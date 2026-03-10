import dotenv from 'dotenv';
dotenv.config();

// ── PNTHR Phase 1 Signal Engine ───────────────────────────────────────────────
//
// Generates BL (Buy Long) and SS (Sell Short) signals from 21-week EMA logic.
// All computations are from FMP weekly price data — no external signal database needed.
//
// BL (Buy Long):
//   • Weekly close > 21-week EMA
//   • Current EMA > Previous EMA  (slope positive)
//   • Weekly close > highest high of the prior 2 completed weeks + $0.01
//   → Stop: lowest low of the prior 2 completed weeks − $0.01
//
// SS (Sell Short):
//   • Weekly close < 21-week EMA
//   • Current EMA < Previous EMA  (slope negative)
//   • Weekly close < lowest low of the prior 2 completed weeks − $0.01
//   → Stop: highest high of the prior 2 completed weeks + $0.01
//
// Results are cached weekly (invalidates each new Friday).
// Return format is backward-compatible with the old getLatestSignals() shape.
// ─────────────────────────────────────────────────────────────────────────────

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';

const EMA_PERIOD = 21;
// 5-year window matches the chart's data range so server and client state machines
// traverse the same BL/BE cycles and produce consistent signals.
const WEEKS_HISTORY = 260;

// Weekly cache keyed by last-Friday date string
let signalCache = { weekKey: null, signals: {} };

// ── Helpers ───────────────────────────────────────────────────────────────────

function getLastFriday() {
  const today = new Date();
  const dow = today.getDay(); // 0=Sun … 6=Sat
  const daysBack = dow === 5 ? 0 : (dow + 2) % 7;
  const d = new Date(today);
  d.setDate(today.getDate() - daysBack);
  return d.toISOString().split('T')[0];
}

async function fetchDailyBars(ticker, from, to) {
  const url = `${FMP_BASE_URL}/historical-price-full/${ticker}?from=${from}&to=${to}&apikey=${FMP_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP ${res.status}`);
  const data = await res.json();
  return data?.historical || [];
}

// Aggregate FMP daily bars (descending) into weekly bars sorted ascending.
// Each weekly bar spans Mon–Fri:
//   open  = Monday's open  (or first trading day of that week)
//   high  = highest high across the week
//   low   = lowest low across the week
//   close = Friday's close (or last trading day of that week)
function aggregateWeeklyBars(daily) {
  const weekMap = {};

  // FMP returns descending; iterate all bars building weekly aggregates
  for (const bar of daily) {
    const date = new Date(bar.date + 'T12:00:00');
    const dow = date.getDay();
    const daysToMonday = dow === 0 ? -6 : 1 - dow;
    const monday = new Date(date);
    monday.setDate(date.getDate() + daysToMonday);
    const key = monday.toISOString().split('T')[0];

    if (!weekMap[key]) {
      weekMap[key] = { weekStart: key, open: null, high: -Infinity, low: Infinity, close: null };
    }
    const w = weekMap[key];
    w.high = Math.max(w.high, bar.high);
    w.low  = Math.min(w.low,  bar.low);
    // First-seen = latest day of week → Friday close
    if (w.close === null) w.close = bar.close;
    // Last-seen  = earliest day of week → Monday open
    w.open = bar.open;
  }

  return Object.values(weekMap).sort((a, b) => (a.weekStart > b.weekStart ? 1 : -1));
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
// BL (Launch): weekLow is 1–10% above 21-EMA, within first 3 bars of long-daylight streak
//              (current or previous bar is the 1st or 2nd bar where low > EMA).
// SS (Failure): weekHigh is 1–10% below 21-EMA, within first 3 bars of short-daylight streak.
// Phase 5 exit: structural 2-week low/high + 0.1% predatory buffer, trigger on weekly close.
function runStateMachine(weeklyBars) {
  if (weeklyBars.length < EMA_PERIOD + 2) {
    return { signal: null, ema21: null, stopPrice: null };
  }

  const closes = weeklyBars.map(b => b.close);
  const emas   = computeEMASeries(closes, EMA_PERIOD);
  if (emas.length < 2) return { signal: null, ema21: null, stopPrice: null };

  // emas[i] aligns to weeklyBars[i + (period - 1)]
  const emaOffset = EMA_PERIOD - 1;

  let position         = null;  // { type: 'BL'|'SS', entryWi: number }
  let lastEvent        = null;  // most recent emitted event
  let longDaylight     = 0;    // consecutive bars where weekLow > EMA
  let shortDaylight    = 0;    // consecutive bars where weekHigh < EMA
  let longTrendActive  = false; // true after first BL fires; allows re-entry with Phase 1 only (no daylight zone) while price stays above EMA
  let shortTrendActive = false; // true after first SS fires; allows re-entry with Phase 1 only while price stays below EMA

  for (let wi = EMA_PERIOD + 1; wi < weeklyBars.length; wi++) {
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

    // Reset trend flags whenever there is no active position and the weekly close
    // crosses to the wrong side of the EMA. Once price closes below the EMA
    // (with no open position), the established long trend is considered broken
    // and the next BL entry requires the full 4-condition check including daylight zone.
    if (!position && current.close < emaCurrent) longTrendActive  = false;
    if (!position && current.close > emaCurrent) shortTrendActive = false;

    // Past entry week: check for BE/SE exit
    // BE: this week's low breaks below the 2-week structural low
    // SE: this week's high breaks above the 2-week structural high
    if (position && position.entryWi !== wi) {
      if (position.type === 'BL') {
        if (current.low < twoWeekLow) {
          lastEvent = { signal: 'BE', signalDate: current.weekStart, ema21: parseFloat(emaCurrent.toFixed(4)), stopPrice: null };
          position = null; continue;
        }
      } else {
        if (current.high > twoWeekHigh) {
          lastEvent = { signal: 'SE', signalDate: current.weekStart, ema21: parseFloat(emaCurrent.toFixed(4)), stopPrice: null };
          position = null; continue;
        }
      }
    }

    // BL (Launch): Phase 1 + daylight zone required for first entry in a trend.
    // Once longTrendActive, only Phase 1 needed (price stayed above EMA after prior BL/BE).
    // SS (Failure): symmetric.
    if (!position) {
      const emaPrev = emas[emaIdx - 1];
      const blPhase1 = current.close > emaCurrent && emaCurrent > emaPrev && current.high >= twoWeekHigh + 0.01;
      const ssPhase1 = current.close < emaCurrent && emaCurrent < emaPrev && current.low  <= twoWeekLow  - 0.01;
      const blZone   = current.low  >= emaCurrent * 1.01 && current.low  <= emaCurrent * 1.10;
      const ssZone   = current.high <= emaCurrent * 0.99 && current.high >= emaCurrent * 0.90;

      // Daylight required for first entry: low must be strictly above EMA (longDaylight >= 1) and in the 1–10% zone.
      // Once longTrendActive (after first BL), re-entries only need Phase 1 — no daylight zone required.
      const blDaylightOk = longTrendActive || (blZone && longDaylight >= 1 && longDaylight <= 3);
      const ssDaylightOk = shortTrendActive || (ssZone && shortDaylight >= 1 && shortDaylight <= 3);

      if (blPhase1 && blDaylightOk) {
        const stopPrice = parseFloat((twoWeekLow - 0.01).toFixed(2));
        lastEvent = { signal: 'BL', signalDate: current.weekStart, ema21: parseFloat(emaCurrent.toFixed(4)), stopPrice };
        position  = { type: 'BL', entryWi: wi };
        longTrendActive = true;
      } else if (ssPhase1 && ssDaylightOk) {
        const stopPrice = parseFloat((twoWeekHigh + 0.01).toFixed(2));
        lastEvent = { signal: 'SS', signalDate: current.weekStart, ema21: parseFloat(emaCurrent.toFixed(4)), stopPrice };
        position  = { type: 'SS', entryWi: wi };
        shortTrendActive = true;
      }
    }
  }

  if (!lastEvent) {
    const lastEma = emas[emas.length - 1];
    return { signal: null, ema21: parseFloat(lastEma.toFixed(4)), stopPrice: null };
  }

  return lastEvent;
}

// ── Public API ────────────────────────────────────────────────────────────────

// Returns a signal map backward-compatible with the old getLatestSignals() shape,
// with stopPrice already included (no separate calculateStopPrices() call needed).
//
// { [ticker]: { signal: 'BUY'|'SELL'|null, stopPrice: number|null,
//               isNewSignal: false, profitPercentage: null, ema21: number|null } }
//
// BL → 'BUY', SS → 'SELL' to keep existing UI labels working.
export async function getSignals(tickers) {
  if (!tickers || tickers.length === 0) return {};

  const weekKey = getLastFriday();

  // Invalidate cache when week rolls over
  if (signalCache.weekKey !== weekKey) {
    signalCache = { weekKey, signals: {} };
  }

  const missing = tickers.filter(t => !(t in signalCache.signals));

  if (missing.length > 0) {
    const toDate  = weekKey;
    const fromD   = new Date(weekKey);
    fromD.setDate(fromD.getDate() - WEEKS_HISTORY * 7);
    const fromDate = fromD.toISOString().split('T')[0];

    console.log(`📡 EMA signals: computing ${missing.length} tickers (${fromDate} → ${toDate})...`);

    const concurrency = 5;
    for (let i = 0; i < missing.length; i += concurrency) {
      const chunk = missing.slice(i, i + concurrency);
      await Promise.all(chunk.map(async (ticker) => {
        try {
          const daily  = await fetchDailyBars(ticker, fromDate, toDate);
          const weekly = aggregateWeeklyBars(daily);
          signalCache.signals[ticker] = runStateMachine(weekly);
        } catch (err) {
          console.error(`Signal error for ${ticker}:`, err.message);
          signalCache.signals[ticker] = { signal: null, ema21: null, stopPrice: null };
        }
      }));
      if (i + concurrency < missing.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    const activeCount = Object.values(signalCache.signals).filter(s => s.signal).length;
    console.log(`📡 EMA signals done: ${activeCount} active (BL/SS) out of ${Object.keys(signalCache.signals).length} tickers`);
  }

  // Build return map in the format the rest of the app expects
  const result = {};
  for (const ticker of tickers) {
    const s = signalCache.signals[ticker] || { signal: null, ema21: null, stopPrice: null };
    result[ticker] = {
      signal:           s.signal, // 'BL', 'SS', 'BE', 'SE', or null
      stopPrice:        s.stopPrice,
      ema21:            s.ema21,
      signalDate:       s.signalDate || null, // YYYY-MM-DD (Monday of signal week)
      isNewSignal:      false,
      profitPercentage: null,
    };
  }
  return result;
}
