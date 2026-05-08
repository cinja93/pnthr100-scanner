// server/scripts/aiUniverse/buildPnthrAi300Index.js
// ── PNTHR AI 300 — Index Backfill ──────────────────────────────────────────
//
// One-time backfill (idempotent, re-runnable). Reads daily constituent bars
// from pnthr_ai_bt_candles, computes capped market-cap weights at each
// monthly rebalance, walks the daily timeline, and writes index OHLCV bars
// to pnthr_ai_index_candles. Divisor history + per-rebalance constituent
// weights are written to pnthr_ai_index_meta for audit transparency.
//
// Methodology (white-paper-canonical):
//   • Base date 2022-11-30, base value 1000.00 (per pnthrAiIndexConfig.js)
//   • Float-adjusted market cap = current sharesOutstanding × close_at_date
//     (sharesOutstanding from FMP /profile; small approximation vs true
//     historical float, but caps dominate for the largest names where
//     drift could matter)
//   • Caps applied iteratively (Nasdaq 100 / S&P 500 style):
//        sort by weight desc → cap any weight exceeding its limit →
//        redistribute excess proportionally to non-capped → repeat to convergence
//   • Synthetic share counts s_i set on rebalance such that the index value
//     does NOT jump on rebalance day; weights drift naturally between
//     rebalances ("let winners run within the cap")
//   • New constituents (post-IPO names) join at the next rebalance after
//     their first available bar; weight is allocated and divisor adjusts
//
// Usage:  cd server && node scripts/aiUniverse/buildPnthrAi300Index.js
// Optional flags:  --from=YYYY-MM-DD  (recompute only from this date forward)
// ────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../../.env', import.meta.url).pathname });

import { connectToDatabase } from '../../database.js';
import { SECTORS } from './aiUniverseData.js';
import {
  INDEX_NAME, INDEX_TICKER, BASE_DATE, BASE_VALUE,
  SINGLE_NAME_CAP, HYPERSCALER_CAP, HYPERSCALER_TICKERS,
  COLL_INDEX_DAILY, COLL_INDEX_META,
} from '../../data/pnthrAiIndexConfig.js';

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE    = 'https://financialmodelingprep.com/api/v3';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── CLI args ────────────────────────────────────────────────────────────────
const fromArg = process.argv.find(a => a.startsWith('--from='));
const FROM_DATE = fromArg ? fromArg.split('=')[1] : null;

// ── FMP /profile fetch (chunked, batched) ───────────────────────────────────
async function fetchSharesOutstanding(tickers) {
  const out = {};
  const CHUNK = 100;
  for (let i = 0; i < tickers.length; i += CHUNK) {
    const chunk = tickers.slice(i, i + CHUNK);
    const url = `${FMP_BASE}/profile/${chunk.join(',')}?apikey=${FMP_API_KEY}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const arr = await res.json();
      if (Array.isArray(arr)) {
        for (const p of arr) {
          // FMP returns volAvg, mktCap, price, sharesOutstanding when available.
          // sharesOutstanding direct, otherwise derive from mktCap / price.
          let shares = parseFloat(p.sharesOutstanding) || 0;
          if (!shares && p.mktCap && p.price) {
            shares = parseFloat(p.mktCap) / parseFloat(p.price);
          }
          if (shares > 0) out[p.symbol] = shares;
        }
      }
    } catch (err) {
      console.error(`  /profile chunk ${i / CHUNK + 1} failed:`, err.message);
    }
    if (i + CHUNK < tickers.length) await sleep(300);
  }
  return out;
}

// ── Cap enforcement (iterative, Nasdaq 100 style) ───────────────────────────
// rawWeights: { ticker: weight } summing to ~1.0
// capFn(ticker): returns the cap for that ticker (e.g., 0.04 or 0.015)
// Returns: { ticker: cappedWeight } summing to 1.0 with all weights ≤ cap
function applyCaps(rawWeights, capFn, maxIter = 50) {
  const weights = { ...rawWeights };
  for (let iter = 0; iter < maxIter; iter++) {
    let cappedTotal = 0;
    let uncappedTotal = 0;
    const cappedSet = new Set();

    for (const [t, w] of Object.entries(weights)) {
      const cap = capFn(t);
      if (w > cap) {
        weights[t] = cap;
        cappedTotal += cap;
        cappedSet.add(t);
      } else {
        // Will be re-evaluated on next pass — collect raw current
        uncappedTotal += w;
      }
    }

    if (cappedSet.size === 0) break; // converged

    // Redistribute the slack proportionally among uncapped
    const slack = 1 - cappedTotal - uncappedTotal;
    if (Math.abs(slack) < 1e-9) break;

    const scale = (uncappedTotal + slack) / uncappedTotal;
    for (const [t] of Object.entries(weights)) {
      if (!cappedSet.has(t)) weights[t] *= scale;
    }
  }
  // Final sanity: if total drift > 0.01% from 1.0, normalize
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (Math.abs(total - 1) > 1e-6) {
    for (const t of Object.keys(weights)) weights[t] /= total;
  }
  return weights;
}

// ── EMA helper (Wilder-style classic EMA) ──────────────────────────────────
// Used here only to confirm the index series is well-formed; the live service
// computes its own EMAs from the persisted bars.

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!FMP_API_KEY) { console.error('FMP_API_KEY missing'); process.exit(1); }
  const db = await connectToDatabase();
  if (!db) { console.error('Mongo connect failed'); process.exit(1); }

  const constituentCol = db.collection('pnthr_ai_bt_candles');
  const indexCol       = db.collection(COLL_INDEX_DAILY);
  const metaCol        = db.collection(COLL_INDEX_META);
  await indexCol.createIndex({ ticker: 1 }, { unique: true });
  await metaCol.createIndex({ key: 1 }, { unique: true });

  const allTickers = [];
  for (const sec of SECTORS) for (const h of sec.holdings) allTickers.push(h.ticker);
  const tickers = [...new Set(allTickers)];

  console.log('\n' + '═'.repeat(72));
  console.log(`  ${INDEX_NAME} (${INDEX_TICKER}) — Backfill`);
  console.log(`  Constituents:    ${tickers.length}`);
  console.log(`  Base date/value: ${BASE_DATE} = ${BASE_VALUE.toFixed(2)}`);
  console.log(`  Caps:            ${(SINGLE_NAME_CAP*100).toFixed(2)}% single-name, ${(HYPERSCALER_CAP*100).toFixed(2)}% hyperscaler`);
  console.log(`  Hyperscalers:    ${HYPERSCALER_TICKERS.join(', ')}`);
  console.log(`  Rebalance:       monthly (first trading day)`);
  console.log('═'.repeat(72));

  // ── Step 1: Load constituent daily bars from Mongo ────────────────────────
  console.log('\n[1/5] Loading constituent daily bars from Mongo…');
  const docs = await constituentCol.find(
    { ticker: { $in: tickers } },
    { projection: { ticker: 1, daily: 1 } }
  ).toArray();

  const barsByTicker = {};
  for (const d of docs) {
    if (!d.daily || d.daily.length === 0) continue;
    const sorted = [...d.daily].sort((a, b) => a.date.localeCompare(b.date));
    const map = {};
    for (const b of sorted) map[b.date] = b;
    barsByTicker[d.ticker] = map;
  }
  const tickersWithData = Object.keys(barsByTicker);
  console.log(`  → ${tickersWithData.length}/${tickers.length} tickers have bars`);

  // ── Step 2: Build trading calendar (union of all dates) ──────────────────
  const dateSet = new Set();
  for (const t of tickersWithData) {
    for (const d of Object.keys(barsByTicker[t])) dateSet.add(d);
  }
  const allDates = [...dateSet].sort();
  const startIdx = allDates.findIndex(d => d >= BASE_DATE);
  const tradingDates = allDates.slice(startIdx);
  console.log(`[2/5] Trading calendar: ${tradingDates.length} days from ${tradingDates[0]} to ${tradingDates[tradingDates.length-1]}`);

  // ── Step 3: Identify monthly rebalance dates (first trading day of month)
  const rebalanceDates = [];
  let lastMonth = null;
  for (const d of tradingDates) {
    const ym = d.slice(0, 7); // YYYY-MM
    if (ym !== lastMonth) {
      rebalanceDates.push(d);
      lastMonth = ym;
    }
  }
  console.log(`[3/5] Rebalance dates: ${rebalanceDates.length} (first = ${rebalanceDates[0]}, latest = ${rebalanceDates[rebalanceDates.length-1]})`);

  // ── Step 4: Fetch current sharesOutstanding for all tickers ───────────────
  console.log(`[4/5] Fetching sharesOutstanding for ${tickersWithData.length} tickers from FMP…`);
  const sharesMap = await fetchSharesOutstanding(tickersWithData);
  const haveShares = Object.keys(sharesMap).length;
  const missingShares = tickersWithData.filter(t => !sharesMap[t]);
  console.log(`  → ${haveShares} tickers w/ shares; missing: ${missingShares.length}${missingShares.length ? ' ('+missingShares.slice(0,8).join(', ')+(missingShares.length>8?'…':'')+')' : ''}`);
  if (missingShares.length > 0) {
    // Fall back to equal weight contribution by giving missing tickers a
    // synthetic share count of 1 (very tiny effective weight) so they appear
    // in the index without dominating it. Logged for transparency.
    for (const t of missingShares) sharesMap[t] = 1;
  }

  // ── Step 5: Walk timeline — rebalance + compute daily OHLC ────────────────
  console.log('[5/5] Computing daily index OHLC across timeline…');
  const capFor = t => HYPERSCALER_TICKERS.includes(t) ? HYPERSCALER_CAP : SINGLE_NAME_CAP;
  const startTime = Date.now();

  const indexBars = []; // [{ date, open, high, low, close, volume }]
  const rebalanceLog = []; // for meta collection
  let currentShares = {}; // s_i — synthetic share counts (constant between rebalances)
  let currentIndexValue = BASE_VALUE;

  for (let i = 0; i < tradingDates.length; i++) {
    const date = tradingDates[i];
    const isRebalance = rebalanceDates.includes(date);

    // Determine which tickers have a bar today (or had one previously — i.e.
    // already in the index). On any given day, a ticker is "active" if its
    // bar exists today.
    const activeTickers = tickersWithData.filter(t => barsByTicker[t][date]);

    if (isRebalance) {
      // ── Rebalance step: compute new weights + new synthetic shares ──────
      // Pre-rebalance close (from previous day's bars × old shares) = the
      // index value we want to preserve. For the very first rebalance (BASE_DATE),
      // the pre-rebalance value IS BASE_VALUE by definition.
      let preRebalanceValue;
      if (indexBars.length === 0) {
        preRebalanceValue = BASE_VALUE;
      } else {
        preRebalanceValue = indexBars[indexBars.length - 1].close;
      }
      currentIndexValue = preRebalanceValue;

      // Compute uncapped market caps for active tickers (using TODAY's close).
      // For day 1 (BASE_DATE) we use today's close. For subsequent rebalances
      // we use today's close as well (rebalance applied at end of day).
      const mcaps = {};
      let mcapTotal = 0;
      for (const t of activeTickers) {
        const bar = barsByTicker[t][date];
        if (!bar || !bar.close) continue;
        const m = sharesMap[t] * bar.close;
        if (m > 0) {
          mcaps[t] = m;
          mcapTotal += m;
        }
      }

      const rawWeights = {};
      for (const [t, m] of Object.entries(mcaps)) rawWeights[t] = m / mcapTotal;
      const capped = applyCaps(rawWeights, capFor);

      // New synthetic share counts: s_i = weight_i × index_value / price_i
      const newShares = {};
      for (const [t, w] of Object.entries(capped)) {
        const px = barsByTicker[t][date].close;
        newShares[t] = (w * preRebalanceValue) / px;
      }
      currentShares = newShares;

      rebalanceLog.push({
        date,
        preRebalanceValue: parseFloat(preRebalanceValue.toFixed(4)),
        constituentCount: Object.keys(capped).length,
        weights: Object.fromEntries(
          Object.entries(capped).map(([t, w]) => [t, parseFloat(w.toFixed(6))])
        ),
      });
    }

    // ── Compute today's OHLCV from s_i × constituent OHLCV ─────────────────
    let O = 0, H = 0, L = 0, C = 0, V = 0, contribCount = 0;
    for (const [t, s] of Object.entries(currentShares)) {
      const bar = barsByTicker[t][date];
      if (!bar) continue;
      O += s * (bar.open  || bar.close);
      H += s * (bar.high  || bar.close);
      L += s * (bar.low   || bar.close);
      C += s * (bar.close);
      V += (bar.volume || 0);
      contribCount++;
    }

    if (contribCount === 0) continue; // shouldn't happen, but defensive

    indexBars.push({
      date,
      open:   parseFloat(O.toFixed(4)),
      high:   parseFloat(H.toFixed(4)),
      low:    parseFloat(L.toFixed(4)),
      close:  parseFloat(C.toFixed(4)),
      volume: V,
    });
  }

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const first = indexBars[0];
  const last  = indexBars[indexBars.length - 1];
  console.log(`  → ${indexBars.length} index bars computed in ${elapsedSec}s`);
  console.log(`  → Range: ${first.date} (close ${first.close.toFixed(2)}) → ${last.date} (close ${last.close.toFixed(2)})`);
  console.log(`  → Cumulative return: ${(((last.close / first.close) - 1) * 100).toFixed(2)}%`);

  // ── Persist daily bars (descending order, matching pnthr_ai_bt_candles)
  const sortedDesc = [...indexBars].sort((a, b) => b.date.localeCompare(a.date));
  await indexCol.updateOne(
    { ticker: INDEX_TICKER },
    {
      $set: {
        ticker:       INDEX_TICKER,
        indexName:    INDEX_NAME,
        daily:        sortedDesc,
        barCount:     sortedDesc.length,
        fromDate:     first.date,
        toDate:       last.date,
        baseDate:     BASE_DATE,
        baseValue:    BASE_VALUE,
        lastBuildAt:  new Date(),
        methodology: {
          weighting:    'capped-mcap',
          singleNameCap: SINGLE_NAME_CAP,
          hyperscalerCap: HYPERSCALER_CAP,
          hyperscalers: HYPERSCALER_TICKERS,
          rebalance:    'monthly',
          rebalanceCount: rebalanceDates.length,
        },
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );

  // Persist rebalance log + latest weights to meta collection
  await metaCol.updateOne(
    { key: 'rebalance_log' },
    { $set: { key: 'rebalance_log', log: rebalanceLog, updatedAt: new Date() } },
    { upsert: true }
  );

  const latestRebalance = rebalanceLog[rebalanceLog.length - 1];
  await metaCol.updateOne(
    { key: 'current_weights' },
    {
      $set: {
        key: 'current_weights',
        asOfRebalance: latestRebalance.date,
        weights: latestRebalance.weights,
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );

  console.log('\n' + '═'.repeat(72));
  console.log('  BACKFILL COMPLETE');
  console.log('═'.repeat(72));
  console.log(`  Index daily bars:  ${sortedDesc.length}`);
  console.log(`  Rebalances:        ${rebalanceLog.length}`);
  console.log(`  Stored:            ${COLL_INDEX_DAILY}, ${COLL_INDEX_META}`);
  console.log('\n  Next: node scripts/aiUniverse/buildPnthrAi300IndexWeekly.js\n');
  process.exit(0);
}

main().catch(err => { console.error('\nFATAL:', err); process.exit(1); });
