// One-off: read pnthr_bt_pyramid_trades and produce BL_BACKTEST / SS_BACKTEST
// constants for client/src/components/OrdersPage.jsx BacktestPopup.
// Run: node server/scripts_den/computeBacktestPopupData.js
import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { connectToDatabase } from '../database.js';

function pct(n, d) { return d > 0 ? +(n / d * 100).toFixed(1) : 0; }
function round1(n) { return +Number(n).toFixed(1); }
function round2(n) { return +Number(n).toFixed(2); }

async function compute(direction) {
  const db = await connectToDatabase();
  const positions = await db.collection('pnthr_bt_pyramid_trades')
    .find({ signal: direction }, { projection: { _id: 0 } })
    .toArray();

  if (positions.length === 0) {
    console.log(`No ${direction} positions found in pnthr_bt_pyramid_trades.`);
    return null;
  }

  // Flatten lots into individual lot rows (matches BacktestPopup expectation)
  const lots = [];
  for (const pos of positions) {
    for (const lot of (pos.lots || [])) {
      lots.push({
        ticker: pos.ticker,
        signal: pos.signal,
        sector: pos.sector,
        entryDate: lot.fillDate,
        entryPrice: lot.fillPrice,
        exitDate: pos.pyramidExitDate,
        exitPrice: pos.pyramidExitPrice,
        profitPct: lot.pnlPct,
        dollarPnl: lot.dollarPnl ?? null,
        exitReason: pos.pyramidExitReason,
        lotNum: lot.lot,
        lotPct: lot.pct,
        lotsInPosition: pos.lotsFilledCount,
      });
    }
  }

  // Position-level aggregates (one row per position, not per lot)
  const positionsClosed = positions.filter(p => p.pyramidExitDate);
  const winners = positionsClosed.filter(p => (p.pyramidNetPnlPct ?? p.pyramidPnlPct ?? 0) > 0);
  const losers  = positionsClosed.filter(p => (p.pyramidNetPnlPct ?? p.pyramidPnlPct ?? 0) <= 0);

  const trades = positionsClosed.length;
  const winRate = pct(winners.length, trades);
  const avgPnl = round2(positionsClosed.reduce((s, p) => s + (p.pyramidPnlPct ?? 0), 0) / Math.max(trades, 1));
  const avgWin = round2(winners.reduce((s, p) => s + (p.pyramidPnlPct ?? 0), 0) / Math.max(winners.length, 1));
  const avgLoss = round2(losers.reduce((s, p) => s + (p.pyramidPnlPct ?? 0), 0) / Math.max(losers.length, 1));
  const wlRatio = avgLoss !== 0 ? round2(Math.abs(avgWin / avgLoss)) : 0;
  const totalReturn = Math.round(positionsClosed.reduce((s, p) => s + (p.pyramidDollarPnl ?? 0), 0));
  const lotRows = lots.length;
  const avgLots = round2(lotRows / Math.max(trades, 1));

  // Lot distribution (% of lots filled at each lot number 1-5)
  const lotDistRaw = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const l of lots) lotDistRaw[l.lotNum] = (lotDistRaw[l.lotNum] || 0) + 1;
  const lotDist = {};
  for (const k of [1, 2, 3, 4, 5]) lotDist[k] = `${pct(lotDistRaw[k], lotRows)}%`;

  // Year-by-year breakdown (entry year of position)
  const yearMap = {};
  for (const p of positionsClosed) {
    const yr = String(p.original?.entryDate || '').slice(0, 4);
    if (!yr) continue;
    if (!yearMap[yr]) yearMap[yr] = { trades: 0, wins: 0, pnlSum: 0 };
    yearMap[yr].trades++;
    yearMap[yr].pnlSum += (p.pyramidPnlPct ?? 0);
    if ((p.pyramidPnlPct ?? 0) > 0) yearMap[yr].wins++;
  }
  const allYears = Object.keys(yearMap).sort();
  const years = allYears.map(yr => ({
    year: yr,
    trades: yearMap[yr].trades,
    winPct: round1(yearMap[yr].wins / yearMap[yr].trades * 100),
    avgPnl: round2(yearMap[yr].pnlSum / yearMap[yr].trades),
  }));
  const noTradeYears = direction === 'SS'
    ? ['2019', '2020', '2021', '2022', '2023', '2024', '2025', '2026'].filter(y => !yearMap[y])
    : undefined;

  // By exit reason (position-level)
  const reasonMap = {};
  for (const p of positionsClosed) {
    const r = p.pyramidExitReason || 'UNKNOWN';
    if (!reasonMap[r]) reasonMap[r] = { count: 0, wins: 0, pnlSum: 0 };
    reasonMap[r].count++;
    reasonMap[r].pnlSum += (p.pyramidPnlPct ?? 0);
    if ((p.pyramidPnlPct ?? 0) > 0) reasonMap[r].wins++;
  }
  const exitReasons = Object.entries(reasonMap)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([reason, v]) => ({
      reason,
      count: v.count,
      winPct: round1(v.wins / v.count * 100),
      avgPnl: round2(v.pnlSum / v.count),
    }));

  // Top 5 winners and losers (position-level by pyramidPnlPct)
  const sortedByPnl = [...positionsClosed].sort((a, b) => (b.pyramidPnlPct || 0) - (a.pyramidPnlPct || 0));
  const topWinners = sortedByPnl.slice(0, 5).map(p => ({
    ticker: p.ticker,
    entry:  String(p.original?.entryDate || '').slice(0, 10),
    exit:   String(p.pyramidExitDate || '').slice(0, 10),
    pnl:    round2(p.pyramidPnlPct || 0),
  }));
  const topLosers = sortedByPnl.slice(-5).reverse().map(p => ({
    ticker: p.ticker,
    entry:  String(p.original?.entryDate || '').slice(0, 10),
    exit:   String(p.pyramidExitDate || '').slice(0, 10),
    pnl:    round2(p.pyramidPnlPct || 0),
  }));

  return {
    trades,
    winners: winners.length,
    losers: losers.length,
    winRate,
    avgPnl,
    avgWin,
    avgLoss,
    wlRatio,
    totalReturn,
    lotRows,
    avgLots,
    lotDist,
    years,
    noTradeYears,
    exitReasons,
    topWinners,
    topLosers,
  };
}

async function main() {
  const bl = await compute('BL');
  const ss = await compute('SS');
  console.log('\n========== BL_BACKTEST ==========');
  console.log(JSON.stringify(bl, null, 2));
  console.log('\n========== SS_BACKTEST ==========');
  console.log(JSON.stringify(ss, null, 2));
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
