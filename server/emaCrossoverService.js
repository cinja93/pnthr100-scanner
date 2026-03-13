import dotenv from 'dotenv';
import { getAllTickers } from './constituents.js';
import { getWatchlistStocks } from './stockService.js';
import { getSignals } from './signalService.js';
import { connectToDatabase } from './database.js';

dotenv.config();

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';

// Cache results for 60 minutes — the full-universe scan is expensive on first run.
let emaCrossoverCache = { data: null, timestamp: null };
const CACHE_TTL_MS = 60 * 60 * 1000;
const MONGO_COLLECTION = 'ema_crossover_cache';
let refreshInProgress = false;

// ── MongoDB helpers ───────────────────────────────────────────────────────────
async function loadFromMongo() {
  try {
    const db = await connectToDatabase();
    if (!db) return null;
    return await db.collection(MONGO_COLLECTION).findOne({}, { sort: { updatedAt: -1 } });
  } catch { return null; }
}

async function saveToMongo(result) {
  try {
    const db = await connectToDatabase();
    if (!db) return;
    await db.collection(MONGO_COLLECTION).replaceOne(
      {},
      { stocks: result.stocks, signals: result.signals, updatedAt: new Date() },
      { upsert: true }
    );
    console.log('📊 EMA crossover cache saved to MongoDB');
  } catch (err) {
    console.error('EMA crossover MongoDB save error:', err.message);
  }
}

// Aggregate daily OHLCV to weekly (keyed by Monday of each week; weekly close = last trading day of week)
function aggregateToWeekly(dailyData) {
  const sorted = [...dailyData].sort((a, b) => (a.date < b.date ? -1 : 1));
  const weeksMap = new Map();
  for (const day of sorted) {
    const date = new Date(day.date + 'T00:00:00');
    const dow = date.getDay();
    const monday = new Date(date);
    monday.setDate(date.getDate() - (dow === 0 ? 6 : dow - 1));
    const weekKey = monday.toISOString().split('T')[0];
    if (!weeksMap.has(weekKey)) {
      weeksMap.set(weekKey, { time: weekKey, close: day.close });
    } else {
      weeksMap.get(weekKey).close = day.close;
    }
  }
  return [...weeksMap.values()]; // ascending by time
}

// 21-period EMA on ascending weekly close data
function calculateEMA21(weeklyData) {
  if (weeklyData.length < 21) return [];
  const k = 2 / 22;
  let ema = weeklyData.slice(0, 21).reduce((sum, d) => sum + d.close, 0) / 21;
  const result = [{ time: weeklyData[20].time, ema }];
  for (let i = 21; i < weeklyData.length; i++) {
    ema = weeklyData[i].close * k + ema * (1 - k);
    result.push({ time: weeklyData[i].time, ema });
  }
  return result;
}

// Fetch ~7 months of daily price history (21 weeks for EMA warm-up + a few extra)
async function fetchHistory(ticker) {
  const from = new Date();
  from.setMonth(from.getMonth() - 7);
  const fromStr = from.toISOString().split('T')[0];
  const url = `${FMP_BASE_URL}/historical-price-full/${ticker}?from=${fromStr}&apikey=${FMP_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP ${res.status}`);
  const data = await res.json();
  return data.historical || [];
}

// Returns true only if an actual EMA crossover happened within the past 2 COMPLETED calendar weeks.
//
// Root cause of the "wrong position" bug: using slice(-3) picks bars by array index, which shifts
// whenever FMP doesn't have the most recent week's data for a stock. Instead we use explicit
// Monday-based week-key boundaries so every stock is measured against the same calendar window.
//
// Window: the 2 most recently completed weekly bars (< this Monday, >= 2 Mondays ago).
// Reference: the most recent bar BEFORE that window — must be on the OPPOSITE side of the EMA.
// At least one bar inside the window must be on the CORRECT side (the actual crossover).
function checkRecentCrossover(signal, daily) {
  const weekly = aggregateToWeekly(daily);
  const emaData = calculateEMA21(weekly);
  if (emaData.length < 4) return false;

  // Build Monday-based calendar boundaries (all dates as YYYY-MM-DD strings for direct comparison)
  const now = new Date();
  const dow = now.getDay(); // 0 = Sunday
  const thisMonday = new Date(now);
  thisMonday.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
  thisMonday.setHours(0, 0, 0, 0);
  const thisMondayKey       = thisMonday.toISOString().split('T')[0];

  const twoWeeksAgoMonday = new Date(thisMonday);
  twoWeeksAgoMonday.setDate(thisMonday.getDate() - 14);
  const twoWeeksAgoKey = twoWeeksAgoMonday.toISOString().split('T')[0];

  const closes = new Map(weekly.map(w => [w.time, w.close]));

  // Window bars: completed weeks within the 2-week window (exclude the current in-progress week)
  const windowBars = emaData.filter(b => b.time >= twoWeeksAgoKey && b.time < thisMondayKey);
  // Reference bars: all completed weeks strictly before the window
  const refBars    = emaData.filter(b => b.time < twoWeeksAgoKey);

  if (windowBars.length === 0 || refBars.length === 0) return false;

  // Use only the most recent reference bar — the one right before the window opened
  const refBar   = refBars[refBars.length - 1];
  const refClose = closes.get(refBar.time);
  if (refClose == null) return false;

  const isBuy = signal === 'BL';

  if (isBuy) {
    const wasBelow    = refClose < refBar.ema;
    const crossedAbove = windowBars.some(b => {
      const c = closes.get(b.time);
      return c != null && c >= b.ema;
    });
    return wasBelow && crossedAbove;
  } else {
    const wasAbove    = refClose > refBar.ema;
    const crossedBelow = windowBars.some(b => {
      const c = closes.get(b.time);
      return c != null && c <= b.ema;
    });
    return wasAbove && crossedBelow;
  }
}

async function runEmaCrossoverScan() {
  if (refreshInProgress) return emaCrossoverCache.data;
  refreshInProgress = true;
  console.log('📊 EMA crossover scan starting (full universe: S&P 500 + NASDAQ 100 + Dow 30)...');
  try {
    // 1. Full universe from constituents.js (same lists used by the main scanner)
    const allTickers = await getAllTickers(); // ~600–700 unique tickers
    console.log(`📊 Universe: ${allTickers.length} tickers`);

    // 2. Get signals for all tickers using the main state machine (5yr data, BL/SS/BE/SE format)
    const rawSignals = await getSignals(allTickers);
    // Only check BL/SS — crossover is only meaningful on entry signals, not exits
    const tickersWithSignals = allTickers.filter(t => rawSignals[t]?.signal === 'BL' || rawSignals[t]?.signal === 'SS');
    console.log(`📊 ${tickersWithSignals.length} tickers have signals — checking EMA crossover...`);

    // 3. Fetch price history and test the actual crossover condition (5 concurrent, 300ms delay)
    const matchingTickers = [];
    const matchingSignalsMap = {};
    const CONCURRENCY = 5;

    for (let i = 0; i < tickersWithSignals.length; i += CONCURRENCY) {
      const chunk = tickersWithSignals.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(async ticker => {
        try {
          const signal = rawSignals[ticker].signal;
          const daily = await fetchHistory(ticker);
          if (checkRecentCrossover(signal, daily)) {
            matchingTickers.push(ticker);
            matchingSignalsMap[ticker] = rawSignals[ticker];
          }
        } catch (err) {
          console.error(`EMA crossover error for ${ticker}:`, err.message);
        }
      }));
      if (i + CONCURRENCY < tickersWithSignals.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    console.log(`📊 ${matchingTickers.length} tickers passed the crossover test — fetching metadata...`);

    // 4. Fetch stock metadata (quote, profile, YTD) only for the matching set — fast since it's a small list
    const matchingStocks = matchingTickers.length > 0
      ? await getWatchlistStocks(matchingTickers)
      : [];

    console.log(`📊 EMA crossover complete: ${matchingStocks.length} stocks`);
    // getSignals() already includes stopPrice — no separate calculateStopPrices() call needed
    const result = { stocks: matchingStocks, signals: matchingSignalsMap };
    emaCrossoverCache = { data: result, timestamp: Date.now() };
    await saveToMongo(result);
    return result;
  } catch (err) {
    console.error('❌ EMA crossover scan failed:', err.message);
    throw err;
  } finally {
    refreshInProgress = false;
  }
}

export async function getEmaCrossoverStocks(forceRefresh = false) {
  // 1. In-memory cache hit
  if (!forceRefresh && emaCrossoverCache.data && Date.now() - emaCrossoverCache.timestamp < CACHE_TTL_MS) {
    console.log('📊 EMA crossover: serving from in-memory cache');
    return emaCrossoverCache.data;
  }

  // 2. MongoDB fallback — serves stale data instantly while refresh runs in background
  const mongo = await loadFromMongo();
  if (mongo?.stocks) {
    const result = { stocks: mongo.stocks, signals: mongo.signals || {} };
    emaCrossoverCache = { data: result, timestamp: Date.now() };
    const ageHours = mongo.updatedAt ? (Date.now() - new Date(mongo.updatedAt).getTime()) / 3600000 : 999;
    if (forceRefresh || ageHours > 1) {
      console.log(`📊 EMA crossover: MongoDB data is ${ageHours.toFixed(1)}h old — refreshing in background...`);
      if (!refreshInProgress) runEmaCrossoverScan().catch(err => console.error('Background EMA crossover error:', err.message));
    } else {
      console.log('📊 EMA crossover: serving from MongoDB cache');
    }
    return result;
  }

  // 3. Nothing cached — run full scan now (will be slow on first cold start)
  console.log('📊 EMA crossover: no cached data, running full scan...');
  try {
    return await runEmaCrossoverScan();
  } finally {
    refreshInProgress = false;
  }
}
