import { useState, useEffect, useMemo } from 'react';
import StockTable from './StockTable';
import ChartModal from './ChartModal';
import { fetchJungleStocks, fetchEarnings, fetchEarningsSeason } from '../services/api';
import styles from './EarningsWeekPage.module.css';
import pantherHead from '../assets/panther head.png';

// ── Earnings Season Table ────────────────────────────────────────────────────
// Beat / Met / Miss rollup of the current fiscal reporting quarter across S&P
// 500 sectors. Calls /api/earnings-season (server-side 12h cache). Sectors
// with zero reports are rendered muted; row with reports get colored counts
// and % of reported.
function EarningsSeasonTable() {
  const [snap, setSnap]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async ({ refresh = false } = {}) => {
    try {
      if (refresh) setRefreshing(true); else setLoading(true);
      setError(null);
      const data = await fetchEarningsSeason({ refresh });
      setSnap(data);
    } catch (e) {
      setError(e.message || 'Failed to load earnings season');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { load(); }, []);

  const fmtPct    = (n) => n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
  const pctOf     = (n) => n == null ? '' : `(${n.toFixed(1)}%)`;
  const ageLabel  = snap?.cacheAgeMinutes == null
    ? ''
    : snap.cacheAgeMinutes < 60
      ? `${snap.cacheAgeMinutes}m ago`
      : `${Math.floor(snap.cacheAgeMinutes / 60)}h ago`;

  return (
    <div style={{
      background:   '#0c0c0c',
      border:       '1px solid #1e1e1e',
      borderRadius: 8,
      marginBottom: 20,
      overflow:     'hidden',
    }}>
      <div style={{
        padding:     '10px 16px',
        background:  '#111',
        borderBottom: '1px solid #1a1a1a',
        display:     'flex',
        alignItems:  'center',
        gap:         14,
        flexWrap:    'wrap',
      }}>
        <span style={{
          color: '#FCF000', fontSize: 12, fontWeight: 900, letterSpacing: '0.14em',
          fontFamily: "'Inter', 'Segoe UI', sans-serif",
        }}>
          EARNINGS SEASON · {snap?.season || '—'}
        </span>
        {snap && (
          <span style={{ fontSize: 11, color: '#888' }}>
            {snap.totals?.reported ?? 0} of {snap.sp500Count ?? 0} S&P 500 reported
            ({((snap.totals?.reported ?? 0) / Math.max(1, snap.sp500Count ?? 1) * 100).toFixed(1)}%)
          </span>
        )}
        <span style={{ flex: 1 }} />
        {ageLabel && <span style={{ fontSize: 10, color: '#555' }}>cached {ageLabel}</span>}
        <button
          onClick={() => load({ refresh: true })}
          disabled={refreshing}
          style={{
            padding: '4px 10px',
            fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
            background: 'rgba(252,240,0,0.1)',
            color: '#FCF000',
            border: '1px solid rgba(252,240,0,0.35)',
            borderRadius: 4,
            cursor: refreshing ? 'wait' : 'pointer',
            opacity: refreshing ? 0.6 : 1,
          }}
        >{refreshing ? '…REFRESHING' : '↺ REFRESH'}</button>
      </div>

      {loading && !snap && (
        <div style={{ padding: 20, color: '#666', fontSize: 12 }}>Loading earnings season…</div>
      )}
      {error && (
        <div style={{ padding: 20, color: '#dc3545', fontSize: 12 }}>Error: {error}</div>
      )}

      {snap && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{
            width: '100%', borderCollapse: 'collapse', minWidth: 820,
            fontVariantNumeric: 'tabular-nums',
          }}>
            <thead>
              <tr style={{ background: '#0e0e0e', color: '#777', fontSize: 10, letterSpacing: '0.06em' }}>
                <th style={thL}>SECTOR</th>
                <th style={thR}>REPORTED</th>
                <th style={thR}>AVG MISS %</th>
                <th style={thR}>MISS</th>
                <th style={thR}>MET</th>
                <th style={thR}>BEAT</th>
                <th style={thR}>AVG BEAT %</th>
              </tr>
            </thead>
            <tbody>
              {snap.sectors.map(s => {
                const dim = s.reported === 0;
                const rowStyle = { borderTop: '1px solid #161616', color: dim ? '#444' : '#ddd' };
                return (
                  <tr key={s.sector} style={rowStyle}>
                    <td style={{ ...tdL, fontWeight: 700, color: dim ? '#444' : '#e0e0e0' }}>
                      {s.sector}
                    </td>
                    <td style={tdR}>
                      <span style={{ color: dim ? '#444' : '#e0e0e0' }}>
                        {s.reported} / {s.sp500Count}
                      </span>
                    </td>
                    <td style={{ ...tdR, color: s.miss > 0 ? '#ef5350' : '#333' }}>
                      {s.miss > 0 ? fmtPct(s.avgMissSurprisePct) : '—'}
                    </td>
                    <td style={{ ...tdR, color: s.miss > 0 ? '#ef5350' : dim ? '#333' : '#555' }}>
                      {s.miss > 0 ? <><b>{s.miss}</b> <span style={{ opacity: 0.7 }}>{pctOf(s.missPct)}</span></> : '—'}
                    </td>
                    <td style={{ ...tdR, color: s.met > 0 ? '#b0b0b0' : dim ? '#333' : '#555' }}>
                      {s.met > 0 ? <><b>{s.met}</b> <span style={{ opacity: 0.7 }}>{pctOf(s.metPct)}</span></> : '—'}
                    </td>
                    <td style={{ ...tdR, color: s.beat > 0 ? '#22c55e' : dim ? '#333' : '#555' }}>
                      {s.beat > 0 ? <><b>{s.beat}</b> <span style={{ opacity: 0.7 }}>{pctOf(s.beatPct)}</span></> : '—'}
                    </td>
                    <td style={{ ...tdR, color: s.beat > 0 ? '#22c55e' : '#333' }}>
                      {s.beat > 0 ? fmtPct(s.avgBeatSurprisePct) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{
                borderTop: '2px solid #2a2a2a',
                background: '#0e0e0e',
                color: '#FCF000',
                fontWeight: 700,
              }}>
                <td style={{ ...tdL, fontWeight: 900 }}>{snap.totals.sector}</td>
                <td style={tdR}>{snap.totals.reported} / {snap.totals.sp500Count}</td>
                <td style={{ ...tdR, color: snap.totals.miss > 0 ? '#ef5350' : '#666' }}>
                  {snap.totals.miss > 0 ? fmtPct(snap.totals.avgMissSurprisePct) : '—'}
                </td>
                <td style={{ ...tdR, color: '#ef5350' }}>
                  <b>{snap.totals.miss}</b> <span style={{ opacity: 0.7 }}>{pctOf(snap.totals.missPct)}</span>
                </td>
                <td style={{ ...tdR, color: '#b0b0b0' }}>
                  <b>{snap.totals.met}</b> <span style={{ opacity: 0.7 }}>{pctOf(snap.totals.metPct)}</span>
                </td>
                <td style={{ ...tdR, color: '#22c55e' }}>
                  <b>{snap.totals.beat}</b> <span style={{ opacity: 0.7 }}>{pctOf(snap.totals.beatPct)}</span>
                </td>
                <td style={{ ...tdR, color: snap.totals.beat > 0 ? '#22c55e' : '#666' }}>
                  {snap.totals.beat > 0 ? fmtPct(snap.totals.avgBeatSurprisePct) : '—'}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

const thL = { textAlign: 'left',  padding: '8px 12px', fontWeight: 700 };
const thR = { textAlign: 'right', padding: '8px 12px', fontWeight: 700 };
const tdL = { textAlign: 'left',  padding: '8px 12px', fontSize: 12 };
const tdR = { textAlign: 'right', padding: '8px 12px', fontSize: 12 };

// Returns { from, to, isNextWeek } for the relevant earnings window.
// Thu–Sun: show NEXT week Mon–Fri (users plan ahead on Thursday).
// Mon–Wed: show current week today through Friday.
function getEarningsDateWindow() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = today.getDay(); // 0=Sun, 1=Mon…5=Fri, 6=Sat
  const fmt = d => d.toISOString().split('T')[0];

  const start = new Date(today);
  const end   = new Date(today);

  const showNextWeek = dow >= 4 || dow === 0 || dow === 6; // Thu=4, Fri=5, Sat=6, Sun=0

  if (showNextWeek) {
    // Days until next Monday: Sun→1, Thu→4, Fri→3, Sat→2
    const daysToNextMon = dow === 0 ? 1 : dow === 6 ? 2 : (8 - dow);
    start.setDate(today.getDate() + daysToNextMon);
    end.setDate(today.getDate() + daysToNextMon + 4); // Mon through Fri
  } else {
    // Mon–Wed: today through this Friday
    end.setDate(today.getDate() + (5 - dow));
  }

  return { from: fmt(start), to: fmt(end), isNextWeek: showNextWeek };
}

function formatDayHeader(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

export default function EarningsWeekPage() {
  const [stocks, setStocks]           = useState([]);
  const [signals, setSignals]         = useState({});
  const [earnings, setEarnings]       = useState({});
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [chartIndex, setChartIndex]   = useState(null);
  const [chartStocks, setChartStocks] = useState([]);

  function load() {
    setLoading(true);
    setError(null);
    fetchJungleStocks()
      .then(data => {
        const stockList = data.stocks || [];
        setStocks(stockList);
        setSignals(data.signals || {});
        fetchEarnings(stockList.map(s => s.ticker)).then(setEarnings);
      })
      .catch(err => {
        console.error(err);
        setError('Failed to load earnings data.');
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  const { from, to, isNextWeek } = useMemo(() => getEarningsDateWindow(), []);

  // Filter jungle stocks to those with earnings in this week's window, grouped by date
  const byDate = useMemo(() => {
    const groups = {};
    for (const stock of stocks) {
      const date = earnings[stock.ticker];
      if (!date || date < from || date > to) continue;
      if (!groups[date]) groups[date] = [];
      groups[date].push(stock);
    }
    return groups;
  }, [stocks, earnings, from, to]);

  const dates = useMemo(() => Object.keys(byDate).sort(), [byDate]);
  const totalCount = dates.reduce((sum, d) => sum + byDate[d].length, 0);

  function handleRowClick(_s, idx, sortedStocks) {
    setChartStocks(sortedStocks);
    setChartIndex(idx);
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>
            <img src={pantherHead} alt="PNTHR" className={styles.pantherLogo} />
            Earnings {isNextWeek ? 'Next Week' : 'This Week'}
          </h1>
          <p className={styles.subtitle}>
            {!loading && !error
              ? totalCount > 0
                ? `${totalCount} Jungle stocks reporting ${isNextWeek ? 'next week' : 'this week'} across ${dates.length} day${dates.length !== 1 ? 's' : ''}`
                : `No Jungle stocks reporting ${isNextWeek ? 'next week' : 'this week'}`
              : `PNTHR 679 Jungle — upcoming earnings ${isNextWeek ? 'next week' : 'this week'}`}
          </p>
        </div>
        <button className={styles.refreshBtn} onClick={load} disabled={loading}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {/* S&P 500 earnings season beat/met/miss tracker pinned to the top so
          the user sees the market-wide read before this week's jungle list. */}
      <EarningsSeasonTable />

      {loading && (
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <p>Loading Jungle earnings…</p>
        </div>
      )}

      {error && !loading && (
        <div className={styles.errorState}>
          <p>{error}</p>
          <button className={styles.retryBtn} onClick={load}>Try Again</button>
        </div>
      )}

      {!loading && !error && dates.length === 0 && (
        <div className={styles.emptyState}>
          <p>No Jungle stocks reporting this week.</p>
        </div>
      )}

      {!loading && !error && dates.map(date => (
        <div key={date} className={styles.daySection}>
          <h2 className={styles.dayHeader}>{formatDayHeader(date)}</h2>
          <StockTable
            stocks={byDate[date]}
            signals={signals}
            signalsLoading={false}
            earnings={earnings}
            onTickerClick={handleRowClick}
            scanType="long"
            compact={true}
            highlightAllEarnings={true}
          />
        </div>
      ))}

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
