// server/backtest/exportPyramidOrders.js
// ── PNTHR Full Pyramid Backtest — True Apples-to-Apples ──────────────────────
//
// Combines the production signal selection pipeline with the full 5-lot
// pyramiding strategy exactly as coded in the live system.
//
// SIGNAL SELECTION (mirrors exportOrdersTrades.js / production Orders page):
//   - Reads pnthr_bt_scores (full D1-D8 from backfillBtScores.js v2.0)
//   - MACRO gate: BL requires index above 21W EMA; SS requires below
//   - SECTOR gate: sector EMA alignment from pnthr_bt_analyze_signals
//   - D2 gate: sector return must be non-negative for direction
//   - SS CRASH gate: requires 2+ consecutive falling EMA weeks + sector -3% 5D
//   - Top 10 BL + top 5 SS selected weekly
//
// PYRAMIDING (mirrors live CommandCenter lot system exactly):
//   Lot 1 "The Scent":    35% of position — entry trigger
//   Lot 2 "The Stalk":    25% — +3% trigger, 5-day time gate
//   Lot 3 "The Strike":   20% — +6% trigger
//   Lot 4 "The Jugular":  12% — +10% trigger
//   Lot 5 "The Kill":      8% — +14% trigger
//
//   Stop ratchets on lot fill:
//     Lot 2 fill → stop to avg cost (breakeven)
//     Lot 3 fill → stop to Lot 1 fill price
//     Lot 4 fill → stop to Lot 2 fill price
//     Lot 5 fill → stop to Lot 3 fill price
//
//   Time gate: 5 trading days after Lot 1 before Lot 2 is eligible
//   Weekly ATR ratchet: Wilder ATR(3) applied each new week
//
// POSITION SIZING:
//   Full position = $10,000 (same as single-lot baseline for apples-to-apples)
//   Lot 1 = 35% = $3,500 at risk; full pyramid = $10,000 total deployed
//
// COST ENGINE (costEngine.js — per lot fill):
//   Commission: IBKR Pro Fixed ($0.005/share, $1 min, 1% cap) per lot entry + exit
//   Slippage:   5 bps adverse per leg (entry + exit) per lot
//   Borrow:     SS only — sector-tiered 1.0-2.0% annualized on per-lot value
//
// OUTPUT:
//   pnthr_bt_pyramid_trade_log — per-trade records with all lot details + costs
//
// Prerequisite: node backtest/backfillBtScores.js (full D1-D8 scores)
//
// Usage:  cd server && node backtest/exportPyramidOrders.js
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { connectToDatabase } from '../database.js';
import { aggregateWeeklyBars } from '../technicalUtils.js';
import { computeWilderATR } from '../stopCalculation.js';
import { calcCommission, calcSlippage, getBorrowRate, calcBorrowCost, COST_METHODOLOGY } from './costEngine.js';

// ── Lot system constants (must match sizingUtils.js + live CommandCenter) ──
const FULL_POSITION_USD = 10000;   // same as single-lot baseline
const LOT_PCT   = [0.35, 0.25, 0.20, 0.12, 0.08];
const LOT_NAMES = ['The Scent', 'The Stalk', 'The Strike', 'The Jugular', 'The Kill'];
const LOT_OFFSET_PCT = [0, 0.03, 0.06, 0.10, 0.14];   // trigger = anchor × (1 ± offset)
const TIME_GATE_DAYS = 5;  // Lot 2 only: 5 trading days after Lot 1

// ── Sector maps ──────────────────────────────────────────────────────────────
const ALL_SECTOR_ETFS = ['XLK', 'XLE', 'XLV', 'XLF', 'XLY', 'XLC', 'XLI', 'XLB', 'XLRE', 'XLU', 'XLP'];
const SECTOR_MAP = {
  'Technology': 'XLK', 'Energy': 'XLE', 'Healthcare': 'XLV', 'Health Care': 'XLV',
  'Financial Services': 'XLF', 'Financials': 'XLF', 'Consumer Discretionary': 'XLY',
  'Consumer Cyclical': 'XLY', 'Communication Services': 'XLC', 'Industrials': 'XLI',
  'Basic Materials': 'XLB', 'Materials': 'XLB', 'Real Estate': 'XLRE',
  'Utilities': 'XLU', 'Consumer Staples': 'XLP', 'Consumer Defensive': 'XLP',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Get Monday for any date string
function getMondayOf(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const dow = d.getDay();
  const daysToMon = dow === 0 ? -6 : 1 - dow;
  const m = new Date(d);
  m.setDate(d.getDate() + daysToMon);
  return m.toISOString().split('T')[0];
}

// Compute weekly ATR stop candidate
function computeWeeklyStopCandidate(weekly, atrArr, weekIdx, signal, currentStop) {
  if (weekIdx < 3 || !atrArr[weekIdx - 1]) return currentStop;
  const prev1 = weekly[weekIdx - 1];
  const prev2 = weekly[weekIdx - 2];
  const twoWeekHigh = Math.max(prev1.high, prev2.high);
  const twoWeekLow  = Math.min(prev1.low,  prev2.low);
  const prevAtr = atrArr[weekIdx - 1];

  if (signal === 'BL') {
    const struct = parseFloat((twoWeekLow - 0.01).toFixed(2));
    const atrFloor = parseFloat((prev1.close - prevAtr).toFixed(2));
    const candidate = Math.max(struct, atrFloor);
    return parseFloat(Math.max(currentStop, candidate).toFixed(2));
  } else {
    const struct = parseFloat((twoWeekHigh + 0.01).toFixed(2));
    const atrCeil = parseFloat((prev1.close + prevAtr).toFixed(2));
    const candidate = Math.min(struct, atrCeil);
    return parseFloat(Math.min(currentStop, candidate).toFixed(2));
  }
}

// Detect structural signal exit (price breaks through 2-week high/low)
function checkStructuralExit(weekBar, twoWeekHigh, twoWeekLow, signal) {
  if (signal === 'BL' && weekBar.low < twoWeekLow) return true;
  if (signal === 'SS' && weekBar.high > twoWeekHigh) return true;
  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('Cannot connect to MongoDB'); process.exit(1); }

  const scoreCol   = db.collection('pnthr_bt_scores');
  const signalCol  = db.collection('pnthr_bt_analyze_signals');
  const regimeCol  = db.collection('pnthr_bt_regime');
  const candleCol  = db.collection('pnthr_bt_candles');
  const outputCol  = db.collection('pnthr_bt_pyramid_trade_log');

  // ── Load score data ────────────────────────────────────────────────────────
  console.log('\nLoading score data...');
  const allScores = await scoreCol.find({}).toArray();
  const scoresByWeek = {};
  for (const s of allScores) {
    if (!scoresByWeek[s.weekOf]) scoresByWeek[s.weekOf] = [];
    scoresByWeek[s.weekOf].push(s);
  }
  const allWeeks = Object.keys(scoresByWeek).sort();
  console.log(`  ${allScores.length.toLocaleString()} scores across ${allWeeks.length} weeks`);
  console.log(`  Period: ${allWeeks[0]} → ${allWeeks[allWeeks.length - 1]}`);

  // ── Load analyze signals ────────────────────────────────────────────────────
  const rawSignals = await signalCol.find({}).toArray();
  const signalMap = {};
  for (const s of rawSignals) signalMap[s.weekOf + '|' + s.ticker] = s;

  // ── Load regime ─────────────────────────────────────────────────────────────
  const regimeDocs = await regimeCol.find({}).toArray();
  const regimeMap = {};
  for (const r of regimeDocs) regimeMap[r.weekOf] = r;

  // Slope-falling map (SS crash gate: 2 consecutive falling EMA weeks)
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

  // ── Build sector EMA alignment map ─────────────────────────────────────────
  const sectorEmaByWeek = {};
  for (const s of rawSignals) {
    if (!sectorEmaByWeek[s.weekOf]) sectorEmaByWeek[s.weekOf] = {};
    const etf = SECTOR_MAP[s.sector];
    if (!etf) continue;
    if (!sectorEmaByWeek[s.weekOf][etf]) sectorEmaByWeek[s.weekOf][etf] = { blAligned: false, ssAligned: false };
    if ((s.analyzeComponents?.t1d ?? 0) > 0) {
      if (s.signal === 'BL') sectorEmaByWeek[s.weekOf][etf].blAligned = true;
      else                   sectorEmaByWeek[s.weekOf][etf].ssAligned = true;
    }
  }

  // ── Sector 5D momentum map ─────────────────────────────────────────────────
  console.log('Loading sector daily data...');
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

  // ── Load all candle data ───────────────────────────────────────────────────
  console.log('Loading candle data...');
  const allCandles = await candleCol.find({}).toArray();
  const candleMap = {};   // ticker → ascending daily bars
  const weeklyMap = {};   // ticker → weekly bars
  const atrMap    = {};   // ticker → Wilder ATR array

  for (const doc of allCandles) {
    const ascending = [...doc.daily].sort((a, b) => a.date > b.date ? 1 : -1);
    candleMap[doc.ticker] = ascending;
    const weekly = aggregateWeeklyBars(doc.daily, { includeVolume: false });
    weeklyMap[doc.ticker] = weekly;
    atrMap[doc.ticker]    = computeWilderATR(weekly);
  }
  console.log(`  ${Object.keys(candleMap).length} tickers loaded\n`);

  // ── Run simulation ─────────────────────────────────────────────────────────
  // Open positions: Map<ticker, positionObj>
  // Each positionObj tracks the pyramid state for one trade
  const openPositions = new Map();
  const closedTrades  = [];

  let weekNum = 0;
  for (let wi = 0; wi < allWeeks.length; wi++) {
    const friday     = allWeeks[wi];
    const regime     = regimeMap[friday];
    weekNum++;

    // ── Exit/update all open positions ───────────────────────────────────────
    for (const [ticker, pos] of openPositions) {
      const daily  = candleMap[ticker];
      const weekly = weeklyMap[ticker];
      const atrArr = atrMap[ticker];
      if (!daily || !weekly) continue;

      // Walk daily bars up to this Friday
      for (const bar of daily) {
        if (bar.date <= pos.lastCheckedDate) continue;
        if (bar.date > friday) break;

        pos.tradingDays++;
        pos.lastCheckedDate = bar.date;

        // ── Weekly stop ratchet (ATR) ─────────────────────────────────────
        const barMondayStr = getMondayOf(bar.date);
        const weekIdx = weekly.findIndex(b => b.weekStart === barMondayStr);

        if (weekIdx > pos.currentWeekIdx && weekIdx >= 3) {
          pos.currentWeekIdx = weekIdx;

          // ATR stop ratchet
          const newStop = computeWeeklyStopCandidate(weekly, atrArr, weekIdx, pos.signal, pos.stop);
          if (newStop !== pos.stop) {
            pos.stop = newStop;
            pos.stopHistory.push({ date: bar.date, stop: newStop, reason: 'ATR_RATCHET' });
          }

          // Structural signal exit check
          const prev1 = weekly[weekIdx - 1];
          const prev2 = weekly[weekIdx - 2];
          const twoWeekHigh = Math.max(prev1.high, prev2.high);
          const twoWeekLow  = Math.min(prev1.low, prev2.low);
          const weekBar = weekly[weekIdx];
          if (weekBar && checkStructuralExit(weekBar, twoWeekHigh, twoWeekLow, pos.signal)) {
            closePosition(pos, bar.date, pos.stop, 'SIGNAL_BE');
            break;
          }
        }

        // ── MFE / MAE tracking ────────────────────────────────────────────
        const refPrice = pos.avgCost;
        if (pos.signal === 'BL') {
          pos.mfe = Math.max(pos.mfe, (bar.high - refPrice) / refPrice * 100);
          pos.mae = Math.min(pos.mae, (bar.low  - refPrice) / refPrice * 100);
        } else {
          pos.mfe = Math.max(pos.mfe, (refPrice - bar.low)  / refPrice * 100);
          pos.mae = Math.min(pos.mae, (refPrice - bar.high) / refPrice * 100);
        }

        // ── Check stop hit ────────────────────────────────────────────────
        if (pos.signal === 'BL' && bar.low <= pos.stop) {
          closePosition(pos, bar.date, pos.stop, 'STOP_HIT');
          break;
        }
        if (pos.signal === 'SS' && bar.high >= pos.stop) {
          closePosition(pos, bar.date, pos.stop, 'STOP_HIT');
          break;
        }

        // ── Stale hunt (20 trading days, losing) ─────────────────────────
        if (pos.tradingDays >= 20) {
          const pnl = pos.signal === 'BL'
            ? (bar.close - pos.avgCost) / pos.avgCost * 100
            : (pos.avgCost - bar.close) / pos.avgCost * 100;
          if (pnl < 0) {
            closePosition(pos, bar.date, bar.close, 'STALE_HUNT');
            break;
          }
        }

        if (pos.closed) break;

        // ── Pyramid lot additions ─────────────────────────────────────────
        const nextLotIdx = pos.lots.length;  // 0-based index of next lot to add
        if (nextLotIdx < 5) {
          // Time gate: only applies to Lot 2 (index 1)
          const timeGateOk = nextLotIdx !== 1 || pos.tradingDays >= TIME_GATE_DAYS;
          if (!timeGateOk) continue;

          const trigger = pos.lotTriggers[nextLotIdx];
          const triggerHit = pos.signal === 'BL'
            ? bar.high >= trigger
            : bar.low  <= trigger;

          if (triggerHit) {
            const fillPrice = trigger;  // limit order fills at trigger
            const shares    = pos.lotShares[nextLotIdx];
            const lotValue  = parseFloat((shares * fillPrice).toFixed(2));
            const lotName   = LOT_NAMES[nextLotIdx];
            const lotNum    = nextLotIdx + 1;

            // Per-lot entry cost (commission + slippage; borrow computed at exit)
            const entryComm  = calcCommission(shares, fillPrice);
            const entrySlip  = calcSlippageLeg(shares, fillPrice);

            pos.lots.push({
              lot:          lotNum,
              name:         lotName,
              pct:          LOT_PCT[nextLotIdx],
              fillDate:     bar.date,
              fillPrice,
              shares,
              lotValue,
              tradingDayAtFill: pos.tradingDays,
              entryComm,
              entrySlip,
            });

            // Update position averages
            pos.totalShares += shares;
            pos.totalCost   += shares * fillPrice;
            pos.avgCost      = parseFloat((pos.totalCost / pos.totalShares).toFixed(4));

            // ── Stop ratchet on lot fill ─────────────────────────────────
            let ratchetPrice = pos.stop;
            if (lotNum === 2) ratchetPrice = parseFloat(pos.avgCost.toFixed(2));       // → avg cost (breakeven)
            else if (lotNum === 3) ratchetPrice = pos.lots[0].fillPrice;                // → Lot 1 fill
            else if (lotNum === 4) ratchetPrice = pos.lots[1].fillPrice;                // → Lot 2 fill
            else if (lotNum === 5) ratchetPrice = pos.lots[2].fillPrice;                // → Lot 3 fill

            const ratchetTightens = pos.signal === 'BL'
              ? ratchetPrice > pos.stop
              : ratchetPrice < pos.stop;

            if (ratchetTightens) {
              pos.stop = parseFloat(ratchetPrice.toFixed(2));
              pos.stopHistory.push({ date: bar.date, stop: pos.stop, reason: `LOT${lotNum}_RATCHET` });
            }

            // Check if ratcheted stop immediately hit on this same bar
            if (pos.signal === 'BL' && bar.low <= pos.stop) {
              closePosition(pos, bar.date, pos.stop, 'STOP_HIT');
              break;
            }
            if (pos.signal === 'SS' && bar.high >= pos.stop) {
              closePosition(pos, bar.date, pos.stop, 'STOP_HIT');
              break;
            }
          }
        }
      }
    }

    // Remove closed positions — push to closedTrades
    for (const [ticker, pos] of openPositions) {
      if (pos.closed) {
        applyExitCosts(pos);
        closedTrades.push(pos);
        openPositions.delete(ticker);
      }
    }

    // ── Signal selection (NEW_ASYM_SS: BL top 10 + SS crash gate top 5) ────
    const weekScores = scoresByWeek[friday] || [];
    if (weekScores.length === 0) continue;

    let pool = weekScores.filter(s => !s.overextended && s.signal && s.entryPrice > 0);

    // MACRO gate
    if (regime) {
      pool = pool.filter(s => {
        const exc = (s.exchange || '').toUpperCase();
        const idxTicker = (exc === 'NASDAQ' || exc.includes('NASDAQ')) ? 'QQQ' : 'SPY';
        const idxKey = idxTicker.toLowerCase();
        const idx = regime[idxKey];
        if (!idx) return false;
        return s.signal === 'BL' ? idx.aboveEma : !idx.aboveEma;
      });
    }

    // SECTOR gate
    const sectorEma = sectorEmaByWeek[friday] || {};
    pool = pool.filter(s => {
      const etf = SECTOR_MAP[s.sector];
      if (!etf || !sectorEma[etf]) return true;
      return s.signal === 'BL' ? sectorEma[etf].blAligned : sectorEma[etf].ssAligned;
    });

    // D2 gate: sector return must be aligned (d2 ≥ 0)
    pool = pool.filter(s => (s.scores?.d2 ?? 0) >= 0);

    // SS CRASH gate: requires 2+ consecutive falling EMA weeks + sector -3% 5D
    pool = pool.filter(s => {
      if (s.signal !== 'SS') return true;
      const exc = (s.exchange || '').toUpperCase();
      const idxTicker = (exc === 'NASDAQ' || exc.includes('NASDAQ')) ? 'QQQ' : 'SPY';
      const slopeOk = slopeFallingMap[friday]?.[idxTicker] ?? false;
      if (!slopeOk) return false;
      const etf = SECTOR_MAP[s.sector];
      const sect5d = sector5dMap[friday]?.[etf] ?? 0;
      return sect5d <= -3;
    });

    // Re-rank and take top 10 BL + top 5 SS
    pool.sort((a, b) => b.apexScore - a.apexScore);
    let fRank = 0;
    for (const s of pool) { fRank++; s.filteredRank = fRank; }
    const blPool = pool.filter(s => s.signal === 'BL').slice(0, 10);
    const ssPool = pool.filter(s => s.signal === 'SS').slice(0, 5);
    const selected = [...blPool, ...ssPool];

    // ── Open new positions ─────────────────────────────────────────────────
    for (const score of selected) {
      const ticker = score.ticker;
      if (openPositions.has(ticker)) continue;

      const sig = signalMap[friday + '|' + ticker];
      const entryPrice = sig?.entryPrice || score.entryPrice;
      const stopPrice  = sig?.stopPrice  || score.stopPrice;
      if (!entryPrice || entryPrice <= 0) continue;

      const weekly = weeklyMap[ticker];
      if (!weekly) continue;

      const entryMonday = getMondayOf(friday);
      const entryBi = weekly.findIndex(b => b.weekStart === entryMonday);
      if (entryBi < 3) continue;

      const fallback = score.signal === 'BL' ? entryPrice * 0.95 : entryPrice * 1.05;
      const initStop  = parseFloat((stopPrice || fallback).toFixed(2));

      // Compute per-lot shares and trigger prices from Lot 1 anchor
      const fullShares = Math.floor(FULL_POSITION_USD / entryPrice);
      const lotShares  = LOT_PCT.map(pct => Math.max(1, Math.round(fullShares * pct)));
      const lotTriggers = LOT_OFFSET_PCT.map((off, i) =>
        score.signal === 'BL'
          ? parseFloat((entryPrice * (1 + off)).toFixed(2))
          : parseFloat((entryPrice * (1 - off)).toFixed(2))
      );

      // Lot 1 entry cost
      const lot1Shares = lotShares[0];
      const lot1Value  = parseFloat((lot1Shares * entryPrice).toFixed(2));
      const l1Comm     = calcCommission(lot1Shares, entryPrice);
      const l1Slip     = calcSlippageLeg(lot1Shares, entryPrice);

      openPositions.set(ticker, {
        // Identity
        ticker,
        signal:      score.signal,
        sector:      score.sector,
        exchange:    score.exchange,
        weekOf:      friday,
        entryDate:   friday,
        killRank:    score.killRank,
        filteredRank: score.filteredRank,
        apexScore:   score.apexScore,

        // Lot 1 (anchor)
        entryPrice,
        initialStop: initStop,
        stop:        initStop,
        stopHistory: [{ date: friday, stop: initStop, reason: 'INITIAL' }],

        // Pyramid state
        lots: [{
          lot: 1, name: LOT_NAMES[0], pct: LOT_PCT[0],
          fillDate: friday, fillPrice: entryPrice,
          shares: lot1Shares, lotValue: lot1Value,
          tradingDayAtFill: 0, entryComm: l1Comm, entrySlip: l1Slip,
        }],
        lotShares,
        lotTriggers,
        totalShares:   lot1Shares,
        totalCost:     lot1Shares * entryPrice,
        avgCost:       entryPrice,

        // Position tracking
        tradingDays:      0,
        lastCheckedDate:  friday,
        currentWeekIdx:   entryBi,
        mfe: 0, mae: 0,
        closed: false,
        exitDate: null, exitPrice: null, exitReason: null,
      });
    }

    if (weekNum % 20 === 0 || weekNum === allWeeks.length) {
      process.stdout.write(
        `\r  Week ${String(weekNum).padStart(4)}/${allWeeks.length} — ` +
        `${friday} — open: ${openPositions.size}, closed: ${closedTrades.length}  `
      );
    }
  }

  // ── Close remaining open positions ─────────────────────────────────────────
  for (const [ticker, pos] of openPositions) {
    const daily = candleMap[ticker];
    if (daily?.length > 0) {
      const last = daily[daily.length - 1];
      closePosition(pos, last.date, last.close, 'STILL_OPEN');
      applyExitCosts(pos);
    }
    closedTrades.push(pos);
    openPositions.delete(ticker);
  }

  console.log('\n');

  // ── Persist to MongoDB ─────────────────────────────────────────────────────
  console.log(`Persisting ${closedTrades.length} trades to pnthr_bt_pyramid_trade_log...`);
  await outputCol.deleteMany({});
  if (closedTrades.length > 0) {
    await outputCol.insertMany(closedTrades);
    await outputCol.createIndex({ weekOf: 1, ticker: 1 });
    await outputCol.createIndex({ signal: 1, entryDate: 1 });
    await outputCol.createIndex({ ticker: 1 });
  }
  console.log('  Done.\n');

  // ── Analysis ───────────────────────────────────────────────────────────────
  const closed   = closedTrades.filter(t => t.exitReason !== 'STILL_OPEN');
  const blTrades = closed.filter(t => t.signal === 'BL');
  const ssTrades = closed.filter(t => t.signal === 'SS');

  console.log('═'.repeat(80));
  console.log('  PNTHR PYRAMID BACKTEST — FULL D1-D8 SELECTION + 35/25/20/12/8% LOTS');
  console.log(`  Period:         ${allWeeks[0]} → ${allWeeks[allWeeks.length - 1]}`);
  console.log(`  Position size:  $${FULL_POSITION_USD.toLocaleString()} full / Lot 1 = ${(LOT_PCT[0]*100).toFixed(0)}% = $${(FULL_POSITION_USD*LOT_PCT[0]).toFixed(0)}`);
  console.log(`  Cost engine:    ${COST_METHODOLOGY.version} (${COST_METHODOLOGY.effectiveDate})`);
  console.log('═'.repeat(80));

  // Lot distribution
  const lotDist = [0, 0, 0, 0, 0];
  for (const t of closed) { if (t.lots?.length) lotDist[t.lots.length - 1]++; }
  console.log('\n── Lot Fill Distribution ──');
  const lotLabels = ['Lot 1 only', 'Lot 2 max', 'Lot 3 max', 'Lot 4 max', 'Lot 5 (full)'];
  for (let i = 0; i < 5; i++) {
    const pct = closed.length > 0 ? (lotDist[i] / closed.length * 100).toFixed(1) : '0.0';
    console.log(`  ${lotLabels[i].padEnd(14)}: ${String(lotDist[i]).padStart(5)} trades (${pct}%)`);
  }
  const avgLots = closed.length > 0
    ? closed.reduce((s, t) => s + (t.lots?.length || 1), 0) / closed.length
    : 0;
  console.log(`  Avg lots/trade : ${avgLots.toFixed(2)}`);

  // Trade statistics
  function tradeSummary(trades, label) {
    if (trades.length === 0) { console.log(`\n── ${label}: no trades`); return; }
    const wins   = trades.filter(t => t.netIsWinner);
    const losses = trades.filter(t => !t.netIsWinner);
    const totalNet   = trades.reduce((s, t) => s + (t.netDollarPnl || 0), 0);
    const totalGross = trades.reduce((s, t) => s + (t.grossDollarPnl || 0), 0);
    const totalFrict = trades.reduce((s, t) => s + (t.totalFrictionDollar || 0), 0);
    const avgPnl = trades.reduce((s, t) => s + (t.netProfitPct || 0), 0) / trades.length;
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + (t.netProfitPct || 0), 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + (t.netProfitPct || 0), 0) / losses.length : 0;
    const wlRatio = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : Infinity;

    console.log(`\n── ${label} (${trades.length} closed trades) ──`);
    console.log(`  Win rate:        ${(wins.length / trades.length * 100).toFixed(1)}%  (${wins.length}W / ${losses.length}L)`);
    console.log(`  Avg net P&L:     ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(2)}%`);
    console.log(`  Avg win:         +${avgWin.toFixed(2)}%   Avg loss: ${avgLoss.toFixed(2)}%`);
    console.log(`  Win/loss ratio:  ${wlRatio === Infinity ? '∞' : wlRatio.toFixed(2)}×`);
    console.log(`  Total gross P&L: $${totalGross.toFixed(0).toLocaleString()}`);
    console.log(`  Total friction:  -$${totalFrict.toFixed(0)} (${totalGross !== 0 ? (totalFrict / Math.abs(totalGross) * 100).toFixed(2) : '—'}% of gross)`);
    console.log(`  Total net P&L:   $${totalNet.toFixed(0).toLocaleString()}`);
  }

  tradeSummary(blTrades, 'BL (Longs)');
  tradeSummary(ssTrades, 'SS (Shorts)');
  tradeSummary(closed,   'Combined');

  // Monthly equity curve + institutional metrics
  console.log('\n── Monthly Equity Curve (Net-of-Costs) ──\n');
  const monthlyPnl = {};
  for (const t of closed) {
    if (!t.exitDate) continue;
    const m = t.exitDate.slice(0, 7);
    if (!monthlyPnl[m]) monthlyPnl[m] = 0;
    monthlyPnl[m] += (t.netDollarPnl || 0);
  }

  let equity = 100000;
  const months = Object.keys(monthlyPnl).sort();
  let peak = equity;
  let maxDD = 0, maxDDPeriod = '';
  let ddStart = months[0] || '';
  let positiveMonths = 0;
  const monthlyReturns = [];

  for (const m of months) {
    const prevEquity = equity;
    equity += monthlyPnl[m];
    const monthReturn = prevEquity > 0 ? (monthlyPnl[m] / prevEquity * 100) : 0;
    monthlyReturns.push(monthReturn);
    if (monthReturn > 0) positiveMonths++;
    if (equity > peak) { peak = equity; ddStart = m; }
    const dd = peak > 0 ? (peak - equity) / peak * 100 : 0;
    if (dd > maxDD) { maxDD = dd; maxDDPeriod = `${ddStart} to ${m}`; }
    process.stdout.write(`  ${m}: ${monthReturn >= 0 ? '+' : ''}${monthReturn.toFixed(2)}%  equity: $${equity.toFixed(0)}\n`);
  }

  // Sharpe / Sortino
  const avgMonthly = monthlyReturns.reduce((s, r) => s + r, 0) / (monthlyReturns.length || 1);
  const stdDev = Math.sqrt(
    monthlyReturns.reduce((s, r) => s + (r - avgMonthly) ** 2, 0) / Math.max(monthlyReturns.length - 1, 1)
  );
  const riskFreeMonthly = 5 / 12;
  const excessReturns = monthlyReturns.map(r => r - riskFreeMonthly);
  const avgExcess = excessReturns.reduce((s, r) => s + r, 0) / (excessReturns.length || 1);
  const downside = excessReturns.filter(r => r < 0);
  const downsideDev = downside.length > 0
    ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / downside.length)
    : 0.001;
  const sharpe  = stdDev  > 0 ? (avgExcess / stdDev)  * Math.sqrt(12) : 0;
  const sortino = downsideDev > 0 ? (avgExcess / downsideDev) * Math.sqrt(12) : 0;

  const yearsSpan = months.length / 12;
  const totalReturn = equity > 0 ? (equity - 100000) / 100000 * 100 : 0;
  const cagr = yearsSpan > 0 && equity > 0 ? (Math.pow(equity / 100000, 1 / yearsSpan) - 1) * 100 : 0;
  const calmar = maxDD > 0 ? cagr / maxDD : 0;

  const totalWon  = closed.filter(t => (t.netDollarPnl || 0) > 0).reduce((s, t) => s + t.netDollarPnl, 0);
  const totalLost = Math.abs(closed.filter(t => (t.netDollarPnl || 0) < 0).reduce((s, t) => s + t.netDollarPnl, 0));
  const profitFactor = totalLost > 0 ? totalWon / totalLost : Infinity;

  console.log('\n' + '═'.repeat(80));
  console.log('  INSTITUTIONAL METRICS — PYRAMID NET-OF-COSTS');
  console.log('═'.repeat(80));
  console.log(`  Starting capital:  $100,000`);
  console.log(`  Final equity:      $${equity.toFixed(0).toLocaleString()}`);
  console.log(`  Total return:      +${totalReturn.toFixed(1)}%`);
  console.log(`  CAGR:              +${cagr.toFixed(1)}%`);
  console.log(`  Sharpe ratio:      ${sharpe.toFixed(2)}`);
  console.log(`  Sortino ratio:     ${sortino.toFixed(2)}`);
  console.log(`  Max drawdown:      -${maxDD.toFixed(2)}% (${maxDDPeriod})`);
  console.log(`  Calmar ratio:      ${calmar.toFixed(2)}`);
  console.log(`  Profit factor:     ${profitFactor === Infinity ? '∞' : profitFactor.toFixed(2)}`);
  console.log(`  Positive months:   ${positiveMonths}/${months.length} (${months.length > 0 ? (positiveMonths/months.length*100).toFixed(1) : 0}%)`);
  console.log(`  Avg monthly:       +${avgMonthly.toFixed(2)}%`);
  console.log(`  Monthly std dev:   ${stdDev.toFixed(2)}%`);
  console.log(`  Avg lots/trade:    ${avgLots.toFixed(2)}`);

  console.log('\n' + '═'.repeat(80));
  console.log('  NEXT STEPS:');
  console.log('  1. node backtest/computeHedgeFundMetrics.js  (update full metrics store)');
  console.log('  2. node backtest/exportAuditLog.js           (update investor audit log)');
  console.log('═'.repeat(80) + '\n');

  process.exit(0);
}

// ── Close position helper ─────────────────────────────────────────────────────
function closePosition(pos, exitDate, exitPrice, exitReason) {
  if (pos.closed) return;
  pos.exitDate   = exitDate;
  pos.exitPrice  = parseFloat(exitPrice.toFixed(4));
  pos.exitReason = exitReason;
  pos.closed     = true;

  // Gross P&L per lot
  let totalGross = 0;
  for (const lot of pos.lots) {
    let lotGross;
    if (pos.signal === 'BL') lotGross = (pos.exitPrice - lot.fillPrice) * lot.shares;
    else                      lotGross = (lot.fillPrice - pos.exitPrice) * lot.shares;
    lot.grossDollarPnl = parseFloat(lotGross.toFixed(2));
    totalGross += lotGross;
  }

  pos.grossDollarPnl = parseFloat(totalGross.toFixed(2));
  pos.grossProfitPct = pos.avgCost > 0
    ? parseFloat(((pos.signal === 'BL'
        ? (pos.exitPrice - pos.avgCost) / pos.avgCost
        : (pos.avgCost - pos.exitPrice) / pos.avgCost) * 100).toFixed(2))
    : 0;
  pos.isWinner = pos.grossDollarPnl > 0;
}

// ── Apply exit costs (commission, slippage, borrow) to all lots ──────────────
function applyExitCosts(pos) {
  if (!pos.exitPrice || !pos.lots) return;

  let totalComm   = 0;
  let totalSlip   = 0;
  let totalBorrow = 0;

  for (const lot of pos.lots) {
    // Exit commission + slippage per lot
    const exitComm = calcCommission(lot.shares, pos.exitPrice);
    const exitSlip = calcSlippageLeg(lot.shares, pos.exitPrice);

    // Borrow cost for SS (per lot, based on holding days of this lot)
    let borrowCost = 0;
    if (pos.signal === 'SS') {
      const entryDate   = new Date(lot.fillDate + 'T12:00:00');
      const exitDateObj = new Date(pos.exitDate + 'T12:00:00');
      const calDays     = Math.max(1, Math.round((exitDateObj - entryDate) / 86400000));
      // Approximate trading days (0.71× calendar days)
      const tradDays    = Math.max(1, Math.round(calDays * 0.71));
      const borrowRate  = getBorrowRate(pos.sector);
      borrowCost = parseFloat((lot.shares * lot.fillPrice * borrowRate / 252 * tradDays).toFixed(2));
    }

    lot.exitComm   = exitComm;
    lot.exitSlip   = exitSlip;
    lot.borrowCost = borrowCost;
    lot.totalLotFriction = parseFloat((lot.entryComm + lot.entrySlip + exitComm + exitSlip + borrowCost).toFixed(2));
    lot.netDollarPnl = parseFloat((lot.grossDollarPnl - lot.totalLotFriction).toFixed(2));

    totalComm   += lot.entryComm + exitComm;
    totalSlip   += lot.entrySlip + exitSlip;
    totalBorrow += borrowCost;
  }

  pos.commissionTotal      = parseFloat(totalComm.toFixed(2));
  pos.slippageTotal        = parseFloat(totalSlip.toFixed(2));
  pos.borrowCostTotal      = parseFloat(totalBorrow.toFixed(2));
  pos.totalFrictionDollar  = parseFloat((totalComm + totalSlip + totalBorrow).toFixed(2));
  pos.netDollarPnl         = parseFloat(((pos.grossDollarPnl || 0) - pos.totalFrictionDollar).toFixed(2));
  pos.netProfitPct         = pos.avgCost > 0
    ? parseFloat((pos.netDollarPnl / (pos.totalShares * pos.avgCost) * 100).toFixed(2))
    : 0;
  pos.netIsWinner          = pos.netDollarPnl > 0;
}

// ── Cost functions delegated to costEngine.js ────────────────────────────────
// calcCommission, calcSlippage, getBorrowRate, calcBorrowCost all imported above.
// Per-leg slippage alias for clarity:
const calcSlippageLeg = calcSlippage;

main().catch(err => {
  console.error('\nFatal:', err.message);
  console.error(err.stack);
  process.exit(1);
});
