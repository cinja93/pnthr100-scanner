import { useState, useEffect, useMemo } from 'react';
import StockTable from './StockTable';
import ChartModal from './ChartModal';
import { fetchJungleStocks, fetchEarnings, fetchScannerRanks } from '../services/api';
import styles from './JunglePage.module.css';

const UNIVERSE_FILTERS = [
  { key: 'all',        label: 'All Jungle',   countKey: 'all' },
  { key: 'sp517',      label: 'S&P 517',      countKey: 'sp517' },
  { key: 'sp400Long',  label: '400 Longs',    countKey: 'sp400Long' },
  { key: 'sp400Short', label: '400 Shorts',   countKey: 'sp400Short' },
];

export default function JunglePage() {
  const [stocks, setStocks]           = useState([]);
  const [signals, setSignals]         = useState({});
  const [earnings, setEarnings]       = useState({});
  const [scannerRanks, setScannerRanks] = useState(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [universeFilter, setUniverseFilter] = useState('all');
  const [chartIndex, setChartIndex]   = useState(null);
  const [chartStocks, setChartStocks] = useState([]);

  function load(forceRefresh = false) {
    setLoading(true);
    setError(null);
    Promise.all([
      fetchJungleStocks(forceRefresh),
      fetchScannerRanks(),
    ])
      .then(([data, ranks]) => {
        const stockList = data.stocks || [];
        setStocks(stockList);
        setSignals(data.signals || {});
        setScannerRanks(ranks);
        fetchEarnings(stockList.map(s => s.ticker)).then(setEarnings);
      })
      .catch(err => {
        console.error(err);
        setError('Failed to load jungle stocks. Please try again.');
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  const counts = useMemo(() => ({
    all:        stocks.length,
    sp517:      stocks.filter(s => s.universe === 'sp517').length,
    sp400Long:  stocks.filter(s => s.universe === 'sp400Long').length,
    sp400Short: stocks.filter(s => s.universe === 'sp400Short').length,
  }), [stocks]);

  const filteredStocks = useMemo(() => {
    if (universeFilter === 'all') return stocks;
    return stocks.filter(s => s.universe === universeFilter);
  }, [stocks, universeFilter]);

  function handleTickerClick(_stock, sortedIdx, sortedStocks) {
    setChartStocks(sortedStocks);
    setChartIndex(sortedIdx);
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>🐆 PNTHR 679 Jungle</h1>
          {!loading && !error && (
            <p className={styles.subtitle}>
              {counts.all} stocks — S&P 517 core + S&P 400 Long &amp; Short leaders
            </p>
          )}
        </div>
        <button className={styles.refreshBtn} onClick={() => load(true)} disabled={loading}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {!loading && !error && stocks.length > 0 && (
        <div className={styles.filterRow}>
          {UNIVERSE_FILTERS.map(f => (
            <button
              key={f.key}
              className={`${styles.filterBtn} ${universeFilter === f.key ? styles.filterBtnActive : ''}`}
              onClick={() => setUniverseFilter(f.key)}
            >
              {f.label}
              <span className={styles.filterCount}>{counts[f.countKey]}</span>
            </button>
          ))}
        </div>
      )}

      {loading && (
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <p>Loading jungle universe… first load takes ~30 seconds.</p>
        </div>
      )}

      {error && <div className={styles.errorState}>{error}</div>}

      {!loading && !error && filteredStocks.length > 0 && (
        <StockTable
          stocks={filteredStocks}
          signals={signals}
          signalsLoading={false}
          earnings={earnings}
          scannerRanks={scannerRanks}
          onTickerClick={handleTickerClick}
          scanType="long"
        />
      )}

      {chartIndex != null && (
        <ChartModal
          stocks={chartStocks}
          initialIndex={chartIndex}
          onClose={() => setChartIndex(null)}
        />
      )}
    </div>
  );
}
