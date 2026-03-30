import { useState, useRef } from 'react';
import styles from './Sidebar.module.css';
import pnthrLogo from '../assets/panther head.png';
import builtWithLove from '../assets/Built with Love.jpg';

const NAV_GROUPS = [
  {
    groupLabel: 'This Week',
    items: [
      { key: 'assistant', label: 'PNTHR Assistant', iconImg: true },
      { key: 'pulse',    label: 'PNTHR Pulse',  iconImg: true },
      { key: 'perch',    label: 'PNTHR Perch',    iconImg: true },
      { key: 'earnings', label: 'Earnings Week',  icon: '📅' },
    ],
  },
  {
    groupLabel: 'The Hunt',
    items: [
      { key: 'search',   label: 'PNTHR Search',   iconImg: true },
      { key: 'prey',     label: 'PNTHR Prey',     iconImg: true },
      { key: 'apex',     label: 'PNTHR Kill',     iconImg: true },
    ],
  },
  {
    groupLabel: 'Jungle',
    items: [
      { key: 'jungle',  label: 'PNTHR 679 Jungle', iconImg: true },
      { key: 'long',    label: 'PNTHR 100 Longs',  icon: '📈' },
      { key: 'short',   label: 'PNTHR 100 Shorts', icon: '📉' },
      { key: 'etf',     label: "PNTHR ETF's",      iconImg: true },
      { key: 'sectors', label: 'PNTHR Sectors',    iconImg: true },
    ],
  },
];

function getFirstName(user) {
  if (!user) return null;
  if (user.name)      return user.name.split(' ')[0];
  if (user.firstName) return user.firstName;
  // Derive from email: "scott.tiger@..." → "Scott"
  const local = (user.email || '').split('@')[0];
  const part  = local.split(/[._-]/)[0] || local;
  return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
}

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

export default function Sidebar({ activePage, onNavigate, currentUser, isAdmin, onLogout, longStats, shortStats }) {
  const [tooltipKey, setTooltipKey] = useState(null);
  const [tooltipTop, setTooltipTop] = useState(0);
  const btnRefs = useRef({});

  const firstName = getFirstName(currentUser);

  // Personal group — Command for everyone; History pages admin-only
  const personalItems = [
    { key: 'command',  label: 'PNTHR Command',  iconImg: true },
    { key: 'journal',  label: 'PNTHR Journal',  iconImg: true },
    { key: 'watchlist', label: firstName ? `${firstName}'s Watchlist` : 'Watchlist', icon: '👁' },
  ];
  if (isAdmin) {
    personalItems.push({ key: 'history',        label: 'PNTHR Kill 10',  iconImg: true });
    personalItems.push({ key: 'kill-test',      label: 'PNTHR Kill Test',     iconImg: true });
    personalItems.push({ key: 'signal-history', label: 'PNTHR History',      iconImg: true });
  }

  const personalGroup = firstName
    ? { groupLabel: `For ${firstName}`, items: personalItems }
    : null;

  const allGroups = personalGroup ? [...NAV_GROUPS, personalGroup] : NAV_GROUPS;

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
      {/* Logo + PNTHR's Den */}
      <div className={styles.logoArea}>
        <img src={pnthrLogo} alt="PNTHR" className={styles.logo} />
        <div className={styles.appName}>
          <span className={styles.appNameYellow}>PNTHR's</span>{' '}
          <span className={styles.appNameWhite}>Den</span>
        </div>
      </div>

      {/* Navigation groups */}
      <nav className={styles.nav}>
        {allGroups.map((group) => (
          <div key={group.groupLabel} className={styles.navGroup}>
            <span className={styles.navGroupLabel}>{group.groupLabel}</span>
            <div className={styles.navGroupBox}>
              {group.items.map((item) => (
                <button
                  key={item.key}
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
              ))}
            </div>
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
