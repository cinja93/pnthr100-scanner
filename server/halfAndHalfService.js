// server/halfAndHalfService.js
// ── "Half and Half" board — AI 300 universe split four ways ─────────────────
//
// Classifies every AI-300 name by where its PRICE sits versus its EMA line, on
// two timeframes, producing four buckets:
//
//   Daily Short   — current price BELOW the daily EMA
//   Daily Long    — current price ABOVE the daily EMA
//   Weekly Short  — current price BELOW the weekly EMA
//   Weekly Long   — current price ABOVE the weekly EMA
//
// The EMA definition is identical to the dual-pane chart modal
// (aiUniverseStockChartService.js): per-sector EMA period (default 30W, or the
// carnivore period when a name is in carnivore mode), applied to the daily bars
// for the daily line and the weekly bars for the weekly line, with a 21-period
// fallback when a name has too little history. That way a name's bucket always
// agrees with the EMA line the user sees after clicking into its chart.
//
// Bars are read in bulk from the same end-of-day collections the chart uses
// (pnthr_ai_bt_candles / _weekly). The CURRENT price is overlaid live from one
// batched FMP /quote call so the comparison reflects today's tape, not just
// yesterday's close.
// ────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';
import { calculateEMA } from './signalDetection.js';
import { SECTORS } from './scripts/aiUniverse/aiUniverseData.js';
import { SECTOR_EMA_PERIODS } from './data/pnthrAiSectorsConfig.js';
import { isCarnivoreMode, getCarnivoreEmaPeriod } from './data/strategyMode.js';
import { fetchFMP } from './stockService.js';

// ticker → { sectorId, sectorName, name }
const TICKER_META = {};
for (const sec of SECTORS) {
  for (const h of sec.holdings) {
    TICKER_META[h.ticker] = { sectorId: sec.id, sectorName: sec.name, name: h.name };
  }
}
const AI_TICKERS = Object.keys(TICKER_META);

// EOD bars don't move intraday, so a short cache is plenty. The live-quote
// overlay refreshes on each miss.
const CACHE_MS = 60 * 1000;
let _cache = null;
let _cacheAt = 0;

export function clearHalfAndHalfCache() { _cache = null; _cacheAt = 0; }

// Mirror of the chart's period resolution (aiUniverseStockChartService.js).
function sectorPeriodFor(ticker, sectorId) {
  if (isCarnivoreMode(ticker)) return getCarnivoreEmaPeriod(ticker) || 30;
  return SECTOR_EMA_PERIODS[sectorId] || 30;
}
function pickPeriod(barCount, sectorPeriod) {
  if (barCount >= sectorPeriod * 3) return sectorPeriod;
  if (barCount >= 21 + 2)           return 21;
  return null;
}

// Last EMA value for a set of bars at the resolved period, or null.
function lastEma(bars, period) {
  if (!period) return null;
  const series = calculateEMA(bars.map(b => ({ time: b.date || b.weekOf, close: b.close })), period);
  if (!series.length) return null;
  return series[series.length - 1].value;
}

// A bar tail older than this is a delisted/frozen name — drop it from the board.
const STALE_DAYS = 14;
function isStale(lastDateStr) {
  if (!lastDateStr) return true;
  const ms = Date.parse(lastDateStr + 'T00:00:00Z');
  if (Number.isNaN(ms)) return true;
  return (Date.now() - ms) > STALE_DAYS * 24 * 60 * 60 * 1000;
}

// One batched live-quote map: ticker → price. Chunked to keep URLs sane.
async function fetchLivePrices(tickers) {
  const out = {};
  const CHUNK = 100;
  for (let i = 0; i < tickers.length; i += CHUNK) {
    const batch = tickers.slice(i, i + CHUNK);
    try {
      const arr = await fetchFMP(`/quote/${batch.join(',')}`);
      if (Array.isArray(arr)) {
        for (const q of arr) {
          if (q && typeof q.price === 'number') out[q.symbol] = q.price;
        }
      }
    } catch { /* leave these tickers to fall back to last stored close */ }
  }
  return out;
}

export async function getHalfAndHalf() {
  if (_cache && (Date.now() - _cacheAt) < CACHE_MS) return _cache;

  const db = await connectToDatabase();
  if (!db) return { ok: false, error: 'Mongo connect failed' };

  const [dailyDocs, weeklyDocs, livePrices] = await Promise.all([
    db.collection('pnthr_ai_bt_candles').find({}, { projection: { ticker: 1, daily: 1 } }).toArray(),
    db.collection('pnthr_ai_bt_candles_weekly').find({}, { projection: { ticker: 1, weekly: 1 } }).toArray(),
    fetchLivePrices(AI_TICKERS),
  ]);

  const dailyByTicker  = new Map(dailyDocs.map(d => [d.ticker, d.daily || []]));
  const weeklyByTicker = new Map(weeklyDocs.map(d => [d.ticker, d.weekly || []]));

  const dailyShorts = [], dailyLongs = [], weeklyShorts = [], weeklyLongs = [];

  for (const ticker of AI_TICKERS) {
    const meta = TICKER_META[ticker];
    const sectorPeriod = sectorPeriodFor(ticker, meta.sectorId);
    const live = livePrices[ticker];

    // ── Daily ──
    const dRaw = dailyByTicker.get(ticker) || [];
    if (dRaw.length) {
      const dAsc = [...dRaw].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      const lastBar = dAsc[dAsc.length - 1];
      if (!isStale(lastBar?.date)) {
        const ema = lastEma(dAsc, pickPeriod(dAsc.length, sectorPeriod));
        const price = (typeof live === 'number') ? live : lastBar.close;
        if (ema != null && price != null) {
          const distPct = +(((price - ema) / ema) * 100).toFixed(2);
          const row = {
            ticker, name: meta.name, sector: meta.sectorName,
            price: +price.toFixed(2), ema: +ema.toFixed(2), distPct,
          };
          (price < ema ? dailyShorts : dailyLongs).push(row);
        }
      }
    }

    // ── Weekly ──
    const wRaw = weeklyByTicker.get(ticker) || [];
    if (wRaw.length) {
      const wAsc = [...wRaw].sort((a, b) => (a.weekOf || '').localeCompare(b.weekOf || ''));
      const lastBar = wAsc[wAsc.length - 1];
      if (!isStale(lastBar?.weekOf)) {
        const ema = lastEma(wAsc, pickPeriod(wAsc.length, sectorPeriod));
        const price = (typeof live === 'number') ? live : lastBar.close;
        if (ema != null && price != null) {
          const distPct = +(((price - ema) / ema) * 100).toFixed(2);
          const row = {
            ticker, name: meta.name, sector: meta.sectorName,
            price: +price.toFixed(2), ema: +ema.toFixed(2), distPct,
          };
          (price < ema ? weeklyShorts : weeklyLongs).push(row);
        }
      }
    }
  }

  // Shorts: most-below the EMA first (most negative distPct). Longs: most-above first.
  dailyShorts.sort((a, b) => a.distPct - b.distPct);
  weeklyShorts.sort((a, b) => a.distPct - b.distPct);
  dailyLongs.sort((a, b) => b.distPct - a.distPct);
  weeklyLongs.sort((a, b) => b.distPct - a.distPct);

  const result = {
    ok: true,
    universe: 'ai300',
    dailyShorts, dailyLongs, weeklyShorts, weeklyLongs,
    counts: {
      dailyShorts: dailyShorts.length, dailyLongs: dailyLongs.length,
      weeklyShorts: weeklyShorts.length, weeklyLongs: weeklyLongs.length,
    },
    updatedAt: new Date().toISOString(),
  };

  _cache = result;
  _cacheAt = Date.now();
  return result;
}
