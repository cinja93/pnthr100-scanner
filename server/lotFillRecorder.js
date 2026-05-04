// server/lotFillRecorder.js
// ── Auto-record TWS pyramid lot fills into PNTHR portfolio ──────────────────
//
// When a BUY STP for a LONG pyramid lot fires (or SELL STP for SHORT) and the
// fill comes back from the bridge as an execution, this module figures out
// which plan lot (L2-L5) the fill corresponds to and writes it into the
// position's fills[N] record. Without this, PNTHR's CMD POS and IBKR POS
// drift apart on every pyramid add and the user has no UI to reconcile (the
// old Command Center fill modal is no longer accessible).
//
// Hook point: server/ibkrSync.js processExecutions, before the existing exit
// detection. ADDs route here; SLDs (closes) fall through to recordExit.
//
// Gating: IBKR_AUTO_RECORD_ADD_FILL=true. When off, the function still runs
// but only LOGS what it would have done — useful for verification before
// flipping the switch.

import { computeLotPlan } from './lotMath.js';
import { calculateDisciplineScore } from './journalService.js';

// Tolerances for matching a fill execution to a plan lot.
// Wider than the lot-trigger sync tolerance because BUY STP can fill at a
// gap price well above the trigger (e.g., overnight news → open fills L2
// at $82 even though trigger was $78.16). The share-count check guards
// against matching the wrong lot when prices drift far.
const PRICE_TOLERANCE_PCT = 0.05;   // 5% — handles gap-fills
const SHARE_TOLERANCE_PCT = 0.20;   // ±20% of planned lot share count

// Default NAV when a user profile has none stored. Mirrors the rest of the
// server so the lot plan computed here matches what shows in the UI.
const DEFAULT_NAV = 100_000;

// ── Lot identification ──────────────────────────────────────────────────────
// Pick the lowest-numbered unfilled lot whose trigger price is within 5% of
// the fill price AND whose target shares are within 20% of the fill shares.
// Returns the lot object or null.
function identifyLotForFill({ position, lotPlan, fillPrice, fillShares, isLong }) {
  for (const lot of lotPlan) {
    if (lot.lot === 1) continue;       // L1 is the entry, never an STP fill
    if (lot.filled) continue;          // already recorded

    const priceTol = lot.triggerPrice * PRICE_TOLERANCE_PCT;
    const shareTol = Math.max(1, Math.round(lot.targetShares * SHARE_TOLERANCE_PCT));

    // For LONG: fill should be at or above trigger (BUY STP triggers when price
    // crosses up). For SHORT: at or below trigger (SELL STP triggers down).
    const triggerSideOk = isLong
      ? fillPrice >= lot.triggerPrice - priceTol
      : fillPrice <= lot.triggerPrice + priceTol;
    if (!triggerSideOk) continue;

    const priceOk = Math.abs(fillPrice - lot.triggerPrice) <= priceTol;
    const sharesOk = Math.abs(fillShares - lot.targetShares) <= shareTol;
    if (priceOk && sharesOk) return lot;
  }
  return null;
}

// ── Stop ratchet rule per CommandCenter pattern ─────────────────────────────
// L3 filled → stop = L1 fill price (breakeven on entry)
// L4 filled → stop = L2 fill price (lock L2 cost)
// L5 filled → stop = L3 fill price (lock L3 cost)
// Highest filled lot wins. Never moves backward (MAX for LONG, MIN for SHORT).
// Returns { newStop, reason } or null if no ratchet applies.
function computeStopRatchet({ position, fills, isLong }) {
  const highFilled = Math.max(0, ...Object.keys(fills).map(k => fills[k]?.filled ? +k : 0));
  let recStop = null;
  let reason  = null;
  if (highFilled >= 5 && fills[3]?.filled && fills[3]?.price != null) {
    recStop = +fills[3].price; reason = 'L5_FILLED_LOCK_TO_L3';
  } else if (highFilled >= 4 && fills[2]?.filled && fills[2]?.price != null) {
    recStop = +fills[2].price; reason = 'L4_FILLED_LOCK_TO_L2';
  } else if (highFilled >= 3 && fills[1]?.filled && fills[1]?.price != null) {
    recStop = +fills[1].price; reason = 'L3_FILLED_BREAKEVEN';
  }
  if (recStop == null) return null;

  const currentStop = +position.stopPrice || 0;
  // Tightest-wins: never loosen the stop. LONG = higher tighter; SHORT = lower.
  const tighter = isLong ? recStop > currentStop : (currentStop === 0 || recStop < currentStop);
  if (!tighter) return null;
  return { newStop: +recStop.toFixed(2), reason };
}

// ── Journal note for the auto-record ────────────────────────────────────────
async function appendJournalNote({ db, ownerId, positionId, lot, fillPrice, fillShares, fillDate, ratchetMsg }) {
  // Only append if a journal doc exists; don't auto-create here (recordExit
  // does that on close, but a mid-trade lot fill shouldn't conjure one).
  const existing = await db.collection('pnthr_journal').findOne(
    { positionId: positionId.toString(), ownerId },
    { projection: { _id: 1 } }
  );
  if (!existing) return false;

  const text = `L${lot.lot} (${lot.name}) auto-filled from TWS — ${fillShares} sh @ $${(+fillPrice).toFixed(2)} on ${fillDate}` +
               (ratchetMsg ? `. ${ratchetMsg}` : '');
  await db.collection('pnthr_journal').updateOne(
    { positionId: positionId.toString(), ownerId },
    { $push: {
      notes: {
        id: `N_AUTOFILL_L${lot.lot}_${Date.now()}`,
        timestamp: new Date().toISOString(),
        type: 'AUTO_FILL',
        text,
      },
    } }
  );
  return true;
}

// ── recordLotFill ───────────────────────────────────────────────────────────
// Returns one of:
//   { recorded: true, lot, ratchet }                 — wrote fills[N]
//   { recorded: false, skipReason: '...' }           — couldn't or wouldn't
// Never throws. Caller (ibkrSync) treats this as advisory; on any failure
// the execution is left for retry on the next sync.
export async function recordLotFill({ db, ownerId, position, execution, syncedAt, nav, dryRun = false }) {
  const direction = (position.direction || 'LONG').toUpperCase();
  const isLong    = direction !== 'SHORT';

  // Sanity: action must match direction-of-add for a pyramid lot fill.
  // LONG pyramid adds via BOT (BUY STP fired). SHORT adds via SLD (SELL STP).
  const expectedSide = isLong ? 'BOT' : 'SLD';
  if (execution.side !== expectedSide) {
    return { recorded: false, skipReason: `SIDE_MISMATCH_${execution.side}_FOR_${direction}` };
  }

  const fillPrice  = +execution.price;
  const fillShares = +execution.shares;
  if (!Number.isFinite(fillPrice) || fillPrice <= 0) return { recorded: false, skipReason: 'BAD_PRICE' };
  if (!Number.isFinite(fillShares) || fillShares <= 0) return { recorded: false, skipReason: 'BAD_SHARES' };

  const fills = position.fills || {};
  const totalFilled = Object.values(fills).reduce((s, f) => s + (f?.filled ? +f.shares || 0 : 0), 0);

  // Must already have at least one filled lot — otherwise this is a NEW
  // position open, which is Phase 3's job (auto-open), not auto-record.
  if (totalFilled === 0) return { recorded: false, skipReason: 'NO_PRIOR_FILLS_NOT_PYRAMID_ADD' };

  // Compute the canonical plan (anchor + offsets) and identify which lot.
  const lotPlan = computeLotPlan(position, nav || DEFAULT_NAV);
  const lot     = identifyLotForFill({ position, lotPlan, fillPrice, fillShares, isLong });
  if (!lot) {
    return { recorded: false, skipReason: 'NO_MATCHING_LOT', diagnostic: {
      fillPrice, fillShares, planLots: lotPlan.filter(l => l.lot !== 1).map(l => ({ lot: l.lot, trig: l.triggerPrice, target: l.targetShares, filled: l.filled }))
    } };
  }

  // Don't overwrite a manual fill. If user already marked this lot, leave it.
  if (fills[lot.lot]?.filled) return { recorded: false, skipReason: 'LOT_ALREADY_FILLED', lot: lot.lot };

  const fillDate = (syncedAt instanceof Date ? syncedAt : new Date(syncedAt)).toISOString().split('T')[0];

  // Project the new fills state (for stop-ratchet computation) without
  // writing yet — we want the ratchet to see this fill as "just filled".
  const projectedFills = { ...fills, [lot.lot]: {
    filled: true,
    shares: fillShares,
    price:  fillPrice,
    date:   fillDate,
    execId: execution.execId,
    permId: execution.permId,
    source: 'IBKR_AUTO_RECORD',
  } };
  const ratchet = computeStopRatchet({ position, fills: projectedFills, isLong });

  if (dryRun) {
    return { recorded: false, skipReason: 'DRY_RUN', lot: lot.lot, ratchet, projectedShares: totalFilled + fillShares };
  }

  // ── Write fills[N] + (optionally) stopPrice ratchet ──────────────────────
  const setOps = { [`fills.${lot.lot}`]: projectedFills[lot.lot], updatedAt: new Date() };
  if (ratchet) {
    setOps.stopPrice         = ratchet.newStop;
    setOps.stopRatchetSource = 'AUTO_FILL_' + ratchet.reason;
    setOps.stopRatchetAt     = new Date();
  }
  const writeRes = await db.collection('pnthr_portfolio').updateOne(
    { id: position.id, ownerId },
    { $set: setOps }
  );
  if (writeRes.matchedCount === 0) return { recorded: false, skipReason: 'POSITION_DISAPPEARED' };

  // Best-effort journal note + discipline rescore (non-blocking).
  try {
    const ratchetMsg = ratchet ? `Stop ratcheted to $${ratchet.newStop.toFixed(2)} (${ratchet.reason}).` : null;
    await appendJournalNote({ db, ownerId, positionId: position.id, lot, fillPrice, fillShares, fillDate, ratchetMsg });
  } catch (e) { console.warn(`[lotFill] journal note failed for ${position.ticker} L${lot.lot}: ${e.message}`); }

  return { recorded: true, lot: lot.lot, lotName: lot.name, fillPrice, fillShares, fillDate, ratchet };
}
