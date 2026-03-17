// server/commandCenter.js
// ── PNTHR Command Center — API Route Handlers ─────────────────────────────────
//
// Provides backend for the PNTHR Command Center portfolio dashboard.
//
// Routes (mounted in index.js):
//   GET  /api/kill-pipeline          — Latest Kill scores from MongoDB
//   GET  /api/positions              — All active positions with live prices
//   POST /api/positions              — Create or update a position
//   POST /api/positions/close        — Close a position with outcome
//   GET  /api/ticker/:symbol         — Auto-populate ticker data from FMP
//   GET  /api/regime                 — Current market regime
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config();

import { connectToDatabase } from './database.js';

const FMP_API_KEY  = process.env.FMP_API_KEY;
const FMP_BASE     = 'https://financialmodelingprep.com';

// ── FMP Helpers ───────────────────────────────────────────────────────────────

function fmpUrl(path, params = {}) {
  const url = new URL(path, FMP_BASE);
  url.searchParams.set('apikey', FMP_API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

async function fmpGet(path, params = {}) {
  const res = await fetch(fmpUrl(path, params));
  if (!res.ok) throw new Error(`FMP ${res.status}: ${path}`);
  return res.json();
}

// Batch quotes for up to 500 tickers per call
async function fetchQuotes(tickers) {
  const results = {};
  for (let i = 0; i < tickers.length; i += 500) {
    const batch = tickers.slice(i, i + 500);
    try {
      const data = await fmpGet('/stable/quote', { symbol: batch.join(',') });
      if (Array.isArray(data)) {
        for (const q of data) {
          results[q.symbol] = {
            price:         q.price,
            changePct:     q.changesPercentage,
            dayHigh:       q.dayHigh,
            dayLow:        q.dayLow,
            volume:        q.volume,
            avgVolume:     q.avgVolume,
            previousClose: q.previousClose,
          };
        }
      }
    } catch (e) { console.warn('[CC] Quote batch failed:', e.message); }
  }
  return results;
}

// Company profile: sector, exchange, name, marketCap
async function fetchProfile(ticker) {
  try {
    const data = await fmpGet('/stable/profile', { symbol: ticker });
    if (!Array.isArray(data) || !data[0]) return null;
    const p = data[0];
    return { sector: p.sector, exchange: p.exchangeShortName, companyName: p.companyName, marketCap: p.mktCap };
  } catch { return null; }
}

// 21-week EMA (current + previous for slope)
async function fetchEMA21(ticker) {
  try {
    const data = await fmpGet('/stable/technical-indicators/ema', { symbol: ticker, periodLength: 21, timeframe: '1week' });
    if (!Array.isArray(data) || data.length < 2) return null;
    return { current: data[0]?.ema, previous: data[1]?.ema };
  } catch { return null; }
}

// Weekly RSI
async function fetchRSI(ticker) {
  try {
    const data = await fmpGet('/stable/technical-indicators/rsi', { symbol: ticker, periodLength: 14, timeframe: '1week' });
    if (!Array.isArray(data) || !data[0]) return null;
    return data[0]?.rsi || null;
  } catch { return null; }
}

// Daily ADX for trend strength
async function fetchADX(ticker) {
  try {
    const data = await fmpGet('/stable/technical-indicators/adx', { symbol: ticker, periodLength: 14, timeframe: '1day' });
    if (!Array.isArray(data) || data.length < 2) return null;
    return { value: data[0]?.adx, rising: data[0]?.adx > data[1]?.adx };
  } catch { return null; }
}

// 52-week max overnight gap (daily candles)
async function calcGapRisk(ticker) {
  try {
    const data = await fmpGet('/stable/historical-price-eod/full', { symbol: ticker });
    const candles = data?.historical || [];
    if (candles.length < 2) return 0;
    let maxGap = 0;
    for (let i = 0; i < Math.min(candles.length - 1, 260); i++) {
      const gap = Math.abs((candles[i].open - candles[i + 1].close) / candles[i + 1].close) * 100;
      if (gap > maxGap) maxGap = gap;
    }
    return +maxGap.toFixed(2);
  } catch { return 0; }
}

// ── GET /api/kill-pipeline ────────────────────────────────────────────────────
// Returns latest Kill scores from MongoDB (written by Friday pipeline or /api/apex).
// Enriches with live prices from FMP.

export async function killPipelineHandler(req, res) {
  try {
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ signals: [], error: 'DB unavailable' });

    const minScore    = parseInt(req.query.minScore)  || 0;
    const limit       = parseInt(req.query.limit)     || 50;
    const confirmedOnly = req.query.confirmed !== 'false';

    // Find most recent weekOf
    const latest = await db.collection('pnthr_kill_scores')
      .find().sort({ weekOf: -1 }).limit(1).toArray();

    if (!latest.length) {
      return res.json({ signals: [], weekOf: null, regime: null, updatedAt: new Date().toISOString() });
    }

    const weekOf  = latest[0].weekOf;
    const filter  = { weekOf, totalScore: { $gte: minScore } };
    if (confirmedOnly) filter.confirmation = 'CONFIRMED';

    const signals = await db.collection('pnthr_kill_scores')
      .find(filter).sort({ totalScore: -1 }).limit(limit).toArray();

    // Fetch live prices
    const tickers = signals.map(s => s.ticker);
    let livePrices = {};
    try { if (tickers.length) livePrices = await fetchQuotes(tickers); } catch { /* ok */ }

    // Portfolio tickers (IN PORT flag)
    const portfolio = await db.collection('pnthr_portfolio')
      .find({ status: 'ACTIVE' }).project({ ticker: 1 }).toArray();
    const inPort = new Set(portfolio.map(p => p.ticker));

    const regime = await db.collection('pnthr_kill_regime').findOne({ weekOf });

    const enriched = signals.map(s => ({
      ticker:       s.ticker,
      signal:       s.signal,
      tier:         s.tier,
      score:        s.totalScore,
      confirmation: s.confirmation,
      signalAge:    s.signalAge,
      sector:       s.sector,
      convPct:      s.convictionPct,
      slopePct:     s.slopePct,
      sepPct:       s.separationPct,
      rankChg:      s.dimensions?.d5?.raw || 0,
      entryQuality: s.entryQuality,
      price:        livePrices[s.ticker]?.price    || s.currentPrice,
      fridayClose:  s.currentPrice,
      priceChange:  livePrices[s.ticker]?.changePct || 0,
      priceSource:  livePrices[s.ticker] ? 'live' : 'friday_close',
      ema21:        s.ema21,
      maxGapPct:    s.maxGapPct,
      inPortfolio:  inPort.has(s.ticker),
    }));

    res.json({
      signals: enriched,
      weekOf,
      regime: regime ? {
        indexPosition: regime.indexPosition,
        indexSlope:    regime.indexSlope,
        blCount:       regime.blCount,
        ssCount:       regime.ssCount,
      } : null,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[CC] Kill pipeline error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ── GET /api/positions ────────────────────────────────────────────────────────
// Returns all active positions enriched with live FMP prices.

export async function positionsGetAll(req, res) {
  try {
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ positions: [], error: 'DB unavailable' });

    const positions = await db.collection('pnthr_portfolio')
      .find({ status: 'ACTIVE' }).sort({ createdAt: -1 }).toArray();

    const tickers = [...new Set(positions.map(p => p.ticker))];
    let live = {};
    try { if (tickers.length) live = await fetchQuotes(tickers); } catch { /* ok */ }

    const enriched = positions.map(p => ({
      ...p,
      currentPrice: live[p.ticker]?.price || p.currentPrice,
      priceSource:  live[p.ticker] ? 'live' : 'stored',
      dayHigh:      live[p.ticker]?.dayHigh  || null,
      dayLow:       live[p.ticker]?.dayLow   || null,
    }));

    res.json({ positions: enriched, count: enriched.length, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[CC] Positions GET error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ── POST /api/positions ───────────────────────────────────────────────────────
// Create a new position or update an existing one (by id).

export async function positionsSave(req, res) {
  try {
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });

    const position = req.body;
    if (!position.ticker || !position.direction) {
      return res.status(400).json({ error: 'ticker and direction are required' });
    }

    if (position.id) {
      await db.collection('pnthr_portfolio').updateOne(
        { id: position.id },
        { $set: { ...position, updatedAt: new Date() } },
        { upsert: true }
      );
    } else {
      position.id        = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      position.status    = 'ACTIVE';
      position.createdAt = new Date();
      position.updatedAt = new Date();
      position.outcome   = { exitPrice: null, profitPct: null, profitDollar: null, holdingDays: null, exitReason: null };
      await db.collection('pnthr_portfolio').insertOne(position);
    }

    res.json({ success: true, id: position.id });
  } catch (err) {
    console.error('[CC] Positions POST error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ── POST /api/positions/close ─────────────────────────────────────────────────
// Close a position. Body: { id, exitPrice, exitReason }

export async function positionsClose(req, res) {
  try {
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });

    const { id, exitPrice, exitReason } = req.body;
    if (!id || !exitPrice) return res.status(400).json({ error: 'id and exitPrice required' });

    const position = await db.collection('pnthr_portfolio').findOne({ id });
    if (!position) return res.status(404).json({ error: 'Position not found' });

    const isLong     = position.direction === 'LONG';
    const fills      = position.fills || {};
    const filledShr  = Object.values(fills).reduce((s, f) => s + (f.filled ? (+f.shares || 0) : 0), 0);
    const totalCost  = Object.values(fills).reduce((s, f) => s + (f.filled ? (+f.shares || 0) * (+f.price || 0) : 0), 0);
    const avgCost    = filledShr > 0 ? totalCost / filledShr : position.entryPrice;
    const profitPct  = isLong ? (exitPrice - avgCost) / avgCost * 100 : (avgCost - exitPrice) / avgCost * 100;
    const profitDollar = isLong ? (exitPrice - avgCost) * filledShr : (avgCost - exitPrice) * filledShr;
    const holdingDays = Math.floor((Date.now() - new Date(position.createdAt).getTime()) / 86400000);

    await db.collection('pnthr_portfolio').updateOne({ id }, {
      $set: {
        status: 'CLOSED', closedAt: new Date(), updatedAt: new Date(),
        outcome: {
          exitPrice,
          profitPct:    +profitPct.toFixed(2),
          profitDollar: +profitDollar.toFixed(2),
          holdingDays,
          exitReason:   exitReason || 'MANUAL',
        },
      },
    });

    res.json({ success: true, outcome: { profitPct: +profitPct.toFixed(2), profitDollar: +profitDollar.toFixed(2), holdingDays } });
  } catch (err) {
    console.error('[CC] Positions close error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ── GET /api/ticker/:symbol ───────────────────────────────────────────────────
// Auto-populate all data for a ticker. Called from "New Position" calculator.

export async function tickerHandler(req, res) {
  try {
    const ticker = req.params.symbol.toUpperCase();
    const db     = await connectToDatabase();

    // Parallel fetch: FMP data + MongoDB Kill score + cached gap risk
    const [quote, profile, ema, rsi, adx, killScore] = await Promise.allSettled([
      fetchQuotes([ticker]).then(r => r[ticker] || null),
      fetchProfile(ticker),
      fetchEMA21(ticker),
      fetchRSI(ticker),
      fetchADX(ticker),
      db ? db.collection('pnthr_kill_scores').findOne({ ticker }, { sort: { weekOf: -1 } }) : null,
    ]);

    const q = quote.value;
    const p = profile.value;
    const e = ema.value;
    const r = rsi.value;
    const a = adx.value;
    const k = killScore.value;

    // Gap risk: check cache first, compute if stale/missing
    let maxGapPct = 0;
    if (db) {
      const cached = await db.collection('pnthr_gap_risk').findOne({ ticker });
      if (cached && (Date.now() - new Date(cached.calculatedAt).getTime()) < 7 * 86400000) {
        maxGapPct = cached.maxGapPct;
      } else {
        maxGapPct = await calcGapRisk(ticker);
        if (db && maxGapPct > 0) {
          await db.collection('pnthr_gap_risk').updateOne(
            { ticker },
            { $set: { ticker, maxGapPct, calculatedAt: new Date(), dataPoints: 260 } },
            { upsert: true }
          );
        }
      }
    }

    // EMA slope
    let emaSlopePct = 0;
    if (e?.current && e?.previous && e.previous !== 0) {
      emaSlopePct = +((e.current - e.previous) / e.previous * 100).toFixed(3);
    }

    // Volume ratio
    const volumeRatio = q?.volume && q?.avgVolume ? +(q.volume / q.avgVolume).toFixed(2) : null;

    // Suggested direction from Kill score or EMA
    let suggestedDirection = null;
    if (k?.signal) suggestedDirection = k.signal === 'SS' ? 'SHORT' : 'LONG';
    else if (e?.current && q?.price) suggestedDirection = q.price > e.current ? 'LONG' : 'SHORT';

    res.json({
      ticker,
      found:            !!(q || k),
      currentPrice:     q?.price      || null,
      maxGapPct,
      sector:           p?.sector     || '',
      exchange:         p?.exchange   || '',
      companyName:      p?.companyName || '',
      ema21:            e?.current    || null,
      emaSlopePct,
      rsi:              r || null,
      adx:              a?.value      || null,
      adxRising:        a?.rising     || false,
      volumeRatio,
      killScore:        k?.totalScore || null,
      killTier:         k?.tier       || null,
      killConfirmation: k?.confirmation || null,
      entryQuality:     k?.entryQuality || null,
      convictionPct:    k?.convictionPct || 0,
      slopePct:         k?.slopePct     || 0,
      separationPct:    k?.separationPct || 0,
      signalAge:        k?.signalAge    || 0,
      suggestedDirection,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[CC] Ticker lookup error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ── GET /api/regime ───────────────────────────────────────────────────────────
// Returns market regime: SPY/QQQ vs 21-week EMA + BL/SS ratio.

export async function regimeHandler(req, res) {
  try {
    const db = await connectToDatabase();
    const latest = db ? await db.collection('pnthr_kill_regime').findOne({}, { sort: { weekOf: -1 } }) : null;

    // Live SPY/QQQ check
    let live = null;
    try {
      const [spyEma, qqqEma, quotes] = await Promise.all([
        fetchEMA21('SPY'),
        fetchEMA21('QQQ'),
        fetchQuotes(['SPY', 'QQQ']),
      ]);
      live = {
        spy: {
          price:    quotes['SPY']?.price || 0,
          ema21:    spyEma?.current || latest?.spy?.ema21 || 0,
          position: (quotes['SPY']?.price || 0) >= (spyEma?.current || 0) ? 'above' : 'below',
          changePct: quotes['SPY']?.changePct || 0,
        },
        qqq: {
          price:    quotes['QQQ']?.price || 0,
          ema21:    qqqEma?.current || latest?.qqq?.ema21 || 0,
          position: (quotes['QQQ']?.price || 0) >= (qqqEma?.current || 0) ? 'above' : 'below',
          changePct: quotes['QQQ']?.changePct || 0,
        },
      };
    } catch { /* live data optional */ }

    res.json({
      friday: latest ? {
        weekOf:        latest.weekOf,
        indexPosition: latest.indexPosition,
        indexSlope:    latest.indexSlope,
        blCount:       latest.blCount,
        ssCount:       latest.ssCount,
      } : null,
      live,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[CC] Regime error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ── MongoDB Index Bootstrap ───────────────────────────────────────────────────
// Called once on server startup to ensure Command Center indexes exist.

export async function ensureCommandCenterIndexes() {
  try {
    const db = await connectToDatabase();
    if (!db) return;

    // Portfolio
    const portfolio = db.collection('pnthr_portfolio');
    await portfolio.createIndex({ id: 1 }, { unique: true, sparse: true });
    await portfolio.createIndex({ status: 1, ticker: 1 });

    // Kill scores
    const scores = db.collection('pnthr_kill_scores');
    await scores.createIndex({ weekOf: 1, totalScore: -1 });
    await scores.createIndex({ weekOf: 1, ticker: 1 });
    await scores.createIndex({ weekOf: 1, confirmation: 1 });
    await scores.createIndex({ ticker: 1, weekOf: -1 });

    // Kill regime
    const regime = db.collection('pnthr_kill_regime');
    await regime.createIndex({ weekOf: 1 }, { unique: true });

    // Kill history
    const history = db.collection('pnthr_kill_history');
    await history.createIndex({ weekOf: 1, ticker: 1 });
    await history.createIndex({ ticker: 1, weekOf: -1 });

    // Gap risk cache
    const gapRisk = db.collection('pnthr_gap_risk');
    await gapRisk.createIndex({ ticker: 1 }, { unique: true });

    // FMP candle cache — TTL index auto-expires docs after 7 days
    const candles = db.collection('pnthr_candle_cache');
    await candles.createIndex({ ticker: 1 }, { unique: true });
    await candles.createIndex({ cachedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

    console.log('[CC] Command Center MongoDB indexes ensured');
  } catch (e) {
    console.warn('[CC] Index creation failed (non-fatal):', e.message);
  }
}
