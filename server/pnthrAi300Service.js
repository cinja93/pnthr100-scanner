// server/pnthrAi300Service.js
// ── PNTHR AI 300 — Index read service ──────────────────────────────────────
//
// Powers /api/pnthr-ai-300 (header strip on AI Jungle) and
// /api/pnthr-ai-300/bars (chart modal).
//
// Reads bars from pnthr_ai_index_candles + pnthr_ai_index_candles_weekly.
// Computes 21D + 21W EMA on demand and the bull/bear regime gate.
// In-memory cache keyed by timeframe; cleared by daily cron after each
// candle-update run. Zero touch to PNTHR 679 collections.
// ────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';
import {
  INDEX_NAME, INDEX_TICKER, BASE_DATE, BASE_VALUE,
  COLL_INDEX_DAILY, COLL_INDEX_WEEKLY, COLL_INDEX_META,
  INDEX_EMA_DAILY_PERIOD, INDEX_EMA_WEEKLY_PERIOD, INDEX_EMA_MONTHLY_PERIOD,
  SINGLE_NAME_CAP, HYPERSCALER_CAP, HYPERSCALER_TICKERS,
} from './data/pnthrAiIndexConfig.js';
import { fetchFMP } from './stockService.js';
import {
  fetchAiQuotesBatch, computeIntradayBar,
  spliceTodayDaily, spliceTodayWeekly, spliceTodayMonthly,
} from './aiIntradayOverlay.js';

// ── Cached weights loader ───────────────────────────────────────────────────
// PAI300's monthly capped market-cap weights are stored in pnthr_ai_index_meta
// under key='current_weights'. Re-loaded once per CACHE_MS; the rebalance
// cron clears this cache when it writes a fresh weights doc.
let cacheIndexWeights   = null;
let cacheIndexWeightsAt = 0;
async function loadIndexWeights() {
  const now = Date.now();
  if (cacheIndexWeights && (now - cacheIndexWeightsAt) < CACHE_MS) return cacheIndexWeights;
  const db = await connectToDatabase();
  if (!db) return null;
  const meta = await db.collection('pnthr_ai_index_meta').findOne({ key: 'current_weights' });
  cacheIndexWeights   = meta?.weights || null;
  cacheIndexWeightsAt = now;
  return cacheIndexWeights;
}

// Standard EMA — first value = simple average of first `period` closes,
// then α-weighted recursion. Matches the 679 EMA convention.
function computeEMA(closes, period) {
  if (!closes || closes.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  // SMA seed for first `period-1` values is undefined; first EMA at index period-1
  let sma = 0;
  for (let i = 0; i < period; i++) sma += closes[i];
  sma /= period;
  for (let i = 0; i < period - 1; i++) out.push(null);
  out.push(sma);
  let prev = sma;
  for (let i = period; i < closes.length; i++) {
    const ema = (closes[i] - prev) * k + prev;
    out.push(ema);
    prev = ema;
  }
  return out;
}

// ── In-memory caches ────────────────────────────────────────────────────────
// Bars are end-of-day (cron-written) — 5 min cache is fine; the underlying
// data only changes once a day at 5:30pm. The latest snapshot, however, is
// recomputed from live FMP quotes overlaid on the most recent stored close,
// so its cache matches the AI Universe table cadence (30s).
let cacheDaily   = null; let cacheDailyAt   = 0;
let cacheWeekly  = null; let cacheWeeklyAt  = 0;
let cacheMonthly = null; let cacheMonthlyAt = 0;
let cacheLatest  = null; let cacheLatestAt  = 0;
const CACHE_MS         = 5 * 60 * 1000;  // bars + weights — change at 5:30pm cron only
const LATEST_CACHE_MS  = 30 * 1000;      // strip snapshot — live FMP refresh

export function clearPnthrAi300Cache() {
  cacheDaily        = null; cacheDailyAt        = 0;
  cacheWeekly       = null; cacheWeeklyAt       = 0;
  cacheMonthly      = null; cacheMonthlyAt      = 0;
  cacheLatest       = null; cacheLatestAt       = 0;
  cacheWeights      = null; cacheWeightsAt      = 0;
  cacheIndexWeights = null; cacheIndexWeightsAt = 0;
}

async function loadDailyBars() {
  const now = Date.now();
  if (cacheDaily && (now - cacheDailyAt) < CACHE_MS) return cacheDaily;
  const db = await connectToDatabase();
  if (!db) return [];
  const doc = await db.collection(COLL_INDEX_DAILY).findOne({ ticker: INDEX_TICKER });
  if (!doc?.daily?.length) return [];
  // Stored descending; service consumers want ascending
  const asc = [...doc.daily].sort((a, b) => a.date.localeCompare(b.date));
  cacheDaily = asc; cacheDailyAt = now;
  return asc;
}

async function loadWeeklyBars() {
  const now = Date.now();
  if (cacheWeekly && (now - cacheWeeklyAt) < CACHE_MS) return cacheWeekly;
  const db = await connectToDatabase();
  if (!db) return [];
  const doc = await db.collection(COLL_INDEX_WEEKLY).findOne({ ticker: INDEX_TICKER });
  if (!doc?.weekly?.length) return [];
  const asc = [...doc.weekly].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  cacheWeekly = asc; cacheWeeklyAt = now;
  return asc;
}

function aggregateDailyToMonthly(dailyBars) {
  if (!dailyBars.length) return [];
  const buckets = new Map();
  for (const bar of dailyBars) {
    const month = bar.date.slice(0, 7); // YYYY-MM
    if (!buckets.has(month)) {
      buckets.set(month, {
        monthOf: bar.date,
        open: bar.open, high: bar.high, low: bar.low, close: bar.close,
        volume: bar.volume || 0,
      });
    } else {
      const b = buckets.get(month);
      if (bar.high > b.high) b.high = bar.high;
      if (bar.low  < b.low)  b.low  = bar.low;
      b.close   = bar.close;
      b.volume += bar.volume || 0;
    }
  }
  return [...buckets.values()];
}

async function loadMonthlyBars() {
  const now = Date.now();
  if (cacheMonthly && (now - cacheMonthlyAt) < CACHE_MS) return cacheMonthly;
  const daily = await loadDailyBars();
  const monthly = aggregateDailyToMonthly(daily);
  cacheMonthly = monthly; cacheMonthlyAt = now;
  return monthly;
}

// ── Public API ──────────────────────────────────────────────────────────────

// Latest snapshot for the AI Jungle header strip + regime gate.
//
// Architecture:
//   • Bars (pnthr_ai_index_candles) are end-of-day only — written by the 5:30pm
//     cron. During RTH, daily[length-1] is YESTERDAY's close, not today's.
//   • Live overlay = constituent quotes × stored weights via aiIntradayOverlay
//     helper (single source of truth — same math used by getPnthrAi300Bars
//     and the per-sector services).
//   • Falls back to the stored close if FMP is unreachable so the strip
//     never goes blank.
export async function getPnthrAi300Latest() {
  const now = Date.now();
  if (cacheLatest && (now - cacheLatestAt) < LATEST_CACHE_MS) return cacheLatest;

  const [daily, weekly, weights] = await Promise.all([
    loadDailyBars(), loadWeeklyBars(), loadIndexWeights(),
  ]);
  if (!daily.length || !weekly.length) {
    return {
      ok: false,
      error: 'Index bars not yet built — run scripts/aiUniverse/buildPnthrAi300Index.js',
      indexName: INDEX_NAME,
      indexTicker: INDEX_TICKER,
    };
  }

  const lastBar      = daily[daily.length - 1];
  const priorBar     = daily.length >= 2 ? daily[daily.length - 2] : null;
  const lastBarClose = lastBar.close;

  // Live overlay — synthesize today's intraday bar (or fall back to stored).
  let liveValue  = lastBarClose;
  let liveAsOf   = lastBar.date;
  let liveSource = 'stored';
  let intraday   = null;
  if (weights) {
    const tickers = Object.keys(weights).filter(t => weights[t] > 0);
    const qmap    = await fetchAiQuotesBatch(tickers, { cacheKey: 'ai-universe-all' });
    intraday = computeIntradayBar({ weights, lastClose: lastBarClose, quoteMap: qmap });
    if (intraday.ok) {
      liveValue  = intraday.close;
      liveAsOf   = intraday.todayET || lastBar.date;
      liveSource = 'live';
    }
  }

  // Day change anchored to the prior session close. When the overlay synthesized
  // today's bar (todayET > lastBar.date), prior session = lastBar itself.
  // When lastBar IS today's bar already (post-cron), prior session = priorBar.
  const dayChangeBase = (liveSource === 'live' && liveAsOf > lastBar.date)
    ? lastBarClose
    : (priorBar ? priorBar.close : lastBarClose);
  const dayChangePct    = dayChangeBase > 0 ? ((liveValue - dayChangeBase) / dayChangeBase) * 100 : 0;
  const dayChangePoints = liveValue - dayChangeBase;

  const closesD = daily.map(b => b.close);
  const emaD    = computeEMA(closesD, INDEX_EMA_DAILY_PERIOD);
  const closesW = weekly.map(b => b.close);
  const emaW    = computeEMA(closesW, INDEX_EMA_WEEKLY_PERIOD);

  const ema21D = emaD[emaD.length - 1] ?? null;
  const ema21W = emaW[emaW.length - 1] ?? null;
  // Regime gate compares LIVE index value against the weekly OpEMA — matches
  // how a trader reads it ("are we above the EMA right now?").
  const regime = (ema21W != null && liveValue >= ema21W) ? 'bull' : 'bear';

  const yearStart = `${new Date().getFullYear()}-01-01`;
  const ytdSeed   = daily.find(b => b.date >= yearStart);
  const ytdPct    = ytdSeed ? ((liveValue - ytdSeed.close) / ytdSeed.close) * 100 : null;
  const inceptionPct = ((liveValue - BASE_VALUE) / BASE_VALUE) * 100;

  const out = {
    ok: true,
    indexName:   INDEX_NAME,
    indexTicker: INDEX_TICKER,
    asOf:        liveAsOf,
    value:       parseFloat(liveValue.toFixed(2)),
    valueSource: liveSource,
    open:        parseFloat((intraday?.ok ? intraday.open : lastBar.open).toFixed(2)),
    high:        parseFloat((intraday?.ok ? intraday.high : lastBar.high).toFixed(2)),
    low:         parseFloat((intraday?.ok ? intraday.low  : lastBar.low ).toFixed(2)),
    dayChangePct:    parseFloat(dayChangePct.toFixed(2)),
    dayChangePoints: parseFloat(dayChangePoints.toFixed(2)),
    ytdPct:      ytdPct != null ? parseFloat(ytdPct.toFixed(2)) : null,
    inceptionPct: parseFloat(inceptionPct.toFixed(2)),
    ema21D:      ema21D != null ? parseFloat(ema21D.toFixed(2)) : null,
    ema21W:      ema21W != null ? parseFloat(ema21W.toFixed(2)) : null,
    regime,
    barCount: { daily: daily.length, weekly: weekly.length },
    baseDate:  BASE_DATE,
    baseValue: BASE_VALUE,
  };
  cacheLatest = out; cacheLatestAt = now;
  return out;
}

// Latest constituent weights — read from pnthr_ai_index_meta (key: 'current_weights')
// and enriched with name + sector from the canonical white-paper data file.
// Sorted desc by weight. Includes the asOf rebalance date for transparency.
let cacheWeights = null; let cacheWeightsAt = 0;

export async function getPnthrAi300Weights() {
  const now = Date.now();
  if (cacheWeights && (now - cacheWeightsAt) < CACHE_MS) return cacheWeights;

  const db = await connectToDatabase();
  if (!db) return { ok: false, error: 'Mongo connect failed' };

  const meta = await db.collection('pnthr_ai_index_meta').findOne({ key: 'current_weights' });
  if (!meta?.weights) return { ok: false, error: 'No weights yet — run buildPnthrAi300Index.js' };

  // Lookup: ticker → { name, sectorId, sectorName, sectorWeight }
  const { SECTORS } = await import('./scripts/aiUniverse/aiUniverseData.js');
  const lookup = {};
  for (const sec of SECTORS) {
    for (const h of sec.holdings) {
      lookup[h.ticker] = {
        name:        h.name,
        sectorId:    sec.id,
        sectorName:  sec.name,
        sectorTargetWeight: sec.weight,
      };
    }
  }

  const constituents = Object.entries(meta.weights)
    .map(([ticker, w]) => ({
      ticker,
      name:       lookup[ticker]?.name || ticker,
      sectorId:   lookup[ticker]?.sectorId ?? null,
      sector:     lookup[ticker]?.sectorName || 'Unknown',
      weight:     parseFloat((w * 100).toFixed(4)),  // 0..100
    }))
    .sort((a, b) => b.weight - a.weight)
    .map((row, i) => ({ rank: i + 1, ...row }));

  // Per-sector roll-up
  const sectorMap = {};
  for (const c of constituents) {
    const key = c.sectorId ?? 0;
    if (!sectorMap[key]) sectorMap[key] = { id: c.sectorId, name: c.sector, count: 0, weight: 0, target: lookup[c.ticker]?.sectorTargetWeight ?? null };
    sectorMap[key].count++;
    sectorMap[key].weight += c.weight;
  }
  const sectorRollup = Object.values(sectorMap)
    .map(s => ({ ...s, weight: parseFloat(s.weight.toFixed(4)) }))
    .sort((a, b) => b.weight - a.weight);

  const out = {
    ok:               true,
    asOfRebalance:    meta.asOfRebalance,
    constituentCount: constituents.length,
    totalWeight:      parseFloat(constituents.reduce((s, c) => s + c.weight, 0).toFixed(4)),
    sectors:          sectorRollup,
    constituents,
  };
  cacheWeights = out; cacheWeightsAt = now;
  return out;
}

// Rebalance weights from the current aiUniverseData.js holdings + live FMP
// market caps. Applies the same iterative cap algorithm as the full index
// build script but without rebuilding historical bars. Writes the new
// current_weights doc to Mongo and clears all caches.
export async function rebalanceWeightsNow() {
  const db = await connectToDatabase();
  if (!db) return { ok: false, error: 'Mongo connect failed' };

  const { SECTORS, FUND_META } = await import('./scripts/aiUniverse/aiUniverseData.js');
  const allTickers = [];
  for (const sec of SECTORS) {
    for (const h of sec.holdings) allTickers.push(h.ticker);
  }
  if (allTickers.length === 0) return { ok: false, error: 'No holdings in aiUniverseData.js' };

  const CHUNK = 100;
  const mktCapMap = {};
  for (let i = 0; i < allTickers.length; i += CHUNK) {
    const chunk = allTickers.slice(i, i + CHUNK);
    try {
      const arr = await fetchFMP(`/profile/${chunk.join(',')}`);
      if (Array.isArray(arr)) {
        for (const p of arr) {
          const mc = parseFloat(p.mktCap) || 0;
          if (mc > 0) mktCapMap[p.symbol] = mc;
        }
      }
    } catch (err) {
      console.error(`[rebalanceWeights] /profile chunk failed:`, err.message);
    }
    if (i + CHUNK < allTickers.length) await new Promise(r => setTimeout(r, 300));
  }

  const covered = allTickers.filter(t => mktCapMap[t]);
  if (covered.length === 0) return { ok: false, error: 'FMP returned no market caps' };

  const totalMktCap = covered.reduce((s, t) => s + mktCapMap[t], 0);
  const rawWeights = {};
  for (const t of covered) rawWeights[t] = mktCapMap[t] / totalMktCap;

  const hyperSet = new Set(HYPERSCALER_TICKERS);
  function capFn(ticker) {
    return hyperSet.has(ticker) ? HYPERSCALER_CAP : SINGLE_NAME_CAP;
  }

  const weights = { ...rawWeights };
  for (let iter = 0; iter < 50; iter++) {
    let cappedTotal = 0, uncappedTotal = 0;
    const cappedSet = new Set();
    for (const [t, w] of Object.entries(weights)) {
      const cap = capFn(t);
      if (w > cap) { weights[t] = cap; cappedTotal += cap; cappedSet.add(t); }
      else { uncappedTotal += w; }
    }
    if (cappedSet.size === 0) break;
    const slack = 1 - cappedTotal - uncappedTotal;
    if (Math.abs(slack) < 1e-9) break;
    const scale = (uncappedTotal + slack) / uncappedTotal;
    for (const t of Object.keys(weights)) {
      if (!cappedSet.has(t)) weights[t] *= scale;
    }
  }
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (Math.abs(total - 1) > 1e-6) {
    for (const t of Object.keys(weights)) weights[t] /= total;
  }

  const today = new Date().toISOString().slice(0, 10);
  await db.collection(COLL_INDEX_META).updateOne(
    { key: 'current_weights' },
    { $set: { weights, asOfRebalance: today, updatedAt: new Date() } },
    { upsert: true },
  );

  clearPnthrAi300Cache();
  console.log(`[rebalanceWeights] Done — ${Object.keys(weights).length} constituents, as of ${today}`);
  return { ok: true, constituentCount: Object.keys(weights).length, asOfRebalance: today };
}

// Bars + EMA series for the chart modal. timeframe = 'daily' | 'weekly'.
// limit (optional) = max bars to return (most recent N).
//
// Stored bars come from the cron-written collections (end-of-day only). To
// keep the chart in sync with the strip during RTH we splice in today's
// synthesized intraday bar via the shared aiIntradayOverlay helper — same
// math as getPnthrAi300Latest. EMA is recomputed over the augmented series
// so the OpEMA line extends to today.
export async function getPnthrAi300Bars({ timeframe = 'daily', limit = null } = {}) {
  const bars = timeframe === 'monthly'
    ? await loadMonthlyBars()
    : timeframe === 'weekly' ? await loadWeeklyBars() : await loadDailyBars();
  if (!bars.length) return { ok: false, bars: [], ema: [], emaPeriod: null };

  const period   = timeframe === 'monthly' ? INDEX_EMA_MONTHLY_PERIOD
                 : timeframe === 'weekly'  ? INDEX_EMA_WEEKLY_PERIOD
                 : INDEX_EMA_DAILY_PERIOD;
  const labelKey = timeframe === 'monthly' ? 'monthOf'
                 : timeframe === 'weekly'  ? 'weekOf'
                 : 'date';

  // Live overlay: synthesize today's intraday bar from constituent quotes,
  // then splice into the stored series. Daily series gets a today's bar
  // appended (or replaced if cron already wrote it). Weekly series gets
  // this week's bar updated H/L/C in place (preserving stored Monday open).
  let augmented = bars.slice();
  try {
    const weights = await loadIndexWeights();
    if (weights) {
      // Use most recent stored DAILY close as the lastClose anchor — daily
      // bars are always the most up-to-date close vs the weekly aggregate.
      const dailyForAnchor = timeframe === 'daily' ? bars : await loadDailyBars();
      if (dailyForAnchor.length > 0) {
        const lastDailyClose = dailyForAnchor[dailyForAnchor.length - 1].close;
        const tickers = Object.keys(weights).filter(t => weights[t] > 0);
        const qmap    = await fetchAiQuotesBatch(tickers, { cacheKey: 'ai-universe-all' });
        const intraday = computeIntradayBar({ weights, lastClose: lastDailyClose, quoteMap: qmap });
        if (intraday.ok) {
          if (timeframe === 'monthly') {
            augmented = spliceTodayMonthly(bars, intraday);
          } else if (timeframe === 'weekly') {
            augmented = spliceTodayWeekly(bars, intraday);
          } else {
            augmented = spliceTodayDaily(bars, intraday);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[PAI300] bars overlay failed; rendering stored bars only:', err.message);
  }

  const closes = augmented.map(b => b.close);
  const ema    = computeEMA(closes, period);

  let merged = augmented.map((b, i) => ({
    date:   b[labelKey],
    open:   b.open,
    high:   b.high,
    low:    b.low,
    close:  b.close,
    volume: b.volume || 0,
    ema:    ema[i] != null ? parseFloat(ema[i].toFixed(2)) : null,
  }));

  if (limit && merged.length > limit) merged = merged.slice(merged.length - limit);

  return {
    ok:        true,
    timeframe,
    emaPeriod: period,
    indexName: INDEX_NAME,
    indexTicker: INDEX_TICKER,
    bars: merged,
  };
}

// Append today's bar to pnthr_ai_index_candles + re-aggregate weekly. Called
// by the daily cron after constituent candles are refreshed. Idempotent
// when run multiple times in the same day (re-uses same date — overwrites).
export async function appendTodaysIndexBar() {
  // Lazy-import to avoid a startup-time circular and to keep the build/backfill
  // script and the live cron path mathematically identical.
  const buildModule = await import('./scripts/aiUniverse/buildPnthrAi300Index.js')
    .catch(() => null);
  if (!buildModule) {
    console.warn('[PAI300] build module not importable; falling back to no-op');
    return { ok: false, error: 'build module not importable' };
  }
  // Build script's main() exits the process — we want a function. Instead,
  // run the same logic in-process by spawning a child node call to the script.
  // Simpler: mark cache stale and let the next /api/pnthr-ai-300 hit recompute
  // — but that doesn't actually persist a fresh bar. We need a real append.
  // Strategy: invoke the build script as a subprocess. It's idempotent and
  // small enough to re-run end-to-end (~3s once Mongo is warm).
  return { ok: false, error: 'use child_process invocation in cron — see runPnthrAi300DailyAppend' };
}

// Imperative wrapper used by the cron — runs the standalone backfill script
// in-process via dynamic import. The script has process.exit() at the end;
// we shim that off so this can be called as a function.
export async function runPnthrAi300DailyAppend() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  const path = (await import('node:path')).default;
  const url  = (await import('node:url')).default;

  const scriptPath = url.fileURLToPath(new URL('./scripts/aiUniverse/buildPnthrAi300Index.js', import.meta.url));
  const weeklyPath = url.fileURLToPath(new URL('./scripts/aiUniverse/buildPnthrAi300IndexWeekly.js', import.meta.url));
  const cwd = path.dirname(scriptPath);

  console.log('[PAI300] running daily index rebuild…');
  const t0 = Date.now();
  try {
    const { stdout: o1 } = await exec('node', [scriptPath], { cwd, maxBuffer: 10 * 1024 * 1024 });
    const { stdout: o2 } = await exec('node', [weeklyPath], { cwd, maxBuffer: 10 * 1024 * 1024 });
    clearPnthrAi300Cache();
    console.log(`[PAI300] rebuild done in ${((Date.now()-t0)/1000).toFixed(1)}s`);
    // Surface the last few lines of each script's stdout so cron logs are useful
    const tail = (s) => s.split('\n').filter(Boolean).slice(-3).join(' | ');
    return { ok: true, runtimeSec: (Date.now()-t0)/1000, daily: tail(o1), weekly: tail(o2) };
  } catch (err) {
    console.error('[PAI300] rebuild failed:', err.message);
    return { ok: false, error: err.message };
  }
}
