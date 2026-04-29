// server/dataIntegrity.js
// ── Data integrity sweep — UI-callable version of sweepPartialAndDrift.js ────
//
// Detects and (optionally) repairs two related portfolio-doc bugs:
//
//   (1) PARTIAL-stuck: status='PARTIAL' but remainingShares===0. Logically
//       CLOSED but the close handler didn't transition. Same shape as the
//       DTCR mod0qqm9fajlg incident on 2026-04-29.
//
//   (2) totalFilledShares drift: the denormalized field is stale relative to
//       sum(fills[].shares) for filled lots. Caused by Lot 2-5 fills going
//       through positionsSave's surgical $set without recomputing.
//
// The repair logic mirrors exitService.recordExit's canonical close shape so
// downstream consumers (journal, washSale, discipline scoring) don't need to
// know whether a doc was closed via the normal path or via this sweep.
//
// Always runs scoped to a specific userId (multi-tenant safety, even though
// production has one user today).

function calcFilledShares(fills) {
  return Object.values(fills || {}).reduce((s, f) => s + (f?.filled ? +f.shares || 0 : 0), 0);
}

function calcAvgCost(fills, fallbackEntry) {
  const filled = Object.values(fills || {}).filter(f => f?.filled && f?.price && f?.shares);
  if (!filled.length) return +fallbackEntry || 0;
  const cost = filled.reduce((s, f) => s + (+f.shares * +f.price), 0);
  const shr  = filled.reduce((s, f) => s + +f.shares, 0);
  return shr > 0 ? cost / shr : (+fallbackEntry || 0);
}

async function findPartialBroken(db, userId) {
  const partials = await db.collection('pnthr_portfolio').find({
    ownerId: userId, status: 'PARTIAL',
  }).toArray();

  return partials
    .map(d => {
      const filled    = calcFilledShares(d.fills);
      const exited    = (d.exits || []).reduce((s, e) => s + (+e.shares || 0), 0);
      const remaining = filled - exited;
      return { d, filled, exited, remaining };
    })
    .filter(x => x.remaining === 0 && x.filled > 0);
}

async function findDrift(db, userId) {
  const all = await db.collection('pnthr_portfolio').find({
    ownerId: userId, status: { $in: ['ACTIVE', 'PARTIAL'] },
  }).toArray();

  return all
    .map(d => ({ d, fillsSum: calcFilledShares(d.fills), tfs: +d.totalFilledShares || 0 }))
    .filter(x => x.fillsSum !== x.tfs && x.fillsSum > 0);
}

async function repairPartialBroken({ db, userId, d, filled, exited }) {
  const isLong = d.direction === 'LONG';
  const exits  = d.exits || [];
  if (filled !== exited) {
    return { ok: false, reason: `filled=${filled} but exited=${exited} — refusing to auto-repair` };
  }

  const avgCost = calcAvgCost(d.fills, d.entryPrice);
  const totalExitedShares = exits.reduce((s, e) => s + (+e.shares || 0), 0);
  const totalExitProceeds = exits.reduce((s, e) => s + (+e.shares || 0) * (+e.price || 0), 0);
  const avgExitPrice      = totalExitedShares > 0 ? totalExitProceeds / totalExitedShares : 0;

  const realizedDollar = exits.reduce((s, e) => {
    const shr = +e.shares || 0;
    const px  = +e.price  || 0;
    const diff = isLong ? (px - avgCost) : (avgCost - px);
    return s + diff * shr;
  }, 0);
  const totalCostBasis = avgCost * filled;
  const realizedPct = totalCostBasis > 0 ? +(realizedDollar / totalCostBasis * 100).toFixed(2) : 0;

  const lastExit = exits[exits.length - 1];
  const lastExitDate = lastExit?.date || new Date().toISOString().split('T')[0];
  const closedAt = new Date(`${lastExitDate}T${lastExit?.time || '16:00'}:00`);

  const $set = {
    status: 'CLOSED',
    totalFilledShares: filled,
    totalExitedShares: totalExitedShares,
    remainingShares:   0,
    avgExitPrice:      +avgExitPrice.toFixed(4),
    'realizedPnl.dollar': +realizedDollar.toFixed(2),
    'realizedPnl.pct':    realizedPct,
    closedAt,
    updatedAt: new Date(),
    outcome: {
      exitPrice:    +avgExitPrice.toFixed(4),
      profitPct:    realizedPct,
      profitDollar: +realizedDollar.toFixed(2),
      holdingDays:  Math.floor((closedAt.getTime() - new Date(d.createdAt).getTime()) / 86400000),
      exitReason:   lastExit?.reason || 'MANUAL',
    },
  };

  if (realizedDollar < 0) {
    const finalDate = new Date(`${lastExitDate}T00:00:00.000Z`);
    const expiry = new Date(finalDate);
    expiry.setUTCDate(expiry.getUTCDate() + 30);
    $set['washRule.isLoss']        = true;
    $set['washRule.finalExitDate'] = lastExitDate;
    $set['washRule.expiryDate']    = expiry.toISOString().split('T')[0];
  }

  const exitPatch = {};
  if (exits.length > 0) {
    const last = exits.length - 1;
    exitPatch[`exits.${last}.isFinalExit`]     = true;
    exitPatch[`exits.${last}.remainingShares`] = 0;
  }

  const r = await db.collection('pnthr_portfolio').updateOne(
    { id: d.id, ownerId: userId },
    { $set: { ...$set, ...exitPatch } },
  );

  // Sync journal to match
  let journalSynced = false;
  const journal = await db.collection('pnthr_journal').findOne({ positionId: d.id, ownerId: userId });
  if (journal) {
    const jSet = {
      'performance.status':            'CLOSED',
      'performance.remainingShares':   0,
      'performance.realizedPnlDollar': +realizedDollar.toFixed(2),
      'performance.realizedPnlPct':    realizedPct,
      'performance.avgExitPrice':      +avgExitPrice.toFixed(4),
      closedAt,
      updatedAt: new Date(),
    };
    if (realizedDollar < 0) {
      const finalDate = new Date(`${lastExitDate}T00:00:00.000Z`);
      const expiry = new Date(finalDate);
      expiry.setUTCDate(expiry.getUTCDate() + 30);
      jSet['washSale.isLoss']     = true;
      jSet['washSale.lossAmount'] = +realizedDollar.toFixed(2);
      jSet['washSale.exitDate']   = finalDate;
      jSet['washSale.expiryDate'] = expiry;
      jSet['washSale.triggered']  = false;
    }
    await db.collection('pnthr_journal').updateOne(
      { positionId: d.id, ownerId: userId },
      { $set: jSet },
    );
    journalSynced = true;
  }

  return {
    ok: r.matchedCount > 0,
    journalSynced,
    realizedDollar: +realizedDollar.toFixed(2),
    realizedPct,
    avgExitPrice: +avgExitPrice.toFixed(4),
  };
}

async function repairDrift({ db, userId, d, fillsSum }) {
  const r = await db.collection('pnthr_portfolio').updateOne(
    { id: d.id, ownerId: userId },
    { $set: { totalFilledShares: fillsSum, updatedAt: new Date() } },
  );
  return { ok: r.matchedCount > 0, newValue: fillsSum };
}

// Public: { apply, skipDrift } → { found, applied, mode, runAt }
export async function runDataIntegritySweep(db, userId, { apply = false, skipDrift = false } = {}) {
  const partial = await findPartialBroken(db, userId);
  const drift   = skipDrift ? [] : await findDrift(db, userId);

  const result = {
    runAt: new Date().toISOString(),
    mode:  apply ? 'APPLY' : 'DRY_RUN',
    found: {
      partialBroken: partial.map(({ d, filled }) => ({
        ticker: d.ticker, id: d.id, direction: d.direction, fillsSum: filled, exitsCount: (d.exits || []).length,
      })),
      drift: drift.map(({ d, fillsSum, tfs }) => ({
        ticker: d.ticker, id: d.id, totalFilledShares: tfs, fillsSum,
      })),
    },
    applied: { partial: [], drift: [] },
  };

  if (!apply) return result;

  for (const x of partial) {
    try {
      const r = await repairPartialBroken({ db, userId, ...x });
      result.applied.partial.push({ ticker: x.d.ticker, id: x.d.id, ok: r.ok, journalSynced: r.journalSynced, realizedDollar: r.realizedDollar });
    } catch (e) {
      result.applied.partial.push({ ticker: x.d.ticker, id: x.d.id, ok: false, error: e.message });
    }
  }

  for (const x of drift) {
    try {
      const r = await repairDrift({ db, userId, d: x.d, fillsSum: x.fillsSum });
      result.applied.drift.push({ ticker: x.d.ticker, id: x.d.id, ok: r.ok, from: x.tfs, to: r.newValue });
    } catch (e) {
      result.applied.drift.push({ ticker: x.d.ticker, id: x.d.id, ok: false, error: e.message });
    }
  }

  // Persist audit trail so PNTHR Assistant can show "last clean run"
  try {
    await db.collection('pnthr_data_audits').insertOne({
      ownerId: userId, ...result,
    });
  } catch (e) {
    console.warn('[dataIntegrity] audit log insert failed:', e.message);
  }

  return result;
}

// Public: latest audit for this user
export async function getLatestDataAudit(db, userId) {
  const latest = await db.collection('pnthr_data_audits')
    .find({ ownerId: userId })
    .sort({ runAt: -1 })
    .limit(1)
    .toArray();
  return latest[0] || null;
}
