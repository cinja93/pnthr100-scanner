// server/assistantLiveReconcile.js
// GET /api/assistant/live-reconcile
// The "PNTHR Assistant LIVE" source-of-truth table.
// Compares IBKR (positions + working stops) against Command Center (portfolio + planned stops)
// and returns one row per ticker (union of all three sources) with color-coded checks.

import { connectToDatabase } from './database.js';

// ── Tolerance thresholds ──────────────────────────────────────────────────────
// Centralized so tuning doesn't require chasing through the file.
const TOL = {
  AVG_EXACT:         0.01,   // < $0.01 = green (rounding)
  AVG_YELLOW_PCT:    0.0025, // < 0.25%  = yellow
  STOP_EXACT:        0.01,   // < $0.01 = green match
  RATCHET_STAGED:    0.05,   // IBKR stop within $0.05 of target = "staged"
  RATCHET_YELLOW:    0.01,   // within 1% of lot trigger = yellow
  RATCHET_RED:       0.005,  // within 0.5% or past = red
};

// ── Utility: worst-severity wins for the row rollup ──────────────────────────
function worst(...statuses) {
  if (statuses.includes('red'))    return 'red';
  if (statuses.includes('yellow')) return 'yellow';
  if (statuses.includes('green'))  return 'green';
  return 'gray';
}

// ── Filled-lot math ──────────────────────────────────────────────────────────
function summarizeFills(fills = {}) {
  const filledLots = [1, 2, 3, 4, 5]
    .map(n => ({ n, f: fills[n] }))
    .filter(x => x.f?.filled);
  const totShr  = filledLots.reduce((s, x) => s + (+x.f.shares || 0), 0);
  const totCost = filledLots.reduce((s, x) => s + (+x.f.shares || 0) * (+x.f.price || 0), 0);
  const avgCost = totShr > 0 ? +(totCost / totShr).toFixed(4) : null;
  return { filledCount: filledLots.length, totShr, avgCost, filledLots };
}

// Lot-trigger prices for lots 2-5 (BUY STP for long, SELL STP for short).
// Mirrors client/src/utils/sizingUtils.js → buildLots so server and client
// agree on the exact trigger prices.
const LOT_OFFSETS = [0, 0.03, 0.06, 0.10, 0.14];

function computeLotTriggers(position) {
  const dir = position.direction;
  const isLong = dir === 'LONG';
  if (!dir || !['LONG', 'SHORT'].includes(dir)) return [];
  const fills = position.fills || {};
  const anchor = fills[1]?.filled && fills[1]?.price
    ? +fills[1].price
    : +position.entryPrice || null;
  if (!anchor) return [];
  return [2, 3, 4, 5].map(n => {
    const i = n - 1;
    const triggerPrice = isLong
      ? +(anchor * (1 + LOT_OFFSETS[i])).toFixed(2)
      : +(anchor * (1 - LOT_OFFSETS[i])).toFixed(2);
    return {
      lot: n,
      triggerPrice,
      filled: fills[n]?.filled || false,
      expectedSide: isLong ? 'BUY' : 'SELL', // lot-entry orders are the same side as the position
    };
  });
}

// For each unfilled lot trigger, check if there's a matching pending order in
// IBKR (same side + same price within tolerance). Returns an array enriched
// with `staged: bool` so the client can render green/red dots.
function enrichLotTriggersWithIbkrStatus(triggers, ibkrStops) {
  return triggers.map(t => {
    if (t.filled) return { ...t, staged: null }; // already happened — no dot
    const match = ibkrStops.find(s =>
      s.action === t.expectedSide &&
      Math.abs(+s.stopPrice - t.triggerPrice) < 0.05
    );
    return { ...t, staged: !!match };
  });
}

// ── FMP live price fetch (mirrors headlines endpoint pattern) ────────────────
async function fetchLivePrices(tickers) {
  const out = {};
  if (!tickers.length || !process.env.FMP_API_KEY) return out;
  try {
    const url = `https://financialmodelingprep.com/stable/quote?symbol=${tickers.join(',')}&apikey=${process.env.FMP_API_KEY}`;
    const r   = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return out;
    const d = await r.json();
    if (Array.isArray(d)) for (const q of d) out[q.symbol?.toUpperCase()] = q.price;
  } catch { /* non-fatal */ }
  return out;
}

// ── Per-column classifiers ───────────────────────────────────────────────────
function classifyDirection(ibkrDir, cmdDir) {
  if (!ibkrDir && !cmdDir) return { status: 'gray' };
  if (!ibkrDir) return { status: 'red', reason: 'Command has position, IBKR does not' };
  if (!cmdDir)  return { status: 'red', reason: 'IBKR has position, Command does not' };
  if (ibkrDir === cmdDir) return { status: 'green' };
  return { status: 'red', reason: `IBKR ${ibkrDir} vs Cmd ${cmdDir}` };
}

function classifyShares(ibkrShr, cmdShr) {
  if (ibkrShr == null && cmdShr == null) return { status: 'gray' };
  if (ibkrShr == null) return { status: 'red', reason: 'Command position has no IBKR match' };
  if (cmdShr == null)  return { status: 'red', reason: 'IBKR position has no Command match' };
  if (ibkrShr === cmdShr) return { status: 'green' };
  return { status: 'red', reason: `IBKR ${ibkrShr} vs Cmd ${cmdShr}` };
}

function classifyAvg(ibkrAvg, cmdAvg) {
  if (ibkrAvg == null && cmdAvg == null) return { status: 'gray' };
  if (ibkrAvg == null || cmdAvg == null) return { status: 'yellow', reason: 'only one side' };
  const diff = Math.abs(ibkrAvg - cmdAvg);
  if (diff < TOL.AVG_EXACT) return { status: 'green' };
  if (diff < cmdAvg * TOL.AVG_YELLOW_PCT) return { status: 'yellow', reason: `${(diff/cmdAvg*100).toFixed(2)}% drift` };
  return { status: 'red', reason: `$${diff.toFixed(2)} drift` };
}

function classifyStopSide(expectedSide, stops) {
  if (!stops.length) return { status: 'gray' };
  const sides = new Set(stops.map(s => s.action));
  if (!expectedSide) return { status: 'yellow', reason: 'no Command direction to compare' };
  if (sides.size === 1 && sides.has(expectedSide)) return { status: 'green' };
  return { status: 'red', reason: `Expected ${expectedSide}, IBKR has ${[...sides].join('+')}` };
}

function classifyStopPrice(ibkrStops, cmdStop) {
  const hasIbkr = ibkrStops.length > 0;
  if (!hasIbkr && cmdStop == null) return { status: 'gray' };
  if (!hasIbkr && cmdStop != null)  return { status: 'red', reason: 'NAKED — no IBKR stop' };
  if (hasIbkr && cmdStop == null)   return { status: 'red', reason: 'Orphan stop — no Command position' };
  // Compare the "active" IBKR stop (tightest = highest for long stops, lowest for short)
  // Note: without direction ambiguity we compare against ANY match — if plan stop matches any IBKR stop, green.
  const match = ibkrStops.find(s => Math.abs(+s.stopPrice - cmdStop) < TOL.STOP_EXACT);
  if (match) return { status: 'green' };
  const closest = ibkrStops.reduce((a, b) =>
    Math.abs(+a.stopPrice - cmdStop) < Math.abs(+b.stopPrice - cmdStop) ? a : b
  );
  const diff = Math.abs(+closest.stopPrice - cmdStop);
  return { status: 'red', reason: `IBKR $${(+closest.stopPrice).toFixed(2)} vs Cmd $${cmdStop.toFixed(2)} ($${diff.toFixed(2)} diff)` };
}

function classifyStopShares(ibkrStops, cmdShr) {
  if (!ibkrStops.length && cmdShr == null) return { status: 'gray' };
  if (!ibkrStops.length) return { status: 'red', reason: 'NAKED — position unprotected' };
  // If any stop is missing a shares value, the bridge is the old version and
  // the coverage math would be wrong. Surface as a yellow "restart bridge"
  // signal rather than a misleading red under-stopped flag.
  const anyUnknown = ibkrStops.some(o => o.shares == null);
  if (anyUnknown) {
    return { status: 'yellow', reason: 'Bridge has not reported stop share count (restart pnthr-ibkr-bridge)' };
  }
  const covered = ibkrStops.reduce((s, o) => s + (+o.shares || 0), 0);
  if (cmdShr == null) {
    return { status: 'red', reason: `${covered} sh stop with no Command position` };
  }
  if (covered === cmdShr) return { status: 'green' };
  if (covered < cmdShr)   return { status: 'red', reason: `Under-stopped: ${covered}/${cmdShr} covered` };
  return { status: 'red', reason: `Over-stopped: ${covered} sh stopping ${cmdShr} sh position` };
}

// Classify the overall ratchet-column status based on the NEXT unfilled lot
// trigger only. Per-lot dots inside the cell still reflect each individual
// trigger's staging state (green/red), but only the next one drives the
// row-level roll-up. Rationale: the user only needs to stage orders when
// triggers get close to price; later ratchets are informational.
//
// Green = next unfilled lot trigger has a matching pending order in IBKR
// Red   = next unfilled lot trigger has NO matching pending order
// Gray  = all lots filled (no upcoming trigger)
function classifyLotTriggers(enrichedTriggers) {
  const next = enrichedTriggers.find(t => !t.filled);
  if (!next) return { status: 'gray', reason: 'all lots filled' };
  return next.staged
    ? { status: 'green', reason: `Next lot (L${next.lot}) staged in IBKR` }
    : { status: 'red',   reason: `Next lot (L${next.lot}) NOT staged in IBKR` };
}

// ── Row builder ──────────────────────────────────────────────────────────────
function buildRow(ticker, cmd, ibkrPos, ibkrTickerStops, lastPrice) {
  const cmdHas  = !!cmd;
  const ibkrHas = !!ibkrPos;

  // Direction
  const cmdDir  = cmd?.direction || null;
  const ibkrDir = ibkrPos ? (ibkrPos.shares > 0 ? 'LONG' : ibkrPos.shares < 0 ? 'SHORT' : null) : null;

  // Shares
  const ibkrShares = ibkrPos ? Math.abs(ibkrPos.shares) : null;
  const { totShr: cmdShares, avgCost: cmdAvg } = cmd ? summarizeFills(cmd.fills) : { totShr: null, avgCost: null };
  const cmdSharesOrNull = cmdHas ? cmdShares : null;

  // Avg
  const ibkrAvg = ibkrPos?.avgCost ?? null;

  // Stop side expected
  const expectedStopSide = cmdDir === 'LONG' ? 'SELL' : cmdDir === 'SHORT' ? 'BUY' : null;

  // Lot triggers (BUY STP for long / SELL STP for short) for unfilled lots 2-5.
  // Each enriched with staged:true/false based on whether a matching pending order
  // exists in IBKR. The client stacks these in the NEXT RATCHET column with dots.
  const rawLotTriggers     = cmd ? computeLotTriggers(cmd) : [];
  const enrichedLotTriggers = enrichLotTriggersWithIbkrStatus(rawLotTriggers, ibkrTickerStops);

  // Classify each column
  const checks = {
    direction:     classifyDirection(ibkrDir, cmdDir),
    shares:        classifyShares(ibkrShares, cmdSharesOrNull),
    avg:           classifyAvg(ibkrAvg, cmdAvg),
    stopSide:      classifyStopSide(expectedStopSide, ibkrTickerStops),
    stopPrice:     classifyStopPrice(ibkrTickerStops, cmd?.stopPrice ?? null),
    stopShares:    classifyStopShares(ibkrTickerStops, cmdSharesOrNull),
    ratchet:       cmd ? classifyLotTriggers(enrichedLotTriggers) : { status: 'gray' },
  };

  // Extra flag: multiple stops on same ticker (user asked to flag for review)
  const multiStop = ibkrTickerStops.length > 1;

  // Row status = worst of all checks
  const rowStatus = worst(...Object.values(checks).map(c => c.status));

  // Action list: what the user can click to fix
  const actions = [];
  // For any unstaged lot trigger, give the user the exact TWS instruction
  for (const t of enrichedLotTriggers) {
    if (t.filled || t.staged) continue;
    actions.push({
      type: 'ibkr',
      label: `Stage Lot ${t.lot} trigger in IBKR`,
      instruction: `Open TWS. Add ${t.expectedSide} STP @ $${t.triggerPrice.toFixed(2)} GTC (Lot ${t.lot} entry).`,
    });
  }
  if (checks.stopPrice.status === 'red' && checks.stopPrice.reason?.includes('NAKED')) {
    actions.push({
      type: 'ibkr',
      label: 'NAKED — add protective stop in IBKR',
      instruction: `Open TWS. Add ${expectedStopSide} STP ${cmdSharesOrNull || '?'} sh @ $${(cmd?.stopPrice || 0).toFixed(2)} GTC.`,
    });
  }
  if (checks.stopPrice.status === 'red' && checks.stopPrice.reason?.includes('Orphan')) {
    const orphan = ibkrTickerStops[0];
    actions.push({
      type: 'ibkr',
      label: 'Cancel orphan stop in IBKR',
      instruction: `Open TWS. Cancel ${orphan?.action || ''} ${orphan?.orderType || 'STP'} order #${orphan?.orderId} (${ticker} @ $${(+orphan?.stopPrice || 0).toFixed(2)}).`,
    });
  }
  if (cmdHas && (checks.shares.status === 'red' || checks.avg.status === 'red' || checks.direction.status === 'red')) {
    actions.push({
      type: 'app',
      label: 'Open in Command Center',
      route: 'command',
      positionId: cmd.id,
    });
  }
  if (!cmdHas && ibkrHas) {
    actions.push({
      type: 'app',
      label: 'Add to Command Center',
      route: 'command',
    });
  }

  return {
    ticker,
    rowStatus,
    ibkr: {
      hasPosition: ibkrHas,
      direction:   ibkrDir,
      shares:      ibkrShares,
      avgCost:     ibkrAvg,
      marketPrice: ibkrPos?.marketPrice ?? null,
      stops:       ibkrTickerStops.map(s => ({
        orderId:   s.orderId,
        side:      s.action,
        type:      s.orderType,
        price:     +s.stopPrice,
        // shares: null means bridge predates the totalQuantity patch (treat as unknown, not 0)
        shares:    s.shares == null ? null : +s.shares,
      })),
    },
    command: {
      hasPosition:    cmdHas,
      positionId:     cmd?.id || null,
      direction:      cmdDir,
      shares:         cmdSharesOrNull,
      avgCost:        cmdAvg,
      stopPrice:      cmd?.stopPrice ?? null,
      // How many lots are filled — the client uses this to decide whether the
      // CMD avg cost is inline-editable (only editable for single-lot positions
      // where avg == lot 1 fill price unambiguously).
      filledLotCount: cmd ? summarizeFills(cmd.fills).filledCount : 0,
    },
    lastPrice,
    lotTriggers:  enrichedLotTriggers, // [{lot, triggerPrice, filled, expectedSide, staged}, ...]
    multiStop,
    checks,
    actions,
  };
}

// ── Main handler ─────────────────────────────────────────────────────────────
export async function assistantLiveReconcile(req, res) {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });

    // Command positions
    const cmdPositions = await db.collection('pnthr_portfolio')
      .find({ ownerId: userId, status: 'ACTIVE' })
      .toArray();

    // IBKR snapshot (single doc per user)
    const ibkrDoc = await db.collection('pnthr_ibkr_positions').findOne({ ownerId: userId });
    const ibkrPositions = ibkrDoc?.positions  || [];
    const ibkrStops     = Array.isArray(ibkrDoc?.stopOrders) ? ibkrDoc.stopOrders : [];
    const ibkrSyncedAt  = ibkrDoc?.syncedAt   || null;

    // Union of all tickers across three sources (uppercase, deduped, exclude cash)
    const tickerSet = new Set();
    for (const p of cmdPositions)   if (p.ticker)           tickerSet.add(p.ticker.toUpperCase());
    for (const p of ibkrPositions)  if (p.symbol && p.symbol !== 'USD') tickerSet.add(p.symbol.toUpperCase());
    for (const s of ibkrStops)      if (s.symbol)           tickerSet.add(s.symbol.toUpperCase());

    const tickers = Array.from(tickerSet);

    // Live prices
    const prices = await fetchLivePrices(tickers);

    // Build rows
    const rows = tickers.map(ticker => {
      const cmd     = cmdPositions.find(p => p.ticker?.toUpperCase() === ticker) || null;
      const ibkrPos = ibkrPositions.find(p => p.symbol?.toUpperCase() === ticker) || null;
      const stops   = ibkrStops.filter(s => s.symbol?.toUpperCase() === ticker);
      const last    = prices[ticker] ?? ibkrPos?.marketPrice ?? cmd?.currentPrice ?? null;
      return buildRow(ticker, cmd, ibkrPos, stops, last);
    });

    // Sort: red first, then yellow, then green; within each by ticker
    const order = { red: 0, yellow: 1, green: 2, gray: 3 };
    rows.sort((a, b) => (order[a.rowStatus] - order[b.rowStatus]) || a.ticker.localeCompare(b.ticker));

    const summary = { green: 0, yellow: 0, red: 0, gray: 0, total: rows.length };
    for (const r of rows) summary[r.rowStatus]++;

    res.json({
      lastSyncedAt: ibkrSyncedAt,
      generatedAt:  new Date().toISOString(),
      summary,
      rows,
    });
  } catch (err) {
    console.error('[assistant/live-reconcile]', err);
    res.status(500).json({ error: err.message });
  }
}
