import dotenv from 'dotenv';
dotenv.config();
import { getAllTickers } from './constituents.js';
import { normalizeSector } from './sectorUtils.js';
import { connectToDatabase } from './database.js';

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE = 'https://financialmodelingprep.com/api/v3';
const TIMEOUT_MS = 12000;

let cache = null;
let cacheTime = 0;
const CACHE_MS = 60 * 1000;

let fcfCache = null;
let fcfCacheTime = 0;
const FCF_CACHE_MS = 6 * 60 * 60 * 1000;

let valCache = null;
let valCacheTime = 0;
const VAL_CACHE_MS = 6 * 60 * 60 * 1000;

const SECTOR_COLLECTION = 'pnthr_ticker_sector_cache';
const SECTOR_STALE_AFTER = 30 * 24 * 60 * 60 * 1000;

export function clearJungleHeatCache() {
  cache = null; cacheTime = 0;
  fcfCache = null; fcfCacheTime = 0;
  valCache = null; valCacheTime = 0;
}

const get = (url) =>
  fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    .then(r => r.ok ? r.json() : [])
    .catch(() => []);

async function fetchBulkQuotes(tickers) {
  const results = {};
  const BATCH = 200;
  for (let i = 0; i < tickers.length; i += BATCH) {
    const chunk = tickers.slice(i, i + BATCH);
    try {
      const data = await get(`${FMP_BASE}/quote/${chunk.join(',')}?apikey=${FMP_API_KEY}`);
      if (Array.isArray(data)) {
        for (const q of data) if (q?.symbol) results[q.symbol] = q;
      }
    } catch {}
    if (i + BATCH < tickers.length) await new Promise(r => setTimeout(r, 300));
  }
  return results;
}

async function buildSectorMap(tickers) {
  const map = {};
  const nowMs = Date.now();
  let db;
  try { db = await connectToDatabase(); } catch {}

  if (db) {
    try {
      const cached = await db.collection(SECTOR_COLLECTION)
        .find({ ticker: { $in: tickers } }).toArray();
      for (const d of cached) {
        const age = d.cachedAt ? nowMs - new Date(d.cachedAt).getTime() : Infinity;
        if (d.ticker && d.sector && age < SECTOR_STALE_AFTER) {
          map[d.ticker.toUpperCase()] = d.sector;
        }
      }
    } catch {}
  }

  const missing = tickers.filter(t => !map[t]);
  if (missing.length > 0) {
    const CHUNK = 100;
    const upserts = [];
    for (let i = 0; i < missing.length; i += CHUNK) {
      const chunk = missing.slice(i, i + CHUNK);
      try {
        const data = await get(`${FMP_BASE}/profile/${chunk.join(',')}?apikey=${FMP_API_KEY}`);
        if (Array.isArray(data)) {
          for (const p of data) {
            if (p?.symbol && p?.sector) {
              const sec = normalizeSector(p.sector);
              map[p.symbol.toUpperCase()] = sec;
              upserts.push({
                updateOne: {
                  filter: { ticker: p.symbol.toUpperCase() },
                  update: { $set: { ticker: p.symbol.toUpperCase(), sector: sec, cachedAt: new Date() } },
                  upsert: true,
                },
              });
            }
          }
        }
      } catch {}
      if (i + CHUNK < missing.length) await new Promise(r => setTimeout(r, 300));
    }
    if (db && upserts.length > 0) {
      try { await db.collection(SECTOR_COLLECTION).bulkWrite(upserts); } catch {}
    }
  }
  return map;
}

export async function getJungleHeatData(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cache && (now - cacheTime) < CACHE_MS) return cache;

  if (!FMP_API_KEY) throw new Error('FMP_API_KEY not set');

  const tickers = await getAllTickers();
  console.log(`[JungleHeat] fetching quotes for ${tickers.length} tickers`);

  const [quoteMap, sectorMap] = await Promise.all([
    fetchBulkQuotes(tickers),
    buildSectorMap(tickers),
  ]);

  const sectorGroups = {};
  for (const t of tickers) {
    const q = quoteMap[t];
    if (!q) continue;
    const sec = sectorMap[t] || 'Unknown';
    if (!sectorGroups[sec]) sectorGroups[sec] = { name: sec, holdings: [] };
    sectorGroups[sec].holdings.push({
      ticker: q.symbol,
      name: q.name || q.symbol,
      price: q.price,
      change: q.change,
      changePct: q.changesPercentage,
    });
  }

  const sectors = Object.values(sectorGroups)
    .filter(s => s.name !== 'Unknown')
    .map((s, i) => {
      s.holdings.sort((a, b) => (b.changePct || 0) - (a.changePct || 0));
      const withData = s.holdings.filter(h => h.changePct != null);
      const avgChange = withData.length
        ? +(withData.reduce((sum, h) => sum + h.changePct, 0) / withData.length).toFixed(2)
        : null;
      return { id: i + 1, name: s.name, avgChange, holdings: s.holdings };
    });

  const allWithData = tickers.filter(t => quoteMap[t]?.changesPercentage != null);
  const advancers = allWithData.filter(t => quoteMap[t].changesPercentage > 0).length;
  const decliners = allWithData.filter(t => quoteMap[t].changesPercentage < 0).length;
  const unchanged = allWithData.length - advancers - decliners;

  const result = {
    sectors,
    breadth: { advancers, decliners, unchanged, total: allWithData.length },
    updatedAt: new Date().toISOString(),
  };

  cache = result;
  cacheTime = now;
  console.log(`[JungleHeat] ✅ ${sectors.length} sectors, ${tickers.length} tickers`);
  return result;
}

export async function getJungleFcfData() {
  const now = Date.now();
  if (fcfCache && (now - fcfCacheTime) < FCF_CACHE_MS) return fcfCache;
  if (!FMP_API_KEY) throw new Error('FMP_API_KEY not set');

  const tickers = await getAllTickers();
  const results = {};
  const CONCURRENCY = 10;
  for (let i = 0; i < tickers.length; i += CONCURRENCY) {
    const batch = tickers.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (ticker) => {
      const data = await get(`${FMP_BASE}/cash-flow-statement/${ticker}?period=annual&limit=1&apikey=${FMP_API_KEY}`);
      if (Array.isArray(data) && data.length > 0) {
        results[ticker] = data[0].freeCashFlow ?? null;
      }
    }));
  }

  fcfCache = results;
  fcfCacheTime = now;
  return results;
}

export async function getJungleValuationData() {
  const now = Date.now();
  if (valCache && (now - valCacheTime) < VAL_CACHE_MS) return valCache;
  if (!FMP_API_KEY) throw new Error('FMP_API_KEY not set');

  const tickers = await getAllTickers();
  const results = {};
  const CONCURRENCY = 10;
  for (let i = 0; i < tickers.length; i += CONCURRENCY) {
    const batch = tickers.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (ticker) => {
      const data = await get(`${FMP_BASE}/ratios-ttm/${ticker}?apikey=${FMP_API_KEY}`);
      if (Array.isArray(data) && data.length > 0) {
        const r = data[0];
        results[ticker] = {
          forwardPE: r.peRatioTTM ?? null,
          peg: r.pegRatioTTM ?? null,
        };
      }
    }));
  }

  valCache = results;
  valCacheTime = now;
  return results;
}
