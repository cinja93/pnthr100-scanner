// server/newHighsLowsService.js
// Stocks at a NEW intraday N-week HIGH, by universe:
//   Carnivore (679 = S&P 500 + S&P 400 MidCap) → 4-week high  (20 trading days)  — backtest-best lookback
//   AI 300 (PNTHR AI Universe)                  → 42-week high (210 trading days) — matches the live Tree
// "New high" = today's live intraday high ≥ the highest high of the prior N trading days,
// computed from the daily candle store EXCLUDING today's forming bar (same as pnthrTreeEngine).
//
// LOWS REMOVED (2026-06-17): shorting new lows backtested as a money-loser in every regime
// and lookback (and the SS+1 short likewise), so the page is long-side ("New Highs") only.
import { fetchFMP } from './stockService.js';
import { getAllTickers, getSp400Tickers } from './constituents.js';
import { SECTORS as AI_SECTORS } from './scripts/aiUniverse/aiUniverseData.js';
import { connectToDatabase } from './database.js';

const CARN_LOOKBACK = 20;    // 4-week high
const AI_LOOKBACK = 210;     // 42-week high (= pnthrTreeEngine ENTRY_HIGH_LOOKBACK)

const AI_TICKERS = (() => {
  const out = [];
  for (const s of AI_SECTORS) for (const h of s.holdings) out.push(h.ticker);
  return [...new Set(out)];
})();

const etDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });   // YYYY-MM-DD in ET

async function fetchQuotesChunked(tickers) {
  const map = {};
  for (let i = 0; i < tickers.length; i += 200) {
    const chunk = tickers.slice(i, i + 200);
    const quotes = await fetchFMP(`/quote/${chunk.join(',')}`).catch(() => null);
    if (Array.isArray(quotes)) for (const q of quotes) if (q && q.symbol) map[q.symbol] = q;
  }
  return map;
}

// Highest high of the prior `lookback` trading days (excludes today's forming bar).
async function priorHighs(db, coll, tickers, lookback) {
  const today = etDate();
  const docs = await db.collection(coll).find({ ticker: { $in: tickers } }, { projection: { ticker: 1, daily: 1 } }).toArray();
  const out = {};
  for (const d of docs) {
    const bars = (d.daily || []).filter(b => b.date < today && +b.high > 0).sort((a, b) => a.date.localeCompare(b.date));
    if (bars.length < lookback) continue;                            // need a full window — no half-baked highs
    out[d.ticker] = Math.max(...bars.slice(-lookback).map(b => +b.high));
  }
  return out;
}

function classifyHighs(tickers, quoteMap, priorHi) {
  const highs = [];
  for (const t of tickers) {
    const q = quoteMap[t]; const ph = priorHi[t];
    if (!q || !(ph > 0)) continue;
    const price = +q.price; const dayHigh = +q.dayHigh || price;
    if (!(price > 0)) continue;
    if (dayHigh >= ph + 0.01) highs.push({ ticker: t, price, level: +ph.toFixed(2), changePct: +q.changesPercentage || 0 });
  }
  highs.sort((a, b) => a.ticker.localeCompare(b.ticker));
  return highs;
}

export async function getNewHighsLows() {
  const db = await connectToDatabase();
  const [base, sp400] = await Promise.all([getAllTickers(), getSp400Tickers()]);
  const carnivoreTickers = [...new Set([...(base || []), ...(sp400 || [])])];
  const all = [...new Set([...carnivoreTickers, ...AI_TICKERS])];
  const [quoteMap, carnHi, aiHi] = await Promise.all([
    fetchQuotesChunked(all),
    priorHighs(db, 'pnthr_bt_candles', carnivoreTickers, CARN_LOOKBACK),
    priorHighs(db, 'pnthr_ai_bt_candles', AI_TICKERS, AI_LOOKBACK),
  ]);
  return {
    carnivore: { highs: classifyHighs(carnivoreTickers, quoteMap, carnHi), lookbackWeeks: 4 },
    ai300: { highs: classifyHighs(AI_TICKERS, quoteMap, aiHi), lookbackWeeks: 42 },
    updatedAt: new Date().toISOString(),
  };
}
