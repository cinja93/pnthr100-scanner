/**
 * One-time migration: import pnthr679_ALL_signals_history.csv
 * into MongoDB collection `pnthr679_trade_archive`.
 *
 * Run from project root:
 *   node --env-file=server/.env server/scripts/importTradeArchive.js
 *
 * Safe to re-run — drops and recreates the collection each time.
 */

import { MongoClient } from 'mongodb';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = resolve(__dirname, '../../../Downloads/pnthr679_ALL_signals_history.csv');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME     = process.env.MONGODB_DB_NAME || 'pnthr100';
const COLLECTION  = 'pnthr679_trade_archive';

// ── Parse CSV ──────────────────────────────────────────────────────────────

function parseCSV(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  const lines = raw.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());

  return lines.slice(1).map((line, i) => {
    const values = line.split(',');
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx]?.trim() ?? '';
    });

    // Coerce numeric fields
    const nums = [
      'currentPrice','ytdReturn','entryPrice','ema21AtEntry','emaSeparationPct',
      'closeConvictionPct','emaSlopePct','weekHighAtEntry','weekLowAtEntry',
      'weekCloseAtEntry','exitPrice','profitDollar','profitPct','holdingWeeks'
    ];
    nums.forEach(f => {
      if (row[f] !== '' && row[f] !== undefined) {
        const n = parseFloat(row[f]);
        row[f] = isNaN(n) ? null : n;
      } else {
        row[f] = null;
      }
    });

    // Coerce booleans
    row.isWinner   = row.isWinner   === 'WIN';
    row.bigWinner  = row.bigWinner  === 'YES';

    // Coerce dates to Date objects (keep strings if malformed)
    ['entryDate','exitDate'].forEach(f => {
      if (row[f] && /^\d{4}-\d{2}-\d{2}$/.test(row[f])) {
        row[f] = new Date(row[f] + 'T00:00:00Z');
      }
    });

    row._importedAt = new Date();
    return row;
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!MONGODB_URI) {
    console.error('❌ MONGODB_URI not set. Did you pass --env-file=server/.env?');
    process.exit(1);
  }

  console.log(`📂 Reading CSV from: ${CSV_PATH}`);
  const records = parseCSV(CSV_PATH);
  console.log(`✅ Parsed ${records.length} records`);

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  const col = db.collection(COLLECTION);

  // Drop existing and reimport fresh
  await col.drop().catch(() => {});
  console.log(`🗑️  Dropped existing ${COLLECTION} (if any)`);

  const result = await col.insertMany(records);
  console.log(`✅ Inserted ${result.insertedCount} documents into ${COLLECTION}`);

  // Indexes for common query patterns
  await col.createIndex({ ticker: 1 });
  await col.createIndex({ sector: 1 });
  await col.createIndex({ signal: 1 });
  await col.createIndex({ status: 1 });
  await col.createIndex({ entryDate: -1 });
  await col.createIndex({ exitDate: -1 });
  await col.createIndex({ isWinner: 1 });
  await col.createIndex({ bigWinner: 1 });
  await col.createIndex({ profitPct: -1 });
  await col.createIndex({ holdingWeeks: 1 });
  console.log('✅ Indexes created');

  // Quick sanity check
  const total      = await col.countDocuments();
  const closed     = await col.countDocuments({ status: 'CLOSED' });
  const winners    = await col.countDocuments({ isWinner: true });
  const bigWinners = await col.countDocuments({ bigWinner: true });
  const blCount    = await col.countDocuments({ signal: 'BL' });
  const ssCount    = await col.countDocuments({ signal: 'SS' });

  console.log('\n── Summary ───────────────────────────────');
  console.log(`  Total records : ${total}`);
  console.log(`  Closed trades : ${closed}`);
  console.log(`  Winners       : ${winners} (${((winners/closed)*100).toFixed(1)}% win rate)`);
  console.log(`  Big winners   : ${bigWinners}`);
  console.log(`  BL signals    : ${blCount}`);
  console.log(`  SS signals    : ${ssCount}`);
  console.log('──────────────────────────────────────────\n');

  await client.close();
  console.log('🎉 Import complete. Collection: pnthr679_trade_archive');
}

main().catch(err => {
  console.error('❌ Import failed:', err.message);
  process.exit(1);
});
