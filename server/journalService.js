// server/journalService.js
// ── PNTHR Journal Service — auto-creates journal entries from portfolio positions ──
//
// Journal entries are stored in pnthr_journal, keyed by positionId (string id).
// ─────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';
import { ObjectId } from 'mongodb';

export async function createJournalEntry(db, position, userId, killData = null) {
  // Check if entry already exists
  const existing = await db.collection('pnthr_journal').findOne({
    positionId: position.id.toString(),
    ownerId: userId,
  });
  if (existing) return existing;

  // Fills is an object { 1: { filled, price, shares, date }, ... }
  const fills = Object.values(position.fills || {}).filter(f => f && f.filled && f.price);
  const lot1 = fills[0] || null;

  const entry = {
    ownerId: userId,
    positionId: position.id.toString(),
    ticker: position.ticker,
    direction: position.direction,
    entry: {
      signalType: position.direction === 'LONG' ? 'BL' : 'SS',
      fillDate: lot1?.date || null,
      fillPrice: lot1?.price || position.entryPrice || null,
      stopPrice: position.stopPrice || null,
      killRank: killData?.killRank || null,
      killScore: killData?.totalScore || null,
      killTier: killData?.tier || null,
      isKillTop10: killData?.killRank ? killData.killRank <= 10 : false,
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
    discipline: { totalScore: null },
    whatIf: {},
    washRule: { isLoss: false, expired: true },
    notes: [],
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await db.collection('pnthr_journal').insertOne(entry);
  return entry;
}

export async function calculateDisciplineScore(db, journalId) {
  const journal = await db.collection('pnthr_journal').findOne({ _id: new ObjectId(journalId) });
  if (!journal) return;

  const exits = journal.exits || [];
  const lots = journal.lots || [];

  // Entry score (0-30)
  let entryScore = 0;
  const entryBreakdown = {};

  entryBreakdown.confirmedSignal = journal.entry?.killRank ? 10 : 0;
  entryScore += entryBreakdown.confirmedSignal;

  entryBreakdown.entryTiming = 10; // default; could refine with signalDate
  entryScore += entryBreakdown.entryTiming;

  entryBreakdown.slippage = 3; // default moderate
  entryScore += entryBreakdown.slippage;

  entryBreakdown.sizingAdherence = 0;
  entryScore += entryBreakdown.sizingAdherence;

  // Hold score (0-30)
  let holdScore = 0;
  const holdBreakdown = {};

  holdBreakdown.heldThroughDrawdown = 10; // default
  holdScore += holdBreakdown.heldThroughDrawdown;

  holdBreakdown.pyramidingFollowed = Math.min(lots.length * 5, 10);
  holdScore += holdBreakdown.pyramidingFollowed;

  holdBreakdown.stopMaintained = 10;
  holdScore += holdBreakdown.stopMaintained;

  // Exit score (0-40)
  let exitScore = 0;
  const exitBreakdown = {};

  const signalExits = exits.filter(e => ['SIGNAL', 'FEAST', 'STALE_HUNT', 'STOP_HIT'].includes(e.reason));
  const manualExits = exits.filter(e => e.reason === 'MANUAL');
  const totalExitShares = exits.reduce((s, e) => s + e.shares, 0);
  const signalExitShares = signalExits.reduce((s, e) => s + e.shares, 0);
  const signalExitPct = totalExitShares > 0 ? signalExitShares / totalExitShares : 1;

  exitBreakdown.followedSignal = Math.round(signalExitPct * 20);
  exitScore += exitBreakdown.followedSignal;

  exitBreakdown.feastFollowed = exits.some(e => e.reason === 'FEAST') ? 10 : 0;
  exitScore += exitBreakdown.feastFollowed;

  exitBreakdown.staleHuntFollowed = exits.some(e => e.reason === 'STALE_HUNT') ? 5 : 0;

  exitBreakdown.exitSlippage = 3;
  exitScore += exitBreakdown.exitSlippage;

  exitBreakdown.overridePenalty = manualExits.length > 0 ? -(manualExits.length * 10) : 0;
  exitScore = Math.max(0, exitScore + exitBreakdown.overridePenalty);

  const totalScore = Math.min(100, Math.max(0, entryScore + holdScore + exitScore));

  const overrides = manualExits.map(e => ({
    date: e.date,
    type: 'EARLY_EXIT',
    shares: e.shares,
    note: e.note,
    vixAtOverride: e.market?.vix || null,
    regretCost: null,
  }));

  await db.collection('pnthr_journal').updateOne(
    { _id: new ObjectId(journalId) },
    {
      $set: {
        'discipline.totalScore': totalScore,
        'discipline.entryScore': entryScore,
        'discipline.entryBreakdown': entryBreakdown,
        'discipline.holdScore': holdScore,
        'discipline.holdBreakdown': holdBreakdown,
        'discipline.exitScore': exitScore,
        'discipline.exitBreakdown': exitBreakdown,
        'discipline.overrides': overrides,
        'discipline.overrideCount': overrides.length,
        updatedAt: new Date(),
      },
    }
  );
}
