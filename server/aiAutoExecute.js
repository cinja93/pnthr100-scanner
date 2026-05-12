// server/aiAutoExecute.js
// ── PNTHR AI 300 — Auto-Execution from Weekly Order Sheet ─────────────────
//
// Takes the latest AI Orders pipeline output and:
//   1. Creates pnthr_portfolio positions for new BL/SS entries
//   2. Enqueues market orders for Lot 1 entry via outbox → bridge → TWS
//   3. Enqueues protective STP MKT stops
//   4. Enqueues Lot 2-5 pyramid triggers (BUY STP / SELL STP)
//
// Kill switch: AI_AUTO_EXECUTE env var (default OFF)
// Dry-run: AI_AUTO_EXECUTE_DRY_RUN env var (default ON)
//
// Called after runAiOrdersPipeline() completes (manually or by cron).
// ──────────────────────────────────────────────────────────────────────────

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

const COLL_PORTFOLIO = 'pnthr_portfolio';
const COLL_AI_ORDERS = 'pnthr_ai_orders';

function isEnabled() {
  return process.env.AI_AUTO_EXECUTE === 'true';
}
function isDryRun() {
  return process.env.AI_AUTO_EXECUTE_DRY_RUN !== 'false';
}

export async function autoExecuteAiOrders({ ownerId, nav } = {}) {
  if (!isEnabled()) {
    console.log('[AI AutoExec] DISABLED — set AI_AUTO_EXECUTE=true to enable');
    return { skipped: 'DISABLED', positions: [], outbox: [] };
  }

  const db = await connectToDatabase();
  if (!db) return { skipped: 'NO_DB', positions: [], outbox: [] };

  if (!ownerId) {
    const adminEmail = (process.env.ADMIN_EMAILS || '').split(',')[0]?.trim();
    if (!adminEmail) return { skipped: 'NO_ADMIN_EMAIL', positions: [], outbox: [] };
    const user = await db.collection('user_profiles').findOne({ email: adminEmail });
    if (!user) return { skipped: 'ADMIN_NOT_FOUND', positions: [], outbox: [] };
    ownerId = user.userId;
  }

  if (!nav) {
    const profile = await getUserProfile(ownerId).catch(() => null);
    nav = profile?.accountSize || 100000;
  }

  const latestOrder = await db.collection(COLL_AI_ORDERS)
    .find({}).sort({ generatedAt: -1 }).limit(1).toArray();
  if (!latestOrder.length) return { skipped: 'NO_ORDERS', positions: [], outbox: [] };
  const orderDoc = latestOrder[0];

  const existingPositions = await db.collection(COLL_PORTFOLIO)
    .find({ ownerId, status: { $in: ['ACTIVE', 'PARTIAL'] } })
    .toArray();
  const activeTickers = new Set(existingPositions.map(p => p.ticker));

  const dryRun = isDryRun();
  const results = { positions: [], outbox: [], skipped: [], dryRun };

  const qualifiedOrders = (orderDoc.orders || []).filter(o => {
    if (!o.isNewSignal) return false;
    if (o.signal !== 'BL' && o.signal !== 'SS') return false;
    const label = o.qualityGrade;
    if (o.signal === 'BL' && label !== 'BEST' && label !== 'GOOD') return false;
    return true;
  });

  console.log(`[AI AutoExec] ${qualifiedOrders.length} qualified new orders from ${orderDoc.weekOf} (dryRun=${dryRun})`);

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

    const posId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const now = new Date();

    // Build fills skeleton — L1 unfilled, L2-L5 unfilled.
    // Shares are placeholders until computeLotTargetShares runs.
    const fills = {};
    for (let i = 1; i <= 5; i++) {
      fills[i] = {
        lot: i,
        name: LOT_NAMES[i - 1],
        filled: false,
        pct: STRIKE_PCT[i - 1],
        shares: 0,
        price: null,
        date: null,
      };
    }

    // Build partial position doc so the canonical sizing functions work.
    // sectorMult travels on the order from the AI Orders pipeline (1.25 GO,
    // 1.0 NEUTRAL). Carnivore-mode tickers always get 1.0 (no sector rotation).
    const sMult = isCarnivoreMode(ticker) ? 1.0 : (+(order.sectorMult) || 1.0);
    const partialPos = {
      entryPrice,
      stopPrice,
      originalStop: stopPrice,
      direction,
      isETF: false,
      fills,
      maxGapPct: order.maxGapPct || 0,
      sectorMult: sMult,
    };

    // Use the canonical sizing algorithm (same as Live table + 4g cron).
    const lotShares = computeLotTargetShares(partialPos, nav);
    const targetShares = lotShares.reduce((s, v) => s + v, 0);

    // Populate fills with canonical share counts.
    for (let i = 0; i < 5; i++) {
      fills[i + 1].shares = lotShares[i];
    }
    partialPos.fills = fills;

    // Build the lot plan to get canonical trigger prices.
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
      targetShares,
      targetAvg: null,
      maxGapPct: order.maxGapPct || 0,
      status: 'ACTIVE',
      ownerId,
      strategyMode: getStrategyMode(ticker),
      autoExecuted: true,
      autoExecuteSource: 'AI_ORDERS',
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

    console.log(`[AI AutoExec] ${dryRun ? 'DRY-RUN' : 'LIVE'} ${ticker} ${direction} — L1=${lot1Shares}sh @${entryPrice}, stop=${stopPrice}, mode=${position.strategyMode}`);

    if (!dryRun) {
      await db.collection(COLL_PORTFOLIO).insertOne(position);
      activeTickers.add(ticker);
    }
    results.positions.push({ ticker, direction, lot1Shares, entryPrice, stopPrice, strategyMode: position.strategyMode });

    // Enqueue Lot 1 market entry
    const entryCmd = {
      ticker,
      direction,
      shares: lot1Shares,
      positionId: posId,
      lot: 1,
      source: 'AUTO_ENTRY',
      tif: 'DAY',
      rth: true,
    };

    if (!dryRun) {
      const entryResult = await enqueueOutbox(db, ownerId, 'BUY_MARKET_TO_CATCH_UP', entryCmd);
      results.outbox.push({ ticker, command: 'ENTRY_MARKET', ...entryResult });
    }

    // Enqueue protective stop (STP MKT for RTH)
    const stopShape = buildStopOrderShape({ stopPrice, direction, stopExtendedHours: false });
    const stopCmd = {
      ticker,
      direction,
      shares: lot1Shares,
      stopPrice,
      positionId: posId,
      ...stopShape,
    };

    if (!dryRun) {
      const stopResult = await enqueueOutbox(db, ownerId, 'PLACE_STOP', stopCmd);
      results.outbox.push({ ticker, command: 'PLACE_STOP', ...stopResult });
    }

    // Enqueue Lot 2-5 pyramid triggers using canonical trigger prices
    for (let i = 1; i < lotPlan.length; i++) {
      const plan = lotPlan[i];
      if (plan.targetShares <= 0 || !plan.triggerPrice || plan.triggerPrice <= 0) continue;

      const triggerCmd = {
        ticker,
        direction,
        shares: plan.targetShares,
        triggerPrice: plan.triggerPrice,
        positionId: posId,
        lot: plan.lot,
        orderType: 'STP',
        rth: true,
        tif: 'GTC',
      };

      if (!dryRun) {
        const trigResult = await enqueueOutbox(db, ownerId, 'PLACE_LOT_TRIGGER', triggerCmd);
        results.outbox.push({ ticker, command: 'PLACE_LOT_TRIGGER', lot: plan.lot, ...trigResult });
      }
    }
  }

  console.log(`[AI AutoExec] Done — ${results.positions.length} positions, ${results.outbox.length} outbox commands, ${results.skipped.length} skipped`);
  return results;
}
