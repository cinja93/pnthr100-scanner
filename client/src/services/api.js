// In dev: use relative URL so Vite proxy hits local server. In production: use deployed API URL.
const API_BASE = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? '' : 'http://localhost:3000');

// JWT token — set once after login via setAuthToken()
let _token = null;
export function setAuthToken(token) { _token = token; }
export function clearAuthToken() { _token = null; }

// Base headers included on every request
function authHeaders(extra = {}) {
  return {
    ...(_token ? { 'Authorization': `Bearer ${_token}` } : {}),
    ...extra
  };
}

// ── Auth ──

export async function fetchUserProfile() {
  const response = await fetch(`${API_BASE}/api/user/profile`, { headers: authHeaders() });
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return response.json();
}

export async function updateUserProfile(updates) {
  const response = await fetch(`${API_BASE}/api/user/profile`, {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(updates),
  });
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return response.json();
}

export async function fetchTopStocks(forceRefresh = false) {
  try {
    const params = forceRefresh ? `?refresh=1&_=${Date.now()}` : '';
    const response = await fetch(`${API_BASE}/api/stocks${params}`, { headers: authHeaders() });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
  } catch (error) {
    console.error('Error fetching stocks:', error);
    throw error;
  }
}

// Short scan: bottom 100 by YTD (shorting opportunities)
export async function fetchShortStocks(forceRefresh = false) {
  try {
    const params = forceRefresh ? `?refresh=1&_=${Date.now()}` : '';
    const response = await fetch(`${API_BASE}/api/stocks/shorts${params}`, { headers: authHeaders() });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
  } catch (error) {
    console.error('Error fetching short stocks:', error);
    throw error;
  }
}

// Fetch list of available historical rankings (last 12 weeks)
export async function fetchAvailableDates() {
  try {
    const response = await fetch(`${API_BASE}/api/rankings`, { headers: authHeaders() });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
  } catch (error) {
    console.error('Error fetching available dates:', error);
    throw error;
  }
}

// Fetch full ranking for a date (includes rankings + shortRankings when available)
export async function fetchRankingByDate(date) {
  try {
    const response = await fetch(`${API_BASE}/api/rankings/${date}`, { headers: authHeaders() });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
  } catch (error) {
    console.error('Error fetching ranking by date:', error);
    throw error;
  }
}

// Fetch latest laser signals for a list of tickers (from mobile app DB, read-only).
// shortList: true = compute stop prices for short-scan tickers that have no laser signal (2-week high + $0.01).
export async function fetchSignals(tickers, options = {}) {
  try {
    const { shortList = false } = options;
    const response = await fetch(`${API_BASE}/api/signals`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ tickers, shortList })
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
  } catch (error) {
    console.error('Error fetching signals:', error);
    return {};
  }
}

// Fetch daily OHLCV history for charting
export async function fetchChartData(ticker) {
  try {
    const response = await fetch(`${API_BASE}/api/chart/${ticker}`, { headers: authHeaders() });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
  } catch (error) {
    console.error('Error fetching chart data:', error);
    throw error;
  }
}

// Fetch stock's 12-week ranking history
export async function fetchStockHistory(ticker) {
  try {
    const response = await fetch(`${API_BASE}/api/stock-history/${ticker}`, { headers: authHeaders() });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
  } catch (error) {
    console.error('Error fetching stock history:', error);
    throw error;
  }
}

// ── Watchlist ──

export async function fetchWatchlist() {
  const response = await fetch(`${API_BASE}/api/watchlist`, { headers: authHeaders() });
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return response.json();
}

export async function addWatchlistTicker(ticker) {
  const response = await fetch(`${API_BASE}/api/watchlist`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ ticker }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Failed to add ticker');
  return data;
}

export async function removeWatchlistTicker(ticker) {
  const response = await fetch(`${API_BASE}/api/watchlist/${ticker}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || 'Failed to remove ticker');
  }
  return response.json();
}

// ── Portfolio ──

export async function fetchPortfolio() {
  const response = await fetch(`${API_BASE}/api/portfolio`, { headers: authHeaders() });
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return response.json();
}

export async function fetchPortfolioTicker(ticker) {
  const response = await fetch(`${API_BASE}/api/portfolio/ticker/${ticker}`, { headers: authHeaders() });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Ticker ${ticker} not found`);
  }
  return response.json();
}

export async function optimizePortfolio(accountSize, tickers) {
  const response = await fetch(`${API_BASE}/api/portfolio/optimize`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ accountSize, tickers }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP error! status: ${response.status}`);
  return data;
}

// EMA Crossover scan: returns { stocks: [...], signals: {...} }
// Universe: top 100 long + top 100 short. Cached 60 min server-side; pass forceRefresh=true to bust cache.
export async function fetchEmaCrossoverStocks(forceRefresh = false) {
  const qs = forceRefresh ? '?refresh=1' : '';
  const response = await fetch(`${API_BASE}/api/stocks/ema-crossover${qs}`, { headers: authHeaders() });
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return response.json();
}

// Fetch the first date each ticker appeared in the long or short top-100 list.
// Returns { TICKER: { date: 'YYYY-MM-DD', list: 'LONG' | 'SHORT' }, ... }
export async function fetchEntryDates(tickers) {
  try {
    const response = await fetch(`${API_BASE}/api/entry-dates`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ tickers }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } catch (error) {
    console.error('Error fetching entry dates:', error);
    return {};
  }
}

// ETF scan: top 100 US ETFs by YTD return with signals. Cached 60 min; pass forceRefresh=true to bust.
export async function fetchEtfStocks(forceRefresh = false) {
  const qs = forceRefresh ? '?refresh=1' : '';
  const response = await fetch(`${API_BASE}/api/stocks/etfs${qs}`, { headers: authHeaders() });
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return response.json();
}

// Fetch next earnings date for a list of tickers.
// Returns { TICKER: 'YYYY-MM-DD' } for tickers with upcoming earnings (next 3 months).
export async function fetchEarnings(tickers) {
  if (!tickers || tickers.length === 0) return {};
  try {
    const qs = encodeURIComponent(tickers.join(','));
    const response = await fetch(`${API_BASE}/api/earnings?tickers=${qs}`, { headers: authHeaders() });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
  } catch (error) {
    console.error('Error fetching earnings:', error);
    return {};
  }
}

// Fetch the most-recent-week scanner rank for every ticker in the long + short lists.
// Returns { TICKER: { rank: N, list: 'LONG'|'SHORT' } }
export async function fetchScannerRanks() {
  try {
    const response = await fetch(`${API_BASE}/api/scanner-ranks`, { headers: authHeaders() });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
  } catch (error) {
    console.error('Error fetching scanner ranks:', error);
    return {};
  }
}

// Fetch stocks in a given sector (by sector key, e.g. 'informationTechnology')
export async function fetchSectorStocks(sectorKey) {
  const response = await fetch(`${API_BASE}/api/sector-stocks/${sectorKey}`, { headers: authHeaders() });
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return response.json();
}

// Fetch sector performance data (11 sectors, weekly cumulative % return, 12-month rolling)
export async function fetchSectorData() {
  try {
    const response = await fetch(`${API_BASE}/api/sectors`, { headers: authHeaders() });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
  } catch (error) {
    console.error('Error fetching sector data:', error);
    throw error;
  }
}
