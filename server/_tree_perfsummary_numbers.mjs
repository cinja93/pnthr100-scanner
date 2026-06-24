import dotenv from 'dotenv';
dotenv.config({ path: new URL('./.env', import.meta.url).pathname });
import fs from 'fs';
import { connectToDatabase } from './database.js';
import { computeSide, spyMetrics, buildSpyAnnualReturns } from './irLiveService.js';

const db = await connectToDatabase();
const spyDoc = await db.collection('pnthr_bt_candles').findOne({ ticker: 'SPY' });
const spyDaily = spyDoc?.daily || [];
const tiers = [
  { key: '100k', label: 'FILET', seed: 100000 },
  { key: '500k', label: 'PORTERHOUSE', seed: 500000 },
  { key: '1m', label: 'WAGYU', seed: 1000000 },
];
function recoveryOf(curve, field, seed) {
  let pk = -Infinity, mdd = 0;
  for (const p of curve) { const v = +p[field]; if (v > pk) pk = v; const dd = v - pk; if (dd < mdd) mdd = dd; }
  const end = +curve[curve.length - 1][field];
  return Math.abs(mdd) > 0 ? +((end - seed) / Math.abs(mdd)).toFixed(1) : 0;
}
const R = (m) => ({ tot: m.totalReturn, cagr: m.cagr, sharpe: m.sharpe, sortino: m.sortino, calmar: m.calmar, maxDD: m.maxDD });
for (const t of tiers) {
  const j = JSON.parse(fs.readFileSync(new URL(`./data/treeIr/${t.key}.json`, import.meta.url).pathname, 'utf8'));
  const gross = computeSide(j.grossDaily, 'equity'), net = computeSide(j.netDaily, 'netEquity');
  console.log(`\n=== ${t.label} ($${t.seed.toLocaleString()}) — ${j.totalTrades} trades ===`);
  console.log('GROSS:', JSON.stringify({ ...R(gross), rec: recoveryOf(j.grossDaily, 'equity', t.seed), end: Math.round(+j.grossDaily.at(-1).equity) }));
  console.log('NET  :', JSON.stringify({ ...R(net), rec: recoveryOf(j.netDaily, 'netEquity', t.seed), end: Math.round(+j.netDaily.at(-1).netEquity) }));
  const c = j.tradeStats?.combined || j.tradeStats || {};
  console.log('TRADE:', JSON.stringify({ profitFactor: c.profitFactor, winRate: c.winRate, total: c.totalTrades ?? j.totalTrades }));
}
const j1 = JSON.parse(fs.readFileSync(new URL(`./data/treeIr/1m.json`, import.meta.url).pathname, 'utf8'));
const net1 = computeSide(j1.netDaily, 'netEquity');
const spy = spyMetrics(spyDaily, j1.firstTradeDate, net1.endDate, 1000000, net1.startDate);
console.log('\n=== SPY full period ===', JSON.stringify({ tot: spy.totalReturn, cagr: spy.cagr, maxDD: spy.maxDD }));
console.log('Tree WAGYU-NET annual %:', JSON.stringify(net1.annualReturns));
console.log('SPY annual %:', JSON.stringify(buildSpyAnnualReturns(j1.grossDaily, spyDaily, 1000000, j1.firstTradeDate)));
const byYear = {}; for (const p of j1.netDaily) byYear[p.date.slice(0,4)] = Math.round(+p.netEquity);
console.log('WAGYU-NET year-end equity:', JSON.stringify(byYear), '| firstTrade', j1.firstTradeDate, '| start', net1.startDate, '| end', net1.endDate);
process.exit(0);
