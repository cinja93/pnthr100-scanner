// server/ai300KillTestSettings.js
// ── PNTHR AI 300 Kill Test — Portfolio Simulation Settings ──────────────────
//
// Separate settings for the AI 300 Kill Test (independent NAV, risk params).
// Collection: pnthr_ai300_kill_test_settings
// Reuses lot sizing constants + helpers from killTestSettings.js.

import { connectToDatabase } from './database.js';

export const AI300_KT_DEFAULTS = {
  nav:              100000,
  riskPctPerTrade:  1,
  portfolioRiskCap: 10,
  sweepRate:        4.83,
  riskFreeRate:     4.50,
  killThreshold:    130, // AI Kill score minimum for appearances
  maxRank:          5,   // Only top N ranked stocks qualify
};

export async function getAi300KillTestSettings() {
  try {
    const db  = await connectToDatabase();
    const doc = await db.collection('pnthr_ai300_kill_test_settings').findOne({});
    if (!doc) return { ...AI300_KT_DEFAULTS };
    const { _id, updatedAt, ...rest } = doc;
    return { ...AI300_KT_DEFAULTS, ...rest };
  } catch {
    return { ...AI300_KT_DEFAULTS };
  }
}

export async function saveAi300KillTestSettings(updates) {
  const db      = await connectToDatabase();
  const allowed = ['nav', 'riskPctPerTrade', 'portfolioRiskCap', 'sweepRate', 'riskFreeRate', 'killThreshold', 'maxRank'];
  const patch   = {};
  for (const k of allowed) {
    if (updates[k] != null && !isNaN(+updates[k])) patch[k] = +updates[k];
  }
  if (Object.keys(patch).length === 0) throw new Error('No valid fields to update');
  await db.collection('pnthr_ai300_kill_test_settings').updateOne(
    {},
    { $set: { ...patch, updatedAt: new Date() } },
    { upsert: true }
  );
  return getAi300KillTestSettings();
}
