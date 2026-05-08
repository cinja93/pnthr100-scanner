// server/scripts/aiUniverse/buildPnthrAi300IndexWeekly.js
// ── PNTHR AI 300 — Weekly Bar Aggregation ──────────────────────────────────
//
// Reads daily bars from pnthr_ai_index_candles, aggregates into Monday-anchored
// weekly OHLCV bars, writes to pnthr_ai_index_candles_weekly. Mirrors the
// constituent weekly aggregator (buildAiUniverseWeeklyCandles.js).
//
// Idempotent. Re-run any time the daily backfill changes.
//
// Usage:  cd server && node scripts/aiUniverse/buildPnthrAi300IndexWeekly.js
// ────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../../.env', import.meta.url).pathname });

import { connectToDatabase } from '../../database.js';
import { INDEX_TICKER, COLL_INDEX_DAILY, COLL_INDEX_WEEKLY } from '../../data/pnthrAiIndexConfig.js';

function aggregateToWeekly(dailyBars) {
  if (!dailyBars || dailyBars.length === 0) return [];
  const sorted = [...dailyBars].sort((a, b) => a.date.localeCompare(b.date));
  const weeks = [];
  let current = null;

  for (const bar of sorted) {
    const d   = new Date(bar.date + 'T12:00:00Z');
    const day = d.getUTCDay();                         // 0=Sun..6=Sat
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
  if (!db) { console.error('Mongo connect failed'); process.exit(1); }

  const dailyCol  = db.collection(COLL_INDEX_DAILY);
  const weeklyCol = db.collection(COLL_INDEX_WEEKLY);
  await weeklyCol.createIndex({ ticker: 1 }, { unique: true });

  const doc = await dailyCol.findOne({ ticker: INDEX_TICKER });
  if (!doc || !doc.daily?.length) {
    console.error(`No daily bars in ${COLL_INDEX_DAILY} for ${INDEX_TICKER} — run buildPnthrAi300Index.js first`);
    process.exit(1);
  }

  const weekly = aggregateToWeekly(doc.daily);
  if (weekly.length === 0) {
    console.error('Aggregator returned 0 weekly bars');
    process.exit(1);
  }

  await weeklyCol.updateOne(
    { ticker: INDEX_TICKER },
    {
      $set: {
        ticker:           INDEX_TICKER,
        weekly,
        barCount:         weekly.length,
        fromWeek:         weekly[0].weekOf,
        toWeek:           weekly[weekly.length - 1].weekOf,
        builtAt:          new Date(),
        sourceDailyBars:  doc.daily.length,
      },
    },
    { upsert: true }
  );

  console.log(`✓ ${INDEX_TICKER} weekly: ${weekly.length} bars (${weekly[0].weekOf} → ${weekly[weekly.length-1].weekOf})`);
  console.log(`  Stored in ${COLL_INDEX_WEEKLY}`);
  process.exit(0);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
