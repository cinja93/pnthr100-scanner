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
import AssistantRowExpand from './AssistantRowExpand';
import { sizePosition, isEtfTicker } from '../utils/sizingUtils.js';

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

// ── Generic inline integer-shares editor ─────────────────────────────────────
// Shared by CMD POS and CMD STOP share cells. Click → number input →
// Enter saves via PATCH /api/positions/:id/shares; the server adjusts lot 1's
// shares so the total sums to the typed value (lots 2-5 preserved).
function EditableSharesCell({ value, check, positionId, onSaved, bottomBorder = false }) {
  const [editing, setEditing] = useState(false);
  const [input,   setInput]   = useState(value == null ? '' : String(value));
  const [saving,  setSaving]  = useState(false);
  const [flash,   setFlash]   = useState(null);
  const inputRef = useRef(null);

  useEffect(() => { if (!editing) setInput(value == null ? '' : String(value)); }, [value, editing]);
  useEffect(() => {
    if (editing && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
  }, [editing]);

  const commit = async () => {
    const n = Number(input);
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
      setFlash('error'); setTimeout(() => setFlash(null), 1500);
      setEditing(false); setInput(String(value ?? ''));
      return;
    }
    if (n === (+value || 0)) { setEditing(false); return; }
    setSaving(true);
    try {
      const r = await fetch(`${API_BASE}/api/positions/${positionId}/shares`, {
        method:  'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body:    JSON.stringify({ totalShares: n }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d?.error || `HTTP ${r.status}`);
      }
      setFlash('success');
      setEditing(false);
      await onSaved?.();
      setTimeout(() => setFlash(null), 900);
    } catch (e) {
      setFlash('error');
      setTimeout(() => setFlash(null), 2000);
      setEditing(false);
      setInput(String(value ?? ''));
    } finally { setSaving(false); }
  };

  const cancel = () => { setEditing(false); setInput(String(value ?? '')); };
  const flashBg = flash === 'success' ? 'rgba(40,167,69,0.18)'
                : flash === 'error'   ? 'rgba(220,53,69,0.18)'
                : undefined;
  const status = check?.status || null;

  return (
    <td
      onClick={(e) => { if (!editing && !saving && positionId) { e.stopPropagation(); setEditing(true); } }}
      style={{
        padding: '4px 8px',
        borderBottom: bottomBorder ? '1px solid rgba(255,255,255,0.12)' : 'none',
        cursor: editing ? 'text' : positionId ? 'pointer' : 'default',
        color: '#e6e6e6', fontSize: 12,
        whiteSpace: 'nowrap', textAlign: 'right',
        fontVariantNumeric: 'tabular-nums',
        background: flashBg, transition: 'background 0.3s',
      }}
      title={editing ? 'Enter to save · Esc to cancel' : 'Click to edit total shares'}
    >
      {status && <Dot status={status} title={check?.reason} />}
      {editing ? (
        <input
          ref={inputRef}
          type="number" step="1" min="1"
          value={input}
          disabled={saving}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter')  { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          }}
          onBlur={commit}
          onClick={(e) => e.stopPropagation()}
          style={{
            width: 60, padding: '1px 4px',
            background: 'rgba(252,240,0,0.1)',
            border: '1px solid #FCF000', borderRadius: 3,
            color: '#FCF000', fontSize: 12, fontWeight: 600,
            fontVariantNumeric: 'tabular-nums', textAlign: 'right',
            outline: 'none',
          }}
        />
      ) : (
        <span style={{
          borderBottom: positionId ? '1px dotted rgba(252,240,0,0.35)' : 'none',
          paddingBottom: 1,
        }}>{saving ? '…' : (value == null ? '—' : value)}</span>
      )}
    </td>
  );
}

// ── Inline direction toggle (LONG ↔ SHORT) ───────────────────────────────────
// Click to reveal LONG/SHORT buttons; click one to save via PATCH
// /api/positions/:id/direction. Flipping direction also flips the expected
// protective-stop side (SELL ↔ BUY) automatically via the next refetch.
function EditableDirectionCell({ value, check, positionId, onSaved, bottomBorder = false }) {
  const [editing, setEditing] = useState(false);
  const [saving,  setSaving]  = useState(false);
  const [flash,   setFlash]   = useState(null);

  const pick = async (newDir) => {
    if (newDir === value) { setEditing(false); return; }
    setSaving(true);
    try {
      const r = await fetch(`${API_BASE}/api/positions/${positionId}/direction`, {
        method:  'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body:    JSON.stringify({ direction: newDir }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setFlash('success'); setEditing(false);
      await onSaved?.();
      setTimeout(() => setFlash(null), 900);
    } catch (e) {
      setFlash('error');
      setTimeout(() => setFlash(null), 2000);
      setEditing(false);
    } finally { setSaving(false); }
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
        cursor: editing ? 'default' : positionId ? 'pointer' : 'default',
        color: '#e6e6e6', fontSize: 12, whiteSpace: 'nowrap',
        background: flashBg, transition: 'background 0.3s',
      }}
      title={editing ? 'Click LONG or SHORT to set' : 'Click to change direction'}
    >
      {status && <Dot status={status} title={check?.reason} />}
      {editing ? (
        <span style={{ display: 'inline-flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
          {['LONG', 'SHORT'].map(d => (
            <button
              key={d}
              type="button"
              disabled={saving}
              onClick={() => pick(d)}
              style={{
                padding: '1px 6px',
                background: d === value
                  ? (d === 'LONG' ? 'rgba(40,167,69,0.25)' : 'rgba(220,53,69,0.25)')
                  : 'rgba(255,255,255,0.05)',
                border: `1px solid ${d === value
                  ? (d === 'LONG' ? '#28a745' : '#dc3545')
                  : 'rgba(255,255,255,0.2)'}`,
                color: d === 'LONG' ? '#28a745' : '#dc3545',
                borderRadius: 3, fontSize: 10, fontWeight: 800,
                letterSpacing: '0.05em', cursor: 'pointer',
              }}
            >{d}</button>
          ))}
        </span>
      ) : (
        <span style={{
          borderBottom: positionId ? '1px dotted rgba(252,240,0,0.35)' : 'none',
          paddingBottom: 1,
        }}>{saving ? '…' : value}</span>
      )}
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

// Inline-editable CMD average cost, rendered in the ticker cell below IBKR avg.
// Only editable when exactly one lot is filled (avg == lot 1 fill price). For
// multi-lot positions, renders plain with a tooltip pointing the user at
// Command Center (where individual fills can be edited).
function EditableAvgCostLine({ value, check, positionId, filledLotCount, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [input,   setInput]   = useState(value == null ? '' : String(value));
  const [saving,  setSaving]  = useState(false);
  const [flash,   setFlash]   = useState(null);
  const inputRef = useRef(null);

  useEffect(() => { if (!editing) setInput(value == null ? '' : String(value)); }, [value, editing]);
  useEffect(() => {
    if (editing && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
  }, [editing]);

  // Edits work for any filled-lot count: the server solves for lot 1's price
  // so the weighted avg of all filled lots equals the requested value.
  const editable = !!positionId;

  const commit = async () => {
    const n = Number(input);
    if (!Number.isFinite(n) || n <= 0) {
      setFlash('error'); setTimeout(() => setFlash(null), 1500);
      setEditing(false); setInput(String(value ?? ''));
      return;
    }
    if (Math.abs(n - (+value || 0)) < 0.005) { setEditing(false); return; }
    setSaving(true);
    try {
      const r = await fetch(`${API_BASE}/api/positions/${positionId}/avg-cost`, {
        method:  'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body:    JSON.stringify({ avgCost: n }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${r.status}`);
      }
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

  const cancel = () => { setEditing(false); setInput(String(value ?? '')); };

  const flashColor = flash === 'success' ? 'rgba(40,167,69,0.3)'
                   : flash === 'error'   ? 'rgba(220,53,69,0.3)'
                   : 'transparent';

  const tooltip = !editable
    ? ''
    : filledLotCount > 1
      ? `Click to edit — lot 1 price will be adjusted so the ${filledLotCount}-lot weighted average equals your entered value`
      : 'Click to edit CMD avg cost';

  return (
    <div
      onClick={() => { if (editable && !saving && !editing) setEditing(true); }}
      title={tooltip}
      style={{
        marginTop: 1, fontSize: 11,
        display: 'flex', alignItems: 'center', gap: 0,
        fontVariantNumeric: 'tabular-nums',
        color: 'rgba(255,255,255,0.75)',
        cursor: editable && !editing ? 'pointer' : 'default',
        background: flashColor,
        transition: 'background 0.3s',
        borderRadius: 2,
      }}
    >
      <Dot status={check?.status || 'gray'} title={check?.reason} />
      <span style={{ opacity: 0.5, marginRight: 4, color: '#FCF000' }}>CMD</span>
      {editing ? (
        <input
          ref={inputRef}
          type="number" step="0.0001" min="0"
          value={input}
          disabled={saving}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter')  { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          }}
          onBlur={commit}
          onClick={(e) => e.stopPropagation()}
          style={{
            width: 72, padding: '1px 4px',
            background: 'rgba(252,240,0,0.1)',
            border: '1px solid #FCF000',
            borderRadius: 3, color: '#FCF000',
            fontSize: 11, fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            outline: 'none',
          }}
        />
      ) : (
        <span style={{
          borderBottom: editable ? '1px dotted rgba(252,240,0,0.35)' : 'none',
          paddingBottom: 1,
        }}>{saving ? '…' : (value == null ? '—' : `$${(+value).toFixed(2)}`)}</span>
      )}
    </div>
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
              {a.type === 'ibkr' ? '🔗 MANUAL — IN IBKR' : '→ IN ASSISTANT'}
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

  // Split IBKR stops into PROTECTIVE vs RATCHET:
  //   PROTECTIVE = opposite-side STP for the position direction
  //                (SELL STP on LONG, BUY STP on SHORT). Participates in the
  //                stop-side / price / shares reconciliation checks.
  //   RATCHET    = same-side STP placed at a lot-entry trigger price. Does
  //                not affect the protective-stop checks — its correctness
  //                shows up in the NEXT RATCHET column dots instead.
  //
  // Sub-row order is:
  //   IBKR POS → IBKR STOP(s) → CMD POS → CMD STOP → [gap] → IBKR RATCHET(s)
  // so the flow stays grouped (position/stop/command) and ratchet orders don't
  // break the visual continuity of the 'how many protective shares do I have'
  // chain.
  const stops = row.ibkr.stops || [];
  const protectiveSide = row.command.direction === 'LONG'  ? 'SELL'
                       : row.command.direction === 'SHORT' ? 'BUY'
                       : row.ibkr.direction    === 'LONG'  ? 'SELL'
                       : row.ibkr.direction    === 'SHORT' ? 'BUY'
                       : null;
  const isProtective = (st) => protectiveSide ? st.side === protectiveSide : true;
  const protectiveIbkrStops = stops.filter(isProtective);
  const ratchetIbkrStops    = stops.filter(s => !isProtective(s));

  // 2. IBKR STOP — protective stops (or a single placeholder if there are none)
  if (protectiveIbkrStops.length === 0) {
    out.push({
      kind:   'IBKR_STOP',
      subKind: 'PROTECTIVE',
      source: 'IBKR STOP',
      shares: null, stopSide: null, stopPrice: null,
      sharesCheck:    c.stopShares,
      stopSideCheck:  c.stopSide,
      stopPriceCheck: c.stopPrice,
      noStop: true,
    });
  } else {
    protectiveIbkrStops.forEach((st, idx) => {
      out.push({
        kind:       'IBKR_STOP',
        subKind:    'PROTECTIVE',
        source:     'IBKR STOP',
        shares:     st.shares,
        stopSide:   st.side,
        stopPrice:  st.price,
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

  // 5. Visual gap + ratchet zone. Always rendered so the L2-L5 plan list has
  // a consistent home below the divider (even when no ratchet orders are
  // staged yet in IBKR).
  //   - IBKR_RATCHET rows: one per same-side lot-entry stop currently in IBKR
  //   - If no ratchet orders are staged, a single RATCHET_PLAN row stands in
  //     so the L2-L5 plan list still has a row to render on.
  //   - The FIRST row below the divider gets showRatchetPlan: true, meaning
  //     the L2-L5 list renders in its NEXT RATCHET cell.
  const hasRemainingLotPlan = (row.lotTriggers || []).some(t => !t.filled);
  const needsRatchetZone = ratchetIbkrStops.length > 0 || hasRemainingLotPlan;
  if (needsRatchetZone) {
    out.push({ kind: 'GAP' });
    if (ratchetIbkrStops.length > 0) {
      ratchetIbkrStops.forEach((st, idx) => {
        out.push({
          kind:      'IBKR_STOP',
          subKind:   'RATCHET',
          source:    'IBKR RATCHET',
          shares:    st.shares,
          stopSide:  st.side,
          stopType:  st.type,       // raw IB order type (e.g. 'STP', 'STP LMT')
          stopPrice: st.price,
          showRatchetPlan: idx === 0, // L2-L5 list renders on the first ratchet row
        });
      });
    } else {
      // No staged ratchet stops — dedicated plan row so the list stays below
      // the divider rather than jumping back up onto CMD STOP.
      out.push({
        kind:    'RATCHET_PLAN',
        source:  'RATCHET PLAN',
        showRatchetPlan: true,
      });
    }
  }

  return out;
}

// ── Main component ──────────────────────────────────────────────────────────
export default function AssistantLiveTable({ onNavigate, netLiquidity, onOpenChart, onAddPosition }) {
  const [data,       setData]       = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState(null);
  const [modalRow,   setModalRow]   = useState(null);
  const [collapsed,  setCollapsed]  = useState(false);
  // Day 1: per-row expand panel — Set<ticker>. Always starts empty (locked
  // decision #2 — collapse all on reload, clean slate every visit).
  const [expandedTickers, setExpandedTickers] = useState(() => new Set());
  // Mirror of pnthr_portfolio for the expanded-row panel. Fetched once
  // alongside live-reconcile and refreshed on the same cadence.
  const [positions, setPositions] = useState([]);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      setRefreshing(true);
      const [reconcileRes, positionsRes] = await Promise.all([
        fetch(`${API_BASE}/api/assistant/live-reconcile`, { headers: authHeaders() }),
        fetch(`${API_BASE}/api/positions`, { headers: authHeaders() }),
      ]);
      if (!reconcileRes.ok) throw new Error(`HTTP ${reconcileRes.status}`);
      const d = await reconcileRes.json();
      setData(d);
      if (positionsRes.ok) {
        const pd = await positionsRes.json();
        const list = Array.isArray(pd?.positions) ? pd.positions : (Array.isArray(pd) ? pd : []);
        setPositions(list);
      }
    } catch (e) {
      setError(e.message || 'Failed to load');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const toggleExpanded = useCallback((ticker) => {
    setExpandedTickers(prev => {
      const next = new Set(prev);
      if (next.has(ticker)) next.delete(ticker);
      else next.add(ticker);
      return next;
    });
  }, []);

  // Find a PNTHR portfolio doc by ticker for the expand panel. Active first;
  // falls back to most-recent regardless of status (rare, mainly for closed
  // positions still surfaced by the reconciler).
  const findPositionByTicker = useCallback((ticker) => {
    if (!ticker) return null;
    const t = ticker.toUpperCase();
    const active = positions.find(p => p.ticker?.toUpperCase() === t && (p.status === 'ACTIVE' || p.status === 'PARTIAL'));
    if (active) return active;
    return positions.find(p => p.ticker?.toUpperCase() === t) || null;
  }, [positions]);

  useEffect(() => {
    fetchData();
    const iv = setInterval(fetchData, REFRESH_MS);
    return () => clearInterval(iv);
  }, [fetchData]);

  const handleCellClick = (row) => {
    if (!row.actions?.length) return;
    const appAction = row.actions.find(a => a.type === 'app');
    if (appAction?.expandTicker) {
      setExpandedTickers(prev => {
        const next = new Set(prev);
        next.add(appAction.expandTicker);
        return next;
      });
      return;
    }
    if (appAction?.addTicker && onAddPosition) {
      onAddPosition({ ticker: appAction.addTicker });
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

  // Shared colgroup for the header table and every per-ticker table so column
  // widths stay in lock-step. Rendered via a helper so each mini-table gets
  // its own React nodes.
  const renderColgroup = () => (
    <colgroup>
      <col style={{ width: 18 }} />                    {/* status dot */}
      <col style={{ width: 150 }} />                   {/* ticker + last + IBKR avg + CMD avg */}
      <col style={{ width: 95 }} />                    {/* direction */}
      <col style={{ width: 100 }} />                   {/* source label */}
      <col style={{ width: 75 }} />                    {/* shares */}
      <col style={{ width: 115 }} />                   {/* stop side (wider so 'BUY STOP LIMIT' fits on ratchet rows) */}
      <col style={{ width: 95 }} />                    {/* stop price */}
      <col style={{ width: 115 }} />                   {/* next ratchet (narrowed to free room for STOP SIDE) */}
      <col style={{ width: 70 }} />                    {/* action */}
    </colgroup>
  );

  // Yellow outline around each ticker group, so the IBKR RATCHET row below
  // the divider can't be mistaken for the next ticker's first row.
  // `position: relative` anchors the live-price badge in the top-right.
  const tickerBoxStyle = {
    position:     'relative',
    border:       '3px solid rgba(252,240,0,0.45)',
    borderRadius: 5,
    marginBottom: 7,
    overflow:     'hidden',
    background:   'rgba(0,0,0,0.3)',
  };

  const body = () => {
    if (loading && !data) return <div style={{ padding: 20, opacity: 0.6 }}>Loading reconciliation…</div>;
    if (error) return <div style={{ padding: 20, color: '#dc3545' }}>Error: {error}</div>;
    if (!data?.rows?.length) return <div style={{ padding: 20, opacity: 0.6 }}>No positions or stops to reconcile.</div>;

    return (
      <div style={s.tableWrap}>
        {/* Column headers — single table, no body rows */}
        <table style={{ ...s.table, tableLayout: 'fixed', marginBottom: 4 }}>
          {renderColgroup()}
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
        </table>

        {/* One yellow-bordered mini-table per ticker */}
        {data.rows.map(row => {
          const rs      = row.rowStatus;
          const tint    = rowTint(rs);
          const sub     = buildSubRows(row);
          const spanAll = sub.length;
          const ibStops = row.ibkr?.stops || [];

          // Pyramid sizing badge — "filled / target at 1% NAV risk".
          // Shown top-right under the live-price badge. Hidden when no PNTHR
          // position record exists for this ticker, or when sizing math
          // returns 0 (recycled / invalid stop).
          const pos = findPositionByTicker(row.ticker);
          let targetShares = null;
          if (pos && +pos.entryPrice > 0 && +pos.stopPrice > 0 && +netLiquidity > 0) {
            const sizing = sizePosition({
              netLiquidity,
              entryPrice: +pos.entryPrice,
              stopPrice:  +pos.stopPrice,
              maxGapPct:  +pos.maxGapPct || 0,
              direction:  (pos.direction || 'LONG').toUpperCase(),
              isETF:      isEtfTicker(row.ticker, pos.isEtf),
            });
            if (sizing && sizing.totalShares > 0) targetShares = sizing.totalShares;
          }
          const currentShares = Math.abs(+row.ibkr?.shares || 0);

          return (
            <div key={row.ticker} style={tickerBoxStyle}>
              {/* Live-price badge — top-right corner. Refreshes with the
                  reconcile poll (every 60s). Hidden when price is unknown. */}
              {row.lastPrice != null && (
                <div
                  title={`Live price — refreshes every ${REFRESH_MS / 1000}s`}
                  style={{
                    position:    'absolute',
                    top:         6,
                    right:       6,
                    zIndex:      2,
                    display:     'flex',
                    alignItems:  'center',
                    gap:         5,
                    padding:     '2px 8px',
                    background:  'rgba(252,240,0,0.10)',
                    border:      '1px solid rgba(252,240,0,0.40)',
                    borderRadius: 4,
                    fontSize:    11,
                    fontWeight:  800,
                    color:       '#FCF000',
                    letterSpacing: '0.02em',
                    fontVariantNumeric: 'tabular-nums',
                    pointerEvents: 'none',
                  }}
                >
                  <span style={{
                    display: 'inline-block',
                    width: 6, height: 6, borderRadius: '50%',
                    background: '#28a745',
                    boxShadow: '0 0 4px rgba(40,167,69,0.9)',
                  }} />
                  {fmtMoney(row.lastPrice)}
                </div>
              )}
              {/* Pyramid sizing badge — filled / target at 1% NAV risk. */}
              {targetShares != null && (
                <div
                  title="Filled shares / Target shares at 1% NAV risk (all 5 lots filled). Numerator = IBKR-canonical current holdings; denominator = max position size at full pyramid."
                  style={{
                    position:    'absolute',
                    top:         32,
                    right:       6,
                    zIndex:      2,
                    padding:     '2px 8px',
                    background:  'rgba(13,110,253,0.18)',
                    border:      '1px solid rgba(13,110,253,0.55)',
                    borderRadius: 4,
                    fontSize:    11,
                    fontWeight:  800,
                    color:       '#FFFFFF',
                    fontVariantNumeric: 'tabular-nums',
                    pointerEvents: 'none',
                    letterSpacing: '0.02em',
                  }}
                >
                  {currentShares} / {targetShares}
                </div>
              )}
              <table style={{ ...s.table, tableLayout: 'fixed' }}>
                {renderColgroup()}
                <tbody>
                  {sub.map((sr, idx) => {
                const isLast = idx === sub.length - 1;

                // Visual separator between the CMD block and the IBKR RATCHET
                // rows. The ticker/last/status/action columns are covered by
                // the rowSpan from idx=0, so we only render empty middle cells.
                if (sr.kind === 'GAP') {
                  const dash = '1px dashed rgba(255,255,255,0.18)';
                  const gapCell = { padding: 0, height: 8, borderTop: dash };
                  return (
                    <tr key={`${row.ticker}-${idx}`} style={{ background: tint }}>
                      <td style={gapCell} /> {/* direction */}
                      <td style={gapCell} /> {/* source */}
                      <td style={gapCell} /> {/* shares */}
                      <td style={gapCell} /> {/* stop side */}
                      <td style={gapCell} /> {/* stop price */}
                      <td style={gapCell} /> {/* next ratchet */}
                    </tr>
                  );
                }

                // When the NEXT RATCHET cell has a multi-line L2–L5 list
                // (IBKR RATCHET / RATCHET PLAN rows), anchor the whole tr to
                // the top so the single-line price/side/shares cells line up
                // with the FIRST L-line — otherwise the default middle
                // alignment floats them into the middle of the list.
                const isRatchetZoneRow = sr.kind === 'RATCHET_PLAN'
                  || (sr.kind === 'IBKR_STOP' && sr.subKind === 'RATCHET');

                return (
                  <tr
                    key={`${row.ticker}-${idx}`}
                    style={{
                      background: tint,
                      ...(isRatchetZoneRow ? { verticalAlign: 'top' } : {}),
                    }}
                  >
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
                        <div
                          style={{
                            ...s.ticker,
                            cursor: 'pointer',
                            userSelect: 'none',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                          }}
                          onClick={() => toggleExpanded(row.ticker)}
                          title={expandedTickers.has(row.ticker) ? 'Collapse details' : 'Expand details'}
                        >
                          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', width: 8 }}>
                            {expandedTickers.has(row.ticker) ? '▼' : '▶'}
                          </span>
                          {row.ticker}
                        </div>
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
                        <EditableAvgCostLine
                          value={row.command.avgCost}
                          check={row.checks?.avg}
                          positionId={row.command.positionId}
                          filledLotCount={row.command.filledLotCount}
                          onSaved={fetchData}
                        />
                        {row.multiStop && (
                          <div style={{
                            marginTop: 4, padding: '1px 5px', borderRadius: 3,
                            background: 'rgba(255,193,7,0.15)', color: '#ffc107',
                            fontSize: 9, fontWeight: 800, display: 'inline-block',
                          }}>{ibStops.length} STOPS</div>
                        )}
                      </td>
                    )}

                    {/* DIRECTION — POS rows only. Editable on CMD_POS. */}
                    {sr.direction != null
                      ? (sr.kind === 'CMD_POS' && row.command.positionId
                          ? <EditableDirectionCell
                              value={sr.direction}
                              check={sr.dirCheck}
                              positionId={row.command.positionId}
                              onSaved={fetchData}
                              bottomBorder={isLast}
                            />
                          : <Cell check={sr.dirCheck} bottomBorder={isLast}>{sr.direction}</Cell>)
                      : <EmptyCell bottomBorder={isLast} needsFill={needsFillIn(sr.kind, 'dir', rs)} />}

                    <td style={{ ...s.sourceLabel(sr.kind), borderBottom: isLast ? '1px solid rgba(255,255,255,0.12)' : 'none' }}>
                      {sr.source}
                    </td>

                    {/* SHARES — always shown (position shares or stop shares).
                        Inline-editable on CMD_POS and CMD_STOP rows — both map
                        to the same underlying position total (protective stop
                        always covers the full position). */}
                    {sr.shares != null
                      ? ((sr.kind === 'CMD_POS' || sr.kind === 'CMD_STOP') && row.command.positionId
                          ? <EditableSharesCell
                              value={sr.shares}
                              check={sr.sharesCheck}
                              positionId={row.command.positionId}
                              onSaved={fetchData}
                              bottomBorder={isLast}
                            />
                          : <Cell check={sr.sharesCheck} align="right" onClick={() => handleCellClick(row)} bottomBorder={isLast}>{fmtShares(sr.shares)}</Cell>)
                      : sr.noStop
                        ? <Cell check={sr.sharesCheck} align="right" onClick={() => handleCellClick(row)} bottomBorder={isLast}>0</Cell>
                        : <EmptyCell bottomBorder={isLast} align="right" needsFill={needsFillIn(sr.kind, 'shares', rs)} />}

                    {/* STOP SIDE — STOP rows only. On RATCHET rows we also
                        render the IB order type ('STOP LIMIT' / 'STOP') so the
                        user knows exactly what order to stage in TWS. */}
                    {sr.kind === 'IBKR_POS' || sr.kind === 'CMD_POS'
                      ? <EmptyCell bottomBorder={isLast} />
                      : (sr.stopSide != null || sr.noStop)
                        ? <Cell check={sr.stopSideCheck} bottomBorder={isLast}>
                            {sr.stopSide ?? (sr.noStop ? '—' : '')}
                            {sr.subKind === 'RATCHET' && sr.stopType && (
                              <span style={{
                                marginLeft: 5,
                                fontSize: 10,
                                fontWeight: 600,
                                color: 'rgba(255,255,255,0.55)',
                                letterSpacing: '0.03em',
                              }}>
                                {sr.stopType === 'STP LMT' ? 'STOP LIMIT'
                                 : sr.stopType === 'STP'   ? 'STOP'
                                 :                           sr.stopType}
                              </span>
                            )}
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

                    {/* NEXT RATCHET — renders on whichever row is flagged
                        showRatchetPlan (first IBKR_RATCHET stop or, when none
                        are staged, a dedicated RATCHET_PLAN row). Below the
                        divider so the protective flow reads cleanly. */}
                    {(() => {
                      const remaining = (row.lotTriggers || []).filter(t => !t.filled);
                      if (!sr.showRatchetPlan || remaining.length === 0) {
                        return <EmptyCell bottomBorder={isLast} />;
                      }
                      return (
                        <td
                          onClick={() => handleCellClick(row)}
                          style={{
                            padding: '4px 8px',
                            borderBottom: isLast ? '1px solid rgba(255,255,255,0.12)' : 'none',
                            cursor: row.actions?.some(a => a.type === 'ibkr') ? 'pointer' : 'default',
                            fontSize: 11, whiteSpace: 'nowrap',
                            fontVariantNumeric: 'tabular-nums', textAlign: 'right',
                          }}
                        >
                          {remaining.map(t => {
                            // If target shares is 0 the plan has nothing to
                            // add for this lot (position already at vitality /
                            // ticker-cap ceiling). No action needed → green.
                            const noAction = !t.targetShares || t.targetShares <= 0;
                            const dotStatus = noAction ? 'green'
                                            : t.staged ? 'green'
                                            :            'red';
                            const dotTitle = noAction
                              ? `Lot ${t.lot}: no shares to add (position already at size cap)`
                              : t.staged
                                ? `Lot ${t.lot}: ${t.expectedSide} STP @ $${t.triggerPrice.toFixed(2)} staged in IBKR`
                                : `Lot ${t.lot}: NO pending ${t.expectedSide} STP @ $${t.triggerPrice.toFixed(2)}`;
                            return (
                              <div key={t.lot} style={{
                                display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
                                gap: 2, lineHeight: '14px',
                              }}>
                                <Dot status={dotStatus} title={dotTitle} />
                                <span style={{ opacity: 0.5, fontSize: 9, marginRight: 2 }}>L{t.lot}</span>
                                <span>{fmtMoney(t.triggerPrice)}</span>
                                <span
                                  title={noAction
                                    ? '0 sh — position already at vitality/ticker-cap ceiling; no more shares to distribute'
                                    : `Plan calls for ${t.targetShares} sh at Lot ${t.lot}`}
                                  style={{
                                    marginLeft: 5, fontSize: 9,
                                    color: noAction
                                      ? 'rgba(255,255,255,0.28)'
                                      : 'rgba(255,255,255,0.45)',
                                    fontWeight: 500,
                                  }}
                                >{t.targetShares} sh</span>
                              </div>
                            );
                          })}
                        </td>
                      );
                    })()}

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
                  })}
                </tbody>
              </table>
              {expandedTickers.has(row.ticker) && (() => {
                const pos = findPositionByTicker(row.ticker);
                if (!pos) {
                  return (
                    <div style={{ padding: 14, fontSize: 11, color: '#888', fontStyle: 'italic' }}>
                      No active PNTHR position record for {row.ticker}.
                    </div>
                  );
                }
                return (
                  <div style={{ padding: '0 8px' }}>
                    <AssistantRowExpand
                      position={pos}
                      netLiquidity={netLiquidity}
                      onClose={() => toggleExpanded(row.ticker)}
                      onPositionChanged={fetchData}
                      onOpenChart={onOpenChart}
                    />
                  </div>
                );
              })()}
            </div>
          );
        })}
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
