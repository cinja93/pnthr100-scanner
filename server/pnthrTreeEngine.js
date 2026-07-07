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
export const APPROACH_PCT   = 0.01;   // within 1% of the 42wk high → "approaching" (flashing)
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
export async function engineExclusions(db) {
  const out = new Map();
  for (const t of ENGINE_EXCLUDE) out.set(t, 'new IPO — seasoning until ~1yr of bars');
  try { for (const [t, why] of await getSplitExclusions(db)) out.set(t, why); }
  catch (e) { console.error('[Tree] split exclusions unavailable:', e.message); }
  return out;
}

// ── No-buyback list (user-toggled per-ticker "do not re-enter") ───────────────
// Toggled per card on the Tree page. While a ticker is on this list the engine will
// NOT re-enter it (no buyback) — so when you manually sell a name it stays sold. UNLIKE
// ENGINE_EXCLUDE, this is ENTRY-ONLY: any position you still hold is trailed/managed
// normally until you sell it. Toggle off to let the engine buy it again.
const NO_BUYBACK = 'pnthr_tree_no_buyback';
export async function getNoBuybackSet(db) {
  try { return new Set((await db.collection(NO_BUYBACK).find({}).toArray()).map(d => d.ticker)); }
  catch { return new Set(); }
}
export async function setTreeNoBuyback(db, ticker, blocked) {
  const t = String(ticker || '').toUpperCase().trim();
  if (!t) throw new Error('ticker required');
  if (blocked) await db.collection(NO_BUYBACK).updateOne({ ticker: t }, { $set: { ticker: t, blockedAt: new Date() } }, { upsert: true });
  else await db.collection(NO_BUYBACK).deleteOne({ ticker: t });
  return { ticker: t, noBuyback: !!blocked };
}

// Live-vs-stored price sanity net: if the live quote is wildly off the stored
// candle scale (a split the calendar missed, or bad data), DROP the ticker's
// bands so the engine can't enter or trail a stop off bogus levels, and flag
// it for the nightly split re-sync. This is the guard that would have caught
// KLAC even with no calendar (live $241 vs stored ~$2,411).
export function applyPriceSanity(quotes, bands) {
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
export const MAX_GROSS_X    = 2.0;    // gross leverage cap: total long exposure ≤ 2× NAV (Scott 2026-06-11).
                               // WITHOUT this the per-name 2%/10% sizing piles to 4-10× in a broad rally
                               // (backtest: 72%+ drawdown). 2× cap → ~106% CAGR / 55% DD (daily-stop, hypothetical).

export const AI_META = {};
export const AI_TICKERS = (() => {
  const out = [];
  for (const s of AI_SECTORS) for (const h of s.holdings) { out.push(h.ticker); AI_META[h.ticker] = { sector: s.name, name: h.name }; }
  return [...new Set(out)];
})();

// ── NAV (same source the Ambush/Elite pages use) ────────────────────────────
// getNavInfo carries WHERE the number came from. source:'default' means every real
// source failed — the 2026-07-02 corruption incident was this default ($80,200)
// silently sizing orders and being written into the fund-compare history as real
// NAV. Consumers must treat source:'default' as UNTRUSTED: the tick skips entries
// and fund-compare refuses to record the point. (2026-07-06 audit.)
export async function getNavInfo(db) {
  let nav = 80200, source = 'default';
  try {
    // keyed doc first (writes use { key: 'ambush_config' }); tolerate a legacy keyless doc
    const cfg = (await db.collection('pnthr_ambush_config').findOne({ key: 'ambush_config' }))
             || (await db.collection('pnthr_ambush_config').findOne({}));
    if (cfg?.nav > 0) { nav = cfg.nav; source = 'config'; }
    if (cfg?.ownerId) { const p = await getUserProfile(cfg.ownerId); if (p?.accountSize > 0) { nav = p.accountSize; source = 'profile'; } }
    const tcfg = await db.collection(CFG).findOne({});
    if (tcfg?.navOverride > 0) { nav = tcfg.navOverride; source = 'override'; }   // page can set an explicit NAV
  } catch (e) { console.error('[Tree] getNavInfo failed — UNTRUSTED default NAV:', e.message); source = 'default'; }
  return { nav, source, trusted: source !== 'default' };
}
export async function getNav(db) { return (await getNavInfo(db)).nav; }

export async function fetchQuotes(tickers) {
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
export async function priorBands(db, tickers, excl) {
  const today = etDateStr();
  const highs = {}, lows = {}, lastClose = {}, adv = {};
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
    // 20-day average SHARE volume = liquidity rank. Share volume (not dollar) is what the robustness
    // battery validated as the most durable entry-selection signal (best out-of-sample). Drives BOTH the
    // funnel card sort/shade AND the engine's scarce-capital buy priority. Past bars only — executable.
    const av = bars.slice(-20); let vol = 0, n = 0;
    for (const b of av) { const v = +b.volume || 0; if (v > 0) { vol += v; n++; } }
    if (n) adv[d.ticker] = vol / n;
  }
  return { highs, lows, lastClose, adv };
}

export function sizeFor(nav, price, stop) {
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
  const navInfo = await getNavInfo(db);
  const nav = navInfo.nav;
  const excl = await engineExclusions(db);
  const noBuyback = await getNoBuybackSet(db);
  await ensureMirrorMigration(db, cfg, excl);
  const [quotes, bands] = await Promise.all([fetchQuotes(AI_TICKERS), priorBands(db, AI_TICKERS, excl)]);
  for (const f of applyPriceSanity(quotes, bands)) {   // un-tracked split / bad data → manual until re-synced
    excl.set(f.ticker, `live $${f.price} vs stored $${f.lastClose} — data re-sync pending`);
    flagSuspectSplit(db, f.ticker, `Tree state: live $${f.price} vs stored close $${f.lastClose}`).catch(() => {});
  }
  const { highs, lows, adv } = bands;

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
      .map(p => ({ ticker: p.ticker, shares: p.totalShares || p.shares, avgCost: p.avgCost || p.entryPrice, entryPrice: p.entryPrice, createdAt: p.createdAt, stop: p.stop, sim: true }));
  }
  // off-strategy = a held name Tree never trades (ENGINE_EXCLUDE like SPCX, or non-AI-300)
  const offStrategy = (t) => excl.has(t) || !AI_META[t];
  let positions = [], manualTrades = [];
  for (const p of [...realRaw, ...simRaw]) (offStrategy(p.ticker) ? manualTrades : positions).push(p);
  const held = new Set([...realRaw, ...simRaw].map(p => p.ticker));   // everything displayed is "held" for the funnel

  // ATTACK trigger times (written by the 2-min tick) — when each new-high signal first fired.
  const attackSeen = {};
  for (const d of await db.collection('pnthr_tree_attack_seen').find({}).toArray()) attackSeen[d.ticker] = d.firstAttackAt;

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
        adv: adv[t] ?? null, noBuyback: noBuyback.has(t),
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
      attackAt: state === 'attack' ? (attackSeen[t] || null) : null,   // when this new-high signal first fired
      adv: adv[t] ?? null,   // 20-day avg share volume → liquidity rank/gradient + buy priority
      noBuyback: noBuyback.has(t),
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
    p.noBuyback = noBuyback.has(p.ticker);
    const q = quotes[p.ticker]; const basis = p.avgCost || p.entryPrice || 0;
    const fmpLast = q ? +q.price : 0;
    const last = p.real ? (p.ibkrLast || fmpLast || basis) : (fmpLast || basis);
    p.last = last;
    const eng = lows[p.ticker] ? +(lows[p.ticker] - 0.01).toFixed(2) : 0;   // engine's 2-week-low (intended trail)
    const brk = brokerStops[p.ticker] || 0;                                 // your actual resting stop (manual raises included)
    const eff = Math.max(brk, eng, p.stop || 0);   // also honor the engine's stored stop so a paper breakeven-snap (≥ avg cost) shows
    p.stop = eff > 0 ? +eff.toFixed(2) : (p.stop || null);
    p.pnl = p.real ? Math.round(p.ibkrPnl || 0)                            // IBKR truth for real positions → matches your account
                   : +(((last - basis) * (p.shares || p.totalShares || 0))).toFixed(0);
    p.pnlPct = basis ? +((last / basis - 1) * 100).toFixed(1) : 0;
    // PROTECT = effective stop has reached/passed your entry → worst case is a locked profit.
    p.protected = p.stop != null && basis > 0 && p.stop >= basis;
    // Total Risk (heat) = $ you'd give back if stopped from here = (last − stop) × shares; also as % of NAV.
    const shx = p.shares || p.totalShares || 0;
    p.riskNow = (p.stop != null && last > p.stop) ? Math.round((last - p.stop) * shx) : 0;
    p.riskPct = nav > 0 ? +((p.riskNow / nav) * 100).toFixed(2) : 0;
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
    positions.forEach(p => {
      p.newToday = seen[p.ticker] === seenToday; p.seenAt = seenAt[p.ticker] || 0;
      // when the trade occurred: paper → the sim buy's createdAt; real → first-seen-held (best available proxy)
      p.boughtAt = p.sim ? (p.createdAt || null) : (seenAt[p.ticker] ? new Date(seenAt[p.ticker]) : null);
      // when this name first appeared on ATTACK (its 42wk-high trigger time) — preserved while held
      p.attackAt = attackSeen[p.ticker] || null;
    });
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
  // ── Total Risk (heat) roll-up: ACTUAL (your real positions) vs STRATEGY (what the engine's
  //    book carries — the paper sim in paper mode, the real positions once live). $ and % of NAV.
  const sumRisk = (arr) => arr.reduce((a, p) => a + (p.riskNow || 0), 0);
  const actualRiskNow = sumRisk(positions.filter(p => p.real));
  const strategyRiskNow = sumRisk(cfg.mode === 'paper' ? positions.filter(p => p.sim) : positions.filter(p => p.real));
  const totalRisk = {
    actual: actualRiskNow, actualPct: +((actualRiskNow / (nav || 1)) * 100).toFixed(2),
    strategy: strategyRiskNow, strategyPct: +((strategyRiskNow / (nav || 1)) * 100).toFixed(2),
  };
  return {
    mode: cfg.mode, nav, navSource: navInfo.source, navTrusted: navInfo.trusted,
    // fund-compare / recorders need to know the snapshot is real before treating NAV/positions as truth
    snapshotConfirmed: snap.positionsConfirmed === true, snapshotSyncedAt: snap.syncedAt || null,
    funnel, positions, manualTrades, counts, recentStops, treePnl, manualPnl, openPnl, simPnl, totalRisk,
    grossUsed: +grossUsed.toFixed(0), grossX: +(grossUsed / (nav || 1)).toFixed(2), grossCapX: MAX_GROSS_X,
    baselineDrift: cfg.baselineDrift || null,   // drift guard flag — page shows a banner if the backtest baseline went stale
    bridgeHealth: cfg.bridgeHealth || null,     // server-side bridge alarm (2026-07-06) — page banner
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

// ── FILL LEDGER (forward-recording for the Risk Scorecard) ────────────────────
// Persists EVERY entry (BOT) and exit (SLD) fill on a Tree-universe (AI-300) name,
// idempotent by execId, so we can reconstruct each of your real trades — including
// scaling in/out — and score how you managed risk vs the untouched strategy. Best-effort
// on IBKR's execution feed (same source the exit-capture uses); runs every tick so fills
// are caught within ~2 min. Forward-only: it captures from the moment it deploys (your
// fast 3-day flurry before this can't be reconstructed and is intentionally not backfilled).
const FILLS = 'pnthr_tree_fills';
async function captureTreeFills(db, cfg, snap) {
  const ymd = etDateStr().replaceAll('-', '');
  let n = 0;
  for (const e of (snap.latestExecutions || [])) {
    const side = String(e.side || '').toUpperCase();                       // BOT (buy) | SLD (sell)
    if (side !== 'BOT' && side !== 'SLD') continue;
    const t = (e.symbol || '').toUpperCase();
    if (!AI_META[t]) continue;                                             // Tree universe (AI-300) only — what the strategy also trades
    if (e.time && !String(e.time).replace(/[^0-9]/g, '').startsWith(ymd)) continue;   // today's fills only (feed can carry a prior session)
    const r = await db.collection(FILLS).updateOne(
      { execId: e.execId },
      { $setOnInsert: {
          execId: e.execId, ticker: t, side, price: +e.price || 0, shares: Math.abs(+e.shares || 0),
          date: etDateStr(), execTime: e.time || null, mode: cfg.mode, recordedAt: new Date(),
        } },
      { upsert: true },
    );
    if (r.upsertedCount) n++;
  }
  return n;
}

// ── ATTACK trigger-time ledger ───────────────────────────────────────────────
// Records WHEN each name first fired the ATTACK signal (hit a new 42wk high while we don't
// hold it). Written ONLY by the 2-min tick — page-independent, reliable to ~2 min — so the
// trigger time is correct even if no one is viewing the page. getPnthrTreeState only READS it.
// The stamp PERSISTS while the name is held, so its DEVOUR card can show when it first hit
// ATTACK; it clears only once the name is neither firing ATTACK nor held (fully pulled back /
// sold), so a fresh re-entry gets a fresh trigger time.
const ATTACK_SEEN = 'pnthr_tree_attack_seen';
async function stampAttackSeen(db, firedTickers, heldTickers = []) {
  const now = new Date();
  for (const t of firedTickers) await db.collection(ATTACK_SEEN).updateOne({ ticker: t }, { $setOnInsert: { ticker: t, firstAttackAt: now } }, { upsert: true });
  const keep = [...new Set([...firedTickers, ...heldTickers])];   // keep stamps for names still firing OR still held
  await db.collection(ATTACK_SEEN).deleteMany(keep.length ? { ticker: { $nin: keep } } : {});
}

// ── Breakeven-stop snap (NAV-risk reduction) ─────────────────────────────────
// Scott 2026-06-18: once a LONG is up ≥ $250 open profit AND the latest COMPLETED
// hourly bar is green, raise its stop to breakeven (avg cost). Raise-only, and it
// stacks with the 2-week-low trail (highest/tightest stop wins) so the trail keeps
// ratcheting above breakeven afterwards. "Green hour" is confirmed on TWS-matching :00
// CLOCK-hour bars (built from FMP 30-min, the still-forming hour dropped) so it lines up
// with what the chart shows. Green = the completed hour closed at or above its open.
// $250 chosen over $100 on the backtest: robust good/neutral in both the survivorship and
// survivorship-neutral runs, holds CAGR at baseline + nudges Sharpe/PF up, without the heavy
// winner-strangling $100 caused in the (survivorship-flattered) scorecard universe.
export const BE_SNAP_PROFIT = 250;   // $ open profit required before snapping the stop to breakeven
function etTotalMinutesNow(d = new Date()) {
  const p = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d)) p[type] = value;
  return (+p.hour) * 60 + (+p.minute);
}
// true = last COMPLETED clock-hour bar green · false = red · null = no completed hour yet today.
function lastCompletedClockHourGreen(min30, today, nowMin) {
  const byHour = {};
  for (const b of (min30 || [])) {
    if (!b.date || !b.date.startsWith(today)) continue;
    const hr = parseInt(String(b.date).slice(11, 13), 10);
    if (!(hr >= 0)) continue;
    (byHour[hr] = byHour[hr] || []).push(b);
  }
  const done = Object.keys(byHour).map(Number).sort((a, b) => a - b).filter(hr => (hr + 1) * 60 <= nowMin);
  if (!done.length) return null;   // nothing has finished yet today → can't confirm a green hour
  const bs = byHour[done[done.length - 1]].sort((a, b) => a.date.localeCompare(b.date));
  return +bs[bs.length - 1].close >= +bs[0].open;
}
// Map ticker → green?(true/false/null) for the last completed clock hour. Cached ~60s so the
// 2-min tick doesn't hammer FMP; only called for names we actually hold (paper or live).
let _greenHourCache = { at: 0, map: {} };
export async function fetchGreenHourMap(tickers) {
  if (!tickers.length) return {};
  if (Date.now() - _greenHourCache.at < 60_000 && tickers.every(t => t in _greenHourCache.map)) return _greenHourCache.map;
  const today = etDateStr(), nowMin = etTotalMinutesNow(), map = {};
  for (let i = 0; i < tickers.length; i += 5) {
    await Promise.allSettled(tickers.slice(i, i + 5).map(async (t) => {
      try { const data = await fetchFMP(`/historical-chart/30min/${t}`); map[t] = lastCompletedClockHourGreen(Array.isArray(data) ? data : [], today, nowMin); }
      catch { map[t] = null; }
    }));
  }
  _greenHourCache = { at: Date.now(), map };
  return map;
}

// ── PURE: the 2-week (10 trading-day) low stop ───────────────────────────────
// Lowest low of the last STOP_LOOKBACK bars (excluding today's forming bar) minus $0.01 —
// the same rule the AI-300 names use. Returns { ok, stop, low, lastClose, barCount } so the
// caller can gate on history depth (a fresh IPO with < 2 weeks of bars is NOT auto-stopped).
export function tenDayLowStop(bars, todayStr) {
  const clean = (bars || [])
    .filter(b => b && b.date < todayStr && +b.low > 0)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (clean.length < STOP_LOOKBACK) return { ok: false, barCount: clean.length, reason: `only ${clean.length} bar(s), need ${STOP_LOOKBACK}` };
  const window = clean.slice(-STOP_LOOKBACK);
  const low = Math.min(...window.map(b => +b.low));
  return { ok: true, barCount: clean.length, low, lastClose: +clean[clean.length - 1].close, stop: +(low - 0.01).toFixed(2) };
}

// ── PURE: does a naked long fall to the COVERAGE path, and is it a band gap? ─
// The trail loop manages an in-scope (AI-300, non-excluded) long ONLY when priorBands
// produced a 2-week-low band for it. With no band (candle doc missing/empty) the trail
// loop silently skips it, so coverage MUST take it — flagged nakedNoBands so the gap in
// the candle store is surfaced, not just silently patched. (2026-07-06 audit, critical #1.)
export function coverageScope({ inUniverse, excluded, hasBand }) {
  if (inUniverse && !excluded) {
    return hasBand ? { cover: false, nakedNoBands: false }   // trail loop really covers it
                   : { cover: true,  nakedNoBands: true };   // bandless in-scope → cover + surface
  }
  return { cover: true, nakedNoBands: false };               // off-universe / excluded → coverage as designed
}

// ── PURE: should we auto-place this coverage stop? ───────────────────────────
// Gates so we NEVER place a dangerous stop on untrusted data — the safety the engine-exclusion
// gave us, kept as a per-stop check instead of a blanket skip. The stop must be a real number
// BELOW market (a stop at/above price sells you out instantly), and the live price must be sane
// vs the last close (a split/bad-data guard). Returns { place, reason }.
export function coverageStopDecision({ stop, lastPrice, lastClose }) {
  if (!(stop > 0)) return { place: false, reason: 'no valid stop' };
  if (!(lastPrice > 0)) return { place: false, reason: 'no current price' };
  if (stop >= lastPrice) return { place: false, reason: `stop $${stop} >= price $${lastPrice} — data suspect` };
  if (lastClose > 0 && Math.abs(lastPrice - lastClose) / lastClose > 0.5) return { place: false, reason: `price $${lastPrice} vs last close $${lastClose} — split/data suspect` };
  return { place: true, reason: 'ok' };
}

// Daily OHLC for a NON-universe ticker (e.g. GLD) not in the AI candle store. FMP returns
// newest-first; tenDayLowStop sorts ascending so the order here doesn't matter.
async function fetchDailyBarsFMP(ticker) {
  const r = await fetchFMP(`/historical-price-full/${ticker}?timeseries=25`).catch(() => null);
  const hist = (r && r.historical) || [];
  return hist.map(b => ({ date: b.date, high: +b.high, low: +b.low, close: +b.close }));
}

// ── Engine tick — paper records / live places orders on new 42wk highs ───────
export async function runPnthrTreeTick(db) {
  const cfg = await getPnthrTreeConfig(db);
  if (!cfg.mode || cfg.mode === 'off') return { mode: 'off', actions: [] };
  const nav = await getNav(db);
  const excl = await engineExclusions(db);
  const noBuyback = await getNoBuybackSet(db);
  await ensureMirrorMigration(db, cfg, excl);   // one-time: switch to the live-mirror model
  const [quotes, bands] = await Promise.all([fetchQuotes(AI_TICKERS), priorBands(db, AI_TICKERS, excl)]);
  const actions = [];
  for (const f of applyPriceSanity(quotes, bands)) {   // un-tracked split / bad data → hands off until re-synced
    excl.set(f.ticker, 'price/data mismatch');
    actions.push({ type: 'DATA_SANITY_EXCLUDE', ticker: f.ticker, price: f.price, lastClose: f.lastClose });
    await flagSuspectSplit(db, f.ticker, `Tree tick: live $${f.price} vs stored close $${f.lastClose}`).catch(() => {});
  }
  const { highs, lows, adv } = bands;

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

  // ── DOUBLE-ACTION GUARD: in-flight BUY_ENTRY dedup (2026-06-22 AMD incident) ──────
  // The IBKR snapshot's `held` set lags a fill by up to one 60s sync (worse right after
  // a bridge reconnect, when TWS confirmations arrive late). Without this, a second tick
  // saw AMD still "not held" and enqueued a SECOND BUY_ENTRY → 2 lots (32sh), one stop,
  // 16sh naked. Treat any name whose entry is still in flight (PENDING/EXECUTING) or filled
  // within the propagation window as already held, and reserve its exposure so the 2× gross
  // cap can't be breached by entries the snapshot hasn't shown yet. (Live only; paper books
  // its entries straight into POS, already counted in `held` above — the outbox is empty.)
  // Time-bounded so a command stuck PENDING/EXECUTING (e.g. the bridge died mid-flight and
  // the restarted bridge only resumes PENDING, leaving an EXECUTING orphan) can NEVER block a
  // ticker forever — anything older than the window is stale, not in flight. FAILED is excluded
  // so a genuinely failed entry stays retryable.
  const ENTRY_INFLIGHT_MS = 5 * 60 * 1000;   // fill → snapshot propagation window
  const inflightCutoff = new Date(Date.now() - ENTRY_INFLIGHT_MS);
  for (const c of await db.collection('pnthr_ambush_outbox').find({
    command: 'BUY_ENTRY',
    status: { $in: ['PENDING', 'EXECUTING', 'DONE'] },
    createdAt: { $gte: inflightCutoff },
  }).toArray()) {
    const t = (c.request?.ticker || '').toUpperCase();
    if (t && !held.has(t)) { held.add(t); gross += (+c.request?.shares || 0) * (+c.request?.price || 0); }
  }

  // ── ENTRY SAFETY GATE (2026-06-20 audit) — only OPEN new positions when it's safe: ──
  //   (a) inside the 9:30–16:00 ET cash session, computed in ET so it is correct no matter
  //       the host timezone (the cron window is a backstop, not the gate); and
  //   (b) in LIVE mode, only off a FRESH (≤10m) + IBKR-CONFIRMED snapshot — otherwise a stale
  //       or unconfirmed snapshot reads `held` as empty and the engine could re-buy the whole
  //       book, with the reconcile backstop stood down while Tree is live. Stop MANAGEMENT
  //       below is intentionally NOT gated (raise-only; safe on any snapshot, any hour).
  const _etp = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(new Date());
  const _eo = {}; for (const x of _etp) _eo[x.type] = x.value; let _eh = parseInt(_eo.hour, 10); if (_eh === 24) _eh = 0;
  const _etMin = _eh * 60 + parseInt(_eo.minute, 10);
  const inSession = _etMin >= 570 && _etMin <= 960;                  // 9:30 AM – 4:00 PM ET
  const snapAgeMin = snap.syncedAt ? (Date.now() - new Date(snap.syncedAt).getTime()) / 60000 : Infinity;
  const snapFreshConfirmed = snapAgeMin <= 10 && snap.positionsConfirmed === true;
  const entriesAllowed = inSession && (cfg.mode !== 'live' || snapFreshConfirmed);
  if (cfg.mode === 'live' && inSession && !snapFreshConfirmed) {
    actions.push({ type: 'ENTRY_GATE_SKIP', reason: snapAgeMin > 10 ? `snapshot ${snapAgeMin === Infinity ? 'missing' : snapAgeMin.toFixed(0) + 'm stale'}` : 'snapshot unconfirmed' });
  }

  // 1) ENTRIES — names at a NEW 42wk high we don't already hold. Build the qualified ATTACK set,
  // then deploy capital CLOSEST-TO-TRIGGER first, RESIZING the marginal name to fit when capital
  // is tight. This is IDENTICAL to the prior list-order full-size loop whenever capital is
  // plentiful (every name's full size fits → same positions, same sizes; only the enqueue order
  // differs, which can't change the outcome when all are bought). The ranking + resize change the
  // OUTCOME only when capital is CONSTRAINED — i.e. exactly the "a stop-out just freed a few dollars
  // and ATTACK names are waiting to be adopted" case (Scott 2026-06-22). Everything else unchanged:
  // same 42wk-high trigger, same full-size sizing (sizeFor) when affordable, same 2× gross cap,
  // same stop, same entry gate. For a long-only Reg-T account the 2× gross headroom (grossCap −
  // gross) IS the available buying power. [Green-current-hour filter = a separate, backtest-gated
  // addition — NOT wired here yet.]
  const attackFired = [];   // every new-42wk-high name we don't hold (for trigger timestamps), bought or not
  const candidates = [];
  if (entriesAllowed) for (const t of AI_TICKERS) {
    if (held.has(t)) continue;
    if (excl.has(t)) continue;   // manual-only (IPO seasoning / split re-sync pending) → don't trade
    const q = quotes[t]; if (!q) continue;
    const price = +q.price, dayHigh = +q.dayHigh || +q.price;
    const priorHigh = highs[t];   // real prior 42wk high (excl today) = the breakout / trigger price
    if (!(price > 0) || !(priorHigh > 0) || dayHigh < priorHigh + 0.01) continue;   // not a new 42wk high
    attackFired.push(t);
    if (noBuyback.has(t)) { actions.push({ type: 'SKIP_NO_BUYBACK', ticker: t }); continue; }   // user blocked re-entry on this card
    const stop = lows[t] ? +(lows[t] - 0.01).toFixed(2) : null;
    const { shares: fullShares } = stop ? sizeFor(nav, price, stop) : { shares: 0 };
    if (!stop || fullShares < 1) continue;   // unchanged: no valid stop / sub-1-share full size → not a candidate
    candidates.push({ t, price, priorHigh, stop, fullShares, adv: adv[t] ?? 0 });
  }
  // MOST-LIQUID first: when the 2× cap can't fund every same-day breakout, scarce capital goes to the
  // highest 20-day share-volume names first. This replaced closest-to-trigger after a robustness battery
  // (in-sample + out-of-sample on a separate universe) showed liquidity-priority materially beats it
  // (e.g. ~92% vs ~60% CAGR at $100K, and it generalized OOS where closest-trigger did not). Ticker
  // tiebreak = deterministic/reproducible. Matches the funnel card sort so the dark-green card is the
  // one actually bought first. When capital is plentiful every candidate buys full-size regardless of order.
  candidates.sort((a, b) => (b.adv - a.adv) || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  // SMA_BUFFER: a new entry must leave at least this much room under the 2× cap so buying power is
  // never driven to zero (Scott 2026-06-22 — "keep ≥$500 SMA available"). Anchored to the engine's
  // own room (grossCap − gross), computed from live positions + live NAV, because the broker's stored
  // SMA/buyingPower fields are unreliable here. MIN_ENTRY_FRACTION: don't deploy a freed-capital sliver
  // — take ≥ half a full position or leave the name in the pound for a later tick (no dust trades).
  const SMA_BUFFER = 500;
  const MIN_ENTRY_FRACTION = 0.5;
  for (const c of candidates) {
    const room = grossCap - gross - SMA_BUFFER;                          // 2× firm, less the $500 cushion
    const shares = Math.min(c.fullShares, room > 0 ? Math.floor(room / c.price) : 0);   // RESIZE: only ever shrink to fit, never grow
    if (shares < 1 || shares < Math.ceil(c.fullShares * MIN_ENTRY_FRACTION)) {          // too little room for a meaningful position → wait
      actions.push({ type: 'SKIP_GROSS_CAP', ticker: c.t, grossX: +(gross / nav).toFixed(2) });
      continue;
    }
    const resized = shares < c.fullShares;                              // true ONLY in the freed-capital / tight-cap case
    gross += shares * c.price;   // reserve the exposure so the cap holds across this tick's entries

    if (cfg.mode === 'paper') {
      await db.collection(POS).insertOne({
        ticker: c.t, direction: 'LONG', entryPrice: c.price, avgCost: c.price, totalShares: shares, shares,
        stop: c.stop, status: 'ACTIVE', mode: 'paper', source: 'TREE_42WH', entryDate: new Date().toISOString().slice(0, 10), createdAt: new Date(),
      });
      actions.push({ type: 'PAPER_ENTRY', ticker: c.t, shares, price: c.price, stop: c.stop, resized });
    } else if (cfg.mode === 'live') {
      // Bridge BUY_ENTRY places the market buy AND the protective stop in one command (Ambush shape).
      // Requires the bridge running + draining the outbox, and the Ambush engine OFF (no reconcile contention).
      await enqueueAmbushOrder(db, 'BUY_ENTRY', { ticker: c.t, shares, price: c.price, direction: 'LONG', stopPrice: c.stop, source: 'TREE_42WH' });
      actions.push({ type: 'LIVE_ENTRY_ENQUEUED', ticker: c.t, shares, price: c.price, stop: c.stop, resized });
    }
  }

  await stampAttackSeen(db, attackFired, [...held]).catch((e) => console.error('[Tree] attack-seen stamp failed:', e.message));

  // 2) MANAGE — trail the 2-week stop; paper exits on stop (live stops rest at the broker)
  if (cfg.mode === 'paper') {
    const todayStr = etDateStr();
    const active = await db.collection(POS).find({ status: 'ACTIVE' }).toArray();
    const greenHour = await fetchGreenHourMap([...new Set(active.map(p => p.ticker))]).catch(() => ({}));
    for (const p of active) {
      const q = quotes[p.ticker]; if (!q) continue;
      const price = +q.price, dayLow = +q.dayLow || price;
      const sh = p.totalShares || p.shares || 0;
      const newStop = lows[p.ticker] ? +(lows[p.ticker] - 0.01).toFixed(2) : p.stop;
      // Breakeven snap: ≥ $100 open profit AND last completed hour green → raise stop to avg cost.
      const openPnl = (price - p.avgCost) * sh;
      const beStop = (openPnl >= BE_SNAP_PROFIT && greenHour[p.ticker] === true && p.avgCost > 0) ? +(+p.avgCost).toFixed(2) : 0;
      const trailed = Math.max(p.stop || 0, newStop || 0, beStop);
      // Raising the stop above an intraday low arms it FORWARD-ONLY (matches a live resting stop:
      // it can't fire on a low that printed before the stop was raised there). beArmedDate persists
      // that for the rest of the day; it resets next session when dayLow is fresh.
      const raisedAboveLow = trailed > (p.stop || 0) && trailed > dayLow;
      const upd = {};
      if (trailed !== p.stop) upd.stop = trailed;
      if (raisedAboveLow) upd.beArmedDate = todayStr;
      if (Object.keys(upd).length) await db.collection(POS).updateOne({ _id: p._id }, { $set: upd });
      if (beStop && trailed === beStop && (p.stop || 0) < beStop) actions.push({ type: 'BE_SNAP', ticker: p.ticker, stop: beStop, openPnl: Math.round(openPnl) });
      // Exit: forward-only (current price) while armed today; otherwise any intraday touch of the stop.
      const armedToday = (raisedAboveLow ? todayStr : p.beArmedDate) === todayStr;
      const stopHit = armedToday ? (price <= trailed) : (dayLow <= trailed);
      if (stopHit) {
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
    const liveLongs = (snap.positions || []).filter(p => { const t = (p.ticker || p.symbol || '').toUpperCase(); const sh = p.position ?? p.shares; return AI_META[t] && sh > 0 && !excl.has(t); });
    const greenHour = await fetchGreenHourMap([...new Set(liveLongs.map(p => (p.ticker || p.symbol || '').toUpperCase()))]).catch(() => ({}));
    // ── DOUBLE-ACTION GUARD: in-flight MODIFY_STOP dedup (2026-06-22 STX/ALAB incident) ──
    // The bridge places a stop as "cancel-all then place". When TWS confirms the place LATE
    // (post-reconnect congestion) the bridge reports FAILED though the stop rests, and `cur`
    // below (read from the lagging snapshot) still shows the OLD low level — so the next tick
    // re-enqueued the same raise and the bridge stacked another resting stop (STX = ~8 copies
    // @ $1063.45 against 8 shares → over-sell-flip risk). Skip enqueuing when an equal-or-higher
    // raise for this name is already PENDING/EXECUTING; once it clears and the snapshot reflects
    // it, `cur` rises and the (target > cur) test naturally stops re-enqueuing.
    // Cover PENDING/EXECUTING AND recently-DONE raises: a late-confirmed place is marked DONE,
    // but `cur` (from the lagging snapshot) can still show the old level for up to one sync — so
    // without the recent-DONE window a re-enqueue would still slip through and stack a duplicate.
    const pendingStop = {};
    for (const c of await db.collection('pnthr_ambush_outbox').find({
      command: 'MODIFY_STOP',
      status: { $in: ['PENDING', 'EXECUTING', 'DONE'] },
      createdAt: { $gte: inflightCutoff },   // same time bound: a stuck command can't freeze a ticker's trailing
    }).toArray()) {
      const t = (c.request?.ticker || '').toUpperCase();
      if (t) pendingStop[t] = Math.max(pendingStop[t] || 0, +c.request?.newStopPrice || 0);
    }
    // Recent in-flight CANCEL_ORDER permIds, so the dup-trim never re-enqueues a cancel that's
    // already working through the bridge (idempotent at the bridge, but this avoids outbox churn).
    const pendingCancel = new Set();
    for (const c of await db.collection('pnthr_ambush_outbox').find({
      command: 'CANCEL_ORDER',
      status: { $in: ['PENDING', 'EXECUTING', 'DONE'] },
      createdAt: { $gte: inflightCutoff },
    }).toArray()) {
      const pid = c.request?.permId; if (pid != null) pendingCancel.add(String(pid));
    }
    // Stop MANAGEMENT acts on resting-order state, so it requires a FRESH + IBKR-CONFIRMED
    // snapshot (same bar the entry gate uses). On a stale/unconfirmed snapshot the stop list
    // can't be trusted — trailing or cancelling off it could stack or strip a stop — so we wait
    // a tick. Stops already rest at the broker; skipping a tick never leaves a position naked.
    if (cfg.mode === 'live' && !snapFreshConfirmed) {
      actions.push({ type: 'STOP_MANAGE_SKIP_STALE', snapAgeMin: snapAgeMin === Infinity ? null : +snapAgeMin.toFixed(0) });
    }
    for (const p of (snapFreshConfirmed ? (snap.positions || []) : [])) {
      const t = (p.ticker || p.symbol || '').toUpperCase(); const sh = p.position ?? p.shares;
      if (!AI_META[t] || !(sh > 0)) continue;
      if (excl.has(t)) continue;   // split-stale / IPO → DON'T touch stops (could be at the wrong scale, above market)

      // Every SELL protective stop resting on this name, with full identity. A stop is CANCELLABLE
      // only when it is BOUND — i.e. it carries a NON-ZERO orderId. The bridge cancels by orderId;
      // an orderId-0 order is UNBOUND (one TWS handed back after its nightly restart, orderId + PNTHR
      // tag stripped) and UNCANCELLABLE via the API (the bridge hits TWS error 10147 and reports a
      // FALSE "already gone"). NOTE: a bound orderId can be NEGATIVE — when TWS's "Use negative
      // numbers to bind automatic orders" is on, client-0 binding assigns negative ids — and a
      // negative id is still bound/cancellable. So the orphan test is strictly orderId === 0, never
      // "> 0". Trying to "cancel + replace" an orphan is exactly what stacked the duplicate stops on
      // 2026-06-23 (KLAC/LRCX/AMAT/AMKR/APH: a fresh tagged stop placed atop an uncancellable orphan
      // = two full-size SELL stops → over-sell/flip risk). So an unbound orphan is treated as a FIXED
      // protective floor: keep it, never place a second stop on top, surface it. Once the bridge
      // (client 0) binds it, orderId becomes non-zero and trailing/trim resumes automatically.
      const stops = (snap.stopOrders || [])
        .filter(o => (o.symbol || o.ticker || '').toUpperCase() === t && (o.action || '').toUpperCase() === 'SELL')
        .map(o => ({ permId: o.permId, orderId: Number(o.orderId) || 0, price: +o.stopPrice || 0 }))
        .filter(o => o.price > 0);
      const cur = stops.reduce((m, o) => Math.max(m, o.price), 0);
      const hasOrphan = stops.some(o => o.orderId === 0);   // unbound (orderId 0) = uncancellable

      // ── DUP TRIM: enforce EXACTLY ONE protective stop = the TIGHTEST (highest for a long). ─────
      // Cancel every OTHER cancellable stop (real orderId) by permId — auto-heals a cancellable
      // duplicate the moment the snapshot shows it. The tightest is ALWAYS kept, so protection is
      // never loosened. A non-tightest ORPHAN can't be cancelled here; it is flagged for a manual
      // clear. (Mirrors the proven Ambush V7.6 trim — server/ambush/ambushCron.js ~L1552.)
      if (stops.length > 1) {
        const tightest = stops.reduce((best, o) => (o.price > best.price ? o : best), stops[0]);
        for (const o of stops) {
          if (o.permId === tightest.permId) continue;
          if (o.orderId === 0) { actions.push({ type: 'ORPHAN_STOP_UNCANCELLABLE', ticker: t, price: o.price }); continue; }   // unbound → can't cancel; flag it
          if (o.permId != null && pendingCancel.has(String(o.permId))) continue;
          await enqueueAmbushOrder(db, 'CANCEL_ORDER', { ticker: t, permId: o.permId, reason: 'TREE_DUP_PROTECTIVE_STOP' });
          actions.push({ type: 'CANCEL_DUP_STOP', ticker: t, permId: o.permId, price: o.price });
        }
      }

      // ── TRAIL: raise the protective stop to the current target (2-week low or breakeven snap). ─
      const lowStop = lows[t] ? +(lows[t] - 0.01).toFixed(2) : 0;
      // Breakeven snap: ≥ $100 open profit AND last completed hour green → raise stop to avg cost.
      const avgCost = +p.avgCost || +p.avgPrice || 0, px = +quotes[t]?.price || 0;
      const beStop = (avgCost > 0 && px > 0 && (px - avgCost) * sh >= BE_SNAP_PROFIT && greenHour[t] === true) ? +avgCost.toFixed(2) : 0;
      const target = Math.max(lowStop, beStop);
      if (!target || target <= cur + 0.01) continue;   // broker stops are forward-only; nothing tighter to do
      // ORPHAN GUARD: an uncancellable orphan already rests here. We can't cancel it, so placing
      // our tighter stop would STACK a second full-size order → over-sell/flip risk. Hold the line:
      // keep the single orphan as the floor and surface it. (Cleared in TWS, or by the bridge
      // re-adopt fix, trailing then resumes on the next tick.)
      if (hasOrphan) {
        actions.push({ type: 'TRAIL_BLOCKED_BY_ORPHAN', ticker: t, orphanStop: cur, wanted: target });
        continue;
      }
      if ((pendingStop[t] || 0) >= target - 0.01) {   // an equal-or-higher raise is already in flight → don't stack
        actions.push({ type: 'STOP_INFLIGHT_SKIP', ticker: t, queued: pendingStop[t], target });
        continue;
      }
      const beSnap = beStop && target === beStop && beStop > lowStop;
      await enqueueAmbushOrder(db, 'MODIFY_STOP', { ticker: t, direction: 'LONG', newStopPrice: target, shares: sh, reason: beSnap ? 'TREE_BE_SNAP' : 'TREE_TRAIL' });
      actions.push({ type: beSnap ? 'LIVE_BE_SNAP' : 'LIVE_TRAIL', ticker: t, newStop: target, from: cur });
    }

    // ── NAKED-POSITION STOP COVERAGE (Scott 2026-06-26) ──────────────────────────────────────
    // ANY held long with no protective stop gets the 2-week-low − $0.01 stop — including
    // non-universe names (GLD) and engine-excluded names (SPCX) that the AI-300 trail loop above
    // intentionally skips. Self-healing each tick. The exclusion's safety (never place a wrong-
    // scale stop on untrusted IPO/split data) is preserved as a per-stop GATE: we place ONLY a
    // sane stop (full 2-week window, below market, price not split-suspect); otherwise we flag it
    // and leave the position for manual handling rather than place a dangerous stop. Uses
    // MODIFY_STOP — the same place-or-replace path the trail loop already uses to put a fresh stop
    // on a naked AI-300 name, so this is a proven enqueue, just widened to all held names.
    if (snapFreshConfirmed) {
      const covToday = etDateStr();
      const haveStop = new Set((snap.stopOrders || [])
        .filter(o => (o.action || '').toUpperCase() === 'SELL' && +o.stopPrice > 0)
        .map(o => (o.symbol || o.ticker || '').toUpperCase()));
      for (const p of (snap.positions || [])) {
        const t = (p.ticker || p.symbol || '').toUpperCase(); const sh = p.position ?? p.shares;
        if (!(sh > 0) || haveStop.has(t)) continue;                 // not a naked long
        // In-scope names are covered by the trail loop above ONLY when it has a 2-week-low band
        // for them. A held AI-300 name with NO stored bands (candle doc missing/empty — e.g. a
        // new universe member bought before its backfill landed, or a wiped doc) silently falls
        // out of the trail loop (target=0 → continue) — so it MUST fall through to this coverage
        // path, which re-derives the stop from the candle store or a fresh FMP pull and gates it.
        const scope = coverageScope({ inUniverse: !!AI_META[t], excluded: excl.has(t), hasBand: lows[t] > 0 });
        if (!scope.cover) continue;
        if (scope.nakedNoBands) actions.push({ type: 'NAKED_NO_BANDS', ticker: t });
        if ((pendingStop[t] || 0) > 0) { actions.push({ type: 'COVERAGE_INFLIGHT_SKIP', ticker: t }); continue; }
        // 2-week low: AI candle store first (covers excluded in-universe names like SPCX, which
        // priorBands skips), else a fresh FMP pull (non-universe names like GLD).
        let bars = null;
        const doc = await db.collection('pnthr_ai_bt_candles').findOne({ ticker: t }, { projection: { daily: 1 } });
        bars = doc?.daily?.length ? doc.daily : await fetchDailyBarsFMP(t);
        const low = tenDayLowStop(bars, covToday);
        if (!low.ok) { actions.push({ type: 'COVERAGE_SKIP', ticker: t, reason: low.reason }); continue; }
        let price = +quotes[t]?.price || 0;
        if (!(price > 0)) { const q = await fetchQuotes([t]).catch(() => ({})); price = +q[t]?.price || 0; }
        const dec = coverageStopDecision({ stop: low.stop, lastPrice: price, lastClose: low.lastClose });
        if (!dec.place) { actions.push({ type: 'COVERAGE_SKIP', ticker: t, stop: low.stop, price, reason: dec.reason }); continue; }
        await enqueueAmbushOrder(db, 'MODIFY_STOP', { ticker: t, direction: 'LONG', newStopPrice: low.stop, shares: Math.abs(sh), reason: 'TREE_NAKED_COVERAGE' });
        pendingStop[t] = low.stop;   // reserve so a second naked name this tick can't race a duplicate
        actions.push({ type: 'COVERAGE_STOP_PLACED', ticker: t, stop: low.stop, shares: Math.abs(sh), price });
      }
    }
  }
  // Stop-out capture (exec-driven, reads your real SELL fills) — runs in BOTH paper and live
  // so a real stop-out shows as a red "recently stopped" card either way. Enqueues NOTHING;
  // in paper this is the only thing that touches the real account, and it is read-only.
  try { const n = await captureTreeStopOuts(db, cfg, snap, lows, excl); if (n) actions.push({ type: 'STOP_OUTS_RECORDED', count: n }); }
  catch (e) { console.error('[Tree] stop-out capture failed:', e.message); }
  // Fill ledger (entries + exits) for the Risk Scorecard — forward-recording, both modes, read-only.
  try { const n = await captureTreeFills(db, cfg, snap); if (n) actions.push({ type: 'FILLS_RECORDED', count: n }); }
  catch (e) { console.error('[Tree] fill capture failed:', e.message); }

  await db.collection(CFG).updateOne({}, { $set: { lastTick: new Date(), lastActions: actions.slice(0, 50) } }, { upsert: true });
  return { mode: cfg.mode, actions };
}

// ── Reset paper book (FULL fresh start) ──────────────────────────────────────
// Wipes everything that makes a paper name look "in progress" so every stock
// falls back to Approaching/Attack with nothing blocked. PAPER-ONLY and
// ticker-state — never touches live positions/trades (mode:'paper' scoped where
// the collection carries a mode; the seen/attack-seen/no-buyback collections are
// ticker-keyed funnel state with no live counterpart while flat).
export async function resetPnthrTreePaper(db) {
  const a = await db.collection(POS).deleteMany({ mode: 'paper' });          // held paper cards
  const b = await db.collection(TRADES).deleteMany({ mode: 'paper' });       // paper trade log
  const c = await db.collection(EXITS).deleteMany({ mode: 'paper' });        // 24h "recently stopped" paper cards
  const d = await db.collection(NO_BUYBACK).deleteMany({});                  // un-block every NO BUYBACK toggle
  const e = await db.collection('pnthr_tree_seen').deleteMany({});           // clear NEW-badge history
  const f = await db.collection('pnthr_tree_attack_seen').deleteMany({});    // clear attack-since timestamps
  return {
    positions:  a.deletedCount,
    trades:     b.deletedCount,
    exits:      c.deletedCount,
    noBuyback:  d.deletedCount,
    seen:       e.deletedCount,
    attackSeen: f.deletedCount,
  };
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
export function etDateStr(d = new Date()) {
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

// opts (all optional — defaults reproduce the house/admin book exactly):
//   nav      — override the NAV (paper books pass their own marked-to-market NAV)
//   cfgColl  — config collection that holds the projection anchor (per-book for paper)
//   aumColl  — actual-AUM series collection (per-book for paper)
//   noCashLedger — paper books suppress the house cash-banking ledger (it's Scott's, not theirs)
export async function getPnthrTreeProjection(db, opts = {}) {
  const cfgColl = opts.cfgColl || CFG;
  const aumColl = opts.aumColl || 'pnthr_tree_aum';
  const proj = loadTreeBaseline();
  const factors = proj.factors || [];
  const nav = opts.nav != null ? opts.nav : await getNav(db);
  const todayISO = etDateStr();

  // anchor: lock the projection start (date + AUM) on first call
  const cfg = (await db.collection(cfgColl).findOne({})) || {};
  let startDate = cfg.projectionStartDate, startAum = cfg.projectionStartAum;
  if (!startDate || !startAum) {
    startDate = todayISO; startAum = nav;
    await db.collection(cfgColl).updateOne({}, { $set: { projectionStartDate: startDate, projectionStartAum: startAum } }, { upsert: true });
  }

  // record today's actual NAV, then read the actual series
  await db.collection(aumColl).updateOne({ date: todayISO }, { $set: { date: todayISO, actualAum: nav } }, { upsert: true });
  const actualSeries = await db.collection(aumColl).find({}).sort({ date: 1 }).toArray();

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
  // "If we keep pace with the plan from here" — extend the ACTUAL line forward (dotted green on
  // the chart) starting at TODAY's real AUM (nav) and compounding at the same backtest daily CAGR.
  // Anchored at your current (ahead/behind) point, so it runs parallel to the blue, offset by how
  // far ahead you are today. (Once there's enough live history we can switch this to your OWN
  // realized pace — for now 5 days is too short to annualize.)
  const actualProjected = projected.slice(elapsed).map((p, k) => ({ date: p.date, value: +(nav * Math.pow(dailyCagr, k)).toFixed(0) }));
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
    actualProjected,   // dotted green: keep-pace-with-the-plan from today's actual AUM
    forward,
    metrics: proj.metrics || null,
    metricsGross: proj.metricsGross || null,   // GROSS tiles (AumTracker renders a 2nd row when present)
    metricsNetFees: proj.metricsNetFees || null,  // NET after PPM fund fees (Filet) — the true investor net (matches the IR)
    cashLedger: opts.noCashLedger ? null : loadCashLedger(),
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
