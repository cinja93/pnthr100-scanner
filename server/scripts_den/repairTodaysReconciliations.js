// server/scripts_den/repairTodaysReconciliations.js
// ── One-time: record DTCR partial sale + reconcile avg cost on 5 positions ──
//
// Inputs (per Scott, 2026-04-28):
//   DTCR — sold 51 shares @ $27.875 at 08:35 PT (manual exit in TWS,
//          PNTHR did not detect it; IBKR shows 51 remaining vs PNTHR's 102).
//   GOOGL/FCFS/MSFT/IRM/QCOM — IBKR avg cost is correct, PNTHR avg drifted
//          because adds in TWS weren't recorded. Reconcile by replacing
//          fills[] with one consolidated fill at IBKR's avg cost (preserves
//          IBKR shares exactly, loses per-lot detail — acceptable trade-off
//          per Scott since the per-lot history was already incorrect).
//
// Run: node scripts_den/repairTodaysReconciliations.js              # dry run
//      node scripts_den/repairTodaysReconciliations.js --apply       # write
//
// Idempotent: re-running after success skips records already in target state.

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });
import { connectToDatabase } from '../database.js';
import { recordExit } from '../exitService.js';

const APPLY = process.argv.includes('--apply');
const SCOTT = '69c62632367d0e18498e7650';

// DTCR partial sale per Scott
const DTCR_SALE = {
  ticker: 'DTCR',
  shares: 51,
  price:  27.875,
  date:   '2026-04-28',
  time:   '08:35',
  reason: 'MANUAL',
  note:   'Manual partial sale in TWS at 08:35 PT — backfilled from Scott\'s confirmation 2026-04-28',
};

// Avg-cost reconciliations: trust IBKR's avg cost as authoritative source
const AVG_COST_RECONCILE = ['GOOGL', 'FCFS', 'MSFT', 'IRM', 'QCOM'];

const db = await connectToDatabase();
const mode = APPLY ? 'APPLY' : 'DRY-RUN';
console.log(`\n=== Repair today's reconciliations — ${mode} ===\n`);

// ── (1) DTCR partial sale ─────────────────────────────────────────────────
console.log('--- 1. DTCR partial sale (51 sh @ $27.875) ---');
{
  const p = await db.collection('pnthr_portfolio').findOne({
    ownerId: SCOTT, ticker: 'DTCR', status: { $in: ['ACTIVE', 'PARTIAL'] },
  }, { sort: { createdAt: -1 } });
  if (!p) {
    console.log('  ✗ DTCR position not found (already fully closed?)');
  } else {
    const totalFilled = Object.values(p.fills || {}).reduce((s, f) => s + (f?.filled ? +f.shares || 0 : 0), 0);
    const alreadyExited = (p.exits || []).reduce((s, e) => s + (+e.shares || 0), 0);
    const remaining = totalFilled - alreadyExited;
    console.log(`  position id=${p.id} totalFilled=${totalFilled} alreadyExited=${alreadyExited} remaining=${remaining}`);

    // Idempotency check: did we already record this exact partial?
    const dupExit = (p.exits || []).find(e =>
      +e.shares === DTCR_SALE.shares &&
      Math.abs(+e.price - DTCR_SALE.price) < 0.01 &&
      e.date === DTCR_SALE.date
    );

    if (dupExit) {
      console.log(`  ✓ SKIP — exit already recorded (id=${dupExit.id})`);
    } else if (DTCR_SALE.shares > remaining) {
      console.log(`  ✗ ERROR — Scott confirmed selling ${DTCR_SALE.shares} sh, but only ${remaining} sh remain to exit. Inspect manually.`);
    } else if (!APPLY) {
      console.log(`  → DRY: would call recordExit with ${JSON.stringify(DTCR_SALE)}`);
      console.log(`     Expected post-state: ${remaining - DTCR_SALE.shares} sh remaining, status PARTIAL`);
    } else {
      try {
        const result = await recordExit(db, p.id, SCOTT, DTCR_SALE);
        console.log(`  ✓ DONE — exited ${DTCR_SALE.shares} sh @ $${DTCR_SALE.price}, P&L $${result.exitRecord.pnl.dollar}/${result.exitRecord.pnl.pct}%, status=${result.status}, remaining=${result.remainingShares}`);
      } catch (e) {
        console.log(`  ✗ recordExit failed: ${e.message}`);
      }
    }
  }
}

// ── (2) Avg-cost reconciliation: IBKR is authoritative ───────────────────
console.log('\n--- 2. Avg-cost reconciliation (IBKR avg → PNTHR fills) ---');
const ibkrDoc = await db.collection('pnthr_ibkr_positions').findOne({ ownerId: SCOTT });
const ibkrByTicker = new Map((ibkrDoc?.positions || []).map(p => [p.symbol?.toUpperCase(), p]));

for (const ticker of AVG_COST_RECONCILE) {
  const p = await db.collection('pnthr_portfolio').findOne({
    ownerId: SCOTT, ticker, status: 'ACTIVE',
  }, { sort: { createdAt: -1 } });
  if (!p) { console.log(`  ${ticker.padEnd(6)} ✗ no ACTIVE position`); continue; }

  const ibkr = ibkrByTicker.get(ticker);
  if (!ibkr || !ibkr.avgCost) { console.log(`  ${ticker.padEnd(6)} ✗ IBKR position/avg missing`); continue; }

  const ibkrShares = Math.abs(+ibkr.shares || 0);
  const ibkrAvg    = +(+ibkr.avgCost).toFixed(4);

  // Verify shares match (this script is for same-shares, drifted-avg cases only;
  // shares mismatches are handled separately as partial-fill repairs).
  const pnthrShares = Object.values(p.fills || {}).reduce((s, f) => s + (f?.filled ? +f.shares || 0 : 0), 0);
  if (pnthrShares !== ibkrShares) {
    console.log(`  ${ticker.padEnd(6)} ✗ SKIP — shares mismatch (PNTHR ${pnthrShares} vs IBKR ${ibkrShares}); not an avg-cost-only fix`);
    continue;
  }

  // Compute current PNTHR avg
  const fills      = Object.values(p.fills || {}).filter(f => f?.filled && f.price && f.shares);
  const totalCost  = fills.reduce((s, f) => s + (+f.shares || 0) * (+f.price || 0), 0);
  const pnthrAvg   = pnthrShares > 0 ? +(totalCost / pnthrShares).toFixed(4) : null;

  if (pnthrAvg != null && Math.abs(pnthrAvg - ibkrAvg) < 0.01) {
    console.log(`  ${ticker.padEnd(6)} ✓ SKIP — already aligned (PNTHR $${pnthrAvg}, IBKR $${ibkrAvg})`);
    continue;
  }

  // Earliest original fill date — preserve so signal age / holding-period
  // calculations don't reset to today.
  const earliestFillDate = fills.map(f => f.date).filter(Boolean).sort()[0] || p.entryDate || new Date().toISOString().split('T')[0];

  // Build new fills: one consolidated fill at IBKR avg
  const newFills = {
    1: {
      lot:    1,
      name:   'The Scent',
      filled: true,
      pct:    1.0,
      shares: ibkrShares,
      price:  ibkrAvg,
      date:   earliestFillDate,
    },
  };

  const update = {
    $set: {
      fills:                    newFills,
      entryPrice:               ibkrAvg,
      totalFilledShares:        ibkrShares,
      remainingShares:          ibkrShares - (p.exits || []).reduce((s, e) => s + (+e.shares || 0), 0),
      ibkrAvgCost:              ibkr.avgCost,
      ibkrShares:               ibkrShares,
      avgCostReconciledAt:      new Date(),
      avgCostReconciledFrom:    { pnthrAvg, ibkrAvg, source: 'IBKR_AUTHORITATIVE' },
      updatedAt:                new Date(),
    },
  };

  if (!APPLY) {
    console.log(`  ${ticker.padEnd(6)} DRY  | ${pnthrShares}sh | PNTHR $${pnthrAvg} → IBKR $${ibkrAvg}  (replace fills with one consolidated lot @ $${ibkrAvg})`);
    continue;
  }

  try {
    await db.collection('pnthr_portfolio').updateOne({ id: p.id, ownerId: SCOTT }, update);
    console.log(`  ${ticker.padEnd(6)} ✓    | ${pnthrShares}sh | PNTHR $${pnthrAvg} → $${ibkrAvg}`);
  } catch (e) {
    console.log(`  ${ticker.padEnd(6)} ✗ updateOne failed: ${e.message}`);
  }
}

console.log(`\n=== ${mode} complete ===`);
if (!APPLY) console.log('Re-run with --apply to write.\n');
process.exit(0);
