// server/data/pnthrAiSectorsConfig.js
// ── PNTHR AI Sectors — 16 synthetic sector indices ──────────────────────────
//
// One synthetic index per sector in the AI Universe taxonomy. Same methodology
// as the parent PNTHR AI 300 (capped market-cap, monthly rebalance), but the
// universe is restricted to that sector's constituents and weights are
// renormalized to 1.0 within the sector.
//
// Each sector index is treated as its own ticker for storage and chart purposes:
// `PAI_S{id}` where `id` is the sectorId from aiUniverseData.js.
//
// Base date / value matches the parent (2022-11-30 = 1000.00) so all 16
// sector lines anchor at the same point and you can read relative performance
// straight off the chart.
//
// Storage (kept distinct from PAI300 + PNTHR 679):
//   • pnthr_ai_sector_candles         — daily OHLCV bars per sector
//   • pnthr_ai_sector_candles_weekly  — weekly bars per sector
//   • pnthr_ai_sector_meta            — per-sector rebalance log + current weights
// ────────────────────────────────────────────────────────────────────────────

import { SECTORS } from '../scripts/aiUniverse/aiUniverseData.js';

export const SECTOR_BASE_DATE  = '2022-11-30';
export const SECTOR_BASE_VALUE = 1000.00;

// Same caps as the parent PAI300 — applied within each sector after renormalizing.
export const SECTOR_SINGLE_NAME_CAP = 0.04;
export const SECTOR_HYPERSCALER_CAP = 0.015;
export const SECTOR_HYPERSCALER_TICKERS = ['MSFT', 'GOOGL', 'META', 'AMZN', 'ORCL', 'IBM'];

// Mongo collection names (distinct from PAI300 + 679 by `_ai_sector_` infix).
export const COLL_SECTOR_DAILY   = 'pnthr_ai_sector_candles';
export const COLL_SECTOR_WEEKLY  = 'pnthr_ai_sector_candles_weekly';
export const COLL_SECTOR_META    = 'pnthr_ai_sector_meta';

// Synthetic ticker for each sector: PAI_S{id}
export function sectorTicker(sectorId) {
  return `PAI_S${sectorId}`;
}

// Per-sector EMA period. ONE number per sector — applied to weekly bars for
// the weekly signal/EMA (e.g. 36W) and to the same-numbered daily EMA (36D).
// Default 30 for all 16; per-sector overrides below are added one line at a
// time as Scott observes the charts and tunes.
//   Format: sectorId → period
//   Example: "AI Compute, try 35" → set 1: 35
const SECTOR_EMA_OVERRIDES = {
  4:  36,  // AI Cloud, Data Centers & Edge                  (iterated 30 → 34 → 36)
  7:  36,  // AI Software & Agentic Platforms                (iterated 30 → 36)
  12: 40,  // AI Healthcare, Genomics & Drug Discovery       (iterated 30 → 40)
};

export const SECTOR_EMA_PERIODS = Object.fromEntries(
  SECTORS.map(s => [s.id, SECTOR_EMA_OVERRIDES[s.id] ?? 30])
);

// Back-compat aliases — both timeframes resolve to the same number.
export const SECTOR_EMA_WEEKLY_PERIODS = SECTOR_EMA_PERIODS;
export const SECTOR_EMA_DAILY_PERIODS  = SECTOR_EMA_PERIODS;

// Convenience export — sector metadata for frontend (id, name, count, target weight)
export const SECTOR_METADATA = SECTORS.map(s => ({
  id:           s.id,
  name:         s.name,
  ticker:       sectorTicker(s.id),
  holdingCount: s.holdings.length,
  targetWeight: s.weight,
}));
