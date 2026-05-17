import { useState, useEffect, useMemo } from 'react';
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
  const avgColor = getHeatColor(sector.avgChange);
  const avgTextColor = getTextColor(sector.avgChange);

  return (
    <div className={styles.sectorBlock}>
      <div className={styles.sectorHeader} style={{ backgroundColor: avgColor, color: avgTextColor }}>
        <span className={styles.sectorName}>{sector.name}</span>
        <span className={styles.sectorAvg}>
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const url = `${API_BASE}/api/bond-heat${refresh ? '?refresh=1' : ''}`;
      const res = await apiFetch(url, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
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
    </div>
  );
}
