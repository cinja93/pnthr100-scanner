// server/bridgeHealthMonitor.js
// ── Server-side bridge/outbox health alarm (2026-07-06 audit, critical #4) ────
//
// The gap this closes: when the IBKR bridge on the trading Mac dies or zombies
// (a known failure mode through TWS's nightly restart), the engine's safety
// gates hold — entries stop on the stale snapshot, resting stops keep protecting
// the book — but NOTHING TELLS ANYONE. Stop ratchets queue unexecuted, fills go
// unrecorded, and the only evidence is an ENTRY_GATE_SKIP line in Render logs.
// Worse, the only stuck-command promoter (ibkrOutbox.flagStuck) was invoked by
// the bridge itself — the component whose death it is supposed to report.
//
// This monitor runs on a server cron (writer-gated) every 2 minutes during
// market hours and:
//   1. Checks the latest IBKR snapshot age — > STALE_MIN during the session with
//      Tree mode not 'off' means the bridge is down/zombied.
//   2. Promotes EXECUTING commands older than 5 min to STUCK in BOTH outboxes
//      (main + ambush) — server-side, so a dead bridge can't hide them.
//   3. Counts recent FAILED ambush commands (a failing-loop signal, e.g. stop
//      rejected on margin, previously visible only in Render logs).
//   4. Surfaces the result three ways: pnthr_tree_config.bridgeHealth (the Tree
//      page can banner it), a durable pnthr_ops_alerts record on each ok→bad
//      transition (no per-minute spam), and a best-effort ops email.
//
// It never places, cancels, or retries orders — observe and alarm only.
// ─────────────────────────────────────────────────────────────────────────────

import { flagStuck as flagStuckMainOutbox } from './ibkrOutbox.js';
import { sendOpsAlertEmail } from './emailService.js';

const SNAPSHOT_STALE_MIN = 5;    // bridge pushes every ~60s; 5 min = clearly dead
const STUCK_MS           = 5 * 60 * 1000;
const FAILED_WINDOW_MS   = 15 * 60 * 1000;
const FAILED_STREAK      = 3;    // >= this many FAILED in the window → alarm

function etSessionNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
  }).formatToParts(now);
  const o = {}; for (const p of parts) o[p.type] = p.value;
  let h = parseInt(o.hour, 10); if (h === 24) h = 0;
  const min = h * 60 + parseInt(o.minute, 10);
  const weekday = !['Sat', 'Sun'].includes(o.weekday);
  return { inSession: weekday && min >= 570 && min <= 960 };   // 9:30–16:00 ET
}

// Promote stale-EXECUTING ambush commands to STUCK (the ambush outbox had no
// flagStuck at all). STUCK is invisible to the bridge poller (PENDING only) and
// to the engine's in-flight dedup (which is time-bounded anyway) — safe, and it
// makes the abandoned command visible instead of silently EXECUTING forever.
export async function flagStuckAmbushOutbox(db) {
  const cutoff = new Date(Date.now() - STUCK_MS);
  const r = await db.collection('pnthr_ambush_outbox').updateMany(
    { status: 'EXECUTING', executingAt: { $lt: cutoff } },
    { $set: { status: 'STUCK', stuckAt: new Date() } },
  );
  return r.modifiedCount;
}

export async function runBridgeHealthCheck(db) {
  const { inSession } = etSessionNow();
  const cfg = (await db.collection('pnthr_tree_config').findOne({}, { projection: { mode: 1, bridgeHealth: 1 } })) || {};
  const mode = cfg.mode || 'off';

  // Snapshot freshness (the bridge's heartbeat).
  const snap = (await db.collection('pnthr_ibkr_positions').find({}).sort({ syncedAt: -1 }).limit(1).toArray())[0];
  const ageMin = snap?.syncedAt ? (Date.now() - new Date(snap.syncedAt).getTime()) / 60000 : Infinity;

  // Stuck commands — promote server-side in both outboxes.
  let stuckMain = 0, stuckAmbush = 0;
  try { stuckMain = await flagStuckMainOutbox(db); } catch (e) { console.error('[BridgeHealth] flagStuck(main):', e.message); }
  try { stuckAmbush = await flagStuckAmbushOutbox(db); } catch (e) { console.error('[BridgeHealth] flagStuck(ambush):', e.message); }
  const stuckTotal = await db.collection('pnthr_ambush_outbox').countDocuments({ status: 'STUCK' })
                   + await db.collection('pnthr_ibkr_outbox').countDocuments({ status: 'STUCK' });

  // Recent FAILED streak (ambush outbox carries Tree's live commands).
  const failedRecent = await db.collection('pnthr_ambush_outbox').countDocuments({
    status: 'FAILED', updatedAt: { $gte: new Date(Date.now() - FAILED_WINDOW_MS) },   // markAmbushOrderFailed stamps updatedAt
  });

  const problems = [];
  // A stale snapshot only matters in-session with the engine on: overnight/weekend
  // staleness is normal (bridge Mac asleep is fine when nothing can trade).
  if (inSession && mode !== 'off' && ageMin > SNAPSHOT_STALE_MIN) {
    problems.push(`IBKR snapshot ${ageMin === Infinity ? 'MISSING' : ageMin.toFixed(0) + ' min stale'} — bridge down or zombied`);
  }
  if (stuckTotal > 0) problems.push(`${stuckTotal} outbox command(s) STUCK (EXECUTING > 5 min, promoted server-side)`);
  if (failedRecent >= FAILED_STREAK) problems.push(`${failedRecent} FAILED commands in the last 15 min — check bridge/TWS`);

  const ok = problems.length === 0;
  const health = {
    ok, problems, mode, inSession,
    snapshotAgeMin: ageMin === Infinity ? null : +ageMin.toFixed(1),
    stuckPromoted: stuckMain + stuckAmbush, stuckTotal, failedRecent,
    checkedAt: new Date(),
  };
  await db.collection('pnthr_tree_config').updateOne({}, { $set: { bridgeHealth: health } }, { upsert: true });

  // Alarm only on the ok → bad TRANSITION (and re-arm once healthy again).
  const wasOk = cfg.bridgeHealth ? cfg.bridgeHealth.ok !== false : true;
  if (!ok && wasOk) {
    console.error(`[BridgeHealth] 🚨 ${problems.join(' | ')}`);
    await db.collection('pnthr_ops_alerts').insertOne({
      kind: 'BRIDGE_HEALTH', problems, mode, snapshotAgeMin: health.snapshotAgeMin,
      stuckTotal, failedRecent, at: new Date(),
    });
    await sendOpsAlertEmail({
      subject: 'Bridge/outbox health alarm',
      lines: [...problems, `Tree mode: ${mode}`, 'Entries are gated on snapshot freshness; resting stops still protect the book. Check the bridge + TWS on the trading Mac.'],
    }).catch(e => console.error('[BridgeHealth] alert email failed:', e.message));
  } else if (ok && !wasOk) {
    console.log('[BridgeHealth] ✅ recovered');
    await db.collection('pnthr_ops_alerts').insertOne({ kind: 'BRIDGE_HEALTH_RECOVERED', at: new Date() });
  }
  return health;
}
