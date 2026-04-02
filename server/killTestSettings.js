// server/killTestSettings.js
// ── PNTHR Kill Test — Portfolio Simulation Settings ───────────────────────────
//
// Configurable parameters for the Kill Test simulation portfolio.
// Stored as a single document in pnthr_kill_test_settings.
// Admin-only read/write via /api/kill-test/settings
// ─────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';

export const KT_DEFAULTS = {
  nav:              100000,  // Starting portfolio NAV ($)
  riskPctPerTrade:  1,       // Risk % per trade (1% of NAV at full lot size)
  portfolioRiskCap: 10,      // Max % of portfolio at risk simultaneously
  sweepRate:        4.83,    // IBKR sweep interest rate on idle cash (%)
  riskFreeRate:     4.50,    // 2-year Treasury yield for Sharpe/Sortino (%)
};

// ── Lot sizing constants (mirrors client sizingUtils.js) ──────────────────────
export const STRIKE_PCT   = [0.35, 0.25, 0.20, 0.12, 0.08];
export const LOT_OFFSETS  = [0,    0.03, 0.06, 0.10, 0.14];
export const LOT_NAMES    = ['The Scent', 'The Stalk', 'The Strike', 'The Jugular', 'The Kill'];

// ── Server-side sizePosition (mirrors client sizingUtils.sizePosition) ────────
export function serverSizePosition({ nav, entryPrice, stopPrice, riskPct = 1 }) {
  if (!entryPrice || !stopPrice || !nav || nav <= 0) return null;
  const tickerCap = nav * 0.10;                      // 10% ticker cap
  const vitality  = nav * (riskPct / 100);           // dollar risk budget
  const rps       = Math.abs(entryPrice - stopPrice); // risk per share
  if (rps <= 0) return null;
  const totalShares = Math.floor(
    Math.min(Math.floor(vitality / rps), Math.floor(tickerCap / entryPrice))
  );
  if (totalShares <= 0) return null;
  return {
    totalShares,
    vitalityDollar: +vitality.toFixed(2),
    maxRiskDollar:  +(totalShares * rps).toFixed(2),
    riskPerShare:   +rps.toFixed(4),
  };
}

// ── Build lot configuration ───────────────────────────────────────────────────
export function buildServerLotConfig(totalShares, entryPrice, signal) {
  const isShort = signal === 'SS';
  return STRIKE_PCT.map((pct, i) => ({
    lotNum:       i + 1,
    name:         LOT_NAMES[i],
    targetShares: Math.max(1, Math.round(totalShares * pct)),
    pct:          pct * 100,
    triggerPrice: isShort
      ? +(entryPrice * (1 - LOT_OFFSETS[i])).toFixed(2)
      : +(entryPrice * (1 + LOT_OFFSETS[i])).toFixed(2),
    offsetPct:    LOT_OFFSETS[i] * 100,
  }));
}

// ── Compute ratcheted stop after lot fills ────────────────────────────────────
// Lot 2+ filled → stop moves to avg cost of all filled lots (true breakeven)
// Rule: SS stop only moves DOWN (tightens), BL stop only moves UP
export function computeRatchetedStop(lotFills, initialStop, signal) {
  if (!lotFills) return initialStop;
  const isShort = signal === 'SS';

  // Compute avg cost of all filled lots (true breakeven)
  let cumCost = 0, cumShr = 0;
  for (let n = 1; n <= 5; n++) {
    const key = `lot${n}`;
    const lot = lotFills[key];
    if (lot?.filled && lot?.fillPrice != null && lot?.shares > 0) {
      cumCost += lot.shares * lot.fillPrice;
      cumShr  += lot.shares;
    }
  }

  // No ratchet until at least 2 lots filled
  const filledCount = Object.values(lotFills).filter(l => l?.filled).length;
  if (filledCount < 2 || cumShr === 0) return initialStop;

  const avgCost = +(cumCost / cumShr).toFixed(2);

  // Never move stop in unfavorable direction
  if (isShort) return Math.min(avgCost, initialStop); // SS: stop moves down
  else          return Math.max(avgCost, initialStop); // BL: stop moves up
}

// ── Settings CRUD ─────────────────────────────────────────────────────────────

export async function getKillTestSettings() {
  try {
    const db  = await connectToDatabase();
    const doc = await db.collection('pnthr_kill_test_settings').findOne({});
    if (!doc) return { ...KT_DEFAULTS };
    const { _id, updatedAt, ...rest } = doc;
    return { ...KT_DEFAULTS, ...rest };
  } catch {
    return { ...KT_DEFAULTS };
  }
}

export async function saveKillTestSettings(updates) {
  const db      = await connectToDatabase();
  const allowed = ['nav', 'riskPctPerTrade', 'portfolioRiskCap', 'sweepRate', 'riskFreeRate'];
  const patch   = {};
  for (const k of allowed) {
    if (updates[k] != null && !isNaN(+updates[k])) patch[k] = +updates[k];
  }
  if (Object.keys(patch).length === 0) throw new Error('No valid fields to update');
  await db.collection('pnthr_kill_test_settings').updateOne(
    {},
    { $set: { ...patch, updatedAt: new Date() } },
    { upsert: true }
  );
  return getKillTestSettings();
}
