// server/scripts/backfillKillAppearances.js
// ── One-time backfill: seed pnthr_kill_appearances from existing pnthr_kill_scores ──
//
// Run: node --env-file=server/.env server/scripts/backfillKillAppearances.js
//
// Seeds the appearances collection from ALL existing pnthr_kill_scores data,
// respecting the STRIKING+ threshold (totalScore >= 100).
// The earliest qualifying week for each ticker+signal becomes the firstAppearanceDate.

import { MongoClient } from 'mongodb';

const APPEARANCE_THRESHOLD = 100;

async function backfill() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db('pnthr_den');

  // Get all weeks in ascending order
  const weeks = await db.collection('pnthr_kill_scores')
    .distinct('weekOf');
  weeks.sort();
  console.log(`Found ${weeks.length} weeks of kill scores: ${weeks.join(', ')}`);

  // Get all qualifying records sorted oldest-first
  const allRecords = await db.collection('pnthr_kill_scores')
    .find({ totalScore: { $gte: APPEARANCE_THRESHOLD } })
    .sort({ weekOf: 1, killRank: 1 })
    .toArray();

  console.log(`Total qualifying records (score >= ${APPEARANCE_THRESHOLD}): ${allRecords.length}`);

  // Group by ticker+signal — earliest record = first appearance
  const appearanceMap = new Map(); // key: "ticker|signal"

  for (const rec of allRecords) {
    const key = `${rec.ticker}|${rec.signal}`;

    // Check if there's already a record for this key with a gap > 8 weeks
    const existing = appearanceMap.get(key);
    if (existing) {
      const lastSeen  = new Date(existing.lastSeenDate);
      const thisWeek  = new Date(rec.weekOf);
      const weeksDiff = (thisWeek - lastSeen) / (7 * 24 * 60 * 60 * 1000);

      if (weeksDiff > 8) {
        // Gap too large — this is a new cycle, save the old one and start fresh
        await upsertAppearance(db, existing);
        appearanceMap.delete(key);
      }
    }

    if (!appearanceMap.has(key)) {
      // New first appearance
      appearanceMap.set(key, {
        ticker:               rec.ticker,
        signal:               rec.signal,
        sector:               rec.sector ?? null,
        exchange:             rec.exchange ?? null,
        firstAppearanceDate:  rec.weekOf,
        firstAppearancePrice: rec.currentPrice ?? null,
        firstKillScore:       rec.totalScore,
        firstKillRank:        rec.killRank ?? null,
        firstTier:            rec.tier,
        firstSignalAge:       rec.signalAge ?? null,
        firstConvictionPct:   rec.convictionPct ?? rec.dimensions?.d3?.convictionPct ?? null,
        firstSlopePct:        rec.slopePct ?? rec.dimensions?.d3?.slopePct ?? null,
        firstSeparationPct:   rec.separationPct ?? rec.dimensions?.d3?.separationPct ?? null,
        lastSeenDate:         rec.weekOf,
        lastSeenPrice:        rec.currentPrice ?? null,
        lastKillScore:        rec.totalScore,
        lastKillRank:         rec.killRank ?? null,
        exitDate:             null,
        exitPrice:            null,
        profitPct:            null,
        holdingWeeks:         null,
        isWinner:             null,
        createdAt:            new Date(),
        updatedAt:            new Date(),
      });
    } else {
      // Update lastSeen for existing cycle
      const entry = appearanceMap.get(key);
      entry.lastSeenDate  = rec.weekOf;
      entry.lastSeenPrice = rec.currentPrice ?? null;
      entry.lastKillScore = rec.totalScore;
      entry.lastKillRank  = rec.killRank ?? null;
      entry.updatedAt     = new Date();
    }
  }

  // Save all remaining active appearances
  let saved = 0;
  for (const [, appearance] of appearanceMap) {
    await upsertAppearance(db, appearance);
    saved++;
  }

  console.log(`\nBackfill complete: ${saved} appearances saved to pnthr_kill_appearances`);

  // Print summary
  const all = await db.collection('pnthr_kill_appearances')
    .find({})
    .sort({ firstAppearanceDate: 1, firstKillRank: 1 })
    .toArray();

  console.log('\n── Appearance Records ────────────────────────────────────');
  for (const a of all) {
    const priceStr = a.firstAppearancePrice ? `$${a.firstAppearancePrice.toFixed(2)}` : 'N/A';
    console.log(
      `${a.ticker.padEnd(6)} ${a.signal} | First: ${a.firstAppearanceDate} @ ${priceStr} ` +
      `| Score: ${a.firstKillScore} | Rank: #${a.firstKillRank ?? '?'} | ${a.firstTier}`
    );
  }

  // Create indexes
  await db.collection('pnthr_kill_appearances').createIndex(
    { ticker: 1, signal: 1, lastSeenDate: -1 }
  );
  await db.collection('pnthr_kill_appearances').createIndex({ firstAppearanceDate: -1 });
  await db.collection('pnthr_kill_appearances').createIndex({ exitDate: 1 });
  console.log('\nIndexes created.');

  await client.close();
}

async function upsertAppearance(db, doc) {
  await db.collection('pnthr_kill_appearances').updateOne(
    {
      ticker:              doc.ticker,
      signal:              doc.signal,
      firstAppearanceDate: doc.firstAppearanceDate,
    },
    { $setOnInsert: doc },
    { upsert: true }
  );
}

backfill().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
