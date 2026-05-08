// server/scripts/aiUniverse/buildAiUniverseConstituents.js
// ── PNTHR AI Universe Constituents Builder ──────────────────────────────────
//
// Populates the `pnthr_ai_universe_constituents` MongoDB collection from the
// canonical white-paper data file (aiUniverseData.js). One document per ticker
// with sector, sub-sector, target weight, conviction tier, and PNTHR thesis.
//
// Idempotent: re-run any time the basket changes. Upserts by ticker.
//
// Usage:  cd server && node scripts/aiUniverse/buildAiUniverseConstituents.js
// ────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../../.env', import.meta.url).pathname });

import { connectToDatabase } from '../../database.js';
import { SECTORS, FUND_META } from './aiUniverseData.js';

function convictionTier(weight) {
  if (weight >= 10)  return 'CORE';
  if (weight >= 5)   return 'HIGH';
  if (weight >= 2)   return 'MEDIUM';
  return 'RADAR';
}

async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('Cannot connect to MongoDB'); process.exit(1); }

  const col = db.collection('pnthr_ai_universe_constituents');
  await col.createIndex({ ticker: 1 }, { unique: true });
  await col.createIndex({ sectorId: 1 });

  const startTime = Date.now();
  console.log('\n' + '═'.repeat(70));
  console.log('  PNTHR AI Universe Constituents Build');
  console.log(`  Source:  scripts/aiUniverse/aiUniverseData.js (${FUND_META.version})`);
  console.log(`  Target:  pnthr_ai_universe_constituents`);
  console.log('═'.repeat(70));

  let upserted = 0;
  const tickerSet = new Set();

  for (const sector of SECTORS) {
    for (const h of sector.holdings) {
      if (tickerSet.has(h.ticker)) {
        console.warn(`  DUP: ${h.ticker} appears in multiple sectors — skipping later occurrence`);
        continue;
      }
      tickerSet.add(h.ticker);

      const conviction = convictionTier(sector.weight);
      await col.updateOne(
        { ticker: h.ticker },
        {
          $set: {
            ticker:        h.ticker,
            companyName:   h.name,
            sectorId:      sector.id,
            sectorName:    sector.name,
            sectorWeight:  sector.weight,
            conviction,
            thesis:        h.thesis,
            updatedAt:     new Date(),
          },
          $setOnInsert: {
            createdAt: new Date(),
          },
        },
        { upsert: true }
      );
      upserted++;
    }
  }

  const stale = await col.countDocuments({ ticker: { $nin: [...tickerSet] } });
  if (stale > 0) {
    console.log(`\n  ${stale} stale tickers no longer in basket — flagging as inactive`);
    await col.updateMany(
      { ticker: { $nin: [...tickerSet] } },
      { $set: { active: false, deactivatedAt: new Date() } }
    );
  }
  await col.updateMany(
    { ticker: { $in: [...tickerSet] } },
    { $set: { active: true } }
  );

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n' + '─'.repeat(70));
  console.log(`  Upserted:  ${upserted} active tickers across ${SECTORS.length} sectors`);
  console.log(`  Stale:     ${stale} tickers marked inactive`);
  console.log(`  Runtime:   ${elapsed}s`);
  console.log('─'.repeat(70));
  console.log('\n  Next: node scripts/aiUniverse/backfillAiUniverseDailyCandles.js\n');

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
