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

import { connectToDatabase } from './database.js';
import {
  enqueue as enqueueOutbox,
  sanityCheckPlaceLotTrigger,
  sanityCheckModifyLotTrigger,
  buildStopOrderShape,
  DEMO_OWNER_ID,
} from './ibkrOutbox.js';
import {
  computeLotTriggers,
  classifyLotCompletion,
  expectedLotTriggerAction,
  matchTwsOrderToLot,
  sizePosition,
  isEtfTicker,
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
    const profile = await db.collection('user_profiles').findOne({ userId: oid });
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

    // Recompute the pyramid plan using current NAV. Lot 1 anchor is fixed
    // post-fill so trigger prices are stable; total shares (and therefore
    // per-lot share counts) drift with NAV.
    const nav   = navByOwner.get(p.ownerId);
    const isETF = !!p.isETF || isEtfTicker(ticker);
    const sizing = sizePosition({
      netLiquidity: nav,
      entryPrice:   +p.entryPrice,
      stopPrice:    +p.stopPrice,
      maxGapPct:    +p.maxGapPct || 0,
      isETF,
    });
    if (!sizing.totalShares || sizing.totalShares <= 0) {
      skips.push({ ticker, reason: 'PLAN_TOTAL_ZERO' }); continue;
    }
    const lots = classifyLotCompletion(
      computeLotTriggers({ position: p, totalShares: sizing.totalShares }),
      ibkrShares,
    );

    // 3. Filter IBKR stop orders to lot-trigger candidates only — opposite
    //    action from the protective stop (BUY for LONG pyramid, SELL for SHORT).
    const isLong = (p.direction || 'LONG').toUpperCase() !== 'SHORT';
    const lotAction = expectedLotTriggerAction(p.direction);
    const candidateOrders = (ibkrSnap.stopOrders || []).filter(s =>
      s.symbol?.toUpperCase() === ticker
      && s.action === lotAction
      && (s.orderType === 'STP' || s.orderType === 'STP LMT')
    );

    // Track which lots have been matched to a TWS order (for the PLACE pass).
    const matchedLotNums = new Set();

    // ── PASS 1: CLEANUP + PASS 2: MODIFY/ADOPT ────────────────────────────────
    for (const order of candidateOrders) {
      const matchedLot = matchTwsOrderToLot(order, lots);
      if (!matchedLot) {
        // Order doesn't sit at any plan lot price — leave it alone (could be
        // a tactical user-placed order outside the pyramid plan). Log only.
        skips.push({
          ticker, reason: 'TWS_ORDER_UNMATCHED_TO_PLAN',
          permId: order.permId, stopPrice: order.stopPrice, shares: order.shares,
        });
        continue;
      }
      matchedLotNums.add(matchedLot.lot);

      // CLEANUP pass: matched a complete lot → stale, must cancel.
      // (SWKS pattern — manual market-buy past the trigger left the order
      // dangling; could over-allocate if price re-trips the level.)
      if (matchedLot.complete) {
        const enqRes = !dryRun && flagOn
          ? await enqueueOutbox(db, p.ownerId, 'CANCEL_ORDER', {
              ticker,
              permId:    order.permId,
              direction: isLong ? 'LONG' : 'SHORT',
              source:    'LOT_TRIGGER_CRON_CLEANUP',
              lot:       matchedLot.lot,
              reason:    'STALE_LOT_TRIGGER_PAST_CUMULATIVE',
            })
          : { skipped: dryRun ? 'DRY_RUN' : 'IBKR_AUTO_SYNC_LOT_TRIGGERS_OFF' };
        cancellations.push({
          ticker, lot: matchedLot.lot, dir: isLong ? 'LONG' : 'SHORT',
          stalePrice: +order.stopPrice, staleShares: order.shares,
          ibkrShares, cumulativeTarget: matchedLot.cumulativeTargetShares,
          permId: order.permId,
          enqueued:   !enqRes.skipped, outboxId: enqRes.id,
          skipReason: enqRes.skipped || null,
        });
        continue;
      }

      // MODIFY/ADOPT pass: incomplete lot with a TWS order present.
      const twsTrigger    = +order.stopPrice;
      const twsShares     = Math.abs(+order.shares || 0);
      const planTrigger   = matchedLot.triggerPrice;
      const planShares    = matchedLot.targetShares;
      const triggerDiff   = Math.abs(twsTrigger - planTrigger);
      const triggerLooser = isLong ? twsTrigger > planTrigger : twsTrigger < planTrigger;
      const sharesMatch   = twsShares === planShares;

      if (triggerDiff < 0.05 && sharesMatch) {
        aligned.push({ ticker, lot: matchedLot.lot, trigger: twsTrigger, shares: twsShares });
        continue;
      }

      // TWS-tighter or share-override → silent adoption (no enqueue).
      // The order stays as Scott set it; PNTHR doesn't push back.
      if (!triggerLooser || !sharesMatch) {
        adoptions.push({
          ticker, lot: matchedLot.lot, dir: isLong ? 'LONG' : 'SHORT',
          tws: { trigger: twsTrigger, shares: twsShares },
          plan: { trigger: planTrigger, shares: planShares },
          reason: !sharesMatch ? 'USER_SHARE_OVERRIDE' : 'TWS_TRIGGER_TIGHTER',
        });
        continue;
      }

      // PNTHR-tighter trigger AND shares match → push to TWS via MODIFY.
      const sanity = sanityCheckModifyLotTrigger({
        position:        p,
        ibkrPosition:    { shares: ibkrShares, lastPrice: ibkrPos.lastPrice || p.currentPrice, avgCost: ibkrPos.avgCost },
        lot:             matchedLot.lot,
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
            lot:             matchedLot.lot,
            shares:          planShares,
            oldPermId:       order.permId,
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
        ticker, lot: matchedLot.lot, dir: isLong ? 'LONG' : 'SHORT',
        from: { trigger: twsTrigger, shares: twsShares },
        to:   { trigger: planTrigger, shares: planShares },
        permId: order.permId,
        enqueued:   !enqRes.skipped, outboxId: enqRes.id,
        skipReason: enqRes.skipped || null,
      });
    }

    // ── PASS 3: PLACE for incomplete lots with NO matching TWS order ─────────
    for (const lot of lots) {
      if (lot.lot === 1) continue;          // L1 is the entry, never a trigger
      if (lot.complete) continue;           // Already filled/surpassed — covered by cleanup
      if (matchedLotNums.has(lot.lot)) continue; // Already has a TWS order

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
