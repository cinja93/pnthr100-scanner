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
import { getCachedSignals } from './signalService.js';
import { blInitStop, ssInitStop, computeWilderATR } from './stopCalculation.js';

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
        // No stop on record — try to derive one from the weekly signal cache.
        const signalCache = getCachedSignals();
        const sig = signalCache?.[ticker];
        const signalStop = +(sig?.stopPrice || sig?.pnthrStop || 0);
        if (!Number.isFinite(signalStop) || signalStop <= 0) {
          // Fallback 2: compute structural stop from weekly bars (same as ibkrSync Fallback 4).
          // Signal cache may return null when the ticker's signal flipped (e.g. BL→SE) but
          // the position is still open under the original direction.
          let computedStop = null;
          try {
            const fromD = new Date();
            fromD.setDate(fromD.getDate() - 60);
            const fromStr = fromD.toISOString().split('T')[0];
            const url = `https://financialmodelingprep.com/api/v3/historical-price-full/${ticker}?from=${fromStr}&apikey=${process.env.FMP_API_KEY}`;
            const barRes = await fetch(url, { signal: AbortSignal.timeout(10000) });
            if (barRes.ok) {
              const barData = await barRes.json();
              const dailyBars = (barData?.historical || [])
                .map(b => ({ date: b.date, high: +b.high, low: +b.low, close: +b.close }))
                .sort((a, b) => a.date.localeCompare(b.date));
              const weekMap = new Map();
              for (const b of dailyBars) {
                const d = new Date(b.date + 'T12:00:00Z');
                const day = d.getDay();
                const mon = new Date(d);
                mon.setDate(mon.getDate() - ((day + 6) % 7));
                const wk = mon.toISOString().split('T')[0];
                if (!weekMap.has(wk)) weekMap.set(wk, { weekStart: wk, high: -Infinity, low: Infinity, close: 0 });
                const w = weekMap.get(wk);
                if (b.high > w.high) w.high = b.high;
                if (b.low < w.low) w.low = b.low;
                w.close = b.close;
              }
              const weeklyBars = [...weekMap.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
              if (weeklyBars.length >= 4) {
                const atrArr = computeWilderATR(weeklyBars);
                const lastWk = weeklyBars[weeklyBars.length - 1];
                const prev1  = weeklyBars[weeklyBars.length - 2];
                const prev2  = weeklyBars[weeklyBars.length - 3];
                const atr    = atrArr[atrArr.length - 1];
                if (isLong) {
                  const twoWeekLow = Math.min(prev1.low, prev2.low);
                  computedStop = blInitStop(twoWeekLow, lastWk.close, atr);
                } else {
                  const twoWeekHigh = Math.max(prev1.high, prev2.high);
                  computedStop = ssInitStop(twoWeekHigh, lastWk.close, atr);
                }
                const rightSide = isLong ? computedStop < refPrice : computedStop > refPrice;
                if (!computedStop || !rightSide) computedStop = null;
              }
            }
          } catch (e) {
            console.warn(`[stopRatchet] ${ticker} weekly-bar stop computation failed: ${e.message}`);
          }
          if (!computedStop) {
            skips.push({ ticker, reason: 'NAKED_NO_PNTHR_STOP_TO_PLACE', ibkrShares });
            continue;
          }
          // Use computed stop — write to position and fall through to place
          if (!dryRun) {
            await db.collection('pnthr_portfolio').updateOne(
              { id: p.id },
              { $set: { stopPrice: computedStop, originalStop: computedStop, updatedAt: new Date() } },
            );
            console.log(`[stopRatchet] ${ticker} NAKED — computed stop $${computedStop} from weekly bars, saved to position`);
          }
          const sanityComputed = sanityCheckPlaceStop({
            position:     { ...p, stopPrice: computedStop },
            ibkrPosition: { shares: ibkrShares, lastPrice: refPrice, avgCost: ibkrPos.avgCost },
            stopPrice:    computedStop,
          });
          const shapeComputed = buildStopOrderShape({
            stopPrice:         computedStop,
            direction:         isLong ? 'LONG' : 'SHORT',
            stopExtendedHours: !!p.stopExtendedHours,
          });
          const enqComputed = sanityComputed.ok && !dryRun && flagOnPlace
            ? await enqueueOutbox(db, p.ownerId, 'PLACE_STOP', {
                ticker,
                direction:  isLong ? 'LONG' : 'SHORT',
                shares:     ibkrShares,
                stopPrice:  computedStop,
                orderType:  shapeComputed.orderType,
                lmtPrice:   shapeComputed.lmtPrice,
                tif:        'GTC',
                rth:        shapeComputed.rth,
                positionId: p.id,
                source:     'STOP_RATCHET_NAKED_COMPUTED_FROM_WEEKLY_BARS',
              }, { sanityCheck: sanityComputed })
            : { skipped: !sanityComputed.ok ? sanityComputed.reason : (dryRun ? 'DRY_RUN' : (flagOnPlace ? 'UNKNOWN' : 'IBKR_AUTO_PLACE_STOP_OFF')) };
          nakedFixes.push({
            ticker, dir: isLong ? 'LONG' : 'SHORT',
            stopPrice: computedStop, shares: ibkrShares,
            derivedFromWeeklyBars: true,
            enqueued: !enqComputed.skipped, outboxId: enqComputed.id,
            skipReason: enqComputed.skipped || null,
          });
          continue;
        }
        // Write the derived stop to the position so future ticks don't re-derive.
        if (!dryRun) {
          await db.collection('pnthr_portfolio').updateOne(
            { id: p.id },
            { $set: { stopPrice: signalStop, originalStop: signalStop, updatedAt: new Date() } },
          );
          console.log(`[stopRatchet] ${ticker} NAKED — derived stop $${signalStop} from signal cache, saved to position`);
        }
        // Fall through to place the stop in TWS using the derived value.
        const sanityDerived = sanityCheckPlaceStop({
          position:     { ...p, stopPrice: signalStop },
          ibkrPosition: { shares: ibkrShares, lastPrice: refPrice, avgCost: ibkrPos.avgCost },
          stopPrice:    signalStop,
        });
        const shapeDerived = buildStopOrderShape({
          stopPrice:         signalStop,
          direction:         isLong ? 'LONG' : 'SHORT',
          stopExtendedHours: !!p.stopExtendedHours,
        });
        const enqDerived = sanityDerived.ok && !dryRun && flagOnPlace
          ? await enqueueOutbox(db, p.ownerId, 'PLACE_STOP', {
              ticker,
              direction:  isLong ? 'LONG' : 'SHORT',
              shares:     ibkrShares,
              stopPrice:  signalStop,
              orderType:  shapeDerived.orderType,
              lmtPrice:   shapeDerived.lmtPrice,
              tif:        'GTC',
              rth:        shapeDerived.rth,
              positionId: p.id,
              source:     'STOP_RATCHET_NAKED_DERIVED_FROM_SIGNAL',
            }, { sanityCheck: sanityDerived })
          : { skipped: !sanityDerived.ok ? sanityDerived.reason : (dryRun ? 'DRY_RUN' : (flagOnPlace ? 'UNKNOWN' : 'IBKR_AUTO_PLACE_STOP_OFF')) };
        nakedFixes.push({
          ticker, dir: isLong ? 'LONG' : 'SHORT',
          stopPrice: signalStop, shares: ibkrShares,
          derivedFromSignal: true,
          enqueued: !enqDerived.skipped, outboxId: enqDerived.id,
          skipReason: enqDerived.skipped || null,
        });
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
    if (!Number.isFinite(ibkrStop)) {
      skips.push({ ticker, reason: 'BAD_STOP_VALUE' }); continue;
    }
    if (!Number.isFinite(pnthrStop) || pnthrStop <= 0) {
      // CMD has no stop price (null) but IBKR already has one — adopt it.
      // This happens when a position was confirmed without a stop price and
      // the user manually placed the stop in TWS before PNTHR could compute one.
      if (!dryRun) {
        await db.collection('pnthr_portfolio').updateOne(
          { id: p.id, ownerId: p.ownerId },
          { $set: { stopPrice: ibkrStop, updatedAt: new Date() },
            $push: { stopHistory: { date: new Date().toISOString().slice(0,10), stop: ibkrStop, reason: 'NULL_STOP_ADOPTED_FROM_TWS', source: 'STOP_RATCHET_CRON' } } }
        );
      }
      adoptions.push({ ticker, dir: isLong ? 'LONG' : 'SHORT', from: null, to: ibkrStop, permId: protective.permId, reason: 'NULL_ADOPT' });
      continue;
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
      // If the existing IBKR stop has orderId=0 (placed in a prior TWS session,
      // uncancellable via API), MODIFY_STOP will always fail at the cancel phase.
      // Same strategy as the shares-coverage path: PLACE a new full-coverage stop
      // at the tighter price instead. The tighter stop fires first; the lower
      // orderId=0 stop fires into empty shares and gets rejected harmlessly.
      const isUncancellableUserStop = (+protective.orderId === 0)
        && ((protective.orderRef || '').trim().toUpperCase() !== 'PNTHR');
      const posShares = Math.abs(+ibkrPos.shares || 0);
      const shape = buildStopOrderShape({
        stopPrice:         pnthrStop,
        direction:         isLong ? 'LONG' : 'SHORT',
        stopExtendedHours: !!p.stopExtendedHours,
      });

      let enqueueResult;
      let cmdName;
      if (isUncancellableUserStop) {
        const sanity = sanityCheckPlaceStop({
          position:     p,
          ibkrPosition: { shares: posShares, lastPrice: ibkrPos.lastPrice || p.currentPrice, avgCost: ibkrPos.avgCost },
          stopPrice:    pnthrStop,
        });
        cmdName = 'PLACE_STOP';
        enqueueResult = !dryRun && process.env.IBKR_AUTO_SYNC_STOPS === 'true' && flagOnPlace
          ? await enqueueOutbox(db, p.ownerId, 'PLACE_STOP', {
              ticker,
              direction:  isLong ? 'LONG' : 'SHORT',
              shares:     posShares,
              stopPrice:  pnthrStop,
              orderType:  shape.orderType,
              lmtPrice:   shape.lmtPrice,
              tif:        'GTC',
              rth:        shape.rth,
              positionId: p.id,
              source:     'STOP_RATCHET_PNTHR_TIGHTER_UNCANCELLABLE',
            }, { sanityCheck: sanity })
          : { skipped: dryRun ? 'DRY_RUN' : (process.env.IBKR_AUTO_SYNC_STOPS !== 'true' ? 'IBKR_AUTO_SYNC_STOPS_OFF' : (!flagOnPlace ? 'IBKR_AUTO_PLACE_STOP_OFF' : 'UNKNOWN')) };
      } else {
        const sanity = sanityCheckModifyStop({
          position:     p,
          ibkrPosition: { shares: ibkrPos.shares, lastPrice: ibkrPos.lastPrice || p.currentPrice, avgCost: ibkrPos.avgCost },
          oldStopPrice: ibkrStop,
          newStopPrice: pnthrStop,
        });
        cmdName = 'MODIFY_STOP';
        enqueueResult = !dryRun && process.env.IBKR_AUTO_SYNC_STOPS === 'true'
          ? await enqueueOutbox(db, p.ownerId, 'MODIFY_STOP', {
              ticker,
              direction:    isLong ? 'LONG' : 'SHORT',
              shares:       posShares,
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
      }
      modifications.push({
        ticker, dir: isLong ? 'LONG' : 'SHORT',
        from: ibkrStop, to: pnthrStop,
        permId: protective.permId,
        cmd: cmdName,
        uncancellable: isUncancellableUserStop,
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
      // Sum ALL same-price stops as true coverage — not just the one picked
      // as "protective". When gap-coverage fired previously, multiple stops
      // exist at the same price (user's 85sh + PNTHR gap stops). Counting
      // only one undercounts coverage and causes runaway gap-stop placement.
      // DTCR 2026-05-07: 8 stops at $29.51 totalling ~679 shares for a 212
      // share position — every minute the cron picked one stop, saw an
      // illusory gap, placed another. Now: total coverage = sum of all
      // stops at protective.stopPrice ± $0.05.
      const protPriceKey = +protective.stopPrice;
      const sameSidePriceStops = stops.filter(s =>
        Math.abs((+s.stopPrice || 0) - protPriceKey) < 0.05
      );
      const stopShares = sameSidePriceStops.reduce((sum, s) => sum + Math.abs(+s.shares || 0), 0);
      const posShares  = Math.abs(+ibkrPos.shares || 0);
      if (posShares > 0 && Number.isFinite(stopShares) && stopShares < posShares) {
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
      } else if (sameSidePriceStops.length > 1 && stopShares > posShares) {
        // Over-stopped: duplicate protective stops at ~same price. Keep the
        // tightest (already selected as `protective`), cancel the rest.
        const dupes = sameSidePriceStops.filter(s => s.permId !== protective.permId);
        for (const dup of dupes) {
          if (+dup.orderId === 0) {
            skips.push({ ticker, reason: 'OVER_STOPPED_UNCANCELLABLE_ID_ZERO', permId: dup.permId });
            continue;
          }
          const cancelRes = !dryRun && flagOnSync
            ? await enqueueOutbox(db, p.ownerId, 'CANCEL_ORDER', {
                ticker,
                permId:     dup.permId,
                stopPrice:  +dup.stopPrice,
                positionId: p.id,
                direction:  isLong ? 'LONG' : 'SHORT',
                source:     'STOP_RATCHET_DEDUP_OVER_STOPPED',
                reason:     'DUPLICATE_PROTECTIVE_STOP',
              })
            : { skipped: dryRun ? 'DRY_RUN' : 'IBKR_AUTO_SYNC_STOPS_OFF' };
          orphanCancels.push({
            ticker, permId: dup.permId, stopPrice: +dup.stopPrice,
            enqueued: !cancelRes.skipped, skipReason: cancelRes.skipped || null,
          });
        }
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
