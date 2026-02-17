import { connectToDatabase } from './database.js';

async function cleanup() {
  const db = await connectToDatabase();
  if (!db) {
    console.error('Could not connect to database');
    process.exit(1);
  }

  const collection = db.collection('rankings');

  // Show all current dates before cleanup
  const all = await collection.find().project({ date: 1, dayOfWeek: 1, _id: 0 }).sort({ date: 1 }).toArray();
  console.log('Current entries in database:');
  all.forEach(r => console.log(`  ${r.date} (${r.dayOfWeek})`));

  // Delete any entries that are NOT Friday
  const result = await collection.deleteMany({ dayOfWeek: { $ne: 'Friday' } });
  console.log(`\nDeleted ${result.deletedCount} non-Friday entries`);

  // Show remaining
  const remaining = await collection.find().project({ date: 1, dayOfWeek: 1, _id: 0 }).sort({ date: 1 }).toArray();
  console.log('\nRemaining entries:');
  remaining.forEach(r => console.log(`  ${r.date} (${r.dayOfWeek})`));

  process.exit(0);
}

cleanup();
