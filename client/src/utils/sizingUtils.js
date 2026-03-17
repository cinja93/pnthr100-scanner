// client/src/utils/sizingUtils.js
// ── Shared Position Sizing & Heat Utilities ───────────────────────────────────
//
// Extracted from CommandCenter.jsx so ChartModal (SIZE IT panel) and Command
// Center both use identical math. No logic changes from the original.
// ─────────────────────────────────────────────────────────────────────────────

// ── Sizing Constants ──────────────────────────────────────────────────────────

export const STRIKE_PCT     = [0.15, 0.30, 0.25, 0.20, 0.10];
export const LOT_NAMES      = ['The Scent', 'The Stalk', 'The Strike', 'The Jugular', 'The Kill'];
export const LOT_OFFSETS    = [0, 0.03, 0.06, 0.10, 0.14];
export const LOT_TIME_GATES = [0, 5, 0, 0, 0];

// ── Position Sizing Logic ─────────────────────────────────────────────────────

export function buildLots({ entryPrice, stopPrice, totalShares, direction, fills = {} }) {
  const isLong = direction === 'LONG';
  const anchor = fills[1]?.filled && fills[1]?.price ? +fills[1].price : entryPrice;
  return STRIKE_PCT.map((pct, i) => {
    const targetShares  = Math.max(1, Math.round(totalShares * pct));
    const triggerPrice  = isLong
      ? +(anchor * (1 + LOT_OFFSETS[i])).toFixed(2)
      : +(anchor * (1 - LOT_OFFSETS[i])).toFixed(2);
    const fill          = fills[i + 1] || {};
    const filled        = fill.filled || false;
    const actualPrice   = fill.price  != null ? +fill.price  : null;
    const actualShares  = fill.shares != null ? +fill.shares : (filled ? targetShares : 0);
    const actualDate    = fill.date   || null;
    const costBasis     = filled && actualPrice ? +(actualShares * actualPrice).toFixed(2) : 0;
    return {
      lot: i + 1, name: LOT_NAMES[i], pctLabel: STRIKE_PCT[i] * 100,
      targetShares, triggerPrice, offsetPct: Math.round(LOT_OFFSETS[i] * 100),
      timeGate: LOT_TIME_GATES[i],
      filled, actualPrice, actualShares, actualDate, costBasis, anchor,
    };
  });
}

export function enrichLots(lots, entryPrice, stopPrice, direction) {
  const isLong = direction === 'LONG';
  let cumShr = 0, cumCost = 0;
  return lots.map((l, i) => {
    if (l.filled && l.actualShares > 0) { cumShr += l.actualShares; cumCost += l.costBasis; }
    const avgCost = cumShr > 0 ? +(cumCost / cumShr).toFixed(2) : 0;
    let recStop, rNote;
    if (i <= 1) { recStop = stopPrice; rNote = null; }
    else if (i === 2) {
      const p = lots[0].actualPrice || entryPrice; recStop = +p.toFixed(2);
      rNote = `Move stop → $${recStop} (Lot 1 fill = breakeven)`;
    } else if (i === 3) {
      const p = lots[1].actualPrice || lots[1].triggerPrice; recStop = +p.toFixed(2);
      rNote = `Ratchet stop → $${recStop} (Lot 2 fill)`;
    } else {
      const p = lots[2].actualPrice || lots[2].triggerPrice; recStop = +p.toFixed(2);
      rNote = `Ratchet stop → $${recStop} (Lot 3 fill)`;
    }
    return { ...l, cumShr, cumCost: +cumCost.toFixed(2), avgCost, recommendedStop: recStop, ratchetNote: rNote };
  });
}

export function sizePosition({ netLiquidity, entryPrice, stopPrice, maxGapPct, direction }) {
  const tickerCap  = netLiquidity * 0.10;
  const vitality   = netLiquidity * 0.01;
  const structRisk = Math.abs((entryPrice - stopPrice) / entryPrice);
  const gapMult    = maxGapPct > structRisk * 100 ? Math.max(0.3, structRisk * 100 / maxGapPct) : 1.0;
  const rps        = Math.abs(entryPrice - stopPrice);
  const total      = Math.floor(
    Math.min(rps > 0 ? Math.floor(vitality / rps) : 0, Math.floor(tickerCap / entryPrice)) * gapMult
  );
  return {
    totalShares: total,
    gapMult:     +gapMult.toFixed(2),
    structRisk:  +(structRisk * 100).toFixed(2),
    maxRisk$:    +(total * rps).toFixed(2),
    gapProne:    maxGapPct > structRisk * 100,
  };
}

export function calcHeat(positions, nav) {
  let liveCnt = 0, recycledCnt = 0, actual$ = 0;
  for (const p of positions) {
    const filledShr = Object.values(p.fills || {}).reduce((s, f) => s + (f.filled ? (+f.shares || 0) : 0), 0);
    const lot1P     = p.fills?.[1]?.price ? +p.fills[1].price : p.entryPrice;
    const isL       = p.direction === 'LONG';
    const rps       = isL ? Math.max(lot1P - p.stopPrice, 0) : Math.max(p.stopPrice - lot1P, 0);
    const posRisk   = filledShr * rps;
    const isRecycled = isL ? p.stopPrice >= lot1P : p.stopPrice <= lot1P;
    if (isRecycled) { recycledCnt++; } else { liveCnt++; actual$ += posRisk; }
  }
  const theo$ = liveCnt * nav * 0.01;
  return {
    liveCnt, recycledCnt, totalPos: positions.length,
    theo$:     +theo$.toFixed(0),
    theoPct:   +((theo$ / nav) * 100).toFixed(1),
    actual$:   +actual$.toFixed(0),
    actualPct: +((actual$ / nav) * 100).toFixed(2),
    slots:     Math.max(0, Math.floor((nav * 0.10 - theo$) / (nav * 0.01))),
  };
}
