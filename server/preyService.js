// server/preyService.js
// ── PNTHR PREY Scanner ─ Phase 3 ──────────────────────────────────────────────
//
// Three strategies:
//   Alphas  — Elite Alpha Longs (Rule Set 1) + Elite Alpha Shorts (Rule Set 2)
//   Springs — PNTHR Spring Longs (Rule Set 3) + PNTHR Spring Shorts (Rule Set 4)
//   Dinner  — BL+1 and SS+1 from existing PNTHR state machine (all 679)
//
// Cached weekly (invalidates at Friday boundary).
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config();
import { runStateMachine } from './signalService.js';

const FMP_API_KEY   = process.env.FMP_API_KEY;
const FMP_BASE_URL  = 'https://financialmodelingprep.com/api/v3';

// Weekly cache
let preyCache = { weekKey: null, results: null };

// ── Sector ETFs ───────────────────────────────────────────────────────────────

const SECTOR_ETFS = ['XLK', 'XLE', 'XLV', 'XLF', 'XLY', 'XLC', 'XLI', 'XLB', 'XLRE', 'XLU', 'XLP'];

const SECTOR_MAP = {
  'Technology':             'XLK',
  'Energy':                 'XLE',
  'Healthcare':             'XLV',
  'Health Care':            'XLV',
  'Financial Services':     'XLF',
  'Financials':             'XLF',
  'Consumer Cyclical':      'XLY',
  'Consumer Discretionary': 'XLY',
  'Communication Services': 'XLC',
  'Industrials':            'XLI',
  'Basic Materials':        'XLB',
  'Materials':              'XLB',
  'Real Estate':            'XLRE',
  'Utilities':              'XLU',
  'Consumer Defensive':     'XLP',
  'Consumer Staples':       'XLP',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getLastFriday() {
  const today = new Date();
  const dow = today.getDay();
  const daysBack = dow === 5 ? 0 : (dow + 2) % 7;
  const d = new Date(today);
  d.setDate(today.getDate() - daysBack);
  return d.toISOString().split('T')[0];
}

async function fetchDailyBars(ticker, from, to) {
  const url = `${FMP_BASE_URL}/historical-price-full/${ticker}?from=${from}&to=${to}&apikey=${FMP_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP ${res.status} for ${ticker}`);
  const data = await res.json();
  return data?.historical || [];
}

// Aggregate daily bars (FMP descending) → weekly bars ascending, including volume
function aggregateWeeklyBars(daily) {
  const weekMap = {};
  for (const bar of daily) {
    const date = new Date(bar.date + 'T12:00:00');
    const dow  = date.getDay();
    const daysToMonday = dow === 0 ? -6 : 1 - dow;
    const monday = new Date(date);
    monday.setDate(date.getDate() + daysToMonday);
    const key = monday.toISOString().split('T')[0];
    if (!weekMap[key]) {
      weekMap[key] = { weekStart: key, open: null, high: -Infinity, low: Infinity, close: null, volume: 0 };
    }
    const w = weekMap[key];
    w.high   = Math.max(w.high, bar.high);
    w.low    = Math.min(w.low,  bar.low);
    if (w.close === null) w.close = bar.close; // first-seen = Friday close
    w.open   = bar.open;                        // last-seen  = Monday open
    w.volume += (bar.volume || 0);
  }
  return Object.values(weekMap).sort((a, b) => a.weekStart > b.weekStart ? 1 : -1);
}

// ── Indicator Computations ────────────────────────────────────────────────────

function computeEMA21(weeklyBars) {
  const closes = weeklyBars.map(b => b.close);
  const n = closes.length;
  const ema = new Array(n).fill(null);
  if (n < 21) return ema;
  let sum = 0;
  for (let i = 0; i < 21; i++) sum += closes[i];
  ema[20] = sum / 21;
  const k = 2 / 22;
  for (let i = 21; i < n; i++) ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  return ema;
}

function computeOBV(weeklyBars) {
  const n = weeklyBars.length;
  const obv = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    if (weeklyBars[i].close > weeklyBars[i - 1].close)      obv[i] = obv[i-1] + weeklyBars[i].volume;
    else if (weeklyBars[i].close < weeklyBars[i - 1].close) obv[i] = obv[i-1] - weeklyBars[i].volume;
    else                                                      obv[i] = obv[i-1];
  }
  return obv;
}

function computeRSI14(weeklyBars) {
  const closes = weeklyBars.map(b => b.close);
  const n = closes.length;
  const rsi = new Array(n).fill(null);
  if (n < 15) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= 14; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
  }
  avgGain /= 14; avgLoss /= 14;
  rsi[14] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = 15; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * 13 + Math.max(d, 0))  / 14;
    avgLoss = (avgLoss * 13 + Math.max(-d, 0)) / 14;
    rsi[i]  = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function computeADX14(weeklyBars) {
  const n = weeklyBars.length;
  const adxArr = new Array(n).fill(null);
  if (n < 30) return adxArr;

  const trs = [], plusDMs = [], minusDMs = [];
  for (let i = 1; i < n; i++) {
    const cur = weeklyBars[i], prev = weeklyBars[i - 1];
    trs.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close)));
    const up = cur.high - prev.high, dn = prev.low - cur.low;
    plusDMs.push(up > dn && up > 0 ? up : 0);
    minusDMs.push(dn > up && dn > 0 ? dn : 0);
  }

  // Wilder smooth TR, +DM, -DM over 14
  let smTR  = trs.slice(0, 14).reduce((a, b) => a + b, 0);
  let smPDM = plusDMs.slice(0, 14).reduce((a, b) => a + b, 0);
  let smMDM = minusDMs.slice(0, 14).reduce((a, b) => a + b, 0);

  const dxArr = [];
  for (let i = 14; i < trs.length; i++) {
    smTR  = smTR  - smTR  / 14 + trs[i];
    smPDM = smPDM - smPDM / 14 + plusDMs[i];
    smMDM = smMDM - smMDM / 14 + minusDMs[i];
    const pdi = smTR === 0 ? 0 : (smPDM / smTR) * 100;
    const mdi = smTR === 0 ? 0 : (smMDM / smTR) * 100;
    const sum = pdi + mdi;
    dxArr.push(sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100);
  }

  if (dxArr.length < 14) return adxArr;
  let adx = dxArr.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
  const base = 28; // bar index where ADX first valid
  adxArr[base] = adx;
  for (let i = 14; i < dxArr.length; i++) {
    adx = (adx * 13 + dxArr[i]) / 14;
    adxArr[base + (i - 13)] = adx;
  }
  return adxArr;
}

// Aggregate weekly bars → monthly (last weekly close of each calendar month)
// Returns { months, closes, ema } arrays
function computeMonthlyEMA21(weeklyBars) {
  const monthMap = {};
  for (const bar of weeklyBars) {
    const month = bar.weekStart.slice(0, 7); // YYYY-MM
    monthMap[month] = bar.close;             // later assignment wins = latest week = month-end
  }
  const months  = Object.keys(monthMap).sort();
  const closes  = months.map(m => monthMap[m]);
  const n       = closes.length;
  const ema     = new Array(n).fill(null);
  if (n < 21) return { months, closes, ema };
  let sum = 0;
  for (let i = 0; i < 21; i++) sum += closes[i];
  ema[20] = sum / 21;
  const k = 2 / 22;
  for (let i = 21; i < n; i++) ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  return { months, closes, ema };
}

// ── Data Fetcher ──────────────────────────────────────────────────────────────

async function fetchStockData(ticker) {
  try {
    const today = new Date();
    const from  = new Date(today);
    from.setFullYear(today.getFullYear() - 3);
    const daily = await fetchDailyBars(ticker, from.toISOString().split('T')[0], today.toISOString().split('T')[0]);
    if (!daily || daily.length < 40) return null;

    const dailyAsc = [...daily].sort((a, b) => a.date > b.date ? 1 : -1);
    const weekly   = aggregateWeeklyBars(daily);
    if (weekly.length < 30) return null;

    const ema21      = computeEMA21(weekly);
    const obv        = computeOBV(weekly);
    const rsi        = computeRSI14(weekly);
    const adx        = computeADX14(weekly);
    const monthlyData = computeMonthlyEMA21(weekly);

    // 5-day and 20-day average volume from most recent daily bars
    const recent = dailyAsc.slice(-25);
    const vol5   = recent.slice(-5).reduce((s, b)  => s + (b.volume || 0), 0) / 5;
    const vol20  = recent.slice(-20).reduce((s, b) => s + (b.volume || 0), 0) / 20;

    return { weekly, ema21, obv, rsi, adx, monthlyData, vol5, vol20 };
  } catch {
    return null;
  }
}

// ── Sector Sentinel ───────────────────────────────────────────────────────────

async function runSectorSentinel() {
  const status = {}, fourWeekReturns = {};
  await Promise.all(SECTOR_ETFS.map(async etf => {
    try {
      const data = await fetchStockData(etf);
      if (!data) return;
      const { weekly, ema21 } = data;
      const n = weekly.length;
      const lastEma = ema21[n - 1];
      if (lastEma == null) return;
      status[etf] = weekly[n - 1].close > lastEma ? 'above' : 'below';
      if (n >= 5) fourWeekReturns[etf] = (weekly[n-1].close - weekly[n-5].close) / weekly[n-5].close;
    } catch { /* skip */ }
  }));
  return { status, fourWeekReturns };
}

// ── Rule Set 1: Elite Alpha Long ──────────────────────────────────────────────

function runAlphaLong(ticker, sector, data, sectorStatus, sectorFW) {
  const { weekly, ema21, obv, rsi, adx, vol5, vol20 } = data;
  const n = weekly.length;
  if (n < 30) return null;

  const li = n - 1;
  const lastEma = ema21[li], prevEma = ema21[li - 1];
  if (lastEma == null || prevEma == null) return null;

  const cur = weekly[li], prev = weekly[li - 1];

  // Sector sentinel — stock sector must be in uptrend
  const etf = SECTOR_MAP[sector];
  if (!etf || sectorStatus[etf] !== 'above') return null;

  // Price delta +1% to +10% above EMA
  const delta = (cur.close - lastEma) / lastEma;
  if (delta < 0.01 || delta > 0.10) return null;

  // EMA slope positive
  if (lastEma <= prevEma) return null;

  // Daylight: low of current AND previous week > their respective EMAs
  if (cur.low <= lastEma || prev.low <= prevEma) return null;

  // Maturity: 3-8 consecutive bars above EMA
  let barsAbove = 0;
  for (let i = li; i >= 0 && ema21[i] != null; i--) {
    if (weekly[i].close > ema21[i]) barsAbove++; else break;
  }
  if (barsAbove < 3 || barsAbove > 8) return null;

  // OBV 5-period slope positive
  if (li < 5 || obv[li] <= obv[li - 5]) return null;

  // Volume pulse: 5-day > 20-day
  if (vol5 <= vol20) return null;

  // Live trigger: current week low > previous week low
  if (cur.low <= prev.low) return null;

  // ADX(14) > 20 and rising
  const curAdx = adx[li], prevAdx = adx[li - 1];
  if (curAdx == null || curAdx <= 20 || prevAdx == null || curAdx <= prevAdx) return null;

  // RSI 55–70 (>70 = overextended, disqualify)
  const curRsi = rsi[li];
  if (curRsi == null || curRsi < 55 || curRsi > 70) return null;

  // Sector alpha: stock 4-week > sector 4-week
  const stock4w  = n >= 5 ? (cur.close - weekly[n-5].close) / weekly[n-5].close : null;
  const sector4w = sectorFW[etf];
  if (stock4w == null || sector4w == null || stock4w <= sector4w) return null;

  return {
    ticker, strategy: 'Alpha Long', direction: 'long',
    barNumber: barsAbove, currentPrice: cur.close, ema21: +lastEma.toFixed(2),
    priceDeltaPct: +(delta * 100).toFixed(2),
    rsi: +curRsi.toFixed(1), adx: +curAdx.toFixed(1),
    obvSlope: 'positive', daylight: 'confirmed',
    stock4wPct: +(stock4w * 100).toFixed(2), sector4wPct: +(sector4w * 100).toFixed(2), sectorEtf: etf,
  };
}

// ── Rule Set 2: Elite Alpha Short ─────────────────────────────────────────────

function runAlphaShort(ticker, sector, data, sectorStatus, sectorFW) {
  const { weekly, ema21, obv, rsi, adx, vol5, vol20 } = data;
  const n = weekly.length;
  if (n < 30) return null;

  const li = n - 1;
  const lastEma = ema21[li], prevEma = ema21[li - 1];
  if (lastEma == null || prevEma == null) return null;

  const cur = weekly[li], prev = weekly[li - 1];

  const etf = SECTOR_MAP[sector];
  if (!etf || sectorStatus[etf] !== 'below') return null;

  // Price delta 1%–10% below EMA
  const delta = (lastEma - cur.close) / lastEma;
  if (delta < 0.01 || delta > 0.10) return null;

  // EMA slope negative
  if (lastEma >= prevEma) return null;

  // Bearish daylight: high of current AND previous week < their EMAs
  if (cur.high >= lastEma || prev.high >= prevEma) return null;

  // Breakdown window: 1–5 bars below EMA
  let barsBelow = 0;
  for (let i = li; i >= 0 && ema21[i] != null; i--) {
    if (weekly[i].close < ema21[i]) barsBelow++; else break;
  }
  if (barsBelow < 1 || barsBelow > 5) return null;

  // Roll-over trigger: current high < previous high
  if (cur.high >= prev.high) return null;

  // OBV 5-period slope negative
  if (li < 5 || obv[li] >= obv[li - 5]) return null;

  // ADX > 20 and rising
  const curAdx = adx[li], prevAdx = adx[li - 1];
  if (curAdx == null || curAdx <= 20 || prevAdx == null || curAdx <= prevAdx) return null;

  // RSI < 50
  const curRsi = rsi[li];
  if (curRsi == null || curRsi >= 50) return null;

  // Oversold buffer: RSI < 30 → must be within 3% of EMA
  if (curRsi < 30 && delta > 0.03) return null;

  // Negative sector alpha: stock 4-week < sector 4-week
  const stock4w  = n >= 5 ? (cur.close - weekly[n-5].close) / weekly[n-5].close : null;
  const sector4w = sectorFW[etf];
  if (stock4w == null || sector4w == null || stock4w >= sector4w) return null;

  return {
    ticker, strategy: 'Alpha Short', direction: 'short',
    barNumber: barsBelow, currentPrice: cur.close, ema21: +lastEma.toFixed(2),
    priceDeltaPct: +(delta * 100).toFixed(2),
    rsi: +curRsi.toFixed(1), adx: +curAdx.toFixed(1),
    obvSlope: 'negative', daylight: 'confirmed',
    stock4wPct: +(stock4w * 100).toFixed(2), sector4wPct: +(sector4w * 100).toFixed(2), sectorEtf: etf,
  };
}

// ── Rule Set 3: PNTHR Spring Long ─────────────────────────────────────────────

function runSpringLong(ticker, data) {
  const { weekly, ema21, obv, monthlyData } = data;
  const n = weekly.length;
  if (n < 60) return null;

  const li = n - 1;
  const lastEma = ema21[li];
  if (lastEma == null) return null;
  const cur = weekly[li];

  // Step 0: 21-EMA slope positive over 52 weeks
  const ema52 = ema21[li - 52];
  if (ema52 == null || lastEma <= ema52) return null;

  // Step 1: ≥32 of last 52 weeks closed above EMA
  let weeksAbove = 0;
  for (let i = li - 51; i <= li; i++) {
    if (ema21[i] != null && weekly[i].close > ema21[i]) weeksAbove++;
  }
  if (weeksAbove < 32) return null;

  // Step 1b: last 3 months above monthly 21-EMA
  const { closes: mC, ema: mE } = monthlyData;
  if (!mE || mE.length < 3) return null;
  const ml = mE.length;
  for (let i = ml - 3; i < ml; i++) {
    if (mE[i] == null || mC[i] <= mE[i]) return null;
  }

  // Step 2: weekly low touched/pierced EMA in T-3 to T-7, closed above
  let touchBar = -1;
  for (let t = 3; t <= 7; t++) {
    const idx = li - t;
    if (idx < 0 || ema21[idx] == null) continue;
    if (weekly[idx].low <= ema21[idx] && weekly[idx].close > ema21[idx]) { touchBar = t; break; }
  }
  if (touchBar === -1) return null;

  // Step 3: Recency lock — T-2 low <= EMA (fresh daylight check)
  const t2 = li - 2;
  if (t2 < 0 || ema21[t2] == null || weekly[t2].low > ema21[t2]) return null;

  // Step 4: Daylight — lowest low 1%–10% above EMA (T-0 or T-1)
  const daylight0 = (cur.low / lastEma) - 1;
  let daylightOk = daylight0 >= 0.01 && daylight0 <= 0.10;
  if (!daylightOk) {
    const t1e = ema21[li - 1];
    if (t1e != null) {
      const d1 = (weekly[li-1].low / t1e) - 1;
      daylightOk = d1 >= 0.01 && d1 <= 0.10;
    }
  }
  if (!daylightOk) return null;

  // Step 5: Price > weekly open AND OBV positive slope
  if (cur.close <= cur.open) return null;
  if (li < 5 || obv[li] <= obv[li - 5]) return null;

  const delta = (cur.close - lastEma) / lastEma;
  return {
    ticker, strategy: 'Spring Long', direction: 'long',
    touchBar, weeksAbove52: weeksAbove,
    currentPrice: cur.close, ema21: +lastEma.toFixed(2),
    priceDeltaPct: +(delta * 100).toFixed(2),
    obvSlope: 'positive', daylight: 'confirmed',
  };
}

// ── Rule Set 4: PNTHR Spring Short ────────────────────────────────────────────

function runSpringShort(ticker, data) {
  const { weekly, ema21, obv, monthlyData } = data;
  const n = weekly.length;
  if (n < 60) return null;

  const li = n - 1;
  const lastEma = ema21[li];
  if (lastEma == null) return null;
  const cur = weekly[li];

  // Step 0: 21-EMA slope negative over 52 weeks
  const ema52 = ema21[li - 52];
  if (ema52 == null || lastEma >= ema52) return null;

  // Step 1: ≥32 of last 52 weeks closed below EMA
  let weeksBelow = 0;
  for (let i = li - 51; i <= li; i++) {
    if (ema21[i] != null && weekly[i].close < ema21[i]) weeksBelow++;
  }
  if (weeksBelow < 32) return null;

  // Step 1b: last 3 months below monthly 21-EMA
  const { closes: mC, ema: mE } = monthlyData;
  if (!mE || mE.length < 3) return null;
  const ml = mE.length;
  for (let i = ml - 3; i < ml; i++) {
    if (mE[i] == null || mC[i] >= mE[i]) return null;
  }

  // Step 2: high touched/pierced EMA in T-3 to T-7, closed below
  let touchBar = -1;
  for (let t = 3; t <= 7; t++) {
    const idx = li - t;
    if (idx < 0 || ema21[idx] == null) continue;
    if (weekly[idx].high >= ema21[idx] && weekly[idx].close < ema21[idx]) { touchBar = t; break; }
  }
  if (touchBar === -1) return null;

  // Step 3: Recency lock — T-2 high >= EMA
  const t2 = li - 2;
  if (t2 < 0 || ema21[t2] == null || weekly[t2].high < ema21[t2]) return null;

  // Step 4: Highest high 1%–10% below EMA (T-0 or T-1)
  const dist0 = 1 - (cur.high / lastEma);
  let daylightOk = dist0 >= 0.01 && dist0 <= 0.10;
  if (!daylightOk) {
    const t1e = ema21[li - 1];
    if (t1e != null) {
      const d1 = 1 - (weekly[li-1].high / t1e);
      daylightOk = d1 >= 0.01 && d1 <= 0.10;
    }
  }
  if (!daylightOk) return null;

  // Step 5: Price < weekly open AND OBV negative slope
  if (cur.close >= cur.open) return null;
  if (li < 5 || obv[li] >= obv[li - 5]) return null;

  const delta = (lastEma - cur.close) / lastEma;
  return {
    ticker, strategy: 'Spring Short', direction: 'short',
    touchBar, weeksBelow52: weeksBelow,
    currentPrice: cur.close, ema21: +lastEma.toFixed(2),
    priceDeltaPct: +(delta * 100).toFixed(2),
    obvSlope: 'negative', daylight: 'confirmed',
  };
}

// ── Dinner: BL+1 / SS+1 ──────────────────────────────────────────────────────
// A stock is Dinner if the PNTHR state machine's last completed bar was bar 1
// of a BL or SS signal (i.e., 2 consecutive bars above/below EMA where bar 1
// broke the prior 2-week structural high/low).

function runDinner(ticker, data) {
  const { weekly, ema21, obv, rsi } = data;
  const n = weekly.length;
  if (n < 25) return null;

  const li      = n - 1;
  const lastEma = ema21[li];
  const prevEma = ema21[li - 1];
  if (lastEma == null || prevEma == null) return null;

  // Use the canonical PNTHR state machine to determine current signal
  const sig = runStateMachine(weekly);
  if (!sig || (sig.signal !== 'BL' && sig.signal !== 'SS')) return null;

  // Dinner = BL+1 or SS+1: signal must have fired on the previous bar (li-1)
  if (sig.signalDate !== weekly[li - 1].weekStart) return null;

  const lastRsi = rsi[li];
  const prevRsi = rsi[li - 1];
  const lastObv = obv[li];
  const prevObv = obv[li - 1];

  if (sig.signal === 'BL') {
    // Quality filters for Dinner Long:
    // 1. EMA slope rising
    if (lastEma <= prevEma) return null;
    // 2. OBV rising
    if (lastObv == null || prevObv == null || lastObv <= prevObv) return null;
    // 3. RSI rising AND has room to reach 85
    if (lastRsi == null || prevRsi == null) return null;
    if (lastRsi <= prevRsi) return null;
    if (lastRsi >= 75) return null;
    // 4. Daylight: current bar low above EMA
    if (weekly[li].low <= lastEma) return null;

    const delta = (weekly[li].close - lastEma) / lastEma;
    return {
      ticker, strategy: 'BL+1', direction: 'long',
      currentPrice: weekly[li].close,
      ema21: +lastEma.toFixed(2),
      priceDeltaPct: +(delta * 100).toFixed(2),
      rsi: +lastRsi.toFixed(1),
      obvSlope: 'rising',
    };
  }

  if (sig.signal === 'SS') {
    // Quality filters for Dinner Short:
    // 1. EMA slope falling
    if (lastEma >= prevEma) return null;
    // 2. OBV falling
    if (lastObv == null || prevObv == null || lastObv >= prevObv) return null;
    // 3. RSI falling AND has room to reach 15
    if (lastRsi == null || prevRsi == null) return null;
    if (lastRsi >= prevRsi) return null;
    if (lastRsi <= 25) return null;
    // 4. Daylight: current bar high below EMA
    if (weekly[li].high >= lastEma) return null;

    const delta = (lastEma - weekly[li].close) / lastEma;
    return {
      ticker, strategy: 'SS+1', direction: 'short',
      currentPrice: weekly[li].close,
      ema21: +lastEma.toFixed(2),
      priceDeltaPct: +(delta * 100).toFixed(2),
      rsi: +lastRsi.toFixed(1),
      obvSlope: 'falling',
    };
  }

  return null;
}

// ── Batch Processor ───────────────────────────────────────────────────────────

async function processBatch(items, fn, concurrency = 12) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const out   = await Promise.all(batch.map(fn));
    results.push(...out);
    if (i + concurrency < items.length) await new Promise(r => setTimeout(r, 150));
  }
  return results;
}

// ── Main Export ───────────────────────────────────────────────────────────────

export async function getPreyResults(tickers, stockMeta = {}) {
  const weekKey = getLastFriday();
  if (preyCache.weekKey === weekKey && preyCache.results) return preyCache.results;

  console.log(`[PREY] Starting scan of ${tickers.length} stocks + ${SECTOR_ETFS.length} sector ETFs…`);

  // 1. Sector Sentinel
  const { status: sectorStatus, fourWeekReturns: sectorFW } = await runSectorSentinel();
  console.log('[PREY] Sector sentinel complete:', sectorStatus);

  // 2. Scan all tickers
  const alphaLongs = [], alphaShorts = [], springLongs = [], springShorts = [], dinner = [];

  await processBatch(tickers, async ticker => {
    const meta   = stockMeta[ticker] || {};
    const sector = meta.sector || '';
    const data   = await fetchStockData(ticker);
    if (!data) return;

    const aL = runAlphaLong(ticker, sector, data, sectorStatus, sectorFW);
    if (aL) alphaLongs.push({ ...aL, ...meta });

    const aS = runAlphaShort(ticker, sector, data, sectorStatus, sectorFW);
    if (aS) alphaShorts.push({ ...aS, ...meta });

    const sL = runSpringLong(ticker, data);
    if (sL) springLongs.push({ ...sL, ...meta });

    const sS = runSpringShort(ticker, data);
    if (sS) springShorts.push({ ...sS, ...meta });

    const din = runDinner(ticker, data);
    if (din) dinner.push({ ...din, ...meta });
  });

  // Sort: Alphas by bar# then delta; Springs by touchBar; Dinner by delta
  alphaLongs.sort((a, b)  => a.barNumber - b.barNumber || b.priceDeltaPct - a.priceDeltaPct);
  alphaShorts.sort((a, b) => a.barNumber - b.barNumber || b.priceDeltaPct - a.priceDeltaPct);
  springLongs.sort((a, b)  => a.touchBar - b.touchBar);
  springShorts.sort((a, b) => a.touchBar - b.touchBar);
  dinner.sort((a, b) => b.priceDeltaPct - a.priceDeltaPct);

  const results = {
    alphas:  { longs: alphaLongs,  shorts: alphaShorts  },
    springs: { longs: springLongs, shorts: springShorts },
    dinner:  {
      longs:  dinner.filter(d => d.direction === 'long'),
      shorts: dinner.filter(d => d.direction === 'short'),
    },
    sectorStatus,
    scannedAt: new Date().toISOString(),
    totalScanned: tickers.length,
  };

  preyCache = { weekKey, results };
  console.log(`[PREY] Done. Alphas: ${alphaLongs.length}L/${alphaShorts.length}S  Springs: ${springLongs.length}L/${springShorts.length}S  Dinner: ${dinner.length}`);
  return results;
}

export function clearPreyCache() {
  preyCache = { weekKey: null, results: null };
}
