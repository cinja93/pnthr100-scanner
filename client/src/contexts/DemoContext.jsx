// client/src/contexts/DemoContext.jsx
// ── Demo Mode Context ───────────────────────────────────────────────────────
//
// Provides isDemo toggle for investor demo presentations.
// When active, all user-scoped API calls append ?demo=1 so the server
// swaps ownerId to 'demo_fund', showing the auto-traded Kill top 10 portfolio.
//
// Admin-only. Toggle is a subtle icon in the sidebar footer.
// ─────────────────────────────────────────────────────────────────────────────

import { createContext, useContext, useState, useCallback } from 'react';
import { apiFetch, authHeaders, setDemoMode } from '../services/api';

const DemoContext = createContext({ isDemo: false, toggleDemo: () => {} });

export function useDemo() {
  return useContext(DemoContext);
}

export function DemoProvider({ children }) {
  const [isDemo, setIsDemo] = useState(false);

  const toggleDemo = useCallback(async () => {
    const next = !isDemo;
    try {
      await apiFetch('/api/demo/toggle', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: next }),
      });
    } catch (e) {
      console.warn('[Demo] Toggle failed:', e.message);
    }
    setDemoMode(next);
    setIsDemo(next);
  }, [isDemo]);

  return (
    <DemoContext.Provider value={{ isDemo, toggleDemo }}>
      {children}
    </DemoContext.Provider>
  );
}
