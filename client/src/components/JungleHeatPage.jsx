import { useState, useEffect, useMemo } from 'react';
import { apiFetch, authHeaders, API_BASE } from '../services/api';
import AiTickerChartModal from './AiTickerChartModal';
import pantherHead from '../assets/panther head.png';
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

function getFcfColor(fcf) {
  if (fcf == null) return '#666';
  if (fcf > 50_000_000) return '#00c853';
  if (fcf > 0) return '#69f0ae';
  if (fcf > -50_000_000) return '#ffd600';
  return '#ff5252';
}

function getFcfLabel(fcf) {
  if (fcf == null) return 'No FCF data';
  if (fcf > 50_000_000) return `FCF: +$${(fcf / 1e9).toFixed(1)}B`;
  if (fcf > 0) return `FCF: +$${(fcf / 1e6).toFixed(0)}M`;
  if (fcf > -50_000_000) return `FCF: -$${(Math.abs(fcf) / 1e6).toFixed(0)}M (breakeven)`;
  return `FCF: -$${(Math.abs(fcf) / 1e9).toFixed(1)}B`;
}

function getPeColor(pe) {
  if (pe == null) return '#666';
  if (pe <= 0) return '#b71c1c';
  if (pe < 15) return '#00c853';
  if (pe < 25) return '#69f0ae';
  if (pe < 40) return '#ffd600';
  if (pe < 60) return '#ff9800';
  return '#ff5252';
}

function getPegColor(peg) {
  if (peg == null) return '#666';
  if (peg <= 0) return '#b71c1c';
  if (peg < 1) return '#00c853';
  if (peg < 1.5) return '#69f0ae';
  if (peg < 2) return '#ffd600';
  if (peg < 3) return '#ff9800';
  return '#ff5252';
}

function SectorGrid({ sector, fcfMap, valMap, onTickerClick }) {
  const tickers = sector.holdings.map(h => h.ticker);
  return (
    <div className={styles.sectorBlock}>
      <div className={styles.sectorHeader}>
        <span className={styles.sectorName}>{sector.name}</span>
        <span className={styles.sectorCount} style={{ marginLeft: 8, fontSize: 11, color: '#888' }}>
          ({sector.holdings.length})
        </span>
        <span className={`${styles.sectorAvg} ${sector.avgChange >= 0 ? styles.sectorAvgUp : styles.sectorAvgDown}`}>
          {sector.avgChange != null ? `${sector.avgChange > 0 ? '+' : ''}${sector.avgChange.toFixed(2)}%` : '—'}
        </span>
      </div>
      <div className={styles.tickerGrid}>
        {sector.holdings.map((h, i) => {
          const bg = getHeatColor(h.changePct);
          const color = getTextColor(h.changePct);
          const fcf = fcfMap[h.ticker];
          const fcfColor = getFcfColor(fcf);
          const v = valMap?.[h.ticker];
          const pe = v?.forwardPE;
          const peg = v?.peg;
          return (
            <div
              key={h.ticker}
              className={styles.tickerCell}
              style={{ backgroundColor: bg, color, cursor: 'pointer' }}
              title={`${h.name}\n${h.changePct != null ? `${h.changePct > 0 ? '+' : ''}${h.changePct.toFixed(2)}%` : 'No data'}\n${getFcfLabel(fcf)}\nClick to view chart`}
              onClick={() => onTickerClick(tickers, i)}
            >
              <div className={styles.tickerSymbol}>{h.ticker}</div>
              <div className={styles.tickerChange}>
                {h.changePct != null ? `${h.changePct > 0 ? '+' : ''}${h.changePct.toFixed(1)}%` : '—'}
              </div>
              <div className={styles.valPills}>
                <span className={styles.fcfBill} style={{ backgroundColor: fcfColor }} title={getFcfLabel(fcf)}>$</span>
                <span className={styles.valPill} style={{ backgroundColor: getPeColor(pe), color: pe != null && pe <= 0 ? '#fff' : '#000' }} title={pe != null ? `P/E: ${pe.toFixed(1)}x` : 'P/E: N/A'}>▸PE{pe == null ? '' : pe <= 0 ? ' N/E' : ` ${pe.toFixed(0)}`}</span>
                <span className={styles.valPill} style={{ backgroundColor: getPegColor(peg), color: peg != null && peg <= 0 ? '#fff' : '#000' }} title={peg != null ? `PEG: ${peg.toFixed(2)}` : 'PEG: N/A'}>PEG{peg == null ? '' : peg <= 0 ? ' N/E' : ` ${peg.toFixed(1)}`}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function JungleHeatPage() {
  const [data, setData] = useState(null);
  const [fcfMap, setFcfMap] = useState({});
  const [valMap, setValMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [chartStocks, setChartStocks] = useState([]);
  const [chartIndex, setChartIndex] = useState(null);

  const load = async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const [heatRes, fcfRes, valRes] = await Promise.all([
        apiFetch(`${API_BASE}/api/jungle-heat${refresh ? '?refresh=1' : ''}`, { headers: authHeaders() }),
        apiFetch(`${API_BASE}/api/jungle-heat/fcf`, { headers: authHeaders() }),
        apiFetch(`${API_BASE}/api/jungle-heat/valuation`, { headers: authHeaders() }),
      ]);
      if (!heatRes.ok) throw new Error(`HTTP ${heatRes.status}`);
      const json = await heatRes.json();
      setData(json);
      if (fcfRes.ok) setFcfMap(await fcfRes.json() || {});
      if (valRes.ok) setValMap(await valRes.json() || {});
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
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>
            <img src={pantherHead} alt="PNTHR" className={styles.pantherLogo} />
            PNTHR HEAT
          </h1>
          <p className={styles.pageSubtitle}>679 Jungle stock heat map — daily performance by GICS sector with FCF, P/E, and PEG valuation overlays.</p>
        </div>
        <div className={styles.headerControls}>
          {data?.breadth && (
            <div style={{ display: 'flex', gap: 12, fontSize: 12, marginRight: 16 }}>
              <span style={{ color: '#4caf50' }}>{data.breadth.advancers} ▲</span>
              <span style={{ color: '#f44336' }}>{data.breadth.decliners} ▼</span>
              <span style={{ color: '#888' }}>{data.breadth.unchanged} —</span>
              <span style={{ color: '#aaa' }}>({data.breadth.total} total)</span>
            </div>
          )}
          <button className={styles.refreshBtn} onClick={() => load(true)} disabled={loading}>
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>
          {data?.updatedAt && (
            <span className={styles.timestamp}>
              Updated: {new Date(data.updatedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {data && (
        <div className={styles.sectorsContainer}>
          {sortedSectors.map(s => <SectorGrid key={s.id} sector={s} fcfMap={fcfMap} valMap={valMap} onTickerClick={(tickers, idx) => { setChartStocks(tickers.map(t => ({ ticker: t }))); setChartIndex(idx); }} />)}
        </div>
      )}

      {loading && !data && (
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <p>Loading 679 heat map...</p>
        </div>
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
