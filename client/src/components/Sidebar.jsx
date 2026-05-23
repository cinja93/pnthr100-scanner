import { useState, useRef, useEffect } from 'react';
import styles from './Sidebar.module.css';
import pnthrLogo from '../assets/panther head.png';
import builtWithLove from '../assets/Built with Love.jpg';
import { useDemo } from '../contexts/DemoContext';
import { usePortal } from '../contexts/PortalContext';
import { useFund } from '../contexts/FundContext';
import { fetchImpersonationTargets, startImpersonation } from '../services/api';
import AumShield from './AumShield';

const APP_VERSION = '4.4.0';

// When fund toggle is set to AI, split-badge items navigate to their AI variant.
// When set to Carnivore, they navigate to the Carnivore variant (the default key).
const AI_PAGE_MAP = {
  pulse:          'aiPulse',
  orders:         'aiOrders',
  apex:           'aiKill',
  jungle:         'aiJungle',
  sectors:        'aiSectors',
  jungleHeat:     'aiHeat',
  long:           'long',
  short:          'short',
  'signal-history': 'ai-signal-history',
  history:        'history',
  'kill-test':    'kill-test',
  'ir-live':      'ai-ir-live',
  'data-room':    'ai-data-room',
};

// Reverse map: AI page key → Carnivore base key
const CARN_PAGE_MAP = {};
for (const [carn, ai] of Object.entries(AI_PAGE_MAP)) {
  if (ai !== carn) CARN_PAGE_MAP[ai] = carn;
}

const NAV_GROUPS = [
  {
    groupLabel: "Investor's Den",
    info: 'investorsDen',
    items: [
      { key: 'ir-live',   label: 'Intelligence Report', badge: 'AI | CARN', badgeType: 'split', needsAccess: true },
      { key: 'data-room', label: 'Data Room',            badge: 'AI | CARN', badgeType: 'split' },
    ],
  },
  {
    groupLabel: 'This Week',
    info: 'thisWeek',
    items: [
      { key: 'perch',    label: 'Perch',    badge: 'NEWSLETTER' },
      { key: 'earnings', label: 'Calendar', badge: 'EARNINGS' },
    ],
  },
  {
    groupLabel: 'Market Pulse',
    info: 'marketPulse',
    items: [
      { key: 'pulse',    label: 'Pulse',       badge: 'AI | CARN', badgeType: 'split' },
      { key: 'bondHeat', label: 'Bond Yields' },
    ],
  },
  {
    groupLabel: 'PNTHR Live',
    info: 'pnthrLive',
    items: [
      { key: 'orders',    label: 'Orders',    badge: 'AI | CARN', badgeType: 'split' },
    ],
  },
  {
    groupLabel: 'Strategy',
    info: 'strategy',
    items: [
      { key: 'prey',   label: 'Prey',   badge: 'CARN', badgeType: 'carn' },
      { key: 'apex',   label: 'Kill',   badge: 'AI | CARN', badgeType: 'split' },
      { key: 'search', label: 'Search' },
    ],
  },
  {
    groupLabel: 'Universe',
    info: 'universe',
    items: [
      { key: 'jungle',     label: 'Jungle',     badge: 'AI | CARN', badgeType: 'split' },
      { key: 'sectors',    label: 'Sectors',     badge: 'AI | CARN', badgeType: 'split' },
      { key: 'jungleHeat', label: 'Heat Map',    badge: 'AI | CARN', badgeType: 'split' },
      { key: 'etf',        label: "ETF's" },
      { key: 'long',       label: '100 Longs',   badge: 'AI | CARN', badgeType: 'split' },
      { key: 'short',      label: '100 Shorts',  badge: 'AI | CARN', badgeType: 'split' },
    ],
  },
];

const SECTION_INFO = {
  investorsDen: {
    title: "Investor's Den",
    body: "Start here. Everything an investor needs to evaluate PNTHR Funds — our live performance report and full legal document suite.",
  },
  thisWeek: {
    title: 'This Week',
    body: "Weekly briefing to start your week. The Perch newsletter covers our top trade, market regime, and sector rotation. Calendar shows all upcoming earnings reports.",
  },
  marketPulse: {
    title: 'Market Pulse',
    body: "Real-time performance tracking and macro context. Pulse shows live equity curves for both funds. Bond Yields tracks the treasury yield curve and credit spreads.",
  },
  pnthrLive: {
    title: 'PNTHR Live',
    body: "Live operations center. The Assistant is an all-day dashboard with positions, risk metrics, and real-time alerts. Orders shows the active trading pipeline and heat exposure.",
  },
  strategy: {
    title: 'Strategy',
    body: "Our proprietary stock selection tools. Prey is the Carnivore trade pipeline. Kill scores every stock across 8 dimensions. Search lets you analyze any individual ticker.",
  },
  universe: {
    title: 'Universe',
    body: "Browse every stock we track. The Jungle is our full universe. Sectors shows ETF-level regime analysis. Heat maps risk by sector. 100 Longs/Shorts ranks the strongest signals.",
  },
  internal: {
    title: 'Internal',
    body: "Admin-only tools for fund operations, trade journaling, compliance, and backtesting. These pages are not visible to investors or outside users.",
  },
  fundExplainer: {
    title: 'Carnivore vs AI Elite 300',
    body: "Carnivore — Our flagship equity fund. Concentrated, high-conviction positions across all sectors using proprietary signal detection and 5-lot pyramid scaling.\n\nAI Elite 300 — Our AI-focused equity fund. 300 names in the artificial intelligence ecosystem — semiconductors, cloud, robotics, data infrastructure, and AI applications. Same pyramid discipline, AI-specific universe.",
  },
  kill10: {
    title: 'PNTHR Kill 10',
    body: null,
  },
  killTest: {
    title: 'PNTHR Kill Test',
    body: null,
  },
};

function getFirstName(user) {
  if (!user) return null;
  if (user.name)      return user.name.split(' ')[0];
  if (user.firstName) return user.firstName;
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
function VipImpersonateMenu() {
  const [open, setOpen]         = useState(false);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [targets, setTargets]   = useState(null);
  const [launching, setLaunching] = useState(null);

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
        className={styles.navItem}
        onClick={() => setOpen(o => !o)}
        title="Open a clean demo view with no account data (read-only, 30-min session)"
        style={{ color: 'rgba(255,255,255,0.65)', borderLeft: '3px solid transparent' }}
      >
        <span className={styles.navIcon}>👀</span>
        <span className={styles.navLabel}>Demo Mode</span>
        <span style={{ fontSize: 10, opacity: 0.6, marginLeft: 'auto' }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div style={{
          marginTop:    2,
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
            <VipImpersonateOption
              target={targets.vanilla}
              subtitle="Clean demo — no account data"
              onLaunch={handleLaunch}
              launching={launching === targets.vanilla.id}
            />
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
  const { activeFund, setActiveFund } = useFund();
  const [pageOverrides, setPageOverrides] = useState({});
  const [tooltipKey, setTooltipKey] = useState(null);
  const [tooltipTop, setTooltipTop] = useState(0);
  const [infoModal, setInfoModal] = useState(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebarCollapsed') === 'true');
  const btnRefs = useRef({});

  function toggleCollapse() {
    setCollapsed(prev => {
      const next = !prev;
      localStorage.setItem('sidebarCollapsed', String(next));
      return next;
    });
  }

  // Auto-navigate when fund toggle changes and user is on a dual-fund page
  useEffect(() => {
    if (activeFund === 'ai') {
      // If on a Carnivore page that has an AI variant, switch to it
      const aiPage = AI_PAGE_MAP[activePage];
      if (aiPage && aiPage !== activePage) onNavigate(aiPage);
    } else {
      // If on an AI page, switch back to Carnivore variant
      const carnPage = CARN_PAGE_MAP[activePage];
      if (carnPage) onNavigate(carnPage);
    }
  }, [activeFund]); // eslint-disable-line react-hooks/exhaustive-deps

  const firstName = getFirstName(currentUser);
  const isPortalMode = isDenPortal || isInvestorPortal || isVipPortal;
  const effectiveAdmin = isAdmin && !isVipPortal && !isInvestorPortal;

  // VIP portal: inject Portfolio item into PNTHR Live
  const liveGroupWithPortfolio = isVipPortal
    ? {
        groupLabel: 'PNTHR Live',
        info: 'pnthrLive',
        items: [
          { key: 'portfolio', label: 'Portfolio' },
          { key: 'assistant', label: 'Assistant', badge: 'DASHBOARD' },
          { key: 'orders',    label: 'Orders',    badge: 'AI | CARN', badgeType: 'split' },
        ],
      }
    : null;

  // Internal section — admin-only, PIN-protected
  const internalGroup = effectiveAdmin
    ? {
        groupLabel: 'Internal', info: 'internal', adminOnly: true, pinProtected: true,
        items: [
          { key: 'assistant',         label: 'Assistant', badge: 'DASHBOARD' },
          { key: 'investor-mgmt',     label: 'Investor Portal' },
          { key: 'journal',           label: 'Journal' },
          { key: 'signal-history',    label: 'Signal History',    badge: 'AI | CARN', badgeType: 'split' },
          { key: 'history',           label: 'Kill 10',           info: 'kill10', badge: 'AI | CARN', badgeType: 'split' },
          { key: 'kill-test',         label: 'Kill Test',         info: 'killTest', badge: 'AI | CARN', badgeType: 'split' },
          { key: 'compliance',        label: 'Compliance' },
          { key: 'watchlist',         label: firstName ? `${firstName}'s Watchlist` : 'Watchlist' },
          { key: 'test',              label: 'TEST' },
        ],
      }
    : null;

  // Assemble groups
  const baseGroups = liveGroupWithPortfolio
    ? NAV_GROUPS.map(g => g.groupLabel === 'PNTHR Live' ? liveGroupWithPortfolio : g)
    : NAV_GROUPS;

  let allGroups = internalGroup
    ? [...baseGroups, internalGroup]
    : [...baseGroups];

  // Per-user or portal page filtering
  const userPages = currentUser?.allowedPages;
  const effectiveAllowed = (userPages && userPages.length > 0) ? userPages : allowedPages;
  if (effectiveAllowed) {
    allGroups = allGroups
      .map(group => ({
        ...group,
        items: group.items.filter(item => effectiveAllowed.includes(item.key)),
      }))
      .filter(group => group.items.length > 0);
  } else {
    // No portal/per-user filter — hide items that need explicit access (non-admin)
    if (!effectiveAdmin) {
      allGroups = allGroups
        .map(group => ({
          ...group,
          items: group.items.filter(item =>
            !item.needsAccess || (userPages && userPages.includes(item.key))
          ),
        }))
        .filter(group => group.items.length > 0);
    }
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

  function resolvePageForFund(key, badgeType) {
    if (badgeType !== 'split') return key;
    const fund = pageOverrides[key] ?? activeFund;
    if (fund === 'ai' && AI_PAGE_MAP[key]) return AI_PAGE_MAP[key];
    return key;
  }

  function handleNav(page, badgeType) {
    setMobileOpen(false);
    onNavigate(resolvePageForFund(page, badgeType));
  }

  function renderGroupItems(group) {
    return (
      <>
        {group.items.map((item) => {
          const resolvedPage = resolvePageForFund(item.key, item.badgeType);
          const isActive = activePage === item.key || activePage === resolvedPage
            || (item.badgeType === 'split' && activePage === AI_PAGE_MAP[item.key]);
          return (
            <button
              key={item.key}
              ref={el => { if (el) btnRefs.current[item.key] = el; }}
              className={`${styles.navItem} ${isActive ? styles.navItemActive : ''} ${item.soon ? styles.navItemDisabled : ''}`}
              onClick={() => !item.soon && handleNav(item.key, item.badgeType)}
              disabled={item.soon}
              title={item.soon ? 'Coming soon' : item.label}
              onMouseEnter={() => handleMouseEnter(item.key)}
              onMouseLeave={() => setTooltipKey(null)}
            >
              <span className={styles.navLabel}>{item.label}</span>
              {item.badge && item.badgeType === 'split' && (() => {
                const aiKey = AI_PAGE_MAP[item.key];
                const hasVariant = aiKey && aiKey !== item.key;
                const isThisActive = activePage === item.key || (hasVariant && activePage === aiKey);
                const showAi = isThisActive
                  ? (hasVariant && activePage === aiKey)
                  : (pageOverrides[item.key] ?? activeFund) === 'ai';
                return (
                  <span className={styles.badgeSplit}>
                    <span
                      className={`${styles.badgeSplitAi} ${showAi ? styles.badgeSplitActive : styles.badgeSplitDim}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPageOverrides(prev => ({ ...prev, [item.key]: 'ai' }));
                        if (hasVariant) onNavigate(aiKey);
                        else onNavigate(item.key);
                      }}
                    >AI</span>
                    <span className={styles.badgeSplitSep}>|</span>
                    <span
                      className={`${styles.badgeSplitCarn} ${!showAi ? styles.badgeSplitActive : styles.badgeSplitDim}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPageOverrides(prev => ({ ...prev, [item.key]: 'carn' }));
                        onNavigate(item.key);
                      }}
                    >CARN</span>
                  </span>
                );
              })()}
              {item.badge && item.badgeType === 'carn' && (
                <span className={styles.badgeCarn}>{item.badge}</span>
              )}
              {item.badge && item.badgeType === 'live' && (
                <span className={styles.badgeLive}>{item.badge}</span>
              )}
              {item.badge && !item.badgeType && (
                <span className={styles.badgeDefault}>{item.badge}</span>
              )}
              {item.soon && <span className={styles.soonBadge}>Soon</span>}
              {item.info && (
                <span
                  className={styles.navInfoBtn}
                  onClick={(e) => { e.stopPropagation(); setInfoModal(item.info); }}
                  title="What does this measure?"
                >ⓘ</span>
              )}
            </button>
          );
        })}
        {group.adminOnly && effectiveAdmin && (
          <VipImpersonateMenu />
        )}
      </>
    );
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

      {/* Expand tab — visible only when sidebar is collapsed on desktop */}
      {collapsed && (
        <button className={styles.expandTab} onClick={toggleCollapse} aria-label="Expand sidebar">
          <img src={pnthrLogo} alt="PNTHR" className={styles.expandTabLogo} />
        </button>
      )}

    <aside className={`${styles.sidebar} ${mobileOpen ? styles.sidebarOpen : ''} ${collapsed ? styles.sidebarCollapsed : ''}`} style={isDemo ? { borderTop: '2px solid #fcf000' } : undefined}>
      {/* Collapse toggle — right edge of sidebar */}
      <button className={styles.collapseBtn} onClick={toggleCollapse} aria-label="Collapse sidebar">‹</button>
      {/* Logo + branding */}
      <div className={styles.logoArea}>
        <img src={pnthrLogo} alt="PNTHR" className={styles.logo} />
        <div className={styles.appName}>
          <span className={styles.appNameYellow}>PNTHR</span>{' '}
          <span className={styles.appNameWhite}>
            {isDenPortal ? "'s Den" : isInvestorPortal ? 'Investor' : "'s Den"}
          </span>
        </div>
        {!isPortalMode && (
          <div style={{ fontSize: 8, color: '#444', letterSpacing: '0.08em', textAlign: 'center', marginTop: 2, fontFamily: 'monospace' }}>
            {isDemo ? `Dv${APP_VERSION}` : `v${APP_VERSION}`}
          </div>
        )}
        <button
          onClick={onLogout}
          style={{
            background: 'none', border: '1px solid #333', color: '#666',
            borderRadius: 4, padding: '3px 10px', fontSize: 9, cursor: 'pointer',
            letterSpacing: '0.04em', marginTop: 6,
          }}
        >
          SIGN OUT
        </button>
      </div>

      {/* Navigation groups */}
      <nav className={styles.nav}>
        {/* Master Toggle — switches every dual-fund page at once */}
        <div className={styles.fundExplainer}>
          <span className={styles.fundExplainerLabel}>
            Master Toggle
            <span
              className={styles.sectionInfoBtn}
              onClick={(e) => { e.stopPropagation(); setInfoModal('fundExplainer'); }}
              title="About our funds"
            >ⓘ</span>
          </span>
          <div className={styles.fundTags}>
            <button
              className={`${styles.fundTagAI} ${activeFund !== 'ai' ? styles.fundTagInactive : ''}`}
              onClick={() => { setPageOverrides({}); setActiveFund('ai'); }}
            >AI ELITE 300</button>
            <button
              className={`${styles.fundTagCarn} ${activeFund !== 'carn' ? styles.fundTagInactive : ''}`}
              onClick={() => { setPageOverrides({}); setActiveFund('carn'); }}
            >Carnivore</button>
          </div>
        </div>

        {allGroups.map((group) => (
          <div key={group.groupLabel}>
            <div className={styles.navGroup}>
              <span className={styles.navGroupLabel}>
                {group.adminOnly && <span style={{ marginRight: 4 }}>🔒</span>}
                {group.groupLabel}
                {group.info && (
                  <span
                    className={styles.sectionInfoBtn}
                    onClick={(e) => { e.stopPropagation(); setInfoModal(group.info); }}
                    title={`About ${group.groupLabel}`}
                  >ⓘ</span>
                )}
              </span>
              {group.pinProtected ? (
                <AumShield block showDuration>
                  <div className={styles.navGroupBox}>
                    {renderGroupItems(group)}
                  </div>
                </AumShield>
              ) : (
                <div className={styles.navGroupBox}>
                  {renderGroupItems(group)}
                </div>
              )}
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

      {/* Info modal — section explainers + Kill 10 / Kill Test */}
      {infoModal && (
        <div className={styles.infoModalOverlay} onClick={() => setInfoModal(null)}>
          <div className={styles.infoModalBox} onClick={(e) => e.stopPropagation()}>
            <button className={styles.infoModalClose} onClick={() => setInfoModal(null)}>✕</button>

            {/* Section info modals */}
            {SECTION_INFO[infoModal]?.body && infoModal !== 'kill10' && infoModal !== 'killTest' && (
              <>
                <h3 className={styles.infoModalTitle}>{SECTION_INFO[infoModal].title}</h3>
                <div className={styles.infoModalSection} style={{ whiteSpace: 'pre-line' }}>
                  {SECTION_INFO[infoModal].body}
                </div>
              </>
            )}

            {/* Kill 10 info modal — preserved from original */}
            {infoModal === 'kill10' && (
              <>
                <h3 className={styles.infoModalTitle}>PNTHR Kill 10</h3>
                <p className={styles.infoModalDesc}>Forward-tested track record of the Kill scoring engine's top-10 stock picks.</p>
                <div className={styles.infoModalSection}>
                  <strong>What it measures:</strong> Every time a stock enters the Kill top 10 ranking, the system automatically opens a simulated trade using the full 5-lot PNTHR pyramid strategy. It tracks entries, weekly P&L snapshots, and exits (STOP_HIT, OVEREXTENDED, or BE/SE structural break).
                </div>
                <div className={styles.infoModalSection}>
                  <strong>The question it answers:</strong> "If you traded every top-10 Kill stock mechanically using the PNTHR pyramid, what would the results be?"
                </div>
                <div className={styles.infoModalSection}>
                  <strong>Key metrics:</strong> Win rate, profit factor, avg win vs avg loss, total P&L, equity curve — broken down by tier, direction, sector, and month. Configurable NAV ($100K–$5M) scales the pyramid P&L accordingly.
                </div>
                <div className={styles.infoModalSection}>
                  <strong>Data source:</strong> Friday pipeline scores all 679 stocks, ranks top 10, opens new case studies, updates active ones, and rebuilds the aggregate track record weekly.
                </div>
              </>
            )}
            {infoModal === 'killTest' && (
              <>
                <h3 className={styles.infoModalTitle}>PNTHR Kill Test</h3>
                <p className={styles.infoModalDesc}>Broader forward performance tracker — every qualifying Kill stock, not just the top 10.</p>
                <div className={styles.infoModalSection}>
                  <strong>What it measures:</strong> Every stock that qualifies on the Kill list (Kill &gt; 100, Analyze &gt; 80%, Composite &gt; 75) is tracked with the full 5-lot pyramid simulation using your actual NAV, risk %, and portfolio cap settings.
                </div>
                <div className={styles.infoModalSection}>
                  <strong>The question it answers:</strong> "What happens if you mechanically take every qualifying Kill signal at your real account size?" This is a stress test of the entire Kill pipeline at scale.
                </div>
                <div className={styles.infoModalSection}>
                  <strong>Key metrics:</strong> Active/closed appearances, portfolio heat, lot fill tracking, estimated P&L per position. Portfolio Analytics tab shows Sharpe, Sortino, Calmar ratios, drawdown analysis, monthly equity curve, and peak-to-valley attribution.
                </div>
                <div className={styles.infoModalSection}>
                  <strong>Data source:</strong> Daily cron (4:30 PM ET) fetches OHLC, checks lot trigger fills, ratchets stops, and records exits. Monthly cron computes portfolio snapshots and risk metrics.
                </div>
              </>
            )}
          </div>
        </div>
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
