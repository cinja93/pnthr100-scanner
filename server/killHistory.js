// server/killHistory.js
// ── PNTHR Kill Case Study — Track Record System ───────────────────────────────
//
// Tracks every stock that enters the Kill top 10. Logs entry, updates weekly,
// closes when BE/SE fires or stock becomes OVEREXTENDED.
// Data is global/shared — all users see the same track record.
//
// Collections:
//   pnthr_kill_case_studies  — one document per trade
//   pnthr_kill_track_record  — running aggregate statistics
//
// Runs in TWO places:
//   1. Friday pipeline (after scoring) — full rebuild of track record
//   2. Kill page refresh (?refresh=1) — entry + P&L update only, no rebuild
// ─────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';

function getToday() {
  return new Date().toISOString().split('T')[0];
}

// ── Main Entry Point ──────────────────────────────────────────────────────────
// allScored  — full scored array from getApexResults (already has s.killRank)
// signalData — jungleSignals map { ticker: { signal, stopPrice, ... } }
// source     — 'FRIDAY_PIPELINE' | 'INTRAWEEK_REFRESH'

export async function checkCaseStudyEntries(db, allScored, signalData, source) {
  if (!db || !allScored || allScored.length === 0) return;

  // Guard: skip if D5 rank data is missing — means scoring engine ran at <100% capacity
  // (D5 requires at least 2 weeks of PNTHR rankings to compare against)
  const hasRankData = allScored.some(s => {
    const d5 = s.scores?.d5 ?? s.scoreDetail?.d5?.score;
    return d5 != null && d5 !== 0;
  });
  if (!hasRankData) {
    console.log('[CASE STUDY] Skipping — D5 rank data missing (engine <100% capacity, need 2+ weeks of rankings)');
    return;
  }

  const today = getToday();

  // Top 10 non-overextended stocks
  const top10 = allScored
    .filter(s => s.killRank != null && s.killRank <= 10 && !s.overextended)
    .sort((a, b) => a.killRank - b.killRank)
    .slice(0, 10);

  // Fast lookup by ticker for updates
  const scoredMap = {};
  for (const s of allScored) scoredMap[s.ticker] = s;

  // ── 1. Check for new top-10 entries ────────────────────────────────────────
  for (const stock of top10) {
    // Skip if already tracking as active
    const existing = await db.collection('pnthr_kill_case_studies')
      .findOne({ ticker: stock.ticker, status: 'ACTIVE' });
    if (existing) continue;

    // 2-week cooldown after a close
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
    const recentlyClosed = await db.collection('pnthr_kill_case_studies')
      .findOne({
        ticker: stock.ticker,
        status: 'CLOSED',
        exitDate: { $gte: twoWeeksAgo.toISOString().split('T')[0] },
      });
    if (recentlyClosed) continue;

    const sig = signalData?.[stock.ticker];
    const entry = {
      id:                `${stock.ticker}-${today}`,
      ticker:            stock.ticker,
      direction:         stock.signal === 'SS' ? 'SHORT' : 'LONG',
      sector:            stock.sector || '—',
      entryDate:         today,
      entryPrice:        stock.currentPrice || 0,
      entryRank:         stock.killRank,
      entryScore:        stock.apexScore ?? 0,
      entryTier:         stock.tier,
      entryConfirmation: stock.confirmation || null,
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
      await db.collection('pnthr_kill_case_studies').insertOne(entry);
      console.log(`[CASE STUDY] New ${source}: ${stock.ticker} ${stock.signal} @ $${entry.entryPrice} (Rank #${stock.killRank})`);
    } catch (err) {
      // Duplicate id (same ticker re-entered same day) — skip
      if (err.code !== 11000) throw err;
    }
  }

  // ── 2. Update all active case studies ──────────────────────────────────────
  const activeStudies = await db.collection('pnthr_kill_case_studies')
    .find({ status: 'ACTIVE' }).toArray();

  for (const study of activeStudies) {
    const scored = scoredMap[study.ticker];
    const currentPrice = scored?.currentPrice ?? study.entryPrice;
    const isShort = study.direction === 'SHORT';

    const pnlPct = isShort
      ? ((study.entryPrice - currentPrice) / study.entryPrice) * 100
      : ((currentPrice - study.entryPrice) / study.entryPrice) * 100;

    // BE/SE exit detection
    const sig = signalData?.[study.ticker];
    const sigType = sig?.signal ?? sig?.type;
    const exitTriggered = (isShort && sigType === 'BE') ||
                          (!isShort && sigType === 'SE');

    // OVEREXTENDED: apexScore === -99
    const overextended = scored?.overextended === true;

    const snapshot = {
      date:      today,
      price:     currentPrice,
      pnlPct:    +pnlPct.toFixed(2),
      killRank:  scored?.killRank ?? null,
      killScore: scored?.apexScore ?? null,
    };

    const updates = {
      $push: { weeklySnapshots: snapshot },
      $set: {
        holdingWeeks: study.weeklySnapshots.length + 1,
        maxFavorable: +(Math.max(study.maxFavorable, pnlPct > 0 ? pnlPct : 0)).toFixed(2),
        maxAdverse:   +(Math.min(study.maxAdverse,   pnlPct < 0 ? pnlPct : 0)).toFixed(2),
      },
    };

    if (exitTriggered || overextended) {
      const pnlDollar = (pnlPct / 100) * 10000; // $10K standardized position
      updates.$set.status    = 'CLOSED';
      updates.$set.exitDate  = today;
      updates.$set.exitPrice = currentPrice;
      updates.$set.exitReason = overextended ? 'OVEREXTENDED' : (isShort ? 'BE' : 'SE');
      updates.$set.pnlPct    = +pnlPct.toFixed(2);
      updates.$set.pnlDollar = +pnlDollar.toFixed(2);
      console.log(`[CASE STUDY] Close: ${study.ticker} ${study.direction} ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% ($${pnlDollar.toFixed(0)}) — ${updates.$set.exitReason}`);
    }

    await db.collection('pnthr_kill_case_studies').updateOne(
      { id: study.id },
      updates
    );
  }

  // ── 3. Rebuild aggregate (Fridays only) ────────────────────────────────────
  if (source === 'FRIDAY_PIPELINE') {
    await rebuildTrackRecord(db, today);
  }
}

// ── Aggregate Track Record Builder ────────────────────────────────────────────

async function rebuildTrackRecord(db, asOf) {
  const allStudies = await db.collection('pnthr_kill_case_studies').find({}).toArray();
  const closed = allStudies.filter(s => s.status === 'CLOSED');
  const active = allStudies.filter(s => s.status === 'ACTIVE');

  const winners    = closed.filter(s => (s.pnlPct ?? 0) > 0);
  const losers     = closed.filter(s => (s.pnlPct ?? 0) <= 0);
  const bigWinners = closed.filter(s => (s.pnlPct ?? 0) >= 20);

  const grossWins   = winners.reduce((sum, t) => sum + (t.pnlPct ?? 0), 0);
  const grossLosses = Math.abs(losers.reduce((sum, t) => sum + (t.pnlPct ?? 0), 0));

  // By tier
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

  // By direction
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

  // By sector
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

  // By entry source
  const bySource = {};
  for (const s of closed) {
    const src = s.entrySource || 'UNKNOWN';
    if (!bySource[src]) bySource[src] = { count: 0, wins: 0, totalPnl: 0 };
    bySource[src].count++;
    if ((s.pnlPct ?? 0) > 0) bySource[src].wins++;
    bySource[src].totalPnl += (s.pnlPct ?? 0);
  }
  for (const src of Object.keys(bySource)) {
    bySource[src].winRate = +(bySource[src].wins / bySource[src].count * 100).toFixed(1);
    bySource[src].avgPnl  = +(bySource[src].totalPnl / bySource[src].count).toFixed(1);
    delete bySource[src].totalPnl;
  }

  // Monthly returns (by exit month)
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
    bySource,
    monthlyReturns,
    updatedAt: new Date(),
  };

  await db.collection('pnthr_kill_track_record').updateOne(
    { asOf },
    { $set: record },
    { upsert: true }
  );

  console.log(`[TRACK RECORD] ${record.totalTrades} trades (${record.activeTrades} active, ${record.closedTrades} closed) — WR: ${record.winRate}% | PF: ${record.profitFactor}x`);
}

// ── Index Creation ─────────────────────────────────────────────────────────────

export async function createKillHistoryIndexes() {
  try {
    const db = await connectToDatabase();
    if (!db) return;
    const col = db.collection('pnthr_kill_case_studies');
    await col.createIndex({ ticker: 1, status: 1 });
    await col.createIndex({ status: 1, entryDate: -1 });
    await col.createIndex({ id: 1 }, { unique: true });
    await db.collection('pnthr_kill_track_record').createIndex({ asOf: -1 });
    console.log('[KILL HISTORY] Indexes ensured');
  } catch (err) {
    console.warn('[KILL HISTORY] Index creation warning:', err.message);
  }
}

// ── API Handlers ───────────────────────────────────────────────────────────────

export async function killHistoryGetAll(req, res) {
  try {
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });
    const studies = await db.collection('pnthr_kill_case_studies')
      .find({})
      .sort({ entryDate: -1 })
      .toArray();
    res.json({ studies, count: studies.length });
  } catch (err) {
    console.error('[KILL HISTORY] getAll error:', err);
    res.status(500).json({ error: err.message });
  }
}

export async function killHistoryGetActive(req, res) {
  try {
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });
    const studies = await db.collection('pnthr_kill_case_studies')
      .find({ status: 'ACTIVE' })
      .sort({ entryRank: 1 })
      .toArray();
    res.json({ studies, count: studies.length });
  } catch (err) {
    console.error('[KILL HISTORY] getActive error:', err);
    res.status(500).json({ error: err.message });
  }
}

export async function killHistoryGetTrackRecord(req, res) {
  try {
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });
    const record = await db.collection('pnthr_kill_track_record')
      .findOne({}, { sort: { asOf: -1 } });
    res.json(record || {
      totalTrades: 0, activeTrades: 0, closedTrades: 0, winRate: 0,
      avgWinPct: 0, avgLossPct: 0, profitFactor: 0, bigWinnerRate: 0,
      byTier: {}, byDirection: {}, bySector: {}, bySource: {}, monthlyReturns: [],
    });
  } catch (err) {
    console.error('[KILL HISTORY] getTrackRecord error:', err);
    res.status(500).json({ error: err.message });
  }
}
