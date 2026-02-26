import { useState, useEffect } from 'react';
import StockTable from './StockTable';
import ChartModal from './ChartModal';
import { fetchEtfStocks } from '../services/api';
import styles from './EtfPage.module.css';

export default function EtfPage() {
  const [stocks, setStocks] = useState([]);
  const [signals, setSignals] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [chartIndex, setChartIndex] = useState(null);

  useEffect(() => {
    load(false);
  }, []);

  async function load(forceRefresh) {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchEtfStocks(forceRefresh);
      setStocks(result.stocks || []);
      setSignals(result.signals || {});
    } catch (err) {
      setError('Failed to run ETF scan. Make sure the server is running.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  function handleRowClick(stock) {
    const index = stocks.findIndex(s => s.ticker === stock.ticker);
    if (index >= 0) setChartIndex(index);
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>ETF Scan</h1>
          <p className={styles.subtitle}>
            Top 100 US-listed ETFs ranked by YTD return, with Laser signals where available.
            Universe: all US exchange-traded funds priced above $2.
          </p>
        </div>
        <button
          className={styles.refreshBtn}
          onClick={() => load(true)}
          disabled={loading}
        >
          {loading ? '🔄 Scanning...' : '🔄 Refresh'}
        </button>
      </div>

      {loading && (
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <p>Running ETF scan…</p>
          <p className={styles.loadingNote}>
            Fetching YTD returns for all US-listed ETFs and ranking the top 100.
            First run may take 30–60 seconds. Results are cached for 1 hour.
          </p>
        </div>
      )}

      {error && !loading && (
        <div className={styles.errorState}>
          <p>{error}</p>
          <button className={styles.retryBtn} onClick={() => load(false)}>Try Again</button>
        </div>
      )}

      {!loading && !error && (
        <>
          <div className={styles.resultCount}>
            {stocks.length === 0
              ? 'No ETFs returned.'
              : `${stocks.length} ETF${stocks.length === 1 ? '' : 's'} ranked by YTD return`}
          </div>
          {stocks.length > 0 && (
            <StockTable
              stocks={stocks}
              signals={signals}
              signalsLoading={false}
              onTickerClick={handleRowClick}
              scanType="long"
            />
          )}
        </>
      )}

      {chartIndex != null && (
        <ChartModal
          stocks={stocks}
          initialIndex={chartIndex}
          signals={signals}
          onClose={() => setChartIndex(null)}
        />
      )}
    </div>
  );
}
