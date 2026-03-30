// server/journalService.js
// ── PNTHR Journal Service — auto-creates journal entries from portfolio positions ──
//
// Journal entries are stored in pnthr_journal, keyed by positionId (string id).
// ─────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';
import { ObjectId } from 'mongodb';
import { computeDisciplineScore } from './disciplineScoring.js';

export async function createJournalEntry(db, position, userId, killData = null, marketAtEntry = null, sectorAtEntry = null, enrichment = {}) {
  // Check if entry already exists
  const existing = await db.collection('pnthr_journal').findOne({
    positionId: position.id.toString(),
    ownerId: userId,
  });
  if (existing) return existing;

  // Fills is an object { 1: { filled, price, shares, date }, ... }
  const fills = Object.values(position.fills || {}).filter(f => f && f.filled && f.price);
  const lot1 = fills[0] || null;

  // Kill data: prefer enrichment.killScoreAtEntry, fall back to legacy killData param
  const kse = enrichment.killScoreAtEntry || null;
  const legacyKill = killData || null;

  const entry = {
    ownerId:    userId,
    positionId: position.id.toString(),
    ticker:     position.ticker,
    direction:  position.direction,
    entry: {
      signalType:    position.direction === 'LONG' ? 'BL' : 'SS',
      fillDate:      lot1?.date || null,
      fillPrice:     lot1?.price || position.entryPrice || null,
      stopPrice:     position.stopPrice || null,
      killRank:      kse?.rank       || legacyKill?.killRank   || null,
      killScore:     kse?.totalScore || legacyKill?.totalScore  || null,
      killTier:      kse?.tier       || legacyKill?.tier        || null,
      isKillTop10:   kse?.rank ? kse.rank <= 10 : (legacyKill?.killRank ? legacyKill.killRank <= 10 : false),
      marketAtEntry: enrichment.marketAtEntry || marketAtEntry || null,
      sectorAtEntry: sectorAtEntry || null,
    },
    lots: fills.map((f, i) => ({ lot: i + 1, shares: f.shares, price: f.price, date: f.date })),
    totalFilledShares: fills.reduce((s, f) => s + (f.shares || 0), 0),
    exits: position.exits || [],
    performance: {
      status: position.status || 'ACTIVE',
      remainingShares: position.remainingShares ?? fills.reduce((s, f) => s + (f.shares || 0), 0),
      avgExitPrice: position.avgExitPrice || null,
      totalPnlDollar: null,
      realizedPnlDollar: position.realizedPnl?.dollar || 0,
    },
    entryContext:        position.entryContext  || enrichment.entryContext || 'NO_SIGNAL',
    signal:              enrichment.signal      || position.signal         || null,
    signalAge:           enrichment.signalAge   ?? position.signalAge      ?? null,
    exchange:            enrichment.exchange    || position.exchange        || null,
    navAtEntry:          enrichment.navAtEntry  ?? null,
    marketAtEntry:       enrichment.marketAtEntry || marketAtEntry          || null,
    killScoreAtEntry:    kse                    || null,
    analyzeScoreAtEntry: enrichment.analyzeScoreAtEntry || null,
    userConfirmed:       enrichment.userConfirmed       || null,
    dataSource:          enrichment.dataSource  || 'UNKNOWN',
    discipline: { totalScore: null },
    whatIf: {},
    washRule: { isLoss: false, expired: true },
    notes: [],
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  console.log(`[JOURNAL] Created entry for ${position.ticker}:`,
    `Kill=${entry.killScoreAtEntry?.totalScore ?? 'NONE'}`,
    `Signal=${entry.signal ?? 'NONE'}+${entry.signalAge ?? '?'}`,
    `Context=${entry.entryContext}`,
    `SPY=${entry.marketAtEntry?.spy?.aboveEma ?? entry.marketAtEntry?.spyPosition ?? 'NONE'}`,
    `Source=${entry.dataSource}`
  );

  await db.collection('pnthr_journal').insertOne(entry);
  return entry;
}

export async function calculateDisciplineScore(db, journalId) {
  const journal = await db.collection('pnthr_journal').findOne({ _id: new ObjectId(journalId) });
  if (!journal) return;

  const result = computeDisciplineScore(journal);

  await db.collection('pnthr_journal').updateOne(
    { _id: new ObjectId(journalId) },
    { $set: { discipline: result, updatedAt: new Date() } }
  );
}
