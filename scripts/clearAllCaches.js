#!/usr/bin/env node
// scripts/clearAllCaches.js
// Clears stale cached data from MongoDB. Safe to run after any deployment.
// Usage: MONGODB_URI=<uri> node scripts/clearAllCaches.js

import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config({ path: new URL('../server/.env', import.meta.url).pathname });

const uri  = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'pnthr_den';

if (!uri) {
  console.error('ERROR: MONGODB_URI not set. Add it to server/.env or pass as env var.');
  process.exit(1);
}

async function clearCaches() {
  const client = new MongoClient(uri);
  await client.connect();
  console.log(`Connected to MongoDB — database: ${dbName}\n`);
  const db = client.db(dbName);

  // 1. Candle cache — forces fresh FMP fetch on next page load
  const candles = await db.collection('pnthr_candle_cache').deleteMany({});
  console.log(`✓ Candle cache:        cleared ${candles.deletedCount} entries`);

  // 2. Stale Kill scores older than 2 weeks
  const twoWeeksAgo = new Date();
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  const staleScores = await db.collection('pnthr_kill_scores').deleteMany({
    createdAt: { $lt: twoWeeksAgo },
  });
  console.log(`✓ Stale Kill scores:   cleared ${staleScores.deletedCount} entries`);

  // 3. Expired / dismissed pending entries
  const expiredEntries = await db.collection('pnthr_pending_entries').deleteMany({
    status: { $in: ['EXPIRED', 'DISMISSED'] },
  });
  console.log(`✓ Expired entries:     cleared ${expiredEntries.deletedCount} entries`);

  // 4. Index check — reports how many indexes each collection has
  console.log('\nIndex counts per collection:');
  const collections = [
    'pnthr_portfolio',
    'pnthr_kill_scores',
    'pnthr_kill_regime',
    'pnthr_kill_history',
    'pnthr_gap_risk',
    'pnthr_candle_cache',
    'pnthr_pending_entries',
    'user_profiles',
    'newsletter_issues',
  ];
  for (const name of collections) {
    try {
      const indexes = await db.collection(name).indexes();
      console.log(`  ${name.padEnd(28)} ${indexes.length} index${indexes.length !== 1 ? 'es' : ''}`);
    } catch {
      console.log(`  ${name.padEnd(28)} (not found)`);
    }
  }

  await client.close();
  console.log('\n✓ All done. Caches cleared and indexes verified.');
}

clearCaches().catch(err => {
  console.error('Cache clear failed:', err.message);
  process.exit(1);
});
