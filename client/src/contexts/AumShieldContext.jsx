import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { API_BASE, authHeaders } from '../services/api';

const SS_KEY = 'pnthr.aumShield.unlockedUntil';

const AumShieldCtx = createContext({
  hasPin: null, setHasPin: () => {},
  unlocked: false, unlock: () => {}, lock: () => {},
});

export function AumShieldProvider({ children }) {
  const [hasPin, setHasPin] = useState(null);
  const [unlocked, setUnlocked] = useState(() => {
    try {
      const until = parseInt(sessionStorage.getItem(SS_KEY), 10);
      return until && Date.now() < until;
    } catch { return false; }
  });
  const timerRef = useRef(null);

  // On mount, if session says unlocked, schedule the re-lock
  useEffect(() => {
    try {
      const until = parseInt(sessionStorage.getItem(SS_KEY), 10);
      if (until && Date.now() < until) {
        const remaining = until - Date.now();
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          setUnlocked(false);
          sessionStorage.removeItem(SS_KEY);
        }, remaining);
      }
    } catch {}
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/user/aum-pin/status`, { headers: authHeaders() });
        const d = await res.json();
        setHasPin(!!d.hasPin);
      } catch { setHasPin(false); }
    })();
  }, []);

  const unlock = useCallback((durationMs) => {
    const until = Date.now() + durationMs;
    sessionStorage.setItem(SS_KEY, String(until));
    setUnlocked(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setUnlocked(false);
      sessionStorage.removeItem(SS_KEY);
    }, durationMs);
  }, []);

  const lock = useCallback(() => {
    setUnlocked(false);
    sessionStorage.removeItem(SS_KEY);
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return (
    <AumShieldCtx.Provider value={{ hasPin, setHasPin, unlocked, unlock, lock }}>
      {children}
    </AumShieldCtx.Provider>
  );
}

export function useAumShield() { return useContext(AumShieldCtx); }
