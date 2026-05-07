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

      // Pick the keeper: prefer PNTHR-tagged, else lowest permId.
      const pnthrTagged = group.filter(s => (s.orderRef || '').trim() === 'PNTHR');
      const keeper = pnthrTagged.length > 0
        ? pnthrTagged.sort((a, b) => +a.permId - +b.permId)[0]
        : group.slice().sort((a, b) => +a.permId - +b.permId)[0];

      const cancellations = [];
      for (const s of group) {
        if (s.permId === keeper.permId) continue;
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
