// server/signalHistoryService.js
//
// Saves weekly signal snapshots to MongoDB for historical tracking.
// Every Friday night a cron job captures the signal state for all 679
// Jungle stocks. This builds a complete week-by-week archive over time.
//
// Collection: signal_history
// Schema: { ticker, weekOf (YYYY-MM-DD Monday), signal, ema21, emaPeriod,
//           stopPrice, isNewSignal, signalDate, profitDollar, profitPct, savedAt }

import { connectToDatabase } from './database.js';
import { DEFAULT_EMA_PERIOD } from './sectorEmaConfig.js';

// Returns the Monday of the current week as YYYY-MM-DD
export function getCurrentWeekOf() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = today.getDay(); // 0=Sun...6=Sat
  const daysToMonday = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(today);
  monday.setDate(today.getDate() + daysToMonday);
  return monday.toISOString().split('T')[0];
}

// Save a full weekly snapshot for all tickers.
// signalMap: { ticker -> { signal, ema21, emaPeriod, stopPrice, pnthrStop,
//                          isNewSignal, signalDate, profitDollar, profitPct } }
// Upserts so it's safe to call multiple times per week.
export async function saveWeeklySnapshot(signalMap) {
  const db = await connectToDatabase();
  const coll = db.collection('signal_history');
  const weekOf = getCurrentWeekOf();

  const entries = Object.entries(signalMap);
  if (entries.length === 0) return 0;

  const ops = entries.map(([ticker, s]) => ({
    updateOne: {
      filter: { ticker, weekOf },
      update: {
        $set: {
          ticker,
          weekOf,
          signal:      s.signal      ?? null,
          ema21:       s.ema21       ?? null,
          emaPeriod:   s.emaPeriod   ?? DEFAULT_EMA_PERIOD,
          stopPrice:   s.pnthrStop   ?? s.stopPrice ?? null,
          isNewSignal: s.isNewSignal ?? false,
          signalDate:  s.signalDate  ?? null,
          profitDollar: s.profitDollar ?? null,
          profitPct:    s.profitPct    ?? null,
          savedAt: new Date(),
        },
      },
      upsert: true,
    },
  }));

  await coll.bulkWrite(ops);
  return entries.length;
}

// Retrieve full signal history for a single ticker, newest first.
export async function getTickerHistory(ticker) {
  const db = await connectToDatabase();
  return db.collection('signal_history')
    .find({ ticker: ticker.toUpperCase() })
    .sort({ weekOf: -1 })
    .toArray();
}

// Retrieve all active (non-null) signals for a given week.
export async function getWeekSnapshot(weekOf) {
  const db = await connectToDatabase();
  return db.collection('signal_history')
    .find({ weekOf, signal: { $ne: null } })
    .sort({ ticker: 1 })
    .toArray();
}

// List all weeks that have been archived, newest first.
export async function listArchivedWeeks() {
  const db = await connectToDatabase();
  return db.collection('signal_history')
    .distinct('weekOf')
    .then(weeks => weeks.sort((a, b) => b.localeCompare(a)));
}
