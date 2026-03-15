import { useState, useEffect, useRef } from 'react';
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
  if (signal === 'BL'  || signal === 'BUY')         return { icon: isNewSignal ? newConfirmedBuyIcon  : confirmedBuyIcon,  alt: isNewSignal ? 'New BL'  : 'BL'  };
  if (signal === 'SS'  || signal === 'SELL')        return { icon: isNewSignal ? newConfirmedSellIcon : confirmedSellIcon, alt: isNewSignal ? 'New SS'  : 'SS'  };
  if (signal === 'YELLOW_BUY')  return { icon: isNewSignal ? newCautionBuyIcon   : cautionBuyIcon,    alt: isNewSignal ? 'New Caution Buy'    : 'Caution Buy'    };
  if (signal === 'YELLOW_SELL') return { icon: isNewSignal ? newCautionSellIcon  : cautionSellIcon,   alt: isNewSignal ? 'New Caution Sell'   : 'Caution Sell'   };
  return { icon: null, alt: signal };
}

// Signal sort order: buys first, sells last, no signal at bottom
const SIGNAL_ORDER = { BL: 1, BUY: 1, BE: 2, YELLOW_BUY: 3, YELLOW_SELL: 4, SE: 5, SS: 6, SELL: 6 };

// Inclusive weeks since signal (signal week = week 1)
function computeWeeksAgo(signalDate) {
  if (!signalDate) return null;
  const signalMonday = new Date(signalDate + 'T12:00:00');
  const today = new Date();
  const dow = today.getDay();
  const daysToMonday = dow === 0 ? -6 : 1 - dow;
  const currentMonday = new Date(today);
  currentMonday.setDate(today.getDate() + daysToMonday);
  currentMonday.setHours(0, 0, 0, 0);
  const diffDays = Math.round((currentMonday - signalMonday) / (1000 * 60 * 60 * 24));
  return Math.floor(diffDays / 7) + 1;
}

const TODAY = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();

function getEarningsInfo(dateStr) {
  if (!dateStr) return { display: '—', daysAway: null, highlight: false };
  const [y, m, d] = dateStr.split('-').map(Number);
  const earningsDate = new Date(y, m - 1, d);
  const daysAway = Math.round((earningsDate - TODAY) / (1000 * 60 * 60 * 24));
  const display = earningsDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return { display, daysAway, highlight: daysAway >= 0 && daysAway <= 5 };
}

function matchesPinSignal(sigData, pinSignal) {
  if (!sigData || !pinSignal) return false;
  if (pinSignal === 'newBL') return sigData.signal === 'BL' && sigData.isNewSignal;
  if (pinSignal === 'newSS') return sigData.signal === 'SS' && sigData.isNewSignal;
  return sigData.signal === pinSignal;
}

export default function StockTable({ stocks, signals = {}, laserSignals = {}, signalsLoading = false, earnings = {}, scannerRanks = null, hideSector = false, hideEarnings = false, groupBySector = false, groupByCategory = false, pinSignal = null, compact = false, highlightAllEarnings = false, onTickerClick, onRemove, scanType, rankLabel = 'Performance Rank' }) {
  const [sortConfig, setSortConfig] = useState({ key: (groupBySector || groupByCategory) ? 'ytdReturn' : 'rank', direction: (groupBySector || groupByCategory) ? 'desc' : 'asc' });
  const [selectedTicker, setSelectedTicker] = useState(null);
  const listRef = useRef([]);

  // Arrow-key navigation through visible rows
  useEffect(() => {
    function onKey(e) {
      if (!selectedTicker) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const list = listRef.current;
      const idx = list.findIndex(s => s.ticker === selectedTicker);
      if (idx === -1) return;
      const next = e.key === 'ArrowDown'
        ? Math.min(idx + 1, list.length - 1)
        : Math.max(idx - 1, 0);
      setSelectedTicker(list[next].ticker);
      document.getElementById(`strow-${list[next].ticker}`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selectedTicker]);

  const hasScannerRanks = scannerRanks !== null;

  // Sort stocks based on current sort configuration
  const sortedStocks = [...stocks].sort((a, b) => {
    // pinSignal: matching stocks always float to the top
    if (pinSignal) {
      const aPin = matchesPinSignal(signals[a.ticker], pinSignal);
      const bPin = matchesPinSignal(signals[b.ticker], pinSignal);
      if (aPin && !bPin) return -1;
      if (!aPin && bPin) return 1;
    }
    const dir = sortConfig.direction === 'asc' ? 1 : -1;

    // Special handling for rank when using scanner ranks (nulls sort last)
    if (sortConfig.key === 'rank' && hasScannerRanks) {
      const aRank = scannerRanks[a.ticker?.toUpperCase()]?.rank ?? null;
      const bRank = scannerRanks[b.ticker?.toUpperCase()]?.rank ?? null;
      if (aRank === null && bRank === null) return 0;
      if (aRank === null) return dir;
      if (bRank === null) return -dir;
      return (aRank - bRank) * dir;
    }

    // Special handling for signal column: sort by type THEN weeks
    // e.g. BL+1 < BL+2 < BL+3 ... < SS+1 < SS+2 < SS+3 ...
    if (sortConfig.key === 'signal') {
      const aSig  = signals[a.ticker];
      const bSig  = signals[b.ticker];
      const aType = SIGNAL_ORDER[aSig?.signal] ?? 99;
      const bType = SIGNAL_ORDER[bSig?.signal] ?? 99;
      const aWks  = computeWeeksAgo(aSig?.signalDate) ?? 9999;
      const bWks  = computeWeeksAgo(bSig?.signalDate) ?? 9999;
      return (aType * 10000 + aWks - (bType * 10000 + bWks)) * dir;
    }

    // Special handling for weeks since signal: sort by weeks THEN type
    // e.g. BL+1, SS+1, BL+2, SS+2 ...
    if (sortConfig.key === 'weeksAgo') {
      const aSig  = signals[a.ticker];
      const bSig  = signals[b.ticker];
      const aWks  = computeWeeksAgo(aSig?.signalDate) ?? 9999;
      const bWks  = computeWeeksAgo(bSig?.signalDate) ?? 9999;
      const aType = SIGNAL_ORDER[aSig?.signal] ?? 99;
      const bType = SIGNAL_ORDER[bSig?.signal] ?? 99;
      return (aWks * 10000 + aType - (bWks * 10000 + bType)) * dir;
    }

    // Special handling for stop price / risk columns — 3-state sort:
    //   asc:         active (low→high) → PAUSE → no signal
    //   desc:        active (high→low) → PAUSE → no signal
    //   pause-first: PAUSE → active (high→low) → no signal
    if (sortConfig.key === 'stopPrice' || sortConfig.key === 'riskDollar' || sortConfig.key === 'riskPct') {
      const isPauseFirst = sortConfig.direction === 'pause-first';
      const numDir = (sortConfig.direction === 'asc') ? 1 : -1; // pause-first also sorts numerics desc

      const aSig = signals[a.ticker]?.signal;
      const bSig = signals[b.ticker]?.signal;
      const aIsPause = aSig === 'BE' || aSig === 'SE';
      const bIsPause = bSig === 'BE' || bSig === 'SE';

      let aVal, bVal;
      if (sortConfig.key === 'stopPrice') {
        aVal = signals[a.ticker]?.stopPrice ?? null;
        bVal = signals[b.ticker]?.stopPrice ?? null;
      } else {
        const aStop = signals[a.ticker]?.stopPrice;
        const bStop = signals[b.ticker]?.stopPrice;
        if (sortConfig.key === 'riskDollar') {
          aVal = aStop != null ? Math.abs(a.currentPrice - aStop) : null;
          bVal = bStop != null ? Math.abs(b.currentPrice - bStop) : null;
        } else {
          aVal = aStop != null ? (Math.abs(a.currentPrice - aStop) / a.currentPrice) * 100 : null;
          bVal = bStop != null ? (Math.abs(b.currentPrice - bStop) / b.currentPrice) * 100 : null;
        }
      }

      // Assign tiers based on mode
      // pause-first: PAUSE=0, active=1, none=2
      // asc/desc:    active=0, PAUSE=1, none=2
      const aTier = aIsPause ? (isPauseFirst ? 0 : 1) : aVal !== null ? (isPauseFirst ? 1 : 0) : 2;
      const bTier = bIsPause ? (isPauseFirst ? 0 : 1) : bVal !== null ? (isPauseFirst ? 1 : 0) : 2;

      if (aTier !== bTier) return aTier - bTier;
      if (aIsPause && bIsPause) return 0; // both PAUSE, equal
      if (aVal === null && bVal === null) return 0; // both no-signal
      if (aVal === null) return 1;
      if (bVal === null) return -1;
      return (aVal - bVal) * numDir;
    }

    // Special handling for earnings date (from earnings map)
    if (sortConfig.key === 'earningsDate') {
      const aVal = earnings[a.ticker] ?? null;
      const bVal = earnings[b.ticker] ?? null;
      if (aVal === null && bVal === null) return 0;
      if (aVal === null) return dir;
      if (bVal === null) return -dir;
      return (aVal < bVal ? -1 : aVal > bVal ? 1 : 0) * dir;
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
  const STOP_KEYS = new Set(['stopPrice', 'riskDollar', 'riskPct']);
  const handleSort = (key) => {
    setSortConfig(prevConfig => {
      if (prevConfig.key !== key) return { key, direction: 'asc' };
      if (STOP_KEYS.has(key)) {
        // 3-state: asc (low→high, PAUSE last) → desc (high→low, PAUSE last) → pause-first (PAUSE top, then high→low)
        if (prevConfig.direction === 'asc') return { key, direction: 'desc' };
        if (prevConfig.direction === 'desc') return { key, direction: 'pause-first' };
        return { key, direction: 'asc' };
      }
      return { key, direction: prevConfig.direction === 'desc' ? 'asc' : 'desc' };
    });
  };

  // Get sort indicator for column
  const getSortIndicator = (key) => {
    const isActive = sortConfig.key === key;
    let symbol;
    if (!isActive) symbol = '↕';
    else if (sortConfig.direction === 'pause-first') symbol = '⏸';
    else symbol = sortConfig.direction === 'asc' ? '▲' : '▼';
    return (
      <span style={{ display: 'block', marginTop: '3px', fontSize: '11px', opacity: isActive ? 1 : 0.6, color: isActive ? '#fcf000' : 'inherit' }}>
        {symbol}
      </span>
    );
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

  // Build display order (may differ from sortedStocks when groupBySector/groupByCategory)
  let displayStocks = sortedStocks;
  if (groupBySector) {
    const _grp = {};
    for (const s of sortedStocks) { const sec = s.sector || 'Other'; if (!_grp[sec]) _grp[sec] = []; _grp[sec].push(s); }
    displayStocks = Object.keys(_grp).sort().flatMap(sec => _grp[sec]);
  } else if (groupByCategory) {
    const _seen = new Set(); const _ord = [];
    for (const s of sortedStocks) { const c = s.category || 'Other'; if (!_seen.has(c)) { _seen.add(c); _ord.push(c); } }
    const _grp = {};
    for (const s of sortedStocks) { const c = s.category || 'Other'; if (!_grp[c]) _grp[c] = []; _grp[c].push(s); }
    displayStocks = _ord.flatMap(c => _grp[c]);
  }
  listRef.current = displayStocks;

  const colCount =
    10 +
    (!onRemove ? 1 : 0) +
    (!onRemove ? 1 : 0) +
    (!hideSector ? 1 : 0) +
    (onRemove ? 1 : 0) +
    (hideEarnings ? -1 : 0);

  return (
    <div className={styles.tableContainer} style={compact ? { minHeight: 0 } : undefined}>
      <table className={styles.table}>
        <thead>
          <tr>
            {!onRemove && <th onClick={() => handleSort('rank')} className={`${styles.rankColumn} ${styles.sortable}`} scope="col">
              {rankLabel} {getSortIndicator('rank')}
            </th>}
            {!onRemove && <th onClick={() => handleSort('rankChange')} className={styles.sortable}>
              Rank Change {getSortIndicator('rankChange')}
            </th>}
            <th onClick={() => handleSort('ticker')} className={styles.sortable}>
              Ticker {getSortIndicator('ticker')}
            </th>
            <th onClick={() => handleSort('exchange')} className={styles.sortable}>
              Exchange {getSortIndicator('exchange')}
            </th>
            {!hideSector && <th onClick={() => handleSort('sector')} className={styles.sortable}>
              Sector {getSortIndicator('sector')}
            </th>}
            <th onClick={() => handleSort('currentPrice')} className={styles.sortable}>
              Current Price {getSortIndicator('currentPrice')}
            </th>
            <th onClick={() => handleSort('ytdReturn')} className={styles.sortable}>
              YTD Return {getSortIndicator('ytdReturn')}
            </th>
            <th onClick={() => handleSort('stopPrice')} className={styles.sortable}>
              PNTHR Stop {getSortIndicator('stopPrice')}
            </th>
            <th onClick={() => handleSort('riskDollar')} className={styles.sortable}>
              Risk per Share {getSortIndicator('riskDollar')}
            </th>
            <th onClick={() => handleSort('riskPct')} className={styles.sortable}>
              Risk % {getSortIndicator('riskPct')}
            </th>
            <th onClick={() => handleSort('signal')} className={`${styles.signalColumn} ${styles.sortable}`}>
              PNTHR Signal {getSortIndicator('signal')}
            </th>
            <th onClick={() => handleSort('weeksAgo')} className={`${styles.signalColumn} ${styles.sortable}`}>
              Wks Since {getSortIndicator('weeksAgo')}
            </th>
            {!hideEarnings && <th onClick={() => handleSort('earningsDate')} className={styles.sortable}>
              Next Earnings {getSortIndicator('earningsDate')}
            </th>}
            {onRemove && <th className={styles.removeColumn}></th>}
          </tr>
        </thead>
        <tbody>
          {(() => {
            let lastSector = null;
            let lastCategory = null;
            return displayStocks.map((stock, sortedIdx) => {
              const rows = [];

              if (groupBySector && stock.sector !== lastSector) {
                lastSector = stock.sector;
                const groupCount = displayStocks.filter(s => s.sector === stock.sector).length;
                const sectorLabel = stock.sector || 'Other';
                rows.push(
                  <tr key={`grp-${stock.sector}`} className={styles.sectorGroupRow}>
                    <td colSpan={colCount} style={{background:'#1e2c4b',color:'#ffffff',fontWeight:700,fontSize:'13px',padding:'10px 16px',letterSpacing:'0.1em',textTransform:'uppercase'}}>{sectorLabel} <span style={{fontSize:'11px',fontWeight:500,opacity:0.6,marginLeft:'6px'}}>({groupCount})</span></td>
                  </tr>
                );
              }

              if (groupByCategory && stock.category !== lastCategory) {
                lastCategory = stock.category;
                const cat = stock.category || 'Other';
                const groupCount = displayStocks.filter(s => (s.category || 'Other') === cat).length;
                rows.push(
                  <tr key={`cat-${cat}`} className={styles.categoryGroupRow}>
                    <td colSpan={colCount}>{cat} <span style={{fontSize:'11px',fontWeight:500,opacity:0.6,marginLeft:'6px'}}>({groupCount})</span></td>
                  </tr>
                );
              }

            const signalData = signals[stock.ticker];
            const { icon, alt } = getSignalDisplay(signalData);
            const stopPrice = signalData?.stopPrice ?? null;
            const riskDollar = stopPrice != null ? Math.abs(stock.currentPrice - stopPrice) : null;
            const riskPct = riskDollar != null ? (riskDollar / stock.currentPrice) * 100 : null;
            const rankDisplay = getRankChangeDisplay(stock);

            const earningsInfo = getEarningsInfo(earnings[stock.ticker]);

            rows.push(
              <tr
                id={`strow-${stock.ticker}`}
                key={stock.ticker}
                className={`${styles.clickableRow}${selectedTicker === stock.ticker ? ` ${styles.selectedRow}` : ''}${(earningsInfo.highlight || highlightAllEarnings) ? ` ${styles.earningsHighlight}` : ''}`}
                onClick={() => setSelectedTicker(stock.ticker)}
                title={stock.companyName || ''}
              >
                {!onRemove && <td className={styles.rankColumn}>
                  {hasScannerRanks ? (() => {
                    const info = scannerRanks[stock.ticker?.toUpperCase()];
                    if (!info) return <span className={styles.badgeJungle}>JUNGLE</span>;
                    return <span>{info.rank} <span className={info.list === 'LONG' ? styles.scannerBadgeLong : styles.scannerBadgeShort}>{info.list === 'LONG' ? 'L' : 'S'}</span></span>;
                  })() : (stock.rank ?? '—')}
                </td>}
                {!onRemove && (() => {
                  if (hasScannerRanks) {
                    const info = scannerRanks[stock.ticker?.toUpperCase()];
                    if (!info) return <td className={styles.rankNew}>—</td>;
                    const rc = info.rankChange;
                    if (rc == null) return <td className={styles.rankNew}>— —</td>;
                    if (rc > 0) return <td className={`${styles.table && ''} ${styles.rankUp}`}>▲ +{rc}</td>;
                    if (rc < 0) return <td className={styles.rankDown}>▼ {rc}</td>;
                    return <td className={styles.rankNew}>— —</td>;
                  }
                  return <td className={rankDisplay.className} title={stock.previousRank ? `Previous rank: #${stock.previousRank}` : 'New entry'}>{rankDisplay.text}</td>;
                })()}
                <td
                  className={`${styles.ticker} ${styles.tickerClickable}`}
                  onClick={e => { e.stopPropagation(); onTickerClick?.(stock, sortedIdx, displayStocks); }}
                  title="Click to view chart"
                >
                  <div className={styles.tickerRow}>
                    {(() => {
                      // L/S badge: prefer scannerRanks prop, fall back to stock.rankList
                      let list = null;
                      if (hasScannerRanks) {
                        list = scannerRanks[stock.ticker?.toUpperCase()]?.list ?? null;
                      } else if (stock.rankList) {
                        list = stock.rankList;
                      }
                      if (!list) return null;
                      return <span className={list === 'LONG' ? styles.scannerBadgeLong : styles.scannerBadgeShort} style={{ marginLeft: 0, marginRight: 4 }}>{list === 'LONG' ? 'L' : 'S'}</span>;
                    })()}
                    <span>{stock.ticker}</span>
                    {(() => {
                      const tags = [];
                      if (stock.isSp500) tags.push('500');
                      if (stock.isDow30) tags.push('30');
                      if (stock.universe === 'sp400Long' || stock.universe === 'sp400Short') tags.push('400');
                      if (stock.isNasdaq100) tags.push('100');
                      return tags.length > 0
                        ? <span className={styles.membershipTag}>({tags.join(', ')})</span>
                        : null;
                    })()}
                  </div>
                  {stock.companyName && <div className={styles.companyName}>{stock.companyName}</div>}
                </td>
                <td>{stock.exchange}</td>
                {!hideSector && <td>{stock.sector}</td>}
                <td className={styles.price}>${stock.currentPrice.toLocaleString()}</td>
                <td className={stock.ytdReturn != null ? (stock.ytdReturn >= 0 ? styles.positive : styles.negative) : ''}>
                  {stock.ytdReturn != null ? `${stock.ytdReturn >= 0 ? '+' : ''}${stock.ytdReturn.toFixed(2)}%` : '—'}
                </td>
                {signalsLoading ? (
                  <>
                    <td className={styles.stopPriceCell}><span className={styles.loadingDots}>···</span></td>
                    <td className={styles.riskCell}><span className={styles.loadingDots}>···</span></td>
                    <td className={styles.riskCell}><span className={styles.loadingDots}>···</span></td>
                  </>
                ) : (signalData?.signal === 'BE' || signalData?.signal === 'SE') ? (
                  <td colSpan={3} className={styles.pauseCell}>
                    <span className={styles.pauseBadge}>⏸ PAUSE</span>
                  </td>
                ) : (
                  <>
                    <td className={styles.stopPriceCell}>
                      {stopPrice != null ? `$${stopPrice.toLocaleString()}` : '—'}
                    </td>
                    <td className={styles.riskCell}>
                      {riskDollar != null ? `$${riskDollar.toFixed(2)}` : '—'}
                    </td>
                    <td className={styles.riskCell}>
                      {riskPct != null ? `${riskPct.toFixed(2)}%` : '—'}
                    </td>
                  </>
                )}
                <td className={styles.signalColumn}>
                  {signalsLoading
                    ? <span className={styles.loadingDots}>···</span>
                    : signalData?.signal === 'BL'
                      ? <span className={`${styles.pnthrBadge} ${styles.pnthrBadgeBL}`}>BL</span>
                      : signalData?.signal === 'SS'
                        ? <span className={`${styles.pnthrBadge} ${styles.pnthrBadgeSS}`}>SS</span>
                        : signalData?.signal === 'BE'
                          ? <span className={`${styles.pnthrBadge} ${styles.pnthrBadgeBE}`}>BE</span>
                          : signalData?.signal === 'SE'
                            ? <span className={`${styles.pnthrBadge} ${styles.pnthrBadgeSE}`}>SE</span>
                            : <span className={styles.signalNone}>—</span>}
                </td>
                <td className={styles.signalColumn}>
                  {signalsLoading
                    ? <span className={styles.loadingDots}>···</span>
                    : (() => {
                        const sig = signalData?.signal;
                        const wks = computeWeeksAgo(signalData?.signalDate);
                        if (!sig || wks == null) return <span className={styles.signalNone}>—</span>;
                        const cls = sig === 'BL' ? styles.pnthrBadgeBL
                                  : sig === 'SS' ? styles.pnthrBadgeSS
                                  : styles.pnthrBadgeBE; // BE and SE both orange
                        const isNew = signalData?.isNewSignal;
                        return <span className={`${styles.pnthrBadge} ${cls}`}>{isNew ? '★ ' : ''}{sig}+{wks}</span>;
                      })()}
                </td>
                {!hideEarnings && <td>
                  {earningsInfo.display}
                  {earningsInfo.highlight && (
                    <span className={styles.earningsSoonBadge}>
                      {earningsInfo.daysAway === 0 ? 'Today' : `${earningsInfo.daysAway}d`}
                    </span>
                  )}
                </td>}
                {onRemove && (
                  <td className={styles.removeColumn}>
                    <button
                      className={styles.removeBtn}
                      onClick={e => { e.stopPropagation(); onRemove(stock.ticker); }}
                      title={`Remove ${stock.ticker} from watchlist`}
                    >
                      ✕
                    </button>
                  </td>
                )}
              </tr>
            );
            return rows;
          }).flat();
          })()}
        </tbody>
      </table>
    </div>
  );
}
