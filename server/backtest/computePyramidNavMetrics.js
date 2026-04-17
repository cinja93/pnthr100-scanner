// server/backtest/computePyramidNavMetrics.js
// ── Post-Processing for NAV-Scaled Pyramid Backtest ──────────────────────────
//
// Reads trades from pnthr_bt_pyramid_nav_{tier}_trade_log (written by
// exportPyramidNav.js) and builds:
//
//   1. Daily NAV equity curve (PNTHR + SPY benchmark)
//      → pnthr_bt_pyramid_nav_{tier}_daily_nav
//
//   2. Hedge fund metrics (gross + net, BL/SS/combined)
//      → pnthr_bt_pyramid_nav_{tier}_hedge_metrics
//
//   3. MAE analysis (worst adverse excursions)
//      → pnthr_bt_pyramid_nav_{tier}_mae_analysis
//
// Usage:  cd server && node backtest/computePyramidNavMetrics.js [--nav 100000]
//         Runs for ONE tier at a time. Run 3× for all tiers.
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { connectToDatabase } from '../database.js';

// ── NAV tier from CLI ────────────────────────────────────────────────────────
const NAV_ARG = process.argv.find(a => a.startsWith('--nav='));
const STARTING_NAV = NAV_ARG ? parseInt(NAV_ARG.split('=')[1]) : (parseInt(process.argv[process.argv.indexOf('--nav') + 1]) || 100000);
const navLabel = STARTING_NAV >= 1000000 ? `${STARTING_NAV / 1000000}m` : `${STARTING_NAV / 1000}k`;

// ── Monthly Equity Curve ─────────────────────────────────────────────────────
function buildMonthlyEquityCurve(trades, startingCapital, mode = 'net') {
  const pnlField    = mode === 'net' ? 'netDollarPnl' : 'grossDollarPnl';
  const winnerField = mode === 'net' ? 'netIsWinner'  : 'isWinner';

  const monthlyPnl = {};
  for (const t of trades) {
    if (!t.exitDate || t.exitReason === 'STILL_OPEN') continue;
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
function computeHedgeFundMetrics(curve, trades, startingCapital) {
  if (curve.length === 0) return null;
  const months = curve.length;
  const returns = curve.map(c => c.returnPct);
  const years = [...new Set(curve.map(c => c.month.slice(0, 4)))];

  const totalReturn = ((curve[curve.length - 1].equity - startingCapital) / startingCapital * 100);
  const cagr = (Math.pow(curve[curve.length - 1].equity / startingCapital, 12 / months) - 1) * 100;

  const meanMonthly = returns.reduce((s, r) => s + r, 0) / months;
  const stdMonthly = Math.sqrt(returns.reduce((s, r) => s + (r - meanMonthly) ** 2, 0) / (months - 1));
  const positiveMonths = returns.filter(r => r > 0).length;
  const bestMonth = Math.max(...returns);
  const worstMonth = Math.min(...returns);
  const bestMonthLabel = curve[returns.indexOf(bestMonth)].month;
  const worstMonthLabel = curve[returns.indexOf(worstMonth)].month;

  const riskFreeMonthly = 5 / 12;
  const sharpe = stdMonthly > 0 ? ((meanMonthly - riskFreeMonthly) / stdMonthly) * Math.sqrt(12) : 0;

  const downsideReturns = returns.filter(r => r < riskFreeMonthly);
  const downsideDev = downsideReturns.length > 0
    ? Math.sqrt(downsideReturns.reduce((s, r) => s + (r - riskFreeMonthly) ** 2, 0) / months)
    : 0;
  const sortino = downsideDev > 0 ? ((meanMonthly - riskFreeMonthly) / downsideDev) * Math.sqrt(12) : Infinity;

  let peak = startingCapital, maxDD = 0, maxDDStart = '', maxDDEnd = '', currentDDStart = '';
  for (const c of curve) {
    if (c.equity > peak) { peak = c.equity; currentDDStart = c.month; }
    const dd = (peak - c.equity) / peak * 100;
    if (dd > maxDD) { maxDD = dd; maxDDStart = currentDDStart; maxDDEnd = c.month; }
  }

  const calmar = maxDD > 0 ? cagr / maxDD : Infinity;

  const pnlField    = 'netDollarPnl';
  const winnerField = 'netIsWinner';
  const grossWins   = trades.filter(t =>  t[winnerField]).reduce((s, t) => s + (t[pnlField] || 0), 0);
  const grossLosses = Math.abs(trades.filter(t => !t[winnerField]).reduce((s, t) => s + (t[pnlField] || 0), 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : Infinity;

  const annualReturns = {};
  for (const year of years) {
    const yearMonths = curve.filter(c => c.month.startsWith(year));
    const yearPnl = yearMonths.reduce((s, c) => s + c.dollarPnl, 0);
    const yearStartEquity = yearMonths[0].equity - yearMonths[0].dollarPnl;
    annualReturns[year] = parseFloat(((yearPnl / yearStartEquity) * 100).toFixed(1));
  }

  const pctField = 'netProfitPct';
  const winners = trades.filter(t =>  t[winnerField]);
  const losers  = trades.filter(t => !t[winnerField]);
  const avgWin  = winners.length > 0 ? winners.reduce((s, t) => s + (t[pctField] || 0), 0) / winners.length : 0;
  const avgLoss = losers.length  > 0 ? losers.reduce( (s, t) => s + (t[pctField] || 0), 0) / losers.length  : 0;
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

// ── Build Daily NAV from trade log + SPY candles ────────────────────────────
function buildDailyNav(trades, spyCandles, startingCapital) {
  // Build daily P&L events from trades (using exit date → net dollar P&L)
  const closedTrades = trades.filter(t => t.exitDate && t.exitReason !== 'STILL_OPEN');

  // Events: entries and exits by date
  const entryEvents = {};   // date → [{ticker, signal, shares}]
  const exitEvents  = {};   // date → [{ticker, signal, netDollarPnl}]

  for (const t of closedTrades) {
    const ed = t.entryDate;
    if (!entryEvents[ed]) entryEvents[ed] = [];
    entryEvents[ed].push({ ticker: t.ticker, signal: t.signal, shares: t.totalShares });

    const xd = t.exitDate;
    if (!exitEvents[xd]) exitEvents[xd] = [];
    exitEvents[xd].push({ ticker: t.ticker, signal: t.signal, pnl: t.netDollarPnl || 0 });
  }

  // SPY buy-and-hold benchmark: growth of $startingCapital
  const spyByDate = {};
  for (const c of spyCandles) spyByDate[c.date] = c;

  // Get all trading days from SPY candles (sorted)
  const allDates = spyCandles.map(c => c.date).sort();
  const firstTradeDate = closedTrades.map(t => t.entryDate).sort()[0];
  const tradingDays = allDates.filter(d => d >= firstTradeDate);

  if (tradingDays.length === 0) return [];

  // SPY growth-of-$X
  const spyStartPrice = spyByDate[tradingDays[0]]?.close || spyByDate[allDates.find(d => d >= firstTradeDate)]?.close || 1;
  let equity = startingCapital;
  let peakEquity = startingCapital;
  let openCount = 0;

  // Track open positions count
  const openTracker = new Map(); // ticker → true/false

  const dailyNav = [];
  for (const date of tradingDays) {
    const spyPrice = spyByDate[date]?.close || 0;
    const spyEquity = spyPrice > 0 ? parseFloat((startingCapital * spyPrice / spyStartPrice).toFixed(2)) : startingCapital;

    // Process entries
    const opened = (entryEvents[date] || []).map(e => {
      openTracker.set(e.ticker, true);
      return { ticker: e.ticker, signal: e.signal };
    });

    // Process exits
    const closed = (exitEvents[date] || []).map(e => {
      openTracker.delete(e.ticker);
      equity += e.pnl;
      return { ticker: e.ticker, signal: e.signal, pnl: parseFloat(e.pnl.toFixed(2)) };
    });

    if (equity > peakEquity) peakEquity = equity;
    openCount = openTracker.size;

    dailyNav.push({
      date,
      equity:        parseFloat(equity.toFixed(2)),
      spyEquity,
      peakEquity:    parseFloat(peakEquity.toFixed(2)),
      openPositions: openCount,
      opened:        opened.length > 0 ? opened : undefined,
      closed:        closed.length > 0 ? closed : undefined,
    });
  }

  return dailyNav;
}

// ── MAE Analysis ────────────────────────────────────────────────────────────
function buildMAEAnalysis(trades) {
  const closedTrades = trades
    .filter(t => t.exitDate && t.exitReason !== 'STILL_OPEN' && t.mae != null)
    .sort((a, b) => a.mae - b.mae);  // worst MAE first (most negative)

  const top30Trades = closedTrades.slice(0, 30).map(t => ({
    ticker:       t.ticker,
    signal:       t.signal,
    direction:    t.signal === 'BL' ? 'LONG' : 'SHORT',
    entryDate:    t.entryDate,
    exitDate:     t.exitDate,
    exitReason:   t.exitReason,
    maePct:       t.mae,
    mfePct:       t.mfe,
    netPnlDollar: t.netDollarPnl || 0,
    netPnlPct:    t.netProfitPct,
    isWinner:     t.netIsWinner,
  }));

  // MAE distribution
  const buckets = { '0-2%': 0, '2-5%': 0, '5-10%': 0, '10-20%': 0, '20%+': 0 };
  for (const t of closedTrades) {
    const absMae = Math.abs(t.mae);
    if (absMae <= 2) buckets['0-2%']++;
    else if (absMae <= 5) buckets['2-5%']++;
    else if (absMae <= 10) buckets['5-10%']++;
    else if (absMae <= 20) buckets['10-20%']++;
    else buckets['20%+']++;
  }

  return {
    totalAnalyzed: closedTrades.length,
    top30Trades,
    distribution: buckets,
    avgMAE: closedTrades.length > 0 ? parseFloat((closedTrades.reduce((s, t) => s + t.mae, 0) / closedTrades.length).toFixed(2)) : 0,
    avgMFE: closedTrades.length > 0 ? parseFloat((closedTrades.reduce((s, t) => s + (t.mfe || 0), 0) / closedTrades.length).toFixed(2)) : 0,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('Cannot connect to MongoDB'); process.exit(1); }

  const tradeColName = `pnthr_bt_pyramid_nav_${navLabel}_trade_log`;
  console.log(`\nLoading trades from ${tradeColName}...`);
  const allTrades = await db.collection(tradeColName).find({}).toArray();

  if (allTrades.length === 0) {
    console.error(`No trades found in ${tradeColName}.`);
    console.error('Run: cd server && node backtest/exportPyramidNav.js --nav ' + STARTING_NAV);
    process.exit(1);
  }

  const closed = allTrades.filter(t => t.exitReason !== 'STILL_OPEN');
  const blTrades = closed.filter(t => t.signal === 'BL');
  const ssTrades = closed.filter(t => t.signal === 'SS');

  console.log(`  ${allTrades.length} total trades (${closed.length} closed, ${blTrades.length} BL, ${ssTrades.length} SS)`);

  // ── Load SPY candles for benchmark ────────────────────────────────────────
  console.log('Loading SPY candles for benchmark...');
  const spyDoc = await db.collection('pnthr_bt_candles').findOne({ ticker: 'SPY' });
  const spyCandles = (spyDoc?.daily || []).sort((a, b) => a.date.localeCompare(b.date));
  console.log(`  ${spyCandles.length} SPY daily candles`);

  // ── 1. Build Daily NAV ────────────────────────────────────────────────────
  console.log('\nBuilding daily NAV equity curve...');
  const dailyNav = buildDailyNav(allTrades, spyCandles, STARTING_NAV);
  console.log(`  ${dailyNav.length} trading days`);

  const dailyNavColName = `pnthr_bt_pyramid_nav_${navLabel}_daily_nav`;
  await db.collection(dailyNavColName).deleteMany({});
  if (dailyNav.length > 0) {
    await db.collection(dailyNavColName).insertMany(dailyNav);
    await db.collection(dailyNavColName).createIndex({ date: 1 });
  }
  console.log(`  Persisted to ${dailyNavColName}`);

  // ── 2. Compute Hedge Fund Metrics ─────────────────────────────────────────
  console.log('\nComputing hedge fund metrics...');

  const combGrossCurve = buildMonthlyEquityCurve(closed, STARTING_NAV, 'gross');
  const combNetCurve   = buildMonthlyEquityCurve(closed, STARTING_NAV, 'net');
  const blNetCurve     = buildMonthlyEquityCurve(blTrades, STARTING_NAV, 'net');
  const ssNetCurve     = buildMonthlyEquityCurve(ssTrades, STARTING_NAV, 'net');
  const blGrossCurve   = buildMonthlyEquityCurve(blTrades, STARTING_NAV, 'gross');
  const ssGrossCurve   = buildMonthlyEquityCurve(ssTrades, STARTING_NAV, 'gross');

  const combGross = computeHedgeFundMetrics(combGrossCurve, closed, STARTING_NAV);
  const combNet   = computeHedgeFundMetrics(combNetCurve, closed, STARTING_NAV);
  const blGross   = computeHedgeFundMetrics(blGrossCurve, blTrades, STARTING_NAV);
  const blNet     = computeHedgeFundMetrics(blNetCurve, blTrades, STARTING_NAV);
  const ssGross   = ssGrossCurve.length > 0 ? computeHedgeFundMetrics(ssGrossCurve, ssTrades, STARTING_NAV) : null;
  const ssNet     = ssNetCurve.length > 0 ? computeHedgeFundMetrics(ssNetCurve, ssTrades, STARTING_NAV) : null;

  const dateFrom = closed.map(t => t.entryDate).filter(Boolean).sort()[0]?.slice(0, 7) || '?';
  const dateTo   = closed.map(t => t.exitDate).filter(Boolean).sort().pop()?.slice(0, 7) || '?';

  const metricsDoc = {
    computedAt:       new Date(),
    period:           { from: dateFrom, to: dateTo },
    sourceCollection: tradeColName,
    navTier:          STARTING_NAV,
    hasCostData:      true,
    totalTrades:      closed.length,
    blTrades:         blTrades.length,
    ssTrades:         ssTrades.length,
    metrics: {
      bl:       { gross: blGross, net: blNet },
      ss:       { gross: ssGross, net: ssNet },
      combined: { gross: combGross, net: combNet },
    },
    equityCurves: {
      blGross: blGrossCurve, ssGross: ssGrossCurve, combGross: combGrossCurve,
      blNet: blNetCurve, ssNet: ssNetCurve, combNet: combNetCurve,
    },
  };

  const metricsColName = `pnthr_bt_pyramid_nav_${navLabel}_hedge_metrics`;
  await db.collection(metricsColName).deleteMany({});
  await db.collection(metricsColName).insertOne(metricsDoc);
  console.log(`  Persisted to ${metricsColName}`);

  // ── 3. MAE Analysis ──────────────────────────────────────────────────────
  console.log('\nComputing MAE analysis...');
  const maeAnalysis = buildMAEAnalysis(allTrades);

  const maeColName = `pnthr_bt_pyramid_nav_${navLabel}_mae_analysis`;
  await db.collection(maeColName).deleteMany({});
  await db.collection(maeColName).insertOne(maeAnalysis);
  console.log(`  Persisted to ${maeColName}`);

  // ── Print summary ─────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(80));
  console.log(`  PYRAMID NAV METRICS — $${STARTING_NAV.toLocaleString()} TIER`);
  console.log('═'.repeat(80));
  console.log(`  Period:          ${dateFrom} → ${dateTo}`);
  console.log(`  Trades:          ${closed.length} (${blTrades.length} BL / ${ssTrades.length} SS)`);
  console.log(`  Final equity:    $${combNet.finalEquity.toLocaleString()}`);
  console.log(`  CAGR:            +${combNet.cagr}%`);
  console.log(`  Sharpe:          ${combNet.sharpe}`);
  console.log(`  Sortino:         ${combNet.sortino}`);
  console.log(`  Max DD:          -${combNet.maxDrawdown}%`);
  console.log(`  Profit Factor:   ${combNet.profitFactor}`);
  console.log(`  Win Rate:        ${combNet.winRate}%`);
  console.log(`  Daily NAV days:  ${dailyNav.length}`);
  console.log(`  Worst MAE:       ${maeAnalysis.avgMAE}% avg`);
  console.log('═'.repeat(80));

  console.log('\n  Collections created:');
  console.log(`    ${dailyNavColName}`);
  console.log(`    ${metricsColName}`);
  console.log(`    ${maeColName}\n`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
