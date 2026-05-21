// server/scripts/reentryBacktest.mjs
// ── PNTHR Re-Entry BL vs Fresh BL Backtest ──────────────────────────────────
//
// Compares two entry strategies for top-100 stocks by TTM return:
//   1. Fresh BL: enter Monday open when weekly BL fires (2-bar high breakout)
//   2. Re-entry BL: enter on FIRST daily 2-bar-high breakout within 20 days
//      AFTER a weekly BL fires
//
// Run: node server/scripts/reentryBacktest.mjs
// ────────────────────────────────────────────────────────────────────────────

// NOTE: ES module static imports are hoisted, so dotenv must be loaded
// BEFORE database.js runs its own dotenv.config().
// We use a loader approach: set env vars directly then dynamic-import modules.
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Manually parse and inject .env before any other module runs dotenv.config()
function loadEnvFile(envPath) {
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
    return true;
  } catch { return false; }
}

// Try worktree server/.env, then main repo server/.env
const loaded =
  loadEnvFile(path.resolve(__dirname, '../.env')) ||
  loadEnvFile('/Users/cindyeagar/pnthr100-scanner/server/.env');

if (!loaded || !process.env.MONGODB_URI) {
  console.error('Could not load .env or MONGODB_URI missing');
  process.exit(1);
}

// Dynamic imports so env is set before database.js calls dotenv.config()
const { connectToDatabase } = await import('../database.js');
const { detectAllSignals } = await import('../signalDetection.js');
const { SECTORS } = await import('./aiUniverse/aiUniverseData.js');

// ── Constants ────────────────────────────────────────────────────────────────
const TEST_START   = '2023-01-01';
const TEST_END     = '2026-05-01';
const RISK_PER_TRADE = 1000; // $1k risk per trade on $100k NAV
const STARTING_NAV   = 100000;
const TOP_N          = 100;
const REENTRY_WINDOW = 20;   // trading days after weekly BL to look for daily trigger

// AI universe tickers
const AI_TICKERS = new Set();
for (const sec of SECTORS) {
  for (const h of sec.holdings) AI_TICKERS.add(h.ticker);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function tradingDaysBetween(allDailyDates, startDate, endDate) {
  // count trading days strictly after startDate and <= endDate
  let count = 0;
  for (const d of allDailyDates) {
    if (d > startDate && d <= endDate) count++;
  }
  return count;
}

function indexAfterDate(bars, dateStr) {
  // returns first index where bar.date > dateStr
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].date > dateStr) return i;
  }
  return bars.length;
}

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

// ── TTM Return computation ────────────────────────────────────────────────────
function computeTTMReturn(dailyBars) {
  if (!dailyBars || dailyBars.length < 2) return null;
  const sorted = [...dailyBars].sort((a, b) => a.date.localeCompare(b.date));
  const last = sorted[sorted.length - 1];
  // find bar closest to 365 days ago
  const cutoff = new Date(last.date);
  cutoff.setDate(cutoff.getDate() - 365);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  // find bar on or just after cutoff
  let ref = sorted[0];
  for (const bar of sorted) {
    if (bar.date >= cutoffStr) { ref = bar; break; }
  }
  if (ref.date === last.date) return null;
  return (last.close - ref.close) / ref.close;
}

// ── Shape bars from MongoDB doc to signal format ──────────────────────────────
function shapeDaily(rawBars) {
  return rawBars
    .filter(b => b.date >= '2022-01-01' && b.date <= TEST_END)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(b => ({ time: b.date, open: b.open, high: b.high, low: b.low, close: b.close }));
}

function shapeWeekly(rawBars) {
  return rawBars
    .filter(b => {
      const d = b.weekOf || b.date;
      return d >= '2022-01-01' && d <= TEST_END;
    })
    .sort((a, b) => {
      const da = a.weekOf || a.date;
      const db = b.weekOf || b.date;
      return da.localeCompare(db);
    })
    .map(b => ({
      time: b.weekOf || b.date,
      open: b.open, high: b.high, low: b.low, close: b.close
    }));
}

// ── Run fresh-BL backtest on one ticker ──────────────────────────────────────
// Returns array of trade objects
function runFreshBL(weeklyBars, ticker) {
  if (!weeklyBars || weeklyBars.length < 25) return [];

  const { events } = detectAllSignals(weeklyBars, 21, false, null, 0.10);
  const trades = [];

  for (let ei = 0; ei < events.length; ei++) {
    const ev = events[ei];
    if (ev.signal !== 'BL') continue;
    if (ev.time < TEST_START) continue;

    // Find bar index for this BL event
    const blIdx = weeklyBars.findIndex(b => b.time === ev.time);
    if (blIdx < 2) continue;

    const prev1 = weeklyBars[blIdx - 1];
    const prev2 = weeklyBars[blIdx - 2];
    const twoBarHigh = Math.max(prev1.high, prev2.high);
    const twoBarLow  = Math.min(prev1.low,  prev2.low);

    const entryPrice = twoBarHigh + 0.01;  // breakout entry
    const stopPrice  = twoBarLow  - 0.01;  // structural stop

    if (stopPrice >= entryPrice) continue;
    const riskPerShare = entryPrice - stopPrice;
    if (riskPerShare <= 0) continue;

    // Find exit: next BE event (which marks when 2-bar low was broken on weekly)
    let exitTime = null;
    let exitPrice = null;
    let exitSignal = null;

    for (let fi = ei + 1; fi < events.length; fi++) {
      const fe = events[fi];
      if (fe.signal === 'BE' || fe.signal === 'SS') {
        // exit at the weekly low that broke (approximate: use bar's close)
        const exitIdx = weeklyBars.findIndex(b => b.time === fe.time);
        if (exitIdx >= 0) {
          exitTime = fe.time;
          exitPrice = weeklyBars[exitIdx].low; // fill at bar low (breakout down)
          exitSignal = fe.signal;
        }
        break;
      }
    }

    // If no exit found, skip (open trade at end of test)
    if (!exitTime) continue;

    const rMultiple = (exitPrice - entryPrice) / riskPerShare;
    const entryDate = ev.time; // BL fires on Friday, enter "Monday" same-bar for simplicity
    const exitDate = exitTime;

    // compute holding weeks
    const entryIdx = weeklyBars.findIndex(b => b.time === entryDate);
    const exitIdx  = weeklyBars.findIndex(b => b.time === exitDate);
    const holdingWeeks = exitIdx - entryIdx;
    const holdingDays  = holdingWeeks * 5;

    trades.push({
      ticker,
      entryDate,
      exitDate,
      entryPrice,
      stopPrice,
      exitPrice,
      riskPerShare,
      rMultiple,
      holdingDays,
      strategy: 'FreshBL',
    });
  }

  return trades;
}

// ── Run re-entry BL backtest on one ticker ────────────────────────────────────
// Looks for first daily 2-bar-high breakout within 20 trading days of weekly BL
function runReentryBL(weeklyBars, dailyBars, ticker) {
  if (!weeklyBars || weeklyBars.length < 25) return [];
  if (!dailyBars || dailyBars.length < 35) return [];

  const { events } = detectAllSignals(weeklyBars, 21, false, null, 0.10);
  const trades = [];

  for (let ei = 0; ei < events.length; ei++) {
    const ev = events[ei];
    if (ev.signal !== 'BL') continue;
    if (ev.time < TEST_START) continue;

    const blDate = ev.time; // Friday of weekly BL

    // Find the next BE/SS event to know when weekly signal ends
    let weeklyExitDate = TEST_END;
    for (let fi = ei + 1; fi < events.length; fi++) {
      if (events[fi].signal === 'BE' || events[fi].signal === 'SS') {
        weeklyExitDate = events[fi].time;
        break;
      }
    }

    // Collect daily bars in the 20-trading-day window after BL date
    const windowBars = [];
    let tradingDayCount = 0;
    let foundWindow = false;

    for (let di = 0; di < dailyBars.length; di++) {
      const bar = dailyBars[di];
      if (bar.time <= blDate) continue; // only AFTER the BL fire date
      if (bar.time >= weeklyExitDate) break; // don't enter after signal ends

      tradingDayCount++;
      windowBars.push({ ...bar, di_original: di });

      if (tradingDayCount >= REENTRY_WINDOW) {
        foundWindow = true;
        break;
      }
    }

    if (windowBars.length < 3) continue;

    // Compute daily EMA-30 on ALL daily bars up to end of window
    const windowEndDate = windowBars[windowBars.length - 1].time;
    const allBarsUpToWindow = dailyBars.filter(b => b.time <= windowEndDate);
    const closes = allBarsUpToWindow.map(b => b.close);

    // Find the first daily bar where close > EMA30 AND high >= max(prev2 daily highs) + $0.01
    let entryTrade = null;

    for (let wi = 0; wi < windowBars.length; wi++) {
      const wbar = windowBars[wi];

      // find position in allBarsUpToWindow
      const wIdx = allBarsUpToWindow.findIndex(b => b.time === wbar.time);
      if (wIdx < 32) continue; // need at least 30 bars for EMA + 2 prev bars

      const prev1 = allBarsUpToWindow[wIdx - 1];
      const prev2 = allBarsUpToWindow[wIdx - 2];
      if (!prev1 || !prev2) continue;

      // Compute EMA-30 at this bar
      const ema = calcEMA(closes.slice(0, wIdx), 30);
      if (!ema) continue;

      const twoBarHigh = Math.max(prev1.high, prev2.high);
      const twoBarLow  = Math.min(prev1.low,  prev2.low);

      const breakoutLevel = twoBarHigh + 0.01;

      // Trigger: close above EMA AND high >= 2-bar-high breakout
      if (wbar.close > ema && wbar.high >= breakoutLevel) {
        const entryPrice = wbar.close; // enter at close of trigger bar
        const stopPrice  = twoBarLow - 0.01;

        if (stopPrice >= entryPrice) continue;
        const riskPerShare = entryPrice - stopPrice;
        if (riskPerShare <= 0) continue;

        // Now find exit: first daily bar where low < min(prev2 daily lows)
        let exitPrice = null;
        let exitDate  = null;

        for (let xi = wIdx + 1; xi < allBarsUpToWindow.length; xi++) {
          if (allBarsUpToWindow[xi].time > TEST_END) break;
          const xPrev1 = allBarsUpToWindow[xi - 1];
          const xPrev2 = allBarsUpToWindow[xi - 2];
          if (!xPrev1 || !xPrev2) continue;

          const exitStop = Math.min(xPrev1.low, xPrev2.low) - 0.01;
          if (allBarsUpToWindow[xi].low <= exitStop) {
            exitPrice = exitStop; // filled at stop
            exitDate  = allBarsUpToWindow[xi].time;
            break;
          }
        }

        // If no exit, skip open trade
        if (!exitDate) break;

        const rMultiple = (exitPrice - entryPrice) / riskPerShare;

        // Count holding days
        const holdingDays = allBarsUpToWindow
          .filter(b => b.time > wbar.time && b.time <= exitDate).length;

        entryTrade = {
          ticker,
          entryDate: wbar.time,
          exitDate,
          entryPrice,
          stopPrice,
          exitPrice,
          riskPerShare,
          rMultiple,
          holdingDays,
          strategy: 'ReentryBL',
          blDate,
        };
        break; // only first trigger in window
      }
    }

    if (entryTrade) trades.push(entryTrade);
  }

  return trades;
}

// ── Metrics computation ───────────────────────────────────────────────────────
function computeMetrics(trades, label) {
  if (!trades.length) {
    return { label, totalTrades: 0, note: 'no trades' };
  }

  const winners = trades.filter(t => t.rMultiple > 0);
  const losers  = trades.filter(t => t.rMultiple <= 0);

  const winRate     = winners.length / trades.length;
  const avgR        = trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length;
  const avgWinR     = winners.length ? winners.reduce((s, t) => s + t.rMultiple, 0) / winners.length : 0;
  const avgLossR    = losers.length  ? losers.reduce((s, t) => s + t.rMultiple, 0) / losers.length  : 0;
  const maxWinR     = winners.length ? Math.max(...winners.map(t => t.rMultiple)) : 0;
  const maxLossR    = losers.length  ? Math.min(...losers.map(t => t.rMultiple))  : 0;
  const sumWins     = winners.reduce((s, t) => s + t.rMultiple, 0);
  const sumLosses   = Math.abs(losers.reduce((s, t) => s + t.rMultiple, 0));
  const profitFactor = sumLosses > 0 ? sumWins / sumLosses : (sumWins > 0 ? Infinity : 0);
  const avgHoldDays  = trades.reduce((s, t) => s + t.holdingDays, 0) / trades.length;

  // Equity curve + CAGR
  const sortedTrades = [...trades].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  let nav = STARTING_NAV;
  const dailyNavs = [{ date: TEST_START, nav }];

  for (const t of sortedTrades) {
    const shares = Math.floor(RISK_PER_TRADE / t.riskPerShare);
    const pnl = shares * (t.exitPrice - t.entryPrice);
    nav = Math.max(nav + pnl, 1);
    dailyNavs.push({ date: t.exitDate, nav });
  }

  // CAGR
  const firstDate = new Date(TEST_START);
  const lastDate  = new Date(TEST_END);
  const years = (lastDate - firstDate) / (365.25 * 24 * 3600 * 1000);
  const finalNav = dailyNavs[dailyNavs.length - 1].nav;
  const cagr = Math.pow(finalNav / STARTING_NAV, 1 / years) - 1;

  // Daily returns for Sharpe / Sortino
  // Approximate: one return per trade
  const tradeReturns = sortedTrades.map(t => {
    const shares = Math.floor(RISK_PER_TRADE / t.riskPerShare);
    return shares * (t.exitPrice - t.entryPrice) / STARTING_NAV;
  });
  const meanReturn = tradeReturns.reduce((s, r) => s + r, 0) / tradeReturns.length;
  const stdAll  = Math.sqrt(tradeReturns.reduce((s, r) => s + Math.pow(r - meanReturn, 2), 0) / tradeReturns.length);
  const downside = tradeReturns.filter(r => r < 0);
  const stdDown = downside.length > 1
    ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / downside.length)
    : stdAll;

  // Annualize Sharpe/Sortino assuming avg holding days per trade
  const tradesPerYear = 252 / (avgHoldDays || 5);
  const sharpe  = stdAll  > 0 ? (meanReturn * tradesPerYear) / (stdAll  * Math.sqrt(tradesPerYear)) : 0;
  const sortino = stdDown > 0 ? (meanReturn * tradesPerYear) / (stdDown * Math.sqrt(tradesPerYear)) : 0;

  // Max drawdown on equity curve
  let peak = STARTING_NAV;
  let maxDD = 0;
  for (const { nav: n } of dailyNavs) {
    if (n > peak) peak = n;
    const dd = (peak - n) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const calmar = maxDD > 0 ? cagr / maxDD : 0;

  return {
    label,
    totalTrades:   trades.length,
    winRate,
    profitFactor,
    avgR,
    avgWinR,
    avgLossR,
    maxWinR,
    maxLossR,
    avgHoldDays,
    cagr,
    sharpe,
    sortino,
    maxDD,
    calmar,
    finalNav,
    trades: sortedTrades,
  };
}

// ── Print helpers ─────────────────────────────────────────────────────────────
function pct(v) { return (v * 100).toFixed(2) + '%'; }
function f2(v)  { return typeof v === 'number' ? v.toFixed(2) : v; }

function printMetricsTable(results) {
  const cols = ['Metric', ...results.map(r => r.label)];
  const rows = [
    ['Total Trades',     ...results.map(r => r.totalTrades)],
    ['Win Rate',         ...results.map(r => pct(r.winRate || 0))],
    ['Profit Factor',    ...results.map(r => f2(r.profitFactor))],
    ['Avg R',            ...results.map(r => f2(r.avgR))],
    ['Avg Win R',        ...results.map(r => f2(r.avgWinR))],
    ['Avg Loss R',       ...results.map(r => f2(r.avgLossR))],
    ['Max Win R',        ...results.map(r => f2(r.maxWinR))],
    ['Max Loss R',       ...results.map(r => f2(r.maxLossR))],
    ['Avg Holding Days', ...results.map(r => f2(r.avgHoldDays))],
    ['CAGR',             ...results.map(r => pct(r.cagr || 0))],
    ['Sharpe',           ...results.map(r => f2(r.sharpe))],
    ['Sortino',          ...results.map(r => f2(r.sortino))],
    ['Max Drawdown',     ...results.map(r => pct(r.maxDD || 0))],
    ['Calmar',           ...results.map(r => f2(r.calmar))],
    ['Final NAV',        ...results.map(r => '$' + Math.round(r.finalNav || STARTING_NAV).toLocaleString())],
  ];

  // column widths
  const widths = cols.map((c, ci) => {
    let max = c.length;
    for (const row of rows) {
      if (String(row[ci]).length > max) max = String(row[ci]).length;
    }
    return max;
  });

  const separator = '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+';
  const formatRow = (row) => '| ' + row.map((cell, ci) => String(cell).padEnd(widths[ci])).join(' | ') + ' |';

  console.log(separator);
  console.log(formatRow(cols));
  console.log(separator);
  for (const row of rows) {
    console.log(formatRow(row));
  }
  console.log(separator);
}

function printTopBottom(trades, label, n = 10) {
  if (!trades || !trades.length) return;
  const sorted = [...trades].sort((a, b) => b.rMultiple - a.rMultiple);
  console.log(`\n--- ${label} — Top ${n} trades by R ---`);
  console.log('Rank | Ticker | Entry Date  | Exit Date   |  Entry  |  Stop   |  Exit   |    R   | Hold');
  for (const t of sorted.slice(0, n)) {
    console.log(
      `${String(sorted.indexOf(t)+1).padStart(4)} | ${t.ticker.padEnd(6)} | ${t.entryDate} | ${t.exitDate} | ${f2(t.entryPrice).padStart(7)} | ${f2(t.stopPrice).padStart(7)} | ${f2(t.exitPrice).padStart(7)} | ${f2(t.rMultiple).padStart(6)} | ${Math.round(t.holdingDays)}d`
    );
  }

  console.log(`\n--- ${label} — Bottom ${n} trades by R ---`);
  console.log('Rank | Ticker | Entry Date  | Exit Date   |  Entry  |  Stop   |  Exit   |    R   | Hold');
  for (const t of sorted.slice(-n).reverse()) {
    console.log(
      `${String(sorted.length - sorted.slice(-n).reverse().indexOf(t)).padStart(4)} | ${t.ticker.padEnd(6)} | ${t.entryDate} | ${t.exitDate} | ${f2(t.entryPrice).padStart(7)} | ${f2(t.stopPrice).padStart(7)} | ${f2(t.exitPrice).padStart(7)} | ${f2(t.rMultiple).padStart(6)} | ${Math.round(t.holdingDays)}d`
    );
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== PNTHR Re-Entry BL vs Fresh BL Backtest ===');
  console.log(`Test period: ${TEST_START} → ${TEST_END}`);
  console.log(`Top ${TOP_N} stocks by TTM return per universe`);
  console.log(`Risk per trade: $${RISK_PER_TRADE} on $${STARTING_NAV.toLocaleString()} starting NAV\n`);

  const db = await connectToDatabase();
  if (!db) {
    console.error('Could not connect to MongoDB. Check MONGODB_URI in .env');
    process.exit(1);
  }

  // ── Load data from MongoDB ──────────────────────────────────────────────────
  console.log('Loading daily candle data...');

  const [daily679, daily_ai, weekly679, weekly_ai] = await Promise.all([
    db.collection('pnthr_bt_candles').find({}, { projection: { ticker: 1, daily: 1 } }).toArray(),
    db.collection('pnthr_ai_bt_candles').find({}, { projection: { ticker: 1, daily: 1 } }).toArray(),
    db.collection('pnthr_bt_candles_weekly').find({}, { projection: { ticker: 1, weekly: 1 } }).toArray(),
    db.collection('pnthr_ai_bt_candles_weekly').find({}, { projection: { ticker: 1, weekly: 1 } }).toArray(),
  ]);

  console.log(`Loaded: 679 daily=${daily679.length} weekly=${weekly679.length} | AI daily=${daily_ai.length} weekly=${weekly_ai.length}`);

  // Build lookup maps
  const daily679Map  = {};
  const weeklyB679Map = {};
  const dailyAiMap   = {};
  const weeklyAiMap  = {};

  for (const doc of daily679)   daily679Map[doc.ticker]   = doc.daily   || [];
  for (const doc of weekly679)  weeklyB679Map[doc.ticker] = doc.weekly  || [];
  for (const doc of daily_ai)   dailyAiMap[doc.ticker]    = doc.daily   || [];
  for (const doc of weekly_ai)  weeklyAiMap[doc.ticker]   = doc.weekly  || [];

  // ── Compute TTM returns and select top 100 per universe ──────────────────────
  console.log('\nComputing TTM returns...');

  // 679 universe: all tickers in pnthr_bt_candles
  const tickers679 = Object.keys(daily679Map);
  const ttm679 = [];
  for (const ticker of tickers679) {
    const raw = daily679Map[ticker];
    const ttm = computeTTMReturn(raw);
    if (ttm !== null) ttm679.push({ ticker, ttm });
  }
  ttm679.sort((a, b) => b.ttm - a.ttm);
  const top679 = ttm679.slice(0, TOP_N).map(x => x.ticker);
  console.log(`679 universe: ${tickers679.length} tickers → top ${top679.length} selected (TTM range: ${pct(ttm679[0]?.ttm)} to ${pct(ttm679[TOP_N-1]?.ttm)})`);

  // AI 300 universe
  const tickersAI = [...AI_TICKERS].filter(t => dailyAiMap[t]);
  const ttmAI = [];
  for (const ticker of tickersAI) {
    const raw = dailyAiMap[ticker];
    const ttm = computeTTMReturn(raw);
    if (ttm !== null) ttmAI.push({ ticker, ttm });
  }
  ttmAI.sort((a, b) => b.ttm - a.ttm);
  const topAI = ttmAI.slice(0, TOP_N).map(x => x.ticker);
  console.log(`AI universe: ${tickersAI.length} tickers → top ${topAI.length} selected (TTM range: ${pct(ttmAI[0]?.ttm)} to ${pct(ttmAI[TOP_N-1]?.ttm)})`);

  // ── Run backtests ──────────────────────────────────────────────────────────
  console.log('\nRunning Fresh BL backtest...');

  const freshBL679Trades = [];
  const freshBLAiTrades  = [];
  let processed = 0;

  for (const ticker of top679) {
    const weekly = shapeWeekly(weeklyB679Map[ticker] || []);
    const trades = runFreshBL(weekly, ticker);
    freshBL679Trades.push(...trades);
    processed++;
    if (processed % 20 === 0) process.stdout.write(`  679 fresh BL: ${processed}/${top679.length} tickers\r`);
  }
  console.log(`  679 Fresh BL: ${top679.length} tickers → ${freshBL679Trades.length} trades`);

  processed = 0;
  for (const ticker of topAI) {
    const weekly = shapeWeekly(weeklyAiMap[ticker] || []);
    const trades = runFreshBL(weekly, ticker);
    freshBLAiTrades.push(...trades);
    processed++;
    if (processed % 20 === 0) process.stdout.write(`  AI fresh BL: ${processed}/${topAI.length} tickers\r`);
  }
  console.log(`  AI Fresh BL: ${topAI.length} tickers → ${freshBLAiTrades.length} trades`);

  console.log('\nRunning Re-entry BL backtest...');

  const reentry679Trades = [];
  const reentryAiTrades  = [];

  processed = 0;
  for (const ticker of top679) {
    const weekly = shapeWeekly(weeklyB679Map[ticker] || []);
    const daily  = shapeDaily(daily679Map[ticker] || []);
    const trades = runReentryBL(weekly, daily, ticker);
    reentry679Trades.push(...trades);
    processed++;
    if (processed % 20 === 0) process.stdout.write(`  679 reentry: ${processed}/${top679.length} tickers\r`);
  }
  console.log(`  679 Re-entry: ${top679.length} tickers → ${reentry679Trades.length} trades`);

  processed = 0;
  for (const ticker of topAI) {
    const weekly = shapeWeekly(weeklyAiMap[ticker] || []);
    const daily  = shapeDaily(dailyAiMap[ticker] || []);
    const trades = runReentryBL(weekly, daily, ticker);
    reentryAiTrades.push(...trades);
    processed++;
    if (processed % 20 === 0) process.stdout.write(`  AI reentry: ${processed}/${topAI.length} tickers\r`);
  }
  console.log(`  AI Re-entry: ${topAI.length} tickers → ${reentryAiTrades.length} trades`);

  // ── Compute metrics ─────────────────────────────────────────────────────────
  console.log('\n');

  const freshBL679 = computeMetrics(freshBL679Trades,   '679 Fresh BL');
  const reentry679 = computeMetrics(reentry679Trades,    '679 Re-entry');
  const freshBLAi  = computeMetrics(freshBLAiTrades,    'AI Fresh BL');
  const reentryAi  = computeMetrics(reentryAiTrades,    'AI Re-entry');
  const freshBLAll = computeMetrics([...freshBL679Trades, ...freshBLAiTrades], 'Combined Fresh BL');
  const reentryAll = computeMetrics([...reentry679Trades, ...reentryAiTrades], 'Combined Re-entry');

  // ── Print results ───────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  679 UNIVERSE — Fresh BL vs Re-entry BL');
  console.log('══════════════════════════════════════════════════════════════════');
  printMetricsTable([freshBL679, reentry679]);

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  AI 300 UNIVERSE — Fresh BL vs Re-entry BL');
  console.log('══════════════════════════════════════════════════════════════════');
  printMetricsTable([freshBLAi, reentryAi]);

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  COMBINED (679 + AI 300) — Fresh BL vs Re-entry BL');
  console.log('══════════════════════════════════════════════════════════════════');
  printMetricsTable([freshBLAll, reentryAll]);

  // ── Top/Bottom 10 individual trades ─────────────────────────────────────────
  printTopBottom(freshBL679Trades, '679 Fresh BL');
  printTopBottom(reentry679Trades, '679 Re-entry BL');
  printTopBottom(freshBLAiTrades,  'AI 300 Fresh BL');
  printTopBottom(reentryAiTrades,  'AI 300 Re-entry BL');

  console.log('\n=== Backtest complete ===');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
