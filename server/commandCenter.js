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
import { normalizeSector } from './sectorUtils.js';
import { calculateSectorExposure } from './sectorExposure.js';
import { computeEMAFromDailyBars, computeEMA21fromDailyBars } from './technicalUtils.js';
import { getSectorEmaPeriod } from './sectorEmaConfig.js';

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

// Batch quotes for up to 500 tickers per call.
// Uses /api/v3/quote/{symbols} (path-based multi-symbol) — the /stable/quote
// endpoint silently returns [] when given a comma-separated list, so multi-symbol
// queries against it had been losing every price (= 0 in caller) for some time.
async function fetchQuotes(tickers) {
  const results = {};
  for (let i = 0; i < tickers.length; i += 500) {
    const batch = tickers.slice(i, i + 500);
    try {
      const data = await fmpGet(`/api/v3/quote/${batch.join(',')}`);
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
    return { sector: normalizeSector(p.sector), exchange: p.exchangeShortName, companyName: p.companyName, marketCap: p.mktCap };
  } catch { return null; }
}

// EMA from daily candles — parameterized by period.
// Defaults to 21 for backward compatibility (regime, index).
// Pass sector-specific period via getSectorEmaPeriod() for individual stocks.
async function fetchEMA(ticker, period) {
  try {
    const url = fmpUrl(`/api/v3/historical-price-full/${ticker}`, { timeseries: '250' });
    const data = await fetch(url, { signal: AbortSignal.timeout(8000) })
      .then(r => r.ok ? r.json() : null).catch(() => null);
    return period != null
      ? computeEMAFromDailyBars(data?.historical ?? null, period)
      : computeEMA21fromDailyBars(data?.historical ?? null);
  } catch { return null; }
}

// Backward-compat alias — regime (SPY/QQQ) always uses 21-period
async function fetchEMA21(ticker) {
  return fetchEMA(ticker);
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

// ── Trading-Days Counter ──────────────────────────────────────────────────────
// Count weekday trading days from createdAt to today (excludes weekends only).
// Good enough for stale-position warnings; does not subtract public holidays.

function tradingDaysSince(createdAt) {
  if (!createdAt) return 0;
  const start = new Date(createdAt);
  const now   = new Date();
  let count = 0;
  const d = new Date(start);
  d.setHours(0, 0, 0, 0);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  while (d < today) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

// 52-week max overnight gap (daily candles)
async function calcGapRisk(ticker) {
  try {
    const data = await fmpGet('/stable/historical-price-eod/full', { symbol: ticker });
    // Stable endpoint returns flat array; legacy returns { historical: [...] }
    const candles = Array.isArray(data) ? data : (data?.historical || []);
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

    // Portfolio tickers (IN PORT flag) — scoped to the requesting user
    const portfolio = await db.collection('pnthr_portfolio')
      .find({ status: 'ACTIVE', ownerId: req.user.userId }).project({ ticker: 1 }).toArray();
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
      .find({ status: { $nin: ['CLOSED'] }, ownerId: req.user.userId }).sort({ createdAt: -1 }).toArray();

    const tickers = [...new Set(positions.map(p => p.ticker))];
    let live = {};
    try { if (tickers.length) live = await fetchQuotes(tickers); } catch { /* ok */ }

    // ── FEAST alert: weekly RSI > 85 = overextended; SELL 50% immediately ──────
    // Fetch in parallel; non-fatal if any call fails
    const rsiMap = {};
    if (tickers.length) {
      const rsiResults = await Promise.allSettled(tickers.map(t => fetchRSI(t)));
      tickers.forEach((t, i) => { rsiMap[t] = rsiResults[i].value ?? null; });
    }

    // ── Sector concentration summary ─────────────────────────────────────────
    const sectorCounts = {};
    for (const p of positions) {
      if (p.sector && p.sector !== '—') {
        sectorCounts[p.sector] = (sectorCounts[p.sector] || 0) + 1;
      }
    }
    const saturatedSectors = Object.entries(sectorCounts)
      .filter(([, cnt]) => cnt >= 3).map(([s]) => s);

    const IBKR_FRESH_MS = 5 * 60 * 1000; // 5 minutes
    const enriched = positions.map(p => {
      const rsi       = rsiMap[p.ticker] ?? null;
      const ibkrFresh = p.ibkrSyncedAt &&
        (Date.now() - new Date(p.ibkrSyncedAt).getTime()) < IBKR_FRESH_MS;
      // FMP is the real-time price source. IBKR updatePortfolio prices update only
      // when TWS refreshes its portfolio view (every few minutes), so always prefer
      // the live FMP quote. IBKR avg cost / shares still used for P&L accuracy.
      const livePrice   = live[p.ticker]?.price || null;
      const ibkrPrice   = ibkrFresh ? p.currentPrice : null;
      return {
        ...p,
        currentPrice:      livePrice ?? ibkrPrice ?? p.currentPrice,
        priceSource:       livePrice ? (ibkrFresh ? 'fmp+ibkr' : 'live') : (ibkrFresh ? 'ibkr' : 'stored'),
        dayHigh:           live[p.ticker]?.dayHigh  || null,
        dayLow:            live[p.ticker]?.dayLow   || null,
        tradingDaysActive: tradingDaysSince(p.createdAt),
        feastAlert:        rsi !== null && rsi > 85,
        feastRSI:          rsi,
      };
    });

    res.json({
      positions:        enriched,
      count:            enriched.length,
      sectorCounts,
      saturatedSectors,
      updatedAt:        new Date().toISOString(),
    });
  } catch (err) {
    console.error('[CC] Positions GET error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ── POST /api/positions ───────────────────────────────────────────────────────
// Create a new position or update an existing one (by id).
//
// SACRED FIELDS — this handler persists user-edited data, so these must come
// through from the client and be saved as-is:
//   fills[1-5].price/shares/date/filled, stopPrice, originalStop,
//   entryPrice, direction, signal, exits[].price/shares
//
// TRANSIENT DISPLAY FIELDS — computed server-side, must NOT be persisted from
// the client payload (they would overwrite values written by IBKR sync or
// the price-refresh endpoint):
//   priceSource, dayHigh, dayLow, tradingDaysActive, feastAlert, feastRSI
//   (ibkrAvgCost, ibkrShares, ibkrSyncedAt are excluded below for same reason)

// Fields that are computed/transient on the server and must never be saved back
// from the client payload into MongoDB.
const TRANSIENT_FIELDS = new Set([
  'priceSource', 'dayHigh', 'dayLow', 'tradingDaysActive',
  'feastAlert', 'feastRSI',
  // IBKR fields are written exclusively by ibkrSync.js — reject any client values
  'ibkrAvgCost', 'ibkrShares', 'ibkrSyncedAt', 'ibkrUnrealizedPNL', 'ibkrMarketValue',
]);

function stripTransientFields(obj) {
  const clean = { ...obj };
  for (const key of TRANSIENT_FIELDS) delete clean[key];
  return clean;
}

export async function positionsSave(req, res) {
  try {
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });

    const position = req.body;

    let warning = null;

    if (position.id) {
      // ── Surgical patch (update existing position) ──────────────────────────
      // Strip transient/IBKR display fields — they must not overwrite values
      // written by ibkrSync.js or the price-refresh endpoint.
      // Only the fields present in the request body are written ($set is surgical).
      // This means concurrent patches to different fields (fills vs stopPrice)
      // can never overwrite each other — the permanent fix for the revert bug.
      const saveData = stripTransientFields(position);
      // Guard: never allow a partial patch to clobber entryPrice or originalStop
      // unless those fields were explicitly included in this save payload.
      // (Full-position saves from createPosition always include them.)
      await db.collection('pnthr_portfolio').updateOne(
        { id: position.id, ownerId: req.user.userId },
        { $set: { ...saveData, updatedAt: new Date() } }
        // No { upsert: true } — updates should only touch existing positions.
        // New positions use the insertOne path below.
      );
    } else {
      // ── New position — ticker and direction are required ────────────────────
      if (!position.ticker || !position.direction) {
        return res.status(400).json({ error: 'ticker and direction are required for new positions' });
      }
      // ── Sector net-exposure check (warn, not block) ─────────────────────────
      if (position.sector && position.sector !== '—') {
        const existingPositions = await db.collection('pnthr_portfolio')
          .find({ ownerId: req.user.userId, status: { $in: ['ACTIVE', 'PARTIAL'] } })
          .toArray();
        const exposure    = calculateSectorExposure(existingPositions);
        const sectorName  = normalizeSector(position.sector);
        const sectorData  = exposure[sectorName] || { longCount: 0, shortCount: 0, netExposure: 0 };
        const newDir      = (position.direction || '').toUpperCase();
        const projLongs   = sectorData.longCount  + (newDir === 'LONG'  ? 1 : 0);
        const projShorts  = sectorData.shortCount + (newDir === 'SHORT' ? 1 : 0);
        const projNet     = Math.abs(projLongs - projShorts);
        if (projNet > 3) {
          warning = {
            type:    'SECTOR_HEIGHTENED',
            message: `Adding this ${newDir} in ${sectorName} would bring net directional exposure to ${projNet}. Advisory only — Fund policy allows manager discretion on sector concentration.`,
          };
        } else if (projNet === 3) {
          warning = {
            type:    'SECTOR_ELEVATED',
            message: `${sectorName} would be at net exposure ${projNet} (${projLongs}L / ${projShorts}S). Advisory only — Fund policy allows manager discretion; balancing with a ${newDir === 'LONG' ? 'short' : 'long'} is optional.`,
          };
        }
      }

      // Duplicate guard — block if an active position already exists for this ticker
      const existingActive = await db.collection('pnthr_portfolio').findOne({
        ticker:  position.ticker.toUpperCase(),
        ownerId: req.user.userId,
        status:  { $in: ['ACTIVE', 'PARTIAL'] },
      });
      if (existingActive) return res.status(409).json({ error: `${position.ticker} already has an active position in Command` });

      position.id        = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      position.status    = 'ACTIVE';
      position.ownerId   = req.user.userId;
      position.createdAt = new Date();
      position.updatedAt = new Date();
      position.outcome   = { exitPrice: null, profitPct: null, profitDollar: null, holdingDays: null, exitReason: null };
      try {
        await db.collection('pnthr_portfolio').insertOne(position);
      } catch (insertErr) {
        if (insertErr.code === 11000) return res.status(409).json({ error: 'Position already exists for this ticker' });
        throw insertErr;
      }
    }

    res.json({ success: true, id: position.id, warning });
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

    const userId = req.user.userId;
    const position = await db.collection('pnthr_portfolio').findOne({ id, ownerId: userId });
    if (!position) return res.status(404).json({ error: 'Position not found' });
    if (position.status === 'CLOSED') return res.status(400).json({ error: 'Position already closed' });

    const isLong     = position.direction === 'LONG';
    const fills      = position.fills || {};
    const filledShr  = Object.values(fills).reduce((s, f) => s + (f.filled ? (+f.shares || 0) : 0), 0);
    const totalCost  = Object.values(fills).reduce((s, f) => s + (f.filled ? (+f.shares || 0) * (+f.price || 0) : 0), 0);
    const avgCost    = filledShr > 0 ? totalCost / filledShr : position.entryPrice;
    const profitPct  = isLong ? (exitPrice - avgCost) / avgCost * 100 : (avgCost - exitPrice) / avgCost * 100;
    const profitDollar = isLong ? (exitPrice - avgCost) * filledShr : (avgCost - exitPrice) * filledShr;
    const holdingDays = Math.floor((Date.now() - new Date(position.createdAt).getTime()) / 86400000);

    await db.collection('pnthr_portfolio').updateOne({ id, ownerId: userId }, {
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

    // ── Sync to journal (best-effort — don't fail the close if journal sync fails) ──
    try {
      const { createJournalEntry } = await import('./journalService.js');
      const { calculateDisciplineScore } = await import('./disciplineScoring.js');

      // Re-read position after close update so journal gets final state
      const closedPos = await db.collection('pnthr_portfolio').findOne({ id, ownerId: userId });

      // Create journal entry if one doesn't exist yet (non-queue/test trades may not have one)
      await createJournalEntry(db, closedPos, userId);

      // Build exit record matching exitService format
      const exitRecord = {
        id: 'E1',
        shares: filledShr,
        price: +exitPrice,
        date: new Date().toISOString().split('T')[0],
        time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        reason: exitReason || 'MANUAL',
        note: '',
        isOverride: (exitReason || 'MANUAL') === 'MANUAL',
        isFinalExit: true,
        pnl: { dollar: +profitDollar.toFixed(2), pct: +profitPct.toFixed(2) },
        remainingShares: 0,
        createdAt: new Date(),
      };

      // Sync exit to journal
      await db.collection('pnthr_journal').updateOne(
        { positionId: id.toString(), ownerId: userId },
        {
          $push: { exits: exitRecord },
          $set: {
            'performance.status': 'CLOSED',
            'performance.remainingShares': 0,
            'performance.avgExitPrice': +exitPrice,
            'performance.realizedPnlDollar': +profitDollar.toFixed(2),
            'performance.realizedPnlPct': +profitPct.toFixed(2),
            closedAt: new Date(),
            updatedAt: new Date(),
          },
        }
      );

      // Discipline score
      const journal = await db.collection('pnthr_journal').findOne(
        { positionId: id.toString(), ownerId: userId },
        { projection: { _id: 1 } }
      );
      if (journal) {
        await calculateDisciplineScore(db, journal._id.toString());
      }

      // Wash sale tracking for losses
      if (profitDollar < 0) {
        const exitDate = new Date();
        exitDate.setUTCHours(0, 0, 0, 0);
        const expiryDate = new Date(exitDate);
        expiryDate.setUTCDate(expiryDate.getUTCDate() + 30);
        await db.collection('pnthr_journal').updateOne(
          { positionId: id.toString(), ownerId: userId },
          { $set: { 'washSale.isLoss': true, 'washSale.lossAmount': +profitDollar.toFixed(2), 'washSale.exitDate': exitDate, 'washSale.expiryDate': expiryDate, 'washSale.triggered': false } }
        );
      }

      console.log(`[CC] ✅ Journal synced for ${position.ticker} close (${exitReason || 'MANUAL'})`);
    } catch (journalErr) {
      console.warn(`[CC] Journal sync failed for ${position.ticker}:`, journalErr.message);
    }

    res.json({ success: true, outcome: { profitPct: +profitPct.toFixed(2), profitDollar: +profitDollar.toFixed(2), holdingDays } });
  } catch (err) {
    console.error('[CC] Positions close error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ── DELETE /api/positions/:id ─────────────────────────────────────────────────
// Hard-delete a position from the portfolio. Admin only. Used to remove test
// entries or positions added by mistake.

export async function positionsDelete(req, res) {
  try {
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });

    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'id required' });

    const result = await db.collection('pnthr_portfolio').deleteOne({ id, ownerId: req.user.userId });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Position not found' });

    res.json({ success: true });
  } catch (err) {
    console.error('[CC] Positions delete error:', err);
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
    // Profile is fetched first (with other non-EMA calls) so we know the sector
    // before computing the sector-specific EMA period.
    const [quote, profile, rsi, adx, killScore] = await Promise.allSettled([
      fetchQuotes([ticker]).then(r => r[ticker] || null),
      fetchProfile(ticker),
      fetchRSI(ticker),
      fetchADX(ticker),
      db ? db.collection('pnthr_kill_scores').findOne({ ticker }, { sort: { weekOf: -1 } }) : null,
    ]);

    const q = quote.value;
    const p = profile.value;
    const r = rsi.value;
    const a = adx.value;
    const k = killScore.value;

    // Fetch EMA with sector-specific period (requires profile for sector)
    const sectorName = normalizeSector(p?.sector || '');
    const emaPeriod  = getSectorEmaPeriod(sectorName);
    const e = await fetchEMA(ticker, emaPeriod).catch(() => null);

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
      sector:           sectorName,
      exchange:         p?.exchange   || '',
      companyName:      p?.companyName || '',
      ema21:            e?.current    || null,
      emaPeriod,
      emaSlopePct,
      rsi:              r || null,
      adx:              a?.value      || null,
      adxRising:        a?.rising     || false,
      volumeRatio,
      killScore:        k?.totalScore ?? null,
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
// Returns market regime: SPY/QQQ vs 21W Index EMA + BL/SS ratio.

export async function regimeHandler(req, res) {
  try {
    const db = await connectToDatabase();
    const latest = db ? await db.collection('pnthr_kill_regime').findOne({}, { sort: { weekOf: -1 } }) : null;

    // Live SPY/QQQ check
    // CRITICAL: never fall back to EMA=0 — that makes every stock "above" the EMA
    let live = null;
    try {
      const [spyEma, qqqEma, quotes] = await Promise.all([
        fetchEMA21('SPY'),
        fetchEMA21('QQQ'),
        fetchQuotes(['SPY', 'QQQ']),
      ]);

      const spyPrice  = quotes['SPY']?.price || null;
      const qqqPrice  = quotes['QQQ']?.price || null;
      const spyEma21  = spyEma?.current || null;   // null if FMP failed — do NOT default to 0
      const qqqEma21  = qqqEma?.current || null;

      // Live position requires BOTH a real price AND a real EMA. If either is
      // missing/zero (FMP quote or EMA call failed), fall back to the stored
      // Friday boolean — which is stale but at least directionally correct.
      // If both sources are missing, return null so the client surfaces ERROR
      // instead of silently lying (per Data Integrity Rules — ERROR not UNKNOWN).
      const fridayPos = (b) => b == null ? null : (b ? 'above' : 'below');
      const livePos = (price, ema) => (price && ema) ? (price >= ema ? 'above' : 'below') : null;

      const spyPos = livePos(spyPrice, spyEma21) ?? fridayPos(latest?.spyAboveEma);
      const qqqPos = livePos(qqqPrice, qqqEma21) ?? fridayPos(latest?.qqqAboveEma);

      console.log(`[REGIME] SPY price=${spyPrice} ema21=${spyEma21} pos=${spyPos} | QQQ price=${qqqPrice} ema21=${qqqEma21} pos=${qqqPos}`);

      live = {
        spy: {
          price:     spyPrice || 0,
          ema21:     spyEma21 ?? null,
          position:  spyPos,
          changePct: quotes['SPY']?.changePct || 0,
        },
        qqq: {
          price:     qqqPrice || 0,
          ema21:     qqqEma21 ?? null,
          position:  qqqPos,
          changePct: quotes['QQQ']?.changePct || 0,
        },
      };
    } catch (e) {
      console.error('[REGIME] Live data fetch failed:', e.message);
    }

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
  const db = await connectToDatabase();
  if (!db) return;

  // Helper: create one index, skip silently if it already exists with different options
  // (MongoDB error code 85 = IndexOptionsConflict, 86 = IndexKeySpecsConflict)
  async function idx(collection, spec, opts = {}) {
    try {
      await collection.createIndex(spec, opts);
    } catch (e) {
      if (e.code === 85 || e.code === 86) return; // index already exists — fine
      console.warn(`[CC] Index warning on ${collection.collectionName}:`, e.message);
    }
  }

  // Portfolio
  const portfolio = db.collection('pnthr_portfolio');
  await idx(portfolio, { id: 1 },             { unique: true, sparse: true });
  await idx(portfolio, { status: 1, ticker: 1 });
  await idx(portfolio, { ownerId: 1, status: 1 });

  // Kill scores
  const scores = db.collection('pnthr_kill_scores');
  await idx(scores, { weekOf: 1, totalScore: -1 });
  await idx(scores, { weekOf: 1, ticker: 1 });
  await idx(scores, { weekOf: 1, confirmation: 1 });
  await idx(scores, { ticker: 1, weekOf: -1 });

  // Kill regime
  const regime = db.collection('pnthr_kill_regime');
  await idx(regime, { weekOf: 1 }, { unique: true });
  await idx(regime, { weekOf: -1 });

  // Kill history
  const history = db.collection('pnthr_kill_history');
  await idx(history, { weekOf: 1, ticker: 1 });
  await idx(history, { ticker: 1, weekOf: -1 });

  // Gap risk cache
  const gapRisk = db.collection('pnthr_gap_risk');
  await idx(gapRisk, { ticker: 1 }, { unique: true });

  // FMP candle cache — TTL index auto-expires docs after 7 days
  const candles = db.collection('pnthr_candle_cache');
  await idx(candles, { ticker: 1 },    { unique: true });
  await idx(candles, { cachedAt: 1 },  { expireAfterSeconds: 7 * 24 * 60 * 60 });

  // User profiles
  const profiles = db.collection('user_profiles');
  await idx(profiles, { userId: 1 }, { unique: true, sparse: true });
  await idx(profiles, { email: 1 },  { unique: true, sparse: true });

  // Signal history archive
  const signalHistory = db.collection('signal_history');
  await idx(signalHistory, { weekOf: -1 });

  // Portfolio returns
  const portfolioReturns = db.collection('pnthr_portfolio_returns');
  await idx(portfolioReturns, { ownerId: 1, date: -1 });

  // Journal
  const journal = db.collection('pnthr_journal');
  await idx(journal, { ownerId: 1, 'performance.status': 1 });
  await idx(journal, { ticker: 1, ownerId: 1 });

  // Pending entries
  const pending = db.collection('pnthr_pending_entries');
  await idx(pending, { ownerId: 1, status: 1 });

  console.log('[CC] Command Center MongoDB indexes ensured');
}
