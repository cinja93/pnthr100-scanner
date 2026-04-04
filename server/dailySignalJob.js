// ── Daily Signal Job ──────────────────────────────────────────────────────────
// Runs Mon–Fri at 5:05 PM ET (after market close) via cron in index.js.
// Can also be triggered manually via POST /api/admin/run-daily-signal-job.
//
// What it does:
//   1. Gets full 679-stock universe (tickers from constituent cache + sectors from MongoDB)
//   2. Runs the signal state machine against today's developing weekly candle
//      (Mon open → today's close), which is the same logic as signalService.js
//   3. Persists per-stock results to pnthr_daily_signals (replaced each run)
//   4. Persists aggregate sector counts to pnthr_daily_pulse_snapshot (upserted by runDate)
//
// isNew = true  → signal fired on today's developing weekly bar (BL or SS just crossed)
// isNew = false → stock is already in BL/SS from a prior week (existing position)
//
// The Pulse endpoint uses pnthr_daily_pulse_snapshot for dial counts (↑38 ↓47) and
// pnthr_daily_signals (isNew: true) for the ratio bars and 5D sector signal summary.

import { connectToDatabase } from './database.js';
import { normalizeSector }   from './sectorUtils.js';
import { DEFAULT_EMA_PERIOD } from './sectorEmaConfig.js';

// ── Sector lookup ─────────────────────────────────────────────────────────────
// Build ticker→sector map from MongoDB (avoids expensive FMP profile API calls).
// Uses pnthr_kill_scores (has sector for every stock that ever appeared in Kill scoring)
// with pnthr_kill_appearances as a secondary fallback.
async function buildSectorMap(db, tickers) {
  // Aggregate most-recent sector per ticker from kill_scores
  const sectorDocs = await db.collection('pnthr_kill_scores')
    .aggregate([
      { $sort: { weekOf: -1 } },
      { $group: { _id: '$ticker', sector: { $first: '$sector' } } },
    ]).toArray();

  const map = {};
  for (const d of sectorDocs) {
    if (d._id && d.sector) map[d._id] = d.sector;
  }

  // Fill gaps from kill_appearances
  const missing = tickers.filter(t => !map[t]);
  if (missing.length > 0) {
    const appDocs = await db.collection('pnthr_kill_appearances')
      .find({ ticker: { $in: missing } }, { projection: { ticker: 1, sector: 1 } })
      .toArray();
    for (const d of appDocs) {
      if (d.ticker && d.sector && !map[d.ticker]) map[d.ticker] = d.sector;
    }
  }

  return map;
}

// ── Main job ──────────────────────────────────────────────────────────────────
export async function runDailySignalJob() {
  const t0 = Date.now();
  console.log('[dailySignalJob] Starting daily signal snapshot...');

  const { getAllTickers }              = await import('./constituents.js');
  const { getSp400Longs, getSp400Shorts } = await import('./sp400Service.js');
  const { getSignals }                 = await import('./signalService.js');

  const db = await connectToDatabase();

  // ── 1. Get full ticker universe ──────────────────────────────────────────
  const [baseTickers, specLongs, specShorts] = await Promise.all([
    getAllTickers(),
    getSp400Longs().catch(() => []),
    getSp400Shorts().catch(() => []),
  ]);
  const tickers = [...new Set([...baseTickers, ...specLongs, ...specShorts])];
  console.log(`[dailySignalJob] Universe: ${tickers.length} tickers`);

  // ── 2. Sector map from MongoDB ───────────────────────────────────────────
  const sectorMap = await buildSectorMap(db, tickers);

  // ── 3. Run signal state machine ──────────────────────────────────────────
  // getSignals invalidates its cache daily and fetches through today's close,
  // so the developing weekly candle (Mon→today) is always included.
  const signals = await getSignals(tickers);
  console.log(`[dailySignalJob] Signals computed for ${Object.keys(signals).length} tickers`);

  // ── 4. Build per-stock docs ──────────────────────────────────────────────
  const runDate = new Date().toISOString().split('T')[0];
  const docs = [];

  for (const [ticker, sig] of Object.entries(signals)) {
    if (!sig.signal) continue; // skip BE/SE/null — only active BL/SS signals
    const rawSector = sectorMap[ticker] || 'Unknown';
    const sector    = normalizeSector(rawSector);
    docs.push({
      ticker,
      sector,
      signal:     sig.signal,       // 'BL' or 'SS'
      signalDate: sig.signalDate || null,
      isNew:      sig.isNewSignal ?? false,
      ema21:      sig.ema21 ?? null,
      emaPeriod:  sig.emaPeriod ?? DEFAULT_EMA_PERIOD,
      emaRising:  sig.emaRising ?? null,
      runDate,
      updatedAt:  new Date(),
    });
  }

  // ── 5. Aggregate sector breadth ──────────────────────────────────────────
  const bySector = {};
  let blTotal = 0, ssTotal = 0, newBlTotal = 0, newSsTotal = 0;

  for (const doc of docs) {
    const s = doc.sector;
    if (!bySector[s]) bySector[s] = { bl: 0, ss: 0 };
    if (doc.signal === 'BL') { bySector[s].bl++; blTotal++;  if (doc.isNew) newBlTotal++; }
    if (doc.signal === 'SS') { bySector[s].ss++; ssTotal++;  if (doc.isNew) newSsTotal++; }
  }

  // ── 6. Persist ───────────────────────────────────────────────────────────
  await db.collection('pnthr_daily_signals').deleteMany({});
  if (docs.length > 0) {
    await db.collection('pnthr_daily_signals').insertMany(docs);
  }

  await db.collection('pnthr_daily_pulse_snapshot').updateOne(
    { runDate },
    { $set: { runDate, bySector, blTotal, ssTotal, newBlTotal, newSsTotal, updatedAt: new Date() } },
    { upsert: true }
  );

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[dailySignalJob] Done in ${elapsed}s — ${docs.length} active signals | BL: ${blTotal} SS: ${ssTotal} | New BL: ${newBlTotal} New SS: ${newSsTotal}`);
  return { tickers: tickers.length, signals: docs.length, blTotal, ssTotal, newBlTotal, newSsTotal, elapsed };
}
