// MoversAlertBanner — top-of-app banner for fresh BL+1/SS+1 signals on
// PNTHR Movers. Static "PNTHR MOVERS" header with all tickers as badges.

import { useEffect, useState } from 'react';
import { useAuth } from '../AuthContext';
import { fetchMovers } from '../services/api';

const POLL_MS = 60 * 1000;

function todayKey() {
  return `pnthr.moversAlerts.dismissed.${new Date().toISOString().slice(0, 10)}`;
}

function loadDismissed() {
  try {
    return JSON.parse(localStorage.getItem(todayKey()) || 'false');
  } catch {
    return false;
  }
}

function saveDismissed(val) {
  try { localStorage.setItem(todayKey(), JSON.stringify(val)); } catch {}
}

function buildAlerts(movers) {
  if (!movers) return [];
  const out = [];
  const seen = new Set();
  const push = (r, kind) => {
    if (!r || seen.has(r.ticker)) return;
    if (r.signalLabel === 'BL+1' && kind === 'gainer') {
      out.push({ id: `${r.ticker}-BL`, ticker: r.ticker, signal: 'BL+1', changePct: r.changePct });
      seen.add(r.ticker);
    } else if (r.signalLabel === 'SS+1' && kind === 'decliner') {
      out.push({ id: `${r.ticker}-SS`, ticker: r.ticker, signal: 'SS+1', changePct: r.changePct });
      seen.add(r.ticker);
    }
  };
  for (const r of movers.stocks?.gainers   || []) push(r, 'gainer');
  for (const r of movers.stocks?.decliners || []) push(r, 'decliner');
  for (const r of movers.etfs?.gainers     || []) push(r, 'gainer');
  for (const r of movers.etfs?.decliners   || []) push(r, 'decliner');
  return out;
}

export const MOVERS_BANNER_HEIGHT = 44;

export default function MoversAlertBanner({ onTickerClick, onVisibleChange, topOffset = 0 }) {
  const { currentUser } = useAuth() || {};
  const [alerts, setAlerts] = useState([]);
  const [hidden, setHidden] = useState(() => loadDismissed());

  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    const load = () => fetchMovers()
      .then(d => { if (!cancelled) setAlerts(buildAlerts(d)); })
      .catch(() => {});
    load();
    const id = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [currentUser]);

  const visible = !!(currentUser && !hidden && alerts.length > 0);
  useEffect(() => { onVisibleChange?.(visible); }, [visible]);

  if (!visible) return null;

  return (
    <div style={{
      position: 'fixed', top: topOffset, left: 0, right: 0, zIndex: 9998,
      background: '#fcf000', color: '#000',
      padding: '10px 16px',
      borderBottom: '2px solid #000',
      boxShadow: '0 2px 12px rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 0 }}>
        <span style={{ fontWeight: 900, fontSize: 13, letterSpacing: '0.08em', whiteSpace: 'nowrap' }}>
          PNTHR MOVERS
        </span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {alerts.map(a => {
            const isBL = a.signal === 'BL+1';
            return (
              <button
                key={a.id}
                onClick={() => onTickerClick?.(a.ticker)}
                title={`Open ${a.ticker} chart`}
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                  background: isBL ? '#16a34a' : '#dc2626',
                  color: '#fff', fontWeight: 800, fontSize: 12,
                  padding: '4px 12px 3px', borderRadius: 5,
                  cursor: 'pointer', border: 'none',
                  letterSpacing: '0.04em', lineHeight: 1.3,
                }}
              >
                <span>{a.ticker} {a.signal}</span>
                <span style={{ fontSize: 10, fontWeight: 700, opacity: 0.9 }}>
                  {a.changePct >= 0 ? '+' : ''}{a.changePct?.toFixed(2)}%
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <button
        onClick={() => { setHidden(true); saveDismissed(true); }}
        title="Dismiss movers banner for today"
        style={{
          background: '#000', color: '#fcf000',
          border: 'none', borderRadius: 4,
          padding: '4px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
          marginLeft: 8,
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
