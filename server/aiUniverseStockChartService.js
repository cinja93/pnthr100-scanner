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
import { fetchFMP } from './stockService.js';

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

// 30s cache matches the AI Universe table cadence so the modal header price
// stays in lockstep with the table. Bars themselves are end-of-day Mongo data
// (don't change intraday) but currentPrice + dayChangePct are pulled live from
// FMP /quote on every cache miss — see fetch below.
const CACHE_MS = 30 * 1000;
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

  // Pull both bar series + live quote in parallel.
  // Bars are end-of-day historical (Mongo) — used for chart rendering and
  // signal state machine. Live quote is FMP — used for the modal header
  // currentPrice + day-change %. Pulling them together keeps one round trip.
  const [dailyDoc, weeklyDoc, liveQuoteArr] = await Promise.all([
    db.collection('pnthr_ai_bt_candles').findOne({ ticker }),
    db.collection('pnthr_ai_bt_candles_weekly').findOne({ ticker }),
    fetchFMP(`/quote/${ticker}`).catch(() => null),
  ]);
  const liveQuote = Array.isArray(liveQuoteArr) && liveQuoteArr.length > 0 ? liveQuoteArr[0] : null;

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

  // Daily uses 0.3% daylight zone (vs 1% weekly) — daily ranges are tighter
  // than weekly so the 1% threshold starves daily signals on chop-zone names.
  const dailyDetect  = dailyPeriod  ? detectAllSignals(dailySigBars,  dailyPeriod,  false, 0.003) : { events: [], pnthrStop: null, currentSignal: null, activeType: null };
  const weeklyDetect = weeklyPeriod ? detectAllSignals(weeklySigBars, weeklyPeriod, false)        : { events: [], pnthrStop: null, currentSignal: null, activeType: null };

  // Last bar info per timeframe
  const lastDaily  = dailyAsc[dailyAsc.length - 1] || null;
  const lastWeekly = weeklyAsc[weeklyAsc.length - 1] || null;

  // Header price + day change come from live FMP quote, not the latest bar.
  // The previous code echoed lastDaily.close as "current price" — during the
  // trading day before the 5:30pm cron appends today's bar, that's yesterday's
  // close (e.g. SNDK showed $1,339.96 in the modal while the live tape was at
  // $1,510). Pull live quote and compute day change against yesterday's close.
  // Fall back to bar-based math if FMP is unreachable (offline / rate-limited).
  const prevDaily = dailyAsc.length >= 2 ? dailyAsc[dailyAsc.length - 2] : null;
  let livePrice    = (liveQuote && typeof liveQuote.price === 'number') ? liveQuote.price : null;
  let dayChangePct = null;
  if (livePrice != null && lastDaily) {
    // Today's % move = (live - yesterday's close) / yesterday's close. lastDaily
    // IS yesterday's bar during RTH (today's bar lands at 5:30pm cron). Once
    // today's bar lands, lastDaily becomes today's bar — in which case the math
    // (live - today's open close-stamped value) drifts; fall back to FMP's own
    // changesPercentage when FMP returns it (it's the canonical day move).
    if (typeof liveQuote.changesPercentage === 'number') {
      dayChangePct = liveQuote.changesPercentage;
    } else if (prevDaily) {
      dayChangePct = ((livePrice - lastDaily.close) / lastDaily.close) * 100;
    }
  } else if (lastDaily && prevDaily) {
    livePrice    = lastDaily.close;
    dayChangePct = ((lastDaily.close - prevDaily.close) / prevDaily.close) * 100;
  }

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
    currentPrice: livePrice != null ? parseFloat(livePrice.toFixed(2)) : null,
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
