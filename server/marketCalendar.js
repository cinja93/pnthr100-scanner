// server/marketCalendar.js
// ── NYSE holiday calendar (2026-07-06 audit) ────────────────────────────────
// The system had NO holiday awareness: everything on a `* * 1-5` schedule ran on
// July 4th, Thanksgiving, Good Friday, etc. Mostly harmless (FMP returns no new
// bar so the candle appenders no-op), but the LIVE Tree tick could still fire a
// spurious order on a holiday if FMP's quote dayHigh disagreed by pennies with the
// stored candle high — and the Friday weeklies (Perch, Kill pipeline, archive)
// generated off Thursday data on a Good Friday.
//
// A static full-holiday list (markets fully closed — no half-days here; half-days
// still trade so they are intentionally NOT excluded). Update annually.

const NYSE_HOLIDAYS = new Set([
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
  // 2028
  '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19',
  '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-25',
]);

// Current date in America/New_York as YYYY-MM-DD.
export function etDateString(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// Is the given date (or today, ET) a full NYSE holiday? Weekends are also non-trading.
export function isMarketHoliday(dateStr) {
  const d = dateStr || etDateString();
  return NYSE_HOLIDAYS.has(d);
}

export function isWeekend(dateStr) {
  const d = dateStr || etDateString();
  const dow = new Date(d + 'T12:00:00Z').getUTCDay();
  return dow === 0 || dow === 6;
}

// True when the US equity market is OPEN for a full or half session today (ET).
export function isTradingDay(dateStr) {
  const d = dateStr || etDateString();
  return !isWeekend(d) && !isMarketHoliday(d);
}
