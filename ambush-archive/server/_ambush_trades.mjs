import dotenv from 'dotenv'; dotenv.config({ path: new URL('./.env', import.meta.url).pathname });
import { connectToDatabase } from './database.js';
const db = await connectToDatabase();
const cols = (await db.listCollections().toArray()).map(c=>c.name).filter(c=>/ambush/i.test(c));
console.log('ambush collections:'); for (const c of cols) console.log(`  ${c}: ${await db.collection(c).countDocuments()}`);
// closed positions in pnthr_ambush_positions
const closed = await db.collection('pnthr_ambush_positions').find({ status: 'CLOSED' }).toArray();
console.log(`\npnthr_ambush_positions CLOSED: ${closed.length}`);
if (closed[0]) console.log('  fields:', Object.keys(closed[0]).filter(k=>/pnl|profit|exit|direction|closed|realized|win/i.test(k)).join(','));
// look for a dedicated trade log / journal
for (const c of cols) { if(/trade|journal|history|log|closed/i.test(c)) { const s=await db.collection(c).findOne({}); if(s) console.log(`\n${c} sample fields:`, Object.keys(s).slice(0,20).join(',')); } }
process.exit(0);
