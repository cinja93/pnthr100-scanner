// ── PNTHR TREE — BUILD PROJECTION BASELINE (daily-10 stop, 2× cap) ───────────
// Runs the LOCKED Tree strategy (now in the SHARED treeSim.js engine, also used by
// the Investor Report builder genTreeIrData.js — so the dashboard and the IR can
// never diverge) and writes server/data/treeProjectionBaseline.json — the same
// shape Ambush uses, so the AumTracker panel renders Tree's OWN numbers.
//
//   AI-300 · LONG-only · FULL size (no pyramid) · enter on NEW intraday 42wk high (210 trading days)
//   (resting buy-stop, fill at worse of level/open) · stop = lowest low of prior 10
//   daily bars − .01, trail up · size = min(2% NAV/risk, 10% NAV/price) · GROSS ≤ 2× NAV.
//   Executable / no look-ahead. Costs: commission + slippage every leg. SURVIVORSHIP-FLATTERED.
//
// Run: node --env-file=../.env build_tree_baseline.mjs

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });
import fs from 'fs';
import { connectToDatabase } from '../database.js';
import { computeInputHash } from '../treeBaselineGuard.js';   // single shared fingerprint of the backtest inputs
import { loadTreeData, simulateTree, ENTRY_HIGH_LOOKBACK, BE_SNAP_PROFIT, DEFAULT_START, DEFAULT_END } from './treeSim.js';

// Sweep knobs (env overrides; production runs use the LOCKED defaults from treeSim.js).
const LOOKBACK = +(process.env.LOOKBACK) || ENTRY_HIGH_LOOKBACK;   // 42wk = 210d; override to sweep (60=12wk … 252=52wk)
const BE_SNAP = process.env.BE_SNAP != null ? +process.env.BE_SNAP : BE_SNAP_PROFIT;   // BE_SNAP=0 = old no-snap baseline
const START = process.env.START || DEFAULT_START;
const END = process.env.END || DEFAULT_END;   // FROZEN at the last session before go-live (reproducible)
const UNIVERSE = process.env.UNIVERSE || 'ai';   // 'ai' (default) | 'carn' (679 out-of-sample validation)
const NAV0 = 100000;

const db = await connectToDatabase();

// Load candles + run the shared LOCKED simulation (identical engine to the live dashboard + the IR).
const data = await loadTreeData(db, { end: END, universe: UNIVERSE, lookback: LOOKBACK });
const { spyAt, lastDate } = data;
const sim = simulateTree(data, { nav0: NAV0, start: START, beSnap: BE_SNAP });
const { equity, equityGross, closed, maxDDfrac, maxDDdollar, maxDDfracG, maxDDdollarG, totalComm, totalSlip } = sim;

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
  // per-trade winner / loser detail (return %, hold days, extremes). avgOf defined below in the
  // monthly block is hoisted? no — declare a local median helper; reuse simple inline averages.
  const medOf = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const avgArr = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const winRets = wins.map(t => t.returnPct ?? 0), lossRets = losses.map(t => t.returnPct ?? 0);
  const winHolds = wins.map(t => t.holdDays).filter(h => h != null), lossHolds = losses.map(t => t.holdDays).filter(h => h != null);
  const maxDDPct = Math.abs(mDDfrac) * 100;
  const monthEnd = {}, monthDays = {};
  for (const e of eqArr) { const k = e.date.slice(0, 7); monthEnd[k] = e.eq; (monthDays[k] ||= []).push(e.eq); }
  const months = Object.keys(monthEnd).sort(); let posM = 0, totM = 0, prev = NAV0; const mRets = [];
  for (const m of months) { const r = monthEnd[m] / prev - 1; mRets.push(r * 100); if (r > 0) posM++; totM++; prev = monthEnd[m]; }
  // monthly risk/return profile
  const avgOf = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const ups = mRets.filter(r => r > 0), downs = mRets.filter(r => r < 0);
  const maxMonthlyDD = mRets.length ? Math.min(...mRets) : 0;           // worst single calendar month
  let mPk = -Infinity, worstStretch = 0; for (const m of months) { const v = monthEnd[m]; if (v > mPk) mPk = v; if (mPk > 0) { const d = (v - mPk) / mPk * 100; if (d < worstStretch) worstStretch = d; } }
  const intra = []; for (const m of months) { let pk = -Infinity, dd = 0; for (const v of monthDays[m]) { if (v > pk) pk = v; if (pk > 0) { const d = (v - pk) / pk; if (d < dd) dd = d; } } intra.push(dd * 100); }
  let worstRolling30 = 0;
  for (let i = 0; i < eqArr.length; i++) { let lp = eqArr[i].eq; for (let j = i; j < eqArr.length; j++) { if ((Date.parse(eqArr[j].date) - Date.parse(eqArr[i].date)) / 86400000 > 31) break; if (eqArr[j].eq > lp) lp = eqArr[j].eq; const d = (eqArr[j].eq - lp) / lp * 100; if (d < worstRolling30) worstRolling30 = d; } }
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
    // monthly risk/return profile (for the dashboard drawdown panel + row tiles)
    maxMonthlyDDPct: +maxMonthlyDD.toFixed(1),
    avgDownMonthPct: +avgOf(downs).toFixed(1),
    avgWithinMonthDipPct: +avgOf(intra).toFixed(1),
    worstRolling30Pct: +worstRolling30.toFixed(1),
    worstStretchPct: +worstStretch.toFixed(1),
    bestMonthPct: +Math.max(0, ...mRets).toFixed(1),
    avgUpMonthPct: +avgOf(ups).toFixed(1),
    avgMonthPct: +avgOf(mRets).toFixed(1),
    // winner / loser per-trade detail
    winnersN: wins.length, losersN: losses.length,
    avgWinPct: +avgArr(winRets).toFixed(1), avgWinDollar: Math.round(avgWin),
    winnerHoldDays: +avgArr(winHolds).toFixed(1), winnerHoldMed: medOf(winHolds), largestWinPct: +(winRets.length ? Math.max(...winRets) : 0).toFixed(1),
    avgLossPct: +avgArr(lossRets).toFixed(1), avgLossDollar: -Math.round(avgLoss),
    loserHoldDays: +avgArr(lossHolds).toFixed(1), loserHoldMed: medOf(lossHolds), largestLossPct: +(lossRets.length ? Math.min(...lossRets) : 0).toFixed(1),
  };
}
// Hold time across all closed trades (winners + losers), in trading days. Same for net/gross
// (identical trades). Right-skewed — winners ride, losers cut — so report mean AND median.
const holds = closed.map(c => c.holdDays).filter(h => h != null).sort((a, b) => a - b);
const avgHoldDays = holds.length ? +(holds.reduce((a, b) => a + b, 0) / holds.length).toFixed(1) : null;
const medianHoldDays = holds.length ? holds[Math.floor(holds.length / 2)] : null;
const metrics = computeMetrics(equity, 'pnl', maxDDfrac, maxDDdollar);              // NET (dashboard headline)
const grossMetrics = computeMetrics(equityGross, 'pnlGross', maxDDfracG, maxDDdollarG);  // GROSS (before costs)
const factors = equity.map((e, i) => ({ i, date: e.date, factor: +(e.eq / NAV0).toFixed(6) }));  // projection uses NET curve
const inputFingerprint = await computeInputHash(db);   // stamp the exact inputs so the drift guard can detect future data changes

const out = {
  generatedFrom: 'build_tree_baseline.mjs',
  strategy: `AI-300 · LONG-only · new intraday 42wk high (210d) · daily-10 stop · 2% risk / 10% cap · 2× gross cap · breakeven snap (+$${BE_SNAP} & green)`,
  disclosure: 'Hypothetical. Universe = current AI-300 members → SURVIVORSHIP-FLATTERED. Breakeven snap modeled on a green-DAY proxy for the live green-HOUR rule (approximate). Backtest FROZEN at go-live (2026-06-11); live track record begins 2026-06-12. Not a track record.',
  version: `tree-${lastDate}`,
  backtestStart: equity[0].date,        // first session traded (frozen)
  backtestEnd: lastDate,                // last session before go-live (frozen at 2026-06-11)
  backtestStartNav: NAV0,
  backtestEndNav: metrics.endingEquity,
  tradingDays: factors.length,
  avgHoldDays,                          // mean trading days held per closed trade
  medianHoldDays,                       // median trading days held (less skewed by long winners)
  inputHash: inputFingerprint.hash,     // fingerprint of the candle inputs (drift guard)
  inputNames: inputFingerprint.names,
  metrics,                     // NET (dashboard headline)
  metricsGross: grossMetrics,  // GROSS (before commission + slippage) — frontend renders a 2nd row when present
  costs: { commission: Math.round(totalComm), slippage: Math.round(totalSlip) },
  factors,
};
const outPath = new URL('../data/treeProjectionBaseline.json', import.meta.url).pathname;
if (process.env.NO_WRITE !== '1') fs.writeFileSync(outPath, JSON.stringify(out, null, 1));   // NO_WRITE=1 → sweep mode, never overwrite the live baseline

console.log('\n  ════ TREE BASELINE WRITTEN ════');
console.log('  ' + outPath);
console.log(`  Period ${equity[0].date}→${lastDate} · ${factors.length} sessions · ${closed.length} trades`);
console.log('  NET  :', JSON.stringify(metrics));
console.log('  GROSS:', JSON.stringify(grossMetrics));
console.log(`  costs: comm $${Math.round(totalComm).toLocaleString()} · slip $${Math.round(totalSlip).toLocaleString()}`);
process.exit(0);
