// server/backtest/pai300HourlyV4.js
// ── 90-DAY HOURLY V4 — FIRST-HOUR LOW EXIT + CONFIRMED GREEN BAR RE-ENTRY ──
//
// Scott's rules (2026-05-29):
// 1. Enter any AI 300 long with active BL (+ 26 Carnivore crossover stocks)
// 2. After first hour (9:30-10:30 ET), note the low of that first hour
// 3. If price breaks below first-hour low after 10:30 → EXIT
// 4. Wait for confirmed re-entry: green 60-min bar where:
//    a) close > open (green)
//    b) bar high > previous bar's high (breakout)
//    c) bar close > previous bar's high (confirmed, not just a wick)
// 5. Re-entry stop = new low of day at re-entry time - fees
// 6. At $50 unrealized profit → move stop to breakeven + fees
// 7. As L2-L5 fill, avg cost rises → breakeven ratchets up → stop follows
// 8. Cycle can repeat (exit on new low break, re-enter on confirmed green)
// 9. Max loss = $300 per trade
//
// Usage: cd server && node backtest/pai300HourlyV4.js
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
const MAX_LOSS        = 300;
const IBKR_FEE_PER_TRADE = 1.00;
const IBKR_SLIPPAGE   = 0.01;
const BE_PROFIT_THRESHOLD = 50;
const PAI300_REGIME_PERIOD = 36;
const FIRST_HOUR_END  = '10:30';

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
  for (const h of sec.holdings) AI_TICKER_META[h.ticker] = { sectorId: sec.id };
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

async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('No DB'); process.exit(1); }

  console.log('='.repeat(110));
  console.log('  90-DAY HOURLY V4 — FIRST-HOUR LOW EXIT + CONFIRMED GREEN BAR RE-ENTRY');
  console.log('  Rules: 1h settle → low-of-hour stop → confirmed breakout re-entry → BE ratchet → L1-L5 pyramid');
  console.log('='.repeat(110));

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
    let blStart = null;
    for (const evt of result.events) {
      if (evt.signal === 'BL') blStart = evt.time;
      if ((evt.signal === 'BE' || evt.signal === 'SS') && blStart) {
        activeBLPeriods.push({ from: blStart, to: evt.time });
        blStart = null;
      }
    }
    if (blStart) activeBLPeriods.push({ from: blStart, to: '9999-12-31' });
    signalsByTicker[ticker] = { activeBLPeriods, isCarnivore };
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

  function getWeeklyStop(ticker, dateStr, entryPrice) {
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

  // ── SIMULATION ─────────────────────────────────────────────────────────────
  console.log('\n[3] Running simulation...');

  const trades = [];
  const positions = {};   // ticker → position state
  const waiting = {};     // ticker → waiting for re-entry

  let totalEntries = 0, totalExitsFirstHour = 0, totalReentries = 0;
  let totalBEStopUps = 0, totalLotFills = 0, totalCycleRepeats = 0;

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

      // Determine first-hour low for TODAY (9:30-10:30)
      const firstHourBars = hBars.filter(b => extractTime(b.date) < FIRST_HOUR_END);
      const afterFirstHour = hBars.filter(b => extractTime(b.date) >= FIRST_HOUR_END);
      const firstHourLow = firstHourBars.length
        ? Math.min(...firstHourBars.map(b => b.low))
        : null;

      // Track running low of day for re-entry stop calculation
      let runningLow = firstHourLow ?? Infinity;

      // Process first-hour bars: only check existing stop (from prior day or BE ratchet)
      for (const hBar of firstHourBars) {
        if (!positions[ticker]) break;
        if (hBar.low < runningLow) runningLow = hBar.low;

        // Existing stop hit during first hour
        if (pos.stop != null && hBar.low <= pos.stop) {
          const exitPrice = pos.stop;
          const pnl = (exitPrice - pos.avgCost) * pos.totalShares;
          trades.push({
            ticker, phase: 'STOP_HIT_FIRST_HOUR',
            entryPrice: pos.avgCost, exitPrice, shares: pos.totalShares,
            entryDate: pos.entryDate, exitDate: date, exitHour: hBar.date,
            pnl: +pnl.toFixed(2), peakProfit: pos.peak,
            cycleNum: pos.cycleNum,
          });
          // Set up re-entry wait
          waiting[ticker] = {
            originalEntry: pos.originalEntry,
            exitPrice, exitDate: date, exitHour: hBar.date,
            runningLow, cycleNum: pos.cycleNum + 1,
          };
          delete positions[ticker];
          break;
        }

        // Track peak profit
        const unr = (hBar.high - pos.avgCost) * pos.totalShares;
        if (unr > (pos.peak || 0)) pos.peak = +unr.toFixed(2);

        // BE ratchet: at $50 profit, move stop to breakeven + fees
        if (!pos.atBE && unr >= BE_PROFIT_THRESHOLD) {
          pos.atBE = true;
          const feePer = IBKR_FEE_PER_TRADE / pos.totalShares;
          pos.stop = +(pos.avgCost + feePer).toFixed(2);
          totalBEStopUps++;
        }
      }

      if (!positions[ticker]) continue;

      // Process after-first-hour bars: check first-hour low break + existing stop
      for (const hBar of afterFirstHour) {
        if (!positions[ticker]) break;
        if (hBar.low < runningLow) runningLow = hBar.low;

        // First-hour low break → EXIT
        if (firstHourLow != null && hBar.low < firstHourLow) {
          const exitPrice = firstHourLow;
          const pnl = (exitPrice - pos.avgCost) * pos.totalShares;
          trades.push({
            ticker, phase: 'FIRST_HOUR_LOW_BREAK',
            entryPrice: pos.avgCost, exitPrice, shares: pos.totalShares,
            entryDate: pos.entryDate, exitDate: date, exitHour: hBar.date,
            pnl: +pnl.toFixed(2), peakProfit: pos.peak,
            cycleNum: pos.cycleNum,
          });
          totalExitsFirstHour++;
          waiting[ticker] = {
            originalEntry: pos.originalEntry,
            exitPrice, exitDate: date, exitHour: hBar.date,
            runningLow: hBar.low, cycleNum: pos.cycleNum + 1,
          };
          delete positions[ticker];
          break;
        }

        // Existing stop hit (BE ratchet or initial stop)
        if (pos.stop != null && hBar.low <= pos.stop) {
          const exitPrice = pos.stop;
          const pnl = (exitPrice - pos.avgCost) * pos.totalShares;
          trades.push({
            ticker, phase: pos.atBE ? 'BE_STOP' : 'STOP_HIT',
            entryPrice: pos.avgCost, exitPrice, shares: pos.totalShares,
            entryDate: pos.entryDate, exitDate: date, exitHour: hBar.date,
            pnl: +pnl.toFixed(2), peakProfit: pos.peak,
            cycleNum: pos.cycleNum,
          });
          waiting[ticker] = {
            originalEntry: pos.originalEntry,
            exitPrice, exitDate: date, exitHour: hBar.date,
            runningLow, cycleNum: pos.cycleNum + 1,
          };
          delete positions[ticker];
          break;
        }

        // Track peak profit
        const unr = (hBar.high - pos.avgCost) * pos.totalShares;
        if (unr > (pos.peak || 0)) pos.peak = +unr.toFixed(2);

        // BE ratchet
        if (!pos.atBE && unr >= BE_PROFIT_THRESHOLD) {
          pos.atBE = true;
          const feePer = IBKR_FEE_PER_TRADE / pos.totalShares;
          pos.stop = +(pos.avgCost + feePer).toFixed(2);
          totalBEStopUps++;
        }

        // L2-L5 lot trigger fills (price rises through lot offsets)
        if (pos.nextLot <= 4) {
          const lotTrigger = +(pos.originalEntry * (1 + LOT_OFFSETS[pos.nextLot])).toFixed(2);
          if (hBar.high >= lotTrigger) {
            const lotShares = pos.lotPlan[pos.nextLot];
            const oldCost = pos.avgCost * pos.totalShares;
            pos.totalShares += lotShares;
            pos.avgCost = +((oldCost + lotTrigger * lotShares) / pos.totalShares).toFixed(4);
            pos.nextLot++;
            totalLotFills++;

            // Ratchet BE stop up to new avg cost if already at BE
            if (pos.atBE) {
              const feePer = IBKR_FEE_PER_TRADE / pos.totalShares;
              pos.stop = +(pos.avgCost + feePer).toFixed(2);
            }
          }
        }
      }
    }

    // ═══ PHASE B: Check re-entry for waiting tickers ═══
    for (const [ticker, w] of Object.entries(waiting)) {
      if (positions[ticker]) { delete waiting[ticker]; continue; }

      const hBars = dayHourly[ticker];
      if (!hBars || hBars.length < 2) continue;
      if (!isActiveBL(ticker, date)) { delete waiting[ticker]; continue; }
      if (!getRegime(ticker, date)) continue;
      if (!getSectorOk(ticker, date)) continue;

      // Only check after first hour
      const afterFirst = hBars.filter(b => extractTime(b.date) >= FIRST_HOUR_END);
      if (afterFirst.length < 2) continue;

      for (let i = 1; i < afterFirst.length; i++) {
        if (positions[ticker]) break;
        const bar = afterFirst[i];
        const prevBar = afterFirst[i - 1];

        // Track running low
        if (bar.low < w.runningLow) w.runningLow = bar.low;

        // Confirmed green bar breakout
        if (!isConfirmedGreenBreakout(bar, prevBar)) continue;

        // Re-entry price = bar close (confirmed breakout close)
        const rePrice = bar.close;

        // Stop = new low of day - fees buffer
        const feesBuffer = (IBKR_FEE_PER_TRADE * 2) / 1; // rough per-share buffer
        const reStop = +(w.runningLow - feesBuffer - IBKR_SLIPPAGE).toFixed(2);
        if (reStop >= rePrice) continue;

        // Size: max loss $300
        const rps = rePrice - reStop;
        if (rps <= 0.01) continue;
        const maxShares = Math.floor(MAX_LOSS / rps);
        if (maxShares < 1) continue;

        // Also cap by vitality + ticker cap
        const vitalityShares = Math.floor((NAV_INITIAL * VITALITY_PCT) / rps);
        const capShares = Math.floor((NAV_INITIAL * TICKER_CAP_PCT) / rePrice);
        const totalShares = Math.min(maxShares, vitalityShares, capShares);
        if (totalShares < 1) continue;

        const l1 = Math.max(1, Math.round(totalShares * STRIKE_PCT[0]));
        const lotPlan = STRIKE_PCT.map(p => Math.max(1, Math.round(totalShares * p)));

        positions[ticker] = {
          ticker, entryPrice: rePrice, avgCost: rePrice, entryDate: date,
          originalEntry: w.originalEntry || rePrice,
          totalShares: l1, lotPlan,
          stop: reStop, atBE: false, peak: 0, nextLot: 1,
          cycleNum: w.cycleNum, isReentry: true,
        };

        trades.push({
          ticker, phase: 'REENTRY',
          reentryPrice: rePrice, reentryDate: date, reentryHour: bar.date,
          reentryStop: reStop, shares: l1,
          cycleNum: w.cycleNum,
          dayLowAtReentry: w.runningLow,
        });

        totalReentries++;
        if (w.cycleNum > 1) totalCycleRepeats++;
        delete waiting[ticker];
        break;
      }
    }

    // ═══ PHASE C: New entries (MCE daily 2-bar breakout) ═══
    if (dayIdx >= 2) {
      const p1 = hourlyTradingDates[dayIdx - 1];
      const p2 = hourlyTradingDates[dayIdx - 2];

      for (const ticker of Object.keys(signalsByTicker)) {
        if (positions[ticker] || waiting[ticker]) continue;
        if (!hourlyBarMap[ticker]) continue;
        if (!isActiveBL(ticker, date)) continue;
        if (!getRegime(ticker, date)) continue;
        if (!getSectorOk(ticker, date)) continue;

        const bar = dailyBarMap[ticker]?.[date];
        const prev1 = dailyBarMap[ticker]?.[p1];
        const prev2 = dailyBarMap[ticker]?.[p2];
        if (!bar || !prev1 || !prev2) continue;

        const trigger = Math.max(prev1.high, prev2.high) + 0.01;
        if (bar.high < trigger) continue;

        // Also check hourly confirmation: need a confirmed green breakout bar today
        const hBars = dayHourly[ticker];
        if (!hBars || hBars.length < 2) continue;
        const afterFirst = hBars.filter(b => extractTime(b.date) >= FIRST_HOUR_END);
        let hourlyConfirmed = false;
        for (let i = 1; i < afterFirst.length; i++) {
          if (isConfirmedGreenBreakout(afterFirst[i], afterFirst[i - 1])) {
            hourlyConfirmed = true;
            break;
          }
        }
        if (!hourlyConfirmed) continue;

        const ep = Math.max(bar.open, trigger);
        const weeklyStop = getWeeklyStop(ticker, date, ep);
        if (!weeklyStop || weeklyStop >= ep) continue;

        const rps = ep - weeklyStop;
        if (rps <= 0.01) continue;
        const maxShares = Math.floor(MAX_LOSS / rps);
        const vitalityShares = Math.floor((NAV_INITIAL * VITALITY_PCT) / rps);
        const capShares = Math.floor((NAV_INITIAL * TICKER_CAP_PCT) / ep);
        const totalShares = Math.min(maxShares, vitalityShares, capShares);
        if (totalShares < 1) continue;

        const l1 = Math.max(1, Math.round(totalShares * STRIKE_PCT[0]));
        const lotPlan = STRIKE_PCT.map(p => Math.max(1, Math.round(totalShares * p)));

        // Initial stop = weekly stop (not first-hour low, which isn't known yet at entry)
        positions[ticker] = {
          ticker, entryPrice: ep, avgCost: ep, entryDate: date,
          originalEntry: ep,
          totalShares: l1, lotPlan,
          stop: weeklyStop, atBE: false, peak: 0, nextLot: 1,
          cycleNum: 0, isReentry: false,
        };

        totalEntries++;
      }
    }
  }

  // Close remaining positions at last available price
  for (const [ticker, pos] of Object.entries(positions)) {
    const hBars = hourlyBarMap[ticker];
    if (!hBars || !hBars.length) continue;
    const last = hBars[hBars.length - 1];
    const pnl = (last.close - pos.avgCost) * pos.totalShares;
    trades.push({
      ticker, phase: 'OPEN_AT_END',
      entryPrice: pos.avgCost, exitPrice: last.close, shares: pos.totalShares,
      entryDate: pos.entryDate, exitDate: last.date.split(' ')[0],
      pnl: +pnl.toFixed(2), peakProfit: pos.peak,
      cycleNum: pos.cycleNum,
    });
  }

  // ── RESULTS ────────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(110));
  console.log('  RESULTS');
  console.log('='.repeat(110));

  const closedTrades = trades.filter(t => t.pnl !== undefined && t.phase !== 'REENTRY');
  const wins = closedTrades.filter(t => t.pnl > 0);
  const losses = closedTrades.filter(t => t.pnl < 0);
  const flat = closedTrades.filter(t => t.pnl === 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = losses.reduce((s, t) => s + t.pnl, 0);
  const netPnl = grossWin + grossLoss;
  const pf = grossLoss ? grossWin / Math.abs(grossLoss) : 999;
  const wr = closedTrades.length ? wins.length / closedTrades.length : 0;
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(grossLoss / losses.length) : 1;
  const payoff = avgLoss > 0 ? avgWin / avgLoss : 999;

  // Breakdown by phase
  const firstHourExits = trades.filter(t => t.phase === 'FIRST_HOUR_LOW_BREAK');
  const beStops = trades.filter(t => t.phase === 'BE_STOP');
  const stopHits = trades.filter(t => t.phase === 'STOP_HIT' || t.phase === 'STOP_HIT_FIRST_HOUR');
  const reentryEvents = trades.filter(t => t.phase === 'REENTRY');
  const openAtEnd = trades.filter(t => t.phase === 'OPEN_AT_END');

  // Re-entry trade P&L
  const reentryTrades = closedTrades.filter(t => t.cycleNum > 0);
  const reWins = reentryTrades.filter(t => t.pnl > 0);
  const reLosses = reentryTrades.filter(t => t.pnl < 0);
  const reGrossWin = reWins.reduce((s, t) => s + t.pnl, 0);
  const reGrossLoss = reLosses.reduce((s, t) => s + t.pnl, 0);
  const reNetPnl = reGrossWin + reGrossLoss;
  const reWr = reentryTrades.length ? reWins.length / reentryTrades.length : 0;
  const rePf = reGrossLoss ? reGrossWin / Math.abs(reGrossLoss) : 999;

  // Max drawdown (simple equity curve)
  let equity = NAV_INITIAL, peak = NAV_INITIAL, maxDD = 0;
  const sortedClosed = closedTrades.sort((a, b) => (a.exitDate || a.exitHour || '').localeCompare(b.exitDate || b.exitHour || ''));
  for (const t of sortedClosed) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  // Biggest winner / loser
  const bigWin = wins.length ? wins.reduce((best, t) => t.pnl > best.pnl ? t : best) : null;
  const bigLoss = losses.length ? losses.reduce((worst, t) => t.pnl < worst.pnl ? t : worst) : null;

  console.log(`\n  OVERVIEW (90-day hourly window)`);
  console.log(`  ${'─'.repeat(50)}`);
  console.log(`  New entries:              ${totalEntries}`);
  console.log(`  First-hour low exits:     ${totalExitsFirstHour}`);
  console.log(`  Re-entries (confirmed):   ${totalReentries}`);
  console.log(`  Cycle repeats:            ${totalCycleRepeats}`);
  console.log(`  BE stop ratchets:         ${totalBEStopUps}`);
  console.log(`  Lot fills (L2-L5):        ${totalLotFills}`);
  console.log(`  Still open at end:        ${openAtEnd.length}`);

  console.log(`\n  P&L SUMMARY`);
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
  console.log(`  Total Closed Trades:      ${closedTrades.length} (${wins.length}W / ${losses.length}L / ${flat.length}F)`);

  if (bigWin) console.log(`  Biggest Win:              $${bigWin.pnl.toFixed(2)} (${bigWin.ticker} ${bigWin.entryDate})`);
  if (bigLoss) console.log(`  Biggest Loss:             $${bigLoss.pnl.toFixed(2)} (${bigLoss.ticker} ${bigLoss.entryDate})`);

  console.log(`\n  EXIT BREAKDOWN`);
  console.log(`  ${'─'.repeat(50)}`);
  console.log(`  First-hour low break:     ${firstHourExits.length}  (P&L: $${firstHourExits.reduce((s, t) => s + t.pnl, 0).toFixed(2)})`);
  console.log(`  BE stop hit:              ${beStops.length}  (P&L: $${beStops.reduce((s, t) => s + t.pnl, 0).toFixed(2)})`);
  console.log(`  Regular stop hit:         ${stopHits.length}  (P&L: $${stopHits.reduce((s, t) => s + t.pnl, 0).toFixed(2)})`);
  console.log(`  Open at end:              ${openAtEnd.length}  (P&L: $${openAtEnd.reduce((s, t) => s + t.pnl, 0).toFixed(2)})`);

  console.log(`\n  RE-ENTRY TRADES (cycle > 0)`);
  console.log(`  ${'─'.repeat(50)}`);
  console.log(`  Re-entry closed trades:   ${reentryTrades.length}`);
  console.log(`  Re-entry net P&L:         $${reNetPnl.toFixed(2)}`);
  console.log(`  Re-entry win rate:        ${(reWr * 100).toFixed(1)}%`);
  console.log(`  Re-entry profit factor:   ${rePf.toFixed(2)}x`);

  // ── TOP 20 INDIVIDUAL TRADES ──────────────────────────────────────────────
  console.log(`\n  TOP 20 WINNING TRADES`);
  console.log(`  ${'─'.repeat(90)}`);
  console.log(`  ${'#'.padStart(3)} ${'Ticker'.padEnd(7)} ${'Phase'.padEnd(22)} ${'Entry'.padStart(9)} ${'Exit'.padStart(9)} ${'Shares'.padStart(7)} ${'P&L'.padStart(10)} ${'Peak$'.padStart(8)} ${'Cyc'.padStart(4)} ${'Date'.padEnd(12)}`);
  const topWins = [...closedTrades].sort((a, b) => b.pnl - a.pnl).slice(0, 20);
  for (let i = 0; i < topWins.length; i++) {
    const t = topWins[i];
    console.log(`  ${String(i + 1).padStart(3)} ${(t.ticker || '').padEnd(7)} ${(t.phase || '').padEnd(22)} $${(t.entryPrice || 0).toFixed(2).padStart(8)} $${(t.exitPrice || 0).toFixed(2).padStart(8)} ${String(t.shares || 0).padStart(7)} $${t.pnl.toFixed(2).padStart(9)} $${(t.peakProfit || 0).toFixed(0).padStart(7)} ${String(t.cycleNum || 0).padStart(4)} ${(t.exitDate || '').padEnd(12)}`);
  }

  // ── WORST 20 TRADES ───────────────────────────────────────────────────────
  console.log(`\n  WORST 20 LOSING TRADES`);
  console.log(`  ${'─'.repeat(90)}`);
  console.log(`  ${'#'.padStart(3)} ${'Ticker'.padEnd(7)} ${'Phase'.padEnd(22)} ${'Entry'.padStart(9)} ${'Exit'.padStart(9)} ${'Shares'.padStart(7)} ${'P&L'.padStart(10)} ${'Peak$'.padStart(8)} ${'Cyc'.padStart(4)} ${'Date'.padEnd(12)}`);
  const worstLosses = [...closedTrades].sort((a, b) => a.pnl - b.pnl).slice(0, 20);
  for (let i = 0; i < worstLosses.length; i++) {
    const t = worstLosses[i];
    console.log(`  ${String(i + 1).padStart(3)} ${(t.ticker || '').padEnd(7)} ${(t.phase || '').padEnd(22)} $${(t.entryPrice || 0).toFixed(2).padStart(8)} $${(t.exitPrice || 0).toFixed(2).padStart(8)} ${String(t.shares || 0).padStart(7)} $${t.pnl.toFixed(2).padStart(9)} $${(t.peakProfit || 0).toFixed(0).padStart(7)} ${String(t.cycleNum || 0).padStart(4)} ${(t.exitDate || '').padEnd(12)}`);
  }

  // ── TICKER SUMMARY ────────────────────────────────────────────────────────
  const tickerStats = {};
  for (const t of closedTrades) {
    if (!tickerStats[t.ticker]) tickerStats[t.ticker] = { pnl: 0, trades: 0, wins: 0, reentries: 0 };
    tickerStats[t.ticker].pnl += t.pnl;
    tickerStats[t.ticker].trades++;
    if (t.pnl > 0) tickerStats[t.ticker].wins++;
    if (t.cycleNum > 0) tickerStats[t.ticker].reentries++;
  }
  const tickerArr = Object.entries(tickerStats).map(([ticker, s]) => ({ ticker, ...s }));
  tickerArr.sort((a, b) => b.pnl - a.pnl);

  console.log(`\n  TOP 20 TICKERS BY NET P&L`);
  console.log(`  ${'─'.repeat(60)}`);
  console.log(`  ${'#'.padStart(3)} ${'Ticker'.padEnd(7)} ${'Net P&L'.padStart(10)} ${'Trades'.padStart(7)} ${'Wins'.padStart(5)} ${'WR'.padStart(6)} ${'ReEnts'.padStart(7)}`);
  for (let i = 0; i < Math.min(20, tickerArr.length); i++) {
    const s = tickerArr[i];
    console.log(`  ${String(i + 1).padStart(3)} ${s.ticker.padEnd(7)} $${s.pnl.toFixed(2).padStart(9)} ${String(s.trades).padStart(7)} ${String(s.wins).padStart(5)} ${(s.trades ? (s.wins / s.trades * 100).toFixed(0) : 0).toString().padStart(5)}% ${String(s.reentries).padStart(7)}`);
  }

  console.log(`\n  BOTTOM 10 TICKERS BY NET P&L`);
  console.log(`  ${'─'.repeat(60)}`);
  const bottom = [...tickerArr].sort((a, b) => a.pnl - b.pnl).slice(0, 10);
  for (let i = 0; i < bottom.length; i++) {
    const s = bottom[i];
    console.log(`  ${String(i + 1).padStart(3)} ${s.ticker.padEnd(7)} $${s.pnl.toFixed(2).padStart(9)} ${String(s.trades).padStart(7)} ${String(s.wins).padStart(5)} ${(s.trades ? (s.wins / s.trades * 100).toFixed(0) : 0).toString().padStart(5)}% ${String(s.reentries).padStart(7)}`);
  }

  console.log('\n' + '='.repeat(110));
  console.log('  V4 BACKTEST COMPLETE');
  console.log('='.repeat(110));

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
