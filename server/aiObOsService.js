// server/aiObOsService.js
// ── PNTHR OB/OS — Overbought / Oversold tracker for the AI Elite 300 ─────────
//
// Tracks AI-300 names coming OUT of overbought (RSI > 70) and oversold
// (RSI < 30) conditions, on both DAILY and WEEKLY closed bars. Four buckets,
// mutually exclusive at any snapshot, with the episode peak/trough carried
// through the roll from one bucket to the next:
//
//   rollingOver (OB-1) — RSI still > 70, pulled back >= TURN pts off the
//                        episode peak.            e.g. 78 -> 74
//   brokeDown   (OB-2) — RSI crossed down through 70 (rolled out of OB-1).
//                        Shown for CROSS_WINDOW closed bars.  e.g. 78 -> 69
//   turningUp   (OS-1) — RSI still < 30, risen >= TURN pts off the episode
//                        trough.                  e.g. 22 -> 26
//   brokeOut    (OS-2) — RSI crossed up through 30 (rolled out of OS-1).
//                        Shown for CROSS_WINDOW closed bars.  e.g. 22 -> 31
//
// Data source: pnthr_ai_bt_candles (daily) + pnthr_ai_bt_candles_weekly
// (weekly). Both store CLOSED end-of-day bars — except the weekly collection
// re-aggregates the developing week daily, so the current (partial) week is
// excluded here. A defensive same-day daily guard also drops any partial
// today bar that a manual backfill could leave behind (see ET cutoffs below).
//
// RSI is the canonical Wilder RSI-14 (server/lib/rsi.js) — the same definition
// the rest of the Den uses, so this page can never disagree with it.
//
// Fully deterministic and order-independent: candles are sorted ascending by
// date before RSI is computed, so the result does not depend on Mongo's stored
// array order.
// ────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';
import { SECTORS, FUND_META } from './scripts/aiUniverse/aiUniverseData.js';
import { computeWilderRSI } from './lib/rsi.js';

// ── Tunables (locked per spec 2026-06-30) ───────────────────────────────────
const RSI_PERIOD     = 14;     // Wilder RSI-14
const OB_LINE        = 70;     // overbought threshold
const OS_LINE        = 30;     // oversold threshold
const TURN           = 2;      // points off peak/trough to confirm the turn
const CROSS_WINDOW_D = 5;      // daily: keep a "broke the line" name listed for N closed bars
const CROSS_WINDOW_W = 3;      // weekly: same, in closed weeks
const MIN_BARS       = RSI_PERIOD + 1;  // minimum closes needed to compute RSI

const CACHE_MS = 5 * 60 * 1000;   // 5-minute cache (data only changes post-close)
let _cache = null;                // { data, ts }

// ── Ticker → sector lookup (built once) ─────────────────────────────────────
const TICKER_META = {};
const ALL_TICKERS = [];
for (const sec of SECTORS) {
  for (const h of sec.holdings) {
    if (TICKER_META[h.ticker]) continue;       // first listing wins (no dupes)
    TICKER_META[h.ticker] = { sectorId: sec.id, sectorName: sec.name, name: h.name };
    ALL_TICKERS.push(h.ticker);
  }
}

// ── ET-aware closed-bar cutoffs ─────────────────────────────────────────────
// "Closed bars only" means: never use a bar whose session/week has not finished.
function etParts(now = new Date()) {
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

function isoAddDays(iso, days) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

// Returns { dailyCutoff, weeklyCutoff } — inclusive YYYY-MM-DD strings.
// Daily: include today's bar only after the 16:00 ET close (else it could be a
//        partial bar from a backfill). Markets are closed on weekends, so the
//        latest real bar is Friday < today and is always included.
// Weekly: include a week only once it has fully closed (Fri 16:00 ET). The
//         developing week's weekOf is therefore excluded until the week ends.
function closedBarCutoffs(now = new Date()) {
  const { dateStr, hour, dow } = etParts(now);
  const dailyCutoff = hour >= 16 ? dateStr : isoAddDays(dateStr, -1);

  // Monday of the current ET week
  const thisMonday = isoAddDays(dateStr, -((dow + 6) % 7));
  // Has the current week's Friday close passed?
  const currentWeekClosed = (dow === 6) || (dow === 0) || (dow === 5 && hour >= 16);
  const weeklyCutoff = currentWeekClosed ? thisMonday : isoAddDays(thisMonday, -7);

  return { dailyCutoff, weeklyCutoff };
}

// ── Classification state machine ────────────────────────────────────────────
// Walks an ascending RSI series and reports the bucket of the LATEST bar, with
// the episode peak/trough carried through OB_ACTIVE → OB_COOLING (and the
// oversold mirror). Returns { bucket, from, to } or null.
export function classifyObOs(rsi, opts = {}) {
  const ob   = opts.ob   ?? OB_LINE;
  const os   = opts.os   ?? OS_LINE;
  const turn = opts.turn ?? TURN;
  const win  = opts.crossWindow ?? CROSS_WINDOW_D;

  const vals = rsi.filter(v => v != null);
  const n = vals.length;
  if (n < 2) return null;

  let state = 'NEUTRAL';
  let peak = null, trough = null, coolBars = 0;

  for (let i = 0; i < n; i++) {
    const r = vals[i];
    switch (state) {
      case 'NEUTRAL':
        if (r > ob)      { state = 'OB_ACTIVE'; peak = r; }
        else if (r < os) { state = 'OS_ACTIVE'; trough = r; }
        break;
      case 'OB_ACTIVE':
        if (r > ob)      { if (r > peak) peak = r; }
        else             { state = 'OB_COOLING'; coolBars = 1; }   // crossed below 70 this bar
        break;
      case 'OB_COOLING':
        if (r > ob)      { state = 'OB_ACTIVE'; if (r > peak) peak = r; coolBars = 0; }
        else if (r < os) { state = 'OS_ACTIVE'; trough = r; coolBars = 0; }
        else { coolBars++; if (coolBars > win) { state = 'NEUTRAL'; peak = null; coolBars = 0; } }
        break;
      case 'OS_ACTIVE':
        if (r < os)      { if (r < trough) trough = r; }
        else             { state = 'OS_WARMING'; coolBars = 1; }   // crossed above 30 this bar
        break;
      case 'OS_WARMING':
        if (r < os)      { state = 'OS_ACTIVE'; if (r < trough) trough = r; coolBars = 0; }
        else if (r > ob) { state = 'OB_ACTIVE'; peak = r; coolBars = 0; }
        else { coolBars++; if (coolBars > win) { state = 'NEUTRAL'; trough = null; coolBars = 0; } }
        break;
    }
  }

  const cur = vals[n - 1];
  if (state === 'OB_ACTIVE')  return (peak != null && cur <= peak - turn)   ? { bucket: 'rollingOver', from: peak,   to: cur } : null;
  if (state === 'OB_COOLING') return { bucket: 'brokeDown', from: peak,   to: cur };
  if (state === 'OS_ACTIVE')  return (trough != null && cur >= trough + turn) ? { bucket: 'turningUp',  from: trough, to: cur } : null;
  if (state === 'OS_WARMING') return { bucket: 'brokeOut',  from: trough, to: cur };
  return null;
}

const r1 = v => Math.round(v * 10) / 10;   // 1-decimal RSI for display/truthfulness

// Build the four buckets for one timeframe from a map of ticker → ascending
// { closes, lastClose, asOf }.
function buildBuckets(seriesByTicker, crossWindow) {
  const out = { rollingOver: [], brokeDown: [], turningUp: [], brokeOut: [] };
  for (const ticker of Object.keys(seriesByTicker)) {
    const s = seriesByTicker[ticker];
    if (!s || s.closes.length < MIN_BARS) continue;
    const rsi = computeWilderRSI(s.closes, RSI_PERIOD);
    const hit = classifyObOs(rsi, { crossWindow });
    if (!hit) continue;
    const meta = TICKER_META[ticker] || {};
    out[hit.bucket].push({
      ticker,
      name:       meta.name || ticker,
      sectorId:   meta.sectorId ?? null,
      sectorName: meta.sectorName || null,
      from:       r1(hit.from),
      to:         r1(hit.to),
      price:      s.lastClose,
      asOf:       s.asOf,
    });
  }
  // Sort: overbought by peak desc (most extreme first); oversold by trough asc.
  out.rollingOver.sort((a, b) => b.from - a.from);
  out.brokeDown.sort((a, b) => b.from - a.from);
  out.turningUp.sort((a, b) => a.from - b.from);
  out.brokeOut.sort((a, b) => a.from - b.from);
  return out;
}

// Pull candles for all tickers in one aggregation per collection. We strip each
// bar to { d, c } in Mongo to keep the payload small, then sort ascending in JS
// and apply the closed-bar cutoff. dateField is 'date' (daily) or 'weekOf'
// (weekly); arrayField is 'daily' or 'weekly'.
async function loadSeries(db, collection, arrayField, dateField, cutoff) {
  const docs = await db.collection(collection).aggregate([
    { $match: { ticker: { $in: ALL_TICKERS } } },
    { $project: {
        ticker: 1,
        bars: { $map: { input: `$${arrayField}`, as: 'b', in: { d: `$$b.${dateField}`, c: `$$b.close` } } },
    } },
  ]).toArray();

  const byTicker = {};
  for (const doc of docs) {
    const bars = (doc.bars || [])
      .filter(b => b && b.d && b.d <= cutoff && Number.isFinite(b.c) && b.c > 0)
      .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));   // ascending — order-independent
    if (bars.length < MIN_BARS) continue;
    byTicker[doc.ticker] = {
      closes:    bars.map(b => b.c),
      lastClose: bars[bars.length - 1].c,
      asOf:      bars[bars.length - 1].d,
    };
  }
  return byTicker;
}

export function clearAiObOsCache() { _cache = null; }

export async function getAiObOs(forceRefresh = false) {
  if (!forceRefresh && _cache && (Date.now() - _cache.ts) < CACHE_MS) return _cache.data;

  const db = await connectToDatabase();
  if (!db) return { ok: false, error: 'Mongo connect failed' };

  const { dailyCutoff, weeklyCutoff } = closedBarCutoffs();

  const [dailySeries, weeklySeries] = await Promise.all([
    loadSeries(db, 'pnthr_ai_bt_candles',        'daily',  'date',   dailyCutoff),
    loadSeries(db, 'pnthr_ai_bt_candles_weekly',  'weekly', 'weekOf', weeklyCutoff),
  ]);

  const daily  = buildBuckets(dailySeries,  CROSS_WINDOW_D);
  const weekly = buildBuckets(weeklySeries, CROSS_WINDOW_W);

  // as-of = the latest closed bar date actually used (max across names)
  const maxAsOf = obj => Object.values(obj).reduce((m, s) => (s.asOf > m ? s.asOf : m), '');

  const data = {
    ok: true,
    generatedAt: new Date().toISOString(),
    params: { period: RSI_PERIOD, obLine: OB_LINE, osLine: OS_LINE, turn: TURN,
              crossWindowDaily: CROSS_WINDOW_D, crossWindowWeekly: CROSS_WINDOW_W },
    universe: { version: FUND_META?.version || null, count: ALL_TICKERS.length },
    daily:  { asOf: maxAsOf(dailySeries),  ...daily },
    weekly: { asOf: maxAsOf(weeklySeries), ...weekly },
  };

  _cache = { data, ts: Date.now() };
  return data;
}
