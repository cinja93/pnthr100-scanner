import dotenv from 'dotenv';
import { getSignals } from './signalService.js';

dotenv.config();

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';

// ── PNTHR ETF 140 — curated list by category ─────────────────────────────────
const ETF_CATEGORIES = [
  {
    label: 'S&P 500 Sectors',
    tickers: ['XLK','XLI','XLF','XLV','XLY','XLP','XLRE','XLB','XLU','XLC','XLE'],
  },
  {
    label: 'Broad Market',
    tickers: ['SPY','VOO','RSP','ONEQ','QQQ','NYA','DIA','VTI','IWB','IWV','IWM','IJR','TOPT','IJH','FRTY'],
  },
  {
    label: 'Growth & Factor',
    tickers: ['SPMO','XMMO','QUAL','MGK','VUG','SCHG','QQQM','SCHD','VIG','DGRO','NOBL','USMV','VYM','NANC'],
  },
  {
    label: 'Technology & Innovation',
    tickers: ['MAGS','IETC','SMH','XSD','SOXX','VGT','IGV','AIQ','ARTY','CHAT','QTUM','HACK','CLOU','DTCR','SOCL','BLOK','BKCH','XTL','TTEQ'],
  },
  {
    label: 'Aerospace & Defense',
    tickers: ['XAR','ITA','ARKX','JEDI','FITE','BOTZ','ROBO'],
  },
  {
    label: 'Energy & Infrastructure',
    tickers: ['XOP','OIH','USO','USAI','LNGX','UNG','NUKZ','RSHO','POWR','GRID','PAVE','JETS'],
  },
  {
    label: 'Materials & Mining',
    tickers: ['XME','PICK','REMX','GDX','SIL','SLVP','COPJ','COPX','SLX','URA','LIT','SETM','IBAT','IGF'],
  },
  {
    label: 'Precious Metals & Commodities',
    tickers: ['GLD','SLV','USCI','DBA','MOO'],
  },
  {
    label: 'Financials & Real Estate',
    tickers: ['VNQ','ITB','XHB','WTRE'],
  },
  {
    label: 'Health Care & Biotech',
    tickers: ['XHE','XBI','IHE'],
  },
  {
    label: 'International & Emerging Markets',
    tickers: ['EEM','IDMO','SPEU','AIA','INDA','EPI','FXI','YINN','EWJ','EWY','EWC','FLMX','ARGT','EWZ','EWP','GREK','EIS','EPU'],
  },
  {
    label: 'Fixed Income & Currencies',
    tickers: ['LQD','HYG','SHY','IEF','TLT','UUP','UDN','FXY','FXE','FXB','FXF','FXC','FXA','VTEB','MUB','PZA'],
  },
  {
    label: 'Cryptocurrency',
    tickers: ['IBIT','BTCO','XRPC'],
  },
];

// ── PNTHR AI 300 ETFs — AI-themed ETFs organized by AI sector ────────────────
const AI_ETF_CATEGORIES = [
  {
    label: 'Pure AI & Machine Learning',
    tickers: ['BAI','AIQ','ARTY','CHAT','IGPT','WTAI','THNQ','LRNZ','XAIX','IVES'],
  },
  {
    label: 'AI Semiconductors & Memory',
    tickers: ['DRAM','SMH','SOXX','XSD','PSI'],
  },
  {
    label: 'AI Infrastructure & Data Centers',
    tickers: ['GRID','VRT','EQIX','DLR','AMT','CCI'],
  },
  {
    label: 'Robotics & Automation',
    tickers: ['BOTZ','ROBT','ROBO','BOTT','ARKQ'],
  },
  {
    label: 'AI Software & Cloud',
    tickers: ['CLOU','HACK','IGV','SKYY','WCLD'],
  },
  {
    label: 'AI Quantum Computing',
    tickers: ['QTUM','IONQ','RGTI','QBTS'],
  },
  {
    label: 'AI Energy & Power',
    tickers: ['NUKZ','GRID','ICLN','QCLN'],
  },
  {
    label: 'AI Autonomous & EV',
    tickers: ['DRIV','IDRV','MAGS'],
  },
  {
    label: 'AI Income & Thematic',
    tickers: ['AIPI','KOMP','RSPT','BUZZ'],
  },
  {
    label: 'International AI',
    tickers: ['DRGN','EEM','FXI','EWJ','EWY'],
  },
];

// Build flat ticker→category map and ordered ticker list
const TICKER_CATEGORY = {};
const ALL_ETF_TICKERS = [];
for (const cat of ETF_CATEGORIES) {
  for (const t of cat.tickers) {
    TICKER_CATEGORY[t] = cat.label;
    ALL_ETF_TICKERS.push(t);
  }
}

const AI_TICKER_CATEGORY = {};
const ALL_AI_ETF_TICKERS = [];
for (const cat of AI_ETF_CATEGORIES) {
  for (const t of cat.tickers) {
    if (!AI_TICKER_CATEGORY[t]) {
      AI_TICKER_CATEGORY[t] = cat.label;
      ALL_AI_ETF_TICKERS.push(t);
    }
  }
}

// Cache results for 60 minutes
let etfCache = { data: null, timestamp: null };
const CACHE_TTL_MS = 60 * 60 * 1000;

async function fetchJson(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${FMP_BASE_URL}${path}${sep}apikey=${FMP_API_KEY}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`FMP ${res.status} for ${path}`);
  return res.json();
}

async function fetchYtdChanges(tickers) {
  const results = {};
  const BATCH = 500;
  for (let i = 0; i < tickers.length; i += BATCH) {
    const chunk = tickers.slice(i, i + BATCH);
    try {
      const data = await fetchJson(`/stock-price-change/${chunk.join(',')}`);
      if (Array.isArray(data)) {
        for (const item of data) {
          if (item.symbol && item.ytd != null) results[item.symbol] = item.ytd;
        }
      }
    } catch (err) {
      console.error('ETF YTD batch error:', err.message);
    }
    if (i + BATCH < tickers.length) await new Promise(r => setTimeout(r, 300));
  }
  return results;
}

async function fetchBulkQuotes(tickers) {
  const results = {};
  const BATCH = 500;
  for (let i = 0; i < tickers.length; i += BATCH) {
    const chunk = tickers.slice(i, i + BATCH);
    try {
      const data = await fetchJson(`/quote/${chunk.join(',')}`);
      if (Array.isArray(data)) {
        for (const q of data) if (q.symbol) results[q.symbol] = q;
      }
    } catch (err) {
      console.error('ETF quote batch error:', err.message);
    }
    if (i + BATCH < tickers.length) await new Promise(r => setTimeout(r, 300));
  }
  return results;
}

// Export the canonical ETF ticker set so other modules (e.g. pulse) can classify ETFs
export const ALL_ETF_TICKER_SET = new Set([...ALL_ETF_TICKERS, ...ALL_AI_ETF_TICKERS]);

// Export AI ETF category lookup (ticker → AI category label)
export { AI_TICKER_CATEGORY };

// Returns the cached ETF results without triggering a refetch — null if cache is cold.
// Same pattern as getCachedApexResults() in apexService.js.
export function getCachedEtfResults() {
  if (!etfCache.data) return null;
  return etfCache.data; // { stocks, signals, categories }
}

export async function getEtfStocks(forceRefresh = false) {
  if (!forceRefresh && etfCache.data && Date.now() - etfCache.timestamp < CACHE_TTL_MS) {
    console.log('📊 ETF 140: serving from cache');
    return etfCache.data;
  }

  console.log('📊 ETF 140: fetching quotes and YTD for curated list...');

  const [quoteMap, ytdMap] = await Promise.all([
    fetchBulkQuotes(ALL_ETF_TICKERS),
    fetchYtdChanges(ALL_ETF_TICKERS),
  ]);

  // Build previous rank lookup from the cached run (for rank change calculation)
  const prevRankMap = {};
  if (etfCache.data?.stocks) {
    for (const s of etfCache.data.stocks) {
      if (s.ticker && s.rank != null) prevRankMap[s.ticker] = s.rank;
    }
  }

  const unsorted = ALL_ETF_TICKERS
    .map(ticker => {
      const q = quoteMap[ticker];
      if (!q?.price) return null;
      return {
        ticker,
        companyName: q.name || ticker,
        exchange: q.exchange || 'N/A',
        sector: TICKER_CATEGORY[ticker] || 'ETF',
        category: TICKER_CATEGORY[ticker] || 'ETF',
        currentPrice: parseFloat(Number(q.price).toFixed(2)),
        ytdReturn: ytdMap[ticker] != null ? parseFloat(Number(ytdMap[ticker]).toFixed(2)) : null,
        // Volume ratio for Momentum Quality scoring (volume / avgVolume from FMP quote)
        volumeRatio: (q.volume && q.avgVolume) ? parseFloat((q.volume / q.avgVolume).toFixed(2)) : null,
      };
    })
    .filter(Boolean);

  // Sort by YTD return descending (nulls last) — rank 1 = best YTD performance
  unsorted.sort((a, b) => {
    if (a.ytdReturn == null && b.ytdReturn == null) return 0;
    if (a.ytdReturn == null) return 1;
    if (b.ytdReturn == null) return -1;
    return b.ytdReturn - a.ytdReturn;
  });

  const stocks = unsorted.map((s, i) => {
    const newRank = i + 1;
    const prevRank = prevRankMap[s.ticker] ?? null;
    // rankChange: positive = moved up (rank number decreased), negative = dropped
    const rankChange = prevRank != null ? prevRank - newRank : null;
    return { ...s, rank: newRank, rankChange, previousRank: prevRank };
  });

  const stockTickers = stocks.map(s => s.ticker);
  const signals = await getSignals(stockTickers, { isETF: true });

  console.log(`📊 ETF 140 complete: ${stocks.length} ETFs`);
  const result = { stocks, signals, categories: ETF_CATEGORIES.map(c => c.label) };
  etfCache = { data: result, timestamp: Date.now() };
  return result;
}

// ── AI 300 ETF fetch (mirrors 679 pattern) ───────────────────────────────────
let aiEtfCache = { data: null, timestamp: null };

export async function getAiEtfStocks(forceRefresh = false) {
  if (!forceRefresh && aiEtfCache.data && Date.now() - aiEtfCache.timestamp < CACHE_TTL_MS) {
    console.log('🤖 AI ETF: serving from cache');
    return aiEtfCache.data;
  }

  console.log(`🤖 AI ETF: fetching quotes and YTD for ${ALL_AI_ETF_TICKERS.length} tickers...`);

  const [quoteMap, ytdMap] = await Promise.all([
    fetchBulkQuotes(ALL_AI_ETF_TICKERS),
    fetchYtdChanges(ALL_AI_ETF_TICKERS),
  ]);

  const prevRankMap = {};
  if (aiEtfCache.data?.stocks) {
    for (const s of aiEtfCache.data.stocks) {
      if (s.ticker && s.rank != null) prevRankMap[s.ticker] = s.rank;
    }
  }

  const unsorted = ALL_AI_ETF_TICKERS
    .map(ticker => {
      const q = quoteMap[ticker];
      if (!q?.price) return null;
      return {
        ticker,
        companyName: q.name || ticker,
        exchange: q.exchange || 'N/A',
        sector: AI_TICKER_CATEGORY[ticker] || 'AI ETF',
        category: AI_TICKER_CATEGORY[ticker] || 'AI ETF',
        currentPrice: parseFloat(Number(q.price).toFixed(2)),
        ytdReturn: ytdMap[ticker] != null ? parseFloat(Number(ytdMap[ticker]).toFixed(2)) : null,
        volumeRatio: (q.volume && q.avgVolume) ? parseFloat((q.volume / q.avgVolume).toFixed(2)) : null,
      };
    })
    .filter(Boolean);

  unsorted.sort((a, b) => {
    if (a.ytdReturn == null && b.ytdReturn == null) return 0;
    if (a.ytdReturn == null) return 1;
    if (b.ytdReturn == null) return -1;
    return b.ytdReturn - a.ytdReturn;
  });

  const stocks = unsorted.map((s, i) => {
    const newRank = i + 1;
    const prevRank = prevRankMap[s.ticker] ?? null;
    const rankChange = prevRank != null ? prevRank - newRank : null;
    return { ...s, rank: newRank, rankChange, previousRank: prevRank };
  });

  const stockTickers = stocks.map(s => s.ticker);
  const signals = await getSignals(stockTickers, { isETF: true });

  console.log(`🤖 AI ETF complete: ${stocks.length} ETFs`);
  const result = { stocks, signals, categories: AI_ETF_CATEGORIES.map(c => c.label) };
  aiEtfCache = { data: result, timestamp: Date.now() };
  return result;
}
