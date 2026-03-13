import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { getTopStocks, calculateStopPrices, getShortStopPrices, getWatchlistStocks, getJungleStocks } from './stockService.js';
import { getSignals, getCachedSignals } from './signalService.js';
import { enrichWithSignals, optimizeWithRason } from './portfolioService.js';
import { getLastFridayDate, saveRankingManually } from './rankingService.js';
import { getEmaCrossoverStocks } from './emaCrossoverService.js';
import { getEtfStocks } from './etfService.js';
import { getSp400Longs, getSp400Shorts } from './sp400Service.js';
import { getPreyResults, clearPreyCache } from './preyService.js';
import newsletterRouter from './routes/newsletter.js';
import cron from 'node-cron';
import { generateIssue, getMostRecentFriday } from './newsletterService.js';
import { saveWeeklySnapshot, getTickerHistory, getWeekSnapshot, listArchivedWeeks, getCurrentWeekOf } from './signalHistoryService.js';
import { authenticateJWT, requireAdmin, hashPassword, verifyPassword, generateToken, resolveRole } from './auth.js';
import {
  getSupplementalStocks,
  addSupplementalStock,
  removeSupplementalStock,
  getWatchlistTickers,
  addToWatchlist,
  removeFromWatchlist,
  getAllRankings,
  getRankingByDate,
  getMostRecentRanking,
  getStockHistory,
  getListEntryDates,
  getLatestSignals,
  createUser,
  findUserByEmail,
  getUserProfile,
  upsertUserProfile,
} from './database.js';

const app = express();
const PORT = 3000;

// Middleware
const allowedOrigin = process.env.ALLOWED_ORIGIN || 'http://localhost:5173';
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());

// Rate limiting for auth endpoints — 10 attempts per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
});

// ── Auth routes (public — no middleware) ───────────────────────────────────

// Register is admin-only — only admins can create new accounts (invite system)
app.post('/auth/register', authLimiter, authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const hashedPassword = await hashPassword(password);
    const user = await createUser(email, hashedPassword);
    const role = resolveRole(user.email);
    const token = generateToken(user._id, user.email, role);
    res.json({ token, email: user.email, role });
  } catch (error) {
    if (error.message.includes('already exists')) {
      return res.status(409).json({ error: error.message });
    }
    console.error('Register error:', error);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

app.post('/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const user = await findUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    const valid = await verifyPassword(password, user.hashedPassword);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
    // Role is always resolved from ADMIN_EMAILS env var — no DB migration needed
    const role = resolveRole(user.email);
    const token = generateToken(user._id, user.email, role);
    const profile = await getUserProfile(user._id.toString());
    res.json({ token, email: user.email, role, profile });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── API authentication ────────────────────────────────────────────────────────
// Accepts either a valid JWT (browser sessions) or x-api-key (server-to-server, cron jobs).
const API_KEY = process.env.API_KEY;
app.use('/api', (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey && apiKey === API_KEY) return next();
  authenticateJWT(req, res, next);
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
  IJH:  'sp400',
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

// Single ticker search — any NYSE/Nasdaq stock
app.get('/api/stocks/search', async (req, res) => {
  try {
    const ticker = (req.query.ticker || '').toUpperCase().trim();
    if (!ticker) return res.status(400).json({ error: 'ticker is required' });

    const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';
    const FMP_API_KEY = process.env.FMP_API_KEY;

    // Fetch quote, profile (sector), and YTD price change in parallel
    const [quoteRes, profileRes, changeRes] = await Promise.all([
      fetch(`${FMP_BASE_URL}/quote/${ticker}?apikey=${FMP_API_KEY}`),
      fetch(`${FMP_BASE_URL}/profile/${ticker}?apikey=${FMP_API_KEY}`),
      fetch(`${FMP_BASE_URL}/stock-price-change/${ticker}?apikey=${FMP_API_KEY}`),
    ]);

    if (!quoteRes.ok) throw new Error(`FMP ${quoteRes.status}`);
    const quoteArr = await quoteRes.json();
    if (!Array.isArray(quoteArr) || quoteArr.length === 0) {
      return res.status(404).json({ error: `Ticker "${ticker}" not found` });
    }
    const q = quoteArr[0];
    if (!q.price) return res.status(404).json({ error: `No price data for "${ticker}"` });

    // Extract sector from profile (best effort)
    let sector = 'N/A';
    try {
      const profileArr = await profileRes.json();
      if (Array.isArray(profileArr) && profileArr[0]?.sector) {
        sector = profileArr[0].sector;
      }
    } catch { /* ignore */ }

    // Extract YTD return from price-change endpoint (best effort)
    let ytdReturn = null;
    try {
      const changeArr = await changeRes.json();
      if (Array.isArray(changeArr) && changeArr[0]?.['ytd'] != null) {
        ytdReturn = parseFloat(Number(changeArr[0]['ytd']).toFixed(2));
      }
    } catch { /* ignore */ }

    const stock = {
      ticker: q.symbol,
      companyName: q.name || q.symbol,
      exchange: q.exchange || 'N/A',
      sector,
      currentPrice: parseFloat(Number(q.price).toFixed(2)),
      ytdReturn,
      rank: null,
      rankChange: null,
      previousRank: null,
      rankList: null,
    };

    // Check if this ticker is in the most recent PNTHR 100 long or short ranking
    try {
      const latestRanking = await getMostRecentRanking();
      if (latestRanking) {
        const longEntry  = (latestRanking.rankings      || []).find(r => r.ticker === ticker);
        const shortEntry = (latestRanking.shortRankings || []).find(r => r.ticker === ticker);
        const entry = longEntry || shortEntry;
        if (entry) {
          stock.rank         = entry.rank         ?? null;
          stock.rankChange   = entry.rankChange   ?? null;
          stock.previousRank = entry.previousRank ?? null;
          stock.rankList     = longEntry ? 'LONG' : 'SHORT';
        }
      }
    } catch { /* ranking lookup is best-effort */ }

    const signals = await getSignals([ticker]);

    res.json({ stock, signals });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Earnings calendar for the current/upcoming week
app.get('/api/earnings/week', async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to dates required' });

    const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';
    const FMP_API_KEY = process.env.FMP_API_KEY;

    const url = `${FMP_BASE_URL}/earning_calendar?from=${from}&to=${to}&apikey=${FMP_API_KEY}`;
    const data = await fetch(url).then(r => r.json());

    if (!Array.isArray(data)) return res.json({ byDate: {}, dates: [] });

    // Group by date — US-listed tickers only (no dots = no exchange suffix), sort alphabetically
    const byDate = {};
    for (const item of data) {
      if (!item.date || !item.symbol) continue;
      if (item.symbol.includes('.')) continue; // skip non-US (e.g. 001520.KS, 0762.HK, 0J51.L)
      if (!byDate[item.date]) byDate[item.date] = [];
      byDate[item.date].push({
        ticker: item.symbol,
        name: item.name || item.symbol,
        time: item.time || null,          // 'bmo' | 'amc' | null
        epsEstimated: item.epsEstimated ?? null,
        eps: item.eps ?? null,
        revenueEstimated: item.revenueEstimated ?? null,
      });
    }
    for (const date of Object.keys(byDate)) {
      byDate[date].sort((a, b) => a.ticker.localeCompare(b.ticker));
    }

    const dates = Object.keys(byDate).sort();
    res.json({ byDate, dates });
  } catch (err) {
    console.error('Earnings week error:', err.message);
    res.status(500).json({ error: 'Failed to fetch earnings calendar' });
  }
});

// Autocomplete: search NYSE/Nasdaq/ETF tickers and names
app.get('/api/search/autocomplete', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 1) return res.json([]);

    const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';
    const FMP_API_KEY = process.env.FMP_API_KEY;

    const url = `${FMP_BASE_URL}/search?query=${encodeURIComponent(q)}&limit=20&apikey=${FMP_API_KEY}`;
    const data = await fetch(url).then(r => r.json());

    const US_EXCHANGES = new Set(['NYSE', 'NASDAQ', 'AMEX', 'NYSEARCA', 'ETF']);
    const results = Array.isArray(data)
      ? data
          .filter(item => !item.symbol?.includes('.') && US_EXCHANGES.has(item.exchangeShortName))
          .map(item => ({
            ticker: item.symbol,
            name: item.name || item.symbol,
            exchange: item.exchangeShortName || 'N/A',
          }))
          .slice(0, 15)
      : [];

    res.json(results);
  } catch (err) {
    console.error('Autocomplete error:', err.message);
    res.json([]);
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

// ── User profile ──

app.get('/api/user/profile', async (req, res) => {
  try {
    if (!req.user?.userId) return res.status(401).json({ error: 'Authentication required' });
    const profile = await getUserProfile(req.user.userId);
    res.json({ email: req.user.email, role: req.user.role, accountSize: profile?.accountSize ?? null, defaultPage: profile?.defaultPage ?? 'long' });
  } catch (error) {
    console.error('Error fetching user profile:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

app.patch('/api/user/profile', async (req, res) => {
  try {
    if (!req.user?.userId) return res.status(401).json({ error: 'Authentication required' });
    const { accountSize, defaultPage } = req.body;
    const updates = {};
    if (accountSize !== undefined) updates.accountSize = accountSize === null ? null : Number(accountSize);
    if (defaultPage !== undefined) updates.defaultPage = defaultPage;
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update' });
    await upsertUserProfile(req.user.userId, updates);
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating user profile:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ── Watchlist ──

// Get all watchlist stocks with live data
app.get('/api/watchlist', async (req, res) => {
  try {
    if (!req.user?.userId) return res.status(401).json({ error: 'Authentication required' });
    const tickers = await getWatchlistTickers(req.user.userId);
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
    if (!req.user?.userId) return res.status(401).json({ error: 'Authentication required' });
    const { ticker } = req.body;
    if (!ticker || typeof ticker !== 'string') {
      return res.status(400).json({ error: 'Ticker is required' });
    }
    const tickerUpper = ticker.toUpperCase().trim();
    if (!/^[A-Z]{1,5}[A-Z.\-]*$/.test(tickerUpper)) {
      return res.status(400).json({ error: 'Invalid ticker format' });
    }
    const result = await addToWatchlist(tickerUpper, req.user.userId);
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
    if (!req.user?.userId) return res.status(401).json({ error: 'Authentication required' });
    const { ticker } = req.params;
    const result = await removeFromWatchlist(ticker, req.user.userId);
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

// POST /api/rankings/save
// Force a fresh scan and save it for the most recent Friday (or a supplied date).
// Useful for backfilling a missed Friday when the server was sleeping.
// Body (optional): { date: 'YYYY-MM-DD' }
app.post('/api/rankings/save', async (req, res) => {
  try {
    const date = req.body?.date || getLastFridayDate();
    const data = await getStocksCache(true); // force fresh scan
    const result = await saveRankingManually(data.long, data.short, date);
    res.json(result);
  } catch (error) {
    console.error('Error in manual ranking save:', error);
    res.status(500).json({ error: error.message || 'Failed to save ranking' });
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

// Get EMA-derived signals for a list of tickers.
// If shortList: true, tickers with no signal get a proxy stop from 2-week high + $0.01.
app.post('/api/signals', async (req, res) => {
  try {
    const { tickers, shortList } = req.body;
    if (!Array.isArray(tickers) || tickers.length === 0) {
      return res.status(400).json({ error: 'tickers array is required' });
    }
    let signalsWithStops = await getSignals(tickers);
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

// Get legacy Laser signals from MongoDB (read-only mirror of The Laser app DB).
// Used alongside /api/signals for side-by-side comparison during PNTHR signal rollout.
app.post('/api/laser-signals', async (req, res) => {
  try {
    const { tickers, shortList } = req.body;
    if (!Array.isArray(tickers) || tickers.length === 0) {
      return res.status(400).json({ error: 'tickers array is required' });
    }
    let signals = await getLatestSignals(tickers);
    signals = await calculateStopPrices(signals);
    if (shortList) {
      const missingStopTickers = tickers.filter(t => {
        const key = (typeof t === 'string' ? t : t.ticker || t).toUpperCase();
        return !(signals[key]?.stopPrice != null);
      });
      if (missingStopTickers.length > 0) {
        const shortStops = await getShortStopPrices(missingStopTickers);
        signals = { ...signals };
        for (const [ticker, data] of Object.entries(shortStops)) {
          signals[ticker] = { ...(signals[ticker] || {}), ...data };
        }
      }
    }
    res.json(signals);
  } catch (error) {
    console.error('Error fetching laser signals:', error);
    res.status(500).json({ error: 'Failed to fetch laser signals' });
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

// Map internal sector keys to GICS sector names as used by the S&P 500 constituent list
// FMP sp500_constituent uses its own sector names (not pure GICS)
const SECTOR_KEY_TO_GICS = {
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

// Cache S&P 500 constituent list (refreshes daily)
let sp500Cache = { date: null, constituents: null };

async function getSP500Constituents(FMP_API_KEY) {
  const today = new Date().toISOString().split('T')[0];
  if (sp500Cache.date === today && sp500Cache.constituents) return sp500Cache.constituents;
  const res = await fetch(`https://financialmodelingprep.com/api/v3/sp500_constituent?apikey=${FMP_API_KEY}`);
  if (!res.ok) throw new Error(`FMP SP500 constituent ${res.status}`);
  const data = await res.json();
  sp500Cache = { date: today, constituents: data };
  return data;
}

// Sector signal counts — pre-computed in background at startup, cached weekly
let sectorSignalCountsCache = null;

async function computeSectorSignalCounts() {
  try {
    console.log('📡 Computing sector signal counts for all S&P 500 stocks...');
    const FMP_API_KEY = process.env.FMP_API_KEY;
    const constituents = await getSP500Constituents(FMP_API_KEY);

    const gicsToKey = {};
    for (const [key, gics] of Object.entries(SECTOR_KEY_TO_GICS)) gicsToKey[gics] = key;

    const tickersBySector = {};
    for (const c of constituents) {
      const sectorKey = gicsToKey[c.sector];
      if (!sectorKey) continue;
      if (!tickersBySector[sectorKey]) tickersBySector[sectorKey] = [];
      tickersBySector[sectorKey].push(c.symbol);
    }

    const allTickers = constituents.map(c => c.symbol);
    const signals = await getSignals(allTickers);

    const counts = {};
    for (const [sectorKey, tickers] of Object.entries(tickersBySector)) {
      counts[sectorKey] = { BL: 0, BE: 0, SS: 0, SE: 0, newBL: 0, newSS: 0, total: tickers.length };
      for (const ticker of tickers) {
        const sigData = signals[ticker];
        const sig = sigData?.signal;
        const isNew = sigData?.isNewSignal ?? false;
        if (sig === 'BL' || sig === 'BUY')       { counts[sectorKey].BL++; if (isNew) counts[sectorKey].newBL++; }
        else if (sig === 'BE')                      counts[sectorKey].BE++;
        else if (sig === 'SS' || sig === 'SELL')  { counts[sectorKey].SS++; if (isNew) counts[sectorKey].newSS++; }
        else if (sig === 'SE')                      counts[sectorKey].SE++;
      }
    }

    sectorSignalCountsCache = counts;
    console.log('✅ Sector signal counts ready');
  } catch (err) {
    console.error('Error computing sector signal counts:', err);
  }
}

// GET /api/sector-signal-counts — returns instantly from cache (computed at startup)
app.get('/api/sector-signal-counts', async (req, res) => {
  res.json(sectorSignalCountsCache); // null until background job finishes (~2 min after start)
});

// GET /api/sector-stocks/:sectorKey
// Returns S&P 500 stocks in the given GICS sector, ranked by YTD return.
app.get('/api/sector-stocks/:sectorKey', async (req, res) => {
  const { sectorKey } = req.params;
  const gicsSector = SECTOR_KEY_TO_GICS[sectorKey];
  if (!gicsSector) return res.status(400).json({ error: 'Unknown sector key' });

  try {
    const FMP_API_KEY = process.env.FMP_API_KEY;
    const FMP_BASE = 'https://financialmodelingprep.com/api/v3';

    // 1. Get S&P 500 constituents and filter to this GICS sector
    const constituents = await getSP500Constituents(FMP_API_KEY);
    const sectorConstituents = constituents.filter(c => c.sector === gicsSector);
    if (sectorConstituents.length === 0) return res.json({ stocks: [], signals: {} });

    const tickers = sectorConstituents.map(c => c.symbol);

    // 2. Fetch current prices via quote endpoint
    const quoteRes = await fetch(`${FMP_BASE}/quote/${tickers.join(',')}?apikey=${FMP_API_KEY}`);
    const quoteData = quoteRes.ok ? await quoteRes.json() : [];
    const quoteMap = {};
    if (Array.isArray(quoteData)) for (const q of quoteData) quoteMap[q.symbol] = q;

    // 3. Fetch YTD % return
    const ytdRes = await fetch(`${FMP_BASE}/stock-price-change/${tickers.join(',')}?apikey=${FMP_API_KEY}`);
    const ytdData = ytdRes.ok ? await ytdRes.json() : [];
    const ytdMap = {};
    if (Array.isArray(ytdData)) for (const item of ytdData) ytdMap[item.symbol] = item.ytd;

    // 4. Build stock objects, sort by YTD desc, assign ranks
    const stocks = sectorConstituents
      .filter(c => quoteMap[c.symbol]?.price && ytdMap[c.symbol] != null)
      .map(c => ({
        ticker: c.symbol,
        companyName: c.name || '',
        exchange: quoteMap[c.symbol]?.exchange || 'N/A',
        sector: gicsSector,
        currentPrice: parseFloat(Number(quoteMap[c.symbol].price).toFixed(2)),
        ytdReturn: parseFloat(Number(ytdMap[c.symbol]).toFixed(2)),
        rank: null,
        rankChange: null,
        previousRank: null,
      }))
      .sort((a, b) => b.ytdReturn - a.ytdReturn)
      .map((s, i) => ({ ...s, rank: i + 1 }));

    // 5. Get EMA signals + stop prices for these tickers
    const signals = await getSignals(stocks.map(s => s.ticker));

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

// GET /api/scanner-ranks
// Returns the most-recent-week scanner rank for every ticker in the long + short lists.
// Cached 1 hour. Used by secondary views (sectors, EMA) to carry over PNTHR100 rank.
let scannerRanksCache = null;
let scannerRanksCacheTime = null;
const SCANNER_RANKS_CACHE_DURATION = 60 * 60 * 1000; // 1 hour

app.get('/api/scanner-ranks', async (req, res) => {
  try {
    const now = Date.now();
    if (scannerRanksCache && scannerRanksCacheTime && (now - scannerRanksCacheTime) < SCANNER_RANKS_CACHE_DURATION) {
      return res.json(scannerRanksCache);
    }
    const ranking = await getMostRecentRanking();
    if (!ranking) return res.json({});
    const map = {};
    for (const stock of ranking.rankings || []) {
      if (stock.ticker) map[stock.ticker.toUpperCase()] = { rank: stock.rank, list: 'LONG' };
    }
    for (const stock of ranking.shortRankings || []) {
      if (stock.ticker) map[stock.ticker.toUpperCase()] = { rank: stock.rank, list: 'SHORT' };
    }
    scannerRanksCache = map;
    scannerRanksCacheTime = now;
    res.json(map);
  } catch (error) {
    console.error('Error fetching scanner ranks:', error);
    res.status(500).json({ error: 'Failed to fetch scanner ranks' });
  }
});

// ── Speculative 162 (S&P 400 Mid-Cap) ────────────────────────────────────────

// Signal counts for the 81 speculative longs + 81 speculative shorts
let speculativeSignalCountsCache = null;

async function computeSpeculativeSignalCounts() {
  try {
    console.log('📡 Computing speculative signal counts (162 S&P 400 stocks)...');
    const allTickers = [...SPEC_LONGS, ...SPEC_SHORTS];
    const signals = await getSignals(allTickers);

    const counts = {
      longs:  { BL: 0, BE: 0, SS: 0, SE: 0, total: SPEC_LONGS.length },
      shorts: { BL: 0, BE: 0, SS: 0, SE: 0, total: SPEC_SHORTS.length },
    };

    for (const ticker of SPEC_LONGS) {
      const sig = signals[ticker]?.signal;
      if      (sig === 'BL' || sig === 'BUY')  counts.longs.BL++;
      else if (sig === 'BE')                   counts.longs.BE++;
      else if (sig === 'SS' || sig === 'SELL') counts.longs.SS++;
      else if (sig === 'SE')                   counts.longs.SE++;
    }
    for (const ticker of SPEC_SHORTS) {
      const sig = signals[ticker]?.signal;
      if      (sig === 'BL' || sig === 'BUY')  counts.shorts.BL++;
      else if (sig === 'BE')                   counts.shorts.BE++;
      else if (sig === 'SS' || sig === 'SELL') counts.shorts.SS++;
      else if (sig === 'SE')                   counts.shorts.SE++;
    }

    speculativeSignalCountsCache = counts;
    console.log('✅ Speculative signal counts ready');
  } catch (err) {
    console.error('Error computing speculative signal counts:', err);
  }
}

// GET /api/speculative-signal-counts — returns instantly from cache
app.get('/api/speculative-signal-counts', (req, res) => {
  res.json(speculativeSignalCountsCache); // null until background job finishes
});

// Sector cache for speculative tickers (profile data rarely changes)
const speculativeSectorCache = { longs: null, shorts: null };

// GET /api/speculative-stocks/:side — returns longs or shorts with live quotes + signals
app.get('/api/speculative-stocks/:side', async (req, res) => {
  const { side } = req.params;
  if (side !== 'longs' && side !== 'shorts') {
    return res.status(400).json({ error: 'side must be longs or shorts' });
  }

  try {
    const tickers = side === 'longs' ? SPEC_LONGS : SPEC_SHORTS;
    const FMP_API_KEY = process.env.FMP_API_KEY;
    const FMP_BASE = 'https://financialmodelingprep.com/api/v3';

    // Fetch quotes, YTD, and sector profile in parallel
    const [quoteRes, ytdRes, profileRes] = await Promise.all([
      fetch(`${FMP_BASE}/quote/${tickers.join(',')}?apikey=${FMP_API_KEY}`),
      fetch(`${FMP_BASE}/stock-price-change/${tickers.join(',')}?apikey=${FMP_API_KEY}`),
      speculativeSectorCache[side]
        ? Promise.resolve(null) // skip if cached
        : fetch(`${FMP_BASE}/profile/${tickers.join(',')}?apikey=${FMP_API_KEY}`),
    ]);

    const quoteData = quoteRes.ok ? await quoteRes.json() : [];
    const ytdData   = ytdRes.ok   ? await ytdRes.json()   : [];

    // Build sector map from profile (cached after first fetch)
    if (!speculativeSectorCache[side] && profileRes?.ok) {
      const profileData = await profileRes.json();
      const sectorMap = {};
      if (Array.isArray(profileData)) {
        for (const p of profileData) if (p.symbol && p.sector) sectorMap[p.symbol] = p.sector;
      }
      speculativeSectorCache[side] = sectorMap;
    }
    const sectorMap = speculativeSectorCache[side] || {};

    const quoteMap = {};
    if (Array.isArray(quoteData)) for (const q of quoteData) quoteMap[q.symbol] = q;
    const ytdMap = {};
    if (Array.isArray(ytdData)) for (const item of ytdData) ytdMap[item.symbol] = item.ytd;

    const stocks = tickers
      .filter(t => quoteMap[t]?.price != null && ytdMap[t] != null)
      .map(t => ({
        ticker:       t,
        companyName:  quoteMap[t]?.name || '',
        exchange:     quoteMap[t]?.exchange || 'N/A',
        sector:       sectorMap[t] || '',
        currentPrice: parseFloat(Number(quoteMap[t].price).toFixed(2)),
        ytdReturn:    parseFloat(Number(ytdMap[t]).toFixed(2)),
        rank:         null,
        rankChange:   null,
        previousRank: null,
      }))
      .sort((a, b) => side === 'longs' ? b.ytdReturn - a.ytdReturn : a.ytdReturn - b.ytdReturn)
      .map((s, i) => ({ ...s, rank: i + 1 }));

    const signals = await getSignals(tickers);

    res.json({ stocks, signals });
  } catch (error) {
    console.error(`Error fetching speculative ${side}:`, error);
    res.status(500).json({ error: `Failed to fetch speculative ${side}` });
  }
});

// ── PNTHR 679 Jungle ─────────────────────────────────────────────────────────
let jungleCacheData = null;
let jungleCacheTime = 0;

app.get('/api/jungle-stocks', async (req, res) => {
  try {
    const now = Date.now();
    if (jungleCacheData && (now - jungleCacheTime) < 5 * 60 * 1000 && !req.query.refresh) {
      return res.json(jungleCacheData);
    }
    const [specLongs, specShorts] = await Promise.all([getSp400Longs(), getSp400Shorts()]);
    const stocks  = await getJungleStocks(specLongs, specShorts);
    const signals = await getSignals(stocks.map(s => s.ticker));
    jungleCacheData = { stocks, signals };
    jungleCacheTime = now;
    res.json(jungleCacheData);
  } catch (err) {
    console.error('Error in /api/jungle-stocks:', err);
    res.status(500).json({ error: 'Failed to load jungle stocks' });
  }
});

// ── PNTHR PREY ────────────────────────────────────────────────────────────────
app.get('/api/prey', authenticateJWT, async (req, res) => {
  try {
    if (req.query.refresh) clearPreyCache();
    // Build the 679 stock universe with metadata
    const [specLongs, specShorts] = await Promise.all([getSp400Longs(), getSp400Shorts()]);
    const stocks = await getJungleStocks(specLongs, specShorts);
    const tickers = stocks.map(s => s.ticker);
    const stockMeta = {};
    for (const s of stocks) stockMeta[s.ticker] = { companyName: s.companyName, sector: s.sector, exchange: s.exchange, currentPrice: s.currentPrice };
    const jungleSignals = await getSignals(tickers);
    const results = await getPreyResults(tickers, stockMeta, jungleSignals);
    res.json(results);
  } catch (err) {
    console.error('Error in /api/prey:', err);
    res.status(500).json({ error: 'Prey scan failed' });
  }
});

// ── Newsletter (PNTHR's Perch) ────────────────────────────────────────────────
app.use('/api/newsletter', newsletterRouter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Cron: auto-generate newsletter every Friday at 5pm ET (22:00 UTC) ─────────
cron.schedule('0 22 * * 5', async () => {
  try {
    const weekOf = getMostRecentFriday();
    console.log(`[Cron] Generating PNTHR's Perch for week of ${weekOf}...`);
    await generateIssue(weekOf);
    console.log(`[Cron] PNTHR's Perch generated successfully.`);
  } catch (err) {
    console.error('[Cron] Newsletter generation failed:', err.message);
  }
});

// ── Cron: archive weekly signal snapshot every Friday at 6pm ET (23:00 UTC) ───
// Runs one hour after newsletter generation so signal cache is warm.
cron.schedule('0 23 * * 5', async () => {
  try {
    console.log('[Signal Archive] Saving weekly snapshot...');
    const jungleData = await getJungleStocks();
    const tickers = (jungleData.stocks || []).map(s => s.ticker);
    const signals  = await getSignals(tickers);
    const count    = await saveWeeklySnapshot(signals);
    console.log(`[Signal Archive] Saved ${count} signal records for week of ${getCurrentWeekOf()}.`);
  } catch (err) {
    console.error('[Signal Archive] Snapshot failed:', err.message);
  }
});

// ── Admin: signal history endpoints ────────────────────────────────────────────

// POST /api/admin/signal-history/snapshot — manually save this week's snapshot
app.post('/api/admin/signal-history/snapshot', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    // Prefer the already-warm in-memory signal cache so the snapshot is instant
    // when the Jungle page has been loaded this session. If the cache is cold
    // (server just restarted), fall back to a full getSignals() fetch.
    let signals = getCachedSignals();
    if (signals) {
      console.log(`[Signal Archive] Using cached signals for snapshot (${Object.keys(signals).length} tickers)`);
    } else {
      console.log('[Signal Archive] Cache cold — fetching signals from FMP (this may take a few minutes)...');
      const jungleData = await getJungleStocks();
      const tickers = (jungleData.stocks || []).map(s => s.ticker);
      signals = await getSignals(tickers);
    }
    const count = await saveWeeklySnapshot(signals);
    res.json({ ok: true, count, weekOf: getCurrentWeekOf() });
  } catch (err) {
    console.error('[Signal Archive] Manual snapshot failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/signal-history/weeks — list all archived weeks
app.get('/api/admin/signal-history/weeks', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const weeks = await listArchivedWeeks();
    res.json(weeks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/signal-history/week/:weekOf — get all active signals for a week
app.get('/api/admin/signal-history/week/:weekOf', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const records = await getWeekSnapshot(req.params.weekOf);
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/signal-history/ticker/:ticker — full history for one stock
app.get('/api/admin/signal-history/ticker/:ticker', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const records = await getTickerHistory(req.params.ticker);
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📊 API available at http://localhost:${PORT}/api/stocks`);
  // Pre-compute signal counts in background (takes ~2 min each)
  computeSectorSignalCounts();
  computeSpeculativeSignalCounts();
});

// Scheduled Friday auto-save: checks every 30 minutes.
// On Fridays (Eastern) between 4:00 PM and 8:00 PM, forces a fresh scan
// which triggers autoSaveRankingIfFriday internally.
// Note: only works while the server is awake — pair with an external uptime
// monitor (e.g. cron-job.org hitting /health) to prevent Render free-tier sleep.
setInterval(async () => {
  try {
    const now = new Date();
    const etWeekday = now.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long' });
    const etHour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }), 10);
    if (etWeekday === 'Friday' && etHour >= 16 && etHour <= 20) {
      console.log('⏰ Friday scheduler: forcing fresh scan for auto-save...');
      await getStocksCache(true);
    }
  } catch (err) {
    console.error('Friday scheduler error:', err.message);
  }
}, 30 * 60 * 1000);
