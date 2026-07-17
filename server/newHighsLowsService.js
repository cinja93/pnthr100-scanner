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
import { getNav, sizeFor } from './pnthrTreeEngine.js';   // single source of truth for NAV + 2%-risk/10%-cap sizing

const CARN_LOOKBACK = 20;    // 4-week high
const AI_LOOKBACK = 210;     // 42-week high (= pnthrTreeEngine ENTRY_HIGH_LOOKBACK)
const STOP_LOOKBACK = 10;    // 2-week (10 trading day) trailing-stop reference (matches the Tree)

// One doc per (ET trading day, universe) holding that day's set of new-high tickers.
// Used only to flag which badges are NEW to the list today vs the prior trading day so
// the client can flash them for the day. Index lives in database.js connectToDatabase().
const SNAP_COLL = 'pnthr_new_highs_daily';

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

// Prior bands per ticker (excludes today's forming bar): the N-week HIGH (entry trigger) and
// the 10-day LOW − $0.01 (the 2-week trailing-stop reference, same as the Tree).
async function priorBands(db, coll, tickers, lookback) {
  const today = etDate();
  const docs = await db.collection(coll).find({ ticker: { $in: tickers } }, { projection: { ticker: 1, daily: 1 } }).toArray();
  const out = {};
  for (const d of docs) {
    const bars = (d.daily || []).filter(b => b.date < today && +b.high > 0 && +b.low > 0).sort((a, b) => a.date.localeCompare(b.date));
    if (bars.length < lookback) continue;                            // need a full window — no half-baked highs
    const high = Math.max(...bars.slice(-lookback).map(b => +b.high));
    const lo = bars.length >= STOP_LOOKBACK ? Math.min(...bars.slice(-STOP_LOOKBACK).map(b => +b.low)) : null;
    out[d.ticker] = { high, stop: lo != null ? +(lo - 0.01).toFixed(2) : null };
  }
  return out;
}

function classifyHighs(tickers, quoteMap, bands, nav) {
  const highs = [];
  for (const t of tickers) {
    const q = quoteMap[t]; const b = bands[t];
    if (!q || !b || !(b.high > 0)) continue;
    const price = +q.price; const dayHigh = +q.dayHigh || price;
    if (!(price > 0)) continue;
    if (dayHigh >= b.high + 0.01) {
      const sz = b.stop ? sizeFor(nav, price, b.stop) : { shares: 0, risk: 0 };   // 2% NAV risk / 10% cap — same as the Tree
      highs.push({ ticker: t, price, level: +b.high.toFixed(2), changePct: +q.changesPercentage || 0, stop: b.stop, shares: sz.shares, risk: sz.risk });
    }
  }
  highs.sort((a, b) => a.ticker.localeCompare(b.ticker));
  return highs;
}

// The most recent PRIOR trading day's set of new-high tickers for a universe (date < today).
// exists=false when there is no earlier snapshot at all → the caller then flags NOTHING as
// new, so we never claim "new today" without a real baseline (e.g. the first day after deploy).
// Using "latest snapshot before today" (not literally yesterday) means weekends/holidays and
// any day the page went unviewed are skipped over to the last day that actually had a list.
async function priorDaySet(db, universe, today) {
  const docs = await db.collection(SNAP_COLL)
    .find({ universe, date: { $lt: today } }, { projection: { tickers: 1 } })
    .sort({ date: -1 }).limit(1).toArray();
  const doc = docs[0];
  return { exists: !!doc, set: new Set(doc?.tickers || []) };
}

// Union today's tickers into today's snapshot (idempotent, concurrency-safe via $addToSet so
// simultaneous viewers can't clobber each other). Accumulating across the day means a name that
// appears at 10am and fades by noon still counts as "was on the list today" for tomorrow. We
// SKIP empty lists so a market-closed day never writes an empty baseline that would flash the
// whole board on the next trading day.
async function saveTodaySnapshot(db, universe, today, tickers) {
  if (!tickers.length) return;
  await db.collection(SNAP_COLL).updateOne(
    { date: today, universe },
    { $addToSet: { tickers: { $each: tickers } }, $set: { updatedAt: new Date() } },
    { upsert: true },
  );
}

// navOverride — when provided (e.g. a member's $50k account size), size the buy
// suggestions to THAT account instead of the house NAV, so each viewer sees their
// own share counts and risk. Admins pass nothing → the house NAV.
export async function getNewHighsLows(navOverride) {
  const db = await connectToDatabase();
  const today = etDate();
  const [base, sp400] = await Promise.all([getAllTickers(), getSp400Tickers()]);
  const carnivoreTickers = [...new Set([...(base || []), ...(sp400 || [])])];
  const all = [...new Set([...carnivoreTickers, ...AI_TICKERS])];
  const [quoteMap, carnBands, aiBands, nav, carnPrior, aiPrior] = await Promise.all([
    fetchQuotesChunked(all),
    priorBands(db, 'pnthr_bt_candles', carnivoreTickers, CARN_LOOKBACK),
    priorBands(db, 'pnthr_ai_bt_candles', AI_TICKERS, AI_LOOKBACK),
    navOverride != null ? Promise.resolve(navOverride) : getNav(db),
    priorDaySet(db, 'carnivore', today),
    priorDaySet(db, 'ai300', today),
  ]);

  const carnHighs = classifyHighs(carnivoreTickers, quoteMap, carnBands, nav);
  const aiHighs = classifyHighs(AI_TICKERS, quoteMap, aiBands, nav);

  // Flag names NEW to the list today = on the list now but NOT on the prior trading day's list.
  // No baseline yet → nothing is flagged new (see priorDaySet).
  for (const h of carnHighs) h.isNew = carnPrior.exists && !carnPrior.set.has(h.ticker);
  for (const h of aiHighs) h.isNew = aiPrior.exists && !aiPrior.set.has(h.ticker);

  // Record today's set (union) so it becomes tomorrow's baseline. Persistence must never break
  // the live read, so failures here are swallowed — the page still renders, just without flags.
  await Promise.all([
    saveTodaySnapshot(db, 'carnivore', today, carnHighs.map(h => h.ticker)),
    saveTodaySnapshot(db, 'ai300', today, aiHighs.map(h => h.ticker)),
  ]).catch(() => {});

  return {
    carnivore: { highs: carnHighs, lookbackWeeks: 4 },
    ai300: { highs: aiHighs, lookbackWeeks: 42 },
    nav,
    updatedAt: new Date().toISOString(),
  };
}
