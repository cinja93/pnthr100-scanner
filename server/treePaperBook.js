// server/treePaperBook.js
// ── PNTHR TREE — per-member PAPER book ───────────────────────────────────────
// A fully independent, PAPER-ONLY PNTHR Tree for a non-admin member (e.g. Brennan,
// $50k). It runs the EXACT SAME strategy as the live (house) Tree — 42-week-high
// entries, 2-week-low trailing stop, $250 breakeven snap, 2× gross cap, 2%/10%
// risk sizing — by importing the engine's SHARED signal primitives, so the paper
// book can never drift from the real strategy. It keeps its OWN book in
// owner-scoped collections (suffixed by userId) and NEVER reads the real IBKR
// account, never places an order. Admins (Scott) are routed to the original
// house functions in pnthrTreeEngine.js; members are routed here (see index.js).
//
// NAV = the member's account size (base capital, default $50k) marked-to-market
// by the book's OWN realized (closed paper trades) + unrealized (open paper
// positions) P&L — so the Actual-AUM line tracks the paper book's performance
// from its $50k start, and sizing compounds with it. Later, if the member
// connects a brokerage, this book can be upgraded to live "green" trades.

import {
  AI_TICKERS, AI_META, sizeFor, priorBands, fetchQuotes, engineExclusions,
  applyPriceSanity, fetchGreenHourMap, etDateStr, getPnthrTreeProjection,
  APPROACH_PCT, MAX_GROSS_X, BE_SNAP_PROFIT,
} from './pnthrTreeEngine.js';
import { getUserProfile } from './database.js';

const BOOKS = 'pnthr_tree_books';     // registry of paper books: { ownerId, label, createdAt }
const DEFAULT_CAPITAL = 50000;

// Owner-scoped collection names. Each member's paper book lives entirely in its
// own suffixed collections, so it can never collide with the house book or another
// member's book (findOne({}) within a suffixed collection only ever sees that book).
const C = (ownerId) => ({
  POS:    `pnthr_tree_positions__${ownerId}`,
  TRADES: `pnthr_tree_trades__${ownerId}`,
  EXITS:  `pnthr_tree_exits__${ownerId}`,
  ATTACK: `pnthr_tree_attack_seen__${ownerId}`,
  CFG:    `pnthr_tree_config__${ownerId}`,
  AUM:    `pnthr_tree_aum__${ownerId}`,
});

// opts.baseCapital → the book seeds at an explicit NAV (e.g. the house hands-off Tree
// book at the $89,882 fund-compare baseline) instead of the member's profile accountSize.
// opts.treeOnly  → this book runs ONLY the Tree strategy; the index.js member loop skips
// it so it never spawns owner-scoped Elite/Ambush paper engines (house has its own).
export async function ensurePaperBook(db, ownerId, label = null, opts = {}) {
  const setOnInsert = { ownerId: String(ownerId), label, createdAt: new Date() };
  if (opts.baseCapital > 0) setOnInsert.baseCapital = +opts.baseCapital;
  if (opts.treeOnly) setOnInsert.treeOnly = true;
  await db.collection(BOOKS).updateOne(
    { ownerId: String(ownerId) },
    { $setOnInsert: setOnInsert },
    { upsert: true },
  );
}
export async function listPaperBooks(db) {
  return db.collection(BOOKS).find({}).toArray();
}

// Base starting capital for the book: the book's own explicit baseCapital (house
// hands-off Tree = $89,882) if set, else the member's profile account size, else $50k.
async function baseCapital(db, ownerId) {
  try { const bk = await db.collection(BOOKS).findOne({ ownerId: String(ownerId) }); if (bk?.baseCapital > 0) return bk.baseCapital; } catch { /* fall through */ }
  try { const p = await getUserProfile(ownerId); if (p?.accountSize > 0) return p.accountSize; } catch { /* default */ }
  return DEFAULT_CAPITAL;
}

// Live mark-to-market NAV: base capital + realized P&L (closed paper trades) +
// unrealized P&L (open paper positions at the live price). Equals the base ($50k)
// exactly when the book is empty, then compounds with the book's performance.
function markToMarketNav(base, active, closed, quotes) {
  const realized = (closed || []).reduce((a, t) => a + (t.pnl || 0), 0);
  let unreal = 0;
  for (const p of (active || [])) {
    const basis = p.avgCost || p.entryPrice || 0;
    const q = quotes[p.ticker]; const last = q ? +q.price : basis;
    unreal += (last - basis) * (p.totalShares || p.shares || 0);
  }
  return Math.round(base + realized + unreal);
}

// ── Live snapshot the page polls (same shape as getPnthrTreeState) ───────────
export async function getPaperBookState(db, ownerId) {
  await ensurePaperBook(db, ownerId);
  const cols = C(ownerId);
  const base = await baseCapital(db, ownerId);
  const excl = await engineExclusions(db);
  const [quotes, bands, active, closed] = await Promise.all([
    fetchQuotes(AI_TICKERS),
    priorBands(db, AI_TICKERS, excl),
    db.collection(cols.POS).find({ status: 'ACTIVE' }).toArray(),
    db.collection(cols.TRADES).find({}).toArray(),
  ]);
  for (const f of applyPriceSanity(quotes, bands)) excl.set(f.ticker, `live $${f.price} vs stored $${f.lastClose} — data re-sync pending`);
  const { highs, lows } = bands;
  const nav = markToMarketNav(base, active, closed, quotes);
  const heldSet = new Set(active.map(p => p.ticker));

  // ATTACK trigger times for THIS book (written by the tick).
  const attackSeen = {};
  for (const d of await db.collection(cols.ATTACK).find({}).toArray()) attackSeen[d.ticker] = d.firstAttackAt;

  // ── funnel — identical signal logic to the house engine, sized to THIS nav ──
  const funnel = [];
  for (const t of AI_TICKERS) {
    const q = quotes[t]; if (!q) continue;
    const price = +q.price, dayHigh = +q.dayHigh || +q.price;
    const priorHigh = highs[t];
    if (!(price > 0)) continue;
    if (!(priorHigh > 0)) {
      funnel.push({ ticker: t, sector: AI_META[t]?.sector, price, priorHigh: null, pctToHigh: null, changePct: +q.changesPercentage || 0, state: 'stalking', held: heldSet.has(t), manual: true, note: excl.get(t) || null, stop: null, shares: 0, risk: 0, posValue: 0 });
      continue;
    }
    let state = 'stalking';
    if (dayHigh >= priorHigh + 0.01) state = 'attack';
    else if (price >= priorHigh * (1 - APPROACH_PCT)) state = 'approaching';
    const stop = lows[t] ? +(lows[t] - 0.01).toFixed(2) : null;
    const sz = stop ? sizeFor(nav, price, stop) : { shares: 0, rps: 0, risk: 0 };
    funnel.push({
      ticker: t, sector: AI_META[t]?.sector, price, priorHigh,
      pctToHigh: +(((priorHigh - price) / priorHigh) * 100).toFixed(2),
      changePct: +q.changesPercentage || 0, state, held: heldSet.has(t),
      stop, shares: sz.shares, risk: sz.risk, posValue: +(sz.shares * price).toFixed(0),
      attackAt: state === 'attack' ? (attackSeen[t] || null) : null,
    });
  }
  funnel.sort((a, b) => (a.pctToHigh ?? Infinity) - (b.pctToHigh ?? Infinity));

  // ── positions (his paper book) — solid cards, hypothetical P&L from live FMP ──
  const todayET = etDateStr();
  const positions = active.map(p => {
    const basis = p.avgCost || p.entryPrice || 0;
    const q = quotes[p.ticker]; const last = q ? +q.price : basis;
    const eng = lows[p.ticker] ? +(lows[p.ticker] - 0.01).toFixed(2) : 0;   // engine 2-week-low trail
    const effStop = Math.max(eng, p.stop || 0);
    const stop = effStop > 0 ? +effStop.toFixed(2) : (p.stop ?? null);
    const shares = p.totalShares || p.shares || 0;
    const pnl = +(((last - basis) * shares)).toFixed(0);
    const protectedP = stop != null && basis > 0 && stop >= basis;
    const riskNow = (stop != null && last > stop) ? Math.round((last - stop) * shares) : 0;
    const createdET = p.createdAt ? etDateStr(new Date(p.createdAt)) : null;
    return {
      ticker: p.ticker, shares, totalShares: shares, avgCost: basis, entryPrice: p.entryPrice,
      last, stop, pnl, pnlPct: basis ? +((last / basis - 1) * 100).toFixed(1) : 0,
      protected: protectedP, riskNow, riskPct: nav > 0 ? +((riskNow / nav) * 100).toFixed(2) : 0,
      company: AI_META[p.ticker]?.name || null, sector: AI_META[p.ticker]?.sector || null,
      sim: false, real: false, early: false,                       // his own book → render as solid cards
      newToday: createdET === todayET, boughtAt: p.createdAt || null,
      attackAt: attackSeen[p.ticker] || null, seenAt: p.createdAt ? new Date(p.createdAt).getTime() : 0,
    };
  });
  positions.sort((a, b) => (a.seenAt ?? Infinity) - (b.seenAt ?? Infinity));

  // ── recently stopped (last 24h) — red cards that linger after a paper stop ──
  let recentStops = [];
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const exitDocs = await db.collection(cols.EXITS).find({ recordedAt: { $gte: since } }).toArray();
    recentStops = exitDocs
      .filter(x => x.ticker && !heldSet.has(x.ticker))
      .map(x => ({ ticker: x.ticker, shares: x.shares, exitPrice: x.exitPrice ?? null, stop: x.stop ?? null, avgCost: x.avgCost ?? null, pnl: x.pnl ?? null, company: x.company || AI_META[x.ticker]?.name || null, sector: x.sector || AI_META[x.ticker]?.sector || null, stoppedAt: x.recordedAt }))
      .sort((a, b) => new Date(b.stoppedAt) - new Date(a.stoppedAt));
  } catch { recentStops = []; }

  const counts = funnel.reduce((a, f) => { a[f.state] = (a[f.state] || 0) + 1; return a; }, {});
  const grossUsed = positions.reduce((a, p) => a + (p.last || 0) * (p.shares || 0), 0);
  const treePnl = Math.round(positions.reduce((a, p) => a + (p.pnl || 0), 0));
  const riskTotal = positions.reduce((a, p) => a + (p.riskNow || 0), 0);

  return {
    kind: 'paper', readOnly: true, paperBook: true, baseCapital: base,
    mode: 'paper', nav, funnel, positions, manualTrades: [], counts, recentStops,
    treePnl, manualPnl: 0, openPnl: treePnl, simPnl: 0,
    totalRisk: {
      actual: riskTotal, actualPct: +((riskTotal / (nav || 1)) * 100).toFixed(2),
      strategy: riskTotal, strategyPct: +((riskTotal / (nav || 1)) * 100).toFixed(2),
    },
    grossUsed: +grossUsed.toFixed(0), grossX: +(grossUsed / (nav || 1)).toFixed(2), grossCapX: MAX_GROSS_X,
    baselineDrift: null, updatedAt: new Date().toISOString(),
  };
}

// ── Engine tick — paper entries on new 42wk highs + manage/exit (no real orders) ─
// Mirrors the PAPER branch of pnthrTreeEngine.runPnthrTreeTick against THIS book's
// collections and marked-to-market NAV. Never reads IBKR, never enqueues an order.
export async function runPaperBookTick(db, ownerId) {
  await ensurePaperBook(db, ownerId);
  const cols = C(ownerId);
  const base = await baseCapital(db, ownerId);
  const excl = await engineExclusions(db);
  const [quotes, bands, active0, closed] = await Promise.all([
    fetchQuotes(AI_TICKERS),
    priorBands(db, AI_TICKERS, excl),
    db.collection(cols.POS).find({ status: 'ACTIVE' }).toArray(),
    db.collection(cols.TRADES).find({}).toArray(),
  ]);
  for (const f of applyPriceSanity(quotes, bands)) excl.set(f.ticker, 'price/data mismatch');
  const { highs, lows } = bands;
  const nav = markToMarketNav(base, active0, closed, quotes);
  const actions = [];

  // held + current gross exposure (for the 2× leverage cap)
  const held = new Set(active0.map(p => p.ticker));
  let gross = active0.reduce((a, p) => a + (p.totalShares || p.shares || 0) * (+quotes[p.ticker]?.price || p.entryPrice || p.avgCost || 0), 0);
  const grossCap = MAX_GROSS_X * nav;

  // 1) ENTRIES — any AI-300 name at a NEW intraday 42wk high we don't already hold
  const attackFired = [];
  for (const t of AI_TICKERS) {
    if (held.has(t) || excl.has(t)) continue;
    const q = quotes[t]; if (!q) continue;
    const price = +q.price, dayHigh = +q.dayHigh || +q.price;
    const priorHigh = highs[t];
    if (!(price > 0) || !(priorHigh > 0) || dayHigh < priorHigh + 0.01) continue;
    attackFired.push(t);
    const stop = lows[t] ? +(lows[t] - 0.01).toFixed(2) : null;
    const { shares } = stop ? sizeFor(nav, price, stop) : { shares: 0 };
    if (!stop || shares < 1) continue;
    if (gross + shares * price > grossCap) { actions.push({ type: 'SKIP_GROSS_CAP', ticker: t, grossX: +(gross / nav).toFixed(2) }); continue; }
    gross += shares * price;
    await db.collection(cols.POS).insertOne({
      ticker: t, direction: 'LONG', entryPrice: price, avgCost: price, totalShares: shares, shares,
      stop, status: 'ACTIVE', mode: 'paper', source: 'TREE_42WH', entryDate: new Date().toISOString().slice(0, 10), createdAt: new Date(),
    });
    actions.push({ type: 'PAPER_ENTRY', ticker: t, shares, price, stop });
  }
  // ATTACK trigger-time ledger (book-scoped): stamp firing names, drop those neither firing nor held.
  for (const t of attackFired) await db.collection(cols.ATTACK).updateOne({ ticker: t }, { $setOnInsert: { ticker: t, firstAttackAt: new Date() } }, { upsert: true });
  { const keep = [...new Set([...attackFired, ...held])]; await db.collection(cols.ATTACK).deleteMany(keep.length ? { ticker: { $nin: keep } } : {}).catch(() => {}); }

  // 2) MANAGE — trail the 2-week stop + $250 breakeven snap; paper exit on a stop hit
  const todayStr = etDateStr();
  const active = await db.collection(cols.POS).find({ status: 'ACTIVE' }).toArray();
  const greenHour = await fetchGreenHourMap([...new Set(active.map(p => p.ticker))]).catch(() => ({}));
  for (const p of active) {
    const q = quotes[p.ticker]; if (!q) continue;
    const price = +q.price, dayLow = +q.dayLow || price, dayOpen = +q.open || +q.dayOpen || price;
    const sh = p.totalShares || p.shares || 0;
    const newStop = lows[p.ticker] ? +(lows[p.ticker] - 0.01).toFixed(2) : p.stop;
    const openPnl = (price - p.avgCost) * sh;
    const beStop = (openPnl >= BE_SNAP_PROFIT && greenHour[p.ticker] === true && p.avgCost > 0) ? +(+p.avgCost).toFixed(2) : 0;
    const trailed = Math.max(p.stop || 0, newStop || 0, beStop);
    const raisedAboveLow = trailed > (p.stop || 0) && trailed > dayLow;
    const upd = {};
    if (trailed !== p.stop) upd.stop = trailed;
    if (raisedAboveLow) upd.beArmedDate = todayStr;
    if (Object.keys(upd).length) await db.collection(cols.POS).updateOne({ _id: p._id }, { $set: upd });
    if (beStop && trailed === beStop && (p.stop || 0) < beStop) actions.push({ type: 'BE_SNAP', ticker: p.ticker, stop: beStop, openPnl: Math.round(openPnl) });
    const armedToday = (raisedAboveLow ? todayStr : p.beArmedDate) === todayStr;
    const stopHit = armedToday ? (price <= trailed) : (dayLow <= trailed);
    if (stopHit) {
      // GAP-THROUGH (2026-07-06 audit): if the day OPENED below the stop, the real fill is
      // near the open, not the stop — fill at min(stop, open) for a long (matches treeSim).
      // Only applies to a non-armed (intraday-touch) exit; an armed forward-only stop exits
      // at the current price which is already the achievable level.
      const exitPx = armedToday ? Math.min(trailed, price) : Math.min(trailed, dayOpen);
      const pnl = +((exitPx - p.avgCost) * sh).toFixed(2);
      await db.collection(cols.POS).updateOne({ _id: p._id }, { $set: { status: 'CLOSED', exitPrice: exitPx, exitDate: new Date().toISOString().slice(0, 10), pnl, closedAt: new Date() } });
      await db.collection(cols.TRADES).insertOne({ ticker: p.ticker, direction: 'LONG', entryPrice: p.entryPrice, exitPrice: exitPx, shares: sh, pnl, exitReason: 'STOP', mode: 'paper', entryDate: p.entryDate, exitDate: new Date().toISOString().slice(0, 10), createdAt: new Date() });
      await db.collection(cols.EXITS).updateOne({ paperExitId: String(p._id) }, { $setOnInsert: {
        paperExitId: String(p._id), ticker: p.ticker, exitPrice: exitPx, shares: sh, avgCost: p.avgCost, stop: trailed, stopHit: true, pnl,
        company: AI_META[p.ticker]?.name || null, sector: AI_META[p.ticker]?.sector || null, mode: 'paper', recordedAt: new Date(),
      } }, { upsert: true });
      actions.push({ type: 'PAPER_EXIT', ticker: p.ticker, exitPx, pnl });
    }
  }
  // keep the exits collection bounded — the page only shows the last 24h
  await db.collection(cols.EXITS).deleteMany({ recordedAt: { $lt: new Date(Date.now() - 7 * 24 * 3600 * 1000) } }).catch(() => {});
  return { ownerId: String(ownerId), mode: 'paper', actions };
}

// Tick every registered paper book (called by the 2-min cron alongside the house tick).
export async function runAllPaperBookTicks(db) {
  const books = await listPaperBooks(db);
  const out = [];
  for (const b of books) {
    try { const r = await runPaperBookTick(db, b.ownerId); if (r.actions?.length) out.push(r); }
    catch (e) { console.error('[Tree paper book] tick failed for', b.ownerId, e.message); }
  }
  return out;
}

// Projected vs Actual AUM + PNTHR Goals, anchored at THIS book's NAV (e.g. $50k).
// Reuses the house projection math (same backtest baseline + forward rule) but
// records/reads the book's own anchor + actual-AUM series, and suppresses the
// house cash-banking ledger.
export async function getPaperBookProjection(db, ownerId) {
  await ensurePaperBook(db, ownerId);
  const cols = C(ownerId);
  const base = await baseCapital(db, ownerId);
  const [quotes, active, closed] = await Promise.all([
    fetchQuotes(AI_TICKERS),
    db.collection(cols.POS).find({ status: 'ACTIVE' }).toArray(),
    db.collection(cols.TRADES).find({}).toArray(),
  ]);
  const nav = markToMarketNav(base, active, closed, quotes);
  return getPnthrTreeProjection(db, { nav, cfgColl: cols.CFG, aumColl: cols.AUM, noCashLedger: true });
}
