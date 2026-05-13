// server/aiAutoExecute.js
// ── PNTHR AI 300 — APEX v7 Auto-Execution (Sector Rotation) ─────────────────
//
// Friday-stage, Monday-execute flow:
//   Friday 4:15 PM: stageWeeklyOrders() — creates STAGED orders in portfolio
//   Monday 9:35 AM: executeWeeklyOrders() — promotes STAGED → ACTIVE, enqueues
//                   BUY_MARKET + PLACE_STOP + L2-L5 lot triggers
//
// Risk gates (checked at staging AND execution):
//   1. 20-position cap — total ACTIVE + STAGED + new entries ≤ 20
//   2. 10% total heat budget — sum of all position risk ≤ 10% NAV
//   3. 10% per-ticker concentration cap — in enqueueOutbox
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

const MAX_POSITIONS     = 20;
const MAX_BL_PER_WEEK   = 10;
const MAX_SS_PER_WEEK   = 10;
const HEAT_CAP_PCT      = 0.10;  // 10% NAV max total risk

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

// ── Heat calculation (portfolio-wide risk as % of NAV) ──────────────────────
function computePortfolioHeat(positions, nav) {
  if (!nav || nav <= 0) return { totalRisk: 0, totalRiskPct: 0, posCount: 0 };
  let totalRisk = 0;
  let posCount = 0;
  for (const p of positions) {
    const fills = p.fills || {};
    const filledShr = Object.values(fills).reduce(
      (s, f) => s + (f && f.filled ? (+f.shares || 0) : 0), 0
    );
    if (filledShr <= 0 && p.status !== 'STAGED') continue;
    const avg = filledShr > 0
      ? Object.values(fills).filter(f => f.filled).reduce(
          (s, f) => s + (+f.shares || 0) * (+f.price || 0), 0
        ) / filledShr
      : (+p.entryPrice || 0);
    const stop = +p.stopPrice || 0;
    const isLong = (p.direction || 'LONG') !== 'SHORT';
    const rps = Math.max(0, isLong ? avg - stop : stop - avg);
    // For STAGED positions (not yet filled), use L1 target shares × risk
    const shares = filledShr > 0 ? filledShr : (+p.targetShares || 0) * STRIKE_PCT[0];
    totalRisk += shares * rps;
    posCount++;
  }
  return {
    totalRisk: +totalRisk.toFixed(2),
    totalRiskPct: +(totalRisk / nav * 100).toFixed(2),
    posCount,
  };
}

// ── Estimate risk for a single new entry (L1 only) ──────────────────────────
function estimateL1Risk(entryPrice, stopPrice, nav, isETF, sectorMult) {
  const vitality = nav * (isETF ? 0.005 : 0.01) * (sectorMult || 1.0);
  const rps = Math.abs(entryPrice - stopPrice);
  if (rps <= 0) return 0;
  const totalShares = Math.floor(Math.min(
    Math.floor(vitality / rps),
    Math.floor(nav * 0.10 / entryPrice)
  ));
  const l1Shares = Math.max(1, Math.round(totalShares * STRIKE_PCT[0]));
  return l1Shares * rps;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STAGE — Friday 4:15 PM: create STAGED positions from order sheet
// ═══════════════════════════════════════════════════════════════════════════════
export async function stageWeeklyOrders(opts = {}) {
  if (!isEnabled()) {
    console.log('[AI AutoExec] DISABLED — set AI_AUTO_EXECUTE=true to enable');
    return { skipped: 'DISABLED', staged: [], skippedOrders: [] };
  }

  const db = await connectToDatabase();
  if (!db) return { skipped: 'NO_DB', staged: [], skippedOrders: [] };

  const ctx = await resolveContext(db, opts);
  if (!ctx) return { skipped: 'NO_CONTEXT', staged: [], skippedOrders: [] };
  const { ownerId, nav } = ctx;

  const dryRun = isDryRun();

  // Get the latest orders doc
  const latestOrder = await db.collection(COLL_AI_ORDERS)
    .find({}).sort({ generatedAt: -1 }).limit(1).toArray();
  if (!latestOrder.length) return { skipped: 'NO_ORDERS', staged: [], skippedOrders: [] };
  const orderDoc = latestOrder[0];

  // Check existing positions (ACTIVE + PARTIAL + STAGED all count toward cap)
  const existingPositions = await db.collection(COLL_PORTFOLIO)
    .find({ ownerId, status: { $in: ['ACTIVE', 'PARTIAL', 'STAGED'] } }).toArray();
  const activeTickers = new Set(existingPositions.map(p => p.ticker));
  let currentPosCount = existingPositions.length;

  // Compute current portfolio heat
  const currentHeat = computePortfolioHeat(existingPositions, nav);
  let runningRisk = currentHeat.totalRisk;

  const results = { staged: [], skippedOrders: [], dryRun, weekOf: orderDoc.weekOf };

  const qualifiedOrders = (orderDoc.orders || []).filter(o => {
    if (!o.isNewSignal) return false;
    if (o.signal !== 'BL' && o.signal !== 'SS') return false;
    return true;
  });

  // Separate BL and SS, apply per-direction caps
  const blOrders = qualifiedOrders.filter(o => o.signal === 'BL').slice(0, MAX_BL_PER_WEEK);
  const ssOrders = qualifiedOrders.filter(o => o.signal === 'SS').slice(0, MAX_SS_PER_WEEK);
  const allOrders = [...blOrders, ...ssOrders];

  console.log(`[AI AutoExec] STAGING ${allOrders.length} orders from ${orderDoc.weekOf} (${blOrders.length} BL + ${ssOrders.length} SS, dryRun=${dryRun})`);
  console.log(`[AI AutoExec] Current: ${currentPosCount} positions, heat=${currentHeat.totalRiskPct}% of ${nav} NAV`);

  for (const order of allOrders) {
    const { ticker } = order;

    // Gate: already active/staged
    if (activeTickers.has(ticker)) {
      results.skippedOrders.push({ ticker, reason: 'ALREADY_ACTIVE' });
      continue;
    }

    // Gate: 20-position cap
    if (currentPosCount >= MAX_POSITIONS) {
      results.skippedOrders.push({ ticker, reason: `POSITION_CAP_${MAX_POSITIONS}` });
      continue;
    }

    const isLong = order.signal === 'BL';
    const direction = isLong ? 'LONG' : 'SHORT';
    const entryPrice = order.currentPrice;
    const stopPrice = order.stopPrice;

    if (!entryPrice || !stopPrice) {
      results.skippedOrders.push({ ticker, reason: 'NO_PRICE_OR_STOP' });
      continue;
    }

    const riskPerShare = isLong ? (entryPrice - stopPrice) : (stopPrice - entryPrice);
    if (riskPerShare <= 0) {
      results.skippedOrders.push({ ticker, reason: 'BAD_RISK' });
      continue;
    }

    // Gate: 10% heat budget
    const sMult = isCarnivoreMode(ticker) ? 1.0 : (+(order.sectorMult) || 1.0);
    const newEntryRisk = estimateL1Risk(entryPrice, stopPrice, nav, false, sMult);
    if ((runningRisk + newEntryRisk) / nav > HEAT_CAP_PCT) {
      results.skippedOrders.push({ ticker, reason: `HEAT_CAP_${((runningRisk + newEntryRisk) / nav * 100).toFixed(1)}PCT` });
      continue;
    }

    const posId = makePosId();
    const now = new Date();

    const fills = buildFillsSkeleton();
    const partialPos = {
      entryPrice, stopPrice, originalStop: stopPrice,
      direction, isETF: false, fills, maxGapPct: order.maxGapPct || 0,
      sectorMult: sMult,
    };

    const lotShares = computeLotTargetShares(partialPos, nav);
    const totalShares = lotShares.reduce((s, v) => s + v, 0);
    for (let i = 0; i < 5; i++) fills[i + 1].shares = lotShares[i];
    partialPos.fills = fills;

    const targetAvg = computeTargetAvg({ ...partialPos, fills }, nav);

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
      targetAvg,
      maxGapPct: order.maxGapPct || 0,
      status: 'STAGED',
      ownerId,
      strategyMode: getStrategyMode(ticker),
      autoExecuted: true,
      autoExecuteSource: 'WEEKLY_DIRECT',
      autoExecuteMode: 'WEEKLY',
      stagedAt: now,
      stagedWeekOf: orderDoc.weekOf,
      weekOf: orderDoc.weekOf,
      killScore: order.killScore || null,
      qualityGrade: order.qualityGrade || null,
      createdAt: now,
      updatedAt: now,
      outcome: { exitPrice: null, profitPct: null, profitDollar: null, holdingDays: null, exitReason: null },
    };

    console.log(`[AI AutoExec] ${dryRun ? 'DRY-RUN' : 'STAGED'} ${ticker} ${direction} — L1=${lotShares[0]}sh @${entryPrice}, stop=${stopPrice}, heat+=${(newEntryRisk / nav * 100).toFixed(2)}%`);

    if (!dryRun) {
      await db.collection(COLL_PORTFOLIO).insertOne(position);
      activeTickers.add(ticker);
    }

    currentPosCount++;
    runningRisk += newEntryRisk;
    results.staged.push({
      ticker, direction, lot1Shares: lotShares[0], entryPrice, stopPrice,
      strategyMode: position.strategyMode, estimatedRiskPct: +(newEntryRisk / nav * 100).toFixed(2),
    });
  }

  console.log(`[AI AutoExec] Staging complete: ${results.staged.length} staged, ${results.skippedOrders.length} skipped, total heat=${(runningRisk / nav * 100).toFixed(1)}%`);
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXECUTE — Monday 9:35 AM: promote STAGED → ACTIVE, enqueue outbox commands
// ═══════════════════════════════════════════════════════════════════════════════
export async function executeWeeklyOrders(opts = {}) {
  if (!isEnabled()) {
    console.log('[AI AutoExec] DISABLED — set AI_AUTO_EXECUTE=true to enable');
    return { skipped: 'DISABLED', executed: [], outbox: [] };
  }

  const db = await connectToDatabase();
  if (!db) return { skipped: 'NO_DB', executed: [], outbox: [] };

  const ctx = await resolveContext(db, opts);
  if (!ctx) return { skipped: 'NO_CONTEXT', executed: [], outbox: [] };
  const { ownerId, nav } = ctx;

  const dryRun = isDryRun();

  // Find all STAGED positions for this owner
  const stagedPositions = await db.collection(COLL_PORTFOLIO)
    .find({ ownerId, status: 'STAGED', autoExecuteSource: 'WEEKLY_DIRECT' }).toArray();

  if (!stagedPositions.length) {
    console.log('[AI AutoExec] No STAGED positions to execute');
    return { skipped: 'NO_STAGED', executed: [], outbox: [] };
  }

  // Re-check portfolio heat at execution time (prices may have changed over weekend)
  const allPositions = await db.collection(COLL_PORTFOLIO)
    .find({ ownerId, status: { $in: ['ACTIVE', 'PARTIAL'] } }).toArray();
  const currentHeat = computePortfolioHeat(allPositions, nav);
  let runningRisk = currentHeat.totalRisk;

  console.log(`[AI AutoExec] EXECUTING ${stagedPositions.length} staged positions (dryRun=${dryRun}), current heat=${currentHeat.totalRiskPct}%`);

  const results = { executed: [], outbox: [], skippedOrders: [], dryRun };

  for (const position of stagedPositions) {
    const { ticker, direction, entryPrice, stopPrice } = position;
    const isLong = direction === 'LONG';
    const sMult = position.sectorMult || 1.0;

    // Re-check heat gate at execution time
    const newEntryRisk = estimateL1Risk(entryPrice, stopPrice, nav, false, sMult);
    if ((runningRisk + newEntryRisk) / nav > HEAT_CAP_PCT) {
      console.log(`[AI AutoExec] HEAT CAP — skipping ${ticker} (would be ${((runningRisk + newEntryRisk) / nav * 100).toFixed(1)}%)`);
      results.skippedOrders.push({ ticker, reason: 'HEAT_CAP_AT_EXECUTION' });
      if (!dryRun) {
        await db.collection(COLL_PORTFOLIO).updateOne({ _id: position._id }, {
          $set: { status: 'CLOSED', closedAt: new Date(), updatedAt: new Date(),
            outcome: { exitPrice: 0, profitPct: 0, profitDollar: 0, holdingDays: 0, exitReason: 'HEAT_CAP_REJECTED' } },
        });
      }
      continue;
    }

    // Promote STAGED → ACTIVE
    if (!dryRun) {
      await db.collection(COLL_PORTFOLIO).updateOne({ _id: position._id }, {
        $set: { status: 'ACTIVE', activatedAt: new Date(), updatedAt: new Date() },
      });
    }

    const lotPlan = computeLotPlan(position, nav);
    const lot1Shares = position.fills?.[1]?.shares || lotPlan[0]?.targetShares || 0;

    console.log(`[AI AutoExec] ${dryRun ? 'DRY-RUN' : 'LIVE'} EXECUTE ${ticker} ${direction} — L1=${lot1Shares}sh @MKT, stop=${stopPrice}`);

    results.executed.push({ ticker, direction, lot1Shares, entryPrice, stopPrice });

    // Enqueue Lot 1 market entry
    if (!dryRun) {
      const entryCmd = {
        ticker, direction, shares: lot1Shares,
        positionId: position.id, lot: 1, source: 'WEEKLY_DIRECT_MONDAY', tif: 'DAY', rth: true,
      };
      const r = await enqueueOutbox(db, ownerId, 'BUY_MARKET_TO_CATCH_UP', entryCmd);
      results.outbox.push({ ticker, command: 'ENTRY_MARKET', ...r });
    }

    // Enqueue protective stop
    if (!dryRun) {
      const stopShape = buildStopOrderShape({ stopPrice, direction, stopExtendedHours: false });
      const stopCmd = {
        ticker, direction, shares: lot1Shares, stopPrice,
        positionId: position.id, ...stopShape,
      };
      const r = await enqueueOutbox(db, ownerId, 'PLACE_STOP', stopCmd);
      results.outbox.push({ ticker, command: 'PLACE_STOP', ...r });
    }

    // Enqueue L2-L5 pyramid triggers (STOP MKT orders)
    if (!dryRun) {
      for (let i = 1; i < lotPlan.length; i++) {
        const plan = lotPlan[i];
        if (plan.targetShares <= 0 || !plan.triggerPrice || plan.triggerPrice <= 0) continue;

        const triggerCmd = {
          ticker, direction, shares: plan.targetShares,
          triggerPrice: plan.triggerPrice, positionId: position.id,
          lot: plan.lot, orderType: 'STP', rth: true, tif: 'GTC',
        };
        const r = await enqueueOutbox(db, ownerId, 'PLACE_LOT_TRIGGER', triggerCmd);
        results.outbox.push({ ticker, command: 'PLACE_LOT_TRIGGER', lot: plan.lot, ...r });
      }
    }

    runningRisk += newEntryRisk;
  }

  console.log(`[AI AutoExec] Execution complete: ${results.executed.length} executed, ${results.outbox.length} outbox, ${results.skippedOrders.length} skipped`);
  return results;
}


// Legacy wrappers — keeps existing API endpoints working.
export async function autoExecuteWeeklyOrders(opts = {}) {
  return stageWeeklyOrders(opts);
}
export async function autoExecuteAiOrders(opts = {}) {
  return stageWeeklyOrders(opts);
}
