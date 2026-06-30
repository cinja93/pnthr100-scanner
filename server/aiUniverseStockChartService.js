// server/aiUniverseStockChartService.js
// ── Per-stock chart data for ANY ticker (AI 300 + 679 + ETFs) ──────────────
//
// Returns daily + weekly OHLC bars + EMA overlay + BL/SS/BE/SE signal events
// for a single stock. Powers the side-by-side daily/weekly chart modal
// across the entire Den — AI 300 tickers use AI sector config; 679/ETF
// tickers use the 679 sector-optimized EMA (sectorEmaConfig.js).
//
// AI 300:  pnthr_ai_bt_candles (daily) + pnthr_ai_bt_candles_weekly (weekly)
// 679/ETF: pnthr_bt_candles    (daily) + pnthr_bt_candles_weekly    (weekly)
// ────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';
import { detectAllSignals, calculateEMA } from './signalDetection.js';
import { SECTORS } from './scripts/aiUniverse/aiUniverseData.js';
import { SECTOR_EMA_PERIODS } from './data/pnthrAiSectorsConfig.js';
import { getSectorEmaPeriod, getEtfEmaPeriod, ETF_TO_SECTOR } from './sectorEmaConfig.js';
import { fetchFMP } from './stockService.js';
import { isCarnivoreMode, getCarnivoreEmaPeriod, CARNIVORE_GATE_OFFSET } from './data/strategyMode.js';

// Build ticker → { sectorId, sectorName, name } lookup once
const TICKER_META = {};
for (const sec of SECTORS) {
  for (const h of sec.holdings) {
    TICKER_META[h.ticker] = {
      sectorId:   sec.id,
      sectorName: sec.name,
      name:       h.name,
      thesis:     h.thesis || null,   // the same brief description shown on AI Members
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
  const meta = TICKER_META[ticker]; // null for non-AI tickers

  const cached = cache.get(ticker);
  if (cached && (Date.now() - cached.ts) < CACHE_MS) return cached.data;

  const db = await connectToDatabase();
  if (!db) return { ok: false, error: 'Mongo connect failed' };

  // Determine which collections + EMA config to use
  const isAI = !!meta;
  const dailyCol  = isAI ? 'pnthr_ai_bt_candles'        : 'pnthr_bt_candles';
  const weeklyCol = isAI ? 'pnthr_ai_bt_candles_weekly'  : 'pnthr_bt_candles_weekly';

  // For non-AI tickers, fetch FMP /profile to get sector + name
  const profilePromise = !isAI
    ? fetchFMP(`/profile/${ticker}`).catch(() => null)
    : Promise.resolve(null);

  const [dailyDoc, weeklyDoc, liveQuoteArr, profileArr] = await Promise.all([
    db.collection(dailyCol).findOne({ ticker }),
    db.collection(weeklyCol).findOne({ ticker }),
    fetchFMP(`/quote/${ticker}`).catch(() => null),
    profilePromise,
  ]);

  const profile = Array.isArray(profileArr) && profileArr.length > 0 ? profileArr[0] : null;

  // Resolve EMA period + gate offset
  let sectorPeriod, gateOff, resolvedSectorName, resolvedSectorId, resolvedName, resolvedThesis;
  if (isAI) {
    const carnivore = isCarnivoreMode(ticker);
    sectorPeriod = carnivore ? getCarnivoreEmaPeriod(ticker) : (SECTOR_EMA_PERIODS[meta.sectorId] || 30);
    gateOff      = carnivore ? CARNIVORE_GATE_OFFSET : 0.25;
    resolvedSectorId   = meta.sectorId;
    resolvedSectorName = meta.sectorName;
    resolvedName       = meta.name;
    resolvedThesis     = meta.thesis || null;
  } else {
    const fmpSector = profile?.sector || null;
    const isEtf = !!ETF_TO_SECTOR[ticker];
    sectorPeriod = isEtf ? getEtfEmaPeriod(ticker) : getSectorEmaPeriod(fmpSector);
    gateOff      = 0.10;
    resolvedSectorId   = fmpSector || null;
    resolvedSectorName = fmpSector || null;
    resolvedName       = profile?.companyName || ticker;
    resolvedThesis     = null;   // non-AI names (679/ETFs) have no PNTHR thesis on file
  }
  const liveQuote = Array.isArray(liveQuoteArr) && liveQuoteArr.length > 0 ? liveQuoteArr[0] : null;

  let dailyRaw  = dailyDoc?.daily   || [];
  let weeklyRaw = weeklyDoc?.weekly || [];

  // FMP live fallback: when a non-AI ticker has no stored candles, fetch from
  // FMP historical-price-full and synthesize weekly bars on the fly.
  if (!isAI && dailyRaw.length === 0 && weeklyRaw.length === 0) {
    try {
      const from = new Date();
      from.setFullYear(from.getFullYear() - 5);
      const fromStr = from.toISOString().split('T')[0];
      const fmpBars = await fetchFMP(`/historical-price-full/${ticker}?from=${fromStr}`);
      const hist = (fmpBars?.historical || []).filter(b => b.close > 0 && b.open > 0);
      if (hist.length > 0) {
        dailyRaw = hist.map(b => ({
          date: b.date, open: +b.open, high: +b.high, low: +b.low,
          close: +b.close, volume: b.volume || 0,
        })).sort((a, b) => a.date.localeCompare(b.date));
        const weekMap = new Map();
        for (const b of dailyRaw) {
          const d = new Date(`${b.date}T12:00:00-05:00`);
          const dow = d.getUTCDay();
          const daysToMon = dow === 0 ? -6 : 1 - dow;
          d.setUTCDate(d.getUTCDate() + daysToMon);
          const mon = d.toISOString().slice(0, 10);
          const w = weekMap.get(mon);
          if (!w) {
            weekMap.set(mon, { weekOf: mon, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 });
          } else {
            w.high  = Math.max(w.high, b.high);
            w.low   = Math.min(w.low, b.low);
            w.close = b.close;
            w.volume += (b.volume || 0);
          }
        }
        weeklyRaw = [...weekMap.values()].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
      }
    } catch (e) {
      console.warn(`[aiStockChart] FMP fallback failed for ${ticker}:`, e.message);
    }
    if (dailyRaw.length === 0) {
      return { ok: false, error: `No chart data for ticker: ${ticker}` };
    }
  }

  // Sort ascending for chart consumption.
  // We keep TWO views of the bars:
  //   • *Sig*: Mongo-only, fed to the state machine — closed bars / cron-aggregated
  //     in-progress weekly bar. This is the source of truth for BL/SS markers,
  //     PNTHR Stop, and the "is there an open position?" flag.
  //   • Render arrays (dailyAsc / weeklyAsc): Mongo + today's live FMP overlay.
  //     This is what the chart draws so the user sees today's bar breathe.
  const dailyAscSig  = [...dailyRaw].sort((a, b) => a.date.localeCompare(b.date));
  const weeklyAscSig = [...weeklyRaw].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  const dailyAsc  = [...dailyAscSig];
  const weeklyAsc = [...weeklyAscSig];

  // ── Intraday synthesis: append today's live bar so the chart "breathes" ──
  // Mongo bars are end-of-day only — written by the 5:30pm cron. During RTH,
  // the latest stored daily bar is yesterday's, and the chart looks frozen
  // even while the tape moves. We use the FMP /quote we already pulled to
  // synthesize today's intraday bar (open, dayHigh, dayLow, live close) and
  // append it to dailyAsc. Same idea for weekly: this week's weekly bar gets
  // its high/low/close updated using today's live data.
  //
  // CRITICAL: signal state machine does NOT see this synthesized bar (signals
  // confirm only on closed bars). The chart shows today's bar visually, but
  // BL/SS/BE/SE markers and the PNTHR Stop are still computed off the closed
  // bar history. This prevents intraday signal whipsaws.
  function ymdET(unixSec) {
    if (!unixSec) return null;
    const d = new Date(unixSec * 1000);
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    });
    return fmt.format(d); // "YYYY-MM-DD"
  }
  function mondayOfET(ymd) {
    if (!ymd) return null;
    // Parse as ET noon to avoid TZ slop, then walk back to Monday.
    const d = new Date(`${ymd}T12:00:00-05:00`);
    const dow = d.getUTCDay(); // 0=Sun..6=Sat (UTC ok since we anchored noon ET)
    const daysToMonday = dow === 0 ? -6 : 1 - dow;
    d.setUTCDate(d.getUTCDate() + daysToMonday);
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    });
    return fmt.format(d);
  }
  const todayET = liveQuote?.timestamp ? ymdET(liveQuote.timestamp) : null;
  const lastStoredDaily = dailyAsc[dailyAsc.length - 1] || null;
  const liveOpen   = (liveQuote && typeof liveQuote.open    === 'number') ? liveQuote.open    : null;
  const liveHigh   = (liveQuote && typeof liveQuote.dayHigh === 'number') ? liveQuote.dayHigh : null;
  const liveLow    = (liveQuote && typeof liveQuote.dayLow  === 'number') ? liveQuote.dayLow  : null;
  const liveClose  = (liveQuote && typeof liveQuote.price   === 'number') ? liveQuote.price   : null;
  const liveVol    = (liveQuote && typeof liveQuote.volume  === 'number') ? liveQuote.volume  : 0;
  const haveLiveBar = todayET && liveOpen != null && liveHigh != null && liveLow != null && liveClose != null;

  // Append today's daily bar if it's missing (the usual case during RTH).
  // If the cron has already written today's bar (post-5:30pm ET), we replace
  // its OHLC with the live values to keep the chart in sync until close.
  if (haveLiveBar && lastStoredDaily) {
    const lastIsToday = lastStoredDaily.date === todayET;
    const todayBar = {
      date:   todayET,
      open:   liveOpen,
      high:   Math.max(liveHigh, lastIsToday ? lastStoredDaily.high : liveHigh),
      low:    Math.min(liveLow,  lastIsToday ? lastStoredDaily.low  : liveLow),
      close:  liveClose,
      volume: Math.max(liveVol,  lastIsToday ? (lastStoredDaily.volume || 0) : liveVol),
    };
    if (lastIsToday) dailyAsc[dailyAsc.length - 1] = todayBar;
    else if (todayET > lastStoredDaily.date) dailyAsc.push(todayBar);
  }

  // Update / append this week's weekly bar with today's live data.
  // The weekly bar represents the Mon→Fri aggregation. During RTH on any
  // weekday, this week's weekly bar should reflect today's live high/low/close.
  if (haveLiveBar && weeklyAsc.length > 0) {
    const thisMonday = mondayOfET(todayET);
    const lastWk = weeklyAsc[weeklyAsc.length - 1];
    if (thisMonday && lastWk) {
      if (lastWk.weekOf === thisMonday) {
        // Update in place: keep stored open (Monday's open), update H/L/C.
        weeklyAsc[weeklyAsc.length - 1] = {
          ...lastWk,
          high:  Math.max(lastWk.high, liveHigh),
          low:   Math.min(lastWk.low,  liveLow),
          close: liveClose,
        };
      } else if (thisMonday > lastWk.weekOf) {
        // New week starting today (e.g. Monday morning, no aggregator run yet).
        weeklyAsc.push({
          weekOf: thisMonday,
          open:   liveOpen,
          high:   liveHigh,
          low:    liveLow,
          close:  liveClose,
          volume: liveVol,
        });
      }
    }
  }

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
  // EMA is computed on all available bars regardless of staleness so the
  // historical line always renders. Signals are suppressed on stale data
  // (BL/SS on a frozen tail are meaningless) via separate sig-period vars.
  const dailyPeriod  = pickPeriod(dailyAsc.length);
  const weeklyPeriod = pickPeriod(weeklyAsc.length);
  const dailySigPeriod  = !dailyStaleData  ? dailyPeriod  : null;
  const weeklySigPeriod = !weeklyStaleData ? weeklyPeriod : null;

  // Compute EMA series aligned to bars (using whichever period was picked).
  // EMA includes today's synthesized bar so the line extends to today's price.
  const dailyEma  = dailyPeriod  ? emaSeriesAlignedTo(dailyAsc,  dailyPeriod)  : new Array(dailyAsc.length).fill(null);
  const weeklyEma = weeklyPeriod ? emaSeriesAlignedTo(weeklyAsc, weeklyPeriod) : new Array(weeklyAsc.length).fill(null);

  // Signal state machine runs on the Mongo-only series (no live intraday
  // overlay) so today's tape can't whip BL/SS markers around mid-session.
  // dailyAscSig and weeklyAscSig are the bars exactly as the cron wrote them.
  const dailySigBars  = dailyAscSig.map(b => ({ time: b.date,   open: b.open, high: b.high, low: b.low, close: b.close }));
  const weeklySigBars = weeklyAscSig.map(b => ({ time: b.weekOf, open: b.open, high: b.high, low: b.low, close: b.close }));

  // Daily uses 0.3% daylight zone (vs 1% weekly) — daily ranges are tighter
  // than weekly so the 1% threshold starves daily signals on chop-zone names.
  // Gate offset: carnivore tickers use 1.10× (CARNIVORE_GATE_OFFSET = 0.10),
  // AI tickers use 1.25× (0.25) per locked AI Universe spec.
  const dailyDetect  = dailySigPeriod  ? detectAllSignals(dailySigBars,  dailySigPeriod,  false, 0.003, gateOff) : { events: [], pnthrStop: null, currentSignal: null, activeType: null };
  const weeklyDetect = weeklySigPeriod ? detectAllSignals(weeklySigBars, weeklySigPeriod, false, null,  gateOff) : { events: [], pnthrStop: null, currentSignal: null, activeType: null };

  // After a BE exit from a long, compute where the next BL would trigger:
  // max(last-2 closed daily bars' highs) + $0.01. Shows as a dashed green
  // line on the chart so the trader knows exactly where confirmation fires.
  // Only shown when: last event is BE, and no SS followed it (trend still long).
  const dailyNextEntryTrigger = (() => {
    const evs = dailyDetect.events;
    if (!evs?.length) return null;
    const lastEv = evs[evs.length - 1];
    if (lastEv.signal !== 'BE') return null;
    // Ensure no SS fired after the last BL (trend still bullish)
    let lastBlIdx = -1;
    for (let i = evs.length - 1; i >= 0; i--) { if (evs[i].signal === 'BL') { lastBlIdx = i; break; } }
    if (lastBlIdx < 0) return null;
    if (evs.slice(lastBlIdx).some(e => e.signal === 'SS')) return null;
    if (dailyAscSig.length < 2) return null;
    const h1 = dailyAscSig[dailyAscSig.length - 1].high;
    const h2 = dailyAscSig[dailyAscSig.length - 2].high;
    return parseFloat((Math.max(h1, h2) + 0.01).toFixed(2));
  })();

  // MCE trigger line — AI 300 only, shown when weekly BL is active (not exited).
  // Marks max(prev 2 daily highs) + $0.01: the exact breakout price for an MCE entry.
  const dailyMceTrigger = isAI ? (() => {
    const weeklyActive = weeklyDetect.activeType;
    if (weeklyActive !== 'BL') return null;
    if (dailyAscSig.length < 3) return null;
    const h1 = dailyAscSig[dailyAscSig.length - 2].high;
    const h2 = dailyAscSig[dailyAscSig.length - 3].high;
    return parseFloat((Math.max(h1, h2) + 0.01).toFixed(2));
  })() : null;

  // Last bar info per timeframe
  const lastDaily  = dailyAsc[dailyAsc.length - 1] || null;
  const lastWeekly = weeklyAsc[weeklyAsc.length - 1] || null;

  // Header price + day change come from live FMP quote.
  // Day change preference order:
  //   1. FMP's canonical changesPercentage (matches TWS / Bloomberg)
  //   2. (livePrice - prior close) / prior close — where "prior close" is the
  //      last Mongo bar that is NOT today (i.e., yesterday's close, even when
  //      today's synthesized bar has been appended).
  //   3. Bar-based math when FMP is unreachable.
  const priorCloseBar = (() => {
    // Walk dailyAscSig (Mongo only) backwards skipping any same-day entry.
    for (let i = dailyAscSig.length - 1; i >= 0; i--) {
      if (dailyAscSig[i].date !== todayET) return dailyAscSig[i];
    }
    return null;
  })();
  let livePrice    = (liveQuote && typeof liveQuote.price === 'number') ? liveQuote.price : null;
  let dayChangePct = null;
  if (livePrice != null) {
    if (typeof liveQuote.changesPercentage === 'number') {
      dayChangePct = liveQuote.changesPercentage;
    } else if (priorCloseBar) {
      dayChangePct = ((livePrice - priorCloseBar.close) / priorCloseBar.close) * 100;
    }
  } else if (lastDaily && priorCloseBar && lastDaily !== priorCloseBar) {
    livePrice    = lastDaily.close;
    dayChangePct = ((lastDaily.close - priorCloseBar.close) / priorCloseBar.close) * 100;
  }

  const out = {
    ok:           true,
    ticker,
    name:         resolvedName,
    sectorId:     resolvedSectorId,
    sectorName:   resolvedSectorName,
    thesis:       resolvedThesis,      // brief PNTHR description (AI names only) — for the chart "Description" button
    isAI,
    emaPeriod:        sectorPeriod,    // canonical sector period
    dailyEmaPeriod:   dailyPeriod,     // period actually used for daily (may be 21W fallback)
    weeklyEmaPeriod:  weeklyPeriod,    // period actually used for weekly (may be 21W fallback)
    fallbackDaily:    dailySigPeriod  != null && dailySigPeriod  !== sectorPeriod,
    fallbackWeekly:   weeklySigPeriod != null && weeklySigPeriod !== sectorPeriod,
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
      signals:          dailyDetect.events,
      currentSignal:    dailyDetect.activeType || dailyDetect.currentSignal || null,
      pnthrStop:        dailyDetect.activeType ? dailyDetect.pnthrStop : null,
      nextEntryTrigger: dailyNextEntryTrigger,
      mceTrigger:       dailyMceTrigger,
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
