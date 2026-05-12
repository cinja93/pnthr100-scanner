// server/aiScoutService.js
// ── PNTHR AI Elite Fund — Daily Cascade Scout Pipeline ──────────────────────
//
// Replicates the backtest's Daily Cascade exactly:
//   1. Daily BL signals passing combo [6] filter → enter as SCOUT (50% of Lot 1)
//   2. Daily ATR-based stop (fixed at entry, no ratchet for scouts)
//   3. 28 trading-day conversion window
//   4. Friday check: subsequent-week weekly BL+1 → convert to full Lot 1 + pyramid
//   5. Timeout / stop hit → close scout
//
// Collections:
//   pnthr_ai_scouts — active + recently closed scouts
//
// Called by:
//   - Daily cron (after market close): scanForNewScouts() + manageActiveScouts()
//   - Friday cron (after weekly bars finalize): checkConversions()
//   - AI Orders pipeline: getActiveScouts() for display
// ────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';
import { detectAllSignals, calculateEMA, blInitStop, computeWilderATR } from './signalDetection.js';
import { SECTORS } from './scripts/aiUniverse/aiUniverseData.js';
import { SECTOR_EMA_PERIODS } from './data/pnthrAiSectorsConfig.js';
import { getPai300Regime } from './pai300Regime.js';
import { getLatestAiSectorRanks } from './aiSectorRotationService.js';
import { getAiUniverseSignals } from './aiUniverseSignalsService.js';
import { STRIKE_PCT } from './lotMath.js';
import { isCarnivoreMode } from './data/strategyMode.js';

const COLL_SCOUTS = 'pnthr_ai_scouts';

const AI_GATE_OFFSET   = 0.25;
const SCOUT_SIZE_FRAC  = 0.50;
const CONVERSION_DAYS  = 28;
const NAV_VITALITY_PCT = 0.01;
const TICKER_CAP_PCT   = 0.10;
const SCOUT_GAP_MIN    = 12;   // Gap > 12% above weekly EMA (refined filter)
const SCOUT_SLOPE_MAX  = 20;   // EMA slope < 20% annualized (early trend sweet spot)
const BEST_GAP_MIN     = 15;   // Gap > 15% = ★ BEST grade

const TICKER_META = {};
for (const sec of SECTORS) {
  for (const h of sec.holdings) {
    TICKER_META[h.ticker] = { sectorId: sec.id, sectorName: sec.name };
  }
}

function getMondayOf(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const dow = d.getDay();
  const daysToMon = dow === 0 ? -6 : 1 - dow;
  const m = new Date(d);
  m.setDate(d.getDate() + daysToMon);
  return m.toISOString().split('T')[0];
}

function sizePosition(nav, entryPrice, stopPrice) {
  const tickerCap = nav * TICKER_CAP_PCT;
  const vitality  = nav * NAV_VITALITY_PCT;
  const rps = Math.abs(entryPrice - stopPrice);
  if (rps <= 0 || entryPrice <= 0) return 0;
  return Math.floor(Math.min(vitality / rps, tickerCap / entryPrice));
}

// ── Scan for new scouts ──────────────────────────────────────────────────────
// Runs daily after close. Finds daily BL signals passing combo [6], enters scouts.
export async function scanForNewScouts({ nav = 100000, dryRun = false } = {}) {
  const db = await connectToDatabase();
  if (!db) return { newScouts: [], blocked: {} };

  const pai300Bull = await getPai300Regime();
  if (pai300Bull === false) {
    console.log('[AI Scouts] PAI300 BEAR — no new BL scouts');
    return { newScouts: [], blocked: { regime: 'BEAR' } };
  }

  // Sector gate
  let sectorTierBySid = {};
  try {
    const ranks = await getLatestAiSectorRanks();
    if (ranks?.ranks) {
      for (const r of ranks.ranks) sectorTierBySid[r.sectorId] = r.tier;
    }
  } catch (_) {}

  const tickers = Object.keys(TICKER_META).filter(t => !isCarnivoreMode(t));
  const col = db.collection(COLL_SCOUTS);
  await col.createIndex({ ticker: 1, status: 1 });
  await col.createIndex({ status: 1 });

  // Get already-active scouts + any AI Orders positions to avoid doubling
  const activeScouts = await col.find({ status: 'ACTIVE' }).toArray();
  const activeTickers = new Set(activeScouts.map(s => s.ticker));

  // Skip tickers that already have an active weekly BL — no point scouting what's confirmed
  const weeklyBLTickers = new Set();
  try {
    const { signals } = await getAiUniverseSignals();
    for (const [t, sig] of Object.entries(signals)) {
      if (sig?.signal === 'BL') weeklyBLTickers.add(t);
    }
  } catch (_) {}

  // Load daily + weekly candles
  const [dailyDocs, weeklyDocs] = await Promise.all([
    db.collection('pnthr_ai_bt_candles')
      .find({ ticker: { $in: tickers } }, { projection: { ticker: 1, daily: 1 } }).toArray(),
    db.collection('pnthr_ai_bt_candles_weekly')
      .find({ ticker: { $in: tickers } }, { projection: { ticker: 1, weekly: 1 } }).toArray(),
  ]);
  const dailyByTicker = Object.fromEntries(dailyDocs.map(d => [d.ticker, d.daily || []]));
  const weeklyByTicker = Object.fromEntries(weeklyDocs.map(d => [d.ticker, d.weekly || []]));

  const newScouts = [];
  const skipLog = { noData: 0, noSignal: 0, alreadyActive: 0, weeklyBLExists: 0, sectorBlocked: 0, comboFailed: 0, noSize: 0 };

  for (const ticker of tickers) {
    if (activeTickers.has(ticker)) { skipLog.alreadyActive++; continue; }
    if (weeklyBLTickers.has(ticker)) { skipLog.weeklyBLExists++; continue; }

    const meta = TICKER_META[ticker];
    const sectorId = meta.sectorId;
    const period = SECTOR_EMA_PERIODS[sectorId] || 30;

    // Sector gate — skip BL in NO_GO sectors
    const tier = sectorTierBySid[sectorId];
    if (tier === 'NO_GO') { skipLog.sectorBlocked++; continue; }

    const dailyRaw = dailyByTicker[ticker] || [];
    if (dailyRaw.length < period * 3) { skipLog.noData++; continue; }

    const dailyAsc = [...dailyRaw].sort((a, b) => a.date.localeCompare(b.date));
    const dBars = dailyAsc.map(b => ({
      time: b.date, open: b.open, high: b.high, low: b.low, close: b.close,
    }));

    // Run daily signal detection
    const { events, activeType } = detectAllSignals(dBars, period, false, 0.003, AI_GATE_OFFSET);
    if (activeType !== 'BL') { skipLog.noSignal++; continue; }

    // Find the last BL event
    const lastBL = [...events].reverse().find(e => e.signal === 'BL');
    if (!lastBL) { skipLog.noSignal++; continue; }

    // Refined scout filter: Gap > 12% above weekly EMA + Slope < 20% annualized
    const weeklyRaw = weeklyByTicker[ticker] || [];
    if (weeklyRaw.length < period * 3) { skipLog.comboFailed++; continue; }
    const weeklyAsc = [...weeklyRaw].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
    const wBars = weeklyAsc.map(b => ({
      time: b.weekOf, open: b.open, high: b.high, low: b.low, close: b.close,
    }));
    const wEmaData = calculateEMA(wBars, period);
    if (!wEmaData.length) { skipLog.comboFailed++; continue; }

    const lastBar = dBars[dBars.length - 1];
    const closeD = lastBar.close;
    const entryDate = lastBar.time;

    const monday = getMondayOf(entryDate);
    let wEmaVal = null, wEmaIdx = -1;
    for (let i = wEmaData.length - 1; i >= 0; i--) {
      if (wEmaData[i].time <= monday) { wEmaVal = wEmaData[i].value; wEmaIdx = i; break; }
    }
    if (wEmaVal == null) { skipLog.comboFailed++; continue; }

    if (closeD < wEmaVal) { skipLog.comboFailed++; continue; }

    // Gap > 12% above weekly EMA (refined: backtest proved >12% = best scout trades)
    const gapPct = ((closeD - wEmaVal) / wEmaVal) * 100;
    if (gapPct < SCOUT_GAP_MIN) { skipLog.comboFailed++; continue; }

    // Weekly EMA slope < 20% annualized (early trend = sweet spot, not late-stage)
    if (wEmaIdx < 8) { skipLog.comboFailed++; continue; }
    const ema8ago = wEmaData[wEmaIdx - 8]?.value;
    if (ema8ago == null) { skipLog.comboFailed++; continue; }
    const wEmaSlope = ((wEmaVal - ema8ago) / ema8ago) * (52 / 8) * 100;
    if (wEmaSlope >= SCOUT_SLOPE_MAX) { skipLog.comboFailed++; continue; }

    // Compute daily stop
    const dAtr = computeWilderATR(dBars);
    const barIdx = dBars.length - 1;
    if (barIdx < 3 || !dAtr[barIdx]) { skipLog.noSize++; continue; }
    const prev1 = dBars[barIdx - 1], prev2 = dBars[barIdx - 2];
    const twoBarLow = Math.min(prev1.low, prev2.low);
    const dailyStop = blInitStop(twoBarLow, closeD, dAtr[barIdx]);

    // Size: scout = 50% of Lot 1
    const totalShares = sizePosition(nav, closeD, dailyStop);
    if (totalShares <= 0) { skipLog.noSize++; continue; }
    const fullLot1 = Math.max(1, Math.round(totalShares * STRIKE_PCT[0]));
    const scoutShares = Math.max(1, Math.round(fullLot1 * SCOUT_SIZE_FRAC));

    const qualityGrade = gapPct >= BEST_GAP_MIN && wEmaSlope < SCOUT_SLOPE_MAX ? 'BEST' : 'GOOD';

    const scoutDoc = {
      ticker,
      status: 'ACTIVE',
      mode: 'SCOUT',
      direction: 'LONG',
      entryDate,
      entryPrice: +closeD.toFixed(2),
      shares: scoutShares,
      stopPrice: +dailyStop.toFixed(2),
      fullLot1Shares: fullLot1,
      totalTargetShares: totalShares,
      sectorId: sectorId,
      sectorName: meta.sectorName,
      sectorTier: tier || 'NEUTRAL',
      gapPct: +gapPct.toFixed(2),
      wEmaSlope: +wEmaSlope.toFixed(2),
      qualityGrade,
      conversionDeadlineDays: CONVERSION_DAYS,
      tradingDaysOpen: 0,
      entryMonday: monday,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    newScouts.push(scoutDoc);
  }

  if (!dryRun && newScouts.length > 0) {
    await col.insertMany(newScouts);
  }

  console.log(`[AI Scouts] scan: ${newScouts.length} new scouts, skip: ${JSON.stringify(skipLog)}`);
  return { newScouts, skipLog };
}

// ── Manage active scouts (daily) ─────────────────────────────────────────────
// Checks stop hits and increments trading days. Run after close each day.
export async function manageActiveScouts() {
  const db = await connectToDatabase();
  if (!db) return { stopped: 0, timedOut: 0, active: 0 };

  const col = db.collection(COLL_SCOUTS);
  const activeScouts = await col.find({ status: 'ACTIVE' }).toArray();
  if (activeScouts.length === 0) return { stopped: 0, timedOut: 0, active: 0 };

  const tickers = activeScouts.map(s => s.ticker);
  const dailyDocs = await db.collection('pnthr_ai_bt_candles')
    .find({ ticker: { $in: tickers } }, { projection: { ticker: 1, daily: 1 } }).toArray();
  const dailyByTicker = Object.fromEntries(dailyDocs.map(d => [d.ticker, d.daily || []]));

  let stopped = 0, timedOut = 0;

  for (const scout of activeScouts) {
    const dailyRaw = dailyByTicker[scout.ticker] || [];
    const sorted = [...dailyRaw].sort((a, b) => a.date.localeCompare(b.date));
    const lastBar = sorted[sorted.length - 1];
    if (!lastBar) continue;

    // Count trading days since entry
    const daysAfterEntry = sorted.filter(b => b.date > scout.entryDate).length;

    // Stop hit check
    if (lastBar.low <= scout.stopPrice) {
      await col.updateOne({ _id: scout._id }, { $set: {
        status: 'CLOSED', closeReason: 'SCOUT_STOPPED', closeDate: lastBar.date,
        closePrice: +scout.stopPrice.toFixed(2), tradingDaysOpen: daysAfterEntry, updatedAt: new Date(),
      }});
      stopped++;
      continue;
    }

    // Timeout check
    if (daysAfterEntry >= CONVERSION_DAYS) {
      await col.updateOne({ _id: scout._id }, { $set: {
        status: 'CLOSED', closeReason: 'SCOUT_TIMEOUT', closeDate: lastBar.date,
        closePrice: +lastBar.close.toFixed(2), tradingDaysOpen: daysAfterEntry, updatedAt: new Date(),
      }});
      timedOut++;
      continue;
    }

    // Update trading days
    await col.updateOne({ _id: scout._id }, { $set: {
      tradingDaysOpen: daysAfterEntry, updatedAt: new Date(),
    }});
  }

  const remaining = activeScouts.length - stopped - timedOut;
  console.log(`[AI Scouts] manage: ${stopped} stopped, ${timedOut} timed out, ${remaining} active`);
  return { stopped, timedOut, active: remaining };
}

// ── Check for conversions (runs daily) ───────────────────────────────────────
// Check if any active scout's ticker has a current weekly BL signal that fired
// AFTER the scout was created. If so, the scout is confirmed — flag for conversion.
export async function checkConversions() {
  const db = await connectToDatabase();
  if (!db) return { converted: [], noConversion: 0 };

  const col = db.collection(COLL_SCOUTS);
  const activeScouts = await col.find({ status: 'ACTIVE' }).toArray();
  if (activeScouts.length === 0) return { converted: [], noConversion: 0 };

  // Use live weekly signals — same source as the orders pipeline
  let weeklyBLByTicker = {};
  try {
    const { signals } = await getAiUniverseSignals();
    for (const [t, sig] of Object.entries(signals)) {
      if (sig?.signal === 'BL') weeklyBLByTicker[t] = sig;
    }
  } catch (_) {}

  const converted = [];
  let noConversion = 0;

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  for (const scout of activeScouts) {
    const sig = weeklyBLByTicker[scout.ticker];
    if (!sig) { noConversion++; continue; }

    // Weekly BL must have fired AFTER the scout's entry week
    const scoutEntryMonday = scout.entryMonday || getMondayOf(scout.entryDate);
    const blMonday = sig.signalDate ? getMondayOf(sig.signalDate) : null;

    if (blMonday && blMonday <= scoutEntryMonday) { noConversion++; continue; }

    // Conversion confirmed — weekly BL backs up the daily scout
    await col.updateOne({ _id: scout._id }, { $set: {
      status: 'CONVERTED',
      mode: 'CONVERTED',
      conversionDate: todayStr,
      conversionWeeklyBLDate: blMonday || todayStr,
      updatedAt: new Date(),
    }});

    converted.push({
      ticker: scout.ticker,
      scoutEntryDate: scout.entryDate,
      scoutShares: scout.shares,
      fullLot1Shares: scout.fullLot1Shares,
      totalTargetShares: scout.totalTargetShares,
      entryPrice: scout.entryPrice,
      stopPrice: scout.stopPrice,
      conversionDate: todayStr,
    });
  }

  console.log(`[AI Scouts] conversions: ${converted.length} converted, ${noConversion} no conversion`);
  return { converted, noConversion };
}

// ── Get active + recently converted scouts for Orders display ────────────────
export async function getActiveScouts() {
  const db = await connectToDatabase();
  if (!db) return [];
  const col = db.collection(COLL_SCOUTS);
  return col.find({
    status: { $in: ['ACTIVE', 'CONVERTED'] },
  }).sort({ entryDate: -1 }).toArray();
}

// ── Get scout history (for audit/debug) ──────────────────────────────────────
export async function getScoutHistory({ limit = 50 } = {}) {
  const db = await connectToDatabase();
  if (!db) return [];
  return db.collection(COLL_SCOUTS).find({}).sort({ createdAt: -1 }).limit(limit).toArray();
}
