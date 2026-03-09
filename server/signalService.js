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
// 2.5× EMA period gives reliable EMA values; +2 weeks for breakout lookback
const WEEKS_HISTORY = 55;

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

// Derive BL/SS signal from completed weekly bars.
// Uses bars[-1] as "current week", bars[-2] and bars[-3] as "prior 2 weeks".
function computeSignal(weeklyBars) {
  if (weeklyBars.length < EMA_PERIOD + 2) {
    return { signal: null, ema21: null, stopPrice: null };
  }

  const closes = weeklyBars.map(b => b.close);
  const emas   = computeEMASeries(closes, EMA_PERIOD);
  if (emas.length < 2) return { signal: null, ema21: null, stopPrice: null };

  const emaCurrent = emas[emas.length - 1];
  const emaPrev    = emas[emas.length - 2];

  const current = weeklyBars[weeklyBars.length - 1]; // last completed week
  const prev1   = weeklyBars[weeklyBars.length - 2]; // one week prior
  const prev2   = weeklyBars[weeklyBars.length - 3]; // two weeks prior

  const slopeUp   = emaCurrent > emaPrev;
  const slopeDown = emaCurrent < emaPrev;

  const twoWeekHigh = Math.max(prev1.high, prev2.high);
  const twoWeekLow  = Math.min(prev1.low,  prev2.low);

  // BL: above EMA, slope rising, close breaks above 2-week high
  if (current.close > emaCurrent && slopeUp && current.close > twoWeekHigh + 0.01) {
    return {
      signal:    'BL',
      ema21:     parseFloat(emaCurrent.toFixed(4)),
      stopPrice: parseFloat((twoWeekLow - 0.01).toFixed(2)),
    };
  }

  // SS: below EMA, slope falling, close breaks below 2-week low
  if (current.close < emaCurrent && slopeDown && current.close < twoWeekLow - 0.01) {
    return {
      signal:    'SS',
      ema21:     parseFloat(emaCurrent.toFixed(4)),
      stopPrice: parseFloat((twoWeekHigh + 0.01).toFixed(2)),
    };
  }

  return {
    signal:    null,
    ema21:     parseFloat(emaCurrent.toFixed(4)),
    stopPrice: null,
  };
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
          signalCache.signals[ticker] = computeSignal(weekly);
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
      signal:           s.signal, // 'BL', 'SS', or null
      stopPrice:        s.stopPrice,
      ema21:            s.ema21,
      isNewSignal:      false,
      profitPercentage: null,
    };
  }
  return result;
}
