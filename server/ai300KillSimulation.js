// server/ai300KillSimulation.js
// ── PNTHR AI 300 Kill 10 — Pyramid Simulation Engine ────────────────────────
//
// Mirrors killSimulation.js but reads from pnthr_ai300_kill_case_studies.
// Same 5-lot pyramid, ATR ratchet, BE/SE exit logic.

import { connectToDatabase } from './database.js';
import { computeWilderATR, blInitStop, ssInitStop } from './stopCalculation.js';
import { aggregateWeeklyBars } from './technicalUtils.js';

const FMP_API_KEY  = process.env.FMP_API_KEY;
const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';

const STRIKE_PCT     = [0.35, 0.25, 0.20, 0.12, 0.08];
const LOT_OFFSETS    = [0, 0.03, 0.06, 0.10, 0.14];
const LOT_TIME_GATES = [0, 5, 0, 0, 0];

function getWeekMonday(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const dow = d.getDay();
  const daysToMon = dow === 0 ? -6 : 1 - dow;
  const mon = new Date(d);
  mon.setDate(d.getDate() + daysToMon);
  return mon.toISOString().split('T')[0];
}

async function getDailyCandles(db, ticker) {
  const cached = await db.collection('pnthr_candle_cache').findOne({ ticker });
  if (cached?.daily?.length > 0) {
    const has2026 = cached.daily.some(c => c.date?.startsWith('2026'));
    if (has2026) return [...cached.daily].sort((a, b) => a.date.localeCompare(b.date));
  }
  if (!FMP_API_KEY) return [];
  const url = `${FMP_BASE_URL}/historical-price-full/${ticker}?from=2025-10-01&to=2026-06-30&apikey=${FMP_API_KEY}`;
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
    console.error(`[AI300 KILL SIM] FMP fetch failed for ${ticker}:`, err.message);
    return [];
  }
}

function simulateTrade(trade, allDaily, weeklySnapshots) {
  const isLong  = trade.direction === 'LONG';
  const isShort = !isLong;

  const entryIdx = allDaily.findIndex(b => b.date >= trade.entryDate);
  if (entryIdx < 0) return null;

  const warmupStart = Math.max(0, entryIdx - 60);
  const daily = allDaily.slice(warmupStart);
  const entryBarIdx = daily.findIndex(b => b.date >= trade.entryDate);

  const weeklyBars = aggregateWeeklyBars(
    [...allDaily].sort((a, b) => b.date.localeCompare(a.date)),
    { includeVolume: false }
  );
  const atrArr = computeWilderATR(weeklyBars, 3);

  const anchor = trade.entryPrice;
  let currentStop = trade.stopPrice;

  const triggerPrices = LOT_OFFSETS.map(off =>
    isLong
      ? parseFloat((anchor * (1 + off)).toFixed(2))
      : parseFloat((anchor * (1 - off)).toFixed(2))
  );

  const lots = [];
  let lastLotFillDay = 0;
  lots.push({ lot: 1, fillDate: trade.entryDate, fillPrice: trade.entryPrice, pctOfTotal: STRIKE_PCT[0] });

  let finalExit = null;
  let currentWeekMonday = getWeekMonday(trade.entryDate);
  let currentWeekBar = { high: -Infinity, low: Infinity, close: null, open: null };
  let prevCompletedWeeks = [];

  const entryWeekMonday = getWeekMonday(trade.entryDate);
  const priorWeeks = weeklyBars.filter(w => w.weekStart < entryWeekMonday);
  if (priorWeeks.length >= 2) prevCompletedWeeks = priorWeeks.slice(-2);

  const stopHistory = [{ date: trade.entryDate, stop: currentStop, reason: 'INIT' }];
  let tradingDayCount = 0;

  for (let i = entryBarIdx; i < daily.length; i++) {
    const bar = daily[i];
    tradingDayCount++;
    const barWeekMonday = getWeekMonday(bar.date);

    if (barWeekMonday !== currentWeekMonday && tradingDayCount > 1) {
      if (currentWeekBar.close !== null) {
        const completedWeek = {
          weekStart: currentWeekMonday,
          high: currentWeekBar.high, low: currentWeekBar.low,
          close: currentWeekBar.close, open: currentWeekBar.open,
        };
        prevCompletedWeeks.push(completedWeek);
        if (prevCompletedWeeks.length > 2) prevCompletedWeeks.shift();

        if (prevCompletedWeeks.length >= 2) {
          const prev1 = prevCompletedWeeks[prevCompletedWeeks.length - 1];
          const prev2 = prevCompletedWeeks[prevCompletedWeeks.length - 2];
          const wIdx = weeklyBars.findIndex(w => w.weekStart === completedWeek.weekStart);
          const prevAtr = wIdx > 0 ? atrArr[wIdx] ?? atrArr[wIdx - 1] : null;

          if (prevAtr != null) {
            const twoWeekHigh = Math.max(prev1.high, prev2.high);
            const twoWeekLow  = Math.min(prev1.low,  prev2.low);
            if (isLong) {
              const candidate = Math.max(parseFloat((twoWeekLow - 0.01).toFixed(2)), parseFloat((prev1.close - prevAtr).toFixed(2)));
              const newStop = parseFloat(Math.max(currentStop, candidate).toFixed(2));
              if (newStop !== currentStop) { currentStop = newStop; stopHistory.push({ date: bar.date, stop: currentStop, reason: 'ATR_RATCHET' }); }
            } else {
              const candidate = Math.min(parseFloat((twoWeekHigh + 0.01).toFixed(2)), parseFloat((prev1.close + prevAtr).toFixed(2)));
              const newStop = parseFloat(Math.min(currentStop, candidate).toFixed(2));
              if (newStop !== currentStop) { currentStop = newStop; stopHistory.push({ date: bar.date, stop: currentStop, reason: 'ATR_RATCHET' }); }
            }
          }

          const twoWeekHigh = Math.max(prev1.high, prev2.high);
          const twoWeekLow  = Math.min(prev1.low,  prev2.low);
          if (isLong && completedWeek.low < twoWeekLow) {
            finalExit = { date: completedWeek.weekStart, price: completedWeek.close, reason: 'BE' };
            const weekDays = daily.filter(d => getWeekMonday(d.date) === completedWeek.weekStart);
            if (weekDays.length > 0) { finalExit.date = weekDays[weekDays.length - 1].date; finalExit.price = weekDays[weekDays.length - 1].close; }
            break;
          }
          if (isShort && completedWeek.high > twoWeekHigh) {
            finalExit = { date: completedWeek.weekStart, price: completedWeek.close, reason: 'SE' };
            const weekDays = daily.filter(d => getWeekMonday(d.date) === completedWeek.weekStart);
            if (weekDays.length > 0) { finalExit.date = weekDays[weekDays.length - 1].date; finalExit.price = weekDays[weekDays.length - 1].close; }
            break;
          }
        }
      }
      currentWeekMonday = barWeekMonday;
      currentWeekBar = { high: -Infinity, low: Infinity, close: null, open: null };
    }

    currentWeekBar.high = Math.max(currentWeekBar.high, bar.high);
    currentWeekBar.low  = Math.min(currentWeekBar.low, bar.low);
    currentWeekBar.close = bar.close;
    if (currentWeekBar.open === null) currentWeekBar.open = bar.open;

    if (isLong && bar.low <= currentStop) { finalExit = { date: bar.date, price: currentStop, reason: 'STOP_HIT' }; break; }
    if (isShort && bar.high >= currentStop) { finalExit = { date: bar.date, price: currentStop, reason: 'STOP_HIT' }; break; }

    const nextLotIdx = lots.length;
    if (nextLotIdx < 5) {
      const daysSinceLastLot = tradingDayCount - lastLotFillDay;
      const timeGateCleared = daysSinceLastLot >= LOT_TIME_GATES[nextLotIdx];
      const trigger = triggerPrices[nextLotIdx];
      const triggerHit = isLong ? bar.high >= trigger : bar.low <= trigger;

      if (timeGateCleared && triggerHit) {
        lots.push({ lot: nextLotIdx + 1, fillDate: bar.date, fillPrice: trigger, pctOfTotal: STRIKE_PCT[nextLotIdx] });
        lastLotFillDay = tradingDayCount;

        const lotNum = nextLotIdx + 1;
        let ratchetPrice = currentStop;
        if (lotNum === 2) {
          const totalCost = lots.reduce((sum, l) => sum + l.fillPrice * l.pctOfTotal, 0);
          const totalPct  = lots.reduce((sum, l) => sum + l.pctOfTotal, 0);
          ratchetPrice = parseFloat((totalCost / totalPct).toFixed(2));
        } else if (lotNum === 3) { ratchetPrice = lots[0].fillPrice; }
        else if (lotNum === 4) { ratchetPrice = lots[1].fillPrice; }
        else if (lotNum === 5) { ratchetPrice = lots[2].fillPrice; }

        const ratchetTightens = isLong ? ratchetPrice > currentStop : ratchetPrice < currentStop;
        if (ratchetTightens) { currentStop = parseFloat(ratchetPrice.toFixed(2)); stopHistory.push({ date: bar.date, stop: currentStop, reason: `LOT${lotNum}_RATCHET` }); }
      }
    }
  }

  const lastBar = daily[daily.length - 1];
  return {
    ticker: trade.ticker, direction: trade.direction, sector: trade.sector,
    entryDate: trade.entryDate, entryPrice: trade.entryPrice, initStop: trade.stopPrice,
    entryRank: trade.entryRank, entryTier: trade.entryTier,
    status: finalExit ? 'CLOSED' : 'ACTIVE',
    lots, finalExit,
    latestPrice: finalExit ? finalExit.price : lastBar?.close ?? trade.entryPrice,
    latestDate:  finalExit ? finalExit.date  : lastBar?.date  ?? trade.entryDate,
    stopHistory, holdingDays: tradingDayCount,
  };
}

export async function simulateAllAi300KillTrades() {
  const db = await connectToDatabase();
  if (!db) throw new Error('DB unavailable');

  const studies = await db.collection('pnthr_ai300_kill_case_studies')
    .find({}).sort({ entryDate: 1 }).toArray();

  if (studies.length === 0) return { trades: [], simulatedAt: new Date().toISOString() };

  const results = [];
  const errors  = [];

  for (const study of studies) {
    try {
      const daily = await getDailyCandles(db, study.ticker);
      if (daily.length === 0) { errors.push(`${study.ticker}: no daily candle data`); continue; }
      const result = simulateTrade(
        { ticker: study.ticker, direction: study.direction === 'SHORT' ? 'SHORT' : 'LONG',
          entryDate: study.entryDate, entryPrice: study.entryPrice, stopPrice: study.stopPrice,
          sector: study.sector, entryRank: study.entryRank, entryTier: study.entryTier },
        daily, study.weeklySnapshots || []
      );
      if (result) results.push(result);
    } catch (err) { errors.push(`${study.ticker}: ${err.message}`); }
  }

  return {
    trades: results, errors: errors.length > 0 ? errors : undefined,
    simulatedAt: new Date().toISOString(),
    tradeCount: results.length,
    closedCount: results.filter(r => r.status === 'CLOSED').length,
    activeCount: results.filter(r => r.status === 'ACTIVE').length,
  };
}

export async function ai300KillSimulationHandler(req, res) {
  try {
    const result = await simulateAllAi300KillTrades();
    res.json(result);
  } catch (err) {
    console.error('[AI300 KILL SIM] Error:', err);
    res.status(500).json({ error: err.message });
  }
}
