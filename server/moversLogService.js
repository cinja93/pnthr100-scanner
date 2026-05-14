// moversLogService.js — Tracks PNTHR Movers (BL+1 / SS+1) from banner appearance
// through exit (BE, SE, or PNTHR stop hit). Research tool to measure whether
// intraday mover signals represent missed opportunities.
//
// Auto-log: when movers banner fires with BL+1 or SS+1, the entry is recorded
//   with ticker, signal direction, entry price, and date.
// Daily update cron: refreshes current price, checks for exit conditions.
// Exit triggers (whichever comes first):
//   1. Signal flips to BE (Buy Exit) or SE (Short Exit)
//   2. Price hits initial PNTHR stop level

import { connectToDatabase } from './database.js';

const COLL = 'pnthr_movers_log';

/**
 * Log a new mover entry. Idempotent — skips if ticker+entryDate already exists.
 * @param {object} entry
 * @param {string} entry.ticker
 * @param {string} entry.signal — 'BL+1' or 'SS+1'
 * @param {number} entry.entryPrice — price when first seen on movers banner
 * @param {string} entry.entryDate — ISO date 'YYYY-MM-DD'
 * @param {number} [entry.stopPrice] — initial PNTHR stop (from signal cache)
 * @param {string} [entry.sector] — sector name
 * @param {string} [entry.companyName] — company name
 */
export async function logMoverEntry(entry) {
  const db = await connectToDatabase();
  if (!db) return null;

  const coll = db.collection(COLL);

  // Idempotent: one entry per ticker per entry date
  const exists = await coll.findOne({
    ticker: entry.ticker,
    entryDate: entry.entryDate,
  });
  if (exists) return exists;

  const doc = {
    ticker: entry.ticker,
    signal: entry.signal,           // 'BL+1' or 'SS+1'
    direction: entry.signal.startsWith('BL') ? 'LONG' : 'SHORT',
    entryPrice: entry.entryPrice,
    entryDate: entry.entryDate,
    stopPrice: entry.stopPrice || null,
    sector: entry.sector || null,
    companyName: entry.companyName || null,
    currentPrice: entry.entryPrice,
    returnPct: 0,
    daysHeld: 0,
    status: 'OPEN',                 // OPEN | CLOSED-BE | CLOSED-SE | CLOSED-STOP
    exitPrice: null,
    exitDate: null,
    exitReason: null,
    priceHistory: [],               // [{ date, price, returnPct }]
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await coll.insertOne(doc);
  console.log(`[MoversLog] logged ${entry.ticker} ${entry.signal} @ $${entry.entryPrice}`);
  return { ...doc, _id: result.insertedId };
}

/**
 * Auto-log movers from the current movers banner data.
 * Called by the movers cron or when banner data refreshes.
 */
export async function autoLogFromMovers() {
  const { getMovers } = await import('./moversService.js');
  const movers = await getMovers(true);
  if (!movers) return { logged: 0 };

  const today = new Date().toISOString().slice(0, 10);
  let logged = 0;

  // Collect BL+1 gainers and SS+1 decliners (same filter as client banner)
  const candidates = [];
  const seen = new Set();

  const process = (list, kind) => {
    for (const r of list || []) {
      if (seen.has(r.ticker)) continue;
      if (r.signalLabel === 'BL+1' && kind === 'gainer') {
        candidates.push(r);
        seen.add(r.ticker);
      } else if (r.signalLabel === 'SS+1' && kind === 'decliner') {
        candidates.push(r);
        seen.add(r.ticker);
      }
    }
  };

  process(movers.stocks?.gainers, 'gainer');
  process(movers.stocks?.decliners, 'decliner');
  process(movers.etfs?.gainers, 'gainer');
  process(movers.etfs?.decliners, 'decliner');

  // Fetch signal cache for stop prices
  let signalCache = {};
  try {
    const { getSignals } = await import('./signalService.js');
    const sigs = await getSignals();
    signalCache = sigs || {};
  } catch {}

  for (const c of candidates) {
    const sig = signalCache[c.ticker];
    const stopPrice = sig?.stopPrice || null;

    await logMoverEntry({
      ticker: c.ticker,
      signal: c.signalLabel,
      entryPrice: c.price,
      entryDate: today,
      stopPrice,
      sector: sig?.sector || null,
      companyName: c.name || null,
    });
    logged++;
  }

  return { logged, total: candidates.length };
}

/**
 * Daily update: refresh prices and check exit conditions for all OPEN movers.
 */
export async function updateOpenMovers() {
  const db = await connectToDatabase();
  if (!db) return { updated: 0, closed: 0 };

  const coll = db.collection(COLL);
  const openMovers = await coll.find({ status: 'OPEN' }).toArray();
  if (!openMovers.length) return { updated: 0, closed: 0 };

  const tickers = openMovers.map(m => m.ticker);
  const today = new Date().toISOString().slice(0, 10);

  // Fetch current quotes
  let quoteMap = {};
  try {
    const { fetchAiQuotesBatch } = await import('./aiIntradayOverlay.js');
    quoteMap = await fetchAiQuotesBatch(tickers);
  } catch (err) {
    console.warn('[MoversLog] quote fetch failed:', err.message);
    return { updated: 0, closed: 0 };
  }

  // Fetch current signals for exit detection
  let signalCache = {};
  try {
    const { getSignals } = await import('./signalService.js');
    signalCache = await getSignals() || {};
  } catch {}

  // Also check AI universe signals
  let aiSignals = {};
  try {
    const { getAiUniverseSignals } = await import('./aiUniverseSignalsService.js');
    const result = await getAiUniverseSignals({});
    aiSignals = result?.signals || {};
  } catch {}

  let updated = 0;
  let closed = 0;

  for (const mover of openMovers) {
    const quote = quoteMap[mover.ticker];
    const currentPrice = quote?.price || quote?.previousClose;
    if (!currentPrice) continue;

    const isLong = mover.direction === 'LONG';
    const returnPct = isLong
      ? ((currentPrice - mover.entryPrice) / mover.entryPrice) * 100
      : ((mover.entryPrice - currentPrice) / mover.entryPrice) * 100;

    const entryMs = new Date(mover.entryDate + 'T12:00:00').getTime();
    const nowMs = Date.now();
    const daysHeld = Math.max(0, Math.round((nowMs - entryMs) / (24 * 60 * 60 * 1000)));

    // Check exit conditions
    let exitReason = null;
    const sig = signalCache[mover.ticker] || aiSignals[mover.ticker];

    // 1. Signal flip to BE or SE
    if (sig?.signal === 'BE' && isLong) exitReason = 'BE';
    if (sig?.signal === 'SE' && !isLong) exitReason = 'SE';

    // 2. Stop hit
    if (!exitReason && mover.stopPrice) {
      if (isLong && currentPrice <= mover.stopPrice) exitReason = 'STOP';
      if (!isLong && currentPrice >= mover.stopPrice) exitReason = 'STOP';
    }

    const updateFields = {
      currentPrice: +currentPrice.toFixed(2),
      returnPct: +returnPct.toFixed(2),
      daysHeld,
      updatedAt: new Date(),
    };

    // Append to price history (one entry per day)
    const historyEntry = {
      date: today,
      price: +currentPrice.toFixed(2),
      returnPct: +returnPct.toFixed(2),
    };

    if (exitReason) {
      updateFields.status = `CLOSED-${exitReason}`;
      updateFields.exitPrice = +currentPrice.toFixed(2);
      updateFields.exitDate = today;
      updateFields.exitReason = exitReason;
      closed++;
      console.log(`[MoversLog] closed ${mover.ticker} — ${exitReason} @ $${currentPrice.toFixed(2)} (${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(2)}%)`);
    }

    await coll.updateOne(
      { _id: mover._id },
      {
        $set: updateFields,
        $push: { priceHistory: historyEntry },
      }
    );
    updated++;
  }

  console.log(`[MoversLog] daily update: ${updated} updated, ${closed} closed`);
  return { updated, closed };
}

/**
 * Get all movers log entries, most recent first.
 * @param {object} [opts]
 * @param {string} [opts.status] — filter by status ('OPEN' or 'CLOSED-*')
 * @param {number} [opts.limit] — max entries (default 200)
 */
export async function getMoversLog(opts = {}) {
  const db = await connectToDatabase();
  if (!db) return [];

  const filter = {};
  if (opts.status === 'OPEN') filter.status = 'OPEN';
  else if (opts.status === 'CLOSED') filter.status = { $regex: /^CLOSED/ };

  return db.collection(COLL)
    .find(filter)
    .sort({ entryDate: -1, ticker: 1 })
    .limit(opts.limit || 200)
    .toArray();
}

/**
 * Get summary stats for the movers log.
 */
export async function getMoversLogStats() {
  const db = await connectToDatabase();
  if (!db) return null;

  const coll = db.collection(COLL);
  const all = await coll.find({}).toArray();

  const open = all.filter(m => m.status === 'OPEN');
  const closed = all.filter(m => m.status !== 'OPEN');
  const winners = closed.filter(m => m.returnPct > 0);
  const avgReturn = closed.length
    ? closed.reduce((s, m) => s + m.returnPct, 0) / closed.length
    : 0;
  const avgDays = closed.length
    ? closed.reduce((s, m) => s + m.daysHeld, 0) / closed.length
    : 0;

  return {
    total: all.length,
    open: open.length,
    closed: closed.length,
    winRate: closed.length ? (winners.length / closed.length * 100) : 0,
    avgReturn: +avgReturn.toFixed(2),
    avgDaysHeld: Math.round(avgDays),
  };
}
