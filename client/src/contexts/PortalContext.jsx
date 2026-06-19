import { createContext, useContext, useMemo } from 'react';
import SIDEBAR_PAGES from '../utils/sidebarPages';

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

// Auto-derived from SIDEBAR_PAGES — any new sidebar button automatically
// appears as an assignable checkbox in the Investor Portal (unchecked by default).
export const ALL_ASSIGNABLE_PAGES = SIDEBAR_PAGES;

export function getDefaultPages() {
  return ALL_ASSIGNABLE_PAGES.filter(p => !p.personalData).map(p => p.key);
}

// Pages allowed per portal mode (fallback when user has no per-user allowedPages)
export const PORTAL_PAGES = {
  den:      null, // Admin demo mode — full access, no page filtering
  // Tree-exclusive: investors land on the Tree IR + Tree Data Room. Elite IR /
  // Elite Data Room are now INTERNAL (admin-only) and intentionally excluded.
  investor: ['tree-ir-live', 'tree-data-room', 'perch', 'earnings', 'newHighsLows', 'aiPulse', 'ai300Index', 'bondHeat', 'aiKill', 'search', 'aiJungle', 'aiSectors', 'aiHeat', 'etf'],
  // VIP: member-scoped view. Per-user data isolation (portfolio/journal/
  // assistant/watchlist) is enforced server-side via ownerId filters.
  // Orders pages show MCE/Sector Gated/ON DECK with VIP user's own NAV
  // for sizing (not admin NAV). Admin-only sections (Live Positions, Heat
  // Budget, Sector Breakdown, Bridge Orders) are gated by isAdmin.
  vip: [
    'tree-ir-live', 'tree-data-room', 'pnthrTree', 'newHighsLows', 'perch', 'earnings',
    'pulse', 'aiPulse', 'ai300Index', 'bondHeat',
    'prey', 'apex', 'aiKill', 'search',
    'jungle', 'aiJungle', 'sectors', 'aiSectors',
    'jungleHeat', 'aiHeat', 'etf', 'long', 'short',
    'watchlist',
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
