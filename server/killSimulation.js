// server/killSimulation.js
// ── PNTHR Kill 10 — Pyramid Simulation Engine ────────────────────────────────
//
// Simulates the full 5-lot PNTHR Command pyramid strategy on Kill top 10 case
// studies. Uses EXACT formulas from:
//   sizingUtils.js       → STRIKE_PCT, LOT_OFFSETS, LOT_TIME_GATES
//   stopCalculation.js   → computeWilderATR, blInitStop, ssInitStop
//   signalService.js     → BE/SE detection, weekly stop ratchet
//   commandCenter.js     → FEAST RSI > 85 / < 15 → sell 50%
//   apexService.js       → OVEREXTENDED (closeSepPct > 20, killScore = -99)
//
// The simulation timeline (lot fills, exits) is price-driven and NAV-independent.
// The client scales shares + dollar P&L based on selected NAV.
// ─────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';
import { computeWilderATR, blInitStop, ssInitStop } from './stopCalculation.js';
import { aggregateWeeklyBars } from './technicalUtils.js';

const FMP_API_KEY  = process.env.FMP_API_KEY;
const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';

// ── Constants (exact match to sizingUtils.js) ────────────────────────────────

const STRIKE_PCT     = [0.35, 0.25, 0.20, 0.12, 0.08];
const LOT_OFFSETS    = [0, 0.03, 0.06, 0.10, 0.14];
const LOT_TIME_GATES = [0, 5, 0, 0, 0]; // 5-day gate for Lot 2 only

// ── RSI (standard 14-period Wilder smoothing) ────────────────────────────────

function computeRSI(closes) {
  const period = 14;
  if (closes.length < period + 1) return null;

  const changes = [];
  for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);

  // Seed: simple average of first `period` gains/losses
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder smoothing through remaining changes
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

// ── Get Monday of a date's week ──────────────────────────────────────────────

function getWeekMonday(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const dow = d.getDay();
  const daysToMon = dow === 0 ? -6 : 1 - dow;
  const mon = new Date(d);
  mon.setDate(d.getDate() + daysToMon);
  return mon.toISOString().split('T')[0];
}

// ── Fetch daily candles (cache → FMP fallback) ───────────────────────────────

async function getDailyCandles(db, ticker) {
  // Try cache first
  const cached = await db.collection('pnthr_candle_cache').findOne({ ticker });
  if (cached?.daily?.length > 0) {
    // Check if we have 2026 data
    const has2026 = cached.daily.some(c => c.date?.startsWith('2026'));
    if (has2026) {
      return [...cached.daily].sort((a, b) => a.date.localeCompare(b.date));
    }
  }

  // Fallback: fetch from FMP and cache
  if (!FMP_API_KEY) {
    console.warn(`[KILL SIM] No FMP_API_KEY, cannot backfill ${ticker}`);
    return [];
  }
  const url = `${FMP_BASE_URL}/historical-price-full/${ticker}?from=2025-10-01&to=2026-04-30&apikey=${FMP_API_KEY}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`FMP ${res.status}`);
    const data = await res.json();
    const daily = data?.historical || [];
    if (daily.length > 0) {
      await db.collection('pnthr_candle_cache').updateOne(
        { ticker },
        { $set: { ticker, daily, cachedAt: new Date() } },
        { upsert: true }
      );
    }
    return [...daily].sort((a, b) => a.date.localeCompare(b.date));
  } catch (err) {
    console.error(`[KILL SIM] FMP fetch failed for ${ticker}:`, err.message);
    return [];
  }
}

// ── Count trading days (Mon–Fri) between two dates ───────────────────────────

function tradingDaysBetween(dailyBars, fromDate, toDate) {
  return dailyBars.filter(b => b.date > fromDate && b.date <= toDate).length;
}

// ── Simulate one Kill case study trade ───────────────────────────────────────

function simulateTrade(trade, allDaily, weeklySnapshots) {
  const isLong  = trade.direction === 'LONG';
  const isShort = !isLong;

  // Filter daily bars: need ~60 days before entry for RSI warmup, through latest
  const entryIdx = allDaily.findIndex(b => b.date >= trade.entryDate);
  if (entryIdx < 0) return null;

  // Start 60 bars before entry for RSI warmup
  const warmupStart = Math.max(0, entryIdx - 60);
  const daily = allDaily.slice(warmupStart);
  const entryBarIdx = daily.findIndex(b => b.date >= trade.entryDate);

  // Build weekly bars from ALL available daily data (need history for ATR)
  const weeklyBars = aggregateWeeklyBars(
    [...allDaily].sort((a, b) => b.date.localeCompare(a.date)), // descending for aggregateWeeklyBars
    { includeVolume: false }
  );
  const atrArr = computeWilderATR(weeklyBars, 3);

  // ── Initialize position ──────────────────────────────────────────────
  const anchor = trade.entryPrice;
  let currentStop = trade.stopPrice; // Already computed via blInitStop/ssInitStop

  // Lot trigger prices
  const triggerPrices = LOT_OFFSETS.map(off =>
    isLong
      ? parseFloat((anchor * (1 + off)).toFixed(2))
      : parseFloat((anchor * (1 - off)).toFixed(2))
  );

  // Track lot fills
  const lots = []; // { lot, fillDate, fillPrice, pctOfTotal }
  let lastLotFillDay = 0; // trading day index of last lot fill

  // Lot 1 fills at entry
  lots.push({ lot: 1, fillDate: trade.entryDate, fillPrice: trade.entryPrice, pctOfTotal: STRIKE_PCT[0] });

  // FEAST tracking
  let feastExit = null;
  let feastTriggered = false;

  // Final exit
  let finalExit = null;

  // Weekly tracking for BE/SE and ATR ratchet
  let currentWeekMonday = getWeekMonday(trade.entryDate);
  let currentWeekBar = { high: -Infinity, low: Infinity, close: null, open: null };
  let prevCompletedWeeks = []; // last 2 completed weekly bars

  // Build prevCompletedWeeks from weekly bars before entry
  const entryWeekMonday = getWeekMonday(trade.entryDate);
  const priorWeeks = weeklyBars.filter(w => w.weekStart < entryWeekMonday);
  if (priorWeeks.length >= 2) {
    prevCompletedWeeks = priorWeeks.slice(-2);
  }

  // Stop history for debugging
  const stopHistory = [{ date: trade.entryDate, stop: currentStop, reason: 'INIT' }];

  // ── Walk daily bars from entry ─────────────────────────────────────────
  let tradingDayCount = 0;

  for (let i = entryBarIdx; i < daily.length; i++) {
    const bar = daily[i];
    tradingDayCount++;

    const barWeekMonday = getWeekMonday(bar.date);

    // ── New week boundary? ─────────────────────────────────────────────
    if (barWeekMonday !== currentWeekMonday && tradingDayCount > 1) {
      // Complete the previous week
      if (currentWeekBar.close !== null) {
        const completedWeek = {
          weekStart: currentWeekMonday,
          high: currentWeekBar.high,
          low: currentWeekBar.low,
          close: currentWeekBar.close,
          open: currentWeekBar.open,
        };
        prevCompletedWeeks.push(completedWeek);
        if (prevCompletedWeeks.length > 2) prevCompletedWeeks.shift();

        // ── ATR ratchet (weekly) ─────────────────────────────────────
        if (prevCompletedWeeks.length >= 2) {
          const prev1 = prevCompletedWeeks[prevCompletedWeeks.length - 1];
          const prev2 = prevCompletedWeeks[prevCompletedWeeks.length - 2];
          // Find ATR for the completed week
          const wIdx = weeklyBars.findIndex(w => w.weekStart === completedWeek.weekStart);
          const prevAtr = wIdx > 0 ? atrArr[wIdx] ?? atrArr[wIdx - 1] : null;

          if (prevAtr != null) {
            const twoWeekHigh = Math.max(prev1.high, prev2.high);
            const twoWeekLow  = Math.min(prev1.low,  prev2.low);

            if (isLong) {
              const structStop = parseFloat((twoWeekLow - 0.01).toFixed(2));
              const atrFloor   = parseFloat((prev1.close - prevAtr).toFixed(2));
              const candidate  = Math.max(structStop, atrFloor);
              const newStop    = parseFloat(Math.max(currentStop, candidate).toFixed(2));
              if (newStop !== currentStop) {
                currentStop = newStop;
                stopHistory.push({ date: bar.date, stop: currentStop, reason: 'ATR_RATCHET' });
              }
            } else {
              const structStop  = parseFloat((twoWeekHigh + 0.01).toFixed(2));
              const atrCeiling  = parseFloat((prev1.close + prevAtr).toFixed(2));
              const candidate   = Math.min(structStop, atrCeiling);
              const newStop     = parseFloat(Math.min(currentStop, candidate).toFixed(2));
              if (newStop !== currentStop) {
                currentStop = newStop;
                stopHistory.push({ date: bar.date, stop: currentStop, reason: 'ATR_RATCHET' });
              }
            }
          }

          // ── BE/SE check (weekly structural break) ──────────────────
          const twoWeekHigh = Math.max(prev1.high, prev2.high);
          const twoWeekLow  = Math.min(prev1.low,  prev2.low);

          if (isLong && completedWeek.low < twoWeekLow) {
            // BE signal for BL — exit at Friday close of the completed week
            finalExit = {
              date: completedWeek.weekStart, // approximate — use last daily bar of that week
              price: completedWeek.close,
              reason: 'BE',
            };
            // Find the actual last trading day of that week
            const weekDays = daily.filter(d => getWeekMonday(d.date) === completedWeek.weekStart);
            if (weekDays.length > 0) {
              finalExit.date = weekDays[weekDays.length - 1].date;
              finalExit.price = weekDays[weekDays.length - 1].close;
            }
            break;
          }
          if (isShort && completedWeek.high > twoWeekHigh) {
            // SE signal for SS — exit at Friday close
            finalExit = {
              date: completedWeek.weekStart,
              price: completedWeek.close,
              reason: 'SE',
            };
            const weekDays = daily.filter(d => getWeekMonday(d.date) === completedWeek.weekStart);
            if (weekDays.length > 0) {
              finalExit.date = weekDays[weekDays.length - 1].date;
              finalExit.price = weekDays[weekDays.length - 1].close;
            }
            break;
          }
        }
      }

      // Reset for new week
      currentWeekMonday = barWeekMonday;
      currentWeekBar = { high: -Infinity, low: Infinity, close: null, open: null };
    }

    // Update current week bar
    currentWeekBar.high = Math.max(currentWeekBar.high, bar.high);
    currentWeekBar.low  = Math.min(currentWeekBar.low, bar.low);
    currentWeekBar.close = bar.close; // Last bar's close = week's close
    if (currentWeekBar.open === null) currentWeekBar.open = bar.open;

    // ── 1. Check STOP HIT (highest priority, checked before lot adds) ──
    if (isLong && bar.low <= currentStop) {
      finalExit = { date: bar.date, price: currentStop, reason: 'STOP_HIT' };
      break;
    }
    if (isShort && bar.high >= currentStop) {
      finalExit = { date: bar.date, price: currentStop, reason: 'STOP_HIT' };
      break;
    }

    // ── 2. Check FEAST (RSI > 85 for longs, RSI < 15 for shorts) ───────
    if (!feastTriggered) {
      // Collect last 15+ closes for RSI computation (need 14 changes + seed)
      const closesForRSI = [];
      for (let j = Math.max(0, i - 30); j <= i; j++) {
        closesForRSI.push(daily[j].close);
      }
      const rsi = computeRSI(closesForRSI);
      if (rsi !== null) {
        const feastFired = isLong ? rsi >= 85 : rsi <= 15;
        if (feastFired) {
          feastTriggered = true;
          feastExit = { date: bar.date, price: bar.close, rsi, sharePct: 0.50 };
        }
      }
    }

    // ── 3. Check OVEREXTENDED (from case study weekly snapshots) ────────
    const snapForDate = weeklySnapshots?.find(s => s.date === bar.date);
    if (snapForDate && snapForDate.killScore === -99) {
      finalExit = { date: bar.date, price: bar.close, reason: 'OVEREXTENDED' };
      break;
    }

    // ── 4. Check lot triggers ──────────────────────────────────────────
    const nextLotIdx = lots.length; // 0-based: lots.length = number filled
    if (nextLotIdx < 5) {
      // Time gate check: trading days since last lot fill
      const daysSinceLastLot = tradingDayCount - lastLotFillDay;
      const timeGateCleared = daysSinceLastLot >= LOT_TIME_GATES[nextLotIdx];

      const trigger = triggerPrices[nextLotIdx];
      const triggerHit = isLong
        ? bar.high >= trigger
        : bar.low <= trigger;

      if (timeGateCleared && triggerHit) {
        lots.push({
          lot: nextLotIdx + 1,
          fillDate: bar.date,
          fillPrice: trigger,
          pctOfTotal: STRIKE_PCT[nextLotIdx],
        });
        lastLotFillDay = tradingDayCount;

        // ── Lot fill stop ratchet ──────────────────────────────────
        const lotNum = nextLotIdx + 1;
        let ratchetPrice = currentStop;

        if (lotNum === 2) {
          // Ratchet to avg cost (breakeven)
          const totalCost = lots.reduce((sum, l) => sum + l.fillPrice * l.pctOfTotal, 0);
          const totalPct  = lots.reduce((sum, l) => sum + l.pctOfTotal, 0);
          ratchetPrice = parseFloat((totalCost / totalPct).toFixed(2));
        } else if (lotNum === 3) {
          ratchetPrice = lots[0].fillPrice; // Lot 1 fill
        } else if (lotNum === 4) {
          ratchetPrice = lots[1].fillPrice; // Lot 2 fill
        } else if (lotNum === 5) {
          ratchetPrice = lots[2].fillPrice; // Lot 3 fill
        }

        const ratchetTightens = isLong
          ? ratchetPrice > currentStop
          : ratchetPrice < currentStop;

        if (ratchetTightens) {
          currentStop = parseFloat(ratchetPrice.toFixed(2));
          stopHistory.push({ date: bar.date, stop: currentStop, reason: `LOT${lotNum}_RATCHET` });
        }
      }
    }
  }

  // ── If we never exited, trade is still ACTIVE ──────────────────────────
  const lastBar = daily[daily.length - 1];
  const status = finalExit ? 'CLOSED' : 'ACTIVE';

  return {
    ticker:      trade.ticker,
    direction:   trade.direction,
    sector:      trade.sector,
    entryDate:   trade.entryDate,
    entryPrice:  trade.entryPrice,
    initStop:    trade.stopPrice,
    entryRank:   trade.entryRank,
    entryTier:   trade.entryTier,
    status,
    lots,
    feastExit,
    finalExit,
    latestPrice: finalExit ? finalExit.price : lastBar?.close ?? trade.entryPrice,
    latestDate:  finalExit ? finalExit.date  : lastBar?.date  ?? trade.entryDate,
    stopHistory,
    holdingDays: tradingDayCount,
  };
}

// ── Main: simulate all Kill case studies ─────────────────────────────────────

export async function simulateAllKillTrades() {
  const db = await connectToDatabase();
  if (!db) throw new Error('DB unavailable');

  const studies = await db.collection('pnthr_kill_case_studies')
    .find({})
    .sort({ entryDate: 1 })
    .toArray();

  if (studies.length === 0) return { trades: [], simulatedAt: new Date().toISOString() };

  const results = [];
  const errors  = [];

  for (const study of studies) {
    try {
      const daily = await getDailyCandles(db, study.ticker);
      if (daily.length === 0) {
        errors.push(`${study.ticker}: no daily candle data`);
        continue;
      }

      const result = simulateTrade(
        {
          ticker:    study.ticker,
          direction: study.direction === 'SHORT' ? 'SHORT' : 'LONG',
          entryDate: study.entryDate,
          entryPrice: study.entryPrice,
          stopPrice:  study.stopPrice,
          sector:     study.sector,
          entryRank:  study.entryRank,
          entryTier:  study.entryTier,
        },
        daily,
        study.weeklySnapshots || [],
      );

      if (result) results.push(result);
    } catch (err) {
      errors.push(`${study.ticker}: ${err.message}`);
    }
  }

  return {
    trades: results,
    errors: errors.length > 0 ? errors : undefined,
    simulatedAt: new Date().toISOString(),
    tradeCount: results.length,
    closedCount: results.filter(r => r.status === 'CLOSED').length,
    activeCount: results.filter(r => r.status === 'ACTIVE').length,
  };
}

// ── API Handler ──────────────────────────────────────────────────────────────

export async function killSimulationHandler(req, res) {
  try {
    const result = await simulateAllKillTrades();
    res.json(result);
  } catch (err) {
    console.error('[KILL SIM] Error:', err);
    res.status(500).json({ error: err.message });
  }
}
