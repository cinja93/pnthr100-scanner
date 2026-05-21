// server/pnthrAiSectorsService.js
// ── PNTHR AI Sectors — read service ─────────────────────────────────────────
//
// Powers /api/pnthr-ai-sectors (16-card grid) and
// /api/pnthr-ai-sectors/:sectorId/bars (per-sector chart).
//
// Reads from pnthr_ai_sector_candles + pnthr_ai_sector_candles_weekly.
// EMAs computed on demand using per-sector periods from
// data/pnthrAiSectorsConfig.js (all start at 30W, tunable individually).
// Zero touch to PAI300 / 679 collections.
// ────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';
import { SECTORS } from './scripts/aiUniverse/aiUniverseData.js';
import {
  COLL_SECTOR_DAILY, COLL_SECTOR_WEEKLY,
  SECTOR_BASE_DATE, SECTOR_BASE_VALUE,
  SECTOR_EMA_DAILY_PERIODS, SECTOR_EMA_WEEKLY_PERIODS,
  SECTOR_METADATA, sectorTicker,
} from './data/pnthrAiSectorsConfig.js';
import {
  fetchAiQuotesBatch, computeIntradayBar,
  spliceTodayDaily, spliceTodayWeekly,
} from './aiIntradayOverlay.js';

// ── Per-sector weights cache ────────────────────────────────────────────────
// Each sector's capped weights live in pnthr_ai_sector_meta under
// key='current_weights:S{id}'. Loaded once per CACHE_MS; cleared by the
// monthly rebalance cron via clearPnthrAiSectorsCache().
let cacheSectorWeights   = null;
let cacheSectorWeightsAt = 0;
async function loadAllSectorWeights() {
  const now = Date.now();
  if (cacheSectorWeights && (now - cacheSectorWeightsAt) < CACHE_MS) return cacheSectorWeights;
  const db = await connectToDatabase();
  if (!db) return null;
  const docs = await db.collection('pnthr_ai_sector_meta')
    .find({ key: { $regex: /^current_weights:S/ } })
    .toArray();
  const out = {};
  for (const d of docs) {
    // key looks like "current_weights:S4" → sectorId 4
    const m = /^current_weights:S(\d+)$/.exec(d.key);
    if (!m) continue;
    out[parseInt(m[1], 10)] = d.weights || {};
  }
  cacheSectorWeights   = out;
  cacheSectorWeightsAt = now;
  return out;
}

function computeEMA(closes, period) {
  if (!closes || closes.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
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

// Bar/weights caches stay 5 min — they only change at the daily 5:30pm cron
// (or monthly rebalance). Latest snapshot uses a 30s cache so the live
// overlay rolls forward with the AI Universe table cadence.
const CACHE_MS         = 5 * 60 * 1000;
const LATEST_CACHE_MS  = 30 * 1000;
let cacheLatest = null; let cacheLatestAt = 0;
const cacheBars = new Map(); // key = `${sectorId}:${timeframe}` → { data, ts }

export function clearPnthrAiSectorsCache() {
  cacheLatest = null; cacheLatestAt = 0;
  cacheBars.clear();
  cacheSectorWeights = null; cacheSectorWeightsAt = 0;
}

// Latest snapshot for all 16 sectors — for the AI Sectors grid page.
// Returns { ok, asOf, sectors: [{ id, ticker, name, value, dayChangePct, ytdPct, inceptionPct, ema21D, emaW, regime, ... }] }
//
// Each sector's value is recomputed live by overlaying constituent FMP quotes
// on the most recent stored close using that sector's capped weights. One
// batched FMP call covers all 16 sectors (the 297-name basket is shared
// across them via aiIntradayOverlay's quote cache). Sectors without weights
// or quotes fall back cleanly to the stored close.
export async function getPnthrAiSectorsLatest() {
  const now = Date.now();
  if (cacheLatest && (now - cacheLatestAt) < LATEST_CACHE_MS) return cacheLatest;

  const db = await connectToDatabase();
  if (!db) return { ok: false, error: 'Mongo connect failed' };

  const dailyCol  = db.collection(COLL_SECTOR_DAILY);
  const weeklyCol = db.collection(COLL_SECTOR_WEEKLY);

  const [dailyDocs, weeklyDocs, allWeights] = await Promise.all([
    dailyCol.find({ ticker: /^PAI_S/ }).toArray(),
    weeklyCol.find({ ticker: /^PAI_S/ }).toArray(),
    loadAllSectorWeights(),
  ]);

  const dailyByTicker  = Object.fromEntries(dailyDocs.map(d => [d.ticker, d]));
  const weeklyByTicker = Object.fromEntries(weeklyDocs.map(d => [d.ticker, d]));

  // Pull live quotes for all constituents across all sectors in one batch.
  // The shared aiIntradayOverlay quote cache means any subsequent call within
  // 30s (PAI300 strip, sector chart, etc.) hits the cache instead of FMP.
  let qmap = {};
  if (allWeights) {
    const tickerSet = new Set();
    for (const w of Object.values(allWeights)) {
      for (const t of Object.keys(w || {})) {
        if (w[t] > 0) tickerSet.add(t);
      }
    }
    if (tickerSet.size > 0) {
      qmap = await fetchAiQuotesBatch([...tickerSet], { cacheKey: 'ai-universe-all' });
    }
  }

  const yearStart = `${new Date().getFullYear()}-01-01`;
  let asOf = null;

  const sectors = SECTOR_METADATA.map(meta => {
    const dDoc = dailyByTicker[meta.ticker];
    const wDoc = weeklyByTicker[meta.ticker];
    if (!dDoc?.daily?.length || !wDoc?.weekly?.length) {
      return { ...meta, ok: false, error: 'No bars' };
    }
    const dailyAsc  = [...dDoc.daily].sort((a, b) => a.date.localeCompare(b.date));
    const weeklyAsc = [...wDoc.weekly].sort((a, b) => a.weekOf.localeCompare(b.weekOf));

    const lastDaily = dailyAsc[dailyAsc.length - 1];
    const prevDaily = dailyAsc.length >= 2 ? dailyAsc[dailyAsc.length - 2] : null;

    // Live overlay for this sector's value — same shared helper.
    const sectorWeights = allWeights ? allWeights[meta.id] : null;
    const intraday = sectorWeights
      ? computeIntradayBar({ weights: sectorWeights, lastClose: lastDaily.close, quoteMap: qmap })
      : { ok: false };
    const live = intraday.ok;
    const liveValue  = live ? intraday.close : lastDaily.close;
    const liveOpen   = live ? intraday.open  : lastDaily.open;
    const liveHigh   = live ? intraday.high  : lastDaily.high;
    const liveLow    = live ? intraday.low   : lastDaily.low;
    const liveAsOf   = live ? (intraday.todayET || lastDaily.date) : lastDaily.date;

    // Day change anchored to prior-session close (handles pre-cron and
    // post-cron lastDaily semantics — same logic as PAI300 strip).
    const dayChangeBase = (live && liveAsOf > lastDaily.date)
      ? lastDaily.close
      : (prevDaily ? prevDaily.close : lastDaily.close);
    const dayChangePct = dayChangeBase > 0
      ? ((liveValue - dayChangeBase) / dayChangeBase) * 100
      : 0;

    const dailyPeriod  = SECTOR_EMA_DAILY_PERIODS[meta.id]  ?? 21;
    const weeklyPeriod = SECTOR_EMA_WEEKLY_PERIODS[meta.id] ?? 30;
    const emaD = computeEMA(dailyAsc.map(b => b.close),  dailyPeriod);
    const emaW = computeEMA(weeklyAsc.map(b => b.close), weeklyPeriod);
    const lastEmaD = emaD[emaD.length - 1] ?? null;
    const lastEmaW = emaW[emaW.length - 1] ?? null;

    // Regime gate compares LIVE sector value vs weekly OpEMA — matches how
    // a trader reads "is this sector above its OpEMA right now?"
    const regime = (lastEmaW != null && liveValue >= lastEmaW) ? 'bull' : 'bear';

    const ytdSeed = dailyAsc.find(b => b.date >= yearStart);
    const ytdPct  = ytdSeed ? ((liveValue - ytdSeed.close) / ytdSeed.close) * 100 : null;
    const inceptionPct = ((liveValue - SECTOR_BASE_VALUE) / SECTOR_BASE_VALUE) * 100;

    // 5D return matching SectorMiniChart: it fetches 5 bars with limit=5,
    // where the last bar includes the live overlay. That gives a window of
    // [anchor, ..., liveValue]. When the overlay is active (today not yet
    // stored), liveValue is an EXTRA day beyond stored bars, so the anchor
    // is 4 stored bars back. Without overlay, liveValue = last stored close,
    // so anchor is 5 stored bars back.
    const todayStored = dailyAsc[dailyAsc.length - 1]?.date === liveAsOf;
    const lookback = (live && !todayStored) ? 4 : 5;
    const fiveDayAnchorIdx = Math.max(0, dailyAsc.length - lookback);
    const fiveDayAnchor = dailyAsc[fiveDayAnchorIdx]?.close;
    const fiveDayPct = fiveDayAnchor > 0
      ? ((liveValue - fiveDayAnchor) / fiveDayAnchor) * 100
      : null;

    if (!asOf || liveAsOf > asOf) asOf = liveAsOf;

    return {
      ...meta,
      ok:           true,
      value:        parseFloat(liveValue.toFixed(2)),
      valueSource:  live ? 'live' : 'stored',
      open:         parseFloat(liveOpen.toFixed(2)),
      high:         parseFloat(liveHigh.toFixed(2)),
      low:          parseFloat(liveLow.toFixed(2)),
      dayChangePct: parseFloat(dayChangePct.toFixed(2)),
      fiveDayPct:   fiveDayPct != null ? parseFloat(fiveDayPct.toFixed(2)) : null,
      ytdPct:       ytdPct != null ? parseFloat(ytdPct.toFixed(2)) : null,
      inceptionPct: parseFloat(inceptionPct.toFixed(2)),
      emaDaily:     lastEmaD != null ? parseFloat(lastEmaD.toFixed(2)) : null,
      emaWeekly:    lastEmaW != null ? parseFloat(lastEmaW.toFixed(2)) : null,
      emaDailyPeriod:  dailyPeriod,
      emaWeeklyPeriod: weeklyPeriod,
      regime,
      asOf:         liveAsOf,
      barCount:     { daily: dailyAsc.length, weekly: weeklyAsc.length },
    };
  });

  // Sort by inception return desc — best-performing AI sectors first.
  sectors.sort((a, b) => (b.inceptionPct ?? -Infinity) - (a.inceptionPct ?? -Infinity));

  const out = {
    ok:        true,
    asOf,
    baseDate:  SECTOR_BASE_DATE,
    baseValue: SECTOR_BASE_VALUE,
    sectors,
  };
  cacheLatest = out; cacheLatestAt = now;
  return out;
}

// Per-sector bars + EMA for chart modal. timeframe = 'daily' | 'weekly'.
//
// Stored bars come from the cron-written sector candle collection. Today's
// intraday bar is synthesized via the shared aiIntradayOverlay helper using
// this sector's capped weights × constituent live quotes — same math as the
// 16-card grid and PAI300 chart. Bars cache stays at 5 min (covers stored
// data); the live overlay re-runs every call (overlay quote cache is 30s
// inside the helper, so a cluster of sector-chart opens hits FMP once).
export async function getPnthrAiSectorBars({ sectorId, timeframe = 'daily', limit = null } = {}) {
  const cacheKey = `${sectorId}:${timeframe}`;
  let stored = cacheBars.get(cacheKey);
  // Re-fetch bars from Mongo only when the stored cache is cold; otherwise
  // reuse the stored series and rerun just the live overlay each call.
  if (!stored || (Date.now() - stored.ts) >= CACHE_MS) {
    const db = await connectToDatabase();
    if (!db) return { ok: false, bars: [] };
    const ticker = sectorTicker(sectorId);
    const coll   = timeframe === 'weekly' ? COLL_SECTOR_WEEKLY : COLL_SECTOR_DAILY;
    const doc    = await db.collection(coll).findOne({ ticker });
    if (!doc) return { ok: false, bars: [] };
    const series   = timeframe === 'weekly' ? doc.weekly : doc.daily;
    const labelKey = timeframe === 'weekly' ? 'weekOf'   : 'date';
    const asc      = [...series].sort((a, b) => a[labelKey].localeCompare(b[labelKey]));
    stored = { ts: Date.now(), asc, ticker, labelKey };
    cacheBars.set(cacheKey, stored);
  }
  const { asc, ticker, labelKey } = stored;

  const period = timeframe === 'weekly'
    ? (SECTOR_EMA_WEEKLY_PERIODS[sectorId] ?? 30)
    : (SECTOR_EMA_DAILY_PERIODS[sectorId]  ?? 21);

  // Live overlay for this sector. Anchor uses the daily series' last close
  // since daily is always the most recent; for weekly timeframe we need to
  // pull daily separately to anchor properly.
  let augmented = asc.slice();
  try {
    const allWeights    = await loadAllSectorWeights();
    const sectorWeights = allWeights ? allWeights[sectorId] : null;
    if (sectorWeights) {
      // Need daily anchor close (most recent stored daily close for THIS sector).
      let anchorClose = null;
      if (timeframe === 'daily') {
        anchorClose = asc[asc.length - 1]?.close ?? null;
      } else {
        const db = await connectToDatabase();
        const doc = db ? await db.collection(COLL_SECTOR_DAILY).findOne({ ticker }) : null;
        const dseries = doc?.daily || [];
        const dasc = [...dseries].sort((a, b) => a.date.localeCompare(b.date));
        anchorClose = dasc[dasc.length - 1]?.close ?? null;
      }
      if (anchorClose != null) {
        const tickers = Object.keys(sectorWeights).filter(t => sectorWeights[t] > 0);
        // Reuse the shared all-universe quote cache when present (the grid
        // page populates it); fall back to a sector-scoped cache otherwise.
        const qmap = await fetchAiQuotesBatch(tickers, { cacheKey: 'ai-universe-all' });
        const intraday = computeIntradayBar({
          weights: sectorWeights, lastClose: anchorClose, quoteMap: qmap,
        });
        if (intraday.ok) {
          augmented = timeframe === 'weekly'
            ? spliceTodayWeekly(asc, intraday)
            : spliceTodayDaily(asc,  intraday);
        }
      }
    }
  } catch (err) {
    console.warn(`[AI Sector ${sectorId}] bars overlay failed; rendering stored bars only:`, err.message);
  }

  const closes    = augmented.map(b => b.close);
  const emaSeries = computeEMA(closes, period);

  const sectorMeta = SECTORS.find(s => s.id === sectorId);
  let bars = augmented.map((b, i) => ({
    date:   b[labelKey],
    open:   b.open,
    high:   b.high,
    low:    b.low,
    close:  b.close,
    volume: b.volume || 0,
    ema:    emaSeries[i] != null ? parseFloat(emaSeries[i].toFixed(2)) : null,
  }));
  if (limit && bars.length > limit) bars = bars.slice(-limit);

  return {
    ok:           true,
    timeframe,
    sectorId,
    sectorName:   sectorMeta?.name || `Sector ${sectorId}`,
    ticker,
    emaPeriod:    period,
    targetWeight: sectorMeta?.weight ?? null,
    holdingCount: sectorMeta?.holdings?.length ?? null,
    bars,
  };
}

// Per-sector constituents list (the holdings inside that sector). Used by
// the "click sector card" modal to show what's actually in it.
export async function getPnthrAiSectorConstituents({ sectorId } = {}) {
  const sec = SECTORS.find(s => s.id === sectorId);
  if (!sec) return { ok: false, error: 'Unknown sector' };
  return {
    ok:           true,
    sectorId,
    sectorName:   sec.name,
    targetWeight: sec.weight,
    holdings: sec.holdings.map(h => ({ ticker: h.ticker, name: h.name })),
  };
}

// Imperative wrapper for the daily cron — re-runs both backfill scripts.
export async function runPnthrAiSectorsDailyAppend() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  const path = (await import('node:path')).default;
  const url  = (await import('node:url')).default;

  const dailyPath  = url.fileURLToPath(new URL('./scripts/aiUniverse/buildPnthrAiSectorIndices.js',       import.meta.url));
  const weeklyPath = url.fileURLToPath(new URL('./scripts/aiUniverse/buildPnthrAiSectorIndicesWeekly.js', import.meta.url));
  const cwd = path.dirname(dailyPath);

  console.log('[AI Sectors] running daily rebuild…');
  const t0 = Date.now();
  try {
    const { stdout: o1 } = await exec('node', [dailyPath],  { cwd, maxBuffer: 10 * 1024 * 1024 });
    const { stdout: o2 } = await exec('node', [weeklyPath], { cwd, maxBuffer: 10 * 1024 * 1024 });
    clearPnthrAiSectorsCache();
    console.log(`[AI Sectors] rebuild done in ${((Date.now()-t0)/1000).toFixed(1)}s`);
    const tail = (s) => s.split('\n').filter(Boolean).slice(-3).join(' | ');
    return { ok: true, runtimeSec: (Date.now()-t0)/1000, daily: tail(o1), weekly: tail(o2) };
  } catch (err) {
    console.error('[AI Sectors] rebuild failed:', err.message);
    return { ok: false, error: err.message };
  }
}
