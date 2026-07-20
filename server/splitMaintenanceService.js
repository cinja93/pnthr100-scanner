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
import { fetchHistorical, normalizeBar, aggregateToWeekly, lastCompleteTradingDate } from './aiUniverseDailyJob.js';
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

// Whole-day distance between two YYYY-MM-DD dates.
function daysApart(a, b) {
  return Math.round(Math.abs(new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000);
}

// True when `seamDate` lines up (within toleranceDays) with a real FMP-recorded
// split. This is the discriminator that lets a re-sync tell a genuine
// unadjusted split seam (FMP records the split → matches → stay excluded) apart
// from a real price crash / short-squeeze (FMP records NO split → no match →
// the series is legitimate, don't block on it). Exported for the unit test.
export function seamMatchesSplit(seamDate, splitDates, toleranceDays = 5) {
  for (const sd of splitDates) if (daysApart(seamDate, sd) <= toleranceDays) return true;
  return false;
}

// FMP's recorded split ex-dates for a ticker, as a Set of YYYY-MM-DD. An empty
// set means FMP knows of no split — so any large move in the price series is
// real market action, not an unadjusted split. Shared with the 679 re-sync.
export async function fmpSplitDates(t) {
  const res = await fetchFMP(`/historical-price-full/stock_split/${t}`).catch(() => null);
  const hist = Array.isArray(res?.historical) ? res.historical : [];
  return new Set(hist.map(h => h?.date).filter(Boolean));
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
  // Closed bars only (2026-07-06 audit): a re-sync running intraday must not swap in
  // today's partial bar — the daily appender's overlap repair can't touch a doc whose
  // toDate already reads today, so a partial bar here would sit until tomorrow.
  const today = lastCompleteTradingDate();

  const old = await db.collection(DAILY_COLL).findOne({ ticker: t });

  // Never fabricate an AI-collection doc for a non-AI ticker. 679-only names get
  // flagged here via flagSuspectSplit (divergence) by the Carnivore daily appender;
  // without this guard the swap below would upsert e.g. BKNG/CVNA into
  // pnthr_ai_bt_candles and pollute the AI universe. The 679 repair (runSplitMaintenance
  // → resyncCarnivoreSplit) handles those. Returns ready so it isn't a blocker.
  if (!old && !universeTickers().has(t)) return { ready: true, action: 'not-in-AI' };

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

  // (c) discontinuity seam guard. A >50% day-over-day move in the fresh series
  // usually means an UNADJUSTED split (FMP has not rescaled its history yet);
  // swapping that in would corrupt the candles, so we don't. BUT a real price
  // crash or short-squeeze is ALSO a >50% move, and that is legitimate data.
  // Discriminate by FMP's own split record: a genuine split seam matches an
  // FMP-recorded split date and still blocks; a real move (no FMP split) does
  // not, so it no longer keeps a name excluded forever. This is the PRIM case —
  // a real -50% news crash on 2026-05-06 that FMP records no split for, which
  // had kept PRIM data-flagged and out of the Value screen for 29 days.
  const freshAsc = [...freshDesc].reverse();
  let splitDates = null;          // lazy — only fetched if we actually hit a seam
  const realMoves = [];
  for (let i = 1; i < freshAsc.length; i++) {
    const move = freshAsc[i].close / freshAsc[i - 1].close - 1;
    if (Math.abs(move) <= 0.5) continue;
    const seamDate = freshAsc[i].date;
    if (splitDates === null) splitDates = await fmpSplitDates(t);
    if (seamMatchesSplit(seamDate, splitDates)) {
      return { ready: false, note: `fresh series has a ${(move * 100).toFixed(0)}% seam on ${seamDate} matching an FMP split — not swapping` };
    }
    realMoves.push(`${(move * 100).toFixed(0)}% ${seamDate}`);
    console.log(`[Splits] ${t}: ${(move * 100).toFixed(0)}% move on ${seamDate} has no FMP split — real price action, not a split seam`);
  }
  const seamNote = realMoves.length ? ` (real move ${realMoves.join(', ')}, no FMP split)` : '';

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
  return { ready: true, action: action + seamNote, bars: freshDesc.length };
}

// ── Orchestrator — wired into the 4:15pm cron + admin endpoint ──────────────
export async function runSplitMaintenance() {
  const db = await connectToDatabase();
  if (!db) return { ok: false, error: 'Mongo connect failed' };

  const cal = await refreshSplitCalendar(db);
  const today = etDateStr();
  const due = await db.collection(COLL).find({ status: 'pending', date: { $lte: today } }).toArray();

  // 679 / Carnivore re-sync lives in carnivoreDailyJob (dynamic import → no cycle).
  // A ticker can be in the AI collection, the 679 collection, or BOTH (e.g. KLAC).
  // We repair every collection it lives in and only mark the split 'resynced' once
  // ALL present collections are ready — so a name is never half-repaired.
  const { resyncCarnivoreSplit } = await import('./carnivoreDailyJob.js');
  const resynced = [], waiting = [];
  for (const split of due) {
    const t = split.ticker;
    let aiRes;
    try { aiRes = await resyncTicker(db, split); }
    catch (e) { aiRes = { ready: false, note: `AI error: ${e.message}` }; }

    let carnRes = null;
    const in679 = await db.collection('pnthr_bt_candles').findOne({ ticker: t }, { projection: { _id: 1 } });
    if (in679) {
      try { carnRes = await resyncCarnivoreSplit(db, t); }
      catch (e) { carnRes = { ready: false, note: `679 error: ${e.message}` }; }
    }

    const parts = [['AI', aiRes], ['679', carnRes]].filter(([, r]) => r);
    const allReady = parts.every(([, r]) => r.ready);
    const note = parts.map(([c, r]) => `${c}:${r.ready ? (r.action || `ok ${r.bars || ''}`).trim() : r.note}`).join(' | ');

    await db.collection(COLL).updateOne(
      { _id: split._id },
      allReady
        ? { $set: { status: 'resynced', resyncedAt: new Date(), note }, $inc: { attempts: 1 } }
        : { $set: { lastAttemptAt: new Date(), note }, $inc: { attempts: 1 } },
    );
    (allReady ? resynced : waiting).push(`${t}: ${note}`);
    console.log(`[Splits] ${t} ${split.date} → ${allReady ? 'RESYNCED' : 'still pending'} — ${note}`);
  }
  exclCache = null;   // re-read exclusions on next engine tick

  const upcoming = await db.collection(COLL).countDocuments({ status: 'pending', date: { $gt: today } });
  return { ok: true, calendar: cal, due: due.length, resynced, waiting, upcoming };
}
