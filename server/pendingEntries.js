// server/pendingEntries.js
// ── PNTHR Pending Entries & NAV Settings API Handlers ─────────────────────────
//
// Routes (mounted in index.js):
//   GET  /api/settings/nav                — Current user's NAV (accountSize)
//   POST /api/settings/nav                — Save NAV to user profile
//   GET  /api/pending-entries             — PENDING entries for current user
//   POST /api/pending-entries             — Bulk insert queued entries (admin)
//   POST /api/pending-entries/:id/confirm — Confirm entry → creates position (admin)
//   POST /api/pending-entries/:id/dismiss — Dismiss entry (admin)
// ─────────────────────────────────────────────────────────────────────────────

import { connectToDatabase, getUserProfile, upsertUserProfile } from './database.js';
import { createJournalEntry } from './journalService.js';
import { fetchMarketSnapshot, getSectorEtf } from './marketSnapshot.js';
import { fetchTechnicalSnapshot } from './technicalSnapshot.js';
import { normalizeSector } from './sectorUtils.js';
import { getDevelopingSignalTickers } from './signalService.js';
import { calculateSectorExposure } from './sectorExposure.js';

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE    = 'https://financialmodelingprep.com';

// ── GET /api/settings/nav ─────────────────────────────────────────────────────

export async function navGet(req, res) {
  try {
    const profile = await getUserProfile(req.user.userId);
    res.json({ nav: profile?.accountSize ?? 100000 });
  } catch (err) {
    console.error('[PE] navGet error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ── POST /api/settings/nav ────────────────────────────────────────────────────

export async function navPost(req, res) {
  try {
    const { nav } = req.body;
    if (typeof nav !== 'number' || nav <= 0) {
      return res.status(400).json({ error: 'nav must be a positive number' });
    }
    await upsertUserProfile(req.user.userId, { accountSize: nav });
    res.json({ success: true, nav });
  } catch (err) {
    console.error('[PE] navPost error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ── GET /api/pending-entries ──────────────────────────────────────────────────
// Returns all PENDING entries for the current user.

export async function pendingEntriesGet(req, res) {
  try {
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });

    const entries = await db.collection('pnthr_pending_entries')
      .find({ ownerId: req.user.userId, status: 'PENDING' })
      .sort({ queuedAt: 1 })
      .toArray();

    res.json(entries);
  } catch (err) {
    console.error('[PE] pendingEntriesGet error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ── POST /api/pending-entries ─────────────────────────────────────────────────
// Bulk insert queued entries. Body: array of entry objects.
// Existing PENDING entries for queued tickers are replaced (upsert by ticker+ownerId).

export async function pendingEntriesPost(req, res) {
  try {
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });

    const entries = req.body;
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: 'Body must be a non-empty array of entries' });
    }

    const now = new Date();
    const ops = entries.map(entry => ({
      updateOne: {
        filter: { ownerId: req.user.userId, ticker: entry.ticker, status: 'PENDING' },
        update: {
          $set: {
            ...entry,
            id:        entry.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
            ownerId:   req.user.userId,
            status:    'PENDING',
            queuedAt:  entry.queuedAt ? new Date(entry.queuedAt) : now,
            updatedAt: now,
          },
        },
        upsert: true,
      },
    }));

    await db.collection('pnthr_pending_entries').bulkWrite(ops);
    res.json({ success: true, count: entries.length });
  } catch (err) {
    console.error('[PE] pendingEntriesPost error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ── POST /api/pending-entries/:id/confirm ─────────────────────────────────────
// Confirm a pending entry. Creates a full position in pnthr_portfolio.
// Body: { fillPrice, shares, date, stop, direction }

export async function pendingEntryConfirm(req, res) {
  try {
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });

    const entry = await db.collection('pnthr_pending_entries').findOne({
      id: req.params.id, ownerId: req.user.userId, status: 'PENDING',
    });
    if (!entry) return res.status(404).json({ error: 'Pending entry not found' });

    const { fillPrice, shares, date, stop, direction } = req.body;
    if (!fillPrice || !shares) return res.status(400).json({ error: 'fillPrice and shares are required' });

    const resolvedDirection = (direction === 'LONG' || direction === 'SHORT') ? direction : entry.direction;

    // ═══════════════════════════════════════════════════════════════
    // DATA POPULATION — ANALYZE SNAPSHOT IS PRIMARY SOURCE
    // ═══════════════════════════════════════════════════════════════

    const analyze = entry.analyzeScore || null;
    const raw     = analyze?.rawData   || null;

    // ── Kill Score Cascade ──────────────────────────────────────────────────
    let killScoreAtEntry = null;

    // Source 1: Analyze snapshot rawData (what was live on screen)
    if (raw?.kill?.totalScore != null) {
      killScoreAtEntry = {
        totalScore:       raw.kill.totalScore,
        pipelineMaxScore: raw.kill.pipelineMaxScore ?? null,
        rank:             raw.kill.rank      ?? null,
        rankChange:       raw.kill.rankChange ?? null,
        tier:             raw.kill.tier       ?? null,
        d1: raw.kill.d1 ?? null, d2: raw.kill.d2 ?? null,
        d3: raw.kill.d3 ?? null, d4: raw.kill.d4 ?? null,
        d5: raw.kill.d5 ?? null, d6: raw.kill.d6 ?? null,
        d7: raw.kill.d7 ?? null, d8: raw.kill.d8 ?? null,
        signal:      raw.signal?.type  ?? null,
        signalAge:   raw.signal?.age   ?? null,
        signalPrice: raw.signal?.price ?? null,
        source:      'ANALYZE_SNAPSHOT',
      };
      console.log(`[CONFIRM] ${entry.ticker}: Kill from Analyze snapshot — score=${killScoreAtEntry.totalScore}, rank=${killScoreAtEntry.rank}`);
    }

    // Source 2: Queue entry fields
    if (!killScoreAtEntry && entry.killScore != null) {
      killScoreAtEntry = {
        totalScore:       entry.killScore,
        pipelineMaxScore: null,
        rank:             entry.killRank  || null,
        rankChange:       null,
        tier:             entry.killTier  || null,
        d1: null, d2: null, d3: null, d4: null,
        d5: null, d6: null, d7: null, d8: null,
        signal:      entry.signal    || null,
        signalAge:   entry.signalAge ?? null,
        signalPrice: null,
        source:      'QUEUE_ENTRY',
      };
      console.log(`[CONFIRM] ${entry.ticker}: Kill from queue entry — score=${entry.killScore}`);
    }

    // Source 3: MongoDB pipeline (last resort)
    if (!killScoreAtEntry) {
      try {
        const killDoc = await db.collection('pnthr_kill_scores')
          .findOne({ ticker: entry.ticker.toUpperCase() }, { sort: { createdAt: -1 } });
        if (killDoc) {
          let pipelineMaxScore = null;
          if (killDoc.weekOf) {
            const maxDoc = await db.collection('pnthr_kill_scores')
              .findOne({ weekOf: killDoc.weekOf }, { sort: { totalScore: -1 } });
            pipelineMaxScore = maxDoc?.totalScore ?? null;
          }
          killScoreAtEntry = {
            totalScore:       killDoc.totalScore   ?? null,
            pipelineMaxScore,
            rank:             killDoc.killRank      ?? null,
            rankChange:       killDoc.rankChange    ?? null,
            tier:             killDoc.tier           ?? null,
            d1: killDoc.preMultiplier ?? null,
            d2: null, d3: null, d4: null,
            d5: null, d6: null, d7: null, d8: null,
            signal:      killDoc.signal    ?? null,
            signalAge:   killDoc.signalAge ?? null,
            signalPrice: killDoc.signalPrice ?? null,
            source:      'MONGODB_PIPELINE',
          };
          console.log(`[CONFIRM] ${entry.ticker}: Kill from MongoDB pipeline — score=${killScoreAtEntry.totalScore}`);
        }
      } catch (e) {
        console.warn(`[CONFIRM] ${entry.ticker}: MongoDB Kill lookup failed:`, e.message);
      }
    }

    if (!killScoreAtEntry) {
      console.warn(`[CONFIRM] ${entry.ticker}: No Kill score from any source`);
    }

    // ── Signal Cascade ──────────────────────────────────────────────────────
    let signal     = null;
    let signalAge  = null;
    let entryContext = 'NO_SIGNAL';

    if (raw?.signal?.type) {
      signal      = raw.signal.type;
      signalAge   = raw.signal.age ?? null;
      entryContext = raw.signal.isDeveloping ? 'DEVELOPING_SIGNAL'
        : (signal === 'BL' || signal === 'SS')
          ? ((signalAge != null && signalAge <= 1) ? 'CONFIRMED_SIGNAL' : 'STALE_SIGNAL')
          : 'NO_SIGNAL';
      console.log(`[CONFIRM] ${entry.ticker}: Signal from Analyze — ${signal}+${signalAge}, ctx=${entryContext}`);
    } else if (entry.signal) {
      signal      = entry.signal;
      signalAge   = entry.signalAge ?? null;
      entryContext = (signalAge || 0) <= 1 ? 'CONFIRMED_SIGNAL' : 'STALE_SIGNAL';
      console.log(`[CONFIRM] ${entry.ticker}: Signal from queue entry — ${signal}`);
    } else if (killScoreAtEntry?.signal) {
      signal      = killScoreAtEntry.signal;
      signalAge   = killScoreAtEntry.signalAge ?? null;
      entryContext = (signalAge || 0) <= 1 ? 'CONFIRMED_SIGNAL' : 'STALE_SIGNAL';
      console.log(`[CONFIRM] ${entry.ticker}: Signal from Kill data — ${signal}`);
    } else {
      try {
        const devTickers = getDevelopingSignalTickers();
        if (devTickers.has(entry.ticker.toUpperCase())) entryContext = 'DEVELOPING_SIGNAL';
      } catch (e) { /* ignore */ }
    }

    // ── Sector Resolution ──────────────────────────────────────────────────
    let resolvedSector = raw?.stock?.sector || entry.sector || null;
    if (entry.isETF) {
      resolvedSector = 'ETF';
    } else if (!resolvedSector || resolvedSector === '—' || resolvedSector === '') {
      try {
        const url = `${FMP_BASE}/api/v3/profile/${entry.ticker}?apikey=${FMP_API_KEY}`;
        const profileRes = await fetch(url);
        const profile = await profileRes.json();
        resolvedSector = normalizeSector(profile?.[0]?.sector || '') || 'Unknown';
        console.log(`[CONFIRM] ${entry.ticker}: Sector from FMP profile — ${resolvedSector}`);
      } catch (e) {
        resolvedSector = 'Unknown';
      }
    } else {
      resolvedSector = normalizeSector(resolvedSector);
    }

    // ── Market Data Cascade ────────────────────────────────────────────────
    let marketAtEntry = {};

    // Source 1: Analyze snapshot
    if (raw?.market?.spy?.aboveEma != null || raw?.market?.regime) {
      marketAtEntry = {
        spy:    raw.market.spy    || null,
        qqq:    raw.market.qqq    || null,
        vix:    raw.market.vix != null ? { close: raw.market.vix } : null,
        regime: raw.market.regime ? { label: raw.market.regime } : null,
        source: 'ANALYZE_SNAPSHOT',
      };
      console.log(`[CONFIRM] ${entry.ticker}: Market from Analyze snapshot — regime=${raw.market.regime}`);
    }

    // Source 2: Live FMP snapshot (enriches with sector ETF, yields, etc.)
    try {
      const liveSnapshot = await fetchMarketSnapshot(resolvedSector || null).catch(() => ({}));
      if (liveSnapshot && Object.keys(liveSnapshot).length > 0) {
        marketAtEntry = {
          ...marketAtEntry,
          ...liveSnapshot,
          // Keep analyze snapshot SPY/QQQ/regime as they reflect decision time
          spy:    marketAtEntry.spy    || liveSnapshot.spy    || null,
          qqq:    marketAtEntry.qqq    || liveSnapshot.qqq    || null,
          regime: marketAtEntry.regime || (liveSnapshot.regime ? { label: liveSnapshot.regime } : null),
          source: marketAtEntry.source || 'LIVE_SNAPSHOT',
        };
      }
    } catch (e) {
      console.warn(`[CONFIRM] ${entry.ticker}: Live market snapshot failed:`, e.message);
    }

    // Source 3: Regime fallback
    if (!marketAtEntry.spy && !marketAtEntry.spyPosition) {
      try {
        const regime = await db.collection('pnthr_kill_regime').findOne({}, { sort: { weekOf: -1 } });
        if (regime) {
          marketAtEntry = {
            ...marketAtEntry,
            spyPosition: regime.spyAboveEma ? 'above' : 'below',
            qqqPosition: regime.qqqAboveEma ? 'above' : 'below',
            regime:      regime.regime || null,
            source:      marketAtEntry.source || 'REGIME_FALLBACK',
          };
          console.log(`[CONFIRM] ${entry.ticker}: Market from regime fallback`);
        }
      } catch (e) {
        console.error(`[CONFIRM] ${entry.ticker}: All market data sources failed`);
      }
    }

    // ── Exchange & NAV ──────────────────────────────────────────────────────
    const exchange   = raw?.stock?.exchange || entry.exchange || null;
    let   navAtEntry = raw?.nav ?? null;
    if (!navAtEntry) {
      try {
        const userProfile = await getUserProfile(req.user.userId);
        navAtEntry = userProfile?.accountSize ?? null;
      } catch (e) { /* ignore */ }
    }

    // ── Analyze Score snapshot ──────────────────────────────────────────────
    const analyzeScoreAtEntry = analyze ? {
      score:      analyze.score     ?? null,
      max:        analyze.max       ?? 53,
      pct:        analyze.pct       ?? null,
      projected:  analyze.projected ?? null,
      composite:  analyze.composite ?? null,
      warnings:   analyze.warnings  ?? [],
      direction:  analyze.direction ?? null,
      computedAt: analyze.rawData?.analyzedAt || analyze.computedAt || new Date().toISOString(),
      source:     'ANALYZE',
    } : null;

    // ═══════════════════════════════════════════════════════════════
    // BUILD POSITION
    // ═══════════════════════════════════════════════════════════════

    const posId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const fills = { 1: { filled: true, price: +fillPrice, shares: +shares, date: date || new Date().toISOString().split('T')[0] } };
    for (let i = 2; i <= 5; i++) fills[i] = { filled: false };

    const position = {
      id:           posId,
      ticker:       entry.ticker,
      direction:    resolvedDirection,
      entryPrice:   +fillPrice,
      originalStop: entry.adjustedStop || entry.suggestedStop,
      stopPrice:    stop ? +stop : (entry.adjustedStop || entry.suggestedStop),
      maxGapPct:    entry.gapPct || 0,
      currentPrice: +fillPrice,
      isETF:        entry.isETF || false,
      sector:       resolvedSector,
      exchange,
      fills,
      status:       'ACTIVE',
      ownerId:      req.user.userId,
      createdAt:    new Date(),
      updatedAt:    new Date(),
      outcome:      { exitPrice: null, profitPct: null, profitDollar: null, holdingDays: null, exitReason: null },
      killScore:    entry.killScore  || null,
      killTier:     entry.killTier   || null,
      entryContext,
      signal,
      signalAge,
      fromQueue:    true,
    };

    await db.collection('pnthr_portfolio').insertOne(position);
    await db.collection('pnthr_pending_entries').updateOne(
      { id: req.params.id },
      { $set: { status: 'CONFIRMED', confirmedAt: new Date(), positionId: posId } }
    );

    let washWarning = null;

    // ── Create Journal Entry with all captured data ─────────────────────────
    try {
      const sectorAtEntry = resolvedSector && resolvedSector !== '—' ? {
        name:        resolvedSector,
        etfTicker:   getSectorEtf(resolvedSector),
        etfPrice:    marketAtEntry.sectorPrice    || null,
        etfChange1D: marketAtEntry.sectorChange1D || null,
      } : null;

      await createJournalEntry(db, position, req.user.userId, null, marketAtEntry, sectorAtEntry, {
        killScoreAtEntry,
        signal,
        signalAge,
        exchange,
        navAtEntry,
        marketAtEntry,
        analyzeScoreAtEntry,
        dataSource: killScoreAtEntry?.source || 'UNKNOWN',
      });
    } catch (e) {
      console.warn('[JOURNAL] Auto-create failed:', e.message);
    }

    // ── Async: fetch technical snapshot and update journal ──────────────────
    try {
      const techAtEntry = await fetchTechnicalSnapshot(position.ticker).catch(() => null);
      if (techAtEntry) {
        await db.collection('pnthr_journal').updateOne(
          { positionId: posId, ownerId: req.user.userId },
          { $set: { techAtEntry, isETF: position.isETF || false } }
        );
      }
    } catch (e) {
      console.warn('[PE] techAtEntry capture failed:', e.message);
    }

    // ── Wash sale check ─────────────────────────────────────────────────────
    try {
      const now = new Date();
      const activeWash = await db.collection('pnthr_journal').findOne({
        ticker:                position.ticker,
        ownerId:               req.user.userId,
        'washSale.isLoss':     true,
        'washSale.expiryDate': { $gt: now },
        'washSale.triggered':  false,
      });
      if (activeWash) {
        washWarning = {
          ticker:        position.ticker,
          lossAmount:    activeWash.washSale.lossAmount,
          exitDate:      activeWash.washSale.exitDate,
          expiryDate:    activeWash.washSale.expiryDate,
          daysRemaining: (() => {
            const expiryDay = new Date(new Date(activeWash.washSale.expiryDate).toISOString().split('T')[0] + 'T00:00:00.000Z');
            const todayDay  = new Date(now.toISOString().split('T')[0] + 'T00:00:00.000Z');
            return Math.max(0, Math.round((expiryDay - todayDay) / 86400000));
          })(),
        };
        await db.collection('pnthr_journal').updateOne(
          { _id: activeWash._id },
          { $set: { 'washSale.triggered': true, 'washSale.triggeredDate': now, 'washSale.triggeredEntryId': posId } }
        );
        await db.collection('pnthr_journal').updateOne(
          { positionId: posId, ownerId: req.user.userId },
          { $addToSet: { tags: 'wash-sale' } }
        );
      }
    } catch (e) { console.warn('[PE] Wash rule check failed:', e.message); }

    // ── Sector concentration check ──────────────────────────────────────────
    let sectorWarning = null;
    if (!position.isETF) {
      try {
        const existingPositions = await db.collection('pnthr_portfolio')
          .find({ ownerId: req.user.userId, status: { $in: ['ACTIVE', 'PARTIAL'] } })
          .toArray();
        const exposure = calculateSectorExposure(existingPositions);
        const thisSector = position.sector;
        const data = exposure[thisSector] || { longCount: 0, shortCount: 0, netExposure: 0 };
        if (data.netExposure > 3) {
          sectorWarning = {
            sector:           thisSector,
            currentExposure:  `${data.longCount}L/${data.shortCount}S (net ${data.netExposure})`,
            netExposure:      data.netExposure,
            level:            data.netExposure >= 4 ? 'CRITICAL' : 'WARNING',
            message:          `${thisSector} is now at net ${data.netExposure} ${data.netDirection}. Consider adding a ${position.direction === 'LONG' ? 'short' : 'long'} to balance.`,
          };
        }
      } catch (e) { console.warn('[PE] sector check failed:', e.message); }
    }

    res.json({ success: true, positionId: posId, washWarning, sectorWarning });
  } catch (err) {
    console.error('[PE] pendingEntryConfirm error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ── POST /api/pending-entries/:id/dismiss ─────────────────────────────────────

export async function pendingEntryDismiss(req, res) {
  try {
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });

    const result = await db.collection('pnthr_pending_entries').updateOne(
      { id: req.params.id, ownerId: req.user.userId },
      { $set: { status: 'DISMISSED', dismissedAt: new Date() } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Entry not found' });

    res.json({ success: true });
  } catch (err) {
    console.error('[PE] pendingEntryDismiss error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ── Create indexes for pnthr_pending_entries ──────────────────────────────────

export async function createPendingEntriesIndexes() {
  try {
    const db = await connectToDatabase();
    if (!db) return;
    const col = db.collection('pnthr_pending_entries');
    await col.createIndex({ ownerId: 1, status: 1 });
    await col.createIndex({ ticker: 1 });
    console.log('[PE] pnthr_pending_entries indexes ensured');
  } catch (err) {
    console.warn('[PE] Index creation warning:', err.message);
  }
}
