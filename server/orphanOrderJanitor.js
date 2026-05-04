// server/orphanOrderJanitor.js
// ── Orphan-order janitor (runs inside the every-minute reconciliation cron) ──
//
// Closes the gap that left XYZ with three live BUY STP lot triggers in TWS
// after its protective stop hit on 2026-05-04. Phase 4b's CANCEL_RELATED_ORDERS
// is fire-once at exit time — if it fails (e.g., bridge cache stale, partial
// PERMID_NOT_FOUND), nothing else cleans up. The lotTriggerCron only walks
// ACTIVE/PARTIAL positions, so closed-position orphans are invisible to it.
//
// This janitor runs every minute and does ONE thing: for every TWS STP/STP LMT
// order whose ticker has NO matching ACTIVE/PARTIAL position in PNTHR for that
// owner, enqueue a CANCEL_ORDER. Idempotent — if the order is already gone,
// the bridge's PERMID_NOT_FOUND→ALREADY_GONE path makes the cancel a no-op.
//
// Safety:
//   • Demo sentinel honored at the position-set query AND inside enqueueOutbox.
//   • Gated by IBKR_AUTO_CANCEL_ORPHANS (default off). When off the janitor
//     still scans + reports so an admin can preview what WOULD be cancelled.
//   • Per-owner scoping — never reaches across users.
//   • Never cancels an order whose ticker has any live PNTHR position record;
//     even a 1-share PARTIAL is enough to keep its triggers alive.

import { connectToDatabase } from './database.js';
import { enqueue as enqueueOutbox, DEMO_OWNER_ID, getPnthrPlacedPermIds } from './ibkrOutbox.js';

// PNTHR fingerprint stamped on every bridge-placed order's `orderRef` field.
// Manual TWS order entry doesn't expose orderRef, so any order carrying this
// tag was placed by the bridge — and any order WITHOUT this tag (and absent
// from the outbox audit log) is the user's manual order and must be left alone.
const PNTHR_ORDER_REF = 'PNTHR';

export async function runOrphanCleanup({ db, dryRun = false } = {}) {
  if (!db) db = await connectToDatabase();
  if (!db) return { error: 'NO_DB' };

  const flagOn = process.env.IBKR_AUTO_CANCEL_ORPHANS === 'true';

  // Pull every IBKR snapshot we have a record of. Each doc = one owner.
  const snapshots = await db.collection('pnthr_ibkr_positions').find({
    ownerId: { $ne: DEMO_OWNER_ID },
  }).toArray();

  const orphans       = []; // ones we (would) cancel
  const skips         = []; // diagnostic — why we didn't act on a candidate

  // Counter — surfaced in the report so we can see how many manual user
  // orders the janitor protected this tick (good signal that the whitelist
  // is working as intended).
  let userOrdersProtected = 0;

  for (const snap of snapshots) {
    const ownerId    = snap.ownerId;
    const stopOrders = Array.isArray(snap.stopOrders) ? snap.stopOrders : [];
    if (stopOrders.length === 0) continue;

    // Active / partial positions for THIS owner only — never cross-owner.
    const activePositions = await db.collection('pnthr_portfolio').find({
      ownerId,
      status: { $in: ['ACTIVE', 'PARTIAL'] },
    }).project({ ticker: 1 }).toArray();
    const activeTickers = new Set(
      activePositions.map(p => (p.ticker || '').toUpperCase()).filter(Boolean)
    );

    // Build the PNTHR-fingerprint whitelist for THIS owner. Two sources OR'd
    // together (defense in depth):
    //   1. orderRef='PNTHR' on the live TWS order (forward-going clean tag —
    //      bridge stamps every place_protective_stop / sell_position).
    //   2. permId in the outbox audit log of DONE place/modify commands —
    //      catches orders placed BEFORE the orderRef tagging shipped, plus
    //      anything where the orderRef somehow got cleared.
    // Only orders matching at least ONE of these are eligible for cancel.
    // Everything else is treated as a user-initiated manual TWS order and
    // is invisible to the janitor.
    const pnthrPermIds = await getPnthrPlacedPermIds(db, ownerId);

    for (const order of stopOrders) {
      const ticker    = (order.symbol || '').toUpperCase();
      const orderType = order.orderType;
      const permId    = order.permId;
      const orderRef  = (order.orderRef || '').trim();

      if (!ticker || !permId) {
        skips.push({ ownerId, ticker, reason: 'MISSING_TICKER_OR_PERMID', order });
        continue;
      }
      if (orderType !== 'STP' && orderType !== 'STP LMT') {
        // Janitor only owns stop-shaped orders. Manual LMT/MKT entries are
        // out of scope by design.
        continue;
      }
      if (activeTickers.has(ticker)) {
        // Has a live PNTHR position — Phase 4c (stops) and Phase 4g (lot
        // triggers) own this case. Janitor leaves it alone.
        continue;
      }

      // PNTHR fingerprint check: only act on orders we placed. If neither
      // the orderRef tag nor the outbox audit knows about this permId, it
      // is a manual user order — ignore it forever.
      const isPnthrPlaced = orderRef === PNTHR_ORDER_REF || pnthrPermIds.has(Number(permId));
      if (!isPnthrPlaced) {
        userOrdersProtected += 1;
        continue;
      }

      // Confirmed orphan: TWS holds a stop for a ticker with no PNTHR
      // ACTIVE/PARTIAL position AND we have evidence we placed it. This is
      // exactly the XYZ-after-stop-hit case.
      const enqRes = !dryRun && flagOn
        ? await enqueueOutbox(db, ownerId, 'CANCEL_ORDER', {
            ticker,
            permId,
            source: 'ORPHAN_JANITOR',
            reason: 'NO_ACTIVE_POSITION',
            stopPrice: order.stopPrice,
            shares:    order.shares,
            action:    order.action,
            orderType,
          })
        : { skipped: dryRun ? 'DRY_RUN' : (flagOn ? 'UNKNOWN' : 'IBKR_AUTO_CANCEL_ORPHANS_OFF') };

      orphans.push({
        ownerId, ticker, permId, orderType,
        stopPrice: order.stopPrice,
        shares:    order.shares,
        action:    order.action,
        // Which whitelist matched? Useful for diagnosing transition-period
        // behavior — we expect 'TAG' for new orders, 'AUDIT' for old ones.
        matchedBy: orderRef === PNTHR_ORDER_REF ? 'TAG' : 'AUDIT',
        enqueued:   !enqRes.skipped,
        outboxId:   enqRes.id || null,
        skipReason: enqRes.skipped || null,
      });
    }
  }

  return {
    reconciledAt: new Date(),
    dryRun,
    flagOn,
    snapshotsScanned: snapshots.length,
    userOrdersProtected,
    orphans,
    skips,
  };
}
