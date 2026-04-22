// client/src/components/AssistantLiveTable.jsx
// ── PNTHR Assistant LIVE — source-of-truth reconciliation table ──────────────
//
// THREE sub-rows per ticker (stacked vertically):
//   1. IBKR POS — what IBKR says you own (direction, shares, avg)
//   2. IBKR STP — the working stop order(s) in IBKR (one row per stop)
//   3. CMD      — what Command Center expects
//
// Cells have their own colored alignment dot. Same dot color appears in both
// participating rows of a column comparison (e.g. shares dot on IBKR POS and
// CMD rows reflects the same check).
//
// Click any non-green cell to fix (deep-link to Command or show IBKR instructions).
// Data source: GET /api/assistant/live-reconcile (60s auto-refresh).

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

// ── Status dot ───────────────────────────────────────────────────────────────
function Dot({ status, title, size = 8 }) {
  const c = DOT_COLOR[status] || DOT_COLOR.gray;
  return (
    <span
      title={title}
      style={{
        display: 'inline-block',
        width: size, height: size, borderRadius: '50%',
        background: c, marginRight: 6, verticalAlign: 'middle',
        flexShrink: 0,
      }}
    />
  );
}

// ── Single cell — has optional dot (via check) + value, optionally clickable ─
function Cell({ check, children, onClick, align = 'left', subtle = false, bottomBorder = false }) {
  const status    = check?.status || null;
  const clickable = onClick && status && status !== 'green' && status !== 'gray';
  return (
    <td
      onClick={clickable ? onClick : undefined}
      style={{
        padding: '4px 8px',
        borderBottom: bottomBorder ? '1px solid rgba(255,255,255,0.12)' : 'none',
        cursor: clickable ? 'pointer' : 'default',
        color: subtle ? 'rgba(255,255,255,0.35)' : '#e6e6e6',
        fontSize: 12,
        whiteSpace: 'nowrap',
        textAlign: align,
        fontVariantNumeric: 'tabular-nums',
      }}
      title={check?.reason || ''}
    >
      {status && <Dot status={status} title={check?.reason} />}
      {children}
    </td>
  );
}

// Empty placeholder cell (used on rows that have no value in this column)
function EmptyCell({ bottomBorder = false }) {
  return (
    <td
      style={{
        padding: '4px 8px',
        borderBottom: bottomBorder ? '1px solid rgba(255,255,255,0.12)' : 'none',
        color: 'rgba(255,255,255,0.2)',
        fontSize: 12,
        textAlign: 'center',
      }}
    >·</td>
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

// ── Build the 3+ sub-rows for one ticker ─────────────────────────────────────
// Returns an array: [IBKR_POS, IBKR_STP_1, ..., IBKR_STP_N, CMD]
// Each sub-row has the source label + values for every column (or null where N/A)
function buildSubRows(row) {
  const out = [];
  const c   = row.checks || {};

  // 1. IBKR POS
  out.push({
    kind:         'IBKR_POS',
    source:       'IBKR POS',
    direction:    row.ibkr.direction,
    shares:       row.ibkr.shares,
    avgCost:      row.ibkr.avgCost,
    stopSide:     null,
    stopPrice:    null,
    stopShares:   null,
    ratchetValue: null,
    // checks shown on this row:
    dirCheck:     c.direction,
    sharesCheck:  c.shares,
    avgCheck:     c.avg,
  });

  // 2. IBKR STP — one row per stop (or a single placeholder if no stops)
  const stops = row.ibkr.stops || [];
  if (stops.length === 0) {
    // Show a stop placeholder so user sees clearly that IBKR has no stop
    out.push({
      kind:         'IBKR_STP',
      source:       'IBKR STP',
      direction:    null, shares: null, avgCost: null,
      stopSide:     null,
      stopPrice:    null,
      stopShares:   null,
      ratchetValue: null,
      stopSideCheck:   c.stopSide,
      stopPriceCheck:  c.stopPrice,
      stopSharesCheck: c.stopShares,
      noStop: true,
    });
  } else {
    stops.forEach((st, idx) => {
      out.push({
        kind:         'IBKR_STP',
        source:       stops.length > 1 ? `IBKR STP ${idx + 1}` : 'IBKR STP',
        direction:    null, shares: null, avgCost: null,
        stopSide:     st.side,
        stopPrice:    st.price,
        stopShares:   st.shares,
        ratchetValue: null,
        // show the column-level checks only on the FIRST stop row (compound checks span all stops)
        stopSideCheck:   idx === 0 ? c.stopSide : null,
        stopPriceCheck:  idx === 0 ? c.stopPrice : null,
        stopSharesCheck: idx === 0 ? c.stopShares : null,
      });
    });
  }

  // 3. CMD
  out.push({
    kind:         'CMD',
    source:       'CMD',
    direction:    row.command.direction,
    shares:       row.command.shares,
    avgCost:      row.command.avgCost,
    stopSide:     row.command.direction === 'LONG'  ? 'SELL' :
                  row.command.direction === 'SHORT' ? 'BUY'  : null,
    stopPrice:    row.command.stopPrice,
    stopShares:   row.command.shares, // planned stop covers the full position
    ratchetValue: row.nextRatchet,
    ratchetLabel: row.ratchetLabel,
    dirCheck:        c.direction,
    sharesCheck:     c.shares,
    avgCheck:        c.avg,
    stopSideCheck:   c.stopSide,
    stopPriceCheck:  c.stopPrice,
    stopSharesCheck: c.stopShares,
    ratchetCheck:    c.ratchet,
  });

  return out;
}

// ── Main component ──────────────────────────────────────────────────────────
export default function AssistantLiveTable({ onNavigate }) {
  const [data,       setData]       = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState(null);
  const [modalRow,   setModalRow]   = useState(null);
  const [collapsed,  setCollapsed]  = useState(false);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      setRefreshing(true);
      const r = await fetch(`${API_BASE}/api/assistant/live-reconcile`, { headers: authHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setData(d);
    } catch (e) {
      setError(e.message || 'Failed to load');
    } finally {
      setLoading(false);
      setRefreshing(false);
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
      userSelect: 'none',
    },
    collapseBtn: {
      background: 'transparent', border: 'none', padding: '2px 4px',
      color: '#FCF000', fontSize: 11, cursor: 'pointer',
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
    tableWrap: { padding: '6px 6px 6px', overflowX: 'auto' },
    table:     { width: '100%', borderCollapse: 'collapse', minWidth: 900 },
    th: {
      padding: '6px 8px', textAlign: 'left', fontSize: 9, fontWeight: 800,
      letterSpacing: '0.08em', color: 'rgba(255,255,255,0.6)',
      borderBottom: '1px solid rgba(255,255,255,0.15)', whiteSpace: 'nowrap',
    },
    thR: { textAlign: 'right' },
    ticker: { fontWeight: 800, letterSpacing: '0.04em', fontSize: 13, color: '#fff' },
    sourceLabel: (kind) => ({
      padding: '4px 8px',
      fontSize: 9,
      fontWeight: 700,
      letterSpacing: '0.08em',
      color: kind === 'CMD'       ? '#FCF000'
           : kind === 'IBKR_POS'  ? 'rgba(255,255,255,0.55)'
           :                        'rgba(255,255,255,0.4)',
      whiteSpace: 'nowrap',
    }),
  };

  // Row-level tint based on worst status — applied to all sub-rows of a ticker
  const rowTint = (rs) =>
    rs === 'red'    ? 'rgba(220,53,69,0.04)'
  : rs === 'yellow' ? 'rgba(255,193,7,0.03)'
  :                   'transparent';

  const body = () => {
    if (loading && !data) return <div style={{ padding: 20, opacity: 0.6 }}>Loading reconciliation…</div>;
    if (error) return <div style={{ padding: 20, color: '#dc3545' }}>Error: {error}</div>;
    if (!data?.rows?.length) return <div style={{ padding: 20, opacity: 0.6 }}>No positions or stops to reconcile.</div>;

    return (
      <div style={s.tableWrap}>
        <table style={s.table}>
          <colgroup>
            <col style={{ width: 18 }} />                    {/* status dot */}
            <col style={{ width: 90 }} />                    {/* ticker */}
            <col style={{ width: 80 }} />                    {/* source label */}
            <col style={{ width: 60 }} />                    {/* dir */}
            <col style={{ width: 70 }} />                    {/* shares */}
            <col style={{ width: 95 }} />                    {/* avg */}
            <col style={{ width: 85 }} />                    {/* last */}
            <col style={{ width: 70 }} />                    {/* stop side */}
            <col style={{ width: 95 }} />                    {/* stop price */}
            <col style={{ width: 70 }} />                    {/* stop shr */}
            <col style={{ width: 130 }} />                   {/* next ratchet */}
            <col style={{ width: 70 }} />                    {/* action */}
          </colgroup>
          <thead>
            <tr>
              <th style={s.th}></th>
              <th style={s.th}>TICKER</th>
              <th style={s.th}>SRC</th>
              <th style={s.th}>DIR</th>
              <th style={{ ...s.th, ...s.thR }}>SHARES</th>
              <th style={{ ...s.th, ...s.thR }}>AVG</th>
              <th style={{ ...s.th, ...s.thR }}>LAST</th>
              <th style={s.th}>STOP SIDE</th>
              <th style={{ ...s.th, ...s.thR }}>STOP PRICE</th>
              <th style={{ ...s.th, ...s.thR }}>STOP SHR</th>
              <th style={{ ...s.th, ...s.thR }}>NEXT RATCHET</th>
              <th style={s.th}>ACTION</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map(row => {
              const rs   = row.rowStatus;
              const tint = rowTint(rs);
              const sub  = buildSubRows(row);
              const spanAll = sub.length;
              const ibStops = row.ibkr?.stops || [];

              return sub.map((sr, idx) => {
                const isLast = idx === sub.length - 1;
                return (
                  <tr key={`${row.ticker}-${idx}`} style={{ background: tint }}>
                    {idx === 0 && (
                      <td
                        rowSpan={spanAll}
                        style={{
                          padding: '4px 4px 4px 10px',
                          borderBottom: '1px solid rgba(255,255,255,0.12)',
                          verticalAlign: 'middle',
                          textAlign: 'center',
                        }}
                      >
                        <Dot status={rs} size={10} title={`Row status: ${rs}`} />
                      </td>
                    )}
                    {idx === 0 && (
                      <td
                        rowSpan={spanAll}
                        style={{
                          padding: '4px 8px',
                          borderBottom: '1px solid rgba(255,255,255,0.12)',
                          verticalAlign: 'middle',
                          ...s.ticker,
                        }}
                      >
                        {row.ticker}
                        {row.multiStop && (
                          <div style={{
                            marginTop: 2, padding: '1px 5px', borderRadius: 3,
                            background: 'rgba(255,193,7,0.15)', color: '#ffc107',
                            fontSize: 9, fontWeight: 800, display: 'inline-block',
                          }}>{ibStops.length} STOPS</div>
                        )}
                      </td>
                    )}

                    <td style={{ ...s.sourceLabel(sr.kind), borderBottom: isLast ? '1px solid rgba(255,255,255,0.12)' : 'none' }}>
                      {sr.source}
                    </td>

                    {/* DIR */}
                    {sr.direction != null
                      ? <Cell check={sr.dirCheck} bottomBorder={isLast}>{sr.direction}</Cell>
                      : <EmptyCell bottomBorder={isLast} />}

                    {/* SHARES */}
                    {sr.shares != null
                      ? <Cell check={sr.sharesCheck} align="right" onClick={() => handleCellClick(row)} bottomBorder={isLast}>{fmtShares(sr.shares)}</Cell>
                      : <EmptyCell bottomBorder={isLast} />}

                    {/* AVG */}
                    {sr.avgCost != null
                      ? <Cell check={sr.avgCheck} align="right" onClick={() => handleCellClick(row)} bottomBorder={isLast}>{fmtMoney(sr.avgCost)}</Cell>
                      : <EmptyCell bottomBorder={isLast} />}

                    {/* LAST — single cell spanning all sub-rows, shown only on first */}
                    {idx === 0 && (
                      <td
                        rowSpan={spanAll}
                        style={{
                          padding: '4px 8px', textAlign: 'right',
                          borderBottom: '1px solid rgba(255,255,255,0.12)',
                          verticalAlign: 'middle',
                          color: '#e6e6e6', fontSize: 12,
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >{fmtMoney(row.lastPrice)}</td>
                    )}

                    {/* STOP SIDE */}
                    {sr.kind === 'IBKR_POS'
                      ? <EmptyCell bottomBorder={isLast} />
                      : (sr.stopSide != null || sr.noStop)
                        ? <Cell check={sr.stopSideCheck} bottomBorder={isLast}>{sr.stopSide ?? (sr.noStop ? '—' : '')}</Cell>
                        : <EmptyCell bottomBorder={isLast} />
                    }

                    {/* STOP PRICE */}
                    {sr.kind === 'IBKR_POS'
                      ? <EmptyCell bottomBorder={isLast} />
                      : (sr.stopPrice != null || sr.noStop)
                        ? <Cell check={sr.stopPriceCheck} align="right" onClick={() => handleCellClick(row)} bottomBorder={isLast}>
                            {sr.noStop ? '— NAKED' : fmtMoney(sr.stopPrice)}
                          </Cell>
                        : <EmptyCell bottomBorder={isLast} />
                    }

                    {/* STOP SHR */}
                    {sr.kind === 'IBKR_POS'
                      ? <EmptyCell bottomBorder={isLast} />
                      : (sr.stopShares != null || sr.noStop)
                        ? <Cell check={sr.stopSharesCheck} align="right" onClick={() => handleCellClick(row)} bottomBorder={isLast}>
                            {sr.noStop ? '0' : fmtShares(sr.stopShares)}
                          </Cell>
                        : <EmptyCell bottomBorder={isLast} />
                    }

                    {/* NEXT RATCHET — only populated on CMD row */}
                    {sr.kind === 'CMD' && sr.ratchetValue != null
                      ? <Cell check={sr.ratchetCheck} align="right" onClick={() => handleCellClick(row)} bottomBorder={isLast}>
                          {fmtMoney(sr.ratchetValue)}
                          {sr.ratchetLabel && (
                            <span style={{ opacity: 0.55, fontSize: 10, marginLeft: 4 }}>({sr.ratchetLabel})</span>
                          )}
                        </Cell>
                      : <EmptyCell bottomBorder={isLast} />
                    }

                    {/* ACTION — rowspan, on first sub-row only */}
                    {idx === 0 && (
                      <td
                        rowSpan={spanAll}
                        style={{
                          padding: '4px 8px',
                          borderBottom: '1px solid rgba(255,255,255,0.12)',
                          verticalAlign: 'middle',
                          textAlign: 'center',
                        }}
                      >
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
                          >FIX</button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              });
            })}
          </tbody>
        </table>
      </div>
    );
  };

  const summary = data?.summary || { red: 0, yellow: 0, green: 0, total: 0 };

  return (
    <div style={s.container}>
      <div style={s.headerBar}>
        <button
          type="button"
          onClick={() => setCollapsed(v => !v)}
          style={s.collapseBtn}
          title={collapsed ? 'Expand' : 'Collapse'}
        >{collapsed ? '▶' : '▼'}</button>
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
          {refreshing ? 'refreshing…' : `last sync: ${fmtTime(data?.lastSyncedAt)}`}
        </span>
        <button
          type="button"
          onClick={fetchData}
          disabled={refreshing}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(252,240,0,0.22)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(252,240,0,0.1)';  }}
          style={{
            padding: '4px 12px',
            background: 'rgba(252,240,0,0.1)',
            color: '#FCF000',
            border: '1px solid rgba(252,240,0,0.4)',
            borderRadius: 4, fontSize: 10, fontWeight: 800,
            cursor: refreshing ? 'wait' : 'pointer',
            letterSpacing: '0.05em',
            opacity: refreshing ? 0.6 : 1,
            transition: 'background 0.15s',
          }}
        >{refreshing ? '… REFRESHING' : '↺ REFRESH'}</button>
      </div>
      {!collapsed && body()}
      <ActionModal row={modalRow} onClose={() => setModalRow(null)} />
    </div>
  );
}
