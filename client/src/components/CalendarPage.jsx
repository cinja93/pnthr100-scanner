import { useState, useEffect, useMemo } from 'react';
import StockTable from './StockTable';
import ChartModal from './ChartModal';
import { fetchJungleStocks, fetchEarnings, fetchWashRules } from '../services/api';
import styles from './CalendarPage.module.css';
import pantherHead from '../assets/panther head.png';

// Returns { from, to, isNextWeek } for the relevant week window.
// Thu–Sun: show NEXT week Mon–Fri (users plan ahead on Thursday).
// Mon–Wed: show current week today through Friday.
function getWeekWindow() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = today.getDay(); // 0=Sun, 1=Mon…5=Fri, 6=Sat
  const fmt = d => d.toISOString().split('T')[0];

  const start = new Date(today);
  const end   = new Date(today);

  const showNextWeek = dow >= 4 || dow === 0 || dow === 6; // Thu/Fri/Sat/Sun

  if (showNextWeek) {
    const daysToNextMon = dow === 0 ? 1 : dow === 6 ? 2 : (8 - dow);
    start.setDate(today.getDate() + daysToNextMon);
    end.setDate(today.getDate() + daysToNextMon + 4); // Mon–Fri
  } else {
    end.setDate(today.getDate() + (5 - dow)); // today through Friday
  }

  return { from: fmt(start), to: fmt(end), isNextWeek: showNextWeek };
}

function formatDayHeader(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function toDateStr(val) {
  if (!val) return null;
  const d = typeof val === 'string' ? val : new Date(val).toISOString();
  return d.split('T')[0];
}

// ── Wash Sale Expiry Row ──────────────────────────────────────────────────────
function WashSaleRow({ rule }) {
  const loss = rule.performance?.realizedPnlDollar;
  const lossAmt = loss != null ? Math.abs(loss) : null;
  const daysLeft = rule.washSale?.daysRemaining ?? 0;

  return (
    <div className={styles.washRow}>
      <div className={styles.washLeft}>
        <span className={styles.washTicker}>{rule.ticker}</span>
        <span className={`${styles.washDir} ${rule.direction === 'SHORT' ? styles.washDirShort : styles.washDirLong}`}>
          {rule.direction === 'SHORT' ? 'SS' : 'BL'}
        </span>
        <span className={styles.washLabel}>WASH SALE EXPIRES</span>
      </div>
      <div className={styles.washRight}>
        {lossAmt != null && (
          <span className={styles.washLoss}>
            Loss: <strong>${lossAmt.toFixed(2)}</strong>
          </span>
        )}
        <span className={`${styles.washDays} ${daysLeft <= 3 ? styles.washDaysUrgent : daysLeft <= 7 ? styles.washDaysWarn : ''}`}>
          {daysLeft === 0 ? 'Expires today' : daysLeft === 1 ? '1 day left' : `${daysLeft} days left`}
        </span>
      </div>
    </div>
  );
}

// ── Wash Sale Section ─────────────────────────────────────────────────────────
function WashSaleSection({ rules }) {
  if (!rules || rules.length === 0) return null;
  return (
    <div className={styles.washSection}>
      <div className={styles.washSectionHeader}>
        <span className={styles.washSectionIcon}>⚠</span>
        {' '}WASH SALE EXPIRATION{rules.length > 1 ? 'S' : ''}
      </div>
      {rules.map((rule, i) => (
        <WashSaleRow key={rule._id || rule.ticker + i} rule={rule} />
      ))}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function CalendarPage() {
  const [stocks, setStocks]           = useState([]);
  const [signals, setSignals]         = useState({});
  const [earnings, setEarnings]       = useState({});
  const [washRules, setWashRules]     = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [chartIndex, setChartIndex]   = useState(null);
  const [chartStocks, setChartStocks] = useState([]);

  function load() {
    setLoading(true);
    setError(null);

    const junglePromise = fetchJungleStocks()
      .then(data => {
        const stockList = data.stocks || [];
        setStocks(stockList);
        setSignals(data.signals || {});
        return fetchEarnings(stockList.map(s => s.ticker)).then(e => setEarnings(e));
      });

    const washPromise = fetchWashRules()
      .then(rules => setWashRules(Array.isArray(rules) ? rules : []))
      .catch(() => setWashRules([]));

    Promise.all([junglePromise, washPromise])
      .catch(err => {
        console.error(err);
        setError('Failed to load calendar data.');
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  const { from, to, isNextWeek } = useMemo(() => getWeekWindow(), []);

  // Earnings grouped by date
  const earningsByDate = useMemo(() => {
    const groups = {};
    for (const stock of stocks) {
      const date = earnings[stock.ticker];
      if (!date || date < from || date > to) continue;
      if (!groups[date]) groups[date] = [];
      groups[date].push(stock);
    }
    return groups;
  }, [stocks, earnings, from, to]);

  // Wash sales grouped by expiry date
  const washByDate = useMemo(() => {
    const groups = {};
    for (const rule of washRules) {
      const date = toDateStr(rule.washSale?.expiryDate);
      if (!date || date < from || date > to) continue;
      if (!groups[date]) groups[date] = [];
      groups[date].push(rule);
    }
    return groups;
  }, [washRules, from, to]);

  // All unique dates that appear in either earnings or wash sales
  const allDates = useMemo(() => {
    const set = new Set([
      ...Object.keys(earningsByDate),
      ...Object.keys(washByDate),
    ]);
    return Array.from(set).sort();
  }, [earningsByDate, washByDate]);

  const earningsCount = allDates.reduce((sum, d) => sum + (earningsByDate[d]?.length || 0), 0);
  const washCount     = allDates.reduce((sum, d) => sum + (washByDate[d]?.length || 0), 0);

  function handleRowClick(_s, idx, sortedStocks) {
    setChartStocks(sortedStocks);
    setChartIndex(idx);
  }

  function buildSubtitle() {
    if (loading || error) return `PNTHR 679 Jungle earnings + wash sale expirations ${isNextWeek ? 'next week' : 'this week'}`;
    const parts = [];
    if (earningsCount > 0) parts.push(`${earningsCount} Jungle stock${earningsCount !== 1 ? 's' : ''} reporting`);
    if (washCount > 0) parts.push(`${washCount} wash sale expiration${washCount !== 1 ? 's' : ''}`);
    if (parts.length === 0) return `Nothing scheduled ${isNextWeek ? 'next week' : 'this week'}`;
    return parts.join(' · ') + ` ${isNextWeek ? 'next week' : 'this week'}`;
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>
            <img src={pantherHead} alt="PNTHR" className={styles.pantherLogo} />
            PNTHR Calendar — {isNextWeek ? 'Next Week' : 'This Week'}
          </h1>
          <p className={styles.subtitle}>{buildSubtitle()}</p>
        </div>
        <button className={styles.refreshBtn} onClick={load} disabled={loading}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {loading && (
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <p>Loading calendar…</p>
        </div>
      )}

      {error && !loading && (
        <div className={styles.errorState}>
          <p>{error}</p>
          <button className={styles.retryBtn} onClick={load}>Try Again</button>
        </div>
      )}

      {!loading && !error && allDates.length === 0 && (
        <div className={styles.emptyState}>
          <p>Nothing scheduled {isNextWeek ? 'next week' : 'this week'}.</p>
        </div>
      )}

      {!loading && !error && allDates.map(date => (
        <div key={date} className={styles.daySection}>
          <h2 className={styles.dayHeader}>{formatDayHeader(date)}</h2>

          {/* Wash sale expirations for this day */}
          <WashSaleSection rules={washByDate[date]} />

          {/* Earnings stocks for this day */}
          {earningsByDate[date]?.length > 0 && (
            <div className={styles.earningsSection}>
              {washByDate[date]?.length > 0 && (
                <div className={styles.earningsSectionHeader}>
                  📅 EARNINGS REPORTING
                </div>
              )}
              <StockTable
                stocks={earningsByDate[date]}
                signals={signals}
                signalsLoading={false}
                earnings={earnings}
                onTickerClick={handleRowClick}
                scanType="long"
                compact={true}
                highlightAllEarnings={true}
              />
            </div>
          )}
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
