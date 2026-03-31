// server/ibkrSync.js
// POST /api/ibkr/sync — IBKR TWS Bridge receiver (Phase 1: Read-Only)
//
// Called every 60s by the Python bridge running on the admin's machine.
// Authenticates via JWT (req.user.userId = admin's ownerId).
// Writes ONLY to that user's data — impossible to touch another user's records.

import { connectToDatabase, upsertUserProfile } from './database.js';
import { validatePortfolioUpdate } from './portfolioGuard.js';

// ── POST /api/ibkr/sync ───────────────────────────────────────────────────────
export async function ibkrSync(req, res) {
  try {
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });

    const userId = req.user.userId; // stamped from JWT — cannot be spoofed
    const { timestamp, accountId, account, positions, stopOrders } = req.body;

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

    // 2. Upsert full IBKR positions + stop orders snapshot (one doc per user)
    await db.collection('pnthr_ibkr_positions').updateOne(
      { ownerId: userId },
      {
        $set: {
          ownerId:            userId,
          positions,
          stopOrders:         Array.isArray(stopOrders) ? stopOrders : [],
          stopOrdersSyncedAt: syncedAt,
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

    // 4. Identify IBKR positions not yet tracked in PNTHR (informational)
    const pnthrTickers = new Set(pnthrPositions.map(p => p.ticker?.toUpperCase()));
    const untracked    = positions
      .filter(p => p.symbol !== 'USD' && !pnthrTickers.has(p.symbol.toUpperCase()))
      .map(p => ({ symbol: p.symbol, shares: p.shares, marketValue: p.marketValue }));

    // 5. Detect stop price mismatches (IBKR live stop ≠ PNTHR stored stop)
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
      success:         true,
      nav:             Math.round(account.netLiquidation),
      positionsSynced: positions.length,
      pnthrUpdated:    updateOps.length,
      mismatches,
      stopMismatches,
      untracked,
      syncedAt:        syncedAt.toISOString(),
    });
  } catch (err) {
    console.error('[IBKR] Sync error:', err);
    res.status(500).json({ error: err.message });
  }
}
