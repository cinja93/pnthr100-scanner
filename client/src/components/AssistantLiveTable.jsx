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

import { useState, useEffect, useCallback, useRef } from 'react';
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

// Inline-editable stop price cell for CMD_STOP rows. Click → input → Enter saves
// to PATCH /api/positions/:id/stop-price and triggers a table refresh.
function EditableStopPriceCell({ value, check, positionId, onSaved, bottomBorder = false }) {
  const [editing, setEditing] = useState(false);
  const [input,   setInput]   = useState(value == null ? '' : String(value));
  const [saving,  setSaving]  = useState(false);
  const [flash,   setFlash]   = useState(null); // 'success' | 'error' | null
  const inputRef = useRef(null);

  // Keep internal input in sync when the prop changes (e.g. after a refetch)
  useEffect(() => { if (!editing) setInput(value == null ? '' : String(value)); }, [value, editing]);

  // Auto-focus the input when entering edit mode
  useEffect(() => {
    if (editing && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
  }, [editing]);

  const commit = async () => {
    const n = Number(input);
    if (!Number.isFinite(n) || n <= 0) {
      setFlash('error');
      setTimeout(() => setFlash(null), 1500);
      setEditing(false);
      setInput(String(value ?? ''));
      return;
    }
    if (Math.abs(n - (+value || 0)) < 0.005) {
      // No change — exit cleanly
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const r = await fetch(`${API_BASE}/api/positions/${positionId}/stop-price`, {
        method:  'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body:    JSON.stringify({ stopPrice: n }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setFlash('success');
      setEditing(false);
      await onSaved?.();
      setTimeout(() => setFlash(null), 900);
    } catch (e) {
      setFlash('error');
      setTimeout(() => setFlash(null), 2000);
      setEditing(false);
      setInput(String(value ?? ''));
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    setEditing(false);
    setInput(String(value ?? ''));
  };

  const status = check?.status || null;
  const flashBg = flash === 'success' ? 'rgba(40,167,69,0.18)'
                : flash === 'error'   ? 'rgba(220,53,69,0.18)'
                : undefined;

  return (
    <td
      onClick={(e) => { if (!editing && !saving && positionId) { e.stopPropagation(); setEditing(true); } }}
      style={{
        padding: '4px 8px',
        borderBottom: bottomBorder ? '1px solid rgba(255,255,255,0.12)' : 'none',
        cursor: editing ? 'text' : positionId ? 'pointer' : 'default',
        color: '#e6e6e6',
        fontSize: 12,
        whiteSpace: 'nowrap',
        textAlign: 'right',
        fontVariantNumeric: 'tabular-nums',
        background: flashBg,
        transition: 'background 0.3s',
      }}
      title={editing ? 'Enter to save · Esc to cancel' : 'Click to edit stop price'}
    >
      {status && <Dot status={status} title={check?.reason} />}
      {editing ? (
        <input
          ref={inputRef}
          type="number"
          step="0.01"
          min="0"
          value={input}
          disabled={saving}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          }}
          onBlur={commit}
          style={{
            width: 70, padding: '1px 4px',
            background: 'rgba(252,240,0,0.1)',
            border: '1px solid #FCF000',
            borderRadius: 3, color: '#FCF000',
            fontSize: 12, fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            textAlign: 'right',
            outline: 'none',
          }}
        />
      ) : (
        <span style={{
          borderBottom: positionId ? '1px dotted rgba(252,240,0,0.35)' : 'none',
          paddingBottom: 1,
        }}>
          {saving ? '…' : (value == null ? '—' : fmtMoney(value))}
        </span>
      )}
    </td>
  );
}

// Empty placeholder cell. When `needsFill` is true, renders a dashed box
// so the user instantly sees "this is where data should go."
function EmptyCell({ bottomBorder = false, needsFill = false, align = 'center' }) {
  if (needsFill) {
    return (
      <td
        style={{
          padding: '4px 8px',
          borderBottom: bottomBorder ? '1px solid rgba(255,255,255,0.12)' : 'none',
          textAlign: align,
        }}
      >
        <span style={{
          display: 'inline-block',
          padding: '1px 8px',
          border: '1px dashed rgba(220,53,69,0.75)',
          borderRadius: 3,
          color: '#dc3545',
          fontSize: 9,
          fontWeight: 800,
          letterSpacing: '0.08em',
          background: 'rgba(220,53,69,0.04)',
        }}>ADD</span>
      </td>
    );
  }
  return (
    <td
      style={{
        padding: '4px 8px',
        borderBottom: bottomBorder ? '1px solid rgba(255,255,255,0.12)' : 'none',
        color: 'rgba(255,255,255,0.2)',
        fontSize: 12,
        textAlign: align,
      }}
    >·</td>
  );
}

// Which columns should have data for a given sub-row kind.
// Used to decide whether an empty cell should be highlighted ("needs fill in")
// or left as an inert ·.
const REQUIRED_FIELDS = {
  IBKR_POS:  new Set(['dir', 'shares']),
  IBKR_STOP: new Set(['shares', 'stopSide', 'stopPrice']),
  CMD_POS:   new Set(['dir', 'shares']),
  CMD_STOP:  new Set(['shares', 'stopSide', 'stopPrice']),
};
function needsFillIn(kind, col, rowStatus) {
  if (rowStatus !== 'red' && rowStatus !== 'yellow') return false;
  return REQUIRED_FIELDS[kind]?.has(col) || false;
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

// ── Build the 4-row (+ extra IBKR stops) sub-row stack for one ticker ────────
// Stack order:
//   IBKR POS     → direction, shares (pos), avg
//   IBKR STOP(s) → shares (stop), stop side, stop price  (multi-stop → extra rows)
//   CMD POS      → direction, shares (pos), avg
//   CMD STOP     → shares (stop), stop side, stop price, next ratchet
//
// The SHARES column is filled on every row so the user can scan one column
// and confirm all four values match.
function buildSubRows(row) {
  const out = [];
  const c   = row.checks || {};
  const cmdPlannedShares = row.command.shares; // planned stop should cover the full position
  const expectedStopSide = row.command.direction === 'LONG'  ? 'SELL'
                         : row.command.direction === 'SHORT' ? 'BUY'
                         : null;

  // 1. IBKR POS
  out.push({
    kind:        'IBKR_POS',
    source:      'IBKR POS',
    direction:   row.ibkr.direction,
    shares:      row.ibkr.shares,
    avgCost:     row.ibkr.avgCost,
    dirCheck:    c.direction,
    sharesCheck: c.shares,
    avgCheck:    c.avg,
  });

  // 2. IBKR STOP — one row per stop (or placeholder if none)
  const stops = row.ibkr.stops || [];
  if (stops.length === 0) {
    out.push({
      kind:   'IBKR_STOP',
      source: 'IBKR STOP',
      shares: null, stopSide: null, stopPrice: null,
      sharesCheck:    c.stopShares,
      stopSideCheck:  c.stopSide,
      stopPriceCheck: c.stopPrice,
      noStop: true,
    });
  } else {
    stops.forEach((st, idx) => {
      out.push({
        kind:   'IBKR_STOP',
        source: stops.length > 1 ? `IBKR STOP ${idx + 1}` : 'IBKR STOP',
        shares:    st.shares,
        stopSide:  st.side,
        stopPrice: st.price,
        // compound column-level checks only on first stop row
        sharesCheck:    idx === 0 ? c.stopShares : null,
        stopSideCheck:  idx === 0 ? c.stopSide   : null,
        stopPriceCheck: idx === 0 ? c.stopPrice  : null,
      });
    });
  }

  // 3. CMD POS
  out.push({
    kind:        'CMD_POS',
    source:      'CMD POS',
    direction:   row.command.direction,
    shares:      row.command.shares,
    avgCost:     row.command.avgCost,
    dirCheck:    c.direction,
    sharesCheck: c.shares,
    avgCheck:    c.avg,
  });

  // 4. CMD STOP
  out.push({
    kind:        'CMD_STOP',
    source:      'CMD STOP',
    shares:      cmdPlannedShares, // planned stop covers the full position
    stopSide:    expectedStopSide,
    stopPrice:   row.command.stopPrice,
    ratchetValue: row.nextRatchet,
    ratchetLabel: row.ratchetLabel,
    sharesCheck:    c.stopShares,
    stopSideCheck:  c.stopSide,
    stopPriceCheck: c.stopPrice,
    ratchetCheck:   c.ratchet,
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
    table:     { width: '100%', borderCollapse: 'collapse', minWidth: 820 },
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
      color: kind === 'CMD_POS' || kind === 'CMD_STOP' ? '#FCF000'
           : kind === 'IBKR_POS'                       ? 'rgba(255,255,255,0.6)'
           :                                             'rgba(255,255,255,0.45)',
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
            <col style={{ width: 150 }} />                   {/* ticker + last + IBKR avg + CMD avg */}
            <col style={{ width: 95 }} />                    {/* direction */}
            <col style={{ width: 100 }} />                   {/* source label */}
            <col style={{ width: 75 }} />                    {/* shares */}
            <col style={{ width: 70 }} />                    {/* stop side */}
            <col style={{ width: 95 }} />                    {/* stop price */}
            <col style={{ width: 130 }} />                   {/* next ratchet */}
            <col style={{ width: 70 }} />                    {/* action */}
          </colgroup>
          <thead>
            <tr>
              <th style={s.th}></th>
              <th style={s.th}>TICKER · LAST · AVG</th>
              <th style={s.th}>DIRECTION</th>
              <th style={s.th}>SRC</th>
              <th style={{ ...s.th, ...s.thR }}>SHARES</th>
              <th style={s.th}>STOP SIDE</th>
              <th style={{ ...s.th, ...s.thR }}>STOP PRICE</th>
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
                          padding: '6px 8px',
                          borderBottom: '1px solid rgba(255,255,255,0.12)',
                          verticalAlign: 'top',
                        }}
                      >
                        <div style={s.ticker}>{row.ticker}</div>
                        <div style={{
                          fontSize: 11, color: 'rgba(255,255,255,0.55)',
                          fontVariantNumeric: 'tabular-nums', marginTop: 1,
                        }}>{fmtMoney(row.lastPrice)}</div>
                        <div style={{
                          marginTop: 4, fontSize: 11,
                          display: 'flex', alignItems: 'center', gap: 0,
                          fontVariantNumeric: 'tabular-nums',
                          color: 'rgba(255,255,255,0.75)',
                        }}>
                          <Dot status={row.checks?.avg?.status || 'gray'} title={row.checks?.avg?.reason} />
                          <span style={{ opacity: 0.5, marginRight: 4 }}>IBKR</span>
                          {fmtMoney(row.ibkr.avgCost)}
                        </div>
                        <div style={{
                          marginTop: 1, fontSize: 11,
                          display: 'flex', alignItems: 'center', gap: 0,
                          fontVariantNumeric: 'tabular-nums',
                          color: 'rgba(255,255,255,0.75)',
                        }}>
                          <Dot status={row.checks?.avg?.status || 'gray'} title={row.checks?.avg?.reason} />
                          <span style={{ opacity: 0.5, marginRight: 4, color: '#FCF000' }}>CMD</span>
                          {fmtMoney(row.command.avgCost)}
                        </div>
                        {row.multiStop && (
                          <div style={{
                            marginTop: 4, padding: '1px 5px', borderRadius: 3,
                            background: 'rgba(255,193,7,0.15)', color: '#ffc107',
                            fontSize: 9, fontWeight: 800, display: 'inline-block',
                          }}>{ibStops.length} STOPS</div>
                        )}
                      </td>
                    )}

                    {/* DIRECTION — POS rows only. Moved before SRC per user request. */}
                    {sr.direction != null
                      ? <Cell check={sr.dirCheck} bottomBorder={isLast}>{sr.direction}</Cell>
                      : <EmptyCell bottomBorder={isLast} needsFill={needsFillIn(sr.kind, 'dir', rs)} />}

                    <td style={{ ...s.sourceLabel(sr.kind), borderBottom: isLast ? '1px solid rgba(255,255,255,0.12)' : 'none' }}>
                      {sr.source}
                    </td>

                    {/* SHARES — always shown (position shares or stop shares) */}
                    {sr.shares != null
                      ? <Cell check={sr.sharesCheck} align="right" onClick={() => handleCellClick(row)} bottomBorder={isLast}>{fmtShares(sr.shares)}</Cell>
                      : sr.noStop
                        ? <Cell check={sr.sharesCheck} align="right" onClick={() => handleCellClick(row)} bottomBorder={isLast}>0</Cell>
                        : <EmptyCell bottomBorder={isLast} align="right" needsFill={needsFillIn(sr.kind, 'shares', rs)} />}

                    {/* STOP SIDE — STOP rows only */}
                    {sr.kind === 'IBKR_POS' || sr.kind === 'CMD_POS'
                      ? <EmptyCell bottomBorder={isLast} />
                      : (sr.stopSide != null || sr.noStop)
                        ? <Cell check={sr.stopSideCheck} bottomBorder={isLast}>
                            {sr.stopSide ?? (sr.noStop ? '—' : '')}
                          </Cell>
                        : <EmptyCell bottomBorder={isLast} needsFill={needsFillIn(sr.kind, 'stopSide', rs)} />
                    }

                    {/* STOP PRICE — STOP rows only. CMD_STOP is inline-editable. */}
                    {sr.kind === 'IBKR_POS' || sr.kind === 'CMD_POS'
                      ? <EmptyCell bottomBorder={isLast} />
                      : sr.kind === 'CMD_STOP' && row.command.positionId
                        ? <EditableStopPriceCell
                            value={sr.stopPrice}
                            check={sr.stopPriceCheck}
                            positionId={row.command.positionId}
                            onSaved={fetchData}
                            bottomBorder={isLast}
                          />
                        : (sr.stopPrice != null || sr.noStop)
                          ? <Cell check={sr.stopPriceCheck} align="right" onClick={() => handleCellClick(row)} bottomBorder={isLast}>
                              {sr.noStop ? '— NAKED' : fmtMoney(sr.stopPrice)}
                            </Cell>
                          : <EmptyCell bottomBorder={isLast} align="right" needsFill={needsFillIn(sr.kind, 'stopPrice', rs)} />
                    }

                    {/* NEXT RATCHET — CMD_STOP row only */}
                    {sr.kind === 'CMD_STOP' && sr.ratchetValue != null
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
