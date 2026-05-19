// server/aiUniverseHealthJob.js
// ── PNTHR AI Universe — weekly health check + auto-deactivation ─────────────
//
// Runs every Sunday at 8 PM ET (well before Monday open).
//
// What it does:
//   1. For every ticker currently in the AI Universe (SECTORS):
//      a. Check FMP profile → isActivelyTrading
//      b. Check last daily bar date in pnthr_ai_bt_candles
//   2. Any ticker that is BOTH not actively trading AND has no FMP data for
//      > 30 days is written to pnthr_ai_deactivated (upsert, idempotent).
//   3. Tickers that pass the checks are removed from pnthr_ai_deactivated if
//      they were there (data may have resumed, e.g. temporary FMP gap).
//   4. Returns a full health report.
//
// The deactivated collection is read at runtime by aiUniverseService.js and
// aiUniverseDailyJob.js to exclude dead tickers from the live universe and
// the candle update loop.
// ────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';
import { SECTORS } from './scripts/aiUniverse/aiUniverseData.js';
import { fetchFMP } from './stockService.js';

const FMP_CHUNK  = 20;   // FMP profile endpoint takes individual calls — batch with small parallelism
const STALE_DAYS = 30;   // days without FMP data before a ticker is considered data-dead
const BATCH_DELAY = 200; // ms between FMP profile calls to avoid 429s
const sleep = ms => new Promise(r => setTimeout(r, ms));

const COLLECTION = 'pnthr_ai_deactivated';

// ── Load the current deactivated set from Mongo ──────────────────────────────
// Called at startup by consumers (service + daily job) so they can filter.
export async function loadDeactivatedTickers() {
  try {
    const db = await connectToDatabase();
    if (!db) return new Set();
    const docs = await db.collection(COLLECTION).find({}, { projection: { ticker: 1 } }).toArray();
    return new Set(docs.map(d => d.ticker));
  } catch {
    return new Set();
  }
}

// ── Main health check ────────────────────────────────────────────────────────
export async function runAiUniverseHealthCheck() {
  const db = await connectToDatabase();
  if (!db) return { ok: false, error: 'Mongo connect failed' };

  const deactivatedCol = db.collection(COLLECTION);
  const candlesCol     = db.collection('pnthr_ai_bt_candles');

  await deactivatedCol.createIndex({ ticker: 1 }, { unique: true });

  // Flatten all current universe tickers
  const allTickers = [];
  for (const sec of SECTORS) for (const h of sec.holdings) allTickers.push(h.ticker);
  const tickers = [...new Set(allTickers)];

  const todayMs = Date.now();
  const results = [];

  console.log(`[AI Health] checking ${tickers.length} tickers...`);

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];

    // FMP profile — isActivelyTrading is the authoritative "still listed?" flag
    let isActivelyTrading = true; // default safe
    try {
      const prof = await fetchFMP(`/profile/${ticker}`);
      if (Array.isArray(prof) && prof.length > 0) {
        isActivelyTrading = prof[0].isActivelyTrading !== false; // treat undefined as true
      }
    } catch {
      // FMP unreachable — don't deactivate on network error
    }

    // Last bar date from Mongo candles
    let lastBarDate = null;
    let daysStale   = 0;
    try {
      const doc = await candlesCol.findOne({ ticker }, { projection: { toDate: 1 } });
      if (doc?.toDate) {
        lastBarDate = doc.toDate;
        daysStale   = Math.round((todayMs - Date.parse(lastBarDate + 'T00:00:00Z')) / 86400000);
      }
    } catch { /* Mongo error — leave daysStale=0 so we don't false-deactivate */ }

    // Deactivate when FMP says not trading AND data has been dead > STALE_DAYS
    const shouldDeactivate = !isActivelyTrading && daysStale > STALE_DAYS;
    const status = shouldDeactivate ? 'DEACTIVATED' : (!isActivelyTrading ? 'INACTIVE_FMP' : daysStale > STALE_DAYS ? 'DATA_GAP' : 'HEALTHY');

    results.push({ ticker, isActivelyTrading, lastBarDate, daysStale, status });

    if (shouldDeactivate) {
      await deactivatedCol.updateOne(
        { ticker },
        { $set: { ticker, lastBarDate, daysStale, deactivatedAt: new Date(), reason: 'isActivelyTrading=false + stale data' } },
        { upsert: true },
      );
      console.log(`[AI Health] DEACTIVATED ${ticker} — isActivelyTrading=false, last bar ${lastBarDate} (${daysStale}d ago)`);
    } else {
      // If previously deactivated but now passing checks — reinstate
      const wasDeactivated = await deactivatedCol.findOne({ ticker });
      if (wasDeactivated) {
        await deactivatedCol.deleteOne({ ticker });
        console.log(`[AI Health] REINSTATED ${ticker} — checks now passing`);
      }
    }

    if (i % FMP_CHUNK === FMP_CHUNK - 1) await sleep(BATCH_DELAY);
  }

  const deactivated = results.filter(r => r.status === 'DEACTIVATED');
  const dataGap     = results.filter(r => r.status === 'DATA_GAP');
  const inactiveFmp = results.filter(r => r.status === 'INACTIVE_FMP');
  const healthy     = results.filter(r => r.status === 'HEALTHY');

  const summary = {
    ok:           true,
    checkedAt:    new Date().toISOString(),
    total:        tickers.length,
    healthy:      healthy.length,
    deactivated:  deactivated.length,
    dataGap:      dataGap.length,
    inactiveFmp:  inactiveFmp.length,
    deactivatedTickers: deactivated.map(r => ({ ticker: r.ticker, lastBarDate: r.lastBarDate, daysStale: r.daysStale })),
    dataGapTickers:     dataGap.map(r => ({ ticker: r.ticker, lastBarDate: r.lastBarDate, daysStale: r.daysStale })),
    inactiveFmpOnly:    inactiveFmp.map(r => r.ticker),
  };
  console.log(`[AI Health] done — ${healthy.length} healthy, ${deactivated.length} deactivated, ${dataGap.length} data-gap, ${inactiveFmp.length} inactive-FMP-only`);
  return summary;
}
