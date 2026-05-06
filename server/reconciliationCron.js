// server/reconciliationCron.js
// ── Unified every-minute reconciliation cron (market hours, Mon-Fri) ────────
//
// Replaces the two daily 4:30 PM ET crons (stopRatchetCron + lotTriggerCron).
// Calls runStopRatchet() then runLotTriggerSync() in sequence per tick so
// PNTHR <-> IBKR drift is detected within ~60s during market hours instead
// of once at close.
//
// Schedule: every minute, 9 AM - 4:59 PM ET, Monday - Friday (America/New_York).
//
// Gating (defense in depth):
//   1. RECONCILIATION_CRON_ENABLED env var — if not 'true', the cron is not
//      registered at all. Set to 'true' on Render only; leave unset on the
//      local Mac Node server so duplicate ticks against the same Atlas DB
//      cannot race. This is the per-environment writer gate.
//   2. IBKR_AUTO_SYNC_STOPS — gates whether runStopRatchet enqueues writes.
//      Off => observe + log only.
//   3. IBKR_AUTO_SYNC_LOT_TRIGGERS — same, for runLotTriggerSync.
//
// Concurrency: a simple in-process mutex prevents tick N+1 from starting
// while tick N is still running (e.g., on a slow Atlas response). Skipped
// ticks log one line so we can see they happened.
//
// Logging: one compact summary line per tick. Quiet ticks (no changes,
// no errors) log a short "ok" line so absence of output never masks a
// stuck cron; verbose detail only when something actually moved.

import { connectToDatabase }       from './database.js';
import { runStopRatchet }          from './stopRatchetCron.js';
import { runLotTriggerSync }       from './lotTriggerCron.js';
import { runOrphanCleanup }        from './orphanOrderJanitor.js';
import { runGhostReconcile }       from './ghostPositionReconciler.js';
import { runPositionReconciler }   from './positionReconciler.js';

const SCHEDULE = '* 9-16 * * 1-5'; // every minute, 9-16:59 ET, Mon-Fri
const TZ       = 'America/New_York';

let tickInProgress = false;

// Pad helper for HH:MM:SS prefix in log lines.
function ts() {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// One reconciliation pass. Reuses the same db handle across both run* calls
// so the Mongo client connection pool is shared. Returns a structured report
// or { error } so callers (cron + ad-hoc admin endpoint, if added later) can
// branch cleanly.
export async function runUnifiedReconciliation({ db, dryRun = false } = {}) {
  if (!db) db = await connectToDatabase();
  if (!db) return { error: 'NO_DB' };

  const startedAt = new Date();
  // Ghost reconciler runs FIRST: if it closes a position this tick, the
  // orphan janitor (which runs last) will see the ticker as no-longer-active
  // and clean up any leftover triggers in the same tick instead of waiting
  // a minute. recordExit() also fires Phase 4b CANCEL_RELATED_ORDERS
  // synchronously, so most of the time the orphans never make it to the
  // janitor at all — the cancel queues directly.
  const ghosts    = await runGhostReconcile({ db, dryRun });
  const ratchet   = await runStopRatchet({ db, dryRun });
  const lotTrig   = await runLotTriggerSync({ db, dryRun });
  const orphans   = await runOrphanCleanup({ db, dryRun });
  // Position reconciler runs LAST so any fills/exits that the earlier passes
  // (ghost, ratchet, lotTrig) have just written are reflected in the drift
  // calculation. Catches everything those passes can't: manual market buys
  // outside lot tolerance, partial sells the bridge dropped, historical
  // record drift inherited from old import-position imports, etc.
  const reconcile = await runPositionReconciler({ db, dryRun });
  const finishedAt = new Date();

  return {
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    dryRun,
    ghosts,
    ratchet,
    lotTrig,
    orphans,
    reconcile,
  };
}

// Cron registration. Called once at server startup from server/index.js.
// No-op (with one startup log line) when RECONCILIATION_CRON_ENABLED !== 'true'.
export function registerReconciliationCron(cron) {
  const enabled = process.env.RECONCILIATION_CRON_ENABLED === 'true';
  if (!enabled) {
    console.log('[reconciliation] DISABLED (set RECONCILIATION_CRON_ENABLED=true to enable). Schedule would be:', SCHEDULE, TZ);
    return;
  }

  console.log('[reconciliation] ENABLED — schedule:', SCHEDULE, TZ);

  cron.schedule(SCHEDULE, async () => {
    if (tickInProgress) {
      console.log(`[reconciliation] ${ts()} skip — previous tick still running`);
      return;
    }
    tickInProgress = true;
    try {
      const r = await runUnifiedReconciliation({});
      if (r.error) {
        console.error(`[reconciliation] ${ts()} ERROR ${r.error}`);
        return;
      }

      const gh = r.ghosts  || {};
      const ra = r.ratchet || {};
      const lt = r.lotTrig || {};
      const oj = r.orphans || {};
      const ghObserved = (gh.observed || []).length;
      const ghClosed   = (gh.closed   || []).length;
      const ghCleared  = (gh.cleared  || []).length;
      const ratchetAdopt  = (ra.adoptions     || []).length;
      const ratchetPush   = (ra.modifications || []).filter(m => m.enqueued).length;
      const ratchetAlign  = (ra.aligned       || []).length;
      const ratchetSkip   = (ra.skips         || []).length;
      const ltPlace       = (lt.placements    || []).filter(x => x.enqueued).length;
      const ltModify      = (lt.modifications || []).filter(x => x.enqueued).length;
      const ltCancel      = (lt.cancellations || []).filter(x => x.enqueued).length;
      const ltAdopt       = (lt.adoptions     || []).length;
      const ltSkip        = (lt.skips         || []).length;
      const ojOrphans     = (oj.orphans       || []).length;
      const ojEnq         = (oj.orphans       || []).filter(x => x.enqueued).length;
      const ojProtected   = oj.userOrdersProtected || 0;
      const rc = r.reconcile || {};
      const rcActions     = (rc.actions       || []).length;
      const rcSkips       = (rc.skips         || []).length;
      const rcAligned     = (rc.aligned       || []).length;

      const anyChange = ratchetAdopt || ratchetPush || ltPlace || ltModify || ltCancel || ltAdopt || ojEnq || ghObserved || ghClosed || ghCleared || rcActions;

      if (anyChange || ojOrphans) {
        console.log(
          `[reconciliation] ${ts()} checked=${ra.positionsChecked || 0}` +
          ` ghosts:obs=${ghObserved} closed=${ghClosed} cleared=${ghCleared}` +
          ` / ratchet:adopt=${ratchetAdopt} push=${ratchetPush} align=${ratchetAlign} skip=${ratchetSkip}` +
          ` / lotTrig:place=${ltPlace} modify=${ltModify} cancel=${ltCancel} adopt=${ltAdopt} skip=${ltSkip}` +
          ` / orphans:found=${ojOrphans} enq=${ojEnq} userProtected=${ojProtected}` +
          ` / drift:actions=${rcActions} aligned=${rcAligned} skip=${rcSkips}` +
          ` (${r.durationMs}ms${gh.flagOn ? '' : ' GHOSTS_FLAG_OFF'}${ra.flagOn ? '' : ' RATCHET_FLAG_OFF'}${lt.flagOn ? '' : ' LOTTRIG_FLAG_OFF'}${oj.flagOn ? '' : ' ORPHANS_FLAG_OFF'})`
        );
      } else {
        console.log(`[reconciliation] ${ts()} ok checked=${ra.positionsChecked || 0} aligned=${rcAligned} (${r.durationMs}ms)`);
      }
    } catch (e) {
      console.error(`[reconciliation] ${ts()} FAILED: ${e.message}`);
    } finally {
      tickInProgress = false;
    }
  }, { timezone: TZ });
}
