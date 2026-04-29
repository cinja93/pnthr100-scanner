// server/scripts_den/backfillStopHistory_2026_04_29.js
// ── Phase 4-of-original-plan: backfill stopHistory[] for pre-ratchet docs ──
//
// 10 positions have stopPrice ≠ originalStop but empty stopHistory[]. The
// stops moved at some point (ATR ratchet, manual TWS tightening, sync
// adoption, etc.) before stopHistory[] became the canonical audit channel
// for stop changes. Backfill creates a single entry per doc documenting
// the pre-→-post move. Original ratchet date(s) are unrecoverable, so we
// record today's date with reason='BACKFILL_PRIOR_RATCHET' and a note
// flagging it as a one-time consolidated backfill.
//
// Idempotency: skips any position whose stopHistory[] is already non-empty
// (those have post-stopHistory-feature ratchet history and shouldn't get a
// retroactive entry layered on).
//
// HARD GATES per ticker (abort-on-fail):
//   1. Position exists, status active/partial, owner=Scott
//   2. stopHistory[] is currently empty
//   3. stopPrice ≠ originalStop (matches audit's "moved" definition)
//
// Run:  node scripts_den/backfillStopHistory_2026_04_29.js          # dry
//       node scripts_den/backfillStopHistory_2026_04_29.js --apply  # write

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });
import { connectToDatabase } from '../database.js';

const APPLY = process.argv.includes('--apply');
const SCOTT = '69c62632367d0e18498e7650';
const TODAY = new Date().toISOString().slice(0, 10);

const STOP_TOL_DOLLAR = 0.05;
const NOTE = 'Backfilled from prior ratchet activity (original ratchet date(s) unknown); see commit 2026-04-29 Path-2 cleanup';

const db = await connectToDatabase();
if (!db) { console.error('NO DB'); process.exit(1); }

console.log(`\n=== Stop history backfill — ${APPLY ? 'APPLY' : 'DRY-RUN'} ===\n`);

const positions = await db.collection('pnthr_portfolio').find({
  ownerId: SCOTT, status: { $in: ['ACTIVE', 'PARTIAL'] },
}).toArray();

const candidates = [];
for (const p of positions) {
  const sp = +p.stopPrice;
  const op = +p.originalStop;
  if (!Number.isFinite(sp) || !Number.isFinite(op)) continue;
  const moved = Math.abs(sp - op) > STOP_TOL_DOLLAR;
  const histLen = Array.isArray(p.stopHistory) ? p.stopHistory.length : 0;
  if (moved && histLen === 0) {
    candidates.push(p);
  }
}

console.log(`Active/partial positions: ${positions.length}`);
console.log(`Candidates (moved stop + empty history): ${candidates.length}\n`);

if (candidates.length === 0) {
  console.log(`\x1b[32m✓ Nothing to backfill — all moved stops already have history entries.\x1b[0m\n`);
  process.exit(0);
}

console.log(`Tickers needing backfill:`);
for (const p of candidates) {
  console.log(`  ${p.ticker.padEnd(6)} ${p.direction.padEnd(5)}  $${(+p.originalStop).toFixed(2)} → $${(+p.stopPrice).toFixed(2)}  (${p.id})`);
}

if (!APPLY) {
  console.log(`\n\x1b[33mDRY-RUN complete. Re-run with --apply to write.\x1b[0m\n`);
  process.exit(0);
}

console.log(`\nApplying…`);
let applied = 0;
const errors = [];

for (const p of candidates) {
  // Re-fetch right before update — defensive against intervening writes
  // (e.g. a concurrent adoptTwsTighterStops.js or manual edit). Refuse to
  // write if state has shifted since the candidate scan.
  const fresh = await db.collection('pnthr_portfolio').findOne({ id: p.id, ownerId: SCOTT });
  if (!fresh) { errors.push({ ticker: p.ticker, error: 'doc disappeared' }); continue; }
  if (Array.isArray(fresh.stopHistory) && fresh.stopHistory.length > 0) {
    console.log(`  ⚠ ${p.ticker.padEnd(6)} skipped — stopHistory grew to ${fresh.stopHistory.length} between scan and write (idempotency guard)`);
    continue;
  }
  if (+fresh.stopPrice !== +p.stopPrice || +fresh.originalStop !== +p.originalStop) {
    console.log(`  ⚠ ${p.ticker.padEnd(6)} skipped — stop values shifted between scan and write (idempotency guard)`);
    continue;
  }

  const historyEntry = {
    date:      TODAY,
    stop:      +fresh.stopPrice,
    from:      +fresh.originalStop,
    reason:    'BACKFILL_PRIOR_RATCHET',
    note:      NOTE,
  };

  try {
    const r = await db.collection('pnthr_portfolio').updateOne(
      { id: p.id, ownerId: SCOTT, $or: [{ stopHistory: { $exists: false } }, { stopHistory: { $size: 0 } }] },
      {
        $set: { updatedAt: new Date() },
        $push: { stopHistory: historyEntry },
      }
    );
    if (r.modifiedCount === 1) {
      applied++;
      console.log(`  ✓ ${p.ticker.padEnd(6)} backfilled  $${(+p.originalStop).toFixed(2)} → $${(+p.stopPrice).toFixed(2)}`);
    } else {
      console.log(`  ⚠ ${p.ticker.padEnd(6)} no-op (matched 0 docs — likely concurrent backfill)`);
    }
  } catch (e) {
    errors.push({ ticker: p.ticker, error: e.message });
    console.log(`  \x1b[31m✗\x1b[0m ${p.ticker.padEnd(6)} ${e.message}`);
  }
}

// Post-state verify
console.log(`\nPost-state verify:`);
let allOk = true;
for (const p of candidates) {
  const fresh = await db.collection('pnthr_portfolio').findOne({ id: p.id, ownerId: SCOTT }, { projection: { stopHistory: 1 } });
  const histLen = (fresh?.stopHistory || []).length;
  const ok = histLen >= 1;
  if (!ok) allOk = false;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${p.ticker.padEnd(6)} stopHistory.length=${histLen}`);
}

console.log(`\nApplied: ${applied}/${candidates.length}  |  Errors: ${errors.length}`);
if (!allOk || errors.length > 0) {
  console.log(`\n\x1b[31m✗ Some entries still empty — investigate.\x1b[0m\n`);
  process.exit(1);
}
console.log(`\n\x1b[32m✓ APPLY complete. Re-run audit to confirm section 5 → 0.\x1b[0m\n`);
process.exit(0);
