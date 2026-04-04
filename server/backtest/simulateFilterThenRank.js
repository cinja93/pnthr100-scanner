// server/backtest/simulateFilterThenRank.js
// ── Backtest: Top-Down Filter → Re-Rank → Top N ────────────────────────────
//
// Models the user's correct top-down flow:
//   1. Start with full 679 PNTHR universe (all scored stocks for a given Friday)
//   2. MACRO gate: filter to direction-aligned stocks only
//   3. SECTOR gate: filter to sector-aligned stocks only
//   4. D2 gate: filter D2 < 0
//   5. Re-rank remaining stocks by apexScore
//   6. Take top N from this FILTERED pool
//   7. Enter at signal price, same 3 exit rules
//
// Compares against the old approach (rank all → top 10 → then filter)
// to show the impact of re-ranking after filtering.
//
// Also runs pyramiding (Lots 1-5) on the winning configs.
//
// Reads: pnthr_bt_scores, pnthr_bt_analyze_signals, pnthr_bt_regime, pnthr_bt_candles
// Writes: pnthr_bt_filter_rank_results
//
// Usage:  cd server && node backtest/simulateFilterThenRank.js
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { connectToDatabase } from '../database.js';
import { aggregateWeeklyBars } from '../technicalUtils.js';
import { computeWilderATR } from '../stopCalculation.js';

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
  pos.isWinner = pos.profitPct > 0;
  pos.closed = true;
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

  const scoreCol  = db.collection('pnthr_bt_scores');
  const signalCol = db.collection('pnthr_bt_analyze_signals');
  const regimeCol = db.collection('pnthr_bt_regime');
  const candleCol = db.collection('pnthr_bt_candles');
  const resultCol = db.collection('pnthr_bt_filter_rank_results');

  await resultCol.deleteMany({});
  await resultCol.createIndex({ config: 1 }, { unique: true });

  // ── Load all Kill scores ──────────────────────────────────────────────────
  console.log('Loading Kill scores...');
  const allScores = await scoreCol.find({}).toArray();
  // Index: weekOf → array of score docs
  const scoresByWeek = {};
  for (const s of allScores) {
    if (!scoresByWeek[s.weekOf]) scoresByWeek[s.weekOf] = [];
    scoresByWeek[s.weekOf].push(s);
  }
  const allWeeks = Object.keys(scoresByWeek).sort();
  console.log(`  ${allScores.length} scores across ${allWeeks.length} weeks`);

  // ── Load Analyze signals for entry prices + analyze scores ────────────────
  console.log('Loading Analyze signals...');
  const rawSignals = await signalCol.find({}).toArray();
  // Index: weekOf|ticker → signal doc
  const signalMap = {};
  for (const s of rawSignals) {
    signalMap[s.weekOf + '|' + s.ticker] = s;
  }
  console.log(`  ${rawSignals.length} signals indexed`);

  // ── Load regime data ──────────────────────────────────────────────────────
  console.log('Loading regime data...');
  const regimeDocs = await regimeCol.find({}).toArray();
  const regimeMap = {};
  for (const r of regimeDocs) regimeMap[r.weekOf] = r;

  // Build slope falling map (EMA falling 2+ consecutive weeks)
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

  // ── Sector EMA state from Analyze signals (t1d component) ─────────────────
  // Build a lookup: weekOf → sectorEtf → aligned (from any signal that week)
  console.log('Building sector EMA state...');
  const sectorEmaByWeek = {}; // weekOf → { XLK: { blAligned, ssAligned } }
  for (const s of rawSignals) {
    if (!sectorEmaByWeek[s.weekOf]) sectorEmaByWeek[s.weekOf] = {};
    const etf = SECTOR_MAP[s.sector];
    if (!etf) continue;
    if (!sectorEmaByWeek[s.weekOf][etf]) sectorEmaByWeek[s.weekOf][etf] = { blAligned: false, ssAligned: false };
    // t1d > 0 means sector is aligned with this signal's direction
    if ((s.analyzeComponents?.t1d ?? 0) > 0) {
      if (s.signal === 'BL') sectorEmaByWeek[s.weekOf][etf].blAligned = true;
      else sectorEmaByWeek[s.weekOf][etf].ssAligned = true;
    }
  }

  // ── Sector 5D momentum ───────────────────────────────────────────────────
  console.log('Computing sector 5D momentum...');
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

  // ── Load candle data for trade simulation ─────────────────────────────────
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

  // ── Define configurations ─────────────────────────────────────────────────
  const configs = [
    // Control: old approach (rank all → top 10 → then filter)
    {
      name: 'OLD_RANK_THEN_FILTER',
      desc: 'Current: rank all 679 → top 10 → filter by macro+sector+D2',
      mode: 'rank_then_filter',
      blTopN: 10, ssTopN: 10,
      d2Gate: true, macroGate: true, sectorGate: true,
      ssStrict: false,
    },

    // New: filter → re-rank → top 10
    {
      name: 'NEW_FILTER_RANK_TOP10',
      desc: 'New: macro+sector+D2 filter → re-rank → top 10',
      mode: 'filter_then_rank',
      blTopN: 10, ssTopN: 10,
      d2Gate: true, macroGate: true, sectorGate: true,
      ssStrict: false,
    },

    // New with asymmetric SS
    {
      name: 'NEW_ASYM_SS',
      desc: 'Filter→rank: BL top 10, SS crash mode top 5',
      mode: 'filter_then_rank',
      blTopN: 10, ssTopN: 5,
      d2Gate: true, macroGate: true, sectorGate: true,
      ssStrict: true, // macro slope falling + sector 5D < -3%
    },

    // New top 5 both directions
    {
      name: 'NEW_FILTER_RANK_TOP5',
      desc: 'Filter→rank: top 5 both directions',
      mode: 'filter_then_rank',
      blTopN: 5, ssTopN: 5,
      d2Gate: true, macroGate: true, sectorGate: true,
      ssStrict: false,
    },

    // New top 15 (more trades from filtered pool)
    {
      name: 'NEW_FILTER_RANK_TOP15',
      desc: 'Filter→rank: top 15 both directions',
      mode: 'filter_then_rank',
      blTopN: 15, ssTopN: 10,
      d2Gate: true, macroGate: true, sectorGate: true,
      ssStrict: false,
    },

    // New BL only
    {
      name: 'NEW_BL_ONLY_TOP10',
      desc: 'Filter→rank: BL only, top 10',
      mode: 'filter_then_rank',
      blTopN: 10, ssTopN: 0,
      d2Gate: true, macroGate: true, sectorGate: true,
      ssStrict: false,
    },

    // New: filter → rank → top 10, Analyze >= 70% for BL, >= 85% for SS
    {
      name: 'NEW_ASYM_ANALYZE',
      desc: 'Filter→rank: BL top10 ana>=70, SS crash top5 ana>=85',
      mode: 'filter_then_rank',
      blTopN: 10, ssTopN: 5,
      d2Gate: true, macroGate: true, sectorGate: true,
      ssStrict: true,
      blMinAnalyze: 70, ssMinAnalyze: 85,
    },

    // New: filter → rank → top 10, no Analyze gate (pure Kill ranking)
    {
      name: 'NEW_PURE_KILL_TOP10',
      desc: 'Filter→rank: pure Kill score, no Analyze gate',
      mode: 'filter_then_rank',
      blTopN: 10, ssTopN: 5,
      d2Gate: true, macroGate: true, sectorGate: true,
      ssStrict: true,
      blMinAnalyze: 0, ssMinAnalyze: 0,
    },
  ];

  // ── Run each config ─────────────────────────────────��─────────────────────
  const allResults = [];

  for (const config of configs) {
    console.log(`\n  Running ${config.name} (${config.desc})...`);

    // === WITHOUT PYRAMIDING ===
    const noPyrResult = runSimulation(config, allWeeks, scoresByWeek, signalMap, regimeMap, slopeFallingMap,
      sectorEmaByWeek, sector5dMap, candleMap, weeklyMap, atrMap, false);

    // === WITH PYRAMIDING ===
    const pyrResult = runSimulation(config, allWeeks, scoresByWeek, signalMap, regimeMap, slopeFallingMap,
      sectorEmaByWeek, sector5dMap, candleMap, weeklyMap, atrMap, true);

    const combined = {
      config: config.name,
      desc: config.desc,
      mode: config.mode,
      noPyramid: noPyrResult,
      withPyramid: pyrResult,
    };

    allResults.push(combined);
    await resultCol.updateOne({ config: config.name }, { $set: combined }, { upsert: true });

    console.log(
      `    No pyramid: ${noPyrResult.closedTrades} trades, ${noPyrResult.winRate}% win, ` +
      `${noPyrResult.avgPnl >= 0 ? '+' : ''}${noPyrResult.avgPnl}% avg`
    );
    console.log(
      `    Pyramid:    ${pyrResult.closedTrades} trades, trade ${pyrResult.tradeWinRate}% / dollar ${pyrResult.dollarWinRate}% win, ` +
      `$${pyrResult.totalDollarPnl.toLocaleString()} PnL`
    );
  }

  // ── Console Report ─────────────────────────────────���──────────────────────
  console.log('\n\n');
  console.log('═════════════════════════════════════════════════════════��═════════════════════════════════════════════');
  console.log('  PNTHR BACKTEST — FILTER THEN RANK vs RANK THEN FILTER');
  console.log('  The question: Does re-ranking AFTER macro/sector filtering improve the top 10?');
  console.log('════════════════════════════════════════════════════════════��══════════════════════════════════════════');

  // Without pyramiding
  console.log('\n── WITHOUT PYRAMIDING (single lot) ──\n');
  console.log('  Config                    Trades  Win%    Avg P&L   Avg Win   Avg Loss  W/L     Total Ret');
  console.log('  ────────────────────────  ──────  ──────  ────────  ────────  ────────  ──────  ─────────');
  for (const r of allResults) {
    const d = r.noPyramid;
    console.log(
      `  ${r.config.padEnd(26)}` +
      `${String(d.closedTrades).padStart(6)}  ` +
      `${d.winRate.toFixed(1).padStart(5)}%  ` +
      `${(d.avgPnl >= 0 ? '+' : '') + d.avgPnl.toFixed(2) + '%'}`.padStart(8) + '  ' +
      `+${d.avgWin.toFixed(2)}%`.padStart(8) + '  ' +
      `${d.avgLoss.toFixed(2)}%`.padStart(8) + '  ' +
      `${d.winLossRatio.toFixed(2)}`.padStart(6) + '  ' +
      `${(d.totalReturn >= 0 ? '+' : '') + d.totalReturn.toFixed(0) + '%'}`.padStart(9)
    );
  }

  // BL vs SS breakdown
  console.log('\n── BL vs SS WITHOUT PYRAMIDING ──\n');
  console.log('  Config                    BL Trades  BL Win%  BL Avg    SS Trades  SS Win%  SS Avg');
  console.log('  ────────────────────────  ─────────  ───────  ────────  ─────────  ───────  ────────');
  for (const r of allResults) {
    const bl = r.noPyramid.byDirection.BL || { trades: 0, winRate: 0, avgPnl: 0 };
    const ss = r.noPyramid.byDirection.SS || { trades: 0, winRate: 0, avgPnl: 0 };
    console.log(
      `  ${r.config.padEnd(26)}` +
      `${String(bl.trades).padStart(9)}  ` +
      `${bl.winRate.toFixed(1).padStart(6)}%  ` +
      `${(bl.avgPnl >= 0 ? '+' : '') + bl.avgPnl.toFixed(2) + '%'}`.padStart(8) + '  ' +
      `${String(ss.trades).padStart(9)}  ` +
      `${ss.winRate.toFixed(1).padStart(6)}%  ` +
      `${(ss.avgPnl >= 0 ? '+' : '') + ss.avgPnl.toFixed(2) + '%'}`.padStart(8)
    );
  }

  // With pyramiding
  console.log('\n── WITH PYRAMIDING (Lots 1-5) ──\n');
  console.log('  Config                    Trades  Trade Win%  Dollar Win%  Dollar P&L    ROI%    Avg Lots/Win  Avg Lots/Loss');
  console.log('  ────────────────────────  ──────  ──────────  ───────────  ──────────  ──────  ────────────  ─────────────');
  for (const r of allResults) {
    const d = r.withPyramid;
    console.log(
      `  ${r.config.padEnd(26)}` +
      `${String(d.closedTrades).padStart(6)}  ` +
      `${d.tradeWinRate.toFixed(1).padStart(9)}%  ` +
      `${d.dollarWinRate.toFixed(1).padStart(10)}%  ` +
      `$${d.totalDollarPnl.toLocaleString()}`.padStart(10) + '  ' +
      `${d.dollarROI.toFixed(1)}%`.padStart(6) + '  ' +
      `${d.avgLotsOnWinners.toFixed(2).padStart(12)}  ` +
      `${d.avgLotsOnLosers.toFixed(2).padStart(13)}`
    );
  }

  // Year-by-year for head-to-head
  console.log('\n── YEAR-BY-YEAR HEAD TO HEAD: Old vs New (no pyramid) ──\n');
  for (const configName of ['OLD_RANK_THEN_FILTER', 'NEW_FILTER_RANK_TOP10', 'NEW_ASYM_SS', 'NEW_ASYM_ANALYZE']) {
    const r = allResults.find(c => c.config === configName);
    if (!r) continue;
    console.log(`  ${r.config} — ${r.desc}:`);
    const years = Object.keys(r.noPyramid.byYear).sort();
    for (const year of years) {
      const y = r.noPyramid.byYear[year];
      const wr = y.trades > 0 ? (y.winners / y.trades * 100).toFixed(1) : '0.0';
      const avg = y.trades > 0 ? (y.totalPnl / y.trades).toFixed(2) : '0.00';
      console.log(
        `    ${year}  ${String(y.trades).padStart(5)} trades  win: ${wr.padStart(5)}%  ` +
        `avg: ${(parseFloat(avg) >= 0 ? '+' : '') + avg}%  total: ${(y.totalPnl >= 0 ? '+' : '') + y.totalPnl.toFixed(0)}%`
      );
    }
    console.log('');
  }

  // Year-by-year pyramiding
  console.log('── YEAR-BY-YEAR HEAD TO HEAD: Old vs New (with pyramid) ──\n');
  for (const configName of ['OLD_RANK_THEN_FILTER', 'NEW_FILTER_RANK_TOP10', 'NEW_ASYM_SS', 'NEW_ASYM_ANALYZE']) {
    const r = allResults.find(c => c.config === configName);
    if (!r) continue;
    console.log(`  ${r.config}:`);
    const years = Object.keys(r.withPyramid.byYear).sort();
    for (const year of years) {
      const y = r.withPyramid.byYear[year];
      const wr = y.trades > 0 ? (y.winners / y.trades * 100).toFixed(1) : '0.0';
      console.log(
        `    ${year}  ${String(y.trades).padStart(5)} trades  win: ${wr.padStart(5)}%  ` +
        `dollar P&L: $${y.totalDollarPnl.toFixed(0)}`
      );
    }
    console.log('');
  }

  // The delta
  console.log('── THE DELTA: Filter→Rank vs Rank→Filter ──\n');
  const oldNP = allResults.find(c => c.config === 'OLD_RANK_THEN_FILTER')?.noPyramid;
  const newNP = allResults.find(c => c.config === 'NEW_FILTER_RANK_TOP10')?.noPyramid;
  const oldP = allResults.find(c => c.config === 'OLD_RANK_THEN_FILTER')?.withPyramid;
  const newP = allResults.find(c => c.config === 'NEW_FILTER_RANK_TOP10')?.withPyramid;
  if (oldNP && newNP) {
    console.log('  Without pyramiding:');
    console.log(`    Old (rank→filter):   ${oldNP.closedTrades} trades, ${oldNP.winRate.toFixed(1)}% win, ${oldNP.avgPnl >= 0 ? '+' : ''}${oldNP.avgPnl.toFixed(2)}% avg, W/L ${oldNP.winLossRatio.toFixed(2)}`);
    console.log(`    New (filter→rank):   ${newNP.closedTrades} trades, ${newNP.winRate.toFixed(1)}% win, ${newNP.avgPnl >= 0 ? '+' : ''}${newNP.avgPnl.toFixed(2)}% avg, W/L ${newNP.winLossRatio.toFixed(2)}`);
    console.log(`    Delta win rate:      ${(newNP.winRate - oldNP.winRate) >= 0 ? '+' : ''}${(newNP.winRate - oldNP.winRate).toFixed(1)} ppt`);
    console.log(`    Delta avg P&L:       ${(newNP.avgPnl - oldNP.avgPnl) >= 0 ? '+' : ''}${(newNP.avgPnl - oldNP.avgPnl).toFixed(2)} ppt`);
  }
  if (oldP && newP) {
    console.log('\n  With pyramiding:');
    console.log(`    Old (rank→filter):   ${oldP.closedTrades} trades, dollar win ${oldP.dollarWinRate.toFixed(1)}%, $${oldP.totalDollarPnl.toLocaleString()} PnL`);
    console.log(`    New (filter→rank):   ${newP.closedTrades} trades, dollar win ${newP.dollarWinRate.toFixed(1)}%, $${newP.totalDollarPnl.toLocaleString()} PnL`);
    console.log(`    Delta dollar win:    ${(newP.dollarWinRate - oldP.dollarWinRate) >= 0 ? '+' : ''}${(newP.dollarWinRate - oldP.dollarWinRate).toFixed(1)} ppt`);
    console.log(`    Delta dollar P&L:    $${(newP.totalDollarPnl - oldP.totalDollarPnl).toLocaleString()}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════════════════════════════\n');
  process.exit(0);
}

// ── Simulation runner ───────────────────────────────────────────────────────

function runSimulation(config, allWeeks, scoresByWeek, signalMap, regimeMap, slopeFallingMap,
  sectorEmaByWeek, sector5dMap, candleMap, weeklyMap, atrMap, usePyramiding) {

  const openPositions = new Map();
  const closedTrades = [];

  for (let wi = 0; wi < allWeeks.length; wi++) {
    const friday = allWeeks[wi];
    const nextFriday = wi < allWeeks.length - 1 ? allWeeks[wi + 1] : '9999-12-31';
    const regime = regimeMap[friday];
    const slopeData = slopeFallingMap[friday];

    // ── Exit checks ──
    for (const [ticker, pos] of openPositions) {
      const daily = candleMap[ticker];
      if (!daily) continue;
      const weekly = weeklyMap[ticker];
      const atrArr = atrMap[ticker];

      for (const bar of daily) {
        if (bar.date <= pos.lastCheckedDate) continue;
        if (bar.date > (usePyramiding ? nextFriday : friday)) break;

        pos.tradingDays++;
        pos.lastCheckedDate = bar.date;

        // Pyramiding: lot additions
        if (usePyramiding && pos.lots && pos.lots.length < MAX_LOTS) {
          const daysSinceLastLot = pos.tradingDays - pos.lastLotDay;
          if (daysSinceLastLot >= TIME_GATE_DAYS) {
            const ref = pos.lots[pos.lots.length - 1].price;
            const pnl = pos.signal === 'BL'
              ? (bar.close - ref) / ref * 100
              : (ref - bar.close) / ref * 100;
            if (pnl >= LOT_TRIGGER_PCT) {
              const shares = Math.floor(LOT_SIZE_USD / bar.close);
              if (shares > 0) {
                const lotNum = pos.lots.length + 1;
                pos.lots.push({ num: lotNum, price: bar.close, shares, date: bar.date, day: pos.tradingDays });
                pos.lastLotDay = pos.tradingDays;
                pos.totalShares += shares;
                pos.totalCost += shares * bar.close;
                pos.avgCost = pos.totalCost / pos.totalShares;
                // Stop ratchet on lot fill
                if (lotNum === 3) {
                  const be = pos.lots[0].price;
                  pos.stop = pos.signal === 'BL' ? Math.max(pos.stop, be) : Math.min(pos.stop, be);
                } else if (lotNum === 4) {
                  const l2 = pos.lots[1].price;
                  pos.stop = pos.signal === 'BL' ? Math.max(pos.stop, l2) : Math.min(pos.stop, l2);
                } else if (lotNum === 5) {
                  const l3 = pos.lots[2].price;
                  pos.stop = pos.signal === 'BL' ? Math.max(pos.stop, l3) : Math.min(pos.stop, l3);
                }
              }
            }
          }
        }

        // MFE/MAE
        const refPrice = usePyramiding ? (pos.avgCost || pos.entryPrice) : pos.entryPrice;
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
              usePyramiding ? closePyramidPosition(pos, bar.date, pos.stop, 'SIGNAL_BE') : closePosition(pos, bar.date, pos.stop, 'SIGNAL_BE');
              break;
            }
            if (pos.signal === 'SS' && weekBar.high > twoWeekHigh) {
              usePyramiding ? closePyramidPosition(pos, bar.date, pos.stop, 'SIGNAL_SE') : closePosition(pos, bar.date, pos.stop, 'SIGNAL_SE');
              break;
            }
          }
        }

        if (pos.signal === 'BL' && bar.low <= pos.stop) {
          usePyramiding ? closePyramidPosition(pos, bar.date, pos.stop, 'STOP_HIT') : closePosition(pos, bar.date, pos.stop, 'STOP_HIT');
          break;
        }
        if (pos.signal === 'SS' && bar.high >= pos.stop) {
          usePyramiding ? closePyramidPosition(pos, bar.date, pos.stop, 'STOP_HIT') : closePosition(pos, bar.date, pos.stop, 'STOP_HIT');
          break;
        }

        if (pos.tradingDays >= 20) {
          const pnlRef = usePyramiding ? (pos.avgCost || pos.entryPrice) : pos.entryPrice;
          const pnl = pos.signal === 'BL'
            ? (bar.close - pnlRef) / pnlRef * 100
            : (pnlRef - bar.close) / pnlRef * 100;
          if (pnl < 0) {
            usePyramiding ? closePyramidPosition(pos, bar.date, bar.close, 'STALE_HUNT') : closePosition(pos, bar.date, bar.close, 'STALE_HUNT');
            break;
          }
        }
      }
    }

    // Remove closed
    for (const [ticker, pos] of openPositions) {
      if (pos.closed) { closedTrades.push(pos); openPositions.delete(ticker); }
    }

    // ── Select entries for this Friday ──
    const weekScores = scoresByWeek[friday] || [];
    if (weekScores.length === 0) continue;

    // Step 1: Start with all scored stocks (non-overextended, with signals)
    let pool = weekScores.filter(s => !s.overextended && s.signal && s.entryPrice > 0);

    if (config.mode === 'filter_then_rank') {
      // Step 2: MACRO gate
      if (config.macroGate && regime) {
        pool = pool.filter(s => {
          const exc = (s.exchange || '').toUpperCase();
          const idxTicker = (exc === 'NASDAQ' || exc.includes('NASDAQ')) ? 'QQQ' : 'SPY';
          const idxKey = idxTicker.toLowerCase();
          const idx = regime[idxKey];
          if (!idx) return false;
          if (s.signal === 'BL') return idx.aboveEma;
          else return !idx.aboveEma;
        });
      }

      // Step 3: SECTOR gate
      if (config.sectorGate) {
        const sectorEma = sectorEmaByWeek[friday] || {};
        pool = pool.filter(s => {
          const etf = SECTOR_MAP[s.sector];
          if (!etf || !sectorEma[etf]) return true; // Let through if no data
          if (s.signal === 'BL') return sectorEma[etf].blAligned;
          else return sectorEma[etf].ssAligned;
        });
      }

      // Step 4: D2 gate
      if (config.d2Gate) {
        pool = pool.filter(s => (s.scores?.d2 ?? 0) >= 0);
      }

      // Step 5: SS strict criteria
      if (config.ssStrict) {
        pool = pool.filter(s => {
          if (s.signal !== 'SS') return true; // BL passes through
          const exc = (s.exchange || '').toUpperCase();
          const idxTicker = (exc === 'NASDAQ' || exc.includes('NASDAQ')) ? 'QQQ' : 'SPY';
          const slopeOk = slopeFallingMap[friday]?.[idxTicker] ?? false;
          if (!slopeOk) return false;
          const etf = SECTOR_MAP[s.sector];
          const sect5d = sector5dMap[friday]?.[etf] ?? 0;
          if (sect5d > -3) return false;
          return true;
        });
      }

      // Step 6: Re-rank by apexScore within filtered pool
      pool.sort((a, b) => b.apexScore - a.apexScore);

      // Step 7: Assign new filtered ranks
      let fRank = 0;
      for (const s of pool) {
        fRank++;
        s.filteredRank = fRank;
      }

      // Step 8: Take top N by direction
      const blPool = pool.filter(s => s.signal === 'BL').slice(0, config.blTopN);
      const ssPool = pool.filter(s => s.signal === 'SS').slice(0, config.ssTopN);
      pool = [...blPool, ...ssPool];

      // Step 9: Analyze gate (if configured)
      if (config.blMinAnalyze > 0 || config.ssMinAnalyze > 0) {
        pool = pool.filter(s => {
          const sig = signalMap[friday + '|' + s.ticker];
          const ana = sig?.analyzePct ?? 0;
          if (s.signal === 'BL') return ana >= (config.blMinAnalyze || 0);
          else return ana >= (config.ssMinAnalyze || 0);
        });
      }

    } else {
      // OLD MODE: rank_then_filter
      // Rank all, take top 10, THEN filter
      pool.sort((a, b) => b.apexScore - a.apexScore);
      let rank = 0;
      for (const s of pool) { rank++; s.filteredRank = rank; }

      // Take top 10
      pool = pool.slice(0, 10);

      // Then filter
      if (config.macroGate && regime) {
        pool = pool.filter(s => {
          const exc = (s.exchange || '').toUpperCase();
          const idxTicker = (exc === 'NASDAQ' || exc.includes('NASDAQ')) ? 'QQQ' : 'SPY';
          const idxKey = idxTicker.toLowerCase();
          const idx = regime[idxKey];
          if (!idx) return false;
          if (s.signal === 'BL') return idx.aboveEma;
          else return !idx.aboveEma;
        });
      }
      if (config.sectorGate) {
        const sectorEma = sectorEmaByWeek[friday] || {};
        pool = pool.filter(s => {
          const etf = SECTOR_MAP[s.sector];
          if (!etf || !sectorEma[etf]) return true;
          if (s.signal === 'BL') return sectorEma[etf].blAligned;
          else return sectorEma[etf].ssAligned;
        });
      }
      if (config.d2Gate) {
        pool = pool.filter(s => (s.scores?.d2 ?? 0) >= 0);
      }
    }

    // ── Enter positions from selected pool ──
    for (const score of pool) {
      const ticker = score.ticker;
      if (openPositions.has(ticker)) continue;

      // Get entry price from analyze signal (signal price) or score doc
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

      const posObj = {
        ticker,
        signal: score.signal,
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
        sector: score.sector,
        exchange: score.exchange,
        analyzePct: sig?.analyzePct ?? null,
      };

      if (usePyramiding) {
        const lot1Shares = Math.floor(LOT_SIZE_USD / entryPrice);
        if (lot1Shares <= 0) continue;
        posObj.lots = [{ num: 1, price: entryPrice, shares: lot1Shares, date: friday, day: 0 }];
        posObj.lastLotDay = 0;
        posObj.totalShares = lot1Shares;
        posObj.totalCost = lot1Shares * entryPrice;
        posObj.avgCost = entryPrice;
      }

      openPositions.set(ticker, posObj);
    }
  }

  // Close remaining
  for (const [ticker, pos] of openPositions) {
    const daily = candleMap[ticker];
    if (daily?.length > 0) {
      const last = daily[daily.length - 1];
      usePyramiding
        ? closePyramidPosition(pos, last.date, last.close, 'STILL_OPEN')
        : closePosition(pos, last.date, last.close, 'STILL_OPEN');
    }
    closedTrades.push(pos);
  }

  // ── Compute results ──
  const closed = closedTrades.filter(t => t.exitReason !== 'STILL_OPEN');
  const winners = closed.filter(t => t.isWinner);
  const losers = closed.filter(t => !t.isWinner);
  const avgPnl = closed.length > 0 ? closed.reduce((s, t) => s + t.profitPct, 0) / closed.length : 0;
  const avgWin = winners.length > 0 ? winners.reduce((s, t) => s + t.profitPct, 0) / winners.length : 0;
  const avgLoss = losers.length > 0 ? losers.reduce((s, t) => s + t.profitPct, 0) / losers.length : 0;
  const totalReturn = closed.reduce((s, t) => s + t.profitPct, 0);

  const byDir = {};
  for (const dir of ['BL', 'SS']) {
    const dt = closed.filter(t => t.signal === dir);
    const dw = dt.filter(t => t.isWinner);
    byDir[dir] = {
      trades: dt.length,
      winners: dw.length,
      winRate: dt.length > 0 ? parseFloat((dw.length / dt.length * 100).toFixed(1)) : 0,
      avgPnl: dt.length > 0 ? parseFloat((dt.reduce((s, t) => s + t.profitPct, 0) / dt.length).toFixed(2)) : 0,
      totalReturn: parseFloat(dt.reduce((s, t) => s + t.profitPct, 0).toFixed(1)),
    };
  }

  const byYear = {};
  for (const t of closed) {
    const y = t.weekOf.slice(0, 4);
    if (!byYear[y]) byYear[y] = { trades: 0, winners: 0, totalPnl: 0, totalDollarPnl: 0 };
    byYear[y].trades++;
    if (t.isWinner) byYear[y].winners++;
    byYear[y].totalPnl += t.profitPct;
    if (usePyramiding) byYear[y].totalDollarPnl += (t.dollarPnl || 0);
  }

  const result = {
    closedTrades: closed.length,
    winners: winners.length,
    winRate: closed.length > 0 ? parseFloat((winners.length / closed.length * 100).toFixed(1)) : 0,
    avgPnl: parseFloat(avgPnl.toFixed(2)),
    avgWin: parseFloat(avgWin.toFixed(2)),
    avgLoss: parseFloat(avgLoss.toFixed(2)),
    winLossRatio: avgLoss !== 0 ? parseFloat((avgWin / Math.abs(avgLoss)).toFixed(2)) : 0,
    totalReturn: parseFloat(totalReturn.toFixed(1)),
    byDirection: byDir,
    byYear,
  };

  if (usePyramiding) {
    const dollarWon = closed.filter(t => (t.dollarPnl || 0) > 0).reduce((s, t) => s + t.dollarPnl, 0);
    const dollarLost = Math.abs(closed.filter(t => (t.dollarPnl || 0) < 0).reduce((s, t) => s + t.dollarPnl, 0));
    const totalInvested = closed.reduce((s, t) => s + (t.totalCost || 0), 0);
    result.tradeWinRate = result.winRate;
    result.dollarWinRate = (dollarWon + dollarLost) > 0 ? parseFloat((dollarWon / (dollarWon + dollarLost) * 100).toFixed(1)) : 0;
    result.totalDollarPnl = parseFloat((dollarWon - dollarLost).toFixed(0));
    result.dollarROI = totalInvested > 0 ? parseFloat(((dollarWon - dollarLost) / totalInvested * 100).toFixed(2)) : 0;
    result.avgLotsOnWinners = winners.length > 0 ? parseFloat((winners.reduce((s, t) => s + (t.maxLots || 1), 0) / winners.length).toFixed(2)) : 0;
    result.avgLotsOnLosers = losers.length > 0 ? parseFloat((losers.reduce((s, t) => s + (t.maxLots || 1), 0) / losers.length).toFixed(2)) : 0;
  }

  return result;
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
