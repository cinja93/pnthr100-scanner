// READ-ONLY: reconstruct the HANDS-OFF (no-intervention) PNTHR Tree over the fund-compare
// window (2026-06-22 → today) using the LOCKED treeSim engine (executable, no look-ahead,
// MOST_LIQUID priority). Fairness: warm up BEFORE 06-22 so the book is mature entering the
// window (Elite/Ambush also entered 06-22 with mature books), then REBASE to $89,882 on 06-22
// and measure the segment. Robustness: vary warm-up start + entry tiebreak; segment must hold.
// No DB writes, no UI. Prints daily series (gross+net), segment returns, trades, coverage.
import dotenv from 'dotenv'; dotenv.config({ path: new URL('../.env', import.meta.url).pathname });
import { MongoClient } from 'mongodb';
import { loadTreeData, simulateTree, MOST_LIQUID, CLOSEST_TO_TRIGGER } from './treeSim.js';

const BASELINE = 89882;              // common fund-compare baseline (Tree's 06-22 NAV)
const SEG_START = '2026-06-22';
const END = '2026-07-02';
const ALPHA = (a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0);   // pure-alphabetical tiebreak sensitivity

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db(process.env.MONGODB_DB_NAME || 'pnthr100');

console.log('Loading AI-300 candles through', END, '...');
const data = await loadTreeData(db, { end: END, universe: 'ai' });
console.log('tickers loaded:', Object.keys(data.T).length, '| allDates:', data.allDates.length,
  '| first', data.allDates[0], '| LAST', data.lastDate);
const inWindow = data.allDates.filter(d => d >= SEG_START && d <= END);
console.log('trading dates in window 06-22..%s:', END, inWindow.join(', '));

// Extract the SEG_START→asOf segment from a full equity curve and rebase to $BASELINE on the
// first in-window bar. Returns { series, segRet, base0 } for a given curve.
function segment(curve, asOf = END) {
  const pts = curve.filter(p => p.date >= SEG_START && p.date <= asOf);
  if (!pts.length) return { series: [], segRet: null };
  const base0 = pts[0].eq;                       // NAV on the first in-window bar
  const series = pts.map(p => ({ date: p.date, eq: +(BASELINE * (p.eq / base0)).toFixed(0),
    ret: +((p.eq / base0 - 1) * 100).toFixed(2) }));
  return { series, segRet: series[series.length - 1].ret, base0 };
}

function run(label, { start, sort }) {
  const r = simulateTree(data, { nav0: BASELINE, start, entrySort: sort });
  const g = segment(r.equityGross);
  const n = segment(r.equity);
  return { label, start, gross: g, net: n, closed: r.closed, raw: r };
}

// ── PRIMARY + robustness battery ─────────────────────────────────────────────
const runs = [
  run('PRIMARY  warmup 2025-09-02, MOST_LIQUID', { start: '2025-09-02', sort: MOST_LIQUID }),
  run('warmup   2026-01-02, MOST_LIQUID',        { start: '2026-01-02', sort: MOST_LIQUID }),
  run('warmup   2026-03-02, MOST_LIQUID',        { start: '2026-03-02', sort: MOST_LIQUID }),
  run('warmup   2025-06-02, MOST_LIQUID',        { start: '2025-06-02', sort: MOST_LIQUID }),
  run('tiebreak CLOSEST_TO_TRIGGER (2025-09-02)',{ start: '2025-09-02', sort: CLOSEST_TO_TRIGGER }),
  run('tiebreak ALPHABETICAL (2025-09-02)',      { start: '2025-09-02', sort: ALPHA }),
];

console.log('\n=== ROBUSTNESS: hands-off Tree segment return, rebased to $%s ===', BASELINE);
console.log('variant                                        | gross@Jul1 | gross@Jul2 | net@Jul2 | 06-22 book NAV');
for (const r of runs) {
  const g1 = segment(r.raw.equityGross, '2026-07-01').segRet;
  console.log(`${r.label.padEnd(46)} | ${String(g1).padStart(8)}% | ${String(r.gross.segRet).padStart(8)}% | ${String(r.net.segRet).padStart(6)}% | $${Math.round(r.gross.base0)}`);
}

// July 2 candle completeness — is it a real after-close bar or a partial/forming one?
console.log('\n=== Jul-2 bar completeness (vs Jul-1) for liquid names ===');
for (const t of ['NVDA','AMD','MU','AVGO','INTC','AAPL']) {
  const tk = data.T[t]; if (!tk) { console.log(`  ${t}: not loaded`); continue; }
  const i2 = tk.idxByDate['2026-07-02'], i1 = tk.idxByDate['2026-07-01'];
  const b2 = i2 != null ? tk.bars[i2] : null, b1 = i1 != null ? tk.bars[i1] : null;
  console.log(`  ${t.padEnd(5)} Jul1 c=${b1?.c} v=${b1?.v} | Jul2 o=${b2?.o} h=${b2?.h} l=${b2?.l} c=${b2?.c} v=${b2?.v}`);
}

const P = runs[0];
console.log('\n=== PRIMARY daily path (hands-off Tree, rebased $%s on 06-22) ===', BASELINE);
console.log('date        | gross eq   gross%  | net eq     net%');
for (let i = 0; i < P.gross.series.length; i++) {
  const g = P.gross.series[i], n = P.net.series[i];
  console.log(`${g.date} | $${String(g.eq).padStart(7)} ${String(g.ret).padStart(6)}% | $${String(n.eq).padStart(7)} ${String(n.ret).padStart(6)}%`);
}

// Trades closed WITHIN the window (transparency) + open positions at end
const winClosed = P.closed.filter(t => t.exitDate >= SEG_START);
console.log('\n=== PRIMARY: trades that closed in-window (%d) ===', winClosed.length);
for (const t of winClosed.slice(0, 40)) console.log(`  ${t.entryDate}→${t.exitDate} ${t.ticker} ${t.shares}sh ${t.entryPrice}→${t.exitPrice} net$${Math.round(t.pnl)} (${t.exitReason})`);
const openAtEnd = P.closed.filter(t => t.exitReason === 'OPEN_AT_END');
console.log(`\n=== PRIMARY: still-open at ${END} (marked to close): ${openAtEnd.length} ===`);
for (const t of openAtEnd.slice(0, 60)) console.log(`  ${t.ticker} entered ${t.entryDate} ${t.shares}sh @${t.entryPrice} → mark ${t.exitPrice} net$${Math.round(t.pnl)}`);

await client.close(); process.exit(0);
