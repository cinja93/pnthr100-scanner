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

// Wilder's ATR(period) over weekly bars.
// Returns array indexed by bar index; atrArr[i] = ATR through bar i (null until seeded).
function computeWilderATR(weeklyBars, period = 3) {
  const n = weeklyBars.length;
  const atrArr = new Array(n).fill(null);
  if (n < period + 1) return atrArr;
  const trs = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const cur = weeklyBars[i], prev = weeklyBars[i - 1];
    trs[i] = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
  }
  let atr = 0;
  for (let i = 1; i <= period; i++) atr += trs[i];
  atr /= period;
  atrArr[period] = atr;
  for (let i = period + 1; i < n; i++) {
    atr = (atr * 2 + trs[i]) / 3;
    atrArr[i] = atr;
  }
  return atrArr;
}

// Predatory buffer stop for a long position (entry week).
// For expensive stocks: stop slightly above low (tighter). For cheap: below low.
function longPredStop(low, price) {
  const buf = price * 0.001;
  return parseFloat((buf > 0.01 ? low + buf : low - 0.01).toFixed(2));
}

// Predatory buffer stop for a short position (entry week).
function shortPredStop(high, price) {
  const buf = price * 0.001;
  return parseFloat((buf > 0.01 ? high - buf : high + 0.01).toFixed(2));
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
  if (emas.length < 2) return { signal: null, ema21: null, stopPrice: null, currentWeekStop: null };
  const atrArr = computeWilderATR(weeklyBars);

  // emas[i] aligns to weeklyBars[i + (period - 1)]
  const emaOffset = EMA_PERIOD - 1;

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
          const profitDollar = parseFloat((exitPrice - position.entryClose).toFixed(2));
          const profitPct    = parseFloat(((profitDollar / position.entryClose) * 100).toFixed(2));
          lastEvent = { signal: 'BE', signalDate: current.weekStart, ema21: parseFloat(emaCurrent.toFixed(4)), stopPrice: null, profitDollar, profitPct };
          shortTrendActive = true;
          shortTrendCapped = true;   // SS after BE = opposite side → 25% cap applies
          position = null; continue;
        }
      } else {
        if (current.high > twoWeekHigh) {
          const exitPrice    = position.pnthrStop;
          const profitDollar = parseFloat((position.entryClose - exitPrice).toFixed(2));
          const profitPct    = parseFloat(((profitDollar / position.entryClose) * 100).toFixed(2));
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
      const blZone   = current.low  >= emaCurrent * 1.01 && current.low  <= emaCurrent * 1.10;
      const ssZone   = current.high <= emaCurrent * 0.99 && current.high >= emaCurrent * 0.90;

      const blReentry    = longTrendActive  && current.low  >= emaCurrent * 1.01 && (!longTrendCapped  || current.low  <= emaCurrent * 1.25);
      const ssReentry    = shortTrendActive && current.high <= emaCurrent * 0.99 && (!shortTrendCapped || current.high >= emaCurrent * 0.75);
      const blDaylightOk = blReentry || (blZone && longDaylight  >= 1 && longDaylight  <= 3);
      const ssDaylightOk = ssReentry || (ssZone && shortDaylight >= 1 && shortDaylight <= 3);

      if (blPhase1 && blDaylightOk) {
        const initStop = longPredStop(current.low, current.close);
        lastEvent = { signal: 'BL', signalDate: current.weekStart, ema21: parseFloat(emaCurrent.toFixed(4)), stopPrice: initStop };
        position         = { type: 'BL', entryWi: wi, pnthrStop: initStop, entryClose: current.close };
        longTrendActive  = true;
        longTrendCapped  = false; // same-side — future BE→BL re-entry has no cap
        shortTrendActive = false;
        shortTrendCapped = false;
      } else if (ssPhase1 && ssDaylightOk) {
        const initStop = shortPredStop(current.high, current.close);
        lastEvent = { signal: 'SS', signalDate: current.weekStart, ema21: parseFloat(emaCurrent.toFixed(4)), stopPrice: initStop };
        position         = { type: 'SS', entryWi: wi, pnthrStop: initStop, entryClose: current.close };
        shortTrendActive = true;
        shortTrendCapped = false; // same-side — future SE→SS re-entry has no cap
        longTrendActive  = false;
        longTrendCapped  = false;
      }
    }
  }

  if (!lastEvent) {
    const lastEma = emas[emas.length - 1];
    return { signal: null, ema21: parseFloat(lastEma.toFixed(4)), stopPrice: null, currentWeekStop: null };
  }

  // If still in an open position, attach live stop prices to the signal event
  if (position) {
    const lastBar = weeklyBars[weeklyBars.length - 1];
    lastEvent.pnthrStop = position.pnthrStop;
    lastEvent.stopPrice = position.pnthrStop; // backward-compat alias
    lastEvent.currentWeekStop = position.type === 'BL'
      ? parseFloat((lastBar.low  - 0.01).toFixed(2))
      : parseFloat((lastBar.high + 0.01).toFixed(2));
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
      stopPrice:        s.pnthrStop ?? s.stopPrice ?? null, // backward-compat alias for pnthrStop
      pnthrStop:        s.pnthrStop ?? null,
      currentWeekStop:  s.currentWeekStop ?? null,
      ema21:            s.ema21,
      signalDate:       s.signalDate || null, // YYYY-MM-DD (Monday of signal week)
      isNewSignal:      false,
      profitPercentage: null,
      profitDollar:     s.profitDollar ?? null,
      profitPct:        s.profitPct    ?? null,
    };
  }
  return result;
}
