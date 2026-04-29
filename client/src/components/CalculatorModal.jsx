// client/src/components/CalculatorModal.jsx
// ── Position Sizing Calculator — modal launched from Assistant top-bar ───────
//
// Day 1 UI consolidation: extracted from CommandCenter.jsx as a self-contained
// modal so the Command Center page can be retired. Behavior identical to the
// inline calculator that lived inside the Command Center — same Tier A pyramid
// (35-25-20-12-8), same /api/ticker/:symbol autocomplete, same sizePosition()
// math, same per-lot table.
//
// Data flow: modal self-fetches NAV when opened; ticker autocomplete on blur
// pulls current price + max gap + suggested direction + sector. "ADD TO
// PORTFOLIO" POSTs directly to /api/positions (same body shape the queue
// review confirm flow produces).
//
// Props:
//   open      (bool)  — show/hide
//   onClose   (fn)    — backdrop / Escape / Cancel
//   onCreated (fn?)   — called with new position id after successful save

import { useState, useEffect } from 'react';
import { API_BASE, authHeaders, fetchNav } from '../services/api';
import { sizePosition, buildLots, enrichLots } from '../utils/sizingUtils.js';

function Badge({ children, color = '#888', bg, small }) {
  return (
    <span style={{ display: 'inline-block', padding: small ? '1px 6px' : '2px 8px', borderRadius: 4,
      fontSize: small ? 10 : 11, fontWeight: 600, color, background: bg || 'rgba(255,255,255,0.06)',
      textTransform: 'uppercase', whiteSpace: 'nowrap', lineHeight: '18px', letterSpacing: '0.02em' }}>
      {children}
    </span>
  );
}

function SigBadge({ d }) {
  return d === 'LONG'
    ? <Badge color="#0f5132" bg="#d1e7dd">LONG</Badge>
    : <Badge color="#842029" bg="#f8d7da">SHORT</Badge>;
}

async function apiGet(path) {
  const res = await fetch(`${API_BASE || ''}${path}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export default function CalculatorModal({ open, onClose, onCreated }) {
  const [nav,     setNav]     = useState(null);
  const [f,       setF]       = useState({ ticker: '', entry: '', stop: '', gap: '', dir: 'LONG', sector: '' });
  const [result,  setResult]  = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    if (!open) return;
    setF({ ticker: '', entry: '', stop: '', gap: '', dir: 'LONG', sector: '' });
    setResult(null);
    setError(null);
    setSaving(false);
    fetchNav().then(setNav).catch(() => setNav(100000));
  }, [open]);

  if (!open) return null;

  const lookupTicker = async (ticker) => {
    if (ticker.length < 2) return;
    setLoading(true);
    try {
      const data = await apiGet(`/api/ticker/${ticker}`);
      if (data.found) {
        setF(prev => ({
          ...prev,
          entry:  data.currentPrice?.toFixed(2) || prev.entry,
          gap:    data.maxGapPct?.toFixed(1)    || prev.gap,
          dir:    data.suggestedDirection === 'SHORT' ? 'SHORT' : 'LONG',
          sector: data.sector || prev.sector,
        }));
      }
    } catch { /* user fills manually */ }
    setLoading(false);
  };

  const calc = () => {
    if (!f.entry || !f.stop || !nav) return;
    const p = sizePosition({ netLiquidity: nav, entryPrice: +f.entry, stopPrice: +f.stop, maxGapPct: +f.gap || 0, direction: f.dir });
    const l = buildLots({ entryPrice: +f.entry, stopPrice: +f.stop, totalShares: p.totalShares, direction: f.dir });
    setResult({ ...p, lots: enrichLots(l, +f.entry, +f.stop, f.dir), dir: f.dir, entry: +f.entry, stop: +f.stop });
  };

  const addToPortfolio = async () => {
    if (!result || saving) return;
    setSaving(true);
    setError(null);
    try {
      const fills = {
        1: { filled: true, price: result.entry, shares: result.lots[0].targetShares, date: new Date().toISOString().split('T')[0] },
      };
      for (let i = 2; i <= 5; i++) fills[i] = { filled: false };
      const body = {
        ticker:       f.ticker.trim().toUpperCase() || 'NEW',
        direction:    f.dir,
        signal:       f.dir === 'LONG' ? 'BL' : 'SS',
        entryPrice:   result.entry,
        originalStop: result.stop,
        stopPrice:    result.stop,
        maxGapPct:    +f.gap || 0,
        currentPrice: result.entry,
        fills,
        sector:       f.sector || '—',
        isETF:        false,
      };
      const r = await fetch(`${API_BASE}/api/positions`, {
        method:  'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
      await onCreated?.(data.id);
      onClose?.();
    } catch (e) {
      setError(e.message || 'Failed to save');
      setSaving(false);
    }
  };

  const isL = f.dir === 'LONG';
  const is = { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 6, padding: '8px 12px', color: '#e8e6e3', fontSize: 13, fontFamily: 'monospace',
    width: '100%', outline: 'none', boxSizing: 'border-box' };

  return (
    <div
      onClick={() => !saving && onClose?.()}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
        zIndex: 1100, display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: 20, overflowY: 'auto',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape' && !saving) onClose?.(); }}
        style={{
          background: '#111', border: '1px solid rgba(252,240,0,0.35)',
          borderRadius: 8, padding: 22,
          width: 920, maxWidth: '95vw',
          marginTop: 40, marginBottom: 40,
          color: '#e6e6e6', fontFamily: "'Inter', 'Segoe UI', sans-serif",
        }}
      >
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14,
        }}>
          <div style={{ color: '#FCF000', fontWeight: 900, fontSize: 14, letterSpacing: '0.1em' }}>
            🔢 POSITION CALCULATOR
          </div>
          <button
            type="button"
            onClick={() => onClose?.()}
            disabled={saving}
            style={{
              padding: '5px 12px', background: 'transparent',
              border: '1px solid rgba(255,255,255,0.2)', color: '#e6e6e6',
              borderRadius: 4, fontSize: 11, cursor: saving ? 'wait' : 'pointer', letterSpacing: '0.05em',
            }}
          >CLOSE ✕</button>
        </div>

        <div style={{ background: 'rgba(255,255,255,0.02)', borderRadius: 10, padding: 20, border: '1px solid rgba(255,255,255,0.06)', marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}><span style={{ color: '#FFD700' }}>+</span> New position</span>
            <Badge color="#FFD700" bg="rgba(255,215,0,0.08)" small>TIER A · 35-25-20-12-8</Badge>
            <span style={{ fontSize: 11, color: '#666', marginLeft: 'auto' }}>NAV ${nav?.toLocaleString() || '…'}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr 0.8fr 0.8fr auto', gap: 10, alignItems: 'end' }}>
            <div>
              <div style={{ fontSize: 10, color: '#666', marginBottom: 4, textTransform: 'uppercase' }}>Ticker</div>
              <input value={f.ticker} placeholder="FICO" onChange={e => setF(x => ({ ...x, ticker: e.target.value.toUpperCase() }))}
                onBlur={e => { if (e.target.value.length >= 2) lookupTicker(e.target.value); }}
                onKeyDown={e => { if (e.key === 'Tab' || e.key === 'Enter') lookupTicker(f.ticker); }}
                style={{ ...is, borderColor: loading ? 'rgba(255,215,0,0.4)' : undefined }} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: '#666', marginBottom: 4, textTransform: 'uppercase' }}>Entry {loading && <span style={{ color: '#FFD700' }}>⟳</span>}</div>
              <input value={f.entry} placeholder="125.00" type="number" onChange={e => setF(x => ({ ...x, entry: e.target.value }))} style={is} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: '#666', marginBottom: 4, textTransform: 'uppercase' }}>Stop</div>
              <input value={f.stop} placeholder="115.00" type="number" onChange={e => setF(x => ({ ...x, stop: e.target.value }))} style={is} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: '#666', marginBottom: 4, textTransform: 'uppercase' }}>Gap %</div>
              <input value={f.gap} placeholder="4.2" type="number" onChange={e => setF(x => ({ ...x, gap: e.target.value }))} style={is} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: '#666', marginBottom: 4, textTransform: 'uppercase' }}>Dir</div>
              <select value={f.dir} onChange={e => setF(x => ({ ...x, dir: e.target.value }))} style={{ ...is, fontFamily: 'sans-serif' }}>
                <option value="LONG">LONG</option>
                <option value="SHORT">SHORT</option>
              </select>
            </div>
            <button onClick={calc}
              style={{ background: '#FFD700', color: '#000', border: 'none', borderRadius: 6, padding: '8px 20px', fontWeight: 700, fontSize: 13, cursor: 'pointer', height: 38 }}>
              SIZE IT
            </button>
          </div>
        </div>

        {result && (
          <div style={{ background: 'rgba(255,255,255,0.02)', borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)', overflow: 'hidden' }}>
            <div style={{ padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 20, fontWeight: 800, fontFamily: 'monospace' }}>{f.ticker || '—'}</span>
                <SigBadge d={f.dir} />
                {result.gapProne && <Badge color="#664d03" bg="#fff3cd" small>GAP PRONE</Badge>}
              </div>
              <div style={{ display: 'flex', gap: 20 }}>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 10, color: '#666' }}>Total</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#FFD700', fontFamily: 'monospace' }}>{result.totalShares} shr</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 10, color: '#666' }}>Max risk</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#28a745', fontFamily: 'monospace' }}>${result.maxRisk$.toLocaleString()}</div>
                </div>
              </div>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'monospace' }}>
              <thead>
                <tr style={{ fontSize: 9, color: '#555', textTransform: 'uppercase', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  {['Lot','Name','Shares','%', isL ? 'Buy @' : 'Short @', '+%', 'Cost', 'Cumul', 'Avg', 'Rec stop', 'Order'].map(h => (
                    <th key={h} style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.lots.map((l, i) => (
                  <tr key={i} style={{ background: i === 0 ? 'rgba(255,215,0,0.04)' : 'transparent', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                    <td style={{ padding: '10px 8px', fontWeight: 700, color: i === 0 ? '#FFD700' : '#aaa', textAlign: 'right' }}>#{l.lot}</td>
                    <td style={{ padding: '10px 8px', fontFamily: 'sans-serif', fontSize: 11, fontWeight: 600, color: i === 0 ? '#FFD700' : '#aaa', textAlign: 'right' }}>{l.name}</td>
                    <td style={{ padding: '10px 8px', textAlign: 'right', fontWeight: 700, fontSize: 14 }}>{l.targetShares}</td>
                    <td style={{ padding: '10px 8px', textAlign: 'right', color: '#777' }}>{l.pctLabel}%</td>
                    <td style={{ padding: '10px 8px', textAlign: 'right', fontWeight: 700, color: '#FFD700', fontSize: 14 }}>${l.triggerPrice}</td>
                    <td style={{ padding: '10px 8px', textAlign: 'right', color: '#666' }}>{l.offsetPct > 0 ? `+${l.offsetPct}%` : 'entry'}</td>
                    <td style={{ padding: '10px 8px', textAlign: 'right', color: '#777' }}>${(l.targetShares * l.triggerPrice).toFixed(0)}</td>
                    <td style={{ padding: '10px 8px', textAlign: 'right', color: '#aaa' }}>{result.lots.slice(0, i + 1).reduce((s, x) => s + x.targetShares, 0)}</td>
                    <td style={{ padding: '10px 8px', textAlign: 'right', color: '#888' }}>${l.avgCost || l.triggerPrice}</td>
                    <td style={{ padding: '10px 8px', textAlign: 'right', color: '#888', fontSize: 11 }}>${l.recommendedStop}</td>
                    <td style={{ padding: '10px 8px', textAlign: 'right' }}>
                      {i === 0 ? <Badge color="#000" bg="#FFD700" small>MARKET</Badge>
                      : i === 1 ? <Badge color="#664d03" bg="#fff3cd" small>{isL ? 'BUY' : 'SELL'}+5D</Badge>
                      : <Badge color="#FFD700" bg="rgba(255,215,0,0.1)" small>{isL ? 'BUY' : 'SELL'} LMT</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ padding: '12px 20px', background: 'rgba(0,0,0,0.15)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: '#666' }}>Entry: ${result.entry} · Stop: ${result.stop} · Risk: {result.structRisk}% · Gap: {result.gapMult}×</span>
              <button
                onClick={addToPortfolio}
                disabled={saving}
                style={{ background: saving ? 'rgba(255,215,0,0.5)' : '#FFD700', color: '#000', border: 'none', borderRadius: 6, padding: '8px 20px', fontWeight: 700, fontSize: 12, cursor: saving ? 'wait' : 'pointer' }}>
                {saving ? 'SAVING…' : 'ADD TO PORTFOLIO'}
              </button>
            </div>
          </div>
        )}

        {error && (
          <div style={{
            padding: '8px 10px', marginTop: 12,
            background: 'rgba(220,53,69,0.1)',
            border: '1px solid rgba(220,53,69,0.4)',
            borderRadius: 4, color: '#dc3545',
            fontSize: 12, fontWeight: 600,
          }}>{error}</div>
        )}
      </div>
    </div>
  );
}
