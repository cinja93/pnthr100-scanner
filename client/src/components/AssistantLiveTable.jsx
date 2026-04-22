// client/src/components/AssistantLiveTable.jsx
// ── PNTHR Assistant LIVE — source-of-truth reconciliation table ──────────────
//
// One row per ticker (union of IBKR positions + IBKR working stops + Command
// Center portfolio). Each cell compares IBKR vs Command and shows a colored
// dot: green = aligned, yellow = attention soon, red = fix now, gray = N/A.
//
// Clicking a non-green cell either deep-links into Command Center (if the fix
// is in-app) or shows an IBKR instruction (if the fix is manual in TWS).
//
// Data source: GET /api/assistant/live-reconcile (every 60s).

import { useState, useEffect, useCallback } from 'react';
import { API_BASE, authHeaders } from '../services/api';

const REFRESH_MS = 60_000;

const DOT_COLOR = {
  green:  '#28a745',
  yellow: '#ffc107',
  red:    '#dc3545',
  gray:   '#555',
};

const fmtMoney  = (v) => v == null ? '—' : `$${(+v).toFixed(2)}`;
const fmtShares = (v) => v == null ? '—' : `${+v}`;
const fmtTime   = (iso) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
      timeZone: 'America/New_York',
    });
  } catch { return '—'; }
};

// ── Dot primitive ────────────────────────────────────────────────────────────
function Dot({ status, title }) {
  const c = DOT_COLOR[status] || DOT_COLOR.gray;
  return (
    <span
      title={title}
      style={{
        display: 'inline-block',
        width: 8, height: 8, borderRadius: '50%',
        background: c, marginRight: 6, verticalAlign: 'middle',
      }}
    />
  );
}

// ── Cell with built-in color dot + click behavior ────────────────────────────
function Cell({ check, children, onClick }) {
  const status    = check?.status || 'gray';
  const clickable = onClick && status !== 'green' && status !== 'gray';
  return (
    <td
      onClick={clickable ? onClick : undefined}
      style={{
        padding: '8px 10px',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        cursor: clickable ? 'pointer' : 'default',
        color: '#e6e6e6',
        fontSize: 13,
        whiteSpace: 'nowrap',
      }}
      title={check?.reason || ''}
    >
      <Dot status={status} title={check?.reason} />
      {children}
    </td>
  );
}

// ── Action modal (IBKR instructions for cells that need manual fixing) ───────
function ActionModal({ row, onClose }) {
  if (!row) return null;
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
        zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#111', border: '1px solid rgba(252,240,0,0.3)',
          borderRadius: 8, padding: 20, minWidth: 420, maxWidth: 560,
          color: '#e6e6e6', fontFamily: "'Inter', 'Segoe UI', sans-serif",
        }}
      >
        <div style={{
          color: '#FCF000', fontWeight: 900, fontSize: 14,
          letterSpacing: '0.1em', marginBottom: 12,
        }}>
          {row.ticker} — ACTION REQUIRED
        </div>
        {row.actions.length === 0 && (
          <div style={{ opacity: 0.7 }}>No actions available for this row.</div>
        )}
        {row.actions.map((a, i) => (
          <div
            key={i}
            style={{
              padding: '10px 12px',
              background: a.type === 'ibkr' ? 'rgba(220,53,69,0.08)' : 'rgba(40,167,69,0.08)',
              border: `1px solid ${a.type === 'ibkr' ? 'rgba(220,53,69,0.35)' : 'rgba(40,167,69,0.35)'}`,
              borderRadius: 6, marginBottom: 8,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 4 }}>
              {a.type === 'ibkr' ? '🔗 MANUAL — IN IBKR' : '→ IN COMMAND CENTER'}
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{a.label}</div>
            {a.instruction && (
              <div style={{
                fontSize: 12, fontFamily: 'Menlo, monospace',
                background: 'rgba(0,0,0,0.4)', padding: '6px 8px', borderRadius: 4,
              }}>
                {a.instruction}
              </div>
            )}
          </div>
        ))}
        <button
          onClick={onClose}
          style={{
            marginTop: 4, padding: '6px 14px',
            background: 'transparent', border: '1px solid rgba(255,255,255,0.2)',
            color: '#e6e6e6', borderRadius: 4, cursor: 'pointer', fontSize: 12,
          }}
        >Close</button>
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────
export default function AssistantLiveTable({ onNavigate }) {
  const [data,      setData]      = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);
  const [modalRow,  setModalRow]  = useState(null);
  const [collapsed, setCollapsed] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const r = await fetch(`${API_BASE}/api/assistant/live-reconcile`, { headers: authHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setData(d);
    } catch (e) {
      setError(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const iv = setInterval(fetchData, REFRESH_MS);
    return () => clearInterval(iv);
  }, [fetchData]);

  const handleCellClick = (row) => {
    if (!row.actions?.length) return;
    const appAction = row.actions.find(a => a.type === 'app');
    if (appAction?.route && onNavigate) {
      onNavigate(appAction.route);
      return;
    }
    setModalRow(row);
  };

  // Styling
  const s = {
    container: {
      border: '1px solid rgba(252, 240, 0, 0.3)',
      borderRadius: 8, padding: 0, marginBottom: 16,
      background: 'rgba(252, 240, 0, 0.01)',
    },
    headerBar: {
      padding: '7px 14px 5px',
      borderBottom: '1px solid rgba(252, 240, 0, 0.12)',
      display: 'flex', alignItems: 'center', gap: 12,
      cursor: 'pointer', userSelect: 'none',
    },
    title: {
      color: '#FCF000', fontWeight: 900, fontSize: 10, letterSpacing: '0.14em',
      fontFamily: "'Inter', 'Segoe UI', sans-serif",
    },
    spacer: { flex: 1, height: 1, background: 'linear-gradient(90deg, rgba(252,240,0,0.15), transparent 80%)' },
    meta: { fontSize: 10, color: 'rgba(255,255,255,0.5)' },
    pill: (color) => ({
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 10,
      background: `${color}22`, border: `1px solid ${color}55`,
      color, fontSize: 10, fontWeight: 700, letterSpacing: '0.05em',
    }),
    tableWrap: { padding: '8px 6px 6px', overflowX: 'auto' },
    table:     { width: '100%', borderCollapse: 'collapse', minWidth: 1100 },
    th: {
      padding: '6px 10px', textAlign: 'left', fontSize: 10, fontWeight: 800,
      letterSpacing: '0.08em', color: 'rgba(255,255,255,0.6)',
      borderBottom: '1px solid rgba(255,255,255,0.15)', whiteSpace: 'nowrap',
    },
    ticker: { fontWeight: 800, letterSpacing: '0.04em' },
    rowRed:    { background: 'rgba(220,53,69,0.04)' },
    rowYellow: { background: 'rgba(255,193,7,0.03)' },
  };

  const body = () => {
    if (loading && !data) return <div style={{ padding: 20, opacity: 0.6 }}>Loading reconciliation…</div>;
    if (error) return <div style={{ padding: 20, color: '#dc3545' }}>Error: {error}</div>;
    if (!data?.rows?.length) return <div style={{ padding: 20, opacity: 0.6 }}>No positions or stops to reconcile.</div>;

    return (
      <div style={s.tableWrap}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}></th>
              <th style={s.th}>TICKER</th>
              <th style={s.th}>DIR</th>
              <th style={s.th}>SHARES (IBKR / CMD)</th>
              <th style={s.th}>AVG (IBKR / CMD)</th>
              <th style={s.th}>LAST</th>
              <th style={s.th}>STOP SIDE</th>
              <th style={s.th}>STOP PRICE (IBKR / CMD)</th>
              <th style={s.th}>STOP SHR (IBKR / CMD)</th>
              <th style={s.th}>NEXT RATCHET</th>
              <th style={s.th}>ACTION</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map(row => {
              const rs = row.rowStatus;
              const rowBg = rs === 'red' ? s.rowRed : rs === 'yellow' ? s.rowYellow : undefined;
              const c     = row.checks || {};
              const ibStops = row.ibkr?.stops || [];
              const stopPriceStr = ibStops.length
                ? ibStops.map(o => fmtMoney(o.price)).join(', ')
                : '—';
              const stopShrStr = ibStops.length
                ? ibStops.map(o => fmtShares(o.shares)).join(', ')
                : '—';
              const stopSideStr = ibStops.length
                ? [...new Set(ibStops.map(o => o.side))].join('+')
                : '—';
              return (
                <tr key={row.ticker} style={rowBg}>
                  <td style={{ padding: '8px 4px 8px 10px', width: 18 }}>
                    <Dot status={rs} title={`Row status: ${rs}`} />
                  </td>
                  <td style={{ padding: '8px 10px', ...s.ticker, color: '#fff' }}>
                    {row.ticker}
                    {row.multiStop && (
                      <span style={{
                        marginLeft: 6, padding: '1px 5px', borderRadius: 3,
                        background: 'rgba(255,193,7,0.15)', color: '#ffc107',
                        fontSize: 9, fontWeight: 800,
                      }}>
                        {ibStops.length} STOPS
                      </span>
                    )}
                  </td>
                  <Cell check={c.direction}>
                    {row.command.direction || row.ibkr.direction || '—'}
                  </Cell>
                  <Cell check={c.shares} onClick={() => handleCellClick(row)}>
                    {fmtShares(row.ibkr.shares)} / {fmtShares(row.command.shares)}
                  </Cell>
                  <Cell check={c.avg} onClick={() => handleCellClick(row)}>
                    {fmtMoney(row.ibkr.avgCost)} / {fmtMoney(row.command.avgCost)}
                  </Cell>
                  <td style={{ padding: '8px 10px', fontSize: 13, color: '#e6e6e6', whiteSpace: 'nowrap' }}>
                    {fmtMoney(row.lastPrice)}
                  </td>
                  <Cell check={c.stopSide}>{stopSideStr}</Cell>
                  <Cell check={c.stopPrice} onClick={() => handleCellClick(row)}>
                    {stopPriceStr} / {fmtMoney(row.command.stopPrice)}
                  </Cell>
                  <Cell check={c.stopShares} onClick={() => handleCellClick(row)}>
                    {stopShrStr} / {fmtShares(row.command.shares)}
                  </Cell>
                  <Cell check={c.ratchet} onClick={() => handleCellClick(row)}>
                    {row.nextRatchet ? fmtMoney(row.nextRatchet) : '—'}
                    {row.ratchetLabel && (
                      <span style={{ opacity: 0.6, fontSize: 11, marginLeft: 4 }}>({row.ratchetLabel})</span>
                    )}
                  </Cell>
                  <td style={{ padding: '8px 10px' }}>
                    {row.actions.length > 0 && (
                      <button
                        onClick={() => handleCellClick(row)}
                        style={{
                          padding: '3px 8px',
                          background: rs === 'red' ? '#dc3545' : '#ffc107',
                          color: rs === 'red' ? '#fff' : '#000',
                          border: 'none', borderRadius: 4,
                          fontSize: 10, fontWeight: 800, letterSpacing: '0.05em',
                          cursor: 'pointer',
                        }}
                      >
                        FIX
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  const summary = data?.summary || { red: 0, yellow: 0, green: 0, total: 0 };

  return (
    <div style={s.container}>
      <div style={s.headerBar} onClick={() => setCollapsed(v => !v)}>
        <span style={{ fontSize: 11, color: '#FCF000' }}>{collapsed ? '▶' : '▼'}</span>
        <span style={s.title}>PNTHR ASSISTANT LIVE — SOURCE OF TRUTH</span>
        {summary.red > 0    && <span style={s.pill(DOT_COLOR.red)}>    ● {summary.red} TO FIX</span>}
        {summary.yellow > 0 && <span style={s.pill(DOT_COLOR.yellow)}> ● {summary.yellow} WATCHING</span>}
        {summary.green > 0  && <span style={s.pill(DOT_COLOR.green)}>  ● {summary.green} ALIGNED</span>}
        {(summary.red === 0 && summary.yellow === 0 && summary.total > 0) && (
          <span style={{ ...s.pill(DOT_COLOR.green), background: `${DOT_COLOR.green}33` }}>
            ✓ ALL ALIGNED
          </span>
        )}
        <span style={s.spacer} />
        <span style={s.meta}>
          last sync: {fmtTime(data?.lastSyncedAt)}
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); fetchData(); }}
          style={{
            padding: '3px 10px',
            background: 'rgba(252,240,0,0.1)',
            color: '#FCF000',
            border: '1px solid rgba(252,240,0,0.3)',
            borderRadius: 4, fontSize: 10, fontWeight: 800,
            cursor: 'pointer', letterSpacing: '0.05em',
          }}
        >↺ REFRESH</button>
      </div>
      {!collapsed && body()}
      <ActionModal row={modalRow} onClose={() => setModalRow(null)} />
    </div>
  );
}
