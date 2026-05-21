// TrendlineAlertBanner — top-of-app banner that surfaces fresh trendline
// breaks as clickable ticker badges (matching PNTHR MOVERS style). Click a
// badge to open that ticker's chart. Polls /api/test/trendline-alerts every
// 30s. Admin-only — non-admin users see nothing.

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../AuthContext';
import { fetchTrendlineAlerts, dismissTrendlineAlert } from '../services/api';

const POLL_MS = 30 * 1000;

export const TRENDLINE_BANNER_HEIGHT = 50;

export default function TrendlineAlertBanner({ onTickerClick, onNavigateToAssistant, onVisibleChange }) {
  const { isAdmin } = useAuth() || {};
  const [alerts, setAlerts] = useState([]);
  const [hidden, setHidden] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const badgeRefs = useRef([]);

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

  const visible = !!(isAdmin && !hidden && alerts.length > 0);
  useEffect(() => { onVisibleChange?.(visible); }, [visible]);

  useEffect(() => {
    if (focusIdx >= 0 && badgeRefs.current[focusIdx]) {
      badgeRefs.current[focusIdx].scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
    }
  }, [focusIdx]);

  if (!visible) return null;

  async function dismissOne(alert, e) {
    e.stopPropagation();
    setAlerts(prev => prev.filter(a => a._id !== alert._id));
    try { await dismissTrendlineAlert(alert._id); } catch {}
  }

  function handleBadgeClick(alert, idx) {
    setFocusIdx(idx);
    onTickerClick?.(alert.ticker);
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 0 }}>
        <span style={{ fontWeight: 900, fontSize: 13, letterSpacing: '0.08em', whiteSpace: 'nowrap' }}>
          TRENDLINE BROKEN
        </span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {alerts.map((a, i) => {
            const isBelow = (a.breakDirection || '').toLowerCase() === 'below';
            return (
              <button
                key={a._id || `${a.ticker}-${i}`}
                ref={el => badgeRefs.current[i] = el}
                onClick={() => handleBadgeClick(a, i)}
                title={`${a.ticker} broke ${(a.breakDirection || '').toUpperCase()} at $${a.breakPrice?.toFixed(2)} (line: $${a.lineValue?.toFixed(2)})`}
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                  background: isBelow ? '#dc2626' : '#16a34a',
                  color: '#fff', fontWeight: 800, fontSize: 12,
                  padding: '4px 12px 3px', borderRadius: 5,
                  cursor: 'pointer', border: focusIdx === i ? '2px solid #fff' : 'none',
                  letterSpacing: '0.04em', lineHeight: 1.3,
                }}
              >
                <span>${a.ticker}</span>
                <span style={{ fontSize: 10, fontWeight: 700, opacity: 0.9 }}>
                  {(a.breakDirection || '').toUpperCase()} ${a.breakPrice ? `$${a.breakPrice.toFixed(2)}` : ''}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, marginLeft: 8 }}>
        {onNavigateToAssistant && (
          <button
            onClick={() => onNavigateToAssistant()}
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
          onClick={() => dismissOne(alerts[focusIdx] || alerts[0], { stopPropagation: () => {} })}
          style={{
            background: '#000', color: '#fcf000',
            border: 'none', borderRadius: 4,
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
