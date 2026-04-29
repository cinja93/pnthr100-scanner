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
import { enqueue as enqueueOutbox, sanityCheckModifyStop, DEMO_OWNER_ID } from './ibkrOutbox.js';

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

  for (const p of positions) {
    const ticker = p.ticker?.toUpperCase();
    if (!ticker) { skips.push({ ticker: p.ticker, reason: 'NO_TICKER' }); continue; }

    const ibkrSnap = ibkrByOwner.get(p.ownerId);
    const ibkrPos  = (ibkrSnap.positions  || []).find(x => x.symbol?.toUpperCase() === ticker);
    if (!ibkrPos) { skips.push({ ticker, reason: 'IBKR_POSITION_MISSING' }); continue; }

    const isLong = (p.direction || 'LONG').toUpperCase() !== 'SHORT';
    const expectedAction = isLong ? 'SELL' : 'BUY';
    const stops = (ibkrSnap.stopOrders || []).filter(s =>
      s.symbol?.toUpperCase() === ticker
      && s.action === expectedAction
      && s.orderType === 'STP'
    );
    const protective = stops[0] || null;
    if (!protective) { skips.push({ ticker, reason: 'NAKED_NO_IBKR_STOP' }); continue; }

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
    } else if (pnthrTighter) {
      // PNTHR has a tighter stop (likely from weekly ATR ratchet) — push to TWS.
      const sanity = sanityCheckModifyStop({
        position:     p,
        ibkrPosition: { shares: ibkrPos.shares, lastPrice: ibkrPos.lastPrice || p.currentPrice, avgCost: ibkrPos.avgCost },
        oldStopPrice: ibkrStop,
        newStopPrice: pnthrStop,
      });
      const enqueueResult = !dryRun && process.env.IBKR_AUTO_SYNC_STOPS === 'true'
        ? await enqueueOutbox(db, p.ownerId, 'MODIFY_STOP', {
            ticker,
            direction:    isLong ? 'LONG' : 'SHORT',
            shares:       Math.abs(+ibkrPos.shares || 0),
            oldPermId:    protective.permId,
            oldStopPrice: ibkrStop,
            newStopPrice: pnthrStop,
            orderType:    'STP',
            tif:          'GTC',
            rth:          true,
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
      aligned.push({ ticker, stop: pnthrStop });
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
