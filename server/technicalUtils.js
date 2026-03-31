// server/technicalUtils.js
// ── Shared technical indicator utilities ──────────────────────────────────────
//
// Single source of truth for:
//   getLastFriday()              — canonical "last Friday" date string
//   aggregateWeeklyBars()        — group FMP daily bars into weekly bars
//   computeEMA21series()         — full EMA-21 series array for weekly bars
//   computeEMA21fromDailyBars()  — single EMA-21 value from raw FMP daily bars
//
// Previously duplicated across: apexService, signalService, fridayPipeline,
// preyService, commandCenter, and index.js. Any change to EMA math now happens
// in exactly one place.
// ─────────────────────────────────────────────────────────────────────────────

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

// ── computeEMA21series ────────────────────────────────────────────────────────
// Computes the full EMA-21 series from weekly bars.
// Returns an array the same length as weeklyBars; values are null until week 21.
// Used by apexService where per-bar EMA access is needed (e.g. bell-curve scoring).
export function computeEMA21series(weeklyBars) {
  const closes = weeklyBars.map(b => b.close);
  const n      = closes.length;
  const ema    = new Array(n).fill(null);
  if (n < 21) return ema;

  let sum = 0;
  for (let i = 0; i < 21; i++) sum += closes[i];
  ema[20] = sum / 21;

  const k = 2 / 22;
  for (let i = 21; i < n; i++) {
    ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

// ── computeEMA21fromDailyBars ─────────────────────────────────────────────────
// Groups raw FMP daily bars into weekly closes (Sunday-epoch key), then computes
// EMA-21 on those weekly closes.
//
// Returns { current, previous } — the last two EMA values — or null if there is
// insufficient data (< 110 daily bars or < 22 weekly bars).
//
// Used by commandCenter (regime/ticker EMA) and the /api/sector-ema route.
// The Sunday-epoch grouping ensures a stable weekly key regardless of the last
// trading day of each week.
export function computeEMA21fromDailyBars(daily) {
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

  if (closes.length < 22) return null;

  let ema  = closes.slice(0, 21).reduce((s, v) => s + v, 0) / 21;
  let prev = ema;
  const k  = 2 / 22;

  for (let i = 21; i < closes.length; i++) {
    prev = ema;
    ema  = closes[i] * k + ema * (1 - k);
  }

  return { current: +ema.toFixed(2), previous: +prev.toFixed(2) };
}
