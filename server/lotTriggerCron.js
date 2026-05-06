// server/lotTriggerCron.js
// ── Phase 4g — daily lot-trigger reconciliation cron (4:30 PM ET, Mon-Fri) ──
//
// Walks every ACTIVE/PARTIAL non-demo position with a real pyramid plan and
// reconciles its computed L2-L5 BUY/SELL STOPs against IBKR's open orders.
//
// THREE-PASS DESIGN (per handoff_2026_04_30.md §4G + project_4g_lot_trigger_
// cleanup_rule.md):
//
//   1. CLEANUP — for every IBKR lot-trigger order matched to a "complete" lot
//                (cumulative target ≤ IBKR shares, i.e., already filled or
//                surpassed via manual market-buy), enqueue CANCEL_ORDER.
//                This is the SWKS-style stale-trigger eliminator.
//
//   2. MODIFY  — for every IBKR lot-trigger order matched to an "incomplete"
//                lot where PNTHR's computed trigger is TIGHTER than the TWS
//                value (rare — anchor is fixed so trigger prices don't drift,
//                but share-count drift from NAV change still goes here when
//                PNTHR computes a smaller count we want to push), enqueue
//                MODIFY_LOT_TRIGGER. Tightest-wins: TWS-tighter cases are
//                silently adopted (no enqueue).
//
//   3. PLACE   — for every "incomplete" lot with NO matching TWS order,
//                enqueue PLACE_LOT_TRIGGER. New positions get their pyramid
//                ladder pre-staged in TWS.
//
// Auto-opened positions (Phase 3) are SKIPPED — they enter at full size with
// fills[1].pct === 1.0 and have no pyramid plan to enforce.
//
// Gated by IBKR_AUTO_SYNC_LOT_TRIGGERS — when off (default), the cron exits
// early after logging a diff summary so an admin can preview what WOULD
// happen before flipping the flag (mirrors stopRatchetCron Day 5 pattern).
//
// Demo sentinel: filter at query level + every enqueue() also rejects demo.

import { connectToDatabase, getUserProfile } from './database.js';
import {
  enqueue as enqueueOutbox,
  sanityCheckPlaceLotTrigger,
  sanityCheckModifyLotTrigger,
  buildStopOrderShape,
  DEMO_OWNER_ID,
} from './ibkrOutbox.js';
import {
  computeLotPlan,
  classifyLotCompletion,
  expectedLotTriggerAction,
  pairTwsOrdersToLots,
} from './lotMath.js';

// Default NAV when a user profile has none stored. Mirrors the client's
// defaultAccountSize so dry-run output is consistent with Assistant render.
const DEFAULT_NAV = 100_000;

// ── Core reconciliation ─────────────────────────────────────────────────────
// Pure-ish: db + dryRun flag in, structured report out. Called by the daily
// cron AND by POST /api/admin/sync-lot-triggers for on-demand inspection.
export async function runLotTriggerSync({ db, dryRun = false } = {}) {
  if (!db) db = await connectToDatabase();
  if (!db) return { error: 'NO_DB' };

  // 1. Active non-demo positions only.
  const positions = await db.collection('pnthr_portfolio').find({
    status:  { $in: ['ACTIVE', 'PARTIAL'] },
    ownerId: { $ne: DEMO_OWNER_ID },
  }).toArray();

  if (positions.length === 0) {
    return {
      reconciledAt: new Date(), positionsChecked: 0,
      placements: [], modifications: [], cancellations: [], adoptions: [], skips: [], aligned: [],
    };
  }

  // 2. Per-owner: load IBKR snapshot AND user NAV (drives sizePosition recompute).
  const ownerIds  = [...new Set(positions.map(p => p.ownerId))];
  const ibkrByOwner = new Map();
  const navByOwner  = new Map();
  for (const oid of ownerIds) {
    const ibkr    = await db.collection('pnthr_ibkr_positions').findOne({ ownerId: oid });
    ibkrByOwner.set(oid, ibkr || { positions: [], stopOrders: [] });
    // Use getUserProfile() so this cron's NAV matches the LIVE table's. Pre-fix
    // an inline findOne({ userId: oid }) was used here — but getUserProfile()
    // converts hex-24 userIds to ObjectId before querying, while this inline
    // version passed the plain string. Whichever shape the user_profiles doc
    // actually stores, only one path matched — the other returned null and
    // fell back to DEFAULT_NAV. That divergence produced different lot plans
    // (live table L4=3, cron L4=2 aligned), so the cron never enqueued the
    // MODIFY to align TWS to plan.
    const profile = await getUserProfile(oid);
    navByOwner.set(oid, +profile?.accountSize || DEFAULT_NAV);
  }

  const placements    = []; // PLACE_LOT_TRIGGER enqueues
  const modifications = []; // MODIFY_LOT_TRIGGER enqueues
  const cancellations = []; // CANCEL_ORDER enqueues (cleanup pass)
  const adoptions     = []; // TWS-tighter user overrides — silent, no enqueue
  const skips         = []; // unable to reconcile (no plan, no IBKR record, etc.)
  const aligned       = []; // already at-or-within tolerance

  const flagOn = process.env.IBKR_AUTO_SYNC_LOT_TRIGGERS === 'true';

  for (const p of positions) {
    const ticker = p.ticker?.toUpperCase();
    if (!ticker) { skips.push({ ticker: p.ticker, reason: 'NO_TICKER' }); continue; }

    // Skip auto-opened full-size positions — they have no pyramid plan.
    // Discriminator: Phase 3 sets fills[1].pct === 1.0 + autoOpenedByIBKR=true.
    if (p.autoOpenedByIBKR === true || p.fills?.[1]?.pct === 1.0) {
      skips.push({ ticker, reason: 'AUTO_OPENED_NO_PYRAMID_PLAN' });
      continue;
    }

    const ibkrSnap = ibkrByOwner.get(p.ownerId);
    const ibkrPos  = (ibkrSnap.positions || []).find(x => x.symbol?.toUpperCase() === ticker);
    if (!ibkrPos) { skips.push({ ticker, reason: 'IBKR_POSITION_MISSING' }); continue; }
    const ibkrShares = Math.abs(+ibkrPos.shares || 0);
    if (ibkrShares <= 0) { skips.push({ ticker, reason: 'IBKR_SHARES_ZERO' }); continue; }

    // Compute the canonical pyramid plan via the L1-aware algorithm shared
    // with the Live table (server/lotMath.js → computeLotPlan). Sizes off
    // ORIGINAL stop and the actual L1 fill so the cron's plan matches what
    // the user sees on screen — guarantees the cleanup pass doesn't flag
    // legitimate pending pyramid orders as stale (verified the hard way
    // during the 2026-04-30 dry run).
    const nav  = navByOwner.get(p.ownerId);
    const lots = classifyLotCompletion(
      computeLotPlan(p, nav),
      ibkrShares,
    );
    if (!lots.length || lots.every(l => l.targetShares <= 0)) {
      skips.push({ ticker, reason: 'PLAN_TOTAL_ZERO' }); continue;
    }

    // 3. Filter IBKR stop orders to lot-trigger candidates only — opposite
    //    action from the protective stop (BUY for LONG pyramid, SELL for SHORT).
    const isLong = (p.direction || 'LONG').toUpperCase() !== 'SHORT';
    const lotAction = expectedLotTriggerAction(p.direction);
    const candidateOrders = (ibkrSnap.stopOrders || []).filter(s =>
      s.symbol?.toUpperCase() === ticker
      && s.action === lotAction
      && (s.orderType === 'STP' || s.orderType === 'STP LMT')
    );

    // ── Pre-pass: pair candidate TWS orders to plan lots in price order ──────
    // Order-based pairing (lotMath.pairTwsOrdersToLots): the lowest BUY STP
    // for a LONG pyramid pairs with L2, next with L3, etc. — regardless of
    // anchor drift. Replaces the old closest-distance match which would shift
    // every order up one lot when the anchor moved (HOOD/IWM/MUR cases),
    // leaving L2 looking unmatched and L3-L5 seeing "looser" candidates that
    // failed the old tighter-only sanity check, so nothing ever got modified.
    // Extras beyond the lot count fall into trulyUnmatched (left alone).
    const { candidatesByLot, trulyUnmatched } = pairTwsOrdersToLots(candidateOrders, lots, isLong);
    for (const order of trulyUnmatched) {
      // Likely user-placed tactical order well outside the pyramid plan.
      // Leave it alone — janitor handles it iff position closes entirely.
      skips.push({
        ticker, reason: 'TWS_ORDER_UNMATCHED_TO_PLAN',
        permId: order.permId, stopPrice: order.stopPrice, shares: order.shares,
      });
    }

    // ── PASS 1+2: per-lot processing ─────────────────────────────────────────
    for (const lot of lots) {
      if (lot.lot === 1) continue; // L1 is the entry, never a trigger
      const candidates = candidatesByLot.get(lot.lot) || [];

      // CLEANUP: complete lot → cancel ALL candidates.
      if (lot.complete) {
        for (const order of candidates) {
          const enqRes = !dryRun && flagOn
            ? await enqueueOutbox(db, p.ownerId, 'CANCEL_ORDER', {
                ticker,
                permId:    order.permId,
                direction: isLong ? 'LONG' : 'SHORT',
                source:    'LOT_TRIGGER_CRON_CLEANUP',
                lot:       lot.lot,
                reason:    candidates.length > 1 ? 'DUPLICATE_AT_COMPLETE_LOT' : 'STALE_LOT_TRIGGER_PAST_CUMULATIVE',
              })
            : { skipped: dryRun ? 'DRY_RUN' : 'IBKR_AUTO_SYNC_LOT_TRIGGERS_OFF' };
          cancellations.push({
            ticker, lot: lot.lot, dir: isLong ? 'LONG' : 'SHORT',
            stalePrice: +order.stopPrice, staleShares: order.shares,
            ibkrShares, cumulativeTarget: lot.cumulativeTargetShares,
            permId: order.permId,
            enqueued:   !enqRes.skipped, outboxId: enqRes.id,
            skipReason: enqRes.skipped || null,
          });
        }
        continue;
      }

      // No candidates → falls through to PASS 3 (PLACE).
      if (candidates.length === 0) continue;

      // Pick the BEST candidate (closest to plan price). Cancel the rest as
      // duplicates — this is how the CSCO 7-orders-for-4-lots mess gets
      // cleaned up: the new canonical-price order stays, the stale-anchor
      // ones get cancelled.
      const planTrigger = lot.triggerPrice;
      const planShares  = lot.targetShares;
      candidates.sort((a, b) =>
        Math.abs(+a.stopPrice - planTrigger) - Math.abs(+b.stopPrice - planTrigger)
      );
      const best       = candidates[0];
      const duplicates = candidates.slice(1);

      // Cancel duplicates first.
      for (const dup of duplicates) {
        const enqRes = !dryRun && flagOn
          ? await enqueueOutbox(db, p.ownerId, 'CANCEL_ORDER', {
              ticker,
              permId:    dup.permId,
              direction: isLong ? 'LONG' : 'SHORT',
              source:    'LOT_TRIGGER_CRON_DEDUP',
              lot:       lot.lot,
              reason:    'DUPLICATE_AT_INCOMPLETE_LOT',
            })
          : { skipped: dryRun ? 'DRY_RUN' : 'IBKR_AUTO_SYNC_LOT_TRIGGERS_OFF' };
        cancellations.push({
          ticker, lot: lot.lot, dir: isLong ? 'LONG' : 'SHORT',
          stalePrice: +dup.stopPrice, staleShares: dup.shares,
          permId: dup.permId, reason: 'DEDUP',
          enqueued:   !enqRes.skipped, outboxId: enqRes.id,
          skipReason: enqRes.skipped || null,
        });
      }

      // Now align/modify the best candidate.
      const twsTrigger  = +best.stopPrice;
      const twsShares   = Math.abs(+best.shares || 0);
      const triggerDiff = Math.abs(twsTrigger - planTrigger);
      const sharesMatch = twsShares === planShares;

      if (triggerDiff < 0.05 && sharesMatch) {
        aligned.push({ ticker, lot: lot.lot, trigger: twsTrigger, shares: twsShares });
        continue;
      }

      // PNTHR plan is law for lot triggers. Drop the silent-adoption path —
      // any drift gets pushed to plan via MODIFY. Lot triggers aren't risk-
      // symmetric like protective stops (tighter trigger = MORE risk, not
      // less), so the tightest-wins rule doesn't apply. If the trader wants
      // a custom L_N entry price, they edit the plan in PNTHR (Command
      // Center / Pyramid modal), not in TWS.
      const sanity = sanityCheckModifyLotTrigger({
        position:        p,
        ibkrPosition:    { shares: ibkrShares, lastPrice: ibkrPos.lastPrice || p.currentPrice, avgCost: ibkrPos.avgCost },
        lot:             lot.lot,
        oldTriggerPrice: twsTrigger,
        newTriggerPrice: planTrigger,
        oldShares:       twsShares,
        newShares:       planShares,
      });
      const shape = buildStopOrderShape({
        stopPrice:         planTrigger,
        direction:         isLong ? 'LONG' : 'SHORT',
        stopExtendedHours: !!p.stopExtendedHours,
      });
      const enqRes = !dryRun && flagOn
        ? await enqueueOutbox(db, p.ownerId, 'MODIFY_LOT_TRIGGER', {
            ticker,
            direction:       isLong ? 'LONG' : 'SHORT',
            lot:             lot.lot,
            shares:          planShares,
            oldPermId:       best.permId,
            oldTriggerPrice: twsTrigger,
            newTriggerPrice: planTrigger,
            orderType:       shape.orderType,
            lmtPrice:        shape.lmtPrice,
            tif:             'GTC',
            rth:             shape.rth,
            positionId:      p.id,
            source:          'LOT_TRIGGER_CRON',
          }, { sanityCheck: sanity })
        : { skipped: dryRun ? 'DRY_RUN' : (flagOn ? 'UNKNOWN' : 'IBKR_AUTO_SYNC_LOT_TRIGGERS_OFF') };
      modifications.push({
        ticker, lot: lot.lot, dir: isLong ? 'LONG' : 'SHORT',
        from: { trigger: twsTrigger, shares: twsShares },
        to:   { trigger: planTrigger, shares: planShares },
        permId: best.permId,
        enqueued:   !enqRes.skipped, outboxId: enqRes.id,
        skipReason: enqRes.skipped || null,
      });
    }

    // ── PASS 3: PLACE for incomplete lots with NO matching TWS order ─────────
    for (const lot of lots) {
      if (lot.lot === 1) continue;          // L1 is the entry, never a trigger
      if (lot.complete) continue;           // Already filled/surpassed — covered by cleanup
      if ((candidatesByLot.get(lot.lot) || []).length > 0) continue; // Already has a TWS order

      const sanity = sanityCheckPlaceLotTrigger({
        position:     p,
        ibkrPosition: { shares: ibkrShares, lastPrice: ibkrPos.lastPrice || p.currentPrice, avgCost: ibkrPos.avgCost },
        lot:          lot.lot,
        triggerPrice: lot.triggerPrice,
        shares:       lot.targetShares,
      });
      if (!sanity.ok) {
        skips.push({ ticker, lot: lot.lot, reason: `PLACE_SANITY_${sanity.reason}` });
        continue;
      }
      const shape = buildStopOrderShape({
        stopPrice:         lot.triggerPrice,
        direction:         isLong ? 'LONG' : 'SHORT',
        stopExtendedHours: !!p.stopExtendedHours,
      });
      const enqRes = !dryRun && flagOn
        ? await enqueueOutbox(db, p.ownerId, 'PLACE_LOT_TRIGGER', {
            ticker,
            direction:    isLong ? 'LONG' : 'SHORT',
            lot:          lot.lot,
            shares:       lot.targetShares,
            triggerPrice: lot.triggerPrice,
            orderType:    shape.orderType,
            lmtPrice:     shape.lmtPrice,
            tif:          'GTC',
            rth:          shape.rth,
            positionId:   p.id,
            source:       'LOT_TRIGGER_CRON',
          }, { sanityCheck: sanity })
        : { skipped: dryRun ? 'DRY_RUN' : (flagOn ? 'UNKNOWN' : 'IBKR_AUTO_SYNC_LOT_TRIGGERS_OFF') };
      placements.push({
        ticker, lot: lot.lot, dir: isLong ? 'LONG' : 'SHORT',
        trigger: lot.triggerPrice, shares: lot.targetShares,
        cumulativeTarget: lot.cumulativeTargetShares,
        ibkrShares,
        enqueued:   !enqRes.skipped, outboxId: enqRes.id,
        skipReason: enqRes.skipped || null,
      });
    }
  }

  return {
    reconciledAt:     new Date(),
    positionsChecked: positions.length,
    dryRun,
    flagOn,
    placements,
    modifications,
    cancellations,
    adoptions,
    skips,
    aligned,
  };
}

// ── Cron registration helper (called from index.js startup) ────────────────
// 4:30 PM ET, Mon-Fri — same slot as stopRatchetCron. Both run after the
// close so the day's fills + manual TWS edits are settled before the diff
// is taken.
export function registerLotTriggerCron(cron) {
  cron.schedule('30 16 * * 1-5', async () => {
    console.log('[lotTriggerCron] Starting daily lot-trigger reconciliation…');
    try {
      const r = await runLotTriggerSync({});
      const summary = `checked=${r.positionsChecked} place=${r.placements.filter(x => x.enqueued).length} modify=${r.modifications.filter(x => x.enqueued).length} cancel=${r.cancellations.filter(x => x.enqueued).length} adopt=${r.adoptions.length} skip=${r.skips.length} align=${r.aligned.length}`;
      console.log(`[lotTriggerCron] Done — ${summary}${r.flagOn ? '' : ' (IBKR_AUTO_SYNC_LOT_TRIGGERS off — nothing enqueued)'}`);
    } catch (e) {
      console.error(`[lotTriggerCron] Failed: ${e.message}`);
    }
  }, { timezone: 'America/New_York' });
}
