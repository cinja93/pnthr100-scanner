// server/backtest/pai300HourlyV5.js
// ── PNTHR AMBUSH V5 — CAPITAL-CONSTRAINED + FULL TRADE LEDGER ──────────
//
// Same strategy as V4 but with REAL capital tracking:
// - Cash balance tracked on every entry/exit
// - Can't enter if not enough cash
// - Equity = cash + market value of open positions
// - Every single trade printed with full P&L verification
//
// Usage: cd server && node backtest/pai300HourlyV5.js
// ────────────────────────────────────────────────────────────────────────

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
const MAX_POSITIONS   = 20;

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

  console.log('='.repeat(130));
  console.log('  PNTHR AMBUSH V5 — CAPITAL-CONSTRAINED BACKTEST');
  console.log('  Real hourly data only | $100K start | Cash tracking | 20-position cap | Full trade ledger');
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

  // ── SIMULATION WITH CAPITAL TRACKING ──────────────────────────────────────
  console.log('\n[3] Running simulation...');

  let cash = NAV_INITIAL;
  const ledger = [];        // every entry/exit event with cash balance
  const positions = {};     // ticker -> position state
  const waiting = {};       // ticker -> waiting for re-entry
  let tradeSeq = 0;         // sequential trade number

  let totalEntries = 0, totalExitsFirstHour = 0, totalReentries = 0;
  let totalBEStopUps = 0, totalLotFills = 0, totalCycleRepeats = 0;
  let skippedNoCash = 0, skippedMaxPos = 0;

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

  function recordEntry(ticker, type, shares, price, date, hour, stop, cycleNum, lotPlan) {
    const cost = +(shares * price + IBKR_FEE_PER_TRADE).toFixed(2);
    cash -= cost;
    tradeSeq++;
    ledger.push({
      seq: tradeSeq,
      action: 'BUY',
      type,
      ticker,
      shares,
      price: +price.toFixed(2),
      cost,
      stop: +stop.toFixed(2),
      date,
      hour: hour || '',
      cashAfter: +cash.toFixed(2),
      cycleNum,
      lotPlan: lotPlan ? lotPlan.join('/') : '',
    });
    return tradeSeq;
  }

  function recordLotFill(ticker, lotNum, shares, price, date, hour, newAvg, newStop) {
    const cost = +(shares * price + IBKR_FEE_PER_TRADE).toFixed(2);
    cash -= cost;
    tradeSeq++;
    ledger.push({
      seq: tradeSeq,
      action: `LOT${lotNum}`,
      type: 'PYRAMID',
      ticker,
      shares,
      price: +price.toFixed(2),
      cost,
      stop: +(newStop || 0).toFixed(2),
      date,
      hour: hour || '',
      cashAfter: +cash.toFixed(2),
      newAvg: +newAvg.toFixed(2),
    });
  }

  function recordExit(ticker, phase, shares, exitPrice, avgCost, date, hour, cycleNum, peakProfit) {
    const proceeds = +(shares * exitPrice - IBKR_FEE_PER_TRADE).toFixed(2);
    const pnl = +(proceeds - shares * avgCost - IBKR_FEE_PER_TRADE).toFixed(2);
    cash += proceeds;
    tradeSeq++;
    ledger.push({
      seq: tradeSeq,
      action: 'SELL',
      type: phase,
      ticker,
      shares,
      price: +exitPrice.toFixed(2),
      proceeds,
      avgCost: +avgCost.toFixed(2),
      pnl,
      date,
      hour: hour || '',
      cashAfter: +cash.toFixed(2),
      cycleNum,
      peakProfit: +(peakProfit || 0).toFixed(2),
    });
    return pnl;
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

      const firstHourBars = hBars.filter(b => extractTime(b.date) < FIRST_HOUR_END);
      const afterFirstHour = hBars.filter(b => extractTime(b.date) >= FIRST_HOUR_END);
      const firstHourLow = firstHourBars.length
        ? Math.min(...firstHourBars.map(b => b.low))
        : null;

      let runningLow = firstHourLow ?? Infinity;

      // Process first-hour bars: check existing stop only
      for (const hBar of firstHourBars) {
        if (!positions[ticker]) break;
        if (hBar.low < runningLow) runningLow = hBar.low;

        if (pos.stop != null && hBar.low <= pos.stop) {
          const pnl = recordExit(ticker, 'STOP_HIT_1H', pos.totalShares, pos.stop, pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak);
          waiting[ticker] = {
            originalEntry: pos.originalEntry,
            exitPrice: pos.stop, exitDate: date, exitHour: hBar.date,
            runningLow, cycleNum: pos.cycleNum + 1,
          };
          delete positions[ticker];
          break;
        }

        const unr = (hBar.high - pos.avgCost) * pos.totalShares;
        if (unr > (pos.peak || 0)) pos.peak = +unr.toFixed(2);

        if (!pos.atBE && unr >= BE_PROFIT_THRESHOLD) {
          pos.atBE = true;
          const feePer = IBKR_FEE_PER_TRADE / pos.totalShares;
          pos.stop = +(pos.avgCost + feePer).toFixed(2);
          totalBEStopUps++;
        }
      }

      if (!positions[ticker]) continue;

      // Process after-first-hour bars
      for (const hBar of afterFirstHour) {
        if (!positions[ticker]) break;
        if (hBar.low < runningLow) runningLow = hBar.low;

        // First-hour low break -> EXIT
        if (firstHourLow != null && hBar.low < firstHourLow) {
          const pnl = recordExit(ticker, '1H_LOW_BREAK', pos.totalShares, firstHourLow, pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak);
          totalExitsFirstHour++;
          waiting[ticker] = {
            originalEntry: pos.originalEntry,
            exitPrice: firstHourLow, exitDate: date, exitHour: hBar.date,
            runningLow: hBar.low, cycleNum: pos.cycleNum + 1,
          };
          delete positions[ticker];
          break;
        }

        // Existing stop hit
        if (pos.stop != null && hBar.low <= pos.stop) {
          const phase = pos.atBE ? 'BE_STOP' : 'STOP_HIT';
          const pnl = recordExit(ticker, phase, pos.totalShares, pos.stop, pos.avgCost, date, hBar.date, pos.cycleNum, pos.peak);
          waiting[ticker] = {
            originalEntry: pos.originalEntry,
            exitPrice: pos.stop, exitDate: date, exitHour: hBar.date,
            runningLow, cycleNum: pos.cycleNum + 1,
          };
          delete positions[ticker];
          break;
        }

        const unr = (hBar.high - pos.avgCost) * pos.totalShares;
        if (unr > (pos.peak || 0)) pos.peak = +unr.toFixed(2);

        if (!pos.atBE && unr >= BE_PROFIT_THRESHOLD) {
          pos.atBE = true;
          const feePer = IBKR_FEE_PER_TRADE / pos.totalShares;
          pos.stop = +(pos.avgCost + feePer).toFixed(2);
          totalBEStopUps++;
        }

        // L2-L5 lot trigger fills
        if (pos.nextLot <= 4) {
          const lotTrigger = +(pos.originalEntry * (1 + LOT_OFFSETS[pos.nextLot])).toFixed(2);
          if (hBar.high >= lotTrigger) {
            const lotShares = pos.lotPlan[pos.nextLot];
            const lotCost = lotShares * lotTrigger + IBKR_FEE_PER_TRADE;

            // Capital check for lot fill
            if (cash >= lotCost) {
              const oldCost = pos.avgCost * pos.totalShares;
              pos.totalShares += lotShares;
              pos.avgCost = +((oldCost + lotTrigger * lotShares) / pos.totalShares).toFixed(4);
              const lotNum = pos.nextLot + 1;
              pos.nextLot++;
              totalLotFills++;

              let newStop = pos.stop;
              if (pos.atBE) {
                const feePer = IBKR_FEE_PER_TRADE / pos.totalShares;
                pos.stop = +(pos.avgCost + feePer).toFixed(2);
                newStop = pos.stop;
              }

              recordLotFill(ticker, lotNum, lotShares, lotTrigger, date, hBar.date, pos.avgCost, newStop);
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

      // Position cap check
      if (openPositionCount() >= MAX_POSITIONS) { skippedMaxPos++; continue; }

      const afterFirst = hBars.filter(b => extractTime(b.date) >= FIRST_HOUR_END);
      if (afterFirst.length < 2) continue;

      for (let i = 1; i < afterFirst.length; i++) {
        if (positions[ticker]) break;
        const bar = afterFirst[i];
        const prevBar = afterFirst[i - 1];

        if (bar.low < w.runningLow) w.runningLow = bar.low;

        if (!isConfirmedGreenBreakout(bar, prevBar)) continue;

        const rePrice = bar.close;
        const feesBuffer = (IBKR_FEE_PER_TRADE * 2);
        const reStop = +(w.runningLow - feesBuffer - IBKR_SLIPPAGE).toFixed(2);
        if (reStop >= rePrice) continue;

        const rps = rePrice - reStop;
        if (rps <= 0.01) continue;
        const maxShares = Math.floor(MAX_LOSS / rps);
        if (maxShares < 1) continue;

        const nav = cash + capitalDeployed();
        const vitalityShares = Math.floor((nav * VITALITY_PCT) / rps);
        const capShares = Math.floor((nav * TICKER_CAP_PCT) / rePrice);
        const totalShares = Math.min(maxShares, vitalityShares, capShares);
        if (totalShares < 1) continue;

        const l1 = Math.max(1, Math.round(totalShares * STRIKE_PCT[0]));
        const lotPlan = STRIKE_PCT.map(p => Math.max(1, Math.round(totalShares * p)));
        const entryCost = l1 * rePrice + IBKR_FEE_PER_TRADE;

        // Cash check
        if (cash < entryCost) { skippedNoCash++; continue; }

        recordEntry(ticker, 'REENTRY', l1, rePrice, date, bar.date, reStop, w.cycleNum, lotPlan);

        positions[ticker] = {
          ticker, entryPrice: rePrice, avgCost: rePrice, entryDate: date,
          originalEntry: w.originalEntry || rePrice,
          totalShares: l1, lotPlan,
          stop: reStop, atBE: false, peak: 0, nextLot: 1,
          cycleNum: w.cycleNum, isReentry: true,
        };

        totalReentries++;
        if (w.cycleNum > 1) totalCycleRepeats++;
        delete waiting[ticker];
        break;
      }
    }

    // ═══ PHASE C: New entries (MCE daily 2-bar breakout + hourly confirmation) ═══
    if (dayIdx >= 2) {
      const p1 = hourlyTradingDates[dayIdx - 1];
      const p2 = hourlyTradingDates[dayIdx - 2];

      // Sort candidates by RPS descending so best setups get capital first
      const candidates = [];
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
        candidates.push({ ticker, ep, weeklyStop, rps });
      }

      // Best RPS first — allocate capital to highest-quality setups
      candidates.sort((a, b) => b.rps - a.rps);

      for (const c of candidates) {
        if (openPositionCount() >= MAX_POSITIONS) { skippedMaxPos++; continue; }

        const { ticker, ep, weeklyStop, rps } = c;
        const nav = cash + capitalDeployed();
        const maxShares = Math.floor(MAX_LOSS / rps);
        const vitalityShares = Math.floor((nav * VITALITY_PCT) / rps);
        const capShares = Math.floor((nav * TICKER_CAP_PCT) / ep);
        const totalShares = Math.min(maxShares, vitalityShares, capShares);
        if (totalShares < 1) continue;

        const l1 = Math.max(1, Math.round(totalShares * STRIKE_PCT[0]));
        const lotPlan = STRIKE_PCT.map(p => Math.max(1, Math.round(totalShares * p)));
        const entryCost = l1 * ep + IBKR_FEE_PER_TRADE;

        if (cash < entryCost) { skippedNoCash++; continue; }

        recordEntry(ticker, 'NEW_MCE', l1, ep, date, '', weeklyStop, 0, lotPlan);

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
    recordExit(ticker, 'OPEN_AT_END', pos.totalShares, last.close, pos.avgCost,
      last.date.split(' ')[0], last.date, pos.cycleNum, pos.peak);
  }

  // ── FULL TRADE LEDGER ─────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(130));
  console.log('  COMPLETE TRADE LEDGER — EVERY ENTRY AND EXIT');
  console.log('='.repeat(130));
  console.log(`  ${'#'.padStart(5)} ${'Action'.padEnd(6)} ${'Type'.padEnd(14)} ${'Ticker'.padEnd(7)} ${'Shares'.padStart(6)} ${'Price'.padStart(10)} ${'Cost/Proc'.padStart(10)} ${'AvgCost'.padStart(9)} ${'P&L'.padStart(10)} ${'Stop'.padStart(9)} ${'Cash'.padStart(12)} ${'Cyc'.padStart(4)} ${'Date'.padEnd(12)} ${'Hour'.padEnd(20)}`);
  console.log(`  ${'─'.repeat(128)}`);

  for (const e of ledger) {
    const seq = String(e.seq).padStart(5);
    const action = (e.action || '').padEnd(6);
    const type = (e.type || '').padEnd(14);
    const ticker = (e.ticker || '').padEnd(7);
    const shares = String(e.shares || '').padStart(6);
    const price = `$${(e.price || 0).toFixed(2)}`.padStart(10);
    const costProc = e.action === 'SELL'
      ? `$${(e.proceeds || 0).toFixed(2)}`.padStart(10)
      : `$${(e.cost || 0).toFixed(2)}`.padStart(10);
    const avgCost = e.newAvg ? `$${e.newAvg}`.padStart(9) : (e.avgCost ? `$${e.avgCost.toFixed(2)}`.padStart(9) : ''.padStart(9));
    const pnl = e.pnl !== undefined ? `$${e.pnl.toFixed(2)}`.padStart(10) : ''.padStart(10);
    const stop = e.stop ? `$${e.stop.toFixed(2)}`.padStart(9) : ''.padStart(9);
    const cashAfter = `$${e.cashAfter.toFixed(2)}`.padStart(12);
    const cyc = String(e.cycleNum ?? '').padStart(4);
    const dt = (e.date || '').padEnd(12);
    const hr = (e.hour || '').padEnd(20);
    console.log(`  ${seq} ${action} ${type} ${ticker} ${shares} ${price} ${costProc} ${avgCost} ${pnl} ${stop} ${cashAfter} ${cyc} ${dt} ${hr}`);
  }

  // ── P&L SUMMARY ───────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(130));
  console.log('  P&L SUMMARY');
  console.log('='.repeat(130));

  const exits = ledger.filter(e => e.action === 'SELL');
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

  // Equity curve for drawdown
  let equity = NAV_INITIAL, peak = NAV_INITIAL, maxDD = 0;
  for (const e of exits.sort((a, b) => (a.date + a.hour).localeCompare(b.date + b.hour))) {
    equity += e.pnl;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  // ── ADVANCED METRICS: Sharpe, Sortino, Calmar, Recovery, Positive Months, CAGR ──
  const dailyReturns = [];
  let dailyEquity = NAV_INITIAL;
  let posMonths = 0, totalMonths = 0;
  let monthPnl = 0, currentMonth = '';
  const monthlyPnls = [];

  for (const date of hourlyTradingDates) {
    const dayExits = exits.filter(e => e.date === date);
    const dayPnl = dayExits.reduce((s, e) => s + e.pnl, 0);
    const prevEquity = dailyEquity;
    dailyEquity += dayPnl;
    if (prevEquity > 0) dailyReturns.push(dayPnl / prevEquity);

    const month = date.slice(0, 7);
    if (month !== currentMonth) {
      if (currentMonth) {
        monthlyPnls.push(monthPnl);
        totalMonths++;
        if (monthPnl > 0) posMonths++;
      }
      currentMonth = month;
      monthPnl = 0;
    }
    monthPnl += dayPnl;
  }
  if (currentMonth) {
    monthlyPnls.push(monthPnl);
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
  console.log(`  Net Total Return:         +${netReturn.toFixed(2)}%`);
  console.log(`  CAGR:                     +${cagr.toFixed(2)}%`);
  console.log(`  Sharpe Ratio:             ${sharpe.toFixed(2)}`);
  console.log(`  Sortino Ratio:            ${sortino.toFixed(2)}`);
  console.log(`  Calmar Ratio:             ${calmar.toFixed(2)}`);
  console.log(`  Recovery Factor:          ${recoveryFactor.toFixed(1)}x`);
  console.log(`  Positive Months:          ${posMonths}/${totalMonths} (${(posMonths / totalMonths * 100).toFixed(1)}%)`);
  console.log(`  Years:                    ${yearsElapsed.toFixed(2)}`);
  console.log(`  Trading Days:             ${hourlyTradingDates.length}`);

  console.log(`\n  CAPITAL TRACKING`);
  console.log(`  ${'─'.repeat(50)}`);
  console.log(`  Starting Cash:            $${NAV_INITIAL.toLocaleString()}`);
  console.log(`  Final Cash:               $${cash.toFixed(2)}`);
  console.log(`  Max Positions Allowed:    ${MAX_POSITIONS}`);
  console.log(`  Skipped (no cash):        ${skippedNoCash}`);
  console.log(`  Skipped (max positions):  ${skippedMaxPos}`);

  console.log(`\n  ACTIVITY`);
  console.log(`  ${'─'.repeat(50)}`);
  console.log(`  New entries:              ${totalEntries}`);
  console.log(`  First-hour low exits:     ${totalExitsFirstHour}`);
  console.log(`  Re-entries (confirmed):   ${totalReentries}`);
  console.log(`  Cycle repeats:            ${totalCycleRepeats}`);
  console.log(`  BE stop ratchets:         ${totalBEStopUps}`);
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

  // ── DAILY EQUITY CURVE ────────────────────────────────────────────────────
  console.log(`\n  DAILY EQUITY SNAPSHOT`);
  console.log(`  ${'─'.repeat(70)}`);
  console.log(`  ${'Date'.padEnd(12)} ${'Positions'.padStart(10)} ${'Cash'.padStart(12)} ${'Deployed'.padStart(12)} ${'Day P&L'.padStart(10)} ${'Cum P&L'.padStart(12)}`);

  let cumPnl = 0;
  for (const date of hourlyTradingDates) {
    const dayExits = exits.filter(e => e.date === date);
    const dayPnl = dayExits.reduce((s, e) => s + e.pnl, 0);
    cumPnl += dayPnl;

    // Count positions at end of day
    const dayBuys = ledger.filter(e => e.date === date && (e.action === 'BUY' || e.action.startsWith('LOT')));
    const daySells = ledger.filter(e => e.date === date && e.action === 'SELL');

    // Cash at end of this day
    const lastEvent = [...ledger].filter(e => e.date <= date).pop();
    const eodCash = lastEvent ? lastEvent.cashAfter : NAV_INITIAL;

    // Rough position count (open at end of day)
    const posCount = dayBuys.length > 0 || daySells.length > 0
      ? `${dayBuys.length}B/${daySells.length}S`
      : '-';

    if (dayBuys.length > 0 || daySells.length > 0) {
      console.log(`  ${date.padEnd(12)} ${posCount.padStart(10)} $${eodCash.toFixed(0).padStart(11)} ${' '.repeat(12)} $${dayPnl.toFixed(2).padStart(9)} $${cumPnl.toFixed(2).padStart(11)}`);
    }
  }

  console.log('\n' + '='.repeat(130));
  console.log('  PNTHR AMBUSH V5 BACKTEST COMPLETE');
  console.log('='.repeat(130));

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
