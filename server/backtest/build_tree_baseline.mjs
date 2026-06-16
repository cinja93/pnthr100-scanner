// ── PNTHR TREE — BUILD PROJECTION BASELINE (daily-10 stop, 2× cap) ───────────
// Runs the LOCKED Tree strategy (matches pnthrTreeEngine.js) and writes
// server/data/treeProjectionBaseline.json — the same shape Ambush uses, so the
// AumTracker panel renders Tree's OWN numbers (not Ambush's).
//
//   AI-300 · LONG-only · FULL size (no pyramid) · enter on NEW intraday 52wk high
//   (resting buy-stop, fill at worse of level/open) · stop = lowest low of prior 10
//   daily bars − .01, trail up · size = min(2% NAV/risk, 10% NAV/price) · GROSS ≤ 2× NAV.
//   Executable / no look-ahead. Costs: commission + slippage every leg. SURVIVORSHIP-FLATTERED.
//
// Run: node --env-file=../.env build_tree_baseline.mjs

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });
import fs from 'fs';
import { connectToDatabase } from '../database.js';
import { calcCommission, calcSlippage } from './costEngine.js';
import { computeInputHash } from '../treeBaselineGuard.js';   // single shared fingerprint of the backtest inputs

const NAV0 = 100000, VITALITY_PCT = 0.02, TICKER_CAP_PCT = 0.10, MAX_GROSS = 2.0;
const LOOKBACK_52W = 252, STOP_LOOKBACK = 10, ADV_CAP_PCT = 0.02;
const START = '2023-01-03';
// Backtest END is FROZEN at the last session before go-live (strategy went LIVE Fri 2026-06-12).
// A backtest must not bleed into the live period, and freezing the endpoint makes the result
// reproducible — it no longer drifts as new daily bars arrive. Live performance from 06-12
// onward is the real track record (the dashboard's ACTUAL AUM line), tracked separately.
const END = '2026-06-11';

const db = await connectToDatabase();

// ── load + precompute ───────────────────────────────────────────────────────
const docs = await db.collection('pnthr_ai_bt_candles').find({}).toArray();
const T = {}; const allDatesSet = new Set();
for (const d of docs) {
  const bars = (d.daily || []).map(b => ({ date: b.date, o: +b.open, h: +b.high, l: +b.low, c: +b.close, v: +b.volume || 0 }))
    .filter(b => b.l > 0 && b.c > 0 && b.date <= END).sort((a, b) => a.date.localeCompare(b.date));
  if (bars.length < LOOKBACK_52W + 5) continue;
  const n = bars.length;
  const hi52 = new Array(n).fill(null), loStop = new Array(n).fill(null), adv20 = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (i >= LOOKBACK_52W) { let mh = -Infinity; for (let j = i - LOOKBACK_52W; j < i; j++) if (bars[j].h > mh) mh = bars[j].h; hi52[i] = mh; }
    if (i >= STOP_LOOKBACK) { let sl = Infinity; for (let j = i - STOP_LOOKBACK; j < i; j++) if (bars[j].l < sl) sl = bars[j].l; loStop[i] = sl; }
    if (i >= 20) { let v = 0; for (let j = i - 20; j < i; j++) v += bars[j].v; adv20[i] = v / 20; }
    allDatesSet.add(bars[i].date);
  }
  const idxByDate = {}; bars.forEach((b, i) => { idxByDate[b.date] = i; });
  T[d.ticker] = { bars, idxByDate, hi52, loStop, adv20 };
}
const allDates = [...allDatesSet].sort();

// ── SPY benchmark (stitch the two DB sources to cover the full period) ────────
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

// ── simulation (daily-10 stop, 2× gross cap) ─────────────────────────────────
const positions = {};
let realized = 0, realizedGross = 0, totalComm = 0, totalSlip = 0;
const closed = []; const equity = []; const equityGross = [];
let peak = NAV0, maxDDfrac = 0, maxDDdollar = 0;
let peakG = NAV0, maxDDfracG = 0, maxDDdollarG = 0;

const unrealAt = (mark) => { let u = 0; for (const [t, p] of Object.entries(positions)) { const px = mark[t]; if (px == null) continue; u += (px - p.fill) * p.sh; } return u; };
const equityAt = (mark) => NAV0 + realized + unrealAt(mark);            // NET (after costs) — drives sizing/cap, unchanged
const equityGrossAt = (mark) => NAV0 + realizedGross + unrealAt(mark);  // GROSS (before commission + slippage)
const grossAt = (mark) => { let g = 0; for (const [t, p] of Object.entries(positions)) g += p.sh * (mark[t] ?? p.fill); return g; };
function closePos(t, exitPx, date) {
  const p = positions[t]; if (!p) return;
  const comm = calcCommission(p.sh, exitPx), slip = calcSlippage(p.sh, exitPx);
  totalComm += comm; totalSlip += slip;
  const gross = (exitPx - p.fill) * p.sh; realizedGross += gross;       // gross: no costs
  const pnl = gross - comm - slip; realized += pnl;                     // net: minus costs
  closed.push({ ticker: t, pnl, pnlGross: gross }); delete positions[t];
}

for (const date of allDates) {
  if (date < START) continue;
  for (const t of Object.keys(positions)) {
    const tk = T[t]; const i = tk.idxByDate[date]; if (i == null) continue;
    const bar = tk.bars[i]; const pos = positions[t];
    if (tk.loStop[i] != null) { const s = tk.loStop[i] - 0.01; pos.stop = pos.stop == null ? s : Math.max(pos.stop, s); }
    if (pos.stop != null && bar.l <= pos.stop) closePos(t, Math.min(pos.stop, bar.o), date);
  }
  const mark = {}; for (const t of Object.keys(positions)) { const i = T[t].idxByDate[date]; if (i != null) mark[t] = T[t].bars[i].c; }
  const curEq = equityAt(mark);
  for (const t of Object.keys(T)) {
    if (positions[t]) continue;
    const tk = T[t]; const i = tk.idxByDate[date]; if (i == null || i < LOOKBACK_52W) continue;
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
  const eq = equityAt(mark); equity.push({ date, eq });
  if (eq > peak) peak = eq;
  const ddf = (eq - peak) / peak; if (ddf < maxDDfrac) maxDDfrac = ddf;
  if (peak - eq > maxDDdollar) maxDDdollar = peak - eq;
  const eqG = equityGrossAt(mark); equityGross.push({ date, eq: eqG });   // gross equity, same trades
  if (eqG > peakG) peakG = eqG;
  const ddfG = (eqG - peakG) / peakG; if (ddfG < maxDDfracG) maxDDfracG = ddfG;
  if (peakG - eqG > maxDDdollarG) maxDDdollarG = peakG - eqG;
}
const lastDate = allDates[allDates.length - 1];
for (const t of Object.keys(positions)) { const i = T[t].idxByDate[lastDate]; closePos(t, i != null ? T[t].bars[i].c : positions[t].fill, lastDate); }

// ── metrics — computed identically for NET (after costs) and GROSS (before costs) ───
// Same trades either way; gross just adds the commission+slippage back. pnlField selects
// which per-trade P&L to use; the equity array selects which curve drives Sharpe/DD.
function computeMetrics(eqArr, pnlField, mDDfrac, mDDdollar) {
  const endEq = eqArr[eqArr.length - 1].eq;
  const firstDate = eqArr[0].date;
  const years = (Date.parse(lastDate) - Date.parse(firstDate)) / (365.25 * 86400000);
  const cagr = Math.pow(endEq / NAV0, 1 / years) - 1;
  const rets = []; for (let i = 1; i < eqArr.length; i++) rets.push((eqArr[i].eq - eqArr[i - 1].eq) / Math.max(1, eqArr[i - 1].eq));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  const dsd = Math.sqrt(rets.filter(r => r < 0).reduce((a, b) => a + b * b, 0) / rets.length);
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;
  const sortino = dsd > 0 ? (mean / dsd) * Math.sqrt(252) : 0;
  const wins = closed.filter(t => t[pnlField] > 0), losses = closed.filter(t => t[pnlField] <= 0);
  const grossWin = wins.reduce((a, t) => a + t[pnlField], 0), grossLoss = Math.abs(losses.reduce((a, t) => a + t[pnlField], 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : 0;
  const avgWin = wins.length ? grossWin / wins.length : 0, avgLoss = losses.length ? grossLoss / losses.length : 0;
  const maxDDPct = Math.abs(mDDfrac) * 100;
  const monthEnd = {}; for (const e of eqArr) monthEnd[e.date.slice(0, 7)] = e.eq;
  const months = Object.keys(monthEnd).sort(); let posM = 0, totM = 0, prev = NAV0;
  for (const m of months) { const r = monthEnd[m] / prev - 1; if (r > 0) posM++; totM++; prev = monthEnd[m]; }
  const spyFirst = spyAt(firstDate, +1), spyLast = spyAt(lastDate, -1);
  const spyRet = (spyFirst && spyLast) ? (spyLast / spyFirst - 1) : 0;
  const alphaDollar = endEq - NAV0 * (1 + spyRet);
  return {
    netReturnPct: +(((endEq - NAV0) / NAV0) * 100).toFixed(1),   // total return % for this stream
    cagrPct: +(cagr * 100).toFixed(1),
    sharpe: +sharpe.toFixed(2), sortino: +sortino.toFixed(2),
    profitFactor: +pf.toFixed(2),
    calmar: maxDDPct > 0 ? +((cagr * 100) / maxDDPct).toFixed(2) : 0,
    recoveryFactor: mDDdollar > 0 ? +((endEq - NAV0) / mDDdollar).toFixed(1) : 0,
    positiveMonthsPct: totM > 0 ? +((posM / totM) * 100).toFixed(1) : 0,
    winRatePct: +((wins.length / (closed.length || 1)) * 100).toFixed(0),
    payoff: avgLoss > 0 ? +(avgWin / avgLoss).toFixed(2) : 0,
    maxDDPct: +maxDDPct.toFixed(2),
    totalClosed: closed.length,
    endingEquity: Math.round(endEq),
    alphaDollar: Math.round(alphaDollar),
    alphaPct: +((alphaDollar / NAV0) * 100).toFixed(0),
    spyReturnPct: +(spyRet * 100).toFixed(1),
    startNav: NAV0,
  };
}
const metrics = computeMetrics(equity, 'pnl', maxDDfrac, maxDDdollar);              // NET (dashboard headline)
const grossMetrics = computeMetrics(equityGross, 'pnlGross', maxDDfracG, maxDDdollarG);  // GROSS (before costs)
const factors = equity.map((e, i) => ({ i, date: e.date, factor: +(e.eq / NAV0).toFixed(6) }));  // projection uses NET curve
const inputFingerprint = await computeInputHash(db);   // stamp the exact inputs so the drift guard can detect future data changes

const out = {
  generatedFrom: 'build_tree_baseline.mjs',
  strategy: 'AI-300 · LONG-only · new intraday 52wk high · daily-10 stop · 2% risk / 10% cap · 2× gross cap',
  disclosure: 'Hypothetical. Universe = current AI-300 members → SURVIVORSHIP-FLATTERED. Backtest FROZEN at go-live (2026-06-11); live track record begins 2026-06-12. Not a track record.',
  version: `tree-${lastDate}`,
  backtestStartNav: NAV0,
  backtestEndNav: metrics.endingEquity,
  tradingDays: factors.length,
  inputHash: inputFingerprint.hash,     // fingerprint of the candle inputs (drift guard)
  inputNames: inputFingerprint.names,
  metrics,                     // NET (dashboard headline)
  metricsGross: grossMetrics,  // GROSS (before commission + slippage) — frontend renders a 2nd row when present
  costs: { commission: Math.round(totalComm), slippage: Math.round(totalSlip) },
  factors,
};
const outPath = new URL('../data/treeProjectionBaseline.json', import.meta.url).pathname;
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));

console.log('\n  ════ TREE BASELINE WRITTEN ════');
console.log('  ' + outPath);
console.log(`  Period ${equity[0].date}→${lastDate} · ${factors.length} sessions · ${closed.length} trades`);
console.log('  NET  :', JSON.stringify(metrics));
console.log('  GROSS:', JSON.stringify(grossMetrics));
console.log(`  costs: comm $${Math.round(totalComm).toLocaleString()} · slip $${Math.round(totalSlip).toLocaleString()}`);
process.exit(0);
