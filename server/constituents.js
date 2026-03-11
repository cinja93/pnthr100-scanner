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

// Get all unique tickers from S&P 500, NASDAQ 100, and Dow 30
export async function getAllTickers() {
  try {
    console.log('Fetching complete constituent lists from FMP...');

    // Fetch FMP lists and user-added supplemental stocks in parallel
    const [sp500, nasdaq100, dow30, userSupplemental] = await Promise.all([
      fetchConstituents('/sp500_constituent'),
      fetchConstituents('/nasdaq_constituent'),
      fetchConstituents('/dowjones_constituent'),
      getSupplementalStocks()
    ]);

    console.log(`Fetched: ${sp500.length} S&P 500 stocks, ${nasdaq100.length} NASDAQ 100 stocks, ${dow30.length} Dow 30 stocks`);
    console.log(`Supplemental: ${SUPPLEMENTAL_STOCKS.length} hardcoded + ${userSupplemental.length} user-added`);

    // Combine FMP lists with both hardcoded and user-added supplemental stocks
    const allTickers = [...sp500, ...nasdaq100, ...dow30, ...SUPPLEMENTAL_STOCKS, ...userSupplemental];
    const uniqueTickers = [...new Set(allTickers)];

    console.log(`Total unique tickers: ${uniqueTickers.length}`);
    return uniqueTickers;

  } catch (error) {
    console.error('Error fetching constituent lists:', error);
    throw error;
  }
}

// Get Dow 30 tickers (for tagging in Jungle universe)
export async function getDow30Tickers() {
  try {
    return await fetchConstituents('/dowjones_constituent');
  } catch (error) {
    console.error('Error fetching Dow 30 tickers:', error);
    return [];
  }
}
