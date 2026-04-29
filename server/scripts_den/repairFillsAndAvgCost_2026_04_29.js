// server/scripts_den/repairFillsAndAvgCost_2026_04_29.js
// ── Round 2.C + 2.D: reconcile fills + avg cost to match IBKR ───────────────
//
// Today's roundtrip trading left several PNTHR docs with stale fills:
//   • SBUX : fills.1.shares=21 from 2026-04-24 entry, but +14/+14/+11 today
//            brought IBKR to 60sh. PNTHR didn't update fills. Also has a
//            mysterious remainingShares=35 (doesn't match 21, 60, or any
//            consistent state — likely artifact from an earlier IBKR sync).
//   • IBAT : fills.1.shares=72 from 2026-04-24, but IBKR shows 123. Avg cost
//            also drifted ($41.26 → $41.73).
//   • GOOGL: shares match (14), but new avg cost $351.51 vs fills $344.02
//            (the current 14sh are from today's 07:10:51 BOT @ $351.44, not
//            the prior 14sh @ $344 that were sold at 06:31:08).
//   • EXPE : shares match (10), avg drifted $243.57 → $245.75.
//   • QQQ  : shares match (3), avg drifted $656.52 → $659.95.
//
// Approach (mirrors yesterday's repairTodaysReconciliations.js pattern):
// replace fills{} with a single consolidated Lot 1 at IBKR's avg cost,
// preserving the canonical 'sector', 'stopPrice', 'originalStop',
// 'stopHistory', and exits[] untouched. Set totalFilledShares /
// remainingShares to match IBKR. entryPrice updated to IBKR avg.
//
// Records a reconciledFrom snapshot in each doc so the prior state is
// auditable.
//
// HARD VERIFICATION GATES per ticker (run before any write, abort on fail):
//   1. PNTHR doc exists (active/partial) — single record
//   2. IBKR position exists with expected shares + avgCost (within tolerance)
//   3. PNTHR exits.length === 0 (this script only reconciles non-exited
//      positions; if exits exist, the partial-sale math gets complex —
//      treat case-by-case)
//   4. Direction LONG (script doesn't handle SHORT yet)
//
// Idempotent — second run sees fills already match IBKR and skips.
//
// Run:  node scripts_den/repairFillsAndAvgCost_2026_04_29.js          # dry
//       node scripts_den/repairFillsAndAvgCost_2026_04_29.js --apply

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });
import { connectToDatabase } from '../database.js';

const APPLY = process.argv.includes('--apply');
const SCOTT = '69c62632367d0e18498e7650';

const TICKERS = [
  // Class A — shares + avg drift (stale fills from before today's adds)
  { ticker: 'SBUX', expectedIbkrShares: 60,  expectedIbkrAvg: 103.910705,  classification: 'SHARES_AND_AVG' },
  { ticker: 'IBAT', expectedIbkrShares: 123, expectedIbkrAvg: 41.7318699,  classification: 'SHARES_AND_AVG' },
  // Class B — avg drift only (today's roundtrip; new fill price differs from
  // commission-inclusive avg)
  { ticker: 'GOOGL', expectedIbkrShares: 14, expectedIbkrAvg: 351.5114,    classification: 'AVG_ONLY' },
  { ticker: 'EXPE',  expectedIbkrShares: 10, expectedIbkrAvg: 245.75,      classification: 'AVG_ONLY' },
  { ticker: 'QQQ',   expectedIbkrShares: 3,  expectedIbkrAvg: 659.9474,    classification: 'AVG_ONLY' },
];

const SHARES_TOL  = 0;       // exact
const AVG_TOL_ABS = 0.01;    // $0.01 — IBKR avg cost to 4 decimals; ours match within $0.01

const db = await connectToDatabase();
if (!db) { console.error('NO DB'); process.exit(1); }
const ibkrDoc = await db.collection('pnthr_ibkr_positions').findOne({ ownerId: SCOTT });
const ibkrPositions = ibkrDoc?.positions || [];
const ibkrByTicker = new Map(ibkrPositions.map(p => [p.symbol?.toUpperCase(), p]));

console.log(`\n=== Round 2.C + 2.D fills+avg reconciliation — ${APPLY ? 'APPLY' : 'DRY-RUN'} ===\n`);
console.log(`IBKR last sync: ${ibkrDoc?.syncedAt}\n`);

const proposed = [];
let anyFail = false;

for (const t of TICKERS) {
  console.log(`━━━ ${t.ticker} (${t.classification}) ━━━`);
  const gates = [];

  const docs = await db.collection('pnthr_portfolio').find({
    ownerId: SCOTT, ticker: t.ticker, status: { $in: ['ACTIVE', 'PARTIAL'] },
  }).toArray();
  gates.push({ name: 'exactly one PNTHR doc', ok: docs.length === 1, detail: `${docs.length} doc(s)` });
  const p = docs[0];

  const ibkr = ibkrByTicker.get(t.ticker);
  const ibkrShares = ibkr ? Math.abs(+ibkr.shares || 0) : 0;
  const ibkrAvg    = ibkr ? +ibkr.avgCost : 0;
  gates.push({ name: 'IBKR shares match expected', ok: ibkrShares === t.expectedIbkrShares,
    detail: `IBKR=${ibkrShares} expected=${t.expectedIbkrShares}` });
  gates.push({ name: 'IBKR avg cost matches expected (within $0.01)',
    ok: Math.abs(ibkrAvg - t.expectedIbkrAvg) < AVG_TOL_ABS,
    detail: `IBKR=$${ibkrAvg?.toFixed(4)} expected=$${t.expectedIbkrAvg}` });

  const exits = (p?.exits || []).length;
  gates.push({ name: 'no exits on doc', ok: exits === 0, detail: `${exits} exits` });

  gates.push({ name: 'direction LONG', ok: (p?.direction || '').toUpperCase() !== 'SHORT',
    detail: p?.direction || 'unknown' });

  // Idempotency: if PNTHR fills already match IBKR shape, skip
  const currentFilled = Object.values(p?.fills || {}).reduce((s, f) => s + (f?.filled ? +f.shares || 0 : 0), 0);
  const currentAvgFromFills = (() => {
    const filledArr = Object.values(p?.fills || {}).filter(f => f?.filled && f?.shares && f?.price);
    const totalShares = filledArr.reduce((s, f) => s + (+f.shares || 0), 0);
    const totalCost   = filledArr.reduce((s, f) => s + (+f.shares || 0) * (+f.price || 0), 0);
    return totalShares > 0 ? totalCost / totalShares : null;
  })();
  const alreadyReconciled = currentFilled === ibkrShares
    && currentAvgFromFills != null
    && Math.abs(currentAvgFromFills - ibkrAvg) < AVG_TOL_ABS;

  let allGatesOk = true;
  for (const g of gates) {
    console.log(`  ${g.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${g.name.padEnd(45)} (${g.detail})`);
    if (!g.ok) allGatesOk = false;
  }

  if (!allGatesOk) { anyFail = true; continue; }
  if (alreadyReconciled) {
    console.log(`  \x1b[32m✓\x1b[0m already reconciled — skip`);
    continue;
  }

  // Build proposed update.
  // Preserve original fill date (the earliest filled-lot date present, so
  // signal age / holding period don't reset).
  const earliestDate = (() => {
    const dates = Object.values(p.fills || {}).filter(f => f?.filled && f?.date).map(f => f.date).sort();
    return dates[0] || p.entryDate || ibkrDoc?.syncedAt?.toISOString().slice(0, 10);
  })();

  const newFills = {
    1: { lot: 1, name: 'The Scent', filled: true, pct: 1.0, shares: ibkrShares, price: +ibkrAvg.toFixed(4), date: earliestDate },
  };
  // Preserve any unfilled lot 2-5 markers if present (cosmetic)
  for (let i = 2; i <= 5; i++) {
    if (p.fills?.[i]) newFills[i] = p.fills[i];
    else newFills[i] = { filled: false };
  }

  const update = {
    fills:                newFills,
    entryPrice:           +ibkrAvg.toFixed(4),
    totalFilledShares:    ibkrShares,
    remainingShares:      ibkrShares,
    totalExitedShares:    0,
    ibkrAvgCost:          +ibkrAvg,
    ibkrShares,
    fillsReconciledAt:    new Date(),
    fillsReconciledFrom:  {
      classification:  t.classification,
      priorFills:      p.fills,
      priorEntryPrice: p.entryPrice,
      priorRemaining:  p.remainingShares,
      priorFilledTotal: currentFilled,
      priorAvgFromFills: currentAvgFromFills,
      reason:          `Round 2.${t.classification === 'SHARES_AND_AVG' ? 'C' : 'D'} reconciliation 2026-04-29: IBKR is authoritative`,
    },
    updatedAt:            new Date(),
  };

  proposed.push({ id: p.id, ticker: t.ticker, classification: t.classification, update,
                  before: { filled: currentFilled, avg: currentAvgFromFills, remaining: p.remainingShares },
                  after:  { filled: ibkrShares, avg: ibkrAvg, remaining: ibkrShares } });
  console.log(`  \x1b[33m→\x1b[0m ${t.classification === 'SHARES_AND_AVG' ? 'fills+avg+shares' : 'avg only'} change: filled ${currentFilled} → ${ibkrShares}, avg $${currentAvgFromFills?.toFixed(4)} → $${ibkrAvg.toFixed(4)}, remaining ${p.remainingShares} → ${ibkrShares}`);
}

if (anyFail) {
  console.log(`\n\x1b[31mABORTED — at least one gate failed.\x1b[0m\n`);
  process.exit(1);
}

console.log(`\n${proposed.length} ticker(s) ready to reconcile.`);
if (proposed.length === 0) {
  console.log(`\n\x1b[32m✓ No changes needed — all reconciliations already applied.\x1b[0m\n`);
  process.exit(0);
}

if (!APPLY) {
  console.log(`\n\x1b[33mDRY-RUN complete. Re-run with --apply to write.\x1b[0m\n`);
  process.exit(0);
}

console.log(`\nApplying…`);
let writes = 0;
for (const p of proposed) {
  try {
    const r = await db.collection('pnthr_portfolio').updateOne(
      { id: p.id, ownerId: SCOTT },
      { $set: p.update }
    );
    writes += r.modifiedCount;
    console.log(`  ${r.modifiedCount === 1 ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${p.ticker.padEnd(6)} (${p.classification}) modifiedCount=${r.modifiedCount}`);
  } catch (e) {
    console.log(`  \x1b[31m✗\x1b[0m ${p.ticker.padEnd(6)} updateOne failed: ${e.message}`);
  }
}

// Post-state verification
console.log(`\nPost-state verify:`);
for (const p of proposed) {
  const after = await db.collection('pnthr_portfolio').findOne({ id: p.id, ownerId: SCOTT });
  const filled = Object.values(after?.fills || {}).reduce((s, f) => s + (f?.filled ? +f.shares || 0 : 0), 0);
  const ok = filled === p.after.filled && +after?.entryPrice === +p.after.avg.toFixed(4);
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${p.ticker.padEnd(6)} filled=${filled} entryPrice=$${after?.entryPrice} remaining=${after?.remainingShares}`);
}

console.log(`\nWrites: ${writes}/${proposed.length}\n`);
if (writes === proposed.length) {
  console.log(`\x1b[32m✓ APPLY complete. Re-run audit to confirm sections 1c + 1d → 0.\x1b[0m\n`);
} else {
  console.log(`\x1b[31m✗ Some writes failed — investigate.\x1b[0m\n`);
  process.exit(1);
}
process.exit(0);
