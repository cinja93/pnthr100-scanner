// server/backtest/genNewHighsCards.mjs
// Single source of truth for the two New Highs backtest cards (AI 300 42wk + Carnivore 679 4wk).
// Writes client/src/data/newHighsCards.json so the New Highs page renders ENGINE-computed numbers
// (never hand-typed) with an as-of date and an input fingerprint for drift detection.
//   AI 300 card  = the Tree baseline (server/data/treeProjectionBaseline.json — already drift-guarded
//                  by treeBaselineGuard.js); we just surface its NET-of-costs metrics here.
//   Carnivore card = the 679 4-week-high breakout via the SHARED treeSim engine (universe=carn,
//                  lookback=20, NO breakeven snap — the snap is tuned for the Tree and hurts this signal).
// Re-run after any candle/universe/baseline change:
//   cd server/backtest && node --env-file=../.env genNewHighsCards.mjs
import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });
import fs from 'fs';
import crypto from 'crypto';
import { connectToDatabase } from '../database.js';
import { loadTreeData, simulateTree } from './treeSim.js';

const CARN_END = '2026-06-11', CARN_START = '2019-02-01', CARN_LOOKBACK = 20, NAV0 = 100000;

// Metrics for the card (mirrors build_tree_baseline.mjs computeMetrics — NET of costs, raw-mean Sharpe).
function metricsOf(sim, spyAt, lastDate) {
  const { equity, closed, maxDDfrac } = sim;
  const endEq = equity[equity.length - 1].eq, firstDate = equity[0].date;
  const years = (Date.parse(lastDate) - Date.parse(firstDate)) / (365.25 * 86400000);
  const cagr = Math.pow(endEq / NAV0, 1 / years) - 1;
  const rets = []; for (let i = 1; i < equity.length; i++) rets.push((equity[i].eq - equity[i - 1].eq) / Math.max(1, equity[i - 1].eq));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  const dsd = Math.sqrt(rets.filter(r => r < 0).reduce((a, b) => a + b * b, 0) / rets.length);
  const wins = closed.filter(t => t.pnl > 0), losses = closed.filter(t => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0), gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const avgWin = wins.length ? gw / wins.length : 0, avgLoss = losses.length ? gl / losses.length : 0;
  const maxDDPct = Math.abs(maxDDfrac) * 100;
  const spyFirst = spyAt(firstDate, +1), spyLast = spyAt(lastDate, -1);
  const spyRet = (spyFirst && spyLast) ? (spyLast / spyFirst - 1) : 0;
  return {
    netReturnPct: +(((endEq - NAV0) / NAV0) * 100).toFixed(1),
    cagrPct: +(cagr * 100).toFixed(1),
    sharpe: +(sd > 0 ? (mean / sd) * Math.sqrt(252) : 0).toFixed(2),
    sortino: +(dsd > 0 ? (mean / dsd) * Math.sqrt(252) : 0).toFixed(2),
    profitFactor: +(gl > 0 ? gw / gl : 0).toFixed(2),
    calmar: maxDDPct > 0 ? +((cagr * 100) / maxDDPct).toFixed(2) : 0,
    maxDDPct: +maxDDPct.toFixed(1),
    winRatePct: +((wins.length / (closed.length || 1)) * 100).toFixed(0),
    payoff: +(avgLoss > 0 ? avgWin / avgLoss : 0).toFixed(2),
    totalClosed: closed.length,
    spyReturnPct: +(spyRet * 100).toFixed(0),
  };
}

// SHA1 fingerprint of the exact candle inputs a backtest consumes (drift guard).
function fingerprint(docs, end, minBars) {
  const parts = [];
  for (const d of docs) {
    const bars = (d.daily || []).filter(b => +b.low > 0 && +b.close > 0 && b.date <= end).sort((a, b) => a.date.localeCompare(b.date));
    if (bars.length < minBars) continue;
    parts.push((d.ticker || '') + '|' + bars.map(b => `${b.date}:${(+b.open).toFixed(4)},${(+b.high).toFixed(4)},${(+b.low).toFixed(4)},${(+b.close).toFixed(4)}`).join(';'));
  }
  parts.sort();
  return { hash: crypto.createHash('sha1').update(parts.join('\n')).digest('hex'), names: parts.length };
}

const db = await connectToDatabase();

// ── AI 300 card — read the already-guarded Tree baseline (NET of costs) ──────────
const tb = JSON.parse(fs.readFileSync(new URL('../data/treeProjectionBaseline.json', import.meta.url).pathname, 'utf8'));
const a = tb.metrics;
const aiRows = [
  ['Net return', `+${Math.round(a.netReturnPct)}%`], ['CAGR', `${a.cagrPct}%`], ['Sharpe', a.sharpe.toFixed(2)], ['Sortino', a.sortino.toFixed(2)],
  ['Profit factor', `${a.profitFactor.toFixed(2)}x`], ['Calmar', a.calmar.toFixed(2)], ['Max drawdown', `${a.maxDDPct.toFixed(1)}%`],
  ['Win rate', `${a.winRatePct}% (${a.payoff.toFixed(2)}x payoff)`], ['Trades', a.totalClosed.toLocaleString()], ['vs SPY', `SPY +${Math.round(a.spyReturnPct)}%`],
];

// ── Carnivore card — run the 679 4-week-high breakout via the shared engine ──────
const carnData = await loadTreeData(db, { end: CARN_END, universe: 'carn', lookback: CARN_LOOKBACK });
const carnSim = simulateTree(carnData, { nav0: NAV0, start: CARN_START, beSnap: 0 });
const c = metricsOf(carnSim, carnData.spyAt, carnData.lastDate);
const carnCandles = await db.collection('pnthr_bt_candles').find({}).toArray();
const carnFp = fingerprint(carnCandles, CARN_END, CARN_LOOKBACK + 5);
const carnRows = [
  ['Net return', `+${Math.round(c.netReturnPct)}%`], ['CAGR', `${c.cagrPct}%`], ['Sharpe', c.sharpe.toFixed(2)], ['Sortino', c.sortino.toFixed(2)],
  ['Profit factor', `${c.profitFactor.toFixed(2)}x`], ['Calmar', c.calmar.toFixed(2)], ['Max drawdown', `${c.maxDDPct.toFixed(1)}%`],
  ['Win rate', `${c.winRatePct}%`], ['Trades', c.totalClosed.toLocaleString()], ['vs SPY', `SPY +${Math.round(c.spyReturnPct)}%`],
];

const out = {
  generatedFrom: 'genNewHighsCards.mjs',
  note: 'Engine-computed; do not hand-edit. Re-run after any candle/universe/baseline change.',
  ai:   { rows: aiRows,   asOf: tb.backtestEnd || CARN_END, inputHash: tb.inputHash || null },
  carn: { rows: carnRows, asOf: CARN_END, inputHash: carnFp.hash, inputNames: carnFp.names },
};
const outPath = new URL('../../client/src/data/newHighsCards.json', import.meta.url).pathname;
fs.mkdirSync(new URL('../../client/src/data/', import.meta.url).pathname, { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log('Wrote', outPath);
console.log('  AI 300 :', aiRows.map(r => r.join(' ')).join(' | '));
console.log('  Carn   :', carnRows.map(r => r.join(' ')).join(' | '), `(fp ${carnFp.hash.slice(0, 10)}, ${carnFp.names} names)`);
process.exit(0);
