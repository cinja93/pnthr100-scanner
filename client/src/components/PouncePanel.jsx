import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch, authHeaders, API_BASE } from '../services/api';
import AiTickerChartModal from './AiTickerChartModal';

// PNTHR POUNCE — the pullback (ambush) strategy, PAPER book. Sister to PNTHR Tree,
// shown on the same page in the fund's black-and-gold so it can never be mistaken
// for Tree's green live book. Cards mirror the Tree cards' layout + info.
const GOLD = '#facc15', GOLD_DIM = '#a3891f', PANEL_BG = '#0a0a0a';

const num = (v, d = 2) => (typeof v === 'number' ? v.toFixed(d) : '—');
const fmtVol = v => (v == null ? '' : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? Math.round(v / 1e3) + 'K' : '' + Math.round(v));
const fmtWhen = (t) => { if (!t) return null; const d = new Date(t); return `${d.toLocaleDateString([], { month: 'numeric', day: 'numeric' })} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`; };

function ModeBtn({ label, active, onClick, disabled, title }) {
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      style={{
        padding: '7px 14px', borderRadius: 7, fontSize: 12, fontWeight: 800, letterSpacing: '0.03em',
        cursor: disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit',
        background: active ? GOLD : '#161616', color: active ? '#000' : (disabled ? '#555' : GOLD),
        border: `1px solid ${active ? GOLD : '#333'}`, opacity: disabled ? 0.5 : 1,
      }}>{label}</button>
  );
}

// Funnel badge — mirrors the Tree "APPROACHING/ATTACK" badge: ticker, price, liquidity
// rank (#n + 20-day avg volume), share size, and the recommended stop. Pounce gold theme.
function PounceBadge({ f, rank, isPounce, onClick }) {
  return (
    <button onClick={onClick} title={`${f.company || f.ticker} — view chart`}
      className="tree-pulse"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8, fontFamily: 'inherit', cursor: 'pointer',
        background: '#141207', color: GOLD, borderRadius: 8, padding: '6px 11px', fontSize: 12,
        border: isPounce ? `1px solid ${GOLD}` : `1px dashed ${GOLD_DIM}`,
        animation: isPounce ? 'pounceflash 1s ease-in-out infinite' : 'none',
      }}>
      <b style={{ fontWeight: 800 }}>{f.ticker}</b>
      <span style={{ color: '#e6e6e6' }}>${num(f.price)}</span>
      {f.pctToEma != null && <span style={{ color: GOLD_DIM }}>{f.pctToEma > 0 ? '+' : ''}{f.pctToEma}%</span>}
      {rank != null && <span style={{ background: '#000', color: GOLD_DIM, borderRadius: 5, padding: '1px 6px', fontSize: 10, fontWeight: 700 }}>#{rank}{f.adv != null ? ` (${fmtVol(f.adv)})` : ''}</span>}
      {f.shares > 0 && <span style={{ background: '#000', color: '#e6e6e6', borderRadius: 5, padding: '1px 6px', fontSize: 10, fontWeight: 700 }}>{f.shares}sh</span>}
      {f.stop != null && <span style={{ color: isPounce ? '#fca5a5' : '#f87171', fontSize: 11 }}>stop ${num(f.stop)}</span>}
    </button>
  );
}

// Position card — mirrors the Tree DevourCard layout + fields, in Pounce gold.
function PounceCard({ p, onClick }) {
  const pnl = p.pnl || 0, prot = p.protected;
  const riskPerSh = (p.last != null && p.stop != null && p.last > p.stop) ? (p.last - p.stop) : 0;
  const lbl = { color: '#8a8a8a' }, val = { color: '#e6e6e6', fontWeight: 700 };
  return (
    <div onClick={onClick} title={`${p.company || p.ticker} — view chart`}
      style={{ background: '#0d0d0d', border: `1px solid ${prot ? '#22c55e' : GOLD}`, borderRadius: 12, padding: '12px 16px', minWidth: 300, cursor: 'pointer' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span style={{ background: GOLD, color: '#000', fontWeight: 900, padding: '5px 12px', borderRadius: 8, fontSize: 15 }}>{p.ticker}</span>
        {prot && <span style={{ color: '#22c55e', fontSize: 12, fontWeight: 700 }}>🛡 LOCKED</span>}
        <span style={{ marginLeft: 'auto', color: pnl >= 0 ? '#22c55e' : '#ef4444', fontWeight: 800, fontSize: 17 }}>
          {pnl >= 0 ? '+' : ''}${Math.abs(pnl).toLocaleString()} ({p.pnlPct > 0 ? '+' : ''}{p.pnlPct}%)
        </span>
      </div>
      {p.company && <div style={{ color: '#e6e6e6', fontWeight: 700, fontSize: 15 }}>{p.company}</div>}
      {p.sector && <div style={{ color: GOLD_DIM, fontSize: 13, marginBottom: 8 }}>{p.sector}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 20px', fontSize: 14 }}>
        <div><span style={lbl}>Shares </span><span style={val}>{p.shares}</span></div>
        <div><span style={lbl}>Last </span><span style={val}>${num(p.last)}</span></div>
        <div><span style={lbl}>Avg </span><span style={val}>${num(p.avgCost ?? p.entryPrice)}</span></div>
        <div><span style={lbl}>Stop </span><span style={{ color: prot ? '#22c55e' : '#e6e6e6', fontWeight: 700 }}>${num(p.stop)}</span></div>
        <div><span style={lbl}>Risk/sh </span><span style={{ color: GOLD, fontWeight: 700 }}>${num(riskPerSh)}</span></div>
        <div><span style={lbl}>Total risk </span><span style={{ color: '#f59e0b', fontWeight: 700 }}>${(p.riskNow || 0).toLocaleString()}</span><span style={{ color: '#f59e0b' }}> · {p.riskPct}% NAV</span></div>
      </div>
      {fmtWhen(p.createdAt) && <div style={{ color: '#6a6a6a', fontSize: 12, marginTop: 8 }}>Bought {fmtWhen(p.createdAt)}</div>}
    </div>
  );
}

export default function PouncePanel() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [chart, setChart] = useState(null);   // { tickers, index } → AiTickerChartModal (scroll within a group)
  const openChart = (list, ticker) => setChart({ tickers: list, index: Math.max(0, list.indexOf(ticker)) });

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
  const byLiq = (a, b) => (b.adv || 0) - (a.adv || 0);   // most-liquid first = buy priority (same as Tree)
  const pounce = funnel.filter(f => f.state === 'pounce').sort(byLiq);
  const approaching = funnel.filter(f => f.state === 'approaching').sort(byLiq);
  const stalkingN = funnel.filter(f => f.state === 'stalking').length;
  const pounceTk = pounce.map(x => x.ticker), apprTk = approaching.map(x => x.ticker), posTk = positions.map(x => x.ticker);
  const bookPnl = positions.reduce((a, p) => a + (p.pnl || 0), 0);

  return (
    <div style={{ background: PANEL_BG, border: `2px solid ${GOLD}`, borderRadius: 12, padding: 16, margin: '16px 0' }}>
      <style>{`@keyframes pounceflash { 0%,100% { box-shadow: 0 0 0 0 ${GOLD}00; } 50% { box-shadow: 0 0 9px 2px ${GOLD}; } }`}</style>

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
        <button onClick={resetPaper} disabled={busy} style={{ marginLeft: 'auto', fontSize: 11, color: '#8a8a8a', background: 'none', border: '1px solid #333', borderRadius: 6, padding: '5px 10px', cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit' }}>↺ Reset paper book</button>
      </div>

      {err && <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 10 }}>Error: {err}</div>}

      {/* pounce zone */}
      <div style={{ color: GOLD, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '6px 0' }}>🐾 Pouncing now — at the OpEMA ({pounce.length})</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {pounce.length === 0
          ? <span style={{ color: '#666', fontSize: 12 }}>No names at the line right now.</span>
          : pounce.map((f, i) => <PounceBadge key={f.ticker} f={f} rank={i + 1} isPounce onClick={() => openChart(pounceTk, f.ticker)} />)}
      </div>

      {/* approaching */}
      <div style={{ color: GOLD_DIM, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '14px 0 6px' }}>Approaching the line ({approaching.length})</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        {approaching.slice(0, 30).map((f, i) => <PounceBadge key={f.ticker} f={f} rank={i + 1} onClick={() => openChart(apprTk, f.ticker)} />)}
        <span style={{ color: '#5a5a5a', fontSize: 11 }}>+ {stalkingN} stalking</span>
      </div>

      {/* paper book */}
      <div style={{ color: GOLD, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '16px 0 8px', display: 'flex', gap: 12, alignItems: 'center' }}>
        <span>Paper book ({positions.length})</span>
        {positions.length > 0 && <span style={{ color: bookPnl >= 0 ? '#22c55e' : '#ef4444' }}>P&amp;L {bookPnl >= 0 ? '+' : ''}${bookPnl.toLocaleString()}</span>}
      </div>
      {mode !== 'paper'
        ? <div style={{ color: '#666', fontSize: 12 }}>Flip to PAPER to start tracking Pounce forward.</div>
        : positions.length === 0
          ? <div style={{ color: '#666', fontSize: 12 }}>No open paper positions yet — waiting for a pounce.</div>
          : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {positions.map(p => <PounceCard key={p.ticker} p={p} onClick={() => openChart(posTk, p.ticker)} />)}
          </div>}

      {chart && <AiTickerChartModal tickers={chart.tickers} initialIndex={chart.index} onClose={() => setChart(null)} />}
    </div>
  );
}
