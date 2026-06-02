// server/backtest/pai300HourlyV7_graduated.js
// ── V7A 1H-STOP: FULL SIZE vs GRADUATED SIZE ────────────────────────────
//
// Both use firstHourLow - fees as initial stop (1H stop = winner).
// FULL  = 100% sizing from day 1
// GRAD  = 50% sizing until $125K NAV, 75% until $166K, then 100%
//
// Tracks NAV milestones with dates to answer: when do we hit $1M?
//
// Usage: cd server && node backtest/pai300HourlyV7_graduated.js
// ────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import fs from 'fs';
import os from 'os';
import path from 'path';
import { connectToDatabase } from '../database.js';
import { SECTORS } from '../scripts/aiUniverse/aiUniverseData.js';
import { SECTOR_EMA_PERIODS } from '../data/pnthrAiSectorsConfig.js';
import { CARNIVORE_MODE_TICKERS } from '../data/strategyMode.js';
import { detectAllSignals, calculateEMA, blInitStop, ssInitStop, computeWilderATR } from '../signalDetection.js';
import { calcCommission, calcBorrowCost } from './costEngine.js';

let NAV_INITIAL     = 83_000;
const VITALITY_PCT    = 0.01;
const TICKER_CAP_PCT  = 0.10;
const STRIKE_PCT      = [0.35, 0.25, 0.20, 0.12, 0.08];
const LOT_OFFSETS     = [0, 0.03, 0.06, 0.10, 0.14];
const MAX_LOSS        = 300;
const BE_THRESHOLD    = 75;
const PAI300_REGIME_PERIOD = 36;
const FIRST_HOUR_END  = '10:30';
const SLIPPAGE_BPS    = 5;
const COMMISSION_PER_SHARE = 0.005;
const WITHDRAWAL_THRESHOLD = 2_000_000;
const WITHDRAWAL_AMOUNT    = 1_000_000;

// ── GRADUATED SIZING THRESHOLDS ──
const GRAD_TIER_1 = 125_000;   // 50% → 75% at $125K
const GRAD_TIER_2 = 166_000;   // 75% → 100% at $166K

function getSizingMultiplier(currentNav, useGraduated) {
  if (!useGraduated) return 1.0;
  if (currentNav >= GRAD_TIER_2) return 1.00;
  if (currentNav >= GRAD_TIER_1) return 0.75;
  return 0.50;
}

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
  return AI_TICKER_META[ticker]?.sector || 'Technology';
}
function getWeekOf(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const dow = d.getDay(); const daysToMon = dow === 0 ? -6 : 1 - dow;
  const m = new Date(d); m.setDate(d.getDate() + daysToMon);
  return m.toISOString().split('T')[0];
}
function computeEMASeed(closes, period) {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  const result = new Array(period - 1).fill(null); result.push(ema);
  for (let i = period; i < closes.length; i++) { ema = closes[i] * k + ema * (1 - k); result.push(ema); }
  return result;
}
function extractTime(dateStr) { const p = dateStr.split(' '); return p.length > 1 ? p[1].slice(0, 5) : '00:00'; }
function isConfirmedGreenBreakout(bar, prevBar) {
  return prevBar && bar.close > bar.open && bar.high > prevBar.high && bar.close > prevBar.high;
}
function isConfirmedRedBreakdown(bar, prevBar) {
  return prevBar && bar.close < bar.open && bar.low < prevBar.low && bar.close < prevBar.low;
}
function applySlip(price, adverse) {
  const s = price * (SLIPPAGE_BPS / 10000);
  return adverse ? +(price + s).toFixed(4) : +(price - s).toFixed(4);
}
function entrySlip(price, dir) { return dir === 'LONG' ? applySlip(price, true) : applySlip(price, false); }
function exitSlip(price, dir) { return dir === 'LONG' ? applySlip(price, false) : applySlip(price, true); }
function comm(shares, price) { return calcCommission(shares, price); }

async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('No DB'); process.exit(1); }

  console.log('='.repeat(140));
  console.log('  PNTHR AMBUSH V7.3 — LOT-TRAIL + GUARDRAIL + $2M WITHDRAWAL BACKTEST');
  console.log('  1H Stop (firstHourLow - fees) | Post-BE stop = previous lot price | 2-bar-low-break exit | NO daily ratchet');
  console.log(`  $83K Starting NAV / $75 Break Even / 2-bar trailing / Real IBKR fees / 5bps slippage`);
  console.log(`  Graduated tiers: 50% until $${(GRAD_TIER_1/1000).toFixed(0)}K → 75% until $${(GRAD_TIER_2/1000).toFixed(0)}K → 100%`);
  console.log('='.repeat(140));

  // ── LOAD DATA ──────────────────────────────────────────────────────────────
  console.log('\n[1] Loading data...');
  const dailyDocs = await db.collection('pnthr_ai_bt_candles').find({}, { projection: { ticker: 1, daily: 1 } }).toArray();
  const weeklyDocs = await db.collection('pnthr_ai_bt_candles_weekly').find({}, { projection: { ticker: 1, weekly: 1 } }).toArray();
  const hourlyDocs = await db.collection('pnthr_ai_hourly_candles').find({}, { projection: { ticker: 1, hourly: 1 } }).toArray();
  const sectorRankDocs = await db.collection('pnthr_ai_sector_rank_daily').find({}).sort({ date: 1 }).toArray();
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
      const first = bars[0].date.split(' ')[0]; const last = bars[bars.length - 1].date.split(' ')[0];
      if (first < hourlyMinDate) hourlyMinDate = first;
      if (last > hourlyMaxDate) hourlyMaxDate = last;
    }
  }
  const dailyBarMap = {};
  for (const doc of dailyDocs) { const map = {}; for (const b of (doc.daily || [])) map[b.date] = b; dailyBarMap[doc.ticker] = map; }

  const hourlyDatesSet = new Set();
  for (const bars of Object.values(hourlyBarMap)) { for (const b of bars) hourlyDatesSet.add(b.date.split(' ')[0]); }
  const hourlyTradingDates = [...hourlyDatesSet].sort();

  const weeklyBarsByTicker = {};
  for (const doc of weeklyDocs) {
    const sorted = (doc.weekly || []).sort((a, b) => (a.weekOf || a.date).localeCompare(b.weekOf || b.date));
    weeklyBarsByTicker[doc.ticker] = sorted.map(w => ({ time: w.weekOf || w.date, open: w.open, high: w.high, low: w.low, close: w.close }));
  }

  const pai300Weekly = (pai300Doc?.weekly || []).sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  const pai300Closes = pai300Weekly.map(w => w.close);
  const pai300Ema = computeEMASeed(pai300Closes, PAI300_REGIME_PERIOD);
  const pai300RegimeByWeek = {};
  for (let i = 0; i < pai300Weekly.length; i++) { if (pai300Ema[i] != null) pai300RegimeByWeek[pai300Weekly[i].weekOf] = pai300Closes[i] > pai300Ema[i]; }

  const spyWeekly = (spyWeeklyDoc?.weekly || []).sort((a, b) => (a.weekOf || a.date).localeCompare(b.weekOf || b.date));
  const spyCloses = spyWeekly.map(w => w.close);
  const spyEma21 = computeEMASeed(spyCloses, 21);
  const spyRegimeByWeek = {};
  for (let i = 0; i < spyWeekly.length; i++) { if (spyEma21[i] != null) spyRegimeByWeek[spyWeekly[i].weekOf || spyWeekly[i].date] = spyCloses[i] > spyEma21[i]; }

  const etfAboveEmaByWeek = {};
  for (const [etf, doc] of Object.entries(etfWeeklyDocs)) {
    const bars = (doc.weekly || []).sort((a, b) => (a.weekOf || a.date).localeCompare(b.weekOf || b.date));
    const closes = bars.map(w => w.close); const period = ETF_EMA_PERIOD[etf] || 21;
    const ema = computeEMASeed(closes, period); const map = {};
    for (let i = 0; i < bars.length; i++) { if (ema[i] != null) map[bars[i].weekOf || bars[i].date] = closes[i] > ema[i]; }
    etfAboveEmaByWeek[etf] = map;
  }
  const aiSectorTierByDate = {};
  for (const doc of sectorRankDocs) {
    const tiers = {}; for (const r of (doc.ranks || [])) tiers[r.sectorId] = r.tier;
    aiSectorTierByDate[doc.date] = tiers;
  }

  console.log(`  Hourly: ${hourlyMinDate} to ${hourlyMaxDate} (${hourlyTradingDates.length} days)`);
  console.log(`  Tickers: ${Object.keys(hourlyBarMap).length}`);

  // ── SIGNALS ────────────────────────────────────────────────────────────────
  console.log('\n[2] Computing signals...');
  const allTickers = Object.keys(weeklyBarsByTicker).filter(t => AI_TICKER_META[t] || CARNIVORE_MODE_TICKERS.has(t));
  const signalsByTicker = {};
  for (const ticker of allTickers) {
    const bars = weeklyBarsByTicker[ticker]; if (!bars || bars.length < 35) continue;
    const isCarnivore = CARNIVORE_MODE_TICKERS.has(ticker);
    const sectorId = AI_TICKER_META[ticker]?.sectorId;
    const period = isCarnivore ? 21 : (SECTOR_EMA_PERIODS[sectorId] ?? SECTOR_EMA_PERIODS[String(sectorId)] ?? 30);
    const gateOffset = isCarnivore ? 0.10 : 0.25;
    const result = detectAllSignals(bars, period, false, null, gateOffset);
    const activeBLPeriods = [], activeSSPeriods = [];
    let blStart = null, ssStart = null;
    for (const evt of result.events) {
      if (evt.signal === 'BL') blStart = evt.time;
      if ((evt.signal === 'BE' || evt.signal === 'SS') && blStart) { activeBLPeriods.push({ from: blStart, to: evt.time }); blStart = null; }
      if (evt.signal === 'SS') ssStart = evt.time;
      if ((evt.signal === 'SE' || evt.signal === 'BL') && ssStart) { activeSSPeriods.push({ from: ssStart, to: evt.time }); ssStart = null; }
    }
    if (blStart) activeBLPeriods.push({ from: blStart, to: '9999-12-31' });
    if (ssStart) activeSSPeriods.push({ from: ssStart, to: '9999-12-31' });
    signalsByTicker[ticker] = { activeBLPeriods, activeSSPeriods, isCarnivore };
  }
  console.log(`  ${Object.keys(signalsByTicker).length} tickers with signals`);

  // ── GATE FUNCTIONS ─────────────────────────────────────────────────────────
  function getRegime(ticker, dateStr) {
    const weekOf = getWeekOf(dateStr);
    const rm = CARNIVORE_MODE_TICKERS.has(ticker) ? spyRegimeByWeek : pai300RegimeByWeek;
    if (rm[weekOf] !== undefined) return rm[weekOf];
    const ws = Object.keys(rm).sort(); let best = null;
    for (const w of ws) { if (w <= weekOf) best = w; else break; }
    return best !== null ? rm[best] : true;
  }
  function getSectorOk(ticker, dateStr) {
    const weekOf = getWeekOf(dateStr);
    if (!CARNIVORE_MODE_TICKERS.has(ticker)) {
      const dates = Object.keys(aiSectorTierByDate).sort(); let best = null;
      for (const d of dates) { if (d <= dateStr) best = d; else break; }
      if (!best) return true;
      return aiSectorTierByDate[best]?.[AI_TICKER_META[ticker]?.sectorId] !== 'AVOID';
    }
    const gics = CARNIVORE_GICS[ticker]; const etf = CARNIVORE_SECTOR_MAP[gics];
    if (!etf) return true; const etfMap = etfAboveEmaByWeek[etf]; if (!etfMap) return true;
    let above = etfMap[weekOf];
    if (above === undefined) { const ws = Object.keys(etfMap).sort(); let best = null; for (const w of ws) { if (w <= weekOf) best = w; else break; } above = best ? etfMap[best] : true; }
    return above;
  }
  function isActiveBL(ticker, dateStr) {
    const sig = signalsByTicker[ticker]; if (!sig) return false; const weekOf = getWeekOf(dateStr);
    for (const p of sig.activeBLPeriods) { if (weekOf >= p.from && weekOf <= p.to) return true; } return false;
  }
  function isActiveSS(ticker, dateStr) {
    const sig = signalsByTicker[ticker]; if (!sig) return false; const weekOf = getWeekOf(dateStr);
    for (const p of sig.activeSSPeriods) { if (weekOf >= p.from && weekOf <= p.to) return true; } return false;
  }
  function countTradingDays(fromDate, toDate) {
    const from = hourlyTradingDates.indexOf(fromDate); const to = hourlyTradingDates.indexOf(toDate);
    if (from < 0 || to < 0) return Math.max(1, Math.round((new Date(toDate) - new Date(fromDate)) / 86400000 * 5/7));
    return Math.max(1, to - from);
  }

  // ── SIMULATION ENGINE ──────────────────────────────────────────────────────
  function runSim({ maxPositions = 999, pessimistic = false, withdrawals = false, label = '', useGraduated = false, exitMode = 'be75', gateMode = 'regime', entryMode = 'lookahead', lookbackBars = 1, greenFilter = false }) {
    const twoBarGoverns = exitMode === '2bar';
    const useBE75 = exitMode === 'be75';
    let cash = NAV_INITIAL;
    const exits = [];
    const positions = {};
    const waiting = {};
    const pendingReentry = {};
    const dailyLedger = []; // daily cash/NAV snapshot for CSV export
    let totalComm = 0, totalBorrow = 0;
    let totalEntries = 0, totalExits1H = 0, totalReentries = 0;
    let totalBEStopUps = 0, totalLotFills = 0, totalCycleRepeats = 0;
    let totalTrailingExits = 0, skippedNoCash = 0, skippedMaxPos = 0;
    let totalLongEntries = 0, totalShortEntries = 0;
    let maxConcurrentPositions = 0;
    let worstSingleTrade = 0;
    let skippedNo1HLow = 0;
    let totalLotStopExits = 0;
    let totalWithdrawn = 0;
    // Cash ledger tracking
    let minCash = NAV_INITIAL;
    let daysTappedOut = 0;
    let peakDeployedPct = 0;

    // ── MILESTONE TRACKING ──
    const MILESTONES = [100_000, 125_000, 166_000, 250_000, 500_000, 1_000_000, 2_000_000, 3_000_000, 5_000_000, 8_000_000];
    const milestoneHits = {};  // { amount: date }

    // ── SIZING TIER TRACKING ──
    let currentTierLabel = '50%';
    const tierChanges = [];  // { date, from, to, nav }

    function openCount() { return Object.keys(positions).length; }
    function deployed() { let d = 0; for (const p of Object.values(positions)) d += p.avgCost * p.totalShares; return d; }
    function nav() { return cash + deployed(); }

    function doExit(ticker, phase, shares, exitPrice, avgCost, date, hour, cycleNum, peak, direction, entryDate) {
      const c = comm(shares, exitPrice); totalComm += c;
      let pnl;
      if (direction === 'SHORT') {
        const td = countTradingDays(entryDate, date);
        const borrow = calcBorrowCost(shares, avgCost, td, getSectorName(ticker));
        totalBorrow += borrow;
        pnl = +(shares * (avgCost - exitPrice) - c - borrow).toFixed(2);
        cash += +(shares * avgCost + pnl).toFixed(2);
      } else {
        const proceeds = +(shares * exitPrice - c).toFixed(2);
        pnl = +(proceeds - shares * avgCost).toFixed(2);
        cash += proceeds;
      }
      if (pnl < worstSingleTrade) worstSingleTrade = pnl;
      exits.push({ pnl, date, hour, ticker, type: phase, direction, shares, avgCost, exitPrice, entryDate });
      return pnl;
    }

    for (let dayIdx = 0; dayIdx < hourlyTradingDates.length; dayIdx++) {
      const date = hourlyTradingDates[dayIdx];

      // Withdrawal check at start of day
      if (withdrawals && nav() >= WITHDRAWAL_THRESHOLD) {
        cash -= WITHDRAWAL_AMOUNT;
        totalWithdrawn += WITHDRAWAL_AMOUNT;
      }

      const dayHourly = {};
      for (const [t, bars] of Object.entries(hourlyBarMap)) {
        const db = bars.filter(b => b.date.startsWith(date));
        if (db.length) dayHourly[t] = db;
      }

      const curCount = openCount();
      if (curCount > maxConcurrentPositions) maxConcurrentPositions = curCount;

      // Cash ledger snapshot at start of day
      if (cash < minCash) minCash = cash;
      if (cash < 500) daysTappedOut++;
      const currentNav = nav();
      const dep = deployed();
      if (currentNav > 0) {
        const depPct = dep / currentNav;
        if (depPct > peakDeployedPct) peakDeployedPct = depPct;
      }

      // ── MILESTONE CHECK ──
      for (const m of MILESTONES) {
        if (!milestoneHits[m] && currentNav >= m) {
          milestoneHits[m] = date;
        }
      }

      // ── SIZING TIER CHECK ──
      if (useGraduated) {
        let newTier;
        if (currentNav >= GRAD_TIER_2) newTier = '100%';
        else if (currentNav >= GRAD_TIER_1) newTier = '75%';
        else newTier = '50%';
        if (newTier !== currentTierLabel) {
          tierChanges.push({ date, from: currentTierLabel, to: newTier, nav: Math.round(currentNav) });
          currentTierLabel = newTier;
        }
      }

      // Get current sizing multiplier
      const sizeMult = getSizingMultiplier(currentNav, useGraduated);

      // ═══ PHASE A: Process existing positions ═══
      for (const [ticker, pos] of Object.entries(positions)) {
        const hBars = dayHourly[ticker]; if (!hBars || !hBars.length) continue;
        const isLong = pos.direction === 'LONG';
        const firstHourBars = hBars.filter(b => extractTime(b.date) < FIRST_HOUR_END);
        const afterFirstHour = hBars.filter(b => extractTime(b.date) >= FIRST_HOUR_END);
        const firstHourLow = firstHourBars.length ? Math.min(...firstHourBars.map(b => b.low)) : null;
        const firstHourHigh = firstHourBars.length ? Math.max(...firstHourBars.map(b => b.high)) : null;

        // V7.2: daily first-hour-low ratchet REMOVED. Post-BE the stop follows the lots.

        let runningLow = firstHourLow ?? Infinity;
        let runningHigh = firstHourHigh ?? -Infinity;

        // First-hour bars: stop check only
        for (const hBar of firstHourBars) {
          if (!positions[ticker]) break;
          if (hBar.low < runningLow) runningLow = hBar.low;
          if (hBar.high > runningHigh) runningHigh = hBar.high;
          if (isLong && pos.stop != null && hBar.low <= pos.stop) {
            doExit(ticker, 'STOP_HIT_1H', pos.totalShares, exitSlip(pos.stop, 'LONG'), pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak, 'LONG', pos.entryDate);
            waiting[ticker] = { originalEntry: pos.originalEntry, runningLow, runningHigh, cycleNum: pos.cycleNum + 1, direction: 'LONG' };
            delete positions[ticker]; break;
          }
          if (!isLong && pos.stop != null && hBar.high >= pos.stop) {
            doExit(ticker, 'STOP_HIT_1H', pos.totalShares, exitSlip(pos.stop, 'SHORT'), pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak, 'SHORT', pos.entryDate);
            waiting[ticker] = { originalEntry: pos.originalEntry, runningLow, runningHigh, cycleNum: pos.cycleNum + 1, direction: 'SHORT' };
            delete positions[ticker]; break;
          }
          const unr = isLong ? (hBar.high - pos.avgCost) * pos.totalShares : (pos.avgCost - hBar.low) * pos.totalShares;
          if (unr > (pos.peak || 0)) pos.peak = +unr.toFixed(2);
          if (useBE75 && !pos.atBE && unr >= BE_THRESHOLD) {
            pos.atBE = true; pos.trailingActive = false; pos.beDate = date;
            const feePer = comm(pos.totalShares, pos.avgCost) / pos.totalShares;
            pos.stop = isLong ? +(pos.avgCost + feePer).toFixed(2) : +(pos.avgCost - feePer).toFixed(2);
            totalBEStopUps++;
          }
        }
        if (!positions[ticker]) continue;

        // After-first-hour bars
        // V7.2: lower-low / higher-high tracking persists on the position (pos._prevLow / _prevPrevLow).
        for (const hBar of afterFirstHour) {
          if (!positions[ticker]) break;
          if (hBar.low < runningLow) runningLow = hBar.low;
          if (hBar.high > runningHigh) runningHigh = hBar.high;

          const checkStop = () => {
            if (!positions[ticker]) return;
            if (isLong) {
              // V7.2 exit #1 (post-BE only): two prior after-hour bars formed a lower low,
              // and this bar takes out (prev bar low - $0.01). Exit there IF above the stop.
              if (pos.atBE && pos._prevLow != null && pos._prevPrevLow != null && pos._prevLow < pos._prevPrevLow) {
                const breakLevel = +(pos._prevLow - 0.01).toFixed(2);
                if ((twoBarGoverns || breakLevel > pos.stop) && hBar.low <= breakLevel) {
                  doExit(ticker, 'TRAILING_STOP', pos.totalShares, exitSlip(breakLevel, 'LONG'), pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak, 'LONG', pos.entryDate);
                  totalTrailingExits++;
                  waiting[ticker] = { originalEntry: pos.originalEntry, runningLow: hBar.low, runningHigh, cycleNum: pos.cycleNum + 1, direction: 'LONG' };
                  delete positions[ticker]; return;
                }
              }
              // V7.2 exit #2: the hard stop. Pre-BE = first-hour low; post-BE = breakeven/lot-based.
              if (pos.stop != null && hBar.low <= pos.stop) {
                doExit(ticker, pos.atBE ? 'LOT_STOP' : '1H_LOW_BREAK', pos.totalShares, exitSlip(pos.stop, 'LONG'), pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak, 'LONG', pos.entryDate);
                if (pos.atBE) totalLotStopExits++; else totalExits1H++;
                waiting[ticker] = { originalEntry: pos.originalEntry, runningLow: hBar.low, runningHigh, cycleNum: pos.cycleNum + 1, direction: 'LONG' };
                delete positions[ticker]; return;
              }
            } else {
              if (pos.atBE && pos._prevHigh != null && pos._prevPrevHigh != null && pos._prevHigh > pos._prevPrevHigh) {
                const breakLevel = +(pos._prevHigh + 0.01).toFixed(2);
                if ((twoBarGoverns || breakLevel < pos.stop) && hBar.high >= breakLevel) {
                  doExit(ticker, 'TRAILING_STOP', pos.totalShares, exitSlip(breakLevel, 'SHORT'), pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak, 'SHORT', pos.entryDate);
                  totalTrailingExits++;
                  waiting[ticker] = { originalEntry: pos.originalEntry, runningLow, runningHigh: hBar.high, cycleNum: pos.cycleNum + 1, direction: 'SHORT' };
                  delete positions[ticker]; return;
                }
              }
              if (pos.stop != null && hBar.high >= pos.stop) {
                doExit(ticker, pos.atBE ? 'LOT_STOP' : '1H_HIGH_BREAK', pos.totalShares, exitSlip(pos.stop, 'SHORT'), pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak, 'SHORT', pos.entryDate);
                if (pos.atBE) totalLotStopExits++; else totalExits1H++;
                waiting[ticker] = { originalEntry: pos.originalEntry, runningLow, runningHigh: hBar.high, cycleNum: pos.cycleNum + 1, direction: 'SHORT' };
                delete positions[ticker]; return;
              }
            }
          };

          const checkLots = () => {
            if (!positions[ticker]) return;
            if (pos.nextLot <= 4) {
              const offset = LOT_OFFSETS[pos.nextLot];
              const lotTrigger = isLong ? +(pos.originalEntry * (1 + offset)).toFixed(2) : +(pos.originalEntry * (1 - offset)).toFixed(2);
              const triggered = isLong ? hBar.high >= lotTrigger : hBar.low <= lotTrigger;
              if (triggered) {
                const lotShares = pos.lotPlan[pos.nextLot];
                const fillPrice = isLong ? entrySlip(lotTrigger, 'LONG') : entrySlip(lotTrigger, 'SHORT');
                const c = comm(lotShares, fillPrice); totalComm += c;
                const lotCost = lotShares * fillPrice + c;
                if (cash >= lotCost) {
                  const oldCost = pos.avgCost * pos.totalShares;
                  cash -= lotCost;
                  pos.totalShares += lotShares;
                  pos.avgCost = +((oldCost + fillPrice * lotShares) / pos.totalShares).toFixed(4);
                  pos.nextLot++; totalLotFills++;
                  // V7.2: post-BE, stop moves to the PREVIOUS lot's trigger price, but NEVER
                  // worse than the recomputed breakeven (guardrail caps cheap-stock give-backs).
                  if (pos.atBE) {
                    const feePer = comm(pos.totalShares, pos.avgCost) / pos.totalShares;
                    const breakeven = isLong ? +(pos.avgCost + feePer).toFixed(2) : +(pos.avgCost - feePer).toFixed(2);
                    const prevLotIdx = pos.nextLot - 2; // lot just below the one that filled
                    let lotStop = breakeven;
                    if (prevLotIdx >= 0) {
                      lotStop = isLong
                        ? +(pos.originalEntry * (1 + LOT_OFFSETS[prevLotIdx])).toFixed(2)
                        : +(pos.originalEntry * (1 - LOT_OFFSETS[prevLotIdx])).toFixed(2);
                    }
                    pos.stop = isLong
                      ? Math.max(pos.stop, lotStop, breakeven)
                      : Math.min(pos.stop, lotStop, breakeven);
                  }
                }
              }
            }
          };

          if (pessimistic) { checkStop(); checkLots(); } else { checkLots(); checkStop(); }

          if (!positions[ticker]) { continue; }

          const unr = isLong ? (hBar.high - pos.avgCost) * pos.totalShares : (pos.avgCost - hBar.low) * pos.totalShares;
          if (unr > (pos.peak || 0)) pos.peak = +unr.toFixed(2);
          if (useBE75 && !pos.atBE && unr >= BE_THRESHOLD) {
            pos.atBE = true; pos.trailingActive = false; pos.beDate = date;
            const feePer = comm(pos.totalShares, pos.avgCost) / pos.totalShares;
            pos.stop = isLong ? +(pos.avgCost + feePer).toFixed(2) : +(pos.avgCost - feePer).toFixed(2);
            totalBEStopUps++;
          }
          if (pos.atBE && !pos.trailingActive && pos.beDate && pos.beDate !== date) pos.trailingActive = true;
          if (pos.atBE && !pos.beDate) pos.beDate = date;

          pos._prevPrevLow = pos._prevLow; pos._prevLow = hBar.low;
          pos._prevPrevHigh = pos._prevHigh; pos._prevHigh = hBar.high;
        }
      }

      // ═══ PHASE B-1: Execute pending re-entries ═══
      for (const [ticker, pend] of Object.entries(pendingReentry)) {
        if (positions[ticker]) { delete pendingReentry[ticker]; continue; }
        const hBars = dayHourly[ticker]; if (!hBars || !hBars.length) { delete pendingReentry[ticker]; continue; }
        if (openCount() >= maxPositions) { skippedMaxPos++; delete pendingReentry[ticker]; continue; }
        const isLong = pend.direction === 'LONG';
        const firstAfterOpen = hBars.find(b => extractTime(b.date) >= FIRST_HOUR_END) || hBars[0];
        const rePrice = isLong ? entrySlip(firstAfterOpen.open, 'LONG') : entrySlip(firstAfterOpen.open, 'SHORT');
        const reStop = isLong ? +(pend.runningLow - 0.01).toFixed(2) : +(pend.runningHigh + 0.01).toFixed(2);
        if (isLong && reStop >= rePrice) { delete pendingReentry[ticker]; continue; }
        if (!isLong && reStop <= rePrice) { delete pendingReentry[ticker]; continue; }
        const rps = isLong ? rePrice - reStop : reStop - rePrice;
        if (rps <= 0.01) { delete pendingReentry[ticker]; continue; }
        const maxShares = Math.floor(MAX_LOSS / rps); if (maxShares < 1) { delete pendingReentry[ticker]; continue; }
        const n = nav();
        let totalShares = Math.min(maxShares, Math.floor((n * VITALITY_PCT) / rps), Math.floor((n * TICKER_CAP_PCT) / rePrice));
        // Apply graduated sizing
        totalShares = Math.max(1, Math.floor(totalShares * sizeMult));
        if (totalShares < 1) { delete pendingReentry[ticker]; continue; }
        const l1 = Math.max(1, Math.round(totalShares * STRIKE_PCT[0]));
        const lotPlan = STRIKE_PCT.map(p => Math.max(1, Math.round(totalShares * p)));
        const c = comm(l1, rePrice); totalComm += c;
        if (cash < l1 * rePrice + c) { skippedNoCash++; delete pendingReentry[ticker]; continue; }
        cash -= l1 * rePrice + c;
        positions[ticker] = {
          ticker, entryPrice: rePrice, avgCost: rePrice, entryDate: date,
          originalEntry: pend.originalEntry || rePrice, totalShares: l1, lotPlan,
          stop: reStop, atBE: twoBarGoverns, trailingActive: false, peak: 0, nextLot: 1,
          cycleNum: pend.cycleNum, direction: pend.direction,
        };
        totalReentries++;
        if (pend.direction === 'LONG') totalLongEntries++; else totalShortEntries++;
        if (pend.cycleNum > 1) totalCycleRepeats++;
        delete pendingReentry[ticker];
      }

      // ═══ PHASE B-2: Check re-entry signals ═══
      for (const [ticker, w] of Object.entries(waiting)) {
        if (positions[ticker] || pendingReentry[ticker]) { delete waiting[ticker]; continue; }
        const hBars = dayHourly[ticker]; if (!hBars || hBars.length < 2) continue;
        const isLong = w.direction === 'LONG';
        if (isLong && !isActiveBL(ticker, date)) { delete waiting[ticker]; continue; }
        if (!isLong && !isActiveSS(ticker, date)) { delete waiting[ticker]; continue; }
        const regime = getRegime(ticker, date);
        if (isLong && !regime && gateMode !== 'none') continue;
        if (!isLong && regime && gateMode === 'regime') continue;
        if (!getSectorOk(ticker, date)) continue;
        const afterFirst = hBars.filter(b => extractTime(b.date) >= FIRST_HOUR_END);
        if (afterFirst.length < 2) continue;
        for (let i = 1; i < afterFirst.length; i++) {
          const bar = afterFirst[i], prevBar = afterFirst[i - 1];
          if (bar.low < w.runningLow) w.runningLow = bar.low;
          if (bar.high > w.runningHigh) w.runningHigh = bar.high;
          if (isLong ? isConfirmedGreenBreakout(bar, prevBar) : isConfirmedRedBreakdown(bar, prevBar)) {
            pendingReentry[ticker] = { originalEntry: w.originalEntry, runningLow: w.runningLow, runningHigh: w.runningHigh, cycleNum: w.cycleNum, direction: w.direction };
            delete waiting[ticker]; break;
          }
        }
      }

      // ═══ PHASE C: New MCE entries (always use 1H stop) ═══
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
          // gateMode: 'regime' = longs in bull only / shorts in bear only (LOCKED)
          //           'none'   = take BL+1 longs AND SS+1 shorts in ANY regime
          //           'shorts-ungated' = longs still need bull; shorts allowed any regime
          const tryLong  = gateMode === 'none' ? true : regime;
          const tryShort = (gateMode === 'none' || gateMode === 'shorts-ungated') ? true : !regime;

          if (tryLong) (() => {
            if (!isActiveBL(ticker, date)) return;
            const dailyTrigger = Math.max(prev1.high, prev2.high) + 0.01;
            const firstHourBars = hBars.filter(b => extractTime(b.date) < FIRST_HOUR_END);
            const firstHourLow = firstHourBars.length ? Math.min(...firstHourBars.map(b => b.low)) : null;
            if (!firstHourLow) { skippedNo1HLow++; return; }
            let ep = null;
            if (entryMode === 'realtime') {
              // EXECUTABLE: resting stop-buy at max(2-day high, prior-N-bar high). Entry only
              // after 10:30 (1H stop is set). Fill at the level, or the bar open if it gapped
              // above by the time we can act. No look-ahead — only prior bars + this bar's high.
              const seq = hBars.slice().sort((a, b) => a.date.localeCompare(b.date));
              for (let i = 0; i < seq.length; i++) {
                const b = seq[i];
                if (extractTime(b.date) < FIRST_HOUR_END) continue;   // entry only after 10:30
                if (i < lookbackBars) continue;                       // need N prior bars
                const priorNHigh = Math.max(...seq.slice(i - lookbackBars, i).map(x => x.high));
                const level = Math.max(dailyTrigger, +(priorNHigh + 0.01).toFixed(2));
                if (b.high >= level) {                                // stop-buy triggered this bar
                  if (greenFilter && !(b.close > b.open)) continue;
                  ep = entrySlip(Math.max(level, b.open), 'LONG');    // fill at level, or open if gapped above
                  break;
                }
              }
              if (ep == null) return;
            } else {
              if (bar.high < dailyTrigger) return;                    // ORIGINAL look-ahead (daily full-day high)
              let ok = false; for (let i = 1; i < afterFirst.length; i++) { if (isConfirmedGreenBreakout(afterFirst[i], afterFirst[i - 1])) { ok = true; break; } }
              if (!ok) return;
              ep = entrySlip(Math.max(bar.open, dailyTrigger), 'LONG'); // ORIGINAL: fill at 9:30 open / trigger
            }
            if (firstHourLow >= ep) { skippedNo1HLow++; return; }
            const stop = +(firstHourLow - COMMISSION_PER_SHARE).toFixed(2);
            if (stop >= ep) return;
            candidates.push({ ticker, ep, stop, rps: ep - stop, direction: 'LONG' });
          })();

          if (tryShort) (() => {
            if (!isActiveSS(ticker, date)) return;
            const dailyTrigger = Math.min(prev1.low, prev2.low) - 0.01;
            const firstHourBars = hBars.filter(b => extractTime(b.date) < FIRST_HOUR_END);
            const firstHourHigh = firstHourBars.length ? Math.max(...firstHourBars.map(b => b.high)) : null;
            if (!firstHourHigh) { skippedNo1HLow++; return; }
            let ep = null;
            if (entryMode === 'realtime') {
              // EXECUTABLE: resting stop-sell at min(2-day low, prior-N-bar low). Mirror of the long.
              const seq = hBars.slice().sort((a, b) => a.date.localeCompare(b.date));
              for (let i = 0; i < seq.length; i++) {
                const b = seq[i];
                if (extractTime(b.date) < FIRST_HOUR_END) continue;
                if (i < lookbackBars) continue;
                const priorNLow = Math.min(...seq.slice(i - lookbackBars, i).map(x => x.low));
                const level = Math.min(dailyTrigger, +(priorNLow - 0.01).toFixed(2));
                if (b.low <= level) {
                  if (greenFilter && !(b.close < b.open)) continue;
                  ep = entrySlip(Math.min(level, b.open), 'SHORT');
                  break;
                }
              }
              if (ep == null) return;
            } else {
              if (bar.low > dailyTrigger) return;
              let ok = false; for (let i = 1; i < afterFirst.length; i++) { if (isConfirmedRedBreakdown(afterFirst[i], afterFirst[i - 1])) { ok = true; break; } }
              if (!ok) return;
              ep = entrySlip(Math.min(bar.open, dailyTrigger), 'SHORT');
            }
            if (firstHourHigh <= ep) { skippedNo1HLow++; return; }
            const stop = +(firstHourHigh + COMMISSION_PER_SHARE).toFixed(2);
            if (stop <= ep) return;
            candidates.push({ ticker, ep, stop, rps: stop - ep, direction: 'SHORT' });
          })();
        }
        candidates.sort((a, b) => b.rps - a.rps);
        for (const c of candidates) {
          if (openCount() >= maxPositions) { skippedMaxPos++; continue; }
          const { ticker, ep, stop, rps, direction } = c;
          const n = nav();
          let totalShares = Math.min(Math.floor(MAX_LOSS / rps), Math.floor((n * VITALITY_PCT) / rps), Math.floor((n * TICKER_CAP_PCT) / ep));
          // Apply graduated sizing
          totalShares = Math.max(1, Math.floor(totalShares * sizeMult));
          if (totalShares < 1) continue;
          const l1 = Math.max(1, Math.round(totalShares * STRIKE_PCT[0]));
          const lotPlan = STRIKE_PCT.map(p => Math.max(1, Math.round(totalShares * p)));
          const cc = comm(l1, ep); totalComm += cc;
          if (cash < l1 * ep + cc) { skippedNoCash++; continue; }
          cash -= l1 * ep + cc;
          positions[ticker] = {
            ticker, entryPrice: ep, avgCost: ep, entryDate: date, originalEntry: ep,
            totalShares: l1, lotPlan, stop, atBE: twoBarGoverns, trailingActive: false,
            peak: 0, nextLot: 1, cycleNum: 0, direction,
          };
          totalEntries++;
          if (direction === 'LONG') totalLongEntries++; else totalShortEntries++;
        }
      }

      // Daily snapshot for the cash-ledger CSV
      dailyLedger.push({
        date, positions: openCount(),
        cash: +cash.toFixed(2), deployed: +deployed().toFixed(2),
        nav: +nav().toFixed(2), withdrawn: totalWithdrawn,
      });
    }

    // Close remaining
    for (const [ticker, pos] of Object.entries(positions)) {
      const hBars = hourlyBarMap[ticker]; if (!hBars || !hBars.length) continue;
      const last = hBars[hBars.length - 1];
      doExit(ticker, 'OPEN_AT_END', pos.totalShares, exitSlip(last.close, pos.direction), pos.avgCost, last.date.split(' ')[0], last.date, pos.cycleNum, pos.peak, pos.direction, pos.entryDate);
    }

    // Metrics
    const wins = exits.filter(e => e.pnl > 0), losses = exits.filter(e => e.pnl < 0);
    const grossWin = wins.reduce((s, e) => s + e.pnl, 0), grossLoss = losses.reduce((s, e) => s + e.pnl, 0);
    const pf = grossLoss ? grossWin / Math.abs(grossLoss) : 999;
    const wr = exits.length ? wins.length / exits.length : 0;
    const avgWin = wins.length ? grossWin / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(grossLoss / losses.length) : 1;
    let equity = NAV_INITIAL, peak = NAV_INITIAL, maxDD = 0, maxDDDollar = 0;
    for (const e of exits.sort((a, b) => (a.date + a.hour).localeCompare(b.date + b.hour))) {
      equity += e.pnl; if (equity > peak) peak = equity;
      const dd = (peak - equity) / peak; if (dd > maxDD) maxDD = dd;
      const dd$ = peak - equity; if (dd$ > maxDDDollar) maxDDDollar = dd$;
    }
    const dailyReturns = []; let dailyEquity = NAV_INITIAL;
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
    const downRet = dailyReturns.filter(r => r < 0);
    const downStd = downRet.length > 1 ? Math.sqrt(downRet.reduce((s, r) => s + r ** 2, 0) / (downRet.length - 1)) : 0.0001;
    const ann = Math.sqrt(252);
    const sharpe = (avgRet / stdDev) * ann, sortino = (avgRet / downStd) * ann;
    const years = (new Date(hourlyTradingDates[hourlyTradingDates.length - 1] + 'T12:00:00') - new Date(hourlyTradingDates[0] + 'T12:00:00')) / (365.25 * 24 * 60 * 60 * 1000);
    const cagr = (Math.pow(equity / NAV_INITIAL, 1 / years) - 1) * 100;

    return {
      label, netReturn: ((equity - NAV_INITIAL) / NAV_INITIAL) * 100, cagr, sharpe, sortino,
      pf, wr: wr * 100, payoff: avgLoss > 0 ? avgWin / avgLoss : 999,
      maxDD: maxDD * 100, equity,
      trades: exits.length, totalEntries, totalReentries, totalExits1H,
      totalTrailingExits, totalBEStopUps, totalLotFills,
      totalLongEntries, totalShortEntries,
      maxConcurrentPositions, worstSingleTrade,
      skippedNoCash, skippedMaxPos, skippedNo1HLow, totalLotStopExits,
      totalComm, totalBorrow, totalWithdrawn,
      minCash, daysTappedOut, peakDeployedPct: +(peakDeployedPct * 100).toFixed(1),
      milestoneHits, tierChanges,
      worstTrades: exits.slice().sort((a, b) => a.pnl - b.pnl).slice(0, 5),
      lotStopExits: totalLotStopExits,
      dailyLedger, closedTrades: exits,
      positiveMonthsPct: +(totalMonths ? (posMonths / totalMonths) * 100 : 0).toFixed(1),
      maxDDDollar: +maxDDDollar.toFixed(0),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Generate per-tier Ambush IR data (daily NAV + capped trade log + stats) ─
  const fsMod = fs; const pathMod = path;
  const { computeTradeStats } = await import('../irLiveService.js');
  const TIERS = [
    { key: '1m',   seedNav: 1_000_000 },
    { key: '500k', seedNav: 500_000 },
    { key: '100k', seedNav: 100_000 },
  ];
  const V74 = { gateMode: 'none', exitMode: '2bar', entryMode: 'realtime', lookbackBars: 1 };
  const outDir = new URL('../data/ambushIr/', import.meta.url).pathname;
  try { fsMod.mkdirSync(outDir, { recursive: true }); } catch {}
  function wdays(entry, exit) {
    if (!entry || !exit) return 0;
    let n = 0; const d = new Date(entry + 'T12:00:00'); const e = new Date(exit + 'T12:00:00');
    while (d < e) { d.setDate(d.getDate() + 1); const w = d.getDay(); if (w !== 0 && w !== 6) n++; }
    return n;
  }
  for (const t of TIERS) {
    NAV_INITIAL = t.seedNav;
    process.stdout.write(`  ${t.key} ($${(t.seedNav/1000).toFixed(0)}K)...`);
    const r = runSim({ ...V74, useGraduated: true, withdrawals: false, label: `IR ${t.key}` });
    const grossDaily = (r.dailyLedger || []).map(s => ({ date: s.date, equity: +(+s.nav).toFixed(2) }));
    const netDaily   = (r.dailyLedger || []).map(s => ({ date: s.date, netEquity: +(+s.nav).toFixed(2) }));
    const trades = (r.closedTrades || []).map(e => {
      const open = e.type === 'OPEN_AT_END';
      const basis = (e.avgCost || 0) * (e.shares || 0);
      const pct = basis > 0 ? (e.pnl / basis) * 100 : 0;
      return {
        ticker: e.ticker, signal: e.direction === 'SHORT' ? 'SS' : 'BL', direction: e.direction, sectorName: '—',
        entryDate: e.entryDate, exitDate: open ? null : e.date,
        entryPrice: +(+e.avgCost || 0).toFixed(2), exitPrice: open ? null : +(+e.exitPrice || 0).toFixed(2),
        avgCost: +(+e.avgCost || 0).toFixed(2), totalShares: e.shares || 0, lots: null, tradingDays: wdays(e.entryDate, e.date),
        exitReason: open ? 'ACTIVE' : (e.type || 'EXIT'),
        grossProfitPct: +pct.toFixed(2), netProfitPct: +pct.toFixed(2),
        grossDollarPnl: +(+e.pnl).toFixed(2), netDollarPnl: +(+e.pnl).toFixed(2), netIsWinner: e.pnl > 0,
      };
    });
    // Exact stats from ALL trades; cap the display log to the most recent 1500.
    const tradeStats = computeTradeStats(trades, t.seedNav, 1);
    const closedSorted = trades.filter(x => x.entryDate).sort((a, b) => String(a.entryDate).localeCompare(String(b.entryDate)));
    const firstTradeDate = closedSorted.length ? String(closedSorted[0].entryDate).slice(0, 10) : null;
    const tradeLog = closedSorted.slice(-1500);
    fsMod.writeFileSync(pathMod.join(outDir, `${t.key}.json`), JSON.stringify({
      tier: t.key, seedNav: t.seedNav, version: '7.4.0', firstTradeDate,
      grossDaily, netDaily, tradeStats, tradeLog, totalTrades: trades.length,
    }));
    console.log(` days ${grossDaily.length}  trades ${trades.length} (log ${tradeLog.length})  endNav $${Math.round(r.equity).toLocaleString()}`);
  }
  console.log('\n  Wrote slim per-tier Ambush IR data to server/data/ambushIr/');
  process.exit(0);
}
main().catch(err => { console.error(err); process.exit(1); });
