import { useState, useEffect, useMemo } from 'react';
import StockTable from './StockTable';
import ChartModal from './ChartModal';
import { fetchEtfStocks, fetchEarnings } from '../services/api';
import { useAnalyzeContext } from '../contexts/AnalyzeContext';
import { computeETFAnalyzeScore } from '../utils/analyzeScore';
import styles from './EtfPage.module.css';
import pantherHead from '../assets/panther head.png';

// Inclusive weeks since signal date (signal week = week 1). Same logic as StockTable.
function weeksAgo(signalDate) {
  if (!signalDate) return null;
  const signalMonday = new Date(signalDate + 'T12:00:00');
  const today = new Date();
  const dow = today.getDay();
  const currentMonday = new Date(today);
  currentMonday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
  currentMonday.setHours(0, 0, 0, 0);
  const diffDays = Math.round((currentMonday - signalMonday) / (1000 * 60 * 60 * 24));
  return Math.floor(diffDays / 7) + 1;
}

export default function EtfPage() {
  const { analyzeContext } = useAnalyzeContext() || {};
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

  // Compute ETF Analyze score for every ETF row using AnalyzeContext + signal enrichment.
  // Fields derived from signals: ema21, emaRising→emaSlope proxy, lastWeekHigh/Low/Close.
  // volumeRatio comes from etfService (FMP quote volume/avgVolume). rsi14 unavailable at
  // table level (no chart data fetched) — scoring function gives partial credit gracefully.
  const analyzeScores = useMemo(() => {
    if (!analyzeContext || !stocks.length) return {};
    const result = {};
    for (const stock of stocks) {
      const sigData  = signals[stock.ticker];
      const signalAge = weeksAgo(sigData?.signalDate);
      const enriched = {
        ...stock,
        signal:        sigData?.signal        || null,
        signalAge,
        weeksInSignal: signalAge,
        ema21:         sigData?.ema21         ?? null,
        emaSlope:      sigData?.emaSlope       ?? null, // % change week-over-week from signalService
        weekHigh:      sigData?.lastWeekHigh  ?? null,
        weekLow:       sigData?.lastWeekLow   ?? null,
        close:         sigData?.lastWeekClose ?? stock.currentPrice ?? null,
        // volumeRatio from etfService (q.volume/q.avgVolume); rsi14 unavailable without chart
      };
      const ar = computeETFAnalyzeScore(enriched, analyzeContext);
      if (ar) result[stock.ticker] = { pct: ar.pct, color: ar.color, warnings: ar.warnings };
    }
    return result;
  }, [stocks, signals, analyzeContext]);

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
            Strategic PNTHR ETFs organized by category with PNTHR signals.
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
          hideEarnings={true}
          onTickerClick={handleRowClick}
          scanType="long"
          rankLabel="ETF Performance Rank"
          groupByCategory={activeCategory === 'All'}
          analyzeScores={analyzeScores}
        />
      )}

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
