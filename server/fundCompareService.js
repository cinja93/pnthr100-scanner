// server/fundCompareService.js
// ── FUND COMPARISON — Tree (LIVE) vs Elite (PAPER) vs AI Sector Momentum (PAPER) ──
//
// Investor-facing side-by-side comparison. All three start from ONE common NAV
// baseline locked on Monday 2026-06-22 (= Tree's real Monday NAV); each fund's
// forward % return is tracked from there. No backfill — every point is captured
// live going forward. Reuses the canonical hedge-fund metric functions in
// irLiveService.js (computeSide for risk-adjusted metrics, computeTradeStats for
// trade stats) so all three are measured identically.
//
// COMPLIANCE: Elite + AI Sector Momentum are SIMULATED (paper) — flagged simulated:true. Past /
// simulated performance does not guarantee future results. The dashboard renders the
// mandatory hypothetical-performance disclaimers around this data.
// ────────────────────────────────────────────────────────────────────────────
import { connectToDatabase, getUserProfile } from './database.js';
import { computeSide, computeTradeStats } from './irLiveService.js';
import { getElitePositions } from './eliteAiEngine.js';
import { getSectorRotationPaperPositions } from './sectorRotationPaperEngine.js';
import { getPnthrTreeState } from './pnthrTreeEngine.js';
import { getPaperBookState } from './treePaperBook.js';
import { getHandsOffBand } from './backtest/treePaperReconstruction.js';

// Position → slim card (module-level so both the house and per-member builders share it).
// Direction: explicit field when set, else infer from share sign (Tree is long-only, stores none).
function slimPos(p) {
  const sh = +(p.totalShares ?? p.shares ?? 0);
  const direction = (String(p.direction || '').toUpperCase() === 'SHORT' || sh < 0) ? 'SHORT' : 'LONG';
  return { ticker: p.ticker, direction, avgCost: +(+(p.avgCost ?? p.entryPrice ?? 0)).toFixed(2),
    last: +(+(p.currentPrice ?? p.last ?? p.avgCost ?? 0)).toFixed(2), shares: Math.abs(sh),
    pnl: Math.round(+(p.livePnl ?? p.pnl ?? 0)), stop: +(+(p.stop ?? p.stopPrice ?? 0)).toFixed(2) };
}

const CFG = 'pnthr_fund_compare_config';
const DAILY = 'pnthr_fund_compare_daily';
const START_DATE = '2026-06-22';     // common comparison start (Monday — Tree's first live trading day)
const MIN_RISK_POINTS = 15;          // ~3 weeks of daily points before Sharpe/DD/etc. are meaningful

function todayET() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }

async function realNav(db) {
  let nav = 0;
  try {
    const cfg = await db.collection('pnthr_ambush_config').findOne({});
    if (cfg?.nav > 0) nav = cfg.nav;
    if (cfg?.ownerId) { const p = await getUserProfile(cfg.ownerId); if (p?.accountSize > 0) nav = p.accountSize; }
  } catch { /* ignore */ }
  return nav;
}

// Normalize any engine's trade docs into the shape computeTradeStats expects.
function normTrades(trades) {
  return (trades || []).map(t => ({
    entryDate: t.entryDate, exitDate: t.exitDate, exitReason: t.exitReason || 'STOP', signal: t.signal || 'BL',
    netDollarPnl: +t.pnl || 0, grossDollarPnl: +t.pnl || 0,
  }));
}

// Average holding days of WINNING closed trades (matches the tearsheet "avg winner hold").
function avgWinnerHold(trades) {
  const wins = (trades || []).filter(t => (+t.netDollarPnl || 0) > 0 && t.entryDate && t.exitDate);
  if (!wins.length) return null;
  const days = wins.map(t => Math.max(0, (new Date(t.exitDate) - new Date(t.entryDate)) / 86400000));
  return +(days.reduce((s, d) => s + d, 0) / days.length).toFixed(1);
}

// Only the always-on Render writer may mutate the daily series / baselines from a
// GET (2026-07-06 audit: a local dev server pointed at Atlas could record a day's
// equity from stale quotes — the same two-writer class the tick's gate closes).
const IS_WRITER = process.env.RECONCILIATION_CRON_ENABLED === 'true' || process.env.AMBUSH_CRON_ENABLED === 'true';

// Risk-adjusted metrics from a daily equity series — only once it's long enough to
// be meaningful; otherwise a 'building' placeholder (honest small-sample handling).
// Rows flagged corrupt:true (the quarantined 2026-06-22→07-02 Tree window) are excluded.
function riskMetrics(series) {
  const pts = (series || []).filter(s => s.equity > 0 && !s.corrupt);
  if (pts.length < MIN_RISK_POINTS) {
    return { status: 'building', points: pts.length, need: MIN_RISK_POINTS };
  }
  try {
    const m = computeSide(pts.map(s => ({ date: s.date, equity: s.equity })), 'equity');
    return { status: 'ready', sharpe: m.sharpe, sortino: m.sortino, maxDD: m.maxDD, calmar: m.calmar,
      cagr: m.cagr, recoveryFactor: m.recoveryFactor, positiveMonthsPct: m.positivePct,
      ulcerIndex: m.ulcerIndex, timeUnderWater: m.timeUnderWater, equityCurve: m.equityCurve };
  } catch { return { status: 'building', points: pts.length, need: MIN_RISK_POINTS }; }
}

const _cache = { at: 0, data: null };

export async function getFundComparison() {
  if (_cache.data && Date.now() - _cache.at < 8000) return _cache.data;   // bound 10s-poll cost
  const db = await connectToDatabase();
  if (!db) return { error: 'NO_DB' };
  const today = todayET();
  const started = today >= START_DATE;

  // ── Gather each fund's live state ──────────────────────────────────────────
  // Tree (house book — real account): real positions + real account NAV.
  let tree = { positions: [], nav: 0, openPnl: 0, totalRisk: { actual: { dollars: 0 } } };
  try { tree = await getPnthrTreeState(db); } catch { /* leave default */ }
  const treeMode = tree?.mode || 'off';
  // NAV is TRUSTED only when it came from a real source (not the hardcoded default)
  // — the 2026-07-02 corruption was the $80,200 default recorded as real equity.
  const treeNavTrusted = tree?.navTrusted === true && tree?.nav > 0;
  const treeNav = treeNavTrusted ? tree.nav : (await realNav(db));
  const treePos = (tree?.positions || []).filter(p => p.real);
  const treeOpenPnl = tree?.treePnl ?? tree?.openPnl ?? treePos.reduce((s, p) => s + (+p.pnl || 0), 0);
  const treeRisk = tree?.totalRisk?.actual?.dollars ?? treePos.reduce((s, p) => s + Math.abs(((+p.last || +p.avgCost) - (+p.stop || 0)) * (+p.shares || 0)), 0);

  // Elite (PAPER)
  const elitePos = await getElitePositions().catch(() => []);
  const eliteClosed = await db.collection('pnthr_elite_trades').find({}).toArray();
  const eliteOpenPnl = elitePos.reduce((s, p) => s + (+p.livePnl || 0), 0);
  const eliteRealized = eliteClosed.reduce((s, t) => s + (+t.pnl || 0), 0);
  const eliteTotalPnl = eliteOpenPnl + eliteRealized;
  const eliteRisk = elitePos.reduce((s, p) => s + Math.abs(((+p.avgCost || +p.entryPrice) - (+p.stop || +p.stopPrice || 0)) * (+p.totalShares || 0)), 0);

  // AI Sector Momentum (PAPER) — 6mo momentum, top-2/sector, quarterly. Forward-live from 2026-07-10.
  const srPos = await getSectorRotationPaperPositions().catch(() => []);
  const srClosed = await db.collection('pnthr_sectrot_paper_trades').find({}).toArray();
  const srOpenPnl = srPos.reduce((s, p) => s + (+p.livePnl || 0), 0);
  const srRealized = srClosed.reduce((s, t) => s + (+t.pnl || 0), 0);
  const srTotalPnl = srOpenPnl + srRealized;

  // PNTHR Tree — HANDS-OFF PAPER book (house, no-intervention). Forward-live paper book
  // (reuses treePaperBook), included ONLY when the house treeOnly book is registered so a
  // read never auto-creates a mis-seeded book. Plus the stored hypothetical reconstruction band.
  const houseOwner = String((await db.collection('pnthr_ambush_config').findOne({}, { projection: { ownerId: 1 } }))?.ownerId || '');
  const houseBook = houseOwner ? await db.collection('pnthr_tree_books').findOne({ ownerId: houseOwner, treeOnly: true }) : null;
  const treePaperState = houseBook ? await getPaperBookState(db, houseOwner).catch(() => null) : null;
  const treePaperNav = treePaperState?.nav || 0;
  const treePaperTradesC = houseOwner ? `pnthr_tree_trades__${houseOwner}` : null;
  const reconBand = await getHandsOffBand(db).catch(() => null);

  // ── Lock the common baseline on the first call on/after Monday ─────────────
  let cfg = await db.collection(CFG).findOne({ key: 'fund_compare' });
  if (started && (!cfg || !cfg.locked) && IS_WRITER) {
    cfg = { key: 'fund_compare', locked: true, startDate: today, baselineNav: treeNav || 100000,
      treeBaselineNav: treeNav, eliteBaselinePnl: eliteTotalPnl, lockedAt: new Date() };
    await db.collection(CFG).updateOne({ key: 'fund_compare' }, { $set: cfg }, { upsert: true });
  }
  const baselineNav = cfg?.baselineNav || treeNav || 100000;

  // ── Current equity per fund (forward from the common baseline) ─────────────
  const treeEquity   = started && cfg ? baselineNav + (treeNav - (cfg.treeBaselineNav || treeNav)) : treeNav;
  const eliteEquity  = started && cfg ? baselineNav + (eliteTotalPnl - (cfg.eliteBaselinePnl || 0)) : baselineNav;
  const sectrotEquity = started && cfg ? baselineNav + (srTotalPnl - (cfg.sectrotBaselinePnl || 0)) : baselineNav;
  // Hands-off Tree paper book is seeded at the $89,882 baseline and marks itself to market,
  // so its NAV IS its equity on the common scale (forward-only — begins the day it was stood up).
  const treePaperEquity = treePaperState ? treePaperNav : baselineNav;
  const pct = (eq) => baselineNav > 0 ? +(((eq / baselineNav) - 1) * 100).toFixed(2) : 0;

  // Fund fees applied uniformly so the comparison shows "what an investor keeps" — the same
  // basis as the Tree tearsheet: 2% annual management + 30% performance (Filet tier, the
  // ~$89k baseline's tier), with the start NAV as the high-water mark (perf fee only on gains).
  const FEE_MGMT = 0.02, FEE_PERF = 0.30;
  const elapsedDays = (started && cfg?.startDate) ? Math.max(0, (new Date(today) - new Date(cfg.startDate)) / 86400000) : 0;
  const pctNet = (eq) => {
    if (baselineNav <= 0) return 0;
    const grossPnl = eq - baselineNav;
    const mgmt = baselineNav * FEE_MGMT * (elapsedDays / 365);
    const afterMgmt = grossPnl - mgmt;
    const perf = afterMgmt > 0 ? afterMgmt * FEE_PERF : 0;
    return +(((grossPnl - mgmt - perf) / baselineNav) * 100).toFixed(2);
  };

  // ── One-time quarantine of the corrupted Tree window (2026-06-22 → 2026-07-02) ──
  // Mode toggles + the 6/23 full liquidation booked at $0 P&L + default-NAV fallbacks
  // corrupted the recorded tree equity in this window. Rows are FLAGGED (never deleted —
  // audit trail) and excluded from risk metrics; the payload discloses the window.
  const TREE_CORRUPT_FROM = '2026-06-22', TREE_CORRUPT_TO = '2026-07-02';
  if (IS_WRITER && !cfg?.treeCorruptQuarantined) {
    await db.collection(DAILY).updateMany(
      { fund: 'tree', date: { $gte: TREE_CORRUPT_FROM, $lte: TREE_CORRUPT_TO } },
      { $set: { corrupt: true, corruptReason: 'mode toggles + 6/23 liquidation booked $0 P&L + default-NAV fallback (2026-07-06 audit)' } });
    await db.collection(CFG).updateOne({ key: 'fund_compare' }, { $set: { treeCorruptQuarantined: true } }, { upsert: true });
  }

  // ── Record today's equity point per fund (one row per fund per day) ────────
  // Writer-gated, and the tree point is recorded ONLY off a trusted NAV with a
  // confirmed IBKR snapshot — a fallback/default NAV must never enter the history.
  if (started && IS_WRITER) {
    const rows = [['elite', eliteEquity], ['sectrot', sectrotEquity]];
    if (treeNavTrusted && tree?.snapshotConfirmed) rows.push(['tree', treeEquity]);
    else console.warn(`[FundCompare] tree equity point SKIPPED — navTrusted=${treeNavTrusted} snapshotConfirmed=${tree?.snapshotConfirmed}`);
    if (treePaperState) rows.push(['treePaper', treePaperEquity]);   // only once the house book is live
    for (const [fund, eq] of rows) {
      await db.collection(DAILY).updateOne({ fund, date: today }, { $set: { fund, date: today, equity: +(+eq).toFixed(2), updatedAt: new Date() } }, { upsert: true });
    }
  }
  async function series(fund) {
    return (await db.collection(DAILY).find({ fund }, { projection: { _id: 0, date: 1, equity: 1, corrupt: 1 } }).sort({ date: 1 }).toArray());
  }

  // ── Assemble per-fund payload ──────────────────────────────────────────────
  // Direction: use the explicit field when set, else infer from the share sign. Tree is
  // long-only and stores no `direction` (shares > 0) — without this it mis-renders as short.
  const slim = (p) => {
    const sh = +(p.totalShares ?? p.shares ?? 0);
    const direction = (String(p.direction || '').toUpperCase() === 'SHORT' || sh < 0) ? 'SHORT' : 'LONG';
    return { ticker: p.ticker, direction, avgCost: +(+(p.avgCost ?? p.entryPrice ?? 0)).toFixed(2),
      last: +(+(p.currentPrice ?? p.last ?? p.avgCost ?? 0)).toFixed(2), shares: Math.abs(sh),
      pnl: Math.round(+(p.livePnl ?? p.pnl ?? 0)), stop: +(+(p.stop ?? p.stopPrice ?? 0)).toFixed(2) };
  };
  const recent = (trades) => normTrades(trades).filter(t => !started || t.exitDate >= START_DATE);

  // The house tree column is REAL-ACCOUNT trades only — the engine writes its paper-mode
  // simulations into the same collection with mode:'paper' (they belong to the hands-off
  // column's own suffixed collection, never here). Same filter treeJourneyCompare uses.
  const treeTrades = recent(await db.collection('pnthr_tree_trades').find({ mode: { $ne: 'paper' } }).toArray());
  const eliteTr = recent(eliteClosed), srTr = recent(srClosed);
  const funds = [
    // Mode label follows the ENGINE's actual mode — hardcoding 'LIVE' showed paper-mode
    // periods (like right now) as live performance on an investor-facing page.
    { id: 'tree', name: 'PNTHR Tree', strategy: '42-week-high momentum (daily)',
      mode: treeMode === 'live' ? 'LIVE' : 'PAPER', simulated: treeMode !== 'live',
      dataQuality: {
        corruptWindow: { from: TREE_CORRUPT_FROM, to: TREE_CORRUPT_TO },
        note: 'Recorded equity 06/22–07/02 is quarantined (mode toggles, a 6/23 liquidation booked at $0 P&L, and default-NAV fallbacks corrupted the series). Return-since-start includes that window and is NOT a reliable strategy track record; risk metrics exclude the quarantined rows. The hands-off paper column is the clean strategy track.',
      },
      baselineNav, currentEquity: Math.round(treeEquity), returnPct: pct(treeEquity), returnPctNet: pctNet(treeEquity),
      pnlSinceStart: Math.round(treeEquity - baselineNav), openPnl: Math.round(treeOpenPnl),
      riskAtStop: Math.round(treeRisk), openCount: treePos.length, positions: treePos.map(slim),
      tradeStats: computeTradeStats(treeTrades, baselineNav, 1), avgWinnerHold: avgWinnerHold(treeTrades),
      risk: riskMetrics(await series('tree')) },
    { id: 'elite', name: 'Elite AI', strategy: 'AI-300 Elite / MCE (daily breakout, long-only)', mode: 'PAPER', simulated: true,
      baselineNav, currentEquity: Math.round(eliteEquity), returnPct: pct(eliteEquity), returnPctNet: pctNet(eliteEquity),
      pnlSinceStart: Math.round(eliteEquity - baselineNav), openPnl: Math.round(eliteOpenPnl),
      riskAtStop: Math.round(eliteRisk), openCount: elitePos.length, positions: elitePos.map(slim),
      tradeStats: computeTradeStats(eliteTr, baselineNav, 1), avgWinnerHold: avgWinnerHold(eliteTr),
      risk: riskMetrics(await series('elite')) },
    { id: 'sectrot', name: 'AI Sector Momentum', strategy: 'AI-300 top-2/sector · 6mo momentum · quarterly rebalance (long-only)', mode: 'PAPER', simulated: true,
      baselineNav, currentEquity: Math.round(sectrotEquity), returnPct: pct(sectrotEquity), returnPctNet: pctNet(sectrotEquity),
      pnlSinceStart: Math.round(sectrotEquity - baselineNav), openPnl: Math.round(srOpenPnl),
      riskAtStop: 0, openCount: srPos.length, positions: srPos.map(slim),
      tradeStats: computeTradeStats(srTr, baselineNav, 1), avgWinnerHold: avgWinnerHold(srTr),
      risk: riskMetrics(await series('sectrot')) },
  ];

  // 4th column — PNTHR Tree HANDS-OFF (paper). Two clearly-separated parts:
  //   • reconstruction — the HYPOTHETICAL 06-22→last-complete-session band (from treeSim), and
  //   • the forward-live paper book that ticks from the day it was stood up.
  // Only added once the house book is registered (treePaperState non-null).
  if (treePaperState) {
    const tpTrades = recent(await db.collection(treePaperTradesC).find({}).toArray());
    const forwardStart = houseBook?.createdAt ? new Date(houseBook.createdAt).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) : today;
    funds.push({
      id: 'treePaper', name: 'PNTHR Tree (hands-off)', strategy: '42-week-high momentum — paper, no intervention', mode: 'PAPER', simulated: true,
      baselineNav, currentEquity: Math.round(treePaperEquity), returnPct: pct(treePaperEquity), returnPctNet: pctNet(treePaperEquity),
      pnlSinceStart: Math.round(treePaperEquity - baselineNav), openPnl: Math.round(treePaperState.treePnl || 0),
      riskAtStop: Math.round(treePaperState.totalRisk?.actual || 0), openCount: (treePaperState.positions || []).length,
      positions: (treePaperState.positions || []).map(slim),
      tradeStats: computeTradeStats(tpTrades, baselineNav, 1), avgWinnerHold: avgWinnerHold(tpTrades),
      risk: riskMetrics(await series('treePaper')),
      forwardStart,   // the paper book tracks live from here; before it, only the reconstruction is meaningful
      reconstruction: (reconBand && reconBand.status === 'ok') ? {
        start: reconBand.start, asOf: reconBand.asOf, centralPct: reconBand.centralPct,
        lowPct: reconBand.lowPct, highPct: reconBand.highPct, netCentralPct: reconBand.netCentralPct,
        method: reconBand.method, series: reconBand.series || [], hypothetical: true,
      } : null,
    });
  }

  const result = {
    started, startDate: START_DATE, baselineNav: Math.round(baselineNav), asOf: new Date().toISOString(),
    fees: { mgmtPct: FEE_MGMT * 100, perfPct: FEE_PERF * 100, basis: '2% annual management + 30% performance (Filet tier), high-water mark — net = what an investor keeps' },
    note: started ? `Common start ${START_DATE} at $${Math.round(baselineNav).toLocaleString()} NAV.`
                   : `Comparison begins ${START_DATE} (Tree's first live trading day). Showing live previews.`,
    disclaimer: 'HYPOTHETICAL / SIMULATED PERFORMANCE. Elite AI and AI Sector Momentum are PAPER-TRADED simulations — not real trading and not a track record. The PNTHR Tree column reflects the house account (its mode label shows whether the engine is currently live or paper); its recorded 06/22–07/02 history is quarantined as corrupted and its return-since-start is not a reliable strategy track record. Past and simulated performance does not guarantee future results. For evaluation only; not an offer to sell securities. Reg D 506(c) — available only to verified accredited investors.',
    funds,
  };
  _cache.at = Date.now(); _cache.data = result;
  return result;
}

// ── PER-MEMBER comparison — all 3 strategies PAPER, owner-scoped, walled off ──
// Brennan (and any non-admin member) gets a fully INDEPENDENT comparison: his own
// $50k baseline, his own owner-suffixed paper books for ALL THREE strategies, his
// own config/daily-series collections. It NEVER calls getPnthrTreeState (the live
// house book), NEVER reads the house NAV, and NEVER touches the singleton
// pnthr_fund_compare_* collections. The only shared inputs are public strategy
// signals + live market prices — never the house account's positions or NAV.
const _memCache = new Map();   // ownerId -> { at, data }
export async function getFundComparisonForMember(db, ownerId) {
  if (!ownerId) return { error: 'NO_OWNER' };
  const oid = String(ownerId);
  const hit = _memCache.get(oid);
  if (hit && Date.now() - hit.at < 8000) return hit.data;
  if (!db) db = await connectToDatabase();
  if (!db) return { error: 'NO_DB' };
  const today = todayET();
  const started = today >= START_DATE;

  // Base capital = the MEMBER's own account size ($50k default) — never the house NAV.
  let base = 50000;
  try { const p = await getUserProfile(oid); if (p?.accountSize > 0) base = p.accountSize; } catch { /* default $50k */ }

  // Owner-scoped collections (every read/write below is walled to this member).
  const CFG_M = `${CFG}__${oid}`, DAILY_M = `${DAILY}__${oid}`;
  const treeTradesC = `pnthr_tree_trades__${oid}`, eliteTradesC = `pnthr_elite_trades__${oid}`;

  // Tree — the member's PAPER book (NOT getPnthrTreeState — that's the live house book).
  let tree = { nav: base, positions: [], treePnl: 0, totalRisk: { actual: 0 } };
  try { tree = await getPaperBookState(db, oid); } catch { /* default */ }
  const treeNav = tree?.nav || base;
  const treePos = tree?.positions || [];
  const treeOpenPnl = tree?.treePnl ?? 0;
  const treeRisk = tree?.totalRisk?.actual ?? 0;

  // Elite — the member's PAPER book (owner-scoped via ownerId).
  const elitePos = await getElitePositions({ ownerId: oid }).catch(() => []);
  const eliteClosed = await db.collection(eliteTradesC).find({}).toArray();
  const eliteOpenPnl = elitePos.reduce((s, p) => s + (+p.livePnl || 0), 0);
  const eliteRealized = eliteClosed.reduce((s, t) => s + (+t.pnl || 0), 0);
  const eliteTotalPnl = eliteOpenPnl + eliteRealized;
  const eliteRisk = elitePos.reduce((s, p) => s + Math.abs(((+p.avgCost || +p.entryPrice) - (+p.stop || +p.stopPrice || 0)) * (+p.totalShares || 0)), 0);

  // AI Sector Momentum — the member's PAPER book (owner-scoped).
  const srPos = await getSectorRotationPaperPositions({ ownerId: oid }).catch(() => []);
  const srClosed = await db.collection(`pnthr_sectrot_paper_trades__${oid}`).find({}).toArray();
  const srOpenPnl = srPos.reduce((s, p) => s + (+p.livePnl || 0), 0);
  const srRealized = srClosed.reduce((s, t) => s + (+t.pnl || 0), 0);
  const srTotalPnl = srOpenPnl + srRealized;

  // Common baseline = the member's $50k, locked on/after Monday in his OWN config doc.
  let cfg = await db.collection(CFG_M).findOne({ key: 'fund_compare' });
  if (started && (!cfg || !cfg.locked) && IS_WRITER) {
    cfg = { key: 'fund_compare', locked: true, startDate: today, baselineNav: base,
      treeBaselineNav: treeNav, eliteBaselinePnl: eliteTotalPnl, lockedAt: new Date() };
    await db.collection(CFG_M).updateOne({ key: 'fund_compare' }, { $set: cfg }, { upsert: true });
  }
  const baselineNav = cfg?.baselineNav || base;

  const treeEquity   = started && cfg ? baselineNav + (treeNav - (cfg.treeBaselineNav || treeNav)) : baselineNav;
  const eliteEquity  = started && cfg ? baselineNav + (eliteTotalPnl - (cfg.eliteBaselinePnl || 0)) : baselineNav;
  const sectrotEquity = started && cfg ? baselineNav + (srTotalPnl - (cfg.sectrotBaselinePnl || 0)) : baselineNav;
  const pct = (eq) => baselineNav > 0 ? +(((eq / baselineNav) - 1) * 100).toFixed(2) : 0;

  const FEE_MGMT = 0.02, FEE_PERF = 0.30;
  const elapsedDays = (started && cfg?.startDate) ? Math.max(0, (new Date(today) - new Date(cfg.startDate)) / 86400000) : 0;
  const pctNet = (eq) => {
    if (baselineNav <= 0) return 0;
    const grossPnl = eq - baselineNav;
    const mgmt = baselineNav * FEE_MGMT * (elapsedDays / 365);
    const afterMgmt = grossPnl - mgmt;
    const perf = afterMgmt > 0 ? afterMgmt * FEE_PERF : 0;
    return +(((grossPnl - mgmt - perf) / baselineNav) * 100).toFixed(2);
  };

  if (started && IS_WRITER) {
    for (const [fund, eq] of [['tree', treeEquity], ['elite', eliteEquity], ['sectrot', sectrotEquity]]) {
      await db.collection(DAILY_M).updateOne({ fund, date: today }, { $set: { fund, date: today, equity: +(+eq).toFixed(2), updatedAt: new Date() } }, { upsert: true });
    }
  }
  const series = async (fund) => (await db.collection(DAILY_M).find({ fund }, { projection: { _id: 0, date: 1, equity: 1 } }).sort({ date: 1 }).toArray());
  const recent = (trades) => normTrades(trades).filter(t => !started || t.exitDate >= START_DATE);
  const treeTrades = recent(await db.collection(treeTradesC).find({}).toArray());
  const eliteTr = recent(eliteClosed), srTr = recent(srClosed);

  // ALL THREE are PAPER for a member (he has no live account).
  const funds = [
    { id: 'tree', name: 'PNTHR Tree', strategy: '42-week-high momentum (daily)', mode: 'PAPER', simulated: true,
      baselineNav, currentEquity: Math.round(treeEquity), returnPct: pct(treeEquity), returnPctNet: pctNet(treeEquity),
      pnlSinceStart: Math.round(treeEquity - baselineNav), openPnl: Math.round(treeOpenPnl),
      riskAtStop: Math.round(treeRisk), openCount: treePos.length, positions: treePos.map(slimPos),
      tradeStats: computeTradeStats(treeTrades, baselineNav, 1), avgWinnerHold: avgWinnerHold(treeTrades),
      risk: riskMetrics(await series('tree')) },
    { id: 'elite', name: 'Elite AI', strategy: 'AI-300 Elite / MCE (daily breakout, long-only)', mode: 'PAPER', simulated: true,
      baselineNav, currentEquity: Math.round(eliteEquity), returnPct: pct(eliteEquity), returnPctNet: pctNet(eliteEquity),
      pnlSinceStart: Math.round(eliteEquity - baselineNav), openPnl: Math.round(eliteOpenPnl),
      riskAtStop: Math.round(eliteRisk), openCount: elitePos.length, positions: elitePos.map(slimPos),
      tradeStats: computeTradeStats(eliteTr, baselineNav, 1), avgWinnerHold: avgWinnerHold(eliteTr),
      risk: riskMetrics(await series('elite')) },
    { id: 'sectrot', name: 'AI Sector Momentum', strategy: 'AI-300 top-2/sector · 6mo momentum · quarterly rebalance (long-only)', mode: 'PAPER', simulated: true,
      baselineNav, currentEquity: Math.round(sectrotEquity), returnPct: pct(sectrotEquity), returnPctNet: pctNet(sectrotEquity),
      pnlSinceStart: Math.round(sectrotEquity - baselineNav), openPnl: Math.round(srOpenPnl),
      riskAtStop: 0, openCount: srPos.length, positions: srPos.map(slimPos),
      tradeStats: computeTradeStats(srTr, baselineNav, 1), avgWinnerHold: avgWinnerHold(srTr),
      risk: riskMetrics(await series('sectrot')) },
  ];

  const result = {
    started, startDate: START_DATE, baselineNav: Math.round(baselineNav), asOf: new Date().toISOString(),
    member: true, ownerId: oid,
    fees: { mgmtPct: FEE_MGMT * 100, perfPct: FEE_PERF * 100, basis: '2% annual management + 30% performance (Filet tier), high-water mark — net = what an investor keeps' },
    note: started ? `Common start ${START_DATE} at $${Math.round(baselineNav).toLocaleString()} NAV (paper).`
                   : `Comparison begins ${START_DATE}. Showing live previews.`,
    disclaimer: 'HYPOTHETICAL / SIMULATED PERFORMANCE. All three strategies shown here — PNTHR Tree, Elite AI, and AI Sector Momentum — are PAPER-TRADED simulations seeded from a $50,000 starting balance; none reflect real trading and none are a track record. Past and simulated performance does not guarantee future results. For evaluation only; not an offer to sell securities. Reg D 506(c) — available only to verified accredited investors.',
    funds,
  };
  _memCache.set(oid, { at: Date.now(), data: result });
  return result;
}
