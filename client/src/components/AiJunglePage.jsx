import { useState, useEffect, useMemo } from 'react';
import StockTable from './StockTable';
import AiTickerChartModal from './AiTickerChartModal';
import Pnthr300ChartModal from './Pnthr300ChartModal';
import Pnthr300WeightsModal from './Pnthr300WeightsModal';
import { fetchAiUniverse, fetchEarnings, fetchPnthrAi300Latest, fetchAiSectorRotation } from '../services/api';
import { getCalendarWeekWindow } from '../utils/dateUtils';
import styles from './JunglePage.module.css';
import pantherHead from '../assets/panther head.png';

// ── PNTHR AI 300 header strip ───────────────────────────────────────────────
// Live snapshot of the proprietary index. Clickable → opens Pnthr300ChartModal.
// Polls /api/pnthr-ai-300 every 30s — matches the server's 30s LATEST_CACHE_MS
// so each tick pulls a freshly recomputed live overlay (constituent quotes ×
// stored weights → live index value).
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
    const id = setInterval(load, 30000);
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
        {data.dayChangePct >= 0 ? '▲' : '▼'}
        {data.dayChangePoints != null && (
          <> {data.dayChangePoints >= 0 ? '+' : ''}{data.dayChangePoints.toFixed(2)}</>
        )}
        {' '}
        ({data.dayChangePct >= 0 ? '+' : ''}{data.dayChangePct?.toFixed(2)}%) today
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
  const [sectorRanks, setSectorRanks]     = useState(null); // sector rotation rank doc
  const [fundMeta, setFundMeta]           = useState(null);
  const [earnings, setEarnings]           = useState({});
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState(null);
  const [sectorFilter, setSectorFilter]   = useState('all'); // 'all' | sectorId number
  const [searchQuery, setSearchQuery]     = useState('');    // ticker or company name filter
  const [groupBySector, setGroupBySector] = useState(false);
  // Sector chip row expand/collapse — persisted across sessions so Scott's
  // preference sticks. Default expanded for first-time users (no key yet).
  const [sectorChipsExpanded, setSectorChipsExpanded] = useState(() => {
    try {
      const v = localStorage.getItem('aiJungle.sectorChipsExpanded');
      return v === null ? true : v === '1';
    } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem('aiJungle.sectorChipsExpanded', sectorChipsExpanded ? '1' : '0'); } catch { /* ignore */ }
  }, [sectorChipsExpanded]);
  const [chartTickers, setChartTickers]   = useState([]);    // sorted ticker list as displayed in the table
  const [chartIndex, setChartIndex]       = useState(0);
  const [showIndexChart, setShowIndexChart] = useState(false);
  const [showWeights, setShowWeights]       = useState(false);

  function load(forceRefresh = false, { silent = false } = {}) {
    if (!silent) setLoading(true);
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
        if (!silent) setError('Failed to load AI Universe. Please try again.');
      })
      .finally(() => { if (!silent) setLoading(false); });
  }

  // Initial load + 30s auto-refresh. Server cache is also 30s, so each tick
  // pulls a freshly-fetched FMP /quote batch (~120 calls/hour during RTH).
  // Silent option keeps the spinner from blinking every cycle.
  useEffect(() => {
    load();
    fetchAiSectorRotation().then(setSectorRanks).catch(() => {});
    const id = setInterval(() => load(false, { silent: true }), 30000);
    return () => clearInterval(id);
  }, []);

  // Counts by sectorId from current stock list (live, not from sectors metadata —
  // so the count reflects what FMP actually priced today).
  const counts = useMemo(() => {
    const out = { all: stocks.length };
    for (const s of stocks) {
      out[s.sectorId] = (out[s.sectorId] || 0) + 1;
    }
    return out;
  }, [stocks]);

  // 16-step palettes — LOCKED. Use for any ranked sector visualization.
  // Greens: index 0 = darkest forest, index 15 = lightest emerald
  const SECTOR_GREENS = [
    '#0B3D0B', '#104D10', '#155D15', '#1A6D1A',
    '#1F7D1F', '#248D24', '#299D29', '#2EAD2E',
    '#35BA35', '#3FC53F', '#4ACE4A', '#56D656',
    '#63DD63', '#70E370', '#7DE97D', '#8BEF8B',
  ];
  // Reds: index 0 = lightest salmon, index 15 = darkest blood red
  const SECTOR_REDS = [
    '#E08080', '#D97272', '#D16464', '#C95656',
    '#C14949', '#B93D3D', '#B03232', '#A62828',
    '#9B2020', '#8F1A1A', '#831515', '#761111',
    '#690D0D', '#5C0A0A', '#4F0707', '#420505',
  ];

  // Sectors sorted by 5D return (most bullish first) with gradient colors
  const sortedSectors = useMemo(() => {
    if (!sectors.length) return [];
    const rankMap = {};
    if (sectorRanks?.ranks) {
      for (const r of sectorRanks.ranks) {
        rankMap[r.sectorId] = r;
      }
    }
    const sorted = sectors.slice().sort((a, b) => {
      const ra = rankMap[a.id]?.fiveDayReturn ?? -Infinity;
      const rb = rankMap[b.id]?.fiveDayReturn ?? -Infinity;
      return rb - ra;
    });
    const bullish = sorted.filter(s => (rankMap[s.id]?.fiveDayReturn ?? 0) >= 0);
    const bearish = sorted.filter(s => (rankMap[s.id]?.fiveDayReturn ?? 0) < 0);

    return sorted.map(sec => {
      const rank = rankMap[sec.id];
      const ret = rank?.fiveDayReturn ?? 0;
      let bg;
      if (ret >= 0) {
        const idx = bullish.indexOf(sec);
        const step = bullish.length > 1 ? Math.round(idx * 15 / (bullish.length - 1)) : 0;
        bg = SECTOR_GREENS[step];
      } else {
        const idx = bearish.indexOf(sec);
        const step = bearish.length > 1 ? Math.round(idx * 15 / (bearish.length - 1)) : 15;
        bg = SECTOR_REDS[step];
      }
      return { ...sec, bg, color: '#fff', fiveDayReturn: rank?.fiveDayReturn, tier: rank?.tier };
    });
  }, [sectors, sectorRanks]);

  // Compose sector filter + search filter. Sector chips narrow the universe;
  // the search box matches ticker prefix OR company name substring (case-
  // insensitive), mirroring PNTHR Search's match style. Empty query = no
  // search filter applied.
  const filteredStocks = useMemo(() => {
    let list = (sectorFilter === 'all')
      ? stocks
      : stocks.filter(s => s.sectorId === sectorFilter);
    const q = searchQuery.trim().toUpperCase();
    if (q) {
      list = list.filter(s => {
        const ticker = (s.ticker || '').toUpperCase();
        const name   = (s.companyName || '').toUpperCase();
        return ticker.startsWith(q) || name.includes(q);
      });
    }
    return list;
  }, [stocks, sectorFilter, searchQuery]);

  function handleTickerClick(_stock, sortedIdx, sortedStocks) {
    // StockTable hands back the currently-displayed sort order so the
    // ◀ / ▶ nav inside the modal walks tickers in the same order Scott sees.
    setChartTickers((sortedStocks || []).map(s => s.ticker));
    setChartIndex(sortedIdx);
  }

  const totalCount = stocks.length;
  const sectorCount = sectors.length;
  const versionLabel = fundMeta?.version ? `${fundMeta.version}` : '';

  // Earnings highlight window — synchronized with PNTHR Calendar so any AI 300
  // stock reporting "this week" (or "next week" once we cross Thursday) lights
  // up yellow on this page in lockstep with what Calendar shows. Memoized with
  // an empty dep list so the window is captured on mount; re-renders within
  // the same session don't shift the window mid-day.
  const earningsHighlightWindow = useMemo(() => getCalendarWeekWindow(), []);

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
          {!loading && !error && stocks.length > 0 && (
            <div className={styles.headerSearchWrap}>
              <span className={styles.headerSearchIcon} aria-hidden="true">⌕</span>
              <input
                type="text"
                className={styles.headerSearchInput}
                placeholder="Search AI 300 ticker or company…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              {searchQuery && (
                <button
                  type="button"
                  className={styles.headerSearchClear}
                  onClick={() => setSearchQuery('')}
                  title="Clear search"
                  aria-label="Clear search"
                >×</button>
              )}
            </div>
          )}
          {!loading && !error && stocks.length > 0 && (
            <button
              className={styles.sectorToggle}
              onClick={() => setSectorChipsExpanded(v => !v)}
              title={sectorChipsExpanded ? 'Hide sector chips' : 'Show sector chips'}
            >
              {sectorChipsExpanded ? '▾' : '▸'} Sectors
              {sectorFilter !== 'all' && (
                <span className={styles.sectorTogglePill}>{counts[sectorFilter] ?? 0}</span>
              )}
            </button>
          )}
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

      {!loading && !error && searchQuery && (
        <div className={styles.aiSearchResultRow}>
          {filteredStocks.length} match{filteredStocks.length === 1 ? '' : 'es'}
          {sectorFilter !== 'all' && ' in selected sector'}
          {' for '}
          <strong>"{searchQuery}"</strong>
        </div>
      )}

      {!loading && !error && stocks.length > 0 && sectorChipsExpanded && (
        <div className={styles.filterRow}>
          <button
            key="all"
            className={`${styles.filterBtn} ${sectorFilter === 'all' ? styles.filterBtnActive : ''}`}
            onClick={() => setSectorFilter('all')}
          >
            Full AI Jungle
            <span className={styles.filterCount}>{counts.all}</span>
          </button>
          {sortedSectors.map(sec => (
            <button
              key={sec.id}
              className={`${styles.filterBtn} ${sectorFilter === sec.id ? styles.filterBtnActive : ''}`}
              onClick={() => setSectorFilter(sec.id)}
              title={`${sec.tier || '—'} · 5D return: ${sec.fiveDayReturn != null ? (sec.fiveDayReturn * 100).toFixed(2) + '%' : '—'}`}
              style={sectorFilter !== sec.id ? { background: sec.bg, color: sec.color, borderColor: 'transparent' } : undefined}
            >
              {sec.name}
              <span className={styles.filterCount} style={sectorFilter !== sec.id ? { color: 'rgba(255,255,255,0.8)' } : undefined}>{counts[sec.id] ?? 0}</span>
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
          earningsHighlightWindow={earningsHighlightWindow}
          groupBySector={groupBySector}
          hideExchange
          weeklySignalLabel="PNTHR Weekly Signal"
          showDailySignal
          showKillScore
          onTickerClick={handleTickerClick}
          scanType="long"
        />
      )}

      {!loading && !error && stocks.length > 0 && filteredStocks.length === 0 && (
        <div className={styles.aiNoResults}>
          No AI 300 stocks match
          {searchQuery ? <> "<strong>{searchQuery}</strong>"</> : null}
          {sectorFilter !== 'all' ? ' in this sector' : null}.
          {searchQuery && (
            <button className={styles.aiNoResultsClear} onClick={() => setSearchQuery('')}>
              Clear search
            </button>
          )}
        </div>
      )}

      {chartTickers.length > 0 && (
        <AiTickerChartModal
          tickers={chartTickers}
          initialIndex={chartIndex}
          onClose={() => setChartTickers([])}
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
