// server/scripts/aiUniverse/buildPnthrAiSectorIndices.js
// ── PNTHR AI Sectors — Backfill 16 synthetic sector indices ────────────────
//
// One pass: for each of the 16 sectors in the AI Universe taxonomy, build a
// capped market-cap weighted index restricted to that sector's constituents.
// Same math as buildPnthrAi300Index.js but per-sector. Outputs:
//
//   • pnthr_ai_sector_candles  — one document per sector (ticker = PAI_S{id}),
//                                 daily OHLCV bars
//   • pnthr_ai_sector_meta     — { key: 'rebalance_log:S{id}', log: [...] }
//                                 + { key: 'current_weights:S{id}', weights: {...} }
//
// Idempotent. Re-runnable safely. Each sector built independently so a cap
// breach in one sector doesn't pollute another.
//
// Usage:  cd server && node scripts/aiUniverse/buildPnthrAiSectorIndices.js
// ────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../../.env', import.meta.url).pathname });

import { connectToDatabase } from '../../database.js';
import { SECTORS } from './aiUniverseData.js';
import {
  SECTOR_BASE_DATE, SECTOR_BASE_VALUE,
  SECTOR_SINGLE_NAME_CAP, SECTOR_HYPERSCALER_CAP, SECTOR_HYPERSCALER_TICKERS,
  COLL_SECTOR_DAILY, COLL_SECTOR_META,
  sectorTicker,
} from '../../data/pnthrAiSectorsConfig.js';

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE    = 'https://financialmodelingprep.com/api/v3';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── FMP /profile fetch (chunked) — same as PAI300 backfill ──────────────────
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

// ── Cap enforcement (iterative) — identical to PAI300 ───────────────────────
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
        uncappedTotal += w;
      }
    }
    if (cappedSet.size === 0) break;

    const slack = 1 - cappedTotal - uncappedTotal;
    if (Math.abs(slack) < 1e-9) break;
    const scale = (uncappedTotal + slack) / uncappedTotal;
    for (const [t] of Object.entries(weights)) {
      if (!cappedSet.has(t)) weights[t] *= scale;
    }
  }
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (Math.abs(total - 1) > 1e-6) {
    for (const t of Object.keys(weights)) weights[t] /= total;
  }
  return weights;
}

// ── Build one sector's index ────────────────────────────────────────────────
function buildSectorIndex(sectorDef, barsByTicker, sharesMap, tradingDates, rebalanceDates) {
  const sectorTickers = sectorDef.holdings.map(h => h.ticker);
  const capFor = t => SECTOR_HYPERSCALER_TICKERS.includes(t)
    ? SECTOR_HYPERSCALER_CAP
    : SECTOR_SINGLE_NAME_CAP;

  const indexBars     = [];
  const rebalanceLog  = [];
  let currentShares   = {};
  let currentValue    = SECTOR_BASE_VALUE;

  for (let i = 0; i < tradingDates.length; i++) {
    const date = tradingDates[i];
    const isRebalance = rebalanceDates.has(date);

    // Active tickers in this sector that have a bar today
    const activeTickers = sectorTickers.filter(t => barsByTicker[t]?.[date]);

    if (isRebalance) {
      const preRebalanceValue = indexBars.length === 0
        ? SECTOR_BASE_VALUE
        : indexBars[indexBars.length - 1].close;
      currentValue = preRebalanceValue;

      const mcaps = {};
      let mcapTotal = 0;
      for (const t of activeTickers) {
        const bar = barsByTicker[t][date];
        if (!bar?.close) continue;
        const m = (sharesMap[t] || 0) * bar.close;
        if (m > 0) { mcaps[t] = m; mcapTotal += m; }
      }
      if (mcapTotal === 0) continue; // no data — skip rebalance, keep prior shares

      const rawWeights = {};
      for (const [t, m] of Object.entries(mcaps)) rawWeights[t] = m / mcapTotal;
      const capped = applyCaps(rawWeights, capFor);

      const newShares = {};
      for (const [t, w] of Object.entries(capped)) {
        const px = barsByTicker[t][date].close;
        newShares[t] = (w * preRebalanceValue) / px;
      }
      currentShares = newShares;

      rebalanceLog.push({
        date,
        preRebalanceValue: parseFloat(preRebalanceValue.toFixed(4)),
        constituentCount:  Object.keys(capped).length,
        weights: Object.fromEntries(
          Object.entries(capped).map(([t, w]) => [t, parseFloat(w.toFixed(6))])
        ),
      });
    }

    // Compute today's OHLCV
    let O = 0, H = 0, L = 0, C = 0, V = 0, contrib = 0;
    for (const [t, s] of Object.entries(currentShares)) {
      const bar = barsByTicker[t]?.[date];
      if (!bar) continue;
      O += s * (bar.open  || bar.close);
      H += s * (bar.high  || bar.close);
      L += s * (bar.low   || bar.close);
      C += s * bar.close;
      V += (bar.volume || 0);
      contrib++;
    }
    if (contrib === 0) continue;

    indexBars.push({
      date,
      open:   parseFloat(O.toFixed(4)),
      high:   parseFloat(H.toFixed(4)),
      low:    parseFloat(L.toFixed(4)),
      close:  parseFloat(C.toFixed(4)),
      volume: V,
    });
  }

  return { indexBars, rebalanceLog };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!FMP_API_KEY) { console.error('FMP_API_KEY missing'); process.exit(1); }
  const db = await connectToDatabase();
  if (!db) { console.error('Mongo connect failed'); process.exit(1); }

  const constituentCol = db.collection('pnthr_ai_bt_candles');
  const indexCol       = db.collection(COLL_SECTOR_DAILY);
  const metaCol        = db.collection(COLL_SECTOR_META);
  await indexCol.createIndex({ ticker: 1 }, { unique: true });
  await metaCol.createIndex({ key: 1 }, { unique: true });

  const allTickers = [];
  for (const sec of SECTORS) for (const h of sec.holdings) allTickers.push(h.ticker);
  const tickers = [...new Set(allTickers)];

  console.log('\n' + '═'.repeat(72));
  console.log('  PNTHR AI Sectors — Backfill (16 synthetic sector indices)');
  console.log(`  Universe:      ${tickers.length} constituents`);
  console.log(`  Base:          ${SECTOR_BASE_DATE} = ${SECTOR_BASE_VALUE.toFixed(2)}`);
  console.log(`  Caps:          ${(SECTOR_SINGLE_NAME_CAP*100).toFixed(2)}% / ${(SECTOR_HYPERSCALER_CAP*100).toFixed(2)}% hyperscaler`);
  console.log('═'.repeat(72));

  // 1) Load constituent daily bars
  console.log('\n[1/5] Loading constituent daily bars…');
  const docs = await constituentCol.find(
    { ticker: { $in: tickers } },
    { projection: { ticker: 1, daily: 1 } }
  ).toArray();
  const barsByTicker = {};
  for (const d of docs) {
    if (!d.daily?.length) continue;
    const map = {};
    for (const b of d.daily) map[b.date] = b;
    barsByTicker[d.ticker] = map;
  }
  const haveBars = Object.keys(barsByTicker).length;
  console.log(`  → ${haveBars}/${tickers.length} tickers have bars`);

  // 2) Trading calendar
  const dateSet = new Set();
  for (const t of Object.keys(barsByTicker)) {
    for (const d of Object.keys(barsByTicker[t])) dateSet.add(d);
  }
  const allDates = [...dateSet].sort();
  const startIdx = allDates.findIndex(d => d >= SECTOR_BASE_DATE);
  const tradingDates = allDates.slice(startIdx);
  console.log(`[2/5] Trading calendar: ${tradingDates.length} days (${tradingDates[0]} → ${tradingDates[tradingDates.length-1]})`);

  // 3) Monthly rebalance dates (first trading day of each calendar month)
  const rebalanceSet = new Set();
  let lastMonth = null;
  for (const d of tradingDates) {
    const ym = d.slice(0, 7);
    if (ym !== lastMonth) { rebalanceSet.add(d); lastMonth = ym; }
  }
  console.log(`[3/5] Rebalance dates: ${rebalanceSet.size}`);

  // 4) sharesOutstanding from FMP
  console.log(`[4/5] Fetching sharesOutstanding from FMP…`);
  const sharesMap = await fetchSharesOutstanding(Object.keys(barsByTicker));
  const haveShares = Object.keys(sharesMap).length;
  console.log(`  → ${haveShares} tickers w/ shares (missing fall back to synthetic 1)`);
  for (const t of Object.keys(barsByTicker)) {
    if (!sharesMap[t]) sharesMap[t] = 1;
  }

  // 5) Build each sector index + persist
  console.log('[5/5] Building 16 sector indices…');
  const startTime = Date.now();
  const summary = [];
  for (const sec of SECTORS) {
    const { indexBars, rebalanceLog } = buildSectorIndex(
      sec, barsByTicker, sharesMap, tradingDates, rebalanceSet
    );
    if (indexBars.length === 0) {
      console.log(`  ⚠  S${sec.id} ${sec.name}: 0 bars — skipping`);
      continue;
    }
    const sortedDesc = [...indexBars].sort((a, b) => b.date.localeCompare(a.date));
    const first = indexBars[0];
    const last  = indexBars[indexBars.length - 1];
    const cumPct = ((last.close / first.close) - 1) * 100;

    const ticker = sectorTicker(sec.id);
    await indexCol.updateOne(
      { ticker },
      {
        $set: {
          ticker,
          sectorId:    sec.id,
          sectorName:  sec.name,
          targetWeight: sec.weight,
          holdingCount: sec.holdings.length,
          daily:       sortedDesc,
          barCount:    sortedDesc.length,
          fromDate:    first.date,
          toDate:      last.date,
          baseDate:    SECTOR_BASE_DATE,
          baseValue:   SECTOR_BASE_VALUE,
          lastBuildAt: new Date(),
          methodology: {
            weighting:      'capped-mcap',
            singleNameCap:  SECTOR_SINGLE_NAME_CAP,
            hyperscalerCap: SECTOR_HYPERSCALER_CAP,
            rebalance:      'monthly',
            rebalanceCount: rebalanceLog.length,
          },
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );

    await metaCol.updateOne(
      { key: `rebalance_log:S${sec.id}` },
      { $set: { key: `rebalance_log:S${sec.id}`, sectorId: sec.id, log: rebalanceLog, updatedAt: new Date() } },
      { upsert: true }
    );
    const latest = rebalanceLog[rebalanceLog.length - 1];
    if (latest) {
      await metaCol.updateOne(
        { key: `current_weights:S${sec.id}` },
        {
          $set: {
            key: `current_weights:S${sec.id}`,
            sectorId: sec.id,
            asOfRebalance: latest.date,
            weights: latest.weights,
            updatedAt: new Date(),
          },
        },
        { upsert: true }
      );
    }

    summary.push({
      id: sec.id, name: sec.name, ticker,
      bars: sortedDesc.length, rebalances: rebalanceLog.length,
      open: first.close, close: last.close, cumPct,
    });
  }

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n' + '═'.repeat(72));
  console.log('  BACKFILL COMPLETE');
  console.log('═'.repeat(72));
  console.log(`  Runtime:  ${elapsedSec}s`);
  console.log(`  Sectors:  ${summary.length}/16`);
  console.log('  Performance since 2022-11-30 (sorted desc):');
  summary.sort((a, b) => b.cumPct - a.cumPct);
  for (const s of summary) {
    const sign = s.cumPct >= 0 ? '+' : '';
    console.log(`    ${s.ticker.padEnd(8)} ${s.name.padEnd(48)} ${sign}${s.cumPct.toFixed(2).padStart(8)}%  (${s.bars} bars)`);
  }
  console.log('\n  Next: node scripts/aiUniverse/buildPnthrAiSectorIndicesWeekly.js\n');
  process.exit(0);
}

main().catch(err => { console.error('\nFATAL:', err); process.exit(1); });
