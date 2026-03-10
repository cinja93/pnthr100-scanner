import { useState } from 'react';
import styles from './Sidebar.module.css';
import pnthrLogo from '../assets/PNTHR FUNDS Logo black background 2 lines.png';
import builtWithLove from '../assets/Built with Love.jpg';

const NAV_ITEMS = [
  { key: 'long',      label: 'PNTHR Long',     icon: '📈', section: 'SCANNER' },
  { key: 'short',     label: 'PNTHR Short',    icon: '📉' },
  { key: 'ema',       label: 'PNTHR Hunt',     icon: '〰️' },
  { key: 'etf',       label: 'ETF Scan',       icon: '🗂️' },
  { key: 'sectors',   label: 'Sectors',        icon: '📊', dividerBefore: true },
  { key: 'watchlist', label: 'Watchlist',  icon: '👁' },
  { key: 'portfolio', label: 'Portfolio',  icon: '📁' },
];

export default function Sidebar({ activePage, onNavigate, currentUser, onLogout, longStats }) {
  const [showLongTooltip, setShowLongTooltip] = useState(false);

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
              className={`${styles.navItem} ${activePage === item.key ? styles.navItemActive : ''} ${item.soon ? styles.navItemDisabled : ''}`}
              onClick={() => !item.soon && onNavigate(item.key)}
              disabled={item.soon}
              title={item.soon ? 'Coming soon' : item.label}
              onMouseEnter={() => item.key === 'long' && longStats && setShowLongTooltip(true)}
              onMouseLeave={() => setShowLongTooltip(false)}
            >
              <span className={styles.navIcon}>{item.icon}</span>
              <span className={styles.navLabel}>{item.label}</span>
              {item.soon && <span className={styles.soonBadge}>Soon</span>}
            </button>
            {item.key === 'long' && showLongTooltip && longStats && (
              <div className={styles.statsTooltip}>
                <div className={styles.statsTooltipTitle}>Closed Trades This Batch</div>
                <div className={styles.statsRow}>
                  <span className={styles.statsLabel}>Total closed</span>
                  <span className={styles.statsValue}>{longStats.total}</span>
                </div>
                <div className={styles.statsRow}>
                  <span className={styles.statsLabel}>Winners</span>
                  <span className={styles.statsValue}>{longStats.wins} ({longStats.winRate.toFixed(0)}%)</span>
                </div>
                <div className={styles.statsRow}>
                  <span className={styles.statsLabel}>Avg profit</span>
                  <span className={`${styles.statsValue} ${longStats.avgDollar >= 0 ? styles.statsPos : styles.statsNeg}`}>
                    {longStats.avgDollar >= 0 ? '+' : ''}{longStats.avgDollar.toFixed(2)}
                  </span>
                </div>
                <div className={styles.statsRow}>
                  <span className={styles.statsLabel}>Avg %</span>
                  <span className={`${styles.statsValue} ${longStats.avgPct >= 0 ? styles.statsPos : styles.statsNeg}`}>
                    {longStats.avgPct >= 0 ? '+' : ''}{longStats.avgPct.toFixed(2)}%
                  </span>
                </div>
              </div>
            )}
          </div>
        ))}
      </nav>

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
