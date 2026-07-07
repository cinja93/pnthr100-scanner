// server/aiUniverseDailyJob.js
// ── PNTHR AI Universe — daily candle update + weekly re-aggregate ──────────
//
// Runs Mon–Fri post-close (5:30pm ET cron — see server/index.js).
//
// What it does, per ticker:
//   1. Look up `toDate` in pnthr_ai_bt_candles
//   2. Fetch FMP /historical-price-full from (toDate+1) → today, append new
//      bars (dedup by date)
//   3. Re-aggregate the entire ticker's daily series into pnthr_ai_bt_candles_weekly
//      (so the developing week's weekly bar updates each day)
//
// Why re-aggregate everything: weekly bars are pure derivatives of daily bars
// — recomputing from scratch is fast (~ms per ticker) and guarantees zero
// drift. The bottleneck is the FMP fetch, not the aggregation.
//
// Idempotent. Safe to run multiple times per day. Pulls only what's missing.
// ────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config();

import { connectToDatabase } from './database.js';
import { SECTORS } from './scripts/aiUniverse/aiUniverseData.js';
import { clearAiUniverseCache, getDeactivatedTickers } from './aiUniverseService.js';

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE    = 'https://financialmodelingprep.com/api/v3';

// FMP multi-ticker /historical-price-full silently truncates. BATCH_SIZE=1
// guarantees full range. For incremental daily updates the range is tiny
// (1–4 days) so cost is bounded regardless.
const BATCH_SIZE  = 1;
const BATCH_DELAY = 250;
const MAX_RETRIES = 3;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function todayISO() { return new Date().toISOString().split('T')[0]; }
function nextDayISO(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split('T')[0];
}

// ── Closed-bar discipline + overlap repair (2026-07-06 audit, critical #3) ──
// The old appender had a permanent-corruption path: an INTRADAY run (admin endpoint,
// local node run) appended today's in-progress bar; the evening cron then saw
// `lastStored >= today` and skipped, and the next day's dedup-by-date refused to
// replace the frozen partial bar — forever. These candles feed the LIVE Tree engine's
// 42wk-high triggers and 10-day-low stops (the 2026-06-30 v4.3 incident class).
// Two rules close it at the source:
//   1. NEVER fetch/store a bar dated today until the session is closed (16:10 ET
//      buffer, just ahead of the 16:15 cron) — an intraday run simply stops at
//      yesterday, so a partial bar can no longer be written at all.
//   2. Every run re-fetches a ~10-calendar-day OVERLAP window and REPLACES any
//      stored bar whose OHLCV differs — so any pre-existing frozen partial bar
//      (and FMP's post-close volume revisions, which drive the MOST_LIQUID entry
//      priority) self-heals on the next run instead of being dedup-skipped.
const CLOSED_BAR_CUTOFF_MIN = 16 * 60 + 10;   // 4:10pm ET
export const OVERLAP_DAYS = 10;               // calendar days re-fetched for repair

export function etClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(now);
  const o = {}; for (const p of parts) o[p.type] = p.value;
  let h = parseInt(o.hour, 10); if (h === 24) h = 0;
  return { date: `${o.year}-${o.month}-${o.day}`, minutes: h * 60 + parseInt(o.minute, 10) };
}

export function isoMinusDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().split('T')[0];
}

// Latest ET date whose daily bar is guaranteed COMPLETE right now.
export function lastCompleteTradingDate(now = new Date()) {
  const { date, minutes } = etClock(now);
  return minutes >= CLOSED_BAR_CUTOFF_MIN ? date : isoMinusDays(date, 1);
}

// Merge fresh (normalized, filtered) bars into the stored daily series:
// same-date bars are REPLACED when any OHLCV field differs; new dates append.
// Returns { merged (NEWEST-FIRST, the collection's storage order), appendedCount,
// replacedCount } — merged is null when nothing changed (skip the write).
export function mergeBarsWithRepair(existingDaily, freshBars) {
  const byDate = new Map((existingDaily || []).map(b => [b.date, b]));
  let appendedCount = 0, replacedCount = 0;
  const differs = (a, b) =>
    +a.open !== +b.open || +a.high !== +b.high || +a.low !== +b.low ||
    +a.close !== +b.close || (+a.volume || 0) !== (+b.volume || 0);
  for (const b of freshBars) {
    const prev = byDate.get(b.date);
    if (!prev) { byDate.set(b.date, b); appendedCount++; }
    else if (differs(prev, b)) { byDate.set(b.date, b); replacedCount++; }
  }
  if (!appendedCount && !replacedCount) return { merged: null, appendedCount, replacedCount };
  const merged = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
  return { merged, appendedCount, replacedCount };
}

// Scale-mismatch (split) check, overlap-aware: same-date pairs are compared
// directly (a vendor rescale mid-window trips it), and the oldest genuinely-new
// bar is compared to the newest stored bar (the original seam check). Returns
// a human-readable detail string when suspect, else null.
export function detectScaleMismatch(existingDaily, freshBars) {
  const byDate = new Map((existingDaily || []).map(b => [b.date, b]));
  const BAND_LO = 0.6, BAND_HI = 1.67;
  for (const b of freshBars) {
    const prev = byDate.get(b.date);
    if (prev?.close > 0 && b.close > 0) {
      const r = b.close / prev.close;
      if (r < BAND_LO || r > BAND_HI) return `same-date ${b.date}: fresh $${b.close} vs stored $${prev.close}`;
    }
  }
  const lastStoredBar = (existingDaily || []).reduce((m, x) => (!m || x.date > m.date ? x : m), null);
  if (lastStoredBar?.close > 0) {
    const oldestNew = freshBars.filter(b => !byDate.has(b.date)).reduce((m, x) => (!m || x.date < m.date ? x : m), null);
    if (oldestNew?.close > 0) {
      const r = oldestNew.close / lastStoredBar.close;
      if (r < BAND_LO || r > BAND_HI) return `new bar ${oldestNew.date} $${oldestNew.close} vs stored ${lastStoredBar.date} $${lastStoredBar.close}`;
    }
  }
  return null;
}

async function fetchWithRetry(url, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) { await sleep(attempt * 3000); continue; }
      if (res.status === 403) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(attempt * 1500);
    }
  }
  return null;
}

export async function fetchHistorical(ticker, fromDate, toDate) {
  const url = `${FMP_BASE}/historical-price-full/${ticker}?from=${fromDate}&to=${toDate}&apikey=${FMP_API_KEY}`;
  const raw = await fetchWithRetry(url).catch(() => null);
  if (!raw) return [];
  if (raw.historical?.length > 0) return raw.historical;
  return [];
}

export function normalizeBar(b) {
  return {
    date:   b.date,
    open:   parseFloat(b.open)   || 0,
    high:   parseFloat(b.high)   || 0,
    low:    parseFloat(b.low)    || 0,
    close:  parseFloat(b.close)  || 0,
    volume: parseInt(b.volume)   || 0,
  };
}

// Pure aggregator — daily bars (any order) → Monday-anchored weekly bars.
// Mirrors scripts/aiUniverse/buildAiUniverseWeeklyCandles.js exactly.
export function aggregateToWeekly(dailyBars) {
  if (!dailyBars || dailyBars.length === 0) return [];
  const sorted = [...dailyBars].sort((a, b) => a.date.localeCompare(b.date));
  const weeks  = [];
  let current  = null;

  for (const bar of sorted) {
    const d = new Date(bar.date + 'T12:00:00Z');
    const day = d.getUTCDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(d);
    monday.setUTCDate(monday.getUTCDate() + mondayOffset);
    const weekKey = monday.toISOString().split('T')[0];

    if (!current || current.weekKey !== weekKey) {
      if (current) weeks.push(current);
      current = {
        weekKey, weekOf: weekKey,
        open: bar.open, high: bar.high, low: bar.low, close: bar.close,
        volume: bar.volume || 0,
        firstDate: bar.date, lastDate: bar.date, tradingDays: 1,
      };
    } else {
      current.high   = Math.max(current.high, bar.high);
      current.low    = Math.min(current.low, bar.low);
      current.close  = bar.close;
      current.volume += bar.volume || 0;
      current.lastDate = bar.date;
      current.tradingDays++;
    }
  }
  if (current) weeks.push(current);

  return weeks.map(w => ({
    weekOf: w.weekOf, open: w.open, high: w.high, low: w.low, close: w.close,
    volume: w.volume, firstDate: w.firstDate, lastDate: w.lastDate, tradingDays: w.tradingDays,
  }));
}

export async function runAiUniverseDailyUpdate() {
  if (!FMP_API_KEY) {
    console.error('[AI Universe Daily] FMP_API_KEY missing — skipping');
    return { ok: false, error: 'FMP_API_KEY missing' };
  }

  const db = await connectToDatabase();
  if (!db) {
    console.error('[AI Universe Daily] Mongo connect failed — skipping');
    return { ok: false, error: 'Mongo connect failed' };
  }

  const dailyCol  = db.collection('pnthr_ai_bt_candles');
  const weeklyCol = db.collection('pnthr_ai_bt_candles_weekly');
  await dailyCol.createIndex({ ticker: 1 }, { unique: true });
  await weeklyCol.createIndex({ ticker: 1 }, { unique: true });

  const excluded = getDeactivatedTickers();
  const allTickers = [];
  for (const sec of SECTORS) for (const h of sec.holdings) {
    if (!excluded.has(h.ticker)) allTickers.push(h.ticker);
  }
  const tickers = [...new Set(allTickers)];
  // Closed bars only: an intraday run stops at yesterday — it can no longer freeze a
  // partial today-bar into the store (2026-07-06 audit; the 06-30 v4.3 incident class).
  const safeEnd = lastCompleteTradingDate();
  if (excluded.size > 0) console.log(`[AI Universe Daily] skipping ${excluded.size} deactivated: ${[...excluded].join(', ')}`);

  console.log(`[AI Universe Daily] starting — ${tickers.length} tickers, target date ${safeEnd} (last complete session)`);
  const startTime = Date.now();

  let appended = 0, alreadyCurrent = 0, missing = 0, failed = 0, weeklyRebuilt = 0, suspect = 0;
  let totalBarsAdded = 0;

  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const ticker = tickers[i];

    try {
      const existing = await dailyCol.findOne({ ticker }, { projection: { daily: 1, toDate: 1 } });
      const lastStored = existing?.toDate || null;

      if (lastStored && lastStored >= safeEnd) {
        alreadyCurrent++;
        continue;
      }

      // OVERLAP window: re-fetch the last ~10 calendar days too, so a previously
      // frozen partial bar (or an FMP volume revision) is REPAIRED, not dedup-skipped.
      const fromDate = lastStored ? isoMinusDays(lastStored, OVERLAP_DAYS) : '2022-11-30';
      const rawBars  = await fetchHistorical(ticker, fromDate, safeEnd);

      if (!rawBars || rawBars.length === 0) {
        missing++;
        await sleep(BATCH_DELAY);
        continue;
      }

      const fresh = rawBars
        .map(normalizeBar)
        .filter(b =>
          b.date && b.date <= safeEnd &&
          b.close > 0 && b.high >= b.low && b.high > 0
        );

      // SPLIT/DATA GUARD: never merge bars on a different price scale onto the
      // stored series (post-split bars onto pre-split history — that seam would
      // poison every consumer, incl. the PAI300 index for the night). Flag the
      // ticker for the split re-sync machinery and skip the append; the re-sync
      // swaps the whole series wholesale once FMP's history is adjusted.
      const mismatch = detectScaleMismatch(existing?.daily, fresh);
      if (mismatch) {
        suspect++;
        console.warn(`[AI Universe Daily] ${ticker}: ${mismatch} — scale mismatch, append blocked (split re-sync will repair)`);
        const { flagSuspectSplit } = await import('./splitMaintenanceService.js');   // dynamic — avoids circular import
        await flagSuspectSplit(db, ticker, `daily append blocked: ${mismatch}`);
        await sleep(BATCH_DELAY);
        continue;
      }

      const { merged, appendedCount, replacedCount } = mergeBarsWithRepair(existing?.daily, fresh);
      if (!merged) {
        alreadyCurrent++;
        await sleep(BATCH_DELAY);
        continue;
      }
      if (replacedCount) console.log(`[AI Universe Daily] ${ticker}: repaired ${replacedCount} stored bar(s) in the overlap window`);
      const sortedAsc = [...merged].sort((a, b) => a.date.localeCompare(b.date));

      await dailyCol.updateOne(
        { ticker },
        {
          $set: {
            ticker,
            daily:           merged,
            barCount:        merged.length,
            fromDate:        sortedAsc[0]?.date || null,
            toDate:          sortedAsc[sortedAsc.length - 1]?.date || null,
            lastDailyUpdateAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true }
      );

      // Re-aggregate weekly for this ticker (daily series changed)
      const weekly = aggregateToWeekly(merged);
      if (weekly.length > 0) {
        await weeklyCol.updateOne(
          { ticker },
          {
            $set: {
              ticker, weekly,
              barCount: weekly.length,
              fromWeek: weekly[0].weekOf,
              toWeek:   weekly[weekly.length - 1].weekOf,
              builtAt:  new Date(),
              sourceDailyBars: merged.length,
            },
          },
          { upsert: true }
        );
        weeklyRebuilt++;
      }

      appended++;
      totalBarsAdded += appendedCount + replacedCount;
    } catch (err) {
      failed++;
      console.error(`[AI Universe Daily] ${ticker}:`, err.message);
    }

    await sleep(BATCH_DELAY);
  }

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(0);

  // Page cache must drop so the next request returns fresh prices/YTD
  clearAiUniverseCache();

  const summary = {
    ok: true,
    runtimeSec:     Number(elapsedSec),
    appended,
    alreadyCurrent,
    missing,
    failed,
    weeklyRebuilt,
    suspect,
    totalBarsAdded,
  };
  console.log(`[AI Universe Daily] done in ${elapsedSec}s — appended ${appended}, current ${alreadyCurrent}, missing ${missing}, failed ${failed}, suspect ${suspect}, weeklyRebuilt ${weeklyRebuilt}, +${totalBarsAdded} bars`);
  return summary;
}
