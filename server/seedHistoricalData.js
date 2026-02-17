import { connectToDatabase, saveRanking } from './database.js';

import { getTopStocks } from './stockService.js';

async function seedHistoricalData() {
  try {
    console.log('🌱 Seeding historical ranking data...\n');

    // Connect to database
    const db = await connectToDatabase();

    // Calculate last 2 Friday dates
    const today = new Date();
    const dates = [];

    // Find last Friday
    let lastFriday = new Date(today);
    lastFriday.setDate(today.getDate() - ((today.getDay() + 2) % 7));

    // Get last 2 Fridays
    for (let i = 0; i < 2; i++) {
      const friday = new Date(lastFriday);
      friday.setDate(lastFriday.getDate() - (i * 7));
      dates.push({
        date: friday.toISOString().split('T')[0],
        dayOfWeek: 'Friday'
      });
    }

    console.log('📅 Generating rankings for:');
    dates.forEach(d => console.log(`   - ${d.date} (${d.dayOfWeek})`));
    console.log('');

    // Fetch current stock data
    console.log('📊 Fetching stock data...');
    const stocks = await getTopStocks();
    console.log(`✅ Retrieved ${stocks.length} stocks\n`);

    // Delete any existing entries for these dates to avoid duplicates
    console.log('🗑️  Removing any existing entries for these dates...');
    const collection = db.collection('rankings');
    for (const { date } of dates) {
      const deleted = await collection.deleteMany({ date });
      if (deleted.deletedCount > 0) {
        console.log(`   Removed ${deleted.deletedCount} existing entry for ${date}`);
      }
    }
    console.log('');

    // Save rankings for each date
    for (let i = 0; i < dates.length; i++) {
      const { date, dayOfWeek } = dates[i];

      console.log(`💾 Saving ranking for ${date}...`);

      // Slightly vary the data for each week to simulate rank changes
      const weekStocks = stocks.map((stock, index) => {
        // Simulate small price and return variations
        const priceVariation = 1 + (Math.random() * 0.05 - 0.025) * (i + 1); // ±2.5% per week
        const returnVariation = (Math.random() * 2 - 1) * (i + 1); // ±1% per week

        return {
          ...stock,
          currentPrice: parseFloat((stock.currentPrice * priceVariation).toFixed(2)),
          ytdReturn: parseFloat((stock.ytdReturn + returnVariation).toFixed(2))
        };
      });

      // Re-sort by YTD return after variations
      weekStocks.sort((a, b) => b.ytdReturn - a.ytdReturn);

      await saveRanking(date, weekStocks);
      console.log(`   ✅ Saved ${weekStocks.length} stocks for ${date}`);
    }

    console.log('\n🎉 Historical data seeding complete!');
    console.log('\nYou can now:');
    console.log('  - Use the date picker to view past weeks');
    console.log('  - Click stock tickers to see 12-week progression');
    console.log('  - Compare rank changes week-over-week\n');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding historical data:', error);
    process.exit(1);
  }
}

seedHistoricalData();
