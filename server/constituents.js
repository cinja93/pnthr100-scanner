import dotenv from 'dotenv';
import { getSupplementalStocks } from './database.js';
dotenv.config();

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';

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
const constituentCache = { weekKey: null, allTickers: null, dow30: null, sp500: null, nasdaq100: null };

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

// Supplemental stocks - extracted from user's manual PNTHR 100 list
// These fill gaps in FMP's constituent lists (stocks that should be in S&P 500/NASDAQ/DOW but are missing)
const SUPPLEMENTAL_STOCKS = [
  "AA", "ADI", "ADM", "AKAM", "ALB", "ALGN", "AMAT", "AMCR", "AOS", "ARM", "ASML",
  "BAC", "BALL", "BDX", "BF.B", "BG", "BKR", "BPTRX", "BTU", "CAG", "CARR", "CAT",
  "CF", "CHD", "CHTR", "CIEN", "CL", "CLX", "CMI", "COP", "COST", "CTRA", "CVX",
  "DAN", "DD", "DE", "DG", "DGX", "DHI", "DLR", "DOV", "DOW", "DRI", "DVA", "DVN",
  "DXYZ", "ECL", "ED", "EOG", "EQIX", "ETN", "EVRG", "FAST", "FCX", "FDX", "GEV",
  "GILD", "GLW", "GNRC", "GOOGL", "GPC", "HAL", "HAS", "HCA", "HII", "HON", "HSY",
  "HUBB", "HWM", "IBKR", "IEX", "IFF", "INTC", "IP", "IRM", "ITW", "JBHT", "JCI",
  "JNJ", "KEYS", "KLAC", "KMI", "KR", "LEN", "LHX", "LII", "LMT", "LOW", "LRCX",
  "LUV", "LW", "LYB", "MAR", "MAS", "MCHP", "MDLZ", "MO", "MOS", "MPC", "MPWR",
  "MRK", "MRNA", "MSI", "MU", "MUX", "NDSN", "NEE", "NEM", "NEOG", "NOC", "NOV",
  "O", "ODFL", "OKE", "ON", "PCAR", "PEP", "PH", "PHM", "PKG", "PM", "POOL", "PPG",
  "PSX", "PWR", "Q", "RCL", "SATS", "SCCO", "SLB", "SNDK", "STX", "SW", "SWK",
  "SYY", "T", "TAP", "TDY", "TER", "TGT", "TNK", "TPL", "TRGP", "TT", "TXN", "UEC",
  "UPS", "VLO", "VMC", "VTRS", "VZ", "WAB", "WDC", "WMB", "WMT", "WSM", "XOM"
];

// Populate the weekly cache — fetches all three lists in one shot so they share a single cache refresh
async function refreshConstituentCache() {
  const weekKey = getWeekKey();
  console.log(`📋 Refreshing constituent cache for week of ${weekKey}...`);

  const [sp500, nasdaq100, dow30, userSupplemental] = await Promise.all([
    fetchConstituents('/sp500_constituent'),
    fetchConstituents('/nasdaq_constituent'),
    fetchConstituents('/dowjones_constituent'),
    getSupplementalStocks(),
  ]);

  console.log(`Fetched: ${sp500.length} S&P 500, ${nasdaq100.length} Nasdaq 100, ${dow30.length} Dow 30`);

  const allTickers = [...new Set([...sp500, ...nasdaq100, ...dow30, ...SUPPLEMENTAL_STOCKS, ...userSupplemental])];
  constituentCache.weekKey    = weekKey;
  constituentCache.allTickers = allTickers;
  constituentCache.dow30      = dow30;
  constituentCache.sp500      = sp500;
  constituentCache.nasdaq100  = nasdaq100;

  console.log(`📋 Constituent cache set (${allTickers.length} unique tickers, valid until next Friday)`);
}

// Get all unique tickers from S&P 500, NASDAQ 100, and Dow 30
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
