import { useState, useEffect } from 'react';
import { fetchEarningsWeek } from '../services/api';
import styles from './EarningsWeekPage.module.css';
import pantherHead from '../assets/panther head.png';

// Returns { from, to } date strings covering the relevant window
function getEarningsDateRange() {
  const today = new Date();
  const dow = today.getDay(); // 0=Sun, 1=Mon…5=Fri, 6=Sat
  const fmt = d => d.toISOString().split('T')[0];

  const start = new Date(today);
  const end   = new Date(today);

  if (dow === 5) {
    // Friday: show today through next Friday (6 trading days)
    end.setDate(today.getDate() + 7);
  } else if (dow === 6) {
    // Saturday: show next Mon–Fri
    start.setDate(today.getDate() + 2);
    end.setDate(today.getDate() + 6);
  } else if (dow === 0) {
    // Sunday: show next Mon–Fri
    start.setDate(today.getDate() + 1);
    end.setDate(today.getDate() + 5);
  } else {
    // Mon–Thu: show today through this Friday
    end.setDate(today.getDate() + (5 - dow));
  }

  return { from: fmt(start), to: fmt(end) };
}

function formatDayHeader(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function formatRevenue(val) {
  if (val == null) return '—';
  if (Math.abs(val) >= 1e9) return `$${(val / 1e9).toFixed(2)}B`;
  if (Math.abs(val) >= 1e6) return `$${(val / 1e6).toFixed(1)}M`;
  return `$${val.toFixed(0)}`;
}

export default function EarningsWeekPage() {
  const [byDate, setByDate]   = useState({});
  const [dates, setDates]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const { from, to } = getEarningsDateRange();
      const result = await fetchEarningsWeek(from, to);
      setByDate(result.byDate || {});
      setDates(result.dates || []);
    } catch (err) {
      setError('Failed to load earnings calendar.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  const totalCount = dates.reduce((sum, d) => sum + (byDate[d]?.length || 0), 0);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>
            <img src={pantherHead} alt="PNTHR" className={styles.pantherLogo} />
            Earnings Week
          </h1>
          <p className={styles.subtitle}>
            {!loading && !error
              ? `${totalCount} companies reporting across ${dates.length} day${dates.length !== 1 ? 's' : ''}`
              : 'Upcoming earnings reports for this week'}
          </p>
        </div>
        <button className={styles.refreshBtn} onClick={load} disabled={loading}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {loading && (
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <p>Loading earnings calendar…</p>
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
          <p>No earnings reported for this period.</p>
        </div>
      )}

      {!loading && !error && dates.map(date => {
        const stocks = byDate[date] || [];
        return (
          <div key={date} className={styles.daySection}>
            <h2 className={styles.dayHeader}>{formatDayHeader(date)}</h2>
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th>Company</th>
                    <th>Time</th>
                    <th>EPS Est</th>
                    <th>EPS Actual</th>
                    <th>Rev Est</th>
                  </tr>
                </thead>
                <tbody>
                  {stocks.map(s => (
                    <tr key={s.ticker}>
                      <td className={styles.tickerCell}>{s.ticker}</td>
                      <td className={styles.nameCell}>{s.name}</td>
                      <td className={styles.timeCell}>
                        {s.time === 'bmo'
                          ? <span className={styles.bmoBadge}>BMO</span>
                          : s.time === 'amc'
                          ? <span className={styles.amcBadge}>AMC</span>
                          : <span className={styles.noTime}>—</span>}
                      </td>
                      <td className={styles.numCell}>
                        {s.epsEstimated != null ? s.epsEstimated.toFixed(2) : '—'}
                      </td>
                      <td className={styles.numCell}>
                        {s.eps != null
                          ? <span className={s.eps >= (s.epsEstimated ?? s.eps) ? styles.beat : styles.miss}>
                              {s.eps.toFixed(2)}
                            </span>
                          : '—'}
                      </td>
                      <td className={styles.numCell}>{formatRevenue(s.revenueEstimated)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
