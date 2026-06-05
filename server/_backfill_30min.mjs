// server/_backfill_30min.mjs
// ── Backfill FMP 30-MINUTE bars for the AI-300, 2022-10 → present ─────────────
// Needed to rebuild :00 CLOCK-HOUR bars (matching the trader's TWS chart) so the
// Ambush backtest can re-validate on the SAME bars the live engine trails off.
//
// FMP /historical-chart/30min caps each call at ~260 bars (~20 trading days)
// regardless of from/to, so we walk `to` BACKWARD in ~3-week windows per ticker,
// dedupe by timestamp, and store one doc per ticker. Resumable: a ticker whose
// stored data already reaches back to START is skipped.
//
// Usage:
//   node _backfill_30min.mjs --test           (first 2 tickers, verbose)
//   node _backfill_30min.mjs                   (full AI-300, background-friendly)
// ─────────────────────────────────────────────────────────────────────────────
import dotenv from 'dotenv';
dotenv.config({ path: new URL('./.env', import.meta.url).pathname });
import { connectToDatabase } from './database.js';
import { SECTORS } from './scripts/aiUniverse/aiUniverseData.js';

const K = process.env.FMP_API_KEY;
const START = '2022-10-25';
const END   = '2026-06-06';
const STEP_DAYS = 24;          // calendar days per window (~17 trading days, < the ~260-bar cap)
const TICKER_CONCURRENCY = 4;  // tickers fetched in parallel
const COL = 'pnthr_ai_30min_candles';
const TEST = process.argv.includes('--test');

const addDays = (d, n) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchWindow(ticker, from, to, tries = 3) {
  const url = `https://financialmodelingprep.com/api/v3/historical-chart/30min/${ticker}?from=${from}&to=${to}&apikey=${K}`;
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(url);
      if (r.status === 429) { await sleep(1500 * (t + 1)); continue; }
      if (!r.ok) { await sleep(300); continue; }
      const d = await r.json();
      return Array.isArray(d) ? d : [];
    } catch { await sleep(400); }
  }
  return [];
}

async function backfillTicker(ticker) {
  const byDate = new Map();
  let to = END, emptyStreak = 0, calls = 0;
  while (to > START) {
    const from = addDays(to, -STEP_DAYS);
    const bars = await fetchWindow(ticker, from, to); calls++;
    let added = 0;
    for (const b of bars) {
      if (!byDate.has(b.date)) { byDate.set(b.date, { date: b.date, open: +b.open, high: +b.high, low: +b.low, close: +b.close, volume: +b.volume || 0 }); added++; }
    }
    const oldest = bars.length ? bars[bars.length - 1].date.slice(0, 10) : null;
    if (!bars.length) { emptyStreak++; if (emptyStreak >= 2 && byDate.size > 0) break; } else emptyStreak = 0;
    // Step the window back. If FMP capped (oldest > from), resume AT oldest to avoid a gap.
    to = (oldest && oldest > from) ? oldest : from;
    if (oldest && oldest <= START) break;
    if (calls > 120) break; // safety cap per ticker
    await sleep(60);
  }
  const min30 = [...byDate.values()].filter(b => b.date >= START).sort((a, b) => a.date.localeCompare(b.date));
  return { min30, calls };
}

async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('no db'); process.exit(1); }
  if (!K) { console.error('no FMP_API_KEY'); process.exit(1); }
  await db.collection(COL).createIndex({ ticker: 1 }, { unique: true }).catch(() => {});

  let tickers = [...new Set(SECTORS.flatMap(s => s.holdings.map(h => h.ticker)))].sort();
  if (TEST) tickers = tickers.slice(0, 2);
  console.log(`[30min backfill] ${tickers.length} tickers, ${START} → ${END}, step ${STEP_DAYS}d, concurrency ${TICKER_CONCURRENCY}${TEST ? ' (TEST)' : ''}`);

  // Resume: skip tickers already covering back to START (oldest <= 2022-11-05).
  const existing = await db.collection(COL).find({}, { projection: { ticker: 1, min30: { $slice: 1 } } }).toArray();
  const done = new Set(existing.filter(d => d.min30?.[0]?.date && d.min30[0].date <= '2022-11-05').map(d => d.ticker));
  if (!TEST && done.size) console.log(`  resuming — ${done.size} tickers already complete, skipping`);
  const todo = tickers.filter(t => !done.has(t));

  let n = 0, totalBars = 0, totalCalls = 0; const t0 = Date.now();
  for (let i = 0; i < todo.length; i += TICKER_CONCURRENCY) {
    const batch = todo.slice(i, i + TICKER_CONCURRENCY);
    const res = await Promise.all(batch.map(async (tk) => ({ tk, ...(await backfillTicker(tk)) })));
    for (const { tk, min30, calls } of res) {
      totalCalls += calls; totalBars += min30.length;
      if (min30.length) await db.collection(COL).replaceOne({ ticker: tk }, { ticker: tk, min30, updatedAt: new Date(), oldest: min30[0].date, newest: min30[min30.length - 1].date }, { upsert: true });
      n++;
      if (TEST || n % 20 === 0 || n === todo.length) {
        const mins = ((Date.now() - t0) / 60000).toFixed(1);
        console.log(`  [${n}/${todo.length}] ${tk}: ${min30.length} bars ${min30[0]?.date?.slice(0,10)}→${min30[min30.length-1]?.date?.slice(0,10)} (${calls} calls) · ${totalCalls} calls, ${mins}m elapsed`);
      }
    }
  }
  console.log(`[30min backfill] DONE — ${n} tickers, ${totalBars.toLocaleString()} bars, ${totalCalls.toLocaleString()} calls, ${((Date.now()-t0)/60000).toFixed(1)}m`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
