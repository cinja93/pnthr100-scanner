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

const NAV0 = 100000, VITALITY_PCT = 0.02, TICKER_CAP_PCT = 0.10, MAX_GROSS = 2.0;
const LOOKBACK_52W = 252, STOP_LOOKBACK = 10, ADV_CAP_PCT = 0.02;
const START = '2023-01-03';

const db = await connectToDatabase();

// ── load + precompute ───────────────────────────────────────────────────────
const docs = await db.collection('pnthr_ai_bt_candles').find({}).toArray();
const T = {}; const allDatesSet = new Set();
for (const d of docs) {
  const bars = (d.daily || []).map(b => ({ date: b.date, o: +b.open, h: +b.high, l: +b.low, c: +b.close, v: +b.volume || 0 }))
    .filter(b => b.l > 0 && b.c > 0).sort((a, b) => a.date.localeCompare(b.date));
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
let realized = 0, totalComm = 0, totalSlip = 0;
const closed = []; const equity = [];
let peak = NAV0, maxDDfrac = 0, maxDDdollar = 0;

const equityAt = (mark) => { let u = 0; for (const [t, p] of Object.entries(positions)) { const px = mark[t]; if (px == null) continue; u += (px - p.fill) * p.sh; } return NAV0 + realized + u; };
const grossAt = (mark) => { let g = 0; for (const [t, p] of Object.entries(positions)) g += p.sh * (mark[t] ?? p.fill); return g; };
function closePos(t, exitPx, date) {
  const p = positions[t]; if (!p) return;
  const comm = calcCommission(p.sh, exitPx), slip = calcSlippage(p.sh, exitPx);
  totalComm += comm; totalSlip += slip;
  const pnl = (exitPx - p.fill) * p.sh - comm - slip; realized += pnl;
  closed.push({ ticker: t, pnl }); delete positions[t];
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
}
const lastDate = allDates[allDates.length - 1];
for (const t of Object.keys(positions)) { const i = T[t].idxByDate[lastDate]; closePos(t, i != null ? T[t].bars[i].c : positions[t].fill, lastDate); }

// ── metrics ──────────────────────────────────────────────────────────────────
const endEq = equity[equity.length - 1].eq;
const firstDate = equity[0].date;
const years = (Date.parse(lastDate) - Date.parse(firstDate)) / (365.25 * 86400000);
const cagr = Math.pow(endEq / NAV0, 1 / years) - 1;
const rets = []; for (let i = 1; i < equity.length; i++) rets.push((equity[i].eq - equity[i - 1].eq) / Math.max(1, equity[i - 1].eq));
const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
const dsd = Math.sqrt(rets.filter(r => r < 0).reduce((a, b) => a + b * b, 0) / rets.length);
const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;
const sortino = dsd > 0 ? (mean / dsd) * Math.sqrt(252) : 0;
const wins = closed.filter(t => t.pnl > 0), losses = closed.filter(t => t.pnl <= 0);
const grossWin = wins.reduce((a, t) => a + t.pnl, 0), grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
const pf = grossLoss > 0 ? grossWin / grossLoss : 0;
const avgWin = wins.length ? grossWin / wins.length : 0, avgLoss = losses.length ? grossLoss / losses.length : 0;
const maxDDPct = Math.abs(maxDDfrac) * 100;
// monthly returns → positive-month %
const monthEnd = {}; for (const e of equity) monthEnd[e.date.slice(0, 7)] = e.eq;
const months = Object.keys(monthEnd).sort(); let posM = 0, totM = 0; let prev = NAV0;
for (const m of months) { const r = monthEnd[m] / prev - 1; if (r > 0) posM++; totM++; prev = monthEnd[m]; }
// SPY alpha over the same window
const spyFirst = spyAt(firstDate, +1), spyLast = spyAt(lastDate, -1);
const spyRet = (spyFirst && spyLast) ? (spyLast / spyFirst - 1) : 0;
const spyEnd = NAV0 * (1 + spyRet);
const alphaDollar = endEq - spyEnd;

const metrics = {
  netReturnPct: +(((endEq - NAV0) / NAV0) * 100).toFixed(1),
  cagrPct: +(cagr * 100).toFixed(1),
  sharpe: +sharpe.toFixed(2), sortino: +sortino.toFixed(2),
  profitFactor: +pf.toFixed(2),
  calmar: maxDDPct > 0 ? +((cagr * 100) / maxDDPct).toFixed(2) : 0,
  recoveryFactor: maxDDdollar > 0 ? +((endEq - NAV0) / maxDDdollar).toFixed(1) : 0,
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
const factors = equity.map((e, i) => ({ i, date: e.date, factor: +(e.eq / NAV0).toFixed(6) }));

const out = {
  generatedFrom: 'build_tree_baseline.mjs',
  strategy: 'AI-300 · LONG-only · new intraday 52wk high · daily-10 stop · 2% risk / 10% cap · 2× gross cap',
  disclosure: 'Hypothetical. Universe = current AI-300 members → SURVIVORSHIP-FLATTERED. Not a track record.',
  version: `tree-${lastDate}`,
  backtestStartNav: NAV0,
  backtestEndNav: Math.round(endEq),
  tradingDays: factors.length,
  metrics,
  factors,
};
const outPath = new URL('../data/treeProjectionBaseline.json', import.meta.url).pathname;
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));

console.log('\n  ════ TREE BASELINE WRITTEN ════');
console.log('  ' + outPath);
console.log(`  Period ${firstDate}→${lastDate} (${years.toFixed(2)}y) · ${factors.length} trading days`);
console.log('  metrics:', JSON.stringify(metrics, null, 1));
console.log(`  SPY: ${spyFirst?.toFixed(2)} → ${spyLast?.toFixed(2)}  (${(spyRet*100).toFixed(1)}%)`);
console.log(`  costs: comm $${Math.round(totalComm).toLocaleString()} · slip $${Math.round(totalSlip).toLocaleString()}`);
process.exit(0);
