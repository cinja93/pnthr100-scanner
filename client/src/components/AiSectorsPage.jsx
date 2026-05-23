import { useState, useEffect, useMemo, useRef } from 'react';
import { createChart, LineSeries } from 'lightweight-charts';
import { fetchPnthrAiSectorsLatest, fetchPnthrAiSectorBars } from '../services/api';
import AiSectorChartModal from './AiSectorChartModal';
import PageHeader from './PageHeader';
import junglePageStyles from './JunglePage.module.css';

function fmtNum(n) {
  if (n == null) return '—';
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(n) {
  if (n == null) return '—';
  const s = n >= 0 ? '+' : '';
  return `${s}${n.toFixed(2)}%`;
}

const TIME_RANGES = [
  { key: '5d',  label: '5 Days',  days: 5,   timeframe: 'daily' },
  { key: '30d', label: '30 Days', days: 30,  timeframe: 'daily' },
  { key: '90d', label: '90 Days', days: 90,  timeframe: 'daily' },
  { key: '1y',  label: '1 Year',  days: 252, timeframe: 'weekly' },
  { key: 'all', label: 'All',     days: null, timeframe: 'weekly' },
];

// ── Mini-chart (one per card): close + EMA, no axes, no decoration ──────────
function SectorMiniChart({ sectorId, timeRange, onPeriodReturn }) {
  const ref = useRef(null);

  useEffect(() => {
    let cancelled = false;
    let chart;
    const range = TIME_RANGES.find(r => r.key === timeRange) || TIME_RANGES[4];

    fetchPnthrAiSectorBars(sectorId, range.timeframe, range.days)
      .then(d => {
        if (cancelled || !ref.current || !d.ok || !d.bars?.length) return;
        chart = createChart(ref.current, {
          autoSize: true,
          layout: { background: { color: 'transparent' }, textColor: '#666', attributionLogo: false, fontSize: 9 },
          grid: { vertLines: { visible: false }, horzLines: { visible: false } },
          rightPriceScale: { visible: false },
          leftPriceScale:  { visible: false },
          timeScale: { visible: false },
          crosshair: { mode: 0, vertLine: { visible: false }, horzLine: { visible: false } },
          handleScroll: false, handleScale: false,
        });
        const closeSeries = chart.addSeries(LineSeries, {
          color: '#16a34a', lineWidth: 2,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        });
        const emaSeries = chart.addSeries(LineSeries, {
          color: '#fcf000', lineWidth: 1.5,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        });
        const last = d.bars[d.bars.length - 1];
        const lastEma = [...d.bars].reverse().find(b => b.ema != null)?.ema;
        if (last?.close && lastEma != null) {
          closeSeries.applyOptions({ color: last.close >= lastEma ? '#16a34a' : '#dc2626' });
        }
        closeSeries.setData(d.bars.map(b => ({ time: b.date, value: b.close })));
        emaSeries.setData(d.bars.filter(b => b.ema != null).map(b => ({ time: b.date, value: b.ema })));
        chart.timeScale().fitContent();

        // Compute period return from first to last bar in the fetched range
        if (onPeriodReturn && d.bars.length >= 2) {
          const first = d.bars[0];
          const pctChange = ((last.close - first.close) / first.close) * 100;
          onPeriodReturn(pctChange);
        }
      })
      .catch(() => {});

    return () => { cancelled = true; if (chart) chart.remove(); };
  }, [sectorId, timeRange]);

  return <div ref={ref} style={{ width: '100%', height: 80 }} />;
}

// ── Sector card ─────────────────────────────────────────────────────────────
function SectorCard({ sector, rank, timeRange, onClick }) {
  const [periodReturn, setPeriodReturn] = useState(null);

  // Reset period return when timeRange changes
  useEffect(() => { setPeriodReturn(null); }, [timeRange]);

  if (!sector.ok) {
    return (
      <div style={{ padding: 12, background: '#0a0a0a', border: '1px solid #2a2a2a', borderRadius: 6 }}>
        <div style={{ color: '#fcf000', fontSize: 12, fontWeight: 700 }}>{sector.name}</div>
        <div style={{ color: '#666', fontSize: 10, marginTop: 6 }}>No data yet</div>
      </div>
    );
  }
  const dayChangeColor = sector.dayChangePct >= 0 ? '#16a34a' : '#dc2626';
  const regimeColor    = sector.regime === 'bull' ? '#16a34a' : '#dc2626';
  const isAll = timeRange === 'all';
  const rangeLabel = TIME_RANGES.find(r => r.key === timeRange)?.label || 'All';
  const periodColor = periodReturn != null ? (periodReturn >= 0 ? '#16a34a' : '#dc2626') : '#888';

  return (
    <button
      onClick={onClick}
      title={`Open full chart for ${sector.name} (target weight ${sector.targetWeight}%)`}
      style={{
        padding: 12, textAlign: 'left',
        background: 'linear-gradient(180deg, #1a1a1a 0%, #0a0a0a 100%)',
        border: '1px solid #2a2a2a', borderRadius: 6,
        cursor: 'pointer', fontFamily: 'inherit', display: 'flex', flexDirection: 'column', gap: 8,
        transition: 'border-color 0.15s, transform 0.15s',
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = '#fcf000'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = '#2a2a2a'; e.currentTarget.style.transform = 'translateY(0)'; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: '#666', fontSize: 10, fontFamily: 'monospace', minWidth: 20 }}>#{rank}</span>
        <span style={{ color: '#fcf000', fontSize: 12, fontWeight: 700, lineHeight: 1.2, flex: 1 }}>
          {sector.name}
        </span>
        {periodReturn != null && (
          <span style={{
            padding: '2px 6px', borderRadius: 3, fontSize: 9, fontWeight: 700,
            background: periodReturn >= 0 ? '#16a34a' : '#dc2626', color: '#fff', letterSpacing: '0.04em',
          }}>
            {periodReturn >= 0 ? 'BULL' : 'BEAR'}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontFamily: 'monospace' }}>
        <span style={{ color: '#fff', fontSize: 16, fontWeight: 700 }}>{fmtNum(sector.value)}</span>
        <span style={{ color: dayChangeColor, fontSize: 11, fontWeight: 600 }}>{fmtPct(sector.dayChangePct)}</span>
      </div>

      <SectorMiniChart sectorId={sector.id} timeRange={timeRange} onPeriodReturn={setPeriodReturn} />

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, fontFamily: 'monospace' }}>
        {isAll ? (
          <>
            <span style={{ color: '#888' }}>YTD <strong style={{ color: (sector.ytdPct ?? 0) >= 0 ? '#16a34a' : '#dc2626' }}>{fmtPct(sector.ytdPct)}</strong></span>
            <span style={{ color: '#888' }}>Since launch <strong style={{ color: sector.inceptionPct >= 0 ? '#16a34a' : '#dc2626' }}>{fmtPct(sector.inceptionPct)}</strong></span>
          </>
        ) : (
          <>
            <span style={{ color: '#888' }}>{rangeLabel} <strong style={{ color: periodColor }}>{periodReturn != null ? fmtPct(periodReturn) : '…'}</strong></span>
            <span style={{ color: '#888' }}>Day <strong style={{ color: dayChangeColor }}>{fmtPct(sector.dayChangePct)}</strong></span>
          </>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#666', fontFamily: 'monospace', marginTop: -2 }}>
        <span>{sector.holdingCount} holdings · target {sector.targetWeight}%</span>
        <span>{sector.emaWeeklyPeriod}W OpEMA {fmtNum(sector.emaWeekly)}</span>
      </div>
    </button>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────
export default function AiSectorsPage() {
  const [data, setData]           = useState(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [sortBy, setSortBy]       = useState('inception');
  const [timeRange, setTimeRange] = useState('5d');
  const [openSector, setOpenSector] = useState(null);

  function load(forceRefresh = false, { silent = false } = {}) {
    if (!silent) { setLoading(true); setError(null); }
    fetchPnthrAiSectorsLatest(forceRefresh)
      .then(setData)
      .catch(err => { if (!silent) { console.error(err); setError('Failed to load AI sectors.'); } })
      .finally(() => { if (!silent) setLoading(false); });
  }

  useEffect(() => {
    load();
    const id = setInterval(() => load(false, { silent: true }), 30000);
    return () => clearInterval(id);
  }, []);

  const sortedSectors = useMemo(() => {
    if (!data?.sectors) return [];
    const list = [...data.sectors];
    switch (sortBy) {
      case 'ytd':       list.sort((a, b) => (b.ytdPct ?? -Infinity) - (a.ytdPct ?? -Infinity)); break;
      case 'day':       list.sort((a, b) => (b.dayChangePct ?? -Infinity) - (a.dayChangePct ?? -Infinity)); break;
      case 'name':      list.sort((a, b) => a.name.localeCompare(b.name)); break;
      case 'target':    list.sort((a, b) => (b.targetWeight ?? 0) - (a.targetWeight ?? 0)); break;
      default:          list.sort((a, b) => (b.inceptionPct ?? -Infinity) - (a.inceptionPct ?? -Infinity)); break;
    }
    return list;
  }, [data, sortBy]);

  return (
    <div className={junglePageStyles.page}>
      <PageHeader title="AI 300 Sectors" description="AI-specific sector ETF regime analysis with optimized EMAs." />
      <div className={junglePageStyles.header}>
        <div>
          {!loading && !error && data?.ok && (
            <p className={junglePageStyles.subtitle}>
              16 synthetic sector indices · capped market-cap weighted · monthly rebalance · base {data.baseDate} = {fmtNum(data.baseValue)} · as of {data.asOf}
            </p>
          )}
        </div>
        <div className={junglePageStyles.headerActions}>
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
            disabled={loading}
            style={{
              padding: '6px 10px', fontSize: 12, fontWeight: 600,
              background: '#111', border: '1px solid #2a2a2a', borderRadius: 4,
              color: '#d4d4d4', cursor: 'pointer',
            }}
          >
            <option value="inception">Sort: Since launch ↓</option>
            <option value="ytd">Sort: YTD ↓</option>
            <option value="day">Sort: Day change ↓</option>
            <option value="target">Sort: Target weight ↓</option>
            <option value="name">Sort: Name A-Z</option>
          </select>
          <button className={junglePageStyles.refreshBtn} onClick={() => load(true)} disabled={loading}>
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {/* ── Time range selector ──────────────────────────────────────── */}
      <div style={{
        display: 'flex', gap: 4, padding: '8px 0',
        borderBottom: '1px solid #1a1a1a',
      }}>
        {TIME_RANGES.map(r => (
          <button
            key={r.key}
            onClick={() => setTimeRange(r.key)}
            style={{
              padding: '6px 14px', fontSize: 12, fontWeight: 700,
              fontFamily: 'inherit', cursor: 'pointer',
              borderRadius: 4, border: 'none',
              background: timeRange === r.key ? '#fcf000' : '#1a1a1a',
              color: timeRange === r.key ? '#000' : '#888',
              transition: 'background 0.15s, color 0.15s',
            }}
          >
            {r.label}
          </button>
        ))}
      </div>

      {loading && (
        <div className={junglePageStyles.loadingState}>
          <div className={junglePageStyles.spinner} />
          <p>Loading 16 AI sector indices…</p>
        </div>
      )}

      {error && <div className={junglePageStyles.errorState}>{error}</div>}

      {!loading && !error && data?.ok && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 12,
          padding: '12px 0',
        }}>
          {sortedSectors.map((s, i) => (
            <SectorCard key={s.id} sector={s} rank={i + 1} timeRange={timeRange} onClick={() => setOpenSector(s)} />
          ))}
        </div>
      )}

      {openSector && (
        <AiSectorChartModal
          sector={openSector}
          onClose={() => setOpenSector(null)}
        />
      )}
    </div>
  );
}
