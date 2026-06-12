// server/pnthrTreeEngine.js
// ── PNTHR TREE — 52-week-high momentum engine ───────────────────────────────
// Strategy (Scott 2026-06-11): AI-300, LONG-only. Enter FULL SIZE the moment a name
// makes a NEW INTRADAY 52-week high (no pyramid — tested best). Stop = 2-week lowest-low,
// trailed up. Risk-based sizing (2% NAV/name, capped 10% NAV/name).
//
// Modes:  'off'  — nothing fires (default)
//         'paper'— records to pnthr_tree_positions, NO real orders (safe)
//         'live' — places real orders via the BRIDGE (reuses Ambush's tested order queue)
//
// SAFETY: must OWN AI-300 alone — Ambush + Elite must be OFF (one auto-engine per account,
// or you get the AVGO cross-engine contamination). Live mode requires the bridge up.

import fs from 'fs';
import { fetchFMP } from './stockService.js';
import { getUserProfile } from './database.js';
import { SECTORS as AI_SECTORS } from './scripts/aiUniverse/aiUniverseData.js';
import { enqueueAmbushOrder } from './ambush/ambushStateManager.js';

const CFG    = 'pnthr_tree_config';
const POS    = 'pnthr_tree_positions';
const TRADES = 'pnthr_tree_trades';

const VITALITY_PCT   = 0.02;   // risk budget per name
const TICKER_CAP_PCT = 0.10;   // max position value per name
const APPROACH_PCT   = 0.01;   // within 1% of the 52wk high → "approaching" (flashing)
const STOP_LOOKBACK  = 10;     // 2 trading weeks
const LOOKBACK_52W   = 252;    // 52-week high lookback (PRIOR bars, excludes today)
const MAX_GROSS_X    = 2.0;    // gross leverage cap: total long exposure ≤ 2× NAV (Scott 2026-06-11).
                               // WITHOUT this the per-name 2%/10% sizing piles to 4-10× in a broad rally
                               // (backtest: 72%+ drawdown). 2× cap → ~106% CAGR / 55% DD (daily-stop, hypothetical).

const AI_META = {};
const AI_TICKERS = (() => {
  const out = [];
  for (const s of AI_SECTORS) for (const h of s.holdings) { out.push(h.ticker); AI_META[h.ticker] = { sector: s.name }; }
  return [...new Set(out)];
})();

// ── NAV (same source the Ambush/Elite pages use) ────────────────────────────
async function getNav(db) {
  let nav = 80200;
  try {
    const cfg = await db.collection('pnthr_ambush_config').findOne({});
    if (cfg?.nav > 0) nav = cfg.nav;
    if (cfg?.ownerId) { const p = await getUserProfile(cfg.ownerId); if (p?.accountSize > 0) nav = p.accountSize; }
    const tcfg = await db.collection(CFG).findOne({});
    if (tcfg?.navOverride > 0) nav = tcfg.navOverride;   // page can set an explicit NAV
  } catch { /* default */ }
  return nav;
}

async function fetchQuotes(tickers) {
  const map = {};
  for (let i = 0; i < tickers.length; i += 200) {
    const chunk = tickers.slice(i, i + 200);
    const quotes = await fetchFMP(`/quote/${chunk.join(',')}`).catch(() => null);
    if (Array.isArray(quotes)) for (const q of quotes) if (q && q.symbol) map[q.symbol] = q;
  }
  return map;
}

// Prior-bar bands from the daily backtest candles, EXCLUDING today's forming bar:
//   highs[t] = max high of the prior ≤252 bars  → the real 52-week high to break (the
//              ATTACK trigger). NOT FMP's `yearHigh` field — that already absorbs today's
//              intraday move, so a fresh breakout never registers (it stays "approaching").
//   lows[t]  = min low of the prior ≤10 bars    → the 2-week trailing-stop reference.
// Excluding today makes the live trigger identical to the backtest (prior-bars-only).
async function priorBands(db, tickers) {
  const today = etDateStr();
  const highs = {}, lows = {};
  const docs = await db.collection('pnthr_ai_bt_candles').find({ ticker: { $in: tickers } }).toArray();
  for (const d of docs) {
    const bars = (d.daily || []).filter(b => b.date < today && +b.high > 0 && +b.low > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!bars.length) continue;
    const hi = bars.slice(-LOOKBACK_52W), lo = bars.slice(-STOP_LOOKBACK);
    if (hi.length) highs[d.ticker] = Math.max(...hi.map(b => +b.high));
    if (lo.length) lows[d.ticker] = Math.min(...lo.map(b => +b.low));
  }
  return { highs, lows };
}

function sizeFor(nav, price, stop) {
  if (!(stop > 0) || !(price > stop)) return { shares: 0, rps: 0, risk: 0 };
  const rps = price - stop;
  const shares = Math.min(Math.floor(nav * VITALITY_PCT / rps), Math.floor(nav * TICKER_CAP_PCT / price));
  return { shares: Math.max(0, shares), rps: +rps.toFixed(2), risk: +(shares * rps).toFixed(0) };
}

// ── Config / mode ───────────────────────────────────────────────────────────
export async function getPnthrTreeConfig(db) {
  return (await db.collection(CFG).findOne({})) || { mode: 'off' };
}
export async function setPnthrTreeMode(db, mode) {
  if (!['off', 'paper', 'live'].includes(mode)) throw new Error('bad mode');
  await db.collection(CFG).updateOne({}, { $set: { mode, modeSetAt: new Date() } }, { upsert: true });
  return { mode };
}

// ── Live snapshot the page polls: funnel + sizing/stops + positions ──────────
export async function getPnthrTreeState(db) {
  const cfg = await getPnthrTreeConfig(db);
  const nav = await getNav(db);
  const [quotes, bands] = await Promise.all([fetchQuotes(AI_TICKERS), priorBands(db, AI_TICKERS)]);
  const { highs, lows } = bands;

  const held = new Set();
  let positions = [];
  if (cfg.mode === 'live') {
    const snap = (await db.collection('pnthr_ibkr_positions').find({}).sort({ syncedAt: -1 }).limit(1).toArray())[0] || {};
    positions = (snap.positions || [])
      .filter(p => { const t = (p.ticker || p.symbol || '').toUpperCase(); return AI_META[t] && (p.position ?? p.shares) > 0; })
      .map(p => ({ ticker: (p.ticker || p.symbol).toUpperCase(), shares: p.position ?? p.shares, avgCost: p.avgCost ?? p.avgPrice, live: true }));
  } else {
    positions = await db.collection(POS).find({ status: 'ACTIVE' }).toArray();
  }
  positions.forEach(p => held.add(p.ticker));

  const funnel = [];
  for (const t of AI_TICKERS) {
    const q = quotes[t]; if (!q) continue;
    const price = +q.price, dayHigh = +q.dayHigh || +q.price;
    const priorHigh = highs[t];   // real prior 52wk high (excl today) — see priorBands
    if (!(price > 0) || !(priorHigh > 0)) continue;
    let state = 'stalking';
    if (dayHigh >= priorHigh + 0.01) state = 'attack';                 // broke the prior 52wk high today
    else if (price >= priorHigh * (1 - APPROACH_PCT)) state = 'approaching';
    const stop = lows[t] ? +(lows[t] - 0.01).toFixed(2) : null;
    const sz = stop ? sizeFor(nav, price, stop) : { shares: 0, rps: 0, risk: 0 };
    funnel.push({
      ticker: t, sector: AI_META[t]?.sector, price, priorHigh,
      pctToHigh: +(((priorHigh - price) / priorHigh) * 100).toFixed(2),
      changePct: +q.changesPercentage || 0, state, held: held.has(t),
      stop, shares: sz.shares, risk: sz.risk, posValue: +(sz.shares * price).toFixed(0),
    });
  }
  funnel.sort((a, b) => a.pctToHigh - b.pctToHigh);   // closest to a new high first

  // enrich positions with the live stop + P&L
  for (const p of positions) {
    const q = quotes[p.ticker]; const last = q ? +q.price : p.avgCost;
    p.last = last; p.stop = lows[p.ticker] ? +(lows[p.ticker] - 0.01).toFixed(2) : (p.stop || null);
    p.pnl = +(((last - (p.avgCost || p.entryPrice)) * (p.shares || p.totalShares || 0))).toFixed(0);
    p.pnlPct = +((last / (p.avgCost || p.entryPrice) - 1) * 100).toFixed(1);
  }

  const counts = funnel.reduce((a, f) => { a[f.state] = (a[f.state] || 0) + 1; return a; }, {});
  const grossUsed = positions.reduce((a, p) => a + (p.last || 0) * (p.shares || p.totalShares || 0), 0);
  return {
    mode: cfg.mode, nav, funnel, positions, counts,
    grossUsed: +grossUsed.toFixed(0), grossX: +(grossUsed / (nav || 1)).toFixed(2), grossCapX: MAX_GROSS_X,
    updatedAt: new Date().toISOString(),
  };
}

// ── Engine tick — paper records / live places orders on new 52wk highs ───────
export async function runPnthrTreeTick(db) {
  const cfg = await getPnthrTreeConfig(db);
  if (!cfg.mode || cfg.mode === 'off') return { mode: 'off', actions: [] };
  const nav = await getNav(db);
  const [quotes, bands] = await Promise.all([fetchQuotes(AI_TICKERS), priorBands(db, AI_TICKERS)]);
  const { highs, lows } = bands;
  const actions = [];

  // held set + current GROSS exposure (for the 2× leverage cap)
  const held = new Set();
  let gross = 0;
  if (cfg.mode === 'live') {
    const snap = (await db.collection('pnthr_ibkr_positions').find({}).sort({ syncedAt: -1 }).limit(1).toArray())[0] || {};
    for (const p of (snap.positions || [])) {
      const t = (p.ticker || p.symbol || '').toUpperCase(); const sh = p.position ?? p.shares;
      if (sh !== 0) { held.add(t); gross += Math.abs(sh) * (+quotes[t]?.price || p.avgCost || p.avgPrice || 0); }
    }
  } else {
    for (const p of await db.collection(POS).find({ status: 'ACTIVE' }).toArray()) {
      held.add(p.ticker); gross += (p.totalShares || p.shares || 0) * (+quotes[p.ticker]?.price || p.entryPrice || p.avgCost || 0);
    }
  }
  const grossCap = MAX_GROSS_X * nav;

  // 1) ENTRIES — any AI-300 name at a NEW intraday 52wk high we don't already hold
  for (const t of AI_TICKERS) {
    if (held.has(t)) continue;
    const q = quotes[t]; if (!q) continue;
    const price = +q.price, dayHigh = +q.dayHigh || +q.price;
    const priorHigh = highs[t];   // real prior 52wk high (excl today)
    if (!(price > 0) || !(priorHigh > 0) || dayHigh < priorHigh + 0.01) continue;   // not a new 52wk high
    const stop = lows[t] ? +(lows[t] - 0.01).toFixed(2) : null;
    const { shares } = stop ? sizeFor(nav, price, stop) : { shares: 0 };
    if (!stop || shares < 1) continue;
    if (gross + shares * price > grossCap) {                              // 2× gross leverage cap
      actions.push({ type: 'SKIP_GROSS_CAP', ticker: t, grossX: +(gross / nav).toFixed(2) });
      continue;
    }
    gross += shares * price;   // reserve the exposure so the cap holds across this tick's entries

    if (cfg.mode === 'paper') {
      await db.collection(POS).insertOne({
        ticker: t, direction: 'LONG', entryPrice: price, avgCost: price, totalShares: shares, shares,
        stop, status: 'ACTIVE', mode: 'paper', source: 'TREE_52WH', entryDate: new Date().toISOString().slice(0, 10), createdAt: new Date(),
      });
      actions.push({ type: 'PAPER_ENTRY', ticker: t, shares, price, stop });
    } else if (cfg.mode === 'live') {
      // Bridge BUY_ENTRY places the market buy AND the protective stop in one command (Ambush shape).
      // Requires the bridge running + draining the outbox, and the Ambush engine OFF (no reconcile contention).
      await enqueueAmbushOrder(db, 'BUY_ENTRY', { ticker: t, shares, price, direction: 'LONG', stopPrice: stop, source: 'TREE_52WH' });
      actions.push({ type: 'LIVE_ENTRY_ENQUEUED', ticker: t, shares, price, stop });
    }
  }

  // 2) MANAGE — trail the 2-week stop; paper exits on stop (live stops rest at the broker)
  if (cfg.mode === 'paper') {
    for (const p of await db.collection(POS).find({ status: 'ACTIVE' }).toArray()) {
      const q = quotes[p.ticker]; if (!q) continue;
      const price = +q.price, dayLow = +q.dayLow || price;
      const newStop = lows[p.ticker] ? +(lows[p.ticker] - 0.01).toFixed(2) : p.stop;
      const trailed = Math.max(p.stop || 0, newStop || 0);
      if (trailed !== p.stop) await db.collection(POS).updateOne({ _id: p._id }, { $set: { stop: trailed } });
      if (dayLow <= trailed) {
        const exitPx = trailed;
        const pnl = +((exitPx - p.avgCost) * p.totalShares).toFixed(2);
        await db.collection(POS).updateOne({ _id: p._id }, { $set: { status: 'CLOSED', exitPrice: exitPx, exitDate: new Date().toISOString().slice(0, 10), pnl, closedAt: new Date() } });
        await db.collection(TRADES).insertOne({ ticker: p.ticker, direction: 'LONG', entryPrice: p.entryPrice, exitPrice: exitPx, shares: p.totalShares, pnl, exitReason: 'STOP', mode: 'paper', entryDate: p.entryDate, exitDate: new Date().toISOString().slice(0, 10), createdAt: new Date() });
        actions.push({ type: 'PAPER_EXIT', ticker: p.ticker, exitPx, pnl });
      }
    }
  }
  // LIVE manage: trail each held position's stop UP to its current 2-week low (broker-resting stop fires the exit)
  if (cfg.mode === 'live') {
    const snap = (await db.collection('pnthr_ibkr_positions').find({}).sort({ syncedAt: -1 }).limit(1).toArray())[0] || {};
    for (const p of (snap.positions || [])) {
      const t = (p.ticker || p.symbol || '').toUpperCase(); const sh = p.position ?? p.shares;
      if (!AI_META[t] || !(sh > 0)) continue;
      const newStop = lows[t] ? +(lows[t] - 0.01).toFixed(2) : null; if (!newStop) continue;
      const cur = (snap.stopOrders || []).filter(o => (o.symbol || o.ticker || '').toUpperCase() === t && (o.action || '').toUpperCase() === 'SELL').reduce((m, o) => Math.max(m, +o.stopPrice || 0), 0);
      if (newStop > cur + 0.01) {
        await enqueueAmbushOrder(db, 'MODIFY_STOP', { ticker: t, direction: 'LONG', newStopPrice: newStop, shares: sh, reason: 'TREE_TRAIL' });
        actions.push({ type: 'LIVE_TRAIL', ticker: t, newStop, from: cur });
      }
    }
  }

  await db.collection(CFG).updateOne({}, { $set: { lastTick: new Date(), lastActions: actions.slice(0, 50) } }, { upsert: true });
  return { mode: cfg.mode, actions };
}

// ── Reset paper book ─────────────────────────────────────────────────────────
export async function resetPnthrTreePaper(db) {
  const a = await db.collection(POS).deleteMany({ mode: 'paper' });
  const b = await db.collection(TRADES).deleteMany({ mode: 'paper' });
  return { positions: a.deletedCount, trades: b.deletedCount };
}

// ── Projected vs Actual AUM (Tree's OWN backtest baseline, NOT Ambush's) ──────
// Mirrors the Ambush projection so the shared AumTracker panel renders Tree's
// real numbers. Baseline = server/data/treeProjectionBaseline.json (build_tree_baseline.mjs).
const _treeBaselinePath = new URL('./data/treeProjectionBaseline.json', import.meta.url).pathname;
let _treeBaseline = null;
function loadTreeBaseline() {
  if (!_treeBaseline) {
    try { _treeBaseline = JSON.parse(fs.readFileSync(_treeBaselinePath, 'utf8')); }
    catch { _treeBaseline = { factors: [], metrics: null, backtestStartNav: 100000, backtestEndNav: 0 }; }
  }
  return _treeBaseline;
}
function etDateStr(d = new Date()) {
  const p = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) p[type] = value;
  return `${p.year}-${p.month}-${p.day}`;
}
function weekdaysBetween(startISO, endISO) {
  if (!endISO || endISO <= startISO) return 0;
  const e = new Date(endISO + 'T12:00:00'); const d = new Date(startISO + 'T12:00:00');
  let n = 0;
  while (d < e) { d.setDate(d.getDate() + 1); const w = d.getDay(); if (w !== 0 && w !== 6) n++; }
  return n;
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

export async function getPnthrTreeProjection(db) {
  const proj = loadTreeBaseline();
  const factors = proj.factors || [];
  const nav = await getNav(db);
  const todayISO = etDateStr();

  // anchor: lock the projection start (date + AUM) on first call
  const cfg = await getPnthrTreeConfig(db);
  let startDate = cfg.projectionStartDate, startAum = cfg.projectionStartAum;
  if (!startDate || !startAum) {
    startDate = todayISO; startAum = nav;
    await db.collection(CFG).updateOne({}, { $set: { projectionStartDate: startDate, projectionStartAum: startAum } }, { upsert: true });
  }

  // record today's actual NAV, then read the actual series
  await db.collection('pnthr_tree_aum').updateOne({ date: todayISO }, { $set: { date: todayISO, actualAum: nav } }, { upsert: true });
  const actualSeries = await db.collection('pnthr_tree_aum').find({}).sort({ date: 1 }).toArray();

  // projected curve = baseline factor × anchor AUM, mapped to weekday dates
  const N = factors.length;
  const dates = N ? [startDate] : [];
  { const d = new Date(startDate + 'T12:00:00'); for (let i = 1; i < N; i++) { do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6); dates.push(d.toISOString().split('T')[0]); } }
  const projected = factors.map((f, i) => ({ date: dates[i], value: +(startAum * f.factor).toFixed(0) }));

  const elapsed = Math.min(weekdaysBetween(startDate, todayISO), Math.max(0, N - 1));
  const projectedToday = +(startAum * (factors[elapsed]?.factor || 1)).toFixed(0);
  const onTrackPct = projectedToday > 0 ? +(((nav / projectedToday) - 1) * 100).toFixed(1) : 0;

  const cagrPct = proj.metrics?.cagrPct || 0;
  const dailyCagr = cagrPct > 0 ? Math.pow(1 + cagrPct / 100, 1 / 252) : 1;
  const projFwd = N ? simulateForward(projectedToday, N, elapsed, dailyCagr, FWD_HORIZONS) : {};
  const actFwd = N ? simulateForward(nav, N, elapsed, dailyCagr, FWD_HORIZONS) : {};
  const forward = {
    cagrPct,
    withdrawalRule: { threshold: FWD_WD_THRESHOLD, amount: FWD_WD_AMOUNT },
    horizons: FWD_HORIZONS.map(h => ({ label: h.label, years: h.years, days: h.days, projected: projFwd[h.days] || null, actual: actFwd[h.days] || null, extrapolated: (actFwd[h.days]?.extrapolated) || false })),
  };

  return {
    anchor: { startDate, startAum: +(+startAum).toFixed(0) },
    current: { date: todayISO, projectedAum: projectedToday, actualAum: +(+nav).toFixed(0), onTrackPct },
    projected,
    actual: actualSeries.map(s => ({ date: s.date, value: s.actualAum })),
    forward,
    metrics: proj.metrics || null,
    meta: { backtestEndNav: proj.backtestEndNav, tradingDays: factors.length, basis: 'pure compounding (no withdrawals)', disclosure: proj.disclosure },
  };
}
