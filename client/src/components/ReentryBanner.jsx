// ReentryBanner — fixed top-of-app banner for daily re-entry opportunities.
// Fires when: weekly BL active + top-100 TTM rank + not held + daily 2-bar high breaks.
// Same visual pattern as MoversAlertBanner; purple color scheme.

import { useEffect, useState } from 'react';
import { useAuth } from '../AuthContext';
import { fetchReentrySignals } from '../services/api';

const POLL_MS = 60 * 1000;
const LS_KEY  = () => `pnthr.reentryBanner.dismissed.${new Date().toISOString().slice(0, 10)}`;

function loadDismissed() {
  try { return JSON.parse(localStorage.getItem(LS_KEY()) || 'false'); } catch { return false; }
}
function saveDismissed(val) {
  try { localStorage.setItem(LS_KEY(), JSON.stringify(val)); } catch {}
}

export const REENTRY_BANNER_HEIGHT = 50;

export default function ReentryBanner({ onTickerClick, onVisibleChange, topOffset = 0 }) {
  const { currentUser } = useAuth() || {};
  const [signals, setSignals]   = useState([]);
  const [hidden, setHidden]     = useState(() => loadDismissed());

  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    const load = () =>
      fetchReentrySignals()
        .then(d => { if (!cancelled) setSignals(d?.signals || []); })
        .catch(() => {});
    load();
    const id = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [currentUser]);

  const visible = !!(currentUser && !hidden && signals.length > 0);
  useEffect(() => { onVisibleChange?.(visible); }, [visible]);

  if (!visible) return null;

  return (
    <div style={{
      position: 'fixed', top: topOffset, left: 0, right: 0, zIndex: 9997,
      background: '#7c3aed', color: '#fff',
      padding: '10px 16px',
      borderBottom: '2px solid #5b21b6',
      boxShadow: '0 2px 12px rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 0 }}>
        <span style={{ fontWeight: 900, fontSize: 13, letterSpacing: '0.08em', whiteSpace: 'nowrap' }}>
          RE-ENTRY
        </span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {signals.map(s => (
            <button
              key={s.ticker}
              onClick={() => onTickerClick?.(s.ticker)}
              title={`${s.ticker} — Entry $${s.entryTrigger} | Stop $${s.weeklyStop} | RPS $${s.rps}`}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                background: '#5b21b6', color: '#fff', fontWeight: 800, fontSize: 12,
                padding: '4px 12px 3px', borderRadius: 5,
                cursor: 'pointer', border: '1px solid #7c3aed',
                letterSpacing: '0.04em', lineHeight: 1.3,
              }}
            >
              <span>{s.ticker} {s.fund === 'AI 300' ? '★' : ''}</span>
              <span style={{ fontSize: 10, fontWeight: 700, opacity: 0.85 }}>
                ${s.entryTrigger} | Stop ${s.weeklyStop}
              </span>
            </button>
          ))}
        </div>
      </div>
      <button
        onClick={() => { setHidden(true); saveDismissed(true); }}
        title="Dismiss re-entry banner for today"
        style={{
          marginLeft: 8,
          background: '#5b21b6', color: '#e9d5ff',
          border: 'none', borderRadius: 4,
          padding: '4px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
