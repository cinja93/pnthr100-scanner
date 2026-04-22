// client/src/components/AddCommandPositionModal.jsx
// ── "+" quick-add Command position modal ──────────────────────────────────────
//
// Shared by the "+" button in Command Center and (future) the ADD box in the
// PNTHR Assistant LIVE table. Creates an active position in pnthr_portfolio
// with lot 1 pre-filled — same shape the pending-entry confirm flow produces,
// minus the chart/queue round trip.
//
// Props:
//   open        (bool)    — show/hide
//   initial     (obj?)    — optional pre-fill { ticker, direction, shares, entryPrice, stopPrice }
//   onClose     (fn)      — called when user cancels/saves
//   onSaved     (fn)      — called after successful save (position id passed)

import { useState, useEffect, useRef } from 'react';
import { API_BASE, authHeaders } from '../services/api';

const todayISO = () => new Date().toISOString().split('T')[0];

// Canonical GICS sectors used throughout PNTHR (see server/sectorUtils.js).
// Keep in sync with KNOWN_SECTORS there.
const SECTORS = [
  'Technology',
  'Healthcare',
  'Financial Services',
  'Consumer Discretionary',
  'Consumer Staples',
  'Communication Services',
  'Industrials',
  'Basic Materials',
  'Real Estate',
  'Utilities',
  'Energy',
];

export default function AddCommandPositionModal({ open, initial, onClose, onSaved }) {
  const [ticker,     setTicker]     = useState('');
  const [direction,  setDirection]  = useState('LONG');
  const [shares,     setShares]     = useState('');
  const [entryPrice, setEntryPrice] = useState('');
  const [stopPrice,  setStopPrice]  = useState('');
  const [fillDate,   setFillDate]   = useState(todayISO());
  const [sector,     setSector]     = useState('');
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState(null);
  const [warning,    setWarning]    = useState(null); // non-blocking; shows 'ADD ANYWAY' on next click
  const tickerRef = useRef(null);

  // Reset when opening, pre-fill from `initial` if provided
  useEffect(() => {
    if (!open) return;
    setTicker(initial?.ticker?.toUpperCase() || '');
    setDirection(initial?.direction || 'LONG');
    setShares(initial?.shares != null ? String(initial.shares) : '');
    setEntryPrice(initial?.entryPrice != null ? String(initial.entryPrice) : '');
    setStopPrice(initial?.stopPrice != null ? String(initial.stopPrice) : '');
    setFillDate(todayISO());
    setSector('');
    setError(null);
    setWarning(null);
    setSaving(false);
    // Focus ticker if empty, otherwise shares
    setTimeout(() => tickerRef.current?.focus(), 50);
  }, [open, initial]);

  if (!open) return null;

  // Returns { blocking: true, message } for hard errors, { blocking: false, message }
  // for soft warnings the user can bypass (e.g. stop already ratcheted past entry),
  // or null if the form is clean.
  const validate = () => {
    if (!ticker.trim()) return { blocking: true, message: 'Ticker required' };
    if (!['LONG', 'SHORT'].includes(direction)) return { blocking: true, message: 'Direction required' };
    const nShares = Number(shares);
    if (!Number.isFinite(nShares) || nShares <= 0 || !Number.isInteger(nShares)) return { blocking: true, message: 'Shares must be a positive integer' };
    const nEntry = Number(entryPrice);
    if (!Number.isFinite(nEntry) || nEntry <= 0) return { blocking: true, message: 'Entry price must be positive' };
    const nStop = Number(stopPrice);
    if (!Number.isFinite(nStop) || nStop <= 0) return { blocking: true, message: 'Stop price must be positive' };
    // Soft warnings — stop on "wrong" side usually means stop has already been
    // ratcheted past entry on a position that's been open for a while. Flag it
    // but let the user proceed on a second click.
    if (direction === 'LONG'  && nStop >= nEntry) return { blocking: false, message: 'Long stop is at or above entry — this usually means the stop has already been ratcheted past entry. Click ADD ANYWAY to proceed.' };
    if (direction === 'SHORT' && nStop <= nEntry) return { blocking: false, message: 'Short stop is at or below entry — this usually means the stop has already been ratcheted past entry. Click ADD ANYWAY to proceed.' };
    return null;
  };

  // When the user edits any field, clear the warning so they re-confirm if still valid.
  const clearWarning = () => { if (warning) setWarning(null); };

  const save = async () => {
    const v = validate();
    if (v?.blocking) { setError(v.message); setWarning(null); return; }
    if (v && !v.blocking) {
      // Non-blocking warning — show it and require a second click before saving
      if (warning !== v.message) {
        setWarning(v.message);
        setError(null);
        return;
      }
      // warning was already shown; user clicked again → proceed
    }
    setSaving(true);
    setError(null);
    setWarning(null);
    try {
      const nShares = Number(shares);
      const nEntry  = Number(entryPrice);
      const nStop   = Number(stopPrice);
      const fills = {
        1: { filled: true, price: nEntry, shares: nShares, date: fillDate },
        2: { filled: false },
        3: { filled: false },
        4: { filled: false },
        5: { filled: false },
      };
      const body = {
        ticker:       ticker.trim().toUpperCase(),
        direction,
        signal:       direction === 'LONG' ? 'BL' : 'SS',
        entryPrice:   nEntry,
        originalStop: nStop,
        stopPrice:    nStop,
        currentPrice: nEntry,
        fills,
        sector:       sector.trim() || '—',
        isETF:        false,
      };
      const r = await fetch(`${API_BASE}/api/positions`, {
        method:  'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
      await onSaved?.(data.id);
      onClose?.();
    } catch (e) {
      setError(e.message || 'Failed to save');
      setSaving(false);
    }
  };

  const field = (label, node, hint) => (
    <div style={{ marginBottom: 10 }}>
      <label style={{
        display: 'block', fontSize: 10, fontWeight: 800, letterSpacing: '0.08em',
        color: 'rgba(255,255,255,0.5)', marginBottom: 3,
      }}>{label}</label>
      {node}
      {hint && <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>{hint}</div>}
    </div>
  );

  const inputStyle = {
    width: '100%',
    padding: '7px 9px',
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: 4,
    color: '#e6e6e6',
    fontSize: 13,
    fontVariantNumeric: 'tabular-nums',
    outline: 'none',
    boxSizing: 'border-box',
  };

  return (
    <div
      onClick={() => !saving && onClose?.()}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
        zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !saving) onClose?.();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
        }}
        style={{
          background: '#111', border: '1px solid rgba(252,240,0,0.35)',
          borderRadius: 8, padding: 22,
          width: 420, maxWidth: '95vw',
          color: '#e6e6e6', fontFamily: "'Inter', 'Segoe UI', sans-serif",
        }}
      >
        <div style={{
          color: '#FCF000', fontWeight: 900, fontSize: 14,
          letterSpacing: '0.1em', marginBottom: 14,
        }}>ADD COMMAND POSITION</div>

        {field('TICKER',
          <input
            ref={tickerRef}
            type="text"
            value={ticker}
            disabled={saving || !!initial?.ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            placeholder="AMZN"
            style={{ ...inputStyle, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 }}
          />
        )}

        {field('DIRECTION',
          <div style={{ display: 'flex', gap: 8 }}>
            {['LONG', 'SHORT'].map(d => (
              <button
                key={d}
                type="button"
                disabled={saving}
                onClick={() => { setDirection(d); clearWarning(); }}
                style={{
                  flex: 1, padding: '6px 10px',
                  background: direction === d
                    ? (d === 'LONG' ? 'rgba(40,167,69,0.18)' : 'rgba(220,53,69,0.18)')
                    : 'rgba(255,255,255,0.05)',
                  border: `1px solid ${direction === d
                    ? (d === 'LONG' ? '#28a745' : '#dc3545')
                    : 'rgba(255,255,255,0.15)'}`,
                  color: direction === d
                    ? (d === 'LONG' ? '#28a745' : '#dc3545')
                    : 'rgba(255,255,255,0.7)',
                  borderRadius: 4, fontSize: 12, fontWeight: 700,
                  letterSpacing: '0.05em', cursor: 'pointer',
                }}
              >{d}</button>
            ))}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {field('SHARES',
            <input
              type="number" min="1" step="1"
              value={shares}
              disabled={saving}
              onChange={(e) => setShares(e.target.value)}
              placeholder="10"
              style={inputStyle}
            />
          )}
          {field('ENTRY PRICE',
            <input
              type="number" min="0" step="0.01"
              value={entryPrice}
              disabled={saving}
              onChange={(e) => { setEntryPrice(e.target.value); clearWarning(); }}
              placeholder="251.56"
              style={inputStyle}
            />
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {field('STOP PRICE',
            <input
              type="number" min="0" step="0.01"
              value={stopPrice}
              disabled={saving}
              onChange={(e) => { setStopPrice(e.target.value); clearWarning(); }}
              placeholder="230.63"
              style={inputStyle}
            />
          )}
          {field('FILL DATE',
            <input
              type="date"
              value={fillDate}
              disabled={saving}
              onChange={(e) => setFillDate(e.target.value)}
              style={inputStyle}
            />
          )}
        </div>

        {field('SECTOR (OPTIONAL)',
          <select
            value={sector}
            disabled={saving}
            onChange={(e) => setSector(e.target.value)}
            style={{ ...inputStyle, appearance: 'none', cursor: 'pointer' }}
          >
            <option value="">— select sector —</option>
            {SECTORS.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>, 'Leave blank if unknown — can be edited later'
        )}

        {error && (
          <div style={{
            padding: '8px 10px', marginBottom: 10,
            background: 'rgba(220,53,69,0.1)',
            border: '1px solid rgba(220,53,69,0.4)',
            borderRadius: 4, color: '#dc3545',
            fontSize: 12, fontWeight: 600,
          }}>{error}</div>
        )}

        {warning && !error && (
          <div style={{
            padding: '8px 10px', marginBottom: 10,
            background: 'rgba(255,193,7,0.1)',
            border: '1px solid rgba(255,193,7,0.5)',
            borderRadius: 4, color: '#ffc107',
            fontSize: 12, fontWeight: 600,
          }}>⚠ {warning}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
          <button
            type="button"
            onClick={() => onClose?.()}
            disabled={saving}
            style={{
              padding: '7px 16px',
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.2)',
              color: '#e6e6e6', borderRadius: 4, fontSize: 12,
              cursor: saving ? 'wait' : 'pointer',
            }}
          >Cancel</button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            style={{
              padding: '7px 22px',
              background: saving ? 'rgba(252,240,0,0.5)'
                        : warning ? '#ffc107'
                        : '#FCF000',
              border: `1px solid ${warning ? '#ffc107' : '#FCF000'}`,
              color: '#000', borderRadius: 4,
              fontSize: 12, fontWeight: 800, letterSpacing: '0.05em',
              cursor: saving ? 'wait' : 'pointer',
            }}
          >{saving ? 'SAVING…' : warning ? 'ADD ANYWAY' : 'ADD TO COMMAND'}</button>
        </div>
      </div>
    </div>
  );
}
