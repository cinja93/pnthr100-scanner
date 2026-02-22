import { useState, useEffect, useMemo } from 'react';
import StockTable from './components/StockTable';
import StockModal from './components/StockModal';
import ManageStocks from './components/ManageStocks';
import FilterBar from './components/FilterBar';
import { fetchTopStocks, fetchShortStocks, fetchAvailableDates, fetchRankingByDate, fetchSignals } from './services/api';
import pnthrLogo from './assets/PNTHR FUNDS Logo black background 2 lines.png';
import builtWithLove from './assets/Built with Love.jpg';
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
};

function App() {
  const [stocks, setStocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('long'); // 'long' | 'short' | 'manage'
  const scanType = activeTab === 'manage' ? 'long' : activeTab; // long/short for scanner view
  const [selectedDate, setSelectedDate] = useState(null); // null until dates load, then most recent date or 'current'
  const [availableDates, setAvailableDates] = useState([]);
  const [signals, setSignals] = useState({}); // { AAPL: { signal: "BUY", ... }, ... }
  const [selectedStock, setSelectedStock] = useState(null); // For modal
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [filters, setFilters] = useState(defaultFilters);

  // Reset filters whenever the user switches tabs or changes the date
  useEffect(() => {
    setFilters(defaultFilters);
  }, [activeTab, selectedDate]);

  // Apply filters to stocks (risk values derived here since they need signals data)
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
      // Default to most recent saved week for fast load (avoid slow live fetch on first paint)
      if (dates?.length) setSelectedDate(dates[0].date);
      else setSelectedDate('current');
    } catch (err) {
      console.error('Failed to load available dates:', err);
      setSelectedDate('current');
    }
  }

  // Load stocks when viewing a scan (long/short) and a date is selected
  useEffect(() => {
    if (activeTab === 'manage' || selectedDate == null) return;
    if (selectedDate === 'current') loadCurrentStocks(true);
    else loadStocksByDate(selectedDate);
  }, [activeTab, selectedDate]);

  async function loadCurrentStocks(forceRefresh = false) {
    try {
      setLoading(true);
      setError(null);
      const fetchFn = scanType === 'short' ? fetchShortStocks : fetchTopStocks;
      const data = await fetchFn(forceRefresh);
      setStocks(data);
      setSelectedDate('current');
      // Fetch laser signals in parallel (non-blocking)
      fetchSignals(data.map(s => s.ticker)).then(setSignals);
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
      // Fetch laser signals in parallel (non-blocking)
      fetchSignals(list.map(s => s.ticker)).then(setSignals);
    } catch (err) {
      setError(`Failed to load data for ${date}. Please try again.`);
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  function formatDate(dateString) {
    const date = new Date(dateString + 'T00:00:00');
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function handleTickerClick(stock) {
    setSelectedStock(stock);
    setIsModalOpen(true);
  }

  function handleCloseModal() {
    setIsModalOpen(false);
    setSelectedStock(null);
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-content">
          <h1 className="title">
            <img src={pnthrLogo} alt="PNTHR Funds" className="logo" />
            PNTHR100 Scanner
          </h1>

          {/* Primary scan buttons */}
          <div className="scan-actions">
            <button
              className={`scan-btn scan-long ${activeTab === 'long' ? 'active' : ''}`}
              onClick={() => setActiveTab('long')}
            >
              📈 Scan Long
            </button>
            <button
              className={`scan-btn scan-short ${activeTab === 'short' ? 'active' : ''}`}
              onClick={() => setActiveTab('short')}
            >
              📉 Scan Short
            </button>
          </div>

          {/* Secondary: Manage Stocks on its own row */}
          <div className="manage-row">
            <button
              className="manage-link"
              onClick={() => setActiveTab('manage')}
              title="Add stocks to scan beyond index constituents"
            >
              Manage Stocks
            </button>
          </div>

          {(activeTab === 'long' || activeTab === 'short') && (
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
                <button className="refresh-button" onClick={() => loadCurrentStocks(true)} disabled={loading}>
                  {loading ? '🔄 Loading...' : '🔄 Refresh Data'}
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      <main className="main">
        {(activeTab === 'long' || activeTab === 'short') && (
          <>
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
                <StockTable stocks={filteredStocks} signals={signals} onTickerClick={handleTickerClick} />
              </>
            )}
          </>
        )}

        {/* Manage Stocks Tab */}
        {activeTab === 'manage' && <ManageStocks />}
      </main>

      <footer className="footer">
        <p>Data provided by Financial Modeling Prep • Live view cached for 5 minutes</p>
        <div className="footer-love">
          <div className="love-frame">
            <img src={builtWithLove} alt="Built with Love" className="love-img" />
          </div>
          <p className="love-text">Built with love by Cindy and Blazer</p>
        </div>
      </footer>

      {/* Stock Detail Modal */}
      {isModalOpen && selectedStock && (
        <StockModal stock={selectedStock} onClose={handleCloseModal} />
      )}
    </div>
  );
}

export default App;
