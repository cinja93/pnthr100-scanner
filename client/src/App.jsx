import { useState, useEffect } from 'react';
import StockTable from './components/StockTable';
import StockModal from './components/StockModal';
import ManageStocks from './components/ManageStocks';
import { fetchTopStocks, fetchShortStocks, fetchAvailableDates, fetchRankingByDate } from './services/api';
import pnthrLogo from './assets/PNTHR FUNDS Logo black background 2 lines.png';
import './App.css';

function App() {
  const [stocks, setStocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('long'); // 'long' | 'short' | 'manage'
  const scanType = activeTab === 'manage' ? 'long' : activeTab; // long/short for scanner view
  const [selectedDate, setSelectedDate] = useState(null); // null until dates load, then most recent date or 'current'
  const [availableDates, setAvailableDates] = useState([]);
  const [selectedStock, setSelectedStock] = useState(null); // For modal
  const [isModalOpen, setIsModalOpen] = useState(false);

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
          <p className="subtitle">
            Long: Top 100 YTD • Short: Bottom 100 YTD — S&P 500, NASDAQ 100 & Dow 30
          </p>

          {/* Primary: Scan Long / Scan Short. Secondary: Manage Stocks */}
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
              </div>

              <button className="refresh-button" onClick={() => loadCurrentStocks(true)} disabled={loading}>
                {loading ? '🔄 Loading...' : '🔄 Refresh Data'}
              </button>
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

                <div className="stats">
                  <div className="stat-card">
                    <div className="stat-value">{stocks.length}</div>
                    <div className="stat-label">{scanType === 'long' ? 'Top Performers' : 'Short Candidates'}</div>
                  </div>
                  <div className="stat-card">
                    <div className={`stat-value ${scanType === 'long' ? 'positive' : ''}`}>
                      {stocks[0]?.ytdReturn >= 0 ? '+' : ''}{stocks[0]?.ytdReturn.toFixed(2)}%
                    </div>
                    <div className="stat-label">{scanType === 'long' ? 'Best YTD Return' : 'Worst YTD Return (#1 short)'}</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-value">
                      {stocks[stocks.length - 1]?.ytdReturn >= 0 ? '+' : ''}
                      {stocks[stocks.length - 1]?.ytdReturn.toFixed(2)}%
                    </div>
                    <div className="stat-label">{scanType === 'long' ? '100th Best Return' : '100th Worst Return'}</div>
                  </div>
                </div>
                <StockTable stocks={stocks} onTickerClick={handleTickerClick} />
              </>
            )}
          </>
        )}

        {/* Manage Stocks Tab */}
        {activeTab === 'manage' && <ManageStocks />}
      </main>

      <footer className="footer">
        <p>Data provided by Financial Modeling Prep • Live view cached for 5 minutes</p>
      </footer>

      {/* Stock Detail Modal */}
      {isModalOpen && selectedStock && (
        <StockModal stock={selectedStock} onClose={handleCloseModal} />
      )}
    </div>
  );
}

export default App;
