// server/twsRemediation.js
// ── TWS remediation punch list — UI-callable version of the CLI script ──────
//
// Returns the manual TWS actions needed to align IBKR with PNTHR's canonical
// state. Read-only — no DB writes.
//
// Five categories:
//   1) NAKED — ACTIVE PNTHR position with no protective IBKR stop. Place stop.
//   2) STALE — IBKR has GTC orders for tickers with no ACTIVE PNTHR position.
//   3) SHARES — IBKR shares ≠ PNTHR shares. Manual review.
//   4) STOP — IBKR stop ≠ PNTHR stop. Tightest wins (per earnings-week rule).
//   5) AVG_COST — IBKR avg ≠ PNTHR avg. Informational (fills missed by PNTHR).
//
// Note: shares uses sum(fills[].filled.shares) as authoritative, not the
// denormalized totalFilledShares field (which can drift).

const STOP_TOLERANCE_PCT = 0.5;
const AVG_TOLERANCE_PCT  = 0.5;

function pctDiff(a, b) {
  if (a == null || b == null || b === 0) return null;
  return Math.abs((a - b) / b) * 100;
}

function calcFillsSum(fills) {
  return Object.values(fills || {}).reduce((s, f) => s + (f?.filled ? +f.shares || 0 : 0), 0);
}

export async function getRemediationPunchList(db, userId) {
  const ibkrDoc = await db.collection('pnthr_ibkr_positions').findOne({ ownerId: userId });
  const ibkrPositions  = ibkrDoc?.positions  || [];
  const ibkrStopOrders = ibkrDoc?.stopOrders || [];
  const ibkrSyncedAt   = ibkrDoc?.syncedAt   || null;

  const pnthr = await db.collection('pnthr_portfolio').find({
    ownerId: userId, status: { $in: ['ACTIVE', 'PARTIAL'] },
  }).toArray();

  const ibkrByTicker = new Map(ibkrPositions.map(p => [p.symbol?.toUpperCase(), p]));
  const stopsByTicker = new Map();
  for (const s of ibkrStopOrders) {
    const t = s.symbol?.toUpperCase();
    if (!t) continue;
    if (!stopsByTicker.has(t)) stopsByTicker.set(t, []);
    stopsByTicker.get(t).push(s);
  }
  const pnthrByTicker = new Map(pnthr.map(p => [p.ticker?.toUpperCase(), p]));

  const naked = [];
  for (const p of pnthr) {
    const t = p.ticker?.toUpperCase();
    const ibkr = ibkrByTicker.get(t);
    if (!ibkr) continue;
    const stops = stopsByTicker.get(t) || [];
    const expectedAction = (p.direction || 'LONG').toUpperCase() === 'SHORT' ? 'BUY' : 'SELL';
    const hasProtective  = stops.some(s => s.action === expectedAction && s.orderType === 'STP');
    if (!hasProtective) {
      naked.push({
        ticker: t, direction: p.direction || 'LONG',
        ibkrShares: Math.abs(+ibkr.shares || 0),
        ibkrAvgCost: +ibkr.avgCost || null,
        pnthrStop: +p.stopPrice || null,
        existingNonProtective: stops.map(s => ({ action: s.action, orderType: s.orderType, shares: s.shares, stopPrice: s.stopPrice })),
      });
    }
  }

  const stale = [];
  for (const [ticker, stops] of stopsByTicker.entries()) {
    if (pnthrByTicker.has(ticker)) continue;
    const ibkr = ibkrByTicker.get(ticker);
    if (ibkr && Math.abs(+ibkr.shares || 0) > 0) continue;
    stale.push({
      ticker,
      orders: stops.map(s => ({ action: s.action, orderType: s.orderType, shares: s.shares, stopPrice: s.stopPrice, permId: s.permId })),
    });
  }

  const sharesMismatch = [];
  for (const p of pnthr) {
    const t = p.ticker?.toUpperCase();
    const ibkr = ibkrByTicker.get(t);
    if (!ibkr) {
      sharesMismatch.push({ ticker: t, direction: p.direction, ibkrShares: 0, pnthrShares: calcFillsSum(p.fills), kind: 'IBKR_MISSING' });
      continue;
    }
    const ibkrShares  = Math.abs(+ibkr.shares || 0);
    const pnthrShares = calcFillsSum(p.fills);
    if (ibkrShares !== pnthrShares) {
      sharesMismatch.push({ ticker: t, direction: p.direction, ibkrShares, pnthrShares, kind: 'DIFF', diff: ibkrShares - pnthrShares });
    }
  }

  const stopMismatch = [];
  for (const p of pnthr) {
    const t = p.ticker?.toUpperCase();
    const ibkr = ibkrByTicker.get(t);
    if (!ibkr) continue;
    const stops = stopsByTicker.get(t) || [];
    const dirAction = (p.direction || 'LONG').toUpperCase() === 'SHORT' ? 'BUY' : 'SELL';
    const protective = stops.find(s => s.action === dirAction && s.orderType === 'STP');
    if (!protective || p.stopPrice == null) continue;
    const diff = pctDiff(protective.stopPrice, p.stopPrice);
    if (diff != null && diff > STOP_TOLERANCE_PCT) {
      const isLong = (p.direction || 'LONG').toUpperCase() !== 'SHORT';
      const ibkrTighter = isLong ? (protective.stopPrice > p.stopPrice) : (protective.stopPrice < p.stopPrice);
      stopMismatch.push({
        ticker: t, direction: p.direction,
        ibkrStop: protective.stopPrice, pnthrStop: p.stopPrice,
        diffPct: +diff.toFixed(2),
        ibkrShares: Math.abs(+ibkr.shares || 0),
        ibkrPermId: protective.permId,
        verdict: ibkrTighter ? 'IBKR_TIGHTER' : 'PNTHR_TIGHTER',
      });
    }
  }

  const avgMismatch = [];
  for (const p of pnthr) {
    const t = p.ticker?.toUpperCase();
    const ibkr = ibkrByTicker.get(t);
    if (!ibkr || !ibkr.avgCost) continue;
    const fills = Object.values(p.fills || {}).filter(f => f?.filled && f.price && f.shares);
    if (fills.length === 0) continue;
    const totalShares = fills.reduce((s, f) => s + (+f.shares || 0), 0);
    const totalCost   = fills.reduce((s, f) => s + (+f.shares || 0) * (+f.price || 0), 0);
    const pnthrAvg    = totalShares > 0 ? totalCost / totalShares : null;
    if (pnthrAvg == null) continue;
    const diff = pctDiff(ibkr.avgCost, pnthrAvg);
    if (diff != null && diff > AVG_TOLERANCE_PCT) {
      avgMismatch.push({ ticker: t, direction: p.direction, ibkrAvg: ibkr.avgCost, pnthrAvg: +pnthrAvg.toFixed(4), diffPct: +diff.toFixed(2), ibkrShares: Math.abs(+ibkr.shares || 0) });
    }
  }

  return {
    runAt: new Date().toISOString(),
    ibkrSyncedAt,
    counts: {
      ibkrPositions:  ibkrPositions.length,
      ibkrStopOrders: ibkrStopOrders.length,
      pnthrActive:    pnthr.length,
      naked:          naked.length,
      stale:          stale.length,
      sharesMismatch: sharesMismatch.length,
      stopMismatch:   stopMismatch.length,
      avgMismatch:    avgMismatch.length,
      totalActions:   naked.length + stale.length + sharesMismatch.length + stopMismatch.length,
    },
    naked, stale, sharesMismatch, stopMismatch, avgMismatch,
  };
}
