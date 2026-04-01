import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import mongoSanitize from 'express-mongo-sanitize';
import { getTopStocks, calculateStopPrices, getShortStopPrices, getWatchlistStocks, getJungleStocks } from './stockService.js';
import { getSignals, getCachedSignals } from './signalService.js';
import { enrichWithSignals, optimizeWithRason } from './portfolioService.js';
import { getLastFridayDate, saveRankingManually } from './rankingService.js';
import { getEmaCrossoverStocks } from './emaCrossoverService.js';
import { getEtfStocks, ALL_ETF_TICKER_SET, getCachedEtfResults } from './etfService.js';
import { getSp400Longs, getSp400Shorts } from './sp400Service.js';
import { getSp500Tickers, getDow30Tickers, getNasdaq100Tickers } from './constituents.js';
import { getPreyResults, clearPreyCache } from './preyService.js';
import { getApexResults, clearApexCache, getCachedTickerKillData, getCachedSignalStocks, triggerApexWarmup } from './apexService.js';
import {
  killPipelineHandler,
  positionsGetAll,
  positionsSave,
  positionsClose,
  positionsDelete,
  tickerHandler,
  regimeHandler,
  ensureCommandCenterIndexes,
} from './commandCenter.js';
import { runFridayKillPipeline } from './fridayPipeline.js';
import { getKillTestSettings, saveKillTestSettings } from './killTestSettings.js';
import { runKillTestDailyUpdate } from './killTestDailyUpdate.js';
import { killTestMonthlyGet, killTestMetricsGet, killTestMonthlyGenerate, generateMonthlySnapshots } from './killTestMonthly.js';
import {
  checkCaseStudyEntries,
  createKillHistoryIndexes,
  killHistoryGetAll,
  killHistoryGetActive,
  killHistoryGetTrackRecord,
} from './killHistory.js';
import {
  navGet,
  navPost,
  pendingEntriesGet,
  pendingEntriesPost,
  pendingEntryConfirm,
  pendingEntryDismiss,
  createPendingEntriesIndexes,
} from './pendingEntries.js';
import newsletterRouter from './routes/newsletter.js';
import cron from 'node-cron';
import { generateIssue, getMostRecentFriday } from './newsletterService.js';
import { saveWeeklySnapshot, getTickerHistory, getWeekSnapshot, listArchivedWeeks, getCurrentWeekOf } from './signalHistoryService.js';
import { authenticateJWT, requireAdmin, hashPassword, verifyPassword, generateToken, resolveRole, generateApprovalToken, verifyApprovalToken } from './auth.js';
import { normalizeSector, warnUnknownSector } from './sectorUtils.js';
import { calculateSectorExposure, generateSectorRecommendations } from './sectorExposure.js';
import { sendApprovalRequestEmail, sendWelcomeEmail, sendDenialEmail } from './emailService.js';
import { ibkrSync, getOvernightFills } from './ibkrSync.js';
import {
  generateAssistantTasks,
  getStopSyncRows,
  getRoutineTasks,
  markTaskComplete,
  getTodayCompleted,
  ensureAssistantIndexes,
  buildRoutineContext,
  getPositionHealthAlerts,
} from './assistantService.js';
import { recordExit, calcAvgCost, calcTotalFilled } from './exitService.js';
import { computeEMA21fromDailyBars } from './technicalUtils.js';
import { createJournalEntry, calculateDisciplineScore } from './journalService.js';
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
  approveUser,
  denyUser,
} from './database.js';

const app = express();
const PORT = 3000;

// Middleware
// Helmet — secure HTTP headers (XSS, clickjacking, MIME sniffing, etc.)
app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled: Vercel handles it

// CORS — support comma-separated origins in ALLOWED_ORIGIN env var
const rawOrigin = process.env.ALLOWED_ORIGIN || 'http://localhost:5173';
const allowedOrigins = rawOrigin.split(',').map(o => o.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (Render health checks, curl, etc.)
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
}));

app.use(express.json({ limit: '5mb' }));

// MongoDB injection guard — strips $ and . from req.body, query, params
app.use(mongoSanitize());

// General API rate limit — 120 requests per minute per IP
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});
app.use('/api/', apiLimiter);

// Rate limiting for auth endpoints — 10 attempts per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
});

// ── Health check (public, no auth) ────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const db = await connectToDatabase();
    await db.command({ ping: 1 });
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
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

// Public self-registration — creates account as pending, emails admin for approval
app.post('/auth/request-access', authLimiter, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password are required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const hashedPassword = await hashPassword(password);
    const user = await createUser(email, hashedPassword, { name, status: 'pending' });
    const token = generateApprovalToken(user._id.toString());
    const apiUrl = process.env.API_URL || `https://pnthr100-scanner-api.onrender.com`;
    const approveUrl = `${apiUrl}/auth/approve/${user._id}?action=approve&token=${token}`;
    const denyUrl    = `${apiUrl}/auth/approve/${user._id}?action=deny&token=${token}`;
    await sendApprovalRequestEmail({ applicantName: name, applicantEmail: email, approveUrl, denyUrl });
    res.json({ success: true, pending: true, message: 'Your account request has been submitted. You will receive an email when approved.' });
  } catch (error) {
    if (error.message.includes('already exists')) return res.status(409).json({ error: error.message });
    console.error('Request access error:', error);
    res.status(500).json({ error: 'Failed to submit account request' });
  }
});

// One-click approve/deny from email link
app.get('/auth/approve/:userId', async (req, res) => {
  const { userId } = req.params;
  const { action, token } = req.query;
  if (!verifyApprovalToken(userId, token)) return res.status(403).send('<h2>Invalid or expired approval link.</h2>');
  try {
    const { connectToDatabase: getDb } = await import('./database.js');
    const { ObjectId } = await import('mongodb');
    const db = await getDb();
    const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
    if (!user) return res.status(404).send('<h2>User not found.</h2>');
    if (user.status !== 'pending') return res.send(page('Already Processed', '#aaa', `This account has already been processed (status: ${user.status}).`));
    if (action === 'approve') {
      await approveUser(userId);
      await sendWelcomeEmail({ to: user.email, name: user.name || user.email }).catch(() => {});
      return res.send(page('✓ Account Approved', '#28a745', `${user.name || user.email} (${user.email}) has been approved and notified.`));
    }
    if (action === 'deny') {
      await denyUser(userId);
      await sendDenialEmail({ to: user.email, name: user.name || user.email }).catch(() => {});
      return res.send(page('✗ Account Denied', '#dc3545', `${user.name || user.email} (${user.email}) has been denied.`));
    }
    res.status(400).send('<h2>Invalid action.</h2>');
  } catch (err) {
    console.error('Approve error:', err);
    res.status(500).send('<h2>Server error.</h2>');
  }
});

function page(title, color, body) {
  return `<html><body style="background:#0a0a0a;color:#fff;font-family:Arial;text-align:center;padding:60px;">
    <h1 style="color:#D4A017;">PNTHR FUNDS</h1>
    <h2 style="color:${color};">${title}</h2>
    <p>${body}</p>
  </body></html>`;
}



app.post('/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const user = await findUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    const valid = await verifyPassword(password, user.hashedPassword);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
    // Check approval status (users without a status field are legacy — treat as active)
    if (user.status === 'pending') return res.status(403).json({ error: 'Your account is pending approval. You will receive an email when approved.', pending: true });
    if (user.status === 'denied')  return res.status(403).json({ error: 'Your account request was not approved.', denied: true });
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
// Flag to prevent multiple simultaneous full refreshes
let stockRefreshInProgress = false;

async function getStocksCache(skipCache = false) {
  const now = Date.now();
  if (!skipCache && cachedData && lastFetch && (now - lastFetch) < CACHE_DURATION) {
    return cachedData;
  }

  // Cold start (no in-memory data): try MongoDB rankings as an instant fallback
  // so Sprint loads immediately while a fresh FMP fetch runs in the background.
  if (!cachedData && !skipCache) {
    try {
      const recent = await getMostRecentRanking();
      if (recent?.rankings?.length > 0) {
        console.log(`📊 Stocks: cold start — serving MongoDB fallback (${recent.date}), refreshing in background...`);
        cachedData = { long: recent.rankings, short: recent.shortRankings || [] };
        lastFetch = now - CACHE_DURATION + 60 * 1000; // force re-fetch after 1 min
        if (!stockRefreshInProgress) {
          stockRefreshInProgress = true;
          getTopStocks()
            .then(data => { cachedData = data; lastFetch = Date.now(); })
            .catch(err => console.error('Background stock refresh error:', err.message))
            .finally(() => { stockRefreshInProgress = false; });
        }
        return cachedData;
      }
    } catch (err) {
      console.error('MongoDB stock fallback error:', err.message);
    }
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
    // Enrich stocks with PNTHR 100 rank/rankChange so Hunt shows real rank vs JUNGLE badge
    if (result.stocks?.length) {
      try {
        const latestRanking = await getMostRecentRanking();
        if (latestRanking) {
          const longMap  = Object.fromEntries((latestRanking.rankings      || []).map(r => [r.ticker, { rank: r.rank, rankChange: r.rankChange, rankList: 'LONG'  }]));
          const shortMap = Object.fromEntries((latestRanking.shortRankings || []).map(r => [r.ticker, { rank: r.rank, rankChange: r.rankChange, rankList: 'SHORT' }]));
          result.stocks = result.stocks.map(s => {
            const entry = longMap[s.ticker] || shortMap[s.ticker];
            return entry ? { ...s, rank: entry.rank, rankChange: entry.rankChange, rankList: entry.rankList } : s;
          });
        }
      } catch { /* rank enrichment is best-effort */ }
    }
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

    // Fetch quote, profile (sector), YTD price change, and index membership in parallel
    const [quoteRes, profileRes, changeRes, sp500Tickers, dow30Tickers, nasdaq100Tickers, sp400Longs, sp400Shorts] = await Promise.all([
      fetch(`${FMP_BASE_URL}/quote/${ticker}?apikey=${FMP_API_KEY}`),
      fetch(`${FMP_BASE_URL}/profile/${ticker}?apikey=${FMP_API_KEY}`),
      fetch(`${FMP_BASE_URL}/stock-price-change/${ticker}?apikey=${FMP_API_KEY}`),
      getSp500Tickers().catch(() => []),
      getDow30Tickers().catch(() => []),
      getNasdaq100Tickers().catch(() => []),
      getSp400Longs().catch(() => []),
      getSp400Shorts().catch(() => []),
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
        sector = normalizeSector(profileArr[0].sector);
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

    // Index membership flags
    const sp500Set    = new Set(sp500Tickers);
    const dow30Set    = new Set(dow30Tickers);
    const ndx100Set   = new Set(nasdaq100Tickers);
    const sp400LSet   = new Set(sp400Longs.map(t => (typeof t === 'string' ? t : t.ticker)));
    const sp400SSet   = new Set(sp400Shorts.map(t => (typeof t === 'string' ? t : t.ticker)));
    const universe    = sp400LSet.has(ticker) ? 'sp400Long' : sp400SSet.has(ticker) ? 'sp400Short' : 'sp517';

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
      isSp500:     sp500Set.has(ticker),
      isDow30:     dow30Set.has(ticker),
      isNasdaq100: ndx100Set.has(ticker),
      universe,
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

app.patch('/api/user/profile', authenticateJWT, async (req, res) => {
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
app.post('/api/watchlist', authenticateJWT, requireAdmin, async (req, res) => {
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
app.delete('/api/watchlist/:ticker', authenticateJWT, requireAdmin, async (req, res) => {
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

    // Enrich with membership tags (isSp500, isDow30, isNasdaq100, universe, rankList)
    const [sp500Tickers, dow30Tickers, nasdaq100Tickers, sp400Longs, sp400Shorts] = await Promise.all([
      getSp500Tickers().catch(() => []),
      getDow30Tickers().catch(() => []),
      getNasdaq100Tickers().catch(() => []),
      getSp400Longs().catch(() => []),
      getSp400Shorts().catch(() => []),
    ]);
    const sp500Set  = new Set(sp500Tickers);
    const dow30Set  = new Set(dow30Tickers);
    const ndx100Set = new Set(nasdaq100Tickers);
    const sp400LSet = new Set(sp400Longs);
    const sp400SSet = new Set(sp400Shorts);

    const enrichMembership = (stocks, rankList) => stocks.map(s => {
      const t = s.ticker?.toUpperCase();
      let universe = null;
      if (sp400LSet.has(t)) universe = 'sp400Long';
      else if (sp400SSet.has(t)) universe = 'sp400Short';
      return {
        ...s,
        isSp500:     sp500Set.has(t),
        isDow30:     dow30Set.has(t),
        isNasdaq100: ndx100Set.has(t),
        universe,
        rankList,
      };
    });

    ranking.rankings = enrichMembership(ranking.rankings || [], 'LONG');
    ranking.shortRankings = enrichMembership(ranking.shortRankings || [], 'SHORT');

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
  consumerDiscretionary: 'Consumer Discretionary',
  consumerStaples:       'Consumer Staples',
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
  // Normalize sector names at ingestion — FMP uses 'Consumer Cyclical', 'Consumer Defensive', etc.
  // All downstream code (badge counts + sector stocks) then uses canonical GICS names directly.
  const normalized = data.map(c => {
    warnUnknownSector(c.sector, `sp500_constituent/${c.symbol}`);
    return { ...c, sector: normalizeSector(c.sector) };
  });
  sp500Cache = { date: today, constituents: normalized };
  return normalized;
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
      // c.sector is already normalized by getSP500Constituents
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

// GET /api/sector-exposure — net directional exposure per sector for Risk Advisor v2
app.get('/api/sector-exposure', authenticateJWT, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'Database unavailable' });

    // Step 1: fetch user positions
    const positions = await db.collection('pnthr_portfolio')
      .find({ ownerId: req.user.userId, status: { $in: ['ACTIVE', 'PARTIAL'] } })
      .toArray();

    // Step 2: compute net exposure (pure function — no DB)
    const exposure = calculateSectorExposure(positions);

    // Step 3: fetch latest week's kill scores for recommendations (limit to most recent weekOf)
    let killMap = {};
    try {
      const latestKill = await db.collection('pnthr_kill_scores')
        .findOne({}, { sort: { createdAt: -1 }, projection: { weekOf: 1 } });
      if (latestKill?.weekOf) {
        const killDocs = await db.collection('pnthr_kill_scores')
          .find({ weekOf: latestKill.weekOf },
                { projection: { ticker: 1, totalScore: 1, killRank: 1, tier: 1, signal: 1, sector: 1, signalAge: 1 } })
          .toArray();
        for (const s of killDocs) {
          if (!killMap[s.ticker]) killMap[s.ticker] = s;
        }
      }
    } catch (killErr) {
      console.warn('[SECTOR-EXPOSURE] Kill scores unavailable — recommendations will be limited:', killErr.message);
    }

    const recommendations = generateSectorRecommendations(exposure, killMap);

    res.json({
      exposure,
      recommendations,
      summary: {
        totalSectors: Object.keys(exposure).length,
        criticalCount: recommendations.filter(r => r.level === 'CRITICAL').length,
        atLimitCount:  recommendations.filter(r => r.level === 'AT_LIMIT').length,
        clearCount:    Object.values(exposure).filter(e => e.level === 'CLEAR').length,
      },
    });
  } catch (err) {
    console.error('[SECTOR-EXPOSURE] Error:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to compute sector exposure', detail: err.message });
  }
});

// GET /api/sector-ema — sector ETF vs 21-week EMA for all 11 sectors
app.get('/api/sector-ema', authenticateJWT, async (req, res) => {
  try {
    const SECTOR_ETFS = {
      'Technology':             'XLK',
      'Healthcare':             'XLV',
      'Financial Services':     'XLF',
      'Industrials':            'XLI',
      'Consumer Staples':       'XLP',
      'Consumer Discretionary': 'XLY',
      'Energy':                 'XLE',
      'Utilities':              'XLU',
      'Basic Materials':        'XLB',
      'Communication Services': 'XLC',
      'Real Estate':            'XLRE',
    };

    // FMP stable EMA endpoint returns "Invalid timeframe" for weekly.
    // Compute 21-week EMA from daily candles instead — guaranteed to work for any ETF.
    const FMP_KEY  = process.env.FMP_API_KEY;
    const FMP_HOST = 'https://financialmodelingprep.com';
    const etfTickers = Object.values(SECTOR_ETFS);

    // Helper: compute 21-week EMA from 250 daily candles (shared utility)
    async function computeEtfEma(etf) {
      try {
        const url = `${FMP_HOST}/api/v3/historical-price-full/${etf}?timeseries=250&apikey=${FMP_KEY}`;
        const data = await fetch(url, { signal: AbortSignal.timeout(8000) })
          .then(r => r.ok ? r.json() : null).catch(() => null);
        const result = computeEMA21fromDailyBars(data?.historical ?? null);
        return result ? result.current : null;
      } catch { return null; }
    }

    // Batch quote fetch (one call for all 11 ETFs) + candle-based EMA in parallel
    const [quotesRaw, emaEntries] = await Promise.all([
      fetch(`${FMP_HOST}/api/v3/quote/${etfTickers.join(',')}?apikey=${FMP_KEY}`)
        .then(r => r.ok ? r.json() : []).catch(() => []),
      Promise.all(etfTickers.map(async etf => [etf, await computeEtfEma(etf)])),
    ]);

    const priceMap = {};
    for (const q of (Array.isArray(quotesRaw) ? quotesRaw : [])) priceMap[q.symbol] = q.price;
    const emaMap = Object.fromEntries(emaEntries);

    const result = {};
    for (const [sector, etf] of Object.entries(SECTOR_ETFS)) {
      const price = priceMap[etf] ?? null;
      const ema21 = emaMap[etf]  ?? null;
      result[sector] = {
        etf,
        price,
        ema21,
        aboveEma:   price != null && ema21 != null ? price > ema21 : null,
        signal:     null,
        separation: price && ema21 ? +((price - ema21) / ema21 * 100).toFixed(2) : null,
      };
    }
    console.log('[SECTOR-EMA]', Object.entries(result).map(([s, d]) =>
      `${d.etf}:price=${d.price?.toFixed(0)} ema=${d.ema21} above=${d.aboveEma}`).join(' | '));

    res.json(result);
  } catch (err) {
    console.error('[SECTOR-EMA] Error:', err);
    res.status(500).json({ error: 'Failed to compute sector EMA data' });
  }
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

    // 1. Get S&P 500 constituents and filter to this GICS sector.
    // Sectors are normalized at cache time by getSP500Constituents — plain equality works.
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

    // 4. Fetch membership lists for tags
    const [dow30Tickers, nasdaq100Tickers, sp400Longs, sp400Shorts] = await Promise.all([
      getDow30Tickers().catch(() => []),
      getNasdaq100Tickers().catch(() => []),
      getSp400Longs().catch(() => []),
      getSp400Shorts().catch(() => []),
    ]);
    const dow30Set  = new Set(dow30Tickers);
    const ndx100Set = new Set(nasdaq100Tickers);
    const sp400LSet = new Set(sp400Longs);
    const sp400SSet = new Set(sp400Shorts);

    // 5. Build stock objects, sort by YTD desc, assign ranks
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
        isSp500:     true, // all sector stocks are S&P 500 members
        isDow30:     dow30Set.has(c.symbol),
        isNasdaq100: ndx100Set.has(c.symbol),
        universe:    sp400LSet.has(c.symbol) ? 'sp400Long' : sp400SSet.has(c.symbol) ? 'sp400Short' : null,
      }))
      .sort((a, b) => b.ytdReturn - a.ytdReturn)
      .map((s, i) => ({ ...s, rank: i + 1 }));

    // 6. Get EMA signals + stop prices for these tickers
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
      if (stock.ticker) map[stock.ticker.toUpperCase()] = { rank: stock.rank, rankChange: stock.rankChange ?? null, list: 'LONG' };
    }
    for (const stock of ranking.shortRankings || []) {
      if (stock.ticker) map[stock.ticker.toUpperCase()] = { rank: stock.rank, rankChange: stock.rankChange ?? null, list: 'SHORT' };
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
    console.log('📡 Computing speculative signal counts (S&P 400 stocks)...');
    const [specLongs, specShorts] = await Promise.all([getSp400Longs(), getSp400Shorts()]);
    const allTickers = [...specLongs, ...specShorts];
    const signals = await getSignals(allTickers);

    const counts = {
      longs:  { BL: 0, BE: 0, SS: 0, SE: 0, total: specLongs.length },
      shorts: { BL: 0, BE: 0, SS: 0, SE: 0, total: specShorts.length },
    };

    for (const ticker of specLongs) {
      const sig = signals[ticker]?.signal;
      if      (sig === 'BL' || sig === 'BUY')  counts.longs.BL++;
      else if (sig === 'BE')                   counts.longs.BE++;
      else if (sig === 'SS' || sig === 'SELL') counts.longs.SS++;
      else if (sig === 'SE')                   counts.longs.SE++;
    }
    for (const ticker of specShorts) {
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
    const [sp400Longs, sp400Shorts] = await Promise.all([getSp400Longs(), getSp400Shorts()]);
    const tickers = side === 'longs' ? sp400Longs : sp400Shorts;
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
        for (const p of profileData) if (p.symbol && p.sector) sectorMap[p.symbol] = normalizeSector(p.sector);
      }
      speculativeSectorCache[side] = sectorMap;
    }
    const sectorMap = speculativeSectorCache[side] || {};

    const quoteMap = {};
    if (Array.isArray(quoteData)) for (const q of quoteData) quoteMap[q.symbol] = q;
    const ytdMap = {};
    if (Array.isArray(ytdData)) for (const item of ytdData) ytdMap[item.symbol] = item.ytd;

    const [sp500TickersForSpec, dow30TickersForSpec, ndx100TickersForSpec] = await Promise.all([
      getSp500Tickers().catch(() => []),
      getDow30Tickers().catch(() => []),
      getNasdaq100Tickers().catch(() => []),
    ]);
    const sp500SetSpec  = new Set(sp500TickersForSpec);
    const dow30SetSpec  = new Set(dow30TickersForSpec);
    const ndx100SetSpec = new Set(ndx100TickersForSpec);
    const sp400LSetSpec = new Set(sp400Longs);
    const sp400SSetSpec = new Set(sp400Shorts);

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
        isSp500:     sp500SetSpec.has(t),
        isDow30:     dow30SetSpec.has(t),
        isNasdaq100: ndx100SetSpec.has(t),
        universe:    sp400LSetSpec.has(t) ? 'sp400Long' : sp400SSetSpec.has(t) ? 'sp400Short' : null,
        rankList: side === 'longs' ? 'LONG' : 'SHORT',
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
    for (const s of stocks) stockMeta[s.ticker] = {
      companyName: s.companyName, sector: s.sector, exchange: s.exchange,
      currentPrice: s.currentPrice, ytdReturn: s.ytdReturn,
      isSp500: s.isSp500, isDow30: s.isDow30, isNasdaq100: s.isNasdaq100,
      universe: s.universe, rankList: s.rankList ?? null,
      rank: null, rankChange: null,
    };
    // Enrich with PNTHR 100 rank + rankChange from most recent saved ranking
    try {
      const latestRanking = await getMostRecentRanking();
      if (latestRanking) {
        for (const entry of (latestRanking.rankings || [])) {
          if (stockMeta[entry.ticker]) {
            stockMeta[entry.ticker].rank       = entry.rank       ?? null;
            stockMeta[entry.ticker].rankChange = entry.rankChange ?? null;
            stockMeta[entry.ticker].rankList   = 'LONG';
          }
        }
        for (const entry of (latestRanking.shortRankings || [])) {
          if (stockMeta[entry.ticker]) {
            stockMeta[entry.ticker].rank       = entry.rank       ?? null;
            stockMeta[entry.ticker].rankChange = entry.rankChange ?? null;
            stockMeta[entry.ticker].rankList   = 'SHORT';
          }
        }
      }
    } catch { /* best-effort — prey still works without rank data */ }
    const jungleSignals = await getSignals(tickers);
    const results = await getPreyResults(tickers, stockMeta, jungleSignals);
    res.json(results);
  } catch (err) {
    console.error('Error in /api/prey:', err);
    res.status(500).json({ error: 'Prey scan failed' });
  }
});

// ── PNTHR KILL ────────────────────────────────────────────────────────────────
app.get('/api/apex', authenticateJWT, async (req, res) => {
  try {
    if (req.query.refresh) clearApexCache();
    const [specLongs, specShorts] = await Promise.all([getSp400Longs(), getSp400Shorts()]);
    const stocks = await getJungleStocks(specLongs, specShorts);
    const tickers = stocks.map(s => s.ticker);
    const stockMeta = {};
    for (const s of stocks) stockMeta[s.ticker] = {
      companyName: s.companyName, sector: s.sector, exchange: s.exchange,
      currentPrice: s.currentPrice, ytdReturn: s.ytdReturn,
      isSp500: s.isSp500, isDow30: s.isDow30, isNasdaq100: s.isNasdaq100,
      universe: s.universe, rankList: s.rankList ?? null,
      rank: null, rankChange: undefined,
    };
    // Enrich with PNTHR 100 rank + rankChange
    try {
      const latestRanking = await getMostRecentRanking();
      if (latestRanking) {
        for (const entry of (latestRanking.rankings || [])) {
          if (stockMeta[entry.ticker]) {
            stockMeta[entry.ticker].rank       = entry.rank       ?? null;
            stockMeta[entry.ticker].rankChange = entry.rankChange ?? undefined;
            stockMeta[entry.ticker].rankList   = 'LONG';
          }
        }
        for (const entry of (latestRanking.shortRankings || [])) {
          if (stockMeta[entry.ticker]) {
            stockMeta[entry.ticker].rank       = entry.rank       ?? null;
            stockMeta[entry.ticker].rankChange = entry.rankChange ?? undefined;
            stockMeta[entry.ticker].rankList   = 'SHORT';
          }
        }
      }
    } catch { /* best-effort */ }
    const jungleSignals = await getSignals(tickers);

    // Load Prey results + Hunt tickers for Kill universe + D8 scoring
    let preyResults  = null;
    let huntTickers  = new Set();
    try {
      preyResults = await getPreyResults(tickers, stockMeta, jungleSignals);
    } catch (e) { console.warn('[KILL] preyResults failed, scoring without:', e.message); }
    try {
      const huntData = await getEmaCrossoverStocks();
      const huntList = huntData?.stocks || [];
      huntTickers = new Set(huntList.map(s => s.ticker || s));
    } catch (e) { console.warn('[KILL] huntTickers failed, scoring without:', e.message); }

    const results = await getApexResults(tickers, stockMeta, jungleSignals, preyResults, huntTickers);

    // Expose to scoring-health endpoint
    global._apexCache = { results: results.stocks || [], cachedAt: new Date() };

    // On explicit refresh: update case studies in background (don't block response)
    if (req.query.refresh) {
      const { connectToDatabase } = await import('./database.js');
      connectToDatabase().then(db => {
        if (db) {
          checkCaseStudyEntries(db, results.stocks, jungleSignals, 'INTRAWEEK_REFRESH')
            .catch(err => console.error('[CASE STUDY] intraweek check failed:', err.message));
        }
      }).catch(() => {});
    }

    res.json(results);
  } catch (err) {
    console.error('Error in /api/apex:', err);
    res.status(500).json({ error: 'PNTHR Kill scan failed' });
  }
});

// ── PNTHR Kill — single ticker lookup from cache (no recompute) ──────────────
app.get('/api/apex/ticker/:ticker', authenticateJWT, (req, res) => {
  const stock = getCachedTickerKillData(req.params.ticker);
  if (!stock) return res.json({ found: false });
  res.json({ found: true, stock });
});

// ── PNTHR Kill History (Case Studies + Track Record) ───────────────────────────
app.get('/api/kill-history',              authenticateJWT, killHistoryGetAll);
app.get('/api/kill-history/active',       authenticateJWT, killHistoryGetActive);
app.get('/api/kill-history/track-record', authenticateJWT, killHistoryGetTrackRecord);

// ── PNTHR Kill Test — Appearance Tracking ──────────────────────────────────────
app.get('/api/kill-appearances', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const db   = await connectToDatabase();
    const col  = db.collection('pnthr_kill_appearances');
    const docs = await col
      .find({})
      .sort({ firstAppearanceDate: -1, firstKillRank: 1 })
      .toArray();

    // ── Lazy migration: ensure every appearance has lotFills with Lot 1 filled ──
    // Appearances created before the lot system lack this field. Lot 1 is always
    // filled at firstAppearancePrice on firstAppearanceDate by definition.
    const needsFill = docs.filter(d => !d.lotFills);
    if (needsFill.length) {
      const { ObjectId } = await import('mongodb');
      const bulkOps = needsFill.map(d => ({
        updateOne: {
          filter: { _id: d._id },
          update: {
            $set: {
              lotFills: {
                lot1: { filled: true,  fillDate: d.firstAppearanceDate, fillPrice: d.firstAppearancePrice },
                lot2: { filled: false, fillDate: null, fillPrice: null },
                lot3: { filled: false, fillDate: null, fillPrice: null },
                lot4: { filled: false, fillDate: null, fillPrice: null },
                lot5: { filled: false, fillDate: null, fillPrice: null },
              },
              lotsFilledCount: 1,
            },
          },
        },
      }));
      await col.bulkWrite(bulkOps);
      console.log(`[kill-appearances] Backfilled lotFills for ${needsFill.length} appearances`);
      // Patch in-memory docs so response is immediately correct
      needsFill.forEach(d => {
        d.lotFills = {
          lot1: { filled: true,  fillDate: d.firstAppearanceDate, fillPrice: d.firstAppearancePrice },
          lot2: { filled: false, fillDate: null, fillPrice: null },
          lot3: { filled: false, fillDate: null, fillPrice: null },
          lot4: { filled: false, fillDate: null, fillPrice: null },
          lot5: { filled: false, fillDate: null, fillPrice: null },
        };
        d.lotsFilledCount = d.lotsFilledCount ?? 1;
      });
    }

    res.json(docs);
  } catch (err) {
    console.error('[kill-appearances]', err);
    res.status(500).json({ error: 'Failed to load kill appearances' });
  }
});

// ── Kill Test Settings ────────────────────────────────────────────────────────
app.get('/api/kill-test/settings', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const settings = await getKillTestSettings();
    res.json(settings);
  } catch (err) {
    console.error('[kill-test/settings GET]', err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/kill-test/settings', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const settings = await saveKillTestSettings(req.body);
    res.json(settings);
  } catch (err) {
    console.error('[kill-test/settings PATCH]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Kill Test: Live Price Refresh ─────────────────────────────────────────────
// Fetches current quotes from FMP for all active appearances, updates
// lastSeenPrice / currentPnlPct / currentPnlDollar in MongoDB, returns price map.
app.post('/api/kill-test/refresh-prices', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const db  = await connectToDatabase();
    const col = db.collection('pnthr_kill_appearances');

    // Active appearances only
    const active = await col.find({ exitDate: null }).toArray();
    if (!active.length) return res.json({ prices: {}, updated: 0 });

    const tickers = [...new Set(active.map(a => a.ticker))];
    const key     = process.env.FMP_API_KEY;
    if (!key) return res.status(500).json({ error: 'FMP_API_KEY not configured' });

    // Batch quotes — FMP supports up to ~500 tickers comma-separated
    const priceMap = {};
    for (let i = 0; i < tickers.length; i += 200) {
      const chunk = tickers.slice(i, i + 200).join(',');
      try {
        const r    = await fetch(`https://financialmodelingprep.com/api/v3/quote/${chunk}?apikey=${key}`);
        const data = await r.json();
        if (Array.isArray(data)) {
          for (const q of data) {
            if (q.symbol && q.price != null) priceMap[q.symbol] = q.price;
          }
        }
      } catch (err) {
        console.error('[refresh-prices] FMP batch error:', err.message);
      }
    }

    // Update each active appearance in MongoDB
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    let updated = 0;
    const bulkOps = [];

    for (const appr of active) {
      const price = priceMap[appr.ticker];
      if (price == null) continue;

      const isShort    = appr.signal === 'SS';
      const avgCost    = appr.currentAvgCost ?? appr.firstAppearancePrice;
      const shares     = appr.currentShares  ?? 0;
      const pnlPct     = avgCost
        ? isShort
          ? ((avgCost - price) / avgCost) * 100
          : ((price - avgCost) / avgCost) * 100
        : 0;
      const pnlDollar  = isShort
        ? (avgCost - price) * shares
        : (price - avgCost) * shares;

      bulkOps.push({
        updateOne: {
          filter: { _id: appr._id },
          update: {
            $set: {
              lastSeenPrice:    price,
              lastSeenDate:     today,
              currentPnlPct:    +pnlPct.toFixed(2),
              currentPnlDollar: +pnlDollar.toFixed(2),
              updatedAt:        new Date(),
            },
          },
        },
      });
      updated++;
    }

    if (bulkOps.length) await col.bulkWrite(bulkOps);

    console.log(`[kill-test/refresh-prices] Updated ${updated} prices`);
    res.json({ prices: priceMap, updated, refreshedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[kill-test/refresh-prices]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Kill Test Monthly Snapshots & Analytics Metrics ───────────────────────────
app.get('/api/kill-test/monthly',          authenticateJWT, requireAdmin, killTestMonthlyGet);
app.get('/api/kill-test/metrics',          authenticateJWT, requireAdmin, killTestMetricsGet);
app.post('/api/kill-test/monthly/generate', authenticateJWT, requireAdmin, killTestMonthlyGenerate);

// ── Scoring Engine Health ───────────────────────────────────────────────────────
app.get('/api/scoring-health', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const db = await connectToDatabase();

    // pnthr_kill_scores has one doc PER STOCK per weekOf.
    // Find the most recent weekOf, then load all docs for that week.
    const latest = await db.collection('pnthr_kill_scores')
      .findOne({}, { sort: { createdAt: -1 }, projection: { weekOf: 1, createdAt: 1 } });

    if (!latest) {
      return res.json({ status: 'NO_DATA', message: 'No scoring run found yet. The Friday pipeline populates this.' });
    }

    const stocks = await db.collection('pnthr_kill_scores')
      .find({ weekOf: latest.weekOf })
      .toArray();

    const lastRun = latest.createdAt;

    // ── Helper: read one dimension key across all scored stock docs ─────────
    // Each doc has:  dimensions.d1.score, dimensions.d2.score, etc.
    function analyseD(key) {
      const vals = stocks
        .map(s => s.dimensions?.[key]?.score ?? null)
        .filter(v => v !== null && v !== undefined);
      const nonZero = vals.filter(v => v !== 0);
      return {
        count:   vals.length,
        nonZero: nonZero.length,
        sample:  nonZero[0] ?? vals[0] ?? null,
        allSame: new Set(vals.map(v => Math.round(v * 10))).size <= 1,
        hasData: nonZero.length > 0,
      };
    }

    const d1 = analyseD('d1');
    const d2 = analyseD('d2');
    const d3 = analyseD('d3');
    const d4 = analyseD('d4');
    const d5 = analyseD('d5');
    const d6 = analyseD('d6');
    const d7 = analyseD('d7');
    const d8 = analyseD('d8');

    const d1Varies = !d1.allSame;
    const d3Conf   = stocks.find(s => s.dimensions?.d3?.confirmation)?.dimensions?.d3?.confirmation || '—';

    function dim(id, name, range, src, stat, statusOverride) {
      const ok   = statusOverride ?? stat.hasData;
      const warn = !ok && stat.count > 0;
      return {
        id, name, range, source: src,
        status:  ok ? 'OK' : (warn ? 'WARNING' : 'ERROR'),
        hasData: stat.hasData,
        nonZero: stat.nonZero,
        total:   stat.count,
        sample:  stat.sample,
      };
    }

    const dimensions = [
      dim('D1','Market Regime',    '0.70× – 1.30×', 'SPY/QQQ vs 21-week EMA + signal ratio',   d1, d1Varies || d1.hasData),
      dim('D2','Sector Alignment', '−15 to +15 pts', 'FMP sector 5D/1M performance',             d2),
      dim('D3','Entry Quality',    '0 – 85 pts',     `Weekly candles (conviction/slope/sep) — ${d3Conf}`, d3),
      dim('D4','Signal Freshness', '−15 to +10 pts', 'Signal age (days since entry)',             d4),
      dim('D5','Rank Rise',        '−20 to +20 pts', 'PNTHR 100 weekly rankings delta',           d5),
      dim('D6','Momentum',         '−10 to +20 pts', 'RSI, OBV, ADX, volume ratio',              d6),
      dim('D7','Rank Velocity',    '−10 to +10 pts', 'Week-over-week rank change acceleration',   d7),
      dim('D8','Multi-Strategy',   '0 – 6 pts',      'PNTHR Prey strategies (HUNT/FEAST/etc.)',   d8),
    ];

    const okCount   = dimensions.filter(d => d.status === 'OK').length;
    const warnCount = dimensions.filter(d => d.status === 'WARNING').length;
    const errCount  = dimensions.filter(d => d.status === 'ERROR').length;

    res.json({
      status:       errCount > 0 ? 'ERROR' : warnCount > 0 ? 'WARNING' : 'OK',
      lastRun,
      weekOf:       latest.weekOf,
      source:       'pnthr_kill_scores',
      stocksScored: stocks.length,
      okCount,
      warnCount,
      errCount,
      dimensions,
    });
  } catch (err) {
    console.error('[scoring-health]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PNTHR Command Center ───────────────────────────────────────────────────────
app.get('/api/kill-pipeline',       authenticateJWT, killPipelineHandler);
app.get('/api/positions',           authenticateJWT, positionsGetAll);
app.post('/api/positions',          authenticateJWT, positionsSave);
app.post('/api/positions/close',    authenticateJWT, positionsClose);
app.delete('/api/positions/:id',    authenticateJWT, positionsDelete);

// PATCH /api/positions/:id/direction — explicit user-initiated direction correction
app.patch('/api/positions/:id/direction', authenticateJWT, async (req, res) => {
  try {
    const { direction } = req.body;
    if (!['LONG', 'SHORT'].includes(direction)) {
      return res.status(400).json({ error: 'direction must be LONG or SHORT' });
    }
    const { connectToDatabase } = await import('./database.js');
    const db = await connectToDatabase();
    const result = await db.collection('pnthr_portfolio').updateOne(
      { id: req.params.id, ownerId: req.user.userId },
      { $set: { direction, updatedAt: new Date() } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Position not found' });
    // Also update journal entry so direction badge + discipline scoring stay correct
    await db.collection('pnthr_journal').updateMany(
      { positionId: req.params.id, userId: req.user.userId },
      { $set: { direction, 'entry.direction': direction, updatedAt: new Date() } }
    );
    res.json({ success: true, direction });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/ibkr/sync',          authenticateJWT, ibkrSync);

// ── IBKR Discrepancy Check ─────────────────────────────────────────────────
// Compares pnthr_ibkr_positions against pnthr_portfolio for 4 error types:
//   A. TICKER_MISSING  — ticker in IBKR but not Command (or vice versa)
//   B. SHARES_MISMATCH — share count differs between IBKR and Command
//   C. PRICE_MISMATCH  — avg cost differs by ≥0.5% (beyond commission noise)
//   D. STOP_MISSING    — Command position has no stop set (CRITICAL)
//   E. STOP_MISMATCH   — Command stop differs from IBKR stop order
app.get('/api/ibkr/discrepancies', authenticateJWT, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const db = await connectToDatabase();
    const userId = req.user.userId;

    // Load IBKR data (single doc per user)
    const ibkrDoc = await db.collection('pnthr_ibkr_positions').findOne({ ownerId: userId });
    if (!ibkrDoc) return res.json({ discrepancies: [], ibkrConnected: false });

    const allIbkrPositions = ibkrDoc.positions || [];
    const ibkrStops = ibkrDoc.stopOrders || [];
    const syncedAt = ibkrDoc.syncedAt || null;
    const staleMins = syncedAt ? Math.round((Date.now() - new Date(syncedAt)) / 60000) : null;
    const isStale = staleMins != null && staleMins > 10;

    // ── Fix 1: Only treat positions with actual shares as "active" ─────────
    // IBKR keeps closed positions in its feed briefly with 0 shares.
    // Filtering these out prevents false-positive IBKR_ONLY alerts (e.g. COIN
    // showing "24 shr" when the position was already closed to 0).
    const ibkrPositions = allIbkrPositions.filter(ip => Math.abs(+ip.shares || 0) >= 1);

    // Build a secondary map of zero-share IBKR positions so we can give a more
    // accurate COMMAND_ONLY message ("IBKR shows 0 shares" vs "not found in IBKR").
    const ibkrZeroShareTickers = new Set(
      allIbkrPositions
        .filter(ip => ip.symbol && Math.abs(+ip.shares || 0) < 1)
        .map(ip => ip.symbol.toUpperCase())
    );

    // Load PNTHR active positions
    const pnthrPositions = await db.collection('pnthr_portfolio')
      .find({ ownerId: userId, status: 'ACTIVE' })
      .toArray();

    // Build lookup maps (active IBKR positions only — 0-share entries excluded)
    const ibkrByTicker = {};
    for (const ip of ibkrPositions) {
      if (ip.symbol) ibkrByTicker[ip.symbol.toUpperCase()] = ip;
    }
    const ibkrStopByTicker = {};
    for (const s of ibkrStops) {
      if (s.symbol) ibkrStopByTicker[s.symbol.toUpperCase()] = s;
    }
    const pnthrByTicker = {};
    for (const pp of pnthrPositions) {
      if (pp.ticker) pnthrByTicker[pp.ticker.toUpperCase()] = pp;
    }

    // Helper: compute PNTHR avg cost from fills
    function pnthrAvgCost(p) {
      if (p.manualAvgCost) return +p.manualAvgCost;
      let cost = 0, shares = 0;
      for (let i = 1; i <= 5; i++) {
        const f = p.fills?.[i];
        if (f?.filled && f?.price && f?.shares) { cost += +f.shares * +f.price; shares += +f.shares; }
      }
      return shares > 0 ? cost / shares : (p.entryPrice || 0);
    }

    // Helper: compute total remaining shares in PNTHR
    function pnthrShares(p) {
      return p.remainingShares ?? Object.values(p.fills || {}).filter(f => f?.filled).reduce((s, f) => s + (+f.shares || 0), 0);
    }

    const discrepancies = [];

    // Check all PNTHR active positions vs IBKR
    for (const [ticker, p] of Object.entries(pnthrByTicker)) {
      const ip = ibkrByTicker[ticker];
      // positionId = PNTHR's string id field (used for surgical PATCH via POST /api/positions)
      const positionId = p.id || null;
      const direction  = p.direction || 'LONG';

      // A. Ticker in Command but missing from active IBKR positions
      if (!ip) {
        // ── Fix 2: Distinguish "IBKR shows 0 shares" vs "not in IBKR feed at all"
        // Both mean the position was likely closed in IBKR — but the message
        // should reflect which case it is so the user understands what happened.
        const ibkrShowsZero = ibkrZeroShareTickers.has(ticker);
        discrepancies.push({
          type: 'TICKER_MISSING',
          severity: 'CRITICAL',
          ticker,
          side: 'COMMAND_ONLY',
          positionId,
          direction,
          pnthrShares: pnthrShares(p),
          ibkrShowsZero, // true = IBKR has it at 0 shares; false = not in IBKR at all
        });
        continue; // no further checks if ticker is missing from active IBKR
      }

      // B. Shares mismatch
      const pShares = pnthrShares(p);
      const iShares = Math.abs(+ip.shares || 0); // IBKR uses negative for shorts
      if (pShares > 0 && iShares > 0 && pShares !== iShares) {
        discrepancies.push({
          type: 'SHARES_MISMATCH',
          severity: Math.abs(pShares - iShares) > 1 ? 'HIGH' : 'MEDIUM',
          ticker,
          positionId,
          direction,
          pnthrShares: pShares,
          ibkrShares: iShares,
          diff: pShares - iShares,
        });
      }

      // C. Avg cost / price mismatch
      const pAvg = pnthrAvgCost(p);
      const iAvg = +ip.avgCost || 0;
      if (pAvg > 0 && iAvg > 0) {
        const diffAbs = Math.abs(pAvg - iAvg);
        const diffPct = diffAbs / pAvg;
        if (diffPct >= 0.005) { // 0.5% threshold — beyond commission noise
          discrepancies.push({
            type: 'PRICE_MISMATCH',
            severity: diffPct >= 0.02 ? 'HIGH' : 'MEDIUM',
            ticker,
            positionId,
            direction,
            pnthrAvg: +pAvg.toFixed(2),
            ibkrAvg:  +iAvg.toFixed(2),
            diffPct:  +(diffPct * 100).toFixed(2),
          });
        }
      }

      // D. Stop missing in Command
      if (!p.stopPrice || +p.stopPrice === 0) {
        discrepancies.push({
          type: 'STOP_MISSING',
          severity: 'CRITICAL',
          ticker,
          positionId,
          direction,
          ibkrStop: ibkrStopByTicker[ticker]?.stopPrice ? +ibkrStopByTicker[ticker].stopPrice : null,
        });
      } else {
        // E. Stop mismatch — IBKR has a stop order that differs from Command stop
        const ibkrStop = ibkrStopByTicker[ticker];
        if (ibkrStop?.stopPrice) {
          const pStop = +p.stopPrice;
          const iStop = +ibkrStop.stopPrice;
          const stopDiffPct = Math.abs(pStop - iStop) / pStop;
          if (stopDiffPct >= 0.005) {
            discrepancies.push({
              type: 'STOP_MISMATCH',
              severity: 'HIGH',
              ticker,
              positionId,
              direction,
              pnthrStop: +pStop.toFixed(2),
              ibkrStop:  +iStop.toFixed(2),
              diff:      +(pStop - iStop).toFixed(2),
            });
          }
        }
      }
    }

    // A. Tickers in IBKR (with actual shares) but not in Command — untracked open position
    // ── Fix 3: Attach isStale flag so client can note "data may be outdated"
    const syncIsStale = staleMins != null && staleMins > 5; // 5-min freshness threshold
    for (const ticker of Object.keys(ibkrByTicker)) {
      if (!pnthrByTicker[ticker]) {
        discrepancies.push({
          type: 'TICKER_MISSING',
          severity: 'CRITICAL',
          ticker,
          side: 'IBKR_ONLY',
          positionId: null,
          ibkrShares: Math.abs(+ibkrByTicker[ticker].shares || 0),
          syncIsStale, // if true, banner shows "⏱ data may be outdated" note
          staleMins,
        });
      }
    }

    // Sort: CRITICAL first, then HIGH, then MEDIUM
    const SEVERITY_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
    discrepancies.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));

    res.json({ discrepancies, ibkrConnected: true, syncedAt, isStale: syncIsStale, staleMins });
  } catch (err) {
    console.error('[IBKR discrepancies]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ticker/:symbol',      authenticateJWT, tickerHandler);
app.get('/api/regime',              authenticateJWT, regimeHandler);

// ── Pending Entries & NAV Settings ────────────────────────────────────────────
app.get('/api/settings/nav',                    authenticateJWT, navGet);
app.post('/api/settings/nav',                   authenticateJWT, navPost);
app.get('/api/pending-entries',                 authenticateJWT, pendingEntriesGet);
app.post('/api/pending-entries',                authenticateJWT, pendingEntriesPost);
app.post('/api/pending-entries/:id/confirm',    authenticateJWT, pendingEntryConfirm);
app.post('/api/pending-entries/:id/dismiss',    authenticateJWT, pendingEntryDismiss);

// ── Exit Service ──────────────────────────────────────────────────────────────

// POST /api/positions/:id/exit — record an exit (partial or full)
app.post('/api/positions/:id/exit', authenticateJWT, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const db = await connectToDatabase();
    const { shares, price, date, time, reason, note } = req.body;
    if (!shares || !price || !date || !reason) return res.status(400).json({ error: 'shares, price, date, reason required' });
    if (reason === 'MANUAL' && !note) return res.status(400).json({ error: 'Note is required for MANUAL exits' });
    const result = await recordExit(db, req.params.id, req.user.userId, { shares: Number(shares), price: Number(price), date, time, reason, note });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// DELETE /api/positions/:id/exits/:eid — undo an exit
app.delete('/api/positions/:id/exits/:eid', authenticateJWT, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const db = await connectToDatabase();
    const position = await db.collection('pnthr_portfolio').findOne({ id: req.params.id, ownerId: req.user.userId });
    if (!position) return res.status(404).json({ error: 'Not found' });
    const exitToRemove = (position.exits || []).find(e => e.id === req.params.eid);
    if (!exitToRemove) return res.status(404).json({ error: 'Exit not found' });
    const newExits = (position.exits || []).filter(e => e.id !== req.params.eid);
    const totalFilled = position.totalFilledShares || calcTotalFilled(position);
    const newExited = newExits.reduce((s, e) => s + e.shares, 0);
    const newRemaining = totalFilled - newExited;
    const realizedDollar = newExits.reduce((s, e) => s + (e.pnl?.dollar || 0), 0);
    const newStatus = newExited === 0 ? 'ACTIVE' : newRemaining === 0 ? 'CLOSED' : 'PARTIAL';
    await db.collection('pnthr_portfolio').updateOne(
      { id: req.params.id, ownerId: req.user.userId },
      { $set: { exits: newExits, remainingShares: newRemaining, totalExitedShares: newExited, status: newStatus, 'realizedPnl.dollar': realizedDollar, updatedAt: new Date() } }
    );
    res.json({ ok: true, remainingShares: newRemaining, status: newStatus });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Journal API ───────────────────────────────────────────────────────────────

// GET /api/journal — all journal entries for user
app.get('/api/journal', authenticateJWT, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const db = await connectToDatabase();
    const { status, limit = 50 } = req.query;
    const filter = { ownerId: req.user.userId };
    if (status) filter['performance.status'] = status;
    const entries = await db.collection('pnthr_journal')
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .toArray();
    res.json(entries);
    // Lazy backfill: compute discipline score for any closed trade that's missing it.
    // Fire-and-forget after response — doesn't affect response time.
    const needsScore = entries.filter(
      e => e.performance?.status === 'CLOSED' && e.discipline?.totalScore == null
    );
    if (needsScore.length) {
      setImmediate(async () => {
        for (const e of needsScore) {
          try { await calculateDisciplineScore(db, e._id.toString()); } catch { /* ignore */ }
        }
      });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/journal/migrate — one-time backfill: create journal entries for existing positions (admin only)
// Also claims orphaned positions (no ownerId — created before per-user scoping)
app.post('/api/journal/migrate', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const mdb = await connectToDatabase();
    const userId = req.user.userId;
    // Find positions owned by this user OR orphaned (no ownerId — pre-scoping era)
    const positions = await mdb.collection('pnthr_portfolio')
      .find({ $or: [{ ownerId: userId }, { ownerId: { $exists: false } }, { ownerId: null }] })
      .toArray();
    let created = 0, updated = 0, claimed = 0;
    for (const pos of positions) {
      // Claim orphaned positions for this user
      if (!pos.ownerId) {
        await mdb.collection('pnthr_portfolio').updateOne(
          { _id: pos._id },
          { $set: { ownerId: userId } }
        );
        claimed++;
        pos.ownerId = userId;
      }
      // pos.id is the custom string ID (e.g. "m3abc1xyz") used by createJournalEntry
      // pos._id is MongoDB ObjectId — journal entries store positionId = pos.id, not pos._id
      const posId = pos.id || pos._id.toString();
      const existing = await mdb.collection('pnthr_journal').findOne({
        positionId: posId,
        ownerId: userId,
      });

      // Build position-derived fields from live portfolio data (sacred source of truth)
      const fills = Object.values(pos.fills || {}).filter(f => f && f.filled && f.price);
      const lot1  = fills[0] || null;
      const positionFields = {
        'entry.fillDate':                lot1?.date  || existing?.entry?.fillDate  || null,
        'entry.fillPrice':               lot1?.price || pos.entryPrice             || existing?.entry?.fillPrice || null,
        'entry.stopPrice':               pos.stopPrice                             || existing?.entry?.stopPrice || null,
        lots:                            fills.map((f, i) => ({ lot: i + 1, shares: f.shares, price: f.price, date: f.date })),
        totalFilledShares:               fills.reduce((s, f) => s + (f.shares || 0), 0),
        exits:                           pos.exits || existing?.exits || [],
        'performance.status':            pos.status || existing?.performance?.status || 'ACTIVE',
        'performance.remainingShares':   pos.remainingShares ?? fills.reduce((s, f) => s + (f.shares || 0), 0),
        'performance.avgExitPrice':      pos.avgExitPrice    || existing?.performance?.avgExitPrice || null,
        'performance.realizedPnlDollar': pos.realizedPnl?.dollar ?? existing?.performance?.realizedPnlDollar ?? 0,
        updatedAt: new Date(),
      };

      if (existing) {
        // Refresh position-derived fields — never touch notes, tags, discipline, washRule, whatIf
        await mdb.collection('pnthr_journal').updateOne(
          { _id: existing._id },
          { $set: positionFields }
        );
        updated++;
      } else {
        await createJournalEntry(mdb, pos, userId, null);
        created++;
      }
    }
    res.json({ ok: true, created, updated, claimed, total: positions.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/portfolio/ratios — Sharpe & Sortino from weekly portfolio return snapshots
app.get('/api/portfolio/ratios', authenticateJWT, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });

    const snapshots = await db.collection('pnthr_portfolio_returns')
      .find({ ownerId: req.user.userId })
      .sort({ date: -1 })
      .limit(52)
      .toArray();

    if (snapshots.length < 4) {
      return res.json({
        current: { sharpe: null, sortino: null },
        trailing13wk: { sharpe: null, sortino: null },
        trailing26wk: { sharpe: null, sortino: null },
        trailing52wk: { sharpe: null, sortino: null },
        sinceInception: { sharpe: null, sortino: null },
        weeksOfData: snapshots.length,
        latestNav: snapshots[0]?.nav ?? null,
        cumulativeReturn: snapshots[0]?.cumulativeReturn ?? null,
        message: `Need at least 4 weeks of data (have ${snapshots.length})`,
      });
    }

    function computeRatios(snaps) {
      if (!snaps || snaps.length < 2) return { sharpe: null, sortino: null };
      const returns = snaps.map(s => s.weeklyReturn);
      const rfRates  = snaps.map(s => s.riskFreeRate || 0);
      const excess   = returns.map((r, i) => r - rfRates[i]);
      const avgExcess = excess.reduce((a, b) => a + b, 0) / excess.length;
      const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance  = returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (returns.length - 1);
      const stdDev    = Math.sqrt(variance);
      const downside  = excess.filter(r => r < 0);
      const dsVar     = downside.length > 0
        ? downside.reduce((s, r) => s + r * r, 0) / downside.length : 0;
      const dsDev     = Math.sqrt(dsVar);
      const ann       = Math.sqrt(52);
      return {
        sharpe:  stdDev > 0    ? +((avgExcess / stdDev)  * ann).toFixed(2) : null,
        sortino: dsDev > 0     ? +((avgExcess / dsDev)   * ann).toFixed(2) : null,
      };
    }

    const slice = (n) => snapshots.slice(0, n);

    res.json({
      current:        computeRatios(snapshots),
      trailing13wk:   computeRatios(slice(13)),
      trailing26wk:   computeRatios(slice(26)),
      trailing52wk:   computeRatios(slice(52)),
      sinceInception: computeRatios(snapshots),
      weeksOfData:    snapshots.length,
      latestNav:      snapshots[0]?.nav ?? null,
      cumulativeReturn: snapshots[0]?.cumulativeReturn ?? null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/journal/analytics — discipline stats (must be before /:id)
app.get('/api/journal/analytics', authenticateJWT, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const db = await connectToDatabase();
    const entries = await db.collection('pnthr_journal')
      .find({ ownerId: req.user.userId, 'performance.status': 'CLOSED' })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    const scores = entries.map(e => e.discipline?.totalScore).filter(s => s != null);
    const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

    const overrideEntries = entries.filter(e => (e.discipline?.overrideCount || 0) > 0);
    const disciplinedWinners = entries.filter(e => (e.discipline?.totalScore || 0) >= 75 && (e.performance?.realizedPnlDollar || e.performance?.totalPnlDollar || 0) > 0);
    const disciplinedTotal = entries.filter(e => (e.discipline?.totalScore || 0) >= 75);
    const overrideWinners = overrideEntries.filter(e => (e.performance?.totalPnlDollar || 0) > 0);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const overridesThisMonth = entries.filter(e => e.updatedAt > monthStart && (e.discipline?.overrideCount || 0) > 0);

    // Streak: consecutive closed trades with no overrides (most recent first)
    let streak = 0;
    for (const e of entries) {
      if ((e.discipline?.overrideCount || 0) === 0) streak++;
      else break;
    }

    res.json({
      avgDisciplineScore: avgScore,
      totalTrades: entries.length,
      streak,
      overridesThisMonth: overridesThisMonth.length,
      disciplineWinRate: disciplinedTotal.length ? Math.round(disciplinedWinners.length / disciplinedTotal.length * 100) : null,
      overrideWinRate: overrideEntries.length ? Math.round(overrideWinners.length / overrideEntries.length * 100) : null,
      overrideCostThisMonth: null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/journal/weekly-reviews — must be before /:id
app.get('/api/journal/weekly-reviews', authenticateJWT, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const db = await connectToDatabase();
    const reviews = await db.collection('pnthr_weekly_reviews')
      .find({ ownerId: req.user.userId })
      .sort({ weekOf: -1 })
      .limit(12)
      .toArray();
    res.json(reviews);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/journal/weekly-reviews — must be before /:id
app.post('/api/journal/weekly-reviews', authenticateJWT, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const db = await connectToDatabase();
    const { weekOf, reflection } = req.body;
    if (!weekOf) return res.status(400).json({ error: 'weekOf required' });
    await db.collection('pnthr_weekly_reviews').updateOne(
      { ownerId: req.user.userId, weekOf },
      { $set: { ownerId: req.user.userId, weekOf, reflection, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/wash-rules — active wash sale windows for current user; ?ticker=X to filter
app.get('/api/wash-rules', authenticateJWT, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const db = await connectToDatabase();
    const now = new Date();
    const filter = {
      ownerId: req.user.userId,
      'washSale.isLoss': true,
      $or: [
        { 'washSale.expiryDate': { $gt: now } },
        { 'washSale.triggered': true },
      ],
    };
    if (req.query.ticker) filter.ticker = req.query.ticker.toUpperCase();
    const rules = await db.collection('pnthr_journal').find(filter)
      .project({ ticker: 1, direction: 1, washSale: 1, 'performance.realizedPnlDollar': 1 })
      .sort({ 'washSale.expiryDate': 1 })
      .toArray();
    const enriched = rules.map(r => ({
      ...r,
      washSale: {
        ...r.washSale,
        // Normalize both to UTC midnight for clean calendar-day counting
        daysRemaining: (() => {
          const expiryDay = new Date(new Date(r.washSale.expiryDate).toISOString().split('T')[0] + 'T00:00:00.000Z');
          const todayDay  = new Date(now.toISOString().split('T')[0] + 'T00:00:00.000Z');
          return Math.max(0, Math.round((expiryDay - todayDay) / 86400000));
        })(),
      },
    }));
    res.json(enriched);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/journal/closed-scorecard — all CLOSED journal entries for scorecard grid (must be before /:id)
// Also catches entries with exits that are stuck at ACTIVE due to pre-fix syncExitToJournal bug.
app.get('/api/journal/closed-scorecard', authenticateJWT, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });

    const entries = await db.collection('pnthr_journal')
      .find({
        ownerId: req.user.userId,
        $or: [
          { 'performance.status': 'CLOSED' },
          // Catch entries stuck at ACTIVE/PARTIAL that have exit data (pre-Round-1-fix positions)
          { 'performance.exits.0': { $exists: true } },
        ],
      })
      .sort({ createdAt: -1 })
      .toArray();

    // Lazy-fix any stuck entries: if exits exist and remainingShares===0 mark CLOSED server-side
    setImmediate(async () => {
      // Fix 1: journal has exits but wrong status
      for (const e of entries) {
        if (e.performance?.status !== 'CLOSED' && Array.isArray(e.performance?.exits) && e.performance.exits.length > 0 && (e.performance?.remainingShares ?? 1) === 0) {
          try {
            await db.collection('pnthr_journal').updateOne(
              { _id: e._id },
              { $set: { 'performance.status': 'CLOSED', updatedAt: new Date() } }
            );
          } catch { /* best-effort */ }
        }
      }

      // Fix 2: IBKR auto-closed portfolio entries whose journal was never synced
      // or was never created (e.g. position added directly without pendingEntries flow).
      try {
        const { syncExitToJournal } = await import('./exitService.js');
        const { createJournalEntry } = await import('./journalService.js');
        const ibkrClosed = await db.collection('pnthr_portfolio').find({
          ownerId: req.user.userId,
          status: 'CLOSED',
          autoClosedByIBKR: true,
        }).toArray();

        const ibkrPositionIds = ibkrClosed.map(p => p.id?.toString()).filter(Boolean);
        const existingJournals = ibkrPositionIds.length
          ? await db.collection('pnthr_journal').find({
              ownerId: req.user.userId,
              positionId: { $in: ibkrPositionIds },
            }).toArray()
          : [];
        const journalByPositionId = {};
        for (const e of existingJournals) {
          journalByPositionId[e.positionId] = e;
        }

        for (const pos of ibkrClosed) {
          const jEntry = journalByPositionId[pos.id?.toString()];

          const outcome     = pos.outcome || {};
          const exitPrice   = outcome.exitPrice   ?? pos.entryPrice ?? 0;
          const exitReason  = outcome.exitReason  ?? 'MANUAL';
          const profitDollar = outcome.profitDollar ?? 0;
          const profitPct    = outcome.profitPct    ?? 0;
          const fills        = pos.fills || {};
          const pnthrShares  = Object.values(fills)
            .reduce((s, f) => s + (f.filled ? (+f.shares || 0) : 0), 0);
          const totalCost    = Object.values(fills)
            .reduce((s, f) => s + (f.filled ? (+f.shares || 0) * (+f.price || 0) : 0), 0);
          const avgCost      = pnthrShares > 0 ? totalCost / pnthrShares : (pos.entryPrice || 0);
          const isLong       = pos.direction === 'LONG';
          const closedAt     = pos.closedAt ? new Date(pos.closedAt) : new Date();

          const exitRecord = {
            id: 'E1', shares: pnthrShares, price: exitPrice,
            date: closedAt.toISOString().split('T')[0],
            time: closedAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }),
            reason: exitReason, note: 'Auto-closed by IBKR TWS fill detection',
            isOverride: exitReason === 'MANUAL', isFinalExit: true,
            pnl: {
              dollar:   +profitDollar.toFixed(2),
              pct:      +profitPct.toFixed(2),
              perShare: +(isLong ? exitPrice - avgCost : avgCost - exitPrice).toFixed(4),
            },
            remainingShares: 0, marketAtExit: {}, createdAt: closedAt,
          };

          if (!jEntry) {
            // Case A: No journal entry at all — create one from portfolio data then sync exit.
            // This happens when a position was added directly (not via pendingEntries confirm flow).
            try {
              await createJournalEntry(db, pos, req.user.userId);
              await syncExitToJournal(db, pos.id, req.user.userId, exitRecord, 0, profitDollar, exitPrice, 'CLOSED', pos);
              console.log(`[Journal] ✅ Created missing journal entry for IBKR-closed ${pos.ticker}`);
            } catch (createErr) {
              console.warn(`[Journal] Create failed for ${pos.ticker}:`, createErr.message);
            }
            continue;
          }

          // Case B: Journal exists — check if exit already synced (top-level exits array)
          if (Array.isArray(jEntry.exits) && jEntry.exits.length > 0) continue;
          if (jEntry.performance?.status === 'CLOSED') continue;

          // Case C: Journal exists but exit not yet synced — sync now
          try {
            await syncExitToJournal(db, pos.id, req.user.userId, exitRecord, 0, profitDollar, exitPrice, 'CLOSED', pos);
            console.log(`[Journal] ✅ Repaired stuck IBKR-closed entry for ${pos.ticker}`);
          } catch (repairErr) {
            console.warn(`[Journal] Repair failed for ${pos.ticker}:`, repairErr.message);
          }
        }
      } catch (e2) { console.warn('[Journal] IBKR repair pass failed:', e2.message); }
    });

    res.json(entries);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/journal/repair-ibkr — one-time repair that creates/fixes journal entries for all
// IBKR auto-closed positions. Handles three cases:
//   A) No journal entry at all → create from portfolio position data + sync exit
//   B) Journal exists, direction mismatch vs portfolio → patch core fields + rescore
//   C) Journal exists, exits not synced → sync exit
// Safe to run multiple times — already-correct entries are skipped.
app.post('/api/journal/repair-ibkr', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const { ObjectId } = await import('mongodb');
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });

    const { syncExitToJournal } = await import('./exitService.js');
    const { createJournalEntry, calculateDisciplineScore } = await import('./journalService.js');

    const userId = req.user.userId;
    const log = [];

    const ibkrClosed = await db.collection('pnthr_portfolio').find({
      ownerId: userId,
      status: 'CLOSED',
      autoClosedByIBKR: true,
    }).toArray();

    if (!ibkrClosed.length) {
      return res.json({ ok: true, repaired: 0, log: ['No IBKR auto-closed positions found'] });
    }

    const ibkrPositionIds = ibkrClosed.map(p => p.id?.toString()).filter(Boolean);
    const existingJournals = await db.collection('pnthr_journal').find({
      ownerId: userId,
      positionId: { $in: ibkrPositionIds },
    }).toArray();
    const journalByPositionId = {};
    for (const e of existingJournals) {
      journalByPositionId[e.positionId] = e;
    }

    let repaired = 0;

    for (const pos of ibkrClosed) {
      const posId   = pos.id?.toString();
      const jEntry  = journalByPositionId[posId];
      const outcome = pos.outcome || {};

      // Build exit record from portfolio outcome data
      const exitPrice    = outcome.exitPrice    ?? pos.entryPrice ?? 0;
      const exitReason   = outcome.exitReason   ?? 'MANUAL';
      const profitDollar = outcome.profitDollar ?? 0;
      const profitPct    = outcome.profitPct    ?? 0;
      const fills        = pos.fills || {};
      const pnthrShares  = Object.values(fills)
        .reduce((s, f) => s + (f.filled ? (+f.shares || 0) : 0), 0);
      const totalCost    = Object.values(fills)
        .reduce((s, f) => s + (f.filled ? (+f.shares || 0) * (+f.price || 0) : 0), 0);
      const avgCost      = pnthrShares > 0 ? totalCost / pnthrShares : (pos.entryPrice || 0);
      const isLong       = pos.direction === 'LONG';
      const closedAt     = pos.closedAt ? new Date(pos.closedAt) : new Date();

      const exitRecord = {
        id: 'E1', shares: pnthrShares, price: exitPrice,
        date: closedAt.toISOString().split('T')[0],
        time: closedAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }),
        reason: exitReason, note: 'Auto-closed by IBKR TWS fill detection',
        isOverride: exitReason === 'MANUAL', isFinalExit: true,
        pnl: {
          dollar:   +profitDollar.toFixed(2),
          pct:      +profitPct.toFixed(2),
          perShare: +(isLong ? exitPrice - avgCost : avgCost - exitPrice).toFixed(4),
        },
        remainingShares: 0, marketAtExit: {}, createdAt: closedAt,
      };

      // ── Case A: No journal entry — create from portfolio position then sync exit ──
      if (!jEntry) {
        try {
          const created = await createJournalEntry(db, pos, userId);
          await syncExitToJournal(db, posId, userId, exitRecord, 0, profitDollar, exitPrice, 'CLOSED', pos);
          log.push(`✅ [${pos.ticker}] Created new journal entry + synced exit (positionId: ${posId})`);
          repaired++;
        } catch (e) {
          log.push(`❌ [${pos.ticker}] Create failed: ${e.message}`);
        }
        continue;
      }

      // ── Case B: Journal exists but core fields are wrong (direction mismatch) ──
      // This happens when a wrong/old position was previously linked. Overwrite with
      // data from the correct portfolio position.
      const directionMismatch = jEntry.direction !== pos.direction;
      const fillsMismatch     = jEntry.lots?.length !== Object.values(fills).filter(f => f.filled).length;

      if (directionMismatch) {
        try {
          // Rebuild core fields from the portfolio position
          const fillEntries = Object.entries(fills)
            .filter(([, f]) => f && f.filled && f.price)
            .sort(([a], [b]) => +a - +b);
          const lot1 = fillEntries[0]?.[1] || null;
          const lotsArr = fillEntries.map(([k, f]) => ({ lot: +k, shares: f.shares, price: f.price, date: f.date }));

          await db.collection('pnthr_journal').updateOne(
            { _id: jEntry._id },
            {
              $set: {
                direction:          pos.direction,
                ticker:             pos.ticker,
                signal:             pos.signal    || null,
                signalAge:          pos.signalAge ?? null,
                exchange:           pos.exchange  || null,
                entryContext:       pos.entryContext || 'NO_SIGNAL',
                'entry.fillDate':   lot1?.date  || null,
                'entry.fillPrice':  lot1?.price || pos.entryPrice || null,
                'entry.stopPrice':  pos.stopPrice || null,
                'entry.signalType': pos.signal || (pos.direction === 'LONG' ? 'BL' : 'SS'),
                lots:               lotsArr,
                totalFilledShares:  fillEntries.reduce((s, [, f]) => s + (f.shares || 0), 0),
                // Clear any exits from the old wrong position — will be re-synced below
                exits:              [],
                'performance.status':           'ACTIVE',
                'performance.remainingShares':  pnthrShares,
                'performance.avgExitPrice':     null,
                'performance.realizedPnlDollar': 0,
                updatedAt: new Date(),
              },
            }
          );
          // Now sync the correct exit
          await syncExitToJournal(db, posId, userId, exitRecord, 0, profitDollar, exitPrice, 'CLOSED', pos);
          log.push(`✅ [${pos.ticker}] Fixed direction mismatch (was ${jEntry.direction} → ${pos.direction}) + resynced exit`);
          repaired++;
        } catch (e) {
          log.push(`❌ [${pos.ticker}] Direction fix failed: ${e.message}`);
        }
        continue;
      }

      // ── Case C: Journal exists, direction correct, but exit not yet synced ──
      const hasExit = Array.isArray(jEntry.exits) && jEntry.exits.length > 0;
      if (hasExit && jEntry.performance?.status === 'CLOSED') {
        log.push(`⏭ [${pos.ticker}] Already correct — skipped`);
        continue;
      }
      try {
        await syncExitToJournal(db, posId, userId, exitRecord, 0, profitDollar, exitPrice, 'CLOSED', pos);
        log.push(`✅ [${pos.ticker}] Synced missing exit data`);
        repaired++;
      } catch (e) {
        log.push(`❌ [${pos.ticker}] Exit sync failed: ${e.message}`);
      }
    }

    res.json({ ok: true, repaired, total: ibkrClosed.length, log });
  } catch (e) {
    console.error('[journal/repair-ibkr]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/journal/:id/scorecard-notes — save tradeNotes and/or macroNotes (must be before /:id)
app.patch('/api/journal/:id/scorecard-notes', authenticateJWT, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const { ObjectId } = await import('mongodb');
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });

    const { tradeNotes, macroNotes } = req.body;
    const setFields = { updatedAt: new Date() };
    if (tradeNotes !== undefined) setFields.tradeNotes = tradeNotes;
    if (macroNotes !== undefined) setFields.macroNotes = macroNotes;

    const result = await db.collection('pnthr_journal').updateOne(
      { _id: new ObjectId(req.params.id), ownerId: req.user.userId },
      { $set: setFields }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Entry not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/journal/rescore-all — rescore all closed journal entries; backfills signal from killScore (admin)
app.post('/api/journal/rescore-all', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const { computeDisciplineScore } = await import('./disciplineScoring.js');
    const db = await connectToDatabase();

    const entries = await db.collection('pnthr_journal')
      .find({ ownerId: req.user.userId, 'performance.status': 'CLOSED' })
      .toArray();

    const results = [];
    for (const entry of entries) {
      const fixes = {};

      // Auto-backfill: copy signal/signalAge from killScoreAtEntry if missing at top level
      if (!entry.signal && entry.killScoreAtEntry?.signal) {
        fixes.signal    = entry.killScoreAtEntry.signal;
        fixes.signalAge = entry.killScoreAtEntry.signalAge ?? null;
        if (fixes.signal && (fixes.signalAge ?? 0) <= 1) {
          fixes.entryContext = 'CONFIRMED_SIGNAL';
        } else if (fixes.signal) {
          fixes.entryContext = 'STALE_SIGNAL';
        }
        console.log(`[RESCORE] ${entry.ticker}: backfilled signal=${fixes.signal} signalAge=${fixes.signalAge} from killScore`);
      }

      // Auto-backfill: copy spyPosition/qqqPosition into marketAtEntry if empty
      if (!entry.marketAtEntry?.spyPosition) {
        try {
          const regime = await db.collection('pnthr_kill_regime').findOne({}, { sort: { weekOf: -1 } });
          if (regime) {
            fixes.marketAtEntry = {
              ...(entry.marketAtEntry || {}),
              spyPosition: regime.spyPosition || null,
              qqqPosition: regime.qqqPosition || null,
              regime:      regime.regime || null,
              _source:     'regime_fallback_rescore',
            };
            console.log(`[RESCORE] ${entry.ticker}: backfilled market data from regime doc`);
          }
        } catch {}
      }

      if (Object.keys(fixes).length > 0) {
        await db.collection('pnthr_journal').updateOne(
          { _id: entry._id },
          { $set: { ...fixes, updatedAt: new Date() } }
        );
        Object.assign(entry, fixes);
      }

      const newScore = computeDisciplineScore(entry);
      await db.collection('pnthr_journal').updateOne(
        { _id: entry._id },
        { $set: { discipline: newScore, updatedAt: new Date() } }
      );

      results.push({ ticker: entry.ticker, oldScore: entry.discipline?.totalScore, newScore: newScore.totalScore, tierLabel: newScore.tierLabel, fixes: Object.keys(fixes) });
    }

    res.json({ success: true, count: results.length, results });
  } catch (e) {
    console.error('[journal/rescore-all]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/journal/:id/confirm-score — user confirms missing data, triggers rescore
app.put('/api/journal/:id/confirm-score', authenticateJWT, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const { ObjectId } = await import('mongodb');
    const { computeDisciplineScore } = await import('./disciplineScoring.js');
    const db = await connectToDatabase();

    const entry = await db.collection('pnthr_journal').findOne({
      _id: new ObjectId(req.params.id),
      ownerId: req.user.userId,
    });
    if (!entry) return res.status(404).json({ error: 'Journal entry not found' });

    const { answers } = req.body;
    if (!answers || typeof answers !== 'object') return res.status(400).json({ error: 'answers required' });

    const updates = {
      userConfirmed: { ...(entry.userConfirmed || {}), confirmedAt: new Date() },
    };

    // Signal answer
    if (answers.signal) {
      const sigMap = {
        'BL+1': { signal: 'BL', signalAge: 1, entryContext: 'CONFIRMED_SIGNAL' },
        'BL+2': { signal: 'BL', signalAge: 2, entryContext: 'STALE_SIGNAL' },
        'BL+3': { signal: 'BL', signalAge: 3, entryContext: 'STALE_SIGNAL' },
        'SS+1': { signal: 'SS', signalAge: 1, entryContext: 'CONFIRMED_SIGNAL' },
        'SS+2': { signal: 'SS', signalAge: 2, entryContext: 'STALE_SIGNAL' },
        'SS+3': { signal: 'SS', signalAge: 3, entryContext: 'STALE_SIGNAL' },
        'DEVELOPING': { signal: null, signalAge: null, entryContext: 'DEVELOPING_SIGNAL' },
        'NONE': { signal: null, signalAge: null, entryContext: 'NO_SIGNAL' },
      };
      const sigData = sigMap[answers.signal] || {};
      Object.assign(updates, sigData);
      updates.userConfirmed.signal = answers.signal;
    }

    // Kill score answer
    if (answers.killScore) {
      const ks = answers.killScore;
      if (ks.inPipeline === 'Yes') {
        updates.killScoreAtEntry = {
          ...(entry.killScoreAtEntry || {}),
          totalScore: ks.killScore ? +ks.killScore : (entry.killScoreAtEntry?.totalScore || null),
          rank:       ks.killRank  ? +ks.killRank  : (entry.killScoreAtEntry?.rank       || null),
          tier:       (ks.killTier && ks.killTier !== "Don't remember") ? ks.killTier : (entry.killScoreAtEntry?.tier || null),
        };
      } else if (ks.inPipeline === 'No') {
        updates.killScoreAtEntry = null;
      }
      updates.userConfirmed.killScore = ks;
    }

    // Index trend answer
    if (answers.indexTrend) {
      updates.userConfirmed.indexTrend = answers.indexTrend;
      if (answers.indexTrend === 'WITH')    updates.userConfirmed.indexTrendAligned = true;
      if (answers.indexTrend === 'AGAINST') updates.userConfirmed.indexTrendAligned = false;
    }

    // Sector trend answer
    if (answers.sectorTrend) {
      updates.userConfirmed.sectorTrend = answers.sectorTrend;
      if (answers.sectorTrend === 'WITH')    updates.userConfirmed.sectorTrendAligned = true;
      if (answers.sectorTrend === 'AGAINST') updates.userConfirmed.sectorTrendAligned = false;
    }

    // Sizing answer
    if (answers.sizing) {
      updates.userConfirmed.sizing = answers.sizing;
      updates.userConfirmed.sizingCorrect = ['EXACT', 'WITHIN_10'].includes(answers.sizing);
    }

    // Save confirmations
    await db.collection('pnthr_journal').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { ...updates, updatedAt: new Date() } }
    );

    // Fetch updated entry and rescore
    const updatedEntry = await db.collection('pnthr_journal').findOne({ _id: new ObjectId(req.params.id) });
    const newScore = computeDisciplineScore(updatedEntry);
    await db.collection('pnthr_journal').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { discipline: newScore, updatedAt: new Date() } }
    );

    res.json({ success: true, newScore });
  } catch (e) {
    console.error('[journal/confirm-score]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/journal/:id — single entry
app.get('/api/journal/:id', authenticateJWT, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const { ObjectId } = await import('mongodb');
    const db = await connectToDatabase();
    const entry = await db.collection('pnthr_journal').findOne({
      _id: new ObjectId(req.params.id),
      ownerId: req.user.userId,
    });
    if (!entry) return res.status(404).json({ error: 'Not found' });
    res.json(entry);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/journal/:id/notes — add note
app.post('/api/journal/:id/notes', authenticateJWT, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const { ObjectId } = await import('mongodb');
    const db = await connectToDatabase();
    const { type = 'MID_TRADE', text } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });
    const note = {
      id: `N${Date.now().toString(36)}`,
      timestamp: new Date().toISOString(),
      type,
      text,
      marketSnapshot: {},
    };
    await db.collection('pnthr_journal').updateOne(
      { _id: new ObjectId(req.params.id), ownerId: req.user.userId },
      { $push: { notes: note }, $set: { updatedAt: new Date() } }
    );
    res.json(note);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/journal/:id/notes/:noteId
app.delete('/api/journal/:id/notes/:noteId', authenticateJWT, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const { ObjectId } = await import('mongodb');
    const db = await connectToDatabase();
    await db.collection('pnthr_journal').updateOne(
      { _id: new ObjectId(req.params.id), ownerId: req.user.userId },
      { $pull: { notes: { id: req.params.noteId } }, $set: { updatedAt: new Date() } }
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/journal/:id/tags
app.post('/api/journal/:id/tags', authenticateJWT, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const { ObjectId } = await import('mongodb');
    const db = await connectToDatabase();
    const { tag } = req.body;
    if (!tag) return res.status(400).json({ error: 'tag required' });
    await db.collection('pnthr_journal').updateOne(
      { _id: new ObjectId(req.params.id), ownerId: req.user.userId },
      { $addToSet: { tags: tag }, $set: { updatedAt: new Date() } }
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/journal/:id/tags/:tag
app.delete('/api/journal/:id/tags/:tag', authenticateJWT, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const { ObjectId } = await import('mongodb');
    const db = await connectToDatabase();
    await db.collection('pnthr_journal').updateOne(
      { _id: new ObjectId(req.params.id), ownerId: req.user.userId },
      { $pull: { tags: req.params.tag }, $set: { updatedAt: new Date() } }
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Newsletter (PNTHR's Perch) ────────────────────────────────────────────────
app.use('/api/newsletter', newsletterRouter);

// ── Admin: Cache Status ────────────────────────────────────────────────────────
// Shows whether in-memory caches are warm. Helps diagnose cold-start issues.
app.get('/api/cache-status', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const db = await connectToDatabase();

    // Apex cache — imported dynamically to avoid circular dep
    const { getCachedApexResults } = await import('./apexService.js');
    const apexResults = getCachedApexResults();
    const apexCount   = apexResults?.stocks?.length ?? 0;

    // ETF cache
    const etfResults = getCachedEtfResults();
    const etfCount   = Array.isArray(etfResults) ? etfResults.length
                       : etfResults?.stocks?.length ?? 0;

    // Candle cache (MongoDB)
    const candleCount = db
      ? await db.collection('pnthr_candle_cache').countDocuments()
      : null;

    // Regime (latest doc)
    const regimeDoc = db
      ? await db.collection('pnthr_kill_regime').findOne({}, { sort: { weekOf: -1 } })
      : null;

    // Signal cache (in-memory, from signalService)
    const { getCachedSignals } = await import('./signalService.js');
    const signalSnap  = getCachedSignals();
    const signalCount = signalSnap ? Object.keys(signalSnap).length : 0;

    res.json({
      apex: {
        warm:        apexCount > 0,
        count:       apexCount,
        status:      apexCount > 0 ? 'warm' : 'cold',
      },
      etf: {
        warm:        etfCount > 0,
        count:       etfCount,
        status:      etfCount > 0 ? 'warm' : 'cold',
      },
      signals: {
        warm:        signalCount > 0,
        count:       signalCount,
        status:      signalCount > 0 ? 'warm' : 'cold',
      },
      candle: {
        count:       candleCount,
        status:      (candleCount ?? 0) > 0 ? 'populated' : 'empty',
      },
      regime: {
        weekOf:      regimeDoc?.weekOf ?? null,
        updatedAt:   regimeDoc?.createdAt ?? null,
        status:      regimeDoc ? 'ok' : 'missing',
      },
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[cache-status]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: Pipeline Health ─────────────────────────────────────────────────────
// Verifies the Friday pipeline kept all collections in sync.
app.get('/api/pipeline-health', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });

    const [latestScores, latestRegime, latestHistory, latestSnapshot] = await Promise.all([
      db.collection('pnthr_kill_scores').findOne({}, { sort: { createdAt: -1 } }),
      db.collection('pnthr_kill_regime').findOne({}, { sort: { weekOf: -1 } }),
      db.collection('pnthr_kill_history').findOne({}, { sort: { createdAt: -1 } }),
      db.collection('pnthr_weekly_market_snapshot').findOne({}, { sort: { weekOf: -1 } }),
    ]);

    const scoreWeek   = latestScores?.weekOf   ?? null;
    const regimeWeek  = latestRegime?.weekOf    ?? null;
    const historyWeek = latestHistory?.weekOf   ?? null;
    const snapWeek    = latestSnapshot?.weekOf  ?? null;

    // All core collections should share the same weekOf
    const allSameWeek = !!(scoreWeek && regimeWeek && scoreWeek === regimeWeek);
    const scoreCount  = scoreWeek
      ? await db.collection('pnthr_kill_scores').countDocuments({ weekOf: scoreWeek })
      : 0;

    res.json({
      healthy:  allSameWeek && scoreCount > 0,
      weekOf:   scoreWeek,
      scores: {
        weekOf:    scoreWeek,
        count:     scoreCount,
        updatedAt: latestScores?.createdAt ?? null,
      },
      regime: {
        weekOf:    regimeWeek,
        updatedAt: latestRegime?.createdAt ?? null,
        inSync:    regimeWeek === scoreWeek,
      },
      history: {
        weekOf:    historyWeek,
        updatedAt: latestHistory?.createdAt ?? null,
      },
      snapshot: {
        weekOf:    snapWeek,
        updatedAt: latestSnapshot?.createdAt ?? null,
      },
      warning: allSameWeek ? null : `Collections out of sync — scores: ${scoreWeek}, regime: ${regimeWeek}. Possible partial pipeline failure.`,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[pipeline-health]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Cron: PNTHR Kill scoring pipeline every Friday at 4:15pm ET ─────────────
// Runs right after market close to pre-compute Kill scores and persist to MongoDB.
// The Command Center's /api/kill-pipeline reads from this data for instant response.
cron.schedule('15 16 * * 5', async () => {
  try {
    console.log('[Kill Pipeline] Starting Friday Kill pipeline...');
    await runFridayKillPipeline();
  } catch (err) {
    console.error('[Kill Pipeline] Failed:', err.message);
  }
}, { timezone: 'America/New_York' });

// ── Cron: Kill Test monthly portfolio snapshot — first Friday of month, 6 PM ET
// Generates equity curve snapshot + recomputes all analytics metrics
cron.schedule('0 18 1-7 * 5', async () => {
  try {
    console.log('[KillTest Monthly] Generating monthly snapshot...');
    const { connectToDatabase } = await import('./database.js');
    const db = await connectToDatabase();
    await generateMonthlySnapshots(db);
    console.log('[KillTest Monthly] Done.');
  } catch (err) {
    console.error('[KillTest Monthly] Failed:', err.message);
  }
}, { timezone: 'America/New_York' });

// ── Cron: Kill Test daily price tracking Mon–Fri at 4:30pm ET ───────────────
// Fetches OHLC for active appearances, processes lot fills, stop hits, P&L
cron.schedule('30 16 * * 1-5', async () => {
  try {
    console.log('[KillTest Daily] Starting daily price tracking...');
    await runKillTestDailyUpdate();
  } catch (err) {
    console.error('[KillTest Daily] Failed:', err.message);
  }
}, { timezone: 'America/New_York' });

// ── Cron: auto-generate newsletter every Friday at 5pm ET ───────────────────
cron.schedule('0 17 * * 5', async () => {
  try {
    const weekOf = getMostRecentFriday();
    console.log(`[Cron] Generating PNTHR's Perch for week of ${weekOf}...`);
    await generateIssue(weekOf);
    console.log(`[Cron] PNTHR's Perch generated successfully.`);
  } catch (err) {
    console.error('[Cron] Newsletter generation failed:', err.message);
  }
}, { timezone: 'America/New_York' });

// ── Cron: archive weekly signal snapshot every Friday at 8pm ET ─────────────
// Runs 3 hours after newsletter generation so signal cache is fully warm.
cron.schedule('0 20 * * 5', async () => {
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
}, { timezone: 'America/New_York' });

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

// ── Signal History Enhancement endpoints ──────────────────────────────────────

// GET /api/signal-history/market-snapshots?from=&to=
app.get('/api/signal-history/market-snapshots', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const db = await connectToDatabase();
    const query = {};
    if (req.query.from || req.query.to) {
      query.weekOf = {};
      if (req.query.from) query.weekOf.$gte = req.query.from;
      if (req.query.to)   query.weekOf.$lte = req.query.to;
    }
    const docs = await db.collection('pnthr_weekly_market_snapshot')
      .find(query)
      .sort({ weekOf: 1 })
      .toArray();
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/signal-history/enriched-signals?weekOf=
app.get('/api/signal-history/enriched-signals', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const db = await connectToDatabase();
    const weekOf = req.query.weekOf;
    const query = weekOf ? { weekOf } : {};
    if (!weekOf) {
      // Default: latest week
      const latest = await db.collection('pnthr_enriched_signals')
        .findOne({}, { sort: { weekOf: -1 } });
      if (latest) query.weekOf = latest.weekOf;
    }
    const docs = await db.collection('pnthr_enriched_signals')
      .find(query)
      .sort({ killRank: 1 })
      .toArray();
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/signal-history/enriched-signals/:ticker/trajectory?weeks=12
app.get('/api/signal-history/enriched-signals/:ticker/trajectory', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const db = await connectToDatabase();
    const weeks = parseInt(req.query.weeks) || 12;
    const docs = await db.collection('pnthr_enriched_signals')
      .find({ ticker: req.params.ticker.toUpperCase() })
      .sort({ weekOf: -1 })
      .limit(weeks)
      .toArray();
    res.json(docs.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/signal-history/closed-trades?tier=&direction=&sector=
app.get('/api/signal-history/closed-trades', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const db = await connectToDatabase();
    const query = {};
    if (req.query.tier)      query.entryTier  = req.query.tier;
    if (req.query.direction) query.direction  = req.query.direction;
    if (req.query.sector)    query.sector     = req.query.sector;
    const docs = await db.collection('pnthr_closed_trades')
      .find(query)
      .sort({ exitDate: -1 })
      .limit(500)
      .toArray();
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/signal-history/closed-trades/summary
app.get('/api/signal-history/closed-trades/summary', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const db = await connectToDatabase();
    const trades = await db.collection('pnthr_closed_trades').find({}).toArray();
    const total    = trades.length;
    const winners  = trades.filter(t => t.isWinner).length;
    const avgProfitPct = total > 0 ? trades.reduce((s, t) => s + (t.profitPct ?? 0), 0) / total : 0;
    const byTier   = {};
    for (const t of trades) {
      const k = t.entryTier || 'Unknown';
      if (!byTier[k]) byTier[k] = { total: 0, winners: 0 };
      byTier[k].total++;
      if (t.isWinner) byTier[k].winners++;
    }
    res.json({ total, winners, winRate: total > 0 ? winners / total : 0, avgProfitPct, byTier });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/signal-history/dimension-effectiveness?monthOf=
app.get('/api/signal-history/dimension-effectiveness', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const db = await connectToDatabase();
    const query = req.query.monthOf ? { monthOf: req.query.monthOf } : {};
    const docs = await db.collection('pnthr_dimension_effectiveness')
      .find(query)
      .sort({ monthOf: -1 })
      .limit(12)
      .toArray();
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/signal-history/changelog
app.get('/api/signal-history/changelog', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const db = await connectToDatabase();
    const docs = await db.collection('pnthr_system_changelog')
      .find({})
      .sort({ date: -1, createdAt: -1 })
      .limit(500)
      .toArray();
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/signal-history/changelog
app.post('/api/signal-history/changelog', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const db = await connectToDatabase();
    const { date, version, category, impact, description, details } = req.body;
    if (!date || !category || !description) {
      return res.status(400).json({ error: 'date, category, and description are required' });
    }
    const doc = {
      date,
      version:    version || null,
      category:   category || 'OTHER',
      impact:     impact || 'LOW',
      description,
      details:    details || '',
      changedBy:  req.user?.email || 'admin',
      createdAt:  new Date(),
    };
    const result = await db.collection('pnthr_system_changelog').insertOne(doc);
    res.json({ _id: result.insertedId, ...doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Pulse cache warmers — background, non-blocking ────────────────────────────
// Triggered by /api/pulse when caches are cold so the dashboard is self-sufficient.
// Uses a guard flag to prevent duplicate in-flight computations.

let _apexWarmInProgress = false;
async function warmApexCacheIfCold() {
  const { getCachedApexResults: _getApex } = await import('./apexService.js');
  if (_getApex() || _apexWarmInProgress) return;
  _apexWarmInProgress = true;
  console.log('[PULSE] Warming apex cache in background...');
  try {
    const [specLongs, specShorts] = await Promise.all([getSp400Longs(), getSp400Shorts()]);
    const stocks = await getJungleStocks(specLongs, specShorts);
    const tickers = stocks.map(s => s.ticker);
    const stockMeta = {};
    for (const s of stocks) {
      stockMeta[s.ticker] = {
        companyName: s.companyName, sector: s.sector, exchange: s.exchange,
        currentPrice: s.currentPrice, ytdReturn: s.ytdReturn,
        isSp500: s.isSp500, isDow30: s.isDow30, isNasdaq100: s.isNasdaq100,
        universe: s.universe, rankList: s.rankList ?? null,
        rank: null, rankChange: undefined,
      };
    }
    try {
      const latestRanking = await getMostRecentRanking();
      if (latestRanking) {
        for (const e of (latestRanking.rankings || [])) {
          if (stockMeta[e.ticker]) { stockMeta[e.ticker].rank = e.rank ?? null; stockMeta[e.ticker].rankChange = e.rankChange ?? undefined; stockMeta[e.ticker].rankList = 'LONG'; }
        }
        for (const e of (latestRanking.shortRankings || [])) {
          if (stockMeta[e.ticker]) { stockMeta[e.ticker].rank = e.rank ?? null; stockMeta[e.ticker].rankChange = e.rankChange ?? undefined; stockMeta[e.ticker].rankList = 'SHORT'; }
        }
      }
    } catch { /* rankings are enrichment only */ }
    const jungleSignals = await getSignals(tickers);
    let preyResults = null, huntTickers = new Set();
    try { preyResults = await getPreyResults(tickers, stockMeta, jungleSignals); } catch (e) { console.warn('[PULSE] prey failed:', e.message); }
    try { const h = await getEmaCrossoverStocks(); huntTickers = new Set((h?.stocks || []).map(s => s.ticker || s)); } catch {}
    const { getApexResults: _ga } = await import('./apexService.js');
    const _apexRes = await _ga(tickers, stockMeta, jungleSignals, preyResults, huntTickers);
    console.log('[PULSE] ✅ Apex cache warmed');
    // Persist SPY/QQQ EMA to regime doc so pulse works on next cold start
    try {
      const _iSPY = _apexRes?.indexData?.SPY;
      const _iQQQ = _apexRes?.indexData?.QQQ;
      if (_iSPY || _iQQQ) {
        const _db = await connectToDatabase();
        if (_db) {
          const _latest = await _db.collection('pnthr_kill_regime').findOne({}, { sort: { weekOf: -1 } });
          if (_latest?._id) {
            const _upd = {};
            if (_iSPY) _upd.spy = { close: _iSPY.price, ema21: _iSPY.ema21 };
            if (_iQQQ) _upd.qqq = { close: _iQQQ.price, ema21: _iQQQ.ema21 };
            await _db.collection('pnthr_kill_regime').updateOne({ _id: _latest._id }, { $set: _upd });
          }
        }
      }
    } catch { /* non-fatal */ }
  } catch (err) {
    console.error('[PULSE] Apex warm failed:', err.message);
  } finally {
    _apexWarmInProgress = false;
  }
}

let _etfWarmInProgress = false;
async function warmEtfCacheIfCold() {
  if (getCachedEtfResults() || _etfWarmInProgress) return;
  _etfWarmInProgress = true;
  console.log('[PULSE] Warming ETF cache in background...');
  try {
    await getEtfStocks();
    console.log('[PULSE] ✅ ETF cache warmed');
  } catch (err) {
    console.error('[PULSE] ETF warm failed:', err.message);
  } finally {
    _etfWarmInProgress = false;
  }
}

// ── PNTHR's Pulse — Mission Control Dashboard ─────────────────────────────────
app.get('/api/pulse', authenticateJWT, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const db = await connectToDatabase();
    const userId = req.user.userId;

    // Fire cache warming in background if caches are cold (non-blocking — pulse responds immediately)
    const { getCachedApexResults: _checkApex } = await import('./apexService.js');
    const apexCold = !_checkApex();
    const etfCold  = !getCachedEtfResults();
    if (apexCold) warmApexCacheIfCold().catch(() => {});
    if (etfCold)  warmEtfCacheIfCold().catch(() => {});
    const cacheWarming = apexCold || etfCold;

    // DB queries for regime prices, portfolio, and macro snapshot
    const [regimeDoc, positions, userProfile, marketSnapshot] = await Promise.all([
      db.collection('pnthr_kill_regime').findOne({}, { sort: { weekOf: -1 } }),
      db.collection('pnthr_portfolio').find({ ownerId: userId, status: { $ne: 'closed' } }).toArray(),
      db.collection('user_profiles').findOne({ userId }),
      db.collection('pnthr_weekly_market_snapshot').findOne({}, { sort: { weekOf: -1 } }),
    ]);

    // Live apex cache (populated when Kill page is visited this session).
    // Falls back to Friday pipeline DB data when cache is cold.
    const { getCachedApexResults } = await import('./apexService.js');
    const liveApex = getCachedApexResults();

    let killTop10, blCount, ssCount, sectorMap;
    if (liveApex) {
      killTop10 = liveApex.stocks
        .filter(s => s.isTop10)
        .map(s => ({
          killRank: s.killRank, ticker: s.ticker, signal: s.signal,
          totalScore: s.apexScore, tier: s.tier, sector: s.sector,
          currentPrice: s.currentPrice, rankChange: s.rankChange ?? null,
        }));
      blCount = liveApex.regime?.blCount || 0;
      ssCount = liveApex.regime?.ssCount || 0;
      sectorMap = {};
      for (const s of liveApex.stocks) {
        if (!s.signal || s.overextended) continue;
        const sector = s.sector || 'Unknown';
        if (!sectorMap[sector]) sectorMap[sector] = { bl: 0, ss: 0 };
        if (s.signal === 'BL') sectorMap[sector].bl++;
        else if (s.signal === 'SS') sectorMap[sector].ss++;
      }
    } else {
      // Cold server — fall back to Friday pipeline data.
      // pnthr_kill_scores has sector + signal for the full scored universe.
      const [top10Scores, allKillSignals] = await Promise.all([
        db.collection('pnthr_kill_scores').find({ killRank: { $lte: 10, $ne: null } }).sort({ killRank: 1 }).toArray(),
        db.collection('pnthr_kill_scores')
          .find({ signal: { $in: ['BL', 'SS'] } }, { projection: { ticker: 1, signal: 1, sector: 1, weekOf: 1 } })
          .sort({ weekOf: -1 }).limit(700).toArray(),
      ]);
      killTop10 = top10Scores.map(s => ({ ...s, totalScore: s.totalScore ?? s.apexScore ?? 0 }));
      blCount = 0; ssCount = 0; sectorMap = {};
      for (const s of allKillSignals) {
        const sector = s.sector || 'Unknown';
        if (!sectorMap[sector]) sectorMap[sector] = { bl: 0, ss: 0 };
        if (s.signal === 'BL') { sectorMap[sector].bl++; blCount++; }
        else if (s.signal === 'SS') { sectorMap[sector].ss++; ssCount++; }
      }
      // regimeDoc has authoritative counts from the signal state machine
      if (blCount === 0 && ssCount === 0) {
        blCount = regimeDoc?.blCount ?? 0;
        ssCount = regimeDoc?.ssCount ?? 0;
      }
    }

    // New signals this week (signalAge 0–1) — stocks from apex cache, ETFs from etf cache
    // ETFs are a separate scoring universe and never appear in the apex/kill results.
    function calcSignalAge(signalDate) {
      if (!signalDate) return 99;
      try {
        const sigMs  = new Date(signalDate + 'T12:00:00').getTime();
        // Current week Monday
        const now = new Date();
        const dow = now.getDay();
        const monday = new Date(now);
        monday.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
        monday.setHours(12, 0, 0, 0);
        return Math.max(0, Math.round((monday.getTime() - sigMs) / (7 * 24 * 60 * 60 * 1000)));
      } catch { return 99; }
    }
    function mapNewSig(s) {
      return { ticker: s.ticker, sector: s.sector, currentPrice: s.currentPrice,
        totalScore: s.apexScore ?? s.totalScore ?? 0, tier: s.tier, signal: s.signal,
        signalAge: s.signalAge, killRank: s.killRank ?? null };
    }
    const sortByScore = (a, b) => ((b.totalScore || 0) - (a.totalScore || 0));

    // ── Stocks: from apex cache (live) or Friday DB ──
    let newBLStocks = [], newSSStocks = [];
    if (liveApex) {
      const fresh = liveApex.stocks.filter(s => !s.overextended && (s.signalAge ?? 99) <= 1);
      newBLStocks = fresh.filter(s => s.signal === 'BL').map(mapNewSig).sort(sortByScore);
      newSSStocks = fresh.filter(s => s.signal === 'SS').map(mapNewSig).sort(sortByScore);
    } else {
      const dbFresh = await db.collection('pnthr_kill_scores')
        .find({ signal: { $in: ['BL', 'SS'] }, signalAge: { $lte: 1 } })
        .project({ ticker: 1, sector: 1, currentPrice: 1, totalScore: 1, apexScore: 1, tier: 1, signal: 1, signalAge: 1, killRank: 1 })
        .toArray();
      newBLStocks = dbFresh.filter(s => s.signal === 'BL')
        .map(s => ({ ...s, totalScore: s.totalScore ?? s.apexScore ?? 0 })).sort(sortByScore);
      newSSStocks = dbFresh.filter(s => s.signal === 'SS')
        .map(s => ({ ...s, totalScore: s.totalScore ?? s.apexScore ?? 0 })).sort(sortByScore);
    }

    // ── ETFs: from the ETF cache (populated when /api/etf-stocks is visited) ──
    let newBLEtfs = [], newSSEtfs = [];
    const cachedEtf = getCachedEtfResults();
    if (cachedEtf) {
      const { stocks: etfStocks, signals: etfSignals } = cachedEtf;
      const freshEtfs = etfStocks
        .map(s => {
          const sig = etfSignals?.[s.ticker];
          if (!sig?.signal || sig.signal === 'BE' || sig.signal === 'SE') return null;
          const signalAge = calcSignalAge(sig.signalDate);
          if (signalAge > 1) return null;
          return {
            ticker: s.ticker,
            sector: s.category || s.sector || 'ETF',
            currentPrice: s.currentPrice,
            totalScore: 0,   // ETFs not Kill-scored
            tier: null,
            signal: sig.signal === 'BUY' ? 'BL' : sig.signal === 'SELL' ? 'SS' : sig.signal,
            signalAge,
            killRank: null,
          };
        })
        .filter(Boolean);
      newBLEtfs = freshEtfs.filter(s => s.signal === 'BL');
      newSSEtfs = freshEtfs.filter(s => s.signal === 'SS');
    }

    // D1 multipliers — matches apexService calcD1() sign convention:
    //   bearish market → negative regimeScore → ssD1 > 1.0 (amplifies SS), blD1 < 1.0 (dampens BL)
    const apexRegime = liveApex?.regime || {};
    const spyAbove = apexRegime.spyAboveEma ?? regimeDoc?.spyAboveEma ?? null;
    const spyRising = apexRegime.spyEmaRising ?? (
      regimeDoc?.indexSlope === 'rising' ? true :
      regimeDoc?.indexSlope === 'falling' ? false : null
    );
    let indexScore = 0;
    if (spyAbove === false && spyRising === false) indexScore = -2;
    else if (spyAbove === false) indexScore = -1;
    else if (spyAbove === true && spyRising === true) indexScore = 2;
    else if (spyAbove === true) indexScore = 1;
    const openRatio = ssCount / Math.max(blCount, 1);
    let ratioScore = 0;
    if (blCount + ssCount > 0) {
      // High SS:BL ratio → bearish (negative); low ratio → bullish (positive)
      if (openRatio > 3) ratioScore = -2;
      else if (openRatio > 2) ratioScore = -1;
      else if (openRatio < 0.5) ratioScore = 2;
      else if (openRatio < 1) ratioScore = 1;
    }
    const regimeScore = indexScore + ratioScore;
    const ssD1 = Math.max(0.70, Math.min(1.30, Math.round((1.0 - regimeScore * 0.06) * 100) / 100));
    const blD1 = Math.max(0.70, Math.min(1.30, Math.round((1.0 + regimeScore * 0.06) * 100) / 100));

    const nav = userProfile?.accountSize || 100000;

    // fills can be an array (new lot system) OR an object keyed by lot number (old style)
    // commandCenter uses Object.values(fills) — match that pattern
    function getFillsArray(p) {
      if (Array.isArray(p.fills)) return p.fills;
      if (p.fills && typeof p.fills === 'object') return Object.values(p.fills);
      return [];
    }

    // Portfolio heat — all positions with any filled lot OR direct shares field
    const filledPos = positions.filter(p => {
      const fills = getFillsArray(p);
      return fills.some(f => f.filled) || (p.shares > 0);
    });
    let stockRisk = 0, etfRisk = 0;
    for (const p of filledPos) {
      const fills = getFillsArray(p);
      const filledShares = fills.filter(f => f.filled).reduce((s, f) => s + (+f.shares || 0), 0);
      const totalShares = filledShares || (p.shares || 0);
      const stop = p.stopPrice || 0;
      const avg = p.avgCost || p.entryPrice || 0;
      const risk = totalShares * Math.abs(avg - stop);
      const isShort = p.direction === 'SHORT';
      const isRecycled = isShort ? stop <= avg : stop >= avg;
      if (!isRecycled) {
        if (p.isETF) etfRisk += risk;
        else stockRisk += risk;
      }
    }
    const totalRisk = stockRisk + etfRisk;
    const stockRiskPct = +((stockRisk / nav) * 100).toFixed(2);
    const etfRiskPct = +((etfRisk / nav) * 100).toFixed(2);
    const totalRiskPct = +((totalRisk / nav) * 100).toFixed(2);

    // Lots ready
    const lotsReady = [];
    for (const p of filledPos) {
      const fills = getFillsArray(p);
      for (const f of fills) {
        if (f.filled) continue;
        const priorFilled = f.lot === 1 || fills.find(x => x.lot === f.lot - 1)?.filled;
        if (priorFilled && f.triggerPrice) {
          lotsReady.push({ ticker: p.ticker, lot: f.lot, triggerPrice: f.triggerPrice });
        }
      }
    }

    const shortCount = positions.filter(p => p.direction === 'SHORT').length;
    const longCount = positions.filter(p => p.direction === 'LONG').length;
    const recycledCount = filledPos.filter(p => {
      const fills = getFillsArray(p);
      const filledShares = fills.filter(f => f.filled).reduce((s, f) => s + (+f.shares || 0), 0);
      const totalShares = filledShares || (p.shares || 0);
      const stop = p.stopPrice || 0;
      const avg = p.avgCost || p.entryPrice || 0;
      const isShort = p.direction === 'SHORT';
      return totalShares > 0 && (isShort ? stop <= avg : stop >= avg);
    }).length;

    // SPY/QQQ index data from apex cache
    const apexIndexData = liveApex?.indexData || {};

    // Live macro data from FMP — 10Y, DXY, and SPY/QQQ prices when apex cache is cold
    const FMP_KEY = process.env.FMP_API_KEY;
    let treasury10y = marketSnapshot?.treasury10y ?? null;
    let dxy = marketSnapshot?.dxy ?? null;
    const needSpyQqq = !apexIndexData.SPY && !regimeDoc?.spy;
    let spyLivePrice = null, qqqLivePrice = null;
    const fmpFetches = [];
    if (treasury10y == null) fmpFetches.push(['t10', `https://financialmodelingprep.com/api/v3/quote/%5ETNX?apikey=${FMP_KEY}`]);
    if (dxy == null) fmpFetches.push(['dxy', `https://financialmodelingprep.com/api/v3/quote/DX-Y.NYB?apikey=${FMP_KEY}`]);
    if (needSpyQqq) {
      fmpFetches.push(['spy', `https://financialmodelingprep.com/api/v3/quote/SPY?apikey=${FMP_KEY}`]);
      fmpFetches.push(['qqq', `https://financialmodelingprep.com/api/v3/quote/QQQ?apikey=${FMP_KEY}`]);
    }
    if (fmpFetches.length > 0) {
      try {
        const results = await Promise.all(fmpFetches.map(([, url]) => fetch(url)));
        for (let i = 0; i < fmpFetches.length; i++) {
          if (!results[i].ok) continue;
          const data = await results[i].json();
          const price = data[0]?.price ?? null;
          const [key] = fmpFetches[i];
          if (key === 't10') treasury10y = price;
          else if (key === 'dxy') dxy = price;
          else if (key === 'spy') spyLivePrice = price;
          else if (key === 'qqq') qqqLivePrice = price;
        }
      } catch { /* best-effort */ }
    }

    // Always-fetch market gauge data: NYSE, NASDAQ, IWM, GLD, DJI, WTI Crude, USD, BTC
    let marketGauges = { nyse: null, nasdaq: null, iwm: null, gld: null, dji: null, crude: null, usd: null, btc: null };
    try {
      const mgRes = await fetch(
        `https://financialmodelingprep.com/api/v3/quote/%5ENYA,%5EIXIC,IWM,GLD,%5EDJI,USOIL,DX-Y.NYB,BTCUSD?apikey=${FMP_KEY}`
      );
      if (mgRes.ok) {
        const mgData = await mgRes.json();
        function extractMg(symbol) {
          const q = mgData.find(x => x.symbol === symbol || x.symbol === symbol.replace('%5E', '^'));
          if (!q) return null;
          return {
            price: q.price ?? null,
            change: q.change ?? null,
            changePct: q.changesPercentage ?? null,
            name: q.name ?? symbol,
          };
        }
        marketGauges = {
          nyse:   extractMg('%5ENYA')  || extractMg('^NYA'),
          nasdaq: extractMg('%5EIXIC') || extractMg('^IXIC'),
          iwm:    extractMg('IWM'),
          gld:    extractMg('GLD'),
          dji:    extractMg('%5EDJI')  || extractMg('^DJI'),
          crude:  extractMg('USOIL'),
          usd:    extractMg('DX-Y.NYB'),
          btc:    extractMg('BTCUSD'),
        };
        // Try alternate symbol names if not found
        if (!marketGauges.nyse)   marketGauges.nyse   = mgData.find(q => q.symbol === '^NYA')  ? { price: mgData.find(q=>q.symbol==='^NYA').price,   changePct: mgData.find(q=>q.symbol==='^NYA').changesPercentage   } : null;
        if (!marketGauges.nasdaq) marketGauges.nasdaq = mgData.find(q => q.symbol === '^IXIC') ? { price: mgData.find(q=>q.symbol==='^IXIC').price, changePct: mgData.find(q=>q.symbol==='^IXIC').changesPercentage } : null;
        console.log('[PULSE] marketGauges fetched:', Object.entries(marketGauges).map(([k,v]) => `${k}:${v?.price ?? 'null'}`).join(' '));
      }
    } catch (e) {
      console.warn('[PULSE] marketGauges fetch failed:', e.message);
    }

    // WTI crude fallback — USOIL may not return in batch; try USOIL then USO ETF as proxy
    if (!marketGauges.crude) {
      try {
        const wtiRes = await fetch(`https://financialmodelingprep.com/api/v3/quote/USOIL,USO?apikey=${FMP_KEY}`);
        if (wtiRes.ok) {
          const wtiData = await wtiRes.json();
          if (Array.isArray(wtiData)) {
            const q = wtiData.find(x => x.symbol === 'USOIL') || wtiData.find(x => x.symbol === 'USO');
            if (q?.price) {
              marketGauges.crude = { price: q.price, change: q.change ?? null, changePct: q.changesPercentage ?? null, symbol: q.symbol };
              console.log('[PULSE] WTI crude fallback via', q.symbol, ':', q.price);
            }
          }
        }
      } catch (e) { console.warn('[PULSE] WTI fallback failed:', e.message); }
    }

    // Treasury yields: Fed (1mo proxy), 2Y, 10Y, 30Y
    let treasuryYields = { fed: null, y2: null, y10: null, y30: null };
    try {
      const toDate  = new Date().toISOString().slice(0, 10);
      const fromDate = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
      const tRes = await fetch(
        `https://financialmodelingprep.com/api/v4/treasury?from=${fromDate}&to=${toDate}&apikey=${FMP_KEY}`
      );
      if (tRes.ok) {
        const tData = await tRes.json();
        if (Array.isArray(tData) && tData.length >= 1) {
          const latest = tData[0];
          const prev   = tData[1] || null;
          const bps = (val, prevVal) =>
            val != null && prevVal != null ? +((val - prevVal) * 100).toFixed(1) : null;
          treasuryYields = {
            fed: latest.month1 != null ? { rate: latest.month1, changeBps: bps(latest.month1, prev?.month1) } : null,
            y2:  latest.year2  != null ? { rate: latest.year2,  changeBps: bps(latest.year2,  prev?.year2)  } : null,
            y10: latest.year10 != null ? { rate: latest.year10, changeBps: bps(latest.year10, prev?.year10) } : null,
            y30: latest.year30 != null ? { rate: latest.year30, changeBps: bps(latest.year30, prev?.year30) } : null,
          };
          console.log('[PULSE] treasury yields:', JSON.stringify(treasuryYields));
        }
      }
    } catch (e) {
      console.warn('[PULSE] treasury yields fetch failed:', e.message);
    }

    // Data freshness metadata — client shows "Scores: Fri Mar 20" vs "Scores: Live"
    const dataSource = liveApex ? 'live_apex' : 'friday_pipeline';
    const scoresAsOf = liveApex
      ? new Date().toISOString()
      : (regimeDoc?.weekOf ? `${regimeDoc.weekOf}T16:15:00` : null);
    const weekOf = liveApex
      ? new Date().toISOString().split('T')[0]
      : (regimeDoc?.weekOf ?? null);

    res.json({
      statusLight: cacheWarming ? 'YELLOW' : 'GREEN',
      statusMessage: cacheWarming ? 'SCORING ENGINE WARMING UP' : 'ALL SYSTEMS OPERATIONAL',
      killDataLive: !!liveApex,
      cacheWarming,
      apexWarmInProgress: _apexWarmInProgress,
      etfWarmInProgress: _etfWarmInProgress,
      dataSource,
      scoresAsOf,
      weekOf,
      regime: {
        ...(regimeDoc || {}),
        indexPosition: spyAbove ? 'above' : spyAbove === false ? 'below' : 'unknown',
        spyAboveEma: apexRegime.spyAboveEma ?? regimeDoc?.spyAboveEma,
        spyEmaRising: apexRegime.spyEmaRising ?? regimeDoc?.spyEmaRising,
        qqqAboveEma: apexRegime.qqqAboveEma ?? regimeDoc?.qqqAboveEma,
        qqqEmaRising: apexRegime.qqqEmaRising ?? regimeDoc?.qqqEmaRising,
        blCount, ssCount, ssD1, blD1, regimeScore,
        spy: apexIndexData.SPY
          ? { close: apexIndexData.SPY.price, ema21: apexIndexData.SPY.ema21 }
          : (regimeDoc?.spy ?? (spyLivePrice != null ? { close: spyLivePrice, ema21: null } : null)),
        qqq: apexIndexData.QQQ
          ? { close: apexIndexData.QQQ.price, ema21: apexIndexData.QQQ.ema21 }
          : (regimeDoc?.qqq ?? (qqqLivePrice != null ? { close: qqqLivePrice, ema21: null } : null)),
      },
      killTop10,
      newSignals: {
        blStocks: newBLStocks,
        blEtfs:   newBLEtfs,
        ssStocks: newSSStocks,
        ssEtfs:   newSSEtfs,
      },
      signals: {
        blCount, ssCount,
        ratio: ssCount / Math.max(blCount, 1),
        bySector: sectorMap,
      },
      positions: {
        total: positions.length,
        short: shortCount,
        long: longCount,
        recycled: recycledCount,
        heat: { stockRisk, etfRisk, totalRisk, stockRiskPct, etfRiskPct, totalRiskPct },
        nav,
      },
      lotsReady: lotsReady.slice(0, 5),
      marketSnapshot: { ...(marketSnapshot || {}), treasury10y, dxy },
      marketGauges,
      treasuryYields,
    });
  } catch (err) {
    console.error('[/api/pulse]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Pulse signal drill-down — all BL or SS stocks ─────────────────────────────
app.get('/api/pulse/signal-stocks', authenticateJWT, async (req, res) => {
  try {
    const { signal } = req.query;
    if (!['BL', 'SS'].includes(signal)) return res.status(400).json({ error: 'signal must be BL or SS' });

    const { getCachedApexResults } = await import('./apexService.js');
    const liveApex = getCachedApexResults();

    let stocks;
    if (liveApex) {
      stocks = liveApex.stocks
        .filter(s => s.signal === signal && !s.overextended)
        .map(s => ({
          ticker: s.ticker,
          sector: s.sector,
          currentPrice: s.currentPrice,
          totalScore: +(s.apexScore || 0).toFixed(1),
          tier: s.tier,
          signalAge: s.signalAge ?? null,
          killRank: s.killRank ?? null,
        }))
        .sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));
    } else {
      const { connectToDatabase } = await import('./database.js');
      const db = await connectToDatabase();
      const rows = await db.collection('pnthr_kill_scores')
        .find({ signal }, { projection: { ticker: 1, sector: 1, currentPrice: 1, totalScore: 1, tier: 1, signalAge: 1, killRank: 1 } })
        .sort({ killRank: 1 })
        .toArray();
      stocks = rows.map(s => ({ ...s, totalScore: +(s.totalScore ?? 0).toFixed(1) }));
    }

    res.json({ signal, stocks, count: stocks.length });
  } catch (err) {
    console.error('[/api/pulse/signal-stocks]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Developing Signals — intra-week 3/4 condition detection ───────────────────
// Mon–Thu: stocks where 3 of 4 BL (or SS) conditions are confirmed intra-week.
// The 4th condition (weekly close) is still pending (resolves Friday close).
// Returns { status: 'OK'|'COLD', bl: [...], ss: [...] }
app.get('/api/pulse/developing-signals', authenticateJWT, async (req, res) => {
  try {
    const FMP_API_KEY = process.env.FMP_API_KEY;
    const { getCachedSignals } = await import('./signalService.js');
    const signalMap = getCachedSignals();

    if (!signalMap || Object.keys(signalMap).length === 0) {
      return res.json({ status: 'COLD', bl: [], ss: [], message: 'Signal cache warming — check back in ~2 min' });
    }

    // ── Check if cache has new fields (lastWeekHigh added with tighter detection) ─
    // Old cache entries won't have lastWeekHigh; force recompute if missing.
    const entries = Object.values(signalMap);
    const hasFreshFields = entries.some(s => s.lastWeekHigh != null);
    if (!hasFreshFields) {
      const { clearSignalCache } = await import('./signalService.js').catch(() => ({}));
      if (typeof clearSignalCache === 'function') clearSignalCache();
      return res.json({ status: 'STALE', bl: [], ss: [], message: 'Signal cache refreshing — hit REFRESH in ~90s' });
    }

    // ── Build candidate lists ─────────────────────────────────────────────────
    // BL candidates: NOT already BL + EMA rising + has last-week candle data
    // SS candidates: NOT already SS + EMA falling + has last-week candle data
    const blCandidates = [];
    const ssCandidates = [];
    for (const [ticker, s] of Object.entries(signalMap)) {
      if (!s.ema21 || !s.lastWeekHigh || !s.lastWeekLow || !s.lastWeekClose) continue;
      if (s.signal !== 'BL' && s.emaRising === true) {
        blCandidates.push({ ticker, ema21: s.ema21,
          lastWeekHigh: s.lastWeekHigh, lastWeekLow: s.lastWeekLow, lastWeekClose: s.lastWeekClose });
      }
      if (s.signal !== 'SS' && s.emaRising === false) {
        ssCandidates.push({ ticker, ema21: s.ema21,
          lastWeekHigh: s.lastWeekHigh, lastWeekLow: s.lastWeekLow, lastWeekClose: s.lastWeekClose });
      }
    }

    // ── Sector lookup — two-pass for full coverage ────────────────────────────
    // Developing signal stocks have no CURRENT signal so won't be in this week's
    // kill_scores. Use:
    //   1. All historical kill_scores entries (any week a stock ever had a signal)
    //   2. Live apex cache (currently signaled stocks — confirms current sectors)
    // This covers virtually every stock in the 679 universe.
    const allCandidateTickers = [...new Set([
      ...blCandidates.map(c => c.ticker),
      ...ssCandidates.map(c => c.ticker),
    ])];
    const sectorMap = {};
    try {
      const { connectToDatabase } = await import('./database.js');
      const db = await connectToDatabase();
      // Pass 1: historical kill_scores — group by ticker, grab most-recent sector
      // No ticker filter — we want all 679 stocks' historical sector data in one shot
      const sectorDocs = await db.collection('pnthr_kill_scores')
        .aggregate([
          { $sort: { createdAt: -1 } },
          { $group: { _id: '$ticker', sector: { $first: '$sector' } } },
        ])
        .toArray();
      for (const d of sectorDocs) if (d.sector) sectorMap[d._id] = d.sector;
      // Pass 2: live apex cache — catches any sector that changed since last pipeline
      const { getCachedApexResults } = await import('./apexService.js');
      const liveApex = getCachedApexResults();
      if (liveApex?.stocks) {
        for (const s of liveApex.stocks) {
          if (s.sector) sectorMap[s.ticker] = s.sector; // apex overrides historical
        }
      }
    } catch (e) { console.warn('[developing-signals] sector lookup failed:', e.message); }

    // ── Fetch today's quotes in chunks of 100 ────────────────────────────────
    const CHUNK_SIZE = 100;
    const quoteMap = {};
    const tickersToQuote = allCandidateTickers.slice(0, 500); // safety cap
    for (let i = 0; i < tickersToQuote.length; i += CHUNK_SIZE) {
      const chunk = tickersToQuote.slice(i, i + CHUNK_SIZE);
      try {
        const r = await fetch(`https://financialmodelingprep.com/api/v3/quote/${chunk.join(',')}?apikey=${FMP_API_KEY}`);
        if (r.ok) {
          const data = await r.json();
          if (Array.isArray(data)) {
            for (const q of data) quoteMap[q.symbol] = q;
          }
        }
      } catch (e) { console.warn('[developing-signals] quote chunk failed:', e.message); }
    }

    // ── Apply tighter developing BL check ────────────────────────────────────
    // All conditions must be true:
    //   A. EMA slope rising (already filtered in candidates)
    //   B. Within 2% of last week's high (approaching or past breakout)
    //   C. Price > last Friday's close (week trending up)
    //   D. Price within 2% below EMA (not too far to trigger)
    //   E. Not overextended (|priceVsEma| ≤ 20%)
    // Sort: closest to (or past) last week's high first
    const devBL = [];
    for (const c of blCandidates) {
      const q = quoteMap[c.ticker];
      if (!q?.price) continue;
      const price     = q.price;
      const weekOpen  = c.lastWeekClose; // last Friday's close as week-open proxy
      // B: within 2% below last week's high (negative = already past it — highest priority)
      const pctFromHigh = +((c.lastWeekHigh - price) / c.lastWeekHigh * 100).toFixed(2);
      if (pctFromHigh > 2) continue;
      // C: week trending up
      if (price <= weekOpen) continue;
      // D+E: price within [-2%, +20%] of EMA
      const priceVsEma = +((price - c.ema21) / c.ema21 * 100).toFixed(2);
      if (priceVsEma < -2 || priceVsEma > 20) continue;
      devBL.push({
        ticker:       c.ticker,
        companyName:  q.name || '',
        exchange:     q.exchange || '',
        sector:       sectorMap[c.ticker] || '—',
        price,
        ema21:        c.ema21,
        lastWeekHigh: c.lastWeekHigh,
        pctFromHigh,               // <0 = already past last week's high
        priceVsEma,
        weekTrending: true,
      });
    }
    devBL.sort((a, b) => a.pctFromHigh - b.pctFromHigh); // past high first, then closest

    // ── Apply tighter developing SS check ────────────────────────────────────
    // All conditions must be true:
    //   A. EMA slope falling (already filtered in candidates)
    //   B. Within 2% of last week's low (approaching or past breakdown)
    //   C. Price < last Friday's close (week trending down)
    //   D. Price within 2% above EMA (not too far to trigger)
    //   E. Not overextended (|priceVsEma| ≤ 20%)
    // Sort: closest to (or past) last week's low first
    const devSS = [];
    for (const c of ssCandidates) {
      const q = quoteMap[c.ticker];
      if (!q?.price) continue;
      const price    = q.price;
      const weekOpen = c.lastWeekClose;
      // B: within 2% above last week's low (negative = already below it)
      const pctFromLow = +((price - c.lastWeekLow) / c.lastWeekLow * 100).toFixed(2);
      if (pctFromLow > 2) continue;
      // C: week trending down
      if (price >= weekOpen) continue;
      // D+E: price within [-20%, +2%] of EMA
      const priceVsEma = +((price - c.ema21) / c.ema21 * 100).toFixed(2);
      if (priceVsEma > 2 || priceVsEma < -20) continue;
      devSS.push({
        ticker:      c.ticker,
        companyName: q.name || '',
        exchange:    q.exchange || '',
        sector:      sectorMap[c.ticker] || '—',
        price,
        ema21:       c.ema21,
        lastWeekLow: c.lastWeekLow,
        pctFromLow,                // <0 = already past last week's low
        priceVsEma,
        weekTrending: true,
      });
    }
    devSS.sort((a, b) => a.pctFromLow - b.pctFromLow); // past low first, then closest

    console.log(`[developing-signals] BL candidates: ${blCandidates.length} → ${devBL.length} developing | SS candidates: ${ssCandidates.length} → ${devSS.length} developing`);
    res.json({ status: 'OK', bl: devBL, ss: devSS });
  } catch (err) {
    console.error('[/api/pulse/developing-signals]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Live VIX quote ─────────────────────────────────────────────────────────────
app.get('/api/market-data/vix', authenticateJWT, async (req, res) => {
  try {
    const FMP_API_KEY = process.env.FMP_API_KEY;
    const url = `https://financialmodelingprep.com/api/v3/quote/%5EVIX?apikey=${FMP_API_KEY}`;
    const fmpRes = await fetch(url);
    if (!fmpRes.ok) throw new Error(`FMP error ${fmpRes.status}`);
    const data = await fmpRes.json();
    res.json({ close: data[0]?.price || null, change: data[0]?.change || null });
  } catch (e) {
    res.json({ close: null, change: null });
  }
});

// ── PNTHR Assistant API ───────────────────────────────────────────────────────
// All endpoints available to ALL authenticated users (admin + member).

// GET /api/assistant/tasks — generate prioritized task list for current user
app.get('/api/assistant/tasks', async (req, res) => {
  try {
    if (!req.user?.userId) return res.status(401).json({ error: 'Authentication required' });

    // Fetch active positions (same enrichment as positionsGetAll)
    const { connectToDatabase: _getDb } = await import('./database.js');
    const db = await _getDb();
    if (!db) return res.status(503).json({ tasks: [], error: 'DB unavailable' });

    const positionsRaw = await db.collection('pnthr_portfolio')
      .find({ status: { $nin: ['CLOSED'] }, ownerId: req.user.userId })
      .sort({ createdAt: -1 })
      .toArray();

    // Fetch live prices for current price comparisons
    const tickers = [...new Set(positionsRaw.map(p => p.ticker))];
    let live = {};
    if (tickers.length) {
      try {
        const FMP_KEY = process.env.FMP_API_KEY;
        const qUrl = `https://financialmodelingprep.com/stable/quote?symbol=${tickers.join(',')}&apikey=${FMP_KEY}`;
        const qRes = await fetch(qUrl, { signal: AbortSignal.timeout(8000) });
        if (qRes.ok) {
          const qData = await qRes.json();
          if (Array.isArray(qData)) {
            for (const q of qData) live[q.symbol] = q.price;
          }
        }
      } catch { /* non-fatal */ }
    }

    // Fetch RSI for feast detection
    const rsiMap = {};
    if (tickers.length) {
      const FMP_KEY = process.env.FMP_API_KEY;
      await Promise.allSettled(tickers.map(async t => {
        try {
          const url = `https://financialmodelingprep.com/stable/technical-indicators/rsi?symbol=${t}&periodLength=14&timeframe=1week&apikey=${FMP_KEY}`;
          const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
          if (r.ok) {
            const d = await r.json();
            if (Array.isArray(d) && d[0]) rsiMap[t] = d[0].rsi ?? null;
          }
        } catch { /* ignore */ }
      }));
    }

    // Enrich positions with live data
    const positions = positionsRaw.map(p => ({
      ...p,
      currentPrice: live[p.ticker] ?? p.currentPrice,
      feastAlert:   rsiMap[p.ticker] != null && rsiMap[p.ticker] > 85,
      feastRSI:     rsiMap[p.ticker] ?? null,
    }));

    // Fetch NAV from user profile
    const profileDoc = await db.collection('user_profiles').findOne({ userId: req.user.userId });
    const nav = profileDoc?.accountSize ?? 100000;

    const tasks = await generateAssistantTasks(req.user.userId, positions, nav);
    res.json({ tasks, count: tasks.length, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[assistant/tasks]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/assistant/stop-sync — compare PNTHR stop vs position.stopPrice
app.get('/api/assistant/stop-sync', async (req, res) => {
  try {
    if (!req.user?.userId) return res.status(401).json({ error: 'Authentication required' });

    const { connectToDatabase: _getDb2 } = await import('./database.js');
    const db = await _getDb2();
    if (!db) return res.status(503).json({ rows: [], error: 'DB unavailable' });

    const positions = await db.collection('pnthr_portfolio')
      .find({ status: { $nin: ['CLOSED'] }, ownerId: req.user.userId })
      .toArray();

    const rows = await getStopSyncRows(positions, req.user.userId);

    // Day-of-week label
    const dow = new Date().getDay(); // 0=Sun, 1=Mon...
    const label = dow === 1 ? 'MONDAY STOP SYNC' : 'STOP CHECK';

    res.json({ rows, label, dayOfWeek: dow });
  } catch (err) {
    console.error('[assistant/stop-sync]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/assistant/routines — day-of-week routine checklist (smart on Mondays)
app.get('/api/assistant/routines', async (req, res) => {
  try {
    if (!req.user?.userId) return res.status(401).json({ error: 'Authentication required' });
    // Use Eastern Time — prevents UTC rollover showing tomorrow's routine after 8 PM ET
    const etDayName = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long' });
    const dow = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].indexOf(etDayName);

    let context = {};
    // On Mondays (and any day), build smart context so the 3 key routines show specific data
    try {
      const { connectToDatabase: _rdb } = await import('./database.js');
      const rdb = await _rdb();
      if (rdb) {
        const activePosns = await rdb.collection('pnthr_portfolio')
          .find({ status: { $nin: ['CLOSED'] }, ownerId: req.user.userId })
          .toArray();
        const killSignals = getCachedSignalStocks();
        // Auto-warm Kill cache if cold — fires in background, doesn't block response
        if (!killSignals.length) {
          console.log('[routines] Kill cache cold — triggering background warm-up');
          triggerApexWarmup(); // intentionally not awaited
        }
        context = await buildRoutineContext(activePosns, killSignals);
      }
    } catch (ctxErr) {
      console.warn('[assistant/routines] context build failed:', ctxErr.message);
    }

    const routines = getRoutineTasks(dow, context);
    res.json({ routines, dayOfWeek: dow });
  } catch (err) {
    console.error('[assistant/routines]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/assistant/position-health — daily RSI alerts for Command positions
// BL positions: alert if daily RSI-14 > 75 (overbought)
// SS positions: alert if daily RSI-14 < 25 (oversold / short squeeze risk)
app.get('/api/assistant/position-health', async (req, res) => {
  try {
    if (!req.user?.userId) return res.status(401).json({ error: 'Authentication required' });
    const positions = await getPositionHealthAlerts(req.user.userId);
    res.json({ positions, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[assistant/position-health]', err.message);
    res.status(500).json({ positions: [], error: err.message });
  }
});

// GET /api/assistant/overnight-fills — positions auto-closed by IBKR in last 48h (undismissed)
app.get('/api/assistant/overnight-fills', authenticateJWT, async (req, res) => {
  try {
    if (!req.user?.userId) return res.status(401).json({ error: 'Authentication required' });
    const fills = await getOvernightFills(req.user.userId);
    res.json({ fills });
  } catch (err) {
    console.error('[assistant/overnight-fills]', err.message);
    res.status(500).json({ fills: [], error: err.message });
  }
});

// POST /api/assistant/dismiss-fill — user has reviewed a fill; hide it from the list
// Sets ibkrFillDismissedAt so getOvernightFills filters it out on next fetch.
app.post('/api/assistant/dismiss-fill', authenticateJWT, async (req, res) => {
  try {
    const { connectToDatabase } = await import('./database.js');
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });
    const { positionId } = req.body;
    if (!positionId) return res.status(400).json({ error: 'positionId required' });
    await db.collection('pnthr_portfolio').updateOne(
      { id: positionId, ownerId: req.user.userId },
      { $set: { ibkrFillDismissedAt: new Date() } }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[assistant/dismiss-fill]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/assistant/complete — mark a task done
app.post('/api/assistant/complete', async (req, res) => {
  try {
    if (!req.user?.userId) return res.status(401).json({ error: 'Authentication required' });
    const { taskId, taskType, ticker } = req.body;
    if (!taskId) return res.status(400).json({ error: 'taskId required' });
    const dow = new Date().getDay();
    await markTaskComplete(req.user.userId, taskId, taskType, ticker, dow);
    res.json({ ok: true });
  } catch (err) {
    // Duplicate key = already completed today — treat as success
    if (err.code === 11000) return res.json({ ok: true, alreadyDone: true });
    console.error('[assistant/complete]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/assistant/completed — today's completed tasks
app.get('/api/assistant/completed', async (req, res) => {
  try {
    if (!req.user?.userId) return res.status(401).json({ error: 'Authentication required' });
    const completed = await getTodayCompleted(req.user.userId);
    res.json({ completed });
  } catch (err) {
    console.error('[assistant/completed]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📊 API available at http://localhost:${PORT}/api/stocks`);
  // Pre-compute signal counts in background (takes ~2 min each)
  computeSectorSignalCounts();
  computeSpeculativeSignalCounts();
  // Bootstrap MongoDB indexes (non-blocking)
  ensureCommandCenterIndexes().catch(() => {});
  createPendingEntriesIndexes().catch(() => {});
  createKillHistoryIndexes().catch(() => {});
  ensureAssistantIndexes().catch(() => {});
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
