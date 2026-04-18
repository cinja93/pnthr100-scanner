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

// Pages allowed per portal mode
export const PORTAL_PAGES = {
  den:      null, // Admin demo mode — full access, no page filtering
  investor: ['apex', 'perch', 'sectors', 'etf', 'earnings', 'jungle', 'pulse', 'data-room'],
  // VIP: member-scoped view. Per-user data isolation (portfolio/journal/
  // command/assistant/watchlist) is enforced server-side via ownerId filters.
  vip: [
    'perch', 'earnings', 'pulse', 'portfolio', 'assistant', 'command',
    'search', 'prey', 'apex', 'jungle', 'long', 'short', 'etf', 'sectors',
    'journal', 'watchlist', 'orders', 'data-room',
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
