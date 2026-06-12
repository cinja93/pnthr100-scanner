// ── Backfill daily candles into pnthr_bt_candles (Carnivore / 679 backtest store) ──
// For a new S&P 500 / 400 constituent that has no candle history yet (e.g. a fresh
// index add). Stores the RAW FMP /historical-price-full bars (adjClose, vwap, etc.)
// to match the existing schema. Dedups against any existing bars.
//
// Run: node --env-file=../.env scripts/backfillBtCandles.mjs --tickers=FLEX[,XYZ]

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });
import { connectToDatabase } from '../database.js';

const FMP_BASE = 'https://financialmodelingprep.com/api/v3';
const KEY = process.env.FMP_API_KEY;
const FROM = '2018-12-31';                                   // matches the existing store's start
const TO = new Date().toISOString().split('T')[0];

const arg = process.argv.find(a => a.startsWith('--tickers='));
const TICKERS = arg ? arg.split('=')[1].split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : [];
if (!TICKERS.length) { console.error('Usage: node scripts/backfillBtCandles.mjs --tickers=FLEX'); process.exit(1); }

const db = await connectToDatabase();
const col = db.collection('pnthr_bt_candles');

for (const ticker of TICKERS) {
  const url = `${FMP_BASE}/historical-price-full/${ticker}?from=${FROM}&to=${TO}&apikey=${KEY}`;
  let raw;
  try { raw = await (await fetch(url)).json(); }
  catch (e) { console.log(`${ticker}: fetch failed — ${e.message}`); continue; }
  const bars = (raw?.historical || []).filter(b => b.date && +b.close > 0);
  if (!bars.length) { console.log(`${ticker}: no FMP data in ${FROM}..${TO}`); continue; }

  const existing = await col.findOne({ ticker }, { projection: { daily: 1 } });
  const seen = new Set((existing?.daily || []).map(b => b.date));
  const merged = [...(existing?.daily || []), ...bars.filter(b => !seen.has(b.date))]
    .sort((a, b) => a.date.localeCompare(b.date));

  await col.updateOne(
    { ticker },
    { $set: {
        ticker, daily: merged, barCount: merged.length,
        from: merged[0].date, to: merged[merged.length - 1].date,
        fromDate: merged[0].date, toDate: merged[merged.length - 1].date,
        fetchedAt: new Date(),
      } },
    { upsert: true }
  );
  console.log(`${ticker}: stored ${merged.length} bars  (${merged[0].date} → ${merged[merged.length - 1].date}, +${bars.filter(b => !seen.has(b.date)).length} new)`);
}
process.exit(0);
