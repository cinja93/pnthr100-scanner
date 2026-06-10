// server/eliteAiEngine.js
// ── PNTHR Elite AI — DRY-RUN paper engine ───────────────────────────────────
//
// Isolated paper-trading engine for the AI-300 Elite strategy. Writes ONLY to
// its own `pnthr_elite_positions` collection — NO shared state with Ambush
// (pnthr_ambush_positions) or the Command Center (pnthr_portfolio). NO real
// orders, NO IBKR, NO outbox. Pure paper.
//
// Entry: reads the MCE scan (getReentrySignals — the SAME source the ORDERS AI /
// PNTHR MCE page and the live MCE auto-execute path use): active weekly BL +
// top-100 TTM + daily 2-bar high breakout + bull sector. For each candidate it
// opens a PAPER position with the candidate's own 5-lot share ladder + weekly
// stop, so the paper book mirrors ORDERS AI name-for-name. The manage pass then
// fills L2-L5 as live price clears each trigger, ratchets the stop, exits on a hit.
// ────────────────────────────────────────────────────────────────────────────
import fs from 'fs';
import { connectToDatabase, getUserProfile } from './database.js';
import { getReentrySignals } from './reentrySignalService.js';
import { getSectorName, getSizingMultiplier, getSizingTierLabel } from './ambush/ambushEngine.js';
import { LOT_OFFSETS } from './lotMath.js';

const COLL = 'pnthr_elite_positions';
const TRADES = 'pnthr_elite_trades';
const FMP = 'https://financialmodelingprep.com/api/v3';

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Open paper positions for the current MCE breakout candidates (idempotent — skips
// names already in the paper book). Each candidate from getReentrySignals already
// carries its full entry plan: L1 trigger, weekly stop, RPS, and the 5-lot share
// ladder. Null ownerId → not filtered by the live Command-Center book (Elite AI is
// its own isolated paper account).
export async function runEliteAiDryRun({ nav } = {}) {
  const db = await connectToDatabase();
  if (!db) return { error: 'NO_DB', created: [] };

  // Graduated sizing: paper equity = $100k seed + realized P&L → 50 / 75 / 100% at the
  // SAME $125K / $166K NAV steps as Ambush (getSizingMultiplier). Keeps risk-per-trade /
  // NAV constant; at the current sub-$125K NAV that's 50% → ~$150 risk/name.
  const realized = (await db.collection(TRADES).find({}, { projection: { pnl: 1 } }).toArray()).reduce((s, t) => s + (+t.pnl || 0), 0);
  const paperNav = nav || (100000 + realized);
  const sizingMult = getSizingMultiplier(paperNav);
  const sizingPct = Math.round(sizingMult * 100);

  const candidates = await getReentrySignals(null, paperNav);

  const existing = await db.collection(COLL).find({ status: { $in: ['ACTIVE', 'PARTIAL'] } }).toArray();
  const held = new Set(existing.map(p => p.ticker));
  // ONE MCE shot per name per day: block re-entry of a name that already stopped out today.
  // The daily-bar backtest can't churn intraday; the 60s live cron can — without this guard a
  // name re-enters the instant it stops out (UMC churned 48x in a day). Resets next session.
  const tradedToday = new Set((await db.collection(TRADES).find({ exitDate: todayET() }, { projection: { ticker: 1 } }).toArray()).map(t => t.ticker));
  // capital gates (mirror aiAutoExecute): 15% NAV heat cap + 20% buying-power reserve
  let runningRisk = existing.reduce((s, p) => s + Math.abs((+p.avgCost || +p.entryPrice) - (+p.stop || +p.stopPrice)) * (+p.totalShares || 0), 0);
  let availBP = paperNav - existing.reduce((s, p) => s + (+p.avgCost || +p.entryPrice) * (+p.totalShares || 0), 0) - paperNav * 0.20;
  const created = [];
  const now = new Date(), today = todayET();

  for (const c of candidates) {
    if (held.has(c.ticker) || tradedToday.has(c.ticker)) continue;   // skip names that already had their shot today
    const entry = +c.entryTrigger, stop = +c.weeklyStop;
    const lotPlan = (c.lotShares || []).map(n => Math.max(1, Math.round((+n || 0) * sizingMult)));  // graduated sizing
    const rps = +c.rps || (entry - stop);
    if (!(entry > 0) || !(stop > 0) || !lotPlan[0] || rps <= 0) continue;

    // gates: 15% NAV heat + buying power for L1
    const l1Risk = rps * lotPlan[0], l1Cost = lotPlan[0] * entry;
    if ((runningRisk + l1Risk) / paperNav > 0.15 || l1Cost > availBP) continue;

    const pos = {
      ticker: c.ticker, direction: 'LONG', signal: 'BL',          // MCE is long-only
      entryPrice: entry, originalEntry: entry, avgCost: entry,
      stopPrice: stop, originalStop: stop, stop,
      lotPlan, nextLot: 1,                                         // L1 paper-filled, L2-L5 pending
      totalShares: lotPlan[0], targetShares: lotPlan.reduce((s, v) => s + v, 0),
      lotPrices: [c.l1Price, c.l2Price, c.l3Price, c.l4Price, c.l5Price].map(x => (x != null ? +x : null)),
      sector: getSectorName(c.ticker) || null, sectorMult: 1,
      rps, signalDate: c.signalDate || null, sizingPct,
      dailyTrigger: entry, weeklyTrigger: null,
      gapPct: null, qualityGrade: null,
      peak: 0, atBE: false, cycleNum: 0,
      status: 'ACTIVE', dryRun: true, source: 'ELITE_MCE_DRYRUN',
      entryDate: today, createdAt: now, updatedAt: now,
    };
    await db.collection(COLL).insertOne(pos);
    held.add(c.ticker);
    created.push({ ticker: c.ticker, l1Shares: lotPlan[0], totalShares: pos.targetShares, entry, stop });
    runningRisk += l1Risk; availBP -= l1Cost;
  }

  return { created, totalOpen: existing.length + created.length, candidatesScanned: candidates.length, source: 'MCE', paperNav, sizingPct };
}

// Current graduated-sizing tier for the paper book (paper equity = $100k + realized P&L).
export async function getEliteSizing() {
  const db = await connectToDatabase();
  const realized = db ? (await db.collection(TRADES).find({}, { projection: { pnl: 1 } }).toArray()).reduce((s, t) => s + (+t.pnl || 0), 0) : 0;
  const paperNav = 100000 + realized;
  return { paperNav, realized, sizingPct: Math.round(getSizingMultiplier(paperNav) * 100), tier: getSizingTierLabel(paperNav), tier1: 125000, tier2: 166000 };
}

// LONG-vs-SHORT scorecard — validates the Ambush(short) / Elite(long) split on REAL data.
// SHORT leg = Ambush live realized trades; LONG leg = Elite AI paper (realized + open).
export async function getEliteScorecard() {
  const db = await connectToDatabase();
  if (!db) return null;
  const st = (arr) => { const p = arr.reduce((s, t) => s + (+t.pnl || 0), 0); const w = arr.filter(t => (+t.pnl || 0) > 0).length; return { n: arr.length, wr: arr.length ? Math.round(w / arr.length * 100) : 0, pnl: Math.round(p) }; };
  const amb = await db.collection('pnthr_ambush_trades').find({}, { projection: { direction: 1, pnl: 1, exitDate: 1 } }).toArray();
  const isShort = t => /short|^ss$/i.test(String(t.direction || ''));
  const short = st(amb.filter(isShort));
  const ambLong = st(amb.filter(t => !isShort(t)));
  const eliteClosed = st(await db.collection(TRADES).find({}, { projection: { pnl: 1 } }).toArray());
  const ePos = await db.collection(COLL).find({ status: { $in: ['ACTIVE', 'PARTIAL'] } }, { projection: { livePnl: 1 } }).toArray();
  const eliteOpen = { n: ePos.length, pnl: Math.round(ePos.reduce((s, p) => s + (+p.livePnl || 0), 0)) };
  const dates = amb.map(t => t.exitDate).filter(Boolean).sort();
  return { short, ambLong, eliteClosed, eliteOpen, from: dates[0] || null, to: dates[dates.length - 1] || null };
}

// Independent rule-recompute verification — the paper analogue of Ambush's
// IBKR-truth reconcile. Recomputes what each value SHOULD be per the strategy
// and flags drift. When live, the IBKR-position comparison plugs in here.
export function verifyElitePosition(pos, nav = 100000) {
  const isLong = pos.direction === 'LONG';
  const entry = +pos.entryPrice, stop = +(pos.stop ?? pos.stopPrice), avg = +pos.avgCost || entry, sh = +pos.totalShares || 0;
  const cur = +pos.currentPrice || entry;
  const checks = {};
  checks.direction = ((pos.signal === 'BL') === isLong) ? { status: 'green' } : { status: 'red', reason: `${pos.signal}≠${pos.direction}` };
  const plannedFilled = (pos.lotPlan || []).slice(0, pos.nextLot || 1).reduce((s, v) => s + v, 0);
  checks.shares = (sh === plannedFilled) ? { status: 'green' } : { status: 'yellow', reason: `${sh} vs plan ${plannedFilled}` };
  checks.stopLevel = (isLong ? stop < cur : stop > cur) ? { status: 'green' } : { status: 'red', reason: `wrong side of ${cur.toFixed(2)}` };
  const notional = sh * avg;
  checks.cap = (notional <= nav * 0.10 + 1) ? { status: 'green' } : { status: 'red', reason: `${(notional / nav * 100).toFixed(1)}% > 10%` };
  const riskPct = (Math.abs(avg - stop) * sh) / nav;
  checks.risk = (riskPct <= 0.015) ? { status: 'green' } : { status: 'yellow', reason: `${(riskPct * 100).toFixed(2)}% NAV` };
  const ord = { red: 3, yellow: 2, green: 1 }; let rollup = 'green'; const reasons = [];
  for (const [k, c] of Object.entries(checks)) { if (ord[c.status] > ord[rollup]) rollup = c.status; if (c.reason) reasons.push(`${k}: ${c.reason}`); }
  return { rollup, checks, reasons };
}

export async function getElitePositions() {
  const db = await connectToDatabase();
  if (!db) return [];
  const positions = await db.collection(COLL).find({ status: { $in: ['ACTIVE', 'PARTIAL'] } }).sort({ createdAt: -1 }).toArray();
  return positions.map(p => ({ ...p, rec: verifyElitePosition(p) }));
}

// Clear the paper book (dry-run only — never touches anything but pnthr_elite_positions).
export async function resetEliteDryRun() {
  const db = await connectToDatabase();
  if (!db) return { deleted: 0 };
  const r = await db.collection(COLL).deleteMany({ dryRun: true });
  await db.collection(TRADES).deleteMany({ dryRun: true });
  return { deleted: r.deletedCount };
}

// Live FMP quotes for a set of tickers → { TICKER: price }
async function fetchQuotes(tickers) {
  const K = process.env.FMP_API_KEY; const out = {};
  for (let i = 0; i < tickers.length; i += 50) {
    const batch = tickers.slice(i, i + 50);
    try { const r = await fetch(`${FMP}/quote/${batch.join(',')}?apikey=${K}`); const j = await r.json(); if (Array.isArray(j)) for (const q of j) if (q.price != null) out[(q.symbol || '').toUpperCase()] = +q.price; } catch { /* skip */ }
  }
  return out;
}

// ── MANAGE pass (paper) ──────────────────────────────────────────────────────
// For each open paper position, against the live price: fill L2-L5 as price
// clears each +3/6/10/14% trigger, ratchet the stop as lots fill (L3→break-even,
// L4→L2 level, L5→L3 level), and close on a stop hit. Updates live P&L + peak.
// Paper only — touches nothing but pnthr_elite_positions / pnthr_elite_trades.
const RATCHET_AT = { 3: 0, 4: 1, 5: 2 }; // nextLot reached → stop anchored at LOT_OFFSETS[index]

export async function manageEliteAiDryRun() {
  const db = await connectToDatabase();
  if (!db) return { fills: 0, exits: 0, changed: false };
  const positions = await db.collection(COLL).find({ status: { $in: ['ACTIVE', 'PARTIAL'] } }).toArray();
  if (!positions.length) return { fills: 0, exits: 0, changed: false };

  const prices = await fetchQuotes([...new Set(positions.map(p => p.ticker))]);
  let fills = 0, exits = 0;

  for (const p of positions) {
    const px = prices[p.ticker]; if (px == null) continue;
    const isLong = p.direction === 'LONG';
    const anchor = +p.originalEntry || +p.entryPrice;
    let nextLot = p.nextLot || 1, totalShares = p.totalShares || 0, avgCost = +p.avgCost || anchor, stop = +p.stop || +p.stopPrice, atBE = !!p.atBE;
    let changed = false;

    // (a) lot fills — paper-fill at the trigger as price clears it
    while (nextLot < 5) {
      const trig = isLong ? +(anchor * (1 + LOT_OFFSETS[nextLot])).toFixed(2) : +(anchor * (1 - LOT_OFFSETS[nextLot])).toFixed(2);
      const cleared = isLong ? px >= trig : px <= trig;
      if (!cleared) break;
      const addSh = (p.lotPlan || [])[nextLot] || 0;
      if (addSh > 0) { avgCost = (avgCost * totalShares + trig * addSh) / (totalShares + addSh); totalShares += addSh; }
      nextLot += 1; fills++; changed = true;
    }

    // (b) ratchet stop as lots fill
    if (RATCHET_AT[nextLot] != null) {
      const lvl = isLong ? +(anchor * (1 + LOT_OFFSETS[RATCHET_AT[nextLot]])).toFixed(2) : +(anchor * (1 - LOT_OFFSETS[RATCHET_AT[nextLot]])).toFixed(2);
      const newStop = isLong ? Math.max(stop, lvl) : Math.min(stop, lvl);
      if (newStop !== stop) { stop = newStop; changed = true; }
      atBE = true;
    }

    // (c) exit on stop hit (paper)
    const stopHit = isLong ? px <= stop : px >= stop;
    if (stopHit) {
      const exitPx = stop;
      const pnl = isLong ? (exitPx - avgCost) * totalShares : (avgCost - exitPx) * totalShares;
      const now = new Date();
      await db.collection(COLL).updateOne({ _id: p._id }, { $set: { status: 'CLOSED', exitPrice: exitPx, exitReason: 'STOP', pnl: +pnl.toFixed(2), nextLot, totalShares, avgCost: +avgCost.toFixed(4), stop, closedAt: now, updatedAt: now } });
      await db.collection(TRADES).insertOne({ ticker: p.ticker, direction: p.direction, entryPrice: p.entryPrice, exitPrice: exitPx, avgCost: +avgCost.toFixed(4), shares: totalShares, pnl: +pnl.toFixed(2), exitReason: 'STOP', entryDate: p.entryDate, exitDate: todayET(), dryRun: true, createdAt: now });
      exits++; continue;
    }

    // (d) live P&L + peak
    const livePnl = isLong ? (px - avgCost) * totalShares : (avgCost - px) * totalShares;
    const peak = Math.max(+p.peak || 0, livePnl);
    if (changed || px !== p.currentPrice) {
      await db.collection(COLL).updateOne({ _id: p._id }, { $set: { nextLot, totalShares, avgCost: +avgCost.toFixed(4), stop, atBE, currentPrice: px, livePnl: +livePnl.toFixed(2), peak: +peak.toFixed(2), updatedAt: new Date() } });
    }
  }
  return { fills, exits, changed: fills > 0 || exits > 0, managed: positions.length };
}

export async function getEliteTrades(limit = 30) {
  const db = await connectToDatabase();
  if (!db) return [];
  return db.collection(TRADES).find({}).sort({ createdAt: -1 }).limit(limit).toArray();
}

// ── PROJECTED vs ACTUAL AUM (mirrors the Ambush projection, Elite numbers) ──────
// Backtest baseline = eliteProjectionBaseline.json (MCE gated baseline, NET of fund
// fees). HYPOTHETICAL / survivorship-flattered — internal tracker, not a track record.
const _eliteProjPath = new URL('./data/eliteProjectionBaseline.json', import.meta.url).pathname;
let _eliteProj = null;
function loadEliteProjection() {
  if (!_eliteProj) {
    try { _eliteProj = JSON.parse(fs.readFileSync(_eliteProjPath, 'utf8')); }
    catch { _eliteProj = { factors: [], backtestStartNav: 100000, backtestEndNav: 0, metrics: null }; }
  }
  return _eliteProj;
}
function _etDateStr(d = new Date()) {
  const p = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) p[type] = value;
  return `${p.year}-${p.month}-${p.day}`;
}
function _weekdaysBetween(a, b) {
  if (!b || b <= a) return 0;
  const e = new Date(b + 'T12:00:00'), d = new Date(a + 'T12:00:00'); let n = 0;
  while (d < e) { d.setDate(d.getDate() + 1); const w = d.getDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}
const _FWD_WD_THRESHOLD = 2_000_000, _FWD_WD_AMOUNT = 1_000_000;
const _FWD_HORIZONS = [
  { label: '6 mo', years: 0.5, days: 126 }, { label: '1 yr', years: 1, days: 252 },
  { label: '18 mo', years: 1.5, days: 378 }, { label: '2 yr', years: 2, days: 504 },
  { label: '3 yr', years: 3, days: 756 }, { label: '5 yr', years: 5, days: 1260 },
  { label: '10 yr', years: 10, days: 2520 },
];
function _simulateForward(startBalance, factors, elapsed, dailyCagrRate, horizons) {
  const N = factors.length, maxDays = horizons[horizons.length - 1].days;
  const byDay = new Map(horizons.map(h => [h.days, h]));
  let balance = startBalance, banked = 0; const snaps = {};
  for (let k = 1; k <= maxDays; k++) {
    if (balance >= _FWD_WD_THRESHOLD) { balance -= _FWD_WD_AMOUNT; banked += _FWD_WD_AMOUNT; }
    const srcIdx = elapsed + k;
    let ratio = (srcIdx < N && factors[srcIdx - 1]?.factor > 0) ? factors[srcIdx].factor / factors[srcIdx - 1].factor : dailyCagrRate;
    if (ratio > 0 && isFinite(ratio)) balance *= ratio;
    if (byDay.has(k)) snaps[k] = { balance: Math.round(balance), banked, total: Math.round(balance + banked), extrapolated: (elapsed + k) >= N };
  }
  return snaps;
}

export async function getEliteProjection() {
  const db = await connectToDatabase();
  if (!db) return null;
  const proj = loadEliteProjection();
  const factors = proj.factors || [];

  // Actual AUM = the REAL account NAV (same source as the Ambush panel) — we ride the
  // real AUM forward at the Elite backtest growth rate, NOT the notional paper book.
  let actualNav = 83000;
  try {
    const ambCfg = await db.collection('pnthr_ambush_config').findOne({});
    if (ambCfg?.nav > 0) actualNav = ambCfg.nav;
    if (ambCfg?.ownerId) { const p = await getUserProfile(ambCfg.ownerId); if (p?.accountSize > 0) actualNav = p.accountSize; }
  } catch { /* fall back to default */ }
  const todayISO = _etDateStr();

  // Anchor: lock start date + AUM on first call (mirrors Ambush).
  const cfgColl = db.collection('pnthr_elite_config');
  const cfg = (await cfgColl.findOne({ key: 'elite_config' })) || {};
  let startDate = cfg.projectionStartDate, startAum = cfg.projectionStartAum;
  if (!startDate || !startAum) {
    startDate = todayISO; startAum = actualNav;
    await cfgColl.updateOne({ key: 'elite_config' }, { $set: { key: 'elite_config', projectionStartDate: startDate, projectionStartAum: startAum } }, { upsert: true });
  }

  // Record today's actual snapshot, then read the series.
  if (actualNav > 0) {
    await db.collection('pnthr_elite_aum_daily').updateOne({ date: todayISO }, { $set: { date: todayISO, actualAum: +actualNav.toFixed(2), updatedAt: new Date() } }, { upsert: true });
  }
  const actualSeries = await db.collection('pnthr_elite_aum_daily').find({}, { projection: { _id: 0, date: 1, actualAum: 1 } }).sort({ date: 1 }).toArray();

  const N = factors.length;
  const dates = N ? [startDate] : [];
  { const d = new Date(startDate + 'T12:00:00'); for (let i = 1; i < N; i++) { do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6); dates.push(d.toISOString().split('T')[0]); } }
  const projected = factors.map((f, i) => ({ date: dates[i], value: +(startAum * f.factor).toFixed(0) }));

  const elapsed = Math.min(_weekdaysBetween(startDate, todayISO), Math.max(0, N - 1));
  const projectedToday = +(startAum * (factors[elapsed]?.factor || 1)).toFixed(0);
  const onTrackPct = projectedToday > 0 ? +(((actualNav / projectedToday) - 1) * 100).toFixed(1) : 0;

  const cagrPct = proj.metrics?.cagrPct || 0;
  const dailyCagr = cagrPct > 0 ? Math.pow(1 + cagrPct / 100, 1 / 252) : 1;
  const projFwd = N ? _simulateForward(projectedToday, factors, elapsed, dailyCagr, _FWD_HORIZONS) : {};
  const actFwd = N ? _simulateForward(actualNav, factors, elapsed, dailyCagr, _FWD_HORIZONS) : {};
  const forward = {
    cagrPct, withdrawalRule: { threshold: _FWD_WD_THRESHOLD, amount: _FWD_WD_AMOUNT },
    horizons: _FWD_HORIZONS.map(h => ({ label: h.label, years: h.years, days: h.days, projected: projFwd[h.days] || null, actual: actFwd[h.days] || null, extrapolated: (actFwd[h.days]?.extrapolated) || false })),
  };

  return {
    anchor: { startDate, startAum: +startAum.toFixed(0) },
    current: { date: todayISO, projectedAum: projectedToday, actualAum: +actualNav.toFixed(0), onTrackPct },
    projected,
    actual: actualSeries.map(s => ({ date: s.date, value: s.actualAum })),
    forward,
    metrics: proj.metrics || null,
    meta: { backtestEndNav: proj.backtestEndNav, tradingDays: factors.length, basis: 'pure compounding (no withdrawals)' },
  };
}
