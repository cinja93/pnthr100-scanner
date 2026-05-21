// server/aiAutoExecute.js
// ── PNTHR AI 300 — APEX v7 Auto-Execution (Sector Rotation) ─────────────────
//
// Friday-stage, Monday-execute flow:
//   Friday 4:15 PM: stageWeeklyOrders() — creates STAGED orders in portfolio
//   Monday 9:35 AM: executeWeeklyOrders() — promotes STAGED → ACTIVE, enqueues
//                   BUY_MARKET + PLACE_STOP + L2-L5 lot triggers
//
// Risk gates (checked at staging AND execution):
//   1. 10% total heat budget — sum of all position risk ≤ 10% NAV
//   2. 10% per-ticker concentration cap — in enqueueOutbox
//   3. Buying power check — NAV minus deployed capital minus 20% reserve
//      must cover the new Lot 1 dollar cost. Prevents over-leveraging
//      at small NAV sizes without artificially capping position count.
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
import { refreshOrderGrades } from './aiOrdersPipeline.js';
import { getPnthrAiSectorsLatest, getPnthrAiSectorBars } from './pnthrAiSectorsService.js';
import { SECTORS as AI_UNIVERSE_SECTORS } from './scripts/aiUniverse/aiUniverseData.js';

const COLL_PORTFOLIO = 'pnthr_portfolio';
const COLL_AI_ORDERS = 'pnthr_ai_orders';

const HEAT_CAP_PCT      = 0.10;  // 10% NAV max total risk
const CAPITAL_RESERVE   = 0.20;  // 20% NAV kept as buying power reserve

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
    const user = await db.collection('users').findOne({
      email: { $regex: new RegExp(`^${adminEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
    });
    if (!user) return null;
    ownerId = user._id.toString();
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

// ── Buying power: deployed capital + 20% reserve ────────────────────────────
function computeDeployedCapital(positions) {
  let deployed = 0;
  for (const p of positions) {
    const fills = p.fills || {};
    const filledShr = Object.values(fills).reduce(
      (s, f) => s + (f && f.filled ? (+f.shares || 0) : 0), 0
    );
    if (filledShr > 0) {
      const totalCost = Object.values(fills).filter(f => f.filled).reduce(
        (s, f) => s + (+f.shares || 0) * (+f.price || 0), 0
      );
      deployed += totalCost;
    } else if (p.status === 'STAGED') {
      // STAGED but not yet filled — estimate L1 cost from entry price × L1 shares
      const l1Shares = fills[1]?.shares || 0;
      deployed += l1Shares * (+p.entryPrice || 0);
    }
  }
  return +deployed.toFixed(2);
}

function computeAvailableBuyingPower(nav, deployedCapital) {
  // Available = NAV - deployed - 20% reserve
  const reserve = nav * CAPITAL_RESERVE;
  return Math.max(0, nav - deployedCapital - reserve);
}

// ── Estimate L1 dollar cost (what it costs to open the position) ────────────
function estimateL1Cost(entryPrice, stopPrice, nav, isETF, sectorMult) {
  const vitality = nav * (isETF ? 0.005 : 0.01) * (sectorMult || 1.0);
  const rps = Math.abs(entryPrice - stopPrice);
  if (rps <= 0 || entryPrice <= 0) return 0;
  const totalShares = Math.floor(Math.min(
    Math.floor(vitality / rps),
    Math.floor(nav * 0.10 / entryPrice)
  ));
  const l1Shares = Math.max(1, Math.round(totalShares * STRIKE_PCT[0]));
  return l1Shares * entryPrice;
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

  // Check existing positions (ACTIVE + PARTIAL + STAGED)
  const existingPositions = await db.collection(COLL_PORTFOLIO)
    .find({ ownerId, status: { $in: ['ACTIVE', 'PARTIAL', 'STAGED'] } }).toArray();
  const activeTickers = new Set(existingPositions.map(p => p.ticker));

  // Compute current portfolio heat + buying power
  const currentHeat = computePortfolioHeat(existingPositions, nav);
  let runningRisk = currentHeat.totalRisk;
  const deployedCapital = computeDeployedCapital(existingPositions);
  let availableBP = computeAvailableBuyingPower(nav, deployedCapital);

  const results = { staged: [], skippedOrders: [], dryRun, weekOf: orderDoc.weekOf };

  // Only auto-stage ★ BUY LONG / ★ SELL SHORT (qualityGrade BEST).
  // WAIT LONG / WAIT SHORT (GOOD) and LONG / SHORT (BETTER) sit on the
  // order sheet until the 60-second intraday monitor upgrades them.
  const allOrders = (orderDoc.orders || []).filter(o => {
    if (!o.isNewSignal) return false;
    if (o.signal !== 'BL' && o.signal !== 'SS') return false;
    if (o.qualityGrade !== 'BEST') return false;
    return true;
  });

  const blCount = allOrders.filter(o => o.signal === 'BL').length;
  const ssCount = allOrders.filter(o => o.signal === 'SS').length;

  console.log(`[AI AutoExec] STAGING ${allOrders.length} orders from ${orderDoc.weekOf} (${blCount} BL + ${ssCount} SS, dryRun=${dryRun})`);
  console.log(`[AI AutoExec] Current: ${existingPositions.length} positions, heat=${currentHeat.totalRiskPct}%, deployed=$${deployedCapital.toLocaleString()}, available BP=$${availableBP.toLocaleString()} (${(availableBP/nav*100).toFixed(1)}% NAV), reserve=${CAPITAL_RESERVE*100}%`);

  for (const order of allOrders) {
    const { ticker } = order;

    // Gate: already active/staged
    if (activeTickers.has(ticker)) {
      results.skippedOrders.push({ ticker, reason: 'ALREADY_ACTIVE' });
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

    const sMult = isCarnivoreMode(ticker) ? 1.0 : (+(order.sectorMult) || 1.0);

    // Gate: 10% heat budget
    const newEntryRisk = estimateL1Risk(entryPrice, stopPrice, nav, false, sMult);
    if ((runningRisk + newEntryRisk) / nav > HEAT_CAP_PCT) {
      results.skippedOrders.push({ ticker, reason: `HEAT_CAP_${((runningRisk + newEntryRisk) / nav * 100).toFixed(1)}PCT` });
      continue;
    }

    // Gate: buying power (NAV - deployed - 20% reserve must cover L1 cost)
    const l1Cost = estimateL1Cost(entryPrice, stopPrice, nav, false, sMult);
    if (l1Cost > availableBP) {
      results.skippedOrders.push({ ticker, reason: `BUYING_POWER_$${availableBP.toFixed(0)}_NEED_$${l1Cost.toFixed(0)}` });
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

    runningRisk += newEntryRisk;
    availableBP -= l1Cost;
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

  // Re-check portfolio heat + buying power at execution time (prices may have changed over weekend)
  const allPositions = await db.collection(COLL_PORTFOLIO)
    .find({ ownerId, status: { $in: ['ACTIVE', 'PARTIAL'] } }).toArray();
  const currentHeat = computePortfolioHeat(allPositions, nav);
  let runningRisk = currentHeat.totalRisk;
  const deployedCapital = computeDeployedCapital([...allPositions, ...stagedPositions]);
  let availableBP = computeAvailableBuyingPower(nav, deployedCapital);

  console.log(`[AI AutoExec] EXECUTING ${stagedPositions.length} staged positions (dryRun=${dryRun}), heat=${currentHeat.totalRiskPct}%, available BP=$${availableBP.toLocaleString()}`);

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

    // Re-check buying power at execution time
    const l1Cost = estimateL1Cost(entryPrice, stopPrice, nav, false, sMult);
    if (l1Cost > availableBP) {
      console.log(`[AI AutoExec] BUYING POWER — skipping ${ticker} (need $${l1Cost.toFixed(0)}, available $${availableBP.toFixed(0)})`);
      results.skippedOrders.push({ ticker, reason: 'BUYING_POWER_AT_EXECUTION' });
      if (!dryRun) {
        await db.collection(COLL_PORTFOLIO).updateOne({ _id: position._id }, {
          $set: { status: 'CLOSED', closedAt: new Date(), updatedAt: new Date(),
            outcome: { exitPrice: 0, profitPct: 0, profitDollar: 0, holdingDays: 0, exitReason: 'BUYING_POWER_REJECTED' } },
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
    availableBP -= l1Cost;
  }

  console.log(`[AI AutoExec] Execution complete: ${results.executed.length} executed, ${results.outbox.length} outbox, ${results.skippedOrders.length} skipped, remaining BP=$${availableBP.toFixed(0)}`);
  return results;
}


// ═══════════════════════════════════════════════════════════════════════════════
// MONITOR — 60-second intraday: recompute grades, auto-stage WAIT→BUY upgrades
// ═══════════════════════════════════════════════════════════════════════════════
export async function monitorAndStageUpgrades(opts = {}) {
  if (!isEnabled()) return { skipped: 'DISABLED', upgrades: [] };

  const { upgraded, doc } = await refreshOrderGrades();
  if (!upgraded.length || !doc) return { skipped: 'NO_UPGRADES', upgrades: [] };

  const db = await connectToDatabase();
  if (!db) return { skipped: 'NO_DB', upgrades: [] };

  const ctx = await resolveContext(db, opts);
  if (!ctx) return { skipped: 'NO_CONTEXT', upgrades: [] };
  const { ownerId, nav } = ctx;

  const dryRun = isDryRun();

  const existingPositions = await db.collection(COLL_PORTFOLIO)
    .find({ ownerId, status: { $in: ['ACTIVE', 'PARTIAL', 'STAGED'] } }).toArray();
  const activeTickers = new Set(existingPositions.map(p => p.ticker));

  const currentHeat = computePortfolioHeat(existingPositions, nav);
  let runningRisk = currentHeat.totalRisk;
  const deployedCapital = computeDeployedCapital(existingPositions);
  let availableBP = computeAvailableBuyingPower(nav, deployedCapital);

  const results = { staged: [], skippedOrders: [], dryRun, upgrades: upgraded };

  for (const upg of upgraded) {
    const order = doc.orders.find(o => o.ticker === upg.ticker && o.signal === upg.signal);
    if (!order) continue;

    const { ticker } = order;
    if (activeTickers.has(ticker)) {
      results.skippedOrders.push({ ticker, reason: 'ALREADY_ACTIVE' });
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

    const sMult = isCarnivoreMode(ticker) ? 1.0 : (+(order.sectorMult) || 1.0);

    const newEntryRisk = estimateL1Risk(entryPrice, stopPrice, nav, false, sMult);
    if ((runningRisk + newEntryRisk) / nav > HEAT_CAP_PCT) {
      results.skippedOrders.push({ ticker, reason: `HEAT_CAP_${((runningRisk + newEntryRisk) / nav * 100).toFixed(1)}PCT` });
      continue;
    }

    const l1Cost = estimateL1Cost(entryPrice, stopPrice, nav, false, sMult);
    if (l1Cost > availableBP) {
      results.skippedOrders.push({ ticker, reason: `BUYING_POWER_$${availableBP.toFixed(0)}_NEED_$${l1Cost.toFixed(0)}` });
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
      autoExecuteSource: 'INTRADAY_UPGRADE',
      autoExecuteMode: 'INTRADAY',
      stagedAt: now,
      stagedWeekOf: doc.weekOf,
      weekOf: doc.weekOf,
      killScore: order.killScore || null,
      qualityGrade: 'BEST',
      upgradedFrom: upg.from,
      upgradedAt: now,
      createdAt: now,
      updatedAt: now,
      outcome: { exitPrice: null, profitPct: null, profitDollar: null, holdingDays: null, exitReason: null },
    };

    console.log(`[AI Monitor] ${dryRun ? 'DRY-RUN' : 'STAGED'} ${ticker} ${direction} — upgraded ${upg.from}→BEST (gap=${upg.gapPct}%, slope=${upg.slope}%), L1=${lotShares[0]}sh @${entryPrice}`);

    if (!dryRun) {
      await db.collection(COLL_PORTFOLIO).insertOne(position);
      activeTickers.add(ticker);
    }

    runningRisk += newEntryRisk;
    availableBP -= l1Cost;
    results.staged.push({
      ticker, direction, lot1Shares: lotShares[0], entryPrice, stopPrice,
      strategyMode: position.strategyMode, upgradedFrom: upg.from,
    });
  }

  if (results.staged.length > 0) {
    console.log(`[AI Monitor] Intraday upgrade: ${results.staged.length} staged (${results.staged.map(s => s.ticker).join(', ')})`);
  }
  return results;
}


// ═══════════════════════════════════════════════════════════════════════════════
// PNTHR MCE — Daily: detect MCE signals, stage + immediately execute (AI 300 only)
// Kill switch: IBKR_MCE_AUTO_EXECUTE (default OFF)
// ═══════════════════════════════════════════════════════════════════════════════
function isMceEnabled() {
  return process.env.IBKR_MCE_AUTO_EXECUTE === 'true';
}

export async function executeMceEntries(opts = {}) {
  if (!isMceEnabled()) {
    console.log('[MCE AutoExec] DISABLED — set IBKR_MCE_AUTO_EXECUTE=true to enable');
    return { skipped: 'DISABLED', executed: [], outbox: [] };
  }

  const db = await connectToDatabase();
  if (!db) return { skipped: 'NO_DB', executed: [], outbox: [] };

  const ctx = await resolveContext(db, opts);
  if (!ctx) return { skipped: 'NO_CONTEXT', executed: [], outbox: [] };
  const { ownerId, nav } = ctx;

  const dryRun = isDryRun();

  const { getReentrySignals } = await import('./reentrySignalService.js');
  const mceSignals = await getReentrySignals(ownerId, nav);
  if (!mceSignals || mceSignals.length === 0) {
    return { skipped: 'NO_MCE_SIGNALS', executed: [], outbox: [] };
  }

  // ── Sector 5D priority sort ───────────────────────────────────────────────
  // Build ticker → sectorId from the AI universe holdings list.
  const tickerToSectorId = {};
  for (const sec of AI_UNIVERSE_SECTORS) {
    for (const h of (sec.holdings || [])) {
      if (h.ticker) tickerToSectorId[h.ticker.toUpperCase()] = sec.id;
    }
  }

  // Load live sector regime (bull/bear) + compute 5D return from same bars source
  // as the AI Sectors page — avoids stale pnthr_ai_sector_rank_daily data.
  const sectorIdTo5d = {};
  const sectorIdToRegime = {};
  try {
    const sectorsData = await getPnthrAiSectorsLatest();
    if (sectorsData?.sectors) {
      for (const s of sectorsData.sectors) sectorIdToRegime[s.id] = s.regime;
    }
  } catch (e) {
    console.warn('[MCE AutoExec] Could not load sector regimes:', e.message);
  }
  const neededSectorIds = [...new Set(mceSignals.map(s => tickerToSectorId[s.ticker?.toUpperCase()]).filter(Boolean))];
  await Promise.all(neededSectorIds.map(async (sid) => {
    try {
      const liveSec = sectorsData?.sectors?.find(s => s.id === sid);
      if (!liveSec?.value) return;
      const d = await getPnthrAiSectorBars({ sectorId: sid, timeframe: 'daily', limit: 5 });
      if (d?.ok && d.bars?.length >= 2) {
        const anchorClose = d.bars[0].close;
        if (anchorClose > 0) sectorIdTo5d[sid] = (liveSec.value - anchorClose) / anchorClose;
      }
    } catch {}
  }));

  const bearFiltered = mceSignals.filter(s => {
    const sid = tickerToSectorId[s.ticker?.toUpperCase()];
    const regime = sectorIdToRegime[sid];
    if (regime === 'bear') {
      console.log(`[MCE AutoExec] SKIP ${s.ticker} — sector ${sid} is BEAR regime`);
      return false;
    }
    return true;
  });
  console.log(`[MCE AutoExec] ${mceSignals.length} candidates → ${bearFiltered.length} after bear-sector filter (${mceSignals.length - bearFiltered.length} excluded)`);

  // Sort strongest sector first. Tickers not in the AI universe map default to 0.
  const sortedSignals = [...bearFiltered].sort((a, b) => {
    const aRet = sectorIdTo5d[tickerToSectorId[a.ticker?.toUpperCase()]] ?? 0;
    const bRet = sectorIdTo5d[tickerToSectorId[b.ticker?.toUpperCase()]] ?? 0;
    return bRet - aRet;
  });

  console.log(`[MCE AutoExec] Sector-sorted order: ${sortedSignals.map(s => {
    const sid = tickerToSectorId[s.ticker?.toUpperCase()];
    const ret = sectorIdTo5d[sid] != null ? (sectorIdTo5d[sid] * 100).toFixed(2) + '%' : 'n/a';
    return `${s.ticker}(${ret})`;
  }).join(', ')}`);

  const existingPositions = await db.collection(COLL_PORTFOLIO)
    .find({ ownerId, status: { $in: ['ACTIVE', 'PARTIAL', 'STAGED'] } }).toArray();
  const activeTickers = new Set(existingPositions.map(p => p.ticker));

  const currentHeat = computePortfolioHeat(existingPositions, nav);
  let runningRisk = currentHeat.totalRisk;
  const deployedCapital = computeDeployedCapital(existingPositions);
  let availableBP = computeAvailableBuyingPower(nav, deployedCapital);

  console.log(`[MCE AutoExec] ${sortedSignals.length} MCE signals, heat=${currentHeat.totalRiskPct}%, BP=$${availableBP.toLocaleString()}, dryRun=${dryRun}`);

  const results = { executed: [], outbox: [], skippedOrders: [], dryRun };

  for (const sig of sortedSignals) {
    const { ticker, entryTrigger: entryPrice, weeklyStop: stopPrice, lotShares: mceShares } = sig;

    if (activeTickers.has(ticker)) {
      results.skippedOrders.push({ ticker, reason: 'ALREADY_ACTIVE' });
      continue;
    }
    if (!entryPrice || !stopPrice || !mceShares) {
      results.skippedOrders.push({ ticker, reason: 'NO_PRICE_OR_STOP' });
      continue;
    }

    const rps = entryPrice - stopPrice;
    if (rps <= 0) {
      results.skippedOrders.push({ ticker, reason: 'BAD_RISK' });
      continue;
    }

    // Compute the maximum L1 shares allowed by heat budget and buying power.
    // Instead of hard-skipping, reduce shares to fit — minimum 1 share.
    // Strongest-sector stocks (sorted first) always get full allocation;
    // reductions fall on weaker-sector stocks later in the list.
    const maxSharesFromHeat = Math.floor((HEAT_CAP_PCT * nav - runningRisk) / rps);
    const maxSharesFromBP   = Math.floor(availableBP / entryPrice);
    const l1Shares = Math.min(mceShares[0], maxSharesFromHeat, maxSharesFromBP);

    if (l1Shares < 1) {
      results.skippedOrders.push({ ticker, reason: `NO_ROOM_heat=${((runningRisk / nav) * 100).toFixed(1)}%_BP=$${availableBP.toFixed(0)}` });
      continue;
    }

    // If L1 was reduced, scale the full lot plan proportionally from the new total.
    let actualShares = mceShares;
    if (l1Shares < mceShares[0]) {
      const scaledTotal = Math.round(l1Shares / STRIKE_PCT[0]);
      actualShares = STRIKE_PCT.map(pct => Math.max(1, Math.round(scaledTotal * pct)));
      actualShares[0] = l1Shares;
      console.log(`[MCE AutoExec] ${ticker} shares reduced ${mceShares[0]}→${l1Shares} (sector 5D rank constraint)`);
    }

    const posId = makePosId();
    const now = new Date();
    const fills = buildFillsSkeleton();
    for (let i = 0; i < 5; i++) fills[i + 1].shares = actualShares[i];

    const totalShares = actualShares.reduce((s, v) => s + v, 0);
    const sectorId    = tickerToSectorId[ticker?.toUpperCase()] ?? null;
    const sector5dRet = sectorId != null ? (sectorIdTo5d[sectorId] ?? null) : null;

    const position = {
      id: posId,
      ticker,
      direction: 'LONG',
      signal: 'BL',
      entryPrice,
      currentPrice: entryPrice,
      stopPrice,
      originalStop: stopPrice,
      sector: null,
      sectorId,
      sectorMult: 1.0,
      isETF: false,
      fills,
      targetShares: totalShares,
      maxGapPct: 0,
      status: 'ACTIVE',
      ownerId,
      fundId: 'ai300',
      strategyMode: 'ai300',
      autoExecuted: true,
      autoExecuteSource: 'MCE_DAILY',
      autoExecuteMode: 'MCE',
      entryContext: 'MCE_SIGNAL',
      mceL1Reduced: l1Shares < mceShares[0],
      mceSector5dReturn: sector5dRet,
      createdAt: now,
      updatedAt: now,
      outcome: { exitPrice: null, profitPct: null, profitDollar: null, holdingDays: null, exitReason: null },
    };

    console.log(`[MCE AutoExec] ${dryRun ? 'DRY-RUN' : 'LIVE'} ${ticker} LONG — L1=${actualShares[0]}sh @MKT, stop=${stopPrice}${l1Shares < mceShares[0] ? ` [REDUCED from ${mceShares[0]}]` : ''}`);

    if (!dryRun) {
      // Insert as STAGED first — only promote to ACTIVE after the buy
      // enqueues successfully. Prevents ghost ACTIVE positions with 0
      // filled shares if the outbox rejects the buy (position cap, heat
      // cap, concentration cap, etc.).
      position.status = 'STAGED';
      await db.collection(COLL_PORTFOLIO).insertOne(position);
      activeTickers.add(ticker);

      const entryCmd = {
        ticker, direction: 'LONG', shares: actualShares[0],
        positionId: posId, lot: 1, source: 'MCE_DAILY', tif: 'DAY', rth: true,
      };
      const r1 = await enqueueOutbox(db, ownerId, 'BUY_MARKET_TO_CATCH_UP', entryCmd);
      results.outbox.push({ ticker, command: 'ENTRY_MARKET', ...r1 });

      if (r1.skipped) {
        // Buy rejected — remove the STAGED position to avoid ghosts.
        await db.collection(COLL_PORTFOLIO).deleteOne({ id: posId, ownerId });
        activeTickers.delete(ticker);
        console.warn(`[MCE AutoExec] ${ticker} buy REJECTED: ${r1.skipped} — STAGED position removed`);
        results.skippedOrders.push({ ticker, reason: `BUY_REJECTED_${r1.skipped}` });
        continue;
      }

      // Buy accepted — promote to ACTIVE and stage protective stop + lot triggers.
      await db.collection(COLL_PORTFOLIO).updateOne(
        { id: posId, ownerId },
        { $set: { status: 'ACTIVE', updatedAt: new Date() } }
      );

      const stopShape = buildStopOrderShape({ stopPrice, direction: 'LONG', stopExtendedHours: false });
      const stopCmd = {
        ticker, direction: 'LONG', shares: actualShares[0], stopPrice,
        positionId: posId, ...stopShape,
      };
      const r2 = await enqueueOutbox(db, ownerId, 'PLACE_STOP', stopCmd);
      results.outbox.push({ ticker, command: 'PLACE_STOP', ...r2 });

      const lotPlan = computeLotPlan(position, nav);
      for (let i = 1; i < lotPlan.length; i++) {
        const plan = lotPlan[i];
        if (plan.targetShares <= 0 || !plan.triggerPrice || plan.triggerPrice <= 0) continue;
        const triggerCmd = {
          ticker, direction: 'LONG', shares: plan.targetShares,
          triggerPrice: plan.triggerPrice, positionId: posId,
          lot: plan.lot, orderType: 'STP', rth: true, tif: 'GTC',
        };
        const r = await enqueueOutbox(db, ownerId, 'PLACE_LOT_TRIGGER', triggerCmd);
        results.outbox.push({ ticker, command: 'PLACE_LOT_TRIGGER', lot: plan.lot, ...r });
      }
    }

    runningRisk += l1Shares * rps;
    availableBP -= l1Shares * entryPrice;
    results.executed.push({ ticker, direction: 'LONG', lot1Shares: actualShares[0], lot1Requested: mceShares[0], entryPrice, stopPrice, sector5dReturn: sector5dRet });
  }

  console.log(`[MCE AutoExec] Complete: ${results.executed.length} executed, ${results.skippedOrders.length} skipped`);
  return results;
}
