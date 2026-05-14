// server/aiOrdersPipeline.js
// ── PNTHR AI 300 — Weekly Orders Pipeline (Multi-Strategy) ─────────────────
//
// Each run produces a single doc in pnthr_ai_orders keyed by weekOf, holding
// all qualifying BL/SS orders ready for Monday-open execution.
//
// Two strategy pipelines merge into one order sheet:
//
//   AI 300 tickers (~272): scored by AI signals + AI sector rotation gate
//     BL: sectorTier ∈ {GO, NEUTRAL}  (size mult: GO 1.25 / NEUTRAL 1.0)
//     SS: sectorTier ∈ {NO_GO, NEUTRAL} (size mult: NO_GO 1.25 / NEUTRAL 1.0)
//     Regime: PAI300 (not SPY/QQQ)
//
//   Carnivore tickers (26): scored by 679 Kill with native 679 rules
//     Pull from 679 Kill if tier ∈ {ALPHA, STRIKING, HUNTING}
//     Pre-qualified — no AI regime gate, no sector rotation re-check
//     Tagged with strategyMode='679', killTier679, killScore679
//
// Source of truth: AI signals from getAiUniverseSignals(), 679 Kill from
// triggerApexWarmup() + getCachedApexResults().
// ────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';
import { getAiUniverseSignals } from './aiUniverseSignalsService.js';
import { getLatestAiSectorRanks } from './aiSectorRotationService.js';
import { SECTORS } from './scripts/aiUniverse/aiUniverseData.js';
import { SECTOR_EMA_PERIODS } from './data/pnthrAiSectorsConfig.js';
import { calculateEMA } from './signalDetection.js';
import { fetchAiQuotesBatch } from './aiIntradayOverlay.js';
import { getPai300Regime } from './pai300Regime.js';
import { isCarnivoreMode, getCarnivoreEmaPeriod, CARNIVORE_MODE_TICKERS } from './data/strategyMode.js';
import { fetchIndexData, triggerApexWarmup, getCachedApexResults } from './apexService.js';

const COLL_AI_ORDERS = 'pnthr_ai_orders';

// Vitality: 1% NAV per trade (× sector multiplier)
const NAV_VITALITY_PCT  = 0.01;
const TICKER_CAP_PCT    = 0.10;
const ASSUMED_NAV       = 100_000; // reference NAV; frontend scales to user's actual NAV

// Build ticker → metadata once
const TICKER_META = {};
for (const sec of SECTORS) {
  for (const h of sec.holdings) {
    TICKER_META[h.ticker] = {
      sectorId: sec.id,
      sectorName: sec.name,
      companyName: h.name,
    };
  }
}

function getLastFriday(refDate = new Date()) {
  const d = new Date(refDate);
  const day = d.getUTCDay();
  // Monday=1, Tuesday=2, ..., Friday=5, Saturday=6, Sunday=0
  const diff = day >= 5 ? day - 5 : day + 2; // walk back to most recent Friday
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

// SS mirror: in our universe shorts work best in NO_GO sectors
function ssMult(tier) {
  if (tier === 'NO_GO')   return 1.25;
  if (tier === 'NEUTRAL') return 1.0;
  return 0; // GO sector → skip SS
}
function blMult(tier) {
  if (tier === 'GO')      return 1.25;
  if (tier === 'NEUTRAL') return 1.0;
  return 0; // NO_GO → skip BL
}

function tierRankForSort(tier) {
  // GO entries first (1.25 mult), then NEUTRAL (1.0), then NO_GO (skipped anyway)
  if (tier === 'GO') return 0;
  if (tier === 'NEUTRAL') return 1;
  return 2;
}

/**
 * Run the AI Orders pipeline. Idempotent — upserts a single doc keyed by weekOf.
 * @param {object} [opts]
 * @param {string} [opts.type='DAILY']  'DAILY' | 'WEEKLY' (informational tag)
 * @returns {Promise<object>} the persisted order document
 */
export async function runAiOrdersPipeline(opts = {}) {
  const type   = opts.type || 'DAILY';
  const weekOf = getLastFriday();

  const db = await connectToDatabase();
  if (!db) throw new Error('No DB connection');

  console.log(`[AI Orders] starting pipeline (type=${type}, weekOf=${weekOf})…`);

  // 0. Regime gate — PAI300 for AI 300-mode tickers only.
  //    Carnivore tickers are pre-screened by the 679 Kill (Alpha/Striking/Hunting)
  //    and enter AI 300 Orders pre-qualified — no second gate.
  const pai300Bull = await getPai300Regime();
  console.log(`[AI Orders] PAI300 regime: ${pai300Bull === true ? 'BULL (BL allowed)' : pai300Bull === false ? 'BEAR (BL blocked)' : 'UNKNOWN (BL allowed)'}`);

  // 0b. Pull 679 Kill results for carnivore tickers.
  //     These 26 tickers are scored by the 679 Kill engine with native 679 rules
  //     (GICS OpEMA, SPY+QQQ regime, no sector rotation). If they earned
  //     Alpha / Striking / Hunting tier, they enter AI 300 Orders pre-qualified.
  const QUALIFYING_679_TIERS = new Set(['ALPHA PNTHR KILL', 'STRIKING', 'HUNTING']);
  let carnivoreOrders = [];
  try {
    await triggerApexWarmup(); // ensure 679 Kill cache is warm
    const apexResults = getCachedApexResults();
    if (apexResults?.stocks) {
      const qualified = apexResults.stocks.filter(s =>
        CARNIVORE_MODE_TICKERS.has(s.ticker) &&
        QUALIFYING_679_TIERS.has(s.tier) &&
        (s.signal === 'BL' || s.signal === 'SS') &&
        !s.overextended
      );
      console.log(`[AI Orders] 679 Kill carnivore: ${qualified.length} qualified out of ${CARNIVORE_MODE_TICKERS.size} (tiers: ${qualified.map(s => `${s.ticker}=${s.tier}`).join(', ') || 'none'})`);
      carnivoreOrders = qualified; // will be converted to order format below
    } else {
      console.warn('[AI Orders] 679 Kill cache empty — carnivore tickers skipped this run');
    }
  } catch (err) {
    console.warn('[AI Orders] 679 Kill warmup failed — carnivore tickers skipped:', err.message);
  }

  // 1. Pull live signals (force refresh so sector tiers reflect today's rank)
  const { signals } = await getAiUniverseSignals({ refresh: true });
  const allTickers = Object.keys(signals);
  console.log(`[AI Orders] received ${allTickers.length} weekly signals`);

  // 2. Pull live quotes once for entry-price reference + day-change context
  let quoteMap = {};
  try {
    quoteMap = await fetchAiQuotesBatch(allTickers);
  } catch (err) {
    console.warn('[AI Orders] live quote batch failed; entryPrice may be stale:', err.message);
  }

  // 3. Pull the sector rank doc so we can attach sector context to the order sheet
  const sectorRanks = await getLatestAiSectorRanks();

  // 3b. Load weekly candles for gap% + EMA slope computation (quality grades)
  const allUniverseTickers = Object.keys(TICKER_META);
  const weeklyDocs = await db.collection('pnthr_ai_bt_candles_weekly')
    .find({ ticker: { $in: allUniverseTickers } }, { projection: { ticker: 1, weekly: 1 } }).toArray();
  const weeklyByTicker = Object.fromEntries(weeklyDocs.map(d => [d.ticker, d.weekly || []]));

  function computeGapAndSlope(ticker, livePrice) {
    const meta = TICKER_META[ticker];
    if (!meta) return null;
    const period = getCarnivoreEmaPeriod(ticker) || SECTOR_EMA_PERIODS[meta.sectorId] || 30;
    const wRaw = weeklyByTicker[ticker] || [];
    if (wRaw.length < period * 3) return null;
    const wAsc = [...wRaw].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
    const wBars = wAsc.map(b => ({ time: b.weekOf, open: b.open, high: b.high, low: b.low, close: b.close }));
    const wEmaData = calculateEMA(wBars, period);
    if (!wEmaData.length) return null;
    const lastEma = wEmaData[wEmaData.length - 1];
    if (!lastEma?.value) return null;
    const gapPct = ((livePrice - lastEma.value) / lastEma.value) * 100;
    const idx = wEmaData.length - 1;
    let slope = null;
    if (idx >= 1) {
      const emaPrev = wEmaData[idx - 1]?.value;
      if (emaPrev && emaPrev > 0) slope = ((lastEma.value - emaPrev) / emaPrev) * 52 * 100;
    }
    return { gapPct: +gapPct.toFixed(2), wEmaSlope: slope != null ? +slope.toFixed(2) : null };
  }

  // 4. Build candidate orders
  let orders = [];
  const skipLog = { blNoGo: 0, ssGo: 0, notEntry: 0, noStop: 0, noPrice: 0, blRegimeBlocked: 0 };

  for (const ticker of allTickers) {
    // Carnivore tickers are handled by the 679 Kill pull above — skip here
    if (isCarnivoreMode(ticker)) continue;

    const sig = signals[ticker];
    if (!sig) continue;

    // Only entry signals (BL or SS) — BE/SE are exits, no order to place
    if (sig.signal !== 'BL' && sig.signal !== 'SS') { skipLog.notEntry++; continue; }

    const tier = sig.sectorTier;
    const isLong = sig.signal === 'BL';

    // Regime hard gate: AI 300 tickers use PAI300
    const regimeBull = pai300Bull !== false;
    if (isLong && !regimeBull) { skipLog.blRegimeBlocked++; continue; }
    if (!isLong && regimeBull) { skipLog.ssRegimeBlocked = (skipLog.ssRegimeBlocked || 0) + 1; continue; }

    const mult = isLong ? blMult(tier) : ssMult(tier);

    if (mult === 0) {
      if (isLong) skipLog.blNoGo++; else skipLog.ssGo++;
      continue;
    }

    const meta = TICKER_META[ticker] || {};
    const quote = quoteMap[ticker] || null;
    const livePrice = (quote && typeof quote.price === 'number') ? quote.price : null;

    if (livePrice == null) { skipLog.noPrice++; continue; }
    const stopPrice = sig.stopPrice;
    if (stopPrice == null) {
      // Active BL/SS without a recorded stop is rare; skip rather than guess
      skipLog.noStop++; continue;
    }

    const riskPerShare = isLong ? (livePrice - stopPrice) : (stopPrice - livePrice);
    if (!(riskPerShare > 0)) { skipLog.noStop++; continue; }
    const riskPct = (riskPerShare / livePrice) * 100;

    // Vitality dollar (size linearly in NAV; downstream UI scales by user NAV)
    const vitalityDollar = ASSUMED_NAV * NAV_VITALITY_PCT * mult;
    const tickerCapDollar = ASSUMED_NAV * TICKER_CAP_PCT;
    const sharesByRisk = Math.floor(vitalityDollar / riskPerShare);
    const sharesByCap  = Math.floor(tickerCapDollar / livePrice);
    const targetShares = Math.max(0, Math.min(sharesByRisk, sharesByCap));

    // 5-lot pyramid sizing (same as Phase 4 / v6)
    const STRIKE_PCT = [0.35, 0.25, 0.20, 0.12, 0.08];
    const lot1Cap    = riskPerShare > 0 ? Math.floor(vitalityDollar / riskPerShare) : targetShares;
    const lot1Shares = Math.min(Math.max(1, Math.round(targetShares * STRIKE_PCT[0])), lot1Cap);
    const lot1Dollar = lot1Shares * livePrice;

    const gs = computeGapAndSlope(ticker, livePrice);
    const gapPct = gs?.gapPct ?? null;
    const wEmaSlope = gs?.wEmaSlope ?? null;
    let qualityGrade = 'GOOD';
    if (gapPct != null && wEmaSlope != null) {
      const absGap = Math.abs(gapPct);
      const absSlope = Math.abs(wEmaSlope);
      if (absGap >= 12 && absSlope < 50) qualityGrade = 'BEST';
      else if (absGap >= 9 && absSlope < 50) qualityGrade = 'BETTER';
    }

    const heatDollar = +(lot1Shares * riskPerShare).toFixed(2);
    const heatPctNav = +((heatDollar / ASSUMED_NAV) * 100).toFixed(3);

    orders.push({
      ticker,
      companyName: meta.companyName || null,
      sectorId: meta.sectorId || null,
      sectorName: meta.sectorName || null,
      signal: sig.signal,
      direction: isLong ? 'LONG' : 'SHORT',
      sectorTier: tier,
      sectorMult: mult,
      currentPrice: livePrice,
      stopPrice: stopPrice,
      riskPerShare: +riskPerShare.toFixed(4),
      riskPct: +riskPct.toFixed(2),
      vitalityDollar: +vitalityDollar.toFixed(2),
      targetShares,
      lot1Shares,
      lot1Dollar: +lot1Dollar.toFixed(2),
      signalDate: sig.signalDate,
      lastBarDate: sig.lastBarDate,
      isNewSignal: !!sig.isNewSignal,
      gapPct,
      wEmaSlope,
      qualityGrade,
      heatDollar,
      heatPctNav,
    });
  }

  // 4b. Convert qualified carnivore tickers from 679 Kill into order format.
  //     These are pre-screened (Alpha/Striking/Hunting in 679 Kill) — no sector
  //     rotation gate, no regime re-check. They enter as-is.
  for (const killStock of carnivoreOrders) {
    const ticker = killStock.ticker;
    const isLong = killStock.signal === 'BL';
    const meta = TICKER_META[ticker] || {};

    // Use live quote for current price (same source as AI orders above)
    const quote = quoteMap[ticker] || null;
    const livePrice = (quote && typeof quote.price === 'number') ? quote.price : killStock.currentPrice;
    if (livePrice == null) continue;

    const stopPrice = killStock.stopPrice ?? killStock.pnthrStop ?? null;
    if (stopPrice == null) continue;

    const riskPerShare = isLong ? (livePrice - stopPrice) : (stopPrice - livePrice);
    if (!(riskPerShare > 0)) continue;
    const riskPct = (riskPerShare / livePrice) * 100;

    // Size using same vitality model as AI orders (1% NAV × 1.0 mult — no sector boost)
    const mult = 1.0;
    const vitalityDollar = ASSUMED_NAV * NAV_VITALITY_PCT * mult;
    const tickerCapDollar = ASSUMED_NAV * TICKER_CAP_PCT;
    const sharesByRisk = Math.floor(vitalityDollar / riskPerShare);
    const sharesByCap  = Math.floor(tickerCapDollar / livePrice);
    const targetShares = Math.max(0, Math.min(sharesByRisk, sharesByCap));

    const STRIKE_PCT = [0.35, 0.25, 0.20, 0.12, 0.08];
    const lot1Cap    = riskPerShare > 0 ? Math.floor(vitalityDollar / riskPerShare) : targetShares;
    const lot1Shares = Math.min(Math.max(1, Math.round(targetShares * STRIKE_PCT[0])), lot1Cap);
    const lot1Dollar = lot1Shares * livePrice;

    const gs = computeGapAndSlope(ticker, livePrice);
    const gapPct = gs?.gapPct ?? null;
    const wEmaSlope = gs?.wEmaSlope ?? null;
    let qualityGrade = 'GOOD';
    if (gapPct != null && wEmaSlope != null) {
      const absGap = Math.abs(gapPct);
      const absSlope = Math.abs(wEmaSlope);
      if (absGap >= 12 && absSlope < 50) qualityGrade = 'BEST';
      else if (absGap >= 9 && absSlope < 50) qualityGrade = 'BETTER';
    }

    const heatDollar = +(lot1Shares * riskPerShare).toFixed(2);
    const heatPctNav = +((heatDollar / ASSUMED_NAV) * 100).toFixed(3);

    orders.push({
      ticker,
      companyName: meta.companyName || killStock.companyName || null,
      sectorId: meta.sectorId || null,
      sectorName: meta.sectorName || killStock.sector || null,
      signal: killStock.signal,
      direction: isLong ? 'LONG' : 'SHORT',
      sectorTier: null,           // carnivore bypasses AI sector rotation
      sectorMult: mult,
      currentPrice: livePrice,
      stopPrice,
      riskPerShare: +riskPerShare.toFixed(4),
      riskPct: +riskPct.toFixed(2),
      vitalityDollar: +vitalityDollar.toFixed(2),
      targetShares,
      lot1Shares,
      lot1Dollar: +lot1Dollar.toFixed(2),
      signalDate: killStock.signalDate,
      lastBarDate: null,
      isNewSignal: !!killStock.isNewSignal,
      gapPct,
      wEmaSlope,
      qualityGrade,
      heatDollar,
      heatPctNav,
      // Tag so downstream (UI, auto-execute) knows the source
      strategyMode: '679',
      killTier679: killStock.tier,
      killScore679: killStock.apexScore,
    });
  }

  // 5. Sort: GO/NO_GO tier first (1.25× mult), then NEUTRAL, then by signal date desc
  orders.sort((a, b) => {
    const t = tierRankForSort(a.sectorTier) - tierRankForSort(b.sectorTier);
    if (t !== 0) return t;
    return (b.signalDate || '').localeCompare(a.signalDate || '');
  });

  // 5b. No weekly cap — APEX v7 backtesting proved capping entries was too
  //     restrictive and reduced returns without improving risk metrics.
  //     All qualifying signals that pass the sector rotation gate enter.
  //     (Previously capped at 10 BL + 5 SS per week in APEX v6.)

  // 6. Aggregate stats for header display
  const blOrders = orders.filter(o => o.signal === 'BL');
  const ssOrders = orders.filter(o => o.signal === 'SS');
  const newOrders = orders.filter(o => o.isNewSignal);
  const stats = {
    universeSize: allTickers.length,
    totalOrders: orders.length,
    blCount: blOrders.length,
    ssCount: ssOrders.length,
    newThisWeek: newOrders.length,
    skippedNoGoBL: skipLog.blNoGo,
    skippedGoSS: skipLog.ssGo,
    skippedNoEntry: skipLog.notEntry,
    skippedNoStop: skipLog.noStop,
    skippedNoPrice: skipLog.noPrice,
    blRegimeBlocked: skipLog.blRegimeBlocked,
    pai300Regime: pai300Bull === true ? 'BULL' : pai300Bull === false ? 'BEAR' : 'UNKNOWN',
    carnivoreQualified: carnivoreOrders.length,
    carnivoreTotal: CARNIVORE_MODE_TICKERS.size,
  };

  // 7. Sector summary (top 6 GO + bottom 4 NO_GO with 5D returns)
  const sectorSummary = {
    asOf: sectorRanks?.date || null,
    lookback: sectorRanks?.lookback || null,
    go: (sectorRanks?.ranks || []).slice(0, 6).map(r => ({
      sectorId: r.sectorId, name: r.name, rank: r.rank, fiveDayReturn: r.fiveDayReturn, tier: r.tier,
    })),
    nogo: (sectorRanks?.ranks || []).slice(-4).map(r => ({
      sectorId: r.sectorId, name: r.name, rank: r.rank, fiveDayReturn: r.fiveDayReturn, tier: r.tier,
    })),
  };

  // 8. Persist
  const doc = {
    weekOf, type, generatedAt: new Date(),
    sectorSummary,
    orders, stats,
    assumedNav: ASSUMED_NAV,
    vitalityPct: NAV_VITALITY_PCT,
    tickerCapPct: TICKER_CAP_PCT,
  };

  const col = db.collection(COLL_AI_ORDERS);
  await col.createIndex({ weekOf: -1, type: 1 });
  await col.replaceOne({ weekOf, type }, doc, { upsert: true });

  console.log(`[AI Orders] ${type} ${weekOf}: ${orders.length} orders (BL=${blOrders.length} SS=${ssOrders.length} new=${newOrders.length}); skipped BL/NO_GO=${skipLog.blNoGo} SS/GO=${skipLog.ssGo}`);
  return doc;
}

export async function getLatestAiOrders(type = null) {
  const db = await connectToDatabase();
  if (!db) return null;
  const filter = type ? { type } : {};
  return db.collection(COLL_AI_ORDERS).find(filter).sort({ weekOf: -1, generatedAt: -1 }).limit(1).next();
}

export async function getAiOrdersHistory({ limit = 20, type = null } = {}) {
  const db = await connectToDatabase();
  if (!db) return [];
  const filter = type ? { type } : {};
  return db.collection(COLL_AI_ORDERS).find(filter).sort({ weekOf: -1, generatedAt: -1 }).limit(limit).toArray();
}
