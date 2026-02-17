import { useState } from 'react';
import styles from './StockTable.module.css';

export default function StockTable({ stocks, onTickerClick }) {
  const [sortConfig, setSortConfig] = useState({
    key: 'ytdReturn',
    direction: 'desc'
  });

  // Sort stocks based on current sort configuration
  const sortedStocks = [...stocks].sort((a, b) => {
    const aValue = a[sortConfig.key];
    const bValue = b[sortConfig.key];

    // Handle null values (for rankChange)
    if (aValue === null && bValue === null) return 0;
    if (aValue === null) return sortConfig.direction === 'asc' ? 1 : -1;
    if (bValue === null) return sortConfig.direction === 'asc' ? -1 : 1;

    // Handle string vs number comparison
    if (typeof aValue === 'string') {
      const comparison = aValue.localeCompare(bValue);
      return sortConfig.direction === 'asc' ? comparison : -comparison;
    } else {
      const comparison = aValue - bValue;
      return sortConfig.direction === 'asc' ? comparison : -comparison;
    }
  });

  // Handle column header click
  const handleSort = (key) => {
    setSortConfig(prevConfig => ({
      key,
      direction: prevConfig.key === key && prevConfig.direction === 'desc' ? 'asc' : 'desc'
    }));
  };

  // Get sort indicator for column
  const getSortIndicator = (key) => {
    if (sortConfig.key !== key) return '⇅';
    return sortConfig.direction === 'asc' ? '▲' : '▼';
  };

  // Get rank change display with arrow and color (rankChange: null/undefined = New, number = up/down/same)
  const getRankChangeDisplay = (stock) => {
    const change = stock.rankChange;
    if (change === null || change === undefined) {
      return { text: '➖ New', className: styles.rankNew };
    }
    const n = Number(change);
    if (n > 0) return { text: `▲ +${n}`, className: styles.rankUp };
    if (n < 0) return { text: `▼ ${n}`, className: styles.rankDown };
    return { text: '— —', className: styles.rankNew };
  };

  return (
    <div className={styles.tableContainer}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th onClick={() => handleSort('rank')} className={`${styles.rankColumn} ${styles.sortable}`} scope="col">
              Rank {getSortIndicator('rank')}
            </th>
            <th onClick={() => handleSort('ticker')} className={styles.sortable}>
              Ticker {getSortIndicator('ticker')}
            </th>
            <th onClick={() => handleSort('exchange')} className={styles.sortable}>
              Exchange {getSortIndicator('exchange')}
            </th>
            <th onClick={() => handleSort('sector')} className={styles.sortable}>
              Sector {getSortIndicator('sector')}
            </th>
            <th onClick={() => handleSort('currentPrice')} className={styles.sortable}>
              Current Price {getSortIndicator('currentPrice')}
            </th>
            <th onClick={() => handleSort('ytdReturn')} className={styles.sortable}>
              YTD Return {getSortIndicator('ytdReturn')}
            </th>
            <th onClick={() => handleSort('rankChange')} className={styles.sortable}>
              Rank Change {getSortIndicator('rankChange')}
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedStocks.map((stock) => (
            <tr key={stock.ticker}>
              <td className={styles.rankColumn}>{stock.rank ?? '—'}</td>
              <td
                className={styles.ticker}
                onClick={() => onTickerClick?.(stock)}
                title="Click to view 12-week history"
              >
                {stock.ticker}
              </td>
              <td>{stock.exchange}</td>
              <td>{stock.sector}</td>
              <td className={styles.price}>${stock.currentPrice.toLocaleString()}</td>
              <td className={stock.ytdReturn >= 0 ? styles.positive : styles.negative}>
                {stock.ytdReturn >= 0 ? '+' : ''}{stock.ytdReturn.toFixed(2)}%
              </td>
              <td
                className={getRankChangeDisplay(stock).className}
                title={stock.previousRank ? `Previous rank: #${stock.previousRank}` : 'New entry'}
              >
                {getRankChangeDisplay(stock).text}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
