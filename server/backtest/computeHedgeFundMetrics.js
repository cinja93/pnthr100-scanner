// server/backtest/computeHedgeFundMetrics.js
// ── Hedge Fund Performance Metrics ─────────────────────────────────────────
//
// Reads persisted trades from pnthr_bt_optimal_trades (written by
// simulateOptimalEma.js) and computes institutional-grade metrics:
//   CAGR, Sharpe, Sortino, Max Drawdown, Calmar, Best/Worst Month, etc.
//
// Prerequisite: run simulateOptimalEma.js first to populate the collection.
//
// Usage:  cd server && node backtest/computeHedgeFundMetrics.js
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { connectToDatabase } from '../database.js';

const STARTING_CAPITAL = 100000;
const LOT_SIZE_USD = 10000;

// ── Monthly Equity Curve ────────────────────────────────────────────────────
function buildMonthlyEquityCurve(trades, startingCapital = STARTING_CAPITAL) {
  // Group realized P&L by exit month
  const monthlyPnl = {};
  for (const t of trades) {
    if (!t.exitDate) continue;
    const month = t.exitDate.slice(0, 7);
    if (!monthlyPnl[month]) monthlyPnl[month] = { dollarPnl: 0, trades: 0, wins: 0 };
    monthlyPnl[month].dollarPnl += t.dollarPnl || 0;
    monthlyPnl[month].trades++;
    if (t.isWinner) monthlyPnl[month].wins++;
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
      equity: parseFloat(equity.toFixed(2)),
      dollarPnl: parseFloat(monthlyPnl[month].dollarPnl.toFixed(2)),
      returnPct: parseFloat(monthReturn.toFixed(2)),
      trades: monthlyPnl[month].trades,
      wins: monthlyPnl[month].wins,
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

  // Profit Factor
  const grossWins = trades.filter(t => t.isWinner).reduce((s, t) => s + (t.dollarPnl || 0), 0);
  const grossLosses = Math.abs(trades.filter(t => !t.isWinner).reduce((s, t) => s + (t.dollarPnl || 0), 0));
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

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('Cannot connect to MongoDB'); process.exit(1); }

  const col = db.collection('pnthr_bt_optimal_trades');
  const trades = await col.find({}).toArray();

  if (trades.length === 0) {
    console.error('\nNo trades found in pnthr_bt_optimal_trades.');
    console.error('Run simulateOptimalEma.js first to populate the collection.\n');
    process.exit(1);
  }

  const blTrades = trades.filter(t => t.signal === 'BL');
  const ssTrades = trades.filter(t => t.signal === 'SS');

  console.log(`\nLoaded ${trades.length} trades from pnthr_bt_optimal_trades`);
  console.log(`  BL: ${blTrades.length}  |  SS: ${ssTrades.length}\n`);

  // Build curves
  const combinedCurve = buildMonthlyEquityCurve(trades);
  const blCurve = buildMonthlyEquityCurve(blTrades);
  const ssCurve = buildMonthlyEquityCurve(ssTrades);

  // Compute metrics
  const combinedMetrics = computeHedgeFundMetrics(combinedCurve, trades);
  const blMetrics = computeHedgeFundMetrics(blCurve, blTrades);
  const ssMetrics = ssCurve.length > 0 ? computeHedgeFundMetrics(ssCurve, ssTrades) : null;

  // Print
  printMetrics('COMBINED (BL + SS) — HEDGE FUND METRICS', combinedMetrics, combinedCurve);
  printMetrics('BUY LONG (BL) — HEDGE FUND METRICS', blMetrics, blCurve);
  if (ssMetrics) printMetrics('SELL SHORT (SS) — HEDGE FUND METRICS', ssMetrics, ssCurve);

  // Monthly equity curve
  console.log(`\n${'='.repeat(70)}`);
  console.log('  MONTHLY EQUITY CURVE (Combined)');
  console.log(`${'='.repeat(70)}`);
  console.log('  Month      Equity         P&L        Return   Trades  Win%');
  console.log(`  ${'─'.repeat(64)}`);
  for (const c of combinedCurve) {
    const winPct = c.trades > 0 ? (c.wins / c.trades * 100).toFixed(0) : '—';
    console.log(`  ${c.month}   $${c.equity.toLocaleString().padStart(12)}   ${(c.dollarPnl >= 0 ? '+$' : '-$') + Math.abs(c.dollarPnl).toLocaleString().padStart(8)}   ${(c.returnPct >= 0 ? '+' : '') + c.returnPct.toFixed(1).padStart(5)}%   ${String(c.trades).padStart(4)}   ${String(winPct).padStart(3)}%`);
  }

  // Output JSON for embedding in OrdersPage
  console.log(`\n${'='.repeat(70)}`);
  console.log('  COPY-PASTE FOR OrdersPage.jsx');
  console.log(`${'='.repeat(70)}\n`);

  function toJSObject(m) {
    return `{
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

  console.log(`const BL_HEDGE = ${toJSObject(blMetrics)};\n`);
  console.log(`const SS_HEDGE = ${toJSObject(ssMetrics || {})};\n`);
  console.log(`const COMBINED_HEDGE = ${toJSObject(combinedMetrics)};\n`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
