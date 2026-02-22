// In dev: use relative URL so Vite proxy hits local server. In production: use deployed API URL.
const API_BASE = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? '' : 'http://localhost:3000');

// Base headers included on every request
function authHeaders(extra = {}) {
  return {
    'x-api-key': import.meta.env.VITE_API_KEY,
    ...extra
  };
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

// Fetch latest laser signals for a list of tickers (from mobile app DB, read-only)
export async function fetchSignals(tickers) {
  try {
    const response = await fetch(`${API_BASE}/api/signals`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ tickers })
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
