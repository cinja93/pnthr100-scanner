// client/src/utils/sizingUtils.js
// ── Shared Position Sizing & Heat Utilities ───────────────────────────────────

// ── Sizing Constants ──────────────────────────────────────────────────────────

export const STRIKE_PCT     = [0.35, 0.25, 0.20, 0.12, 0.08];
export const LOT_NAMES      = ['The Scent', 'The Stalk', 'The Strike', 'The Jugular', 'The Kill'];
export const LOT_OFFSETS    = [0, 0.03, 0.06, 0.10, 0.14];
export const LOT_TIME_GATES = [0, 5, 0, 0, 0];

// ── ETF Identification ────────────────────────────────────────────────────────
// ETF tier: 0.5% vitality cap (vs 1% for stocks). Supplemented by tickerData.isEtf.
export const ETF_LIST = new Set([
  'SPY','QQQ','DIA','IWM','VTI','VOO','VEA','VWO','EEM','EFA',
  'XLE','XLF','XLK','XLV','XLP','XLI','XLU','XLB','XLC','XLRE','XLY',
  'GLD','SLV','TLT','HYG','LQD','USO','UNG',
  'ARKK','SOXX','SMH','IBB','XBI','KRE','XHB','ITB',
  'GDX','GDXJ','RSP','MDY','IJR','SCHA','VB',
  'JETS','BUZZ','KWEB','FXI','INDA',
]);

export function isEtfTicker(ticker, profileIsEtf = false) {
  return profileIsEtf || ETF_LIST.has((ticker || '').toUpperCase());
}

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

// isETF=true → 0.5% vitality cap; false → 1% vitality cap
export function sizePosition({ netLiquidity, entryPrice, stopPrice, maxGapPct, direction, isETF = false }) {
  const tickerCap  = netLiquidity * 0.10;
  const vitality   = netLiquidity * (isETF ? 0.005 : 0.01);
  const structRisk = Math.abs((entryPrice - stopPrice) / entryPrice);
  const gapMult    = maxGapPct > structRisk * 100 ? Math.max(0.3, structRisk * 100 / maxGapPct) : 1.0;
  const rps        = Math.abs(entryPrice - stopPrice);
  const total      = Math.floor(
    Math.min(rps > 0 ? Math.floor(vitality / rps) : 0, Math.floor(tickerCap / entryPrice)) * gapMult
  );
  return {
    totalShares: total,
    vitality:    +vitality.toFixed(0),
    vitalityPct: isETF ? 0.5 : 1,
    gapMult:     +gapMult.toFixed(2),
    structRisk:  +(structRisk * 100).toFixed(2),
    maxRisk$:    +(total * rps).toFixed(2),
    gapProne:    maxGapPct > structRisk * 100,
  };
}

// ── Heat Calculation (actual dollar risk, split by ETF/stock) ─────────────────
// Caps: stocks 10% NAV, ETFs 5% NAV, combined 15% NAV.
// Recycled positions (stop beyond entry) = $0 risk.
export function calcHeat(positions, nav) {
  let liveCnt = 0, recycledCnt = 0, stockRisk = 0, etfRisk = 0;
  for (const p of positions) {
    const filledShr  = Object.values(p.fills || {}).reduce((s, f) => s + (f.filled ? (+f.shares || 0) : 0), 0);
    const avg        = filledShr > 0
      ? Object.values(p.fills || {}).filter(f => f.filled).reduce((s, f) => s + (+f.shares || 0) * (+f.price || 0), 0) / filledShr
      : (p.entryPrice || 0);
    const isL        = p.direction === 'LONG';
    const rps        = Math.max(0, isL ? avg - p.stopPrice : p.stopPrice - avg);
    const posRisk    = filledShr * rps;
    const isRecycled = isL ? p.stopPrice >= avg : p.stopPrice <= avg;
    if (isRecycled) {
      recycledCnt++;
    } else {
      liveCnt++;
      if (p.isETF) { etfRisk += posRisk; } else { stockRisk += posRisk; }
    }
  }
  const totalRisk    = stockRisk + etfRisk;
  const stockRiskPct = nav > 0 ? +((stockRisk / nav) * 100).toFixed(2) : 0;
  const etfRiskPct   = nav > 0 ? +((etfRisk   / nav) * 100).toFixed(2) : 0;
  const totalRiskPct = nav > 0 ? +((totalRisk  / nav) * 100).toFixed(2) : 0;
  return {
    liveCnt, recycledCnt, totalPos: positions.length,
    stockRisk:    +stockRisk.toFixed(0),
    etfRisk:      +etfRisk.toFixed(0),
    totalRisk:    +totalRisk.toFixed(0),
    stockRiskPct, etfRiskPct, totalRiskPct,
    // Legacy aliases kept for any code that still reads these
    actual$:   +totalRisk.toFixed(0),
    actualPct: totalRiskPct,
    theo$:     0,
    theoPct:   0,
    slots:     0,
  };
}
