// server/pnthrPounceEngine.js
// ── PNTHR POUNCE — the pullback (ambush) strategy, PAPER book ─────────────────
//
// Sister engine to pnthrTreeEngine.js. Tree buys NEW 42-week HIGHS (breakouts);
// POUNCE buys PULLBACKS to the weekly OpEMA (sector-optimized EMA) while the
// AI-300 index is above its 11-week trend (the regime gate). Everything else —
// NAV, risk-based sizing, the daily-2-week-low trailing stop, the 2× gross cap,
// exclusions, quotes — is REUSED verbatim from pnthrTreeEngine so the two engines
// can never disagree on the shared math.
//
// PHASE 1: PAPER ONLY. modes = 'off' | 'paper'. This file contains ZERO live-order
// code — it never touches the outbox/bridge. Live execution ('live' mode) is a
// deliberate later phase, wired separately with owner-tags + a shared gross budget.
//
// Isolated collections (nothing here can touch a pnthr_tree_* record):
//   pnthr_pounce_config     — { mode, lastTick, lastActions }
//   pnthr_pounce_positions  — the paper book (status ACTIVE|CLOSED)
//   pnthr_pounce_trades     — closed paper trades (P&L ledger)

import fs from 'fs';
import {
  getNavInfo, sizeFor, fetchQuotes, priorBands, engineExclusions,
  applyPriceSanity, AI_TICKERS, AI_META, MAX_GROSS_X, etDateStr,
} from './pnthrTreeEngine.js';
import { calculateEMA } from './signalDetection.js';
import { SECTOR_EMA_PERIODS } from './data/pnthrAiSectorsConfig.js';
import { SECTORS } from './scripts/aiUniverse/aiUniverseData.js';

const PCFG    = 'pnthr_pounce_config';
const PPOS    = 'pnthr_pounce_positions';
const PTRADES = 'pnthr_pounce_trades';
const PAUM    = 'pnthr_pounce_aum';       // daily actual-AUM series (paper equity) for the projection

// ── locked signal params (mirror the backtest champion: 2% band, 11W gate) ───
const NEAR_BAND = 0.02;   // "pounce" = price within 2% of the weekly OpEMA
const APPROACH  = 0.05;   // "approaching" = within 5% above the OpEMA (pulling back toward it)
const GATE_N    = 11;     // AI-300 index 11-week EMA regime gate
const BE_SNAP   = 250;    // breakeven snap: ≥ $250 open profit → stop to entry (same as Tree)
const RSI_FLOOR = 50;     // daily RSI-14 momentum floor — skip falling-knife dips (backtest-validated 2026-07-09)
const RSI_N     = 14;
const SIG_CACHE_MS = 5 * 60 * 1000;

// ticker → sector-id (for the OpEMA period), built once from the universe
const TK_SID = {};
for (const s of SECTORS) for (const h of s.holdings) if (TK_SID[h.ticker] == null) TK_SID[h.ticker] = s.id;

// ── ET session / trading-day gate (same discipline as the Tree tick) ─────────
function etMinutesNow() {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(new Date());
  const o = {}; for (const x of p) o[x.type] = x.value;
  let h = parseInt(o.hour, 10); if (h === 24) h = 0;
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[o.weekday];
  return { min: h * 60 + parseInt(o.minute, 10), weekday: dow };
}
function inCashSession() { const { min, weekday } = etMinutesNow(); return weekday >= 1 && weekday <= 5 && min >= 570 && min <= 960; }  // 9:30–16:00 ET, Mon–Fri

// ── Pounce signal: weekly OpEMA per name + the 11W index regime gate ─────────
let _sig = null;
async function pounceSignals(db) {
  if (_sig && (Date.now() - _sig.ts) < SIG_CACHE_MS) return _sig.data;
  const wdocs = await db.collection('pnthr_ai_bt_candles_weekly').find({}, { projection: { ticker: 1, weekly: 1 } }).toArray();
  const opema = {}, upTrend = {};
  for (const d of wdocs) {
    const t = (d.ticker || '').toUpperCase();
    const per = SECTOR_EMA_PERIODS[TK_SID[t]] || 30;
    const ws = (d.weekly || []).map(b => ({ time: b.weekOf || b.date, close: +b.close })).filter(b => b.time && b.close > 0).sort((a, b) => a.time < b.time ? -1 : 1);
    if (ws.length < per + 2) continue;
    const e = calculateEMA(ws, per);
    const last = e[e.length - 1]; if (!last) continue;
    opema[t] = last.value;
    upTrend[t] = ws[ws.length - 1].close > last.value;   // last completed week closed above its OpEMA = uptrend
  }
  // AI-300 index 11W EMA gate (green-up-week re-entry), current state
  let gateOn = true;
  try {
    const idx = await db.collection('pnthr_ai_index_candles_weekly').findOne({});
    const iw = (idx?.weekly || []).slice().sort((a, b) => (a.weekOf || '').localeCompare(b.weekOf || ''));
    if (iw.length >= GATE_N) {
      const C = iw.map(w => +w.close), O = iw.map(w => +w.open), k = 2 / (GATE_N + 1);
      const emaArr = new Array(C.length).fill(null); let p;
      for (let i = 0; i < C.length; i++) { if (i < GATE_N - 1) continue; if (i === GATE_N - 1) { let s = 0; for (let j = 0; j < GATE_N; j++) s += C[j]; p = s / GATE_N; } else p = C[i] * k + p * (1 - k); emaArr[i] = p; }
      let state = 'IN';
      for (let i = 0; i < C.length; i++) { if (state === 'IN') { if (emaArr[i] != null && C[i] < emaArr[i]) state = 'CASH'; } else if (C[i] > O[i]) state = 'IN'; }
      gateOn = state === 'IN';
    }
  } catch { /* gate defaults ON (never blocks on a data hiccup; entries have their own guards) */ }

  // daily RSI-14 (Wilder) per name — as of the last CLOSED daily bar (no look-ahead), the exact
  // definition validated in _pounce_rsi.mjs. Gates entries: RSI ≥ 50 = an orderly pullback (the edge);
  // RSI < 50 = a falling-knife dip (the drag). Sort ascending like priorBands — stored order isn't guaranteed.
  const rsi = {};
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const ddocs = await db.collection('pnthr_ai_bt_candles').find({}, { projection: { ticker: 1, daily: 1 } }).toArray();
  for (const d of ddocs) {
    const t = (d.ticker || '').toUpperCase();
    const closes = (d.daily || []).filter(b => b.date < today && +b.close > 0)
      .sort((a, b) => a.date.localeCompare(b.date)).map(b => +b.close);
    const r = wilderRSI(closes, RSI_N);
    const last = r.length ? r[r.length - 1] : null;
    if (last != null) rsi[t] = last;
  }

  const data = { opema, upTrend, gateOn, rsi };
  _sig = { data, ts: Date.now() };
  return data;
}
export function clearPounceSignalCache() { _sig = null; }

// Wilder RSI-14 — identical formula to the backtest harness (_pounce_rsi.mjs) so the live
// gate can never drift from the validated rule. out[i] = RSI as of close[i].
function wilderRSI(closes, n = RSI_N) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < n + 1) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
  let aG = g / n, aL = l / n;
  out[n] = aL === 0 ? 100 : 100 - 100 / (1 + aG / aL);
  for (let i = n + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1], gg = d > 0 ? d : 0, ll = d < 0 ? -d : 0; aG = (aG * (n - 1) + gg) / n; aL = (aL * (n - 1) + ll) / n; out[i] = aL === 0 ? 100 : 100 - 100 / (1 + aG / aL); }
  return out;
}

// classify a name's funnel state from its distance to the OpEMA + the gate + the RSI floor
function pounceState(price, opema, up, gateOn, rsi) {
  if (!(opema > 0) || !up) return 'stalking';
  const dist = (price - opema) / opema;
  if (Math.abs(dist) <= NEAR_BAND) return (gateOn && rsi >= RSI_FLOOR) ? 'pounce' : 'approaching';   // at the line, but gated / weak momentum → hold at approaching
  if (dist > 0 && dist <= APPROACH) return 'approaching';
  return 'stalking';
}

export async function getPnthrPounceConfig(db) {
  return (await db.collection(PCFG).findOne({})) || { mode: 'off' };
}
export async function setPnthrPounceMode(db, mode, actor = {}) {
  if (!['off', 'paper'].includes(mode)) throw new Error('bad mode (live not wired yet)');
  await db.collection(PCFG).updateOne({}, { $set: { mode, modeSetAt: new Date(), modeSetBy: actor.email || null } }, { upsert: true });
  return getPnthrPounceConfig(db);
}
export async function resetPnthrPouncePaper(db) {
  await db.collection(PPOS).deleteMany({ mode: 'paper' });
  await db.collection(PTRADES).deleteMany({});
  await db.collection(PAUM).deleteMany({});   // clear the actual-AUM series
  await db.collection(PCFG).updateOne({}, { $unset: { projectionStartDate: '', projectionStartAum: '' } });   // re-anchor the projection on next call
  return { reset: true };
}

// ── FORWARD PROJECTION — renders Pounce's OWN backtest baseline through the shared
// AumTracker/ForwardProjection (same shape as getPnthrTreeProjection). Paper equity =
// anchor AUM + cumulative paper P&L. Helpers duplicated from the Tree engine (module-private there).
const _pounceBaselinePath = new URL('./data/pounceProjectionBaseline.json', import.meta.url).pathname;
let _pounceBaseline;
function loadPounceBaseline() {
  if (!_pounceBaseline) {
    try { _pounceBaseline = JSON.parse(fs.readFileSync(_pounceBaselinePath, 'utf8')); }
    catch { _pounceBaseline = { factors: [], metrics: null, backtestStartNav: 100000, backtestEndNav: 0 }; }
  }
  return _pounceBaseline;
}
function weekdaysBetween(startISO, endISO) {
  if (!endISO || endISO <= startISO) return 0;
  const e = new Date(endISO + 'T12:00:00'); const d = new Date(startISO + 'T12:00:00');
  let n = 0; while (d < e) { d.setDate(d.getDate() + 1); const w = d.getDay(); if (w !== 0 && w !== 6) n++; } return n;
}
const FWD_WD_THRESHOLD = 2_000_000, FWD_WD_AMOUNT = 1_000_000;
const FWD_HORIZONS = [
  { label: '6 mo', years: 0.5, days: 126 }, { label: '1 yr', years: 1, days: 252 },
  { label: '18 mo', years: 1.5, days: 378 }, { label: '2 yr', years: 2, days: 504 },
  { label: '3 yr', years: 3, days: 756 }, { label: '5 yr', years: 5, days: 1260 },
  { label: '10 yr', years: 10, days: 2520 },
];
function simulateForward(startBalance, N, elapsed, dailyCagrRate, horizons) {
  const maxDays = horizons[horizons.length - 1].days;
  const byDay = new Map(horizons.map(h => [h.days, h]));
  let balance = startBalance, banked = 0; const snaps = {};
  for (let k = 1; k <= maxDays; k++) {
    if (balance >= FWD_WD_THRESHOLD) { balance -= FWD_WD_AMOUNT; banked += FWD_WD_AMOUNT; }
    if (dailyCagrRate > 0 && isFinite(dailyCagrRate)) balance *= dailyCagrRate;
    if (byDay.has(k)) snaps[k] = { balance: Math.round(balance), banked, total: Math.round(balance + banked), extrapolated: (elapsed + k) >= N };
  }
  return snaps;
}
export async function getPnthrPounceProjection(db, opts = {}) {
  const proj = loadPounceBaseline();
  const factors = proj.factors || [];
  const baseNav = opts.nav != null ? opts.nav : (await getNavInfo(db)).nav;
  const paperPnL = opts.paperPnL || 0;
  const todayISO = etDateStr();

  const cfg = (await db.collection(PCFG).findOne({})) || {};
  let startDate = cfg.projectionStartDate, startAum = cfg.projectionStartAum;
  if (!startDate || !startAum) {
    startDate = todayISO; startAum = baseNav;
    await db.collection(PCFG).updateOne({}, { $set: { projectionStartDate: startDate, projectionStartAum: startAum } }, { upsert: true });
  }
  const actualAum = +(startAum + paperPnL).toFixed(0);   // paper equity = anchor + cumulative paper P&L
  await db.collection(PAUM).updateOne({ date: todayISO }, { $set: { date: todayISO, actualAum } }, { upsert: true });
  const actualSeries = await db.collection(PAUM).find({}).sort({ date: 1 }).toArray();

  const N = factors.length;
  const cagrPct = proj.metrics?.cagrPct || 0;
  const dailyCagr = cagrPct > 0 ? Math.pow(1 + cagrPct / 100, 1 / 252) : 1;
  const dates = N ? [startDate] : [];
  { const d = new Date(startDate + 'T12:00:00'); for (let i = 1; i < N; i++) { do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6); dates.push(d.toISOString().split('T')[0]); } }
  const projected = dates.map((date, i) => ({ date, value: +(startAum * Math.pow(dailyCagr, i)).toFixed(0) }));
  const elapsed = Math.min(weekdaysBetween(startDate, todayISO), Math.max(0, N - 1));
  const actualProjected = projected.slice(elapsed).map((p, k) => ({ date: p.date, value: +(actualAum * Math.pow(dailyCagr, k)).toFixed(0) }));
  const projectedToday = +(startAum * Math.pow(dailyCagr, elapsed)).toFixed(0);
  const onTrackPct = projectedToday > 0 ? +(((actualAum / projectedToday) - 1) * 100).toFixed(1) : 0;
  let paceIdx = projected.findIndex(p => p.value >= actualAum);
  if (paceIdx < 0) paceIdx = projected.length - 1;
  const aheadOfSchedule = (projected.length && paceIdx >= 0) ? { date: projected[paceIdx].date, tradingDays: paceIdx - elapsed, ahead: (paceIdx - elapsed) >= 0 } : null;
  const projFwd = N ? simulateForward(projectedToday, N, elapsed, dailyCagr, FWD_HORIZONS) : {};
  const actFwd = N ? simulateForward(actualAum, N, elapsed, dailyCagr, FWD_HORIZONS) : {};
  const forward = {
    cagrPct,
    withdrawalRule: { threshold: FWD_WD_THRESHOLD, amount: FWD_WD_AMOUNT },
    horizons: FWD_HORIZONS.map(h => ({ label: h.label, years: h.years, days: h.days, projected: projFwd[h.days] || null, actual: actFwd[h.days] || null, extrapolated: (actFwd[h.days]?.extrapolated) || false })),
  };
  return {
    anchor: { startDate, startAum: +(+startAum).toFixed(0) },
    current: { date: todayISO, projectedAum: projectedToday, actualAum, onTrackPct, aheadOfSchedule },
    projected,
    actual: actualSeries.map(s => ({ date: s.date, value: s.actualAum })),
    actualProjected,
    forward,
    metrics: proj.metrics || null,
    metricsGross: proj.metricsGross || null,
    metricsNetFees: proj.metricsNetFees || null,
    cashLedger: null,   // paper book — no cash movements
    meta: {
      backtestStart: proj.backtestStart || null, backtestEnd: proj.backtestEnd || null,
      avgHoldDays: proj.avgHoldDays ?? null, medianHoldDays: proj.medianHoldDays ?? null,
      actualStart: actualSeries.length ? actualSeries[0].date : null,
      backtestEndNav: projected.length ? projected[projected.length - 1].value : proj.backtestEndNav,
      tradingDays: factors.length, basis: 'pure compounding (no withdrawals)', disclosure: proj.disclosure,
    },
  };
}

// ── Live snapshot the page polls: funnel + paper book (mirror of Tree's shape) ─
export async function getPnthrPounceState(db) {
  const cfg = await getPnthrPounceConfig(db);
  const navInfo = await getNavInfo(db); const nav = navInfo.nav;
  const excl = await engineExclusions(db);
  const sig = await pounceSignals(db);
  const [quotes, bands] = await Promise.all([fetchQuotes(AI_TICKERS), priorBands(db, AI_TICKERS, excl)]);
  for (const f of applyPriceSanity(quotes, bands)) excl.set(f.ticker, `live $${f.price} vs stored $${f.lastClose} — data re-sync pending`);
  const { lows, adv } = bands;

  let simRaw = [];
  if (cfg.mode === 'paper') {
    simRaw = (await db.collection(PPOS).find({ status: 'ACTIVE' }).toArray())
      .map(p => ({ ticker: p.ticker, shares: p.shares, avgCost: p.entryPrice, entryPrice: p.entryPrice, createdAt: p.createdAt, stop: p.stop, sim: true }));
  }
  const held = new Set(simRaw.map(p => p.ticker));

  const funnel = [];
  for (const t of AI_TICKERS) {
    const q = quotes[t]; if (!q) continue;
    const price = +q.price; if (!(price > 0)) continue;
    const opema = sig.opema[t] || null;
    const state = pounceState(price, opema, sig.upTrend[t], sig.gateOn, sig.rsi[t]);
    const stop = lows[t] ? +(lows[t] - 0.01).toFixed(2) : null;
    const sz = stop ? sizeFor(nav, price, stop) : { shares: 0, risk: 0 };
    funnel.push({
      ticker: t, sector: AI_META[t]?.sector || null, company: AI_META[t]?.name || null,
      price, opema, pctToEma: opema ? +(((price - opema) / opema) * 100).toFixed(2) : null,
      rsi: sig.rsi[t] != null ? +sig.rsi[t].toFixed(0) : null,
      changePct: +q.changesPercentage || 0, state, held: held.has(t), gateOn: sig.gateOn,
      stop, shares: sz.shares, risk: sz.risk, posValue: +(sz.shares * price).toFixed(0),
      adv: adv[t] ?? null, manual: excl.has(t) || !AI_META[t], note: excl.get(t) || null,
    });
  }
  // closest to the OpEMA (about to pounce) first; extended names + no-data last
  funnel.sort((a, b) => (Math.abs(a.pctToEma ?? 999)) - (Math.abs(b.pctToEma ?? 999)));

  const positions = simRaw;
  const enrich = (p) => {
    const q = quotes[p.ticker]; const basis = p.avgCost || p.entryPrice || 0;
    const last = q ? +q.price : basis; p.last = last;
    const eng = lows[p.ticker] ? +(lows[p.ticker] - 0.01).toFixed(2) : 0;
    const eff = Math.max(eng, p.stop || 0);
    p.stop = eff > 0 ? +eff.toFixed(2) : (p.stop || null);
    p.pnl = +(((last - basis) * (p.shares || 0))).toFixed(0);
    p.pnlPct = basis ? +((last / basis - 1) * 100).toFixed(1) : 0;
    p.protected = p.stop != null && basis > 0 && p.stop >= basis;     // stop at/above entry → locked
    const shx = p.shares || 0;
    p.riskNow = (p.stop != null && last > p.stop) ? Math.round((last - p.stop) * shx) : 0;
    p.riskPct = nav > 0 ? +((p.riskNow / nav) * 100).toFixed(2) : 0;
    p.company = AI_META[p.ticker]?.name || null;
    p.sector = AI_META[p.ticker]?.sector || null;
    p.rsi = sig.rsi[p.ticker] != null ? +sig.rsi[p.ticker].toFixed(0) : null;   // current daily RSI-14 (live momentum read)
  };
  positions.forEach(enrich);

  // recently stopped — closed paper trades in the last 24h (red cards, like Tree)
  let recentStops = [];
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    recentStops = (await db.collection(PTRADES).find({ exitAt: { $gte: since } }).sort({ exitAt: -1 }).toArray())
      .map(t => ({ ticker: t.ticker, shares: t.shares, entryPrice: t.entryPrice, exitPrice: t.exitPrice, pnl: t.pnl, reason: t.reason || 'STOP', exitAt: t.exitAt, company: AI_META[t.ticker]?.name || null, sector: AI_META[t.ticker]?.sector || null }));
  } catch { /* non-fatal */ }

  // forward projection — Pounce's OWN baseline; paper equity = anchor + cumulative paper P&L
  let projection = null;
  try {
    const cl = await db.collection(PTRADES).find({}, { projection: { pnl: 1 } }).toArray();
    const realizedPnL = cl.reduce((a, t) => a + (t.pnl || 0), 0);
    const openPnL = positions.reduce((a, p) => a + (p.pnl || 0), 0);
    projection = await getPnthrPounceProjection(db, { nav, paperPnL: realizedPnL + openPnL });
  } catch { /* projection is non-critical to the funnel */ }

  return {
    strategy: 'pounce', mode: cfg.mode || 'off', nav, navSource: navInfo.source, navTrusted: navInfo.trusted,
    gateOn: sig.gateOn, funnel, positions, recentStops, manualTrades: [], projection, lastTick: cfg.lastTick || null,
    generatedAt: new Date().toISOString(),
  };
}

// ── PAPER tick: simulate entries on a pounce, manage the trailing stop, exit ──
// PAPER ONLY. No orders leave this process. Reuses Tree's NAV/sizing/quote/stop
// helpers so a paper Pounce fill is sized/stopped exactly as a Tree fill would be.
export async function runPnthrPounceTick(db) {
  const cfg = await getPnthrPounceConfig(db);
  if (!cfg.mode || cfg.mode === 'off') return { mode: 'off', actions: [] };
  if (cfg.mode !== 'paper') return { mode: cfg.mode, actions: [{ type: 'LIVE_NOT_WIRED' }] };   // Phase 5

  const navInfo = await getNavInfo(db);
  if (!navInfo.trusted) {   // never size off a fabricated NAV (same guard as Tree)
    await db.collection(PCFG).updateOne({}, { $set: { lastTick: new Date(), lastActions: [{ type: 'NAV_UNTRUSTED_SKIP', source: navInfo.source }] } }, { upsert: true });
    return { mode: 'paper', actions: [{ type: 'NAV_UNTRUSTED_SKIP', source: navInfo.source }] };
  }
  const nav = navInfo.nav;
  const excl = await engineExclusions(db);
  const sig = await pounceSignals(db);
  const [quotes, bands] = await Promise.all([fetchQuotes(AI_TICKERS), priorBands(db, AI_TICKERS, excl)]);
  for (const f of applyPriceSanity(quotes, bands)) excl.set(f.ticker, 'price/data mismatch');
  const { lows } = bands;
  const actions = [];

  const active = await db.collection(PPOS).find({ status: 'ACTIVE' }).toArray();
  const held = new Set(active.map(p => p.ticker));
  let gross = 0; for (const p of active) gross += (p.shares || 0) * (+quotes[p.ticker]?.price || p.entryPrice || 0);
  const grossCap = MAX_GROSS_X * nav;

  // 1) MANAGE / EXIT held paper positions (runs every tick, any hour — raise-only)
  for (const p of active) {
    const q = quotes[p.ticker]; const price = q ? +q.price : 0; if (!(price > 0)) continue;
    let stop = p.stop;
    const eng = lows[p.ticker] ? +(lows[p.ticker] - 0.01).toFixed(2) : null;
    if (eng != null) stop = stop == null ? eng : Math.max(stop, eng);                 // 2-week-low trail, up-only
    if (price >= p.entryPrice && (price - p.entryPrice) * p.shares >= BE_SNAP) stop = Math.max(stop || 0, +p.entryPrice.toFixed(2));  // breakeven snap
    if (stop != null && +stop.toFixed(2) !== (p.stop == null ? null : +p.stop.toFixed(2))) await db.collection(PPOS).updateOne({ _id: p._id }, { $set: { stop: +stop.toFixed(2) } });
    if (stop != null && price <= stop) {   // stopped out
      const exit = +stop.toFixed(2), pnl = +(((exit - p.entryPrice) * p.shares)).toFixed(2);
      await db.collection(PPOS).updateOne({ _id: p._id }, { $set: { status: 'CLOSED', exitPrice: exit, exitAt: new Date(), pnl } });
      await db.collection(PTRADES).insertOne({ ticker: p.ticker, shares: p.shares, entryPrice: p.entryPrice, exitPrice: exit, pnl, entryAt: p.createdAt, exitAt: new Date(), reason: 'STOP' });
      held.delete(p.ticker); gross -= p.shares * price;
      actions.push({ type: 'PAPER_EXIT', ticker: p.ticker, pnl });
    }
  }

  // 2) ENTRIES — pounce triggers, only in-session and only when the regime gate is ON
  if (inCashSession() && sig.gateOn) {
    const cands = [];
    for (const t of AI_TICKERS) {
      if (held.has(t) || excl.has(t)) continue;
      const q = quotes[t]; if (!q) continue;
      const price = +q.price, opema = sig.opema[t];
      if (!(price > 0) || !(opema > 0) || !sig.upTrend[t]) continue;
      if (Math.abs((price - opema) / opema) > NEAR_BAND) continue;              // not at the line
      if (!(sig.rsi[t] >= RSI_FLOOR)) continue;                                 // RSI floor — skip falling-knife dips (backtest-validated RSI≥50)
      const stop = lows[t] ? +(lows[t] - 0.01).toFixed(2) : null;
      if (!stop || stop >= price) continue;
      const { shares } = sizeFor(nav, price, stop);
      if (shares < 1) continue;
      cands.push({ t, price, stop, shares, adv: bands.adv[t] ?? 0 });
    }
    cands.sort((a, b) => (b.adv - a.adv) || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));   // most-liquid first (same priority as Tree)
    for (const c of cands) {
      if (gross + c.shares * c.price > grossCap) { actions.push({ type: 'CAP_SKIP', ticker: c.t }); continue; }
      await db.collection(PPOS).insertOne({ ticker: c.t, shares: c.shares, entryPrice: c.price, stop: c.stop, status: 'ACTIVE', mode: 'paper', createdAt: new Date() });
      held.add(c.t); gross += c.shares * c.price;
      actions.push({ type: 'PAPER_ENTRY', ticker: c.t, shares: c.shares, price: c.price, stop: c.stop });
    }
  }

  await db.collection(PCFG).updateOne({}, { $set: { lastTick: new Date(), lastActions: actions } }, { upsert: true });
  return { mode: 'paper', actions };
}
