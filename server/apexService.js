// server/apexService.js
// ── PNTHR KILL v3 — Predatory Scoring System ──────────────────────────────────
//
// v3 Architecture — backed by 7,883 closed trades over 2 years, 530 tickers
// Core finding: entry quality (conviction + slope + separation) is the dominant
// predictor of trade success.
//
// Formula: Total = (D2 + D3 + D4 + D5 + D6 + D7 + D8) × D1
//
//   D1  Market Regime Multiplier    0.70×–1.30×  Index EMA position + signal ratio
//   D2  Sector Alignment            ±15 pts       Sector ETF returns, capped
//   D3  Entry Quality               0–85 pts      Conviction×2.5 + Slope×10 + Sep×1.5
//   D4  Signal Freshness            -15 to +10    New signal bonus / stale signal decay
//   D5  Rank Rise                   ±20 pts       Delta rank change, capped
//   D6  Momentum                    0–20 pts      RSI + OBV + ADX + Volume, floored at 0
//   D7  Rank Velocity               ±10 pts       Acceleration of rank change
//   D8  Multi-Strategy Prey         0–6 pts       SPRINT/HUNT=2 pts, others=1 pt
//
// Tiers: ≥130 ALPHA KILL · ≥100 STRIKING · ≥80 HUNTING · ≥65 POUNCING
//        ≥50 COILING · ≥35 STALKING · ≥20 TRACKING · ≥10 PROWLING
//        ≥0 STIRRING · <0 DORMANT
//
// Config: server/killScoringConfig.js — thresholds and weights
// Cached weekly — re-runs only at Friday boundary (or on ?refresh=1).
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config();

import { getMostRecentRanking, getRankingBeforeDate } from './database.js';

const FMP_API_KEY  = process.env.FMP_API_KEY;
const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';

// Weekly cache
let apexCache = { weekKey: null, results: null };

// ── Tier Definitions ──────────────────────────────────────────────────────────

export const APEX_TIERS = [
  { min: 130, max: Infinity, name: 'ALPHA PNTHR KILL', tagline: 'Jugular. Teeth in. Alpha PNTHR is Legend.' },
  { min: 100, max: 129,      name: 'STRIKING',         tagline: 'Claws out. Contact made. In the kill zone.' },
  { min: 80,  max: 99,       name: 'HUNTING',          tagline: 'Full pursuit mode. Locked and moving fast.' },
  { min: 65,  max: 79,       name: 'POUNCING',         tagline: 'The leap has begun. No turning back.' },
  { min: 50,  max: 64,       name: 'COILING',          tagline: 'Body compressed. Energy stored. About to explode.' },
  { min: 35,  max: 49,       name: 'STALKING',         tagline: 'Eyes fixed on target. Closing the distance silently.' },
  { min: 20,  max: 34,       name: 'TRACKING',         tagline: 'Scent picked up. Target identified. Moving with intent.' },
  { min: 10,  max: 19,       name: 'PROWLING',         tagline: 'Moving through the jungle. No target yet.' },
  { min: 0,   max: 9,        name: 'STIRRING',         tagline: 'Waking up. Eyes barely open.' },
  { min: -Infinity, max: -1, name: 'DORMANT',          tagline: 'Fighting the trend. Sleeping against the flow.' },
];

export function getTier(score) {
  if (score == null) return APEX_TIERS[9];
  // Tiers are ordered highest→lowest; use only t.min so fractional scores
  // (e.g. 99.8) don't fall through integer max boundaries into DORMANT.
  return APEX_TIERS.find(t => score >= t.min) ?? APEX_TIERS[9];
}

// ── Sector Map ────────────────────────────────────────────────────────────────

const SECTOR_MAP = {
  'Technology':             'XLK',
  'Energy':                 'XLE',
  'Healthcare':             'XLV',
  'Health Care':            'XLV',
  'Financial Services':     'XLF',
  'Financials':             'XLF',
  'Consumer Discretionary': 'XLY',
  'Communication Services': 'XLC',
  'Industrials':            'XLI',
  'Basic Materials':        'XLB',
  'Materials':              'XLB',
  'Real Estate':            'XLRE',
  'Utilities':              'XLU',
  'Consumer Staples':       'XLP',
};

const ALL_SECTOR_ETFS = ['XLK', 'XLE', 'XLV', 'XLF', 'XLY', 'XLC', 'XLI', 'XLB', 'XLRE', 'XLU', 'XLP'];

// ── Date Helpers ──────────────────────────────────────────────────────────────

function getLastFriday() {
  const today = new Date();
  const dow = today.getDay();
  const daysBack = dow === 5 ? 0 : (dow + 2) % 7;
  const d = new Date(today);
  d.setDate(today.getDate() - daysBack);
  return d.toISOString().split('T')[0];
}

function getCurrentWeekMonday() {
  const today = new Date();
  const dow = today.getDay();
  const daysBack = dow === 0 ? 6 : dow - 1;
  const d = new Date(today);
  d.setDate(today.getDate() - daysBack);
  return d.toISOString().split('T')[0];
}

// Compute signal age in weeks from the signal's entry date
// signalDate is "YYYY-MM-DD" (Monday of signal entry week)
// Age 0 = signal fired this week (BL+1 / SS+1)
function computeSignalAge(signalDate) {
  if (!signalDate) return 4; // default to neutral zone if unknown
  try {
    const signalMs  = new Date(signalDate + 'T12:00:00').getTime();
    const currentMs = new Date(getCurrentWeekMonday() + 'T12:00:00').getTime();
    const weeks = Math.round((currentMs - signalMs) / (7 * 24 * 60 * 60 * 1000));
    return Math.max(0, weeks);
  } catch {
    return 4;
  }
}

// ── Price Data Helpers ────────────────────────────────────────────────────────

async function fetchDailyBars(ticker, from, to) {
  const url = `${FMP_BASE_URL}/historical-price-full/${ticker}?from=${from}&to=${to}&apikey=${FMP_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP ${res.status} for ${ticker}`);
  const data = await res.json();
  return data?.historical || [];
}

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
    if (weeklyBars[i].close > weeklyBars[i - 1].close)       obv[i] = obv[i - 1] + weeklyBars[i].volume;
    else if (weeklyBars[i].close < weeklyBars[i - 1].close)  obv[i] = obv[i - 1] - weeklyBars[i].volume;
    else                                                       obv[i] = obv[i - 1];
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
  const base = 28;
  adxArr[base] = adx;
  for (let i = 14; i < dxArr.length; i++) {
    adx = (adx * 13 + dxArr[i]) / 14;
    adxArr[base + (i - 13)] = adx;
  }
  return adxArr;
}

// ── Data Fetcher ──────────────────────────────────────────────────────────────

async function fetchStockData(ticker) {
  try {
    const today = new Date();
    const from  = new Date(today);
    from.setFullYear(today.getFullYear() - 3);
    const daily = await fetchDailyBars(ticker, from.toISOString().split('T')[0], today.toISOString().split('T')[0]);
    if (!daily || daily.length < 40) return null;
    const weekly = aggregateWeeklyBars(daily);
    if (weekly.length < 30) return null;
    const ema21 = computeEMA21(weekly);
    const obv   = computeOBV(weekly);
    const rsi   = computeRSI14(weekly);
    const adx   = computeADX14(weekly);
    return { weekly, ema21, obv, rsi, adx };
  } catch {
    return null;
  }
}

// ── Index Data (D1 regime) ────────────────────────────────────────────────────
// Returns { QQQ, SPY } each with: price, ema21 value, emaSlope %, aboveEma, emaRising

async function fetchIndexData() {
  const result = {};
  for (const ticker of ['QQQ', 'SPY']) {
    try {
      const data = await fetchStockData(ticker);
      if (!data) continue;
      const { weekly, ema21 } = data;
      const n  = weekly.length;
      const li = n - 1;
      if (ema21[li] == null || ema21[li - 1] == null) continue;

      const emaSlope = (ema21[li] - ema21[li - 1]) / ema21[li - 1] * 100; // % per week
      result[ticker] = {
        price:     weekly[li].close,
        ema21:     ema21[li],
        emaSlope,
        aboveEma:  weekly[li].close > ema21[li],
        emaRising: ema21[li] > ema21[li - 1],
      };
    } catch { /* skip */ }
  }
  return result;
}

// ── Sector Data (D2) ─────────────────────────────────────────────────────────
// Returns map of ETF ticker → { return5D, return1M } in percent

async function fetchSectorData() {
  const result = {};
  await Promise.all(ALL_SECTOR_ETFS.map(async etf => {
    try {
      const data = await fetchStockData(etf);
      if (!data) return;
      const { weekly } = data;
      const n = weekly.length;
      const return5D = n >= 2
        ? (weekly[n - 1].close - weekly[n - 2].close) / weekly[n - 2].close * 100
        : 0;
      const return1M = n >= 5
        ? (weekly[n - 1].close - weekly[n - 5].close) / weekly[n - 5].close * 100
        : 0;
      result[etf] = { return5D, return1M };
    } catch { /* skip */ }
  }));
  return result;
}

// ── Prey Presence Builder (D8) ────────────────────────────────────────────────
// Returns Map<ticker, Set<strategyName>>

function buildPreyPresence(preyResults, huntTickers, stockMeta) {
  const map = new Map();

  function addStrategy(ticker, strategy) {
    if (!map.has(ticker)) map.set(ticker, new Set());
    map.get(ticker).add(strategy);
  }

  if (preyResults) {
    for (const s of (preyResults.dinner?.longs  || [])) addStrategy(s.ticker, 'Feast');
    for (const s of (preyResults.dinner?.shorts || [])) addStrategy(s.ticker, 'Feast');
    for (const s of (preyResults.alphas?.longs  || [])) addStrategy(s.ticker, 'Alpha');
    for (const s of (preyResults.alphas?.shorts || [])) addStrategy(s.ticker, 'Alpha');
    for (const s of (preyResults.springs?.longs  || [])) addStrategy(s.ticker, 'Spring');
    for (const s of (preyResults.springs?.shorts || [])) addStrategy(s.ticker, 'Spring');
    for (const s of (preyResults.sneak?.longs  || [])) addStrategy(s.ticker, 'Sneak');
    for (const s of (preyResults.sneak?.shorts || [])) addStrategy(s.ticker, 'Sneak');
  }

  for (const ticker of (huntTickers || [])) addStrategy(ticker, 'Hunt');

  // Sprint: only stocks actually on the PNTHR 100 list that rose or are new entries
  for (const [ticker, meta] of Object.entries(stockMeta)) {
    if (meta.rank != null && (meta.rankChange === null || meta.rankChange > 0)) {
      addStrategy(ticker, 'Sprint');
    }
  }

  return map;
}

function collectPreyTickers(preyResults, huntTickers, stockMeta) {
  const set = new Set();

  if (preyResults) {
    for (const s of (preyResults.dinner?.longs   || [])) set.add(s.ticker);
    for (const s of (preyResults.dinner?.shorts  || [])) set.add(s.ticker);
    for (const s of (preyResults.alphas?.longs   || [])) set.add(s.ticker);
    for (const s of (preyResults.alphas?.shorts  || [])) set.add(s.ticker);
    for (const s of (preyResults.springs?.longs  || [])) set.add(s.ticker);
    for (const s of (preyResults.springs?.shorts || [])) set.add(s.ticker);
    for (const s of (preyResults.sneak?.longs    || [])) set.add(s.ticker);
    for (const s of (preyResults.sneak?.shorts   || [])) set.add(s.ticker);
  }
  for (const t of (huntTickers || [])) set.add(t);

  // Sprint: only stocks actually on the PNTHR 100 list that rose or are new entries
  for (const [ticker, meta] of Object.entries(stockMeta)) {
    if (meta.rank != null && (meta.rankChange === null || meta.rankChange > 0)) {
      set.add(ticker);
    }
  }

  return set;
}

// ── D1: Market Regime Multiplier (0.70× to 1.30×) ────────────────────────────
// Exchange routing: Nasdaq → QQQ, NYSE/ARCA → SPY
// regimeScore (-5 to +5) → BL multiplier = 1.0 + score×0.06; SS inverted

function calcD1(signal, exchange, indexData, signalCounts) {
  const { blCount = 0, ssCount = 0, newBlCount = 0, newSsCount = 0 } = signalCounts;

  // Route to index by exchange
  const exc = (exchange || '').toUpperCase();
  const indexTicker = (exc === 'NASDAQ' || exc.includes('NASDAQ')) ? 'QQQ' : 'SPY';
  const idx = indexData[indexTicker];

  // Index EMA position + slope scoring
  let indexScore = 0;
  if (idx) {
    const aboveEma = idx.aboveEma;
    const slope    = idx.emaSlope;
    const slopeDir = slope > 0.1 ? 'rising' : slope < -0.1 ? 'falling' : 'flat';
    if (!aboveEma && slopeDir === 'falling') indexScore = -2;
    else if (!aboveEma)                      indexScore = -1;
    else if (aboveEma && slopeDir === 'rising') indexScore = 2;
    else if (aboveEma)                       indexScore = 1;
  }

  // Signal ratio scoring (higher SS:BL = more bearish)
  const openRatio = ssCount / Math.max(blCount, 1);
  const newRatio  = newSsCount / Math.max(newBlCount, 1);
  let ratioScore = 0;
  if (openRatio > 3)        ratioScore = -2;
  else if (openRatio > 2)   ratioScore = -1;
  else if (openRatio < 0.5) ratioScore =  2;
  else if (openRatio < 1)   ratioScore =  1;

  // New signal ratio gives extra weight (leading indicator)
  if (newRatio > 5)        ratioScore -= 1;
  else if (newRatio < 0.2) ratioScore += 1;

  const regimeScore = indexScore + ratioScore;

  // Map to multiplier (BL benefits from bullish; SS benefits from bearish)
  let multiplier;
  if (signal === 'BL') {
    multiplier = 1.0 + (regimeScore * 0.06);
  } else {
    multiplier = 1.0 - (regimeScore * 0.06);
  }
  const score = Math.max(0.70, Math.min(1.30, Math.round(multiplier * 100) / 100));

  return {
    score,
    regimeScore,
    indexScore,
    ratioScore,
    openRatio: Math.round(openRatio * 10) / 10,
    newRatio:  Math.round(newRatio  * 10) / 10,
    indexTicker,
  };
}

// ── D2: Sector Alignment (±15 pts, capped) ────────────────────────────────────
// Sector direction = sign(sector ETF 5D return)
// 5D: |return5D%| × newMult × direction × 2
// 1M: |return1M%| × direction

function scoreD2(signal, sector, isNewSignal, sectorData) {
  if (!signal || !sectorData) return { score: 0, aligned: null };
  const etf = SECTOR_MAP[sector];
  if (!etf || !sectorData[etf]) return { score: 0, aligned: null };
  const { return5D, return1M } = sectorData[etf];

  const sectorBullish = return5D >= 0;
  const aligned    = (signal === 'BL' && sectorBullish) || (signal === 'SS' && !sectorBullish);
  const direction  = aligned ? 1 : -1;
  const newMult    = isNewSignal ? 2 : 1;

  const score5D = Math.abs(return5D) * newMult * direction * 2;
  const score1M = Math.abs(return1M || 0) * direction;
  const raw     = score5D + score1M;
  const score   = Math.max(-15, Math.min(15, Math.round(raw * 10) / 10));

  return {
    score,
    aligned,
    score5D:   Math.round(score5D   * 10) / 10,
    score1M:   Math.round(score1M   * 10) / 10,
    return5D:  Math.round(return5D  * 10) / 10,
    return1M:  Math.round((return1M || 0) * 10) / 10,
  };
}

// ── D3: Entry Quality (0–85 pts) — THE DOMINANT DIMENSION ────────────────────
// Sub-A: Close conviction (range-normalized) = (close-low)/(high-low)*100 × 2.5 → cap 40
// Sub-B: EMA slope (signal direction only)   = |slopePct| × 10                  → cap 30
// Sub-C: EMA separation                      = |sep%| × 1.5                     → cap 15
// CONFIRMATION: ≥30=CONFIRMED, ≥15=PARTIAL, <15=UNCONFIRMED

function scoreD3(signal, data) {
  const zero = { score: 0, subA: 0, subB: 0, subC: 0, confirmation: 'UNCONFIRMED',
                 convictionPct: 0, slopePct: 0, separationPct: 0 };
  if (!signal || !data) return zero;
  const { weekly, ema21 } = data;
  const n   = weekly.length;
  const li  = n - 1;
  const ema = ema21[li];
  const emaPrev = ema21[li - 1];
  const bar = weekly[li];
  if (ema == null || !bar) return zero;

  // Sub-A: Close conviction (range-normalized)
  // v3 formula: (close-low)/(high-low)*100 — where in the week's range did price close?
  const range = bar.high - bar.low;
  let closeConvictionPct = 0;
  if (range > 0) {
    if (signal === 'BL') closeConvictionPct = (bar.close - bar.low)  / range * 100;
    else                 closeConvictionPct = (bar.high  - bar.close) / range * 100;
  }
  const subA = Math.min(Math.max(closeConvictionPct * 2.5, 0), 40);

  // Sub-B: EMA slope (% change per week, signal-direction only)
  let emaSlopePct = 0;
  if (emaPrev != null && emaPrev !== 0) {
    emaSlopePct = (ema - emaPrev) / emaPrev * 100;
  }
  let subB = 0;
  if (signal === 'BL' && emaSlopePct > 0) {
    subB = Math.min(emaSlopePct * 10, 30);
  } else if (signal === 'SS' && emaSlopePct < 0) {
    subB = Math.min(Math.abs(emaSlopePct) * 10, 30);
  }

  // Sub-C: EMA separation (how far price has moved from EMA in signal direction)
  let emaSeparationPct = 0;
  if (ema !== 0) {
    if (signal === 'BL') emaSeparationPct = (bar.low  - ema) / ema * 100;
    else                 emaSeparationPct = (ema - bar.high) / ema * 100;
  }
  const subC = Math.min(Math.max(emaSeparationPct * 1.5, 0), 15);

  const total = Math.round((subA + subB + subC) * 10) / 10;

  let confirmation;
  if (total >= 30)      confirmation = 'CONFIRMED';
  else if (total >= 15) confirmation = 'PARTIAL';
  else                  confirmation = 'UNCONFIRMED';

  return {
    score:          total,
    subA:           Math.round(subA  * 10) / 10,
    subB:           Math.round(subB  * 10) / 10,
    subC:           Math.round(subC  * 10) / 10,
    confirmation,
    convictionPct:  Math.round(closeConvictionPct  * 10) / 10,
    slopePct:       Math.round(emaSlopePct         * 10) / 10,
    separationPct:  Math.round(emaSeparationPct    * 10) / 10,
  };
}

// ── D4: Signal Freshness (-15 to +10 pts) ────────────────────────────────────
// New confirmed signals earn a bonus; stale signals decay.

function scoreD4(signalAge, d3Confirmation) {
  let score;

  if (signalAge === 0) {
    // New signal this week — gated by D3 confirmation quality
    if (d3Confirmation === 'CONFIRMED')    score = 10;
    else if (d3Confirmation === 'PARTIAL') score = 6;
    else                                   score = 3;
  } else if (signalAge === 1) {
    // One week old — still fresh, slightly discounted
    if (d3Confirmation === 'CONFIRMED')    score = 7;
    else if (d3Confirmation === 'PARTIAL') score = 4;
    else                                   score = 2;
  } else if (signalAge === 2) {
    score = 4;
  } else if (signalAge <= 5) {
    score = 0;
  } else if (signalAge <= 9) {
    // Early decay: -3 per week beyond week 5
    score = -3 * (signalAge - 5);
  } else {
    // Deep decay: -5 per week beyond week 9, floor at -15
    score = Math.max(-5 * (signalAge - 9) - 12, -15);
  }

  return { score, signalAge, gatedBy: d3Confirmation };
}

// ── D5: Rank Rise (capped ±20 pts) ────────────────────────────────────────────
// +1 pt per position risen, -1 per position fallen, capped to prevent rank
// volatility from dominating. 55% of +30 rank jumps revert the following week.

function scoreD5(rankChange) {
  if (rankChange === null || rankChange === undefined) return { score: 0, raw: 0 };
  const raw   = Number(rankChange);
  const score = Math.max(-20, Math.min(20, raw));
  return { score, raw };
}

// ── D6: Momentum (0–20 pts, floored at 0) ────────────────────────────────────
// Sub-A: RSI (±5 pts)  — centered on 50; above/below favors BL/SS
// Sub-B: OBV (±5 pts)  — buying/selling pressure confirms signal direction
// Sub-C: ADX (0–5 pts) — trend strength, only when ADX is rising
// Sub-D: Volume (0 or +5 pts) — above-average volume confirms breakout

function scoreD6(signal, data) {
  if (!signal || !data) return { score: 0, subA: 0, subB: 0, subC: 0, subD: 0 };
  const { weekly, rsi, obv, adx } = data;
  const n  = weekly.length;
  const li = n - 1;

  // Sub-A: RSI alignment (±5 pts)
  let subA = 0;
  const curRsi = rsi[li];
  if (curRsi != null) {
    if (signal === 'BL') subA = Math.min(Math.max((curRsi - 50) / 10, -5), 5);
    else                 subA = Math.min(Math.max((50 - curRsi) / 10, -5), 5);
  }

  // Sub-B: OBV week-over-week % change (±5 pts)
  let subB = 0;
  if (li >= 1 && obv[li - 1] !== 0) {
    const obvChangePct = (obv[li] - obv[li - 1]) / Math.abs(obv[li - 1]) * 100;
    const obvAligned   = signal === 'BL' ? obvChangePct : -obvChangePct;
    subB = Math.min(Math.max(obvAligned / 5, -5), 5);
  }

  // Sub-C: ADX trend strength (0–5 pts, only when ADX is rising above 15)
  let subC = 0;
  const adxCur  = adx[li];
  const adxPrev = adx[li - 1];
  if (adxCur != null && adxCur > 15 && adxPrev != null && adxCur > adxPrev) {
    subC = Math.min((adxCur - 15) / 5, 5);
  }

  // Sub-D: Volume confirmation (0 or +5 pts)
  let subD = 0;
  const lookback = Math.min(20, n - 1);
  if (lookback > 0) {
    const avgVol = weekly.slice(li - lookback, li).reduce((s, b) => s + b.volume, 0) / lookback;
    if (avgVol > 0 && weekly[li].volume / avgVol > 1.5) subD = 5;
  }

  const raw   = subA + subB + subC + subD;
  const score = Math.max(0, Math.min(20, Math.round(raw * 10) / 10));

  return {
    score,
    subA: Math.round(subA * 10) / 10,
    subB: Math.round(subB * 10) / 10,
    subC: Math.round(subC * 10) / 10,
    subD,
  };
}

// ── D7: Rank Velocity (-10 to +10 pts) ────────────────────────────────────────
// Measures the acceleration of rank change (is the stock gaining momentum?)
// velocity = currentRankChange - previousRankChange
// score = clip(round(velocity / 6), -10, +10)

function scoreD7(currentRankChange, previousRankChange) {
  if (currentRankChange === null || currentRankChange === undefined ||
      previousRankChange === null || previousRankChange === undefined) {
    return { score: 0, velocity: 0 };
  }
  const velocity = Number(currentRankChange) - Number(previousRankChange);
  const score    = Math.max(-10, Math.min(10, Math.round(velocity / 6)));
  return { score, velocity };
}

// ── D8: Multi-Strategy Prey Presence (0–6 pts) ────────────────────────────────
// SPRINT and HUNT = 2 pts each (direct trade signals)
// FEAST, ALPHA, SPRING, SNEAK = 1 pt each (supporting signals)
// Max 6 pts regardless of strategy count

function scoreD8(ticker, preyPresenceMap) {
  const strategies = preyPresenceMap.get(ticker);
  if (!strategies || strategies.size === 0) return { score: 0, strategies: [] };

  let points = 0;
  const stratSet = new Set([...strategies].map(s => s.toUpperCase()));
  if (stratSet.has('SPRINT')) points += 2;
  if (stratSet.has('HUNT'))   points += 2;
  for (const s of ['FEAST', 'ALPHA', 'SPRING', 'SNEAK']) {
    if (stratSet.has(s)) points += 1;
  }

  return { score: Math.min(points, 6), strategies: [...stratSet] };
}

// ── Batch Processor ───────────────────────────────────────────────────────────

async function processBatch(items, fn, concurrency = 10) {
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

export async function getApexResults(
  tickers,
  stockMeta        = {},
  jungleSignals    = {},
  preyResults      = null,
  huntTickers      = new Set(),
) {
  const weekKey = getLastFriday();
  if (apexCache.weekKey === weekKey && apexCache.results) return apexCache.results;

  // Build prey presence — determines the universe + D8 scores
  const preyPresenceMap = buildPreyPresence(preyResults, huntTickers, stockMeta);
  const preyTickerSet   = collectPreyTickers(preyResults, huntTickers, stockMeta);

  // Score ALL 679 tickers with open BL/SS signals.
  // Prey membership is NOT a gate — it adds D8 tiebreaker points (SPRINT/HUNT +2,
  // FEAST/ALPHA/SPRING/SNEAK +1 each). The confirmation gate (D3 conviction ≥ 30)
  // and Kill scoring naturally filter weak setups to the bottom.
  const allSignalTickers = tickers.filter(t => {
    const sig = jungleSignals[t]?.signal;
    return sig === 'BL' || sig === 'SS';
  });

  console.log(`[KILL v3] Scoring ${allSignalTickers.length} stocks with open signals (${preyTickerSet.size} in Prey universe, ${tickers.length} total 679)`);

  // Load index + sector context in parallel
  console.log('[KILL v3] Fetching index + sector data...');
  const [indexData, sectorData] = await Promise.all([
    fetchIndexData(),
    fetchSectorData(),
  ]);
  console.log(`[KILL v3] Index: ${Object.keys(indexData).join(', ')} | Sectors: ${Object.keys(sectorData).length} ETFs`);

  // Build signal counts for D1 regime (SS:BL ratio)
  const signalCounts = { blCount: 0, ssCount: 0, newBlCount: 0, newSsCount: 0 };
  for (const sig of Object.values(jungleSignals)) {
    if (sig.signal === 'BL') {
      signalCounts.blCount++;
      if (sig.isNewSignal) signalCounts.newBlCount++;
    }
    if (sig.signal === 'SS') {
      signalCounts.ssCount++;
      if (sig.isNewSignal) signalCounts.newSsCount++;
    }
  }
  console.log(`[KILL v3] Regime counts — BL: ${signalCounts.blCount} (new: ${signalCounts.newBlCount}), SS: ${signalCounts.ssCount} (new: ${signalCounts.newSsCount})`);

  // Fetch previous week's rankings for D7 (rank velocity = change in rank change)
  const prevRankLookup = {};
  try {
    const latestRanking = await getMostRecentRanking();
    if (latestRanking) {
      const prevRanking = await getRankingBeforeDate(latestRanking.date);
      if (prevRanking) {
        for (const entry of (prevRanking.rankings || [])) {
          if (entry.ticker) prevRankLookup[entry.ticker] = entry.rankChange ?? null;
        }
        for (const entry of (prevRanking.shortRankings || [])) {
          if (entry.ticker) prevRankLookup[entry.ticker] = entry.rankChange ?? null;
        }
        console.log(`[KILL v3] Previous ranking loaded: ${Object.keys(prevRankLookup).length} tickers from ${prevRanking.date}`);
      }
    }
  } catch (e) {
    console.warn('[KILL v3] prevRankLookup failed (D7 will score 0):', e.message);
  }

  const scored = [];

  await processBatch(allSignalTickers, async ticker => {
    const meta       = stockMeta[ticker] || {};
    const signalData = jungleSignals[ticker] || null;
    if (!signalData?.signal) return;

    const signal      = signalData.signal;
    const isNewSignal = signalData.isNewSignal ?? false;
    const signalAge   = computeSignalAge(signalData.signalDate);
    const data        = await fetchStockData(ticker);

    // ── Score all 8 dimensions ────────────────────────────────────────────────
    const d1 = calcD1(signal, meta.exchange, indexData, signalCounts);
    const d2 = scoreD2(signal, meta.sector, isNewSignal, sectorData);
    const d3 = scoreD3(signal, data);
    const d4 = scoreD4(signalAge, d3.confirmation);
    const d5 = scoreD5(meta.rankChange);
    const d6 = scoreD6(signal, data);
    const d7 = scoreD7(meta.rankChange, prevRankLookup[ticker] ?? null);
    const d8 = scoreD8(ticker, preyPresenceMap);

    // v3 formula: (D2 + D3 + D4 + D5 + D6 + D7 + D8) × D1
    const preMultiplier = d2.score + d3.score + d4.score + d5.score + d6.score + d7.score + d8.score;
    const total         = Math.round(preMultiplier * d1.score * 10) / 10;
    const tierDef       = getTier(total);

    scored.push({
      ticker,
      companyName:  meta.companyName  || '',
      sector:       meta.sector       || '',
      exchange:     meta.exchange     || '',
      currentPrice: meta.currentPrice || 0,
      ytdReturn:    meta.ytdReturn    ?? null,
      signal,
      signalDate:   signalData.signalDate  ?? null,
      signalAge,
      isNewSignal,
      stopPrice:    signalData.stopPrice   ?? null,
      rank:         meta.rank         ?? null,
      rankChange:   meta.rankChange   ?? undefined,
      rankList:     meta.rankList     || null,
      isSp500:      meta.isSp500      || false,
      isDow30:      meta.isDow30      || false,
      isNasdaq100:  meta.isNasdaq100  || false,
      universe:     meta.universe     || null,
      preyStrategies: d8.strategies,
      apexScore:    total,
      preMultiplier: Math.round(preMultiplier * 10) / 10,
      confirmation: d3.confirmation,
      // Flat scores object for score detail popup
      scores: {
        d1: d1.score,  // multiplier (0.70–1.30×)
        d2: d2.score,
        d3: d3.score,
        d4: d4.score,
        d5: d5.score,
        d6: d6.score,
        d7: d7.score,
        d8: d8.score,
      },
      // Detailed per-dimension breakdown for expanded popup view
      scoreDetail: { d1, d2, d3, d4, d5, d6, d7, d8 },
      tier:         tierDef.name,
      tierTagline:  tierDef.tagline,
    });
  });

  // Sort by score descending
  scored.sort((a, b) => b.apexScore - a.apexScore);

  // Mark top 10 and assign kill rank to all scored stocks
  scored.forEach((s, i) => { s.isTop10 = i < 10; s.killRank = i + 1; });

  const results = {
    stocks: scored,
    contextSummary: {
      spyAboveEma:  indexData['SPY']?.aboveEma  ?? null,
      spyEmaRising: indexData['SPY']?.emaRising ?? null,
      qqqAboveEma:  indexData['QQQ']?.aboveEma  ?? null,
      qqqEmaRising: indexData['QQQ']?.emaRising ?? null,
    },
    tierCounts: APEX_TIERS.reduce((acc, t) => {
      acc[t.name] = scored.filter(s => s.tier === t.name).length;
      return acc;
    }, {}),
    scannedAt:     new Date().toISOString(),
    totalScanned:  tickers.length,
    preyCount:     preyTickerSet.size,
    activeSignals: preySignalTickers.length,
    regime: {
      ...signalCounts,
      spyAboveEma:  indexData['SPY']?.aboveEma  ?? null,
      spyEmaRising: indexData['SPY']?.emaRising ?? null,
      qqqAboveEma:  indexData['QQQ']?.aboveEma  ?? null,
      qqqEmaRising: indexData['QQQ']?.emaRising ?? null,
    },
  };

  apexCache = { weekKey, results };
  console.log(`[KILL v3] Done. Scored: ${scored.length}. Top kill: ${scored[0]?.ticker ?? 'none'} @ ${scored[0]?.apexScore ?? 0} (${scored[0]?.tier ?? 'n/a'}).`);
  return results;
}

export function clearApexCache() {
  apexCache = { weekKey: null, results: null };
}
