// TrendlineAlertBanner — top-of-app banner that surfaces fresh trendline
// breaks. Polls /api/test/trendline-alerts every 30s. Shows the most recent
// undismissed alert as a yellow PNTHR-themed banner across the top of the
// app. Click "Dismiss" to remove (calls PATCH /dismiss server-side). The
// PNTHR Assistant card still shows the full undismissed history for review.
//
// Admin-only — non-admin users see nothing (matches the per-user trendline
// model where only the admin draws lines).

import { useEffect, useState } from 'react';
import { useAuth } from '../AuthContext';
import { fetchTrendlineAlerts, dismissTrendlineAlert } from '../services/api';

const POLL_MS = 30 * 1000;

export default function TrendlineAlertBanner({ onNavigateToAssistant }) {
  const { isAdmin } = useAuth() || {};
  const [alerts, setAlerts] = useState([]);
  const [hidden, setHidden] = useState(false);   // collapse banner manually

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    const load = () => fetchTrendlineAlerts()
      .then(d => { if (!cancelled) setAlerts(d.alerts || []); })
      .catch(() => {});
    load();
    const id = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [isAdmin]);

  if (!isAdmin || hidden || alerts.length === 0) return null;

  const newest = alerts[0];
  const restCount = alerts.length - 1;

  async function dismissOne() {
    setAlerts(prev => prev.filter(a => a._id !== newest._id));
    try { await dismissTrendlineAlert(newest._id); }
    catch (e) { console.error(e); }
  }

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
      background: '#fcf000', color: '#000',
      padding: '10px 16px',
      borderBottom: '2px solid #000',
      boxShadow: '0 2px 12px rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 18 }}>🔔</span>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 13, letterSpacing: '0.04em' }}>
            TRENDLINE BROKEN — ${newest.ticker}
          </div>
          <div style={{ fontSize: 12, opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {newest.message?.startsWith('$') ? newest.message : `$${newest.ticker} broke ${newest.breakDirection?.toUpperCase()} at $${newest.breakPrice?.toFixed(2)} (line: $${newest.lineValue?.toFixed(2)})`}
          </div>
        </div>
        {restCount > 0 && (
          <span style={{
            background: '#000', color: '#fcf000', fontWeight: 800, fontSize: 11,
            padding: '2px 8px', borderRadius: 10, marginLeft: 8,
          }}>+{restCount} more</span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {onNavigateToAssistant && (
          <button
            onClick={() => { onNavigateToAssistant(); }}
            style={{
              background: 'transparent', color: '#000',
              border: '1.5px solid #000', borderRadius: 4,
              padding: '4px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
            }}
          >
            View on Assistant
          </button>
        )}
        <button
          onClick={dismissOne}
          style={{
            background: '#000', color: '#fcf000',
            border: '1.5px solid #000', borderRadius: 4,
            padding: '4px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
          }}
        >
          Dismiss
        </button>
        <button
          onClick={() => setHidden(true)}
          title="Hide banner (alerts still in PNTHR Assistant)"
          style={{
            background: 'transparent', color: '#000', border: 'none',
            fontSize: 18, lineHeight: 1, cursor: 'pointer', padding: '0 4px',
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}
