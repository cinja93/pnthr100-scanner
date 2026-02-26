import dotenv from 'dotenv';
import { getLatestSignals } from './database.js';
import { calculateStopPrices } from './stockService.js';

dotenv.config();

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';

// Cache results for 60 minutes
let etfCache = { data: null, timestamp: null };
const CACHE_TTL_MS = 60 * 60 * 1000;

// US exchange identifiers returned by FMP's etf/list
const US_EXCHANGES = new Set(['AMEX', 'NYSE', 'NASDAQ', 'ETF', 'BATS']);

async function fetchJson(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${FMP_BASE_URL}${path}${sep}apikey=${FMP_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP ${res.status} for ${path}`);
  return res.json();
}

// Batch fetch YTD % change via /stock-price-change (500 symbols per call).
// This endpoint returns ytd without needing historical year-start prices.
async function fetchYtdChanges(tickers) {
  const results = {};
  const BATCH = 500;
  for (let i = 0; i < tickers.length; i += BATCH) {
    const chunk = tickers.slice(i, i + BATCH);
    try {
      const data = await fetchJson(`/stock-price-change/${chunk.join(',')}`);
      if (Array.isArray(data)) {
        for (const item of data) {
          if (item.symbol && item.ytd != null) results[item.symbol] = item.ytd;
        }
      }
    } catch (err) {
      console.error(`ETF YTD batch error (batch ${Math.floor(i / BATCH) + 1}):`, err.message);
    }
    if (i + BATCH < tickers.length) await new Promise(r => setTimeout(r, 300));
  }
  return results;
}

// Batch fetch live quotes (current price, name, exchange) for up to 500 tickers at a time
async function fetchBulkQuotes(tickers) {
  const results = {};
  const BATCH = 500;
  for (let i = 0; i < tickers.length; i += BATCH) {
    const chunk = tickers.slice(i, i + BATCH);
    try {
      const data = await fetchJson(`/quote/${chunk.join(',')}`);
      if (Array.isArray(data)) {
        for (const q of data) if (q.symbol) results[q.symbol] = q;
      }
    } catch (err) {
      console.error(`ETF quote batch error:`, err.message);
    }
    if (i + BATCH < tickers.length) await new Promise(r => setTimeout(r, 300));
  }
  return results;
}

// Fetch profiles for up to 500 tickers in one call (for company name, exchange, sector)
async function fetchProfiles(tickers) {
  const results = {};
  try {
    const data = await fetchJson(`/profile/${tickers.join(',')}`);
    if (Array.isArray(data)) {
      for (const p of data) if (p.symbol) results[p.symbol] = p;
    }
  } catch (err) {
    console.error('ETF profile fetch error:', err.message);
  }
  return results;
}

export async function getEtfStocks(forceRefresh = false) {
  if (!forceRefresh && etfCache.data && Date.now() - etfCache.timestamp < CACHE_TTL_MS) {
    console.log('📊 ETF scan: serving from cache');
    return etfCache.data;
  }

  console.log('📊 ETF scan starting...');

  // 1. Fetch the full ETF list and filter to US-listed ETFs with meaningful price
  const etfList = await fetchJson('/etf/list');
  const usEtfs = Array.isArray(etfList)
    ? etfList.filter(e => e.price > 2 && US_EXCHANGES.has(e.exchangeShortName))
    : [];
  console.log(`📊 ETF universe: ${usEtfs.length} US-listed ETFs (price > $2)`);

  const allTickers = usEtfs.map(e => e.symbol);

  // 2. Fetch YTD % return for all ETFs via stock-price-change (reliable, no year-start price needed)
  const ytdMap = await fetchYtdChanges(allTickers);

  // 3. Sort by YTD descending, take top 100 tickers
  const sorted = usEtfs
    .filter(e => ytdMap[e.symbol] != null)
    .sort((a, b) => ytdMap[b.symbol] - ytdMap[a.symbol]);
  const top100 = sorted.slice(0, 100);
  const top100Tickers = top100.map(e => e.symbol);
  console.log(`📊 Top ${top100.length} ETFs selected — fetching live quotes & profiles...`);

  // 4. Fetch live quotes (fresh price) and profiles (company name, sector) for top 100
  const [quoteMap, profileMap] = await Promise.all([
    fetchBulkQuotes(top100Tickers),
    fetchProfiles(top100Tickers),
  ]);

  // 5. Build final stock objects using stock-price-change YTD (avoids year-start price gaps)
  //    Re-number rank sequentially after filtering any tickers with no live quote
  const stocks = top100
    .map(e => {
      const q = quoteMap[e.symbol];
      const p = profileMap[e.symbol];
      const price = q?.price || e.price;
      if (!price) return null;
      return {
        ticker: e.symbol,
        companyName: p?.companyName || q?.name || e.name || '',
        exchange: p?.exchangeShortName || q?.exchange || e.exchangeShortName || 'N/A',
        // FMP often returns 'Financial Services' for ETF issuers — fall back to 'ETF'
        sector: (p?.sector && p.sector !== '' && p.sector !== 'Financial Services')
          ? p.sector
          : 'ETF',
        currentPrice: parseFloat(Number(price).toFixed(2)),
        ytdReturn: parseFloat(Number(ytdMap[e.symbol]).toFixed(2)),
        rank: null,     // assigned below after filter
        rankChange: null,
        previousRank: null,
      };
    })
    .filter(Boolean)
    .map((s, i) => ({ ...s, rank: i + 1 })); // sequential ranks, no gaps

  // 6. Get signals and stop prices for the final stock list
  const stockTickers = stocks.map(s => s.ticker);
  const rawSignals = await getLatestSignals(stockTickers);
  const signals = await calculateStopPrices(rawSignals);

  console.log(`📊 ETF scan complete: ${stocks.length} ETFs`);
  const result = { stocks, signals };
  etfCache = { data: result, timestamp: Date.now() };
  return result;
}
