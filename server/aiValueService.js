// server/aiValueService.js
// ── PNTHR Value — the "bottoming" screen for the AI Elite 300 ────────────────
//
// Finds names that are genuinely BEATEN DOWN and have been below their
// sector-optimized EMA ("OpEMA") a long time, then stages each by where it sits
// versus that line so you can watch a real bottom form and turn up:
//
//   turned  — reclaimed the line (back above within RECLAIM_W wks, >= LIGHT_BAND% light)
//   line    — straddling the line (within NEAR_BAND% below, up to just over)
//   basing  — still > NEAR_BAND% under the line, building
//   other   — not a candidate (healthy / not beaten / too young / data-suspect)
//
// A name is a CANDIDATE only when beaten >= BEATEN% off its 52-wk high AND below
// the line >= BASEMIN weeks. Depth (>= DEEP%) is marked as extra conviction.
//
// Integrity (Number Integrity Protocol):
//   • Drawdown is closing-basis off the highest close in the last 252 closed
//     sessions, from the SAME candle store the engine uses (pnthr_ai_bt_candles).
//   • The OpEMA line uses the engine's OWN calculateEMA + SECTOR_EMA_PERIODS +
//     the effectivePeriod fallback, so "below/above the line" cannot disagree
//     with the Jungle's BL/SS signals.
//   • Data-suspect names are excluded from every candidate box and shown dimmed:
//       - pending stock split (getSplitExclusions), and
//       - a best-effort live FMP cross-check — if our stored 52-wk high or our
//         last close is on a different scale than FMP's split-adjusted quote,
//         the drawdown is untrustworthy (e.g. an un-resynced reverse split).
//     If FMP is unavailable the page still renders; only the FMP flag is skipped.
// ────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';
import { SECTORS, FUND_META } from './scripts/aiUniverse/aiUniverseData.js';
import { SECTOR_EMA_PERIODS } from './data/pnthrAiSectorsConfig.js';
import { calculateEMA } from './signalDetection.js';
import { fetchFMP } from './stockService.js';
import { getSplitExclusions } from './splitMaintenanceService.js';

// ── Tunable knobs (locked with Scott 2026-07-15; change only on request) ─────
export const VALUE_KNOBS = {
  BASEMIN:    13,   // min consecutive weeks below the line to count as a "long base"
  BEATEN:     30,   // min % off the 52-wk high to count as "beaten"
  DEEP:       50,   // % off high that earns the "deep" conviction mark
  RECLAIM_W:  4,    // a reclaim is still "fresh" for this many weeks above the line
  LIGHT_BAND: 2,    // % above the line for a reclaim to count as decisive (not a toe over)
  NEAR_BAND:  3,    // within this % below the line = "at the line" (about to resolve)
};
const WK_HIGH_WINDOW = 252;   // ~52 weeks of trading sessions
const WEEK_SESSIONS  = 5;     // 1 week = 5 trading sessions (for the 1-wk move)

const CACHE_MS = 5 * 60 * 1000;
let _cache = null;            // { data, ts }
export function clearAiValueCache() { _cache = null; }

// ── ticker → sector (first listing wins) ────────────────────────────────────
const TICKER_META = {};
const ALL_TICKERS = [];
for (const sec of SECTORS) {
  for (const h of sec.holdings) {
    if (TICKER_META[h.ticker]) continue;
    TICKER_META[h.ticker] = { sectorId: sec.id, sectorName: sec.name, name: h.name };
    ALL_TICKERS.push(h.ticker);
  }
}

// Engine's young-name fallback (mirrors aiUniverseSignalsService.effectivePeriod)
function effectivePeriod(barCount, sectorPeriod) {
  if (barCount >= sectorPeriod * 3) return sectorPeriod;
  if (barCount >= 21 + 2)           return 21;
  return null;
}

// ── ET-aware closed-bar cutoffs (mirrors aiObOsService) ─────────────────────
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
function closedBarCutoffs(now = new Date()) {
  const { dateStr, hour, dow } = etParts(now);
  const dailyCutoff = hour >= 16 ? dateStr : isoAddDays(dateStr, -1);
  const thisMonday = isoAddDays(dateStr, -((dow + 6) % 7));
  const currentWeekClosed = (dow === 6) || (dow === 0) || (dow === 5 && hour >= 16);
  const weeklyCutoff = currentWeekClosed ? thisMonday : isoAddDays(thisMonday, -7);
  return { dailyCutoff, weeklyCutoff };
}
// weekOf (Monday) → that week's Friday close date, for display
function weekOfToFriday(weekOf) {
  if (!weekOf) return null;
  return isoAddDays(weekOf, 4);
}

// Pull one collection's bars stripped to { d, c }, sorted ascending, closed only.
async function loadCloses(db, collection, arrayField, dateField, cutoff) {
  const docs = await db.collection(collection).aggregate([
    { $match: { ticker: { $in: ALL_TICKERS } } },
    { $project: { ticker: 1,
        bars: { $map: { input: `$${arrayField}`, as: 'b', in: { d: `$$b.${dateField}`, c: `$$b.close` } } } } },
  ]).toArray();
  const out = {};
  for (const doc of docs) {
    out[doc.ticker] = (doc.bars || [])
      .filter(b => b && b.d && b.d <= cutoff && Number.isFinite(b.c) && b.c > 0)
      .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  }
  return out;
}

// Best-effort FMP scale cross-check → Set of suspect tickers + reason map.
async function fmpScaleSuspects(rows) {
  const suspect = new Map();   // ticker -> reason
  try {
    const fmp = {};
    for (let i = 0; i < ALL_TICKERS.length; i += 200) {
      const chunk = ALL_TICKERS.slice(i, i + 200);
      const quotes = await fetchFMP(`/quote/${chunk.join(',')}`).catch(() => null);
      if (Array.isArray(quotes)) for (const q of quotes) if (q && q.symbol) fmp[q.symbol] = q;
    }
    if (!Object.keys(fmp).length) return suspect;   // FMP down — skip flagging
    for (const r of rows) {
      const q = fmp[r.ticker];
      if (!q) continue;
      if (+q.price > 0) {
        const pr = r.last / +q.price;
        if (pr < 0.75 || pr > 1.33) { suspect.set(r.ticker, `price scale ${pr.toFixed(2)}x vs FMP — data-suspect`); continue; }
      }
      if (+q.yearHigh > 0 && r.high52 > 0) {
        const hr = r.high52 / +q.yearHigh;
        if (hr < 0.70 || hr > 1.40) suspect.set(r.ticker, `52-wk-high scale ${hr.toFixed(2)}x vs FMP — data-suspect`);
      }
    }
  } catch (e) {
    console.warn('[Value] FMP cross-check skipped:', e.message);
  }
  return suspect;
}

// ── Main ────────────────────────────────────────────────────────────────────
export async function getAiValue(forceRefresh = false) {
  if (!forceRefresh && _cache && (Date.now() - _cache.ts) < CACHE_MS) return _cache.data;

  const db = await connectToDatabase();
  if (!db) return { ok: false, error: 'Mongo connect failed' };

  const { dailyCutoff, weeklyCutoff } = closedBarCutoffs();

  const [dailyBars, weeklyBars, splitExcl] = await Promise.all([
    loadCloses(db, 'pnthr_ai_bt_candles',        'daily',  'date',   dailyCutoff),
    loadCloses(db, 'pnthr_ai_bt_candles_weekly',  'weekly', 'weekOf', weeklyCutoff),
    getSplitExclusions(db).catch(() => new Map()),
  ]);

  const rows = [];
  let dailyAsOf = '', latestWeek = '';

  for (const ticker of ALL_TICKERS) {
    const meta = TICKER_META[ticker];
    const dBars = dailyBars[ticker] || [];
    if (dBars.length < WEEK_SESSIONS + 1) continue;      // not enough daily history

    // ── Depth + 1-wk move (daily, closing basis) ──
    const closes = dBars.map(b => b.c);
    const n = closes.length;
    const last = closes[n - 1];
    const asOf = dBars[n - 1].d;
    if (asOf > dailyAsOf) dailyAsOf = asOf;
    const high52 = Math.max(...closes.slice(Math.max(0, n - WK_HIGH_WINDOW)));
    const peak   = Math.max(...closes);
    const prevWk = closes[n - 1 - WEEK_SESSIONS];
    const d52 = Math.round((high52 - last) / high52 * 1000) / 10;
    const dpk = Math.round((peak   - last) / peak   * 1000) / 10;
    const wk  = Math.round((last - prevWk) / prevWk * 1000) / 10;

    // biggest single-session close move (volatility heads-up)
    let worstGap = 0;
    for (let i = 1; i < n; i++) {
      const chg = (closes[i] - closes[i - 1]) / closes[i - 1];
      if (Math.abs(chg) > Math.abs(worstGap)) worstGap = chg;
    }
    const volatile = Math.abs(worstGap) >= 0.40;

    // ── OpEMA line (weekly) — engine's calculateEMA + sector period ──
    const wBars = weeklyBars[ticker] || [];
    let opema = null, opemaPeriod = null, light = null, side = null;
    let wksBelow = null, wksAbove = null, reclaim = false, weekOf = null;
    const period = SECTOR_EMA_PERIODS[meta.sectorId] || 30;
    const eff = effectivePeriod(wBars.length, period);
    if (eff) {
      const emaBars = wBars.map(b => ({ time: b.d, close: b.c }));
      const emaData = calculateEMA(emaBars, eff);                     // ENGINE function
      const emaByWeek = Object.fromEntries(emaData.map(e => [e.time, e.value]));
      const aligned = wBars.filter(b => emaByWeek[b.d] != null)
        .map(b => ({ w: b.d, c: b.c, e: emaByWeek[b.d], below: b.c < emaByWeek[b.d] }));
      if (aligned.length) {
        const m = aligned.length;
        const lastA = aligned[m - 1];
        opema = Math.round(lastA.e * 100) / 100;
        opemaPeriod = eff;
        weekOf = lastA.w;
        if (weekOf > latestWeek) latestWeek = weekOf;
        light = Math.round(((lastA.c / lastA.e) - 1) * 1000) / 10;
        side = lastA.below ? 'below' : 'above';
        let curRun = 1;
        for (let i = m - 2; i >= 0; i--) { if (aligned[i].below === lastA.below) curRun++; else break; }
        if (lastA.below) { wksBelow = curRun; wksAbove = 0; }
        else {
          wksAbove = curRun;
          let prior = 0;
          for (let i = m - 1 - curRun; i >= 0; i--) { if (aligned[i].below) prior++; else break; }
          wksBelow = prior;
          reclaim = (wksAbove === 1 && prior >= 1);
        }
      }
    }

    rows.push({
      ticker, name: meta.name, sector: meta.sectorName,
      d52, dpk, wk, last: Math.round(last * 100) / 100, high52: Math.round(high52 * 100) / 100,
      opema, opemaPeriod, light, side, wksBelow, wksAbove, reclaim, weekOf,
      volatile, deep: d52 >= VALUE_KNOBS.DEEP,
      suspect: false, suspectReason: null,
    });
  }

  // ── Data-suspect flagging: pending splits + FMP scale cross-check ──
  const fmpSusp = await fmpScaleSuspects(rows);
  for (const r of rows) {
    if (splitExcl.has(r.ticker)) { r.suspect = true; r.suspectReason = splitExcl.get(r.ticker); }
    else if (fmpSusp.has(r.ticker)) { r.suspect = true; r.suspectReason = fmpSusp.get(r.ticker); }
  }

  // ── Classify into boxes ──
  const K = VALUE_KNOBS;
  function classify(r) {
    if (r.suspect || r.opema == null) return null;
    if (!(r.d52 >= K.BEATEN && r.wksBelow >= K.BASEMIN)) return null;   // beaten + long base
    if (r.side === 'above') {
      if (r.wksAbove > K.RECLAIM_W) return null;                        // turned long ago
      if (r.light >= K.LIGHT_BAND) return 'turned';
      if (r.light >= 0) return 'line';                                  // marginal reclaim
      return null;
    }
    if (r.light >= -K.NEAR_BAND) return 'line';                         // pressing from below
    return 'basing';
  }
  for (const r of rows) r.state = classify(r);

  const byDrawdown = (a, b) => b.d52 - a.d52;
  const boxes = {
    turned: rows.filter(r => r.state === 'turned').sort(byDrawdown),
    line:   rows.filter(r => r.state === 'line').sort(byDrawdown),
    basing: rows.filter(r => r.state === 'basing').sort(byDrawdown),
    other:  rows.filter(r => !r.state).sort(byDrawdown),
  };
  const cand = boxes.turned.length + boxes.line.length + boxes.basing.length;

  const data = {
    ok: true,
    generatedAt: new Date().toISOString(),
    asOf: dailyAsOf,
    weekEnding: weekOfToFriday(latestWeek),
    universe: { version: FUND_META?.version || null, count: ALL_TICKERS.length, withData: rows.length },
    knobs: VALUE_KNOBS,
    counts: {
      candidates: cand,
      turned: boxes.turned.length, line: boxes.line.length, basing: boxes.basing.length,
      other: boxes.other.length, deep: rows.filter(r => r.state && r.deep).length,
    },
    boxes,
  };

  _cache = { data, ts: Date.now() };
  return data;
}
