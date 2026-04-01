// server/backfillEntryConfirmed.js
// ── One-time backfill: add entryConfirmed to existing journal entries ──────────
// Constructs entryConfirmed from data already stored on each entry.
// Safe: only adds a new field — never touches fills, stops, scores, or exits.
//
// Run from project root: node server/backfillEntryConfirmed.js
// ─────────────────────────────────────────────────────────────────────────────
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { MongoClient } from 'mongodb';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

async function buildEntryConfirmed(entry) {
  const kse = entry.killScoreAtEntry || null;
  const mat = entry.marketAtEntry    || null;
  const ec  = entry.entryContext     || null;

  const captured = {
    capturedAt:   entry.createdAt || new Date(),   // use original entry date
    killScore:    kse?.totalScore ?? null,
    killRank:     kse?.rank       ?? null,
    killTier:     kse?.tier       ?? null,
    signal:       entry.signal    ?? null,
    signalAge:    entry.signalAge ?? null,
    entryContext: ec,
    indexTrend:   mat?.spyPosition    ?? null,
    sectorTrend:  mat?.sectorPosition ?? null,
    regime:       mat?.regime?.label  ?? null,
    dataSource:   entry.dataSource    || 'BACKFILL',
  };

  captured.allCaptured = !!(
    captured.killScore   != null &&
    captured.killRank    != null &&
    captured.signal      != null &&
    captured.signalAge   != null &&
    captured.entryContext && captured.entryContext !== 'NO_SIGNAL' &&
    captured.indexTrend  != null &&
    captured.sectorTrend != null &&
    captured.regime      != null
  );

  return captured;
}

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('❌ MONGODB_URI not set'); process.exit(1); }
  const dbName = process.env.MONGODB_DB_NAME || 'pnthr100';
  const client = new MongoClient(uri);
  await client.connect();
  console.log('✅ Connected to MongoDB');
  const db  = client.db(dbName);
  const col = db.collection('pnthr_journal');

  // Only process entries that don't already have entryConfirmed
  const entries = await col.find({ entryConfirmed: { $exists: false } }).toArray();

  if (entries.length === 0) {
    console.log('✅ All journal entries already have entryConfirmed — nothing to do.');
    process.exit(0);
  }

  console.log(`📋 Found ${entries.length} journal entr${entries.length === 1 ? 'y' : 'ies'} to backfill...\n`);

  let updated  = 0;
  let partial  = 0;
  let complete = 0;

  for (const entry of entries) {
    const ec = await buildEntryConfirmed(entry);

    await col.updateOne(
      { _id: entry._id },
      { $set: { entryConfirmed: ec, updatedAt: new Date() } }
    );

    const status = ec.allCaptured ? '✅ COMPLETE' : '⚠️  PARTIAL ';
    const missing = Object.entries(ec)
      .filter(([k, v]) => k !== 'capturedAt' && k !== 'dataSource' && k !== 'allCaptured' && v == null)
      .map(([k]) => k);

    console.log(`  ${status}  ${entry.ticker.padEnd(6)} (${entry.direction})` +
      (missing.length ? `  — missing: ${missing.join(', ')}` : ''));

    if (ec.allCaptured) complete++; else partial++;
    updated++;
  }

  console.log(`\n─────────────────────────────────────────────`);
  console.log(`✅ Backfill complete: ${updated} entr${updated === 1 ? 'y' : 'ies'} updated`);
  console.log(`   ${complete} fully captured · ${partial} partial (will prompt at close)`);
  await client.close();
  process.exit(0);
}

run().catch(err => {
  console.error('❌ Backfill failed:', err);
  process.exit(1);
});
