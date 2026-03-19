// server/ibkrSync.js
// POST /api/ibkr/sync — IBKR TWS Bridge receiver (Phase 1: Read-Only)
//
// Called every 60s by the Python bridge running on the admin's machine.
// Authenticates via JWT (req.user.userId = admin's ownerId).
// Writes ONLY to that user's data — impossible to touch another user's records.

import { connectToDatabase } from './database.js';

// ── POST /api/ibkr/sync ───────────────────────────────────────────────────────
export async function ibkrSync(req, res) {
  try {
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });

    const userId = req.user.userId; // stamped from JWT — cannot be spoofed
    const { timestamp, accountId, account, positions } = req.body;

    if (!account || !Array.isArray(positions)) {
      return res.status(400).json({ error: 'account and positions[] required' });
    }

    const syncedAt = timestamp ? new Date(timestamp) : new Date();

    // 1. Update user's NAV + account metadata from IBKR NetLiquidation
    if (account.netLiquidation > 0) {
      await db.collection('user_profiles').updateOne(
        { userId },
        {
          $set: {
            accountSize:     Math.round(account.netLiquidation),
            ibkrLastSync:    syncedAt,
            ibkrAccountId:   accountId || null,
            ibkrAccountData: account,
          },
        },
        { upsert: true }
      );
    }

    // 2. Upsert full IBKR positions snapshot (one doc per user)
    await db.collection('pnthr_ibkr_positions').updateOne(
      { ownerId: userId },
      {
        $set: {
          ownerId:   userId,
          positions,
          syncedAt,
          accountId: accountId || null,
        },
      },
      { upsert: true }
    );

    // 3. Cross-reference: update current price + P&L on matching PNTHR positions
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

        return {
          updateOne: {
            filter: { id: pp.id, ownerId: userId },
            update: { $set: $setFields },
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

    res.json({
      success:         true,
      nav:             Math.round(account.netLiquidation),
      positionsSynced: positions.length,
      pnthrUpdated:    updateOps.length,
      mismatches,
      untracked,
      syncedAt:        syncedAt.toISOString(),
    });
  } catch (err) {
    console.error('[IBKR] Sync error:', err);
    res.status(500).json({ error: err.message });
  }
}
