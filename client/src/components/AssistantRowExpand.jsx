// client/src/components/AssistantRowExpand.jsx
// ── Click-to-expand row detail panel for Assistant LIVE table ───────────────
//
// Day 1 UI consolidation: when a user clicks a row in the LIVE table, this
// panel opens inline below it, showing per-position detail that previously
// required navigating to PNTHR Command Center:
//
//   • Lot 1-5 status grid (read-only; full edit still in Command Center)
//   • Last 5 stop ratchet history entries + "Show all" reveal
//   • Exits list (each partial sell / close)
//   • Action row: [Close Position] + [Open in Command Center] deep link
//
// The existing inline EditableCell components in AssistantLiveTable continue
// to handle quick edits to shares / direction / stop price / avg cost — those
// don't move into the expand panel.
//
// Notes field and full lot-fill controls are deferred to Day 2 (need either
// a new server endpoint for position notes, or per-lot patch endpoints + the
// auto-ratchet modal flow). Until then this panel is read-mostly.
//
// Props:
//   position    — the pnthr_portfolio doc for this row's ticker
//   onClose     — collapse the panel (parent controls expanded state)
//   onPositionChanged — called after a write succeeds so parent can refetch
//   onOpenChart — optional, opens chart modal for this ticker

import { useState, useMemo } from 'react';
import { API_BASE, authHeaders } from '../services/api';

const LOT_NAMES = ['The Scent', 'The Stalk', 'The Strike', 'The Shadow', 'The Slumber'];
const LOT_PCTS  = [35, 25, 20, 12, 8];

function fmtMoney(n) {
  if (n == null || !Number.isFinite(+n)) return '—';
  return `$${(+n).toFixed(2)}`;
}
function fmtDate(s) {
  if (!s) return '—';
  try { return new Date(s).toISOString().slice(0, 10); } catch { return String(s).slice(0, 10); }
}
function fmtDateTime(s) {
  if (!s) return '—';
  try { return new Date(s).toISOString().slice(0, 16).replace('T', ' '); } catch { return String(s); }
}

export default function AssistantRowExpand({ position, onClose, onPositionChanged, onOpenChart }) {
  const [showAllStops, setShowAllStops] = useState(false);
  const [closing, setClosing]           = useState(false);
  const [error, setError]               = useState(null);

  if (!position) return null;

  const isLong   = (position.direction || 'LONG').toUpperCase() !== 'SHORT';
  const fills    = position.fills || {};
  const exits    = Array.isArray(position.exits) ? position.exits : [];
  const stopHist = Array.isArray(position.stopHistory) ? position.stopHistory : [];

  const visibleStops = showAllStops
    ? stopHist
    : stopHist.slice(-5);

  // Total filled / exited / remaining — used by both the lot grid and the
  // exits header.
  const totals = useMemo(() => {
    let totalFilled = 0;
    for (let i = 1; i <= 5; i++) {
      const f = fills[i];
      if (f?.filled) totalFilled += +f.shares || 0;
    }
    const totalExited = exits.reduce((s, e) => s + (+e.shares || 0), 0);
    return { totalFilled, totalExited, remaining: Math.max(0, totalFilled - totalExited) };
  }, [fills, exits]);

  async function handleClosePosition() {
    if (closing) return;
    if (!window.confirm(`Close ${position.ticker} at market? This records a canonical exit through recordExit.`)) return;
    setClosing(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/api/positions/close`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionId: position.id, exitReason: 'MANUAL' }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
      await onPositionChanged?.();
      onClose?.();
    } catch (e) {
      setError(e.message || 'Close failed');
      setClosing(false);
    }
  }

  // Section header style
  const sh = {
    fontSize: 10, fontWeight: 800, letterSpacing: '0.1em',
    color: '#FCF000', marginBottom: 6, textTransform: 'uppercase',
  };

  return (
    <div style={{
      background: 'rgba(252,240,0,0.03)',
      border: '1px solid rgba(252,240,0,0.18)',
      borderRadius: 6,
      padding: 14,
      margin: '6px 0 14px 0',
      color: '#e6e6e6',
      fontFamily: "'Inter', 'Segoe UI', sans-serif",
      fontSize: 12,
    }}>
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 800, fontFamily: 'monospace', color: '#FCF000' }}>{position.ticker}</span>
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 3,
            background: isLong ? 'rgba(40,167,69,0.18)' : 'rgba(220,53,69,0.18)',
            border: `1px solid ${isLong ? '#28a745' : '#dc3545'}`,
            color: isLong ? '#28a745' : '#dc3545',
          }}>{isLong ? 'LONG' : 'SHORT'}</span>
          <span style={{ fontSize: 11, color: '#888' }}>
            {totals.totalFilled} sh filled · {totals.totalExited} exited · {totals.remaining} remaining
          </span>
          {position.sector && position.sector !== '—' && (
            <span style={{ fontSize: 10, color: '#666' }}>{position.sector}</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {onOpenChart && (
            <button
              type="button"
              onClick={() => onOpenChart(position.ticker)}
              style={{
                padding: '4px 10px', background: 'transparent',
                border: '1px solid rgba(255,255,255,0.2)',
                color: '#aaa', borderRadius: 4, fontSize: 10, cursor: 'pointer',
                letterSpacing: '0.05em',
              }}
            >CHART</button>
          )}
          <button
            type="button"
            onClick={() => onClose?.()}
            style={{
              padding: '4px 10px', background: 'transparent',
              border: '1px solid rgba(255,255,255,0.2)',
              color: '#aaa', borderRadius: 4, fontSize: 10, cursor: 'pointer',
              letterSpacing: '0.05em',
            }}
          >COLLAPSE ✕</button>
        </div>
      </div>

      {/* 3-column layout: lots | stop history | exits */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr', gap: 16 }}>

        {/* ── Lot 1-5 grid ───────────────────────────────────────────────── */}
        <div>
          <div style={sh}>Lots (Tier A · 35-25-20-12-8)</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: 'monospace' }}>
            <thead>
              <tr style={{ color: '#666', fontSize: 9, textTransform: 'uppercase' }}>
                <th style={{ textAlign: 'left',  padding: '3px 4px', fontWeight: 600 }}>#</th>
                <th style={{ textAlign: 'left',  padding: '3px 4px', fontWeight: 600 }}>Name</th>
                <th style={{ textAlign: 'right', padding: '3px 4px', fontWeight: 600 }}>%</th>
                <th style={{ textAlign: 'right', padding: '3px 4px', fontWeight: 600 }}>Shares</th>
                <th style={{ textAlign: 'right', padding: '3px 4px', fontWeight: 600 }}>Fill</th>
                <th style={{ textAlign: 'right', padding: '3px 4px', fontWeight: 600 }}>Date</th>
              </tr>
            </thead>
            <tbody>
              {[1, 2, 3, 4, 5].map(n => {
                const f = fills[n] || {};
                const filled = !!f.filled;
                return (
                  <tr key={n} style={{
                    background: filled ? (n === 1 ? 'rgba(252,240,0,0.06)' : 'rgba(40,167,69,0.05)') : 'transparent',
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                    color: filled ? '#e6e6e6' : '#555',
                  }}>
                    <td style={{ padding: '5px 4px', fontWeight: 700, color: filled ? '#FCF000' : '#444' }}>#{n}</td>
                    <td style={{ padding: '5px 4px', fontFamily: 'sans-serif', fontSize: 10 }}>{LOT_NAMES[n - 1]}</td>
                    <td style={{ padding: '5px 4px', textAlign: 'right', color: '#666' }}>{LOT_PCTS[n - 1]}%</td>
                    <td style={{ padding: '5px 4px', textAlign: 'right' }}>{filled ? (+f.shares || 0) : '—'}</td>
                    <td style={{ padding: '5px 4px', textAlign: 'right' }}>{filled ? fmtMoney(f.price) : '—'}</td>
                    <td style={{ padding: '5px 4px', textAlign: 'right', color: '#888' }}>{filled ? fmtDate(f.date) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ marginTop: 6, fontSize: 10, color: '#666' }}>
            Lot fill / edit lives in Command Center for now — full controls move here in Day 2.
          </div>
        </div>

        {/* ── Stop history ─────────────────────────────────────────────────── */}
        <div>
          <div style={{ ...sh, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Stop History {stopHist.length > 0 && <span style={{ color: '#888', fontWeight: 400 }}>({stopHist.length})</span>}</span>
            {stopHist.length > 5 && (
              <button
                type="button"
                onClick={() => setShowAllStops(s => !s)}
                style={{
                  background: 'transparent', border: 'none', color: '#aaa',
                  fontSize: 9, cursor: 'pointer', textDecoration: 'underline',
                  letterSpacing: '0.05em',
                }}
              >{showAllStops ? 'SHOW LAST 5' : `SHOW ALL ${stopHist.length}`}</button>
            )}
          </div>
          {stopHist.length === 0 ? (
            <div style={{ fontSize: 11, color: '#555', fontStyle: 'italic' }}>No stop history yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: showAllStops ? 240 : 'none', overflowY: showAllStops ? 'auto' : 'visible' }}>
              {visibleStops.slice().reverse().map((h, i) => (
                <div key={i} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  fontSize: 10, fontFamily: 'monospace',
                  padding: '3px 6px',
                  background: h.reason === 'USER_TIGHTENED_VIA_TWS' ? 'rgba(252,240,0,0.06)' : 'rgba(255,255,255,0.02)',
                  borderRadius: 3,
                  borderLeft: `2px solid ${h.reason === 'USER_TIGHTENED_VIA_TWS' ? '#FCF000' : 'rgba(255,255,255,0.1)'}`,
                }}>
                  <div>
                    <span style={{ color: '#FCF000', fontWeight: 700 }}>{fmtMoney(h.stop)}</span>
                    {h.from != null && (
                      <span style={{ color: '#666', marginLeft: 6 }}>
                        ← {fmtMoney(h.from)}
                      </span>
                    )}
                  </div>
                  <div>
                    <span style={{ color: '#888' }}>{fmtDate(h.date)}</span>
                    <span style={{ color: '#555', marginLeft: 6, fontSize: 9 }}>{h.reason || '—'}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Exits list ───────────────────────────────────────────────────── */}
        <div>
          <div style={sh}>Exits {exits.length > 0 && <span style={{ color: '#888', fontWeight: 400 }}>({exits.length})</span>}</div>
          {exits.length === 0 ? (
            <div style={{ fontSize: 11, color: '#555', fontStyle: 'italic' }}>No exits recorded.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 240, overflowY: 'auto' }}>
              {exits.slice().reverse().map((e, i) => {
                const pnlPct = e.pnl?.pct ?? e.pnlPct ?? null;
                const pnlDol = e.pnl?.dollar ?? e.pnlDollar ?? null;
                const pos = pnlPct == null ? null : pnlPct >= 0;
                return (
                  <div key={e.id || i} style={{
                    fontSize: 10, fontFamily: 'monospace',
                    padding: '4px 6px',
                    background: 'rgba(255,255,255,0.02)',
                    borderRadius: 3,
                    borderLeft: `2px solid ${pos == null ? 'rgba(255,255,255,0.1)' : (pos ? '#28a745' : '#dc3545')}`,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>{(+e.shares || 0)} sh @ {fmtMoney(e.price)}</span>
                      <span style={{ color: '#888' }}>{fmtDateTime(e.date || e.exitedAt)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2, color: '#666' }}>
                      <span style={{ color: e.reason === 'STOP_HIT' ? '#dc3545' : '#888' }}>{e.reason || 'MANUAL'}</span>
                      {pnlPct != null && (
                        <span style={{ color: pos ? '#28a745' : '#dc3545' }}>
                          {pnlPct >= 0 ? '+' : ''}{(+pnlPct).toFixed(2)}%
                          {pnlDol != null && ` · ${pnlDol >= 0 ? '+' : ''}$${Math.abs(+pnlDol).toFixed(0)}`}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Action row */}
      <div style={{
        marginTop: 14, paddingTop: 12,
        borderTop: '1px solid rgba(255,255,255,0.06)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
      }}>
        <div style={{ fontSize: 10, color: '#666' }}>
          Inline edits (shares · direction · stop · avg cost) work directly in the row above.
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <a
            href={`/?page=command&ticker=${encodeURIComponent(position.ticker)}`}
            style={{
              padding: '5px 12px',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.15)',
              color: '#aaa', borderRadius: 4, fontSize: 10,
              textDecoration: 'none', letterSpacing: '0.05em',
            }}
          >OPEN IN COMMAND CENTER</a>
          <button
            type="button"
            onClick={handleClosePosition}
            disabled={closing || totals.remaining === 0}
            style={{
              padding: '5px 14px',
              background: closing ? 'rgba(220,53,69,0.5)' : 'rgba(220,53,69,0.15)',
              border: '1px solid #dc3545',
              color: '#dc3545', borderRadius: 4, fontSize: 10, fontWeight: 700,
              cursor: closing || totals.remaining === 0 ? 'wait' : 'pointer',
              letterSpacing: '0.05em',
            }}
          >{closing ? 'CLOSING…' : totals.remaining === 0 ? 'ALREADY CLOSED' : 'CLOSE POSITION'}</button>
        </div>
      </div>

      {error && (
        <div style={{
          marginTop: 8, padding: '6px 10px',
          background: 'rgba(220,53,69,0.1)',
          border: '1px solid rgba(220,53,69,0.4)',
          borderRadius: 4, color: '#dc3545',
          fontSize: 11, fontWeight: 600,
        }}>{error}</div>
      )}
    </div>
  );
}
