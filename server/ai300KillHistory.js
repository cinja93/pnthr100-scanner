// server/ai300KillHistory.js
// ── PNTHR AI 300 Kill Case Study — Track Record System ──────────────────────
//
// Mirrors killHistory.js but for the AI 300 universe.
// Consumes AI Kill scores from pnthr_ai_kill_scores (via aiKillService.js).
// Tracks top-10 AI Kill ranked stocks as case studies.
//
// Collections:
//   pnthr_ai300_kill_case_studies  — one document per trade
//   pnthr_ai300_kill_track_record  — running aggregate statistics
//
// Key differences from 679 Kill:
//   - No D5 guard (AI Kill v1 has D5=0)
//   - No OVEREXTENDED exit (AI Kill doesn't compute closeSepPct)
//   - Tier names use AI prefix (e.g. "ALPHA AI KILL")
//   - Signal data from getAiUniverseSignals() instead of jungle signals

import { connectToDatabase } from './database.js';

function getToday() {
  return new Date().toISOString().split('T')[0];
}

// aiKillScores — scores array from getLatestAiKillScores().scores
// aiSignalData — map { ticker: { signal, stopPrice, ... } } from getAiUniverseSignals()
// source — 'DAILY_PIPELINE' | 'MANUAL'
export async function checkAi300CaseStudyEntries(db, aiKillScores, aiSignalData, source) {
  if (!db || !aiKillScores || aiKillScores.length === 0) return;

  const today = getToday();

  const top10 = aiKillScores
    .filter(s => s.killRank != null && s.killRank <= 10)
    .sort((a, b) => a.killRank - b.killRank)
    .slice(0, 10);

  const scoredMap = {};
  for (const s of aiKillScores) scoredMap[s.ticker] = s;

  // 1. New top-10 entries
  for (const stock of top10) {
    const existing = await db.collection('pnthr_ai300_kill_case_studies')
      .findOne({ ticker: stock.ticker, status: 'ACTIVE' });
    if (existing) continue;

    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
    const recentlyClosed = await db.collection('pnthr_ai300_kill_case_studies')
      .findOne({
        ticker: stock.ticker,
        status: 'CLOSED',
        exitDate: { $gte: twoWeeksAgo.toISOString().split('T')[0] },
      });
    if (recentlyClosed) continue;

    const sig = aiSignalData?.[stock.ticker];
    const entry = {
      id:                `ai300-${stock.ticker}-${today}`,
      ticker:            stock.ticker,
      direction:         stock.direction === 'SHORT' ? 'SHORT' : 'LONG',
      sector:            stock.sectorName || '—',
      entryDate:         today,
      entryPrice:        stock.currentPrice || 0,
      entryRank:         stock.killRank,
      entryScore:        stock.total ?? 0,
      entryTier:         stock.tierName,
      entryD3:           stock.scores?.d3 ?? 0,
      entrySource:       source,
      stopPrice:         sig?.stopPrice ?? stock.stopPrice ?? null,
      status:            'ACTIVE',
      exitDate:          null,
      exitPrice:         null,
      exitReason:        null,
      pnlPct:            null,
      pnlDollar:         null,
      holdingWeeks:      0,
      maxFavorable:      0,
      maxAdverse:        0,
      weeklySnapshots:   [],
      createdAt:         new Date(),
    };

    try {
      await db.collection('pnthr_ai300_kill_case_studies').insertOne(entry);
      console.log(`[AI300 CASE STUDY] New ${source}: ${stock.ticker} ${stock.direction} @ $${entry.entryPrice} (Rank #${stock.killRank})`);
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
  }

  // 2. Update all active case studies
  const activeStudies = await db.collection('pnthr_ai300_kill_case_studies')
    .find({ status: 'ACTIVE' }).toArray();

  for (const study of activeStudies) {
    const scored = scoredMap[study.ticker];
    const currentPrice = scored?.currentPrice ?? study.entryPrice;
    const isShort = study.direction === 'SHORT';

    const pnlPct = isShort
      ? ((study.entryPrice - currentPrice) / study.entryPrice) * 100
      : ((currentPrice - study.entryPrice) / study.entryPrice) * 100;

    // BE/SE exit detection from AI Universe signals
    const sig = aiSignalData?.[study.ticker];
    const sigType = sig?.signal ?? sig?.type;
    const exitTriggered = (isShort && sigType === 'BE') ||
                          (!isShort && sigType === 'SE');

    const snapshot = {
      date:      today,
      price:     currentPrice,
      pnlPct:    +pnlPct.toFixed(2),
      killRank:  scored?.killRank ?? null,
      killScore: scored?.total ?? null,
    };

    const updates = {
      $push: { weeklySnapshots: snapshot },
      $set: {
        holdingWeeks: study.weeklySnapshots.length + 1,
        maxFavorable: +(Math.max(study.maxFavorable, pnlPct > 0 ? pnlPct : 0)).toFixed(2),
        maxAdverse:   +(Math.min(study.maxAdverse,   pnlPct < 0 ? pnlPct : 0)).toFixed(2),
      },
    };

    if (exitTriggered) {
      const pnlDollar = (pnlPct / 100) * 10000;
      updates.$set.status    = 'CLOSED';
      updates.$set.exitDate  = today;
      updates.$set.exitPrice = currentPrice;
      updates.$set.exitReason = isShort ? 'BE' : 'SE';
      updates.$set.pnlPct    = +pnlPct.toFixed(2);
      updates.$set.pnlDollar = +pnlDollar.toFixed(2);
      console.log(`[AI300 CASE STUDY] Close: ${study.ticker} ${study.direction} ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% ($${pnlDollar.toFixed(0)}) — ${updates.$set.exitReason}`);
    }

    await db.collection('pnthr_ai300_kill_case_studies').updateOne(
      { id: study.id },
      updates
    );
  }

  // 3. Rebuild aggregate (daily — AI Kill runs daily not just Fridays)
  await rebuildAi300TrackRecord(db, today);
}

async function rebuildAi300TrackRecord(db, asOf) {
  const allStudies = await db.collection('pnthr_ai300_kill_case_studies').find({}).toArray();
  const closed = allStudies.filter(s => s.status === 'CLOSED');
  const active = allStudies.filter(s => s.status === 'ACTIVE');

  const winners    = closed.filter(s => (s.pnlPct ?? 0) > 0);
  const losers     = closed.filter(s => (s.pnlPct ?? 0) <= 0);
  const bigWinners = closed.filter(s => (s.pnlPct ?? 0) >= 20);

  const grossWins   = winners.reduce((sum, t) => sum + (t.pnlPct ?? 0), 0);
  const grossLosses = Math.abs(losers.reduce((sum, t) => sum + (t.pnlPct ?? 0), 0));

  const byTier = {};
  for (const s of closed) {
    const t = s.entryTier || 'UNKNOWN';
    if (!byTier[t]) byTier[t] = { count: 0, wins: 0, totalPnl: 0 };
    byTier[t].count++;
    if ((s.pnlPct ?? 0) > 0) byTier[t].wins++;
    byTier[t].totalPnl += (s.pnlPct ?? 0);
  }
  for (const tier of Object.keys(byTier)) {
    byTier[tier].winRate = +(byTier[tier].wins / byTier[tier].count * 100).toFixed(1);
    byTier[tier].avgPnl  = +(byTier[tier].totalPnl / byTier[tier].count).toFixed(1);
    delete byTier[tier].totalPnl;
  }

  const byDirection = {};
  for (const dir of ['SHORT', 'LONG']) {
    const dt = closed.filter(s => s.direction === dir);
    const dw = dt.filter(s => (s.pnlPct ?? 0) > 0);
    byDirection[dir] = {
      count:   dt.length,
      winRate: dt.length > 0 ? +(dw.length / dt.length * 100).toFixed(1) : 0,
      avgPnl:  dt.length > 0 ? +(dt.reduce((sum, t) => sum + (t.pnlPct ?? 0), 0) / dt.length).toFixed(1) : 0,
    };
  }

  const bySector = {};
  for (const s of closed) {
    const sec = s.sector || 'Unknown';
    if (!bySector[sec]) bySector[sec] = { count: 0, wins: 0, totalPnl: 0 };
    bySector[sec].count++;
    if ((s.pnlPct ?? 0) > 0) bySector[sec].wins++;
    bySector[sec].totalPnl += (s.pnlPct ?? 0);
  }
  for (const sec of Object.keys(bySector)) {
    bySector[sec].winRate = +(bySector[sec].wins / bySector[sec].count * 100).toFixed(1);
    bySector[sec].avgPnl  = +(bySector[sec].totalPnl / bySector[sec].count).toFixed(1);
    delete bySector[sec].totalPnl;
  }

  const byMonth = {};
  for (const s of closed) {
    const month = s.exitDate?.substring(0, 7);
    if (!month) continue;
    if (!byMonth[month]) byMonth[month] = { trades: 0, totalPnl: 0 };
    byMonth[month].trades++;
    byMonth[month].totalPnl += (s.pnlPct ?? 0);
  }
  const monthlyReturns = Object.entries(byMonth)
    .map(([month, data]) => ({
      month,
      trades: data.trades,
      avgPnl: +(data.totalPnl / data.trades).toFixed(1),
      totalPnl: +data.totalPnl.toFixed(1),
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const record = {
    asOf,
    totalTrades:      allStudies.length,
    activeTrades:     active.length,
    closedTrades:     closed.length,
    winRate:          closed.length > 0 ? +(winners.length / closed.length * 100).toFixed(1) : 0,
    avgWinPct:        winners.length > 0 ? +(grossWins  / winners.length).toFixed(1) : 0,
    avgLossPct:       losers.length  > 0 ? +(-grossLosses / losers.length).toFixed(1) : 0,
    avgHoldingWeeks:  closed.length  > 0
      ? +(closed.reduce((sum, t) => sum + (t.holdingWeeks || 0), 0) / closed.length).toFixed(1)
      : 0,
    profitFactor:     grossLosses > 0
      ? +(grossWins / grossLosses).toFixed(2)
      : (grossWins > 0 ? 999 : 0),
    bigWinnerRate:    closed.length > 0 ? +(bigWinners.length / closed.length * 100).toFixed(1) : 0,
    byTier,
    byDirection,
    bySector,
    monthlyReturns,
    updatedAt: new Date(),
  };

  await db.collection('pnthr_ai300_kill_track_record').updateOne(
    { asOf },
    { $set: record },
    { upsert: true }
  );

  console.log(`[AI300 TRACK RECORD] ${record.totalTrades} trades (${record.activeTrades} active, ${record.closedTrades} closed) — WR: ${record.winRate}% | PF: ${record.profitFactor}x`);
}

// Index creation
export async function createAi300KillHistoryIndexes() {
  try {
    const db = await connectToDatabase();
    if (!db) return;
    const col = db.collection('pnthr_ai300_kill_case_studies');
    await col.createIndex({ ticker: 1, status: 1 });
    await col.createIndex({ status: 1, entryDate: -1 });
    await col.createIndex({ id: 1 }, { unique: true });
    await db.collection('pnthr_ai300_kill_track_record').createIndex({ asOf: -1 });
    console.log('[AI300 KILL HISTORY] Indexes ensured');
  } catch (err) {
    console.warn('[AI300 KILL HISTORY] Index creation warning:', err.message);
  }
}

// API Handlers
export async function ai300KillHistoryGetAll(req, res) {
  try {
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });
    const studies = await db.collection('pnthr_ai300_kill_case_studies')
      .find({})
      .sort({ entryDate: -1 })
      .toArray();
    res.json({ studies, count: studies.length });
  } catch (err) {
    console.error('[AI300 KILL HISTORY] getAll error:', err);
    res.status(500).json({ error: err.message });
  }
}

export async function ai300KillHistoryGetActive(req, res) {
  try {
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });
    const studies = await db.collection('pnthr_ai300_kill_case_studies')
      .find({ status: 'ACTIVE' })
      .sort({ entryRank: 1 })
      .toArray();
    res.json({ studies, count: studies.length });
  } catch (err) {
    console.error('[AI300 KILL HISTORY] getActive error:', err);
    res.status(500).json({ error: err.message });
  }
}

export async function ai300KillHistoryGetTrackRecord(req, res) {
  try {
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });
    const record = await db.collection('pnthr_ai300_kill_track_record')
      .findOne({}, { sort: { asOf: -1 } });
    res.json(record || {
      totalTrades: 0, activeTrades: 0, closedTrades: 0, winRate: 0,
      avgWinPct: 0, avgLossPct: 0, profitFactor: 0, bigWinnerRate: 0,
      byTier: {}, byDirection: {}, bySector: {}, monthlyReturns: [],
    });
  } catch (err) {
    console.error('[AI300 KILL HISTORY] getTrackRecord error:', err);
    res.status(500).json({ error: err.message });
  }
}

// Kill Test appearances creation (called from cron after AI Kill scoring)
export async function updateAi300KillAppearances(db, aiKillDoc, aiSignalData, settings) {
  if (!aiKillDoc?.scores?.length) return;

  const threshold = settings?.killThreshold ?? 130;
  const maxRank   = settings?.maxRank ?? 5;
  const today = getToday();
  const col = db.collection('pnthr_ai300_kill_appearances');

  const qualifying = aiKillDoc.scores.filter(s => s.total >= threshold && s.signal && s.killRank <= maxRank);

  let created = 0, updated = 0;
  for (const stock of qualifying) {
    const sig = aiSignalData?.[stock.ticker];
    const existing = await col.findOne({ ticker: stock.ticker, signal: stock.signal, exitDate: null });

    if (existing) {
      await col.updateOne({ _id: existing._id }, {
        $set: {
          lastSeenDate:  today,
          lastSeenPrice: stock.currentPrice,
          lastKillScore: stock.total,
          lastKillRank:  stock.killRank,
          updatedAt:     new Date(),
        },
      });
      updated++;
    } else {
      // 8-week cooldown
      const eightWeeksAgo = new Date();
      eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56);
      const recentExit = await col.findOne({
        ticker: stock.ticker,
        signal: stock.signal,
        exitDate: { $gte: eightWeeksAgo.toISOString().split('T')[0] },
      });
      if (recentExit) continue;

      const stopPrice = sig?.stopPrice ?? stock.stopPrice ?? null;
      const entryPrice = stock.currentPrice;
      if (!entryPrice || !stopPrice) continue;

      const riskPct = Math.abs((entryPrice - stopPrice) / entryPrice * 100);

      const { serverSizePosition, buildServerLotConfig } = await import('./killTestSettings.js');
      const sized = serverSizePosition({
        nav: settings?.nav ?? 100000,
        entryPrice,
        stopPrice,
        riskPct: settings?.riskPctPerTrade ?? 1,
      });

      const lotConfig = sized ? {
        nav: settings?.nav ?? 100000,
        riskPct: settings?.riskPctPerTrade ?? 1,
        totalShares: sized.totalShares,
        maxRiskDollar: sized.maxRiskDollar,
        lots: buildServerLotConfig(sized.totalShares, entryPrice, stock.signal),
      } : null;

      await col.insertOne({
        ticker:               stock.ticker,
        signal:               stock.signal,
        sector:               stock.sectorName || '—',
        exchange:             stock.exchange || null,
        firstAppearanceDate:  today,
        firstAppearancePrice: entryPrice,
        firstStopPrice:       stopPrice,
        firstRiskPct:         +riskPct.toFixed(2),
        firstKillScore:       stock.total,
        firstKillRank:        stock.killRank,
        firstTier:            stock.tierName,
        lotConfig,
        lotFills: {
          lot1: { filled: true,  fillDate: today, fillPrice: entryPrice },
          lot2: { filled: false, fillDate: null, fillPrice: null },
          lot3: { filled: false, fillDate: null, fillPrice: null },
          lot4: { filled: false, fillDate: null, fillPrice: null },
          lot5: { filled: false, fillDate: null, fillPrice: null },
        },
        currentStop:       stopPrice,
        currentAvgCost:    entryPrice,
        currentShares:     sized?.totalShares ? Math.max(1, Math.round(sized.totalShares * 0.35)) : 0,
        lotsFilledCount:   1,
        lastSeenDate:      today,
        lastSeenPrice:     entryPrice,
        lastKillScore:     stock.total,
        lastKillRank:      stock.killRank,
        currentPnlPct:     0,
        currentPnlDollar:  0,
        exitDate:          null,
        exitPrice:         null,
        exitReason:        null,
        profitPct:         null,
        profitDollar:      null,
        isWinner:          null,
        holdingWeeks:      null,
        dailySnapshots:    [],
        createdAt:         new Date(),
        updatedAt:         new Date(),
      });
      created++;
    }
  }

  if (created || updated) {
    console.log(`[AI300 Kill Appearances] ${created} new, ${updated} updated (threshold: ${threshold})`);
  }
}
