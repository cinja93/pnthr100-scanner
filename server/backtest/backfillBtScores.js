// server/backtest/backfillBtScores.js
// ── Backfill pnthr_bt_scores, pnthr_bt_regime, pnthr_bt_analyze_signals ────────
//
// Extends the three simulation backbone collections back to January 2019.
//
// FULL D1-D8 SCORING (backfillVersion '2.0'):
//   score = (D2 + D3 + D4 + D5 + D6 + D7 + D8) × D1
//
//   D1  Market regime multiplier (0.70×–1.30×)           ← FULL (index only, no ratio)
//   D2  Sector alignment (capped ±15)                    ← FULL
//   D3  Entry quality — Sub-A conviction, Sub-B slope,   ← FULL
//         Sub-C separation  (0–85 pts)
//   D4  Signal freshness — age decay/bonus (-15 to +10)  ← FULL (uses signalAge from state machine)
//   D5  Rank rise delta from prior week (capped ±20)     ← FULL (two-pass, 0 for new/first week)
//   D6  Momentum — RSI sub-A only (0–5 pts, floored 0)   ← PARTIAL (OBV/ADX/Volume need daily data)
//   D7  Rank velocity — curD5-prevD5 (capped ±10)        ← FULL (computed from D5 history)
//   D8  Prey presence (0–6 pts)                          ← DISCLOSED ZERO
//         Prey pipeline requires separate Prey detection run; omitted for 2019–2021 backfill.
//         Effect: ~0–3 pts underestimated on top BL/SS entries. Conservative bias.
//
// METHODOLOGY NOTE: "Pre-2021 Kill scores use the full D1–D7 formula (D8=0 for
//   Prey absence). D6 uses RSI momentum only (OBV/ADX not available at weekly
//   granularity for this period). Full 8-dimension scores including D8 are used
//   for April 2021 onward."
//
// TWO-PASS SCORING PER WEEK:
//   Pass 1: (D2+D3+D4+D6)×D1 → preliminary rank
//   Pass 2: D5 = prevFinalRank − prelimRank (capped ±20)
//           D7 = clip(round((D5−prevD5)/6), −10, +10)
//           Final = (D2+D3+D4+D5+D6+D7)×D1 → final rank stored for next week
//
// SAFE TO RE-RUN: Deletes all existing backfill records (backfillVersion ≥ '1.0')
//   at startup, then rebuilds from scratch. Original data (April 2021+, no backfillVersion)
//   is NEVER modified.
//
// Usage:  cd server && node backtest/backfillBtScores.js
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { connectToDatabase } from '../database.js';
import { aggregateWeeklyBars } from '../technicalUtils.js';
import { computeWilderATR, blInitStop, ssInitStop } from '../stopCalculation.js';

// ── Date range ─────────────────────────────────────────────────────────────────
const BACKFILL_START  = '2019-01-01';
const EMA_PERIOD      = 21;
const BACKFILL_VER    = '2.0';   // bump when formula changes

const SECTOR_MAP = {
  'Technology': 'XLK', 'Energy': 'XLE', 'Healthcare': 'XLV', 'Health Care': 'XLV',
  'Financial Services': 'XLF', 'Financials': 'XLF',
  'Consumer Discretionary': 'XLY', 'Consumer Cyclical': 'XLY',
  'Communication Services': 'XLC', 'Industrials': 'XLI',
  'Basic Materials': 'XLB', 'Materials': 'XLB',
  'Real Estate': 'XLRE', 'Utilities': 'XLU',
  'Consumer Staples': 'XLP', 'Consumer Defensive': 'XLP',
};
const SECTOR_NORMALIZE = {
  'Consumer Cyclical': 'Consumer Discretionary',
  'Consumer Defensive': 'Consumer Staples',
  'Health Care': 'Healthcare',
  'Financials': 'Financial Services',
  'Materials': 'Basic Materials',
};
function normSector(s) { return SECTOR_NORMALIZE[s] || s; }

const ALL_SECTOR_ETFS = ['XLK','XLE','XLV','XLF','XLY','XLC','XLI','XLB','XLRE','XLU','XLP'];

// ── Generate all Fridays in a date range ──────────────────────────────────────
function getFridaysInRange(fromStr, toStr) {
  const fridays = [];
  const d = new Date(fromStr + 'T12:00:00');
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
  while (d.toISOString().split('T')[0] <= toStr) {
    fridays.push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate() + 7);
  }
  return fridays;
}

// ── EMA computation ───────────────────────────────────────────────────────────
function computeEMASeries(closes, period) {
  if (closes.length < period) return [];
  const mult = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, c) => s + c, 0) / period;
  const emas = [ema];
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * mult + ema * (1 - mult);
    emas.push(ema);
  }
  return emas;
}

// ── RSI computation (Wilder smoothing) ───────────────────────────────────────
function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  const rsis = new Array(period).fill(null);
  for (let i = period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsis.push(parseFloat((100 - 100 / (1 + rs)).toFixed(2)));
  }
  return rsis;
}

// ── D1: Regime multiplier ─────────────────────────────────────────────────────
function calcD1(signal, exchange, regimeByWeek, friday) {
  const exc = (exchange || '').toUpperCase();
  const indexTicker = (exc === 'NASDAQ' || exc.includes('NASDAQ')) ? 'QQQ' : 'SPY';
  const regime = regimeByWeek[friday];
  if (!regime) return 1.0;
  const idx = regime[indexTicker.toLowerCase()];
  if (!idx) return 1.0;

  const slope = idx.emaSlope ?? 0;
  const slopeDir = slope > 0.1 ? 'rising' : slope < -0.1 ? 'falling' : 'flat';
  let indexScore = 0;
  if (!idx.aboveEma && slopeDir === 'falling') indexScore = -2;
  else if (!idx.aboveEma)                      indexScore = -1;
  else if (idx.aboveEma && slopeDir === 'rising') indexScore = 2;
  else if (idx.aboveEma)                       indexScore = 1;

  let multiplier;
  if (signal === 'BL') multiplier = 1.0 + indexScore * 0.06;
  else                 multiplier = 1.0 - indexScore * 0.06;
  return Math.max(0.70, Math.min(1.30, Math.round(multiplier * 100) / 100));
}

// ── D2: Sector alignment ──────────────────────────────────────────────────────
function calcD2(signal, sector, sectorDataForWeek) {
  const etf = SECTOR_MAP[sector];
  if (!etf || !sectorDataForWeek?.[etf]) return 0;
  const { return5D, return1M } = sectorDataForWeek[etf];
  const sectorBullish = return5D >= 0;
  const aligned = (signal === 'BL' && sectorBullish) || (signal === 'SS' && !sectorBullish);
  const direction = aligned ? 1 : -1;
  const score5D = Math.abs(return5D) * direction * 2;
  const score1M = Math.abs(return1M || 0) * direction;
  const raw = score5D + score1M;
  return Math.max(-15, Math.min(15, Math.round(raw * 10) / 10));
}

// ── D3: Entry quality ─────────────────────────────────────────────────────────
function calcD3(signal, weeklyBar, ema, emaPrev) {
  if (!signal || !weeklyBar || ema == null) {
    return { score: 0, overextended: false, confirmation: 'UNCONFIRMED', subA: 0, subB: 0, subC: 0 };
  }

  // Sub-A: Close conviction
  const range = weeklyBar.high - weeklyBar.low;
  let conviction = 0;
  if (range > 0) {
    if (signal === 'BL') conviction = (weeklyBar.close - weeklyBar.low) / range * 100;
    else                 conviction = (weeklyBar.high - weeklyBar.close) / range * 100;
  }
  const subA = Math.min(conviction * 2.5, 40);

  // Sub-B: EMA slope (signal-direction only)
  let slopePct = 0;
  if (emaPrev != null && emaPrev !== 0) slopePct = (ema - emaPrev) / emaPrev * 100;
  let subB = 0;
  if (signal === 'BL' && slopePct > 0) subB = Math.min(slopePct * 10, 30);
  else if (signal === 'SS' && slopePct < 0) subB = Math.min(Math.abs(slopePct) * 10, 30);

  // Sub-C: EMA separation (bell curve)
  let sepPct = 0, closeSepPct = 0;
  if (ema !== 0) {
    if (signal === 'BL') {
      sepPct = (weeklyBar.low - ema) / ema * 100;
      closeSepPct = (weeklyBar.close - ema) / ema * 100;
    } else {
      sepPct = (ema - weeklyBar.high) / ema * 100;
      closeSepPct = (ema - weeklyBar.close) / ema * 100;
    }
  }

  // Overextension gate: close > 20% from EMA
  if (closeSepPct > 20) {
    return { score: 0, overextended: true, confirmation: 'OVEREXTENDED', subA: 0, subB: 0, subC: 0 };
  }

  let subC = 0;
  if (sepPct <= 0)       subC = 0;
  else if (sepPct <= 2)  subC = sepPct * 3;
  else if (sepPct <= 8)  subC = 6 + (sepPct - 2) * 1.5;
  else if (sepPct <= 15) subC = 15 - (sepPct - 8) * (12 / 7);
  else if (sepPct <= 20) subC = 3 - (sepPct - 15) * 0.6;
  subC = Math.max(subC, 0);

  const total = Math.round((subA + subB + subC) * 10) / 10;
  let confirmation;
  if (total >= 30) confirmation = 'CONFIRMED';
  else if (total >= 15) confirmation = 'PARTIAL';
  else confirmation = 'UNCONFIRMED';

  return {
    score: total,
    overextended: false,
    confirmation,
    subA: Math.round(subA * 10) / 10,
    subB: Math.round(subB * 10) / 10,
    subC: Math.round(subC * 10) / 10,
  };
}

// ── D4: Signal freshness (-15 to +10 pts) ─────────────────────────────────────
// Uses signal age (0 = new entry this week) and D3 confirmation level.
function calcD4(signalAge, confirmation) {
  if (signalAge === 0) {
    if (confirmation === 'CONFIRMED')   return 10;
    if (confirmation === 'PARTIAL')     return 6;
    return 3;  // UNCONFIRMED
  }
  if (signalAge === 1) {
    if (confirmation === 'CONFIRMED')   return 7;
    if (confirmation === 'PARTIAL')     return 4;
    return 2;  // UNCONFIRMED
  }
  if (signalAge === 2) return 4;
  if (signalAge <= 5)  return 0;
  // Age 6–9: -3 pts/week beyond 5; floor -15
  if (signalAge <= 9)  return Math.max(-15, -3 * (signalAge - 5));
  // Age 10+: -5 pts/week beyond 9; floor -15
  return Math.max(-15, -15 - 5 * (signalAge - 9));
}

// ── D6: Momentum — RSI sub-A only ─────────────────────────────────────────────
// Full D6 requires OBV/ADX/Volume at daily granularity not available here.
// RSI-only gives a 0–5 pt contribution (floored at 0).
function calcD6(signal, rsi) {
  if (rsi == null) return 0;
  let subA;
  if (signal === 'BL') subA = Math.min(Math.max((rsi - 50) / 10, -5), 5);
  else                 subA = Math.min(Math.max((50 - rsi) / 10, -5), 5);
  return Math.max(0, Math.min(20, Math.round(subA * 10) / 10));
}

// ── D5: Rank delta (capped ±20) ───────────────────────────────────────────────
// prevRank = final rank from prior week; curRank = preliminary rank this week (before D5/D7)
// Positive = rose in rank (improved); negative = fell in rank
function calcD5(prevRank, curPrelimRank) {
  if (prevRank == null) return 0;  // new entry or first week
  const delta = prevRank - curPrelimRank;
  return Math.max(-20, Math.min(20, delta));
}

// ── D7: Rank velocity (capped ±10) ───────────────────────────────────────────
// velocity = current week's D5 − prior week's D5
// score = clip(round(velocity / 6), -10, +10)
function calcD7(currentD5, prevD5) {
  const velocity = currentD5 - (prevD5 ?? 0);
  return Math.max(-10, Math.min(10, Math.round(velocity / 6)));
}

// ── Signal state machine — detects signals AND tracks signal age ──────────────
// signalAge: 0 = new entry this week, 1 = held 1 week, 2 = held 2 weeks, etc.
// Returns: Map<fridayStr, { signal, entryPrice, stopPrice, signalAge }>
function detectSignals(weeklyBars, emaPeriod, atrArr) {
  const events = new Map();
  if (weeklyBars.length < emaPeriod + 2) return events;

  const closes = weeklyBars.map(b => b.close);
  const emas = computeEMASeries(closes, emaPeriod);
  if (emas.length < 2) return events;
  const emaOffset = emaPeriod - 1;

  let position = null;   // { type, entryWi, stop, entryPrice, age }
  let longDaylight = 0, shortDaylight = 0;
  let longTrendActive = false, longTrendCapped = false;
  let shortTrendActive = false, shortTrendCapped = false;

  for (let wi = emaPeriod + 1; wi < weeklyBars.length; wi++) {
    const emaIdx = wi - emaOffset;
    if (emaIdx < 1) continue;

    const current  = weeklyBars[wi];
    const prev1    = weeklyBars[wi - 1];
    const prev2    = weeklyBars[wi - 2];
    const emaCurrent = emas[emaIdx];
    const twoWeekHigh = Math.max(prev1.high, prev2.high);
    const twoWeekLow  = Math.min(prev1.low,  prev2.low);

    longDaylight  = current.low  > emaCurrent ? longDaylight  + 1 : 0;
    shortDaylight = current.high < emaCurrent ? shortDaylight + 1 : 0;

    // Compute Friday date from weekStart (Monday) + 4 days
    const mon = new Date(current.weekStart + 'T12:00:00');
    const fri = new Date(mon);
    fri.setDate(mon.getDate() + 4);
    const fridayStr = fri.toISOString().split('T')[0];

    // ── Manage existing position ──
    if (position && position.entryWi !== wi) {
      // Ratchet stop
      const prevAtr = atrArr[wi - 1];
      if (prevAtr != null) {
        if (position.type === 'BL') {
          const candidate = Math.max(
            parseFloat((twoWeekLow - 0.01).toFixed(2)),
            parseFloat((prev1.close - prevAtr).toFixed(2))
          );
          position.stop = parseFloat(Math.max(position.stop, candidate).toFixed(2));
        } else {
          const candidate = Math.min(
            parseFloat((twoWeekHigh + 0.01).toFixed(2)),
            parseFloat((prev1.close + prevAtr).toFixed(2))
          );
          position.stop = parseFloat(Math.min(position.stop, candidate).toFixed(2));
        }
      }

      // Check structural exit
      if (position.type === 'BL' && current.low < twoWeekLow) {
        shortTrendActive = true; shortTrendCapped = true;
        position = null; continue;
      }
      if (position.type === 'SS' && current.high > twoWeekHigh) {
        longTrendActive = true; longTrendCapped = true;
        position = null; continue;
      }

      // Still in position — emit with current age, then increment
      events.set(fridayStr, {
        signal:      position.type,
        entryPrice:  position.entryPrice,
        stopPrice:   position.stop,
        signalAge:   position.age,
      });
      position.age++;
      continue;
    }

    // ── Look for new entry ──
    if (!position) {
      const emaPrev  = emas[emaIdx - 1];
      const blPhase1 = current.close > emaCurrent && emaCurrent > emaPrev && current.high >= twoWeekHigh + 0.01;
      const ssPhase1 = current.close < emaCurrent && emaCurrent < emaPrev && current.low  <= twoWeekLow  - 0.01;
      const dPct     = 0.01;
      const blZone    = current.low  >= emaCurrent * (1 + dPct) && current.low  <= emaCurrent * 1.10;
      const ssZone    = current.high <= emaCurrent * (1 - dPct) && current.high >= emaCurrent * 0.90;
      const blReentry = longTrendActive  && current.low  >= emaCurrent * (1 + dPct) && (!longTrendCapped  || current.low  <= emaCurrent * 1.25);
      const ssReentry = shortTrendActive && current.high <= emaCurrent * (1 - dPct) && (!shortTrendCapped || current.high >= emaCurrent * 0.75);
      const blDaylightOk = blReentry || (blZone && longDaylight >= 1 && longDaylight <= 3);
      const ssDaylightOk = ssReentry || (ssZone && shortDaylight >= 1 && shortDaylight <= 3);

      if (blPhase1 && blDaylightOk) {
        const initStop   = blInitStop(twoWeekLow, current.close, atrArr[wi]);
        const entryPrice = parseFloat((twoWeekHigh + 0.01).toFixed(2));
        events.set(fridayStr, { signal: 'BL', entryPrice, stopPrice: initStop, signalAge: 0 });
        position = { type: 'BL', entryWi: wi, stop: initStop, entryPrice, age: 1 };
        longTrendActive = true; longTrendCapped = false; shortTrendActive = false; shortTrendCapped = false;
      } else if (ssPhase1 && ssDaylightOk) {
        const initStop   = ssInitStop(twoWeekHigh, current.close, atrArr[wi]);
        const entryPrice = parseFloat((twoWeekLow - 0.01).toFixed(2));
        events.set(fridayStr, { signal: 'SS', entryPrice, stopPrice: initStop, signalAge: 0 });
        position = { type: 'SS', entryWi: wi, stop: initStop, entryPrice, age: 1 };
        shortTrendActive = true; shortTrendCapped = false; longTrendActive = false; longTrendCapped = false;
      }
    }
  }
  return events;
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('Cannot connect to MongoDB'); process.exit(1); }

  const candleCol  = db.collection('pnthr_bt_candles');
  const scoreCol   = db.collection('pnthr_bt_scores');
  const signalCol  = db.collection('pnthr_bt_analyze_signals');
  const regimeCol  = db.collection('pnthr_bt_regime');

  console.log('\n' + '═'.repeat(72));
  console.log('  PNTHR Backtest Score Backfill v2.0 — Full D1-D8 (D8=0 disclosed)');
  console.log(`  Period: ${BACKFILL_START} → first existing week in pnthr_bt_scores`);
  console.log('  Formula: score = (D2+D3+D4+D5+D6+D7+0)×D1  [D8=0, D6=RSI only]');
  console.log('  Two-pass scoring: base rank → D5/D7 → final rank');
  console.log('═'.repeat(72));

  // ── Delete all existing backfill records (v1.x and v2.x) ─────────────────
  // backfillVersion field is ONLY on records we created — original data is untouched
  console.log('\n  Purging existing backfill records...');
  const scoresDel  = await scoreCol.deleteMany({ backfillVersion: { $exists: true } });
  const signalsDel = await signalCol.deleteMany({ backfillVersion: { $exists: true } });
  const regimeDel  = await regimeCol.deleteMany({ weekOf: { $lt: '2021-01-01' } });
  console.log(`  Removed: ${scoresDel.deletedCount} scores, ${signalsDel.deletedCount} signals, ${regimeDel.deletedCount} regime records`);

  // ── Find the first existing week in pnthr_bt_scores ──────────────────────
  const firstExisting = await scoreCol.find({}, { projection: { weekOf: 1 } })
    .sort({ weekOf: 1 }).limit(1).toArray();
  const existingStart = firstExisting[0]?.weekOf ?? null;
  console.log(`\n  Original pnthr_bt_scores starts at: ${existingStart ?? 'EMPTY'}`);

  const backfillEnd = existingStart
    ? (() => {
        const d = new Date(existingStart + 'T12:00:00');
        d.setDate(d.getDate() - 1);
        return d.toISOString().split('T')[0];
      })()
    : '2021-03-26';

  if (existingStart && BACKFILL_START >= existingStart) {
    console.log(`\n  pnthr_bt_scores already starts at/before ${BACKFILL_START}. Nothing to backfill.`);
    process.exit(0);
  }

  const fridays = getFridaysInRange(BACKFILL_START, backfillEnd);
  console.log(`  Backfill range: ${BACKFILL_START} → ${backfillEnd} (${fridays.length} Fridays)\n`);

  // ── Load all existing regime weeks ───────────────────────────────────────
  const existingRegimeDocs = await regimeCol.find({}, { projection: { weekOf: 1 } }).toArray();
  const existingRegimeWeeks = new Set(existingRegimeDocs.map(d => d.weekOf));

  // ── Load all candle data ─────────────────────────────────────────────────
  console.log('  Loading candle data...');
  const allCandles = await candleCol.find({}).toArray();
  const allTickers = allCandles.map(d => d.ticker);
  const sectorEtfSet = new Set(ALL_SECTOR_ETFS);

  console.log(`  Building weekly bars + EMA series for ${allTickers.length} tickers...`);
  const weeklyMap  = {};
  const emaMap     = {};
  const atrMap     = {};
  const rsiMap     = {};
  const tickerMeta = {};

  for (const doc of allCandles) {
    const ticker = doc.ticker;
    // aggregateWeeklyBars expects FMP native DESCENDING order (doc.daily is stored descending)
    const weekly = aggregateWeeklyBars(doc.daily, { includeVolume: true });
    weeklyMap[ticker] = weekly;

    if (weekly.length >= EMA_PERIOD) {
      const closes = weekly.map(b => b.close);
      emaMap[ticker] = computeEMASeries(closes, EMA_PERIOD);
      rsiMap[ticker] = computeRSI(closes, 14);
    }
    atrMap[ticker] = computeWilderATR(weekly);
    tickerMeta[ticker] = {
      sector:      normSector(doc.sector || ''),
      exchange:    doc.exchange || '',
      companyName: doc.companyName || ticker,
    };
  }
  console.log(`  Loaded ${allTickers.length} tickers.\n`);

  // ── Pre-compute sector 5D and 1M returns per Friday ──────────────────────
  console.log('  Pre-computing sector returns per week...');
  const sectorReturns = {};  // friday → { ETF: { return5D, return1M } }

  for (const friday of fridays) {
    sectorReturns[friday] = {};
    for (const etf of ALL_SECTOR_ETFS) {
      const doc = allCandles.find(d => d.ticker === etf);
      if (!doc) continue;
      const daily = [...doc.daily].sort((a, b) => a.date > b.date ? 1 : -1);
      let fi = -1;
      for (let i = daily.length - 1; i >= 0; i--) {
        if (daily[i].date <= friday) { fi = i; break; }
      }
      if (fi < 22) continue;
      const cur   = daily[fi].close;
      const p5D   = daily[Math.max(fi - 5, 0)].close;
      const p1M   = daily[Math.max(fi - 21, 0)].close;
      if (p5D > 0 && p1M > 0) {
        sectorReturns[friday][etf] = {
          return5D: parseFloat(((cur - p5D) / p5D * 100).toFixed(2)),
          return1M: parseFloat(((cur - p1M) / p1M * 100).toFixed(2)),
        };
      }
    }
  }

  // ── Compute regime per Friday ────────────────────────────────────────────
  console.log('  Computing regime (SPY/QQQ EMA21) per Friday...\n');
  const regimeByWeek = {};

  for (const friday of fridays) {
    if (existingRegimeWeeks.has(friday)) {
      const doc = await regimeCol.findOne({ weekOf: friday });
      if (doc) regimeByWeek[friday] = doc;
      continue;
    }

    const regimeDoc = { weekOf: friday };

    for (const idx of ['SPY', 'QQQ']) {
      const weekly = weeklyMap[idx];
      const emas   = emaMap[idx];
      if (!weekly || !emas) { regimeDoc[idx.toLowerCase()] = null; continue; }

      const mon = new Date(friday + 'T12:00:00');
      mon.setDate(mon.getDate() - 4);
      const mondayStr = mon.toISOString().split('T')[0];
      const wi = weekly.findIndex(b => b.weekStart === mondayStr);
      if (wi < EMA_PERIOD + 1) { regimeDoc[idx.toLowerCase()] = null; continue; }

      const emaIdx  = wi - (EMA_PERIOD - 1);
      if (emaIdx < 1 || emaIdx >= emas.length) { regimeDoc[idx.toLowerCase()] = null; continue; }

      const ema     = emas[emaIdx];
      const emaPrev = emas[emaIdx - 1];
      const bar     = weekly[wi];
      const slope   = emaPrev !== 0 ? parseFloat(((ema - emaPrev) / emaPrev * 100).toFixed(4)) : 0;

      regimeDoc[idx.toLowerCase()] = {
        close:    bar.close,
        ema21:    parseFloat(ema.toFixed(4)),
        aboveEma: bar.close > ema,
        emaSlope: slope,
      };
    }

    regimeByWeek[friday] = regimeDoc;
  }

  // ── Pre-detect signals for all tickers (with signalAge) ──────────────────
  console.log('  Pre-detecting signals for all tickers...');
  const signalsByTicker = {};  // ticker → Map<fridayStr, { signal, entryPrice, stopPrice, signalAge }>

  let detectedCount = 0;
  for (const doc of allCandles) {
    if (sectorEtfSet.has(doc.ticker)) continue;
    const weekly = weeklyMap[doc.ticker];
    const atrArr = atrMap[doc.ticker];
    if (!weekly || weekly.length < EMA_PERIOD + 3) continue;
    signalsByTicker[doc.ticker] = detectSignals(weekly, EMA_PERIOD, atrArr);
    detectedCount++;
  }
  console.log(`  Signal detection complete for ${detectedCount} tickers.\n`);

  // ── Two-pass rank history (D5/D7) ────────────────────────────────────────
  // prevFinalRank[ticker] = rank from last week's FINAL ranked list
  // prevD5[ticker]        = D5 value from last week (for D7 velocity)
  const prevFinalRank = {};
  const prevD5Map     = {};

  // ── Build score records week-by-week ─────────────────────────────────────
  let totalScoresDocs = 0;
  let totalSignalDocs = 0;
  let totalRegimeDocs = 0;
  let totalBL = 0, totalSS = 0;
  const startTime = Date.now();

  console.log('─'.repeat(72));
  console.log(`  Processing ${fridays.length} weeks...\n`);

  const BATCH_WEEKS = 4;

  for (let fi = 0; fi < fridays.length; fi += BATCH_WEEKS) {
    const weekBatch  = fridays.slice(fi, fi + BATCH_WEEKS);
    const scoreBatch  = [];
    const signalBatch = [];
    const regimeBatch = [];

    for (const friday of weekBatch) {
      const sectorData = sectorReturns[friday] || {};

      // ── PASS 1: Compute base scores (D2+D3+D4+D6)×D1 + signal detection ──
      const pass1 = [];    // { ticker, signal, meta, weekBar, ema, emaPrev, rsi, d1, d2, d3, d4, d6, entryPrice, stopPrice, signalAge, overextended }

      for (const doc of allCandles) {
        const ticker = doc.ticker;
        if (sectorEtfSet.has(ticker)) continue;

        const weekly     = weeklyMap[ticker];
        const emas       = emaMap[ticker];
        const atrArr     = atrMap[ticker];
        const rsiSeries  = rsiMap[ticker];
        if (!weekly || !emas) continue;

        const mon = new Date(friday + 'T12:00:00');
        mon.setDate(mon.getDate() - 4);
        const mondayStr = mon.toISOString().split('T')[0];
        const wi = weekly.findIndex(b => b.weekStart === mondayStr);
        if (wi < EMA_PERIOD + 1) continue;

        const emaIdx = wi - (EMA_PERIOD - 1);
        if (emaIdx < 1 || emaIdx >= emas.length) continue;

        const ema      = emas[emaIdx];
        const emaPrev  = emas[emaIdx - 1];
        const weekBar  = weekly[wi];
        const rsi      = rsiSeries ? rsiSeries[wi] : null;
        const meta     = tickerMeta[ticker] || {};

        // Get signal (with age) from pre-detected map
        const sigData = signalsByTicker[ticker]?.get(friday) ?? null;
        if (!sigData || !sigData.signal) continue;

        const { signal, entryPrice, stopPrice, signalAge } = sigData;

        // D3 first (overextension gate)
        const d3 = calcD3(signal, weekBar, ema, emaPrev);
        if (d3.overextended) {
          pass1.push({ ticker, signal, meta, entryPrice, stopPrice, signalAge, overextended: true });
          continue;
        }

        const d1 = calcD1(signal, meta.exchange, regimeByWeek, friday);
        const d2 = calcD2(signal, meta.sector, sectorData);
        const d4 = calcD4(signalAge, d3.confirmation);
        const d6 = calcD6(signal, rsi);

        const baseScore = (d2 + d3.score + d4 + d6) * d1;

        pass1.push({
          ticker, signal, meta, weekBar, ema, emaPrev, rsi,
          d1, d2, d3, d4, d6,
          entryPrice, stopPrice, signalAge,
          overextended: false,
          baseScore,
        });
      }

      // ── Assign preliminary ranks (non-overextended, sorted by baseScore) ──
      const validPass1  = pass1.filter(s => !s.overextended);
      const oxPass1     = pass1.filter(s => s.overextended);
      validPass1.sort((a, b) => b.baseScore - a.baseScore);
      const prelimRankMap = {};
      validPass1.forEach((s, i) => { prelimRankMap[s.ticker] = i + 1; });

      // ── PASS 2: Compute D5, D7 → final scores ────────────────────────────
      const weekScores  = [];
      const weekSignals = [];
      const thisWeekD5  = {};   // store D5 values for NEXT week's D7

      // Overextended tickers — no score, no rank
      for (const s of oxPass1) {
        weekScores.push({
          weekOf:      friday,
          ticker:      s.ticker,
          signal:      s.signal,
          sector:      s.meta.sector,
          exchange:    s.meta.exchange,
          entryPrice:  s.entryPrice,
          stopPrice:   s.stopPrice,
          apexScore:   -99,
          killRank:    null,
          overextended: true,
          scores:       { d1: 1.0, d2: 0, d3: 0, d4: 0, d5: 0, d6: 0, d7: 0, d8: 0 },
          confirmation: 'OVEREXTENDED',
          signalAge:   s.signalAge,
          backfillVersion: BACKFILL_VER,
        });
      }

      // Valid tickers — full D1-D7 scoring
      for (const s of validPass1) {
        const curPrelim = prelimRankMap[s.ticker];
        const prevRank  = prevFinalRank[s.ticker] ?? null;
        const d5        = calcD5(prevRank, curPrelim);
        const prevD5Val = prevD5Map[s.ticker] ?? 0;
        const d7        = calcD7(d5, prevD5Val);

        thisWeekD5[s.ticker] = d5;   // save for next week's D7

        const finalScore = Math.round((s.d2 + s.d3.score + s.d4 + d5 + s.d6 + d7) * s.d1 * 10) / 10;

        weekScores.push({
          weekOf:      friday,
          ticker:      s.ticker,
          signal:      s.signal,
          sector:      s.meta.sector,
          exchange:    s.meta.exchange,
          entryPrice:  s.entryPrice,
          stopPrice:   s.stopPrice,
          apexScore:   finalScore,
          killRank:    null,   // assigned after sort below
          overextended: false,
          scores: {
            d1: s.d1,
            d2: s.d2,
            d3: s.d3.score,
            d4: s.d4,
            d5,
            d6: s.d6,
            d7,
            d8: 0,
          },
          confirmation: s.d3.confirmation,
          signalAge:   s.signalAge,
          backfillVersion: BACKFILL_VER,
        });

        // Signal record for pnthr_bt_analyze_signals
        weekSignals.push({
          weekOf:    friday,
          ticker:    s.ticker,
          signal:    s.signal,
          sector:    s.meta.sector,
          exchange:  s.meta.exchange,
          entryPrice: s.entryPrice,
          stopPrice:  s.stopPrice,
          analyzeComponents: {
            t1d: s.d2 > 0 ? 7 : 0,   // used by exportOrdersTrades sector EMA gate
          },
          signalAge: s.signalAge,
          backfillVersion: BACKFILL_VER,
        });
      }

      // ── Assign final kill ranks ───────────────────────────────────────────
      const nonOX = weekScores.filter(s => !s.overextended);
      nonOX.sort((a, b) => b.apexScore - a.apexScore);
      let rank = 0;
      for (const s of nonOX) {
        rank++;
        s.killRank = rank;
        prevFinalRank[s.ticker] = rank;   // store for next week's D5
      }

      // Update prevD5Map for next week's D7
      for (const [t, d5val] of Object.entries(thisWeekD5)) {
        prevD5Map[t] = d5val;
      }

      const blCount = weekScores.filter(s => s.signal === 'BL' && !s.overextended).length;
      const ssCount = weekScores.filter(s => s.signal === 'SS' && !s.overextended).length;
      const oxCount = weekScores.filter(s => s.overextended).length;

      process.stdout.write(
        `  ${friday}: ${weekScores.length} scores ` +
        `(BL: ${blCount}, SS: ${ssCount}, OX: ${oxCount})\n`
      );

      totalBL += blCount;
      totalSS += ssCount;
      scoreBatch.push(...weekScores);
      signalBatch.push(...weekSignals);

      // Regime record
      if (!existingRegimeWeeks.has(friday) && regimeByWeek[friday]) {
        regimeBatch.push(regimeByWeek[friday]);
      }
    }

    // ── Write batch to MongoDB ──────────────────────────────────────────────
    if (scoreBatch.length > 0) {
      await scoreCol.insertMany(scoreBatch, { ordered: false }).catch(() => {});
      totalScoresDocs += scoreBatch.length;
    }
    if (signalBatch.length > 0) {
      await signalCol.insertMany(signalBatch, { ordered: false }).catch(() => {});
      totalSignalDocs += signalBatch.length;
    }
    if (regimeBatch.length > 0) {
      await regimeCol.insertMany(regimeBatch, { ordered: false }).catch(() => {});
      totalRegimeDocs += regimeBatch.length;
    }
  }

  // ── Create indexes ────────────────────────────────────────────────────────
  console.log('\n  Ensuring collection indexes...');
  await scoreCol.createIndex({ weekOf: 1, apexScore: -1 }).catch(() => {});
  await signalCol.createIndex({ weekOf: 1 }).catch(() => {});
  await regimeCol.createIndex({ weekOf: 1 }).catch(() => {});

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n' + '═'.repeat(72));
  console.log('  BACKFILL COMPLETE');
  console.log('═'.repeat(72));
  console.log(`  Runtime:        ${elapsed}s`);
  console.log(`  Score records:  ${totalScoresDocs.toLocaleString()} added to pnthr_bt_scores`);
  console.log(`  Signal records: ${totalSignalDocs.toLocaleString()} added to pnthr_bt_analyze_signals`);
  console.log(`  Regime records: ${totalRegimeDocs.toLocaleString()} added to pnthr_bt_regime`);
  console.log(`  BL signals:     ${totalBL.toLocaleString()}`);
  console.log(`  SS signals:     ${totalSS.toLocaleString()}`);

  // ── Verify data coverage ──────────────────────────────────────────────────
  const firstScore = await scoreCol.find({}, { projection: { weekOf: 1 } })
    .sort({ weekOf: 1 }).limit(1).toArray();
  const lastScore = await scoreCol.find({}, { projection: { weekOf: 1 } })
    .sort({ weekOf: -1 }).limit(1).toArray();
  const totalInCollection = await scoreCol.countDocuments();

  console.log(`\n  pnthr_bt_scores now covers: ${firstScore[0]?.weekOf} → ${lastScore[0]?.weekOf}`);
  console.log(`  Total records in collection: ${totalInCollection.toLocaleString()}`);

  // ── March 2020 COVID crash verification ───────────────────────────────────
  console.log('\n  MARCH 2020 COVERAGE VERIFICATION');
  console.log('  ' + '─'.repeat(50));
  const marchWeeks = ['2020-02-21', '2020-02-28', '2020-03-06', '2020-03-13', '2020-03-20', '2020-03-27'];
  for (const w of marchWeeks) {
    const cnt  = await scoreCol.countDocuments({ weekOf: w });
    const blW  = await scoreCol.countDocuments({ weekOf: w, signal: 'BL' });
    const ssW  = await scoreCol.countDocuments({ weekOf: w, signal: 'SS' });
    const note = (w === '2020-03-13' || w === '2020-03-20') ? ' ← COVID crash week' : '';
    console.log(`  ${w}: ${cnt} records (BL: ${blW}, SS: ${ssW})${note}`);
  }

  console.log('\n' + '═'.repeat(72));
  console.log('  NEXT STEPS — Run in this exact order:');
  console.log('  1. node backtest/exportPyramidOrders.js');
  console.log('     Full pyramid backtest (35/25/20/12/8% lots, all gates, per-lot costs)');
  console.log('     Outputs: pnthr_bt_pyramid_trade_log');
  console.log('');
  console.log('  2. node backtest/computeHedgeFundMetrics.js');
  console.log('     Computes institutional metrics for both single-lot and pyramid');
  console.log('');
  console.log('  3. node backtest/exportAuditLog.js');
  console.log('     Updates investor-grade audit log');
  console.log('═'.repeat(72) + '\n');

  process.exit(0);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  console.error(err.stack);
  process.exit(1);
});
