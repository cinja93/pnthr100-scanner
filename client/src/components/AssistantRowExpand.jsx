// client/src/components/AssistantRowExpand.jsx
// ── Click-to-expand row detail panel for Assistant LIVE table ───────────────
//
// Day 1 build (2026-04-29 evening): replaced the original read-only lot grid
// with the full PyramidCard from CommandCenter (named-imported as a reuse —
// Day 2 cleanup will move PyramidCard to its own file). The expand panel now
// gives users every per-position control they previously had in Command
// Center, inline below the LIVE row:
//
//   • Lot 1-5 fill / edit / unfill (inherits CommandCenter's auto-ratchet
//     confirmation modal for Lots 2-5, breakeven logic for Lots 3+)
//   • Direction toggle (LONG ⇄ SHORT) with confirmation
//   • Stop edit + manual avg-cost edit + manual price override
//   • Manual exit panel + canonical close
//   • Plus a separate Stop History section beneath the card (last 5 ratchet
//     entries with "Show all" reveal — value-add over Command Center).
//
// All write callbacks below post directly to /api/positions or the position-
// specific endpoints — same wire format Command Center uses, just without the
// optimistic local-state updates (we re-fetch via onPositionChanged instead).

import { useState, useMemo, useCallback } from 'react';
import { API_BASE, authHeaders } from '../services/api';
import { PyramidCard } from './pyramid';

function fmtMoney(n) {
  if (n == null || !Number.isFinite(+n)) return '—';
  return `$${(+n).toFixed(2)}`;
}
function fmtDate(s) {
  if (!s) return '—';
  try { return new Date(s).toISOString().slice(0, 10); } catch { return String(s).slice(0, 10); }
}

async function apiPost(path, body) {
  const res = await fetch(`${API_BASE || ''}${path}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

async function apiDelete(path) {
  const res = await fetch(`${API_BASE || ''}${path}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

async function apiPatch(path, body) {
  const res = await fetch(`${API_BASE || ''}${path}`, {
    method: 'PATCH',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

export default function AssistantRowExpand({ position, netLiquidity, onClose, onPositionChanged, onOpenChart }) {
  const [showAllStops, setShowAllStops] = useState(false);
  const [error,        setError]        = useState(null);

  // ── PyramidCard callbacks — each writes via the same wire format
  // CommandCenter uses, then triggers a parent refresh so the panel re-renders
  // with the new position state. No optimistic updates here; the LIVE table's
  // 60s reconcile poll provides the eventual-consistency baseline anyway.
  const refresh = useCallback(() => { onPositionChanged?.(); }, [onPositionChanged]);

  const handleUpdate = useCallback(async (id, fields) => {
    try { await apiPost('/api/positions', { id, ...fields }); refresh(); }
    catch (e) { setError(e.message || 'Save failed'); }
  }, [refresh]);

  const handleUpdateStop = useCallback(async (id, newStop) => {
    try { await apiPost('/api/positions', { id, stopPrice: newStop }); refresh(); }
    catch (e) { setError(e.message || 'Stop save failed'); }
  }, [refresh]);

  const handleUpdatePrice = useCallback(async (id, newPrice) => {
    const override = { price: +newPrice, setAt: new Date().toISOString(), active: true };
    try { await apiPost('/api/positions', { id, manualPriceOverride: override }); refresh(); }
    catch (e) { setError(e.message || 'Price save failed'); }
  }, [refresh]);

  const handleClearOverride = useCallback(async (id) => {
    try { await apiPost('/api/positions', { id, 'manualPriceOverride.active': false }); refresh(); }
    catch (e) { setError(e.message || 'Override clear failed'); }
  }, [refresh]);

  const handleDelete = useCallback(async (id) => {
    if (!window.confirm('Delete this position permanently? This removes the record entirely (use only for mistaken entries — for normal exits use the Close button).')) return;
    try { await apiDelete(`/api/positions/${id}`); refresh(); onClose?.(); }
    catch (e) { setError(e.message || 'Delete failed'); }
  }, [refresh, onClose]);

  const handleExitConfirmed = useCallback(() => { refresh(); }, [refresh]);

  const handleField = useCallback(async (id, fields) => {
    try { await apiPost('/api/positions', { id, ...fields }); refresh(); }
    catch (e) { setError(e.message || 'Field save failed'); }
  }, [refresh]);

  const handleDirectionChange = useCallback(async (id, newDir) => {
    try {
      await apiPatch(`/api/positions/${id}/direction`, { direction: newDir });
      refresh();
    } catch (e) { setError(e.message || 'Direction change failed'); }
  }, [refresh]);

  // ── Stop history (separate section — PyramidCard doesn't surface this) ───
  const stopHist = Array.isArray(position?.stopHistory) ? position.stopHistory : [];
  const visibleStops = showAllStops ? stopHist : stopHist.slice(-5);

  if (!position) return null;

  return (
    <div style={{
      background: 'rgba(252,240,0,0.03)',
      border: '1px solid rgba(252,240,0,0.18)',
      borderRadius: 6,
      padding: 12,
      margin: '6px 0 14px 0',
      color: '#e6e6e6',
      fontFamily: "'Inter', 'Segoe UI', sans-serif",
    }}>
      {/* Collapse affordance (PyramidCard owns the rest of the header) */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
        <button
          type="button"
          onClick={() => onClose?.()}
          style={{
            padding: '3px 10px', background: 'transparent',
            border: '1px solid rgba(255,255,255,0.2)',
            color: '#aaa', borderRadius: 4, fontSize: 10, cursor: 'pointer',
            letterSpacing: '0.05em',
          }}
        >COLLAPSE ✕</button>
      </div>

      {/* Full editable PyramidCard — same component CommandCenter renders. */}
      <PyramidCard
        position={position}
        netLiquidity={netLiquidity || 100000}
        onUpdate={handleUpdate}
        onUpdateStop={handleUpdateStop}
        onUpdatePrice={handleUpdatePrice}
        onClearOverride={handleClearOverride}
        onDelete={handleDelete}
        onExitConfirmed={handleExitConfirmed}
        onOpenChart={onOpenChart}
        onField={handleField}
        onDirectionChange={handleDirectionChange}
        flashed={false}
      />

      {/* Extended-hours stop opt-in (Phase 4 — STP LMT outside RTH).
          Default off. When on, the next 4a auto-place / 4c stop-sync uses
          STP LMT with a 0.5% slippage cushion so the order can fill in
          thin pre/post-market liquidity. Hard-gap fill risk warning shown
          inline so the user understands the trade-off. */}
      <div style={{
        marginTop: 10, padding: '8px 12px',
        background: 'rgba(0,0,0,0.2)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 6,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
      }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12 }}>
          <input
            type="checkbox"
            checked={!!position.stopExtendedHours}
            onChange={async (e) => {
              const next = e.target.checked;
              if (next && !window.confirm(
                'Enable extended-hours stop protection?\n\n' +
                'PNTHR will place STP LMT (stop-limit) instead of pure STP for this position. ' +
                'This protects against pre/post-market price moves but introduces FILL RISK on a hard gap — ' +
                'if price gaps past the limit, the order may not fill. Default cushion is 0.5%.'
              )) return;
              await handleField(position.id, { stopExtendedHours: next });
            }}
          />
          <span style={{ color: position.stopExtendedHours ? '#fcf000' : '#aaa', fontWeight: 600 }}>
            Extended-hours stop protection
          </span>
          {position.stopExtendedHours && (
            <span style={{
              fontSize: 10, padding: '2px 6px', borderRadius: 3,
              background: 'rgba(252,240,0,0.15)', color: '#fcf000', letterSpacing: '0.05em',
            }}>STP LMT · 0.5% cushion · hard-gap fill risk</span>
          )}
        </label>
      </div>

      {/* Stop history — value-add over Command Center */}
      {stopHist.length > 0 && (
        <div style={{
          marginTop: 12, padding: '10px 14px',
          background: 'rgba(0,0,0,0.2)',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: 6,
        }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginBottom: 6,
            fontSize: 10, fontWeight: 800, letterSpacing: '0.1em',
            color: '#FCF000', textTransform: 'uppercase',
          }}>
            <span>Stop History <span style={{ color: '#888', fontWeight: 400 }}>({stopHist.length})</span></span>
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
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 4,
            maxHeight: showAllStops ? 240 : 'none',
            overflowY: showAllStops ? 'auto' : 'visible',
          }}>
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
                    <span style={{ color: '#666', marginLeft: 6 }}>← {fmtMoney(h.from)}</span>
                  )}
                </div>
                <div>
                  <span style={{ color: '#888' }}>{fmtDate(h.date)}</span>
                  <span style={{ color: '#555', marginLeft: 6, fontSize: 9 }}>{h.reason || '—'}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

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
