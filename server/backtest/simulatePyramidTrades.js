// server/backtest/simulatePyramidTrades.js
// ── Pyramid Simulation on Validated Optimal Trades ─────────────────────────
//
// Reads: pnthr_bt_optimal_trades (1,676 validated single-lot trades)
//        pnthr_bt_candles (daily OHLCV, already cached)
// Writes: pnthr_bt_pyramid_trades (per-trade lot detail for $10M sim)
//
// Simulates lots 2-5 on top of each Lot 1 entry using:
//   - Percentage sizing: 35/25/20/12/8% of full position
//   - Trigger offsets: +3/6/10/14% from Lot 1 anchor
//   - 5-day time gate for Lot 2 only
//   - Stop ratchets: Lot 3→breakeven, Lot 4→Lot 2, Lot 5→Lot 3
//   - ATR weekly ratchet (from existing stop system)
//   - Exit: stop hit (ratcheted) or original signal exit date
//
// Usage:  cd server && node backtest/simulatePyramidTrades.js
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { connectToDatabase } from '../database.js';
import { aggregateWeeklyBars } from '../technicalUtils.js';
import { computeWilderATR } from '../stopCalculation.js';

// ── Lot System Constants (must match sizingUtils.js) ──────────────────────
const STRIKE_PCT    = [0.35, 0.25, 0.20, 0.12, 0.08];
const LOT_OFFSETS   = [0, 0.03, 0.06, 0.10, 0.14];
const LOT_TIME_GATE = [0, 5, 0, 0, 0];  // trading days since prior lot
const LOT_NAMES     = ['The Scent', 'The Stalk', 'The Strike', 'The Jugular', 'The Kill'];

// Position sizing: full position = $10K per trade (same as single-lot baseline)
// With pyramiding, Lot 1 = 35% = $3,500, full 5 lots = $10,000
const FULL_POSITION_USD = 10000;

// ── Helpers ────────────────────────────────────────────────────────────────

function getDailySlice(allDaily, fromDate, toDate) {
  // allDaily is sorted ascending by date
  return allDaily.filter(d => d.date >= fromDate && d.date <= toDate);
}

function computeWeeklyStop(weekly, atrArr, weekIdx, signal, currentStop) {
  if (weekIdx < 3 || !atrArr[weekIdx - 1]) return currentStop;
  const prev1 = weekly[weekIdx - 1];
  const prev2 = weekly[weekIdx - 2];
  const twoWeekHigh = Math.max(prev1.high, prev2.high);
  const twoWeekLow  = Math.min(prev1.low, prev2.low);
  const prevAtr = atrArr[weekIdx - 1];

  if (signal === 'BL') {
    const structStop = parseFloat((twoWeekLow - 0.01).toFixed(2));
    const atrFloor   = parseFloat((prev1.close - prevAtr).toFixed(2));
    const candidate  = Math.max(structStop, atrFloor);
    return parseFloat(Math.max(currentStop, candidate).toFixed(2));
  } else {
    const structStop = parseFloat((twoWeekHigh + 0.01).toFixed(2));
    const atrCeiling = parseFloat((prev1.close + prevAtr).toFixed(2));
    const candidate  = Math.min(structStop, atrCeiling);
    return parseFloat(Math.min(currentStop, candidate).toFixed(2));
  }
}

function getWeekMonday(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const dow = d.getDay();
  const daysToMon = dow === 0 ? -6 : 1 - dow;
  const mon = new Date(d);
  mon.setDate(d.getDate() + daysToMon);
  return mon.toISOString().split('T')[0];
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('Cannot connect to MongoDB'); process.exit(1); }

  const tradesCol  = db.collection('pnthr_bt_optimal_trades');
  const candleCol  = db.collection('pnthr_bt_candles');
  const outputCol  = db.collection('pnthr_bt_pyramid_trades');

  // ── Load trades ──
  const trades = await tradesCol.find({}).toArray();
  console.log(`\nLoaded ${trades.length} validated trades from pnthr_bt_optimal_trades`);

  // ── Load candle data ──
  console.log('Loading candle data...');
  const allCandles = await candleCol.find({}).toArray();
  const candleMap = {};
  const weeklyMap = {};
  const atrMap    = {};
  for (const doc of allCandles) {
    const sorted = [...doc.daily].sort((a, b) => a.date > b.date ? 1 : -1);
    candleMap[doc.ticker] = sorted;
    const weekly = aggregateWeeklyBars(doc.daily, { includeVolume: false });
    weeklyMap[doc.ticker] = weekly;
    atrMap[doc.ticker] = computeWilderATR(weekly);
  }
  console.log(`  ${Object.keys(candleMap).length} tickers loaded\n`);

  // ── Process each trade ──
  const results = [];
  let lotStats = { lot1Only: 0, lot2: 0, lot3: 0, lot4: 0, lot5: 0 };
  let exitChanged = 0;

  for (let ti = 0; ti < trades.length; ti++) {
    const trade = trades[ti];
    const daily = candleMap[trade.ticker];
    const weekly = weeklyMap[trade.ticker];
    const atrArr = atrMap[trade.ticker];

    if (!daily || !weekly) {
      console.warn(`  SKIP: no candle data for ${trade.ticker}`);
      continue;
    }

    const isLong = trade.signal === 'BL';
    const anchor = trade.entryPrice;

    // Calculate lot trigger prices from anchor
    const triggerPrices = LOT_OFFSETS.map((off, i) =>
      isLong
        ? parseFloat((anchor * (1 + off)).toFixed(2))
        : parseFloat((anchor * (1 - off)).toFixed(2))
    );

    // Calculate shares per lot based on full position sizing
    const fullShares = Math.floor(FULL_POSITION_USD / anchor);
    const lotShares = STRIKE_PCT.map(pct => Math.max(1, Math.round(fullShares * pct)));

    // Initialize position
    const lots = [{
      lot: 1,
      name: LOT_NAMES[0],
      pct: STRIKE_PCT[0],
      fillDate: trade.entryDate,
      fillPrice: anchor,
      triggerPrice: anchor,
      shares: lotShares[0],
      dollarInvested: parseFloat((lotShares[0] * anchor).toFixed(2)),
      tradingDaysSinceLot1: 0,
    }];

    let currentStop = trade.stop;
    let tradingDays = 0;
    let lastLotDay = 0;
    let totalShares = lotShares[0];
    let totalCost = lotShares[0] * anchor;
    let avgCost = anchor;
    let currentWeekIdx = -1;
    let pyramidExitDate = trade.exitDate;
    let pyramidExitPrice = trade.exitPrice;
    let pyramidExitReason = trade.exitReason;
    let exitWasChanged = false;
    let mfe = 0;  // max favorable excursion %
    let mae = 0;  // max adverse excursion %

    // Find entry week index
    const entryMonday = getWeekMonday(trade.entryDate);
    const entryWeekIdx = weekly.findIndex(b => b.weekStart === entryMonday);
    if (entryWeekIdx >= 0) currentWeekIdx = entryWeekIdx;

    // Get daily candles from entry to original exit (+ buffer for potential earlier exit)
    const slice = getDailySlice(daily, trade.entryDate, trade.exitDate);

    // Stop ratchet history for $10M sim
    const stopHistory = [{ date: trade.entryDate, stop: currentStop, reason: 'INITIAL' }];

    // Day-by-day walk
    let exited = false;
    for (const bar of slice) {
      if (bar.date <= trade.entryDate) continue; // skip entry day itself
      tradingDays++;

      // ── Weekly ATR stop ratchet ──
      const barMonday = getWeekMonday(bar.date);
      const weekIdx = weekly.findIndex(b => b.weekStart === barMonday);
      if (weekIdx > currentWeekIdx && weekIdx >= 3) {
        currentWeekIdx = weekIdx;
        const newStop = computeWeeklyStop(weekly, atrArr, weekIdx, trade.signal, currentStop);
        if (newStop !== currentStop) {
          currentStop = newStop;
          stopHistory.push({ date: bar.date, stop: currentStop, reason: 'ATR_RATCHET' });
        }
      }

      // ── Check stop hit FIRST (intraday, before lot adds) ──
      if (isLong && bar.low <= currentStop) {
        pyramidExitDate = bar.date;
        pyramidExitPrice = currentStop;
        pyramidExitReason = 'STOP_HIT';
        exitWasChanged = (bar.date !== trade.exitDate);
        exited = true;
        break;
      }
      if (!isLong && bar.high >= currentStop) {
        pyramidExitDate = bar.date;
        pyramidExitPrice = currentStop;
        pyramidExitReason = 'STOP_HIT';
        exitWasChanged = (bar.date !== trade.exitDate);
        exited = true;
        break;
      }

      // ── Check for lot additions ──
      const nextLotIdx = lots.length; // 0-based index for next lot (lots.length = number filled)
      if (nextLotIdx < 5) {
        const timeGateCleared = (tradingDays - lastLotDay) >= LOT_TIME_GATE[nextLotIdx];
        const trigger = triggerPrices[nextLotIdx];

        // Did price reach trigger? (high for longs, low for shorts)
        const triggerHit = isLong
          ? bar.high >= trigger
          : bar.low <= trigger;

        if (timeGateCleared && triggerHit) {
          const fillPrice = trigger; // fill at trigger price (limit order)
          const shares = lotShares[nextLotIdx];

          lots.push({
            lot: nextLotIdx + 1,
            name: LOT_NAMES[nextLotIdx],
            pct: STRIKE_PCT[nextLotIdx],
            fillDate: bar.date,
            fillPrice,
            triggerPrice: trigger,
            shares,
            dollarInvested: parseFloat((shares * fillPrice).toFixed(2)),
            tradingDaysSinceLot1: tradingDays,
          });

          totalShares += shares;
          totalCost += shares * fillPrice;
          avgCost = parseFloat((totalCost / totalShares).toFixed(4));
          lastLotDay = tradingDays;

          // ── Stop ratchet on lot fill ──
          const lotNum = nextLotIdx + 1;
          let ratchetStop = currentStop;

          if (lotNum === 2) {
            // Lot 2: ratchet to avg cost (breakeven)
            ratchetStop = parseFloat(avgCost.toFixed(2));
          } else if (lotNum === 3) {
            // Lot 3: ratchet to Lot 1 fill price
            ratchetStop = lots[0].fillPrice;
          } else if (lotNum === 4) {
            // Lot 4: ratchet to Lot 2 fill price
            ratchetStop = lots[1].fillPrice;
          } else if (lotNum === 5) {
            // Lot 5: ratchet to Lot 3 fill price
            ratchetStop = lots[2].fillPrice;
          }

          // Only ratchet if it tightens (up for longs, down for shorts)
          if (isLong && ratchetStop > currentStop) {
            currentStop = parseFloat(ratchetStop.toFixed(2));
            stopHistory.push({ date: bar.date, stop: currentStop, reason: `LOT${lotNum}_RATCHET` });
          } else if (!isLong && ratchetStop < currentStop) {
            currentStop = parseFloat(ratchetStop.toFixed(2));
            stopHistory.push({ date: bar.date, stop: currentStop, reason: `LOT${lotNum}_RATCHET` });
          }

          // Check if ratcheted stop is immediately hit by this same bar
          if (isLong && bar.low <= currentStop) {
            pyramidExitDate = bar.date;
            pyramidExitPrice = currentStop;
            pyramidExitReason = 'STOP_HIT';
            exitWasChanged = (bar.date !== trade.exitDate);
            exited = true;
            break;
          }
          if (!isLong && bar.high >= currentStop) {
            pyramidExitDate = bar.date;
            pyramidExitPrice = currentStop;
            pyramidExitReason = 'STOP_HIT';
            exitWasChanged = (bar.date !== trade.exitDate);
            exited = true;
            break;
          }
        }
      }

      // ── MFE/MAE tracking (based on avg cost) ──
      if (isLong) {
        mfe = Math.max(mfe, (bar.high - avgCost) / avgCost * 100);
        mae = Math.min(mae, (bar.low - avgCost) / avgCost * 100);
      } else {
        mfe = Math.max(mfe, (avgCost - bar.low) / avgCost * 100);
        mae = Math.min(mae, (avgCost - bar.high) / avgCost * 100);
      }
    }

    // If we didn't exit early, use original exit
    if (!exited) {
      pyramidExitDate = trade.exitDate;
      pyramidExitPrice = trade.exitPrice;
      pyramidExitReason = trade.exitReason;
    }

    // ── Compute final P&L ──
    let totalDollarPnl = 0;
    const lotDetails = lots.map(l => {
      let lotPnl, lotDollarPnl;
      if (isLong) {
        lotPnl = parseFloat(((pyramidExitPrice - l.fillPrice) / l.fillPrice * 100).toFixed(2));
        lotDollarPnl = parseFloat(((pyramidExitPrice - l.fillPrice) * l.shares).toFixed(2));
      } else {
        lotPnl = parseFloat(((l.fillPrice - pyramidExitPrice) / l.fillPrice * 100).toFixed(2));
        lotDollarPnl = parseFloat(((l.fillPrice - pyramidExitPrice) * l.shares).toFixed(2));
      }
      totalDollarPnl += lotDollarPnl;
      return { ...l, pnlPct: lotPnl, dollarPnl: lotDollarPnl };
    });

    const profitPct = isLong
      ? parseFloat(((pyramidExitPrice - avgCost) / avgCost * 100).toFixed(2))
      : parseFloat(((avgCost - pyramidExitPrice) / avgCost * 100).toFixed(2));

    const isWinner = totalDollarPnl > 0;
    if (exitWasChanged) exitChanged++;

    // Lot count stats
    const maxLots = lots.length;
    if (maxLots === 1) lotStats.lot1Only++;
    else if (maxLots === 2) lotStats.lot2++;
    else if (maxLots === 3) lotStats.lot3++;
    else if (maxLots === 4) lotStats.lot4++;
    else if (maxLots === 5) lotStats.lot5++;

    // Risk metrics for $10M simulation
    const riskPerShare = parseFloat(Math.abs(trade.entryPrice - trade.stop).toFixed(4));
    const initialDollarRisk = parseFloat((riskPerShare * lotShares[0]).toFixed(2));

    results.push({
      // Identity
      ticker: trade.ticker,
      signal: trade.signal,
      sector: trade.sector,
      exchange: trade.exchange,
      weekOf: trade.weekOf,
      optimized: trade.optimized,
      killRank: trade.killRank,

      // Original single-lot results (for comparison)
      original: {
        entryDate: trade.entryDate,
        entryPrice: trade.entryPrice,
        exitDate: trade.exitDate,
        exitPrice: trade.exitPrice,
        exitReason: trade.exitReason,
        profitPct: trade.profitPct,
        dollarPnl: trade.dollarPnl,
        stop: trade.stop,
      },

      // Pyramid results
      lotsFilledCount: lots.length,
      lots: lotDetails,
      totalShares,
      avgCost: parseFloat(avgCost.toFixed(4)),
      totalInvested: parseFloat(totalCost.toFixed(2)),
      pyramidExitDate,
      pyramidExitPrice,
      pyramidExitReason,
      pyramidProfitPct: profitPct,
      pyramidDollarPnl: parseFloat(totalDollarPnl.toFixed(2)),
      isWinner,
      finalStop: currentStop,
      stopHistory,
      exitChangedByPyramid: exitWasChanged,
      tradingDays,
      mfe: parseFloat(mfe.toFixed(2)),
      mae: parseFloat(mae.toFixed(2)),

      // Risk data for $10M simulation
      riskPerShare,
      initialDollarRisk,
      lot1Shares: lotShares[0],
      fullPositionShares: fullShares,
      lotSharesDistribution: lotShares,

      _persistedAt: new Date().toISOString(),
    });

    if ((ti + 1) % 200 === 0 || ti === trades.length - 1) {
      process.stdout.write(`\r  Processed ${ti + 1}/${trades.length} trades`);
    }
  }

  console.log('\n');

  // ── Persist to MongoDB ──
  console.log(`Persisting ${results.length} pyramid trades to pnthr_bt_pyramid_trades...`);
  await outputCol.deleteMany({});
  if (results.length > 0) {
    await outputCol.insertMany(results);
    await outputCol.createIndex({ ticker: 1 });
    await outputCol.createIndex({ signal: 1 });
  }
  console.log('  Done.\n');

  // ── Summary Report ──
  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log('  PNTHR PYRAMID SIMULATION — VALIDATED OPTIMAL TRADES');
  console.log(`  Full position: $${FULL_POSITION_USD} | Lots: ${STRIKE_PCT.map(p => p*100+'%').join('/')}`);
  console.log(`  Offsets: ${LOT_OFFSETS.map(o => o*100+'%').join('/')} | Time gate: Lot 2 = 5 days`);
  console.log('  Stop ratchet: Lot 2→avg cost, Lot 3→Lot 1, Lot 4→Lot 2, Lot 5→Lot 3');
  console.log('═══════════════════════════════════════════════════════════════════════════\n');

  // Lot distribution
  console.log('── Lot Fill Distribution ──\n');
  console.log(`  Lot 1 only:  ${lotStats.lot1Only} trades (${(lotStats.lot1Only/results.length*100).toFixed(1)}%)`);
  console.log(`  Lot 2 max:   ${lotStats.lot2} trades (${(lotStats.lot2/results.length*100).toFixed(1)}%)`);
  console.log(`  Lot 3 max:   ${lotStats.lot3} trades (${(lotStats.lot3/results.length*100).toFixed(1)}%)`);
  console.log(`  Lot 4 max:   ${lotStats.lot4} trades (${(lotStats.lot4/results.length*100).toFixed(1)}%)`);
  console.log(`  Lot 5 (full): ${lotStats.lot5} trades (${(lotStats.lot5/results.length*100).toFixed(1)}%)`);
  console.log(`  Exits changed by pyramid: ${exitChanged}`);

  // Comparison: Single-lot vs Pyramid
  console.log('\n── Single-Lot vs Pyramid — Overall ──\n');

  const blTrades = results.filter(t => t.signal === 'BL');
  const ssTrades = results.filter(t => t.signal === 'SS');

  for (const [label, subset] of [['ALL', results], ['BL', blTrades], ['SS', ssTrades]]) {
    if (subset.length === 0) continue;

    const origDollar = subset.reduce((s, t) => s + t.original.dollarPnl, 0);
    const pyrDollar  = subset.reduce((s, t) => s + t.pyramidDollarPnl, 0);
    const origWins   = subset.filter(t => t.original.dollarPnl > 0).length;
    const pyrWins    = subset.filter(t => t.isWinner).length;
    const origAvg    = subset.reduce((s, t) => s + t.original.profitPct, 0) / subset.length;
    const pyrAvg     = subset.reduce((s, t) => s + t.pyramidProfitPct, 0) / subset.length;
    const avgLots    = subset.reduce((s, t) => s + t.lotsFilledCount, 0) / subset.length;
    const origInvested = subset.reduce((s, t) => s + (Math.floor(FULL_POSITION_USD / t.original.entryPrice) * t.original.entryPrice * STRIKE_PCT[0]), 0);
    const pyrInvested  = subset.reduce((s, t) => s + t.totalInvested, 0);

    console.log(`  ${label} (${subset.length} trades):`);
    console.log(`    Single-lot:  ${origWins}W / ${subset.length - origWins}L  (${(origWins/subset.length*100).toFixed(1)}%)  avg P&L: ${origAvg >= 0 ? '+' : ''}${origAvg.toFixed(2)}%  total $: $${origDollar.toFixed(0)}`);
    console.log(`    Pyramid:     ${pyrWins}W / ${subset.length - pyrWins}L  (${(pyrWins/subset.length*100).toFixed(1)}%)  avg P&L: ${pyrAvg >= 0 ? '+' : ''}${pyrAvg.toFixed(2)}%  total $: $${pyrDollar.toFixed(0)}`);
    console.log(`    Avg lots:    ${avgLots.toFixed(2)}`);
    console.log(`    Capital deployed: single $${origInvested.toFixed(0)} vs pyramid $${pyrInvested.toFixed(0)}`);
    console.log(`    Dollar P&L delta: ${pyrDollar > origDollar ? '+' : ''}$${(pyrDollar - origDollar).toFixed(0)}`);
    console.log('');
  }

  // By lot count: how do multi-lot trades perform vs single-lot?
  console.log('── Performance by Lot Count ──\n');
  console.log('  Max Lot  Count   Win%    Avg P&L%   Avg $ PnL   Total $ PnL');
  for (let l = 1; l <= 5; l++) {
    const sub = results.filter(t => t.lotsFilledCount === l);
    if (sub.length === 0) continue;
    const wins = sub.filter(t => t.isWinner).length;
    const avgPnl = sub.reduce((s, t) => s + t.pyramidProfitPct, 0) / sub.length;
    const avgDollar = sub.reduce((s, t) => s + t.pyramidDollarPnl, 0) / sub.length;
    const totalDollar = sub.reduce((s, t) => s + t.pyramidDollarPnl, 0);
    console.log(
      `  ${l}        ${String(sub.length).padStart(5)}   ${(wins/sub.length*100).toFixed(1).padStart(5)}%  ` +
      `${(avgPnl >= 0 ? '+' : '') + avgPnl.toFixed(2) + '%'}`.padStart(10) + '  ' +
      `$${avgDollar.toFixed(0)}`.padStart(10) + '  ' +
      `$${totalDollar.toFixed(0)}`.padStart(12)
    );
  }

  // Year-by-year comparison
  console.log('\n── Year-by-Year: Single-Lot vs Pyramid Dollar P&L ──\n');
  const years = [...new Set(results.map(t => t.weekOf.slice(0, 4)))].sort();
  console.log('  Year   Trades  Single $     Pyramid $    Delta $     Avg Lots');
  console.log('  ────   ──────  ─────────    ─────────    ───────     ────────');
  for (const yr of years) {
    const sub = results.filter(t => t.weekOf.slice(0, 4) === yr);
    const origD = sub.reduce((s, t) => s + t.original.dollarPnl, 0);
    const pyrD  = sub.reduce((s, t) => s + t.pyramidDollarPnl, 0);
    const avgL  = sub.reduce((s, t) => s + t.lotsFilledCount, 0) / sub.length;
    console.log(
      `  ${yr}   ${String(sub.length).padStart(6)}  ` +
      `$${origD.toFixed(0)}`.padStart(9) + '    ' +
      `$${pyrD.toFixed(0)}`.padStart(9) + '    ' +
      `${pyrD > origD ? '+' : ''}$${(pyrD - origD).toFixed(0)}`.padStart(7) + '     ' +
      avgL.toFixed(2)
    );
  }

  // Monthly equity curve for hedge fund metrics
  console.log('\n── Monthly Equity Curve (Pyramid) ──\n');
  const monthlyPnl = {};
  for (const t of results) {
    const exitMonth = t.pyramidExitDate.slice(0, 7);
    if (!monthlyPnl[exitMonth]) monthlyPnl[exitMonth] = 0;
    monthlyPnl[exitMonth] += t.pyramidDollarPnl;
  }

  let equity = 100000; // starting capital
  const months = Object.keys(monthlyPnl).sort();
  let peak = equity;
  let maxDD = 0;
  let maxDDPeriod = '';
  let ddStart = months[0];
  let positiveMonths = 0;

  for (const m of months) {
    equity += monthlyPnl[m];
    const monthReturn = (monthlyPnl[m] / (equity - monthlyPnl[m])) * 100;
    if (monthReturn > 0) positiveMonths++;
    if (equity > peak) { peak = equity; ddStart = m; }
    const dd = (peak - equity) / peak * 100;
    if (dd > maxDD) { maxDD = dd; maxDDPeriod = `${ddStart} to ${m}`; }
  }

  const totalReturn = (equity - 100000) / 100000 * 100;
  const yearsSpan = months.length / 12;
  const cagr = (Math.pow(equity / 100000, 1 / yearsSpan) - 1) * 100;

  // Monthly returns for Sharpe/Sortino
  const monthlyReturns = months.map(m => {
    const pnl = monthlyPnl[m];
    // Approximate monthly equity at that point
    return pnl / 100000 * 100; // simplified % return on starting capital
  });
  const avgMonthly = monthlyReturns.reduce((s, r) => s + r, 0) / monthlyReturns.length;
  const stdDev = Math.sqrt(monthlyReturns.reduce((s, r) => s + (r - avgMonthly) ** 2, 0) / (monthlyReturns.length - 1));
  const riskFreeMonthly = 5 / 12; // 5% annual
  const excessReturns = monthlyReturns.map(r => r - riskFreeMonthly);
  const avgExcess = excessReturns.reduce((s, r) => s + r, 0) / excessReturns.length;
  const sharpe = stdDev > 0 ? (avgExcess / stdDev) * Math.sqrt(12) : 0;
  const downside = excessReturns.filter(r => r < 0);
  const downsideDev = downside.length > 0
    ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / downside.length) : 0.001;
  const sortino = (avgExcess / downsideDev) * Math.sqrt(12);
  const calmar = maxDD > 0 ? cagr / maxDD : 0;

  // Profit factor
  const totalWon = results.filter(t => t.pyramidDollarPnl > 0).reduce((s, t) => s + t.pyramidDollarPnl, 0);
  const totalLost = Math.abs(results.filter(t => t.pyramidDollarPnl < 0).reduce((s, t) => s + t.pyramidDollarPnl, 0));
  const profitFactor = totalLost > 0 ? totalWon / totalLost : Infinity;

  console.log(`  Starting capital:  $100,000`);
  console.log(`  Final equity:      $${equity.toFixed(0)}`);
  console.log(`  Total return:      +${totalReturn.toFixed(1)}%`);
  console.log(`  CAGR:              +${cagr.toFixed(1)}%`);
  console.log(`  Sharpe ratio:      ${sharpe.toFixed(2)}`);
  console.log(`  Sortino ratio:     ${sortino.toFixed(2)}`);
  console.log(`  Max drawdown:      -${maxDD.toFixed(2)}% (${maxDDPeriod})`);
  console.log(`  Calmar ratio:      ${calmar.toFixed(2)}`);
  console.log(`  Profit factor:     ${profitFactor.toFixed(2)}`);
  console.log(`  Positive months:   ${positiveMonths}/${months.length} (${(positiveMonths/months.length*100).toFixed(1)}%)`);
  console.log(`  Avg monthly:       +${avgMonthly.toFixed(2)}%`);
  console.log(`  Monthly std dev:   ${stdDev.toFixed(2)}%`);

  // Comparison with single-lot hedge fund metrics
  console.log('\n── SINGLE-LOT vs PYRAMID — Institutional Metrics ──\n');
  console.log('  Metric              Single-Lot    Pyramid       Delta');
  console.log('  ──────              ──────────    ───────       ─────');
  console.log(`  CAGR                +57.9%        +${cagr.toFixed(1)}%`);
  console.log(`  Sharpe              2.62          ${sharpe.toFixed(2)}`);
  console.log(`  Sortino             46.18         ${sortino.toFixed(2)}`);
  console.log(`  Max Drawdown        -1.18%        -${maxDD.toFixed(2)}%`);
  console.log(`  Calmar              49.06         ${calmar.toFixed(2)}`);
  console.log(`  Profit Factor       7.12          ${profitFactor.toFixed(2)}`);
  console.log(`  Positive Months     93.4%         ${(positiveMonths/months.length*100).toFixed(1)}%`);

  console.log('\n═══════════════════════════════════════════════════════════════════════════\n');
  process.exit(0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
