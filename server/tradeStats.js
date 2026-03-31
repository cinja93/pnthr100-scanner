// tradeStats.js — run with: node server/tradeStats.js
// Computes profitability stats for all closed BL→BE trades across the PNTHR Long top-100 list.

import dotenv from 'dotenv';
dotenv.config({ path: new URL('.env', import.meta.url).pathname });

import { aggregateWeeklyBars } from './technicalUtils.js';

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';
const EMA_PERIOD   = 21;
const WEEKS_HISTORY = 260;

// ── Helpers ───────────────────────────────────────────────────────────────────
// aggregateWeeklyBars imported from technicalUtils.js

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP ${res.status} for ${url}`);
  return res.json();
}

async function fetchDailyBars(ticker, from, to) {
  const url = `${FMP_BASE_URL}/historical-price-full/${ticker}?from=${from}&to=${to}&apikey=${FMP_API_KEY}`;
  const data = await fetchJSON(url);
  return data?.historical || [];
}

function computeEMASeries(closes, period) {
  if (closes.length < period) return [];
  const mult = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, c) => s + c, 0) / period;
  const emas = [ema];
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * mult + ema * (1 - mult);
    emas.push(ema);
  }
  return emas;
}

// ── Full state machine — returns ALL BL/BE/SS/SE events ───────────────────────

function runFullStateMachine(weeklyBars) {
  const events = [];
  if (weeklyBars.length < EMA_PERIOD + 2) return events;

  const closes    = weeklyBars.map(b => b.close);
  const emas      = computeEMASeries(closes, EMA_PERIOD);
  if (emas.length < 2) return events;
  const emaOffset = EMA_PERIOD - 1;

  let position        = null;
  let longDaylight    = 0;
  let shortDaylight   = 0;
  let longTrendActive  = false;
  let longTrendCapped  = false;
  let shortTrendActive = false;
  let shortTrendCapped = false;

  for (let wi = EMA_PERIOD + 1; wi < weeklyBars.length; wi++) {
    const emaIdx     = wi - emaOffset;
    if (emaIdx < 1) continue;
    const current    = weeklyBars[wi];
    const prev1      = weeklyBars[wi - 1];
    const prev2      = weeklyBars[wi - 2];
    const emaCurrent = emas[emaIdx];
    const twoWeekHigh = Math.max(prev1.high, prev2.high);
    const twoWeekLow  = Math.min(prev1.low,  prev2.low);

    longDaylight  = current.low  > emaCurrent ? longDaylight  + 1 : 0;
    shortDaylight = current.high < emaCurrent ? shortDaylight + 1 : 0;

    if (position && position.entryWi !== wi) {
      if (position.type === 'BL') {
        if (current.low < twoWeekLow) {
          const exitPrice    = parseFloat((twoWeekLow - 0.01).toFixed(2));
          const profitDollar = parseFloat((exitPrice - position.entryPrice).toFixed(2));
          const profitPct    = parseFloat(((profitDollar / position.entryPrice) * 100).toFixed(2));
          events.push({ type: 'BE', week: current.weekStart, entryPrice: position.entryPrice, exitPrice, profitDollar, profitPct });
          shortTrendActive = true;
          shortTrendCapped = true;
          position = null; continue;
        }
      } else {
        if (current.high > twoWeekHigh) {
          const exitPrice    = parseFloat((twoWeekHigh + 0.01).toFixed(2));
          const profitDollar = parseFloat((position.entryPrice - exitPrice).toFixed(2));
          const profitPct    = parseFloat(((profitDollar / position.entryPrice) * 100).toFixed(2));
          events.push({ type: 'SE', week: current.weekStart, entryPrice: position.entryPrice, exitPrice, profitDollar, profitPct });
          longTrendActive = true;
          longTrendCapped = true;
          position = null; continue;
        }
      }
    }

    if (!position) {
      const emaPrev = emas[emaIdx - 1];
      const blPhase1 = current.close > emaCurrent && emaCurrent > emaPrev && current.high >= twoWeekHigh + 0.01;
      const ssPhase1 = current.close < emaCurrent && emaCurrent < emaPrev && current.low  <= twoWeekLow  - 0.01;
      const blZone   = current.low  >= emaCurrent * 1.01 && current.low  <= emaCurrent * 1.10;
      const ssZone   = current.high <= emaCurrent * 0.99 && current.high >= emaCurrent * 0.90;

      const blReentry = longTrendActive  && current.low  >= emaCurrent * 1.01 && (!longTrendCapped  || current.low  <= emaCurrent * 1.25);
      const ssReentry = shortTrendActive && current.high <= emaCurrent * 0.99 && (!shortTrendCapped || current.high >= emaCurrent * 0.75);
      const blDaylightOk = blReentry || (blZone && longDaylight  >= 1 && longDaylight  <= 3);
      const ssDaylightOk = ssReentry || (ssZone && shortDaylight >= 1 && shortDaylight <= 3);

      if (blPhase1 && blDaylightOk) {
        const entryPrice = parseFloat((twoWeekHigh + 0.01).toFixed(2));
        events.push({ type: 'BL', week: current.weekStart, entryPrice });
        position         = { type: 'BL', entryWi: wi, entryPrice };
        longTrendActive  = true;
        longTrendCapped  = false;
        shortTrendActive = false;
        shortTrendCapped = false;
      } else if (ssPhase1 && ssDaylightOk) {
        const entryPrice = parseFloat((twoWeekLow - 0.01).toFixed(2));
        events.push({ type: 'SS', week: current.weekStart, entryPrice });
        position         = { type: 'SS', entryWi: wi, entryPrice };
        shortTrendActive = true;
        shortTrendCapped = false;
        longTrendActive  = false;
        longTrendCapped  = false;
      }
    }
  }
  return events;
}

// ── Fetch top-100 long tickers ─────────────────────────────────────────────────

async function getTop100LongTickers() {
  process.stdout.write('Fetching constituents...');
  const [sp500, nasdaq, dow] = await Promise.all([
    fetchJSON(`${FMP_BASE_URL}/sp500_constituent?apikey=${FMP_API_KEY}`).catch(() => []),
    fetchJSON(`${FMP_BASE_URL}/nasdaq_constituent?apikey=${FMP_API_KEY}`).catch(() => []),
    fetchJSON(`${FMP_BASE_URL}/dowjones_constituent?apikey=${FMP_API_KEY}`).catch(() => []),
  ]);
  const tickers = [...new Set([...sp500, ...nasdaq, ...dow].map(s => s.symbol).filter(Boolean))];
  console.log(` ${tickers.length} tickers.`);

  // Batch quotes
  process.stdout.write('Fetching bulk quotes...');
  const [spQuotes, nasdaqQuotes] = await Promise.all([
    fetchJSON(`${FMP_BASE_URL}/quotes/sp500?apikey=${FMP_API_KEY}`).catch(() => []),
    fetchJSON(`${FMP_BASE_URL}/quotes/nasdaq?apikey=${FMP_API_KEY}`).catch(() => []),
  ]);
  const quoteMap = {};
  for (const q of [...spQuotes, ...nasdaqQuotes]) {
    if (q.symbol && q.price) quoteMap[q.symbol] = q.price;
  }
  console.log(` ${Object.keys(quoteMap).length} quotes.`);

  // Year-start prices — fetch Dec 26–31 window so we catch the last trading day even if Dec 31 is a weekend
  const prevYear  = new Date().getFullYear() - 1;
  const fromYS    = `${prevYear}-12-26`;
  const toYS      = `${prevYear}-12-31`;
  process.stdout.write('Fetching year-start prices (batches of 5)...');
  const yearStartMap = {};
  const chunkSize5 = 5;
  for (let i = 0; i < tickers.length; i += chunkSize5) {
    const chunk  = tickers.slice(i, i + chunkSize5);
    const joined = chunk.join(',');
    const url    = `${FMP_BASE_URL}/historical-price-full/${joined}?from=${fromYS}&to=${toYS}&apikey=${FMP_API_KEY}`;
    const data   = await fetchJSON(url).catch(() => ({}));
    const list   = data.historicalStockList || (data.symbol ? [data] : []);
    for (const entry of list) {
      if (entry.historical?.length) yearStartMap[entry.symbol] = entry.historical[0].close;
    }
    // also handle single-ticker response shape
    if (data.symbol && data.historical?.length) yearStartMap[data.symbol] = data.historical[0].close;
    if (i % 50 === 0) process.stdout.write('.');
    await new Promise(r => setTimeout(r, 150));
  }
  console.log(` ${Object.keys(yearStartMap).length} year-start prices.`);

  // Compute YTD and select top 100
  const ytdList = tickers
    .filter(t => quoteMap[t] && yearStartMap[t])
    .map(t => ({ ticker: t, ytd: (quoteMap[t] - yearStartMap[t]) / yearStartMap[t] * 100 }))
    .sort((a, b) => b.ytd - a.ytd)
    .slice(0, 100);

  const top = ytdList.slice(0, 100);
  console.log(`Top ${top.length} long: ${top[0].ticker}(${top[0].ytd.toFixed(1)}%) … ${top[top.length-1].ticker}(${top[top.length-1].ytd.toFixed(1)}%)`);
  return top.map(x => x.ticker);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const tickers = await getTop100LongTickers();

  const toDate  = new Date().toISOString().split('T')[0];
  const fromD   = new Date();
  fromD.setDate(fromD.getDate() - WEEKS_HISTORY * 7);
  const fromDate = fromD.toISOString().split('T')[0];

  const allBETrades = [];  // all closed BL→BE trades
  const errors = [];

  console.log(`\nRunning state machine on ${tickers.length} tickers (${fromDate} → ${toDate})...`);

  const concurrency = 5;
  for (let i = 0; i < tickers.length; i += concurrency) {
    const chunk = tickers.slice(i, i + concurrency);
    await Promise.all(chunk.map(async (ticker) => {
      try {
        const daily  = await fetchDailyBars(ticker, fromDate, toDate);
        const weekly = aggregateWeeklyBars(daily);
        const events = runFullStateMachine(weekly);
        const beTrades = events.filter(e => e.type === 'BE');
        for (const t of beTrades) allBETrades.push({ ticker, ...t });
      } catch (err) {
        errors.push(`${ticker}: ${err.message}`);
      }
    }));
    process.stdout.write(`  ${Math.min(i + concurrency, tickers.length)}/${tickers.length}\r`);
    if (i + concurrency < tickers.length) await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\nDone. Errors: ${errors.length}`);

  // ── Stats ──────────────────────────────────────────────────────────────────
  if (allBETrades.length === 0) {
    console.log('No closed BE trades found.');
    return;
  }

  const profitable  = allBETrades.filter(t => t.profitDollar > 0);
  const unprofitable = allBETrades.filter(t => t.profitDollar <= 0);
  const winRate     = (profitable.length / allBETrades.length * 100).toFixed(1);
  const avgProfitPct = (allBETrades.reduce((s, t) => s + t.profitPct, 0) / allBETrades.length).toFixed(2);
  const avgProfitDollar = (allBETrades.reduce((s, t) => s + t.profitDollar, 0) / allBETrades.length).toFixed(2);
  const avgWinPct    = profitable.length  ? (profitable.reduce((s, t) => s + t.profitPct, 0)    / profitable.length).toFixed(2)    : 'N/A';
  const avgWinDollar = profitable.length  ? (profitable.reduce((s, t) => s + t.profitDollar, 0) / profitable.length).toFixed(2)    : 'N/A';
  const avgLossPct   = unprofitable.length ? (unprofitable.reduce((s, t) => s + t.profitPct, 0)  / unprofitable.length).toFixed(2)  : 'N/A';
  const avgLossDollar = unprofitable.length ? (unprofitable.reduce((s, t) => s + t.profitDollar, 0) / unprofitable.length).toFixed(2) : 'N/A';

  const bestTrade  = allBETrades.reduce((best, t) => t.profitPct > best.profitPct ? t : best, allBETrades[0]);
  const worstTrade = allBETrades.reduce((worst, t) => t.profitPct < worst.profitPct ? t : worst, allBETrades[0]);

  console.log(`
═══════════════════════════════════════════════════
  PNTHR LONG — CLOSED BE TRADE STATISTICS
  (5-year lookback, ${tickers.length} tickers)
═══════════════════════════════════════════════════
  Total closed BL→BE trades : ${allBETrades.length}
  Profitable trades          : ${profitable.length} (${winRate}%)
  Unprofitable trades        : ${unprofitable.length} (${(100 - parseFloat(winRate)).toFixed(1)}%)

  ── All Trades ──────────────────────────────────
  Avg profit %               : ${avgProfitPct}%
  Avg profit $               : $${avgProfitDollar}/sh

  ── Winners only ────────────────────────────────
  Avg win %                  : ${avgWinPct}%
  Avg win $                  : $${avgWinDollar}/sh

  ── Losers only ─────────────────────────────────
  Avg loss %                 : ${avgLossPct}%
  Avg loss $                 : $${avgLossDollar}/sh

  ── Best trade ──────────────────────────────────
  ${bestTrade.ticker} BE on ${bestTrade.week}: +${bestTrade.profitPct}% (+$${bestTrade.profitDollar}/sh)
  ── Worst trade ─────────────────────────────────
  ${worstTrade.ticker} BE on ${worstTrade.week}: ${worstTrade.profitPct}% ($${worstTrade.profitDollar}/sh)
═══════════════════════════════════════════════════
`);

  // Per-ticker breakdown of profitable trades
  console.log('Profitable BE trades by ticker:');
  const byTicker = {};
  for (const t of allBETrades) {
    if (!byTicker[t.ticker]) byTicker[t.ticker] = { wins: 0, losses: 0, totalPct: 0 };
    if (t.profitDollar > 0) byTicker[t.ticker].wins++;
    else byTicker[t.ticker].losses++;
    byTicker[t.ticker].totalPct += t.profitPct;
  }
  const rows = Object.entries(byTicker).sort((a, b) => b[1].totalPct - a[1].totalPct);
  for (const [ticker, s] of rows) {
    const total = s.wins + s.losses;
    console.log(`  ${ticker.padEnd(6)} ${s.wins}W/${s.losses}L  avg ${(s.totalPct/total).toFixed(1)}%`);
  }
}

main().catch(console.error);
