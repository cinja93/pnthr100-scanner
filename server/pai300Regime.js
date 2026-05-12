// server/pai300Regime.js
// PAI300 36W EMA regime gate — shared by AI Orders pipeline + AI Kill service.
// Returns true (bull), false (bear), or null (unknown).

import { connectToDatabase } from './database.js';

const REGIME_PERIOD = 36;

export async function getPai300Regime() {
  try {
    const db = await connectToDatabase();
    if (!db) return null;
    const paiDoc = await db.collection('pnthr_ai_index_candles_weekly').findOne({ ticker: 'PAI300' });
    const wk = (paiDoc?.weekly || []).slice().sort((a, b) => a.weekOf.localeCompare(b.weekOf));
    if (wk.length < REGIME_PERIOD) return null;
    const closes = wk.map(b => b.close);
    const k = 2 / (REGIME_PERIOD + 1);
    let ema = closes.slice(0, REGIME_PERIOD).reduce((s, x) => s + x, 0) / REGIME_PERIOD;
    for (let i = REGIME_PERIOD; i < closes.length; i++) ema = (closes[i] - ema) * k + ema;
    return closes[closes.length - 1] > ema;
  } catch (err) {
    console.warn('[PAI300 regime] lookup failed:', err.message);
    return null;
  }
}
