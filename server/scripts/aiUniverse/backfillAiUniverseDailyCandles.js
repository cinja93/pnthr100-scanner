// server/scripts/aiUniverse/backfillAiUniverseDailyCandles.js
// ── PNTHR AI Universe — Daily Candle Backfill ───────────────────────────────
//
// Fetches FMP historical daily OHLCV bars for all 305 PNTHR AI Universe
// constituents from 2022-11-30 (ChatGPT launch — start of modern AI cycle)
// through today, and stores them in the `pnthr_ai_bt_candles` collection.
//
// One document per ticker:
//   { ticker, daily: [{date, open, high, low, close, volume}], barCount,
//     fromDate, toDate, lastBackfillAt }
//
// Idempotent + resumable:
//   - Existing dates are deduplicated (no overwriting)
//   - Re-running picks up from the latest stored date for each ticker
//   - Missing tickers (delisted / no data) are flagged but don't fail the run
//
// Late IPOs (CRWV, RDDT, TEM, SNDK, PONY, WRD, etc.) are stored with whatever
// history FMP provides — no synthetic backfill. Their fromDate reflects IPO.
//
// Prices are FMP-default (split-adjusted). Matches PNTHR 679 convention.
//
// Usage:  cd server && node scripts/aiUniverse/backfillAiUniverseDailyCandles.js
// Optional: --tickers AAPL,MSFT  to restrict run to specific tickers
// ────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../../.env', import.meta.url).pathname });

import { connectToDatabase } from '../../database.js';
import { SECTORS } from './aiUniverseData.js';

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE    = 'https://financialmodelingprep.com/api/v3';

if (!FMP_API_KEY) {
  console.error('FMP_API_KEY missing from .env — cannot backfill');
  process.exit(1);
}

// ── Date range ──────────────────────────────────────────────────────────────
// 2022-11-30 = ChatGPT launch = start of modern Generative AI investment cycle.
// Locked rule per project memory: project_ai_universe_start_date.md
const AI_CYCLE_START = '2022-11-30';
const TODAY = new Date().toISOString().split('T')[0];

// ── Rate limiting ───────────────────────────────────────────────────────────
// FMP paid plans: ~300 req/min.
// IMPORTANT: FMP's MULTI-ticker /historical-price-full silently caps results
// to ~1 year regardless of from/to params. SINGLE-ticker calls respect the
// full range. Use BATCH_SIZE=1 to get full 2022-11-30 history per ticker.
// 1/call @ 250ms = ~240 req/min (safely under 300/min limit).
const BATCH_SIZE  = 1;
const BATCH_DELAY = 250;
const MAX_RETRIES = 3;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── CLI args ────────────────────────────────────────────────────────────────
const tickerArg = process.argv.find(a => a.startsWith('--tickers='));
const ONLY_TICKERS = tickerArg ? tickerArg.split('=')[1].split(',').map(s => s.trim().toUpperCase()) : null;

// ── FMP fetch w/ retry on 429 ───────────────────────────────────────────────
async function fetchWithRetry(url, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        const waitMs = attempt * 3000;
        process.stdout.write(`\n    [429] rate-limited, waiting ${waitMs / 1000}s (attempt ${attempt}/${retries})...`);
        await sleep(waitMs);
        continue;
      }
      if (res.status === 403) return null;            // plan doesn't cover this date range
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(attempt * 1500);
    }
  }
  return null;
}

// ── Batch fetch from FMP /historical-price-full ─────────────────────────────
// Multi-ticker response: { historicalStockList: [{ symbol, historical: [...] }] }
// Single-ticker response: { symbol, historical: [...] }
async function fetchHistoricalBatch(tickers, fromDate, toDate) {
  const url = `${FMP_BASE}/historical-price-full/${tickers.join(',')}?from=${fromDate}&to=${toDate}&apikey=${FMP_API_KEY}`;
  let raw;
  try {
    raw = await fetchWithRetry(url);
  } catch (err) {
    return { error: err.message, data: {} };
  }
  if (!raw) return { error: null, data: {} };

  const data = {};
  if (raw.historicalStockList) {
    for (const item of raw.historicalStockList) {
      if (item.symbol && item.historical?.length > 0) data[item.symbol] = item.historical;
    }
  } else if (raw.historical?.length > 0) {
    const symbol = raw.symbol || tickers[0];
    data[symbol] = raw.historical;
  }
  return { error: null, data };
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

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('Cannot connect to MongoDB'); process.exit(1); }

  const col = db.collection('pnthr_ai_bt_candles');
  await col.createIndex({ ticker: 1 }, { unique: true });

  // Build ticker list from white-paper data (305 names) — matches what the
  // constituents builder loaded into pnthr_ai_universe_constituents.
  const allTickers = [];
  for (const sec of SECTORS) for (const h of sec.holdings) allTickers.push(h.ticker);
  const tickers = ONLY_TICKERS
    ? allTickers.filter(t => ONLY_TICKERS.includes(t))
    : [...new Set(allTickers)];

  console.log('\n' + '═'.repeat(72));
  console.log('  PNTHR AI Universe Daily Candle Backfill');
  console.log(`  Tickers:    ${tickers.length}`);
  console.log(`  From:       ${AI_CYCLE_START} (ChatGPT launch — start of modern AI cycle)`);
  console.log(`  To:         ${TODAY}`);
  console.log(`  Adjusted:   YES (FMP default, split-adjusted prices)`);
  console.log(`  Batch size: ${BATCH_SIZE}  |  Delay: ${BATCH_DELAY}ms  |  Retries: ${MAX_RETRIES}`);
  console.log('═'.repeat(72));

  const totalBatches = Math.ceil(tickers.length / BATCH_SIZE);
  const estSec = Math.ceil(totalBatches * BATCH_DELAY / 1000);
  console.log(`\n  ${totalBatches} batches  |  est. ~${Math.ceil(estSec / 60)} min runtime\n`);
  console.log('─'.repeat(72));

  let upserted = 0, missing = 0, failed = 0;
  let totalBarsAdded = 0;
  const failedTickers = [];
  const missingTickers = [];
  const startTime = Date.now();

  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch    = tickers.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const pct     = (i / tickers.length * 100).toFixed(1);
    process.stdout.write(
      `\r  Batch ${String(batchNum).padStart(3)}/${totalBatches} ` +
      `(${pct.padStart(5)}%) — ` +
      `${upserted} stored, ${missing} missing, ${failed} failed — ` +
      `${elapsed}s elapsed         `
    );

    const { error: batchError, data: histMap } = await fetchHistoricalBatch(batch, AI_CYCLE_START, TODAY);

    if (batchError) {
      failed += batch.length;
      for (const t of batch) failedTickers.push({ ticker: t, reason: batchError });
      await sleep(BATCH_DELAY);
      continue;
    }

    for (const ticker of batch) {
      const rawBars = histMap[ticker];

      if (!rawBars || rawBars.length === 0) {
        missing++;
        missingTickers.push(ticker);
        await col.updateOne(
          { ticker },
          {
            $set: {
              ticker,
              backfillCheckedAt: new Date(),
              backfillNote: `No FMP data ${AI_CYCLE_START}..${TODAY}`,
            },
            $setOnInsert: { createdAt: new Date() },
          },
          { upsert: true }
        );
        continue;
      }

      // Read existing for dedup
      const existing = await col.findOne({ ticker }, { projection: { daily: 1 } });
      const existingDates = new Set((existing?.daily || []).map(b => b.date));

      const cleanNew = rawBars
        .map(normalizeBar)
        .filter(b =>
          b.date &&
          !existingDates.has(b.date) &&
          b.date >= AI_CYCLE_START &&
          b.close > 0 &&
          b.high >= b.low &&
          b.high > 0
        );

      // Combine + sort descending (FMP convention)
      const merged = [...cleanNew, ...(existing?.daily || [])]
        .sort((a, b) => b.date.localeCompare(a.date));

      // Date range
      const sortedAsc = [...merged].sort((a, b) => a.date.localeCompare(b.date));
      const fromDate  = sortedAsc[0]?.date || null;
      const toDate    = sortedAsc[sortedAsc.length - 1]?.date || null;

      await col.updateOne(
        { ticker },
        {
          $set: {
            ticker,
            daily:           merged,
            barCount:        merged.length,
            fromDate,
            toDate,
            lastBackfillAt:  new Date(),
            backfillFrom:    AI_CYCLE_START,
            backfillTo:      TODAY,
            barsAddedThisRun: cleanNew.length,
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true }
      );

      totalBarsAdded += cleanNew.length;
      upserted++;
    }

    await sleep(BATCH_DELAY);
  }

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(0);

  console.log('\n\n' + '═'.repeat(72));
  console.log('  BACKFILL COMPLETE');
  console.log('═'.repeat(72));
  console.log(`  Runtime:        ${elapsedSec}s (${(elapsedSec / 60).toFixed(1)} min)`);
  console.log(`  Stored:         ${upserted} tickers (bars added: ${totalBarsAdded.toLocaleString()})`);
  console.log(`  Missing:        ${missing} tickers (no FMP data — likely post-2022 IPO with diff symbol or delisted)`);
  console.log(`  Failed:         ${failed} tickers`);
  if (missingTickers.length > 0) console.log(`\n  Missing tickers: ${missingTickers.slice(0, 30).join(', ')}${missingTickers.length > 30 ? '…' : ''}`);
  if (failedTickers.length > 0)  console.log(`\n  Failed tickers:  ${failedTickers.slice(0, 10).map(f => f.ticker).join(', ')}${failedTickers.length > 10 ? '…' : ''}`);
  console.log('\n  Next: node scripts/aiUniverse/buildAiUniverseWeeklyCandles.js\n');

  process.exit(0);
}

main().catch(err => { console.error('\n\nFATAL:', err); process.exit(1); });
