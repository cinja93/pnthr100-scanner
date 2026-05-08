// client/src/utils/dateUtils.js
// ── Shared date utilities ──────────────────────────────────────────────────────
//
// Single source of truth for inclusive "since signal" counters:
//   computeWeeksAgo(signalDate, lastBarDate?)         — weekly counter
//   computeTradingDaysAgo(signalDate, lastBarDate?)   — daily counter
//
// Both counters are anchored to a REFERENCE DATE that defaults to today's
// calendar date. When a lastBarDate is provided (e.g. from the AI Universe
// signals payload), the counter anchors to that bar instead. This is the
// correct anchor whenever the bar database is older than the calendar (e.g.
// during the trading day before the 5:30pm cron appends today's bar): the
// chart shows the signal on the latest available bar, so the counter must
// agree with the chart and read +1 — not +2 because the calendar has rolled.
//
// Backwards-compatible: any caller that omits lastBarDate keeps the old
// "anchor to today" behavior. 679 callers are unaffected.
// ─────────────────────────────────────────────────────────────────────────────

// Parse a YYYY-MM-DD date string into a local-noon Date (avoids TZ rollover).
function parseISODate(s) {
  if (!s) return null;
  const d = new Date(s + 'T12:00:00');
  return isNaN(d.getTime()) ? null : d;
}

// Compute the Date for the Monday of the week containing `d`.
function mondayOf(d) {
  const dow = d.getDay();                 // 0=Sun..6=Sat
  const daysToMonday = dow === 0 ? -6 : 1 - dow;
  const m = new Date(d);
  m.setDate(d.getDate() + daysToMonday);
  m.setHours(0, 0, 0, 0);
  return m;
}

// Compute inclusive weeks between two signal dates.
// Signal week = week 1 (so a signal fired in the reference week returns 1, not 0).
// `lastBarDate` (optional, YYYY-MM-DD) anchors the count to that bar; when omitted
// the count anchors to today's calendar date.
// Returns null if no signalDate.
export function computeWeeksAgo(signalDate, lastBarDate = null) {
  if (!signalDate) return null;
  const sigMonday = mondayOf(parseISODate(signalDate) || new Date());

  const refDate = parseISODate(lastBarDate) || new Date();
  const refMonday = mondayOf(refDate);

  const diffDays = Math.round((refMonday - sigMonday) / (1000 * 60 * 60 * 24));
  return Math.floor(diffDays / 7) + 1; // inclusive: signal week = week 1
}

// Compute inclusive TRADING days between signal and reference.
// Signal day = day 1 (so a signal fired on the reference date returns 1, not 0).
// Excludes weekends (Sat/Sun); does not currently exclude US market holidays.
// `lastBarDate` (optional, YYYY-MM-DD) anchors the count to that bar; when omitted
// the count anchors to today's calendar date. The latter causes a one-day drift
// during the trading day (chart shows signal on yesterday's bar = "+1" visually,
// but calendar today is +2) — pass lastBarDate to keep the counter on the bar.
export function computeTradingDaysAgo(signalDate, lastBarDate = null) {
  if (!signalDate) return null;
  const sig = parseISODate(signalDate);
  if (!sig) return null;
  sig.setHours(0, 0, 0, 0);

  const ref = parseISODate(lastBarDate) || new Date();
  ref.setHours(0, 0, 0, 0);

  if (sig >= ref) return 1;  // signal on (or after) the reference bar = day 1
  let count = 0;
  const cur = new Date(sig);
  while (cur < ref) {
    cur.setDate(cur.getDate() + 1);
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count + 1; // signal day = day 1
}
