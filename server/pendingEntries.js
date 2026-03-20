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
      sector:       entry.isETF ? 'ETF' : (entry.sector || '—'),
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

    await db.collection('pnthr_portfolio').insertOne(position);
    await db.collection('pnthr_pending_entries').updateOne(
      { id: req.params.id },
      { $set: { status: 'CONFIRMED', confirmedAt: new Date(), positionId: posId } }
    );

    res.json({ success: true, positionId: posId });
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
