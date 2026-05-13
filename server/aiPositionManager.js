// server/aiPositionManager.js
// ── PNTHR AI 300 — Position Management (APEX v6) ──────────────────────────
//
// Three rules matching the APEX v6 backtest:
//
//   1. Weekly stop ratchet — once per new weekly bar, tighten the stop using
//      max(current, max(2-week-low - $0.01, prev_close - ATR)) for BL.
//
//   2. Weekly structural exit (BE/SE) — if current week's low < 2-week-low
//      (BL) or high > 2-week-high (SS), exit at stop price.
//
//   3. 20-day stale hunt — if position open ≥ 20 trading days AND underwater,
//      close at market. Full positions only (scouts use their own 28-day timeout).
//
// Called by cron in index.js:
//   - runAiWeeklyRatchet()   → Friday 4:30 PM ET (after bars settle)
//   - runAiStaleHuntCheck()  → Daily 4:30 PM ET
// ──────────────────────────────────────────────────────────────────────────────

import { connectToDatabase, getUserProfile } from './database.js';
import { enqueue as enqueueOutbox, buildStopOrderShape } from './ibkrOutbox.js';
import { computeWilderATR } from './signalDetection.js';
import { getStrategyMode, isCarnivoreMode } from './data/strategyMode.js';

const COLL_PORTFOLIO = 'pnthr_portfolio';
const STALE_HUNT_DAYS = 20;

async function resolveOwner(db) {
  const adminEmail = (process.env.ADMIN_EMAILS || '').split(',')[0]?.trim();
  if (!adminEmail) return null;
  const user = await db.collection('user_profiles').findOne({ email: adminEmail });
  return user?.userId || null;
}

function tradingDaysSince(dateStr) {
  if (!dateStr) return 0;
  const start = new Date(dateStr);
  const now = new Date();
  let count = 0;
  const d = new Date(start);
  d.setDate(d.getDate() + 1);
  while (d <= now) {
    const dow = d.getDay();
    if (dow >= 1 && dow <= 5) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

function computeWeeklyStopCandidate(weeklyBars, atrArr, weekIdx, signal, currentStop) {
  if (weekIdx < 3 || !atrArr[weekIdx - 1]) return currentStop;
  const prev1 = weeklyBars[weekIdx - 1];
  const prev2 = weeklyBars[weekIdx - 2];
  const twoWeekHigh = Math.max(prev1.high, prev2.high);
  const twoWeekLow  = Math.min(prev1.low, prev2.low);
  const prevAtr = atrArr[weekIdx - 1];
  if (signal === 'BL') {
    const struct = parseFloat((twoWeekLow - 0.01).toFixed(2));
    const atrFloor = parseFloat((prev1.close - prevAtr).toFixed(2));
    return parseFloat(Math.max(currentStop, Math.max(struct, atrFloor)).toFixed(2));
  } else {
    const struct = parseFloat((twoWeekHigh + 0.01).toFixed(2));
    const atrCeil = parseFloat((prev1.close + prevAtr).toFixed(2));
    return parseFloat(Math.min(currentStop, Math.min(struct, atrCeil)).toFixed(2));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Weekly Stop Ratchet + 2. Structural Exit (combined — both run on new week)
// ═══════════════════════════════════════════════════════════════════════════════
export async function runAiWeeklyRatchet() {
  const db = await connectToDatabase();
  if (!db) return { error: 'NO_DB' };
  const ownerId = await resolveOwner(db);
  if (!ownerId) return { error: 'NO_OWNER' };

  const dryRun = process.env.AI_AUTO_EXECUTE_DRY_RUN !== 'false';
  const positions = await db.collection(COLL_PORTFOLIO).find({
    ownerId,
    status: { $in: ['ACTIVE', 'PARTIAL'] },
    autoExecuteMode: { $in: ['WEEKLY', 'CONVERTED'] },
  }).toArray();

  if (!positions.length) return { ratcheted: 0, structuralExits: 0, positions: 0 };

  const tickers = [...new Set(positions.map(p => p.ticker))];
  const weeklyDocs = await db.collection('pnthr_ai_bt_candles_weekly')
    .find({ ticker: { $in: tickers } }, { projection: { ticker: 1, weekly: 1 } }).toArray();
  const weeklyByTicker = Object.fromEntries(weeklyDocs.map(d => [d.ticker, d.weekly || []]));

  const results = { ratcheted: 0, structuralExits: 0, positions: positions.length, details: [], dryRun };

  for (const pos of positions) {
    const signal = pos.signal || (pos.direction === 'LONG' ? 'BL' : 'SS');
    const wRaw = weeklyByTicker[pos.ticker] || [];
    if (wRaw.length < 10) continue;

    const wAsc = [...wRaw].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
    const wBars = wAsc.map(b => ({ high: b.high, low: b.low, close: b.close }));
    const atrArr = computeWilderATR(wBars);
    const weekIdx = wAsc.length - 1;

    if (weekIdx < 3 || !atrArr[weekIdx - 1]) continue;

    // Structural exit check first (backtest checks this before stop ratchet matters)
    const prev1 = wAsc[weekIdx - 1];
    const prev2 = wAsc[weekIdx - 2];
    const twoWeekHigh = Math.max(prev1.high, prev2.high);
    const twoWeekLow  = Math.min(prev1.low, prev2.low);
    const weekBar = wAsc[weekIdx];

    if (weekBar) {
      const blExit = signal === 'BL' && weekBar.low < twoWeekLow;
      const ssExit = signal === 'SS' && weekBar.high > twoWeekHigh;

      if (blExit || ssExit) {
        const exitPrice = pos.stopPrice;
        const exitReason = signal === 'BL' ? 'SIGNAL_BE' : 'SIGNAL_SE';
        console.log(`[AI PosManager] ${dryRun ? 'DRY-RUN' : 'LIVE'} structural exit ${pos.ticker} ${signal} → ${exitReason} @${exitPrice}`);

        if (!dryRun) {
          const isLong = pos.direction === 'LONG';
          const fills = pos.fills || {};
          const filledShr = Object.values(fills).reduce((s, f) => s + (f.filled ? (+f.shares || 0) : 0), 0) || pos.targetShares || 0;
          const totalCost = Object.values(fills).reduce((s, f) => s + (f.filled ? (+f.shares || 0) * (+f.price || 0) : 0), 0);
          const avgCost = filledShr > 0 ? totalCost / filledShr : pos.entryPrice;
          const profitPct = isLong ? (exitPrice - avgCost) / avgCost * 100 : (avgCost - exitPrice) / avgCost * 100;
          const profitDollar = isLong ? (exitPrice - avgCost) * filledShr : (avgCost - exitPrice) * filledShr;
          const holdingDays = Math.floor((Date.now() - new Date(pos.createdAt).getTime()) / 86400000);

          await db.collection(COLL_PORTFOLIO).updateOne({ _id: pos._id }, {
            $set: {
              status: 'CLOSED', closedAt: new Date(), updatedAt: new Date(),
              outcome: {
                exitPrice, profitPct: +profitPct.toFixed(2), profitDollar: +profitDollar.toFixed(2),
                holdingDays, exitReason,
              },
            },
          });

          await enqueueOutbox(db, ownerId, 'SELL_POSITION', {
            ticker: pos.ticker, direction: pos.direction, shares: filledShr,
            positionId: pos.id, orderType: 'MKT', tif: 'DAY', rth: true,
            source: exitReason,
          });
        }

        results.structuralExits++;
        results.details.push({ ticker: pos.ticker, action: signal === 'BL' ? 'SIGNAL_BE' : 'SIGNAL_SE', exitPrice });
        continue;
      }
    }

    // Stop ratchet
    const currentStop = pos.stopPrice;
    const newStop = computeWeeklyStopCandidate(wBars, atrArr, weekIdx, signal, currentStop);

    if (newStop !== currentStop) {
      console.log(`[AI PosManager] ${dryRun ? 'DRY-RUN' : 'LIVE'} ratchet ${pos.ticker} ${signal} stop ${currentStop} → ${newStop}`);

      if (!dryRun) {
        await db.collection(COLL_PORTFOLIO).updateOne({ _id: pos._id }, {
          $set: { stopPrice: newStop, updatedAt: new Date() },
        });

        const stopShape = buildStopOrderShape({ stopPrice: newStop, direction: pos.direction, stopExtendedHours: false });
        await enqueueOutbox(db, ownerId, 'MODIFY_STOP', {
          ticker: pos.ticker, direction: pos.direction, stopPrice: newStop,
          positionId: pos.id, ...stopShape, source: 'AI_WEEKLY_RATCHET',
        });
      }

      results.ratcheted++;
      results.details.push({ ticker: pos.ticker, action: 'RATCHET', from: currentStop, to: newStop });
    }
  }

  console.log(`[AI PosManager] Weekly ratchet done: ${results.ratcheted} ratcheted, ${results.structuralExits} structural exits out of ${positions.length} positions`);
  return results;
}


// ═══════════════════════════════════════════════════════════════════════════════
// 3. 20-Day Stale Hunt Exit
// ═══════════════════════════════════════════════════════════════════════════════
export async function runAiStaleHuntCheck() {
  const db = await connectToDatabase();
  if (!db) return { error: 'NO_DB' };
  const ownerId = await resolveOwner(db);
  if (!ownerId) return { error: 'NO_OWNER' };

  const dryRun = process.env.AI_AUTO_EXECUTE_DRY_RUN !== 'false';
  const positions = await db.collection(COLL_PORTFOLIO).find({
    ownerId,
    status: { $in: ['ACTIVE', 'PARTIAL'] },
    autoExecuteMode: { $in: ['WEEKLY', 'CONVERTED'] },
  }).toArray();

  if (!positions.length) return { staleExits: 0, positions: 0 };

  const results = { staleExits: 0, positions: positions.length, details: [], dryRun };

  for (const pos of positions) {
    const entryDate = pos.fills?.[1]?.date || pos.createdAt;
    const days = tradingDaysSince(typeof entryDate === 'string' ? entryDate : new Date(entryDate).toISOString().slice(0, 10));

    if (days < STALE_HUNT_DAYS) continue;

    const isLong = pos.direction === 'LONG';
    const currentPrice = pos.currentPrice || pos.entryPrice;
    const fills = pos.fills || {};
    const filledShr = Object.values(fills).reduce((s, f) => s + (f.filled ? (+f.shares || 0) : 0), 0) || pos.targetShares || 0;
    const totalCost = Object.values(fills).reduce((s, f) => s + (f.filled ? (+f.shares || 0) * (+f.price || 0) : 0), 0);
    const avgCost = filledShr > 0 ? totalCost / filledShr : pos.entryPrice;

    const pnlPct = isLong
      ? (currentPrice - avgCost) / avgCost * 100
      : (avgCost - currentPrice) / avgCost * 100;

    if (pnlPct >= 0) continue;

    console.log(`[AI PosManager] ${dryRun ? 'DRY-RUN' : 'LIVE'} STALE_HUNT ${pos.ticker} ${pos.direction} — ${days} trading days, P&L ${pnlPct.toFixed(2)}%`);

    if (!dryRun) {
      const profitDollar = isLong ? (currentPrice - avgCost) * filledShr : (avgCost - currentPrice) * filledShr;
      const holdingDays = Math.floor((Date.now() - new Date(pos.createdAt).getTime()) / 86400000);

      await db.collection(COLL_PORTFOLIO).updateOne({ _id: pos._id }, {
        $set: {
          status: 'CLOSED', closedAt: new Date(), updatedAt: new Date(),
          outcome: {
            exitPrice: currentPrice, profitPct: +pnlPct.toFixed(2), profitDollar: +profitDollar.toFixed(2),
            holdingDays, exitReason: 'STALE_HUNT',
          },
        },
      });

      await enqueueOutbox(db, ownerId, 'SELL_POSITION', {
        ticker: pos.ticker, direction: pos.direction, shares: filledShr,
        positionId: pos.id, orderType: 'MKT', tif: 'DAY', rth: true,
        source: 'STALE_HUNT',
      });
    }

    results.staleExits++;
    results.details.push({ ticker: pos.ticker, direction: pos.direction, tradingDays: days, pnlPct: +pnlPct.toFixed(2) });
  }

  console.log(`[AI PosManager] Stale hunt done: ${results.staleExits} exits out of ${positions.length} positions`);
  return results;
}
