// server/aiUniverseStockChartService.js
// ── Per-stock chart data for any AI Universe ticker ────────────────────────
//
// Returns daily + weekly OHLC bars + EMA overlay + BL/SS/BE/SE signal events
// for a single AI Universe stock. Powers the side-by-side daily/weekly chart
// modal opened from the AI 300 Index table and AI Sector chart modal.
//
// Each stock uses its AI sector's tunable EMA period (per pnthrAiSectorsConfig)
// applied to both timeframes (weekly bars = period as weeks, daily bars =
// same number as days).
//
// Reads from pnthr_ai_bt_candles (daily) + pnthr_ai_bt_candles_weekly (weekly).
// Cached 5 min keyed by ticker. Zero touch to 679 collections.
// ────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';
import { detectAllSignals, calculateEMA } from './signalDetection.js';
import { SECTORS } from './scripts/aiUniverse/aiUniverseData.js';
import { SECTOR_EMA_PERIODS } from './data/pnthrAiSectorsConfig.js';

// Build ticker → { sectorId, sectorName, name } lookup once
const TICKER_META = {};
for (const sec of SECTORS) {
  for (const h of sec.holdings) {
    TICKER_META[h.ticker] = {
      sectorId:   sec.id,
      sectorName: sec.name,
      name:       h.name,
    };
  }
}

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();   // ticker → { data, ts }

export function clearAiStockChartCache(ticker = null) {
  if (ticker) cache.delete(ticker);
  else cache.clear();
}

function emaSeriesAlignedTo(bars, period) {
  // Returns array same length as bars, with null until period-1, then EMA values.
  const ema = new Array(bars.length).fill(null);
  if (bars.length < period) return ema;
  const series = calculateEMA(bars.map(b => ({ time: b.date || b.weekOf, close: b.close })), period);
  for (let i = 0; i < series.length; i++) {
    const idx = period - 1 + i;
    if (idx < ema.length) ema[idx] = series[i].value;
  }
  return ema;
}

export async function getAiStockChartData(ticker) {
  ticker = (ticker || '').toUpperCase();
  const meta = TICKER_META[ticker];
  if (!meta) return { ok: false, error: `Unknown AI Universe ticker: ${ticker}` };

  const cached = cache.get(ticker);
  if (cached && (Date.now() - cached.ts) < CACHE_MS) return cached.data;

  const db = await connectToDatabase();
  if (!db) return { ok: false, error: 'Mongo connect failed' };

  const sectorPeriod = SECTOR_EMA_PERIODS[meta.sectorId] || 30;

  // Pull both bar series in parallel
  const [dailyDoc, weeklyDoc] = await Promise.all([
    db.collection('pnthr_ai_bt_candles').findOne({ ticker }),
    db.collection('pnthr_ai_bt_candles_weekly').findOne({ ticker }),
  ]);

  const dailyRaw  = dailyDoc?.daily   || [];
  const weeklyRaw = weeklyDoc?.weekly || [];

  // Sort ascending for chart consumption
  const dailyAsc  = [...dailyRaw].sort((a, b) => a.date.localeCompare(b.date));
  const weeklyAsc = [...weeklyRaw].sort((a, b) => a.weekOf.localeCompare(b.weekOf));

  // Stale-data guard: if the last available bar is > 14 days old, the ticker
  // has been delisted/acquired and signals on the frozen tail are meaningless.
  // We still return the historical bars so the chart can render context, but
  // we suppress signal events + currentSignal + pnthrStop and flag the data
  // as stale.
  const STALE_DAYS = 14;
  const todayMs = Date.now();
  function isStale(lastDate) {
    if (!lastDate) return true;
    const lastMs = Date.parse(lastDate + 'T00:00:00Z');
    if (isNaN(lastMs)) return true;
    return (todayMs - lastMs) > STALE_DAYS * 24 * 60 * 60 * 1000;
  }
  const lastDailyBar  = dailyAsc[dailyAsc.length - 1];
  const lastWeeklyBar = weeklyAsc[weeklyAsc.length - 1];
  const dailyStaleData  = isStale(lastDailyBar?.date);
  const weeklyStaleData = isStale(lastWeeklyBar?.weekOf);

  // Recent-IPO fallback: to use the sector's tuned period we need ~3× history
  // (so EMA has settled and produces meaningful crosses). Otherwise fall back
  // to 21W per Scott's "21 as a standard" rule. Chart label surfaces which
  // period was actually used for transparency ("21W (fallback, short history)").
  function pickPeriod(barCount) {
    if (barCount >= sectorPeriod * 3) return sectorPeriod;
    if (barCount >= 21 + 2)           return 21;
    return null;
  }
  const dailyPeriod  = !dailyStaleData  ? pickPeriod(dailyAsc.length)  : null;
  const weeklyPeriod = !weeklyStaleData ? pickPeriod(weeklyAsc.length) : null;

  // Compute EMA series aligned to bars (using whichever period was picked)
  const dailyEma  = dailyPeriod  ? emaSeriesAlignedTo(dailyAsc,  dailyPeriod)  : new Array(dailyAsc.length).fill(null);
  const weeklyEma = weeklyPeriod ? emaSeriesAlignedTo(weeklyAsc, weeklyPeriod) : new Array(weeklyAsc.length).fill(null);

  // Run signal state machine on each (its picked period applied to its own bars)
  const dailySigBars  = dailyAsc.map(b => ({ time: b.date,   open: b.open, high: b.high, low: b.low, close: b.close }));
  const weeklySigBars = weeklyAsc.map(b => ({ time: b.weekOf, open: b.open, high: b.high, low: b.low, close: b.close }));

  const dailyDetect  = dailyPeriod  ? detectAllSignals(dailySigBars,  dailyPeriod,  false) : { events: [], pnthrStop: null, currentSignal: null, activeType: null };
  const weeklyDetect = weeklyPeriod ? detectAllSignals(weeklySigBars, weeklyPeriod, false) : { events: [], pnthrStop: null, currentSignal: null, activeType: null };

  // Last bar info per timeframe
  const lastDaily  = dailyAsc[dailyAsc.length - 1] || null;
  const lastWeekly = weeklyAsc[weeklyAsc.length - 1] || null;

  // Day change %
  const prevDaily = dailyAsc.length >= 2 ? dailyAsc[dailyAsc.length - 2] : null;
  const dayChangePct = (lastDaily && prevDaily)
    ? ((lastDaily.close - prevDaily.close) / prevDaily.close) * 100
    : null;

  const out = {
    ok:           true,
    ticker,
    name:         meta.name,
    sectorId:     meta.sectorId,
    sectorName:   meta.sectorName,
    emaPeriod:        sectorPeriod,    // canonical sector period
    dailyEmaPeriod:   dailyPeriod,     // period actually used for daily (may be 21W fallback)
    weeklyEmaPeriod:  weeklyPeriod,    // period actually used for weekly (may be 21W fallback)
    fallbackDaily:    dailyPeriod  != null && dailyPeriod  !== sectorPeriod,
    fallbackWeekly:   weeklyPeriod != null && weeklyPeriod !== sectorPeriod,
    staleDaily:       dailyStaleData,
    staleWeekly:      weeklyStaleData,
    asOf:         lastDaily?.date || null,
    currentPrice: lastDaily ? parseFloat(lastDaily.close.toFixed(2)) : null,
    dayChangePct: dayChangePct != null ? parseFloat(dayChangePct.toFixed(2)) : null,
    daily: {
      bars: dailyAsc.map((b, i) => ({
        date:   b.date,
        open:   b.open,
        high:   b.high,
        low:    b.low,
        close:  b.close,
        volume: b.volume || 0,
        ema:    dailyEma[i] != null ? parseFloat(dailyEma[i].toFixed(2)) : null,
      })),
      signals:       dailyDetect.events,
      currentSignal: dailyDetect.activeType || dailyDetect.currentSignal || null,
      pnthrStop:     dailyDetect.activeType ? dailyDetect.pnthrStop : null,
    },
    weekly: {
      bars: weeklyAsc.map((b, i) => ({
        date:   b.weekOf,
        open:   b.open,
        high:   b.high,
        low:    b.low,
        close:  b.close,
        volume: b.volume || 0,
        ema:    weeklyEma[i] != null ? parseFloat(weeklyEma[i].toFixed(2)) : null,
      })),
      signals:       weeklyDetect.events,
      currentSignal: weeklyDetect.activeType || weeklyDetect.currentSignal || null,
      pnthrStop:     weeklyDetect.activeType ? weeklyDetect.pnthrStop : null,
    },
  };

  cache.set(ticker, { data: out, ts: Date.now() });
  return out;
}
