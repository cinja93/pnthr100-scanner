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

  // Step 6: catch-up matching. If the position has a catchUpRebalancePlan
  // (set by lotTriggerCron PASS 5 when the catch-up was enqueued), check
  // whether THIS execution is the catch-up filling. The catch-up market
  // order ships at Sa shares with current-market price — usually well above
  // the original L_N trigger, so the standard identifyLotForFill match
  // (5% price tolerance from trigger) won't pair it. We pair by Sa share
  // match instead. The catch-up writes to fills[missedLot] like a normal
  // pyramid fill, then applies the persisted rebalance plan to upper lots.
  const catchUpPlan = position.catchUpRebalancePlan || null;
  let isCatchUp = false;
  let lot = null;
  if (catchUpPlan && catchUpPlan.missedLot && catchUpPlan.Sa) {
    // Match by share count tolerance (allow ±1 sh for fractional rounding).
    const sharesMatch = Math.abs(fillShares - +catchUpPlan.Sa) <= 1;
    if (sharesMatch && !fills[catchUpPlan.missedLot]?.filled) {
      isCatchUp = true;
      lot = lotPlan.find(l => l.lot === catchUpPlan.missedLot);
    }
  }
  if (!lot) {
    lot = identifyLotForFill({ position, lotPlan, fillPrice, fillShares, isLong });
  }
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
  // For a catch-up fill, also pre-update the unfilled upper lots'
  // targetShares per the persisted rebalance plan, so subsequent share
  // total + ratchet calculations operate on the new plan.
  const fillSource = isCatchUp ? 'IBKR_AUTO_RECORD_CATCHUP' : 'IBKR_AUTO_RECORD';
  const projectedFills = { ...fills, [lot.lot]: {
    filled: true,
    shares: fillShares,
    price:  fillPrice,
    date:   fillDate,
    execId: execution.execId,
    permId: execution.permId,
    source: fillSource,
  } };
  // Apply rebalance plan to UNFILLED upper lots (only when this is the
  // catch-up filling). Each newUpperShares entry replaces that lot's
  // targetShares; trigger price stays put (anchored at L1).
  if (isCatchUp && Array.isArray(catchUpPlan.newUpperShares)) {
    for (const u of catchUpPlan.newUpperShares) {
      const ln = +u.lot;
      if (!ln || ln <= lot.lot || ln > 5) continue;
      // Don't touch a lot that has independently filled in the meantime.
      if (projectedFills[ln]?.filled) continue;
      // Preserve any existing fields on the unfilled lot record; just
      // overwrite the planned targetShares.
      projectedFills[ln] = {
        ...(projectedFills[ln] || {}),
        filled:       false,
        targetShares: +u.shares,
        triggerPrice: +u.triggerPrice,
        lot:          ln,
        rebalancedFromCatchUp: true,
      };
    }
  }
  const ratchet = computeStopRatchet({ position, fills: projectedFills, isLong });

  if (dryRun) {
    return { recorded: false, skipReason: 'DRY_RUN', lot: lot.lot, ratchet, projectedShares: totalFilled + fillShares };
  }

  // ── Write fills[N] + share totals + (optionally) stopPrice ratchet ──────────
  // Recompute totalFilledShares / remainingShares from the projected fills set
  // so PNTHR's bookkeeping stays consistent with sum(fills[].shares). Without
  // this, every auto-recorded fill grew the fills[] array but left
  // totalFilledShares stale, causing the live table to display sum-of-fills
  // (e.g., 16) while internal accounting (badge, P&L) used the stale value
  // (e.g., 4) — exactly the ADI 2026-05-06 drift.
  const projectedFilled = Object.values(projectedFills).reduce(
    (s, f) => s + (f?.filled ? +f.shares || 0 : 0), 0,
  );
  const projectedExited = (position.exits || []).reduce((s, e) => s + (+e.shares || 0), 0);
  const projectedRemaining = projectedFilled - projectedExited;

  const setOps = {
    [`fills.${lot.lot}`]: projectedFills[lot.lot],
    totalFilledShares:    projectedFilled,
    remainingShares:      projectedRemaining,
    updatedAt:            new Date(),
  };
  if (ratchet) {
    setOps.stopPrice         = ratchet.newStop;
    setOps.stopRatchetSource = 'AUTO_FILL_' + ratchet.reason;
    setOps.stopRatchetAt     = new Date();
  }
  // Catch-up fill: persist rebalanced upper-lot target shares so the next
  // lotTriggerCron tick MODIFYs TWS BUY/SELL STPs to the new counts.
  // Clear the pendingCatchUp + catchUpRebalancePlan flags now that the
  // catch-up has filled and been recorded.
  let unsetOps = null;
  if (isCatchUp && Array.isArray(catchUpPlan.newUpperShares)) {
    for (const u of catchUpPlan.newUpperShares) {
      const ln = +u.lot;
      if (!ln || ln <= lot.lot || ln > 5) continue;
      if (projectedFills[ln]?.filled) continue;
      setOps[`fills.${ln}`] = projectedFills[ln];
    }
    unsetOps = { pendingCatchUp: '', catchUpRebalancePlan: '' };
  }
  const updateDoc = { $set: setOps };
  if (unsetOps) updateDoc.$unset = unsetOps;
  const writeRes = await db.collection('pnthr_portfolio').updateOne(
    { id: position.id, ownerId },
    updateDoc
  );
  if (writeRes.matchedCount === 0) return { recorded: false, skipReason: 'POSITION_DISAPPEARED' };

  // Best-effort journal note + discipline rescore (non-blocking).
  try {
    const ratchetMsg = ratchet ? `Stop ratcheted to $${ratchet.newStop.toFixed(2)} (${ratchet.reason}).` : null;
    await appendJournalNote({ db, ownerId, positionId: position.id, lot, fillPrice, fillShares, fillDate, ratchetMsg });
  } catch (e) { console.warn(`[lotFill] journal note failed for ${position.ticker} L${lot.lot}: ${e.message}`); }

  return { recorded: true, lot: lot.lot, lotName: lot.name, fillPrice, fillShares, fillDate, ratchet, isCatchUp };
}
