// server/scripts/mceBacktest.mjs
// ── PNTHR Momentum Continuation Entry (MCE) Backtest ──────────────────────────
//
// Entry: active weekly BL + first daily 2-bar high breakout (no pullback gate)
// Universe: top 100 TTM-ranked (walk-forward) from 679 AND AI 300 separately
// Pyramid: 5 lots at anchor +0/3/6/10/14%, share split 35/25/20/12/8%
// Sizing: compounding NAV — 1% of current NAV / RPS, 10% NAV cap
// Stop: max(min(prev2 weekly lows) − $0.01, weeklyClose − weeklyATR3), ratchet up only
// Stop ratchet on fills: L3→L1 price, L4→L2 price, L5→L3 price
// Exit: daily low ≤ stop → stop price
//       BE event → min(prev2 weekly lows) − $0.01
//       SS event → max(prev2 weekly highs) + $0.01
//       TEST_END → last daily close
//
// Test A: L2 has 5 trading-day time gate after L1
// Test B: No time gate — L2 eligible immediately after L1
//
// Run: node server/scripts/mceBacktest.mjs
// ─────────────────────────────────────────────────────────────────────────────

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

// ── Constants ─────────────────────────────────────────────────────────────────
const TEST_START     = '2023-01-01';
const TEST_END       = '2026-05-01';
const STARTING_NAV   = 100_000;
const TOP_N          = 100;
const LOT_OFFSETS    = [0, 0.03, 0.06, 0.10, 0.14];
const STRIKE_PCT     = [0.35, 0.25, 0.20, 0.12, 0.08];
const LOT2_TIME_GATE = 5;   // trading days — used in Test A only
const R_CAP          = 20;

const AI_TICKERS = new Set();
for (const sec of SECTORS) for (const h of sec.holdings) AI_TICKERS.add(h.ticker);

// ── Bar shapers ───────────────────────────────────────────────────────────────
function shapeDaily(rawBars) {
  return rawBars
    .filter(b => b.date >= '2022-01-01' && b.date <= TEST_END)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(b => ({ time: b.date, open: +b.open, high: +b.high, low: +b.low, close: +b.close }));
}
function shapeWeekly(rawBars) {
  return rawBars
    .filter(b => { const d = b.weekOf || b.date; return d >= '2022-01-01' && d <= TEST_END; })
    .sort((a, b) => { const da = a.weekOf||a.date, db = b.weekOf||b.date; return da.localeCompare(db); })
    .map(b => ({ time: b.weekOf||b.date, open:+b.open, high:+b.high, low:+b.low, close:+b.close }));
}

// ── Wilder ATR(3) on any bar array ───────────────────────────────────────────
function computeATR3(bars, upToIdx) {
  const slice = bars.slice(0, upToIdx + 1);
  const n = slice.length;
  if (n < 4) return null;
  const trs = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const c = slice[i], p = slice[i - 1];
    trs[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  let atr = (trs[1] + trs[2] + trs[3]) / 3;
  for (let i = 4; i < n; i++) atr = (atr * 2 + trs[i]) / 3;
  return atr;
}

// ── Walk-forward TTM ranking ───────────────────────────────────────────────────
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

function buildRankingCache(dailyMap) {
  const cache = new Map();
  return function getTop100(asOfDate) {
    if (cache.has(asOfDate)) return cache.get(asOfDate);
    const ranked = [];
    for (const [ticker, bars] of dailyMap) {
      const ttm = computeTTMAsOf(bars, asOfDate);
      if (ttm !== null) ranked.push({ ticker, ttm });
    }
    ranked.sort((a, b) => b.ttm - a.ttm);
    const top = new Set(ranked.slice(0, TOP_N).map(x => x.ticker));
    cache.set(asOfDate, top);
    return top;
  };
}

// ── Weekly stop: max(min(prev2 lows) − 0.01, close − ATR3), ratcheted ────────
function computeWeeklyStop(weeklyBars, blDate, targetDate) {
  let blIdx = -1;
  for (let i = 0; i < weeklyBars.length; i++) {
    if (weeklyBars[i].time <= blDate) blIdx = i;
    else break;
  }
  if (blIdx < 2) return null;

  const blBar   = weeklyBars[blIdx];
  const p1      = weeklyBars[blIdx - 1];
  const p2      = weeklyBars[blIdx - 2];
  const twoLow  = Math.min(p1.low, p2.low);
  const atr0    = computeATR3(weeklyBars, blIdx);
  const struct  = parseFloat((twoLow - 0.01).toFixed(2));
  const atrStop = atr0 != null ? parseFloat((blBar.close - atr0).toFixed(2)) : -Infinity;
  let stop      = parseFloat(Math.max(struct, atrStop).toFixed(2));

  for (let i = blIdx + 1; i < weeklyBars.length; i++) {
    const wBar = weeklyBars[i];
    if (wBar.time > targetDate) break;
    if (i < 2) continue;
    const wp1    = weeklyBars[i - 1];
    const wp2    = weeklyBars[i - 2];
    const wLow   = Math.min(wp1.low, wp2.low);
    const atr    = computeATR3(weeklyBars, i);
    const cand   = parseFloat(Math.max(
      wLow - 0.01,
      atr != null ? wBar.close - atr : wLow - 0.01
    ).toFixed(2));
    if (cand > stop) stop = cand;
  }
  return stop;
}

// ── Exact BE/SS exit price from weekly bars at the exit date ──────────────────
function getWeeklyExitPrice(weeklyBars, exitDate, exitSignal) {
  let idx = -1;
  for (let i = 0; i < weeklyBars.length; i++) {
    if (weeklyBars[i].time <= exitDate) idx = i;
    else break;
  }
  if (idx < 2) return null;
  const p1 = weeklyBars[idx - 1];
  const p2 = weeklyBars[idx - 2];
  if (exitSignal === 'BE') return parseFloat((Math.min(p1.low, p2.low) - 0.01).toFixed(2));
  if (exitSignal === 'SS') return parseFloat((Math.max(p1.high, p2.high) + 0.01).toFixed(2));
  return null;
}

// ── Lot sizing from current NAV ───────────────────────────────────────────────
function computeLotShares(entryPrice, stopPrice, nav) {
  const rps      = Math.abs(entryPrice - stopPrice);
  if (rps <= 0) return null;
  const total    = Math.floor(Math.min(
    Math.floor((nav * 0.01) / rps),
    Math.floor((nav * 0.10) / entryPrice)
  ));
  if (total < 1) return null;
  return STRIKE_PCT.map(pct => Math.max(1, Math.round(total * pct)));
}

// ── Core simulation ───────────────────────────────────────────────────────────
function simulatePyramid(weeklyBars, dailyBars, blDate, weeklyExitDate, weeklyExitSignal, nav, hasL2Gate) {
  // Find L1: first daily 2-bar high breakout after BL date
  let lot1Idx = -1, lot1Trigger = null;
  for (let i = 2; i < dailyBars.length; i++) {
    const bar = dailyBars[i];
    if (bar.time <= blDate)        continue;
    if (bar.time >= weeklyExitDate) break;
    const p1 = dailyBars[i - 1], p2 = dailyBars[i - 2];
    const trigger = parseFloat((Math.max(p1.high, p2.high) + 0.01).toFixed(2));
    if (bar.high >= trigger) { lot1Idx = i; lot1Trigger = trigger; break; }
  }
  if (lot1Idx < 0) return null;

  const lot1Bar    = dailyBars[lot1Idx];
  const entryPrice = lot1Trigger;

  // Weekly stop ratcheted to L1 entry date
  const initStop = computeWeeklyStop(weeklyBars, blDate, lot1Bar.time);
  if (initStop === null || initStop >= entryPrice) return null;
  const rps = parseFloat((entryPrice - initStop).toFixed(2));
  if (rps <= 0.01) return null;

  const lotShares = computeLotShares(entryPrice, initStop, nav);
  if (!lotShares) return null;

  const triggerPrices = LOT_OFFSETS.map(off => parseFloat((entryPrice * (1 + off)).toFixed(2)));

  const fills = [
    { filled: true,  price: entryPrice, shares: lotShares[0], date: lot1Bar.time },
    { filled: false, price: null, shares: 0, date: null },
    { filled: false, price: null, shares: 0, date: null },
    { filled: false, price: null, shares: 0, date: null },
    { filled: false, price: null, shares: 0, date: null },
  ];

  let currentStop      = initStop;
  let cumShares        = lotShares[0];
  let cumCost          = lotShares[0] * entryPrice;

  function closeOut(exitPrice, exitReason, exitDate) {
    const avgFill   = cumCost / cumShares;
    const pnl       = cumShares * (exitPrice - avgFill);
    const rawR      = (exitPrice - avgFill) / rps;
    return {
      lot1EntryDate: lot1Bar.time, lot1EntryPrice: entryPrice,
      initStop, rps, exitDate, exitPrice, exitReason,
      lotsFilled: fills.filter(f => f.filled).length,
      totalShares: cumShares, avgFill, pnl,
      rMultiple: Math.min(rawR, R_CAP), rawR,
    };
  }

  for (let i = lot1Idx + 1; i < dailyBars.length; i++) {
    const bar = dailyBars[i];
    if (bar.time > TEST_END) break;

    // ── Weekly exit signal reached ────────────────────────────────────────
    if (bar.time >= weeklyExitDate) {
      const exitPrice = getWeeklyExitPrice(weeklyBars, weeklyExitDate, weeklyExitSignal)
        ?? bar.close;
      return closeOut(exitPrice, weeklyExitSignal, bar.time);
    }

    // ── Stop hit ─────────────────────────────────────────────────────────
    if (bar.low <= currentStop) return closeOut(currentStop, 'STOP', bar.time);

    // ── Lot triggers ──────────────────────────────────────────────────────
    for (let li = 1; li < 5; li++) {
      if (fills[li].filled) continue;
      if (li > 1 && !fills[li - 1].filled) break;
      if (li === 1 && hasL2Gate) {
        const daysSince = i - lot1Idx;
        if (daysSince < LOT2_TIME_GATE) continue;
      }
      if (bar.high >= triggerPrices[li]) {
        const fp    = triggerPrices[li];
        const sh    = lotShares[li];
        fills[li]   = { filled: true, price: fp, shares: sh, date: bar.time };
        cumShares  += sh;
        cumCost    += sh * fp;
        // Stop ratchet on lot fill
        if (li === 2) currentStop = fills[0].price;
        else if (li === 3) currentStop = fills[1].price;
        else if (li === 4) currentStop = fills[2].price;
        break;
      }
    }

    // ── Weekly stop ratchet (check each Monday/start of new week) ─────────
    // Re-compute weekly stop as of this daily bar's date and advance if higher
    const newStop = computeWeeklyStop(weeklyBars, blDate, bar.time);
    if (newStop !== null && newStop > currentStop) currentStop = newStop;
  }

  // Still open at TEST_END
  const last = dailyBars[dailyBars.length - 1];
  return closeOut(last.close, 'END', last.time);
}

// ── Metrics (compounding NAV already in pnl, derive % stats from that) ────────
function computeMetrics(trades, label) {
  if (!trades.length) return {
    label, totalTrades: 0, winRate: 0, profitFactor: 0,
    avgR: 0, avgWinR: 0, avgLossR: 0, cagr: 0, sharpe: 0,
    sortino: 0, maxDD: 0, calmar: 0, finalNav: STARTING_NAV,
    avgLotsFilled: 0, avgHoldDays: 0, totalProfit: 0, annualProfit: 0,
  };

  const sorted  = [...trades].sort((a, b) => a.lot1EntryDate.localeCompare(b.lot1EntryDate));
  const winners = trades.filter(t => t.rMultiple > 0);
  const losers  = trades.filter(t => t.rMultiple <= 0);

  const winRate      = winners.length / trades.length;
  const avgR         = trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length;
  const avgWinR      = winners.length ? winners.reduce((s, t) => s + t.rMultiple, 0) / winners.length : 0;
  const avgLossR     = losers.length  ? losers.reduce((s, t)  => s + t.rMultiple, 0) / losers.length  : 0;
  const maxWinRaw    = trades.length  ? Math.max(...trades.map(t => t.rawR)) : 0;
  const sumWins      = winners.reduce((s, t) => s + t.rMultiple, 0);
  const sumLosses    = Math.abs(losers.reduce((s, t) => s + t.rMultiple, 0));
  const profitFactor = sumLosses > 0 ? sumWins / sumLosses : (sumWins > 0 ? Infinity : 0);

  // Equity curve using actual compounded P&L
  let nav = STARTING_NAV;
  const navPoints = [{ date: TEST_START, nav }];
  for (const t of sorted) {
    nav = Math.max(nav + t.pnl, 1);
    navPoints.push({ date: t.exitDate, nav });
  }
  const finalNav = navPoints[navPoints.length - 1].nav;
  const years    = (new Date(TEST_END) - new Date(TEST_START)) / (365.25 * 24 * 3600 * 1000);
  const cagr     = Math.pow(finalNav / STARTING_NAV, 1 / years) - 1;

  // Sharpe/Sortino using trade-level returns as % of NAV at entry
  const tradeRets = sorted.map(t => t.pnl / STARTING_NAV);
  const mean      = tradeRets.reduce((s, r) => s + r, 0) / tradeRets.length;
  const std       = Math.sqrt(tradeRets.reduce((s, r) => s + (r - mean) ** 2, 0) / tradeRets.length);
  const downside  = tradeRets.filter(r => r < 0);
  const stdDown   = downside.length > 1
    ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / downside.length)
    : std;
  const avgHold   = sorted.reduce((s, t) =>
    s + (new Date(t.exitDate) - new Date(t.lot1EntryDate)) / (24 * 3600 * 1000), 0) / sorted.length;
  const tpy       = 252 / Math.max(avgHold, 1);
  const sharpe    = std     > 0 ? (mean * tpy) / (std     * Math.sqrt(tpy)) : 0;
  const sortino   = stdDown > 0 ? (mean * tpy) / (stdDown * Math.sqrt(tpy)) : 0;

  let peak = STARTING_NAV, maxDD = 0;
  for (const { nav: n } of navPoints) {
    if (n > peak) peak = n;
    const dd = (peak - n) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    label, totalTrades: trades.length, winRate, profitFactor,
    avgR, avgWinR, avgLossR, maxWinRaw,
    avgHoldDays: avgHold, cagr, sharpe, sortino, maxDD,
    calmar: maxDD > 0 ? cagr / maxDD : 0,
    finalNav, avgLotsFilled: trades.reduce((s, t) => s + t.lotsFilled, 0) / trades.length,
    totalProfit: finalNav - STARTING_NAV,
    annualProfit: (finalNav - STARTING_NAV) / years,
  };
}

// ── Print ─────────────────────────────────────────────────────────────────────
function pct(v)  { return (v * 100).toFixed(2) + '%'; }
function f2(v)   { return typeof v === 'number' ? v.toFixed(2) : String(v); }
function usd(v)  { return '$' + Math.round(v).toLocaleString(); }

function printTable(results) {
  const cols = ['Metric', ...results.map(r => r.label)];
  const rows = [
    ['Total Trades',     ...results.map(r => r.totalTrades)],
    ['Win Rate',         ...results.map(r => pct(r.winRate || 0))],
    ['Profit Factor',    ...results.map(r => f2(r.profitFactor))],
    ['Avg R',            ...results.map(r => f2(r.avgR))],
    ['Avg Win R',        ...results.map(r => f2(r.avgWinR))],
    ['Avg Loss R',       ...results.map(r => f2(r.avgLossR))],
    ['Max Win R (raw)',  ...results.map(r => f2(r.maxWinRaw))],
    ['Avg Lots Filled',  ...results.map(r => f2(r.avgLotsFilled))],
    ['Avg Hold Days',    ...results.map(r => f2(r.avgHoldDays))],
    ['CAGR',             ...results.map(r => pct(r.cagr || 0))],
    ['Sharpe',           ...results.map(r => f2(r.sharpe))],
    ['Sortino',          ...results.map(r => f2(r.sortino))],
    ['Max Drawdown',     ...results.map(r => pct(r.maxDD || 0))],
    ['Calmar',           ...results.map(r => f2(r.calmar))],
    ['Final NAV',        ...results.map(r => usd(r.finalNav))],
    ['Total Profit',     ...results.map(r => usd(r.totalProfit))],
    ['Annual Profit',    ...results.map(r => usd(r.annualProfit))],
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
  console.log('=== PNTHR Momentum Continuation Entry (MCE) Backtest — AI 300 Only ===');
  console.log(`Period : ${TEST_START} → ${TEST_END}`);
  console.log(`Universe: Top ${TOP_N} TTM-ranked walk-forward | AI 300 only`);
  console.log(`NAV    : $${STARTING_NAV.toLocaleString()} compounding (AI 300 P&L only)`);
  console.log(`Tests  : A = L2 has 5-day time gate | B = no L2 time gate\n`);

  const db = await connectToDatabase();
  if (!db) { console.error('MongoDB connection failed'); process.exit(1); }

  console.log('Loading candles...');
  const [daily679, dailyAI, weekly679, weeklyAI] = await Promise.all([
    db.collection('pnthr_bt_candles').find({}, { projection: { ticker: 1, daily: 1 } }).toArray(),
    db.collection('pnthr_ai_bt_candles').find({}, { projection: { ticker: 1, daily: 1 } }).toArray(),
    db.collection('pnthr_bt_candles_weekly').find({}, { projection: { ticker: 1, weekly: 1 } }).toArray(),
    db.collection('pnthr_ai_bt_candles_weekly').find({}, { projection: { ticker: 1, weekly: 1 } }).toArray(),
  ]);
  console.log(`679 : daily=${daily679.length} weekly=${weekly679.length}`);
  console.log(`AI  : daily=${dailyAI.length}  weekly=${weeklyAI.length}\n`);

  const daily679Map  = new Map(daily679.map(d => [d.ticker, shapeDaily(d.daily || [])]));
  const dailyAIMap   = new Map(dailyAI.map(d => [d.ticker, shapeDaily(d.daily || [])]));
  const weekly679Map = new Map(weekly679.map(d => [d.ticker, shapeWeekly(d.weekly || [])]));
  const weeklyAIMap  = new Map(weeklyAI.map(d => [d.ticker, shapeWeekly(d.weekly || [])]));

  const aiSet = new Set([...AI_TICKERS].filter(t => dailyAIMap.has(t)));
  const dailyAIFiltered = new Map([...dailyAIMap].filter(([t]) => aiSet.has(t)));

  const getTop679 = buildRankingCache(daily679Map);
  const getTopAI  = buildRankingCache(dailyAIFiltered);

  // Pre-compute weekly BL events for each universe
  console.log('Pre-computing weekly signals...');

  function buildBlEvents(weeklyMap, dailyMap, tickerFilter) {
    const events = [];
    for (const [ticker, weekly] of weeklyMap) {
      if (tickerFilter && !tickerFilter.has(ticker)) continue;
      const daily = dailyMap.get(ticker);
      if (!weekly || weekly.length < 25 || !daily || daily.length < 35) continue;
      const { events: sigs } = detectAllSignals(weekly, 21, false, null, 0.10);
      for (let ei = 0; ei < sigs.length; ei++) {
        const ev = sigs[ei];
        if (ev.signal !== 'BL' || ev.time < TEST_START) continue;
        let exitDate   = TEST_END;
        let exitSignal = 'END';
        for (let fi = ei + 1; fi < sigs.length; fi++) {
          if (sigs[fi].signal === 'BE' || sigs[fi].signal === 'SS') {
            exitDate   = sigs[fi].time;
            exitSignal = sigs[fi].signal;
            break;
          }
        }
        events.push({ ticker, blDate: ev.time, exitDate, exitSignal, daily, weekly });
      }
    }
    return events.sort((a, b) => a.blDate.localeCompare(b.blDate));
  }

  const blEvents679 = buildBlEvents(weekly679Map, daily679Map, null);
  const blEventsAI  = buildBlEvents(weeklyAIMap,  dailyAIMap,  aiSet);
  console.log(`BL events — 679: ${blEvents679.length}  AI: ${blEventsAI.length}\n`);

  // ── Run one test configuration ─────────────────────────────────────────────
  async function runTest(label, hasL2Gate) {
    console.log(`Running ${label} (L2 gate: ${hasL2Gate ? 'YES — 5 days' : 'NO'})...`);

    // Compounding NAV: track closed trades by exitDate so sizing uses NAV
    // as of each trade's L1 entry (sum of P&L from trades closed before that date)
    let closedTrades = [];

    function navAtDate(date) {
      const pnl = closedTrades
        .filter(t => t.exitDate < date)
        .reduce((s, t) => s + t.pnl, 0);
      return Math.max(STARTING_NAV + pnl, 1);
    }

    // AI 300 only — own compounding NAV, no 679 dilution
    const allEvents = [
      ...blEventsAI.map(e => ({ ...e, fund: 'AI 300', getTop: getTopAI })),
    ].sort((a, b) => a.blDate.localeCompare(b.blDate));

    let count = 0;
    for (const ev of allEvents) {
      const topOnDate = ev.getTop(ev.blDate);
      if (!topOnDate.has(ev.ticker)) continue;

      const nav    = navAtDate(ev.blDate);
      const result = simulatePyramid(
        ev.weekly, ev.daily,
        ev.blDate, ev.exitDate, ev.exitSignal,
        nav, hasL2Gate
      );
      if (!result) continue;

      closedTrades.push({ ...result, ticker: ev.ticker, fund: ev.fund });
      count++;
      if (count % 200 === 0) process.stdout.write(`  ${label}: ${count} trades...\n`);
    }

    const trades679 = closedTrades.filter(t => t.fund === '679');
    const tradesAI  = closedTrades.filter(t => t.fund === 'AI 300');
    console.log(`  ${label} done: 679=${trades679.length} AI=${tradesAI.length} Total=${closedTrades.length}`);
    return closedTrades;
  }

  const tradesA = await runTest('Test A (L2 gate)', true);
  const tradesB = await runTest('Test B (no gate)', false);

  // ── Results ────────────────────────────────────────────────────────────────
  const metA = computeMetrics(tradesA, 'A — w/ L2 gate');
  const metB = computeMetrics(tradesB, 'B — no L2 gate');

  console.log(`\n${'═'.repeat(90)}`);
  console.log('  MCE — AI 300 Top 100 Walk-Forward | Compounding $100K NAV');
  console.log(`${'═'.repeat(90)}`);
  printTable([metA, metB]);

  process.exit(0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
