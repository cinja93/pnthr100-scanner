// server/aiAutoExecute.js
// ── PNTHR AI 300 — APEX v7 Auto-Execution (Sector Rotation) ─────────────────
//
// Single entry path: Weekly Direct Entry
//   Full Lot 1 at 100% → MKT entry + weekly stop + L2-L5 triggers
//   Sector rotation gates entries (GO/NEUTRAL/NO_GO tiers from 5D ranking).
//
// Kill switch: AI_AUTO_EXECUTE env var (default OFF)
// Dry-run: AI_AUTO_EXECUTE_DRY_RUN env var (default ON)
// ──────────────────────────────────────────────────────────────────────────────

import { connectToDatabase, getUserProfile } from './database.js';
import { enqueue as enqueueOutbox, buildStopOrderShape } from './ibkrOutbox.js';
import { getStrategyMode, isCarnivoreMode } from './data/strategyMode.js';
import {
  computeLotTargetShares,
  computeLotPlan,
  computeTargetAvg,
  STRIKE_PCT,
  LOT_NAMES,
} from './lotMath.js';
import { computeWilderATR, blInitStop, ssInitStop } from './signalDetection.js';

const COLL_PORTFOLIO = 'pnthr_portfolio';
const COLL_AI_ORDERS = 'pnthr_ai_orders';

function isEnabled() {
  return process.env.AI_AUTO_EXECUTE === 'true';
}
function isDryRun() {
  return process.env.AI_AUTO_EXECUTE_DRY_RUN !== 'false';
}

function makePosId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function buildFillsSkeleton() {
  const fills = {};
  for (let i = 1; i <= 5; i++) {
    fills[i] = {
      lot: i, name: LOT_NAMES[i - 1], filled: false,
      pct: STRIKE_PCT[i - 1], shares: 0, price: null, date: null,
    };
  }
  return fills;
}

// ── Resolve ownerId + NAV ───────────────────────────────────────────────────
async function resolveContext(db, { ownerId, nav } = {}) {
  if (!ownerId) {
    const adminEmail = (process.env.ADMIN_EMAILS || '').split(',')[0]?.trim();
    if (!adminEmail) return null;
    const user = await db.collection('user_profiles').findOne({ email: adminEmail });
    if (!user) return null;
    ownerId = user.userId;
  }
  if (!nav) {
    const profile = await getUserProfile(ownerId).catch(() => null);
    nav = profile?.accountSize || 100000;
  }
  return { ownerId, nav };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Weekly Direct Entry — full L1 + stop + L2-L5 triggers
// Sector rotation gates entries. Called after runAiOrdersPipeline() completes.
// ═══════════════════════════════════════════════════════════════════════════════
export async function autoExecuteWeeklyOrders(opts = {}) {
  if (!isEnabled()) {
    console.log('[AI AutoExec] DISABLED — set AI_AUTO_EXECUTE=true to enable');
    return { skipped: 'DISABLED', positions: [], outbox: [] };
  }

  const db = await connectToDatabase();
  if (!db) return { skipped: 'NO_DB', positions: [], outbox: [] };

  const ctx = await resolveContext(db, opts);
  if (!ctx) return { skipped: 'NO_CONTEXT', positions: [], outbox: [] };
  const { ownerId, nav } = ctx;

  // Get the latest orders doc
  const latestOrder = await db.collection(COLL_AI_ORDERS)
    .find({}).sort({ generatedAt: -1 }).limit(1).toArray();
  if (!latestOrder.length) return { skipped: 'NO_ORDERS', positions: [], outbox: [] };
  const orderDoc = latestOrder[0];

  // Check existing positions to avoid doubling
  const existingPositions = await db.collection(COLL_PORTFOLIO)
    .find({ ownerId, status: { $in: ['ACTIVE', 'PARTIAL'] } }).toArray();
  const activeTickers = new Set(existingPositions.map(p => p.ticker));

  const dryRun = isDryRun();
  const results = { positions: [], outbox: [], skipped: [], dryRun };

  const qualifiedOrders = (orderDoc.orders || []).filter(o => {
    if (!o.isNewSignal) return false;
    if (o.signal !== 'BL' && o.signal !== 'SS') return false;
    return true;
  });

  console.log(`[AI AutoExec] ${qualifiedOrders.length} qualified weekly orders from ${orderDoc.weekOf} (dryRun=${dryRun})`);

  for (const order of qualifiedOrders) {
    const { ticker } = order;

    if (activeTickers.has(ticker)) {
      results.skipped.push({ ticker, reason: 'ALREADY_ACTIVE' });
      continue;
    }

    const isLong = order.signal === 'BL';
    const direction = isLong ? 'LONG' : 'SHORT';
    const entryPrice = order.currentPrice;
    const stopPrice = order.stopPrice;

    if (!entryPrice || !stopPrice) {
      results.skipped.push({ ticker, reason: 'NO_PRICE_OR_STOP' });
      continue;
    }

    const riskPerShare = isLong ? (entryPrice - stopPrice) : (stopPrice - entryPrice);
    if (riskPerShare <= 0) {
      results.skipped.push({ ticker, reason: 'BAD_RISK' });
      continue;
    }

    const posId = makePosId();
    const now = new Date();

    const fills = buildFillsSkeleton();
    const sMult = isCarnivoreMode(ticker) ? 1.0 : (+(order.sectorMult) || 1.0);
    const partialPos = {
      entryPrice, stopPrice, originalStop: stopPrice,
      direction, isETF: false, fills, maxGapPct: order.maxGapPct || 0,
      sectorMult: sMult,
    };

    const lotShares = computeLotTargetShares(partialPos, nav);
    const totalShares = lotShares.reduce((s, v) => s + v, 0);
    for (let i = 0; i < 5; i++) fills[i + 1].shares = lotShares[i];
    partialPos.fills = fills;

    const lotPlan = computeLotPlan(partialPos, nav);

    const position = {
      id: posId,
      ticker,
      direction,
      signal: order.signal,
      entryPrice,
      currentPrice: entryPrice,
      stopPrice,
      originalStop: stopPrice,
      sector: order.sectorName || null,
      sectorId: order.sectorId || null,
      sectorMult: sMult,
      isETF: false,
      fills,
      targetShares: totalShares,
      targetAvg: null,
      maxGapPct: order.maxGapPct || 0,
      status: 'ACTIVE',
      ownerId,
      strategyMode: getStrategyMode(ticker),
      autoExecuted: true,
      autoExecuteSource: 'WEEKLY_DIRECT',
      autoExecuteMode: 'WEEKLY',
      weekOf: orderDoc.weekOf,
      killScore: order.killScore || null,
      qualityGrade: order.qualityGrade || null,
      createdAt: now,
      updatedAt: now,
      outcome: { exitPrice: null, profitPct: null, profitDollar: null, holdingDays: null, exitReason: null },
    };

    const targetAvg = computeTargetAvg(position, nav);
    position.targetAvg = targetAvg;

    const lot1Shares = lotShares[0];

    console.log(`[AI AutoExec] ${dryRun ? 'DRY-RUN' : 'LIVE'} WEEKLY ${ticker} ${direction} — L1=${lot1Shares}sh @${entryPrice}, stop=${stopPrice}, mode=${position.strategyMode}`);

    if (!dryRun) {
      await db.collection(COLL_PORTFOLIO).insertOne(position);
      activeTickers.add(ticker);
    }
    results.positions.push({ ticker, direction, lot1Shares, entryPrice, stopPrice, strategyMode: position.strategyMode, path: 'WEEKLY_DIRECT' });

    // Enqueue Lot 1 market entry
    const entryCmd = {
      ticker, direction, shares: lot1Shares,
      positionId: posId, lot: 1, source: 'WEEKLY_DIRECT', tif: 'DAY', rth: true,
    };
    if (!dryRun) {
      const r = await enqueueOutbox(db, ownerId, 'BUY_MARKET_TO_CATCH_UP', entryCmd);
      results.outbox.push({ ticker, command: 'ENTRY_MARKET', ...r });
    }

    // Enqueue protective stop
    const stopShape = buildStopOrderShape({ stopPrice, direction, stopExtendedHours: false });
    const stopCmd = {
      ticker, direction, shares: lot1Shares, stopPrice,
      positionId: posId, ...stopShape,
    };
    if (!dryRun) {
      const r = await enqueueOutbox(db, ownerId, 'PLACE_STOP', stopCmd);
      results.outbox.push({ ticker, command: 'PLACE_STOP', ...r });
    }

    // Enqueue L2-L5 pyramid triggers
    for (let i = 1; i < lotPlan.length; i++) {
      const plan = lotPlan[i];
      if (plan.targetShares <= 0 || !plan.triggerPrice || plan.triggerPrice <= 0) continue;

      const triggerCmd = {
        ticker, direction, shares: plan.targetShares,
        triggerPrice: plan.triggerPrice, positionId: posId,
        lot: plan.lot, orderType: 'STP', rth: true, tif: 'GTC',
      };
      if (!dryRun) {
        const r = await enqueueOutbox(db, ownerId, 'PLACE_LOT_TRIGGER', triggerCmd);
        results.outbox.push({ ticker, command: 'PLACE_LOT_TRIGGER', lot: plan.lot, ...r });
      }
    }
  }

  console.log(`[AI AutoExec] Weekly direct: ${results.positions.length} positions, ${results.outbox.length} outbox, ${results.skipped.length} skipped`);
  return results;
}


// Legacy wrapper — keeps existing API endpoints working.
export async function autoExecuteAiOrders(opts = {}) {
  return autoExecuteWeeklyOrders(opts);
}
