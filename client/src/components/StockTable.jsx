import { useState } from 'react';
import styles from './StockTable.module.css';

import confirmedBuyIcon from './Confirmed Buy Signal.png';
import confirmedSellIcon from './Confirmed Sell Signal.png';
import cautionBuyIcon from './Caution Buy Signal.png';
import cautionSellIcon from './Caution Sell Signal.png';
import newConfirmedBuyIcon from './New Confirmed Buy Signal.png';
import newConfirmedSellIcon from './New Confirmed Sell Signal.png';
import newCautionBuyIcon from './New Caution Buy Signal.png';
import newCautionSellIcon from './New Caution Sell Signal.png';

// Map signal + isNewSignal to the correct icon
function getSignalDisplay(signalData) {
  if (!signalData) return { icon: null, alt: '—' };
  const { signal, isNewSignal } = signalData;
  if (signal === 'BUY')         return { icon: isNewSignal ? newConfirmedBuyIcon  : confirmedBuyIcon,  alt: isNewSignal ? 'New Confirmed Buy'  : 'Confirmed Buy'  };
  if (signal === 'SELL')        return { icon: isNewSignal ? newConfirmedSellIcon : confirmedSellIcon, alt: isNewSignal ? 'New Confirmed Sell' : 'Confirmed Sell' };
  if (signal === 'YELLOW_BUY')  return { icon: isNewSignal ? newCautionBuyIcon   : cautionBuyIcon,    alt: isNewSignal ? 'New Caution Buy'    : 'Caution Buy'    };
  if (signal === 'YELLOW_SELL') return { icon: isNewSignal ? newCautionSellIcon  : cautionSellIcon,   alt: isNewSignal ? 'New Caution Sell'   : 'Caution Sell'   };
  return { icon: null, alt: signal };
}

// Signal sort order: buys first, sells last, no signal at bottom
const SIGNAL_ORDER = { BUY: 1, YELLOW_BUY: 2, YELLOW_SELL: 3, SELL: 4 };

export default function StockTable({ stocks, signals = {}, onTickerClick }) {
  const [sortConfig, setSortConfig] = useState({
    key: 'ytdReturn',
    direction: 'desc'
  });

  // Sort stocks based on current sort configuration
  const sortedStocks = [...stocks].sort((a, b) => {
    const dir = sortConfig.direction === 'asc' ? 1 : -1;

    // Special handling for signal column (data lives in signals map, not stock object)
    if (sortConfig.key === 'signal') {
      const aOrder = SIGNAL_ORDER[signals[a.ticker]?.signal] ?? 99;
      const bOrder = SIGNAL_ORDER[signals[b.ticker]?.signal] ?? 99;
      return (aOrder - bOrder) * dir;
    }

    // Special handling for stop price (from signals map)
    if (sortConfig.key === 'stopPrice') {
      const aVal = signals[a.ticker]?.stopPrice ?? null;
      const bVal = signals[b.ticker]?.stopPrice ?? null;
      if (aVal === null && bVal === null) return 0;
      if (aVal === null) return dir;
      if (bVal === null) return -dir;
      return (aVal - bVal) * dir;
    }

    // Special handling for risk $ (derived from signals + stock)
    if (sortConfig.key === 'riskDollar') {
      const aStop = signals[a.ticker]?.stopPrice;
      const bStop = signals[b.ticker]?.stopPrice;
      const aVal = aStop != null ? Math.abs(a.currentPrice - aStop) : null;
      const bVal = bStop != null ? Math.abs(b.currentPrice - bStop) : null;
      if (aVal === null && bVal === null) return 0;
      if (aVal === null) return dir;
      if (bVal === null) return -dir;
      return (aVal - bVal) * dir;
    }

    // Special handling for risk % (derived from signals + stock)
    if (sortConfig.key === 'riskPct') {
      const aStop = signals[a.ticker]?.stopPrice;
      const bStop = signals[b.ticker]?.stopPrice;
      const aVal = aStop != null ? (Math.abs(a.currentPrice - aStop) / a.currentPrice) * 100 : null;
      const bVal = bStop != null ? (Math.abs(b.currentPrice - bStop) / b.currentPrice) * 100 : null;
      if (aVal === null && bVal === null) return 0;
      if (aVal === null) return dir;
      if (bVal === null) return -dir;
      return (aVal - bVal) * dir;
    }

    const aValue = a[sortConfig.key];
    const bValue = b[sortConfig.key];

    // Handle null values (for rankChange)
    if (aValue === null && bValue === null) return 0;
    if (aValue === null) return dir;
    if (bValue === null) return -dir;

    // Handle string vs number comparison
    if (typeof aValue === 'string') {
      return aValue.localeCompare(bValue) * dir;
    } else {
      return (aValue - bValue) * dir;
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
            <th onClick={() => handleSort('rankChange')} className={styles.sortable}>
              Rank Change {getSortIndicator('rankChange')}
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
            <th onClick={() => handleSort('stopPrice')} className={styles.sortable}>
              Stop Price {getSortIndicator('stopPrice')}
            </th>
            <th onClick={() => handleSort('riskDollar')} className={styles.sortable}>
              Risk $ {getSortIndicator('riskDollar')}
            </th>
            <th onClick={() => handleSort('riskPct')} className={styles.sortable}>
              Risk % {getSortIndicator('riskPct')}
            </th>
            <th onClick={() => handleSort('signal')} className={`${styles.signalColumn} ${styles.sortable}`}>
              Signal {getSortIndicator('signal')}
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedStocks.map((stock) => {
            const signalData = signals[stock.ticker];
            const { icon, alt } = getSignalDisplay(signalData);
            const stopPrice = signalData?.stopPrice ?? null;
            const riskDollar = stopPrice != null ? Math.abs(stock.currentPrice - stopPrice) : null;
            const riskPct = riskDollar != null ? (riskDollar / stock.currentPrice) * 100 : null;
            const rankDisplay = getRankChangeDisplay(stock);

            return (
              <tr
                key={stock.ticker}
                className={styles.clickableRow}
                onClick={() => onTickerClick?.(stock)}
                title={stock.companyName ? `${stock.companyName} — Click to view chart` : 'Click to view chart'}
              >
                <td className={styles.rankColumn}>{stock.rank ?? '—'}</td>
                <td
                  className={rankDisplay.className}
                  title={stock.previousRank ? `Previous rank: #${stock.previousRank}` : 'New entry'}
                >
                  {rankDisplay.text}
                </td>
                <td className={styles.ticker}>
                  {stock.ticker}
                </td>
                <td>{stock.exchange}</td>
                <td>{stock.sector}</td>
                <td className={styles.price}>${stock.currentPrice.toLocaleString()}</td>
                <td className={stock.ytdReturn >= 0 ? styles.positive : styles.negative}>
                  {stock.ytdReturn >= 0 ? '+' : ''}{stock.ytdReturn.toFixed(2)}%
                </td>
                <td className={styles.stopPriceCell}>
                  {stopPrice != null ? `$${stopPrice.toLocaleString()}` : '—'}
                </td>
                <td className={styles.riskCell}>
                  {riskDollar != null ? `$${riskDollar.toFixed(2)}` : '—'}
                </td>
                <td className={styles.riskCell}>
                  {riskPct != null ? `${riskPct.toFixed(2)}%` : '—'}
                </td>
                <td className={styles.signalColumn}>
                  {icon
                    ? <img src={icon} alt={alt} className={styles.signalIcon} title={alt} />
                    : <span className={styles.signalNone}>—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
