import { useState, useMemo } from 'react';
import styles from './FilterBar.module.css';

import confirmedBuyIcon     from './Confirmed Buy Signal.png';
import confirmedSellIcon    from './Confirmed Sell Signal.png';
import cautionBuyIcon       from './Caution Buy Signal.png';
import cautionSellIcon      from './Caution Sell Signal.png';
import newConfirmedBuyIcon  from './New Confirmed Buy Signal.png';
import newConfirmedSellIcon from './New Confirmed Sell Signal.png';
import newCautionBuyIcon    from './New Caution Buy Signal.png';
import newCautionSellIcon   from './New Caution Sell Signal.png';

const BUY_SIGNALS  = ['NEW_BUY', 'BUY', 'NEW_YELLOW_BUY', 'YELLOW_BUY'];
const SELL_SIGNALS = ['NEW_SELL', 'SELL', 'NEW_YELLOW_SELL', 'YELLOW_SELL', 'NONE'];

const SIGNAL_LABELS = {
  BUY: 'Confirmed Buy',
  NEW_BUY: 'New Confirmed Buy',
  YELLOW_BUY: 'Caution Buy',
  NEW_YELLOW_BUY: 'New Caution Buy',
  SELL: 'Confirmed Sell',
  NEW_SELL: 'New Confirmed Sell',
  YELLOW_SELL: 'Caution Sell',
  NEW_YELLOW_SELL: 'New Caution Sell',
  NONE: 'No Signal',
};

const SIGNAL_ICONS = {
  BUY: confirmedBuyIcon,
  NEW_BUY: newConfirmedBuyIcon,
  YELLOW_BUY: cautionBuyIcon,
  NEW_YELLOW_BUY: newCautionBuyIcon,
  SELL: confirmedSellIcon,
  NEW_SELL: newConfirmedSellIcon,
  YELLOW_SELL: cautionSellIcon,
  NEW_YELLOW_SELL: newCautionSellIcon,
};

function countActiveFilters(filters) {
  let count = 0;
  if (filters.signals.length > 0) count++;
  if (filters.sectors.length > 0) count++;
  if (filters.exchanges.length > 0) count++;
  if (filters.minPrice !== '' || filters.maxPrice !== '') count++;
  if (filters.minRiskDollar !== '' || filters.maxRiskDollar !== '') count++;
  if (filters.minRiskPct !== '' || filters.maxRiskPct !== '') count++;
  return count;
}

export default function FilterBar({ stocks, filters, onChange, scanType }) {
  const [expanded, setExpanded] = useState(true);

  // Derive unique sorted sectors and exchanges from current stock list
  const sectors = useMemo(() => {
    const set = new Set(stocks.map(s => s.sector).filter(Boolean));
    return [...set].sort();
  }, [stocks]);

  const exchanges = useMemo(() => {
    const EXCHANGE_ORDER = ['NASDAQ', 'NYSE', 'AMEX'];
    const set = new Set(stocks.map(s => s.exchange).filter(Boolean));
    return [...set].sort((a, b) => {
      const ai = EXCHANGE_ORDER.indexOf(a);
      const bi = EXCHANGE_ORDER.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }, [stocks]);

  const activeCount = countActiveFilters(filters);

  function togglePill(field, value) {
    const current = filters[field];
    const next = current.includes(value)
      ? current.filter(v => v !== value)
      : [...current, value];
    onChange({ ...filters, [field]: next });
  }

  function toggleSector(sector) {
    const current = filters.sectors;
    const next = current.includes(sector)
      ? current.filter(s => s !== sector)
      : [...current, sector];
    onChange({ ...filters, sectors: next });
  }

  function setRange(field, value) {
    onChange({ ...filters, [field]: value });
  }

  function clearAll() {
    onChange({
      signals: [],
      sectors: [],
      exchanges: [],
      minPrice: '',
      maxPrice: '',
      minRiskDollar: '',
      maxRiskDollar: '',
      minRiskPct: '',
      maxRiskPct: '',
    });
  }

  return (
    <div className={styles.filterBar}>
      {/* Header row */}
      <div className={styles.header} onClick={() => setExpanded(e => !e)}>
        <span className={styles.title}>
          Filters
          {activeCount > 0 && (
            <span className={styles.badge}>{activeCount} active</span>
          )}
        </span>
        <div className={styles.headerRight}>
          {activeCount > 0 && (
            <button
              className={styles.clearBtn}
              onClick={(e) => { e.stopPropagation(); clearAll(); }}
            >
              Clear All
            </button>
          )}
          <span className={styles.chevron}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* Filter panels */}
      {expanded && (
        <div className={styles.panels}>

          {/* Signal */}
          <div className={styles.group}>
            <label className={styles.groupLabel}>Signal</label>
            <div className={styles.signalRows}>
              <div className={styles.pills}>
                {BUY_SIGNALS.map(value => (
                  <button
                    key={value}
                    className={`${styles.pill} ${filters.signals.includes(value) ? styles.pillActive : ''} ${styles[`pill_${value}`] || ''}`}
                    onClick={() => togglePill('signals', value)}
                  >
                    {SIGNAL_ICONS[value] && <img src={SIGNAL_ICONS[value]} alt="" className={styles.pillIcon} />}
                    {SIGNAL_LABELS[value]}
                  </button>
                ))}
              </div>
              <div className={styles.pills}>
                {SELL_SIGNALS.map(value => (
                  <button
                    key={value}
                    className={`${styles.pill} ${filters.signals.includes(value) ? styles.pillActive : ''} ${styles[`pill_${value}`] || ''}`}
                    onClick={() => togglePill('signals', value)}
                  >
                    {SIGNAL_ICONS[value] && <img src={SIGNAL_ICONS[value]} alt="" className={styles.pillIcon} />}
                    {SIGNAL_LABELS[value]}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Sector */}
          <div className={styles.group}>
            <label className={styles.groupLabel}>
              Sector
              {filters.sectors.length > 0 && (
                <span className={styles.groupCount}>{filters.sectors.length} selected</span>
              )}
            </label>
            <div className={styles.sectorGrid}>
              {sectors.map(sector => (
                <button
                  key={sector}
                  className={`${styles.sectorPill} ${filters.sectors.includes(sector) ? styles.pillActive : ''}`}
                  onClick={() => toggleSector(sector)}
                >
                  {sector}
                </button>
              ))}
            </div>
          </div>

          {/* Exchange */}
          <div className={styles.group}>
            <label className={styles.groupLabel}>Exchange</label>
            <div className={styles.pills}>
              {exchanges.map(exchange => (
                <button
                  key={exchange}
                  className={`${styles.pill} ${filters.exchanges.includes(exchange) ? styles.pillActive : ''}`}
                  onClick={() => togglePill('exchanges', exchange)}
                >
                  {exchange}
                </button>
              ))}
            </div>
          </div>

          {/* Numeric range filters */}
          <div className={styles.rangeRow}>
            <div className={styles.rangeGroup}>
              <label className={styles.groupLabel}>Price ($)</label>
              <div className={styles.rangeInputs}>
                <input
                  type="number"
                  className={styles.rangeInput}
                  placeholder="Min"
                  value={filters.minPrice}
                  min="0"
                  onChange={e => setRange('minPrice', e.target.value)}
                />
                <span className={styles.rangeSep}>–</span>
                <input
                  type="number"
                  className={styles.rangeInput}
                  placeholder="Max"
                  value={filters.maxPrice}
                  min="0"
                  onChange={e => setRange('maxPrice', e.target.value)}
                />
              </div>
            </div>

            <div className={styles.rangeGroup}>
              <label className={styles.groupLabel}>Risk $ (per share)</label>
              <div className={styles.rangeInputs}>
                <input
                  type="number"
                  className={styles.rangeInput}
                  placeholder="Min"
                  value={filters.minRiskDollar}
                  min="0"
                  step="0.01"
                  onChange={e => setRange('minRiskDollar', e.target.value)}
                />
                <span className={styles.rangeSep}>–</span>
                <input
                  type="number"
                  className={styles.rangeInput}
                  placeholder="Max"
                  value={filters.maxRiskDollar}
                  min="0"
                  step="0.01"
                  onChange={e => setRange('maxRiskDollar', e.target.value)}
                />
              </div>
            </div>

            <div className={styles.rangeGroup}>
              <label className={styles.groupLabel}>Risk % (of price)</label>
              <div className={styles.rangeInputs}>
                <input
                  type="number"
                  className={styles.rangeInput}
                  placeholder="Min"
                  value={filters.minRiskPct}
                  min="0"
                  step="0.1"
                  onChange={e => setRange('minRiskPct', e.target.value)}
                />
                <span className={styles.rangeSep}>–</span>
                <input
                  type="number"
                  className={styles.rangeInput}
                  placeholder="Max"
                  value={filters.maxRiskPct}
                  min="0"
                  step="0.1"
                  onChange={e => setRange('maxRiskPct', e.target.value)}
                />
              </div>
            </div>
          </div>

        </div>
      )}
    </div>
  );
}
