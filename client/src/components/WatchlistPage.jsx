import { useState, useEffect } from 'react';
import StockTable from './StockTable';
import ChartModal from './ChartModal';
import { fetchWatchlist, addWatchlistTicker, removeWatchlistTicker, fetchSignals, fetchEarnings } from '../services/api';
import styles from './WatchlistPage.module.css';

export default function WatchlistPage() {
  const [stocks, setStocks] = useState([]);
  const [signals, setSignals] = useState({});
  const [signalsLoading, setSignalsLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [addInput, setAddInput] = useState('');
  const [addError, setAddError] = useState(null);
  const [addLoading, setAddLoading] = useState(false);
  const [earnings, setEarnings] = useState({});
  const [chartIndex, setChartIndex] = useState(null);
  const [chartStocks, setChartStocks] = useState([]);

  useEffect(() => {
    loadWatchlist();
  }, []);

  async function loadWatchlist() {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchWatchlist();
      setStocks(data);
      if (data.length > 0) {
        const tickers = data.map(s => s.ticker);
        setSignals({});
        setSignalsLoading(true);
        fetchSignals(tickers).then(result => {
          setSignals(result);
          setSignalsLoading(false);
        });
        fetchEarnings(tickers).then(result => setEarnings(result));
      }
    } catch (err) {
      console.error(err);
      setError('Failed to load watchlist.');
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd(e) {
    e.preventDefault();
    const ticker = addInput.trim().toUpperCase();
    if (!ticker) return;
    setAddLoading(true);
    setAddError(null);
    try {
      await addWatchlistTicker(ticker);
      setAddInput('');
      await loadWatchlist();
    } catch (err) {
      setAddError(err.message);
    } finally {
      setAddLoading(false);
    }
  }

  async function handleRemove(ticker) {
    try {
      await removeWatchlistTicker(ticker);
      setStocks(prev => prev.filter(s => s.ticker !== ticker));
    } catch (err) {
      console.error('Remove failed:', err.message);
    }
  }

  function handleRowClick(_stock, sortedIdx, sortedStocks) {
    setChartStocks(sortedStocks);
    setChartIndex(sortedIdx);
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h2 className={styles.pageTitle}>Watchlist</h2>
          <p className={styles.pageSubtitle}>Saved to your account — persists between sessions</p>
        </div>

        <div className={styles.controls}>
          {/* Refresh */}
          <button
            className={styles.refreshBtn}
            onClick={loadWatchlist}
            disabled={loading}
            title="Refresh live data"
          >
            {loading ? '⏳ Loading...' : '🔄 Refresh Data'}
          </button>

          {/* Add stock form */}
          <form className={styles.addForm} onSubmit={handleAdd}>
            <input
              className={styles.addInput}
              type="text"
              placeholder="Ticker (e.g. AAPL)"
              value={addInput}
              onChange={e => setAddInput(e.target.value.toUpperCase())}
              maxLength={10}
              disabled={addLoading || loading}
            />
            <button className={styles.addBtn} type="submit" disabled={addLoading || loading || !addInput.trim()}>
              {addLoading ? 'Adding...' : '+ Add'}
            </button>
          </form>
        </div>
      </div>

      {addError && <div className={styles.addError}>{addError}</div>}

      {/* Loading — disappears automatically once data is ready */}
      {loading && (
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <p>Fetching live data for your watchlist...</p>
          <p className={styles.loadingNote}>This may take a few seconds</p>
        </div>
      )}

      {error && <div className={styles.errorState}>⚠️ {error}</div>}

      {!loading && !error && stocks.length === 0 && (
        <div className={styles.emptyState}>
          <p>Your watchlist is empty.</p>
          <p>Type a ticker above and click <strong>+ Add</strong> to get started.</p>
        </div>
      )}

      {!loading && !error && stocks.length > 0 && (
        <StockTable
          stocks={stocks}
          signals={signals}
          signalsLoading={signalsLoading}
          earnings={earnings}
          onTickerClick={handleRowClick}
          onRemove={handleRemove}
          scanType="long"
        />
      )}

      {chartIndex != null && (
        <ChartModal
          stocks={chartStocks}
          initialIndex={chartIndex}
          signals={signals}
          onClose={() => setChartIndex(null)}
        />
      )}
    </div>
  );
}
