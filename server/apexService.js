// server/apexService.js
// ── PNTHR APEX — 100-Point Predatory Scoring System ──────────────────────────
//
// 6 dimensions totalling 100 pts:
//   D1  Signal Freshness      (0-25)  BL/SS age: week 1=25, 2-3=18, 4-6=12, 7-10=6, >10=0
//   D2  Trend Quality         (0-20)  Price vs 21-EMA delta + EMA slope direction
//   D3  Momentum              (0-15)  RSI zone + OBV slope + Volume pulse
//   D4  Rank Position + Rise  (0-20)  PNTHR 100 rank (0-10) + rankChange (0-10)
//   D5  Trend Duration        (0-10)  Consecutive bars above/below EMA: 3-8=peak
//   D6  Market Context        (0-10)  SPY + sector ETF alignment
//
// 10 tiers (DORMANT → ALPHA PNTHR KILL)
// Cached weekly — only re-runs at Friday boundary.
// Only stocks with active BL/SS signals get full price data fetch; others score 0.
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config();

const FMP_API_KEY  = process.env.FMP_API_KEY;
const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';

// Weekly cache
let apexCache = { weekKey: null, results: null };

// ── Tier Definitions ──────────────────────────────────────────────────────────

export const APEX_TIERS = [
  { min: 91, max: 100, name: 'ALPHA PNTHR KILL', tagline: 'Jugular. Teeth in. Alpha PNTHR is Legend.' },
  { min: 81, max: 90,  name: 'STRIKING',          tagline: 'Claws out. Contact made. In the kill zone.' },
  { min: 71, max: 80,  name: 'HUNTING',            tagline: 'Full pursuit mode. Locked and moving fast.' },
  { min: 61, max: 70,  name: 'POUNCING',           tagline: 'The leap has begun. No turning back.' },
  { min: 51, max: 60,  name: 'COILING',            tagline: 'Body compressed. Energy stored. About to explode.' },
  { min: 41, max: 50,  name: 'STALKING',           tagline: 'Eyes fixed on target. Closing the distance silently.' },
  { min: 31, max: 40,  name: 'TRACKING',           tagline: 'Scent picked up. Target identified. Moving with intent.' },
  { min: 21, max: 30,  name: 'PROWLING',           tagline: 'Moving through the jungle. No target yet.' },
  { min: 11, max: 20,  name: 'STIRRING',           tagline: 'Waking up. Eyes barely open.' },
  { min: 0,  max: 10,  name: 'DORMANT',            tagline: 'Flat. Sleeping. No signal, no momentum.' },
];

export function getTier(score) {
  if (score == null || score < 0) return APEX_TIERS[9];
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

const CONTEXT_TICKERS = ['SPY', 'XLK', 'XLE', 'XLV', 'XLF', 'XLY', 'XLC', 'XLI', 'XLB', 'XLRE', 'XLU', 'XLP'];

// ── Price Data Helpers ────────────────────────────────────────────────────────

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
    w.low    = Math.min(w.low, bar.low);
    if (w.close === null) w.close = bar.close;
    w.open   = bar.open;
    w.volume += (bar.volume || 0);
  }
  return Object.values(weekMap).sort((a, b) => a.weekStart > b.weekStart ? 1 : -1);
}

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

    const ema21 = computeEMA21(weekly);
    const obv   = computeOBV(weekly);
    const rsi   = computeRSI14(weekly);

    const recent = dailyAsc.slice(-25);
    const vol5   = recent.slice(-5).reduce((s, b)  => s + (b.volume || 0), 0) / 5;
    const vol20  = recent.slice(-20).reduce((s, b) => s + (b.volume || 0), 0) / 20;

    return { weekly, ema21, obv, rsi, vol5, vol20 };
  } catch {
    return null;
  }
}

// ── Context Loader (SPY + 11 sector ETFs) ────────────────────────────────────

async function fetchContextData() {
  const ctx = {};
  await Promise.all(CONTEXT_TICKERS.map(async t => {
    try {
      const data = await fetchStockData(t);
      if (!data) return;
      const n = data.weekly.length;
      const li = n - 1;
      const ema = data.ema21[li];
      const prevEma = data.ema21[li - 1];
      if (ema == null) return;
      ctx[t] = {
        aboveEma:  data.weekly[li].close > ema,
        emaRising: prevEma != null && ema > prevEma,
      };
    } catch { /* skip */ }
  }));
  return ctx;
}

// ── Scoring Functions ─────────────────────────────────────────────────────────

function computeWeeksAgo(signalDate) {
  if (!signalDate) return null;
  const signalMonday = new Date(signalDate + 'T12:00:00');
  const today = new Date();
  const dow = today.getDay();
  const daysToMonday = dow === 0 ? -6 : 1 - dow;
  const currentMonday = new Date(today);
  currentMonday.setDate(today.getDate() + daysToMonday);
  currentMonday.setHours(0, 0, 0, 0);
  const diffDays = Math.round((currentMonday - signalMonday) / (1000 * 60 * 60 * 24));
  return Math.floor(diffDays / 7) + 1;
}

// D1: Signal Freshness (0-25 pts)
function scoreSignalFreshness(signalData) {
  if (!signalData) return 0;
  const { signal, isNewSignal, signalDate } = signalData;
  if (signal !== 'BL' && signal !== 'SS') return 0;
  if (isNewSignal) return 25;
  const wks = computeWeeksAgo(signalDate);
  if (wks == null) return 0;
  if (wks <= 1)  return 25;
  if (wks <= 3)  return 18;
  if (wks <= 6)  return 12;
  if (wks <= 10) return 6;
  return 0;
}

// D2: Trend Quality (0-20 pts)
function scoreTrendQuality(data, signalData) {
  if (!data || !signalData) return 0;
  const { signal } = signalData;
  if (signal !== 'BL' && signal !== 'SS') return 0;
  const { weekly, ema21 } = data;
  const n = weekly.length;
  const li = n - 1;
  const lastEma = ema21[li], prevEma = ema21[li - 1];
  if (lastEma == null || prevEma == null) return 0;
  const cur = weekly[li];
  const prev = weekly[li - 1];
  const emaRising = lastEma > prevEma;
  // EMA slope must align with signal direction
  if (signal === 'BL' && !emaRising) return 2;
  if (signal === 'SS' &&  emaRising) return 2;
  // Delta = how far price is from EMA (0-20 pts)
  const delta = signal === 'BL'
    ? (cur.close - lastEma) / lastEma
    : (lastEma - cur.close) / lastEma;
  let score;
  if (delta < 0)         score = 4;  // wrong side
  else if (delta < 0.01) score = 10; // just crossed
  else if (delta <= 0.05) score = 20; // sweet spot 1-5%
  else if (delta <= 0.07) score = 15; // 5-7%
  else if (delta <= 0.10) score = 10; // 7-10%
  else                   score = 5;  // >10% overextended
  // +5 if current bar closes in signal direction:
  // SS: this week closed lower than open AND lower than last week's close (bearish confirmation)
  // BL: this week closed higher than open AND higher than last week's close (bullish confirmation)
  if (prev) {
    if (signal === 'SS' && cur.close < cur.open && cur.close < prev.close) score += 5;
    if (signal === 'BL' && cur.close > cur.open && cur.close > prev.close) score += 5;
  }
  return score;
}

// D3: Momentum (0-15 pts) — RSI + OBV + Volume pulse
function scoreMomentum(data, signalData) {
  if (!data || !signalData) return 0;
  const { signal } = signalData;
  if (signal !== 'BL' && signal !== 'SS') return 0;
  const { obv, rsi, vol5, vol20, weekly } = data;
  const li = weekly.length - 1;
  let score = 0;

  // RSI (0-7 pts)
  const curRsi = rsi[li];
  if (curRsi != null) {
    if (signal === 'BL') {
      if (curRsi >= 55 && curRsi <= 70)       score += 7;
      else if (curRsi > 50 && curRsi < 75)    score += 4;
      else if (curRsi >= 40 && curRsi < 50)   score += 2;
    } else {
      if (curRsi >= 30 && curRsi <= 45)       score += 7;
      else if (curRsi >= 25 && curRsi < 50)   score += 4;
      else if (curRsi > 50 && curRsi <= 60)   score += 2;
    }
  }

  // OBV 5-period slope (0-5 pts)
  if (li >= 5) {
    const obvSlope = obv[li] - obv[li - 5];
    if (signal === 'BL' && obvSlope > 0)  score += 5;
    else if (signal === 'SS' && obvSlope < 0) score += 5;
  }

  // Volume pulse (0-3 pts)
  if (vol5 > 0 && vol20 > 0) {
    if (vol5 >= vol20 * 1.2) score += 3;
    else if (vol5 > vol20)   score += 2;
  }

  return Math.min(score, 15);
}

// D4: Rank Position + Rise (0-20 pts)
function scoreRankAndRise(rank, rankChange) {
  // Position (0-10 pts)
  let posScore = 0;
  if (rank != null) {
    if (rank <= 10)  posScore = 10;
    else if (rank <= 25)  posScore = 8;
    else if (rank <= 50)  posScore = 6;
    else if (rank <= 75)  posScore = 4;
    else                  posScore = 2;
  }

  // Rise (0-10 pts) — null = NEW entry
  let riseScore = 0;
  if (rankChange === null || rankChange === undefined) {
    riseScore = 10; // NEW entry
  } else {
    const n = Number(rankChange);
    if (n >= 30)      riseScore = 9;
    else if (n >= 20) riseScore = 7;
    else if (n >= 10) riseScore = 5;
    else if (n >= 5)  riseScore = 3;
    else if (n >= 1)  riseScore = 1;
    else              riseScore = 0;
  }

  return posScore + riseScore;
}

// D5: Trend Duration (0-10 pts) — consecutive bars on correct side of EMA
function scoreTrendDuration(data, signalData) {
  if (!data || !signalData) return 0;
  const { signal } = signalData;
  if (signal !== 'BL' && signal !== 'SS') return 0;
  const { weekly, ema21 } = data;
  const li = weekly.length - 1;
  let bars = 0;
  for (let i = li; i >= 0 && ema21[i] != null; i--) {
    const aboveEma = weekly[i].close > ema21[i];
    if (signal === 'BL' && aboveEma)  bars++;
    else if (signal === 'SS' && !aboveEma) bars++;
    else break;
  }
  if (bars >= 3 && bars <= 8)  return 10; // ideal window
  if (bars === 1 || bars === 2) return 5; // early
  if (bars >= 9 && bars <= 12)  return 4; // mature
  if (bars > 12)                return 2; // extended
  return 0;
}

// D6: Market Context (0-10 pts) — SPY + sector aligned
function scoreMarketContext(sector, signalData, ctx) {
  if (!signalData || !ctx) return 0;
  const { signal } = signalData;
  if (signal !== 'BL' && signal !== 'SS') return 0;

  const spy = ctx['SPY'];
  const broadAligned = spy
    ? (signal === 'BL' ? spy.aboveEma && spy.emaRising : !spy.aboveEma && !spy.emaRising)
    : false;

  const etf = SECTOR_MAP[sector];
  const sectorCtx = etf ? ctx[etf] : null;
  const sectorAligned = sectorCtx
    ? (signal === 'BL' ? sectorCtx.aboveEma && sectorCtx.emaRising : !sectorCtx.aboveEma && !sectorCtx.emaRising)
    : false;

  if (broadAligned && sectorAligned) return 10;
  if (broadAligned)                  return 6;
  if (sectorAligned)                 return 4;
  return 0;
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

export async function getApexResults(tickers, stockMeta = {}, jungleSignals = {}) {
  const weekKey = getLastFriday();
  if (apexCache.weekKey === weekKey && apexCache.results) return apexCache.results;

  const activeTickers = tickers.filter(t => {
    const sig = jungleSignals[t]?.signal;
    return sig === 'BL' || sig === 'SS';
  });

  console.log(`[APEX] Starting scan — ${activeTickers.length} active signal stocks out of ${tickers.length} total`);

  // Load context (SPY + 11 sector ETFs)
  const ctx = await fetchContextData();
  console.log(`[APEX] Context loaded: ${Object.keys(ctx).length} ETFs`);

  const scored = [];

  // Score active signal stocks (full price data fetch)
  await processBatch(activeTickers, async ticker => {
    const meta       = stockMeta[ticker] || {};
    const signalData = jungleSignals[ticker] || null;
    const data       = await fetchStockData(ticker);

    const d1 = scoreSignalFreshness(signalData);
    const d2 = scoreTrendQuality(data, signalData);
    const d3 = scoreMomentum(data, signalData);
    const d4 = scoreRankAndRise(meta.rank ?? null, meta.rankChange);
    const d5 = scoreTrendDuration(data, signalData);
    const d6 = scoreMarketContext(meta.sector, signalData, ctx);

    const total   = d1 + d2 + d3 + d4 + d5 + d6;
    const tierDef = getTier(total);

    scored.push({
      ticker,
      companyName:  meta.companyName  || '',
      sector:       meta.sector       || '',
      exchange:     meta.exchange     || '',
      currentPrice: meta.currentPrice || 0,
      ytdReturn:    meta.ytdReturn    ?? null,
      signal:       signalData.signal,
      signalDate:   signalData.signalDate   ?? null,
      isNewSignal:  signalData.isNewSignal  ?? false,
      stopPrice:    signalData.stopPrice    ?? null,
      rank:         meta.rank         ?? null,
      rankChange:   meta.rankChange   ?? undefined,
      rankList:     meta.rankList     || null,
      isSp500:      meta.isSp500      || false,
      isDow30:      meta.isDow30      || false,
      isNasdaq100:  meta.isNasdaq100  || false,
      universe:     meta.universe     || null,
      apexScore:    total,
      scores: { freshness: d1, trendQuality: d2, momentum: d3, rankRise: d4, duration: d5, context: d6 },
      tier:         tierDef.name,
      tierTagline:  tierDef.tagline,
    });
  });

  // Sort: score desc, then signal freshness tie-breaker
  scored.sort((a, b) => b.apexScore - a.apexScore);

  const results = {
    stocks: scored,
    contextSummary: {
      spyAboveEma:  ctx['SPY']?.aboveEma  ?? null,
      spyEmaRising: ctx['SPY']?.emaRising ?? null,
    },
    tierCounts: APEX_TIERS.reduce((acc, t) => {
      acc[t.name] = scored.filter(s => s.tier === t.name).length;
      return acc;
    }, {}),
    scannedAt:    new Date().toISOString(),
    totalScanned: tickers.length,
    activeSignals: activeTickers.length,
  };

  apexCache = { weekKey, results };
  const topCount = scored.filter(s => ['ALPHA PNTHR KILL', 'STRIKING', 'HUNTING'].includes(s.tier)).length;
  console.log(`[APEX] Done. Scored: ${scored.length}. Top tier: ${topCount}.`);
  return results;
}

export function clearApexCache() {
  apexCache = { weekKey: null, results: null };
}
