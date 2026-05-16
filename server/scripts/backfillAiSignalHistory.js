#!/usr/bin/env node
// server/scripts/backfillAiSignalHistory.js
//
// Backfills ai_signal_history from stored weekly candle data.
// For each past Monday, truncates candle history up to that week and replays
// the signal state machine to reconstruct what signals would have been active.
//
// Usage: node server/scripts/backfillAiSignalHistory.js [--from YYYY-MM-DD] [--dry-run]
//
// Defaults: from 2023-01-02 (first tradeable Monday after AI warmup period)

import 'dotenv/config';
import { connectToDatabase } from '../database.js';
import { detectAllSignals, calculateEMA } from '../signalDetection.js';
import { SECTORS } from '../scripts/aiUniverse/aiUniverseData.js';
import { SECTOR_EMA_PERIODS } from '../data/pnthrAiSectorsConfig.js';

const AI_GATE_OFFSET = 0.25;
const LOT_OFFSETS = [0, 0.03, 0.06, 0.10, 0.14];

const TICKER_TO_SECTOR_ID = {};
for (const sec of SECTORS) {
  for (const h of sec.holdings) {
    TICKER_TO_SECTOR_ID[h.ticker] = sec.id;
  }
}
const ALL_TICKERS = Object.keys(TICKER_TO_SECTOR_ID);

function effectivePeriod(barCount, sectorPeriod) {
  if (barCount >= sectorPeriod * 3) return sectorPeriod;
  if (barCount >= 21 + 2) return 21;
  return null;
}

function getMondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = d.getUTCDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().split('T')[0];
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const fromIdx = args.indexOf('--from');
  const fromDate = fromIdx >= 0 && args[fromIdx + 1] ? args[fromIdx + 1] : '2023-01-02';
  const toIdx = args.indexOf('--to');
  const toDate = toIdx >= 0 && args[toIdx + 1] ? args[toIdx + 1] : null;

  console.log(`AI Signal History Backfill`);
  console.log(`  From:    ${fromDate}`);
  console.log(`  Dry run: ${dryRun}`);
  console.log();

  const db = await connectToDatabase();

  // Load all weekly candles for AI universe tickers
  console.log(`Loading weekly candles for ${ALL_TICKERS.length} tickers...`);
  const weeklyDocs = await db.collection('pnthr_ai_bt_candles_weekly')
    .find({ ticker: { $in: ALL_TICKERS } }, { projection: { ticker: 1, weekly: 1 } })
    .toArray();
  const weeklyByTicker = {};
  for (const d of weeklyDocs) {
    weeklyByTicker[d.ticker] = (d.weekly || [])
      .sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  }
  console.log(`Loaded candles for ${weeklyDocs.length} tickers`);

  // Collect all unique Mondays from the candle data
  const allMondays = new Set();
  for (const bars of Object.values(weeklyByTicker)) {
    for (const b of bars) {
      allMondays.add(b.weekOf);
    }
  }
  const sortedMondays = [...allMondays].sort();
  const todayMonday = getMondayOf(new Date().toISOString().split('T')[0]);

  // Filter to our range
  const endDate = toDate || todayMonday;
  const targetMondays = sortedMondays.filter(m => m >= fromDate && m <= endDate);
  console.log(`Processing ${targetMondays.length} weeks (${targetMondays[0]} to ${targetMondays[targetMondays.length - 1]})\n`);

  let totalSaved = 0;

  for (let wi = 0; wi < targetMondays.length; wi++) {
    const weekOf = targetMondays[wi];
    const signals = {};

    for (const ticker of ALL_TICKERS) {
      const allBars = weeklyByTicker[ticker] || [];
      // Truncate to bars on or before this weekOf
      const barsThruWeek = allBars.filter(b => b.weekOf <= weekOf);
      if (barsThruWeek.length === 0) continue;

      const sectorId = TICKER_TO_SECTOR_ID[ticker];
      const period = SECTOR_EMA_PERIODS[sectorId] || 30;
      const wPeriod = effectivePeriod(barsThruWeek.length, period);
      if (!wPeriod) continue;

      const wBars = barsThruWeek.map(b => ({
        time: b.weekOf, open: b.open, high: b.high, low: b.low, close: b.close,
      }));

      try {
        const { events, pnthrStop, currentSignal, activeType } = detectAllSignals(wBars, wPeriod, false, null, AI_GATE_OFFSET);
        const lastEvent = events[events.length - 1];
        const lastBarTime = wBars[wBars.length - 1].time;
        const isNewSignal = lastEvent && lastEvent.time === lastBarTime;
        const finalSignal = activeType || currentSignal || (lastEvent ? lastEvent.signal : null);
        const finalDate = lastEvent ? lastEvent.time : null;

        const emaData = calculateEMA(wBars, wPeriod);
        const emaValue = emaData.length > 0 ? emaData[emaData.length - 1].value : null;

        let profitDollar = null, profitPct = null, lotsFilled = null, entryPrice = null;
        if (activeType && events.length > 0) {
          const entryEvent = [...events].reverse().find(e => e.signal === activeType);
          if (entryEvent) {
            const lastClose = wBars[wBars.length - 1].close;
            const entryIdx = wBars.findIndex(b => b.time === entryEvent.time);
            if (entryIdx >= 0) {
              entryPrice = activeType === 'BL'
                ? parseFloat((Math.max(wBars[Math.max(0, entryIdx - 1)]?.high || 0, wBars[Math.max(0, entryIdx - 2)]?.high || 0) + 0.01).toFixed(2))
                : parseFloat((Math.min(wBars[Math.max(0, entryIdx - 1)]?.low || Infinity, wBars[Math.max(0, entryIdx - 2)]?.low || Infinity) - 0.01).toFixed(2));
              if (activeType === 'BL') {
                profitDollar = parseFloat((lastClose - entryPrice).toFixed(2));
              } else {
                profitDollar = parseFloat((entryPrice - lastClose).toFixed(2));
              }
              profitPct = entryPrice !== 0 ? parseFloat(((profitDollar / entryPrice) * 100).toFixed(2)) : null;

              // Simulate lots filled: check if price reached each trigger during the position
              const positionBars = wBars.slice(entryIdx);
              lotsFilled = 0;
              for (const offset of LOT_OFFSETS) {
                const trigger = activeType === 'BL'
                  ? entryPrice * (1 + offset)
                  : entryPrice * (1 - offset);
                const hit = activeType === 'BL'
                  ? positionBars.some(b => b.high >= trigger)
                  : positionBars.some(b => b.low <= trigger);
                if (hit) lotsFilled++;
                else break;
              }
            }
          }
        }
        if (!activeType && lastEvent && (lastEvent.signal === 'BE' || lastEvent.signal === 'SE')) {
          profitDollar = lastEvent.profitDollar ?? null;
          profitPct = lastEvent.profitPct ?? null;
          // For closed positions, simulate lots from the full trade run
          const entrySignal = lastEvent.signal === 'BE' ? 'BL' : 'SS';
          const entryEv = [...events].reverse().find(e => e.signal === entrySignal);
          if (entryEv) {
            const eIdx = wBars.findIndex(b => b.time === entryEv.time);
            const exitIdx = wBars.findIndex(b => b.time === lastEvent.time);
            if (eIdx >= 0 && exitIdx >= 0) {
              const ep = entrySignal === 'BL'
                ? parseFloat((Math.max(wBars[Math.max(0, eIdx - 1)]?.high || 0, wBars[Math.max(0, eIdx - 2)]?.high || 0) + 0.01).toFixed(2))
                : parseFloat((Math.min(wBars[Math.max(0, eIdx - 1)]?.low || Infinity, wBars[Math.max(0, eIdx - 2)]?.low || Infinity) - 0.01).toFixed(2));
              const tradeBars = wBars.slice(eIdx, exitIdx + 1);
              lotsFilled = 0;
              for (const offset of LOT_OFFSETS) {
                const trigger = entrySignal === 'BL' ? ep * (1 + offset) : ep * (1 - offset);
                const hit = entrySignal === 'BL'
                  ? tradeBars.some(b => b.high >= trigger)
                  : tradeBars.some(b => b.low <= trigger);
                if (hit) lotsFilled++;
                else break;
              }
            }
          }
        }

        if (finalSignal) {
          signals[ticker] = {
            signal: finalSignal,
            signalDate: finalDate,
            isNewSignal: !!isNewSignal,
            stopPrice: activeType ? pnthrStop : null,
            ema21: emaValue,
            emaPeriod: wPeriod,
            profitDollar,
            profitPct,
            lotsFilled,
          };
        }
      } catch {
        // skip individual ticker errors
      }
    }

    const signalCount = Object.keys(signals).length;

    if (!dryRun && signalCount > 0) {
      const ops = Object.entries(signals).map(([ticker, s]) => ({
        updateOne: {
          filter: { ticker, weekOf },
          update: {
            $set: {
              ticker,
              weekOf,
              signal: s.signal,
              ema21: s.ema21,
              emaPeriod: s.emaPeriod,
              stopPrice: s.stopPrice,
              isNewSignal: s.isNewSignal,
              signalDate: s.signalDate,
              profitDollar: s.profitDollar ?? null,
              profitPct: s.profitPct ?? null,
              lotsFilled: s.lotsFilled ?? null,
              savedAt: new Date(),
            },
          },
          upsert: true,
        },
      }));
      await db.collection('ai_signal_history').bulkWrite(ops);
    }

    totalSaved += signalCount;
    if ((wi + 1) % 10 === 0 || wi === targetMondays.length - 1) {
      const blCount = Object.values(signals).filter(s => s.signal === 'BL').length;
      const ssCount = Object.values(signals).filter(s => s.signal === 'SS').length;
      console.log(`  [${wi + 1}/${targetMondays.length}] ${weekOf}: ${signalCount} signals (BL=${blCount}, SS=${ssCount})`);
    }
  }

  console.log(`\nBackfill complete: ${totalSaved} total signal records across ${targetMondays.length} weeks`);
  if (dryRun) console.log('(dry run — nothing written to DB)');

  process.exit(0);
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
