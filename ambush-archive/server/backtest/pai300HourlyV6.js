// server/backtest/pai300HourlyV6.js
// ── PNTHR AMBUSH V6 — REALISTIC BACKTEST ─────────────────────────────────
//
// V5 → V6 changes:
//   1. Next-bar-open entry: re-entries signal on bar N, execute on bar N+1 open
//      (eliminates look-ahead bias — you can't know a bar is confirmed until it closes)
//   2. Real IBKR fees: calcCommission() from costEngine.js ($0.005/sh, $1 min, 1% max)
//   3. Slippage: 5bps adverse per leg on ALL entries and exits
//   4. Bear market shorts: when regime is bearish, run the OPPOSITE strategy
//      — first-hour HIGH exit, confirmed RED bar re-entry downward, pyramid down
//
// Usage: cd server && node backtest/pai300HourlyV6.js
// ────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { connectToDatabase } from '../database.js';
import { SECTORS } from '../scripts/aiUniverse/aiUniverseData.js';
import { SECTOR_EMA_PERIODS } from '../data/pnthrAiSectorsConfig.js';
import { CARNIVORE_MODE_TICKERS } from '../data/strategyMode.js';
import { detectAllSignals, calculateEMA, blInitStop, ssInitStop, computeWilderATR } from '../signalDetection.js';
import { calcCommission, calcSlippage, calcBorrowCost, getBorrowRate } from './costEngine.js';

const NAV_INITIAL     = 100_000;
const VITALITY_PCT    = 0.01;
const TICKER_CAP_PCT  = 0.10;
const STRIKE_PCT      = [0.35, 0.25, 0.20, 0.12, 0.08];
const LOT_OFFSETS     = [0, 0.03, 0.06, 0.10, 0.14];
const MAX_LOSS        = 300;
const BE_PROFIT_THRESHOLD = 50;
const PAI300_REGIME_PERIOD = 36;
const FIRST_HOUR_END  = '10:30';
const MAX_POSITIONS   = 20;
const SLIPPAGE_BPS    = 5;

const CARNIVORE_SECTOR_MAP = {
  'Technology':'XLK','Energy':'XLE','Healthcare':'XLV','Health Care':'XLV',
  'Financial Services':'XLF','Financials':'XLF','Consumer Discretionary':'XLY',
  'Consumer Cyclical':'XLY','Communication Services':'XLC','Industrials':'XLI',
  'Basic Materials':'XLB','Materials':'XLB','Real Estate':'XLRE','Utilities':'XLU',
  'Consumer Staples':'XLP','Consumer Defensive':'XLP',
};
const ETF_EMA_PERIOD = {
  XLK: 21, XLV: 24, XLF: 25, XLI: 24, XLE: 26, XLC: 21,
  XLRE: 26, XLU: 21, XLB: 19, XLY: 19, XLP: 18,
};
const CARNIVORE_GICS = {
  AKAM:'Technology',ANET:'Technology',CDW:'Technology',COHR:'Technology',
  INTC:'Technology',KLAC:'Technology',SNDK:'Technology',
  META:'Communication Services',TSLA:'Consumer Discretionary',CSGP:'Real Estate',
  CEG:'Utilities',EQT:'Energy',TRGP:'Energy',
  APH:'Industrials',ARM:'Industrials',EMR:'Industrials',ETN:'Industrials',
  GEV:'Industrials',HUBB:'Industrials',LDOS:'Industrials',TDG:'Industrials',
  TRMB:'Industrials',CMI:'Industrials',
  IBM:'Technology',ORCL:'Technology',TTD:'Technology',VST:'Utilities',LITE:'Technology',
};

const AI_TICKER_META = {};
for (const sec of SECTORS) {
  for (const h of sec.holdings) AI_TICKER_META[h.ticker] = { sectorId: sec.id, sector: sec.name };
}

function getSectorName(ticker) {
  if (CARNIVORE_GICS[ticker]) return CARNIVORE_GICS[ticker];
  const meta = AI_TICKER_META[ticker];
  if (meta?.sector) return meta.sector;
  return 'Technology';
}

function getWeekOf(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const dow = d.getDay();
  const daysToMon = dow === 0 ? -6 : 1 - dow;
  const m = new Date(d); m.setDate(d.getDate() + daysToMon);
  return m.toISOString().split('T')[0];
}

function computeEMASeed(closes, period) {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  const result = new Array(period - 1).fill(null);
  result.push(ema);
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

function extractTime(dateStr) {
  const parts = dateStr.split(' ');
  return parts.length > 1 ? parts[1].slice(0, 5) : '00:00';
}

function isConfirmedGreenBreakout(bar, prevBar) {
  if (!prevBar) return false;
  if (bar.close <= bar.open) return false;
  if (bar.high <= prevBar.high) return false;
  if (bar.close <= prevBar.high) return false;
  return true;
}

function isConfirmedRedBreakdown(bar, prevBar) {
  if (!prevBar) return false;
  if (bar.close >= bar.open) return false;
  if (bar.low >= prevBar.low) return false;
  if (bar.close >= prevBar.low) return false;
  return true;
}

function applySlippage(price, adverse) {
  const slip = price * (SLIPPAGE_BPS / 10000);
  return adverse ? +(price + slip).toFixed(4) : +(price - slip).toFixed(4);
}

async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('No DB'); process.exit(1); }

  console.log('='.repeat(130));
  console.log('  PNTHR AMBUSH V6 — REALISTIC BACKTEST');
  console.log('  Next-bar-open entry | Real IBKR fees | 5bps slippage | Bear-market shorts');
  console.log('='.repeat(130));

  // ── LOAD DATA ──────────────────────────────────────────────────────────────
  console.log('\n[1] Loading data...');

  const dailyDocs = await db.collection('pnthr_ai_bt_candles')
    .find({}, { projection: { ticker: 1, daily: 1 } }).toArray();
  const weeklyDocs = await db.collection('pnthr_ai_bt_candles_weekly')
    .find({}, { projection: { ticker: 1, weekly: 1 } }).toArray();
  const hourlyDocs = await db.collection('pnthr_ai_hourly_candles')
    .find({}, { projection: { ticker: 1, hourly: 1 } }).toArray();
  const sectorRankDocs = await db.collection('pnthr_ai_sector_rank_daily')
    .find({}).sort({ date: 1 }).toArray();
  const pai300Doc = await db.collection('pnthr_ai_index_candles_weekly').findOne({ ticker: 'PAI300' });
  const spyWeeklyDoc = await db.collection('pnthr_bt_candles_weekly').findOne({ ticker: 'SPY' });
  const etfWeeklyDocs = {};
  for (const etf of Object.keys(ETF_EMA_PERIOD)) {
    const doc = await db.collection('pnthr_bt_candles_weekly').findOne({ ticker: etf });
    if (doc) etfWeeklyDocs[etf] = doc;
  }

  const hourlyBarMap = {};
  let hourlyMinDate = '9999', hourlyMaxDate = '0000';
  for (const doc of hourlyDocs) {
    const bars = (doc.hourly || []).sort((a, b) => a.date.localeCompare(b.date));
    hourlyBarMap[doc.ticker] = bars;
    if (bars.length) {
      const first = bars[0].date.split(' ')[0];
      const last = bars[bars.length - 1].date.split(' ')[0];
      if (first < hourlyMinDate) hourlyMinDate = first;
      if (last > hourlyMaxDate) hourlyMaxDate = last;
    }
  }

  const dailyBarMap = {};
  for (const doc of dailyDocs) {
    const map = {};
    for (const b of (doc.daily || [])) map[b.date] = b;
    dailyBarMap[doc.ticker] = map;
  }

  const hourlyDatesSet = new Set();
  for (const bars of Object.values(hourlyBarMap)) {
    for (const b of bars) hourlyDatesSet.add(b.date.split(' ')[0]);
  }
  const hourlyTradingDates = [...hourlyDatesSet].sort();

  const weeklyBarsByTicker = {};
  for (const doc of weeklyDocs) {
    const sorted = (doc.weekly || []).sort((a, b) => (a.weekOf || a.date).localeCompare(b.weekOf || b.date));
    weeklyBarsByTicker[doc.ticker] = sorted.map(w => ({
      time: w.weekOf || w.date, open: w.open, high: w.high, low: w.low, close: w.close,
    }));
  }

  // Regimes
  const pai300Weekly = (pai300Doc?.weekly || []).sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  const pai300Closes = pai300Weekly.map(w => w.close);
  const pai300Ema = computeEMASeed(pai300Closes, PAI300_REGIME_PERIOD);
  const pai300RegimeByWeek = {};
  for (let i = 0; i < pai300Weekly.length; i++) {
    if (pai300Ema[i] != null) pai300RegimeByWeek[pai300Weekly[i].weekOf] = pai300Closes[i] > pai300Ema[i];
  }
  const spyWeekly = (spyWeeklyDoc?.weekly || []).sort((a, b) => (a.weekOf || a.date).localeCompare(b.weekOf || b.date));
  const spyCloses = spyWeekly.map(w => w.close);
  const spyEma21 = computeEMASeed(spyCloses, 21);
  const spyRegimeByWeek = {};
  for (let i = 0; i < spyWeekly.length; i++) {
    if (spyEma21[i] != null) spyRegimeByWeek[spyWeekly[i].weekOf || spyWeekly[i].date] = spyCloses[i] > spyEma21[i];
  }
  const etfAboveEmaByWeek = {};
  for (const [etf, doc] of Object.entries(etfWeeklyDocs)) {
    const bars = (doc.weekly || []).sort((a, b) => (a.weekOf || a.date).localeCompare(b.weekOf || b.date));
    const closes = bars.map(w => w.close);
    const period = ETF_EMA_PERIOD[etf] || 21;
    const ema = computeEMASeed(closes, period);
    const map = {};
    for (let i = 0; i < bars.length; i++) {
      if (ema[i] != null) map[bars[i].weekOf || bars[i].date] = closes[i] > ema[i];
    }
    etfAboveEmaByWeek[etf] = map;
  }
  const aiSectorTierByDate = {};
  for (const doc of sectorRankDocs) {
    const tiers = {};
    for (const r of (doc.ranks || [])) tiers[r.sectorId] = r.tier;
    aiSectorTierByDate[doc.date] = tiers;
  }

  console.log(`  Hourly window: ${hourlyMinDate} to ${hourlyMaxDate} (${hourlyTradingDates.length} days)`);
  console.log(`  Tickers with hourly data: ${Object.keys(hourlyBarMap).length}`);

  // ── SIGNALS ────────────────────────────────────────────────────────────────
  console.log('\n[2] Computing signals...');

  const allTickers = Object.keys(weeklyBarsByTicker).filter(t =>
    AI_TICKER_META[t] || CARNIVORE_MODE_TICKERS.has(t));

  const signalsByTicker = {};
  for (const ticker of allTickers) {
    const bars = weeklyBarsByTicker[ticker];
    if (!bars || bars.length < 35) continue;
    const isCarnivore = CARNIVORE_MODE_TICKERS.has(ticker);
    const sectorId = AI_TICKER_META[ticker]?.sectorId;
    const period = isCarnivore ? 21 : (SECTOR_EMA_PERIODS[sectorId] ?? SECTOR_EMA_PERIODS[String(sectorId)] ?? 30);
    const gateOffset = isCarnivore ? 0.10 : 0.25;
    const result = detectAllSignals(bars, period, false, null, gateOffset);

    const activeBLPeriods = [];
    const activeSSPeriods = [];
    let blStart = null, ssStart = null;
    for (const evt of result.events) {
      if (evt.signal === 'BL') blStart = evt.time;
      if ((evt.signal === 'BE' || evt.signal === 'SS') && blStart) {
        activeBLPeriods.push({ from: blStart, to: evt.time });
        blStart = null;
      }
      if (evt.signal === 'SS') ssStart = evt.time;
      if ((evt.signal === 'SE' || evt.signal === 'BL') && ssStart) {
        activeSSPeriods.push({ from: ssStart, to: evt.time });
        ssStart = null;
      }
    }
    if (blStart) activeBLPeriods.push({ from: blStart, to: '9999-12-31' });
    if (ssStart) activeSSPeriods.push({ from: ssStart, to: '9999-12-31' });

    signalsByTicker[ticker] = { activeBLPeriods, activeSSPeriods, isCarnivore };
  }
  console.log(`  ${Object.keys(signalsByTicker).length} tickers with signals`);

  // ── GATE FUNCTIONS ─────────────────────────────────────────────────────────

  function getRegime(ticker, dateStr) {
    const weekOf = getWeekOf(dateStr);
    const regimeMap = CARNIVORE_MODE_TICKERS.has(ticker) ? spyRegimeByWeek : pai300RegimeByWeek;
    if (regimeMap[weekOf] !== undefined) return regimeMap[weekOf];
    const weeks = Object.keys(regimeMap).sort();
    let best = null;
    for (const w of weeks) { if (w <= weekOf) best = w; else break; }
    return best !== null ? regimeMap[best] : true;
  }

  function getSectorOk(ticker, dateStr) {
    const weekOf = getWeekOf(dateStr);
    if (!CARNIVORE_MODE_TICKERS.has(ticker)) {
      const dates = Object.keys(aiSectorTierByDate).sort();
      let best = null;
      for (const d of dates) { if (d <= dateStr) best = d; else break; }
      if (!best) return true;
      const tiers = aiSectorTierByDate[best];
      const sectorId = AI_TICKER_META[ticker]?.sectorId;
      const tier = tiers?.[sectorId];
      return tier !== 'AVOID';
    } else {
      const gics = CARNIVORE_GICS[ticker];
      const etf = CARNIVORE_SECTOR_MAP[gics];
      if (!etf) return true;
      const etfMap = etfAboveEmaByWeek[etf];
      if (!etfMap) return true;
      let above = etfMap[weekOf];
      if (above === undefined) {
        const weeks = Object.keys(etfMap).sort();
        let best = null;
        for (const w of weeks) { if (w <= weekOf) best = w; else break; }
        above = best ? etfMap[best] : true;
      }
      return above;
    }
  }

  function isActiveBL(ticker, dateStr) {
    const sig = signalsByTicker[ticker];
    if (!sig) return false;
    const weekOf = getWeekOf(dateStr);
    for (const p of sig.activeBLPeriods) {
      if (weekOf >= p.from && weekOf <= p.to) return true;
    }
    return false;
  }

  function isActiveSS(ticker, dateStr) {
    const sig = signalsByTicker[ticker];
    if (!sig) return false;
    const weekOf = getWeekOf(dateStr);
    for (const p of sig.activeSSPeriods) {
      if (weekOf >= p.from && weekOf <= p.to) return true;
    }
    return false;
  }

  function getWeeklyStopLong(ticker, dateStr, entryPrice) {
    const bars = weeklyBarsByTicker[ticker];
    if (!bars) return null;
    const weekOf = getWeekOf(dateStr);
    let barIdx = -1;
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i].time <= weekOf) { barIdx = i; break; }
    }
    if (barIdx < 2) return null;
    const twoBarLow = Math.min(bars[barIdx - 1].low, bars[barIdx - 2].low);
    const atrArr = computeWilderATR(bars.slice(0, barIdx + 1));
    return blInitStop(twoBarLow, entryPrice, atrArr[barIdx]);
  }

  function getWeeklyStopShort(ticker, dateStr, entryPrice) {
    const bars = weeklyBarsByTicker[ticker];
    if (!bars) return null;
    const weekOf = getWeekOf(dateStr);
    let barIdx = -1;
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i].time <= weekOf) { barIdx = i; break; }
    }
    if (barIdx < 2) return null;
    const twoBarHigh = Math.max(bars[barIdx - 1].high, bars[barIdx - 2].high);
    const atrArr = computeWilderATR(bars.slice(0, barIdx + 1));
    return ssInitStop(twoBarHigh, entryPrice, atrArr[barIdx]);
  }

  // ── COST HELPERS ───────────────────────────────────────────────────────────

  function entrySlippage(price, direction) {
    return direction === 'LONG' ? applySlippage(price, true) : applySlippage(price, false);
  }

  function exitSlippage(price, direction) {
    return direction === 'LONG' ? applySlippage(price, false) : applySlippage(price, true);
  }

  function commission(shares, price) {
    return calcCommission(shares, price);
  }

  // ── SIMULATION ─────────────────────────────────────────────────────────────
  console.log('\n[3] Running simulation...');

  let cash = NAV_INITIAL;
  const ledger = [];
  const positions = {};
  const waiting = {};
  const pendingReentry = {};
  let tradeSeq = 0;

  let totalEntries = 0, totalExitsFirstHour = 0, totalReentries = 0;
  let totalBEStopUps = 0, totalLotFills = 0, totalCycleRepeats = 0;
  let skippedNoCash = 0, skippedMaxPos = 0;
  let totalLongEntries = 0, totalShortEntries = 0;
  let totalBorrowCost = 0;

  function openPositionCount() {
    return Object.keys(positions).length;
  }

  function capitalDeployed() {
    let deployed = 0;
    for (const pos of Object.values(positions)) {
      deployed += pos.avgCost * pos.totalShares;
    }
    return deployed;
  }

  function recordEntry(ticker, type, shares, price, date, hour, stop, cycleNum, lotPlan, direction) {
    const comm = commission(shares, price);
    const cost = +(shares * price + comm).toFixed(2);
    cash -= cost;
    tradeSeq++;
    ledger.push({
      seq: tradeSeq, action: direction === 'SHORT' ? 'SHORT' : 'BUY', type,
      ticker, shares, price: +price.toFixed(2), cost, commission: comm,
      stop: +stop.toFixed(2), date, hour: hour || '', cashAfter: +cash.toFixed(2),
      cycleNum, lotPlan: lotPlan ? lotPlan.join('/') : '', direction,
    });
    return tradeSeq;
  }

  function recordLotFill(ticker, lotNum, shares, price, date, hour, newAvg, newStop, direction) {
    const comm = commission(shares, price);
    const cost = +(shares * price + comm).toFixed(2);
    cash -= cost;
    tradeSeq++;
    ledger.push({
      seq: tradeSeq, action: `LOT${lotNum}`, type: 'PYRAMID',
      ticker, shares, price: +price.toFixed(2), cost, commission: comm,
      stop: +(newStop || 0).toFixed(2), date, hour: hour || '',
      cashAfter: +cash.toFixed(2), newAvg: +newAvg.toFixed(2), direction,
    });
  }

  function recordExit(ticker, phase, shares, exitPrice, avgCost, date, hour, cycleNum, peakProfit, direction, entryDate) {
    const comm = commission(shares, exitPrice);
    let pnl;
    if (direction === 'SHORT') {
      const tradingDays = countTradingDays(entryDate, date);
      const sector = getSectorName(ticker);
      const borrow = calcBorrowCost(shares, avgCost, tradingDays, sector);
      totalBorrowCost += borrow;
      pnl = +(shares * (avgCost - exitPrice) - comm - borrow).toFixed(2);
      cash += +(shares * avgCost + pnl).toFixed(2);
    } else {
      const proceeds = +(shares * exitPrice - comm).toFixed(2);
      pnl = +(proceeds - shares * avgCost).toFixed(2);
      cash += proceeds;
    }
    tradeSeq++;
    ledger.push({
      seq: tradeSeq, action: direction === 'SHORT' ? 'COVER' : 'SELL', type: phase,
      ticker, shares, price: +exitPrice.toFixed(2), commission: comm,
      avgCost: +avgCost.toFixed(2), pnl, date, hour: hour || '',
      cashAfter: +cash.toFixed(2), cycleNum, peakProfit: +(peakProfit || 0).toFixed(2),
      direction,
    });
    return pnl;
  }

  function countTradingDays(fromDate, toDate) {
    const from = hourlyTradingDates.indexOf(fromDate);
    const to = hourlyTradingDates.indexOf(toDate);
    if (from < 0 || to < 0) return Math.max(1, Math.round((new Date(toDate) - new Date(fromDate)) / 86400000 * 5/7));
    return Math.max(1, to - from);
  }

  // ── DAY LOOP ──────────────────────────────────────────────────────────────
  for (let dayIdx = 0; dayIdx < hourlyTradingDates.length; dayIdx++) {
    const date = hourlyTradingDates[dayIdx];

    const dayHourly = {};
    for (const [t, bars] of Object.entries(hourlyBarMap)) {
      const db = bars.filter(b => b.date.startsWith(date));
      if (db.length) dayHourly[t] = db;
    }

    // ═══ PHASE A: Process existing positions ═══
    for (const [ticker, pos] of Object.entries(positions)) {
      const hBars = dayHourly[ticker];
      if (!hBars || !hBars.length) continue;

      const isLong = pos.direction === 'LONG';
      const firstHourBars = hBars.filter(b => extractTime(b.date) < FIRST_HOUR_END);
      const afterFirstHour = hBars.filter(b => extractTime(b.date) >= FIRST_HOUR_END);

      const firstHourLow = firstHourBars.length
        ? Math.min(...firstHourBars.map(b => b.low))
        : null;
      const firstHourHigh = firstHourBars.length
        ? Math.max(...firstHourBars.map(b => b.high))
        : null;

      let runningLow = firstHourLow ?? Infinity;
      let runningHigh = firstHourHigh ?? -Infinity;

      // Process first-hour bars: check existing stop only
      for (const hBar of firstHourBars) {
        if (!positions[ticker]) break;
        if (hBar.low < runningLow) runningLow = hBar.low;
        if (hBar.high > runningHigh) runningHigh = hBar.high;

        if (isLong && pos.stop != null && hBar.low <= pos.stop) {
          const exitP = exitSlippage(pos.stop, 'LONG');
          recordExit(ticker, 'STOP_HIT_1H', pos.totalShares, exitP, pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak, 'LONG', pos.entryDate);
          waiting[ticker] = {
            originalEntry: pos.originalEntry, exitPrice: exitP, exitDate: date,
            exitHour: hBar.date, runningLow, runningHigh, cycleNum: pos.cycleNum + 1,
            direction: 'LONG',
          };
          delete positions[ticker];
          break;
        }
        if (!isLong && pos.stop != null && hBar.high >= pos.stop) {
          const exitP = exitSlippage(pos.stop, 'SHORT');
          recordExit(ticker, 'STOP_HIT_1H', pos.totalShares, exitP, pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak, 'SHORT', pos.entryDate);
          waiting[ticker] = {
            originalEntry: pos.originalEntry, exitPrice: exitP, exitDate: date,
            exitHour: hBar.date, runningLow, runningHigh, cycleNum: pos.cycleNum + 1,
            direction: 'SHORT',
          };
          delete positions[ticker];
          break;
        }

        const unr = isLong
          ? (hBar.high - pos.avgCost) * pos.totalShares
          : (pos.avgCost - hBar.low) * pos.totalShares;
        if (unr > (pos.peak || 0)) pos.peak = +unr.toFixed(2);

        if (!pos.atBE && unr >= BE_PROFIT_THRESHOLD) {
          pos.atBE = true;
          const feePer = commission(pos.totalShares, pos.avgCost) / pos.totalShares;
          pos.stop = isLong
            ? +(pos.avgCost + feePer).toFixed(2)
            : +(pos.avgCost - feePer).toFixed(2);
          totalBEStopUps++;
        }
      }

      if (!positions[ticker]) continue;

      // Process after-first-hour bars
      for (const hBar of afterFirstHour) {
        if (!positions[ticker]) break;
        if (hBar.low < runningLow) runningLow = hBar.low;
        if (hBar.high > runningHigh) runningHigh = hBar.high;

        // LONG: first-hour low break -> EXIT
        if (isLong && firstHourLow != null && hBar.low < firstHourLow) {
          const exitP = exitSlippage(firstHourLow, 'LONG');
          recordExit(ticker, '1H_LOW_BREAK', pos.totalShares, exitP, pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak, 'LONG', pos.entryDate);
          totalExitsFirstHour++;
          waiting[ticker] = {
            originalEntry: pos.originalEntry, exitPrice: exitP, exitDate: date,
            exitHour: hBar.date, runningLow: hBar.low, runningHigh, cycleNum: pos.cycleNum + 1,
            direction: 'LONG',
          };
          delete positions[ticker];
          break;
        }

        // SHORT: first-hour high break -> EXIT
        if (!isLong && firstHourHigh != null && hBar.high > firstHourHigh) {
          const exitP = exitSlippage(firstHourHigh, 'SHORT');
          recordExit(ticker, '1H_HIGH_BREAK', pos.totalShares, exitP, pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak, 'SHORT', pos.entryDate);
          totalExitsFirstHour++;
          waiting[ticker] = {
            originalEntry: pos.originalEntry, exitPrice: exitP, exitDate: date,
            exitHour: hBar.date, runningLow, runningHigh: hBar.high, cycleNum: pos.cycleNum + 1,
            direction: 'SHORT',
          };
          delete positions[ticker];
          break;
        }

        // Existing stop hit
        if (isLong && pos.stop != null && hBar.low <= pos.stop) {
          const phase = pos.atBE ? 'BE_STOP' : 'STOP_HIT';
          const exitP = exitSlippage(pos.stop, 'LONG');
          recordExit(ticker, phase, pos.totalShares, exitP, pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak, 'LONG', pos.entryDate);
          waiting[ticker] = {
            originalEntry: pos.originalEntry, exitPrice: exitP, exitDate: date,
            exitHour: hBar.date, runningLow, runningHigh, cycleNum: pos.cycleNum + 1,
            direction: 'LONG',
          };
          delete positions[ticker];
          break;
        }
        if (!isLong && pos.stop != null && hBar.high >= pos.stop) {
          const phase = pos.atBE ? 'BE_STOP' : 'STOP_HIT';
          const exitP = exitSlippage(pos.stop, 'SHORT');
          recordExit(ticker, phase, pos.totalShares, exitP, pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak, 'SHORT', pos.entryDate);
          waiting[ticker] = {
            originalEntry: pos.originalEntry, exitPrice: exitP, exitDate: date,
            exitHour: hBar.date, runningLow, runningHigh, cycleNum: pos.cycleNum + 1,
            direction: 'SHORT',
          };
          delete positions[ticker];
          break;
        }

        const unr = isLong
          ? (hBar.high - pos.avgCost) * pos.totalShares
          : (pos.avgCost - hBar.low) * pos.totalShares;
        if (unr > (pos.peak || 0)) pos.peak = +unr.toFixed(2);

        if (!pos.atBE && unr >= BE_PROFIT_THRESHOLD) {
          pos.atBE = true;
          const feePer = commission(pos.totalShares, pos.avgCost) / pos.totalShares;
          pos.stop = isLong
            ? +(pos.avgCost + feePer).toFixed(2)
            : +(pos.avgCost - feePer).toFixed(2);
          totalBEStopUps++;
        }

        // L2-L5 lot trigger fills
        if (pos.nextLot <= 4) {
          const offset = LOT_OFFSETS[pos.nextLot];
          const lotTrigger = isLong
            ? +(pos.originalEntry * (1 + offset)).toFixed(2)
            : +(pos.originalEntry * (1 - offset)).toFixed(2);

          const triggered = isLong ? hBar.high >= lotTrigger : hBar.low <= lotTrigger;
          if (triggered) {
            const lotShares = pos.lotPlan[pos.nextLot];
            const fillPrice = isLong
              ? entrySlippage(lotTrigger, 'LONG')
              : entrySlippage(lotTrigger, 'SHORT');
            const comm = commission(lotShares, fillPrice);
            const lotCost = lotShares * fillPrice + comm;

            if (cash >= lotCost) {
              const oldCost = pos.avgCost * pos.totalShares;
              pos.totalShares += lotShares;
              pos.avgCost = +((oldCost + fillPrice * lotShares) / pos.totalShares).toFixed(4);
              const lotNum = pos.nextLot + 1;
              pos.nextLot++;
              totalLotFills++;

              let newStop = pos.stop;
              if (pos.atBE) {
                const feePer = commission(pos.totalShares, pos.avgCost) / pos.totalShares;
                pos.stop = isLong
                  ? +(pos.avgCost + feePer).toFixed(2)
                  : +(pos.avgCost - feePer).toFixed(2);
                newStop = pos.stop;
              }

              recordLotFill(ticker, lotNum, lotShares, fillPrice, date, hBar.date, pos.avgCost, newStop, pos.direction);
            }
          }
        }
      }
    }

    // ═══ PHASE B-1: Execute pending re-entries from PREVIOUS bar's signal ═══
    for (const [ticker, pend] of Object.entries(pendingReentry)) {
      if (positions[ticker]) { delete pendingReentry[ticker]; continue; }
      const hBars = dayHourly[ticker];
      if (!hBars || !hBars.length) { delete pendingReentry[ticker]; continue; }

      if (openPositionCount() >= MAX_POSITIONS) { skippedMaxPos++; delete pendingReentry[ticker]; continue; }

      const direction = pend.direction;
      const isLong = direction === 'LONG';
      const firstAfterOpen = hBars.find(b => extractTime(b.date) >= FIRST_HOUR_END) || hBars[0];
      const rePrice = isLong
        ? entrySlippage(firstAfterOpen.open, 'LONG')
        : entrySlippage(firstAfterOpen.open, 'SHORT');

      const reStop = isLong
        ? +(pend.runningLow - 0.01).toFixed(2)
        : +(pend.runningHigh + 0.01).toFixed(2);

      if (isLong && reStop >= rePrice) { delete pendingReentry[ticker]; continue; }
      if (!isLong && reStop <= rePrice) { delete pendingReentry[ticker]; continue; }

      const rps = isLong ? rePrice - reStop : reStop - rePrice;
      if (rps <= 0.01) { delete pendingReentry[ticker]; continue; }

      const maxShares = Math.floor(MAX_LOSS / rps);
      if (maxShares < 1) { delete pendingReentry[ticker]; continue; }

      const nav = cash + capitalDeployed();
      const vitalityShares = Math.floor((nav * VITALITY_PCT) / rps);
      const capShares = Math.floor((nav * TICKER_CAP_PCT) / rePrice);
      const totalShares = Math.min(maxShares, vitalityShares, capShares);
      if (totalShares < 1) { delete pendingReentry[ticker]; continue; }

      const l1 = Math.max(1, Math.round(totalShares * STRIKE_PCT[0]));
      const lotPlan = STRIKE_PCT.map(p => Math.max(1, Math.round(totalShares * p)));
      const entryCost = l1 * rePrice + commission(l1, rePrice);

      if (cash < entryCost) { skippedNoCash++; delete pendingReentry[ticker]; continue; }

      recordEntry(ticker, 'REENTRY', l1, rePrice, date, firstAfterOpen.date, reStop, pend.cycleNum, lotPlan, direction);

      positions[ticker] = {
        ticker, entryPrice: rePrice, avgCost: rePrice, entryDate: date,
        originalEntry: pend.originalEntry || rePrice,
        totalShares: l1, lotPlan,
        stop: reStop, atBE: false, peak: 0, nextLot: 1,
        cycleNum: pend.cycleNum, isReentry: true, direction,
      };

      totalReentries++;
      if (direction === 'LONG') totalLongEntries++; else totalShortEntries++;
      if (pend.cycleNum > 1) totalCycleRepeats++;
      delete pendingReentry[ticker];
    }

    // ═══ PHASE B-2: Check for re-entry SIGNALS (queue for next bar's open) ═══
    for (const [ticker, w] of Object.entries(waiting)) {
      if (positions[ticker] || pendingReentry[ticker]) { delete waiting[ticker]; continue; }

      const hBars = dayHourly[ticker];
      if (!hBars || hBars.length < 2) continue;

      const direction = w.direction;
      const isLong = direction === 'LONG';

      if (isLong && !isActiveBL(ticker, date)) { delete waiting[ticker]; continue; }
      if (!isLong && !isActiveSS(ticker, date)) { delete waiting[ticker]; continue; }

      const regime = getRegime(ticker, date);
      if (isLong && !regime) continue;
      if (!isLong && regime) continue;
      if (!getSectorOk(ticker, date)) continue;

      const afterFirst = hBars.filter(b => extractTime(b.date) >= FIRST_HOUR_END);
      if (afterFirst.length < 2) continue;

      for (let i = 1; i < afterFirst.length; i++) {
        const bar = afterFirst[i];
        const prevBar = afterFirst[i - 1];

        if (bar.low < w.runningLow) w.runningLow = bar.low;
        if (bar.high > w.runningHigh) w.runningHigh = bar.high;

        const confirmed = isLong
          ? isConfirmedGreenBreakout(bar, prevBar)
          : isConfirmedRedBreakdown(bar, prevBar);

        if (!confirmed) continue;

        pendingReentry[ticker] = {
          originalEntry: w.originalEntry,
          runningLow: w.runningLow,
          runningHigh: w.runningHigh,
          cycleNum: w.cycleNum,
          direction,
          signalDate: date,
          signalBar: bar.date,
        };
        delete waiting[ticker];
        break;
      }
    }

    // ═══ PHASE C: New entries (MCE daily 2-bar breakout + hourly confirmation) ═══
    if (dayIdx >= 2) {
      const p1 = hourlyTradingDates[dayIdx - 1];
      const p2 = hourlyTradingDates[dayIdx - 2];

      const candidates = [];
      for (const ticker of Object.keys(signalsByTicker)) {
        if (positions[ticker] || waiting[ticker] || pendingReentry[ticker]) continue;
        if (!hourlyBarMap[ticker]) continue;

        const regime = getRegime(ticker, date);
        if (!getSectorOk(ticker, date)) continue;

        const bar = dailyBarMap[ticker]?.[date];
        const prev1 = dailyBarMap[ticker]?.[p1];
        const prev2 = dailyBarMap[ticker]?.[p2];
        if (!bar || !prev1 || !prev2) continue;

        const hBars = dayHourly[ticker];
        if (!hBars || hBars.length < 2) continue;
        const afterFirst = hBars.filter(b => extractTime(b.date) >= FIRST_HOUR_END);

        if (regime) {
          // BULL: long entries
          if (!isActiveBL(ticker, date)) continue;
          const trigger = Math.max(prev1.high, prev2.high) + 0.01;
          if (bar.high < trigger) continue;

          let hourlyConfirmed = false;
          for (let i = 1; i < afterFirst.length; i++) {
            if (isConfirmedGreenBreakout(afterFirst[i], afterFirst[i - 1])) {
              hourlyConfirmed = true; break;
            }
          }
          if (!hourlyConfirmed) continue;

          const ep = entrySlippage(Math.max(bar.open, trigger), 'LONG');
          const weeklyStop = getWeeklyStopLong(ticker, date, ep);
          if (!weeklyStop || weeklyStop >= ep) continue;
          const rps = ep - weeklyStop;
          if (rps <= 0.01) continue;
          candidates.push({ ticker, ep, stop: weeklyStop, rps, direction: 'LONG' });
        } else {
          // BEAR: short entries
          if (!isActiveSS(ticker, date)) continue;
          const trigger = Math.min(prev1.low, prev2.low) - 0.01;
          if (bar.low > trigger) continue;

          let hourlyConfirmed = false;
          for (let i = 1; i < afterFirst.length; i++) {
            if (isConfirmedRedBreakdown(afterFirst[i], afterFirst[i - 1])) {
              hourlyConfirmed = true; break;
            }
          }
          if (!hourlyConfirmed) continue;

          const ep = entrySlippage(Math.min(bar.open, trigger), 'SHORT');
          const weeklyStop = getWeeklyStopShort(ticker, date, ep);
          if (!weeklyStop || weeklyStop <= ep) continue;
          const rps = weeklyStop - ep;
          if (rps <= 0.01) continue;
          candidates.push({ ticker, ep, stop: weeklyStop, rps, direction: 'SHORT' });
        }
      }

      candidates.sort((a, b) => b.rps - a.rps);

      for (const c of candidates) {
        if (openPositionCount() >= MAX_POSITIONS) { skippedMaxPos++; continue; }

        const { ticker, ep, stop, rps, direction } = c;
        const isLong = direction === 'LONG';
        const nav = cash + capitalDeployed();
        const maxShares = Math.floor(MAX_LOSS / rps);
        const vitalityShares = Math.floor((nav * VITALITY_PCT) / rps);
        const capShares = Math.floor((nav * TICKER_CAP_PCT) / ep);
        const totalShares = Math.min(maxShares, vitalityShares, capShares);
        if (totalShares < 1) continue;

        const l1 = Math.max(1, Math.round(totalShares * STRIKE_PCT[0]));
        const lotPlan = STRIKE_PCT.map(p => Math.max(1, Math.round(totalShares * p)));
        const entryCost = l1 * ep + commission(l1, ep);

        if (cash < entryCost) { skippedNoCash++; continue; }

        recordEntry(ticker, 'NEW_MCE', l1, ep, date, '', stop, 0, lotPlan, direction);

        positions[ticker] = {
          ticker, entryPrice: ep, avgCost: ep, entryDate: date,
          originalEntry: ep,
          totalShares: l1, lotPlan,
          stop, atBE: false, peak: 0, nextLot: 1,
          cycleNum: 0, isReentry: false, direction,
        };

        totalEntries++;
        if (isLong) totalLongEntries++; else totalShortEntries++;
      }
    }
  }

  // Close remaining positions at last available price
  for (const [ticker, pos] of Object.entries(positions)) {
    const hBars = hourlyBarMap[ticker];
    if (!hBars || !hBars.length) continue;
    const last = hBars[hBars.length - 1];
    const exitP = exitSlippage(last.close, pos.direction);
    recordExit(ticker, 'OPEN_AT_END', pos.totalShares, exitP, pos.avgCost,
      last.date.split(' ')[0], last.date, pos.cycleNum, pos.peak, pos.direction, pos.entryDate);
  }

  // ── P&L SUMMARY ───────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(130));
  console.log('  P&L SUMMARY');
  console.log('='.repeat(130));

  const exits = ledger.filter(e => e.action === 'SELL' || e.action === 'COVER');
  const wins = exits.filter(e => e.pnl > 0);
  const losses = exits.filter(e => e.pnl < 0);
  const flat = exits.filter(e => e.pnl === 0);
  const grossWin = wins.reduce((s, e) => s + e.pnl, 0);
  const grossLoss = losses.reduce((s, e) => s + e.pnl, 0);
  const netPnl = grossWin + grossLoss;
  const pf = grossLoss ? grossWin / Math.abs(grossLoss) : 999;
  const wr = exits.length ? wins.length / exits.length : 0;
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(grossLoss / losses.length) : 1;
  const payoff = avgLoss > 0 ? avgWin / avgLoss : 999;

  let equity = NAV_INITIAL, peak = NAV_INITIAL, maxDD = 0;
  for (const e of exits.sort((a, b) => (a.date + a.hour).localeCompare(b.date + b.hour))) {
    equity += e.pnl;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  // Commission totals
  const totalCommissions = ledger.reduce((s, e) => s + (e.commission || 0), 0);

  // Slippage estimate (entries + exits × 5bps each)
  const entryLegs = ledger.filter(e => e.action === 'BUY' || e.action === 'SHORT' || e.action.startsWith('LOT'));
  const exitLegs = exits;
  const totalSlippageEst = [...entryLegs, ...exitLegs].reduce((s, e) => {
    return s + Math.abs(e.shares || 0) * Math.abs(e.price || 0) * (SLIPPAGE_BPS / 10000);
  }, 0);

  // ── ADVANCED METRICS ──────────────────────────────────────────────────────
  const dailyReturns = [];
  let dailyEquity = NAV_INITIAL;
  let posMonths = 0, totalMonths = 0;
  let monthPnl = 0, currentMonth = '';

  for (const date of hourlyTradingDates) {
    const dayExits = exits.filter(e => e.date === date);
    const dayPnl = dayExits.reduce((s, e) => s + e.pnl, 0);
    const prevEquity = dailyEquity;
    dailyEquity += dayPnl;
    if (prevEquity > 0) dailyReturns.push(dayPnl / prevEquity);

    const month = date.slice(0, 7);
    if (month !== currentMonth) {
      if (currentMonth) {
        totalMonths++;
        if (monthPnl > 0) posMonths++;
      }
      currentMonth = month;
      monthPnl = 0;
    }
    monthPnl += dayPnl;
  }
  if (currentMonth) {
    totalMonths++;
    if (monthPnl > 0) posMonths++;
  }

  const avgDailyRet = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
  const dailyStdDev = Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avgDailyRet) ** 2, 0) / (dailyReturns.length - 1));
  const downsideReturns = dailyReturns.filter(r => r < 0);
  const downsideStdDev = downsideReturns.length > 1
    ? Math.sqrt(downsideReturns.reduce((s, r) => s + r ** 2, 0) / (downsideReturns.length - 1))
    : 0.0001;

  const annualFactor = Math.sqrt(252);
  const sharpe = (avgDailyRet / dailyStdDev) * annualFactor;
  const sortino = (avgDailyRet / downsideStdDev) * annualFactor;

  const firstDate = new Date(hourlyTradingDates[0] + 'T12:00:00');
  const lastDate = new Date(hourlyTradingDates[hourlyTradingDates.length - 1] + 'T12:00:00');
  const yearsElapsed = (lastDate - firstDate) / (365.25 * 24 * 60 * 60 * 1000);
  const cagr = (Math.pow(equity / NAV_INITIAL, 1 / yearsElapsed) - 1) * 100;
  const calmar = maxDD > 0 ? cagr / (maxDD * 100) : 999;
  const maxDDDollar = maxDD * peak;
  const recoveryFactor = maxDDDollar > 0 ? netPnl / maxDDDollar : 999;
  const netReturn = ((equity - NAV_INITIAL) / NAV_INITIAL) * 100;

  console.log(`\n  RISK-ADJUSTED METRICS`);
  console.log(`  ${'─'.repeat(50)}`);
  console.log(`  Net Total Return:         ${netReturn >= 0 ? '+' : ''}${netReturn.toFixed(2)}%`);
  console.log(`  CAGR:                     ${cagr >= 0 ? '+' : ''}${cagr.toFixed(2)}%`);
  console.log(`  Sharpe Ratio:             ${sharpe.toFixed(2)}`);
  console.log(`  Sortino Ratio:            ${sortino.toFixed(2)}`);
  console.log(`  Calmar Ratio:             ${calmar.toFixed(2)}`);
  console.log(`  Recovery Factor:          ${recoveryFactor.toFixed(1)}x`);
  console.log(`  Positive Months:          ${posMonths}/${totalMonths} (${totalMonths ? (posMonths / totalMonths * 100).toFixed(1) : 0}%)`);
  console.log(`  Years:                    ${yearsElapsed.toFixed(2)}`);
  console.log(`  Trading Days:             ${hourlyTradingDates.length}`);

  console.log(`\n  CAPITAL TRACKING`);
  console.log(`  ${'─'.repeat(50)}`);
  console.log(`  Starting Cash:            $${NAV_INITIAL.toLocaleString()}`);
  console.log(`  Final Cash:               $${cash.toFixed(2)}`);
  console.log(`  Max Positions Allowed:    ${MAX_POSITIONS}`);
  console.log(`  Skipped (no cash):        ${skippedNoCash}`);
  console.log(`  Skipped (max positions):  ${skippedMaxPos}`);

  console.log(`\n  FRICTION COSTS`);
  console.log(`  ${'─'.repeat(50)}`);
  console.log(`  Total Commissions:        $${totalCommissions.toFixed(2)}`);
  console.log(`  Total Slippage (est):     $${totalSlippageEst.toFixed(2)}`);
  console.log(`  Total Borrow Cost:        $${totalBorrowCost.toFixed(2)}`);
  console.log(`  Total Friction:           $${(totalCommissions + totalSlippageEst + totalBorrowCost).toFixed(2)}`);

  console.log(`\n  ACTIVITY`);
  console.log(`  ${'─'.repeat(50)}`);
  console.log(`  New entries:              ${totalEntries}`);
  console.log(`  Long entries:             ${totalLongEntries}`);
  console.log(`  Short entries:            ${totalShortEntries}`);
  console.log(`  First-hour exits:         ${totalExitsFirstHour}`);
  console.log(`  Re-entries (confirmed):   ${totalReentries}`);
  console.log(`  Cycle repeats:            ${totalCycleRepeats}`);
  console.log(`  Break Even ratchets:      ${totalBEStopUps}`);
  console.log(`  Lot fills (L2-L5):        ${totalLotFills}`);

  console.log(`\n  P&L`);
  console.log(`  ${'─'.repeat(50)}`);
  console.log(`  Net P&L:                  $${netPnl.toFixed(2)}`);
  console.log(`  Gross Win:                $${grossWin.toFixed(2)}`);
  console.log(`  Gross Loss:               $${grossLoss.toFixed(2)}`);
  console.log(`  Profit Factor:            ${pf.toFixed(2)}x`);
  console.log(`  Win Rate:                 ${(wr * 100).toFixed(1)}%`);
  console.log(`  Avg Win:                  $${avgWin.toFixed(2)}`);
  console.log(`  Avg Loss:                 $${avgLoss.toFixed(2)}`);
  console.log(`  Payoff Ratio:             ${payoff.toFixed(2)}x`);
  console.log(`  Max Drawdown:             ${(maxDD * 100).toFixed(2)}%`);
  console.log(`  Ending Equity:            $${equity.toFixed(2)}`);
  console.log(`  Total Closed Trades:      ${exits.length} (${wins.length}W / ${losses.length}L / ${flat.length}F)`);

  const longExits = exits.filter(e => e.direction === 'LONG');
  const shortExits = exits.filter(e => e.direction === 'SHORT');
  const longPnl = longExits.reduce((s, e) => s + e.pnl, 0);
  const shortPnl = shortExits.reduce((s, e) => s + e.pnl, 0);
  console.log(`  Long Trades:              ${longExits.length}  P&L: $${longPnl.toFixed(2)}`);
  console.log(`  Short Trades:             ${shortExits.length}  P&L: $${shortPnl.toFixed(2)}`);

  const bigWin = wins.length ? wins.reduce((best, e) => e.pnl > best.pnl ? e : best) : null;
  const bigLoss = losses.length ? losses.reduce((worst, e) => e.pnl < worst.pnl ? e : worst) : null;
  if (bigWin) console.log(`  Biggest Win:              $${bigWin.pnl.toFixed(2)} (${bigWin.ticker} ${bigWin.date})`);
  if (bigLoss) console.log(`  Biggest Loss:             $${bigLoss.pnl.toFixed(2)} (${bigLoss.ticker} ${bigLoss.date})`);

  // ── EXIT BREAKDOWN ────────────────────────────────────────────────────────
  const byType = {};
  for (const e of exits) {
    if (!byType[e.type]) byType[e.type] = { count: 0, pnl: 0 };
    byType[e.type].count++;
    byType[e.type].pnl += e.pnl;
  }
  console.log(`\n  EXIT BREAKDOWN`);
  console.log(`  ${'─'.repeat(50)}`);
  for (const [type, stats] of Object.entries(byType).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${type.padEnd(20)} ${String(stats.count).padStart(5)} trades   P&L: $${stats.pnl.toFixed(2)}`);
  }

  // ── SIDE-BY-SIDE V5 vs V6 vs AI 300 WEEKLY ────────────────────────────────
  console.log(`\n  ${'═'.repeat(90)}`);
  console.log(`  SIDE-BY-SIDE COMPARISON: AMBUSH V5 vs V6 vs AI 300 WEEKLY`);
  console.log(`  ${'═'.repeat(90)}`);
  console.log(`  ${'Metric'.padEnd(25)} ${'V5 (ideal)'.padStart(16)} ${'V6 (realistic)'.padStart(16)} ${'AI 300 Weekly'.padStart(16)}`);
  console.log(`  ${'─'.repeat(73)}`);
  console.log(`  ${'Net Return'.padEnd(25)} ${'+1936.67%'.padStart(16)} ${(netReturn >= 0 ? '+' : '') + netReturn.toFixed(2) + '%'} ${''.padStart(16 - ('+487.77%').length)}${'+487.77%'}`);
  console.log(`  ${'CAGR'.padEnd(25)} ${'+132.46%'.padStart(16)} ${(cagr >= 0 ? '+' : '') + cagr.toFixed(2) + '%'} ${''.padStart(16 - ('+49.90%').length)}${'+49.90%'}`);
  console.log(`  ${'Sharpe'.padEnd(25)} ${'8.90'.padStart(16)} ${sharpe.toFixed(2).padStart(16)} ${'1.33'.padStart(16)}`);
  console.log(`  ${'Sortino'.padEnd(25)} ${'53.41'.padStart(16)} ${sortino.toFixed(2).padStart(16)} ${'2.19'.padStart(16)}`);
  console.log(`  ${'Calmar'.padEnd(25)} ${'140.14'.padStart(16)} ${calmar.toFixed(2).padStart(16)} ${'1.81'.padStart(16)}`);
  console.log(`  ${'Recovery Factor'.padEnd(25)} ${'100.6x'.padStart(16)} ${recoveryFactor.toFixed(1) + 'x'} ${'18.0x'.padStart(16)}`);
  console.log(`  ${'Profit Factor'.padEnd(25)} ${'10.25x'.padStart(16)} ${pf.toFixed(2) + 'x'} ${'2.84x'.padStart(16)}`);
  console.log(`  ${'Win Rate'.padEnd(25)} ${'48.3%'.padStart(16)} ${(wr * 100).toFixed(1) + '%'} ${'34.0%'.padStart(16)}`);
  console.log(`  ${'Payoff Ratio'.padEnd(25)} ${'10.98x'.padStart(16)} ${payoff.toFixed(2) + 'x'} ${'5.50x'.padStart(16)}`);
  console.log(`  ${'Max Drawdown'.padEnd(25)} ${'0.95%'.padStart(16)} ${(maxDD * 100).toFixed(2) + '%'} ${'27.50%'.padStart(16)}`);
  console.log(`  ${'Positive Months'.padEnd(25)} ${'100.0%'.padStart(16)} ${totalMonths ? (posMonths / totalMonths * 100).toFixed(1) + '%' : 'N/A'} ${'52.8%'.padStart(16)}`);
  console.log(`  ${'Ending Equity'.padEnd(25)} ${'$2,036,672'.padStart(16)} ${'$' + Math.round(equity).toLocaleString()} ${'$588,000'.padStart(16)}`);

  // ── TOP/BOTTOM TICKERS ────────────────────────────────────────────────────
  const tickerStats = {};
  for (const e of exits) {
    if (!tickerStats[e.ticker]) tickerStats[e.ticker] = { pnl: 0, trades: 0, wins: 0 };
    tickerStats[e.ticker].pnl += e.pnl;
    tickerStats[e.ticker].trades++;
    if (e.pnl > 0) tickerStats[e.ticker].wins++;
  }
  const tickerArr = Object.entries(tickerStats).map(([ticker, s]) => ({ ticker, ...s }));
  tickerArr.sort((a, b) => b.pnl - a.pnl);

  console.log(`\n  TOP 15 TICKERS BY NET P&L`);
  console.log(`  ${'─'.repeat(60)}`);
  console.log(`  ${'#'.padStart(3)} ${'Ticker'.padEnd(7)} ${'Net P&L'.padStart(10)} ${'Trades'.padStart(7)} ${'Wins'.padStart(5)} ${'WR'.padStart(6)}`);
  for (let i = 0; i < Math.min(15, tickerArr.length); i++) {
    const s = tickerArr[i];
    console.log(`  ${String(i + 1).padStart(3)} ${s.ticker.padEnd(7)} $${s.pnl.toFixed(2).padStart(9)} ${String(s.trades).padStart(7)} ${String(s.wins).padStart(5)} ${(s.trades ? (s.wins / s.trades * 100).toFixed(0) : 0).toString().padStart(5)}%`);
  }

  console.log(`\n  BOTTOM 10 TICKERS BY NET P&L`);
  console.log(`  ${'─'.repeat(60)}`);
  const bottom = [...tickerArr].sort((a, b) => a.pnl - b.pnl).slice(0, 10);
  for (let i = 0; i < bottom.length; i++) {
    const s = bottom[i];
    console.log(`  ${String(i + 1).padStart(3)} ${s.ticker.padEnd(7)} $${s.pnl.toFixed(2).padStart(9)} ${String(s.trades).padStart(7)} ${String(s.wins).padStart(5)} ${(s.trades ? (s.wins / s.trades * 100).toFixed(0) : 0).toString().padStart(5)}%`);
  }

  console.log('\n' + '='.repeat(130));
  console.log('  PNTHR AMBUSH V6 BACKTEST COMPLETE');
  console.log('='.repeat(130));

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
