// server/aiScoutService.js
// ── PNTHR AI Elite Fund — Daily Cascade Scout Pipeline (APEX v6) ────────────
//
// Replicates the APEX v6 backtest's Daily Cascade for BOTH BL and SS:
//   1. Daily BL/SS signals passing combo [6] filter → enter as SCOUT (50% of Lot 1)
//      BL combo [6]: price above weekly EMA, slope 0–50%, gap 5–15%
//      SS combo [6]: price below weekly EMA, slope -50–0%, gap 5–15% below
//   2. Daily ATR-based stop (fixed at entry, no ratchet for scouts)
//   3. 28 trading-day conversion window
//   4. Daily check: subsequent-week weekly BL+1/SS+1 → convert to full Lot 1 + pyramid
//   5. Timeout / stop hit / daily BE/SE → close scout
//
// Collections:
//   pnthr_ai_scouts — active + recently closed scouts
//
// Called by:
//   - Daily cron (after market close): scanForNewScouts() + manageActiveScouts()
//   - Daily cron: checkConversions()
//   - AI Orders pipeline: getActiveScouts() for display
// ────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';
import { detectAllSignals, calculateEMA, blInitStop, ssInitStop, computeWilderATR } from './signalDetection.js';
import { SECTORS } from './scripts/aiUniverse/aiUniverseData.js';
import { SECTOR_EMA_PERIODS } from './data/pnthrAiSectorsConfig.js';
import { getPai300Regime } from './pai300Regime.js';
import { getLatestAiSectorRanks, AI_SECTOR_TIER_MULT } from './aiSectorRotationService.js';
import { getAiUniverseSignals } from './aiUniverseSignalsService.js';
import { STRIKE_PCT } from './lotMath.js';
import { isCarnivoreMode } from './data/strategyMode.js';

const COLL_SCOUTS = 'pnthr_ai_scouts';

const AI_GATE_OFFSET   = 0.25;
const SCOUT_SIZE_FRAC  = 0.50;
const CONVERSION_DAYS  = 28;
const NAV_VITALITY_PCT = 0.01;
const TICKER_CAP_PCT   = 0.10;
const MAX_SCOUTS_PER_DAY = 3;
// Combo [6] filter thresholds (from APEX v6 backtest)
const COMBO6_GAP_MIN   = 5;    // Gap 5–15% from weekly EMA
const COMBO6_GAP_MAX   = 15;
const COMBO6_SLOPE_MAX = 50;   // EMA slope 0–50% annualized (BL) / -50–0% (SS)
// Quality grades for display
const BEST_GAP_MIN     = 12;   // Gap ≥ 12% = ★ BEST grade
const BETTER_GAP_MIN   = 9;    // Gap ≥ 9%  = ✓ BETTER grade

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

function sizePosition(nav, entryPrice, stopPrice, sectorMult = 1.0) {
  const tickerCap = nav * TICKER_CAP_PCT;
  const vitality  = nav * NAV_VITALITY_PCT * (+(sectorMult) || 1.0);
  const rps = Math.abs(entryPrice - stopPrice);
  if (rps <= 0 || entryPrice <= 0) return 0;
  return Math.floor(Math.min(vitality / rps, tickerCap / entryPrice));
}

// APEX v6 sector rotation: BL uses GO=1.25/NEUTRAL=1.0/NO_GO=skip;
// SS mirrors: NO_GO=1.25/NEUTRAL=1.0/GO=skip
function blSectorMult(tier) {
  if (tier === 'GO')      return 1.25;
  if (tier === 'NEUTRAL') return 1.0;
  return 0; // NO_GO → skip BL
}
function ssSectorMult(tier) {
  if (tier === 'NO_GO')   return 1.25;
  if (tier === 'NEUTRAL') return 1.0;
  return 0; // GO → skip SS
}

// ── Scan for new scouts ──────────────────────────────────────────────────────
// Runs daily after close. Finds daily BL+SS signals passing combo [6], enters scouts.
// APEX v6: both directions, sector rotation gates + multipliers, regime gate.
export async function scanForNewScouts({ nav = 100000, dryRun = false } = {}) {
  const db = await connectToDatabase();
  if (!db) return { newScouts: [], blocked: {} };

  const pai300Bull = await getPai300Regime();
  // Regime gate: BL only when PAI300 BULL, SS only when PAI300 BEAR
  const blAllowed = pai300Bull !== false;
  const ssAllowed = pai300Bull === false;
  if (!blAllowed && !ssAllowed) {
    console.log('[AI Scouts] PAI300 regime unknown — allowing BL scouts only');
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

  // Get already-active scouts to avoid doubling
  const activeScouts = await col.find({ status: 'ACTIVE' }).toArray();
  const activeTickers = new Set(activeScouts.map(s => s.ticker));

  // Skip tickers that already have a weekly signal in the same direction — no point scouting
  const weeklySignalTickers = {};
  try {
    const { signals } = await getAiUniverseSignals();
    for (const [t, sig] of Object.entries(signals)) {
      if (sig?.signal === 'BL' || sig?.signal === 'SS') weeklySignalTickers[t] = sig.signal;
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
  const skipLog = { noData: 0, noSignal: 0, alreadyActive: 0, weeklyExists: 0, sectorBlocked: 0, regimeBlocked: 0, comboFailed: 0, noSize: 0 };

  for (const ticker of tickers) {
    if (activeTickers.has(ticker)) { skipLog.alreadyActive++; continue; }

    const meta = TICKER_META[ticker];
    const sectorId = meta.sectorId;
    const period = SECTOR_EMA_PERIODS[sectorId] || 30;

    const dailyRaw = dailyByTicker[ticker] || [];
    if (dailyRaw.length < period * 3) { skipLog.noData++; continue; }

    const dailyAsc = [...dailyRaw].sort((a, b) => a.date.localeCompare(b.date));
    const dBars = dailyAsc.map(b => ({
      time: b.date, open: b.open, high: b.high, low: b.low, close: b.close,
    }));

    // Run daily signal detection
    const { events, activeType } = detectAllSignals(dBars, period, false, 0.003, AI_GATE_OFFSET);
    if (activeType !== 'BL' && activeType !== 'SS') { skipLog.noSignal++; continue; }

    const isLong = activeType === 'BL';
    const direction = isLong ? 'LONG' : 'SHORT';

    // Regime gate: BL when PAI300 bull, SS when PAI300 bear
    if (isLong && !blAllowed) { skipLog.regimeBlocked++; continue; }
    if (!isLong && !ssAllowed) { skipLog.regimeBlocked++; continue; }

    // Skip if weekly signal in same direction already exists
    if (weeklySignalTickers[ticker] === activeType) { skipLog.weeklyExists++; continue; }

    // Sector rotation gate
    const tier = sectorTierBySid[sectorId];
    const sMult = isLong ? blSectorMult(tier) : ssSectorMult(tier);
    if (sMult === 0) { skipLog.sectorBlocked++; continue; }

    // Find the last matching event
    const lastEvent = [...events].reverse().find(e => e.signal === activeType);
    if (!lastEvent) { skipLog.noSignal++; continue; }

    // ── Combo [6] filter (from APEX v6 backtest) ────────────────────────────
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

    // BL: price above EMA; SS: price below EMA
    if (isLong && closeD < wEmaVal) { skipLog.comboFailed++; continue; }
    if (!isLong && closeD > wEmaVal) { skipLog.comboFailed++; continue; }

    // Gap 5–15% from weekly EMA (absolute distance)
    const gapPct = isLong
      ? ((closeD - wEmaVal) / wEmaVal) * 100
      : ((wEmaVal - closeD) / wEmaVal) * 100;
    if (gapPct < COMBO6_GAP_MIN || gapPct > COMBO6_GAP_MAX) { skipLog.comboFailed++; continue; }

    // Weekly EMA slope: 1-week delta annualized (matches APEX v6 backtest)
    if (wEmaIdx < 1) { skipLog.comboFailed++; continue; }
    const emaPrev = wEmaData[wEmaIdx - 1]?.value;
    if (emaPrev == null || emaPrev <= 0) { skipLog.comboFailed++; continue; }
    const wEmaSlope = ((wEmaVal - emaPrev) / emaPrev) * 52 * 100;
    if (isLong  && (wEmaSlope < 0 || wEmaSlope > COMBO6_SLOPE_MAX)) { skipLog.comboFailed++; continue; }
    if (!isLong && (wEmaSlope > 0 || wEmaSlope < -COMBO6_SLOPE_MAX)) { skipLog.comboFailed++; continue; }

    // ── Compute daily stop ──────────────────────────────────────────────────
    const dAtr = computeWilderATR(dBars);
    const barIdx = dBars.length - 1;
    if (barIdx < 3 || !dAtr[barIdx]) { skipLog.noSize++; continue; }
    const prev1 = dBars[barIdx - 1], prev2 = dBars[barIdx - 2];
    let dailyStop;
    if (isLong) {
      const twoBarLow = Math.min(prev1.low, prev2.low);
      dailyStop = blInitStop(twoBarLow, closeD, dAtr[barIdx]);
    } else {
      const twoBarHigh = Math.max(prev1.high, prev2.high);
      dailyStop = ssInitStop(twoBarHigh, closeD, dAtr[barIdx]);
    }

    // ── Size: scout = 50% of Lot 1 ─────────────────────────────────────────
    const totalShares = sizePosition(nav, closeD, dailyStop, sMult);
    if (totalShares <= 0) { skipLog.noSize++; continue; }
    const fullLot1 = Math.max(1, Math.round(totalShares * STRIKE_PCT[0]));
    const scoutShares = Math.max(1, Math.round(fullLot1 * SCOUT_SIZE_FRAC));

    const absGap = Math.abs(gapPct);
    const absSlope = Math.abs(wEmaSlope);
    const qualityGrade = absGap >= BEST_GAP_MIN && absSlope < COMBO6_SLOPE_MAX ? 'BEST'
      : absGap >= BETTER_GAP_MIN && absSlope < COMBO6_SLOPE_MAX ? 'BETTER' : 'GOOD';

    const scoutDoc = {
      ticker,
      status: 'ACTIVE',
      mode: 'SCOUT',
      direction,
      signal: activeType,
      entryDate,
      entryPrice: +closeD.toFixed(2),
      shares: scoutShares,
      stopPrice: +dailyStop.toFixed(2),
      fullLot1Shares: fullLot1,
      totalTargetShares: totalShares,
      sectorId: sectorId,
      sectorName: meta.sectorName,
      sectorTier: tier || 'NEUTRAL',
      sectorMult: sMult,
      gapPct: +gapPct.toFixed(2),
      wEmaSlope: +wEmaSlope.toFixed(2),
      qualityGrade,
      conversionDeadlineDays: CONVERSION_DAYS,
      tradingDaysOpen: 0,
      entryMonday: monday,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    if (newScouts.length >= MAX_SCOUTS_PER_DAY) {
      skipLog.maxPerDay = (skipLog.maxPerDay || 0) + 1;
      continue;
    }
    newScouts.push(scoutDoc);
  }

  if (!dryRun && newScouts.length > 0) {
    await col.insertMany(newScouts);
  }

  const blScouts = newScouts.filter(s => s.signal === 'BL').length;
  const ssScouts = newScouts.filter(s => s.signal === 'SS').length;
  console.log(`[AI Scouts] scan: ${newScouts.length} new scouts (BL=${blScouts} SS=${ssScouts}), skip: ${JSON.stringify(skipLog)}`);
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

  let stopped = 0, timedOut = 0, exited = 0;

  for (const scout of activeScouts) {
    const dailyRaw = dailyByTicker[scout.ticker] || [];
    const sorted = [...dailyRaw].sort((a, b) => a.date.localeCompare(b.date));
    const lastBar = sorted[sorted.length - 1];
    if (!lastBar) continue;

    // Count trading days since entry
    const daysAfterEntry = sorted.filter(b => b.date > scout.entryDate).length;

    // Stop hit check (direction-aware)
    const stopHit = scout.direction === 'SHORT'
      ? lastBar.high >= scout.stopPrice
      : lastBar.low <= scout.stopPrice;
    if (stopHit) {
      await col.updateOne({ _id: scout._id }, { $set: {
        status: 'CLOSED', closeReason: 'SCOUT_STOPPED', closeDate: lastBar.date,
        closePrice: +scout.stopPrice.toFixed(2), tradingDaysOpen: daysAfterEntry, updatedAt: new Date(),
      }});
      stopped++;
      continue;
    }

    // Daily BE/SE exit check (matches APEX v6 backtest)
    const meta = TICKER_META[scout.ticker];
    if (meta) {
      const period = SECTOR_EMA_PERIODS[meta.sectorId] || 30;
      if (sorted.length >= period * 2) {
        const dBars = sorted.map(b => ({ time: b.date, open: b.open, high: b.high, low: b.low, close: b.close }));
        const { activeType } = detectAllSignals(dBars, period, false, 0.003, AI_GATE_OFFSET);
        const exitSignal = scout.direction === 'LONG' ? 'BE' : 'SE';
        if (activeType === exitSignal || activeType === (scout.direction === 'LONG' ? 'SE' : 'BE')) {
          await col.updateOne({ _id: scout._id }, { $set: {
            status: 'CLOSED', closeReason: scout.direction === 'LONG' ? 'DAILY_BE' : 'DAILY_SE',
            closeDate: lastBar.date, closePrice: +lastBar.close.toFixed(2),
            tradingDaysOpen: daysAfterEntry, updatedAt: new Date(),
          }});
          exited++;
          continue;
        }
      }
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

  const remaining = activeScouts.length - stopped - timedOut - exited;
  console.log(`[AI Scouts] manage: ${stopped} stopped, ${exited} exited (BE/SE), ${timedOut} timed out, ${remaining} active`);
  return { stopped, exited, timedOut, active: remaining };
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

  // Use live weekly signals — BL confirms BL scouts, SS confirms SS scouts
  let weeklySignalByTicker = {};
  try {
    const { signals } = await getAiUniverseSignals();
    for (const [t, sig] of Object.entries(signals)) {
      if (sig?.signal === 'BL' || sig?.signal === 'SS') weeklySignalByTicker[t] = sig;
    }
  } catch (_) {}

  const converted = [];
  let noConversion = 0;

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  for (const scout of activeScouts) {
    const sig = weeklySignalByTicker[scout.ticker];
    if (!sig) { noConversion++; continue; }

    // Signal must match scout direction: BL scout needs weekly BL, SS scout needs weekly SS
    const expectedSignal = scout.direction === 'SHORT' ? 'SS' : 'BL';
    if (sig.signal !== expectedSignal) { noConversion++; continue; }

    // Weekly signal must have fired AFTER the scout's entry date (same week OK)
    if (sig.signalDate && sig.signalDate <= scout.entryDate) { noConversion++; continue; }

    // Conversion confirmed — weekly signal backs up the daily scout
    await col.updateOne({ _id: scout._id }, { $set: {
      status: 'CONVERTED',
      mode: 'CONVERTED',
      conversionDate: todayStr,
      conversionWeeklySignalDate: sig.signalDate || todayStr,
      updatedAt: new Date(),
    }});

    converted.push({
      ticker: scout.ticker,
      direction: scout.direction,
      signal: scout.signal || expectedSignal,
      scoutEntryDate: scout.entryDate,
      scoutShares: scout.shares,
      fullLot1Shares: scout.fullLot1Shares,
      totalTargetShares: scout.totalTargetShares,
      entryPrice: scout.entryPrice,
      stopPrice: scout.stopPrice,
      sectorId: scout.sectorId,
      sectorName: scout.sectorName,
      sectorTier: scout.sectorTier,
      sectorMult: scout.sectorMult,
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
