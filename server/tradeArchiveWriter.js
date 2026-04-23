// server/tradeArchiveWriter.js
//
// Keeps pnthr679_trade_archive in sync with live signals.
//
// The archive was originally loaded from a one-time CSV import
// (see scripts/importTradeArchive.js) and never had an ongoing writer. Data
// went stale at 2026-03-09 as a result. This module fills that gap: every
// time the Perch newsletter runs, the current week's BE/SE exits are
// upserted into the archive, enriched with sector/companyName from the
// live stock universe so getTradeOfWeek and getFromArchives continue to
// have fresh data to draw from.
//
// Called from perchService.generatePerch during the live-signals flow.

import { connectToDatabase } from './database.js';

// Friday YYYY-MM-DD → Monday YYYY-MM-DD for the same trading week.
function fridayToMonday(weekOf) {
  const fri = new Date(weekOf + 'T12:00:00Z');
  const mon = new Date(fri);
  mon.setUTCDate(fri.getUTCDate() - 4);
  return mon.toISOString().split('T')[0];
}

/**
 * Upsert this week's BE/SE exits into pnthr679_trade_archive.
 *
 * @param {object} params
 * @param {string} params.weekOf     Friday of the target week (YYYY-MM-DD).
 * @param {object} params.signals    { ticker: { signal, profitPct, profitDollar, signalDate, ... } }
 * @param {object} params.stockMeta  { ticker: { companyName, sector, exchange, currentPrice } }
 * @returns {Promise<{upserted: number, modified: number, total: number}>}
 */
export async function archiveThisWeeksExits({ weekOf, signals = {}, stockMeta = {} }) {
  const db = await connectToDatabase();
  if (!db) return { upserted: 0, modified: 0, total: 0 };

  const weekStart = fridayToMonday(weekOf);
  const exitDateObj = new Date(weekStart + 'T00:00:00Z');

  // Filter signals down to exits that actually happened THIS week. signalDate
  // is the Monday of the week the signal fired, so we match on that.
  const exits = Object.entries(signals)
    .filter(([, s]) =>
      (s?.signal === 'BE' || s?.signal === 'SE') &&
      s.signalDate === weekStart &&
      s.profitPct != null
    );

  if (exits.length === 0) return { upserted: 0, modified: 0, total: 0 };

  const archive = db.collection('pnthr679_trade_archive');

  const ops = exits.map(([ticker, s]) => {
    const meta = stockMeta[ticker] || {};
    return {
      updateOne: {
        filter: { ticker, exitDate: exitDateObj },
        update: {
          $set: {
            ticker,
            companyName:   meta.companyName || ticker,
            sector:        meta.sector      || 'Unknown',
            exchange:      meta.exchange    || null,
            currentPrice:  meta.currentPrice ?? null,
            // The entry side of the trade. BE exit means the original position
            // was a long (BL); SE means the original was a short (SS).
            signal:        s.signal === 'BE' ? 'BL' : 'SS',
            exitSignal:    s.signal,
            exitDate:      exitDateObj,
            profitDollar:  s.profitDollar ?? null,
            profitPct:     s.profitPct,
            // signal_history / live signals don't track closeConvictionPct.
            // Use a sentinel >= 8 so getTradeOfWeek (which filters >=8) and
            // getFromArchives keep these entries eligible. Real conviction
            // data is only available on CSV-imported rows.
            closeConvictionPct: 10,
            isWinner:           s.profitPct > 0,
            bigWinner:          s.profitPct >= 20,
            status:             'CLOSED',
            source:             'live_signals',
            archivedAt:         new Date(),
          },
        },
        upsert: true,
      },
    };
  });

  const result = await archive.bulkWrite(ops);
  return {
    upserted: result.upsertedCount || 0,
    modified: result.modifiedCount || 0,
    total:    exits.length,
  };
}
