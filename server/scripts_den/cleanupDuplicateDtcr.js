// server/scripts_den/cleanupDuplicateDtcr.js
// ── One-time: delete the duplicate DTCR portfolio + journal doc ────────────
//
// Background: yesterday's partial sale of DTCR (51 of 102 sh @ $27.875 @ 08:35
// PT) left the canonical record (id mod0qqm9fajlg, created 2026-04-24) in
// PARTIAL status. Today's IBKR sync hit a Phase 3 bug (status filter only
// matched ACTIVE, not PARTIAL) and auto-opened a duplicate ACTIVE doc
// (id moiu3kncmuysl, created 2026-04-28T16:22) for the same ticker + same
// ownerId.
//
// Phase 3 filter bug is fixed in commit 248d118. This script removes the
// duplicate doc + its matching journal so the audit returns to a clean
// state. After it runs, the next bridge sync (every 60s) will refresh the
// IBKR fields on the canonical record now that its PARTIAL status is no
// longer filtered out.
//
// HARD VERIFICATION GATES — refuses to run if any of these fail:
//   1. Duplicate doc must exist with status='ACTIVE' AND autoOpenedByIBKR=true
//   2. Duplicate doc must have entryDate='2026-04-28' (today's auto-create)
//   3. Duplicate doc must have ZERO exits (was created today, no closes yet)
//   4. Duplicate doc fills.1.shares must equal 51 (matches the IBKR remaining)
//   5. Canonical doc must exist with status='PARTIAL' AND have 1 exit
//   6. Canonical doc must have totalFilledShares=102 and remainingShares=51
//
// If ANY gate fails, the script aborts before deleting anything. Re-runnable
// — second run sees no duplicate and exits cleanly.
//
// Run:  node scripts_den/cleanupDuplicateDtcr.js          # dry-run
//       node scripts_den/cleanupDuplicateDtcr.js --apply   # actually delete

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });
import { connectToDatabase } from '../database.js';

const APPLY = process.argv.includes('--apply');
const SCOTT  = '69c62632367d0e18498e7650';
const DUP_ID  = 'moiu3kncmuysl'; // duplicate ACTIVE doc to delete
const KEEP_ID = 'mod0qqm9fajlg'; // canonical PARTIAL doc to preserve

const db = await connectToDatabase();
if (!db) { console.error('NO DB'); process.exit(1); }

console.log(`\n=== DTCR duplicate cleanup — ${APPLY ? 'APPLY' : 'DRY-RUN'} ===\n`);

const dup    = await db.collection('pnthr_portfolio').findOne({ id: DUP_ID,  ownerId: SCOTT });
const keep   = await db.collection('pnthr_portfolio').findOne({ id: KEEP_ID, ownerId: SCOTT });
const dupJrn = await db.collection('pnthr_journal').findOne({ positionId: DUP_ID, ownerId: SCOTT });

// Idempotency: if dup already gone, exit cleanly
if (!dup) {
  console.log('  ✓ SKIP — duplicate doc already deleted (idempotent re-run).');
  if (dupJrn) {
    console.log(`  ⚠ orphaned journal doc still present for positionId=${DUP_ID}`);
    if (APPLY) {
      const r = await db.collection('pnthr_journal').deleteOne({ _id: dupJrn._id });
      console.log(`  ✓ deleted orphaned journal (deletedCount=${r.deletedCount})`);
    } else {
      console.log(`  → DRY: would delete orphaned journal _id=${dupJrn._id}`);
    }
  }
  process.exit(0);
}

// ── Hard verification gates ──────────────────────────────────────────────────
const gates = [];
gates.push({
  name: 'duplicate is ACTIVE',
  ok: dup.status === 'ACTIVE',
  detail: `status=${dup.status}`,
});
gates.push({
  name: 'duplicate is autoOpenedByIBKR',
  ok: dup.autoOpenedByIBKR === true,
  detail: `autoOpenedByIBKR=${dup.autoOpenedByIBKR}`,
});
gates.push({
  name: 'duplicate entryDate is 2026-04-28',
  ok: dup.entryDate === '2026-04-28',
  detail: `entryDate=${dup.entryDate}`,
});
gates.push({
  name: 'duplicate has zero exits',
  ok: Array.isArray(dup.exits) && dup.exits.length === 0,
  detail: `exits.length=${(dup.exits || []).length}`,
});
gates.push({
  name: 'duplicate fills.1.shares is 51',
  ok: +dup.fills?.[1]?.shares === 51,
  detail: `fills.1.shares=${dup.fills?.[1]?.shares}`,
});
gates.push({
  name: 'canonical exists',
  ok: !!keep,
  detail: keep ? `id=${keep.id}` : 'NOT FOUND',
});
gates.push({
  name: 'canonical is PARTIAL',
  ok: keep?.status === 'PARTIAL',
  detail: `status=${keep?.status}`,
});
gates.push({
  name: 'canonical has 1 exit',
  ok: Array.isArray(keep?.exits) && keep.exits.length === 1,
  detail: `exits.length=${(keep?.exits || []).length}`,
});
gates.push({
  name: 'canonical totalFilledShares is 102',
  ok: +keep?.totalFilledShares === 102,
  detail: `totalFilledShares=${keep?.totalFilledShares}`,
});
gates.push({
  name: 'canonical remainingShares is 51',
  ok: +keep?.remainingShares === 51,
  detail: `remainingShares=${keep?.remainingShares}`,
});

console.log('Hard verification gates:');
let allOk = true;
for (const g of gates) {
  console.log(`  ${g.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${g.name.padEnd(40)} (${g.detail})`);
  if (!g.ok) allOk = false;
}

if (!allOk) {
  console.log('\n\x1b[31mABORTED — at least one gate failed.\x1b[0m One of the docs is not in the expected state. Investigate before running --apply.\n');
  process.exit(1);
}

console.log('\nAll gates passed. Targets to delete:');
console.log(`  • pnthr_portfolio  id=${DUP_ID} (status=ACTIVE, 51sh, autoOpenedByIBKR, created ${new Date(dup.createdAt).toISOString().slice(0,16)})`);
if (dupJrn) {
  console.log(`  • pnthr_journal    positionId=${DUP_ID} _id=${dupJrn._id}`);
} else {
  console.log(`  • (no journal doc found for positionId=${DUP_ID} — only the portfolio delete will run)`);
}
console.log(`\nPreserved untouched:`);
console.log(`  • pnthr_portfolio  id=${KEEP_ID} (status=PARTIAL, 102 filled / 51 exited / 51 remaining)`);
console.log(`  • pnthr_journal    positionId=${KEEP_ID} (1 exit, $27.875 sale @ 08:35 PT 2026-04-28)`);

if (!APPLY) {
  console.log('\n\x1b[33mDRY-RUN complete. Re-run with --apply to write.\x1b[0m\n');
  process.exit(0);
}

// ── Apply ────────────────────────────────────────────────────────────────────
console.log('\nApplying…');
const portRes = await db.collection('pnthr_portfolio').deleteOne({ id: DUP_ID, ownerId: SCOTT });
console.log(`  ✓ pnthr_portfolio.deleteOne deletedCount=${portRes.deletedCount}`);

if (dupJrn) {
  const jrnRes = await db.collection('pnthr_journal').deleteOne({ _id: dupJrn._id });
  console.log(`  ✓ pnthr_journal.deleteOne   deletedCount=${jrnRes.deletedCount}`);
}

// Post-condition verify
const dupCheck = await db.collection('pnthr_portfolio').findOne({ id: DUP_ID, ownerId: SCOTT });
const keepCheck = await db.collection('pnthr_portfolio').findOne({ id: KEEP_ID, ownerId: SCOTT });
console.log(`\nPost-state:`);
console.log(`  duplicate doc:  ${dupCheck ? '\x1b[31mSTILL PRESENT\x1b[0m' : '\x1b[32mGONE ✓\x1b[0m'}`);
console.log(`  canonical doc:  ${keepCheck ? '\x1b[32mPRESENT (status=' + keepCheck.status + ', remaining=' + keepCheck.remainingShares + ') ✓\x1b[0m' : '\x1b[31mMISSING\x1b[0m'}`);

if (dupCheck || !keepCheck) {
  console.log('\n\x1b[31mPOST-STATE FAILED — investigate.\x1b[0m\n');
  process.exit(1);
}

console.log('\n\x1b[32m✓ APPLY complete. Re-run phase4PreflightAudit.js to confirm Section 0 is now empty.\x1b[0m\n');
process.exit(0);
