// server/aiOrdersPipeline.js
// ── PNTHR AI 300 — Weekly Orders Pipeline (APEX v6) ────────────────────────
//
// Each run produces a single doc in pnthr_ai_orders keyed by weekOf, holding
// every BL/SS signal in the AI 300 universe that passes the sector gate, with
// v6-sized lot 1 share counts ready for Monday-open execution.
//
// Sector gate rules (mirroring the v6 backtest):
//   BL: sectorTier ∈ {GO, NEUTRAL}      (skip NO_GO — sector cooling, don't fight)
//        size mult: GO 1.25 / NEUTRAL 1.0
//   SS: sectorTier ∈ {NO_GO, NEUTRAL}   (skip GO — short into strength = bad)
//        size mult: NO_GO 1.25 / NEUTRAL 1.0   (mirrored — short into weakness)
//
// Source of truth for signals: getAiUniverseSignals() — already carries
// sectorTier + sectorMult (Phase B). We re-derive the SS-mirrored mult here.
// ────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';
import { getAiUniverseSignals } from './aiUniverseSignalsService.js';
import { getLatestAiSectorRanks } from './aiSectorRotationService.js';
import { SECTORS } from './scripts/aiUniverse/aiUniverseData.js';
import { fetchAiQuotesBatch } from './aiIntradayOverlay.js';

const COLL_AI_ORDERS = 'pnthr_ai_orders';

// Vitality: 1% NAV per trade (× sector multiplier)
const NAV_VITALITY_PCT  = 0.01;
const TICKER_CAP_PCT    = 0.10;
const ASSUMED_NAV       = 60_000; // Brennan's VIP account size

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

  // 4. Build candidate orders
  const orders = [];
  const skipLog = { blNoGo: 0, ssGo: 0, notEntry: 0, noStop: 0, noPrice: 0 };

  for (const ticker of allTickers) {
    const sig = signals[ticker];
    if (!sig) continue;

    // Only entry signals (BL or SS) — BE/SE are exits, no order to place
    if (sig.signal !== 'BL' && sig.signal !== 'SS') { skipLog.notEntry++; continue; }

    const tier = sig.sectorTier;
    const isLong = sig.signal === 'BL';
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
    });
  }

  // 5. Sort: GO/NO_GO tier first (1.25× mult), then NEUTRAL, then by signal date desc
  orders.sort((a, b) => {
    const t = tierRankForSort(a.sectorTier) - tierRankForSort(b.sectorTier);
    if (t !== 0) return t;
    // newer signal first
    return (b.signalDate || '').localeCompare(a.signalDate || '');
  });

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
