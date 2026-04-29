// server/scripts_den/backfillJournalEntries_2026_04_29.js
// ── Phase 4-of-original-plan: backfill missing journal docs ─────────────────
//
// 12 active positions predate the auto-create-journal logic and have no
// pnthr_journal doc. They show up correctly in Command Center / Assistant
// but the Journal page can't render them because there's no journal entry
// to mirror exits / discipline scoring against.
//
// createJournalEntry is already idempotent (checks for existing
// {positionId, ownerId} and returns the existing doc if found), so this
// script is safe to re-run and won't create duplicates.
//
// Per ticker (from latest audit, section 6):
//   TT, TGT, SWKS, CSCO, FDX, TXN, ADI, EQIX, IRM, HPE, XYZ, BWA
//
// Run:  node scripts_den/backfillJournalEntries_2026_04_29.js          # dry
//       node scripts_den/backfillJournalEntries_2026_04_29.js --apply  # write

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });
import { connectToDatabase } from '../database.js';
import { createJournalEntry } from '../journalService.js';

const APPLY = process.argv.includes('--apply');
const SCOTT = '69c62632367d0e18498e7650';

const db = await connectToDatabase();
if (!db) { console.error('NO DB'); process.exit(1); }

console.log(`\n=== Journal backfill — ${APPLY ? 'APPLY' : 'DRY-RUN'} ===\n`);

// Find every active/partial position that has NO matching pnthr_journal doc.
const positions = await db.collection('pnthr_portfolio').find({
  ownerId: SCOTT, status: { $in: ['ACTIVE', 'PARTIAL'] },
}).toArray();

const journalDocs = await db.collection('pnthr_journal').find({
  ownerId: SCOTT,
}).project({ positionId: 1 }).toArray();
const journalIds = new Set(journalDocs.map(j => String(j.positionId)));

const missing = positions.filter(p => !journalIds.has(String(p.id)));
console.log(`Active/partial positions: ${positions.length}`);
console.log(`Existing journal docs:    ${journalDocs.length}`);
console.log(`Missing journal:          ${missing.length}\n`);

if (missing.length === 0) {
  console.log(`\x1b[32m✓ Nothing to backfill — all positions have journal entries.\x1b[0m\n`);
  process.exit(0);
}

console.log(`Tickers needing backfill:`);
for (const p of missing) {
  console.log(`  ${p.ticker.padEnd(6)} status=${p.status} positionId=${p.id}`);
}

if (!APPLY) {
  console.log(`\n\x1b[33mDRY-RUN complete. Re-run with --apply to write.\x1b[0m\n`);
  process.exit(0);
}

console.log(`\nApplying…`);
let created = 0;
let alreadyExisted = 0;
const errors = [];

for (const p of missing) {
  try {
    const journal = await createJournalEntry(db, p, SCOTT);
    // createJournalEntry returns the existing doc if it already exists; we
    // can't distinguish "created" from "already existed" via return value
    // alone. Re-query to find out.
    const before = journalIds.has(String(p.id));
    if (before) {
      alreadyExisted++;
      console.log(`  ✓ ${p.ticker.padEnd(6)} (already existed — idempotent)`);
    } else {
      created++;
      console.log(`  ✓ ${p.ticker.padEnd(6)} created journalId=${journal._id || '?'}`);
    }
  } catch (e) {
    errors.push({ ticker: p.ticker, error: e.message });
    console.log(`  \x1b[31m✗\x1b[0m ${p.ticker.padEnd(6)} ${e.message}`);
  }
}

// Post-state verification
console.log(`\nPost-state verify:`);
const finalJournals = await db.collection('pnthr_journal').find({
  ownerId: SCOTT, positionId: { $in: missing.map(p => String(p.id)) },
}).project({ positionId: 1, ticker: 1 }).toArray();
const finalIds = new Set(finalJournals.map(j => String(j.positionId)));
let allOk = true;
for (const p of missing) {
  const ok = finalIds.has(String(p.id));
  if (!ok) allOk = false;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${p.ticker.padEnd(6)} journal ${ok ? 'present' : 'STILL MISSING'}`);
}

console.log(`\nCreated: ${created}  |  Already existed: ${alreadyExisted}  |  Errors: ${errors.length}`);
if (!allOk || errors.length > 0) {
  console.log(`\n\x1b[31m✗ Some entries still missing — investigate.\x1b[0m\n`);
  process.exit(1);
}
console.log(`\n\x1b[32m✓ APPLY complete. Re-run audit to confirm section 6 → 0.\x1b[0m\n`);
process.exit(0);
