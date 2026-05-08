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

const CACHE_MS = 5 * 60 * 1000;
let cacheLatest = null; let cacheLatestAt = 0;
const cacheBars = new Map(); // key = `${sectorId}:${timeframe}` → { data, ts }

export function clearPnthrAiSectorsCache() {
  cacheLatest = null; cacheLatestAt = 0;
  cacheBars.clear();
}

// Latest snapshot for all 16 sectors — for the AI Sectors grid page.
// Returns { ok, asOf, sectors: [{ id, ticker, name, value, dayChangePct, ytdPct, inceptionPct, ema21D, emaW, regime, ... }] }
export async function getPnthrAiSectorsLatest() {
  const now = Date.now();
  if (cacheLatest && (now - cacheLatestAt) < CACHE_MS) return cacheLatest;

  const db = await connectToDatabase();
  if (!db) return { ok: false, error: 'Mongo connect failed' };

  const dailyCol  = db.collection(COLL_SECTOR_DAILY);
  const weeklyCol = db.collection(COLL_SECTOR_WEEKLY);

  const [dailyDocs, weeklyDocs] = await Promise.all([
    dailyCol.find({ ticker: /^PAI_S/ }).toArray(),
    weeklyCol.find({ ticker: /^PAI_S/ }).toArray(),
  ]);

  const dailyByTicker  = Object.fromEntries(dailyDocs.map(d => [d.ticker, d]));
  const weeklyByTicker = Object.fromEntries(weeklyDocs.map(d => [d.ticker, d]));

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
    const dayChangePct = prevDaily ? ((lastDaily.close - prevDaily.close) / prevDaily.close) * 100 : 0;

    const dailyPeriod  = SECTOR_EMA_DAILY_PERIODS[meta.id]  ?? 21;
    const weeklyPeriod = SECTOR_EMA_WEEKLY_PERIODS[meta.id] ?? 30;
    const emaD = computeEMA(dailyAsc.map(b => b.close),  dailyPeriod);
    const emaW = computeEMA(weeklyAsc.map(b => b.close), weeklyPeriod);
    const lastEmaD = emaD[emaD.length - 1] ?? null;
    const lastEmaW = emaW[emaW.length - 1] ?? null;

    const regime = (lastEmaW != null && lastDaily.close >= lastEmaW) ? 'bull' : 'bear';

    const ytdSeed = dailyAsc.find(b => b.date >= yearStart);
    const ytdPct  = ytdSeed ? ((lastDaily.close - ytdSeed.close) / ytdSeed.close) * 100 : null;
    const inceptionPct = ((lastDaily.close - SECTOR_BASE_VALUE) / SECTOR_BASE_VALUE) * 100;

    if (!asOf || lastDaily.date > asOf) asOf = lastDaily.date;

    return {
      ...meta,
      ok:           true,
      value:        parseFloat(lastDaily.close.toFixed(2)),
      open:         parseFloat(lastDaily.open.toFixed(2)),
      high:         parseFloat(lastDaily.high.toFixed(2)),
      low:          parseFloat(lastDaily.low.toFixed(2)),
      dayChangePct: parseFloat(dayChangePct.toFixed(2)),
      ytdPct:       ytdPct != null ? parseFloat(ytdPct.toFixed(2)) : null,
      inceptionPct: parseFloat(inceptionPct.toFixed(2)),
      emaDaily:     lastEmaD != null ? parseFloat(lastEmaD.toFixed(2)) : null,
      emaWeekly:    lastEmaW != null ? parseFloat(lastEmaW.toFixed(2)) : null,
      emaDailyPeriod:  dailyPeriod,
      emaWeeklyPeriod: weeklyPeriod,
      regime,
      asOf:         lastDaily.date,
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
export async function getPnthrAiSectorBars({ sectorId, timeframe = 'daily', limit = null } = {}) {
  const cacheKey = `${sectorId}:${timeframe}`;
  const cached = cacheBars.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < CACHE_MS) {
    if (limit && cached.data?.bars && cached.data.bars.length > limit) {
      return { ...cached.data, bars: cached.data.bars.slice(-limit) };
    }
    return cached.data;
  }

  const db = await connectToDatabase();
  if (!db) return { ok: false, bars: [] };
  const ticker = sectorTicker(sectorId);
  const coll   = timeframe === 'weekly' ? COLL_SECTOR_WEEKLY : COLL_SECTOR_DAILY;
  const doc    = await db.collection(coll).findOne({ ticker });
  if (!doc) return { ok: false, bars: [] };

  const period = timeframe === 'weekly'
    ? (SECTOR_EMA_WEEKLY_PERIODS[sectorId] ?? 30)
    : (SECTOR_EMA_DAILY_PERIODS[sectorId]  ?? 21);

  const series   = timeframe === 'weekly' ? doc.weekly : doc.daily;
  const labelKey = timeframe === 'weekly' ? 'weekOf'   : 'date';
  const asc      = [...series].sort((a, b) => a[labelKey].localeCompare(b[labelKey]));
  const closes   = asc.map(b => b.close);
  const emaSeries = computeEMA(closes, period);

  const sectorMeta = SECTORS.find(s => s.id === sectorId);
  const bars = asc.map((b, i) => ({
    date:   b[labelKey],
    open:   b.open,
    high:   b.high,
    low:    b.low,
    close:  b.close,
    volume: b.volume || 0,
    ema:    emaSeries[i] != null ? parseFloat(emaSeries[i].toFixed(2)) : null,
  }));

  const out = {
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
  cacheBars.set(cacheKey, { data: out, ts: Date.now() });

  if (limit && out.bars.length > limit) {
    return { ...out, bars: out.bars.slice(-limit) };
  }
  return out;
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
