// server/scripts/aiUniverse/buildAiUniverseWeeklyCandles.js
// ── PNTHR AI Universe — Weekly Candle Builder ──────────────────────────────
//
// Aggregates daily bars from `pnthr_ai_bt_candles` into weekly OHLCV bars,
// stored in `pnthr_ai_bt_candles_weekly`. Mirrors the PNTHR 679 pattern from
// backtest/buildWeeklyCandles.js.
//
// Each week = Monday-anchored ISO week of the trading days that fell in that
// week (Mon-Fri). Open = first day's open, High/Low = max/min, Close = last
// day's close (typically Friday), Volume = sum.
//
// Idempotent: overwrites existing weekly docs by ticker.
//
// Usage:  cd server && node scripts/aiUniverse/buildAiUniverseWeeklyCandles.js
// ────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../../.env', import.meta.url).pathname });

import { connectToDatabase } from '../../database.js';

function aggregateToWeekly(dailyBars) {
  if (!dailyBars || dailyBars.length === 0) return [];
  const sorted = [...dailyBars].sort((a, b) => a.date.localeCompare(b.date));

  const weeks = [];
  let current = null;

  for (const bar of sorted) {
    const d = new Date(bar.date + 'T12:00:00Z');     // noon UTC to avoid TZ drift
    const day = d.getUTCDay();                        // 0=Sun, 1=Mon...
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
    weekOf:      w.weekOf,
    open:        w.open,
    high:        w.high,
    low:         w.low,
    close:       w.close,
    volume:      w.volume,
    firstDate:   w.firstDate,
    lastDate:    w.lastDate,
    tradingDays: w.tradingDays,
  }));
}

async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('Cannot connect to MongoDB'); process.exit(1); }

  const dailyCol  = db.collection('pnthr_ai_bt_candles');
  const weeklyCol = db.collection('pnthr_ai_bt_candles_weekly');
  await weeklyCol.createIndex({ ticker: 1 }, { unique: true });

  const startTime = Date.now();
  console.log('\n' + '═'.repeat(70));
  console.log('  PNTHR AI Universe Weekly Candle Build');
  console.log(`  Source:  pnthr_ai_bt_candles`);
  console.log(`  Target:  pnthr_ai_bt_candles_weekly`);
  console.log('═'.repeat(70));

  const dailyDocs = await dailyCol.find(
    { daily: { $exists: true, $ne: [] } },
    { projection: { ticker: 1, daily: 1, barCount: 1 } }
  ).toArray();
  console.log(`\n  Found ${dailyDocs.length} tickers with daily bars\n`);

  let built = 0, skipped = 0;
  let totalWeeks = 0;

  for (const doc of dailyDocs) {
    const weekly = aggregateToWeekly(doc.daily);
    if (weekly.length === 0) {
      skipped++;
      continue;
    }
    await weeklyCol.updateOne(
      { ticker: doc.ticker },
      {
        $set: {
          ticker:          doc.ticker,
          weekly,
          barCount:        weekly.length,
          fromWeek:        weekly[0].weekOf,
          toWeek:          weekly[weekly.length - 1].weekOf,
          builtAt:         new Date(),
          sourceDailyBars: doc.barCount,
        },
      },
      { upsert: true }
    );
    built++;
    totalWeeks += weekly.length;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('─'.repeat(70));
  console.log(`  Built:    ${built} tickers (${totalWeeks.toLocaleString()} total weekly bars)`);
  console.log(`  Skipped:  ${skipped} tickers (no daily data)`);
  console.log(`  Runtime:  ${elapsed}s`);
  console.log('─'.repeat(70));
  console.log('\n  AI Universe data layer complete. Three collections live:');
  console.log('    pnthr_ai_universe_constituents  (305 tickers + sector + thesis)');
  console.log('    pnthr_ai_bt_candles             (daily bars, 2022-11-30+)');
  console.log('    pnthr_ai_bt_candles_weekly      (weekly bars, 2022-11-30+)\n');

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
