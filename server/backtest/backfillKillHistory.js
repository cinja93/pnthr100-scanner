// server/backtest/backfillKillHistory.js
// ── Historical Kill Top 10 Backfill — Re-runs scoring engine for each Friday ──
//
// Loads ALL daily candle data from caches, then for each Friday from Jan 3, 2026:
//   1. Truncates candles to that date
//   2. Runs signal detection on all tickers (BL/SS state machine)
//   3. Computes index regime (SPY/QQQ) and sector data
//   4. Computes YTD rankings with week-over-week rankChange
//   5. Scores all signaled stocks through D1-D8 (exact formulas from apexService.js)
//   6. Ranks, identifies top 10, creates case study entries
//
// Usage: cd server && node backtest/backfillKillHistory.js [--dry-run]
//
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config();
import { connectToDatabase } from '../database.js';
import { computeWilderATR, blInitStop, ssInitStop } from '../stopCalculation.js';
import { getSectorEmaPeriod, SECTOR_EMA_PERIODS, DEFAULT_EMA_PERIOD } from '../sectorEmaConfig.js';

const DRY_RUN = process.argv.includes('--dry-run');

// ── Constants ────────────────────────────────────────────────────────────────

const SECTOR_MAP = {
  'Technology': 'XLK', 'Energy': 'XLE', 'Healthcare': 'XLV', 'Health Care': 'XLV',
  'Financial Services': 'XLF', 'Financials': 'XLF', 'Consumer Discretionary': 'XLY',
  'Communication Services': 'XLC', 'Industrials': 'XLI', 'Basic Materials': 'XLB',
  'Materials': 'XLB', 'Real Estate': 'XLRE', 'Utilities': 'XLU', 'Consumer Staples': 'XLP',
};
const ALL_SECTOR_ETFS = ['XLK', 'XLE', 'XLV', 'XLF', 'XLY', 'XLC', 'XLI', 'XLB', 'XLRE', 'XLU', 'XLP'];

const APEX_TIERS = [
  { name: 'ALPHA PNTHR KILL', min: 130 },
  { name: 'STRIKING',         min: 100 },
  { name: 'HUNTING',          min:  80 },
  { name: 'POUNCING',         min:  65 },
  { name: 'COILING',          min:  50 },
  { name: 'STALKING',         min:  35 },
  { name: 'TRACKING',         min:  20 },
  { name: 'PROWLING',         min:  10 },
  { name: 'STIRRING',         min:   0 },
  { name: 'DORMANT',          min: -Infinity },
];

function getTier(score) {
  return APEX_TIERS.find(t => score >= t.min) ?? APEX_TIERS[9];
}

// ── Date Helpers ─────────────────────────────────────────────────────────────

function getFridaysInRange(startDate, endDate) {
  const fridays = [];
  const d = new Date(startDate + 'T12:00:00');
  // Advance to first Friday
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
  const end = new Date(endDate + 'T12:00:00');
  while (d <= end) {
    fridays.push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate() + 7);
  }
  return fridays;
}

function getWeekMonday(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const dow = d.getDay();
  const daysToMon = dow === 0 ? -6 : 1 - dow;
  const mon = new Date(d);
  mon.setDate(d.getDate() + daysToMon);
  return mon.toISOString().split('T')[0];
}

// ── Weekly Bar Aggregation ───────────────────────────────────────────────────
// Groups daily bars (ascending by date) into weekly OHLCV bars keyed by Monday.

function aggregateWeeklyFromAsc(dailyAsc) {
  const weekMap = {};
  for (const bar of dailyAsc) {
    const date = new Date(bar.date + 'T12:00:00');
    const dow = date.getDay();
    const daysToMon = dow === 0 ? -6 : 1 - dow;
    const mon = new Date(date);
    mon.setDate(date.getDate() + daysToMon);
    const key = mon.toISOString().split('T')[0];

    if (!weekMap[key]) {
      weekMap[key] = { weekStart: key, open: bar.open, high: -Infinity, low: Infinity, close: null, volume: 0 };
    }
    const w = weekMap[key];
    w.high = Math.max(w.high, bar.high);
    w.low = Math.min(w.low, bar.low);
    w.close = bar.close; // last bar in week = Friday close
    w.volume += (bar.volume || 0);
  }
  return Object.values(weekMap).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

// ── EMA Computation ──────────────────────────────────────────────────────────

function computeEMASeries(closes, period) {
  if (closes.length < period) return [];
  const mult = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, c) => s + c, 0) / period;
  const emas = [ema];
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * mult + ema * (1 - mult);
    emas.push(ema);
  }
  return emas;
}

function computeEMA21series(weeklyBars) {
  const closes = weeklyBars.map(b => b.close);
  const raw = computeEMASeries(closes, 21);
  const result = new Array(weeklyBars.length).fill(null);
  for (let i = 0; i < raw.length; i++) result[i + 20] = raw[i];
  return result;
}

// ── Technical Indicators ─────────────────────────────────────────────────────

function computeRSI14(weeklyBars) {
  const closes = weeklyBars.map(b => b.close);
  const n = closes.length;
  const rsi = new Array(n).fill(null);
  if (n < 15) return rsi;

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= 14; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change; else avgLoss += Math.abs(change);
  }
  avgGain /= 14;
  avgLoss /= 14;
  rsi[14] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = 15; i < n; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * 13 + gain) / 14;
    avgLoss = (avgLoss * 13 + loss) / 14;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function computeOBV(weeklyBars) {
  const n = weeklyBars.length;
  const obv = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    if (weeklyBars[i].close > weeklyBars[i - 1].close) obv[i] = obv[i - 1] + weeklyBars[i].volume;
    else if (weeklyBars[i].close < weeklyBars[i - 1].close) obv[i] = obv[i - 1] - weeklyBars[i].volume;
    else obv[i] = obv[i - 1];
  }
  return obv;
}

function computeADX14(weeklyBars) {
  const n = weeklyBars.length;
  const adx = new Array(n).fill(null);
  if (n < 28) return adx;

  const plusDM = [], minusDM = [], tr = [];
  for (let i = 1; i < n; i++) {
    const h = weeklyBars[i].high, l = weeklyBars[i].low, pc = weeklyBars[i - 1].close;
    const ph = weeklyBars[i - 1].high, pl = weeklyBars[i - 1].low;
    const up = h - ph, dn = pl - l;
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }

  let smoothTR = 0, smoothPlusDM = 0, smoothMinusDM = 0;
  for (let i = 0; i < 14; i++) { smoothTR += tr[i]; smoothPlusDM += plusDM[i]; smoothMinusDM += minusDM[i]; }

  const dx = [];
  for (let i = 13; i < plusDM.length; i++) {
    if (i > 13) {
      smoothTR = smoothTR - smoothTR / 14 + tr[i];
      smoothPlusDM = smoothPlusDM - smoothPlusDM / 14 + plusDM[i];
      smoothMinusDM = smoothMinusDM - smoothMinusDM / 14 + minusDM[i];
    }
    const pdi = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
    const mdi = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
    const diSum = pdi + mdi;
    dx.push(diSum > 0 ? Math.abs(pdi - mdi) / diSum * 100 : 0);
  }

  if (dx.length < 14) return adx;
  let adxVal = dx.slice(0, 14).reduce((s, v) => s + v, 0) / 14;
  adx[27] = adxVal;
  for (let i = 14; i < dx.length; i++) {
    adxVal = (adxVal * 13 + dx[i]) / 14;
    adx[i + 14] = adxVal;
  }
  return adx;
}

// ── Signal Detection (exact copy of signalService.js runStateMachine) ────────

function runStateMachine(weeklyBars, isETF = false, emaPeriod = DEFAULT_EMA_PERIOD) {
  if (weeklyBars.length < emaPeriod + 2) return { signal: null, ema21: null, stopPrice: null };

  const closes = weeklyBars.map(b => b.close);
  const emas = computeEMASeries(closes, emaPeriod);
  if (emas.length < 2) return { signal: null, ema21: null, stopPrice: null };
  const atrArr = computeWilderATR(weeklyBars);
  const emaOffset = emaPeriod - 1;

  let position = null, lastEvent = null;
  let longDaylight = 0, shortDaylight = 0;
  let longTrendActive = false, longTrendCapped = false;
  let shortTrendActive = false, shortTrendCapped = false;

  for (let wi = emaPeriod + 1; wi < weeklyBars.length; wi++) {
    const emaIdx = wi - emaOffset;
    if (emaIdx < 1) continue;

    const current = weeklyBars[wi];
    const prev1 = weeklyBars[wi - 1];
    const prev2 = weeklyBars[wi - 2];
    const emaCurrent = emas[emaIdx];
    const twoWeekHigh = Math.max(prev1.high, prev2.high);
    const twoWeekLow = Math.min(prev1.low, prev2.low);

    longDaylight = current.low > emaCurrent ? longDaylight + 1 : 0;
    shortDaylight = current.high < emaCurrent ? shortDaylight + 1 : 0;

    if (position && position.entryWi !== wi) {
      const prevAtr = atrArr[wi - 1];
      if (prevAtr != null) {
        if (position.type === 'BL') {
          const structStop = parseFloat((twoWeekLow - 0.01).toFixed(2));
          const atrFloor = parseFloat((prev1.close - prevAtr).toFixed(2));
          const candidate = Math.max(structStop, atrFloor);
          position.pnthrStop = parseFloat(Math.max(position.pnthrStop, candidate).toFixed(2));
        } else {
          const structStop = parseFloat((twoWeekHigh + 0.01).toFixed(2));
          const atrCeiling = parseFloat((prev1.close + prevAtr).toFixed(2));
          const candidate = Math.min(structStop, atrCeiling);
          position.pnthrStop = parseFloat(Math.min(position.pnthrStop, candidate).toFixed(2));
        }
      }
      if (position.type === 'BL' && current.low < twoWeekLow) {
        lastEvent = { signal: 'BE', signalDate: current.weekStart, ema21: parseFloat(emaCurrent.toFixed(4)), stopPrice: null };
        shortTrendActive = true; shortTrendCapped = true;
        position = null; continue;
      }
      if (position.type === 'SS' && current.high > twoWeekHigh) {
        lastEvent = { signal: 'SE', signalDate: current.weekStart, ema21: parseFloat(emaCurrent.toFixed(4)), stopPrice: null };
        longTrendActive = true; longTrendCapped = true;
        position = null; continue;
      }
    }

    if (!position) {
      const emaPrev = emas[emaIdx - 1];
      const blPhase1 = current.close > emaCurrent && emaCurrent > emaPrev && current.high >= twoWeekHigh + 0.01;
      const ssPhase1 = current.close < emaCurrent && emaCurrent < emaPrev && current.low <= twoWeekLow - 0.01;
      const dPct = isETF ? 0.003 : 0.01;
      const blZone = current.low >= emaCurrent * (1 + dPct) && current.low <= emaCurrent * 1.10;
      const ssZone = current.high <= emaCurrent * (1 - dPct) && current.high >= emaCurrent * 0.90;

      const blReentry = longTrendActive && current.low >= emaCurrent * (1 + dPct) && (!longTrendCapped || current.low <= emaCurrent * 1.25);
      const ssReentry = shortTrendActive && current.high <= emaCurrent * (1 - dPct) && (!shortTrendCapped || current.high >= emaCurrent * 0.75);
      const blDaylightOk = blReentry || (blZone && longDaylight >= 1 && longDaylight <= 3);
      const ssDaylightOk = ssReentry || (ssZone && shortDaylight >= 1 && shortDaylight <= 3);

      if (blPhase1 && blDaylightOk) {
        const initStop = blInitStop(twoWeekLow, current.close, atrArr[wi]);
        lastEvent = { signal: 'BL', signalDate: current.weekStart, ema21: parseFloat(emaCurrent.toFixed(4)), stopPrice: initStop };
        position = { type: 'BL', entryWi: wi, pnthrStop: initStop, entryPrice: parseFloat((twoWeekHigh + 0.01).toFixed(2)) };
        longTrendActive = true; longTrendCapped = false;
        shortTrendActive = false; shortTrendCapped = false;
      } else if (ssPhase1 && ssDaylightOk) {
        const initStop = ssInitStop(twoWeekHigh, current.close, atrArr[wi]);
        lastEvent = { signal: 'SS', signalDate: current.weekStart, ema21: parseFloat(emaCurrent.toFixed(4)), stopPrice: initStop };
        position = { type: 'SS', entryWi: wi, pnthrStop: initStop, entryPrice: parseFloat((twoWeekLow - 0.01).toFixed(2)) };
        shortTrendActive = true; shortTrendCapped = false;
        longTrendActive = false; longTrendCapped = false;
      }
    }
  }

  if (position && lastEvent) {
    lastEvent.pnthrStop = position.pnthrStop;
    lastEvent.stopPrice = position.pnthrStop;
  }

  const isActiveSignal = lastEvent && (lastEvent.signal === 'BL' || lastEvent.signal === 'SS');
  if (lastEvent) {
    const lastBar = weeklyBars[weeklyBars.length - 1];
    lastEvent.isNew = isActiveSignal && lastEvent.signalDate === lastBar.weekStart;
  }

  if (!lastEvent) {
    const lastEma = emas[emas.length - 1];
    return { signal: null, ema21: lastEma != null ? parseFloat(lastEma.toFixed(4)) : null, stopPrice: null };
  }
  return lastEvent;
}

// ── Signal Age Computation ───────────────────────────────────────────────────

function computeSignalAge(signalDate, targetMonday) {
  if (!signalDate) return 4;
  const signalMs = new Date(signalDate + 'T12:00:00').getTime();
  const targetMs = new Date(targetMonday + 'T12:00:00').getTime();
  const weeks = Math.round((targetMs - signalMs) / (7 * 24 * 60 * 60 * 1000));
  return Math.max(0, weeks);
}

// ── D1: Market Regime ────────────────────────────────────────────────────────

function calcD1(signal, exchange, indexData, signalCounts) {
  const { blCount = 0, ssCount = 0, newBlCount = 0, newSsCount = 0 } = signalCounts;
  const exc = (exchange || '').toUpperCase();
  const indexTicker = (exc === 'NASDAQ' || exc.includes('NASDAQ')) ? 'QQQ' : 'SPY';
  const idx = indexData[indexTicker];

  let indexScore = 0;
  if (idx) {
    const slopeDir = idx.emaSlope > 0.1 ? 'rising' : idx.emaSlope < -0.1 ? 'falling' : 'flat';
    if (!idx.aboveEma && slopeDir === 'falling') indexScore = -2;
    else if (!idx.aboveEma) indexScore = -1;
    else if (idx.aboveEma && slopeDir === 'rising') indexScore = 2;
    else if (idx.aboveEma) indexScore = 1;
  }

  const openRatio = ssCount / Math.max(blCount, 1);
  const newRatio = newSsCount / Math.max(newBlCount, 1);
  let ratioScore = 0;
  if (openRatio > 3) ratioScore = -2;
  else if (openRatio > 2) ratioScore = -1;
  else if (openRatio < 0.5) ratioScore = 2;
  else if (openRatio < 1) ratioScore = 1;
  if (newRatio > 5) ratioScore -= 1;
  else if (newRatio < 0.2) ratioScore += 1;

  const regimeScore = indexScore + ratioScore;
  let multiplier;
  if (signal === 'BL') multiplier = 1.0 + (regimeScore * 0.06);
  else multiplier = 1.0 - (regimeScore * 0.06);
  const score = Math.max(0.70, Math.min(1.30, Math.round(multiplier * 100) / 100));
  return { score };
}

// ── D2: Sector Alignment ─────────────────────────────────────────────────────

function scoreD2(signal, sector, isNewSignal, sectorData) {
  if (!signal || !sectorData) return { score: 0 };
  const etf = SECTOR_MAP[sector];
  if (!etf || !sectorData[etf]) return { score: 0 };
  const { return5D, return1M } = sectorData[etf];
  const sectorBullish = return5D >= 0;
  const aligned = (signal === 'BL' && sectorBullish) || (signal === 'SS' && !sectorBullish);
  const direction = aligned ? 1 : -1;
  const newMult = isNewSignal ? 2 : 1;
  const score5D = Math.abs(return5D) * newMult * direction * 2;
  const score1M = Math.abs(return1M || 0) * direction;
  const raw = score5D + score1M;
  return { score: Math.max(-15, Math.min(15, Math.round(raw * 10) / 10)) };
}

// ── D3: Entry Quality ────────────────────────────────────────────────────────

function scoreD3(signal, weekly, ema21) {
  const zero = { score: 0, confirmation: 'UNCONFIRMED', overextended: false, slopePct: 0, separationPct: 0, convictionPct: 0 };
  const n = weekly.length;
  const li = n - 1;
  const ema = ema21[li];
  const emaPrev = ema21[li - 1];
  const bar = weekly[li];
  if (ema == null || !bar) return zero;

  const range = bar.high - bar.low;
  let closeConvictionPct = 0;
  if (range > 0) {
    if (signal === 'BL') closeConvictionPct = (bar.close - bar.low) / range * 100;
    else closeConvictionPct = (bar.high - bar.close) / range * 100;
  }
  const subA = Math.min(Math.max(closeConvictionPct * 2.5, 0), 40);

  let emaSlopePct = 0;
  if (emaPrev != null && emaPrev !== 0) emaSlopePct = (ema - emaPrev) / emaPrev * 100;
  let subB = 0;
  if (signal === 'BL' && emaSlopePct > 0) subB = Math.min(emaSlopePct * 10, 30);
  else if (signal === 'SS' && emaSlopePct < 0) subB = Math.min(Math.abs(emaSlopePct) * 10, 30);

  let emaSeparationPct = 0, closeSepPct = 0;
  if (ema !== 0) {
    if (signal === 'BL') {
      emaSeparationPct = (bar.low - ema) / ema * 100;
      closeSepPct = (bar.close - ema) / ema * 100;
    } else {
      emaSeparationPct = (ema - bar.high) / ema * 100;
      closeSepPct = (ema - bar.close) / ema * 100;
    }
  }

  let subC = 0;
  if (emaSeparationPct <= 0) subC = 0;
  else if (emaSeparationPct <= 2) subC = emaSeparationPct * 3;
  else if (emaSeparationPct <= 8) subC = 6 + (emaSeparationPct - 2) * 1.5;
  else if (emaSeparationPct <= 15) subC = 15 - (emaSeparationPct - 8) * (12 / 7);
  else if (emaSeparationPct <= 20) subC = 3 - (emaSeparationPct - 15) * 0.6;
  subC = Math.max(subC, 0);

  const overextended = closeSepPct > 20;
  const total = Math.round((subA + subB + subC) * 10) / 10;

  let confirmation;
  if (overextended) confirmation = 'OVEREXTENDED';
  else if (total >= 30) confirmation = 'CONFIRMED';
  else if (total >= 15) confirmation = 'PARTIAL';
  else confirmation = 'UNCONFIRMED';

  return {
    score: total, confirmation, overextended,
    convictionPct: Math.round(closeConvictionPct * 10) / 10,
    slopePct: Math.round(emaSlopePct * 10) / 10,
    separationPct: Math.round(emaSeparationPct * 10) / 10,
  };
}

// ── D4: Signal Freshness ─────────────────────────────────────────────────────

function scoreD4(signalAge, d3Confirmation) {
  let score;
  if (signalAge === 0) {
    if (d3Confirmation === 'CONFIRMED') score = 10;
    else if (d3Confirmation === 'PARTIAL') score = 6;
    else score = 3;
  } else if (signalAge === 1) {
    if (d3Confirmation === 'CONFIRMED') score = 7;
    else if (d3Confirmation === 'PARTIAL') score = 4;
    else score = 2;
  } else if (signalAge === 2) score = 4;
  else if (signalAge <= 5) score = 0;
  else if (signalAge <= 9) score = -3 * (signalAge - 5);
  else score = Math.max(-12 - (signalAge - 9) * 1.5, -15);
  return { score };
}

// ── D5: Rank Rise ────────────────────────────────────────────────────────────

function scoreD5(rankChange) {
  if (rankChange == null) return { score: 0 };
  return { score: Math.max(-20, Math.min(20, Number(rankChange))) };
}

// ── D6: Momentum ─────────────────────────────────────────────────────────────

function scoreD6(signal, weekly, rsi, obv, adx) {
  const n = weekly.length;
  const li = n - 1;
  let subA = 0, subB = 0, subC = 0, subD = 0;
  const curRsi = rsi[li];

  if (curRsi != null) {
    if (signal === 'BL') subA = Math.min(Math.max((curRsi - 50) / 10, -5), 5);
    else subA = Math.min(Math.max((50 - curRsi) / 10, -5), 5);
  }
  if (li >= 1 && obv[li - 1] !== 0) {
    const obvChangePct = (obv[li] - obv[li - 1]) / Math.abs(obv[li - 1]) * 100;
    const obvAligned = signal === 'BL' ? obvChangePct : -obvChangePct;
    subB = Math.min(Math.max(obvAligned / 5, -5), 5);
  }
  const adxCur = adx[li], adxPrev = adx[li - 1];
  if (adxCur != null && adxCur > 15 && adxPrev != null && adxCur > adxPrev) {
    subC = Math.min((adxCur - 15) / 5, 5);
  }
  const lookback = Math.min(20, n - 1);
  if (lookback > 0) {
    const avgVol = weekly.slice(li - lookback, li).reduce((s, b) => s + b.volume, 0) / lookback;
    if (avgVol > 0 && weekly[li].volume / avgVol > 1.5) subD = 5;
  }

  const raw = subA + subB + subC + subD;
  return { score: Math.max(-10, Math.min(20, Math.round(raw * 10) / 10)), curRsi };
}

// ── D7: Rank Velocity ────────────────────────────────────────────────────────

function scoreD7(currentRankChange, previousRankChange) {
  if (currentRankChange == null || previousRankChange == null) return { score: 0 };
  const velocity = Number(currentRankChange) - Number(previousRankChange);
  return { score: Math.max(-10, Math.min(10, Math.round(velocity / 6))) };
}

// ── Main Backfill ────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  PNTHR Kill History — Historical Backfill');
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (no DB writes)' : 'LIVE (will write to DB)'}`);
  console.log(`${'═'.repeat(70)}\n`);

  const db = await connectToDatabase();
  if (!db) throw new Error('DB unavailable');

  // ── 1. Load ALL candle data ─────────────────────────────────────────────
  console.log('[1/6] Loading candle data from caches...');
  const allCandles = {};  // ticker → daily bars (ascending)

  // Primary cache
  const candleCache = await db.collection('pnthr_candle_cache').find({}).toArray();
  for (const doc of candleCache) {
    if (!doc.ticker || !doc.daily?.length) continue;
    const sorted = [...doc.daily].sort((a, b) => a.date.localeCompare(b.date));
    allCandles[doc.ticker] = sorted;
  }

  // Backtest candles (fill gaps)
  const btCandles = await db.collection('pnthr_bt_candles').find({}).toArray();
  for (const doc of btCandles) {
    if (!doc.ticker || !doc.daily?.length) continue;
    if (allCandles[doc.ticker]) continue; // prefer live cache
    const sorted = [...doc.daily].sort((a, b) => a.date.localeCompare(b.date));
    allCandles[doc.ticker] = sorted;
  }

  const allTickers = Object.keys(allCandles);
  console.log(`  Loaded ${allTickers.length} tickers with daily candle data`);

  // ── 2. Load stock metadata (sector, exchange) ──────────────────────────
  console.log('[2/6] Loading stock metadata from bt_scores...');
  const stockMeta = {};

  // Get metadata from the most recent bt_scores week
  const btMetaDocs = await db.collection('pnthr_bt_scores')
    .find({ weekOf: '2026-04-03' })
    .project({ ticker: 1, sector: 1, exchange: 1 })
    .toArray();
  for (const doc of btMetaDocs) {
    if (doc.ticker) stockMeta[doc.ticker] = { sector: doc.sector || '', exchange: doc.exchange || '' };
  }

  // Fill gaps from live kill_scores
  const liveMetaDocs = await db.collection('pnthr_kill_scores')
    .find({ weekOf: '2026-04-10' })
    .project({ ticker: 1, sector: 1, exchange: 1 })
    .toArray();
  for (const doc of liveMetaDocs) {
    if (doc.ticker && !stockMeta[doc.ticker]) {
      stockMeta[doc.ticker] = { sector: doc.sector || '', exchange: doc.exchange || '' };
    }
  }

  // Fill from rankings
  const rankDocs = await db.collection('rankings')
    .findOne({}, { sort: { date: -1 } });
  if (rankDocs?.rankings) {
    for (const r of [...(rankDocs.rankings || []), ...(rankDocs.shortRankings || [])]) {
      if (r.ticker && !stockMeta[r.ticker]) {
        stockMeta[r.ticker] = { sector: r.sector || '', exchange: r.exchange || '' };
      }
    }
  }

  console.log(`  Metadata for ${Object.keys(stockMeta).length} tickers`);

  // ── 3. Generate Fridays ─────────────────────────────────────────────────
  const fridays = getFridaysInRange('2026-01-01', '2026-04-11');
  console.log(`[3/6] Will process ${fridays.length} Fridays: ${fridays[0]} → ${fridays[fridays.length - 1]}\n`);

  // ── 4. Process each Friday ──────────────────────────────────────────────
  const allWeeklyResults = {};  // weekOf → { top10, scored, signalCounts }
  let prevRankings = {};  // ticker → rank (previous week)
  let prevRankChanges = {}; // ticker → rankChange (previous week, for D7)

  for (const friday of fridays) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  Processing: ${friday}`);
    console.log(`${'─'.repeat(60)}`);

    const targetMonday = getWeekMonday(friday);

    // Truncate candles to this Friday
    const truncatedCandles = {};
    for (const [ticker, daily] of Object.entries(allCandles)) {
      const trunc = daily.filter(b => b.date <= friday);
      if (trunc.length >= 40) truncatedCandles[ticker] = trunc;
    }
    console.log(`  Tickers with ≥40 bars: ${Object.keys(truncatedCandles).length}`);

    // ── Compute index data (SPY/QQQ) ──────────────────────────────────
    const indexData = {};
    for (const idx of ['SPY', 'QQQ']) {
      const daily = truncatedCandles[idx];
      if (!daily) continue;
      const weekly = aggregateWeeklyFromAsc(daily);
      if (weekly.length < 30) continue;
      const ema21 = computeEMA21series(weekly);
      const li = weekly.length - 1;
      if (ema21[li] == null || ema21[li - 1] == null) continue;
      const emaSlope = (ema21[li] - ema21[li - 1]) / ema21[li - 1] * 100;
      indexData[idx] = {
        price: weekly[li].close,
        ema21: ema21[li],
        emaSlope,
        aboveEma: weekly[li].close > ema21[li],
        emaRising: ema21[li] > ema21[li - 1],
      };
    }

    // ── Compute sector data ───────────────────────────────────────────
    const sectorData = {};
    for (const etf of ALL_SECTOR_ETFS) {
      const daily = truncatedCandles[etf];
      if (!daily) continue;
      const weekly = aggregateWeeklyFromAsc(daily);
      const n = weekly.length;
      const return5D = n >= 2 ? (weekly[n - 1].close - weekly[n - 2].close) / weekly[n - 2].close * 100 : 0;
      const return1M = n >= 5 ? (weekly[n - 1].close - weekly[n - 5].close) / weekly[n - 5].close * 100 : 0;
      sectorData[etf] = { return5D, return1M };
    }

    // ── Run signal detection on all tickers ───────────────────────────
    const signals = {}; // ticker → signal result
    let blCount = 0, ssCount = 0, newBlCount = 0, newSsCount = 0;

    for (const ticker of Object.keys(truncatedCandles)) {
      if (ALL_SECTOR_ETFS.includes(ticker) || ticker === 'SPY' || ticker === 'QQQ') continue;
      const daily = truncatedCandles[ticker];
      const weekly = aggregateWeeklyFromAsc(daily);
      if (weekly.length < 25) continue;

      const meta = stockMeta[ticker] || {};
      const emaPeriod = getSectorEmaPeriod(meta.sector);
      const result = runStateMachine(weekly, false, emaPeriod);

      if (result.signal === 'BL' || result.signal === 'SS') {
        const signalAge = computeSignalAge(result.signalDate, targetMonday);
        if (signalAge <= 12) {
          signals[ticker] = { ...result, signalAge, isNewSignal: result.isNew ?? false };
          if (result.signal === 'BL') { blCount++; if (result.isNew) newBlCount++; }
          if (result.signal === 'SS') { ssCount++; if (result.isNew) newSsCount++; }
        }
      }
    }

    const signalCounts = { blCount, ssCount, newBlCount, newSsCount };
    console.log(`  Signals: ${blCount} BL (${newBlCount} new), ${ssCount} SS (${newSsCount} new)`);

    // ── Compute YTD rankings ──────────────────────────────────────────
    // YTD return = close on friday vs close on last trading day of 2025
    const rankings = [];
    for (const ticker of Object.keys(truncatedCandles)) {
      if (ALL_SECTOR_ETFS.includes(ticker) || ticker === 'SPY' || ticker === 'QQQ') continue;
      const daily = truncatedCandles[ticker];
      const lastBar = daily[daily.length - 1];
      // Find Dec 31 2025 close (or nearest prior trading day)
      const eoyBars = daily.filter(b => b.date <= '2025-12-31');
      if (eoyBars.length === 0) continue;
      const eoyClose = eoyBars[eoyBars.length - 1].close;
      if (eoyClose <= 0) continue;
      const ytdReturn = ((lastBar.close - eoyClose) / eoyClose) * 100;
      rankings.push({ ticker, ytdReturn, currentPrice: lastBar.close });
    }
    rankings.sort((a, b) => b.ytdReturn - a.ytdReturn);

    // Assign rank and compute rankChange
    const currentRankings = {};
    rankings.forEach((r, i) => {
      const rank = i + 1;
      const prevRank = prevRankings[r.ticker];
      const rankChange = prevRank != null ? prevRank - rank : null;
      currentRankings[r.ticker] = { rank, rankChange, ytdReturn: r.ytdReturn, currentPrice: r.currentPrice };
    });

    // ── Score all signaled stocks ─────────────────────────────────────
    const scored = [];

    for (const [ticker, sig] of Object.entries(signals)) {
      const daily = truncatedCandles[ticker];
      const weekly = aggregateWeeklyFromAsc(daily);
      if (weekly.length < 30) continue;

      const ema21 = computeEMA21series(weekly);
      const rsi = computeRSI14(weekly);
      const obv = computeOBV(weekly);
      const adx = computeADX14(weekly);

      const meta = stockMeta[ticker] || {};
      const rankInfo = currentRankings[ticker] || {};
      const curRankChange = rankInfo.rankChange ?? null;
      const prevWeekRankChange = prevRankChanges[ticker] ?? null;

      const d1 = calcD1(sig.signal, meta.exchange, indexData, signalCounts);
      const d2 = scoreD2(sig.signal, meta.sector, sig.isNewSignal, sectorData);
      const d3 = scoreD3(sig.signal, weekly, ema21);

      if (d3.overextended) {
        scored.push({
          ticker, signal: sig.signal, apexScore: -99, overextended: true,
          tier: 'OVEREXTENDED', confirmation: 'OVEREXTENDED',
          sector: meta.sector || '', exchange: meta.exchange || '',
          currentPrice: rankInfo.currentPrice || weekly[weekly.length - 1].close,
          stopPrice: sig.stopPrice ?? null, signalDate: sig.signalDate,
          signalAge: sig.signalAge, entryRank: null,
          scores: { d1: d1.score, d2: d2.score, d3: d3.score, d4: 0, d5: 0, d6: 0, d7: 0, d8: 0 },
        });
        continue;
      }

      const d4 = scoreD4(sig.signalAge, d3.confirmation);
      const d5 = scoreD5(curRankChange);
      const d6 = scoreD6(sig.signal, weekly, rsi, obv, adx);
      const d7 = scoreD7(curRankChange, prevWeekRankChange);
      // D8: 0 for backfill (Prey data not available historically — max 6pts of ~100+)
      const d8 = { score: 0 };

      const preMultiplier = d2.score + d3.score + d4.score + d5.score + d6.score + d7.score + d8.score;
      const total = Math.round(preMultiplier * d1.score * 10) / 10;
      const tierDef = getTier(total);

      scored.push({
        ticker, signal: sig.signal, apexScore: total, overextended: false,
        tier: tierDef.name, confirmation: d3.confirmation,
        sector: meta.sector || '', exchange: meta.exchange || '',
        currentPrice: rankInfo.currentPrice || weekly[weekly.length - 1].close,
        stopPrice: sig.stopPrice ?? sig.pnthrStop ?? null,
        signalDate: sig.signalDate, signalAge: sig.signalAge,
        preMultiplier: Math.round(preMultiplier * 10) / 10,
        weeklyRsi: d6.curRsi ?? null,
        scores: { d1: d1.score, d2: d2.score, d3: d3.score, d4: d4.score, d5: d5.score, d6: d6.score, d7: d7.score, d8: d8.score },
      });
    }

    // Sort and rank
    scored.sort((a, b) => {
      if (a.overextended && !b.overextended) return 1;
      if (!a.overextended && b.overextended) return -1;
      if (b.apexScore !== a.apexScore) return b.apexScore - a.apexScore;
      const aRsi = a.weeklyRsi, bRsi = b.weeklyRsi;
      if (aRsi != null && bRsi != null) {
        const aRoom = a.signal === 'BL' ? (75 - aRsi) : (aRsi - 25);
        const bRoom = b.signal === 'BL' ? (75 - bRsi) : (bRsi - 25);
        if (aRoom !== bRoom) return bRoom - aRoom;
      }
      return 0;
    });

    let rankCounter = 0;
    scored.forEach(s => {
      if (s.overextended) { s.killRank = null; }
      else { rankCounter++; s.killRank = rankCounter; }
    });

    const top10 = scored.filter(s => s.killRank != null && s.killRank <= 10);
    console.log(`  Scored: ${scored.length} | Top 10:`);
    for (const s of top10) {
      console.log(`    #${s.killRank} ${s.ticker.padEnd(6)} ${s.signal} ${s.apexScore.toFixed(1).padStart(7)} ${s.tier} | D1=${s.scores.d1} D3=${s.scores.d3}`);
    }

    // Build price map for exit price lookups
    const priceMap = {};
    for (const r of rankings) priceMap[r.ticker] = r.currentPrice;

    allWeeklyResults[friday] = { top10, scored, signals, priceMap, signalCounts, indexData };

    // Save rankings for next week's D5/D7
    prevRankChanges = {};
    prevRankings = {};
    for (const [ticker, info] of Object.entries(currentRankings)) {
      prevRankings[ticker] = info.rank;
      if (info.rankChange != null) prevRankChanges[ticker] = info.rankChange;
    }
  }

  // ── 5. Build case studies ───────────────────────────────────────────────
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  Building Case Studies');
  console.log(`${'═'.repeat(70)}\n`);

  // Clear existing backfilled entries (keep live entries from source=FRIDAY_PIPELINE)
  if (!DRY_RUN) {
    const deleteResult = await db.collection('pnthr_kill_case_studies')
      .deleteMany({ entrySource: 'HISTORICAL_BACKFILL' });
    console.log(`  Cleared ${deleteResult.deletedCount} previous backfill entries`);
  }

  const caseStudies = [];  // { ticker, entryDate, ... }
  const activeCases = {};  // ticker → case study object (for tracking exits)

  for (const friday of fridays) {
    const { top10, scored, signals, priceMap } = allWeeklyResults[friday];
    const scoredMap = {};
    for (const s of scored) scoredMap[s.ticker] = s;

    // ── Check exits for active case studies ───────────────────────────
    for (const [ticker, cs] of Object.entries(activeCases)) {
      const s = scoredMap[ticker];
      const currentPrice = s?.currentPrice ?? priceMap[ticker] ?? cs.entryPrice;
      const isShort = cs.direction === 'SHORT';
      const pnlPct = isShort
        ? ((cs.entryPrice - currentPrice) / cs.entryPrice) * 100
        : ((currentPrice - cs.entryPrice) / cs.entryPrice) * 100;

      // Check OVEREXTENDED
      if (s?.overextended) {
        cs.status = 'CLOSED';
        cs.exitDate = friday;
        cs.exitPrice = currentPrice;
        cs.exitReason = 'OVEREXTENDED';
        cs.pnlPct = +pnlPct.toFixed(2);
        cs.pnlDollar = +(pnlPct / 100 * 10000).toFixed(2);
        delete activeCases[ticker];
        continue;
      }

      // Check BE/SE from signal state
      // If stock no longer has its entry signal (BL lost for LONG, SS lost for SHORT),
      // that means a BE/SE exit occurred
      const currentSig = signals[ticker];
      if (!currentSig) {
        // No active signal at all — exit happened
        cs.status = 'CLOSED';
        cs.exitDate = friday;
        cs.exitPrice = currentPrice;
        cs.exitReason = isShort ? 'SE' : 'BE';
        cs.pnlPct = +pnlPct.toFixed(2);
        cs.pnlDollar = +(pnlPct / 100 * 10000).toFixed(2);
        delete activeCases[ticker];
        continue;
      } else if ((isShort && currentSig.signal === 'BL') || (!isShort && currentSig.signal === 'SS')) {
        // Signal flipped to opposite direction — exit
        cs.status = 'CLOSED';
        cs.exitDate = friday;
        cs.exitPrice = currentPrice;
        cs.exitReason = isShort ? 'SE' : 'BE';
        cs.pnlPct = +pnlPct.toFixed(2);
        cs.pnlDollar = +(pnlPct / 100 * 10000).toFixed(2);
        delete activeCases[ticker];
        continue;
      }

      // Update weekly snapshot
      cs.weeklySnapshots.push({
        date: friday,
        price: currentPrice,
        pnlPct: +pnlPct.toFixed(2),
        killRank: s?.killRank ?? null,
        killScore: s?.apexScore ?? null,
      });
      cs.holdingWeeks = cs.weeklySnapshots.length;
      cs.maxFavorable = +(Math.max(cs.maxFavorable, pnlPct > 0 ? pnlPct : 0)).toFixed(2);
      cs.maxAdverse = +(Math.min(cs.maxAdverse, pnlPct < 0 ? pnlPct : 0)).toFixed(2);
    }

    // ── Check for new entries from top 10 ─────────────────────────────
    for (const stock of top10) {
      if (activeCases[stock.ticker]) continue; // Already tracking

      // 2-week cooldown check
      const recentlyClosedCase = caseStudies.find(cs =>
        cs.ticker === stock.ticker &&
        cs.status === 'CLOSED' &&
        cs.exitDate &&
        daysBetween(cs.exitDate, friday) < 14
      );
      if (recentlyClosedCase) continue;

      const entry = {
        id: `${stock.ticker}-${friday}`,
        ticker: stock.ticker,
        direction: stock.signal === 'SS' ? 'SHORT' : 'LONG',
        sector: stock.sector || '—',
        entryDate: friday,
        entryPrice: stock.currentPrice || 0,
        entryRank: stock.killRank,
        entryScore: stock.apexScore ?? 0,
        entryTier: stock.tier,
        entryConfirmation: stock.confirmation || null,
        entrySource: 'HISTORICAL_BACKFILL',
        stopPrice: stock.stopPrice ?? null,
        status: 'ACTIVE',
        exitDate: null,
        exitPrice: null,
        exitReason: null,
        pnlPct: null,
        pnlDollar: null,
        holdingWeeks: 0,
        maxFavorable: 0,
        maxAdverse: 0,
        weeklySnapshots: [],
        createdAt: new Date(),
      };

      activeCases[stock.ticker] = entry;
      caseStudies.push(entry);
    }
  }

  // ── Close remaining active cases with latest data ───────────────────
  // (They remain ACTIVE — the pyramid simulation will use latest candle data)

  // ── 6. Write to database ────────────────────────────────────────────────
  const closedCount = caseStudies.filter(cs => cs.status === 'CLOSED').length;
  const activeCount = caseStudies.filter(cs => cs.status === 'ACTIVE').length;
  console.log(`\n  Total case studies: ${caseStudies.length} (${closedCount} closed, ${activeCount} active)`);

  if (!DRY_RUN && caseStudies.length > 0) {
    // Insert backfilled case studies
    const col = db.collection('pnthr_kill_case_studies');
    for (const cs of caseStudies) {
      try {
        await col.insertOne(cs);
      } catch (err) {
        if (err.code === 11000) {
          console.warn(`  Duplicate: ${cs.id} — skipping`);
        } else throw err;
      }
    }
    console.log(`  ✓ Inserted ${caseStudies.length} backfilled case studies`);

    // Also save weekly scores to pnthr_kill_scores for reference
    let scoreCount = 0;
    for (const [weekOf, data] of Object.entries(allWeeklyResults)) {
      // Only save weeks that don't already exist
      const existing = await db.collection('pnthr_kill_scores').countDocuments({ weekOf });
      if (existing > 0) {
        console.log(`  Skipping pnthr_kill_scores for ${weekOf} (${existing} docs exist)`);
        continue;
      }
      const scoreDocs = data.scored.filter(s => !s.overextended).slice(0, 50).map((s, i) => ({
        weekOf,
        killRank: s.killRank,
        ticker: s.ticker,
        signal: s.signal,
        signalAge: s.signalAge,
        totalScore: s.apexScore,
        tier: s.tier,
        confirmation: s.confirmation,
        preMultiplier: s.preMultiplier,
        dimensions: s.scores,
        sector: s.sector,
        exchange: s.exchange,
        currentPrice: s.currentPrice,
        createdAt: new Date(),
      }));
      if (scoreDocs.length > 0) {
        await db.collection('pnthr_kill_scores').insertMany(scoreDocs);
        scoreCount += scoreDocs.length;
      }
    }
    console.log(`  ✓ Inserted ${scoreCount} score records across new weeks`);
  } else {
    console.log('  [DRY RUN] No database writes performed');
  }

  // Print summary
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  BACKFILL COMPLETE');
  console.log(`${'═'.repeat(70)}`);
  console.log(`  Fridays processed: ${fridays.length}`);
  console.log(`  Case studies created: ${caseStudies.length}`);
  console.log(`  Closed: ${closedCount} | Active: ${activeCount}`);
  console.log();

  // Print all entries
  for (const cs of caseStudies) {
    const status = cs.status === 'CLOSED'
      ? `CLOSED ${cs.exitReason} ${cs.pnlPct >= 0 ? '+' : ''}${cs.pnlPct?.toFixed(1)}%`
      : 'ACTIVE';
    console.log(`  ${cs.entryDate} #${String(cs.entryRank).padStart(2)} ${cs.ticker.padEnd(6)} ${cs.direction.padEnd(5)} $${cs.entryPrice.toFixed(2).padStart(8)} ${cs.entryTier.padEnd(16)} ${status}`);
  }

  process.exit(0);
}

function daysBetween(date1, date2) {
  const d1 = new Date(date1 + 'T12:00:00');
  const d2 = new Date(date2 + 'T12:00:00');
  return Math.abs((d2 - d1) / (24 * 60 * 60 * 1000));
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
