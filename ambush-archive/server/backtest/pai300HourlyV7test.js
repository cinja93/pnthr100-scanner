// server/backtest/pai300HourlyV7test.js
// ── PNTHR AMBUSH V7 — TRAILING STOP TEST MATRIX ─────────────────────────
//
// Tests 8 combinations:
//   Break Even threshold: $25, $50, $75, $100
//   Exit mode: 1-bar break vs 2-consecutive-lower-lows
//
// Trailing stop design (after Break Even is met):
//   - Each day's first-hour low becomes the new stop (if higher than current)
//   - Stop ratchets up day over day, locking in profits
//   - For shorts: first-hour HIGH ratchets down
//
// Data loaded ONCE, simulation runs 8 times with different params.
//
// Usage: cd server && node backtest/pai300HourlyV7test.js
// ────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { connectToDatabase } from '../database.js';
import { SECTORS } from '../scripts/aiUniverse/aiUniverseData.js';
import { SECTOR_EMA_PERIODS } from '../data/pnthrAiSectorsConfig.js';
import { CARNIVORE_MODE_TICKERS } from '../data/strategyMode.js';
import { detectAllSignals, calculateEMA, blInitStop, ssInitStop, computeWilderATR } from '../signalDetection.js';
import { calcCommission, calcBorrowCost } from './costEngine.js';

const NAV_INITIAL     = 100_000;
const VITALITY_PCT    = 0.01;
const TICKER_CAP_PCT  = 0.10;
const STRIKE_PCT      = [0.35, 0.25, 0.20, 0.12, 0.08];
const LOT_OFFSETS     = [0, 0.03, 0.06, 0.10, 0.14];
const MAX_LOSS        = 300;
const PAI300_REGIME_PERIOD = 36;
const FIRST_HOUR_END  = '10:30';
const MAX_POSITIONS   = 100;
const SLIPPAGE_BPS    = 5;

const BE_THRESHOLDS   = [25, 50, 75, 100];
const EXIT_MODES      = ['1BAR', '2BAR'];

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
  return bar.close > bar.open && bar.high > prevBar.high && bar.close > prevBar.high;
}

function isConfirmedRedBreakdown(bar, prevBar) {
  if (!prevBar) return false;
  return bar.close < bar.open && bar.low < prevBar.low && bar.close < prevBar.low;
}

function applySlippage(price, adverse) {
  const slip = price * (SLIPPAGE_BPS / 10000);
  return adverse ? +(price + slip).toFixed(4) : +(price - slip).toFixed(4);
}

function entrySlip(price, dir) { return dir === 'LONG' ? applySlippage(price, true) : applySlippage(price, false); }
function exitSlip(price, dir) { return dir === 'LONG' ? applySlippage(price, false) : applySlippage(price, true); }
function comm(shares, price) { return calcCommission(shares, price); }

async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('No DB'); process.exit(1); }

  console.log('='.repeat(130));
  console.log('  PNTHR AMBUSH V7 — TRAILING STOP TEST MATRIX');
  console.log('  8 scenarios: 4 Break Even thresholds × 2 exit modes');
  console.log('='.repeat(130));

  // ── LOAD DATA (once) ──────────────────────────────────────────────────────
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

  console.log(`  Hourly: ${hourlyMinDate} to ${hourlyMaxDate} (${hourlyTradingDates.length} days)`);
  console.log(`  Tickers: ${Object.keys(hourlyBarMap).length}`);

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

    const activeBLPeriods = [], activeSSPeriods = [];
    let blStart = null, ssStart = null;
    for (const evt of result.events) {
      if (evt.signal === 'BL') blStart = evt.time;
      if ((evt.signal === 'BE' || evt.signal === 'SS') && blStart) {
        activeBLPeriods.push({ from: blStart, to: evt.time }); blStart = null;
      }
      if (evt.signal === 'SS') ssStart = evt.time;
      if ((evt.signal === 'SE' || evt.signal === 'BL') && ssStart) {
        activeSSPeriods.push({ from: ssStart, to: evt.time }); ssStart = null;
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
      return tiers?.[sectorId] !== 'AVOID';
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
    const sig = signalsByTicker[ticker]; if (!sig) return false;
    const weekOf = getWeekOf(dateStr);
    for (const p of sig.activeBLPeriods) { if (weekOf >= p.from && weekOf <= p.to) return true; }
    return false;
  }

  function isActiveSS(ticker, dateStr) {
    const sig = signalsByTicker[ticker]; if (!sig) return false;
    const weekOf = getWeekOf(dateStr);
    for (const p of sig.activeSSPeriods) { if (weekOf >= p.from && weekOf <= p.to) return true; }
    return false;
  }

  function getWeeklyStopLong(ticker, dateStr, entryPrice) {
    const bars = weeklyBarsByTicker[ticker]; if (!bars) return null;
    const weekOf = getWeekOf(dateStr);
    let barIdx = -1;
    for (let i = bars.length - 1; i >= 0; i--) { if (bars[i].time <= weekOf) { barIdx = i; break; } }
    if (barIdx < 2) return null;
    const twoBarLow = Math.min(bars[barIdx - 1].low, bars[barIdx - 2].low);
    const atrArr = computeWilderATR(bars.slice(0, barIdx + 1));
    return blInitStop(twoBarLow, entryPrice, atrArr[barIdx]);
  }

  function getWeeklyStopShort(ticker, dateStr, entryPrice) {
    const bars = weeklyBarsByTicker[ticker]; if (!bars) return null;
    const weekOf = getWeekOf(dateStr);
    let barIdx = -1;
    for (let i = bars.length - 1; i >= 0; i--) { if (bars[i].time <= weekOf) { barIdx = i; break; } }
    if (barIdx < 2) return null;
    const twoBarHigh = Math.max(bars[barIdx - 1].high, bars[barIdx - 2].high);
    const atrArr = computeWilderATR(bars.slice(0, barIdx + 1));
    return ssInitStop(twoBarHigh, entryPrice, atrArr[barIdx]);
  }

  function countTradingDays(fromDate, toDate) {
    const from = hourlyTradingDates.indexOf(fromDate);
    const to = hourlyTradingDates.indexOf(toDate);
    if (from < 0 || to < 0) return Math.max(1, Math.round((new Date(toDate) - new Date(fromDate)) / 86400000 * 5/7));
    return Math.max(1, to - from);
  }

  // ── RUN SIMULATION FOR ONE PARAMETER SET ──────────────────────────────────

  function runSim(beThreshold, exitMode) {
    let cash = NAV_INITIAL;
    const exits = [];
    const positions = {};
    const waiting = {};
    const pendingReentry = {};

    let totalEntries = 0, totalExits1H = 0, totalReentries = 0;
    let totalBEStopUps = 0, totalLotFills = 0, totalCycleRepeats = 0;
    let skippedNoCash = 0, skippedMaxPos = 0;
    let totalLongEntries = 0, totalShortEntries = 0;
    let totalBorrow = 0, totalComm = 0;
    let totalTrailingExits = 0;

    function openCount() { return Object.keys(positions).length; }
    function deployed() {
      let d = 0; for (const p of Object.values(positions)) d += p.avgCost * p.totalShares; return d;
    }

    function doEntry(ticker, type, shares, price, stop, date, hour, cycleNum, lotPlan, direction) {
      const c = comm(shares, price);
      totalComm += c;
      cash -= shares * price + c;
    }

    function doLotFill(ticker, lotShares, fillPrice, direction) {
      const c = comm(lotShares, fillPrice);
      totalComm += c;
      cash -= lotShares * fillPrice + c;
    }

    function doExit(ticker, phase, shares, exitPrice, avgCost, date, hour, cycleNum, peak, direction, entryDate) {
      const c = comm(shares, exitPrice);
      totalComm += c;
      let pnl;
      if (direction === 'SHORT') {
        const td = countTradingDays(entryDate, date);
        const sector = getSectorName(ticker);
        const borrow = calcBorrowCost(shares, avgCost, td, sector);
        totalBorrow += borrow;
        pnl = +(shares * (avgCost - exitPrice) - c - borrow).toFixed(2);
        cash += +(shares * avgCost + pnl).toFixed(2);
      } else {
        const proceeds = +(shares * exitPrice - c).toFixed(2);
        pnl = +(proceeds - shares * avgCost).toFixed(2);
        cash += proceeds;
      }
      exits.push({ pnl, date, hour, ticker, type: phase, direction });
      return pnl;
    }

    // ── DAY LOOP ────────────────────────────────────────────────────────────
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

        const firstHourLow = firstHourBars.length ? Math.min(...firstHourBars.map(b => b.low)) : null;
        const firstHourHigh = firstHourBars.length ? Math.max(...firstHourBars.map(b => b.high)) : null;

        // TRAILING STOP: update with today's first-hour low/high (if Break Even already met)
        if (pos.atBE && pos.trailingActive) {
          if (isLong && firstHourLow != null && firstHourLow > pos.stop) {
            pos.stop = +firstHourLow.toFixed(2);
          }
          if (!isLong && firstHourHigh != null && firstHourHigh < pos.stop) {
            pos.stop = +firstHourHigh.toFixed(2);
          }
        }

        let runningLow = firstHourLow ?? Infinity;
        let runningHigh = firstHourHigh ?? -Infinity;

        // Process first-hour bars: check stop only
        for (const hBar of firstHourBars) {
          if (!positions[ticker]) break;
          if (hBar.low < runningLow) runningLow = hBar.low;
          if (hBar.high > runningHigh) runningHigh = hBar.high;

          if (isLong && pos.stop != null && hBar.low <= pos.stop) {
            const ep = exitSlip(pos.stop, 'LONG');
            doExit(ticker, 'STOP_HIT_1H', pos.totalShares, ep, pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak, 'LONG', pos.entryDate);
            waiting[ticker] = { originalEntry: pos.originalEntry, exitPrice: ep, exitDate: date, exitHour: hBar.date, runningLow, runningHigh, cycleNum: pos.cycleNum + 1, direction: 'LONG' };
            delete positions[ticker]; break;
          }
          if (!isLong && pos.stop != null && hBar.high >= pos.stop) {
            const ep = exitSlip(pos.stop, 'SHORT');
            doExit(ticker, 'STOP_HIT_1H', pos.totalShares, ep, pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak, 'SHORT', pos.entryDate);
            waiting[ticker] = { originalEntry: pos.originalEntry, exitPrice: ep, exitDate: date, exitHour: hBar.date, runningLow, runningHigh, cycleNum: pos.cycleNum + 1, direction: 'SHORT' };
            delete positions[ticker]; break;
          }

          const unr = isLong
            ? (hBar.high - pos.avgCost) * pos.totalShares
            : (pos.avgCost - hBar.low) * pos.totalShares;
          if (unr > (pos.peak || 0)) pos.peak = +unr.toFixed(2);

          if (!pos.atBE && unr >= beThreshold) {
            pos.atBE = true;
            pos.trailingActive = false;
            const feePer = comm(pos.totalShares, pos.avgCost) / pos.totalShares;
            pos.stop = isLong ? +(pos.avgCost + feePer).toFixed(2) : +(pos.avgCost - feePer).toFixed(2);
            totalBEStopUps++;
          }
        }

        if (!positions[ticker]) continue;

        // Process after-first-hour bars
        let consecutiveLowerLows = 0;
        let prevBarLow = null;

        for (const hBar of afterFirstHour) {
          if (!positions[ticker]) break;
          if (hBar.low < runningLow) runningLow = hBar.low;
          if (hBar.high > runningHigh) runningHigh = hBar.high;

          // LONG: first-hour low break → exit (for positions NOT yet at Break Even)
          // For positions at Break Even with trailing active, the trailing stop handles it
          if (isLong && !pos.trailingActive && firstHourLow != null && hBar.low < firstHourLow) {
            const ep = exitSlip(firstHourLow, 'LONG');
            doExit(ticker, '1H_LOW_BREAK', pos.totalShares, ep, pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak, 'LONG', pos.entryDate);
            totalExits1H++;
            waiting[ticker] = { originalEntry: pos.originalEntry, exitPrice: ep, exitDate: date, exitHour: hBar.date, runningLow: hBar.low, runningHigh, cycleNum: pos.cycleNum + 1, direction: 'LONG' };
            delete positions[ticker]; break;
          }
          if (!isLong && !pos.trailingActive && firstHourHigh != null && hBar.high > firstHourHigh) {
            const ep = exitSlip(firstHourHigh, 'SHORT');
            doExit(ticker, '1H_HIGH_BREAK', pos.totalShares, ep, pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak, 'SHORT', pos.entryDate);
            totalExits1H++;
            waiting[ticker] = { originalEntry: pos.originalEntry, exitPrice: ep, exitDate: date, exitHour: hBar.date, runningLow, runningHigh: hBar.high, cycleNum: pos.cycleNum + 1, direction: 'SHORT' };
            delete positions[ticker]; break;
          }

          // TRAILING STOP CHECK (after Break Even, trailing is active)
          if (pos.trailingActive) {
            if (exitMode === '1BAR') {
              if (isLong && hBar.low <= pos.stop) {
                const ep = exitSlip(pos.stop, 'LONG');
                doExit(ticker, 'TRAILING_STOP', pos.totalShares, ep, pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak, 'LONG', pos.entryDate);
                totalTrailingExits++;
                waiting[ticker] = { originalEntry: pos.originalEntry, exitPrice: ep, exitDate: date, exitHour: hBar.date, runningLow, runningHigh, cycleNum: pos.cycleNum + 1, direction: 'LONG' };
                delete positions[ticker]; break;
              }
              if (!isLong && hBar.high >= pos.stop) {
                const ep = exitSlip(pos.stop, 'SHORT');
                doExit(ticker, 'TRAILING_STOP', pos.totalShares, ep, pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak, 'SHORT', pos.entryDate);
                totalTrailingExits++;
                waiting[ticker] = { originalEntry: pos.originalEntry, exitPrice: ep, exitDate: date, exitHour: hBar.date, runningLow, runningHigh, cycleNum: pos.cycleNum + 1, direction: 'SHORT' };
                delete positions[ticker]; break;
              }
            } else {
              // 2BAR mode: need 2 consecutive hourly bars with lower lows (long) / higher highs (short)
              if (isLong) {
                if (prevBarLow !== null && hBar.low < prevBarLow && hBar.low <= pos.stop) {
                  consecutiveLowerLows++;
                } else if (prevBarLow !== null && hBar.low < prevBarLow) {
                  consecutiveLowerLows = 1;
                } else {
                  consecutiveLowerLows = 0;
                }
                if (consecutiveLowerLows >= 2) {
                  const ep = exitSlip(pos.stop, 'LONG');
                  doExit(ticker, 'TRAILING_2BAR', pos.totalShares, ep, pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak, 'LONG', pos.entryDate);
                  totalTrailingExits++;
                  waiting[ticker] = { originalEntry: pos.originalEntry, exitPrice: ep, exitDate: date, exitHour: hBar.date, runningLow, runningHigh, cycleNum: pos.cycleNum + 1, direction: 'LONG' };
                  delete positions[ticker]; break;
                }
              } else {
                if (prevBarLow !== null && hBar.high > (pos._prevBarHigh || 0) && hBar.high >= pos.stop) {
                  pos._consecutiveHigherHighs = (pos._consecutiveHigherHighs || 0) + 1;
                } else if (prevBarLow !== null && hBar.high > (pos._prevBarHigh || 0)) {
                  pos._consecutiveHigherHighs = 1;
                } else {
                  pos._consecutiveHigherHighs = 0;
                }
                pos._prevBarHigh = hBar.high;
                if ((pos._consecutiveHigherHighs || 0) >= 2) {
                  const ep = exitSlip(pos.stop, 'SHORT');
                  doExit(ticker, 'TRAILING_2BAR', pos.totalShares, ep, pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak, 'SHORT', pos.entryDate);
                  totalTrailingExits++;
                  waiting[ticker] = { originalEntry: pos.originalEntry, exitPrice: ep, exitDate: date, exitHour: hBar.date, runningLow, runningHigh, cycleNum: pos.cycleNum + 1, direction: 'SHORT' };
                  delete positions[ticker]; break;
                }
              }
              prevBarLow = hBar.low;
            }
          }

          // Non-trailing stop hit (before Break Even)
          if (!pos.trailingActive) {
            if (isLong && pos.stop != null && hBar.low <= pos.stop) {
              const phase = pos.atBE ? 'BE_STOP' : 'STOP_HIT';
              const ep = exitSlip(pos.stop, 'LONG');
              doExit(ticker, phase, pos.totalShares, ep, pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak, 'LONG', pos.entryDate);
              waiting[ticker] = { originalEntry: pos.originalEntry, exitPrice: ep, exitDate: date, exitHour: hBar.date, runningLow, runningHigh, cycleNum: pos.cycleNum + 1, direction: 'LONG' };
              delete positions[ticker]; break;
            }
            if (!isLong && pos.stop != null && hBar.high >= pos.stop) {
              const phase = pos.atBE ? 'BE_STOP' : 'STOP_HIT';
              const ep = exitSlip(pos.stop, 'SHORT');
              doExit(ticker, phase, pos.totalShares, ep, pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak, 'SHORT', pos.entryDate);
              waiting[ticker] = { originalEntry: pos.originalEntry, exitPrice: ep, exitDate: date, exitHour: hBar.date, runningLow, runningHigh, cycleNum: pos.cycleNum + 1, direction: 'SHORT' };
              delete positions[ticker]; break;
            }
          }

          const unr = isLong
            ? (hBar.high - pos.avgCost) * pos.totalShares
            : (pos.avgCost - hBar.low) * pos.totalShares;
          if (unr > (pos.peak || 0)) pos.peak = +unr.toFixed(2);

          if (!pos.atBE && unr >= beThreshold) {
            pos.atBE = true;
            pos.trailingActive = false;
            const feePer = comm(pos.totalShares, pos.avgCost) / pos.totalShares;
            pos.stop = isLong ? +(pos.avgCost + feePer).toFixed(2) : +(pos.avgCost - feePer).toFixed(2);
            totalBEStopUps++;
          }

          // Activate trailing on the NEXT day after Break Even is first hit
          // (so today's first-hour low can be used as the first trailing level)
          if (pos.atBE && !pos.trailingActive && pos.beDate && pos.beDate !== date) {
            pos.trailingActive = true;
          }
          if (pos.atBE && !pos.beDate) {
            pos.beDate = date;
          }

          // L2-L5 lot triggers
          if (pos.nextLot <= 4) {
            const offset = LOT_OFFSETS[pos.nextLot];
            const lotTrigger = isLong
              ? +(pos.originalEntry * (1 + offset)).toFixed(2)
              : +(pos.originalEntry * (1 - offset)).toFixed(2);
            const triggered = isLong ? hBar.high >= lotTrigger : hBar.low <= lotTrigger;
            if (triggered) {
              const lotShares = pos.lotPlan[pos.nextLot];
              const fillPrice = isLong ? entrySlip(lotTrigger, 'LONG') : entrySlip(lotTrigger, 'SHORT');
              const c = comm(lotShares, fillPrice);
              const lotCost = lotShares * fillPrice + c;
              if (cash >= lotCost) {
                const oldCost = pos.avgCost * pos.totalShares;
                pos.totalShares += lotShares;
                pos.avgCost = +((oldCost + fillPrice * lotShares) / pos.totalShares).toFixed(4);
                pos.nextLot++;
                totalLotFills++;
                doLotFill(ticker, lotShares, fillPrice, pos.direction);
                if (pos.atBE) {
                  const feePer = comm(pos.totalShares, pos.avgCost) / pos.totalShares;
                  pos.stop = isLong ? +(pos.avgCost + feePer).toFixed(2) : +(pos.avgCost - feePer).toFixed(2);
                }
              }
            }
          }
        }
      }

      // ═══ PHASE B-1: Execute pending re-entries ═══
      for (const [ticker, pend] of Object.entries(pendingReentry)) {
        if (positions[ticker]) { delete pendingReentry[ticker]; continue; }
        const hBars = dayHourly[ticker];
        if (!hBars || !hBars.length) { delete pendingReentry[ticker]; continue; }
        if (openCount() >= MAX_POSITIONS) { skippedMaxPos++; delete pendingReentry[ticker]; continue; }

        const isLong = pend.direction === 'LONG';
        const firstAfterOpen = hBars.find(b => extractTime(b.date) >= FIRST_HOUR_END) || hBars[0];
        const rePrice = isLong ? entrySlip(firstAfterOpen.open, 'LONG') : entrySlip(firstAfterOpen.open, 'SHORT');
        const reStop = isLong ? +(pend.runningLow - 0.01).toFixed(2) : +(pend.runningHigh + 0.01).toFixed(2);
        if (isLong && reStop >= rePrice) { delete pendingReentry[ticker]; continue; }
        if (!isLong && reStop <= rePrice) { delete pendingReentry[ticker]; continue; }

        const rps = isLong ? rePrice - reStop : reStop - rePrice;
        if (rps <= 0.01) { delete pendingReentry[ticker]; continue; }
        const maxShares = Math.floor(MAX_LOSS / rps); if (maxShares < 1) { delete pendingReentry[ticker]; continue; }
        const nav = cash + deployed();
        const vitalityShares = Math.floor((nav * VITALITY_PCT) / rps);
        const capShares = Math.floor((nav * TICKER_CAP_PCT) / rePrice);
        const totalShares = Math.min(maxShares, vitalityShares, capShares);
        if (totalShares < 1) { delete pendingReentry[ticker]; continue; }
        const l1 = Math.max(1, Math.round(totalShares * STRIKE_PCT[0]));
        const lotPlan = STRIKE_PCT.map(p => Math.max(1, Math.round(totalShares * p)));
        const entryCost = l1 * rePrice + comm(l1, rePrice);
        if (cash < entryCost) { skippedNoCash++; delete pendingReentry[ticker]; continue; }

        doEntry(ticker, 'REENTRY', l1, rePrice, reStop, date, firstAfterOpen.date, pend.cycleNum, lotPlan, pend.direction);
        positions[ticker] = {
          ticker, entryPrice: rePrice, avgCost: rePrice, entryDate: date,
          originalEntry: pend.originalEntry || rePrice,
          totalShares: l1, lotPlan, stop: reStop, atBE: false, trailingActive: false,
          peak: 0, nextLot: 1, cycleNum: pend.cycleNum, direction: pend.direction,
        };
        totalReentries++;
        if (pend.direction === 'LONG') totalLongEntries++; else totalShortEntries++;
        if (pend.cycleNum > 1) totalCycleRepeats++;
        delete pendingReentry[ticker];
      }

      // ═══ PHASE B-2: Check re-entry signals (queue for next bar's open) ═══
      for (const [ticker, w] of Object.entries(waiting)) {
        if (positions[ticker] || pendingReentry[ticker]) { delete waiting[ticker]; continue; }
        const hBars = dayHourly[ticker]; if (!hBars || hBars.length < 2) continue;
        const isLong = w.direction === 'LONG';
        if (isLong && !isActiveBL(ticker, date)) { delete waiting[ticker]; continue; }
        if (!isLong && !isActiveSS(ticker, date)) { delete waiting[ticker]; continue; }
        const regime = getRegime(ticker, date);
        if (isLong && !regime) continue;
        if (!isLong && regime) continue;
        if (!getSectorOk(ticker, date)) continue;

        const afterFirst = hBars.filter(b => extractTime(b.date) >= FIRST_HOUR_END);
        if (afterFirst.length < 2) continue;

        for (let i = 1; i < afterFirst.length; i++) {
          const bar = afterFirst[i], prevBar = afterFirst[i - 1];
          if (bar.low < w.runningLow) w.runningLow = bar.low;
          if (bar.high > w.runningHigh) w.runningHigh = bar.high;
          const confirmed = isLong ? isConfirmedGreenBreakout(bar, prevBar) : isConfirmedRedBreakdown(bar, prevBar);
          if (!confirmed) continue;
          pendingReentry[ticker] = {
            originalEntry: w.originalEntry, runningLow: w.runningLow, runningHigh: w.runningHigh,
            cycleNum: w.cycleNum, direction: w.direction, signalDate: date,
          };
          delete waiting[ticker]; break;
        }
      }

      // ═══ PHASE C: New MCE entries ═══
      if (dayIdx >= 2) {
        const p1 = hourlyTradingDates[dayIdx - 1], p2 = hourlyTradingDates[dayIdx - 2];
        const candidates = [];
        for (const ticker of Object.keys(signalsByTicker)) {
          if (positions[ticker] || waiting[ticker] || pendingReentry[ticker]) continue;
          if (!hourlyBarMap[ticker]) continue;
          const regime = getRegime(ticker, date);
          if (!getSectorOk(ticker, date)) continue;
          const bar = dailyBarMap[ticker]?.[date], prev1 = dailyBarMap[ticker]?.[p1], prev2 = dailyBarMap[ticker]?.[p2];
          if (!bar || !prev1 || !prev2) continue;
          const hBars = dayHourly[ticker]; if (!hBars || hBars.length < 2) continue;
          const afterFirst = hBars.filter(b => extractTime(b.date) >= FIRST_HOUR_END);

          if (regime) {
            if (!isActiveBL(ticker, date)) continue;
            const trigger = Math.max(prev1.high, prev2.high) + 0.01;
            if (bar.high < trigger) continue;
            let ok = false;
            for (let i = 1; i < afterFirst.length; i++) { if (isConfirmedGreenBreakout(afterFirst[i], afterFirst[i - 1])) { ok = true; break; } }
            if (!ok) continue;
            const ep = entrySlip(Math.max(bar.open, trigger), 'LONG');
            const stop = getWeeklyStopLong(ticker, date, ep);
            if (!stop || stop >= ep) continue;
            const rps = ep - stop; if (rps <= 0.01) continue;
            candidates.push({ ticker, ep, stop, rps, direction: 'LONG' });
          } else {
            if (!isActiveSS(ticker, date)) continue;
            const trigger = Math.min(prev1.low, prev2.low) - 0.01;
            if (bar.low > trigger) continue;
            let ok = false;
            for (let i = 1; i < afterFirst.length; i++) { if (isConfirmedRedBreakdown(afterFirst[i], afterFirst[i - 1])) { ok = true; break; } }
            if (!ok) continue;
            const ep = entrySlip(Math.min(bar.open, trigger), 'SHORT');
            const stop = getWeeklyStopShort(ticker, date, ep);
            if (!stop || stop <= ep) continue;
            const rps = stop - ep; if (rps <= 0.01) continue;
            candidates.push({ ticker, ep, stop, rps, direction: 'SHORT' });
          }
        }

        candidates.sort((a, b) => b.rps - a.rps);

        for (const c of candidates) {
          if (openCount() >= MAX_POSITIONS) { skippedMaxPos++; continue; }
          const { ticker, ep, stop, rps, direction } = c;
          const isLong = direction === 'LONG';
          const nav = cash + deployed();
          const maxShares = Math.floor(MAX_LOSS / rps);
          const vitalityShares = Math.floor((nav * VITALITY_PCT) / rps);
          const capShares = Math.floor((nav * TICKER_CAP_PCT) / ep);
          const totalShares = Math.min(maxShares, vitalityShares, capShares);
          if (totalShares < 1) continue;
          const l1 = Math.max(1, Math.round(totalShares * STRIKE_PCT[0]));
          const lotPlan = STRIKE_PCT.map(p => Math.max(1, Math.round(totalShares * p)));
          const entryCost = l1 * ep + comm(l1, ep);
          if (cash < entryCost) { skippedNoCash++; continue; }

          doEntry(ticker, 'NEW_MCE', l1, ep, stop, date, '', 0, lotPlan, direction);
          positions[ticker] = {
            ticker, entryPrice: ep, avgCost: ep, entryDate: date,
            originalEntry: ep, totalShares: l1, lotPlan,
            stop, atBE: false, trailingActive: false, peak: 0, nextLot: 1,
            cycleNum: 0, direction,
          };
          totalEntries++;
          if (isLong) totalLongEntries++; else totalShortEntries++;
        }
      }
    }

    // Close remaining
    for (const [ticker, pos] of Object.entries(positions)) {
      const hBars = hourlyBarMap[ticker]; if (!hBars || !hBars.length) continue;
      const last = hBars[hBars.length - 1];
      const ep = exitSlip(last.close, pos.direction);
      doExit(ticker, 'OPEN_AT_END', pos.totalShares, ep, pos.avgCost, last.date.split(' ')[0], last.date, pos.cycleNum, pos.peak, pos.direction, pos.entryDate);
    }

    // ── Compute metrics ──
    const wins = exits.filter(e => e.pnl > 0);
    const losses = exits.filter(e => e.pnl < 0);
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

    const dailyReturns = [];
    let dailyEquity = NAV_INITIAL;
    let posMonths = 0, totalMonths = 0, monthPnl = 0, currentMonth = '';
    for (const date of hourlyTradingDates) {
      const dayPnl = exits.filter(e => e.date === date).reduce((s, e) => s + e.pnl, 0);
      const prev = dailyEquity; dailyEquity += dayPnl;
      if (prev > 0) dailyReturns.push(dayPnl / prev);
      const month = date.slice(0, 7);
      if (month !== currentMonth) { if (currentMonth) { totalMonths++; if (monthPnl > 0) posMonths++; } currentMonth = month; monthPnl = 0; }
      monthPnl += dayPnl;
    }
    if (currentMonth) { totalMonths++; if (monthPnl > 0) posMonths++; }

    const avgRet = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
    const stdDev = Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avgRet) ** 2, 0) / (dailyReturns.length - 1));
    const downReturns = dailyReturns.filter(r => r < 0);
    const downStdDev = downReturns.length > 1 ? Math.sqrt(downReturns.reduce((s, r) => s + r ** 2, 0) / (downReturns.length - 1)) : 0.0001;
    const ann = Math.sqrt(252);
    const sharpe = (avgRet / stdDev) * ann;
    const sortino = (avgRet / downStdDev) * ann;
    const firstDate = new Date(hourlyTradingDates[0] + 'T12:00:00');
    const lastDate = new Date(hourlyTradingDates[hourlyTradingDates.length - 1] + 'T12:00:00');
    const years = (lastDate - firstDate) / (365.25 * 24 * 60 * 60 * 1000);
    const cagr = (Math.pow(equity / NAV_INITIAL, 1 / years) - 1) * 100;
    const calmar = maxDD > 0 ? cagr / (maxDD * 100) : 999;
    const netReturn = ((equity - NAV_INITIAL) / NAV_INITIAL) * 100;

    const longExits = exits.filter(e => e.direction === 'LONG');
    const shortExits = exits.filter(e => e.direction === 'SHORT');

    return {
      beThreshold, exitMode, netReturn, cagr, sharpe, sortino, calmar,
      pf, wr: wr * 100, payoff, maxDD: maxDD * 100, equity,
      posMonthsPct: totalMonths ? (posMonths / totalMonths * 100) : 0,
      trades: exits.length, wins: wins.length, losses: losses.length,
      avgWin, avgLoss,
      longTrades: longExits.length, longPnl: longExits.reduce((s, e) => s + e.pnl, 0),
      shortTrades: shortExits.length, shortPnl: shortExits.reduce((s, e) => s + e.pnl, 0),
      totalComm, totalBorrow,
      totalEntries, totalExits1H, totalReentries, totalTrailingExits,
      totalBEStopUps, totalLotFills, totalCycleRepeats,
      skippedNoCash, skippedMaxPos,
    };
  }

  // ── RUN ALL 8 SCENARIOS ──────────────────────────────────────────────────
  console.log('\n[3] Running 8 scenarios...\n');

  const results = [];
  for (const be of BE_THRESHOLDS) {
    for (const mode of EXIT_MODES) {
      const label = `BE=$${be} / ${mode}`;
      process.stdout.write(`  Running ${label}...`);
      const r = runSim(be, mode);
      results.push(r);
      console.log(` done  (CAGR: ${r.cagr >= 0 ? '+' : ''}${r.cagr.toFixed(1)}%, Sharpe: ${r.sharpe.toFixed(2)}, Equity: $${Math.round(r.equity).toLocaleString()})`);
    }
  }

  // ── COMPARISON TABLE ──────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(140));
  console.log('  PNTHR AMBUSH V7 — TRAILING STOP OPTIMIZATION RESULTS');
  console.log('='.repeat(140));

  const hdr = ['Scenario', 'Net Ret', 'CAGR', 'Sharpe', 'Sortino', 'Calmar', 'PF', 'WR', 'Payoff', 'MaxDD', 'Equity', 'Pos Mo', 'Trades', 'Trail Exits', 'Avg Win', 'Avg Loss'];
  console.log(`  ${hdr.map((h, i) => i === 0 ? h.padEnd(18) : h.padStart(10)).join(' ')}`);
  console.log(`  ${'─'.repeat(hdr.length * 11)}`);

  for (const r of results) {
    const label = `$${r.beThreshold}/${r.exitMode}`;
    const row = [
      label.padEnd(18),
      `${r.netReturn >= 0 ? '+' : ''}${r.netReturn.toFixed(0)}%`.padStart(10),
      `${r.cagr >= 0 ? '+' : ''}${r.cagr.toFixed(1)}%`.padStart(10),
      r.sharpe.toFixed(2).padStart(10),
      r.sortino.toFixed(1).padStart(10),
      r.calmar.toFixed(1).padStart(10),
      `${r.pf.toFixed(1)}x`.padStart(10),
      `${r.wr.toFixed(1)}%`.padStart(10),
      `${r.payoff.toFixed(1)}x`.padStart(10),
      `${r.maxDD.toFixed(2)}%`.padStart(10),
      `$${Math.round(r.equity).toLocaleString()}`.padStart(10),
      `${r.posMonthsPct.toFixed(0)}%`.padStart(10),
      String(r.trades).padStart(10),
      String(r.totalTrailingExits).padStart(10),
      `$${r.avgWin.toFixed(0)}`.padStart(10),
      `$${r.avgLoss.toFixed(0)}`.padStart(10),
    ];
    console.log(`  ${row.join(' ')}`);
  }

  // ── V6 BASELINE FOR COMPARISON ────────────────────────────────────────────
  console.log(`\n  V6 BASELINE (no trailing stop, BE=$50, no position cap change):`);
  console.log(`  Net: +1217%  CAGR: +105.8%  Sharpe: 2.75  PF: 5.19x  WR: 40.2%  MaxDD: 1.21%  Equity: $1,317,334`);

  // ── LONG vs SHORT BREAKDOWN ───────────────────────────────────────────────
  console.log(`\n  LONG vs SHORT BREAKDOWN`);
  console.log(`  ${'─'.repeat(90)}`);
  console.log(`  ${'Scenario'.padEnd(18)} ${'Long Trades'.padStart(12)} ${'Long P&L'.padStart(12)} ${'Short Trades'.padStart(13)} ${'Short P&L'.padStart(12)} ${'Entries'.padStart(8)} ${'Re-entry'.padStart(9)} ${'1H Exits'.padStart(9)}`);
  for (const r of results) {
    const label = `$${r.beThreshold}/${r.exitMode}`;
    console.log(`  ${label.padEnd(18)} ${String(r.longTrades).padStart(12)} ${'$' + Math.round(r.longPnl).toLocaleString()} ${String(r.shortTrades).padStart(13)} ${'$' + Math.round(r.shortPnl).toLocaleString()} ${String(r.totalEntries).padStart(8)} ${String(r.totalReentries).padStart(9)} ${String(r.totalExits1H).padStart(9)}`);
  }

  // ── RECOMMENDATION ────────────────────────────────────────────────────────
  const best = [...results].sort((a, b) => {
    const scoreA = a.cagr * 0.3 + a.sharpe * 20 + a.pf * 5 - a.maxDD * 10;
    const scoreB = b.cagr * 0.3 + b.sharpe * 20 + b.pf * 5 - b.maxDD * 10;
    return scoreB - scoreA;
  })[0];

  console.log(`\n  COMPOSITE RANKING (30% CAGR + 20× Sharpe + 5× PF - 10× MaxDD):`);
  for (let i = 0; i < results.length; i++) {
    const r = [...results].sort((a, b) => {
      const scoreA = a.cagr * 0.3 + a.sharpe * 20 + a.pf * 5 - a.maxDD * 10;
      const scoreB = b.cagr * 0.3 + b.sharpe * 20 + b.pf * 5 - b.maxDD * 10;
      return scoreB - scoreA;
    })[i];
    const score = r.cagr * 0.3 + r.sharpe * 20 + r.pf * 5 - r.maxDD * 10;
    console.log(`  ${String(i + 1).padStart(3)}. $${r.beThreshold}/${r.exitMode}  score: ${score.toFixed(1)}  (CAGR: ${r.cagr.toFixed(1)}%, Sharpe: ${r.sharpe.toFixed(2)}, PF: ${r.pf.toFixed(1)}x, MaxDD: ${r.maxDD.toFixed(2)}%)`);
  }

  console.log('\n' + '='.repeat(140));
  console.log('  PNTHR AMBUSH V7 TEST MATRIX COMPLETE');
  console.log('='.repeat(140));

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
