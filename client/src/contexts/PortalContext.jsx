import { createContext, useContext, useMemo } from 'react';

/**
 * PortalContext — detects which subdomain the user is on and exposes
 * the portal mode to the entire component tree.
 *
 * Modes:
 *   'app'      — normal PNTHR's Den (full access based on role)
 *   'den'      — den.pnthrfunds.com (admin demo mode for investor meetings)
 *   'investor' — investor.pnthrfunds.com (investor self-service portal)
 */

const PortalContext = createContext({ portalMode: 'app' });

// Pages allowed per portal mode
export const PORTAL_PAGES = {
  den:      ['apex', 'prey', 'perch', 'sectors'],
  investor: ['apex', 'prey', 'perch', 'sectors', 'data-room'],
};

function detectPortal() {
  const host = window.location.hostname;
  if (host === 'den.pnthrfunds.com') return 'den';
  if (host === 'investor.pnthrfunds.com') return 'investor';
  // Dev shortcuts: ?portal=den or ?portal=investor
  const params = new URLSearchParams(window.location.search);
  const override = params.get('portal');
  if (override === 'den' || override === 'investor') return override;
  return 'app';
}

export function PortalProvider({ children }) {
  const value = useMemo(() => {
    const portalMode = detectPortal();
    return {
      portalMode,
      isDenPortal: portalMode === 'den',
      isInvestorPortal: portalMode === 'investor',
      allowedPages: PORTAL_PAGES[portalMode] || null, // null = all pages allowed
    };
  }, []);

  return <PortalContext.Provider value={value}>{children}</PortalContext.Provider>;
}

export function usePortal() {
  return useContext(PortalContext);
}
