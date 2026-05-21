// server/backtest/ai300MceSimulator.js
// ── PNTHR AI Elite Fund — Multi-Strategy + MCE Backtest Simulator ──────────
//
// IDENTICAL to ai300MultiStrategySimulator.js (base strategy unchanged) PLUS:
//   Momentum Continuation Entry (MCE) — daily 2-bar high breakout on active
//   weekly BL signals for tickers NOT currently held AND in TTM top 100.
//   MCE entries do NOT re-check regime or sector rotation (BL already validated).
//   MCE positions use standard 1.0 sector mult and the same 5-lot pyramid.
//   Tagged tradeType='MCE' vs 'WEEKLY_DIRECT' for separate reporting.
//
// Base strategy (unchanged):
//   AI 300 tickers (272): AI sector EMA (30-40W), 1.25× gate, PAI300, sector rotation
//   Carnivore tickers (26): GICS OpEMA (18-26W), 1.10× gate, SPY+QQQ, no rotation
//
// Usage: cd server && node backtest/ai300MceSimulator.js [--nav 100000]
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { connectToDatabase } from '../database.js';
import { computeWilderATR } from '../stopCalculation.js';
import { detectAllSignals, calculateEMA, blInitStop, ssInitStop } from '../signalDetection.js';
import { calcCommission, calcSlippage } from './costEngine.js';
import { SECTORS } from '../scripts/aiUniverse/aiUniverseData.js';
import { SECTOR_EMA_PERIODS } from '../data/pnthrAiSectorsConfig.js';
import { isCarnivoreMode, getCarnivoreEmaPeriod, CARNIVORE_GATE_OFFSET } from '../data/strategyMode.js';

// ── CLI ────────────────────────────────────────────────────────────────────
const NAV_ARG = process.argv.find(a => a.startsWith('--nav='));
const STARTING_NAV = NAV_ARG ? parseInt(NAV_ARG.split('=')[1]) : (parseInt(process.argv[process.argv.indexOf('--nav') + 1]) || 1000000);
const navLabel = STARTING_NAV >= 1000000 ? `${STARTING_NAV / 1000000}m` : `${STARTING_NAV / 1000}k`;

// ── Constants ──────────────────────────────────────────────────────────────
const AI_GATE_OFFSET    = 0.25;
const C679_GATE_OFFSET  = CARNIVORE_GATE_OFFSET;  // 0.10 — stricter 679 gate
const REGIME_EMA_PERIOD = 21;                      // SPY/QQQ 21W EMA for 679 regime
const BACKTEST_START    = '2022-01-03';
const ADV_ARG = process.argv.find(a => a.startsWith('--adv='));
const ADV_CAP_PCT       = ADV_ARG ? parseFloat(ADV_ARG.split('=')[1]) : 0.02;  // default 2% of 20-day ADV
const LOT_PCT           = [0.35, 0.25, 0.20, 0.12, 0.08];
const LOT_NAMES         = ['The Scent', 'The Stalk', 'The Strike', 'The Jugular', 'The Kill'];
const LOT_OFFSET_PCT    = [0, 0.03, 0.06, 0.10, 0.14];
const TIME_GATE_DAYS    = 5;
const PAI300_EMA_PERIOD = 36;
// APEX v7: scouts disabled — weekly-only entry
const GO_TOP            = 6;
const NEUT_TOP          = 12;
const MCE_TOP_N         = 100;  // TTM top-100 ranking for MCE eligibility

// AI-sector borrow rates
const AI_BORROW_RATES = {
  1: 0.010, 2: 0.015, 3: 0.012, 4: 0.015, 5: 0.015,
  6: 0.010, 7: 0.010, 8: 0.010, 9: 0.015, 10: 0.010,
  11: 0.010, 12: 0.010, 13: 0.015, 14: 0.020, 15: 0.020,
  16: 0.015,
};

// Build ticker → sector info lookup
const TICKER_META = {};
for (const sec of SECTORS) {
  for (const h of sec.holdings) {
    TICKER_META[h.ticker] = { sectorId: sec.id, sectorName: sec.name };
  }
}
const ALL_TICKERS = Object.keys(TICKER_META);

// ── Position sizing ───────────────────────────────────────────────────────
function sizePositionNav(nav, entryPrice, stopPrice, sectorMult = 1.0) {
  const tickerCap = nav * 0.10;
  const vitality  = nav * 0.01 * sectorMult;
  const rps = Math.abs(entryPrice - stopPrice);
  if (rps <= 0 || entryPrice <= 0) return 0;
  return Math.floor(Math.min(Math.floor(vitality / rps), Math.floor(tickerCap / entryPrice)));
}

// ── Helpers ────────────────────────────────────────────────────────────────
function getMondayOf(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const dow = d.getDay();
  const daysToMon = dow === 0 ? -6 : 1 - dow;
  const m = new Date(d);
  m.setDate(d.getDate() + daysToMon);
  return m.toISOString().split('T')[0];
}

function isFriday(dateStr) {
  return new Date(dateStr + 'T12:00:00').getDay() === 5;
}

// Simple EMA on close values
function emaValues(closes, period) {
  const k = 2 / (period + 1);
  const result = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    result.push(closes[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function computeWeeklyStopCandidate(weekly, atrArr, weekIdx, signal, currentStop) {
  if (weekIdx < 3 || !atrArr[weekIdx - 1]) return currentStop;
  const prev1 = weekly[weekIdx - 1];
  const prev2 = weekly[weekIdx - 2];
  const twoWeekHigh = Math.max(prev1.high, prev2.high);
  const twoWeekLow  = Math.min(prev1.low, prev2.low);
  const prevAtr = atrArr[weekIdx - 1];
  if (signal === 'BL') {
    const struct = parseFloat((twoWeekLow - 0.01).toFixed(2));
    const atrFloor = parseFloat((prev1.close - prevAtr).toFixed(2));
    return parseFloat(Math.max(currentStop, Math.max(struct, atrFloor)).toFixed(2));
  } else {
    const struct = parseFloat((twoWeekHigh + 0.01).toFixed(2));
    const atrCeil = parseFloat((prev1.close + prevAtr).toFixed(2));
    return parseFloat(Math.min(currentStop, Math.min(struct, atrCeil)).toFixed(2));
  }
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('Cannot connect to MongoDB'); process.exit(1); }

  console.log('═'.repeat(80));
  console.log('  PNTHR AI ELITE FUND — MULTI-STRATEGY + MCE BACKTEST');
  console.log(`  Starting NAV:   $${STARTING_NAV.toLocaleString()}`);
  console.log(`  Universe:       ${ALL_TICKERS.length} AI 300 names (multi-strategy)`);
  console.log(`  Period:         ${BACKTEST_START} → latest bar (EMA warmup → first trades mid-2023)`);
  console.log(`  Base entry:     Friday signal → Monday open fill → 5-lot pyramid`);
  console.log(`  MCE entry:      Daily 2-bar high breakout on active weekly BL, TTM top ${MCE_TOP_N}`);
  console.log(`  MCE dedup:      Held tickers use NAV gap only (current 1% − original 1%)`);
  console.log(`  AI 300 tickers: AI sector EMA (30-40W), 1.25× gate, PAI300 regime, sector rotation`);
  console.log(`  679 tickers:    GICS OpEMA (18-26W), 1.10× gate, SPY+QQQ regime, no sector rotation`);
  console.log(`  Volume cap:     ${(ADV_CAP_PCT * 100)}% of 20-day ADV per lot fill`);
  console.log(`  Stop fills:     Gap-through → fill at open (realistic slippage)`);
  console.log('═'.repeat(80));

  // ── 1. Load PAI300 index for regime gate ─────────────────────────────────
  console.log('\n[1/5] Loading PAI300 index...');
  const pai300Doc = await db.collection('pnthr_ai_index_candles_weekly').findOne({ ticker: 'PAI300' });
  if (!pai300Doc?.weekly?.length) { console.error('No PAI300 weekly data'); process.exit(1); }
  const pai300Weekly = [...pai300Doc.weekly].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  const pai300Closes = pai300Weekly.map(b => b.close);
  const pai300Ema = emaValues(pai300Closes, PAI300_EMA_PERIOD);
  const pai300RegimeByWeek = {};
  for (let i = 0; i < pai300Weekly.length; i++) {
    pai300RegimeByWeek[pai300Weekly[i].weekOf] = {
      close: pai300Closes[i],
      ema: pai300Ema[i],
      aboveEma: pai300Closes[i] > pai300Ema[i],
    };
  }
  console.log(`  ${pai300Weekly.length} weekly bars, EMA period ${PAI300_EMA_PERIOD}`);

  // ── 1b. Load SPY + QQQ for carnivore regime gate ────────────────────────
  console.log('  Loading SPY/QQQ for carnivore regime gate...');
  const spyDoc = await db.collection('pnthr_candles_weekly').findOne({ ticker: 'SPY' });
  const qqqDoc = await db.collection('pnthr_candles_weekly').findOne({ ticker: 'QQQ' });
  const spyWeekly = spyDoc?.weekly ? [...spyDoc.weekly].sort((a, b) => a.weekOf.localeCompare(b.weekOf)) : [];
  const qqqWeekly = qqqDoc?.weekly ? [...qqqDoc.weekly].sort((a, b) => a.weekOf.localeCompare(b.weekOf)) : [];

  function buildRegimeMap(weekly) {
    const closes = weekly.map(b => b.close);
    const ema = emaValues(closes, REGIME_EMA_PERIOD);
    const map = {};
    for (let i = 0; i < weekly.length; i++) {
      map[weekly[i].weekOf] = { close: closes[i], ema: ema[i], aboveEma: closes[i] > ema[i] };
    }
    return map;
  }
  const spyRegimeByWeek = buildRegimeMap(spyWeekly);
  const qqqRegimeByWeek = buildRegimeMap(qqqWeekly);
  console.log(`  SPY: ${spyWeekly.length} bars, QQQ: ${qqqWeekly.length} bars`);

  // ── 2. Load sector rotation ranks ────────────────────────────────────────
  console.log('[2/5] Loading sector rotation ranks...');
  const sectorRankDocs = await db.collection('pnthr_ai_sector_rank_daily')
    .find({}).sort({ date: 1 }).toArray();
  const sectorRankByDate = {};
  for (const doc of sectorRankDocs) {
    const tierMap = {};
    for (const r of doc.ranks) {
      tierMap[r.sectorId] = r.rank <= GO_TOP ? 'GO' : r.rank <= NEUT_TOP ? 'NEUTRAL' : 'NO_GO';
    }
    sectorRankByDate[doc.date] = tierMap;
  }
  const sectorRankDates = Object.keys(sectorRankByDate).sort();
  console.log(`  ${sectorRankDates.length} daily rank records`);

  function getSectorTierOnDate(sectorId, date) {
    for (let i = sectorRankDates.length - 1; i >= 0; i--) {
      if (sectorRankDates[i] <= date) return sectorRankByDate[sectorRankDates[i]][sectorId] || 'NEUTRAL';
    }
    return 'NEUTRAL';
  }

  function getSectorMult(tier, signal) {
    if (signal === 'BL') {
      if (tier === 'GO') return 1.25;
      if (tier === 'NEUTRAL') return 1.0;
      return 0;
    } else {
      if (tier === 'NO_GO') return 1.25;
      if (tier === 'NEUTRAL') return 1.0;
      return 0;
    }
  }

  // ── 3. Load all AI candle data ───────────────────────────────────────────
  console.log('[3/5] Loading AI 300 candle data...');
  const dailyDocs = await db.collection('pnthr_ai_bt_candles')
    .find({ ticker: { $in: ALL_TICKERS } }).toArray();
  const weeklyDocs = await db.collection('pnthr_ai_bt_candles_weekly')
    .find({ ticker: { $in: ALL_TICKERS } }).toArray();

  const dailyCandleMap = {};
  const weeklyCandleMap = {};
  const weeklyAtrMap = {};

  for (const doc of dailyDocs) {
    dailyCandleMap[doc.ticker] = [...(doc.daily || [])].sort((a, b) => a.date.localeCompare(b.date));
  }
  for (const doc of weeklyDocs) {
    const sorted = [...(doc.weekly || [])].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
    weeklyCandleMap[doc.ticker] = sorted;
    const barsForAtr = sorted.map(b => ({ high: b.high, low: b.low, close: b.close }));
    weeklyAtrMap[doc.ticker] = computeWilderATR(barsForAtr);
  }
  console.log(`  Daily: ${Object.keys(dailyCandleMap).length} tickers`);
  console.log(`  Weekly: ${Object.keys(weeklyCandleMap).length} tickers`);

  // ── 4. Pre-compute signals ───────────────────────────────────────────────
  // Run detectAllSignals ONCE per ticker on full history for both daily and
  // weekly. Extract event timelines indexed by date for O(1) lookups.
  console.log('[4/5] Pre-computing daily + weekly signals...');

  // weeklySignalEvents[ticker] = [{ time, signal: 'BL'|'SS'|'BE'|'SE', ... }]
  const weeklySignalEvents = {};
  // dailySignalEvents[ticker] = [{ time, signal: 'BL'|'SS'|'BE'|'SE', ... }]
  const dailySignalEvents = {};
  // weeklyEmaByTicker[ticker] = { [weekOf]: emaValue }
  const weeklyEmaByTicker = {};
  // dailyAtrByTicker[ticker] = atrArr[]
  const dailyAtrByTicker = {};

  let totalWeeklyEvents = 0, totalDailyEvents = 0;

  let carnivoreCount = 0, ai300Count = 0;
  for (const ticker of ALL_TICKERS) {
    const meta = TICKER_META[ticker];
    const isCarnivore = isCarnivoreMode(ticker);
    // Carnivore tickers use GICS sector-optimized EMA (18-26W)
    // AI 300 tickers use AI sector EMA (30-40W)
    const period = isCarnivore
      ? (getCarnivoreEmaPeriod(ticker) || 21)
      : (SECTOR_EMA_PERIODS[meta.sectorId] || 30);
    const gateOffset = isCarnivore ? C679_GATE_OFFSET : AI_GATE_OFFSET;
    if (isCarnivore) carnivoreCount++; else ai300Count++;

    // Weekly signals
    const weekly = weeklyCandleMap[ticker];
    if (weekly && weekly.length >= period * 3) {
      const wBars = weekly.map(b => ({
        time: b.weekOf, open: b.open, high: b.high, low: b.low, close: b.close,
      }));
      const result = detectAllSignals(wBars, period, false, null, gateOffset);
      weeklySignalEvents[ticker] = result.events || [];
      totalWeeklyEvents += weeklySignalEvents[ticker].length;

      // Pre-compute weekly EMA values for combo [6] filter
      const emaData = calculateEMA(wBars, period);
      const emaMap = {};
      for (const e of emaData) emaMap[e.time] = e.value;
      weeklyEmaByTicker[ticker] = emaMap;
    }

    // Daily signals (0.3% daylight zone per locked params)
    const daily = dailyCandleMap[ticker];
    if (daily && daily.length >= period * 3) {
      const dBars = daily.map(b => ({
        time: b.date, open: b.open, high: b.high, low: b.low, close: b.close,
      }));
      const result = detectAllSignals(dBars, period, false, 0.003, gateOffset);
      dailySignalEvents[ticker] = result.events || [];
      totalDailyEvents += dailySignalEvents[ticker].length;

      // Daily ATR (retained for potential future use)
      dailyAtrByTicker[ticker] = computeWilderATR(dBars);
    }
  }
  console.log(`  Strategy split: ${carnivoreCount} carnivore (679 rules) + ${ai300Count} AI 300 rules`);
  console.log(`  Weekly events: ${totalWeeklyEvents} across ${Object.keys(weeklySignalEvents).length} tickers`);
  console.log(`  Daily events:  ${totalDailyEvents} across ${Object.keys(dailySignalEvents).length} tickers`);

  // Index events by date for fast lookup
  // weeklyEventsByDate[date][ticker] = event
  const weeklyEventsByDate = {};
  for (const [ticker, events] of Object.entries(weeklySignalEvents)) {
    for (const ev of events) {
      if (!weeklyEventsByDate[ev.time]) weeklyEventsByDate[ev.time] = {};
      weeklyEventsByDate[ev.time][ticker] = ev;
    }
  }
  const dailyEventsByDate = {};
  for (const [ticker, events] of Object.entries(dailySignalEvents)) {
    for (const ev of events) {
      if (!dailyEventsByDate[ev.time]) dailyEventsByDate[ev.time] = {};
      dailyEventsByDate[ev.time][ticker] = ev;
    }
  }

  // ── 5. Build trading calendar ────────────────────────────────────────────
  console.log('[5/5] Running APEX v7 + Sector Rotation + MCE simulation...\n');
  const allDailyDates = new Set();
  for (const ticker of ALL_TICKERS) {
    const daily = dailyCandleMap[ticker];
    if (!daily) continue;
    for (const b of daily) {
      if (b.date >= BACKTEST_START) allDailyDates.add(b.date);
    }
  }
  const tradingDays = [...allDailyDates].sort();
  console.log(`  ${tradingDays.length} trading days\n`);

  // ── Simulation state ─────────────────────────────────────────────────────
  const fullPositions = new Map();    // ticker → full weekly position
  const closedTrades = [];
  let totalWeeklyOpened = 0;
  let totalMceOpened = 0;
  let totalMceGapAdds = 0;
  let pendingEntries = [];            // staged Friday → execute Monday at open

  // ── MCE state ───────────────────────────────────────────────────────────
  const activeWeeklySignal = {};      // ticker → 'BL'|'SS'|null (most recent weekly signal)
  let currentTtmTop100 = new Set();
  let lastTtmComputeWeek = null;

  function computeTtmReturn(ticker, date) {
    const daily = dailyCandleMap[ticker];
    if (!daily || daily.length < 253) return -Infinity;
    let todayIdx = -1;
    for (let i = daily.length - 1; i >= 0; i--) {
      if (daily[i].date <= date) { todayIdx = i; break; }
    }
    if (todayIdx < 252) return -Infinity;
    const yearAgoIdx = todayIdx - 252;
    const todayClose = daily[todayIdx].close;
    const yearAgoClose = daily[yearAgoIdx].close;
    if (!yearAgoClose || yearAgoClose <= 0) return -Infinity;
    return (todayClose - yearAgoClose) / yearAgoClose;
  }

  function recomputeTtmTop100(date) {
    const ranked = [];
    for (const ticker of ALL_TICKERS) {
      const ttm = computeTtmReturn(ticker, date);
      if (ttm > -Infinity) ranked.push({ ticker, ttm });
    }
    ranked.sort((a, b) => b.ttm - a.ttm);
    return new Set(ranked.slice(0, MCE_TOP_N).map(x => x.ticker));
  }

  function getDailyTwoBarHigh(ticker, date) {
    const daily = dailyCandleMap[ticker];
    if (!daily) return null;
    let idx = -1;
    for (let i = daily.length - 1; i >= 0; i--) {
      if (daily[i].date === date) { idx = i; break; }
    }
    if (idx < 2) return null;
    const prev1High = daily[idx - 1].high;
    const prev2High = daily[idx - 2].high;
    const twoBarHigh = Math.max(prev1High, prev2High);
    const trigger = parseFloat((twoBarHigh + 0.01).toFixed(2));
    return { trigger, todayBar: daily[idx] };
  }

  // Combo [6] filter: above weekly EMA + slope 0–50% annualized + gap 5–15%
  function passesCombo6(ticker, date, dailyClose, signal) {
    const emaMap = weeklyEmaByTicker[ticker];
    if (!emaMap) return false;

    // Find the most recent weekly EMA value on or before this date
    const weekly = weeklyCandleMap[ticker];
    if (!weekly) return false;
    let weeklyEmaVal = null;
    let prevWeeklyEmaVal = null;
    for (let i = weekly.length - 1; i >= 0; i--) {
      if (weekly[i].weekOf <= date) {
        weeklyEmaVal = emaMap[weekly[i].weekOf];
        if (i > 0) prevWeeklyEmaVal = emaMap[weekly[i - 1].weekOf];
        break;
      }
    }
    if (weeklyEmaVal == null) return false;

    if (signal === 'BL') {
      // 1. Price above weekly EMA
      if (dailyClose <= weeklyEmaVal) return false;

      // 2. EMA slope 0–50% annualized
      if (prevWeeklyEmaVal != null && prevWeeklyEmaVal > 0) {
        const weeklySlope = (weeklyEmaVal - prevWeeklyEmaVal) / prevWeeklyEmaVal;
        const annualized = weeklySlope * 52 * 100; // annualized %
        if (annualized < 0 || annualized > 50) return false;
      }

      // 3. Gap 5–15% above EMA
      const gap = (dailyClose - weeklyEmaVal) / weeklyEmaVal * 100;
      if (gap < 5 || gap > 15) return false;

      return true;
    } else {
      // SS mirror
      if (dailyClose >= weeklyEmaVal) return false;

      if (prevWeeklyEmaVal != null && prevWeeklyEmaVal > 0) {
        const weeklySlope = (weeklyEmaVal - prevWeeklyEmaVal) / prevWeeklyEmaVal;
        const annualized = weeklySlope * 52 * 100;
        if (annualized > 0 || annualized < -50) return false;
      }

      const gap = (weeklyEmaVal - dailyClose) / weeklyEmaVal * 100;
      if (gap < 5 || gap > 15) return false;

      return true;
    }
  }

  // Helper: 20-day average daily volume for a ticker on a given date
  function getAdv20(ticker, date) {
    const daily = dailyCandleMap[ticker];
    if (!daily) return Infinity;
    const idx = daily.findIndex(b => b.date >= date);
    if (idx < 0) return Infinity;
    const start = Math.max(0, idx - 20);
    const slice = daily.slice(start, idx + 1).filter(c => c.volume > 0);
    if (slice.length === 0) return Infinity;
    return slice.reduce((s, c) => s + c.volume, 0) / slice.length;
  }

  // Helper: close a position and compute P&L
  function closePosition(pos, exitDate, exitPrice, exitReason) {
    if (pos.closed) return;
    pos.exitDate = exitDate;
    pos.exitPrice = parseFloat(exitPrice.toFixed(4));
    pos.exitReason = exitReason;
    pos.closed = true;

    let totalGross = 0;
    for (const lot of pos.lots) {
      const lotGross = pos.signal === 'BL'
        ? (pos.exitPrice - lot.fillPrice) * lot.shares
        : (lot.fillPrice - pos.exitPrice) * lot.shares;
      lot.grossDollarPnl = parseFloat(lotGross.toFixed(2));
      totalGross += lotGross;
    }

    pos.grossDollarPnl = parseFloat(totalGross.toFixed(2));
    pos.grossProfitPct = pos.avgCost > 0
      ? parseFloat(((pos.signal === 'BL'
          ? (pos.exitPrice - pos.avgCost) / pos.avgCost
          : (pos.avgCost - pos.exitPrice) / pos.avgCost) * 100).toFixed(2))
      : 0;
    pos.isWinner = pos.grossDollarPnl > 0;
  }

  function applyExitCosts(pos) {
    if (!pos.exitPrice || !pos.lots) return;
    let totalComm = 0, totalSlip = 0, totalBorrow = 0;

    for (const lot of pos.lots) {
      const exitComm = calcCommission(lot.shares, pos.exitPrice);
      const exitSlip = calcSlippage(lot.shares, pos.exitPrice);

      let borrowCost = 0;
      if (pos.signal === 'SS') {
        const entryDate = new Date(lot.fillDate + 'T12:00:00');
        const exitDateObj = new Date(pos.exitDate + 'T12:00:00');
        const calDays = Math.max(1, Math.round((exitDateObj - entryDate) / 86400000));
        const tradDays = Math.max(1, Math.round(calDays * 0.71));
        const borrowRate = AI_BORROW_RATES[pos.sectorId] || 0.015;
        borrowCost = parseFloat((lot.shares * lot.fillPrice * borrowRate / 252 * tradDays).toFixed(2));
      }

      lot.exitComm = exitComm;
      lot.exitSlip = exitSlip;
      lot.borrowCost = borrowCost;
      lot.totalLotFriction = parseFloat(((lot.entryComm || 0) + (lot.entrySlip || 0) + exitComm + exitSlip + borrowCost).toFixed(2));
      lot.netDollarPnl = parseFloat((lot.grossDollarPnl - lot.totalLotFriction).toFixed(2));

      totalComm += (lot.entryComm || 0) + exitComm;
      totalSlip += (lot.entrySlip || 0) + exitSlip;
      totalBorrow += borrowCost;
    }

    pos.commissionTotal = parseFloat(totalComm.toFixed(2));
    pos.slippageTotal = parseFloat(totalSlip.toFixed(2));
    pos.borrowCostTotal = parseFloat(totalBorrow.toFixed(2));
    pos.totalFrictionDollar = parseFloat((totalComm + totalSlip + totalBorrow).toFixed(2));
    pos.netDollarPnl = parseFloat(((pos.grossDollarPnl || 0) - pos.totalFrictionDollar).toFixed(2));
    pos.netProfitPct = pos.avgCost > 0
      ? parseFloat((pos.netDollarPnl / (pos.totalShares * pos.avgCost) * 100).toFixed(2))
      : 0;
    pos.netIsWinner = pos.netDollarPnl > 0;
  }

  // ── Day-by-day simulation ────────────────────────────────────────────────
  let dayCount = 0;
  let lastFriday = null;
  let cumulativeRealizedPnl = 0;

  // ── Capital constraint: real cash ledger ────────────────────────────────
  let availableCash = STARTING_NAV;
  let totalSkippedForCash = 0;
  let totalLotsSkippedForCash = 0;
  let peakDeployed = 0;
  let peakPositionCount = 0;

  function getCurrentNav(date) {
    let unrealizedPnl = 0;
    for (const [ticker, pos] of fullPositions) {
      if (pos.closed) continue;
      const daily = dailyCandleMap[ticker];
      if (!daily) continue;
      let closePrice = pos.entryPrice;
      for (let i = daily.length - 1; i >= 0; i--) {
        if (daily[i].date <= date) { closePrice = daily[i].close; break; }
      }
      for (const lot of pos.lots) {
        if (pos.signal === 'BL') unrealizedPnl += (closePrice - lot.fillPrice) * lot.shares;
        else unrealizedPnl += (lot.fillPrice - closePrice) * lot.shares;
      }
    }
    return STARTING_NAV + cumulativeRealizedPnl + unrealizedPnl;
  }

  for (const date of tradingDays) {
    dayCount++;
    const currentFriday = isFriday(date) ? date : null;
    const mondayStr = getMondayOf(date);

    // Find PAI300 regime for this week (AI 300 tickers)
    let pai300Bull = true;
    for (let i = pai300Weekly.length - 1; i >= 0; i--) {
      if (pai300Weekly[i].weekOf <= mondayStr) {
        pai300Bull = pai300RegimeByWeek[pai300Weekly[i].weekOf]?.aboveEma ?? true;
        break;
      }
    }

    // Find SPY+QQQ regime for this week (carnivore tickers — both must be above 21W EMA)
    let spyBull = true, qqqBull = true;
    for (let i = spyWeekly.length - 1; i >= 0; i--) {
      if (spyWeekly[i].weekOf <= mondayStr) { spyBull = spyRegimeByWeek[spyWeekly[i].weekOf]?.aboveEma ?? true; break; }
    }
    for (let i = qqqWeekly.length - 1; i >= 0; i--) {
      if (qqqWeekly[i].weekOf <= mondayStr) { qqqBull = qqqRegimeByWeek[qqqWeekly[i].weekOf]?.aboveEma ?? true; break; }
    }
    const c679Bull = spyBull && qqqBull;  // 679 requires BOTH above EMA

    // ── MCE: Update active weekly signals + TTM ranking on new week ─────
    if (mondayStr !== lastTtmComputeWeek) {
      lastTtmComputeWeek = mondayStr;
      const weeklyEvents = weeklyEventsByDate[mondayStr] || {};
      for (const [ticker, wev] of Object.entries(weeklyEvents)) {
        if (wev.signal === 'BL' || wev.signal === 'SS') {
          activeWeeklySignal[ticker] = wev.signal;
        } else if (wev.signal === 'BE' || wev.signal === 'SE') {
          activeWeeklySignal[ticker] = null;
        }
      }
      currentTtmTop100 = recomputeTtmTop100(date);
    }

    // ── A0. Execute pending Monday entries at today's open ──────────────
    if (pendingEntries.length > 0) {
      const executed = [];
      for (const cand of pendingEntries) {
        const { ticker, signal, meta, sectorTier, sectorMult, weekIdx, stopPrice, fullShares, weekOf } = cand;
        if (fullPositions.has(ticker)) continue;

        const daily = dailyCandleMap[ticker];
        if (!daily) continue;
        const bar = daily.find(b => b.date === date);
        if (!bar) continue;

        const entryPrice = bar.open;
        if (entryPrice <= 0) continue;

        // Re-size based on Monday open price (stop unchanged from Friday calc)
        const currentNav = getCurrentNav(date);
        const resizedShares = sizePositionNav(currentNav, entryPrice, stopPrice, sectorMult);
        if (resizedShares <= 0) continue;

        const lotShares = LOT_PCT.map(pct => Math.max(1, Math.round(resizedShares * pct)));
        const lotTriggers = LOT_OFFSET_PCT.map((off) =>
          signal === 'BL'
            ? parseFloat((entryPrice * (1 + off)).toFixed(2))
            : parseFloat((entryPrice * (1 - off)).toFixed(2))
        );

        // ADV cap on Lot 1
        const advMax = Math.floor(getAdv20(ticker, date) * ADV_CAP_PCT);
        let lot1Shares = Math.min(lotShares[0], advMax > 0 ? advMax : lotShares[0]);
        if (lot1Shares <= 0) continue;

        // Capital constraint: can we afford this?
        const lot1Cost = lot1Shares * entryPrice;
        if (availableCash < lot1Cost) { totalSkippedForCash++; continue; }
        availableCash -= lot1Cost;

        const l1Comm = calcCommission(lot1Shares, entryPrice);
        const l1Slip = calcSlippage(lot1Shares, entryPrice);

        fullPositions.set(ticker, {
          ticker, signal, sectorId: meta.sectorId, sectorName: meta.sectorName,
          sectorTier, sectorMult, weekOf, entryDate: date,
          navTier: currentNav, entryPrice, initialStop: stopPrice, stop: stopPrice,
          vitalityCommitted: currentNav * 0.01 * sectorMult,
          lastMceGapDay: -Infinity,
          lots: [{
            lot: 1, name: LOT_NAMES[0], pct: LOT_PCT[0],
            fillDate: date, fillPrice: entryPrice,
            shares: lot1Shares, lotValue: parseFloat((lot1Shares * entryPrice).toFixed(2)),
            tradingDayAtFill: 0, entryComm: l1Comm, entrySlip: l1Slip,
          }],
          lotShares, lotTriggers,
          totalShares: lot1Shares, totalCost: lot1Shares * entryPrice, avgCost: entryPrice,
          tradingDays: 0, lastCheckedDate: date,
          currentWeekIdx: weekIdx, mfe: 0, mae: 0,
          closed: false, exitDate: null, exitPrice: null, exitReason: null,
          tradeType: 'WEEKLY_DIRECT',
        });
        totalWeeklyOpened++;
        executed.push(ticker);
      }
      pendingEntries = [];
    }

    // ── A. Update open FULL positions (daily bar check) ───────────────────
    for (const [ticker, pos] of fullPositions) {
      if (pos.closed) continue;
      const daily = dailyCandleMap[ticker];
      const weekly = weeklyCandleMap[ticker];
      const atrArr = weeklyAtrMap[ticker];
      if (!daily) continue;

      // Find today's bar
      const bar = daily.find(b => b.date === date);
      if (!bar) continue;
      if (bar.date <= pos.lastCheckedDate) continue;

      pos.tradingDays++;
      pos.lastCheckedDate = bar.date;

      // Weekly stop ratchet (on new week)
      if (weekly) {
        const weekIdx = weekly.findIndex(b => b.weekOf === mondayStr);
        if (weekIdx > pos.currentWeekIdx && weekIdx >= 3) {
          pos.currentWeekIdx = weekIdx;
          const newStop = computeWeeklyStopCandidate(weekly, atrArr, weekIdx, pos.signal, pos.stop);
          if (newStop !== pos.stop) {
            pos.stop = newStop;
          }

          // Structural exit check
          const prev1 = weekly[weekIdx - 1];
          const prev2 = weekly[weekIdx - 2];
          const twoWeekHigh = Math.max(prev1.high, prev2.high);
          const twoWeekLow = Math.min(prev1.low, prev2.low);
          const weekBar = weekly[weekIdx];
          if (weekBar) {
            if (pos.signal === 'BL' && weekBar.low < twoWeekLow) {
              closePosition(pos, bar.date, pos.stop, 'SIGNAL_BE');
              continue;
            }
            if (pos.signal === 'SS' && weekBar.high > twoWeekHigh) {
              closePosition(pos, bar.date, pos.stop, 'SIGNAL_SE');
              continue;
            }
          }
        }
      }

      // MFE / MAE
      if (pos.signal === 'BL') {
        pos.mfe = Math.max(pos.mfe || 0, (bar.high - pos.avgCost) / pos.avgCost * 100);
        pos.mae = Math.min(pos.mae || 0, (bar.low - pos.avgCost) / pos.avgCost * 100);
      } else {
        pos.mfe = Math.max(pos.mfe || 0, (pos.avgCost - bar.low) / pos.avgCost * 100);
        pos.mae = Math.min(pos.mae || 0, (pos.avgCost - bar.high) / pos.avgCost * 100);
      }

      // Stop hit — fill at open if bar gaps through stop
      if (pos.signal === 'BL' && bar.low <= pos.stop) {
        const fillPrice = bar.open < pos.stop ? bar.open : pos.stop;
        closePosition(pos, bar.date, fillPrice, 'STOP_HIT');
        continue;
      }
      if (pos.signal === 'SS' && bar.high >= pos.stop) {
        const fillPrice = bar.open > pos.stop ? bar.open : pos.stop;
        closePosition(pos, bar.date, fillPrice, 'STOP_HIT');
        continue;
      }

      // Stale hunt (20 trading days losing)
      if (pos.tradingDays >= 20) {
        const pnl = pos.signal === 'BL'
          ? (bar.close - pos.avgCost) / pos.avgCost * 100
          : (pos.avgCost - bar.close) / pos.avgCost * 100;
        if (pnl < 0) {
          closePosition(pos, bar.date, bar.close, 'STALE_HUNT');
          continue;
        }
      }

      // Pyramid lot additions
      const nextLotIdx = pos.lots.length;
      if (nextLotIdx < 5) {
        const timeGateOk = nextLotIdx !== 1 || pos.tradingDays >= TIME_GATE_DAYS;
        if (timeGateOk) {
          const trigger = pos.lotTriggers[nextLotIdx];
          const triggerHit = pos.signal === 'BL' ? bar.high >= trigger : bar.low <= trigger;

          if (triggerHit) {
            const fillPrice = trigger;
            const advMax = Math.floor(getAdv20(ticker, bar.date) * ADV_CAP_PCT);
            const shares = Math.min(pos.lotShares[nextLotIdx], advMax > 0 ? advMax : pos.lotShares[nextLotIdx]);
            if (shares <= 0) continue;

            // Capital constraint: can we afford this lot?
            const lotCost = shares * fillPrice;
            if (availableCash < lotCost) { totalLotsSkippedForCash++; continue; }
            availableCash -= lotCost;

            const lotNum = nextLotIdx + 1;
            const entryComm = calcCommission(shares, fillPrice);
            const entrySlip = calcSlippage(shares, fillPrice);

            pos.lots.push({
              lot: lotNum, name: LOT_NAMES[nextLotIdx], pct: LOT_PCT[nextLotIdx],
              fillDate: bar.date, fillPrice, shares, lotValue: parseFloat((shares * fillPrice).toFixed(2)),
              tradingDayAtFill: pos.tradingDays, entryComm, entrySlip,
            });

            pos.totalShares += shares;
            pos.totalCost += shares * fillPrice;
            pos.avgCost = parseFloat((pos.totalCost / pos.totalShares).toFixed(4));

            // Stop ratchet
            let ratchetPrice = pos.stop;
            if (lotNum === 2) ratchetPrice = parseFloat(pos.avgCost.toFixed(2));
            else if (lotNum === 3) ratchetPrice = pos.lots[0].fillPrice;
            else if (lotNum === 4) ratchetPrice = pos.lots[1].fillPrice;
            else if (lotNum === 5) ratchetPrice = pos.lots[2].fillPrice;

            const ratchetTightens = pos.signal === 'BL'
              ? ratchetPrice > pos.stop
              : ratchetPrice < pos.stop;

            if (ratchetTightens) {
              pos.stop = parseFloat(ratchetPrice.toFixed(2));
            }

            // Check if stop immediately hit after ratchet
            if (pos.signal === 'BL' && bar.low <= pos.stop) {
              const fp = bar.open < pos.stop ? bar.open : pos.stop;
              closePosition(pos, bar.date, fp, 'STOP_HIT');
            }
            if (pos.signal === 'SS' && bar.high >= pos.stop) {
              const fp = bar.open > pos.stop ? bar.open : pos.stop;
              closePosition(pos, bar.date, fp, 'STOP_HIT');
            }
          }
        }
      }
    }

    // ── B. (APEX v7: scouts disabled — skipped) ────────────────────────

    // Clean up closed positions, return cash, track realized P&L
    for (const [ticker, pos] of fullPositions) {
      if (pos.closed) {
        // Return cash from closed position
        for (const lot of pos.lots) {
          if (pos.signal === 'BL') {
            availableCash += lot.shares * pos.exitPrice;
          } else {
            availableCash += lot.shares * (2 * lot.fillPrice - pos.exitPrice);
          }
        }
        applyExitCosts(pos);
        cumulativeRealizedPnl += (pos.netDollarPnl || pos.grossDollarPnl || 0);
        closedTrades.push(pos);
        fullPositions.delete(ticker);
      }
    }

    // Track peak deployment and position count
    let deployed = 0;
    for (const [, p] of fullPositions) { if (!p.closed) deployed += p.totalCost; }
    if (deployed > peakDeployed) peakDeployed = deployed;
    if (fullPositions.size > peakPositionCount) peakPositionCount = fullPositions.size;

    // ── MCE: Daily 2-bar high breakout scan (BL only) ───────────────────
    if (!currentFriday) {
      const currentNav = getCurrentNav(date);
      let mceNewToday = 0;
      for (const ticker of currentTtmTop100) {
        if (activeWeeklySignal[ticker] !== 'BL') continue;

        const breakout = getDailyTwoBarHigh(ticker, date);
        if (!breakout) continue;
        const { trigger, todayBar } = breakout;
        if (todayBar.high < trigger) continue;

        const meta = TICKER_META[ticker];
        if (!meta) continue;

        const weekly = weeklyCandleMap[ticker];
        if (!weekly) continue;
        let weekIdx = -1;
        for (let i = weekly.length - 1; i >= 0; i--) {
          if (weekly[i].weekOf <= mondayStr) { weekIdx = i; break; }
        }
        if (weekIdx < 3) continue;

        const prev1 = weekly[weekIdx - 1];
        const prev2 = weekly[weekIdx - 2];
        const twoWeekLow = Math.min(prev1.low, prev2.low);
        const atrArr = weeklyAtrMap[ticker];
        const stopPrice = blInitStop(twoWeekLow, weekly[weekIdx].close, atrArr?.[weekIdx] ?? null);
        if (!stopPrice || stopPrice >= trigger) continue;

        const existingPos = fullPositions.get(ticker);

        if (existingPos && !existingPos.closed && existingPos.signal === 'BL') {
          // NAV gap top-up: only enter if NAV growth created headroom
          if (dayCount - existingPos.lastMceGapDay < 5) continue;
          const currentVitality = currentNav * 0.01;
          const gap = currentVitality - (existingPos.vitalityCommitted || existingPos.navTier * 0.01);
          if (gap <= 0) continue;

          const rps = Math.abs(trigger - stopPrice);
          if (rps <= 0) continue;
          const tickerCap = currentNav * 0.10;
          const existingValue = existingPos.totalShares * existingPos.avgCost;
          const remainingCap = tickerCap - existingValue;
          if (remainingCap <= 0) continue;

          let mceShares = Math.floor(gap / rps);
          mceShares = Math.min(mceShares, Math.floor(remainingCap / trigger));
          if (mceShares <= 0) continue;

          const advMax = Math.floor(getAdv20(ticker, date) * ADV_CAP_PCT);
          mceShares = Math.min(mceShares, advMax > 0 ? advMax : mceShares);
          if (mceShares <= 0) continue;

          // Capital constraint
          const mceCost = mceShares * trigger;
          if (availableCash < mceCost) { totalSkippedForCash++; continue; }
          availableCash -= mceCost;

          const entryComm = calcCommission(mceShares, trigger);
          const entrySlip = calcSlippage(mceShares, trigger);

          existingPos.lots.push({
            lot: existingPos.lots.length + 1, name: 'MCE Gap Add',
            pct: 0, fillDate: date, fillPrice: trigger,
            shares: mceShares, lotValue: parseFloat((mceShares * trigger).toFixed(2)),
            tradingDayAtFill: existingPos.tradingDays, entryComm, entrySlip,
            isMceAdd: true,
          });

          existingPos.totalShares += mceShares;
          existingPos.totalCost += mceShares * trigger;
          existingPos.avgCost = parseFloat((existingPos.totalCost / existingPos.totalShares).toFixed(4));

          const rpsUsed = mceShares * Math.abs(trigger - stopPrice);
          existingPos.vitalityCommitted = (existingPos.vitalityCommitted || existingPos.navTier * 0.01) + rpsUsed;
          existingPos.lastMceGapDay = dayCount;

          const newStop = blInitStop(twoWeekLow, weekly[weekIdx].close, atrArr?.[weekIdx] ?? null);
          if (newStop > existingPos.stop) {
            existingPos.stop = parseFloat(newStop.toFixed(2));
          }

          totalMceGapAdds++;
        } else if ((!existingPos || existingPos.closed) && mceNewToday < 3) {
          // New MCE position — full 5-lot pyramid (max 3 per day)
          const entryPrice = trigger;
          const sectorMult = 1.0;
          const fullShares = sizePositionNav(currentNav, entryPrice, stopPrice, sectorMult);
          if (fullShares <= 0) continue;

          const lotShares = LOT_PCT.map(pct => Math.max(1, Math.round(fullShares * pct)));
          const lotTriggers = LOT_OFFSET_PCT.map(off =>
            parseFloat((entryPrice * (1 + off)).toFixed(2))
          );

          const advMax = Math.floor(getAdv20(ticker, date) * ADV_CAP_PCT);
          let lot1Shares = Math.min(lotShares[0], advMax > 0 ? advMax : lotShares[0]);
          if (lot1Shares <= 0) continue;

          // Capital constraint
          const mceLot1Cost = lot1Shares * entryPrice;
          if (availableCash < mceLot1Cost) { totalSkippedForCash++; continue; }
          availableCash -= mceLot1Cost;

          const l1Comm = calcCommission(lot1Shares, entryPrice);
          const l1Slip = calcSlippage(lot1Shares, entryPrice);

          fullPositions.set(ticker, {
            ticker, signal: 'BL', sectorId: meta.sectorId, sectorName: meta.sectorName,
            sectorTier: 'NEUTRAL', sectorMult: 1.0, weekOf: mondayStr, entryDate: date,
            navTier: currentNav, entryPrice, initialStop: stopPrice, stop: stopPrice,
            vitalityCommitted: currentNav * 0.01,
            lastMceGapDay: -Infinity,
            lots: [{
              lot: 1, name: LOT_NAMES[0], pct: LOT_PCT[0],
              fillDate: date, fillPrice: entryPrice,
              shares: lot1Shares, lotValue: parseFloat((lot1Shares * entryPrice).toFixed(2)),
              tradingDayAtFill: 0, entryComm: l1Comm, entrySlip: l1Slip,
            }],
            lotShares, lotTriggers,
            totalShares: lot1Shares, totalCost: lot1Shares * entryPrice, avgCost: entryPrice,
            tradingDays: 0, lastCheckedDate: date,
            currentWeekIdx: weekIdx, mfe: 0, mae: 0,
            closed: false, exitDate: null, exitPrice: null, exitReason: null,
            tradeType: 'MCE',
          });
          totalMceOpened++;
          mceNewToday++;
        }
      }
    }

    // ── C. On Fridays: check weekly signals for conversions + new entries ──
    if (currentFriday) {
      lastFriday = currentFriday;

      const weeklyEvents = weeklyEventsByDate[mondayStr] || {};

      // APEX v7: weekly-only entries — collect candidates, rank, cap at top 10 BL + top 5 SS
      const currentNav = getCurrentNav(date);
      const weeklyCandidates = [];
      for (const [ticker, wev] of Object.entries(weeklyEvents)) {
        if (fullPositions.has(ticker)) continue;
        if (wev.signal !== 'BL' && wev.signal !== 'SS') continue;

        const meta = TICKER_META[ticker];
        if (!meta) continue;

        const tickerIsCarnivore = isCarnivoreMode(ticker);

        // Regime gate: carnivore uses SPY+QQQ, AI 300 uses PAI300
        if (tickerIsCarnivore) {
          if (wev.signal === 'BL' && !c679Bull) continue;
          if (wev.signal === 'SS' && c679Bull) continue;
        } else {
          if (wev.signal === 'BL' && !pai300Bull) continue;
          if (wev.signal === 'SS' && pai300Bull) continue;
        }

        // Sector rotation: carnivore skips (mult=1.0), AI 300 applies GO/NEUTRAL/NO_GO
        let sectorTier, sectorMult;
        if (tickerIsCarnivore) {
          sectorTier = 'NEUTRAL';
          sectorMult = 1.0;  // 679 tickers skip sector rotation
        } else {
          sectorTier = getSectorTierOnDate(meta.sectorId, date);
          sectorMult = getSectorMult(sectorTier, wev.signal);
          if (sectorMult === 0) continue;
        }

        const weekly = weeklyCandleMap[ticker];
        if (!weekly) continue;
        const weekIdx = weekly.findIndex(b => b.weekOf === mondayStr);
        if (weekIdx < 3) continue;

        const prev1 = weekly[weekIdx - 1];
        const prev2 = weekly[weekIdx - 2];
        const twoBarHigh = Math.max(prev1.high, prev2.high);
        const twoBarLow = Math.min(prev1.low, prev2.low);
        const lastBar = weekly[weekIdx];

        let entryPrice, stopPrice;
        if (wev.signal === 'BL') {
          entryPrice = parseFloat((twoBarHigh + 0.01).toFixed(2));
          const atrArr = weeklyAtrMap[ticker];
          stopPrice = blInitStop(twoBarLow, lastBar.close, atrArr?.[weekIdx] ?? null);
        } else {
          entryPrice = parseFloat((twoBarLow - 0.01).toFixed(2));
          const atrArr = weeklyAtrMap[ticker];
          stopPrice = ssInitStop(twoBarHigh, lastBar.close, atrArr?.[weekIdx] ?? null);
        }

        if (entryPrice <= 0 || !stopPrice) continue;

        const fullShares = sizePositionNav(currentNav, entryPrice, stopPrice, sectorMult);
        if (fullShares <= 0) continue;

        weeklyCandidates.push({
          ticker, signal: wev.signal, meta, sectorTier, sectorMult,
          weekIdx, entryPrice, stopPrice, fullShares,
        });
      }

      // Sort by sector tier (GO first) then by sector mult descending
      const tierOrder = { GO: 0, NEUTRAL: 1, NO_GO: 2 };
      weeklyCandidates.sort((a, b) => (tierOrder[a.sectorTier] || 1) - (tierOrder[b.sectorTier] || 1));

      const blCands = weeklyCandidates.filter(c => c.signal === 'BL').slice(0, 10);
      const ssCands = weeklyCandidates.filter(c => c.signal === 'SS').slice(0, 5);
      const selectedWeekly = [...blCands, ...ssCands];

      // Stage for Monday open execution (not entered on Friday)
      pendingEntries = selectedWeekly.map(cand => ({
        ...cand,
        weekOf: currentFriday,
      }));
    }

    // ── D. (APEX v7: scouts disabled — skipped) ────────────────────────

    // Progress
    if (dayCount % 50 === 0 || dayCount === tradingDays.length) {
      process.stdout.write(
        `\r  Day ${String(dayCount).padStart(4)}/${tradingDays.length} — ` +
        `${date} — open: ${fullPositions.size}, closed: ${closedTrades.length}, cash: $${Math.round(availableCash).toLocaleString()}  `
      );
    }
  }

  // Close remaining open positions and return cash
  for (const [ticker, pos] of fullPositions) {
    const daily = dailyCandleMap[ticker];
    if (daily?.length > 0) {
      const last = daily[daily.length - 1];
      closePosition(pos, last.date, last.close, 'STILL_OPEN');
      for (const lot of pos.lots) {
        if (pos.signal === 'BL') {
          availableCash += lot.shares * pos.exitPrice;
        } else {
          availableCash += lot.shares * (2 * lot.fillPrice - pos.exitPrice);
        }
      }
      applyExitCosts(pos);
    }
    closedTrades.push(pos);
  }
  fullPositions.clear();

  console.log('\n');

  // ── Build daily NAV (gross = post-transaction-costs, pre-fund-fees) ──────
  // Track cumulative realized P&L + unrealized MTM for all open positions.
  console.log('Building daily NAV series...');
  const dailyGrossNav = [];

  // Index trades by entry/exit date for efficient lookup
  const tradesByEntry = {};
  const tradesByExit = {};
  for (const trade of closedTrades) {
    if (!tradesByEntry[trade.entryDate]) tradesByEntry[trade.entryDate] = [];
    tradesByEntry[trade.entryDate].push(trade);
    if (trade.exitDate) {
      if (!tradesByExit[trade.exitDate]) tradesByExit[trade.exitDate] = [];
      tradesByExit[trade.exitDate].push(trade);
    }
  }

  let navRealizedPnl = 0;
  const openTradesForNav = new Map();

  for (const date of tradingDays) {
    const entering = tradesByEntry[date] || [];
    for (const t of entering) {
      openTradesForNav.set(`${t.ticker}_${t.entryDate}`, t);
    }

    const exiting = tradesByExit[date] || [];
    for (const t of exiting) {
      const key = `${t.ticker}_${t.entryDate}`;
      if (openTradesForNav.has(key)) {
        navRealizedPnl += (t.netDollarPnl || 0);
        openTradesForNav.delete(key);
      }
    }

    let unrealizedMtm = 0;
    for (const [key, trade] of openTradesForNav) {
      const daily = dailyCandleMap[trade.ticker];
      if (!daily) continue;

      let closePrice = null;
      for (let i = daily.length - 1; i >= 0; i--) {
        if (daily[i].date <= date) { closePrice = daily[i].close; break; }
      }
      if (closePrice === null) continue;

      let lotPnl = 0;
      let entryCosts = 0;
      for (const lot of trade.lots) {
        if (lot.fillDate > date) continue;
        if (trade.signal === 'BL') {
          lotPnl += (closePrice - lot.fillPrice) * lot.shares;
        } else {
          lotPnl += (lot.fillPrice - closePrice) * lot.shares;
        }
        entryCosts += (lot.entryComm || 0) + (lot.entrySlip || 0);
      }
      unrealizedMtm += lotPnl - entryCosts;
    }

    const equity = STARTING_NAV + navRealizedPnl + unrealizedMtm;
    dailyGrossNav.push({ date, equity: parseFloat(equity.toFixed(2)) });
  }
  console.log(`  ${dailyGrossNav.length} daily NAV points`);

  // ── Persist to MongoDB ───────────────────────────────────────────────────
  const SUFFIX_ARG = process.argv.find(a => a.startsWith('--suffix='));
  const colSuffix = SUFFIX_ARG ? SUFFIX_ARG.split('=')[1] : '_mce';
  const tradeCol = db.collection(`pnthr_ai_bt_pyramid_nav_${navLabel}_trade_log${colSuffix}`);
  const navCol = db.collection(`pnthr_ai_bt_pyramid_nav_${navLabel}_daily_nav_gross${colSuffix}`);

  console.log(`\nPersisting ${closedTrades.length} trades...`);
  await tradeCol.deleteMany({});
  if (closedTrades.length > 0) {
    await tradeCol.insertMany(closedTrades);
    await tradeCol.createIndex({ ticker: 1 });
    await tradeCol.createIndex({ entryDate: 1 });
    await tradeCol.createIndex({ tradeType: 1 });
  }

  console.log(`Persisting ${dailyGrossNav.length} NAV points...`);
  await navCol.deleteMany({});
  if (dailyGrossNav.length > 0) {
    await navCol.insertMany(dailyGrossNav);
    await navCol.createIndex({ date: 1 });
  }

  // ── Analysis ─────────────────────────────────────────────────────────────
  const closed = closedTrades.filter(t => t.exitReason !== 'STILL_OPEN');
  const blTrades = closed.filter(t => t.signal === 'BL');
  const ssTrades = closed.filter(t => t.signal === 'SS');

  const mceTrades = closed.filter(t => t.tradeType === 'MCE');
  const weeklyTrades = closed.filter(t => t.tradeType === 'WEEKLY_DIRECT');

  console.log('\n' + '═'.repeat(80));
  console.log('  PNTHR AI ELITE FUND — MULTI-STRATEGY + MCE RESULTS');
  console.log(`  Period:         ${tradingDays[0]} → ${tradingDays[tradingDays.length - 1]}`);
  console.log(`  Starting NAV:   $${STARTING_NAV.toLocaleString()}`);
  console.log('═'.repeat(80));

  console.log('\n── Trade Breakdown ──');
  console.log(`  Total closed:      ${closed.length}`);
  console.log(`  Weekly entries:    ${totalWeeklyOpened}`);
  console.log(`  MCE entries:       ${totalMceOpened}`);
  console.log(`  MCE gap adds:      ${totalMceGapAdds}`);
  console.log(`  BL trades:         ${blTrades.length}`);
  console.log(`  SS trades:         ${ssTrades.length}`);

  console.log('\n── Capital Constraint ──');
  console.log(`  Starting cash:            $${STARTING_NAV.toLocaleString()}`);
  console.log(`  Final cash (all closed):  $${Math.round(availableCash).toLocaleString()}`);
  console.log(`  Entries skipped (no cash): ${totalSkippedForCash}`);
  console.log(`  Lots skipped (no cash):    ${totalLotsSkippedForCash}`);
  console.log(`  Peak capital deployed:     $${Math.round(peakDeployed).toLocaleString()}`);
  console.log(`  Peak concurrent positions: ${peakPositionCount}`);

  function tradeSummary(trades, label) {
    if (trades.length === 0) { console.log(`\n── ${label}: no trades`); return; }
    const wins = trades.filter(t => t.netIsWinner);
    const losses = trades.filter(t => !t.netIsWinner);
    const totalNet = trades.reduce((s, t) => s + (t.netDollarPnl || 0), 0);
    const totalGross = trades.reduce((s, t) => s + (t.grossDollarPnl || 0), 0);
    const totalFrict = trades.reduce((s, t) => s + (t.totalFrictionDollar || 0), 0);

    console.log(`\n── ${label} (${trades.length} closed trades) ──`);
    console.log(`  Win rate:        ${(wins.length / trades.length * 100).toFixed(1)}%  (${wins.length}W / ${losses.length}L)`);
    console.log(`  Total gross P&L: $${totalGross.toFixed(0)}`);
    console.log(`  Total friction:  -$${totalFrict.toFixed(0)}`);
    console.log(`  Total net P&L:   $${totalNet.toFixed(0)}`);
  }

  tradeSummary(weeklyTrades, 'WEEKLY_DIRECT');
  tradeSummary(mceTrades, 'MCE');
  tradeSummary(blTrades, 'BL (Longs)');
  tradeSummary(ssTrades, 'SS (Shorts)');
  tradeSummary(closed, 'Combined');

  // Monthly equity curve
  const monthlyPnl = {};
  for (const t of closed) {
    if (!t.exitDate) continue;
    const m = t.exitDate.slice(0, 7);
    if (!monthlyPnl[m]) monthlyPnl[m] = 0;
    monthlyPnl[m] += (t.netDollarPnl || 0);
  }

  let equity = STARTING_NAV;
  const months = Object.keys(monthlyPnl).sort();
  let positiveMonths = 0;
  const monthlyReturns = [];

  for (const m of months) {
    const prev = equity;
    equity += monthlyPnl[m];
    const monthReturn = prev > 0 ? (monthlyPnl[m] / prev * 100) : 0;
    monthlyReturns.push(monthReturn);
    if (monthReturn > 0) positiveMonths++;
  }

  // Max drawdown from daily NAV series (accurate, not monthly approx)
  let peak = STARTING_NAV, maxDD = 0;
  for (const nav of dailyGrossNav) {
    if (nav.equity > peak) peak = nav.equity;
    const dd = peak > 0 ? (peak - nav.equity) / peak * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }

  // Use actual calendar span from daily NAV for accurate CAGR
  const firstDate = new Date(tradingDays[0] + 'T12:00:00');
  const lastDate = new Date(tradingDays[tradingDays.length - 1] + 'T12:00:00');
  const yearsSpan = (lastDate - firstDate) / (365.25 * 86400000);
  // Use final daily NAV equity (more accurate than summing monthly PnL)
  const finalNavEquity = dailyGrossNav[dailyGrossNav.length - 1]?.equity || equity;
  const totalReturn = finalNavEquity > 0 ? (finalNavEquity - STARTING_NAV) / STARTING_NAV * 100 : 0;
  const cagr = yearsSpan > 0 ? (Math.pow(finalNavEquity / STARTING_NAV, 1 / yearsSpan) - 1) * 100 : 0;

  const avgMonthly = monthlyReturns.reduce((s, r) => s + r, 0) / (monthlyReturns.length || 1);
  const stdDev = Math.sqrt(
    monthlyReturns.reduce((s, r) => s + (r - avgMonthly) ** 2, 0) / Math.max(monthlyReturns.length - 1, 1)
  );
  const riskFreeMonthly = 5 / 12;
  const excessReturns = monthlyReturns.map(r => r - riskFreeMonthly);
  const avgExcess = excessReturns.reduce((s, r) => s + r, 0) / (excessReturns.length || 1);
  const downside = excessReturns.filter(r => r < 0);
  const downsideDev = downside.length > 0
    ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / downside.length)
    : 0.001;
  const sharpe = stdDev > 0 ? (avgExcess / stdDev) * Math.sqrt(12) : 0;
  const sortino = downsideDev > 0 ? (avgExcess / downsideDev) * Math.sqrt(12) : 0;
  const calmar = maxDD > 0 ? cagr / maxDD : 0;

  const totalWon = closed.filter(t => (t.netDollarPnl || 0) > 0).reduce((s, t) => s + t.netDollarPnl, 0);
  const totalLost = Math.abs(closed.filter(t => (t.netDollarPnl || 0) < 0).reduce((s, t) => s + t.netDollarPnl, 0));
  const profitFactor = totalLost > 0 ? totalWon / totalLost : Infinity;

  console.log('\n' + '═'.repeat(80));
  console.log(`  INSTITUTIONAL METRICS — MULTI-STRATEGY + MCE (NAV $${STARTING_NAV.toLocaleString()})`);
  console.log('═'.repeat(80));
  console.log(`  Final equity:      $${equity.toFixed(0)}`);
  console.log(`  Total return:      +${totalReturn.toFixed(1)}%`);
  console.log(`  CAGR:              +${cagr.toFixed(2)}%`);
  console.log(`  Sharpe ratio:      ${sharpe.toFixed(2)}`);
  console.log(`  Sortino ratio:     ${sortino.toFixed(2)}`);
  console.log(`  Max drawdown:      -${maxDD.toFixed(2)}%`);
  console.log(`  Calmar ratio:      ${calmar.toFixed(2)}`);
  console.log(`  Profit factor:     ${profitFactor === Infinity ? '∞' : profitFactor.toFixed(2)}`);
  console.log(`  Positive months:   ${positiveMonths}/${months.length}`);
  console.log(`  Closed trades:     ${closed.length} (BL: ${blTrades.length}, SS: ${ssTrades.length})`);
  console.log(`  Still open:        ${closedTrades.length - closed.length}`);

  console.log('\n── Target comparison ──');
  console.log(`  Phase 4 target:  +356.49% / 55.57% CAGR / 1,588 trades / Sharpe 1.89`);
  console.log(`  APEX v6 target:  +481.13% / 66.89% CAGR / Sharpe 2.06 / PF 2.57`);
  console.log(`  This run:        +${totalReturn.toFixed(1)}% / ${cagr.toFixed(2)}% CAGR / ${closed.length} trades / Sharpe ${sharpe.toFixed(2)} / PF ${profitFactor === Infinity ? '∞' : profitFactor.toFixed(2)}`);

  console.log('\n' + '═'.repeat(80));
  console.log('  DATA PERSISTED:');
  console.log(`  Trade log:  pnthr_ai_bt_pyramid_nav_${navLabel}_trade_log (${closedTrades.length} docs)`);
  console.log(`  Daily NAV:  pnthr_ai_bt_pyramid_nav_${navLabel}_daily_nav_gross (${dailyGrossNav.length} docs)`);
  console.log('═'.repeat(80) + '\n');

  process.exit(0);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  console.error(err.stack);
  process.exit(1);
});
