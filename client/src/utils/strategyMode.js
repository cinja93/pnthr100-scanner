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

export function getStrategyMode(ticker) {
  return CARNIVORE_MODE_TICKERS.has(ticker) ? 'carnivore' : 'ai300';
}

export function isCarnivoreMode(ticker) {
  return CARNIVORE_MODE_TICKERS.has(ticker);
}
