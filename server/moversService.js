// PNTHR Movers — top intraday gainers/decliners across the PNTHR 679 + PNTHR ETF universe.
// 5-minute server cache; one bulk FMP /quote call per universe.
import dotenv from 'dotenv';
dotenv.config();
import { getAllTickers } from './constituents.js';
import { freshSignalsFor } from './signalService.js';

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';
const CACHE_TTL_MS = 5 * 60 * 1000;
const STOCK_TOP_N = 12;
const ETF_TOP_N = 5;

let moversCache = { data: null, timestamp: 0 };

async function fetchJson(endpoint) {
  const url = `${FMP_BASE_URL}${endpoint}${endpoint.includes('?') ? '&' : '?'}apikey=${FMP_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP ${res.status} ${endpoint}`);
  return res.json();
}

async function fetchBulkQuotes(tickers) {
  const results = {};
  const BATCH = 200;
  for (let i = 0; i < tickers.length; i += BATCH) {
    const chunk = tickers.slice(i, i + BATCH);
    try {
      const data = await fetchJson(`/quote/${chunk.join(',')}`);
      if (Array.isArray(data)) {
        for (const q of data) if (q?.symbol) results[q.symbol] = q;
      }
    } catch (err) {
      console.error('[Movers] quote batch error:', err.message);
    }
    if (i + BATCH < tickers.length) await new Promise(r => setTimeout(r, 300));
  }
  return results;
}

// Monday of the current ISO week (matches signalService weekKey logic)
function currentWeekMonday() {
  const d = new Date();
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function signalLabel(signalMap, ticker) {
  const s = signalMap?.[ticker];
  if (!s || !s.signal) return null;
  if (s.signal !== 'BL' && s.signal !== 'SS') return null;
  let weeks = 1;
  if (s.signalDate) {
    const sigMs = new Date(s.signalDate + 'T12:00:00').getTime();
    const curMs = new Date(currentWeekMonday() + 'T12:00:00').getTime();
    const ageWeeks = Math.max(0, Math.round((curMs - sigMs) / (7 * 24 * 60 * 60 * 1000)));
    weeks = ageWeeks + 1; // BL+1 = fired this week
  }
  return `${s.signal}+${weeks}`;
}

function buildMovers(quoteMap, tickers, topN, signalMap) {
  const rows = [];
  for (const t of tickers) {
    const q = quoteMap[t];
    if (!q) continue;
    const price = Number(q.price);
    const pct = Number(q.changesPercentage);
    if (!isFinite(price) || !isFinite(pct)) continue;
    rows.push({
      ticker: q.symbol,
      name: q.name || q.symbol,
      price: parseFloat(price.toFixed(2)),
      changePct: parseFloat(pct.toFixed(3)),
      signalLabel: signalLabel(signalMap, q.symbol),
    });
  }
  const sorted = [...rows].sort((a, b) => b.changePct - a.changePct);
  const gainers = sorted.slice(0, topN).filter(r => r.changePct > 0);
  const decliners = [...sorted].reverse().slice(0, topN).filter(r => r.changePct < 0);
  return { gainers, decliners };
}

export async function getMovers(forceRefresh = false) {
  if (!forceRefresh && moversCache.data && Date.now() - moversCache.timestamp < CACHE_TTL_MS) {
    return moversCache.data;
  }

  const { ALL_ETF_TICKER_SET } = await import('./etfService.js');
  const etfTickers = Array.from(ALL_ETF_TICKER_SET);
  const stockTickersRaw = await getAllTickers();
  // Defensive: ensure no ETFs leak into the stock universe.
  const stockTickers = stockTickersRaw.filter(t => !ALL_ETF_TICKER_SET.has(t));

  console.log(`[Movers] fetching quotes — ${stockTickers.length} stocks + ${etfTickers.length} ETFs`);
  const [stockQuotes, etfQuotes] = await Promise.all([
    fetchBulkQuotes(stockTickers),
    fetchBulkQuotes(etfTickers),
  ]);

  // Pre-pick top-N tickers so we only force-recompute signals for what's shown.
  const preStocks = buildMovers(stockQuotes, stockTickers, STOCK_TOP_N, {});
  const preEtfs   = buildMovers(etfQuotes,   etfTickers,   ETF_TOP_N,   {});
  const stockTopTickers = [...preStocks.gainers, ...preStocks.decliners].map(r => r.ticker);
  const etfTopTickers   = [...preEtfs.gainers,   ...preEtfs.decliners].map(r => r.ticker);

  // Build sectorMap for stock recompute from FMP profiles in one call (24-tickers max).
  const sectorMap = {};
  if (stockTopTickers.length > 0) {
    try {
      const profiles = await fetchJson(`/profile/${stockTopTickers.join(',')}`);
      if (Array.isArray(profiles)) {
        const { normalizeSector } = await import('./sectorUtils.js');
        for (const p of profiles) {
          if (p?.symbol && p?.sector) sectorMap[p.symbol] = normalizeSector(p.sector);
        }
      }
    } catch (err) {
      console.error('[Movers] sectorMap profile fetch failed:', err.message);
    }
  }

  const [stockSignals, etfSignals] = await Promise.all([
    freshSignalsFor(stockTopTickers, { sectorMap }).catch(err => {
      console.error('[Movers] stock signals recompute failed:', err.message);
      return {};
    }),
    freshSignalsFor(etfTopTickers, { isETF: true }).catch(err => {
      console.error('[Movers] etf signals recompute failed:', err.message);
      return {};
    }),
  ]);

  const data = {
    stocks: buildMovers(stockQuotes, stockTickers, STOCK_TOP_N, stockSignals),
    etfs: buildMovers(etfQuotes, etfTickers, ETF_TOP_N, etfSignals),
    asOf: new Date().toISOString(),
  };

  moversCache = { data, timestamp: Date.now() };
  console.log(`[Movers] ✅ stocks ${data.stocks.gainers.length}↑/${data.stocks.decliners.length}↓ · ETFs ${data.etfs.gainers.length}↑/${data.etfs.decliners.length}↓`);
  return data;
}
