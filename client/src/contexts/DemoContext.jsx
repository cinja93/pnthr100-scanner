// client/src/contexts/DemoContext.jsx
// ── Demo Mode Context ───────────────────────────────────────────────────────
//
// Provides isDemo toggle for investor demo presentations.
// When active, all user-scoped API calls append ?demo=1 so the server
// swaps ownerId to 'demo_fund', showing the auto-traded Kill top 10 portfolio.
//
// Persists to localStorage so refreshing the page stays in demo mode.
// Admin-only. Toggle is a subtle icon in the sidebar footer.
// ─────────────────────────────────────────────────────────────────────────────

import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { apiFetch, authHeaders, setDemoMode } from '../services/api';

const STORAGE_KEY = 'pnthr_demo_mode';
const DemoContext = createContext({ isDemo: false, toggleDemo: () => {} });

export function useDemo() {
  return useContext(DemoContext);
}

export function DemoProvider({ children }) {
  const [isDemo, setIsDemo] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    const active = saved === '1';
    // Apply immediately on load so the very first fetch calls get ?demo=1
    if (active) setDemoMode(true);
    return active;
  });

  // Notify server on mount if demo was persisted
  useEffect(() => {
    if (isDemo) {
      apiFetch('/api/demo/toggle', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true }),
      }).catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  }, [isDemo]);

  return (
    <DemoContext.Provider value={{ isDemo, toggleDemo }}>
      {children}
    </DemoContext.Provider>
  );
}
