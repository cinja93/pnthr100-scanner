// server/scripts/buildEliteProjectionBaseline.mjs
// Builds server/data/eliteProjectionBaseline.json (same shape as ambushProjectionBaseline.json)
// from the GATED MCE backtest gross NAV curve + trade log, applying the PPM v6.9 Filet
// fee engine (NET of fund fees) — so the Elite AI "Projected vs Actual AUM" panel mirrors
// the Ambush one. Every number is COMPUTED from the backtest, not hardcoded.
//
// Run: cd server && node scripts/buildEliteProjectionBaseline.mjs
// Prereq: a clean gated baseline run of ai300MceSimulator.js --nav 100000 (writes the
//         pnthr_ai_bt_pyramid_nav_100k_daily_nav_gross + _trade_log collections).
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
const URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB_NAME || 'pnthr_den';

// PPM v6.9 — Filet $100K tier (matches mceNetComparison.mjs)
const MGMT_FEE_ANNUAL = 0.02, LOYALTY_MONTHS = 36;
const TIER = { nav: 100_000, baseRate: 0.30, loyaltyRate: 0.25 };
const US2Y_HURDLE_PCT = { 2019:2.50,2020:1.58,2021:0.11,2022:0.78,2023:4.40,2024:4.33,2025:4.25,2026:3.47 };
const US3MT_RATES_PCT = { 2019:2.40,2020:1.56,2021:0.06,2022:0.09,2023:4.29,2024:5.40,2025:4.30,2026:3.82 };
const ym = s => s.slice(0, 7);
const qk = s => s.slice(0, 4) + '-Q' + Math.ceil(parseInt(s.slice(5, 7), 10) / 3);

function applyFeeEngine(grossCurve, tier) {
  const { nav: STARTING_NAV, baseRate, loyaltyRate } = tier;
  let netNav = STARTING_NAV, hwm = STARTING_NAV, lra = 0, monthIdx = 0, quarterStartNav = STARTING_NAV;
  const netCurve = []; let prev = grossCurve[0].equity;
  for (let i = 0; i < grossCurve.length; i++) {
    const day = grossCurve[i];
    if (i > 0 && prev > 0) netNav *= (1 + (day.equity - prev) / prev);
    prev = day.equity;
    const nxt = grossCurve[i + 1];
    const isMonthEnd = !nxt || ym(day.date) !== ym(nxt.date);
    const isQuarterEnd = !nxt || qk(day.date) !== qk(nxt.date);
    if (isMonthEnd) { netNav -= netNav * (MGMT_FEE_ANNUAL / 12); monthIdx++; }
    if (isQuarterEnd) {
      const year = parseInt(day.date.slice(0, 4), 10);
      const hurdle = quarterStartNav * ((US2Y_HURDLE_PCT[year] || 0) / 100 / 4);
      const qProfit = netNav - quarterStartNav;
      let lraRec = 0;
      if (qProfit > 0 && lra > 0) { lraRec = Math.min(qProfit, lra); lra -= lraRec; }
      else if (qProfit < 0) lra += Math.abs(qProfit);
      const excess = Math.max(0, (qProfit - lraRec) - hurdle);
      const rate = monthIdx >= LOYALTY_MONTHS ? loyaltyRate : baseRate;
      const pa = (netNav > hwm && lra === 0 && excess > 0) ? excess * rate : 0;
      netNav -= pa;
      if (pa > 0 && netNav > hwm) hwm = netNav;
      quarterStartNav = netNav;
    }
    netCurve.push({ date: day.date, netEquity: +netNav.toFixed(2) });
  }
  return netCurve;
}

function computeMetrics(curve, field) {
  const rets = [], exc = [];
  for (let i = 1; i < curve.length; i++) {
    const p = curve[i - 1][field], c = curve[i][field];
    if (p <= 0) continue;
    const r = (c - p) / p * 100; rets.push(r);
    exc.push(r - (US3MT_RATES_PCT[parseInt(curve[i].date.slice(0, 4), 10)] || 0) / 252);
  }
  const mean = rets.reduce((s, r) => s + r, 0) / (rets.length || 1);
  const std = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(rets.length - 1, 1));
  const ds = rets.filter(r => r < 0);
  const dsStd = Math.sqrt(ds.reduce((s, r) => s + r * r, 0) / (rets.length || 1));
  const meanExc = exc.reduce((s, r) => s + r, 0) / (exc.length || 1);
  const sharpe = std > 0 ? (meanExc / std) * Math.sqrt(252) : 0;
  const sortino = dsStd > 0 ? (mean / dsStd) * Math.sqrt(252) : 0;
  let peak = curve[0][field], maxDdPct = 0, maxDdDollar = 0;
  for (const d of curve) {
    if (d[field] > peak) peak = d[field];
    const ddP = peak > 0 ? (d[field] - peak) / peak * 100 : 0;
    if (ddP < maxDdPct) maxDdPct = ddP;
    const ddD = d[field] - peak;
    if (ddD < maxDdDollar) maxDdDollar = ddD;
  }
  const first = curve[0][field], last = curve[curve.length - 1][field];
  const years = (new Date(curve[curve.length - 1].date + 'T12:00:00') - new Date(curve[0].date + 'T12:00:00')) / (365.25 * 86400000);
  const cagr = first > 0 && last > 0 && years > 0 ? (Math.pow(last / first, 1 / years) - 1) * 100 : 0;
  const totalReturn = first > 0 ? (last - first) / first * 100 : 0;
  const calmar = maxDdPct < 0 ? cagr / Math.abs(maxDdPct) : 0;
  const me = {};
  for (const d of curve) { const m = d.date.slice(0, 7); if (!me[m]) me[m] = { start: d[field], end: d[field] }; me[m].end = d[field]; }
  let pos = 0, tot = 0;
  for (const m of Object.keys(me)) { tot++; if (me[m].end > me[m].start) pos++; }
  return { sharpe, sortino, maxDdPct, maxDdDollar, cagr, totalReturn, calmar, first, last, pos, tot };
}

async function main() {
  const client = new MongoClient(URI); await client.connect();
  const db = client.db(DB_NAME);
  const gross = await db.collection('pnthr_ai_bt_pyramid_nav_100k_daily_nav_gross').find({}).sort({ date: 1 }).toArray();
  const trades = await db.collection('pnthr_ai_bt_pyramid_nav_100k_trade_log').find({}).toArray();
  if (!gross.length) { console.error('No gross NAV curve — run ai300MceSimulator.js --nav 100000 first.'); process.exit(1); }

  const netCurve = applyFeeEngine(gross, TIER);
  const m = computeMetrics(netCurve, 'netEquity');
  const startNav = TIER.nav;

  // Trade-level stats (gross trade P&L — fund fees are book-level, not per-trade)
  const closed = trades.filter(t => t.exitReason && t.exitReason !== 'STILL_OPEN');
  const pnl = t => (t.netDollarPnl ?? t.grossDollarPnl ?? 0);
  const wins = closed.filter(t => pnl(t) > 0), losses = closed.filter(t => pnl(t) < 0);
  const sumWin = wins.reduce((s, t) => s + pnl(t), 0), sumLoss = Math.abs(losses.reduce((s, t) => s + pnl(t), 0));
  const profitFactor = sumLoss > 0 ? sumWin / sumLoss : 0;
  const winRatePct = closed.length ? wins.length / closed.length * 100 : 0;
  const avgWin = wins.length ? sumWin / wins.length : 0, avgLoss = losses.length ? sumLoss / losses.length : 0;
  const payoff = avgLoss > 0 ? avgWin / avgLoss : 0;

  // SPY benchmark over the same window (for alpha)
  const startDate = netCurve[0].date, endDate = netCurve[netCurve.length - 1].date;
  const spyDoc = await db.collection('pnthr_bt_candles_weekly').findOne({ ticker: 'SPY' });
  const spyW = (spyDoc?.weekly || []).filter(b => b.weekOf >= startDate && b.weekOf <= endDate).sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  const spyReturnPct = spyW.length >= 2 ? (spyW[spyW.length - 1].close - spyW[0].close) / spyW[0].close * 100 : 0;

  const netReturnPct = m.totalReturn;
  const alphaPct = netReturnPct - spyReturnPct;
  const alphaDollar = alphaPct / 100 * startNav;
  const recoveryFactor = m.maxDdDollar < 0 ? (m.last - startNav) / Math.abs(m.maxDdDollar) : 0;

  const factors = netCurve.map((d, i) => ({ i, date: d.date, factor: +(d.netEquity / startNav).toFixed(6) }));

  // ── GROSS (before fund fees) — straight from the simulator's daily NAV curve ──
  const mG = computeMetrics(gross, 'equity');
  const grossReturnPct = mG.totalReturn;
  const grossAlphaPct = grossReturnPct - spyReturnPct;
  const grossRecovery = mG.maxDdDollar < 0 ? (mG.last - startNav) / Math.abs(mG.maxDdDollar) : 0;
  const factorsGross = gross.map((d, i) => ({ i, date: d.date, factor: +(d.equity / startNav).toFixed(6) }));

  const out = {
    generatedFrom: 'ai300MceSimulator.js (gated baseline: PAI300 36W regime + sector rotation) + PPM v6.9 Filet fee engine. metrics = NET of fund fees; metricsGross = GROSS. HYPOTHETICAL / survivorship-flattered (AI-300 index back-cast) — internal tracker, not a track record.',
    version: 'elite-1.1.0',
    backtestStartNav: startNav,
    backtestEndNav: Math.round(m.last),
    backtestEndNavGross: Math.round(mG.last),
    tradingDays: factors.length,
    metrics: {
      netReturnPct: +netReturnPct.toFixed(1),
      cagrPct: +m.cagr.toFixed(1),
      sharpe: +m.sharpe.toFixed(2),
      sortino: +m.sortino.toFixed(1),
      profitFactor: +profitFactor.toFixed(1),
      calmar: +m.calmar.toFixed(2),
      recoveryFactor: +recoveryFactor.toFixed(1),
      positiveMonthsPct: +(m.pos / (m.tot || 1) * 100).toFixed(1),
      winRatePct: Math.round(winRatePct),
      payoff: +payoff.toFixed(1),
      maxDDPct: +Math.abs(m.maxDdPct).toFixed(2),
      totalClosed: closed.length,
      endingEquity: Math.round(m.last),
      alphaDollar: Math.round(alphaDollar),
      alphaPct: Math.round(alphaPct),
      spyReturnPct: +spyReturnPct.toFixed(1),
      startNav,
    },
    metricsGross: {
      netReturnPct: +grossReturnPct.toFixed(1),
      cagrPct: +mG.cagr.toFixed(1),
      sharpe: +mG.sharpe.toFixed(2),
      sortino: +mG.sortino.toFixed(1),
      profitFactor: +profitFactor.toFixed(1),
      calmar: +mG.calmar.toFixed(2),
      recoveryFactor: +grossRecovery.toFixed(1),
      positiveMonthsPct: +(mG.pos / (mG.tot || 1) * 100).toFixed(1),
      winRatePct: Math.round(winRatePct),
      payoff: +payoff.toFixed(1),
      maxDDPct: +Math.abs(mG.maxDdPct).toFixed(2),
      totalClosed: closed.length,
      endingEquity: Math.round(mG.last),
      alphaDollar: Math.round(grossAlphaPct / 100 * startNav),
      alphaPct: Math.round(grossAlphaPct),
      spyReturnPct: +spyReturnPct.toFixed(1),
      startNav,
    },
    factors,
    factorsGross,
  };

  const outPath = path.resolve(__dirname, '../data/eliteProjectionBaseline.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log('Wrote', outPath);
  console.log('Period:', startDate, '→', endDate, '|', factors.length, 'days');
  console.log('NET metrics:', JSON.stringify(out.metrics, null, 2));
  await client.close(); process.exit(0);
}
main().catch(e => { console.error(e.stack || e.message); process.exit(99); });
