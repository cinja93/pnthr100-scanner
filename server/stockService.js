import dotenv from 'dotenv';
import { getAllTickers, getDow30Tickers } from './constituents.js';
import { addRankingComparison, addShortRankingComparison, autoSaveRankingIfFriday } from './rankingService.js';

dotenv.config();

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';

// Get the last trading day of the previous year (Dec 31, 2025)
function getYearStartDate() {
  const now = new Date();
  const year = now.getFullYear();
  return `${year - 1}-12-31`; // December 31st of previous year format: YYYY-MM-DD
}

// Fetch data from FMP API with retry on rate limit (429)
async function fetchFMP(endpoint, retries = 3) {
  const url = `${FMP_BASE_URL}${endpoint}${endpoint.includes('?') ? '&' : '?'}apikey=${FMP_API_KEY}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url);
      if (response.status === 429) {
        const waitMs = Math.min(1000 * Math.pow(2, attempt), 30000);
        console.log(`⏳ Rate limited (429), waiting ${waitMs / 1000}s before retry ${attempt}/${retries}...`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data.Error) throw new Error(data.Error);
      return data;
    } catch (error) {
      if (attempt === retries) throw new Error(error.message);
      const waitMs = 2000 * attempt;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw new Error('Max retries exceeded');
}

// Cache stop prices for the current week — keyed by last Friday's date so it
// auto-invalidates each new week without any manual expiry logic.
let stopPriceCache = { weekKey: null, stops: {} };
// Same week key, but for short-scan tickers that have no laser signal (we use SELL logic: high + 0.01)
let shortStopPriceCache = { weekKey: null, stops: {} };

// Year-start price cache — Dec 31 close is constant all year; cache indefinitely
// and only re-fetch when the calendar year rolls over or for newly-seen tickers.
let yearStartPriceCache = { year: null, prices: {} };

// Fetch year-start (Dec 31) close prices for a list of tickers.
// Already-cached tickers are returned immediately; only missing ones hit FMP.
async function getYearStartPrices(tickers) {
  const currentYear = new Date().getFullYear();
  const yearStart = getYearStartDate();

  // Reset on new year
  if (yearStartPriceCache.year !== currentYear) {
    yearStartPriceCache = { year: currentYear, prices: {} };
  }

  const missing = tickers.filter(t => !(t in yearStartPriceCache.prices));

  if (missing.length > 0) {
    console.log(`📅 Fetching year-start prices for ${missing.length} tickers...`);
    const concurrency = 15;
    for (let i = 0; i < missing.length; i += concurrency) {
      const chunk = missing.slice(i, i + concurrency);
      await Promise.all(chunk.map(async (ticker) => {
        try {
          const historical = await fetchFMP(`/historical-price-full/${ticker}?from=${yearStart}&to=${yearStart}`);
          if (historical?.historical?.length > 0) {
            yearStartPriceCache.prices[ticker] = historical.historical[historical.historical.length - 1].close;
          }
        } catch (err) {
          console.error(`Year-start price error for ${ticker}:`, err.message);
        }
      }));
      if (i + concurrency < missing.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }
    console.log(`📅 Year-start prices cached: ${Object.keys(yearStartPriceCache.prices).length} tickers`);
  }

  return yearStartPriceCache.prices;
}

// Calculate stop prices for tickers that have signals using 2-week price history:
//   BUY / YELLOW_BUY  → lowest low of the 2 most recent complete trading weeks − $0.01
//   SELL / YELLOW_SELL → highest high of the 2 most recent complete trading weeks + $0.01
//
// Results are cached for the whole week so FMP is only called once per week,
// not on every page load.
export async function calculateStopPrices(signalMap) {
  const tickersWithSignals = Object.entries(signalMap).filter(([, data]) => data.signal);
  if (tickersWithSignals.length === 0) return signalMap;

  // Find the most recently completed Friday
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0=Sun … 5=Fri … 6=Sat
  const daysToLastFriday = dayOfWeek === 5 ? 0 : (dayOfWeek + 2) % 7;
  const lastFriday = new Date(today);
  lastFriday.setDate(today.getDate() - daysToLastFriday);
  const weekKey = lastFriday.toISOString().split('T')[0]; // e.g. "2026-02-20"

  // Two full trading weeks = 14 calendar days back from that Friday
  const twoWeeksBeforeFriday = new Date(lastFriday);
  twoWeeksBeforeFriday.setDate(lastFriday.getDate() - 14);
  const fromDate = twoWeeksBeforeFriday.toISOString().split('T')[0];

  const result = { ...signalMap };

  // Apply any already-cached stops for this week (cache is shared across long + short lists)
  if (stopPriceCache.weekKey === weekKey) {
    for (const [ticker, stopPrice] of Object.entries(stopPriceCache.stops)) {
      if (result[ticker]) result[ticker] = { ...result[ticker], stopPrice };
    }
  } else {
    stopPriceCache = { weekKey, stops: {} };
  }

  // Find tickers that still need a stop computed (not in cache or first load this week)
  const needCompute = tickersWithSignals.filter(([ticker]) => result[ticker]?.stopPrice == null);
  if (needCompute.length === 0) {
    console.log(`📍 Using cached stop prices for week of ${weekKey}`);
    return result;
  }

  console.log(`📍 Calculating stop prices for week of ${weekKey} (${fromDate} → ${weekKey})...`);
  const newStops = {};

  // Fetch 3 at a time to stay within FMP rate limits
  for (let i = 0; i < needCompute.length; i += 3) {
    const chunk = needCompute.slice(i, i + 3);
    await Promise.all(chunk.map(async ([ticker, data]) => {
      try {
        const history = await fetchFMP(`/historical-price-full/${ticker}?from=${fromDate}&to=${weekKey}`);
        if (!history?.historical?.length) return;

        let stopPrice;
        if (data.signal === 'BUY' || data.signal === 'YELLOW_BUY') {
          const lowestLow = Math.min(...history.historical.map(d => d.low));
          stopPrice = parseFloat((lowestLow - 0.01).toFixed(2));
        } else if (data.signal === 'SELL' || data.signal === 'YELLOW_SELL') {
          const highestHigh = Math.max(...history.historical.map(d => d.high));
          stopPrice = parseFloat((highestHigh + 0.01).toFixed(2));
        }
        if (stopPrice !== undefined) {
          result[ticker] = { ...result[ticker], stopPrice };
          newStops[ticker] = stopPrice;
        }
      } catch (err) {
        console.error(`Stop price error for ${ticker}:`, err.message);
      }
    }));
    if (i + 3 < needCompute.length) {
      await new Promise(r => setTimeout(r, 400));
    }
  }

  // Merge into cache so long and short lists both persist
  stopPriceCache.stops = { ...stopPriceCache.stops, ...newStops };
  console.log(`📍 Cached stop prices for ${Object.keys(stopPriceCache.stops).length} tickers (valid until next Friday)`);
  return result;
}

// Get week key (last Friday) and fromDate (14 days before) for 2-week lookback
function getStopPriceWeekRange() {
  const today = new Date();
  const dayOfWeek = today.getDay();
  const daysToLastFriday = dayOfWeek === 5 ? 0 : (dayOfWeek + 2) % 7;
  const lastFriday = new Date(today);
  lastFriday.setDate(today.getDate() - daysToLastFriday);
  const weekKey = lastFriday.toISOString().split('T')[0];
  const twoWeeksBeforeFriday = new Date(lastFriday);
  twoWeeksBeforeFriday.setDate(lastFriday.getDate() - 14);
  const fromDate = twoWeeksBeforeFriday.toISOString().split('T')[0];
  return { weekKey, fromDate };
}

// For short-scan tickers with no laser signal: compute stop as highest high + $0.01 (short exit level).
// Cached per week like calculateStopPrices.
export async function getShortStopPrices(tickers) {
  if (!tickers || tickers.length === 0) return {};
  const { weekKey, fromDate } = getStopPriceWeekRange();
  const result = {};
  const upperTickers = tickers.map(t => (typeof t === 'string' ? t : t.ticker || t).toUpperCase());

  if (shortStopPriceCache.weekKey !== weekKey) {
    shortStopPriceCache = { weekKey, stops: {} };
  }

  for (const ticker of upperTickers) {
    const stopPrice = shortStopPriceCache.stops[ticker];
    if (stopPrice != null) result[ticker] = { stopPrice };
  }
  const toFetch = upperTickers.filter(t => shortStopPriceCache.stops[t] == null);
  if (toFetch.length === 0) return result;

  if (toFetch.length > 0) {
    console.log(`📍 Calculating short stop prices for ${toFetch.length} tickers (week of ${weekKey})...`);
    for (let i = 0; i < toFetch.length; i += 3) {
      const chunk = toFetch.slice(i, i + 3);
      await Promise.all(chunk.map(async (ticker) => {
        try {
          const history = await fetchFMP(`/historical-price-full/${ticker}?from=${fromDate}&to=${weekKey}`);
          if (!history?.historical?.length) return;
          const highestHigh = Math.max(...history.historical.map(d => d.high));
          const stopPrice = parseFloat((highestHigh + 0.01).toFixed(2));
          shortStopPriceCache.stops[ticker] = stopPrice;
          result[ticker] = { stopPrice };
        } catch (err) {
          console.error(`Short stop price error for ${ticker}:`, err.message);
        }
      }));
      if (i + 3 < toFetch.length) await new Promise(r => setTimeout(r, 400));
    }
  }
  return result;
}

// Fetch stock data and calculate YTD returns.
// Uses FMP bulk quote + profile endpoints (2 calls instead of ~200),
// plus a year-long in-memory cache for Dec 31 prices.
export async function getTopStocks() {
  try {
    const tickers = await getAllTickers();
    console.log(`Fetching data for ${tickers.length} unique tickers from FMP...`);

    // ── Step 1: Bulk fetch quotes (200 tickers per call) ──────────────────────
    console.log('📊 Bulk fetching quotes...');
    const quoteMap = {};
    const bulkChunk = 200;
    for (let i = 0; i < tickers.length; i += bulkChunk) {
      const chunk = tickers.slice(i, i + bulkChunk);
      try {
        const quotes = await fetchFMP(`/quote/${chunk.join(',')}`);
        if (Array.isArray(quotes)) {
          for (const q of quotes) quoteMap[q.symbol] = q;
        }
      } catch (err) {
        console.error(`Bulk quote error (chunk ${i / bulkChunk + 1}):`, err.message);
      }
      if (i + bulkChunk < tickers.length) await new Promise(r => setTimeout(r, 500));
    }
    console.log(`✅ Quotes received for ${Object.keys(quoteMap).length} tickers`);

    // ── Step 2: Bulk fetch profiles (200 tickers per call) ───────────────────
    console.log('🏢 Bulk fetching profiles...');
    const profileMap = {};
    for (let i = 0; i < tickers.length; i += bulkChunk) {
      const chunk = tickers.slice(i, i + bulkChunk);
      try {
        const profiles = await fetchFMP(`/profile/${chunk.join(',')}`);
        if (Array.isArray(profiles)) {
          for (const p of profiles) profileMap[p.symbol] = p;
        }
      } catch (err) {
        console.error(`Bulk profile error (chunk ${i / bulkChunk + 1}):`, err.message);
      }
      if (i + bulkChunk < tickers.length) await new Promise(r => setTimeout(r, 500));
    }
    console.log(`✅ Profiles received for ${Object.keys(profileMap).length} tickers`);

    // ── Step 3: Year-start prices (cached after first run) ───────────────────
    const yearStartPrices = await getYearStartPrices(tickers);

    // ── Step 4: Assemble stock objects ────────────────────────────────────────
    const stockData = [];
    for (const ticker of tickers) {
      const quoteData = quoteMap[ticker];
      const profileData = profileMap[ticker];
      const yearStartPrice = yearStartPrices[ticker];

      if (!quoteData || !yearStartPrice || !quoteData.price) continue;

      const currentPrice = quoteData.price;
      const ytdReturn = ((currentPrice - yearStartPrice) / yearStartPrice) * 100;
      stockData.push({
        ticker: quoteData.symbol,
        companyName: profileData?.companyName || quoteData.name || '',
        exchange: profileData?.exchangeShortName || quoteData.exchange || 'N/A',
        sector: profileData?.sector || 'N/A',
        currentPrice: parseFloat(currentPrice.toFixed(2)),
        ytdReturn: parseFloat(ytdReturn.toFixed(2)),
      });
    }

    // Sort by YTD: top 100 = long (highest first), bottom 100 = short (lowest first so #1 = largest loss)
    const sorted = [...stockData].sort((a, b) => b.ytdReturn - a.ytdReturn);
    const top100 = sorted.slice(0, 100);
    const bottom100 = [...sorted.slice(-100)].sort((a, b) => a.ytdReturn - b.ytdReturn);

    console.log(`✅ Fetched ${stockData.length} stocks: top 100 (long) + bottom 100 (short)`);
    console.log(`Long: #1 ${top100[0]?.ticker} +${top100[0]?.ytdReturn}% YTD | Short: #1 ${bottom100[0]?.ticker} (largest loss) ${bottom100[0]?.ytdReturn}% YTD`);

    const [longWithRankings, shortWithRankings] = await Promise.all([
      addRankingComparison(top100),
      addShortRankingComparison(bottom100)
    ]);

    await autoSaveRankingIfFriday(longWithRankings, shortWithRankings);

    return { long: longWithRankings, short: shortWithRankings };
  } catch (error) {
    console.error('Error in getTopStocks:', error);
    throw error;
  }
}

// Fetch live stock data for an arbitrary list of tickers (used by Watchlist).
// Uses shared bulk endpoints and year-start price cache.
export async function getWatchlistStocks(tickers) {
  if (!tickers || tickers.length === 0) return [];

  const [quoteArr, profileArr, yearStartPrices] = await Promise.all([
    fetchFMP(`/quote/${tickers.join(',')}`).catch(() => []),
    fetchFMP(`/profile/${tickers.join(',')}`).catch(() => []),
    getYearStartPrices(tickers),
  ]);

  const quoteMap = {};
  if (Array.isArray(quoteArr)) for (const q of quoteArr) quoteMap[q.symbol] = q;
  const profileMap = {};
  if (Array.isArray(profileArr)) for (const p of profileArr) profileMap[p.symbol] = p;

  return tickers.map(ticker => {
    const quoteData = quoteMap[ticker];
    const profileData = profileMap[ticker];
    const yearStartPrice = yearStartPrices[ticker];

    if (!quoteData || !yearStartPrice || !quoteData.price) return null;

    const currentPrice = quoteData.price;
    const ytdReturn = ((currentPrice - yearStartPrice) / yearStartPrice) * 100;
    return {
      ticker: quoteData.symbol,
      companyName: profileData?.companyName || quoteData.name || '',
      exchange: profileData?.exchangeShortName || quoteData.exchange || 'N/A',
      sector: profileData?.sector || 'N/A',
      currentPrice: parseFloat(currentPrice.toFixed(2)),
      ytdReturn: parseFloat(ytdReturn.toFixed(2)),
      rank: null,
      rankChange: null,
      previousRank: null,
    };
  }).filter(Boolean);
}

// Fetch live stock data for the full PNTHR 679 Jungle universe:
// getAllTickers() (SP517) + specLongs (SP400 Long leaders) + specShorts (SP400 Short leaders).
// Returns sorted by YTD desc with universe field: 'sp517' | 'sp400Long' | 'sp400Short'.
export async function getJungleStocks(specLongs = [], specShorts = []) {
  const [sp517, dow30List] = await Promise.all([getAllTickers(), getDow30Tickers()]);
  const specLongsSet  = new Set(specLongs);
  const specShortsSet = new Set(specShorts);
  const dow30Set      = new Set(dow30List);
  const allTickers = [...new Set([...sp517, ...specLongs, ...specShorts])];

  console.log(`🌿 Jungle: ${allTickers.length} unique tickers (${sp517.length} SP517 + ${specLongs.length} 400L + ${specShorts.length} 400S + ${dow30List.length} Dow30)`);

  const CHUNK = 200;
  const quoteMap   = {};
  const profileMap = {};

  for (let i = 0; i < allTickers.length; i += CHUNK) {
    const chunk = allTickers.slice(i, i + CHUNK);
    const [quotes, profiles] = await Promise.all([
      fetchFMP(`/quote/${chunk.join(',')}`).catch(() => []),
      fetchFMP(`/profile/${chunk.join(',')}`).catch(() => []),
    ]);
    if (Array.isArray(quotes))   for (const q of quotes)   quoteMap[q.symbol]   = q;
    if (Array.isArray(profiles)) for (const p of profiles) profileMap[p.symbol] = p;
    if (i + CHUNK < allTickers.length) await new Promise(r => setTimeout(r, 300));
  }

  const yearStartPrices = await getYearStartPrices(allTickers);

  const stocks = [];
  for (const ticker of allTickers) {
    const q   = quoteMap[ticker];
    const p   = profileMap[ticker];
    const ysp = yearStartPrices[ticker];
    if (!q || !ysp || !q.price) continue;

    const currentPrice = q.price;
    const ytdReturn    = ((currentPrice - ysp) / ysp) * 100;
    const universe     = specLongsSet.has(ticker)  ? 'sp400Long'
                       : specShortsSet.has(ticker) ? 'sp400Short'
                       : 'sp517';

    stocks.push({
      ticker:      q.symbol,
      companyName: p?.companyName || q.name || '',
      exchange:    p?.exchangeShortName || q.exchange || 'N/A',
      sector:      p?.sector || 'N/A',
      currentPrice: parseFloat(currentPrice.toFixed(2)),
      ytdReturn:    parseFloat(ytdReturn.toFixed(2)),
      universe,
      isDow30:     dow30Set.has(q.symbol),
      rank: null,
      rankChange: null,
    });
  }

  // Always enforce exactly 679 — spec stocks (400L/400S) are protected; trim lowest-YTD sp517 if needed
  const TARGET = 679;
  const specSet = new Set([...specLongs, ...specShorts]);
  const sorted = stocks.sort((a, b) => b.ytdReturn - a.ytdReturn);
  const specStocks  = sorted.filter(s => specSet.has(s.ticker));
  const sp517Stocks = sorted.filter(s => !specSet.has(s.ticker));
  const allowedSp517 = Math.max(0, TARGET - specStocks.length);
  const trimmed = [...sp517Stocks.slice(0, allowedSp517), ...specStocks]
    .sort((a, b) => b.ytdReturn - a.ytdReturn)
    .slice(0, TARGET); // hard cap in case of any edge-case rounding

  console.log(`🌿 Jungle final: ${trimmed.length} stocks (sp517: ${Math.min(sp517Stocks.length, allowedSp517)}, spec: ${specStocks.length}, target: ${TARGET})`);
  return trimmed.map((s, i) => ({ ...s, rank: i + 1 }));
}
