/**
 * PNTHR ETF Asset Class Classification
 *
 * All 140 ETFs from etfService.js classified by asset type.
 * Drives ETF Analyze macro alignment scoring — each class gets
 * the appropriate macro context (own momentum, regime inversion, etc.)
 *
 * Classes:
 *   SECTOR      — Pure GICS sector US equity ETF (XLK, XLE, etc.)
 *   INDEX       — Broad US equity market / factor ETF (SPY, QQQ, etc.)
 *   THEMATIC    — Sub-sector, innovation, or niche equity ETF (SOXX, ARKK)
 *   COMMODITY   — Physical commodity or commodity futures ETF (USO, GLD)
 *   BOND        — Fixed income / treasury ETF (TLT, HYG)
 *   CURRENCY    — Currency-tracking ETF (UUP, FXE)
 *   INTERNATIONAL — Non-US equity ETF (EEM, EWJ)
 *
 * Populated from server/etfService.js ETF_CATEGORIES (140 tickers).
 * Update this file when etfService.js adds new ETFs.
 */

const ETF_ASSET_CLASS = {
  // ── S&P 500 Sectors (pure GICS) ─────────────────────────────────────────────
  XLK:  'SECTOR',   // Technology
  XLI:  'SECTOR',   // Industrials
  XLF:  'SECTOR',   // Financials
  XLV:  'SECTOR',   // Health Care
  XLY:  'SECTOR',   // Consumer Discretionary
  XLP:  'SECTOR',   // Consumer Staples
  XLRE: 'SECTOR',   // Real Estate
  XLB:  'SECTOR',   // Materials
  XLU:  'SECTOR',   // Utilities
  XLC:  'SECTOR',   // Communication Services
  XLE:  'SECTOR',   // Energy

  // ── Broad Market / Factor (US equities, index-like) ──────────────────────────
  SPY:  'INDEX',    // S&P 500
  VOO:  'INDEX',    // Vanguard S&P 500
  RSP:  'INDEX',    // Equal-weight S&P 500
  ONEQ: 'INDEX',    // Fidelity Nasdaq Composite
  QQQ:  'INDEX',    // Nasdaq 100
  NYA:  'INDEX',    // NYSE Composite
  DIA:  'INDEX',    // Dow Jones
  VTI:  'INDEX',    // Vanguard Total Market
  IWB:  'INDEX',    // iShares Russell 1000
  IWV:  'INDEX',    // iShares Russell 3000
  IWM:  'INDEX',    // Russell 2000
  IJR:  'INDEX',    // S&P 600 Small Cap
  TOPT: 'INDEX',    // Toroso ETF
  IJH:  'INDEX',    // S&P 400 Mid Cap
  FRTY: 'INDEX',    // Alger 35 ETF

  // ── Growth & Factor (US equity factor tilts) ─────────────────────────────────
  SPMO:  'INDEX',   // S&P 500 Momentum
  XMMO:  'INDEX',   // MidCap Momentum
  QUAL:  'INDEX',   // MSCI USA Quality Factor
  MGK:   'INDEX',   // Vanguard Mega Cap Growth
  VUG:   'INDEX',   // Vanguard Growth
  SCHG:  'INDEX',   // Schwab US Large-Cap Growth
  QQQM:  'INDEX',   // Invesco Nasdaq 100 (mini)
  SCHD:  'INDEX',   // Schwab Dividend
  VIG:   'INDEX',   // Vanguard Dividend Appreciation
  DGRO:  'INDEX',   // iShares Core Dividend Growth
  NOBL:  'INDEX',   // S&P 500 Dividend Aristocrats
  USMV:  'INDEX',   // MSCI USA Min Volatility
  VYM:   'INDEX',   // Vanguard High Dividend Yield
  NANC:  'THEMATIC', // Unusual Whales Democratic tracker

  // ── Technology & Innovation (thematic sub-sectors) ───────────────────────────
  MAGS:  'THEMATIC', // Magnificent 7 focused
  IETC:  'THEMATIC', // iShares US Tech Independence
  SMH:   'THEMATIC', // Semiconductor (VanEck)
  XSD:   'THEMATIC', // S&P Semiconductor
  SOXX:  'THEMATIC', // iShares Semiconductor
  VGT:   'THEMATIC', // Vanguard IT
  IGV:   'THEMATIC', // iShares Software
  AIQ:   'THEMATIC', // AI & Technology
  ARTY:  'THEMATIC', // iShares Robotics & AI
  CHAT:  'THEMATIC', // Roundhill Generative AI
  QTUM:  'THEMATIC', // Defiance Quantum
  HACK:  'THEMATIC', // Cybersecurity
  CLOU:  'THEMATIC', // Cloud Computing
  DTCR:  'THEMATIC', // Data Center
  SOCL:  'THEMATIC', // Social Media
  BLOK:  'THEMATIC', // Blockchain
  BKCH:  'THEMATIC', // Global X Blockchain
  XTL:   'THEMATIC', // SPDR S&P Telecom

  // ── Aerospace & Defense ───────────────────────────────────────────────────────
  XAR:   'THEMATIC', // SPDR S&P Aerospace & Defense
  ITA:   'THEMATIC', // iShares US Aerospace & Defense
  ARKX:  'THEMATIC', // ARK Space Exploration
  JEDI:  'THEMATIC', // Adaptive Alpha Defense
  FITE:  'THEMATIC', // Prime Cyber Security
  BOTZ:  'THEMATIC', // Global X Robotics & AI
  ROBO:  'THEMATIC', // Robo Global Robotics

  // ── Energy & Infrastructure ───────────────────────────────────────────────────
  XOP:   'THEMATIC', // S&P Oil & Gas E&P (equity sub-sector)
  OIH:   'THEMATIC', // VanEck Oil Services (equity)
  USO:   'COMMODITY', // United States Oil Fund (crude futures)
  USAI:  'THEMATIC', // US Energy Independence (equity)
  LNGX:  'COMMODITY', // Global X LNG
  UNG:   'COMMODITY', // United States Natural Gas Fund (futures)
  NUKZ:  'THEMATIC', // Range Nuclear Renaissance
  RSHO:  'THEMATIC', // Cambiar Fossil Fuel Free
  POWR:  'THEMATIC', // Invesco DWA Utilities Momentum
  GRID:  'THEMATIC', // First Trust Clean Edge Smart Grid
  PAVE:  'THEMATIC', // Global X US Infrastructure Development
  JETS:  'THEMATIC', // US Global Jets (airlines)

  // ── Materials & Mining ────────────────────────────────────────────────────────
  XME:   'THEMATIC', // SPDR S&P Metals & Mining
  PICK:  'THEMATIC', // iShares MSCI Global Metals & Mining
  REMX:  'THEMATIC', // VanEck Rare Earth/Strategic Metals
  GDX:   'COMMODITY', // VanEck Gold Miners (moves with gold price)
  SIL:   'COMMODITY', // Global X Silver Miners (moves with silver)
  SLVP:  'COMMODITY', // iShares MSCI Global Silver Miners
  COPJ:  'THEMATIC', // Sprott Junior Copper Miners
  COPX:  'THEMATIC', // Global X Copper Miners
  SLX:   'THEMATIC', // VanEck Steel
  URA:   'THEMATIC', // Global X Uranium
  LIT:   'THEMATIC', // Global X Lithium & Battery Tech
  SETM:  'THEMATIC', // Sprott Energy Transition Materials
  IBAT:  'THEMATIC', // iShares Li-Ion Battery & Storage
  IGF:   'THEMATIC', // iShares Global Infrastructure

  // ── Precious Metals & Commodities ────────────────────────────────────────────
  GLD:   'COMMODITY', // SPDR Gold Shares (physical)
  SLV:   'COMMODITY', // iShares Silver Trust (physical)
  USCI:  'COMMODITY', // United States Commodity Index
  DBA:   'COMMODITY', // Invesco DB Agriculture Fund (futures)
  MOO:   'THEMATIC', // VanEck Agribusiness (equity companies)

  // ── Financials & Real Estate ──────────────────────────────────────────────────
  VNQ:   'SECTOR',   // Vanguard Real Estate (broad, like XLRE)
  ITB:   'THEMATIC', // iShares US Home Construction
  XHB:   'THEMATIC', // SPDR S&P Homebuilders
  WTRE:  'THEMATIC', // Pacer Waverly Water

  // ── Health Care & Biotech ─────────────────────────────────────────────────────
  XHE:   'THEMATIC', // SPDR S&P Health Care Equipment
  XBI:   'THEMATIC', // SPDR S&P Biotech
  IHE:   'THEMATIC', // iShares US Pharmaceuticals

  // ── International & Emerging Markets ─────────────────────────────────────────
  EEM:   'INTERNATIONAL', // iShares MSCI Emerging Markets
  IDMO:  'INTERNATIONAL', // Invesco IDEX Momentum
  SPEU:  'INTERNATIONAL', // SPDR Portfolio Europe
  AIA:   'INTERNATIONAL', // iShares Asia 50
  INDA:  'INTERNATIONAL', // iShares MSCI India
  EPI:   'INTERNATIONAL', // WisdomTree India Earnings
  FXI:   'INTERNATIONAL', // iShares China Large-Cap
  YINN:  'INTERNATIONAL', // Direxion Daily FTSE China Bull 3x
  EWJ:   'INTERNATIONAL', // iShares MSCI Japan
  EWY:   'INTERNATIONAL', // iShares MSCI South Korea
  EWC:   'INTERNATIONAL', // iShares MSCI Canada
  FLMX:  'INTERNATIONAL', // Franklin FTSE Mexico
  ARGT:  'INTERNATIONAL', // Global X MSCI Argentina
  EWZ:   'INTERNATIONAL', // iShares MSCI Brazil
  EWP:   'INTERNATIONAL', // iShares MSCI Spain
  GREK:  'INTERNATIONAL', // Global X MSCI Greece
  EIS:   'INTERNATIONAL', // iShares MSCI Israel
  EPU:   'INTERNATIONAL', // iShares MSCI All Peru

  // ── Fixed Income ──────────────────────────────────────────────────────────────
  LQD:   'BOND',     // iShares Investment Grade Corporate Bond
  HYG:   'BOND',     // iShares High Yield Corporate Bond
  SHY:   'BOND',     // iShares 1-3 Year Treasury Bond
  IEF:   'BOND',     // iShares 7-10 Year Treasury Bond
  TLT:   'BOND',     // iShares 20+ Year Treasury Bond
  VTEB:  'BOND',     // Vanguard Tax-Exempt Bond
  MUB:   'BOND',     // iShares National Muni Bond
  PZA:   'BOND',     // Invesco National AMT-Free Muni Bond

  // ── Currencies ────────────────────────────────────────────────────────────────
  UUP:   'CURRENCY', // Invesco DB US Dollar Index Bullish
  UDN:   'CURRENCY', // Invesco DB US Dollar Index Bearish
  FXY:   'CURRENCY', // Invesco CurrencyShares Yen
  FXE:   'CURRENCY', // Invesco CurrencyShares Euro
  FXB:   'CURRENCY', // Invesco CurrencyShares British Pound
  FXF:   'CURRENCY', // Invesco CurrencyShares Swiss Franc
  FXC:   'CURRENCY', // Invesco CurrencyShares Canadian Dollar
  FXA:   'CURRENCY', // Invesco CurrencyShares Australian Dollar

  // ── Cryptocurrency ────────────────────────────────────────────────────────────
  IBIT:  'THEMATIC', // iShares Bitcoin Trust
  BTCO:  'THEMATIC', // Invesco Bitcoin ETF
  XRPC:  'THEMATIC', // XRP ETF
};

/**
 * Returns the asset class for an ETF ticker.
 * Returns null for tickers not in the map (not an ETF, or unclassified new addition).
 * Unclassified ETFs that ARE ETFs (detected via isEtfTicker) should default to THEMATIC.
 */
export function getETFAssetClass(ticker) {
  if (!ticker) return null;
  return ETF_ASSET_CLASS[ticker.toUpperCase()] ?? null;
}

/**
 * Returns true if this ticker is in the known ETF classification map.
 * Use as a routing gate: if true, run computeETFAnalyzeScore().
 * Complement with isEtfTicker() for ETFs added after this file was last updated.
 */
export function isClassifiedETF(ticker) {
  if (!ticker) return false;
  return ticker.toUpperCase() in ETF_ASSET_CLASS;
}

// ─── Macro Alignment: ETF → S&P 500 Sector Benchmark ───────────────────────
// Each ETF is compared against its corresponding S&P 500 sector ETF.
// Logic: is this ETF's price direction (above/below 21 EMA) in sync with its sector benchmark?
// Pure sector ETFs (XLK, XLE, etc.) compare against themselves — always in sync.
// Broad market / factor / international ETFs compare against SPY.
// Bonds, currencies, crypto → null (independent, no sector benchmark).
export const ETF_SECTOR_BENCHMARK = {
  // ── Pure S&P 500 Sector ETFs — compare against themselves ───────────────
  XLK: 'XLK', XLI: 'XLI', XLF: 'XLF', XLV: 'XLV',
  XLY: 'XLY', XLP: 'XLP', XLRE: 'XLRE', XLB: 'XLB',
  XLU: 'XLU', XLC: 'XLC', XLE: 'XLE',

  // ── Real Estate ─────────────────────────────────────────────────────────
  VNQ:  'XLRE',

  // ── Technology & Innovation → XLK ───────────────────────────────────────
  MAGS: 'XLK', IETC: 'XLK', SMH:  'XLK', XSD:  'XLK', SOXX: 'XLK',
  VGT:  'XLK', IGV:  'XLK', AIQ:  'XLK', ARTY: 'XLK', CHAT: 'XLK',
  QTUM: 'XLK', HACK: 'XLK', CLOU: 'XLK', DTCR: 'XLK',
  BLOK: 'XLK', BKCH: 'XLK', FITE: 'XLK', BOTZ: 'XLK', ROBO: 'XLK',

  // ── Communication Services → XLC ────────────────────────────────────────
  SOCL: 'XLC', XTL: 'XLC',

  // ── Industrials → XLI ───────────────────────────────────────────────────
  XAR:  'XLI', ITA:  'XLI', ARKX: 'XLI', JEDI: 'XLI',
  PAVE: 'XLI', JETS: 'XLI', IGF:  'XLI',

  // ── Energy → XLE ────────────────────────────────────────────────────────
  XOP:  'XLE', OIH:  'XLE', USAI: 'XLE', LNGX: 'XLE',
  RSHO: 'XLE', USO:  'XLE', UNG:  'XLE',

  // ── Utilities → XLU ─────────────────────────────────────────────────────
  NUKZ: 'XLU', POWR: 'XLU', GRID: 'XLU', WTRE: 'XLU',

  // ── Materials → XLB ─────────────────────────────────────────────────────
  XME:  'XLB', PICK: 'XLB', REMX: 'XLB', GDX:  'XLB',
  SIL:  'XLB', SLVP: 'XLB', COPJ: 'XLB', COPX: 'XLB',
  SLX:  'XLB', URA:  'XLB', LIT:  'XLB', SETM: 'XLB',
  IBAT: 'XLB', GLD:  'XLB', SLV:  'XLB', USCI: 'XLB', DBA: 'XLB',

  // ── Health Care → XLV ───────────────────────────────────────────────────
  XHE:  'XLV', XBI:  'XLV', IHE:  'XLV',

  // ── Consumer Discretionary → XLY ────────────────────────────────────────
  ITB:  'XLY', XHB:  'XLY',

  // ── Consumer Staples → XLP ──────────────────────────────────────────────
  MOO:  'XLP',

  // ── Broad market / factor / international → SPY ─────────────────────────
  SPY:  'SPY', VOO:  'SPY', RSP:  'SPY', ONEQ: 'SPY', QQQ:  'SPY',
  NYA:  'SPY', DIA:  'SPY', VTI:  'SPY', IWB:  'SPY', IWV:  'SPY',
  IWM:  'SPY', IJR:  'SPY', TOPT: 'SPY', IJH:  'SPY', FRTY: 'SPY',
  SPMO: 'SPY', XMMO: 'SPY', QUAL: 'SPY', MGK:  'SPY', VUG:  'SPY',
  SCHG: 'SPY', QQQM: 'SPY', SCHD: 'SPY', VIG:  'SPY', DGRO: 'SPY',
  NOBL: 'SPY', USMV: 'SPY', VYM:  'SPY', NANC: 'SPY',
  // International
  EEM:  'SPY', IDMO: 'SPY', SPEU: 'SPY', AIA:  'SPY', INDA: 'SPY',
  EPI:  'SPY', FXI:  'SPY', YINN: 'SPY', EWJ:  'SPY', EWY:  'SPY',
  EWC:  'SPY', FLMX: 'SPY', ARGT: 'SPY', EWZ:  'SPY', EWP:  'SPY',
  GREK: 'SPY', EIS:  'SPY', EPU:  'SPY',

  // ── Independent assets — no sector benchmark ────────────────────────────
  // Bonds
  LQD: null, HYG: null, SHY: null, IEF: null, TLT:  null,
  VTEB: null, MUB: null, PZA: null,
  // Currencies
  UUP: null, UDN: null, FXY: null, FXE: null, FXB:  null,
  FXF: null, FXC: null, FXA: null,
  // Crypto
  IBIT: null, BTCO: null, XRPC: null,
};

// Reverse lookup: sector ETF ticker → key used in context.sectorEma
export const BENCHMARK_TO_SECTOR_KEY = {
  XLK:  'Technology',
  XLV:  'Healthcare',
  XLF:  'Financial Services',
  XLI:  'Industrials',
  XLP:  'Consumer Staples',
  XLY:  'Consumer Discretionary',
  XLE:  'Energy',
  XLU:  'Utilities',
  XLB:  'Basic Materials',
  XLC:  'Communication Services',
  XLRE: 'Real Estate',
};
