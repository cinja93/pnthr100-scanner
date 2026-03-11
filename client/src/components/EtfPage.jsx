import { useState, useEffect, useMemo } from 'react';
import StockTable from './StockTable';
import ChartModal from './ChartModal';
import { fetchEtfStocks, fetchEarnings } from '../services/api';
import styles from './EtfPage.module.css';
import pantherHead from '../assets/panther head.png';

export default function EtfPage() {
  const [stocks, setStocks]           = useState([]);
  const [signals, setSignals]         = useState({});
  const [categories, setCategories]   = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [earnings, setEarnings]       = useState({});
  const [activeCategory, setActiveCategory] = useState('All');
  const [chartIndex, setChartIndex]   = useState(null);
  const [chartStocks, setChartStocks] = useState([]);

  useEffect(() => { load(false); }, []);

  async function load(forceRefresh) {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchEtfStocks(forceRefresh);
      const stockList = result.stocks || [];
      setStocks(stockList);
      setSignals(result.signals || {});
      setCategories(result.categories || []);
      fetchEarnings(stockList.map(s => s.ticker)).then(r => setEarnings(r));
    } catch (err) {
      setError('Failed to load ETF data. Make sure the server is running.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  const filteredStocks = useMemo(() => {
    if (activeCategory === 'All') return stocks;
    return stocks.filter(s => s.category === activeCategory);
  }, [stocks, activeCategory]);

  function handleRowClick(_stock, sortedIdx, sortedStocks) {
    setChartStocks(sortedStocks);
    setChartIndex(sortedIdx);
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>
            <img src={pantherHead} alt="PNTHR" className={styles.pantherLogo} />
            PNTHR ETFs
          </h1>
          <p className={styles.subtitle}>
            {!loading && !error
              ? `${stocks.length} curated ETFs across ${categories.length} categories`
              : 'Curated list of 140 ETFs organized by category, with Laser signals where available.'}
          </p>
        </div>
        <button
          className={styles.refreshBtn}
          onClick={() => load(true)}
          disabled={loading}
        >
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {!loading && !error && stocks.length > 0 && (
        <div className={styles.filterRow}>
          <button
            className={`${styles.filterBtn} ${activeCategory === 'All' ? styles.filterBtnActive : ''}`}
            onClick={() => setActiveCategory('All')}
          >
            All ETFs
            <span className={styles.filterCount}>{stocks.length}</span>
          </button>
          {categories.map(cat => {
            const count = stocks.filter(s => s.category === cat).length;
            return (
              <button
                key={cat}
                className={`${styles.filterBtn} ${activeCategory === cat ? styles.filterBtnActive : ''}`}
                onClick={() => setActiveCategory(cat)}
              >
                {cat}
                <span className={styles.filterCount}>{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {loading && (
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <p>Loading ETF 140…</p>
        </div>
      )}

      {error && !loading && (
        <div className={styles.errorState}>
          <p>{error}</p>
          <button className={styles.retryBtn} onClick={() => load(false)}>Try Again</button>
        </div>
      )}

      {!loading && !error && filteredStocks.length > 0 && (
        <StockTable
          stocks={filteredStocks}
          signals={signals}
          signalsLoading={false}
          earnings={earnings}
          onTickerClick={handleRowClick}
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
