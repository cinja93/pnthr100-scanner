// server/backfillPipelineMaxScore.js
// Backfills killScoreAtEntry.pipelineMaxScore for all journal entries where
// totalScore exists but pipelineMaxScore is null/missing.
//
// Run with: node backfillPipelineMaxScore.js

import { connectToDatabase } from './database.js';

// Given any date, return the ISO string of the most recent Friday on or before it.
// Parses date strings as local (not UTC) to avoid timezone-shift issues.
function getFridayFor(date) {
  const str = String(date).split('T')[0]; // e.g. "2026-03-24"
  const [y, m, day] = str.split('-').map(Number);
  const d = new Date(y, m - 1, day); // local midnight — no UTC offset
  const dow = d.getDay();
  const daysBack = dow === 5 ? 0 : (dow + 2) % 7;
  d.setDate(d.getDate() - daysBack);
  const fy = d.getFullYear();
  const fm = String(d.getMonth() + 1).padStart(2, '0');
  const fd = String(d.getDate()).padStart(2, '0');
  return `${fy}-${fm}-${fd}`;
}

async function run() {
  const db = await connectToDatabase();
  if (!db) { console.error('DB unavailable'); process.exit(1); }

  // Find all journal entries that have a Kill score but no pipelineMaxScore
  const entries = await db.collection('pnthr_journal').find({
    'killScoreAtEntry.totalScore': { $ne: null, $exists: true },
    $or: [
      { 'killScoreAtEntry.pipelineMaxScore': null },
      { 'killScoreAtEntry.pipelineMaxScore': { $exists: false } },
    ],
  }).toArray();

  console.log(`Found ${entries.length} entries needing pipelineMaxScore backfill`);
  if (entries.length === 0) { console.log('Nothing to do.'); process.exit(0); }

  // Cache max scores per weekOf so we don't hit DB repeatedly
  const maxByWeek = {};

  async function getMaxForWeek(weekOf) {
    if (maxByWeek[weekOf] !== undefined) return maxByWeek[weekOf];
    const maxDoc = await db.collection('pnthr_kill_scores')
      .findOne({ weekOf }, { sort: { totalScore: -1 } });
    const max = maxDoc?.totalScore ?? null;
    maxByWeek[weekOf] = max;
    return max;
  }

  let fixed = 0, skipped = 0;

  for (const entry of entries) {
    const rawDate = entry.entry?.fillDate || entry.createdAt;
    if (!rawDate) { console.log(`  SKIP ${entry.ticker} — no entry date`); skipped++; continue; }

    const weekOf = getFridayFor(rawDate);
    const pipelineMaxScore = await getMaxForWeek(weekOf);

    if (pipelineMaxScore == null) {
      console.log(`  SKIP ${entry.ticker} (${weekOf}) — no kill scores found for that week`);
      skipped++;
      continue;
    }

    await db.collection('pnthr_journal').updateOne(
      { _id: entry._id },
      { $set: { 'killScoreAtEntry.pipelineMaxScore': pipelineMaxScore, updatedAt: new Date() } }
    );

    console.log(`  FIXED ${entry.ticker} (${weekOf}) — pipelineMaxScore = ${pipelineMaxScore}`);
    fixed++;
  }

  console.log(`\nDone. Fixed: ${fixed}, Skipped: ${skipped}`);
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
