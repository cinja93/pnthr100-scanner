// Client mirror of server/data/strategyMode.js
// 26 AI 300 tickers that run under Carnivore (679) strategy rules.
// Source: head-to-head backtest comparison (Nov 2022 – May 2026),
// overlapComparison.js. Updated 2026-05-13 (was 81, now 26 after APEX v7 retest).

const CARNIVORE_MODE_TICKERS = new Set([
  'AKAM', 'ANET', 'APH', 'ARM', 'CDW', 'CEG', 'CMI', 'COHR',
  'CSGP', 'EMR', 'EQT', 'ETN', 'GEV', 'HUBB', 'IBM', 'INTC',
  'KLAC', 'LDOS', 'LITE', 'META', 'ORCL', 'SNDK', 'TDG', 'TRGP',
  'TRMB', 'TSLA', 'TTD', 'VST',
]);

// GICS sector → OpEMA period (mirrors server/sectorEmaConfig.js)
const GICS_EMA = {
  Technology: 21, 'Communication Services': 21, 'Consumer Discretionary': 19,
  'Consumer Staples': 18, 'Real Estate': 26, Utilities: 21, Energy: 26,
  Industrials: 24, 'Financial Services': 25, Healthcare: 24, 'Basic Materials': 19,
};

// Carnivore ticker → GICS sector
const CARNIVORE_SECTOR = {
  AKAM: 'Technology', ANET: 'Technology', CDW: 'Technology', COHR: 'Technology',
  INTC: 'Technology', KLAC: 'Technology', SNDK: 'Technology', IBM: 'Technology',
  ORCL: 'Technology', TTD: 'Technology', LITE: 'Technology',
  META: 'Communication Services',
  TSLA: 'Consumer Discretionary',
  CSGP: 'Real Estate',
  CEG: 'Utilities', VST: 'Utilities',
  EQT: 'Energy', TRGP: 'Energy',
  APH: 'Industrials', ARM: 'Industrials', EMR: 'Industrials', ETN: 'Industrials',
  GEV: 'Industrials', HUBB: 'Industrials', LDOS: 'Industrials', TDG: 'Industrials',
  TRMB: 'Industrials',
  CMI: 'Basic Materials',
};

export function getStrategyMode(ticker) {
  return CARNIVORE_MODE_TICKERS.has(ticker) ? 'carnivore' : 'ai300';
}

export function isCarnivoreMode(ticker) {
  return CARNIVORE_MODE_TICKERS.has(ticker);
}

export function getCarnivoreEmaPeriod(ticker) {
  const sector = CARNIVORE_SECTOR[ticker];
  if (!sector) return null;
  return GICS_EMA[sector] || 21;
}
