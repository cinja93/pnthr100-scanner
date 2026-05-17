import { createContext, useContext, useMemo } from 'react';

/**
 * PortalContext — detects which subdomain the user is on and exposes
 * the portal mode to the entire component tree.
 *
 * Modes:
 *   'app'      — normal PNTHR's Den (full access based on role)
 *   'den'      — den.pnthrfunds.com (admin demo mode for investor meetings)
 *   'investor' — investor.pnthrfunds.com (investor self-service portal)
 *   'vip'      — vip.pnthrfunds.com (member portal for Brennan + family)
 */

const PortalContext = createContext({ portalMode: 'app' });

// All pages that can be assigned to investors/VIPs.
// personalData = true means the page exposes admin account info (NAV, positions, etc.)
// and should default to UNCHECKED when creating a new investor.
export const ALL_ASSIGNABLE_PAGES = [
  { key: 'perch',      label: 'PNTHR Perch' },
  { key: 'earnings',   label: 'PNTHR Calendar' },
  { key: 'pulse',      label: 'PNTHR Pulse' },
  { key: 'assistant',  label: 'PNTHR Assistant',  personalData: true },
  { key: 'orders',     label: 'PNTHR Orders' },
  { key: 'aiOrders',   label: 'PNTHR AI Orders' },
  { key: 'search',     label: 'PNTHR Search' },
  { key: 'prey',       label: 'PNTHR Prey' },
  { key: 'apex',       label: 'PNTHR Kill' },
  { key: 'aiKill',     label: 'PNTHR AI Kill' },
  { key: 'jungle',     label: 'PNTHR 679 Jungle' },
  { key: 'aiJungle',   label: 'PNTHR AI 300 Index' },
  { key: 'aiSectors',  label: 'PNTHR AI Sectors' },
  { key: 'long',       label: 'PNTHR 100 Longs' },
  { key: 'short',      label: 'PNTHR 100 Shorts' },
  { key: 'etf',        label: "PNTHR ETF's" },
  { key: 'sectors',    label: 'PNTHR Sectors' },
  { key: 'journal',    label: 'PNTHR Journal',    personalData: true },
  { key: 'watchlist',  label: 'Watchlist' },
  { key: 'portfolio',  label: 'PNTHR Portfolio',   personalData: true },
  { key: 'bondHeat',   label: 'PNTHR Bond Heat' },
  { key: 'data-room',  label: 'PNTHR Data Room' },
];

export function getDefaultPages() {
  return ALL_ASSIGNABLE_PAGES.filter(p => !p.personalData).map(p => p.key);
}

// Pages allowed per portal mode (fallback when user has no per-user allowedPages)
export const PORTAL_PAGES = {
  den:      null, // Admin demo mode — full access, no page filtering
  investor: ['apex', 'perch', 'sectors', 'etf', 'earnings', 'jungle', 'pulse', 'data-room'],
  // VIP: member-scoped view. Per-user data isolation (portfolio/journal/
  // assistant/watchlist) is enforced server-side via ownerId filters.
  vip: [
    'perch', 'earnings', 'pulse', 'portfolio', 'assistant',
    'search', 'prey', 'apex', 'jungle', 'long', 'short', 'etf', 'sectors',
    'journal', 'watchlist', 'orders', 'bondHeat', 'data-room',
  ],
};

function detectPortal() {
  const host = window.location.hostname;
  if (host === 'den.pnthrfunds.com')      return 'den';
  if (host === 'investor.pnthrfunds.com') return 'investor';
  if (host === 'vip.pnthrfunds.com')      return 'vip';
  // Dev shortcuts: ?portal=den | investor | vip
  const params = new URLSearchParams(window.location.search);
  const override = params.get('portal');
  if (override === 'den' || override === 'investor' || override === 'vip') return override;
  return 'app';
}

export function PortalProvider({ children }) {
  const value = useMemo(() => {
    const portalMode = detectPortal();
    return {
      portalMode,
      isDenPortal:      portalMode === 'den',
      isInvestorPortal: portalMode === 'investor',
      isVipPortal:      portalMode === 'vip',
      allowedPages: PORTAL_PAGES[portalMode] || null, // null = all pages allowed
    };
  }, []);

  return <PortalContext.Provider value={value}>{children}</PortalContext.Provider>;
}

export function usePortal() {
  return useContext(PortalContext);
}
