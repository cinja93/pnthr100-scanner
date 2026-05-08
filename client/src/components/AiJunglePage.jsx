import { useState, useEffect, useMemo } from 'react';
import StockTable from './StockTable';
import ChartModal from './ChartModal';
import Pnthr300ChartModal from './Pnthr300ChartModal';
import Pnthr300WeightsModal from './Pnthr300WeightsModal';
import { fetchAiUniverse, fetchEarnings, fetchPnthrAi300Latest } from '../services/api';
import styles from './JunglePage.module.css';
import pantherHead from '../assets/panther head.png';

// ── PNTHR AI 300 header strip ───────────────────────────────────────────────
// Live snapshot of the proprietary index. Clickable → opens Pnthr300ChartModal.
// Polls /api/pnthr-ai-300 on mount + every 60s while the page is open.
function Pnthr300Strip({ onOpenChart, onOpenWeights }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchPnthrAi300Latest()
        .then(d => { if (!cancelled) setData(d); })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 60000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (!data || !data.ok) return null;

  const dayChangeColor = data.dayChangePct >= 0 ? '#16a34a' : '#dc2626';
  const ytdColor       = (data.ytdPct ?? 0) >= 0 ? '#16a34a' : '#dc2626';
  const regimeColor    = data.regime === 'bull' ? '#16a34a' : '#dc2626';
  const regimeLabel    = data.regime === 'bull' ? '🟢 BULL REGIME' : '🔴 BEAR REGIME';

  return (
    <div
      onClick={onOpenChart}
      title="Click for full PNTHR AI 300 chart (OHLC bars + OpEMA, daily/weekly toggle)"
      style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14,
        padding: '10px 16px', margin: '12px 0',
        background: 'linear-gradient(90deg, #1a1a1a 0%, #0f0f0f 100%)',
        border: '1px solid #2a2a2a', borderRadius: 6,
        cursor: 'pointer', textAlign: 'left', width: '100%',
        fontFamily: 'inherit',
      }}
      onMouseEnter={e => e.currentTarget.style.borderColor = '#fcf000'}
      onMouseLeave={e => e.currentTarget.style.borderColor = '#2a2a2a'}
    >
      <span style={{ color: '#fcf000', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em' }}>
        PNTHR AI 300
      </span>
      <span style={{ color: '#666', fontSize: 10, fontFamily: 'monospace' }}>PAI300</span>

      <span style={{ color: '#fff', fontSize: 18, fontWeight: 700, fontFamily: 'monospace' }}>
        {data.value?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </span>
      <span style={{ color: dayChangeColor, fontSize: 13, fontWeight: 600, fontFamily: 'monospace' }}>
        {data.dayChangePct >= 0 ? '▲' : '▼'} {data.dayChangePct >= 0 ? '+' : ''}{data.dayChangePct?.toFixed(2)}% today
      </span>

      <span style={{
        padding: '3px 8px', borderRadius: 3, fontSize: 10, fontWeight: 700,
        letterSpacing: '0.06em', background: regimeColor, color: '#fff',
      }}>
        {regimeLabel}
      </span>

      <span style={{ color: '#888', fontSize: 11, fontFamily: 'monospace' }}>
        OpEMA <strong style={{ color: '#fcf000' }}>{data.ema21W?.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</strong>
      </span>
      <span style={{ color: '#888', fontSize: 11, fontFamily: 'monospace' }}>
        YTD <strong style={{ color: ytdColor }}>{data.ytdPct >= 0 ? '+' : ''}{data.ytdPct?.toFixed(2)}%</strong>
      </span>
      <span style={{ color: '#888', fontSize: 11, fontFamily: 'monospace' }}>
        Since launch <strong style={{ color: '#16a34a' }}>+{data.inceptionPct?.toFixed(1)}%</strong>
      </span>

      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          onClick={e => { e.stopPropagation(); onOpenWeights(); }}
          title="Show how each of the 304 holdings is weighted in the index"
          style={{
            padding: '5px 10px', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em',
            background: 'transparent', border: '1px solid #fcf000', borderRadius: 4,
            color: '#fcf000', cursor: 'pointer',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = '#fcf000'; e.currentTarget.style.color = '#000'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#fcf000'; }}
        >
          📊 Weights
        </button>
        <span style={{ color: '#fcf000', fontSize: 11, fontWeight: 600 }}>
          Open chart →
        </span>
      </span>
    </div>
  );
}

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
  const [showIndexChart, setShowIndexChart] = useState(false);
  const [showWeights, setShowWeights]       = useState(false);

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
            PNTHR AI 300 Index
          </h1>
          {!loading && !error && (
            <p className={styles.subtitle}>
              PNTHR AI 300 Index {versionLabel} — {totalCount} AI-elite holdings across {sectorCount} sectors,
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

      {!loading && !error && (
        <Pnthr300Strip
          onOpenChart={() => setShowIndexChart(true)}
          onOpenWeights={() => setShowWeights(true)}
        />
      )}

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

      {showIndexChart && (
        <Pnthr300ChartModal onClose={() => setShowIndexChart(false)} />
      )}

      {showWeights && (
        <Pnthr300WeightsModal onClose={() => setShowWeights(false)} />
      )}
    </div>
  );
}
