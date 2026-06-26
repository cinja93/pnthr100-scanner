// server/data/pnthrAiIndexConfig.js
// ── PNTHR AI 300 — Index Methodology Configuration ──────────────────────────
//
// PNTHR's proprietary AI-economy index. 304 hand-curated holdings across 16
// sectors, capped market-cap weighted, monthly rebalance. Patterned on the
// Nasdaq 100 methodology (cap rules + monthly rebalance + divisor maintenance).
//
// Public spec (white-paper-ready):
//   • Constituents: see scripts/aiUniverse/aiUniverseData.js (304 names, FUND_META v2.0)
//   • Weighting:    Float-adjusted market cap, with single-name and hyperscaler caps
//   • Caps:         4.00% single-name (any non-hyperscaler), 1.50% hyperscaler
//   • Rebalance:    First trading day of each calendar month
//   • Base date:    2022-11-30 (ChatGPT launch — start of modern Generative AI cycle)
//   • Base value:   1000.00
//   • Continuity:   Divisor adjusts on rebalance + on add/drop, no jumps in index value
//
// Storage (separate from PNTHR 679 — zero spillover):
//   • pnthr_ai_index_candles         — daily OHLCV bars for PAI300
//   • pnthr_ai_index_candles_weekly  — weekly bars, aggregated from daily
//   • pnthr_ai_index_meta            — divisor history, rebalance log, constituent weights timeline
// ────────────────────────────────────────────────────────────────────────────

export const INDEX_NAME    = 'PNTHR AI 300';
export const INDEX_TICKER  = 'PAI300';

export const BASE_DATE     = '2022-01-03';
export const BASE_VALUE    = 1000.00;

export const SINGLE_NAME_CAP = 0.025;  // 2.50% non-hyperscaler cap (lowered 2026-06-25 for Mag-7 de-concentration)
export const HYPERSCALER_CAP = 0.01;   // 1.00% hyperscaler-tier cap (lowered 2026-06-25)

// Hyperscaler set = AI Hyperscalers & Mega-Cap Software (sector 6 of the
// AI Universe taxonomy). These are the names that, uncapped, would dominate
// any AI-themed market-cap-weighted index. Cap matches the white paper.
export const HYPERSCALER_TICKERS = ['MSFT', 'GOOGL', 'META', 'AMZN', 'ORCL', 'IBM'];

// Rebalance frequency. 'monthly' = first trading day of each calendar month.
export const REBALANCE_FREQUENCY = 'monthly';

// Mongo collection names (kept distinct from 679 collections by `_ai_index_` infix).
export const COLL_INDEX_DAILY   = 'pnthr_ai_index_candles';
export const COLL_INDEX_WEEKLY  = 'pnthr_ai_index_candles_weekly';
export const COLL_INDEX_META    = 'pnthr_ai_index_meta';

// EMA period for PAI300 — ONE number, applied to weekly bars for the weekly
// EMA (36W) and to daily bars for the daily EMA (36D). Empirically tuned to
// ride PAI300's own historical pullbacks (Oct 2023, Jul 2024). Iterated:
// 21 → 20 → 23 → 24 → 26 → 27 → 29 → 30 → 35 → 36.
// Re-tune without affecting 679's sector-optimized EMA system — this index
// has its own EMA spec.
export const INDEX_EMA_PERIOD = 36;

// Back-compat aliases — all timeframes resolve to the same base number.
export const INDEX_EMA_DAILY_PERIOD   = INDEX_EMA_PERIOD;
export const INDEX_EMA_WEEKLY_PERIOD  = INDEX_EMA_PERIOD;
export const INDEX_EMA_MONTHLY_PERIOD = 12;
