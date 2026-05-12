// server/aiAutoExecute.js
// ── PNTHR AI 300 — APEX v6 Auto-Execution (3-Path) ─────────────────────────
//
// Three entry paths matching the APEX v6 backtest exactly:
//
//   Path 1 — Scout Entry (AI 300 tickers, BL + SS):
//     Daily cascade scout at 50% of Lot 1 → MKT entry + daily ATR stop
//     No pyramid triggers yet — scout must convert first.
//
//   Path 2 — Scout Conversion (AI 300 tickers):
//     Weekly BL/SS confirms a prior scout → topup remaining ~50% of L1
//     Switch stop from daily to weekly → place L2-L5 pyramid triggers.
//
//   Path 3 — Weekly Direct Entry (carnivore tickers + AI 300 without prior scout):
//     Full Lot 1 at 100% → MKT entry + weekly stop + L2-L5 triggers
//     Carnivore tickers always enter this path (no daily scouts for 679 rules).
//     AI 300 tickers enter this path only if no active/converted scout exists.
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
const COLL_SCOUTS    = 'pnthr_ai_scouts';

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
// PATH 1: Scout Entry — 50% of Lot 1, MKT + daily stop, no pyramid
// Called after scanForNewScouts() returns new scout docs.
// ═══════════════════════════════════════════════════════════════════════════════
export async function autoExecuteScoutEntries(newScouts = [], opts = {}) {
  if (!isEnabled()) return { skipped: 'DISABLED', positions: [], outbox: [] };
  if (!newScouts.length) return { skipped: 'NO_SCOUTS', positions: [], outbox: [] };

  const db = await connectToDatabase();
  if (!db) return { skipped: 'NO_DB', positions: [], outbox: [] };

  const ctx = await resolveContext(db, opts);
  if (!ctx) return { skipped: 'NO_CONTEXT', positions: [], outbox: [] };
  const { ownerId, nav } = ctx;

  const dryRun = isDryRun();
  const results = { positions: [], outbox: [], skipped: [], dryRun };

  // Check existing positions to avoid doubling
  const existingPositions = await db.collection(COLL_PORTFOLIO)
    .find({ ownerId, status: { $in: ['ACTIVE', 'PARTIAL'] } }).toArray();
  const activeTickers = new Set(existingPositions.map(p => p.ticker));

  for (const scout of newScouts) {
    const { ticker } = scout;
    if (activeTickers.has(ticker)) {
      results.skipped.push({ ticker, reason: 'ALREADY_ACTIVE' });
      continue;
    }

    const posId = makePosId();
    const now = new Date();
    const isLong = scout.direction === 'LONG';

    const position = {
      id: posId,
      ticker,
      direction: scout.direction,
      signal: scout.signal || (isLong ? 'BL' : 'SS'),
      entryPrice: scout.entryPrice,
      currentPrice: scout.entryPrice,
      stopPrice: scout.stopPrice,
      originalStop: scout.stopPrice,
      sector: scout.sectorName || null,
      sectorId: scout.sectorId || null,
      sectorMult: scout.sectorMult || 1.0,
      isETF: false,
      fills: {},
      targetShares: scout.shares,
      targetAvg: null,
      maxGapPct: 0,
      status: 'ACTIVE',
      ownerId,
      strategyMode: getStrategyMode(ticker),
      autoExecuted: true,
      autoExecuteSource: 'SCOUT_ENTRY',
      autoExecuteMode: 'SCOUT',
      scoutDocTicker: ticker,
      scoutEntryDate: scout.entryDate,
      killScore: null,
      qualityGrade: scout.qualityGrade || null,
      createdAt: now,
      updatedAt: now,
      outcome: { exitPrice: null, profitPct: null, profitDollar: null, holdingDays: null, exitReason: null },
    };

    // Scout only gets L1 filled at 50% — no L2-L5 yet
    const fills = buildFillsSkeleton();
    fills[1].shares = scout.shares;
    position.fills = fills;

    console.log(`[AI AutoExec] ${dryRun ? 'DRY-RUN' : 'LIVE'} SCOUT ${ticker} ${scout.direction} — ${scout.shares}sh @${scout.entryPrice}, stop=${scout.stopPrice}`);

    if (!dryRun) {
      await db.collection(COLL_PORTFOLIO).insertOne(position);
      activeTickers.add(ticker);
    }
    results.positions.push({ ticker, direction: scout.direction, shares: scout.shares, entryPrice: scout.entryPrice, stopPrice: scout.stopPrice, path: 'SCOUT_ENTRY' });

    // Enqueue MKT entry
    const entryCmd = {
      ticker, direction: scout.direction, shares: scout.shares,
      positionId: posId, lot: 1, source: 'SCOUT_ENTRY', tif: 'DAY', rth: true,
    };
    if (!dryRun) {
      const r = await enqueueOutbox(db, ownerId, 'BUY_MARKET_TO_CATCH_UP', entryCmd);
      results.outbox.push({ ticker, command: 'SCOUT_ENTRY_MARKET', ...r });
    }

    // Enqueue daily ATR stop (STP MKT for RTH)
    const stopShape = buildStopOrderShape({ stopPrice: scout.stopPrice, direction: scout.direction, stopExtendedHours: false });
    const stopCmd = {
      ticker, direction: scout.direction, shares: scout.shares,
      stopPrice: scout.stopPrice, positionId: posId, ...stopShape,
    };
    if (!dryRun) {
      const r = await enqueueOutbox(db, ownerId, 'PLACE_STOP', stopCmd);
      results.outbox.push({ ticker, command: 'PLACE_STOP', ...r });
    }
  }

  console.log(`[AI AutoExec] Scout entries: ${results.positions.length} positions, ${results.outbox.length} outbox`);
  return results;
}


// ═══════════════════════════════════════════════════════════════════════════════
// PATH 2: Scout Conversion — topup to full L1 + weekly stop + L2-L5 triggers
// Called after checkConversions() returns converted scout docs.
// ═══════════════════════════════════════════════════════════════════════════════
export async function autoExecuteScoutConversions(converted = [], opts = {}) {
  if (!isEnabled()) return { skipped: 'DISABLED', conversions: [], outbox: [] };
  if (!converted.length) return { skipped: 'NO_CONVERSIONS', conversions: [], outbox: [] };

  const db = await connectToDatabase();
  if (!db) return { skipped: 'NO_DB', conversions: [], outbox: [] };

  const ctx = await resolveContext(db, opts);
  if (!ctx) return { skipped: 'NO_CONTEXT', conversions: [], outbox: [] };
  const { ownerId, nav } = ctx;

  const dryRun = isDryRun();
  const results = { conversions: [], outbox: [], skipped: [], dryRun };

  for (const conv of converted) {
    const { ticker } = conv;
    const isLong = conv.direction === 'LONG';

    // Find the existing SCOUT portfolio position
    const existingPos = await db.collection(COLL_PORTFOLIO).findOne({
      ownerId, ticker, status: { $in: ['ACTIVE', 'PARTIAL'] },
      autoExecuteMode: 'SCOUT',
    });

    if (!existingPos) {
      results.skipped.push({ ticker, reason: 'NO_SCOUT_POSITION' });
      continue;
    }

    // Compute full position sizing using the weekly stop
    // Load weekly candles to compute weekly stop
    const weeklyDoc = await db.collection('pnthr_ai_bt_candles_weekly')
      .findOne({ ticker }, { projection: { weekly: 1 } });
    const weeklyRaw = weeklyDoc?.weekly || [];
    if (weeklyRaw.length < 10) {
      results.skipped.push({ ticker, reason: 'NO_WEEKLY_DATA' });
      continue;
    }

    const weeklyAsc = [...weeklyRaw].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
    const wBars = weeklyAsc.map(b => ({ high: b.high, low: b.low, close: b.close }));
    const wAtr = computeWilderATR(wBars);
    const wi = weeklyAsc.length - 1;
    if (wi < 3 || !wAtr[wi - 1]) {
      results.skipped.push({ ticker, reason: 'INSUFFICIENT_WEEKLY_ATR' });
      continue;
    }

    const prev1 = weeklyAsc[wi - 1], prev2 = weeklyAsc[wi - 2];
    let weeklyStop;
    if (isLong) {
      const twoWeekLow = Math.min(prev1.low, prev2.low);
      weeklyStop = blInitStop(twoWeekLow, weeklyAsc[wi].close, wAtr[wi - 1]);
    } else {
      const twoWeekHigh = Math.max(prev1.high, prev2.high);
      weeklyStop = ssInitStop(twoWeekHigh, weeklyAsc[wi].close, wAtr[wi - 1]);
    }

    // Use the tighter stop between daily (existing) and weekly
    const currentStop = existingPos.stopPrice;
    const finalStop = isLong
      ? Math.max(currentStop, weeklyStop)
      : Math.min(currentStop, weeklyStop);

    // Build full position for canonical sizing
    const sMult = conv.sectorMult || existingPos.sectorMult || 1.0;
    const fills = buildFillsSkeleton();
    const partialPos = {
      entryPrice: existingPos.entryPrice,
      stopPrice: finalStop,
      originalStop: existingPos.originalStop,
      direction: conv.direction,
      isETF: false,
      fills,
      maxGapPct: 0,
      sectorMult: sMult,
    };

    const lotShares = computeLotTargetShares(partialPos, nav);
    const totalShares = lotShares.reduce((s, v) => s + v, 0);
    for (let i = 0; i < 5; i++) fills[i + 1].shares = lotShares[i];
    partialPos.fills = fills;

    const fullLot1 = lotShares[0];
    const scoutShares = existingPos.fills?.[1]?.shares || conv.scoutShares;
    const topupShares = Math.max(0, fullLot1 - scoutShares);

    // Build lot plan for trigger prices
    const lotPlan = computeLotPlan(partialPos, nav);

    // Update the existing position to full L1 mode
    const updateFields = {
      autoExecuteMode: 'CONVERTED',
      autoExecuteSource: 'SCOUT_CONVERSION',
      stopPrice: finalStop,
      targetShares: totalShares,
      fills,
      updatedAt: new Date(),
    };

    // Compute targetAvg with full fills
    const fullPos = { ...existingPos, ...updateFields, fills };
    const targetAvg = computeTargetAvg(fullPos, nav);
    updateFields.targetAvg = targetAvg;

    console.log(`[AI AutoExec] ${dryRun ? 'DRY-RUN' : 'LIVE'} CONVERT ${ticker} ${conv.direction} — topup ${topupShares}sh (scout=${scoutShares}, full L1=${fullLot1}), weeklyStop=${finalStop.toFixed(2)}`);

    if (!dryRun) {
      await db.collection(COLL_PORTFOLIO).updateOne(
        { _id: existingPos._id },
        { $set: updateFields },
      );
    }

    results.conversions.push({
      ticker, direction: conv.direction, scoutShares, topupShares, fullLot1,
      weeklyStop: +finalStop.toFixed(2), path: 'SCOUT_CONVERSION',
    });

    // Enqueue topup MKT (if any shares to add)
    if (topupShares > 0) {
      const topupCmd = {
        ticker, direction: conv.direction, shares: topupShares,
        positionId: existingPos.id, lot: 1, source: 'SCOUT_CONVERSION_TOPUP', tif: 'DAY', rth: true,
      };
      if (!dryRun) {
        const r = await enqueueOutbox(db, ownerId, 'BUY_MARKET_TO_CATCH_UP', topupCmd);
        results.outbox.push({ ticker, command: 'CONVERSION_TOPUP_MARKET', ...r });
      }
    }

    // Enqueue updated stop at weekly level (replaces daily scout stop)
    const stopShape = buildStopOrderShape({ stopPrice: finalStop, direction: conv.direction, stopExtendedHours: false });
    const stopCmd = {
      ticker, direction: conv.direction, shares: fullLot1,
      stopPrice: finalStop, positionId: existingPos.id, ...stopShape,
    };
    if (!dryRun) {
      const r = await enqueueOutbox(db, ownerId, 'PLACE_STOP', stopCmd);
      results.outbox.push({ ticker, command: 'CONVERSION_STOP', ...r });
    }

    // Enqueue L2-L5 pyramid triggers
    for (let i = 1; i < lotPlan.length; i++) {
      const plan = lotPlan[i];
      if (plan.targetShares <= 0 || !plan.triggerPrice || plan.triggerPrice <= 0) continue;

      const triggerCmd = {
        ticker, direction: conv.direction, shares: plan.targetShares,
        triggerPrice: plan.triggerPrice, positionId: existingPos.id,
        lot: plan.lot, orderType: 'STP', rth: true, tif: 'GTC',
      };
      if (!dryRun) {
        const r = await enqueueOutbox(db, ownerId, 'PLACE_LOT_TRIGGER', triggerCmd);
        results.outbox.push({ ticker, command: 'PLACE_LOT_TRIGGER', lot: plan.lot, ...r });
      }
    }
  }

  console.log(`[AI AutoExec] Conversions: ${results.conversions.length} converted, ${results.outbox.length} outbox`);
  return results;
}


// ═══════════════════════════════════════════════════════════════════════════════
// PATH 3: Weekly Direct Entry — full L1 + stop + L2-L5 triggers
// For carnivore tickers (always) and AI 300 tickers without prior scout.
// Called after runAiOrdersPipeline() completes.
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

  // Check existing positions + active/converted scouts to avoid doubling
  const existingPositions = await db.collection(COLL_PORTFOLIO)
    .find({ ownerId, status: { $in: ['ACTIVE', 'PARTIAL'] } }).toArray();
  const activeTickers = new Set(existingPositions.map(p => p.ticker));

  const activeScoutDocs = await db.collection(COLL_SCOUTS)
    .find({ status: { $in: ['ACTIVE', 'CONVERTED'] } }).toArray();
  const scoutTickers = new Set(activeScoutDocs.map(s => s.ticker));

  const dryRun = isDryRun();
  const results = { positions: [], outbox: [], skipped: [], dryRun };

  const qualifiedOrders = (orderDoc.orders || []).filter(o => {
    if (!o.isNewSignal) return false;
    if (o.signal !== 'BL' && o.signal !== 'SS') return false;
    // Quality gate: BL needs BEST or GOOD; SS enters regardless (regime-gated upstream)
    if (o.signal === 'BL') {
      const label = o.qualityGrade;
      if (label !== 'BEST' && label !== 'GOOD') return false;
    }
    return true;
  });

  console.log(`[AI AutoExec] ${qualifiedOrders.length} qualified weekly orders from ${orderDoc.weekOf} (dryRun=${dryRun})`);

  for (const order of qualifiedOrders) {
    const { ticker } = order;

    if (activeTickers.has(ticker)) {
      results.skipped.push({ ticker, reason: 'ALREADY_ACTIVE' });
      continue;
    }

    // AI 300 tickers with an active/converted scout skip weekly direct entry —
    // they enter through Path 1 (scout) → Path 2 (conversion) instead
    if (!isCarnivoreMode(ticker) && scoutTickers.has(ticker)) {
      results.skipped.push({ ticker, reason: 'HAS_SCOUT' });
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


// ═══════════════════════════════════════════════════════════════════════════════
// Legacy wrapper — keeps existing API endpoints working.
// Calls Path 3 (weekly direct) only. Paths 1 + 2 are wired into the cron.
// ═══════════════════════════════════════════════════════════════════════════════
export async function autoExecuteAiOrders(opts = {}) {
  return autoExecuteWeeklyOrders(opts);
}
