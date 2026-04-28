// server/scripts_den/repairTodaysExits.js
// ── One-time backfill for 2026-04-28 stop-outs + EXPE ghost ──────────────────
//
// Repairs three categories of broken close records caused by the pre-fix
// IBKR auto-close path:
//
//   A) Schema-split (9 tickers): outcome.* set on portfolio but canonical
//      exits[] / realizedPnl.* / totalFilled fields missing. Journal IS
//      complete (it was written via syncExitToJournal). Fix = mirror exit
//      data from outcome.* into the canonical portfolio fields.
//
//   B) No journal (5 tickers): same portfolio symptom as A, plus journal
//      doc was never created (recordExit-via-Phase-2 silent fail). Fix =
//      same as A on portfolio + createJournalEntry + syncExitToJournal.
//
//   C) Ghost-active (EXPE): IBKR no longer holds it, PNTHR still ACTIVE,
//      no journal. Phase 2 never fired. Fix = recordExit() with TWS exit
//      data ($239.552 @ 07:34:41 from Scott's TWS history).
//
// Run order:
//   node scripts_den/repairTodaysExits.js              # dry run (default)
//   node scripts_den/repairTodaysExits.js --apply      # actually write
//
// Idempotent: re-running after success is a no-op (skips repaired records).
// Per-ticker try/catch — one failure does not abort the rest.
// Audit log written to scripts_den/_repair_log_<date>.json.

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });
import { connectToDatabase } from '../database.js';
import { recordExit, syncExitToJournal } from '../exitService.js';
import { createJournalEntry } from '../journalService.js';
import { normalizeSector } from '../sectorUtils.js';
import fs from 'node:fs';

const APPLY = process.argv.includes('--apply');
const SCOTT = '69c62632367d0e18498e7650';

// Tickers that need repair, grouped by category.
// Group A + B come from today's audit; group C is EXPE per TWS image.
const SCHEMA_SPLIT_TICKERS = ['MU', 'QQQ', 'META', 'ITB', 'AIA', 'GRID', 'ONEQ', 'CVNA', 'NVDA'];
const NO_JOURNAL_TICKERS   = ['SWK', 'FIVE', 'TWLO', 'XE', 'CRWD'];

// EXPE exit data from Scott's TWS history (image timestamp 07:34:41 PT, IBKRATS+1)
const EXPE_EXIT = {
  ticker: 'EXPE',
  shares: 10,
  price:  239.552,
  date:   '2026-04-28',
  time:   '07:34',
  // Stale stop $223.31 → 7% gap → MANUAL per default logic. User can later
  // edit the journal note if this was actually a ratcheted-stop hit.
  reason: 'MANUAL',
  note:   '',
};

const FMP_API_KEY = process.env.FMP_API_KEY;

async function fetchSectorFromFmp(ticker) {
  if (!FMP_API_KEY) return null;
  try {
    const r = await fetch(
      `https://financialmodelingprep.com/api/v3/profile/${ticker}?apikey=${FMP_API_KEY}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return null;
    const data = await r.json();
    const raw = data?.[0]?.sector || null;
    // Normalize FMP sector strings ("Consumer Cyclical" → "Consumer
    // Discretionary") so downstream OpEMA lookup + Analyze T1-D scoring
    // get the canonical PNTHR sector name.
    return raw ? normalizeSector(raw) : null;
  } catch { return null; }
}

// ── Per-ticker handlers ────────────────────────────────────────────────────

// Group A — portfolio has outcome.* but missing canonical exits/realizedPnl.
// Mirror outcome → canonical fields. Don't touch journal (already complete).
async function repairSchemaSplit(db, ticker, dry) {
  const p = await db.collection('pnthr_portfolio').findOne({
    ownerId: SCOTT, ticker, status: 'CLOSED',
  }, { sort: { closedAt: -1 } });
  if (!p) return { ticker, status: 'SKIP', reason: 'no closed portfolio doc found' };
  if ((p.exits || []).length > 0) return { ticker, status: 'SKIP', reason: 'already repaired (exits[] not empty)' };
  if (!p.outcome?.exitPrice) return { ticker, status: 'SKIP', reason: 'no outcome.* data to mirror' };

  // Recompute totals from fills (defense-in-depth — Strategy B from discussion)
  const fills = Object.values(p.fills || {}).filter(f => f && f.filled && f.price && f.shares);
  const totalFilled = fills.reduce((s, f) => s + (+f.shares || 0), 0);
  if (totalFilled === 0) return { ticker, status: 'ERROR', reason: 'no filled shares — cannot compute exit record' };

  const totalCost   = fills.reduce((s, f) => s + (+f.shares * +f.price), 0);
  const avgCost     = totalCost / totalFilled;
  const exitPrice   = +p.outcome.exitPrice;
  const exitShares  = totalFilled; // full close
  const dir         = (p.direction || 'LONG').toUpperCase();
  const perShare    = dir === 'SHORT' ? avgCost - exitPrice : exitPrice - avgCost;
  const dollarPnl   = +(perShare * exitShares).toFixed(2);
  const pctPnl      = avgCost > 0 ? +(perShare / avgCost * 100).toFixed(2) : 0;

  // Sanity check vs journal's stored realized P&L (must match within $0.01)
  const j = await db.collection('pnthr_journal').findOne({
    positionId: p.id, ownerId: SCOTT,
  });
  const jDollar = j?.performance?.realizedPnlDollar;
  const sanityOk = jDollar == null || Math.abs(jDollar - dollarPnl) < 0.01;
  if (!sanityOk) {
    return { ticker, status: 'MISMATCH', reason: `recomputed $${dollarPnl} ≠ journal $${jDollar}`, details: { recomputed: dollarPnl, journal: jDollar } };
  }

  const exitRecord = {
    id:             'E1',
    shares:         exitShares,
    price:          exitPrice,
    date:           p.closedAt ? new Date(p.closedAt).toISOString().split('T')[0] : '2026-04-28',
    time:           p.closedAt ? new Date(p.closedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }) : '06:30',
    reason:         p.outcome.exitReason || 'STOP_HIT',
    note:           '',
    isOverride:     p.outcome.exitReason === 'MANUAL',
    isFinalExit:    true,
    pnl: { dollar: dollarPnl, pct: pctPnl, perShare: +perShare.toFixed(4) },
    remainingShares: 0,
    marketAtExit:   {},
    createdAt:      p.closedAt ? new Date(p.closedAt) : new Date(),
  };

  const update = {
    $push: { exits: exitRecord },
    $set: {
      totalFilledShares:        totalFilled,
      totalExitedShares:        exitShares,
      remainingShares:          0,
      avgExitPrice:             +exitPrice.toFixed(4),
      'realizedPnl.dollar':     dollarPnl,
      'realizedPnl.pct':        pctPnl,
      updatedAt:                new Date(),
      repairedAt:               new Date(),
      repairedFrom:             'outcome',
    },
  };

  if (dry) return { ticker, status: 'DRY_RUN', action: 'mirror outcome→exits[]', preview: { exitRecord, update } };

  await db.collection('pnthr_portfolio').updateOne({ id: p.id, ownerId: SCOTT }, update);
  return { ticker, status: 'OK', action: 'mirrored outcome→exits[]', dollarPnl, pctPnl };
}

// Group B — same portfolio fix as A, but also create journal first.
async function repairNoJournal(db, ticker, dry) {
  const p = await db.collection('pnthr_portfolio').findOne({
    ownerId: SCOTT, ticker, status: 'CLOSED',
  }, { sort: { closedAt: -1 } });
  if (!p) return { ticker, status: 'SKIP', reason: 'no closed portfolio doc found' };
  if ((p.exits || []).length > 0) return { ticker, status: 'SKIP', reason: 'already repaired' };

  // Sector enrichment if missing
  let sector = p.sector;
  let sectorEnriched = false;
  if (!sector) {
    sector = await fetchSectorFromFmp(ticker);
    sectorEnriched = !!sector;
  }

  // Recompute exit math (Strategy B)
  const fills = Object.values(p.fills || {}).filter(f => f && f.filled && f.price && f.shares);
  const totalFilled = fills.reduce((s, f) => s + (+f.shares || 0), 0);
  if (totalFilled === 0) return { ticker, status: 'ERROR', reason: 'no filled shares' };
  const totalCost  = fills.reduce((s, f) => s + (+f.shares * +f.price), 0);
  const avgCost    = totalCost / totalFilled;
  const exitPrice  = +p.outcome?.exitPrice;
  if (!exitPrice) return { ticker, status: 'ERROR', reason: 'no outcome.exitPrice' };
  const dir        = (p.direction || 'LONG').toUpperCase();
  const perShare   = dir === 'SHORT' ? avgCost - exitPrice : exitPrice - avgCost;
  const dollarPnl  = +(perShare * totalFilled).toFixed(2);
  const pctPnl     = avgCost > 0 ? +(perShare / avgCost * 100).toFixed(2) : 0;

  const exitRecord = {
    id:             'E1',
    shares:         totalFilled,
    price:          exitPrice,
    date:           p.closedAt ? new Date(p.closedAt).toISOString().split('T')[0] : '2026-04-28',
    time:           p.closedAt ? new Date(p.closedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }) : '07:00',
    reason:         p.outcome?.exitReason || 'STOP_HIT',
    note:           '',
    isOverride:     p.outcome?.exitReason === 'MANUAL',
    isFinalExit:    true,
    pnl: { dollar: dollarPnl, pct: pctPnl, perShare: +perShare.toFixed(4) },
    remainingShares: 0,
    marketAtExit:   {},
    createdAt:      p.closedAt ? new Date(p.closedAt) : new Date(),
  };

  const portfolioUpdate = {
    $push: { exits: exitRecord },
    $set: {
      totalFilledShares:        totalFilled,
      totalExitedShares:        totalFilled,
      remainingShares:          0,
      avgExitPrice:             +exitPrice.toFixed(4),
      'realizedPnl.dollar':     dollarPnl,
      'realizedPnl.pct':        pctPnl,
      updatedAt:                new Date(),
      repairedAt:               new Date(),
      repairedFrom:             'outcome+createJournal',
      ...(sectorEnriched ? { sector } : {}),
    },
  };

  if (dry) {
    return {
      ticker, status: 'DRY_RUN',
      action: 'create journal + mirror outcome→exits[]',
      sectorEnriched, sector,
      preview: { exitRecord, portfolioUpdate },
    };
  }

  // Write portfolio first (canonical fields), then create journal, then sync exit to journal
  await db.collection('pnthr_portfolio').updateOne({ id: p.id, ownerId: SCOTT }, portfolioUpdate);
  const refreshedP = await db.collection('pnthr_portfolio').findOne({ id: p.id, ownerId: SCOTT });

  try {
    await createJournalEntry(db, refreshedP, SCOTT);
  } catch (e) {
    return { ticker, status: 'ERROR', reason: `createJournalEntry failed: ${e.message}` };
  }

  try {
    await syncExitToJournal(db, p.id, SCOTT, exitRecord, 0, dollarPnl, pctPnl, exitPrice, 'CLOSED', refreshedP);
  } catch (e) {
    return { ticker, status: 'ERROR', reason: `syncExitToJournal failed: ${e.message}` };
  }

  return { ticker, status: 'OK', action: 'created journal + mirrored outcome', dollarPnl, pctPnl, sectorEnriched, sector };
}

// Group C — EXPE ghost. Use recordExit() directly since Phase 2 never ran.
async function repairExpeGhost(db, dry) {
  const ticker = EXPE_EXIT.ticker;
  const p = await db.collection('pnthr_portfolio').findOne({
    ownerId: SCOTT, ticker, status: 'ACTIVE',
  }, { sort: { createdAt: -1 } });
  if (!p) return { ticker, status: 'SKIP', reason: 'no ACTIVE EXPE position found (already closed?)' };

  // Sector enrichment if missing
  let sector = p.sector;
  let sectorEnriched = false;
  if (!sector) {
    sector = await fetchSectorFromFmp(ticker);
    sectorEnriched = !!sector;
    if (!dry && sector) {
      await db.collection('pnthr_portfolio').updateOne({ id: p.id, ownerId: SCOTT }, { $set: { sector } });
    }
  }

  if (dry) {
    return {
      ticker, status: 'DRY_RUN',
      action: 'recordExit() with TWS exit data',
      sectorEnriched, sector,
      preview: { exitData: EXPE_EXIT },
    };
  }

  let result;
  try {
    result = await recordExit(db, p.id, SCOTT, EXPE_EXIT);
  } catch (e) {
    return { ticker, status: 'ERROR', reason: `recordExit failed: ${e.message}` };
  }

  // Audit field so this one is recognizable as a backfilled ghost
  await db.collection('pnthr_portfolio').updateOne(
    { id: p.id, ownerId: SCOTT },
    { $set: { repairedAt: new Date(), repairedFrom: 'TWS_GHOST_BACKFILL', autoClosedByIBKR: false } }
  );

  return {
    ticker, status: 'OK',
    action: 'recordExit() with TWS exit data',
    dollarPnl: result.exitRecord.pnl.dollar,
    pctPnl:    result.exitRecord.pnl.pct,
    sectorEnriched, sector,
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const db = await connectToDatabase();
  const mode = APPLY ? 'APPLY' : 'DRY-RUN';
  console.log(`\n=== Repair today's exits — ${mode} ===\n`);

  const results = { schemaSplit: [], noJournal: [], ghost: [] };

  // Group A
  console.log('--- Group A: schema-split (mirror outcome → canonical) ---');
  for (const t of SCHEMA_SPLIT_TICKERS) {
    try {
      const r = await repairSchemaSplit(db, t, !APPLY);
      console.log(`  ${t.padEnd(6)} ${r.status.padEnd(10)} ${r.action || r.reason || ''}`);
      results.schemaSplit.push(r);
    } catch (e) {
      const r = { ticker: t, status: 'ERROR', reason: e.message };
      console.log(`  ${t.padEnd(6)} ERROR     ${e.message}`);
      results.schemaSplit.push(r);
    }
  }

  // Group B
  console.log('\n--- Group B: no journal (create journal + mirror) ---');
  for (const t of NO_JOURNAL_TICKERS) {
    try {
      const r = await repairNoJournal(db, t, !APPLY);
      console.log(`  ${t.padEnd(6)} ${r.status.padEnd(10)} ${r.action || r.reason || ''} ${r.sectorEnriched ? `(sector: ${r.sector})` : ''}`);
      results.noJournal.push(r);
    } catch (e) {
      const r = { ticker: t, status: 'ERROR', reason: e.message };
      console.log(`  ${t.padEnd(6)} ERROR     ${e.message}`);
      results.noJournal.push(r);
    }
  }

  // Group C
  console.log('\n--- Group C: EXPE ghost (recordExit with TWS data) ---');
  try {
    const r = await repairExpeGhost(db, !APPLY);
    console.log(`  ${'EXPE'.padEnd(6)} ${r.status.padEnd(10)} ${r.action || r.reason || ''} ${r.sectorEnriched ? `(sector: ${r.sector})` : ''}`);
    results.ghost.push(r);
  } catch (e) {
    const r = { ticker: 'EXPE', status: 'ERROR', reason: e.message };
    console.log(`  EXPE   ERROR     ${e.message}`);
    results.ghost.push(r);
  }

  // Summary
  const all = [...results.schemaSplit, ...results.noJournal, ...results.ghost];
  const counts = all.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
  console.log(`\n=== Summary (${mode}) ===`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);

  // Audit log file
  const logPath = new URL('./_repair_log_2026-04-28.json', import.meta.url).pathname;
  fs.writeFileSync(logPath, JSON.stringify({ mode, runAt: new Date().toISOString(), counts, results }, null, 2));
  console.log(`\nAudit log: ${logPath}`);

  if (!APPLY) {
    console.log('\nThis was a DRY RUN. Re-run with --apply to actually write.');
  } else {
    console.log('\nWrites applied. Run audit script to verify.');
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
