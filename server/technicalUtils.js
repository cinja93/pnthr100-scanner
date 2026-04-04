// server/technicalUtils.js
// ── Shared technical indicator utilities ──────────────────────────────────────
//
// Single source of truth for:
//   getLastFriday()              — canonical "last Friday" date string
//   aggregateWeeklyBars()        — group FMP daily bars into weekly bars
//   computeEMAseries()           — full EMA series for any period (parameterized)
//   computeEMA21series()         — backward-compat wrapper → computeEMAseries(bars, 21)
//   computeEMAFromDailyBars()    — single EMA value from raw daily bars (parameterized)
//   computeEMA21fromDailyBars()  — backward-compat wrapper → computeEMAFromDailyBars(daily, 21)
//
// Per-sector EMA periods are defined in sectorEmaConfig.js.
// ─────────────────────────────────────────────────────────────────────────────

import { DEFAULT_EMA_PERIOD } from './sectorEmaConfig.js';

// ── getLastFriday ─────────────────────────────────────────────────────────────
// Returns the most recent Friday as 'YYYY-MM-DD'.
// If today is Friday, returns today. Otherwise walks back to the prior Friday.
export function getLastFriday() {
  const today = new Date();
  const dow = today.getDay(); // 0=Sun … 6=Sat
  const daysBack = dow === 5 ? 0 : (dow + 2) % 7;
  const d = new Date(today);
  d.setDate(today.getDate() - daysBack);
  return d.toISOString().split('T')[0];
}

// ── aggregateWeeklyBars ───────────────────────────────────────────────────────
// Groups FMP daily bars (descending date order) into weekly bars keyed by Monday.
//
// Options:
//   includeVolume (bool, default false) — accumulate volume per week.
//     Set to true when computing OBV or volume-based indicators.
//
// Returns bars sorted ascending (oldest first), each with:
//   { weekStart, open, high, low, close [, volume] }
export function aggregateWeeklyBars(daily, { includeVolume = false } = {}) {
  const weekMap = {};
  for (const bar of daily) {
    const date = new Date(bar.date + 'T12:00:00');
    const dow  = date.getDay();
    const daysToMonday = dow === 0 ? -6 : 1 - dow;
    const monday = new Date(date);
    monday.setDate(date.getDate() + daysToMonday);
    const key = monday.toISOString().split('T')[0];

    if (!weekMap[key]) {
      weekMap[key] = {
        weekStart: key,
        open:      null,
        high:      -Infinity,
        low:       Infinity,
        close:     null,
        ...(includeVolume ? { volume: 0 } : {}),
      };
    }
    const w = weekMap[key];
    w.high = Math.max(w.high, bar.high);
    w.low  = Math.min(w.low,  bar.low);
    if (w.close === null) w.close = bar.close; // first-seen = Friday close (bars are descending)
    w.open = bar.open;                          // last-seen  = Monday open  (bars are descending)
    if (includeVolume) w.volume += (bar.volume || 0);
  }
  return Object.values(weekMap).sort((a, b) => a.weekStart > b.weekStart ? 1 : -1);
}

// ── computeEMAseries ─────────────────────────────────────────────────────────
// Computes a full EMA series for any period from weekly bars.
// Returns an array the same length as weeklyBars; values are null until the
// period-th bar (index period-1).
// Used by apexService, preyService, and anywhere per-bar EMA access is needed.
export function computeEMAseries(weeklyBars, period = DEFAULT_EMA_PERIOD) {
  const closes = weeklyBars.map(b => b.close);
  const n      = closes.length;
  const ema    = new Array(n).fill(null);
  if (n < period) return ema;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  ema[period - 1] = sum / period;

  const k = 2 / (period + 1);
  for (let i = period; i < n; i++) {
    ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

// Backward-compatible wrapper — existing callers that import computeEMA21series
// continue to work without changes.
export function computeEMA21series(weeklyBars) {
  return computeEMAseries(weeklyBars, 21);
}

// ── computeEMAFromDailyBars ──────────────────────────────────────────────────
// Groups raw FMP daily bars into weekly closes (Sunday-epoch key), then computes
// EMA for the specified period on those weekly closes.
//
// Returns { current, previous, period } — the last two EMA values + the period
// used — or null if insufficient data.
//
// Used by commandCenter (regime/ticker EMA) and the /api/sector-ema route.
// The Sunday-epoch grouping ensures a stable weekly key regardless of the last
// trading day of each week.
export function computeEMAFromDailyBars(daily, period = DEFAULT_EMA_PERIOD) {
  if (!Array.isArray(daily) || daily.length < 110) return null;

  // Group into weeks — last bar of each week wins (ascending iteration via reverse)
  const weekMap = {};
  for (const bar of [...daily].reverse()) {
    const d  = new Date(bar.date);
    const ms = d.getTime() - d.getDay() * 86400000; // shift to Sunday epoch
    weekMap[ms] = bar.close;
  }

  const closes = Object.keys(weekMap)
    .sort((a, b) => +a - +b)
    .map(k => weekMap[k]);

  if (closes.length < period + 1) return null;

  let ema  = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  let prev = ema;
  const k  = 2 / (period + 1);

  for (let i = period; i < closes.length; i++) {
    prev = ema;
    ema  = closes[i] * k + ema * (1 - k);
  }

  return { current: +ema.toFixed(2), previous: +prev.toFixed(2), period };
}

// Backward-compatible wrapper
export function computeEMA21fromDailyBars(daily) {
  return computeEMAFromDailyBars(daily, 21);
}
