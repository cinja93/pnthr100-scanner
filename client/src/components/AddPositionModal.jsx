// client/src/components/AddPositionModal.jsx
// ── Add Position modal — launched from Assistant top-bar [+ Add Position] ───
//
// Day 1 UI consolidation: replaces the per-CommandCenter AddCommandPositionModal.
// Same lot-1 entry form + validation, plus an opt-in ticker autocomplete that
// pulls KillScore / sector / current price / suggested direction from
// /api/ticker/:symbol on blur. Per locked decision #1 the user can override
// any pre-filled field — autocomplete is a head-start, not a hard fill.
//
// "Suggested PNTHR Stop" is auto-filled from /api/ticker/:symbol when the
// signalService cache has a live BL/SS for the ticker. Source of truth is
// stopCalculation.js (Wilder ATR(3) + 2-week structural floor, ratcheted
// forward for active positions). User can override the field — autofill is
// a head-start, not a hard fill.
//
// Props:
//   open      (bool)  — show/hide
//   initial   (obj?)  — pre-fill { ticker, direction, shares, entryPrice, stopPrice, sector }
//                       (e.g. when launched from QueueReviewPanel "Send to Command")
//   onClose   (fn)    — backdrop / Escape / Cancel
//   onSaved   (fn?)   — called with new position id after successful save

import { useState, useEffect, useRef } from 'react';
import { API_BASE, authHeaders } from '../services/api';

const todayISO = () => new Date().toISOString().split('T')[0];

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

export default function AddPositionModal({ open, initial, onClose, onSaved }) {
  const [ticker,     setTicker]     = useState('');
  const [direction,  setDirection]  = useState('LONG');
  const [shares,     setShares]     = useState('');
  const [entryPrice, setEntryPrice] = useState('');
  const [stopPrice,  setStopPrice]  = useState('');
  const [fillDate,   setFillDate]   = useState(todayISO());
  const [sector,     setSector]     = useState('');
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState(null);
  const [warning,    setWarning]    = useState(null);

  // Autocomplete state
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupHit,     setLookupHit]     = useState(null); // { killScore, killTier, currentPrice, sector, suggestedDirection, companyName }

  const tickerRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setTicker(initial?.ticker?.toUpperCase() || '');
    setDirection(initial?.direction || 'LONG');
    setShares(initial?.shares != null ? String(initial.shares) : '');
    setEntryPrice(initial?.entryPrice != null ? String(initial.entryPrice) : '');
    setStopPrice(initial?.stopPrice != null ? String(initial.stopPrice) : '');
    setFillDate(todayISO());
    setSector(initial?.sector || '');
    setError(null);
    setWarning(null);
    setSaving(false);
    setLookupLoading(false);
    setLookupHit(null);
    setTimeout(() => tickerRef.current?.focus(), 50);

    // If launched with a pre-filled ticker (e.g. from QueueReviewPanel), kick off
    // an autocomplete fetch so the KillScore badge populates without a manual blur.
    if (initial?.ticker) {
      lookupTicker(initial.ticker.toUpperCase(), { onlyEnrich: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial]);

  if (!open) return null;

  // Autocomplete: pull KillScore + sector + currentPrice + suggested direction
  // for the ticker. `onlyEnrich` mode skips overwriting fields the user (or the
  // `initial` prop) already set — useful when this modal is launched pre-filled
  // from the queue and we just want the KillScore badge.
  async function lookupTicker(t, { onlyEnrich = false } = {}) {
    const sym = (t || '').trim().toUpperCase();
    if (sym.length < 2) return;
    setLookupLoading(true);
    try {
      const r = await fetch(`${API_BASE}/api/ticker/${sym}`, { headers: authHeaders() });
      const data = await r.json();
      if (!r.ok || !data?.found) { setLookupHit(null); return; }
      setLookupHit({
        killScore:          data.killScore,
        killTier:           data.killTier,
        killConfirmation:   data.killConfirmation,
        currentPrice:       data.currentPrice,
        sector:             data.sector,
        suggestedDirection: data.suggestedDirection,
        suggestedStop:      data.suggestedStop,
        pnthrSignal:        data.pnthrSignal,
        companyName:        data.companyName,
        signalAge:          data.signalAge,
      });
      // Pre-fill empty fields only — user (or `initial`) wins on every conflict.
      if (data.currentPrice && (!entryPrice || onlyEnrich === false && !entryPrice.trim())) {
        if (!entryPrice) setEntryPrice(String(data.currentPrice.toFixed(2)));
      }
      if (data.sector && !sector) setSector(data.sector);
      if (data.suggestedDirection && !initial?.direction && !onlyEnrich) {
        setDirection(data.suggestedDirection);
      }
      // Algorithmic PNTHR stop pre-fill — empty fields only, user wins on edit.
      if (data.suggestedStop != null && !stopPrice) {
        setStopPrice(String(data.suggestedStop.toFixed(2)));
      }
    } catch {
      setLookupHit(null);
    } finally {
      setLookupLoading(false);
    }
  }

  const validate = () => {
    if (!ticker.trim()) return { blocking: true, message: 'Ticker required' };
    if (!['LONG', 'SHORT'].includes(direction)) return { blocking: true, message: 'Direction required' };
    const nShares = Number(shares);
    if (!Number.isFinite(nShares) || nShares <= 0 || !Number.isInteger(nShares)) return { blocking: true, message: 'Shares must be a positive integer' };
    const nEntry = Number(entryPrice);
    if (!Number.isFinite(nEntry) || nEntry <= 0) return { blocking: true, message: 'Entry price must be positive' };
    const nStop = Number(stopPrice);
    if (!Number.isFinite(nStop) || nStop <= 0) return { blocking: true, message: 'Stop price must be positive' };
    if (direction === 'LONG'  && nStop >= nEntry) return { blocking: false, message: 'Long stop is at or above entry — usually means stop has been ratcheted past entry. Click ADD ANYWAY to proceed.' };
    if (direction === 'SHORT' && nStop <= nEntry) return { blocking: false, message: 'Short stop is at or below entry — usually means stop has been ratcheted past entry. Click ADD ANYWAY to proceed.' };
    return null;
  };

  const clearWarning = () => { if (warning) setWarning(null); };

  const save = async () => {
    const v = validate();
    if (v?.blocking) { setError(v.message); setWarning(null); return; }
    if (v && !v.blocking) {
      if (warning !== v.message) {
        setWarning(v.message);
        setError(null);
        return;
      }
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

  // KillScore badge color logic — mirrors PNTHR Kill page tier colors.
  const tierColor = (tier) => {
    if (!tier) return '#666';
    if (tier === 'ALPHA PNTHR KILL') return '#FFD700';
    if (tier === 'STRIKING') return '#FF8C00';
    if (tier === 'HUNTING')  return '#4A90D9';
    if (tier === 'POUNCING') return '#5B8C5A';
    return '#888';
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
          width: 460, maxWidth: '95vw',
          color: '#e6e6e6', fontFamily: "'Inter', 'Segoe UI', sans-serif",
        }}
      >
        <div style={{
          color: '#FCF000', fontWeight: 900, fontSize: 14,
          letterSpacing: '0.1em', marginBottom: 14,
        }}>+ ADD POSITION</div>

        {field('TICKER',
          <div style={{ position: 'relative' }}>
            <input
              ref={tickerRef}
              type="text"
              value={ticker}
              disabled={saving || !!initial?.ticker}
              onChange={(e) => { setTicker(e.target.value.toUpperCase()); setLookupHit(null); }}
              onBlur={(e) => { if (e.target.value.trim().length >= 2) lookupTicker(e.target.value); }}
              onKeyDown={(e) => { if (e.key === 'Tab' || e.key === 'Enter') lookupTicker(ticker); }}
              placeholder="AMZN"
              style={{ ...inputStyle, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700,
                paddingRight: lookupLoading ? 30 : 9,
                borderColor: lookupLoading ? 'rgba(252,240,0,0.4)' : (lookupHit ? 'rgba(40,167,69,0.4)' : 'rgba(255,255,255,0.15)') }}
            />
            {lookupLoading && (
              <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: '#FCF000', fontSize: 12 }}>⟳</span>
            )}
          </div>
        )}

        {/* Kill / sector / suggested-direction summary card — appears on autocomplete hit */}
        {lookupHit && (
          <div style={{
            marginBottom: 12, padding: '8px 10px',
            background: 'rgba(40,167,69,0.06)',
            border: '1px solid rgba(40,167,69,0.25)',
            borderRadius: 4, fontSize: 11,
            display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10,
          }}>
            {lookupHit.companyName && (
              <span style={{ color: '#aaa', fontStyle: 'italic' }}>{lookupHit.companyName}</span>
            )}
            {lookupHit.killScore != null && (
              <span style={{
                color: tierColor(lookupHit.killTier), fontWeight: 800, fontSize: 12,
              }}>
                Kill {Math.round(lookupHit.killScore)}{lookupHit.killTier ? ` · ${lookupHit.killTier}` : ''}
              </span>
            )}
            {lookupHit.suggestedDirection && (
              <span style={{
                color: lookupHit.suggestedDirection === 'SHORT' ? '#dc3545' : '#28a745',
                fontWeight: 700,
              }}>
                {lookupHit.suggestedDirection}{lookupHit.signalAge != null ? ` · ${lookupHit.signalAge}w` : ''}
              </span>
            )}
            {lookupHit.currentPrice && (
              <span style={{ color: '#888' }}>
                Last ${lookupHit.currentPrice.toFixed(2)}
              </span>
            )}
            {lookupHit.sector && (
              <span style={{ color: '#888' }}>{lookupHit.sector}</span>
            )}
            <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: 10, marginLeft: 'auto' }}>
              All fields editable below
            </span>
          </div>
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
              placeholder={direction === 'SHORT' ? 'above entry' : 'below entry'}
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
          </select>, 'Auto-filled from ticker lookup when available'
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
          >{saving ? 'SAVING…' : warning ? 'ADD ANYWAY' : 'ADD POSITION'}</button>
        </div>
      </div>
    </div>
  );
}
