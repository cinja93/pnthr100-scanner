import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../AuthContext';
import { fetchLatestAiKill, runAiKill, fetchNav } from '../services/api';
import AiTickerChartModal from './AiTickerChartModal';
import { computeWeeksAgo } from '../utils/dateUtils';
import { sizePosition, isEtfTicker } from '../utils/sizingUtils';
import pantherHead from '../assets/panther head.png';
import styles from './AiKillPage.module.css';

const TIERS = [
  { name: 'ALPHA AI KILL', color: '#15803d', textColor: '#ffffff' },
  { name: 'STRIKING',      color: '#16a34a', textColor: '#ffffff' },
  { name: 'HUNTING',       color: '#22c55e', textColor: '#111111' },
  { name: 'POUNCING',      color: '#86efac', textColor: '#111111' },
  { name: 'COILING',       color: '#ca8a04', textColor: '#ffffff' },
  { name: 'STALKING',      color: '#eab308', textColor: '#111111' },
  { name: 'TRACKING',      color: '#fde047', textColor: '#111111' },
  { name: 'PROWLING',      color: '#b91c1c', textColor: '#ffffff' },
  { name: 'STIRRING',      color: '#ef4444', textColor: '#ffffff' },
  { name: 'DORMANT',       color: '#fca5a5', textColor: '#111111' },
];

function getTierConfig(tierName) {
  return TIERS.find(t => t.name === tierName) || TIERS[9];
}

function fmtUsd(n) {
  if (n == null || isNaN(n)) return '—';
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

export default function AiKillPage() {
  const { isAdmin } = useAuth();
  const [doc, setDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [tierFilter, setTierFilter] = useState('all');
  const [chartTickers, setChartTickers] = useState([]);
  const [chartIndex, setChartIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState(null);
  const [selectedTicker, setSelectedTicker] = useState(null);
  const [nav, setNav] = useState(100_000);

  useEffect(() => {
    fetchNav()
      .then(d => { if (d?.nav) setNav(d.nav); })
      .catch(() => {});
  }, []);

  const load = () => {
    setLoading(true);
    fetchLatestAiKill()
      .then(d => { setDoc(d); setError(null); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  const scores = useMemo(() => {
    if (!doc?.scores) return [];
    let arr = doc.scores;
    if (filter === 'bl')    arr = arr.filter(s => s.signal === 'BL');
    if (filter === 'ss')    arr = arr.filter(s => s.signal === 'SS');
    if (filter === 'top10') arr = arr.slice(0, 10);
    if (tierFilter !== 'all') arr = arr.filter(s => s.tierName === tierFilter);
    return arr;
  }, [doc, filter, tierFilter]);

  const onRun = async () => {
    setRunning(true); setRunMsg(null);
    try {
      const r = await runAiKill();
      setRunMsg(`Scored ${r.scoredCount} names`);
      load();
    } catch (e) {
      setRunMsg(`Failed: ${e.message}`);
    } finally { setRunning(false); }
  };

  return (
    <div className={styles.page}>
      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>
            <img src={pantherHead} alt="PNTHR" className={styles.pantherLogo} />
            PNTHR AI Kill
          </h1>
          <p className={styles.subtitle}>
            v1 — (D2 + D3 + D4) × D1
            <span style={{
              marginLeft: 10, padding: '3px 8px', background: '#3b82f6', color: '#fff',
              borderRadius: 3, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
            }}>AI 300</span>
          </p>
        </div>
        <div className={styles.headerRight}>
          {isAdmin && (
            <button className={styles.refreshBtn} onClick={onRun} disabled={running}>
              {running ? 'RUNNING…' : 'RECOMPUTE'}
            </button>
          )}
          <button className={styles.refreshBtn} onClick={load} disabled={loading}>
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {/* ── Context Banner ──────────────────────────────────────────── */}
      {doc && (
        <div className={styles.contextBanner}>
          <span style={{ color: '#9ca3af', fontWeight: 600 }}>Week of</span>
          <strong style={{ color: '#fff' }}>{doc.weekOf}</strong>
          {doc.pai300Bull != null && (
            <span style={{
              padding: '3px 8px', borderRadius: 3, fontSize: 10, fontWeight: 700,
              background: doc.pai300Bull ? '#16a34a' : '#dc2626', color: '#fff',
            }}>
              {doc.pai300Bull ? 'PAI300 BULL' : 'PAI300 BEAR'}
            </span>
          )}
          <span className={styles.contextMeta}>
            {doc.generatedAt && `generated ${new Date(doc.generatedAt).toLocaleString()}`}
          </span>
        </div>
      )}

      {/* ── Tier Summary Cards ──────────────────────────────────────── */}
      {doc?.tierBreakdown && (
        <div className={styles.tierCards}>
          {TIERS.map(tier => {
            const count = doc.tierBreakdown[tier.name] || 0;
            const isActive = tierFilter === tier.name;
            return (
              <button
                key={tier.name}
                className={`${styles.tierCard} ${isActive ? styles.tierCardActive : ''}`}
                style={{ borderColor: tier.color }}
                onClick={() => setTierFilter(isActive ? 'all' : tier.name)}
              >
                <span className={styles.tierCardCount} style={{ color: tier.color }}>{count}</span>
                <span className={styles.tierCardName}>{tier.name}</span>
              </button>
            );
          })}
          <button
            className={`${styles.tierCard} ${tierFilter === 'all' ? styles.tierCardActive : ''}`}
            style={{ borderColor: '#555' }}
            onClick={() => setTierFilter('all')}
          >
            <span className={styles.tierCardCount} style={{ color: '#aaa' }}>{doc?.scoredCount || 0}</span>
            <span className={styles.tierCardName}>ALL TIERS</span>
          </button>
        </div>
      )}

      {/* ── Controls Bar ────────────────────────────────────────────── */}
      <div className={styles.controlsBar}>
        <div className={styles.controlsLeft}>
          {[
            { k: 'all',   label: 'All' },
            { k: 'top10', label: 'Top 10' },
            { k: 'bl',    label: 'BL only' },
            { k: 'ss',    label: 'SS only' },
          ].map(o => (
            <button
              key={o.k}
              className={`${styles.sideTab} ${filter === o.k ? styles.sideTabActive : ''}`}
              onClick={() => setFilter(o.k)}
            >{o.label}</button>
          ))}
        </div>
        <span className={styles.controlsMeta}>
          {scores.length} of {doc?.scoredCount || 0} shown
        </span>
      </div>
      {runMsg && <div style={{ fontSize: 11, color: '#fcf000', marginBottom: 8 }}>{runMsg}</div>}

      {/* ── Loading / Error ─────────────────────────────────────────── */}
      {loading && !doc && (
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <p>Loading scores…</p>
        </div>
      )}
      {error && <div className={styles.errorState}>{error}</div>}

      {/* ── Scores Table ────────────────────────────────────────────── */}
      {scores.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th style={{ textAlign: 'center', width: 68 }}>#</th>
                <th style={{ textAlign: 'center' }}>Kill<br/>Score</th>
                <th>Tier</th>
                <th>Ticker</th>
                <th>Signal</th>
                <th>Sector</th>
                <th style={{ textAlign: 'right' }}>L1<br/>Shares</th>
                <th style={{ textAlign: 'right' }}>Total<br/>Shares</th>
                <th style={{ textAlign: 'right' }}>D1</th>
                <th style={{ textAlign: 'right' }}>D2</th>
                <th style={{ textAlign: 'right' }}>D3</th>
                <th style={{ textAlign: 'right' }}>D4</th>
                <th style={{ textAlign: 'right' }}>Risk %</th>
                <th style={{ textAlign: 'right' }}>Price</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {scores.map((s, idx) => {
                const tier = getTierConfig(s.tierName);
                const isTop10 = s.killRank <= 10;
                const direction = s.signal === 'BL' ? 'LONG' : 'SHORT';
                const sizing = (s.currentPrice && s.stopPrice && nav)
                  ? sizePosition({
                      netLiquidity: nav,
                      entryPrice: s.currentPrice,
                      stopPrice: s.stopPrice,
                      maxGapPct: 0,
                      direction,
                      isETF: isEtfTicker(s.ticker),
                    })
                  : null;
                return (
                  <tr
                    key={s.ticker}
                    className={`${styles.row}${selectedTicker === s.ticker ? ` ${styles.selectedRow}` : ''}${isTop10 ? ` ${styles.top10Row}` : ''}`}
                    onClick={() => setSelectedTicker(s.ticker)}
                  >
                    {/* Kill Rank */}
                    <td className={styles.killRankCell}>{s.killRank}</td>

                    {/* Kill Score — pill badge */}
                    <td className={styles.scoreCell}>
                      <span
                        className={styles.scoreBadge}
                        style={{ background: tier.color, color: tier.textColor }}
                      >
                        {s.total?.toFixed(1)}
                      </span>
                    </td>

                    {/* Tier badge */}
                    <td>
                      <span
                        className={styles.tierBadge}
                        style={{ background: tier.color, color: tier.textColor }}
                      >
                        {s.tierName}
                      </span>
                    </td>

                    {/* Ticker — click opens chart */}
                    <td
                      className={`${styles.tickerCell} ${styles.tickerClickable}`}
                      onClick={e => {
                        e.stopPropagation();
                        const tickers = scores.map(x => x.ticker);
                        setChartTickers(tickers);
                        setChartIndex(tickers.indexOf(s.ticker));
                      }}
                    >
                      <span className={styles.tickerText}>{s.ticker}</span>
                    </td>

                    {/* Signal */}
                    <td>
                      <span className={s.signal === 'BL' ? styles.sigBadgeBL : styles.sigBadgeSS}>
                        {s.signal}
                        {(() => {
                          const n = computeWeeksAgo(s.signalDate, s.lastBarDate);
                          return n != null ? `+${n}` : '';
                        })()}
                      </span>
                    </td>

                    {/* Sector */}
                    <td style={{ fontSize: 12, color: '#666' }}>
                      S{s.sectorId} {s.sectorName?.split(' ').slice(0, 2).join(' ')}
                    </td>

                    {/* L1 Shares */}
                    <td className={styles.dimCell} style={{ fontWeight: 700, color: '#333' }}>
                      {sizing ? sizing.lot1Shares : '—'}
                    </td>

                    {/* Total Lot Shares (L1-L5) */}
                    <td className={styles.dimCell} style={{ fontWeight: 700, color: '#333' }}>
                      {sizing ? sizing.totalShares : '—'}
                    </td>

                    {/* D1 */}
                    <td className={styles.dimCell}>{s.scores?.d1?.toFixed(2)}×</td>

                    {/* D2 */}
                    <td className={`${styles.dimCell} ${s.scores?.d2 > 0 ? styles.positive : s.scores?.d2 < 0 ? styles.negative : ''}`}>
                      {s.scores?.d2}
                    </td>

                    {/* D3 */}
                    <td className={styles.dimCell}>{s.scores?.d3?.toFixed(0)}</td>

                    {/* D4 */}
                    <td className={`${styles.dimCell} ${s.scores?.d4 > 0 ? styles.positive : s.scores?.d4 < 0 ? styles.negative : ''}`}>
                      {s.scores?.d4}
                    </td>

                    {/* Risk % */}
                    <td className={styles.dimCell}>
                      {s.riskPct != null ? `${s.riskPct.toFixed(1)}%` : '—'}
                    </td>

                    {/* Price */}
                    <td className={styles.priceCell}>{fmtUsd(s.currentPrice)}</td>

                    {/* Status */}
                    <td>
                      {s.isNewSignal
                        ? <span style={{ color: '#b45309', fontWeight: 700, fontSize: 10, letterSpacing: '0.04em' }}>★ NEW</span>
                        : <span style={{ color: '#aaa', fontSize: 10 }}>—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <div className={styles.footer}>
        Score = (D2 + D3 + D4) × D1.
        D1 PAI300 36W regime mult (0.7×–1.3×).
        D2 sector tier ±15.
        D3 entry quality 0–85 (conviction + slope + tightness).
        D4 freshness +10 NEW / -1 per week stale.
        D5 D6 D7 D8 set to 0 in v1 (rank-history, daily momentum, AI Prey not built yet).
        Cron refreshes daily ~5:30pm ET.
      </div>

      {chartTickers.length > 0 && (
        <AiTickerChartModal
          tickers={chartTickers}
          initialIndex={chartIndex}
          onClose={() => setChartTickers([])}
        />
      )}
    </div>
  );
}
