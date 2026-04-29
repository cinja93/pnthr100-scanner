// server/scripts_den/phase4PreflightAudit.js
// ── Phase 4 D1 → Day 3 PREFLIGHT — comprehensive read-only audit ──────────────
//
// Run before flipping any IBKR_AUTO_* flag. Surfaces every divergence between
// PNTHR ↔ IBKR + every gap in PNTHR's own state, classified for triage. NO
// WRITES. Scott reviews every finding before any fix is applied (per
// feedback_accuracy.md: no shortcuts, no assumptions).
//
// Six sections:
//   1. POSITION PARITY     — orphans both directions, shares mismatch, avg drift
//   2. PROTECTIVE STOPS    — aligned, IBKR-tighter (silent adopt candidates),
//                            PNTHR-tighter (push to TWS candidates), shares mismatch
//   3. PYRAMID L2-5 PLANS  — IBKR-side trigger orders vs PNTHR algorithmic L2-5
//   4. PHASE 3 ROOT CAUSE  — for orphaned-in-IBKR tickers, what does
//                            signalService return? Why no pnthrStop?
//   5. STOP HISTORY        — positions whose stopPrice ≠ originalStop but
//                            stopHistory[] is empty (regression check)
//   6. JOURNAL PARITY      — active/partial positions missing pnthr_journal docs
//
// Run: node scripts_den/phase4PreflightAudit.js
//      node scripts_den/phase4PreflightAudit.js --json    # machine-readable
//
// Idempotent. Safe to re-run any time during triage.

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });
import { connectToDatabase } from '../database.js';
import { getSignals } from '../signalService.js';
import { normalizeSector } from '../sectorUtils.js';

const SCOTT  = '69c62632367d0e18498e7650';
const JSON_OUT = process.argv.includes('--json');

const SHARES_TOL_PCT = 0;     // shares are integers — exact match required
const AVG_TOL_PCT    = 0.5;   // %
const STOP_TOL_DOLLAR = 0.05; // ignore noise

function fm(n) { return n == null ? '—' : `$${(+n).toFixed(2)}`; }
function pctDiff(a, b) {
  if (a == null || b == null || b === 0) return null;
  return Math.abs((a - b) / b) * 100;
}

const db = await connectToDatabase();
if (!db) { console.error('NO DB'); process.exit(1); }

// ── Load source-of-truth data ────────────────────────────────────────────────
const ibkrDoc = await db.collection('pnthr_ibkr_positions').findOne({ ownerId: SCOTT });
const ibkrPositions = ibkrDoc?.positions  || [];
const ibkrStops     = ibkrDoc?.stopOrders || [];
const ibkrSyncedAt  = ibkrDoc?.syncedAt;

const pnthr = await db.collection('pnthr_portfolio').find({
  ownerId: SCOTT, status: { $in: ['ACTIVE', 'PARTIAL'] },
}).toArray();

const journals = await db.collection('pnthr_journal').find({
  ownerId: SCOTT,
}).project({ positionId: 1 }).toArray();
const journalPositionIds = new Set(journals.map(j => String(j.positionId)));

// Indexes
const ibkrByTicker = new Map(ibkrPositions.map(p => [p.symbol?.toUpperCase(), p]));
const stopsByTicker = new Map();
for (const s of ibkrStops) {
  const t = s.symbol?.toUpperCase();
  if (!t) continue;
  if (!stopsByTicker.has(t)) stopsByTicker.set(t, []);
  stopsByTicker.get(t).push(s);
}

// Group portfolio docs by ticker to surface duplicates as their own finding.
// When duplicates exist we use the most-recently-created doc as the
// representative for downstream parity checks (mirrors what
// findPositionByTicker does on the client).
const pnthrByTicker = new Map();
const duplicatePortfolioDocs = [];
{
  const grouped = new Map();
  for (const p of pnthr) {
    const t = p.ticker?.toUpperCase();
    if (!t) continue;
    if (!grouped.has(t)) grouped.set(t, []);
    grouped.get(t).push(p);
  }
  for (const [t, docs] of grouped) {
    if (docs.length > 1) {
      // Sort newest first
      const sorted = [...docs].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      duplicatePortfolioDocs.push({
        ticker: t,
        count: docs.length,
        docs: sorted.map(d => ({
          id: d.id,
          status: d.status,
          createdAt: d.createdAt,
          totalFilled: Object.values(d.fills || {}).reduce((s, f) => s + (f?.filled ? +f.shares || 0 : 0), 0),
          exitsCount: (d.exits || []).length,
        })),
      });
      pnthrByTicker.set(t, sorted[0]); // keep newest for downstream comparisons
    } else {
      pnthrByTicker.set(t, docs[0]);
    }
  }
}

// Compute current remaining shares for a portfolio doc, handling old schema
// (no totalFilledShares / remainingShares fields) and current schema both.
function computeRemainingShares(p) {
  const totalFilled = Object.values(p.fills || {}).reduce(
    (s, f) => s + (f?.filled ? +f.shares || 0 : 0), 0);
  const totalExited = (p.exits || []).reduce((s, e) => s + (+e.shares || 0), 0);
  const computed = totalFilled - totalExited;
  // Prefer canonical field if present and finite, else use the computed value.
  const canonical = +p.remainingShares;
  return Number.isFinite(canonical) ? canonical : computed;
}

// ── (1) POSITION PARITY ──────────────────────────────────────────────────────
const orphanedInIbkr = [];   // IBKR has shares, PNTHR has no active record
const orphanedInPnthr = [];  // PNTHR active, IBKR shows zero/missing
const sharesMismatches = []; // both exist, share counts differ
const avgCostDrift   = [];   // both exist, shares match, avg cost > 0.5% off

for (const ip of ibkrPositions) {
  const t = ip.symbol?.toUpperCase();
  if (!t) continue;
  const ibkrShares = Math.abs(+ip.shares || 0);
  if (ibkrShares <= 0) continue;
  const p = pnthrByTicker.get(t);
  if (!p) {
    orphanedInIbkr.push({
      ticker: t,
      ibkrShares,
      ibkrAvgCost: +ip.avgCost,
      ibkrLastPrice: +ip.marketPrice || null,
      direction: ip.shares > 0 ? 'LONG' : 'SHORT',
    });
    continue;
  }
}

// Iterate over deduplicated tickers (one representative per ticker) so the
// findings list doesn't double-report when duplicate portfolio docs exist.
for (const [t, p] of pnthrByTicker) {
  const ip = ibkrByTicker.get(t);
  const remaining = computeRemainingShares(p);

  if (!ip || Math.abs(+ip.shares || 0) <= 0) {
    orphanedInPnthr.push({
      ticker: t, direction: p.direction,
      pnthrRemaining: remaining,
      pnthrStop: p.stopPrice,
      status: p.status,
    });
    continue;
  }

  const ibkrShares = Math.abs(+ip.shares || 0);
  if (ibkrShares !== remaining) {
    sharesMismatches.push({
      ticker: t, direction: p.direction,
      ibkrShares,
      pnthrRemaining: remaining,
      diff: ibkrShares - remaining,
    });
  }

  // Avg cost drift (only when shares match — divergent shares masks the avg comparison)
  if (ibkrShares === remaining && +ip.avgCost > 0) {
    const fills = Object.values(p.fills || {}).filter(f => f?.filled && f.price && f.shares);
    const totalShares = fills.reduce((s, f) => s + (+f.shares || 0), 0);
    const totalCost   = fills.reduce((s, f) => s + (+f.shares || 0) * (+f.price || 0), 0);
    const pnthrAvg    = totalShares > 0 ? totalCost / totalShares : null;
    if (pnthrAvg != null) {
      const diffPct = pctDiff(+ip.avgCost, pnthrAvg);
      if (diffPct != null && diffPct > AVG_TOL_PCT) {
        avgCostDrift.push({
          ticker: t,
          ibkrAvg: +ip.avgCost,
          pnthrAvg: +pnthrAvg.toFixed(4),
          diffPct: +diffPct.toFixed(2),
          shares: ibkrShares,
        });
      }
    }
  }
}

// ── (2) PROTECTIVE STOP PARITY ───────────────────────────────────────────────
const stopsAligned   = [];
const ibkrTighter    = [];
const pnthrTighter   = [];
const stopSharesMismatch = [];
const naked          = [];

for (const [t, p] of pnthrByTicker) {
  const ip = ibkrByTicker.get(t);
  if (!ip || Math.abs(+ip.shares || 0) <= 0) continue;
  const isLong = (p.direction || 'LONG').toUpperCase() !== 'SHORT';
  const expectedAction = isLong ? 'SELL' : 'BUY';
  const ibkrShares = Math.abs(+ip.shares || 0);

  const stops = (stopsByTicker.get(t) || []).filter(s => s.action === expectedAction && s.orderType === 'STP');
  const protective = stops[0] || null;

  if (!protective) {
    naked.push({ ticker: t, direction: p.direction, ibkrShares, pnthrStop: p.stopPrice });
    continue;
  }

  if (Math.abs(+protective.shares || 0) !== ibkrShares) {
    stopSharesMismatch.push({
      ticker: t, direction: p.direction,
      ibkrPositionShares: ibkrShares,
      ibkrStopShares: +protective.shares,
      stopPrice: +protective.stopPrice,
      permId: protective.permId,
    });
  }

  const pnthrStop = +p.stopPrice;
  const ibkrStop  = +protective.stopPrice;
  if (!Number.isFinite(pnthrStop) || !Number.isFinite(ibkrStop)) continue;

  const ibkrIsTighter  = isLong ? (ibkrStop  - pnthrStop > STOP_TOL_DOLLAR) : (pnthrStop - ibkrStop > STOP_TOL_DOLLAR);
  const pnthrIsTighter = isLong ? (pnthrStop - ibkrStop  > STOP_TOL_DOLLAR) : (ibkrStop  - pnthrStop > STOP_TOL_DOLLAR);

  if (ibkrIsTighter) {
    ibkrTighter.push({ ticker: t, direction: p.direction, pnthrStop, ibkrStop, permId: protective.permId,
      diffPct: +pctDiff(ibkrStop, pnthrStop)?.toFixed(2) });
  } else if (pnthrIsTighter) {
    pnthrTighter.push({ ticker: t, direction: p.direction, pnthrStop, ibkrStop, permId: protective.permId,
      diffPct: +pctDiff(pnthrStop, ibkrStop)?.toFixed(2) });
  } else {
    stopsAligned.push({ ticker: t, stop: pnthrStop });
  }
}

// ── (3) PYRAMID L2-5 TRIGGER ORDERS ─────────────────────────────────────────
// For LONG: triggers are BUY STP (price breaks UP → add). For SHORT: SELL STP
// (price breaks DOWN → add to short). Anything not the protective stop gets
// listed alongside PNTHR's L2-L5 plan so Scott can decide adopt-or-update.
const triggerOrders = [];
for (const [t, p] of pnthrByTicker) {
  const ip = ibkrByTicker.get(t);
  if (!ip) continue;
  const isLong = (p.direction || 'LONG').toUpperCase() !== 'SHORT';
  const protectiveAction = isLong ? 'SELL' : 'BUY';
  const triggerAction    = isLong ? 'BUY'  : 'SELL';
  const ibkrTriggers = (stopsByTicker.get(t) || []).filter(s =>
    s.action === triggerAction && (s.orderType === 'STP' || s.orderType === 'STP LMT')
  );
  if (ibkrTriggers.length === 0) continue;
  triggerOrders.push({
    ticker: t,
    direction: p.direction,
    triggers: ibkrTriggers.map(s => ({
      action: s.action,
      orderType: s.orderType,
      shares: +s.shares,
      stopPrice: +s.stopPrice,
      permId: s.permId,
    })),
    pnthrEntry: p.entryPrice,
    pnthrStop:  p.stopPrice,
    pnthrFills: Object.entries(p.fills || {}).map(([k, f]) => ({
      lot: +k, filled: !!f.filled, shares: +f.shares || 0, price: +f.price || 0,
    })),
  });
}

// ── (4) PHASE 3 ROOT CAUSE for orphaned-in-IBKR ─────────────────────────────
const phase3Diagnostics = [];
if (orphanedInIbkr.length > 0) {
  console.error(`[audit] Inspecting signalService for ${orphanedInIbkr.length} orphaned-in-IBKR ticker(s)…`);
  const tickers = orphanedInIbkr.map(o => o.ticker);
  // Look up cached sectors so getSignals uses the right EMA period
  // Sector lookup mirrors ibkrSync.processNewPositions — direct FMP API call
  // with normalizeSector. If FMP fails or sector is missing, signalService
  // will fall back to the default EMA period (which is the same condition
  // Phase 3 hits in production).
  const sectorMap = {};
  for (const t of tickers) {
    try {
      const r = await fetch(
        `https://financialmodelingprep.com/api/v3/profile/${t}?apikey=${process.env.FMP_API_KEY}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (r.ok) {
        const data = await r.json();
        const raw  = data?.[0]?.sector || null;
        if (raw) sectorMap[t] = normalizeSector(raw);
      }
    } catch { /* non-fatal */ }
  }
  let signalsResult = {};
  try {
    signalsResult = await getSignals(tickers, { sectorMap });
  } catch (e) {
    console.error(`[audit] getSignals threw: ${e.message}`);
  }
  for (const o of orphanedInIbkr) {
    const sig = signalsResult[o.ticker] || {};
    const stopFromSig = sig.pnthrStop ?? sig.stopPrice ?? null;
    let blockReason = 'OK';
    if (stopFromSig == null) {
      if (sig.signal == null && sig.ema21 == null) blockReason = 'NO_DATA_FROM_SIGNAL_SERVICE';
      else if (sig.signal == null)                 blockReason = 'NO_ACTIVE_SIGNAL';
      else                                         blockReason = 'STOP_NOT_COMPUTED';
    }
    phase3Diagnostics.push({
      ticker:        o.ticker,
      ibkrShares:    o.ibkrShares,
      ibkrAvgCost:   o.ibkrAvgCost,
      direction:     o.direction,
      sectorCached:  sectorMap[o.ticker] || null,
      signalReturned: sig.signal || null,
      ema21:         sig.ema21 || null,
      pnthrStop:     stopFromSig,
      blockReason,
    });
  }
}

// ── (5) STOP HISTORY GAP CHECK ──────────────────────────────────────────────
const stopHistoryGaps = [];
for (const p of pnthrByTicker.values()) {
  const sp = +p.stopPrice;
  const op = +p.originalStop;
  if (!Number.isFinite(sp) || !Number.isFinite(op)) continue;
  const moved = Math.abs(sp - op) > STOP_TOL_DOLLAR;
  const histLen = Array.isArray(p.stopHistory) ? p.stopHistory.length : 0;
  if (moved && histLen === 0) {
    stopHistoryGaps.push({
      ticker: p.ticker?.toUpperCase(),
      direction: p.direction,
      originalStop: op,
      stopPrice: sp,
    });
  }
}

// ── (6) JOURNAL PARITY ───────────────────────────────────────────────────────
// Iterate over the FULL portfolio array (not the dedupe map) — we want to
// catch journals missing for any specific portfolio doc, including duplicates.
const missingJournal = [];
for (const p of pnthr) {
  if (!journalPositionIds.has(String(p.id))) {
    missingJournal.push({ ticker: p.ticker?.toUpperCase(), id: p.id, status: p.status });
  }
}

// ── REPORT ────────────────────────────────────────────────────────────────────
const report = {
  generatedAt: new Date().toISOString(),
  ibkrSyncedAt,
  counts: {
    pnthrActive:            pnthr.length,
    pnthrUniqueTickers:     pnthrByTicker.size,
    duplicatePortfolioDocs: duplicatePortfolioDocs.length,
    ibkrPositions:          ibkrPositions.filter(p => Math.abs(+p.shares || 0) > 0).length,
    ibkrStopOrders:         ibkrStops.length,
    orphanedInIbkr:         orphanedInIbkr.length,
    orphanedInPnthr:        orphanedInPnthr.length,
    sharesMismatches:       sharesMismatches.length,
    avgCostDrift:           avgCostDrift.length,
    naked:                  naked.length,
    stopsAligned:           stopsAligned.length,
    ibkrTighter:            ibkrTighter.length,
    pnthrTighter:           pnthrTighter.length,
    stopSharesMismatch:     stopSharesMismatch.length,
    triggerOrders:          triggerOrders.length,
    phase3Diagnostics:      phase3Diagnostics.length,
    stopHistoryGaps:        stopHistoryGaps.length,
    missingJournal:         missingJournal.length,
  },
  duplicatePortfolioDocs,
  orphanedInIbkr,
  orphanedInPnthr,
  sharesMismatches,
  avgCostDrift,
  naked,
  ibkrTighter,
  pnthrTighter,
  stopSharesMismatch,
  stopsAligned,
  triggerOrders,
  phase3Diagnostics,
  stopHistoryGaps,
  missingJournal,
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

// ── Pretty print ─────────────────────────────────────────────────────────────
console.log('\n╔══════════════════════════════════════════════════════════════════╗');
console.log('║  PHASE 4 PREFLIGHT AUDIT — read-only                              ║');
console.log(`║  Generated: ${report.generatedAt.slice(0, 19)}Z                          ║`);
console.log(`║  IBKR last sync: ${String(ibkrSyncedAt).slice(0, 24)}                  ║`);
console.log(`║  PNTHR active: ${String(pnthr.length).padEnd(3)} | IBKR pos (≠0 sh): ${String(report.counts.ibkrPositions).padEnd(3)} | IBKR stops: ${String(ibkrStops.length).padEnd(3)}  ║`);
console.log('╚══════════════════════════════════════════════════════════════════╝\n');

function section(num, title, count) {
  const bar = count === 0 ? '\x1b[32m✓\x1b[0m' : '\x1b[33m●\x1b[0m';
  console.log(`${bar} ${num}. ${title} — ${count} finding${count === 1 ? '' : 's'}`);
}

section('0', 'DUPLICATE PORTFOLIO DOCS (same ticker, multiple records)', duplicatePortfolioDocs.length);
for (const d of duplicatePortfolioDocs) {
  console.log(`     ${d.ticker.padEnd(6)} ${d.count} docs:`);
  for (const r of d.docs) {
    console.log(`        id=${r.id} status=${r.status} filled=${r.totalFilled}sh exits=${r.exitsCount} created=${r.createdAt ? new Date(r.createdAt).toISOString().slice(0,16) : '?'}`);
  }
}

section('1a', 'ORPHANED IN IBKR (PNTHR has no record)', orphanedInIbkr.length);
for (const o of orphanedInIbkr) {
  console.log(`     ${o.ticker.padEnd(6)} ${o.direction}  ${o.ibkrShares}sh @ avg ${fm(o.ibkrAvgCost)}  last ${fm(o.ibkrLastPrice)}`);
}

section('1b', 'ORPHANED IN PNTHR (PNTHR active but IBKR shows zero)', orphanedInPnthr.length);
for (const o of orphanedInPnthr) {
  console.log(`     ${o.ticker.padEnd(6)} ${o.direction}  PNTHR ${o.pnthrRemaining}sh stop ${fm(o.pnthrStop)} status=${o.status}`);
}

section('1c', 'SHARES MISMATCH (both exist, counts differ)', sharesMismatches.length);
for (const m of sharesMismatches) {
  console.log(`     ${m.ticker.padEnd(6)} ${m.direction}  IBKR ${m.ibkrShares}sh vs PNTHR ${m.pnthrRemaining}sh (diff ${m.diff > 0 ? '+' : ''}${m.diff})`);
}

section('1d', 'AVG COST DRIFT > 0.5% (shares match)', avgCostDrift.length);
for (const a of avgCostDrift) {
  console.log(`     ${a.ticker.padEnd(6)} IBKR avg ${fm(a.ibkrAvg)} vs PNTHR avg ${fm(a.pnthrAvg)} (diff ${a.diffPct}%, ${a.shares}sh)`);
}

section('2a', 'NAKED — PNTHR active with no IBKR protective stop', naked.length);
for (const n of naked) {
  console.log(`     ${n.ticker.padEnd(6)} ${n.direction}  ${n.ibkrShares}sh — needs ${n.direction === 'SHORT' ? 'BUY' : 'SELL'} STP @ ${fm(n.pnthrStop)}`);
}

section('2b', 'IBKR-TIGHTER stops (PNTHR should silently adopt)', ibkrTighter.length);
for (const m of ibkrTighter) {
  console.log(`     ${m.ticker.padEnd(6)} ${m.direction}  PNTHR ${fm(m.pnthrStop)} → IBKR ${fm(m.ibkrStop)} (diff ${m.diffPct}%)`);
}

section('2c', 'PNTHR-TIGHTER stops (push to TWS)', pnthrTighter.length);
for (const m of pnthrTighter) {
  console.log(`     ${m.ticker.padEnd(6)} ${m.direction}  IBKR ${fm(m.ibkrStop)} → PNTHR ${fm(m.pnthrStop)} (diff ${m.diffPct}%)`);
}

section('2d', 'STOP SHARES MISMATCH (stop order qty ≠ position size)', stopSharesMismatch.length);
for (const m of stopSharesMismatch) {
  console.log(`     ${m.ticker.padEnd(6)} ${m.direction}  position ${m.ibkrPositionShares}sh, STP ${m.ibkrStopShares}sh @ ${fm(m.stopPrice)} (permId ${m.permId})`);
}

section('3', 'PYRAMID TRIGGER ORDERS in IBKR (vs PNTHR L2-5 plan)', triggerOrders.length);
for (const t of triggerOrders) {
  const filledLot = (t.pnthrFills || []).filter(f => f.filled).map(f => f.lot).sort().pop() || 0;
  console.log(`     ${t.ticker.padEnd(6)} ${t.direction}  filled through Lot ${filledLot}`);
  for (const tr of t.triggers) {
    console.log(`        TWS: ${tr.action} ${tr.orderType} ${tr.shares}sh @ ${fm(tr.stopPrice)} (permId ${tr.permId})`);
  }
}

section('4', 'PHASE 3 ROOT-CAUSE diagnostics for orphaned-in-IBKR', phase3Diagnostics.length);
for (const d of phase3Diagnostics) {
  console.log(`     ${d.ticker.padEnd(6)} ${d.direction}  signal=${d.signalReturned || 'null'}  ema=${d.ema21 || 'null'}  pnthrStop=${d.pnthrStop ?? 'null'}  sector=${d.sectorCached || 'unknown'}  →  ${d.blockReason}`);
}

section('5', 'STOP HISTORY GAPS (stop moved but history empty)', stopHistoryGaps.length);
for (const s of stopHistoryGaps) {
  console.log(`     ${s.ticker.padEnd(6)} ${s.direction}  originalStop ${fm(s.originalStop)} → current ${fm(s.stopPrice)}`);
}

section('6', 'JOURNAL PARITY (active position with no journal doc)', missingJournal.length);
for (const m of missingJournal) {
  console.log(`     ${m.ticker.padEnd(6)} status=${m.status} positionId=${m.id}`);
}

const totalFindings =
    duplicatePortfolioDocs.length
  + orphanedInIbkr.length + orphanedInPnthr.length + sharesMismatches.length + avgCostDrift.length
  + naked.length + ibkrTighter.length + pnthrTighter.length + stopSharesMismatch.length
  + triggerOrders.length + phase3Diagnostics.length + stopHistoryGaps.length + missingJournal.length;

console.log('\n╔══════════════════════════════════════════════════════════════════╗');
console.log(`║  TOTAL FINDINGS: ${String(totalFindings).padStart(3)}  ${totalFindings === 0 ? '\x1b[32m✓ ZERO — proceed to Day 3 \x1b[0m' : '— review with Scott before any write   '} ║`);
console.log('╚══════════════════════════════════════════════════════════════════╝\n');

console.log('Re-run any time:  node scripts_den/phase4PreflightAudit.js');
console.log('Machine-readable: node scripts_den/phase4PreflightAudit.js --json\n');

process.exit(0);
