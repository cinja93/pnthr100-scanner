// server/ibkrOutbox.js
// ── PNTHR ↔ IBKR write outbox queue ─────────────────────────────────────────
//
// Phase 4 D1 (2026-04-30): the bidirectional bridge writes here. All Phase 2/3
// hooks plus the daily stop-ratchet cron call enqueue() to push commands; the
// Python bridge polls findPending() every 30s and executes via the IB API.
//
// State machine: PENDING → EXECUTING → DONE | FAILED. After 5 min in
// EXECUTING with no result → STUCK (manual review, no auto-retry — prevents
// double-execution if the bridge crashed mid-write).
//
// Hard rules baked into enqueue():
//   1. Demo account (ownerId === 'demo_fund') writes are FORBIDDEN. Sentinel
//      runs before everything else, returns { skipped: 'DEMO' }.
//   2. Duplicate suppression: same {ownerId, ticker, command} within 60s →
//      skipped. Prevents accidental double-enqueue from concurrent hooks.
//   3. Sanity checks (caller-supplied) — position exists, direction matches,
//      stop on right side of price, within 50% of price, shares match IBKR.
//   4. Daily auto-disable windows (9:25-9:35 ET open, 3:55-4:05 ET close).
//      Avoid placing orders into chaotic price action.
//
// Bridge-side guards live in pnthr-ibkr-bridge.py:
//   - IBKR_WRITES_ENABLED master kill switch (default false) — bridge ignores
//     the queue entirely until set true
//   - IBKR_WRITES_DRY_RUN — log commands but skip the IB API call
//   - Per-symbol (5/min) and global (50/min) rate limits

import { randomUUID } from 'crypto';

export const DEMO_OWNER_ID = 'demo_fund';
const COLLECTION             = 'pnthr_ibkr_outbox';
const STUCK_THRESHOLD_MS     = 5 * 60 * 1000;
const DEDUP_WINDOW_MS        = 60_000;

const VALID_COMMANDS = new Set([
  'PLACE_STOP',           // Phase 4a — stop on auto-open
  'CANCEL_ORDER',          // Phase 4b — cancel by permId
  'CANCEL_RELATED_ORDERS', // Phase 4b — cancel all open orders for a ticker
  'MODIFY_STOP',           // Phase 4c — daily ratchet sync (cancel + replace)
  'SELL_POSITION',         // Phase 4f — close from PNTHR places real sell in TWS
  'PLACE_LOT_TRIGGER',     // Phase 4g — pre-stage L2-L5 BUY/SELL STOP for pyramid adds
  'MODIFY_LOT_TRIGGER',    // Phase 4g — daily reconcile (cancel + replace stale lot trigger)
]);

// ── Stop-order shape helper (RTH vs extended-hours) ──────────────────────────
// Per the locked Phase 4 design (project_phase4_bridge_design.md):
//   • RTH default: pure STP (stop-market). Guarantees fill, accepts whatever
//     price the market gives during regular trading hours.
//   • Extended hours: STP LMT required (IBKR rejects STP outside RTH). The
//     limit price uses a slippage cushion (default 0.5%) so the order can
//     still fill in thin pre/post-market liquidity.
//
// Returns the order shape (orderType, lmtPrice, rth, outsideRth) given the
// position's stopExtendedHours flag. Caller passes the result into the outbox
// request so the bridge has everything it needs to construct the IB order.
const EXT_HOURS_SLIPPAGE_PCT = 0.005; // 0.5% default
export function buildStopOrderShape({ stopPrice, direction, stopExtendedHours }) {
  const isLong = (direction || 'LONG').toUpperCase() !== 'SHORT';
  if (!stopExtendedHours) {
    return { orderType: 'STP', lmtPrice: null, rth: true };
  }
  // Extended-hours STP LMT: limit on the WORST-fill side of the trigger so
  // the order can still cross the spread in thin liquidity but caps the
  // damage on a hard gap. LONG sells, so lmtPrice is below stopPrice; SHORT
  // buys to cover, so lmtPrice is above stopPrice.
  const cushion = +stopPrice * EXT_HOURS_SLIPPAGE_PCT;
  const lmtPrice = isLong ? +stopPrice - cushion : +stopPrice + cushion;
  return { orderType: 'STP LMT', lmtPrice: +lmtPrice.toFixed(2), rth: false };
}

// ── Daily auto-disable windows ──────────────────────────────────────────────
// Returns true during the open/close blackout. Bridge-side code can ALSO
// check, but enqueue-time blocking prevents the queue from filling up in
// the first place.
export function isInBlackoutWindow(now = new Date()) {
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const h  = et.getHours();
  const m  = et.getMinutes();
  const minutesIntoDay = h * 60 + m;
  // 9:25-9:35
  if (minutesIntoDay >= 565 && minutesIntoDay <= 575) return 'OPEN_BLACKOUT';
  // 15:55-16:05
  if (minutesIntoDay >= 955 && minutesIntoDay <= 965) return 'CLOSE_BLACKOUT';
  return null;
}

// ── Pre-enqueue sanity checks ────────────────────────────────────────────────
// Caller passes in the position + IBKR snapshot. We refuse to enqueue if
// anything looks wrong — better to surface as a no-op than to push a bad order.
export function sanityCheckPlaceStop({ position, ibkrPosition, stopPrice }) {
  if (!position || !position.id) return { ok: false, reason: 'POSITION_MISSING' };
  if (!ibkrPosition) return { ok: false, reason: 'IBKR_POSITION_MISSING' };
  const ibkrShares = Math.abs(+ibkrPosition.shares || 0);
  if (ibkrShares <= 0) return { ok: false, reason: 'IBKR_SHARES_ZERO' };
  const lastPrice = +ibkrPosition.lastPrice || +position.currentPrice || 0;
  if (lastPrice <= 0) return { ok: false, reason: 'NO_PRICE_REFERENCE' };
  const stop = +stopPrice;
  if (!Number.isFinite(stop) || stop <= 0) return { ok: false, reason: 'BAD_STOP_PRICE' };

  const isLong = (position.direction || 'LONG').toUpperCase() !== 'SHORT';
  // Stop on right side of price
  if (isLong && stop >= lastPrice)  return { ok: false, reason: 'LONG_STOP_AT_OR_ABOVE_PRICE' };
  if (!isLong && stop <= lastPrice) return { ok: false, reason: 'SHORT_STOP_AT_OR_BELOW_PRICE' };
  // Within 50% of price (catch obvious typos)
  const diffPct = Math.abs(stop - lastPrice) / lastPrice;
  if (diffPct > 0.50) return { ok: false, reason: 'STOP_MORE_THAN_50PCT_AWAY' };

  return { ok: true, ibkrShares, isLong };
}

// ── Pre-enqueue sanity for SELL_POSITION (Phase 4f) ─────────────────────────
// Refuse to enqueue a sell if anything looks wrong — never want PNTHR to
// silently sell shares the user doesn't actually have, or sell during a
// stale-snapshot window.
//
// Enforces:
//   • IBKR still holds the position (matching ticker + direction sign)
//   • Requested shares <= IBKR shares (no over-selling — IBKR rejects too)
//   • Last-price reference is plausible
//   • Limit-order request includes a positive limit price
//   • Limit price is on the user's side of last (won't fill at a stupid price)
export function sanityCheckSellPosition({ position, ibkrPosition, shares, orderType, limitPrice }) {
  if (!position || !position.id) return { ok: false, reason: 'POSITION_MISSING' };
  if (!ibkrPosition) return { ok: false, reason: 'IBKR_POSITION_MISSING' };
  const ibkrShares = Math.abs(+ibkrPosition.shares || 0);
  if (ibkrShares <= 0) return { ok: false, reason: 'IBKR_SHARES_ZERO' };
  const reqShares  = +shares;
  if (!Number.isFinite(reqShares) || reqShares <= 0) return { ok: false, reason: 'BAD_SHARES' };
  if (reqShares > ibkrShares) return { ok: false, reason: 'SHARES_EXCEED_IBKR' };

  const lastPrice = +ibkrPosition.lastPrice || +position.currentPrice || 0;
  if (lastPrice <= 0) return { ok: false, reason: 'NO_PRICE_REFERENCE' };

  const ot = (orderType || 'MKT').toUpperCase();
  if (ot !== 'MKT' && ot !== 'LMT') return { ok: false, reason: 'BAD_ORDER_TYPE' };

  if (ot === 'LMT') {
    const lp = +limitPrice;
    if (!Number.isFinite(lp) || lp <= 0) return { ok: false, reason: 'BAD_LIMIT_PRICE' };
    // For a LONG sell, the limit should not be wildly above last (or it'll
    // never fill). Cap at +20% of last as a typo guard. Below last is fine
    // (aggressive limit). Mirror for SHORT cover.
    const isLong = (position.direction || 'LONG').toUpperCase() !== 'SHORT';
    if (isLong && lp > lastPrice * 1.20) return { ok: false, reason: 'LMT_TOO_HIGH_VS_LAST' };
    if (!isLong && lp < lastPrice * 0.80) return { ok: false, reason: 'LMT_TOO_LOW_VS_LAST' };
  }

  return { ok: true, ibkrShares, reqShares, lastPrice };
}

export function sanityCheckModifyStop({ position, ibkrPosition, oldStopPrice, newStopPrice }) {
  const placeCheck = sanityCheckPlaceStop({ position, ibkrPosition, stopPrice: newStopPrice });
  if (!placeCheck.ok) return placeCheck;
  if (!Number.isFinite(+oldStopPrice) || +oldStopPrice <= 0) return { ok: false, reason: 'BAD_OLD_STOP' };
  // Tightest-wins: PNTHR only pushes a new stop when it's TIGHTER than the
  // current IBKR value (per feedback_earnings_week_stops.md).
  const isLong = placeCheck.isLong;
  const newTighter = isLong
    ? +newStopPrice > +oldStopPrice
    : +newStopPrice < +oldStopPrice;
  if (!newTighter) return { ok: false, reason: 'NEW_STOP_NOT_TIGHTER_THAN_OLD' };
  return placeCheck;
}

// ── Pre-enqueue sanity for PLACE_LOT_TRIGGER (Phase 4g) ──────────────────────
// A lot trigger is a BUY STOP (LONG pyramid) or SELL STOP (SHORT pyramid)
// staged at the L2-L5 trigger price computed from the entry anchor + per-lot
// offset (3/6/10/14% per lotMath.js). Direction is inverted vs the protective
// stop: LONG protective is SELL STOP below market; LONG lot trigger is BUY
// STOP above market.
//
// Refuses to enqueue if anything looks wrong — never want PNTHR to silently
// pre-stage an order on the wrong side of price, at a clearly-bad share
// count, or for the entry lot (Lot 1 isn't a trigger; it's the actual fill).
export function sanityCheckPlaceLotTrigger({ position, ibkrPosition, lot, triggerPrice, shares }) {
  if (!position || !position.id) return { ok: false, reason: 'POSITION_MISSING' };
  if (!ibkrPosition) return { ok: false, reason: 'IBKR_POSITION_MISSING' };
  const ibkrShares = Math.abs(+ibkrPosition.shares || 0);
  if (ibkrShares <= 0) return { ok: false, reason: 'IBKR_SHARES_ZERO' };

  // Lot 1 is the entry fill, not a trigger. Lots 6+ don't exist.
  const lotNum = +lot;
  if (!Number.isInteger(lotNum) || lotNum < 2 || lotNum > 5) {
    return { ok: false, reason: 'INVALID_LOT_NUM' };
  }

  const lastPrice = +ibkrPosition.lastPrice || +position.currentPrice || 0;
  if (lastPrice <= 0) return { ok: false, reason: 'NO_PRICE_REFERENCE' };

  const trig = +triggerPrice;
  if (!Number.isFinite(trig) || trig <= 0) return { ok: false, reason: 'BAD_TRIGGER_PRICE' };

  const reqShares = +shares;
  if (!Number.isFinite(reqShares) || reqShares <= 0) return { ok: false, reason: 'BAD_SHARES' };
  // Per-lot share cap. A single pyramid lot above 50% of the existing position
  // is almost always a typo or stale-NAV recompute — refuse rather than place.
  if (reqShares > ibkrShares * 0.50 + 1) return { ok: false, reason: 'LOT_SHARES_EXCEED_50PCT_OF_IBKR' };

  const isLong = (position.direction || 'LONG').toUpperCase() !== 'SHORT';
  // Trigger on the pyramid-add side of price.
  //   LONG: BUY  STOP must be ABOVE current price (we're chasing strength up).
  //   SHORT: SELL STOP must be BELOW current price (we're chasing weakness down).
  if (isLong  && trig <= lastPrice) return { ok: false, reason: 'LONG_LOT_AT_OR_BELOW_PRICE' };
  if (!isLong && trig >= lastPrice) return { ok: false, reason: 'SHORT_LOT_AT_OR_ABOVE_PRICE' };

  // Within 50% of price (typo guard, same as protective stops).
  const diffPct = Math.abs(trig - lastPrice) / lastPrice;
  if (diffPct > 0.50) return { ok: false, reason: 'TRIGGER_MORE_THAN_50PCT_AWAY' };

  return { ok: true, ibkrShares, isLong };
}

// ── Pre-enqueue sanity for MODIFY_LOT_TRIGGER (Phase 4g) ─────────────────────
// Trigger prices for lot triggers are deterministic from the (fixed) entry
// anchor, so they don't drift after L1 fills. Shares DO drift as NAV changes.
// MODIFY is therefore primarily share-count adjustment. When trigger price
// IS changing, PNTHR-side must be TIGHTER (lower trigger for LONG = earlier
// pyramid commitment; mirror for SHORT) — never push a looser trigger.
export function sanityCheckModifyLotTrigger({ position, ibkrPosition, lot, oldTriggerPrice, newTriggerPrice, oldShares, newShares }) {
  const placeCheck = sanityCheckPlaceLotTrigger({ position, ibkrPosition, lot, triggerPrice: newTriggerPrice, shares: newShares });
  if (!placeCheck.ok) return placeCheck;
  if (!Number.isFinite(+oldTriggerPrice) || +oldTriggerPrice <= 0) return { ok: false, reason: 'BAD_OLD_TRIGGER' };

  const triggerChanged = Math.abs(+newTriggerPrice - +oldTriggerPrice) >= 0.05;
  const sharesChanged  = (+newShares || 0) !== (+oldShares || 0);
  if (!triggerChanged && !sharesChanged) return { ok: false, reason: 'NO_CHANGE_TO_APPLY' };

  if (triggerChanged) {
    // Tighter = closer to anchor (earlier pyramid entry).
    //   LONG: newTrigger < oldTrigger
    //   SHORT: newTrigger > oldTrigger
    const isLong = placeCheck.isLong;
    const newTighter = isLong
      ? +newTriggerPrice < +oldTriggerPrice
      : +newTriggerPrice > +oldTriggerPrice;
    if (!newTighter) return { ok: false, reason: 'NEW_TRIGGER_NOT_TIGHTER_THAN_OLD' };
  }
  return placeCheck;
}

// ── Duplicate suppression (60s window per {ownerId, ticker, command}) ───────
async function isDuplicate(db, ownerId, ticker, command) {
  const since = new Date(Date.now() - DEDUP_WINDOW_MS);
  const dup = await db.collection(COLLECTION).findOne({
    ownerId,
    'request.ticker': ticker,
    command,
    createdAt: { $gt: since },
  });
  return !!dup;
}

// ── Enqueue ─────────────────────────────────────────────────────────────────
// Returns { skipped: false, id } on success, { skipped: <reason> } when
// blocked. Never throws — all failure modes return a structured skip reason
// so callers (Phase 2/3 hooks, cron) don't crash on edge cases.
export async function enqueue(db, ownerId, command, request, opts = {}) {
  // Rule 1 — demo sentinel. Hard-coded check, not a flag.
  if (ownerId === DEMO_OWNER_ID) {
    return { skipped: 'DEMO_ACCOUNT_HARD_DISABLED' };
  }
  if (!VALID_COMMANDS.has(command)) {
    return { skipped: 'INVALID_COMMAND' };
  }
  if (!request || !request.ticker) {
    return { skipped: 'MISSING_TICKER' };
  }
  // Rule 4 — daily auto-disable windows
  const blackout = isInBlackoutWindow();
  if (blackout && !opts.skipBlackoutCheck) {
    return { skipped: blackout };
  }
  // Rule 3 — caller-supplied sanity check
  if (opts.sanityCheck && !opts.sanityCheck.ok) {
    return { skipped: opts.sanityCheck.reason || 'SANITY_FAIL' };
  }
  // Rule 2 — dedup
  if (!opts.skipDedup && await isDuplicate(db, ownerId, request.ticker, command)) {
    return { skipped: 'DUPLICATE_WITHIN_60S' };
  }

  const doc = {
    id:         randomUUID(),
    ownerId,
    command,
    request,
    status:     'PENDING',
    createdAt:  new Date(),
    executedAt: null,
    response:   null,
    errors:     null,
  };
  await db.collection(COLLECTION).insertOne(doc);
  return { skipped: false, id: doc.id };
}

// ── Bridge poller helpers ───────────────────────────────────────────────────

export async function findPending(db, limit = 25) {
  return db.collection(COLLECTION)
    .find({ status: 'PENDING' })
    .sort({ createdAt: 1 })
    .limit(limit)
    .toArray();
}

export async function markExecuting(db, id) {
  return db.collection(COLLECTION).updateOne(
    { id, status: 'PENDING' },
    { $set: { status: 'EXECUTING', executingAt: new Date() } }
  );
}

export async function markDone(db, id, response) {
  return db.collection(COLLECTION).updateOne(
    { id },
    { $set: { status: 'DONE', executedAt: new Date(), response: response || null } }
  );
}

export async function markFailed(db, id, errors) {
  return db.collection(COLLECTION).updateOne(
    { id },
    { $set: { status: 'FAILED', executedAt: new Date(), errors: errors || 'Unknown failure' } }
  );
}

// Promote stuck commands to STUCK status. Called by a periodic server-side
// timer (or admin endpoint) so the operator UI can surface them. Never
// auto-retries; manual review only.
export async function flagStuck(db) {
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS);
  const result = await db.collection(COLLECTION).updateMany(
    { status: 'EXECUTING', executingAt: { $lt: cutoff } },
    { $set: { status: 'STUCK', stuckAt: new Date() } }
  );
  return result.modifiedCount;
}

// ── Admin / status helpers ──────────────────────────────────────────────────

export async function recentCommands(db, ownerId, limit = 50) {
  const filter = ownerId ? { ownerId } : {};
  return db.collection(COLLECTION)
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

export async function statusCounts(db, ownerId) {
  const filter = ownerId ? { ownerId } : {};
  const docs = await db.collection(COLLECTION).aggregate([
    { $match: filter },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]).toArray();
  const out = { PENDING: 0, EXECUTING: 0, DONE: 0, FAILED: 0, STUCK: 0 };
  for (const d of docs) out[d._id] = d.count;
  return out;
}

// ── PNTHR-placed permId whitelist (orphan-janitor secondary fingerprint) ────
// Returns the set of TWS permIds that this outbox knows it placed for the
// given owner. Used by orphanOrderJanitor as a fallback whitelist alongside
// the bridge-stamped orderRef='PNTHR' tag — covers orders placed before the
// orderRef tagging shipped (transition period) and orders whose orderRef
// somehow got cleared (defense in depth).
//
// Permanent IDs (permIds) come back in the bridge's response payload. We
// look at every DONE place/modify command and pull the permId out:
//   • PLACE_STOP / PLACE_LOT_TRIGGER:  response.permId
//   • MODIFY_STOP / MODIFY_LOT_TRIGGER: response.placeResult.permId (the
//     replacement order's permId — the original was cancelled)
//
// Bound to 90-day hot retention (DONE records older than that are archived).
// That's plenty: any TWS order older than 90 days that's still working has
// almost certainly been touched by a Phase 4c ratchet which generates a
// fresh DONE record.
export async function getPnthrPlacedPermIds(db, ownerId) {
  const cmds = await db.collection(COLLECTION).find({
    ownerId,
    status:  'DONE',
    command: { $in: ['PLACE_STOP', 'PLACE_LOT_TRIGGER', 'MODIFY_STOP', 'MODIFY_LOT_TRIGGER'] },
  }).project({ command: 1, response: 1 }).toArray();

  const permIds = new Set();
  for (const c of cmds) {
    const r = c.response;
    if (!r) continue;
    if (r.permId) permIds.add(Number(r.permId));
    // MODIFY commands carry the replacement permId on placeResult
    if (r.placeResult && r.placeResult.permId) permIds.add(Number(r.placeResult.permId));
  }
  return permIds;
}

// ── Cold-archive helper (90-day retention) ───────────────────────────────────
// Moves DONE commands older than 90 days into pnthr_ibkr_outbox_archive.
// FAILED and STUCK commands NEVER auto-archive — they live in the hot
// collection until human review. Run from a daily cron or admin endpoint.
export async function archiveOldDone(db, daysOld = 90) {
  const cutoff = new Date(Date.now() - daysOld * 86_400_000);
  const old = await db.collection(COLLECTION)
    .find({ status: 'DONE', executedAt: { $lt: cutoff } })
    .limit(1000)
    .toArray();
  if (old.length === 0) return { archived: 0 };
  const archived = old.map(d => ({ ...d, archivedAt: new Date() }));
  await db.collection(`${COLLECTION}_archive`).insertMany(archived);
  await db.collection(COLLECTION).deleteMany({ id: { $in: old.map(d => d.id) } });
  return { archived: old.length };
}

// ── Indexes setup (idempotent, called once at server startup) ──────────────
export async function ensureIndexes(db) {
  const col = db.collection(COLLECTION);
  await Promise.all([
    col.createIndex({ ownerId: 1, status: 1, createdAt: -1 }),
    col.createIndex({ status: 1, executingAt: 1 }),
    col.createIndex({ command: 1, 'request.ticker': 1, createdAt: -1 }),
    col.createIndex({ id: 1 }, { unique: true }),
  ]);
}
