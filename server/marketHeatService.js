// server/marketHeatService.js
// ── Daily heat for the AI Elite 300, plus the Treasury yield backdrop ────────
//
// NAMING NOTE: this was called bondHeatService.js, which read as "a service
// about bonds". It is not. The stock data here is the AI-300 universe
// (getAiUniverseHoldings / getAiUniverseSectorMeta); the Treasury yields are
// context layered alongside it. Two pages read from this one service:
//   AiHeatPage   → "AI 300 Heat Map"   (the sector heat blocks, + FCF/valuation)
//   BondHeatPage → "PNTHR Bond Yields" (the treasury curve + history)
// The old /api/bond-heat* routes still work as aliases so nothing breaks across
// a deploy; /api/market-heat* is the name to use going forward.
//
// Fetches daily % change for all AI Universe stocks + 10Y/30Y Treasury yields.
// Also provides historical treasury + SPY data with yield shock detection.

import { getAiUniverseHoldings, getAiUniverseSectorMeta } from './aiUniverseService.js';
import { getPnthrAi300Bars } from './pnthrAi300Service.js';

const FMP_BASE  = 'https://financialmodelingprep.com/api/v3';
const FMP_BASE4 = 'https://financialmodelingprep.com/api/v4';
const TIMEOUT_MS = 8000;

let cache = null;
let cacheTime = 0;
const CACHE_MS = 60 * 1000;

let histCache = null;
let histCacheTime = 0;
const HIST_CACHE_MS = 10 * 60 * 1000;

let fcfCache = null;
let fcfCacheTime = 0;
const FCF_CACHE_MS = 6 * 60 * 60 * 1000; // 6 hours — FCF only changes quarterly

let valCache = null;
let valCacheTime = 0;
const VAL_CACHE_MS = 6 * 60 * 60 * 1000;

export function clearMarketHeatCache() { cache = null; cacheTime = 0; histCache = null; histCacheTime = 0; fcfCache = null; fcfCacheTime = 0; valCache = null; valCacheTime = 0; }

export async function getFcfData() {
  const now = Date.now();
  if (fcfCache && (now - fcfCacheTime) < FCF_CACHE_MS) return fcfCache;

  const key = process.env.FMP_API_KEY;
  if (!key) throw new Error('FMP_API_KEY not set');

  const holdings = getAiUniverseHoldings();
  const tickers = holdings.map(h => h.ticker);

  const get = (url) =>
    fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      .then(r => r.ok ? r.json() : [])
      .catch(() => []);

  const results = {};
  const CONCURRENCY = 10;
  for (let i = 0; i < tickers.length; i += CONCURRENCY) {
    const batch = tickers.slice(i, i + CONCURRENCY);
    const fetches = batch.map(async (ticker) => {
      const data = await get(`${FMP_BASE}/cash-flow-statement/${ticker}?period=annual&limit=1&apikey=${key}`);
      if (Array.isArray(data) && data.length > 0) {
        results[ticker] = data[0].freeCashFlow ?? null;
      }
    });
    await Promise.all(fetches);
  }

  fcfCache = results;
  fcfCacheTime = now;
  return results;
}

export async function getValuationData() {
  const now = Date.now();
  if (valCache && (now - valCacheTime) < VAL_CACHE_MS) return valCache;

  const key = process.env.FMP_API_KEY;
  if (!key) throw new Error('FMP_API_KEY not set');

  const holdings = getAiUniverseHoldings();
  const tickers = holdings.map(h => h.ticker);

  const get = (url) =>
    fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      .then(r => r.ok ? r.json() : [])
      .catch(() => []);

  const results = {};
  const CONCURRENCY = 10;
  for (let i = 0; i < tickers.length; i += CONCURRENCY) {
    const batch = tickers.slice(i, i + CONCURRENCY);
    const fetches = batch.map(async (ticker) => {
      const data = await get(`${FMP_BASE}/ratios-ttm/${ticker}?apikey=${key}`);
      if (Array.isArray(data) && data.length > 0) {
        const r = data[0];
        results[ticker] = {
          forwardPE: r.peRatioTTM ?? null,
          peg: r.pegRatioTTM ?? null,
        };
      }
    });
    await Promise.all(fetches);
  }

  valCache = results;
  valCacheTime = now;
  return results;
}

export async function getMarketHeatData() {
  const now = Date.now();
  if (cache && (now - cacheTime) < CACHE_MS) return cache;

  const key = process.env.FMP_API_KEY;
  if (!key) throw new Error('FMP_API_KEY not set');

  const holdings = getAiUniverseHoldings();
  const sectorMeta = getAiUniverseSectorMeta();
  const tickers = holdings.map(h => h.ticker).join(',');

  const today = new Date();
  const from = new Date(today); from.setDate(from.getDate() - 5);
  const toStr = today.toISOString().split('T')[0];
  const fromStr = from.toISOString().split('T')[0];

  const get = (url) =>
    fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      .then(r => r.ok ? r.json() : [])
      .catch(() => []);

  const [quotes, treasuryData] = await Promise.all([
    get(`${FMP_BASE}/quote/${tickers}?apikey=${key}`),
    get(`${FMP_BASE4}/treasury?from=${fromStr}&to=${toStr}&apikey=${key}`),
  ]);

  const quoteMap = {};
  for (const q of (Array.isArray(quotes) ? quotes : [])) {
    quoteMap[q.symbol] = {
      price: q.price,
      change: q.change,
      changePct: q.changesPercentage,
    };
  }

  const sectors = sectorMeta.map(s => {
    const sectorHoldings = holdings
      .filter(h => h.sectorId === s.id)
      .map(h => ({
        ticker: h.ticker,
        name: h.companyName,
        ...(quoteMap[h.ticker] || { price: null, change: null, changePct: null }),
      }))
      .sort((a, b) => (b.changePct || 0) - (a.changePct || 0));

    const withData = sectorHoldings.filter(h => h.changePct != null);
    const avgChange = withData.length
      ? +(withData.reduce((sum, h) => sum + h.changePct, 0) / withData.length).toFixed(2)
      : null;

    return {
      id: s.id,
      name: s.name,
      weight: s.weight,
      avgChange,
      holdings: sectorHoldings,
    };
  });

  const sortedTreasury = (Array.isArray(treasuryData) ? treasuryData : [])
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));

  const tRow = sortedTreasury.length ? sortedTreasury[sortedTreasury.length - 1] : null;

  const bonds = tRow ? {
    date: tRow.date,
    fedFunds: tRow.month1 != null ? +Number(tRow.month1).toFixed(3) : null,
    y2: tRow.year2 != null ? +Number(tRow.year2).toFixed(3) : null,
    y10: tRow.year10 != null ? +Number(tRow.year10).toFixed(3) : null,
    y30: tRow.year30 != null ? +Number(tRow.year30).toFixed(3) : null,
  } : { date: null, fedFunds: null, y2: null, y10: null, y30: null };

  const prevRow = sortedTreasury.length > 1
    ? sortedTreasury[sortedTreasury.length - 2]
    : null;
  if (prevRow) {
    bonds.y10Prev = prevRow.year10 != null ? +Number(prevRow.year10).toFixed(3) : null;
    bonds.y30Prev = prevRow.year30 != null ? +Number(prevRow.year30).toFixed(3) : null;
    bonds.y2Prev = prevRow.year2 != null ? +Number(prevRow.year2).toFixed(3) : null;
    bonds.y10Change = bonds.y10 != null && bonds.y10Prev != null
      ? +(bonds.y10 - bonds.y10Prev).toFixed(3) : null;
    bonds.y30Change = bonds.y30 != null && bonds.y30Prev != null
      ? +(bonds.y30 - bonds.y30Prev).toFixed(3) : null;
    bonds.y2Change = bonds.y2 != null && bonds.y2Prev != null
      ? +(bonds.y2 - bonds.y2Prev).toFixed(3) : null;
  }

  const allWithData = holdings.filter(h => quoteMap[h.ticker]?.changePct != null);
  const advancers = allWithData.filter(h => quoteMap[h.ticker].changePct > 0).length;
  const decliners = allWithData.filter(h => quoteMap[h.ticker].changePct < 0).length;
  const unchanged = allWithData.length - advancers - decliners;

  const result = {
    bonds,
    sectors,
    breadth: { advancers, decliners, unchanged, total: allWithData.length },
    updatedAt: new Date().toISOString(),
  };

  cache = result;
  cacheTime = now;
  return result;
}

export async function getTreasuryHistory() {
  const now = Date.now();
  if (histCache && (now - histCacheTime) < HIST_CACHE_MS) return histCache;

  const key = process.env.FMP_API_KEY;
  if (!key) throw new Error('FMP_API_KEY not set');

  const toStr = new Date().toISOString().split('T')[0];
  const fromStr = '2025-05-01';

  const get = (url) =>
    fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      .then(r => r.ok ? r.json() : [])
      .catch(() => []);

  let pai300Bars = [];
  try {
    const pai300Result = await getPnthrAi300Bars({ timeframe: 'daily' });
    if (pai300Result?.ok) pai300Bars = pai300Result.bars || [];
  } catch (e) {
    console.warn('[bondHeat] PAI300 bars fetch failed:', e.message);
  }

  const [treasuryRaw, spyRaw] = await Promise.all([
    get(`${FMP_BASE4}/treasury?from=${fromStr}&to=${toStr}&apikey=${key}`),
    get(`${FMP_BASE}/historical-price-full/SPY?from=${fromStr}&to=${toStr}&apikey=${key}`),
  ]);

  const treasuryData = Array.isArray(treasuryRaw) ? treasuryRaw : [];
  const spyPrices = spyRaw?.historical || [];

  // Build SPY lookup by date
  const spyMap = {};
  for (const bar of spyPrices) {
    spyMap[bar.date] = { price: bar.close, changePct: bar.changePercent };
  }

  // Build PAI300 lookup by date
  const pai300Map = {};
  for (const bar of pai300Bars) {
    if (bar.date >= fromStr) {
      pai300Map[bar.date] = { value: bar.close };
    }
  }

  // Sort treasury ascending by date
  treasuryData.sort((a, b) => a.date.localeCompare(b.date));

  const rows = treasuryData.map((d, i) => {
    const y2 = d.year2 != null ? +Number(d.year2).toFixed(3) : null;
    const y10 = d.year10 != null ? +Number(d.year10).toFixed(3) : null;
    const y30 = d.year30 != null ? +Number(d.year30).toFixed(3) : null;

    // Yield shock: 10Y rose 20+ bps in past 10 trading days
    let yieldShock = false;
    if (y10 != null && i >= 10) {
      const prev10Y = treasuryData[i - 10]?.year10;
      if (prev10Y != null) {
        const delta = y10 - prev10Y;
        if (delta >= 0.20) yieldShock = true;
      }
    }

    return {
      date: d.date,
      fedFunds: d.month1 != null ? +Number(d.month1).toFixed(3) : null,
      y2,
      y10,
      y30,
      spread2_10: y10 != null && y2 != null ? +((y10 - y2).toFixed(3)) : null,
      spread10_30: y30 != null && y10 != null ? +((y30 - y10).toFixed(3)) : null,
      spy: spyMap[d.date]?.price ?? null,
      spyChangePct: spyMap[d.date]?.changePct ?? null,
      pai300: pai300Map[d.date]?.value ?? null,
      yieldShock,
    };
  });

  histCache = rows;
  histCacheTime = now;
  return rows;
}
