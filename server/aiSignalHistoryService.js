// server/aiSignalHistoryService.js
//
// Saves weekly signal snapshots for the AI 300 universe to MongoDB.
// Mirrors signalHistoryService.js but writes to ai_signal_history collection.
//
// Collection: ai_signal_history
// Schema: { ticker, weekOf (YYYY-MM-DD Monday), signal, ema21, emaPeriod,
//           stopPrice, isNewSignal, signalDate, profitDollar, profitPct, savedAt }

import { connectToDatabase } from './database.js';
import { DEFAULT_EMA_PERIOD } from './sectorEmaConfig.js';

export function getCurrentWeekOf() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = today.getDay();
  const daysToMonday = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(today);
  monday.setDate(today.getDate() + daysToMonday);
  return monday.toISOString().split('T')[0];
}

export async function saveAiWeeklySnapshot(signalMap) {
  const db = await connectToDatabase();
  const coll = db.collection('ai_signal_history');
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
          lotsFilled:   s.lotsFilled   ?? null,
          savedAt: new Date(),
        },
      },
      upsert: true,
    },
  }));

  await coll.bulkWrite(ops);
  return entries.length;
}

export async function getAiTickerHistory(ticker) {
  const db = await connectToDatabase();
  return db.collection('ai_signal_history')
    .find({ ticker: ticker.toUpperCase() })
    .sort({ weekOf: -1 })
    .toArray();
}

export async function getAiWeekSnapshot(weekOf) {
  const db = await connectToDatabase();
  return db.collection('ai_signal_history')
    .find({ weekOf, signal: { $ne: null } })
    .sort({ ticker: 1 })
    .toArray();
}

export async function listAiArchivedWeeks() {
  const db = await connectToDatabase();
  return db.collection('ai_signal_history')
    .distinct('weekOf')
    .then(weeks => weeks.sort((a, b) => b.localeCompare(a)));
}
