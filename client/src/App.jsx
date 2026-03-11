import { useState, useEffect, useMemo } from 'react';
import StockTable from './components/StockTable';
import ChartModal from './components/ChartModal';
import FilterBar from './components/FilterBar';
import Sidebar from './components/Sidebar';
import SectorPage from './components/SectorPage';
import WatchlistPage from './components/WatchlistPage';
import PortfolioPage from './components/PortfolioPage';
import EmaCrossoverPage from './components/EmaCrossoverPage';
import EtfPage from './components/EtfPage';
import EarningsWeekPage from './components/EarningsWeekPage';
import JunglePage from './components/JunglePage';
import SearchPage from './components/SearchPage';
import PreyPage from './components/PreyPage';
import LoginPage from './components/LoginPage';
import { fetchTopStocks, fetchShortStocks, fetchAvailableDates, fetchRankingByDate, fetchSignals, fetchLaserSignals, fetchEarnings, fetchUserProfile, setAuthToken, clearAuthToken } from './services/api';
import './App.css';

const defaultFilters = {
  signals: [],
  sectors: [],
  exchanges: [],
  minPrice: '',
  maxPrice: '',
  minRiskDollar: '',
  maxRiskDollar: '',
  minRiskPct: '',
  maxRiskPct: '',
  minWeeksAgo: '',
  maxWeeksAgo: '',
};

// Compute inclusive weeks since a signal date (Monday of signal week) to current week's Monday.
// Returns null if no signalDate.
function computeWeeksAgo(signalDate) {
  if (!signalDate) return null;
  const signalMonday = new Date(signalDate + 'T12:00:00');
  const today = new Date();
  const dow = today.getDay(); // 0=Sun..6=Sat
  const daysToMonday = dow === 0 ? -6 : 1 - dow;
  const currentMonday = new Date(today);
  currentMonday.setDate(today.getDate() + daysToMonday);
  currentMonday.setHours(0, 0, 0, 0);
  const diffDays = Math.round((currentMonday - signalMonday) / (1000 * 60 * 60 * 24));
  return Math.floor(diffDays / 7) + 1; // inclusive: signal week = week 1
}

function App() {
  const [authToken, setAuthTokenState] = useState(() => localStorage.getItem('pnthr_token'));
  const [currentUser, setCurrentUser] = useState(null); // { email, accountSize, defaultPage }
  const [authLoading, setAuthLoading] = useState(true);

  // On mount: validate stored token
  useEffect(() => {
    const token = localStorage.getItem('pnthr_token');
    if (!token) { setAuthLoading(false); return; }
    setAuthToken(token);
    fetchUserProfile()
      .then(profile => {
        setCurrentUser(profile);
        setAuthTokenState(token);
      })
      .catch(() => {
        // Token invalid or expired — clear it
        localStorage.removeItem('pnthr_token');
        clearAuthToken();
        setAuthTokenState(null);
      })
      .finally(() => setAuthLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleLogin(token, email, profile) {
    localStorage.setItem('pnthr_token', token);
    setAuthToken(token);
    setAuthTokenState(token);
    setCurrentUser({ email, accountSize: profile?.accountSize ?? null, defaultPage: profile?.defaultPage ?? 'long' });
  }

  function handleLogout() {
    localStorage.removeItem('pnthr_token');
    localStorage.removeItem('pnthr_page');
    clearAuthToken();
    setAuthTokenState(null);
    setCurrentUser(null);
  }

  if (authLoading) return null; // brief flash while validating token
  if (!authToken) return <LoginPage onLogin={handleLogin} />;

  return <AppInner currentUser={currentUser} setCurrentUser={setCurrentUser} onLogout={handleLogout} />;
}

function AppInner({ currentUser, setCurrentUser, onLogout }) {
  const [activePage, setActivePage] = useState(
    () => localStorage.getItem('pnthr_page') || currentUser?.defaultPage || 'long'
  );

  function navigate(page) {
    setActivePage(page);
    localStorage.setItem('pnthr_page', page);
  }
  const scanType = activePage === 'short' ? 'short' : 'long';
  const [stocks, setStocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedDate, setSelectedDate] = useState(null);
  const [availableDates, setAvailableDates] = useState([]);
  const [signals, setSignals] = useState({});
  const [laserSignals, setLaserSignals] = useState({});
  const [signalsLoading, setSignalsLoading] = useState(false);
  const [earnings, setEarnings] = useState({});
  const [chartIndex, setChartIndex] = useState(null);
  const [chartStocks, setChartStocks] = useState([]);
  const [filters, setFilters] = useState(defaultFilters);
  const [longBatchStats, setLongBatchStats] = useState(null);
  const [shortBatchStats, setShortBatchStats] = useState(null);

  const isScanner = activePage === 'long' || activePage === 'short';

  // Reset filters when tab or date changes
  useEffect(() => {
    setFilters(defaultFilters);
  }, [activePage, selectedDate]);

  // Apply filters (risk values derived here since they need signals data)
  const filteredStocks = useMemo(() => {
    return stocks.filter(stock => {
      const signalData = signals[stock.ticker];
      const stopPrice = signalData?.stopPrice ?? null;
      const riskDollar = stopPrice != null ? Math.abs(stock.currentPrice - stopPrice) : null;
      const riskPct = riskDollar != null ? (riskDollar / stock.currentPrice) * 100 : null;

      const signalKey = signalData
        ? (signalData.isNewSignal ? `NEW_${signalData.signal}` : signalData.signal)
        : 'NONE';
      if (filters.signals.length > 0 && !filters.signals.includes(signalKey)) return false;
      if (filters.sectors.length > 0 && !filters.sectors.includes(stock.sector)) return false;
      if (filters.exchanges.length > 0 && !filters.exchanges.includes(stock.exchange)) return false;
      if (filters.minPrice !== '' && stock.currentPrice < +filters.minPrice) return false;
      if (filters.maxPrice !== '' && stock.currentPrice > +filters.maxPrice) return false;
      if (filters.minRiskDollar !== '' && (riskDollar == null || riskDollar < +filters.minRiskDollar)) return false;
      if (filters.maxRiskDollar !== '' && (riskDollar == null || riskDollar > +filters.maxRiskDollar)) return false;
      if (filters.minRiskPct !== '' && (riskPct == null || riskPct < +filters.minRiskPct)) return false;
      if (filters.maxRiskPct !== '' && (riskPct == null || riskPct > +filters.maxRiskPct)) return false;
      if (filters.minWeeksAgo !== '' || filters.maxWeeksAgo !== '') {
        const weeksAgo = computeWeeksAgo(signalData?.signalDate);
        if (weeksAgo == null) return false;
        if (filters.minWeeksAgo !== '' && weeksAgo < +filters.minWeeksAgo) return false;
        if (filters.maxWeeksAgo !== '' && weeksAgo > +filters.maxWeeksAgo) return false;
      }
      return true;
    });
  }, [stocks, signals, filters]);

  useEffect(() => {
    loadAvailableDates();
  }, []);

  async function loadAvailableDates() {
    try {
      const dates = await fetchAvailableDates();
      setAvailableDates(dates);
      if (dates?.length) setSelectedDate(dates[0].date);
      else setSelectedDate('current');
    } catch (err) {
      console.error('Failed to load available dates:', err);
      setSelectedDate('current');
    }
  }

  // Load stocks when viewing a scan and a date is selected
  useEffect(() => {
    if (!isScanner || selectedDate == null) return;
    if (selectedDate === 'current') loadCurrentStocks(true);
    else loadStocksByDate(selectedDate);
  }, [activePage, selectedDate]);

  async function loadCurrentStocks(forceRefresh = false) {
    try {
      setLoading(true);
      setError(null);
      const fetchFn = scanType === 'short' ? fetchShortStocks : fetchTopStocks;
      const data = await fetchFn(forceRefresh);
      setStocks(data);
      setSelectedDate('current');
      setSignals({});
      setLaserSignals({});
      setSignalsLoading(true);
      const tickers = data.map(s => s.ticker);
      const opts = { shortList: scanType === 'short' };
      Promise.all([
        fetchSignals(tickers, opts).catch(err => { console.error('PNTHR signals error:', err); return {}; }),
        fetchLaserSignals(tickers, opts).catch(err => { console.error('Laser signals error:', err); return {}; }),
      ]).then(([pnthr, laser]) => {
        setSignals(pnthr);
        setLaserSignals(laser);
        setSignalsLoading(false);
        if (scanType === 'long') computeAndSetLongStats(pnthr);
        else if (scanType === 'short') computeAndSetShortStats(pnthr);
      });
      fetchEarnings(tickers).then(result => setEarnings(result)).catch(err => console.error('Earnings fetch error:', err));
    } catch (err) {
      setError('Failed to load stock data. Please try again later.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function loadStocksByDate(date) {
    if (date === 'current') {
      loadCurrentStocks(true);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const data = await fetchRankingByDate(date);
      const list = scanType === 'short' ? (data.shortRankings || []) : (data.rankings || []);
      setStocks(list);
      setSelectedDate(date);
      setSignals({});
      setLaserSignals({});
      setSignalsLoading(true);
      const tickers = list.map(s => s.ticker);
      const opts = { shortList: scanType === 'short' };
      Promise.all([
        fetchSignals(tickers, opts).catch(err => { console.error('PNTHR signals error:', err); return {}; }),
        fetchLaserSignals(tickers, opts).catch(err => { console.error('Laser signals error:', err); return {}; }),
      ]).then(([pnthr, laser]) => {
        setSignals(pnthr);
        setLaserSignals(laser);
        setSignalsLoading(false);
        if (scanType === 'long') computeAndSetLongStats(pnthr);
        else if (scanType === 'short') computeAndSetShortStats(pnthr);
      });
      fetchEarnings(tickers).then(result => setEarnings(result)).catch(err => console.error('Earnings fetch error:', err));
    } catch (err) {
      setError(`Failed to load data for ${date}. Please try again.`);
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  function computeAndSetLongStats(pnthrSignals) {
    const closed = Object.values(pnthrSignals).filter(s => s.signal === 'BE' && s.profitDollar != null);
    if (closed.length === 0) { setLongBatchStats(null); return; }
    const wins = closed.filter(s => s.profitDollar > 0);
    const avgDollar = closed.reduce((sum, s) => sum + s.profitDollar, 0) / closed.length;
    const avgPct    = closed.reduce((sum, s) => sum + s.profitPct,    0) / closed.length;
    setLongBatchStats({ total: closed.length, wins: wins.length, winRate: (wins.length / closed.length) * 100, avgDollar, avgPct });
  }

  function computeAndSetShortStats(pnthrSignals) {
    const closed = Object.values(pnthrSignals).filter(s => s.signal === 'SE' && s.profitDollar != null);
    if (closed.length === 0) { setShortBatchStats(null); return; }
    const wins = closed.filter(s => s.profitDollar > 0);
    const avgDollar = closed.reduce((sum, s) => sum + s.profitDollar, 0) / closed.length;
    const avgPct    = closed.reduce((sum, s) => sum + s.profitPct,    0) / closed.length;
    setShortBatchStats({ total: closed.length, wins: wins.length, winRate: (wins.length / closed.length) * 100, avgDollar, avgPct });
  }

  function formatDate(dateString) {
    const date = new Date(dateString + 'T00:00:00');
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function handleRowClick(_stock, sortedIdx, sortedStocks) {
    setChartStocks(sortedStocks);
    setChartIndex(sortedIdx);
  }

  return (
    <div className="app">
      <Sidebar activePage={activePage} onNavigate={navigate} currentUser={currentUser} onLogout={onLogout} longStats={longBatchStats} shortStats={shortBatchStats} />

      <div className="content-wrapper">
        <main className="main">

          {/* Scanner pages (Long / Short) */}
          {isScanner && (
            <>
              <div className="date-picker-container">
                <label htmlFor="date-select" className="date-label">View:</label>
                <select
                  id="date-select"
                  className="date-picker"
                  value={selectedDate ?? ''}
                  onChange={(e) => loadStocksByDate(e.target.value)}
                  disabled={loading}
                >
                  {selectedDate == null && <option value="">Loading...</option>}
                  <option value="current">Current Week (Live)</option>
                  {availableDates.map((ranking) => (
                    <option key={ranking.date} value={ranking.date}>
                      {formatDate(ranking.date)} - {ranking.dayOfWeek}
                    </option>
                  ))}
                </select>
                {selectedDate === 'current' && (
                  <button className="refresh-button" onClick={() => loadCurrentStocks(true)} disabled={loading}>
                    {loading ? '🔄 Loading...' : '🔄 Refresh Data'}
                  </button>
                )}
              </div>

              {loading && (
                <div className="loading">
                  <div className="spinner"></div>
                  <p>{selectedDate === 'current' ? 'Fetching live data...' : 'Loading...'}</p>
                  {selectedDate === 'current' && <p className="loading-note">This may take a few moments</p>}
                </div>
              )}

              {error && (
                <div className="error">
                  <span className="error-icon">⚠️</span>
                  <p>{error}</p>
                  <button className="retry-button" onClick={() => loadCurrentStocks(true)}>
                    Try Again
                  </button>
                </div>
              )}

              {!loading && !error && stocks.length > 0 && (
                <>
                  {selectedDate !== 'current' && (
                    <div className="viewing-indicator">
                      📅 Viewing historical data from {formatDate(selectedDate)}
                    </div>
                  )}
                  <FilterBar stocks={stocks} signals={signals} filters={filters} onChange={setFilters} scanType={scanType} />
                  <StockTable key={activePage} stocks={filteredStocks} signals={signals} laserSignals={laserSignals} signalsLoading={signalsLoading} earnings={earnings} onTickerClick={handleRowClick} scanType={scanType} />
                </>
              )}
            </>
          )}

          {/* Search page */}
          {activePage === 'search' && <SearchPage />}

          {/* Sectors page */}
          {activePage === 'sectors' && <SectorPage />}

          {/* Watchlist page */}
          {activePage === 'watchlist' && <WatchlistPage />}

          {/* EMA Crossover page */}
          {activePage === 'ema' && <EmaCrossoverPage />}

          {/* ETF Scan page */}
          {activePage === 'etf' && <EtfPage />}

          {/* Earnings Week page */}
          {activePage === 'earnings' && <EarningsWeekPage />}

          {/* PNTHR PREY page */}
          {activePage === 'prey' && <PreyPage />}

          {/* Jungle page */}
          {activePage === 'jungle' && <JunglePage />}

          {/* Portfolio page */}
          {activePage === 'portfolio' && <PortfolioPage currentUser={currentUser} onProfileUpdate={setCurrentUser} />}
        </main>

        <footer className="footer">
          <p>Data provided by Financial Modeling Prep • Live view cached for 5 minutes</p>
        </footer>
      </div>

      {/* Chart Modal */}
      {chartIndex != null && (
        <ChartModal
          stocks={chartStocks}
          initialIndex={chartIndex}
          signals={signals}
          earnings={earnings}
          onClose={() => setChartIndex(null)}
        />
      )}
    </div>
  );
}

export default App;
