// server/scripts/reentryBacktestB.mjs
// ── PNTHR Re-Entry BL vs Fresh BL Backtest — Option B ───────────────────────
//
// Option B: Re-entry trades are managed IDENTICALLY to Fresh BL.
// The ONLY difference is entry timing.
//
//   Fresh BL:
//     - Entry: Monday open after weekly BL fires (approx: BL bar's 2-bar-high + 0.01)
//     - Stop:  min(prev2 weekly lows) - 0.01
//     - Exit:  weekly 2-bar-low break (same as BE signal)
//     - Size:  $1k risk / (entry - stop)
//
//   Re-entry BL (Option B):
//     - Same weekly BL signal fires
//     - Scan daily bars within 20 trading days AFTER BL fire date
//     - Entry trigger: first daily bar where daily high >= max(prev2 daily highs) + 0.01
//     - Entry price:   that daily bar's CLOSE
//     - Stop:          min(prev2 WEEKLY lows) - 0.01  ← WEEKLY structural stop, not daily
//     - Exit:          weekly bar's low < min(prev2 weekly lows)  ← IDENTICAL to Fresh BL
//     - Size:          $1k risk / (entry_close - weekly_stop)
//
// Run: node server/scripts/reentryBacktestB.mjs
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
const { detectAllSignals } = await import('../signalDetection.js');
const { SECTORS } = await import('./aiUniverse/aiUniverseData.js');

// ── Constants ────────────────────────────────────────────────────────────────
const TEST_START     = '2023-01-01';
const TEST_END       = '2026-05-01';
const RISK_PER_TRADE = 1000;
const STARTING_NAV   = 100000;
const TOP_N          = 100;
const REENTRY_WINDOW = 20; // trading days after weekly BL fire date

const AI_TICKERS = new Set();
for (const sec of SECTORS) {
  for (const h of sec.holdings) AI_TICKERS.add(h.ticker);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pct(v) { return (v * 100).toFixed(2) + '%'; }
function f2(v)  { return typeof v === 'number' ? v.toFixed(2) : String(v); }

function computeTTMReturn(rawBars) {
  if (!rawBars || rawBars.length < 2) return null;
  const sorted = [...rawBars].sort((a, b) => a.date.localeCompare(b.date));
  const last = sorted[sorted.length - 1];
  const cutoff = new Date(last.date);
  cutoff.setDate(cutoff.getDate() - 365);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  let ref = sorted[0];
  for (const bar of sorted) {
    if (bar.date >= cutoffStr) { ref = bar; break; }
  }
  if (ref.date === last.date) return null;
  return (last.close - ref.close) / ref.close;
}

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

// ── Fresh BL backtest ─────────────────────────────────────────────────────────
// Uses detectAllSignals to find BL events, then:
//   entry = 2-bar-high breakout level
//   stop  = min(prev2 weekly lows) - 0.01
//   exit  = when detectAllSignals fires BE/SS (which is the weekly 2-bar-low break)
function runFreshBL(weeklyBars, ticker) {
  if (!weeklyBars || weeklyBars.length < 25) return [];

  const { events } = detectAllSignals(weeklyBars, 21, false, null, 0.10);
  const trades = [];

  for (let ei = 0; ei < events.length; ei++) {
    const ev = events[ei];
    if (ev.signal !== 'BL') continue;
    if (ev.time < TEST_START) continue;

    const blIdx = weeklyBars.findIndex(b => b.time === ev.time);
    if (blIdx < 2) continue;

    const prev1 = weeklyBars[blIdx - 1];
    const prev2 = weeklyBars[blIdx - 2];
    const twoBarHigh = Math.max(prev1.high, prev2.high);
    const twoBarLow  = Math.min(prev1.low,  prev2.low);

    const entryPrice = twoBarHigh + 0.01;
    const stopPrice  = twoBarLow  - 0.01;

    if (stopPrice >= entryPrice) continue;
    const riskPerShare = entryPrice - stopPrice;
    if (riskPerShare <= 0) continue;

    // Exit: next BE or SS event from detectAllSignals
    let exitTime  = null;
    let exitPrice = null;

    for (let fi = ei + 1; fi < events.length; fi++) {
      const fe = events[fi];
      if (fe.signal === 'BE' || fe.signal === 'SS') {
        const exitIdx = weeklyBars.findIndex(b => b.time === fe.time);
        if (exitIdx >= 0) {
          exitTime  = fe.time;
          exitPrice = weeklyBars[exitIdx].low;
        }
        break;
      }
    }

    if (!exitTime) continue;

    const rMultiple = (exitPrice - entryPrice) / riskPerShare;
    const entryIdx  = weeklyBars.findIndex(b => b.time === ev.time);
    const exitIdx   = weeklyBars.findIndex(b => b.time === exitTime);
    const holdingDays = (exitIdx - entryIdx) * 5;

    trades.push({
      ticker,
      entryDate: ev.time,
      exitDate:  exitTime,
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

// ── Re-entry BL Option B backtest ────────────────────────────────────────────
// Entry: first daily bar within 20 td of BL fire where daily_high >= max(prev2 daily highs) + 0.01
// Stop:  min(prev2 WEEKLY lows) - 0.01  at time of daily entry
// Exit:  weekly 2-bar-low break (same as fresh BL)
// Size:  $1k / (entry_close - weekly_stop)
function runReentryB(weeklyBars, dailyBars, ticker) {
  if (!weeklyBars || weeklyBars.length < 25) return [];
  if (!dailyBars  || dailyBars.length  < 5)  return [];

  const { events } = detectAllSignals(weeklyBars, 21, false, null, 0.10);
  const trades = [];

  for (let ei = 0; ei < events.length; ei++) {
    const ev = events[ei];
    if (ev.signal !== 'BL') continue;
    if (ev.time < TEST_START) continue;

    const blDate = ev.time; // Friday of weekly BL fire

    // Find the weekly bar index for the BL fire
    const blWeeklyIdx = weeklyBars.findIndex(b => b.time === blDate);
    if (blWeeklyIdx < 2) continue;

    // Find exit event (weekly BE/SS) — used to cap the daily scan window
    let weeklyExitDate = TEST_END;
    let weeklyExitPrice = null;
    for (let fi = ei + 1; fi < events.length; fi++) {
      const fe = events[fi];
      if (fe.signal === 'BE' || fe.signal === 'SS') {
        weeklyExitDate = fe.time;
        const exitWIdx = weeklyBars.findIndex(b => b.time === fe.time);
        if (exitWIdx >= 0) weeklyExitPrice = weeklyBars[exitWIdx].low;
        break;
      }
    }

    if (!weeklyExitPrice) continue; // no closed exit — skip open trade

    // ── Find daily entry within 20 trading days after BL fire ────────────────
    let tradingDayCount = 0;
    let entryTrade = null;

    for (let di = 0; di < dailyBars.length; di++) {
      const dbar = dailyBars[di];

      // Only look at bars strictly after BL fire date and before weekly exit
      if (dbar.time <= blDate) continue;
      if (dbar.time >= weeklyExitDate) break;

      tradingDayCount++;
      if (tradingDayCount > REENTRY_WINDOW) break;

      // Need at least 2 prior daily bars for the high breakout check
      if (di < 2) continue;
      const dPrev1 = dailyBars[di - 1];
      const dPrev2 = dailyBars[di - 2];

      const twoBarDailyHigh = Math.max(dPrev1.high, dPrev2.high);
      const breakoutLevel   = twoBarDailyHigh + 0.01;

      // Trigger: today's HIGH reaches breakout level
      if (dbar.high < breakoutLevel) continue;

      // Entry price = close of trigger bar
      const entryPrice = dbar.close;

      // ── Compute WEEKLY stop at time of daily entry ────────────────────────
      // Find which weekly bar contains this daily date
      // The weekly bar that "contains" this daily date is the one with
      // the Monday-of-the-week. We want the 2 weekly bars BEFORE the current week.
      let currentWeekIdx = -1;
      for (let wi = 0; wi < weeklyBars.length; wi++) {
        // weeklyBars[wi].time is the Monday (weekOf) of that week
        const weekStart = weeklyBars[wi].time;
        const weekEnd   = wi + 1 < weeklyBars.length ? weeklyBars[wi + 1].time : '9999-99-99';
        if (dbar.time >= weekStart && dbar.time < weekEnd) {
          currentWeekIdx = wi;
          break;
        }
      }

      // Fallback: find last weekly bar on or before dbar.time
      if (currentWeekIdx < 0) {
        for (let wi = weeklyBars.length - 1; wi >= 0; wi--) {
          if (weeklyBars[wi].time <= dbar.time) {
            currentWeekIdx = wi;
            break;
          }
        }
      }

      if (currentWeekIdx < 2) continue; // need at least 2 prior weekly bars

      const wPrev1 = weeklyBars[currentWeekIdx - 1];
      const wPrev2 = weeklyBars[currentWeekIdx - 2];
      const weeklyStop = Math.min(wPrev1.low, wPrev2.low) - 0.01;

      if (weeklyStop >= entryPrice) continue; // stop above entry — invalid
      const riskPerShare = entryPrice - weeklyStop;
      if (riskPerShare <= 0) continue;

      // ── Exit: weekly 2-bar-low break (same as fresh BL) ──────────────────
      // The exit is already known from the BE/SS event we found above.
      // But we need to verify entry is before exit.
      if (dbar.time >= weeklyExitDate) continue;

      // Exit price = weekly bar's low at BE/SS event
      const exitPrice = weeklyExitPrice;
      const exitDate  = weeklyExitDate;

      const rMultiple = (exitPrice - entryPrice) / riskPerShare;

      // Holding days: count trading days from entry to exit
      let holdDays = 0;
      for (let hdi = di + 1; hdi < dailyBars.length; hdi++) {
        if (dailyBars[hdi].time > exitDate) break;
        holdDays++;
      }

      entryTrade = {
        ticker,
        entryDate:   dbar.time,
        exitDate,
        entryPrice,
        stopPrice:   weeklyStop,
        exitPrice,
        riskPerShare,
        rMultiple,
        holdingDays: holdDays,
        strategy:    'ReentryB',
        blDate,
      };
      break; // only first trigger per BL signal
    }

    if (entryTrade) trades.push(entryTrade);
  }

  return trades;
}

// ── Metrics ───────────────────────────────────────────────────────────────────
function computeMetrics(trades, label) {
  if (!trades.length) return { label, totalTrades: 0, note: 'no trades' };

  const winners = trades.filter(t => t.rMultiple > 0);
  const losers  = trades.filter(t => t.rMultiple <= 0);

  const winRate      = winners.length / trades.length;
  const avgR         = trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length;
  const avgWinR      = winners.length ? winners.reduce((s, t) => s + t.rMultiple, 0) / winners.length : 0;
  const avgLossR     = losers.length  ? losers.reduce((s,  t) => s + t.rMultiple, 0) / losers.length  : 0;
  const maxWinR      = winners.length ? Math.max(...winners.map(t => t.rMultiple)) : 0;
  const maxLossR     = losers.length  ? Math.min(...losers.map(t => t.rMultiple))  : 0;
  const sumWins      = winners.reduce((s, t) => s + t.rMultiple, 0);
  const sumLosses    = Math.abs(losers.reduce((s, t) => s + t.rMultiple, 0));
  const profitFactor = sumLosses > 0 ? sumWins / sumLosses : (sumWins > 0 ? Infinity : 0);
  const avgHoldDays  = trades.reduce((s, t) => s + t.holdingDays, 0) / trades.length;

  // Equity curve
  const sorted = [...trades].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  let nav = STARTING_NAV;
  const navPoints = [{ date: TEST_START, nav }];

  for (const t of sorted) {
    const shares = Math.floor(RISK_PER_TRADE / t.riskPerShare);
    const pnl = shares * (t.exitPrice - t.entryPrice);
    nav = Math.max(nav + pnl, 1);
    navPoints.push({ date: t.exitDate, nav });
  }

  const finalNav  = navPoints[navPoints.length - 1].nav;
  const firstDate = new Date(TEST_START);
  const lastDate  = new Date(TEST_END);
  const years     = (lastDate - firstDate) / (365.25 * 24 * 3600 * 1000);
  const cagr      = Math.pow(finalNav / STARTING_NAV, 1 / years) - 1;

  // Trade returns for Sharpe/Sortino
  const tradeReturns = sorted.map(t => {
    const shares = Math.floor(RISK_PER_TRADE / t.riskPerShare);
    return (shares * (t.exitPrice - t.entryPrice)) / STARTING_NAV;
  });
  const mean    = tradeReturns.reduce((s, r) => s + r, 0) / tradeReturns.length;
  const stdAll  = Math.sqrt(tradeReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / tradeReturns.length);
  const neg     = tradeReturns.filter(r => r < 0);
  const stdDown = neg.length > 1 ? Math.sqrt(neg.reduce((s, r) => s + r * r, 0) / neg.length) : stdAll;

  const tradesPerYear = 252 / (avgHoldDays || 5);
  const sharpe  = stdAll  > 0 ? (mean * tradesPerYear) / (stdAll  * Math.sqrt(tradesPerYear)) : 0;
  const sortino = stdDown > 0 ? (mean * tradesPerYear) / (stdDown * Math.sqrt(tradesPerYear)) : 0;

  // Max drawdown
  let peak = STARTING_NAV;
  let maxDD = 0;
  for (const { nav: n } of navPoints) {
    if (n > peak) peak = n;
    const dd = (peak - n) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const calmar = maxDD > 0 ? cagr / maxDD : 0;

  return {
    label,
    totalTrades: trades.length,
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
    trades: sorted,
  };
}

// ── Print ─────────────────────────────────────────────────────────────────────
function printMetricsTable(results) {
  const cols = ['Metric', ...results.map(r => r.label)];
  const rows = [
    ['Total Trades',     ...results.map(r => r.totalTrades)],
    ['Win Rate',         ...results.map(r => pct(r.winRate     || 0))],
    ['Profit Factor',    ...results.map(r => f2(r.profitFactor))],
    ['Avg R',            ...results.map(r => f2(r.avgR))],
    ['Avg Win R',        ...results.map(r => f2(r.avgWinR))],
    ['Avg Loss R',       ...results.map(r => f2(r.avgLossR))],
    ['Max Win R',        ...results.map(r => f2(r.maxWinR))],
    ['Max Loss R',       ...results.map(r => f2(r.maxLossR))],
    ['Avg Holding Days', ...results.map(r => f2(r.avgHoldDays))],
    ['CAGR',             ...results.map(r => pct(r.cagr       || 0))],
    ['Sharpe',           ...results.map(r => f2(r.sharpe))],
    ['Sortino',          ...results.map(r => f2(r.sortino))],
    ['Max Drawdown',     ...results.map(r => pct(r.maxDD       || 0))],
    ['Calmar',           ...results.map(r => f2(r.calmar))],
    ['Final NAV',        ...results.map(r => '$' + Math.round(r.finalNav || STARTING_NAV).toLocaleString())],
  ];

  const widths = cols.map((c, ci) => {
    let max = c.length;
    for (const row of rows) {
      if (String(row[ci]).length > max) max = String(row[ci]).length;
    }
    return max;
  });

  const sep       = '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+';
  const fmtRow    = row => '| ' + row.map((cell, ci) => String(cell).padEnd(widths[ci])).join(' | ') + ' |';

  console.log(sep);
  console.log(fmtRow(cols));
  console.log(sep);
  for (const row of rows) console.log(fmtRow(row));
  console.log(sep);
}

function printTopBottom(trades, label, n = 10) {
  if (!trades || !trades.length) return;
  const sorted = [...trades].sort((a, b) => b.rMultiple - a.rMultiple);

  const header = 'Rank | Ticker | BL Date    | Entry Date | Exit Date  |  Entry  |  Stop   |  Exit   |    R   | Hold';
  const fmtTrade = (t, rank) =>
    `${String(rank).padStart(4)} | ${(t.ticker || '').padEnd(6)} | ${(t.blDate || 'N/A').padEnd(10)} | ${t.entryDate} | ${t.exitDate} | ${f2(t.entryPrice).padStart(7)} | ${f2(t.stopPrice).padStart(7)} | ${f2(t.exitPrice).padStart(7)} | ${f2(t.rMultiple).padStart(6)} | ${Math.round(t.holdingDays)}d`;

  console.log(`\n--- ${label} — Top ${n} trades by R ---`);
  console.log(header);
  sorted.slice(0, n).forEach((t, i) => console.log(fmtTrade(t, i + 1)));

  console.log(`\n--- ${label} — Bottom ${n} trades by R ---`);
  console.log(header);
  sorted.slice(-n).reverse().forEach((t, i) => console.log(fmtTrade(t, sorted.length - i)));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== PNTHR Re-Entry BL Option B vs Fresh BL Backtest ===');
  console.log(`Option B: Re-entry uses WEEKLY stop + WEEKLY exit (apples-to-apples with Fresh BL)`);
  console.log(`Test period: ${TEST_START} → ${TEST_END}`);
  console.log(`Top ${TOP_N} stocks by TTM return per universe`);
  console.log(`Risk per trade: $${RISK_PER_TRADE} on $${STARTING_NAV.toLocaleString()} starting NAV\n`);

  const db = await connectToDatabase();
  if (!db) {
    console.error('Could not connect to MongoDB. Check MONGODB_URI in .env');
    process.exit(1);
  }

  console.log('Loading candle data from MongoDB...');
  const [daily679, daily_ai, weekly679, weekly_ai] = await Promise.all([
    db.collection('pnthr_bt_candles').find({}, { projection: { ticker: 1, daily: 1 } }).toArray(),
    db.collection('pnthr_ai_bt_candles').find({}, { projection: { ticker: 1, daily: 1 } }).toArray(),
    db.collection('pnthr_bt_candles_weekly').find({}, { projection: { ticker: 1, weekly: 1 } }).toArray(),
    db.collection('pnthr_ai_bt_candles_weekly').find({}, { projection: { ticker: 1, weekly: 1 } }).toArray(),
  ]);

  console.log(`Loaded: 679 daily=${daily679.length} weekly=${weekly679.length} | AI daily=${daily_ai.length} weekly=${weekly_ai.length}`);

  const daily679Map  = {};
  const weekly679Map = {};
  const dailyAiMap   = {};
  const weeklyAiMap  = {};

  for (const doc of daily679)  daily679Map[doc.ticker]  = doc.daily  || [];
  for (const doc of weekly679) weekly679Map[doc.ticker] = doc.weekly || [];
  for (const doc of daily_ai)  dailyAiMap[doc.ticker]   = doc.daily  || [];
  for (const doc of weekly_ai) weeklyAiMap[doc.ticker]  = doc.weekly || [];

  // TTM returns → top 100
  console.log('\nComputing TTM returns...');

  const tickers679 = Object.keys(daily679Map);
  const ttm679 = tickers679
    .map(ticker => ({ ticker, ttm: computeTTMReturn(daily679Map[ticker]) }))
    .filter(x => x.ttm !== null)
    .sort((a, b) => b.ttm - a.ttm);
  const top679 = ttm679.slice(0, TOP_N).map(x => x.ticker);
  console.log(`679: ${tickers679.length} tickers → top ${top679.length} (TTM ${pct(ttm679[0]?.ttm || 0)} to ${pct(ttm679[TOP_N - 1]?.ttm || 0)})`);

  const tickersAI = [...AI_TICKERS].filter(t => dailyAiMap[t]);
  const ttmAI = tickersAI
    .map(ticker => ({ ticker, ttm: computeTTMReturn(dailyAiMap[ticker]) }))
    .filter(x => x.ttm !== null)
    .sort((a, b) => b.ttm - a.ttm);
  const topAI = ttmAI.slice(0, TOP_N).map(x => x.ticker);
  console.log(`AI: ${tickersAI.length} tickers → top ${topAI.length} (TTM ${pct(ttmAI[0]?.ttm || 0)} to ${pct(ttmAI[TOP_N - 1]?.ttm || 0)})`);

  // ── Run backtests ──────────────────────────────────────────────────────────
  console.log('\nRunning Fresh BL backtest...');
  const freshBL679Trades = [];
  const freshBLAiTrades  = [];

  for (let i = 0; i < top679.length; i++) {
    const ticker = top679[i];
    const w = shapeWeekly(weekly679Map[ticker] || []);
    freshBL679Trades.push(...runFreshBL(w, ticker));
    if ((i + 1) % 20 === 0) process.stdout.write(`  679 fresh: ${i+1}/${top679.length}\r`);
  }
  console.log(`  679 Fresh BL: ${top679.length} tickers → ${freshBL679Trades.length} trades`);

  for (let i = 0; i < topAI.length; i++) {
    const ticker = topAI[i];
    const w = shapeWeekly(weeklyAiMap[ticker] || []);
    freshBLAiTrades.push(...runFreshBL(w, ticker));
    if ((i + 1) % 20 === 0) process.stdout.write(`  AI fresh: ${i+1}/${topAI.length}\r`);
  }
  console.log(`  AI Fresh BL: ${topAI.length} tickers → ${freshBLAiTrades.length} trades`);

  console.log('\nRunning Re-entry BL Option B backtest...');
  const reentry679Trades = [];
  const reentryAiTrades  = [];

  for (let i = 0; i < top679.length; i++) {
    const ticker = top679[i];
    const w = shapeWeekly(weekly679Map[ticker] || []);
    const d = shapeDaily(daily679Map[ticker] || []);
    reentry679Trades.push(...runReentryB(w, d, ticker));
    if ((i + 1) % 20 === 0) process.stdout.write(`  679 reentry: ${i+1}/${top679.length}\r`);
  }
  console.log(`  679 Re-entry B: ${top679.length} tickers → ${reentry679Trades.length} trades`);

  for (let i = 0; i < topAI.length; i++) {
    const ticker = topAI[i];
    const w = shapeWeekly(weeklyAiMap[ticker] || []);
    const d = shapeDaily(dailyAiMap[ticker] || []);
    reentryAiTrades.push(...runReentryB(w, d, ticker));
    if ((i + 1) % 20 === 0) process.stdout.write(`  AI reentry: ${i+1}/${topAI.length}\r`);
  }
  console.log(`  AI Re-entry B: ${topAI.length} tickers → ${reentryAiTrades.length} trades`);

  // ── Compute metrics ─────────────────────────────────────────────────────────
  console.log('\nComputing metrics...\n');

  const mFresh679   = computeMetrics(freshBL679Trades,  '679 Fresh BL');
  const mReentry679 = computeMetrics(reentry679Trades,  '679 Re-entry B');
  const mFreshAi    = computeMetrics(freshBLAiTrades,   'AI Fresh BL');
  const mReentryAi  = computeMetrics(reentryAiTrades,   'AI Re-entry B');
  const mFreshAll   = computeMetrics([...freshBL679Trades, ...freshBLAiTrades], 'Combined Fresh BL');
  const mReentryAll = computeMetrics([...reentry679Trades, ...reentryAiTrades], 'Combined Re-entry B');

  // ── Print ───────────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  679 UNIVERSE — Fresh BL vs Re-entry BL (Option B)');
  console.log('══════════════════════════════════════════════════════════════════');
  printMetricsTable([mFresh679, mReentry679]);

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  AI 300 UNIVERSE — Fresh BL vs Re-entry BL (Option B)');
  console.log('══════════════════════════════════════════════════════════════════');
  printMetricsTable([mFreshAi, mReentryAi]);

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  COMBINED (679 + AI 300) — Fresh BL vs Re-entry BL (Option B)');
  console.log('══════════════════════════════════════════════════════════════════');
  printMetricsTable([mFreshAll, mReentryAll]);

  // ── Top/Bottom 10 ───────────────────────────────────────────────────────────
  printTopBottom(freshBL679Trades, '679 Fresh BL');
  printTopBottom(reentry679Trades, '679 Re-entry B');
  printTopBottom(freshBLAiTrades,  'AI 300 Fresh BL');
  printTopBottom(reentryAiTrades,  'AI 300 Re-entry B');

  console.log('\n=== Backtest complete ===');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
