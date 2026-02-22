import { useState, useEffect } from 'react';
import { fetchStockHistory } from '../services/api';
import styles from './StockModal.module.css';

export default function StockModal({ stock, onClose }) {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadStockHistory();
  }, [stock.ticker]);

  async function loadStockHistory() {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchStockHistory(stock.ticker);
      setHistory(data);
    } catch (err) {
      setError('Failed to load stock history');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  function formatDate(dateString) {
    const date = new Date(dateString + 'T00:00:00');
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function getRankChange(currentIndex) {
    if (currentIndex >= history.length - 1) return null;

    const current = history[currentIndex];
    const previous = history[currentIndex + 1];

    if (!current.rank || !previous.rank) return null;

    const change = previous.rank - current.rank;
    return change;
  }

  // Click outside to close
  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) {
      onClose();
    }
  }

  return (
    <div className={styles.modalBackdrop} onClick={handleBackdropClick}>
      <div className={styles.modalContent}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.stockInfo}>
            <h2 className={styles.ticker}>{stock.ticker}</h2>
            {stock.companyName && <p className={styles.companyName}>{stock.companyName}</p>}
            <div className={styles.badges}>
              <span className={styles.badge}>{stock.sector}</span>
              <span className={styles.badge}>{stock.exchange}</span>
            </div>
          </div>
          <button className={styles.closeButton} onClick={onClose} title="Close">
            ×
          </button>
        </div>

        {/* Body */}
        <div className={styles.body}>
          {loading && (
            <div className={styles.loading}>
              <div className={styles.spinner}></div>
              <p>Loading history...</p>
            </div>
          )}

          {error && (
            <div className={styles.error}>{error}</div>
          )}

          {!loading && !error && history.length === 0 && (
            <div className={styles.emptyState}>
              No historical data available yet. Check back after Friday!
            </div>
          )}

          {!loading && !error && history.length > 0 && (
            <div className={styles.historyContainer}>
              <h3 className={styles.sectionTitle}>12-Week Rank Progression</h3>

              <table className={styles.historyTable}>
                <thead>
                  <tr>
                    <th>Week Of</th>
                    <th>Rank</th>
                    <th>Change</th>
                    <th>YTD Return</th>
                    <th>Price</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((week, index) => {
                    const rankChange = getRankChange(index);

                    return (
                      <tr key={week.date} className={index === 0 ? styles.latestWeek : ''}>
                        <td>{formatDate(week.date)}</td>
                        <td className={styles.rankCell}>
                          {week.rank ? `#${week.rank}` : '—'}
                        </td>
                        <td className={styles.changeCell}>
                          {rankChange === null ? (
                            <span className={styles.noChange}>—</span>
                          ) : rankChange > 0 ? (
                            <span className={styles.improved}>🔺 +{rankChange}</span>
                          ) : rankChange < 0 ? (
                            <span className={styles.declined}>🔻 {rankChange}</span>
                          ) : (
                            <span className={styles.noChange}>—</span>
                          )}
                        </td>
                        <td className={week.ytdReturn && week.ytdReturn >= 0 ? styles.positive : styles.negative}>
                          {week.ytdReturn !== null ? `${week.ytdReturn >= 0 ? '+' : ''}${week.ytdReturn.toFixed(2)}%` : '—'}
                        </td>
                        <td>
                          {week.currentPrice !== null ? `$${week.currentPrice.toLocaleString()}` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
