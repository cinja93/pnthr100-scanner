import { useState, useEffect, useMemo } from 'react';
import StockTable from './StockTable';
import ChartModal from './ChartModal';
import { fetchJungleStocks, fetchEarnings } from '../services/api';
import styles from './EarningsWeekPage.module.css';
import pantherHead from '../assets/panther head.png';

// Returns { from, to } date strings for the relevant earnings window
function getEarningsDateWindow() {
  const today = new Date();
  const dow = today.getDay(); // 0=Sun, 1=Mon…5=Fri, 6=Sat
  const fmt = d => d.toISOString().split('T')[0];

  const start = new Date(today);
  const end   = new Date(today);

  if (dow === 5) {
    // Friday: show today + all of next week (6 days)
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
    // Mon–Thu: today through this Friday
    end.setDate(today.getDate() + (5 - dow));
  }

  return { from: fmt(start), to: fmt(end) };
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

  const { from, to } = useMemo(() => getEarningsDateWindow(), []);

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
            Earnings Week
          </h1>
          <p className={styles.subtitle}>
            {!loading && !error
              ? totalCount > 0
                ? `${totalCount} Jungle stocks reporting across ${dates.length} day${dates.length !== 1 ? 's' : ''}`
                : 'No Jungle stocks reporting this period'
              : 'PNTHR 679 Jungle — upcoming earnings this week'}
          </p>
        </div>
        <button className={styles.refreshBtn} onClick={load} disabled={loading}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

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
