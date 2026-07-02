// ONE-OFF SEED: (1) register the house hands-off PNTHR Tree PAPER book (Scott's ownerId,
// seeded at the $89,882 fund-compare baseline, treeOnly) so the 2-min cron ticks it forward;
// (2) compute + store the hypothetical hands-off reconstruction band. Idempotent.
import dotenv from 'dotenv'; dotenv.config({ path: new URL('./.env', import.meta.url).pathname });
import { MongoClient } from 'mongodb';
import { ensurePaperBook, listPaperBooks } from './treePaperBook.js';
import { refreshHandsOffBand } from './backtest/treePaperReconstruction.js';

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db(process.env.MONGODB_DB_NAME || 'pnthr100');

// House owner = the same ownerId getNav() uses (pnthr_ambush_config.ownerId), fallback to Scott's known id.
const amb = await db.collection('pnthr_ambush_config').findOne({});
const HOUSE = String(amb?.ownerId || '69c62632367d0e18498e7650');
console.log('House ownerId =', HOUSE);

// (1) register the hands-off Tree book at the baseline
await ensurePaperBook(db, HOUSE, 'PNTHR Tree — hands-off (house)', { baseCapital: 89882, treeOnly: true });
const bk = (await listPaperBooks(db)).find(b => String(b.ownerId) === HOUSE);
console.log('Registered book:', JSON.stringify({ ownerId: bk?.ownerId, label: bk?.label, baseCapital: bk?.baseCapital, treeOnly: bk?.treeOnly }));

// (2) compute + store the reconstruction band as of the last complete session (07-02)
console.log('\nComputing hands-off reconstruction band (as of 2026-07-02) ...');
const doc = await refreshHandsOffBand(db, { asOf: '2026-07-02' });
console.log('Band stored:', JSON.stringify({
  status: doc.status, start: doc.start, asOf: doc.asOf, windowDays: doc.windowDays,
  centralPct: doc.centralPct, lowPct: doc.lowPct, highPct: doc.highPct, netCentralPct: doc.netCentralPct,
}, null, 2));
console.log('variants:'); for (const v of doc.variants || []) console.log(`  ${v.label.padEnd(34)} gross ${String(v.segGross).padStart(7)}%  net ${String(v.segNet).padStart(7)}%  (live-rule: ${v.live})`);

await client.close(); process.exit(0);
