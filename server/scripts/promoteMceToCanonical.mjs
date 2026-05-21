// server/scripts/promoteMceToCanonical.mjs
// Promotes MCE capital-constrained backtest data to canonical collections:
//   _mce gross NAV → standard gross NAV (overwrite)
//   _mce trade log → standard trade log (overwrite)
//   Applies PPM v6.9 fee engine → standard net NAV (overwrite)
//
// After this runs, the entire downstream pipeline (ai300IrMetrics.js,
// generateAiEliteIR.py, irLiveService.js) picks up MCE data automatically.

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

const MGMT_FEE_ANNUAL = 0.02;
const US2Y_HURDLE_PCT = {
  2019: 2.50, 2020: 1.58, 2021: 0.11, 2022: 0.78,
  2023: 4.40, 2024: 4.33, 2025: 4.25, 2026: 3.47,
};

function getQuarterKey(dateStr) {
  const y = dateStr.slice(0, 4);
  const m = parseInt(dateStr.slice(5, 7), 10);
  return y + '-Q' + Math.ceil(m / 3);
}
function getYearMonth(dateStr) { return dateStr.slice(0, 7); }

function applyFeeEngine(grossCurve, tier) {
  const { startingCapital, baseRate, loyaltyRate } = tier;
  let netNav = startingCapital;
  let hwm = startingCapital;
  let lra = 0;
  let totalMgmtFees = 0, totalPerfFees = 0;
  let monthIdx = 0;
  let quarterStartNav = startingCapital;

  const netCurve = [];
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
      quarterStartNav = netNav;
    }

    netCurve.push({ date: day.date, netEquity: +netNav.toFixed(2) });
  }

  return { netCurve, totalMgmtFees, totalPerfFees };
}

async function main() {
  const client = new MongoClient(URI);
  await client.connect();
  const db = client.db(DB_NAME);

  console.log('═'.repeat(70));
  console.log('  PROMOTE MCE → CANONICAL COLLECTIONS');
  console.log('═'.repeat(70));

  for (const tier of TIERS) {
    const { label, navLabel, startingCapital } = tier;
    const mceGrossCol = `pnthr_ai_bt_pyramid_nav_${navLabel}_daily_nav_gross_mce`;
    const mceTradeCol = `pnthr_ai_bt_pyramid_nav_${navLabel}_trade_log_mce`;
    const canonGrossCol = `pnthr_ai_bt_pyramid_nav_${navLabel}_daily_nav_gross`;
    const canonNetCol = `pnthr_ai_bt_pyramid_nav_${navLabel}_daily_nav_net`;
    const canonTradeCol = `pnthr_ai_bt_pyramid_nav_${navLabel}_trade_log`;

    console.log(`\n── ${label} ($${(startingCapital/1000).toFixed(0)}K) ──`);

    // Load MCE data
    const mceGross = await db.collection(mceGrossCol).find({}).sort({ date: 1 }).toArray();
    const mceTrades = await db.collection(mceTradeCol).find({}).toArray();

    if (!mceGross.length) {
      console.log(`  ⚠ No MCE gross data in ${mceGrossCol} — skipping`);
      continue;
    }

    // Apply fee engine
    const { netCurve, totalMgmtFees, totalPerfFees } = applyFeeEngine(mceGross, tier);

    // Overwrite canonical gross NAV
    await db.collection(canonGrossCol).deleteMany({});
    await db.collection(canonGrossCol).insertMany(mceGross);
    await db.collection(canonGrossCol).createIndex({ date: 1 });
    console.log(`  → ${canonGrossCol}: ${mceGross.length} docs`);

    // Write canonical net NAV
    await db.collection(canonNetCol).deleteMany({});
    await db.collection(canonNetCol).insertMany(netCurve);
    await db.collection(canonNetCol).createIndex({ date: 1 });
    console.log(`  → ${canonNetCol}: ${netCurve.length} docs`);

    // Overwrite canonical trade log
    await db.collection(canonTradeCol).deleteMany({});
    if (mceTrades.length > 0) {
      await db.collection(canonTradeCol).insertMany(mceTrades);
      await db.collection(canonTradeCol).createIndex({ ticker: 1 });
      await db.collection(canonTradeCol).createIndex({ entryDate: 1 });
      await db.collection(canonTradeCol).createIndex({ tradeType: 1 });
    }
    console.log(`  → ${canonTradeCol}: ${mceTrades.length} docs`);

    const netFinal = netCurve[netCurve.length - 1]?.netEquity || 0;
    const grossFinal = mceGross[mceGross.length - 1]?.equity || 0;
    console.log(`  Gross: $${startingCapital.toLocaleString()} → $${Math.round(grossFinal).toLocaleString()}`);
    console.log(`  Net:   $${startingCapital.toLocaleString()} → $${Math.round(netFinal).toLocaleString()}`);
    console.log(`  Fees:  Mgmt $${Math.round(totalMgmtFees).toLocaleString()} + Perf $${Math.round(totalPerfFees).toLocaleString()} = $${Math.round(totalMgmtFees + totalPerfFees).toLocaleString()}`);
  }

  console.log('\n' + '═'.repeat(70));
  console.log('  DONE — canonical collections now contain MCE capital-constrained data');
  console.log('  Next: run ai300IrMetrics.js → generateAiEliteIR.py');
  console.log('═'.repeat(70) + '\n');

  await client.close();
  process.exit(0);
}

main().catch(e => { console.error(e.stack || e.message); process.exit(99); });
