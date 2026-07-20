// server/dailyRankService.js
// ── PNTHR Daily Rank — every AI Elite 300 name ranked by today's move ────────
//
// One continuous ranking, biggest gainer at the top down to biggest decliner at
// the bottom, measured against the PREVIOUS SESSION'S CLOSE. Live through the
// trading day; after the bell it settles into the completed session's move.
//
// Why live quotes and not stored candles:
//   pnthr_ai_bt_candles is closed-bar-only BY DESIGN (aiUniverseDailyJob.js
//   CLOSED_BAR_CUTOFF_MIN = 4:10pm ET). It structurally cannot hold today's
//   in-progress bar, so it can never answer "what is moving right now". The
//   live FMP quote is the only source for the current-day number, and its
//   changesPercentage is the house-canonical field that matches TWS.
//
// Integrity (Number Integrity Protocol):
//   • The percentage is COMPUTED here from (price − previousClose) / previousClose
//     at FULL quote precision rather than read from FMP's changesPercentage.
//     FMP's own field is then compared against it as an independent second
//     derivation; a disagreement beyond PCT_AGREE_TOL flags the row rather than
//     silently picking a winner. Prices ship at full precision and are rounded
//     only for display — rounding them in the payload would break the identity
//     for low-priced names (a $1.36 stock shifts ~0.3pp at 2dp).
//   • SPLIT GUARD. A 2-for-1 split against an unadjusted prior close reads as a
//     clean −50% and would otherwise plant a fake name at the bottom of the
//     board. Two defenses: pending splits (getSplitExclusions) and a same-session
//     cross-check of FMP's previousClose against OUR OWN stored candle close for
//     that exact date. Same day, two independent sources.
//   • Flagged names are DIMMED AND KEPT, never dropped: the page claims to rank
//     the whole universe, so a silent drop would make that claim false.
//   • Names whose prior close could not be cross-checked (candles not caught up)
//     report verified:false. We never claim a check that did not happen.
// ────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';
import { FUND_META } from './scripts/aiUniverse/aiUniverseData.js';
import { getAiUniverseHoldings } from './aiUniverseService.js';
import { fetchAiQuotesBatch, ymdET } from './aiIntradayOverlay.js';
import { getAiUniverseSignals } from './aiUniverseSignalsService.js';
import { getSplitExclusions } from './splitMaintenanceService.js';
import { signalLabel } from './moversService.js';

// Live board: keep this at the underlying quote cache's TTL so the page feels
// live. The client polls every 60s, so a 30s cache means what you see is never
// more than ~30s stale, while the whole universe still costs at most one FMP
// call per 30s no matter how many people have the page open.
const CACHE_MS = 30 * 1000;

// Our stored close vs FMP's previousClose for the SAME session. Closes should
// agree almost exactly (same upstream, both split-adjusted); 5% is loose enough
// to absorb vendor revisions and tight enough that any real split (>=2:1 = 100%
// off) is caught with enormous margin.
const CLOSE_AGREE_TOL = 0.05;
// Max age of our newest stored bar before we treat the cross-check as
// unavailable rather than failed (absorbs weekends + market holidays).
const STALE_CANDLE_DAYS = 5;
// Our computed % vs FMP's changesPercentage, in percentage points.
const PCT_AGREE_TOL = 0.05;

let _cache = null;                      // { data, ts }
export function clearDailyRankCache() { _cache = null; }

const r2 = v => Math.round(v * 100) / 100;
const r3 = v => Math.round(v * 1000) / 1000;

function daysBetween(isoA, isoB) {
  const a = new Date(isoA + 'T12:00:00Z').getTime();
  const b = new Date(isoB + 'T12:00:00Z').getTime();
  return Math.abs(a - b) / 86400000;
}

// Newest few daily bars per ticker, ORDER-INDEPENDENT.
//
// pnthr_ai_bt_candles.daily is stored NEWEST-FIRST, so the newest bars are at
// the head. Rather than depend on that (the storage order has bitten this
// codebase before), take a slice from BOTH ends and sort by date ourselves —
// whichever way the array is ordered, the recent bars are in one of the two
// slices. Six bars per ticker keeps the read tiny.
async function loadRecentCloses(db, tickers) {
  const docs = await db.collection('pnthr_ai_bt_candles').aggregate([
    { $match: { ticker: { $in: tickers } } },
    { $project: {
        ticker: 1,
        head: { $slice: ['$daily', 3] },
        tail: { $slice: ['$daily', -3] },
    } },
  ]).toArray();

  const out = {};
  for (const doc of docs) {
    const byDate = new Map();
    for (const b of [...(doc.head || []), ...(doc.tail || [])]) {
      if (b && b.date && Number.isFinite(b.close) && b.close > 0) byDate.set(b.date, b.close);
    }
    out[doc.ticker] = [...byDate.entries()]
      .map(([date, close]) => ({ date, close }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));   // ascending
  }
  return out;
}

// Cross-check FMP's previousClose against our own stored close for that same
// session. Returns { verified, reason } — reason non-null means data-suspect.
function crossCheckPrevClose(bars, sessionDate, prevClose) {
  if (!bars || !bars.length) return { verified: false, reason: null };      // no candles yet
  // The prior session = newest stored bar strictly BEFORE today's session.
  let prior = null;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (!sessionDate || bars[i].date < sessionDate) { prior = bars[i]; break; }
  }
  if (!prior) return { verified: false, reason: null };
  // Candle store behind (or the session date is unknown) — can't claim a check.
  if (sessionDate && daysBetween(prior.date, sessionDate) > STALE_CANDLE_DAYS) {
    return { verified: false, reason: null };
  }
  const ratio = prevClose / prior.close;
  if (ratio < 1 - CLOSE_AGREE_TOL || ratio > 1 + CLOSE_AGREE_TOL) {
    return {
      verified: false,
      reason: `prior close ${prevClose.toFixed(2)} vs our ${prior.close.toFixed(2)} on ${prior.date} (${ratio.toFixed(2)}x) — possible split or bad data`,
    };
  }
  return { verified: true, reason: null };
}

// ── Main ────────────────────────────────────────────────────────────────────
export async function getDailyRank(forceRefresh = false) {
  if (!forceRefresh && _cache && (Date.now() - _cache.ts) < CACHE_MS) return _cache.data;

  const holdings = getAiUniverseHoldings();          // deactivated names already excluded
  const tickers  = holdings.map(h => h.ticker);
  const meta     = Object.fromEntries(holdings.map(h => [h.ticker, h]));

  const db = await connectToDatabase();

  const [quoteMap, signalsRes, splitExcl, recentBars] = await Promise.all([
    fetchAiQuotesBatch(tickers).catch(() => ({})),
    getAiUniverseSignals().then(r => r.signals || {}).catch(() => ({})),
    db ? getSplitExclusions(db).catch(() => new Map()) : Promise.resolve(new Map()),
    db ? loadRecentCloses(db, tickers).catch(() => ({})) : Promise.resolve({}),
  ]);

  // No live quotes means no board. Say so rather than render an empty ranking.
  if (!quoteMap || Object.keys(quoteMap).length === 0) {
    return { ok: false, error: 'Live quotes unavailable — cannot rank today\'s moves right now.' };
  }

  // Session date + freshness come from the quotes themselves, so weekends and
  // holidays resolve automatically (a Sunday read stamps Friday's session).
  let newestTs = 0;
  for (const t of tickers) {
    const ts = Number(quoteMap[t]?.timestamp);
    if (Number.isFinite(ts) && ts > newestTs) newestTs = ts;
  }
  const sessionDate = newestTs ? ymdET(newestTs) : null;

  const rows = [];
  let missing = 0;
  for (const t of tickers) {
    const q = quoteMap[t];
    if (!q) { missing++; continue; }

    const price = Number(q.price);
    const prev  = Number(q.previousClose);
    if (!Number.isFinite(price) || !Number.isFinite(prev) || prev <= 0) { missing++; continue; }

    // The number, computed from the two numbers shown beside it.
    const changePct = ((price - prev) / prev) * 100;
    const change    = price - prev;

    // Independent second derivation: FMP's own field.
    const fmpPct = Number(q.changesPercentage);
    const pctAgrees = Number.isFinite(fmpPct) ? Math.abs(fmpPct - changePct) <= PCT_AGREE_TOL : null;

    // Integrity: pending split, then same-session prior-close cross-check.
    const xc = crossCheckPrevClose(recentBars[t], sessionDate, prev);
    let suspect = false;
    let suspectReason = null;
    if (splitExcl.has(t)) {
      suspect = true;
      suspectReason = splitExcl.get(t);
    } else if (xc.reason) {
      suspect = true;
      suspectReason = xc.reason;
    } else if (pctAgrees === false) {
      suspect = true;
      suspectReason = `our ${changePct.toFixed(2)}% vs FMP ${fmpPct.toFixed(2)}% — quote internally inconsistent`;
    }

    const vol    = Number(q.volume);
    const avgVol = Number(q.avgVolume);
    const relVol = Number.isFinite(vol) && Number.isFinite(avgVol) && avgVol > 0 ? vol / avgVol : null;

    rows.push({
      ticker:    t,
      name:      meta[t]?.companyName || q.name || t,
      sector:    meta[t]?.sectorName || null,
      // Full precision — the client formats. Keeps changePct exactly re-derivable
      // from price and prevClose for every name, including sub-$2 ones.
      price,
      prevClose: prev,
      change,
      changePct: r3(changePct),
      volume:    Number.isFinite(vol) ? vol : null,
      avgVolume: Number.isFinite(avgVol) ? avgVol : null,
      relVol:    relVol == null ? null : r2(relVol),
      signalLabel: signalLabel(signalsRes, t),
      verified:  xc.verified,
      suspect,
      suspectReason,
    });
  }

  // The ranking: biggest gainer first, biggest decliner last.
  rows.sort((a, b) => b.changePct - a.changePct);
  rows.forEach((r, i) => { r.rank = i + 1; });

  const data = {
    ok: true,
    generatedAt: new Date().toISOString(),
    sessionDate,
    asOf: newestTs ? new Date(newestTs * 1000).toISOString() : null,
    universe: {
      version: FUND_META?.version || null,
      count: tickers.length,
      withData: rows.length,
      missing,
    },
    counts: {
      advancers:  rows.filter(r => r.changePct > 0).length,
      decliners:  rows.filter(r => r.changePct < 0).length,
      unchanged:  rows.filter(r => r.changePct === 0).length,
      suspect:    rows.filter(r => r.suspect).length,
      unverified: rows.filter(r => !r.verified && !r.suspect).length,
    },
    rows,
  };

  _cache = { data, ts: Date.now() };
  return data;
}
