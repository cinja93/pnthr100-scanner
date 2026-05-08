// server/aiUniverseSignalsService.js
// ── PNTHR AI Universe — per-stock BL/SS/BE/SE signals + PNTHR Stops ────────
//
// Architecture (Scott's locked rule):
//   • Each stock lives in exactly one AI sector (per aiUniverseData.js)
//   • That sector has a tunable EMA period (per pnthrAiSectorsConfig.js)
//   • Weekly signal: state machine on weekly bars + that sector's EMA period
//   • Daily signal:  state machine on daily bars  + same sector's EMA period
//                    (period is a NUMBER, applied to whatever bars you feed it)
//   • Regime gate is PAI300 (NOT SPY/QQQ/MDY) — wired in the Kill service (D1)
//   • Zero involvement of S&P 500 GICS sectors, XLK, or 679-system EMA logic
//
// Returns the same shape the client StockTable expects:
//   { signals:      { [ticker]: { signal, signalDate, isNewSignal, stopPrice } },
//     dailySignals: { [ticker]: { signal, signalDate, isNewSignal } } }
// ────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';
import { detectAllSignals } from './signalDetection.js';
import { SECTORS } from './scripts/aiUniverse/aiUniverseData.js';
import { SECTOR_EMA_PERIODS } from './data/pnthrAiSectorsConfig.js';

// Build ticker → sectorId lookup once at module load.
const TICKER_TO_SECTOR_ID = {};
for (const sec of SECTORS) {
  for (const h of sec.holdings) {
    TICKER_TO_SECTOR_ID[h.ticker] = sec.id;
  }
}

// ── Cache ──
let cache = null; let cacheAt = 0;
const CACHE_MS = 5 * 60 * 1000;
export function clearAiUniverseSignalsCache() { cache = null; cacheAt = 0; }

// ── Main ──
export async function getAiUniverseSignals({ refresh = false } = {}) {
  const now = Date.now();
  if (cache && !refresh && (now - cacheAt) < CACHE_MS) return cache;

  const db = await connectToDatabase();
  if (!db) return { signals: {}, dailySignals: {} };

  // Pull all daily + weekly docs in two batch queries (faster than N round trips)
  const tickers = Object.keys(TICKER_TO_SECTOR_ID);
  const [dailyDocs, weeklyDocs] = await Promise.all([
    db.collection('pnthr_ai_bt_candles')
      .find({ ticker: { $in: tickers } }, { projection: { ticker: 1, daily: 1 } })
      .toArray(),
    db.collection('pnthr_ai_bt_candles_weekly')
      .find({ ticker: { $in: tickers } }, { projection: { ticker: 1, weekly: 1 } })
      .toArray(),
  ]);
  const dailyByTicker  = Object.fromEntries(dailyDocs.map(d => [d.ticker, d.daily || []]));
  const weeklyByTicker = Object.fromEntries(weeklyDocs.map(d => [d.ticker, d.weekly || []]));

  const signals      = {};
  const dailySignals = {};
  let withWeeklySig = 0, withDailySig = 0, openLongs = 0, openShorts = 0;

  // For recent IPOs (e.g. SNDK, CRWV) the sector's long EMA period (e.g. 30W)
  // can produce zero signals — even with sectorPeriod + 2 bars the state machine
  // hasn't had room to detect a legit cross. To use the sector's tuned period
  // we need ~3× history so the EMA has settled and crosses are meaningful.
  // Otherwise fall back to 21W per Scott's rule:
  //   "If nothing exists currently in our database, we will use the 21 as a
  //    standard for weekly too."
  function effectivePeriod(barCount, sectorPeriod) {
    if (barCount >= sectorPeriod * 3) return sectorPeriod;
    if (barCount >= 21 + 2)           return 21;
    return null;  // not enough bars even for the fallback — skip
  }

  for (const ticker of tickers) {
    const sectorId = TICKER_TO_SECTOR_ID[ticker];
    const period   = SECTOR_EMA_PERIODS[sectorId] || 30;  // sector-tuned period (number)

    // ── Weekly signal + PNTHR Stop ─────────────────────────────────────────
    const weeklyRaw = weeklyByTicker[ticker] || [];
    const wPeriod = effectivePeriod(weeklyRaw.length, period);
    if (wPeriod) {
      const weeklyAsc = [...weeklyRaw].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
      // Map to {time, ohlc} shape the state machine expects
      const wBars = weeklyAsc.map(b => ({
        time: b.weekOf, open: b.open, high: b.high, low: b.low, close: b.close,
      }));
      const { events, pnthrStop, currentSignal, activeType } = detectAllSignals(wBars, wPeriod, false);
      const lastBarTime = wBars[wBars.length - 1].time;
      const lastEvent   = events[events.length - 1];
      const isNewSignal = lastEvent && lastEvent.time === lastBarTime;

      const finalSignal = activeType || currentSignal || (lastEvent ? lastEvent.signal : null);
      const finalDate   = lastEvent ? lastEvent.time : null;

      if (finalSignal) {
        signals[ticker] = {
          signal:       finalSignal,
          signalDate:   finalDate,
          isNewSignal:  !!isNewSignal,
          stopPrice:    activeType ? pnthrStop : null,  // only carry stop when position is open
        };
        withWeeklySig++;
        if (activeType === 'BL') openLongs++;
        if (activeType === 'SS') openShorts++;
      }
    }

    // ── Daily signal (same sector period, daily bars) ──────────────────────
    const dailyRaw = dailyByTicker[ticker] || [];
    const dPeriod = effectivePeriod(dailyRaw.length, period);
    if (dPeriod) {
      const dailyAsc = [...dailyRaw].sort((a, b) => a.date.localeCompare(b.date));
      const dBars = dailyAsc.map(b => ({
        time: b.date, open: b.open, high: b.high, low: b.low, close: b.close,
      }));
      const { events, currentSignal, activeType } = detectAllSignals(dBars, dPeriod, false);
      const lastBarTime = dBars[dBars.length - 1].time;
      const lastEvent   = events[events.length - 1];
      const isNewSignal = lastEvent && lastEvent.time === lastBarTime;

      const finalSignal = activeType || currentSignal || (lastEvent ? lastEvent.signal : null);
      const finalDate   = lastEvent ? lastEvent.time : null;

      if (finalSignal) {
        dailySignals[ticker] = {
          signal:       finalSignal,
          signalDate:   finalDate,
          isNewSignal:  !!isNewSignal,
        };
        withDailySig++;
      }
    }
  }

  console.log(`🧠 AI Universe signals: weekly=${withWeeklySig}/${tickers.length} (BL=${openLongs}, SS=${openShorts}), daily=${withDailySig}/${tickers.length}`);
  const out = { signals, dailySignals };
  cache = out; cacheAt = now;
  return out;
}
