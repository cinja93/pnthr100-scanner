// server/backtest/simulatePyramiding.js
// ── Phase 3 Backtest: Pyramiding (Lots 1-5) ────────────────────────────────
//
// Builds on the asymmetric gates backtest by adding the lot system:
//   - Lot 1: Signal entry (same as Phase 2)
//   - Lots 2-5: Add on continued strength with time gates
//   - Stop ratchet on lot fills
//   - Dollar-weighted P&L tracking
//
// Tests multiple filter configs (best from Phase 1+2) WITH pyramiding
// to show how lot system changes win rate math.
//
// Reads: pnthr_bt_analyze_signals, pnthr_bt_scores, pnthr_bt_regime, pnthr_bt_candles
// Writes: pnthr_bt_pyramid_results
//
// Usage:  cd server && node backtest/simulatePyramiding.js
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { connectToDatabase } from '../database.js';
import { loadMembership, getDirectionIndexForTicker } from './backtestMembershipSets.js';
import { aggregateWeeklyBars, computeEMA21series } from '../technicalUtils.js';
import { computeWilderATR, blInitStop, ssInitStop } from '../stopCalculation.js';

const ALL_SECTOR_ETFS = ['XLK', 'XLE', 'XLV', 'XLF', 'XLY', 'XLC', 'XLI', 'XLB', 'XLRE', 'XLU', 'XLP'];
const SECTOR_MAP = {
  'Technology': 'XLK', 'Energy': 'XLE', 'Healthcare': 'XLV', 'Health Care': 'XLV',
  'Financial Services': 'XLF', 'Financials': 'XLF', 'Consumer Discretionary': 'XLY',
  'Communication Services': 'XLC', 'Industrials': 'XLI', 'Basic Materials': 'XLB',
  'Materials': 'XLB', 'Real Estate': 'XLRE', 'Utilities': 'XLU', 'Consumer Staples': 'XLP',
};

// ── Lot System Constants ────────────────────────────────────────────────────
const LOT_SIZE_USD = 10000;   // $10k per lot
const MAX_LOTS = 5;
const TIME_GATE_DAYS = 5;    // 5 trading days between lots
const LOT_TRIGGER_PCT = 1.0; // Position must be +1% profitable to add next lot

// ── Filter configs to test (best from asymmetric gates) ─────────────────────

function defineConfigs() {
  return [
    {
      name: 'BASELINE_PYRAMID',
      desc: 'All signals, no filters, with pyramiding',
      bl: {}, ss: {},
    },
    {
      name: 'D2_MACRO_SECTOR_PYR',
      desc: 'D2 + macro + sector alignment, with pyramiding',
      bl: { d2Min: 0, macroAligned: true, sectorAligned: true },
      ss: { d2Min: 0, macroAligned: true, sectorAligned: true },
    },
    {
      name: 'FULL_SYM_TOP10_PYR',
      desc: 'D2 + macro + sector + Kill top 10, with pyramiding',
      bl: { d2Min: 0, macroAligned: true, sectorAligned: true, maxKillRank: 10 },
      ss: { d2Min: 0, macroAligned: true, sectorAligned: true, maxKillRank: 10 },
    },
    {
      name: 'FULL_ASYM_A_PYR',
      desc: 'Asymmetric A + pyramiding (BL:top10+ana70 | SS:strict+top5+ana85)',
      bl: { d2Min: 0, macroAligned: true, sectorAligned: true, maxKillRank: 10, minAnalyze: 70 },
      ss: { d2Min: 0, macroAligned: true, sectorAligned: true, macroSlopeFalling: true, sectorMomentumMax: -1, maxKillRank: 5, minAnalyze: 85 },
    },
    {
      name: 'FULL_ASYM_B_PYR',
      desc: 'Asymmetric B + pyramiding (BL:top10+ana80 | SS:strict+top5+ana90)',
      bl: { d2Min: 0, macroAligned: true, sectorAligned: true, maxKillRank: 10, minAnalyze: 80 },
      ss: { d2Min: 0, macroAligned: true, sectorAligned: true, macroSlopeFalling: true, sectorMomentumMax: -1, maxKillRank: 5, minAnalyze: 90 },
    },
    {
      name: 'BL_ONLY_PYR',
      desc: 'BL only (D2+macro+sector+top10+ana70), no SS, with pyramiding',
      bl: { d2Min: 0, macroAligned: true, sectorAligned: true, maxKillRank: 10, minAnalyze: 70 },
      ss: { blocked: true },
    },
    {
      name: 'BL_LOOSE_PYR',
      desc: 'BL only (D2+macro+sector), no SS, with pyramiding',
      bl: { d2Min: 0, macroAligned: true, sectorAligned: true },
      ss: { blocked: true },
    },
  ];
}

function passesFilter(signal, filter) {
  if (filter.blocked) return false;
  if (filter.d2Min != null && (signal.d2 == null || signal.d2 < filter.d2Min)) return false;
  if (filter.macroAligned && !signal.macroAligned) return false;
  if (filter.sectorAligned && !signal.sectorAligned) return false;
  if (filter.macroSlopeFalling && !signal.macroSlopeFalling) return false;
  if (filter.sectorMomentumMax != null && (signal.sector5dMomentum == null || signal.sector5dMomentum > filter.sectorMomentumMax)) return false;
  if (filter.maxKillRank != null && (signal.killRank == null || signal.killRank > filter.maxKillRank)) return false;
  if (filter.minAnalyze != null && (signal.analyzePct == null || signal.analyzePct < filter.minAnalyze)) return false;
  return true;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('Cannot connect to MongoDB'); process.exit(1); }

  // Membership-based direction-index (v22 policy).
  await loadMembership(db);

  const signalCol = db.collection('pnthr_bt_analyze_signals');
  const scoreCol  = db.collection('pnthr_bt_scores');
  const regimeCol = db.collection('pnthr_bt_regime');
  const candleCol = db.collection('pnthr_bt_candles');
  const resultCol = db.collection('pnthr_bt_pyramid_results');

  await resultCol.deleteMany({});
  await resultCol.createIndex({ config: 1 }, { unique: true });

  // ── Load & enrich signals (same as asymmetric gates) ──────────────────────
  console.log('Loading signal data...');
  const rawSignals = await signalCol.find({}).toArray();
  console.log(`  ${rawSignals.length} signals loaded`);

  console.log('Loading Kill scores for D2...');
  const allScores = await scoreCol.find({}, {
    projection: { weekOf: 1, ticker: 1, 'scores.d2': 1 }
  }).toArray();
  const d2Map = {};
  for (const s of allScores) d2Map[s.weekOf + '|' + s.ticker] = s.scores?.d2 ?? null;

  console.log('Loading regime data...');
  const regimeDocs = await regimeCol.find({}).toArray();
  const regimeMap = {};
  for (const r of regimeDocs) regimeMap[r.weekOf] = r;

  // Build slope falling map
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

  // Sector 5D momentum
  console.log('Computing sector 5D momentum...');
  const sectorDailyMap = {};
  for (const etf of ALL_SECTOR_ETFS) {
    const doc = await candleCol.findOne({ ticker: etf });
    if (doc?.daily) sectorDailyMap[etf] = [...doc.daily].sort((a, b) => a.date > b.date ? 1 : -1);
  }
  const sector5dMap = {};
  for (const friday of regimeWeeks) {
    sector5dMap[friday] = {};
    for (const etf of ALL_SECTOR_ETFS) {
      const daily = sectorDailyMap[etf];
      if (!daily) continue;
      let fridayIdx = -1;
      for (let i = daily.length - 1; i >= 0; i--) {
        if (daily[i].date <= friday) { fridayIdx = i; break; }
      }
      if (fridayIdx < 5) continue;
      const close = daily[fridayIdx].close;
      const prev = daily[fridayIdx - 5].close;
      if (prev > 0) sector5dMap[friday][etf] = parseFloat(((close - prev) / prev * 100).toFixed(2));
    }
  }

  // Load candle data for trade simulation
  console.log('Loading candle data for trade simulation...');
  const allCandles = await candleCol.find({}).toArray();
  const candleMap = {}, weeklyMap = {}, atrMap = {};
  for (const doc of allCandles) {
    candleMap[doc.ticker] = [...doc.daily].sort((a, b) => a.date > b.date ? 1 : -1);
    const weekly = aggregateWeeklyBars(doc.daily, { includeVolume: false });
    weeklyMap[doc.ticker] = weekly;
    atrMap[doc.ticker] = computeWilderATR(weekly);
  }
  console.log(`  ${Object.keys(candleMap).length} tickers loaded`);

  // Enrich signals
  console.log('Enriching signals...');
  const signals = [];
  for (const sig of rawSignals) {
    const key = sig.weekOf + '|' + sig.ticker;
    const d2 = d2Map[key] ?? null;
    const regime = regimeMap[sig.weekOf];
    // Direction-index routing: membership-based per v22 policy
    const idxTicker = getDirectionIndexForTicker(sig.ticker, sig.weekOf);
    const idxKey = idxTicker.toLowerCase();
    const idxState = regime?.[idxKey];
    const macroAligned = idxState
      ? (sig.signal === 'BL' ? idxState.aboveEma : !idxState.aboveEma) : false;
    const slopeData = slopeFallingMap[sig.weekOf];
    const macroSlopeFalling = slopeData?.[idxTicker] ?? false;
    const sectorEtf = SECTOR_MAP[sig.sector];
    const sectorAligned = (sig.analyzeComponents?.t1d ?? 0) > 0;
    const sector5d = sector5dMap[sig.weekOf]?.[sectorEtf] ?? null;
    signals.push({ ...sig, d2, macroAligned, macroSlopeFalling, sectorAligned, sector5dMomentum: sector5d });
  }

  signals.sort((a, b) => a.weekOf < b.weekOf ? -1 : a.weekOf > b.weekOf ? 1 : 0);
  const allFridays = [...new Set(signals.map(s => s.weekOf))].sort();
  console.log(`\n  ${signals.length} enriched signals across ${allFridays.length} weeks\n`);

  // ── Run each configuration with pyramiding ────────────────────────────────
  const configs = defineConfigs();
  const allConfigResults = [];

  for (const config of configs) {
    process.stdout.write(`\n  Running ${config.name}...`);

    // openPositions: ticker → position object with lots array
    const openPositions = new Map();
    const closedTrades = [];

    // Walk through all trading days (not just Fridays) for lot additions
    // Collect all unique dates from daily candles
    const allDates = new Set();
    for (const friday of allFridays) {
      // Add all trading days up to and including this Friday
      // We process Friday-by-Friday for new entries, but daily for exits and lot additions
    }

    for (let fi = 0; fi < allFridays.length; fi++) {
      const friday = allFridays[fi];
      const nextFriday = fi < allFridays.length - 1 ? allFridays[fi + 1] : '9999-12-31';

      // ── Daily processing: exits + lot additions ──
      for (const [ticker, pos] of openPositions) {
        const daily = candleMap[ticker];
        if (!daily) continue;
        const weekly = weeklyMap[ticker];
        const atrArr = atrMap[ticker];

        for (const bar of daily) {
          if (bar.date <= pos.lastCheckedDate) continue;
          if (bar.date > nextFriday) break; // Process through next Friday

          pos.tradingDays++;
          pos.lastCheckedDate = bar.date;

          // Update current price on all lots
          pos.currentPrice = bar.close;

          // ── Check for lot additions ──
          if (pos.lots.length < MAX_LOTS) {
            const daysSinceLastLot = pos.tradingDays - pos.lastLotDay;
            if (daysSinceLastLot >= TIME_GATE_DAYS) {
              // Check if position is profitable enough to add
              const currentPnlPct = pos.signal === 'BL'
                ? (bar.close - pos.lots[pos.lots.length - 1].price) / pos.lots[pos.lots.length - 1].price * 100
                : (pos.lots[pos.lots.length - 1].price - bar.close) / pos.lots[pos.lots.length - 1].price * 100;

              if (currentPnlPct >= LOT_TRIGGER_PCT) {
                const lotNum = pos.lots.length + 1;
                const shares = Math.floor(LOT_SIZE_USD / bar.close);
                if (shares > 0) {
                  pos.lots.push({
                    num: lotNum,
                    price: bar.close,
                    shares,
                    date: bar.date,
                    day: pos.tradingDays,
                  });
                  pos.lastLotDay = pos.tradingDays;
                  pos.totalShares += shares;
                  pos.totalCost += shares * bar.close;
                  pos.avgCost = pos.totalCost / pos.totalShares;

                  // Stop ratchet on lot fill
                  if (lotNum === 3) {
                    // Lot 3 → stop to breakeven (Lot 1 price)
                    const beStop = pos.lots[0].price;
                    if (pos.signal === 'BL') {
                      pos.stop = Math.max(pos.stop, parseFloat(beStop.toFixed(2)));
                    } else {
                      pos.stop = Math.min(pos.stop, parseFloat(beStop.toFixed(2)));
                    }
                  } else if (lotNum === 4) {
                    // Lot 4 → stop to Lot 2 fill price
                    const lot2Stop = pos.lots[1].price;
                    if (pos.signal === 'BL') {
                      pos.stop = Math.max(pos.stop, parseFloat(lot2Stop.toFixed(2)));
                    } else {
                      pos.stop = Math.min(pos.stop, parseFloat(lot2Stop.toFixed(2)));
                    }
                  } else if (lotNum === 5) {
                    // Lot 5 → stop to Lot 3 fill price
                    const lot3Stop = pos.lots[2].price;
                    if (pos.signal === 'BL') {
                      pos.stop = Math.max(pos.stop, parseFloat(lot3Stop.toFixed(2)));
                    } else {
                      pos.stop = Math.min(pos.stop, parseFloat(lot3Stop.toFixed(2)));
                    }
                  }
                }
              }
            }
          }

          // MFE/MAE (based on average cost)
          if (pos.signal === 'BL') {
            pos.maxFavorable = Math.max(pos.maxFavorable, (bar.high - pos.avgCost) / pos.avgCost * 100);
            pos.maxAdverse = Math.min(pos.maxAdverse, (bar.low - pos.avgCost) / pos.avgCost * 100);
          } else {
            pos.maxFavorable = Math.max(pos.maxFavorable, (pos.avgCost - bar.low) / pos.avgCost * 100);
            pos.maxAdverse = Math.min(pos.maxAdverse, (pos.avgCost - bar.high) / pos.avgCost * 100);
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
                const structStop = parseFloat((twoWeekLow - 0.01).toFixed(2));
                const atrFloor = parseFloat((prev1.close - prevAtr).toFixed(2));
                const candidate = Math.max(structStop, atrFloor);
                pos.stop = parseFloat(Math.max(pos.stop, candidate).toFixed(2));
              } else {
                const structStop = parseFloat((twoWeekHigh + 0.01).toFixed(2));
                const atrCeiling = parseFloat((prev1.close + prevAtr).toFixed(2));
                const candidate = Math.min(structStop, atrCeiling);
                pos.stop = parseFloat(Math.min(pos.stop, candidate).toFixed(2));
              }
            }

            // BE/SE structural exit
            const weekBar = weekly[weekIdx];
            if (weekBar) {
              if (pos.signal === 'BL' && weekBar.low < twoWeekLow) {
                closePyramidPosition(pos, bar.date, pos.stop, 'SIGNAL_BE');
                break;
              }
              if (pos.signal === 'SS' && weekBar.high > twoWeekHigh) {
                closePyramidPosition(pos, bar.date, pos.stop, 'SIGNAL_SE');
                break;
              }
            }
          }

          // Daily stop hit
          if (pos.signal === 'BL' && bar.low <= pos.stop) {
            closePyramidPosition(pos, bar.date, pos.stop, 'STOP_HIT');
            break;
          }
          if (pos.signal === 'SS' && bar.high >= pos.stop) {
            closePyramidPosition(pos, bar.date, pos.stop, 'STOP_HIT');
            break;
          }

          // 20-day unprofitable (based on avg cost)
          if (pos.tradingDays >= 20) {
            const pnl = pos.signal === 'BL'
              ? (bar.close - pos.avgCost) / pos.avgCost * 100
              : (pos.avgCost - bar.close) / pos.avgCost * 100;
            if (pnl < 0) {
              closePyramidPosition(pos, bar.date, bar.close, 'STALE_HUNT');
              break;
            }
          }
        }
      }

      // Remove closed
      for (const [ticker, pos] of openPositions) {
        if (pos.closed) { closedTrades.push(pos); openPositions.delete(ticker); }
      }

      // ── Enter new signals ──
      const weekSignals = signals.filter(s => s.weekOf === friday);
      for (const sig of weekSignals) {
        if (openPositions.has(sig.ticker)) continue;
        if (!sig.entryPrice || sig.entryPrice <= 0) continue;
        if (sig.overextended) continue;

        const filter = sig.signal === 'BL' ? config.bl : config.ss;
        if (!passesFilter(sig, filter)) continue;

        const weekly = weeklyMap[sig.ticker];
        if (!weekly) continue;

        const fd = new Date(sig.weekOf + 'T12:00:00');
        fd.setDate(fd.getDate() - 4);
        const monday = fd.toISOString().split('T')[0];
        const entryBi = weekly.findIndex(b => b.weekStart === monday);
        if (entryBi < 3) continue;

        const lot1Shares = Math.floor(LOT_SIZE_USD / sig.entryPrice);
        if (lot1Shares <= 0) continue;

        openPositions.set(sig.ticker, {
          ticker: sig.ticker,
          signal: sig.signal,
          weekOf: sig.weekOf,
          entryDate: sig.weekOf,
          entryPrice: sig.entryPrice,
          avgCost: sig.entryPrice,
          stop: sig.stopPrice,
          tradingDays: 0,
          maxFavorable: 0,
          maxAdverse: 0,
          currentWeekIdx: entryBi,
          lastCheckedDate: sig.weekOf,
          closed: false,
          currentPrice: sig.entryPrice,
          // Lot tracking
          lots: [{
            num: 1,
            price: sig.entryPrice,
            shares: lot1Shares,
            date: sig.weekOf,
            day: 0,
          }],
          lastLotDay: 0,
          totalShares: lot1Shares,
          totalCost: lot1Shares * sig.entryPrice,
          // Metadata
          analyzePct: sig.analyzePct,
          killRank: sig.killRank,
          killConfirmed: sig.killConfirmed,
          d2: sig.d2,
          sector: sig.sector,
          exchange: sig.exchange,
        });
      }

      if (fi % 50 === 0) {
        const pct = Math.round((fi + 1) / allFridays.length * 100);
        process.stdout.write(`\r  ${config.name}: ${friday} — open: ${openPositions.size}, closed: ${closedTrades.length} | ${pct}%`);
      }
    }

    // Close remaining at last price
    for (const [ticker, pos] of openPositions) {
      const daily = candleMap[ticker];
      if (daily?.length > 0) {
        closePyramidPosition(pos, daily[daily.length - 1].date, daily[daily.length - 1].close, 'STILL_OPEN');
      }
      closedTrades.push(pos);
    }

    // ── Compute results ──
    const closed = closedTrades.filter(t => t.exitReason !== 'STILL_OPEN');

    // Trade-count metrics
    const winners = closed.filter(t => t.isWinner);
    const losers = closed.filter(t => !t.isWinner);
    const tradeWinRate = closed.length > 0 ? winners.length / closed.length * 100 : 0;
    const avgPnlPct = closed.length > 0 ? closed.reduce((s, t) => s + t.profitPct, 0) / closed.length : 0;

    // Dollar-weighted metrics
    const totalDollarsWon = closed.filter(t => t.dollarPnl > 0).reduce((s, t) => s + t.dollarPnl, 0);
    const totalDollarsLost = Math.abs(closed.filter(t => t.dollarPnl < 0).reduce((s, t) => s + t.dollarPnl, 0));
    const totalDollarsInvested = closed.reduce((s, t) => s + t.totalCost, 0);
    const dollarWinRate = totalDollarsInvested > 0
      ? totalDollarsWon / (totalDollarsWon + totalDollarsLost) * 100 : 0;
    const totalDollarPnl = totalDollarsWon - totalDollarsLost;
    const dollarROI = totalDollarsInvested > 0 ? totalDollarPnl / totalDollarsInvested * 100 : 0;

    // Lot distribution
    const lotDist = {};
    for (let l = 1; l <= MAX_LOTS; l++) lotDist[l] = { count: 0, winners: 0, totalPnl: 0, totalDollarPnl: 0 };
    for (const t of closed) {
      const maxLot = t.maxLots;
      if (lotDist[maxLot]) {
        lotDist[maxLot].count++;
        if (t.isWinner) lotDist[maxLot].winners++;
        lotDist[maxLot].totalPnl += t.profitPct;
        lotDist[maxLot].totalDollarPnl += t.dollarPnl;
      }
    }

    // Avg winner P&L with lots vs without (1-lot winners vs multi-lot)
    const singleLotWins = winners.filter(t => t.maxLots === 1);
    const multiLotWins = winners.filter(t => t.maxLots > 1);
    const singleLotLosses = losers.filter(t => t.maxLots === 1);
    const multiLotLosses = losers.filter(t => t.maxLots > 1);

    // By direction
    const byDir = {};
    for (const dir of ['BL', 'SS']) {
      const dt = closed.filter(t => t.signal === dir);
      const dw = dt.filter(t => t.isWinner);
      const dDollarWon = dt.filter(t => t.dollarPnl > 0).reduce((s, t) => s + t.dollarPnl, 0);
      const dDollarLost = Math.abs(dt.filter(t => t.dollarPnl < 0).reduce((s, t) => s + t.dollarPnl, 0));
      byDir[dir] = {
        trades: dt.length,
        winners: dw.length,
        winRate: dt.length > 0 ? parseFloat((dw.length / dt.length * 100).toFixed(1)) : 0,
        avgPnl: dt.length > 0 ? parseFloat((dt.reduce((s, t) => s + t.profitPct, 0) / dt.length).toFixed(2)) : 0,
        totalDollarPnl: parseFloat((dDollarWon - dDollarLost).toFixed(0)),
        dollarWinRate: (dDollarWon + dDollarLost) > 0 ? parseFloat((dDollarWon / (dDollarWon + dDollarLost) * 100).toFixed(1)) : 0,
        avgLots: dt.length > 0 ? parseFloat((dt.reduce((s, t) => s + t.maxLots, 0) / dt.length).toFixed(2)) : 0,
      };
    }

    // By year
    const byYear = {};
    for (const t of closed) {
      const y = t.weekOf.slice(0, 4);
      if (!byYear[y]) byYear[y] = { trades: 0, winners: 0, totalPnl: 0, totalDollarPnl: 0 };
      byYear[y].trades++;
      if (t.isWinner) byYear[y].winners++;
      byYear[y].totalPnl += t.profitPct;
      byYear[y].totalDollarPnl += t.dollarPnl;
    }

    const result = {
      config: config.name,
      desc: config.desc,
      closedTrades: closed.length,
      tradeWinRate: parseFloat(tradeWinRate.toFixed(1)),
      dollarWinRate: parseFloat(dollarWinRate.toFixed(1)),
      avgPnlPct: parseFloat(avgPnlPct.toFixed(2)),
      totalDollarPnl: parseFloat(totalDollarPnl.toFixed(0)),
      dollarROI: parseFloat(dollarROI.toFixed(2)),
      avgWinPct: winners.length > 0 ? parseFloat((winners.reduce((s, t) => s + t.profitPct, 0) / winners.length).toFixed(2)) : 0,
      avgLossPct: losers.length > 0 ? parseFloat((losers.reduce((s, t) => s + t.profitPct, 0) / losers.length).toFixed(2)) : 0,
      avgLotsPerTrade: closed.length > 0 ? parseFloat((closed.reduce((s, t) => s + t.maxLots, 0) / closed.length).toFixed(2)) : 0,
      avgLotsOnWinners: winners.length > 0 ? parseFloat((winners.reduce((s, t) => s + t.maxLots, 0) / winners.length).toFixed(2)) : 0,
      avgLotsOnLosers: losers.length > 0 ? parseFloat((losers.reduce((s, t) => s + t.maxLots, 0) / losers.length).toFixed(2)) : 0,
      lotDistribution: lotDist,
      singleLotWinners: singleLotWins.length,
      multiLotWinners: multiLotWins.length,
      avgMultiLotWinPct: multiLotWins.length > 0 ? parseFloat((multiLotWins.reduce((s, t) => s + t.profitPct, 0) / multiLotWins.length).toFixed(2)) : 0,
      avgMultiLotWinDollar: multiLotWins.length > 0 ? parseFloat((multiLotWins.reduce((s, t) => s + t.dollarPnl, 0) / multiLotWins.length).toFixed(0)) : 0,
      avgSingleLotLossDollar: singleLotLosses.length > 0 ? parseFloat((singleLotLosses.reduce((s, t) => s + t.dollarPnl, 0) / singleLotLosses.length).toFixed(0)) : 0,
      byDirection: byDir,
      byYear,
    };

    allConfigResults.push(result);
    await resultCol.updateOne({ config: config.name }, { $set: result }, { upsert: true });

    process.stdout.write(`\r  ${config.name}: ${closed.length} trades, trade win: ${tradeWinRate.toFixed(1)}%, dollar win: ${dollarWinRate.toFixed(1)}%, $${totalDollarPnl.toFixed(0)} total PnL\n`);
  }

  // ── Console Report ────────────────────────────────────────────────────────
  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('  PNTHR PHASE 3 BACKTEST — PYRAMIDING (LOTS 1-5)');
  console.log(`  Lot size: $${LOT_SIZE_USD} | Max lots: ${MAX_LOTS} | Time gate: ${TIME_GATE_DAYS} days | Trigger: +${LOT_TRIGGER_PCT}%`);
  console.log('  Entry: Signal price | Exit: BE/SE + Stop + 20-day stale');
  console.log('  Stop ratchet: Lot 3→breakeven, Lot 4→Lot 2, Lot 5→Lot 3');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════');

  // ── Main comparison: Trade Win Rate vs Dollar Win Rate ──
  console.log('\n── THE KEY INSIGHT: Trade Count vs Dollar-Weighted Win Rate ──\n');
  console.log('  Config                    Trades  Trade Win%  Dollar Win%  Avg Lots/Win  Avg Lots/Loss  Dollar P&L    ROI%');
  console.log('  ────────────────────────  ──────  ──────────  ───────────  ────────────  ─────────────  ──────────  ──────');

  for (const r of allConfigResults) {
    console.log(
      `  ${r.config.padEnd(26)}` +
      `${String(r.closedTrades).padStart(6)}  ` +
      `${r.tradeWinRate.toFixed(1).padStart(9)}%  ` +
      `${r.dollarWinRate.toFixed(1).padStart(10)}%  ` +
      `${r.avgLotsOnWinners.toFixed(2).padStart(12)}  ` +
      `${r.avgLotsOnLosers.toFixed(2).padStart(13)}  ` +
      `$${r.totalDollarPnl.toLocaleString()}`.padStart(10) + '  ' +
      `${r.dollarROI.toFixed(1)}%`.padStart(6)
    );
  }

  // ── Lot Distribution ──
  console.log('\n── Lot Distribution (how many lots per trade) ──\n');
  for (const r of allConfigResults) {
    console.log(`  ${r.config}:`);
    console.log('    Lots  Count   Win%    Avg P&L%   Dollar P&L');
    for (let l = 1; l <= MAX_LOTS; l++) {
      const d = r.lotDistribution[l];
      if (!d || d.count === 0) continue;
      const wr = (d.winners / d.count * 100).toFixed(1);
      const avg = (d.totalPnl / d.count).toFixed(2);
      console.log(
        `    ${l}     ${String(d.count).padStart(5)}   ${wr.padStart(5)}%  ` +
        `${(parseFloat(avg) >= 0 ? '+' : '') + avg}%`.padStart(9) + '  ' +
        `$${d.totalDollarPnl.toFixed(0)}`.padStart(10)
      );
    }
    console.log('');
  }

  // ── The Math: Why Pyramiding Changes Everything ──
  console.log('── The Pyramiding Math ──\n');
  for (const r of allConfigResults) {
    console.log(`  ${r.config}:`);
    console.log(`    Multi-lot winners:       ${r.multiLotWinners} trades, avg P&L: ${r.avgMultiLotWinPct >= 0 ? '+' : ''}${r.avgMultiLotWinPct}%, avg dollar: $${r.avgMultiLotWinDollar}`);
    console.log(`    Single-lot losers:       ${r.lotDistribution[1]?.count - r.lotDistribution[1]?.winners || 0} trades, avg dollar: $${r.avgSingleLotLossDollar}`);
    if (r.avgSingleLotLossDollar !== 0 && r.avgMultiLotWinDollar !== 0) {
      const payoffRatio = Math.abs(r.avgMultiLotWinDollar / r.avgSingleLotLossDollar);
      console.log(`    Payoff ratio:            1 multi-lot winner pays for ${payoffRatio.toFixed(1)} single-lot losers`);
    }
    console.log('');
  }

  // ── Direction Breakdown ──
  console.log('── BL vs SS with Pyramiding ──\n');
  console.log('  Config                    BL Trades  BL TrWin%  BL $Win%  BL $PnL     SS Trades  SS TrWin%  SS $Win%  SS $PnL');
  console.log('  ────────────────────────  ─────────  ─────────  ────────  ─────────   ─────────  ─────────  ────────  ─────────');

  for (const r of allConfigResults) {
    const bl = r.byDirection.BL || { trades: 0, winRate: 0, dollarWinRate: 0, totalDollarPnl: 0 };
    const ss = r.byDirection.SS || { trades: 0, winRate: 0, dollarWinRate: 0, totalDollarPnl: 0 };
    console.log(
      `  ${r.config.padEnd(26)}` +
      `${String(bl.trades).padStart(9)}  ` +
      `${bl.winRate.toFixed(1).padStart(8)}%  ` +
      `${bl.dollarWinRate.toFixed(1).padStart(7)}%  ` +
      `$${bl.totalDollarPnl.toLocaleString()}`.padStart(9) + '   ' +
      `${String(ss.trades).padStart(9)}  ` +
      `${ss.winRate.toFixed(1).padStart(8)}%  ` +
      `${ss.dollarWinRate.toFixed(1).padStart(7)}%  ` +
      `$${ss.totalDollarPnl.toLocaleString()}`.padStart(9)
    );
  }

  // ── Year-by-Year ──
  console.log('\n── Year-by-Year Dollar P&L ──\n');
  for (const r of allConfigResults) {
    console.log(`  ${r.config}:`);
    const years = Object.keys(r.byYear).sort();
    for (const year of years) {
      const y = r.byYear[year];
      const wr = y.trades > 0 ? (y.winners / y.trades * 100).toFixed(1) : '0.0';
      console.log(
        `    ${year}  ${String(y.trades).padStart(5)} trades  win: ${wr.padStart(5)}%  ` +
        `dollar P&L: $${y.totalDollarPnl.toFixed(0)}`
      );
    }
    console.log('');
  }

  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════\n');
  process.exit(0);
}

// ── Close pyramid position helper ───────────────────────────────────────────

function closePyramidPosition(pos, exitDate, exitPrice, exitReason) {
  pos.exitDate = exitDate;
  pos.exitPrice = exitPrice;
  pos.exitReason = exitReason;
  pos.maxLots = pos.lots.length;

  // Compute P&L per lot and total
  let totalDollarPnl = 0;
  for (const lot of pos.lots) {
    if (pos.signal === 'BL') {
      lot.pnl = parseFloat(((exitPrice - lot.price) / lot.price * 100).toFixed(2));
      lot.dollarPnl = parseFloat(((exitPrice - lot.price) * lot.shares).toFixed(2));
    } else {
      lot.pnl = parseFloat(((lot.price - exitPrice) / lot.price * 100).toFixed(2));
      lot.dollarPnl = parseFloat(((lot.price - exitPrice) * lot.shares).toFixed(2));
    }
    totalDollarPnl += lot.dollarPnl;
  }

  pos.dollarPnl = parseFloat(totalDollarPnl.toFixed(2));

  // % P&L based on average cost
  if (pos.signal === 'BL') {
    pos.profitPct = parseFloat(((exitPrice - pos.avgCost) / pos.avgCost * 100).toFixed(2));
  } else {
    pos.profitPct = parseFloat(((pos.avgCost - exitPrice) / pos.avgCost * 100).toFixed(2));
  }

  pos.isWinner = pos.dollarPnl > 0;
  pos.closed = true;
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
