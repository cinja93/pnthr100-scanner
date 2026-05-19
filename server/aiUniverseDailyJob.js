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

async function fetchHistorical(ticker, fromDate, toDate) {
  const url = `${FMP_BASE}/historical-price-full/${ticker}?from=${fromDate}&to=${toDate}&apikey=${FMP_API_KEY}`;
  const raw = await fetchWithRetry(url).catch(() => null);
  if (!raw) return [];
  if (raw.historical?.length > 0) return raw.historical;
  return [];
}

function normalizeBar(b) {
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
function aggregateToWeekly(dailyBars) {
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
  const today   = todayISO();
  if (excluded.size > 0) console.log(`[AI Universe Daily] skipping ${excluded.size} deactivated: ${[...excluded].join(', ')}`);

  console.log(`[AI Universe Daily] starting — ${tickers.length} tickers, target date ${today}`);
  const startTime = Date.now();

  let appended = 0, alreadyCurrent = 0, missing = 0, failed = 0, weeklyRebuilt = 0;
  let totalBarsAdded = 0;

  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const ticker = tickers[i];

    try {
      const existing = await dailyCol.findOne({ ticker }, { projection: { daily: 1, toDate: 1 } });
      const lastStored = existing?.toDate || null;

      if (lastStored && lastStored >= today) {
        alreadyCurrent++;
        continue;
      }

      const fromDate = lastStored ? nextDayISO(lastStored) : '2022-11-30';
      const rawBars  = await fetchHistorical(ticker, fromDate, today);

      if (!rawBars || rawBars.length === 0) {
        missing++;
        await sleep(BATCH_DELAY);
        continue;
      }

      const existingDates = new Set((existing?.daily || []).map(b => b.date));
      const cleanNew = rawBars
        .map(normalizeBar)
        .filter(b =>
          b.date && !existingDates.has(b.date) &&
          b.close > 0 && b.high >= b.low && b.high > 0
        );

      if (cleanNew.length === 0) {
        alreadyCurrent++;
        await sleep(BATCH_DELAY);
        continue;
      }

      const merged = [...cleanNew, ...(existing?.daily || [])]
        .sort((a, b) => b.date.localeCompare(a.date));
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
      totalBarsAdded += cleanNew.length;
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
    totalBarsAdded,
  };
  console.log(`[AI Universe Daily] done in ${elapsedSec}s — appended ${appended}, current ${alreadyCurrent}, missing ${missing}, failed ${failed}, weeklyRebuilt ${weeklyRebuilt}, +${totalBarsAdded} bars`);
  return summary;
}
