// client/src/components/ImpersonationBanner.jsx
// ── Admin-only impersonation banner ─────────────────────────────────────────
//
// Renders a fixed red bar across the top of the app ONLY when the current
// tab is in an impersonation session (ImpersonationContext). The banner
// carries a blue "Return to Admin" button that stops the session and closes
// the tab.
//
// Critical: this component renders nothing when isImpersonating is false.
// A normal user logging in sees NO banner, NO button, NO impersonation UI
// whatsoever. There is no code path that surfaces this UI to anyone other
// than the admin actively impersonating.

import { useState } from 'react';
import { useImpersonation, clearImpersonationToken } from '../contexts/ImpersonationContext';
import { stopImpersonation } from '../services/api';

export default function ImpersonationBanner() {
  const { isImpersonating, targetDisplayName } = useImpersonation();
  const [exiting, setExiting] = useState(false);

  if (!isImpersonating) return null;

  const handleExit = async () => {
    setExiting(true);
    try {
      // Best-effort audit write; never block exit on network failure.
      await stopImpersonation().catch(() => {});
    } finally {
      clearImpersonationToken();
      // Try to close the preview tab first (only works if it was opened via
      // window.open). If the browser blocks close, fall back to navigating
      // to the app root — with sessionStorage cleared, the app will pick up
      // the admin's localStorage token automatically.
      try { window.close(); } catch { /* ignore */ }
      setTimeout(() => {
        if (!window.closed) {
          window.location.href = window.location.origin + '/';
        }
      }, 200);
    }
  };

  return (
    <div
      role="alert"
      style={{
        position:     'fixed',
        top:          0,
        left:         0,
        right:        0,
        zIndex:       100000,
        background:   '#dc3545',
        color:        '#fff',
        padding:      '8px 16px',
        display:      'flex',
        alignItems:   'center',
        gap:          12,
        fontSize:     12,
        fontWeight:   700,
        letterSpacing: '0.06em',
        boxShadow:    '0 2px 12px rgba(0,0,0,0.6)',
      }}
    >
      <span style={{ fontSize: 14 }}>⚠</span>
      <span style={{ textTransform: 'uppercase', letterSpacing: '0.14em' }}>
        Viewing as {targetDisplayName}
      </span>
      <span style={{
        padding: '2px 8px',
        background: 'rgba(255,255,255,0.18)',
        border: '1px solid rgba(255,255,255,0.35)',
        borderRadius: 3,
        fontSize: 10,
        letterSpacing: '0.1em',
      }}>READ-ONLY</span>
      <span style={{ flex: 1 }} />
      <button
        onClick={handleExit}
        disabled={exiting}
        style={{
          background:   '#2563eb',
          color:        '#fff',
          border:       '1px solid #1e40af',
          padding:      '5px 14px',
          borderRadius: 4,
          fontWeight:   800,
          fontSize:     11,
          letterSpacing: '0.08em',
          cursor:       exiting ? 'wait' : 'pointer',
          opacity:      exiting ? 0.6 : 1,
        }}
      >
        {exiting ? 'Returning…' : '← Return to Admin'}
      </button>
    </div>
  );
}

// Fixed-height spacer so page content doesn't slide under the banner. The
// banner is ~36px tall with our padding; use 40 to be safe.
export const IMPERSONATION_BANNER_HEIGHT = 40;
