// server/_build_clockhour.mjs
// ── Build :00 CLOCK-HOUR bars from the 30-min backfill ────────────────────────
// Reuses the EXACT live bucketing (ambushCron.js clockHourBars): group a day's
// 30-minute bars by ET start-hour → one bar per clock hour, matching the trader's
// TWS chart (9:30-10:00, 10:00-11:00, ... 15:00-16:00). Output shape matches
// pnthr_ai_hourly_candles so the backtest can consume it directly.
//
// Reads:  pnthr_ai_30min_candles  ({ ticker, min30:[{date,open,high,low,close,volume}] })
// Writes: pnthr_ai_clockhour_candles ({ ticker, hourly:[{date:"Y-M-D HH:00:00",o,h,l,c,v}] })
//
// Usage: node _build_clockhour.mjs
// ─────────────────────────────────────────────────────────────────────────────
import dotenv from 'dotenv';
dotenv.config({ path: new URL('./.env', import.meta.url).pathname });
import { connectToDatabase } from './database.js';

const SRC = 'pnthr_ai_30min_candles';
const DST = 'pnthr_ai_clockhour_candles';

async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('no db'); process.exit(1); }
  await db.collection(DST).createIndex({ ticker: 1 }, { unique: true }).catch(() => {});

  const docs = await db.collection(SRC).find({}).toArray();
  console.log(`[clockhour] ${docs.length} tickers from ${SRC}`);
  let n = 0, totalBars = 0;
  for (const d of docs) {
    // group by day → by ET start-hour
    const byDayHour = {};
    for (const b of (d.min30 || [])) {
      const [day, time] = b.date.split(' ');
      if (!time) continue;
      const hr = parseInt(time.slice(0, 2), 10);
      const key = `${day} ${String(hr).padStart(2, '0')}:00:00`;
      (byDayHour[key] = byDayHour[key] || []).push(b);
    }
    const hourly = Object.keys(byDayHour).sort().map(key => {
      const bs = byDayHour[key].sort((a, b) => a.date.localeCompare(b.date));
      return {
        date: key,
        open: +bs[0].open,
        high: Math.max(...bs.map(x => +x.high)),
        low: Math.min(...bs.map(x => +x.low)),
        close: +bs[bs.length - 1].close,
        volume: bs.reduce((s, x) => s + (+x.volume || 0), 0),
      };
    });
    if (hourly.length) {
      await db.collection(DST).replaceOne({ ticker: d.ticker }, { ticker: d.ticker, hourly, updatedAt: new Date() }, { upsert: true });
      totalBars += hourly.length; n++;
    }
  }
  console.log(`[clockhour] DONE — ${n} tickers, ${totalBars.toLocaleString()} clock-hour bars → ${DST}`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
