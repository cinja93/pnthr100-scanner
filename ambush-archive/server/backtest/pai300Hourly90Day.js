// server/backtest/pai300Hourly90Day.js
// ── 90-DAY HOURLY RE-ENTRY TEST ────────────────────────────────────────────
//
// Uses REAL hourly bars (March-May 2026) to simulate the full scout cycle:
//   1. Stock appears on NOW/MCE → enter L1
//   2. Stock runs up, hits $50+ profit → set breakeven stop
//   3. Stock pulls back, hits BE stop → exit at $0 loss
//   4. Stock trades down (red hourly bars)
//   5. Green hourly bar = buyers back → RE-ENTER at lower price
//   6. Track what happens: price improvement, subsequent profit, win rate
//
// Weekly signals from detectAllSignals determine which stocks are in BL.
// Daily bars identify MCE triggers (2-bar daily high breakout).
// HOURLY bars handle: profit tracking, stop checks, re-entry triggers.
//
// Usage: cd server && node backtest/pai300Hourly90Day.js
// ─────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { connectToDatabase } from '../database.js';
import { SECTORS } from '../scripts/aiUniverse/aiUniverseData.js';
import { SECTOR_EMA_PERIODS } from '../data/pnthrAiSectorsConfig.js';
import { CARNIVORE_MODE_TICKERS } from '../data/strategyMode.js';
import { detectAllSignals, calculateEMA, blInitStop, computeWilderATR } from '../signalDetection.js';

const NAV_INITIAL     = 100_000;
const VITALITY_PCT    = 0.01;
const TICKER_CAP_PCT  = 0.10;
const STRIKE_PCT      = [0.35, 0.25, 0.20, 0.12, 0.08];
const LOT_OFFSETS     = [0, 0.03, 0.06, 0.10, 0.14];
const MAX_LOSS_L1     = 300;
const IBKR_COMMISSION = 1.00;
const IBKR_SLIPPAGE   = 0.01;
const PAI300_REGIME_PERIOD = 36;

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
  for (const h of sec.holdings) AI_TICKER_META[h.ticker] = { sectorId: sec.id, sectorName: sec.name };
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

async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('No DB'); process.exit(1); }

  console.log('='.repeat(100));
  console.log('  90-DAY HOURLY RE-ENTRY TEST');
  console.log('  Real hourly bars | Scout -> BE -> Re-entry at lower price');
  console.log('  Benchmark: existing system 49.90% CAGR, 2.84x PF, 34% WR, 5.5x payoff');
  console.log('='.repeat(100));

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

  // Hourly bar map: ticker → sorted array of { date, open, high, low, close, volume }
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

  // Daily bar map
  const dailyBarMap = {};
  for (const doc of dailyDocs) {
    const map = {};
    for (const b of (doc.daily || [])) map[b.date] = b;
    dailyBarMap[doc.ticker] = map;
  }

  // Get all trading dates in hourly window
  const hourlyDatesSet = new Set();
  for (const bars of Object.values(hourlyBarMap)) {
    for (const b of bars) hourlyDatesSet.add(b.date.split(' ')[0]);
  }
  const hourlyTradingDates = [...hourlyDatesSet].sort();

  // All daily trading dates (for lookback before hourly window)
  const allDailyDatesSet = new Set();
  for (const doc of dailyDocs) {
    for (const b of (doc.daily || [])) allDailyDatesSet.add(b.date);
  }
  const allTradingDates = [...allDailyDatesSet].sort();

  // Weekly bars for signal detection
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

  // Sector tiers
  const aiSectorTierByDate = {};
  for (const doc of sectorRankDocs) {
    const tiers = {};
    for (const r of (doc.ranks || [])) tiers[r.sectorId] = r.tier;
    aiSectorTierByDate[doc.date] = tiers;
  }

  console.log(`  Hourly window: ${hourlyMinDate} to ${hourlyMaxDate} (${hourlyTradingDates.length} trading days)`);
  console.log(`  Tickers with hourly data: ${Object.keys(hourlyBarMap).length}`);

  // ── SIGNAL DETECTION ───────────────────────────────────────────────────────
  console.log('\n[2] Computing signals (detectAllSignals)...');

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
    const emaData = calculateEMA(bars, period);
    const emaByWeek = {};
    for (const e of emaData) emaByWeek[e.time] = e.value;

    const activeBLPeriods = [];
    let blStart = null;
    for (const evt of result.events) {
      if (evt.signal === 'BL') blStart = evt.time;
      if ((evt.signal === 'BE' || evt.signal === 'SS') && blStart) {
        activeBLPeriods.push({ from: blStart, to: evt.time });
        blStart = null;
      }
    }
    if (blStart) activeBLPeriods.push({ from: blStart, to: '9999-12-31' });

    signalsByTicker[ticker] = { events: result.events, activeBLPeriods, emaByWeek, isCarnivore, period };
  }

  console.log(`  ${Object.keys(signalsByTicker).length} tickers with signals`);

  // ── GATE FUNCTIONS ─────────────────────────────────────────────────────────

  function getRegime(ticker, dateStr) {
    const weekOf = getWeekOf(dateStr);
    const isCarnivore = CARNIVORE_MODE_TICKERS.has(ticker);
    const regimeMap = isCarnivore ? spyRegimeByWeek : pai300RegimeByWeek;
    if (regimeMap[weekOf] !== undefined) return regimeMap[weekOf];
    const weeks = Object.keys(regimeMap).sort();
    let best = null;
    for (const w of weeks) { if (w <= weekOf) best = w; else break; }
    return best !== null ? regimeMap[best] : true;
  }

  function getSectorGate(ticker, dateStr) {
    const weekOf = getWeekOf(dateStr);
    const isCarnivore = CARNIVORE_MODE_TICKERS.has(ticker);
    if (!isCarnivore) {
      const dates = Object.keys(aiSectorTierByDate).sort();
      let best = null;
      for (const d of dates) { if (d <= dateStr) best = d; else break; }
      if (!best) return { allowed: true, mult: 1.0 };
      const tiers = aiSectorTierByDate[best];
      const sectorId = AI_TICKER_META[ticker]?.sectorId;
      const tier = tiers?.[sectorId];
      if (!tier) return { allowed: true, mult: 1.0 };
      if (tier === 'GO') return { allowed: true, mult: 1.25 };
      if (tier === 'NEUTRAL') return { allowed: true, mult: 1.0 };
      return { allowed: false, mult: 0 };
    } else {
      const gicsSector = CARNIVORE_GICS[ticker];
      const etf = CARNIVORE_SECTOR_MAP[gicsSector];
      if (!etf) return { allowed: true, mult: 1.0 };
      const etfMap = etfAboveEmaByWeek[etf];
      if (!etfMap) return { allowed: true, mult: 1.0 };
      let above = etfMap[weekOf];
      if (above === undefined) {
        const weeks = Object.keys(etfMap).sort();
        let best = null;
        for (const w of weeks) { if (w <= weekOf) best = w; else break; }
        above = best ? etfMap[best] : true;
      }
      return above ? { allowed: true, mult: 1.0 } : { allowed: false, mult: 0 };
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

  function getInitialStopFromWeekly(ticker, dateStr, entryPrice) {
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
    const atr = atrArr[barIdx];
    return blInitStop(twoBarLow, entryPrice, atr);
  }

  function computeL1(entryPrice, atrStop, mult) {
    const vitalityDollar = NAV_INITIAL * VITALITY_PCT * mult;
    const tickerCapDollar = NAV_INITIAL * TICKER_CAP_PCT;
    const rps = entryPrice - atrStop;
    if (rps <= 0.01) return null;
    const totalByRisk = Math.floor(vitalityDollar / rps);
    const totalByCap = Math.floor(tickerCapDollar / entryPrice);
    const total = Math.min(totalByRisk, totalByCap);
    if (total < 3) return null;
    const l1Shares = Math.max(1, Math.round(total * STRIKE_PCT[0]));
    const l1MaxLossStop = entryPrice - (MAX_LOSS_L1 / l1Shares);
    const effectiveStop = Math.max(atrStop, l1MaxLossStop);
    if (effectiveStop >= entryPrice) return null;
    const lotShares = STRIKE_PCT.map(pct => Math.max(1, Math.round(total * pct)));
    return { total, l1Shares, effectiveStop, lotShares };
  }

  // ── HOURLY SIMULATION ──────────────────────────────────────────────────────
  console.log('\n[3] Running hourly simulation...');

  function runHourlySim(beThreshold, reentryType) {
    const positions = {};        // ticker → position
    const waitingReentry = {};   // ticker → { stopOutPrice, stopOutHour, entryPrice, peakProfit, ... }
    const completedCycles = [];  // full scout → BE → re-entry → outcome records
    const activeEntries = {};    // prevent duplicate entries same day

    let totalEntries = 0, totalBEStops = 0, totalMaxLossStops = 0;
    let totalReentries = 0, totalReentryWins = 0, totalReentryLosses = 0;

    // Process each trading day in the hourly window
    for (let dayIdx = 0; dayIdx < hourlyTradingDates.length; dayIdx++) {
      const date = hourlyTradingDates[dayIdx];

      // Get hourly bars for all tickers for this date
      const dailyHourlyBars = {};
      for (const [ticker, bars] of Object.entries(hourlyBarMap)) {
        const dayBars = bars.filter(b => b.date.startsWith(date));
        if (dayBars.length > 0) dailyHourlyBars[ticker] = dayBars;
      }

      // ── Process existing positions hour by hour ──
      for (const [ticker, pos] of Object.entries(positions)) {
        const hBars = dailyHourlyBars[ticker];
        if (!hBars) continue;

        for (const hBar of hBars) {
          if (!positions[ticker]) break;

          // Check stop hit
          if (pos.stop != null && hBar.low <= pos.stop) {
            const exitPrice = Math.max(hBar.low, pos.stop);
            const pnl = (exitPrice - pos.entryPrice) * pos.l1Shares;

            if (pos.atBreakeven) {
              totalBEStops++;
              // Record for re-entry tracking
              waitingReentry[ticker] = {
                originalEntry: pos.entryPrice,
                stopOutPrice: exitPrice,
                stopOutDate: date,
                stopOutHour: hBar.date,
                peakProfit: pos.peakProfit,
                l1Shares: pos.l1Shares,
                lotPlan: pos.lotPlan,
                sizing: pos.sizing,
              };
              completedCycles.push({
                ticker, phase: 'BE_STOP',
                entryPrice: pos.entryPrice, entryDate: pos.entryDate,
                exitPrice, exitDate: date, exitHour: hBar.date,
                pnl: +pnl.toFixed(2),
                peakProfit: pos.peakProfit,
                hoursHeld: pos.hoursHeld,
              });
            } else {
              totalMaxLossStops++;
              completedCycles.push({
                ticker, phase: 'MAX_LOSS_STOP',
                entryPrice: pos.entryPrice, entryDate: pos.entryDate,
                exitPrice, exitDate: date, exitHour: hBar.date,
                pnl: +pnl.toFixed(2),
                peakProfit: pos.peakProfit || 0,
                hoursHeld: pos.hoursHeld,
              });
            }
            delete positions[ticker];
            break;
          }

          // Track peak unrealized profit
          const unrealized = (hBar.high - pos.entryPrice) * pos.l1Shares;
          if (unrealized > (pos.peakProfit || 0)) pos.peakProfit = +unrealized.toFixed(2);

          // Check BE threshold
          if (!pos.atBreakeven && unrealized >= beThreshold) {
            pos.atBreakeven = true;
            const feesPerShare = (IBKR_COMMISSION + IBKR_SLIPPAGE * pos.l1Shares) / pos.l1Shares;
            pos.stop = +(pos.entryPrice + feesPerShare).toFixed(2);
          }

          pos.hoursHeld = (pos.hoursHeld || 0) + 1;
        }
      }

      // ── Check re-entry on hourly bars ──
      for (const [ticker, wait] of Object.entries(waitingReentry)) {
        if (positions[ticker]) { delete waitingReentry[ticker]; continue; }

        const hBars = dailyHourlyBars[ticker];
        if (!hBars) continue;

        // Must still be in active BL and pass gates
        if (!isActiveBL(ticker, date)) { delete waitingReentry[ticker]; continue; }
        if (!getRegime(ticker, date)) continue;
        const sectorGate = getSectorGate(ticker, date);
        if (!sectorGate.allowed) continue;

        // Expire after 10 trading days
        const daysSinceStop = hourlyTradingDates.indexOf(date) - hourlyTradingDates.indexOf(wait.stopOutDate);
        if (daysSinceStop > 10) { delete waitingReentry[ticker]; continue; }

        let triggered = false;
        let reentryPrice = null;
        let reentryHour = null;
        let pullbackLow = Infinity;

        for (const hBar of hBars) {
          if (hBar.low < pullbackLow) pullbackLow = hBar.low;

          if (reentryType === 'green_bar') {
            // Current: any green hourly bar closing above stop-out price
            if (hBar.close > hBar.open && hBar.close > wait.stopOutPrice) {
              triggered = true;
              reentryPrice = hBar.close;
              reentryHour = hBar.date;
              break;
            }
          } else if (reentryType === 'higher_low_green') {
            // Higher-low + green: current bar's low > prior bar's low + green close
            const hBarIdx = hBars.indexOf(hBar);
            const prevHBar = hBarIdx > 0 ? hBars[hBarIdx - 1] : null;
            if (prevHBar && hBar.low > prevHBar.low && hBar.close > hBar.open && hBar.close > wait.stopOutPrice) {
              triggered = true;
              reentryPrice = hBar.close;
              reentryHour = hBar.date;
              break;
            }
          } else if (reentryType === 'two_bar_hourly_breakout') {
            // 2-bar hourly high breakout
            const hBarIdx = hBars.indexOf(hBar);
            if (hBarIdx >= 2) {
              const trigger = Math.max(hBars[hBarIdx - 1].high, hBars[hBarIdx - 2].high) + 0.01;
              if (hBar.high >= trigger && hBar.close > wait.stopOutPrice) {
                triggered = true;
                reentryPrice = Math.max(hBar.open, trigger);
                reentryHour = hBar.date;
                break;
              }
            }
          } else if (reentryType === 'reclaim_prior_close') {
            // Close above the prior day's daily close
            const prevDayIdx = hourlyTradingDates.indexOf(date) - 1;
            const prevDate = prevDayIdx >= 0 ? hourlyTradingDates[prevDayIdx] : null;
            const prevDailyBar = prevDate ? dailyBarMap[ticker]?.[prevDate] : null;
            if (prevDailyBar && hBar.close > hBar.open && hBar.close > prevDailyBar.close) {
              triggered = true;
              reentryPrice = hBar.close;
              reentryHour = hBar.date;
              break;
            }
          } else if (reentryType === 'price_improvement_1pct') {
            // Only re-enter if price is at least 1% below original entry + green bar
            const threshold = wait.originalEntry * 0.99;
            if (hBar.close < threshold && hBar.close > hBar.open) {
              triggered = true;
              reentryPrice = hBar.close;
              reentryHour = hBar.date;
              break;
            }
          }
        }

        if (!triggered || !reentryPrice) continue;

        // Size the re-entry
        const atrStop = getInitialStopFromWeekly(ticker, date, reentryPrice);
        if (!atrStop || atrStop >= reentryPrice) continue;
        const sizing = computeL1(reentryPrice, atrStop, sectorGate.mult);
        if (!sizing) continue;

        const priceImprovement = wait.originalEntry - reentryPrice;

        positions[ticker] = {
          ticker, entryPrice: reentryPrice, entryDate: date,
          l1Shares: sizing.l1Shares, lotPlan: sizing.lotShares,
          stop: sizing.effectiveStop, sizing,
          atBreakeven: false, peakProfit: 0, hoursHeld: 0,
          isReentry: true,
          originalEntry: wait.originalEntry,
          priceImprovement: +priceImprovement.toFixed(2),
          pullbackLow: pullbackLow < Infinity ? +pullbackLow.toFixed(2) : null,
        };
        totalReentries++;

        completedCycles.push({
          ticker, phase: 'REENTRY',
          originalEntry: wait.originalEntry,
          stopOutPrice: wait.stopOutPrice,
          reentryPrice, reentryDate: date, reentryHour,
          priceImprovement: +priceImprovement.toFixed(2),
          pullbackLow: pullbackLow < Infinity ? +pullbackLow.toFixed(2) : null,
          peakProfitBeforeStop: wait.peakProfit,
        });

        delete waitingReentry[ticker];
      }

      // ── New MCE entries (daily 2-bar breakout on active BL stocks) ──
      if (dayIdx >= 2) {
        const prev1Date = hourlyTradingDates[dayIdx - 1];
        const prev2Date = hourlyTradingDates[dayIdx - 2];

        for (const ticker of Object.keys(signalsByTicker)) {
          if (positions[ticker] || waitingReentry[ticker] || activeEntries[ticker] === date) continue;
          if (!hourlyBarMap[ticker]) continue;
          if (!isActiveBL(ticker, date)) continue;
          if (!getRegime(ticker, date)) continue;
          const sectorGate = getSectorGate(ticker, date);
          if (!sectorGate.allowed) continue;

          const bar = dailyBarMap[ticker]?.[date];
          const prev1 = dailyBarMap[ticker]?.[prev1Date];
          const prev2 = dailyBarMap[ticker]?.[prev2Date];
          if (!bar || !prev1 || !prev2) continue;

          const trigger = Math.max(prev1.high, prev2.high) + 0.01;
          if (bar.high < trigger) continue;

          const entryPrice = Math.max(bar.open, trigger);
          const atrStop = getInitialStopFromWeekly(ticker, date, entryPrice);
          if (!atrStop || atrStop >= entryPrice) continue;
          const sizing = computeL1(entryPrice, atrStop, sectorGate.mult);
          if (!sizing) continue;

          positions[ticker] = {
            ticker, entryPrice, entryDate: date,
            l1Shares: sizing.l1Shares, lotPlan: sizing.lotShares,
            stop: sizing.effectiveStop, sizing,
            atBreakeven: false, peakProfit: 0, hoursHeld: 0,
            isReentry: false,
          };
          totalEntries++;
          activeEntries[ticker] = date;
        }
      }
    }

    // Close remaining positions at last available price
    for (const [ticker, pos] of Object.entries(positions)) {
      const hBars = hourlyBarMap[ticker];
      if (!hBars || !hBars.length) continue;
      const lastBar = hBars[hBars.length - 1];
      const pnl = (lastBar.close - pos.entryPrice) * pos.l1Shares;
      completedCycles.push({
        ticker, phase: pos.isReentry ? 'REENTRY_OPEN' : 'SCOUT_OPEN',
        entryPrice: pos.entryPrice, entryDate: pos.entryDate,
        exitPrice: lastBar.close, exitDate: lastBar.date.split(' ')[0],
        pnl: +pnl.toFixed(2),
        peakProfit: pos.peakProfit,
        hoursHeld: pos.hoursHeld,
        isReentry: pos.isReentry || false,
        priceImprovement: pos.priceImprovement || 0,
      });
    }

    return { completedCycles, totalEntries, totalBEStops, totalMaxLossStops, totalReentries };
  }

  // ── RUN ALL RE-ENTRY VARIATIONS ────────────────────────────────────────────

  const beThresholds = [50, 120, 200];
  const reentryTypes = [
    { key: 'green_bar', label: 'Green hourly bar > stop-out price' },
    { key: 'higher_low_green', label: 'Higher-low + green bar > stop-out' },
    { key: 'two_bar_hourly_breakout', label: '2-bar hourly high breakout > stop-out' },
    { key: 'reclaim_prior_close', label: 'Green bar reclaiming prior day close' },
    { key: 'price_improvement_1pct', label: 'Green bar at 1%+ below original entry' },
  ];

  const allResults = [];

  for (const beThresh of beThresholds) {
    for (const rt of reentryTypes) {
      console.log(`\n  Running: BE=$${beThresh} + ${rt.label}...`);
      const result = runHourlySim(beThresh, rt.key);
      allResults.push({ beThresh, reentryType: rt.key, reentryLabel: rt.label, ...result });
    }
  }

  // ── PRINT RESULTS ──────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(100));
  console.log('  RESULTS — ALL VARIATIONS');
  console.log('='.repeat(100));

  for (const r of allResults) {
    const cycles = r.completedCycles;
    const beStops = cycles.filter(c => c.phase === 'BE_STOP');
    const maxLossStops = cycles.filter(c => c.phase === 'MAX_LOSS_STOP');
    const reentries = cycles.filter(c => c.phase === 'REENTRY');
    const reentryOutcomes = cycles.filter(c => c.phase === 'REENTRY_OPEN' || (c.isReentry && (c.phase === 'BE_STOP' || c.phase === 'MAX_LOSS_STOP')));
    const scoutOpenAtEnd = cycles.filter(c => c.phase === 'SCOUT_OPEN');
    const reentryOpenAtEnd = cycles.filter(c => c.phase === 'REENTRY_OPEN');

    // Re-entry price improvements
    const improvements = reentries.map(c => c.priceImprovement).filter(v => v != null);
    const avgImprovement = improvements.length ? improvements.reduce((s, v) => s + v, 0) / improvements.length : 0;
    const positiveImprovements = improvements.filter(v => v > 0);

    // Re-entry P&L (from positions that re-entered and then closed or are still open)
    const reentryPnL = cycles.filter(c => (c.isReentry || c.phase === 'REENTRY_OPEN') && c.pnl !== undefined);
    const reentryWins = reentryPnL.filter(c => c.pnl > 0);
    const reentryLosses = reentryPnL.filter(c => c.pnl < 0);
    const reentryTotalWin = reentryWins.reduce((s, c) => s + c.pnl, 0);
    const reentryTotalLoss = reentryLosses.reduce((s, c) => s + c.pnl, 0);

    // All trade P&L
    const allPnL = cycles.filter(c => c.pnl !== undefined);
    const allWins = allPnL.filter(c => c.pnl > 0);
    const allLosses = allPnL.filter(c => c.pnl < 0);
    const totalWin = allWins.reduce((s, c) => s + c.pnl, 0);
    const totalLoss = allLosses.reduce((s, c) => s + c.pnl, 0);
    const netPnL = totalWin + totalLoss;

    console.log(`\n${'─'.repeat(100)}`);
    console.log(`  BE threshold: $${r.beThresh} | Re-entry: ${r.reentryLabel}`);
    console.log('─'.repeat(100));

    console.log(`\n  Entries:           ${r.totalEntries} new scouts`);
    console.log(`  BE stops:          ${beStops.length}`);
    console.log(`  Max loss stops:    ${maxLossStops.length}`);
    console.log(`  Re-entries:        ${reentries.length}`);
    console.log(`  Still open (end):  ${scoutOpenAtEnd.length} scouts + ${reentryOpenAtEnd.length} re-entries`);

    if (beStops.length > 0) {
      const avgPeakBeforeStop = beStops.reduce((s, c) => s + (c.peakProfit || 0), 0) / beStops.length;
      console.log(`\n  Avg peak profit before BE stop: $${avgPeakBeforeStop.toFixed(0)}`);
      console.log(`  BE stop → re-entry rate: ${reentries.length}/${beStops.length} (${(reentries.length / beStops.length * 100).toFixed(0)}%)`);
    }

    if (improvements.length > 0) {
      console.log(`\n  ── Price Improvement on Re-entry ──`);
      console.log(`  Avg improvement:      $${avgImprovement.toFixed(2)}/share`);
      console.log(`  Positive (lower re-entry): ${positiveImprovements.length}/${improvements.length} (${(positiveImprovements.length / improvements.length * 100).toFixed(0)}%)`);
      if (positiveImprovements.length) {
        console.log(`  Avg when positive:    $${(positiveImprovements.reduce((s,v) => s+v, 0) / positiveImprovements.length).toFixed(2)}/share`);
      }
      const negativeImprovements = improvements.filter(v => v < 0);
      if (negativeImprovements.length) {
        console.log(`  Avg when negative:    $${(negativeImprovements.reduce((s,v) => s+v, 0) / negativeImprovements.length).toFixed(2)}/share (re-entered HIGHER)`);
      }
    }

    if (reentryPnL.length > 0) {
      console.log(`\n  ── Re-entry Trade Results ──`);
      console.log(`  Total re-entry trades: ${reentryPnL.length}`);
      console.log(`  Winners:   ${reentryWins.length} (avg $${reentryWins.length ? (reentryTotalWin / reentryWins.length).toFixed(0) : 0})`);
      console.log(`  Losers:    ${reentryLosses.length} (avg $${reentryLosses.length ? (reentryTotalLoss / reentryLosses.length).toFixed(0) : 0})`);
      console.log(`  Win rate:  ${(reentryWins.length / reentryPnL.length * 100).toFixed(1)}%`);
      console.log(`  Net P&L:   $${(reentryTotalWin + reentryTotalLoss).toFixed(0)}`);
      if (reentryTotalLoss) {
        console.log(`  PF:        ${(reentryTotalWin / Math.abs(reentryTotalLoss)).toFixed(2)}x`);
      }
    }

    console.log(`\n  ── Overall P&L (all trades) ──`);
    console.log(`  Net P&L:     $${netPnL.toFixed(0)}`);
    console.log(`  Gross win:   $${totalWin.toFixed(0)}`);
    console.log(`  Gross loss:  $${Math.abs(totalLoss).toFixed(0)}`);
    if (totalLoss) console.log(`  PF:          ${(totalWin / Math.abs(totalLoss)).toFixed(2)}x`);
    console.log(`  Win rate:    ${allPnL.length ? (allWins.length / allPnL.length * 100).toFixed(1) : 0}%`);
    if (allWins.length && allLosses.length) {
      const avgWin = totalWin / allWins.length;
      const avgLoss = Math.abs(totalLoss / allLosses.length);
      console.log(`  Payoff:      ${(avgWin / avgLoss).toFixed(2)}x`);
    }

    // Show individual re-entry cycles with detail
    if (reentries.length > 0 && reentries.length <= 30) {
      console.log(`\n  ── Individual Re-entry Cycles ──`);
      console.log(`  ${'Ticker'.padEnd(7)} ${'Orig Entry'.padStart(11)} ${'StopOut'.padStart(9)} ${'ReEntry'.padStart(9)} ${'Improve'.padStart(9)} ${'PullbkLow'.padStart(10)} ${'Date'.padEnd(12)}`);
      for (const c of reentries) {
        const outcome = cycles.find(x => x.ticker === c.ticker && x.isReentry && (x.phase === 'REENTRY_OPEN' || x.phase === 'BE_STOP' || x.phase === 'MAX_LOSS_STOP'));
        const pnlStr = outcome ? ` P&L: $${outcome.pnl.toFixed(0)}` : '';
        console.log(`  ${c.ticker.padEnd(7)} $${c.originalEntry.toFixed(2).padStart(10)} $${c.stopOutPrice.toFixed(2).padStart(8)} $${c.reentryPrice.toFixed(2).padStart(8)} $${c.priceImprovement.toFixed(2).padStart(8)} $${(c.pullbackLow || 0).toFixed(2).padStart(9)} ${c.reentryDate.padEnd(12)}${pnlStr}`);
      }
    }
  }

  // ── SUMMARY COMPARISON TABLE ───────────────────────────────────────────────
  console.log('\n' + '='.repeat(100));
  console.log('  SUMMARY: ALL VARIATIONS COMPARED');
  console.log('='.repeat(100));
  console.log(`\n  ${'BE$'.padStart(5)} ${'Re-entry Type'.padEnd(45)} ${'Entries'.padStart(8)} ${'BE'.padStart(4)} ${'ReEnt'.padStart(6)} ${'ReEnt%'.padStart(7)} ${'AvgImpr'.padStart(8)} ${'Net$'.padStart(8)} ${'PF'.padStart(6)} ${'WR'.padStart(6)} ${'Payoff'.padStart(7)}`);

  for (const r of allResults) {
    const cycles = r.completedCycles;
    const beStops = cycles.filter(c => c.phase === 'BE_STOP');
    const reentries = cycles.filter(c => c.phase === 'REENTRY');
    const improvements = reentries.map(c => c.priceImprovement).filter(v => v != null);
    const avgImpr = improvements.length ? improvements.reduce((s, v) => s + v, 0) / improvements.length : 0;

    const allPnL = cycles.filter(c => c.pnl !== undefined);
    const wins = allPnL.filter(c => c.pnl > 0);
    const losses = allPnL.filter(c => c.pnl < 0);
    const totalWin = wins.reduce((s, c) => s + c.pnl, 0);
    const totalLoss = losses.reduce((s, c) => s + c.pnl, 0);
    const netPnL = totalWin + totalLoss;
    const pf = totalLoss ? (totalWin / Math.abs(totalLoss)).toFixed(2) : 'Inf';
    const wr = allPnL.length ? (wins.length / allPnL.length * 100).toFixed(0) : '0';
    const avgWin = wins.length ? totalWin / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(totalLoss / losses.length) : 1;
    const payoff = avgLoss > 0 ? (avgWin / avgLoss).toFixed(1) : 'Inf';
    const reentryPct = beStops.length ? (reentries.length / beStops.length * 100).toFixed(0) : '0';

    console.log(`  $${String(r.beThresh).padStart(4)} ${r.reentryLabel.padEnd(45)} ${String(r.totalEntries).padStart(8)} ${String(beStops.length).padStart(4)} ${String(reentries.length).padStart(6)} ${(reentryPct + '%').padStart(7)} $${avgImpr.toFixed(2).padStart(7)} $${String(netPnL.toFixed(0)).padStart(7)} ${String(pf + 'x').padStart(6)} ${(wr + '%').padStart(6)} ${(payoff + 'x').padStart(7)}`);
  }

  console.log('\n' + '='.repeat(100));
  console.log('  Done.');
  console.log('='.repeat(100));

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
