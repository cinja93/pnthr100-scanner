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
import { enqueue as enqueueOutbox, sanityCheckPlaceStop, buildStopOrderShape } from './ibkrOutbox.js';
import { recordLotFill } from './lotFillRecorder.js';

const DEFAULT_NAV = 100_000;

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

  // Load already-processed execIds for this user.
  // Exclude DRY_RUN markers — those record what *would* have happened when
  // IBKR_AUTO_RECORD_ADD_FILL was false; once the flag flips to true, the
  // execution should re-process and actually write fills[N]. The unique index
  // on (ownerId, execId) is reused: when the real record is inserted, the
  // dry-run row is updated in-place via $set rather than duplicate-keyed.
  const processedDocs = await db.collection('pnthr_ibkr_executions')
    .find({
      ownerId: userId,
      execId:  { $in: executions.map(e => e.execId) },
      type:    { $ne: 'AUTO_RECORD_LOT_FILL_DRY_RUN' },
    })
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

  // Cache user NAV once per call so the lot-plan recomputed inside
  // recordLotFill matches the rest of the server.
  let cachedNav = null;
  const getNav = async () => {
    if (cachedNav != null) return cachedNav;
    const profile = await db.collection('user_profiles').findOne({ userId });
    cachedNav = +profile?.accountSize || DEFAULT_NAV;
    return cachedNav;
  };

  const lotFillsRecorded = [];

  for (const exec of executions) {
    if (processedIds.has(exec.execId)) continue; // already handled

    const symbol = exec.symbol?.toUpperCase();

    // ── Phase 4h: auto-record pyramid lot fills ────────────────────────────
    // BOT for an ACTIVE LONG (or SLD for an ACTIVE SHORT) that already has
    // at least one filled lot is a pyramid ADD, not an exit. Route through
    // recordLotFill so PNTHR's fills[N] catches up to the TWS fill without
    // requiring the user to mark it manually (Command Center is gone).
    // Falls through to the exit branch below if recordLotFill declines
    // (e.g., side mismatches direction, or no matching plan lot).
    const addingDir = exec.side === 'BOT' ? 'LONG' : exec.side === 'SLD' ? 'SHORT' : null;
    if (addingDir) {
      const addPos = positionByTickerDir[`${symbol}_${addingDir}`];
      const addFills = addPos?.fills || {};
      const addPriorShares = Object.values(addFills)
        .reduce((s, f) => s + (f?.filled ? +f.shares || 0 : 0), 0);

      if (addPos && addPos.status !== 'CLOSED' && addPriorShares > 0) {
        const dryRun = process.env.IBKR_AUTO_RECORD_ADD_FILL !== 'true';
        const nav = await getNav();
        let lotResult;
        try {
          lotResult = await recordLotFill({
            db, ownerId: userId, position: addPos, execution: exec,
            syncedAt, nav, dryRun,
          });
        } catch (e) {
          console.error(`[Phase 4h] recordLotFill threw for ${symbol}: ${e.message} — execId NOT marked`);
          continue;
        }

        if (lotResult.recorded) {
          // Upsert so a prior DRY_RUN marker for this execId is overwritten
          // when the flag flips and the execution actually gets recorded.
          await db.collection('pnthr_ibkr_executions').updateOne(
            { ownerId: userId, execId: exec.execId },
            { $set: {
                ownerId:    userId,
                execId:     exec.execId,
                symbol,
                side:       exec.side,
                shares:     exec.shares,
                price:      exec.price,
                type:       'AUTO_RECORD_LOT_FILL',
                lot:        lotResult.lot,
                ratchetTo:  lotResult.ratchet?.newStop ?? null,
                processedAt: syncedAt,
              },
            },
            { upsert: true }
          );
          lotFillsRecorded.push({
            ticker: symbol, direction: addingDir, lot: lotResult.lot, lotName: lotResult.lotName,
            shares: lotResult.fillShares, price: lotResult.fillPrice,
            ratchet: lotResult.ratchet || null,
          });
          console.log(`[Phase 4h] ⚡ Auto-recorded ${symbol} L${lotResult.lot} (${lotResult.lotName}) — ${lotResult.fillShares}sh @ $${lotResult.fillPrice}` +
            (lotResult.ratchet ? ` — stop ratcheted to $${lotResult.ratchet.newStop} (${lotResult.ratchet.reason})` : ''));
          continue; // handled — do NOT fall through to exit branch
        }

        // Dry-run mode: log what we WOULD have done so the user can see the
        // recorder is behaving correctly before flipping the flag.
        if (lotResult.skipReason === 'DRY_RUN') {
          console.log(`[Phase 4h] (DRY) Would auto-record ${symbol} L${lotResult.lot} ${exec.shares}sh @ $${exec.price}` +
            (lotResult.ratchet ? ` + stop ratchet to $${lotResult.ratchet.newStop}` : '') +
            ' — set IBKR_AUTO_RECORD_ADD_FILL=true on Render to apply');
          // Mark as processed even in dry run so we don't keep re-logging it
          // every minute. The user can replay manually via the admin endpoint
          // once they're ready to apply. Use upsert in case a prior DRY_RUN
          // row already exists (e.g., re-running same execId snapshot).
          await db.collection('pnthr_ibkr_executions').updateOne(
            { ownerId: userId, execId: exec.execId },
            { $set: {
                ownerId:    userId,
                execId:     exec.execId,
                symbol,
                side:       exec.side,
                shares:     exec.shares,
                price:      exec.price,
                type:       'AUTO_RECORD_LOT_FILL_DRY_RUN',
                lot:        lotResult.lot,
                processedAt: syncedAt,
              },
            },
            { upsert: true }
          );
          continue;
        }

        // Other skip reasons (NO_MATCHING_LOT, LOT_ALREADY_FILLED, etc.) — fall
        // through to the exit branch only if this could plausibly be an exit
        // (BOT on SHORT or SLD on LONG). For BOT on LONG that didn't match a
        // lot, there's nothing else to do — log and skip.
        if (addingDir === 'LONG' && exec.side === 'BOT' || addingDir === 'SHORT' && exec.side === 'SLD') {
          console.log(`[Phase 4h] ${symbol} ADD not auto-recorded: ${lotResult.skipReason}` +
            (lotResult.diagnostic ? ` (price=$${exec.price} shares=${exec.shares})` : ''));
          continue;
        }
      }
    }

    const closingDir = exec.side === 'SLD' ? 'LONG' : exec.side === 'BOT' ? 'SHORT' : null;
    if (!closingDir) continue; // unknown side — skip

    const pnthr = positionByTickerDir[`${symbol}_${closingDir}`];
    if (!pnthr) continue; // no matching PNTHR position for this direction

    // Count PNTHR-tracked filled shares
    const fills     = pnthr.fills || {};
    const pnthrShares = Object.values(fills)
      .reduce((s, f) => s + (f.filled ? (+f.shares || 0) : 0), 0);

    // ── Phase 4d: auto-record partial exits ────────────────────────────────
    // When the exec is a true partial (< 90% of filled), the FULL-EXIT branch
    // below skips it. Pre-4d behavior left the exec for the manual sync flow
    // (trades-today PARTIAL row → /api/ibkr/sync-partial). With the flag on,
    // we instead funnel it through recordExit so PNTHR's exits[]/realizedPnl/
    // journal stay in sync without the user having to click anything.
    //
    // Re-fetches the position before recording so multi-partial-exec batches
    // (rare, but possible if IBKR splits a fill into pieces) see the cumulative
    // state accurately rather than stale pre-batch values.
    if (pnthrShares > 0
        && exec.shares < pnthrShares * 0.90
        && process.env.IBKR_AUTO_RECORD_PARTIAL_SELL === 'true') {
      const latest = await db.collection('pnthr_portfolio').findOne({ id: pnthr.id, ownerId: userId });
      if (!latest || latest.status === 'CLOSED') continue;

      const latestFilled = Object.values(latest.fills || {})
        .reduce((s, f) => s + (f?.filled ? +f.shares || 0 : 0), 0);
      const latestExited = (latest.exits || []).reduce((s, e) => s + (+e.shares || 0), 0);
      const latestRemaining = latestFilled - latestExited;

      if (latestRemaining <= 0) continue; // already fully exited by an earlier exec
      if (exec.shares > latestRemaining) {
        console.warn(`[Phase 4d] Skipping ${symbol}: exec ${exec.shares}sh > remaining ${latestRemaining}sh (likely double-counted)`);
        continue;
      }

      const stopP = latest.stopPrice;
      const partialReason = (stopP != null && Math.abs(exec.price - stopP) / stopP < 0.01)
        ? 'STOP_HIT'
        : 'MANUAL';

      const partialData = {
        shares: exec.shares,
        price:  exec.price,
        date:   syncedAt.toISOString().split('T')[0],
        time:   syncedAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }),
        reason: partialReason,
        note:   'Auto-recorded partial exit by IBKR TWS fill detection',
      };

      let pResult;
      try {
        pResult = await recordExit(db, latest.id, userId, partialData);
      } catch (e) {
        console.error(`[Phase 4d] recordExit failed for ${symbol}: ${e.message} — execId NOT marked (will retry)`);
        continue;
      }

      await db.collection('pnthr_ibkr_executions').insertOne({
        ownerId:    userId,
        execId:     exec.execId,
        symbol,
        side:       exec.side,
        shares:     exec.shares,
        price:      exec.price,
        exitReason: partialReason,
        type:       'PARTIAL_AUTO',
        processedAt: syncedAt,
      });

      console.log(`[Phase 4d] ⚡ Auto-recorded partial ${symbol} (${pnthr.direction}) ${exec.shares}sh @ $${exec.price} — ${partialReason} — remaining ${pResult.remainingShares}sh`);
      continue; // do NOT fall through to full-exit branch
    }

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

  return { autoClosed, lotFillsRecorded };
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
async function processNewPositions(db, userId, ibkrPositions, syncedAt, ibkrStopOrders = []) {
  if (!ibkrPositions?.length) return [];

  const opened = [];

  // Active OR partial PNTHR positions, indexed by ticker+direction. PARTIAL
  // positions still hold real shares — only fully-CLOSED ones drop out. Pre-fix
  // this filtered to status='ACTIVE' alone, which meant after a partial sale
  // (DTCR yesterday → 102 → 51) the next IBKR sync would see 51 IBKR shares,
  // not find DTCR in activeKeys, and auto-create a duplicate ACTIVE doc.
  const activePnthr = await db.collection('pnthr_portfolio')
    .find({ ownerId: userId, status: { $in: ['ACTIVE', 'PARTIAL'] } })
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

    // Stop-side validation. signalService returns the stop computed for the
    // CURRENT signal direction in the cache (BL or SS). If the IBKR fill is
    // the OPPOSITE direction (e.g. user bought CMG long while signal cache
    // has CMG as SS), the returned stop sits on the WRONG side of price for
    // the actual position — a LONG with a stop above price, or SHORT with
    // stop below. Refusing to auto-open in that case is safer than creating
    // a position that would naked-fail the 4a sanity check OR (worse) place
    // a stop that triggers immediately.
    //
    // Caught by sanityCheckPlaceStop downstream too, but rejecting at Phase 3
    // means we don't even create the orphan PNTHR doc that has to be manually
    // closed afterward. Surfaces in trades-today as UNTRACKED — user reviews.
    const lastPrice = typeof pos.marketPrice === 'number' && pos.marketPrice > 0.01 && pos.marketPrice < 50000
      ? +pos.marketPrice
      : +pos.avgCost;
    const stopOnRightSide = direction === 'LONG'
      ? +pnthrStop < lastPrice
      : +pnthrStop > lastPrice;
    // Track whether the stop came from the signal cache or from a TWS fallback —
    // affects journal/audit trail. Default: signal cache.
    let stopSourceTwsFallback = false;
    if (!stopOnRightSide) {
      // Signal-direction mismatch: user traded against the signal (e.g., bought
      // long while signalCache had this ticker as SS). The signal-derived stop
      // sits on the wrong side of price. Before refusing to auto-open, check
      // TWS for a user-placed protective stop on the correct side. If found,
      // use that as the position's stopPrice — preserves automation when the
      // user has already defined their own exit.
      const expectedAction = direction === 'LONG' ? 'SELL' : 'BUY';
      const fallbackStops = (ibkrStopOrders || []).filter(s => {
        if (s.symbol?.toUpperCase() !== ticker) return false;
        if (s.action !== expectedAction) return false;
        if (s.orderType !== 'STP' && s.orderType !== 'STP LMT') return false;
        const sp = +s.stopPrice;
        if (!Number.isFinite(sp) || sp <= 0) return false;
        return direction === 'LONG' ? sp < lastPrice : sp > lastPrice;
      });
      // Tightest wins (highest for LONG, lowest for SHORT) when multiple exist.
      const fallback = fallbackStops.length === 0 ? null
        : fallbackStops.reduce((best, s) =>
            (direction === 'LONG' ? +s.stopPrice > +best.stopPrice : +s.stopPrice < +best.stopPrice)
              ? s : best
          );
      if (fallback) {
        const fallbackPrice = +fallback.stopPrice;
        console.log(`[IBKR Phase 3] ${ticker} ${direction} signal-direction conflict — using user's TWS protective stop $${fallbackPrice} as fallback (signal-derived $${pnthrStop} was on wrong side of price $${lastPrice}).`);
        pnthrStop = fallbackPrice;
        stopSourceTwsFallback = true;
      } else {
        console.warn(`[IBKR Phase 3] Stop-side mismatch for ${ticker} ${direction}: pnthrStop=$${pnthrStop} vs price=$${lastPrice} (signalCache direction=${signalDir || 'unknown'}) and no user TWS fallback stop. Refusing to auto-open — manual review.`);
        continue;
      }
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
      stopSourceTwsFallback:  stopSourceTwsFallback || undefined,
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

      // ── Phase 4a hook: place OR adopt the protective stop ────────────────
      // Pre-fix this always enqueued PLACE_STOP, which created a duplicate
      // when the trader had already placed their own stop in TWS before the
      // 60-second sync caught the position. The duplicate is messy: when
      // price drops, the tighter stop fires first, the position closes, and
      // the looser stop is then naked.
      //
      // Mirror Phase 4c (stopRatchetCron) silent-adoption pattern:
      //   • If TWS already has a protective STP/STP LMT for this ticker on
      //     the right side (SELL for LONG, BUY for SHORT) → ADOPT it. Set
      //     the position's stopPrice to the trader's value, log the adoption
      //     in stopHistory, never enqueue a duplicate.
      //   • Otherwise → enqueue PLACE_STOP as before.
      //
      // Future stop ratchet ticks (every minute) keep tightest-wins running
      // either way, so the trader's manual stop is preserved unless PNTHR's
      // canonical stop later ratchets tighter via weekly ATR.
      const expectedAction = direction === 'LONG' ? 'SELL' : 'BUY';
      // Filter to protective stops only:
      //   • Right ticker, right side, STP/STP LMT type
      //   • For LONG: stopPrice MUST be BELOW lastPrice (a SELL STP above price
      //     is a lot trigger, not a protective stop — adopting it as the
      //     position stop would set the protective floor above current price
      //     and trigger immediately).
      //   • For SHORT: stopPrice MUST be ABOVE lastPrice (mirror reasoning).
      const refPrice = +positionDoc.currentPrice || +pos.avgCost;
      const protectiveStops = (ibkrStopOrders || []).filter(s => {
        if (s.symbol?.toUpperCase() !== ticker) return false;
        if (s.action !== expectedAction) return false;
        if (s.orderType !== 'STP' && s.orderType !== 'STP LMT') return false;
        const sp = +s.stopPrice;
        if (!Number.isFinite(sp) || sp <= 0) return false;
        return direction === 'LONG' ? sp < refPrice : sp > refPrice;
      });
      // Pick the TIGHTEST protective stop (highest for LONG, lowest for SHORT)
      // when multiple exist. Tightest-wins is the universal rule.
      const existingStop = protectiveStops.length === 0 ? null
        : protectiveStops.reduce((best, s) =>
            (direction === 'LONG' ? +s.stopPrice > +best.stopPrice : +s.stopPrice < +best.stopPrice)
              ? s : best
          );

      if (existingStop && Number.isFinite(+existingStop.stopPrice) && +existingStop.stopPrice > 0) {
        // ADOPT the trader's manual stop. Update PNTHR's stopPrice to match
        // and log the adoption so the journal can show where it came from.
        const adoptedStop = +existingStop.stopPrice;
        await db.collection('pnthr_portfolio').updateOne(
          { id: positionDoc.id, ownerId: userId },
          {
            $set:  { stopPrice: adoptedStop, updatedAt: new Date() },
            $push: { stopHistory: {
              date:       new Date().toISOString().slice(0, 10),
              stop:       adoptedStop,
              reason:     'USER_PLACED_AT_OPEN',
              from:       pnthrStop,
              ibkrPermId: existingStop.permId,
              source:     'PHASE_3_AUTO_OPEN',
            } },
          }
        );
        console.log(`[Phase 4a] Adopted user-placed TWS stop for ${ticker}: $${adoptedStop} (PNTHR canonical was $${pnthrStop}). No duplicate placed.`);
      } else if (process.env.IBKR_AUTO_PLACE_STOP === 'true') {
        const sanity = sanityCheckPlaceStop({
          position:     positionDoc,
          ibkrPosition: { shares: absShares, lastPrice: positionDoc.currentPrice, avgCost: pos.avgCost },
          stopPrice:    pnthrStop,
        });
        const shape = buildStopOrderShape({
          stopPrice:           pnthrStop,
          direction,
          stopExtendedHours:   !!positionDoc.stopExtendedHours,
        });
        const result = await enqueueOutbox(db, userId, 'PLACE_STOP', {
          ticker,
          direction,
          shares:    absShares,
          stopPrice: pnthrStop,
          orderType: shape.orderType,
          lmtPrice:  shape.lmtPrice,
          tif:       'GTC',
          rth:       shape.rth,
          positionId: positionDoc.id,
          source:    'PHASE_3_AUTO_OPEN',
        }, { sanityCheck: sanity });
        if (result.skipped) {
          console.warn(`[Phase 4a] PLACE_STOP not enqueued for ${ticker}: ${result.skipped}`);
        } else {
          console.log(`[Phase 4a] PLACE_STOP enqueued for ${ticker} (id=${result.id})`);
        }
      }
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
    //
    // Dedup stop orders by permId before storing. Defensive: TWS occasionally
    // delivers the same openOrder() event twice (transient state, reconnects,
    // multiple subscription paths) which would otherwise show as duplicate
    // IBKR_RATCHET rows in the live table and an inflated "N STOPS" badge.
    // permId is the permanent unique identifier per order in the IB account
    // lifecycle — there is no legitimate reason to store the same permId twice.
    const dedupedStopOrders = (() => {
      if (!Array.isArray(stopOrders)) return [];
      const seen = new Map();
      for (const o of stopOrders) {
        const key = o?.permId ? `p:${o.permId}` : `o:${o?.orderId ?? ''}:${o?.symbol ?? ''}:${o?.stopPrice ?? ''}:${o?.shares ?? ''}`;
        if (!seen.has(key)) seen.set(key, o);
      }
      return Array.from(seen.values());
    })();

    await db.collection('pnthr_ibkr_positions').updateOne(
      { ownerId: userId },
      {
        $set: {
          ownerId:            userId,
          positions,
          stopOrders:         dedupedStopOrders,
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
    // Include PARTIAL alongside ACTIVE — PARTIAL positions still hold real
    // shares, still need IBKR field updates (avgCost / marketPrice / shares),
    // still feed Phase 2's auto-close lookup table (positionByTickerDir), and
    // still need to be in the activeKeys set Phase 3 uses to avoid duplicate
    // doc creation. Note: Phase 2's 90%-of-filled rule only triggers
    // auto-close on full exits relative to the ORIGINAL fill count — partial-
    // exit auto-recording is the deliberate scope of Phase 4d
    // (IBKR_AUTO_RECORD_PARTIAL_SELL, Day 6 enable).
    const pnthrPositions = await db.collection('pnthr_portfolio')
      .find({ ownerId: userId, status: { $in: ['ACTIVE', 'PARTIAL'] } })
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
    const execResult = await processExecutions(
      db, userId, executions, pnthrPositions, syncedAt, positions
    );
    const autoClosedPositions = execResult.autoClosed || [];
    const lotFillsRecorded    = execResult.lotFillsRecorded || [];

    // 5. Phase 3: Auto-open new positions detected in IBKR snapshot.
    // Runs AFTER processExecutions so a sell→rebuy in the same sync cycle
    // closes the old position first, then the new buy is detected as a
    // fresh open on the next sync (the recent-close 5-minute guard
    // prevents creating a new position from a snapshot that still shows
    // the just-closed shares).
    const autoOpenedPositions = await processNewPositions(
      db, userId, positions, syncedAt, stopOrders
    );

    // 6. Identify IBKR positions not yet tracked in PNTHR (informational —
    // anything Phase 3 refused to auto-open, e.g. when no PNTHR Stop was
    // available — surfaces here so user can investigate.)
    const refreshedPnthr = autoOpenedPositions.length
      ? await db.collection('pnthr_portfolio').find({ ownerId: userId, status: { $in: ['ACTIVE', 'PARTIAL'] } }).project({ ticker: 1 }).toArray()
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
      lotFillsRecorded,
      syncedAt:             syncedAt.toISOString(),
    });
  } catch (err) {
    console.error('[IBKR] Sync error:', err);
    res.status(500).json({ error: err.message });
  }
}
