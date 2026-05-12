// Client mirror of server/data/strategyMode.js
// 81 AI 300 tickers that run under Carnivore (679) strategy rules.
// Source: overlap P&L analysis (Nov 2022 – May 2026), locked 2026-05-12.

const CARNIVORE_MODE_TICKERS = new Set([
  'ADBE', 'AKAM', 'ALB', 'AMAT', 'AMT', 'AMZN', 'ANET', 'APP',
  'APTV', 'ARM', 'AVGO', 'CARR', 'CCI', 'CDNS', 'CDW', 'CEG',
  'CIEN', 'COHR', 'CRM', 'CRWD', 'CSCO', 'CSGP', 'D', 'DDOG',
  'DLR', 'EMR', 'EQIX', 'EQT', 'ETN', 'FFIV', 'FICO', 'FTNT',
  'GD', 'GEV', 'GLW', 'GNRC', 'GOOGL', 'HON', 'HOOD', 'HUBB',
  'IBM', 'INTU', 'IRM', 'JCI', 'KMI', 'KTOS', 'LDOS', 'LMT',
  'LRCX', 'META', 'MRVL', 'MSFT', 'NEE', 'NOW', 'NVDA', 'NXPI',
  'OKE', 'ORCL', 'PANW', 'PTC', 'QCOM', 'ROK', 'RTX', 'SATS',
  'SMCI', 'SNDK', 'SNPS', 'SRE', 'TDG', 'TEL', 'TRGP', 'TRMB',
  'TSLA', 'TT', 'TXT', 'TYL', 'VRSK', 'WDAY', 'WDC', 'WMB',
  'ZBRA',
]);

export function getStrategyMode(ticker) {
  return CARNIVORE_MODE_TICKERS.has(ticker) ? 'carnivore' : 'ai300';
}

export function isCarnivoreMode(ticker) {
  return CARNIVORE_MODE_TICKERS.has(ticker);
}
