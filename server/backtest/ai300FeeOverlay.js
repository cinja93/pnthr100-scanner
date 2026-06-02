// server/backtest/ai300FeeOverlay.js
// ── PNTHR AI Elite Fund — PPM v6.9 Fee Overlay ───────────────────────────
//
// Reads the gross daily NAV from the APEX v6 simulator output and applies
// the PPM-compliant fee schedule (2% annual mgmt + quarterly performance
// allocation with US2Y hurdle, HWM, LRA, 36-month loyalty step-down).
//
// Produces net daily NAV curves for all 3 tiers:
//   Filet ($100k)       — 30%/25% PA
//   Porterhouse ($500k) — 25%/20% PA
//   Wagyu ($1M)         — 20%/15% PA
//
// Reads:  pnthr_ai_bt_pyramid_nav_1m_daily_nav_gross
// Writes: pnthr_ai_bt_pyramid_nav_{tier}_daily_nav_gross  (scaled for 100k/500k)
//         pnthr_ai_bt_pyramid_nav_{tier}_daily_nav_net
//
// Usage: cd server && node backtest/ai300FeeOverlay.js
// ─────────────────────────────────────────────────────────────────────────────

import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const URI     = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB_NAME || 'pnthr_den';

const TIERS = [
  { label: 'Filet',       navLabel: '100k', startingCapital: 100_000,   baseRate: 0.30, loyaltyRate: 0.25 },
  { label: 'Porterhouse', navLabel: '500k', startingCapital: 500_000,   baseRate: 0.25, loyaltyRate: 0.20 },
  { label: 'Wagyu',       navLabel: '1m',   startingCapital: 1_000_000, baseRate: 0.20, loyaltyRate: 0.15 },
];

const US2Y_HURDLE_PCT = {
  2019: 2.50, 2020: 1.58, 2021: 0.11, 2022: 0.78,
  2023: 4.40, 2024: 4.33, 2025: 4.25, 2026: 3.47,
};

const US3MT_RATES_PCT = {
  2019: 2.40, 2020: 1.56, 2021: 0.06, 2022: 0.09,
  2023: 4.29, 2024: 5.40, 2025: 4.30, 2026: 3.82,
};

const MGMT_FEE_ANNUAL = 0.02;

function getQuarterKey(dateStr) {
  const y = dateStr.slice(0, 4);
  const m = parseInt(dateStr.slice(5, 7), 10);
  return y + '-Q' + Math.ceil(m / 3);
}
function getYearMonth(dateStr) {
  return dateStr.slice(0, 7);
}

export function applyFeeEngine(grossCurve, tier, opts = {}) {
  const { startingCapital, baseRate, loyaltyRate } = tier;
  const smooth = !!opts.smooth; // spread each quarter's fee across its days (no crystallization cliffs)

  let netNav = startingCapital;
  let hwm = startingCapital;
  let lra = 0;
  let totalMgmtFees = 0, totalPerfFees = 0;
  let monthIdx = 0;
  let quarterStartNav = startingCapital;

  const netCurve = [];
  const quarterlyLog = [];
  let prevGrossEquity = grossCurve[0].equity;

  for (let i = 0; i < grossCurve.length; i++) {
    const day = grossCurve[i];
    const grossEquity = day.equity;

    if (i > 0 && prevGrossEquity > 0) {
      const dailyReturn = (grossEquity - prevGrossEquity) / prevGrossEquity;
      netNav = netNav * (1 + dailyReturn);
    }
    prevGrossEquity = grossEquity;

    const nextDay = grossCurve[i + 1];
    const isMonthEnd   = !nextDay || getYearMonth(day.date) !== getYearMonth(nextDay.date);
    const isQuarterEnd = !nextDay || getQuarterKey(day.date) !== getQuarterKey(nextDay.date);

    if (isMonthEnd) {
      const mFee = netNav * (MGMT_FEE_ANNUAL / 12);
      netNav -= mFee;
      totalMgmtFees += mFee;
      monthIdx++;
    }

    if (isQuarterEnd) {
      const year = parseInt(day.date.slice(0, 4), 10);
      const us2yAnnualPct = US2Y_HURDLE_PCT[year] || 0;
      const hurdleAmount = quarterStartNav * (us2yAnnualPct / 100 / 4);
      const quarterProfit = netNav - quarterStartNav;

      let lraRecovery = 0;
      if (quarterProfit > 0 && lra > 0) {
        lraRecovery = Math.min(quarterProfit, lra);
        lra -= lraRecovery;
      } else if (quarterProfit < 0) {
        lra += Math.abs(quarterProfit);
      }

      const profitAfterLRA = quarterProfit - lraRecovery;
      const excessOverHurdle = Math.max(0, profitAfterLRA - hurdleAmount);
      const aboveHwm = netNav > hwm;
      const lraZeroAfterRecovery = lra === 0;
      const rate = monthIdx >= 36 ? loyaltyRate : baseRate;

      const eligible = aboveHwm && lraZeroAfterRecovery && excessOverHurdle > 0;
      const pa = eligible ? excessOverHurdle * rate : 0;

      netNav -= pa;
      totalPerfFees += pa;

      if (pa > 0 && netNav > hwm) hwm = netNav;

      quarterlyLog.push({
        quarterEnd: day.date,
        quarterStartNav: +quarterStartNav.toFixed(2),
        quarterProfit: +quarterProfit.toFixed(2),
        hurdleAmount: +hurdleAmount.toFixed(2),
        lraAfter: +lra.toFixed(2),
        rate, monthIdx, pa: +pa.toFixed(2),
        netNavAfterPA: +netNav.toFixed(2),
      });

      quarterStartNav = netNav;
    }

    netCurve.push({ date: day.date, netEquity: +netNav.toFixed(2) });
  }

  if (!smooth) {
    return { netCurve, totalMgmtFees: +totalMgmtFees.toFixed(2), totalPerfFees: +totalPerfFees.toFixed(2), finalHwm: +hwm.toFixed(2), finalLra: +lra.toFixed(2), quarterlyLog };
  }

  // ── Smooth pass ─────────────────────────────────────────────────────────────
  // Same fee SCHEDULE/amounts as above (HWM + hurdle + LRA + loyalty all already
  // resolved in quarterlyLog), but spread each quarter's performance fee evenly
  // across that quarter's trading days, and accrue the 2% mgmt fee daily. This
  // removes the quarter-end "cliffs" so risk metrics (Sharpe/Sortino/MaxDD) and the
  // equity curve / heatmap reflect the strategy, not fee-payment timing. Returns
  // net of all fees; total fee dollars are essentially unchanged.
  const perfByQuarter = new Map(quarterlyLog.map(q => [getQuarterKey(q.quarterEnd), q.pa]));
  const daysInQuarter = new Map();
  for (const d of grossCurve) {
    const qk = getQuarterKey(d.date);
    daysInQuarter.set(qk, (daysInQuarter.get(qk) || 0) + 1);
  }
  const smoothCurve = [];
  let nav = startingCapital;
  let prevG = grossCurve[0].equity;
  let smMgmt = 0, smPerf = 0;
  for (let i = 0; i < grossCurve.length; i++) {
    const day = grossCurve[i];
    if (i > 0 && prevG > 0) nav *= (1 + (day.equity - prevG) / prevG);
    prevG = day.equity;
    const mgmt = nav * (MGMT_FEE_ANNUAL / 252);
    nav -= mgmt; smMgmt += mgmt;
    const qk = getQuarterKey(day.date);
    const dPerf = (perfByQuarter.get(qk) || 0) / (daysInQuarter.get(qk) || 1);
    nav -= dPerf; smPerf += dPerf;
    smoothCurve.push({ date: day.date, netEquity: +nav.toFixed(2) });
  }
  return { netCurve: smoothCurve, totalMgmtFees: +smMgmt.toFixed(2), totalPerfFees: +smPerf.toFixed(2), finalHwm: +hwm.toFixed(2), finalLra: +lra.toFixed(2), quarterlyLog, smoothed: true };
}

function computeDailyMetrics(curve, equityField) {
  const dailyReturns = [];
  const dailyExcess = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1][equityField];
    const cur  = curve[i][equityField];
    if (prev <= 0) continue;
    const retPct = (cur - prev) / prev * 100;
    dailyReturns.push(retPct);
    const rfAnnual = US3MT_RATES_PCT[parseInt(curve[i].date.slice(0, 4), 10)] || 0;
    dailyExcess.push(retPct - rfAnnual / 252);
  }
  const meanDaily  = dailyReturns.reduce((s, r) => s + r, 0) / (dailyReturns.length || 1);
  const stdDaily   = Math.sqrt(dailyReturns.reduce((s, r) => s + (r - meanDaily) ** 2, 0) / Math.max(dailyReturns.length - 1, 1));
  const dsStdDaily = Math.sqrt(dailyReturns.filter(r => r < 0).reduce((s, r) => s + r * r, 0) / (dailyReturns.length || 1));
  const meanExcess = dailyExcess.reduce((s, r) => s + r, 0) / (dailyExcess.length || 1);
  const sharpe  = stdDaily > 0 ? (meanExcess / stdDaily) * Math.sqrt(252) : 0;
  const sortino = dsStdDaily > 0 ? (meanDaily / dsStdDaily) * Math.sqrt(252) : 0;

  let peak = curve[0][equityField];
  let maxDdPct = 0;
  for (const d of curve) {
    if (d[equityField] > peak) peak = d[equityField];
    const dd = peak > 0 ? (d[equityField] - peak) / peak * 100 : 0;
    if (dd < maxDdPct) maxDdPct = dd;
  }
  const first = curve[0][equityField];
  const last = curve[curve.length - 1][equityField];
  const firstDate = new Date(curve[0].date + 'T12:00:00');
  const lastDate = new Date(curve[curve.length - 1].date + 'T12:00:00');
  const yearsSpan = (lastDate - firstDate) / (365.25 * 86400000);
  const cagr = first > 0 && last > 0 && yearsSpan > 0
    ? (Math.pow(last / first, 1 / yearsSpan) - 1) * 100 : 0;
  const totalReturn = first > 0 ? (last - first) / first * 100 : 0;
  return { sharpe, sortino, maxDdPct, cagr, totalReturn, startingEquity: first, endingEquity: last, days: dailyReturns.length };
}

async function main() {
  console.log('═'.repeat(70));
  console.log('  PNTHR AI ELITE FUND — PPM v6.9 FEE OVERLAY');
  console.log('═'.repeat(70) + '\n');

  const client = new MongoClient(URI);
  await client.connect();
  const db = client.db(DB_NAME);

  // Load the $1M gross NAV curve
  const grossDocs = await db.collection('pnthr_ai_bt_pyramid_nav_1m_daily_nav_gross')
    .find({}).sort({ date: 1 }).toArray();
  console.log(`Loaded ${grossDocs.length} gross daily NAV points (1M tier)\n`);

  if (grossDocs.length === 0) {
    console.error('No gross NAV data found. Run ai300BacktestSimulator.js first.');
    process.exit(1);
  }

  const BASE_NAV = 1_000_000;

  for (const tier of TIERS) {
    const { label, navLabel, startingCapital } = tier;
    const scale = startingCapital / BASE_NAV;

    console.log(`──── ${label} ($${(startingCapital/1000).toFixed(0)}k, ${(tier.baseRate*100).toFixed(0)}%/${(tier.loyaltyRate*100).toFixed(0)}% PA) ────`);

    // Scale gross curve proportionally
    const scaledGross = grossDocs.map(d => ({
      date: d.date,
      equity: +(d.equity * scale).toFixed(2),
    }));

    // Apply fee engine
    const { netCurve, totalMgmtFees, totalPerfFees, finalHwm, finalLra, quarterlyLog } =
      applyFeeEngine(scaledGross, tier);

    // Compute metrics
    const gross = computeDailyMetrics(scaledGross, 'equity');
    const net   = computeDailyMetrics(netCurve, 'netEquity');

    console.log(`  GROSS: +${gross.totalReturn.toFixed(1)}% / ${gross.cagr.toFixed(2)}% CAGR / Sharpe ${gross.sharpe.toFixed(2)} / MaxDD ${gross.maxDdPct.toFixed(2)}%`);
    console.log(`  NET:   +${net.totalReturn.toFixed(1)}% / ${net.cagr.toFixed(2)}% CAGR / Sharpe ${net.sharpe.toFixed(2)} / MaxDD ${net.maxDdPct.toFixed(2)}%`);
    console.log(`  Fees:  Mgmt $${Math.round(totalMgmtFees).toLocaleString()} + Perf $${Math.round(totalPerfFees).toLocaleString()} = $${Math.round(totalMgmtFees + totalPerfFees).toLocaleString()}`);
    console.log(`  HWM: $${Math.round(finalHwm).toLocaleString()} | LRA: $${Math.round(finalLra).toLocaleString()}`);
    console.log(`  Quarters w/ PA: ${quarterlyLog.filter(q => q.pa > 0).length} / ${quarterlyLog.length}`);

    // Persist
    const grossCol = `pnthr_ai_bt_pyramid_nav_${navLabel}_daily_nav_gross`;
    const netCol   = `pnthr_ai_bt_pyramid_nav_${navLabel}_daily_nav_net`;

    await db.collection(grossCol).deleteMany({});
    await db.collection(grossCol).insertMany(scaledGross);
    await db.collection(grossCol).createIndex({ date: 1 });
    console.log(`  → ${grossCol} (${scaledGross.length} docs)`);

    await db.collection(netCol).deleteMany({});
    await db.collection(netCol).insertMany(netCurve);
    await db.collection(netCol).createIndex({ date: 1 });
    console.log(`  → ${netCol} (${netCurve.length} docs)`);

    console.log('');
  }

  // Summary table
  console.log('═'.repeat(70));
  console.log('  SUMMARY — AI ELITE FUND NET PERFORMANCE (PPM v6.9)');
  console.log('═'.repeat(70));
  console.log('  Tier         | Gross CAGR | Net CAGR | Sharpe(G) | Sharpe(N) | MaxDD(N)');
  console.log('  -------------|------------|----------|-----------|-----------|--------');

  for (const tier of TIERS) {
    const scale = tier.startingCapital / BASE_NAV;
    const scaledGross = grossDocs.map(d => ({ date: d.date, equity: +(d.equity * scale).toFixed(2) }));
    const { netCurve } = applyFeeEngine(scaledGross, tier);
    const g = computeDailyMetrics(scaledGross, 'equity');
    const n = computeDailyMetrics(netCurve, 'netEquity');
    console.log(
      `  ${tier.label.padEnd(12)} | +${g.cagr.toFixed(2)}%`.padEnd(28) +
      ` | +${n.cagr.toFixed(2)}%`.padEnd(12) +
      ` | ${g.sharpe.toFixed(2)}`.padEnd(13) +
      ` | ${n.sharpe.toFixed(2)}`.padEnd(13) +
      ` | ${n.maxDdPct.toFixed(2)}%`
    );
  }

  console.log('\n  Phase 4 target (Wagyu): 41.57% net CAGR');
  console.log('  APEX v6 target (Wagyu, estimated): ~52% net CAGR\n');

  await client.close();
  process.exit(0);
}

// Only auto-run when invoked directly (node ai300FeeOverlay.js), NOT when imported
// as a module (e.g. genAmbushIrData.js reuses applyFeeEngine).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.stack || e.message); process.exit(99); });
}
