// server/backtest/treeSim.js
// ── PNTHR TREE — shared backtest simulation (single source of truth) ─────────
// The LOCKED Tree strategy, extracted verbatim from build_tree_baseline.mjs so the
// live-dashboard baseline (build_tree_baseline.mjs) AND the Investor Report data
// (genTreeIrData.js) run the IDENTICAL engine — their numbers can never diverge.
//
//   AI-300 · LONG-only · FULL size (no pyramid) · enter on NEW intraday 42wk high
//   (210 trading days; resting buy-stop, fill at worse of level/open) · stop =
//   lowest low of prior 10 daily bars − .01, trail up · size = min(2% NAV/risk,
//   10% NAV/price) · 2% ADV cap · GROSS ≤ 2× NAV · breakeven snap (+$250 & green
//   day). Executable / no look-ahead. Costs: commission + slippage every leg.
//   SURVIVORSHIP-FLATTERED (current AI-300 members only).
//
// Two steps so a multi-tier run (the IR's $1M/$500k/$100k) loads candles ONCE:
//   loadTreeData(db, opts)            → { T, allDates, spyAt, lastDate }
//   simulateTree(data, { nav0, ... }) → { equity, equityGross, closed, maxDD…, costs }

import { calcCommission, calcSlippage } from './costEngine.js';
import { SECTORS } from '../scripts/aiUniverse/aiUniverseData.js';

// ── LOCKED strategy constants (the ONLY place they live) ─────────────────────
export const VITALITY_PCT = 0.02;          // risk budget per name (2% NAV)
export const TICKER_CAP_PCT = 0.10;        // max position value per name (10% NAV)
export const MAX_GROSS = 2.0;              // gross leverage cap (2× NAV)
export const ENTRY_HIGH_LOOKBACK = 210;    // 42-week high = 210 trading days (prior bars, excl today)
export const STOP_LOOKBACK = 10;           // 2-week (10 trading day) trailing-stop reference
export const ADV_CAP_PCT = 0.02;           // ≤ 2% of 20-day ADV per entry (capacity)
export const BE_SNAP_PROFIT = 250;         // breakeven snap: ≥ $250 open profit on a green day → stop to entry
export const DEFAULT_START = '2023-01-03';
// Backtest END is FROZEN at the last session before go-live (strategy went LIVE 2026-06-12).
export const DEFAULT_END = '2026-06-11';

// ETFs/indexes living in the 679 ('carn') collection that must never be traded as stocks.
const ETF_EXCLUDE = new Set(['SPY','QQQ','DIA','IWM','XLK','XLF','XLE','XLV','XLY','XLP','XLI','XLB','XLU','XLRE','XLC','SMH','VOO','VTI']);

// ── load + precompute (expensive; call once, reuse across tiers) ─────────────
// Universe = CURRENT AI-300 index members only (matches the live engine + the disclosure).
export async function loadTreeData(db, { end = DEFAULT_END, universe = 'ai', lookback = ENTRY_HIGH_LOOKBACK } = {}) {
  const candleColl = universe === 'carn' ? 'pnthr_bt_candles' : 'pnthr_ai_bt_candles';
  const AI_SET = new Set(); for (const s of SECTORS) for (const h of s.holdings) AI_SET.add(h.ticker);
  const docs = await db.collection(candleColl).find({}).toArray();
  const T = {}; const allDatesSet = new Set();
  for (const d of docs) {
    if (universe === 'ai' && !AI_SET.has(d.ticker)) continue;   // current index members only
    if (universe === 'carn' && ETF_EXCLUDE.has(d.ticker)) continue;   // 679: skip ETFs/indexes
    const bars = (d.daily || []).map(b => ({ date: b.date, o: +b.open, h: +b.high, l: +b.low, c: +b.close, v: +b.volume || 0 }))
      .filter(b => b.l > 0 && b.c > 0 && b.date <= end).sort((a, b) => a.date.localeCompare(b.date));
    if (bars.length < lookback + 5) continue;
    const n = bars.length;
    const hi52 = new Array(n).fill(null), loStop = new Array(n).fill(null), adv20 = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      if (i >= lookback) { let mh = -Infinity; for (let j = i - lookback; j < i; j++) if (bars[j].h > mh) mh = bars[j].h; hi52[i] = mh; }
      if (i >= STOP_LOOKBACK) { let sl = Infinity; for (let j = i - STOP_LOOKBACK; j < i; j++) if (bars[j].l < sl) sl = bars[j].l; loStop[i] = sl; }
      if (i >= 20) { let v = 0; for (let j = i - 20; j < i; j++) v += bars[j].v; adv20[i] = v / 20; }
      allDatesSet.add(bars[i].date);
    }
    const idxByDate = {}; bars.forEach((b, i) => { idxByDate[b.date] = i; });
    T[d.ticker] = { bars, idxByDate, hi52, loStop, adv20 };
  }
  const allDates = [...allDatesSet].sort();

  // SPY benchmark (stitch the two DB sources to cover the full period)
  const spyClose = {};
  for (const c of ['pnthr_bt_candles', 'pnthr_candle_cache']) {
    const d = await db.collection(c).findOne({ ticker: 'SPY' });
    if (d) for (const b of (d.daily || d.candles || [])) if (+b.close > 0) spyClose[b.date] = +b.close;
  }
  const spyDates = Object.keys(spyClose).sort();
  const spyAt = (date, dir) => {   // dir +1 = first ≥ date, -1 = last ≤ date
    if (dir > 0) { for (const dt of spyDates) if (dt >= date) return spyClose[dt]; }
    else { for (let i = spyDates.length - 1; i >= 0; i--) if (spyDates[i] <= date) return spyClose[spyDates[i]]; }
    return null;
  };
  return { T, allDates, spyAt, lastDate: allDates[allDates.length - 1] };
}

// ── simulation (daily-10 stop, 2× gross cap, breakeven snap) ─────────────────
// Returns the daily NET (after trading costs) + GROSS equity curves, the closed-trade
// log (with FULL detail for the IR: entry/exit date+price+shares+direction+reason),
// and the drawdown extremes. NAV0 (seed) is the only per-tier knob.
export function simulateTree({ T, allDates, spyAt, lastDate }, { nav0 = 100000, start = DEFAULT_START, beSnap = BE_SNAP_PROFIT } = {}) {
  const NAV0 = nav0;
  const positions = {};
  let realized = 0, realizedGross = 0, totalComm = 0, totalSlip = 0;
  const closed = []; const equity = []; const equityGross = [];
  let peak = NAV0, maxDDfrac = 0, maxDDdollar = 0;
  let peakG = NAV0, maxDDfracG = 0, maxDDdollarG = 0;

  const unrealAt = (mark) => { let u = 0; for (const [t, p] of Object.entries(positions)) { const px = mark[t]; if (px == null) continue; u += (px - p.fill) * p.sh; } return u; };
  const equityAt = (mark) => NAV0 + realized + unrealAt(mark);            // NET (after costs) — drives sizing/cap
  const equityGrossAt = (mark) => NAV0 + realizedGross + unrealAt(mark);  // GROSS (before commission + slippage)
  const grossAt = (mark) => { let g = 0; for (const [t, p] of Object.entries(positions)) g += p.sh * (mark[t] ?? p.fill); return g; };
  function closePos(t, exitPx, date, reason = 'STOP') {
    const p = positions[t]; if (!p) return;
    const comm = calcCommission(p.sh, exitPx), slip = calcSlippage(p.sh, exitPx);
    totalComm += comm; totalSlip += slip;
    const gross = (exitPx - p.fill) * p.sh; realizedGross += gross;       // gross: no costs
    const pnl = gross - comm - slip; realized += pnl;                     // net: minus costs
    const ei = T[t]?.idxByDate[p.entryDate], xi = T[t]?.idxByDate[date];  // hold time in TRADING days (bar-index delta)
    const holdDays = (ei != null && xi != null) ? (xi - ei) : null;
    const returnPct = p.fill > 0 ? +(((exitPx - p.fill) / p.fill) * 100).toFixed(2) : 0;   // price move %, same net/gross
    // FULL trade detail (extra fields are ignored by the baseline metrics; required by the IR trade log).
    closed.push({
      ticker: t, direction: 'LONG', entryDate: p.entryDate, exitDate: date,
      entryPrice: p.fill, exitPrice: exitPx, shares: p.sh, exitReason: reason,
      pnl, pnlGross: gross, holdDays, returnPct,
    });
    delete positions[t];
  }

  for (const date of allDates) {
    if (date < start) continue;
    for (const t of Object.keys(positions)) {
      const tk = T[t]; const i = tk.idxByDate[date]; if (i == null) continue;
      const bar = tk.bars[i]; const pos = positions[t];
      if (tk.loStop[i] != null) { const s = tk.loStop[i] - 0.01; pos.stop = pos.stop == null ? s : Math.max(pos.stop, s); }
      if (pos.stop != null && bar.l <= pos.stop) closePos(t, Math.min(pos.stop, bar.o), date, 'STOP');
    }
    const mark = {}; for (const t of Object.keys(positions)) { const i = T[t].idxByDate[date]; if (i != null) mark[t] = T[t].bars[i].c; }
    const curEq = equityAt(mark);
    for (const t of Object.keys(T)) {
      if (positions[t]) continue;
      const tk = T[t]; const i = tk.idxByDate[date]; if (i == null || i < ENTRY_HIGH_LOOKBACK) continue;
      const bar = tk.bars[i];
      if (tk.hi52[i] == null || bar.h < tk.hi52[i] + 0.01 || tk.loStop[i] == null) continue;
      const trig = +(tk.hi52[i] + 0.01).toFixed(2);
      const fill = Math.max(trig, bar.o);
      const stop = +(tk.loStop[i] - 0.01).toFixed(2);
      const rps = fill - stop; if (rps <= 0.01 || stop >= fill) continue;
      let sh = Math.min(Math.floor((curEq * VITALITY_PCT) / rps), Math.floor((curEq * TICKER_CAP_PCT) / fill));
      const advMax = Math.floor((tk.adv20[i] || 0) * ADV_CAP_PCT); if (advMax > 0) sh = Math.min(sh, advMax);
      if (sh < 1) continue;
      if (grossAt(mark) + sh * fill > MAX_GROSS * curEq) continue;
      const comm = calcCommission(sh, fill), slip = calcSlippage(sh, fill);
      totalComm += comm; totalSlip += slip; realized -= comm + slip;
      positions[t] = { sh, fill, stop, entryDate: date };
    }
    // breakeven snap (forward-only: set at the close, governs from the next bar). One stop:
    // pos.stop is floored at breakeven; the 2-week-low trail still ratchets it up later via max().
    if (beSnap > 0) {
      for (const t of Object.keys(positions)) {
        const tk = T[t]; const i = tk.idxByDate[date]; if (i == null) continue;
        const bar = tk.bars[i]; const pos = positions[t];
        if (bar.c < bar.o) continue;                                  // not a green day
        if ((bar.c - pos.fill) * pos.sh < beSnap) continue;           // not up enough yet
        const be = +pos.fill.toFixed(2);
        if (pos.stop == null || be > pos.stop) pos.stop = be;         // raise-only
      }
    }
    const eq = equityAt(mark); equity.push({ date, eq });
    if (eq > peak) peak = eq;
    const ddf = (eq - peak) / peak; if (ddf < maxDDfrac) maxDDfrac = ddf;
    if (peak - eq > maxDDdollar) maxDDdollar = peak - eq;
    const eqG = equityGrossAt(mark); equityGross.push({ date, eq: eqG });   // gross equity, same trades
    if (eqG > peakG) peakG = eqG;
    const ddfG = (eqG - peakG) / peakG; if (ddfG < maxDDfracG) maxDDfracG = ddfG;
    if (peakG - eqG > maxDDdollarG) maxDDdollarG = peakG - eqG;
  }
  for (const t of Object.keys(positions)) { const i = T[t].idxByDate[lastDate]; closePos(t, i != null ? T[t].bars[i].c : positions[t].fill, lastDate, 'OPEN_AT_END'); }

  return { equity, equityGross, closed, maxDDfrac, maxDDdollar, maxDDfracG, maxDDdollarG, totalComm, totalSlip, NAV0, lastDate };
}
