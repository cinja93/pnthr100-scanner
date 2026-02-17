import express from 'express';
import cors from 'cors';
import { getTopStocks } from './stockService.js';
import {
  getSupplementalStocks,
  addSupplementalStock,
  removeSupplementalStock,
  getAllRankings,
  getRankingByDate,
  getStockHistory
} from './database.js';

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Cache for stock data (refresh every 5 minutes)
let cachedData = null;
let lastFetch = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes in milliseconds

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
    res.json(data.long);
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
    res.json(data.short);
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📊 API available at http://localhost:${PORT}/api/stocks`);
});
