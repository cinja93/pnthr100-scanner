// crossEngineAudit.js — READ-ONLY cross-engine / IBKR integrity audit.
//
// WHY THIS EXISTS (2026-06-03 incident):
// PNTHR runs multiple trading engines (weekly ai300/679 portfolio in
// `pnthr_portfolio` + intraday Ambush in `pnthr_ambush_positions`) on ONE
// shared IBKR account. IBKR shows only the NET position per ticker. For over a
// month, ibkrSync auto-open silently shadowed Ambush fills into the ai300 book,
// creating duplicate records with competing stops/lot-triggers. It blew up when
// Ambush went live + the user traded manually: an orphaned shadow stop flipped
// AVGO short, and lot-add churn cost ~$709. The "lock-down audit" the night
// before passed because it only verified the Ambush engine IN ISOLATION — it
// never compared the two books against each other or against IBKR.
//
// This audit closes that blind spot. It checks the invariants that MUST hold on
// a single shared account, and is the gate to run before declaring "all set" or
// re-enabling any engine. It is strictly READ-ONLY: it never writes or trades.
//
// Run:  node crossEngineAudit.js            (uses ADMIN ownerId from env/default)
//       node crossEngineAudit.js <ownerId>
//
// Exit code 0 = PASS (no violations), 1 = VIOLATIONS FOUND.

import { MongoClient } from 'mongodb';
import fs from 'fs';

function loadEnv() {
  try {
    const env = fs.readFileSync(new URL('./.env', import.meta.url), 'utf8');
    for (const line of env.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* env already in process (e.g. running inside the server) */ }
}

const TERMINAL_AMBUSH_STATES = new Set(['CLOSED', 'EXITED']); // states that mean "not holding"

// Pull the single IBKR snapshot doc for an owner and index its positions/stops by ticker.
function indexIbkrSnapshot(snap) {
  const byTicker = {};
  const stopsByTicker = {};
  for (const p of (snap?.positions || [])) {
    const t = (p.symbol || p.ticker || '').toUpperCase();
    if (!t) continue;
    byTicker[t] = { shares: +p.shares || 0, avgCost: +p.avgCost || null, marketValue: typeof p.marketValue === 'number' ? p.marketValue : null };
  }
  for (const s of (snap?.stopOrders || [])) {
    const t = (s.symbol || '').toUpperCase();
    if (!t) continue;
    (stopsByTicker[t] = stopsByTicker[t] || []).push({
      action: s.action, orderType: s.orderType, stopPrice: +s.stopPrice || null,
      shares: +s.shares || null, permId: s.permId, orderRef: s.orderRef || null,
    });
  }
  return { byTicker, stopsByTicker, syncedAt: snap?.syncedAt || null };
}

export async function runCrossEngineAudit(db, ownerId) {
  const violations = [];
  const warnings = [];
  const add = (sev, code, ticker, detail) => (sev === 'WARN' ? warnings : violations).push({ code, ticker, detail });

  // ── Load all three sources of truth ──────────────────────────────────────
  const portfolio = await db.collection('pnthr_portfolio')
    .find({ ownerId, status: { $in: ['ACTIVE', 'PARTIAL'] } })
    .project({ ticker: 1, direction: 1, remainingShares: 1, totalFilledShares: 1, ibkrMarketValue: 1, status: 1 })
    .toArray();
  const ambush = await db.collection('pnthr_ambush_positions').find({}).toArray();
  const snapDoc = await db.collection('pnthr_ibkr_positions').findOne({ ownerId });
  const ibkr = indexIbkrSnapshot(snapDoc);

  // Index engine books by ticker
  const portByTicker = {};
  for (const p of portfolio) portByTicker[(p.ticker || '').toUpperCase()] = p;
  const ambHeld = {}; // ambush positions actually HOLDING shares
  const ambAll = {};
  for (const a of ambush) {
    const t = (a.ticker || '').toUpperCase();
    ambAll[t] = a;
    const holding = (+a.totalShares || 0) !== 0 && !TERMINAL_AMBUSH_STATES.has(a.state);
    if (holding) ambHeld[t] = a;
  }

  // ── Snapshot freshness ────────────────────────────────────────────────────
  const ageMin = ibkr.syncedAt ? (Date.now() - new Date(ibkr.syncedAt).getTime()) / 60000 : Infinity;
  if (!ibkr.syncedAt) add('WARN', 'NO_IBKR_SNAPSHOT', '-', 'pnthr_ibkr_positions has no snapshot for this owner — cannot verify against IBKR');
  else if (ageMin > 5) add('WARN', 'STALE_IBKR_SNAPSHOT', '-', `IBKR snapshot is ${ageMin.toFixed(0)} min old (bridge likely down) — IBKR comparisons may not reflect reality`);

  // ── INVARIANT 1: no ticker owned by BOTH engines (the shadow collision) ───
  for (const t of Object.keys(portByTicker)) {
    if (ambAll[t]) add('VIOLATION', 'CROSS_ENGINE_COLLISION', t,
      `held in ai300/679 (pnthr_portfolio ${portByTicker[t].direction}/${portByTicker[t].status}) AND tracked by Ambush (pnthr_ambush_positions ${ambAll[t].direction}/${ambAll[t].state}). A ticker must belong to exactly ONE engine.`);
  }

  // ── INVARIANT 2: recorded direction must agree with IBKR (the AVGO flip) ──
  const checkDirVsIbkr = (t, dir, src) => {
    const ib = ibkr.byTicker[t];
    if (!ib || ib.shares === 0) return; // handled by phantom check
    const ibDir = ib.shares > 0 ? 'LONG' : 'SHORT';
    if (dir && dir.toUpperCase() !== ibDir) {
      add('VIOLATION', 'DIRECTION_INVERSION', t,
        `${src} records ${dir} but IBKR holds ${ib.shares} (${ibDir}). Net account contradicts the book.`);
    }
  };
  for (const [t, p] of Object.entries(portByTicker)) checkDirVsIbkr(t, p.direction, 'ai300/679');
  for (const [t, a] of Object.entries(ambHeld)) checkDirVsIbkr(t, a.direction, 'Ambush');

  // ── INVARIANT 3: engine "holding" must match IBKR shares (phantom/divergence)
  const allEngineTickers = new Set([...Object.keys(portByTicker), ...Object.keys(ambHeld)]);
  if (ibkr.syncedAt && ageMin <= 60) {
    for (const t of allEngineTickers) {
      const eng = portByTicker[t] ? 'ai300/679' : 'Ambush';
      const engShares = portByTicker[t]
        ? Math.abs(+portByTicker[t].remainingShares || +portByTicker[t].totalFilledShares || 0)
        : Math.abs(+ambHeld[t].totalShares || 0);
      const ib = ibkr.byTicker[t];
      const ibShares = ib ? Math.abs(ib.shares) : 0;
      if (ibShares === 0) {
        add('VIOLATION', 'PHANTOM_POSITION', t, `${eng} is tracking ${engShares}sh but IBKR holds 0. Engine could trade shares that don't exist.`);
      } else if (engShares !== ibShares) {
        add('WARN', 'SHARE_DIVERGENCE', t, `${eng} tracks ${engShares}sh, IBKR holds ${ibShares}sh (diff ${engShares - ibShares}).`);
      }
    }
    // ── INVARIANT 4: IBKR holds a name NO engine tracks (untracked) ──────────
    for (const [t, ib] of Object.entries(ibkr.byTicker)) {
      if (ib.shares === 0) continue;
      if (!allEngineTickers.has(t)) add('WARN', 'UNTRACKED_IBKR_POSITION', t, `IBKR holds ${ib.shares}sh but no engine tracks it.`);
    }
    // ── INVARIANT 5: every held IBKR position has a correct-side protective stop
    for (const [t, ib] of Object.entries(ibkr.byTicker)) {
      if (ib.shares === 0) continue;
      const dir = ib.shares > 0 ? 'LONG' : 'SHORT';
      const wantAction = dir === 'LONG' ? 'SELL' : 'BUY';
      // A protective stop is any STP/STP LMT on the correct exit side (SELL for a long,
      // BUY for a short). Do NOT filter by price vs avgCost: a 2-bar TRAILING stop that
      // has ratcheted INTO PROFIT sits on the other side of entry (above entry for a
      // long, below for a short), and the old avgCost filter wrongly rejected those —
      // it false-flagged every profitable position as naked (AMAT/GRAB/KLAC/... on
      // 2026-06-03, masking the 2 genuinely naked names). The opposite-side lot-trigger
      // adds use the OPPOSITE action, so the action filter already excludes them.
      const stops = (ibkr.stopsByTicker[t] || []).filter(s =>
        s.action === wantAction && (s.orderType === 'STP' || s.orderType === 'STP LMT') &&
        Number.isFinite(s.stopPrice));
      if (stops.length === 0) add('VIOLATION', 'NO_PROTECTIVE_STOP', t, `${dir} ${Math.abs(ib.shares)}sh has NO ${wantAction} STP protecting it — naked.`);
      else if (stops.length > 1) add('WARN', 'DUPLICATE_STOPS', t, `${stops.length} protective stops (expected 1): ${stops.map(s => s.stopPrice).join(', ')}.`);
    }
  }

  return { violations, warnings, counts: { portfolio: portfolio.length, ambushHeld: Object.keys(ambHeld).length, ibkr: Object.keys(ibkr.byTicker).filter(t => ibkr.byTicker[t].shares !== 0).length }, ibkrSyncedAt: ibkr.syncedAt };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  loadEnv();
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME || 'pnthr100');
  // default to the admin owner used elsewhere in the incident data
  let ownerId = process.argv[2];
  if (!ownerId) {
    const anyAmbush = await db.collection('pnthr_ambush_config').findOne({ key: 'ambush_config' });
    const anyPort = await db.collection('pnthr_portfolio').findOne({ status: { $in: ['ACTIVE', 'PARTIAL'] } });
    ownerId = anyAmbush?.ownerId || anyPort?.ownerId;
  }
  console.log(`\n=== CROSS-ENGINE INTEGRITY AUDIT — owner ${ownerId} ===`);
  const r = await runCrossEngineAudit(db, ownerId);
  console.log(`Books: ai300/679=${r.counts.portfolio}  Ambush(held)=${r.counts.ambushHeld}  IBKR(open)=${r.counts.ibkr}  | IBKR synced: ${r.ibkrSyncedAt || 'NEVER'}`);
  if (r.warnings.length) {
    console.log(`\n⚠️  WARNINGS (${r.warnings.length}):`);
    for (const w of r.warnings) console.log(`   [${w.code}] ${w.ticker}: ${w.detail}`);
  }
  if (r.violations.length) {
    console.log(`\n🔴 VIOLATIONS (${r.violations.length}):`);
    for (const v of r.violations) console.log(`   [${v.code}] ${v.ticker}: ${v.detail}`);
    console.log(`\nRESULT: ❌ FAIL — ${r.violations.length} violation(s). Do NOT re-enable engines until resolved.`);
  } else {
    console.log(`\nRESULT: ✅ PASS — no invariant violations.${r.warnings.length ? ' (warnings above are advisory)' : ''}`);
  }
  await client.close();
  process.exit(r.violations.length ? 1 : 0);
}
