// server/ambush/ambushEngine.js
// ── PNTHR AMBUSH V7.3 — Live State Machine ─────────────────────────────────
//
// Replicates the V7 stress-test backtest logic for live intraday trading.
// States: STALKING → ATTACK → ACTIVE → PROTECT
//
// Called every 60 seconds by ambushCron.js during market hours.
// Data source: IBKR live prices (held tickers) + FMP quotes (non-held).
// Synthetic hourly OHLC bars built from 60-second price ticks for
// breakout detection and trailing exit pattern matching.
//
// All order actions are written to pnthr_ambush_outbox for the IBKR bridge.
//
// Constants match V7 backtest exactly:
//   - $75 Break Even threshold
//   - 2-bar trailing stop exit
//   - 5-lot pyramid (35/25/20/12/8%)
//   - $300 max risk, 1% NAV, 10% ticker cap
//   - 5bps slippage, IBKR Pro Fixed commissions
// ────────────────────────────────────────────────────────────────────────────

import { calcCommission } from '../backtest/costEngine.js';
import { detectAllSignals } from '../signalDetection.js';
import { SECTORS } from '../scripts/aiUniverse/aiUniverseData.js';
import { SECTOR_EMA_PERIODS } from '../data/pnthrAiSectorsConfig.js';
import { CARNIVORE_MODE_TICKERS } from '../data/strategyMode.js';
import { connectToDatabase } from '../database.js';

// ── Constants (locked to V7 backtest) ───────────────────────────────────────
export const AMBUSH_VERSION = '7.4.0';  // no regime gate (longs+shorts any regime) + 2-bar exit governs (no $75 BE snap)

export const BE_THRESHOLD    = 75;       // dollars unrealized profit to trigger Break Even
export const VITALITY_PCT    = 0.01;     // 1% NAV per position risk
export const TICKER_CAP_PCT  = 0.10;     // 10% NAV max per ticker
export const MAX_LOSS        = 300;      // $300 max risk per position
export const STRIKE_PCT      = [0.35, 0.25, 0.20, 0.12, 0.08];
export const LOT_OFFSETS     = [0, 0.03, 0.06, 0.10, 0.14];
export const SLIPPAGE_BPS    = 5;
export const FIRST_HOUR_END  = '10:30';
export const PAI300_REGIME_PERIOD = 36;
export const WITHDRAWAL_THRESHOLD = 2_000_000;
export const WITHDRAWAL_AMOUNT    = 1_000_000;
export const COMMISSION_PER_SHARE = 0.005;     // IBKR Pro Fixed

// ── Graduated Sizing Thresholds ────────────────────────────────────────────
// 50% sizing until $125K NAV, 75% until $166K, then 100%.
// Keeps risk-per-trade / NAV ratio constant as the fund grows.
export const GRAD_TIER_1 = 125_000;   // 50% → 75%
export const GRAD_TIER_2 = 166_000;   // 75% → 100%

export function getSizingMultiplier(currentNav) {
  if (currentNav >= GRAD_TIER_2) return 1.00;
  if (currentNav >= GRAD_TIER_1) return 0.75;
  return 0.50;
}

export function getSizingTierLabel(currentNav) {
  if (currentNav >= GRAD_TIER_2) return '100%';
  if (currentNav >= GRAD_TIER_1) return '75%';
  return '50%';
}

// State labels for the UI Kanban board
export const STATES = {
  STALKING: 'STALKING',   // First-hour low captured, watching for break
  ATTACK:   'ATTACK',     // Tripwire broken, confirmed breakout queued for next bar
  FILLING:  'FILLING',    // Entry order sent — NOT held until IBKR confirms the fill
  ACTIVE:   'ACTIVE',     // Position open (IBKR-confirmed), lots loading, pre-Break Even
  PROTECT:  'PROTECT',    // Break Even hit, trailing stop ratcheting
};

// ── Carnivore sector maps (from V7 backtest) ────────────────────────────────
const CARNIVORE_SECTOR_MAP = {
  'Technology':'XLK','Energy':'XLE','Healthcare':'XLV','Health Care':'XLV',
  'Financial Services':'XLF','Financials':'XLF','Consumer Discretionary':'XLY',
  'Consumer Cyclical':'XLY','Communication Services':'XLC','Industrials':'XLI',
  'Basic Materials':'XLB','Materials':'XLB','Real Estate':'XLRE','Utilities':'XLU',
  'Consumer Staples':'XLP','Consumer Defensive':'XLP',
};
const ETF_EMA_PERIOD = {
  XLK: 21, XLV: 24, XLF: 25, XLI: 24, XLE: 26, XLC: 21,
  XLRE: 26, XLU: 21, XLB: 19, XLY: 19, XLP: 18,
};
const CARNIVORE_GICS = {
  AKAM:'Technology',ANET:'Technology',CDW:'Technology',COHR:'Technology',
  INTC:'Technology',KLAC:'Technology',SNDK:'Technology',
  META:'Communication Services',TSLA:'Consumer Discretionary',CSGP:'Real Estate',
  CEG:'Utilities',EQT:'Energy',TRGP:'Energy',
  APH:'Industrials',ARM:'Industrials',EMR:'Industrials',ETN:'Industrials',
  GEV:'Industrials',HUBB:'Industrials',LDOS:'Industrials',TDG:'Industrials',
  TRMB:'Industrials',CMI:'Industrials',
  IBM:'Technology',ORCL:'Technology',TTD:'Technology',VST:'Utilities',LITE:'Technology',
};

// ── AI Ticker Metadata ──────────────────────────────────────────────────────
const AI_TICKER_META = {};
for (const sec of SECTORS) {
  for (const h of sec.holdings) AI_TICKER_META[h.ticker] = { sectorId: sec.id, sector: sec.name };
}

export function getSectorName(ticker) {
  // All AI 300 tickers (including 26 Carnivore overlap) use AI sector names.
  return AI_TICKER_META[ticker]?.sector || 'Technology';
}

export function getAiTickers() {
  return Object.keys(AI_TICKER_META);
}

// ── Helper functions (exact copies from V7 backtest) ────────────────────────
export function getWeekOf(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const dow = d.getDay();
  const daysToMon = dow === 0 ? -6 : 1 - dow;
  const m = new Date(d);
  m.setDate(d.getDate() + daysToMon);
  return m.toISOString().split('T')[0];
}

function computeEMASeed(closes, period) {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  const result = new Array(period - 1).fill(null);
  result.push(ema);
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

export function extractTime(dateStr) {
  const p = dateStr.split(' ');
  return p.length > 1 ? p[1].slice(0, 5) : '00:00';
}

export function isConfirmedGreenBreakout(bar, prevBar) {
  return prevBar && bar.close > bar.open && bar.high > prevBar.high && bar.close > prevBar.high;
}

export function isConfirmedRedBreakdown(bar, prevBar) {
  return prevBar && bar.close < bar.open && bar.low < prevBar.low && bar.close < prevBar.low;
}

export function applySlip(price, adverse) {
  const s = price * (SLIPPAGE_BPS / 10000);
  return adverse ? +(price + s).toFixed(4) : +(price - s).toFixed(4);
}

export function entrySlip(price, dir) {
  return dir === 'LONG' ? applySlip(price, true) : applySlip(price, false);
}

export function exitSlip(price, dir) {
  return dir === 'LONG' ? applySlip(price, false) : applySlip(price, true);
}

// ── Sizing (V7 logic + graduated multiplier) ────────────────────────────────
// sizingMultiplier: 0.50 / 0.75 / 1.00 based on NAV tier
export function sizeLots(entryPrice, stopPrice, direction, nav, sizingMultiplier = 1.0) {
  const rps = direction === 'LONG' ? entryPrice - stopPrice : stopPrice - entryPrice;
  if (rps <= 0.01) return null;

  let totalShares = Math.min(
    Math.floor(MAX_LOSS / rps),
    Math.floor((nav * VITALITY_PCT) / rps),
    Math.floor((nav * TICKER_CAP_PCT) / entryPrice)
  );

  // Apply graduated sizing
  totalShares = Math.max(1, Math.floor(totalShares * sizingMultiplier));
  if (totalShares < 1) return null;

  const lotPlan = STRIKE_PCT.map(p => Math.max(1, Math.round(totalShares * p)));
  const l1Shares = lotPlan[0];

  return { totalShares, lotPlan, l1Shares, rps };
}

// ── Weekly signal + regime functions ────────────────────────────────────────
// These load from MongoDB and cache for the duration of each cron tick.
// The cron tick calls loadSignalContext() once, then passes the context
// to all processing functions.

export async function loadSignalContext(db) {
  // Weekly bars for signal detection
  const weeklyDocs = await db.collection('pnthr_ai_bt_candles_weekly')
    .find({}, { projection: { ticker: 1, weekly: 1 } }).toArray();

  const weeklyBarsByTicker = {};
  for (const doc of weeklyDocs) {
    const sorted = (doc.weekly || []).sort((a, b) => (a.weekOf || a.date).localeCompare(b.weekOf || b.date));
    weeklyBarsByTicker[doc.ticker] = sorted.map(w => ({
      time: w.weekOf || w.date, open: w.open, high: w.high, low: w.low, close: w.close,
    }));
  }

  // PAI300 regime
  const pai300Doc = await db.collection('pnthr_ai_index_candles_weekly').findOne({ ticker: 'PAI300' });
  const pai300Weekly = (pai300Doc?.weekly || []).sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  const pai300Closes = pai300Weekly.map(w => w.close);
  const pai300Ema = computeEMASeed(pai300Closes, PAI300_REGIME_PERIOD);
  const pai300RegimeByWeek = {};
  for (let i = 0; i < pai300Weekly.length; i++) {
    if (pai300Ema[i] != null) pai300RegimeByWeek[pai300Weekly[i].weekOf] = pai300Closes[i] > pai300Ema[i];
  }

  // NOTE: SPY regime + ETF EMA loading REMOVED in v7.1.
  // Ambush is AI 300 only — ALL tickers use PAI300 regime (getRegime)
  // and AI sector tier ranking (getSectorOk). No Carnivore ETF gates.

  // AI sector tier ranks
  const sectorRankDocs = await db.collection('pnthr_ai_sector_rank_daily')
    .find({}).sort({ date: 1 }).toArray();
  const aiSectorTierByDate = {};
  for (const doc of sectorRankDocs) {
    const tiers = {};
    for (const r of (doc.ranks || [])) tiers[r.sectorId] = r.tier;
    aiSectorTierByDate[doc.date] = tiers;
  }

  // Compute weekly signals for all AI tickers
  const allTickers = Object.keys(weeklyBarsByTicker).filter(t => AI_TICKER_META[t] || CARNIVORE_MODE_TICKERS.has(t));
  const signalsByTicker = {};
  for (const ticker of allTickers) {
    const bars = weeklyBarsByTicker[ticker];
    if (!bars || bars.length < 35) continue;
    const isCarnivore = CARNIVORE_MODE_TICKERS.has(ticker);
    const sectorId = AI_TICKER_META[ticker]?.sectorId;
    const period = isCarnivore ? 21 : (SECTOR_EMA_PERIODS[sectorId] ?? SECTOR_EMA_PERIODS[String(sectorId)] ?? 30);
    const gateOffset = isCarnivore ? 0.10 : 0.25;
    const result = detectAllSignals(bars, period, false, null, gateOffset);

    const activeBLPeriods = [], activeSSPeriods = [];
    let blStart = null, blEntry = null, ssStart = null, ssEntry = null;
    for (const evt of result.events) {
      // Capture the breakout entry level (the "trigger") that fired each signal, so the
      // engine can freeze it as the Weekly Trigger for the re-entry cross-check.
      if (evt.signal === 'BL') { blStart = evt.time; blEntry = evt.entry ?? null; }
      if ((evt.signal === 'BE' || evt.signal === 'SS') && blStart) {
        activeBLPeriods.push({ from: blStart, to: evt.time, entry: blEntry });
        blStart = null; blEntry = null;
      }
      if (evt.signal === 'SS') { ssStart = evt.time; ssEntry = evt.entry ?? null; }
      if ((evt.signal === 'SE' || evt.signal === 'BL') && ssStart) {
        activeSSPeriods.push({ from: ssStart, to: evt.time, entry: ssEntry });
        ssStart = null; ssEntry = null;
      }
    }
    if (blStart) activeBLPeriods.push({ from: blStart, to: '9999-12-31', entry: blEntry });
    if (ssStart) activeSSPeriods.push({ from: ssStart, to: '9999-12-31', entry: ssEntry });
    signalsByTicker[ticker] = { activeBLPeriods, activeSSPeriods, isCarnivore };
  }

  return {
    weeklyBarsByTicker,
    pai300RegimeByWeek,
    aiSectorTierByDate,
    signalsByTicker,
  };
}

// ── Gate functions ──────────────────────────────────────────────────────────
// Ambush is AI 300 only — ALL tickers use PAI300 regime (not SPY).

export function getRegime(ctx, ticker, dateStr) {
  const weekOf = getWeekOf(dateStr);
  const rm = ctx.pai300RegimeByWeek;
  if (rm[weekOf] !== undefined) return rm[weekOf];
  const ws = Object.keys(rm).sort();
  let best = null;
  for (const w of ws) { if (w <= weekOf) best = w; else break; }
  return best !== null ? rm[best] : true;
}

export function getSectorOk(ctx, ticker, dateStr) {
  // Ambush is AI 300 only — ALL tickers (including the 26 Carnivore overlap)
  // use AI sector tier ranking. Every AI 300 ticker is in AI_TICKER_META.
  const sectorId = AI_TICKER_META[ticker]?.sectorId;
  if (!sectorId) return true; // unknown sector → pass through

  const dates = Object.keys(ctx.aiSectorTierByDate).sort();
  let best = null;
  for (const d of dates) { if (d <= dateStr) best = d; else break; }
  if (!best) return true;
  return ctx.aiSectorTierByDate[best]?.[sectorId] !== 'AVOID';
}

export function isActiveBL(ctx, ticker, dateStr) {
  const sig = ctx.signalsByTicker[ticker];
  if (!sig) return false;
  const weekOf = getWeekOf(dateStr);
  for (const p of sig.activeBLPeriods) {
    if (weekOf >= p.from && weekOf <= p.to) return true;
  }
  return false;
}

export function isActiveSS(ctx, ticker, dateStr) {
  const sig = ctx.signalsByTicker[ticker];
  if (!sig) return false;
  const weekOf = getWeekOf(dateStr);
  for (const p of sig.activeSSPeriods) {
    if (weekOf >= p.from && weekOf <= p.to) return true;
  }
  return false;
}

// The WEEKLY TRIGGER for the currently-active signal = the breakout entry level that
// fired it (prior 2-week high + $0.01 for a BL, prior 2-week low − $0.01 for an SS).
// Frozen for the life of the signal cycle (the period's entry doesn't change); when a
// NEW BL/SS fires, a new period starts with a new entry. `from` is the period's start
// week, used to detect a new cycle (recapture the daily trigger). Returns
// { level, from, dir } or null when no weekly signal is active.
export function getWeeklyTrigger(ctx, ticker, dateStr) {
  const sig = ctx.signalsByTicker[ticker];
  if (!sig) return null;
  const weekOf = getWeekOf(dateStr);
  for (const p of sig.activeBLPeriods) {
    if (weekOf >= p.from && weekOf <= p.to) return { level: p.entry ?? null, from: p.from, dir: 'LONG' };
  }
  for (const p of sig.activeSSPeriods) {
    if (weekOf >= p.from && weekOf <= p.to) return { level: p.entry ?? null, from: p.from, dir: 'SHORT' };
  }
  return null;
}

// NOTE: getWeeklyStopLong / getWeeklyStopShort were removed in V7.3.
// Ambush uses the first-hour low (minus fee) as the ONLY initial stop.
// Carnivore and the weekly AI 300 strategy still use weekly stops via
// signalDetection.js (blInitStop/ssInitStop) — those are separate systems.
