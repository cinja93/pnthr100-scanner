// server/opEma.js
// ── The OpEMA line — ONE definition, shared by every surface that shows it ───
//
// "OpEMA" is the sector-optimized EMA (SECTOR_EMA_PERIODS, 18-26W), never a flat
// 21 EMA. This module owns the single implementation of "where does this name sit
// relative to its OpEMA line", so Daily Rank, Value, and anything added later
// cannot drift apart from each other or from the Jungle's BL/SS.
//
// The line is computed on the DEVELOPING (current, still-forming) week with its
// close set to the live price, so it matches the stock chart rather than lagging
// a week behind on the last closed bar.
//
// Extracted verbatim from aiValueService.js, whose behaviour was verified 120/121
// against the Jungle. Equivalence with that original is asserted in
// opEma.test.mjs over randomized inputs — change this file only with that test.
// ────────────────────────────────────────────────────────────────────────────

import { SECTOR_EMA_PERIODS } from './data/pnthrAiSectorsConfig.js';
import { calculateEMA } from './signalDetection.js';

// ── ET-aware week math ──────────────────────────────────────────────────────
export function etParts(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false, weekday: 'short',
  });
  const p = {};
  for (const part of fmt.formatToParts(now)) p[part.type] = part.value;
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { dateStr: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour, 10) % 24, dow };
}

export function isoAddDays(iso, days) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

// Monday of the current (developing) ET week.
export function developingWeekMonday() {
  const { dateStr, dow } = etParts();
  return isoAddDays(dateStr, -((dow + 6) % 7));
}

// ── The engine's young-name fallback ────────────────────────────────────────
// Mirrors aiUniverseSignalsService.effectivePeriod. Returns null when a name is
// too young to carry any EMA at all.
export function effectivePeriod(barCount, sectorPeriod) {
  if (barCount >= sectorPeriod * 3) return sectorPeriod;
  if (barCount >= 21 + 2)           return 21;
  return null;
}

// ── Weekly closes for a set of tickers, ascending, through a cutoff week ────
// Pass devMonday as the cutoff to INCLUDE the developing week.
export async function loadWeeklyCloses(db, tickers, throughWeek) {
  const docs = await db.collection('pnthr_ai_bt_candles_weekly').aggregate([
    { $match: { ticker: { $in: tickers } } },
    { $project: { ticker: 1,
        bars: { $map: { input: '$weekly', as: 'b', in: { d: '$$b.weekOf', c: '$$b.close' } } } } },
  ]).toArray();
  const out = {};
  for (const doc of docs) {
    out[doc.ticker] = (doc.bars || [])
      .filter(b => b && b.d && b.d <= throughWeek && Number.isFinite(b.c) && b.c > 0)
      .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  }
  return out;
}

// ── Weekly close series with the developing week marked to the live price ───
// weeklyCloses: [{ d, c }] ascending (as returned by loadWeeklyCloses).
// Returns [{ w, c }] ascending.
export function buildDevelopingSeries(weeklyCloses, devMonday, livePrice) {
  const s = (weeklyCloses || []).map(b => ({ w: b.d, c: b.c }));
  if (livePrice != null && s.length) {
    if (s[s.length - 1].w === devMonday) s[s.length - 1] = { w: devMonday, c: livePrice };
    else if (s[s.length - 1].w < devMonday) s.push({ w: devMonday, c: livePrice });
  }
  return s;
}

// ── Where the name sits vs its OpEMA line ───────────────────────────────────
// Returns:
//   aligned     [{ w, c, e, below }] — every week that carries an EMA value.
//                 Callers needing week-counting (weeks below the line, run
//                 length above it) work off this.
//   opema       the line's current value, 2dp
//   opemaPeriod the period actually used (sector period, or 21 for young names)
//   light       % the close sits above (+) or below (-) the line, 1dp
//   side        'above' | 'below'
//   weekOf      the week the reading is for
// All null when the name is too young for a line.
export function computeOpEma(wSeries, sectorId) {
  const out = { aligned: [], opema: null, opemaPeriod: null, light: null, side: null, weekOf: null };
  const period = SECTOR_EMA_PERIODS[sectorId] || 30;
  const eff = effectivePeriod(wSeries.length, period);
  if (!eff) return out;

  const emaData = calculateEMA(wSeries.map(b => ({ time: b.w, close: b.c })), eff);   // ENGINE function
  const emaByWeek = Object.fromEntries(emaData.map(e => [e.time, e.value]));
  const aligned = wSeries
    .filter(b => emaByWeek[b.w] != null)
    .map(b => ({ w: b.w, c: b.c, e: emaByWeek[b.w], below: b.c < emaByWeek[b.w] }));
  if (!aligned.length) return out;

  const lastA = aligned[aligned.length - 1];
  out.aligned     = aligned;
  out.opema       = Math.round(lastA.e * 100) / 100;
  out.opemaPeriod = eff;
  out.weekOf      = lastA.w;
  out.light       = Math.round(((lastA.c / lastA.e) - 1) * 1000) / 10;
  out.side        = lastA.below ? 'below' : 'above';
  return out;
}
