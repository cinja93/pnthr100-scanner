// server/ambush/ambushCron.js
// ── PNTHR AMBUSH V7 — Hourly Cron Processor ────────────────────────────────
//
// Runs at :05 past each hour from 10:35 to 16:05 ET (Mon-Fri).
//   - 10:35 ET → processes the 9:30-10:30 bar (captures first-hour low)
//   - 11:05 ET → processes the 10:30-11:30 bar (first after-hours check)
//   - ...
//   - 16:05 ET → processes the 15:30-16:00 bar (final bar of day)
//
// Data source: FMP /historical-chart/1hour/{ticker}
// Order execution: IBKR bridge via pnthr_ambush_outbox
//
// Flow per tick:
//   1. Fetch today's hourly bars for all tickers in any Ambush state
//      + all tickers with active weekly BL/SS signals (new entry candidates)
//   2. Load signal context (weekly signals, regime, sector gates)
//   3. Process existing positions (stops, lots, Break Even, trailing)
//   4. Process ATTACK positions (execute pending re-entries)
//   5. Process STALKING positions (check for tripwire break → ATTACK)
//   6. Scan for new MCE entries (fresh signals → STALKING)
//   7. Write state changes to MongoDB
//   8. Enqueue order commands to outbox
//
// The bridge polls pnthr_ambush_outbox and executes via IBKR TWS API.
// ────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from '../database.js';
import {
  STATES, BE_THRESHOLD, STRIKE_PCT, LOT_OFFSETS, SLIPPAGE_BPS,
  FIRST_HOUR_END, WITHDRAWAL_THRESHOLD, WITHDRAWAL_AMOUNT,
  isConfirmedGreenBreakout, isConfirmedRedBreakdown,
  entrySlip, exitSlip, extractTime, sizeLots,
  loadSignalContext, getRegime, getSectorOk, isActiveBL, isActiveSS,
  getWeeklyStopLong, getWeeklyStopShort, getAiTickers, getSectorName,
} from './ambushEngine.js';
import { calcCommission, calcBorrowCost } from '../backtest/costEngine.js';
import {
  getAmbushPositions, getAmbushPosition, upsertAmbushPosition,
  deleteAmbushPosition, logAmbushTrade, enqueueAmbushOrder,
  getAmbushConfig, updateAmbushConfig,
} from './ambushStateManager.js';

const FMP_API_KEY = process.env.FMP_API_KEY;

// ── FMP Hourly Bar Fetch ────────────────────────────────────────────────────
// Fetches today's hourly bars for a batch of tickers from FMP.
// FMP returns bars with dates like "2026-06-02 10:30:00"

async function fetchHourlyBars(tickers) {
  const barMap = {};
  const batchSize = 5; // parallel requests to avoid FMP rate limits

  for (let i = 0; i < tickers.length; i += batchSize) {
    const batch = tickers.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (ticker) => {
        try {
          const url = `https://financialmodelingprep.com/api/v3/historical-chart/1hour/${ticker}?apikey=${FMP_API_KEY}`;
          const resp = await fetch(url);
          if (!resp.ok) return { ticker, bars: [] };
          const data = await resp.json();
          // FMP returns newest first, reverse to chronological
          const bars = (Array.isArray(data) ? data : []).reverse().map(b => ({
            date: b.date,
            open: +b.open,
            high: +b.high,
            low: +b.low,
            close: +b.close,
            volume: +b.volume,
          }));
          return { ticker, bars };
        } catch (err) {
          console.error(`[Ambush] FMP fetch failed for ${ticker}:`, err.message);
          return { ticker, bars: [] };
        }
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        barMap[r.value.ticker] = r.value.bars;
      }
    }
  }
  return barMap;
}

// ── Today's date in ET ──────────────────────────────────────────────────────
function getTodayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function isMarketHours() {
  const now = new Date();
  const etOpts = { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false };
  const [hStr, mStr] = now.toLocaleString('en-US', etOpts).split(':');
  const mins = parseInt(hStr, 10) * 60 + parseInt(mStr, 10);
  const dow = now.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' });
  if (dow === 'Sat' || dow === 'Sun') return false;
  return mins >= 570 && mins <= 965; // 9:30 AM – 4:05 PM ET
}

// ── Main Cron Tick ──────────────────────────────────────────────────────────

export async function runAmbushTick() {
  const db = await connectToDatabase();
  if (!db) { console.error('[Ambush] No DB'); return { error: 'NO_DB' }; }

  const config = await getAmbushConfig(db);
  if (!config.enabled) {
    return { skipped: 'DISABLED' };
  }

  const today = getTodayET();
  const nav = config.nav || 83000;
  const maxPositions = config.maxPositions || 999;

  console.log(`[Ambush] Tick starting — ${today}, NAV: $${nav.toLocaleString()}`);

  // 1. Load signal context (weekly signals, regime, sectors)
  const ctx = await loadSignalContext(db);

  // 2. Get all current Ambush positions
  const allPositions = await getAmbushPositions(db);

  // 3. Determine which tickers need hourly bars
  const tickersNeeded = new Set();

  // All tickers currently in any state
  for (const pos of allPositions) tickersNeeded.add(pos.ticker);

  // All tickers with active BL or SS signals (potential new entries)
  for (const ticker of getAiTickers()) {
    if (isActiveBL(ctx, ticker, today) || isActiveSS(ctx, ticker, today)) {
      tickersNeeded.add(ticker);
    }
  }

  console.log(`[Ambush] Fetching hourly bars for ${tickersNeeded.size} tickers...`);
  const hourlyBars = await fetchHourlyBars([...tickersNeeded]);

  // Filter to today's bars only
  const todayBars = {};
  for (const [ticker, bars] of Object.entries(hourlyBars)) {
    const todayOnly = bars.filter(b => b.date.startsWith(today));
    if (todayOnly.length > 0) todayBars[ticker] = todayOnly;
  }

  console.log(`[Ambush] Got bars for ${Object.keys(todayBars).length} tickers today`);

  // Also need yesterday's daily bars for MCE 2-day breakout trigger
  // We'll use the hourly bars from yesterday if available, or skip MCE if not
  const yesterdayBars = {};
  for (const [ticker, bars] of Object.entries(hourlyBars)) {
    const yest = bars.filter(b => !b.date.startsWith(today));
    if (yest.length > 0) yesterdayBars[ticker] = yest;
  }

  const actions = [];   // { type, ticker, details }
  const errors = [];

  // ═══ PHASE A: Process existing ACTIVE + PROTECT positions ═══
  const activePositions = allPositions.filter(p =>
    p.state === STATES.ACTIVE || p.state === STATES.PROTECT
  );

  for (const pos of activePositions) {
    try {
      const hBars = todayBars[pos.ticker];
      if (!hBars || hBars.length === 0) continue;

      const isLong = pos.direction === 'LONG';

      // Get first-hour bars and after-first-hour bars
      const firstHourBars = hBars.filter(b => extractTime(b.date) < FIRST_HOUR_END);
      const afterFirstHour = hBars.filter(b => extractTime(b.date) >= FIRST_HOUR_END);

      // Capture today's first-hour low/high
      const firstHourLow = firstHourBars.length ? Math.min(...firstHourBars.map(b => b.low)) : null;
      const firstHourHigh = firstHourBars.length ? Math.max(...firstHourBars.map(b => b.high)) : null;

      // Trailing stop ratchet: use today's first-hour low/high
      if (pos.atBE && pos.trailingActive) {
        if (isLong && firstHourLow != null && firstHourLow > pos.stop) {
          const oldStop = pos.stop;
          pos.stop = +firstHourLow.toFixed(2);
          actions.push({ type: 'TRAILING_RATCHET', ticker: pos.ticker, from: oldStop, to: pos.stop });
          await enqueueAmbushOrder(db, 'MODIFY_STOP', {
            ticker: pos.ticker, direction: pos.direction,
            newStopPrice: pos.stop, shares: pos.totalShares,
          });
        }
        if (!isLong && firstHourHigh != null && firstHourHigh < pos.stop) {
          const oldStop = pos.stop;
          pos.stop = +firstHourHigh.toFixed(2);
          actions.push({ type: 'TRAILING_RATCHET', ticker: pos.ticker, from: oldStop, to: pos.stop });
          await enqueueAmbushOrder(db, 'MODIFY_STOP', {
            ticker: pos.ticker, direction: pos.direction,
            newStopPrice: pos.stop, shares: pos.totalShares,
          });
        }
      }

      // Process each after-first-hour bar
      let exited = false;
      let prevBarLow = pos.prevBarLow;
      let consecutiveLowerLows = pos.consecutiveLowerLows || 0;

      for (const hBar of afterFirstHour) {
        if (exited) break;

        // ── Check 1H low/high break (pre-trailing exit) ──
        if (isLong && !pos.trailingActive && firstHourLow != null && hBar.low < firstHourLow) {
          const exitPrice = exitSlip(firstHourLow, 'LONG');
          const comm = calcCommission(pos.totalShares, exitPrice);
          const pnl = +(pos.totalShares * exitPrice - comm - pos.totalShares * pos.avgCost).toFixed(2);

          await logAmbushTrade(db, {
            ticker: pos.ticker, direction: 'LONG', entryPrice: pos.avgCost,
            exitPrice, shares: pos.totalShares, pnl, entryDate: pos.entryDate,
            exitDate: today, exitType: '1H_LOW_BREAK', cycleNum: pos.cycleNum,
            commission: comm, peakProfit: pos.peak,
          });

          // Transition to STALKING (waiting for re-entry breakout)
          await upsertAmbushPosition(db, pos.ticker, {
            state: STATES.STALKING,
            direction: 'LONG',
            originalEntry: pos.originalEntry,
            runningLow: hBar.low,
            runningHigh: pos.runningHigh || hBar.high,
            cycleNum: (pos.cycleNum || 0) + 1,
            // Clear position fields
            entryPrice: null, avgCost: null, totalShares: 0,
            lotPlan: null, nextLot: 0, stop: null,
            atBE: false, trailingActive: false, beDate: null, peak: 0,
            firstHourLow: null, firstHourHigh: null,
            consecutiveLowerLows: 0, prevBarLow: null, prevBarHigh: null,
          });

          await enqueueAmbushOrder(db, 'SELL_EXIT', {
            ticker: pos.ticker, shares: pos.totalShares, direction: 'LONG',
            reason: '1H_LOW_BREAK',
          });

          actions.push({ type: '1H_EXIT', ticker: pos.ticker, pnl });
          exited = true;
          break;
        }

        if (!isLong && !pos.trailingActive && firstHourHigh != null && hBar.high > firstHourHigh) {
          const exitPrice = exitSlip(firstHourHigh, 'SHORT');
          const comm = calcCommission(pos.totalShares, exitPrice);
          // Calculate trading days held for borrow cost
          const entryD = pos.entryDate ? new Date(pos.entryDate) : new Date();
          const exitD = new Date(today);
          const tradingDays = Math.max(1, Math.round((exitD - entryD) / 86400000 * 5 / 7));
          const borrow = calcBorrowCost(pos.totalShares, pos.avgCost, tradingDays, getSectorName(pos.ticker));
          const pnl = +(pos.totalShares * (pos.avgCost - exitPrice) - comm - borrow).toFixed(2);

          await logAmbushTrade(db, {
            ticker: pos.ticker, direction: 'SHORT', entryPrice: pos.avgCost,
            exitPrice, shares: pos.totalShares, pnl, entryDate: pos.entryDate,
            exitDate: today, exitType: '1H_HIGH_BREAK', cycleNum: pos.cycleNum,
            commission: comm, borrow, peakProfit: pos.peak,
          });

          await upsertAmbushPosition(db, pos.ticker, {
            state: STATES.STALKING,
            direction: 'SHORT',
            originalEntry: pos.originalEntry,
            runningLow: pos.runningLow || hBar.low,
            runningHigh: hBar.high,
            cycleNum: (pos.cycleNum || 0) + 1,
            entryPrice: null, avgCost: null, totalShares: 0,
            lotPlan: null, nextLot: 0, stop: null,
            atBE: false, trailingActive: false, beDate: null, peak: 0,
            firstHourLow: null, firstHourHigh: null,
            consecutiveLowerLows: 0, prevBarLow: null, prevBarHigh: null,
          });

          await enqueueAmbushOrder(db, 'COVER_EXIT', {
            ticker: pos.ticker, shares: pos.totalShares, direction: 'SHORT',
            reason: '1H_HIGH_BREAK',
          });

          actions.push({ type: '1H_EXIT', ticker: pos.ticker, pnl });
          exited = true;
          break;
        }

        // ── Trailing stop check (2-bar consecutive lower lows) ──
        if (pos.trailingActive && isLong) {
          if (prevBarLow !== null && hBar.low < prevBarLow && hBar.low <= pos.stop) {
            consecutiveLowerLows++;
          } else if (prevBarLow !== null && hBar.low < prevBarLow) {
            consecutiveLowerLows = 1;
          } else {
            consecutiveLowerLows = 0;
          }
          if (consecutiveLowerLows >= 2) {
            const exitPrice = exitSlip(pos.stop, 'LONG');
            const comm = calcCommission(pos.totalShares, exitPrice);
            const pnl = +(pos.totalShares * exitPrice - comm - pos.totalShares * pos.avgCost).toFixed(2);

            await logAmbushTrade(db, {
              ticker: pos.ticker, direction: 'LONG', entryPrice: pos.avgCost,
              exitPrice, shares: pos.totalShares, pnl, entryDate: pos.entryDate,
              exitDate: today, exitType: 'TRAILING_STOP', cycleNum: pos.cycleNum,
              commission: comm, peakProfit: pos.peak,
            });

            await upsertAmbushPosition(db, pos.ticker, {
              state: STATES.STALKING,
              direction: 'LONG',
              originalEntry: pos.originalEntry,
              runningLow: hBar.low, runningHigh: pos.runningHigh || hBar.high,
              cycleNum: (pos.cycleNum || 0) + 1,
              entryPrice: null, avgCost: null, totalShares: 0,
              lotPlan: null, nextLot: 0, stop: null,
              atBE: false, trailingActive: false, beDate: null, peak: 0,
              firstHourLow: null, firstHourHigh: null,
              consecutiveLowerLows: 0, prevBarLow: null, prevBarHigh: null,
            });

            await enqueueAmbushOrder(db, 'SELL_EXIT', {
              ticker: pos.ticker, shares: pos.totalShares, direction: 'LONG',
              reason: 'TRAILING_STOP',
            });

            actions.push({ type: 'TRAILING_EXIT', ticker: pos.ticker, pnl });
            exited = true;
            break;
          }
        }

        // SHORT trailing stop (2-bar consecutive higher highs)
        if (pos.trailingActive && !isLong) {
          const prevHH = pos.prevBarHigh;
          if (prevHH !== undefined && prevHH !== null && hBar.high > prevHH && hBar.high >= pos.stop) {
            consecutiveLowerLows++; // reusing counter for shorts (consecutive HH)
          } else if (prevHH !== undefined && prevHH !== null && hBar.high > prevHH) {
            consecutiveLowerLows = 1;
          } else {
            consecutiveLowerLows = 0;
          }
          if (consecutiveLowerLows >= 2) {
            const exitPrice = exitSlip(pos.stop, 'SHORT');
            const comm = calcCommission(pos.totalShares, exitPrice);
            // Calculate trading days held for borrow cost
            const entryD = pos.entryDate ? new Date(pos.entryDate) : new Date();
            const exitD = new Date(today);
            const tradingDays = Math.max(1, Math.round((exitD - entryD) / 86400000 * 5 / 7));
            const borrow = calcBorrowCost(pos.totalShares, pos.avgCost, tradingDays, getSectorName(pos.ticker));
            const pnl = +(pos.totalShares * (pos.avgCost - exitPrice) - comm - borrow).toFixed(2);

            await logAmbushTrade(db, {
              ticker: pos.ticker, direction: 'SHORT', entryPrice: pos.avgCost,
              exitPrice, shares: pos.totalShares, pnl, entryDate: pos.entryDate,
              exitDate: today, exitType: 'TRAILING_STOP', cycleNum: pos.cycleNum,
              commission: comm, borrow, peakProfit: pos.peak,
            });

            await upsertAmbushPosition(db, pos.ticker, {
              state: STATES.STALKING,
              direction: 'SHORT',
              originalEntry: pos.originalEntry,
              runningLow: pos.runningLow || hBar.low, runningHigh: hBar.high,
              cycleNum: (pos.cycleNum || 0) + 1,
              entryPrice: null, avgCost: null, totalShares: 0,
              lotPlan: null, nextLot: 0, stop: null,
              atBE: false, trailingActive: false, beDate: null, peak: 0,
              firstHourLow: null, firstHourHigh: null,
              consecutiveLowerLows: 0, prevBarLow: null, prevBarHigh: null,
            });

            await enqueueAmbushOrder(db, 'COVER_EXIT', {
              ticker: pos.ticker, shares: pos.totalShares, direction: 'SHORT',
              reason: 'TRAILING_STOP',
            });

            actions.push({ type: 'TRAILING_EXIT', ticker: pos.ticker, pnl });
            exited = true;
            break;
          }
        }

        // ── Lot trigger check ──
        if (pos.nextLot <= 4) {
          const offset = LOT_OFFSETS[pos.nextLot];
          const lotTrigger = isLong
            ? +(pos.originalEntry * (1 + offset)).toFixed(2)
            : +(pos.originalEntry * (1 - offset)).toFixed(2);
          const triggered = isLong ? hBar.high >= lotTrigger : hBar.low <= lotTrigger;

          if (triggered && pos.lotPlan) {
            const lotShares = pos.lotPlan[pos.nextLot];
            const fillPrice = isLong ? entrySlip(lotTrigger, 'LONG') : entrySlip(lotTrigger, 'SHORT');

            const oldCost = pos.avgCost * pos.totalShares;
            pos.totalShares += lotShares;
            pos.avgCost = +((oldCost + fillPrice * lotShares) / pos.totalShares).toFixed(4);
            pos.nextLot++;

            // If at Break Even, recalculate stop with new avg cost
            if (pos.atBE) {
              const feePer = calcCommission(pos.totalShares, pos.avgCost) / pos.totalShares;
              pos.stop = isLong
                ? +(pos.avgCost + feePer).toFixed(2)
                : +(pos.avgCost - feePer).toFixed(2);
            }

            actions.push({
              type: 'LOT_FILL', ticker: pos.ticker,
              lot: pos.nextLot - 1, shares: lotShares, price: fillPrice,
            });

            await enqueueAmbushOrder(db, 'PLACE_LOT_TRIGGER', {
              ticker: pos.ticker, direction: pos.direction,
              lot: pos.nextLot - 1, shares: lotShares, triggerPrice: lotTrigger,
            });
          }
        }

        // ── Break Even check ──
        const unr = isLong
          ? (hBar.high - pos.avgCost) * pos.totalShares
          : (pos.avgCost - hBar.low) * pos.totalShares;
        if (unr > (pos.peak || 0)) pos.peak = +unr.toFixed(2);

        if (!pos.atBE && unr >= BE_THRESHOLD) {
          pos.atBE = true;
          pos.trailingActive = false;
          pos.beDate = today;
          const feePer = calcCommission(pos.totalShares, pos.avgCost) / pos.totalShares;
          pos.stop = isLong
            ? +(pos.avgCost + feePer).toFixed(2)
            : +(pos.avgCost - feePer).toFixed(2);
          pos.state = STATES.PROTECT;

          actions.push({ type: 'BREAK_EVEN', ticker: pos.ticker, stop: pos.stop });

          await enqueueAmbushOrder(db, 'MODIFY_STOP', {
            ticker: pos.ticker, direction: pos.direction,
            newStopPrice: pos.stop, shares: pos.totalShares,
            reason: 'BREAK_EVEN',
          });
        }

        // Activate trailing on next day after Break Even
        if (pos.atBE && !pos.trailingActive && pos.beDate && pos.beDate !== today) {
          pos.trailingActive = true;
          actions.push({ type: 'TRAILING_ACTIVATED', ticker: pos.ticker });
        }

        prevBarLow = hBar.low;
      }

      // Save position state if not exited
      if (!exited) {
        await upsertAmbushPosition(db, pos.ticker, {
          state: pos.atBE ? STATES.PROTECT : STATES.ACTIVE,
          stop: pos.stop,
          avgCost: pos.avgCost,
          totalShares: pos.totalShares,
          nextLot: pos.nextLot,
          atBE: pos.atBE,
          trailingActive: pos.trailingActive,
          beDate: pos.beDate,
          peak: pos.peak,
          consecutiveLowerLows: consecutiveLowerLows,
          prevBarLow: prevBarLow,
          prevBarHigh: hBars[hBars.length - 1]?.high || pos.prevBarHigh,
          firstHourLow,
          firstHourHigh,
          lastBarDate: hBars[hBars.length - 1]?.date,
        });
      }
    } catch (err) {
      errors.push({ ticker: pos.ticker, error: err.message });
      console.error(`[Ambush] Error processing ${pos.ticker}:`, err.message);
    }
  }

  // ═══ PHASE B: Process ATTACK positions (execute pending re-entries) ═══
  const attackPositions = allPositions.filter(p => p.state === STATES.ATTACK);

  for (const pend of attackPositions) {
    try {
      const hBars = todayBars[pend.ticker];
      if (!hBars || hBars.length === 0) continue;

      const activeCount = (await getAmbushPositions(db)).filter(p =>
        p.state === STATES.ACTIVE || p.state === STATES.PROTECT
      ).length;
      if (activeCount >= maxPositions) {
        actions.push({ type: 'SKIPPED_CAP', ticker: pend.ticker });
        continue;
      }

      const isLong = pend.direction === 'LONG';
      const firstAfterOpen = hBars.find(b => extractTime(b.date) >= FIRST_HOUR_END) || hBars[0];
      const rePrice = isLong
        ? entrySlip(firstAfterOpen.open, 'LONG')
        : entrySlip(firstAfterOpen.open, 'SHORT');
      const reStop = isLong
        ? +((pend.runningLow || firstAfterOpen.low) - 0.01).toFixed(2)
        : +((pend.runningHigh || firstAfterOpen.high) + 0.01).toFixed(2);

      if (isLong && reStop >= rePrice) { await deleteAmbushPosition(db, pend.ticker); continue; }
      if (!isLong && reStop <= rePrice) { await deleteAmbushPosition(db, pend.ticker); continue; }

      const sizing = sizeLots(rePrice, reStop, pend.direction, nav);
      if (!sizing) { await deleteAmbushPosition(db, pend.ticker); continue; }

      // Transition ATTACK → ACTIVE
      await upsertAmbushPosition(db, pend.ticker, {
        state: STATES.ACTIVE,
        direction: pend.direction,
        entryPrice: rePrice,
        avgCost: rePrice,
        totalShares: sizing.l1Shares,
        lotPlan: sizing.lotPlan,
        nextLot: 1,
        originalEntry: pend.originalEntry || rePrice,
        stop: reStop,
        atBE: false,
        trailingActive: false,
        beDate: null,
        peak: 0,
        cycleNum: pend.cycleNum || 0,
        entryDate: today,
        runningLow: pend.runningLow,
        runningHigh: pend.runningHigh,
        consecutiveLowerLows: 0,
        prevBarLow: null,
        prevBarHigh: null,
        firstHourLow: null,
        firstHourHigh: null,
        lastBarDate: firstAfterOpen.date,
      });

      await enqueueAmbushOrder(db, isLong ? 'BUY_ENTRY' : 'SHORT_ENTRY', {
        ticker: pend.ticker, shares: sizing.l1Shares, price: rePrice,
        direction: pend.direction, stopPrice: reStop,
        lotPlan: sizing.lotPlan, rps: sizing.rps,
      });

      actions.push({
        type: 'RE_ENTRY', ticker: pend.ticker, direction: pend.direction,
        shares: sizing.l1Shares, price: rePrice, stop: reStop,
        cycle: pend.cycleNum,
      });
    } catch (err) {
      errors.push({ ticker: pend.ticker, error: err.message });
    }
  }

  // ═══ PHASE C: Process STALKING positions (check for breakout → ATTACK) ═══
  const stalkingPositions = allPositions.filter(p => p.state === STATES.STALKING);

  for (const stalk of stalkingPositions) {
    try {
      const hBars = todayBars[stalk.ticker];
      if (!hBars || hBars.length < 2) continue;

      const isLong = stalk.direction === 'LONG';

      // Check if weekly signal is still active
      if (isLong && !isActiveBL(ctx, stalk.ticker, today)) {
        await deleteAmbushPosition(db, stalk.ticker);
        actions.push({ type: 'SIGNAL_EXPIRED', ticker: stalk.ticker });
        continue;
      }
      if (!isLong && !isActiveSS(ctx, stalk.ticker, today)) {
        await deleteAmbushPosition(db, stalk.ticker);
        actions.push({ type: 'SIGNAL_EXPIRED', ticker: stalk.ticker });
        continue;
      }

      // Check regime
      const regime = getRegime(ctx, stalk.ticker, today);
      if (isLong && !regime) continue;
      if (!isLong && regime) continue;

      // Check sector
      if (!getSectorOk(ctx, stalk.ticker, today)) continue;

      const afterFirst = hBars.filter(b => extractTime(b.date) >= FIRST_HOUR_END);
      if (afterFirst.length < 2) continue;

      // Look for confirmed breakout/breakdown
      for (let i = 1; i < afterFirst.length; i++) {
        const bar = afterFirst[i], prevBar = afterFirst[i - 1];
        if (isLong ? isConfirmedGreenBreakout(bar, prevBar) : isConfirmedRedBreakdown(bar, prevBar)) {
          // Transition STALKING → ATTACK (queue entry for next bar open)
          await upsertAmbushPosition(db, stalk.ticker, {
            state: STATES.ATTACK,
            direction: stalk.direction,
            originalEntry: stalk.originalEntry,
            runningLow: stalk.runningLow || bar.low,
            runningHigh: stalk.runningHigh || bar.high,
            cycleNum: stalk.cycleNum || 0,
          });

          actions.push({
            type: 'BREAKOUT_DETECTED', ticker: stalk.ticker,
            direction: stalk.direction, bar: bar.date,
          });
          break;
        }

        // Update running low/high
        if (bar.low < (stalk.runningLow || Infinity)) stalk.runningLow = bar.low;
        if (bar.high > (stalk.runningHigh || -Infinity)) stalk.runningHigh = bar.high;
      }
    } catch (err) {
      errors.push({ ticker: stalk.ticker, error: err.message });
    }
  }

  // ═══ PHASE D: New MCE entries (fresh signals entering STALKING) ═══
  // Only scan tickers not already in any Ambush state
  const existingTickers = new Set(allPositions.map(p => p.ticker));

  for (const ticker of getAiTickers()) {
    if (existingTickers.has(ticker)) continue;

    try {
      const hBars = todayBars[ticker];
      if (!hBars || hBars.length < 2) continue;

      const regime = getRegime(ctx, ticker, today);
      if (!getSectorOk(ctx, ticker, today)) continue;

      const afterFirst = hBars.filter(b => extractTime(b.date) >= FIRST_HOUR_END);
      if (afterFirst.length < 2) continue;

      let direction = null;
      if (regime && isActiveBL(ctx, ticker, today)) direction = 'LONG';
      else if (!regime && isActiveSS(ctx, ticker, today)) direction = 'SHORT';
      if (!direction) continue;

      // Check for confirmed breakout in today's after-first-hour bars
      let breakoutFound = false;
      for (let i = 1; i < afterFirst.length; i++) {
        const bar = afterFirst[i], prevBar = afterFirst[i - 1];
        if (direction === 'LONG' && isConfirmedGreenBreakout(bar, prevBar)) {
          breakoutFound = true;
          break;
        }
        if (direction === 'SHORT' && isConfirmedRedBreakdown(bar, prevBar)) {
          breakoutFound = true;
          break;
        }
      }

      if (!breakoutFound) continue;

      // Check for 2-day breakout trigger (MCE condition from backtest)
      // Need yesterday's high/low
      const yesterdayH = yesterdayBars[ticker];
      if (!yesterdayH || yesterdayH.length === 0) continue;

      const yestHigh = Math.max(...yesterdayH.map(b => b.high));
      const yestLow = Math.min(...yesterdayH.map(b => b.low));
      const todayHigh = Math.max(...hBars.map(b => b.high));
      const todayLow = Math.min(...hBars.map(b => b.low));

      if (direction === 'LONG' && todayHigh <= yestHigh) continue;
      if (direction === 'SHORT' && todayLow >= yestLow) continue;

      // Calculate entry price and stop
      const ep = direction === 'LONG'
        ? entrySlip(Math.max(hBars[0].open, yestHigh + 0.01), 'LONG')
        : entrySlip(Math.min(hBars[0].open, yestLow - 0.01), 'SHORT');

      const stop = direction === 'LONG'
        ? getWeeklyStopLong(ctx, ticker, today, ep)
        : getWeeklyStopShort(ctx, ticker, today, ep);

      if (!stop) continue;
      if (direction === 'LONG' && stop >= ep) continue;
      if (direction === 'SHORT' && stop <= ep) continue;

      const sizing = sizeLots(ep, stop, direction, nav);
      if (!sizing) continue;

      // Check position count
      const currentActive = (await getAmbushPositions(db)).filter(p =>
        p.state === STATES.ACTIVE || p.state === STATES.PROTECT
      ).length;
      if (currentActive >= maxPositions) continue;

      // Create new ACTIVE position
      await upsertAmbushPosition(db, ticker, {
        state: STATES.ACTIVE,
        direction,
        entryPrice: ep,
        avgCost: ep,
        totalShares: sizing.l1Shares,
        lotPlan: sizing.lotPlan,
        nextLot: 1,
        originalEntry: ep,
        stop,
        atBE: false,
        trailingActive: false,
        beDate: null,
        peak: 0,
        cycleNum: 0,
        entryDate: today,
        runningLow: todayLow,
        runningHigh: todayHigh,
        consecutiveLowerLows: 0,
        prevBarLow: null,
        prevBarHigh: null,
        firstHourLow: null,
        firstHourHigh: null,
        lastBarDate: hBars[hBars.length - 1].date,
      });

      await enqueueAmbushOrder(db, direction === 'LONG' ? 'BUY_ENTRY' : 'SHORT_ENTRY', {
        ticker, shares: sizing.l1Shares, price: ep,
        direction, stopPrice: stop,
        lotPlan: sizing.lotPlan, rps: sizing.rps,
      });

      actions.push({
        type: 'NEW_ENTRY', ticker, direction,
        shares: sizing.l1Shares, price: ep, stop,
      });
    } catch (err) {
      errors.push({ ticker, error: err.message });
    }
  }

  // ═══ Update config with last run info ═══
  const result = {
    date: today,
    tickersFetched: tickersNeeded.size,
    barsReceived: Object.keys(todayBars).length,
    actions,
    errors,
    positions: {
      active: activePositions.length,
      attack: attackPositions.length,
      stalking: stalkingPositions.length,
    },
  };

  await updateAmbushConfig(db, {
    lastCronRun: new Date(),
    lastCronResult: result,
  });

  console.log(`[Ambush] Tick complete — ${actions.length} actions, ${errors.length} errors`);
  return result;
}
