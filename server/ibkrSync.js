// server/ibkrSync.js
// POST /api/ibkr/sync — IBKR TWS Bridge receiver
//
// Phase 1: Read-only IBKR position/stop sync (mirror IBKR state into PNTHR)
// Phase 2: Auto-close from fills — when an IBKR SLD/BOT execution fully exits
//          a tracked PNTHR position, write a canonical close (exits[],
//          realizedPnl.*, journal sync, discipline score, washRule).
// Phase 3: Auto-open from new positions — when IBKR holds a ticker that has
//          no matching ACTIVE PNTHR position, create one with the canonical
//          PNTHR Stop (Wilder ATR(3) ratchet + 2-week structural floor).
//
// Called every 60s by the Python bridge running on the admin's machine.
// Authenticates via JWT (req.user.userId = admin's ownerId).
// Writes ONLY to that user's data — impossible to touch another user's records.

import { connectToDatabase, upsertUserProfile } from './database.js';
import { validatePortfolioUpdate } from './portfolioGuard.js';
import { recordExit } from './exitService.js';

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
async function processExecutions(db, userId, executions, pnthrPositions, syncedAt, ibkrPositions = []) {
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

  // Live IBKR shares per ticker (signed) from the current payload. Closed
  // positions are absent from this map (bridge drops tickers with pos=0).
  // Used as the final authority on "is the position actually gone?" — guards
  // against stale partial executions triggering a belated auto-close after a
  // user edits CMD shares down to match IBKR.
  const ibkrSharesByTicker = {};
  for (const p of ibkrPositions || []) {
    if (p?.symbol) ibkrSharesByTicker[p.symbol.toUpperCase()] = Math.abs(+p.shares || 0);
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

    // Final authority: if IBKR still shows this ticker with meaningful shares,
    // the execution was a REDUCTION not an EXIT, even when the share-ratio
    // math suggests a 'full exit'. This blocks stale partial-exit executions
    // from auto-closing a position after the user aligns CMD shares downward.
    const liveIbkrShares = ibkrSharesByTicker[symbol] || 0;
    if (liveIbkrShares > 0) {
      console.log(`[IBKR] Skipping auto-close of ${symbol}: IBKR still holds ${liveIbkrShares} shares (exec was a reduction, not a full exit)`);
      continue;
    }

    // Determine exit reason: fill within 1% of stored stop → STOP_HIT
    const stop       = pnthr.stopPrice;
    const exitPrice  = exec.price;
    const exitReason = (stop != null && Math.abs(exitPrice - stop) / stop < 0.01)
      ? 'STOP_HIT'
      : 'MANUAL';

    // Canonical close — funnel through recordExit so portfolio gets the full
    // schema (exits[], realizedPnl.*, totalFilledShares/Exited/remaining,
    // washRule for losses) and journal gets the matching update + discipline
    // score. This is the SAME path Command Center uses for manual closes;
    // there is now exactly one code path for closing a position.
    const exitData = {
      shares: pnthrShares,
      price:  exitPrice,
      date:   syncedAt.toISOString().split('T')[0],
      time:   syncedAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }),
      reason: exitReason,
      note:   'Auto-closed by IBKR TWS fill detection',
    };

    let result;
    try {
      result = await recordExit(db, pnthr.id, userId, exitData);
    } catch (e) {
      console.error(`[IBKR] recordExit failed for ${symbol}: ${e.message} — execId NOT marked processed (will retry next sync)`);
      // Don't insert into pnthr_ibkr_executions on failure — leaves the exec
      // available for retry on the next sync rather than swallowing the error.
      continue;
    }

    // IBKR-specific audit fields (not part of canonical close schema)
    await db.collection('pnthr_portfolio').updateOne(
      { id: pnthr.id, ownerId: userId },
      { $set: { autoClosedByIBKR: true, ibkrExecId: exec.execId } }
    );

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
      ticker:        symbol,
      direction:     pnthr.direction,
      exitPrice,
      exitReason,
      profitPct:     result.exitRecord.pnl.pct,
      profitDollar:  result.exitRecord.pnl.dollar,
      closedAt:      syncedAt.toISOString(),
    });

    console.log(`[IBKR] ⚡ Auto-closed ${symbol} (${pnthr.direction}) @ $${exitPrice} — ${exitReason} — pnl ${result.exitRecord.pnl.pct}%`);
  }

  return autoClosed;
}

// ── processNewPositions ─────────────────────────────────────────────────────
// Phase 3: Auto-open. When IBKR holds a ticker that has no matching ACTIVE
// PNTHR position for this owner+direction, create one with the canonical
// PNTHR Stop. Mirrors to journal so the new trade is fully tracked from the
// first sync after a fill.
//
// Skip rules:
//   - Symbol = USD (cash, never tracked)
//   - Position has 0 shares
//   - PNTHR already has ACTIVE position for ticker+direction
//   - A CLOSED position for this ticker was created within the last 5 minutes
//     (avoids race where IBKR snapshot still shows the old position briefly
//     after a Phase 2 close fires)
//   - PNTHR Stop unavailable from signalService (refuse to open without a
//     stop — too risky for automated trading)
//
async function processNewPositions(db, userId, ibkrPositions, syncedAt) {
  if (!ibkrPositions?.length) return [];

  const opened = [];

  // Active PNTHR positions for this user, indexed by ticker+direction
  const activePnthr = await db.collection('pnthr_portfolio')
    .find({ ownerId: userId, status: 'ACTIVE' })
    .project({ ticker: 1, direction: 1 })
    .toArray();
  const activeKeys = new Set(activePnthr.map(p => `${p.ticker?.toUpperCase()}_${p.direction?.toUpperCase()}`));

  for (const pos of ibkrPositions) {
    if (!pos.symbol || pos.symbol === 'USD') continue;
    const shares = +pos.shares || 0;
    if (shares === 0) continue;

    const ticker    = pos.symbol.toUpperCase();
    const direction = shares > 0 ? 'LONG' : 'SHORT';
    const key       = `${ticker}_${direction}`;
    if (activeKeys.has(key)) continue; // already tracked

    // Race guard: if Phase 2 just closed a position for this ticker, IBKR
    // snapshot may still show it. Wait for the next sync.
    const recentClose = await db.collection('pnthr_portfolio').findOne({
      ownerId:  userId,
      ticker,
      direction,
      status:   'CLOSED',
      closedAt: { $gte: new Date(Date.now() - 5 * 60 * 1000) },
    });
    if (recentClose) continue;

    const absShares = Math.abs(shares);
    const entryDate = syncedAt.toISOString().split('T')[0];

    // Sector via FMP profile (best-effort, used for OpEMA period + Analyze T1-D).
    // Normalize FMP strings to PNTHR canonical so OpEMA lookup and sector gate
    // logic see the right key (e.g. "Consumer Cyclical" → "Consumer Discretionary").
    let sector = null;
    try {
      const r = await fetch(
        `https://financialmodelingprep.com/api/v3/profile/${ticker}?apikey=${process.env.FMP_API_KEY}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (r.ok) {
        const data = await r.json();
        const raw  = data?.[0]?.sector || null;
        if (raw) {
          const { normalizeSector } = await import('./sectorUtils.js');
          sector = normalizeSector(raw);
        }
      }
    } catch { /* non-fatal — getSignals will fall back to default EMA period */ }

    // Canonical PNTHR Stop from signalService (Wilder ATR(3) ratchet + 2-week
    // structural floor; signalService picks the more conservative). REFUSE to
    // open without a valid stop — automated trading must always have a defined
    // exit. Surface as untracked so user can investigate.
    let pnthrStop = null;
    let signalDir = null;
    try {
      const { getSignals } = await import('./signalService.js');
      const sigMap   = sector ? { [ticker]: sector } : {};
      const signals  = await getSignals([ticker], { sectorMap: sigMap });
      const sig      = signals[ticker] || {};
      pnthrStop      = sig.pnthrStop ?? sig.stopPrice ?? null;
      signalDir      = sig.signal || null;
    } catch (e) {
      console.warn(`[IBKR Phase 3] signal fetch failed for ${ticker}: ${e.message}`);
    }

    if (pnthrStop == null) {
      console.warn(`[IBKR Phase 3] No PNTHR Stop available for ${ticker} ${direction} — refusing to auto-open. Manual review required.`);
      continue;
    }

    // Build canonical position doc
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const positionDoc = {
      id,
      ownerId:    userId,
      ticker,
      direction,
      sector:     sector || null,
      entryDate,
      entryPrice: +(+pos.avgCost).toFixed(4),
      currentPrice: typeof pos.marketPrice === 'number' && pos.marketPrice > 0.01 && pos.marketPrice < 50000
        ? +(+pos.marketPrice).toFixed(4)
        : +(+pos.avgCost).toFixed(4),
      stopPrice:    pnthrStop,
      originalStop: pnthrStop,
      signal:       signalDir || (direction === 'LONG' ? 'BL' : 'SS'),
      // Single-shot fill: full position size enters as Lot 1. The pyramid lot
      // structure (35/25/20/12/8%) doesn't apply when IBKR fills the full size
      // in one execution — we record what actually happened.
      fills: {
        1: {
          lot: 1, name: 'The Scent', filled: true, pct: 1.0,
          shares: absShares,
          price:  +(+pos.avgCost).toFixed(4),
          date:   entryDate,
        },
      },
      exits:                  [],
      totalFilledShares:      absShares,
      totalExitedShares:      0,
      remainingShares:        absShares,
      status:                 'ACTIVE',
      autoOpenedByIBKR:       true,
      createdAt:              syncedAt,
      updatedAt:              syncedAt,
      ibkrSyncedAt:           syncedAt,
      ibkrShares:             absShares,
      ibkrAvgCost:            +pos.avgCost,
      ibkrUnrealizedPNL:      typeof pos.unrealizedPNL === 'number' ? pos.unrealizedPNL : null,
      ibkrMarketValue:        typeof pos.marketValue   === 'number' ? pos.marketValue   : null,
    };

    try {
      await db.collection('pnthr_portfolio').insertOne(positionDoc);

      // Mirror to journal so the trade card / discipline scoring works from day 1
      try {
        const { createJournalEntry } = await import('./journalService.js');
        await createJournalEntry(db, positionDoc, userId);
      } catch (e) {
        console.warn(`[IBKR Phase 3] Journal create failed for ${ticker}: ${e.message} (position already inserted; can backfill later)`);
      }

      opened.push({
        ticker, direction, shares: absShares,
        entryPrice: positionDoc.entryPrice,
        stopPrice:  pnthrStop,
        sector,
        signal:     positionDoc.signal,
      });
      console.log(`[IBKR Phase 3] ⚡ Auto-opened ${ticker} (${direction}) ${absShares}sh @ $${positionDoc.entryPrice} stop $${pnthrStop} sector=${sector || '?'}`);
    } catch (e) {
      console.error(`[IBKR Phase 3] insertOne failed for ${ticker}: ${e.message}`);
    }
  }

  return opened;
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

    // 4. Phase 2: Process executions — auto-close positions from TWS fills.
    // We pass the live IBKR positions so processExecutions can refuse to
    // close a position that IBKR still holds (guards against stale partial
    // exits triggering auto-close after the user aligns CMD shares).
    const autoClosedPositions = await processExecutions(
      db, userId, executions, pnthrPositions, syncedAt, positions
    );

    // 5. Phase 3: Auto-open new positions detected in IBKR snapshot.
    // Runs AFTER processExecutions so a sell→rebuy in the same sync cycle
    // closes the old position first, then the new buy is detected as a
    // fresh open on the next sync (the recent-close 5-minute guard
    // prevents creating a new position from a snapshot that still shows
    // the just-closed shares).
    const autoOpenedPositions = await processNewPositions(
      db, userId, positions, syncedAt
    );

    // 6. Identify IBKR positions not yet tracked in PNTHR (informational —
    // anything Phase 3 refused to auto-open, e.g. when no PNTHR Stop was
    // available — surfaces here so user can investigate.)
    const refreshedPnthr = autoOpenedPositions.length
      ? await db.collection('pnthr_portfolio').find({ ownerId: userId, status: 'ACTIVE' }).project({ ticker: 1 }).toArray()
      : pnthrPositions;
    const pnthrTickers = new Set(refreshedPnthr.map(p => p.ticker?.toUpperCase()));
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
      autoOpenedPositions,
      syncedAt:             syncedAt.toISOString(),
    });
  } catch (err) {
    console.error('[IBKR] Sync error:', err);
    res.status(500).json({ error: err.message });
  }
}
