// server/splitMaintenanceService.js
// ── Stock-split tracking + automatic candle re-sync ─────────────────────────
//
// Why this exists (KLAC 10:1, 2026-06-12): on split day the broker/live price
// moves to the new scale immediately, but FMP's stored history (and therefore
// our pnthr_ai_bt_candles) lags on the old scale. An engine reading stale
// candles would compute a 2-week-low stop ~10x ABOVE the market = instant
// liquidation. KLAC was handled by hand; this service automates that exact
// flow for every future split:
//
//   1. TRACK    — daily pull of FMP's split calendar (/stock_split_calendar),
//                 filtered to the AI universe, stored in pnthr_stock_splits.
//   2. EXCLUDE  — any universe ticker with a PENDING split (effective date
//                 reached, candles not yet re-synced) is excluded from the
//                 Tree engine (no entry / no stop management) via
//                 getSplitExclusions(). The Tree page shows it as MANUAL.
//   3. RE-SYNC  — each run probes FMP: once FMP publishes split-adjusted
//                 history, the full series is fetched, VALIDATED against the
//                 old one (constant rescale ratio + live-quote scale + no
//                 discontinuity seam), then swapped in atomically and weekly
//                 bars rebuilt. The split flips to 'resynced' and the ticker
//                 un-excludes itself. Until validation passes it stays
//                 excluded — fail safe, never fail open.
//
// Divergence safety net: the Tree engine + the daily candle appender also
// flag any ticker whose live/new price diverges hugely from its stored
// candles (flagSuspectSplit) — catches splits the calendar misses and bad
// data. Those records carry numerator/denominator = null; the re-sync
// validation then accepts ANY constant rescale ratio (including ~1.0, which
// is just a clean data refresh).
//
// Collection: pnthr_stock_splits
//   { ticker, date (YYYY-MM-DD effective), numerator, denominator, label,
//     source: 'calendar' | 'divergence', status: 'pending' | 'resynced',
//     detectedAt, attempts, lastAttemptAt, resyncedAt, note }
// ────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';
import { fetchFMP } from './stockService.js';
import { SECTORS } from './scripts/aiUniverse/aiUniverseData.js';
import { fetchHistorical, normalizeBar, aggregateToWeekly } from './aiUniverseDailyJob.js';
import { clearAiUniverseCache } from './aiUniverseService.js';
import { clearAiStockChartCache } from './aiUniverseStockChartService.js';

const COLL          = 'pnthr_stock_splits';
const DAILY_COLL    = 'pnthr_ai_bt_candles';
const WEEKLY_COLL   = 'pnthr_ai_bt_candles_weekly';
const HISTORY_START = '2022-11-30';   // same anchor as the AI universe backfill
const CAL_LOOKBACK_DAYS  = 14;        // catch splits we missed while down
const CAL_LOOKAHEAD_DAYS = 60;

function etDateStr(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
function isoShift(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function universeTickers() {
  const set = new Set();
  for (const sec of SECTORS) for (const h of sec.holdings) set.add(h.ticker);
  return set;
}

// ── 1. TRACK — pull FMP's split calendar, keep universe hits ────────────────
export async function refreshSplitCalendar(db) {
  const from = isoShift(-CAL_LOOKBACK_DAYS), to = isoShift(CAL_LOOKAHEAD_DAYS);
  const cal = await fetchFMP(`/stock_split_calendar?from=${from}&to=${to}`).catch(() => null);
  if (!Array.isArray(cal)) return { ok: false, error: 'FMP split calendar unavailable' };

  const universe = universeTickers();
  let upserts = 0;
  for (const s of cal) {
    const ticker = (s.symbol || '').toUpperCase();
    if (!universe.has(ticker) || !s.date) continue;
    // Keyed by ticker+date so re-runs never duplicate and never downgrade a
    // record that already re-synced.
    const r = await db.collection(COLL).updateOne(
      { ticker, date: s.date },
      {
        $set: { numerator: +s.numerator || null, denominator: +s.denominator || null, label: s.label || null, source: 'calendar' },
        $setOnInsert: { ticker, date: s.date, status: 'pending', detectedAt: new Date(), attempts: 0 },
      },
      { upsert: true },
    );
    if (r.upsertedCount) { upserts++; console.log(`[Splits] NEW universe split detected: ${ticker} ${s.numerator}:${s.denominator} effective ${s.date}`); }
  }
  return { ok: true, upserts, window: `${from} → ${to}` };
}

// ── 2. EXCLUDE — pending splits whose effective date has arrived ────────────
// Returns Map(ticker → reason). Cached 30s (the Tree engine reads this every
// tick + every page poll).
let exclCache = null, exclCacheAt = 0;
export async function getSplitExclusions(db) {
  if (exclCache && Date.now() - exclCacheAt < 30_000) return exclCache;
  const out = new Map();
  try {
    const today = etDateStr();
    const docs = await db.collection(COLL).find({ status: 'pending', date: { $lte: today } }).toArray();
    for (const d of docs) {
      const ratio = d.numerator && d.denominator ? `${d.numerator}:${d.denominator}` : 'data mismatch';
      out.set(d.ticker, `split ${ratio} on ${d.date} — candle re-sync pending`);
    }
  } catch (e) { console.error('[Splits] exclusion read failed:', e.message); }
  exclCache = out; exclCacheAt = Date.now();
  return out;
}

// Safety net: callers (Tree engine, daily appender) flag a ticker whose live
// price diverges hugely from stored candles. Recorded as a pending
// 'divergence' split so the nightly re-sync repairs it. Idempotent per day.
export async function flagSuspectSplit(db, ticker, note) {
  const today = etDateStr();
  try {
    const r = await db.collection(COLL).updateOne(
      { ticker, status: 'pending' },
      { $setOnInsert: { ticker, date: today, numerator: null, denominator: null, label: null, source: 'divergence', status: 'pending', detectedAt: new Date(), attempts: 0 }, $set: { note } },
      { upsert: true },
    );
    if (r.upsertedCount) console.log(`[Splits] SUSPECT flagged: ${ticker} — ${note}`);
    exclCache = null;   // exclusion takes effect on the next read
  } catch (e) { console.error('[Splits] flagSuspectSplit failed:', e.message); }
}

// ── 3. RE-SYNC — once FMP publishes adjusted history, validate + swap ───────
// Decision tree (fail safe — any doubt means stay excluded and retry next run):
//   a. Full FMP history + live quote must agree on scale (else FMP's history
//      isn't adjusted yet → wait).
//   b. Overlap ratio old/fresh must be CONSTANT across sampled dates (a clean
//      rescale, not partial adjustment). ~1.0 → store already adjusted, just
//      mark resynced. Anything else → swap the series in atomically.
//   c. Fresh series must have no discontinuity seam (largest day-over-day
//      close move < 50%) and roughly the old bar count.
async function resyncTicker(db, split) {
  const t = split.ticker;
  const today = etDateStr();

  const old = await db.collection(DAILY_COLL).findOne({ ticker: t });

  // Preserve the stored series' depth: parts of the universe were extended
  // back past the standard 2022-11-30 anchor (most go to 2022-01-03). A
  // re-sync that re-pulled from the anchor would silently truncate that
  // history and knock the ticker out of the backtest's early months (this
  // exact mistake cost KLAC its first year on 2026-06-12).
  const fetchFrom = (old?.fromDate && old.fromDate < HISTORY_START) ? old.fromDate : HISTORY_START;
  const fresh = (await fetchHistorical(t, fetchFrom, today))
    .map(normalizeBar)
    .filter(b => b.date && b.close > 0 && b.high >= b.low && b.high > 0);
  if (fresh.length === 0) return { ready: false, note: 'no FMP history yet' };
  const freshDesc = [...fresh].sort((a, b) => b.date.localeCompare(a.date));
  const freshByDate = new Map(freshDesc.map(b => [b.date, b]));
  const freshLast = freshDesc[0].close;

  // (a) live-quote scale check — distinguishes "FMP not adjusted yet" (history
  // still pre-split while the quote is post-split) from "adjusted".
  const q = await fetchFMP(`/quote/${t}`).catch(() => null);
  const live = Array.isArray(q) ? +q[0]?.price : 0;
  if (live > 0 && (live < freshLast * 0.5 || live > freshLast * 2.0)) {
    return { ready: false, note: `FMP history not adjusted yet (live $${live} vs last bar $${freshLast})` };
  }

  let action = 'swapped';
  if (old?.daily?.length) {
    // (c) FMP shouldn't lose history in an adjustment
    if (fresh.length < old.daily.length * 0.9) {
      return { ready: false, note: `FMP history incomplete (${fresh.length} vs ${old.daily.length} stored bars)` };
    }
    // (b) constant-rescale check over sampled overlap dates before the split
    const oldAsc = [...old.daily].sort((a, b) => a.date.localeCompare(b.date)).filter(b => b.date < split.date && b.close > 0);
    const ratios = [];
    const step = Math.max(1, Math.floor(oldAsc.length / 12));
    for (let i = 0; i < oldAsc.length && ratios.length < 12; i += step) {
      const f = freshByDate.get(oldAsc[i].date);
      if (f?.close > 0) ratios.push(oldAsc[i].close / f.close);
    }
    if (ratios.length < 3) return { ready: false, note: 'too few overlap dates to validate' };
    const lo = Math.min(...ratios), hi = Math.max(...ratios);
    if (hi / lo > 1.03) return { ready: false, note: `overlap ratio not constant (${lo.toFixed(3)}–${hi.toFixed(3)}) — partial adjustment, waiting` };
    const ratio = ratios.sort((a, b) => a - b)[Math.floor(ratios.length / 2)];
    if (Math.abs(ratio - 1) < 0.02) action = 'already-adjusted';   // store matches FMP — nothing to swap
    else if (split.numerator && split.denominator) {
      const expected = split.numerator / split.denominator;
      if (Math.abs(ratio / expected - 1) > 0.05) console.warn(`[Splits] ${t}: observed rescale ${ratio.toFixed(3)} != calendar ${expected} — proceeding (constant + quote-scale checks passed)`);
    }
  }

  // (c) no discontinuity seam in the fresh series
  const freshAsc = [...freshDesc].reverse();
  for (let i = 1; i < freshAsc.length; i++) {
    const move = Math.abs(freshAsc[i].close / freshAsc[i - 1].close - 1);
    if (move > 0.5) return { ready: false, note: `fresh series has a ${(move * 100).toFixed(0)}% seam on ${freshAsc[i].date} — not swapping` };
  }

  if (action === 'swapped') {
    await db.collection(DAILY_COLL).updateOne(
      { ticker: t },
      { $set: { ticker: t, daily: freshDesc, barCount: freshDesc.length, fromDate: freshAsc[0].date, toDate: freshAsc[freshAsc.length - 1].date, lastDailyUpdateAt: new Date(), splitResyncedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
    const weekly = aggregateToWeekly(freshAsc);
    await db.collection(WEEKLY_COLL).updateOne(
      { ticker: t },
      { $set: { ticker: t, weekly, barCount: weekly.length, fromWeek: weekly[0]?.weekOf || null, toWeek: weekly[weekly.length - 1]?.weekOf || null, builtAt: new Date(), sourceDailyBars: freshAsc.length } },
      { upsert: true },
    );
    clearAiUniverseCache();
    clearAiStockChartCache(t);
  }
  return { ready: true, action, bars: freshDesc.length };
}

// ── Orchestrator — wired into the 4:15pm cron + admin endpoint ──────────────
export async function runSplitMaintenance() {
  const db = await connectToDatabase();
  if (!db) return { ok: false, error: 'Mongo connect failed' };

  const cal = await refreshSplitCalendar(db);
  const today = etDateStr();
  const due = await db.collection(COLL).find({ status: 'pending', date: { $lte: today } }).toArray();

  const resynced = [], waiting = [];
  for (const split of due) {
    let res;
    try { res = await resyncTicker(db, split); }
    catch (e) { res = { ready: false, note: `error: ${e.message}` }; }
    await db.collection(COLL).updateOne(
      { _id: split._id },
      res.ready
        ? { $set: { status: 'resynced', resyncedAt: new Date(), note: `${res.action} (${res.bars} bars)` }, $inc: { attempts: 1 } }
        : { $set: { lastAttemptAt: new Date(), note: res.note }, $inc: { attempts: 1 } },
    );
    (res.ready ? resynced : waiting).push(`${split.ticker}: ${res.ready ? res.action : res.note}`);
    console.log(`[Splits] ${split.ticker} ${split.date} → ${res.ready ? `RESYNCED (${res.action})` : `still pending — ${res.note}`}`);
  }
  exclCache = null;   // re-read exclusions on next engine tick

  const upcoming = await db.collection(COLL).countDocuments({ status: 'pending', date: { $gt: today } });
  return { ok: true, calendar: cal, due: due.length, resynced, waiting, upcoming };
}
