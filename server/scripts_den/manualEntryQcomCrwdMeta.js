// server/scripts_den/manualEntryQcomCrwdMeta.js
// ── Phase 2.3: Manual PNTHR entries for QCOM, CRWD, META ─────────────────────
//
// These three are orphaned-in-IBKR — Scott bought them today on his discretion
// when the most recent algorithmic state-machine event was 'SE' (Sell Exit
// from a prior SS position). Phase 3's safety guard correctly refused to
// auto-open without an algorithmic stop. Per the locked decision in
// PLAN_2026-04-29.md, the resolution is manual entry via AddPositionModal —
// this script is the equivalent server-side write so the entries are atomic,
// auditable, and idempotent.
//
// Source data (re-verified 2026-04-29 morning after Scott's overnight/morning
// activity — original 2026-04-28 figures had drifted; gates correctly aborted
// the first dry-run, prompting the re-snapshot below):
//   QCOM  26sh  IBKR avg $154.38253075  stop SELL STP 26 @ $142.50 permId 2143343519
//   CRWD   8sh  IBKR avg $449.37500000  stop SELL STP  8 @ $442.00 permId 772937278
//   META   5sh  IBKR avg $672.54000000  stop SELL STP  5 @ $668.50 permId 772937474
// XE removed from the entry list — Scott closed that position in TWS, so
// there is nothing to track in PNTHR.
//
// Per tightest-wins (feedback_earnings_week_stops.md), PNTHR adopts the TWS
// stop value for each. stopHistory[0] is tagged
// reason='MANUAL_ENTRY_FROM_TWS' with ibkrPermId so the audit trail records
// where the stop came from.
//
// HARD VERIFICATION GATES (run per ticker BEFORE any write — abort on any fail):
//   1. No existing PNTHR doc for ticker (would create a duplicate)
//   2. IBKR snapshot has the position with expected shares + direction LONG
//   3. IBKR has a SELL STP order matching expected stopPrice + shares + permId
//   4. FMP profile lookup succeeds with non-empty sector
//
// XE is NOT included — Scott must place a stop in TWS first, then we add it.
//
// Run:  node scripts_den/manualEntryQcomCrwdMeta.js          # dry-run
//       node scripts_den/manualEntryQcomCrwdMeta.js --apply  # write

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });
import { connectToDatabase } from '../database.js';
import { normalizeSector } from '../sectorUtils.js';

const APPLY  = process.argv.includes('--apply');
const SCOTT  = '69c62632367d0e18498e7650';
const TODAY  = new Date().toISOString().slice(0, 10);
const FMP_KEY = process.env.FMP_API_KEY;

if (!FMP_KEY) { console.error('FMP_API_KEY not set'); process.exit(1); }

// Expected source-of-truth values from the verification done with Scott.
// Each entry pins the exact IBKR state we expect — if reality has drifted
// (e.g. Scott sold/bought again before this script runs), gates will fail
// and the script aborts cleanly.
const ENTRIES = [
  {
    ticker:           'QCOM',
    direction:        'LONG',
    expectedShares:   26,
    expectedAvgCost:  154.38253075,
    expectedTwsStop:  142.50,
    expectedPermId:   2143343519,
    entryTimeNote:    'multiple TWS fills culminating at avg $154.38 (incl commissions); discretionary entry, signal=SE prevented Phase 3 auto-open',
  },
  {
    ticker:           'CRWD',
    direction:        'LONG',
    expectedShares:   8,
    expectedAvgCost:  449.375,
    expectedTwsStop:  442.00,
    expectedPermId:   772937278,
    entryTimeNote:    'multiple TWS fills culminating at avg $449.375; discretionary entry, signal=SE prevented Phase 3 auto-open',
  },
  {
    ticker:           'META',
    direction:        'LONG',
    expectedShares:   5,
    expectedAvgCost:  672.54,
    expectedTwsStop:  668.50,
    expectedPermId:   772937474,
    entryTimeNote:    'multiple TWS fills culminating at avg $672.54; discretionary entry, signal=SE prevented Phase 3 auto-open',
  },
];

const SHARES_TOL = 0;        // exact match — shares are integers
const AVG_TOL    = 0.01;     // $0.01 — IBKR avg cost can shift slightly between syncs
const STOP_TOL   = 0.01;     // exact — TWS stop should match exactly
const FMP_PRICE_TOL_PCT = 50; // very loose — last price can move; just sanity check

const db = await connectToDatabase();
if (!db) { console.error('NO DB'); process.exit(1); }

const ibkrDoc = await db.collection('pnthr_ibkr_positions').findOne({ ownerId: SCOTT });
const ibkrPositions = ibkrDoc?.positions  || [];
const ibkrStops     = ibkrDoc?.stopOrders || [];

console.log(`\n=== Phase 2.3 manual entry — ${APPLY ? 'APPLY' : 'DRY-RUN'} ===\n`);
console.log(`IBKR last sync: ${ibkrDoc?.syncedAt}`);
console.log(`Today: ${TODAY}`);
console.log(``);

// ── Gather + verify per ticker ──────────────────────────────────────────────
const verified = [];
let anyFail = false;

for (const e of ENTRIES) {
  console.log(`━━━ ${e.ticker} ━━━`);
  const gates = [];

  // Gate 1: PNTHR has no active record
  const existing = await db.collection('pnthr_portfolio').findOne({
    ownerId: SCOTT, ticker: e.ticker,
    status:  { $in: ['ACTIVE', 'PARTIAL'] },
  });
  gates.push({ name: 'no existing PNTHR doc',
    ok: !existing,
    detail: existing ? `found id=${existing.id} status=${existing.status}` : 'none — proceed' });

  // Gate 2: IBKR position exists with expected shape
  const ibkrPos = ibkrPositions.find(p => p.symbol?.toUpperCase() === e.ticker);
  const ibkrShares = ibkrPos ? Math.abs(+ibkrPos.shares || 0) : 0;
  const dirOk = ibkrPos ? ((+ibkrPos.shares > 0 ? 'LONG' : 'SHORT') === e.direction) : false;
  gates.push({ name: `IBKR position exists (${e.expectedShares}sh ${e.direction})`,
    ok: !!ibkrPos && ibkrShares === e.expectedShares && dirOk,
    detail: ibkrPos ? `${ibkrShares}sh dir=${+ibkrPos.shares > 0 ? 'LONG' : 'SHORT'}` : 'IBKR has no record' });

  const avgOk = ibkrPos ? Math.abs((+ibkrPos.avgCost || 0) - e.expectedAvgCost) < AVG_TOL : false;
  gates.push({ name: `IBKR avg cost matches expected`,
    ok: avgOk,
    detail: ibkrPos ? `IBKR=$${(+ibkrPos.avgCost).toFixed(8)} expected=$${e.expectedAvgCost}` : '—' });

  // Gate 3: TWS protective stop matches expected
  const stop = ibkrStops.find(s =>
    s.symbol?.toUpperCase() === e.ticker
    && s.action === (e.direction === 'LONG' ? 'SELL' : 'BUY')
    && s.orderType === 'STP'
    && +s.permId === e.expectedPermId);
  gates.push({ name: `TWS stop matches (permId ${e.expectedPermId})`,
    ok: !!stop && Math.abs((+stop.stopPrice || 0) - e.expectedTwsStop) < STOP_TOL && +stop.shares === e.expectedShares,
    detail: stop ? `${stop.shares}sh @ $${stop.stopPrice} (permId ${stop.permId})` : `permId ${e.expectedPermId} not found` });

  // Gate 4: FMP profile + sector
  let sector = null;
  let lastPrice = null;
  try {
    const r = await fetch(`https://financialmodelingprep.com/api/v3/profile/${e.ticker}?apikey=${FMP_KEY}`);
    if (r.ok) {
      const data = await r.json();
      if (Array.isArray(data) && data.length > 0) {
        const raw = data[0]?.sector;
        if (raw) sector = normalizeSector(raw);
        lastPrice = +data[0]?.price || null;
      }
    }
  } catch { /* sector stays null */ }
  gates.push({ name: `FMP profile + sector resolved`,
    ok: !!sector,
    detail: sector ? `sector=${sector} last=$${lastPrice}` : 'NO SECTOR — would skip' });

  // Print gates
  let allOk = true;
  for (const g of gates) {
    console.log(`  ${g.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${g.name.padEnd(45)} (${g.detail})`);
    if (!g.ok) allOk = false;
  }

  if (!allOk) { anyFail = true; continue; }

  // Build the doc
  const positionId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const isLong     = e.direction === 'LONG';
  const positionDoc = {
    id:                  positionId,
    ownerId:             SCOTT,
    ticker:              e.ticker,
    direction:           e.direction,
    sector:              sector,
    entryDate:           TODAY,
    entryPrice:          +(+ibkrPos.avgCost).toFixed(4),
    currentPrice:        (typeof ibkrPos.marketPrice === 'number' && ibkrPos.marketPrice > 0.01 && ibkrPos.marketPrice < 50000)
                            ? +(+ibkrPos.marketPrice).toFixed(4)
                            : +(+ibkrPos.avgCost).toFixed(4),
    stopPrice:           +e.expectedTwsStop,
    originalStop:        +e.expectedTwsStop,
    signal:              isLong ? 'BL' : 'SS',
    fills: {
      1: {
        lot:    1, name: 'The Scent', filled: true, pct: 1.0,
        shares: e.expectedShares,
        price:  +(+ibkrPos.avgCost).toFixed(4),
        date:   TODAY,
      },
    },
    exits:               [],
    totalFilledShares:   e.expectedShares,
    totalExitedShares:   0,
    remainingShares:     e.expectedShares,
    status:              'ACTIVE',
    autoOpenedByIBKR:    false,
    manualEntry:         true,
    manualEntryReason:   'PHASE_3_REFUSED_NO_ALGO_STOP',
    manualEntryNote:     `Discretionary entry per Scott's TWS execution at ${e.entryTimeNote}; signalService returned SE (no fresh BL) so Phase 3 safety guard refused auto-open. Stop adopted from TWS per tightest-wins.`,
    stopHistory: [
      {
        date:       TODAY,
        stop:       +e.expectedTwsStop,
        reason:     'MANUAL_ENTRY_FROM_TWS',
        from:       null,
        ibkrPermId: e.expectedPermId,
      },
    ],
    createdAt:           new Date(),
    updatedAt:           new Date(),
    ibkrSyncedAt:        ibkrDoc?.syncedAt,
    ibkrShares:          e.expectedShares,
    ibkrAvgCost:         +ibkrPos.avgCost,
    ibkrUnrealizedPNL:   typeof ibkrPos.unrealizedPNL === 'number' ? ibkrPos.unrealizedPNL : null,
    ibkrMarketValue:     typeof ibkrPos.marketValue   === 'number' ? ibkrPos.marketValue   : null,
  };

  verified.push({ ticker: e.ticker, positionDoc });
}

if (anyFail) {
  console.log(`\n\x1b[31mABORTED — at least one gate failed. No writes performed.\x1b[0m`);
  console.log('Investigate and re-run.\n');
  process.exit(1);
}

console.log(`\nAll gates passed for ${verified.length} ticker(s). Proposed writes:\n`);
for (const v of verified) {
  const d = v.positionDoc;
  console.log(`  ${d.ticker.padEnd(6)} ${d.direction}  ${d.totalFilledShares}sh @ $${d.entryPrice}  stop $${d.stopPrice}  sector=${d.sector}  positionId=${d.id}`);
}

if (!APPLY) {
  console.log(`\n\x1b[33mDRY-RUN complete. Re-run with --apply to write to MongoDB.\x1b[0m\n`);
  process.exit(0);
}

// ── Apply ────────────────────────────────────────────────────────────────────
console.log(`\nApplying…`);

const portCol = db.collection('pnthr_portfolio');
const journalServiceMod = await import('../journalService.js');

let writeCount = 0;
let journalCount = 0;
const writeErrors = [];

for (const { ticker, positionDoc } of verified) {
  try {
    await portCol.insertOne(positionDoc);
    writeCount++;
    console.log(`  ✓ ${ticker.padEnd(6)} pnthr_portfolio.insertOne — id=${positionDoc.id}`);

    // Mirror to journal so trade card / discipline scoring works from day 1
    try {
      await journalServiceMod.createJournalEntry(db, positionDoc, SCOTT);
      journalCount++;
      console.log(`  ✓ ${ticker.padEnd(6)} pnthr_journal entry created`);
    } catch (je) {
      console.log(`  ⚠ ${ticker.padEnd(6)} journal create failed: ${je.message} (position WAS inserted; can backfill later)`);
    }
  } catch (e) {
    writeErrors.push({ ticker, error: e.message });
    console.log(`  ✗ ${ticker.padEnd(6)} insert failed: ${e.message}`);
  }
}

// Post-state verification — every ticker should now have exactly one ACTIVE doc.
console.log(`\nPost-state verify:`);
for (const { ticker } of verified) {
  const docs = await portCol.find({
    ownerId: SCOTT, ticker, status: { $in: ['ACTIVE', 'PARTIAL'] },
  }).toArray();
  const ok = docs.length === 1;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${ticker.padEnd(6)} ${docs.length} active doc(s) — ${ok ? 'OK' : 'NEEDS REVIEW'}`);
}

console.log(`\nWrites: ${writeCount}/${verified.length} portfolio · ${journalCount}/${verified.length} journal`);
if (writeErrors.length > 0) {
  console.log(`\n\x1b[31mERRORS:\x1b[0m`);
  for (const e of writeErrors) console.log(`  ${e.ticker}: ${e.error}`);
  process.exit(1);
}

console.log(`\n\x1b[32m✓ APPLY complete. Re-run phase4PreflightAudit.js to confirm sections 1a + 4 dropped from 4 → 1 (XE remains).\x1b[0m\n`);
process.exit(0);
