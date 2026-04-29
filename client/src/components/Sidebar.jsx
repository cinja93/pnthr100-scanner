import { useState, useRef, useEffect } from 'react';
import styles from './Sidebar.module.css';
import pnthrLogo from '../assets/panther head.png';
import builtWithLove from '../assets/Built with Love.jpg';
import { useDemo } from '../contexts/DemoContext';
import { usePortal } from '../contexts/PortalContext';
import { fetchImpersonationTargets, startImpersonation } from '../services/api';

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
      // PNTHR Command intentionally hidden 2026-04-29 (Day 1 UI consolidation).
      // Page is still mounted at /?page=command for fallback editing — used by
      // the AssistantRowExpand "OPEN IN COMMAND CENTER" deep link for full lot
      // / ratchet controls until Day 2 expand-panel polish ships.
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

// ── VIP impersonation dropdown ──────────────────────────────────────────────
// Admin-only button: "View as VIP" expands to a list of users the admin can
// preview as (Vanilla + real VIPs from the DB). Clicking a target calls the
// impersonation endpoint, stores the 30-minute read-only token in the new
// tab's sessionStorage (via the URL hand-off), and opens that tab.
function VipImpersonateMenu() {
  const [open, setOpen]         = useState(false);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [targets, setTargets]   = useState(null); // { vanilla, targets: [...] }
  const [launching, setLaunching] = useState(null); // target id while awaiting impersonate call

  // Load the target list the first time the menu opens so the dropdown
  // reflects the current VIP roster without an up-front fetch.
  useEffect(() => {
    if (!open || targets || loading) return;
    setLoading(true);
    setError(null);
    fetchImpersonationTargets()
      .then(setTargets)
      .catch(e => setError(e.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [open, targets, loading]);

  const handleLaunch = async (target) => {
    setLaunching(target.id);
    try {
      const { token } = await startImpersonation(target.id);
      // Hand off the token via URL so the new tab's sessionStorage (per-tab
      // isolated) picks it up — the admin's OWN tab keeps its localStorage
      // admin token completely untouched. consumeImpersonationFromUrl strips
      // the param from the URL bar once captured.
      const url = `${window.location.origin}/?impersonate=${encodeURIComponent(token)}`;
      window.open(url, '_blank', 'noopener,noreferrer');
      setOpen(false);
    } catch (e) {
      setError(e.message || 'Failed to start impersonation');
    } finally {
      setLaunching(null);
    }
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        className={styles.dataRoomBtn}
        onClick={() => setOpen(o => !o)}
        title="Preview as a specific VIP member (read-only, 30-min session)"
      >
        <span style={{ fontSize: 14 }}>👀</span>
        <span style={{ flex: 1, textAlign: 'left' }}>View as VIP</span>
        <span style={{ fontSize: 10, opacity: 0.6 }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div style={{
          marginTop:    4,
          padding:      6,
          background:   '#0c0c0c',
          border:       '1px solid rgba(252,240,0,0.25)',
          borderRadius: 6,
          display:      'flex',
          flexDirection: 'column',
          gap:          3,
        }}>
          {loading && (
            <div style={{ padding: '6px 10px', fontSize: 11, color: '#888' }}>Loading…</div>
          )}
          {error && (
            <div style={{ padding: '6px 10px', fontSize: 11, color: '#ef5350' }}>{error}</div>
          )}
          {targets && (
            <>
              {/* Vanilla first — a synthetic empty user for fresh-login UX
                  testing. No data, no stocks, no personalization. */}
              <VipImpersonateOption
                target={targets.vanilla}
                subtitle="Fresh user — no data"
                onLaunch={handleLaunch}
                launching={launching === targets.vanilla.id}
              />
              {targets.targets.length === 0 && (
                <div style={{ padding: '6px 10px', fontSize: 11, color: '#555' }}>No VIPs found</div>
              )}
              {targets.targets.map(t => (
                <VipImpersonateOption
                  key={t.id}
                  target={t}
                  subtitle={t.email}
                  onLaunch={handleLaunch}
                  launching={launching === t.id}
                />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function VipImpersonateOption({ target, subtitle, onLaunch, launching }) {
  return (
    <button
      onClick={() => !launching && onLaunch(target)}
      disabled={!!launching}
      style={{
        padding:      '6px 10px',
        background:   'transparent',
        border:       '1px solid transparent',
        borderRadius: 4,
        color:        '#e0e0e0',
        textAlign:    'left',
        cursor:       launching ? 'wait' : 'pointer',
        display:      'flex',
        flexDirection: 'column',
        gap:          1,
      }}
      onMouseEnter={e => !launching && (e.currentTarget.style.background = 'rgba(252,240,0,0.08)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      <span style={{ fontSize: 12, fontWeight: 700, color: launching ? '#888' : '#FCF000' }}>
        {launching ? '…launching' : `View as ${target.displayName}`}
      </span>
      <span style={{ fontSize: 9, color: '#666', letterSpacing: '0.02em' }}>{subtitle}</span>
    </button>
  );
}

export default function Sidebar({ activePage, onNavigate, currentUser, isAdmin, onLogout, longStats, shortStats }) {
  const { isDemo, toggleDemo } = useDemo();
  const { allowedPages, isDenPortal, isInvestorPortal, isVipPortal } = usePortal();
  const [tooltipKey, setTooltipKey] = useState(null);
  const [tooltipTop, setTooltipTop] = useState(0);
  const [mobileOpen, setMobileOpen] = useState(false);
  const btnRefs = useRef({});

  const firstName = getFirstName(currentUser);
  const isPortalMode = isDenPortal || isInvestorPortal || isVipPortal;
  // Admin UI suppression — when admin visits vip/investor subdomain, we hide
  // admin-only controls so they see exactly what the family/investor sees.
  const effectiveAdmin = isAdmin && !isVipPortal && !isInvestorPortal;

  // Build nav groups. VIP portal gets an injected "Portfolio" item under
  // PNTHR Live so Brennan + family can see their own portfolio status.
  const liveGroupWithPortfolio = isVipPortal
    ? {
        groupLabel: 'PNTHR Live',
        items: [
          { key: 'pulse',     label: 'PNTHR Pulse',     iconImg: true },
          { key: 'portfolio', label: 'PNTHR Portfolio', iconImg: true },
          { key: 'assistant', label: 'PNTHR Assistant', iconImg: true },
          { key: 'orders',    label: 'PNTHR Orders',    iconImg: true },
          // PNTHR Command hidden 2026-04-29 (Day 1 UI consolidation); see top
          // of file for the ongoing fallback deep-link justification.
        ],
      }
    : null;

  // PNTHR Data group — Journal + Watchlist for everyone; Kill 10, Kill Test, History admin-only
  const dataItems = [
    { key: 'journal',  label: 'PNTHR Journal',  iconImg: true },
  ];
  if (effectiveAdmin) {
    dataItems.push({ key: 'history',        label: 'PNTHR Kill 10',   iconImg: true });
    dataItems.push({ key: 'kill-test',      label: 'PNTHR Kill Test', iconImg: true });
    dataItems.push({ key: 'signal-history', label: 'PNTHR History',   iconImg: true });
  }
  dataItems.push({ key: 'watchlist', label: firstName ? `${firstName}'s Watchlist` : 'Watchlist', icon: '👁' });

  const dataGroup = { groupLabel: 'PNTHR Data', items: dataItems };

  // Swap in the VIP-specific PNTHR Live group when in VIP mode.
  const baseGroups = liveGroupWithPortfolio
    ? NAV_GROUPS.map(g => g.groupLabel === 'PNTHR Live' ? liveGroupWithPortfolio : g)
    : NAV_GROUPS;

  let allGroups = [...baseGroups, dataGroup];

  // Portal mode: filter nav to only allowed pages
  if (allowedPages) {
    allGroups = allGroups
      .map(group => ({
        ...group,
        items: group.items.filter(item => allowedPages.includes(item.key)),
      }))
      .filter(group => group.items.length > 0);
  }

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

  // Close sidebar when navigating on tablet/mobile
  function handleNav(page) {
    setMobileOpen(false);
    onNavigate(page);
  }

  return (
    <>
      {/* Hamburger toggle — only visible on tablet/mobile via CSS */}
      <button
        className={styles.hamburger}
        onClick={() => setMobileOpen(v => !v)}
        aria-label="Toggle menu"
      >
        {mobileOpen ? '✕' : '☰'}
      </button>
      {/* Overlay — click to close on tablet */}
      {mobileOpen && <div className={styles.mobileOverlay} onClick={() => setMobileOpen(false)} />}
    <aside className={`${styles.sidebar} ${mobileOpen ? styles.sidebarOpen : ''}`} style={isDemo ? { borderTop: '2px solid #fcf000' } : undefined}>
      {/* Logo + branding */}
      <div className={styles.logoArea}>
        <img src={pnthrLogo} alt="PNTHR" className={styles.logo} />
        <div className={styles.appName}>
          <span className={styles.appNameYellow}>PNTHR</span>{' '}
          <span className={styles.appNameWhite}>
            {isDenPortal ? 'Den' : isInvestorPortal ? 'Investor' : "s Den"}
          </span>
        </div>
        {!isPortalMode && (
          <div style={{ fontSize: 8, color: '#444', letterSpacing: '0.08em', textAlign: 'center', marginTop: 2, fontFamily: 'monospace' }}>
            {isDemo ? `Dv${APP_VERSION}` : `v${APP_VERSION}`}
          </div>
        )}
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
                  onClick={() => !item.soon && handleNav(item.key)}
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

      {/* Data Room button (hidden for investor portal only) */}
      {!isInvestorPortal && (
        <div style={{ padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button
            className={styles.dataRoomBtn}
            onClick={() => handleNav('data-room')}
            title="PNTHR Data Room — Fund Documents"
          >
            <span style={{ fontSize: 14 }}>🗄️</span>
            <span>PNTHR Data Room</span>
          </button>
          {effectiveAdmin && (
            <button
              className={styles.dataRoomBtn}
              onClick={() => handleNav('compliance')}
              title="PNTHR Compliance — Documents, Calendar & Tasks"
            >
              <span style={{ fontSize: 14 }}>🛡️</span>
              <span>Compliance</span>
            </button>
          )}
          {effectiveAdmin && (
            <button
              className={styles.dataRoomBtn}
              onClick={() => handleNav('investor-mgmt')}
              title="PNTHR Investor Portal — Manage Accounts & Analytics"
            >
              <span style={{ fontSize: 14 }}>👥</span>
              <span>Investor Portal</span>
            </button>
          )}
          {/* Admin-only: preview the INVESTOR portal shell. This is a plain
              portal-mode preview (nav filter only) — admin stays logged in
              as themselves. Useful for "here's what a prospect would see". */}
          {effectiveAdmin && (
            <button
              className={styles.dataRoomBtn}
              onClick={() => window.open(`${window.location.origin}/?portal=investor`, '_blank', 'noopener')}
              title="Open the Investor view in a new tab — see exactly what investors see when they log in"
            >
              <span style={{ fontSize: 14 }}>👀</span>
              <span>View as Investor</span>
            </button>
          )}
          {/* Admin-only: full impersonation dropdown for the VIP portal. Opens
              a new tab with a read-only, 30-minute token scoped to the
              chosen VIP user — admin sees the VIP's actual data, not their
              own. See server/impersonationService.js + ImpersonationBanner. */}
          {effectiveAdmin && (
            <VipImpersonateMenu />
          )}
        </div>
      )}
      {/* Investor portal: show Data Room button */}
      {isInvestorPortal && (
        <div style={{ padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button
            className={styles.dataRoomBtn}
            onClick={() => handleNav('data-room')}
            title="PNTHR Data Room — Fund Documents"
          >
            <span style={{ fontSize: 14 }}>🗄️</span>
            <span>PNTHR Data Room</span>
          </button>
        </div>
      )}

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
        {effectiveAdmin && !isPortalMode && (
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
    </>
  );
}
