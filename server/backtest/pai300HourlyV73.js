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

const NAV_INITIAL     = 83_000;
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
  function runSim({ maxPositions = 999, pessimistic = false, withdrawals = false, label = '', useGraduated = false }) {
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
          if (!pos.atBE && unr >= BE_THRESHOLD) {
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
                if (breakLevel > pos.stop && hBar.low <= breakLevel) {
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
                if (breakLevel < pos.stop && hBar.high >= breakLevel) {
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
          if (!pos.atBE && unr >= BE_THRESHOLD) {
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
          stop: reStop, atBE: false, trailingActive: false, peak: 0, nextLot: 1,
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
        if (isLong && !regime) continue; if (!isLong && regime) continue;
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
          if (regime) {
            if (!isActiveBL(ticker, date)) continue;
            const trigger = Math.max(prev1.high, prev2.high) + 0.01;
            if (bar.high < trigger) continue;
            let ok = false; for (let i = 1; i < afterFirst.length; i++) { if (isConfirmedGreenBreakout(afterFirst[i], afterFirst[i - 1])) { ok = true; break; } }
            if (!ok) continue;
            const ep = entrySlip(Math.max(bar.open, trigger), 'LONG');

            // 1H Stop for longs
            const firstHourBars = hBars.filter(b => extractTime(b.date) < FIRST_HOUR_END);
            const firstHourLow = firstHourBars.length ? Math.min(...firstHourBars.map(b => b.low)) : null;
            if (!firstHourLow || firstHourLow >= ep) { skippedNo1HLow++; continue; }
            const stop = +(firstHourLow - COMMISSION_PER_SHARE).toFixed(2);
            if (stop >= ep) continue;
            candidates.push({ ticker, ep, stop, rps: ep - stop, direction: 'LONG' });
          } else {
            if (!isActiveSS(ticker, date)) continue;
            const trigger = Math.min(prev1.low, prev2.low) - 0.01;
            if (bar.low > trigger) continue;
            let ok = false; for (let i = 1; i < afterFirst.length; i++) { if (isConfirmedRedBreakdown(afterFirst[i], afterFirst[i - 1])) { ok = true; break; } }
            if (!ok) continue;
            const ep = entrySlip(Math.min(bar.open, trigger), 'SHORT');

            // 1H Stop for shorts
            const firstHourBars = hBars.filter(b => extractTime(b.date) < FIRST_HOUR_END);
            const firstHourHigh = firstHourBars.length ? Math.max(...firstHourBars.map(b => b.high)) : null;
            if (!firstHourHigh || firstHourHigh <= ep) { skippedNo1HLow++; continue; }
            const stop = +(firstHourHigh + COMMISSION_PER_SHARE).toFixed(2);
            if (stop <= ep) continue;
            candidates.push({ ticker, ep, stop, rps: stop - ep, direction: 'SHORT' });
          }
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
            totalShares: l1, lotPlan, stop, atBE: false, trailingActive: false,
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
    let equity = NAV_INITIAL, peak = NAV_INITIAL, maxDD = 0;
    for (const e of exits.sort((a, b) => (a.date + a.hour).localeCompare(b.date + b.hour))) {
      equity += e.pnl; if (equity > peak) peak = equity;
      const dd = (peak - equity) / peak; if (dd > maxDD) maxDD = dd;
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
    };
  }

  // ── RUN COMPARISON ─────────────────────────────────────────────────────────
  console.log('\n[3] Running FULL vs GRADUATED comparison...\n');

  const scenarios = [
    { label: 'BASELINE',    maxPositions: 999, pessimistic: false, withdrawals: false },
    { label: 'PESSIMISTIC', maxPositions: 999, pessimistic: true,  withdrawals: false },
    { label: 'WITHDRAW',    maxPositions: 999, pessimistic: false, withdrawals: true  },
    { label: 'WORST-CASE',  maxPositions: 40,  pessimistic: true,  withdrawals: true  },
  ];

  const fullResults = [], gradResults = [];
  for (const s of scenarios) {
    process.stdout.write(`  FULL ${s.label}...`);
    const full = runSim({ ...s, label: `FULL ${s.label}`, useGraduated: false });
    fullResults.push(full);
    const fW = full.totalWithdrawn ? `  Withdrawn: $${(full.totalWithdrawn / 1000).toFixed(0)}K` : '';
    console.log(` CAGR: ${full.cagr >= 0 ? '+' : ''}${full.cagr.toFixed(1)}%  Sharpe: ${full.sharpe.toFixed(2)}  Equity: $${Math.round(full.equity).toLocaleString()}${fW}`);

    process.stdout.write(`  GRAD ${s.label}...`);
    const grad = runSim({ ...s, label: `GRAD ${s.label}`, useGraduated: true });
    gradResults.push(grad);
    const gW = grad.totalWithdrawn ? `  Withdrawn: $${(grad.totalWithdrawn / 1000).toFixed(0)}K` : '';
    console.log(` CAGR: ${grad.cagr >= 0 ? '+' : ''}${grad.cagr.toFixed(1)}%  Sharpe: ${grad.sharpe.toFixed(2)}  Equity: $${Math.round(grad.equity).toLocaleString()}${gW}`);
    console.log();
  }

  // ── EXPORT V7.3 CSVs to ~/Downloads (GRAD WITHDRAW = recommended config) ──
  try {
    const exp = gradResults[2]; // GRAD WITHDRAW
    const dl = path.join(os.homedir(), 'Downloads');
    const tHead = ['ExitDate','Hour','Ticker','Direction','Shares','AvgCost','ExitPrice','ExitType','PnL','EntryDate'];
    const tRows = (exp.closedTrades || []).map(e =>
      [e.date, e.hour || '', e.ticker, e.direction, e.shares, e.avgCost, e.exitPrice, e.type, e.pnl, e.entryDate].join(','));
    fs.writeFileSync(path.join(dl, 'PNTHR_Ambush_V7.3_ClosedTrades.csv'), [tHead.join(','), ...tRows].join('\n'));
    const cHead = ['Date','Positions','Cash','Deployed','NAV','TotalWithdrawn'];
    const cRows = (exp.dailyLedger || []).map(s =>
      [s.date, s.positions, s.cash, s.deployed, s.nav, s.withdrawn].join(','));
    fs.writeFileSync(path.join(dl, 'PNTHR_Ambush_V7.3_CashLedger.csv'), [cHead.join(','), ...cRows].join('\n'));
    console.log(`\n  Exported to ~/Downloads: PNTHR_Ambush_V7.3_ClosedTrades.csv (${tRows.length} trades), PNTHR_Ambush_V7.3_CashLedger.csv (${cRows.length} days)`);

    // ── Projection curve for the live dashboard (GRAD BASELINE = pure compounding) ──
    // Stores daily growth factors (NAV / startNAV) so the app can rebase to any AUM.
    const base = gradResults[0]; // GRAD BASELINE
    const startNav = NAV_INITIAL;
    const factors = (base.dailyLedger || []).map((s, i) => ({
      i, date: s.date, factor: +(s.nav / startNav).toFixed(6),
    }));
    const projOut = {
      generatedFrom: 'pai300HourlyV73.js GRAD BASELINE (pure compounding, no withdrawals)',
      backtestStartNav: startNav,
      backtestEndNav: Math.round(base.equity),
      tradingDays: factors.length,
      factors,
    };
    const projPath = new URL('../data/ambushProjectionBaseline.json', import.meta.url).pathname;
    fs.writeFileSync(projPath, JSON.stringify(projOut));
    console.log(`  Wrote projection curve: server/data/ambushProjectionBaseline.json (${factors.length} days, end factor ${factors[factors.length-1]?.factor})`);
  } catch (e) { console.error('  CSV/projection export failed:', e.message); }

  // ── WORST-TRADE DIAGNOSTIC ──────────────────────────────────────────────────
  for (const [tag, res] of [['FULL BASELINE', fullResults[0]], ['GRAD BASELINE', gradResults[0]]]) {
    console.log(`\n  WORST 5 TRADES — ${tag}   (lot-stop exits this run: ${res.lotStopExits})`);
    console.log('  ' + '-'.repeat(115));
    for (const w of (res.worstTrades || [])) {
      const perSh = w.direction === 'SHORT' ? (w.exitPrice - w.avgCost) : (w.avgCost - w.exitPrice);
      console.log(`    ${(w.ticker||'').padEnd(6)} ${(w.direction||'').padEnd(5)} ${(w.type||'').padEnd(14)} shares=${String(w.shares).padStart(5)}  avgCost=$${w.avgCost}  exit=$${w.exitPrice}  $/sh=${perSh.toFixed(2)}  pnl=$${w.pnl}  in ${w.entryDate} out ${w.date}`);
    }
  }

  // ── HEAD-TO-HEAD TABLE ────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(180));
  console.log('  V7.3 LOT-TRAIL — FULL vs GRADUATED (guardrail + 2M-withdraw built in) (50%→75%→100%)');
  console.log('='.repeat(180));
  console.log(`  ${'Scenario'.padEnd(22)} ${'Net Ret'.padStart(9)} ${'CAGR'.padStart(8)} ${'Sharpe'.padStart(7)} ${'Sortino'.padStart(8)} ${'PF'.padStart(6)} ${'WR'.padStart(6)} ${'Payoff'.padStart(7)} ${'MaxDD'.padStart(7)} ${'Equity'.padStart(14)} ${'Trades'.padStart(7)} ${'Entries'.padStart(8)} ${'Re-entr'.padStart(8)} ${'L/S'.padStart(16)} ${'MaxPos'.padStart(7)} ${'1HSkip'.padStart(7)}`);
  console.log(`  ${'─'.repeat(178)}`);

  for (let i = 0; i < scenarios.length; i++) {
    const f = fullResults[i], g = gradResults[i];
    // FULL row
    console.log(`  ${('FULL ' + scenarios[i].label).padEnd(22)} ${(f.netReturn >= 0 ? '+' : '') + Math.round(f.netReturn) + '%'} ${(f.cagr >= 0 ? '+' : '') + f.cagr.toFixed(1) + '%'} ${f.sharpe.toFixed(2).padStart(7)} ${f.sortino.toFixed(1).padStart(8)} ${(f.pf.toFixed(1) + 'x').padStart(6)} ${(f.wr.toFixed(1) + '%').padStart(6)} ${(f.payoff.toFixed(1) + 'x').padStart(7)} ${(f.maxDD.toFixed(2) + '%').padStart(7)} ${'$' + Math.round(f.equity).toLocaleString().padStart(13)} ${String(f.trades).padStart(7)} ${String(f.totalEntries).padStart(8)} ${String(f.totalReentries).padStart(8)} ${(f.totalLongEntries + 'L/' + f.totalShortEntries + 'S').padStart(16)} ${String(f.maxConcurrentPositions).padStart(7)} ${String(f.skippedNo1HLow).padStart(7)}`);
    // GRAD row
    console.log(`  ${('GRAD ' + scenarios[i].label).padEnd(22)} ${(g.netReturn >= 0 ? '+' : '') + Math.round(g.netReturn) + '%'} ${(g.cagr >= 0 ? '+' : '') + g.cagr.toFixed(1) + '%'} ${g.sharpe.toFixed(2).padStart(7)} ${g.sortino.toFixed(1).padStart(8)} ${(g.pf.toFixed(1) + 'x').padStart(6)} ${(g.wr.toFixed(1) + '%').padStart(6)} ${(g.payoff.toFixed(1) + 'x').padStart(7)} ${(g.maxDD.toFixed(2) + '%').padStart(7)} ${'$' + Math.round(g.equity).toLocaleString().padStart(13)} ${String(g.trades).padStart(7)} ${String(g.totalEntries).padStart(8)} ${String(g.totalReentries).padStart(8)} ${(g.totalLongEntries + 'L/' + g.totalShortEntries + 'S').padStart(16)} ${String(g.maxConcurrentPositions).padStart(7)} ${String(g.skippedNo1HLow).padStart(7)}`);
    // DELTA
    const dCagr = g.cagr - f.cagr, dSharpe = g.sharpe - f.sharpe, dDD = g.maxDD - f.maxDD, dTrades = g.trades - f.trades;
    console.log(`    DELTA (GRAD-FULL)${' '.repeat(1)} ${' '.repeat(9)} ${(dCagr >= 0 ? '+' : '') + dCagr.toFixed(1) + '%'} ${(dSharpe >= 0 ? '+' : '') + dSharpe.toFixed(2)} ${' '.repeat(8)} ${' '.repeat(6)} ${' '.repeat(6)} ${' '.repeat(7)} ${(dDD >= 0 ? '+' : '') + dDD.toFixed(2) + '%'} ${' '.repeat(14)} ${(dTrades >= 0 ? '+' : '') + String(dTrades).padStart(6)}`);
    console.log(`  ${'─'.repeat(178)}`);
  }

  // ── ACTIVITY BREAKDOWN ────────────────────────────────────────────────────
  console.log(`\n  ACTIVITY BREAKDOWN`);
  console.log(`  ${'─'.repeat(140)}`);
  console.log(`  ${'Scenario'.padEnd(22)} ${'Entries'.padStart(8)} ${'Re-entr'.padStart(8)} ${'1H Exits'.padStart(9)} ${'Trail'.padStart(6)} ${'BEStops'.padStart(8)} ${'Lots'.padStart(6)} ${'SkipCash'.padStart(9)} ${'SkipCap'.padStart(8)} ${'1HSkip'.padStart(7)} ${'Comm'.padStart(10)} ${'Borrow'.padStart(8)} ${'Worst$'.padStart(9)} ${'Withdrawn'.padStart(10)}`);
  for (let i = 0; i < scenarios.length; i++) {
    for (const r of [fullResults[i], gradResults[i]]) {
      console.log(`  ${r.label.padEnd(22)} ${String(r.totalEntries).padStart(8)} ${String(r.totalReentries).padStart(8)} ${String(r.totalExits1H).padStart(9)} ${String(r.totalTrailingExits).padStart(6)} ${String(r.totalBEStopUps).padStart(8)} ${String(r.totalLotFills).padStart(6)} ${String(r.skippedNoCash).padStart(9)} ${String(r.skippedMaxPos).padStart(8)} ${String(r.skippedNo1HLow).padStart(7)} ${'$' + Math.round(r.totalComm).toLocaleString()} ${'$' + Math.round(r.totalBorrow).toLocaleString()} ${'$' + Math.round(r.worstSingleTrade).toLocaleString()} ${r.totalWithdrawn ? '$' + (r.totalWithdrawn / 1000).toFixed(0) + 'K' : '-'}`);
    }
  }

  // ── CASH LEDGER ──────────────────────────────────────────────────────────
  console.log(`\n  CASH LEDGER ($${(NAV_INITIAL / 1000).toFixed(0)}K Starting NAV)`);
  console.log(`  ${'─'.repeat(120)}`);
  console.log(`  ${'Scenario'.padEnd(22)} ${'Min Cash'.padStart(12)} ${'Days <$500'.padStart(11)} ${'Peak Deploy%'.padStart(13)} ${'SkipCash'.padStart(9)}`);
  for (let i = 0; i < scenarios.length; i++) {
    for (const r of [fullResults[i], gradResults[i]]) {
      console.log(`  ${r.label.padEnd(22)} ${'$' + Math.round(r.minCash).toLocaleString()} ${String(r.daysTappedOut).padStart(11)} ${(r.peakDeployedPct + '%').padStart(13)} ${String(r.skippedNoCash).padStart(9)}`);
    }
  }

  // ── NAV MILESTONES ────────────────────────────────────────────────────────
  console.log(`\n  NAV MILESTONES (date first reached)`);
  console.log(`  ${'─'.repeat(100)}`);
  const allMilestones = [100_000, 125_000, 166_000, 250_000, 500_000, 1_000_000, 2_000_000, 3_000_000, 5_000_000, 8_000_000];
  console.log(`  ${'Milestone'.padEnd(14)} ${'FULL BASELINE'.padStart(16)} ${'GRAD BASELINE'.padStart(16)} ${'FULL WITHDRAW'.padStart(16)} ${'GRAD WITHDRAW'.padStart(16)} ${'GRAD WORST'.padStart(16)}`);
  for (const m of allMilestones) {
    const label = m >= 1_000_000 ? `$${(m / 1_000_000).toFixed(0)}M` : `$${(m / 1000).toFixed(0)}K`;
    const fb = fullResults[0].milestoneHits[m] || '—';
    const gb = gradResults[0].milestoneHits[m] || '—';
    const fw = fullResults[2].milestoneHits[m] || '—';
    const gw = gradResults[2].milestoneHits[m] || '—';
    const gwc = gradResults[3].milestoneHits[m] || '—';
    console.log(`  ${label.padEnd(14)} ${fb.padStart(16)} ${gb.padStart(16)} ${fw.padStart(16)} ${gw.padStart(16)} ${gwc.padStart(16)}`);
  }

  // ── SIZING TIER CHANGES (GRAD BASELINE) ────────────────────────────────────
  const gradBase = gradResults[0];
  if (gradBase.tierChanges && gradBase.tierChanges.length) {
    console.log(`\n  GRADUATED SIZING TIER CHANGES (BASELINE)`);
    console.log(`  ${'─'.repeat(60)}`);
    for (const tc of gradBase.tierChanges) {
      console.log(`  ${tc.date}  ${tc.from} → ${tc.to}  (NAV: $${tc.nav.toLocaleString()})`);
    }
  }

  // Also show WITHDRAW tier changes
  const gradWithdraw = gradResults[2];
  if (gradWithdraw.tierChanges && gradWithdraw.tierChanges.length) {
    console.log(`\n  GRADUATED SIZING TIER CHANGES (WITHDRAW)`);
    console.log(`  ${'─'.repeat(60)}`);
    for (const tc of gradWithdraw.tierChanges) {
      console.log(`  ${tc.date}  ${tc.from} → ${tc.to}  (NAV: $${tc.nav.toLocaleString()})`);
    }
  }

  console.log('\n' + '='.repeat(180));
  console.log('  V7A GRADUATED SIZING COMPARISON COMPLETE');
  console.log('='.repeat(180));

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
