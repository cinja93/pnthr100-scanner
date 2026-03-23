import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import ChartModal from './ChartModal';
import {
  fetchSignalHistoryWeeks,
  fetchSignalHistoryWeek,
  fetchSignalHistoryTicker,
  saveSignalHistorySnapshot,
  fetchJungleStocks,
  fetchEarnings,
  fetchMarketSnapshots,
  fetchEnrichedSignals,
  fetchClosedTrades,
  fetchChangelog,
  addChangelogEntry,
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

const CATEGORY_COLORS = {
  SCORING:  '#D4A017',
  RISK:     '#ff8c00',
  BUG_FIX:  '#ff4444',
  UI:       '#4a9eff',
  DATA:     '#50d080',
  PIPELINE: '#6a6a6a',
  OTHER:    '#8a8a8a',
};

const IMPACT_COLORS = {
  HIGH:   '#ff4444',
  MEDIUM: '#ff8c00',
  LOW:    '#4a9eff',
};

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
  const [calMonth, setCalMonth] = useState(null);
  const [calYear, setCalYear] = useState(() => {
    const src = selectedWeek || weeks[0];
    return src ? +src.split('-')[0] : new Date().getFullYear();
  });
  const ref = useRef(null);

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
      <button className={styles.calBtn} onClick={openCalendar} title="Jump to a specific week">
        📅
      </button>
      {open && (
        <div className={styles.calPopover}>
          <div className={styles.calYearRow}>
            <button className={styles.calArrow} onClick={() => { setCalYear(y => Math.max(minYear, y - 1)); setCalMonth(null); }} disabled={calYear <= minYear}>◀</button>
            <span className={styles.calYearLabel}>{calYear}</span>
            <button className={styles.calArrow} onClick={() => { setCalYear(y => Math.min(maxYear, y + 1)); setCalMonth(null); }} disabled={calYear >= maxYear}>▶</button>
          </div>
          {calMonth === null ? (
            <div className={styles.calMonthGrid}>
              {MONTHS.map((name, idx) => {
                const hasData = !!byYearMonth[`${calYear}-${idx}`];
                return (
                  <button key={idx} className={`${styles.calMonthBtn} ${hasData ? styles.calMonthActive : styles.calMonthEmpty}`} disabled={!hasData} onClick={() => setCalMonth(idx)}>
                    {name}
                  </button>
                );
              })}
            </div>
          ) : (
            <>
              <button className={styles.calBackBtn} onClick={() => setCalMonth(null)}>← {MONTHS[calMonth]} {calYear}</button>
              <div className={styles.calWeekList}>
                {monthWeeks.map(w => (
                  <button key={w} className={`${styles.calWeekItem} ${selectedWeek === w ? styles.calWeekItemActive : ''}`} onClick={() => selectWeek(w)}>
                    Week of {formatWeekOf(w)}
                  </button>
                ))}
                {monthWeeks.length === 0 && <span className={styles.calEmpty}>No snapshots</span>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Simple SVG Line Chart ───────────────────────────────────────────────────

function SimpleLineChart({ data, lines, width = 600, height = 160, label = '' }) {
  if (!data || data.length < 2) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4a4a4a', fontSize: 13 }}>
        No data yet
      </div>
    );
  }

  const PAD = { top: 12, right: 16, bottom: 32, left: 52 };
  const W = width - PAD.left - PAD.right;
  const H = height - PAD.top - PAD.bottom;

  const allValues = lines.flatMap(l => data.map(d => d[l.key]).filter(v => v != null));
  if (allValues.length === 0) {
    return <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4a4a4a', fontSize: 13 }}>No data yet</div>;
  }
  const minV = Math.min(...allValues);
  const maxV = Math.max(...allValues);
  const rangeV = maxV - minV || 1;

  const xScale = i => PAD.left + (i / (data.length - 1)) * W;
  const yScale = v => PAD.top + H - ((v - minV) / rangeV) * H;

  // Tick labels on x-axis (show up to 6)
  const xTicks = data.length <= 6
    ? data.map((_, i) => i)
    : [0, Math.floor(data.length * 0.2), Math.floor(data.length * 0.4), Math.floor(data.length * 0.6), Math.floor(data.length * 0.8), data.length - 1];

  // Y axis ticks
  const yTickCount = 4;
  const yTicks = Array.from({ length: yTickCount }, (_, i) => minV + (rangeV * i) / (yTickCount - 1));

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }}>
      {/* Grid lines */}
      {yTicks.map((v, i) => (
        <g key={i}>
          <line x1={PAD.left} y1={yScale(v)} x2={PAD.left + W} y2={yScale(v)} stroke="#1e1e1e" strokeWidth={1} />
          <text x={PAD.left - 6} y={yScale(v) + 4} fill="#5a5a5a" fontSize={10} textAnchor="end">
            {v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(v < 10 ? 2 : 0)}
          </text>
        </g>
      ))}

      {/* Lines */}
      {lines.map(l => {
        const pts = data
          .map((d, i) => d[l.key] != null ? `${xScale(i)},${yScale(d[l.key])}` : null)
          .filter(Boolean);
        if (pts.length < 2) return null;
        return (
          <polyline key={l.key} points={pts.join(' ')} fill="none" stroke={l.color} strokeWidth={l.width || 2} strokeLinejoin="round" />
        );
      })}

      {/* X tick labels */}
      {xTicks.map(i => (
        <text key={i} x={xScale(i)} y={PAD.top + H + 18} fill="#5a5a5a" fontSize={9} textAnchor="middle">
          {data[i]?.label ?? data[i]?.weekOf?.slice(5) ?? ''}
        </text>
      ))}

      {/* Chart label */}
      {label && (
        <text x={PAD.left} y={11} fill="#888" fontSize={10} fontWeight={600}>{label}</text>
      )}
    </svg>
  );
}

function VixChart({ data, width = 600, height = 160 }) {
  if (!data || data.length < 2) {
    return <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4a4a4a', fontSize: 13 }}>No VIX data yet</div>;
  }
  const values = data.map(d => d.vix).filter(v => v != null);
  if (values.length < 2) return <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4a4a4a', fontSize: 13 }}>No VIX data yet</div>;

  const PAD = { top: 12, right: 16, bottom: 32, left: 52 };
  const W = width - PAD.left - PAD.right;
  const H = height - PAD.top - PAD.bottom;

  const minV = Math.max(0, Math.min(...values) - 2);
  const maxV = Math.max(...values) + 2;
  const rangeV = maxV - minV || 1;
  const xScale = i => PAD.left + (i / (data.length - 1)) * W;
  const yScale = v => PAD.top + H - ((v - minV) / rangeV) * H;

  const bands = [
    { min: 35, max: maxV + 10, color: 'rgba(255,68,68,0.12)' },
    { min: 25, max: 35,        color: 'rgba(255,140,0,0.12)' },
    { min: 15, max: 25,        color: 'rgba(255,220,0,0.08)' },
    { min: 0,  max: 15,        color: 'rgba(80,208,128,0.08)' },
  ];

  const xTicks = data.length <= 6
    ? data.map((_, i) => i)
    : [0, Math.floor(data.length * 0.25), Math.floor(data.length * 0.5), Math.floor(data.length * 0.75), data.length - 1];

  const pts = data.map((d, i) => d.vix != null ? `${xScale(i)},${yScale(d.vix)}` : null).filter(Boolean);

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }}>
      {/* Colored VIX bands */}
      {bands.map((b, bi) => {
        const y1 = yScale(Math.min(b.max, maxV));
        const y2 = yScale(Math.max(b.min, minV));
        if (y2 <= y1) return null;
        return <rect key={bi} x={PAD.left} y={y1} width={W} height={y2 - y1} fill={b.color} />;
      })}
      {/* Reference lines at 15, 25, 35 */}
      {[15, 25, 35].filter(v => v > minV && v < maxV).map(v => (
        <line key={v} x1={PAD.left} y1={yScale(v)} x2={PAD.left + W} y2={yScale(v)} stroke="#333" strokeWidth={1} strokeDasharray="3 3" />
      ))}
      {/* VIX line */}
      {pts.length >= 2 && <polyline points={pts.join(' ')} fill="none" stroke="#ff8c00" strokeWidth={2} strokeLinejoin="round" />}
      {/* Y axis */}
      {[minV, 15, 25, 35, maxV].filter(v => v >= minV && v <= maxV).map(v => (
        <text key={v} x={PAD.left - 6} y={yScale(v) + 4} fill="#5a5a5a" fontSize={10} textAnchor="end">{v.toFixed(0)}</text>
      ))}
      {/* X ticks */}
      {xTicks.map(i => (
        <text key={i} x={xScale(i)} y={PAD.top + H + 18} fill="#5a5a5a" fontSize={9} textAnchor="middle">
          {data[i]?.weekOf?.slice(5) ?? ''}
        </text>
      ))}
      <text x={PAD.left} y={11} fill="#888" fontSize={10} fontWeight={600}>VIX</text>
    </svg>
  );
}

// ── Tab 1: Signal Archive ────────────────────────────────────────────────────

function SignalArchiveTab({ weeks, onWeeksChange }) {
  const [selectedWeek, setSelectedWeek] = useState(null);
  const [weekData, setWeekData]         = useState([]);
  const [weekLoading, setWeekLoading]   = useState(false);
  const [enrichedMap, setEnrichedMap]   = useState({});

  const [drillTicker, setDrillTicker]       = useState(null);
  const [tickerHistory, setTickerHistory]   = useState([]);
  const [tickerLoading, setTickerLoading]   = useState(false);

  const [jungleStocks, setJungleStocks]     = useState([]);
  const [jungleEarnings, setJungleEarnings] = useState({});
  const [chartIndex, setChartIndex]         = useState(null);
  const [chartStocks, setChartStocks]       = useState([]);

  const [snapping, setSnapping]   = useState(false);
  const [snapMsg, setSnapMsg]     = useState(null);
  const [snapError, setSnapError] = useState(false);

  const [filterSignal, setFilterSignal] = useState('all');
  const [search, setSearch]             = useState('');

  const [marketSnapshots, setMarketSnapshots] = useState({});

  useEffect(() => {
    fetchJungleStocks()
      .then(data => {
        const list = data.stocks || [];
        setJungleStocks(list);
        fetchEarnings(list.map(s => s.ticker)).then(setJungleEarnings);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (weeks.length > 0 && !selectedWeek) setSelectedWeek(weeks[0]);
  }, [weeks]);

  useEffect(() => {
    if (!selectedWeek) return;
    setWeekLoading(true);
    setDrillTicker(null);
    setTickerHistory([]);
    Promise.all([
      fetchSignalHistoryWeek(selectedWeek),
      fetchEnrichedSignals(selectedWeek).catch(() => []),
      fetchMarketSnapshots(selectedWeek, selectedWeek).catch(() => []),
    ])
      .then(([data, enriched, snapshots]) => {
        setWeekData(data);
        const em = {};
        for (const e of enriched) em[e.ticker] = e;
        setEnrichedMap(em);
        const sMap = {};
        for (const s of snapshots) sMap[s.weekOf] = s;
        setMarketSnapshots(prev => ({ ...prev, ...sMap }));
      })
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
      const w = await fetchSignalHistoryWeeks();
      onWeeksChange(w);
      if (!selectedWeek && w.length > 0) setSelectedWeek(w[0]);
    } catch (err) {
      setSnapError(true);
      setSnapMsg(`✗ ${err.message} — Load the Jungle page first, then try again.`);
    } finally {
      setSnapping(false);
    }
  }

  const summary = useMemo(() => {
    const counts = { BL: 0, SS: 0, BE: 0, SE: 0, total: weekData.length };
    weekData.forEach(r => { if (r.signal) counts[r.signal] = (counts[r.signal] || 0) + 1; });
    return counts;
  }, [weekData]);

  const filteredRows = useMemo(() => {
    return weekData.filter(r => {
      if (filterSignal !== 'all' && r.signal !== filterSignal) return false;
      if (search && !r.ticker.includes(search.toUpperCase())) return false;
      return true;
    });
  }, [weekData, filterSignal, search]);

  const weekSnapshot = selectedWeek ? marketSnapshots[selectedWeek] : null;

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
      {/* Sidebar */}
      <aside className={styles.weekSidebar}>
        <div className={styles.sidebarTitle}>Archived Weeks</div>
        {weeks.length === 0 ? (
          <div className={styles.sidebarEmpty}>No snapshots yet.<br />Hit "Save This Week" to capture the first one.</div>
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

      {/* Main */}
      <main className={styles.main}>
        {/* Snapshot button */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, alignItems: 'center' }}>
          {snapMsg && <span style={{ fontSize: 12, color: snapError ? '#ff6060' : '#50d080' }}>{snapMsg}</span>}
          <button className={styles.snapshotBtn} onClick={handleSnapshot} disabled={snapping}>
            {snapping ? 'Saving…' : '📸 Save This Week'}
          </button>
        </div>

        {/* Ticker drill-down */}
        {drillTicker && (
          <div className={styles.drillPanel}>
            <div className={styles.drillHeader}>
              <span className={styles.drillTitle}>{drillTicker} — Full Signal History</span>
              <button className={styles.drillChart} onClick={() => handleChartOpen(drillTicker)}>📈 View Chart</button>
              <button className={styles.drillClose} onClick={() => { setDrillTicker(null); setTickerHistory([]); }}>✕</button>
            </div>
            {tickerLoading ? (
              <div className={styles.loading}><div className={styles.spinner} /> Loading…</div>
            ) : (
              <table className={styles.drillTable}>
                <thead><tr><th>Week Of</th><th>Signal</th><th>EMA 21</th><th>Stop</th><th>New?</th><th>Profit $</th><th>Profit %</th></tr></thead>
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

        {/* Week summary */}
        {selectedWeek && (
          <>
            <div className={styles.weekHeader}>
              <span className={styles.weekTitle}>
                Week of {formatWeekOf(selectedWeek)}
                {weekSnapshot?.vix != null && (
                  <span style={{
                    marginLeft: 12,
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 4,
                    background: weekSnapshot.vix > 35 ? 'rgba(255,68,68,0.15)' : weekSnapshot.vix > 25 ? 'rgba(255,140,0,0.15)' : weekSnapshot.vix > 15 ? 'rgba(255,220,0,0.1)' : 'rgba(80,208,128,0.1)',
                    color: weekSnapshot.vix > 35 ? '#ff4444' : weekSnapshot.vix > 25 ? '#ff8c00' : weekSnapshot.vix > 15 ? '#ffdc00' : '#50d080',
                    border: '1px solid currentColor',
                    fontWeight: 700,
                  }}>
                    VIX {weekSnapshot.vix.toFixed(1)}
                  </span>
                )}
              </span>
              <div className={styles.summaryBadges}>
                {['BL', 'SS', 'BE', 'SE'].map(s => (
                  <span key={s} style={{ color: SIGNAL_COLORS[s], background: `${SIGNAL_COLORS[s]}18`, border: `1px solid ${SIGNAL_COLORS[s]}44`, borderRadius: 5, padding: '2px 10px', fontSize: 12, fontWeight: 700 }}>
                    {s}: {summary[s] || 0}
                  </span>
                ))}
                <span className={styles.totalBadge}>{summary.total} total</span>
                {weeks.length > 0 && (
                  <WeekCalendar weeks={weeks} selectedWeek={selectedWeek} onSelect={w => setSelectedWeek(w)} />
                )}
              </div>
            </div>

            <div className={styles.filters}>
              <input className={styles.searchInput} placeholder="Search ticker…" value={search} onChange={e => setSearch(e.target.value)} />
              {['all', 'BL', 'SS', 'BE', 'SE'].map(s => (
                <button key={s} className={`${styles.filterBtn} ${filterSignal === s ? styles.filterBtnActive : ''}`} onClick={() => setFilterSignal(s)}>
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
                    <th>Ticker</th><th>Signal</th><th>Signal Date</th><th>EMA 21</th>
                    <th>Stop Price</th><th>New</th>
                    <th style={{ color: '#D4A017' }}>Score Δ</th>
                    <th>Profit $</th><th>Profit %</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map(r => {
                    const enriched = enrichedMap[r.ticker];
                    const scoreDelta = enriched?.scoreDelta ?? null;
                    return (
                      <tr key={r.ticker} className={styles.row}>
                        <td>
                          <button className={styles.tickerBtn} onClick={() => handleTickerClick(r.ticker)}>{r.ticker}</button>
                        </td>
                        <td><SignalBadge signal={r.signal} /></td>
                        <td>{r.signalDate ? formatWeekOf(r.signalDate) : '—'}</td>
                        <td>{r.ema21 != null ? r.ema21.toFixed(2) : '—'}</td>
                        <td>{r.stopPrice != null ? `$${r.stopPrice.toFixed(2)}` : '—'}</td>
                        <td>{r.isNewSignal ? <span className={styles.newDot}>NEW</span> : '—'}</td>
                        <td style={{ color: scoreDelta == null ? '#4a4a4a' : scoreDelta > 0 ? '#50d080' : scoreDelta < 0 ? '#ff6060' : '#7a7a7a', fontWeight: 600, fontSize: 11 }}>
                          {scoreDelta != null ? `${scoreDelta > 0 ? '+' : ''}${scoreDelta.toFixed(1)}` : '—'}
                        </td>
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
                    );
                  })}
                  {filteredRows.length === 0 && (
                    <tr><td colSpan={10} className={styles.emptyRow}>No records match</td></tr>
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

      {chartIndex != null && (
        <ChartModal stocks={chartStocks} initialIndex={chartIndex} earnings={jungleEarnings} onClose={() => setChartIndex(null)} />
      )}
    </div>
  );
}

// ── Tab 2: Market Conditions ─────────────────────────────────────────────────

const DATE_RANGES = ['3M', '6M', '1Y', 'ALL'];

function MarketConditionsTab() {
  const [snapshots, setSnapshots] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [range, setRange]         = useState('6M');

  useEffect(() => {
    setLoading(true);
    fetchMarketSnapshots()
      .then(data => { setSnapshots(data || []); })
      .catch(() => setSnapshots([]))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    if (range === 'ALL') return snapshots;
    const months = range === '3M' ? 3 : range === '6M' ? 6 : 12;
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    return snapshots.filter(s => s.weekOf >= cutoffStr);
  }, [snapshots, range]);

  const chartCard = (title, children) => (
    <div style={{ background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 8, padding: '16px 16px 8px', marginBottom: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#7a7a7a', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );

  if (loading) return <div className={styles.loading} style={{ padding: 40 }}><div className={styles.spinner} /> Loading market data…</div>;

  if (snapshots.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#5a5a5a', fontSize: 14 }}>
        <img src={pantherHead} alt="" style={{ width: 48, opacity: 0.2, marginBottom: 16 }} />
        <p>No market condition data yet.</p>
        <p style={{ fontSize: 12, color: '#3a3a3a' }}>Market snapshots are saved automatically by the Friday pipeline once configured.</p>
      </div>
    );
  }

  const spyData  = filtered.map(s => ({ weekOf: s.weekOf, price: s.spyPrice, ema: s.spyEma21 }));
  const qqqData  = filtered.map(s => ({ weekOf: s.weekOf, price: s.qqqPrice, ema: s.qqqEma21 }));
  const ratioData = filtered.map(s => ({
    weekOf: s.weekOf,
    ratio: (s.blCount + s.ssCount) > 0 ? s.ssCount / Math.max(1, s.blCount) : null,
  }));

  return (
    <div style={{ padding: 24, overflowY: 'auto', flex: 1 }}>
      {/* Range selector */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {DATE_RANGES.map(r => (
          <button key={r} onClick={() => setRange(r)} style={{
            background: range === r ? 'rgba(212,160,23,0.15)' : '#1a1a1a',
            border: `1px solid ${range === r ? '#D4A017' : '#2e2e2e'}`,
            color: range === r ? '#D4A017' : '#7a7a7a',
            borderRadius: 5, padding: '4px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}>{r}</button>
        ))}
      </div>

      {chartCard('SPY vs 21-Week EMA',
        <SimpleLineChart
          data={spyData}
          lines={[
            { key: 'price', color: '#D4A017', width: 2 },
            { key: 'ema',   color: '#555',    width: 1.5 },
          ]}
          height={160}
          label="SPY"
        />
      )}

      {chartCard('QQQ vs 21-Week EMA',
        <SimpleLineChart
          data={qqqData}
          lines={[
            { key: 'price', color: '#4a9eff', width: 2 },
            { key: 'ema',   color: '#555',    width: 1.5 },
          ]}
          height={160}
          label="QQQ"
        />
      )}

      {chartCard('VIX — Fear Index',
        <VixChart data={filtered} height={160} />
      )}

      {chartCard('SS : BL Signal Ratio',
        <SimpleLineChart
          data={ratioData}
          lines={[{ key: 'ratio', color: '#ff6060', width: 2 }]}
          height={140}
          label="SS:BL ratio (>1 = bearish dominance)"
        />
      )}
    </div>
  );
}

// ── Tab 3: Dimension Lab ─────────────────────────────────────────────────────

function DimensionLabTab() {
  const [signals, setSignals]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [weekOf, setWeekOf]     = useState(null);

  useEffect(() => {
    setLoading(true);
    fetchEnrichedSignals()
      .then(data => {
        setSignals(data || []);
        if (data && data.length > 0) setWeekOf(data[0].weekOf);
      })
      .catch(() => setSignals([]))
      .finally(() => setLoading(false));
  }, []);

  const dimStats = useMemo(() => {
    if (!signals.length) return [];
    const dims = ['d1', 'd2', 'd3', 'd5', 'd6', 'd7', 'd8'];
    const labels = { d1: 'D1 — Regime Multiplier', d2: 'D2 — Sector Direction', d3: 'D3 — Entry Quality', d5: 'D5 — Rank Rise Delta', d6: 'D6 — Momentum', d7: 'D7 — Rank Velocity', d8: 'D8 — Prey Presence' };
    return dims.map(dim => {
      const vals = signals
        .map(s => {
          const d = s.dimensions;
          if (!d) return null;
          // dimensions is scoreDetail — try various shapes
          const v = d[dim]?.score ?? d[dim]?.value ?? d[dim] ?? null;
          return typeof v === 'number' ? v : null;
        })
        .filter(v => v != null);
      const nonZero = vals.filter(v => v !== 0).length;
      const avg = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      const label = labels[dim] || dim.toUpperCase();
      const effectiveness = nonZero / Math.max(1, vals.length);
      return { dim, label, avg, nonZero, total: vals.length, effectiveness };
    });
  }, [signals]);

  if (loading) return <div className={styles.loading} style={{ padding: 40 }}><div className={styles.spinner} /> Loading…</div>;

  if (!signals.length) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#5a5a5a', fontSize: 14 }}>
        <img src={pantherHead} alt="" style={{ width: 48, opacity: 0.2, marginBottom: 16 }} />
        <p>No enriched signal data yet.</p>
        <p style={{ fontSize: 12, color: '#3a3a3a' }}>Enriched signals are saved automatically by the Friday pipeline.</p>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, overflowY: 'auto', flex: 1 }}>
      <div style={{ marginBottom: 16 }}>
        <span style={{ fontSize: 13, color: '#D4A017', fontWeight: 700 }}>Dimension Analysis</span>
        {weekOf && <span style={{ marginLeft: 12, fontSize: 12, color: '#5a5a5a' }}>Week of {formatWeekOf(weekOf)} — {signals.length} signals</span>}
      </div>

      <div style={{ background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 8, overflow: 'hidden', marginBottom: 24 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
              <th style={{ padding: '10px 16px', textAlign: 'left', color: '#5a5a5a', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Dimension</th>
              <th style={{ padding: '10px 16px', textAlign: 'right', color: '#5a5a5a', fontSize: 10, fontWeight: 700, textTransform: 'uppercase' }}>Avg Score</th>
              <th style={{ padding: '10px 16px', textAlign: 'right', color: '#5a5a5a', fontSize: 10, fontWeight: 700, textTransform: 'uppercase' }}>Active / Total</th>
              <th style={{ padding: '10px 16px', textAlign: 'right', color: '#5a5a5a', fontSize: 10, fontWeight: 700, textTransform: 'uppercase' }}>Activity</th>
              <th style={{ padding: '10px 16px', textAlign: 'left', color: '#5a5a5a', fontSize: 10, fontWeight: 700, textTransform: 'uppercase' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {dimStats.map(d => {
              const pct = d.effectiveness * 100;
              const statusColor = pct >= 60 ? '#50d080' : pct >= 30 ? '#ffdc00' : '#ff6060';
              const statusLabel = pct >= 60 ? 'Active' : pct >= 30 ? 'Partial' : 'Low Activity';
              return (
                <tr key={d.dim} style={{ borderBottom: '1px solid #181818' }}>
                  <td style={{ padding: '10px 16px', color: '#D4A017', fontWeight: 600 }}>{d.label}</td>
                  <td style={{ padding: '10px 16px', textAlign: 'right', color: d.avg > 0 ? '#50d080' : d.avg < 0 ? '#ff6060' : '#7a7a7a', fontWeight: 600 }}>
                    {d.total > 0 ? `${d.avg > 0 ? '+' : ''}${d.avg.toFixed(2)}` : '—'}
                  </td>
                  <td style={{ padding: '10px 16px', textAlign: 'right', color: '#c8c8c8' }}>
                    {d.nonZero} / {d.total}
                  </td>
                  <td style={{ padding: '10px 16px', textAlign: 'right' }}>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ width: 80, height: 6, background: '#2a2a2a', borderRadius: 3, overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: statusColor, borderRadius: 3 }} />
                      </div>
                      <span style={{ color: '#7a7a7a', fontSize: 10 }}>{pct.toFixed(0)}%</span>
                    </div>
                  </td>
                  <td style={{ padding: '10px 16px' }}>
                    <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: `${statusColor}18`, color: statusColor, border: `1px solid ${statusColor}44`, fontWeight: 700 }}>
                      {statusLabel}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ background: '#111', border: '1px solid #2a2a2a', borderRadius: 6, padding: 14, color: '#5a5a5a', fontSize: 12 }}>
        Insufficient closed trades for correlation analysis. Correlation stats will appear once trade outcomes are recorded.
      </div>
    </div>
  );
}

// ── Tab 4: Trade Archive ─────────────────────────────────────────────────────

function TradeArchiveTab() {
  const [trades, setTrades]     = useState([]);
  const [loading, setLoading]   = useState(true);
  const [tierFilter, setTierFilter]         = useState('');
  const [dirFilter, setDirFilter]           = useState('');
  const [sortField, setSortField]           = useState('exitDate');
  const [sortDir, setSortDir]               = useState(-1);

  useEffect(() => {
    setLoading(true);
    fetchClosedTrades({})
      .then(data => setTrades(data || []))
      .catch(() => setTrades([]))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    let list = [...trades];
    if (tierFilter) list = list.filter(t => t.entryTier === tierFilter);
    if (dirFilter)  list = list.filter(t => t.direction === dirFilter);
    list.sort((a, b) => {
      const av = a[sortField] ?? '';
      const bv = b[sortField] ?? '';
      return av < bv ? -sortDir : av > bv ? sortDir : 0;
    });
    return list;
  }, [trades, tierFilter, dirFilter, sortField, sortDir]);

  const tiers = [...new Set(trades.map(t => t.entryTier).filter(Boolean))].sort();
  const dirs  = [...new Set(trades.map(t => t.direction).filter(Boolean))].sort();

  function toggleSort(field) {
    if (sortField === field) setSortDir(d => -d);
    else { setSortField(field); setSortDir(-1); }
  }

  function SortTh({ field, children }) {
    const active = sortField === field;
    return (
      <th onClick={() => toggleSort(field)} style={{ padding: '8px 12px', textAlign: 'left', color: active ? '#D4A017' : '#5a5a5a', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', cursor: 'pointer', userSelect: 'none', borderBottom: '1px solid #1e1e1e', whiteSpace: 'nowrap' }}>
        {children} {active ? (sortDir > 0 ? '▲' : '▼') : ''}
      </th>
    );
  }

  if (loading) return <div className={styles.loading} style={{ padding: 40 }}><div className={styles.spinner} /> Loading…</div>;

  if (!trades.length) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#5a5a5a', fontSize: 14 }}>
        <img src={pantherHead} alt="" style={{ width: 48, opacity: 0.2, marginBottom: 16 }} />
        <p style={{ color: '#5a5a5a' }}>No closed trades yet.</p>
        <p style={{ fontSize: 12, color: '#3a3a3a' }}>Trades populate automatically when Kill case studies exit.</p>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, overflowY: 'auto', flex: 1 }}>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
        <select value={tierFilter} onChange={e => setTierFilter(e.target.value)} style={{ background: '#1a1a1a', border: '1px solid #2e2e2e', borderRadius: 5, color: '#c8c8c8', padding: '5px 10px', fontSize: 12 }}>
          <option value="">All Tiers</option>
          {tiers.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={dirFilter} onChange={e => setDirFilter(e.target.value)} style={{ background: '#1a1a1a', border: '1px solid #2e2e2e', borderRadius: 5, color: '#c8c8c8', padding: '5px 10px', fontSize: 12 }}>
          <option value="">All Directions</option>
          {dirs.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#5a5a5a' }}>{filtered.length} trades</span>
      </div>

      <div style={{ background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 8, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              <SortTh field="ticker">Ticker</SortTh>
              <SortTh field="direction">Dir</SortTh>
              <SortTh field="entryTier">Tier</SortTh>
              <SortTh field="entryDate">Entry</SortTh>
              <SortTh field="exitDate">Exit</SortTh>
              <SortTh field="profitPct">Profit %</SortTh>
              <SortTh field="isWinner">Result</SortTh>
              <SortTh field="sector">Sector</SortTh>
            </tr>
          </thead>
          <tbody>
            {filtered.map((t, i) => (
              <tr key={i} style={{ borderBottom: '1px solid #141414' }}>
                <td style={{ padding: '7px 12px', color: '#D4A017', fontWeight: 700 }}>{t.ticker}</td>
                <td style={{ padding: '7px 12px' }}><SignalBadge signal={t.direction} /></td>
                <td style={{ padding: '7px 12px', color: '#c8c8c8', fontSize: 11 }}>{t.entryTier || '—'}</td>
                <td style={{ padding: '7px 12px', color: '#7a7a7a', fontSize: 11 }}>{t.entryDate ? formatWeekOf(t.entryDate) : '—'}</td>
                <td style={{ padding: '7px 12px', color: '#7a7a7a', fontSize: 11 }}>{t.exitDate ? formatWeekOf(t.exitDate) : '—'}</td>
                <td style={{ padding: '7px 12px', color: t.profitPct > 0 ? '#50d080' : t.profitPct < 0 ? '#ff6060' : '#7a7a7a', fontWeight: 600 }}>
                  {t.profitPct != null ? `${t.profitPct > 0 ? '+' : ''}${t.profitPct.toFixed(2)}%` : '—'}
                </td>
                <td style={{ padding: '7px 12px' }}>
                  {t.isWinner != null ? (
                    <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, background: t.isWinner ? 'rgba(80,208,128,0.15)' : 'rgba(255,96,96,0.15)', color: t.isWinner ? '#50d080' : '#ff6060', fontWeight: 700 }}>
                      {t.isWinner ? 'WIN' : 'LOSS'}
                    </span>
                  ) : '—'}
                </td>
                <td style={{ padding: '7px 12px', color: '#7a7a7a', fontSize: 11 }}>{t.sector || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Tab 5: System Changelog ──────────────────────────────────────────────────

const CHANGELOG_CATEGORIES = ['SCORING', 'RISK', 'BUG_FIX', 'UI', 'DATA', 'PIPELINE', 'OTHER'];
const CHANGELOG_IMPACTS    = ['HIGH', 'MEDIUM', 'LOW'];

function SystemChangelogTab() {
  const [entries, setEntries]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving]     = useState(false);
  const [formErr, setFormErr]   = useState('');
  const [form, setForm] = useState({
    date: new Date().toISOString().split('T')[0],
    version: '',
    category: 'SCORING',
    impact: 'MEDIUM',
    description: '',
    details: '',
  });

  function loadEntries() {
    setLoading(true);
    fetchChangelog()
      .then(data => setEntries(data || []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadEntries(); }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.date || !form.category || !form.description.trim()) {
      setFormErr('Date, category, and description are required.');
      return;
    }
    setSaving(true);
    setFormErr('');
    try {
      await addChangelogEntry(form);
      setShowForm(false);
      setForm({ date: new Date().toISOString().split('T')[0], version: '', category: 'SCORING', impact: 'MEDIUM', description: '', details: '' });
      loadEntries();
    } catch (err) {
      setFormErr(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className={styles.loading} style={{ padding: 40 }}><div className={styles.spinner} /> Loading changelog…</div>;

  return (
    <div style={{ padding: 24, overflowY: 'auto', flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <span style={{ fontSize: 13, color: '#D4A017', fontWeight: 700 }}>System Changelog — {entries.length} entries</span>
        <button
          onClick={() => setShowForm(v => !v)}
          style={{ background: showForm ? '#1a1a1a' : 'rgba(212,160,23,0.12)', border: '1px solid #D4A017', color: '#D4A017', borderRadius: 6, padding: '6px 16px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
        >
          {showForm ? 'Cancel' : '+ Add Entry'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} style={{ background: '#1a1a1a', border: '1px solid #D4A017', borderRadius: 8, padding: 20, marginBottom: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={{ fontSize: 10, color: '#7a7a7a', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>Date</label>
              <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                style={{ width: '100%', background: '#111', border: '1px solid #2e2e2e', borderRadius: 4, color: '#c8c8c8', padding: '5px 8px', fontSize: 12 }} />
            </div>
            <div>
              <label style={{ fontSize: 10, color: '#7a7a7a', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>Version</label>
              <input type="text" placeholder="v3.2.0" value={form.version} onChange={e => setForm(f => ({ ...f, version: e.target.value }))}
                style={{ width: '100%', background: '#111', border: '1px solid #2e2e2e', borderRadius: 4, color: '#c8c8c8', padding: '5px 8px', fontSize: 12 }} />
            </div>
            <div>
              <label style={{ fontSize: 10, color: '#7a7a7a', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>Category</label>
              <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                style={{ width: '100%', background: '#111', border: '1px solid #2e2e2e', borderRadius: 4, color: '#c8c8c8', padding: '5px 8px', fontSize: 12 }}>
                {CHANGELOG_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 10, color: '#7a7a7a', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>Impact</label>
              <select value={form.impact} onChange={e => setForm(f => ({ ...f, impact: e.target.value }))}
                style={{ width: '100%', background: '#111', border: '1px solid #2e2e2e', borderRadius: 4, color: '#c8c8c8', padding: '5px 8px', fontSize: 12 }}>
                {CHANGELOG_IMPACTS.map(i => <option key={i} value={i}>{i}</option>)}
              </select>
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 10, color: '#7a7a7a', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>Description *</label>
            <input type="text" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Brief description of the change..."
              style={{ width: '100%', background: '#111', border: '1px solid #2e2e2e', borderRadius: 4, color: '#c8c8c8', padding: '6px 10px', fontSize: 12, boxSizing: 'border-box' }} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 10, color: '#7a7a7a', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>Details (optional)</label>
            <textarea value={form.details} onChange={e => setForm(f => ({ ...f, details: e.target.value }))}
              rows={3} placeholder="Additional context, motivation, or technical notes..."
              style={{ width: '100%', background: '#111', border: '1px solid #2e2e2e', borderRadius: 4, color: '#c8c8c8', padding: '6px 10px', fontSize: 12, resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' }} />
          </div>
          {formErr && <div style={{ fontSize: 12, color: '#ff6060', marginBottom: 10 }}>{formErr}</div>}
          <button type="submit" disabled={saving} style={{ background: '#D4A017', color: '#000', border: 'none', borderRadius: 5, padding: '7px 20px', fontSize: 12, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Saving…' : 'Save Entry'}
          </button>
        </form>
      )}

      {entries.length === 0 && !showForm && (
        <div style={{ textAlign: 'center', color: '#5a5a5a', padding: 40, fontSize: 14 }}>No changelog entries found.</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {entries.map((e, i) => (
          <div key={i} style={{ background: '#1a1a1a', border: '1px solid #222', borderRadius: 8, padding: '14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
              {/* Date pill */}
              <span style={{ fontSize: 11, fontWeight: 700, color: '#7a7a7a', background: '#111', border: '1px solid #2a2a2a', borderRadius: 4, padding: '2px 8px' }}>
                {e.date}
              </span>
              {/* Version badge */}
              {e.version && (
                <span style={{ fontSize: 10, fontWeight: 700, color: '#D4A017', background: 'rgba(212,160,23,0.1)', border: '1px solid rgba(212,160,23,0.3)', borderRadius: 4, padding: '2px 7px', letterSpacing: '0.04em' }}>
                  {e.version}
                </span>
              )}
              {/* Category badge */}
              {e.category && (
                <span style={{ fontSize: 10, fontWeight: 700, color: CATEGORY_COLORS[e.category] || '#8a8a8a', background: `${CATEGORY_COLORS[e.category] || '#8a8a8a'}18`, border: `1px solid ${CATEGORY_COLORS[e.category] || '#8a8a8a'}44`, borderRadius: 4, padding: '2px 7px', letterSpacing: '0.04em' }}>
                  {e.category}
                </span>
              )}
              {/* Impact badge */}
              {e.impact && (
                <span style={{ fontSize: 10, fontWeight: 700, color: IMPACT_COLORS[e.impact] || '#8a8a8a', background: `${IMPACT_COLORS[e.impact] || '#8a8a8a'}12`, border: `1px solid ${IMPACT_COLORS[e.impact] || '#8a8a8a'}33`, borderRadius: 4, padding: '2px 7px', letterSpacing: '0.04em' }}>
                  {e.impact}
                </span>
              )}
              {e.changedBy && e.changedBy !== 'PIPELINE' && (
                <span style={{ marginLeft: 'auto', fontSize: 10, color: '#5a5a5a' }}>by {e.changedBy}</span>
              )}
            </div>
            <div style={{ fontSize: 13, color: '#c8c8c8', lineHeight: 1.5 }}>{e.description}</div>
            {e.details && (
              <div style={{ marginTop: 6, fontSize: 11, color: '#5a5a5a', lineHeight: 1.5 }}>{e.details}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

const TABS = [
  { id: 'archive',    label: 'Signal Archive' },
  { id: 'market',     label: 'Market Conditions' },
  { id: 'dimensions', label: 'Dimension Lab' },
  { id: 'trades',     label: 'Trade Archive' },
  { id: 'changelog',  label: 'System Changelog' },
];

export default function SignalHistoryPage() {
  const [activeTab, setActiveTab]   = useState('archive');
  const [weeks, setWeeks]           = useState([]);

  useEffect(() => {
    fetchSignalHistoryWeeks()
      .then(w => setWeeks(w))
      .catch(err => console.error('History weeks:', err));
  }, []);

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <img src={pantherHead} alt="PNTHR" className={styles.headerLogo} />
          <div>
            <h1 className={styles.title}>Signal History</h1>
            <p className={styles.subtitle}>Weekly archive, market conditions, and system analytics</p>
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', borderBottom: '1px solid #1e1e1e', background: '#111', paddingLeft: 20, flexShrink: 0 }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              background: 'none',
              border: 'none',
              borderBottom: activeTab === tab.id ? '2px solid #D4A017' : '2px solid transparent',
              color: activeTab === tab.id ? '#D4A017' : '#6a6a6a',
              padding: '10px 18px',
              fontSize: 12,
              fontWeight: activeTab === tab.id ? 700 : 500,
              cursor: 'pointer',
              letterSpacing: '0.03em',
              transition: 'color 0.15s',
              whiteSpace: 'nowrap',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {activeTab === 'archive' && (
          <SignalArchiveTab weeks={weeks} onWeeksChange={setWeeks} />
        )}
        {activeTab === 'market' && (
          <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
            <MarketConditionsTab />
          </div>
        )}
        {activeTab === 'dimensions' && (
          <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
            <DimensionLabTab />
          </div>
        )}
        {activeTab === 'trades' && (
          <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
            <TradeArchiveTab />
          </div>
        )}
        {activeTab === 'changelog' && (
          <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
            <SystemChangelogTab />
          </div>
        )}
      </div>
    </div>
  );
}
