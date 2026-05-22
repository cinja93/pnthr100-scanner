import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { API_BASE, authHeaders } from '../services/api';

const AumShieldCtx = createContext({ locked: true, hasPin: null, unlock: () => {}, setPin: () => {}, checkStatus: () => {} });

const UNLOCK_MS = 10 * 60 * 1000;

export function AumShieldProvider({ children }) {
  const [locked, setLocked] = useState(true);
  const [hasPin, setHasPin] = useState(null);
  const timerRef = useRef(null);

  const lock = useCallback(() => {
    setLocked(true);
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const startTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(lock, UNLOCK_MS);
  }, [lock]);

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/user/aum-pin/status`, { headers: authHeaders() });
      const d = await res.json();
      setHasPin(!!d.hasPin);
    } catch { setHasPin(false); }
  }, []);

  useEffect(() => { checkStatus(); }, [checkStatus]);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const unlock = useCallback(async (pin) => {
    const res = await fetch(`${API_BASE}/api/user/aum-pin/verify`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ pin }),
    });
    const d = await res.json();
    if (d.success) {
      setLocked(false);
      startTimer();
      return true;
    }
    return false;
  }, [startTimer]);

  const setPin = useCallback(async (pin) => {
    const res = await fetch(`${API_BASE}/api/user/aum-pin`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ pin }),
    });
    const d = await res.json();
    if (d.success) {
      setHasPin(true);
      setLocked(false);
      startTimer();
      return true;
    }
    return false;
  }, [startTimer]);

  return (
    <AumShieldCtx.Provider value={{ locked, hasPin, unlock, setPin, checkStatus }}>
      {children}
    </AumShieldCtx.Provider>
  );
}

export function useAumShield() { return useContext(AumShieldCtx); }
