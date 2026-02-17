import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB_NAME || 'pnthr100';

let client = null;
let db = null;

// Connect to MongoDB
export async function connectToDatabase() {
  if (db) {
    return db;
  }

  try {
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DB_NAME);

    // Create indexes for faster queries
    await db.collection('rankings').createIndex({ date: -1 });
    await db.collection('supplemental_stocks').createIndex({ ticker: 1 }, { unique: true });

    console.log('✅ Connected to MongoDB');
    return db;
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    // Don't throw - allow app to run without MongoDB
    return null;
  }
}

// Sort by this report's YTD return (desc) and assign rank 1, 2, 3... so rank always reflects that report's data
function sortRankingsByYtdAndAssignRank(rankings) {
  if (!rankings || !Array.isArray(rankings)) return rankings;
  const sorted = [...rankings].sort((a, b) => (b.ytdReturn ?? -Infinity) - (a.ytdReturn ?? -Infinity));
  return sorted.map((stock, index) => ({ ...stock, rank: index + 1 }));
}

// Short list: lowest YTD = rank 1 (best short candidate)
function sortShortRankingsByYtdAndAssignRank(rankings) {
  if (!rankings || !Array.isArray(rankings)) return rankings;
  const sorted = [...rankings].sort((a, b) => (a.ytdReturn ?? Infinity) - (b.ytdReturn ?? Infinity));
  return sorted.map((stock, index) => ({ ...stock, rank: index + 1 }));
}

// Save ranking to database (long + optional short; rank set from YTD order before save)
export async function saveRanking(date, rankings, shortRankings = null) {
  try {
    const database = await connectToDatabase();
    if (!database) {
      console.log('⚠️  MongoDB not available, skipping save');
      return null;
    }

    const collection = database.collection('rankings');
    const normalized = sortRankingsByYtdAndAssignRank(rankings);
    const document = {
      date,
      dayOfWeek: new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' }),
      timestamp: new Date(),
      rankings: normalized
    };
    if (shortRankings && shortRankings.length > 0) {
      document.shortRankings = sortShortRankingsByYtdAndAssignRank(shortRankings);
    }

    const result = await collection.insertOne(document);
    console.log(`✅ Saved ranking for ${date} (${normalized.length} long${document.shortRankings ? `, ${document.shortRankings.length} short` : ''})`);
    return result;
  } catch (error) {
    console.error('Error saving ranking:', error.message);
    return null;
  }
}

// Get most recent ranking (rank re-derived from that report's YTD order)
export async function getMostRecentRanking() {
  try {
    const database = await connectToDatabase();
    if (!database) {
      return null;
    }

    const collection = database.collection('rankings');
    const ranking = await collection
      .find()
      .sort({ date: -1 })
      .limit(1)
      .toArray();

    if (ranking.length === 0) return null;
    const doc = ranking[0];
    doc.rankings = sortRankingsByYtdAndAssignRank(doc.rankings);
    if (doc.shortRankings) doc.shortRankings = sortShortRankingsByYtdAndAssignRank(doc.shortRankings);
    return doc;
  } catch (error) {
    console.error('Error getting most recent ranking:', error.message);
    return null;
  }
}

// Get the most recent ranking before a given date (rank re-derived from that report's YTD order)
export async function getRankingBeforeDate(date) {
  try {
    const database = await connectToDatabase();
    if (!database) return null;

    const collection = database.collection('rankings');
    const rankings = await collection
      .find({ date: { $lt: date } })
      .sort({ date: -1 })
      .limit(1)
      .toArray();

    if (rankings.length === 0) return null;
    const doc = rankings[0];
    doc.rankings = sortRankingsByYtdAndAssignRank(doc.rankings);
    if (doc.shortRankings) doc.shortRankings = sortShortRankingsByYtdAndAssignRank(doc.shortRankings);
    return doc;
  } catch (error) {
    console.error('Error getting ranking before date:', error.message);
    return null;
  }
}

// Get ranking for a specific date, with rank re-derived from YTD and rank changes vs prior week (long + short if present)
export async function getRankingByDate(date) {
  try {
    const database = await connectToDatabase();
    if (!database) return null;

    const collection = database.collection('rankings');
    const ranking = await collection.findOne({ date });
    if (!ranking) return null;

    const currentLong = sortRankingsByYtdAndAssignRank(ranking.rankings);
    const currentShort = ranking.shortRankings ? sortShortRankingsByYtdAndAssignRank(ranking.shortRankings) : null;

    const prevRankings = await collection
      .find({ date: { $lt: date } })
      .sort({ date: -1 })
      .limit(1)
      .toArray();

    if (prevRankings.length === 0) {
      return {
        ...ranking,
        rankings: currentLong.map(stock => ({ ...stock, rankChange: null, previousRank: null })),
        ...(currentShort && { shortRankings: currentShort.map(stock => ({ ...stock, rankChange: null, previousRank: null })) })
      };
    }

    const prev = prevRankings[0];
    const prevLong = sortRankingsByYtdAndAssignRank(prev.rankings);
    const prevLongMap = {};
    prevLong.forEach((stock) => { if (stock.ticker) prevLongMap[stock.ticker.toUpperCase()] = stock.rank; });

    const rankingsWithChanges = currentLong.map((stock) => {
      const previousRank = prevLongMap[(stock.ticker || '').toUpperCase()] ?? null;
      const rankChange = previousRank !== null ? previousRank - stock.rank : null;
      return { ...stock, rankChange, previousRank };
    });

    let shortRankingsWithChanges = null;
    if (currentShort && prev.shortRankings) {
      const prevShort = sortShortRankingsByYtdAndAssignRank(prev.shortRankings);
      const prevShortMap = {};
      prevShort.forEach((stock) => { if (stock.ticker) prevShortMap[stock.ticker.toUpperCase()] = stock.rank; });
      shortRankingsWithChanges = currentShort.map((stock) => {
        const previousRank = prevShortMap[(stock.ticker || '').toUpperCase()] ?? null;
        const rankChange = previousRank !== null ? previousRank - stock.rank : null;
        return { ...stock, rankChange, previousRank };
      });
    } else if (currentShort) {
      shortRankingsWithChanges = currentShort.map(stock => ({ ...stock, rankChange: null, previousRank: null }));
    }

    return {
      ...ranking,
      rankings: rankingsWithChanges,
      ...(shortRankingsWithChanges && { shortRankings: shortRankingsWithChanges })
    };
  } catch (error) {
    console.error('Error getting ranking by date:', error.message);
    return null;
  }
}

// Get all user-added supplemental stocks
export async function getSupplementalStocks() {
  try {
    const database = await connectToDatabase();
    if (!database) {
      return [];
    }

    const collection = database.collection('supplemental_stocks');
    const stocks = await collection.find().sort({ ticker: 1 }).toArray();
    return stocks.map(doc => doc.ticker);
  } catch (error) {
    console.error('Error getting supplemental stocks:', error.message);
    return [];
  }
}

// Add a supplemental stock
export async function addSupplementalStock(ticker) {
  try {
    const database = await connectToDatabase();
    if (!database) {
      throw new Error('Database not available');
    }

    const collection = database.collection('supplemental_stocks');

    // Check if ticker already exists
    const existing = await collection.findOne({ ticker });
    if (existing) {
      throw new Error(`Ticker ${ticker} already exists in supplemental list`);
    }

    const document = {
      ticker: ticker.toUpperCase(),
      addedAt: new Date()
    };

    await collection.insertOne(document);
    console.log(`✅ Added supplemental stock: ${ticker}`);
    return { success: true, ticker: ticker.toUpperCase() };
  } catch (error) {
    console.error('Error adding supplemental stock:', error.message);
    throw error;
  }
}

// Remove a supplemental stock
export async function removeSupplementalStock(ticker) {
  try {
    const database = await connectToDatabase();
    if (!database) {
      throw new Error('Database not available');
    }

    const collection = database.collection('supplemental_stocks');
    const result = await collection.deleteOne({ ticker: ticker.toUpperCase() });

    if (result.deletedCount === 0) {
      throw new Error(`Ticker ${ticker} not found in supplemental list`);
    }

    console.log(`✅ Removed supplemental stock: ${ticker}`);
    return { success: true, ticker: ticker.toUpperCase() };
  } catch (error) {
    console.error('Error removing supplemental stock:', error.message);
    throw error;
  }
}

// Get all rankings from last 12 weeks
export async function getAllRankings(limit = 12) {
  try {
    const database = await connectToDatabase();
    if (!database) {
      return [];
    }

    const collection = database.collection('rankings');
    const rankings = await collection
      .find()
      .sort({ date: -1 })
      .limit(limit)
      .project({ date: 1, dayOfWeek: 1, timestamp: 1, _id: 0 })
      .toArray();

    return rankings;
  } catch (error) {
    console.error('Error getting all rankings:', error.message);
    return [];
  }
}

// Get stock's ranking history across all saved weeks
export async function getStockHistory(ticker) {
  try {
    const database = await connectToDatabase();
    if (!database) {
      return [];
    }

    const collection = database.collection('rankings');
    const tickerUpper = ticker.toUpperCase();

    // Get all rankings sorted by date descending
    const allRankings = await collection
      .find()
      .sort({ date: -1 })
      .limit(12)
      .toArray();

    // Extract this ticker's history
    const history = allRankings.map(ranking => {
      const stockIndex = ranking.rankings.findIndex(s => s.ticker === tickerUpper);

      if (stockIndex === -1) {
        return {
          date: ranking.date,
          rank: null,
          ytdReturn: null,
          currentPrice: null,
          sector: null
        };
      }

      const stock = ranking.rankings[stockIndex];
      return {
        date: ranking.date,
        rank: stockIndex + 1,
        ytdReturn: stock.ytdReturn,
        currentPrice: stock.currentPrice,
        sector: stock.sector,
        exchange: stock.exchange
      };
    });

    return history;
  } catch (error) {
    console.error('Error getting stock history:', error.message);
    return [];
  }
}

// Delete rankings older than specified weeks
export async function cleanupOldRankings(weeksToKeep = 12) {
  try {
    const database = await connectToDatabase();
    if (!database) {
      return { deletedCount: 0 };
    }

    // Calculate cutoff date (12 weeks ago)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - (weeksToKeep * 7));
    const cutoffDateString = cutoffDate.toISOString().split('T')[0];

    const collection = database.collection('rankings');
    const result = await collection.deleteMany({ date: { $lt: cutoffDateString } });

    if (result.deletedCount > 0) {
      console.log(`🗑️  Cleaned up ${result.deletedCount} old rankings (older than ${cutoffDateString})`);
    }

    return result;
  } catch (error) {
    console.error('Error cleaning up old rankings:', error.message);
    return { deletedCount: 0 };
  }
}

// Close database connection
export async function closeDatabaseConnection() {
  if (client) {
    await client.close();
    console.log('MongoDB connection closed');
  }
}
