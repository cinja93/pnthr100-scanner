// server/protectiveStopDedup.js
// ── Duplicate-protective-stop dedup ─────────────────────────────────────────
//
// For tickers with an active PNTHR position, detects when TWS has MULTIPLE
// protective stops and reduces to exactly ONE canonical stop. Two passes:
//
// PASS 1 — same-price dedup: when multiple stops exist at the same price
//   (within $0.01), keep one and cancel the rest. Typically caused when
//   Phase 3 auto-open placed a SELL/BUY STP without adopting an existing
//   user-placed one at the same price.
//
// PASS 2 — cross-price dedup: after same-price dedup, if multiple stops
//   STILL exist at DIFFERENT prices, keep the TIGHTEST (highest SELL for
//   LONG, lowest BUY for SHORT) and cancel the rest. Prevents stale looser
//   stops from lingering after ratchets, manual tightening, or bridge
//   partial failures. Only cancels stops the bridge can reach (orderId !== 0
//   or PNTHR-tagged). User uncancellable stops (orderId=0, non-PNTHR) are
//   skipped with a logged reason.
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
    ibkrByOwner.set(oid, ibkr || { positions: [], stopOrders: [] });
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
        // User has an uncancellable orderId=0 stop + PNTHR placed exactly one
        // stop at the same price. TWO sub-cases:
        //
        //   A) User stop covers FEWER shares than the position → genuine gap
        //      coverage. Skip dedup (both stops fire together = full coverage).
        //
        //   B) User stop alone covers the FULL position → the PNTHR stop is
        //      a runaway duplicate (from the skipDedup bug in b2fb82b).
        //      Cancel the PNTHR stop. The user's orderId=0 stop is untouchable
        //      but already provides full protection.
        //
        // Without sub-case B, ADM (31+31 for 31-sh pos) and PSX (15+15 for
        // 15-sh pos) stay stuck with permanent duplicates that never clear.
        const snap = ibkrByOwner.get(p.ownerId);
        const ibkrPos = (snap.positions || []).find(x => x.symbol?.toUpperCase() === ticker);
        const posShares = ibkrPos ? Math.abs(+ibkrPos.shares || 0) : 0;
        const userStopShares = userUncancellableStops.reduce((s, st) => s + Math.abs(+st.shares || 0), 0);

        if (posShares > 0 && userStopShares >= posShares) {
          // Sub-case B: user stop already covers full position. PNTHR stop is redundant.
          keeper = userUncancellableStops[0];
          toCancel = pnthrTagged;
          // Fall through to cancellation loop below.
        } else {
          // Sub-case A: genuine gap coverage — skip dedup.
          skips.push({ ticker, priceKey: +priceKey, reason: 'GAP_COVERAGE_USER_PLUS_PNTHR_SAME_PRICE_SKIP', userShares: userStopShares, posShares });
          continue;
        }
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
        // Never attempt to cancel orderId=0 non-PNTHR stops — the bridge
        // can't reach them and we'd just thrash the outbox with failures.
        if (+s.orderId === 0 && (s.orderRef || '').trim().toUpperCase() !== 'PNTHR') {
          skips.push({ ticker, priceKey: +priceKey, permId: s.permId, reason: 'SAME_PRICE_CANCEL_SKIP_UNCANCELLABLE_USER_STOP' });
          continue;
        }
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

  // ── PASS 2: Cross-price dedup ────────────────────────────────────────────
  // After same-price dedup, re-scan each position. If >1 protective stop
  // remains at DIFFERENT prices, keep the TIGHTEST and cancel the rest.
  // A LONG position should have exactly one SELL stop; a SHORT exactly one
  // BUY stop. Multiple at different prices means a ratchet or adoption left
  // a stale looser stop behind.
  const crossPriceDeduped = [];

  for (const p of positions) {
    const ticker = p.ticker?.toUpperCase();
    if (!ticker) continue;
    const isLong = (p.direction || 'LONG').toUpperCase() !== 'SHORT';
    const protectiveSide = protectiveSideFor(p.direction);
    const snap = ibkrByOwner.get(p.ownerId);
    const tickerStops = (snap.stopOrders || []).filter(s =>
      s.symbol?.toUpperCase() === ticker
      && s.action === protectiveSide
      && (s.orderType === 'STP' || s.orderType === 'STP LMT')
    );

    // Subtract any stops already cancelled in pass 1 (by permId).
    const cancelledPermIds = new Set();
    for (const d of deduped) {
      if (d.ticker === ticker && d.ownerId === p.ownerId) {
        for (const c of d.cancelled) {
          if (c.enqueued || c.skipReason === 'DRY_RUN') cancelledPermIds.add(c.permId);
        }
      }
    }
    const remaining = tickerStops.filter(s => !cancelledPermIds.has(s.permId));
    if (remaining.length < 2) continue;

    // Pick the tightest as keeper (highest SELL for LONG, lowest BUY for SHORT).
    const sorted = remaining.slice().sort((a, b) =>
      isLong ? +b.stopPrice - +a.stopPrice : +a.stopPrice - +b.stopPrice
    );
    const keeper = sorted[0];
    const extras = sorted.slice(1);

    const cancellations = [];
    for (const s of extras) {
      const isUncancellable = +s.orderId === 0
        && (s.orderRef || '').trim().toUpperCase() !== 'PNTHR';
      if (isUncancellable) {
        skips.push({
          ticker, priceKey: +s.stopPrice,
          reason: 'CROSS_PRICE_USER_STOP_UNCANCELLABLE',
          permId: s.permId,
        });
        continue;
      }

      const enqRes = !dryRun && flagOn
        ? await enqueueOutbox(db, p.ownerId, 'CANCEL_ORDER', {
            ticker,
            permId:    s.permId,
            direction: (p.direction || 'LONG').toUpperCase(),
            source:    'PROTECTIVE_STOP_DEDUP',
            reason:    'STALE_PROTECTIVE_STOP_LOOSER_PRICE',
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

    if (cancellations.length > 0) {
      crossPriceDeduped.push({
        ticker, ownerId: p.ownerId,
        kept:       { permId: keeper.permId, orderRef: keeper.orderRef || null, stopPrice: +keeper.stopPrice, shares: keeper.shares },
        cancelled:  cancellations,
        stopsFound: remaining.length,
      });
    }
  }

  return { reconciledAt: new Date(), dryRun, flagOn, deduped, crossPriceDeduped, skips };
}
