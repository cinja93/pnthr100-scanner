// server/aiUniverseKillService.js
// ── PNTHR AI Kill — D1-D8 score for the 304 AI Universe stocks ─────────────
//
// Mirrors apexService.js (the 679 PNTHR Kill scoring engine) but with the AI
// substitutions Scott locked in:
//   • D1 (regime):  PAI300 weekly EMA position + AI Universe BL/SS ratio
//                   (NOT SPY/QQQ/MDY)
//   • D2 (sector direction):  the stock's AI sector INDEX (PAI_S{n}) returns
//                              (NOT S&P 500 GICS sector ETFs / XL*)
//   • D3 (entry quality):  stock close vs its AI-sector-tuned EMA
//                           (period from pnthrAiSectorsConfig.js)
//   • D4 (signal freshness):  same formula, signalAge from AI signals
//   • D5 (rank rise):  0 for v1 — AI Universe doesn't have rank-history yet
//   • D6 (momentum):   RSI/OBV/ADX/Volume on stock's weekly bars (same math)
//   • D7 (rank velocity):  0 for v1 — pairs with D5
//   • D8 (prey):  0 for v1 — no AI Prey scan yet
//
// Total = (D2 + D3 + D4 + D5 + D6 + D7 + D8) × D1
// Tier mapping identical to apexService (≥130 ALPHA → -99 OVEREXTENDED).
//
// Reads from:
//   • pnthr_ai_index_candles_weekly         — PAI300 (D1)
//   • pnthr_ai_sector_candles_weekly        — 16 sector indices (D2)
//   • pnthr_ai_bt_candles_weekly            — per-stock weekly bars (D3, D6)
//
// Zero touch to 679 collections. Cached 5 min.
// ────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';
import { SECTORS } from './scripts/aiUniverse/aiUniverseData.js';
import { SECTOR_EMA_PERIODS, sectorTicker } from './data/pnthrAiSectorsConfig.js';
import { INDEX_EMA_PERIOD, INDEX_TICKER } from './data/pnthrAiIndexConfig.js';
import { getAiUniverseSignals } from './aiUniverseSignalsService.js';
import { calculateEMA } from './signalDetection.js';

// ── Tier ladder (identical to ApexService) ──────────────────────────────────
export const AI_KILL_TIERS = [
  { name: 'ALPHA PNTHR KILL',   minScore: 130, color: '#FFD700' },
  { name: 'STRIKING',           minScore: 100, color: '#22c55e' },
  { name: 'HUNTING',            minScore:  80, color: '#3b82f6' },
  { name: 'POUNCING',           minScore:  65, color: '#06b6d4' },
  { name: 'COILING',            minScore:  50, color: '#a855f7' },
  { name: 'STALKING',           minScore:  35, color: '#ec4899' },
  { name: 'TRACKING',           minScore:  20, color: '#f59e0b' },
  { name: 'PROWLING',           minScore:  10, color: '#ef4444' },
  { name: 'STIRRING',           minScore:   0, color: '#6b7280' },
  { name: 'DORMANT',            minScore:-Infinity, color: '#374151' },
];
export function getAiKillTier(score) {
  if (score === -99) return { name: 'OVEREXTENDED', color: '#1f2937' };
  for (const t of AI_KILL_TIERS) if (score >= t.minScore) return t;
  return AI_KILL_TIERS[AI_KILL_TIERS.length - 1];
}

// ── Indicator math (identical to apexService) ───────────────────────────────
function computeOBV(weekly) {
  const n = weekly.length, obv = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    if (weekly[i].close > weekly[i - 1].close) obv[i] = obv[i - 1] + (weekly[i].volume || 0);
    else if (weekly[i].close < weekly[i - 1].close) obv[i] = obv[i - 1] - (weekly[i].volume || 0);
    else obv[i] = obv[i - 1];
  }
  return obv;
}
function computeRSI14(weekly) {
  const closes = weekly.map(b => b.close);
  const n = closes.length, rsi = new Array(n).fill(null);
  if (n < 15) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= 14; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
  }
  avgGain /= 14; avgLoss /= 14;
  rsi[14] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = 15; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * 13 + Math.max(d, 0)) / 14;
    avgLoss = (avgLoss * 13 + Math.max(-d, 0)) / 14;
    rsi[i]  = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}
function computeADX14(weekly) {
  const n = weekly.length, adxArr = new Array(n).fill(null);
  if (n < 30) return adxArr;
  const trs = [], plusDMs = [], minusDMs = [];
  for (let i = 1; i < n; i++) {
    const cur = weekly[i], prev = weekly[i - 1];
    trs.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close)));
    const up = cur.high - prev.high, dn = prev.low - cur.low;
    plusDMs.push(up > dn && up > 0 ? up : 0);
    minusDMs.push(dn > up && dn > 0 ? dn : 0);
  }
  let smTR  = trs.slice(0, 14).reduce((a, b) => a + b, 0);
  let smPDM = plusDMs.slice(0, 14).reduce((a, b) => a + b, 0);
  let smMDM = minusDMs.slice(0, 14).reduce((a, b) => a + b, 0);
  const dxArr = [];
  for (let i = 14; i < trs.length; i++) {
    smTR  = smTR  - smTR  / 14 + trs[i];
    smPDM = smPDM - smPDM / 14 + plusDMs[i];
    smMDM = smMDM - smMDM / 14 + minusDMs[i];
    const pdi = smTR === 0 ? 0 : (smPDM / smTR) * 100;
    const mdi = smTR === 0 ? 0 : (smMDM / smTR) * 100;
    const sum = pdi + mdi;
    dxArr.push(sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100);
  }
  if (dxArr.length < 14) return adxArr;
  let adx = dxArr.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
  const base = 28;
  adxArr[base] = adx;
  for (let i = 14; i < dxArr.length; i++) {
    adx = (adx * 13 + dxArr[i]) / 14;
    adxArr[base + (i - 13)] = adx;
  }
  return adxArr;
}

// ── D1: Market regime — PAI300 (NOT SPY) ────────────────────────────────────
function calcD1(signal, pai300Data, signalCounts) {
  const { blCount = 0, ssCount = 0, newBlCount = 0, newSsCount = 0 } = signalCounts;
  let indexScore = 0;
  if (pai300Data) {
    const aboveEma = pai300Data.aboveEma;
    const slope    = pai300Data.emaSlope;
    const slopeDir = slope > 0.1 ? 'rising' : slope < -0.1 ? 'falling' : 'flat';
    if (!aboveEma && slopeDir === 'falling') indexScore = -2;
    else if (!aboveEma)                      indexScore = -1;
    else if (aboveEma && slopeDir === 'rising') indexScore = 2;
    else if (aboveEma)                       indexScore = 1;
  }
  const openRatio = ssCount / Math.max(blCount, 1);
  const newRatio  = newSsCount / Math.max(newBlCount, 1);
  let ratioScore = 0;
  if (openRatio > 3)        ratioScore = -2;
  else if (openRatio > 2)   ratioScore = -1;
  else if (openRatio < 0.5) ratioScore =  2;
  else if (openRatio < 1)   ratioScore =  1;
  if (newRatio > 5)        ratioScore -= 1;
  else if (newRatio < 0.2) ratioScore += 1;
  const regimeScore = indexScore + ratioScore;
  let multiplier = signal === 'BL' ? 1.0 + regimeScore * 0.06 : 1.0 - regimeScore * 0.06;
  return {
    score: Math.max(0.70, Math.min(1.30, Math.round(multiplier * 100) / 100)),
    regimeScore, indexScore, ratioScore,
    openRatio: Math.round(openRatio * 10) / 10,
    newRatio:  Math.round(newRatio  * 10) / 10,
  };
}

// ── D2: Sector direction — AI sector INDEX (NOT XLK etc.) ──────────────────
function scoreD2(signal, sectorId, aiSectorReturnsMap, isNewSignal) {
  if (!signal || !sectorId) return { score: 0, aligned: null };
  const sec = aiSectorReturnsMap[sectorId];
  if (!sec) return { score: 0, aligned: null };
  const { return5D, return1M } = sec;
  const sectorBullish = return5D >= 0;
  const aligned    = (signal === 'BL' && sectorBullish) || (signal === 'SS' && !sectorBullish);
  const direction  = aligned ? 1 : -1;
  const newMult    = isNewSignal ? 2 : 1;
  const score5D = Math.abs(return5D) * newMult * direction * 2;
  const score1M = Math.abs(return1M || 0) * direction;
  const raw     = score5D + score1M;
  const score   = Math.max(-15, Math.min(15, Math.round(raw * 10) / 10));
  return {
    score, aligned,
    score5D:  Math.round(score5D  * 10) / 10,
    score1M:  Math.round(score1M  * 10) / 10,
    return5D: Math.round(return5D * 10) / 10,
    return1M: Math.round((return1M || 0) * 10) / 10,
  };
}

// ── D3: Entry quality — stock close vs its AI-sector-tuned EMA ─────────────
function scoreD3(signal, stockData) {
  const zero = { score: 0, subA: 0, subB: 0, subC: 0, confirmation: 'UNCONFIRMED', overextended: false, convictionPct: 0, slopePct: 0, separationPct: 0, closeSepPct: 0 };
  if (!signal || !stockData) return zero;
  const { weekly, ema } = stockData;
  const n = weekly.length, li = n - 1;
  const emaCur  = ema[li];
  const emaPrev = ema[li - 1];
  const bar = weekly[li];
  if (emaCur == null || !bar) return zero;

  // Sub-A: close conviction (range-normalized)
  const range = bar.high - bar.low;
  let closeConvictionPct = 0;
  if (range > 0) {
    closeConvictionPct = signal === 'BL'
      ? (bar.close - bar.low)  / range * 100
      : (bar.high  - bar.close) / range * 100;
  }
  const subA = Math.min(Math.max(closeConvictionPct * 2.5, 0), 40);

  // Sub-B: EMA slope
  let emaSlopePct = 0;
  if (emaPrev != null && emaPrev !== 0) {
    emaSlopePct = (emaCur - emaPrev) / emaPrev * 100;
  }
  const slopeAligned = signal === 'BL' ? emaSlopePct : -emaSlopePct;
  const subB = Math.min(Math.max(slopeAligned * 10, 0), 30);

  // Sub-C: EMA separation (bell curve)
  // For BL: low - ema (low above EMA), for SS: ema - high
  let emaSeparationPct = 0;
  if (signal === 'BL') emaSeparationPct = ((bar.low  - emaCur) / emaCur) * 100;
  else                 emaSeparationPct = ((emaCur  - bar.high) / emaCur) * 100;
  // close-based separation for overextension gate
  const closeSepPct = Math.abs((bar.close - emaCur) / emaCur) * 100;

  let subC = 0;
  if (emaSeparationPct <= 0) subC = 0;
  else if (emaSeparationPct <= 2)  subC = emaSeparationPct * 3;
  else if (emaSeparationPct <= 8)  subC = 6 + (emaSeparationPct - 2) * 1.5;
  else if (emaSeparationPct <= 15) subC = 15 - (emaSeparationPct - 8) * (12 / 7);
  else if (emaSeparationPct <= 20) subC = 3 - (emaSeparationPct - 15) * 0.6;
  else subC = 0;
  subC = Math.max(subC, 0);

  const overextended = closeSepPct > 20;
  const total = Math.round((subA + subB + subC) * 10) / 10;
  let confirmation;
  if (overextended)     confirmation = 'OVEREXTENDED';
  else if (total >= 30) confirmation = 'CONFIRMED';
  else if (total >= 15) confirmation = 'PARTIAL';
  else                  confirmation = 'UNCONFIRMED';
  return {
    score: total,
    subA: Math.round(subA * 10) / 10,
    subB: Math.round(subB * 10) / 10,
    subC: Math.round(subC * 10) / 10,
    confirmation, overextended,
    convictionPct: Math.round(closeConvictionPct * 10) / 10,
    slopePct:      Math.round(emaSlopePct        * 10) / 10,
    separationPct: Math.round(emaSeparationPct   * 10) / 10,
    closeSepPct:   Math.round(closeSepPct        * 10) / 10,
  };
}

// ── D4: Signal freshness ────────────────────────────────────────────────────
function scoreD4(signalAge, d3Confirmation) {
  let score;
  if (signalAge === 0) {
    if (d3Confirmation === 'CONFIRMED')    score = 10;
    else if (d3Confirmation === 'PARTIAL') score = 6;
    else                                   score = 3;
  } else if (signalAge === 1) {
    if (d3Confirmation === 'CONFIRMED')    score = 7;
    else if (d3Confirmation === 'PARTIAL') score = 4;
    else                                   score = 2;
  } else if (signalAge === 2) score = 4;
  else if (signalAge <= 5)    score = 0;
  else if (signalAge <= 9)    score = -3 * (signalAge - 5);
  else                        score = Math.max(-12 - (signalAge - 9) * 1.5, -15);
  return { score, signalAge, gatedBy: d3Confirmation };
}

// ── D6: Momentum (RSI + OBV + ADX + Volume) ────────────────────────────────
function scoreD6(signal, stockData) {
  if (!signal || !stockData) return { score: 0, subA: 0, subB: 0, subC: 0, subD: 0, curRsi: null };
  const { weekly, rsi, obv, adx } = stockData;
  const n = weekly.length, li = n - 1;
  let subA = 0;
  const curRsi = rsi[li];
  if (curRsi != null) {
    subA = signal === 'BL'
      ? Math.min(Math.max((curRsi - 50) / 10, -5), 5)
      : Math.min(Math.max((50 - curRsi) / 10, -5), 5);
  }
  let subB = 0;
  if (li >= 1 && obv[li - 1] !== 0) {
    const obvChangePct = (obv[li] - obv[li - 1]) / Math.abs(obv[li - 1]) * 100;
    const obvAligned   = signal === 'BL' ? obvChangePct : -obvChangePct;
    subB = Math.min(Math.max(obvAligned / 5, -5), 5);
  }
  let subC = 0;
  const adxCur  = adx[li];
  const adxPrev = adx[li - 1];
  if (adxCur != null && adxCur > 15 && adxPrev != null && adxCur > adxPrev) {
    subC = Math.min((adxCur - 15) / 5, 5);
  }
  let subD = 0;
  const lookback = Math.min(20, n - 1);
  if (lookback > 0) {
    const avgVol = weekly.slice(li - lookback, li).reduce((s, b) => s + (b.volume || 0), 0) / lookback;
    if (avgVol > 0 && (weekly[li].volume || 0) / avgVol > 1.5) subD = 5;
  }
  const raw = subA + subB + subC + subD;
  return {
    score: Math.max(-10, Math.min(20, Math.round(raw * 10) / 10)),
    subA: Math.round(subA * 10) / 10,
    subB: Math.round(subB * 10) / 10,
    subC: Math.round(subC * 10) / 10,
    subD,
    curRsi: curRsi ?? null,
  };
}

// ── Cache ──
let cache = null; let cacheAt = 0;
const CACHE_MS = 5 * 60 * 1000;
export function clearAiUniverseKillCache() { cache = null; cacheAt = 0; }

// ── Main ────────────────────────────────────────────────────────────────────
export async function getAiUniverseKill({ refresh = false } = {}) {
  const now = Date.now();
  if (cache && !refresh && (now - cacheAt) < CACHE_MS) return cache;

  const db = await connectToDatabase();
  if (!db) return { stocks: {} };

  // Pull PAI300 weekly bars (D1)
  const pai300Doc = await db.collection('pnthr_ai_index_candles_weekly').findOne({ ticker: INDEX_TICKER });
  const pai300Bars = (pai300Doc?.weekly || []).slice().sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  let pai300Data = null;
  if (pai300Bars.length >= INDEX_EMA_PERIOD + 2) {
    const closes = pai300Bars.map(b => b.close);
    const ema = calculateEMA(pai300Bars.map(b => ({ time: b.weekOf, close: b.close })), INDEX_EMA_PERIOD);
    const li = pai300Bars.length - 1;
    const emaIdx = ema.length - 1;
    const emaCur  = ema[emaIdx]?.value;
    const emaPrev = ema[emaIdx - 1]?.value;
    if (emaCur != null && emaPrev != null) {
      pai300Data = {
        aboveEma:  pai300Bars[li].close > emaCur,
        emaSlope:  (emaCur - emaPrev) / emaPrev * 100,
        emaCur,
      };
    }
  }

  // Pull all 16 sector index weekly bars (D2)
  const sectorDocs = await db.collection('pnthr_ai_sector_candles_weekly').find({ ticker: /^PAI_S/ }).toArray();
  const aiSectorReturnsMap = {};
  for (const doc of sectorDocs) {
    const wkly = (doc.weekly || []).slice().sort((a, b) => a.weekOf.localeCompare(b.weekOf));
    const n = wkly.length;
    if (n < 5) continue;
    const return5D = (wkly[n - 1].close - wkly[n - 2].close) / wkly[n - 2].close * 100;
    const return1M = (wkly[n - 1].close - wkly[n - 5].close) / wkly[n - 5].close * 100;
    aiSectorReturnsMap[doc.sectorId] = { return5D, return1M };
  }

  // Get current per-stock signals (D4 inputs + signal counts for D1)
  const { signals: weeklySignals } = await getAiUniverseSignals();
  let blCount = 0, ssCount = 0, newBlCount = 0, newSsCount = 0;
  for (const sig of Object.values(weeklySignals)) {
    if (sig.signal === 'BL') { blCount++; if (sig.isNewSignal) newBlCount++; }
    if (sig.signal === 'SS') { ssCount++; if (sig.isNewSignal) newSsCount++; }
  }
  const signalCounts = { blCount, ssCount, newBlCount, newSsCount };

  // Pull all per-stock weekly bars (D3 + D6)
  const TICKER_TO_SECTOR_ID = {};
  for (const sec of SECTORS) for (const h of sec.holdings) TICKER_TO_SECTOR_ID[h.ticker] = sec.id;
  const allTickers = Object.keys(TICKER_TO_SECTOR_ID);
  const stockDocs = await db.collection('pnthr_ai_bt_candles_weekly').find({ ticker: { $in: allTickers } }).toArray();
  const weeklyByTicker = Object.fromEntries(stockDocs.map(d => [d.ticker, d.weekly || []]));

  const todayISO = new Date().toISOString().split('T')[0];
  const stocks = {};
  let scored = 0, overextended = 0;

  for (const ticker of allTickers) {
    const sectorId = TICKER_TO_SECTOR_ID[ticker];
    const period   = SECTOR_EMA_PERIODS[sectorId] || 30;
    const sig      = weeklySignals[ticker];
    if (!sig || !sig.signal) {
      stocks[ticker] = { signal: null, total: 0, tier: 'STIRRING' };
      continue;
    }

    const wRaw = weeklyByTicker[ticker] || [];
    if (wRaw.length < period + 2) {
      stocks[ticker] = { signal: sig.signal, total: 0, tier: 'STIRRING', note: 'insufficient bars' };
      continue;
    }
    const weekly = [...wRaw].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
    // Compute EMA at the sector's tuned period
    const emaSeries = calculateEMA(weekly.map(b => ({ time: b.weekOf, close: b.close })), period);
    // Build ema array aligned to weekly (null until period-1)
    const ema = new Array(weekly.length).fill(null);
    for (let i = 0; i < emaSeries.length; i++) {
      const idx = period - 1 + i;
      if (idx < ema.length) ema[idx] = emaSeries[i].value;
    }
    const stockData = {
      weekly, ema,
      obv: computeOBV(weekly),
      rsi: computeRSI14(weekly),
      adx: computeADX14(weekly),
    };

    // Compute signal age in WEEKS from signalDate
    let signalAge = 999;
    if (sig.signalDate) {
      const t1 = Date.parse(sig.signalDate + 'T00:00:00Z');
      const t2 = Date.parse(todayISO       + 'T00:00:00Z');
      if (!isNaN(t1) && !isNaN(t2)) {
        signalAge = Math.max(0, Math.round((t2 - t1) / (7 * 24 * 60 * 60 * 1000)));
      }
    }

    const d1 = calcD1(sig.signal, pai300Data, signalCounts);
    const d2 = scoreD2(sig.signal, sectorId, aiSectorReturnsMap, sig.isNewSignal);
    const d3 = scoreD3(sig.signal, stockData);
    const d4 = scoreD4(signalAge, d3.confirmation);
    const d5 = { score: 0 };  // v1: no rank history yet
    const d6 = scoreD6(sig.signal, stockData);
    const d7 = { score: 0 };  // v1: no rank velocity yet
    const d8 = { score: 0 };  // v1: no AI Prey scan yet

    let total;
    let tier;
    if (d3.overextended) {
      total = -99;
      tier  = 'OVEREXTENDED';
      overextended++;
    } else {
      const sum = d2.score + d3.score + d4.score + d5.score + d6.score + d7.score + d8.score;
      total = Math.round(sum * d1.score * 10) / 10;
      tier  = getAiKillTier(total).name;
      scored++;
    }

    stocks[ticker] = {
      signal:    sig.signal,
      isNewSignal: !!sig.isNewSignal,
      signalAge,
      d1, d2, d3, d4, d5, d6, d7, d8,
      total,
      tier,
    };
  }

  console.log(`🎯 AI Kill: scored ${scored}, overextended ${overextended}, regime D1 base=${pai300Data ? (pai300Data.aboveEma ? 'BULL' : 'BEAR') : 'unknown'} (BL=${blCount}, SS=${ssCount})`);

  // Top-10 ranking + rank changes (vs prior cache snapshot)
  const ranked = Object.entries(stocks)
    .filter(([, s]) => s.total != null && s.total > 0 && s.total !== -99)
    .map(([ticker, s]) => ({ ticker, total: s.total, tier: s.tier, signal: s.signal }))
    .sort((a, b) => b.total - a.total)
    .map((s, i) => ({ ...s, rank: i + 1 }));

  // Patch rank back into the per-ticker map for easy lookup
  for (const r of ranked) {
    if (stocks[r.ticker]) stocks[r.ticker].rank = r.rank;
  }

  const out = {
    ok: true,
    asOf:        todayISO,
    pai300:      pai300Data,
    signalCounts,
    sectorReturns: aiSectorReturnsMap,
    stocks,
    ranked: ranked.slice(0, 50),  // top 50 for the page
  };
  cache = out; cacheAt = now;
  return out;
}
