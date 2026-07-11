// server/backtest/pai300HourlyV2.js
// ── 90-DAY HOURLY RE-ENTRY V2 — PULLBACK-FIRST VARIATIONS ─────────────────
//
// Core concept: stock makes NOW/MCE, we enter L1. Runs up, hits BE threshold,
// sets breakeven stop. Pulls back, gets stopped at $0 loss. Stock trades DOWN.
// We wait for a REAL pullback, THEN look for the green hourly bar = buyers back.
// Re-enter at a LOWER price for better economics.
//
// Tests pullback requirements: stock must drop X% below stop-out BEFORE
// we look for the re-entry green bar. Plus combinations with BE thresholds.
//
// Usage: cd server && node backtest/pai300HourlyV2.js
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

async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('No DB'); process.exit(1); }

  console.log('='.repeat(100));
  console.log('  90-DAY HOURLY V2 — PULLBACK-FIRST RE-ENTRY');
  console.log('  Stock must drop X% below stop-out BEFORE green bar triggers re-entry');
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
  console.log(`  ${Object.keys(signalsByTicker).length} tickers`);

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

  function getSectorMult(ticker, dateStr) {
    const weekOf = getWeekOf(dateStr);
    if (!CARNIVORE_MODE_TICKERS.has(ticker)) {
      const dates = Object.keys(aiSectorTierByDate).sort();
      let best = null;
      for (const d of dates) { if (d <= dateStr) best = d; else break; }
      if (!best) return { ok: true, mult: 1.0 };
      const tiers = aiSectorTierByDate[best];
      const sectorId = AI_TICKER_META[ticker]?.sectorId;
      const tier = tiers?.[sectorId];
      if (tier === 'GO') return { ok: true, mult: 1.25 };
      if (tier === 'NEUTRAL' || !tier) return { ok: true, mult: 1.0 };
      return { ok: false, mult: 0 };
    } else {
      const gics = CARNIVORE_GICS[ticker];
      const etf = CARNIVORE_SECTOR_MAP[gics];
      if (!etf) return { ok: true, mult: 1.0 };
      const etfMap = etfAboveEmaByWeek[etf];
      if (!etfMap) return { ok: true, mult: 1.0 };
      let above = etfMap[weekOf];
      if (above === undefined) {
        const weeks = Object.keys(etfMap).sort();
        let best = null;
        for (const w of weeks) { if (w <= weekOf) best = w; else break; }
        above = best ? etfMap[best] : true;
      }
      return above ? { ok: true, mult: 1.0 } : { ok: false, mult: 0 };
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

  function getStop(ticker, dateStr, entryPrice) {
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

  function sizeL1(entryPrice, atrStop, mult) {
    const vDollar = NAV_INITIAL * VITALITY_PCT * mult;
    const capDollar = NAV_INITIAL * TICKER_CAP_PCT;
    const rps = entryPrice - atrStop;
    if (rps <= 0.01) return null;
    const total = Math.min(Math.floor(vDollar / rps), Math.floor(capDollar / entryPrice));
    if (total < 3) return null;
    const l1 = Math.max(1, Math.round(total * STRIKE_PCT[0]));
    const maxLossStop = entryPrice - (MAX_LOSS_L1 / l1);
    const stop = Math.max(atrStop, maxLossStop);
    if (stop >= entryPrice) return null;
    return { total, l1, stop, lots: STRIKE_PCT.map(p => Math.max(1, Math.round(total * p))) };
  }

  // ── SIMULATION ─────────────────────────────────────────────────────────────
  console.log('\n[3] Running variations...');

  function runSim(beThreshold, pullbackPct, reentryStyle) {
    const positions = {};
    const waiting = {};
    const cycles = [];
    const activeEntries = {};

    for (let dayIdx = 0; dayIdx < hourlyTradingDates.length; dayIdx++) {
      const date = hourlyTradingDates[dayIdx];

      // Hourly bars by ticker for this day
      const dayHourly = {};
      for (const [t, bars] of Object.entries(hourlyBarMap)) {
        const db = bars.filter(b => b.date.startsWith(date));
        if (db.length) dayHourly[t] = db;
      }

      // ── Existing positions: check stops + BE on hourly bars ──
      for (const [ticker, pos] of Object.entries(positions)) {
        const hBars = dayHourly[ticker];
        if (!hBars) continue;

        for (const hBar of hBars) {
          if (!positions[ticker]) break;

          // Stop hit
          if (pos.stop != null && hBar.low <= pos.stop) {
            const exitPrice = Math.max(hBar.low, pos.stop);
            const pnl = (exitPrice - pos.entryPrice) * pos.l1;
            const phase = pos.atBE ? 'BE_STOP' : 'MAX_LOSS';

            cycles.push({
              ticker, phase,
              entryPrice: pos.entryPrice, exitPrice,
              entryDate: pos.entryDate, exitDate: date, exitHour: hBar.date,
              pnl: +pnl.toFixed(2), peakProfit: pos.peak, l1: pos.l1,
              isReentry: pos.isReentry || false,
              reentryNum: pos.reentryNum || 0,
              originalEntry: pos.originalEntry || pos.entryPrice,
              priceImprovement: pos.priceImprovement || 0,
            });

            if (pos.atBE) {
              waiting[ticker] = {
                originalEntry: pos.originalEntry || pos.entryPrice,
                stopOutPrice: exitPrice, stopOutDate: date,
                peak: pos.peak, l1: pos.l1,
                reentryNum: (pos.reentryNum || 0) + 1,
                pullbackLow: exitPrice,
                pullbackReached: false,
              };
            }
            delete positions[ticker];
            break;
          }

          // Track peak
          const unr = (hBar.high - pos.entryPrice) * pos.l1;
          if (unr > (pos.peak || 0)) pos.peak = +unr.toFixed(2);

          // BE threshold
          if (!pos.atBE && unr >= beThreshold) {
            pos.atBE = true;
            const feesPer = (IBKR_COMMISSION + IBKR_SLIPPAGE * pos.l1) / pos.l1;
            pos.stop = +(pos.entryPrice + feesPer).toFixed(2);
          }

          pos.hours = (pos.hours || 0) + 1;
        }
      }

      // ── Re-entry checks on hourly bars ──
      for (const [ticker, w] of Object.entries(waiting)) {
        if (positions[ticker]) { delete waiting[ticker]; continue; }

        const hBars = dayHourly[ticker];
        if (!hBars) continue;
        if (!isActiveBL(ticker, date)) { delete waiting[ticker]; continue; }
        if (!getRegime(ticker, date)) continue;
        const sg = getSectorMult(ticker, date);
        if (!sg.ok) continue;

        const daysSince = hourlyTradingDates.indexOf(date) - hourlyTradingDates.indexOf(w.stopOutDate);
        if (daysSince > 10) { delete waiting[ticker]; continue; }

        for (const hBar of hBars) {
          if (positions[ticker]) break;

          // Track pullback low
          if (hBar.low < w.pullbackLow) w.pullbackLow = hBar.low;

          // Check if pullback requirement met
          const pullbackFromStop = (w.stopOutPrice - w.pullbackLow) / w.stopOutPrice;
          if (!w.pullbackReached && pullbackFromStop >= pullbackPct) {
            w.pullbackReached = true;
          }

          // Must have reached pullback threshold first
          if (!w.pullbackReached) continue;

          let triggered = false;
          let rePrice = null;

          if (reentryStyle === 'green_bar') {
            if (hBar.close > hBar.open) {
              triggered = true;
              rePrice = hBar.close;
            }
          } else if (reentryStyle === 'green_above_stopout') {
            if (hBar.close > hBar.open && hBar.close > w.stopOutPrice) {
              triggered = true;
              rePrice = hBar.close;
            }
          } else if (reentryStyle === 'green_below_original') {
            if (hBar.close > hBar.open && hBar.close < w.originalEntry) {
              triggered = true;
              rePrice = hBar.close;
            }
          } else if (reentryStyle === 'higher_low_green') {
            const idx = hBars.indexOf(hBar);
            const prev = idx > 0 ? hBars[idx - 1] : null;
            if (prev && hBar.low > prev.low && hBar.close > hBar.open) {
              triggered = true;
              rePrice = hBar.close;
            }
          } else if (reentryStyle === 'two_bar_breakout') {
            const idx = hBars.indexOf(hBar);
            if (idx >= 2) {
              const trig = Math.max(hBars[idx - 1].high, hBars[idx - 2].high) + 0.01;
              if (hBar.high >= trig) {
                triggered = true;
                rePrice = Math.max(hBar.open, trig);
              }
            }
          }

          if (!triggered || !rePrice) continue;

          const atrStop = getStop(ticker, date, rePrice);
          if (!atrStop || atrStop >= rePrice) continue;
          const sz = sizeL1(rePrice, atrStop, sg.mult);
          if (!sz) continue;

          const improvement = w.originalEntry - rePrice;

          cycles.push({
            ticker, phase: 'REENTRY',
            originalEntry: w.originalEntry, stopOutPrice: w.stopOutPrice,
            reentryPrice: rePrice, reentryDate: date, reentryHour: hBar.date,
            priceImprovement: +improvement.toFixed(2),
            pullbackLow: +w.pullbackLow.toFixed(2),
            pullbackPct: +(pullbackFromStop * 100).toFixed(2),
            reentryNum: w.reentryNum,
            peakBeforeStop: w.peak,
          });

          positions[ticker] = {
            ticker, entryPrice: rePrice, entryDate: date,
            l1: sz.l1, stop: sz.stop, atBE: false, peak: 0, hours: 0,
            isReentry: true, reentryNum: w.reentryNum,
            originalEntry: w.originalEntry,
            priceImprovement: +improvement.toFixed(2),
          };

          delete waiting[ticker];
          break;
        }
      }

      // ── New MCE entries ──
      if (dayIdx >= 2) {
        const p1 = hourlyTradingDates[dayIdx - 1];
        const p2 = hourlyTradingDates[dayIdx - 2];

        for (const ticker of Object.keys(signalsByTicker)) {
          if (positions[ticker] || waiting[ticker] || activeEntries[ticker] === date) continue;
          if (!hourlyBarMap[ticker]) continue;
          if (!isActiveBL(ticker, date)) continue;
          if (!getRegime(ticker, date)) continue;
          const sg = getSectorMult(ticker, date);
          if (!sg.ok) continue;

          const bar = dailyBarMap[ticker]?.[date];
          const prev1 = dailyBarMap[ticker]?.[p1];
          const prev2 = dailyBarMap[ticker]?.[p2];
          if (!bar || !prev1 || !prev2) continue;

          const trigger = Math.max(prev1.high, prev2.high) + 0.01;
          if (bar.high < trigger) continue;

          const ep = Math.max(bar.open, trigger);
          const atrStop = getStop(ticker, date, ep);
          if (!atrStop || atrStop >= ep) continue;
          const sz = sizeL1(ep, atrStop, sg.mult);
          if (!sz) continue;

          positions[ticker] = {
            ticker, entryPrice: ep, entryDate: date,
            l1: sz.l1, stop: sz.stop, atBE: false, peak: 0, hours: 0,
            isReentry: false, reentryNum: 0, originalEntry: ep,
          };
          activeEntries[ticker] = date;
        }
      }
    }

    // Close remaining at last price
    for (const [ticker, pos] of Object.entries(positions)) {
      const hBars = hourlyBarMap[ticker];
      if (!hBars || !hBars.length) continue;
      const last = hBars[hBars.length - 1];
      const pnl = (last.close - pos.entryPrice) * pos.l1;
      cycles.push({
        ticker, phase: pos.isReentry ? 'RE_OPEN' : 'SCOUT_OPEN',
        entryPrice: pos.entryPrice, exitPrice: last.close,
        entryDate: pos.entryDate, exitDate: last.date.split(' ')[0],
        pnl: +pnl.toFixed(2), peakProfit: pos.peak, l1: pos.l1,
        isReentry: pos.isReentry || false, reentryNum: pos.reentryNum || 0,
        originalEntry: pos.originalEntry || pos.entryPrice,
        priceImprovement: pos.priceImprovement || 0,
      });
    }

    return cycles;
  }

  // ── VARIATIONS ─────────────────────────────────────────────────────────────

  const variations = [];

  const beThresholds = [50, 100, 150, 200];
  const pullbacks = [0, 0.005, 0.01, 0.015, 0.02, 0.03, 0.04, 0.05];
  const reentryStyles = [
    { key: 'green_bar', label: 'Any green bar (after pullback)' },
    { key: 'green_below_original', label: 'Green bar below original entry' },
    { key: 'higher_low_green', label: 'Higher-low + green bar' },
    { key: 'two_bar_breakout', label: '2-bar hourly breakout' },
  ];

  for (const be of beThresholds) {
    for (const pb of pullbacks) {
      for (const rs of reentryStyles) {
        variations.push({ be, pb, rsKey: rs.key, rsLabel: rs.label });
      }
    }
  }

  console.log(`  ${variations.length} variations to test...`);

  const results = [];
  let count = 0;

  for (const v of variations) {
    count++;
    if (count % 32 === 0) process.stdout.write(`  ${count}/${variations.length}\r`);

    const cycles = runSim(v.be, v.pb, v.rsKey);

    const beStops = cycles.filter(c => c.phase === 'BE_STOP');
    const maxLoss = cycles.filter(c => c.phase === 'MAX_LOSS');
    const reentries = cycles.filter(c => c.phase === 'REENTRY');
    const allTrades = cycles.filter(c => c.pnl !== undefined);
    const wins = allTrades.filter(c => c.pnl > 0);
    const losses = allTrades.filter(c => c.pnl < 0);
    const grossWin = wins.reduce((s, c) => s + c.pnl, 0);
    const grossLoss = losses.reduce((s, c) => s + c.pnl, 0);
    const netPnl = grossWin + grossLoss;
    const pf = grossLoss ? grossWin / Math.abs(grossLoss) : 999;
    const wr = allTrades.length ? wins.length / allTrades.length : 0;
    const avgWin = wins.length ? grossWin / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(grossLoss / losses.length) : 1;
    const payoff = avgLoss > 0 ? avgWin / avgLoss : 999;

    const improvements = reentries.map(c => c.priceImprovement).filter(v => v != null);
    const avgImpr = improvements.length ? improvements.reduce((s, v) => s + v, 0) / improvements.length : 0;
    const posImpr = improvements.filter(v => v > 0);
    const posImprPct = improvements.length ? posImpr.length / improvements.length : 0;

    // Re-entry specific trades
    const reTrades = allTrades.filter(c => c.isReentry);
    const reWins = reTrades.filter(c => c.pnl > 0);
    const reLosses = reTrades.filter(c => c.pnl < 0);
    const reGrossWin = reWins.reduce((s, c) => s + c.pnl, 0);
    const reGrossLoss = reLosses.reduce((s, c) => s + c.pnl, 0);
    const reNetPnl = reGrossWin + reGrossLoss;
    const reWr = reTrades.length ? reWins.length / reTrades.length : 0;
    const rePf = reGrossLoss ? reGrossWin / Math.abs(reGrossLoss) : 999;

    results.push({
      be: v.be, pb: v.pb, rs: v.rsKey, rsLabel: v.rsLabel,
      beStops: beStops.length, maxLoss: maxLoss.length,
      reentries: reentries.length,
      reentryRate: beStops.length ? reentries.length / beStops.length : 0,
      avgImpr, posImprPct,
      netPnl, pf, wr, payoff,
      trades: allTrades.length,
      reNetPnl, reWr, rePf, reTrades: reTrades.length,
    });
  }

  console.log(`  ${count}/${variations.length} done.`);

  // ── TOP 30 BY NET P&L ─────────────────────────────────────────────────────
  results.sort((a, b) => b.netPnl - a.netPnl);

  console.log('\n' + '='.repeat(140));
  console.log('  TOP 30 VARIATIONS BY NET P&L');
  console.log('='.repeat(140));
  console.log(`  ${'#'.padStart(3)} ${'BE$'.padStart(5)} ${'PB%'.padStart(5)} ${'Re-entry Style'.padEnd(32)} ${'Net$'.padStart(9)} ${'PF'.padStart(7)} ${'WR'.padStart(6)} ${'Payoff'.padStart(7)} ${'ReEnt'.padStart(6)} ${'Rate'.padStart(6)} ${'AvgImpr'.padStart(8)} ${'Impr%'.padStart(6)} ${'ReNet$'.padStart(8)} ${'ReWR'.padStart(6)} ${'RePF'.padStart(7)}`);

  for (let i = 0; i < Math.min(30, results.length); i++) {
    const r = results[i];
    console.log(`  ${String(i + 1).padStart(3)} $${String(r.be).padStart(4)} ${(r.pb * 100).toFixed(1).padStart(5)}% ${r.rsLabel.padEnd(32)} $${String(r.netPnl.toFixed(0)).padStart(8)} ${r.pf.toFixed(2).padStart(6)}x ${(r.wr * 100).toFixed(0).padStart(5)}% ${r.payoff.toFixed(1).padStart(6)}x ${String(r.reentries).padStart(6)} ${(r.reentryRate * 100).toFixed(0).padStart(5)}% $${r.avgImpr.toFixed(2).padStart(7)} ${(r.posImprPct * 100).toFixed(0).padStart(5)}% $${String(r.reNetPnl.toFixed(0)).padStart(7)} ${(r.reWr * 100).toFixed(0).padStart(5)}% ${r.rePf > 100 ? '>100x' : r.rePf.toFixed(1) + 'x'}`);
  }

  // ── TOP 30 BY PAYOFF RATIO (minimum 10 re-entries) ────────────────────────
  const byPayoff = results.filter(r => r.reentries >= 10).sort((a, b) => b.payoff - a.payoff);

  console.log('\n' + '='.repeat(140));
  console.log('  TOP 30 BY PAYOFF RATIO (min 10 re-entries)');
  console.log('='.repeat(140));
  console.log(`  ${'#'.padStart(3)} ${'BE$'.padStart(5)} ${'PB%'.padStart(5)} ${'Re-entry Style'.padEnd(32)} ${'Net$'.padStart(9)} ${'PF'.padStart(7)} ${'WR'.padStart(6)} ${'Payoff'.padStart(7)} ${'ReEnt'.padStart(6)} ${'Rate'.padStart(6)} ${'AvgImpr'.padStart(8)} ${'Impr%'.padStart(6)} ${'ReNet$'.padStart(8)} ${'ReWR'.padStart(6)} ${'RePF'.padStart(7)}`);

  for (let i = 0; i < Math.min(30, byPayoff.length); i++) {
    const r = byPayoff[i];
    console.log(`  ${String(i + 1).padStart(3)} $${String(r.be).padStart(4)} ${(r.pb * 100).toFixed(1).padStart(5)}% ${r.rsLabel.padEnd(32)} $${String(r.netPnl.toFixed(0)).padStart(8)} ${r.pf.toFixed(2).padStart(6)}x ${(r.wr * 100).toFixed(0).padStart(5)}% ${r.payoff.toFixed(1).padStart(6)}x ${String(r.reentries).padStart(6)} ${(r.reentryRate * 100).toFixed(0).padStart(5)}% $${r.avgImpr.toFixed(2).padStart(7)} ${(r.posImprPct * 100).toFixed(0).padStart(5)}% $${String(r.reNetPnl.toFixed(0)).padStart(7)} ${(r.reWr * 100).toFixed(0).padStart(5)}% ${r.rePf > 100 ? '>100x' : r.rePf.toFixed(1) + 'x'}`);
  }

  // ── TOP 30 BY PRICE IMPROVEMENT (min 10 re-entries, positive avg) ─────────
  const byImpr = results.filter(r => r.reentries >= 10 && r.avgImpr > 0).sort((a, b) => b.avgImpr - a.avgImpr);

  console.log('\n' + '='.repeat(140));
  console.log('  TOP 30 BY AVG PRICE IMPROVEMENT (positive only, min 10 re-entries)');
  console.log('='.repeat(140));
  console.log(`  ${'#'.padStart(3)} ${'BE$'.padStart(5)} ${'PB%'.padStart(5)} ${'Re-entry Style'.padEnd(32)} ${'Net$'.padStart(9)} ${'PF'.padStart(7)} ${'WR'.padStart(6)} ${'Payoff'.padStart(7)} ${'ReEnt'.padStart(6)} ${'Rate'.padStart(6)} ${'AvgImpr'.padStart(8)} ${'Impr%'.padStart(6)} ${'ReNet$'.padStart(8)} ${'ReWR'.padStart(6)} ${'RePF'.padStart(7)}`);

  for (let i = 0; i < Math.min(30, byImpr.length); i++) {
    const r = byImpr[i];
    console.log(`  ${String(i + 1).padStart(3)} $${String(r.be).padStart(4)} ${(r.pb * 100).toFixed(1).padStart(5)}% ${r.rsLabel.padEnd(32)} $${String(r.netPnl.toFixed(0)).padStart(8)} ${r.pf.toFixed(2).padStart(6)}x ${(r.wr * 100).toFixed(0).padStart(5)}% ${r.payoff.toFixed(1).padStart(6)}x ${String(r.reentries).padStart(6)} ${(r.reentryRate * 100).toFixed(0).padStart(5)}% $${r.avgImpr.toFixed(2).padStart(7)} ${(r.posImprPct * 100).toFixed(0).padStart(5)}% $${String(r.reNetPnl.toFixed(0)).padStart(7)} ${(r.reWr * 100).toFixed(0).padStart(5)}% ${r.rePf > 100 ? '>100x' : r.rePf.toFixed(1) + 'x'}`);
  }

  // ── BEST BALANCED (good P&L + positive improvement + good payoff) ─────────
  const balanced = results
    .filter(r => r.reentries >= 10 && r.avgImpr > 0)
    .map(r => ({
      ...r,
      score: (r.netPnl / 10000) + (r.payoff * 2) + (r.avgImpr * 0.5) + (r.posImprPct * 5) + (r.reWr * 10),
    }))
    .sort((a, b) => b.score - a.score);

  console.log('\n' + '='.repeat(140));
  console.log('  TOP 20 BALANCED SCORE (P&L + payoff + price improvement + re-entry WR)');
  console.log('='.repeat(140));
  console.log(`  ${'#'.padStart(3)} ${'BE$'.padStart(5)} ${'PB%'.padStart(5)} ${'Re-entry Style'.padEnd(32)} ${'Net$'.padStart(9)} ${'PF'.padStart(7)} ${'WR'.padStart(6)} ${'Payoff'.padStart(7)} ${'ReEnt'.padStart(6)} ${'Rate'.padStart(6)} ${'AvgImpr'.padStart(8)} ${'Impr%'.padStart(6)} ${'ReNet$'.padStart(8)} ${'ReWR'.padStart(6)} ${'Score'.padStart(7)}`);

  for (let i = 0; i < Math.min(20, balanced.length); i++) {
    const r = balanced[i];
    console.log(`  ${String(i + 1).padStart(3)} $${String(r.be).padStart(4)} ${(r.pb * 100).toFixed(1).padStart(5)}% ${r.rsLabel.padEnd(32)} $${String(r.netPnl.toFixed(0)).padStart(8)} ${r.pf.toFixed(2).padStart(6)}x ${(r.wr * 100).toFixed(0).padStart(5)}% ${r.payoff.toFixed(1).padStart(6)}x ${String(r.reentries).padStart(6)} ${(r.reentryRate * 100).toFixed(0).padStart(5)}% $${r.avgImpr.toFixed(2).padStart(7)} ${(r.posImprPct * 100).toFixed(0).padStart(5)}% $${String(r.reNetPnl.toFixed(0)).padStart(7)} ${(r.reWr * 100).toFixed(0).padStart(5)}% ${r.score.toFixed(1).padStart(6)}`);
  }

  console.log('\n' + '='.repeat(100));
  console.log('  Done.');
  console.log('='.repeat(100));

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
