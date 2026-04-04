// server/backtest/buildWeeklyCandles.js
// ── Aggregate daily bars → weekly OHLCV and store in pnthr_bt_candles_weekly ──
//
// Reads from pnthr_bt_candles (daily), groups by ISO week (Mon–Fri),
// and writes one document per ticker to pnthr_bt_candles_weekly.
// Idempotent: overwrites existing docs. No TTL — permanent backtest data.
//
// Usage:  cd server && node backtest/buildWeeklyCandles.js
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { connectToDatabase } from '../database.js';

// ── Aggregate daily bars into weekly bars ────────────────────────────────────

function aggregateToWeekly(dailyBars) {
  if (!dailyBars || dailyBars.length === 0) return [];

  // Sort ascending by date (FMP returns descending)
  const sorted = [...dailyBars].sort((a, b) => a.date.localeCompare(b.date));

  const weeks = [];
  let current = null;

  for (const bar of sorted) {
    const d = new Date(bar.date + 'T12:00:00Z'); // noon UTC to avoid TZ issues
    // ISO week key: get Monday of this bar's week
    const day = d.getUTCDay(); // 0=Sun, 1=Mon, ...
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(d);
    monday.setUTCDate(monday.getUTCDate() + mondayOffset);
    const weekKey = monday.toISOString().split('T')[0];

    if (!current || current.weekKey !== weekKey) {
      // Start new week
      if (current) weeks.push(current);
      current = {
        weekKey,
        weekOf: weekKey,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume || 0,
        firstDate: bar.date,
        lastDate: bar.date,
        tradingDays: 1,
      };
    } else {
      // Extend current week
      current.high = Math.max(current.high, bar.high);
      current.low = Math.min(current.low, bar.low);
      current.close = bar.close;       // Friday close (or last trading day)
      current.volume += bar.volume || 0;
      current.lastDate = bar.date;
      current.tradingDays++;
    }
  }
  if (current) weeks.push(current);

  // Clean up: remove weekKey, return final shape
  return weeks.map(w => ({
    weekOf: w.weekOf,
    open: w.open,
    high: w.high,
    low: w.low,
    close: w.close,
    volume: w.volume,
    firstDate: w.firstDate,
    lastDate: w.lastDate,
    tradingDays: w.tradingDays,
  }));
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('Cannot connect to MongoDB'); process.exit(1); }

  const dailyCol  = db.collection('pnthr_bt_candles');
  const weeklyCol = db.collection('pnthr_bt_candles_weekly');

  // Create index
  await weeklyCol.createIndex({ ticker: 1 }, { unique: true });

  // Get all daily docs
  const dailyDocs = await dailyCol.find({}).toArray();
  console.log(`\nPNTHR Backtest — Building weekly candles from ${dailyDocs.length} daily docs\n`);

  let built = 0;
  let failed = 0;

  for (const doc of dailyDocs) {
    try {
      const weekly = aggregateToWeekly(doc.daily);
      if (weekly.length === 0) {
        console.warn(`  SKIP: ${doc.ticker} — no daily bars`);
        failed++;
        continue;
      }

      await weeklyCol.updateOne(
        { ticker: doc.ticker },
        {
          $set: {
            ticker: doc.ticker,
            weekly,
            barCount: weekly.length,
            fromWeek: weekly[0].weekOf,
            toWeek: weekly[weekly.length - 1].weekOf,
            builtAt: new Date(),
            sourceDailyBars: doc.barCount,
          },
        },
        { upsert: true }
      );

      built++;
      if (built % 50 === 0) {
        process.stdout.write(`\r  Progress: ${built}/${dailyDocs.length} built`);
      }
    } catch (err) {
      failed++;
      console.warn(`  FAIL: ${doc.ticker} — ${err.message}`);
    }
  }

  console.log(`\r  Progress: ${built}/${dailyDocs.length} built`);
  console.log(`\nDone. Built: ${built} | Failed: ${failed}`);

  // Summary
  const totalDocs = await weeklyCol.countDocuments();
  const sample = await weeklyCol.findOne({ ticker: 'AAPL' });
  console.log(`\nCollection pnthr_bt_candles_weekly: ${totalDocs} documents`);
  if (sample) {
    console.log(`Sample (AAPL): ${sample.barCount} weekly bars, ${sample.fromWeek} → ${sample.toWeek}`);
    // Show a few sample bars
    const last3 = sample.weekly.slice(-3);
    console.log('\nLast 3 weekly bars:');
    for (const w of last3) {
      console.log(`  ${w.weekOf}: O=${w.open} H=${w.high} L=${w.low} C=${w.close} V=${w.volume} (${w.tradingDays}d)`);
    }
  }

  process.exit(0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
