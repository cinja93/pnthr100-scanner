// server/aiIntradayOverlay.js
// ── Live intraday OHLC for AI Universe synthetic indices ───────────────────
//
// One source of truth for "synthesize today's intraday OHLC for an AI Universe
// index or sector" by overlaying live FMP /quote constituents onto the stored
// weights. Used by:
//   • pnthrAi300Service       — PAI300 strip + chart modal
//   • pnthrAiSectorsService   — 18 sector cards + sector chart modal
//
// Math is identical to the end-of-day cron rebuild, just substituting live
// FMP fields for end-of-day closes:
//
//   intraday_open  = lastClose × Σ(w_i × open_i      / prevClose_i) / usedWeight
//   intraday_high  = lastClose × Σ(w_i × dayHigh_i   / prevClose_i) / usedWeight
//   intraday_low   = lastClose × Σ(w_i × dayLow_i    / prevClose_i) / usedWeight
//   intraday_close = lastClose × Σ(w_i × price_i     / prevClose_i) / usedWeight
//
// • lastClose is the most recent stored close (yesterday during RTH; today
//   after 5:30pm cron — the math handles both cleanly).
// • Renormalizing by usedWeight (the actual sum of weights that contributed
//   to the sum) cleanly handles any missing quote without dragging the index
//   toward zero.
// • The state machine for signals MUST NOT be fed these synthesized bars —
//   signals confirm only on cron-written closed bars to avoid intraday
//   whipsaws. This module returns the synthesized bar; whether to feed it
//   into signal detection is the caller's choice (it shouldn't).
// ────────────────────────────────────────────────────────────────────────────

import { fetchFMP } from './stockService.js';

// ── In-memory quote-batch cache shared across all overlay calls ─────────────
// All AI Universe synthetic indices (PAI300 + 18 sectors) draw from the same
// 297-name basket. One batched FMP call covers everything; cache it for 30s
// so a request burst (strip + cards + multiple chart modals) hits FMP once.
let quoteCache    = null;
let quoteCacheAt  = 0;
let quoteCacheKey = '';
const QUOTE_CACHE_MS = 30 * 1000;

export function clearAiIntradayQuoteCache() {
  quoteCache = null; quoteCacheAt = 0; quoteCacheKey = '';
}

// Pull live quotes for a set of tickers, batched. Returns a map of
// ticker → quote that is guaranteed to cover every requested ticker (or
// returns {} on hard failure).
//
// Cache strategy: one shared 30s map keyed by the union of tickers ever
// fetched in the window. If a fresh request asks for tickers not yet in the
// cache, we refetch with the full union so subsequent calls for either set
// hit cache. The 297-name AI Universe basket fits in one FMP call, so
// "refetch with the union" is cheap.
//
// The cacheKey arg is now a no-op (kept for backwards compat with existing
// call sites). Behavior is now driven solely by the requested ticker list.
export async function fetchAiQuotesBatch(tickers /*, { cacheKey } = {} */) {
  if (!Array.isArray(tickers) || tickers.length === 0) {
    return {};
  }
  const now = Date.now();
  const cacheFresh = quoteCache && (now - quoteCacheAt) < QUOTE_CACHE_MS;
  if (cacheFresh) {
    // If the cache covers every requested ticker, return it as-is.
    let allCovered = true;
    for (const t of tickers) {
      if (!quoteCache[t]) { allCovered = false; break; }
    }
    if (allCovered) return quoteCache;
  }
  // Cache miss or stale or coverage gap — fetch the union of requested
  // tickers + any tickers already in cache so we don't shrink the map.
  const tickerSet = new Set(tickers);
  if (cacheFresh) for (const t of Object.keys(quoteCache || {})) tickerSet.add(t);
  const tickerList = [...tickerSet];
  const quotes = await fetchFMP(`/quote/${tickerList.join(',')}`).catch(() => null);
  if (!Array.isArray(quotes)) {
    // FMP failed — return whatever cache we have rather than nothing, so
    // callers can still resolve their tickers if any were cached earlier.
    return cacheFresh ? quoteCache : {};
  }
  const map = {};
  for (const q of quotes) {
    if (q && typeof q.symbol === 'string') map[q.symbol] = q;
  }
  quoteCache    = map;
  quoteCacheKey = `union(${tickerList.length})`;
  quoteCacheAt  = now;
  return map;
}

// YYYY-MM-DD in America/New_York from a Unix-second timestamp. Pulls the
// canonical session date out of the FMP quote so weekend / holiday handling
// is automatic — if the latest quote timestamp is Friday, todayET is Friday.
export function ymdET(unixSec) {
  if (!unixSec || !isFinite(unixSec)) return null;
  const d = new Date(unixSec * 1000);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year:  'numeric',
    month: '2-digit',
    day:   '2-digit',
  });
  return fmt.format(d);
}

// Walk a date back to the Monday of its week, ET. Returns YYYY-MM-DD.
export function mondayOfET(ymd) {
  if (!ymd) return null;
  const d = new Date(`${ymd}T12:00:00-05:00`); // ET noon — TZ-stable
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const daysToMonday = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + daysToMonday);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year:  'numeric',
    month: '2-digit',
    day:   '2-digit',
  });
  return fmt.format(d);
}

// Compute today's synthetic intraday OHLC for an index/sector.
//
// Args:
//   weights    — { ticker: number } — sum to ~1.0 (capped weights from meta).
//   lastClose  — number — most recent stored index/sector close.
//   quoteMap   — { ticker: FMP quote object } — live quotes for constituents.
//
// Returns:
//   { ok: true,  open, high, low, close, todayET, sourcedWeight }
//     when at least one constituent quote contributed.
//   { ok: false, reason }
//     when overlay couldn't be computed (no weights, no quotes, all missing).
export function computeIntradayBar({ weights, lastClose, quoteMap }) {
  if (!weights || typeof lastClose !== 'number' || !isFinite(lastClose) || lastClose <= 0) {
    return { ok: false, reason: 'invalid-inputs' };
  }
  if (!quoteMap || typeof quoteMap !== 'object') {
    return { ok: false, reason: 'no-quotes' };
  }

  let sumOpen   = 0;
  let sumHigh   = 0;
  let sumLow    = 0;
  let sumClose  = 0;
  let usedWt    = 0;
  let latestTs  = 0;

  for (const [ticker, w] of Object.entries(weights)) {
    if (!w || w <= 0) continue;
    const q = quoteMap[ticker];
    if (!q) continue;
    const prev = q.previousClose;
    if (typeof prev !== 'number' || prev <= 0) continue;

    const px      = (typeof q.price   === 'number' && q.price   > 0) ? q.price   : prev;
    const open    = (typeof q.open    === 'number' && q.open    > 0) ? q.open    : prev;
    const dayHigh = (typeof q.dayHigh === 'number' && q.dayHigh > 0) ? q.dayHigh : Math.max(open, px);
    const dayLow  = (typeof q.dayLow  === 'number' && q.dayLow  > 0) ? q.dayLow  : Math.min(open, px);

    sumOpen  += w * (open    / prev);
    sumHigh  += w * (dayHigh / prev);
    sumLow   += w * (dayLow  / prev);
    sumClose += w * (px      / prev);
    usedWt   += w;

    if (typeof q.timestamp === 'number' && q.timestamp > latestTs) latestTs = q.timestamp;
  }

  if (usedWt <= 0) return { ok: false, reason: 'no-contributing-constituents' };

  // Renormalize by actual contributing weight so missing tickers don't
  // pull the index toward zero.
  const open  = lastClose * (sumOpen  / usedWt);
  const high  = lastClose * (sumHigh  / usedWt);
  const low   = lastClose * (sumLow   / usedWt);
  const close = lastClose * (sumClose / usedWt);

  // Constrain H/L to enclose O and C — guards against edge cases where
  // stale dayHigh/dayLow fields are missing for some constituents.
  const finalHigh = Math.max(high, open, close);
  const finalLow  = Math.min(low,  open, close);

  return {
    ok:            true,
    open:          parseFloat(open.toFixed(4)),
    high:          parseFloat(finalHigh.toFixed(4)),
    low:           parseFloat(finalLow.toFixed(4)),
    close:         parseFloat(close.toFixed(4)),
    todayET:       latestTs ? ymdET(latestTs) : null,
    sourcedWeight: parseFloat(usedWt.toFixed(6)), // diagnostic — how much of the basket contributed
  };
}

// Splice today's synthesized daily bar into a sorted-ascending bar series.
// If the latest bar's date matches today's ET date, the bar is replaced
// (the cron has already written today's close-stamped bar; live data is
// fresher until close). Otherwise the bar is appended.
//
// Returns a new array — does not mutate the input.
export function spliceTodayDaily(dailyAsc, intraday) {
  if (!intraday?.ok || !intraday.todayET) return dailyAsc.slice();
  const out  = dailyAsc.slice();
  const last = out[out.length - 1];
  const todayBar = {
    date:   intraday.todayET,
    open:   intraday.open,
    high:   intraday.high,
    low:    intraday.low,
    close:  intraday.close,
    volume: 0,
  };
  if (last && last.date === intraday.todayET) {
    // Cron has already written today's bar; widen H/L using whichever is
    // larger across stored vs live, but keep stored open (true session open)
    // and use live close (most recent tick).
    out[out.length - 1] = {
      ...last,
      high:  Math.max(last.high, intraday.high),
      low:   Math.min(last.low,  intraday.low),
      close: intraday.close,
    };
  } else if (!last || intraday.todayET > last.date) {
    out.push(todayBar);
  }
  return out;
}

// Update / append this week's weekly bar with today's intraday data.
// • If the latest weekly bar's weekOf == this Monday → update H/L/C in place
//   (preserve the stored Monday open). Open stays from Mongo.
// • Else if this Monday > latest weekOf → append a new weekly bar (rare —
//   means the daily aggregator hasn't written this week yet).
//
// Returns a new array — does not mutate the input.
export function spliceTodayWeekly(weeklyAsc, intraday) {
  if (!intraday?.ok || !intraday.todayET) return weeklyAsc.slice();
  const thisMonday = mondayOfET(intraday.todayET);
  if (!thisMonday) return weeklyAsc.slice();

  const out  = weeklyAsc.slice();
  const last = out[out.length - 1];

  if (last && last.weekOf === thisMonday) {
    out[out.length - 1] = {
      ...last,
      high:  Math.max(last.high, intraday.high),
      low:   Math.min(last.low,  intraday.low),
      close: intraday.close,
    };
  } else if (!last || thisMonday > last.weekOf) {
    out.push({
      weekOf: thisMonday,
      open:   intraday.open,
      high:   intraday.high,
      low:    intraday.low,
      close:  intraday.close,
      volume: 0,
    });
  }
  return out;
}

export function spliceTodayMonthly(monthlyAsc, intraday) {
  if (!intraday?.ok || !intraday.todayET) return monthlyAsc.slice();
  const thisMonth = intraday.todayET.slice(0, 7);
  const firstOfMonth = thisMonth + '-01';

  const out  = monthlyAsc.slice();
  const last = out[out.length - 1];
  const lastMonth = last?.monthOf?.slice(0, 7);

  if (last && lastMonth === thisMonth) {
    out[out.length - 1] = {
      ...last,
      high:  Math.max(last.high, intraday.high),
      low:   Math.min(last.low,  intraday.low),
      close: intraday.close,
    };
  } else if (!last || firstOfMonth > last.monthOf) {
    out.push({
      monthOf: firstOfMonth,
      open:    intraday.open,
      high:    intraday.high,
      low:     intraday.low,
      close:   intraday.close,
      volume:  0,
    });
  }
  return out;
}
