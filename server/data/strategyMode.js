// 81 AI 300 tickers that run under Carnivore (679) strategy rules:
// weekly-only pyramid, SPY/QQQ regime gate, sector OpEMAs (18-26W).
// All other AI 300 tickers run under AI 300 rules:
// scouts + weekly, PAI300 regime gate, AI-tuned EMAs (30-40W).
// Source: overlap P&L analysis (Nov 2022 – May 2026), locked 2026-05-12.

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
// GICS classifications verified against S&P GICS standard.
const CARNIVORE_TICKERS = {
  // Technology (21W)
  ADBE: 'Technology', AKAM: 'Technology', AMAT: 'Technology', ANET: 'Technology',
  APP: 'Technology', ARM: 'Technology', AVGO: 'Technology', CDNS: 'Technology',
  CDW: 'Technology', CIEN: 'Technology', COHR: 'Technology', CRM: 'Technology',
  CRWD: 'Technology', CSCO: 'Technology', DDOG: 'Technology', FFIV: 'Technology',
  FICO: 'Technology', FTNT: 'Technology', GLW: 'Technology', IBM: 'Technology',
  INTU: 'Technology', LRCX: 'Technology', MRVL: 'Technology', MSFT: 'Technology',
  NOW: 'Technology', NVDA: 'Technology', NXPI: 'Technology', ORCL: 'Technology',
  PANW: 'Technology', PTC: 'Technology', QCOM: 'Technology', SMCI: 'Technology',
  SNDK: 'Technology', SNPS: 'Technology', TEL: 'Technology', TYL: 'Technology',
  VRSK: 'Technology', WDAY: 'Technology', WDC: 'Technology', ZBRA: 'Technology',
  // Communication Services (21W)
  GOOGL: 'Communication Services', META: 'Communication Services',
  // Consumer Discretionary (19W)
  AMZN: 'Consumer Discretionary', TSLA: 'Consumer Discretionary', APTV: 'Consumer Discretionary',
  // Real Estate (26W)
  AMT: 'Real Estate', CCI: 'Real Estate', CSGP: 'Real Estate',
  DLR: 'Real Estate', EQIX: 'Real Estate', IRM: 'Real Estate',
  // Utilities (21W)
  CEG: 'Utilities', D: 'Utilities', NEE: 'Utilities', SRE: 'Utilities',
  // Energy (26W)
  EQT: 'Energy', KMI: 'Energy', OKE: 'Energy', TRGP: 'Energy', WMB: 'Energy',
  // Industrials (24W)
  CARR: 'Industrials', EMR: 'Industrials', ETN: 'Industrials', GD: 'Industrials',
  GEV: 'Industrials', GNRC: 'Industrials', HON: 'Industrials', HUBB: 'Industrials',
  JCI: 'Industrials', KTOS: 'Industrials', LDOS: 'Industrials', LMT: 'Industrials',
  ROK: 'Industrials', RTX: 'Industrials', SATS: 'Industrials', TDG: 'Industrials',
  TRMB: 'Industrials', TT: 'Industrials', TXT: 'Industrials',
  // Financial Services (25W)
  HOOD: 'Financial Services',
  // Basic Materials (19W)
  ALB: 'Basic Materials',
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
