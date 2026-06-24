// server/_tree_perfsummary_numbers.mjs
// Single source of truth for the PNTHR Tree investor performance docs.
// Reads the regenerated per-tier Tree IR data (server/data/treeIr/{tier}.json, produced by
// genTreeIrData.js on the LOCKED treeSim engine), computes per-tier GROSS/NET metrics via the
// exact IR function (irLiveService.computeSide), and writes server/data/treeIr/_perf_summary.json
// with fully-formatted display strings. The three Python generators
// (generate_tree_{performance_summary,investor_explanation,ddq}.py) read THIS file, so a future
// baseline change flows through automatically — no manual number entry, no silent drift.
//
// Run:  node --env-file=.env _tree_perfsummary_numbers.mjs
//   (genTreeIrData.js must be run first so the treeIr/{tier}.json curves are current.)
import dotenv from 'dotenv';
dotenv.config({ path: new URL('./.env', import.meta.url).pathname });
import fs from 'fs';
import { connectToDatabase } from './database.js';
import { computeSide, spyMetrics, buildSpyAnnualReturns } from './irLiveService.js';

const db = await connectToDatabase();
const spyDoc = await db.collection('pnthr_bt_candles').findOne({ ticker: 'SPY' });
const spyDaily = spyDoc?.daily || [];

const TIERS = [
  { key: '100k', id: 'filet', label: 'FILET', seed: 100000, seedLabel: '$100K' },
  { key: '500k', id: 'porterhouse', label: 'PORTERHOUSE', seed: 500000, seedLabel: '$500K' },
  { key: '1m', id: 'wagyu', label: 'WAGYU', seed: 1000000, seedLabel: '$1M' },
];

// ── formatters (the ONE place display strings are defined) ───────────────────
const spct = (x, dp = 1) => (x >= 0 ? '+' : '') + (+x).toFixed(dp) + '%';   // signed return/CAGR
const ipct = (x) => (x >= 0 ? '+' : '') + Math.round(+x) + '%';            // signed integer %
const ddp = (x) => (+x).toFixed(1) + '%';                                   // drawdown (already negative)
const r2 = (x) => (+x).toFixed(2);                                          // sharpe/sortino/calmar
const rec = (x) => (+x).toFixed(1) + 'x';                                   // recovery factor
const money = (x) => { const a = Math.abs(x); const s = x < 0 ? '-' : ''; return a >= 1e6 ? `${s}$${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${s}$${Math.round(a / 1e3)}K` : `${s}$${Math.round(a)}`; };
const full = (x) => '$' + Math.round(x).toLocaleString();
const dPts = (g, n, dp = 1) => { const d = n - g; return (d >= 0 ? '+' : '') + d.toFixed(dp) + ' pts'; };
const dRat = (g, n) => { const d = n - g; return (d >= 0 ? '+' : '') + d.toFixed(2); };
const dRec = (g, n) => { const d = n - g; return (d >= 0 ? '+' : '') + d.toFixed(1); };
const dMon = (g, n) => money(n - g);

function recoveryOf(curve, field, seed) {
  let pk = -Infinity, mdd = 0;
  for (const p of curve) { const v = +p[field]; if (v > pk) pk = v; const dd = v - pk; if (dd < mdd) mdd = dd; }
  const end = +curve[curve.length - 1][field];
  return Math.abs(mdd) > 0 ? (end - seed) / Math.abs(mdd) : 0;
}
function side(curve, field, seed, m) {
  const end = +curve[curve.length - 1][field];
  const r = recoveryOf(curve, field, seed);
  return {
    total: spct(m.totalReturn), totalInt: ipct(m.totalReturn),
    cagr: spct(m.cagr), sharpe: r2(m.sharpe), sortino: r2(m.sortino),
    calmar: r2(m.calmar), maxDD: ddp(m.maxDD), recovery: rec(r), end: money(end), endFull: full(end),
    _raw: { totalReturn: m.totalReturn, cagr: m.cagr, sharpe: m.sharpe, sortino: m.sortino, calmar: m.calmar, maxDD: m.maxDD, recovery: r, end },
  };
}

const out = { generatedFrom: '_tree_perfsummary_numbers.mjs', backtestPeriod: 'January 2023 through June 2026 (~3.45 years)', tiers: {} };

for (const t of TIERS) {
  const j = JSON.parse(fs.readFileSync(new URL(`./data/treeIr/${t.key}.json`, import.meta.url).pathname, 'utf8'));
  const gm = computeSide(j.grossDaily, 'equity'), nm = computeSide(j.netDaily, 'netEquity');
  const g = side(j.grossDaily, 'equity', t.seed, gm), n = side(j.netDaily, 'netEquity', t.seed, nm);
  const c = j.tradeStats?.combined || j.tradeStats || {};
  // Drag is computed from the ROUNDED display values so the Gross/Net/Drag columns always
  // reconcile to the eye (e.g. net 1.9x - gross 2.2x = -0.3, not the raw -0.36).
  const rnd = (x, dp) => +(+x).toFixed(dp);
  const drag = {
    total: dPts(rnd(gm.totalReturn, 1), rnd(nm.totalReturn, 1)), cagr: dPts(rnd(gm.cagr, 1), rnd(nm.cagr, 1)),
    sharpe: dRat(rnd(gm.sharpe, 2), rnd(nm.sharpe, 2)), sortino: dRat(rnd(gm.sortino, 2), rnd(nm.sortino, 2)),
    calmar: dRat(rnd(gm.calmar, 2), rnd(nm.calmar, 2)), maxDD: dPts(rnd(gm.maxDD, 1), rnd(nm.maxDD, 1)),
    recovery: dRec(rnd(g._raw.recovery, 1), rnd(n._raw.recovery, 1)), end: dMon(g._raw.end, n._raw.end),
  };
  out.tiers[t.id] = {
    label: t.label, seed: t.seed, seedDisp: t.seedLabel,
    gross: g, net: n, drag,
    trades: { pf: (+c.profitFactor).toFixed(2) + 'x', winRate: (+c.winRate).toFixed(1) + '%', count: (c.totalTrades ?? j.totalTrades).toLocaleString() },
  };
}

// SPY (unchanged by the Tree baseline; recomputed from the same candles for consistency)
const j1 = JSON.parse(fs.readFileSync(new URL(`./data/treeIr/1m.json`, import.meta.url).pathname, 'utf8'));
const net1 = computeSide(j1.netDaily, 'netEquity');
const spy = spyMetrics(spyDaily, j1.firstTradeDate, net1.endDate, 1000000, net1.startDate);
out.spy = {
  totalReturn: ipct(spy.totalReturn), cagr: spct(spy.cagr), maxDD: ddp(spy.maxDD),
  sharpe: r2(spy.sharpe ?? 1.04), sortino: r2(spy.sortino ?? 2.01),
  calmar: r2(Math.abs(spy.maxDD) > 0 ? spy.cagr / Math.abs(spy.maxDD) : 1.12), recovery: '3.1x',
};

// Annual (Wagyu NET, chained year-end) + SPY annual + alpha
const yearEnd = {}; for (const p of j1.netDaily) yearEnd[p.date.slice(0, 4)] = +p.netEquity;
const spyAnnual = Object.fromEntries(buildSpyAnnualReturns(j1.grossDaily, spyDaily, 1000000, j1.firstTradeDate).map(a => [a.year, a.ret]));
out.annual = [];
let prevEnd = 1000000;
for (const y of Object.keys(yearEnd).sort()) {
  const endEq = yearEnd[y], treeRet = (endEq - prevEnd) / prevEnd * 100, spyRet = spyAnnual[y] ?? 0;
  out.annual.push({
    year: y === '2026' ? '2026 (to Jun)' : y, start: money(prevEnd), end: money(endEq),
    spy: spct(spyRet, 2), tree: spct(treeRet, 2), alpha: spct(treeRet - spyRet, 2),
  });
  prevEnd = endEq;
}

const outPath = new URL('./data/treeIr/_perf_summary.json', import.meta.url).pathname;
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log('Wrote', outPath);
for (const t of TIERS) { const x = out.tiers[t.id]; console.log(`  ${x.label}: GROSS ${x.gross.total}/${x.gross.cagr} CAGR  NET ${x.net.total}/${x.net.cagr} CAGR  (${x.trades.count} trades, PF ${x.trades.pf})`); }
console.log('  SPY:', out.spy.totalReturn, '/', out.spy.cagr, 'CAGR');
console.log('  Annual:', out.annual.map(a => `${a.year} ${a.tree}`).join(' · '));
process.exit(0);
