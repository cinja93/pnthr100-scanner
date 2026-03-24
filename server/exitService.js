// server/exitService.js
// ── PNTHR Exit Service — records partial/full exits on portfolio positions ─────
//
// Positions use a string `id` field (not MongoDB ObjectId) as primary key.
// Exits are stored in position.exits[] and mirrored to pnthr_journal.
// ─────────────────────────────────────────────────────────────────────────────
import { calculateDisciplineScore } from './journalService.js';
import { fetchMarketSnapshot } from './marketSnapshot.js';

function getFillsArray(fills) {
  if (!fills) return [];
  if (Array.isArray(fills)) return fills.filter(f => f && f.price);
  return Object.values(fills).filter(f => f && f.price && f.filled !== false);
}

function calcAvgCost(position) {
  // fills is an object keyed by lot number: { 1: { filled, price, shares }, ... }
  const fills = Object.values(position.fills || {}).filter(f => f && f.filled && f.price && f.shares);
  if (!fills.length) return position.entryPrice || 0;
  const totalCost = fills.reduce((s, f) => s + (f.price * (f.shares || 0)), 0);
  const totalShares = fills.reduce((s, f) => s + (f.shares || 0), 0);
  return totalShares > 0 ? totalCost / totalShares : position.entryPrice || 0;
}

function calcTotalFilled(position) {
  return Object.values(position.fills || {}).reduce((s, f) => s + (f && f.filled ? (f.shares || 0) : 0), 0);
}

function calcExitPnl(avgCost, exitPrice, shares, direction) {
  const diff = direction === 'SHORT' ? avgCost - exitPrice : exitPrice - avgCost;
  const dollar = diff * shares;
  const pct = avgCost > 0 ? (diff / avgCost * 100) : 0;
  return { dollar: +dollar.toFixed(2), pct: +pct.toFixed(2), perShare: +diff.toFixed(2) };
}

async function recordExit(db, positionId, userId, exitData) {
  const { shares, price, date, time, reason, note } = exitData;

  const position = await db.collection('pnthr_portfolio').findOne({
    id: positionId,
    ownerId: userId,
  });
  if (!position) throw new Error('Position not found');

  const totalFilled = calcTotalFilled(position);
  const existingExits = position.exits || [];
  const alreadyExited = existingExits.reduce((s, e) => s + (e.shares || 0), 0);
  const remaining = totalFilled - alreadyExited;

  if (shares > remaining) throw new Error(`Cannot exit ${shares} shares — only ${remaining} remaining`);

  const avgCost = calcAvgCost(position);
  const pnl = calcExitPnl(avgCost, price, shares, position.direction);
  const newRemaining = remaining - shares;
  const exitId = `E${existingExits.length + 1}`;

  // Capture market snapshot at exit time (best-effort, non-blocking for exit flow)
  const marketAtExit = await fetchMarketSnapshot(position.sector || null).catch(() => ({}));

  const exitRecord = {
    id: exitId,
    shares: Number(shares),
    price: Number(price),
    date,
    time: time || new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    reason,
    note: note || '',
    isOverride: reason === 'MANUAL',
    isFinalExit: newRemaining === 0,
    pnl,
    remainingShares: newRemaining,
    marketAtExit,
    createdAt: new Date(),
  };

  // Compute updated realized P&L
  const allExits = [...existingExits, exitRecord];
  const totalExitedShares = allExits.reduce((s, e) => s + (e.shares || 0), 0);
  const realizedDollar = allExits.reduce((s, e) => s + (e.pnl?.dollar || 0), 0);
  const avgExitPrice = totalExitedShares > 0
    ? allExits.reduce((s, e) => s + e.price * e.shares, 0) / totalExitedShares
    : 0;

  const newStatus = newRemaining === 0 ? 'CLOSED' : 'PARTIAL';

  const updateDoc = {
    $push: { exits: exitRecord },
    $set: {
      totalFilledShares: totalFilled,
      totalExitedShares,
      remainingShares: newRemaining,
      status: newStatus,
      avgExitPrice: +avgExitPrice.toFixed(4),
      'realizedPnl.dollar': +realizedDollar.toFixed(2),
      updatedAt: new Date(),
    },
  };

  // Wash rule on final loss exit
  if (newRemaining === 0 && realizedDollar < 0) {
    const finalDate = new Date(date);
    const expiryDate = new Date(finalDate);
    expiryDate.setDate(expiryDate.getDate() + 30);
    updateDoc.$set['washRule.isLoss'] = true;
    updateDoc.$set['washRule.finalExitDate'] = date;
    updateDoc.$set['washRule.expiryDate'] = expiryDate.toISOString().split('T')[0];
    updateDoc.$set.closedAt = new Date();
  } else if (newRemaining === 0) {
    updateDoc.$set.closedAt = new Date();
  }

  await db.collection('pnthr_portfolio').updateOne(
    { id: positionId, ownerId: userId },
    updateDoc
  );

  // Sync to journal (best-effort — don't fail the exit if journal sync fails)
  try {
    await syncExitToJournal(db, positionId, userId, exitRecord, newRemaining, realizedDollar, avgExitPrice, newStatus);
  } catch (e) { console.warn('[EXIT] Journal sync failed:', e.message); }

  return { exitRecord, remainingShares: newRemaining, status: newStatus };
}

async function syncExitToJournal(db, positionId, userId, exitRecord, remainingShares, realizedDollar, avgExitPrice, status) {
  const update = {
    $push: { exits: exitRecord },
    $set: {
      'performance.status': status,
      'performance.remainingShares': remainingShares,
      'performance.avgExitPrice': +avgExitPrice.toFixed(4),
      'performance.realizedPnlDollar': +realizedDollar.toFixed(2),
      updatedAt: new Date(),
    },
  };
  if (remainingShares === 0) {
    update.$set.closedAt = new Date();
  }
  await db.collection('pnthr_journal').updateOne(
    { positionId: positionId.toString(), ownerId: userId },
    update
  );

  // If exit has a note, add it to the journal notes section with type EXIT
  // so it appears in the notes feed alongside MID_TRADE notes.
  if (exitRecord.note?.trim()) {
    await db.collection('pnthr_journal').updateOne(
      { positionId: positionId.toString(), ownerId: userId },
      {
        $push: {
          notes: {
            id: `N_${exitRecord.id}_${Date.now()}`,
            timestamp: new Date().toISOString(),
            type: 'EXIT',
            text: exitRecord.note.trim(),
            marketSnapshot: exitRecord.marketAtExit || {},
          },
        },
      }
    );
  }

  // When trade is fully closed, compute the discipline score automatically.
  if (status === 'CLOSED') {
    try {
      const journal = await db.collection('pnthr_journal').findOne(
        { positionId: positionId.toString(), ownerId: userId },
        { projection: { _id: 1 } }
      );
      if (journal) {
        await calculateDisciplineScore(db, journal._id.toString());
      }
    } catch (e) { console.warn('[EXIT] Discipline score calc failed:', e.message); }
  }
}

export { recordExit, calcAvgCost, calcTotalFilled, calcExitPnl };
