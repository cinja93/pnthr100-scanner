// server/fundCompareService.js
// ── 3-FUND COMPARISON — Tree (LIVE) vs Elite (PAPER) vs Ambush V7.6 (PAPER) ──
//
// Investor-facing side-by-side comparison. All three start from ONE common NAV
// baseline locked on Monday 2026-06-22 (= Tree's real Monday NAV); each fund's
// forward % return is tracked from there. No backfill — every point is captured
// live going forward. Reuses the canonical hedge-fund metric functions in
// irLiveService.js (computeSide for risk-adjusted metrics, computeTradeStats for
// trade stats) so all three are measured identically.
//
// COMPLIANCE: Elite + Ambush are SIMULATED (paper) — flagged simulated:true. Past /
// simulated performance does not guarantee future results. The dashboard renders the
// mandatory hypothetical-performance disclaimers around this data.
// ────────────────────────────────────────────────────────────────────────────
import { connectToDatabase, getUserProfile } from './database.js';
import { computeSide, computeTradeStats } from './irLiveService.js';
import { getElitePositions } from './eliteAiEngine.js';
import { getAmbushPaperPositions } from './ambushPaperEngine.js';
import { getPnthrTreeState } from './pnthrTreeEngine.js';

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
    exitDate: t.exitDate, exitReason: t.exitReason || 'STOP', signal: t.signal || 'BL',
    netDollarPnl: +t.pnl || 0, grossDollarPnl: +t.pnl || 0,
  }));
}

// Risk-adjusted metrics from a daily equity series — only once it's long enough to
// be meaningful; otherwise a 'building' placeholder (honest small-sample handling).
function riskMetrics(series) {
  const pts = (series || []).filter(s => s.equity > 0);
  if (pts.length < MIN_RISK_POINTS) {
    return { status: 'building', points: pts.length, need: MIN_RISK_POINTS };
  }
  try {
    const m = computeSide(pts.map(s => ({ date: s.date, equity: s.equity })), 'equity');
    return { status: 'ready', sharpe: m.sharpe, sortino: m.sortino, maxDD: m.maxDD, calmar: m.calmar,
      cagr: m.cagr, ulcerIndex: m.ulcerIndex, timeUnderWater: m.timeUnderWater, equityCurve: m.equityCurve };
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
  // Tree (LIVE house book): real positions + real account NAV.
  let tree = { positions: [], nav: 0, openPnl: 0, totalRisk: { actual: { dollars: 0 } } };
  try { tree = await getPnthrTreeState(db); } catch { /* leave default */ }
  const treeNav = tree?.nav || (await realNav(db));
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

  // Ambush V7.6 (PAPER)
  const ambPos = await getAmbushPaperPositions().catch(() => []);
  const ambClosed = await db.collection('pnthr_ambush_paper_trades').find({}).toArray();
  const ambOpenPnl = ambPos.reduce((s, p) => s + (+p.livePnl || 0), 0);
  const ambRealized = ambClosed.reduce((s, t) => s + (+t.pnl || 0), 0);
  const ambTotalPnl = ambOpenPnl + ambRealized;
  const ambRisk = ambPos.reduce((s, p) => s + Math.abs(((+p.avgCost || +p.entryPrice) - (+p.stop || 0)) * (+p.totalShares || 0)), 0);

  // ── Lock the common baseline on the first call on/after Monday ─────────────
  let cfg = await db.collection(CFG).findOne({ key: 'fund_compare' });
  if (started && (!cfg || !cfg.locked)) {
    cfg = { key: 'fund_compare', locked: true, startDate: today, baselineNav: treeNav || 100000,
      treeBaselineNav: treeNav, eliteBaselinePnl: eliteTotalPnl, ambushBaselinePnl: ambTotalPnl, lockedAt: new Date() };
    await db.collection(CFG).updateOne({ key: 'fund_compare' }, { $set: cfg }, { upsert: true });
  }
  const baselineNav = cfg?.baselineNav || treeNav || 100000;

  // ── Current equity per fund (forward from the common baseline) ─────────────
  const treeEquity   = started && cfg ? baselineNav + (treeNav - (cfg.treeBaselineNav || treeNav)) : treeNav;
  const eliteEquity  = started && cfg ? baselineNav + (eliteTotalPnl - (cfg.eliteBaselinePnl || 0)) : baselineNav;
  const ambushEquity = started && cfg ? baselineNav + (ambTotalPnl - (cfg.ambushBaselinePnl || 0)) : baselineNav;
  const pct = (eq) => baselineNav > 0 ? +(((eq / baselineNav) - 1) * 100).toFixed(2) : 0;

  // ── Record today's equity point per fund (one row per fund per day) ────────
  if (started) {
    for (const [fund, eq] of [['tree', treeEquity], ['elite', eliteEquity], ['ambush', ambushEquity]]) {
      await db.collection(DAILY).updateOne({ fund, date: today }, { $set: { fund, date: today, equity: +(+eq).toFixed(2), updatedAt: new Date() } }, { upsert: true });
    }
  }
  async function series(fund) {
    return (await db.collection(DAILY).find({ fund }, { projection: { _id: 0, date: 1, equity: 1 } }).sort({ date: 1 }).toArray());
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

  const funds = [
    { id: 'tree', name: 'PNTHR Tree', strategy: '42-week-high momentum (daily)', mode: 'LIVE', simulated: false,
      baselineNav, currentEquity: Math.round(treeEquity), returnPct: pct(treeEquity), openPnl: Math.round(treeOpenPnl),
      riskAtStop: Math.round(treeRisk), openCount: treePos.length, positions: treePos.slice(0, 8).map(slim),
      trades: recent(await db.collection('pnthr_tree_trades').find({}).sort({ exitDate: -1 }).limit(8).toArray()),
      tradeStats: computeTradeStats(recent(await db.collection('pnthr_tree_trades').find({}).toArray()), baselineNav, 1),
      risk: riskMetrics(await series('tree')) },
    { id: 'elite', name: 'Elite AI', strategy: 'AI-300 Elite / MCE (daily breakout, long-only)', mode: 'PAPER', simulated: true,
      baselineNav, currentEquity: Math.round(eliteEquity), returnPct: pct(eliteEquity), openPnl: Math.round(eliteOpenPnl),
      riskAtStop: Math.round(eliteRisk), openCount: elitePos.length, positions: elitePos.slice(0, 8).map(slim),
      trades: recent(eliteClosed).slice(0, 8), tradeStats: computeTradeStats(recent(eliteClosed), baselineNav, 1),
      risk: riskMetrics(await series('elite')) },
    { id: 'ambush', name: 'Ambush V7.6', strategy: 'AI-300 intraday breakout + pyramid (long/short)', mode: 'PAPER', simulated: true,
      baselineNav, currentEquity: Math.round(ambushEquity), returnPct: pct(ambushEquity), openPnl: Math.round(ambOpenPnl),
      riskAtStop: Math.round(ambRisk), openCount: ambPos.length, positions: ambPos.slice(0, 8).map(slim),
      trades: recent(ambClosed).slice(0, 8), tradeStats: computeTradeStats(recent(ambClosed), baselineNav, 1),
      risk: riskMetrics(await series('ambush')) },
  ];

  const result = {
    started, startDate: START_DATE, baselineNav: Math.round(baselineNav), asOf: new Date().toISOString(),
    note: started ? `Common start ${START_DATE} at $${Math.round(baselineNav).toLocaleString()} NAV.`
                   : `Comparison begins ${START_DATE} (Tree's first live trading day). Showing live previews.`,
    disclaimer: 'HYPOTHETICAL / SIMULATED PERFORMANCE. Elite AI and Ambush V7.6 are PAPER-TRADED simulations — not real trading and not a track record. PNTHR Tree reflects a live account with a very short history. Past and simulated performance does not guarantee future results. For evaluation only; not an offer to sell securities. Reg D 506(c) — available only to verified accredited investors.',
    funds,
  };
  _cache.at = Date.now(); _cache.data = result;
  return result;
}
