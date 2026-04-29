// server/scripts_den/diagnoseDtcrPartial.js
// ── Read-only diagnostic: why does DTCR have status=PARTIAL? ──────────────
//
// Symptom: AssistantLiveTable shows DTCR with "CMD —" placeholders (reconciler
// only fetches status=ACTIVE), but POST /api/positions blocks the re-add
// because its duplicate guard spans ACTIVE+PARTIAL. The reconciler is now
// fixed to include PARTIAL — so once deployed, DTCR will render with whatever
// values are actually in the doc. This script prints those values up front so
// we can decide whether to keep the doc as-is, repair it, or close it.
//
// Run: node scripts_den/diagnoseDtcrPartial.js

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });
import { connectToDatabase } from '../database.js';

const TICKER = 'DTCR';

console.log(`\n=== DTCR PARTIAL diagnostic ===\n`);

const db = await connectToDatabase();
if (!db) { console.error('DB connection failed'); process.exit(1); }

// ── 1. All DTCR docs in pnthr_portfolio (any status, any ownerId) ──────────
console.log('─── 1. ALL DTCR docs in pnthr_portfolio ─────────────────────────');
const allDocs = await db.collection('pnthr_portfolio')
  .find({ ticker: TICKER })
  .toArray();
console.log(`Found ${allDocs.length} doc(s)\n`);
for (const d of allDocs) {
  console.log(`  id:           ${d.id}`);
  console.log(`  ownerId:      ${d.ownerId}`);
  console.log(`  status:       ${d.status}`);
  console.log(`  direction:    ${d.direction}  (signal: ${d.signal})`);
  console.log(`  shares:       ${d.shares}`);
  console.log(`  entryPrice:   ${d.entryPrice}`);
  console.log(`  stopPrice:    ${d.stopPrice}`);
  console.log(`  originalStop: ${d.originalStop}`);
  console.log(`  sector:       ${d.sector}`);
  console.log(`  createdAt:    ${d.createdAt}`);
  console.log(`  updatedAt:    ${d.updatedAt}`);
  console.log(`  fills:`);
  for (const lotKey of ['1','2','3','4','5']) {
    const f = d.fills?.[lotKey];
    if (!f) { console.log(`    Lot ${lotKey}: (missing)`); continue; }
    console.log(`    Lot ${lotKey}: filled=${f.filled} shares=${f.shares ?? '-'} price=${f.price ?? '-'} date=${f.date ?? '-'}`);
  }
  if (Array.isArray(d.exits) && d.exits.length) {
    console.log(`  exits (${d.exits.length}):`);
    for (const ex of d.exits) {
      console.log(`    - ${ex.date} ${ex.shares} sh @ ${ex.price} reason=${ex.reason || '-'}`);
    }
  } else {
    console.log(`  exits: (none)`);
  }
  if (Array.isArray(d.stopHistory) && d.stopHistory.length) {
    console.log(`  stopHistory (last 5 of ${d.stopHistory.length}):`);
    for (const sh of d.stopHistory.slice(-5)) {
      console.log(`    - ${sh.date} stop=${sh.stop} reason=${sh.reason || '-'}`);
    }
  }
  console.log(`  outcome:      ${JSON.stringify(d.outcome || {})}`);
  console.log('');
}

// ── 2. IBKR side — what does the synced position look like? ───────────────
console.log('─── 2. IBKR-side DTCR snapshot ──────────────────────────────────');
const ibkrDocs = await db.collection('pnthr_ibkr_positions')
  .find({})
  .toArray();
let foundIbkr = 0;
for (const ibkrDoc of ibkrDocs) {
  const pos = (ibkrDoc.positions || []).find(p => p.symbol === TICKER || p.ticker === TICKER);
  if (!pos) continue;
  foundIbkr++;
  console.log(`  ownerId:     ${ibkrDoc.ownerId}`);
  console.log(`  syncedAt:    ${ibkrDoc.syncedAt}`);
  console.log(`  position:    ${JSON.stringify(pos, null, 2)}`);
  const stops = (ibkrDoc.stopOrders || []).filter(s => s.symbol === TICKER || s.ticker === TICKER);
  console.log(`  stopOrders (${stops.length}):`);
  for (const s of stops) console.log(`    ${JSON.stringify(s)}`);
  console.log('');
}
if (!foundIbkr) console.log('  (no IBKR-side DTCR snapshot found)\n');

// ── 3. Sanity check: shares math ─────────────────────────────────────────
console.log('─── 3. Sanity check ─────────────────────────────────────────────');
for (const d of allDocs) {
  if (d.status !== 'PARTIAL') continue;
  const filledShares = ['1','2','3','4','5']
    .map(k => d.fills?.[k])
    .filter(f => f?.filled)
    .reduce((sum, f) => sum + (f.shares || 0), 0);
  const exitShares = (d.exits || []).reduce((sum, e) => sum + (e.shares || 0), 0);
  const expectedRemaining = filledShares - exitShares;
  console.log(`  Doc id: ${d.id}`);
  console.log(`    filled across lots: ${filledShares}`);
  console.log(`    exited:             ${exitShares}`);
  console.log(`    expected remaining: ${expectedRemaining}`);
  console.log(`    doc.shares field:   ${d.shares}`);
  console.log(`    match? ${expectedRemaining === d.shares ? 'YES' : 'NO — mismatch'}`);
}

console.log('\n=== Done ===\n');
process.exit(0);
