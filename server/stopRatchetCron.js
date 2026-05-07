// server/stopRatchetCron.js
// ── Phase 4c — daily stop reconciliation cron (4:30 PM ET, Mon-Fri) ─────────
//
// Walks every ACTIVE non-demo PNTHR position, compares its stopPrice to the
// matching IBKR protective stop, and applies the universal tightest-wins
// rule:
//
//   • IBKR tighter than PNTHR  → silently adopt IBKR into PNTHR
//                                 (same write pattern as the manual
//                                 adoptTwsTighterStops.js script — append a
//                                 stopHistory entry tagged USER_TIGHTENED_VIA_TWS).
//                                 NEVER enqueues a write — preserves Scott's
//                                 manual TWS override.
//   • PNTHR tighter than IBKR  → enqueue MODIFY_STOP so the bridge cancels
//                                 the old stop and places the new tighter
//                                 one in TWS.
//   • Equal (within $0.01)     → no-op.
//
// Gated by IBKR_AUTO_SYNC_STOPS — when off (default), the cron exits early
// after logging a diff summary so an admin can preview what WOULD happen
// before flipping the flag (see Day 5 in PLAN_2026-04-29.md).
//
// Demo sentinel: this cron iterates ownerIds drawn from pnthr_portfolio.
// Demo accounts (ownerId === 'demo_fund') are filtered out at the query
// level — they never reach the enqueue stage. Belt-and-suspenders: enqueue()
// itself also rejects demo at every call site.

import { connectToDatabase } from './database.js';
import { enqueue as enqueueOutbox, sanityCheckModifyStop, sanityCheckPlaceStop, buildStopOrderShape, DEMO_OWNER_ID } from './ibkrOutbox.js';

const TIGHTER_THRESHOLD = 0.05; // ignore stop diffs below $0.05 (numerical noise)

// ── Core reconciliation logic ───────────────────────────────────────────────
// Pure-ish: takes db + dryRun flag. Returns a structured report so the admin
// endpoint can show the operator exactly what fired vs what was skipped.
export async function runStopRatchet({ db, dryRun = false } = {}) {
  if (!db) db = await connectToDatabase();
  if (!db) return { error: 'NO_DB' };

  // 1. Gather active non-demo positions.
  const positions = await db.collection('pnthr_portfolio').find({
    status:  { $in: ['ACTIVE', 'PARTIAL'] },
    ownerId: { $ne: DEMO_OWNER_ID },
  }).toArray();

  if (positions.length === 0) {
    return { reconciledAt: new Date(), positionsChecked: 0, adoptions: [], modifications: [], skips: [], aligned: [] };
  }

  // 2. For each unique ownerId, load that user's IBKR snapshot once.
  const ownerIds = [...new Set(positions.map(p => p.ownerId))];
  const ibkrByOwner = new Map();
  for (const oid of ownerIds) {
    const ibkr = await db.collection('pnthr_ibkr_positions').findOne({ ownerId: oid });
    ibkrByOwner.set(oid, ibkr || { positions: [], stopOrders: [] });
  }

  const adoptions     = []; // IBKR-tighter, PNTHR adopts silently (no enqueue)
  const modifications = []; // PNTHR-tighter, enqueue MODIFY_STOP
  const skips         = []; // unable to reconcile (no IBKR record, etc.)
  const aligned       = []; // already at-or-below threshold; no-op
  const orphanCancels = []; // stale PNTHR-tagged stops cancelled when a tighter user stop was adopted
  const nakedFixes    = []; // protective stop missing in TWS — enqueue PLACE_STOP to restore

  const flagOnSync = process.env.IBKR_AUTO_SYNC_STOPS === 'true';
  const flagOnPlace = process.env.IBKR_AUTO_PLACE_STOP === 'true';

  for (const p of positions) {
    const ticker = p.ticker?.toUpperCase();
    if (!ticker) { skips.push({ ticker: p.ticker, reason: 'NO_TICKER' }); continue; }

    const ibkrSnap = ibkrByOwner.get(p.ownerId);
    const ibkrPos  = (ibkrSnap.positions  || []).find(x => x.symbol?.toUpperCase() === ticker);
    if (!ibkrPos) { skips.push({ ticker, reason: 'IBKR_POSITION_MISSING' }); continue; }

    const isLong = (p.direction || 'LONG').toUpperCase() !== 'SHORT';
    const expectedAction = isLong ? 'SELL' : 'BUY';
    // Reference price for the protective-side filter — discriminates real
    // protective stops from lot-trigger BUY STPs (which are above price for
    // longs, below for shorts) so we never mistake a lot trigger for a
    // protective stop and adopt it as the position's exit.
    const refPrice = +ibkrPos.lastPrice || +p.currentPrice || 0;
    const allMatchingStops = (ibkrSnap.stopOrders || []).filter(s =>
      s.symbol?.toUpperCase() === ticker
      && s.action === expectedAction
      && (s.orderType === 'STP' || s.orderType === 'STP LMT')
    );
    const stops = refPrice > 0
      ? allMatchingStops.filter(s => {
          const sp = +s.stopPrice;
          if (!Number.isFinite(sp) || sp <= 0) return false;
          return isLong ? sp < refPrice : sp > refPrice;
        })
      : allMatchingStops;
    // Pick the TIGHTEST protective stop (highest for LONG, lowest for SHORT).
    // If multiple stops exist (e.g., user's tighter manual stop + PNTHR's
    // looser auto-placed stop), this ensures we adopt the user's intent.
    const protective = stops.length === 0 ? null
      : stops.reduce((best, s) =>
          (isLong ? +s.stopPrice > +best.stopPrice : +s.stopPrice < +best.stopPrice)
            ? s : best
        );
    if (!protective) {
      // NAKED — position has no protective stop in TWS. PNTHR has a stopPrice
      // on the position record (from auto-open or earlier user-tightening),
      // but the actual SELL/BUY STP isn't in IBKR. Could be: Phase 4b's
      // CANCEL_RELATED_ORDERS cancelled it during a prior partial close on
      // the same ticker; user manually cancelled in TWS; or auto-open never
      // placed it. Whatever caused it, we should re-place to restore protection.
      //
      // IWM 2026-05-06: ACTIVE 17 sh, PNTHR stopPrice=$282.65 from earlier
      // USER_TIGHTENED_VIA_TWS, but no SELL STP in IBKR. The screen showed
      // "NAKED" red but no cron acted on it.
      const pnthrStop = +p.stopPrice;
      const ibkrShares = Math.abs(+ibkrPos.shares || 0);
      if (!Number.isFinite(pnthrStop) || pnthrStop <= 0) {
        skips.push({ ticker, reason: 'NAKED_NO_PNTHR_STOP_TO_PLACE', ibkrShares });
        continue;
      }
      if (ibkrShares <= 0) {
        skips.push({ ticker, reason: 'NAKED_BUT_IBKR_ZERO' });
        continue;
      }
      const sanity = sanityCheckPlaceStop({
        position:     p,
        ibkrPosition: { shares: ibkrShares, lastPrice: refPrice, avgCost: ibkrPos.avgCost },
        stopPrice:    pnthrStop,
      });
      const shape = buildStopOrderShape({
        stopPrice:           pnthrStop,
        direction:           isLong ? 'LONG' : 'SHORT',
        stopExtendedHours:   !!p.stopExtendedHours,
      });
      const enqRes = sanity.ok && !dryRun && flagOnPlace
        ? await enqueueOutbox(db, p.ownerId, 'PLACE_STOP', {
            ticker,
            direction:  isLong ? 'LONG' : 'SHORT',
            shares:     ibkrShares,
            stopPrice:  pnthrStop,
            orderType:  shape.orderType,
            lmtPrice:   shape.lmtPrice,
            tif:        'GTC',
            rth:        shape.rth,
            positionId: p.id,
            source:     'STOP_RATCHET_NAKED_FIX',
          }, { sanityCheck: sanity })
        : { skipped: !sanity.ok ? sanity.reason : (dryRun ? 'DRY_RUN' : (flagOnPlace ? 'UNKNOWN' : 'IBKR_AUTO_PLACE_STOP_OFF')) };
      nakedFixes.push({
        ticker, dir: isLong ? 'LONG' : 'SHORT',
        stopPrice: pnthrStop, shares: ibkrShares,
        enqueued: !enqRes.skipped, outboxId: enqRes.id,
        skipReason: enqRes.skipped || null,
      });
      continue;
    }

    const pnthrStop = +p.stopPrice;
    const ibkrStop  = +protective.stopPrice;
    if (!Number.isFinite(pnthrStop) || !Number.isFinite(ibkrStop)) {
      skips.push({ ticker, reason: 'BAD_STOP_VALUE' }); continue;
    }

    const ibkrTighter  = isLong ? (ibkrStop  - pnthrStop > TIGHTER_THRESHOLD) : (pnthrStop  - ibkrStop  > TIGHTER_THRESHOLD);
    const pnthrTighter = isLong ? (pnthrStop - ibkrStop  > TIGHTER_THRESHOLD) : (ibkrStop  - pnthrStop  > TIGHTER_THRESHOLD);

    if (ibkrTighter) {
      // Silent adoption — never push back to IBKR.
      const historyEntry = {
        date:       new Date().toISOString().slice(0, 10),
        stop:       ibkrStop,
        reason:     'USER_TIGHTENED_VIA_TWS',
        from:       pnthrStop,
        ibkrPermId: protective.permId,
        source:     'STOP_RATCHET_CRON',
      };
      adoptions.push({ ticker, dir: isLong ? 'LONG' : 'SHORT', from: pnthrStop, to: ibkrStop, permId: protective.permId });
      if (!dryRun) {
        await db.collection('pnthr_portfolio').updateOne(
          { id: p.id, ownerId: p.ownerId },
          {
            $set:  { stopPrice: ibkrStop, updatedAt: new Date() },
            $push: { stopHistory: historyEntry },
          }
        );
      }

      // Orphan cleanup: when we adopt a tighter user stop, any OTHER protective
      // stop on this ticker that was placed by PNTHR (orderRef='PNTHR') is now
      // stale — the position has a single canonical stop, not two. Enqueue
      // CANCEL_ORDER to remove the orphan so TWS doesn't carry a redundant
      // looser stop that would fire if the user's tighter stop was later
      // hand-cancelled. Only target PNTHR-tagged stops; never touch the user's
      // own stops (orderRef empty/missing).
      const orphans = stops.filter(s =>
        s.permId !== protective.permId
        && (s.orderRef || '').trim().toUpperCase() === 'PNTHR'
      );
      for (const orphan of orphans) {
        if (dryRun || process.env.IBKR_AUTO_SYNC_STOPS !== 'true') {
          orphanCancels.push({ ticker, permId: orphan.permId, stopPrice: +orphan.stopPrice, enqueued: false, skipReason: dryRun ? 'DRY_RUN' : 'IBKR_AUTO_SYNC_STOPS_OFF' });
          continue;
        }
        const cancelResult = await enqueueOutbox(db, p.ownerId, 'CANCEL_ORDER', {
          ticker,
          permId:     orphan.permId,
          stopPrice:  +orphan.stopPrice,
          positionId: p.id,
          source:     'STOP_RATCHET_ORPHAN_CANCEL',
        });
        orphanCancels.push({
          ticker, permId: orphan.permId, stopPrice: +orphan.stopPrice,
          enqueued: !cancelResult.skipped,
          outboxId: cancelResult.id,
          skipReason: cancelResult.skipped || null,
        });
      }
    } else if (pnthrTighter) {
      // PNTHR has a tighter stop (likely from weekly ATR ratchet) — push to TWS.
      const sanity = sanityCheckModifyStop({
        position:     p,
        ibkrPosition: { shares: ibkrPos.shares, lastPrice: ibkrPos.lastPrice || p.currentPrice, avgCost: ibkrPos.avgCost },
        oldStopPrice: ibkrStop,
        newStopPrice: pnthrStop,
      });
      const shape = buildStopOrderShape({
        stopPrice:         pnthrStop,
        direction:         isLong ? 'LONG' : 'SHORT',
        stopExtendedHours: !!p.stopExtendedHours,
      });
      const enqueueResult = !dryRun && process.env.IBKR_AUTO_SYNC_STOPS === 'true'
        ? await enqueueOutbox(db, p.ownerId, 'MODIFY_STOP', {
            ticker,
            direction:    isLong ? 'LONG' : 'SHORT',
            shares:       Math.abs(+ibkrPos.shares || 0),
            oldPermId:    protective.permId,
            oldStopPrice: ibkrStop,
            newStopPrice: pnthrStop,
            orderType:    shape.orderType,
            lmtPrice:     shape.lmtPrice,
            tif:          'GTC',
            rth:          shape.rth,
            positionId:   p.id,
            source:       'STOP_RATCHET_CRON',
          }, { sanityCheck: sanity })
        : { skipped: dryRun ? 'DRY_RUN' : (process.env.IBKR_AUTO_SYNC_STOPS !== 'true' ? 'IBKR_AUTO_SYNC_STOPS_OFF' : 'UNKNOWN') };
      modifications.push({
        ticker, dir: isLong ? 'LONG' : 'SHORT',
        from: ibkrStop, to: pnthrStop,
        permId: protective.permId,
        enqueued: !enqueueResult.skipped,
        outboxId: enqueueResult.id,
        skipReason: enqueueResult.skipped || null,
      });
    } else {
      // Prices match within tolerance. Check SHARE COVERAGE — when a pyramid
      // lot fills (or any add grows the position) the protective stop's
      // share count needs to expand to cover the new total. The existing
      // ratchet only adjusts price; without this branch a 5-sh stop on an
      // 8-sh position stays at 5 sh forever (QQQ 2026-05-06).
      const stopShares = Math.abs(+protective.shares || 0);
      const posShares  = Math.abs(+ibkrPos.shares || 0);
      if (posShares > 0 && Number.isFinite(stopShares) && stopShares !== posShares) {
        // orderId=0 means the protective stop was placed in a prior TWS
        // session — IB API can't cancel it, so MODIFY (cancel+place) will
        // FAIL at the cancel phase. Hard-learned 2026-05-07: NVDA/TSLA/SMCI
        // accumulated 3 FAILED MODIFY_STOPs each before the failure backoff
        // kicked in, leaving the protective stop short-covered for hours.
        // Switch strategy for this case: place an ADDITIONAL PNTHR-tagged
        // SELL/BUY STP covering only the GAP shares at the same price.
        // When price hits the trigger, both stops fire — total coverage =
        // user stop shares + PNTHR gap stop shares = full position.
        const isUncancellableUserStop = (+protective.orderId === 0)
          && ((protective.orderRef || '').trim().toUpperCase() !== 'PNTHR');
        const gapShares = posShares - stopShares;
        const useGapPlace = isUncancellableUserStop && gapShares > 0;

        const shape = buildStopOrderShape({
          stopPrice:         pnthrStop,
          direction:         isLong ? 'LONG' : 'SHORT',
          stopExtendedHours: !!p.stopExtendedHours,
        });

        let enqRes;
        let cmdName;
        if (useGapPlace) {
          // PLACE gap-coverage stop (additive, leaves user stop alone).
          const sanity = sanityCheckPlaceStop({
            position:     p,
            ibkrPosition: { shares: gapShares, lastPrice: ibkrPos.lastPrice || p.currentPrice, avgCost: ibkrPos.avgCost },
            stopPrice:    pnthrStop,
          });
          cmdName = 'PLACE_STOP';
          enqRes = !dryRun && process.env.IBKR_AUTO_SYNC_STOPS === 'true' && flagOnPlace
            ? await enqueueOutbox(db, p.ownerId, 'PLACE_STOP', {
                ticker,
                direction:  isLong ? 'LONG' : 'SHORT',
                shares:     gapShares,
                stopPrice:  pnthrStop,
                orderType:  shape.orderType,
                lmtPrice:   shape.lmtPrice,
                tif:        'GTC',
                rth:        shape.rth,
                positionId: p.id,
                source:     'STOP_RATCHET_GAP_COVERAGE_USER_STOP_UNCANCELLABLE',
              }, { sanityCheck: sanity })
            : { skipped: dryRun ? 'DRY_RUN'
                  : (process.env.IBKR_AUTO_SYNC_STOPS !== 'true' ? 'IBKR_AUTO_SYNC_STOPS_OFF'
                  : (!flagOnPlace ? 'IBKR_AUTO_PLACE_STOP_OFF' : 'UNKNOWN')) };
        } else {
          // Standard MODIFY (cancel+place). Works when orderId is non-zero.
          const sanity = sanityCheckModifyStop({
            position:     p,
            ibkrPosition: { shares: ibkrPos.shares, lastPrice: ibkrPos.lastPrice || p.currentPrice, avgCost: ibkrPos.avgCost },
            oldStopPrice: ibkrStop,
            newStopPrice: pnthrStop,
          });
          cmdName = 'MODIFY_STOP';
          enqRes = !dryRun && process.env.IBKR_AUTO_SYNC_STOPS === 'true'
            ? await enqueueOutbox(db, p.ownerId, 'MODIFY_STOP', {
                ticker,
                direction:    isLong ? 'LONG' : 'SHORT',
                shares:       posShares,
                oldPermId:    protective.permId,
                oldStopPrice: ibkrStop,
                newStopPrice: pnthrStop,  // unchanged — only the share count moves
                orderType:    shape.orderType,
                lmtPrice:     shape.lmtPrice,
                tif:          'GTC',
                rth:          shape.rth,
                positionId:   p.id,
                source:       'STOP_RATCHET_SHARE_COVERAGE',
              }, { sanityCheck: sanity })
            : { skipped: dryRun ? 'DRY_RUN' : (process.env.IBKR_AUTO_SYNC_STOPS !== 'true' ? 'IBKR_AUTO_SYNC_STOPS_OFF' : 'UNKNOWN') };
        }
        modifications.push({
          ticker, dir: isLong ? 'LONG' : 'SHORT',
          from: { stop: ibkrStop, shares: stopShares },
          to:   { stop: pnthrStop, shares: posShares },
          reason: useGapPlace ? 'GAP_COVERAGE_PLACE_USER_STOP_UNCANCELLABLE' : 'SHARE_COVERAGE_GAP',
          command: cmdName,
          gapShares: useGapPlace ? gapShares : null,
          permId: protective.permId,
          enqueued: !enqRes.skipped,
          outboxId: enqRes.id,
          skipReason: enqRes.skipped || null,
        });
      } else {
        aligned.push({ ticker, stop: pnthrStop });
      }
    }
  }

  return {
    reconciledAt:     new Date(),
    positionsChecked: positions.length,
    dryRun,
    flagOn:           process.env.IBKR_AUTO_SYNC_STOPS === 'true',
    adoptions,
    modifications,
    skips,
    aligned,
    orphanCancels,
    nakedFixes,
  };
}

// ── Cron registration helper (called from index.js startup) ────────────────
// Wired once at server boot; runs at 4:30 PM ET Monday-Friday.
export function registerStopRatchetCron(cron) {
  // 4:30 PM ET = 16:30 in America/New_York. node-cron uses server local time
  // by default, so we set the timezone explicitly.
  cron.schedule('30 16 * * 1-5', async () => {
    console.log('[stopRatchetCron] Starting daily reconciliation…');
    try {
      const report = await runStopRatchet({});
      const summary = `checked=${report.positionsChecked} adopt=${report.adoptions.length} push=${report.modifications.filter(m => m.enqueued).length} skip=${report.skips.length} align=${report.aligned.length}`;
      console.log(`[stopRatchetCron] Done — ${summary}${report.flagOn ? '' : ' (IBKR_AUTO_SYNC_STOPS off — modifications NOT enqueued)'}`);
    } catch (e) {
      console.error(`[stopRatchetCron] Failed: ${e.message}`);
    }
  }, { timezone: 'America/New_York' });
}
