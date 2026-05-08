import { useState, useEffect, useMemo } from 'react';
import StockTable from './StockTable';
import ChartModal from './ChartModal';
import { fetchAiUniverse, fetchEarnings } from '../services/api';
import styles from './JunglePage.module.css';
import pantherHead from '../assets/panther head.png';

// PNTHR AI Jungle — the AI Universe (304 holdings, 16 sectors).
// Mirrors PNTHR 679 Jungle layout with three differences:
//   • Performance Rank is by YTD return (sorted server-side, computed identically to 679)
//   • Exchange column dropped (room for daily signals)
//   • Two new signal columns: PNTHR Daily Signal + Daily Wks Since
//     (blank until AI Universe methodology locks)
//   • Existing PNTHR Signal label renamed to "PNTHR Weekly Signal"

export default function AiJunglePage() {
  const [stocks, setStocks]               = useState([]);
  const [signals, setSignals]             = useState({});
  const [dailySignals, setDailySignals]   = useState({});
  const [sectors, setSectors]             = useState([]);  // [{ id, name, weight, count }]
  const [fundMeta, setFundMeta]           = useState(null);
  const [earnings, setEarnings]           = useState({});
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState(null);
  const [sectorFilter, setSectorFilter]   = useState('all'); // 'all' | sectorId number
  const [groupBySector, setGroupBySector] = useState(false);
  const [chartIndex, setChartIndex]       = useState(null);
  const [chartStocks, setChartStocks]     = useState([]);

  function load(forceRefresh = false) {
    setLoading(true);
    setError(null);
    fetchAiUniverse(forceRefresh)
      .then(data => {
        const stockList = data.stocks || [];
        setStocks(stockList);
        setSignals(data.signals || {});
        setDailySignals(data.dailySignals || {});
        setSectors(data.sectors || []);
        setFundMeta(data.fundMeta || null);
        fetchEarnings(stockList.map(s => s.ticker)).then(setEarnings);
      })
      .catch(err => {
        console.error(err);
        setError('Failed to load AI Universe. Please try again.');
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  // Counts by sectorId from current stock list (live, not from sectors metadata —
  // so the count reflects what FMP actually priced today).
  const counts = useMemo(() => {
    const out = { all: stocks.length };
    for (const s of stocks) {
      out[s.sectorId] = (out[s.sectorId] || 0) + 1;
    }
    return out;
  }, [stocks]);

  const filteredStocks = useMemo(() => {
    if (sectorFilter === 'all') return stocks;
    return stocks.filter(s => s.sectorId === sectorFilter);
  }, [stocks, sectorFilter]);

  function handleTickerClick(_stock, sortedIdx, sortedStocks) {
    setChartStocks(sortedStocks);
    setChartIndex(sortedIdx);
  }

  const totalCount = stocks.length;
  const sectorCount = sectors.length;
  const versionLabel = fundMeta?.version ? `${fundMeta.version}` : '';

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>
            <img src={pantherHead} alt="PNTHR" className={styles.pantherLogo} />
            PNTHR AI Jungle
          </h1>
          {!loading && !error && (
            <p className={styles.subtitle}>
              PNTHR AI Universe {versionLabel} — {totalCount} AI-elite holdings across {sectorCount} sectors,
              ranked by YTD return.
            </p>
          )}
        </div>
        <div className={styles.headerActions}>
          <button
            className={`${styles.sectorToggle} ${groupBySector ? styles.sectorToggleActive : ''}`}
            onClick={() => setGroupBySector(v => !v)}
            disabled={loading}
            title="Group by sector"
          >
            ⬛ By Sector
          </button>
          <button className={styles.refreshBtn} onClick={() => load(true)} disabled={loading}>
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {!loading && !error && stocks.length > 0 && (
        <div className={styles.filterRow}>
          <button
            key="all"
            className={`${styles.filterBtn} ${sectorFilter === 'all' ? styles.filterBtnActive : ''}`}
            onClick={() => setSectorFilter('all')}
          >
            Full AI Jungle
            <span className={styles.filterCount}>{counts.all}</span>
          </button>
          {sectors.map(sec => (
            <button
              key={sec.id}
              className={`${styles.filterBtn} ${sectorFilter === sec.id ? styles.filterBtnActive : ''}`}
              onClick={() => setSectorFilter(sec.id)}
              title={`Target weight: ${sec.weight}%`}
            >
              {sec.name}
              <span className={styles.filterCount}>{counts[sec.id] ?? 0}</span>
            </button>
          ))}
        </div>
      )}

      {loading && (
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <p>Loading PNTHR AI Universe… first load takes ~15 seconds.</p>
        </div>
      )}

      {error && <div className={styles.errorState}>{error}</div>}

      {!loading && !error && filteredStocks.length > 0 && (
        <StockTable
          stocks={filteredStocks}
          signals={signals}
          dailySignals={dailySignals}
          signalsLoading={false}
          earnings={earnings}
          groupBySector={groupBySector}
          hideExchange
          weeklySignalLabel="PNTHR Weekly Signal"
          showDailySignal
          onTickerClick={handleTickerClick}
          scanType="long"
        />
      )}

      {chartIndex != null && (
        <ChartModal
          stocks={chartStocks}
          initialIndex={chartIndex}
          earnings={earnings}
          onClose={() => setChartIndex(null)}
        />
      )}
    </div>
  );
}
