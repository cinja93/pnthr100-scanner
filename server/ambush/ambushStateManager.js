// server/ambush/ambushStateManager.js
// ── PNTHR AMBUSH — MongoDB State Manager ────────────────────────────────────
//
// Manages the pnthr_ambush_positions collection. Each document represents a
// ticker's current Ambush state (STALKING/ATTACK/ACTIVE/PROTECT) with all
// the data needed to process the next hourly bar.
//
// Also manages pnthr_ambush_outbox for order commands sent to the IBKR bridge.
//
// Collection: pnthr_ambush_positions
//   {
//     ticker:          'NVDA',
//     state:           'ACTIVE',           // STALKING | ATTACK | ACTIVE | PROTECT
//     direction:       'LONG',             // LONG | SHORT
//     entryPrice:      135.50,             // L1 fill price (with slippage)
//     avgCost:         136.12,             // weighted avg across filled lots
//     totalShares:     45,                 // current total shares held
//     lotPlan:         [16, 11, 9, 5, 4],  // target shares per lot
//     nextLot:         2,                  // next lot to fill (1-indexed, 1=L2)
//     originalEntry:   135.50,             // original L1 price for lot offset calc
//     stop:            131.20,             // current stop price
//     atBE:            false,              // Break Even triggered?
//     trailingActive:  false,              // trailing stop active? (day after BE)
//     beDate:          null,               // date BE was triggered
//     peak:            0,                  // peak unrealized P&L
//     cycleNum:        0,                  // re-entry cycle count
//     entryDate:       '2026-06-02',       // date position was opened
//     firstHourLow:    134.80,             // today's first-hour low (STALKING tripwire)
//     firstHourHigh:   136.20,             // today's first-hour high (SHORT tripwire)
//     runningLow:      133.50,             // running low since trip (for re-entry stop)
//     runningHigh:     137.00,             // running high since trip (for SHORT re-entry)
//     consecutiveLowerLows: 0,             // 2-bar trailing exit counter
//     prevBarLow:      null,               // previous bar's low (for consecutive LL)
//     prevBarHigh:     null,               // previous bar's high (for consecutive HH)
//     lastBarDate:     '2026-06-02 11:30', // last processed hourly bar
//     createdAt:       Date,
//     updatedAt:       Date,
//   }
//
// Collection: pnthr_ambush_trades (closed trade log)
//   {
//     ticker, direction, entryPrice, exitPrice, shares, pnl,
//     entryDate, exitDate, exitType, cycleNum, commission, borrow,
//     peakProfit, duration, createdAt,
//   }
// ────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from '../database.js';
import { STATES } from './ambushEngine.js';

const POSITIONS_COLLECTION = 'pnthr_ambush_positions';
const TRADES_COLLECTION    = 'pnthr_ambush_trades';
const OUTBOX_COLLECTION    = 'pnthr_ambush_outbox';
const CONFIG_COLLECTION    = 'pnthr_ambush_config';

// ── Position CRUD ───────────────────────────────────────────────────────────

export async function getAmbushPositions(db, state = null) {
  const query = state ? { state } : {};
  return db.collection(POSITIONS_COLLECTION).find(query).sort({ updatedAt: -1 }).toArray();
}

export async function getAmbushPosition(db, ticker) {
  return db.collection(POSITIONS_COLLECTION).findOne({ ticker: ticker.toUpperCase() });
}

export async function upsertAmbushPosition(db, ticker, update) {
  const now = new Date();
  return db.collection(POSITIONS_COLLECTION).updateOne(
    { ticker: ticker.toUpperCase() },
    {
      $set: { ...update, ticker: ticker.toUpperCase(), updatedAt: now },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );
}

export async function deleteAmbushPosition(db, ticker) {
  return db.collection(POSITIONS_COLLECTION).deleteOne({ ticker: ticker.toUpperCase() });
}

export async function countAmbushByState(db) {
  const pipeline = [
    { $group: { _id: '$state', count: { $sum: 1 } } },
  ];
  const results = await db.collection(POSITIONS_COLLECTION).aggregate(pipeline).toArray();
  const counts = { STALKING: 0, ATTACK: 0, ACTIVE: 0, PROTECT: 0, total: 0 };
  for (const r of results) {
    counts[r._id] = r.count;
    counts.total += r.count;
  }
  return counts;
}

// ── Trade Log ───────────────────────────────────────────────────────────────

export async function logAmbushTrade(db, trade) {
  return db.collection(TRADES_COLLECTION).insertOne({
    ...trade,
    createdAt: new Date(),
  });
}

export async function getAmbushTrades(db, limit = 50) {
  return db.collection(TRADES_COLLECTION)
    .find({})
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

// ── Outbox (order commands for IBKR bridge) ─────────────────────────────────

export async function enqueueAmbushOrder(db, command, request) {
  const id = `amb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return db.collection(OUTBOX_COLLECTION).insertOne({
    id,
    command,       // BUY_ENTRY, SELL_EXIT, PLACE_STOP, MODIFY_STOP, PLACE_LOT_TRIGGER, COVER_EXIT, SHORT_ENTRY
    request,       // { ticker, shares, price, stopPrice, direction, lot, ... }
    status: 'PENDING',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

export async function getAmbushPendingOrders(db, limit = 25) {
  return db.collection(OUTBOX_COLLECTION)
    .find({ status: 'PENDING' })
    .sort({ createdAt: 1 })
    .limit(limit)
    .toArray();
}

export async function markAmbushOrderDone(db, id, response) {
  return db.collection(OUTBOX_COLLECTION).updateOne(
    { id },
    { $set: { status: 'DONE', response, updatedAt: new Date() } }
  );
}

export async function markAmbushOrderFailed(db, id, error) {
  return db.collection(OUTBOX_COLLECTION).updateOne(
    { id },
    { $set: { status: 'FAILED', error, updatedAt: new Date() } }
  );
}

export async function getRecentAmbushOrders(db, limit = 50) {
  return db.collection(OUTBOX_COLLECTION)
    .find({})
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

// ── Config (NAV, enabled state, etc.) ───────────────────────────────────────

export async function getAmbushConfig(db) {
  const doc = await db.collection(CONFIG_COLLECTION).findOne({ key: 'ambush_config' });
  return doc || {
    enabled: false,
    nav: 83000,
    maxPositions: 999,
    lastCronRun: null,
    lastCronResult: null,
  };
}

export async function updateAmbushConfig(db, updates) {
  return db.collection(CONFIG_COLLECTION).updateOne(
    { key: 'ambush_config' },
    { $set: { ...updates, updatedAt: new Date() }, $setOnInsert: { key: 'ambush_config', createdAt: new Date() } },
    { upsert: true }
  );
}

// ── Indexes ─────────────────────────────────────────────────────────────────

export async function ensureAmbushIndexes(db) {
  try {
    await db.collection(POSITIONS_COLLECTION).createIndex({ ticker: 1 }, { unique: true });
    await db.collection(POSITIONS_COLLECTION).createIndex({ state: 1 });
    await db.collection(TRADES_COLLECTION).createIndex({ ticker: 1, exitDate: -1 });
    await db.collection(TRADES_COLLECTION).createIndex({ createdAt: -1 });
    await db.collection(OUTBOX_COLLECTION).createIndex({ status: 1, createdAt: 1 });
    await db.collection(OUTBOX_COLLECTION).createIndex({ createdAt: -1 });
    console.log('[Ambush] MongoDB indexes ensured');
  } catch (err) {
    console.error('[Ambush] Index creation failed:', err.message);
  }
}

// ── Summary for API ─────────────────────────────────────────────────────────

export async function getAmbushSummary(db) {
  const [positions, counts, config, recentTrades, recentOrders] = await Promise.all([
    getAmbushPositions(db),
    countAmbushByState(db),
    getAmbushConfig(db),
    getAmbushTrades(db, 20),
    getRecentAmbushOrders(db, 20),
  ]);

  // Calculate P&L from trades
  const totalPnl = recentTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const wins = recentTrades.filter(t => t.pnl > 0).length;
  const losses = recentTrades.filter(t => t.pnl < 0).length;

  return {
    config,
    counts,
    positions,
    recentTrades,
    recentOrders,
    stats: {
      totalPnl: +totalPnl.toFixed(2),
      winRate: recentTrades.length > 0 ? +(wins / recentTrades.length * 100).toFixed(1) : 0,
      wins,
      losses,
      totalTrades: recentTrades.length,
    },
  };
}
