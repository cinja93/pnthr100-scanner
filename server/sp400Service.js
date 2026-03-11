import dotenv from 'dotenv';
dotenv.config();

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';

// ── Selection criteria ────────────────────────────────────────────────────────
// Longs:  price > 200-day MA (uptrend proxy), price > $20, top 80 by YTD return
// Shorts: price < 200-day MA (downtrend proxy), price > $70 (avoids penny-land), top 80 by YTD return (worst first)
// Lists refresh weekly, keyed by last Friday's date.

const LONG_COUNT  = 80;
const SHORT_COUNT = 80;
const MIN_LONG_PRICE  = 20;
const MIN_SHORT_PRICE = 70;

// ── Weekly cache ──────────────────────────────────────────────────────────────
let sp400Cache = { weekKey: null, longs: [], shorts: [] };

function getWeekKey() {
  const today = new Date();
  const day   = today.getDay();
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

// Year-start price for YTD calculation (Dec 31 of previous year)
function getYearStartDate() {
  const year = new Date().getFullYear();
  return `${year - 1}-12-31`;
}

async function getYearStartPrices(tickers) {
  const yearStart = getYearStartDate();
  const prices = {};
  const CHUNK = 200;
  for (let i = 0; i < tickers.length; i += CHUNK) {
    const chunk = tickers.slice(i, i + CHUNK);
    try {
      // FMP historical-price-full supports comma-separated tickers? No — needs individual calls.
      // Use bulk quote's change fields as proxy: `priceAvg50`, `priceAvg200`, `ytdChange` if available.
      // Fall back: individual price history per ticker in batches of 5.
      await Promise.all(chunk.slice(0, 5).map(async (ticker) => {
        try {
          const hist = await fetchFMP(`/historical-price-full/${ticker}?from=${yearStart}&to=${yearStart}`);
          if (hist?.historical?.length > 0) {
            prices[ticker] = hist.historical[hist.historical.length - 1].close;
          }
        } catch (_) { /* skip */ }
      }));
    } catch (_) { /* skip chunk */ }
    if (i + CHUNK < tickers.length) await new Promise(r => setTimeout(r, 300));
  }
  return prices;
}

// ── Main refresh ──────────────────────────────────────────────────────────────
async function refreshSp400Cache() {
  const weekKey = getWeekKey();
  console.log(`📊 Refreshing S&P 400 leaders for week of ${weekKey}...`);

  // Step 1: Get constituent list
  const constituents = await fetchFMP('/sp400_constituent');
  if (!Array.isArray(constituents) || constituents.length === 0) {
    console.error('❌ S&P 400 constituent list empty — keeping previous cache');
    return;
  }
  const tickers = constituents.map(c => c.symbol).filter(Boolean);
  console.log(`📊 S&P 400: ${tickers.length} constituent tickers`);

  // Step 2: Bulk quotes (price, priceAvg200)
  const CHUNK = 200;
  const quoteMap = {};
  for (let i = 0; i < tickers.length; i += CHUNK) {
    const chunk = tickers.slice(i, i + CHUNK);
    try {
      const quotes = await fetchFMP(`/quote/${chunk.join(',')}`);
      if (Array.isArray(quotes)) for (const q of quotes) quoteMap[q.symbol] = q;
    } catch (err) {
      console.error(`S&P 400 quote chunk error:`, err.message);
    }
    if (i + CHUNK < tickers.length) await new Promise(r => setTimeout(r, 400));
  }

  // Step 3: Year-start prices for accurate YTD (batch of 5 at a time to stay within rate limits)
  const yearStart = getYearStartDate();
  const yearStartPrices = {};
  for (let i = 0; i < tickers.length; i += 5) {
    const chunk = tickers.slice(i, i + 5);
    await Promise.all(chunk.map(async (ticker) => {
      try {
        const hist = await fetchFMP(`/historical-price-full/${ticker}?from=${yearStart}&to=${yearStart}`);
        if (hist?.historical?.length > 0) {
          yearStartPrices[ticker] = hist.historical[hist.historical.length - 1].close;
        }
      } catch (_) { /* skip */ }
    }));
    if (i + 5 < tickers.length) await new Promise(r => setTimeout(r, 300));
  }

  // Step 4: Score and filter
  const longCandidates  = [];
  const shortCandidates = [];

  for (const ticker of tickers) {
    const q = quoteMap[ticker];
    const ysp = yearStartPrices[ticker];
    if (!q || !q.price || !q.priceAvg200 || !ysp) continue;

    const price  = q.price;
    const ma200  = q.priceAvg200;
    const ytd    = ((price - ysp) / ysp) * 100;

    if (price > ma200 && price >= MIN_LONG_PRICE)  longCandidates.push({ ticker, price, ytd });
    if (price < ma200 && price >= MIN_SHORT_PRICE) shortCandidates.push({ ticker, price, ytd });
  }

  // Longs: highest YTD first; Shorts: lowest YTD first (worst performers)
  longCandidates.sort((a, b)  => b.ytd - a.ytd);
  shortCandidates.sort((a, b) => a.ytd - b.ytd);

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
