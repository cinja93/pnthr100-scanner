// server/ibkrSync.js
// POST /api/ibkr/sync — IBKR TWS Bridge receiver (Phase 2: Auto-Close from Fills)
//
// Called every 60s by the Python bridge running on the admin's machine.
// Authenticates via JWT (req.user.userId = admin's ownerId).
// Writes ONLY to that user's data — impossible to touch another user's records.

import { connectToDatabase, upsertUserProfile } from './database.js';
import { validatePortfolioUpdate } from './portfolioGuard.js';
import { syncExitToJournal } from './exitService.js';

// ── processExecutions ─────────────────────────────────────────────────────────
// Phase 2: Match TWS fills to PNTHR positions and auto-close on full exit.
// Deduplicates by execId via pnthr_ibkr_executions collection.
//
// Closing logic:
//   SLD (sold) execution + ACTIVE LONG position with matching ticker → close
//   BOT (bought) execution + ACTIVE SHORT position with matching ticker → close
//   Shares must be within 10% of PNTHR tracked shares (guards partial fills).
//
// Exit reason:
//   Fill price within 1% of stored stop → STOP_HIT
//   Otherwise → MANUAL (discretionary exit placed directly in TWS)
//
async function processExecutions(db, userId, executions, pnthrPositions, syncedAt) {
  if (!executions?.length) return [];

  // Ensure index exists (no-op if already created; runs at most once per cold start cycle)
  db.collection('pnthr_ibkr_executions')
    .createIndex({ ownerId: 1, execId: 1 }, { unique: true })
    .catch(() => {}); // fire-and-forget; unique constraint also prevents double-processing

  // Load already-processed execIds for this user
  const processedDocs = await db.collection('pnthr_ibkr_executions')
    .find({ ownerId: userId, execId: { $in: executions.map(e => e.execId) } })
    .project({ execId: 1 })
    .toArray();
  const processedIds = new Set(processedDocs.map(d => d.execId));

  // Index active PNTHR positions by TICKER+DIRECTION (compound key).
  // This prevents LONG and SHORT positions on the same ticker from colliding —
  // if a user held OLLI SHORT previously and now holds OLLI LONG, both are
  // tracked correctly. The exec.side tells us which direction is being closed:
  //   SLD (sold)   → closing a LONG position
  //   BOT (bought) → closing a SHORT position
  const positionByTickerDir = {};
  for (const p of pnthrPositions) {
    const key = `${p.ticker?.toUpperCase()}_${p.direction?.toUpperCase()}`;
    positionByTickerDir[key] = p;
  }

  const autoClosed = [];

  for (const exec of executions) {
    if (processedIds.has(exec.execId)) continue; // already handled

    const symbol     = exec.symbol?.toUpperCase();
    const closingDir = exec.side === 'SLD' ? 'LONG' : exec.side === 'BOT' ? 'SHORT' : null;
    if (!closingDir) continue; // unknown side — skip

    const pnthr = positionByTickerDir[`${symbol}_${closingDir}`];
    if (!pnthr) continue; // no matching PNTHR position for this direction

    // Count PNTHR-tracked filled shares
    const fills     = pnthr.fills || {};
    const pnthrShares = Object.values(fills)
      .reduce((s, f) => s + (f.filled ? (+f.shares || 0) : 0), 0);

    // Only auto-close when execution covers ≥ 90% of tracked shares (full exits)
    if (pnthrShares === 0 || exec.shares < pnthrShares * 0.90) continue;

    // Determine exit reason: fill within 1% of stored stop → STOP_HIT
    const stop       = pnthr.stopPrice;
    const exitReason = (stop != null && Math.abs(exec.price - stop) / stop < 0.01)
      ? 'STOP_HIT'
      : 'MANUAL';

    // Calculate outcome (same math as commandCenter.positionsClose)
    const totalCost    = Object.values(fills)
      .reduce((s, f) => s + (f.filled ? (+f.shares || 0) * (+f.price || 0) : 0), 0);
    const avgCost      = pnthrShares > 0 ? totalCost / pnthrShares : pnthr.entryPrice;
    const exitPrice    = exec.price;
    const profitPct    = closingDir === 'LONG'
      ? (exitPrice - avgCost) / avgCost * 100
      : (avgCost - exitPrice) / avgCost * 100;
    const profitDollar = closingDir === 'LONG'
      ? (exitPrice - avgCost) * pnthrShares
      : (avgCost - exitPrice) * pnthrShares;
    const holdingDays  = Math.floor((Date.now() - new Date(pnthr.createdAt).getTime()) / 86400000);

    // Close the position
    await db.collection('pnthr_portfolio').updateOne(
      { id: pnthr.id, ownerId: userId },
      {
        $set: {
          status:             'CLOSED',
          closedAt:           syncedAt,
          updatedAt:          syncedAt,
          autoClosedByIBKR:   true,
          ibkrExecId:         exec.execId,
          outcome: {
            exitPrice,
            profitPct:    +profitPct.toFixed(2),
            profitDollar: +profitDollar.toFixed(2),
            holdingDays,
            exitReason,
          },
        },
      }
    );

    // Sync exit to journal so the trade card shows CLOSED with P&L and triggers discipline score
    try {
      const exitRecord = {
        id:              'E1',
        shares:          pnthrShares,
        price:           exitPrice,
        date:            syncedAt.toISOString().split('T')[0],
        time:            syncedAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }),
        reason:          exitReason,
        note:            'Auto-closed by IBKR TWS fill detection',
        isOverride:      exitReason === 'MANUAL',
        isFinalExit:     true,
        pnl: {
          dollar:   +profitDollar.toFixed(2),
          pct:      +profitPct.toFixed(2),
          perShare: +(closingDir === 'LONG' ? exitPrice - avgCost : avgCost - exitPrice).toFixed(4),
        },
        remainingShares: 0,
        marketAtExit:    {},
        createdAt:       syncedAt,
      };
      await syncExitToJournal(db, pnthr.id, userId, exitRecord, 0, profitDollar, exitPrice, 'CLOSED', pnthr);
    } catch (e) {
      console.warn(`[IBKR] Journal sync failed for ${symbol}:`, e.message);
    }

    // Record this execId so it is never processed again
    await db.collection('pnthr_ibkr_executions').insertOne({
      ownerId:    userId,
      execId:     exec.execId,
      symbol,
      side:       exec.side,
      shares:     exec.shares,
      price:      exec.price,
      exitReason,
      processedAt: syncedAt,
    });

    autoClosed.push({
      ticker:      symbol,
      direction:   pnthr.direction,
      exitPrice,
      exitReason,
      profitPct:   +profitPct.toFixed(2),
      profitDollar: +profitDollar.toFixed(2),
      closedAt:    syncedAt.toISOString(),
    });

    console.log(`[IBKR] ⚡ Auto-closed ${symbol} (${pnthr.direction}) @ $${exitPrice} — ${exitReason}`);
  }

  return autoClosed;
}

// ── getOvernightFills ─────────────────────────────────────────────────────────
// Returns positions auto-closed by IBKR in the last 48 hours that haven't been
// manually dismissed. Used by the assistant "RECENT FILLS" section.
//
export async function getOvernightFills(userId) {
  try {
    const db = await connectToDatabase();
    if (!db) return [];
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
    return await db.collection('pnthr_portfolio')
      .find({
        ownerId:              userId,
        autoClosedByIBKR:     true,
        closedAt:             { $gte: since },
        ibkrFillDismissedAt:  { $exists: false }, // hide dismissed fills
      })
      .sort({ closedAt: -1 })
      .toArray();
  } catch {
    return [];
  }
}

// ── POST /api/ibkr/sync ───────────────────────────────────────────────────────
export async function ibkrSync(req, res) {
  try {
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });

    const userId = req.user.userId; // stamped from JWT — cannot be spoofed
    const { timestamp, accountId, account, positions, stopOrders, executions } = req.body;

    if (!account || !Array.isArray(positions)) {
      return res.status(400).json({ error: 'account and positions[] required' });
    }

    const syncedAt = timestamp ? new Date(timestamp) : new Date();

    // 1. Update user's NAV + account metadata from IBKR NetLiquidation
    if (account.netLiquidation > 0) {
      await upsertUserProfile(userId, {
        accountSize:     Math.round(account.netLiquidation),
        ibkrLastSync:    syncedAt,
        ibkrAccountId:   accountId || null,
        ibkrAccountData: account,
      });
    }

    // 2. Upsert full IBKR positions + stop orders + today's executions snapshot
    // latestExecutions stores every fill the bridge sends today — used by the
    // trades-today reconciliation endpoint and the discrepancy IBKR_ONLY suppression.
    await db.collection('pnthr_ibkr_positions').updateOne(
      { ownerId: userId },
      {
        $set: {
          ownerId:            userId,
          positions,
          stopOrders:         Array.isArray(stopOrders) ? stopOrders : [],
          stopOrdersSyncedAt: syncedAt,
          latestExecutions:   Array.isArray(executions) ? executions : [],
          latestExecSyncedAt: syncedAt,
          syncedAt,
          accountId:          accountId || null,
        },
      },
      { upsert: true }
    );

    // 3. Cross-reference: update current price + P&L on matching PNTHR positions
    //
    // SACRED FIELDS — NEVER touched here (user-edited, must survive all syncs):
    //   fills[1-5].price/shares/date/filled, stopPrice, originalStop,
    //   entryPrice, direction, signal, exits[].price/shares
    //
    // SAFE auto-update fields (written here):
    //   currentPrice, ibkrAvgCost, ibkrShares, ibkrSyncedAt,
    //   ibkrUnrealizedPNL, ibkrMarketValue
    const pnthrPositions = await db.collection('pnthr_portfolio')
      .find({ ownerId: userId, status: 'ACTIVE' })
      .toArray();

    const ibkrByTicker = {};
    for (const p of positions) {
      ibkrByTicker[p.symbol.toUpperCase()] = p;
    }

    const mismatches  = [];
    const updateOps   = pnthrPositions
      .map(pp => {
        const ibkr = ibkrByTicker[pp.ticker?.toUpperCase()];
        if (!ibkr) return null;

        // Count PNTHR-tracked filled shares
        const pnthrShares = Object.values(pp.fills || {})
          .reduce((s, f) => s + (f.filled ? (+f.shares || 0) : 0), 0);
        const ibkrShares  = Math.abs(ibkr.shares);

        if (Math.abs(ibkrShares - pnthrShares) > 0) {
          mismatches.push({
            ticker:      pp.ticker,
            pnthrShares,
            ibkrShares,
            diff:        ibkrShares - pnthrShares,
          });
        }

        // Sanity-check marketPrice: IBKR sometimes returns sentinel/garbage
        // values (e.g. 600073) when the price feed isn't ready. Only accept
        // prices that are plausible (> $0.01 and < $50,000).
        const validPrice = typeof ibkr.marketPrice === 'number'
          && ibkr.marketPrice > 0.01
          && ibkr.marketPrice < 50000;

        const $setFields = {
          ibkrShares:        ibkrShares,
          ibkrAvgCost:       ibkr.avgCost,
          ibkrUnrealizedPNL: ibkr.unrealizedPNL,
          ibkrMarketValue:   ibkr.marketValue,
          ibkrSyncedAt:      syncedAt,
        };
        if (validPrice) $setFields.currentPrice = ibkr.marketPrice;

        const updateDoc = { $set: $setFields };
        try { validatePortfolioUpdate(updateDoc, 'ibkr-sync'); }
        catch (guardErr) {
          console.error(`[IBKR] Guard blocked update for ${pp.ticker}: ${guardErr.message}`);
          return null; // skip this position rather than overwrite sacred fields
        }
        return {
          updateOne: {
            filter: { id: pp.id, ownerId: userId },
            update: updateDoc,
          },
        };
      })
      .filter(Boolean);

    if (updateOps.length) {
      await db.collection('pnthr_portfolio').bulkWrite(updateOps);
    }

    // 4. Phase 2: Process executions — auto-close positions from TWS fills
    const autoClosedPositions = await processExecutions(
      db, userId, executions, pnthrPositions, syncedAt
    );

    // 6. Identify IBKR positions not yet tracked in PNTHR (informational)
    const pnthrTickers = new Set(pnthrPositions.map(p => p.ticker?.toUpperCase()));
    const untracked    = positions
      .filter(p => p.symbol !== 'USD' && !pnthrTickers.has(p.symbol.toUpperCase()))
      .map(p => ({ symbol: p.symbol, shares: p.shares, marketValue: p.marketValue }));

    // 7. Detect stop price mismatches (IBKR live stop ≠ PNTHR stored stop)
    const ibkrStopMap = {};
    for (const order of (Array.isArray(stopOrders) ? stopOrders : [])) {
      if (order.symbol) ibkrStopMap[order.symbol.toUpperCase()] = order.stopPrice;
    }
    const stopMismatches = pnthrPositions
      .filter(pp => {
        const ibkrStop  = ibkrStopMap[pp.ticker?.toUpperCase()];
        const pnthrStop = pp.stopPrice;
        if (ibkrStop == null || pnthrStop == null) return false;
        return Math.abs(ibkrStop - pnthrStop) >= 0.01;
      })
      .map(pp => ({
        ticker:    pp.ticker,
        pnthrStop: pp.stopPrice,
        ibkrStop:  ibkrStopMap[pp.ticker?.toUpperCase()],
        diff:      +Math.abs(ibkrStopMap[pp.ticker?.toUpperCase()] - pp.stopPrice).toFixed(2),
      }));

    res.json({
      success:              true,
      nav:                  Math.round(account.netLiquidation),
      positionsSynced:      positions.length,
      pnthrUpdated:         updateOps.length,
      mismatches,
      stopMismatches,
      untracked,
      autoClosedPositions,
      syncedAt:             syncedAt.toISOString(),
    });
  } catch (err) {
    console.error('[IBKR] Sync error:', err);
    res.status(500).json({ error: err.message });
  }
}
