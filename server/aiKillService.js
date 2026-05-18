// server/aiKillService.js
// ── PNTHR AI Kill v1 — AI-native predatory scoring ─────────────────────────
//
// Mirrors the 679 Kill formula structure but uses AI-native inputs throughout.
// v1 = the four core dimensions we already have data for. D5/D6/D7/D8 are
// set to 0 in v1 — they require new pipelines (rank-history snapshots, AI
// Prey, daily RSI/OBV/ADX) that ship in later iterations.
//
// Formula: Total = (D2 + D3 + D4 + D5 + D6 + D7 + D8) × D1
//
//   D1  Regime multiplier   0.70×–1.30×   PAI300 close vs 36W OpEMA + signal alignment
//   D2  Sector alignment    ±15 pts        5D sector tier (GO/NEUTRAL/NO_GO) × signal direction
//   D3  Entry quality       0–85 pts        Conviction (% above/below EMA) + slope + separation
//   D4  Signal freshness    -15 to +10 pts  New = +10, decay 1 pt/week, floor -15
//   D5  Rank rise            ±20 pts        v1 = 0 (needs weekly rank-history snapshots)
//   D6  Momentum            -10–20 pts      v1 = 0 (needs daily RSI/OBV/ADX pipeline)
//   D7  Rank velocity        ±10 pts        v1 = 0 (needs rank-history)
//   D8  Prey presence        0–6 pts        v1 = 0 (AI Prey not built)
//
// Same tier ladder as 679 Kill (ALPHA KILL ≥130, STRIKING ≥100, ...).
//
// Storage: pnthr_ai_kill_scores  — one doc per weekOf, holds ranked list.
// ────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';
import { getAiUniverseSignals } from './aiUniverseSignalsService.js';
import { getLatestAiSectorRanks } from './aiSectorRotationService.js';
import { SECTORS } from './scripts/aiUniverse/aiUniverseData.js';
import { SECTOR_EMA_PERIODS } from './data/pnthrAiSectorsConfig.js';
import { calculateEMA } from './signalDetection.js';

const COLL_AI_KILL = 'pnthr_ai_kill_scores';

// Tier ladder — identical to 679 Kill
export const AI_KILL_TIERS = [
  { min: 130, max: Infinity, name: 'ALPHA AI KILL', tagline: 'Jugular. Teeth in. Alpha AI is Legend.' },
  { min: 100, max: 129,      name: 'STRIKING',      tagline: 'Claws out. Contact made. In the kill zone.' },
  { min: 80,  max: 99,       name: 'HUNTING',       tagline: 'Full pursuit mode. Locked and moving fast.' },
  { min: 65,  max: 79,       name: 'POUNCING',      tagline: 'The leap has begun. No turning back.' },
  { min: 50,  max: 64,       name: 'COILING',       tagline: 'Body compressed. Energy stored. About to explode.' },
  { min: 35,  max: 49,       name: 'STALKING',      tagline: 'Eyes fixed on target. Closing the distance silently.' },
  { min: 20,  max: 34,       name: 'TRACKING',      tagline: 'Scent picked up. Target identified.' },
  { min: 10,  max: 19,       name: 'PROWLING',      tagline: 'Moving through the jungle. No target yet.' },
  { min: 0,   max: 9,        name: 'STIRRING',      tagline: 'Waking up. Eyes barely open.' },
  { min: -Infinity, max: -1, name: 'DORMANT',       tagline: 'Fighting the trend. Sleeping against the flow.' },
];

export function getAiKillTier(score) {
  if (score == null) return AI_KILL_TIERS[9];
  return AI_KILL_TIERS.find(t => score >= t.min) ?? AI_KILL_TIERS[9];
}

const TICKER_META = {};
for (const sec of SECTORS) for (const h of sec.holdings) TICKER_META[h.ticker] = { sectorId: sec.id, sectorName: sec.name, companyName: h.name };

// ── Scoring helpers ────────────────────────────────────────────────────────

function getLastFriday(refDate = new Date()) {
  const d = new Date(refDate);
  const day = d.getUTCDay();
  const diff = day >= 5 ? day - 5 : day + 2;
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

// D1 — PAI300 36W regime mult, with signal alignment
function scoreD1(direction, pai300Bull) {
  if (pai300Bull == null) return 1.0; // unknown → neutral
  if (direction === 'LONG'  &&  pai300Bull) return 1.30;
  if (direction === 'SHORT' && !pai300Bull) return 1.30;
  if (direction === 'LONG'  && !pai300Bull) return 0.70;
  if (direction === 'SHORT' &&  pai300Bull) return 0.70;
  return 1.0;
}

// D2 — sector tier × direction
function scoreD2(direction, tier) {
  if (!tier) return 0;
  if (direction === 'LONG') {
    if (tier === 'GO') return 15;
    if (tier === 'NEUTRAL') return 5;
    if (tier === 'NO_GO') return -15;
  } else { // SHORT
    if (tier === 'NO_GO') return 15;
    if (tier === 'NEUTRAL') return 5;
    if (tier === 'GO') return -15;
  }
  return 0;
}

// D3 — entry quality
//   Conviction: % above/below EMA, capped at 25% (×2 → 0–50)
//   Slope: 8W weekly EMA slope annualized %, capped at 50% (×0.6 → 0–30)
//   Separation: risk % below 5% gets bonus (×1 → 0–5)
function scoreD3(direction, close, ema, emaSlopeAnnPct, riskPct) {
  if (close == null || ema == null || ema <= 0) return 0;

  // Conviction (positive = aligned with direction)
  const sepPct = ((close - ema) / ema) * 100;
  let conviction = direction === 'LONG' ? sepPct : -sepPct;
  conviction = Math.max(0, Math.min(25, conviction));
  const convictionPts = conviction * 2.0;  // 0..50

  // Slope (rising helps longs, falling helps shorts)
  let slope = direction === 'LONG' ? (emaSlopeAnnPct ?? 0) : -(emaSlopeAnnPct ?? 0);
  slope = Math.max(0, Math.min(50, slope));
  const slopePts = slope * 0.6;            // 0..30

  // Separation: tighter risk = better entry
  let sepBonus = 0;
  if (riskPct != null && riskPct > 0 && riskPct <= 5) sepBonus = 5;
  else if (riskPct != null && riskPct <= 10) sepBonus = 3;
  else if (riskPct != null && riskPct <= 20) sepBonus = 1;

  return convictionPts + slopePts + sepBonus;
}

// D4 — signal freshness
function scoreD4(signalDate, isNewSignal, weekOf) {
  if (isNewSignal) return 10;
  if (!signalDate) return 0;
  const sigMs = Date.parse(signalDate + 'T00:00:00Z');
  const wkMs  = Date.parse(weekOf + 'T00:00:00Z');
  if (isNaN(sigMs) || isNaN(wkMs)) return 0;
  const ageWeeks = Math.max(0, Math.round((wkMs - sigMs) / (7 * 86400000)));
  // -1 pt per week, capped at -15
  return Math.max(-15, -ageWeeks);
}

// ── Main scoring run ───────────────────────────────────────────────────────

/**
 * Compute AI Kill scores for every ticker with an active BL/SS signal.
 * Idempotent — upsert by weekOf.
 */
export async function runAiKillPipeline() {
  const weekOf = getLastFriday();
  const db = await connectToDatabase();
  if (!db) throw new Error('No DB connection');

  console.log(`[AI Kill] starting v1 pipeline (weekOf=${weekOf})…`);

  // 1. Pull signals (already carry sectorTier, sectorMult, lastBarDate)
  const { signals } = await getAiUniverseSignals({ refresh: true });
  const tickers = Object.keys(signals);
  console.log(`[AI Kill] received ${tickers.length} weekly signals`);

  // 2. PAI300 36W regime
  let pai300Bull = null;
  try {
    const REGIME_PERIOD = 36;
    const paiDoc = await db.collection('pnthr_ai_index_candles_weekly').findOne({ ticker: 'PAI300' });
    const wk = (paiDoc?.weekly || []).slice().sort((a, b) => a.weekOf.localeCompare(b.weekOf));
    if (wk.length >= REGIME_PERIOD) {
      const closes = wk.map(b => b.close);
      const k = 2 / (REGIME_PERIOD + 1);
      let ema = closes.slice(0, REGIME_PERIOD).reduce((s, x) => s + x, 0) / REGIME_PERIOD;
      for (let i = REGIME_PERIOD; i < closes.length; i++) ema = (closes[i] - ema) * k + ema;
      pai300Bull = closes[closes.length - 1] > ema;
    }
  } catch (err) {
    console.warn('[AI Kill] PAI300 regime lookup failed:', err.message);
  }

  // 3. Pull weekly bars per ticker for EMA + slope + close (for D3)
  const weeklyDocs = await db.collection('pnthr_ai_bt_candles_weekly').find({ ticker: { $in: tickers } }, { projection: { ticker: 1, weekly: 1 } }).toArray();
  const weeklyByTicker = Object.fromEntries(weeklyDocs.map(d => [d.ticker, [...(d.weekly || [])].sort((a, b) => a.weekOf.localeCompare(b.weekOf))]));

  // 4. Score each signal
  const scored = [];
  for (const ticker of tickers) {
    const sig = signals[ticker];
    if (!sig) continue;
    if (sig.signal !== 'BL' && sig.signal !== 'SS') continue;

    const meta = TICKER_META[ticker];
    if (!meta) continue;

    const direction = sig.signal === 'BL' ? 'LONG' : 'SHORT';
    const period = SECTOR_EMA_PERIODS[meta.sectorId] || 30;

    // Compute weekly EMA + slope from bars
    const wk = weeklyByTicker[ticker] || [];
    let close = null, ema = null, emaSlopeAnn = null, riskPct = null;
    if (wk.length >= period + 1) {
      const closes = wk.map(b => b.close);
      const emaArr = calculateEMA(wk.map(b => ({ time: b.weekOf, close: b.close })), period);
      const lastEma = emaArr[emaArr.length - 1]?.value;
      const lastClose = closes[closes.length - 1];
      close = lastClose; ema = lastEma;
      // 8-week slope, annualized
      if (emaArr.length >= 9) {
        const ema0 = emaArr[emaArr.length - 9].value;
        const ema8 = emaArr[emaArr.length - 1].value;
        if (ema0 > 0) emaSlopeAnn = ((ema8 - ema0) / ema0) * (52 / 8) * 100;
      }
    }
    if (close != null && sig.stopPrice != null) {
      const r = direction === 'LONG' ? (close - sig.stopPrice) : (sig.stopPrice - close);
      if (r > 0) riskPct = (r / close) * 100;
    }

    const d1 = scoreD1(direction, pai300Bull);
    const d2 = scoreD2(direction, sig.sectorTier);
    const d3 = scoreD3(direction, close, ema, emaSlopeAnn, riskPct);
    const d4 = scoreD4(sig.signalDate, sig.isNewSignal, weekOf);
    const d5 = 0, d6 = 0, d7 = 0, d8 = 0;

    const subtotal = d2 + d3 + d4 + d5 + d6 + d7 + d8;
    const total = +(subtotal * d1).toFixed(2);
    const tier = getAiKillTier(total);

    scored.push({
      ticker,
      companyName: meta.companyName,
      sectorId: meta.sectorId,
      sectorName: meta.sectorName,
      signal: sig.signal,
      direction,
      sectorTier: sig.sectorTier,
      sectorMult: sig.sectorMult,
      pai300Bull,
      currentPrice: close,
      ema, emaSlopeAnn,
      gapPct: (close != null && ema != null && ema > 0) ? +( ((close - ema) / ema) * 100 ).toFixed(2) : null,
      slopePct: emaSlopeAnn != null ? +Math.abs(emaSlopeAnn).toFixed(1) : null,
      stopPrice: sig.stopPrice,
      riskPct: riskPct != null ? +riskPct.toFixed(2) : null,
      signalDate: sig.signalDate,
      lastBarDate: sig.lastBarDate,
      isNewSignal: !!sig.isNewSignal,
      scores: { d1, d2: +d2.toFixed(1), d3: +d3.toFixed(1), d4, d5, d6, d7, d8 },
      subtotal: +subtotal.toFixed(2),
      total,
      tierName: tier.name,
      tierTagline: tier.tagline,
    });
  }

  // 5. Rank: highest total wins, ties broken by D3 (entry quality)
  scored.sort((a, b) => b.total - a.total || b.scores.d3 - a.scores.d3);
  scored.forEach((s, i) => { s.killRank = i + 1; });

  // 6. Tier breakdown for header
  const byTier = {};
  for (const s of scored) byTier[s.tierName] = (byTier[s.tierName] || 0) + 1;

  // 7. Persist
  const doc = {
    weekOf,
    generatedAt: new Date(),
    version: 'v1.0',
    pai300Bull,
    universeSize: tickers.length,
    scoredCount: scored.length,
    scores: scored,
    tierBreakdown: byTier,
  };
  const col = db.collection(COLL_AI_KILL);
  await col.createIndex({ weekOf: -1 });
  await col.replaceOne({ weekOf }, doc, { upsert: true });

  console.log(`[AI Kill] ${weekOf}: scored ${scored.length} names. Top: ${scored[0]?.ticker} ${scored[0]?.total} ${scored[0]?.tierName}. Bear regime=${pai300Bull === false}`);
  return doc;
}

export async function getLatestAiKillScores() {
  const db = await connectToDatabase();
  if (!db) return null;
  return db.collection(COLL_AI_KILL).find({}).sort({ weekOf: -1, generatedAt: -1 }).limit(1).next();
}

export async function getAiKillHistory({ limit = 12 } = {}) {
  const db = await connectToDatabase();
  if (!db) return [];
  return db.collection(COLL_AI_KILL).find({}, { projection: { weekOf: 1, generatedAt: 1, scoredCount: 1, tierBreakdown: 1, pai300Bull: 1 } })
    .sort({ weekOf: -1 }).limit(limit).toArray();
}
