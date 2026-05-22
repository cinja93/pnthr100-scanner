import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { API_BASE, authHeaders } from '../services/api';

const AumShieldCtx = createContext({ hasPin: null, setHasPin: () => {} });

export function AumShieldProvider({ children }) {
  const [hasPin, setHasPin] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/user/aum-pin/status`, { headers: authHeaders() });
        const d = await res.json();
        setHasPin(!!d.hasPin);
      } catch { setHasPin(false); }
    })();
  }, []);

  return (
    <AumShieldCtx.Provider value={{ hasPin, setHasPin }}>
      {children}
    </AumShieldCtx.Provider>
  );
}

export function useAumShield() { return useContext(AumShieldCtx); }
