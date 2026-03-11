import { useState } from 'react';
import StockTable from './StockTable';
import ChartModal from './ChartModal';
import { fetchStockSearch, fetchEarnings } from '../services/api';
import styles from './SearchPage.module.css';
import pantherHead from '../assets/panther head.png';

export default function SearchPage() {
  const [query, setQuery]       = useState('');
  const [stock, setStock]       = useState(null);
  const [signals, setSignals]   = useState({});
  const [earnings, setEarnings] = useState({});
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [chartIndex, setChartIndex]   = useState(null);
  const [chartStocks, setChartStocks] = useState([]);

  async function handleSearch(e) {
    e.preventDefault();
    const ticker = query.trim().toUpperCase();
    if (!ticker) return;
    setLoading(true);
    setError(null);
    setStock(null);
    setSignals({});
    try {
      const result = await fetchStockSearch(ticker);
      setStock(result.stock);
      setSignals(result.signals || {});
      fetchEarnings([result.stock.ticker]).then(setEarnings);
    } catch (err) {
      setError(err.message || 'Ticker not found.');
    } finally {
      setLoading(false);
    }
  }

  function handleTickerClick(_s, idx, sortedStocks) {
    setChartStocks(sortedStocks);
    setChartIndex(idx);
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>
            <img src={pantherHead} alt="PNTHR" className={styles.pantherLogo} />
            PNTHR Search
          </h1>
          <p className={styles.subtitle}>Look up any NYSE or Nasdaq listed stock</p>
        </div>
      </div>

      <div className={styles.searchArea}>
        <form onSubmit={handleSearch} className={styles.searchForm}>
          <input
            className={styles.searchInput}
            type="text"
            placeholder="Enter ticker symbol (e.g. AAPL)"
            value={query}
            onChange={e => setQuery(e.target.value.toUpperCase())}
            autoFocus
            autoComplete="off"
            autoCapitalize="characters"
          />
          <button className={styles.searchBtn} type="submit" disabled={loading || !query.trim()}>
            {loading ? 'Searching\u2026' : 'Search'}
          </button>
        </form>
      </div>

      {error && <div className={styles.errorState}>{error}</div>}

      {!loading && stock && (
        <StockTable
          stocks={[stock]}
          signals={signals}
          signalsLoading={false}
          earnings={earnings}
          onTickerClick={handleTickerClick}
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
