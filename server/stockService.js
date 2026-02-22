import dotenv from 'dotenv';
import { getAllTickers } from './constituents.js';
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

  // If we already calculated stops for this week, return cached values
  if (stopPriceCache.weekKey === weekKey) {
    console.log(`📍 Using cached stop prices for week of ${weekKey}`);
    const result = { ...signalMap };
    for (const [ticker, stopPrice] of Object.entries(stopPriceCache.stops)) {
      if (result[ticker]) result[ticker] = { ...result[ticker], stopPrice };
    }
    return result;
  }

  // First load of this week — fetch from FMP and cache
  console.log(`📍 Calculating stop prices for week of ${weekKey} (${fromDate} → ${weekKey})...`);
  const result = { ...signalMap };
  const newStops = {};

  // Fetch 3 at a time to stay within FMP rate limits
  for (let i = 0; i < tickersWithSignals.length; i += 3) {
    const chunk = tickersWithSignals.slice(i, i + 3);
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
    if (i + 3 < tickersWithSignals.length) {
      await new Promise(r => setTimeout(r, 400));
    }
  }

  stopPriceCache = { weekKey, stops: newStops };
  console.log(`📍 Cached stop prices for ${Object.keys(newStops).length} tickers (valid until next Friday)`);
  return result;
}

// Fetch stock data and calculate YTD returns
export async function getTopStocks() {
  try {
    const tickers = await getAllTickers();
    console.log(`Fetching data for ${tickers.length} unique tickers from FMP...`);

    const yearStart = getYearStartDate();
    const stockData = [];

    // Process in smaller batches with limited concurrency to avoid FMP 429 rate limit
    const batchSize = 80;
    const concurrency = 5;
    for (let i = 0; i < tickers.length; i += batchSize) {
      const batch = tickers.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(tickers.length / batchSize);

      console.log(`Processing batch ${batchNum}/${totalBatches} (${batch.length} stocks)...`);

      for (let c = 0; c < batch.length; c += concurrency) {
        const chunk = batch.slice(c, c + concurrency);
        const chunkResults = await Promise.all(
          chunk.map(async (ticker) => {
            try {
              const [quote, profile, historical] = await Promise.all([
                fetchFMP(`/quote/${ticker}`),
                fetchFMP(`/profile/${ticker}`),
                fetchFMP(`/historical-price-full/${ticker}?from=${yearStart}&to=${yearStart}`)
              ]);
              if (!quote || !quote[0] || !profile || !profile[0]) return null;
              const quoteData = quote[0];
              const profileData = profile[0];
              let yearStartPrice = null;
              if (historical?.historical?.length > 0) {
                yearStartPrice = historical.historical[historical.historical.length - 1].close;
              }
              if (!yearStartPrice || !quoteData.price) return null;
              const currentPrice = quoteData.price;
              const ytdReturn = ((currentPrice - yearStartPrice) / yearStartPrice) * 100;
              return {
                ticker: quoteData.symbol,
                companyName: profileData.companyName || '',
                exchange: profileData.exchangeShortName || quoteData.exchange || 'N/A',
                sector: profileData.sector || 'N/A',
                currentPrice: parseFloat(currentPrice.toFixed(2)),
                ytdReturn: parseFloat(ytdReturn.toFixed(2))
              };
            } catch (error) {
              console.error(`Error fetching ${ticker}:`, error.message);
              return null;
            }
          })
        );
        stockData.push(...chunkResults.filter(Boolean));
        await new Promise((r) => setTimeout(r, 400));
      }

      console.log(`Batch ${batchNum} complete: ${stockData.length} stocks so far`);
      if (i + batchSize < tickers.length) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    // Sort by YTD: top 100 = long (highest first), bottom 100 = short (lowest first so #1 = largest loss)
    const sorted = [...stockData].sort((a, b) => b.ytdReturn - a.ytdReturn);
    const top100 = sorted.slice(0, 100);
    const bottom100 = [...sorted.slice(-100)].sort((a, b) => a.ytdReturn - b.ytdReturn); // ascending: worst = rank 1

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
