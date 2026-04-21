// server/gateLogic.js
// ── PNTHR Funds — Gate Logic (single source of truth) ────────────────────────
//
// Correct gate policy (per 2026-04-20 user clarification):
//
//   STEP 1 — Direction Index (21W EMA of the stock's primary index ETF)
//     If ticker is in SP500 (possibly also NDX100) -> use SPY
//     Else if ticker is NDX100-only                -> use QQQ
//     Else if ticker is SP400 member               -> use MDY
//     Else fallback                                -> use SPY
//
//     BL candidate passes if index.close > index.ema21
//     SS candidate passes if index.close < index.ema21
//
//   STEP 2 — Sector ETF (per-sector OPTIMIZED EMA of the sector ETF)
//     Energy stocks        -> XLE at 26W EMA
//     Real Estate stocks   -> XLRE at 26W EMA
//     Financial Services   -> XLF at 25W EMA
//     Healthcare           -> XLV at 24W EMA
//     Industrials          -> XLI at 24W EMA
//     Technology           -> XLK at 21W EMA
//     Communication Srvcs  -> XLC at 21W EMA
//     Utilities            -> XLU at 21W EMA
//     Basic Materials      -> XLB at 19W EMA
//     Consumer Discretionary -> XLY at 19W EMA
//     Consumer Staples     -> XLP at 18W EMA
//
//     BL candidate passes if sectorEtf.close > sectorEtf.ema
//     SS candidate passes if sectorEtf.close < sectorEtf.ema
//
//   STEP 3 — D2 gate (sector return for that direction, d2 >= 0)
//   STEP 4 — SS Crash gate (for SS only: 2-consec falling EMA weeks + sector -3% 5D)
//
// Membership is evaluated AS OF THE WEEKOFENTRY (historical) for SP500 + NDX100.
// SP400 membership uses today's MDY ETF holdings as proxy (FMP's historical SP400
// endpoint is unavailable).
// ─────────────────────────────────────────────────────────────────────────────

export const SECTOR_MAP = {
  'Technology':'XLK','Energy':'XLE','Healthcare':'XLV','Health Care':'XLV',
  'Financial Services':'XLF','Financials':'XLF','Consumer Discretionary':'XLY',
  'Consumer Cyclical':'XLY','Communication Services':'XLC','Industrials':'XLI',
  'Basic Materials':'XLB','Materials':'XLB','Real Estate':'XLRE','Utilities':'XLU',
  'Consumer Staples':'XLP','Consumer Defensive':'XLP',
};

// Sector ETF EMA periods — per-sector optimized (mirrors sectorEmaConfig.js values)
export const SECTOR_ETF_EMA_PERIOD = {
  XLK: 21, XLV: 24, XLF: 25, XLI: 24, XLE: 26, XLC: 21,
  XLRE: 26, XLU: 21, XLB: 19, XLY: 19, XLP: 18,
};

export const INDEX_EMA_PERIOD = 21;  // SPY, QQQ, MDY all at 21W

// ── Historical membership reconstruction ──────────────────────────────────────
// events: array of { date, symbol (added), removedTicker, index }
// currentSet: today's membership Set
// targetDate: YYYY-MM-DD — the date we want membership AS OF
//
// Logic: start from current, walk events in reverse chrono order.
// For every event dated AFTER targetDate, REVERSE it (un-add the added, re-add the removed).
export function buildMembershipAsOfDate(events, currentSet, targetDate) {
  const set = new Set(currentSet);
  const reversed = events
    .filter(e => e.date && e.date > targetDate)
    .sort((a, b) => b.date.localeCompare(a.date));
  for (const ev of reversed) {
    if (ev.symbol) set.delete(ev.symbol);
    if (ev.removedTicker) set.add(ev.removedTicker);
  }
  return set;
}

// Determine direction index per policy (historical/backtest path — ticker + Sets)
export function getDirectionIndex(ticker, inSp500Set, inNdx100Set, inSp400Set) {
  if (inSp500Set.has(ticker)) return 'SPY';
  if (inNdx100Set.has(ticker)) return 'QQQ';
  if (inSp400Set && inSp400Set.has(ticker)) return 'MDY';
  return 'SPY';  // fallback per policy
}

// Determine direction index per policy (live-scan path — boolean flags already resolved)
export function getDirectionIndexFromFlags({ isSp500, isNasdaq100, isSp400 }) {
  if (isSp500)     return 'SPY';
  if (isNasdaq100) return 'QQQ';
  if (isSp400)     return 'MDY';
  return 'SPY';  // fallback per policy
}

// Pure function: does a candidate pass the index gate?
export function passesIndexGate(signal, indexClose, indexEma) {
  if (indexClose == null || indexEma == null) return false;
  if (signal === 'BL') return indexClose > indexEma;
  if (signal === 'SS') return indexClose < indexEma;
  return false;
}

// Pure function: does a candidate pass the sector ETF gate?
export function passesSectorEtfGate(signal, sectorEtfClose, sectorEtfEma) {
  if (sectorEtfClose == null || sectorEtfEma == null) return false;
  if (signal === 'BL') return sectorEtfClose > sectorEtfEma;
  if (signal === 'SS') return sectorEtfClose < sectorEtfEma;
  return false;
}

// Variable-period EMA series computation
export function computeEMASeries(closes, period) {
  if (closes.length < period) return [];
  const mult = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, c) => s + c, 0) / period;
  const emas = Array(period - 1).fill(null);
  emas.push(ema);
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * mult + ema * (1 - mult);
    emas.push(ema);
  }
  return emas;
}

// Daily candles -> weekly bars (Monday keyed, Friday close)
export function aggregateWeekly(daily) {
  const asc = [...daily].sort((a, b) => a.date.localeCompare(b.date));
  const byWeek = new Map();
  for (const d of asc) {
    const dt = new Date(d.date + 'T12:00:00');
    const dow = dt.getDay();
    const diffToMon = dow === 0 ? -6 : 1 - dow;
    const mon = new Date(dt); mon.setDate(dt.getDate() + diffToMon);
    const weekKey = mon.toISOString().slice(0, 10);
    if (!byWeek.has(weekKey)) byWeek.set(weekKey, { weekStart: weekKey, bars: [] });
    byWeek.get(weekKey).bars.push(d);
  }
  const weekly = [];
  for (const [key, val] of [...byWeek.entries()].sort()) {
    val.bars.sort((a, b) => a.date.localeCompare(b.date));
    const last = val.bars[val.bars.length - 1];
    weekly.push({ weekStart: key, close: last.close, date: last.date });
  }
  return weekly;
}

// Look up weekly close + EMA for a given ETF at a given Friday date
export function getWeeklyEmaForFri(weeklyBars, emas, targetFri) {
  let idx = -1;
  for (let i = weeklyBars.length - 1; i >= 0; i--) {
    if (weeklyBars[i].date <= targetFri) { idx = i; break; }
  }
  if (idx < 0) return null;
  if (emas[idx] == null) return null;
  return { close: weeklyBars[idx].close, ema: emas[idx], weekEnd: weeklyBars[idx].date };
}

// Full gate evaluation for a single candidate. Returns { passes, reason, dirIdx, sectorEtf }
export function evaluateGates({
  ticker, signal, sector, entryFri,
  inSp500Set, inNdx100Set, inSp400Set,
  indexWeeklyBars, indexEmas,           // { SPY: [...], QQQ: [...], MDY: [...] }
  sectorWeeklyBars, sectorEmas,         // { XLK: [...], XLE: [...], ... }
}) {
  const dirIdx = getDirectionIndex(ticker, inSp500Set, inNdx100Set, inSp400Set);
  const idxInfo = getWeeklyEmaForFri(indexWeeklyBars[dirIdx], indexEmas[dirIdx], entryFri);

  if (!idxInfo) return { passes: false, reason: 'no_index_data_' + dirIdx, dirIdx, sectorEtf: null };
  if (!passesIndexGate(signal, idxInfo.close, idxInfo.ema)) {
    return {
      passes: false,
      reason: dirIdx + (signal === 'BL' ? '_below_ema_for_BL' : '_above_ema_for_SS'),
      dirIdx, sectorEtf: null,
      indexClose: idxInfo.close, indexEma: idxInfo.ema,
    };
  }

  const sectorEtf = SECTOR_MAP[sector];
  if (!sectorEtf) return { passes: false, reason: 'unknown_sector_' + (sector || '_empty'), dirIdx, sectorEtf: null };

  const secInfo = getWeeklyEmaForFri(sectorWeeklyBars[sectorEtf], sectorEmas[sectorEtf], entryFri);
  if (!secInfo) return { passes: false, reason: 'no_sector_data_' + sectorEtf, dirIdx, sectorEtf };
  if (!passesSectorEtfGate(signal, secInfo.close, secInfo.ema)) {
    return {
      passes: false,
      reason: sectorEtf + (signal === 'BL' ? '_below_optEma_for_BL' : '_above_optEma_for_SS'),
      dirIdx, sectorEtf,
      indexClose: idxInfo.close, indexEma: idxInfo.ema,
      sectorClose: secInfo.close, sectorEma: secInfo.ema,
    };
  }

  return {
    passes: true, dirIdx, sectorEtf,
    indexClose: idxInfo.close, indexEma: idxInfo.ema,
    sectorClose: secInfo.close, sectorEma: secInfo.ema,
  };
}
