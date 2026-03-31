// client/src/utils/dateUtils.js
// ── Shared date utilities ──────────────────────────────────────────────────────
//
// Single source of truth for:
//   computeWeeksAgo(signalDate) — inclusive weeks since a signal date
//
// Previously duplicated across: App.jsx, ApexPage.jsx, PreyPage.jsx, StockTable.jsx.
// Any change to weeks-ago math now happens in exactly one place.
// ─────────────────────────────────────────────────────────────────────────────

// Compute inclusive weeks since a signal date (Monday of signal week) to current week's Monday.
// Returns null if no signalDate.
// Signal week = week 1 (so a signal fired this week returns 1, not 0).
export function computeWeeksAgo(signalDate) {
  if (!signalDate) return null;
  const signalMonday = new Date(signalDate + 'T12:00:00');
  const today = new Date();
  const dow = today.getDay(); // 0=Sun..6=Sat
  const daysToMonday = dow === 0 ? -6 : 1 - dow;
  const currentMonday = new Date(today);
  currentMonday.setDate(today.getDate() + daysToMonday);
  currentMonday.setHours(0, 0, 0, 0);
  const diffDays = Math.round((currentMonday - signalMonday) / (1000 * 60 * 60 * 24));
  return Math.floor(diffDays / 7) + 1; // inclusive: signal week = week 1
}
