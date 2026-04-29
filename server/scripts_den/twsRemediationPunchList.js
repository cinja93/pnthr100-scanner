// server/scripts_den/twsRemediationPunchList.js
// ── One-time TWS remediation: outputs the manual TWS actions needed to
//     align IBKR with PNTHR's canonical state. No DB writes — read only.
//
// Run: node scripts_den/twsRemediationPunchList.js
//
// Five categories of action (each grouped + numbered for execution):
//   1) NAKED — ACTIVE PNTHR position with no IBKR SELL STOP. PLACE the stop.
//   2) STALE — IBKR has GTC orders for tickers with no ACTIVE PNTHR position.
//      CANCEL these orders.
//   3) SHARES — IBKR shares ≠ PNTHR shares. RECONCILE (you decide which side).
//   4) STOP MISMATCH — IBKR stop ≠ PNTHR stop on an active position.
//      UPDATE the IBKR stop to PNTHR's value (PNTHR is canonical).
//   5) AVG COST — IBKR avg ≠ PNTHR avg by > 0.5%. INFORMATIONAL ONLY (likely
//      missing fills you'll need to enter into Command Center if material).
//
// Run after each TWS action would clear the corresponding line.

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });
import { connectToDatabase } from '../database.js';

const SCOTT = '69c62632367d0e18498e7650';

const STOP_TOLERANCE_PCT = 0.5;   // % difference flagged as stop mismatch
const AVG_TOLERANCE_PCT  = 0.5;   // % difference flagged as avg-cost mismatch

function fmtMoney(n) { return n != null ? `$${(+n).toFixed(2)}` : '—'; }
function pctDiff(a, b) {
  if (a == null || b == null || b === 0) return null;
  return Math.abs((a - b) / b) * 100;
}

const db = await connectToDatabase();

const ibkrDoc = await db.collection('pnthr_ibkr_positions').findOne({ ownerId: SCOTT });
const ibkrPositions = ibkrDoc?.positions  || [];
const ibkrStopOrders = ibkrDoc?.stopOrders || [];
const ibkrSync       = ibkrDoc?.syncedAt;

const pnthr = await db.collection('pnthr_portfolio').find({
  ownerId: SCOTT, status: 'ACTIVE',
}).toArray();

console.log(`\n╔══════════════════════════════════════════════════════════════════╗`);
console.log(`║  TWS REMEDIATION PUNCH LIST — Scott                              ║`);
console.log(`║  Generated: ${new Date().toISOString().slice(0, 19)}Z                          ║`);
console.log(`║  IBKR last sync: ${String(ibkrSync).slice(0, 24)}                  ║`);
console.log(`║  IBKR positions: ${String(ibkrPositions.length).padEnd(3)} | IBKR stop orders: ${String(ibkrStopOrders.length).padEnd(3)} | PNTHR active: ${String(pnthr.length).padEnd(3)}        ║`);
console.log(`╚══════════════════════════════════════════════════════════════════╝\n`);

// Index helpers
const ibkrByTicker     = new Map(ibkrPositions.map(p => [p.symbol?.toUpperCase(), p]));
const stopsByTicker    = new Map();
for (const s of ibkrStopOrders) {
  const t = s.symbol?.toUpperCase();
  if (!t) continue;
  if (!stopsByTicker.has(t)) stopsByTicker.set(t, []);
  stopsByTicker.get(t).push(s);
}
const pnthrByTicker = new Map(pnthr.map(p => [p.ticker?.toUpperCase(), p]));

// ── (1) NAKED: ACTIVE PNTHR with no protective IBKR SELL STOP ────────────
console.log(`╭─ 1. NAKED POSITIONS — no protective stop in IBKR ────────────────╮`);
console.log(`│   ACTION: place a SELL STOP in TWS at the listed price            │`);
console.log(`╰───────────────────────────────────────────────────────────────────╯`);
const naked = [];
for (const p of pnthr) {
  const t = p.ticker?.toUpperCase();
  const ibkr = ibkrByTicker.get(t);
  if (!ibkr) continue; // covered by SHARES category
  const stops = (stopsByTicker.get(t) || []);
  // Protective stop for LONG = SELL action; for SHORT = BUY action
  const expectedAction = (p.direction || 'LONG').toUpperCase() === 'SHORT' ? 'BUY' : 'SELL';
  const hasProtective  = stops.some(s => s.action === expectedAction && s.orderType === 'STP');
  if (!hasProtective) naked.push({ p, ibkr, stops });
}
if (naked.length === 0) console.log('  ✓ none\n');
else {
  let n = 1;
  for (const { p, ibkr, stops } of naked) {
    const dirAction = (p.direction || 'LONG').toUpperCase() === 'SHORT' ? 'BUY' : 'SELL';
    const ibkrShares = Math.abs(+ibkr.shares || 0);
    console.log(`  ${n++}. ${p.ticker.padEnd(6)} ${p.direction || 'LONG'}  ${ibkrShares}sh @ avg ${fmtMoney(ibkr.avgCost)}`);
    console.log(`     → Place ${dirAction} STOP order: ${ibkrShares} shares @ ${fmtMoney(p.stopPrice)} GTC`);
    if (stops.length > 0) {
      console.log(`     ⚠ existing IBKR orders for ${p.ticker} (not protective):`);
      for (const s of stops) console.log(`         ${s.action} ${s.orderType} ${s.shares}sh @ ${fmtMoney(s.stopPrice)}`);
    }
  }
  console.log();
}

// ── (2) STALE: IBKR GTC orders for tickers with no ACTIVE PNTHR ──────────
console.log(`╭─ 2. STALE IBKR ORDERS — no matching ACTIVE PNTHR position ───────╮`);
console.log(`│   ACTION: cancel these GTC orders in TWS                          │`);
console.log(`╰───────────────────────────────────────────────────────────────────╯`);
const stale = [];
for (const [ticker, stops] of stopsByTicker.entries()) {
  if (pnthrByTicker.has(ticker)) continue;
  // Also skip if IBKR still holds shares (may be untracked but live)
  const ibkr = ibkrByTicker.get(ticker);
  if (ibkr && Math.abs(+ibkr.shares || 0) > 0) continue;
  stale.push({ ticker, stops });
}
if (stale.length === 0) console.log('  ✓ none\n');
else {
  let n = 1;
  for (const { ticker, stops } of stale) {
    console.log(`  ${n++}. ${ticker.padEnd(6)} ${stops.length} order(s):`);
    for (const s of stops) console.log(`         CANCEL: ${s.action} ${s.orderType} ${s.shares}sh @ ${fmtMoney(s.stopPrice)} (permId ${s.permId})`);
  }
  console.log();
}

// ── (3) SHARES: IBKR shares ≠ PNTHR shares ───────────────────────────────
console.log(`╭─ 3. SHARES MISMATCH — IBKR position size ≠ PNTHR position size ──╮`);
console.log(`│   ACTION: reconcile manually — decide which is the truth          │`);
console.log(`╰───────────────────────────────────────────────────────────────────╯`);
const sharesMismatch = [];
for (const p of pnthr) {
  const t = p.ticker?.toUpperCase();
  const ibkr = ibkrByTicker.get(t);
  if (!ibkr) {
    sharesMismatch.push({ ticker: t, dir: p.direction, ibkrShares: 0, pnthrShares: p.totalFilledShares ?? 0, kind: 'IBKR_MISSING' });
    continue;
  }
  const ibkrShares  = Math.abs(+ibkr.shares || 0);
  const pnthrShares = +p.totalFilledShares || Object.values(p.fills || {}).reduce((s, f) => s + (f?.filled ? +f.shares || 0 : 0), 0);
  if (ibkrShares !== pnthrShares) {
    sharesMismatch.push({ ticker: t, dir: p.direction, ibkrShares, pnthrShares, kind: 'DIFF' });
  }
}
if (sharesMismatch.length === 0) console.log('  ✓ none\n');
else {
  let n = 1;
  for (const m of sharesMismatch) {
    if (m.kind === 'IBKR_MISSING') {
      console.log(`  ${n++}. ${m.ticker.padEnd(6)} ${m.dir} — PNTHR shows ${m.pnthrShares} shares, IBKR has 0. Did you sell in TWS without our system catching it?`);
    } else {
      console.log(`  ${n++}. ${m.ticker.padEnd(6)} ${m.dir} — IBKR ${m.ibkrShares}sh, PNTHR ${m.pnthrShares}sh (diff ${m.ibkrShares - m.pnthrShares > 0 ? '+' : ''}${m.ibkrShares - m.pnthrShares})`);
    }
  }
  console.log();
}

// ── (4) STOP MISMATCH: IBKR stop ≠ PNTHR stop on active position ─────────
console.log(`╭─ 4. STOP PRICE MISMATCH — IBKR stop ≠ PNTHR canonical stop ──────╮`);
console.log(`│   ACTION: tightest stop wins. Per-row direction below:           │`);
console.log(`│           IBKR-tighter  → run adoptTwsTighterStops.js (adopt)    │`);
console.log(`│           PNTHR-tighter → update TWS to PNTHR's stop             │`);
console.log(`╰───────────────────────────────────────────────────────────────────╯`);
const stopMismatch = [];
for (const p of pnthr) {
  const t = p.ticker?.toUpperCase();
  const ibkr = ibkrByTicker.get(t);
  if (!ibkr) continue;
  const stops = stopsByTicker.get(t) || [];
  const dirAction = (p.direction || 'LONG').toUpperCase() === 'SHORT' ? 'BUY' : 'SELL';
  const protective = stops.find(s => s.action === dirAction && s.orderType === 'STP');
  if (!protective) continue; // covered by NAKED
  if (p.stopPrice == null) continue;
  const diff = pctDiff(protective.stopPrice, p.stopPrice);
  if (diff != null && diff > STOP_TOLERANCE_PCT) {
    stopMismatch.push({
      ticker: t, dir: p.direction,
      ibkrStop: protective.stopPrice, pnthrStop: p.stopPrice,
      diffPct: diff,
      ibkrShares: Math.abs(+ibkr.shares || 0),
      ibkrPermId: protective.permId,
    });
  }
}
if (stopMismatch.length === 0) console.log('  ✓ none\n');
else {
  let n = 1;
  for (const m of stopMismatch) {
    const isLong      = (m.dir || 'LONG').toUpperCase() !== 'SHORT';
    const ibkrTighter = isLong ? (m.ibkrStop > m.pnthrStop) : (m.ibkrStop < m.pnthrStop);
    const dirAction   = isLong ? 'SELL' : 'BUY';
    const verdict     = ibkrTighter
      ? `IBKR-TIGHTER  → run adoptTwsTighterStops.js`
      : `PNTHR-TIGHTER → update TWS ${dirAction} STOP (permId ${m.ibkrPermId}) to ${fmtMoney(m.pnthrStop)}`;
    console.log(`  ${n++}. ${m.ticker.padEnd(6)} ${m.dir} — IBKR ${fmtMoney(m.ibkrStop)} vs PNTHR ${fmtMoney(m.pnthrStop)}  (diff ${m.diffPct.toFixed(2)}%, ${m.ibkrShares}sh)`);
    console.log(`         ${verdict}`);
  }
  console.log();
}

// ── (5) AVG COST: informational ───────────────────────────────────────────
console.log(`╭─ 5. AVG COST DRIFT — IBKR avg ≠ PNTHR avg (informational) ───────╮`);
console.log(`│   Suggests fills happened in TWS that PNTHR didn't record. Add    │`);
console.log(`│   missing fills via Command Center if you want PNTHR P&L to match │`);
console.log(`╰───────────────────────────────────────────────────────────────────╯`);
const avgMismatch = [];
for (const p of pnthr) {
  const t = p.ticker?.toUpperCase();
  const ibkr = ibkrByTicker.get(t);
  if (!ibkr || !ibkr.avgCost) continue;
  const fills = Object.values(p.fills || {}).filter(f => f?.filled && f.price && f.shares);
  if (fills.length === 0) continue;
  const totalShares = fills.reduce((s, f) => s + (+f.shares || 0), 0);
  const totalCost   = fills.reduce((s, f) => s + (+f.shares || 0) * (+f.price || 0), 0);
  const pnthrAvg    = totalShares > 0 ? totalCost / totalShares : null;
  if (pnthrAvg == null) continue;
  const diff = pctDiff(ibkr.avgCost, pnthrAvg);
  if (diff != null && diff > AVG_TOLERANCE_PCT) {
    avgMismatch.push({
      ticker: t, dir: p.direction,
      ibkrAvg: ibkr.avgCost, pnthrAvg,
      diffPct: diff,
      ibkrShares: Math.abs(+ibkr.shares || 0),
    });
  }
}
if (avgMismatch.length === 0) console.log('  ✓ none\n');
else {
  let n = 1;
  for (const m of avgMismatch) {
    console.log(`  ${n++}. ${m.ticker.padEnd(6)} ${m.dir} — IBKR avg ${fmtMoney(m.ibkrAvg)} vs PNTHR avg ${fmtMoney(m.pnthrAvg)}  (diff ${m.diffPct.toFixed(2)}%, ${m.ibkrShares} shares)`);
  }
  console.log();
}

// Summary footer
console.log(`╔══════════════════════════════════════════════════════════════════╗`);
console.log(`║  SUMMARY                                                          ║`);
console.log(`╠══════════════════════════════════════════════════════════════════╣`);
console.log(`║  NAKED (place stop in TWS)        : ${String(naked.length).padStart(3)}                          ║`);
console.log(`║  STALE (cancel order in TWS)      : ${String(stale.length).padStart(3)}                          ║`);
console.log(`║  SHARES MISMATCH (manual review)  : ${String(sharesMismatch.length).padStart(3)}                          ║`);
console.log(`║  STOP MISMATCH (update in TWS)    : ${String(stopMismatch.length).padStart(3)}                          ║`);
console.log(`║  AVG COST DRIFT (informational)   : ${String(avgMismatch.length).padStart(3)}                          ║`);
console.log(`║  ────────────────────────────────────────                         ║`);
console.log(`║  TOTAL ACTIONS REQUIRED           : ${String(naked.length + stale.length + sharesMismatch.length + stopMismatch.length).padStart(3)}                          ║`);
console.log(`╚══════════════════════════════════════════════════════════════════╝\n`);
console.log(`Re-run anytime to see remaining items: node scripts_den/twsRemediationPunchList.js\n`);
process.exit(0);
