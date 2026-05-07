// server/positionReconciler.js
// ── Auto-reconciler — keeps PNTHR fills/exits aligned with IBKR every minute ─
//
// For every ACTIVE / PARTIAL non-demo PNTHR position, compares the canonical
// pnthrNet (sum(fills) - sum(exits)) to ibkrShares. When they differ:
//
//   1. CASE A — drift > 0 (PNTHR has MORE than IBKR):
//      An exit happened in TWS that PNTHR didn't catch. Try to find an
//      unprocessed SLD (LONG) / BOT (SHORT) execution that explains the
//      drift; route through the canonical recordExit so journal +
//      discipline + wash all stay in sync. If no execution can explain it
//      (bridge dropped it, sub-fill aggregation issue, etc.), write a
//      synthetic exit at IBKR's marketPrice tagged AUTO_RECONCILE_NO_EXEC
//      so PNTHR matches reality and the audit trail flags the manual review.
//
//   2. CASE B — drift < 0 (PNTHR has FEWER than IBKR):
//      An add happened in TWS that PNTHR didn't catch (manual market buy,
//      partial lot fill outside tolerance, etc.). Try unprocessed BOT/SLD
//      first via recordLotFill. If no match, append a synthetic fill[next]
//      with shares + IBKR-implied price so totalFilledShares matches IBKR.
//
// Safety guards:
//   • Skip when bridge sync staleness > 5 min (stale data is dangerous)
//   • Skip when |drift| > 50% of max(pnthrNet, ibkrShares) — bounded to
//     prevent catastrophic mass-correction from a single bad sync
//   • Skip CLOSED positions (historical records stay immutable)
//   • Skip when ibkrShares is 0 (caller should route through ghostReconciler
//     full-close path instead — that handles stop cancellation too)
//   • Always log every action to pnthr_reconciliation_log for audit
//
// Demo sentinel: pulled at the query level + each enqueue inside recordExit
// also rejects demo. Belt and suspenders.

import { connectToDatabase } from './database.js';
import { DEMO_OWNER_ID } from './ibkrOutbox.js';
import { recordExit } from './exitService.js';

const SYNC_STALENESS_MS    = 5 * 60 * 1000; // 5 min
const MAX_DRIFT_FRACTION   = 0.50;          // refuse auto-correction beyond 50% drift
const MIN_DRIFT_TO_ACT_SH  = 1;             // ignore sub-share rounding noise

// ── Recompute share totals from fills + exits ──────────────────────────────
// Mirrors the sum-of-fills authority used elsewhere (assistantLiveReconcile,
// exitService). The single source of truth for "how many shares does PNTHR
// think this position holds right now."
function computeTotals(position) {
  const fills = position?.fills || {};
  const exits = position?.exits || [];
  const sumFilled = Object.values(fills).reduce((s, f) => s + (f?.filled ? +f.shares || 0 : 0), 0);
  const sumExited = exits.reduce((s, e) => s + (+e.shares || 0), 0);
  return { sumFilled, sumExited, net: sumFilled - sumExited };
}

// ── Try to find unprocessed executions that explain the drift ──────────────
// Returns { unprocessed: [...], totalShares } where unprocessed is filtered to
// the right side and unprocessed-as-yet (not in pnthr_ibkr_executions or
// only marked DRY_RUN). Up to the caller to decide whether the cumulative
// shares match the drift before routing through canonical recorders.
async function findUnprocessedExecs(db, ownerId, ticker, expectedSide, allExecs) {
  if (!Array.isArray(allExecs) || allExecs.length === 0) return [];
  const tickerExecs = allExecs.filter(e =>
    (e.symbol?.toUpperCase() === ticker) && e.side === expectedSide,
  );
  if (tickerExecs.length === 0) return [];
  const execIds = tickerExecs.map(e => e.execId).filter(Boolean);
  if (execIds.length === 0) return [];
  const processed = await db.collection('pnthr_ibkr_executions').find({
    ownerId,
    execId: { $in: execIds },
    type:   { $ne: 'AUTO_RECORD_LOT_FILL_DRY_RUN' },
  }).project({ execId: 1 }).toArray();
  const processedIds = new Set(processed.map(d => d.execId));
  return tickerExecs.filter(e => !processedIds.has(e.execId));
}

// ── Append a synthetic exit at IBKR-truth price ────────────────────────────
// Used when drift > 0 and no unprocessed SLD execution explains it. Routes
// through the canonical recordExit so journal/discipline/wash stay correct.
// Tagged with reason AUTO_RECONCILE_NO_EXEC so the audit trail flags it.
async function recordSyntheticExit({ db, position, ownerId, shares, ibkrMarketPrice, log }) {
  const date = new Date().toISOString().split('T')[0];
  try {
    const result = await recordExit(db, position.id, ownerId, {
      shares,
      price: +(ibkrMarketPrice || 0).toFixed(2),
      date,
      reason: 'AUTO_RECONCILE_NO_EXEC',
      note:   `Auto-reconciler closed ${shares} sh — PNTHR had ${shares} sh more than IBKR with no matching SLD execution. Price set to IBKR market price at reconcile time.`,
    });
    log.push({ kind: 'SYNTHETIC_EXIT', positionId: position.id, ticker: position.ticker, shares, price: ibkrMarketPrice, ok: true, exitId: result?.exitRecord?.id });
    return true;
  } catch (e) {
    log.push({ kind: 'SYNTHETIC_EXIT', positionId: position.id, ticker: position.ticker, shares, price: ibkrMarketPrice, ok: false, error: e.message });
    return false;
  }
}

// ── Append a synthetic fill[next] when PNTHR has fewer than IBKR ───────────
// Used when drift < 0 and no unprocessed BOT execution explains it. Computes
// the implied price by backing out the volume-weighted balance against IBKR's
// avgCost so totalFilledShares × computed avg = IBKR's notional.
async function appendSyntheticFill({ db, position, ownerId, shares, ibkrMarketPrice, ibkrAvgCost, log }) {
  // Pick the next unfilled lot slot; fall back to a numbered "ADHOC" slot if
  // L2-L5 are all already filled (rare — would mean IBKR has more than the
  // pyramid plan accounted for).
  const fills = position.fills || {};
  let targetSlot = null;
  for (let n = 2; n <= 5; n++) {
    if (!fills[n]?.filled) { targetSlot = n; break; }
  }
  // If all numbered lots filled, use a string key for the synthetic add.
  // The badge math still includes it (sum-of-fills iterates Object.values).
  if (targetSlot == null) {
    targetSlot = 'ADHOC_' + Date.now().toString(36);
  }

  // Implied price: prefer the plain market price at reconcile time. Backing
  // out from avgCost is fragile when partial sells have happened (the avg is
  // a moving target). Market price is honest — "this is what shares cost
  // right now" — and the audit trail records the source.
  const fillPrice = +(ibkrMarketPrice || ibkrAvgCost || 0).toFixed(2);
  const date = new Date().toISOString().split('T')[0];

  const newFill = {
    filled: true,
    shares,
    price:  fillPrice,
    date,
    source: 'AUTO_RECONCILE_NO_EXEC',
  };

  const projectedFills = { ...fills, [targetSlot]: newFill };
  const projectedFilled = Object.values(projectedFills).reduce(
    (s, f) => s + (f?.filled ? +f.shares || 0 : 0), 0,
  );
  const projectedExited = (position.exits || []).reduce((s, e) => s + (+e.shares || 0), 0);
  const projectedRemaining = projectedFilled - projectedExited;

  try {
    const writeRes = await db.collection('pnthr_portfolio').updateOne(
      { id: position.id, ownerId },
      { $set: {
          [`fills.${targetSlot}`]: newFill,
          totalFilledShares: projectedFilled,
          remainingShares:   projectedRemaining,
          updatedAt:         new Date(),
        },
      }
    );
    log.push({ kind: 'SYNTHETIC_FILL', positionId: position.id, ticker: position.ticker, slot: targetSlot, shares, price: fillPrice, ok: writeRes.matchedCount > 0 });
    return writeRes.matchedCount > 0;
  } catch (e) {
    log.push({ kind: 'SYNTHETIC_FILL', positionId: position.id, ticker: position.ticker, slot: targetSlot, shares, price: fillPrice, ok: false, error: e.message });
    return false;
  }
}

// ── Main runner ───────────────────────────────────────────────────────────
export async function runPositionReconciler({ db, dryRun = false } = {}) {
  if (!db) db = await connectToDatabase();
  if (!db) return { error: 'NO_DB' };

  const positions = await db.collection('pnthr_portfolio').find({
    status:  { $in: ['ACTIVE', 'PARTIAL'] },
    ownerId: { $ne: DEMO_OWNER_ID },
  }).toArray();
  if (positions.length === 0) {
    return { reconciledAt: new Date(), positionsChecked: 0, actions: [], skips: [], aligned: [] };
  }

  // Per-owner: load IBKR snapshot once.
  const ownerIds = [...new Set(positions.map(p => p.ownerId))];
  const ibkrByOwner = new Map();
  for (const oid of ownerIds) {
    const ibkr = await db.collection('pnthr_ibkr_positions').findOne({ ownerId: oid });
    ibkrByOwner.set(oid, ibkr || { positions: [], stopOrders: [], latestExecutions: [] });
  }

  const actions = [];
  const skips   = [];
  const aligned = [];

  for (const p of positions) {
    const ticker = p.ticker?.toUpperCase();
    if (!ticker) { skips.push({ ticker: p.ticker, reason: 'NO_TICKER' }); continue; }

    const snap   = ibkrByOwner.get(p.ownerId);
    const syncedAt = snap?.syncedAt ? new Date(snap.syncedAt) : null;
    const ageMs  = syncedAt ? (Date.now() - syncedAt.getTime()) : Infinity;
    if (ageMs > SYNC_STALENESS_MS) {
      skips.push({ ticker, reason: 'BRIDGE_SYNC_STALE', ageMs });
      continue;
    }

    const ibkrPos = (snap.positions || []).find(x => x.symbol?.toUpperCase() === ticker);
    const ibkrShares = ibkrPos ? Math.abs(+ibkrPos.shares || 0) : 0;
    if (ibkrShares === 0) {
      // Full-close — let ghostReconciler own this path so stop cancellation +
      // discrepancy banner clearing fires together.
      skips.push({ ticker, reason: 'IBKR_ZERO_SHARES_USE_GHOST_RECONCILER' });
      continue;
    }

    const { sumFilled, sumExited, net: pnthrNet } = computeTotals(p);
    const drift = pnthrNet - ibkrShares;
    if (Math.abs(drift) < MIN_DRIFT_TO_ACT_SH) {
      aligned.push({ ticker, pnthrNet, ibkrShares });
      continue;
    }

    const isLong = (p.direction || 'LONG').toUpperCase() !== 'SHORT';

    // 50%-drift safety guard — refuse mass-correction from a single bad sync.
    // EXCEPTION: when there are unprocessed IBKR executions in latestExecutions
    // that explain the drift exactly (within ±1 sh rounding), the drift is
    // backed by concrete execution data, not a sync glitch. Allow the
    // correction in that case — it's the exact scenario the reconciler was
    // built for (catch up missed fills/exits).
    const denom = Math.max(pnthrNet, ibkrShares, 1);
    if (Math.abs(drift) / denom > MAX_DRIFT_FRACTION) {
      const expectedSideForDrift = drift > 0
        ? (isLong ? 'SLD' : 'BOT')
        : (isLong ? 'BOT' : 'SLD');
      const unprocPreview = await findUnprocessedExecs(db, p.ownerId, ticker, expectedSideForDrift, snap.latestExecutions);
      const matchPreview  = unprocPreview.reduce((s, e) => s + (+e.shares || 0), 0);
      const want          = Math.abs(drift);
      const execsExplain  = unprocPreview.length > 0 && matchPreview >= want && matchPreview <= want + 1;
      if (!execsExplain) {
        skips.push({ ticker, reason: 'DRIFT_EXCEEDS_50PCT_MANUAL_REVIEW', pnthrNet, ibkrShares, drift, unprocessedExecs: unprocPreview.length });
        continue;
      }
      // Fall through with execs to handle in CASE A/B below.
    }

    if (drift > 0) {
      // CASE A — PNTHR has more than IBKR; an exit slipped through.
      const expectedSide = isLong ? 'SLD' : 'BOT';
      const unprocessed  = await findUnprocessedExecs(db, p.ownerId, ticker, expectedSide, snap.latestExecutions);
      const matchedShares = unprocessed.reduce((s, e) => s + (+e.shares || 0), 0);

      if (unprocessed.length > 0 && matchedShares >= drift && matchedShares <= drift + 1) {
        // Found exec(s) that explain the drift. Route through recordExit but
        // cap total exited shares to exactly the drift — never overshoot.
        if (dryRun) {
          actions.push({ ticker, kind: 'WOULD_RECORD_EXIT_FROM_EXEC', drift, execIds: unprocessed.map(e => e.execId) });
        } else {
          let exitedSoFar = 0;
          for (const e of unprocessed) {
            const sharesNeeded = drift - exitedSoFar;
            if (sharesNeeded <= 0) break;
            const sharesToExit = Math.min(+e.shares, sharesNeeded);
            try {
              await recordExit(db, p.id, p.ownerId, {
                shares: sharesToExit,
                price:  +e.price,
                date:   new Date().toISOString().split('T')[0],
                reason: 'AUTO_RECONCILE_FROM_EXEC',
                note:   `Reconciler matched IBKR exec ${e.execId} (${sharesToExit} sh @ $${e.price}) to drift fix.`,
              });
              await db.collection('pnthr_ibkr_executions').updateOne(
                { ownerId: p.ownerId, execId: e.execId },
                { $set: { ownerId: p.ownerId, execId: e.execId, symbol: ticker, side: e.side, shares: e.shares, price: e.price, type: 'AUTO_RECONCILE_FROM_EXEC', processedAt: new Date() } },
                { upsert: true },
              );
              exitedSoFar += sharesToExit;
              actions.push({ ticker, kind: 'RECORD_EXIT_FROM_EXEC', execId: e.execId, shares: sharesToExit, price: e.price });
            } catch (err) {
              actions.push({ ticker, kind: 'RECORD_EXIT_FROM_EXEC_FAILED', execId: e.execId, error: err.message });
            }
          }
        }
      } else {
        // No matching exec(s). Synthesise an exit at IBKR market price so
        // PNTHR matches reality. Tagged AUTO_RECONCILE_NO_EXEC for audit.
        if (dryRun) {
          actions.push({ ticker, kind: 'WOULD_SYNTHETIC_EXIT', drift, ibkrMarketPrice: ibkrPos?.marketPrice });
        } else {
          await recordSyntheticExit({
            db, position: p, ownerId: p.ownerId,
            shares: drift,
            ibkrMarketPrice: +ibkrPos?.marketPrice || +ibkrPos?.avgCost || 0,
            log: actions,
          });
        }
      }
    } else {
      // CASE B — PNTHR has fewer than IBKR; an add slipped through.
      const want         = -drift;
      const expectedSide = isLong ? 'BOT' : 'SLD';
      const unprocessed  = await findUnprocessedExecs(db, p.ownerId, ticker, expectedSide, snap.latestExecutions);
      const matchedShares = unprocessed.reduce((s, e) => s + (+e.shares || 0), 0);

      if (unprocessed.length > 0 && matchedShares >= want && matchedShares <= want + 1) {
        // Append unprocessed BOT execs as additional fills. Cap total added
        // shares to exactly the drift — never overshoot.
        if (dryRun) {
          actions.push({ ticker, kind: 'WOULD_APPEND_FROM_EXEC', want, execIds: unprocessed.map(e => e.execId) });
        } else {
          let addedSoFar = 0;
          for (const e of unprocessed) {
            const sharesNeeded = want - addedSoFar;
            if (sharesNeeded <= 0) break;
            const sharesToAdd = Math.min(+e.shares, sharesNeeded);
            await appendSyntheticFill({
              db, position: p, ownerId: p.ownerId,
              shares: sharesToAdd,
              ibkrMarketPrice: +e.price,
              ibkrAvgCost: +ibkrPos?.avgCost || 0,
              log: actions,
            });
            await db.collection('pnthr_ibkr_executions').updateOne(
              { ownerId: p.ownerId, execId: e.execId },
              { $set: { ownerId: p.ownerId, execId: e.execId, symbol: ticker, side: e.side, shares: e.shares, price: e.price, type: 'AUTO_RECONCILE_APPEND_EXEC', processedAt: new Date() } },
              { upsert: true },
            );
            addedSoFar += sharesToAdd;
            // Refresh position so the next iteration sees updated fills
            const fresh = await db.collection('pnthr_portfolio').findOne({ id: p.id, ownerId: p.ownerId });
            if (fresh) Object.assign(p, fresh);
          }
        }
      } else {
        // No matching exec. Synthesise a fill at IBKR market price.
        if (dryRun) {
          actions.push({ ticker, kind: 'WOULD_SYNTHETIC_FILL', want, ibkrMarketPrice: ibkrPos?.marketPrice });
        } else {
          await appendSyntheticFill({
            db, position: p, ownerId: p.ownerId,
            shares: want,
            ibkrMarketPrice: +ibkrPos?.marketPrice || +ibkrPos?.avgCost || 0,
            ibkrAvgCost: +ibkrPos?.avgCost || 0,
            log: actions,
          });
        }
      }
    }
  }

  // Persist a single audit entry per run so we can review weeks later.
  if (!dryRun && (actions.length > 0 || skips.some(s => s.reason !== 'BRIDGE_SYNC_STALE'))) {
    try {
      await db.collection('pnthr_reconciliation_log').insertOne({
        runAt:            new Date(),
        positionsChecked: positions.length,
        actions,
        skips,
        alignedCount:     aligned.length,
      });
    } catch { /* non-fatal — audit log is advisory */ }
  }

  return {
    reconciledAt: new Date(),
    positionsChecked: positions.length,
    dryRun,
    actions,
    skips,
    aligned,
  };
}
