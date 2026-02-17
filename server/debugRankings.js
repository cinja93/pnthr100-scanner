import { connectToDatabase } from './database.js';

async function debug() {
  const db = await connectToDatabase();
  const collection = db.collection('rankings');

  // Get Feb 14
  const feb14 = await collection.findOne({ date: '2026-02-14' });
  console.log(`Feb 14 has ${feb14?.rankings?.length} stocks`);

  // Get Feb 7
  const feb7 = await collection.findOne({ date: '2026-02-07' });
  console.log(`Feb 7 has ${feb7?.rankings?.length} stocks`);

  // Find GNRC in each
  const gnrc14 = feb14?.rankings?.findIndex(s => s.ticker === 'GNRC');
  const gnrc7 = feb7?.rankings?.findIndex(s => s.ticker === 'GNRC');
  console.log(`\nGNRC position in Feb 14: index ${gnrc14} → rank ${gnrc14 + 1}`);
  console.log(`GNRC position in Feb 7:  index ${gnrc7} → rank ${gnrc7 + 1}`);

  if (gnrc14 >= 0 && gnrc7 >= 0) {
    const expectedChange = (gnrc7 + 1) - (gnrc14 + 1);
    console.log(`Expected rankChange: ${expectedChange} (${expectedChange > 0 ? '🔺' : '🔻'})`);
  }

  // Show top 5 from each week
  console.log('\nFeb 14 top 5:');
  feb14?.rankings?.slice(0, 5).forEach((s, i) => console.log(`  ${i+1}. ${s.ticker} (${s.ytdReturn}%)`));
  console.log('\nFeb 7 top 5:');
  feb7?.rankings?.slice(0, 5).forEach((s, i) => console.log(`  ${i+1}. ${s.ticker} (${s.ytdReturn}%)`));

  process.exit(0);
}

debug();
