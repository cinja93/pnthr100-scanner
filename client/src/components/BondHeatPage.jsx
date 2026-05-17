import { useState, useEffect, useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { apiFetch, authHeaders, API_BASE } from '../services/api';
import styles from './BondHeatPage.module.css';

function getHeatColor(pct) {
  if (pct == null) return '#333';
  if (pct >= 4) return '#00c853';
  if (pct >= 3) return '#00e676';
  if (pct >= 2) return '#69f0ae';
  if (pct >= 1) return '#a5d6a7';
  if (pct >= 0.5) return '#c8e6c9';
  if (pct > 0) return '#e8f5e9';
  if (pct === 0) return '#424242';
  if (pct > -0.5) return '#ffebee';
  if (pct > -1) return '#ffcdd2';
  if (pct > -2) return '#ef9a9a';
  if (pct > -3) return '#e57373';
  if (pct > -4) return '#ef5350';
  return '#d32f2f';
}

function getTextColor(pct) {
  if (pct == null) return '#888';
  if (Math.abs(pct) >= 2) return '#fff';
  return '#111';
}

const CHART_COLORS = { y2: '#4fc3f7', y10: '#ffd600', y30: '#ff7043' };

function formatDateShort(dateStr) {
  if (!dateStr) return '';
  const [, m, d] = dateStr.split('-');
  return `${+m}/${+d}`;
}

function YieldChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className={styles.chartTooltip}>
      <div className={styles.tooltipDate}>{label}</div>
      {payload.map(p => (
        <div key={p.dataKey} style={{ color: p.color }}>
          {p.name}: {p.value != null ? `${p.value.toFixed(3)}%` : '—'}
        </div>
      ))}
    </div>
  );
}

function YieldChart({ data, title, lines, refLines, height = 180, onClick }) {
  return (
    <div className={styles.chartCard} onClick={onClick} style={onClick ? { cursor: 'pointer' } : undefined}>
      <div className={styles.chartTitle}>{title}</div>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#333" />
          <XAxis dataKey="date" tickFormatter={formatDateShort} tick={{ fill: '#888', fontSize: 10 }} interval="preserveStartEnd" minTickGap={40} />
          <YAxis tick={{ fill: '#888', fontSize: 10 }} domain={['auto', 'auto']} tickFormatter={v => `${v}%`} />
          <Tooltip content={<YieldChartTooltip />} />
          {refLines?.map((rl, i) => (
            <ReferenceLine key={i} y={rl.y} stroke={rl.color || '#ff5252'} strokeDasharray="5 3" label={{ value: rl.label, fill: rl.color || '#ff5252', fontSize: 10, position: 'right' }} />
          ))}
          {lines.map(l => (
            <Line key={l.key} type="monotone" dataKey={l.key} name={l.name} stroke={l.color} dot={false} strokeWidth={2} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function ChartModal({ data, chart, onClose }) {
  if (!chart) return null;

  const configs = {
    yields: {
      title: '2Y / 10Y / 30Y Treasury Yields — 2026 YTD',
      lines: [
        { key: 'y2', name: '2-Year', color: CHART_COLORS.y2 },
        { key: 'y10', name: '10-Year', color: CHART_COLORS.y10 },
        { key: 'y30', name: '30-Year', color: CHART_COLORS.y30 },
      ],
      refLines: [
        { y: 4.5, label: '10Y Alert 4.50%', color: '#ffd600' },
        { y: 5.0, label: '30Y Alert 5.00%', color: '#ff7043' },
      ],
    },
    spread: {
      title: '2Y / 10Y Yield Spread — 2026 YTD',
      lines: [
        { key: 'spread', name: '10Y - 2Y Spread', color: '#ce93d8' },
      ],
      refLines: [
        { y: 0, label: 'Inversion', color: '#ef5350' },
      ],
    },
  };

  const cfg = configs[chart];

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modalContent} onClick={e => e.stopPropagation()}>
        <button className={styles.modalClose} onClick={onClose}>✕</button>
        <YieldChart data={data} title={cfg.title} lines={cfg.lines} refLines={cfg.refLines} height={420} />
      </div>
    </div>
  );
}

function BondBanner({ bonds, breadth }) {
  if (!bonds) return null;

  const y10Alert = bonds.y10 >= 4.5;
  const y30Alert = bonds.y30 >= 5.0;

  return (
    <div className={styles.bondBanner}>
      <div className={styles.bondSection}>
        <div className={styles.bondLabel}>10-Year Treasury</div>
        <div className={`${styles.bondYield} ${y10Alert ? styles.alert : ''}`}>
          {bonds.y10 != null ? `${bonds.y10.toFixed(2)}%` : '—'}
        </div>
        {bonds.y10Change != null && (
          <div className={`${styles.bondChange} ${bonds.y10Change > 0 ? styles.yieldUp : styles.yieldDown}`}>
            {bonds.y10Change > 0 ? '+' : ''}{(bonds.y10Change * 100).toFixed(1)} bps
          </div>
        )}
        {y10Alert && <div className={styles.alertTag}>ABOVE 4.50%</div>}
      </div>

      <div className={styles.bondSection}>
        <div className={styles.bondLabel}>30-Year Treasury</div>
        <div className={`${styles.bondYield} ${y30Alert ? styles.alert : ''}`}>
          {bonds.y30 != null ? `${bonds.y30.toFixed(2)}%` : '—'}
        </div>
        {bonds.y30Change != null && (
          <div className={`${styles.bondChange} ${bonds.y30Change > 0 ? styles.yieldUp : styles.yieldDown}`}>
            {bonds.y30Change > 0 ? '+' : ''}{(bonds.y30Change * 100).toFixed(1)} bps
          </div>
        )}
        {y30Alert && <div className={styles.alertTag}>ABOVE 5.00%</div>}
      </div>

      <div className={styles.bondSection}>
        <div className={styles.bondLabel}>Spread (30Y - 10Y)</div>
        <div className={styles.bondYield}>
          {bonds.y30 != null && bonds.y10 != null
            ? `${(bonds.y30 - bonds.y10).toFixed(2)}%`
            : '—'}
        </div>
      </div>

      <div className={styles.breadthSection}>
        <div className={styles.bondLabel}>AI 300 Breadth</div>
        <div className={styles.breadthRow}>
          <span className={styles.advancers}>{breadth.advancers} up</span>
          <span className={styles.decliners}>{breadth.decliners} down</span>
          {breadth.unchanged > 0 && <span className={styles.unchanged}>{breadth.unchanged} flat</span>}
        </div>
      </div>
    </div>
  );
}

function SectorGrid({ sector }) {
  return (
    <div className={styles.sectorBlock}>
      <div className={styles.sectorHeader}>
        <span className={styles.sectorName}>{sector.name}</span>
        <span className={`${styles.sectorAvg} ${sector.avgChange >= 0 ? styles.sectorAvgUp : styles.sectorAvgDown}`}>
          {sector.avgChange != null ? `${sector.avgChange > 0 ? '+' : ''}${sector.avgChange.toFixed(2)}%` : '—'}
        </span>
      </div>
      <div className={styles.tickerGrid}>
        {sector.holdings.map(h => {
          const bg = getHeatColor(h.changePct);
          const color = getTextColor(h.changePct);
          return (
            <div key={h.ticker} className={styles.tickerCell} style={{ backgroundColor: bg, color }} title={`${h.name}\n${h.changePct != null ? `${h.changePct > 0 ? '+' : ''}${h.changePct.toFixed(2)}%` : 'No data'}`}>
              <div className={styles.tickerSymbol}>{h.ticker}</div>
              <div className={styles.tickerChange}>
                {h.changePct != null ? `${h.changePct > 0 ? '+' : ''}${h.changePct.toFixed(1)}%` : '—'}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function BondHeatPage() {
  const [data, setData] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [modalChart, setModalChart] = useState(null);

  const load = async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const [heatRes, histRes] = await Promise.all([
        apiFetch(`${API_BASE}/api/bond-heat${refresh ? '?refresh=1' : ''}`, { headers: authHeaders() }),
        apiFetch(`${API_BASE}/api/bond-heat/history`, { headers: authHeaders() }),
      ]);
      if (!heatRes.ok) throw new Error(`HTTP ${heatRes.status}`);
      const json = await heatRes.json();
      setData(json);
      if (histRes.ok) {
        const histJson = await histRes.json();
        setHistory(Array.isArray(histJson) ? histJson : []);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const sortedSectors = useMemo(() => {
    if (!data?.sectors) return [];
    return [...data.sectors].sort((a, b) => (b.avgChange || 0) - (a.avgChange || 0));
  }, [data]);

  return (
    <div className={styles.container}>
      <div className={styles.headerRow}>
        <h1 className={styles.title}>PNTHR Bond Heat</h1>
        <button className={styles.refreshBtn} onClick={() => load(true)} disabled={loading}>
          {loading ? '⏳ Loading...' : '🔄 Refresh'}
        </button>
        {data?.updatedAt && (
          <span className={styles.timestamp}>
            Updated: {new Date(data.updatedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {data && (
        <>
          <BondBanner bonds={data.bonds} breadth={data.breadth} />

          {history.length > 0 && (
            <div className={styles.chartsRow}>
              <YieldChart
                data={history}
                title="2Y / 10Y / 30Y Yields — 2026 YTD"
                lines={[
                  { key: 'y2', name: '2-Year', color: CHART_COLORS.y2 },
                  { key: 'y10', name: '10-Year', color: CHART_COLORS.y10 },
                  { key: 'y30', name: '30-Year', color: CHART_COLORS.y30 },
                ]}
                refLines={[
                  { y: 4.5, label: '4.50%', color: '#ffd600' },
                  { y: 5.0, label: '5.00%', color: '#ff7043' },
                ]}
                onClick={() => setModalChart('yields')}
              />
              <YieldChart
                data={history}
                title="2Y / 10Y Spread — 2026 YTD"
                lines={[
                  { key: 'spread', name: '10Y - 2Y Spread', color: '#ce93d8' },
                ]}
                refLines={[
                  { y: 0, label: 'Inversion', color: '#ef5350' },
                ]}
                onClick={() => setModalChart('spread')}
              />
            </div>
          )}

          <div className={styles.sectorsContainer}>
            {sortedSectors.map(s => <SectorGrid key={s.id} sector={s} />)}
          </div>
        </>
      )}

      {loading && !data && (
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <p>Loading AI 300 heat map...</p>
        </div>
      )}

      <ChartModal data={history} chart={modalChart} onClose={() => setModalChart(null)} />
    </div>
  );
}
