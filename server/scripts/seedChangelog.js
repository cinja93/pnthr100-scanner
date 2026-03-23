import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db('pnthr_den');

// Create indexes
await db.collection('pnthr_system_changelog').createIndex({ date: -1 });
await db.collection('pnthr_weekly_market_snapshot').createIndex({ weekOf: 1 }, { unique: true });
await db.collection('pnthr_enriched_signals').createIndex({ weekOf: 1, ticker: 1 }, { unique: true });
await db.collection('pnthr_enriched_signals').createIndex({ weekOf: 1, killRank: 1 });
await db.collection('pnthr_enriched_signals').createIndex({ ticker: 1, weekOf: 1 });
await db.collection('pnthr_closed_trades').createIndex({ ticker: 1, entryDate: 1 }, { unique: true });
await db.collection('pnthr_closed_trades').createIndex({ exitDate: 1 });
await db.collection('pnthr_closed_trades').createIndex({ entryTier: 1 });
await db.collection('pnthr_closed_trades').createIndex({ direction: 1 });
await db.collection('pnthr_closed_trades').createIndex({ sector: 1 });
await db.collection('pnthr_closed_trades').createIndex({ isWinner: 1 });
await db.collection('pnthr_dimension_effectiveness').createIndex({ monthOf: 1 }, { unique: true });

console.log('Indexes created');

const entries = [
  { date: "2026-03-16", version: "v3.0.0", category: "SCORING", impact: "HIGH", description: "Kill v3 scoring engine deployed. 8 dimensions, 7883-trade validation.", changedBy: "Scott", details: "" },
  { date: "2026-03-17", version: "v3.1.0", category: "SCORING", impact: "HIGH", description: "Overextension filter added. Bell curve Sub-C. >20% close separation = disqualified.", changedBy: "Scott", details: "" },
  { date: "2026-03-19", version: "v3.1.0", category: "RISK", impact: "HIGH", description: "Command Center launched. Tier A pyramiding 15-30-25-20-10.", changedBy: "Scott", details: "" },
  { date: "2026-03-20", version: "v3.2.0", category: "RISK", impact: "MEDIUM", description: "Heat cap changed from slot-based to actual dollar risk. Stock 10%, ETF 5%, Total 15%.", changedBy: "Scott", details: "" },
  { date: "2026-03-20", version: "v3.2.0", category: "RISK", impact: "LOW", description: "ETFs exempted from sector concentration limits. 5% risk cap is their guardrail.", changedBy: "Scott", details: "" },
  { date: "2026-03-22", version: "v3.2.0", category: "BUG_FIX", impact: "HIGH", description: "D5/D7 rank change fix. getMostRecentRanking now computes deltas. Migrated 7 weeks historical rankings.", changedBy: "Scott", details: "Kill engine now running at 8/8 dimensions." },
  { date: "2026-03-22", version: "v3.2.0", category: "DATA", impact: "MEDIUM", description: "Kill case studies reset to correct top 10 after D5/D7 fix reshuffled rankings.", changedBy: "Scott", details: "" },
  { date: "2026-03-22", version: "v3.2.0", category: "UI", impact: "LOW", description: "Scoring Engine Health diagnostic panel added. 8-dimension status with green/yellow/red indicators.", changedBy: "Sonnet", details: "" },
];

for (const e of entries) {
  await db.collection('pnthr_system_changelog').insertOne({ ...e, createdAt: new Date() });
}
console.log(`Seeded ${entries.length} changelog entries`);
await client.close();
