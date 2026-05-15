// server/ai300KillSimulation.js
// ── PNTHR AI 300 Kill 10 — Pyramid Stats from Case Study Data ─────────────
//
// Builds simulation-format response directly from backfilled case study data
// (pnthr_ai300_kill_case_studies) which already contains correct P&L.
// No FMP daily candle re-simulation needed.

import { connectToDatabase } from './database.js';

const STRIKE_PCT   = [0.35, 0.25, 0.20, 0.12, 0.08];
const LOT_OFFSETS  = [0, 0.03, 0.06, 0.10, 0.14];

function buildLots(entryPrice, direction, weeklySnapshots) {
  const isLong = direction === 'LONG';

  // Find the peak price reached during the trade from weekly snapshots
  let peakFavorable = entryPrice;
  if (weeklySnapshots?.length > 0) {
    for (const snap of weeklySnapshots) {
      const p = snap.price ?? snap.currentPrice;
      if (p == null) continue;
      if (isLong && p > peakFavorable) peakFavorable = p;
      if (!isLong && p < peakFavorable) peakFavorable = p;
    }
  }

  const lots = [];
  for (let i = 0; i < 5; i++) {
    const triggerPrice = isLong
      ? parseFloat((entryPrice * (1 + LOT_OFFSETS[i])).toFixed(2))
      : parseFloat((entryPrice * (1 - LOT_OFFSETS[i])).toFixed(2));

    const reached = i === 0 || (isLong ? peakFavorable >= triggerPrice : peakFavorable <= triggerPrice);

    if (reached) {
      lots.push({
        lot: i + 1,
        fillDate: null,
        fillPrice: i === 0 ? entryPrice : triggerPrice,
        pctOfTotal: STRIKE_PCT[i],
      });
    } else {
      break;
    }
  }
  return lots;
}

export async function simulateAllAi300KillTrades() {
  const db = await connectToDatabase();
  if (!db) throw new Error('DB unavailable');

  const studies = await db.collection('pnthr_ai300_kill_case_studies')
    .find({}).sort({ entryDate: 1 }).toArray();

  if (studies.length === 0) return { trades: [], simulatedAt: new Date().toISOString() };

  const trades = studies.map(s => {
    const direction = s.direction === 'SHORT' ? 'SHORT' : 'LONG';
    const isClosed = s.status === 'CLOSED';

    const lots = buildLots(s.entryPrice, direction, s.weeklySnapshots);

    const lastSnapshot = s.weeklySnapshots?.length > 0
      ? s.weeklySnapshots[s.weeklySnapshots.length - 1]
      : null;

    return {
      ticker: s.ticker,
      direction,
      sector: s.sector,
      entryDate: s.entryDate,
      entryPrice: s.entryPrice,
      initStop: s.stopPrice,
      entryRank: s.entryRank,
      entryTier: s.entryTier,
      status: s.status,
      lots,
      finalExit: isClosed && s.exitPrice != null
        ? { date: s.exitDate, price: s.exitPrice, reason: s.exitReason || 'EXIT' }
        : null,
      latestPrice: isClosed
        ? (s.exitPrice ?? s.entryPrice)
        : (lastSnapshot?.price ?? s.entryPrice),
      latestDate: isClosed
        ? (s.exitDate ?? s.entryDate)
        : (lastSnapshot?.date ?? s.entryDate),
      holdingDays: (s.holdingWeeks ?? 0) * 5,
      stopHistory: [],
    };
  });

  const results = trades.filter(t => t != null);

  return {
    trades: results,
    simulatedAt: new Date().toISOString(),
    tradeCount: results.length,
    closedCount: results.filter(r => r.status === 'CLOSED').length,
    activeCount: results.filter(r => r.status === 'ACTIVE').length,
  };
}

export async function ai300KillSimulationHandler(req, res) {
  try {
    const result = await simulateAllAi300KillTrades();
    res.json(result);
  } catch (err) {
    console.error('[AI300 KILL SIM] Error:', err);
    res.status(500).json({ error: err.message });
  }
}
