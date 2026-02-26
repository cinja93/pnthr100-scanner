import express from 'express';
import cors from 'cors';
import { getTopStocks, calculateStopPrices, getShortStopPrices, getWatchlistStocks } from './stockService.js';
import { enrichWithSignals, optimizeWithRason } from './portfolioService.js';
import { getEmaCrossoverStocks } from './emaCrossoverService.js';
import { getEtfStocks } from './etfService.js';
import {
  getSupplementalStocks,
  addSupplementalStock,
  removeSupplementalStock,
  getWatchlistTickers,
  addToWatchlist,
  removeFromWatchlist,
  getAllRankings,
  getRankingByDate,
  getStockHistory,
  getLatestSignals,
  getListEntryDates,
} from './database.js';

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// API key authentication — protects all /api/* routes
const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  console.error('⚠️  API_KEY is not set in .env — all /api requests will be rejected');
}
app.use('/api', (req, res, next) => {
  const key = req.headers['x-api-key'];
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// Cache for stock data (refresh every 5 minutes)
let cachedData = null;
let lastFetch = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes in milliseconds

let cachedPortfolio = null;
let lastPortfolioFetch = null;

// Fetch company names from FMP bulk quote and merge into a stocks array.
// Only fills in entries where companyName is missing/empty.
async function enrichCompanyNames(stocks) {
  if (!stocks || stocks.length === 0) return stocks;
  const missing = stocks.filter(s => !s.companyName);
  if (missing.length === 0) return stocks;

  try {
    const tickers = [...new Set(stocks.map(s => s.ticker))];
    const FMP_API_KEY = process.env.FMP_API_KEY;
    const url = `https://financialmodelingprep.com/api/v3/quote/${tickers.join(',')}?apikey=${FMP_API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) return stocks;
    const quotes = await response.json();
    if (!Array.isArray(quotes)) return stocks;

    const nameMap = {};
    for (const q of quotes) if (q.symbol && q.name) nameMap[q.symbol] = q.name;

    return stocks.map(s => ({ ...s, companyName: s.companyName || nameMap[s.ticker] || '' }));
  } catch (err) {
    console.error('enrichCompanyNames error:', err.message);
    return stocks;
  }
}

// Cache for sector performance data (refresh every hour)
let sectorCache = null;
let sectorCacheTime = null;
const SECTOR_CACHE_DURATION = 60 * 60 * 1000; // 1 hour — bust cache by restarting server

// SPDR sector ETF ticker → internal sector key
// These are the same ETFs that Barchart and most platforms use as sector benchmarks.
const SECTOR_ETF_MAP = {
  XLC:  'communicationServices',
  XLY:  'consumerDiscretionary',
  XLP:  'consumerStaples',
  XLE:  'energy',
  XLF:  'financials',
  XLV:  'healthCare',
  XLI:  'industrials',
  XLK:  'informationTechnology',
  XLB:  'materials',
  XLRE: 'realEstate',
  XLU:  'utilities',
};

// Fetch 14 months of daily closes for all 11 sector ETFs.
// FMP's bulk historical endpoint silently caps at 5 tickers, so we fetch each
// ETF individually in parallel and merge the results.
async function fetchEtfSectorData() {
  const FMP_API_KEY = process.env.FMP_API_KEY;

  // 14 months so we have a prior-day close for the first day we want to show
  const from = new Date();
  from.setMonth(from.getMonth() - 14);
  const fromStr = from.toISOString().split('T')[0];

  // Fetch all 11 ETFs concurrently (individual requests — bulk caps at 5)
  const etfSymbols = Object.keys(SECTOR_ETF_MAP);
  const closesBySymbol = {};
  await Promise.all(etfSymbols.map(async symbol => {
    try {
      const url = `https://financialmodelingprep.com/api/v3/historical-price-full/${symbol}?from=${fromStr}&apikey=${FMP_API_KEY}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`FMP ${res.status}`);
      const data = await res.json();
      if (Array.isArray(data.historical) && data.historical.length > 0) {
        closesBySymbol[symbol] = [...data.historical]
          .sort((a, b) => (a.date < b.date ? -1 : 1))
          .map(d => ({ date: d.date, close: d.close }));
      } else {
        console.warn(`No historical data returned for ${symbol}`);
      }
    } catch (err) {
      console.error(`ETF history fetch error for ${symbol}:`, err.message);
    }
  }));
  console.log(`📊 Sector ETF data fetched for: ${Object.keys(closesBySymbol).join(', ')}`);

  // Compute daily % return for each ETF: { symbol: { date: pct } }
  const dailyReturnsBySymbol = {};
  for (const [symbol, bars] of Object.entries(closesBySymbol)) {
    dailyReturnsBySymbol[symbol] = {};
    for (let i = 1; i < bars.length; i++) {
      const prev = bars[i - 1].close;
      const curr = bars[i].close;
      if (prev && curr) {
        dailyReturnsBySymbol[symbol][bars[i].date] =
          parseFloat(((curr - prev) / prev * 100).toFixed(4));
      }
    }
  }

  // Collect trading dates present in any ETF, filter to last 13 months, sort ascending
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 13);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const allDates = new Set();
  for (const returns of Object.values(dailyReturnsBySymbol)) {
    for (const date of Object.keys(returns)) {
      if (date >= cutoffStr) allDates.add(date);
    }
  }
  const sortedDates = [...allDates].sort();

  // Build output: one entry per trading day with all 11 sector % changes
  return sortedDates.map(date => {
    const sectors = {};
    for (const [symbol, sectorKey] of Object.entries(SECTOR_ETF_MAP)) {
      sectors[sectorKey] = dailyReturnsBySymbol[symbol]?.[date] ?? 0;
    }
    return { date, sectors };
  });
}

// Fetch once; cache holds { long, short }
async function getStocksCache(skipCache = false) {
  const now = Date.now();
  if (!skipCache && cachedData && lastFetch && (now - lastFetch) < CACHE_DURATION) {
    return cachedData;
  }
  console.log('Fetching fresh stock data (long + short)...');
  const data = await getTopStocks();
  cachedData = data;
  lastFetch = now;
  return data;
}

// Long scan: top 100 by YTD return
app.get('/api/stocks', async (req, res) => {
  try {
    const skipCache = req.query.refresh === '1' || req.query.refresh === 'true';
    const data = await getStocksCache(skipCache);
    const stocks = await enrichCompanyNames(data.long);
    res.json(stocks);
  } catch (error) {
    console.error('Error fetching stocks:', error);
    res.status(500).json({ error: 'Failed to fetch stock data' });
  }
});

// Short scan: bottom 100 by YTD return (shorting opportunities)
app.get('/api/stocks/shorts', async (req, res) => {
  try {
    const skipCache = req.query.refresh === '1' || req.query.refresh === 'true';
    const data = await getStocksCache(skipCache);
    const stocks = await enrichCompanyNames(data.short);
    res.json(stocks);
  } catch (error) {
    console.error('Error fetching short stocks:', error);
    res.status(500).json({ error: 'Failed to fetch short stock data' });
  }
});

// EMA Crossover scan: stocks with a BUY signal + weekly close >= 21-week EMA, or
// SELL signal + weekly close <= 21-week EMA, within the last 2 completed weeks.
// Universe: top 100 long + top 100 short. Cached 60 min; pass ?refresh=1 to bust.
app.get('/api/stocks/ema-crossover', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1';
    const result = await getEmaCrossoverStocks(forceRefresh);
    res.json(result);
  } catch (error) {
    console.error('Error running EMA crossover scan:', error);
    res.status(500).json({ error: 'Failed to run EMA crossover scan' });
  }
});

// ETF scan: top 100 US ETFs by YTD return with signals. Cached 60 min; pass ?refresh=1 to bust.
app.get('/api/stocks/etfs', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1';
    const result = await getEtfStocks(forceRefresh);
    res.json(result);
  } catch (error) {
    console.error('Error running ETF scan:', error);
    res.status(500).json({ error: 'Failed to run ETF scan' });
  }
});

// Get all user-added supplemental stocks
app.get('/api/supplemental-stocks', async (req, res) => {
  try {
    const stocks = await getSupplementalStocks();
    res.json(stocks);
  } catch (error) {
    console.error('Error fetching supplemental stocks:', error);
    res.status(500).json({ error: 'Failed to fetch supplemental stocks' });
  }
});

// Add a supplemental stock
app.post('/api/supplemental-stocks', async (req, res) => {
  try {
    const { ticker } = req.body;

    if (!ticker || typeof ticker !== 'string') {
      return res.status(400).json({ error: 'Ticker is required and must be a string' });
    }

    // Validate ticker format (uppercase letters, potentially with dots/hyphens)
    const tickerUpper = ticker.toUpperCase();
    if (!/^[A-Z]+[A-Z.\-]*$/.test(tickerUpper)) {
      return res.status(400).json({ error: 'Invalid ticker format. Use uppercase letters only.' });
    }

    const result = await addSupplementalStock(tickerUpper);

    // Clear cache when supplemental stocks change
    cachedData = null;
    lastFetch = null;

    res.json(result);
  } catch (error) {
    console.error('Error adding supplemental stock:', error);

    // Return appropriate error message
    if (error.message.includes('already exists')) {
      res.status(409).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to add supplemental stock' });
    }
  }
});

// Remove a supplemental stock
app.delete('/api/supplemental-stocks/:ticker', async (req, res) => {
  try {
    const { ticker } = req.params;
    const result = await removeSupplementalStock(ticker);

    // Clear cache when supplemental stocks change
    cachedData = null;
    lastFetch = null;

    res.json(result);
  } catch (error) {
    console.error('Error removing supplemental stock:', error);

    // Return appropriate error message
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to remove supplemental stock' });
    }
  }
});

// ── Watchlist ──

// Get all watchlist stocks with live data
app.get('/api/watchlist', async (req, res) => {
  try {
    const tickers = await getWatchlistTickers();
    if (tickers.length === 0) return res.json([]);
    const stocks = await getWatchlistStocks(tickers);
    res.json(stocks);
  } catch (error) {
    console.error('Error fetching watchlist:', error);
    res.status(500).json({ error: 'Failed to fetch watchlist' });
  }
});

// Add a ticker to the watchlist
app.post('/api/watchlist', async (req, res) => {
  try {
    const { ticker } = req.body;
    if (!ticker || typeof ticker !== 'string') {
      return res.status(400).json({ error: 'Ticker is required' });
    }
    const tickerUpper = ticker.toUpperCase().trim();
    if (!/^[A-Z]{1,5}[A-Z.\-]*$/.test(tickerUpper)) {
      return res.status(400).json({ error: 'Invalid ticker format' });
    }
    const result = await addToWatchlist(tickerUpper);
    res.json(result);
  } catch (error) {
    console.error('Error adding to watchlist:', error);
    if (error.message.includes('already on your watchlist')) {
      res.status(409).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to add to watchlist' });
    }
  }
});

// Remove a ticker from the watchlist
app.delete('/api/watchlist/:ticker', async (req, res) => {
  try {
    const { ticker } = req.params;
    const result = await removeFromWatchlist(ticker);
    res.json(result);
  } catch (error) {
    console.error('Error removing from watchlist:', error);
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to remove from watchlist' });
    }
  }
});

// Get all available historical rankings (last 12 weeks)
app.get('/api/rankings', async (req, res) => {
  try {
    const rankings = await getAllRankings(12);
    res.json(rankings);
  } catch (error) {
    console.error('Error fetching rankings:', error);
    res.status(500).json({ error: 'Failed to fetch rankings' });
  }
});

// Get specific week's rankings by date
app.get('/api/rankings/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const ranking = await getRankingByDate(date);

    if (!ranking) {
      return res.status(404).json({ error: `No ranking found for date: ${date}` });
    }

    // Historical data may have been saved without company names — enrich from FMP
    const allStocks = [...(ranking.rankings || []), ...(ranking.shortRankings || [])];
    if (allStocks.some(s => !s.companyName)) {
      const [enrichedLong, enrichedShort] = await Promise.all([
        enrichCompanyNames(ranking.rankings || []),
        enrichCompanyNames(ranking.shortRankings || []),
      ]);
      ranking.rankings = enrichedLong;
      if (ranking.shortRankings) ranking.shortRankings = enrichedShort;
    }

    res.json(ranking);
  } catch (error) {
    console.error('Error fetching ranking by date:', error);
    res.status(500).json({ error: 'Failed to fetch ranking' });
  }
});

// Get stock's ranking history over last 12 weeks
app.get('/api/stock-history/:ticker', async (req, res) => {
  try {
    const { ticker } = req.params;
    const history = await getStockHistory(ticker);
    res.json(history);
  } catch (error) {
    console.error('Error fetching stock history:', error);
    res.status(500).json({ error: 'Failed to fetch stock history' });
  }
});

// Get latest laser signals for a list of tickers (read-only from mobile app DB).
// If shortList: true, tickers with no laser signal get a stop price from 2-week high + $0.01 (short exit).
app.post('/api/signals', async (req, res) => {
  try {
    const { tickers, shortList } = req.body;
    if (!Array.isArray(tickers) || tickers.length === 0) {
      return res.status(400).json({ error: 'tickers array is required' });
    }
    const signals = await getLatestSignals(tickers);
    let signalsWithStops = await calculateStopPrices(signals);
    if (shortList) {
      const missingStopTickers = tickers.filter(t => {
        const key = (typeof t === 'string' ? t : t.ticker || t).toUpperCase();
        return !(signalsWithStops[key]?.stopPrice != null);
      });
      if (missingStopTickers.length > 0) {
        const shortStops = await getShortStopPrices(missingStopTickers);
        signalsWithStops = { ...signalsWithStops };
        for (const [ticker, data] of Object.entries(shortStops)) {
          signalsWithStops[ticker] = { ...(signalsWithStops[ticker] || {}), ...data };
        }
      }
    }
    res.json(signalsWithStops);
  } catch (error) {
    console.error('Error fetching signals:', error);
    res.status(500).json({ error: 'Failed to fetch signals' });
  }
});

// Get the first date each ticker appeared in the long or short top-100 list.
app.post('/api/entry-dates', async (req, res) => {
  try {
    const { tickers } = req.body;
    if (!Array.isArray(tickers) || tickers.length === 0) {
      return res.status(400).json({ error: 'tickers array is required' });
    }
    const entryDates = await getListEntryDates(tickers);
    res.json(entryDates);
  } catch (error) {
    console.error('Error fetching entry dates:', error);
    res.status(500).json({ error: 'Failed to fetch entry dates' });
  }
});

// Get OHLCV daily price history for charting (5 years back)
app.get('/api/chart/:ticker', async (req, res) => {
  try {
    const { ticker } = req.params;
    const FMP_API_KEY = process.env.FMP_API_KEY;
    const from = new Date();
    from.setFullYear(from.getFullYear() - 5);
    const fromStr = from.toISOString().split('T')[0];
    const url = `https://financialmodelingprep.com/api/v3/historical-price-full/${ticker}?from=${fromStr}&apikey=${FMP_API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`FMP error: ${response.status}`);
    const data = await response.json();
    if (data['Error Message']) throw new Error(data['Error Message']);
    res.json(data.historical || []);
  } catch (error) {
    console.error('Error fetching chart data:', error);
    res.status(500).json({ error: 'Failed to fetch chart data' });
  }
});

// Sector performance: 11 SPDR sector ETFs, daily % changes for last 13 months.
// Cumulative compounding is done client-side per the selected time range.
app.get('/api/sectors', async (req, res) => {
  try {
    const now = Date.now();
    if (sectorCache && sectorCacheTime && (now - sectorCacheTime) < SECTOR_CACHE_DURATION) {
      return res.json(sectorCache);
    }
    const processed = await fetchEtfSectorData();
    sectorCache = processed;
    sectorCacheTime = now;
    res.json(processed);
  } catch (error) {
    console.error('Error fetching sector data:', error);
    res.status(500).json({ error: 'Failed to fetch sector data' });
  }
});

// ── Portfolio ────────────────────────────────────────────────────────────────

// GET /api/portfolio
// Returns top 50 long + top 50 short enriched with laser signals and stop prices.
// The client defaults to checking only ranks 1-25 from each list.
// Position sizing (shares, value) is computed client-side from the returned stopPrice.
app.get('/api/portfolio', async (req, res) => {
  try {
    const now = Date.now();
    if (cachedPortfolio && lastPortfolioFetch && (now - lastPortfolioFetch) < CACHE_DURATION) {
      return res.json(cachedPortfolio);
    }
    const data = await getStocksCache();
    const long50 = data.long.slice(0, 50).map(s => ({ ...s, direction: 'LONG' }));
    const short50 = data.short.slice(0, 50).map(s => ({ ...s, direction: 'SHORT' }));
    const all100 = await enrichWithSignals([...long50, ...short50]);
    cachedPortfolio = all100;
    lastPortfolioFetch = now;
    res.json(all100);
  } catch (error) {
    console.error('Error fetching portfolio:', error);
    res.status(500).json({ error: 'Failed to fetch portfolio data' });
  }
});

// GET /api/portfolio/ticker/:ticker
// Fetch live data for a single user-specified ticker (for the add-row feature).
app.get('/api/portfolio/ticker/:ticker', async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase();
    const stocks = await getWatchlistStocks([ticker]);
    if (!stocks || stocks.length === 0) {
      return res.status(404).json({ error: `Ticker ${ticker} not found` });
    }
    const enriched = await enrichWithSignals(stocks);
    res.json(enriched[0]);
  } catch (error) {
    console.error('Error fetching portfolio ticker:', error);
    res.status(500).json({ error: 'Failed to fetch ticker data' });
  }
});

// POST /api/portfolio/optimize
// Runs risk-adjusted portfolio optimisation (Sortino-first, sector caps, vol targeting).
// Body: { accountSize: number, tickers: string[] }
app.post('/api/portfolio/optimize', async (req, res) => {
  try {
    const { accountSize, tickers, riskPct = 1 } = req.body;
    if (!accountSize || !Array.isArray(tickers) || tickers.length < 2) {
      return res.status(400).json({ error: 'accountSize and at least 2 tickers are required' });
    }
    const clampedRiskPct = Math.min(Math.max(parseFloat(riskPct) || 1, 0.1), 10);

    // Determine direction for each requested ticker from current scan data
    const scanData = await getStocksCache();
    const shortTickerSet = new Set(scanData.short.slice(0, 25).map(s => s.ticker));

    // Fetch live data for requested tickers and add direction
    const stockData = await getWatchlistStocks(tickers);
    const stocksWithDir = stockData.map(s => ({
      ...s,
      direction: shortTickerSet.has(s.ticker) ? 'SHORT' : 'LONG',
    }));

    // Add signals + stop prices
    const positions = await enrichWithSignals(stocksWithDir);

    // Optimise
    const {
      fractions,
      sortino,
      sharpe,
      scaleFactor,
      maxDrawdown,
      portfolioVol,
      vix,
      avgCorrelation,
      excludedCount,
    } = await optimizeWithRason(positions, accountSize, clampedRiskPct);

    // Compute optimised shares per position
    const results = positions.map((p, i) => {
      const riskPerShare = p.stopPrice != null
        ? Math.abs(p.currentPrice - p.stopPrice)
        : p.currentPrice * 0.08;
      const baseShares = riskPerShare > 0
        ? Math.floor(accountSize * (clampedRiskPct / 100) / riskPerShare)
        : 0;
      const optShares = Math.floor(baseShares * (fractions[i] ?? 0));
      return {
        ticker: p.ticker,
        direction: p.direction,
        baseShares,
        optShares,
        optValue: parseFloat((optShares * p.currentPrice).toFixed(2)),
        fraction: parseFloat((fractions[i] ?? 0).toFixed(4)),
      };
    });

    res.json({ results, sortino, sharpe, scaleFactor, maxDrawdown, portfolioVol, vix, avgCorrelation, excludedCount });
  } catch (error) {
    console.error('Error in portfolio optimize:', error);
    res.status(500).json({ error: error.message || 'Optimization failed' });
  }
});

// ── Sector stocks ────────────────────────────────────────────────────────────

// Map internal sector keys to the exact sector names FMP uses in its screener
const SECTOR_KEY_TO_FMP = {
  communicationServices: 'Communication Services',
  consumerDiscretionary: 'Consumer Cyclical',
  consumerStaples:       'Consumer Defensive',
  energy:                'Energy',
  financials:            'Financial Services',
  healthCare:            'Healthcare',
  industrials:           'Industrials',
  informationTechnology: 'Technology',
  materials:             'Basic Materials',
  realEstate:            'Real Estate',
  utilities:             'Utilities',
};

// GET /api/sector-stocks/:sectorKey
// Returns up to 100 large-cap US stocks in the given sector, ranked by YTD return.
app.get('/api/sector-stocks/:sectorKey', async (req, res) => {
  const { sectorKey } = req.params;
  const fmpSector = SECTOR_KEY_TO_FMP[sectorKey];
  if (!fmpSector) return res.status(400).json({ error: 'Unknown sector key' });

  try {
    const FMP_API_KEY = process.env.FMP_API_KEY;
    const FMP_BASE = 'https://financialmodelingprep.com/api/v3';

    // 1. Screen for large-cap US stocks in this sector (NYSE + NASDAQ, $500M+ market cap)
    const screenerUrl = `${FMP_BASE}/stock-screener?sector=${encodeURIComponent(fmpSector)}&exchange=NYSE,NASDAQ&country=US&marketCapMoreThan=500000000&limit=150&apikey=${FMP_API_KEY}`;
    const screenerRes = await fetch(screenerUrl);
    if (!screenerRes.ok) throw new Error(`FMP screener ${screenerRes.status}`);
    const screenerData = await screenerRes.json();
    if (!Array.isArray(screenerData) || screenerData.length === 0) {
      return res.json({ stocks: [], signals: {} });
    }

    const tickers = screenerData.map(s => s.symbol);

    // 2. Fetch YTD % return via stock-price-change (no historical price dependency)
    const ytdRes = await fetch(`${FMP_BASE}/stock-price-change/${tickers.join(',')}?apikey=${FMP_API_KEY}`);
    const ytdData = ytdRes.ok ? await ytdRes.json() : [];
    const ytdMap = {};
    if (Array.isArray(ytdData)) for (const item of ytdData) ytdMap[item.symbol] = item.ytd;

    // 3. Build stock objects, sort by YTD desc, assign ranks
    const stocks = screenerData
      .filter(s => s.price && ytdMap[s.symbol] != null)
      .map(s => ({
        ticker: s.symbol,
        companyName: s.companyName || '',
        exchange: s.exchangeShortName || s.exchange || 'N/A',
        sector: s.sector || fmpSector,
        currentPrice: parseFloat(Number(s.price).toFixed(2)),
        ytdReturn: parseFloat(Number(ytdMap[s.symbol]).toFixed(2)),
        rank: null,
        rankChange: null,
        previousRank: null,
      }))
      .sort((a, b) => b.ytdReturn - a.ytdReturn)
      .map((s, i) => ({ ...s, rank: i + 1 }));

    // 4. Get Laser signals + stop prices for these tickers
    const stockTickers = stocks.map(s => s.ticker);
    const rawSignals = await getLatestSignals(stockTickers);
    const signals = await calculateStopPrices(rawSignals);

    res.json({ stocks, signals });
  } catch (error) {
    console.error(`Error fetching sector stocks for ${sectorKey}:`, error);
    res.status(500).json({ error: 'Failed to fetch sector stocks' });
  }
});

// ── Earnings ──────────────────────────────────────────────────────────────────

// Per-ticker cache: { AAPL: '2025-05-01', MSFT: null, ... }
// Uses the per-symbol historical/earning_calendar endpoint (available on free FMP plans)
// which includes upcoming estimated dates (eps: null for future entries).
let earningsCache = {};
let earningsCacheTime = null;
const EARNINGS_CACHE_DURATION = 4 * 60 * 60 * 1000; // 4 hours

async function fetchNextEarningsDate(ticker, FMP_API_KEY) {
  const today = new Date().toISOString().split('T')[0];
  try {
    const url = `https://financialmodelingprep.com/api/v3/historical/earning_calendar/${ticker}?limit=8&apikey=${FMP_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    // Response is a flat array (not { historical: [...] })
    if (!Array.isArray(data)) return null;
    // Find the earliest future date (upcoming estimates have eps: null)
    const upcoming = data
      .filter(e => e.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date));
    return upcoming.length > 0 ? upcoming[0].date : null;
  } catch {
    return null;
  }
}

// GET /api/earnings?tickers=AAPL,MSFT,...
// Returns the next upcoming earnings date for each requested ticker.
// Fetches per-symbol historical earnings and caches results for 4 hours.
app.get('/api/earnings', async (req, res) => {
  try {
    const tickerParam = req.query.tickers;
    if (!tickerParam) return res.status(400).json({ error: 'tickers query param required' });

    const requested = tickerParam.split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
    if (requested.length === 0) return res.json({});

    const FMP_API_KEY = process.env.FMP_API_KEY;
    const now = Date.now();

    // Reset cache if expired
    if (!earningsCacheTime || (now - earningsCacheTime) > EARNINGS_CACHE_DURATION) {
      earningsCache = {};
      earningsCacheTime = now;
    }

    // Fetch only uncached tickers, all in parallel
    const missing = requested.filter(t => !(t in earningsCache));
    if (missing.length > 0) {
      console.log(`📅 Fetching earnings dates for ${missing.length} tickers`);
      const results = await Promise.all(missing.map(t => fetchNextEarningsDate(t, FMP_API_KEY)));
      missing.forEach((ticker, i) => { earningsCache[ticker] = results[i]; });
    }

    const result = {};
    for (const ticker of requested) {
      if (earningsCache[ticker]) result[ticker] = earningsCache[ticker];
    }
    res.json(result);
  } catch (error) {
    console.error('Error fetching earnings:', error);
    res.status(500).json({ error: 'Failed to fetch earnings data' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📊 API available at http://localhost:${PORT}/api/stocks`);
});
