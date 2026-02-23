import express from 'express';
import cors from 'cors';
import { getTopStocks, calculateStopPrices, getShortStopPrices, getWatchlistStocks } from './stockService.js';
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
  getLatestSignals
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

// FMP field name → camelCase sector key
const SECTOR_FIELDS = {
  communicationServicesChangesPercentage: 'communicationServices',
  consumerCyclicalChangesPercentage:      'consumerDiscretionary',
  consumerDefensiveChangesPercentage:     'consumerStaples',
  energyChangesPercentage:                'energy',
  financialServicesChangesPercentage:     'financials',
  healthcareChangesPercentage:            'healthCare',
  industrialsChangesPercentage:           'industrials',
  technologyChangesPercentage:            'informationTechnology',
  basicMaterialsChangesPercentage:        'materials',
  realEstateChangesPercentage:            'realEstate',
  utilitiesChangesPercentage:             'utilities',
};

// Process raw FMP daily sector data — returns daily % changes for the last 13 months.
// Cumulative computation is done on the frontend per the selected time range.
function processSectorData(rawData) {
  if (!Array.isArray(rawData) || rawData.length === 0) return [];

  // Sort ascending by date
  const sorted = [...rawData].sort((a, b) => (a.date < b.date ? -1 : 1));

  // Keep 13 months so the frontend can slice any supported range
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 13);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  const recent = sorted.filter(d => d.date >= cutoffStr);
  if (recent.length === 0) return [];

  return recent.map(day => {
    const sectors = {};
    for (const [fmpField, sectorKey] of Object.entries(SECTOR_FIELDS)) {
      sectors[sectorKey] = parseFloat((day[fmpField] ?? 0).toFixed(4));
    }
    return { date: day.date, sectors };
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

// Sector performance: 11 GICS sectors, weekly cumulative % return, 12-month rolling
app.get('/api/sectors', async (req, res) => {
  try {
    const now = Date.now();
    if (sectorCache && sectorCacheTime && (now - sectorCacheTime) < SECTOR_CACHE_DURATION) {
      return res.json(sectorCache);
    }
    const FMP_API_KEY = process.env.FMP_API_KEY;
    const url = `https://financialmodelingprep.com/api/v3/historical-sectors-performance?limit=400&apikey=${FMP_API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`FMP error: ${response.status}`);
    const data = await response.json();
    const processed = processSectorData(Array.isArray(data) ? data : []);
    sectorCache = processed;
    sectorCacheTime = now;
    res.json(processed);
  } catch (error) {
    console.error('Error fetching sector data:', error);
    res.status(500).json({ error: 'Failed to fetch sector data' });
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
