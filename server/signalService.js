import dotenv from 'dotenv';
dotenv.config();

import { computeWilderATR, blInitStop, ssInitStop } from './stopCalculation.js';
import { getLastFriday, aggregateWeeklyBars } from './technicalUtils.js';
import { getSectorEmaPeriod, DEFAULT_EMA_PERIOD } from './sectorEmaConfig.js';

// ── PNTHR Phase 1 Signal Engine ───────────────────────────────────────────────
//
// Generates BL (Buy Long) and SS (Sell Short) signals using sector-optimized
// EMA periods. Each sector uses its empirically optimal EMA (18-26 weeks).
// See sectorEmaConfig.js for the per-sector period map.
//
// BL (Buy Long):
//   • Weekly close > sector EMA, slope up
//   • Weekly close > highest high of the prior 2 completed weeks + $0.01
//   → Stop: lowest low of the prior 2 completed weeks − $0.01
//
// SS (Sell Short):
//   • Weekly close < sector EMA, slope down
//   • Weekly close < lowest low of the prior 2 completed weeks − $0.01
//   → Stop: highest high of the prior 2 completed weeks + $0.01
//
// Results are cached weekly (invalidates each new Friday).
// Return format is backward-compatible with the old getLatestSignals() shape.
// ─────────────────────────────────────────────────────────────────────────────

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';

// 5-year window matches the chart's data range so server and client state machines
// traverse the same BL/BE cycles and produce consistent signals.
const WEEKS_HISTORY = 260;

// Weekly cache keyed by today's date string
// Two separate caches: stocks use 1% daylight zone, ETFs use 0.3%
let signalCache    = { weekKey: null, signals: {} };
let etfSignalCache = { weekKey: null, signals: {} };

// ── Helpers ───────────────────────────────────────────────────────────────────
// getLastFriday() and aggregateWeeklyBars() imported from technicalUtils.js

function getToday() {
  return new Date().toISOString().split('T')[0];
}

async function fetchDailyBars(ticker, from) {
  // No &to= parameter — matches /api/chart/:ticker exactly so both code paths
  // get identical FMP data → identical weekly bars → identical PNTHR Stop.
  const url = `${FMP_BASE_URL}/historical-price-full/${ticker}?from=${from}&apikey=${FMP_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP ${res.status}`);
  const data = await res.json();
  return data?.historical || [];
}

// Compute EMA series from an array of closes.
// Returns values aligned to closes starting at index (period − 1).
// Length = closes.length − period + 1
function computeEMASeries(closes, period) {
  if (closes.length < period) return [];
  const mult = 2 / (period + 1);
  // Seed: simple average of the first `period` closes
  let ema = closes.slice(0, period).reduce((s, c) => s + c, 0) / period;
  const emas = [ema];
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * mult + ema * (1 - mult);
    emas.push(ema);
  }
  return emas;
}

// Run full state machine over all completed weekly bars to find the most recent signal event.
// Mirrors the client's detectAllSignals logic — returns BL/SS entries and BE/SE exits.
//
// emaPeriod: sector-specific EMA period (default from sectorEmaConfig).
// BL (Launch): weekLow is 1–10% above EMA, within first 3 bars of long-daylight streak.
// SS (Failure): weekHigh is 1–10% below EMA, within first 3 bars of short-daylight streak.
// Phase 5 exit: structural 2-week low/high breach.
function runStateMachine(weeklyBars, isETF = false, emaPeriod = DEFAULT_EMA_PERIOD) {
  if (weeklyBars.length < emaPeriod + 2) {
    return { signal: null, ema21: null, stopPrice: null, emaPeriod };
  }

  const closes = weeklyBars.map(b => b.close);
  const emas   = computeEMASeries(closes, emaPeriod);
  if (emas.length < 2) return { signal: null, ema21: null, stopPrice: null, currentWeekStop: null, emaPeriod };
  const atrArr = computeWilderATR(weeklyBars);

  // emas[i] aligns to weeklyBars[i + (period - 1)]
  const emaOffset = emaPeriod - 1;

  let position         = null;  // { type: 'BL'|'SS', entryWi: number }
  let lastEvent        = null;  // most recent emitted event
  let longDaylight     = 0;    // consecutive bars where weekLow > EMA
  let shortDaylight    = 0;    // consecutive bars where weekHigh < EMA
  // longTrendActive: true after BL or SE fires; expires only when SS fires.
  // shortTrendActive: true after SS or BE fires; expires only when BL fires.
  // Price position relative to EMA does NOT reset these flags — only a confirmed
  // entry in the opposite direction does.
  // longTrendCapped: 25% daylight cap for BL re-entry only when switching sides (SE→BL).
  //   Same-side re-entry (BL→BE→BL) has no cap — it is trend continuation.
  // shortTrendCapped: symmetric for short.
  let longTrendActive  = false;
  let longTrendCapped  = false;
  let shortTrendActive = false;
  let shortTrendCapped = false;

  for (let wi = emaPeriod + 1; wi < weeklyBars.length; wi++) {
    const emaIdx = wi - emaOffset;
    if (emaIdx < 1) continue;

    const current     = weeklyBars[wi];
    const prev1       = weeklyBars[wi - 1];
    const prev2       = weeklyBars[wi - 2];
    const emaCurrent  = emas[emaIdx];
    const twoWeekHigh = Math.max(prev1.high, prev2.high);
    const twoWeekLow  = Math.min(prev1.low,  prev2.low);

    // Update daylight streak counters.
    longDaylight  = current.low  > emaCurrent ? longDaylight + 1 : 0;
    shortDaylight = current.high < emaCurrent ? shortDaylight + 1 : 0;

    // Past entry week: update PNTHR stop (ratchet), then check for BE/SE exit
    if (position && position.entryWi !== wi) {
      const prevAtr = atrArr[wi - 1];
      if (prevAtr != null) {
        if (position.type === 'BL') {
          const structStop = parseFloat((twoWeekLow - 0.01).toFixed(2));
          const atrFloor   = parseFloat((prev1.close - prevAtr).toFixed(2));
          const candidate  = Math.max(structStop, atrFloor);
          position.pnthrStop = parseFloat(Math.max(position.pnthrStop, candidate).toFixed(2));
        } else {
          const structStop  = parseFloat((twoWeekHigh + 0.01).toFixed(2));
          const atrCeiling  = parseFloat((prev1.close + prevAtr).toFixed(2));
          const candidate   = Math.min(structStop, atrCeiling);
          position.pnthrStop = parseFloat(Math.min(position.pnthrStop, candidate).toFixed(2));
        }
      }
      // BE: this week's low breaks below the 2-week structural low
      // SE: this week's high breaks above the 2-week structural high
      if (position.type === 'BL') {
        if (current.low < twoWeekLow) {
          const exitPrice   = position.pnthrStop;
          const profitDollar = parseFloat((exitPrice - position.entryPrice).toFixed(2));
          const profitPct    = parseFloat(((profitDollar / position.entryPrice) * 100).toFixed(2));
          lastEvent = { signal: 'BE', signalDate: current.weekStart, ema21: parseFloat(emaCurrent.toFixed(4)), stopPrice: null, profitDollar, profitPct };
          shortTrendActive = true;
          shortTrendCapped = true;   // SS after BE = opposite side → 25% cap applies
          position = null; continue;
        }
      } else {
        if (current.high > twoWeekHigh) {
          const exitPrice    = position.pnthrStop;
          const profitDollar = parseFloat((position.entryPrice - exitPrice).toFixed(2));
          const profitPct    = parseFloat(((profitDollar / position.entryPrice) * 100).toFixed(2));
          lastEvent = { signal: 'SE', signalDate: current.weekStart, ema21: parseFloat(emaCurrent.toFixed(4)), stopPrice: null, profitDollar, profitPct };
          longTrendActive = true;
          longTrendCapped = true;    // BL after SE = opposite side → 25% cap applies
          position = null; continue;
        }
      }
    }

    if (!position) {
      const emaPrev = emas[emaIdx - 1];
      const blPhase1 = current.close > emaCurrent && emaCurrent > emaPrev && current.high >= twoWeekHigh + 0.01;
      const ssPhase1 = current.close < emaCurrent && emaCurrent < emaPrev && current.low  <= twoWeekLow  - 0.01;
      // ETFs use a tighter 0.3% daylight zone (vs 1% for stocks) so signals fire sooner
      const dPct = isETF ? 0.003 : 0.01;
      const blZone   = current.low  >= emaCurrent * (1 + dPct) && current.low  <= emaCurrent * 1.10;
      const ssZone   = current.high <= emaCurrent * (1 - dPct) && current.high >= emaCurrent * 0.90;

      const blReentry    = longTrendActive  && current.low  >= emaCurrent * (1 + dPct) && (!longTrendCapped  || current.low  <= emaCurrent * 1.25);
      const ssReentry    = shortTrendActive && current.high <= emaCurrent * (1 - dPct) && (!shortTrendCapped || current.high >= emaCurrent * 0.75);
      const blDaylightOk = blReentry || (blZone && longDaylight  >= 1 && longDaylight  <= 3);
      const ssDaylightOk = ssReentry || (ssZone && shortDaylight >= 1 && shortDaylight <= 3);

      if (blPhase1 && blDaylightOk) {
        const initStop = blInitStop(twoWeekLow, current.close, atrArr[wi]);
        lastEvent = { signal: 'BL', signalDate: current.weekStart, ema21: parseFloat(emaCurrent.toFixed(4)), stopPrice: initStop };
        position         = { type: 'BL', entryWi: wi, pnthrStop: initStop, entryPrice: parseFloat((twoWeekHigh + 0.01).toFixed(2)) };
        longTrendActive  = true;
        longTrendCapped  = false; // same-side — future BE→BL re-entry has no cap
        shortTrendActive = false;
        shortTrendCapped = false;
      } else if (ssPhase1 && ssDaylightOk) {
        const initStop = ssInitStop(twoWeekHigh, current.close, atrArr[wi]);
        lastEvent = { signal: 'SS', signalDate: current.weekStart, ema21: parseFloat(emaCurrent.toFixed(4)), stopPrice: initStop };
        position         = { type: 'SS', entryWi: wi, pnthrStop: initStop, entryPrice: parseFloat((twoWeekLow - 0.01).toFixed(2)) };
        shortTrendActive = true;
        shortTrendCapped = false; // same-side — future SE→SS re-entry has no cap
        longTrendActive  = false;
        longTrendCapped  = false;
      }
    }
  }

  // EMA slope direction + magnitude
  const emaRising = emas.length >= 2 ? emas[emas.length - 1] > emas[emas.length - 2] : null;
  const emaSlope  = emas.length >= 2
    ? parseFloat(((emas[emas.length - 1] - emas[emas.length - 2]) / emas[emas.length - 2] * 100).toFixed(4))
    : null; // % change in EMA week-over-week (positive = rising, negative = falling)

  // Last completed weekly bar (n-2 relative to current in-progress bar at n-1)
  // Used by developing-signals to check proximity to last week's high/low.
  const n = weeklyBars.length;
  const prevWeekBar   = n >= 2 ? weeklyBars[n - 2] : null;
  const lastWeekHigh  = prevWeekBar ? +prevWeekBar.high.toFixed(4)  : null;
  const lastWeekLow   = prevWeekBar ? +prevWeekBar.low.toFixed(4)   : null;
  const lastWeekClose = prevWeekBar ? +prevWeekBar.close.toFixed(4) : null; // proxy for week open

  if (!lastEvent) {
    const lastEma = emas[emas.length - 1];
    return { signal: null, ema21: parseFloat(lastEma.toFixed(4)), stopPrice: null, currentWeekStop: null,
             emaRising, emaSlope, lastWeekHigh, lastWeekLow, lastWeekClose, emaPeriod };
  }

  const lastBar = weeklyBars[weeklyBars.length - 1];

  // If still in an open position, attach live stop prices to the signal event
  if (position) {
    lastEvent.pnthrStop = position.pnthrStop;
    lastEvent.stopPrice = position.pnthrStop; // backward-compat alias
    lastEvent.currentWeekStop = position.type === 'BL'
      ? parseFloat((lastBar.low  - 0.01).toFixed(2))
      : parseFloat((lastBar.high + 0.01).toFixed(2));
  }

  // NEW signal = BL or SS that fired on the very last (rightmost) completed bar
  const isActiveSignal = lastEvent.signal === 'BL' || lastEvent.signal === 'SS';
  lastEvent.isNew = isActiveSignal && lastEvent.signalDate === lastBar.weekStart;
  lastEvent.emaRising    = emaRising;
  lastEvent.emaSlope     = emaSlope;
  lastEvent.lastWeekHigh  = lastWeekHigh;
  lastEvent.lastWeekLow   = lastWeekLow;
  lastEvent.lastWeekClose = lastWeekClose;
  lastEvent.emaPeriod     = emaPeriod;

  return lastEvent;
}

export { runStateMachine };

// ── Signal cache snapshot (for Pulse sector counts) ────────────────────────────
// Returns the in-memory signal cache as-is. May be partially populated
// (only tickers requested today). Used by the Pulse endpoint to get real-time
// signal states without triggering a full 679-stock fetch.
export function getSignalCacheSnapshot() {
  return signalCache.signals || {};
}

// ── Public API ────────────────────────────────────────────────────────────────

// Returns a signal map backward-compatible with the old getLatestSignals() shape,
// with stopPrice already included (no separate calculateStopPrices() call needed).
//
// { [ticker]: { signal: 'BUY'|'SELL'|null, stopPrice: number|null,
//               isNewSignal: false, profitPercentage: null, ema21: number|null,
//               emaPeriod: number } }
//
// BL → 'BUY', SS → 'SELL' to keep existing UI labels working.
//
// Options:
//   isETF:     use 0.3% daylight zone (vs 1% for stocks)
//   sectorMap: { TICKER: 'SectorName', ... } — for sector-specific EMA periods.
//              Tickers not in sectorMap use DEFAULT_EMA_PERIOD (21).
export async function getSignals(tickers, { isETF = false, sectorMap = {} } = {}) {
  if (!tickers || tickers.length === 0) return {};

  const today = getToday();

  // ETF signals use a separate cache (different daylight threshold)
  const cache = isETF ? etfSignalCache : signalCache;

  // Invalidate cache daily so intra-week bars (Mon–Thu) are picked up for NEW signal detection
  if (cache.weekKey !== today) {
    if (isETF) etfSignalCache = { weekKey: today, signals: {} };
    else        signalCache   = { weekKey: today, signals: {} };
  }

  const activeCache = isETF ? etfSignalCache : signalCache;

  // Check for tickers that need recomputing: either missing from cache,
  // or cached with a different EMA period than the sector now requires
  const missing = tickers.filter(t => {
    const cached = activeCache.signals[t];
    if (!cached) return true;
    // If sector info is provided, check that the cached period matches
    const sector = sectorMap[t];
    if (sector) {
      const requiredPeriod = getSectorEmaPeriod(sector);
      if (cached.emaPeriod && cached.emaPeriod !== requiredPeriod) return true;
    }
    return false;
  });

  if (missing.length > 0) {
    // Fetch through today so the current in-progress weekly bar is included.
    // isNew = true only when a BL/SS fires on that last (current-week) bar.
    const toDate  = today;
    // Use today − 5 years (same as /api/chart/:ticker) so server and client
    // always start from the same daily bars → identical EMA seed → identical stop.
    const fromD   = new Date();
    fromD.setFullYear(fromD.getFullYear() - 5);
    const fromDate = fromD.toISOString().split('T')[0];

    console.log(`📡 EMA signals${isETF ? ' (ETF)' : ''}: computing ${missing.length} tickers (${fromDate} → ${toDate})...`);

    const concurrency = 5;
    for (let i = 0; i < missing.length; i += concurrency) {
      const chunk = missing.slice(i, i + concurrency);
      await Promise.all(chunk.map(async (ticker) => {
        try {
          const daily  = await fetchDailyBars(ticker, fromDate);
          const weekly = aggregateWeeklyBars(daily);
          const sector = sectorMap[ticker];
          const emaPeriod = sector ? getSectorEmaPeriod(sector) : DEFAULT_EMA_PERIOD;
          activeCache.signals[ticker] = runStateMachine(weekly, isETF, emaPeriod);
        } catch (err) {
          console.error(`Signal error for ${ticker}:`, err.message);
          activeCache.signals[ticker] = { signal: null, ema21: null, stopPrice: null, emaPeriod: DEFAULT_EMA_PERIOD };
        }
      }));
      if (i + concurrency < missing.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    const activeCount = Object.values(activeCache.signals).filter(s => s.signal).length;
    console.log(`📡 EMA signals done: ${activeCount} active (BL/SS) out of ${Object.keys(activeCache.signals).length} tickers`);
  }

  // Build return map in the format the rest of the app expects
  const result = {};
  for (const ticker of tickers) {
    const s = activeCache.signals[ticker] || { signal: null, ema21: null, stopPrice: null, emaPeriod: DEFAULT_EMA_PERIOD };
    result[ticker] = {
      signal:           s.signal, // 'BL', 'SS', 'BE', 'SE', or null
      stopPrice:        s.pnthrStop ?? s.stopPrice ?? null,
      pnthrStop:        s.pnthrStop ?? null,
      currentWeekStop:  s.currentWeekStop ?? null,
      ema21:            s.ema21,
      emaPeriod:        s.emaPeriod ?? DEFAULT_EMA_PERIOD,
      emaRising:        s.emaRising      ?? null, // true/false/null — EMA slope direction
      emaSlope:         s.emaSlope       ?? null, // % change in EMA week-over-week
      lastWeekHigh:     s.lastWeekHigh   ?? null, // previous completed week's high
      lastWeekLow:      s.lastWeekLow    ?? null, // previous completed week's low
      lastWeekClose:    s.lastWeekClose  ?? null, // previous completed week's close
      signalDate:       s.signalDate || null, // YYYY-MM-DD (Monday of signal week)
      isNewSignal:      s.isNew ?? false,
      profitPercentage: null,
      profitDollar:     s.profitDollar ?? null,
      profitPct:        s.profitPct    ?? null,
    };
  }
  return result;
}

// Return the already-computed signals from the in-memory cache without triggering
// any FMP API calls. Returns null if the cache is empty (server is cold).
// The snapshot endpoint uses this so "Save This Week" is instant when the Jungle
// page has already been visited in this server session.
export function getCachedSignals() {
  const today = getToday();
  if (signalCache.weekKey !== today) return null; // cache is stale or empty
  const count = Object.keys(signalCache.signals).length;
  if (count === 0) return null;
  // Build the same shape as getSignals() returns
  const result = {};
  for (const [ticker, s] of Object.entries(signalCache.signals)) {
    result[ticker] = {
      signal:          s.signal,
      stopPrice:       s.pnthrStop ?? s.stopPrice ?? null,
      pnthrStop:       s.pnthrStop ?? null,
      currentWeekStop: s.currentWeekStop ?? null,
      ema21:           s.ema21,
      emaPeriod:       s.emaPeriod ?? DEFAULT_EMA_PERIOD,
      emaRising:       s.emaRising      ?? null,
      emaSlope:        s.emaSlope       ?? null,
      lastWeekHigh:    s.lastWeekHigh   ?? null,
      lastWeekLow:     s.lastWeekLow    ?? null,
      lastWeekClose:   s.lastWeekClose  ?? null,
      signalDate:      s.signalDate || null,
      isNewSignal:     s.isNew ?? false,
      profitDollar:    s.profitDollar ?? null,
      profitPct:       s.profitPct    ?? null,
    };
  }
  return result;
}

/**
 * Return a Map of tickers currently showing developing signal characteristics.
 * Keys are uppercase ticker strings, values are the developing direction ('BL' or 'SS').
 * Uses the in-memory signal cache — no FMP calls, synchronous, safe to call at confirm time.
 */
export function getDevelopingSignalTickers() {
  const signalMap = getCachedSignals();
  if (!signalMap) return new Map();
  const tickers = new Map();
  for (const [ticker, s] of Object.entries(signalMap)) {
    if (s.signal !== 'BL' && s.emaRising === true && s.lastWeekHigh != null) {
      tickers.set(ticker.toUpperCase(), 'BL');
    }
    if (s.signal !== 'SS' && s.emaRising === false && s.lastWeekLow != null) {
      tickers.set(ticker.toUpperCase(), 'SS');
    }
  }
  return tickers;
}

// Force-clear signal cache so next getSignals() call recomputes with latest code.
export function clearSignalCache() {
  signalCache    = { weekKey: null, signals: {} };
  etfSignalCache = { weekKey: null, signals: {} };
  console.log('[signalService] Cache cleared — will recompute on next getSignals() call');
}
