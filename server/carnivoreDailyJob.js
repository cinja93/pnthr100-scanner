// server/carnivoreDailyJob.js
// ── PNTHR 679 / Carnivore — daily candle update + weekly re-aggregate ────────
//
// Sister job to aiUniverseDailyJob.js, for the 679 / Carnivore universe.
// Keeps pnthr_bt_candles (daily) + pnthr_bt_candles_weekly (weekly) CURRENT so
// the per-ticker dual-pane chart (getAiStockChartData → AiTickerChartModal) draws
// continuous bars to today instead of a frozen tail + one synthetic live bar
// (the "phantom gap" Scott flagged 2026-06-16 — the 679 set had no recurring
// updater and froze at 2026-04-02 since the last manual seed). Also refreshes the
// SPY/QQQ benchmark bars that the IR services read.
//
// What it does, per ticker ALREADY in pnthr_bt_candles (the seeded 679 + SPY/QQQ
// + sector ETFs — names not in the collection chart fine via getAiStockChartData's
// FMP fallback, so we don't need a constituent list here):
//   1. Find the last stored date (toDate field, or max of the daily array).
//   2. Fetch FMP /historical-price-full from (lastDate+1) → today, append new
//      bars (dedup by date).
//   3. Re-aggregate the whole daily series into pnthr_bt_candles_weekly.
//
// Reuses aiUniverseDailyJob's pure helpers (fetchHistorical / normalizeBar /
// aggregateToWeekly) so aggregation is byte-identical to the AI set. Idempotent
// and safe to run repeatedly — pulls only what's missing. The SAME function does
// the one-time catch-up (Apr 2 → today) and the nightly keep-fresh via cron.
// ────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config();

import { connectToDatabase } from './database.js';
import {
  fetchHistorical, normalizeBar, aggregateToWeekly,
  lastCompleteTradingDate, isoMinusDays, mergeBarsWithRepair, detectScaleMismatch, OVERLAP_DAYS,
} from './aiUniverseDailyJob.js';
import { fetchFMP } from './stockService.js';

const HISTORY_START = '2018-12-31';   // earliest 679 candle anchor

const FMP_API_KEY = process.env.FMP_API_KEY;
const BATCH_DELAY = 250;   // ms between tickers — same FMP-courtesy pacing as the AI job

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Robust last-stored date: prefer the toDate field, else the max date in the
// daily array (17 legacy docs in this collection have no toDate field).
function lastStoredDate(doc) {
  if (doc?.toDate) return doc.toDate;
  return (doc?.daily || []).reduce((m, b) => (!m || (b.date && b.date > m) ? b.date : m), null);
}

export async function runCarnivoreDailyUpdate() {
  if (!FMP_API_KEY) {
    console.error('[Carnivore Daily] FMP_API_KEY missing — skipping');
    return { ok: false, error: 'FMP_API_KEY missing' };
  }

  const db = await connectToDatabase();
  if (!db) {
    console.error('[Carnivore Daily] Mongo connect failed — skipping');
    return { ok: false, error: 'Mongo connect failed' };
  }

  const dailyCol  = db.collection('pnthr_bt_candles');
  const weeklyCol = db.collection('pnthr_bt_candles_weekly');
  await dailyCol.createIndex({ ticker: 1 }, { unique: true });
  await weeklyCol.createIndex({ ticker: 1 }, { unique: true });

  // Refresh whatever was seeded (the chart's FMP fallback covers anything absent).
  const tickers = await dailyCol.distinct('ticker');
  // Closed bars only + overlap repair — same discipline as the AI job (2026-07-06 audit).
  const safeEnd = lastCompleteTradingDate();

  console.log(`[Carnivore Daily] starting — ${tickers.length} tickers, target date ${safeEnd} (last complete session)`);
  const startTime = Date.now();

  let appended = 0, alreadyCurrent = 0, missing = 0, failed = 0, weeklyRebuilt = 0, suspect = 0;
  let totalBarsAdded = 0;
  const suspectTickers = [];

  for (const ticker of tickers) {
    try {
      const existing   = await dailyCol.findOne({ ticker }, { projection: { daily: 1, toDate: 1 } });
      const lastStored = lastStoredDate(existing);

      if (lastStored && lastStored >= safeEnd) { alreadyCurrent++; continue; }

      const fromDate = lastStored ? isoMinusDays(lastStored, OVERLAP_DAYS) : '2018-12-31';
      const rawBars  = await fetchHistorical(ticker, fromDate, safeEnd);

      if (!rawBars || rawBars.length === 0) { missing++; await sleep(BATCH_DELAY); continue; }

      const fresh = rawBars
        .map(normalizeBar)
        .filter(b => b.date && b.date <= safeEnd && b.close > 0 && b.high >= b.low && b.high > 0);

      // SPLIT/DATA GUARD: never stitch a different price scale onto the stored
      // series (post-split bars onto pre-split history would poison the chart +
      // every consumer). Flag for re-sync and skip — the re-sync swaps the whole
      // series wholesale once FMP's history is split-adjusted. Same guard the AI job uses.
      const mismatch = detectScaleMismatch(existing?.daily, fresh);
      if (mismatch) {
        suspect++; suspectTickers.push(ticker);
        console.warn(`[Carnivore Daily] ${ticker}: ${mismatch} — scale mismatch, append blocked (needs split re-sync)`);
        try {
          const { flagSuspectSplit } = await import('./splitMaintenanceService.js');
          await flagSuspectSplit(db, ticker, `Carnivore daily append blocked: ${mismatch}`);
        } catch { /* flag is best-effort */ }
        await sleep(BATCH_DELAY);
        continue;
      }

      const { merged, appendedCount, replacedCount } = mergeBarsWithRepair(existing?.daily, fresh);
      if (!merged) { alreadyCurrent++; await sleep(BATCH_DELAY); continue; }
      if (replacedCount) console.log(`[Carnivore Daily] ${ticker}: repaired ${replacedCount} stored bar(s) in the overlap window`);
      const sortedAsc = [...merged].sort((a, b) => a.date.localeCompare(b.date));

      await dailyCol.updateOne(
        { ticker },
        {
          $set: {
            ticker,
            daily:             merged,
            barCount:          merged.length,
            fromDate:          sortedAsc[0]?.date || null,
            toDate:            sortedAsc[sortedAsc.length - 1]?.date || null,
            lastDailyUpdateAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true },
      );

      // Re-aggregate weekly (daily series changed) — keep field shape identical to
      // buildWeeklyCandles.js / the AI weekly collection so chart + IR consumers match.
      const weekly = aggregateToWeekly(merged);
      if (weekly.length > 0) {
        await weeklyCol.updateOne(
          { ticker },
          {
            $set: {
              ticker, weekly,
              barCount:        weekly.length,
              fromWeek:        weekly[0].weekOf,
              toWeek:          weekly[weekly.length - 1].weekOf,
              builtAt:         new Date(),
              sourceDailyBars: merged.length,
            },
          },
          { upsert: true },
        );
        weeklyRebuilt++;
      }

      appended++;
      totalBarsAdded += appendedCount + replacedCount;
    } catch (err) {
      failed++;
      console.error(`[Carnivore Daily] ${ticker}:`, err.message);
    }
    await sleep(BATCH_DELAY);
  }

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(0);
  const summary = {
    ok: true, runtimeSec: Number(elapsedSec),
    tickers: tickers.length, appended, alreadyCurrent, missing, failed, weeklyRebuilt,
    suspect, suspectTickers, totalBarsAdded,
  };
  console.log(`[Carnivore Daily] done in ${elapsedSec}s — appended ${appended}, current ${alreadyCurrent}, missing ${missing}, failed ${failed}, suspect ${suspect}${suspectTickers.length ? ' (' + suspectTickers.join(',') + ')' : ''}, weeklyRebuilt ${weeklyRebuilt}, +${totalBarsAdded} bars`);
  return summary;
}

// ── Split re-sync for the 679 collection ─────────────────────────────────────
// splitMaintenanceService only re-syncs the AI collections. When a 679 name splits,
// the daily appender (above) correctly BLOCKS the mixed-scale merge and leaves the
// ticker on its pre-split series. This swaps in FMP's full split-ADJUSTED history
// wholesale, mirroring the AI resyncTicker safety guards: (1) FMP actually adjusted
// (live quote matches the fresh last bar), (2) no history lost, (3) no discontinuity
// seam. Returns {ready,action,bars} or {ready:false,note}. Safe to re-run.
export async function resyncCarnivoreSplit(db, ticker, opts = {}) {
  const t = (ticker || '').toUpperCase();
  const today = lastCompleteTradingDate();   // closed bars only — a re-sync run intraday must not swap in today's partial bar
  const dailyCol = db.collection('pnthr_bt_candles');
  const old = await dailyCol.findOne({ ticker: t });
  const fetchFrom = (old?.fromDate && old.fromDate < HISTORY_START) ? old.fromDate : HISTORY_START;

  const fresh = (await fetchHistorical(t, fetchFrom, today))
    .map(normalizeBar)
    .filter(b => b.date && b.close > 0 && b.high >= b.low && b.high > 0);
  if (fresh.length === 0) return { ready: false, note: 'no FMP history yet' };
  const freshAsc  = [...fresh].sort((a, b) => a.date.localeCompare(b.date));
  const freshDesc = [...freshAsc].reverse();
  const freshLast = freshDesc[0].close;

  // (1) is FMP's history actually split-adjusted yet? live quote must match the last bar's scale
  const q = await fetchFMP(`/quote/${t}`).catch(() => null);
  const live = Array.isArray(q) ? +q[0]?.price : 0;
  if (live > 0 && (live < freshLast * 0.5 || live > freshLast * 2.0)) {
    return { ready: false, note: `FMP history not adjusted yet (live $${live} vs last bar $${freshLast})` };
  }
  // (2) FMP must not lose history in an adjustment
  if (old?.daily?.length && fresh.length < old.daily.length * 0.9) {
    return { ready: false, note: `FMP history incomplete (${fresh.length} vs ${old.daily.length} stored)` };
  }
  // (3) no discontinuity seam in the fresh (adjusted) series. A >50% one-day move is
  // usually an un-adjusted split seam — refuse. opts.forceSeam bypasses this ONLY after
  // a human verified the move is a real market event (e.g. CVNA 2023-06-08 +56% on 878M
  // shares — a genuine short-squeeze, not a data error), to avoid leaving an ultra-volatile
  // name frozen forever on the 50% rule.
  if (!opts.forceSeam) {
    for (let i = 1; i < freshAsc.length; i++) {
      const move = Math.abs(freshAsc[i].close / freshAsc[i - 1].close - 1);
      if (move > 0.5) return { ready: false, note: `seam ${(move * 100).toFixed(0)}% on ${freshAsc[i].date} — not swapping (verify, then forceSeam)` };
    }
  }

  await dailyCol.updateOne(
    { ticker: t },
    { $set: { ticker: t, daily: freshDesc, barCount: freshDesc.length, fromDate: freshAsc[0].date, toDate: freshAsc[freshAsc.length - 1].date, lastDailyUpdateAt: new Date(), splitResyncedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
  const weekly = aggregateToWeekly(freshAsc);
  await db.collection('pnthr_bt_candles_weekly').updateOne(
    { ticker: t },
    { $set: { ticker: t, weekly, barCount: weekly.length, fromWeek: weekly[0]?.weekOf || null, toWeek: weekly[weekly.length - 1]?.weekOf || null, builtAt: new Date(), sourceDailyBars: freshAsc.length } },
    { upsert: true },
  );
  return { ready: true, action: 'swapped', bars: freshDesc.length, from: freshAsc[0].date, to: freshAsc[freshAsc.length - 1].date };
}
