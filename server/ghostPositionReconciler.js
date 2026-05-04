// server/ghostPositionReconciler.js
// ── Ghost-position reconciler (runs inside the every-minute reconciliation) ──
//
// Closes the gap exposed by ADI on 2026-05-04: PNTHR's portfolio said ACTIVE
// (4 shares with a stop at $394.65) while IBKR's snapshot said zero shares.
// Because PNTHR never knew the position closed, recordExit() never fired,
// Phase 4b CANCEL_RELATED_ORDERS never ran, and four BUY STP lot triggers
// were left orphaned in TWS — a phantom-position waiting to happen.
//
// Why didn't auto-close (Phase 2 in ibkrSync) catch it? Phase 2 only acts on
// new TWS *execution* events. If the close happened with the bridge offline,
// before Phase 2 was active, or the execution was simply missed, the position
// silently desyncs. This reconciler is the safety net for that path.
//
// LOGIC:
//   1. Walk every ACTIVE/PARTIAL non-demo position.
//   2. Look up the ticker in the latest IBKR snapshot.
//      • If IBKR shows shares > 0 → clear ghostStartedAt (no-op).
//      • If IBKR shows shares == 0 (or ticker absent) → either set
//        ghostStartedAt=now (first observation) or, if the streak has
//        exceeded GHOST_THRESHOLD_MS, call recordExit() and close it.
//   3. The exit auto-fires Phase 4b CANCEL_RELATED_ORDERS via exitService,
//      which (with the bridge's idempotent cancel + the orphan janitor's
//      whitelist) cleans up any pre-staged lot triggers without further
//      manual intervention.
//
// SAFETY:
//   • Gated by IBKR_AUTO_CLOSE_GHOSTS env var (default off). When off,
//     reports what WOULD be closed but doesn't actually call recordExit.
//   • Demo sentinel honored at the position-set query.
//   • Persistence threshold defaults to 5 minutes (GHOST_THRESHOLD_MS).
//     Tunable via GHOST_THRESHOLD_MS env var if 5 min is too aggressive.
//   • Refuses to act if the IBKR snapshot itself is stale (>10 minutes since
//     last sync) — bridge offline means absence-of-evidence, not evidence-
//     of-absence.
//   • Exit reason tagged 'GHOST_RECONCILE' so journal/discipline scoring
//     can treat it as a system-reconciliation close, not a manual close.
//   • Exit price defaults to last known protective stop (most likely cause
//     of an unrecorded close was a stop hit). Marked exitPriceEstimated=true
//     so the trader knows to verify and correct in the journal.

import { connectToDatabase } from './database.js';
import { recordExit } from './exitService.js';
import { DEMO_OWNER_ID } from './ibkrOutbox.js';

const GHOST_THRESHOLD_MS  = Number(process.env.GHOST_THRESHOLD_MS) || 5 * 60 * 1000; // 5 min default
const STALE_SNAPSHOT_MS   = 10 * 60 * 1000; // 10 min — older than this and we don't trust IBKR data

export async function runGhostReconcile({ db, dryRun = false } = {}) {
  if (!db) db = await connectToDatabase();
  if (!db) return { error: 'NO_DB' };

  const flagOn = process.env.IBKR_AUTO_CLOSE_GHOSTS === 'true';
  const now    = Date.now();

  const positions = await db.collection('pnthr_portfolio').find({
    status:  { $in: ['ACTIVE', 'PARTIAL'] },
    ownerId: { $ne: DEMO_OWNER_ID },
  }).toArray();

  if (positions.length === 0) {
    return {
      reconciledAt: new Date(),
      flagOn,
      threshold: GHOST_THRESHOLD_MS,
      checked: 0,
      observed: [],
      closed:   [],
      cleared:  [],
      skips:    [],
    };
  }

  const ownerIds = [...new Set(positions.map(p => p.ownerId))];
  const ibkrByOwner = new Map();
  for (const oid of ownerIds) {
    const ibkr = await db.collection('pnthr_ibkr_positions').findOne({ ownerId: oid });
    ibkrByOwner.set(oid, ibkr);
  }

  const observed = []; // first-observed-zero this tick (ghost timer started)
  const closed   = []; // actually closed (or would-have-been when dryRun/flagOff)
  const cleared  = []; // were marked ghost, IBKR now shows shares — false alarm cleared
  const skips    = []; // could not reconcile (no snapshot, stale snapshot, bad data)

  for (const p of positions) {
    const ticker = (p.ticker || '').toUpperCase();
    if (!ticker) { skips.push({ id: p.id, reason: 'NO_TICKER' }); continue; }

    const snap = ibkrByOwner.get(p.ownerId);
    if (!snap) { skips.push({ ticker, reason: 'NO_IBKR_SNAPSHOT' }); continue; }

    const syncedAt = new Date(snap.syncedAt || snap.updatedAt || 0).getTime();
    if (!syncedAt || (now - syncedAt) > STALE_SNAPSHOT_MS) {
      skips.push({ ticker, reason: 'IBKR_SNAPSHOT_STALE', ageMs: now - syncedAt });
      continue;
    }

    const ibkrPos = (snap.positions || []).find(x => (x.symbol || '').toUpperCase() === ticker);
    const ibkrShares = ibkrPos ? Math.abs(+ibkrPos.shares || 0) : 0;

    // CASE 1: IBKR confirms position exists. If we previously flagged it as
    // a ghost (timer started), clear the flag — false alarm.
    if (ibkrShares > 0) {
      if (p.ghostStartedAt) {
        if (!dryRun) {
          await db.collection('pnthr_portfolio').updateOne(
            { id: p.id, ownerId: p.ownerId },
            { $unset: { ghostStartedAt: '' } }
          );
        }
        cleared.push({ ticker, ownerId: p.ownerId, prevGhostStartedAt: p.ghostStartedAt });
      }
      continue;
    }

    // CASE 2: IBKR shows zero shares. Either start the streak or close.
    const ghostStartedAt = p.ghostStartedAt ? new Date(p.ghostStartedAt).getTime() : null;

    if (!ghostStartedAt) {
      // First observation. Stamp the timestamp. Will re-evaluate next tick.
      if (!dryRun) {
        await db.collection('pnthr_portfolio').updateOne(
          { id: p.id, ownerId: p.ownerId },
          { $set: { ghostStartedAt: new Date() } }
        );
      }
      observed.push({ ticker, ownerId: p.ownerId, id: p.id });
      continue;
    }

    const ageMs = now - ghostStartedAt;
    if (ageMs < GHOST_THRESHOLD_MS) {
      // Streak in progress, not yet long enough to act.
      observed.push({
        ticker, ownerId: p.ownerId, id: p.id,
        ageMs, threshold: GHOST_THRESHOLD_MS, willCloseInMs: GHOST_THRESHOLD_MS - ageMs,
      });
      continue;
    }

    // CASE 3: streak exceeded threshold → close.
    // Best-estimate exit price: the protective stop (most likely cause of an
    // unrecorded close is a stop hit). The trader can correct in the journal.
    const exitPrice = +p.stopPrice || +p.currentPrice || +p.entryPrice || 0;
    if (exitPrice <= 0) {
      skips.push({ ticker, reason: 'NO_VALID_EXIT_PRICE_AVAILABLE' });
      continue;
    }

    // Calculate how many shares to exit — whatever is currently outstanding.
    const totalFilled  = Object.values(p.fills || {}).reduce(
      (s, f) => s + (f && f.filled ? (f.shares || 0) : 0), 0);
    const alreadyExited = (p.exits || []).reduce((s, e) => s + (e.shares || 0), 0);
    const remaining     = totalFilled - alreadyExited;

    if (remaining <= 0) {
      // PNTHR's books actually show no remaining shares — the position is
      // mid-update or in a weird state. Clear ghost flag, don't close.
      if (!dryRun) {
        await db.collection('pnthr_portfolio').updateOne(
          { id: p.id, ownerId: p.ownerId },
          { $unset: { ghostStartedAt: '' } }
        );
      }
      skips.push({ ticker, reason: 'PNTHR_REMAINING_ZERO_BUT_NOT_CLOSED' });
      continue;
    }

    if (!flagOn || dryRun) {
      // Observe-only path — preview what WOULD be closed, don't actually do it.
      closed.push({
        ticker, ownerId: p.ownerId, id: p.id,
        wouldClose: { shares: remaining, price: exitPrice, ageMs },
        skipReason: dryRun ? 'DRY_RUN' : 'IBKR_AUTO_CLOSE_GHOSTS_OFF',
      });
      continue;
    }

    // Live path — call canonical recordExit(). This in turn fires Phase 4b
    // CANCEL_RELATED_ORDERS, which (with the idempotent cancel) cleans up
    // any pre-staged lot triggers without further intervention.
    try {
      const today = new Date().toISOString().slice(0, 10);
      const exitData = {
        shares: remaining,
        price:  exitPrice,
        date:   today,
        time:   new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        reason: 'GHOST_RECONCILE',
        note:   `Auto-closed by ghost reconciler — IBKR reported 0 shares for ${Math.round(ageMs/60000)} min. Exit price is the last known protective stop ($${exitPrice}) and is an ESTIMATE — verify in journal.`,
      };
      const result = await recordExit(db, p.id, p.ownerId, exitData);
      // Mark the exit price as estimated so the journal/UI can flag it.
      await db.collection('pnthr_portfolio').updateOne(
        { id: p.id, ownerId: p.ownerId },
        { $set: { 'exits.$[lastExit].exitPriceEstimated': true } },
        { arrayFilters: [{ 'lastExit.reason': 'GHOST_RECONCILE' }] }
      );
      closed.push({
        ticker, ownerId: p.ownerId, id: p.id,
        closed: { shares: remaining, price: exitPrice, ageMs, exitId: result?.exitRecord?.id },
      });
    } catch (e) {
      skips.push({ ticker, reason: 'RECORD_EXIT_THREW', error: e.message });
    }
  }

  return {
    reconciledAt: new Date(),
    flagOn,
    threshold: GHOST_THRESHOLD_MS,
    checked:   positions.length,
    observed,
    closed,
    cleared,
    skips,
  };
}
