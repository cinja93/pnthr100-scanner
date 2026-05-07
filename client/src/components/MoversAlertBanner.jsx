// MoversAlertBanner — top-of-app banner for fresh BL+1/SS+1 signals on a
// PNTHR Mover. Triggers when a ticker is BOTH in the Movers list AND has a
// brand-new (this-week) signal in the matching direction:
//   - BL+1 must appear in the GAINERS column (intraday % up)
//   - SS+1 must appear in the DECLINERS column (intraday % down)
//
// Polls /api/pulse/movers every 60s. Dismissals are per-device via
// localStorage (key: pnthr.moversAlerts.dismissed.YYYY-MM-DD).

import { useEffect, useState } from 'react';
import { useAuth } from '../AuthContext';
import { fetchMovers } from '../services/api';

const POLL_MS = 60 * 1000;

function todayKey() {
  return `pnthr.moversAlerts.dismissed.${new Date().toISOString().slice(0, 10)}`;
}

function loadDismissed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(todayKey()) || '[]'));
  } catch {
    return new Set();
  }
}

function saveDismissed(set) {
  try { localStorage.setItem(todayKey(), JSON.stringify([...set])); } catch {}
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

export default function MoversAlertBanner() {
  const { currentUser } = useAuth() || {};
  const [alerts, setAlerts] = useState([]);
  const [dismissed, setDismissed] = useState(() => loadDismissed());
  const [hidden, setHidden] = useState(false);

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

  if (!currentUser || hidden) return null;
  const visible = alerts.filter(a => !dismissed.has(a.id));
  if (visible.length === 0) return null;

  const newest = visible[0];
  const restCount = visible.length - 1;
  const restTickers = visible.slice(1).map(m => m.ticker);
  const isBL = newest.signal === 'BL+1';

  function dismissOne() {
    const next = new Set(dismissed);
    next.add(newest.id);
    setDismissed(next);
    saveDismissed(next);
  }

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9998,
      background: '#fcf000', color: '#000',
      padding: '10px 16px',
      borderBottom: '2px solid #000',
      boxShadow: '0 2px 12px rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 18 }}>📈</span>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 13, letterSpacing: '0.04em' }}>
            ${newest.ticker} — PNTHR MOVER — {newest.signal}
          </div>
          <div style={{ fontSize: 12, opacity: 0.85 }}>
            {isBL
              ? `Fresh BL signal in gainers (${newest.changePct >= 0 ? '+' : ''}${newest.changePct?.toFixed(2)}% today)`
              : `Fresh SS signal in decliners (${newest.changePct?.toFixed(2)}% today)`}
          </div>
        </div>
        {restCount > 0 && (
          <span style={{
            background: '#000', color: '#fcf000', fontWeight: 800, fontSize: 11,
            padding: '2px 8px', borderRadius: 10, marginLeft: 8,
            whiteSpace: 'nowrap',
          }}>+ {restTickers.join(', ')}</span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
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
          title="Hide banner for this session"
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
