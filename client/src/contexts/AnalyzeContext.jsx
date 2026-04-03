/**
 * PNTHR Analyze Context — shared pre-trade scoring context
 *
 * Loads regime, sector exposure, wash rules, and NAV once per page,
 * then provides them to all components so computeAnalyzeScore() can
 * run instantly for every stock without extra API calls.
 *
 * Refreshes every 5 minutes.
 */

import { createContext, useContext, useState, useEffect } from 'react';
import { API_BASE, authHeaders } from '../services/api';
import { useAuth } from '../AuthContext';

const AnalyzeContext = createContext(null);

export function AnalyzeProvider({ children }) {
  const { currentUser } = useAuth() || {};
  const [analyzeContext, setAnalyzeContext] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadContext() {
      try {
        const [sectorRes, washRes, navRes, regimeRes, sectorEmaRes] = await Promise.all([
          fetch(`${API_BASE}/api/sector-exposure`, { headers: authHeaders() })
            .then(r => r.ok ? r.json() : null)
            .catch(() => null),
          fetch(`${API_BASE}/api/wash-rules`, { headers: authHeaders() })
            .then(r => r.ok ? r.json() : [])
            .catch(() => []),
          fetch(`${API_BASE}/api/settings/nav`, { headers: authHeaders() })
            .then(r => r.ok ? r.json() : null)
            .catch(() => null),
          fetch(`${API_BASE}/api/regime`, { headers: authHeaders() })
            .then(r => r.ok ? r.json() : null)
            .catch(() => null),
          fetch(`${API_BASE}/api/sector-ema`, { headers: authHeaders() })
            .then(r => r.ok ? r.json() : {})
            .catch(() => ({})),
        ]);

        // Build wash ticker set for fast O(1) lookup
        const washArray = Array.isArray(washRes) ? washRes : (washRes?.rules || []);
        const washTickers = new Set(
          washArray
            .filter(w => !w.washSale?.triggered && (w.washSale?.daysRemaining || 0) > 0)
            .map(w => (w.ticker || '').toUpperCase())
        );

        setAnalyzeContext({
          sectorExposure: sectorRes?.exposure || {},
          washRules: washArray,
          washTickers,
          nav: navRes?.nav || null,
          regime: regimeRes || null,
          sectorEma: sectorEmaRes || {},
          loadedAt: new Date(),
        });
      } catch (e) {
        console.error('[ANALYZE] Failed to load context:', e);
        // Don't clear existing context on failure — keep stale data
      } finally {
        setLoading(false);
      }
    }

    loadContext();
    const interval = setInterval(loadContext, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [currentUser]); // re-run when auth state changes (login/logout)

  return (
    <AnalyzeContext.Provider value={{ analyzeContext, loading }}>
      {children}
    </AnalyzeContext.Provider>
  );
}

export function useAnalyzeContext() {
  return useContext(AnalyzeContext);
}
