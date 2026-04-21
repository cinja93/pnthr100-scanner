// server/sectorEmaConfig.js
// ── Per-Sector Optimal EMA Periods — Single Source of Truth ──────────────────
//
// Empirically derived from backtesting EMA periods 15–26 across all 11 S&P 500
// sectors on the full PNTHR 679-stock universe (2020-2026).
//
// Validated out-of-sample: Train 2020-2023 (+131%), Test 2024-2026 (+73%).
// Zero year regressions. Zero sector regressions in the full pipeline.
//
// Cluster pattern:
//   Fast-cycle (18-19): Consumer Staples, Consumer Discretionary, Basic Materials
//   Standard (21):      Technology, Communication Services, Utilities
//   Slow-cycle (24-26): Healthcare, Industrials, Financial Services, Energy,
//                        Communication Services, Real Estate
//
// IMPORTANT: SPY/QQQ/MDY direction-index regime gates stay at EMA 21 (per v22
//            Den disclosure: "21-week EMA for INDEX gate only").
//            Sector ETF gates use per-sector optimized EMA from this table
//            (v22 adoption 2026-04-21 — aligns with Den disclosure
//            "sector-specific optimized EMA").
// ─────────────────────────────────────────────────────────────────────────────

export const SECTOR_EMA_PERIODS = {
  'Technology':              21,
  'Healthcare':              24,
  'Financial Services':      25,
  'Industrials':             24,
  'Energy':                  26,
  'Communication Services':  21,
  'Real Estate':             26,
  'Utilities':               21,
  'Basic Materials':         19,
  'Consumer Discretionary':  19,
  'Consumer Staples':        18,
};

// Default period for unknown sectors or index-level calculations
export const DEFAULT_EMA_PERIOD = 21;

// Regime gate period (SPY/QQQ) — always 21, independent of sector optimization
export const REGIME_EMA_PERIOD = 21;

/**
 * Get the optimal EMA period for a given sector.
 * Falls back to DEFAULT_EMA_PERIOD (21) for unknown sectors.
 * @param {string} sector - Canonical PNTHR sector name
 * @returns {number} EMA period
 */
export function getSectorEmaPeriod(sector) {
  return SECTOR_EMA_PERIODS[sector] || DEFAULT_EMA_PERIOD;
}

// Client-friendly export: sector → period mapping for bundling into client code
export const SECTOR_EMA_MAP = { ...SECTOR_EMA_PERIODS };
