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
  sanityCheckBuyMarketToCatchUp,
  buildStopOrderShape,
  DEMO_OWNER_ID,
} from './ibkrOutbox.js';
import {
  computeLotPlan,
  classifyLotCompletion,
  expectedLotTriggerAction,
  pairTwsOrdersToLots,
  computeCatchUpRebalance,
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
  const missedLots    = []; // step 3: lots where price has crossed trigger w/o fill (catch-up flagged)
  const catchUps      = []; // step 5: catch-up market orders enqueued (or skipped w/ reason)

  // ── RTH gate for catch-up firing (step 5) ──────────────────────────────
  // Catch-up market orders only fire during regular trading hours. The
  // detection (step 3) runs 24/7 and writes pendingCatchUp; the firing
  // (here) holds for next RTH tick. Gives a clean MKT fill and avoids
  // pre-market gap chaos (IBKR rejects MKT outside RTH anyway).
  //
  // Window: 9:30 AM – 3:55 PM ET, Monday-Friday. Trader directive 2026-05-07
  // moved this from 9:35 to 9:30 — fire at the bell to minimize the time
  // a missed lot is uncovered. The OPEN_BLACKOUT in ibkrOutbox.isInBlackoutWindow
  // is exempted for BUY_MARKET_TO_CATCH_UP so the 9:30 fire isn't blocked
  // by the 9:25-9:35 blanket window.
  const isRthForCatchUp = (() => {
    const now = new Date();
    const et  = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day = et.getDay(); // 0=Sun, 6=Sat
    if (day === 0 || day === 6) return false;
    const minutes = et.getHours() * 60 + et.getMinutes();
    return minutes >= 570 && minutes <= 955; // 9:30 - 15:55 ET
  })();

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

    // Pre-compute the projected pyramid total from the canonical lot plan so
    // sanity checks use the correct denominator. position.fills doesn't store
    // targetShares for IBKR_IMPORT positions, so the in-place recomputation
    // inside the sanity check would underestimate the total (UBER 2026-05-06:
    // 12 sh L1, fills[2-5] empty, sanity computed denom=12 instead of plan
    // total 34, rejected L2=8sh as exceeding 50%).
    const planProjectedTotal = lots.reduce((s, l) => s + (+l.targetShares || 0), 0);

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
        projectedTotal:  planProjectedTotal,
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
        position:        p,
        ibkrPosition:    { shares: ibkrShares, lastPrice: ibkrPos.lastPrice || p.currentPrice, avgCost: ibkrPos.avgCost },
        lot:             lot.lot,
        triggerPrice:    lot.triggerPrice,
        shares:          lot.targetShares,
        projectedTotal:  planProjectedTotal,
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

    // ── PASS 4: MISSED-LOT DETECTION (step 3 of catch-up feature) ───────────
    // Detect lots where price has CROSSED the trigger but no fill happened
    // (BUY/SELL STP was cancelled, never placed, or fired without filling).
    // Sets `pendingCatchUp` flag on the position. Step 5 of the feature will
    // read this flag during RTH and fire the catch-up market order.
    //
    // Eligibility: only L2/L3/L4 (per design — chasing L5 at an even higher
    // price is bad risk/reward, so missed L5 just gets skipped).
    //
    // Threshold: price ≥ trigger + 5 ticks ($0.05 for stocks > $1). This
    // avoids flagging on a one-tick fluctuation across the trigger.
    const TICK_SIZE   = 0.01;
    const MISS_TICKS  = 5;
    const missThresh  = TICK_SIZE * MISS_TICKS;
    const currPrice   = +ibkrPos?.marketPrice || +p.currentPrice || 0;
    let detectedMiss  = null;
    if (currPrice > 0) {
      for (const lot of lots) {
        if (lot.lot < 2 || lot.lot > 4) continue;     // only L2-L4 eligible
        if (lot.filled || lot.complete) continue;     // already filled / surpassed
        const triggerCrossed = isLong
          ? currPrice >= lot.triggerPrice + missThresh
          : currPrice <= lot.triggerPrice - missThresh;
        if (!triggerCrossed) continue;
        // First eligible miss in lot order wins (catch up the LOWEST missed
        // lot first — it has the most leverage on avg cost).
        detectedMiss = {
          lot: lot.lot,
          triggerPrice: lot.triggerPrice,
          currentPrice: currPrice,
          plannedShares: lot.targetShares,
          detectedAt: new Date(),
        };
        break;
      }
    }
    // Persist or clear the pendingCatchUp flag.
    const existingFlag = p.pendingCatchUp || null;
    if (detectedMiss && (!existingFlag || existingFlag.lot !== detectedMiss.lot)) {
      // New miss or different lot — write/overwrite the flag.
      if (!dryRun) {
        await db.collection('pnthr_portfolio').updateOne(
          { id: p.id, ownerId: p.ownerId },
          { $set: { pendingCatchUp: detectedMiss, updatedAt: new Date() } }
        );
      }
      missedLots.push({ ticker, ...detectedMiss, flagWritten: !dryRun, prior: existingFlag?.lot || null });
    } else if (!detectedMiss && existingFlag) {
      // Previously flagged but no longer missed (lot must have been filled or
      // price retreated). Clear the flag so the catch-up step doesn't fire
      // for a stale state. Note: clearing on price retreat is intentional —
      // if price drops back below trigger, we want the original BUY STP to
      // handle it, not a catch-up.
      if (!dryRun) {
        await db.collection('pnthr_portfolio').updateOne(
          { id: p.id, ownerId: p.ownerId },
          { $unset: { pendingCatchUp: '' }, $set: { updatedAt: new Date() } }
        );
      }
      missedLots.push({ ticker, lot: existingFlag.lot, cleared: true, flagWritten: !dryRun });
    } else if (detectedMiss && existingFlag && existingFlag.lot === detectedMiss.lot) {
      // Same lot still missed — no DB write needed, but report it so the
      // dryRun output is honest about what's pending.
      missedLots.push({ ticker, ...detectedMiss, flagWritten: false, alreadyFlagged: true });
    }

    // ── PASS 5: CATCH-UP FIRING (step 5 of catch-up feature) ────────────────
    // If the position has a pendingCatchUp flag AND we're inside RTH AND the
    // missed condition is still real (price still past trigger), compute the
    // catch-up + rebalance math and enqueue a BUY_MARKET_TO_CATCH_UP. After
    // the bridge fires it and we see the fill via ibkrSync, step 6 will
    // rewrite L_{N+1}..L5 share counts on the position.
    const flag = detectedMiss || existingFlag;
    if (flag && flag.lot >= 2 && flag.lot <= 4) {
      // Skip outside RTH — wait for next eligible tick.
      if (!isRthForCatchUp) {
        catchUps.push({ ticker, lot: flag.lot, skipped: 'OUTSIDE_RTH', detectedAt: flag.detectedAt });
      } else if (!p.targetAvg) {
        // No locked target avg → can't compute rebalance. Skip + log; user
        // may need to backfill targetAvg for older positions.
        catchUps.push({ ticker, lot: flag.lot, skipped: 'NO_TARGET_AVG' });
      } else {
        // Recompute Pa from CURRENT price (may differ from detection-time
        // price if hours have passed waiting for RTH).
        const Pa = +ibkrPos?.marketPrice || +p.currentPrice || 0;
        if (Pa <= 0) {
          catchUps.push({ ticker, lot: flag.lot, skipped: 'NO_LIVE_PRICE' });
        } else {
          const rebal = computeCatchUpRebalance({
            position:     p,
            netLiquidity: nav,
            missedLot:    flag.lot,
            currentPrice: Pa,
            targetAvg:    p.targetAvg,
          });
          if (!rebal.ok) {
            catchUps.push({ ticker, lot: flag.lot, skipped: `REBAL_${rebal.reason}` });
          } else {
            // ── Cap-aware shrinkage ─────────────────────────────────────
            // If post-catch-up notional ≥ 10% NAV, shrink upper lots from
            // top down (L5 → L4 → L3 — only those above missedLot in newUpperShares)
            // by 1 share at a time until under cap. If we run out of upper
            // lots and still over cap, refuse with MISSED_LOT_CAP_UNRESOLVABLE.
            const tickerNotionalAfter = (saShares, upperShares) =>
              (Math.abs(+ibkrPos.shares || 0) + saShares) * Pa
              + upperShares.reduce((s, u) => s + u.shares * u.triggerPrice, 0);
            const capDollar = 0.10 * nav;
            // Note: the cap rule in ibkrOutbox is a current-notional check.
            // Here we model the projected post-fill cap so we can pre-shrink
            // BEFORE enqueue, rather than getting silently rejected later.
            // Walk upper lots HIGH→LOW (L5 first) reducing by 1 sh per pass.
            const upperDesc = rebal.newUpperShares.slice().sort((a, b) => b.lot - a.lot);
            let safetyIters = 200;
            while (
              safetyIters-- > 0 &&
              tickerNotionalAfter(rebal.Sa, rebal.newUpperShares) > capDollar
            ) {
              // Find the highest-lot row with shares > 0 and decrement.
              const target = upperDesc.find(u => u.shares > 0);
              if (!target) break; // can't reduce further from upper
              target.shares -= 1;
              // (rebal.newUpperShares and upperDesc share refs — both updated)
            }
            const stillOver = tickerNotionalAfter(rebal.Sa, rebal.newUpperShares) > capDollar;
            if (stillOver) {
              // Try reducing Sa as last resort.
              while (
                safetyIters-- > 0 &&
                rebal.Sa > 1 &&
                tickerNotionalAfter(rebal.Sa, rebal.newUpperShares) > capDollar
              ) {
                rebal.Sa -= 1;
              }
              if (tickerNotionalAfter(rebal.Sa, rebal.newUpperShares) > capDollar) {
                catchUps.push({ ticker, lot: flag.lot, skipped: 'MISSED_LOT_CAP_UNRESOLVABLE' });
              }
            }

            // Final feasibility check: still positive Sa and positive notional?
            if (!stillOver || tickerNotionalAfter(rebal.Sa, rebal.newUpperShares) <= capDollar) {
              const sanity = sanityCheckBuyMarketToCatchUp({
                position:     p,
                ibkrPosition: { shares: ibkrShares, lastPrice: ibkrPos.marketPrice || p.currentPrice, avgCost: ibkrPos.avgCost },
                lot:          flag.lot,
                shares:       rebal.Sa,
                currentPrice: Pa,
              });
              const enqRes = sanity.ok && !dryRun && flagOn
                ? await enqueueOutbox(db, p.ownerId, 'BUY_MARKET_TO_CATCH_UP', {
                    ticker,
                    direction:    isLong ? 'LONG' : 'SHORT',
                    lot:          flag.lot,
                    shares:       rebal.Sa,
                    currentPrice: Pa,
                    triggerPrice: flag.triggerPrice,
                    targetAvg:    p.targetAvg,
                    positionId:   p.id,
                    source:       'LOT_TRIGGER_CRON_CATCHUP',
                  }, { sanityCheck: sanity })
                : { skipped: !sanity.ok ? sanity.reason : (dryRun ? 'DRY_RUN' : (flagOn ? 'UNKNOWN' : 'IBKR_AUTO_SYNC_LOT_TRIGGERS_OFF')) };
              // Persist the rebalance plan on the position so step 6 can read
              // it after the fill confirms (without re-doing the math against
              // a different current price).
              if (!dryRun && enqRes.id) {
                await db.collection('pnthr_portfolio').updateOne(
                  { id: p.id, ownerId: p.ownerId },
                  { $set: {
                      catchUpRebalancePlan: {
                        missedLot:      flag.lot,
                        Sa:             rebal.Sa,
                        catchUpPrice:   Pa,
                        newUpperShares: rebal.newUpperShares,
                        finalAvg:       rebal.finalAvg,
                        outboxId:       enqRes.id,
                        plannedAt:      new Date(),
                      },
                      updatedAt: new Date(),
                    } }
                );
              }
              catchUps.push({
                ticker, lot: flag.lot, dir: isLong ? 'LONG' : 'SHORT',
                Sa: rebal.Sa, Pa, targetAvg: p.targetAvg, finalAvg: rebal.finalAvg,
                newUpperShares: rebal.newUpperShares,
                enqueued: !enqRes.skipped, outboxId: enqRes.id,
                skipReason: enqRes.skipped || null,
              });
            }
          }
        }
      }
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
    missedLots,
    catchUps,
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
