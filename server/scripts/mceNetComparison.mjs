// server/scripts/mceNetComparison.mjs
// Applies PPM v6.9 fee schedule to BOTH capital-constrained strategies:
//   1. IR Base  → pnthr_ai_bt_pyramid_nav_100k_daily_nav_gross_constrained
//   2. IR + MCE → pnthr_ai_bt_pyramid_nav_100k_daily_nav_gross_mce
// Outputs side-by-side Gross vs Net for Filet $100K tier.

import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const URI     = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB_NAME || 'pnthr_den';

// ── PPM v6.9 Fee Schedule ─────────────────────────────────────────────────
const MGMT_FEE_ANNUAL = 0.02;      // 2% per annum, accrued monthly
const LOYALTY_MONTHS   = 36;

const TIERS = [
  { label: 'Filet',       nav: 100_000,   navLabel: '100k', baseRate: 0.30, loyaltyRate: 0.25 },
  { label: 'Porterhouse', nav: 500_000,   navLabel: '500k', baseRate: 0.25, loyaltyRate: 0.20 },
  { label: 'Wagyu',       nav: 1_000_000, navLabel: '1m',   baseRate: 0.20, loyaltyRate: 0.15 },
];

// US 2-Year Treasury Yield (annual %) — hurdle rate source
const US2Y_HURDLE_PCT = {
  2019: 2.50, 2020: 1.58, 2021: 0.11, 2022: 0.78,
  2023: 4.40, 2024: 4.33, 2025: 4.25, 2026: 3.47,
};

// US 3-Month T-Bill (for Sharpe risk-free rate)
const US3MT_RATES_PCT = {
  2019: 2.40, 2020: 1.56, 2021: 0.06, 2022: 0.09,
  2023: 4.29, 2024: 5.40, 2025: 4.30, 2026: 3.82,
};

function getQuarterKey(dateStr) {
  const y = dateStr.slice(0, 4);
  const m = parseInt(dateStr.slice(5, 7), 10);
  return y + '-Q' + Math.ceil(m / 3);
}
function getYearMonth(dateStr) { return dateStr.slice(0, 7); }

// ── Fee Engine (PPM v6.9 compliant) ───────────────────────────────────────
function applyFeeEngine(grossCurve, tier) {
  const { nav: STARTING_NAV, baseRate, loyaltyRate } = tier;
  let netNav = STARTING_NAV;
  let hwm = STARTING_NAV;
  let lra = 0;
  let totalMgmtFees = 0, totalPerfFees = 0;
  let monthIdx = 0;
  let quarterStartNav = STARTING_NAV;

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

    // Monthly management fee: 2% / 12
    if (isMonthEnd) {
      const mFee = netNav * (MGMT_FEE_ANNUAL / 12);
      netNav -= mFee;
      totalMgmtFees += mFee;
      monthIdx++;
    }

    // Quarterly performance allocation
    if (isQuarterEnd) {
      const year = parseInt(day.date.slice(0, 4), 10);
      const us2yAnnualPct = US2Y_HURDLE_PCT[year] || 0;
      const hurdleAmount = quarterStartNav * (us2yAnnualPct / 100 / 4);
      const quarterProfit = netNav - quarterStartNav;

      // Loss Recovery Account
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
      const rate = monthIdx >= LOYALTY_MONTHS ? loyaltyRate : baseRate;

      const eligible = aboveHwm && lraZeroAfterRecovery && excessOverHurdle > 0;
      const pa = eligible ? excessOverHurdle * rate : 0;

      netNav -= pa;
      totalPerfFees += pa;

      if (pa > 0 && netNav > hwm) hwm = netNav;

      quarterlyLog.push({
        quarterEnd: day.date, quarterProfit: +quarterProfit.toFixed(2),
        hurdleAmount: +hurdleAmount.toFixed(2), rate, pa: +pa.toFixed(2),
        netNavAfterPA: +netNav.toFixed(2),
      });

      quarterStartNav = netNav;
    }

    netCurve.push({ date: day.date, netEquity: +netNav.toFixed(2) });
  }

  return { netCurve, totalMgmtFees, totalPerfFees, finalHwm: hwm, finalLra: lra, quarterlyLog };
}

// ── Metrics from daily curve ──────────────────────────────────────────────
function computeMetrics(curve, field) {
  const dailyReturns = [];
  const dailyExcess = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1][field];
    const cur  = curve[i][field];
    if (prev <= 0) continue;
    const retPct = (cur - prev) / prev * 100;
    dailyReturns.push(retPct);
    const rfAnnual = US3MT_RATES_PCT[parseInt(curve[i].date.slice(0, 4), 10)] || 0;
    dailyExcess.push(retPct - rfAnnual / 252);
  }

  const meanDaily  = dailyReturns.reduce((s, r) => s + r, 0) / (dailyReturns.length || 1);
  const stdDaily   = Math.sqrt(dailyReturns.reduce((s, r) => s + (r - meanDaily) ** 2, 0) / Math.max(dailyReturns.length - 1, 1));
  const dsReturns  = dailyReturns.filter(r => r < 0);
  const dsStdDaily = Math.sqrt(dsReturns.reduce((s, r) => s + r * r, 0) / (dailyReturns.length || 1));
  const meanExcess = dailyExcess.reduce((s, r) => s + r, 0) / (dailyExcess.length || 1);
  const sharpe  = stdDaily > 0 ? (meanExcess / stdDaily) * Math.sqrt(252) : 0;
  const sortino = dsStdDaily > 0 ? (meanDaily / dsStdDaily) * Math.sqrt(252) : 0;

  let peak = curve[0][field], maxDdPct = 0;
  for (const d of curve) {
    if (d[field] > peak) peak = d[field];
    const dd = peak > 0 ? (d[field] - peak) / peak * 100 : 0;
    if (dd < maxDdPct) maxDdPct = dd;
  }

  const first = curve[0][field], last = curve[curve.length - 1][field];
  const firstDate = new Date(curve[0].date + 'T12:00:00');
  const lastDate  = new Date(curve[curve.length - 1].date + 'T12:00:00');
  const years = (lastDate - firstDate) / (365.25 * 86400000);
  const cagr = first > 0 && last > 0 && years > 0 ? (Math.pow(last / first, 1 / years) - 1) * 100 : 0;
  const totalReturn = first > 0 ? (last - first) / first * 100 : 0;
  const calmar = maxDdPct < 0 ? cagr / Math.abs(maxDdPct) : 0;

  // Monthly returns for positive month count
  const monthlyPnl = {};
  for (let i = 1; i < curve.length; i++) {
    const m = curve[i].date.slice(0, 7);
    const prev = curve[i - 1][field];
    const cur  = curve[i][field];
    if (!monthlyPnl[m]) monthlyPnl[m] = 0;
    monthlyPnl[m] += cur - prev;
  }
  // Deduplicate by tracking month-start equity
  const monthEquity = {};
  for (const d of curve) {
    const m = d.date.slice(0, 7);
    if (!monthEquity[m]) monthEquity[m] = { start: d[field], end: d[field] };
    monthEquity[m].end = d[field];
  }
  let positiveMonths = 0, totalMonths = 0;
  for (const m of Object.keys(monthEquity).sort()) {
    totalMonths++;
    if (monthEquity[m].end > monthEquity[m].start) positiveMonths++;
  }

  return { sharpe, sortino, maxDdPct, cagr, totalReturn, calmar, startEq: first, endEq: last, positiveMonths, totalMonths };
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const client = new MongoClient(URI);
  await client.connect();
  const db = client.db(DB_NAME);

  console.log('═'.repeat(90));
  console.log('  PNTHR AI ELITE FUND — PPM v6.9 FEE OVERLAY — ALL TIERS');
  console.log('  Management Fee: 2.0% per annum, accrued monthly');
  console.log('  Hurdle: US 2-Year Treasury Yield, quarterly non-cumulative');
  console.log('  HWM: Running high water mark | LRA: Loss Recovery Account');
  console.log('  Trading costs: Already deducted in gross (comm + slip + borrow)');
  console.log('═'.repeat(90));

  const allResults = [];

  for (const tier of TIERS) {
    const { label, nav, navLabel, baseRate, loyaltyRate } = tier;

    const baseGross = await db.collection(`pnthr_ai_bt_pyramid_nav_${navLabel}_daily_nav_gross_constrained`)
      .find({}).sort({ date: 1 }).toArray();
    const mceGross = await db.collection(`pnthr_ai_bt_pyramid_nav_${navLabel}_daily_nav_gross_mce`)
      .find({}).sort({ date: 1 }).toArray();

    if (!baseGross.length || !mceGross.length) {
      console.error(`\n  Missing data for ${label} tier. Skipping.`);
      continue;
    }

    console.log(`\n${'━'.repeat(90)}`);
    console.log(`  ${label.toUpperCase()} CLASS — $${nav.toLocaleString()} — PA: ${(baseRate*100)}%/${(loyaltyRate*100)}%`);
    console.log('━'.repeat(90));

    // Base
    const baseGrossM = computeMetrics(baseGross, 'equity');
    const baseFee = applyFeeEngine(baseGross, tier);
    const baseNetM = computeMetrics(baseFee.netCurve, 'netEquity');

    // MCE
    const mceGrossM = computeMetrics(mceGross, 'equity');
    const mceFee = applyFeeEngine(mceGross, tier);
    const mceNetM = computeMetrics(mceFee.netCurve, 'netEquity');

    console.log(`\n  IR BASE:  Gross $${nav.toLocaleString()} → $${Math.round(baseGrossM.endEq).toLocaleString()} | Net → $${Math.round(baseNetM.endEq).toLocaleString()}`);
    console.log(`            Fees: Mgmt $${Math.round(baseFee.totalMgmtFees).toLocaleString()} + Perf $${Math.round(baseFee.totalPerfFees).toLocaleString()} = $${Math.round(baseFee.totalMgmtFees + baseFee.totalPerfFees).toLocaleString()}`);
    console.log(`  IR + MCE: Gross $${nav.toLocaleString()} → $${Math.round(mceGrossM.endEq).toLocaleString()} | Net → $${Math.round(mceNetM.endEq).toLocaleString()}`);
    console.log(`            Fees: Mgmt $${Math.round(mceFee.totalMgmtFees).toLocaleString()} + Perf $${Math.round(mceFee.totalPerfFees).toLocaleString()} = $${Math.round(mceFee.totalMgmtFees + mceFee.totalPerfFees).toLocaleString()}`);

    const pad = (s, n) => String(s).padStart(n);
    const row = (lbl, bg, bn, mg, mn) =>
      `  ${lbl.padEnd(22)} ${pad(bg, 12)} ${pad(bn, 12)}  │  ${pad(mg, 12)} ${pad(mn, 12)}`;

    console.log(`\n  ${''.padEnd(22)} ${'IR BASE'.padStart(12)} ${''.padStart(12)}  │  ${'IR + MCE'.padStart(12)} ${''.padStart(12)}`);
    console.log(`  ${'Metric'.padEnd(22)} ${'Gross'.padStart(12)} ${'Net'.padStart(12)}  │  ${'Gross'.padStart(12)} ${'Net'.padStart(12)}`);
    console.log('  ' + '─'.repeat(22) + ' ' + '─'.repeat(12) + ' ' + '─'.repeat(12) + '──┼──' + '─'.repeat(12) + ' ' + '─'.repeat(12));

    console.log(row('Final Equity',
      '$' + Math.round(baseGrossM.endEq).toLocaleString(),
      '$' + Math.round(baseNetM.endEq).toLocaleString(),
      '$' + Math.round(mceGrossM.endEq).toLocaleString(),
      '$' + Math.round(mceNetM.endEq).toLocaleString()));
    console.log(row('Total Return',
      '+' + baseGrossM.totalReturn.toFixed(1) + '%',
      '+' + baseNetM.totalReturn.toFixed(1) + '%',
      '+' + mceGrossM.totalReturn.toFixed(1) + '%',
      '+' + mceNetM.totalReturn.toFixed(1) + '%'));
    console.log(row('CAGR',
      '+' + baseGrossM.cagr.toFixed(2) + '%',
      '+' + baseNetM.cagr.toFixed(2) + '%',
      '+' + mceGrossM.cagr.toFixed(2) + '%',
      '+' + mceNetM.cagr.toFixed(2) + '%'));
    console.log(row('Sharpe Ratio',
      baseGrossM.sharpe.toFixed(2), baseNetM.sharpe.toFixed(2),
      mceGrossM.sharpe.toFixed(2), mceNetM.sharpe.toFixed(2)));
    console.log(row('Sortino Ratio',
      baseGrossM.sortino.toFixed(2), baseNetM.sortino.toFixed(2),
      mceGrossM.sortino.toFixed(2), mceNetM.sortino.toFixed(2)));
    console.log(row('Max Drawdown',
      baseGrossM.maxDdPct.toFixed(2) + '%', baseNetM.maxDdPct.toFixed(2) + '%',
      mceGrossM.maxDdPct.toFixed(2) + '%', mceNetM.maxDdPct.toFixed(2) + '%'));
    console.log(row('Calmar Ratio',
      baseGrossM.calmar.toFixed(2), baseNetM.calmar.toFixed(2),
      mceGrossM.calmar.toFixed(2), mceNetM.calmar.toFixed(2)));
    console.log(row('Positive Months',
      `${baseGrossM.positiveMonths}/${baseGrossM.totalMonths}`,
      `${baseNetM.positiveMonths}/${baseNetM.totalMonths}`,
      `${mceGrossM.positiveMonths}/${mceGrossM.totalMonths}`,
      `${mceNetM.positiveMonths}/${mceNetM.totalMonths}`));

    console.log(`\n  NET DELTA (MCE vs Base):`);
    console.log(`    CAGR:       ${baseNetM.cagr.toFixed(2)}% → ${mceNetM.cagr.toFixed(2)}%  (${(mceNetM.cagr - baseNetM.cagr) >= 0 ? '+' : ''}${(mceNetM.cagr - baseNetM.cagr).toFixed(2)}%)`);
    console.log(`    Sharpe:     ${baseNetM.sharpe.toFixed(2)} → ${mceNetM.sharpe.toFixed(2)}  (${(mceNetM.sharpe - baseNetM.sharpe) >= 0 ? '+' : ''}${(mceNetM.sharpe - baseNetM.sharpe).toFixed(2)})`);
    console.log(`    Max DD:     ${baseNetM.maxDdPct.toFixed(2)}% → ${mceNetM.maxDdPct.toFixed(2)}%  (${(mceNetM.maxDdPct - baseNetM.maxDdPct).toFixed(2)}%)`);
    console.log(`    Net Equity: $${Math.round(baseNetM.endEq).toLocaleString()} → $${Math.round(mceNetM.endEq).toLocaleString()}  (+$${Math.round(mceNetM.endEq - baseNetM.endEq).toLocaleString()})`);
    console.log(`    Fees Paid:  $${Math.round(baseFee.totalMgmtFees + baseFee.totalPerfFees).toLocaleString()} → $${Math.round(mceFee.totalMgmtFees + mceFee.totalPerfFees).toLocaleString()}  (+$${Math.round((mceFee.totalMgmtFees + mceFee.totalPerfFees) - (baseFee.totalMgmtFees + baseFee.totalPerfFees)).toLocaleString()})`);

    allResults.push({
      label, nav,
      baseGrossCAGR: baseGrossM.cagr, baseNetCAGR: baseNetM.cagr,
      mceGrossCAGR: mceGrossM.cagr, mceNetCAGR: mceNetM.cagr,
      baseNetSharpe: baseNetM.sharpe, mceNetSharpe: mceNetM.sharpe,
      baseNetDD: baseNetM.maxDdPct, mceNetDD: mceNetM.maxDdPct,
      baseNetEq: baseNetM.endEq, mceNetEq: mceNetM.endEq,
      baseFees: baseFee.totalMgmtFees + baseFee.totalPerfFees,
      mceFees: mceFee.totalMgmtFees + mceFee.totalPerfFees,
    });
  }

  // ── Summary Table ────────────────────────────────────────────────────────
  console.log('\n\n' + '═'.repeat(90));
  console.log('  MASTER SUMMARY — ALL TIERS — NET PERFORMANCE (PPM v6.9)');
  console.log('═'.repeat(90));
  console.log('                     │          IR BASE           │         IR + MCE           │   MCE Delta');
  console.log('  Tier          NAV  │  Net CAGR  Sharpe   MaxDD  │  Net CAGR  Sharpe   MaxDD  │  CAGR   Equity');
  console.log('  ───────────────────┼────────────────────────────┼────────────────────────────┼──────────────────');
  for (const r of allResults) {
    const navStr = r.nav >= 1_000_000 ? `$${r.nav / 1_000_000}M` : `$${r.nav / 1_000}K`;
    console.log(
      `  ${r.label.padEnd(12)} ${navStr.padStart(5)}` +
      `  │  ${('+' + r.baseNetCAGR.toFixed(2) + '%').padStart(9)}  ${r.baseNetSharpe.toFixed(2).padStart(5)}  ${(r.baseNetDD.toFixed(2) + '%').padStart(7)}` +
      `  │  ${('+' + r.mceNetCAGR.toFixed(2) + '%').padStart(9)}  ${r.mceNetSharpe.toFixed(2).padStart(5)}  ${(r.mceNetDD.toFixed(2) + '%').padStart(7)}` +
      `  │ ${('+' + (r.mceNetCAGR - r.baseNetCAGR).toFixed(1) + '%').padStart(6)}  +$${Math.round(r.mceNetEq - r.baseNetEq).toLocaleString()}`
    );
  }
  console.log('\n  S&P 500 benchmark: ~10% CAGR | -34% max drawdown (2022) | -50% (2008)');
  console.log('═'.repeat(90) + '\n');

  await client.close();
  process.exit(0);
}

main().catch(e => { console.error(e.stack || e.message); process.exit(99); });
