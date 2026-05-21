import { useState, useEffect, useMemo } from 'react';
import StockTable from './StockTable';
import AiTickerChartModal from './AiTickerChartModal';
import { fetchEtfStocks, fetchAiEtfStocks, fetchEarnings } from '../services/api';
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
  const [universe, setUniverse] = useState(() => sessionStorage.getItem('etfUniverse') || '679');
  const [stocks, setStocks]           = useState([]);
  const [signals, setSignals]         = useState({});
  const [categories, setCategories]   = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [earnings, setEarnings]       = useState({});
  const [activeCategory, setActiveCategory] = useState('All');
  const [chartIndex, setChartIndex]   = useState(null);
  const [chartStocks, setChartStocks] = useState([]);

  // AI state
  const [aiStocks, setAiStocks]         = useState([]);
  const [aiSignals, setAiSignals]       = useState({});
  const [aiCategories, setAiCategories] = useState([]);
  const [aiLoading, setAiLoading]       = useState(false);
  const [aiError, setAiError]           = useState(null);
  const [aiEarnings, setAiEarnings]     = useState({});

  useEffect(() => { load(false); }, []);

  function switchUniverse(u) {
    setUniverse(u);
    sessionStorage.setItem('etfUniverse', u);
    setActiveCategory('All');
    if (u === 'ai300' && aiStocks.length === 0 && !aiLoading) loadAi(false);
  }

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

  async function loadAi(forceRefresh) {
    setAiLoading(true);
    setAiError(null);
    try {
      const result = await fetchAiEtfStocks(forceRefresh);
      const stockList = result.stocks || [];
      setAiStocks(stockList);
      setAiSignals(result.signals || {});
      setAiCategories(result.categories || []);
      fetchEarnings(stockList.map(s => s.ticker)).then(r => setAiEarnings(r));
    } catch (err) {
      setAiError('Failed to load AI ETF data.');
      console.error(err);
    } finally {
      setAiLoading(false);
    }
  }

  // Compute ETF Analyze score for every ETF row using AnalyzeContext + signal enrichment.
  // Fields derived from signals: ema21, emaRising→emaSlope proxy, lastWeekHigh/Low/Close.
  // volumeRatio comes from etfService (FMP quote volume/avgVolume). rsi14 unavailable at
  // table level (no chart data fetched) — scoring function gives partial credit gracefully.
  const is679 = universe === '679';
  const curStocks = is679 ? stocks : aiStocks;
  const curSignals = is679 ? signals : aiSignals;
  const curCategories = is679 ? categories : aiCategories;
  const curEarnings = is679 ? earnings : aiEarnings;
  const curLoading = is679 ? loading : aiLoading;
  const curError = is679 ? error : aiError;

  const analyzeScores = useMemo(() => {
    if (!analyzeContext || !curStocks.length) return {};
    const result = {};
    for (const stock of curStocks) {
      const sigData  = curSignals[stock.ticker];
      const signalAge = weeksAgo(sigData?.signalDate);
      const enriched = {
        ...stock,
        signal:        sigData?.signal        || null,
        signalAge,
        weeksInSignal: signalAge,
        ema21:         sigData?.ema21         ?? null,
        emaSlope:      sigData?.emaSlope       ?? null,
        weekHigh:      sigData?.lastWeekHigh  ?? null,
        weekLow:       sigData?.lastWeekLow   ?? null,
        close:         sigData?.lastWeekClose ?? stock.currentPrice ?? null,
      };
      const ar = computeETFAnalyzeScore(enriched, analyzeContext);
      if (ar) result[stock.ticker] = { pct: ar.pct, color: ar.color, warnings: ar.warnings };
    }
    return result;
  }, [curStocks, curSignals, analyzeContext]);

  const filteredStocks = useMemo(() => {
    if (activeCategory === 'All') return curStocks;
    return curStocks.filter(s => s.category === activeCategory);
  }, [curStocks, activeCategory]);

  function handleRowClick(_stock, sortedIdx, sortedStocks) {
    setChartStocks(sortedStocks);
    setChartIndex(sortedIdx);
  }

  return (
    <div className={styles.page}>
      {/* Universe toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
        {[
          { key: '679', label: 'PNTHR 679' },
          { key: 'ai300', label: 'PNTHR AI 300' },
        ].map(u => {
          const active = universe === u.key;
          return (
            <button key={u.key} onClick={() => switchUniverse(u.key)} style={{
              padding: '6px 16px', borderRadius: 6,
              border: active ? '1px solid #FFD700' : '1px solid #333',
              background: active ? 'rgba(255,215,0,0.12)' : '#111',
              color: active ? '#FFD700' : '#666',
              fontWeight: active ? 800 : 600, fontSize: 12,
              fontFamily: 'monospace', letterSpacing: 1.5,
              cursor: 'pointer', transition: 'all 0.15s',
            }}>{u.label}</button>
          );
        })}
        <span style={{ color: '#333', fontSize: 11, marginLeft: 6, fontFamily: 'monospace' }}>ETFs</span>
      </div>

      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>
            <img src={pantherHead} alt="PNTHR" className={styles.pantherLogo} />
            {is679 ? 'PNTHR ETFs' : 'PNTHR AI ETFs'}
          </h1>
          <p className={styles.subtitle}>
            {is679 ? 'Strategic PNTHR ETFs organized by category with PNTHR signals.' : 'AI-themed ETFs across the PNTHR AI 300 universe with PNTHR signals.'}
          </p>
        </div>
        <button
          className={styles.refreshBtn}
          onClick={() => is679 ? load(true) : loadAi(true)}
          disabled={curLoading}
        >
          {curLoading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {!curLoading && !curError && curStocks.length > 0 && (
        <div className={styles.filterRow}>
          <button
            className={`${styles.filterBtn} ${activeCategory === 'All' ? styles.filterBtnActive : ''}`}
            onClick={() => setActiveCategory('All')}
          >
            All ETFs
            <span className={styles.filterCount}>{curStocks.length}</span>
          </button>
          {curCategories.map(cat => {
            const count = curStocks.filter(s => s.category === cat).length;
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

      {curLoading && (
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <p>Loading {is679 ? 'ETFs' : 'AI ETFs'}…</p>
        </div>
      )}

      {curError && !curLoading && (
        <div className={styles.errorState}>
          <p>{curError}</p>
          <button className={styles.retryBtn} onClick={() => is679 ? load(false) : loadAi(false)}>Try Again</button>
        </div>
      )}

      {!curLoading && !curError && filteredStocks.length > 0 && (
        <StockTable
          stocks={filteredStocks}
          signals={curSignals}
          signalsLoading={false}
          earnings={curEarnings}
          hideEarnings={true}
          onTickerClick={handleRowClick}
          scanType="long"
          rankLabel="ETF Performance Rank"
          groupByCategory={activeCategory === 'All'}
          analyzeScores={analyzeScores}
        />
      )}

      {chartIndex != null && (
        <AiTickerChartModal
          tickers={chartStocks.map(s => s.ticker || s)}
          initialIndex={chartIndex}
          onClose={() => setChartIndex(null)}
        />
      )}
    </div>
  );
}
