// server/lib/rsi.js
// ── Canonical Wilder RSI ────────────────────────────────────────────────────
//
// Single source of truth for RSI. Mirrors the long-standing implementation in
// assistantService.js (computeDailyRSI14) exactly, generalized to any period.
// New code should import from here; the older copy-pasted RSI helpers scattered
// across the server (apexService, killSimulation, backfillBtScores, etc.) are a
// known dedup-cleanup candidate but are intentionally left untouched for now so
// no live signal path shifts underneath us.
//
// Input:  closes ascending (oldest → newest).
// Output: array same length as closes; null for the first `period` entries,
//         a Wilder-smoothed RSI value from index `period` onward.
// Wilder smoothing: seed with the simple average of the first `period` moves,
// then smooth each subsequent bar as (prev*(period-1) + thisMove) / period.
// ────────────────────────────────────────────────────────────────────────────

export function computeWilderRSI(closes, period = 14) {
  const n = closes.length;
  const rsi = new Array(n).fill(null);
  if (n < period + 1) return rsi;

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
  }
  avgGain /= period;
  avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0))  / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    rsi[i]  = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}
