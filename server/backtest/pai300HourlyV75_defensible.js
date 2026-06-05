// server/backtest/pai300HourlyV75_defensible.js
// ═══════════════════════════════════════════════════════════════════════════════
//  PNTHR AMBUSH V7.5 — DEFENSIBLE BACKTEST  (+ attribution battery)
//  Built to server/backtest/AMBUSH_V75_BACKTEST_SPEC.md (locked 2026-06-04).
//
//  Clean bar-by-bar intraday simulation core (the data/signal loading is reused
//  from pai300HourlyV74.js). Real frictions, NO optimistic shortcuts:
//    • Commission  — IBKR Pro Fixed ($0.005/sh, $1 min, 1% cap)        [costEngine]
//    • Slippage    — 5 bps adverse on EVERY leg (entries AND exits)
//    • Short borrow— sector-tiered 1.0-2.0%/yr × days held, on exit    [costEngine]
//    • Gap-through stops — exits fill at the WORSE of stop or bar open
//    • 2% ADV cap  — no single fill exceeds 2% of trailing-20d volume
//    • Intraday mgmt— stop → adds (ADV-cap + 10% trim) → trail, SAME day from entry
//    • $100K start, $2M→bank $1M withdrawal · no leverage
//    • GROSS → NET via the Filet-100k fund-fee overlay                  [feeOverlay]
//
//  The simulation is parameterized by a `cfg` so we can attribute the V7.4→V7.5
//  performance gap to each individual rule. The DEFAULT run is the literal locked
//  spec (cfg = SPEC). `--diag` runs the full attribution battery and picks a best.
//
//  Usage:
//    cd server && node backtest/pai300HourlyV75_defensible.js          (canonical spec run)
//    cd server && node backtest/pai300HourlyV75_defensible.js --diag   (attribution battery)
//    TRACE=MSFT node backtest/pai300HourlyV75_defensible.js            (trace one ticker)
// ═══════════════════════════════════════════════════════════════════════════════

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import fs from 'fs';
import os from 'os';
import path from 'path';
import { connectToDatabase } from '../database.js';
import { SECTORS } from '../scripts/aiUniverse/aiUniverseData.js';
import { SECTOR_EMA_PERIODS } from '../data/pnthrAiSectorsConfig.js';
import { CARNIVORE_MODE_TICKERS } from '../data/strategyMode.js';
import { detectAllSignals } from '../signalDetection.js';
import { calcCommission, calcBorrowCost } from './costEngine.js';
import { applyFeeEngine } from './ai300FeeOverlay.js';
import { computeSharpe, computeSortino } from '../irLiveService.js';

// ── Constants (mirror ambushEngine.js — single source of truth) ────────────────
const NAV_INITIAL          = 100_000;          // §3: Filet 100k
const VITALITY_PCT         = 0.01;             // 1% NAV risk cap
const TICKER_CAP_PCT       = 0.10;             // 10% NAV single-name cap
const STRIKE_PCT           = [0.35, 0.25, 0.20, 0.12, 0.08]; // 5-lot pyramid weights
const LOT_OFFSETS          = [0, 0.03, 0.06, 0.10, 0.14];    // add at +0/+3/+6/+10/+14%
const MAX_LOSS             = 300;              // $ risk cap at 100% tier (×0.50 dial = $150 at launch)
const SLIPPAGE_BPS         = 5;                // 5 bps adverse per leg
const COMMISSION_PER_SHARE = 0.005;           // also the "small fee" for the new-entry stop
let   FIRST_HOUR_END       = '10:30';         // first completed hourly bar ends at 10:30 (:30 bars); 10:00 for :00 clock-hour bars
const ADV_CAP_PCT          = 0.02;            // §2: 2% of trailing-20d ADV per fill
const ADV_LOOKBACK         = 20;              // sessions
const WITHDRAWAL_THRESHOLD = 2_000_000;       // §3
const WITHDRAWAL_AMOUNT    = 1_000_000;       // §3

// Graduated sizing dial (walkthrough §5): <125K → 50% (~$150) ; <166K → 75% ; ≥166K → 100%
const GRAD_TIER_1 = 125_000;
const GRAD_TIER_2 = 166_000;
function sizingMultiplier(nav) {
  if (nav >= GRAD_TIER_2) return 1.00;
  if (nav >= GRAD_TIER_1) return 0.75;
  return 0.50;
}

// Filet-100k fund-fee tier (§4)
const FILET_TIER = { startingCapital: 100_000, baseRate: 0.30, loyaltyRate: 0.25 };

// ── The locked literal-spec configuration (the canonical default run) ───────────
const SPEC = {
  label: 'V7.5 literal spec',
  carnivoreSignals: false,   // false = AI params (sector EMA, 1.25× gate) for all 311 names (spec)
  reentryEnabled: true,
  reentryTrigger: 'any',     // 'any' = break prior hourly bar, any color (spec) | 'green' = V7.4 confirmed-green close
  reentryStopMode: 'entrybar', // 'entrybar' = entry-bar low (spec) | 'firsthour' = first-hour low | '2bar' = 2-bar low
  reentryCooldownBars: 0,    // 0 = no cooldown (spec)
  reentryFrozenDaily: true,  // require price above the frozen original breakout (spec)
  sectorFilter: true,        // true = real BULL/BEAR by 5-day return (spec) | false = V7.4 no-op (every sector passes)
  trailStartR: 0,            // 0 = 2-bar trail governs from entry (spec) | >0 = trail only after +R×risk in profit
  gapThrough: true,          // exits fill at the worse of stop or bar open (spec)
};

// ── AI-300 ticker → sector map (borrow rate + sector BULL/BEAR lookup) ──────────
const AI_TICKER_META = {};
for (const sec of SECTORS) for (const h of sec.holdings) AI_TICKER_META[h.ticker] = { sectorId: sec.id, sector: sec.name };
function getSectorName(ticker) { return AI_TICKER_META[ticker]?.sector || 'Technology'; }

// ── Small helpers ──────────────────────────────────────────────────────────────
function getWeekOf(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const dow = d.getDay(); const daysToMon = dow === 0 ? -6 : 1 - dow;
  const m = new Date(d); m.setDate(d.getDate() + daysToMon);
  return m.toISOString().split('T')[0];
}
function extractTime(dateStr) { const p = dateStr.split(' '); return p.length > 1 ? p[1].slice(0, 5) : '00:00'; }
function applySlip(price, adverse) { const s = price * (SLIPPAGE_BPS / 10000); return adverse ? +(price + s).toFixed(4) : +(price - s).toFixed(4); }
function entrySlip(price, dir) { return dir === 'LONG' ? applySlip(price, true) : applySlip(price, false); }
function exitSlip(price, dir)  { return dir === 'LONG' ? applySlip(price, false) : applySlip(price, true); }
function comm(shares, price) { return calcCommission(shares, price); }
// Gap-through stop fill: worse of the stop or the bar's open (§2).
function stopFill(stop, barOpen, dir) { return dir === 'LONG' ? Math.min(stop, barOpen) : Math.max(stop, barOpen); }
// Stop-order add/entry fill: worse = past the trigger.
function addFill(trigger, barOpen, dir) { return dir === 'LONG' ? Math.max(trigger, barOpen) : Math.min(trigger, barOpen); }

async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('No DB'); process.exit(1); }
  const DIAG = process.argv.includes('--diag');
  const TRACE_TICKER = process.env.TRACE || null;

  const RULE = '═'.repeat(96);
  console.log(RULE);
  console.log('  PNTHR AMBUSH V7.5 — DEFENSIBLE BACKTEST' + (DIAG ? '  ·  ATTRIBUTION BATTERY' : ''));
  console.log(RULE);

  // ── [1] LOAD DATA (shape reused from pai300HourlyV74.js) ──────────────────────
  console.log('\n[1] Loading data...');
  // CLOCKHOUR=1 re-validates on :00 clock-hour bars (matching the trader's TWS chart),
  // built from the 30-min backfill. The opening bar is then the 9:30-10:00 half-hour, so
  // the "first hour" window ends at 10:00 (new entries fire from the 10:00 bar onward).
  const CLOCKHOUR = process.env.CLOCKHOUR === '1';
  if (CLOCKHOUR) FIRST_HOUR_END = '10:00';
  const C = { daily: 'pnthr_ai_bt_candles', weekly: 'pnthr_ai_bt_candles_weekly', hourly: CLOCKHOUR ? 'pnthr_ai_clockhour_candles' : 'pnthr_ai_hourly_candles' };
  if (CLOCKHOUR) console.log('  [CLOCKHOUR MODE] using :00 clock-hour bars (pnthr_ai_clockhour_candles), first-hour window → 10:00');
  const dailyDocs  = await db.collection(C.daily).find({},  { projection: { ticker: 1, daily: 1 } }).toArray();
  const weeklyDocs = await db.collection(C.weekly).find({}, { projection: { ticker: 1, weekly: 1 } }).toArray();
  const hourlyDocs = await db.collection(C.hourly).find({}, { projection: { ticker: 1, hourly: 1 } }).toArray();
  const sectorRankDocs = await db.collection('pnthr_ai_sector_rank_daily').find({}).sort({ date: 1 }).toArray();
  const spyWeeklyDoc   = await db.collection('pnthr_bt_candles_weekly').findOne({ ticker: 'SPY' });

  const hourlyByDay = {}, hourlyAll = {};
  let hMinDate = '9999', hMaxDate = '0000';
  const hourlyDatesSet = new Set();
  for (const doc of hourlyDocs) {
    const bars = (doc.hourly || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 0; i < bars.length; i++) bars[i]._gi = i; // continuous global index for the 2-bar trail
    hourlyAll[doc.ticker] = bars;
    const byDay = {};
    for (const b of bars) { const d = b.date.split(' ')[0]; (byDay[d] ||= []).push(b); hourlyDatesSet.add(d); }
    hourlyByDay[doc.ticker] = byDay;
    if (bars.length) {
      const f = bars[0].date.split(' ')[0], l = bars[bars.length - 1].date.split(' ')[0];
      if (f < hMinDate) hMinDate = f; if (l > hMaxDate) hMaxDate = l;
    }
  }
  const tradingDates = [...hourlyDatesSet].sort();

  const dailyByDate = {}, dailyDates = {}, adv20ByDate = {};
  for (const doc of dailyDocs) {
    const bars = (doc.daily || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    const byDate = {}, dates = [], adv = {};
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i]; byDate[b.date] = b; dates.push(b.date);
      const from = Math.max(0, i - ADV_LOOKBACK); let sum = 0, n = 0;
      for (let j = from; j < i; j++) { sum += (bars[j].volume || 0); n++; }
      adv[b.date] = n > 0 ? sum / n : 0;
    }
    dailyByDate[doc.ticker] = byDate; dailyDates[doc.ticker] = dates; adv20ByDate[doc.ticker] = adv;
  }
  function priorTwoDaily(ticker, date) {
    const dates = dailyDates[ticker]; if (!dates || !dates.length) return null;
    let lo = 0, hi = dates.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (dates[mid] < date) lo = mid + 1; else hi = mid; }
    const i1 = lo - 1, i2 = lo - 2; if (i1 < 0 || i2 < 0) return null;
    return { prev1: dailyByDate[ticker][dates[i1]], prev2: dailyByDate[ticker][dates[i2]] };
  }

  const weeklyBarsByTicker = {};
  for (const doc of weeklyDocs) {
    const sorted = (doc.weekly || []).slice().sort((a, b) => (a.weekOf || a.date).localeCompare(b.weekOf || b.date));
    weeklyBarsByTicker[doc.ticker] = sorted.map(w => ({ time: w.weekOf || w.date, open: w.open, high: w.high, low: w.low, close: w.close }));
  }

  const sectorFiveDayByDate = {}; const sectorRankDates = [];
  for (const doc of sectorRankDocs) {
    const m = {}; for (const r of (doc.ranks || [])) m[r.sectorId] = r.fiveDayReturn;
    sectorFiveDayByDate[doc.date] = m; sectorRankDates.push(doc.date);
  }
  function sectorFiveDay(sectorId, date) {
    let lo = 0, hi = sectorRankDates.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sectorRankDates[mid] <= date) lo = mid + 1; else hi = mid; }
    const idx = lo - 1; if (idx < 0) return null;
    const v = sectorFiveDayByDate[sectorRankDates[idx]]?.[sectorId];
    return (v === undefined) ? null : v;
  }
  function sectorOk(ticker, date, dir) {
    const sectorId = AI_TICKER_META[ticker]?.sectorId;
    if (sectorId === undefined) return false;
    const r = sectorFiveDay(sectorId, date);
    if (r === null) return false;
    return dir === 'LONG' ? r >= 0 : r < 0;
  }

  const spyWeekly = (spyWeeklyDoc?.weekly || []).slice().sort((a, b) => (a.weekOf || a.date).localeCompare(b.weekOf || b.date));
  console.log(`  Hourly: ${hMinDate} → ${hMaxDate} (${tradingDates.length} trading days) · Tickers ${Object.keys(hourlyByDay).length}`);

  // ── [2] SIGNALS — build BOTH param sets (AI spec vs V7.4 carnivore overlay) ────
  function buildSignals(useCarnivore) {
    const map = {};
    for (const ticker of Object.keys(weeklyBarsByTicker).filter(t => AI_TICKER_META[t])) {
      const bars = weeklyBarsByTicker[ticker]; if (!bars || bars.length < 35) continue;
      const sectorId = AI_TICKER_META[ticker]?.sectorId;
      const isCarn = useCarnivore && CARNIVORE_MODE_TICKERS.has(ticker);
      const period = isCarn ? 21 : (SECTOR_EMA_PERIODS[sectorId] ?? SECTOR_EMA_PERIODS[String(sectorId)] ?? 30);
      const gateOffset = isCarn ? 0.10 : 0.25;
      const result = detectAllSignals(bars, period, false, null, gateOffset);
      const activeBLPeriods = [], activeSSPeriods = [];
      let blStart = null, ssStart = null;
      for (const evt of result.events) {
        if (evt.signal === 'BL') blStart = evt.time;
        if ((evt.signal === 'BE' || evt.signal === 'SS') && blStart) { activeBLPeriods.push({ from: blStart, to: evt.time }); blStart = null; }
        if (evt.signal === 'SS') ssStart = evt.time;
        if ((evt.signal === 'SE' || evt.signal === 'BL') && ssStart) { activeSSPeriods.push({ from: ssStart, to: evt.time }); ssStart = null; }
      }
      if (blStart) activeBLPeriods.push({ from: blStart, to: '9999-12-31' });
      if (ssStart) activeSSPeriods.push({ from: ssStart, to: '9999-12-31' });
      map[ticker] = { activeBLPeriods, activeSSPeriods };
    }
    return map;
  }
  console.log('\n[2] Computing weekly signals (AI sector-EMA 1.25× gate, + V7.4 carnivore variant)...');
  const signalsAI = buildSignals(false);
  const signalsCarn = buildSignals(true);
  console.log(`  ${Object.keys(signalsAI).length} tickers with signals`);

  function countTradingDays(fromDate, toDate) {
    const a = tradingDates.indexOf(fromDate), b = tradingDates.indexOf(toDate);
    if (a < 0 || b < 0) return Math.max(1, Math.round((new Date(toDate) - new Date(fromDate)) / 86400000 * 5 / 7));
    return Math.max(1, b - a);
  }

  // ── [3] THE PARAMETERIZED SIMULATION CORE ─────────────────────────────────────
  function runSim(cfg) {
    const SIG = cfg.carnivoreSignals ? signalsCarn : signalsAI;
    const isActiveBL = (t, d) => { const s = SIG[t]; if (!s) return false; const w = getWeekOf(d); for (const p of s.activeBLPeriods) if (w >= p.from && w <= p.to) return true; return false; };
    const isActiveSS = (t, d) => { const s = SIG[t]; if (!s) return false; const w = getWeekOf(d); for (const p of s.activeSSPeriods) if (w >= p.from && w <= p.to) return true; return false; };
    const signalActive = (t, d, dir) => dir === 'LONG' ? isActiveBL(t, d) : isActiveSS(t, d);

    let cash = NAV_INITIAL, banked = 0;
    const positions = {}, waiting = {}, exits = [], dailyLedger = [];
    let totalComm = 0, totalBorrow = 0, totalWithdrawn = 0;
    let totalNewEntries = 0, totalReentries = 0, totalLotFills = 0;
    let totalLongEntries = 0, totalShortEntries = 0;
    let totalStopExits = 0, totalEndExits = 0;
    let skippedNoCash = 0, skippedNoADV = 0, skippedSizing = 0;
    let worstSingleTrade = 0, peakDeployed = 0, peakWorkingNav = 0, peakTotalValue = 0, maxConcurrent = 0;
    let sameBarReentry = 0, nextBarReentry = 0;
    const holdBarsHist = {}, milestoneHits = {}, traceLog = [];
    const MILESTONES = [125_000, 166_000, 250_000, 500_000, 1_000_000, 2_000_000];
    const tlog = (o) => { if (TRACE_TICKER && o.ticker === TRACE_TICKER) traceLog.push(o); };

    const deployed = () => { let d = 0; for (const p of Object.values(positions)) d += p.avgCost * p.totalShares; return d; };
    const workingNav = () => cash + deployed();
    const openCount = () => Object.keys(positions).length;

    function closePosition(ticker, pos, exitPriceSlipped, date, hour, type) {
      const shares = pos.totalShares; const c = comm(shares, exitPriceSlipped); totalComm += c;
      let pnl;
      if (pos.direction === 'SHORT') {
        const td = countTradingDays(pos.entryDate, date);
        const borrow = calcBorrowCost(shares, pos.avgCost, td, getSectorName(ticker)); totalBorrow += borrow;
        pnl = +(shares * (pos.avgCost - exitPriceSlipped) - c - borrow).toFixed(2);
        cash += +(shares * pos.avgCost + pnl).toFixed(2);
      } else {
        const proceeds = +(shares * exitPriceSlipped - c).toFixed(2);
        pnl = +(proceeds - shares * pos.avgCost).toFixed(2);
        cash += proceeds;
      }
      if (pnl < worstSingleTrade) worstSingleTrade = pnl;
      exits.push({ pnl, date, hour, ticker, type, direction: pos.direction, shares, avgCost: +pos.avgCost.toFixed(4), exitPrice: +exitPriceSlipped.toFixed(4), entryDate: pos.entryDate, isReentry: !!pos.isReentry, cycleNum: pos.cycleNum });
      return pnl;
    }

    for (let dayIdx = 0; dayIdx < tradingDates.length; dayIdx++) {
      const date = tradingDates[dayIdx];
      while (workingNav() >= WITHDRAWAL_THRESHOLD && cash >= WITHDRAWAL_AMOUNT) { cash -= WITHDRAWAL_AMOUNT; banked += WITHDRAWAL_AMOUNT; totalWithdrawn += WITHDRAWAL_AMOUNT; }
      const navToday = workingNav(); const sizeMult = sizingMultiplier(navToday);
      for (const m of MILESTONES) if (!milestoneHits[m] && (navToday + banked) >= m) milestoneHits[m] = date;
      if (openCount() > maxConcurrent) maxConcurrent = openCount();

      const dayBars = {}, firstHourLow = {}, firstHourHigh = {};
      const universe = new Set([...Object.keys(positions), ...Object.keys(waiting), ...Object.keys(SIG)]);
      for (const t of universe) {
        const bars = hourlyByDay[t]?.[date]; if (!bars || !bars.length) continue;
        dayBars[t] = bars;
        const fh = bars.filter(b => extractTime(b.date) < FIRST_HOUR_END);
        firstHourLow[t]  = fh.length ? Math.min(...fh.map(b => b.low))  : null;
        firstHourHigh[t] = fh.length ? Math.max(...fh.map(b => b.high)) : null;
      }
      let maxSlots = 0; for (const t in dayBars) if (dayBars[t].length > maxSlots) maxSlots = dayBars[t].length;

      for (let slot = 0; slot < maxSlots; slot++) {
        // ===== PART 1: MANAGE held positions (entered on a PRIOR bar) =============
        for (const ticker of Object.keys(positions)) {
          const pos = positions[ticker];
          if (pos.entryDate === date && slot <= pos.entrySlot) continue; // not yet its turn this same day
          const bars = dayBars[ticker]; if (!bars || slot >= bars.length) continue;
          const bar = bars[slot]; const isLong = pos.direction === 'LONG';

          // (a) STOP FIRST — gap-through (§2), optional via cfg.
          const hit = isLong ? bar.low <= pos.stop : bar.high >= pos.stop;
          if (hit) {
            const raw = cfg.gapThrough ? stopFill(pos.stop, bar.open, pos.direction) : pos.stop;
            const px = exitSlip(raw, pos.direction);
            const pnl = closePosition(ticker, pos, px, date, bar.date, pos.isReentry ? 'STOP_REENTRY' : 'STOP');
            totalStopExits++;
            const heldBars = bar._gi - pos.entryGi; holdBarsHist[heldBars] = (holdBarsHist[heldBars] || 0) + 1;
            tlog({ ev: 'EXIT', ticker, date, hour: extractTime(bar.date), gi: bar._gi, kind: pos.isReentry ? 're' : 'new', barOHLC: `O${bar.open} H${bar.high} L${bar.low} C${bar.close}`, stop: pos.stop, fill: +px.toFixed(2), sh: pos.totalShares, lots: pos.nextLot, pnl, heldBars });
            waiting[ticker] = { direction: pos.direction, frozenDaily: pos.frozenDaily, cycleNum: pos.cycleNum + 1, exitGi: bar._gi, runningLow: bar.low, runningHigh: bar.high };
            delete positions[ticker]; continue;
          }

          // (b) LOT ADDS — ADV-capped, 10% NAV top-down trim. (Pyramid never touches the stop.)
          if (pos.nextLot <= 4) {
            const offset = LOT_OFFSETS[pos.nextLot];
            const trigger = isLong ? +(pos.originalEntry * (1 + offset)).toFixed(2) : +(pos.originalEntry * (1 - offset)).toFixed(2);
            const triggered = isLong ? bar.high >= trigger : bar.low <= trigger;
            if (triggered) {
              const fill = entrySlip(addFill(trigger, bar.open, pos.direction), pos.direction);
              const nav = workingNav();
              const advCap = Math.floor(ADV_CAP_PCT * (adv20ByDate[ticker]?.[date] || 0));
              const maxShares = Math.floor((nav * TICKER_CAP_PCT) / fill);
              const addShares = Math.min(pos.lotPlan[pos.nextLot], advCap, Math.max(0, maxShares - pos.totalShares));
              if (addShares >= 1) {
                const c = comm(addShares, fill); const lotCost = addShares * fill + c;
                if (cash >= lotCost) { totalComm += c; const oldBasis = pos.avgCost * pos.totalShares; cash -= lotCost; pos.totalShares += addShares; pos.avgCost = +((oldBasis + fill * addShares) / pos.totalShares).toFixed(4); pos.nextLot++; totalLotFills++; }
              } else { pos.nextLot++; }
            }
          }

          // (c) UPDATE 2-BAR TRAIL for the next bar — lowest low of the two just-completed bars
          //     (i, i-1) in the continuous series; from 10:30 onward; up-only. cfg.trailStartR>0
          //     holds the wider initial stop until the trade is up R×risk ("once it begins trending").
          let trailAllowed = true;
          if (cfg.trailStartR > 0) {
            if (!pos.trailOn) { const fav = isLong ? (bar.high - pos.originalEntry) : (pos.originalEntry - bar.low); if (fav >= cfg.trailStartR * pos.initRps) pos.trailOn = true; }
            trailAllowed = pos.trailOn;
          }
          if (trailAllowed && extractTime(bar.date) >= FIRST_HOUR_END && bar._gi >= 1) {
            const series = hourlyAll[ticker]; const b1 = series[bar._gi], b2 = series[bar._gi - 1];
            if (isLong) { const trail = +(Math.min(b1.low, b2.low) - 0.01).toFixed(2); if (trail > pos.stop) pos.stop = trail; }
            else { const trail = +(Math.max(b1.high, b2.high) + 0.01).toFixed(2); if (trail < pos.stop) pos.stop = trail; }
          }
        }

        // ===== PART 2: SCAN for entries at THIS bar (after the first hour) ========
        if (slot >= 1) {
          const candidates = [];
          for (const ticker of universe) {
            if (positions[ticker]) continue;
            const bars = dayBars[ticker]; if (!bars || slot >= bars.length) continue;
            const bar = bars[slot], prevBar = bars[slot - 1];
            if (extractTime(bar.date) < FIRST_HOUR_END) continue;

            // Re-entry disabled: clear waiting when the weekly cycle ends so the name can re-new.
            if (!cfg.reentryEnabled && waiting[ticker]) { if (!signalActive(ticker, date, waiting[ticker].direction)) delete waiting[ticker]; continue; }
            const w = waiting[ticker];
            const dir = w ? w.direction : (isActiveBL(ticker, date) ? 'LONG' : (isActiveSS(ticker, date) ? 'SHORT' : null));
            if (!dir) continue;
            if (!signalActive(ticker, date, dir)) { delete waiting[ticker]; continue; }
            if (cfg.sectorFilter && !sectorOk(ticker, date, dir)) continue;
            const isLong = dir === 'LONG';
            const hourlyLevel = isLong ? +(prevBar.high + 0.01).toFixed(2) : +(prevBar.low - 0.01).toFixed(2);

            if (w) {
              // ── RE-ENTRY ────────────────────────────────────────────────────
              // Track the running low/high since exit (V7.4's re-entry stop reference).
              w.runningLow = Math.min(w.runningLow ?? bar.low, bar.low);
              w.runningHigh = Math.max(w.runningHigh ?? bar.high, bar.high);
              if (cfg.reentryCooldownBars > 0 && (bar._gi - (w.exitGi ?? -1e9)) < cfg.reentryCooldownBars) continue;
              let triggered;
              if (cfg.reentryTrigger === 'green') {
                triggered = isLong ? (bar.close > bar.open && bar.high > prevBar.high && bar.close > prevBar.high)
                                   : (bar.close < bar.open && bar.low < prevBar.low && bar.close < prevBar.low);
              } else {
                triggered = isLong ? bar.high >= hourlyLevel : bar.low <= hourlyLevel;
              }
              if (!triggered) continue;
              const ep = entrySlip(addFill(hourlyLevel, bar.open, dir), dir);
              if (cfg.reentryFrozenDaily && (isLong ? ep < w.frozenDaily : ep > w.frozenDaily)) continue;
              let stop;
              if (cfg.reentryStopMode === 'firsthour') {
                const fhl = firstHourLow[ticker], fhh = firstHourHigh[ticker];
                if (isLong) { if (fhl == null) continue; stop = +(fhl - COMMISSION_PER_SHARE).toFixed(2); }
                else { if (fhh == null) continue; stop = +(fhh + COMMISSION_PER_SHARE).toFixed(2); }
              } else if (cfg.reentryStopMode === '2bar') {
                const s = hourlyAll[ticker], gi = bar._gi;
                if (gi >= 1) { const b1 = s[gi], b2 = s[gi - 1]; stop = isLong ? +(Math.min(b1.low, b2.low) - 0.01).toFixed(2) : +(Math.max(b1.high, b2.high) + 0.01).toFixed(2); }
                else stop = isLong ? +(bar.low - 0.01).toFixed(2) : +(bar.high + 0.01).toFixed(2);
              } else if (cfg.reentryStopMode === 'runlow') { // V7.4: lowest low / highest high since exit
                stop = isLong ? +((w.runningLow ?? bar.low) - 0.01).toFixed(2) : +((w.runningHigh ?? bar.high) + 0.01).toFixed(2);
              } else { // entrybar (spec)
                stop = isLong ? +(bar.low - 0.01).toFixed(2) : +(bar.high + 0.01).toFixed(2);
              }
              const rps = isLong ? ep - stop : stop - ep; if (rps <= 0.01) continue;
              candidates.push({ ticker, dir, ep, stop, rps, isReentry: true, frozenDaily: w.frozenDaily, cycleNum: w.cycleNum, exitGi: w.exitGi });
            } else {
              // ── NEW ENTRY ───────────────────────────────────────────────────
              const triggered = isLong ? bar.high >= hourlyLevel : bar.low <= hourlyLevel;
              if (!triggered) continue;
              const two = priorTwoDaily(ticker, date); if (!two) continue;
              const dailyLevel = isLong ? +(Math.max(two.prev1.high, two.prev2.high) + 0.01).toFixed(2) : +(Math.min(two.prev1.low, two.prev2.low) - 0.01).toFixed(2);
              const entryLevel = isLong ? Math.max(dailyLevel, hourlyLevel) : Math.min(dailyLevel, hourlyLevel);
              const reached = isLong ? bar.high >= entryLevel : bar.low <= entryLevel; if (!reached) continue;
              const ep = entrySlip(addFill(entryLevel, bar.open, dir), dir);
              const fhl = firstHourLow[ticker], fhh = firstHourHigh[ticker];
              if (isLong && (fhl == null || fhl >= ep)) continue;
              if (!isLong && (fhh == null || fhh <= ep)) continue;
              const stop = isLong ? +(fhl - COMMISSION_PER_SHARE).toFixed(2) : +(fhh + COMMISSION_PER_SHARE).toFixed(2);
              const rps = isLong ? ep - stop : stop - ep; if (rps <= 0.01) continue;
              candidates.push({ ticker, dir, ep, stop, rps, isReentry: false, frozenDaily: dailyLevel, cycleNum: 0 });
            }
          }

          candidates.sort((a, b) => b.rps - a.rps);
          for (const cand of candidates) {
            if (positions[cand.ticker]) continue;
            const { ticker, dir, ep, stop, rps, isReentry, frozenDaily, cycleNum, exitGi } = cand;
            const entryBar = dayBars[ticker][slot]; const nav = workingNav();
            let totalShares = Math.min(Math.floor(MAX_LOSS / rps), Math.floor((nav * VITALITY_PCT) / rps), Math.floor((nav * TICKER_CAP_PCT) / ep));
            totalShares = Math.floor(totalShares * sizeMult);
            if (totalShares < 1) { skippedSizing++; continue; }
            const lotPlan = STRIKE_PCT.map(p => Math.max(1, Math.round(totalShares * p)));
            const advCap = Math.floor(ADV_CAP_PCT * (adv20ByDate[ticker]?.[date] || 0));
            if (advCap < 1) { skippedNoADV++; continue; }
            const l1 = Math.min(lotPlan[0], advCap); if (l1 < 1) { skippedNoADV++; continue; }
            const c = comm(l1, ep); const cost = l1 * ep + c;
            if (cash < cost) { skippedNoCash++; continue; }
            totalComm += c; cash -= cost;
            positions[ticker] = { ticker, direction: dir, entryDate: date, entrySlot: slot, entryGi: entryBar._gi, avgCost: ep, originalEntry: ep, totalShares: l1, lotPlan, stop, initRps: rps, trailOn: false, nextLot: 1, isReentry, frozenDaily, cycleNum };
            delete waiting[ticker];
            if (isReentry) { totalReentries++; const gap = entryBar._gi - (exitGi ?? -999); if (gap === 0) sameBarReentry++; else if (gap === 1) nextBarReentry++; } else totalNewEntries++;
            if (dir === 'LONG') totalLongEntries++; else totalShortEntries++;
            tlog({ ev: isReentry ? 'RE-ENTER' : 'NEW', ticker, date, hour: extractTime(entryBar.date), gi: entryBar._gi, barOHLC: `O${entryBar.open} H${entryBar.high} L${entryBar.low} C${entryBar.close}`, ep: +ep.toFixed(2), stop: +stop.toFixed(2), rps: +rps.toFixed(2), sh: l1, frozenDaily: +(frozenDaily || 0).toFixed(2), barsSinceExit: isReentry ? (entryBar._gi - (exitGi ?? -999)) : null });
          }
        }
      }

      const dep = deployed(); const wnav = cash + dep; const tv = wnav + banked;
      if (dep > peakDeployed) peakDeployed = dep;
      if (wnav > peakWorkingNav) peakWorkingNav = wnav;
      if (tv > peakTotalValue) peakTotalValue = tv;
      dailyLedger.push({ date, positions: openCount(), cash: +cash.toFixed(2), deployed: +dep.toFixed(2), working: +wnav.toFixed(2), banked, totalValue: +tv.toFixed(2) });
    }

    for (const ticker of Object.keys(positions)) {
      const pos = positions[ticker]; const bars = hourlyAll[ticker]; if (!bars || !bars.length) { delete positions[ticker]; continue; }
      const last = bars[bars.length - 1];
      closePosition(ticker, pos, exitSlip(last.close, pos.direction), last.date.split(' ')[0], last.date, 'OPEN_AT_END'); totalEndExits++; delete positions[ticker];
    }
    if (dailyLedger.length) { const tv = cash + banked; dailyLedger[dailyLedger.length - 1] = { ...dailyLedger[dailyLedger.length - 1], positions: 0, cash: +cash.toFixed(2), deployed: 0, working: +cash.toFixed(2), banked, totalValue: +tv.toFixed(2) }; }

    const grossCurve = dailyLedger.map(d => ({ date: d.date, equity: d.totalValue }));
    return {
      cfg, grossCurve, exits, dailyLedger, cash, banked,
      totalComm, totalBorrow, totalWithdrawn, totalNewEntries, totalReentries, totalLotFills,
      totalLongEntries, totalShortEntries, totalStopExits, totalEndExits,
      skippedNoCash, skippedNoADV, skippedSizing, worstSingleTrade,
      peakDeployed, peakWorkingNav, peakTotalValue, maxConcurrent,
      sameBarReentry, nextBarReentry, holdBarsHist, milestoneHits, traceLog,
    };
  }

  // ── METRIC HELPERS ────────────────────────────────────────────────────────────
  function curveMetrics(curve, field) {
    const eq = curve.map(d => d[field]); const dts = curve.map(d => String(d.date).slice(0, 10));
    const dret = []; for (let i = 1; i < eq.length; i++) if (eq[i - 1] > 0) dret.push((eq[i] - eq[i - 1]) / eq[i - 1]);
    const sharpe = computeSharpe(dret, dts), sortino = computeSortino(dret);
    let peak = eq[0], maxDD = 0, maxDD$ = 0;
    for (const v of eq) { if (v > peak) peak = v; const dd = (peak - v) / peak; if (dd > maxDD) maxDD = dd; const d$ = peak - v; if (d$ > maxDD$) maxDD$ = d$; }
    const first = eq[0], last = eq[eq.length - 1];
    const years = (new Date(dts[dts.length - 1] + 'T12:00:00') - new Date(dts[0] + 'T12:00:00')) / (365.25 * 86400000);
    const cagr = (first > 0 && years > 0 && last > 0) ? (Math.pow(last / first, 1 / years) - 1) * 100 : (last <= 0 ? -100 : 0);
    const totalReturn = first > 0 ? (last - first) / first * 100 : 0;
    return { cagr, totalReturn, sharpe, sortino, maxDDPct: maxDD * 100, maxDDDollar: maxDD$, ending: last, years };
  }
  function tradeStats(exits) {
    const wins = exits.filter(e => e.pnl > 0), losses = exits.filter(e => e.pnl < 0);
    const gw = wins.reduce((s, e) => s + e.pnl, 0), gl = losses.reduce((s, e) => s + e.pnl, 0);
    const pf = gl ? gw / Math.abs(gl) : Infinity; const wr = exits.length ? wins.length / exits.length * 100 : 0;
    const avgWin = wins.length ? gw / wins.length : 0, avgLoss = losses.length ? Math.abs(gl / losses.length) : 0;
    const sorted = exits.slice().sort((a, b) => (a.date + (a.hour || '')).localeCompare(b.date + (b.hour || '')));
    let req = NAV_INITIAL, rpeak = NAV_INITIAL, realizedDD$ = 0;
    for (const e of sorted) { req += e.pnl; if (req > rpeak) rpeak = req; const d = rpeak - req; if (d > realizedDD$) realizedDD$ = d; }
    return { pf, wr, payoff: avgLoss > 0 ? avgWin / avgLoss : Infinity, avgWin, avgLoss, realizedDD$, count: exits.length };
  }

  // ── DIAG: attribution battery ─────────────────────────────────────────────────
  if (DIAG) {
    const BATTERY = [
      { ...SPEC, label: 'A. Literal V7.5 spec (baseline)' },
      { ...SPEC, carnivoreSignals: true, label: 'B. +V7.4 carnivore signals (C1)' },
      { ...SPEC, reentryEnabled: false, label: 'C. Re-entry OFF (new entries only)' },
      { ...SPEC, reentryTrigger: 'green', label: 'D. Re-entry = confirmed green (V7.4 trigger)' },
      { ...SPEC, reentryStopMode: 'firsthour', label: 'E. Re-entry stop = first-hour low (wide)' },
      { ...SPEC, reentryCooldownBars: 7, label: 'F. Re-entry cooldown = 1 day (~7 bars)' },
      { ...SPEC, trailStartR: 1, label: 'G. Trail starts only after +1R profit' },
      { ...SPEC, trailStartR: 2, label: 'H. Trail starts only after +2R profit' },
      { ...SPEC, gapThrough: false, label: 'I. Gap-through OFF (friction realism cost)' },
      { ...SPEC, reentryTrigger: 'green', reentryStopMode: 'firsthour', trailStartR: 1, label: 'J. Combo: green re-entry + wide stop + trail@1R' },
      { ...SPEC, reentryCooldownBars: 7, reentryStopMode: 'firsthour', trailStartR: 1, carnivoreSignals: true, label: 'K. Combo: cooldown+widestop+trail@1R+carnivore' },
      { ...SPEC, reentryEnabled: false, trailStartR: 1, label: 'L. New-only + trail@1R (trend hold)' },
    ];
    console.log('\n[3] Attribution battery — each variant changes ONE rule vs the literal spec (except J/K/L combos)\n');
    const rows = [];
    for (const cfg of BATTERY) {
      process.stdout.write(`  running ${cfg.label.slice(0, 38).padEnd(40)}`);
      const R = runSim(cfg); const gm = curveMetrics(R.grossCurve, 'equity');
      const { netCurve } = applyFeeEngine(R.grossCurve, FILET_TIER); const nm = curveMetrics(netCurve, 'netEquity');
      const ts = tradeStats(R.exits);
      rows.push({ cfg, R, gm, nm, ts });
      console.log(`gross ${gm.totalReturn >= 0 ? '+' : ''}${gm.totalReturn.toFixed(0)}%  net ${nm.totalReturn >= 0 ? '+' : ''}${nm.totalReturn.toFixed(0)}%  PF ${ts.pf.toFixed(2)}`);
    }

    const f = (v) => (v >= 0 ? '+' : '') + v.toFixed(0) + '%';
    const fm = (v) => '$' + (Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : Math.round(v).toLocaleString());
    console.log('\n' + RULE);
    console.log('  ATTRIBUTION RESULTS  (GROSS / NET total value from $100K, all real frictions)');
    console.log(RULE);
    console.log('  ' + 'Variant'.padEnd(46) + 'GrossRet'.padStart(9) + 'NetRet'.padStart(9) + 'NetCAGR'.padStart(9) + 'PF'.padStart(7) + 'WR'.padStart(7) + 'MaxDD'.padStart(8) + 'Trades'.padStart(9) + 'EndNet'.padStart(10));
    console.log('  ' + '-'.repeat(102));
    for (const r of rows) {
      console.log('  ' + r.cfg.label.padEnd(46) + f(r.gm.totalReturn).padStart(9) + f(r.nm.totalReturn).padStart(9) + f(r.nm.cagr).padStart(9) + (r.ts.pf === Infinity ? '∞' : r.ts.pf.toFixed(2)).padStart(7) + (r.ts.wr.toFixed(0) + '%').padStart(7) + (r.gm.maxDDPct.toFixed(1) + '%').padStart(8) + r.ts.count.toLocaleString().padStart(9) + fm(r.nm.ending).padStart(10));
    }
    // Benchmark references (clearly labeled as NOT defensible / external).
    const btStart = tradingDates[0], btEnd = tradingDates[tradingDates.length - 1];
    const spyS = (spyWeekly.find(w => w.time >= btStart) || spyWeekly[0])?.close || 0; let spyE = spyS;
    for (let i = spyWeekly.length - 1; i >= 0; i--) { if (spyWeekly[i].time <= btEnd) { spyE = spyWeekly[i].close; break; } }
    const spyRet = spyS ? (spyE / spyS - 1) * 100 : 0;
    console.log('  ' + '-'.repeat(102));
    console.log('  ' + 'REF: S&P 500 buy & hold (same window)'.padEnd(46) + f(spyRet).padStart(9));
    console.log('  ' + 'REF: V7.4 backtest (deferred mgmt — INFLATED, not defensible)'.padEnd(60) + '  net +14,793%  PF 7.6  WR 49%');

    // ── Decide the best DEFENSIBLE strategy ──────────────────────────────────────
    const ranked = rows.slice().sort((a, b) => b.nm.cagr - a.nm.cagr);
    const best = ranked[0];
    console.log('\n' + RULE);
    console.log('  VERDICT — best performing DEFENSIBLE configuration');
    console.log(RULE);
    const positive = rows.filter(r => r.nm.totalReturn > 0);
    if (best.nm.totalReturn > 0) {
      console.log(`  Best by net CAGR: ${best.cfg.label}`);
      console.log(`     Net ${f(best.nm.totalReturn)} total · ${f(best.nm.cagr)} CAGR · PF ${best.ts.pf.toFixed(2)} · WR ${best.ts.wr.toFixed(0)}% · MaxDD ${best.gm.maxDDPct.toFixed(1)}% · ending ${fm(best.nm.ending)}`);
      console.log(`     vs S&P 500 buy & hold ${f(spyRet)} over the same window.`);
    } else {
      console.log('  NONE of the defensible variants finish net-positive.');
      console.log(`  Least-bad: ${best.cfg.label} (net ${f(best.nm.totalReturn)}, PF ${best.ts.pf.toFixed(2)}).`);
      console.log(`  S&P 500 buy & hold returned ${f(spyRet)} over the same window with no single-stock risk.`);
      console.log('  → On these rules and this data, Ambush V7.5 has no defensible edge. The V7.4 +14,793%');
      console.log('    was an artifact of next-day deferred management (look-ahead), not a real edge.');
    }
    console.log(`\n  (${positive.length}/${rows.length} variants net-positive. Full per-trade detail available via the canonical run + CSVs.)`);
    console.log('\n' + RULE + '\n');
    process.exit(0);
  }

  // ── CHURN 2×2: does green-confirm and/or a wider stop fix the V7.5 churn? ──────
  // Holds the V7.5 base constant (frozen daily gate + real BULL/BEAR sector filter +
  // AI signals) and varies ONLY the two re-entry levers: trigger (any/green) × stop
  // (tight entry-bar / wide running-low). Answers "would adding green to V7.5 help?"
  if (process.argv.includes('--churn22')) {
    const cells = [
      { ...SPEC, reentryTrigger: 'any',   reentryStopMode: 'entrybar', label: 'any  + tight  (= V7.5 literal spec)' },
      { ...SPEC, reentryTrigger: 'green', reentryStopMode: 'entrybar', label: 'green + tight  (V7.5 + green confirm)' },
      { ...SPEC, reentryTrigger: 'any',   reentryStopMode: 'runlow',   label: 'any  + wide   (V7.5 + wide stop)' },
      { ...SPEC, reentryTrigger: 'green', reentryStopMode: 'runlow',   label: 'green + wide   (V7.5 base, V7.4 re-entry)' },
    ];
    console.log('\n[CHURN 2×2] V7.5 base (frozen daily + real sector filter + AI signals); vary ONLY re-entry trigger × stop\n');
    const f = (v) => (v >= 0 ? '+' : '') + v.toFixed(0) + '%';
    const fm = (v) => '$' + (Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : Math.round(v).toLocaleString());
    console.log('  ' + 're-entry rule'.padEnd(40) + 'GrossRet'.padStart(9) + 'NetRet'.padStart(9) + 'PF'.padStart(7) + 'WR'.padStart(6) + 'Trades'.padStart(9) + 'Re-ent'.padStart(9) + 'EndNet'.padStart(10));
    console.log('  ' + '-'.repeat(99));
    for (const cfg of cells) {
      const R = runSim(cfg); const gm = curveMetrics(R.grossCurve, 'equity');
      const { netCurve } = applyFeeEngine(R.grossCurve, FILET_TIER); const nm = curveMetrics(netCurve, 'netEquity');
      const ts = tradeStats(R.exits);
      console.log('  ' + cfg.label.padEnd(40) + f(gm.totalReturn).padStart(9) + f(nm.totalReturn).padStart(9) + (ts.pf === Infinity ? '∞' : ts.pf.toFixed(2)).padStart(7) + (ts.wr.toFixed(0) + '%').padStart(6) + R.exits.length.toLocaleString().padStart(9) + R.totalReentries.toLocaleString().padStart(9) + fm(nm.ending).padStart(10));
    }
    console.log('\n  Read: compare row 1 (V7.5 today) vs row 2 (V7.5 + green) to see if green alone fixes it;');
    console.log('  rows 3-4 add the wide stop. The winning live config is green + wide (V7.4 re-entry).\n');
    console.log(RULE + '\n');
    process.exit(0);
  }

  // ── VALIDATE 2: full court-defensible report on V7.4+cap vs V7.5+green ─────────
  if (process.argv.includes('--validate2')) {
    const CFG_A = { ...SPEC, label: 'V7.4 + 10% cap (green re-entry, WIDE stop, no daily/sector gate)', carnivoreSignals: true, reentryTrigger: 'green', reentryStopMode: 'runlow', reentryFrozenDaily: false, sectorFilter: false };
    const CFG_B = { ...SPEC, label: 'V7.5 + green (green re-entry, TIGHT stop, frozen daily + sector filter)', reentryTrigger: 'green' };
    const summ = (cfg) => {
      const R = runSim(cfg);
      const gm = curveMetrics(R.grossCurve, 'equity');
      const fee = applyFeeEngine(R.grossCurve, FILET_TIER);
      const nm = curveMetrics(fee.netCurve, 'netEquity');
      const ts = tradeStats(R.exits);
      const gCal = gm.maxDDPct > 0 ? gm.cagr / gm.maxDDPct : 0, nCal = nm.maxDDPct > 0 ? nm.cagr / nm.maxDDPct : 0;
      const checks = [
        ['PF ≤ ~5', ts.pf.toFixed(2) + 'x', ts.pf <= 5],
        ['WR ≤ ~55%', ts.wr.toFixed(0) + '%', ts.wr <= 55],
        ['Worst trade ≤ 5×$300', '$' + Math.round(R.worstSingleTrade).toLocaleString(), Math.abs(R.worstSingleTrade) <= MAX_LOSS * 5],
        ['Fees ~halve gross', `+${gm.totalReturn.toFixed(0)}%→+${nm.totalReturn.toFixed(0)}%`, nm.totalReturn <= gm.totalReturn * 0.75],
        ['Working ≤ $2.2M', '$' + (R.peakWorkingNav / 1e6).toFixed(2) + 'M', R.peakWorkingNav <= 2_200_000],
        ['Not a wipeout', '$' + Math.round(gm.ending).toLocaleString(), gm.ending >= NAV_INITIAL * 0.25],
      ];
      return { R, gm, nm, ts, fee, gCal, nCal, checks, totalValue: R.cash + R.banked };
    };
    const A = summ(CFG_A), B = summ(CFG_B);
    const m = v => '$' + Math.round(v).toLocaleString(); const p = (s, n) => String(s).padStart(n);
    const r2 = (label, a, b) => console.log('  ' + label.padEnd(30) + p(a, 19) + p(b, 19));
    console.log('\n' + RULE);
    console.log('  VALIDATION — court-defensible, honest intraday, $100K start, $2M→bank $1M, all real frictions');
    console.log(RULE);
    console.log('  ' + ''.padEnd(30) + p('V7.4 + 10% cap', 19) + p('V7.5 + green', 19));
    console.log('  ' + '-'.repeat(68));
    r2('GROSS total return', '+' + A.gm.totalReturn.toFixed(0) + '%', '+' + B.gm.totalReturn.toFixed(0) + '%');
    r2('NET total return', '+' + A.nm.totalReturn.toFixed(0) + '%', '+' + B.nm.totalReturn.toFixed(0) + '%');
    r2('GROSS CAGR', '+' + A.gm.cagr.toFixed(1) + '%', '+' + B.gm.cagr.toFixed(1) + '%');
    r2('NET CAGR', '+' + A.nm.cagr.toFixed(1) + '%', '+' + B.nm.cagr.toFixed(1) + '%');
    r2('Ending value (gross)', m(A.gm.ending), m(B.gm.ending));
    r2('Ending value (net)', m(A.nm.ending), m(B.nm.ending));
    r2('Net Sharpe', A.nm.sharpe.toFixed(2), B.nm.sharpe.toFixed(2));
    r2('Net Sortino', A.nm.sortino.toFixed(1), B.nm.sortino.toFixed(1));
    r2('Net max drawdown', A.nm.maxDDPct.toFixed(1) + '%', B.nm.maxDDPct.toFixed(1) + '%');
    r2('Net Calmar', A.nCal.toFixed(2), B.nCal.toFixed(2));
    r2('Profit Factor', A.ts.pf.toFixed(2) + 'x', B.ts.pf.toFixed(2) + 'x');
    r2('Win Rate / payoff', A.ts.wr.toFixed(0) + '% / ' + A.ts.payoff.toFixed(1) + 'x', B.ts.wr.toFixed(0) + '% / ' + B.ts.payoff.toFixed(1) + 'x');
    r2('Total trades', A.R.exits.length.toLocaleString(), B.R.exits.length.toLocaleString());
    r2('  └ re-entries', A.R.totalReentries.toLocaleString(), B.R.totalReentries.toLocaleString());
    r2('Worst single trade', m(A.R.worstSingleTrade), m(B.R.worstSingleTrade));
    r2('Realized max DD ($)', m(A.ts.realizedDD$), m(B.ts.realizedDD$));
    r2('Total value (bank+work)', m(A.totalValue), m(B.totalValue));
    r2('  └ banked / withdrawals', m(A.R.banked) + '/' + Math.round(A.R.totalWithdrawn / WITHDRAWAL_AMOUNT), m(B.R.banked) + '/' + Math.round(B.R.totalWithdrawn / WITHDRAWAL_AMOUNT));
    r2('Peak working NAV', m(A.R.peakWorkingNav), m(B.R.peakWorkingNav));
    r2('Commission / borrow', m(A.R.totalComm) + '/' + m(A.R.totalBorrow), m(B.R.totalComm) + '/' + m(B.R.totalBorrow));
    r2('Fund fees (mgmt+perf)', m(A.fee.totalMgmtFees + A.fee.totalPerfFees), m(B.fee.totalMgmtFees + B.fee.totalPerfFees));
    console.log('\n  §0 SANITY GATE                ' + p('V7.4 + 10% cap', 19) + p('V7.5 + green', 19));
    console.log('  ' + '-'.repeat(68));
    for (let i = 0; i < A.checks.length; i++) {
      const a = A.checks[i], b = B.checks[i];
      console.log('  ' + a[0].padEnd(30) + p((a[2] ? '✅ ' : '⚠️ ') + a[1], 18) + p((b[2] ? '✅ ' : '⚠️ ') + b[1], 18));
    }
    console.log('\n  NOTE: withdrawals never trigger in-sample (neither reaches $2M working in 3.57y), so total');
    console.log('  value = working balance, $0 banked yet. At these CAGRs that begins ~year 6-7.\n');
    console.log(RULE + '\n');
    process.exit(0);
  }

  // ── CANONICAL RUN — full report + artifacts ───────────────────────────────────
  // Default = literal V7.5 spec. V74HONEST=1 = V7.4's OWN entry rules (green-confirmed
  // re-entry, wide running-low stop, NO daily gate, NO sector filter, carnivore signals)
  // but run through this HONEST intraday engine (bar-by-bar mgmt, gap-through, 2% ADV,
  // real frictions, $2M→$1M withdrawal). This is the court-defensible number for V7.4's
  // rules — what V7.4 actually does once the next-day look-ahead is removed.
  const V74_HONEST = process.env.V74HONEST === '1';
  const V75_GREEN = process.env.V75GREEN === '1';
  const ACTIVE_CFG = V74_HONEST
    ? { ...SPEC, label: 'V7.4 rules — HONEST intraday', carnivoreSignals: true, reentryTrigger: (process.env.RETRIG || 'green'), reentryStopMode: 'runlow', reentryFrozenDaily: false, sectorFilter: false }
    : V75_GREEN
    ? { ...SPEC, label: 'V7.5 + green-confirmed re-entry', reentryTrigger: 'green' }
    : SPEC;
  const cfgName = V74_HONEST ? "V7.4's rules (honest intraday)" : V75_GREEN ? 'V7.5 + green-confirmed re-entry' : 'the canonical literal-spec';
  console.log(`\n[3] Running ${cfgName}${CLOCKHOUR ? ' on :00 TWS clock-hour bars' : ''} simulation...\n`);
  const R = runSim(ACTIVE_CFG);
  const {
    grossCurve, exits, dailyLedger, cash, banked,
    totalComm, totalBorrow, totalWithdrawn, totalNewEntries, totalReentries, totalLotFills,
    totalLongEntries, totalShortEntries, totalStopExits, totalEndExits,
    skippedNoCash, skippedNoADV, skippedSizing, worstSingleTrade,
    peakDeployed, peakWorkingNav, peakTotalValue, maxConcurrent,
    sameBarReentry, nextBarReentry, holdBarsHist, milestoneHits, traceLog,
  } = R;

  console.log('[4] Building GROSS total-value curve + metrics...');
  const grossM = curveMetrics(grossCurve, 'equity');
  console.log('[5] Applying Filet-100k fund-fee overlay (GROSS → NET)...');
  const { netCurve, totalMgmtFees, totalPerfFees, finalHwm, quarterlyLog } = applyFeeEngine(grossCurve, FILET_TIER);
  const netM = curveMetrics(netCurve, 'netEquity');
  const ts = tradeStats(exits);
  const { pf, wr, payoff, avgWin, avgLoss, realizedDD$ } = { ...ts, realizedDD$: ts.realizedDD$ };

  // Positive months on the gross total-value curve.
  let posMonths = 0, totMonths = 0; let prevMonthVal = grossCurve[0]?.equity || NAV_INITIAL; let curMonth = grossCurve[0]?.date.slice(0, 7);
  for (let i = 1; i < grossCurve.length; i++) { const m = grossCurve[i].date.slice(0, 7); if (m !== curMonth) { totMonths++; if (grossCurve[i - 1].equity > prevMonthVal) posMonths++; prevMonthVal = grossCurve[i - 1].equity; curMonth = m; } }
  totMonths++; if (grossCurve[grossCurve.length - 1].equity > prevMonthVal) posMonths++;
  const posMonthsPct = totMonths ? (posMonths / totMonths) * 100 : 0;

  // Benchmark.
  const btStart = tradingDates[0], btEnd = tradingDates[tradingDates.length - 1];
  const spyStartC = (spyWeekly.find(w => w.time >= btStart) || spyWeekly[0])?.close || 0; let spyEndC = spyStartC;
  for (let i = spyWeekly.length - 1; i >= 0; i--) { if (spyWeekly[i].time <= btEnd) { spyEndC = spyWeekly[i].close; break; } }
  const spyRetPct = spyStartC ? (spyEndC / spyStartC - 1) * 100 : 0;
  const weekEndVal = {}; for (const d of grossCurve) weekEndVal[getWeekOf(d.date)] = d.equity;
  const weeks = Object.keys(weekEndVal).sort(); const spyByWeek = {}; for (const w of spyWeekly) spyByWeek[w.time] = w.close;
  const fundWk = [], spyWk = [];
  for (let i = 1; i < weeks.length; i++) { const w0 = weeks[i - 1], w1 = weeks[i]; if (weekEndVal[w0] > 0 && spyByWeek[w0] && spyByWeek[w1]) { fundWk.push((weekEndVal[w1] - weekEndVal[w0]) / weekEndVal[w0]); spyWk.push((spyByWeek[w1] - spyByWeek[w0]) / spyByWeek[w0]); } }
  let beta = 0, r2 = 0, capmAlpha = 0;
  if (fundWk.length > 2) {
    const mf = fundWk.reduce((s, x) => s + x, 0) / fundWk.length, msv = spyWk.reduce((s, x) => s + x, 0) / spyWk.length;
    let cov = 0, varS = 0, varF = 0; for (let i = 0; i < fundWk.length; i++) { cov += (fundWk[i] - mf) * (spyWk[i] - msv); varS += (spyWk[i] - msv) ** 2; varF += (fundWk[i] - mf) ** 2; }
    beta = varS > 0 ? cov / varS : 0; r2 = (varS > 0 && varF > 0) ? (cov * cov) / (varS * varF) : 0; capmAlpha = (mf - beta * msv) * 52 * 100;
  }
  const alphaDollar = Math.round(grossM.ending - NAV_INITIAL * (1 + spyRetPct / 100));

  // §0 sanity gate (both directions).
  const sanity = [];
  sanity.push({ name: 'Profit Factor low single digits (≤ ~5x)', val: pf.toFixed(2) + 'x', pass: pf <= 5 });
  sanity.push({ name: 'Win Rate trend-style (≤ ~55%)', val: wr.toFixed(1) + '%', pass: wr <= 55 });
  sanity.push({ name: 'Worst trade near the risk cap (≤ ~5×$300)', val: '$' + Math.round(worstSingleTrade).toLocaleString(), pass: Math.abs(worstSingleTrade) <= MAX_LOSS * 5 });
  sanity.push({ name: 'Fees roughly halve gross return', val: `gross +${grossM.totalReturn.toFixed(0)}% → net +${netM.totalReturn.toFixed(0)}%`, pass: netM.totalReturn <= grossM.totalReturn * 0.75 });
  sanity.push({ name: 'Working capital stays ~$1M–$2M', val: 'peak working $' + (peakWorkingNav / 1e6).toFixed(2) + 'M', pass: peakWorkingNav <= 2_200_000 });
  sanity.push({ name: 'Not a catastrophic wipeout (≥ 25% of start)', val: 'total value $' + Math.round(grossM.ending).toLocaleString(), pass: grossM.ending >= NAV_INITIAL * 0.25 });
  const allPass = sanity.every(s => s.pass);

  const fmt$ = v => '$' + Math.round(v).toLocaleString(); const pad = (s, n) => String(s).padStart(n);
  console.log('\n' + RULE);
  const TITLE = (V74_HONEST ? 'V7.4 RULES — HONEST INTRADAY' : V75_GREEN ? 'V7.5 + GREEN RE-ENTRY' : 'AMBUSH V7.5 — DEFENSIBLE') + (CLOCKHOUR ? ' · :00 TWS BARS' : '') + ' (court-defensible)';
  console.log('  ' + TITLE + '  (' + btStart + ' → ' + btEnd + ', ' + grossM.years.toFixed(2) + ' years)');
  console.log(RULE);
  console.log('\n  ┌─ HEADLINE (total value = banked + working) ────────────────────────────────┐');
  console.log(`     Total value (GROSS):  ${fmt$(grossM.ending)}   = banked ${fmt$(banked)} + working ${fmt$(cash)}`);
  console.log(`     Withdrawal events: ${Math.round(totalWithdrawn / WITHDRAWAL_AMOUNT)}`);
  console.log('  └────────────────────────────────────────────────────────────────────────────┘');
  console.log('\n  METRIC                         GROSS              NET (Filet 100k)');
  console.log('  ' + '-'.repeat(72));
  const row = (label, g, n) => console.log('  ' + label.padEnd(28) + ' ' + pad(g, 17) + '   ' + pad(n, 17));
  row('Total Return', '+' + grossM.totalReturn.toFixed(1) + '%', '+' + netM.totalReturn.toFixed(1) + '%');
  row('CAGR', '+' + grossM.cagr.toFixed(1) + '%', '+' + netM.cagr.toFixed(1) + '%');
  row('Ending (compounded)', fmt$(grossM.ending), fmt$(netM.ending));
  row('Sharpe', grossM.sharpe.toFixed(2), netM.sharpe.toFixed(2));
  row('Sortino', grossM.sortino.toFixed(1), netM.sortino.toFixed(1));
  row('Max Drawdown (paper)', grossM.maxDDPct.toFixed(2) + '%', netM.maxDDPct.toFixed(2) + '%');
  const gCalmar = grossM.maxDDPct > 0 ? (grossM.cagr / grossM.maxDDPct) : 0, nCalmar = netM.maxDDPct > 0 ? (netM.cagr / netM.maxDDPct) : 0;
  row('Calmar (CAGR/maxDD)', gCalmar.toFixed(2), nCalmar.toFixed(2));

  console.log('\n  TRADE STATS (after all trading frictions, pre-fund-fees)');
  console.log('  ' + '-'.repeat(72));
  console.log(`     Profit Factor ${pf.toFixed(2)}x   Win Rate ${wr.toFixed(1)}%   Payoff ${payoff.toFixed(2)}x   Pos Months ${posMonthsPct.toFixed(0)}%`);
  console.log(`     Trades ${exits.length.toLocaleString()}  (new ${totalNewEntries.toLocaleString()} / re-entry ${totalReentries.toLocaleString()})   Longs ${totalLongEntries.toLocaleString()} / Shorts ${totalShortEntries.toLocaleString()}`);
  console.log(`     Avg win ${fmt$(avgWin)}   Avg loss ${fmt$(-avgLoss)}   Worst single trade ${fmt$(worstSingleTrade)}`);
  console.log(`     Lot fills ${totalLotFills.toLocaleString()}   Stop exits ${totalStopExits.toLocaleString()}   Open-at-end ${totalEndExits}   Max concurrent ${maxConcurrent}`);
  console.log(`     Realized max drawdown: ${fmt$(realizedDD$)}`);

  console.log('\n  CHURN DIAGNOSTIC');
  console.log('  ' + '-'.repeat(72));
  const reTot = totalReentries || 1;
  console.log(`     Re-entries SAME bar as exit: ${sameBarReentry.toLocaleString()} (${(100 * sameBarReentry / reTot).toFixed(1)}%)   NEXT bar: ${nextBarReentry.toLocaleString()} (${(100 * nextBarReentry / reTot).toFixed(1)}%)`);
  const hb = Object.entries(holdBarsHist).map(([k, v]) => [+k, v]).sort((a, b) => a[0] - b[0]); const totHB = hb.reduce((s, [, v]) => s + v, 0) || 1;
  const within = (n) => hb.filter(([k]) => k <= n).reduce((s, [, v]) => s + v, 0);
  console.log(`     Stopped within 1 bar ${(100 * within(1) / totHB).toFixed(0)}% · 2 bars ${(100 * within(2) / totHB).toFixed(0)}% · 3 bars ${(100 * within(3) / totHB).toFixed(0)}%`);
  let cHB = 0, medHB = '?'; for (const [k, v] of hb) { cHB += v; if (cHB >= totHB / 2) { medHB = k; break; } }
  console.log(`     Median hold before stop-out: ${medHB} hourly bar(s)`);
  if (TRACE_TICKER) {
    console.log(`\n  TRACE — ${TRACE_TICKER} (first 60 events)`);
    for (const e of traceLog.slice(0, 60)) {
      if (e.ev === 'EXIT') console.log(`   ${e.date} ${e.hour} gi${e.gi}  EXIT(${e.kind})  ${e.barOHLC}  stop=${e.stop} fill=${e.fill} sh=${e.sh} lots=${e.lots} pnl=$${e.pnl} held=${e.heldBars}b`);
      else console.log(`   ${e.date} ${e.hour} gi${e.gi}  ${e.ev}${e.barsSinceExit != null ? '(+' + e.barsSinceExit + 'b)' : ''}  ${e.barOHLC}  entry=${e.ep} stop=${e.stop} rps=${e.rps} sh=${e.sh}${e.frozenDaily ? ' frozen=' + e.frozenDaily : ''}`);
    }
    console.log(`   ... (${traceLog.length} total events)`);
  }

  console.log('\n  FRICTIONS & FEES');
  console.log('  ' + '-'.repeat(72));
  console.log(`     Trading: commission ${fmt$(totalComm)} + borrow ${fmt$(totalBorrow)}`);
  console.log(`     Fund fees: mgmt ${fmt$(totalMgmtFees)} + perf ${fmt$(totalPerfFees)} = ${fmt$(totalMgmtFees + totalPerfFees)}   (quarters w/ PA: ${quarterlyLog.filter(q => q.pa > 0).length}/${quarterlyLog.length})`);
  console.log(`     Skipped — no cash ${skippedNoCash.toLocaleString()} · thin ADV ${skippedNoADV.toLocaleString()} · sizing<1 ${skippedSizing.toLocaleString()}`);

  console.log('\n  CAPACITY / WORKING CAPITAL');
  console.log('  ' + '-'.repeat(72));
  console.log(`     Peak working NAV ${fmt$(peakWorkingNav)}   Peak deployed ${fmt$(peakDeployed)}   Peak total value ${fmt$(peakTotalValue)}`);

  console.log('\n  BENCHMARK vs S&P 500 (SPY)');
  console.log('  ' + '-'.repeat(72));
  console.log(`     SPY return ${spyRetPct >= 0 ? '+' : ''}${spyRetPct.toFixed(1)}%   Alpha ${fmt$(alphaDollar)}   Beta ${beta.toFixed(2)}   R² ${r2.toFixed(2)}   CAPM α ${capmAlpha.toFixed(1)}%/yr`);

  console.log('\n' + RULE);
  console.log('  §0 SANITY GATE  ' + (allPass ? '✅ ALL PASS' : '⚠️  ONE OR MORE FLAGS — INVESTIGATE BEFORE TRUSTING'));
  console.log(RULE);
  for (const s of sanity) console.log(`   ${s.pass ? '✅' : '⚠️ '} ${s.name.padEnd(46)} ${s.val}`);

  // Artifacts.
  const results = {
    generatedBy: 'pai300HourlyV75_defensible.js', spec: 'AMBUSH_V75_BACKTEST_SPEC.md', version: '7.5.0-defensible',
    window: { start: btStart, end: btEnd, years: +grossM.years.toFixed(2), tradingDays: tradingDates.length },
    headline: { totalValueGross: Math.round(grossM.ending), banked, workingFinal: Math.round(cash), peakWorkingNav: Math.round(peakWorkingNav), peakTotalValue: Math.round(peakTotalValue) },
    gross: { totalReturnPct: +grossM.totalReturn.toFixed(1), cagrPct: +grossM.cagr.toFixed(1), sharpe: +grossM.sharpe.toFixed(2), sortino: +grossM.sortino.toFixed(1), maxDDPct: +grossM.maxDDPct.toFixed(2), ending: Math.round(grossM.ending) },
    net: { totalReturnPct: +netM.totalReturn.toFixed(1), cagrPct: +netM.cagr.toFixed(1), sharpe: +netM.sharpe.toFixed(2), sortino: +netM.sortino.toFixed(1), maxDDPct: +netM.maxDDPct.toFixed(2), ending: Math.round(netM.ending) },
    trades: { total: exits.length, newEntries: totalNewEntries, reentries: totalReentries, profitFactor: +pf.toFixed(2), winRatePct: +wr.toFixed(1), payoff: +payoff.toFixed(2), worstSingleTrade: +worstSingleTrade.toFixed(2) },
    fees: { commission: +totalComm.toFixed(2), borrow: +totalBorrow.toFixed(2), mgmt: +totalMgmtFees.toFixed(2), perf: +totalPerfFees.toFixed(2) },
    benchmark: { spyReturnPct: +spyRetPct.toFixed(1), alphaDollar, beta: +beta.toFixed(2), r2: +r2.toFixed(2) },
    sanityGate: { allPass, checks: sanity },
  };
  try {
    const dl = path.join(os.homedir(), 'Downloads');
    const TAG = (V74_HONEST ? 'V7.4_HonestIntraday' : V75_GREEN ? 'V7.5_Green' : 'V7.5_Defensible') + (CLOCKHOUR ? '_ClockHour' : '');
    fs.writeFileSync(path.join(dl, `PNTHR_Ambush_${TAG}_Results.json`), JSON.stringify(results, null, 2));
    const sortedExits = exits.slice().sort((a, b) => (a.date + (a.hour || '')).localeCompare(b.date + (b.hour || '')));
    const tHead = ['ExitDate', 'Hour', 'Ticker', 'Direction', 'Reentry', 'Shares', 'AvgCost', 'ExitPrice', 'ExitType', 'PnL', 'EntryDate'];
    const tRows = sortedExits.map(e => [e.date, e.hour || '', e.ticker, e.direction, e.isReentry ? 'Y' : 'N', e.shares, e.avgCost, e.exitPrice, e.type, e.pnl, e.entryDate].join(','));
    fs.writeFileSync(path.join(dl, `PNTHR_Ambush_${TAG}_ClosedTrades.csv`), [tHead.join(','), ...tRows].join('\n'));
    const nByDate = {}; for (const n of netCurve) nByDate[n.date] = n.netEquity;
    const cHead = ['Date', 'Positions', 'Cash', 'Deployed', 'Working', 'Banked', 'TotalValueGross', 'TotalValueNet'];
    const cRows = dailyLedger.map(d => [d.date, d.positions, d.cash, d.deployed, d.working, d.banked, d.totalValue, nByDate[d.date] ?? ''].join(','));
    fs.writeFileSync(path.join(dl, `PNTHR_Ambush_${TAG}_DailyNAV.csv`), [cHead.join(','), ...cRows].join('\n'));
    console.log(`\n  Wrote ~/Downloads: PNTHR_Ambush_${TAG}_{Results.json, ClosedTrades.csv, DailyNAV.csv}`);
  } catch (e) { console.error('  artifact export failed:', e.message); }

  // ── EMIT_BASELINE=1 — write the LIVE dashboard projection baseline (V7.6) ──────
  // The dashboard's "Projected vs Actual AUM" card rides these daily factors. We use the
  // NET curve so the projected line is apples-to-apples with the real (net-of-everything)
  // account it's compared against. Only the canonical V7.6 run (green + :00) may write it.
  if (process.env.EMIT_BASELINE === '1' && V75_GREEN && CLOCKHOUR) {
    const factors = netCurve.map((n, i) => ({ i, date: n.date, factor: +(n.netEquity / NAV_INITIAL).toFixed(6) }));
    const recovery = netM.maxDDDollar > 0 ? +((netM.ending - NAV_INITIAL) / netM.maxDDDollar).toFixed(1) : null;
    const projOut = {
      generatedFrom: 'pai300HourlyV75_defensible.js V7.6 (green re-entry, :00 TWS clock-hour bars, NET of fund fees)',
      version: '7.6.0',
      backtestStartNav: NAV_INITIAL,
      backtestEndNav: Math.round(netM.ending),
      tradingDays: factors.length,
      metrics: {
        netReturnPct: +netM.totalReturn.toFixed(1), cagrPct: +netM.cagr.toFixed(1),
        sharpe: +netM.sharpe.toFixed(2), sortino: +netM.sortino.toFixed(1),
        profitFactor: +pf.toFixed(1), calmar: +nCalmar.toFixed(2), recoveryFactor: recovery,
        positiveMonthsPct: +posMonthsPct.toFixed(1), winRatePct: +wr.toFixed(0), payoff: +payoff.toFixed(1),
        maxDDPct: +netM.maxDDPct.toFixed(2), totalClosed: exits.length, endingEquity: Math.round(netM.ending),
        alphaDollar: Math.round(netM.ending - NAV_INITIAL * (1 + spyRetPct / 100)),
        alphaPct: +(netM.totalReturn - spyRetPct).toFixed(1), spyReturnPct: +spyRetPct.toFixed(1), startNav: NAV_INITIAL,
      },
      factors,
    };
    try {
      const projPath = new URL('../data/ambushProjectionBaseline.json', import.meta.url).pathname;
      fs.writeFileSync(projPath, JSON.stringify(projOut));
      console.log(`\n  Wrote LIVE projection baseline: server/data/ambushProjectionBaseline.json (V7.6, ${factors.length} days, net +${netM.totalReturn.toFixed(0)}%)`);
    } catch (e) { console.error('  baseline write failed:', e.message); }
  }

  console.log('\n' + RULE + '\n');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
