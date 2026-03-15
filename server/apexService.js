// server/apexService.js
// ── PNTHR KILL — 8-Dimension Predatory Scoring System ────────────────────────
//
// Universe: PNTHR Prey stocks only (Feast, Alpha, Spring, Sneak, Hunt, Sprint)
// No score cap — each dimension earns what it earns, scores can be negative.
//
//   D1  Market Direction          ±5 typical   Index (QQQ/SPY) EMA alignment × 5 weeks
//   D2  Sector Direction          variable      Sector ETF 5D + 1M return, alignment × multiplier
//   D3  Price Separation + Close  variable      Separation% + conviction% (point-for-point)
//   D4  Rank Position             1-99          Math.max(1, 100 - rank); 0 if not ranked
//   D5  Rank Rise                 variable      +1/-1 per spot; new entry = 100-rank
//   D6  Momentum                  variable      EMA conviction + RSI + OBV% + ADX
//   D7  EMA Slope Duration        0-20          Consecutive weeks EMA in signal direction
//   D8  Multi-Strategy Prey       0-18          +3 pts per Prey strategy stock appears in
//
// Tiers: ≥300 ALPHA · ≥250 STRIKING · ≥200 HUNTING · ≥150 POUNCING
//        ≥100 COILING · ≥75 STALKING · ≥50 TRACKING · ≥25 PROWLING
//        ≥0 STIRRING · <0 DORMANT
//
// Config: server/killScoringConfig.js — single source of truth for all weights
// Cached weekly — only re-runs at Friday boundary.
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config();

import { KILL_CONFIG } from './killScoringConfig.js';

const FMP_API_KEY  = process.env.FMP_API_KEY;
const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';

// Weekly cache
let apexCache = { weekKey: null, results: null };

// ── Tier Definitions ──────────────────────────────────────────────────────────

export const APEX_TIERS = [
  { min: 300, max: Infinity, name: 'ALPHA PNTHR KILL', tagline: 'Jugular. Teeth in. Alpha PNTHR is Legend.' },
  { min: 250, max: 299,      name: 'STRIKING',         tagline: 'Claws out. Contact made. In the kill zone.' },
  { min: 200, max: 249,      name: 'HUNTING',          tagline: 'Full pursuit mode. Locked and moving fast.' },
  { min: 150, max: 199,      name: 'POUNCING',         tagline: 'The leap has begun. No turning back.' },
  { min: 100, max: 149,      name: 'COILING',          tagline: 'Body compressed. Energy stored. About to explode.' },
  { min: 75,  max: 99,       name: 'STALKING',         tagline: 'Eyes fixed on target. Closing the distance silently.' },
  { min: 50,  max: 74,       name: 'TRACKING',         tagline: 'Scent picked up. Target identified. Moving with intent.' },
  { min: 25,  max: 49,       name: 'PROWLING',         tagline: 'Moving through the jungle. No target yet.' },
  { min: 0,   max: 24,       name: 'STIRRING',         tagline: 'Waking up. Eyes barely open.' },
  { min: -Infinity, max: -1, name: 'DORMANT',          tagline: 'Fighting the trend. Sleeping against the flow.' },
];

export function getTier(score) {
  if (score == null) return APEX_TIERS[9];
  return APEX_TIERS.find(t => score >= t.min && score <= t.max) || APEX_TIERS[9];
}

// ── Sector Map ────────────────────────────────────────────────────────────────

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

// ── Index Data (D1) ───────────────────────────────────────────────────────────
// Returns { QQQ, SPY } — each with:
//   history: boolean[5] — last 5 weeks, true = close above EMA (bullish)
//   aboveEma, emaRising for context banner

async function fetchIndexData() {
  const result = {};
  for (const ticker of ['QQQ', 'SPY']) {
    try {
      const data = await fetchStockData(ticker);
      if (!data) continue;
      const { weekly, ema21 } = data;
      const n = weekly.length;
      const li = n - 1;
      // Last 5 weeks of EMA position: true = bullish (close > EMA)
      const history = [];
      for (let i = Math.max(0, n - 5); i < n; i++) {
        if (ema21[i] != null) history.push(weekly[i].close > ema21[i]);
      }
      result[ticker] = {
        history,
        aboveEma:  ema21[li] != null ? weekly[li].close > ema21[li] : null,
        emaRising: ema21[li] != null && ema21[li - 1] != null ? ema21[li] > ema21[li - 1] : null,
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
      // 5D return = 1 week: weekly[n-1] vs weekly[n-2]
      const return5D = n >= 2
        ? (weekly[n - 1].close - weekly[n - 2].close) / weekly[n - 2].close * 100
        : 0;
      // 1M return = 4 weeks: weekly[n-1] vs weekly[n-5]
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
    // Feast (dinner section)
    for (const s of (preyResults.dinner?.longs  || [])) addStrategy(s.ticker, 'Feast');
    for (const s of (preyResults.dinner?.shorts || [])) addStrategy(s.ticker, 'Feast');
    // Alpha
    for (const s of (preyResults.alphas?.longs  || [])) addStrategy(s.ticker, 'Alpha');
    for (const s of (preyResults.alphas?.shorts || [])) addStrategy(s.ticker, 'Alpha');
    // Spring
    for (const s of (preyResults.springs?.longs  || [])) addStrategy(s.ticker, 'Spring');
    for (const s of (preyResults.springs?.shorts || [])) addStrategy(s.ticker, 'Spring');
    // Sneak
    for (const s of (preyResults.sneak?.longs  || [])) addStrategy(s.ticker, 'Sneak');
    for (const s of (preyResults.sneak?.shorts || [])) addStrategy(s.ticker, 'Sneak');
  }

  // Hunt
  for (const ticker of (huntTickers || [])) addStrategy(ticker, 'Hunt');

  // Sprint (rankChange > 0 or null = new entry)
  for (const [ticker, meta] of Object.entries(stockMeta)) {
    if (meta.rankChange === null || meta.rankChange === undefined || meta.rankChange > 0) {
      addStrategy(ticker, 'Sprint');
    }
  }

  return map;
}

// ── Collect All Prey Tickers ──────────────────────────────────────────────────

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

  // Sprint: any stock in stockMeta with rising/new rank
  for (const [ticker, meta] of Object.entries(stockMeta)) {
    if (meta.rankChange === null || meta.rankChange === undefined || meta.rankChange > 0) {
      set.add(ticker);
    }
  }

  return set;
}

// ── D1: Market Direction ──────────────────────────────────────────────────────
// Exchange routing: Nasdaq → QQQ, NYSE/ARCA → SPY
// Score ±1 per week for last 5 weeks (aligned = +1, misaligned = -1)

function scoreD1(signal, exchange, indexData) {
  const cfg = KILL_CONFIG.d1;
  if (!signal || !indexData) return 0;
  // Route to index by exchange
  const exc = (exchange || '').toUpperCase();
  const indexTicker = exc === 'NASDAQ' || exc.includes('NASDAQ') ? 'QQQ' : 'SPY';
  const idx = indexData[indexTicker];
  if (!idx || !idx.history || idx.history.length === 0) return 0;

  let score = 0;
  for (const isBullish of idx.history) {
    const aligned = (signal === 'BL' && isBullish) || (signal === 'SS' && !isBullish);
    score += aligned ? cfg.alignedPts : cfg.misalignedPts;
  }
  return score;
}

// ── D2: Sector Direction ──────────────────────────────────────────────────────
// Sector direction = sign(sector ETF 5D return)
// Aligned: BL + UP sector, or SS + DOWN sector
// 5D: new signal ×2, else ×1 + sector 5D return %
// 1M: sector 1M return % point-for-point

function scoreD2(signal, sector, isNewSignal, sectorData) {
  const cfg = KILL_CONFIG.d2;
  if (!signal || !sectorData) return 0;
  const etf = SECTOR_MAP[sector];
  if (!etf || !sectorData[etf]) return 0;
  const { return5D, return1M } = sectorData[etf];

  const sectorBullish = return5D >= 0;
  const aligned = (signal === 'BL' && sectorBullish) || (signal === 'SS' && !sectorBullish);
  const direction = aligned ? 1 : -1;

  // 5D component: new signals get ×2
  const mult5D = isNewSignal ? cfg.newSignalMultiplier5D : 1;
  const score5D = Math.abs(return5D) * mult5D * direction * cfg.sectorReturn5DMultiplier;

  // 1M component: point-for-point
  const score1M = Math.abs(return1M) * cfg.sectorReturn1MMultiplier * direction;

  return score5D + score1M;
}

// ── D3: Price Separation + Close Conviction ───────────────────────────────────
// Both sub-scores are pure point-for-point percentages
// BL sep:  (low - EMA) / EMA * 100
// BL conv: (close - low) / low * 100
// SS sep:  (EMA - high) / EMA * 100
// SS conv: (high - close) / high * 100

function scoreD3(signal, data) {
  if (!signal || !data) return 0;
  const { weekly, ema21 } = data;
  const n = weekly.length;
  const li = n - 1;
  const ema = ema21[li];
  const bar = weekly[li];
  if (ema == null || !bar) return 0;

  let sep = 0, conv = 0;
  if (signal === 'BL') {
    sep  = (bar.low   - ema)       / ema       * 100;
    conv = (bar.close - bar.low)   / bar.low   * 100;
  } else if (signal === 'SS') {
    sep  = (ema       - bar.high)  / ema       * 100;
    conv = (bar.high  - bar.close) / bar.high  * 100;
  }
  return sep + conv;
}

// ── D4: Rank Position ────────────────────────────────────────────────────────
// Formula: Math.max(floor, 100 - rank); 0 if not ranked

function scoreD4(rank) {
  const cfg = KILL_CONFIG.d4;
  if (rank == null) return 0;
  return Math.max(cfg.floor, 100 - rank);
}

// ── D5: Rank Rise ────────────────────────────────────────────────────────────
// New entry (rankChange null/undefined): 100 - currentRank
// Rising: +ptPerSpot per position climbed
// Falling: -ptPerSpot per position dropped
// Flat (0): 0 pts

function scoreD5(rank, rankChange) {
  const cfg = KILL_CONFIG.d5;
  // New entry
  if (rankChange === null || rankChange === undefined) {
    return rank != null ? 100 - rank : 0;
  }
  return Number(rankChange) * cfg.ptPerSpot;
}

// ── D6: Momentum (4 sub-scores) ───────────────────────────────────────────────
//
// A: EMA Conviction = directedSlope% × separation%
// B: RSI centered on 50
// C: OBV week-over-week % change (inverted for SS)
// D: ADX trend strength (rising: ADX-5, falling: ADX-15, <15: 0)

function scoreD6(signal, data) {
  const cfg = KILL_CONFIG.d6;
  if (!signal || !data) return 0;
  const { weekly, ema21, obv, rsi, adx } = data;
  const n  = weekly.length;
  const li = n - 1;
  const ema    = ema21[li];
  const emaPrev = ema21[li - 1];
  const bar    = weekly[li];
  if (ema == null || !bar) return 0;

  // Sub-score A: EMA Conviction = directedSlope% × separation%
  let scoreA = 0;
  if (emaPrev != null && emaPrev !== 0) {
    const slopePercent = (ema - emaPrev) / emaPrev * 100;
    // Directed slope: BL = positive (slope going up), SS = negative slope is good
    const directedSlope = signal === 'BL' ? slopePercent : -slopePercent;
    // Separation: same as D3 formula
    const sep = signal === 'BL'
      ? (bar.low  - ema) / ema * 100
      : (ema - bar.high) / ema * 100;
    scoreA = directedSlope * sep;
  }

  // Sub-score B: RSI centered on 50
  let scoreB = 0;
  const curRsi = rsi[li];
  if (curRsi != null) {
    scoreB = signal === 'BL' ? curRsi - cfg.rsiCenter : cfg.rsiCenter - curRsi;
  }

  // Sub-score C: OBV week-over-week % change
  let scoreC = 0;
  if (li >= 1 && obv[li - 1] !== 0) {
    const obvChange = (obv[li] - obv[li - 1]) / Math.abs(obv[li - 1]) * 100;
    scoreC = signal === 'BL' ? obvChange : -obvChange;
  }

  // Sub-score D: ADX trend strength
  let scoreD = 0;
  const adxCur  = adx[li];
  const adxPrev = adx[li - 1];
  if (adxCur != null && adxCur >= cfg.adxMinThreshold) {
    const rising = adxPrev != null && adxCur > adxPrev;
    scoreD = rising
      ? adxCur - cfg.adxRisingOffset
      : adxCur - cfg.adxFallingOffset;
    if (scoreD < 0) scoreD = 0; // floor at 0 for ADX sub-score
  }

  return scoreA + scoreB + scoreC + scoreD;
}

// ── D7: EMA Slope Duration ────────────────────────────────────────────────────
// Count consecutive weeks EMA has sloped in signal direction going backward
// BL: ema[i] > ema[i-1] counts; SS: ema[i] < ema[i-1] counts
// Hard stop at first reversal; cap at maxWeeks

function scoreD7(signal, data) {
  const cfg = KILL_CONFIG.d7;
  if (!signal || !data) return 0;
  const { ema21 } = data;
  const n = ema21.length;
  let count = 0;
  for (let i = n - 1; i >= 1; i--) {
    if (ema21[i] == null || ema21[i - 1] == null) break;
    const slopingRight = signal === 'BL'
      ? ema21[i] > ema21[i - 1]
      : ema21[i] < ema21[i - 1];
    if (!slopingRight) break;
    count++;
    if (count >= cfg.maxWeeks) break;
  }
  return count;
}

// ── D8: Multi-Strategy Prey Presence ─────────────────────────────────────────
// +ptPerStrategy for each Prey section the stock appears in (max 6 strategies)

function scoreD8(ticker, preyPresenceMap) {
  const cfg = KILL_CONFIG.d8;
  const strategies = preyPresenceMap.get(ticker);
  if (!strategies || strategies.size === 0) return 0;
  return strategies.size * cfg.ptPerStrategy;
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

  // Filter to Prey universe + active BL/SS signals
  const preySignalTickers = [...preyTickerSet].filter(t => {
    const sig = jungleSignals[t]?.signal;
    return sig === 'BL' || sig === 'SS';
  });

  console.log(`[KILL] Scoring ${preySignalTickers.length} Prey stocks (${preyTickerSet.size} in Prey universe, ${tickers.length} total)`);

  // Load shared context in parallel
  console.log('[KILL] Fetching index + sector data...');
  const [indexData, sectorData] = await Promise.all([
    fetchIndexData(),
    fetchSectorData(),
  ]);
  console.log(`[KILL] Index: ${Object.keys(indexData).join(', ')} | Sectors: ${Object.keys(sectorData).length} ETFs loaded`);

  const scored = [];

  await processBatch(preySignalTickers, async ticker => {
    const meta       = stockMeta[ticker] || {};
    const signalData = jungleSignals[ticker] || null;
    if (!signalData?.signal) return;

    const signal     = signalData.signal;
    const isNewSignal = signalData.isNewSignal ?? false;
    const data       = await fetchStockData(ticker);

    const d1 = scoreD1(signal, meta.exchange,  indexData);
    const d2 = scoreD2(signal, meta.sector, isNewSignal, sectorData);
    const d3 = scoreD3(signal, data);
    const d4 = scoreD4(meta.rank ?? null);
    const d5 = scoreD5(meta.rank ?? null, meta.rankChange);
    const d6 = scoreD6(signal, data);
    const d7 = scoreD7(signal, data);
    const d8 = scoreD8(ticker, preyPresenceMap);

    const total   = d1 + d2 + d3 + d4 + d5 + d6 + d7 + d8;
    const tierDef = getTier(total);

    scored.push({
      ticker,
      companyName:  meta.companyName  || '',
      sector:       meta.sector       || '',
      exchange:     meta.exchange     || '',
      currentPrice: meta.currentPrice || 0,
      ytdReturn:    meta.ytdReturn    ?? null,
      signal,
      signalDate:   signalData.signalDate  ?? null,
      isNewSignal,
      stopPrice:    signalData.stopPrice   ?? null,
      rank:         meta.rank         ?? null,
      rankChange:   meta.rankChange   ?? undefined,
      rankList:     meta.rankList     || null,
      isSp500:      meta.isSp500      || false,
      isDow30:      meta.isDow30      || false,
      isNasdaq100:  meta.isNasdaq100  || false,
      universe:     meta.universe     || null,
      preyStrategies: [...(preyPresenceMap.get(ticker) || [])],
      apexScore:    Math.round(total * 10) / 10,
      scores: { d1, d2: Math.round(d2 * 10) / 10, d3: Math.round(d3 * 10) / 10, d4, d5, d6: Math.round(d6 * 10) / 10, d7, d8 },
      tier:         tierDef.name,
      tierTagline:  tierDef.tagline,
    });
  });

  // Sort by score descending
  scored.sort((a, b) => b.apexScore - a.apexScore);

  // Mark top 10
  scored.forEach((s, i) => { s.isTop10 = i < 10; });

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
    scannedAt:    new Date().toISOString(),
    totalScanned: tickers.length,
    preyCount:    preyTickerSet.size,
    activeSignals: preySignalTickers.length,
  };

  apexCache = { weekKey, results };
  console.log(`[KILL] Done. Scored: ${scored.length}. Top kill: ${scored[0]?.ticker ?? 'none'} @ ${scored[0]?.apexScore ?? 0}.`);
  return results;
}

export function clearApexCache() {
  apexCache = { weekKey: null, results: null };
}
