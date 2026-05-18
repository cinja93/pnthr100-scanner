// server/backtest/analyzeCarnivoreGates.js
// ── Analysis: What would happen if Carnivore tickers had to pass 679 gates? ──
//
// Pulls the actual Carnivore trade log from the multi-strategy backtest,
// then retroactively checks each entry against the 679 gates:
//   1. MACRO gate — direction index (SPY/QQQ) above/below 21W EMA
//   2. SECTOR gate — GICS sector ETF above/below OpEMA (18-26W)
//   3. D2 gate — sector alignment score ≥ 0 (5D return direction matches signal)
//   4. SS CRASH gate — index EMA falling 2+ weeks + sector 5D < -3%
//
// Usage: cd server && node backtest/analyzeCarnivoreGates.js

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { connectToDatabase } from '../database.js';
import { CARNIVORE_MODE_TICKERS, getCarnivoreEmaPeriod } from '../data/strategyMode.js';
import { getEtfEmaPeriod } from '../sectorEmaConfig.js';

const REGIME_EMA_PERIOD = 21;

// GICS sector → ETF mapping (same as ordersPipeline.js)
const SECTOR_MAP = {
  'Technology': 'XLK', 'Energy': 'XLE', 'Healthcare': 'XLV', 'Health Care': 'XLV',
  'Financial Services': 'XLF', 'Financials': 'XLF', 'Consumer Discretionary': 'XLY',
  'Communication Services': 'XLC', 'Industrials': 'XLI', 'Basic Materials': 'XLB',
  'Materials': 'XLB', 'Real Estate': 'XLRE', 'Utilities': 'XLU', 'Consumer Staples': 'XLP',
};
const ALL_SECTOR_ETFS = ['XLK', 'XLE', 'XLV', 'XLF', 'XLY', 'XLC', 'XLI', 'XLB', 'XLRE', 'XLU', 'XLP'];

function emaValues(closes, period) {
  const k = 2 / (period + 1);
  const result = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    result.push(closes[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function getMondayOf(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const dow = d.getDay();
  const daysToMon = dow === 0 ? -6 : 1 - dow;
  const m = new Date(d);
  m.setDate(d.getDate() + daysToMon);
  return m.toISOString().split('T')[0];
}

async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('Cannot connect to MongoDB'); process.exit(1); }

  console.log('═'.repeat(80));
  console.log('  CARNIVORE GATE ANALYSIS');
  console.log('  Would 679 gates improve Carnivore results on AI Orders?');
  console.log('═'.repeat(80));

  // 1. Load Carnivore trades from multi-strategy backtest
  const tradeCol = db.collection('pnthr_ai_bt_pyramid_nav_1m_trade_log_multi');
  const allTrades = await tradeCol.find({}).toArray();
  const carnivoreTrades = allTrades.filter(t => CARNIVORE_MODE_TICKERS.has(t.ticker));
  const ai300Trades = allTrades.filter(t => !CARNIVORE_MODE_TICKERS.has(t.ticker));

  console.log(`\n  Total trades: ${allTrades.length}`);
  console.log(`  Carnivore trades: ${carnivoreTrades.length} (${CARNIVORE_MODE_TICKERS.size} tickers)`);
  console.log(`  AI 300 trades: ${ai300Trades.length}`);

  if (carnivoreTrades.length === 0) {
    console.log('\n  No Carnivore trades found. Check collection name.');
    process.exit(0);
  }

  // 2. Load SPY + QQQ weekly data for macro gate
  console.log('\n  Loading SPY/QQQ for macro gate...');
  const spyDoc = await db.collection('pnthr_candles_weekly').findOne({ ticker: 'SPY' });
  const qqqDoc = await db.collection('pnthr_candles_weekly').findOne({ ticker: 'QQQ' });

  function buildRegimeMap(weekly) {
    const sorted = [...weekly].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
    const closes = sorted.map(b => b.close);
    const ema = emaValues(closes, REGIME_EMA_PERIOD);
    const map = {};
    for (let i = 0; i < sorted.length; i++) {
      const prevAbove = i > 0 ? closes[i - 1] > ema[i - 1] : true;
      const prevSlope = i > 1 ? ema[i - 1] - ema[i - 2] : 0;
      const prevPrevSlope = i > 2 ? ema[i - 2] - ema[i - 3] : 0;
      map[sorted[i].weekOf] = {
        close: closes[i],
        ema: ema[i],
        aboveEma: closes[i] > ema[i],
        slopeFalling: ema[i] < ema[i - 1],
        slopeFalling2Wk: i > 1 && ema[i] < ema[i - 1] && ema[i - 1] < ema[i - 2],
      };
    }
    return map;
  }

  const spyRegime = buildRegimeMap(spyDoc?.weekly || []);
  const qqqRegime = buildRegimeMap(qqqDoc?.weekly || []);

  // 3. Load GICS sector ETF weekly data for sector gate
  console.log('  Loading GICS sector ETF data for sector gate...');
  const sectorEmaByWeek = {}; // weekOf → { ETF: { aboveEma, return5D } }

  for (const etf of ALL_SECTOR_ETFS) {
    const doc = await db.collection('pnthr_candles_weekly').findOne({ ticker: etf });
    if (!doc?.weekly?.length) {
      // Try bt candles
      const btDoc = await db.collection('pnthr_bt_candles').findOne({ ticker: etf });
      if (btDoc?.daily) {
        // Need to load daily for 5D returns
      }
      continue;
    }
    const sorted = [...doc.weekly].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
    const period = getEtfEmaPeriod(etf);
    const closes = sorted.map(b => b.close);
    const ema = emaValues(closes, period);

    for (let i = 0; i < sorted.length; i++) {
      const weekOf = sorted[i].weekOf;
      if (!sectorEmaByWeek[weekOf]) sectorEmaByWeek[weekOf] = {};
      sectorEmaByWeek[weekOf][etf] = {
        close: closes[i],
        ema: ema[i],
        aboveEma: closes[i] > ema[i],
      };
    }
  }

  // Also load daily sector data for 5D returns (SS crash gate needs it)
  console.log('  Loading daily sector ETF data for 5D returns...');
  const sectorDailyMap = {};
  for (const etf of ALL_SECTOR_ETFS) {
    const doc = await db.collection('pnthr_bt_candles').findOne({ ticker: etf });
    if (doc?.daily) {
      sectorDailyMap[etf] = [...doc.daily].sort((a, b) => a.date > b.date ? 1 : -1);
    }
  }

  function getSector5D(etf, dateStr) {
    const daily = sectorDailyMap[etf];
    if (!daily) return null;
    let idx = -1;
    for (let i = daily.length - 1; i >= 0; i--) {
      if (daily[i].date <= dateStr) { idx = i; break; }
    }
    if (idx < 5) return null;
    const cur = daily[idx].close;
    const prev = daily[idx - 5].close;
    if (prev <= 0) return null;
    return parseFloat(((cur - prev) / prev * 100).toFixed(2));
  }

  // 4. Apply gates retroactively to each Carnivore trade
  console.log('\n  Applying 679 gates retroactively...\n');

  let passedAll = 0, failedMacro = 0, failedSector = 0, failedD2 = 0, failedSSCrash = 0;
  const passedTrades = [];
  const filteredTrades = [];

  for (const trade of carnivoreTrades) {
    const weekOf = getMondayOf(trade.weekOf || trade.entryDate);
    const signal = trade.signal;
    const sectorName = trade.sectorName;
    const sectorEtf = SECTOR_MAP[sectorName];
    const isLong = signal === 'BL';
    const grossPnl = trade.grossDollarPnl || 0;

    // Find closest regime data
    let spyData = null, qqqData = null;
    const regimeWeeks = Object.keys(spyRegime).sort();
    for (let i = regimeWeeks.length - 1; i >= 0; i--) {
      if (regimeWeeks[i] <= weekOf) { spyData = spyRegime[regimeWeeks[i]]; break; }
    }
    const qqqWeeks = Object.keys(qqqRegime).sort();
    for (let i = qqqWeeks.length - 1; i >= 0; i--) {
      if (qqqWeeks[i] <= weekOf) { qqqData = qqqRegime[qqqWeeks[i]]; break; }
    }

    // GATE 1: MACRO — SPY above EMA for BL, below for SS
    // (The regime gate is already applied in the backtest — SPY+QQQ both above = c679Bull)
    // Here we check individual direction index. For simplicity, use SPY for all.
    const macroAligned = spyData
      ? (isLong ? spyData.aboveEma : !spyData.aboveEma)
      : true;

    if (!macroAligned) {
      failedMacro++;
      filteredTrades.push({ ...trade, failedGate: 'MACRO', grossPnl });
      continue;
    }

    // GATE 2: SECTOR — sector ETF above OpEMA for BL, below for SS
    let sectorAligned = true;
    if (sectorEtf) {
      const sectorWeeks = Object.keys(sectorEmaByWeek).sort();
      let sectorData = null;
      for (let i = sectorWeeks.length - 1; i >= 0; i--) {
        if (sectorWeeks[i] <= weekOf) { sectorData = sectorEmaByWeek[sectorWeeks[i]]?.[sectorEtf]; break; }
      }
      if (sectorData) {
        sectorAligned = isLong ? sectorData.aboveEma : !sectorData.aboveEma;
      }
    }

    if (!sectorAligned) {
      failedSector++;
      filteredTrades.push({ ...trade, failedGate: 'SECTOR', grossPnl });
      continue;
    }

    // GATE 3: D2 — sector 5D return direction matches signal
    const entryDate = trade.weekOf || trade.entryDate;
    const sector5D = sectorEtf ? getSector5D(sectorEtf, entryDate) : null;
    const d2Aligned = sector5D != null
      ? (isLong ? sector5D >= 0 : sector5D < 0)
      : true; // pass if no data

    if (!d2Aligned) {
      failedD2++;
      filteredTrades.push({ ...trade, failedGate: 'D2', grossPnl, sector5D });
      continue;
    }

    // GATE 4: SS CRASH (SS only) — direction index EMA falling 2+ weeks + sector 5D < -3%
    if (!isLong) {
      const slopeFalling = spyData?.slopeFalling2Wk ?? false;
      const sectorCrash = sector5D != null && sector5D < -3;
      if (!slopeFalling || !sectorCrash) {
        failedSSCrash++;
        filteredTrades.push({ ...trade, failedGate: 'SS_CRASH', grossPnl, sector5D });
        continue;
      }
    }

    passedAll++;
    passedTrades.push({ ...trade, grossPnl });
  }

  // 5. Results
  console.log('─'.repeat(80));
  console.log('  GATE RESULTS');
  console.log('─'.repeat(80));
  console.log(`  Total Carnivore trades:    ${carnivoreTrades.length}`);
  console.log(`  Passed all 679 gates:      ${passedAll}`);
  console.log(`  Filtered out:              ${filteredTrades.length}`);
  console.log(`    Failed MACRO:            ${failedMacro}`);
  console.log(`    Failed SECTOR:           ${failedSector}`);
  console.log(`    Failed D2:               ${failedD2}`);
  console.log(`    Failed SS CRASH:         ${failedSSCrash}`);

  // P&L analysis
  const passedGrossPnl = passedTrades.reduce((s, t) => s + (t.grossPnl || 0), 0);
  const filteredGrossPnl = filteredTrades.reduce((s, t) => s + (t.grossPnl || 0), 0);
  const totalGrossPnl = carnivoreTrades.reduce((s, t) => s + (t.grossDollarPnl || 0), 0);

  const passedWinners = passedTrades.filter(t => t.grossPnl > 0);
  const passedLosers = passedTrades.filter(t => t.grossPnl <= 0);
  const filteredWinners = filteredTrades.filter(t => t.grossPnl > 0);
  const filteredLosers = filteredTrades.filter(t => t.grossPnl <= 0);

  console.log(`\n  ── P&L Impact ──`);
  console.log(`  ALL Carnivore:       ${carnivoreTrades.length} trades | $${totalGrossPnl.toLocaleString(undefined, { maximumFractionDigits: 0 })} gross P&L`);
  console.log(`  PASSED trades:       ${passedTrades.length} trades | $${passedGrossPnl.toLocaleString(undefined, { maximumFractionDigits: 0 })} gross P&L | ${passedWinners.length}W / ${passedLosers.length}L | Win%: ${passedTrades.length > 0 ? (passedWinners.length / passedTrades.length * 100).toFixed(1) : 0}%`);
  console.log(`  FILTERED trades:     ${filteredTrades.length} trades | $${filteredGrossPnl.toLocaleString(undefined, { maximumFractionDigits: 0 })} gross P&L | ${filteredWinners.length}W / ${filteredLosers.length}L | Win%: ${filteredTrades.length > 0 ? (filteredWinners.length / filteredTrades.length * 100).toFixed(1) : 0}%`);

  if (filteredGrossPnl < 0) {
    console.log(`\n  ✅ VERDICT: Gates HELP — filtered trades lost $${Math.abs(filteredGrossPnl).toLocaleString(undefined, { maximumFractionDigits: 0 })}. Adding gates would IMPROVE results.`);
  } else {
    console.log(`\n  ⚠️  VERDICT: Gates HURT — filtered trades earned $${filteredGrossPnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}. Adding gates would REDUCE results.`);
  }

  // Breakdown by gate
  console.log(`\n  ── Filtered Trades by Gate ──`);
  for (const gate of ['MACRO', 'SECTOR', 'D2', 'SS_CRASH']) {
    const gateFiltered = filteredTrades.filter(t => t.failedGate === gate);
    if (gateFiltered.length === 0) continue;
    const gatePnl = gateFiltered.reduce((s, t) => s + (t.grossPnl || 0), 0);
    const gateWins = gateFiltered.filter(t => t.grossPnl > 0).length;
    const gateLosses = gateFiltered.filter(t => t.grossPnl <= 0).length;
    console.log(`  ${gate.padEnd(12)} ${gateFiltered.length} trades | $${gatePnl.toLocaleString(undefined, { maximumFractionDigits: 0 })} P&L | ${gateWins}W / ${gateLosses}L | Win%: ${(gateWins / gateFiltered.length * 100).toFixed(1)}%`);
  }

  // By direction
  console.log(`\n  ── By Direction ──`);
  for (const dir of ['BL', 'SS']) {
    const dirAll = carnivoreTrades.filter(t => t.signal === dir);
    const dirPassed = passedTrades.filter(t => t.signal === dir);
    const dirFiltered = filteredTrades.filter(t => t.signal === dir);
    const dirAllPnl = dirAll.reduce((s, t) => s + (t.grossDollarPnl || 0), 0);
    const dirPassedPnl = dirPassed.reduce((s, t) => s + (t.grossPnl || 0), 0);
    const dirFilteredPnl = dirFiltered.reduce((s, t) => s + (t.grossPnl || 0), 0);
    console.log(`  ${dir}:`);
    console.log(`    All:      ${dirAll.length} trades | $${dirAllPnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
    console.log(`    Passed:   ${dirPassed.length} trades | $${dirPassedPnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
    console.log(`    Filtered: ${dirFiltered.length} trades | $${dirFilteredPnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  }

  // Individual filtered trades (show details for review)
  console.log(`\n  ── Filtered Trade Details (top 20 by |P&L|) ──`);
  const sortedFiltered = [...filteredTrades].sort((a, b) => Math.abs(b.grossPnl) - Math.abs(a.grossPnl));
  console.log(`  ${'Ticker'.padEnd(8)} ${'Signal'.padEnd(6)} ${'Gate'.padEnd(12)} ${'Entry'.padEnd(12)} ${'P&L'.padStart(10)}  Sector`);
  console.log(`  ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(12)} ${'─'.repeat(12)} ${'─'.repeat(10)}  ${'─'.repeat(25)}`);
  for (const t of sortedFiltered.slice(0, 20)) {
    const pnlStr = `$${t.grossPnl >= 0 ? '+' : ''}${t.grossPnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    console.log(`  ${t.ticker.padEnd(8)} ${t.signal.padEnd(6)} ${t.failedGate.padEnd(12)} ${(t.entryDate || t.weekOf || '').padEnd(12)} ${pnlStr.padStart(10)}  ${t.sectorName || ''}`);
  }

  // Year-by-year comparison
  console.log(`\n  ── Year-by-Year Carnivore P&L ──`);
  console.log(`  ${'Year'.padEnd(6)} ${'All'.padStart(12)} ${'Passed'.padStart(12)} ${'Filtered'.padStart(12)} ${'Delta'.padStart(12)}`);
  const years = [...new Set(carnivoreTrades.map(t => (t.entryDate || t.weekOf || '').slice(0, 4)))].sort();
  for (const y of years) {
    const yAll = carnivoreTrades.filter(t => (t.entryDate || t.weekOf || '').startsWith(y));
    const yPassed = passedTrades.filter(t => (t.entryDate || t.weekOf || '').startsWith(y));
    const yFiltered = filteredTrades.filter(t => (t.entryDate || t.weekOf || '').startsWith(y));
    const yAllPnl = yAll.reduce((s, t) => s + (t.grossDollarPnl || 0), 0);
    const yPassedPnl = yPassed.reduce((s, t) => s + (t.grossPnl || 0), 0);
    const yFilteredPnl = yFiltered.reduce((s, t) => s + (t.grossPnl || 0), 0);
    console.log(`  ${y.padEnd(6)} $${yAllPnl.toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(11)} $${yPassedPnl.toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(11)} $${yFilteredPnl.toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(11)} $${(yPassedPnl - yAllPnl).toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(11)}`);
  }

  console.log('\n' + '═'.repeat(80));
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
