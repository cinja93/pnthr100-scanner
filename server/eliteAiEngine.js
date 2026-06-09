// server/eliteAiEngine.js
// ── PNTHR Elite AI — DRY-RUN paper engine ───────────────────────────────────
//
// Isolated paper-trading engine for the AI-300 Elite strategy. Writes ONLY to
// its own `pnthr_elite_positions` collection — NO shared state with Ambush
// (pnthr_ambush_positions) or the Command Center (pnthr_portfolio). NO real
// orders, NO IBKR, NO outbox. Pure paper.
//
// v1 (entry simulation): reads the AI Orders pipeline, and for each qualifying
// BL/SS signal at/above the grade threshold, opens a PAPER position with the
// full 5-lot pyramid plan + the order's ATR/2-bar stop. The Elite AI page then
// renders these as ladder cards so you can watch the funnel produce positions
// on paper before any account is wired.
//
// (v2 — next: a manage pass that fills L2-L5 as live price clears each trigger,
//  ratchets the 2-bar stop, and closes on a stop hit.)
// ────────────────────────────────────────────────────────────────────────────
import { connectToDatabase } from './database.js';
import { getLatestAiOrders } from './aiOrdersPipeline.js';
import { computeLotTargetShares } from './lotMath.js';

const COLL = 'pnthr_elite_positions';
const GRADE_RANK = { GOOD: 0, BETTER: 1, BEST: 2 };

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Open paper positions for qualifying signals (idempotent — skips names already held).
// minGrade defaults to BEST (the live entry criterion); pass 'BETTER' to populate the
// paper book more fully for visualization.
export async function runEliteAiDryRun({ nav = 100000, minGrade = 'BEST' } = {}) {
  const db = await connectToDatabase();
  if (!db) return { error: 'NO_DB', created: [] };

  const doc = await getLatestAiOrders();
  const minRank = GRADE_RANK[minGrade] ?? 2;
  const orders = (doc?.orders || []).filter(o =>
    (o.signal === 'BL' || o.signal === 'SS') &&
    (GRADE_RANK[o.qualityGrade] ?? 0) >= minRank &&
    +o.currentPrice > 0 && +o.stopPrice > 0
  );

  const existing = await db.collection(COLL).find({ status: { $in: ['ACTIVE', 'PARTIAL'] } }).toArray();
  const held = new Set(existing.map(p => p.ticker));
  const created = [];
  const now = new Date(), today = todayET();

  for (const o of orders) {
    if (held.has(o.ticker)) continue;
    const direction = o.signal === 'BL' ? 'LONG' : 'SHORT';
    const entry = +o.currentPrice, stop = +o.stopPrice;
    const rps = direction === 'LONG' ? entry - stop : stop - entry;
    if (rps <= 0) continue;

    // 5-lot pyramid plan, sized off the ATR/2-bar stop (10% ticker cap, sector mult)
    const lotPlan = computeLotTargetShares(
      { entryPrice: entry, originalStop: stop, stopPrice: stop, direction, sectorMult: +o.sectorMult || 1, isETF: false, fills: {} },
      nav
    );
    if (!lotPlan[0]) continue;

    const pos = {
      ticker: o.ticker, direction, signal: o.signal,
      entryPrice: entry, originalEntry: entry, avgCost: entry,
      stopPrice: stop, originalStop: stop, stop,
      lotPlan, nextLot: 1,                          // L1 paper-filled, L2-L5 pending
      totalShares: lotPlan[0], targetShares: lotPlan.reduce((s, v) => s + v, 0),
      sector: o.sectorName || null, sectorId: o.sectorId || null, sectorMult: +o.sectorMult || 1,
      dailyTrigger: null, weeklyTrigger: null,
      gapPct: o.gapPct ?? null, qualityGrade: o.qualityGrade,
      peak: 0, atBE: false, cycleNum: 0,
      status: 'ACTIVE', dryRun: true, source: 'ELITE_DRYRUN',
      entryDate: today, createdAt: now, updatedAt: now,
    };
    await db.collection(COLL).insertOne(pos);
    held.add(o.ticker);
    created.push({ ticker: o.ticker, direction, l1Shares: lotPlan[0], totalShares: pos.targetShares, entry, stop });
  }

  return { created, totalOpen: existing.length + created.length, weekOf: doc?.weekOf || null, candidatesScanned: orders.length, minGrade };
}

export async function getElitePositions() {
  const db = await connectToDatabase();
  if (!db) return [];
  return db.collection(COLL).find({ status: { $in: ['ACTIVE', 'PARTIAL'] } }).sort({ createdAt: -1 }).toArray();
}

// Clear the paper book (dry-run only — never touches anything but pnthr_elite_positions).
export async function resetEliteDryRun() {
  const db = await connectToDatabase();
  if (!db) return { deleted: 0 };
  const r = await db.collection(COLL).deleteMany({ dryRun: true });
  return { deleted: r.deletedCount };
}
