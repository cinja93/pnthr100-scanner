import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch, authHeaders, API_BASE } from '../services/api';

// PNTHR POUNCE — the pullback (ambush) strategy, PAPER book. Sister to PNTHR Tree,
// shown on the same page in the fund's black-and-yellow so it can never be mistaken
// for Tree's green live book. Self-contained: polls /api/pnthr-pounce, admin-only.
const GOLD = '#facc15', GOLD_DIM = '#a3891f', PANEL_BG = '#0a0a0a';

function ModeBtn({ label, active, onClick, disabled, title }) {
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      style={{
        padding: '7px 14px', borderRadius: 7, fontSize: 12, fontWeight: 800, letterSpacing: '0.03em',
        cursor: disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
        background: active ? GOLD : '#161616', color: active ? '#000' : (disabled ? '#555' : GOLD),
        border: `1px solid ${active ? GOLD : '#333'}`, opacity: disabled ? 0.5 : 1,
      }}>{label}</button>
  );
}

export default function PouncePanel() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch(`${API_BASE}/api/pnthr-pounce`, { headers: authHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json()); setErr(null);
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); const id = setInterval(load, 30000); return () => clearInterval(id); }, [load]);

  const setMode = async (mode) => {
    setBusy(true);
    try { await apiFetch(`${API_BASE}/api/admin/pnthr-pounce/mode`, { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) }); await load(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const resetPaper = async () => {
    if (!window.confirm('Reset the PNTHR Pounce PAPER book? Clears all paper positions and trades. Does NOT touch Tree or any live account.')) return;
    setBusy(true);
    try { await apiFetch(`${API_BASE}/api/admin/pnthr-pounce/reset`, { method: 'POST', headers: authHeaders() }); await load(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const mode = data?.mode || 'off';
  const funnel = data?.funnel || [];
  const positions = data?.positions || [];
  const pounce = funnel.filter(f => f.state === 'pounce');
  const approaching = funnel.filter(f => f.state === 'approaching');
  const stalkingN = funnel.filter(f => f.state === 'stalking').length;
  const bookPnl = positions.reduce((a, p) => a + (p.pnl || 0), 0);
  const num = (v, d = 2) => (typeof v === 'number' ? v.toFixed(d) : '—');

  return (
    <div style={{ background: PANEL_BG, border: `2px solid ${GOLD}`, borderRadius: 12, padding: 16, margin: '16px 0' }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ background: GOLD, color: '#000', fontWeight: 900, padding: '3px 10px', borderRadius: 6, letterSpacing: '0.06em' }}>POUNCE</span>
        <span style={{ color: GOLD, fontSize: 16, fontWeight: 800 }}>Pullback Ambush</span>
        <span style={{ color: '#8a8a8a', fontSize: 12 }}>buys the dip to the weekly OpEMA while the AI-300 holds its 11-week trend · PAPER</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 800, color: data?.gateOn ? GOLD : '#ef4444' }}>
          {data ? (data.gateOn ? '● REGIME ON — hunting' : '○ REGIME OFF — in cash') : '…'}
        </span>
      </div>

      {/* execution control */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <span style={{ color: '#8a8a8a', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', marginRight: 2 }}>Execute:</span>
        <ModeBtn label="OFF" active={mode === 'off'} onClick={() => setMode('off')} />
        <ModeBtn label="PAPER" active={mode === 'paper'} onClick={() => setMode('paper')} />
        <ModeBtn label="LIVE POUNCE" active={false} disabled title="Phase 5 — live wiring not built yet" />
        <ModeBtn label="LIVE BOTH" active={false} disabled title="Phase 5 — live wiring not built yet" />
        <span style={{ color: '#5a5a5a', fontSize: 10 }}>live modes arrive in Phase 5</span>
        {busy && <span style={{ color: GOLD_DIM, fontSize: 11 }}>saving…</span>}
        <button onClick={resetPaper} disabled={busy} style={{ marginLeft: 'auto', fontSize: 11, color: '#8a8a8a', background: 'none', border: '1px solid #333', borderRadius: 6, padding: '5px 10px', cursor: busy ? 'wait' : 'pointer' }}>↺ Reset paper book</button>
      </div>

      {err && <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 10 }}>Error: {err}</div>}

      {/* pounce zone */}
      <div style={{ color: GOLD, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '6px 0' }}>🐾 Pouncing now — at the OpEMA ({pounce.length})</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {pounce.length === 0
          ? <span style={{ color: '#666', fontSize: 12 }}>No names at the line right now.</span>
          : pounce.map(f => (
            <div key={f.ticker} style={{ background: GOLD, color: '#000', borderRadius: 8, padding: '6px 10px', fontSize: 12, fontWeight: 800 }}>
              {f.ticker} <span style={{ fontWeight: 500 }}>${num(f.price)} · {f.pctToEma > 0 ? '+' : ''}{f.pctToEma}% to EMA{f.shares > 0 ? ` · ${f.shares}sh` : ''}</span>
            </div>
          ))}
      </div>

      {/* approaching */}
      <div style={{ color: GOLD_DIM, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '14px 0 6px' }}>Approaching the line ({approaching.length})</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {approaching.slice(0, 24).map(f => (
          <div key={f.ticker} style={{ background: '#161616', color: GOLD, border: `1px dashed ${GOLD_DIM}`, borderRadius: 6, padding: '4px 8px', fontSize: 11 }}>
            {f.ticker} <span style={{ color: '#8a8a8a' }}>{f.pctToEma > 0 ? '+' : ''}{f.pctToEma}%</span>
          </div>
        ))}
        <span style={{ color: '#5a5a5a', fontSize: 11 }}>+ {stalkingN} stalking</span>
      </div>

      {/* paper book */}
      <div style={{ color: GOLD, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '16px 0 6px', display: 'flex', gap: 12, alignItems: 'center' }}>
        <span>Paper book ({positions.length})</span>
        {positions.length > 0 && <span style={{ color: bookPnl >= 0 ? '#22c55e' : '#ef4444' }}>P&amp;L {bookPnl >= 0 ? '+' : ''}${bookPnl.toLocaleString()}</span>}
      </div>
      {mode !== 'paper'
        ? <div style={{ color: '#666', fontSize: 12 }}>Flip to PAPER to start tracking Pounce forward.</div>
        : positions.length === 0
          ? <div style={{ color: '#666', fontSize: 12 }}>No open paper positions yet — waiting for a pounce.</div>
          : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {positions.map(p => (
              <div key={p.ticker} style={{ background: '#111', border: `1px solid ${p.protected ? '#22c55e' : GOLD}`, borderRadius: 8, padding: 8, minWidth: 122 }}>
                <div style={{ color: GOLD, fontWeight: 800, fontSize: 13 }}>{p.ticker}{p.protected && <span style={{ color: '#22c55e', fontSize: 10, marginLeft: 6 }} title="stop locked at/above entry">🔒</span>}</div>
                <div style={{ color: '#aaa', fontSize: 11 }}>{p.shares}sh @ ${num(p.entryPrice)}</div>
                <div style={{ color: '#8a8a8a', fontSize: 11 }}>stop ${num(p.stop)}</div>
                <div style={{ color: (p.pnl || 0) >= 0 ? '#22c55e' : '#ef4444', fontSize: 12, fontWeight: 700 }}>{(p.pnl || 0) >= 0 ? '+' : ''}${p.pnl} ({p.pnlPct > 0 ? '+' : ''}{p.pnlPct}%)</div>
              </div>
            ))}
          </div>}
    </div>
  );
}
