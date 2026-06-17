// server/pnthrTreeEngine.js
// ── PNTHR TREE — 42-week-high momentum engine ───────────────────────────────
// Strategy (Scott 2026-06-11): AI-300, LONG-only. Enter FULL SIZE the moment a name
// makes a NEW INTRADAY 42-week high (no pyramid — tested best). Stop = 2-week lowest-low,
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
import { getSplitExclusions, flagSuspectSplit } from './splitMaintenanceService.js';

const CFG    = 'pnthr_tree_config';
const POS    = 'pnthr_tree_positions';
const TRADES = 'pnthr_tree_trades';

const VITALITY_PCT   = 0.02;   // risk budget per name
const TICKER_CAP_PCT = 0.10;   // max position value per name
const APPROACH_PCT   = 0.01;   // within 1% of the 42wk high → "approaching" (flashing)
const STOP_LOOKBACK  = 10;     // 2 trading weeks
const ENTRY_HIGH_LOOKBACK = 210;   // 42-week high lookback: 210 trading days of PRIOR bars (excludes today).
                                   // Switched from 52wk/252d on 2026-06-17 — the 42wk high beat the 52wk on return,
                                   // Sharpe, Sortino, Calmar AND drawdown, and held up OUT-OF-SAMPLE (679 universe +
                                   // 2020-22 COVID/bear regime) as a stable plateau, not a curve-fit spike.

// ── Engine exclude (MANUAL-ONLY tickers) ─────────────────────────────────────
// Tickers the engine must IGNORE in funnel / entry / stop-management — trade them
// BY HAND. Two cases:
//   (a) split-stale candles: a pending/just-applied split makes the live (broker)
//       price a fraction of our cached candles, so the engine would set a 2wk-low
//       stop at the OLD scale, ABOVE the market = instant liquidation; and
//   (b) brand-new IPOs with no/insufficient history: no real 42wk high to break and
//       no 2wk-low to stop against (sizing the model can't compute).
// Remove a ticker here only once its candles are clean (split re-synced, or ~1yr of
// history accumulated). While excluded, the engine never enters, exits, or stops it.
//   SPCX — SpaceX IPO 2026-06-12 (no history); Scott trades it manually until it seasons.
//   (KLAC removed 2026-06-12: FMP published the 10:1 split-adjusted history; candles
//    deleted + re-backfilled, verified continuous on the post-split scale.)
// SPLITS are now handled AUTOMATICALLY: splitMaintenanceService tracks FMP's split
// calendar and any universe ticker with a pending (un-resynced) split is excluded
// dynamically via engineExclusions() below — no more hand-editing this set for splits.
const ENGINE_EXCLUDE = new Set(['SPCX']);

// Static manual-only set ∪ dynamic split exclusions → Map(ticker → reason).
async function engineExclusions(db) {
  const out = new Map();
  for (const t of ENGINE_EXCLUDE) out.set(t, 'new IPO — seasoning until ~1yr of bars');
  try { for (const [t, why] of await getSplitExclusions(db)) out.set(t, why); }
  catch (e) { console.error('[Tree] split exclusions unavailable:', e.message); }
  return out;
}

// Live-vs-stored price sanity net: if the live quote is wildly off the stored
// candle scale (a split the calendar missed, or bad data), DROP the ticker's
// bands so the engine can't enter or trail a stop off bogus levels, and flag
// it for the nightly split re-sync. This is the guard that would have caught
// KLAC even with no calendar (live $241 vs stored ~$2,411).
function applyPriceSanity(quotes, bands) {
  const flagged = [];
  for (const t of Object.keys(bands.highs)) {
    const price = +quotes[t]?.price, last = bands.lastClose?.[t];
    if (!(price > 0) || !(last > 0)) continue;
    if (price < last * 0.6 || price > last * 1.67) {
      flagged.push({ ticker: t, price, lastClose: last });
      delete bands.highs[t]; delete bands.lows[t];
    }
  }
  return flagged;
}
const MAX_GROSS_X    = 2.0;    // gross leverage cap: total long exposure ≤ 2× NAV (Scott 2026-06-11).
                               // WITHOUT this the per-name 2%/10% sizing piles to 4-10× in a broad rally
                               // (backtest: 72%+ drawdown). 2× cap → ~106% CAGR / 55% DD (daily-stop, hypothetical).

const AI_META = {};
const AI_TICKERS = (() => {
  const out = [];
  for (const s of AI_SECTORS) for (const h of s.holdings) { out.push(h.ticker); AI_META[h.ticker] = { sector: s.name, name: h.name }; }
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
//   highs[t] = max high of the prior ≤210 bars  → the real 42-week high to break (the
//              ATTACK trigger). NOT FMP's `yearHigh` field — that already absorbs today's
//              intraday move, so a fresh breakout never registers (it stays "approaching").
//   lows[t]  = min low of the prior ≤10 bars    → the 2-week trailing-stop reference.
// Excluding today makes the live trigger identical to the backtest (prior-bars-only).
async function priorBands(db, tickers, excl) {
  const today = etDateStr();
  const highs = {}, lows = {}, lastClose = {};
  const docs = await db.collection('pnthr_ai_bt_candles').find({ ticker: { $in: tickers } }).toArray();
  for (const d of docs) {
    if (excl?.has(d.ticker)) continue;   // manual-only (IPO seasoning / split re-sync pending) → no bands → no entry/manage
    const bars = (d.daily || []).filter(b => b.date < today && +b.high > 0 && +b.low > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!bars.length) continue;
    const hi = bars.slice(-ENTRY_HIGH_LOOKBACK), lo = bars.slice(-STOP_LOOKBACK);
    // A real 42-week high needs the full ~42 weeks (210 bars) of history. Without this guard a fresh IPO
    // (e.g. QNT, ~6 bars) would set its "42wk high" to a few-days high and falsely
    // trigger ATTACK. No high → the name is skipped from the funnel until it seasons.
    if (bars.length >= ENTRY_HIGH_LOOKBACK) highs[d.ticker] = Math.max(...hi.map(b => +b.high));
    if (lo.length) lows[d.ticker] = Math.min(...lo.map(b => +b.low));
    lastClose[d.ticker] = +bars[bars.length - 1].close;   // for the live-price sanity net
  }
  return { highs, lows, lastClose };
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

// ── One-time migration to the live-mirror paper model ───────────────────────
// Clears the OLD disconnected sim book (which replaced your real account in the
// view) and reseeds "seen" with yesterday's date for your current real holdings, so
// adopting them doesn't make everything flash NEW on day one. Runs EXACTLY once
// (guarded by cfg.mirrorMigrated) and only exists in this NEW code — so Render's
// redeploy timing is irrelevant and the old engine can never refill the sim book.
async function ensureMirrorMigration(db, cfg, excl) {
  if (cfg.mirrorMigrated) return false;
  await db.collection(POS).deleteMany({ mode: 'paper' });
  await db.collection(TRADES).deleteMany({ mode: 'paper' });
  await db.collection('pnthr_tree_seen').deleteMany({});
  const snap = (await db.collection('pnthr_ibkr_positions').find({}).sort({ syncedAt: -1 }).limit(1).toArray())[0] || {};
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
  const yStr = etDateStr(yesterday);
  for (const p of (snap.positions || [])) {
    const t = (p.ticker || p.symbol || '').toUpperCase(); const sh = p.position ?? p.shares;
    if (AI_META[t] && !excl.has(t) && sh > 0) {
      await db.collection('pnthr_tree_seen').updateOne({ ticker: t }, { $setOnInsert: { ticker: t, firstSeen: yStr, firstSeenAt: yesterday } }, { upsert: true });
    }
  }
  await db.collection(CFG).updateOne({}, { $set: { mirrorMigrated: true, mirrorMigratedAt: new Date() } }, { upsert: true });
  cfg.mirrorMigrated = true;
  console.log('[Tree] live-mirror migration: sim book cleared, "seen" reseeded for current holdings.');
  return true;
}

// ── Live snapshot the page polls: funnel + sizing/stops + positions ──────────
export async function getPnthrTreeState(db) {
  const cfg = await getPnthrTreeConfig(db);
  const nav = await getNav(db);
  const excl = await engineExclusions(db);
  await ensureMirrorMigration(db, cfg, excl);
  const [quotes, bands] = await Promise.all([fetchQuotes(AI_TICKERS), priorBands(db, AI_TICKERS, excl)]);
  for (const f of applyPriceSanity(quotes, bands)) {   // un-tracked split / bad data → manual until re-synced
    excl.set(f.ticker, `live $${f.price} vs stored $${f.lastClose} — data re-sync pending`);
    flagSuspectSplit(db, f.ticker, `Tree state: live $${f.price} vs stored close $${f.lastClose}`).catch(() => {});
  }
  const { highs, lows } = bands;

  // ── Displayed book = your REAL IBKR account (adopted) + (paper only) the engine's
  //    SIMULATED would-buys, so paper mimics live automation exactly. The ONLY thing
  //    live does that paper doesn't is actually send the orders to the broker. ───────
  const snap = (await db.collection('pnthr_ibkr_positions').find({}).sort({ syncedAt: -1 }).limit(1).toArray())[0] || {};
  const realRaw = [];
  for (const p of (snap.positions || [])) {
    const t = (p.ticker || p.symbol || '').toUpperCase(); const sh = p.position ?? p.shares;
    if (sh > 0) realRaw.push({ ticker: t, shares: sh, avgCost: p.avgCost ?? p.avgPrice, ibkrPnl: +p.unrealizedPNL || 0, ibkrLast: +p.marketPrice || 0, real: true });
  }
  const realHeld = new Set(realRaw.map(p => p.ticker));
  let simRaw = [];
  if (cfg.mode === 'paper') {
    simRaw = (await db.collection(POS).find({ status: 'ACTIVE' }).toArray())
      .filter(p => !realHeld.has(p.ticker))     // your real account always takes precedence
      .map(p => ({ ticker: p.ticker, shares: p.totalShares || p.shares, avgCost: p.avgCost || p.entryPrice, entryPrice: p.entryPrice, sim: true }));
  }
  // off-strategy = a held name Tree never trades (ENGINE_EXCLUDE like SPCX, or non-AI-300)
  const offStrategy = (t) => excl.has(t) || !AI_META[t];
  let positions = [], manualTrades = [];
  for (const p of [...realRaw, ...simRaw]) (offStrategy(p.ticker) ? manualTrades : positions).push(p);
  const held = new Set([...realRaw, ...simRaw].map(p => p.ticker));   // everything displayed is "held" for the funnel

  const funnel = [];
  for (const t of AI_TICKERS) {
    const q = quotes[t]; if (!q) continue;
    const price = +q.price, dayHigh = +q.dayHigh || +q.price;
    const priorHigh = highs[t];   // real prior 42wk high (excl today) — see priorBands
    if (!(price > 0)) continue;
    if (!(priorHigh > 0)) {
      // MANUAL-ONLY names (ENGINE_EXCLUDE or <1yr of bars, e.g. SPCX/QNT IPOs): still
      // LIST them in STALKING so the page shows the full AI-300 universe, but with no
      // trigger/stop/size — they can never escalate past stalking, and the engine tick
      // (which requires priorHigh + skips ENGINE_EXCLUDE) never trades them.
      funnel.push({
        ticker: t, sector: AI_META[t]?.sector, price, priorHigh: null, pctToHigh: null,
        changePct: +q.changesPercentage || 0, state: 'stalking', held: held.has(t),
        manual: true, note: excl.get(t) || null, stop: null, shares: 0, risk: 0, posValue: 0,
      });
      continue;
    }
    let state = 'stalking';
    if (dayHigh >= priorHigh + 0.01) state = 'attack';                 // broke the prior 42wk high today
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
  funnel.sort((a, b) => (a.pctToHigh ?? Infinity) - (b.pctToHigh ?? Infinity));   // closest to a new high first; manual (no high) last

  // Your ACTUAL resting broker stops (incl. any you raised manually in TWS). The
  // effective protective stop = the HIGHER of your broker stop and the engine's 2-week-low
  // (raise-only / tightest-wins, exactly how live behaves). This is what drives PROTECT,
  // the shown stop, the risk numbers, and the near-stop warning — so a manual raise above
  // break-even is reflected immediately.
  const brokerStops = {};
  for (const o of (snap.stopOrders || [])) {
    const t = (o.symbol || o.ticker || '').toUpperCase();
    if ((o.action || '').toUpperCase() === 'SELL') brokerStops[t] = Math.max(brokerStops[t] || 0, +o.stopPrice || 0);
  }
  // enrich each card with price, the effective stop, and P&L. REAL positions mirror IBKR
  // EXACTLY — its own mark (marketPrice) and unrealized P&L — so the page matches your
  // account to the dollar. SIM would-buys are hypothetical, so they use the live FMP price.
  const enrich = (p) => {
    const q = quotes[p.ticker]; const basis = p.avgCost || p.entryPrice || 0;
    const fmpLast = q ? +q.price : 0;
    const last = p.real ? (p.ibkrLast || fmpLast || basis) : (fmpLast || basis);
    p.last = last;
    const eng = lows[p.ticker] ? +(lows[p.ticker] - 0.01).toFixed(2) : 0;   // engine's 2-week-low (intended trail)
    const brk = brokerStops[p.ticker] || 0;                                 // your actual resting stop (manual raises included)
    const eff = Math.max(brk, eng);
    p.stop = eff > 0 ? +eff.toFixed(2) : (p.stop || null);
    p.pnl = p.real ? Math.round(p.ibkrPnl || 0)                            // IBKR truth for real positions → matches your account
                   : +(((last - basis) * (p.shares || p.totalShares || 0))).toFixed(0);
    p.pnlPct = basis ? +((last / basis - 1) * 100).toFixed(1) : 0;
    // PROTECT = effective stop has reached/passed your entry → worst case is a locked profit.
    p.protected = p.stop != null && basis > 0 && p.stop >= basis;
    p.company = AI_META[p.ticker]?.name || null;
    p.sector  = AI_META[p.ticker]?.sector || null;
  };
  positions.forEach(enrich);
  manualTrades.forEach(enrich);

  // ── NEW-today flash + "Early" latch ─────────────────────────────────────────
  // Early = a strategy position you bought BEFORE the engine's signal (it has not yet
  // made a new 42-week high while you've held it). The moment it does ("the strategy
  // DID recommend it"), the latch flips and Early drops PERMANENTLY for this holding.
  // Engine sim-buys are recommended by definition → never Early. Resets on exit.
  const seenToday = etDateStr();
  const heldNow = new Set([...positions, ...manualTrades].map(p => p.ticker));
  try {
    const seenDocs = await db.collection('pnthr_tree_seen').find({}).toArray();
    const seen = {}, seenAt = {}, grad = {};
    for (const d of seenDocs) {
      seen[d.ticker] = d.firstSeen;
      seenAt[d.ticker] = d.firstSeenAt ? new Date(d.firstSeenAt).getTime() : (d._id?.getTimestamp ? d._id.getTimestamp().getTime() : 0);
      grad[d.ticker] = !!d.graduatedAt;
    }
    const attackNow = (t) => { const q = quotes[t]; const dh = q ? (+q.dayHigh || +q.price) : 0; return highs[t] > 0 && dh >= highs[t] + 0.01; };
    for (const p of positions) {
      const now = new Date();
      if (!seen[p.ticker]) {
        await db.collection('pnthr_tree_seen').updateOne({ ticker: p.ticker }, { $setOnInsert: { ticker: p.ticker, firstSeen: seenToday, firstSeenAt: now } }, { upsert: true });
        seen[p.ticker] = seenToday; seenAt[p.ticker] = now.getTime();
      }
      if (!grad[p.ticker] && (p.sim || attackNow(p.ticker))) {     // engine recommended it → latch graduated
        await db.collection('pnthr_tree_seen').updateOne({ ticker: p.ticker }, { $set: { graduatedAt: now } });
        grad[p.ticker] = true;
      }
      p.early = !p.sim && !grad[p.ticker];
    }
    const gone = seenDocs.filter(d => !heldNow.has(d.ticker)).map(d => d.ticker);
    if (gone.length) await db.collection('pnthr_tree_seen').deleteMany({ ticker: { $in: gone } });
    positions.forEach(p => { p.newToday = seen[p.ticker] === seenToday; p.seenAt = seenAt[p.ticker] || 0; });
    positions.sort((a, b) => (a.seenAt ?? Infinity) - (b.seenAt ?? Infinity));
  } catch { positions.forEach(p => { p.newToday = false; p.early = false; }); }

  // ── Recently stopped (last 24h) — red cards that stay visible after a stop hit ─
  let recentStops = [];
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const exitDocs = await db.collection('pnthr_tree_exits').find({ recordedAt: { $gte: since } }).toArray();
    const byT = {};
    for (const x of exitDocs) {
      if (!x.ticker) continue;
      const a = byT[x.ticker] || (byT[x.ticker] = { ticker: x.ticker, shares: 0, gross: 0, pnl: 0, stop: x.stop ?? null, avgCost: x.avgCost ?? null, stopHit: false, recordedAt: x.recordedAt, company: x.company || AI_META[x.ticker]?.name || null, sector: x.sector || AI_META[x.ticker]?.sector || null });
      a.shares += x.shares || 0; a.gross += (+x.exitPrice || 0) * (x.shares || 0); a.pnl += x.pnl || 0;
      if (x.stopHit === true) a.stopHit = true;
      if (new Date(x.recordedAt) > new Date(a.recordedAt)) a.recordedAt = x.recordedAt;
    }
    recentStops = Object.values(byT)
      .filter(a => a.stopHit && !heldNow.has(a.ticker))
      .map(a => ({ ticker: a.ticker, shares: a.shares, exitPrice: a.shares ? +(a.gross / a.shares).toFixed(2) : null, stop: a.stop, avgCost: a.avgCost, pnl: a.pnl, company: a.company, sector: a.sector, stoppedAt: a.recordedAt }))
      .sort((a, b) => new Date(b.stoppedAt) - new Date(a.stoppedAt));
  } catch { recentStops = []; }

  const counts = funnel.reduce((a, f) => { a[f.state] = (a[f.state] || 0) + 1; return a; }, {});
  const allBook = [...positions, ...manualTrades];   // leverage counts the whole displayed book
  const grossUsed = allBook.reduce((a, p) => a + (p.last || 0) * (p.shares || p.totalShares || 0), 0);
  // Categorized P&L, all from IBKR's own marks so they match your account to the dollar:
  //   treePnl   = TREE strategy positions (Devour + Protect)
  //   manualPnl = your manual / off-strategy holdings (Manual box, e.g. SPCX) — "IBKR P&L"
  //   openPnl   = treePnl + manualPnl = TOTAL = your full IBKR account
  // simPnl (hypothetical would-buys) is tracked separately so the total never drifts from real.
  const treePnl = Math.round(positions.filter(p => p.real).reduce((a, p) => a + (p.pnl || 0), 0));
  const manualPnl = Math.round(manualTrades.reduce((a, p) => a + (p.pnl || 0), 0));
  const simPnl = Math.round(positions.filter(p => p.sim).reduce((a, p) => a + (p.pnl || 0), 0));
  const openPnl = treePnl + manualPnl;
  return {
    mode: cfg.mode, nav, funnel, positions, manualTrades, counts, recentStops, treePnl, manualPnl, openPnl, simPnl,
    grossUsed: +grossUsed.toFixed(0), grossX: +(grossUsed / (nav || 1)).toFixed(2), grossCapX: MAX_GROSS_X,
    baselineDrift: cfg.baselineDrift || null,   // drift guard flag — page shows a banner if the backtest baseline went stale
    updatedAt: new Date().toISOString(),
  };
}

// ── Stop-out capture (for the 24h "recently stopped" red cards) ──────────────
// When a live position is stopped out, the broker-resting stop sells it and the
// name VANISHES from the IBKR snapshot — the card would silently disappear. So we
// persist each stop-out and keep showing it red for 24h (Scott 2026-06-14).
//
// Detection is EXEC-DRIVEN (positive evidence only): we record today's SELL fills
// of Tree-managed longs, idempotent by execId. We do NOT infer an exit from a
// position simply being absent — an empty/stale snapshot would then mass-record
// false exits (the old cascade trap). A fill counts as a STOP HIT when its price
// is at/below the resting stop; a manual profit-sell (well above the stop) is not
// flagged and gets no red card. avgCost/stop come from cfg.lastHeld, which we
// refresh here each tick so P&L survives after the position goes flat.
// This function enqueues NOTHING — it is display-only on the trading side.
const EXITS = 'pnthr_tree_exits';
async function captureTreeStopOuts(db, cfg, snap, lows, excl) {
  const today = etDateStr();
  const ymd = today.replaceAll('-', '');
  const lastHeld = cfg.lastHeld || {};

  // your actual resting broker stops (incl. manual raises). The effective stop is the
  // HIGHER of your stop and the engine's 2-week-low, so a manual-stop fire is detected too.
  const brokerStop = {};
  for (const o of (snap.stopOrders || [])) { const t = (o.symbol || o.ticker || '').toUpperCase(); if ((o.action || '').toUpperCase() === 'SELL') brokerStop[t] = Math.max(brokerStop[t] || 0, +o.stopPrice || 0); }

  // refresh the held-context map (avgCost / shares / effective stop) for AI-300 longs
  const curHeld = {};
  for (const p of (snap.positions || [])) {
    const t = (p.symbol || p.ticker || '').toUpperCase(); const sh = p.position ?? p.shares;
    if (!AI_META[t] || !(sh > 0)) continue;
    const eng = lows[t] ? +(lows[t] - 0.01).toFixed(2) : 0;
    const eff = Math.max(brokerStop[t] || 0, eng);
    curHeld[t] = { avgCost: +p.avgCost || 0, shares: sh, stop: eff > 0 ? +eff.toFixed(2) : (lastHeld[t]?.stop ?? null) };
  }

  let recorded = 0;
  for (const e of (snap.latestExecutions || [])) {
    if (String(e.side || '').toUpperCase() !== 'SLD') continue;           // sells only
    const t = (e.symbol || '').toUpperCase();
    if (!AI_META[t] || excl.has(t)) continue;                             // Tree-managed names only
    if (e.time && !String(e.time).replace(/[^0-9]/g, '').startsWith(ymd)) continue;  // today's fills only (feed can carry a prior session)
    const ctx = lastHeld[t] || curHeld[t] || {};
    const exitPrice = +e.price || 0, sharesSold = +e.shares || 0;
    const stop = ctx.stop ?? null, avgCost = ctx.avgCost ?? null;
    const stopHit = (stop > 0 && exitPrice > 0) ? exitPrice <= stop * 1.01 : null;   // at/below the stop (1% slack for gaps)
    const r = await db.collection(EXITS).updateOne(
      { execId: e.execId },
      { $setOnInsert: {
          execId: e.execId, ticker: t, exitPrice, shares: sharesSold, avgCost, stop, stopHit,
          pnl: (avgCost != null && exitPrice > 0) ? +((exitPrice - avgCost) * sharesSold).toFixed(0) : null,
          company: AI_META[t]?.name || null, sector: AI_META[t]?.sector || null,
          mode: cfg.mode, execTime: e.time || null, recordedAt: new Date(),
        } },
      { upsert: true },
    );
    if (r.upsertedCount) recorded++;
  }

  await db.collection(CFG).updateOne({}, { $set: { lastHeld: curHeld } }, { upsert: true });
  // keep the collection bounded — the page only ever shows the last 24h
  await db.collection(EXITS).deleteMany({ recordedAt: { $lt: new Date(Date.now() - 7 * 24 * 3600 * 1000) } }).catch(() => {});
  return recorded;
}

// ── Engine tick — paper records / live places orders on new 42wk highs ───────
export async function runPnthrTreeTick(db) {
  const cfg = await getPnthrTreeConfig(db);
  if (!cfg.mode || cfg.mode === 'off') return { mode: 'off', actions: [] };
  const nav = await getNav(db);
  const excl = await engineExclusions(db);
  await ensureMirrorMigration(db, cfg, excl);   // one-time: switch to the live-mirror model
  const [quotes, bands] = await Promise.all([fetchQuotes(AI_TICKERS), priorBands(db, AI_TICKERS, excl)]);
  const actions = [];
  for (const f of applyPriceSanity(quotes, bands)) {   // un-tracked split / bad data → hands off until re-synced
    excl.set(f.ticker, 'price/data mismatch');
    actions.push({ type: 'DATA_SANITY_EXCLUDE', ticker: f.ticker, price: f.price, lastClose: f.lastClose });
    await flagSuspectSplit(db, f.ticker, `Tree tick: live $${f.price} vs stored close $${f.lastClose}`).catch(() => {});
  }
  const { highs, lows } = bands;

  // held set + current GROSS exposure (for the 2× leverage cap). Read your REAL account
  // ONCE (adopted in BOTH modes). In paper, ALSO count the engine's simulated would-buys
  // so it never double-buys a name you already hold, real or simulated.
  const snap = (await db.collection('pnthr_ibkr_positions').find({}).sort({ syncedAt: -1 }).limit(1).toArray())[0] || {};
  const held = new Set();
  let gross = 0;
  for (const p of (snap.positions || [])) {
    const t = (p.ticker || p.symbol || '').toUpperCase(); const sh = p.position ?? p.shares;
    if (sh !== 0) { held.add(t); gross += Math.abs(sh) * (+quotes[t]?.price || p.avgCost || p.avgPrice || 0); }
  }
  if (cfg.mode === 'paper') {
    for (const p of await db.collection(POS).find({ status: 'ACTIVE' }).toArray()) {
      if (held.has(p.ticker)) continue;     // your real account takes precedence
      held.add(p.ticker); gross += (p.totalShares || p.shares || 0) * (+quotes[p.ticker]?.price || p.entryPrice || p.avgCost || 0);
    }
  }
  const grossCap = MAX_GROSS_X * nav;

  // 1) ENTRIES — any AI-300 name at a NEW intraday 42wk high we don't already hold
  for (const t of AI_TICKERS) {
    if (held.has(t)) continue;
    if (excl.has(t)) continue;   // manual-only (IPO seasoning / split re-sync pending) → don't trade
    const q = quotes[t]; if (!q) continue;
    const price = +q.price, dayHigh = +q.dayHigh || +q.price;
    const priorHigh = highs[t];   // real prior 42wk high (excl today)
    if (!(price > 0) || !(priorHigh > 0) || dayHigh < priorHigh + 0.01) continue;   // not a new 42wk high
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
        stop, status: 'ACTIVE', mode: 'paper', source: 'TREE_42WH', entryDate: new Date().toISOString().slice(0, 10), createdAt: new Date(),
      });
      actions.push({ type: 'PAPER_ENTRY', ticker: t, shares, price, stop });
    } else if (cfg.mode === 'live') {
      // Bridge BUY_ENTRY places the market buy AND the protective stop in one command (Ambush shape).
      // Requires the bridge running + draining the outbox, and the Ambush engine OFF (no reconcile contention).
      await enqueueAmbushOrder(db, 'BUY_ENTRY', { ticker: t, shares, price, direction: 'LONG', stopPrice: stop, source: 'TREE_42WH' });
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
        // mirror into pnthr_tree_exits so the 24h red "recently stopped" card works in paper too (paper exits are always stop hits)
        await db.collection(EXITS).updateOne({ paperExitId: String(p._id) }, { $setOnInsert: {
          paperExitId: String(p._id), ticker: p.ticker, exitPrice: exitPx, shares: p.totalShares, avgCost: p.avgCost, stop: trailed, stopHit: true, pnl,
          company: AI_META[p.ticker]?.name || null, sector: AI_META[p.ticker]?.sector || null, mode: 'paper', recordedAt: new Date(),
        } }, { upsert: true });
        actions.push({ type: 'PAPER_EXIT', ticker: p.ticker, exitPx, pnl });
      }
    }
  }
  // LIVE manage: trail each held position's stop UP to its current 2-week low (broker-resting
  // stop fires the exit). LIVE ONLY — in paper the page just DISPLAYS the intended stop; the
  // engine never modifies your real broker stops until you go live.
  if (cfg.mode === 'live') {
    for (const p of (snap.positions || [])) {
      const t = (p.ticker || p.symbol || '').toUpperCase(); const sh = p.position ?? p.shares;
      if (!AI_META[t] || !(sh > 0)) continue;
      if (excl.has(t)) continue;   // split-stale / IPO → DON'T place a stop (could be at the wrong scale, above market)
      const newStop = lows[t] ? +(lows[t] - 0.01).toFixed(2) : null; if (!newStop) continue;
      const cur = (snap.stopOrders || []).filter(o => (o.symbol || o.ticker || '').toUpperCase() === t && (o.action || '').toUpperCase() === 'SELL').reduce((m, o) => Math.max(m, +o.stopPrice || 0), 0);
      if (newStop > cur + 0.01) {
        await enqueueAmbushOrder(db, 'MODIFY_STOP', { ticker: t, direction: 'LONG', newStopPrice: newStop, shares: sh, reason: 'TREE_TRAIL' });
        actions.push({ type: 'LIVE_TRAIL', ticker: t, newStop, from: cur });
      }
    }
  }
  // Stop-out capture (exec-driven, reads your real SELL fills) — runs in BOTH paper and live
  // so a real stop-out shows as a red "recently stopped" card either way. Enqueues NOTHING;
  // in paper this is the only thing that touches the real account, and it is read-only.
  try { const n = await captureTreeStopOuts(db, cfg, snap, lows, excl); if (n) actions.push({ type: 'STOP_OUTS_RECORDED', count: n }); }
  catch (e) { console.error('[Tree] stop-out capture failed:', e.message); }

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
const _treeCashLedgerPath = new URL('./data/treeCashLedger.json', import.meta.url).pathname;
let _treeCashLedger;
function loadCashLedger() {
  if (_treeCashLedger === undefined) {
    try { _treeCashLedger = JSON.parse(fs.readFileSync(_treeCashLedgerPath, 'utf8')); }
    catch { _treeCashLedger = null; }
  }
  return _treeCashLedger;
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

  // Projected curve = SMOOTH daily compounding at the backtest CAGR, mapped to
  // weekday dates. NOT the raw backtest equity path: that replays the real
  // drawdowns, so the "projection" dipped BELOW the starting balance (confusing —
  // a forward target should rise steadily, like an index goal line). Each weekday =
  // today's anchor AUM grown at the daily-CAGR rate. (Drawdown risk is disclosed
  // separately in the metric tiles: max DD %.)
  const N = factors.length;
  const cagrPct = proj.metrics?.cagrPct || 0;
  const dailyCagr = cagrPct > 0 ? Math.pow(1 + cagrPct / 100, 1 / 252) : 1;
  const dates = N ? [startDate] : [];
  { const d = new Date(startDate + 'T12:00:00'); for (let i = 1; i < N; i++) { do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6); dates.push(d.toISOString().split('T')[0]); } }
  const projected = dates.map((date, i) => ({ date, value: +(startAum * Math.pow(dailyCagr, i)).toFixed(0) }));

  const elapsed = Math.min(weekdaysBetween(startDate, todayISO), Math.max(0, N - 1));
  const projectedToday = +(startAum * Math.pow(dailyCagr, elapsed)).toFixed(0);
  const onTrackPct = projectedToday > 0 ? +(((nav / projectedToday) - 1) * 100).toFixed(1) : 0;
  // Pace vs schedule: the projection curve is weekday-spaced (1 step ≈ 1 trading day), so the
  // index where projected first reaches today's actual AUM, minus today's index, = trading days
  // ahead (+) or behind (-). Recomputed every poll, so it tracks as Actual AUM moves.
  let paceIdx = projected.findIndex(p => p.value >= nav);
  if (paceIdx < 0) paceIdx = projected.length - 1;                 // AUM above the whole curve → cap at the end
  const aheadOfSchedule = (projected.length && paceIdx >= 0)
    ? { date: projected[paceIdx].date, tradingDays: paceIdx - elapsed, ahead: (paceIdx - elapsed) >= 0 }
    : null;
  const projFwd = N ? simulateForward(projectedToday, N, elapsed, dailyCagr, FWD_HORIZONS) : {};
  const actFwd = N ? simulateForward(nav, N, elapsed, dailyCagr, FWD_HORIZONS) : {};
  const forward = {
    cagrPct,
    withdrawalRule: { threshold: FWD_WD_THRESHOLD, amount: FWD_WD_AMOUNT },
    horizons: FWD_HORIZONS.map(h => ({ label: h.label, years: h.years, days: h.days, projected: projFwd[h.days] || null, actual: actFwd[h.days] || null, extrapolated: (actFwd[h.days]?.extrapolated) || false })),
  };

  return {
    anchor: { startDate, startAum: +(+startAum).toFixed(0) },
    current: { date: todayISO, projectedAum: projectedToday, actualAum: +(+nav).toFixed(0), onTrackPct, aheadOfSchedule },
    projected,
    actual: actualSeries.map(s => ({ date: s.date, value: s.actualAum })),
    forward,
    metrics: proj.metrics || null,
    metricsGross: proj.metricsGross || null,   // GROSS tiles (AumTracker renders a 2nd row when present)
    cashLedger: loadCashLedger(),
    meta: {
      backtestStart: proj.backtestStart || null,
      backtestEnd: proj.backtestEnd || null,
      avgHoldDays: proj.avgHoldDays ?? null,
      medianHoldDays: proj.medianHoldDays ?? null,
      actualStart: actualSeries.length ? actualSeries[0].date : null,   // first real AUM snapshot (live tracking start)
      backtestEndNav: projected.length ? projected[projected.length - 1].value : proj.backtestEndNav,
      tradingDays: factors.length, basis: 'pure compounding (no withdrawals)', disclosure: proj.disclosure,
    },
  };
}

// ── EOD DAILY TRADE LOG (IBKR truth) ─────────────────────────────────────────
// Recorded after the close (16:35 ET cron + admin re-record endpoint). One doc
// per trading day in pnthr_tree_daily_log: NAV, every open position with IBKR's
// own marks/unrealized P&L, and every execution IBKR reported that day — split
// STRATEGY (in the Tree book, engine-managed) vs MANUAL (everything else, e.g.
// SPCX/ARM — Scott's discretionary trades). All numbers come from the bridge's
// IBKR snapshot, never from engine records, so the log matches IBKR exactly.
const DAILY_LOG = 'pnthr_tree_daily_log';

export async function recordTreeDailyLog(db) {
  const date = etDateStr();
  const cfg = await getPnthrTreeConfig(db);
  const excl = await engineExclusions(db);
  const snap = (await db.collection('pnthr_ibkr_positions').find({}).sort({ syncedAt: -1 }).limit(1).toArray())[0] || {};
  const nav = await getNav(db);

  // Strategy = an AI-300 name Tree actually trades. ENGINE_EXCLUDE names (SPCX) and any
  // non-AI-300 holding are "manual / off-strategy". Mode-agnostic.
  const isStrategy = (t) => !!AI_META[t] && !excl.has(t);
  // Pull the page's OWN strategy / early / manual classification so the log matches it to
  // the letter. EARLY = a strategy name you bought before the engine's signal (held, not yet
  // at a new 42wk high). Falls back to strategy/manual for any ticker no longer in the book.
  const catByTicker = {};
  try {
    const st = await getPnthrTreeState(db);
    for (const p of (st.manualTrades || [])) catByTicker[p.ticker] = 'manual';
    for (const p of (st.positions || [])) catByTicker[p.ticker] = p.early ? 'early' : 'strategy';
  } catch { /* fall back below */ }
  const categoryOf = (t) => catByTicker[t] || (isStrategy(t) ? 'strategy' : 'manual');

  // Open positions — IBKR's own marks and unrealized P&L, plus the resting stop.
  const stops = {};
  for (const o of (snap.stopOrders || [])) {
    const t = (o.symbol || o.ticker || '').toUpperCase();
    if ((o.action || '').toUpperCase() === 'SELL') stops[t] = Math.max(stops[t] || 0, +o.stopPrice || 0);
  }
  const positions = (snap.positions || []).filter(p => (p.position ?? p.shares) !== 0).map(p => {
    const t = (p.ticker || p.symbol || '').toUpperCase();
    const sh = p.position ?? p.shares;
    const last = +p.marketPrice || 0;
    return {
      ticker: t, company: AI_META[t]?.name || null, sector: AI_META[t]?.sector || null,
      shares: sh, avgCost: +(+p.avgCost).toFixed(2), last: +last.toFixed(2),
      value: +(+p.marketValue || sh * last).toFixed(0),
      pnl: +(+p.unrealizedPNL || 0).toFixed(0),
      pnlPct: p.avgCost > 0 ? +((last / p.avgCost - 1) * 100).toFixed(1) : null,
      stop: stops[t] || null, strategy: isStrategy(t), category: categoryOf(t),
    };
  });
  const openPnl = +positions.reduce((a, p) => a + (p.pnl || 0), 0).toFixed(0);

  // Today's executions, straight from IBKR's reqExecutions feed. The feed can
  // carry the previous session on a no-trade day — filter by the exec timestamp
  // ("YYYYMMDD  HH:MM:SS", TWS-local clock) so only today's fills are logged.
  const ymd = date.replaceAll('-', '');
  const trades = (snap.latestExecutions || [])
    .filter(e => !e.time || String(e.time).replace(/[^0-9]/g, '').startsWith(ymd))
    .map(e => {
      const t = (e.symbol || '').toUpperCase();
      return {
        time: e.time || null, ticker: t, side: e.side === 'SLD' ? 'SELL' : 'BUY',
        shares: +e.shares, price: +(+e.price).toFixed(2), value: +(e.shares * e.price).toFixed(0),
        execId: e.execId || null, strategy: isStrategy(t), category: categoryOf(t),
      };
    });

  const doc = {
    date, recordedAt: new Date(), mode: cfg.mode, nav, openPnl,
    positionsCount: positions.length, positions,
    trades, tradesCount: trades.length,
    earlyTickers: [...new Set(trades.filter(x => x.category === 'early').map(x => x.ticker))],
    manualTickers: [...new Set(trades.filter(x => x.category === 'manual').map(x => x.ticker))],
    nonStrategyTickers: [...new Set(trades.filter(x => !x.strategy).map(x => x.ticker))],
    ibkrSyncedAt: snap.syncedAt || null, execSyncedAt: snap.latestExecSyncedAt || null,
  };
  await db.collection(DAILY_LOG).updateOne({ date }, { $set: doc }, { upsert: true });
  console.log(`[Tree Daily Log] ${date} recorded — NAV $${nav}, ${positions.length} positions, ${trades.length} trades (${doc.nonStrategyTickers.length ? 'manual: ' + doc.nonStrategyTickers.join(', ') : 'all strategy'})`);
  return doc;
}

export async function getTreeDailyLog(db, limit = 30) {
  return db.collection(DAILY_LOG).find({}).sort({ date: -1 }).limit(limit).toArray();
}
