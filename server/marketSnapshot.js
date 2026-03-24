// server/marketSnapshot.js
// ── Shared market + sector snapshot helper ─────────────────────────────────────
//
// Called at both CONFIRM ENTRY and RECORD EXIT so every journal entry has
// consistent market context without each service reinventing FMP fetching.
// ─────────────────────────────────────────────────────────────────────────────

const FMP_BASE = 'https://financialmodelingprep.com/api/v3';
const TIMEOUT_MS = 6000;

export const SECTOR_ETF = {
  'Technology':             'XLK',
  'Healthcare':             'XLV',
  'Financial Services':     'XLF',
  'Industrials':            'XLI',
  'Consumer Staples':       'XLP',
  'Energy':                 'XLE',
  'Utilities':              'XLU',
  'Basic Materials':        'XLB',
  'Communication Services': 'XLC',
  'Real Estate':            'XLRE',
  'Consumer Cyclical':      'XLY',
  'Consumer Discretionary': 'XLY',
};

export function getSectorEtf(sectorName) {
  return SECTOR_ETF[sectorName] || null;
}

/**
 * Fetch a market snapshot: SPY, QQQ, VIX prices, SPY/QQQ EMA21 separation,
 * derived regime, and optionally a sector ETF quote.
 *
 * All FMP calls run in parallel; any individual failure returns null for that
 * field rather than throwing — the caller always gets a (possibly sparse) object.
 *
 * @param {string|null} sectorName  e.g. "Communication Services" → fetches XLC
 * @returns {Promise<object>}
 */
export async function fetchMarketSnapshot(sectorName = null) {
  const key = process.env.FMP_API_KEY;
  if (!key) return {};

  const etf    = sectorName ? getSectorEtf(sectorName) : null;
  const tickers = ['SPY', 'QQQ', '%5EVIX', etf].filter(Boolean).join(',');

  const get = (url) =>
    fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      .then(r => r.ok ? r.json() : [])
      .catch(() => []);

  const [quotes, spyEmaData, qqqEmaData] = await Promise.all([
    get(`${FMP_BASE}/quote/${tickers}?apikey=${key}`),
    get(`${FMP_BASE}/technical_indicator/1day/SPY?type=ema&period=21&limit=1&apikey=${key}`),
    get(`${FMP_BASE}/technical_indicator/1day/QQQ?type=ema&period=21&limit=1&apikey=${key}`),
  ]);

  const snap = {};

  // ── Parse quotes ────────────────────────────────────────────────────────────
  for (const q of (Array.isArray(quotes) ? quotes : [])) {
    if (q.symbol === 'SPY') {
      snap.spyPrice    = q.price;
      snap.spyChange1D = q.changesPercentage != null ? +q.changesPercentage.toFixed(2) : null;
    }
    if (q.symbol === 'QQQ') {
      snap.qqqPrice    = q.price;
      snap.qqqChange1D = q.changesPercentage != null ? +q.changesPercentage.toFixed(2) : null;
    }
    if (q.symbol === '^VIX') snap.vix = q.price;
    if (etf && q.symbol === etf) {
      snap.sectorEtf      = etf;
      snap.sectorPrice    = q.price;
      snap.sectorChange1D = q.changesPercentage != null ? +q.changesPercentage.toFixed(2) : null;
    }
  }

  // ── SPY EMA21 separation ────────────────────────────────────────────────────
  const spyEma = spyEmaData?.[0]?.ema;
  if (spyEma && snap.spyPrice) {
    snap.spyEma21    = +Number(spyEma).toFixed(4);
    snap.spyVsEma    = +((snap.spyPrice - snap.spyEma21) / snap.spyEma21 * 100).toFixed(2);
    snap.spyPosition = snap.spyPrice > snap.spyEma21 ? 'above' : 'below';
  }

  // ── QQQ EMA21 separation ────────────────────────────────────────────────────
  const qqqEma = qqqEmaData?.[0]?.ema;
  if (qqqEma && snap.qqqPrice) {
    snap.qqqEma21    = +Number(qqqEma).toFixed(4);
    snap.qqqVsEma    = +((snap.qqqPrice - snap.qqqEma21) / snap.qqqEma21 * 100).toFixed(2);
    snap.qqqPosition = snap.qqqPrice > snap.qqqEma21 ? 'above' : 'below';
  }

  // ── Regime: derived from SPY + QQQ vs EMA ──────────────────────────────────
  if (snap.spyPosition && snap.qqqPosition) {
    snap.regime =
      snap.spyPosition === 'above' && snap.qqqPosition === 'above' ? 'BULLISH' :
      snap.spyPosition === 'below' && snap.qqqPosition === 'below' ? 'BEARISH' : 'MIXED';
  } else if (snap.spyPosition) {
    snap.regime = snap.spyPosition === 'above' ? 'BULLISH' : 'BEARISH';
  }

  return snap;
}
