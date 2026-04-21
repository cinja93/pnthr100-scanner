// server/backtest/exportOrdersTrades.js
// ── Export every individual trade from the Filter-Then-Rank backtest ──────────
//
// Runs the NEW_ASYM_SS config (our production Orders pipeline):
//   BL top 10 + SS crash mode top 5
//   Macro gate + Sector gate + D2 gate + SS crash gate
//   With pyramiding (Lots 1-5)
//
// Outputs a full trade log with entry/exit dates, prices, P&L, exit reasons.
//
// Usage:  cd server && node backtest/exportOrdersTrades.js
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { connectToDatabase } from '../database.js';
import { loadMembership, getDirectionIndexForTicker } from './backtestMembershipSets.js';
import { aggregateWeeklyBars } from '../technicalUtils.js';
import { computeWilderATR } from '../stopCalculation.js';
import { calcTradeCosts, sharesFromLot, COST_METHODOLOGY } from './costEngine.js';

const ALL_SECTOR_ETFS = ['XLK', 'XLE', 'XLV', 'XLF', 'XLY', 'XLC', 'XLI', 'XLB', 'XLRE', 'XLU', 'XLP'];
const SECTOR_MAP = {
  'Technology': 'XLK', 'Energy': 'XLE', 'Healthcare': 'XLV', 'Health Care': 'XLV',
  'Financial Services': 'XLF', 'Financials': 'XLF', 'Consumer Discretionary': 'XLY',
  'Communication Services': 'XLC', 'Industrials': 'XLI', 'Basic Materials': 'XLB',
  'Materials': 'XLB', 'Real Estate': 'XLRE', 'Utilities': 'XLU', 'Consumer Staples': 'XLP',
};

const LOT_SIZE_USD = 10000;
const MAX_LOTS = 5;
const TIME_GATE_DAYS = 5;
const LOT_TRIGGER_PCT = 1.0;

// ── Close helpers ───────────────────────────────────────────────────────────

function closePosition(pos, exitDate, exitPrice, exitReason) {
  pos.exitDate = exitDate;
  pos.exitPrice = exitPrice;
  pos.exitReason = exitReason;
  if (pos.signal === 'BL') {
    pos.profitPct = parseFloat(((exitPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(2));
  } else {
    pos.profitPct = parseFloat(((pos.entryPrice - exitPrice) / pos.entryPrice * 100).toFixed(2));
  }
  pos.dollarPnl = parseFloat((pos.profitPct / 100 * LOT_SIZE_USD).toFixed(2));
  pos.isWinner = pos.profitPct > 0;
  pos.closed = true;
  pos.maxLots = 1;
}

function closePyramidPosition(pos, exitDate, exitPrice, exitReason) {
  pos.exitDate = exitDate;
  pos.exitPrice = exitPrice;
  pos.exitReason = exitReason;
  pos.maxLots = pos.lots.length;
  let totalDollarPnl = 0;
  for (const lot of pos.lots) {
    if (pos.signal === 'BL') {
      lot.dollarPnl = parseFloat(((exitPrice - lot.price) * lot.shares).toFixed(2));
    } else {
      lot.dollarPnl = parseFloat(((lot.price - exitPrice) * lot.shares).toFixed(2));
    }
    totalDollarPnl += lot.dollarPnl;
  }
  pos.dollarPnl = parseFloat(totalDollarPnl.toFixed(2));
  if (pos.signal === 'BL') {
    pos.profitPct = parseFloat(((exitPrice - pos.avgCost) / pos.avgCost * 100).toFixed(2));
  } else {
    pos.profitPct = parseFloat(((pos.avgCost - exitPrice) / pos.avgCost * 100).toFixed(2));
  }
  pos.isWinner = pos.dollarPnl > 0;
  pos.closed = true;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('Cannot connect to MongoDB'); process.exit(1); }

  // Membership-based direction-index (v22 policy).
  await loadMembership(db);

  const scoreCol  = db.collection('pnthr_bt_scores');
  const signalCol = db.collection('pnthr_bt_analyze_signals');
  const regimeCol = db.collection('pnthr_bt_regime');
  const candleCol = db.collection('pnthr_bt_candles');

  // ── Load data ──
  console.log('Loading data...');
  const allScores = await scoreCol.find({}).toArray();
  const scoresByWeek = {};
  for (const s of allScores) {
    if (!scoresByWeek[s.weekOf]) scoresByWeek[s.weekOf] = [];
    scoresByWeek[s.weekOf].push(s);
  }
  const allWeeks = Object.keys(scoresByWeek).sort();

  const rawSignals = await signalCol.find({}).toArray();
  const signalMap = {};
  for (const s of rawSignals) signalMap[s.weekOf + '|' + s.ticker] = s;

  const regimeDocs = await regimeCol.find({}).toArray();
  const regimeMap = {};
  for (const r of regimeDocs) regimeMap[r.weekOf] = r;

  // Slope falling map
  const regimeWeeks = Object.keys(regimeMap).sort();
  const slopeFallingMap = {};
  for (let i = 0; i < regimeWeeks.length; i++) {
    const w = regimeWeeks[i];
    const r = regimeMap[w];
    slopeFallingMap[w] = {};
    for (const idx of ['SPY', 'QQQ']) {
      const idxKey = idx.toLowerCase();
      const cur = r[idxKey];
      if (!cur || cur.emaSlope >= 0) { slopeFallingMap[w][idx] = false; continue; }
      if (i > 0) {
        const prev = regimeMap[regimeWeeks[i - 1]]?.[idxKey];
        slopeFallingMap[w][idx] = prev && prev.emaSlope < 0;
      } else {
        slopeFallingMap[w][idx] = false;
      }
    }
  }

  // Sector EMA
  const sectorEmaByWeek = {};
  for (const s of rawSignals) {
    if (!sectorEmaByWeek[s.weekOf]) sectorEmaByWeek[s.weekOf] = {};
    const etf = SECTOR_MAP[s.sector];
    if (!etf) continue;
    if (!sectorEmaByWeek[s.weekOf][etf]) sectorEmaByWeek[s.weekOf][etf] = { blAligned: false, ssAligned: false };
    if ((s.analyzeComponents?.t1d ?? 0) > 0) {
      if (s.signal === 'BL') sectorEmaByWeek[s.weekOf][etf].blAligned = true;
      else sectorEmaByWeek[s.weekOf][etf].ssAligned = true;
    }
  }

  // Sector 5D momentum
  const sectorDailyMap = {};
  for (const etf of ALL_SECTOR_ETFS) {
    const doc = await candleCol.findOne({ ticker: etf });
    if (doc?.daily) sectorDailyMap[etf] = [...doc.daily].sort((a, b) => a.date > b.date ? 1 : -1);
  }
  const sector5dMap = {};
  for (const friday of allWeeks) {
    sector5dMap[friday] = {};
    for (const etf of ALL_SECTOR_ETFS) {
      const daily = sectorDailyMap[etf];
      if (!daily) continue;
      let fi = -1;
      for (let i = daily.length - 1; i >= 0; i--) {
        if (daily[i].date <= friday) { fi = i; break; }
      }
      if (fi < 5) continue;
      const cur = daily[fi].close, prev = daily[fi - 5].close;
      if (prev > 0) sector5dMap[friday][etf] = parseFloat(((cur - prev) / prev * 100).toFixed(2));
    }
  }

  // Candle data
  console.log('Loading candle data...');
  const allCandles = await candleCol.find({}).toArray();
  const candleMap = {}, weeklyMap = {}, atrMap = {};
  for (const doc of allCandles) {
    candleMap[doc.ticker] = [...doc.daily].sort((a, b) => a.date > b.date ? 1 : -1);
    const weekly = aggregateWeeklyBars(doc.daily, { includeVolume: false });
    weeklyMap[doc.ticker] = weekly;
    atrMap[doc.ticker] = computeWilderATR(weekly);
  }
  console.log(`  ${Object.keys(candleMap).length} tickers loaded\n`);

  // ── Run simulation ────────────────────────────────────────────────────────
  const openPositions = new Map();
  const closedTrades = [];

  for (let wi = 0; wi < allWeeks.length; wi++) {
    const friday = allWeeks[wi];
    const nextFriday = wi < allWeeks.length - 1 ? allWeeks[wi + 1] : '9999-12-31';
    const regime = regimeMap[friday];

    // ── Exit checks ──
    for (const [ticker, pos] of openPositions) {
      const daily = candleMap[ticker];
      if (!daily) continue;
      const weekly = weeklyMap[ticker];
      const atrArr = atrMap[ticker];

      for (const bar of daily) {
        if (bar.date <= pos.lastCheckedDate) continue;
        if (bar.date > friday) break;  // single-lot: only check within this week

        pos.tradingDays++;
        pos.lastCheckedDate = bar.date;

        // MFE/MAE
        const refPrice = pos.entryPrice;
        if (pos.signal === 'BL') {
          pos.maxFavorable = Math.max(pos.maxFavorable || 0, (bar.high - refPrice) / refPrice * 100);
          pos.maxAdverse = Math.min(pos.maxAdverse || 0, (bar.low - refPrice) / refPrice * 100);
        } else {
          pos.maxFavorable = Math.max(pos.maxFavorable || 0, (refPrice - bar.low) / refPrice * 100);
          pos.maxAdverse = Math.min(pos.maxAdverse || 0, (refPrice - bar.high) / refPrice * 100);
        }

        // Weekly stop ratchet
        const barD = new Date(bar.date + 'T12:00:00');
        const barDow = barD.getDay();
        const daysToMon = barDow === 0 ? -6 : 1 - barDow;
        const barMonday = new Date(barD);
        barMonday.setDate(barD.getDate() + daysToMon);
        const barMondayStr = barMonday.toISOString().split('T')[0];
        const weekIdx = weekly.findIndex(b => b.weekStart === barMondayStr);

        if (weekIdx > pos.currentWeekIdx && weekIdx >= 3) {
          pos.currentWeekIdx = weekIdx;
          const prev1 = weekly[weekIdx - 1];
          const prev2 = weekly[weekIdx - 2];
          const twoWeekHigh = Math.max(prev1.high, prev2.high);
          const twoWeekLow = Math.min(prev1.low, prev2.low);
          const prevAtr = atrArr[weekIdx - 1];

          if (prevAtr != null) {
            if (pos.signal === 'BL') {
              const candidate = Math.max(parseFloat((twoWeekLow - 0.01).toFixed(2)), parseFloat((prev1.close - prevAtr).toFixed(2)));
              pos.stop = parseFloat(Math.max(pos.stop, candidate).toFixed(2));
            } else {
              const candidate = Math.min(parseFloat((twoWeekHigh + 0.01).toFixed(2)), parseFloat((prev1.close + prevAtr).toFixed(2)));
              pos.stop = parseFloat(Math.min(pos.stop, candidate).toFixed(2));
            }
          }

          const weekBar = weekly[weekIdx];
          if (weekBar) {
            if (pos.signal === 'BL' && weekBar.low < twoWeekLow) {
              closePosition(pos, bar.date, pos.stop, 'SIGNAL_BE');
              break;
            }
            if (pos.signal === 'SS' && weekBar.high > twoWeekHigh) {
              closePosition(pos, bar.date, pos.stop, 'SIGNAL_SE');
              break;
            }
          }
        }

        if (pos.signal === 'BL' && bar.low <= pos.stop) {
          closePosition(pos, bar.date, pos.stop, 'STOP_HIT');
          break;
        }
        if (pos.signal === 'SS' && bar.high >= pos.stop) {
          closePosition(pos, bar.date, pos.stop, 'STOP_HIT');
          break;
        }

        if (pos.tradingDays >= 20) {
          const pnl = pos.signal === 'BL'
            ? (bar.close - pos.entryPrice) / pos.entryPrice * 100
            : (pos.entryPrice - bar.close) / pos.entryPrice * 100;
          if (pnl < 0) {
            closePosition(pos, bar.date, bar.close, 'STALE_HUNT');
            break;
          }
        }
      }
    }

    // Remove closed
    for (const [ticker, pos] of openPositions) {
      if (pos.closed) { closedTrades.push(pos); openPositions.delete(ticker); }
    }

    // ── Select entries (NEW_ASYM_SS config) ──
    const weekScores = scoresByWeek[friday] || [];
    if (weekScores.length === 0) continue;

    let pool = weekScores.filter(s => !s.overextended && s.signal && s.entryPrice > 0);

    // MACRO gate (direction-index routing: membership-based per v22 policy)
    if (regime) {
      pool = pool.filter(s => {
        const idxTicker = getDirectionIndexForTicker(s.ticker, friday);
        const idxKey = idxTicker.toLowerCase();
        const idx = regime[idxKey];
        if (!idx) return false;
        if (s.signal === 'BL') return idx.aboveEma;
        else return !idx.aboveEma;
      });
    }

    // SECTOR gate
    const sectorEma = sectorEmaByWeek[friday] || {};
    pool = pool.filter(s => {
      const etf = SECTOR_MAP[s.sector];
      if (!etf || !sectorEma[etf]) return true;
      if (s.signal === 'BL') return sectorEma[etf].blAligned;
      else return sectorEma[etf].ssAligned;
    });

    // D2 gate
    pool = pool.filter(s => (s.scores?.d2 ?? 0) >= 0);

    // SS crash gate (direction-index routing: membership-based per v22 policy)
    pool = pool.filter(s => {
      if (s.signal !== 'SS') return true;
      const idxTicker = getDirectionIndexForTicker(s.ticker, friday);
      const slopeOk = slopeFallingMap[friday]?.[idxTicker] ?? false;
      if (!slopeOk) return false;
      const etf = SECTOR_MAP[s.sector];
      const sect5d = sector5dMap[friday]?.[etf] ?? 0;
      if (sect5d > -3) return false;
      return true;
    });

    // Re-rank by Kill score
    pool.sort((a, b) => b.apexScore - a.apexScore);
    let fRank = 0;
    for (const s of pool) { fRank++; s.filteredRank = fRank; }

    // Top 10 BL + top 5 SS
    const blPool = pool.filter(s => s.signal === 'BL').slice(0, 10);
    const ssPool = pool.filter(s => s.signal === 'SS').slice(0, 5);
    pool = [...blPool, ...ssPool];

    // ── Enter positions ──
    for (const score of pool) {
      const ticker = score.ticker;
      if (openPositions.has(ticker)) continue;

      const sig = signalMap[friday + '|' + ticker];
      const entryPrice = sig?.entryPrice || score.entryPrice;
      const stopPrice = sig?.stopPrice || score.stopPrice;
      if (!entryPrice || entryPrice <= 0) continue;

      const weekly = weeklyMap[ticker];
      if (!weekly) continue;

      const fd = new Date(friday + 'T12:00:00');
      fd.setDate(fd.getDate() - 4);
      const monday = fd.toISOString().split('T')[0];
      const entryBi = weekly.findIndex(b => b.weekStart === monday);
      if (entryBi < 3) continue;

      openPositions.set(ticker, {
        ticker,
        signal: score.signal,
        sector: score.sector,
        exchange: score.exchange,
        weekOf: friday,
        entryDate: friday,
        entryPrice,
        stop: stopPrice || entryPrice * (score.signal === 'BL' ? 0.95 : 1.05),
        tradingDays: 0,
        maxFavorable: 0,
        maxAdverse: 0,
        currentWeekIdx: entryBi,
        lastCheckedDate: friday,
        closed: false,
        killRank: score.killRank,
        filteredRank: score.filteredRank,
        apexScore: score.apexScore,
      });
    }
  }

  // Close remaining open positions
  for (const [ticker, pos] of openPositions) {
    const daily = candleMap[ticker];
    if (daily?.length > 0) {
      const last = daily[daily.length - 1];
      closePosition(pos, last.date, last.close, 'STILL_OPEN');
    }
    closedTrades.push(pos);
  }

  // ── Output ────────────────────────────────────────────────────────────────
  const closed = closedTrades.filter(t => t.exitReason !== 'STILL_OPEN');
  const stillOpen = closedTrades.filter(t => t.exitReason === 'STILL_OPEN');

  // Sort by entry date
  closed.sort((a, b) => a.entryDate.localeCompare(b.entryDate));

  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('  PNTHR ORDERS BACKTEST — FULL TRADE LOG');
  console.log('  Config: NEW_ASYM_SS (BL top 10 + SS crash top 5, single lot per trade)');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════\n');

  // ── BL Trades ──
  const blTrades = closed.filter(t => t.signal === 'BL');
  const ssTrades = closed.filter(t => t.signal === 'SS');

  console.log(`── BUY LONG TRADES (${blTrades.length}) ──────────────────────────────────────────────────────────\n`);
  console.log('  #   Ticker   Entry Date   Entry $    Exit Date    Exit $     P&L %    $ P&L     Lots  Exit Reason      Sector');
  console.log('  ──  ───────  ──────────   ────────   ──────────   ────────   ──────   ────────  ────  ──────────────   ─────────────────');

  blTrades.forEach((t, i) => {
    const pnlStr = (t.profitPct >= 0 ? '+' : '') + t.profitPct.toFixed(2) + '%';
    const dollarStr = (t.dollarPnl >= 0 ? '+$' : '-$') + Math.abs(t.dollarPnl).toFixed(0);
    console.log(
      `  ${String(i + 1).padStart(3)}  ` +
      `${t.ticker.padEnd(7)}  ` +
      `${t.entryDate}   ` +
      `$${t.entryPrice.toFixed(2).padStart(7)}   ` +
      `${t.exitDate}   ` +
      `$${t.exitPrice.toFixed(2).padStart(7)}   ` +
      `${pnlStr.padStart(7)}   ` +
      `${dollarStr.padStart(7)}  ` +
      `${String(t.maxLots).padStart(4)}  ` +
      `${t.exitReason.padEnd(15)}  ` +
      `${(t.sector || '').slice(0, 20)}`
    );
  });

  console.log(`\n── SELL SHORT TRADES (${ssTrades.length}) ──────────────────────────────────────────────────────────\n`);
  console.log('  #   Ticker   Entry Date   Entry $    Exit Date    Exit $     P&L %    $ P&L     Lots  Exit Reason      Sector');
  console.log('  ──  ───────  ──────────   ────────   ──────────   ────────   ──────   ────────  ────  ──────────────   ─────────────────');

  ssTrades.forEach((t, i) => {
    const pnlStr = (t.profitPct >= 0 ? '+' : '') + t.profitPct.toFixed(2) + '%';
    const dollarStr = (t.dollarPnl >= 0 ? '+$' : '-$') + Math.abs(t.dollarPnl).toFixed(0);
    console.log(
      `  ${String(i + 1).padStart(3)}  ` +
      `${t.ticker.padEnd(7)}  ` +
      `${t.entryDate}   ` +
      `$${t.entryPrice.toFixed(2).padStart(7)}   ` +
      `${t.exitDate}   ` +
      `$${t.exitPrice.toFixed(2).padStart(7)}   ` +
      `${pnlStr.padStart(7)}   ` +
      `${dollarStr.padStart(7)}  ` +
      `${String(t.maxLots).padStart(4)}  ` +
      `${t.exitReason.padEnd(15)}  ` +
      `${(t.sector || '').slice(0, 20)}`
    );
  });

  // ── Summary Stats ──
  const winners = closed.filter(t => t.isWinner);
  const losers = closed.filter(t => !t.isWinner);
  const totalDollarPnl = closed.reduce((s, t) => s + (t.dollarPnl || 0), 0);
  const dollarWon = closed.filter(t => (t.dollarPnl || 0) > 0).reduce((s, t) => s + t.dollarPnl, 0);
  const dollarLost = Math.abs(closed.filter(t => (t.dollarPnl || 0) < 0).reduce((s, t) => s + t.dollarPnl, 0));
  const avgPnl = closed.reduce((s, t) => s + t.profitPct, 0) / closed.length;
  const avgWin = winners.length > 0 ? winners.reduce((s, t) => s + t.profitPct, 0) / winners.length : 0;
  const avgLoss = losers.length > 0 ? losers.reduce((s, t) => s + t.profitPct, 0) / losers.length : 0;

  console.log('\n═══════════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════\n');

  console.log(`  Total trades:        ${closed.length} (${blTrades.length} BL + ${ssTrades.length} SS)`);
  console.log(`  Win rate:            ${(winners.length / closed.length * 100).toFixed(1)}%  (${winners.length}W / ${losers.length}L)`);
  console.log(`  Avg P&L per trade:   ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(2)}%`);
  console.log(`  Avg winner:          +${avgWin.toFixed(2)}%`);
  console.log(`  Avg loser:           ${avgLoss.toFixed(2)}%`);
  console.log(`  W/L ratio:           ${(avgWin / Math.abs(avgLoss)).toFixed(2)}:1`);
  console.log(`  Total return:        +${closed.reduce((s, t) => s + t.profitPct, 0).toFixed(0)}%`);
  console.log(`  Est. $ P&L ($10K):   $${totalDollarPnl.toLocaleString()}`);
  console.log(`  Still open:          ${stillOpen.length}`);

  // By year
  console.log('\n  ── Year-by-Year ──\n');
  console.log('  Year   Trades  Win%     Avg P&L   $ P&L');
  console.log('  ────   ──────  ──────   ────────  ──────────');
  const byYear = {};
  for (const t of closed) {
    const y = t.weekOf.slice(0, 4);
    if (!byYear[y]) byYear[y] = { trades: 0, winners: 0, totalPct: 0, totalDollar: 0 };
    byYear[y].trades++;
    if (t.isWinner) byYear[y].winners++;
    byYear[y].totalPct += t.profitPct;
    byYear[y].totalDollar += t.dollarPnl || 0;
  }
  for (const year of Object.keys(byYear).sort()) {
    const y = byYear[year];
    const wr = (y.winners / y.trades * 100).toFixed(1);
    const avg = (y.totalPct / y.trades).toFixed(2);
    console.log(
      `  ${year}   ${String(y.trades).padStart(6)}  ${wr.padStart(5)}%   ` +
      `${(parseFloat(avg) >= 0 ? '+' : '') + avg}%`.padStart(8) + `  $${y.totalDollar.toFixed(0).padStart(9)}`
    );
  }

  // By exit reason
  console.log('\n  ── By Exit Reason ──\n');
  const byReason = {};
  for (const t of closed) {
    if (!byReason[t.exitReason]) byReason[t.exitReason] = { count: 0, wins: 0, totalPct: 0, totalDollar: 0 };
    byReason[t.exitReason].count++;
    if (t.isWinner) byReason[t.exitReason].wins++;
    byReason[t.exitReason].totalPct += t.profitPct;
    byReason[t.exitReason].totalDollar += t.dollarPnl || 0;
  }
  console.log('  Reason          Trades  Win%    Avg P&L    $ P&L');
  console.log('  ──────────────  ──────  ──────  ────────   ──────────');
  for (const [reason, d] of Object.entries(byReason).sort((a, b) => b[1].count - a[1].count)) {
    const wr = (d.wins / d.count * 100).toFixed(1);
    const avg = (d.totalPct / d.count).toFixed(2);
    console.log(
      `  ${reason.padEnd(16)}${String(d.count).padStart(6)}  ${wr.padStart(5)}%  ` +
      `${(parseFloat(avg) >= 0 ? '+' : '') + avg}%`.padStart(8) + `   $${d.totalDollar.toFixed(0).padStart(9)}`
    );
  }

  // ── Apply friction costs to every trade ──────────────────────────────────
  // Derives share count from LOT_SIZE_USD / entryPrice, then calculates
  // commission (IBKR Pro Fixed), slippage (5 bps/leg), and borrow cost
  // (SS trades only, sector-tiered). See costEngine.js for full methodology.
  const tradeDocs = closed.map(t => {
    const shares = sharesFromLot(t.entryPrice);
    const costs  = calcTradeCosts({
      signal:      t.signal,
      sector:      t.sector,
      entryPrice:  t.entryPrice,
      exitPrice:   t.exitPrice,
      shares,
      tradingDays: t.tradingDays,
      dollarPnl:   t.dollarPnl,
      profitPct:   t.profitPct,
    });

    // R-multiple: net P&L / initial risk per share
    // Initial risk = |entryPrice - stopPrice| × shares
    // stopPrice was stored on the position; we approximate as 5% of entry for
    // legacy trades without stored stops (overridden by actual stop in live data)
    const rMultiple = null;  // computed in exportAuditLog.js with actual stops

    return {
      ticker:       t.ticker,
      signal:       t.signal,
      sector:       t.sector,
      exchange:     t.exchange,
      weekOf:       t.weekOf,
      entryDate:    t.entryDate,
      entryPrice:   t.entryPrice,
      exitDate:     t.exitDate,
      exitPrice:    t.exitPrice,
      tradingDays:  t.tradingDays,
      exitReason:   t.exitReason,
      maxLots:      t.maxLots,
      killRank:     t.killRank,
      filteredRank: t.filteredRank,
      apexScore:    t.apexScore,

      // MFE / MAE
      maxFavorable: parseFloat((t.maxFavorable || 0).toFixed(2)),
      maxAdverse:   parseFloat((t.maxAdverse  || 0).toFixed(2)),

      // Gross performance (before costs)
      shares,
      grossDollarPnl: t.dollarPnl,
      grossProfitPct: t.profitPct,
      isWinner:       t.isWinner,

      // Friction costs (from costEngine.js)
      ...costs,

      // Cost engine version for audit trail
      costEngineVersion: COST_METHODOLOGY.version,
      costEngineDate:    COST_METHODOLOGY.effectiveDate,
    };
  });

  // Store to MongoDB for UI access
  await db.collection('pnthr_bt_trade_log').deleteMany({});
  await db.collection('pnthr_bt_trade_log').insertMany(tradeDocs);
  console.log(`\n  Saved ${closed.length} trades to pnthr_bt_trade_log collection.`);

  // ── Friction cost summary ─────────────────────────────────────────────────
  const blDocs = tradeDocs.filter(t => t.signal === 'BL');
  const ssDocs = tradeDocs.filter(t => t.signal === 'SS');

  const sumFriction = (arr) => arr.reduce((s, t) => s + t.totalFrictionDollar, 0);
  const sumGross    = (arr) => arr.reduce((s, t) => s + t.grossDollarPnl, 0);
  const sumNet      = (arr) => arr.reduce((s, t) => s + t.netDollarPnl, 0);
  const netWinners  = (arr) => arr.filter(t => t.netIsWinner).length;

  console.log('\n  ── Friction Cost Summary ──\n');
  console.log('  Strategy   Trades  Gross $ P&L     Total Friction   Net $ P&L      CAGR Impact');
  console.log('  ─────────  ──────  ─────────────   ──────────────   ─────────────  ────────────');

  for (const [label, arr] of [['BL', blDocs], ['SS', ssDocs], ['COMBINED', tradeDocs]]) {
    if (arr.length === 0) continue;
    const gPnl   = sumGross(arr);
    const frict  = sumFriction(arr);
    const nPnl   = sumNet(arr);
    const nWr    = (netWinners(arr) / arr.length * 100).toFixed(1);
    const avgFrictPct = (frict / arr.length / LOT_SIZE_USD * 100).toFixed(3);
    console.log(
      `  ${label.padEnd(9)}  ${String(arr.length).padStart(6)}  ` +
      `$${gPnl.toFixed(0).padStart(11)}   ` +
      `$${frict.toFixed(0).padStart(11)} (${avgFrictPct}%/trade)   ` +
      `$${nPnl.toFixed(0).padStart(11)}  ` +
      `Net WR: ${nWr}%`
    );
  }

  console.log(`\n  Cost methodology: costEngine.js v${COST_METHODOLOGY.version} (${COST_METHODOLOGY.effectiveDate})`);
  console.log('  Commission: IBKR Pro Fixed | Slippage: 5 bps/leg | Borrow: sector-tiered ETB rate');

  console.log('\n═══════════════════════════════════════════════════════════════════════════════════════════════════\n');
  process.exit(0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
