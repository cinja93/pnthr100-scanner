// server/backtest/fillCandles2020Gap.js
// ── Fill the January–September 2020 Data Gap ─────────────────────────────────
//
// pnthr_bt_candles currently has:
//   Extended data:  2018-12-31 → 2019-12-31 (from seedHistoricalCandles.js)
//   Original data:  ~October 2020 → present
//   GAP:            2020-01-01 → ~2020-09-30 (COVID crash + V-recovery missing!)
//
// This gap prevents the backtest from capturing:
//   Q1 2020   Pre-crash peak bull (Feb ATHs)
//   March 2020  COVID crash (-34% in 33 days, VIX 82)
//   Apr-Sep 2020  V-shaped recovery
//
// This script fetches 2020-01-01 → 2020-09-30 from FMP and merges the data.
// Runtime: ~15-30 minutes (530 tickers, 5/batch, 350ms delay)
//
// IMPORTANT: After this script completes, re-run backfillBtScores.js then
//   exportOrdersTrades.js, computeHedgeFundMetrics.js, exportAuditLog.js.
//
// Usage:  cd server && node backtest/fillCandles2020Gap.js
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { connectToDatabase } from '../database.js';

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE    = 'https://financialmodelingprep.com/api/v3';

// ── The exact gap to fill ─────────────────────────────────────────────────────
const GAP_FROM = '2020-01-01';
const GAP_TO   = '2020-09-30';

// ── Rate limiting ─────────────────────────────────────────────────────────────
const BATCH_SIZE  = 5;
const BATCH_DELAY = 350;
const MAX_RETRIES = 3;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(url, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        const waitMs = attempt * 3000;
        process.stdout.write(`\n    [429] Rate limit — waiting ${waitMs / 1000}s...`);
        await sleep(waitMs);
        continue;
      }
      if (res.status === 403) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(attempt * 1500);
    }
  }
  return null;
}

async function fetchHistoricalBatch(tickers) {
  const tickerStr = tickers.join(',');
  const url = `${FMP_BASE}/historical-price-full/${tickerStr}?from=${GAP_FROM}&to=${GAP_TO}&apikey=${FMP_API_KEY}`;
  let raw;
  try { raw = await fetchWithRetry(url); }
  catch (err) { return { error: err.message, data: {} }; }
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
    open:   parseFloat(b.open)  || 0,
    high:   parseFloat(b.high)  || 0,
    low:    parseFloat(b.low)   || 0,
    close:  parseFloat(b.close) || 0,
    volume: parseInt(b.volume)  || 0,
  };
}

async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('Cannot connect to MongoDB'); process.exit(1); }
  const col = db.collection('pnthr_bt_candles');

  console.log('\n' + '═'.repeat(70));
  console.log('  PNTHR 2020 Data Gap Fill');
  console.log(`  Fetching: ${GAP_FROM} → ${GAP_TO} (COVID crash + V-recovery)`);
  console.log(`  Batch size: ${BATCH_SIZE} | Delay: ${BATCH_DELAY}ms | Retries: ${MAX_RETRIES}`);
  console.log('═'.repeat(70));

  // ── Identify tickers that need gap filling ────────────────────────────────
  // A ticker needs the gap filled if it has no daily bars between GAP_FROM and GAP_TO
  const allDocs = await col.find({}, { projection: { ticker: 1, daily: 1 } }).toArray();
  console.log(`\nLoaded ${allDocs.length} ticker documents`);

  const needsFill = [];
  let alreadyHasGapData = 0;

  for (const doc of allDocs) {
    const hasGapBar = (doc.daily || []).some(b => b.date >= GAP_FROM && b.date <= GAP_TO);
    if (hasGapBar) { alreadyHasGapData++; continue; }
    needsFill.push(doc.ticker);
  }

  console.log(`  Already has 2020 gap data: ${alreadyHasGapData} tickers`);
  console.log(`  Needs gap fill: ${needsFill.length} tickers`);

  if (needsFill.length === 0) {
    console.log('\n  All tickers already have 2020 data. Nothing to do.');
    process.exit(0);
  }

  const totalBatches = Math.ceil(needsFill.length / BATCH_SIZE);
  const estimatedMin = Math.ceil(needsFill.length / BATCH_SIZE * BATCH_DELAY / 60000);
  console.log(`\n  Processing ${needsFill.length} tickers in ${totalBatches} batches`);
  console.log(`  Estimated runtime: ~${estimatedMin} minutes\n`);
  console.log('─'.repeat(70));

  let filled = 0, skipped = 0, failed = 0;
  let totalBarsAdded = 0;
  const failedTickers = [];
  const startTime = Date.now();

  for (let i = 0; i < needsFill.length; i += BATCH_SIZE) {
    const batch   = needsFill.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const elapsed  = ((Date.now() - startTime) / 1000).toFixed(0);
    const pct      = (i / needsFill.length * 100).toFixed(1);

    process.stdout.write(
      `\r  Batch ${String(batchNum).padStart(4)}/${totalBatches} ` +
      `(${pct.padStart(5)}%) — ` +
      `${filled} filled, ${skipped} skipped, ${failed} failed — ` +
      `${elapsed}s elapsed  `
    );

    const { error: batchError, data: historicalData } = await fetchHistoricalBatch(batch);

    if (batchError) {
      failed += batch.length;
      for (const t of batch) failedTickers.push({ ticker: t, reason: batchError });
      await sleep(BATCH_DELAY);
      continue;
    }

    for (const ticker of batch) {
      const newBarsRaw = historicalData[ticker];

      if (!newBarsRaw || newBarsRaw.length === 0) {
        skipped++;
        continue;
      }

      // Fetch existing document
      const existing = await col.findOne({ ticker }, { projection: { daily: 1 } });
      if (!existing) { skipped++; continue; }

      // Build set of existing dates for deduplication
      const existingDates = new Set((existing.daily || []).map(b => b.date));

      // Normalize and deduplicate
      const cleanBars = newBarsRaw
        .map(normalizeBar)
        .filter(b =>
          b.date &&
          b.date >= GAP_FROM &&
          b.date <= GAP_TO &&
          !existingDates.has(b.date) &&
          b.close > 0 &&
          b.high >= b.low &&
          b.high > 0
        );

      if (cleanBars.length === 0) { skipped++; continue; }

      // Merge all bars and sort descending (MongoDB storage convention)
      const merged = [...cleanBars, ...(existing.daily || [])]
        .sort((a, b) => b.date.localeCompare(a.date));

      // Update date range metadata
      const sortedAsc = [...merged].sort((a, b) => a.date.localeCompare(b.date));
      const fromDate  = sortedAsc[0].date;
      const toDate    = sortedAsc[sortedAsc.length - 1].date;

      await col.updateOne(
        { ticker },
        {
          $set: {
            daily:           merged,
            barCount:        merged.length,
            fromDate,
            toDate,
            gap2020FilledAt: new Date(),
            gap2020BarsAdded: cleanBars.length,
          },
        }
      );

      totalBarsAdded += cleanBars.length;
      filled++;
    }

    await sleep(BATCH_DELAY);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

  console.log('\n\n' + '═'.repeat(70));
  console.log('  2020 GAP FILL COMPLETE');
  console.log('═'.repeat(70));
  console.log(`  Runtime:    ${elapsed}s (${(elapsed / 60).toFixed(1)} minutes)`);
  console.log(`  Filled:     ${filled} tickers (${totalBarsAdded.toLocaleString()} bars added)`);
  console.log(`  Skipped:    ${skipped} tickers (no 2020 FMP data or already had it)`);
  console.log(`  Failed:     ${failed} tickers`);

  if (failedTickers.length > 0) {
    console.log('\n  Failed tickers (first 20):');
    for (const f of failedTickers.slice(0, 20)) {
      console.log(`    ${f.ticker}: ${f.reason}`);
    }
  }

  // ── Verify: check AAPL coverage ──────────────────────────────────────────
  console.log('\n  VERIFICATION — Checking 2020 coverage for AAPL:');
  const aaplDoc = await col.findOne({ ticker: 'AAPL' }, { projection: { daily: 1, barCount: 1, fromDate: 1, toDate: 1 } });
  if (aaplDoc) {
    const bars2020 = (aaplDoc.daily || []).filter(b => b.date >= '2020-01-01' && b.date <= '2020-09-30');
    const marBars  = bars2020.filter(b => b.date >= '2020-03-01' && b.date <= '2020-04-01');
    const marchLow = Math.min(...marBars.map(b => b.low));
    console.log(`  AAPL: ${aaplDoc.barCount} total bars, ${aaplDoc.fromDate} → ${aaplDoc.toDate}`);
    console.log(`  AAPL: ${bars2020.length} bars in Jan-Sep 2020`);
    console.log(`  AAPL: ${marBars.length} bars in March 2020 (COVID crash)`);
    console.log(`  AAPL March 2020 low: $${marchLow.toFixed(2)} (COVID crash bottom ~$53)`);
  }

  console.log('\n' + '═'.repeat(70));
  console.log('  NEXT STEPS — Run in this exact order:');
  console.log('  1. node backtest/backfillBtScores.js');
  console.log('     Re-runs the backfill with complete 2019-2021 data');
  console.log('     (Will skip already-written weeks, only fills 2020 gap)');
  console.log('');
  console.log('  2. node backtest/exportOrdersTrades.js');
  console.log('     Regenerates trade log for full 2019-2026 period');
  console.log('');
  console.log('  3. node backtest/computeHedgeFundMetrics.js');
  console.log('     Computes GROSS vs NET metrics including March 2020 stress test');
  console.log('');
  console.log('  4. node backtest/exportAuditLog.js');
  console.log('     Updates investor-grade audit log');
  console.log('═'.repeat(70) + '\n');

  process.exit(0);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  console.error(err.stack);
  process.exit(1);
});
