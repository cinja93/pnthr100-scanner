import { useState, useEffect, useMemo } from 'react';
import StockTable from './StockTable';
import ChartModal from './ChartModal';
import { fetchJungleStocks, fetchEarnings } from '../services/api';
import styles from './EarningsWeekPage.module.css';
import pantherHead from '../assets/panther head.png';

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
