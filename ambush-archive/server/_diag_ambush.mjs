import dotenv from 'dotenv'; dotenv.config({ path: new URL('./.env', import.meta.url).pathname });
import { connectToDatabase } from './database.js';
const db = await connectToDatabase();
const cols = (await db.listCollections().toArray()).map(c=>c.name);
const ibkrCol = cols.find(c=>/ibkr.*pos|pos.*ibkr/i.test(c));
console.log('=== ENGINE book (pnthr_ambush_positions) ===');
const amb = await db.collection('pnthr_ambush_positions').find({}).toArray();
console.log('count:', amb.length);
for (const p of amb) console.log(`  ${p.ticker} ${p.direction} state=${p.state} shares=${p.totalShares} stop=${p.stop} nextLot=${p.nextLot} updated=${p.updatedAt?.toISOString?.().slice(5,16)}`);
console.log('\n=== Ambush config ===');
const cfg = await db.collection('pnthr_ambush_config').findOne({key:'ambush_config'});
console.log('enabled:', cfg?.enabled, '| nav:', cfg?.nav, '| lastCronRun:', cfg?.lastCronRun);
if (ibkrCol) { console.log(`\n=== IBKR truth (${ibkrCol}) ===`); const ib = await db.collection(ibkrCol).find({}).toArray(); for (const p of ib) { const sh=p.position??p.shares??p.qty; if (sh) console.log(`  ${p.ticker||p.symbol} pos=${sh} avg=${p.avgCost??p.avgPrice}`); } }
else console.log('\n(no ibkr-positions collection found; checked:', cols.filter(c=>/ibkr/i.test(c)).join(',')||'none', ')');
process.exit(0);
