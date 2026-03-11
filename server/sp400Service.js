import dotenv from 'dotenv';
dotenv.config();

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';

// ── Selection criteria ────────────────────────────────────────────────────────
// Longs:  close > 50-week EMA (uptrend), price >= $20, top 80 by 52-week return
// Shorts: close < 50-week EMA (downtrend), price >= $70 (avoids penny-land), bottom 80 by 52-week return
// Lists refresh weekly, keyed by last Friday's date.

const LONG_COUNT      = 80;
const SHORT_COUNT     = 80;
const MIN_LONG_PRICE  = 20;
const MIN_SHORT_PRICE = 70;

// Need 55 weeks of weekly closes to seed a 50-week EMA + a few bars of signal
const WEEKS_HISTORY = 56;

// ── Weekly cache ──────────────────────────────────────────────────────────────
let sp400Cache = { weekKey: null, longs: [], shorts: [] };

function getWeekKey() {
  const today  = new Date();
  const day    = today.getDay();
  const daysBack = day === 5 ? 0 : (day + 2) % 7;
  const lastFriday = new Date(today);
  lastFriday.setDate(today.getDate() - daysBack);
  return lastFriday.toISOString().split('T')[0];
}

async function fetchFMP(endpoint, retries = 3) {
  const url = `${FMP_BASE_URL}${endpoint}${endpoint.includes('?') ? '&' : '?'}apikey=${FMP_API_KEY}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        const wait = Math.min(1000 * Math.pow(2, attempt), 30000);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

// Extract the last trading close of each ISO week from a sorted (oldest-first) daily array
function extractWeeklyCloses(dailyOldestFirst) {
  const byWeek = new Map();
  for (const bar of dailyOldestFirst) {
    const d = new Date(bar.date + 'T12:00:00'); // noon UTC to avoid timezone edge cases
    // ISO week key: year + week number
    const jan4 = new Date(d.getFullYear(), 0, 4);
    const weekNum = Math.ceil(((d - jan4) / 86400000 + jan4.getDay() + 1) / 7);
    const key = `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
    byWeek.set(key, bar.close); // overwrites with later dates → last trading day of week
  }
  return [...byWeek.values()]; // oldest to newest
}

// 50-period EMA on an array of closes (oldest first)
function calcEma(closes, period = 50) {
  if (closes.length < period + 1) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, c) => s + c, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

// ── Main refresh ──────────────────────────────────────────────────────────────
async function refreshSp400Cache() {
  const weekKey = getWeekKey();
  console.log(`📊 Refreshing S&P 400 leaders for week of ${weekKey}...`);

  // Step 1: Constituent list
  const constituents = await fetchFMP('/sp400_constituent');
  if (!Array.isArray(constituents) || constituents.length === 0) {
    console.error('❌ S&P 400 constituent list empty — keeping previous cache');
    return;
  }
  const tickers = [...new Set(constituents.map(c => c.symbol).filter(Boolean))];
  console.log(`📊 S&P 400: ${tickers.length} tickers`);

  // Step 2: Bulk current quotes (for current price filter)
  const quoteMap = {};
  const QCHUNK = 200;
  for (let i = 0; i < tickers.length; i += QCHUNK) {
    try {
      const quotes = await fetchFMP(`/quote/${tickers.slice(i, i + QCHUNK).join(',')}`);
      if (Array.isArray(quotes)) for (const q of quotes) quoteMap[q.symbol] = q;
    } catch (err) {
      console.error('S&P 400 quote error:', err.message);
    }
    if (i + QCHUNK < tickers.length) await new Promise(r => setTimeout(r, 400));
  }

  // Step 3: Weekly price history for 50-week EMA + 52-week return
  // FMP multi-ticker historical: /historical-price-full/T1,T2,...?from=DATE&serietype=line
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - WEEKS_HISTORY * 7);
  const from = fromDate.toISOString().split('T')[0];

  const histMap = {}; // ticker → { ema50w, return52w, latestClose }
  const HCHUNK = 10;  // FMP supports ~10 tickers per historical call

  for (let i = 0; i < tickers.length; i += HCHUNK) {
    const chunk = tickers.slice(i, i + HCHUNK);
    try {
      const raw = await fetchFMP(`/historical-price-full/${chunk.join(',')}?from=${from}&serietype=line`);

      // Multi-ticker returns { historicalStockList: [...] }; single returns { symbol, historical }
      const list = raw?.historicalStockList
        ?? (raw?.historical ? [{ symbol: raw.symbol, historical: raw.historical }] : []);

      for (const item of list) {
        if (!item?.historical?.length) continue;
        // FMP returns newest-first — reverse to oldest-first
        const oldestFirst = [...item.historical].reverse();
        const weeklyCloses = extractWeeklyCloses(oldestFirst);

        if (weeklyCloses.length < 53) continue; // not enough history

        const ema50w      = calcEma(weeklyCloses, 50);
        const latestClose = weeklyCloses[weeklyCloses.length - 1];
        const close52wAgo = weeklyCloses[weeklyCloses.length - 53]; // ~52 weeks back
        const return52w   = close52wAgo > 0 ? ((latestClose - close52wAgo) / close52wAgo) * 100 : 0;

        if (ema50w != null) histMap[item.symbol] = { ema50w, return52w, latestClose };
      }
    } catch (err) {
      console.error(`S&P 400 history error (batch ${i / HCHUNK + 1}):`, err.message);
    }
    if (i + HCHUNK < tickers.length) await new Promise(r => setTimeout(r, 300));
  }

  // Step 4: Score and filter
  const longCandidates  = [];
  const shortCandidates = [];

  for (const ticker of tickers) {
    const q    = quoteMap[ticker];
    const hist = histMap[ticker];
    if (!q || !hist || !q.price) continue;

    const price    = q.price;
    const { ema50w, return52w } = hist;

    if (price > ema50w && price >= MIN_LONG_PRICE)  longCandidates.push({ ticker, price, return52w });
    if (price < ema50w && price >= MIN_SHORT_PRICE) shortCandidates.push({ ticker, price, return52w });
  }

  // Longs: best 52-week return first; Shorts: worst 52-week return first
  longCandidates.sort((a, b)  => b.return52w - a.return52w);
  shortCandidates.sort((a, b) => a.return52w - b.return52w);

  sp400Cache = {
    weekKey,
    longs:  longCandidates.slice(0, LONG_COUNT).map(s => s.ticker),
    shorts: shortCandidates.slice(0, SHORT_COUNT).map(s => s.ticker),
  };

  console.log(`📊 S&P 400 leaders cached: ${sp400Cache.longs.length} longs, ${sp400Cache.shorts.length} shorts (week of ${weekKey})`);
}

export async function getSp400Longs() {
  if (sp400Cache.weekKey !== getWeekKey()) await refreshSp400Cache();
  return sp400Cache.longs;
}

export async function getSp400Shorts() {
  if (sp400Cache.weekKey !== getWeekKey()) await refreshSp400Cache();
  return sp400Cache.shorts;
}
