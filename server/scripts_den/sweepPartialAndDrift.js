// server/scripts_den/sweepPartialAndDrift.js
// ── Generalized sweep for two related data-integrity bugs ────────────────────
//
// (1) PARTIAL-with-0-remaining: portfolio docs where remainingShares === 0
//     but status === 'PARTIAL'. These are logically CLOSED but the close
//     handler (most likely /api/ibkr/sync-partial) didn't transition them.
//     Symptom is the same shape as DTCR id=mod0qqm9fajlg from 2026-04-29.
//     Repair = recompute canonical close fields from fills[] + exits[],
//     flip status to CLOSED, set washRule on losses, sync journal.
//
// (2) totalFilledShares drift: docs where +totalFilledShares !== sum(fills[].shares)
//     for filled lots. Caused by Lot 2-5 fills going through positionsSave()
//     which $set's fills surgically without recomputing the denormalized
//     totalFilledShares field. The UI reads from fills[] (so it's correct)
//     but server-side scripts that read totalFilledShares (the punch list,
//     until just fixed) saw stale values.
//
// Usage:
//   node scripts_den/sweepPartialAndDrift.js                 # dry run (default)
//   node scripts_den/sweepPartialAndDrift.js --apply         # write fixes
//   node scripts_den/sweepPartialAndDrift.js --apply --skip-drift  # only fix PARTIAL
//
// Idempotent: re-running after apply is a no-op.
// Read-only on dry-run — safe to run anytime.

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });
import { connectToDatabase } from '../database.js';

const APPLY      = process.argv.includes('--apply');
const SKIP_DRIFT = process.argv.includes('--skip-drift');
const SCOTT      = '69c62632367d0e18498e7650';

console.log(`\n=== Sweep: PARTIAL-stuck + totalFilledShares drift ===`);
console.log(`  mode: ${APPLY ? 'APPLY (writes will happen)' : 'DRY RUN (no writes)'}`);
console.log(`  scope: PARTIAL repair${SKIP_DRIFT ? '' : ' + drift fix'}\n`);

const db = await connectToDatabase();
if (!db) { console.error('DB connection failed'); process.exit(1); }

// Helpers — match exitService.js / repairDtcrClose.js logic exactly
function calcFilledShares(fills) {
  return Object.values(fills || {}).reduce((s, f) => s + (f?.filled ? +f.shares || 0 : 0), 0);
}
function calcAvgCost(fills, fallbackEntry) {
  const filled = Object.values(fills || {}).filter(f => f?.filled && f?.price && f?.shares);
  if (!filled.length) return +fallbackEntry || 0;
  const cost = filled.reduce((s, f) => s + (+f.shares * +f.price), 0);
  const shr  = filled.reduce((s, f) => s + +f.shares, 0);
  return shr > 0 ? cost / shr : (+fallbackEntry || 0);
}

// ── 1. Find PARTIAL docs with remaining === 0 ────────────────────────────────
const partialDocs = await db.collection('pnthr_portfolio').find({
  ownerId: SCOTT,
  status:  'PARTIAL',
}).toArray();

const partialBroken = partialDocs.filter(d => {
  const filled    = calcFilledShares(d.fills);
  const exited    = (d.exits || []).reduce((s, e) => s + (+e.shares || 0), 0);
  const remaining = filled - exited;
  return remaining === 0 && filled > 0;
});

console.log(`╭─ (1) PARTIAL docs with 0 remaining (should be CLOSED) ───────────╮`);
if (partialBroken.length === 0) {
  console.log(`│  ✓ none found                                                     │`);
  console.log(`╰───────────────────────────────────────────────────────────────────╯\n`);
} else {
  console.log(`│  Found ${String(partialBroken.length).padEnd(2)} broken doc(s) — will be repaired                       │`);
  console.log(`╰───────────────────────────────────────────────────────────────────╯`);
  for (const d of partialBroken) {
    console.log(`  • ${d.ticker} (id=${d.id}) — ${d.direction}, fills sum=${calcFilledShares(d.fills)}, exits=${(d.exits || []).length}`);
  }
  console.log();
}

// ── 2. Find totalFilledShares drift ─────────────────────────────────────────
let drift = [];
if (!SKIP_DRIFT) {
  const allActive = await db.collection('pnthr_portfolio').find({
    ownerId: SCOTT,
    status:  { $in: ['ACTIVE', 'PARTIAL'] },
  }).toArray();

  drift = allActive
    .map(d => ({ d, fillsSum: calcFilledShares(d.fills), tfs: +d.totalFilledShares || 0 }))
    .filter(x => x.fillsSum !== x.tfs && x.fillsSum > 0);

  console.log(`╭─ (2) totalFilledShares drift (denorm field stale vs fills[]) ────╮`);
  if (drift.length === 0) {
    console.log(`│  ✓ none found                                                     │`);
    console.log(`╰───────────────────────────────────────────────────────────────────╯\n`);
  } else {
    console.log(`│  Found ${String(drift.length).padEnd(2)} doc(s) with drift — will be re-synced                  │`);
    console.log(`╰───────────────────────────────────────────────────────────────────╯`);
    for (const { d, fillsSum, tfs } of drift) {
      console.log(`  • ${d.ticker} (id=${d.id}) — totalFilledShares=${tfs}, fills sum=${fillsSum}`);
    }
    console.log();
  }
}

// ── 3. Apply repairs (if --apply) ───────────────────────────────────────────

async function repairPartialBroken(d) {
  const isLong = d.direction === 'LONG';
  const exits  = d.exits || [];
  const filled = calcFilledShares(d.fills);
  const exited = exits.reduce((s, e) => s + (+e.shares || 0), 0);
  if (filled !== exited) {
    return { ok: false, reason: `filled=${filled} but exited=${exited} — refusing to auto-repair` };
  }

  const avgCost = calcAvgCost(d.fills, d.entryPrice);

  // avgExitPrice = share-weighted avg of exits
  const totalExitedShares = exits.reduce((s, e) => s + (+e.shares || 0), 0);
  const totalExitProceeds = exits.reduce((s, e) => s + (+e.shares || 0) * (+e.price || 0), 0);
  const avgExitPrice = totalExitedShares > 0 ? totalExitProceeds / totalExitedShares : 0;

  // realizedPnl = sum of per-exit pnl, recomputed against avgCost
  const realizedDollar = exits.reduce((s, e) => {
    const shr = +e.shares || 0;
    const px  = +e.price  || 0;
    const diff = isLong ? (px - avgCost) : (avgCost - px);
    return s + diff * shr;
  }, 0);
  const totalCostBasis = avgCost * filled;
  const realizedPct = totalCostBasis > 0 ? +(realizedDollar / totalCostBasis * 100).toFixed(2) : 0;

  // Last-exit date for closedAt + washRule.finalExitDate
  const lastExit = exits.length > 0 ? exits[exits.length - 1] : null;
  const lastExitDate = lastExit?.date || new Date().toISOString().split('T')[0];
  const closedAt = new Date(`${lastExitDate}T${lastExit?.time || '16:00'}:00`);

  const $set = {
    status: 'CLOSED',
    totalFilledShares: filled,
    totalExitedShares: totalExitedShares,
    remainingShares:   0,
    avgExitPrice:      +avgExitPrice.toFixed(4),
    'realizedPnl.dollar': +realizedDollar.toFixed(2),
    'realizedPnl.pct':    realizedPct,
    closedAt,
    updatedAt: new Date(),
    // Mirror to legacy outcome.* shape (some consumers still read this)
    outcome: {
      exitPrice: +avgExitPrice.toFixed(4),
      profitPct: realizedPct,
      profitDollar: +realizedDollar.toFixed(2),
      holdingDays: Math.floor((closedAt.getTime() - new Date(d.createdAt).getTime()) / 86400000),
      exitReason: lastExit?.reason || 'MANUAL',
    },
  };

  if (realizedDollar < 0) {
    const finalDate = new Date(`${lastExitDate}T00:00:00.000Z`);
    const expiry = new Date(finalDate);
    expiry.setUTCDate(expiry.getUTCDate() + 30);
    $set['washRule.isLoss']        = true;
    $set['washRule.finalExitDate'] = lastExitDate;
    $set['washRule.expiryDate']    = expiry.toISOString().split('T')[0];
  }

  // Patch existing exit records' isFinalExit + remainingShares (mirrors recordExit shape)
  const exitPatch = {};
  for (let i = 0; i < exits.length; i++) {
    if (i === exits.length - 1) {
      exitPatch[`exits.${i}.isFinalExit`]     = true;
      exitPatch[`exits.${i}.remainingShares`] = 0;
    }
  }

  if (!APPLY) return { ok: true, dryRun: true, $set, exitPatch };

  const r = await db.collection('pnthr_portfolio').updateOne(
    { id: d.id, ownerId: SCOTT },
    { $set: { ...$set, ...exitPatch } },
  );
  if (r.matchedCount === 0) return { ok: false, reason: 'no match on update' };

  // Sync journal
  const journal = await db.collection('pnthr_journal').findOne({ positionId: d.id, ownerId: SCOTT });
  if (journal) {
    const jSet = {
      'performance.status':            'CLOSED',
      'performance.remainingShares':   0,
      'performance.realizedPnlDollar': +realizedDollar.toFixed(2),
      'performance.realizedPnlPct':    realizedPct,
      'performance.avgExitPrice':      +avgExitPrice.toFixed(4),
      closedAt,
      updatedAt: new Date(),
    };
    if (realizedDollar < 0) {
      const finalDate = new Date(`${lastExitDate}T00:00:00.000Z`);
      const expiry = new Date(finalDate);
      expiry.setUTCDate(expiry.getUTCDate() + 30);
      jSet['washSale.isLoss']     = true;
      jSet['washSale.lossAmount'] = +realizedDollar.toFixed(2);
      jSet['washSale.exitDate']   = finalDate;
      jSet['washSale.expiryDate'] = expiry;
      jSet['washSale.triggered']  = false;
    }
    await db.collection('pnthr_journal').updateOne(
      { positionId: d.id, ownerId: SCOTT },
      { $set: jSet },
    );
  }

  return { ok: true, applied: true, journalSynced: !!journal };
}

async function repairDrift(d, fillsSum) {
  if (!APPLY) return { ok: true, dryRun: true, newValue: fillsSum };
  const r = await db.collection('pnthr_portfolio').updateOne(
    { id: d.id, ownerId: SCOTT },
    { $set: { totalFilledShares: fillsSum, updatedAt: new Date() } },
  );
  return { ok: r.matchedCount > 0, applied: true, newValue: fillsSum };
}

// Execute repairs
if (partialBroken.length > 0) {
  console.log(`── Repairing PARTIAL-stuck docs ────────────────────────────────`);
  for (const d of partialBroken) {
    try {
      const result = await repairPartialBroken(d);
      if (!result.ok) {
        console.log(`  ✗ ${d.ticker}: ${result.reason}`);
      } else if (result.dryRun) {
        console.log(`  [dry] ${d.ticker}: would set status=CLOSED, realizedPnl=${result.$set['realizedPnl.dollar']}, avgExit=${result.$set.avgExitPrice}`);
      } else {
        console.log(`  ✓ ${d.ticker}: portfolio + ${result.journalSynced ? 'journal' : 'NO journal'} updated`);
      }
    } catch (e) {
      console.log(`  ✗ ${d.ticker}: ${e.message}`);
    }
  }
  console.log();
}

if (drift.length > 0 && !SKIP_DRIFT) {
  console.log(`── Repairing totalFilledShares drift ───────────────────────────`);
  for (const { d, fillsSum, tfs } of drift) {
    try {
      const result = await repairDrift(d, fillsSum);
      if (!result.ok) {
        console.log(`  ✗ ${d.ticker}: ${result.reason || 'no match'}`);
      } else if (result.dryRun) {
        console.log(`  [dry] ${d.ticker}: would set totalFilledShares ${tfs} → ${fillsSum}`);
      } else {
        console.log(`  ✓ ${d.ticker}: totalFilledShares ${tfs} → ${fillsSum}`);
      }
    } catch (e) {
      console.log(`  ✗ ${d.ticker}: ${e.message}`);
    }
  }
  console.log();
}

console.log(`╔══════════════════════════════════════════════════════════════════╗`);
console.log(`║  SWEEP SUMMARY                                                    ║`);
console.log(`╠══════════════════════════════════════════════════════════════════╣`);
console.log(`║  PARTIAL-stuck docs : ${String(partialBroken.length).padStart(3)}                                       ║`);
console.log(`║  Drift docs         : ${String(drift.length).padStart(3)}                                       ║`);
console.log(`║  TOTAL              : ${String(partialBroken.length + drift.length).padStart(3)}                                       ║`);
console.log(`╚══════════════════════════════════════════════════════════════════╝`);

if (!APPLY && (partialBroken.length + drift.length) > 0) {
  console.log(`\nDRY RUN — re-run with --apply to write fixes.`);
}
console.log(`=== Done ===\n`);
process.exit(0);
