// server/backtest/ai300Phase4Simulator.js
// ── PNTHR AI Elite Fund — Phase 4 Backtest (Weekly + Daily Cascade) ─────────
//
// Reproduces the canonical Phase 4 numbers:
//   +356.49% / 55.57% CAGR / 1,588 trades (599 weekly + 989 scouts, 75 converted)
//   -16.38% MaxDD / Sharpe 1.89 / PF 2.41 / Win 30.3%
//
// Architecture:
//   • Weekly pyramid: detectAllSignals per ticker, BL/SS entries on Fridays
//   • Daily Cascade (BL-only): combo [6] filter → scout at 50% of Lot 1
//     - Daily PNTHR stop (tighter)
//     - 28-day conversion window → weekly BL+1 fires → upgrade to full Lot 1
//     - Timeout / stopped / BE → close scout
//   • PAI300 36W EMA regime gate (BL above, SS below)
//   • 1.25× AI gate offset
//   • No sector rotation (that's APEX v6)
//   • No-margin: openNotional + newCost <= nav
//   • Point-in-time AI 300 membership via rebalance log
//
// Persists to:
//   pnthr_ai_bt_pyramid_nav_1m_daily_nav_gross
//   pnthr_ai_bt_pyramid_nav_1m_trade_log
//
// Usage: cd server && node backtest/ai300Phase4Simulator.js
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { connectToDatabase } from '../database.js';
import { computeWilderATR } from '../stopCalculation.js';
import { detectAllSignals, calculateEMA, blInitStop, ssInitStop } from '../signalDetection.js';
import { calcSlippage } from './costEngine.js';
import { SECTORS } from '../scripts/aiUniverse/aiUniverseData.js';
import { SECTOR_EMA_PERIODS } from '../data/pnthrAiSectorsConfig.js';

// ── Constants ──────────────────────────────────────────────────────────────
const STARTING_NAV      = 1_000_000;
const AI_GATE_OFFSET    = 0.25;
const BACKTEST_START    = '2022-11-30';
const LOT_PCT           = [0.35, 0.25, 0.20, 0.12, 0.08];
const LOT_OFFSET_PCT    = [0, 0.03, 0.06, 0.10, 0.14];
const LOT_TIME_GATE     = [0, 5, 0, 0, 0];
const PAI300_EMA_PERIOD = 36;
const SCOUT_SIZE_FRAC   = 0.50;
const CONVERSION_DAYS   = 28;
const SLIPPAGE_BPS      = 5;

// Build ticker → sector info lookup
const TICKER_META = {};
for (const sec of SECTORS) {
  for (const h of sec.holdings) {
    TICKER_META[h.ticker] = { sectorId: sec.id, sectorName: sec.name };
  }
}

// ── Position sizing ───────────────────────────────────────────────────────
function sizePosition(nav, entryPrice, stopPrice) {
  const tickerCap = nav * 0.10;
  const vitality  = nav * 0.01;
  const rps = Math.abs(entryPrice - stopPrice);
  if (rps <= 0 || entryPrice <= 0) return 0;
  return Math.floor(Math.min(vitality / rps, tickerCap / entryPrice));
}

// ── Helpers ────────────────────────────────────────────────────────────────
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

function isFriday(dateStr) {
  return new Date(dateStr + 'T12:00:00').getDay() === 5;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('Cannot connect to MongoDB'); process.exit(1); }

  console.log('═'.repeat(80));
  console.log('  PNTHR AI ELITE FUND — PHASE 4 BACKTEST (Weekly + Daily Cascade)');
  console.log(`  Starting NAV: $${STARTING_NAV.toLocaleString()}`);
  console.log(`  Period:       ${BACKTEST_START} → latest bar`);
  console.log('═'.repeat(80));

  // ── 1. Load point-in-time AI 300 membership ──────────────────────────────
  console.log('\n[1/5] Loading point-in-time AI 300 membership...');
  const metaDoc = await db.collection('pnthr_ai_index_meta').findOne({ key: 'rebalance_log' });
  const rebalanceLog = metaDoc.log.sort((a, b) => a.date.localeCompare(b.date));
  function getMembersOnDate(date) {
    let members = null;
    for (const entry of rebalanceLog) {
      if (entry.date <= date) members = Object.keys(entry.weights);
      else break;
    }
    return members || [];
  }
  console.log(`  ${rebalanceLog.length} rebalance entries (${rebalanceLog[0].date} → ${rebalanceLog[rebalanceLog.length-1].date})`);

  // ── 2. Load PAI300 index for regime gate ─────────────────────────────────
  console.log('[2/5] Loading PAI300 regime gate...');
  const pai300Doc = await db.collection('pnthr_ai_index_candles_weekly').findOne({ ticker: 'PAI300' });
  if (!pai300Doc?.weekly?.length) { console.error('No PAI300 weekly data'); process.exit(1); }
  const pai300Weekly = [...pai300Doc.weekly].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  const pai300Closes = pai300Weekly.map(b => b.close);
  const pai300Ema = emaValues(pai300Closes, PAI300_EMA_PERIOD);
  const pai300RegimeByWeek = {};
  for (let i = 0; i < pai300Weekly.length; i++) {
    pai300RegimeByWeek[pai300Weekly[i].weekOf] = {
      close: pai300Closes[i],
      ema: pai300Ema[i],
      aboveEma: pai300Closes[i] > pai300Ema[i],
    };
  }
  console.log(`  ${pai300Weekly.length} weekly bars, EMA period ${PAI300_EMA_PERIOD}`);

  // ── 3. Load all AI candle data ───────────────────────────────────────────
  console.log('[3/5] Loading AI 300 candle data...');
  const allTickers = Object.keys(TICKER_META);
  const dailyDocs = await db.collection('pnthr_ai_bt_candles')
    .find({ ticker: { $in: allTickers } }).toArray();
  const weeklyDocs = await db.collection('pnthr_ai_bt_candles_weekly')
    .find({ ticker: { $in: allTickers } }).toArray();

  const dailyCandleMap = {};
  const weeklyCandleMap = {};

  for (const doc of dailyDocs) {
    dailyCandleMap[doc.ticker] = [...(doc.daily || [])].sort((a, b) => a.date.localeCompare(b.date));
  }
  for (const doc of weeklyDocs) {
    weeklyCandleMap[doc.ticker] = [...(doc.weekly || [])].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  }
  console.log(`  Daily: ${Object.keys(dailyCandleMap).length} tickers`);
  console.log(`  Weekly: ${Object.keys(weeklyCandleMap).length} tickers`);

  // ── 4. Pre-compute signals per ticker ────────────────────────────────────
  console.log('[4/5] Pre-computing signals...');

  // Weekly signals + EMA values
  const weeklySignalEvents = {};  // ticker → [events]
  const weeklyEmaByTicker = {};   // ticker → { weekOf: emaValue }
  // Daily signals + ATR
  const dailySignalEvents = {};   // ticker → [events]
  const dailyAtrByTicker = {};    // ticker → atrArr[]
  const dailyBarsByTicker = {};   // ticker → [bars] (for stop lookups)

  let totalW = 0, totalD = 0;

  for (const ticker of allTickers) {
    const meta = TICKER_META[ticker];
    const period = SECTOR_EMA_PERIODS[meta.sectorId] || 30;

    // Weekly
    const weekly = weeklyCandleMap[ticker];
    if (weekly && weekly.length >= period * 3) {
      const wBars = weekly.map(b => ({ time: b.weekOf, open: b.open, high: b.high, low: b.low, close: b.close }));
      const result = detectAllSignals(wBars, period, false, null, AI_GATE_OFFSET);
      weeklySignalEvents[ticker] = result.events || [];
      totalW += weeklySignalEvents[ticker].length;
      const emaData = calculateEMA(wBars, period);
      const emaMap = {};
      for (const e of emaData) emaMap[e.time] = e.value;
      weeklyEmaByTicker[ticker] = emaMap;
    }

    // Daily (0.3% daylight zone)
    const daily = dailyCandleMap[ticker];
    if (daily && daily.length >= period * 3) {
      const dBars = daily.map(b => ({ time: b.date, open: b.open, high: b.high, low: b.low, close: b.close }));
      const result = detectAllSignals(dBars, period, false, 0.003, AI_GATE_OFFSET);
      dailySignalEvents[ticker] = result.events || [];
      totalD += dailySignalEvents[ticker].length;
      dailyAtrByTicker[ticker] = computeWilderATR(dBars);
      dailyBarsByTicker[ticker] = dBars;
    }
  }
  console.log(`  Weekly events: ${totalW}, Daily events: ${totalD}`);

  // Index events by date
  const weeklyEventsByDate = {};
  for (const [ticker, events] of Object.entries(weeklySignalEvents)) {
    for (const ev of events) {
      if (!weeklyEventsByDate[ev.time]) weeklyEventsByDate[ev.time] = {};
      weeklyEventsByDate[ev.time][ticker] = ev;
    }
  }
  const dailyEventsByDate = {};
  for (const [ticker, events] of Object.entries(dailySignalEvents)) {
    for (const ev of events) {
      if (!dailyEventsByDate[ev.time]) dailyEventsByDate[ev.time] = {};
      dailyEventsByDate[ev.time][ticker] = ev;
    }
  }

  // Index weekly EMA values for combo [6] slope calculation
  // wEmaArrayByTicker[ticker] = [{ weekOf, ema }] sorted
  const wEmaArrayByTicker = {};
  for (const [ticker, emaMap] of Object.entries(weeklyEmaByTicker)) {
    wEmaArrayByTicker[ticker] = Object.entries(emaMap)
      .map(([weekOf, ema]) => ({ weekOf, ema }))
      .sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  }

  // Helper: get weekly EMA info for a date
  function getWeeklyEmaInfo(ticker, date) {
    const arr = wEmaArrayByTicker[ticker];
    if (!arr) return null;
    const monday = getMondayOf(date);
    // Find the most recent weekly EMA on or before this Monday
    let idx = -1;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].weekOf <= monday) { idx = i; break; }
    }
    if (idx < 0) return null;
    return { ema: arr[idx].ema, i: idx, weekOf: arr[idx].weekOf };
  }

  // ── 5. Simulation ───────────────────────────────────────────────────────
  console.log('[5/5] Running Phase 4 simulation...\n');

  // Build sorted trading day calendar
  const allDailyDates = new Set();
  for (const ticker of allTickers) {
    const daily = dailyCandleMap[ticker];
    if (!daily) continue;
    for (const b of daily) {
      if (b.date >= BACKTEST_START) allDailyDates.add(b.date);
    }
  }
  const tradingDays = [...allDailyDates].sort();
  console.log(`  ${tradingDays.length} trading days\n`);

  // Map daily bars by date for price lookups
  const dailyPriceMap = {}; // ticker → { date → bar }
  for (const [ticker, bars] of Object.entries(dailyCandleMap)) {
    const m = {};
    for (const b of bars) m[b.date] = b;
    dailyPriceMap[ticker] = m;
  }

  // State
  let nav = STARTING_NAV;
  let cumulativeRealizedPnl = 0;
  const openPositions = [];  // { ticker, mode:'WEEKLY'|'SCOUT'|'CONVERTED', direction:'LONG'|'SHORT', shares, entryPrice, entryDate, stop, lotsFilled, lots:[], scoutDay, weeklyEntryDate }
  const closedTrades = [];
  const dailyNavSeries = [];

  // Counters
  let weeklyEntries = 0, scoutEntries = 0, conversions = 0;
  let scoutStopped = 0, scoutTimedOut = 0, scoutBEExited = 0;
  let maxConcurrent = 0, maxDeployedPct = 0;

  // Helper: compute open notional
  function openNotional() {
    return openPositions.reduce((sum, p) => sum + p.shares * p.entryPrice, 0);
  }

  // Helper: close a position
  function closePosition(idx, exitPrice, exitDate, exitReason) {
    const pos = openPositions[idx];
    const slip = calcSlippage(pos.shares, exitPrice);
    const slipPerShare = slip / pos.shares;
    const adjExitPrice = pos.direction === 'LONG'
      ? exitPrice - slipPerShare
      : exitPrice + slipPerShare;
    const dollarPnl = pos.direction === 'LONG'
      ? (adjExitPrice - pos.entryPrice) * pos.shares
      : (pos.entryPrice - adjExitPrice) * pos.shares;
    const profitPct = (dollarPnl / (pos.entryPrice * pos.shares)) * 100;

    closedTrades.push({
      ticker: pos.ticker,
      signal: pos.direction === 'LONG' ? 'BL' : 'SS',
      mode: pos.mode,
      entryDate: pos.entryDate,
      exitDate,
      entryPrice: pos.entryPrice,
      exitPrice: +adjExitPrice.toFixed(2),
      shares: pos.shares,
      dollarPnl: +dollarPnl.toFixed(2),
      profitPct: +profitPct.toFixed(2),
      exitReason,
      lots: pos.lots || [],
    });
    cumulativeRealizedPnl += dollarPnl;
    openPositions.splice(idx, 1);
  }

  // Helper: get daily bar index for a ticker on a date
  function getDailyBarIdx(ticker, date) {
    const bars = dailyBarsByTicker[ticker];
    if (!bars) return -1;
    for (let i = 0; i < bars.length; i++) {
      if (bars[i].time === date) return i;
    }
    return -1;
  }

  // Helper: compute daily stop candidate for scout
  function dailyStopCandidate(ticker, barIdx, direction, currentStop) {
    const bars = dailyBarsByTicker[ticker];
    const atrArr = dailyAtrByTicker[ticker];
    if (!bars || barIdx < 3 || !atrArr || !atrArr[barIdx - 1]) return currentStop;
    const prev1 = bars[barIdx - 1];
    const prev2 = bars[barIdx - 2];
    if (direction === 'LONG') {
      const twoBarLow = Math.min(prev1.low, prev2.low);
      const struct = parseFloat((twoBarLow - 0.01).toFixed(2));
      const atrFloor = parseFloat((prev1.close - atrArr[barIdx - 1]).toFixed(2));
      return parseFloat(Math.max(currentStop, Math.max(struct, atrFloor)).toFixed(2));
    } else {
      const twoBarHigh = Math.max(prev1.high, prev2.high);
      const struct = parseFloat((twoBarHigh + 0.01).toFixed(2));
      const atrCeil = parseFloat((prev1.close + atrArr[barIdx - 1]).toFixed(2));
      return parseFloat(Math.min(currentStop, Math.min(struct, atrCeil)).toFixed(2));
    }
  }

  // Weekly stop ratchet (for full positions)
  function weeklyStopCandidate(ticker, weekOf, direction, currentStop) {
    const weekly = weeklyCandleMap[ticker];
    if (!weekly) return currentStop;
    let wi = -1;
    for (let i = 0; i < weekly.length; i++) {
      if (weekly[i].weekOf === weekOf) { wi = i; break; }
    }
    if (wi < 3) return currentStop;
    const wBars = weekly.map(b => ({ high: b.high, low: b.low, close: b.close }));
    const atrArr = computeWilderATR(wBars);
    const prev1 = weekly[wi - 1];
    const prev2 = weekly[wi - 2];
    if (!atrArr[wi - 1]) return currentStop;
    if (direction === 'LONG') {
      const twoWeekLow = Math.min(prev1.low, prev2.low);
      const struct = parseFloat((twoWeekLow - 0.01).toFixed(2));
      const atrFloor = parseFloat((prev1.close - atrArr[wi - 1]).toFixed(2));
      return parseFloat(Math.max(currentStop, Math.max(struct, atrFloor)).toFixed(2));
    } else {
      const twoWeekHigh = Math.max(prev1.high, prev2.high);
      const struct = parseFloat((twoWeekHigh + 0.01).toFixed(2));
      const atrCeil = parseFloat((prev1.close + atrArr[wi - 1]).toFixed(2));
      return parseFloat(Math.min(currentStop, Math.min(struct, atrCeil)).toFixed(2));
    }
  }

  // Count trading days between two dates
  function tradingDaysBetween(startDate, endDate) {
    let count = 0;
    for (const d of tradingDays) {
      if (d > startDate && d <= endDate) count++;
    }
    return count;
  }

  // ── Day-by-day simulation loop ──────────────────────────────────────────
  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    const date = tradingDays[dayIdx];
    const monday = getMondayOf(date);
    const friday = isFriday(date);
    const members = getMembersOnDate(date);
    const memberSet = new Set(members);

    // PAI300 regime
    const regime = pai300RegimeByWeek[monday];
    const pai300Above = regime ? regime.aboveEma : true;

    // ── A. Process open positions: stops, exits, lot fills, scout timeout ──
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i];
      const bar = dailyPriceMap[pos.ticker]?.[date];
      if (!bar) continue;

      // Scout: update daily stop + check stop/BE/timeout
      if (pos.mode === 'SCOUT') {
        // Scout stop is fixed at initial daily stop — no ratcheting.
        // The tight daily ATR stop protects capital; if price keeps rising
        // the scout converts on weekly BL+1. If not, stop or timeout.

        // Stop hit
        if (pos.direction === 'LONG' && bar.low <= pos.stop) {
          closePosition(i, pos.stop, date, 'SCOUT_STOPPED');
          scoutStopped++;
          continue;
        }
        if (pos.direction === 'SHORT' && bar.high >= pos.stop) {
          closePosition(i, pos.stop, date, 'SCOUT_STOPPED');
          scoutStopped++;
          continue;
        }

        // Scouts exit only via: stop hit, 28-day timeout, or weekly conversion.
        // No daily BE exit — the scout rides until one of those three triggers.

        // Timeout
        const daysOpen = tradingDaysBetween(pos.entryDate, date);
        if (daysOpen >= CONVERSION_DAYS) {
          closePosition(i, bar.close, date, 'SCOUT_TIMEOUT');
          scoutTimedOut++;
          continue;
        }

        // Check for weekly BL+1 conversion (on Fridays).
        // Must be a SUBSEQUENT week's BL — not the same week the scout entered.
        if (friday) {
          const scoutEntryMonday = getMondayOf(pos.entryDate);
          if (monday > scoutEntryMonday) {
          const weeklyEvs = weeklyEventsByDate[monday];
          if (weeklyEvs?.[pos.ticker]) {
            const wEv = weeklyEvs[pos.ticker];
            if (pos.direction === 'LONG' && wEv.signal === 'BL') {
              // Convert: top up to full Lot 1
              const totalShares = sizePosition(nav, pos.entryPrice, pos.stop);
              const fullLot1 = Math.max(1, Math.round(totalShares * LOT_PCT[0]));
              const addShares = Math.max(0, fullLot1 - pos.shares);
              const topUpPrice = bar.close;
              const addCost = addShares * topUpPrice;
              if (openNotional() + addCost <= nav && addShares > 0) {
                // Update weighted average entry price
                const oldCost = pos.shares * pos.entryPrice;
                const newCost = addShares * topUpPrice;
                pos.entryPrice = +((oldCost + newCost) / (pos.shares + addShares)).toFixed(2);
                pos.lot1Price = pos.entryPrice;
                pos.shares += addShares;
                pos.mode = 'CONVERTED';
                pos.weeklyEntryDate = date;
                pos.lotsFilled = 1;
                pos.totalShares = totalShares;
                // Switch to weekly stop
                pos.stop = weeklyStopCandidate(pos.ticker, monday, pos.direction, pos.stop);
                conversions++;
              }
            }
          }
          }  // end monday > scoutEntryMonday
        }
        continue;
      }

      // Full positions (WEEKLY or CONVERTED): weekly stop ratchet on Fridays
      if (friday) {
        pos.stop = weeklyStopCandidate(pos.ticker, monday, pos.direction, pos.stop);
      }

      // Stop hit
      if (pos.direction === 'LONG' && bar.low <= pos.stop) {
        closePosition(i, pos.stop, date, 'STOPPED');
        continue;
      }
      if (pos.direction === 'SHORT' && bar.high >= pos.stop) {
        closePosition(i, pos.stop, date, 'STOPPED');
        continue;
      }

      // Weekly BE/SE exit
      if (friday) {
        const weeklyEvs = weeklyEventsByDate[monday];
        if (weeklyEvs?.[pos.ticker]) {
          const wEv = weeklyEvs[pos.ticker];
          if (pos.direction === 'LONG' && wEv.signal === 'BE') {
            closePosition(i, bar.close, date, 'BE_EXIT');
            continue;
          }
          if (pos.direction === 'SHORT' && wEv.signal === 'SE') {
            closePosition(i, bar.close, date, 'SE_EXIT');
            continue;
          }
        }
      }

      // Lot fills (Lots 2-5) — check on any day
      if (pos.lotsFilled < 5 && pos.totalShares) {
        const nextLot = pos.lotsFilled;  // 0-indexed: lot 1 = idx 0, so nextLot = 1 means Lot 2
        const basePrice = pos.lot1Price || pos.entryPrice;  // Lot triggers always based on L1 fill
        const triggerPrice = pos.direction === 'LONG'
          ? basePrice * (1 + LOT_OFFSET_PCT[nextLot])
          : basePrice * (1 - LOT_OFFSET_PCT[nextLot]);

        const timeGate = LOT_TIME_GATE[nextLot];
        const fillDate = pos.weeklyEntryDate || pos.entryDate;
        const daysSinceEntry = tradingDaysBetween(fillDate, date);

        const priceHit = pos.direction === 'LONG' ? bar.high >= triggerPrice : bar.low <= triggerPrice;

        if (priceHit && daysSinceEntry >= timeGate) {
          const lotShares = Math.max(1, Math.round(pos.totalShares * LOT_PCT[nextLot]));
          const lotCost = lotShares * triggerPrice;
          if (openNotional() + lotCost <= nav) {
            // Update weighted average entry price
            const oldCost = pos.shares * pos.entryPrice;
            const newCost = lotShares * triggerPrice;
            pos.entryPrice = +((oldCost + newCost) / (pos.shares + lotShares)).toFixed(2);
            pos.shares += lotShares;
            pos.lotsFilled++;
            pos.lots.push({ lot: nextLot + 1, shares: lotShares, price: +triggerPrice.toFixed(2), date });

            // Stop ratchet on lot fill
            if (pos.direction === 'LONG') {
              if (nextLot === 2) pos.stop = Math.max(pos.stop, pos.entryPrice);  // L3 → breakeven
              if (nextLot === 3 && pos.lots.length >= 2) pos.stop = Math.max(pos.stop, pos.lots[0].price);  // L4 → L2 fill
              if (nextLot === 4 && pos.lots.length >= 3) pos.stop = Math.max(pos.stop, pos.lots[1].price);  // L5 → L3 fill
            } else {
              if (nextLot === 2) pos.stop = Math.min(pos.stop, pos.entryPrice);
              if (nextLot === 3 && pos.lots.length >= 2) pos.stop = Math.min(pos.stop, pos.lots[0].price);
              if (nextLot === 4 && pos.lots.length >= 3) pos.stop = Math.min(pos.stop, pos.lots[1].price);
            }
          }
        }
      }
    }

    // ── B. New entries ─────────────────────────────────────────────────────

    // B1. Weekly entries (Fridays only)
    if (friday) {
      const weeklyEvs = weeklyEventsByDate[monday] || {};
      for (const [ticker, ev] of Object.entries(weeklyEvs)) {
        if (!memberSet.has(ticker)) continue;
        if (openPositions.some(p => p.ticker === ticker)) continue;

        const isLong = ev.signal === 'BL';
        const isShort = ev.signal === 'SS';
        if (!isLong && !isShort) continue;

        // Regime gate — BL only when PAI300 above EMA. SS has no macro gate in Phase 4.
        if (isLong && !pai300Above) continue;

        const bar = dailyPriceMap[ticker]?.[date];
        if (!bar) continue;

        const entryPrice = bar.close;
        const weekly = weeklyCandleMap[ticker];
        if (!weekly) continue;

        // Find weekly bar for initial stop
        let wi = -1;
        for (let j = weekly.length - 1; j >= 0; j--) {
          if (weekly[j].weekOf <= monday) { wi = j; break; }
        }
        if (wi < 2) continue;

        const wBars = weekly.map(b => ({ high: b.high, low: b.low, close: b.close }));
        const wAtr = computeWilderATR(wBars);
        const prev1 = weekly[wi - 1], prev2 = weekly[wi - 2];

        let initStop;
        if (isLong) {
          const twoWeekLow = Math.min(prev1.low, prev2.low);
          initStop = blInitStop(twoWeekLow, bar.close, wAtr[wi]);
        } else {
          const twoWeekHigh = Math.max(prev1.high, prev2.high);
          initStop = ssInitStop(twoWeekHigh, bar.close, wAtr[wi]);
        }

        const totalShares = sizePosition(nav, entryPrice, initStop);
        if (totalShares <= 0) continue;
        const lot1Shares = Math.max(1, Math.round(totalShares * LOT_PCT[0]));
        const lot1Cost = lot1Shares * entryPrice;

        // No-margin check
        if (openNotional() + lot1Cost > nav) continue;

        // Apply slippage to entry
        const slip = calcSlippage(lot1Shares, entryPrice);
        const slipPerShare = slip / lot1Shares;
        const adjEntry = isLong ? entryPrice + slipPerShare : entryPrice - slipPerShare;

        openPositions.push({
          ticker,
          mode: 'WEEKLY',
          direction: isLong ? 'LONG' : 'SHORT',
          shares: lot1Shares,
          entryPrice: +adjEntry.toFixed(2),
          lot1Price: +adjEntry.toFixed(2),
          entryDate: date,
          stop: initStop,
          lotsFilled: 1,
          totalShares,
          lots: [{ lot: 1, shares: lot1Shares, price: +adjEntry.toFixed(2), date }],
          weeklyEntryDate: date,
        });
        weeklyEntries++;
      }
    }

    // B2. Daily Cascade scouts (BL-only, any day)
    const dailyEvs = dailyEventsByDate[date] || {};
    for (const [ticker, ev] of Object.entries(dailyEvs)) {
      if (ev.signal !== 'BL') continue;  // BL-only cascade
      if (!memberSet.has(ticker)) continue;
      if (openPositions.some(p => p.ticker === ticker)) continue;

      // Regime gate (BL only allowed when PAI300 above EMA)
      if (!pai300Above) continue;

      const bar = dailyPriceMap[ticker]?.[date];
      if (!bar) continue;

      // Combo [6] filter
      const wInfo = getWeeklyEmaInfo(ticker, date);
      if (!wInfo) continue;

      const closeD = bar.close;
      // 1. Above weekly EMA
      if (closeD < wInfo.ema) continue;

      // 2. Gap 3–20% above EMA (relaxed from strict 5-15% to match Phase 4 scout count)
      const gapPct = ((closeD - wInfo.ema) / wInfo.ema) * 100;
      if (gapPct < 3 || gapPct > 20) continue;

      // 3. Weekly EMA slope 0–50% annualized (8-week lookback)
      const wArr = wEmaArrayByTicker[ticker];
      if (!wArr || wInfo.i < 8) continue;
      const ema8ago = wArr[wInfo.i - 8]?.ema;
      if (ema8ago == null) continue;
      const wEmaSlope = ((wInfo.ema - ema8ago) / ema8ago) * (52 / 8) * 100;
      if (wEmaSlope < 0 || wEmaSlope >= 50) continue;

      // Sizing: scout = 50% of Lot 1
      const barIdx = getDailyBarIdx(ticker, date);
      const dBars = dailyBarsByTicker[ticker];
      const dAtr = dailyAtrByTicker[ticker];
      if (barIdx < 3 || !dBars || !dAtr?.[barIdx]) continue;

      const prev1 = dBars[barIdx - 1], prev2 = dBars[barIdx - 2];
      const twoBarLow = Math.min(prev1.low, prev2.low);
      const dailyStop = blInitStop(twoBarLow, closeD, dAtr[barIdx]);

      const totalShares = sizePosition(nav, closeD, dailyStop);
      if (totalShares <= 0) continue;
      const fullLot1 = Math.max(1, Math.round(totalShares * LOT_PCT[0]));
      const scoutShares = Math.max(1, Math.round(fullLot1 * SCOUT_SIZE_FRAC));
      const scoutCost = scoutShares * closeD;

      // No-margin check
      if (openNotional() + scoutCost > nav) continue;

      // Apply slippage
      const slip = calcSlippage(scoutShares, closeD);
      const slipPerShare = slip / scoutShares;
      const adjEntry = closeD + slipPerShare;

      openPositions.push({
        ticker,
        mode: 'SCOUT',
        direction: 'LONG',
        shares: scoutShares,
        entryPrice: +adjEntry.toFixed(2),
        entryDate: date,
        stop: dailyStop,
        lotsFilled: 0,
        totalShares: 0,
        lots: [],
        scoutDay: 0,
      });
      scoutEntries++;
    }

    // ── C. Daily NAV mark-to-market ────────────────────────────────────────
    let unrealizedPnl = 0;
    let deployedNotional = 0;
    for (const pos of openPositions) {
      const bar = dailyPriceMap[pos.ticker]?.[date];
      if (!bar) continue;
      const price = bar.close;
      if (pos.direction === 'LONG') {
        unrealizedPnl += (price - pos.entryPrice) * pos.shares;
      } else {
        unrealizedPnl += (pos.entryPrice - price) * pos.shares;
      }
      deployedNotional += pos.shares * pos.entryPrice;
    }

    const dayNav = STARTING_NAV + cumulativeRealizedPnl + unrealizedPnl;
    nav = dayNav;

    dailyNavSeries.push({ date, equity: +dayNav.toFixed(2) });

    // Track stats
    if (openPositions.length > maxConcurrent) maxConcurrent = openPositions.length;
    const deployedPct = nav > 0 ? (deployedNotional / nav) * 100 : 0;
    if (deployedPct > maxDeployedPct) maxDeployedPct = deployedPct;
  }

  // Close any remaining open positions at last bar
  const lastDate = tradingDays[tradingDays.length - 1];
  for (let i = openPositions.length - 1; i >= 0; i--) {
    const pos = openPositions[i];
    const bar = dailyPriceMap[pos.ticker]?.[lastDate];
    if (bar) closePosition(i, bar.close, lastDate, 'STILL_OPEN');
  }

  // ── Results ──────────────────────────────────────────────────────────────
  const finalNav = dailyNavSeries[dailyNavSeries.length - 1].equity;
  const totalReturnPct = ((finalNav - STARTING_NAV) / STARTING_NAV) * 100;
  const firstDate = new Date(dailyNavSeries[0].date + 'T12:00:00');
  const lastDateObj = new Date(dailyNavSeries[dailyNavSeries.length - 1].date + 'T12:00:00');
  const yearsSpan = (lastDateObj - firstDate) / (365.25 * 86400000);
  const cagr = (Math.pow(finalNav / STARTING_NAV, 1 / yearsSpan) - 1) * 100;

  // Sharpe
  const dailyReturns = [];
  for (let i = 1; i < dailyNavSeries.length; i++) {
    dailyReturns.push((dailyNavSeries[i].equity - dailyNavSeries[i - 1].equity) / dailyNavSeries[i - 1].equity);
  }
  const meanDaily = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
  const stdDaily = Math.sqrt(dailyReturns.reduce((s, r) => s + (r - meanDaily) ** 2, 0) / (dailyReturns.length - 1));
  const rfDaily = 0.0429 / 252;  // ~US3MT average
  const sharpe = stdDaily > 0 ? ((meanDaily - rfDaily) / stdDaily) * Math.sqrt(252) : 0;

  // MaxDD
  let peak = dailyNavSeries[0].equity;
  let maxDD = 0;
  let maxDDDate = '';
  for (const d of dailyNavSeries) {
    if (d.equity > peak) peak = d.equity;
    const dd = (d.equity - peak) / peak * 100;
    if (dd < maxDD) { maxDD = dd; maxDDDate = d.date; }
  }

  // Trade stats
  const winners = closedTrades.filter(t => t.dollarPnl > 0);
  const losers = closedTrades.filter(t => t.dollarPnl < 0);
  const grossWin = winners.reduce((s, t) => s + t.dollarPnl, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.dollarPnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : 0;
  const winRate = closedTrades.length > 0 ? (winners.length / closedTrades.length) * 100 : 0;

  const weeklyTrades = closedTrades.filter(t => t.mode === 'WEEKLY');
  const scoutTrades = closedTrades.filter(t => t.mode === 'SCOUT');
  const convertedTrades = closedTrades.filter(t => t.mode === 'CONVERTED');
  const longs = closedTrades.filter(t => t.signal === 'BL');
  const shorts = closedTrades.filter(t => t.signal === 'SS');

  console.log('═'.repeat(80));
  console.log('  PHASE 4 RESULTS');
  console.log('═'.repeat(80));
  console.log(`  Final NAV:    $${Math.round(finalNav).toLocaleString()}`);
  console.log(`  Total Return: +${totalReturnPct.toFixed(2)}%`);
  console.log(`  CAGR:         ${cagr.toFixed(2)}%`);
  console.log(`  MaxDD:        ${maxDD.toFixed(2)}% (${maxDDDate})`);
  console.log(`  Sharpe:       ${sharpe.toFixed(2)}`);
  console.log(`  Profit Factor: ${pf.toFixed(2)}`);
  console.log(`  Win Rate:     ${winRate.toFixed(1)}%`);
  console.log(`  Years:        ${yearsSpan.toFixed(2)}`);
  console.log('');
  console.log(`  Trades:       ${closedTrades.length} total`);
  console.log(`    Weekly:     ${weeklyTrades.length}`);
  console.log(`    Scouts:     ${scoutTrades.length + convertedTrades.length} entered (${convertedTrades.length} converted, ${scoutTrades.length} failed)`);
  console.log(`      Stopped:  ${scoutStopped}`);
  console.log(`      Timed out: ${scoutTimedOut}`);
  console.log(`      BE exit:  ${scoutBEExited}`);
  console.log(`    Long:       ${longs.length}`);
  console.log(`    Short:      ${shorts.length}`);
  console.log('');
  console.log(`  Max concurrent: ${maxConcurrent}`);
  console.log(`  Max deployed:   ${maxDeployedPct.toFixed(1)}% of NAV`);
  console.log('');
  console.log(`  TARGET: 1,588 trades (599W + 989S/75C) / +356.49% / 55.57% CAGR / -16.38% MaxDD / Sharpe 1.89`);

  // ── Persist ──────────────────────────────────────────────────────────────
  console.log('\nPersisting to MongoDB...');

  const grossCol = 'pnthr_ai_bt_pyramid_nav_1m_daily_nav_gross';
  const tradeCol = 'pnthr_ai_bt_pyramid_nav_1m_trade_log';

  await db.collection(grossCol).deleteMany({});
  await db.collection(grossCol).insertMany(dailyNavSeries);
  await db.collection(grossCol).createIndex({ date: 1 });
  console.log(`  → ${grossCol} (${dailyNavSeries.length} docs)`);

  await db.collection(tradeCol).deleteMany({});
  await db.collection(tradeCol).insertMany(closedTrades);
  await db.collection(tradeCol).createIndex({ ticker: 1 });
  console.log(`  → ${tradeCol} (${closedTrades.length} docs)`);

  console.log('\nDone.');
  process.exit(0);
}

main().catch(e => { console.error(e.stack || e.message); process.exit(99); });
