// server/scripts_den/repairDtcrClose.js
// ── One-off repair: mark broken DTCR PARTIAL doc as canonically CLOSED ────
//
// Symptom (from diagnoseDtcrPartial.js, 2026-04-29):
//   pnthr_portfolio doc id=mod0qqm9fajlg has status='PARTIAL' but exits[]
//   contains a single 51-share manual exit on 2026-04-28 — the full filled
//   position was exited. expected_remaining = 0 → status SHOULD be CLOSED.
//   Canonical fields (totalFilledShares, totalExitedShares, remainingShares,
//   realizedPnl, closedAt) are missing. outcome.* is all-null.
//
// Same family as repairTodaysExits.js (2026-04-28) but a 4th category:
//   exits[] IS populated (so it's not "schema-split" A/B from the prior repair),
//   yet status didn't flip and canonical fields didn't write.
//
// Fix: bring this doc to the state recordExit() would have produced on a clean
// full-close run. Idempotent — if status is already CLOSED, this is a no-op.
//
// Run order:
//   node scripts_den/repairDtcrClose.js              # dry run (default)
//   node scripts_den/repairDtcrClose.js --apply      # actually write

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });
import { connectToDatabase } from '../database.js';

const APPLY    = process.argv.includes('--apply');
const TICKER   = 'DTCR';
const SCOTT    = '69c62632367d0e18498e7650';
const TARGET_ID = 'mod0qqm9fajlg';

console.log(`\n=== DTCR close repair ===`);
console.log(`  mode: ${APPLY ? 'APPLY (writes will happen)' : 'DRY RUN (no writes)'}\n`);

const db = await connectToDatabase();
if (!db) { console.error('DB connection failed'); process.exit(1); }

// ── 1. Locate target doc ───────────────────────────────────────────────────
const doc = await db.collection('pnthr_portfolio').findOne({
  id: TARGET_ID, ownerId: SCOTT, ticker: TICKER,
});
if (!doc) {
  console.error(`Doc not found (id=${TARGET_ID}, ownerId=${SCOTT}, ticker=${TICKER}). Aborting.`);
  process.exit(1);
}

console.log(`Found doc: id=${doc.id} status=${doc.status} ticker=${doc.ticker} direction=${doc.direction}`);

// Allow re-runs: if the portfolio is already CLOSED, skip the portfolio
// write but still proceed to journal sanity check + sync.
const skipPortfolioWrite = doc.status === 'CLOSED';
if (skipPortfolioWrite) {
  console.log('Portfolio already CLOSED — skipping portfolio write, will still check/sync journal.');
} else if (doc.status !== 'PARTIAL') {
  console.error(`Unexpected status '${doc.status}' — expected PARTIAL or CLOSED. Aborting to avoid bad write.`);
  process.exit(1);
}

// ── 2. Validate the data we expect ─────────────────────────────────────────
const exits = Array.isArray(doc.exits) ? doc.exits : [];
const filledShares = ['1','2','3','4','5']
  .map(k => doc.fills?.[k])
  .filter(f => f?.filled)
  .reduce((sum, f) => sum + (+f.shares || 0), 0);
const exitedShares = exits.reduce((s, e) => s + (+e.shares || 0), 0);
const remaining = filledShares - exitedShares;

console.log(`  filledShares: ${filledShares}`);
console.log(`  exitedShares: ${exitedShares}`);
console.log(`  remaining:    ${remaining}`);

if (filledShares <= 0) { console.error('No filled shares found. Aborting.'); process.exit(1); }
if (remaining !== 0)   { console.error(`remaining=${remaining}, expected 0. This doc is genuinely partial — repair would corrupt data. Aborting.`); process.exit(1); }
if (exits.length !== 1) { console.error(`Expected exactly 1 exit; found ${exits.length}. Investigate before repairing.`); process.exit(1); }

const exit = exits[0];
const isLong = doc.direction === 'LONG';

// ── 3. Compute canonical close fields ──────────────────────────────────────
// avg cost from filled lots (matches calcAvgCost in exitService.js)
const totalCost = ['1','2','3','4','5']
  .map(k => doc.fills?.[k])
  .filter(f => f?.filled)
  .reduce((sum, f) => sum + (+f.shares || 0) * (+f.price || 0), 0);
const avgCost = totalCost / filledShares;

const exitPrice = +exit.price;
const profitDollar = isLong
  ? (exitPrice - avgCost) * filledShares
  : (avgCost - exitPrice) * filledShares;
const profitPct = avgCost > 0
  ? (isLong ? (exitPrice - avgCost) / avgCost * 100 : (avgCost - exitPrice) / avgCost * 100)
  : 0;

const holdingDays = Math.floor((new Date(exit.date).getTime() - new Date(doc.createdAt).getTime()) / 86400000);
const closedAt = new Date(`${exit.date}T${exit.time || '16:00'}`);

const realizedDollar = +profitDollar.toFixed(2);
const realizedPct    = +profitPct.toFixed(2);
const avgExitPrice   = +exitPrice.toFixed(4);

console.log(`\nComputed close fields:`);
console.log(`  avgCost:       ${avgCost.toFixed(4)}`);
console.log(`  exitPrice:     ${exitPrice}`);
console.log(`  profitDollar:  ${realizedDollar}`);
console.log(`  profitPct:     ${realizedPct}%`);
console.log(`  holdingDays:   ${holdingDays}`);
console.log(`  closedAt:      ${closedAt.toISOString()}`);

// ── 4. Build the update doc (matches exitService.recordExit shape) ────────
const $set = {
  status: 'CLOSED',
  totalFilledShares: filledShares,
  totalExitedShares: exitedShares,
  remainingShares: 0,
  avgExitPrice,
  'realizedPnl.dollar': realizedDollar,
  'realizedPnl.pct':    realizedPct,
  closedAt,
  updatedAt: new Date(),
  // Mirror to legacy outcome.* shape so any consumer reading either field is correct
  outcome: {
    exitPrice,
    profitPct:    realizedPct,
    profitDollar: realizedDollar,
    holdingDays,
    exitReason:   exit.reason || 'MANUAL',
  },
};

// Wash rule on loss
if (realizedDollar < 0) {
  const dateStr = exit.date.split('T')[0];
  const finalDate = new Date(dateStr + 'T00:00:00.000Z');
  const expiryDate = new Date(finalDate);
  expiryDate.setUTCDate(expiryDate.getUTCDate() + 30);
  $set['washRule.isLoss']        = true;
  $set['washRule.finalExitDate'] = exit.date;
  $set['washRule.expiryDate']    = expiryDate.toISOString().split('T')[0];
}

// Touch the existing exit record so it reflects final-exit state
const exitPatch = {
  'exits.0.isFinalExit':     true,
  'exits.0.remainingShares': 0,
  'exits.0.pnl.dollar':      realizedDollar,
  'exits.0.pnl.pct':         realizedPct,
};

if (skipPortfolioWrite) {
  console.log(`\nPortfolio write skipped (already CLOSED).`);
} else {
  console.log(`\nPlanned $set on pnthr_portfolio.${TARGET_ID}:`);
  for (const [k, v] of Object.entries({ ...$set, ...exitPatch })) {
    console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
}

// ── 5. Apply portfolio write (if needed) ──────────────────────────────────
if (APPLY && !skipPortfolioWrite) {
  const result = await db.collection('pnthr_portfolio').updateOne(
    { id: TARGET_ID, ownerId: SCOTT },
    { $set: { ...$set, ...exitPatch } },
  );
  console.log(`\nUpdate result: matched=${result.matchedCount} modified=${result.modifiedCount}`);
}

// ── 6. Verify portfolio state (read-only — runs on dry-run too) ───────────
const after = await db.collection('pnthr_portfolio').findOne({ id: TARGET_ID });
console.log(`\nPortfolio verification:`);
console.log(`  status:            ${after.status}`);
console.log(`  totalFilledShares: ${after.totalFilledShares}`);
console.log(`  totalExitedShares: ${after.totalExitedShares}`);
console.log(`  remainingShares:   ${after.remainingShares}`);
console.log(`  realizedPnl:       ${JSON.stringify(after.realizedPnl)}`);
console.log(`  outcome:           ${JSON.stringify(after.outcome)}`);
console.log(`  closedAt:          ${after.closedAt}`);
console.log(`  washRule:          ${JSON.stringify(after.washRule || {})}`);

// ── 7. Journal sanity check + sync ────────────────────────────────────────
const journal = await db.collection('pnthr_journal').findOne({ positionId: TARGET_ID, ownerId: SCOTT });
console.log(`\nJournal check:`);
if (!journal) {
  console.log(`  No journal entry found for positionId=${TARGET_ID}.`);
  console.log(`  → If this position should appear in the journal, run a follow-up to create one.`);
} else {
  console.log(`  Before:`);
  console.log(`    status:            ${journal.performance?.status}`);
  console.log(`    remainingShares:   ${journal.performance?.remainingShares}`);
  console.log(`    realizedPnlDollar: ${journal.performance?.realizedPnlDollar}`);
  console.log(`    realizedPnlPct:    ${journal.performance?.realizedPnlPct}`);
  console.log(`    avgExitPrice:      ${journal.performance?.avgExitPrice}`);
  console.log(`    exits in journal:  ${(journal.exits || []).length}`);

  const journalNeedsSync =
    journal.performance?.status !== 'CLOSED' ||
    journal.performance?.remainingShares !== 0 ||
    journal.performance?.realizedPnlPct !== realizedPct ||
    journal.performance?.realizedPnlDollar !== realizedDollar;

  if (!journalNeedsSync) {
    console.log(`  Journal already in sync — no patch needed.`);
  } else {
    const journalSet = {
      'performance.status':            'CLOSED',
      'performance.remainingShares':   0,
      'performance.realizedPnlDollar': realizedDollar,
      'performance.realizedPnlPct':    realizedPct,
      'performance.avgExitPrice':      avgExitPrice,
      closedAt,
      updatedAt: new Date(),
    };
    // Wash sale on loss — mirror the portfolio washRule into the journal washSale
    if (realizedDollar < 0) {
      const dateStr = exit.date.split('T')[0];
      const finalDate = new Date(dateStr + 'T00:00:00.000Z');
      const expiryDate = new Date(finalDate);
      expiryDate.setUTCDate(expiryDate.getUTCDate() + 30);
      journalSet['washSale.isLoss']      = true;
      journalSet['washSale.lossAmount']  = realizedDollar;
      journalSet['washSale.exitDate']    = finalDate;
      journalSet['washSale.expiryDate']  = expiryDate;
      journalSet['washSale.triggered']   = false;
    }

    if (!APPLY) {
      console.log(`  [dry run] would $set on pnthr_journal:`);
      for (const [k, v] of Object.entries(journalSet)) {
        console.log(`    ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
      }
    } else {
      const jr = await db.collection('pnthr_journal').updateOne(
        { positionId: TARGET_ID, ownerId: SCOTT },
        { $set: journalSet },
      );
      console.log(`  Journal update: matched=${jr.matchedCount} modified=${jr.modifiedCount}`);
      const jAfter = await db.collection('pnthr_journal').findOne({ positionId: TARGET_ID, ownerId: SCOTT });
      console.log(`  After:`);
      console.log(`    status:            ${jAfter.performance?.status}`);
      console.log(`    remainingShares:   ${jAfter.performance?.remainingShares}`);
      console.log(`    realizedPnlDollar: ${jAfter.performance?.realizedPnlDollar}`);
      console.log(`    realizedPnlPct:    ${jAfter.performance?.realizedPnlPct}`);
      console.log(`    avgExitPrice:      ${jAfter.performance?.avgExitPrice}`);
    }
  }
}

if (!APPLY) {
  console.log('\nDRY RUN — no writes performed. Re-run with --apply to write.\n');
}
console.log('=== Done ===\n');
process.exit(0);
