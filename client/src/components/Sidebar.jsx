import { useState, useRef } from 'react';
import styles from './Sidebar.module.css';
import pnthrLogo from '../assets/panther head.png';
import builtWithLove from '../assets/Built with Love.jpg';
import { useDemo } from '../contexts/DemoContext';

const APP_VERSION = '4.4.0';

const NAV_GROUPS = [
  {
    groupLabel: 'This Week',
    items: [
      { key: 'perch',    label: 'PNTHR Perch',     iconImg: true },
      { key: 'earnings', label: 'PNTHR Calendar',   icon: '📅' },
    ],
  },
  {
    groupLabel: 'PNTHR Live',
    items: [
      { key: 'pulse',     label: 'PNTHR Pulse',     iconImg: true },
      { key: 'assistant', label: 'PNTHR Assistant',  iconImg: true },
      { key: 'orders',    label: 'PNTHR Orders',    iconImg: true },
      { key: 'command',   label: 'PNTHR Command',   iconImg: true },
    ],
  },
  {
    groupLabel: 'PNTHR Hunt',
    items: [
      { key: 'search', label: 'PNTHR Search', iconImg: true },
      { key: 'prey',   label: 'PNTHR Prey',   iconImg: true },
      { key: 'apex',   label: 'PNTHR Kill',   iconImg: true },
    ],
  },
  {
    groupLabel: 'PNTHR Jungle',
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
  const { isDemo, toggleDemo } = useDemo();
  const [tooltipKey, setTooltipKey] = useState(null);
  const [tooltipTop, setTooltipTop] = useState(0);
  const btnRefs = useRef({});

  const firstName = getFirstName(currentUser);

  // PNTHR Data group — Journal + Watchlist for everyone; Kill 10, Kill Test, History admin-only
  const dataItems = [
    { key: 'journal',  label: 'PNTHR Journal',  iconImg: true },
  ];
  if (isAdmin) {
    dataItems.push({ key: 'history',        label: 'PNTHR Kill 10',   iconImg: true });
    dataItems.push({ key: 'kill-test',      label: 'PNTHR Kill Test', iconImg: true });
    dataItems.push({ key: 'signal-history', label: 'PNTHR History',   iconImg: true });
  }
  dataItems.push({ key: 'watchlist', label: firstName ? `${firstName}'s Watchlist` : 'Watchlist', icon: '👁' });

  const dataGroup = { groupLabel: 'PNTHR Data', items: dataItems };

  const allGroups = [...NAV_GROUPS, dataGroup];

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
    <aside className={styles.sidebar} style={isDemo ? { borderTop: '2px solid #fcf000' } : undefined}>
      {/* Logo + PNTHR's Den */}
      <div className={styles.logoArea}>
        <img src={pnthrLogo} alt="PNTHR" className={styles.logo} />
        <div className={styles.appName}>
          <span className={styles.appNameYellow}>PNTHR's</span>{' '}
          <span className={styles.appNameWhite}>Den</span>
        </div>
        <div style={{ fontSize: 8, color: '#444', letterSpacing: '0.08em', textAlign: 'center', marginTop: 2, fontFamily: 'monospace' }}>
          {isDemo ? `Dv${APP_VERSION}` : `v${APP_VERSION}`}
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

      {/* System Architecture + Data Room buttons */}
      <div style={{ padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button
          className={styles.archBtn}
          onClick={() => window.open('/PNTHR_Fund_Intelligence_Report_v20.pdf', '_blank')}
          title="View PNTHR Fund Intelligence Report"
        >
          <span style={{ fontSize: 14 }}>📄</span>
          <span>Fund Intelligence Report</span>
        </button>
        <button
          className={styles.dataRoomBtn}
          onClick={() => onNavigate('data-room')}
          title="PNTHR Data Room — Fund Documents"
        >
          <span style={{ fontSize: 14 }}>🗄️</span>
          <span>PNTHR Data Room</span>
        </button>
        {isAdmin && (
          <button
            className={styles.dataRoomBtn}
            onClick={() => onNavigate('compliance')}
            title="PNTHR Compliance — Documents, Calendar & Tasks"
          >
            <span style={{ fontSize: 14 }}>🛡️</span>
            <span>Compliance</span>
          </button>
        )}
      </div>

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
        {isAdmin && (
          <div
            onClick={toggleDemo}
            title={isDemo ? 'Demo mode active' : ''}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: 4, cursor: 'pointer', padding: '3px 0', marginBottom: 4,
              opacity: 0.25,
              transition: 'opacity 0.3s',
            }}
          >
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: '#555',
              boxShadow: 'none',
              transition: 'all 0.3s',
            }} />
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
