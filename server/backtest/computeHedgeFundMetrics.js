// server/backtest/computeHedgeFundMetrics.js
// ── Hedge Fund Performance Metrics — Gross AND Net of Friction Costs ──────────
//
// Reads persisted trades from pnthr_bt_trade_log (written by exportOrdersTrades.js,
// which applies the costEngine.js friction cost model to every trade) and computes
// institutional-grade metrics on BOTH gross (before costs) and net (after costs)
// equity curves.
//
// Output: Six metric objects for copy-pasting into OrdersPage.jsx:
//   BL_GROSS   / BL_NET
//   SS_GROSS   / SS_NET
//   COMB_GROSS / COMB_NET
//
// Prerequisite: run exportOrdersTrades.js first to populate pnthr_bt_trade_log.
//
// Usage:  cd server && node backtest/computeHedgeFundMetrics.js
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { connectToDatabase } from '../database.js';

const STARTING_CAPITAL = 100000;
const LOT_SIZE_USD = 10000;

// ── Monthly Equity Curve ─────────────────────────────────────────────────────
// mode: 'gross' uses grossDollarPnl / isWinner
//       'net'   uses netDollarPnl   / netIsWinner
// Falls back to dollarPnl / isWinner for backward-compat with pnthr_bt_optimal_trades
function buildMonthlyEquityCurve(trades, startingCapital = STARTING_CAPITAL, mode = 'gross') {
  const pnlField    = mode === 'net' ? 'netDollarPnl'  : (trades[0]?.grossDollarPnl !== undefined ? 'grossDollarPnl' : 'dollarPnl');
  const winnerField = mode === 'net' ? 'netIsWinner'   : 'isWinner';

  const monthlyPnl = {};
  for (const t of trades) {
    if (!t.exitDate) continue;
    const month = t.exitDate.slice(0, 7);
    if (!monthlyPnl[month]) monthlyPnl[month] = { dollarPnl: 0, trades: 0, wins: 0 };
    monthlyPnl[month].dollarPnl += t[pnlField] || 0;
    monthlyPnl[month].trades++;
    if (t[winnerField]) monthlyPnl[month].wins++;
  }

  const months = Object.keys(monthlyPnl).sort();
  let equity = startingCapital;
  const curve = [];
  for (const month of months) {
    const prev = equity;
    equity += monthlyPnl[month].dollarPnl;
    const monthReturn = (equity - prev) / prev * 100;
    curve.push({
      month,
      equity:    parseFloat(equity.toFixed(2)),
      dollarPnl: parseFloat(monthlyPnl[month].dollarPnl.toFixed(2)),
      returnPct: parseFloat(monthReturn.toFixed(2)),
      trades:    monthlyPnl[month].trades,
      wins:      monthlyPnl[month].wins,
    });
  }
  return curve;
}

// ── Hedge Fund Metrics ──────────────────────────────────────────────────────
function computeHedgeFundMetrics(curve, trades) {
  if (curve.length === 0) return null;
  const months = curve.length;
  const returns = curve.map(c => c.returnPct);
  const years = [...new Set(curve.map(c => c.month.slice(0, 4)))];

  // Return metrics
  const totalReturn = ((curve[curve.length - 1].equity - STARTING_CAPITAL) / STARTING_CAPITAL * 100);
  const cagr = (Math.pow(curve[curve.length - 1].equity / STARTING_CAPITAL, 12 / months) - 1) * 100;

  // Monthly stats
  const meanMonthly = returns.reduce((s, r) => s + r, 0) / months;
  const stdMonthly = Math.sqrt(returns.reduce((s, r) => s + (r - meanMonthly) ** 2, 0) / (months - 1));
  const positiveMonths = returns.filter(r => r > 0).length;
  const bestMonth = Math.max(...returns);
  const worstMonth = Math.min(...returns);
  const bestMonthLabel = curve[returns.indexOf(bestMonth)].month;
  const worstMonthLabel = curve[returns.indexOf(worstMonth)].month;

  // Sharpe (annualized from monthly)
  const riskFreeMonthly = 5 / 12;
  const sharpe = stdMonthly > 0 ? ((meanMonthly - riskFreeMonthly) / stdMonthly) * Math.sqrt(12) : 0;

  // Sortino (annualized from monthly)
  const downsideReturns = returns.filter(r => r < riskFreeMonthly);
  const downsideDev = downsideReturns.length > 0
    ? Math.sqrt(downsideReturns.reduce((s, r) => s + (r - riskFreeMonthly) ** 2, 0) / months)
    : 0;
  const sortino = downsideDev > 0 ? ((meanMonthly - riskFreeMonthly) / downsideDev) * Math.sqrt(12) : Infinity;

  // Max Drawdown (peak-to-trough on equity curve)
  let peak = STARTING_CAPITAL, maxDD = 0, maxDDStart = '', maxDDEnd = '', currentDDStart = '';
  for (const c of curve) {
    if (c.equity > peak) { peak = c.equity; currentDDStart = c.month; }
    const dd = (peak - c.equity) / peak * 100;
    if (dd > maxDD) { maxDD = dd; maxDDStart = currentDDStart; maxDDEnd = c.month; }
  }

  // Calmar
  const calmar = maxDD > 0 ? cagr / maxDD : Infinity;

  // Profit Factor — uses net P&L if available, gross otherwise
  const pnlField    = trades[0]?.netDollarPnl !== undefined ? 'netDollarPnl'  : (trades[0]?.grossDollarPnl !== undefined ? 'grossDollarPnl' : 'dollarPnl');
  const winnerField = trades[0]?.netIsWinner  !== undefined ? 'netIsWinner'   : 'isWinner';
  const grossWins   = trades.filter(t =>  t[winnerField]).reduce((s, t) => s + (t[pnlField] || 0), 0);
  const grossLosses = Math.abs(trades.filter(t => !t[winnerField]).reduce((s, t) => s + (t[pnlField] || 0), 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : Infinity;

  // Annual returns
  const annualReturns = {};
  for (const year of years) {
    const yearMonths = curve.filter(c => c.month.startsWith(year));
    const yearPnl = yearMonths.reduce((s, c) => s + c.dollarPnl, 0);
    const yearStartEquity = yearMonths[0].equity - yearMonths[0].dollarPnl;
    annualReturns[year] = parseFloat(((yearPnl / yearStartEquity) * 100).toFixed(1));
  }

  // Trade-level
  const winners = trades.filter(t => t.isWinner);
  const losers = trades.filter(t => !t.isWinner);
  const avgWin = winners.length > 0 ? winners.reduce((s, t) => s + t.profitPct, 0) / winners.length : 0;
  const avgLoss = losers.length > 0 ? losers.reduce((s, t) => s + t.profitPct, 0) / losers.length : 0;
  const winRate = winners.length / trades.length * 100;

  return {
    totalReturn: parseFloat(totalReturn.toFixed(1)),
    cagr: parseFloat(cagr.toFixed(1)),
    sharpe: parseFloat(sharpe.toFixed(2)),
    sortino: sortino === Infinity ? 'Infinity' : parseFloat(sortino.toFixed(2)),
    maxDrawdown: parseFloat(maxDD.toFixed(2)),
    maxDDPeriod: maxDD > 0 ? `${maxDDStart} to ${maxDDEnd}` : 'None',
    calmar: calmar === Infinity ? 'Infinity' : parseFloat(calmar.toFixed(2)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    months, meanMonthlyReturn: parseFloat(meanMonthly.toFixed(2)),
    monthlyStdDev: parseFloat(stdMonthly.toFixed(2)),
    bestMonth: parseFloat(bestMonth.toFixed(2)), bestMonthLabel,
    worstMonth: parseFloat(worstMonth.toFixed(2)), worstMonthLabel,
    positiveMonths, positiveMonthsPct: parseFloat((positiveMonths / months * 100).toFixed(1)),
    annualReturns,
    totalTrades: trades.length,
    winRate: parseFloat(winRate.toFixed(1)),
    avgWin: parseFloat(avgWin.toFixed(2)),
    avgLoss: parseFloat(avgLoss.toFixed(2)),
    wlRatio: avgLoss !== 0 ? parseFloat((avgWin / Math.abs(avgLoss)).toFixed(2)) : 0,
    finalEquity: parseFloat(curve[curve.length - 1].equity.toFixed(2)),
  };
}

// ── Print helpers ───────────────────────────────────────────────────────────
function printMetrics(label, metrics, curve) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${label}`);
  console.log(`  ${'─'.repeat(66)}`);
  console.log(`  Starting Capital: $${STARTING_CAPITAL.toLocaleString()} | Lot Size: $${LOT_SIZE_USD.toLocaleString()}`);
  console.log(`${'='.repeat(70)}\n`);

  console.log('  RETURN METRICS');
  console.log(`  ${'─'.repeat(40)}`);
  console.log(`  Total Return:           ${metrics.totalReturn > 0 ? '+' : ''}${metrics.totalReturn}%`);
  console.log(`  CAGR:                   ${metrics.cagr > 0 ? '+' : ''}${metrics.cagr}%`);
  console.log(`  Final Equity:           $${metrics.finalEquity.toLocaleString()}`);
  console.log();

  console.log('  RISK-ADJUSTED METRICS');
  console.log(`  ${'─'.repeat(40)}`);
  console.log(`  Sharpe Ratio:           ${metrics.sharpe}`);
  console.log(`  Sortino Ratio:          ${metrics.sortino}`);
  console.log(`  Max Drawdown:           -${metrics.maxDrawdown}%`);
  console.log(`  Max DD Period:          ${metrics.maxDDPeriod}`);
  console.log(`  Calmar Ratio:           ${metrics.calmar}`);
  console.log(`  Profit Factor:          ${metrics.profitFactor}`);
  console.log();

  console.log('  MONTHLY PERFORMANCE');
  console.log(`  ${'─'.repeat(40)}`);
  console.log(`  Months:                 ${metrics.months}`);
  console.log(`  Avg Monthly Return:     ${metrics.meanMonthlyReturn > 0 ? '+' : ''}${metrics.meanMonthlyReturn}%`);
  console.log(`  Monthly Std Dev:        ${metrics.monthlyStdDev}%`);
  console.log(`  Best Month:             +${metrics.bestMonth}% (${metrics.bestMonthLabel})`);
  console.log(`  Worst Month:            ${metrics.worstMonth}% (${metrics.worstMonthLabel})`);
  console.log(`  Positive Months:        ${metrics.positiveMonths}/${metrics.months} (${metrics.positiveMonthsPct}%)`);
  console.log();

  console.log('  ANNUAL RETURNS');
  console.log(`  ${'─'.repeat(40)}`);
  for (const [year, ret] of Object.entries(metrics.annualReturns)) {
    console.log(`  ${year}:                  ${ret > 0 ? '+' : ''}${ret}%`);
  }
  console.log();

  console.log('  TRADE METRICS');
  console.log(`  ${'─'.repeat(40)}`);
  console.log(`  Total Trades:           ${metrics.totalTrades}`);
  console.log(`  Win Rate:               ${metrics.winRate}%`);
  console.log(`  Avg Winner:             +${metrics.avgWin}%`);
  console.log(`  Avg Loser:              ${metrics.avgLoss}%`);
  console.log(`  W/L Ratio:              ${metrics.wlRatio}:1`);
}

// ── Comparison table ─────────────────────────────────────────────────────────
function printComparison(label, gross, net) {
  const w = (v, decimals = 2) => String(v?.toFixed ? v.toFixed(decimals) : v ?? '—').padStart(10);
  const delta = (g, n, invert = false) => {
    if (g == null || n == null) return ''.padStart(10);
    const d = parseFloat((n - g).toFixed(2));
    const sign = d >= 0 ? '+' : '';
    return `(${sign}${d})`.padStart(10);
  };

  console.log(`\n${'='.repeat(80)}`);
  console.log(`  ${label}`);
  console.log(`  GROSS vs NET-OF-COSTS COMPARISON`);
  console.log(`${'='.repeat(80)}`);
  console.log(`  ${'Metric'.padEnd(28)} ${'GROSS'.padStart(10)}  ${'NET'.padStart(10)}  ${'DELTA'.padStart(10)}`);
  console.log(`  ${'─'.repeat(62)}`);

  const rows = [
    ['CAGR %',              gross?.cagr,           net?.cagr,           false],
    ['Sharpe Ratio',        gross?.sharpe,          net?.sharpe,         false],
    ['Sortino Ratio',       gross?.sortino,         net?.sortino,        false],
    ['Max Drawdown %',      gross?.maxDrawdown,     net?.maxDrawdown,    true ],
    ['Calmar Ratio',        gross?.calmar,          net?.calmar,         false],
    ['Profit Factor',       gross?.profitFactor,    net?.profitFactor,   false],
    ['Win Rate %',          gross?.winRate,         net?.winRate,        false],
    ['Avg Monthly Return %',gross?.meanMonthlyReturn, net?.meanMonthlyReturn, false],
    ['Positive Months %',   gross?.positiveMonthsPct, net?.positiveMonthsPct, false],
    ['Total Trades',        gross?.totalTrades,     net?.totalTrades,    false],
  ];

  for (const [metric, gv, nv, inv] of rows) {
    const gvNum = typeof gv === 'string' ? parseFloat(gv) || gv : gv;
    const nvNum = typeof nv === 'string' ? parseFloat(nv) || nv : nv;
    console.log(`  ${metric.padEnd(28)} ${w(gvNum)}  ${w(nvNum)}  ${delta(gvNum, nvNum, inv)}`);
  }

  console.log(`\n  Gross DD Period:  ${gross?.maxDDPeriod || '—'}`);
  console.log(`  Net DD Period:    ${net?.maxDDPeriod   || '—'}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('Cannot connect to MongoDB'); process.exit(1); }

  // ── Try pnthr_bt_trade_log first (has cost fields), fall back to pnthr_bt_optimal_trades
  let trades = await db.collection('pnthr_bt_trade_log').find({}).toArray();
  let sourceCollection = 'pnthr_bt_trade_log';
  const hasCostData = trades.length > 0 && trades[0].netDollarPnl !== undefined;

  if (trades.length === 0) {
    console.log('pnthr_bt_trade_log empty — falling back to pnthr_bt_optimal_trades');
    trades = await db.collection('pnthr_bt_optimal_trades').find({}).toArray();
    sourceCollection = 'pnthr_bt_optimal_trades';
  }

  if (trades.length === 0) {
    console.error('\nNo trades found in pnthr_bt_trade_log or pnthr_bt_optimal_trades.');
    console.error('Run exportOrdersTrades.js first.\n');
    process.exit(1);
  }

  const blTrades   = trades.filter(t => t.signal === 'BL');
  const ssTrades   = trades.filter(t => t.signal === 'SS');

  // Date range in the dataset
  const allDates   = trades.map(t => t.entryDate || t.weekOf).filter(Boolean).sort();
  const dateFrom   = allDates[0]?.slice(0, 7) || '?';
  const dateTo     = allDates[allDates.length - 1]?.slice(0, 7) || '?';

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  PNTHR Hedge Fund Metrics — Gross vs Net-of-Costs`);
  console.log(`  Source: ${sourceCollection} | Period: ${dateFrom} → ${dateTo}`);
  console.log(`  Cost data: ${hasCostData ? '✓ Present (costEngine.js applied)' : '✗ Not present — gross only'}`);
  console.log(`  BL: ${blTrades.length} trades  |  SS: ${ssTrades.length} trades  |  Total: ${trades.length}`);
  console.log(`${'═'.repeat(80)}\n`);

  // ── Build all equity curves ───────────────────────────────────────────────
  const blGrossCurve   = buildMonthlyEquityCurve(blTrades,  STARTING_CAPITAL, 'gross');
  const ssGrossCurve   = buildMonthlyEquityCurve(ssTrades,  STARTING_CAPITAL, 'gross');
  const combGrossCurve = buildMonthlyEquityCurve(trades,    STARTING_CAPITAL, 'gross');

  const blNetCurve     = hasCostData ? buildMonthlyEquityCurve(blTrades,  STARTING_CAPITAL, 'net') : null;
  const ssNetCurve     = hasCostData ? buildMonthlyEquityCurve(ssTrades,  STARTING_CAPITAL, 'net') : null;
  const combNetCurve   = hasCostData ? buildMonthlyEquityCurve(trades,    STARTING_CAPITAL, 'net') : null;

  // ── Compute all metrics ───────────────────────────────────────────────────
  const blGross   = computeHedgeFundMetrics(blGrossCurve,   blTrades);
  const ssGross   = ssGrossCurve.length > 0 ? computeHedgeFundMetrics(ssGrossCurve,   ssTrades)  : null;
  const combGross = computeHedgeFundMetrics(combGrossCurve, trades);

  const blNet     = blNetCurve   ? computeHedgeFundMetrics(blNetCurve,   blTrades)  : null;
  const ssNet     = ssNetCurve && ssNetCurve.length > 0 ? computeHedgeFundMetrics(ssNetCurve, ssTrades)  : null;
  const combNet   = combNetCurve ? computeHedgeFundMetrics(combNetCurve, trades)    : null;

  // ── Print full gross metrics ──────────────────────────────────────────────
  printMetrics('BUY LONG (BL) — GROSS METRICS',      blGross,   blGrossCurve);
  if (ssGross) printMetrics('SELL SHORT (SS) — GROSS METRICS', ssGross,   ssGrossCurve);
  printMetrics('COMBINED — GROSS METRICS',            combGross, combGrossCurve);

  // ── Print gross vs net comparison tables ─────────────────────────────────
  if (hasCostData) {
    printComparison('BL (LONGS)',  blGross,   blNet);
    if (ssGross) printComparison('SS (SHORTS)', ssGross, ssNet);
    printComparison('COMBINED',   combGross, combNet);
  } else {
    console.log('\n  ⚠  Net-of-cost metrics not available.');
    console.log('  Run exportOrdersTrades.js first to generate cost-adjusted trade data.\n');
  }

  // ── Monthly equity curve (combined gross) ─────────────────────────────────
  console.log(`\n${'='.repeat(80)}`);
  console.log('  MONTHLY EQUITY CURVE — Combined Gross');
  console.log(`${'='.repeat(80)}`);
  console.log('  Month      Equity (Gross)    Equity (Net)    Return G   Return N   Trades');
  console.log(`  ${'─'.repeat(72)}`);
  const netByMonth = {};
  if (combNetCurve) { for (const c of combNetCurve) netByMonth[c.month] = c; }
  for (const c of combGrossCurve) {
    const n = netByMonth[c.month];
    const nEq  = n  ? `$${n.equity.toLocaleString().padStart(12)}` : '            —';
    const nRet = n  ? `${(n.returnPct >= 0 ? '+' : '') + n.returnPct.toFixed(1).padStart(5)}%` : '      —';
    console.log(
      `  ${c.month}   ` +
      `$${c.equity.toLocaleString().padStart(12)}    ${nEq}    ` +
      `${(c.returnPct >= 0 ? '+' : '') + c.returnPct.toFixed(1).padStart(5)}%   ${nRet}   ` +
      `${String(c.trades).padStart(4)}`
    );
  }

  // ── Copy-paste output for OrdersPage.jsx ─────────────────────────────────
  console.log(`\n${'='.repeat(80)}`);
  console.log('  COPY-PASTE FOR OrdersPage.jsx');
  console.log('  Update BOTH gross and net constants when updating the UI');
  console.log(`${'='.repeat(80)}\n`);

  function toJSObject(m, label) {
    if (!m) return `null; // ${label} — no data`;
    return `{
  // ${label} (${dateFrom} → ${dateTo}, ${m.totalTrades} trades)
  cagr: ${m.cagr}, sharpe: ${m.sharpe}, sortino: ${typeof m.sortino === 'string' ? `'${m.sortino}'` : m.sortino},
  maxDrawdown: ${m.maxDrawdown}, maxDDPeriod: '${m.maxDDPeriod}',
  calmar: ${typeof m.calmar === 'string' ? `'${m.calmar}'` : m.calmar}, profitFactor: ${m.profitFactor},
  bestMonth: ${m.bestMonth}, bestMonthLabel: '${m.bestMonthLabel}',
  worstMonth: ${m.worstMonth}, worstMonthLabel: '${m.worstMonthLabel}',
  positiveMonths: ${m.positiveMonths}, totalMonths: ${m.months},
  positiveMonthsPct: ${m.positiveMonthsPct},
  avgMonthlyReturn: ${m.meanMonthlyReturn}, monthlyStdDev: ${m.monthlyStdDev},
}`;
  }

  console.log('// ── GROSS (before friction costs) ──');
  console.log(`const BL_GROSS   = ${toJSObject(blGross,   'BL Gross')};\n`);
  console.log(`const SS_GROSS   = ${toJSObject(ssGross,   'SS Gross')};\n`);
  console.log(`const COMB_GROSS = ${toJSObject(combGross, 'Combined Gross')};\n`);

  if (hasCostData) {
    console.log('// ── NET (after commission + slippage + borrow costs) ──');
    console.log(`const BL_NET   = ${toJSObject(blNet,   'BL Net')};\n`);
    console.log(`const SS_NET   = ${toJSObject(ssNet,   'SS Net')};\n`);
    console.log(`const COMB_NET = ${toJSObject(combNet, 'Combined Net')};\n`);
  }

  // ── Persist to MongoDB for API access ────────────────────────────────────
  const metricsDoc = {
    computedAt:    new Date(),
    period:        { from: dateFrom, to: dateTo },
    sourceCollection,
    hasCostData,
    totalTrades:   trades.length,
    blTrades:      blTrades.length,
    ssTrades:      ssTrades.length,
    metrics: {
      bl:       { gross: blGross,   net: blNet   },
      ss:       { gross: ssGross,   net: ssNet   },
      combined: { gross: combGross, net: combNet },
    },
    equityCurves: {
      blGross:   blGrossCurve,
      ssGross:   ssGrossCurve,
      combGross: combGrossCurve,
      blNet:     blNetCurve   || [],
      ssNet:     ssNetCurve   || [],
      combNet:   combNetCurve || [],
    },
  };

  await db.collection('pnthr_bt_hedge_metrics').deleteMany({});
  await db.collection('pnthr_bt_hedge_metrics').insertOne(metricsDoc);
  console.log('  Metrics persisted to pnthr_bt_hedge_metrics collection.');
  console.log('  API endpoint /api/backtest/metrics will serve these values.\n');

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
