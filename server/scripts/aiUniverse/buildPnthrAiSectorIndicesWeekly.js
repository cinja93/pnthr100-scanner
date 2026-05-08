// server/scripts/aiUniverse/buildPnthrAiSectorIndicesWeekly.js
// ── PNTHR AI Sectors — Weekly aggregation (16 indices) ─────────────────────
//
// Reads daily bars from pnthr_ai_sector_candles, aggregates to Monday-anchored
// weekly OHLCV bars, writes pnthr_ai_sector_candles_weekly.
//
// Usage: cd server && node scripts/aiUniverse/buildPnthrAiSectorIndicesWeekly.js
// ────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../../.env', import.meta.url).pathname });

import { connectToDatabase } from '../../database.js';
import { COLL_SECTOR_DAILY, COLL_SECTOR_WEEKLY } from '../../data/pnthrAiSectorsConfig.js';

function aggregateToWeekly(dailyBars) {
  if (!dailyBars || dailyBars.length === 0) return [];
  const sorted = [...dailyBars].sort((a, b) => a.date.localeCompare(b.date));
  const weeks = [];
  let current = null;

  for (const bar of sorted) {
    const d   = new Date(bar.date + 'T12:00:00Z');
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

async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('Mongo connect failed'); process.exit(1); }

  const dailyCol  = db.collection(COLL_SECTOR_DAILY);
  const weeklyCol = db.collection(COLL_SECTOR_WEEKLY);
  await weeklyCol.createIndex({ ticker: 1 }, { unique: true });

  const docs = await dailyCol.find({ ticker: /^PAI_S/ }).toArray();
  console.log(`Aggregating ${docs.length} sector indices to weekly bars…`);

  let built = 0;
  for (const doc of docs) {
    if (!doc.daily?.length) continue;
    const weekly = aggregateToWeekly(doc.daily);
    if (weekly.length === 0) continue;
    await weeklyCol.updateOne(
      { ticker: doc.ticker },
      {
        $set: {
          ticker:     doc.ticker,
          sectorId:   doc.sectorId,
          sectorName: doc.sectorName,
          weekly,
          barCount:   weekly.length,
          fromWeek:   weekly[0].weekOf,
          toWeek:     weekly[weekly.length - 1].weekOf,
          builtAt:    new Date(),
          sourceDailyBars: doc.daily.length,
        },
      },
      { upsert: true }
    );
    built++;
  }
  console.log(`✓ ${built}/${docs.length} sector indices weekly-aggregated`);
  process.exit(0);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
