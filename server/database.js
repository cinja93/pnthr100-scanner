import { MongoClient, ObjectId } from 'mongodb';
import dotenv from 'dotenv';

// Safely construct an ObjectId; throws a clear error if the id is not a valid 24-char hex string.
function safeObjectId(id) {
  if (!id || !/^[a-f\d]{24}$/i.test(String(id))) {
    throw new Error('Invalid user ID format');
  }
  return new ObjectId(id);
}

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

    // Users + profiles
    await db.collection('users').createIndex({ email: 1 }, { unique: true });
    await db.collection('user_profiles').createIndex({ userId: 1 }, { unique: true });

    // Per-user watchlist: drop old global unique index, create per-user compound index
    try { await db.collection('watchlist').dropIndex('ticker_1'); } catch { /* may not exist */ }
    await db.collection('watchlist').createIndex({ userId: 1, ticker: 1 }, { unique: true });

    // Signal history archive: weekly snapshots of all 679 stock signals
    await db.collection('signal_history').createIndex({ ticker: 1, weekOf: -1 });
    await db.collection('signal_history').createIndex({ weekOf: -1, signal: 1 });
    await db.collection('signal_history').createIndex(
      { ticker: 1, weekOf: 1 }, { unique: true }
    );

    // Per-user portfolio: non-unique index for fast lookups by ticker+owner+status
    // Duplicate prevention handled in application code (findOne guard + try/catch on insert)
    await db.collection('pnthr_portfolio').createIndex(
      { ticker: 1, ownerId: 1, status: 1 }
    );

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

    const currentLong  = sortRankingsByYtdAndAssignRank(doc.rankings);
    const currentShort = doc.shortRankings ? sortShortRankingsByYtdAndAssignRank(doc.shortRankings) : null;

    // Fetch the previous ranking to compute rankChange (same logic as getRankingByDate)
    const prevDocs = await collection
      .find({ date: { $lt: doc.date } })
      .sort({ date: -1 })
      .limit(1)
      .toArray();

    if (prevDocs.length === 0) {
      doc.rankings      = currentLong.map(s  => ({ ...s,  rankChange: null, previousRank: null }));
      doc.shortRankings = currentShort ? currentShort.map(s => ({ ...s, rankChange: null, previousRank: null })) : undefined;
      return doc;
    }

    const prev      = prevDocs[0];
    const prevLong  = sortRankingsByYtdAndAssignRank(prev.rankings);
    const prevLongMap = {};
    prevLong.forEach(s => { if (s.ticker) prevLongMap[s.ticker.toUpperCase()] = s.rank; });

    doc.rankings = currentLong.map(s => {
      const previousRank = prevLongMap[(s.ticker || '').toUpperCase()] ?? null;
      return { ...s, rankChange: previousRank !== null ? previousRank - s.rank : null, previousRank };
    });

    if (currentShort && prev.shortRankings) {
      const prevShort = sortShortRankingsByYtdAndAssignRank(prev.shortRankings);
      const prevShortMap = {};
      prevShort.forEach(s => { if (s.ticker) prevShortMap[s.ticker.toUpperCase()] = s.rank; });
      doc.shortRankings = currentShort.map(s => {
        const previousRank = prevShortMap[(s.ticker || '').toUpperCase()] ?? null;
        return { ...s, rankChange: previousRank !== null ? previousRank - s.rank : null, previousRank };
      });
    } else if (currentShort) {
      doc.shortRankings = currentShort.map(s => ({ ...s, rankChange: null, previousRank: null }));
    }

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

// ── Watchlist (per-user) ──

export async function getWatchlistTickers(userId) {
  try {
    const database = await connectToDatabase();
    if (!database) return [];
    const collection = database.collection('watchlist');
    const uid = /^[a-f\d]{24}$/i.test(String(userId)) ? new ObjectId(userId) : String(userId);
    const docs = await collection.find({ userId: uid }).sort({ addedAt: 1 }).toArray();
    return docs.map(doc => doc.ticker);
  } catch (error) {
    console.error('Error getting watchlist:', error.message);
    return [];
  }
}

export async function addToWatchlist(ticker, userId) {
  try {
    const database = await connectToDatabase();
    if (!database) throw new Error('Database not available');
    const collection = database.collection('watchlist');
    const uid = /^[a-f\d]{24}$/i.test(String(userId)) ? new ObjectId(userId) : String(userId);
    const upper = ticker.toUpperCase();
    const existing = await collection.findOne({ userId: uid, ticker: upper });
    if (existing) throw new Error(`${upper} is already on your watchlist`);
    await collection.insertOne({ userId: uid, ticker: upper, addedAt: new Date() });
    console.log(`✅ Added to watchlist: ${upper}`);
    return { success: true, ticker: upper };
  } catch (error) {
    console.error('Error adding to watchlist:', error.message);
    throw error;
  }
}

export async function removeFromWatchlist(ticker, userId) {
  try {
    const database = await connectToDatabase();
    if (!database) throw new Error('Database not available');
    const collection = database.collection('watchlist');
    const uid = /^[a-f\d]{24}$/i.test(String(userId)) ? new ObjectId(userId) : String(userId);
    const upper = ticker.toUpperCase();
    const result = await collection.deleteOne({ userId: uid, ticker: upper });
    if (result.deletedCount === 0) throw new Error(`${upper} not found in watchlist`);
    console.log(`✅ Removed from watchlist: ${upper}`);
    return { success: true, ticker: upper };
  } catch (error) {
    console.error('Error removing from watchlist:', error.message);
    throw error;
  }
}

// ── Users ──

export async function createUser(email, hashedPassword, { name = '', status = 'active' } = {}) {
  const database = await connectToDatabase();
  if (!database) throw new Error('Database not available');
  const collection = database.collection('users');
  const lower = email.toLowerCase().trim();
  const existing = await collection.findOne({ email: lower });
  if (existing) throw new Error('An account with that email already exists');
  const result = await collection.insertOne({
    email: lower, hashedPassword, name, role: 'member', status, createdAt: new Date(),
  });
  return { _id: result.insertedId, email: lower, name, role: 'member', status };
}

export async function approveUser(userId) {
  const database = await connectToDatabase();
  if (!database) throw new Error('Database not available');
  const uid = safeObjectId(userId);
  await database.collection('users').updateOne(
    { _id: uid },
    { $set: { status: 'active', approvedAt: new Date() } }
  );
  // Create user_profiles entry with $100K default NAV if not already present
  await upsertUserProfile(userId, { accountSize: 100000 });
}

export async function denyUser(userId) {
  const database = await connectToDatabase();
  if (!database) throw new Error('Database not available');
  const uid = safeObjectId(userId);
  await database.collection('users').updateOne(
    { _id: uid },
    { $set: { status: 'denied', deniedAt: new Date() } }
  );
}

export async function findUserByEmail(email) {
  const database = await connectToDatabase();
  if (!database) return null;
  return database.collection('users').findOne({ email: email.toLowerCase().trim() });
}

// ── User Profiles ──

export async function getUserProfile(userId) {
  const database = await connectToDatabase();
  if (!database) return null;
  // Support both ObjectId user IDs and plain string IDs (e.g. 'demo_fund')
  const uid = /^[a-f\d]{24}$/i.test(String(userId)) ? new ObjectId(userId) : String(userId);
  return database.collection('user_profiles').findOne({ userId: uid });
}

export async function upsertUserProfile(userId, updates) {
  const database = await connectToDatabase();
  if (!database) throw new Error('Database not available');
  const uid = /^[a-f\d]{24}$/i.test(String(userId)) ? new ObjectId(userId) : String(userId);
  const now = new Date();
  const result = await database.collection('user_profiles').findOneAndUpdate(
    { userId: uid },
    { $set: { ...updates, updatedAt: now }, $setOnInsert: { userId: uid, createdAt: now } },
    { upsert: true, returnDocument: 'after' }
  );
  return result;
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

// ── Mobile app integration (READ-ONLY from stt-production-db) ──
// This never writes, updates, or deletes anything in the mobile app's database.

let sttDb = null;

async function connectToSttDatabase() {
  if (sttDb) return sttDb;
  try {
    if (!client) await connectToDatabase(); // ensure client is connected
    if (!client) return null;
    sttDb = client.db('stt-production-db');
    console.log('✅ Connected to stt-production-db (read-only)');
    return sttDb;
  } catch (error) {
    console.error('❌ stt-production-db connection error:', error.message);
    return null;
  }
}

// Get the first signal of the most recent direction-change run for each ticker.
// "Direction" = BUY family (BUY, YELLOW_BUY) vs SELL family (SELL, YELLOW_SELL).
// Example: NEW_BUY (3w ago) → CAUTION_BUY (2w ago) → returns NEW_BUY (first of the buy run).
//          If it then changed to SELL (1w ago) → returns SELL (first of the new sell run).
export async function getLatestSignals(tickers) {
  try {
    const database = await connectToSttDatabase();
    if (!database) return {};

    const collection = database.collection('laser_signals');
    const upperTickers = tickers.map(t => t.toUpperCase());

    // Limit to last 2 years to keep array sizes manageable; sort ASC to walk direction changes
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

    const results = await collection.aggregate([
      { $match: { symbol: { $in: upperTickers }, timestamp: { $gte: twoYearsAgo } } },
      { $sort: { timestamp: 1 } },
      { $group: {
        _id: '$symbol',
        signals: { $push: {
          signal: '$signal',
          price: '$price',
          timestamp: '$timestamp',
          isNewSignal: '$isNewSignal',
          profitPercentage: '$profitPercentage',
        }},
      }},
    ]).toArray();

    function getDir(signal) { return signal.includes('SELL') ? 'S' : 'B'; }

    const signalMap = {};
    for (const doc of results) {
      const sigs = doc.signals; // ascending by timestamp
      if (sigs.length === 0) continue;

      // Walk forward tracking direction changes; record the start of each new run.
      // At the end, runStart holds the first signal of the most recent direction run.
      let runStart = sigs[0];
      let runDir = getDir(sigs[0].signal);
      for (let i = 1; i < sigs.length; i++) {
        const dir = getDir(sigs[i].signal);
        if (dir !== runDir) {
          runStart = sigs[i];
          runDir = dir;
        }
      }

      signalMap[doc._id] = {
        signal: runStart.signal,
        price: runStart.price,
        timestamp: runStart.timestamp,
        isNewSignal: runStart.isNewSignal ?? false,
        profitPercentage: runStart.profitPercentage,
      };
    }

    console.log(`📡 Fetched direction-change signals for ${Object.keys(signalMap).length}/${tickers.length} tickers`);
    return signalMap;
  } catch (error) {
    console.error('Error fetching laser signals:', error.message);
    return {};
  }
}

// Get the first date each ticker appeared in the long or short top-100 list.
// Returns { AAPL: { date: '2025-01-10', list: 'LONG' }, TSLA: { date: '2024-11-22', list: 'SHORT' }, ... }
// Note: rankings history is kept for 12 weeks; stocks present longer will show the oldest available date.
export async function getListEntryDates(tickers) {
  try {
    const database = await connectToDatabase();
    if (!database) return {};

    const upperTickers = tickers.map(t => t.toUpperCase());
    const collection = database.collection('rankings');

    // Fetch all ranking docs sorted oldest-first; project only the ticker arrays to keep it light
    const allDocs = await collection.find(
      { $or: [
        { 'rankings.ticker': { $in: upperTickers } },
        { 'shortRankings.ticker': { $in: upperTickers } },
      ]},
      { projection: { date: 1, 'rankings.ticker': 1, 'shortRankings.ticker': 1 } }
    ).sort({ date: 1 }).toArray();

    const entryMap = {};
    const remaining = new Set(upperTickers);

    for (const doc of allDocs) {
      if (remaining.size === 0) break;
      for (const ticker of [...remaining]) {
        const inLong  = doc.rankings?.some(r => r.ticker === ticker);
        const inShort = !inLong && doc.shortRankings?.some(r => r.ticker === ticker);
        if (inLong)  { entryMap[ticker] = { date: doc.date, list: 'LONG'  }; remaining.delete(ticker); }
        else if (inShort) { entryMap[ticker] = { date: doc.date, list: 'SHORT' }; remaining.delete(ticker); }
      }
    }

    return entryMap;
  } catch (error) {
    console.error('Error fetching list entry dates:', error.message);
    return {};
  }
}

// Close database connection
export async function closeDatabaseConnection() {
  if (client) {
    await client.close();
    console.log('MongoDB connection closed');
  }
}
