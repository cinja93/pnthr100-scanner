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
    groupLabel: "Investor's Den",
    info: 'investorsDen',
    items: [
      { key: 'ir-live',   label: 'Intelligence Report', iconImg: true, aiHighlight: true, needsAccess: true },
      { key: 'data-room', label: 'PNTHR Data Room',     icon: '🗄️' },
    ],
  },
  {
    groupLabel: 'This Week',
    info: 'thisWeek',
    items: [
      { key: 'perch',    label: 'PNTHR Perch',    iconImg: true },
      { key: 'earnings', label: 'PNTHR Calendar', icon: '📅' },
    ],
  },
  {
    groupLabel: 'Market Pulse',
    info: 'marketPulse',
    items: [
      { key: 'pulse',    label: 'PNTHR Pulse',       iconImg: true, splitHighlight: true },
      { key: 'bondHeat', label: 'PNTHR Bond Yields',  iconImg: true },
    ],
  },
  {
    groupLabel: 'PNTHR Live',
    info: 'pnthrLive',
    items: [
      { key: 'assistant', label: 'PNTHR Assistant', iconImg: true },
      { key: 'orders',    label: 'PNTHR Orders',    iconImg: true },
      { key: 'aiOrders',  label: 'PNTHR AI Orders', iconImg: true, aiHighlight: true },
    ],
  },
  {
    groupLabel: 'Strategy',
    info: 'strategy',
    items: [
      { key: 'prey',   label: 'PNTHR Prey',    iconImg: true },
      { key: 'apex',   label: 'PNTHR Kill',    iconImg: true },
      { key: 'aiKill', label: 'PNTHR AI Kill', iconImg: true, aiHighlight: true },
      { key: 'search', label: 'PNTHR Search',  iconImg: true },
    ],
  },
  {
    groupLabel: 'Universe',
    info: 'universe',
    items: [
      { key: 'jungle',     label: 'Carnivore Jungle',   iconImg: true },
      { key: 'aiJungle',   label: 'PNTHR AI 300 Index', iconImg: true, aiHighlight: true },
      { key: 'sectors',    label: 'PNTHR Sectors',      iconImg: true },
      { key: 'aiSectors',  label: 'PNTHR AI Sectors',   iconImg: true, aiHighlight: true },
      { key: 'jungleHeat', label: 'Carnivore Heat',     iconImg: true },
      { key: 'aiHeat',     label: 'PNTHR AI Heat',      iconImg: true, aiHighlight: true },
      { key: 'etf',        label: "PNTHR ETF's",        iconImg: true },
      { key: 'long',       label: 'PNTHR 100 Longs',    iconImg: true, splitHighlight: true },
      { key: 'short',      label: 'PNTHR 100 Shorts',   iconImg: true, splitHighlight: true },
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
  const [tooltipKey, setTooltipKey] = useState(null);
  const [tooltipTop, setTooltipTop] = useState(0);
  const [infoModal, setInfoModal] = useState(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const btnRefs = useRef({});

  const firstName = getFirstName(currentUser);
  const isPortalMode = isDenPortal || isInvestorPortal || isVipPortal;
  const effectiveAdmin = isAdmin && !isVipPortal && !isInvestorPortal;

  // VIP portal: inject Portfolio item into PNTHR Live
  const liveGroupWithPortfolio = isVipPortal
    ? {
        groupLabel: 'PNTHR Live',
        info: 'pnthrLive',
        items: [
          { key: 'portfolio', label: 'PNTHR Portfolio', iconImg: true },
          { key: 'assistant', label: 'PNTHR Assistant', iconImg: true },
          { key: 'orders',    label: 'PNTHR Orders',    iconImg: true },
        ],
      }
    : null;

  // Internal section — admin-only items
  const internalItems = [];
  if (effectiveAdmin) {
    internalItems.push(
      { key: 'investor-mgmt',     label: 'Investor Portal',     icon: '👥' },
      { key: 'journal',           label: 'PNTHR Journal',       iconImg: true },
      { key: 'signal-history',    label: 'PNTHR History',       iconImg: true },
      { key: 'ai-signal-history', label: 'PNTHR AI History',    iconImg: true, aiHighlight: true },
      { key: 'history',           label: 'PNTHR Kill 10',       iconImg: true, info: 'kill10', splitHighlight: true },
      { key: 'kill-test',         label: 'PNTHR Kill Test',     iconImg: true, info: 'killTest', splitHighlight: true },
      { key: 'compliance',        label: 'Compliance',          icon: '🛡️' },
      { key: 'watchlist',         label: firstName ? `${firstName}'s Watchlist` : 'Watchlist', icon: '👁' },
      { key: 'test',              label: 'TEST',                icon: '🧪' },
    );
  } else {
    // Non-admin users still get Journal and Watchlist
    internalItems.push(
      { key: 'journal',  label: 'PNTHR Journal', iconImg: true },
      { key: 'watchlist', label: firstName ? `${firstName}'s Watchlist` : 'Watchlist', icon: '👁' },
    );
  }
  const internalGroup = internalItems.length > 0
    ? { groupLabel: 'Internal', info: 'internal', adminOnly: true, items: internalItems }
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
              <div className={styles.navGroupBox}>
                {group.items.map((item) => {
                  const isActive = activePage === item.key;
                  const aiStyle = item.aiHighlight ? {
                    background: '#fcf000',
                    color:      '#000',
                    fontWeight: 700,
                    border:     '1px solid #fcf000',
                  } : item.splitHighlight ? {
                    background: 'transparent',
                    fontWeight: 700,
                    border: '1px solid #fcf000',
                    overflow: 'hidden',
                    padding: 0,
                    display: 'flex',
                  } : undefined;
                  return (
                    <button
                      key={item.key}
                      ref={el => { if (el) btnRefs.current[item.key] = el; }}
                      className={`${styles.navItem} ${isActive && !item.aiHighlight && !item.splitHighlight ? styles.navItemActive : ''} ${item.soon ? styles.navItemDisabled : ''}`}
                      style={aiStyle}
                      onClick={() => !item.soon && handleNav(item.key)}
                      disabled={item.soon}
                      title={item.soon ? 'Coming soon' : item.label}
                      onMouseEnter={() => handleMouseEnter(item.key)}
                      onMouseLeave={() => setTooltipKey(null)}
                    >
                      {item.splitHighlight ? (
                        <>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#fcf000', color: '#000', padding: '6px 4px 6px 8px', flexShrink: 0 }}>
                            <img src={pnthrLogo} alt="PNTHR" className={styles.navIconImg} />
                            <span style={{ fontWeight: 700, fontSize: 11 }}>AI</span>
                          </span>
                          <span style={{ display: 'flex', alignItems: 'center', background: '#000', color: '#fcf000', padding: '6px 8px 6px 4px', flex: 1, fontWeight: 700, fontSize: 11 }}>
                            CARN {item.label.replace(/^PNTHR\s*/, '')}
                          </span>
                        </>
                      ) : (
                        <>
                          <span className={styles.navIcon}>
                            {item.iconImg
                              ? <img src={pnthrLogo} alt="PNTHR" className={styles.navIconImg} />
                              : item.icon}
                          </span>
                          <span className={styles.navLabel}>{item.label}</span>
                        </>
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
                {/* Demo Mode inside Internal group */}
                {group.adminOnly && effectiveAdmin && (
                  <VipImpersonateMenu />
                )}
              </div>
            </div>

            {/* Fund Explainer — rendered after Investor's Den */}
            {group.groupLabel === "Investor's Den" && (
              <div className={styles.fundExplainer}>
                <span className={styles.fundExplainerLabel}>
                  Our Funds
                  <span
                    className={styles.sectionInfoBtn}
                    onClick={(e) => { e.stopPropagation(); setInfoModal('fundExplainer'); }}
                    title="About our funds"
                  >ⓘ</span>
                </span>
                <div className={styles.fundTags}>
                  <span className={styles.fundTagAI}>AI ELITE 300</span>
                  <span className={styles.fundTagCarn}>CARNIVORE</span>
                </div>
              </div>
            )}
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
