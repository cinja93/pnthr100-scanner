import dotenv from 'dotenv';
import { connectToDatabase } from './database.js';
import { SPEC_LONGS, SPEC_SHORTS } from './speculative162.js';
dotenv.config();

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';

// ── Selection criteria ────────────────────────────────────────────────────────
// Longs:  close > 21-week EMA (uptrend), price >= $20, top 80 by 52-week return
// Shorts: close < 21-week EMA (downtrend), price >= $70 (avoids penny-land), bottom 80 by 52-week return
// Lists refresh weekly, keyed by last Friday's date.
// Calculation is slow (~40 FMP calls); results are persisted in MongoDB so Vercel
// cold starts serve instantly. Hardcoded SPEC_LONGS/SPEC_SHORTS are used as a
// fallback on the very first run until the background calculation finishes.

const LONG_COUNT      = 80;
const SHORT_COUNT     = 80;
const MIN_LONG_PRICE  = 20;
const MIN_SHORT_PRICE = 70;
const WEEKS_HISTORY   = 56; // 21-week EMA needs ~26 weeks, but 52-week return needs 53 weeks of data

const MONGO_COLLECTION = 'sp400_cache';

// ── In-memory cache ───────────────────────────────────────────────────────────
let sp400Cache = { weekKey: null, longs: null, shorts: null };
let refreshInProgress = false;

function getWeekKey() {
  const today  = new Date();
  const day    = today.getDay();
  const daysBack = day === 5 ? 0 : (day + 2) % 7;
  const lastFriday = new Date(today);
  lastFriday.setDate(today.getDate() - daysBack);
  return lastFriday.toISOString().split('T')[0];
}

// ── MongoDB helpers ───────────────────────────────────────────────────────────
async function loadFromMongo() {
  try {
    const db = await connectToDatabase();
    if (!db) return null;
    return await db.collection(MONGO_COLLECTION).findOne({}, { sort: { updatedAt: -1 } });
  } catch { return null; }
}

async function saveToMongo(weekKey, longs, shorts) {
  try {
    const db = await connectToDatabase();
    if (!db) return;
    await db.collection(MONGO_COLLECTION).replaceOne(
      {},
      { weekKey, longs, shorts, updatedAt: new Date() },
      { upsert: true }
    );
    console.log(`📊 S&P 400 cache saved to MongoDB (week of ${weekKey})`);
  } catch (err) {
    console.error('S&P 400 MongoDB save error:', err.message);
  }
}

// ── FMP helper ────────────────────────────────────────────────────────────────
async function fetchFMP(endpoint, retries = 3) {
  const url = `${FMP_BASE_URL}${endpoint}${endpoint.includes('?') ? '&' : '?'}apikey=${FMP_API_KEY}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt), 30000)));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

// ── EMA + weekly close helpers ────────────────────────────────────────────────
function extractWeeklyCloses(dailyOldestFirst) {
  const byWeek = new Map();
  for (const bar of dailyOldestFirst) {
    const d = new Date(bar.date + 'T12:00:00');
    const jan4 = new Date(d.getFullYear(), 0, 4);
    const weekNum = Math.ceil(((d - jan4) / 86400000 + jan4.getDay() + 1) / 7);
    const key = `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
    byWeek.set(key, bar.close);
  }
  return [...byWeek.values()];
}

function calcEma(closes, period = 21) {
  if (closes.length < period + 1) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, c) => s + c, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

// ── Main calculation (runs in background, saves to MongoDB) ───────────────────
async function refreshSp400Cache() {
  if (refreshInProgress) return;
  refreshInProgress = true;
  const weekKey = getWeekKey();
  console.log(`📊 S&P 400: starting 21-week EMA calculation for week of ${weekKey}...`);

  try {
    // Step 1: Get S&P 400 constituent list
    // FMP sometimes wraps the array in an object or changes endpoint format
    let raw = await fetchFMP('/sp400_constituent');

    // Handle object wrapper — e.g. { "symbolsList": [...] } or { "sp400": [...] }
    let constituents = null;
    if (Array.isArray(raw)) {
      constituents = raw;
    } else if (raw && typeof raw === 'object') {
      // Try common wrapper keys
      const arrayVal = Object.values(raw).find(v => Array.isArray(v) && v.length > 0);
      if (arrayVal) constituents = arrayVal;
    }

    // Fallback endpoint if primary returned nothing usable
    if (!constituents || constituents.length === 0) {
      try {
        const alt = await fetchFMP('/v4/index-constituent?index=sp400');
        if (Array.isArray(alt) && alt.length > 0) {
          constituents = alt;
          console.log(`📊 S&P 400: fallback endpoint returned ${alt.length} constituents`);
        }
      } catch { /* fallback also unavailable */ }
    }

    if (!constituents || constituents.length === 0) {
      // FMP plan doesn't include S&P 400 constituent endpoints — using hardcoded fallback list.
      // This is expected; the hardcoded list in speculative162.js is the active universe.
      console.log('📊 S&P 400: constituent API unavailable on current FMP plan — using hardcoded fallback list');
      return;
    }

    const tickers = [...new Set(constituents.map(c => c.symbol ?? c.ticker ?? c).filter(s => typeof s === 'string'))];
    console.log(`📊 S&P 400: ${tickers.length} constituent tickers`);

    // Step 2: Bulk quotes for current price
    const quoteMap = {};
    for (let i = 0; i < tickers.length; i += 200) {
      try {
        const quotes = await fetchFMP(`/quote/${tickers.slice(i, i + 200).join(',')}`);
        if (Array.isArray(quotes)) for (const q of quotes) quoteMap[q.symbol] = q;
      } catch (err) { console.error('S&P 400 quote error:', err.message); }
      if (i + 200 < tickers.length) await new Promise(r => setTimeout(r, 400));
    }

    // Step 3: Weekly price history for 21-week EMA + 52-week return
    // Uses multi-ticker /historical-price-full (batches of 10)
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - WEEKS_HISTORY * 7);
    const from = fromDate.toISOString().split('T')[0];
    const histMap = {};

    for (let i = 0; i < tickers.length; i += 10) {
      const chunk = tickers.slice(i, i + 10);
      try {
        const raw = await fetchFMP(`/historical-price-full/${chunk.join(',')}?from=${from}&serietype=line`);
        const list = raw?.historicalStockList
          ?? (raw?.historical ? [{ symbol: raw.symbol, historical: raw.historical }] : []);
        for (const item of list) {
          if (!item?.historical?.length) continue;
          const oldestFirst  = [...item.historical].reverse();
          const weeklyCloses = extractWeeklyCloses(oldestFirst);
          if (weeklyCloses.length < 22) continue;
          const ema21w      = calcEma(weeklyCloses, 21);
          const latestClose = weeklyCloses[weeklyCloses.length - 1];
          // 52-week return if enough data, otherwise use available range
          const lookback    = Math.min(52, weeklyCloses.length - 1);
          const closeAgo    = weeklyCloses[weeklyCloses.length - 1 - lookback];
          const return52w   = closeAgo > 0 ? ((latestClose - closeAgo) / closeAgo) * 100 : 0;
          if (ema21w != null) histMap[item.symbol] = { ema21w, return52w };
        }
      } catch (err) { console.error(`S&P 400 history batch ${Math.floor(i / 10) + 1} error:`, err.message); }
      if (i + 10 < tickers.length) await new Promise(r => setTimeout(r, 300));
    }

    // Step 4: Filter + rank
    const longCandidates  = [];
    const shortCandidates = [];
    for (const ticker of tickers) {
      const q    = quoteMap[ticker];
      const hist = histMap[ticker];
      if (!q || !hist || !q.price) continue;
      const { ema21w, return52w } = hist;
      if (q.price > ema21w  && q.price >= MIN_LONG_PRICE)  longCandidates.push({ ticker, return52w });
      if (q.price < ema21w  && q.price >= MIN_SHORT_PRICE) shortCandidates.push({ ticker, return52w });
    }
    longCandidates.sort((a, b)  => b.return52w - a.return52w);
    shortCandidates.sort((a, b) => a.return52w - b.return52w);

    const longs  = longCandidates.slice(0, LONG_COUNT).map(s => s.ticker);
    const shorts = shortCandidates.slice(0, SHORT_COUNT).map(s => s.ticker);

    sp400Cache = { weekKey, longs, shorts };
    console.log(`📊 S&P 400 done: ${longs.length} longs, ${shorts.length} shorts — saving to MongoDB`);
    await saveToMongo(weekKey, longs, shorts);

  } catch (err) {
    console.error('❌ S&P 400 refresh failed:', err.message);
  } finally {
    refreshInProgress = false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
// Returns lists immediately from in-memory → MongoDB → hardcoded fallback.
// If the data is stale (different week) a background refresh is triggered.
async function getCache() {
  const weekKey = getWeekKey();

  // 1. In-memory hit for this week
  if (sp400Cache.weekKey === weekKey && sp400Cache.longs) return sp400Cache;

  // 2. MongoDB
  const mongo = await loadFromMongo();
  if (mongo?.longs?.length > 0) {
    sp400Cache = { weekKey: mongo.weekKey, longs: mongo.longs, shorts: mongo.shorts };
    // Stale data from a previous week → refresh in background
    if (mongo.weekKey !== weekKey && !refreshInProgress) {
      console.log(`📊 S&P 400: MongoDB data is from ${mongo.weekKey}, refreshing in background for ${weekKey}...`);
      refreshSp400Cache().catch(err => console.error('Background sp400 error:', err.message));
    }
    return sp400Cache;
  }

  // 3. Nothing anywhere → use hardcoded fallback and kick off background calculation
  console.log('📊 S&P 400: no cached data — using hardcoded fallback, calculating in background...');
  sp400Cache = { weekKey, longs: SPEC_LONGS, shorts: SPEC_SHORTS };
  if (!refreshInProgress) {
    refreshSp400Cache().catch(err => console.error('Background sp400 error:', err.message));
  }
  return sp400Cache;
}

export async function getSp400Longs()  { return (await getCache()).longs; }
export async function getSp400Shorts() { return (await getCache()).shorts; }
