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

    // Allow direction override at confirm time (e.g. user flips LONG → SHORT)
    const resolvedDirection = (direction === 'LONG' || direction === 'SHORT') ? direction : entry.direction;

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
      sector:       entry.isETF ? 'ETF' : normalizeSector(entry.sector || ''),
      fills,
      status:       'ACTIVE',
      ownerId:      req.user.userId,
      createdAt:    new Date(),
      updatedAt:    new Date(),
      outcome:      { exitPrice: null, profitPct: null, profitDollar: null, holdingDays: null, exitReason: null },
      // Preserve Kill metadata
      killScore:    entry.killScore  || null,
      killTier:     entry.killTier   || null,
      fromQueue:    true,
    };

    // ── Determine entryContext for discipline scoring ─────────────────────────
    // Set at confirm time and never changed — reflects what the trader knew at entry.
    {
      const signalData = entry.signal || entry.pnthrSignal;
      const signalAge  = entry.signalAge || entry.weeksSince || 0;
      if (signalData === 'BL' || signalData === 'SS') {
        position.entryContext = signalAge <= 1 ? 'CONFIRMED_SIGNAL' : 'STALE_SIGNAL';
      } else {
        // No confirmed signal — check developing signals cache (fast, no FMP)
        try {
          const devTickers = getDevelopingSignalTickers();
          position.entryContext = devTickers.has(position.ticker.toUpperCase())
            ? 'DEVELOPING_SIGNAL'
            : 'NO_SIGNAL';
        } catch (e) {
          console.warn('[ENTRY CONTEXT] developing check failed:', e.message);
          position.entryContext = 'NO_SIGNAL';
        }
      }
      console.log(`[CONFIRM ENTRY] ${position.ticker}: entryContext=${position.entryContext} signal=${signalData || 'none'}`);
    }

    // Guard: if sector is still blank/Unknown after normalization, fetch from FMP
    if (!position.isETF && (!position.sector || position.sector === 'Unknown' || position.sector === '—')) {
      try {
        const url = `${FMP_BASE}/api/v3/profile/${position.ticker}?apikey=${FMP_API_KEY}`;
        const profileRes = await fetch(url);
        const profile = await profileRes.json();
        const fetched = normalizeSector(profile?.[0]?.sector || '');
        position.sector = fetched || 'Unknown';
        console.log(`[pendingEntries] sector fallback for ${position.ticker}: "${fetched}"`);
      } catch (e) {
        console.warn(`[pendingEntries] sector FMP fallback failed for ${position.ticker}:`, e.message);
        position.sector = 'Unknown';
      }
    }

    await db.collection('pnthr_portfolio').insertOne(position);
    await db.collection('pnthr_pending_entries').updateOne(
      { id: req.params.id },
      { $set: { status: 'CONFIRMED', confirmedAt: new Date(), positionId: posId } }
    );

    let washWarning = null;

    // Auto-create journal entry for newly confirmed position.
    // Fetch market + sector snapshot at the moment of entry (best-effort).
    try {
      const killData = entry.killScore
        ? { totalScore: entry.killScore, tier: entry.killTier, killRank: entry.killRank || null }
        : null;
      let marketAtEntry = await fetchMarketSnapshot(position.sector || null).catch(() => ({}));

      // Fallback: if FMP snapshot has no SPY position data, use latest regime doc
      if (!marketAtEntry?.spyPosition) {
        console.warn(`[CONFIRM ENTRY] Live market snapshot incomplete for ${position.ticker}, trying regime fallback`);
        try {
          const regime = await db.collection('pnthr_kill_regime').findOne({}, { sort: { weekOf: -1 } });
          if (regime) {
            marketAtEntry = {
              ...marketAtEntry,
              spyPosition: regime.spyPosition || (regime.spyPrice > regime.spyEma21 ? 'above' : null) || null,
              qqqPosition: regime.qqqPosition || (regime.qqqPrice > regime.qqqEma21 ? 'above' : null) || null,
              regime:      regime.regime      || marketAtEntry?.regime || null,
              _source:     'regime_fallback',
            };
            console.log(`[CONFIRM ENTRY] Used regime fallback for market data: spy=${marketAtEntry.spyPosition}, qqq=${marketAtEntry.qqqPosition}`);
          }
        } catch (e) {
          console.error(`[CONFIRM ENTRY] Regime fallback failed:`, e.message);
        }
      }
      const sectorAtEntry = position.sector && position.sector !== '—' ? {
        name:        position.sector,
        etfTicker:   getSectorEtf(position.sector),
        etfPrice:    marketAtEntry.sectorPrice    || null,
        etfChange1D: marketAtEntry.sectorChange1D || null,
      } : null;
      await createJournalEntry(db, position, req.user.userId, killData, marketAtEntry, sectorAtEntry);
    } catch (e) { console.warn('[JOURNAL] Auto-create failed:', e.message); }

    // Capture navAtEntry + isETF + technicals at entry (best-effort).
    try {
      const userProfile = await getUserProfile(req.user.userId);
      const techAtEntry = await fetchTechnicalSnapshot(position.ticker).catch(() => null);
      await db.collection('pnthr_journal').updateOne(
        { positionId: posId, ownerId: req.user.userId },
        { $set: {
            navAtEntry:  userProfile?.accountSize ?? null,
            isETF:       position.isETF || false,
            ...(techAtEntry ? { techAtEntry } : {}),
        }}
      );
    } catch (e) { console.warn('[PE] navAtEntry/tech capture failed:', e.message); }

    // Capture kill score context + exchange from pnthr_kill_scores (best-effort).
    try {
      const killScoreDoc = await db.collection('pnthr_kill_scores').findOne(
        { ticker: position.ticker },
        { sort: { createdAt: -1 } }
      );
      if (killScoreDoc) {
        let pipelineMaxScore = null;
        if (killScoreDoc.weekOf) {
          const maxDocs = await db.collection('pnthr_kill_scores')
            .find({ weekOf: killScoreDoc.weekOf })
            .sort({ totalScore: -1 }).limit(1).toArray();
          pipelineMaxScore = maxDocs[0]?.totalScore ?? null;
        }
        const killScoreAtEntry = {
          totalScore:      killScoreDoc.totalScore      ?? null,
          pipelineMaxScore,
          rank:            killScoreDoc.killRank         ?? null,
          rankChange:      null,
          tier:            killScoreDoc.tier             ?? null,
          signal:          killScoreDoc.signal           ?? null,
          signalAge:       killScoreDoc.signalAge        ?? null,
          d1:              killScoreDoc.preMultiplier    ?? null,
          dimensions:      killScoreDoc.scoreDetail      ?? null,
          weekOf:          killScoreDoc.weekOf           ?? null,
        };
        const updateFields = { killScoreAtEntry };
        if (killScoreDoc.exchange) updateFields.exchange = killScoreDoc.exchange;

        // Also set top-level signal + signalAge if not already captured from queue entry
        const journalSignal    = entry.signal    || entry.pnthrSignal    || killScoreDoc.signal    || null;
        const journalSignalAge = entry.signalAge ?? entry.weeksSince ?? killScoreDoc.signalAge ?? null;
        if (journalSignal)             updateFields.signal    = journalSignal;
        if (journalSignalAge != null)  updateFields.signalAge = journalSignalAge;
        if (journalSignal && journalSignalAge != null) {
          const ctx = journalSignalAge <= 1 ? 'CONFIRMED_SIGNAL' : 'STALE_SIGNAL';
          updateFields.entryContext = ctx;
        }

        await db.collection('pnthr_journal').updateOne(
          { positionId: posId, ownerId: req.user.userId },
          { $set: updateFields }
        );
      }
    } catch (e) { console.warn('[PE] Kill score capture failed:', e.message); }

    // ── Persist analyzeScore snapshot from queue entry ────────────────────────
    // When the user ran ANALYZE before queuing, we receive a pre-trade snapshot.
    // Store it on the journal entry + use it to backfill missing signal/exchange data.
    try {
      if (entry.analyzeScore && typeof entry.analyzeScore === 'object') {
        const as = entry.analyzeScore;
        const analyzeUpdate = {
          analyzeScoreAtEntry: {
            score:       as.score       ?? null,
            max:         as.max         ?? 53,
            pct:         as.pct         ?? null,
            projected:   as.projected   ?? null,
            composite:   as.composite   ?? null,
            warnings:    as.warnings    ?? [],
            direction:   as.direction   ?? null,
            computedAt:  as.computedAt  ?? new Date(),
          },
        };
        // Backfill signal if not yet set from kill score capture
        if (!entry.signal && as.direction) {
          analyzeUpdate.direction = as.direction;
        }
        await db.collection('pnthr_journal').updateOne(
          { positionId: posId, ownerId: req.user.userId },
          { $set: analyzeUpdate }
        );
      }
    } catch (e) { console.warn('[PE] analyzeScore capture failed:', e.message); }

    // Check for active wash sale rule — mark triggered if re-entering during window.
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
        // Tag the new journal entry so it surfaces in the Journal wash filters
        await db.collection('pnthr_journal').updateOne(
          { positionId: posId, ownerId: req.user.userId },
          { $addToSet: { tags: 'wash-sale' } }
        );
      }
    } catch (e) { console.warn('[PE] Wash rule check failed:', e.message); }

    // Check sector concentration AFTER saving — warn but don't block.
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
