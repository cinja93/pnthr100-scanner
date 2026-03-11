import { useState, useRef } from 'react';
import styles from './Sidebar.module.css';
import pnthrLogo from '../assets/panther head.png';
import builtWithLove from '../assets/Built with Love.jpg';

const NAV_ITEMS = [
  { key: 'long',      label: 'PNTHR 100 Longs',   icon: '📈', section: 'SCANNER' },
  { key: 'short',     label: 'PNTHR 100 Shorts',  icon: '📉' },
  { key: 'jungle',    label: 'PNTHR 679 Jungle',  iconImg: true },
  { key: 'ema',       label: 'PNTHR Hunt',        icon: '〰️' },
  { key: 'etf',       label: 'ETF Scan',          icon: '🗂️' },
  { key: 'sectors',   label: 'Sectors',           icon: '📊', dividerBefore: true },
  { key: 'watchlist', label: 'Watchlist',         icon: '👁' },
  { key: 'portfolio', label: 'Portfolio',         icon: '📁' },
];

function BatchStatsTooltip({ stats, top }) {
  return (
    <div className={styles.statsTooltip} style={{ top }}>
      <div className={styles.statsTooltipTitle}>Closed Trades This Batch</div>
      <div className={styles.statsRow}>
        <span className={styles.statsLabel}>Total closed</span>
        <span className={styles.statsValue}>{stats.total}</span>
      </div>
      <div className={styles.statsRow}>
        <span className={styles.statsLabel}>Winners</span>
        <span className={styles.statsValue}>{stats.wins} ({stats.winRate.toFixed(0)}%)</span>
      </div>
      <div className={styles.statsRow}>
        <span className={styles.statsLabel}>Avg profit</span>
        <span className={`${styles.statsValue} ${stats.avgDollar >= 0 ? styles.statsPos : styles.statsNeg}`}>
          {stats.avgDollar >= 0 ? '+' : '-'}${Math.abs(stats.avgDollar).toFixed(2)} / share
        </span>
      </div>
      <div className={styles.statsRow}>
        <span className={styles.statsLabel}>Avg %</span>
        <span className={`${styles.statsValue} ${stats.avgPct >= 0 ? styles.statsPos : styles.statsNeg}`}>
          {stats.avgPct >= 0 ? '+' : ''}{stats.avgPct.toFixed(2)}%
        </span>
      </div>
    </div>
  );
}

export default function Sidebar({ activePage, onNavigate, currentUser, onLogout, longStats, shortStats }) {
  const [tooltipKey, setTooltipKey] = useState(null); // 'long' | 'short' | null
  const [tooltipTop, setTooltipTop] = useState(0);
  const btnRefs = useRef({});

  function handleMouseEnter(key) {
    if (key !== 'long' && key !== 'short') return;
    const btn = btnRefs.current[key];
    if (btn) {
      const rect = btn.getBoundingClientRect();
      setTooltipTop(rect.top);
    }
    setTooltipKey(key);
  }

  const activeTooltipStats = tooltipKey === 'long' ? longStats : tooltipKey === 'short' ? shortStats : null;

  return (
    <aside className={styles.sidebar}>
      {/* Logo */}
      <div className={styles.logoArea}>
        <img src={pnthrLogo} alt="PNTHR Funds" className={styles.logo} />
      </div>

      {/* Navigation */}
      <nav className={styles.nav}>
        {NAV_ITEMS.map((item) => (
          <div key={item.key} className={styles.navItemWrapper}>
            {item.section && (
              <div className={styles.sectionLabel}>{item.section}</div>
            )}
            {item.dividerBefore && <div className={styles.divider} />}
            <button
              ref={el => { if (el) btnRefs.current[item.key] = el; }}
              className={`${styles.navItem} ${activePage === item.key ? styles.navItemActive : ''} ${item.soon ? styles.navItemDisabled : ''}`}
              onClick={() => !item.soon && onNavigate(item.key)}
              disabled={item.soon}
              title={item.soon ? 'Coming soon' : item.label}
              onMouseEnter={() => handleMouseEnter(item.key)}
              onMouseLeave={() => setTooltipKey(null)}
            >
              <span className={styles.navIcon}>
                {item.iconImg
                  ? <img src={pnthrLogo} alt="PNTHR" className={styles.navIconImg} />
                  : item.icon}
              </span>
              <span className={styles.navLabel}>{item.label}</span>
              {item.soon && <span className={styles.soonBadge}>Soon</span>}
            </button>
          </div>
        ))}
      </nav>

      {/* Fixed tooltip rendered outside sidebar overflow */}
      {tooltipKey && (
        activeTooltipStats
          ? <BatchStatsTooltip stats={activeTooltipStats} top={tooltipTop} />
          : <div className={styles.statsTooltip} style={{ top: tooltipTop }}><div className={styles.statsTooltipTitle}>No closed trades yet</div></div>
      )}

      {/* Footer */}
      <div className={styles.sidebarFooter}>
        {currentUser && (
          <div className={styles.userArea}>
            <span className={styles.userEmail} title={currentUser.email}>{currentUser.email}</span>
            <button className={styles.logoutBtn} onClick={onLogout} title="Sign out">Sign out</button>
          </div>
        )}
        <div className={styles.loveFrame}>
          <img src={builtWithLove} alt="Built with Love" className={styles.loveImg} />
        </div>
        <p className={styles.loveText}>Built with love by Cindy and Blazer</p>
      </div>
    </aside>
  );
}
