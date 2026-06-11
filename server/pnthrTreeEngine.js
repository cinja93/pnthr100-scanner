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

// 2-week lowest-low per ticker (the trailing stop reference), from the daily backtest candles.
async function twoWeekLows(db, tickers) {
  const out = {};
  const docs = await db.collection('pnthr_ai_bt_candles').find({ ticker: { $in: tickers } }).toArray();
  for (const d of docs) {
    const bars = (d.daily || []).filter(b => +b.low > 0).sort((a, b) => a.date.localeCompare(b.date)).slice(-STOP_LOOKBACK);
    if (bars.length) out[d.ticker] = Math.min(...bars.map(b => +b.low));
  }
  return out;
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
  const [quotes, lows] = await Promise.all([fetchQuotes(AI_TICKERS), twoWeekLows(db, AI_TICKERS)]);

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
    const price = +q.price, dayHigh = +q.dayHigh, yearHigh = +q.yearHigh;
    if (!(price > 0) || !(yearHigh > 0)) continue;
    let state = 'stalking';
    if (dayHigh >= yearHigh) state = 'attack';
    else if (price >= yearHigh * (1 - APPROACH_PCT)) state = 'approaching';
    const stop = lows[t] ? +(lows[t] - 0.01).toFixed(2) : null;
    const sz = stop ? sizeFor(nav, price, stop) : { shares: 0, rps: 0, risk: 0 };
    funnel.push({
      ticker: t, sector: AI_META[t]?.sector, price, yearHigh,
      pctToHigh: +(((yearHigh - price) / yearHigh) * 100).toFixed(2),
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
  return { mode: cfg.mode, nav, funnel, positions, counts, updatedAt: new Date().toISOString() };
}

// ── Engine tick — paper records / live places orders on new 52wk highs ───────
export async function runPnthrTreeTick(db) {
  const cfg = await getPnthrTreeConfig(db);
  if (!cfg.mode || cfg.mode === 'off') return { mode: 'off', actions: [] };
  const nav = await getNav(db);
  const [quotes, lows] = await Promise.all([fetchQuotes(AI_TICKERS), twoWeekLows(db, AI_TICKERS)]);
  const actions = [];

  // held set (paper or live)
  const held = new Set();
  if (cfg.mode === 'live') {
    const snap = (await db.collection('pnthr_ibkr_positions').find({}).sort({ syncedAt: -1 }).limit(1).toArray())[0] || {};
    for (const p of (snap.positions || [])) { const t = (p.ticker || p.symbol || '').toUpperCase(); if ((p.position ?? p.shares) !== 0) held.add(t); }
  } else {
    for (const p of await db.collection(POS).find({ status: 'ACTIVE' }).toArray()) held.add(p.ticker);
  }

  // 1) ENTRIES — any AI-300 name at a NEW intraday 52wk high we don't already hold
  for (const t of AI_TICKERS) {
    if (held.has(t)) continue;
    const q = quotes[t]; if (!q) continue;
    const price = +q.price, dayHigh = +q.dayHigh, yearHigh = +q.yearHigh;
    if (!(price > 0) || !(yearHigh > 0) || dayHigh < yearHigh) continue;   // not a new high
    const stop = lows[t] ? +(lows[t] - 0.01).toFixed(2) : null;
    const { shares } = stop ? sizeFor(nav, price, stop) : { shares: 0 };
    if (!stop || shares < 1) continue;

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
  // (live: the broker-resting stops handle exits; a weekly stop-raise sweep is the next layer)

  await db.collection(CFG).updateOne({}, { $set: { lastTick: new Date(), lastActions: actions.slice(0, 50) } }, { upsert: true });
  return { mode: cfg.mode, actions };
}

// ── Reset paper book ─────────────────────────────────────────────────────────
export async function resetPnthrTreePaper(db) {
  const a = await db.collection(POS).deleteMany({ mode: 'paper' });
  const b = await db.collection(TRADES).deleteMany({ mode: 'paper' });
  return { positions: a.deletedCount, trades: b.deletedCount };
}
