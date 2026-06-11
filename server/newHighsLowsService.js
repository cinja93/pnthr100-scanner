// server/newHighsLowsService.js
// Stocks at a NEW intraday 52-week high or low, split by universe:
//   Carnivore (679 = S&P 500 + S&P 400 fill)  |  AI 300 (AI Universe).
// "New high" = today's intraday high reached the 52-week high (FMP dayHigh >= yearHigh).
// "New low"  = today's intraday low reached the 52-week low  (FMP dayLow  <= yearLow).
// (FMP's yearHigh/yearLow is the rolling 52-week max/min; dayHigh == yearHigh only when
//  today set or tied the 52-week extreme — so the comparison is robust either way.)
import { fetchFMP } from './stockService.js';
import { getAllTickers, getSp400Tickers } from './constituents.js';
import { SECTORS as AI_SECTORS } from './scripts/aiUniverse/aiUniverseData.js';

const AI_TICKERS = (() => {
  const out = [];
  for (const s of AI_SECTORS) for (const h of s.holdings) out.push(h.ticker);
  return [...new Set(out)];
})();

async function fetchQuotesChunked(tickers) {
  const map = {};
  for (let i = 0; i < tickers.length; i += 200) {
    const chunk = tickers.slice(i, i + 200);
    const quotes = await fetchFMP(`/quote/${chunk.join(',')}`).catch(() => null);
    if (Array.isArray(quotes)) for (const q of quotes) if (q && q.symbol) map[q.symbol] = q;
  }
  return map;
}

function classify(tickers, quoteMap) {
  const highs = [], lows = [];
  for (const t of tickers) {
    const q = quoteMap[t];
    if (!q) continue;
    const price = +q.price, dayHigh = +q.dayHigh, dayLow = +q.dayLow, yearHigh = +q.yearHigh, yearLow = +q.yearLow;
    if (!(price > 0) || !(yearHigh > 0) || !(yearLow > 0)) continue;
    const changePct = +q.changesPercentage || 0;
    if (dayHigh > 0 && dayHigh >= yearHigh) highs.push({ ticker: t, price, level: yearHigh, changePct });
    else if (dayLow > 0 && dayLow <= yearLow) lows.push({ ticker: t, price, level: yearLow, changePct });
  }
  const byTicker = (a, b) => a.ticker.localeCompare(b.ticker);
  highs.sort(byTicker); lows.sort(byTicker);
  return { highs, lows };
}

export async function getNewHighsLows() {
  // Carnivore = base index universe (S&P 500 + Nasdaq + Dow) ∪ full S&P 400 (MidCap).
  const [base, sp400] = await Promise.all([getAllTickers(), getSp400Tickers()]);
  const carnivoreTickers = [...new Set([...(base || []), ...(sp400 || [])])];
  const all = [...new Set([...carnivoreTickers, ...AI_TICKERS])];
  const quoteMap = await fetchQuotesChunked(all);
  return {
    carnivore: classify(carnivoreTickers, quoteMap),
    ai300: classify(AI_TICKERS, quoteMap),
    updatedAt: new Date().toISOString(),
  };
}
