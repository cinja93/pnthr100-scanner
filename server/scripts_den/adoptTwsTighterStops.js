// server/scripts_den/adoptTwsTighterStops.js
// ── Silently adopt IBKR's stop into PNTHR for any position where TWS is
//    tighter than PNTHR's current stop. Implements the universal
//    tightest-wins rule (see feedback_earnings_week_stops.md):
//
//      LONG : tightest = highest (IBKR > PNTHR  ⇒ adopt IBKR)
//      SHORT: tightest = lowest  (IBKR < PNTHR  ⇒ adopt IBKR)
//
//    Updates `pnthr_portfolio.stopPrice` and appends a stopHistory entry
//    `{ date, stop, reason: 'USER_TIGHTENED_VIA_TWS', from, ibkrPermId }`.
//
//    This script is the manual stand-in for Phase 4 sub-phase 4c (daily
//    4:30 ET cron). Re-run any morning the punch list shows STOP MISMATCH
//    items. Once 4c is enabled the cron will do this automatically.
//
// Run: node scripts_den/adoptTwsTighterStops.js              # dry run
//      node scripts_den/adoptTwsTighterStops.js --apply       # write
//
// Idempotent: skips positions where PNTHR is already at-or-tighter than IBKR.

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });
import { connectToDatabase } from '../database.js';

const APPLY = process.argv.includes('--apply');
const SCOTT = '69c62632367d0e18498e7650';
const TIGHTER_THRESHOLD = 0.05;  // ignore noise below $0.05

const db = await connectToDatabase();
const mode = APPLY ? 'APPLY' : 'DRY-RUN';
console.log(`\n=== Adopt TWS-tighter stops into PNTHR — ${mode} ===\n`);

const ibkrDoc = await db.collection('pnthr_ibkr_positions').findOne({ ownerId: SCOTT });
const ibkrStopOrders = ibkrDoc?.stopOrders || [];
const stopsByTicker = new Map();
for (const s of ibkrStopOrders) {
  const t = s.symbol?.toUpperCase();
  if (!t) continue;
  if (!stopsByTicker.has(t)) stopsByTicker.set(t, []);
  stopsByTicker.get(t).push(s);
}

const pnthr = await db.collection('pnthr_portfolio').find({
  ownerId: SCOTT, status: 'ACTIVE',
}).toArray();

const today = new Date().toISOString().slice(0, 10);
let adopted = 0;
let skippedNoIbkr = 0;
let skippedAtOrTighter = 0;

for (const p of pnthr) {
  const t = p.ticker?.toUpperCase();
  const isLong = (p.direction || 'LONG').toUpperCase() !== 'SHORT';
  const expectedAction = isLong ? 'SELL' : 'BUY';
  const stops = stopsByTicker.get(t) || [];
  const protective = stops.find(s => s.action === expectedAction && s.orderType === 'STP');

  if (!protective) { skippedNoIbkr++; continue; }
  const pnthrStop = p.stopPrice;
  const ibkrStop  = protective.stopPrice;
  if (pnthrStop == null || ibkrStop == null) { skippedNoIbkr++; continue; }

  const ibkrIsTighter = isLong
    ? (ibkrStop - pnthrStop > TIGHTER_THRESHOLD)
    : (pnthrStop - ibkrStop > TIGHTER_THRESHOLD);

  if (!ibkrIsTighter) { skippedAtOrTighter++; continue; }

  const historyEntry = {
    date:       today,
    stop:       ibkrStop,
    reason:     'USER_TIGHTENED_VIA_TWS',
    from:       pnthrStop,
    ibkrPermId: protective.permId,
  };

  const tag = `${t.padEnd(6)} ${isLong ? 'LONG ' : 'SHORT'} | $${pnthrStop.toFixed(2)} → $${ibkrStop.toFixed(2)} (TWS tighter by $${Math.abs(ibkrStop - pnthrStop).toFixed(2)})`;

  if (!APPLY) {
    console.log(`  DRY  ${tag}`);
    adopted++;
    continue;
  }

  try {
    await db.collection('pnthr_portfolio').updateOne(
      { id: p.id, ownerId: SCOTT },
      {
        $set:  { stopPrice: ibkrStop, updatedAt: new Date() },
        $push: { stopHistory: historyEntry },
      }
    );
    console.log(`  ✓    ${tag}`);
    adopted++;
  } catch (e) {
    console.log(`  ✗    ${tag}  — updateOne failed: ${e.message}`);
  }
}

console.log(`\nAdopted: ${adopted}  |  Skipped (PNTHR at-or-tighter): ${skippedAtOrTighter}  |  Skipped (no IBKR stop): ${skippedNoIbkr}`);
console.log(`\n=== ${mode} complete ===`);
if (!APPLY) console.log('Re-run with --apply to write.\n');
process.exit(0);
