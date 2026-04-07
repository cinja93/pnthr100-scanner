// server/backtest/seedHistoricalCandles.js
// ── Extend pnthr_bt_candles with Pre-2020 History ─────────────────────────────
//
// PNTHR backtest data currently starts January 2020. This script fetches
// historical price data from 2017-07-01 through 2019-12-31 for all tickers
// in pnthr_bt_candles and merges it with the existing data.
//
// PURPOSE — enables backtesting through five additional market regimes:
//   2017        Low-volatility bull (VIX avg ~11) — trend-following ideal conditions
//   Q1-Q3 2018  Strong bull then volatility returns — tests signal quality
//   Q4 2018     -20% bear market (worst December since 1931) — key stress test
//   2019        Recovery rally — tests re-entry timing after bear
//   Jan-Feb 2020 Pre-crash peak bull — tests open position exposure
//   March 2020  COVID crash (-34% in 33 days, VIX 82) — ultimate stress test
//   Apr-Dec 2020 V-shaped recovery — tests signal re-activation
//
// The 21-week EMA warm-up requires ~5 months of price history before the
// first valid signal. Fetching from 2017-07-01 provides full warm-up buffer
// for signals starting January 2018.
//
// IMPORTANT: After this script completes, run in sequence:
//   1. node backtest/buildWeeklyCandles.js       (rebuild weekly aggregates)
//   2. node backtest/simulateOptimalEma.js        (regenerate Kill scores)
//   3. node backtest/exportOrdersTrades.js        (regenerate trade log w/ costs)
//   4. node backtest/computeHedgeFundMetrics.js   (recompute metrics gross + net)
//
// RUNTIME: ~45-90 minutes (679 tickers, 5/batch, 350ms delay)
// FMP API: Requires paid plan (Starter or higher) for data before 2020
//
// Usage:  cd server && node backtest/seedHistoricalCandles.js
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { connectToDatabase } from '../database.js';

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE    = 'https://financialmodelingprep.com/api/v3';

// ── Date range to fetch ───────────────────────────────────────────────────────
// From: July 2017 (21-week warm-up buffer for January 2018 signals)
// To:   December 2019 (the existing collection handles 2020 onward)
const EXTENSION_FROM = '2017-07-01';
const EXTENSION_TO   = '2019-12-31';

// ── Rate limiting ─────────────────────────────────────────────────────────────
// FMP paid plans: ~300 requests/minute. Using 5/batch at 350ms = ~170 req/min.
// This is safely below the limit with headroom for retries.
const BATCH_SIZE  = 5;     // tickers per FMP request
const BATCH_DELAY = 350;   // ms between batches
const MAX_RETRIES = 3;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── FMP fetch with retry on rate limit ───────────────────────────────────────
async function fetchWithRetry(url, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);

      if (res.status === 429) {
        const waitMs = attempt * 3000;
        process.stdout.write(`\n    [429] Rate limit hit — waiting ${waitMs / 1000}s (attempt ${attempt}/${retries})...`);
        await sleep(waitMs);
        continue;
      }

      if (res.status === 403) {
        // FMP plan does not support this date range for this ticker
        return null;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(attempt * 1500);
    }
  }
  return null;
}

// ── Fetch historical bars for a batch of tickers ─────────────────────────────
// FMP batch endpoint: /historical-price-full/AAPL,MSFT,GOOGL?from=...&to=...
// Returns { historicalStockList: [{ symbol, historical: [...] }] }
// or for single ticker: { symbol, historical: [...] }
async function fetchHistoricalBatch(tickers) {
  const tickerStr = tickers.join(',');
  const url = `${FMP_BASE}/historical-price-full/${tickerStr}?from=${EXTENSION_FROM}&to=${EXTENSION_TO}&apikey=${FMP_API_KEY}`;

  let raw;
  try {
    raw = await fetchWithRetry(url);
  } catch (err) {
    return { error: err.message, data: {} };
  }

  if (!raw) return { error: null, data: {} };

  // Normalize response to { ticker: [bars] } map
  const data = {};
  if (raw.historicalStockList) {
    // Multi-ticker response
    for (const item of raw.historicalStockList) {
      if (item.symbol && item.historical?.length > 0) {
        data[item.symbol] = item.historical;
      }
    }
  } else if (raw.historical?.length > 0) {
    // Single-ticker response
    const symbol = raw.symbol || tickers[0];
    data[symbol] = raw.historical;
  }

  return { error: null, data };
}

// ── Normalize a raw FMP bar ───────────────────────────────────────────────────
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

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('Cannot connect to MongoDB'); process.exit(1); }

  const col = db.collection('pnthr_bt_candles');

  console.log('\n' + '═'.repeat(70));
  console.log('  PNTHR Historical Candle Extension');
  console.log(`  Fetching: ${EXTENSION_FROM} → ${EXTENSION_TO}`);
  console.log(`  Batch size: ${BATCH_SIZE} tickers | Delay: ${BATCH_DELAY}ms | Max retries: ${MAX_RETRIES}`);
  console.log('═'.repeat(70));

  // ── Load all tickers ──────────────────────────────────────────────────────
  // Project only ticker + first/last date to minimize memory
  const allDocs = await col.find(
    {},
    { projection: { ticker: 1, fromDate: 1, barCount: 1 } }
  ).toArray();

  if (allDocs.length === 0) {
    console.error('\nNo documents found in pnthr_bt_candles.');
    console.error('The collection must be populated before running this extension.\n');
    process.exit(1);
  }

  console.log(`\nFound ${allDocs.length} tickers in pnthr_bt_candles`);

  // Identify tickers that need extension
  // A ticker needs extension if its earliest known date is after 2017-12-31
  const needsExtension = allDocs.filter(doc => {
    if (!doc.fromDate) return true;           // unknown start date — fetch to be safe
    return doc.fromDate > '2017-12-31';       // starts after our target window
  });

  const alreadyExtended = allDocs.length - needsExtension.length;
  console.log(`  Already extended (data from ≤2017): ${alreadyExtended}`);
  console.log(`  Needs extension: ${needsExtension.length}`);

  if (needsExtension.length === 0) {
    console.log('\n  All tickers already have pre-2018 data. Nothing to do.');
    console.log('  Run buildWeeklyCandles.js next to rebuild weekly aggregates.\n');
    process.exit(0);
  }

  const tickers = needsExtension.map(d => d.ticker);
  const totalBatches = Math.ceil(tickers.length / BATCH_SIZE);
  const estimatedMinutes = Math.ceil(tickers.length / BATCH_SIZE * BATCH_DELAY / 60000);

  console.log(`\n  Processing ${tickers.length} tickers in ${totalBatches} batches`);
  console.log(`  Estimated runtime: ~${estimatedMinutes} minutes\n`);
  console.log('─'.repeat(70));

  let extended = 0, skipped = 0, failed = 0, batchErrors = 0;
  let totalBarsAdded = 0;
  const failedTickers = [];
  const startTime = Date.now();

  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch      = tickers.slice(i, i + BATCH_SIZE);
    const batchNum   = Math.floor(i / BATCH_SIZE) + 1;

    // ── Progress line ──
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const pct     = (i / tickers.length * 100).toFixed(1);
    process.stdout.write(
      `\r  Batch ${String(batchNum).padStart(4)}/${totalBatches} ` +
      `(${pct.padStart(5)}%) — ` +
      `${extended} extended, ${skipped} skipped, ${failed} failed — ` +
      `${elapsed}s elapsed  `
    );

    // ── Fetch from FMP ──
    const { error: batchError, data: historicalData } = await fetchHistoricalBatch(batch);

    if (batchError) {
      batchErrors++;
      failed += batch.length;
      for (const t of batch) failedTickers.push({ ticker: t, reason: batchError });
      await sleep(BATCH_DELAY);
      continue;
    }

    // ── Process each ticker in the batch ──
    for (const ticker of batch) {
      const newBarsRaw = historicalData[ticker];

      if (!newBarsRaw || newBarsRaw.length === 0) {
        // FMP has no pre-2020 data for this ticker (likely IPO'd after 2020)
        skipped++;
        // Mark as checked so we don't re-fetch next run
        await col.updateOne(
          { ticker },
          { $set: { extensionCheckedAt: new Date(), extensionNote: 'No pre-2020 data available in FMP' } }
        );
        continue;
      }

      // Fetch the existing daily array for this ticker
      const existing = await col.findOne({ ticker }, { projection: { daily: 1 } });
      if (!existing) {
        skipped++;
        continue;
      }

      // Build set of existing dates for deduplication
      const existingDates = new Set((existing.daily || []).map(b => b.date));

      // Normalize and deduplicate new bars
      const cleanBars = newBarsRaw
        .map(normalizeBar)
        .filter(b =>
          b.date &&
          !existingDates.has(b.date) &&
          b.close > 0 &&
          b.high >= b.low &&
          b.high > 0
        );

      if (cleanBars.length === 0) {
        // Bars fetched but all duplicates (already had this data)
        skipped++;
        continue;
      }

      // Merge: combine new (older) bars + existing bars, sort descending (FMP convention)
      const merged = [...cleanBars, ...(existing.daily || [])]
        .sort((a, b) => b.date.localeCompare(a.date));

      // Compute new date range
      const sortedAsc = [...merged].sort((a, b) => a.date.localeCompare(b.date));
      const fromDate  = sortedAsc[0].date;
      const toDate    = sortedAsc[sortedAsc.length - 1].date;

      await col.updateOne(
        { ticker },
        {
          $set: {
            daily:              merged,
            barCount:           merged.length,
            fromDate,
            toDate,
            extendedAt:         new Date(),
            extensionBarsAdded: cleanBars.length,
            extensionFrom:      EXTENSION_FROM,
            extensionTo:        EXTENSION_TO,
          },
        }
      );

      totalBarsAdded += cleanBars.length;
      extended++;
    }

    await sleep(BATCH_DELAY);
  }

  // ── Final summary ─────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

  console.log('\n\n' + '═'.repeat(70));
  console.log('  EXTENSION COMPLETE');
  console.log('═'.repeat(70));
  console.log(`  Runtime:         ${elapsed}s (${(elapsed / 60).toFixed(1)} minutes)`);
  console.log(`  Extended:        ${extended} tickers (bars added: ${totalBarsAdded.toLocaleString()})`);
  console.log(`  Skipped:         ${skipped} tickers (no pre-2020 data in FMP — likely post-2020 IPOs)`);
  console.log(`  Failed:          ${failed} tickers`);

  if (failedTickers.length > 0) {
    console.log(`\n  Failed tickers:`);
    for (const f of failedTickers.slice(0, 20)) {
      console.log(`    ${f.ticker}: ${f.reason}`);
    }
    if (failedTickers.length > 20) {
      console.log(`    ... and ${failedTickers.length - 20} more`);
    }
  }

  // ── Verification: check AAPL and a few representative names ──────────────
  console.log('\n  VERIFICATION SAMPLES');
  console.log('  ' + '─'.repeat(60));
  const sampleTickers = ['AAPL', 'MSFT', 'XOM', 'JPM', 'AMZN'];
  for (const t of sampleTickers) {
    const doc = await col.findOne({ ticker: t }, { projection: { barCount: 1, fromDate: 1, toDate: 1 } });
    if (!doc) { console.log(`  ${t.padEnd(6)}: not found`); continue; }
    const hasPreCrash = doc.fromDate && doc.fromDate <= '2020-01-01';
    const has2018     = doc.fromDate && doc.fromDate <= '2018-01-01';
    const status = has2018 ? '✓ Has 2018 data' : hasPreCrash ? '~ Has pre-2020 only' : '✗ Starts 2020+';
    console.log(`  ${t.padEnd(6)}: ${doc.barCount} bars  ${doc.fromDate} → ${doc.toDate}  ${status}`);
  }

  // ── Next steps ────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log('  NEXT STEPS — Run in this exact order:');
  console.log('  1. node backtest/buildWeeklyCandles.js');
  console.log('     Rebuilds pnthr_bt_candles_weekly from extended daily data');
  console.log();
  console.log('  2. node backtest/simulateOptimalEma.js');
  console.log('     Regenerates Kill scores + signals for 2018-2026');
  console.log('     (This is the long-running step — expect 30-60 minutes)');
  console.log();
  console.log('  3. node backtest/exportOrdersTrades.js');
  console.log('     Regenerates trade log with friction costs for extended period');
  console.log();
  console.log('  4. node backtest/computeHedgeFundMetrics.js');
  console.log('     Computes GROSS vs NET metrics for Run A (2021-2026) AND Run B (2018-2026)');
  console.log();
  console.log('  After step 4, compare Run A vs Run B metrics to determine');
  console.log('  which dataset becomes the headline investor-facing numbers.');
  console.log('═'.repeat(70) + '\n');

  process.exit(0);
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
