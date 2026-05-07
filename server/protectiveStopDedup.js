// server/protectiveStopDedup.js
// ── Duplicate-protective-stop dedup ─────────────────────────────────────────
//
// For tickers with an active PNTHR position, detects when TWS has MULTIPLE
// protective stops at the same price (within $0.01) — typically caused when
// Phase 3 auto-open placed a SELL/BUY STP without adopting an existing
// user-placed one at the same price, leaving two duplicates. The orphan
// janitor doesn't touch tickers with active positions, and the lotTriggerCron
// only dedupes on the BUY/SELL pyramid side, not the protective side. This
// pass closes that specific gap.
//
// Algorithm:
//   1. For each active PNTHR position, collect IBKR stops on the
//      protective-side (SELL for LONG, BUY for SHORT).
//   2. Group by stopPrice (rounded to 2 decimals).
//   3. For any group with >1 order at the same price: keep ONE, cancel the
//      rest. Preference order:
//        a. orderRef === 'PNTHR' (the bridge-placed one — system of record)
//        b. lowest permId (oldest — user's pre-existing stop if Phase 3
//           placed a duplicate later)
//      Keep one, cancel the others.
//
// Gated by IBKR_AUTO_SYNC_STOPS — same flag as stopRatchetCron — so admins
// can dry-run preview before flipping. Demo sentinel honored at enqueue.

import { connectToDatabase } from './database.js';
import { enqueue as enqueueOutbox, DEMO_OWNER_ID } from './ibkrOutbox.js';

const PRICE_GROUP_TOL = 0.01; // 1¢ — anything closer is "same price"

function protectiveSideFor(direction) {
  if ((direction || 'LONG').toUpperCase() === 'SHORT') return 'BUY';
  return 'SELL';
}

export async function runProtectiveStopDedup({ db, dryRun = false } = {}) {
  if (!db) db = await connectToDatabase();
  if (!db) return { error: 'NO_DB' };

  const flagOn = process.env.IBKR_AUTO_SYNC_STOPS === 'true';

  const positions = await db.collection('pnthr_portfolio').find({
    status:  { $in: ['ACTIVE', 'PARTIAL'] },
    ownerId: { $ne: DEMO_OWNER_ID },
  }).toArray();

  if (positions.length === 0) {
    return { reconciledAt: new Date(), dryRun, flagOn, deduped: [], skips: [] };
  }

  // Per-owner: load IBKR snapshot once.
  const ownerIds = [...new Set(positions.map(p => p.ownerId))];
  const ibkrByOwner = new Map();
  for (const oid of ownerIds) {
    const ibkr = await db.collection('pnthr_ibkr_positions').findOne({ ownerId: oid });
    ibkrByOwner.set(oid, ibkr || { stopOrders: [] });
  }

  const deduped = []; // { ticker, kept: {permId,price,orderRef}, cancelled: [{permId,...}] }
  const skips   = [];

  for (const p of positions) {
    const ticker = p.ticker?.toUpperCase();
    if (!ticker) continue;
    const protectiveSide = protectiveSideFor(p.direction);
    const snap = ibkrByOwner.get(p.ownerId);
    const tickerStops = (snap.stopOrders || []).filter(s =>
      s.symbol?.toUpperCase() === ticker
      && s.action === protectiveSide
      && (s.orderType === 'STP' || s.orderType === 'STP LMT')
    );
    if (tickerStops.length < 2) continue;

    // Group by rounded stopPrice
    const groups = new Map();
    for (const s of tickerStops) {
      const key = (+s.stopPrice).toFixed(2);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }

    for (const [priceKey, group] of groups) {
      if (group.length < 2) continue;

      const isUncancellableUserStop = (s) =>
        +s.orderId === 0 && (s.orderRef || '').trim().toUpperCase() !== 'PNTHR';
      const isPnthrTagged = (s) => (s.orderRef || '').trim().toUpperCase() === 'PNTHR';

      const userUncancellableStops = group.filter(isUncancellableUserStop);
      const pnthrTagged             = group.filter(isPnthrTagged);
      const others                  = group.filter(s => !isUncancellableUserStop(s) && !isPnthrTagged(s));

      // CASE A: pure runaway PNTHR gap stops — multiple PNTHR-tagged stops
      // at same price (DTCR 2026-05-07: 8 SELL STPs at $29.51 from buggy
      // gap-coverage that placed one every minute). Consolidate down to
      // ONE PNTHR-tagged stop covering whatever's still needed; cancel
      // the rest. Keep the LARGEST-share PNTHR stop so the position is
      // most fully covered after the dust settles. The next stopRatchetCron
      // tick will adjust shares if needed via gap-coverage place.
      // CASE B: user uncancellable stop + a single PNTHR gap stop —
      // intentional gap-coverage pattern. Skip dedup entirely.
      // CASE C: standard dedup — multiple stops, no uncancellable user
      // stop in the mix. Keep PNTHR-tagged (oldest by permId), else
      // oldest by permId outright.
      let keeper;
      let toCancel;
      if (userUncancellableStops.length > 0 && pnthrTagged.length === 1 && others.length === 0) {
        skips.push({ ticker, priceKey: +priceKey, reason: 'GAP_COVERAGE_INTENTIONAL_USER_STOP_UNCANCELLABLE' });
        continue;
      } else if (userUncancellableStops.length > 0 && pnthrTagged.length > 1) {
        // Keep the LARGEST PNTHR-tagged stop, cancel all OTHER PNTHR-tagged
        // stops. NEVER attempt to cancel the user uncancellable stop(s) —
        // bridge can't reach them and we'd just thrash the outbox.
        keeper = pnthrTagged.slice().sort((a, b) => Math.abs(+b.shares || 0) - Math.abs(+a.shares || 0))[0];
        toCancel = pnthrTagged.filter(s => s.permId !== keeper.permId);
      } else {
        // Standard: prefer PNTHR-tagged keeper, else lowest permId.
        keeper = pnthrTagged.length > 0
          ? pnthrTagged.slice().sort((a, b) => +a.permId - +b.permId)[0]
          : group.slice().sort((a, b) => +a.permId - +b.permId)[0];
        toCancel = group.filter(s => s.permId !== keeper.permId);
      }

      const cancellations = [];
      for (const s of toCancel) {
        const enqRes = !dryRun && flagOn
          ? await enqueueOutbox(db, p.ownerId, 'CANCEL_ORDER', {
              ticker,
              permId:    s.permId,
              direction: (p.direction || 'LONG').toUpperCase(),
              source:    'PROTECTIVE_STOP_DEDUP',
              reason:    'DUPLICATE_PROTECTIVE_STOP_SAME_PRICE',
              stopPrice: s.stopPrice,
              shares:    s.shares,
              action:    s.action,
            })
          : { skipped: dryRun ? 'DRY_RUN' : (flagOn ? 'UNKNOWN' : 'IBKR_AUTO_SYNC_STOPS_OFF') };
        cancellations.push({
          permId: s.permId, orderRef: s.orderRef, stopPrice: s.stopPrice, shares: s.shares,
          enqueued: !enqRes.skipped, outboxId: enqRes.id, skipReason: enqRes.skipped || null,
        });
      }

      deduped.push({
        ticker, ownerId: p.ownerId, priceKey: +priceKey,
        kept:        { permId: keeper.permId, orderRef: keeper.orderRef || null, shares: keeper.shares },
        cancelled:   cancellations,
        groupSize:   group.length,
      });
    }
  }

  return { reconciledAt: new Date(), dryRun, flagOn, deduped, skips };
}
