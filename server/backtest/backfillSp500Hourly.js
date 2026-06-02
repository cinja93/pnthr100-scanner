// ─────────────────────────────────────────────────────────────────────────────
// backfillSp500Hourly.js
//
// Sources ~5 years of HOURLY bars for the S&P 500 universe from FMP and stores
// them in `pnthr_sp500_hourly_candles`, mirroring the shape of
// `pnthr_ai_hourly_candles` so the Ambush backtest can consume them unchanged:
//   { ticker, hourly:[{date,open,high,low,close,volume}], barCount, fromDate, toDate, lastFetchAt, createdAt }
//
// WHY windowed: FMP's /historical-chart/1hour returns only ~3 months per call,
// so we page backward in WINDOW_DAYS chunks from today to START_DATE.
//
// SAFETY: this is a heavy pull (~500 tickers x ~20 calls). Running it during US
// market hours competes with the LIVE Ambush engine's FMP usage and can rate-limit
// live trading. It refuses to run 9:00–16:15 ET unless you pass --force-market.
//
// USAGE:
//   node backtest/backfillSp500Hourly.js                 # full backfill (after close)
//   node backtest/backfillSp500Hourly.js --ticker AAPL --max-windows 2   # quick validation
//   node backtest/backfillSp500Hourly.js --force         # refetch even if ticker already done
//   node backtest/backfillSp500Hourly.js --force-market  # override the market-hours guard
// ─────────────────────────────────────────────────────────────────────────────
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { connectToDatabase } from '../database.js';
import { getSp500Tickers } from '../constituents.js';

dotenv.config();

const FMP_KEY    = process.env.FMP_API_KEY;
const TARGET_COL = 'pnthr_sp500_hourly_candles';
const START_DATE = '2021-06-01';   // ~5y incl. full 2022 bear (FMP intraday depth permitting)
const WINDOW_DAYS = 90;            // FMP serves ~3 months of hourly per call
const THROTTLE_MS = 180;           // be polite to FMP; ~333 calls/min ceiling
const MAX_RETRIES = 4;

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const flagVal = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const ONLY_TICKER  = flagVal('--ticker');
const MAX_WINDOWS  = flagVal('--max-windows') ? parseInt(flagVal('--max-windows'), 10) : Infinity;
const FORCE        = hasFlag('--force');
const FORCE_MARKET = hasFlag('--force-market');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ymd = (d) => d.toISOString().slice(0, 10);

// ── ET market-hours guard (no Date.now arg issues: uses real clock at runtime) ──
function isMarketHoursET() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dow = et.getDay();                 // 0 Sun .. 6 Sat
  if (dow === 0 || dow === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 9 * 60 && mins <= 16 * 60 + 15; // 9:00–16:15 ET
}

async function fetchWindow(ticker, from, to) {
  const url = `https://financialmodelingprep.com/api/v3/historical-chart/1hour/${ticker}?from=${from}&to=${to}&apikey=${FMP_KEY}`;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) { await sleep(2000 * attempt); continue; }   // rate limited: back off
      if (!res.ok) { await sleep(500 * attempt); continue; }
      const data = await res.json();
      if (!Array.isArray(data)) return [];
      return data;
    } catch (e) {
      if (attempt === MAX_RETRIES) throw e;
      await sleep(500 * attempt);
    }
  }
  return [];
}

async function backfillTicker(ticker) {
  const bars = new Map(); // date -> bar (dedupe)
  let to = ymd(new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })));
  let windows = 0;
  while (windows < MAX_WINDOWS) {
    const toD = new Date(to + 'T00:00:00Z');
    const fromD = new Date(toD.getTime() - WINDOW_DAYS * 86400000);
    const from = ymd(fromD);
    const chunk = await fetchWindow(ticker, from, to);
    windows++;
    let added = 0;
    for (const b of chunk) {
      if (!b.date || bars.has(b.date)) continue;
      bars.set(b.date, {
        date: b.date,
        open: +b.open, high: +b.high, low: +b.low, close: +b.close,
        volume: +(b.volume || 0),
      });
      added++;
    }
    await sleep(THROTTLE_MS);
    // Stop when we've paged past the start date, or a window returns nothing new
    // (FMP exhausted its intraday depth for this name).
    if (from <= START_DATE) break;
    if (chunk.length === 0 && added === 0) break;
    to = from;
  }
  const hourly = [...bars.values()].sort((a, b) => a.date.localeCompare(b.date));
  return hourly;
}

async function main() {
  if (!FMP_KEY) { console.error('Missing FMP_API_KEY'); process.exit(1); }
  if (isMarketHoursET() && !FORCE_MARKET) {
    console.error('⛔ Market is open (9:00–16:15 ET). This heavy FMP pull can rate-limit LIVE trading.');
    console.error('   Run after the 4pm close, or pass --force-market to override.');
    process.exit(2);
  }

  const db = await connectToDatabase();
  const col = db.collection(TARGET_COL);
  await col.createIndex({ ticker: 1 }, { unique: true });

  let tickers = ONLY_TICKER ? [ONLY_TICKER.toUpperCase()] : (await getSp500Tickers()).map(t => t.toUpperCase());
  tickers = [...new Set(tickers)];
  console.log(`[SP500 BACKFILL] ${tickers.length} tickers -> ${TARGET_COL} (from ${START_DATE}, ${WINDOW_DAYS}d windows)`);

  let done = 0, skipped = 0, failed = 0, totalBars = 0;
  const t0 = Date.now();
  for (const ticker of tickers) {
    if (!FORCE && ONLY_TICKER == null) {
      const existing = await col.findOne({ ticker }, { projection: { barCount: 1 } });
      if (existing && existing.barCount > 0) { skipped++; continue; }   // resume: already done
    }
    try {
      const hourly = await backfillTicker(ticker);
      if (hourly.length === 0) { console.log(`  ${ticker}: 0 bars (no FMP data)`); failed++; continue; }
      await col.updateOne(
        { ticker },
        { $set: {
            ticker, hourly, barCount: hourly.length,
            fromDate: hourly[0].date, toDate: hourly[hourly.length - 1].date,
            lastFetchAt: new Date().toISOString(),
          },
          $setOnInsert: { createdAt: new Date().toISOString() },
        },
        { upsert: true },
      );
      done++; totalBars += hourly.length;
      console.log(`  ${ticker}: ${hourly.length} bars (${hourly[0].date.slice(0,10)} → ${hourly[hourly.length-1].date.slice(0,10)})  [${done}/${tickers.length}]`);
    } catch (e) {
      console.log(`  ${ticker}: ERROR ${e.message}`); failed++;
    }
  }
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\n[SP500 BACKFILL] done=${done} skipped=${skipped} failed=${failed} | ${totalBars.toLocaleString()} bars | ${mins} min`);
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
}
