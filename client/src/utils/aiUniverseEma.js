// client/src/utils/aiUniverseEma.js
// Lightweight client-side lookup for AI Universe ticker EMA periods.
// Mirrors server/data/pnthrAiSectorsConfig.js sector EMA assignments.
//
// Default AI sector period is 30W. Only non-default tickers listed below.
// Carnivore tickers (26) use GICS OpEMA via getCarnivoreEmaPeriod() — handled
// separately by strategyMode.js, not this file.

import { isCarnivoreMode, getCarnivoreEmaPeriod } from './strategyMode';

// 36W sectors: Data Infrastructure, Enterprise SaaS, Edge Infrastructure
const EMA_36 = new Set([
  'EQIX','DLR','IRM','CRWV','NBIS','IREN','APLD','CORZ','WULF','MARA',
  'HUT','CIFR','HIVE','BITF','NET','NTNX','AKAM','AMT','CCI',
  'PLTR','SNOW','MDB','DDOG','APP','DUOL','CRM','NOW','ADBE','GTLB',
  'ESTC','PEGA','MNDY','INTU','WDAY','DT','DOCN','HUBS','BSY','PTC',
  'ROP','FICO','VRSK','MANH','VEEV','U','RBLX','TTWO','EA','TYL',
  'PINS','ALRM','SOUN','CDW',
]);

// 40W sector: AI Biotech
const EMA_40 = new Set([
  'TEM','RXRX','SDGR','ABCL','ILMN','PACB','TWST','GH','NTLA','NTRA',
  'TXG','ARCT','MASS','NRIX',
]);

// All AI Universe tickers (298 total)
const ALL_AI = new Set([
  // 30W tickers
  'NVDA','AMD','AVGO','TSM','ARM','INTC','QCOM','MRVL','SMCI','MU',
  'NXPI','TXN','ON','STM','ASML','AMAT','KLAC','LRCX','TER','CAMT',
  'ACLS','MKSI','CDNS','SNPS','IPGP','LASR','DELL','HPE','CLS','FLEX',
  'JBL','OLED','WDC','SNDK','PSTG','STX','NTAP','MPWR','ENTG','WOLF',
  'NVTS','AMBA','LSCC','ONTO','KLIC','FORM','KEYS','AEHR','SITM','PI',
  'MXL','GEV','CEG','VST','TLN','NEE','SRE','CWEN','AES','CCJ',
  'OKLO','BE','SMR','NNE','ETN','PWR','D','HUBB','GNRC','POWL',
  'STRL','MTZ','PRIM','CMI','WCC','ENPH','FLNC','STEM','PLUG','EVGO',
  'CHPT','BLNK','EQT','KMI','WMB','TRGP','OKE','LNG','ANET','CSCO',
  'COHR','LITE','FN','CRDO','ALAB','AAOI','MTSI','CIEN','VIAV','GLW',
  'APH','TEL','VICR','POET','FFIV',
  'TSLA','ISRG','SYM','SERV','PATH','ARBE','CGNX','AUR','MBLY','OUST',
  'JOBY','ACHR','EH','APTV','MGA','GNTX','AEVA','INVZ','LIDR','HSAI',
  'ZBRA','PONY','WRD','NIO','LI','XPEV',
  'MSFT','GOOGL','META','AMZN','ORCL','IBM',
  'PANW','CRWD','ZS','FTNT','S','RBRK','OKTA','VRNS','TENB','RPD',
  'QLYS','TTD','RDDT','DV','MGNI','PUBM','CRTO',
  'UPST','LMND','AFRM','SOFI','HOOD','BILL','TWLO','ZM','DOCU','DBX',
  'BOX','WIX','GLBE','TOST','Z','OPEN','CSGP',
  'RKLB','ASTS','PL','LUNR','RDW','SATS','AVAV','ONDS',
  'HON','OSK','BAH','KTOS','LDOS','TRMB','MRCY','IRDM','LMT','RTX',
  'NOC','GD','SAIC','CACI','PSN','RCAT','DPRO','HEI','TDG','CW',
  'TXT','BBAI','HAWK',
  'BABA','BIDU','MELI','CPNG','GRAB','NU','SE',
  'IONQ','RGTI','QBTS','QUBT','ARQQ','LAES',
  'VRT','TT','JCI','AMKR','ASX','NVT','ROK','EMR','CARR','NNDM',
  'MTLS','SSYS','DDD','MP','ALB','FCX',
  // 36W tickers
  ...EMA_36,
  // 40W tickers
  ...EMA_40,
]);

/**
 * Returns true if the ticker is in the AI 300 universe.
 */
export function isAiUniverseTicker(ticker) {
  return ALL_AI.has(ticker);
}

/**
 * Returns the correct EMA period for any ticker, strategy-aware:
 *   - Carnivore tickers → GICS OpEMA (18-26W)
 *   - AI 300 tickers    → AI sector EMA (30/36/40W)
 *   - 679-only tickers  → null (caller should use getSectorEmaPeriod)
 */
export function getAiAwareEmaPeriod(ticker) {
  if (isCarnivoreMode(ticker)) return getCarnivoreEmaPeriod(ticker);
  if (EMA_40.has(ticker)) return 40;
  if (EMA_36.has(ticker)) return 36;
  if (ALL_AI.has(ticker)) return 30;
  return null; // not AI universe — caller uses GICS getSectorEmaPeriod
}

/**
 * Returns the correct gate offset for any ticker:
 *   - Carnivore tickers → 0.10 (1.10× gate, 679 rules)
 *   - AI 300 tickers    → 0.25 (1.25× gate, AI rules)
 *   - 679-only tickers  → null (caller uses default 0.10)
 */
export function getAiAwareGateOffset(ticker) {
  if (isCarnivoreMode(ticker)) return 0.10;
  if (ALL_AI.has(ticker)) return 0.25;
  return null;
}
