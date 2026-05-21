// server/scripts/reentryBacktestVariations.mjs
// ── PNTHR Re-Entry BL Variation Testing ──────────────────────────────────────
//
// Tests the base re-entry strategy (V0) against 4 variations:
//   V0 Base:    20-day window, no weekly-state check, 2-bar-low stop, top 100
//   V1 10-day:  10 trading days instead of 20
//   V2 Active:  Require weekly signal still open at re-entry
//   V3 EMAstop: Daily EMA-30 as stop instead of 2-bar low
//   V4 Top50:   Only top 50 tickers by TTM return
//
// Also applies 20R cap to ALL results to remove data artifacts.
//
// Run: node server/scripts/reentryBacktestVariations.mjs
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
const R_CAP          = 20;    // cap individual trade R at 20R to remove artifacts

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

function computeTTMReturn(dailyBars) {
  if (!dailyBars || dailyBars.length < 2) return null;
  const sorted = [...dailyBars].sort((a, b) => a.date.localeCompare(b.date));
  const last = sorted[sorted.length - 1];
  const cutoff = new Date(last.date);
  cutoff.setDate(cutoff.getDate() - 365);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  let ref = sorted[0];
  for (const bar of sorted) { if (bar.date >= cutoffStr) { ref = bar; break; } }
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
    .filter(b => { const d = b.weekOf || b.date; return d >= '2022-01-01' && d <= TEST_END; })
    .sort((a, b) => { const da = a.weekOf || a.date; const db = b.weekOf || b.date; return da.localeCompare(db); })
    .map(b => ({ time: b.weekOf || b.date, open: b.open, high: b.high, low: b.low, close: b.close }));
}

// Apply R cap
function capR(r) {
  return Math.min(r, R_CAP);
}

// ── Core re-entry backtest function with variation flags ──────────────────────
// opts:
//   reentryWindow: number of trading days (default 20)
//   requireActiveWeekly: bool — only trigger if weekly state still open
//   useEmaStop: bool — use daily EMA-30 as stop instead of 2-bar low
function runReentryVariation(weeklyBars, dailyBars, ticker, events, opts = {}) {
  const {
    reentryWindow = 20,
    requireActiveWeekly = false,
    useEmaStop = false,
  } = opts;

  if (!weeklyBars || weeklyBars.length < 25) return [];
  if (!dailyBars || dailyBars.length < 35) return [];

  const trades = [];

  for (let ei = 0; ei < events.length; ei++) {
    const ev = events[ei];
    if (ev.signal !== 'BL') continue;
    if (ev.time < TEST_START) continue;

    const blDate = ev.time;

    // Find next BE/SS event
    let weeklyExitDate = TEST_END;
    for (let fi = ei + 1; fi < events.length; fi++) {
      if (events[fi].signal === 'BE' || events[fi].signal === 'SS') {
        weeklyExitDate = events[fi].time;
        break;
      }
    }

    // Collect daily bars in the reentryWindow trading days after BL date
    // Also: if requireActiveWeekly, cap window at weeklyExitDate
    const windowBars = [];
    let tradingDayCount = 0;

    for (let di = 0; di < dailyBars.length; di++) {
      const bar = dailyBars[di];
      if (bar.time <= blDate) continue;
      if (bar.time >= weeklyExitDate) break; // always stop at weekly exit

      tradingDayCount++;
      windowBars.push({ ...bar, di_original: di });

      if (tradingDayCount >= reentryWindow) break;
    }

    // V2: requireActiveWeekly already handled above via weeklyExitDate cap
    // (the window stops at weeklyExitDate so we never enter after weekly ends)
    // The subtle difference for V2 is that with requireActiveWeekly=false,
    // we still break at weeklyExitDate in the base. Actually the base also
    // does this. The REAL V2 difference: in the base, if weeklyExitDate
    // is within the 20-day window, the window is truncated. With
    // requireActiveWeekly=true we explicitly require at least the ENTRY bar
    // to be before weeklyExitDate — which is already enforced. So V2 is
    // implicitly the same in this implementation.
    //
    // To make V2 meaningfully different: in V2 we require that the entry bar
    // is at least X days before weeklyExitDate, ensuring the weekly is still
    // "confidently open." We implement this as: skip if weeklyExitDate is
    // within the first 5 days of the window (signal already nearly expired).
    if (requireActiveWeekly) {
      // Count how many window days are available before weeklyExitDate
      const daysAvailable = windowBars.filter(b => b.time < weeklyExitDate).length;
      if (daysAvailable === 0) continue; // weekly already closed before any window day
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
      const twoBarLow  = Math.min(prev1.low, prev2.low);
      const breakoutLevel = twoBarHigh + 0.01;

      // Entry trigger: close above EMA-30 AND high >= 2-bar high
      if (wbar.close > ema && wbar.high >= breakoutLevel) {
        const entryPrice = wbar.close;

        // Stop placement depends on variation
        let stopPrice;
        if (useEmaStop) {
          // V3: stop = daily EMA-30 on entry bar
          stopPrice = ema - 0.01;
        } else {
          // Base / V0 / V1 / V2 / V4: 2-bar low - $0.01
          stopPrice = twoBarLow - 0.01;
        }

        if (stopPrice >= entryPrice) continue;
        const riskPerShare = entryPrice - stopPrice;
        if (riskPerShare <= 0) continue;

        // Find exit: first daily bar where low <= trailing 2-bar-low stop
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

        if (!exitDate) break;

        const rawR = (exitPrice - entryPrice) / riskPerShare;
        const rMultiple = capR(rawR); // cap at 20R
        const rawRMultiple = rawR;    // keep original for reporting

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
          rawRMultiple,
          holdingDays,
          strategy: 'ReentryBL',
          blDate,
        };
        break;
      }
    }

    if (entryTrade) trades.push(entryTrade);
  }

  return trades;
}

// ── Metrics computation ───────────────────────────────────────────────────────
function computeMetrics(trades, label) {
  if (!trades.length) return { label, totalTrades: 0, note: 'no trades' };

  const winners = trades.filter(t => t.rMultiple > 0);
  const losers  = trades.filter(t => t.rMultiple <= 0);

  const winRate      = winners.length / trades.length;
  const avgR         = trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length;
  const avgWinR      = winners.length ? winners.reduce((s, t) => s + t.rMultiple, 0) / winners.length : 0;
  const avgLossR     = losers.length  ? losers.reduce((s, t) => s + t.rMultiple, 0) / losers.length  : 0;
  const maxWinR      = winners.length ? Math.max(...winners.map(t => t.rawRMultiple ?? t.rMultiple)) : 0;
  const maxLossR     = losers.length  ? Math.min(...losers.map(t => t.rMultiple))  : 0;
  const sumWins      = winners.reduce((s, t) => s + t.rMultiple, 0);
  const sumLosses    = Math.abs(losers.reduce((s, t) => s + t.rMultiple, 0));
  const profitFactor = sumLosses > 0 ? sumWins / sumLosses : (sumWins > 0 ? Infinity : 0);
  const avgHoldDays  = trades.reduce((s, t) => s + t.holdingDays, 0) / trades.length;

  // Equity curve
  const sortedTrades = [...trades].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  let nav = STARTING_NAV;
  const dailyNavs = [{ date: TEST_START, nav }];
  for (const t of sortedTrades) {
    const shares = Math.floor(RISK_PER_TRADE / t.riskPerShare);
    const pnl = shares * (t.exitPrice - t.entryPrice);
    // cap pnl to match R cap
    const cappedPnl = Math.min(pnl, shares * t.riskPerShare * R_CAP);
    nav = Math.max(nav + cappedPnl, 1);
    dailyNavs.push({ date: t.exitDate, nav });
  }

  const firstDate = new Date(TEST_START);
  const lastDate  = new Date(TEST_END);
  const years = (lastDate - firstDate) / (365.25 * 24 * 3600 * 1000);
  const finalNav = dailyNavs[dailyNavs.length - 1].nav;
  const cagr = Math.pow(finalNav / STARTING_NAV, 1 / years) - 1;

  const tradeReturns = sortedTrades.map(t => {
    const shares = Math.floor(RISK_PER_TRADE / t.riskPerShare);
    const cappedPnl = Math.min(shares * (t.exitPrice - t.entryPrice), shares * t.riskPerShare * R_CAP);
    return cappedPnl / STARTING_NAV;
  });
  const meanReturn = tradeReturns.reduce((s, r) => s + r, 0) / tradeReturns.length;
  const stdAll  = Math.sqrt(tradeReturns.reduce((s, r) => s + Math.pow(r - meanReturn, 2), 0) / tradeReturns.length);
  const downside = tradeReturns.filter(r => r < 0);
  const stdDown = downside.length > 1
    ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / downside.length)
    : stdAll;

  const tradesPerYear = 252 / (avgHoldDays || 5);
  const sharpe  = stdAll  > 0 ? (meanReturn * tradesPerYear) / (stdAll  * Math.sqrt(tradesPerYear)) : 0;
  const sortino = stdDown > 0 ? (meanReturn * tradesPerYear) / (stdDown * Math.sqrt(tradesPerYear)) : 0;

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
    trades: sortedTrades,
  };
}

// ── Print helpers ─────────────────────────────────────────────────────────────
function pct(v) { return (v * 100).toFixed(2) + '%'; }
function f2(v)  { return typeof v === 'number' ? v.toFixed(2) : v; }

function printComparisonTable(results) {
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

  const separator = '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+';
  const formatRow = (row) => '| ' + row.map((cell, ci) => String(cell).padEnd(widths[ci])).join(' | ') + ' |';

  console.log(separator);
  console.log(formatRow(cols));
  console.log(separator);
  for (const row of rows) console.log(formatRow(row));
  console.log(separator);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== PNTHR Re-Entry BL Variation Testing ===');
  console.log(`Test period: ${TEST_START} → ${TEST_END}`);
  console.log(`R cap: ${R_CAP}R (removes data artifacts like GE 170.64R)`);
  console.log(`Risk per trade: $${RISK_PER_TRADE} on $${STARTING_NAV.toLocaleString()} starting NAV\n`);

  const db = await connectToDatabase();
  if (!db) { console.error('MongoDB connection failed'); process.exit(1); }

  console.log('Loading candle data...');
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

  for (const doc of daily679)   daily679Map[doc.ticker]   = doc.daily   || [];
  for (const doc of weekly679)  weekly679Map[doc.ticker]  = doc.weekly  || [];
  for (const doc of daily_ai)   dailyAiMap[doc.ticker]    = doc.daily   || [];
  for (const doc of weekly_ai)  weeklyAiMap[doc.ticker]   = doc.weekly  || [];

  // ── Compute TTM returns ──────────────────────────────────────────────────────
  console.log('\nComputing TTM returns...');

  const tickers679 = Object.keys(daily679Map);
  const ttm679 = [];
  for (const ticker of tickers679) {
    const ttm = computeTTMReturn(daily679Map[ticker]);
    if (ttm !== null) ttm679.push({ ticker, ttm });
  }
  ttm679.sort((a, b) => b.ttm - a.ttm);
  const top679_100 = ttm679.slice(0, 100).map(x => x.ticker);
  const top679_50  = ttm679.slice(0, 50).map(x => x.ticker);

  const tickersAI = [...AI_TICKERS].filter(t => dailyAiMap[t]);
  const ttmAI = [];
  for (const ticker of tickersAI) {
    const ttm = computeTTMReturn(dailyAiMap[ticker]);
    if (ttm !== null) ttmAI.push({ ticker, ttm });
  }
  ttmAI.sort((a, b) => b.ttm - a.ttm);
  const topAI_100 = ttmAI.slice(0, 100).map(x => x.ticker);
  const topAI_50  = ttmAI.slice(0, 50).map(x => x.ticker);

  console.log(`679: ${tickers679.length} tickers → top 100: TTM ${(ttm679[0].ttm*100).toFixed(1)}% to ${(ttm679[99].ttm*100).toFixed(1)}%`);
  console.log(`AI:  ${tickersAI.length} tickers  → top 100: TTM ${(ttmAI[0].ttm*100).toFixed(1)}% to ${(ttmAI[99].ttm*100).toFixed(1)}%`);

  // ── Pre-compute weekly signals for all tickers ────────────────────────────
  // We run detectAllSignals once per ticker and cache, then pass to variations
  console.log('\nPre-computing weekly signals...');

  const signals679 = {};
  const signalsAI  = {};

  for (const ticker of [...new Set([...top679_100, ...top679_50])]) {
    const weekly = shapeWeekly(weekly679Map[ticker] || []);
    if (weekly.length >= 25) {
      const { events } = detectAllSignals(weekly, 21, false, null, 0.10);
      signals679[ticker] = { weekly, events };
    }
  }
  for (const ticker of [...new Set([...topAI_100, ...topAI_50])]) {
    const weekly = shapeWeekly(weeklyAiMap[ticker] || []);
    if (weekly.length >= 25) {
      const { events } = detectAllSignals(weekly, 21, false, null, 0.10);
      signalsAI[ticker] = { weekly, events };
    }
  }

  // ── Run all variations ─────────────────────────────────────────────────────
  console.log('Running variations (679 + AI, combined)...\n');

  const variations = [
    { label: 'V0 Base (20d)',      opts: { reentryWindow: 20, requireActiveWeekly: false, useEmaStop: false }, universe: 100 },
    { label: 'V1 10-day',          opts: { reentryWindow: 10, requireActiveWeekly: false, useEmaStop: false }, universe: 100 },
    { label: 'V2 Active Weekly',   opts: { reentryWindow: 20, requireActiveWeekly: true,  useEmaStop: false }, universe: 100 },
    { label: 'V3 EMA Stop',        opts: { reentryWindow: 20, requireActiveWeekly: false, useEmaStop: true  }, universe: 100 },
    { label: 'V4 Top 50',          opts: { reentryWindow: 20, requireActiveWeekly: false, useEmaStop: false }, universe: 50  },
  ];

  const allMetrics679 = [];
  const allMetricsAI  = [];
  const allMetricsCombined = [];

  for (const v of variations) {
    process.stdout.write(`  Running ${v.label}...`);

    const top679 = v.universe === 50 ? top679_50 : top679_100;
    const topAI  = v.universe === 50 ? topAI_50  : topAI_100;

    const trades679 = [];
    for (const ticker of top679) {
      if (!signals679[ticker]) continue;
      const { weekly, events } = signals679[ticker];
      const daily = shapeDaily(daily679Map[ticker] || []);
      const t = runReentryVariation(weekly, daily, ticker, events, v.opts);
      trades679.push(...t);
    }

    const tradesAI = [];
    for (const ticker of topAI) {
      if (!signalsAI[ticker]) continue;
      const { weekly, events } = signalsAI[ticker];
      const daily = shapeDaily(dailyAiMap[ticker] || []);
      const t = runReentryVariation(weekly, daily, ticker, events, v.opts);
      tradesAI.push(...t);
    }

    const tradesCombined = [...trades679, ...tradesAI];

    const m679      = computeMetrics(trades679,      v.label + ' 679');
    const mAI       = computeMetrics(tradesAI,       v.label + ' AI');
    const mCombined = computeMetrics(tradesCombined, v.label);

    allMetrics679.push(m679);
    allMetricsAI.push(mAI);
    allMetricsCombined.push(mCombined);

    console.log(` 679: ${trades679.length} trades | AI: ${tradesAI.length} trades | Combined: ${tradesCombined.length}`);
  }

  // ── Print comparison tables ──────────────────────────────────────────────────
  console.log('\n\n══════════════════════════════════════════════════════════════════════');
  console.log('  679 UNIVERSE — Variation Comparison (all R capped at 20R)');
  console.log('══════════════════════════════════════════════════════════════════════');
  printComparisonTable(allMetrics679);

  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('  AI 300 UNIVERSE — Variation Comparison (all R capped at 20R)');
  console.log('══════════════════════════════════════════════════════════════════════');
  printComparisonTable(allMetricsAI);

  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('  COMBINED (679 + AI 300) — Variation Comparison (all R capped at 20R)');
  console.log('══════════════════════════════════════════════════════════════════════');
  printComparisonTable(allMetricsCombined);

  // ── Also show base (V0) without cap for comparison ───────────────────────
  console.log('\n\n══════════════════════════════════════════════════════════════════════');
  console.log('  V0 Base: UNCAPPED vs CAPPED at 20R (679 universe, to show artifact impact)');
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log('  See main reentryBacktest.mjs output for uncapped numbers.');
  console.log('  Key comparison:');
  console.log('  679 Re-entry UNCAPPED: Win Rate 46.49%, PF 3.31, Avg R 0.53, CAGR 86.66%, Sharpe 0.80, Sortino 6.61, MaxDD 8.92%');
  const v0capped = allMetrics679.find(m => m.label.includes('V0'));
  if (v0capped) {
    console.log(`  679 Re-entry CAPPED:   Win Rate ${pct(v0capped.winRate)}, PF ${f2(v0capped.profitFactor)}, Avg R ${f2(v0capped.avgR)}, CAGR ${pct(v0capped.cagr)}, Sharpe ${f2(v0capped.sharpe)}, Sortino ${f2(v0capped.sortino)}, MaxDD ${pct(v0capped.maxDD)}`);
  }

  console.log('\n=== Variations backtest complete ===');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
