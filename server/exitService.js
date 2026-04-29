// server/exitService.js
// ── PNTHR Exit Service — records partial/full exits on portfolio positions ─────
//
// Positions use a string `id` field (not MongoDB ObjectId) as primary key.
// Exits are stored in position.exits[] and mirrored to pnthr_journal.
// ─────────────────────────────────────────────────────────────────────────────
import { calculateDisciplineScore } from './journalService.js';
import { fetchMarketSnapshot } from './marketSnapshot.js';
import { fetchTechnicalSnapshot } from './technicalSnapshot.js';
import { enqueue as enqueueOutbox } from './ibkrOutbox.js';

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
  const totalCostBasis = avgCost * totalFilled;
  const realizedPct = totalCostBasis > 0 ? +(realizedDollar / totalCostBasis * 100).toFixed(2) : 0;

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
      'realizedPnl.pct': realizedPct,
      updatedAt: new Date(),
    },
  };

  // Clear the Phase 4f sell-pending banner once the actual fill arrives.
  // The flag is set by /api/positions/close-via-bridge when the SELL_POSITION
  // command is enqueued; once Phase 2 sees the resulting SLD exec and lands
  // here, the position is canonically recorded and the UI hint is no longer
  // needed regardless of remaining-shares state.
  updateDoc.$unset = { sellPending: '' };

  // Wash rule on final loss exit
  if (newRemaining === 0 && realizedDollar < 0) {
    // Normalize to UTC midnight so expiry is always a clean calendar date
    const dateStr   = typeof date === 'string' ? date.split('T')[0] : new Date(date).toISOString().split('T')[0];
    const finalDate = new Date(dateStr + 'T00:00:00.000Z');
    const expiryDate = new Date(finalDate);
    expiryDate.setUTCDate(expiryDate.getUTCDate() + 30);
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
    await syncExitToJournal(db, positionId, userId, exitRecord, newRemaining, realizedDollar, realizedPct, avgExitPrice, newStatus, position);
  } catch (e) { console.warn('[EXIT] Journal sync failed:', e.message); }

  // ── Phase 4b hook: cancel-on-close ───────────────────────────────────────
  // When a position fully closes (newRemaining === 0), enqueue a
  // CANCEL_RELATED_ORDERS command so the bridge cancels any leftover GTC
  // protective stop in TWS. Both manual closes (Command Center,
  // AssistantRowExpand) and auto-closes (Phase 2 ibkrSync executions) reach
  // here, so this is the single canonical hook. Demo sentinel + dedup live
  // inside enqueueOutbox(). Gated by IBKR_AUTO_CANCEL_ON_CLOSE — when off
  // (default), this is dead code.
  if (newRemaining === 0 && process.env.IBKR_AUTO_CANCEL_ON_CLOSE === 'true') {
    try {
      const result = await enqueueOutbox(db, userId, 'CANCEL_RELATED_ORDERS', {
        ticker:     position.ticker,
        positionId: positionId,
        source:     `EXIT_${reason || 'MANUAL'}`,
      });
      if (result.skipped) {
        console.warn(`[Phase 4b] CANCEL_RELATED_ORDERS not enqueued for ${position.ticker}: ${result.skipped}`);
      } else {
        console.log(`[Phase 4b] CANCEL_RELATED_ORDERS enqueued for ${position.ticker} (id=${result.id})`);
      }
    } catch (e) {
      // Never let an outbox enqueue failure break the exit flow.
      console.warn(`[Phase 4b] enqueue threw for ${position.ticker}: ${e.message}`);
    }
  }

  return { exitRecord, remainingShares: newRemaining, status: newStatus };
}

async function syncExitToJournal(db, positionId, userId, exitRecord, remainingShares, realizedDollar, realizedPct, avgExitPrice, status, position) {
  // Guarantee a journal doc exists before applying the exit update.
  // Pre-fix this used updateOne with no upsert — when the journal doc was
  // missing (e.g., position created before journal infra existed, or
  // auto-close fired before any prior sync had created the entry) the
  // exit data was silently dropped. For an automated trading system that
  // is unacceptable, so we create-then-update.
  const existing = await db.collection('pnthr_journal').findOne(
    { positionId: positionId.toString(), ownerId: userId },
    { projection: { _id: 1 } }
  );
  if (!existing) {
    if (position) {
      try {
        const { createJournalEntry } = await import('./journalService.js');
        await createJournalEntry(db, position, userId);
      } catch (e) {
        console.error(`[EXIT] Auto-create journal failed for ${positionId}: ${e.message} — exit data NOT recorded`);
        return; // fail loud rather than silently lose data
      }
    } else {
      console.error(`[EXIT] No position object provided and no journal doc exists for ${positionId} — exit data NOT recorded`);
      return;
    }
  }

  const update = {
    $push: { exits: exitRecord },
    $set: {
      'performance.status': status,
      'performance.remainingShares': remainingShares,
      'performance.avgExitPrice': +avgExitPrice.toFixed(4),
      'performance.realizedPnlDollar': +realizedDollar.toFixed(2),
      'performance.realizedPnlPct': realizedPct,
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

  // When trade is fully closed: capture technical snapshot + compute discipline score.
  if (status === 'CLOSED') {
    // Technical snapshot at exit (best-effort, non-blocking)
    try {
      const techAtExit = await fetchTechnicalSnapshot(position?.ticker).catch(() => null);
      if (techAtExit) {
        await db.collection('pnthr_journal').updateOne(
          { positionId: positionId.toString(), ownerId: userId },
          { $set: { techAtExit } }
        );
      }
    } catch (e) { console.warn('[EXIT] Tech snapshot failed:', e.message); }

    // Discipline score
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

  // When trade closes at a loss, record 30-day wash sale window on journal entry.
  if (status === 'CLOSED' && realizedDollar < 0) {
    try {
      // Normalize to UTC midnight so expiry is always a clean calendar date
      const exitDateStr = typeof exitRecord.date === 'string' ? exitRecord.date.split('T')[0] : new Date(exitRecord.date).toISOString().split('T')[0];
      const exitDate    = new Date(exitDateStr + 'T00:00:00.000Z');
      const expiryDate  = new Date(exitDate);
      expiryDate.setUTCDate(expiryDate.getUTCDate() + 30);
      await db.collection('pnthr_journal').updateOne(
        { positionId: positionId.toString(), ownerId: userId },
        {
          $set: {
            'washSale.isLoss':          true,
            'washSale.lossAmount':      +realizedDollar.toFixed(2),
            'washSale.exitDate':        exitDate,
            'washSale.expiryDate':      expiryDate,
            'washSale.triggered':       false,
            'washSale.triggeredDate':   null,
            'washSale.triggeredEntryId': null,
            updatedAt: new Date(),
          },
        }
      );
    } catch (e) { console.warn('[EXIT] washSale journal update failed:', e.message); }
  }
}

export { recordExit, calcAvgCost, calcTotalFilled, calcExitPnl, syncExitToJournal };
