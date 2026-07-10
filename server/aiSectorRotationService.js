// server/aiSectorRotationService.js
// ── AI 300 — 5-day sector rotation engine (APEX v6 alpha layer) ─────────────
//
// For each trading day, ranks the PAI_S{n} synthetic sectors (the full live AI
// taxonomy, 18 today) by their trailing 5-day total return and bucketizes them:
//   GO       (rank 1–6)         → 1.25× sizing on entries in this sector
//   NEUTRAL  (rank 7 … N−4)     → 1.00× sizing on entries
//   NO_GO    (bottom 4 ranks)   → SKIP entries entirely
// The EXTREMES are fixed (GO = top 6, NO_GO = bottom 4); NEUTRAL flexes with the
// sector count, which is read live from aiUniverseData.js (SECTORS) so adding or
// removing a sector can never silently drop it from the ranking again.
//
// Storage: pnthr_ai_sector_rank_daily — one doc per trading date:
//   {
//     date:      'YYYY-MM-DD',
//     lookback:  'YYYY-MM-DD',  // 5 trading days back
//     ranks: [
//       { sectorId, name, rank, fiveDayReturn, tier },
//       ...one entry per sector (18 today), sorted by rank ASC
//     ],
//     builtAt:   ISODate
//   }
//
// Daily cron at 4:25 PM ET appends a new doc each market close
// (after pnthr_ai_sector_candles refresh at 5:05 PM — wait, actually
// the cron must run AFTER sector candles update; see updateAiSectorRankToday).
//
// Helpers exposed:
//   getAiSectorTier(sectorId, date)   → 'GO' | 'NEUTRAL' | 'NO_GO' | null
//   getAiSectorMultiplier(sectorId, date) → 1.25 | 1.0 | 0 | null
//   getAiSectorRanksOn(date)          → full rank doc
//   getLatestAiSectorRanks()          → most recent rank doc
//   backfillAiSectorRanks(opts)       → recompute history for the full window
//   updateAiSectorRankToday()         → append today's rank to the collection
//
// Read-only against pnthr_ai_sector_candles. Writes only to
// pnthr_ai_sector_rank_daily. Zero coupling to 679 / PAI300 collections.
// ────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';
import { SECTORS } from './scripts/aiUniverse/aiUniverseData.js';

const COLL_SECTOR_DAILY = 'pnthr_ai_sector_candles';
const COLL_SECTOR_RANK  = 'pnthr_ai_sector_rank_daily';

// Tier thresholds — top 6 GO, bottom 4 NO_GO (APEX v6 spec extremes, kept fixed),
// everything between = NEUTRAL. SELF-HEALING: the sector universe is read live from
// aiUniverseData.js so SECTOR_COUNT/NEUT_TOP track the taxonomy automatically — the
// count can never go stale (the 16→18 hardcoded-constant bug that dropped sectors 17
// & 18 from the ranking). Iterate the ACTUAL sector ids (robust to non-contiguous ids).
const SECTOR_IDS = SECTORS.map(s => s.id);
const SECTOR_COUNT = SECTOR_IDS.length;
const GO_TOP    = 6;                                           // ranks 1–6 → GO
const NO_GO_BOTTOM = 4;                                        // bottom 4 ranks → NO_GO
const NEUT_TOP  = Math.max(GO_TOP, SECTOR_COUNT - NO_GO_BOTTOM); // ranks 7…NEUT_TOP → NEUTRAL
const LOOKBACK_DAYS = 5;

const SECTOR_NAME_BY_ID = {};
for (const s of SECTORS) SECTOR_NAME_BY_ID[s.id] = s.name;

const TIER_MULT = { GO: 1.25, NEUTRAL: 1.0, NO_GO: 0 };

function tierFor(rank) {
  if (rank == null) return null;
  if (rank <= GO_TOP) return 'GO';
  if (rank <= NEUT_TOP) return 'NEUTRAL';
  return 'NO_GO';
}

// ── Read all sector daily series, sorted ascending by date ─────────────────
async function loadSectorDailyByDate(db) {
  const docs = await db.collection(COLL_SECTOR_DAILY)
    .find({ ticker: { $regex: /^PAI_S\d+$/ } }, { projection: { ticker: 1, daily: 1 } })
    .toArray();
  // Build sectorId → { dateMap: { date: close }, sortedDates: [] }
  const out = {};
  for (const doc of docs) {
    const m = /^PAI_S(\d+)$/.exec(doc.ticker);
    if (!m) continue;
    const sectorId = parseInt(m[1], 10);
    const sorted = [...(doc.daily || [])].sort((a, b) => a.date.localeCompare(b.date));
    const dateMap = {};
    for (const b of sorted) dateMap[b.date] = b.close;
    out[sectorId] = { dateMap, dates: sorted.map(b => b.date) };
  }
  return out;
}

// ── Build the full-universe rank for a given date (returns null if data unavailable)
function buildRankRowsForDate(date, sectorData, lookbackDate) {
  const rows = [];
  for (const sid of SECTOR_IDS) {
    const sd = sectorData[sid];
    if (!sd) continue;
    const cur = sd.dateMap[date];
    const lb  = sd.dateMap[lookbackDate];
    if (cur == null || lb == null || lb <= 0) continue;
    rows.push({
      sectorId: sid,
      name: SECTOR_NAME_BY_ID[sid] || `S${sid}`,
      fiveDayReturn: +(cur / lb - 1).toFixed(6),
    });
  }
  if (rows.length < SECTOR_COUNT) return null; // require every sector present
  rows.sort((a, b) => b.fiveDayReturn - a.fiveDayReturn);
  return rows.map((r, i) => ({
    ...r,
    rank: i + 1,
    tier: tierFor(i + 1),
  }));
}

// ── Get a master sorted list of trading dates across all sectors (union) ──
function buildDateUniverse(sectorData) {
  const set = new Set();
  for (const sid of Object.keys(sectorData)) {
    for (const d of sectorData[sid].dates) set.add(d);
  }
  return [...set].sort();
}

// ── Helper: given sorted list, return date that's `n` trading days back ───
function lookbackDate(sortedDates, idx, n) {
  const t = idx - n;
  return t >= 0 ? sortedDates[t] : null;
}

// ─────────────────────────────────────────────────────────────────────────
// Public — backfill / update
// ─────────────────────────────────────────────────────────────────────────

/**
 * Backfill historical sector ranks for the entire daily-candle window.
 * Idempotent: upsert by `date` so re-running just refreshes existing rows.
 * @param {object} [opts]
 * @param {string} [opts.startDate] inclusive cutoff (YYYY-MM-DD)
 * @returns {Promise<{written:number,skipped:number,from:string,to:string}>}
 */
export async function backfillAiSectorRanks(opts = {}) {
  const db = await connectToDatabase();
  if (!db) throw new Error('No DB connection');
  const sectorData = await loadSectorDailyByDate(db);
  const sortedDates = buildDateUniverse(sectorData);
  if (sortedDates.length === 0) return { written: 0, skipped: 0, from: null, to: null };

  const startDate = opts.startDate || sortedDates[0];
  const docs = [];
  let skipped = 0;
  for (let i = 0; i < sortedDates.length; i++) {
    const d = sortedDates[i];
    if (d < startDate) continue;
    if (i < LOOKBACK_DAYS) { skipped++; continue; }
    const lb = lookbackDate(sortedDates, i, LOOKBACK_DAYS);
    const ranks = buildRankRowsForDate(d, sectorData, lb);
    if (!ranks) { skipped++; continue; }
    docs.push({ date: d, lookback: lb, ranks, builtAt: new Date() });
  }

  if (docs.length === 0) return { written: 0, skipped, from: null, to: null };

  // Bulk upsert by date
  const ops = docs.map(d => ({
    replaceOne: { filter: { date: d.date }, replacement: d, upsert: true },
  }));
  await db.collection(COLL_SECTOR_RANK).bulkWrite(ops, { ordered: false });
  return { written: docs.length, skipped, from: docs[0].date, to: docs[docs.length - 1].date };
}

/**
 * Recompute today's sector rank using the latest available daily candles.
 * Safe to call from a daily cron at 4:25 PM ET (after market close).
 * Upserts a single doc.
 */
export async function updateAiSectorRankToday() {
  const db = await connectToDatabase();
  if (!db) throw new Error('No DB connection');
  const sectorData = await loadSectorDailyByDate(db);
  const sortedDates = buildDateUniverse(sectorData);
  if (sortedDates.length < LOOKBACK_DAYS + 1) {
    return { written: 0, reason: 'not enough history' };
  }
  const i = sortedDates.length - 1;
  const date = sortedDates[i];
  const lb = lookbackDate(sortedDates, i, LOOKBACK_DAYS);
  const ranks = buildRankRowsForDate(date, sectorData, lb);
  if (!ranks) return { written: 0, reason: 'incomplete data', date };
  const doc = { date, lookback: lb, ranks, builtAt: new Date() };
  await db.collection(COLL_SECTOR_RANK).replaceOne({ date }, doc, { upsert: true });
  return { written: 1, date, lookback: lb };
}

// ─────────────────────────────────────────────────────────────────────────
// Public — read helpers (used by signal generator + orders pipeline + Kill)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Get the most recent rank doc on or before `date` (defaults to latest).
 * Used by Phase B/C/D consumers to look up the right tier for a signal date
 * (handles weekends + holidays — walks back to last trading day with data).
 */
export async function getAiSectorRanksOn(date = null) {
  const db = await connectToDatabase();
  if (!db) return null;
  const filter = date ? { date: { $lte: date } } : {};
  return db.collection(COLL_SECTOR_RANK).find(filter).sort({ date: -1 }).limit(1).next();
}

export async function getLatestAiSectorRanks() {
  return getAiSectorRanksOn(null);
}

/**
 * Tier for a specific sector on (or before) a date.
 * Returns 'GO' / 'NEUTRAL' / 'NO_GO' / null if no data.
 */
export async function getAiSectorTier(sectorId, date = null) {
  const doc = await getAiSectorRanksOn(date);
  if (!doc) return null;
  const row = (doc.ranks || []).find(r => r.sectorId === sectorId);
  return row ? row.tier : null;
}

/**
 * Sizing multiplier for APEX v6: 1.25× for GO, 1.0× for NEUTRAL, 0 for NO_GO.
 * 0 means SKIP the signal entirely. Returns null if no rank doc available.
 */
export async function getAiSectorMultiplier(sectorId, date = null) {
  const tier = await getAiSectorTier(sectorId, date);
  if (tier == null) return null;
  return TIER_MULT[tier];
}

/**
 * Synchronous batch helper: given a pre-loaded rank doc and a list of
 * { ticker, sectorId } items, return a map ticker → tier. Useful when the
 * caller already has the rank doc in hand (avoids per-ticker round-trips).
 */
export function mapTickersToTiers(ranksDoc, tickerSectorPairs) {
  const out = {};
  if (!ranksDoc || !ranksDoc.ranks) return out;
  const sidToTier = {};
  for (const r of ranksDoc.ranks) sidToTier[r.sectorId] = r.tier;
  for (const { ticker, sectorId } of tickerSectorPairs) {
    out[ticker] = sidToTier[sectorId] || null;
  }
  return out;
}

// Constants for downstream use
export const AI_SECTOR_TIER_MULT = TIER_MULT;
export const AI_SECTOR_LOOKBACK_DAYS = LOOKBACK_DAYS;
export const AI_SECTOR_GO_TOP = GO_TOP;
export const AI_SECTOR_NEUT_TOP = NEUT_TOP;
