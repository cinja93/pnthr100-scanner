import { getMostRecentRanking, getRankingBeforeDate, saveRanking, getRankingByDate, cleanupOldRankings } from './database.js';

// US Eastern timezone for market close
const MARKET_TZ = 'America/New_York';

// True when it's Friday in Eastern (market close day)
function isFriday() {
  const weekday = new Date().toLocaleDateString('en-US', { timeZone: MARKET_TZ, weekday: 'long' });
  return weekday === 'Friday';
}

// Report date = most recent Friday in Eastern (YYYY-MM-DD). Never Saturday.
// Used so weekly reports are stored as Friday (market close), not Saturday (UTC).
function getRankingDate() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: MARKET_TZ }); // YYYY-MM-DD
  const weekday = now.toLocaleDateString('en-US', { timeZone: MARKET_TZ, weekday: 'long' });
  const daysBack = { Sunday: 2, Monday: 3, Tuesday: 4, Wednesday: 5, Thursday: 6, Friday: 0, Saturday: 1 }[weekday];
  if (daysBack === 0) return dateStr;
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - daysBack);
  return d.toISOString().split('T')[0];
}

// Compare current rankings with previous week (not same week).
// E.g. if most recent saved is Feb 14, compare to Feb 7 report.
// Returns stocks with rank change information.
export async function addRankingComparison(currentStocks) {
  try {
    const mostRecent = await getMostRecentRanking();
    if (!mostRecent) {
      console.log('📊 No previous ranking found - this is the first run');
      return currentStocks.map((stock, index) => ({
        ...stock,
        rank: index + 1,
        rankChange: null,
        previousRank: null
      }));
    }

    // Use the week before the most recent for comparison (e.g. Feb 7 when most recent is Feb 14)
    const previousRanking = await getRankingBeforeDate(mostRecent.date);
    if (!previousRanking) {
      // Need two different weeks to show rank change; otherwise we'd compare to same week and get all 0s
      console.log(`📊 Only one ranking in DB (${mostRecent.date}). Add another week's report to see Rank Change.`);
      return currentStocks.map((stock, index) => ({
        ...stock,
        rank: index + 1,
        rankChange: null,
        previousRank: null
      }));
    }

    console.log(`📊 Current week vs previous week: comparing to ${previousRanking.date} (not ${mostRecent.date})`);

    // Create a map of previous rankings: ticker (uppercase) -> rank (use index+1 if rank missing, e.g. seed data)
    const previousRankMap = new Map();
    previousRanking.rankings.forEach((stock, index) => {
      const tickerKey = (stock.ticker || '').toUpperCase();
      if (tickerKey) previousRankMap.set(tickerKey, stock.rank ?? index + 1);
    });

    // Add rank and rank change to current stocks
    let withChangeCount = 0;
    const stocksWithRankings = currentStocks.map((stock, index) => {
      const currentRank = index + 1;
      const previousRank = previousRankMap.get((stock.ticker || '').toUpperCase());

      let rankChange = null;
      if (previousRank !== undefined) {
        rankChange = previousRank - currentRank;
        withChangeCount += 1;
      }

      return {
        ...stock,
        rank: currentRank,
        rankChange,
        previousRank: previousRank ?? null
      };
    });

    console.log(`📊 Rank change: ${withChangeCount}/${currentStocks.length} stocks matched to previous week`);
    return stocksWithRankings;

  } catch (error) {
    console.error('Error in ranking comparison:', error);
    return currentStocks.map((stock, index) => ({
      ...stock,
      rank: index + 1,
      rankChange: null,
      previousRank: null
    }));
  }
}

// Same as addRankingComparison but for short list (uses previous week's shortRankings)
export async function addShortRankingComparison(bottomStocks) {
  try {
    const mostRecent = await getMostRecentRanking();
    if (!mostRecent || !mostRecent.shortRankings) {
      console.log('📊 No previous short ranking found');
      return bottomStocks.map((stock, index) => ({
        ...stock,
        rank: index + 1,
        rankChange: null,
        previousRank: null
      }));
    }

    const previousRanking = await getRankingBeforeDate(mostRecent.date);
    const prevShort = previousRanking?.shortRankings;
    if (!prevShort) {
      console.log(`📊 Only one short ranking in DB (${mostRecent.date}). Add another week to see Rank Change.`);
      return bottomStocks.map((stock, index) => ({
        ...stock,
        rank: index + 1,
        rankChange: null,
        previousRank: null
      }));
    }

    const previousRankMap = new Map();
    prevShort.forEach((stock) => {
      const tickerKey = (stock.ticker || '').toUpperCase();
      if (tickerKey) previousRankMap.set(tickerKey, stock.rank ?? null);
    });

    let withChangeCount = 0;
    const stocksWithRankings = bottomStocks.map((stock, index) => {
      const currentRank = index + 1;
      const previousRank = previousRankMap.get((stock.ticker || '').toUpperCase());
      let rankChange = null;
      if (previousRank !== undefined && previousRank !== null) {
        rankChange = previousRank - currentRank;
        withChangeCount += 1;
      }
      return {
        ...stock,
        rank: currentRank,
        rankChange,
        previousRank: previousRank ?? null
      };
    });

    console.log(`📊 Short rank change: ${withChangeCount}/${bottomStocks.length} stocks matched to previous week`);
    return stocksWithRankings;
  } catch (error) {
    console.error('Error in short ranking comparison:', error);
    return bottomStocks.map((stock, index) => ({
      ...stock,
      rank: index + 1,
      rankChange: null,
      previousRank: null
    }));
  }
}

// Auto-save long + short rankings if it's Friday (Eastern)
export async function autoSaveRankingIfFriday(longStocks, shortStocks = null) {
  try {
    if (!isFriday()) {
      console.log('⏭️  Not Friday (Eastern), skipping auto-save');
      return;
    }

    const rankingDate = getRankingDate();
    const existingRanking = await getRankingByDate(rankingDate);
    if (existingRanking) {
      console.log(`✅ Ranking already saved for ${rankingDate} (Friday)`);
      return;
    }

    console.log(`💾 Auto-saving ranking for Friday ${rankingDate}...`);
    await saveRanking(rankingDate, longStocks, shortStocks);
    await cleanupOldRankings(12);
  } catch (error) {
    console.error('Error in auto-save:', error);
  }
}
