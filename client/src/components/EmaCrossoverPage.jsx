import { useState, useEffect } from 'react';
import StockTable from './StockTable';
import ChartModal from './ChartModal';
import { fetchEmaCrossoverStocks, fetchEarnings, fetchScannerRanks } from '../services/api';
import styles from './EmaCrossoverPage.module.css';

export default function EmaCrossoverPage() {
  const [stocks, setStocks] = useState([]);
  const [signals, setSignals] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [earnings, setEarnings] = useState({});
  const [scannerRanks, setScannerRanks] = useState(null);
  const [chartIndex, setChartIndex] = useState(null);
  const [chartStocks, setChartStocks] = useState([]);

  useEffect(() => {
    load(false);
  }, []);

  async function load(forceRefresh) {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchEmaCrossoverStocks(forceRefresh);
      const stockList = result.stocks || [];
      setStocks(stockList);
      setSignals(result.signals || {});
      fetchEarnings(stockList.map(s => s.ticker)).then(r => setEarnings(r));
      fetchScannerRanks().then(r => setScannerRanks(r));
    } catch (err) {
      setError('Failed to run EMA Crossover scan. Make sure the server is running.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  function handleRowClick(_stock, sortedIdx, sortedStocks) {
    setChartStocks(sortedStocks);
    setChartIndex(sortedIdx);
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>EMA Crossover</h1>
          <p className={styles.subtitle}>
            Stocks whose weekly close crossed the 21-week EMA within the past 2 weeks —
            above EMA with a BUY signal, or below EMA with a SELL signal.
            Universe: S&amp;P 500 + NASDAQ 100 + Dow 30.
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
          <p>Running EMA Crossover scan…</p>
          <p className={styles.loadingNote}>
            Scanning S&amp;P 500 + NASDAQ 100 + Dow 30 (~600 stocks) for recent EMA crossovers.
            First run may take 1–2 minutes. Results are cached for 1 hour.
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
              ? 'No stocks currently meet the EMA Crossover criteria.'
              : `${stocks.length} stock${stocks.length === 1 ? '' : 's'} match`}
          </div>
          {stocks.length > 0 && (
            <StockTable
              stocks={stocks}
              signals={signals}
              signalsLoading={false}
              earnings={earnings}
              scannerRanks={scannerRanks}
              onTickerClick={handleRowClick}
              scanType="long"
            />
          )}
        </>
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
