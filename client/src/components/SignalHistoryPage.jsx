import { useState, useEffect, useRef, useMemo } from 'react';
import ChartModal from './ChartModal';
import {
  fetchSignalHistoryWeeks,
  fetchSignalHistoryWeek,
  fetchSignalHistoryTicker,
  saveSignalHistorySnapshot,
  fetchJungleStocks,
  fetchEarnings,
} from '../services/api';
import styles from './SignalHistoryPage.module.css';
import pantherHead from '../assets/panther head.png';

const SIGNAL_COLORS = {
  BL: '#50d080',
  SS: '#ff6060',
  BE: '#ff9800',
  SE: '#7c7cff',
};
const SIGNAL_LABELS = { BL: 'Buy Long', SS: 'Sell Short', BE: 'Break Even', SE: 'Stop Exit' };

function formatWeekOf(w) {
  if (!w) return '—';
  const [y, m, d] = w.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function SignalBadge({ signal }) {
  if (!signal) return <span style={{ color: '#4a4a4a' }}>—</span>;
  return (
    <span style={{
      background: `${SIGNAL_COLORS[signal]}22`,
      color: SIGNAL_COLORS[signal],
      border: `1px solid ${SIGNAL_COLORS[signal]}55`,
      borderRadius: 4, padding: '1px 8px', fontSize: 11, fontWeight: 700,
    }}>
      {signal}
    </span>
  );
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function WeekCalendar({ weeks, selectedWeek, onSelect }) {
  const [open, setOpen]       = useState(false);
  const [calMonth, setCalMonth] = useState(null); // null = month-grid view, 0-11 = week-list view
  const [calYear, setCalYear] = useState(() => {
    const src = selectedWeek || weeks[0];
    return src ? +src.split('-')[0] : new Date().getFullYear();
  });
  const ref = useRef(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
        setCalMonth(null);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Group archived weeks by "year-month" key (0-indexed month)
  const byYearMonth = useMemo(() => {
    const map = {};
    for (const w of weeks) {
      const [y, m] = w.split('-').map(Number);
      const key = `${y}-${m - 1}`;
      if (!map[key]) map[key] = [];
      map[key].push(w);
    }
    return map;
  }, [weeks]);

  const allYears = useMemo(() => {
    const ys = new Set(weeks.map(w => +w.split('-')[0]));
    return [...ys].sort();
  }, [weeks]);
  const minYear = allYears[0] ?? new Date().getFullYear();
  const maxYear = allYears[allYears.length - 1] ?? new Date().getFullYear();

  function openCalendar() {
    // When opening, default the year view to the selected week's year
    const src = selectedWeek || weeks[0];
    if (src) setCalYear(+src.split('-')[0]);
    setCalMonth(null);
    setOpen(v => !v);
  }

  function selectWeek(w) {
    onSelect(w);
    setOpen(false);
    setCalMonth(null);
  }

  const monthWeeks = calMonth !== null ? (byYearMonth[`${calYear}-${calMonth}`] || []) : [];

  return (
    <div ref={ref} className={styles.calWrap}>
      <button
        className={styles.calBtn}
        onClick={openCalendar}
        title="Jump to a specific week"
      >
        📅
      </button>

      {open && (
        <div className={styles.calPopover}>
          {/* ── Year navigation ── */}
          <div className={styles.calYearRow}>
            <button
              className={styles.calArrow}
              onClick={() => { setCalYear(y => Math.max(minYear, y - 1)); setCalMonth(null); }}
              disabled={calYear <= minYear}
            >◀</button>
            <span className={styles.calYearLabel}>{calYear}</span>
            <button
              className={styles.calArrow}
              onClick={() => { setCalYear(y => Math.min(maxYear, y + 1)); setCalMonth(null); }}
              disabled={calYear >= maxYear}
            >▶</button>
          </div>

          {calMonth === null ? (
            /* ── Month grid ── */
            <div className={styles.calMonthGrid}>
              {MONTHS.map((name, idx) => {
                const hasData = !!byYearMonth[`${calYear}-${idx}`];
                return (
                  <button
                    key={idx}
                    className={`${styles.calMonthBtn} ${hasData ? styles.calMonthActive : styles.calMonthEmpty}`}
                    disabled={!hasData}
                    onClick={() => setCalMonth(idx)}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          ) : (
            /* ── Week list for selected month ── */
            <>
              <button className={styles.calBackBtn} onClick={() => setCalMonth(null)}>
                ← {MONTHS[calMonth]} {calYear}
              </button>
              <div className={styles.calWeekList}>
                {monthWeeks.map(w => (
                  <button
                    key={w}
                    className={`${styles.calWeekItem} ${selectedWeek === w ? styles.calWeekItemActive : ''}`}
                    onClick={() => selectWeek(w)}
                  >
                    Week of {formatWeekOf(w)}
                  </button>
                ))}
                {monthWeeks.length === 0 && (
                  <span className={styles.calEmpty}>No snapshots</span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function SignalHistoryPage() {
  const [weeks, setWeeks]             = useState([]);
  const [selectedWeek, setSelectedWeek] = useState(null);
  const [weekData, setWeekData]       = useState([]);
  const [weekLoading, setWeekLoading] = useState(false);

  // Ticker drill-down
  const [drillTicker, setDrillTicker]   = useState(null);
  const [tickerHistory, setTickerHistory] = useState([]);
  const [tickerLoading, setTickerLoading] = useState(false);

  // Chart modal
  const [jungleStocks, setJungleStocks] = useState([]);
  const [jungleEarnings, setJungleEarnings] = useState({});
  const [chartIndex, setChartIndex]   = useState(null);
  const [chartStocks, setChartStocks] = useState([]);

  // Snapshot controls
  const [snapping, setSnapping]     = useState(false);
  const [snapMsg, setSnapMsg]       = useState(null);
  const [snapError, setSnapError]   = useState(false);

  // Filters
  const [filterSignal, setFilterSignal] = useState('all');
  const [search, setSearch]       = useState('');

  useEffect(() => {
    fetchSignalHistoryWeeks()
      .then(w => { setWeeks(w); if (w.length > 0) setSelectedWeek(w[0]); })
      .catch(err => console.error('History weeks:', err));
    fetchJungleStocks()
      .then(data => {
        const list = data.stocks || [];
        setJungleStocks(list);
        fetchEarnings(list.map(s => s.ticker)).then(setJungleEarnings);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedWeek) return;
    setWeekLoading(true);
    setDrillTicker(null);
    setTickerHistory([]);
    fetchSignalHistoryWeek(selectedWeek)
      .then(setWeekData)
      .catch(err => console.error('History week:', err))
      .finally(() => setWeekLoading(false));
  }, [selectedWeek]);

  function handleTickerClick(ticker) {
    setDrillTicker(ticker);
    setTickerLoading(true);
    fetchSignalHistoryTicker(ticker)
      .then(setTickerHistory)
      .catch(err => console.error('Ticker history:', err))
      .finally(() => setTickerLoading(false));
  }

  function handleChartOpen(ticker) {
    const idx = jungleStocks.findIndex(s => s.ticker === ticker);
    if (idx === -1) return;
    setChartStocks(jungleStocks);
    setChartIndex(idx);
  }

  async function handleSnapshot() {
    setSnapping(true);
    setSnapMsg(null);
    setSnapError(false);
    try {
      const res = await saveSignalHistorySnapshot();
      setSnapError(false);
      setSnapMsg(`✓ Saved ${res.count} records for week of ${formatWeekOf(res.weekOf)}`);
      // Refresh week list
      const w = await fetchSignalHistoryWeeks();
      setWeeks(w);
      if (!selectedWeek && w.length > 0) setSelectedWeek(w[0]);
    } catch (err) {
      setSnapError(true);
      setSnapMsg(`✗ ${err.message} — Load the Jungle page first, then try again.`);
    } finally {
      setSnapping(false);
    }
  }

  // Summary counts for the selected week
  const summary = useMemo(() => {
    const counts = { BL: 0, SS: 0, BE: 0, SE: 0, total: weekData.length };
    weekData.forEach(r => { if (r.signal) counts[r.signal] = (counts[r.signal] || 0) + 1; });
    return counts;
  }, [weekData]);

  // Filtered rows
  const filteredRows = useMemo(() => {
    return weekData.filter(r => {
      if (filterSignal !== 'all' && r.signal !== filterSignal) return false;
      if (search && !r.ticker.includes(search.toUpperCase())) return false;
      return true;
    });
  }, [weekData, filterSignal, search]);

  return (
    <div className={styles.page}>

      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <img src={pantherHead} alt="PNTHR" className={styles.headerLogo} />
          <div>
            <h1 className={styles.title}>Signal History</h1>
            <p className={styles.subtitle}>Weekly archive of all 679 Jungle stock signals</p>
          </div>
        </div>
        <div className={styles.headerRight}>
          {snapMsg && <span className={snapError ? styles.snapMsgError : styles.snapMsg}>{snapMsg}</span>}
          <button className={styles.snapshotBtn} onClick={handleSnapshot} disabled={snapping}>
            {snapping ? 'Saving…' : '📸 Save This Week'}
          </button>
        </div>
      </div>

      <div className={styles.body}>

        {/* Week list sidebar */}
        <aside className={styles.weekSidebar}>
          <div className={styles.sidebarTitle}>Archived Weeks</div>
          {weeks.length === 0 ? (
            <div className={styles.sidebarEmpty}>
              No snapshots yet.<br />Hit "Save This Week" to capture the first one.
            </div>
          ) : (
            <ul className={styles.weekList}>
              {weeks.map(w => (
                <li key={w}>
                  <button
                    className={`${styles.weekBtn} ${selectedWeek === w ? styles.weekBtnActive : ''}`}
                    onClick={() => setSelectedWeek(w)}
                  >
                    {formatWeekOf(w)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* Main content */}
        <main className={styles.main}>

          {/* Ticker drill-down panel */}
          {drillTicker && (
            <div className={styles.drillPanel}>
              <div className={styles.drillHeader}>
                <span className={styles.drillTitle}>{drillTicker} — Full Signal History</span>
                <button className={styles.drillChart} onClick={() => handleChartOpen(drillTicker)}>
                  📈 View Chart
                </button>
                <button className={styles.drillClose} onClick={() => { setDrillTicker(null); setTickerHistory([]); }}>✕</button>
              </div>
              {tickerLoading ? (
                <div className={styles.loading}><div className={styles.spinner} /> Loading…</div>
              ) : (
                <table className={styles.drillTable}>
                  <thead>
                    <tr>
                      <th>Week Of</th>
                      <th>Signal</th>
                      <th>EMA 21</th>
                      <th>Stop</th>
                      <th>New?</th>
                      <th>Profit $</th>
                      <th>Profit %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tickerHistory.map(r => (
                      <tr key={r.weekOf}>
                        <td>{formatWeekOf(r.weekOf)}</td>
                        <td><SignalBadge signal={r.signal} /></td>
                        <td>{r.ema21 != null ? r.ema21.toFixed(2) : '—'}</td>
                        <td>{r.stopPrice != null ? `$${r.stopPrice.toFixed(2)}` : '—'}</td>
                        <td>{r.isNewSignal ? <span className={styles.newDot}>NEW</span> : '—'}</td>
                        <td className={r.profitDollar > 0 ? styles.pos : r.profitDollar < 0 ? styles.neg : ''}>
                          {r.profitDollar != null ? `${r.profitDollar > 0 ? '+' : ''}$${r.profitDollar.toFixed(2)}` : '—'}
                        </td>
                        <td className={r.profitPct > 0 ? styles.pos : r.profitPct < 0 ? styles.neg : ''}>
                          {r.profitPct != null ? `${r.profitPct > 0 ? '+' : ''}${r.profitPct.toFixed(2)}%` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* Week summary + table */}
          {selectedWeek && (
            <>
              <div className={styles.weekHeader}>
                <span className={styles.weekTitle}>Week of {formatWeekOf(selectedWeek)}</span>
                <div className={styles.summaryBadges}>
                  {['BL', 'SS', 'BE', 'SE'].map(s => (
                    <span key={s} style={{ color: SIGNAL_COLORS[s], background: `${SIGNAL_COLORS[s]}18`, border: `1px solid ${SIGNAL_COLORS[s]}44`, borderRadius: 5, padding: '2px 10px', fontSize: 12, fontWeight: 700 }}>
                      {s}: {summary[s] || 0}
                    </span>
                  ))}
                  <span className={styles.totalBadge}>{summary.total} total</span>
                  {weeks.length > 0 && (
                    <WeekCalendar
                      weeks={weeks}
                      selectedWeek={selectedWeek}
                      onSelect={w => { setSelectedWeek(w); }}
                    />
                  )}
                </div>
              </div>

              {/* Filters */}
              <div className={styles.filters}>
                <input
                  className={styles.searchInput}
                  placeholder="Search ticker…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
                {['all', 'BL', 'SS', 'BE', 'SE'].map(s => (
                  <button
                    key={s}
                    className={`${styles.filterBtn} ${filterSignal === s ? styles.filterBtnActive : ''}`}
                    onClick={() => setFilterSignal(s)}
                  >
                    {s === 'all' ? 'All' : s}
                  </button>
                ))}
              </div>

              {weekLoading ? (
                <div className={styles.loading}><div className={styles.spinner} /> Loading…</div>
              ) : (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Ticker</th>
                      <th>Signal</th>
                      <th>Signal Date</th>
                      <th>EMA 21</th>
                      <th>Stop Price</th>
                      <th>New</th>
                      <th>Profit $</th>
                      <th>Profit %</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map(r => (
                      <tr key={r.ticker} className={styles.row}>
                        <td>
                          <button className={styles.tickerBtn} onClick={() => handleTickerClick(r.ticker)}>
                            {r.ticker}
                          </button>
                        </td>
                        <td><SignalBadge signal={r.signal} /></td>
                        <td>{r.signalDate ? formatWeekOf(r.signalDate) : '—'}</td>
                        <td>{r.ema21 != null ? r.ema21.toFixed(2) : '—'}</td>
                        <td>{r.stopPrice != null ? `$${r.stopPrice.toFixed(2)}` : '—'}</td>
                        <td>{r.isNewSignal ? <span className={styles.newDot}>NEW</span> : '—'}</td>
                        <td className={r.profitDollar > 0 ? styles.pos : r.profitDollar < 0 ? styles.neg : ''}>
                          {r.profitDollar != null ? `${r.profitDollar > 0 ? '+' : ''}$${r.profitDollar.toFixed(2)}` : '—'}
                        </td>
                        <td className={r.profitPct > 0 ? styles.pos : r.profitPct < 0 ? styles.neg : ''}>
                          {r.profitPct != null ? `${r.profitPct > 0 ? '+' : ''}${r.profitPct.toFixed(2)}%` : '—'}
                        </td>
                        <td>
                          <button className={styles.chartMiniBtn} onClick={() => handleChartOpen(r.ticker)}>📈</button>
                        </td>
                      </tr>
                    ))}
                    {filteredRows.length === 0 && (
                      <tr><td colSpan={9} className={styles.emptyRow}>No records match</td></tr>
                    )}
                  </tbody>
                </table>
              )}
            </>
          )}

          {!selectedWeek && weeks.length === 0 && !weekLoading && (
            <div className={styles.emptyState}>
              <img src={pantherHead} alt="PNTHR" className={styles.emptyLogo} />
              <p>No signal history yet. Hit <strong>Save This Week</strong> to capture the first snapshot.</p>
            </div>
          )}
        </main>
      </div>

      {chartIndex != null && (
        <ChartModal
          stocks={chartStocks}
          initialIndex={chartIndex}
          earnings={jungleEarnings}
          onClose={() => setChartIndex(null)}
        />
      )}
    </div>
  );
}
