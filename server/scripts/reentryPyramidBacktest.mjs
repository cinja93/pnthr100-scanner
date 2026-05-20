// server/scripts/reentryPyramidBacktest.mjs
// ── PNTHR Weekly BL Re-Entry Pyramid Backtest (Walk-Forward, No Look-Ahead Bias) ──
//
// Re-entry strategy: for stocks in the top 50 by TTM where a weekly BL is
// ACTIVE but we are not currently in the trade (missed entry or stopped out),
// we wait for the stock to pull back below the BL signal close, then re-enter
// on the first daily 2-bar high breakout for the remainder of the weekly BL window.
//
// Entry rules (three sequential gates must be met in order):
//   1. Weekly BL signal must be active (between BL date and BE/SS exit date)
//   2. Walk-forward universe: ticker must be in top N by TTM AS OF the BL date
//   3. Gate 1 — Weekly selloff: at least one weekly close < prior week close
//      (confirms the weekly trend took a real breath, not just entering momentum)
//   4. Gate 2 — Daily pullback: after Gate 1, at least one daily LOW < min(prev2 daily lows)
//      (confirms daily chart showed actual weakness, not just consolidation)
//   5. Trigger: after both gates, first daily bar where HIGH > max(prev2 highs) + $0.01
//      → Lot 1 fills at that BUY STOP trigger price
//   Gates 1 and 2 need not occur in the same week but must occur in sequence.
//
// All other mechanics identical to live system:
//   Lot triggers: anchor +0/3/6/10/14% (BUY STOP fills)
//   Lot 2 time-gate: 5 trading days after Lot 1
//   Initial stop: max(2-day-low − $0.01, entry − dailyATR3)
//   Stop ratchet: L3→L1price, L4→L2price, L5→L3price
//   Exit: daily LOW <= current stop
//   Sizing: 1% vitality NAV / rps, 10% ticker cap, 35/25/20/12/8%
//
// Run: node server/scripts/reentryPyramidBacktest.mjs
// ────────────────────────────────────────────────────────────────────────────

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile(p) {
  try {
    const c = fs.readFileSync(p, 'utf8');
    for (const line of c.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[k]) process.env[k] = v;
    }
    return true;
  } catch { return false; }
}
loadEnvFile(path.resolve(__dirname, '../.env')) || loadEnvFile('/Users/cindyeagar/pnthr100-scanner/server/.env');
if (!process.env.MONGODB_URI) { console.error('MONGODB_URI missing'); process.exit(1); }

const { connectToDatabase } = await import('../database.js');
const { detectAllSignals }  = await import('../signalDetection.js');
const { SECTORS }           = await import('./aiUniverse/aiUniverseData.js');

// ── Constants (all mirrored from live code) ──────────────────────────────────
const TEST_START      = '2023-01-01';
const TEST_END        = '2026-05-01';
const STARTING_NAV    = 100_000;
// Sizing uses a fixed NAV throughout. Compounding NAV in a backtest is not
// realistic — the live account grows slowly and positions are not resized every
// bar. A fixed NAV gives an honest per-signal dollar value comparable across
// universes without exponential runaway.
const SIZING_NAV      = 100_000;
const TOP_N           = 50;
const REENTRY_WINDOW  = 20;         // trading days after weekly BL to find Lot 1
const LOT_OFFSETS     = [0, 0.03, 0.06, 0.10, 0.14];
const STRIKE_PCT      = [0.35, 0.25, 0.20, 0.12, 0.08];
const LOT2_TIME_GATE  = 5;          // LOT_TIME_GATES[1] = 5 trading days
const R_CAP           = 20;         // cap individual trade R for reporting only

const AI_TICKERS = new Set();
for (const sec of SECTORS) for (const h of sec.holdings) AI_TICKERS.add(h.ticker);

// ── Helpers ───────────────────────────────────────────────────────────────────
function shapeDaily(rawBars) {
  return rawBars
    .filter(b => b.date >= '2022-01-01' && b.date <= TEST_END)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(b => ({ time: b.date, open: +b.open, high: +b.high, low: +b.low, close: +b.close }));
}
function shapeWeekly(rawBars) {
  return rawBars
    .filter(b => { const d = b.weekOf || b.date; return d >= '2022-01-01' && d <= TEST_END; })
    .sort((a, b) => { const da = a.weekOf||a.date; const db = b.weekOf||b.date; return da.localeCompare(db); })
    .map(b => ({ time: b.weekOf||b.date, open:+b.open, high:+b.high, low:+b.low, close:+b.close }));
}

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

// Wilder ATR(3) on daily bars — mirrors computeWilderATR in stopCalculation.js
function computeDailyATR3(bars, upToIdx) {
  const period = 3;
  const slice = bars.slice(0, upToIdx + 1);
  const n = slice.length;
  if (n < period + 1) return null;
  const trs = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const cur = slice[i], prev = slice[i - 1];
    trs[i] = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
  }
  let atr = 0;
  for (let i = 1; i <= period; i++) atr += trs[i];
  atr /= period;
  for (let i = period + 1; i < n; i++) atr = (atr * 2 + trs[i]) / 3;
  return atr;
}

// blInitStop adapted for daily (mirrors blInitStop in stopCalculation.js)
function dailyBlInitStop(twoBarLow, entryClose, dailyATR) {
  const structural = parseFloat((twoBarLow - 0.01).toFixed(2));
  const atrBased   = dailyATR != null ? parseFloat((entryClose - dailyATR).toFixed(2)) : -Infinity;
  return parseFloat(Math.max(structural, atrBased).toFixed(2));
}

// Count trading days between two indices in dailyBars (exclusive of start index)
function tradingDaysBetween(bars, fromIdx, toIdx) {
  return toIdx - fromIdx; // bars array is all trading days, so index distance = trading days
}

// Walk-forward TTM ranking — same as reentryBacktestWalkForward.mjs
function computeTTMAsOf(sortedBars, asOfDate) {
  let todayIdx = -1;
  for (let i = sortedBars.length - 1; i >= 0; i--) {
    if (sortedBars[i].time <= asOfDate) { todayIdx = i; break; }
  }
  if (todayIdx < 0) return null;
  const todayBar = sortedBars[todayIdx];
  const cutoff = new Date(todayBar.time);
  cutoff.setDate(cutoff.getDate() - 365);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  let refBar = null;
  for (let i = 0; i <= todayIdx; i++) {
    if (sortedBars[i].time >= cutoffStr) { refBar = sortedBars[i]; break; }
  }
  if (!refBar || refBar.time === todayBar.time) return null;
  return (todayBar.close - refBar.close) / refBar.close;
}

function buildRankingCache(allBarsMap) {
  const cache = new Map();
  return function getTopN(asOfDate) {
    if (cache.has(asOfDate)) return cache.get(asOfDate);
    const ranked = [];
    for (const [ticker, bars] of allBarsMap) {
      const ttm = computeTTMAsOf(bars, asOfDate);
      if (ttm !== null) ranked.push({ ticker, ttm });
    }
    ranked.sort((a, b) => b.ttm - a.ttm);
    const top = new Set(ranked.slice(0, TOP_N).map(x => x.ticker));
    cache.set(asOfDate, top);
    return top;
  };
}

// NAV-based sizing (mirrors sizePosition / computeLotTargetShares exactly)
function computeLotShares(entryPrice, stopPrice, nav) {
  const rps        = Math.abs(entryPrice - stopPrice);
  if (rps <= 0) return null;
  const vitality   = nav * 0.01;
  const tickerCap  = nav * 0.10;
  const total      = Math.floor(Math.min(Math.floor(vitality / rps), Math.floor(tickerCap / entryPrice)));
  if (total < 1) return null;
  return STRIKE_PCT.map(pct => Math.max(1, Math.round(total * pct)));
}

// ── Compute weekly PNTHR stop at a given date ────────────────────────────────
// Runs the weekly structural stop ratchet from blDate forward to targetDate.
// Mirrors blInitStop from stopCalculation.js: max(2wkLow − $0.01, close − ATR3).
// Stop only moves UP (ratchet). Returns the stop level as of targetDate.
function computeWeeklyStopAtDate(weeklyBars, blDate, targetDate) {
  // Find the BL signal bar index
  let blIdx = -1;
  for (let i = 0; i < weeklyBars.length; i++) {
    if (weeklyBars[i].time <= blDate) blIdx = i;
    else break;
  }
  if (blIdx < 1) return null;

  // Compute ATR3 at BL bar
  const atrArr = computeDailyATR3(weeklyBars, blIdx); // reuse ATR fn on weekly bars
  const blBar  = weeklyBars[blIdx];
  const prev1W = weeklyBars[blIdx - 1];
  const twoWkLow = Math.min(prev1W.low, blIdx >= 2 ? weeklyBars[blIdx - 2].low : prev1W.low);
  const initStop = parseFloat(Math.max(twoWkLow - 0.01,
    atrArr != null ? blBar.close - atrArr : twoWkLow - 0.01).toFixed(2));

  let currentStop = initStop;

  // Ratchet forward each weekly bar up to targetDate
  for (let i = blIdx + 1; i < weeklyBars.length; i++) {
    const wBar = weeklyBars[i];
    if (wBar.time > targetDate) break;
    if (i < 2) continue;
    const p1 = weeklyBars[i - 1];
    const p2 = weeklyBars[i - 2];
    const wLow = Math.min(p1.low, p2.low);
    const atr  = computeDailyATR3(weeklyBars, i);
    const candidate = parseFloat(Math.max(wLow - 0.01,
      atr != null ? wBar.close - atr : wLow - 0.01).toFixed(2));
    if (candidate > currentStop) currentStop = candidate;
  }

  return currentStop;
}

// ── Core pyramid simulation per (weekly BL, ticker) ─────────────────────────
// gateMode controls the pullback filter applied before the trigger:
//   'none' — no pullback required; fire on first daily 2-bar high breakout after BL
//   'pct1' — require: (1) weekly close down ≥1% from prior week, THEN
//                     (2) a daily LOW below min(prev2 daily lows), THEN trigger
// All other mechanics (sizing, lots, stop ratchet, exit) are identical in both modes.
function simulatePyramid(weeklyBars, dailyBars, blDate, weeklyExitDate, gateMode = 'none') {
  let lot1EntryIdx     = -1;
  let lot1TriggerPrice = null;

  if (gateMode === 'none') {
    // ── No gates: first daily 2-bar high breakout after BL ────────────────
    for (let i = 2; i < dailyBars.length; i++) {
      const bar = dailyBars[i];
      if (bar.time <= blDate) continue;
      if (bar.time >= weeklyExitDate) break;
      const prev1 = dailyBars[i - 1];
      const prev2 = dailyBars[i - 2];
      if (!prev1 || !prev2) continue;
      const trigger = parseFloat((Math.max(prev1.high, prev2.high) + 0.01).toFixed(2));
      if (bar.high >= trigger) {
        lot1EntryIdx = i; lot1TriggerPrice = trigger; break;
      }
    }
  } else {
    // ── Gate 1: first weekly close that is ≥1% below prior week's close ──
    let weeklyPullbackDate = null;
    for (let i = 1; i < weeklyBars.length; i++) {
      const wBar = weeklyBars[i];
      if (wBar.time <= blDate) continue;
      if (wBar.time >= weeklyExitDate) break;
      const dropPct = (weeklyBars[i - 1].close - wBar.close) / weeklyBars[i - 1].close;
      if (dropPct >= 0.01) { weeklyPullbackDate = wBar.time; break; }
    }
    if (!weeklyPullbackDate) return null;

    // ── Gate 2 + Trigger: scan daily bars after the weekly pullback ───────
    let dailyPullbackSeen = false;
    for (let i = 2; i < dailyBars.length; i++) {
      const bar = dailyBars[i];
      if (bar.time <= blDate) continue;
      if (bar.time < weeklyPullbackDate) continue;
      if (bar.time >= weeklyExitDate) break;
      const prev1 = dailyBars[i - 1];
      const prev2 = dailyBars[i - 2];
      if (!prev1 || !prev2) continue;
      if (!dailyPullbackSeen) {
        if (bar.low < Math.min(prev1.low, prev2.low)) dailyPullbackSeen = true;
        continue;
      }
      const trigger = parseFloat((Math.max(prev1.high, prev2.high) + 0.01).toFixed(2));
      if (bar.high >= trigger) {
        lot1EntryIdx = i; lot1TriggerPrice = trigger; break;
      }
    }
  }

  if (lot1EntryIdx < 0) return null;

  const lot1Bar    = dailyBars[lot1EntryIdx];
  const entryPrice = lot1TriggerPrice; // fill at the BUY STOP trigger price

  // Get weekly PNTHR stop ratcheted to the re-entry date
  const weeklyStop = computeWeeklyStopAtDate(weeklyBars, blDate, lot1Bar.time);
  if (weeklyStop === null) return null;
  if (weeklyStop >= entryPrice) return null; // stop above entry — degenerate

  const rps = entryPrice - weeklyStop;
  if (rps <= 0.01) return null;

  const lotShares = computeLotShares(entryPrice, weeklyStop, SIZING_NAV);
  if (!lotShares) return null;

  const anchor        = entryPrice;
  const triggerPrices = LOT_OFFSETS.map(off => parseFloat((anchor * (1 + off)).toFixed(2)));

  const fills = [
    { filled: true,  price: entryPrice, shares: lotShares[0], date: lot1Bar.time },
    { filled: false, price: null,       shares: 0,             date: null },
    { filled: false, price: null,       shares: 0,             date: null },
    { filled: false, price: null,       shares: 0,             date: null },
    { filled: false, price: null,       shares: 0,             date: null },
  ];

  let currentStop      = weeklyStop;
  let cumulativeShares = lotShares[0];
  let cumulativeCost   = lotShares[0] * entryPrice;
  let lot1EntryTradingDay = lot1EntryIdx;

  // Simulate day by day after Lot 1
  for (let i = lot1EntryIdx + 1; i < dailyBars.length; i++) {
    const bar = dailyBars[i];
    if (bar.time > TEST_END)        break;
    if (bar.time >= weeklyExitDate) {
      // BE/SS weekly exit signal fired — close at that day's close
      const exitPrice = bar.close;
      const avgFill   = cumulativeCost / cumulativeShares;
      const pnl       = cumulativeShares * (exitPrice - avgFill);
      return {
        lot1EntryDate: lot1Bar.time, lot1EntryPrice: entryPrice,
        weeklyStop, rps, exitDate: bar.time, exitPrice,
        exitReason: 'BE_SS',
        lotsFilled: fills.filter(f => f.filled).length,
        totalShares: cumulativeShares, avgFill, pnl,
        rMultiple: Math.min((exitPrice - avgFill) / rps, R_CAP),
        rawR: (exitPrice - avgFill) / rps,
      };
    }

    // ── Check exit: weekly stop hit ───────────────────────────────────────
    if (bar.low <= currentStop) {
      const exitPrice = currentStop;
      const avgFill   = cumulativeCost / cumulativeShares;
      const pnl       = cumulativeShares * (exitPrice - avgFill);
      const rMultiple = (exitPrice - avgFill) / rps;
      return {
        lot1EntryDate: lot1Bar.time, lot1EntryPrice: entryPrice,
        weeklyStop, rps, exitDate: bar.time, exitPrice,
        exitReason: 'STOP',
        lotsFilled: fills.filter(f => f.filled).length,
        totalShares: cumulativeShares, avgFill, pnl,
        rMultiple: Math.min(rMultiple, R_CAP),
        rawR: rMultiple,
      };
    }

    // ── Check next lot trigger ──────────────────────────────────────────
    for (let lotIdx = 1; lotIdx < 5; lotIdx++) {
      if (fills[lotIdx].filled) continue;
      const prevFilled = lotIdx === 1 || fills[lotIdx - 1].filled;
      if (!prevFilled) break;

      if (lotIdx === 1) {
        const daysSinceLot1 = tradingDaysBetween(dailyBars, lot1EntryTradingDay, i);
        if (daysSinceLot1 < LOT2_TIME_GATE) continue;
      }

      if (bar.high >= triggerPrices[lotIdx]) {
        const fillPrice = triggerPrices[lotIdx];
        const shares    = lotShares[lotIdx];
        fills[lotIdx]   = { filled: true, price: fillPrice, shares, date: bar.time };
        cumulativeShares += shares;
        cumulativeCost   += shares * fillPrice;

        // Stop ratchet — mirrors enrichLots in sizingUtils.js
        if (lotIdx === 2) {
          currentStop = fills[0].price;
        } else if (lotIdx === 3) {
          // Lot 4 filled → stop = Lot 2 fill price
          currentStop = fills[1].price;
        } else if (lotIdx === 4) {
          // Lot 5 filled → stop = Lot 3 fill price
          currentStop = fills[2].price;
        }
        break; // only one lot per bar
      }
    }
  }

  // Still open at TEST_END — close at last daily bar close
  const lastBar   = dailyBars[dailyBars.length - 1];
  const exitPrice  = lastBar.close;
  const avgFill    = cumulativeCost / cumulativeShares;
  const pnl        = cumulativeShares * (exitPrice - avgFill);
  const rMultiple  = (exitPrice - avgFill) / rps;
  return {
    lot1EntryDate: lot1Bar.time, lot1EntryPrice: entryPrice,
    weeklyStop, rps, exitDate: lastBar.time, exitPrice,
    exitReason: 'END',
    lotsFilled: fills.filter(f => f.filled).length,
    totalShares: cumulativeShares, avgFill, pnl,
    rMultiple: Math.min(rMultiple, R_CAP),
    rawR: rMultiple,
    openAtEnd: true,
  };
}

// ── Metrics ────────────────────────────────────────────────────────────────
function computeMetrics(trades, label) {
  if (!trades.length) return { label, totalTrades: 0, winRate: 0, profitFactor: 0, avgR: 0, avgWinR: 0, avgLossR: 0, cagr: 0, sharpe: 0, sortino: 0, maxDD: 0, calmar: 0, finalNav: STARTING_NAV };

  const sorted   = [...trades].sort((a, b) => a.lot1EntryDate.localeCompare(b.lot1EntryDate));
  const winners  = trades.filter(t => t.rMultiple > 0);
  const losers   = trades.filter(t => t.rMultiple <= 0);

  const winRate      = winners.length / trades.length;
  const avgR         = trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length;
  const avgWinR      = winners.length ? winners.reduce((s, t) => s + t.rMultiple, 0) / winners.length : 0;
  const avgLossR     = losers.length  ? losers.reduce((s, t) => s + t.rMultiple, 0) / losers.length   : 0;
  const maxWinRaw    = trades.length  ? Math.max(...trades.map(t => t.rawR)) : 0;
  const sumWins      = winners.reduce((s, t) => s + t.rMultiple, 0);
  const sumLosses    = Math.abs(losers.reduce((s, t) => s + t.rMultiple, 0));
  const profitFactor = sumLosses > 0 ? sumWins / sumLosses : (sumWins > 0 ? Infinity : 0);

  // Equity curve from actual PnL
  let nav = STARTING_NAV;
  const navPoints = [{ date: TEST_START, nav }];
  for (const t of sorted) {
    nav = Math.max(nav + t.pnl, 1);
    navPoints.push({ date: t.exitDate, nav });
  }
  const finalNav = navPoints[navPoints.length - 1].nav;
  const years    = (new Date(TEST_END) - new Date(TEST_START)) / (365.25 * 24 * 3600 * 1000);
  const cagr     = Math.pow(finalNav / STARTING_NAV, 1 / years) - 1;

  // Trade-level returns as % of fixed sizing NAV (for Sharpe/Sortino)
  const tradeRets = sorted.map(t => t.pnl / SIZING_NAV);
  const mean      = tradeRets.reduce((s, r) => s + r, 0) / tradeRets.length;
  const std       = Math.sqrt(tradeRets.reduce((s, r) => s + (r - mean) ** 2, 0) / tradeRets.length);
  const downside  = tradeRets.filter(r => r < 0);
  const stdDown   = downside.length > 1 ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / downside.length) : std;

  const avgHoldDays = sorted.reduce((s, t) => {
    const days = (new Date(t.exitDate) - new Date(t.lot1EntryDate)) / (24 * 3600 * 1000);
    return s + days;
  }, 0) / sorted.length;
  const tradesPerYear = 252 / Math.max(avgHoldDays, 1);

  const sharpe  = std     > 0 ? (mean * tradesPerYear) / (std     * Math.sqrt(tradesPerYear)) : 0;
  const sortino = stdDown > 0 ? (mean * tradesPerYear) / (stdDown * Math.sqrt(tradesPerYear)) : 0;

  let peak = STARTING_NAV, maxDD = 0;
  for (const { nav: n } of navPoints) {
    if (n > peak) peak = n;
    const dd = (peak - n) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const avgLotsFilled = trades.reduce((s, t) => s + t.lotsFilled, 0) / trades.length;

  return {
    label, totalTrades: trades.length, winRate, profitFactor,
    avgR, avgWinR, avgLossR, maxWinRaw,
    avgHoldDays, cagr, sharpe, sortino, maxDD,
    calmar: maxDD > 0 ? cagr / maxDD : 0,
    finalNav, avgLotsFilled,
    totalProfit: finalNav - STARTING_NAV,
    annualProfit: (finalNav - STARTING_NAV) / years,
  };
}

// ── Print ─────────────────────────────────────────────────────────────────────
function pct(v) { return (v * 100).toFixed(2) + '%'; }
function f2(v)  { return typeof v === 'number' ? v.toFixed(2) : String(v); }

function printTable(results) {
  const cols = ['Metric', ...results.map(r => r.label)];
  const rows = [
    ['Total Trades',      ...results.map(r => r.totalTrades)],
    ['Win Rate',          ...results.map(r => pct(r.winRate || 0))],
    ['Profit Factor',     ...results.map(r => f2(r.profitFactor))],
    ['Avg R',             ...results.map(r => f2(r.avgR))],
    ['Avg Win R',         ...results.map(r => f2(r.avgWinR))],
    ['Avg Loss R',        ...results.map(r => f2(r.avgLossR))],
    ['Max Win R (raw)',   ...results.map(r => f2(r.maxWinRaw))],
    ['Avg Lots Filled',   ...results.map(r => f2(r.avgLotsFilled))],
    ['Avg Holding Days',  ...results.map(r => f2(r.avgHoldDays))],
    ['CAGR',              ...results.map(r => pct(r.cagr || 0))],
    ['Sharpe',            ...results.map(r => f2(r.sharpe))],
    ['Sortino',           ...results.map(r => f2(r.sortino))],
    ['Max Drawdown',      ...results.map(r => pct(r.maxDD || 0))],
    ['Calmar',            ...results.map(r => f2(r.calmar))],
    ['Final NAV',         ...results.map(r => '$' + Math.round(r.finalNav).toLocaleString())],
    ['Total Profit $',    ...results.map(r => '$' + Math.round(r.totalProfit).toLocaleString())],
    ['Annual Profit $',   ...results.map(r => '$' + Math.round(r.annualProfit).toLocaleString())],
  ];
  const widths = cols.map((c, ci) => {
    let max = c.length;
    for (const row of rows) if (String(row[ci]).length > max) max = String(row[ci]).length;
    return max;
  });
  const sep = '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+';
  const fmt = row => '| ' + row.map((cell, ci) => String(cell).padEnd(widths[ci])).join(' | ') + ' |';
  console.log(sep); console.log(fmt(cols)); console.log(sep);
  for (const row of rows) console.log(fmt(row));
  console.log(sep);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== PNTHR Re-Entry Universe Size Sweep ===');
  console.log(`Period: ${TEST_START} → ${TEST_END}  |  Starting NAV: $${STARTING_NAV.toLocaleString()}`);
  console.log(`Testing TOP_N = 10, 25, 50, 75, 100, 150, 200`);
  console.log(`Combined (679 + AI 300) results for each size\n`);

  const db = await connectToDatabase();
  if (!db) { console.error('MongoDB failed'); process.exit(1); }

  console.log('Loading candle data...');
  const [daily679, daily_ai, weekly679, weekly_ai] = await Promise.all([
    db.collection('pnthr_bt_candles').find({}, { projection: { ticker: 1, daily: 1 } }).toArray(),
    db.collection('pnthr_ai_bt_candles').find({}, { projection: { ticker: 1, daily: 1 } }).toArray(),
    db.collection('pnthr_bt_candles_weekly').find({}, { projection: { ticker: 1, weekly: 1 } }).toArray(),
    db.collection('pnthr_ai_bt_candles_weekly').find({}, { projection: { ticker: 1, weekly: 1 } }).toArray(),
  ]);
  console.log(`679: daily=${daily679.length} weekly=${weekly679.length} | AI: daily=${daily_ai.length} weekly=${weekly_ai.length}`);

  const daily679Map  = new Map(daily679.map(d => [d.ticker, shapeDaily(d.daily || [])]));
  const dailyAiMap   = new Map(daily_ai.map(d => [d.ticker, shapeDaily(d.daily || [])]));
  const weekly679Map = new Map(weekly679.map(d => [d.ticker, shapeWeekly(d.weekly || [])]));
  const weeklyAiMap  = new Map(weekly_ai.map(d => [d.ticker, shapeWeekly(d.weekly || [])]));

  const aiTickerSet = new Set([...AI_TICKERS].filter(t => dailyAiMap.has(t)));

  // Walk-forward ranking functions
  const getTopN679 = buildRankingCache(daily679Map);
  const getTopNAI  = buildRankingCache(new Map([...dailyAiMap].filter(([t]) => aiTickerSet.has(t))));

  // Pre-compute weekly signals — store events AND weekly bars together
  console.log('Pre-computing weekly signals...');
  const signals679 = new Map(); // ticker → { events, weekly }
  const signalsAI  = new Map();
  for (const [ticker, weekly] of weekly679Map) {
    if (weekly.length >= 25) {
      const { events } = detectAllSignals(weekly, 21, false, null, 0.10);
      signals679.set(ticker, { events, weekly });
    }
  }
  for (const ticker of aiTickerSet) {
    const weekly = weeklyAiMap.get(ticker);
    if (weekly && weekly.length >= 25) {
      const { events } = detectAllSignals(weekly, 21, false, null, 0.10);
      signalsAI.set(ticker, { events, weekly });
    }
  }
  console.log(`Signals: 679=${signals679.size}  AI=${signalsAI.size}\n`);

  // ── Run universes ──────────────────────────────────────────────────────────
  function buildBlEvents(sigMap, dailyMap) {
    const blEvents = [];
    for (const [ticker, { events, weekly }] of sigMap) {
      const daily = dailyMap.get(ticker);
      if (!daily || daily.length < 35) continue;
      for (let ei = 0; ei < events.length; ei++) {
        const ev = events[ei];
        if (ev.signal !== 'BL' || ev.time < TEST_START) continue;
        let weeklyExitDate = TEST_END;
        for (let fi = ei + 1; fi < events.length; fi++) {
          if (events[fi].signal === 'BE' || events[fi].signal === 'SS') {
            weeklyExitDate = events[fi].time; break;
          }
        }
        blEvents.push({ ticker, blDate: ev.time, weeklyExitDate, daily, weekly });
      }
    }
    blEvents.sort((a, b) => a.blDate.localeCompare(b.blDate));
    return blEvents;
  }

  async function runUniverse(blEvents, getTopN, label, gateMode) {
    const allTrades = [];
    let processed = 0;
    for (const { ticker, blDate, weeklyExitDate, daily, weekly } of blEvents) {
      const topOnDate = getTopN(blDate);
      if (!topOnDate.has(ticker)) continue;
      const result = simulatePyramid(weekly, daily, blDate, weeklyExitDate, gateMode);
      if (!result) continue;
      allTrades.push({ ticker, ...result });
      processed++;
      if (processed % 100 === 0) process.stdout.write(`  ${label}: ${processed} trades...\n`);
    }
    return allTrades;
  }

  function getTopNSized(dailyMap, n) {
    const c = new Map();
    return function(asOfDate) {
      if (c.has(asOfDate)) return c.get(asOfDate);
      const ranked = [];
      for (const [ticker, bars] of dailyMap) {
        const ttm = computeTTMAsOf(bars, asOfDate);
        if (ttm !== null) ranked.push({ ticker, ttm });
      }
      ranked.sort((a, b) => b.ttm - a.ttm);
      const top = new Set(ranked.slice(0, n).map(x => x.ticker));
      c.set(asOfDate, top);
      return top;
    };
  }

  const UNIVERSE_SIZES = [10, 25, 50, 75, 100, 150, 200];
  const blEvents679 = buildBlEvents(signals679, daily679Map);
  const blEventsAI  = buildBlEvents(signalsAI,  dailyAiMap);

  const aiDailyMapFiltered = new Map([...dailyAiMap].filter(([t]) => aiTickerSet.has(t)));

  const MODES = [
    { key: 'none', label: 'NO GATE — Fire on first daily 2-bar high breakout after BL' },
    { key: 'pct1', label: '1% WEEKLY DROP GATE — Require ≥1% weekly selloff + daily low undercut first' },
  ];

  for (const mode of MODES) {
    const sweepResults = [];
    console.log(`\n\nRunning strategy: ${mode.label}`);

    for (const n of UNIVERSE_SIZES) {
      process.stdout.write(`  TOP ${n}... `);
      const topN679 = getTopNSized(daily679Map,        n);
      const topNAI  = getTopNSized(aiDailyMapFiltered, n);
      const trades679 = await runUniverse(blEvents679, topN679, '679', mode.key);
      const tradesAI  = await runUniverse(blEventsAI,  topNAI,  'AI',  mode.key);
      const combined  = [...trades679, ...tradesAI];
      const m = computeMetrics(combined, `Top ${n}`);
      sweepResults.push(m);
      console.log(`679:${trades679.length} AI:${tradesAI.length} Total:${combined.length} | WinRate:${(m.winRate*100).toFixed(1)}% PF:${m.profitFactor.toFixed(2)} Sharpe:${m.sharpe.toFixed(2)} AnnProfit:$${Math.round(m.annualProfit).toLocaleString()}`);
    }

    console.log(`\n${'═'.repeat(100)}`);
    console.log(`  ${mode.label}`);
    console.log(`  Combined 679 + AI 300 | Walk-Forward | Fixed $100K NAV | ${TEST_START} → ${TEST_END}`);
    console.log(`${'═'.repeat(100)}`);
    printTable(sweepResults);
  }

  console.log('\n=== Sweep complete ===');
  process.exit(0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
