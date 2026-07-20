// server/aiValueService.js
// ── PNTHR Value — the "bottoming" screen for the AI Elite 300 ────────────────
//
// Finds names that are genuinely BEATEN DOWN and have been below their
// sector-optimized EMA ("OpEMA") a long time, then stages each by where it sits
// versus that line so you can watch a real bottom form and turn up:
//
//   turned  — back above the line by >= LIGHT_BAND%, and it crossed up within the
//             last RECLAIM_W weeks (recently)
//   line    — straddling the line (within NEAR_BAND% below, up to just over it)
//   basing  — still > NEAR_BAND% under the line, building
//   other   — not a candidate (healthy / not beaten / too young / data-suspect)
//
// A name is a CANDIDATE only when beaten >= BEATEN% off its 52-wk high AND it has
// been below the line >= BASEMIN weeks SINCE IT MADE ITS HIGH. Depth (>= DEEP%)
// is marked as extra conviction.
//
// LIVE / developing week: the OpEMA line + current price use the DEVELOPING
// (current, still-forming) week — its close set to the live FMP price — so this
// page matches the stock chart rather than lagging a week behind on the last
// closed bar. Falls back to the stored developing bar, then the last close, if
// FMP is unavailable.
//
// Integrity (Number Integrity Protocol):
//   • Drawdown is closing-basis off the highest close in the last 252 sessions,
//     from the SAME candle store the engine uses (pnthr_ai_bt_candles), with the
//     live price folded in as the current point.
//   • The OpEMA line uses the engine's OWN calculateEMA + SECTOR_EMA_PERIODS +
//     the effectivePeriod fallback, so "below/above the line" tracks the chart.
//   • Data-suspect names are excluded from every candidate box and shown dimmed:
//       - pending stock split (getSplitExclusions), and
//       - a live FMP cross-check — if our stored last close or 52-wk high is on a
//         different scale than FMP's split-adjusted quote, the name is untrusted.
// ────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';
import { SECTORS, FUND_META } from './scripts/aiUniverse/aiUniverseData.js';
import { fetchFMP } from './stockService.js';
import { getSplitExclusions } from './splitMaintenanceService.js';
// The OpEMA line lives in one place (opEma.js) so this page, Daily Rank, and
// anything added later cannot drift apart. Extraction is proven equivalent to
// the logic that used to be inline here by opEma.test.mjs.
import {
  etParts, isoAddDays, developingWeekMonday,
  loadWeeklyCloses, buildDevelopingSeries, computeOpEma,
} from './opEma.js';

// ── Tunable knobs (locked with Scott 2026-07-15; change only on request) ─────
export const VALUE_KNOBS = {
  BASEMIN:    13,   // min weeks below the line SINCE ITS HIGH to count as a "long base"
  BEATEN:     30,   // min % off the 52-wk high to count as "beaten"
  DEEP:       50,   // % off high that earns the "deep" conviction mark
  RECLAIM_W:  5,    // "recently above" — reclaimed the line within this many weeks = turned up
  LIGHT_BAND: 0.5,  // min % above the line for a reclaim to count (keeps hair-thin crosses in "at the line")
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

// ── ET-aware dates ──────────────────────────────────────────────────────────
// etParts / isoAddDays / developingWeekMonday now come from opEma.js.
// last CLOSED daily bar (today only after the 16:00 ET close)
function dailyCutoffET() {
  const { dateStr, hour } = etParts();
  return hour >= 16 ? dateStr : isoAddDays(dateStr, -1);
}
function weekOfToFriday(weekOf) { return weekOf ? isoAddDays(weekOf, 4) : null; }

// Pull one collection's bars stripped to { d, c }, sorted ascending, up to cutoff.
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

// Live FMP quotes for the whole universe (2 batched calls). {} if FMP is down.
async function fetchQuotes() {
  const map = {};
  for (let i = 0; i < ALL_TICKERS.length; i += 200) {
    const chunk = ALL_TICKERS.slice(i, i + 200);
    const quotes = await fetchFMP(`/quote/${chunk.join(',')}`).catch(() => null);
    if (Array.isArray(quotes)) for (const q of quotes) if (q && q.symbol) map[q.symbol] = q;
  }
  return map;
}

// FMP scale cross-check → Map(ticker → reason). Compares our STORED last close +
// 52-wk high against FMP's split-adjusted quote; flags names on a wrong scale.
function fmpScaleSuspects(rows, quoteMap) {
  const suspect = new Map();
  if (!quoteMap || !Object.keys(quoteMap).length) return suspect;   // FMP down — skip flagging
  for (const r of rows) {
    const q = quoteMap[r.ticker];
    if (!q) continue;
    if (+q.price > 0 && r.dailyClose > 0) {
      const pr = r.dailyClose / +q.price;
      if (pr < 0.75 || pr > 1.33) { suspect.set(r.ticker, `price scale ${pr.toFixed(2)}x vs FMP — data-suspect`); continue; }
    }
    if (+q.yearHigh > 0 && r.high52 > 0) {
      const hr = r.high52 / +q.yearHigh;
      if (hr < 0.70 || hr > 1.40) suspect.set(r.ticker, `52-wk-high scale ${hr.toFixed(2)}x vs FMP — data-suspect`);
    }
  }
  return suspect;
}

// ── Main ────────────────────────────────────────────────────────────────────
export async function getAiValue(forceRefresh = false) {
  if (!forceRefresh && _cache && (Date.now() - _cache.ts) < CACHE_MS) return _cache.data;

  const db = await connectToDatabase();
  if (!db) return { ok: false, error: 'Mongo connect failed' };

  const dailyCutoff = dailyCutoffET();
  const devMonday   = developingWeekMonday();

  const [dailyBars, weeklyBars, splitExcl, quoteMap] = await Promise.all([
    loadCloses(db, 'pnthr_ai_bt_candles', 'daily', 'date', dailyCutoff),
    loadWeeklyCloses(db, ALL_TICKERS, devMonday),   // include the developing week
    getSplitExclusions(db).catch(() => new Map()),
    fetchQuotes().catch(() => ({})),
  ]);
  const K = VALUE_KNOBS;
  let dailyAsOf = '';

  const rows = [];
  for (const ticker of ALL_TICKERS) {
    const meta = TICKER_META[ticker];
    const dBars = dailyBars[ticker] || [];
    if (dBars.length < WEEK_SESSIONS + 1) continue;      // not enough daily history

    const q = quoteMap[ticker];
    const live = q && +q.price > 0 ? +q.price : null;

    // ── Depth + 1-wk move — live current price vs daily history ──
    const closes = dBars.map(b => b.c);
    const n = closes.length;
    const dailyClose = closes[n - 1];
    const asOf = dBars[n - 1].d;
    if (asOf > dailyAsOf) dailyAsOf = asOf;
    const cur = live != null ? live : dailyClose;        // current price (live when available)
    const high52 = Math.max(cur, ...closes.slice(Math.max(0, n - WK_HIGH_WINDOW)));
    const peak   = Math.max(cur, ...closes);
    const prevWk = closes[n - WEEK_SESSIONS];
    const d52 = Math.round((high52 - cur) / high52 * 1000) / 10;
    const dpk = Math.round((peak   - cur) / peak   * 1000) / 10;
    const wk  = Math.round((cur - prevWk) / prevWk * 1000) / 10;

    // biggest single-session close move (volatility heads-up)
    let worstGap = 0;
    for (let i = 1; i < n; i++) {
      const chg = (closes[i] - closes[i - 1]) / closes[i - 1];
      if (Math.abs(chg) > Math.abs(worstGap)) worstGap = chg;
    }
    const volatile = Math.abs(worstGap) >= 0.40;

    // ── OpEMA line (weekly) — developing week's close set to the live price ──
    const wSeries = buildDevelopingSeries(weeklyBars[ticker], devMonday, live);
    const line = computeOpEma(wSeries, meta.sectorId);
    const { opema, opemaPeriod, light, side, weekOf, aligned } = line;
    let wksBelow = null, wksAbove = null, aboveRun = null, reclaim = false;
    if (aligned.length) {
      const m = aligned.length;
      const lastA = aligned[m - 1];
      // wksBelow = weeks the close was below the line, counted FROM WHEN IT MADE ITS HIGH
      // (the peak weekly close) — the length of the decline/base since the top.
      let hiIdx = 0;
      for (let i = 1; i < m; i++) if (aligned[i].c >= aligned[hiIdx].c) hiIdx = i;
      let belowCnt = 0;
      for (let i = hiIdx; i < m; i++) if (aligned[i].below) belowCnt++;
      wksBelow = belowCnt;
      // wksAbove = how many of the LAST 5 weekly closes were above the line (recency).
      let last5 = 0;
      for (let i = Math.max(0, m - 5); i < m; i++) if (!aligned[i].below) last5++;
      wksAbove = last5;
      // aboveRun = consecutive weeks above the line ending now — the "recently reclaimed" gate.
      if (!lastA.below) { aboveRun = 1; for (let i = m - 2; i >= 0; i--) { if (!aligned[i].below) aboveRun++; else break; } }
      else aboveRun = 0;
      reclaim = (aboveRun === 1);   // crossed above the line this (developing) week
    }

    rows.push({
      ticker, name: meta.name, sector: meta.sectorName,
      d52, dpk, wk, last: Math.round(cur * 100) / 100,
      dailyClose: Math.round(dailyClose * 100) / 100, high52: Math.round(high52 * 100) / 100,
      opema, opemaPeriod, light, side, wksBelow, wksAbove, aboveRun, reclaim, weekOf,
      volatile, deep: d52 >= K.DEEP,
      suspect: false, suspectReason: null,
    });
  }

  // ── Data-suspect flagging: pending splits + FMP scale cross-check ──
  const fmpSusp = fmpScaleSuspects(rows, quoteMap);
  for (const r of rows) {
    if (splitExcl.has(r.ticker)) { r.suspect = true; r.suspectReason = splitExcl.get(r.ticker); }
    else if (fmpSusp.has(r.ticker)) { r.suspect = true; r.suspectReason = fmpSusp.get(r.ticker); }
  }

  // ── Classify into boxes ──
  function classify(r) {
    if (r.suspect || r.opema == null) return null;
    if (!(r.d52 >= K.BEATEN && r.wksBelow >= K.BASEMIN)) return null;   // beaten + long base below the line since its high
    if (r.side === 'above') {
      // decisively above (>= LIGHT_BAND) AND crossed up recently (within RECLAIM_W weeks) = turned up
      if (r.light >= K.LIGHT_BAND) return (r.aboveRun != null && r.aboveRun <= K.RECLAIM_W) ? 'turned' : null;
      return 'line';                                                    // above but within the buffer = straddling
    }
    if (r.light >= -K.NEAR_BAND) return 'line';                         // still below but within NEAR_BAND
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
    live: Object.keys(quoteMap).length > 0,
    developingWeekOf: devMonday,
    weekEnding: weekOfToFriday(devMonday),
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
