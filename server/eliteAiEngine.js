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
import { computeLotTargetShares, LOT_OFFSETS } from './lotMath.js';

const COLL = 'pnthr_elite_positions';
const TRADES = 'pnthr_elite_trades';
const FMP = 'https://financialmodelingprep.com/api/v3';
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

// Independent rule-recompute verification — the paper analogue of Ambush's
// IBKR-truth reconcile. Recomputes what each value SHOULD be per the strategy
// and flags drift. When live, the IBKR-position comparison plugs in here.
export function verifyElitePosition(pos, nav = 100000) {
  const isLong = pos.direction === 'LONG';
  const entry = +pos.entryPrice, stop = +(pos.stop ?? pos.stopPrice), avg = +pos.avgCost || entry, sh = +pos.totalShares || 0;
  const cur = +pos.currentPrice || entry;
  const checks = {};
  checks.direction = ((pos.signal === 'BL') === isLong) ? { status: 'green' } : { status: 'red', reason: `${pos.signal}≠${pos.direction}` };
  const plannedFilled = (pos.lotPlan || []).slice(0, pos.nextLot || 1).reduce((s, v) => s + v, 0);
  checks.shares = (sh === plannedFilled) ? { status: 'green' } : { status: 'yellow', reason: `${sh} vs plan ${plannedFilled}` };
  checks.stopLevel = (isLong ? stop < cur : stop > cur) ? { status: 'green' } : { status: 'red', reason: `wrong side of ${cur.toFixed(2)}` };
  const notional = sh * avg;
  checks.cap = (notional <= nav * 0.10 + 1) ? { status: 'green' } : { status: 'red', reason: `${(notional / nav * 100).toFixed(1)}% > 10%` };
  const riskPct = (Math.abs(avg - stop) * sh) / nav;
  checks.risk = (riskPct <= 0.015) ? { status: 'green' } : { status: 'yellow', reason: `${(riskPct * 100).toFixed(2)}% NAV` };
  const ord = { red: 3, yellow: 2, green: 1 }; let rollup = 'green'; const reasons = [];
  for (const [k, c] of Object.entries(checks)) { if (ord[c.status] > ord[rollup]) rollup = c.status; if (c.reason) reasons.push(`${k}: ${c.reason}`); }
  return { rollup, checks, reasons };
}

export async function getElitePositions() {
  const db = await connectToDatabase();
  if (!db) return [];
  const positions = await db.collection(COLL).find({ status: { $in: ['ACTIVE', 'PARTIAL'] } }).sort({ createdAt: -1 }).toArray();
  return positions.map(p => ({ ...p, rec: verifyElitePosition(p) }));
}

// Clear the paper book (dry-run only — never touches anything but pnthr_elite_positions).
export async function resetEliteDryRun() {
  const db = await connectToDatabase();
  if (!db) return { deleted: 0 };
  const r = await db.collection(COLL).deleteMany({ dryRun: true });
  await db.collection(TRADES).deleteMany({ dryRun: true });
  return { deleted: r.deletedCount };
}

// Live FMP quotes for a set of tickers → { TICKER: price }
async function fetchQuotes(tickers) {
  const K = process.env.FMP_API_KEY; const out = {};
  for (let i = 0; i < tickers.length; i += 50) {
    const batch = tickers.slice(i, i + 50);
    try { const r = await fetch(`${FMP}/quote/${batch.join(',')}?apikey=${K}`); const j = await r.json(); if (Array.isArray(j)) for (const q of j) if (q.price != null) out[(q.symbol || '').toUpperCase()] = +q.price; } catch { /* skip */ }
  }
  return out;
}

// ── MANAGE pass (paper) ──────────────────────────────────────────────────────
// For each open paper position, against the live price: fill L2-L5 as price
// clears each +3/6/10/14% trigger, ratchet the stop as lots fill (L3→break-even,
// L4→L2 level, L5→L3 level), and close on a stop hit. Updates live P&L + peak.
// Paper only — touches nothing but pnthr_elite_positions / pnthr_elite_trades.
const RATCHET_AT = { 3: 0, 4: 1, 5: 2 }; // nextLot reached → stop anchored at LOT_OFFSETS[index]

export async function manageEliteAiDryRun() {
  const db = await connectToDatabase();
  if (!db) return { fills: 0, exits: 0, changed: false };
  const positions = await db.collection(COLL).find({ status: { $in: ['ACTIVE', 'PARTIAL'] } }).toArray();
  if (!positions.length) return { fills: 0, exits: 0, changed: false };

  const prices = await fetchQuotes([...new Set(positions.map(p => p.ticker))]);
  let fills = 0, exits = 0;

  for (const p of positions) {
    const px = prices[p.ticker]; if (px == null) continue;
    const isLong = p.direction === 'LONG';
    const anchor = +p.originalEntry || +p.entryPrice;
    let nextLot = p.nextLot || 1, totalShares = p.totalShares || 0, avgCost = +p.avgCost || anchor, stop = +p.stop || +p.stopPrice, atBE = !!p.atBE;
    let changed = false;

    // (a) lot fills — paper-fill at the trigger as price clears it
    while (nextLot < 5) {
      const trig = isLong ? +(anchor * (1 + LOT_OFFSETS[nextLot])).toFixed(2) : +(anchor * (1 - LOT_OFFSETS[nextLot])).toFixed(2);
      const cleared = isLong ? px >= trig : px <= trig;
      if (!cleared) break;
      const addSh = (p.lotPlan || [])[nextLot] || 0;
      if (addSh > 0) { avgCost = (avgCost * totalShares + trig * addSh) / (totalShares + addSh); totalShares += addSh; }
      nextLot += 1; fills++; changed = true;
    }

    // (b) ratchet stop as lots fill
    if (RATCHET_AT[nextLot] != null) {
      const lvl = isLong ? +(anchor * (1 + LOT_OFFSETS[RATCHET_AT[nextLot]])).toFixed(2) : +(anchor * (1 - LOT_OFFSETS[RATCHET_AT[nextLot]])).toFixed(2);
      const newStop = isLong ? Math.max(stop, lvl) : Math.min(stop, lvl);
      if (newStop !== stop) { stop = newStop; changed = true; }
      atBE = true;
    }

    // (c) exit on stop hit (paper)
    const stopHit = isLong ? px <= stop : px >= stop;
    if (stopHit) {
      const exitPx = stop;
      const pnl = isLong ? (exitPx - avgCost) * totalShares : (avgCost - exitPx) * totalShares;
      const now = new Date();
      await db.collection(COLL).updateOne({ _id: p._id }, { $set: { status: 'CLOSED', exitPrice: exitPx, exitReason: 'STOP', pnl: +pnl.toFixed(2), nextLot, totalShares, avgCost: +avgCost.toFixed(4), stop, closedAt: now, updatedAt: now } });
      await db.collection(TRADES).insertOne({ ticker: p.ticker, direction: p.direction, entryPrice: p.entryPrice, exitPrice: exitPx, avgCost: +avgCost.toFixed(4), shares: totalShares, pnl: +pnl.toFixed(2), exitReason: 'STOP', entryDate: p.entryDate, exitDate: todayET(), dryRun: true, createdAt: now });
      exits++; continue;
    }

    // (d) live P&L + peak
    const livePnl = isLong ? (px - avgCost) * totalShares : (avgCost - px) * totalShares;
    const peak = Math.max(+p.peak || 0, livePnl);
    if (changed || px !== p.currentPrice) {
      await db.collection(COLL).updateOne({ _id: p._id }, { $set: { nextLot, totalShares, avgCost: +avgCost.toFixed(4), stop, atBE, currentPrice: px, livePnl: +livePnl.toFixed(2), peak: +peak.toFixed(2), updatedAt: new Date() } });
    }
  }
  return { fills, exits, changed: fills > 0 || exits > 0, managed: positions.length };
}

export async function getEliteTrades(limit = 30) {
  const db = await connectToDatabase();
  if (!db) return [];
  return db.collection(TRADES).find({}).sort({ createdAt: -1 }).limit(limit).toArray();
}
