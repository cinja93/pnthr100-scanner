import { useState, useEffect } from 'react';
import ChartModal from './ChartModal';
import { fetchApexStocks } from '../services/api';
import styles from './ApexPage.module.css';
import pantherHead from '../assets/panther head.png';

// ── Tier config (mirrors server) ─────────────────────────────────────────────
// Traffic-light palette: dark green → lighter green → dark yellow → lighter yellow → dark red → light red
const TIERS = [
  { name: 'ALPHA PNTHR KILL', tagline: 'Jugular. Teeth in. Alpha PNTHR is Legend.',            color: '#15803d', textColor: '#ffffff' }, // dark green
  { name: 'STRIKING',          tagline: 'Claws out. Contact made. In the kill zone.',           color: '#16a34a', textColor: '#ffffff' }, // green
  { name: 'HUNTING',           tagline: 'Full pursuit mode. Locked and moving fast.',           color: '#22c55e', textColor: '#111111' }, // medium green
  { name: 'POUNCING',          tagline: 'The leap has begun. No turning back.',                 color: '#86efac', textColor: '#111111' }, // light green
  { name: 'COILING',           tagline: 'Body compressed. Energy stored. About to explode.',   color: '#ca8a04', textColor: '#ffffff' }, // dark yellow/gold
  { name: 'STALKING',          tagline: 'Eyes fixed on target. Closing the distance silently.',color: '#eab308', textColor: '#111111' }, // yellow
  { name: 'TRACKING',          tagline: 'Scent picked up. Target identified. Moving with intent.', color: '#fde047', textColor: '#111111' }, // light yellow
  { name: 'PROWLING',          tagline: 'Moving through the jungle. No target yet.',            color: '#b91c1c', textColor: '#ffffff' }, // dark red
  { name: 'STIRRING',          tagline: 'Waking up. Eyes barely open.',                        color: '#ef4444', textColor: '#ffffff' }, // red
  { name: 'DORMANT',           tagline: 'Flat. Sleeping. No signal, no momentum.',             color: '#fca5a5', textColor: '#111111' }, // light red
];

function getTierConfig(tierName) {
  return TIERS.find(t => t.name === tierName) || TIERS[9];
}

// Weeks-ago helper
function computeWeeksAgo(signalDate) {
  if (!signalDate) return null;
  const signalMonday = new Date(signalDate + 'T12:00:00');
  const today = new Date();
  const dow = today.getDay();
  const daysToMonday = dow === 0 ? -6 : 1 - dow;
  const currentMonday = new Date(today);
  currentMonday.setDate(today.getDate() + daysToMonday);
  currentMonday.setHours(0, 0, 0, 0);
  const diffDays = Math.round((currentMonday - signalMonday) / (1000 * 60 * 60 * 24));
  return Math.floor(diffDays / 7) + 1;
}

// Score bar component
function ScoreBar({ score, max, color }) {
  const pct = Math.min(100, Math.round((score / max) * 100));
  return (
    <div className={styles.scoreBarTrack}>
      <div className={styles.scoreBarFill} style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

// Score breakdown tooltip
function ScoreBreakdown({ scores }) {
  const dims = [
    { label: 'Signal Freshness', key: 'freshness',    max: 25 },
    { label: 'Trend Quality',    key: 'trendQuality', max: 20 },
    { label: 'Momentum',         key: 'momentum',     max: 15 },
    { label: 'Rank + Rise',      key: 'rankRise',     max: 20 },
    { label: 'Trend Duration',   key: 'duration',     max: 10 },
    { label: 'Market Context',   key: 'context',      max: 10 },
  ];
  return (
    <div className={styles.breakdown}>
      {dims.map(d => (
        <div key={d.key} className={styles.breakdownRow}>
          <span className={styles.breakdownLabel}>{d.label}</span>
          <ScoreBar score={scores[d.key] || 0} max={d.max} color="#fcf000" />
          <span className={styles.breakdownScore}>{scores[d.key] || 0}/{d.max}</span>
        </div>
      ))}
    </div>
  );
}

export default function ApexPage() {
  const [data, setData]             = useState(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [side, setSide]             = useState('all'); // 'all' | 'long' | 'short'
  const [tierFilter, setTierFilter] = useState('all'); // 'all' or tier name
  const [popup, setPopup]           = useState(null); // { ticker, x, y, scores }
  const [chartIndex, setChartIndex] = useState(null);
  const [chartStocks, setChartStocks] = useState([]);

  useEffect(() => { load(false); }, []);

  async function load(forceRefresh) {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchApexStocks(forceRefresh);
      setData(result);
    } catch (err) {
      setError('Failed to load APEX data. Make sure the server is running.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  const stocks = data?.stocks || [];

  const filtered = stocks.filter(s => {
    if (side === 'long'  && s.signal !== 'BL') return false;
    if (side === 'short' && s.signal !== 'SS') return false;
    if (tierFilter !== 'all' && s.tier !== tierFilter) return false;
    return true;
  });

  function handleRowClick(stock, idx, list) {
    setChartStocks(list);
    setChartIndex(idx);
  }

  // Tier summary cards (top 5 tiers only)
  const topTiers = TIERS.slice(0, 5);

  return (
    <div className={styles.page}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>
            <img src={pantherHead} alt="PNTHR" className={styles.pantherLogo} />
            PNTHR APEX
          </h1>
          <p className={styles.subtitle}>
            679 stocks. 100-point predatory scoring. Who has the PNTHR's attention right now?
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

      {/* ── Loading / Error ─────────────────────────────────────────────────── */}
      {loading && (
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <p>Scoring 679 stocks…</p>
          <p className={styles.loadingNote}>First load takes 1-2 minutes — weekly cached after that.</p>
        </div>
      )}

      {error && !loading && (
        <div className={styles.errorState}>
          <p>{error}</p>
          <button className={styles.retryBtn} onClick={() => load(false)}>Try Again</button>
        </div>
      )}

      {!loading && !error && data && (
        <>
          {/* ── SPY Context Banner ───────────────────────────────────────────── */}
          <div className={styles.contextBanner}>
            <span className={styles.contextLabel}>Broad Market (SPY):</span>
            <span className={data.contextSummary.spyAboveEma ? styles.contextBull : styles.contextBear}>
              {data.contextSummary.spyAboveEma ? '▲ Above EMA' : '▼ Below EMA'}
            </span>
            <span className={data.contextSummary.spyEmaRising ? styles.contextBull : styles.contextBear}>
              {data.contextSummary.spyEmaRising ? '· EMA Rising' : '· EMA Falling'}
            </span>
            <span className={styles.contextMeta}>
              · {data.activeSignals} active signals · {data.totalScanned} total stocks · scanned {new Date(data.scannedAt).toLocaleDateString()}
            </span>
          </div>

          {/* ── Tier Summary Cards ───────────────────────────────────────────── */}
          <div className={styles.tierCards}>
            {topTiers.map(tier => {
              const count = data.tierCounts?.[tier.name] || 0;
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
              <span className={styles.tierCardCount} style={{ color: '#aaa' }}>{stocks.length}</span>
              <span className={styles.tierCardName}>ALL TIERS</span>
            </button>
          </div>

          {/* ── L / S / All Tabs ─────────────────────────────────────────────── */}
          <div className={styles.sideTabs}>
            {[['all', 'All'], ['long', 'Longs (BL)'], ['short', 'Shorts (SS)']].map(([key, label]) => (
              <button
                key={key}
                className={`${styles.sideTab} ${side === key ? styles.sideTabActive : ''}`}
                onClick={() => setSide(key)}
              >
                {label}
                <span className={styles.sideTabCount}>
                  {key === 'all' ? filtered.length
                    : key === 'long' ? stocks.filter(s => s.signal === 'BL' && (tierFilter === 'all' || s.tier === tierFilter)).length
                    : stocks.filter(s => s.signal === 'SS' && (tierFilter === 'all' || s.tier === tierFilter)).length}
                </span>
              </button>
            ))}
          </div>

          {/* ── Table ────────────────────────────────────────────────────────── */}
          {filtered.length === 0 ? (
            <div className={styles.emptyState}>No stocks match the current filters.</div>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Kill Rank</th>
                    <th>Kill Score</th>
                    <th>Tier</th>
                    <th>Ticker</th>
                    <th>Exchange</th>
                    <th>Sector</th>
                    <th>Price</th>
                    <th>YTD</th>
                    <th>Signal</th>
                    <th>Wks</th>
                    <th>PNTHR Rank</th>
                    <th>Score Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((stock, idx) => {
                    const tier = getTierConfig(stock.tier);
                    const wks = computeWeeksAgo(stock.signalDate);
                    return (
                      <tr
                        key={stock.ticker}
                        className={styles.row}
                        onClick={() => handleRowClick(stock, idx, filtered)}
                        title={stock.companyName || stock.ticker}
                      >
                        {/* Kill Rank */}
                        <td className={styles.killRankCell}>{idx + 1}</td>

                        {/* Kill Score */}
                        <td className={styles.scoreCell}>
                          <span
                            className={styles.scoreBadge}
                            style={{ background: tier.color, color: tier.textColor }}
                          >
                            {stock.apexScore}
                          </span>
                        </td>

                        {/* Tier badge */}
                        <td>
                          <span
                            className={styles.tierBadge}
                            style={{ background: tier.color, color: tier.textColor }}
                            title={tier.tagline}
                          >
                            {stock.tier}
                          </span>
                        </td>

                        {/* Ticker + tags */}
                        <td className={styles.tickerCell}>
                          <div className={styles.tickerRow}>
                            {stock.rankList && (
                              <span className={stock.rankList === 'LONG' ? styles.badgeLong : styles.badgeShort}>
                                {stock.rankList === 'LONG' ? 'L' : 'S'}
                              </span>
                            )}
                            <span className={styles.tickerText}>{stock.ticker}</span>
                            {(() => {
                              const tags = [];
                              if (stock.isSp500) tags.push('500');
                              if (stock.isDow30) tags.push('30');
                              if (stock.universe === 'sp400Long' || stock.universe === 'sp400Short') tags.push('400');
                              if (stock.isNasdaq100) tags.push('100');
                              return tags.length > 0
                                ? <span className={styles.membershipTag}>({tags.join(', ')})</span>
                                : null;
                            })()}
                          </div>
                          {stock.companyName && <div className={styles.companyName}>{stock.companyName}</div>}
                        </td>

                        <td>{stock.exchange}</td>
                        <td className={styles.sectorCell}>{stock.sector}</td>

                        {/* Price */}
                        <td className={styles.price}>${stock.currentPrice?.toLocaleString()}</td>

                        {/* YTD */}
                        <td className={stock.ytdReturn != null ? (stock.ytdReturn >= 0 ? styles.positive : styles.negative) : ''}>
                          {stock.ytdReturn != null ? `${stock.ytdReturn >= 0 ? '+' : ''}${stock.ytdReturn.toFixed(2)}%` : '—'}
                        </td>

                        {/* Signal */}
                        <td>
                          {stock.signal === 'BL'
                            ? <span className={styles.sigBadgeBL}>{stock.isNewSignal ? '★ BL' : 'BL'}</span>
                            : stock.signal === 'SS'
                              ? <span className={styles.sigBadgeSS}>{stock.isNewSignal ? '★ SS' : 'SS'}</span>
                              : <span className={styles.sigNone}>—</span>}
                        </td>

                        {/* Weeks since signal */}
                        <td className={styles.wksCell}>
                          {wks != null
                            ? <span className={stock.signal === 'BL' ? styles.wksBL : styles.wksSS}>{stock.signal}+{wks}</span>
                            : '—'}
                        </td>

                        {/* PNTHR 100 Rank */}
                        <td className={styles.rankCell}>
                          {stock.rank != null ? (
                            <span>
                              #{stock.rank}
                              {stock.rankChange === null || stock.rankChange === undefined
                                ? <span className={styles.rankNew}> NEW</span>
                                : stock.rankChange > 0
                                  ? <span className={styles.rankUp}> ▲+{stock.rankChange}</span>
                                  : stock.rankChange < 0
                                    ? <span className={styles.rankDown}> ▼{stock.rankChange}</span>
                                    : null}
                            </span>
                          ) : <span className={styles.noRank}>—</span>}
                        </td>

                        {/* Score Detail hover */}
                        <td
                          className={styles.detailCell}
                          onMouseEnter={(e) => {
                            if (!stock.scores) return;
                            const rect = e.currentTarget.getBoundingClientRect();
                            setPopup({ ticker: stock.ticker, apexScore: stock.apexScore, scores: stock.scores, x: rect.left, y: rect.bottom + 4 });
                          }}
                          onMouseLeave={() => setPopup(null)}
                        >
                          <span className={styles.detailIcon}>📊</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ── Score Breakdown Popup (fixed, avoids overflow clipping) ─────────── */}
      {popup && (
        <div
          className={styles.breakdownPopupFixed}
          style={{ left: Math.max(8, popup.x - 240), top: popup.y }}
          onMouseEnter={() => {/* keep open */}}
        >
          <div className={styles.breakdownTitle}>{popup.ticker} — {popup.apexScore}/100</div>
          <ScoreBreakdown scores={popup.scores} />
        </div>
      )}

      {/* ── Chart Modal ─────────────────────────────────────────────────────── */}
      {chartIndex != null && (
        <ChartModal
          stocks={chartStocks}
          initialIndex={chartIndex}
          signals={Object.fromEntries(chartStocks.map(s => [s.ticker, { signal: s.signal, signalDate: s.signalDate, isNewSignal: s.isNewSignal, stopPrice: s.stopPrice }]))}
          earnings={{}}
          onClose={() => setChartIndex(null)}
        />
      )}
    </div>
  );
}
