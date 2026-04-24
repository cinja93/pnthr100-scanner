// client/src/contexts/ImpersonationContext.jsx
// ── Admin impersonation state, scoped per-tab ──────────────────────────────
//
// A tab is "in impersonation" when its sessionStorage holds an impersonation
// JWT. The JWT's `impersonatedBy` + `targetDisplayName` claims drive the
// banner and the exit flow. Admin's normal Den token lives in localStorage
// and is untouched — the admin's OWN tab keeps working in parallel.
//
// Security model:
//   - Banner / exit button render ONLY when the decoded token has
//     `impersonatedBy`. A user logging in normally (no impersonation) has no
//     such claim and sees no impersonation UI whatsoever.
//   - Token is never forgeable from the client; JWT_SECRET lives on the
//     server. We only *decode* the payload for display.
//
// This context is mounted at the app root (App.jsx) so every page can read
// the state without prop drilling.

import { createContext, useContext, useMemo } from 'react';

const ImpersonationContext = createContext({
  isImpersonating:   false,
  targetDisplayName: null,
  impersonatorEmail: null,
});

const IMPERSONATION_TOKEN_KEY = 'pnthr_impersonation_token';

// Decode a JWT payload (no signature verification — that's the server's job).
// Returns null if the token is missing or malformed.
function decodeJwtPayload(token) {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

// Read the active impersonation token for THIS tab (sessionStorage). Returns
// null if the tab isn't impersonating.
export function getImpersonationToken() {
  if (typeof window === 'undefined') return null;
  try { return window.sessionStorage.getItem(IMPERSONATION_TOKEN_KEY); }
  catch { return null; }
}

export function setImpersonationToken(token) {
  try { window.sessionStorage.setItem(IMPERSONATION_TOKEN_KEY, token); }
  catch { /* incognito quota — ignore */ }
}

export function clearImpersonationToken() {
  try { window.sessionStorage.removeItem(IMPERSONATION_TOKEN_KEY); }
  catch { /* ignore */ }
}

// Landing-page hook: if the tab URL has `?impersonate=<jwt>`, move it into
// sessionStorage and clean the URL bar. Called once on app boot from App.jsx
// BEFORE any token is read, so subsequent getImpersonationToken() returns
// the fresh token.
export function consumeImpersonationFromUrl() {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const token = params.get('impersonate');
  if (!token) return null;
  setImpersonationToken(token);
  params.delete('impersonate');
  const newSearch = params.toString();
  const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : '') + window.location.hash;
  window.history.replaceState({}, '', newUrl);
  return token;
}

export function ImpersonationProvider({ children }) {
  // Re-read per render so start/stop flows updating sessionStorage reflect
  // immediately after a state change. sessionStorage is per-tab, so this
  // does not need cross-tab broadcasting.
  const value = useMemo(() => {
    const token   = getImpersonationToken();
    const payload = decodeJwtPayload(token);
    if (!payload?.impersonatedBy) {
      return {
        isImpersonating:   false,
        targetDisplayName: null,
        impersonatorEmail: null,
        token:             null,
      };
    }
    return {
      isImpersonating:   true,
      targetDisplayName: payload.targetDisplayName || payload.email || 'User',
      impersonatorEmail: payload.impersonatorEmail || null,
      token,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ImpersonationContext.Provider value={value}>
      {children}
    </ImpersonationContext.Provider>
  );
}

export function useImpersonation() {
  return useContext(ImpersonationContext);
}
