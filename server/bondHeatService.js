// server/bondHeatService.js
// Fetches daily % change for all AI Universe stocks + 10Y/30Y Treasury yields.

import { getAiUniverseHoldings, getAiUniverseSectorMeta } from './aiUniverseService.js';

const FMP_BASE  = 'https://financialmodelingprep.com/api/v3';
const FMP_BASE4 = 'https://financialmodelingprep.com/api/v4';
const TIMEOUT_MS = 8000;

let cache = null;
let cacheTime = 0;
const CACHE_MS = 60 * 1000;

export function clearBondHeatCache() { cache = null; cacheTime = 0; }

export async function getBondHeatData() {
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

  const tRow = Array.isArray(treasuryData) && treasuryData.length
    ? treasuryData[treasuryData.length - 1]
    : null;

  const bonds = tRow ? {
    date: tRow.date,
    y10: tRow.year10 != null ? +Number(tRow.year10).toFixed(3) : null,
    y30: tRow.year30 != null ? +Number(tRow.year30).toFixed(3) : null,
    y2: tRow.year2 != null ? +Number(tRow.year2).toFixed(3) : null,
  } : { date: null, y10: null, y30: null, y2: null };

  // Get previous day for yield change
  const prevRow = Array.isArray(treasuryData) && treasuryData.length > 1
    ? treasuryData[treasuryData.length - 2]
    : null;
  if (prevRow) {
    bonds.y10Prev = prevRow.year10 != null ? +Number(prevRow.year10).toFixed(3) : null;
    bonds.y30Prev = prevRow.year30 != null ? +Number(prevRow.year30).toFixed(3) : null;
    bonds.y10Change = bonds.y10 != null && bonds.y10Prev != null
      ? +(bonds.y10 - bonds.y10Prev).toFixed(3) : null;
    bonds.y30Change = bonds.y30 != null && bonds.y30Prev != null
      ? +(bonds.y30 - bonds.y30Prev).toFixed(3) : null;
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
