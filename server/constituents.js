import dotenv from 'dotenv';
import { getSupplementalStocks } from './database.js';
dotenv.config();

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';

// Target universe size (before S&P 400 leaders are added by getJungleStocks)
// getJungleStocks adds 80 S&P 400 longs + 80 S&P 400 shorts = 160
// So the base (sp517) should target 679 - 160 = 519 tickers
const BASE_TARGET = 519;

// Fetch constituent list from FMP
async function fetchConstituents(endpoint) {
  try {
    const url = `${FMP_BASE_URL}${endpoint}?apikey=${FMP_API_KEY}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`FMP API error: ${response.status}`);
    }

    const data = await response.json();
    return data.map(item => item.symbol);
  } catch (error) {
    console.error(`Error fetching constituents from ${endpoint}:`, error.message);
    return [];
  }
}

// Weekly cache for constituent lists — keyed by last Friday's date so it auto-refreshes each week
const constituentCache = { weekKey: null, allTickers: null, dow30: null, sp500: null, nasdaq100: null, sp400Fill: null };

function getWeekKey() {
  const today = new Date();
  const day = today.getDay(); // 0=Sun … 6=Sat
  const daysToLastFriday = day === 5 ? 0 : (day + 2) % 7;
  const lastFriday = new Date(today);
  lastFriday.setDate(today.getDate() - daysToLastFriday);
  return lastFriday.toISOString().split('T')[0];
}

function isCacheValid() {
  return constituentCache.weekKey === getWeekKey();
}

// Legacy hardcoded fallback — ONLY used if FMP API fails for all constituent endpoints
// This ensures the system never runs with zero stocks
const FALLBACK_SUPPLEMENTS = [
  "AA", "ADI", "ADM", "AKAM", "ALB", "ALGN", "AMAT", "AMCR", "AOS", "ARM", "ASML",
  "BAC", "BALL", "BDX", "BG", "BKR", "CAG", "CARR", "CAT",
  "CF", "CHD", "CHTR", "CIEN", "CL", "CLX", "CMI", "COP", "COST", "CTRA", "CVX",
  "DD", "DE", "DG", "DGX", "DHI", "DLR", "DOV", "DOW", "DRI", "DVA", "DVN",
  "ECL", "ED", "EOG", "EQIX", "ETN", "EVRG", "FAST", "FCX", "FDX", "GEV",
  "GILD", "GLW", "GNRC", "GOOGL", "GPC", "HAL", "HAS", "HCA", "HII", "HON", "HSY",
  "HUBB", "HWM", "IBKR", "IEX", "IFF", "INTC", "IP", "IRM", "ITW", "JBHT", "JCI",
  "JNJ", "KEYS", "KLAC", "KMI", "KR", "LEN", "LHX", "LII", "LMT", "LOW", "LRCX",
  "LUV", "LW", "LYB", "MAR", "MAS", "MCHP", "MDLZ", "MO", "MOS", "MPC", "MPWR",
  "MRK", "MRNA", "MSI", "MU", "NDSN", "NEE", "NEM", "NOC", "NOV",
  "O", "ODFL", "OKE", "ON", "PCAR", "PEP", "PH", "PHM", "PKG", "PM", "POOL", "PPG",
  "PSX", "PWR", "RCL", "SCCO", "SLB", "STX", "SWK",
  "SYY", "T", "TAP", "TDY", "TER", "TGT", "TPL", "TRGP", "TT", "TXN", "UEC",
  "UPS", "VLO", "VMC", "VTRS", "VZ", "WAB", "WDC", "WMB", "WMT", "WSM", "XOM"
];

// Tickers to exclude from the universe (e.g. going private, data quality issues)
const EXCLUDED_TICKERS = new Set(["EA"]);

// Populate the weekly cache — dynamically builds the universe from index constituents
// If the S&P 500 + NASDAQ 100 + Dow 30 don't reach BASE_TARGET, fills the gap from S&P 400
async function refreshConstituentCache() {
  const weekKey = getWeekKey();
  console.log(`📋 Refreshing constituent cache for week of ${weekKey}...`);

  const [sp500, nasdaq100, dow30, sp400, userSupplemental] = await Promise.all([
    fetchConstituents('/sp500_constituent'),
    fetchConstituents('/nasdaq_constituent'),
    fetchConstituents('/dowjones_constituent'),
    fetchConstituents('/sp400_constituent'),
    getSupplementalStocks(),
  ]);

  console.log(`Fetched: ${sp500.length} S&P 500, ${nasdaq100.length} Nasdaq 100, ${dow30.length} Dow 30, ${sp400.length} S&P 400`);

  // Step 1: Merge the 3 major indices (deduplicated)
  const indexTickers = [...new Set([...sp500, ...nasdaq100, ...dow30, ...userSupplemental])]
    .filter(t => !EXCLUDED_TICKERS.has(t));

  console.log(`📋 Index union: ${indexTickers.length} unique tickers from S&P 500 + NASDAQ 100 + Dow 30`);

  // Step 2: If we're short of BASE_TARGET, fill from S&P 400 mid-caps
  let sp400Fill = [];
  const deficit = BASE_TARGET - indexTickers.length;
  if (deficit > 0 && sp400.length > 0) {
    const indexSet = new Set(indexTickers);
    // S&P 400 stocks not already in the index union
    const sp400Candidates = sp400.filter(t => !indexSet.has(t) && !EXCLUDED_TICKERS.has(t));
    sp400Fill = sp400Candidates.slice(0, deficit);
    console.log(`📋 Filling ${sp400Fill.length} S&P 400 mid-cap stocks to reach ${BASE_TARGET} base target (deficit was ${deficit})`);
  } else if (deficit > 0 && sp400.length === 0) {
    // FMP S&P 400 API failed — use legacy fallback to fill gaps
    const indexSet = new Set(indexTickers);
    sp400Fill = FALLBACK_SUPPLEMENTS.filter(t => !indexSet.has(t) && !EXCLUDED_TICKERS.has(t)).slice(0, deficit);
    console.log(`📋 S&P 400 API unavailable — using ${sp400Fill.length} fallback supplements to fill deficit of ${deficit}`);
  } else {
    console.log(`📋 No deficit — ${indexTickers.length} index tickers already meet/exceed ${BASE_TARGET} target`);
  }

  const allTickers = [...indexTickers, ...sp400Fill];

  constituentCache.weekKey    = weekKey;
  constituentCache.allTickers = allTickers;
  constituentCache.dow30      = dow30;
  constituentCache.sp500      = sp500;
  constituentCache.nasdaq100  = nasdaq100;
  constituentCache.sp400Fill  = sp400Fill;

  console.log(`📋 Constituent cache set (${allTickers.length} unique tickers, ${sp400Fill.length} from S&P 400 fill, valid until next Friday)`);
}

// Get all unique tickers from S&P 500, NASDAQ 100, Dow 30, and dynamic S&P 400 fill
export async function getAllTickers() {
  if (!isCacheValid()) await refreshConstituentCache();
  return constituentCache.allTickers;
}

// Get Dow 30 tickers (for tagging in Jungle universe)
export async function getDow30Tickers() {
  if (!isCacheValid()) await refreshConstituentCache();
  return constituentCache.dow30;
}

// Get S&P 500 tickers (for tagging in Jungle universe)
export async function getSp500Tickers() {
  if (!isCacheValid()) await refreshConstituentCache();
  return constituentCache.sp500;
}

// Get Nasdaq 100 tickers
export async function getNasdaq100Tickers() {
  if (!isCacheValid()) await refreshConstituentCache();
  return constituentCache.nasdaq100;
}
