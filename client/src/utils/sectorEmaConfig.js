// client/src/utils/sectorEmaConfig.js
// Per-sector optimal EMA periods — mirrors server/sectorEmaConfig.js
export const SECTOR_EMA_PERIODS = {
  'Technology': 21,
  'Healthcare': 24,
  'Financial Services': 25,
  'Industrials': 24,
  'Energy': 26,
  'Communication Services': 21,
  'Real Estate': 26,
  'Utilities': 21,
  'Basic Materials': 19,
  'Consumer Discretionary': 19,
  'Consumer Staples': 18,
};
export const DEFAULT_EMA_PERIOD = 21;
export function getSectorEmaPeriod(sector) {
  return SECTOR_EMA_PERIODS[sector] || DEFAULT_EMA_PERIOD;
}
