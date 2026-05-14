// Overlap tickers that run under Carnivore (679) strategy rules:
// weekly-only pyramid, SPY/QQQ regime gate, GICS OpEMAs (18-26W).
// All other AI 300 tickers run under AI 300 rules:
// weekly + sector rotation, PAI300 regime gate, AI-tuned EMAs (30-40W).
//
// Source: head-to-head backtest comparison (Nov 2022 - May 2026),
// overlapComparison.js. Each ticker tested individually under both
// strategy rule sets. These 26 tickers produced higher P&L under
// 679 rules. The other 81 former carnivore tickers moved to AI 300
// because AI 300 rules produced better results for them.
//
// Updated 2026-05-13 (was 81 tickers, now 26 after APEX v7 retest).

// GICS sector → OpEMA period (from server/sectorEmaConfig.js)
const GICS_EMA = {
  Technology:              21,
  'Communication Services': 21,
  'Consumer Discretionary': 19,
  'Consumer Staples':      18,
  'Real Estate':           26,
  Utilities:               21,
  Energy:                  26,
  Industrials:             24,
  'Financial Services':    25,
  Healthcare:              24,
  'Basic Materials':       19,
};

// Carnivore tickers with their GICS sector for OpEMA lookup.
// Only tickers where 679 rules outperformed AI 300 rules in the
// Nov 2022 - May 2026 head-to-head backtest (overlapComparison.js).
const CARNIVORE_TICKERS = {
  // Technology (21W)
  AKAM: 'Technology', ANET: 'Technology', CDW: 'Technology',
  COHR: 'Technology', INTC: 'Technology', KLAC: 'Technology',
  SNDK: 'Technology',
  // Communication Services (21W)
  META: 'Communication Services',
  // Consumer Discretionary (19W)
  TSLA: 'Consumer Discretionary',
  // Real Estate (26W)
  CSGP: 'Real Estate',
  // Utilities (21W)
  CEG: 'Utilities',
  // Energy (26W)
  EQT: 'Energy', TRGP: 'Energy',
  // Industrials (24W)
  APH: 'Industrials', ARM: 'Industrials', EMR: 'Industrials',
  ETN: 'Industrials', GEV: 'Industrials', HUBB: 'Industrials',
  LDOS: 'Industrials', TDG: 'Industrials', TRMB: 'Industrials',
  // Financial Services (25W)
  // (none)
  // Basic Materials (19W)
  CMI: 'Basic Materials',
  // Other
  IBM: 'Technology', ORCL: 'Technology', TTD: 'Technology',
  VST: 'Utilities', LITE: 'Technology',
};

export const CARNIVORE_MODE_TICKERS = new Set(Object.keys(CARNIVORE_TICKERS));

export function getStrategyMode(ticker) {
  return CARNIVORE_MODE_TICKERS.has(ticker) ? 'carnivore' : 'ai300';
}

export function isCarnivoreMode(ticker) {
  return CARNIVORE_MODE_TICKERS.has(ticker);
}

export function isAi300Mode(ticker) {
  return !CARNIVORE_MODE_TICKERS.has(ticker);
}

// OpEMA period for carnivore tickers (GICS sector-optimized, 18-26W).
// Returns null for AI 300-mode tickers (caller should use AI sector EMA).
export function getCarnivoreEmaPeriod(ticker) {
  const sector = CARNIVORE_TICKERS[ticker];
  if (!sector) return null;
  return GICS_EMA[sector] || 21;
}

// 679 standard gate offset (1.10×), vs AI 300's relaxed 1.25×
export const CARNIVORE_GATE_OFFSET = 0.10;
