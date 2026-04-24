// server/earningsSeasonService.js
// ── PNTHR Earnings Season snapshot ──────────────────────────────────────────
//
// For the currently-reporting fiscal quarter, pulls every S&P 500 company's
// actual vs estimated EPS from FMP, buckets each report as MISS / MET / BEAT
// using a ±2% surprise band, aggregates per sector (count + average surprise
// magnitude on the miss side and the beat side separately), and returns the
// snapshot for the Earnings page.
//
// Cached in MongoDB (`pnthr_earnings_season_cache`, one doc per fiscal
// quarter) and on-demand-refreshed when the cache is older than 12 hours.
// No cron — the page lazy-refreshes on load.

import { connectToDatabase } from './database.js';
import { getSp500Tickers }   from './constituents.js';

const FMP_API_KEY       = process.env.FMP_API_KEY;
const CACHE_COLLECTION  = 'pnthr_earnings_season_cache';
const CACHE_STALE_AFTER = 12 * 60 * 60 * 1000; // 12 hours

// ±2% surprise band for "met expectations" (FactSet-style in-line definition).
// |actualEps − estEps| / |estEps|  ≤ MET_BAND  → MET
//   actualEps − estEps > 0 and outside band    → BEAT
//   actualEps − estEps < 0 and outside band    → MISS
const MET_BAND = 0.02;

// ── Reporting-season calendar ────────────────────────────────────────────────
// US earnings reporting lags the fiscal quarter by ~2 weeks. Windows below
// are conservative start/end dates that capture the full season for each
// fiscal quarter.
//   Q1 fiscal (Jan–Mar) reports    → Apr 1  → May 31
//   Q2 fiscal (Apr–Jun) reports    → Jul 1  → Aug 31
//   Q3 fiscal (Jul–Sep) reports    → Oct 1  → Nov 30
//   Q4 fiscal (Oct–Dec) reports    → Jan 1  → Feb 28
function getCurrentReportingQuarter(today = new Date()) {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth() + 1; // 1..12
  // Map month → (fiscal quarter that is being reported, calendar year of that quarter)
  //  Jan–Feb → Q4 of prior year
  //  Mar       → between seasons; default forward to Q1 (reports will start early April)
  //  Apr–May → Q1
  //  Jun       → between seasons; default forward to Q2
  //  Jul–Aug → Q2
  //  Sep       → between seasons; default forward to Q3
  //  Oct–Nov → Q3
  //  Dec       → between seasons; default forward to Q4
  let quarter, reportYear, startMonth, endMonth;
  if (m <= 2)          { quarter = 4; reportYear = y - 1; startMonth = 1;  endMonth = 2;  }
  else if (m === 3)    { quarter = 1; reportYear = y;     startMonth = 4;  endMonth = 5;  }
  else if (m <= 5)     { quarter = 1; reportYear = y;     startMonth = 4;  endMonth = 5;  }
  else if (m === 6)    { quarter = 2; reportYear = y;     startMonth = 7;  endMonth = 8;  }
  else if (m <= 8)     { quarter = 2; reportYear = y;     startMonth = 7;  endMonth = 8;  }
  else if (m === 9)    { quarter = 3; reportYear = y;     startMonth = 10; endMonth = 11; }
  else if (m <= 11)    { quarter = 3; reportYear = y;     startMonth = 10; endMonth = 11; }
  else                 { quarter = 4; reportYear = y;     startMonth = 1;  endMonth = 2;  }

  const seasonYear = quarter === 4 && m >= 12 ? y + 1 : y; // Q4 reports in next calendar year Jan–Feb
  const pad = (n) => String(n).padStart(2, '0');
  const lastDay = (mo, yr) => new Date(Date.UTC(yr, mo, 0)).getUTCDate();
  const from = `${seasonYear}-${pad(startMonth)}-01`;
  const to   = `${seasonYear}-${pad(endMonth)}-${pad(lastDay(endMonth, seasonYear))}`;
  const label = `Q${quarter} ${reportYear}`;
  const cacheKey = `${reportYear}-Q${quarter}`;
  return { label, cacheKey, quarter, reportYear, from, to };
}

// ── FMP fetch ────────────────────────────────────────────────────────────────
async function fetchSeasonReports(from, to) {
  if (!FMP_API_KEY) throw new Error('FMP_API_KEY missing');
  const url = `https://financialmodelingprep.com/api/v3/earning_calendar?from=${from}&to=${to}&apikey=${FMP_API_KEY}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`FMP earning_calendar ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// ── Sector lookup — pnthr_kill_scores is the durable PNTHR 679 sector map ────
// The Friday pipeline persists sector per ticker to pnthr_kill_scores every
// week. That's the canonical source of truth for the 679 universe and covers
// every S&P 500 ticker. We read the latest weekOf so this works even on a
// cold server where the in-memory apex cache hasn't warmed up yet.
async function buildSectorMap(db) {
  const map = new Map();
  if (!db) return map;
  try {
    const latest = await db.collection('pnthr_kill_scores')
      .findOne({}, { sort: { weekOf: -1 }, projection: { weekOf: 1 } });
    if (!latest?.weekOf) return map;
    const docs = await db.collection('pnthr_kill_scores')
      .find({ weekOf: latest.weekOf }, { projection: { ticker: 1, sector: 1 } })
      .toArray();
    for (const d of docs) {
      if (d.ticker && d.sector) map.set(d.ticker.toUpperCase(), d.sector);
    }
  } catch (err) {
    console.warn('[earningsSeason] sector map build failed:', err.message);
  }
  return map;
}

// ── Bucketing + aggregation ──────────────────────────────────────────────────
function classifyReport(actualEps, estEps) {
  if (actualEps == null || estEps == null) return null; // not yet reported
  if (Number.isNaN(+actualEps) || Number.isNaN(+estEps)) return null;
  const a = +actualEps;
  const e = +estEps;
  // Guard: zero or near-zero estimates blow up the % surprise. Fall back to
  // a $0.01 band when |estEps| is tiny so we don't misclassify pennies.
  const absE = Math.abs(e);
  const surprisePct = absE < 0.02
    ? (a - e) / 0.02         // normalize against 2¢ floor
    : (a - e) / absE;
  const isBeat = (a - e) >  Math.max(absE * MET_BAND, 0.005);
  const isMiss = (a - e) < -Math.max(absE * MET_BAND, 0.005);
  const bucket = isBeat ? 'BEAT' : isMiss ? 'MISS' : 'MET';
  return { bucket, surprisePct };
}

function aggregateBySector(reports, sectorMap, sp500Set) {
  // sectorStats[sector] = {
  //   sector, sp500Count, reported, beat, miss, met,
  //   beatSurprisePctSum, missSurprisePctSum,
  // }
  const sectorStats = new Map();
  // Start with every known S&P 500 sector so empty sectors show 0/N.
  for (const tUp of sp500Set) {
    const sec = sectorMap.get(tUp) || 'Unknown';
    if (!sectorStats.has(sec)) {
      sectorStats.set(sec, {
        sector: sec,
        sp500Count:          0,
        reported:            0,
        beat:                0,
        miss:                0,
        met:                 0,
        beatSurprisePctSum:  0,
        missSurprisePctSum:  0,
      });
    }
    sectorStats.get(sec).sp500Count += 1;
  }

  const totals = {
    sector:              'S&P 500 Total',
    sp500Count:          sp500Set.size,
    reported:            0,
    beat:                0,
    miss:                0,
    met:                 0,
    beatSurprisePctSum:  0,
    missSurprisePctSum:  0,
  };

  // De-dupe: FMP can return multiple rows per ticker in the window (amendments,
  // pre-announced/formal release split). Take the latest row per ticker that
  // has a non-null actual EPS.
  const perTickerLatest = new Map();
  for (const r of reports) {
    const t = (r.symbol || '').toUpperCase();
    if (!sp500Set.has(t)) continue;
    if (r.eps == null) continue; // not yet reported
    const prev = perTickerLatest.get(t);
    if (!prev || (r.date && r.date > prev.date)) perTickerLatest.set(t, r);
  }

  for (const [t, r] of perTickerLatest) {
    const cls = classifyReport(r.eps, r.epsEstimated);
    if (!cls) continue;
    const sec = sectorMap.get(t) || 'Unknown';
    const bucket = sectorStats.get(sec);
    if (!bucket) continue; // defensive — every SPX sector already seeded
    bucket.reported += 1;
    totals.reported += 1;
    bucket[cls.bucket.toLowerCase()] += 1;
    totals[cls.bucket.toLowerCase()]  += 1;
    if (cls.bucket === 'BEAT') {
      bucket.beatSurprisePctSum += cls.surprisePct;
      totals.beatSurprisePctSum += cls.surprisePct;
    } else if (cls.bucket === 'MISS') {
      bucket.missSurprisePctSum += cls.surprisePct;
      totals.missSurprisePctSum += cls.surprisePct;
    }
  }

  // Convert maps → array and derive averages + % shares.
  const finish = (s) => {
    const pct = (n) => s.reported > 0 ? +(n / s.reported * 100).toFixed(1) : 0;
    const avgBeat = s.beat > 0 ? +((s.beatSurprisePctSum / s.beat) * 100).toFixed(1) : null;
    const avgMiss = s.miss > 0 ? +((s.missSurprisePctSum / s.miss) * 100).toFixed(1) : null;
    return {
      sector:       s.sector,
      sp500Count:   s.sp500Count,
      reported:     s.reported,
      beat:         s.beat,
      miss:         s.miss,
      met:          s.met,
      beatPct:      pct(s.beat),
      missPct:      pct(s.miss),
      metPct:       pct(s.met),
      avgBeatSurprisePct: avgBeat, // e.g. +7.2
      avgMissSurprisePct: avgMiss, // e.g. -4.8
    };
  };

  const sectors = [...sectorStats.values()]
    .map(finish)
    .sort((a, b) => b.reported - a.reported); // most-reported first

  return { sectors, totals: finish(totals) };
}

// ── Main entrypoint ──────────────────────────────────────────────────────────
export async function getEarningsSeasonSnapshot({ forceRefresh = false } = {}) {
  const season = getCurrentReportingQuarter();
  const db = await connectToDatabase();

  // Cache hit path
  if (db && !forceRefresh) {
    const cached = await db.collection(CACHE_COLLECTION).findOne({ cacheKey: season.cacheKey });
    if (cached && cached.generatedAt) {
      const age = Date.now() - new Date(cached.generatedAt).getTime();
      if (age < CACHE_STALE_AFTER) {
        return { ...cached.snapshot, cachedAt: cached.generatedAt, cacheAgeMinutes: Math.round(age / 60000) };
      }
    }
  }

  // Build fresh
  const sp500Arr = await getSp500Tickers();
  const sp500Set = new Set((sp500Arr || []).map(t => t.toUpperCase()));
  const sectorMap = await buildSectorMap(db);
  const reports = await fetchSeasonReports(season.from, season.to);
  const agg = aggregateBySector(reports, sectorMap, sp500Set);

  const snapshot = {
    season:        season.label,
    cacheKey:      season.cacheKey,
    from:          season.from,
    to:            season.to,
    sp500Count:    sp500Set.size,
    ...agg,
  };

  if (db) {
    try {
      await db.collection(CACHE_COLLECTION).updateOne(
        { cacheKey: season.cacheKey },
        { $set: { cacheKey: season.cacheKey, snapshot, generatedAt: new Date() } },
        { upsert: true }
      );
    } catch (err) {
      console.warn('[earningsSeason] cache write failed:', err.message);
    }
  }

  return { ...snapshot, cachedAt: new Date().toISOString(), cacheAgeMinutes: 0 };
}
