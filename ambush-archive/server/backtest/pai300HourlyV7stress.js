// server/backtest/pai300HourlyV7stress.js
// ── PNTHR AMBUSH V7 — STRESS TEST MATRIX ─────────────────────────────────
//
// All tests use $75 Break Even / 2-bar trailing exit (Scott's pick).
// Trailing stop: after Break Even, each day's first-hour low ratchets stop up.
//
// Scenarios tested:
//   A) BASELINE      — uncapped positions, optimistic bar ordering
//   B) CAP-30        — 30-position cap
//   C) CAP-40        — 40-position cap
//   D) CAP-50        — 50-position cap
//   E) PESSIMISTIC   — uncapped, worst-case intra-bar (stop before lot trigger)
//   F) WITHDRAW      — uncapped, withdraw $1M every time equity crosses $2M
//   G) WORST-CASE    — CAP-40 + pessimistic + withdrawal
//
// Also: overnight gap scan printed before sim results.
//
// Usage: cd server && node backtest/pai300HourlyV7stress.js
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
const BE_THRESHOLD    = 75;
const PAI300_REGIME_PERIOD = 36;
const FIRST_HOUR_END  = '10:30';
const SLIPPAGE_BPS    = 5;
const WITHDRAWAL_THRESHOLD = 2_000_000;
const WITHDRAWAL_AMOUNT    = 1_000_000;

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

  console.log('='.repeat(130));
  console.log('  PNTHR AMBUSH V7 — STRESS TEST MATRIX');
  console.log('  $75 Break Even / 2-bar trailing / Real IBKR fees / 5bps slippage');
  console.log('='.repeat(130));

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

  // ── OVERNIGHT GAP SCAN ─────────────────────────────────────────────────────
  console.log('\n[2] Scanning overnight gaps...');
  const gaps = [];
  for (const [ticker, bars] of Object.entries(hourlyBarMap)) {
    let prevDayClose = null, prevDayDate = null;
    for (const bar of bars) {
      const barDate = bar.date.split(' ')[0];
      const barTime = extractTime(bar.date);
      if (barTime <= '10:00') {
        if (prevDayClose != null && prevDayDate !== barDate) {
          const gapPct = ((bar.open - prevDayClose) / prevDayClose) * 100;
          if (Math.abs(gapPct) >= 5) {
            const firstHourBars = bars.filter(b => b.date.startsWith(barDate) && extractTime(b.date) < FIRST_HOUR_END);
            const firstHourLow = firstHourBars.length ? Math.min(...firstHourBars.map(b => b.low)) : bar.low;
            const firstHourHigh = firstHourBars.length ? Math.max(...firstHourBars.map(b => b.high)) : bar.high;
            const dayBars = bars.filter(b => b.date.startsWith(barDate));
            const dayHigh = Math.max(...dayBars.map(b => b.high));
            const dayLow = Math.min(...dayBars.map(b => b.low));
            const recoveryFromLow = firstHourLow > 0 ? ((dayHigh - firstHourLow) / firstHourLow * 100) : 0;
            gaps.push({
              ticker, date: barDate, prevClose: prevDayClose, open: bar.open,
              gapPct: +gapPct.toFixed(2), firstHourLow, firstHourHigh,
              dayLow, dayHigh, recoveryPct: +recoveryFromLow.toFixed(2),
            });
          }
        }
      }
      const lastBarOfDay = bars.filter(b => b.date.startsWith(barDate));
      if (lastBarOfDay.length) {
        const finalBar = lastBarOfDay[lastBarOfDay.length - 1];
        prevDayClose = finalBar.close;
        prevDayDate = barDate;
      }
    }
  }

  gaps.sort((a, b) => a.gapPct - b.gapPct);
  console.log(`\n  WORST 20 OVERNIGHT GAP-DOWNS (>= 5% gap)`);
  console.log(`  ${'─'.repeat(110)}`);
  console.log(`  ${'Ticker'.padEnd(7)} ${'Date'.padEnd(12)} ${'Prev Close'.padStart(11)} ${'Open'.padStart(9)} ${'Gap %'.padStart(8)} ${'1H Low'.padStart(9)} ${'Day Low'.padStart(9)} ${'Day High'.padStart(9)} ${'Recovery%'.padStart(10)}`);
  for (let i = 0; i < Math.min(20, gaps.length); i++) {
    const g = gaps[i];
    console.log(`  ${g.ticker.padEnd(7)} ${g.date.padEnd(12)} $${g.prevClose.toFixed(2).padStart(10)} $${g.open.toFixed(2).padStart(8)} ${(g.gapPct + '%').padStart(8)} $${g.firstHourLow.toFixed(2).padStart(8)} $${g.dayLow.toFixed(2).padStart(8)} $${g.dayHigh.toFixed(2).padStart(8)} ${(g.recoveryPct + '%').padStart(10)}`);
  }
  console.log(`\n  Total gaps >= 5%: ${gaps.filter(g => g.gapPct <= -5).length} down / ${gaps.filter(g => g.gapPct >= 5).length} up`);

  // ── SIGNALS ────────────────────────────────────────────────────────────────
  console.log('\n[3] Computing signals...');
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
  function getWeeklyStopLong(ticker, dateStr, ep) {
    const bars = weeklyBarsByTicker[ticker]; if (!bars) return null; const weekOf = getWeekOf(dateStr);
    let barIdx = -1; for (let i = bars.length - 1; i >= 0; i--) { if (bars[i].time <= weekOf) { barIdx = i; break; } }
    if (barIdx < 2) return null;
    return blInitStop(Math.min(bars[barIdx - 1].low, bars[barIdx - 2].low), ep, computeWilderATR(bars.slice(0, barIdx + 1))[barIdx]);
  }
  function getWeeklyStopShort(ticker, dateStr, ep) {
    const bars = weeklyBarsByTicker[ticker]; if (!bars) return null; const weekOf = getWeekOf(dateStr);
    let barIdx = -1; for (let i = bars.length - 1; i >= 0; i--) { if (bars[i].time <= weekOf) { barIdx = i; break; } }
    if (barIdx < 2) return null;
    return ssInitStop(Math.max(bars[barIdx - 1].high, bars[barIdx - 2].high), ep, computeWilderATR(bars.slice(0, barIdx + 1))[barIdx]);
  }
  function countTradingDays(fromDate, toDate) {
    const from = hourlyTradingDates.indexOf(fromDate); const to = hourlyTradingDates.indexOf(toDate);
    if (from < 0 || to < 0) return Math.max(1, Math.round((new Date(toDate) - new Date(fromDate)) / 86400000 * 5/7));
    return Math.max(1, to - from);
  }

  // ── SIMULATION ENGINE ──────────────────────────────────────────────────────
  function runSim({ maxPositions = 999, pessimistic = false, withdrawals = false, label = '' }) {
    let cash = NAV_INITIAL;
    const exits = [];
    const positions = {};
    const waiting = {};
    const pendingReentry = {};
    let totalComm = 0, totalBorrow = 0;
    let totalEntries = 0, totalExits1H = 0, totalReentries = 0;
    let totalBEStopUps = 0, totalLotFills = 0, totalCycleRepeats = 0;
    let totalTrailingExits = 0, skippedNoCash = 0, skippedMaxPos = 0;
    let totalLongEntries = 0, totalShortEntries = 0;
    let totalWithdrawn = 0;
    let maxConcurrentPositions = 0;
    let worstSingleTrade = 0;

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
      exits.push({ pnl, date, hour, ticker, type: phase, direction });
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

      // ═══ PHASE A: Process existing positions ═══
      for (const [ticker, pos] of Object.entries(positions)) {
        const hBars = dayHourly[ticker]; if (!hBars || !hBars.length) continue;
        const isLong = pos.direction === 'LONG';
        const firstHourBars = hBars.filter(b => extractTime(b.date) < FIRST_HOUR_END);
        const afterFirstHour = hBars.filter(b => extractTime(b.date) >= FIRST_HOUR_END);
        const firstHourLow = firstHourBars.length ? Math.min(...firstHourBars.map(b => b.low)) : null;
        const firstHourHigh = firstHourBars.length ? Math.max(...firstHourBars.map(b => b.high)) : null;

        // Trailing stop ratchet: use today's first-hour low/high
        if (pos.atBE && pos.trailingActive) {
          if (isLong && firstHourLow != null && firstHourLow > pos.stop) pos.stop = +firstHourLow.toFixed(2);
          if (!isLong && firstHourHigh != null && firstHourHigh < pos.stop) pos.stop = +firstHourHigh.toFixed(2);
        }

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
        let prevBarLow = null;
        for (const hBar of afterFirstHour) {
          if (!positions[ticker]) break;
          if (hBar.low < runningLow) runningLow = hBar.low;
          if (hBar.high > runningHigh) runningHigh = hBar.high;

          // PESSIMISTIC: check stop BEFORE lot triggers in same bar
          // OPTIMISTIC: check lot triggers first, then stop

          const checkStop = () => {
            if (!positions[ticker]) return;
            // 1H low/high break (pre-trailing)
            if (isLong && !pos.trailingActive && firstHourLow != null && hBar.low < firstHourLow) {
              doExit(ticker, '1H_LOW_BREAK', pos.totalShares, exitSlip(firstHourLow, 'LONG'), pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak, 'LONG', pos.entryDate);
              totalExits1H++;
              waiting[ticker] = { originalEntry: pos.originalEntry, runningLow: hBar.low, runningHigh, cycleNum: pos.cycleNum + 1, direction: 'LONG' };
              delete positions[ticker]; return;
            }
            if (!isLong && !pos.trailingActive && firstHourHigh != null && hBar.high > firstHourHigh) {
              doExit(ticker, '1H_HIGH_BREAK', pos.totalShares, exitSlip(firstHourHigh, 'SHORT'), pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak, 'SHORT', pos.entryDate);
              totalExits1H++;
              waiting[ticker] = { originalEntry: pos.originalEntry, runningLow, runningHigh: hBar.high, cycleNum: pos.cycleNum + 1, direction: 'SHORT' };
              delete positions[ticker]; return;
            }
            // Trailing stop (2-bar mode)
            if (pos.trailingActive) {
              if (isLong) {
                if (prevBarLow !== null && hBar.low < prevBarLow && hBar.low <= pos.stop) {
                  pos._consLL = (pos._consLL || 0) + 1;
                } else if (prevBarLow !== null && hBar.low < prevBarLow) {
                  pos._consLL = 1;
                } else { pos._consLL = 0; }
                if ((pos._consLL || 0) >= 2) {
                  doExit(ticker, 'TRAILING_STOP', pos.totalShares, exitSlip(pos.stop, 'LONG'), pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak, 'LONG', pos.entryDate);
                  totalTrailingExits++;
                  waiting[ticker] = { originalEntry: pos.originalEntry, runningLow, runningHigh, cycleNum: pos.cycleNum + 1, direction: 'LONG' };
                  delete positions[ticker]; return;
                }
              } else {
                if (pos._prevHH !== undefined && hBar.high > pos._prevHH && hBar.high >= pos.stop) {
                  pos._consHH = (pos._consHH || 0) + 1;
                } else if (pos._prevHH !== undefined && hBar.high > pos._prevHH) {
                  pos._consHH = 1;
                } else { pos._consHH = 0; }
                pos._prevHH = hBar.high;
                if ((pos._consHH || 0) >= 2) {
                  doExit(ticker, 'TRAILING_STOP', pos.totalShares, exitSlip(pos.stop, 'SHORT'), pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak, 'SHORT', pos.entryDate);
                  totalTrailingExits++;
                  waiting[ticker] = { originalEntry: pos.originalEntry, runningLow, runningHigh, cycleNum: pos.cycleNum + 1, direction: 'SHORT' };
                  delete positions[ticker]; return;
                }
              }
            }
            // Non-trailing stop
            if (!pos.trailingActive) {
              if (isLong && pos.stop != null && hBar.low <= pos.stop) {
                doExit(ticker, pos.atBE ? 'BE_STOP' : 'STOP_HIT', pos.totalShares, exitSlip(pos.stop, 'LONG'), pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak, 'LONG', pos.entryDate);
                waiting[ticker] = { originalEntry: pos.originalEntry, runningLow, runningHigh, cycleNum: pos.cycleNum + 1, direction: 'LONG' };
                delete positions[ticker]; return;
              }
              if (!isLong && pos.stop != null && hBar.high >= pos.stop) {
                doExit(ticker, pos.atBE ? 'BE_STOP' : 'STOP_HIT', pos.totalShares, exitSlip(pos.stop, 'SHORT'), pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak, 'SHORT', pos.entryDate);
                waiting[ticker] = { originalEntry: pos.originalEntry, runningLow, runningHigh, cycleNum: pos.cycleNum + 1, direction: 'SHORT' };
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
                  if (pos.atBE) {
                    const feePer = comm(pos.totalShares, pos.avgCost) / pos.totalShares;
                    pos.stop = isLong ? +(pos.avgCost + feePer).toFixed(2) : +(pos.avgCost - feePer).toFixed(2);
                  }
                }
              }
            }
          };

          if (pessimistic) { checkStop(); checkLots(); } else { checkLots(); checkStop(); }

          if (!positions[ticker]) { prevBarLow = hBar.low; continue; }

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

          prevBarLow = hBar.low;
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
        const totalShares = Math.min(maxShares, Math.floor((n * VITALITY_PCT) / rps), Math.floor((n * TICKER_CAP_PCT) / rePrice));
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
            let ok = false; for (let i = 1; i < afterFirst.length; i++) { if (isConfirmedGreenBreakout(afterFirst[i], afterFirst[i - 1])) { ok = true; break; } }
            if (!ok) continue;
            const ep = entrySlip(Math.max(bar.open, trigger), 'LONG');
            const stop = getWeeklyStopLong(ticker, date, ep); if (!stop || stop >= ep) continue;
            candidates.push({ ticker, ep, stop, rps: ep - stop, direction: 'LONG' });
          } else {
            if (!isActiveSS(ticker, date)) continue;
            const trigger = Math.min(prev1.low, prev2.low) - 0.01;
            if (bar.low > trigger) continue;
            let ok = false; for (let i = 1; i < afterFirst.length; i++) { if (isConfirmedRedBreakdown(afterFirst[i], afterFirst[i - 1])) { ok = true; break; } }
            if (!ok) continue;
            const ep = entrySlip(Math.min(bar.open, trigger), 'SHORT');
            const stop = getWeeklyStopShort(ticker, date, ep); if (!stop || stop <= ep) continue;
            candidates.push({ ticker, ep, stop, rps: stop - ep, direction: 'SHORT' });
          }
        }
        candidates.sort((a, b) => b.rps - a.rps);
        for (const c of candidates) {
          if (openCount() >= maxPositions) { skippedMaxPos++; continue; }
          const { ticker, ep, stop, rps, direction } = c;
          const n = nav();
          const totalShares = Math.min(Math.floor(MAX_LOSS / rps), Math.floor((n * VITALITY_PCT) / rps), Math.floor((n * TICKER_CAP_PCT) / ep));
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
    const netPnl = grossWin + grossLoss;
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
    const calmar = maxDD > 0 ? cagr / (maxDD * 100) : 999;

    return {
      label, netReturn: ((equity - NAV_INITIAL) / NAV_INITIAL) * 100, cagr, sharpe, sortino, calmar,
      pf, wr: wr * 100, payoff: avgLoss > 0 ? avgWin / avgLoss : 999,
      maxDD: maxDD * 100, equity, posMonthsPct: totalMonths ? (posMonths / totalMonths * 100) : 0,
      trades: exits.length, wins: wins.length, losses: losses.length,
      avgWin, avgLoss, totalComm, totalBorrow, totalWithdrawn,
      totalEntries, totalExits1H, totalReentries, totalTrailingExits,
      totalBEStopUps, totalLotFills, maxConcurrentPositions, worstSingleTrade,
      skippedNoCash, skippedMaxPos,
    };
  }

  // ── RUN ALL SCENARIOS ──────────────────────────────────────────────────────
  console.log('\n[4] Running 7 scenarios...\n');

  const scenarios = [
    { label: 'A) BASELINE',     maxPositions: 999, pessimistic: false, withdrawals: false },
    { label: 'B) CAP-30',       maxPositions: 30,  pessimistic: false, withdrawals: false },
    { label: 'C) CAP-40',       maxPositions: 40,  pessimistic: false, withdrawals: false },
    { label: 'D) CAP-50',       maxPositions: 50,  pessimistic: false, withdrawals: false },
    { label: 'E) PESSIMISTIC',  maxPositions: 999, pessimistic: true,  withdrawals: false },
    { label: 'F) WITHDRAW',     maxPositions: 999, pessimistic: false, withdrawals: true  },
    { label: 'G) WORST-CASE',   maxPositions: 40,  pessimistic: true,  withdrawals: true  },
  ];

  const results = [];
  for (const s of scenarios) {
    process.stdout.write(`  ${s.label}...`);
    const r = runSim(s);
    results.push(r);
    const withdrawn = r.totalWithdrawn ? `  Withdrawn: $${(r.totalWithdrawn / 1000).toFixed(0)}K` : '';
    console.log(` CAGR: ${r.cagr >= 0 ? '+' : ''}${r.cagr.toFixed(1)}%  Sharpe: ${r.sharpe.toFixed(2)}  Equity: $${Math.round(r.equity).toLocaleString()}  MaxPos: ${r.maxConcurrentPositions}${withdrawn}`);
  }

  // ── RESULTS TABLE ─────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(140));
  console.log('  STRESS TEST RESULTS — $75 Break Even / 2-Bar Trailing');
  console.log('═'.repeat(140));
  console.log(`  ${'Scenario'.padEnd(20)} ${'Net Ret'.padStart(9)} ${'CAGR'.padStart(8)} ${'Sharpe'.padStart(7)} ${'Sortino'.padStart(8)} ${'PF'.padStart(6)} ${'WR'.padStart(6)} ${'Payoff'.padStart(7)} ${'MaxDD'.padStart(7)} ${'Equity'.padStart(12)} ${'Pos Mo'.padStart(7)} ${'Trades'.padStart(7)} ${'MaxPos'.padStart(7)} ${'Worst$'.padStart(9)} ${'Withdrawn'.padStart(10)}`);
  console.log(`  ${'─'.repeat(138)}`);

  for (const r of results) {
    console.log(`  ${r.label.padEnd(20)} ${(r.netReturn >= 0 ? '+' : '') + r.netReturn.toFixed(0) + '%'} ${(r.cagr >= 0 ? '+' : '') + r.cagr.toFixed(1) + '%'} ${r.sharpe.toFixed(2).padStart(7)} ${r.sortino.toFixed(1).padStart(8)} ${(r.pf.toFixed(1) + 'x').padStart(6)} ${(r.wr.toFixed(1) + '%').padStart(6)} ${(r.payoff.toFixed(1) + 'x').padStart(7)} ${(r.maxDD.toFixed(2) + '%').padStart(7)} ${'$' + Math.round(r.equity).toLocaleString()} ${(r.posMonthsPct.toFixed(0) + '%').padStart(7)} ${String(r.trades).padStart(7)} ${String(r.maxConcurrentPositions).padStart(7)} ${'$' + Math.round(r.worstSingleTrade).toLocaleString()} ${r.totalWithdrawn ? '$' + (r.totalWithdrawn / 1000).toFixed(0) + 'K' : '-'}`);
  }

  // ── V6 BASELINE ───────────────────────────────────────────────────────────
  console.log(`\n  V6 (no trailing, 20-cap):  +1217%  CAGR: +105.8%  Sharpe: 2.75  PF: 5.19x  MaxDD: 1.21%  Equity: $1,317,334`);
  console.log(`  AI 300 Weekly:             +488%   CAGR: +49.9%   Sharpe: 1.33  PF: 2.84x  MaxDD: 27.5%  Equity: $588,000`);

  // ── ACTIVITY COMPARISON ───────────────────────────────────────────────────
  console.log(`\n  ACTIVITY BREAKDOWN`);
  console.log(`  ${'─'.repeat(120)}`);
  console.log(`  ${'Scenario'.padEnd(20)} ${'Entries'.padStart(8)} ${'Re-entry'.padStart(9)} ${'1H Exits'.padStart(9)} ${'Trail'.padStart(6)} ${'BEStops'.padStart(8)} ${'Lots'.padStart(6)} ${'SkipCash'.padStart(9)} ${'SkipCap'.padStart(8)} ${'Comm'.padStart(10)} ${'Borrow'.padStart(8)}`);
  for (const r of results) {
    console.log(`  ${r.label.padEnd(20)} ${String(r.totalEntries).padStart(8)} ${String(r.totalReentries).padStart(9)} ${String(r.totalExits1H).padStart(9)} ${String(r.totalTrailingExits).padStart(6)} ${String(r.totalBEStopUps).padStart(8)} ${String(r.totalLotFills).padStart(6)} ${String(r.skippedNoCash).padStart(9)} ${String(r.skippedMaxPos).padStart(8)} ${'$' + Math.round(r.totalComm).toLocaleString()} ${'$' + Math.round(r.totalBorrow).toLocaleString()}`);
  }

  console.log('\n' + '═'.repeat(140));
  console.log('  PNTHR AMBUSH V7 STRESS TEST COMPLETE');
  console.log('═'.repeat(140));

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
