// In dev: use relative URL so Vite proxy hits local server. In production: use deployed API URL.
export const API_BASE = import.meta.env.DEV ? '' : (import.meta.env.VITE_API_URL || '');

// JWT token — set once after login via setAuthToken()
let _token = null;
export function setAuthToken(token) { _token = token; }
export function clearAuthToken() { _token = null; }

// Base headers included on every request
export function authHeaders(extra = {}) {
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

// Fetch PNTHR EMA-derived signals (BL/SS) for a list of tickers.
// shortList: true = compute proxy stop prices for short-scan tickers with no signal.
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

// Fetch legacy Laser signals from MongoDB (for side-by-side comparison).
export async function fetchLaserSignals(tickers, options = {}) {
  try {
    const { shortList = false } = options;
    const response = await fetch(`${API_BASE}/api/laser-signals`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ tickers, shortList })
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
  } catch (error) {
    console.error('Error fetching laser signals:', error);
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

export async function fetchStockSearch(ticker) {
  const response = await fetch(`${API_BASE}/api/stocks/search?ticker=${encodeURIComponent(ticker)}`, { headers: authHeaders() });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${response.status}`);
  }
  return response.json();
}

export async function fetchAutocompleteSuggestions(query) {
  if (!query || query.length < 1) return [];
  try {
    const response = await fetch(`${API_BASE}/api/search/autocomplete?q=${encodeURIComponent(query)}`, { headers: authHeaders() });
    if (!response.ok) return [];
    return response.json();
  } catch { return []; }
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

// Fetch BL/BE/SS/SE signal counts for all 11 sectors
export async function fetchSectorSignalCounts() {
  const response = await fetch(`${API_BASE}/api/sector-signal-counts`, { headers: authHeaders() });
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return response.json();
}

// Fetch stocks in a given sector (by sector key, e.g. 'informationTechnology')
export async function fetchSectorStocks(sectorKey) {
  const response = await fetch(`${API_BASE}/api/sector-stocks/${sectorKey}`, { headers: authHeaders() });
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return response.json();
}

// Fetch BL/BE/SS/SE signal counts for the 81 speculative longs + 81 speculative shorts
export async function fetchSpeculativeSignalCounts() {
  const response = await fetch(`${API_BASE}/api/speculative-signal-counts`, { headers: authHeaders() });
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return response.json();
}

// Fetch speculative stocks for a given side ('longs' or 'shorts') with live quotes + signals
export async function fetchSpeculativeStocks(side) {
  const response = await fetch(`${API_BASE}/api/speculative-stocks/${side}`, { headers: authHeaders() });
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return response.json();
}

// Fetch PNTHR 679 Jungle: all SP517 + SP400 Long/Short leaders with signals
export async function fetchJungleStocks(forceRefresh = false) {
  const url = `${API_BASE}/api/jungle-stocks${forceRefresh ? '?refresh=1' : ''}`;
  const response = await fetch(url, { headers: authHeaders() });
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return response.json();
}

// Fetch PNTHR PREY results (Alphas, Springs, Dinner)
export async function fetchPreyStocks(forceRefresh = false) {
  const url = `${API_BASE}/api/prey${forceRefresh ? '?refresh=1' : ''}`;
  const response = await fetch(url, { headers: authHeaders() });
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return response.json();
}

// PNTHR Kill — top-10 ranks from Friday pipeline (pre-computed, MongoDB)
export async function fetchKillPipeline() {
  const response = await fetch(`${API_BASE}/api/kill-pipeline`, { headers: authHeaders() });
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return response.json();
}

// PNTHR APEX — scored predatory ranking
export async function fetchApexStocks(forceRefresh = false) {
  const qs = forceRefresh ? '?refresh=1' : '';
  const response = await fetch(`${API_BASE}/api/apex${qs}`, { headers: authHeaders() });
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return response.json();
}

// ── Newsletter (PNTHR's Perch) ──

export async function fetchNewsletterList() {
  const response = await fetch(`${API_BASE}/api/newsletter`, { headers: authHeaders() });
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return response.json();
}

export async function fetchNewsletterIssue(id) {
  const response = await fetch(`${API_BASE}/api/newsletter/${id}`, { headers: authHeaders() });
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return response.json();
}

export async function generateNewsletterIssue(weekOf) {
  const response = await fetch(`${API_BASE}/api/newsletter/generate`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(weekOf ? { weekOf } : {}),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${response.status}`);
  }
  return response.json();
}

export async function saveNewsletterDraft(id, narrative) {
  const response = await fetch(`${API_BASE}/api/newsletter/${id}`, {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ narrative }),
  });
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return response.json();
}

export async function publishNewsletterIssue(id) {
  const response = await fetch(`${API_BASE}/api/newsletter/${id}/publish`, {
    method: 'POST',
    headers: authHeaders(),
  });
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

// ── Signal History (admin only) ───────────────────────────────────────────────

export async function fetchSignalHistoryWeeks() {
  const res = await fetch(`${API_BASE}/api/admin/signal-history/weeks`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchSignalHistoryWeek(weekOf) {
  const res = await fetch(`${API_BASE}/api/admin/signal-history/week/${weekOf}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchSignalHistoryTicker(ticker) {
  const res = await fetch(`${API_BASE}/api/admin/signal-history/ticker/${ticker}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function saveSignalHistorySnapshot() {
  const res = await fetch(`${API_BASE}/api/admin/signal-history/snapshot`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Pending Entries & NAV Settings ────────────────────────────────────────────

export async function fetchNav() {
  const res = await fetch(`${API_BASE}/api/settings/nav`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json(); // { nav: number }
}

export async function saveNav(value) {
  const res = await fetch(`${API_BASE}/api/settings/nav`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ nav: value }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchPendingEntries() {
  const res = await fetch(`${API_BASE}/api/pending-entries`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json(); // array of entry objects
}

export async function createPendingEntries(entries) {
  const res = await fetch(`${API_BASE}/api/pending-entries`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(entries),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function confirmPendingEntry(id, { fillPrice, shares, date, stop }) {
  const res = await fetch(`${API_BASE}/api/pending-entries/${id}/confirm`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ fillPrice, shares, date, stop }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function dismissPendingEntry(id) {
  const res = await fetch(`${API_BASE}/api/pending-entries/${id}/dismiss`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function deletePosition(id) {
  const res = await fetch(`${API_BASE}/api/positions/${id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Signal History Enhancement ─────────────────────────────────────────────────

export async function fetchMarketSnapshots(from, to) {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to)   params.set('to', to);
  const query = params.toString() ? `?${params}` : '';
  const res = await fetch(`${API_BASE}/api/signal-history/market-snapshots${query}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchEnrichedSignals(weekOf) {
  const query = weekOf ? `?weekOf=${weekOf}` : '';
  const res = await fetch(`${API_BASE}/api/signal-history/enriched-signals${query}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchTickerTrajectory(ticker, weeks = 12) {
  const res = await fetch(`${API_BASE}/api/signal-history/enriched-signals/${ticker}/trajectory?weeks=${weeks}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchClosedTrades(filters = {}) {
  const params = new URLSearchParams();
  if (filters.tier)      params.set('tier', filters.tier);
  if (filters.direction) params.set('direction', filters.direction);
  if (filters.sector)    params.set('sector', filters.sector);
  const query = params.toString() ? `?${params}` : '';
  const res = await fetch(`${API_BASE}/api/signal-history/closed-trades${query}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchChangelog() {
  const res = await fetch(`${API_BASE}/api/signal-history/changelog`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function addChangelogEntry(entry) {
  const res = await fetch(`${API_BASE}/api/signal-history/changelog`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(entry),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── PNTHR's Pulse — Mission Control ───────────────────────────────────────────

export async function fetchPulse() {
  const res = await fetch(`${API_BASE}/api/pulse`, { headers: authHeaders() });
  if (!res.ok) {
    let msg = `Pulse API error ${res.status}`;
    try { const body = await res.json(); if (body?.error) msg += `: ${body.error}`; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

export async function fetchSignalStocks(signal) {
  const res = await fetch(`${API_BASE}/api/pulse/signal-stocks?signal=${signal}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Signal stocks error ${res.status}`);
  return res.json();
}

export async function fetchDevelopingSignals() {
  const res = await fetch(`${API_BASE}/api/pulse/developing-signals`, { headers: authHeaders() });
  if (!res.ok) return { status: 'ERROR', bl: [], ss: [] };
  return res.json();
}

export async function fetchLiveVix() {
  const res = await fetch(`${API_BASE}/api/market-data/vix`, { headers: authHeaders() });
  if (!res.ok) return { close: null, change: null };
  return res.json();
}

// ── Journal ───────────────────────────────────────────────────────────────────

export async function fetchJournal(filters = {}) {
  const params = new URLSearchParams();
  if (filters.status)    params.set('status', filters.status);
  if (filters.direction) params.set('direction', filters.direction);
  if (filters.ticker)    params.set('ticker', filters.ticker);
  const query = params.toString() ? `?${params}` : '';
  const res = await fetch(`${API_BASE}/api/journal${query}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchJournalEntry(id) {
  const res = await fetch(`${API_BASE}/api/journal/${id}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchJournalAnalytics() {
  const res = await fetch(`${API_BASE}/api/journal/analytics`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchWeeklyReviews() {
  const res = await fetch(`${API_BASE}/api/journal/weekly-reviews`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function saveWeeklyReview(review) {
  const res = await fetch(`${API_BASE}/api/journal/weekly-reviews`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(review),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function addJournalNote(journalId, text) {
  const res = await fetch(`${API_BASE}/api/journal/${journalId}/notes`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function deleteJournalNote(journalId, noteId) {
  const res = await fetch(`${API_BASE}/api/journal/${journalId}/notes/${noteId}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function addJournalTag(journalId, tag) {
  const res = await fetch(`${API_BASE}/api/journal/${journalId}/tags`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ tag }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function deleteJournalTag(journalId, tag) {
  const res = await fetch(`${API_BASE}/api/journal/${journalId}/tags/${encodeURIComponent(tag)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
