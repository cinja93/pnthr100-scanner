// server/scripts/reentryBacktestWalkForward.mjs
// ── PNTHR Re-Entry BL — Walk-Forward (Look-Ahead-Bias Fixed) ────────────────
//
// CRITICAL FIX: Universe selection is now computed AS OF each signal date.
// Prior version ranked all tickers using most-recent TTM data (look-ahead bias).
// This version: for each BL signal date, we compute every ticker's TTM return
// using only data available on that date, then check if the ticker was in the
// top 100 at that moment.
//
// Rules (Option A — Daily Stop/Exit):
//   Entry: Weekly BL fires → scan next 20 trading days → first daily bar where
//          close > EMA-30 AND high >= max(prev2 daily highs) + $0.01 → enter at CLOSE
//   Stop:  min(prev2 daily lows) - $0.01 on entry bar
//   Exit:  Trailing 2-bar-low stop (daily)
//   Size:  floor($1,000 / riskPerShare)
//   R cap: 20R (removes data artifacts like GE 170.64R)
//   Period: 2023-01-01 → 2026-05-01
//   Universe: TOP 100 by TTM return AS OF each signal date (walk-forward)
//
// Run: node server/scripts/reentryBacktestWalkForward.mjs
// ────────────────────────────────────────────────────────────────────────────

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
    return true;
  } catch { return false; }
}

const loaded =
  loadEnvFile(path.resolve(__dirname, '../.env')) ||
  loadEnvFile('/Users/cindyeagar/pnthr100-scanner/server/.env');

if (!loaded || !process.env.MONGODB_URI) {
  console.error('Could not load .env or MONGODB_URI missing');
  process.exit(1);
}

const { connectToDatabase } = await import('../database.js');
const { detectAllSignals }  = await import('../signalDetection.js');
const { SECTORS }           = await import('./aiUniverse/aiUniverseData.js');

// ── Constants ────────────────────────────────────────────────────────────────
const TEST_START     = '2023-01-01';
const TEST_END       = '2026-05-01';
const RISK_PER_TRADE = 1000;
const STARTING_NAV   = 100000;
const R_CAP          = 20;
const TOP_N          = 100;   // how many tickers are "in universe" at each signal date
const REENTRY_WINDOW = 20;    // trading days after BL to look for daily trigger

const AI_TICKERS = new Set();
for (const sec of SECTORS) {
  for (const h of sec.holdings) AI_TICKERS.add(h.ticker);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function shapeDaily(rawBars, cutoffDate) {
  return rawBars
    .filter(b => b.date >= '2022-01-01' && b.date <= (cutoffDate || TEST_END))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(b => ({ time: b.date, open: b.open, high: b.high, low: b.low, close: b.close }));
}

function shapeWeekly(rawBars) {
  return rawBars
    .filter(b => { const d = b.weekOf || b.date; return d >= '2022-01-01' && d <= TEST_END; })
    .sort((a, b) => { const da = a.weekOf || a.date; const db = b.weekOf || b.date; return da.localeCompare(db); })
    .map(b => ({ time: b.weekOf || b.date, open: b.open, high: b.high, low: b.low, close: b.close }));
}

function capR(r) { return Math.min(r, R_CAP); }

// Compute TTM return for a ticker as of `asOfDate` using its daily bars
// Returns null if not enough data
function computeTTMReturnAsOf(sortedDailyBars, asOfDate) {
  // sortedDailyBars already sorted ascending by date
  // Find the most recent bar ON OR BEFORE asOfDate
  let todayIdx = -1;
  for (let i = sortedDailyBars.length - 1; i >= 0; i--) {
    if (sortedDailyBars[i].time <= asOfDate) { todayIdx = i; break; }
  }
  if (todayIdx < 0) return null;

  const todayBar = sortedDailyBars[todayIdx];
  const cutoff = new Date(todayBar.time);
  cutoff.setDate(cutoff.getDate() - 365);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  // Find the first bar on or after the cutoff
  let refBar = null;
  for (let i = 0; i <= todayIdx; i++) {
    if (sortedDailyBars[i].time >= cutoffStr) { refBar = sortedDailyBars[i]; break; }
  }
  if (!refBar || refBar.time === todayBar.time) return null;

  return (todayBar.close - refBar.close) / refBar.close;
}

// ── Walk-forward universe check ───────────────────────────────────────────────
// Pre-build a lookup: for each (universe, date), which tickers were top-N?
// We do this lazily per signal date rather than precomputing all dates.
// Cache: Map<dateString, Set<ticker>>
function buildRankingCache(allDailyBars) {
  // allDailyBars: Map<ticker, sortedDailyBars>
  // Returns a function: (asOfDate) -> Set<ticker> of top-N by TTM
  const cache = new Map();

  function getTopN(asOfDate) {
    if (cache.has(asOfDate)) return cache.get(asOfDate);

    const ranked = [];
    for (const [ticker, bars] of allDailyBars) {
      const ttm = computeTTMReturnAsOf(bars, asOfDate);
      if (ttm !== null) ranked.push({ ticker, ttm });
    }
    ranked.sort((a, b) => b.ttm - a.ttm);
    const top = new Set(ranked.slice(0, TOP_N).map(x => x.ticker));
    cache.set(asOfDate, top);
    return top;
  }

  return getTopN;
}

// ── Core re-entry backtest (walk-forward universe) ────────────────────────────
function runReentryWalkForward(weeklyBars, dailyBars, ticker, events, getTopN) {
  if (!weeklyBars || weeklyBars.length < 25) return [];
  if (!dailyBars  || dailyBars.length  < 35) return [];

  const trades = [];

  for (let ei = 0; ei < events.length; ei++) {
    const ev = events[ei];
    if (ev.signal !== 'BL') continue;
    if (ev.time < TEST_START) continue;

    const blDate = ev.time;

    // Walk-forward universe check: was this ticker top-N as of the BL date?
    const topOnDate = getTopN(blDate);
    if (!topOnDate.has(ticker)) continue;

    // Find next BE/SS exit date
    let weeklyExitDate = TEST_END;
    for (let fi = ei + 1; fi < events.length; fi++) {
      if (events[fi].signal === 'BE' || events[fi].signal === 'SS') {
        weeklyExitDate = events[fi].time;
        break;
      }
    }

    // Collect daily bars in the next REENTRY_WINDOW trading days after BL
    const windowBars = [];
    let tradingDayCount = 0;

    for (let di = 0; di < dailyBars.length; di++) {
      const bar = dailyBars[di];
      if (bar.time <= blDate) continue;
      if (bar.time >= weeklyExitDate) break;
      tradingDayCount++;
      windowBars.push({ ...bar, di_original: di });
      if (tradingDayCount >= REENTRY_WINDOW) break;
    }

    if (windowBars.length < 3) continue;

    const windowEndDate = windowBars[windowBars.length - 1].time;
    const allBarsUpToWindow = dailyBars.filter(b => b.time <= windowEndDate);
    const closes = allBarsUpToWindow.map(b => b.close);

    let entryTrade = null;

    for (let wi = 0; wi < windowBars.length; wi++) {
      const wbar = windowBars[wi];
      const wIdx = allBarsUpToWindow.findIndex(b => b.time === wbar.time);
      if (wIdx < 32) continue;

      const prev1 = allBarsUpToWindow[wIdx - 1];
      const prev2 = allBarsUpToWindow[wIdx - 2];
      if (!prev1 || !prev2) continue;

      const ema = calcEMA(closes.slice(0, wIdx), 30);
      if (!ema) continue;

      const twoBarHigh = Math.max(prev1.high, prev2.high);
      const twoBarLow  = Math.min(prev1.low,  prev2.low);
      const breakoutLevel = twoBarHigh + 0.01;

      if (wbar.close > ema && wbar.high >= breakoutLevel) {
        const entryPrice  = wbar.close;
        const stopPrice   = twoBarLow - 0.01;

        if (stopPrice >= entryPrice) continue;
        const riskPerShare = entryPrice - stopPrice;
        if (riskPerShare <= 0) continue;

        // Exit: trailing 2-bar-low daily stop
        let exitPrice = null;
        let exitDate  = null;

        for (let xi = wIdx + 1; xi < allBarsUpToWindow.length; xi++) {
          if (allBarsUpToWindow[xi].time > TEST_END) break;
          const xPrev1 = allBarsUpToWindow[xi - 1];
          const xPrev2 = allBarsUpToWindow[xi - 2];
          if (!xPrev1 || !xPrev2) continue;
          const exitStop = Math.min(xPrev1.low, xPrev2.low) - 0.01;
          if (allBarsUpToWindow[xi].low <= exitStop) {
            exitPrice = exitStop;
            exitDate  = allBarsUpToWindow[xi].time;
            break;
          }
        }

        // If trade never exits by TEST_END, close at last available price
        if (!exitDate) {
          const lastBar = allBarsUpToWindow[allBarsUpToWindow.length - 1];
          exitPrice = lastBar.close;
          exitDate  = lastBar.time;
        }

        const rawR     = (exitPrice - entryPrice) / riskPerShare;
        const rMultiple = capR(rawR);
        const holdingDays = allBarsUpToWindow.filter(b => b.time > wbar.time && b.time <= exitDate).length;

        entryTrade = {
          ticker,
          entryDate: wbar.time,
          exitDate,
          entryPrice,
          stopPrice,
          exitPrice,
          riskPerShare,
          rMultiple,
          rawRMultiple: rawR,
          holdingDays,
          blDate,
        };
        break;
      }
    }

    if (entryTrade) trades.push(entryTrade);
  }

  return trades;
}

// ── Metrics ───────────────────────────────────────────────────────────────────
function computeMetrics(trades, label) {
  if (!trades.length) return { label, totalTrades: 0, winRate: 0, profitFactor: 0, avgR: 0, avgWinR: 0, avgLossR: 0, maxWinR: 0, avgHoldDays: 0, cagr: 0, sharpe: 0, sortino: 0, maxDD: 0, calmar: 0, finalNav: STARTING_NAV };

  const winners = trades.filter(t => t.rMultiple > 0);
  const losers  = trades.filter(t => t.rMultiple <= 0);

  const winRate      = winners.length / trades.length;
  const avgR         = trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length;
  const avgWinR      = winners.length ? winners.reduce((s, t) => s + t.rMultiple, 0) / winners.length : 0;
  const avgLossR     = losers.length  ? losers.reduce((s, t) => s + t.rMultiple, 0) / losers.length   : 0;
  const maxWinR      = winners.length ? Math.max(...winners.map(t => t.rawRMultiple ?? t.rMultiple)) : 0;
  const sumWins      = winners.reduce((s, t) => s + t.rMultiple, 0);
  const sumLosses    = Math.abs(losers.reduce((s, t) => s + t.rMultiple, 0));
  const profitFactor = sumLosses > 0 ? sumWins / sumLosses : (sumWins > 0 ? Infinity : 0);
  const avgHoldDays  = trades.reduce((s, t) => s + t.holdingDays, 0) / trades.length;

  const sortedTrades = [...trades].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  let nav = STARTING_NAV;
  const navPoints = [{ date: TEST_START, nav }];
  for (const t of sortedTrades) {
    const shares = Math.floor(RISK_PER_TRADE / t.riskPerShare);
    const pnl = Math.min(shares * (t.exitPrice - t.entryPrice), shares * t.riskPerShare * R_CAP);
    nav = Math.max(nav + pnl, 1);
    navPoints.push({ date: t.exitDate, nav });
  }

  const years = (new Date(TEST_END) - new Date(TEST_START)) / (365.25 * 24 * 3600 * 1000);
  const finalNav = navPoints[navPoints.length - 1].nav;
  const cagr = Math.pow(finalNav / STARTING_NAV, 1 / years) - 1;

  const tradeReturns = sortedTrades.map(t => {
    const shares = Math.floor(RISK_PER_TRADE / t.riskPerShare);
    return Math.min(shares * (t.exitPrice - t.entryPrice), shares * t.riskPerShare * R_CAP) / STARTING_NAV;
  });
  const meanReturn = tradeReturns.reduce((s, r) => s + r, 0) / tradeReturns.length;
  const stdAll  = Math.sqrt(tradeReturns.reduce((s, r) => s + Math.pow(r - meanReturn, 2), 0) / tradeReturns.length);
  const downside = tradeReturns.filter(r => r < 0);
  const stdDown  = downside.length > 1
    ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / downside.length)
    : stdAll;

  const tradesPerYear = 252 / (avgHoldDays || 5);
  const sharpe  = stdAll  > 0 ? (meanReturn * tradesPerYear) / (stdAll  * Math.sqrt(tradesPerYear)) : 0;
  const sortino = stdDown > 0 ? (meanReturn * tradesPerYear) / (stdDown * Math.sqrt(tradesPerYear)) : 0;

  let peak = STARTING_NAV;
  let maxDD = 0;
  for (const { nav: n } of navPoints) {
    if (n > peak) peak = n;
    const dd = (peak - n) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    label, totalTrades: trades.length, winRate, profitFactor,
    avgR, avgWinR, avgLossR, maxWinR,
    avgHoldDays, cagr, sharpe, sortino, maxDD,
    calmar: maxDD > 0 ? cagr / maxDD : 0,
    finalNav, trades: sortedTrades,
  };
}

// ── Print ─────────────────────────────────────────────────────────────────────
function pct(v) { return (v * 100).toFixed(2) + '%'; }
function f2(v)  { return typeof v === 'number' ? v.toFixed(2) : v; }

function printTable(results) {
  const cols = ['Metric', ...results.map(r => r.label)];
  const rows = [
    ['Total Trades',     ...results.map(r => r.totalTrades)],
    ['Win Rate',         ...results.map(r => pct(r.winRate || 0))],
    ['Profit Factor',    ...results.map(r => f2(r.profitFactor))],
    ['Avg R',            ...results.map(r => f2(r.avgR))],
    ['Avg Win R',        ...results.map(r => f2(r.avgWinR))],
    ['Avg Loss R',       ...results.map(r => f2(r.avgLossR))],
    ['Max Win R (raw)',  ...results.map(r => f2(r.maxWinR))],
    ['Avg Holding Days', ...results.map(r => f2(r.avgHoldDays))],
    ['CAGR',             ...results.map(r => pct(r.cagr || 0))],
    ['Sharpe',           ...results.map(r => f2(r.sharpe))],
    ['Sortino',          ...results.map(r => f2(r.sortino))],
    ['Max Drawdown',     ...results.map(r => pct(r.maxDD || 0))],
    ['Calmar',           ...results.map(r => f2(r.calmar))],
    ['Final NAV',        ...results.map(r => '$' + Math.round(r.finalNav || STARTING_NAV).toLocaleString())],
  ];
  const widths = cols.map((c, ci) => {
    let max = c.length;
    for (const row of rows) if (String(row[ci]).length > max) max = String(row[ci]).length;
    return max;
  });
  const sep = '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+';
  const fmt = (row) => '| ' + row.map((cell, ci) => String(cell).padEnd(widths[ci])).join(' | ') + ' |';
  console.log(sep); console.log(fmt(cols)); console.log(sep);
  for (const row of rows) console.log(fmt(row));
  console.log(sep);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== PNTHR Re-Entry BL — Walk-Forward (No Look-Ahead Bias) ===');
  console.log(`Period: ${TEST_START} → ${TEST_END}  |  Top ${TOP_N} per signal date  |  R cap: ${R_CAP}R`);
  console.log(`Risk/trade: $${RISK_PER_TRADE}  |  Starting NAV: $${STARTING_NAV.toLocaleString()}`);
  console.log('Universe ranking recomputed at each BL signal date (walk-forward).\n');

  const db = await connectToDatabase();
  if (!db) { console.error('MongoDB connection failed'); process.exit(1); }

  console.log('Loading candle data from MongoDB...');
  const [daily679, daily_ai, weekly679, weekly_ai] = await Promise.all([
    db.collection('pnthr_bt_candles').find({}, { projection: { ticker: 1, daily: 1 } }).toArray(),
    db.collection('pnthr_ai_bt_candles').find({}, { projection: { ticker: 1, daily: 1 } }).toArray(),
    db.collection('pnthr_bt_candles_weekly').find({}, { projection: { ticker: 1, weekly: 1 } }).toArray(),
    db.collection('pnthr_ai_bt_candles_weekly').find({}, { projection: { ticker: 1, weekly: 1 } }).toArray(),
  ]);
  console.log(`679:  daily=${daily679.length}  weekly=${weekly679.length}`);
  console.log(`AI300: daily=${daily_ai.length} weekly=${weekly_ai.length}`);

  // Build ticker → sorted daily bars maps
  const daily679Map  = new Map();
  const dailyAiMap   = new Map();
  const weekly679Map = new Map();
  const weeklyAiMap  = new Map();

  for (const doc of daily679)  daily679Map.set(doc.ticker, shapeDaily(doc.daily || []));
  for (const doc of daily_ai)  dailyAiMap.set(doc.ticker, shapeDaily(doc.daily || []));
  for (const doc of weekly679) weekly679Map.set(doc.ticker, shapeWeekly(doc.weekly || []));
  for (const doc of weekly_ai) weeklyAiMap.set(doc.ticker, shapeWeekly(doc.weekly || []));

  // AI ticker filter
  const aiTickerSet = new Set([...AI_TICKERS].filter(t => dailyAiMap.has(t)));

  // Build walk-forward ranking functions
  console.log('\nBuilding walk-forward ranking caches (lazy, computed per signal date)...');
  const getTopN679 = buildRankingCache(daily679Map);
  const getTopNAI  = buildRankingCache(new Map([...dailyAiMap].filter(([t]) => aiTickerSet.has(t))));

  // Pre-compute weekly signals for all tickers
  console.log('Pre-computing weekly signals for all tickers...');
  const signals679 = new Map();
  const signalsAI  = new Map();

  for (const [ticker, weekly] of weekly679Map) {
    if (weekly.length >= 25) {
      const { events } = detectAllSignals(weekly, 21, false, null, 0.10);
      signals679.set(ticker, { weekly, events });
    }
  }
  for (const ticker of aiTickerSet) {
    const weekly = weeklyAiMap.get(ticker);
    if (weekly && weekly.length >= 25) {
      const { events } = detectAllSignals(weekly, 21, false, null, 0.10);
      signalsAI.set(ticker, { weekly, events });
    }
  }
  console.log(`Signals ready: 679=${signals679.size}  AI=${signalsAI.size}`);

  // ── Run 679 universe ─────────────────────────────────────────────────────────
  console.log('\nRunning 679 universe (walk-forward)...');
  const trades679 = [];
  let processed679 = 0;
  for (const [ticker, { weekly, events }] of signals679) {
    const daily = daily679Map.get(ticker);
    const t = runReentryWalkForward(weekly, daily, ticker, events, getTopN679);
    trades679.push(...t);
    processed679++;
    if (processed679 % 50 === 0) process.stdout.write(`  ${processed679}/${signals679.size}...\n`);
  }
  console.log(`679 total trades: ${trades679.length}`);

  // ── Run AI 300 universe ──────────────────────────────────────────────────────
  console.log('\nRunning AI 300 universe (walk-forward)...');
  const tradesAI = [];
  let processedAI = 0;
  for (const [ticker, { weekly, events }] of signalsAI) {
    const daily = dailyAiMap.get(ticker);
    const t = runReentryWalkForward(weekly, daily, ticker, events, getTopNAI);
    tradesAI.push(...t);
    processedAI++;
    if (processedAI % 50 === 0) process.stdout.write(`  ${processedAI}/${signalsAI.size}...\n`);
  }
  console.log(`AI total trades: ${tradesAI.length}`);

  const tradesCombined = [...trades679, ...tradesAI];

  // ── Results ──────────────────────────────────────────────────────────────────
  const m679      = computeMetrics(trades679,      '679 (WF)');
  const mAI       = computeMetrics(tradesAI,       'AI 300 (WF)');
  const mCombined = computeMetrics(tradesCombined, 'Combined (WF)');

  console.log('\n\n══════════════════════════════════════════════════════════════');
  console.log('  WALK-FORWARD RESULTS — No Look-Ahead Bias (R capped at 20R)');
  console.log('══════════════════════════════════════════════════════════════');
  printTable([m679, mAI, mCombined]);

  // ── Top 10 trades by R (to spot any remaining artifacts) ─────────────────────
  console.log('\nTop 10 trades by R (combined, check for artifacts):');
  const top10 = [...tradesCombined].sort((a, b) => b.rawRMultiple - a.rawRMultiple).slice(0, 10);
  console.log(
    'Ticker'.padEnd(8) + 'Entry Date'.padEnd(13) + 'Entry$'.padEnd(10) +
    'Stop$'.padEnd(10) + 'Exit$'.padEnd(10) + 'Risk/sh'.padEnd(10) + 'Raw R'
  );
  console.log('-'.repeat(63));
  for (const t of top10) {
    console.log(
      t.ticker.padEnd(8) +
      t.entryDate.padEnd(13) +
      t.entryPrice.toFixed(2).padEnd(10) +
      t.stopPrice.toFixed(2).padEnd(10) +
      t.exitPrice.toFixed(2).padEnd(10) +
      t.riskPerShare.toFixed(2).padEnd(10) +
      t.rawRMultiple.toFixed(2)
    );
  }

  // ── Compare vs biased results ─────────────────────────────────────────────────
  console.log('\n\n══════════════════════════════════════════════════════════════');
  console.log('  COMPARISON: Look-Ahead Biased (prior run) vs Walk-Forward');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('Prior biased  (V0 Combined, 20R cap): Win 46.06%, PF 2.69, Avg R 0.40, CAGR 107.41%, Sharpe 1.77, MaxDD 18.73%');
  console.log(`Walk-forward  (Combined):             Win ${pct(mCombined.winRate)}, PF ${f2(mCombined.profitFactor)}, Avg R ${f2(mCombined.avgR)}, CAGR ${pct(mCombined.cagr)}, Sharpe ${f2(mCombined.sharpe)}, MaxDD ${pct(mCombined.maxDD)}`);

  console.log('\n=== Walk-forward backtest complete ===');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
