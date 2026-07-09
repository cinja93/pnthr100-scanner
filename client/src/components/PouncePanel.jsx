import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch, authHeaders, API_BASE } from '../services/api';
import AiTickerChartModal from './AiTickerChartModal';

// PNTHR POUNCE — the pullback (ambush) strategy, PAPER book. Sister to PNTHR Tree,
// shown on the same page in the fund's black-and-gold, mirroring Tree's section order:
// PROTECT → RECENTLY STOPPED → DEVOUR → POUNCING → APPROACHING → STALKING.
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
const SectionHead = ({ color, children }) => <h3 style={{ color, fontSize: 13, letterSpacing: '0.08em', margin: '0 0 8px' }}>{children}</h3>;

// Funnel badge — mirrors Tree's ATTACK/APPROACHING badge: ticker, price, %-to-line,
// and (for pounce/approaching) liquidity rank + 20-day volume, share size, stop.
function PounceBadge({ f, rank, isPounce, detail = true, onClick }) {
  return (
    <button onClick={onClick} title={`${f.company || f.ticker} — view chart`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8, fontFamily: 'inherit', cursor: 'pointer', margin: '0 6px 6px 0',
        background: '#141207', color: GOLD, borderRadius: 8, padding: '5px 10px', fontSize: 12,
        border: isPounce ? `1px solid ${GOLD}` : detail ? `1px dashed ${GOLD_DIM}` : '1px solid #2a2a2a',
        animation: isPounce ? 'pounceflash 1s ease-in-out infinite' : 'none',
      }}>
      <b style={{ fontWeight: 800 }}>{f.ticker}</b>
      <span style={{ color: '#e6e6e6' }}>${num(f.price)}</span>
      {f.pctToEma != null && <span style={{ color: GOLD_DIM }}>{f.pctToEma > 0 ? '+' : ''}{f.pctToEma}%</span>}
      {detail && f.rsi != null && <span title="daily RSI-14 — must be ≥ 50 to pounce (skips falling-knife dips)" style={{ color: f.rsi >= 50 ? '#4ade80' : '#f87171', fontSize: 10, fontWeight: 700 }}>RSI {f.rsi}</span>}
      {detail && rank != null && <span style={{ background: '#000', color: GOLD_DIM, borderRadius: 5, padding: '1px 6px', fontSize: 10, fontWeight: 700 }}>#{rank}{f.adv != null ? ` (${fmtVol(f.adv)})` : ''}</span>}
      {detail && f.shares > 0 && <span style={{ background: '#000', color: '#e6e6e6', borderRadius: 5, padding: '1px 6px', fontSize: 10, fontWeight: 700 }}>{f.shares}sh</span>}
      {detail && f.stop != null && <span style={{ color: isPounce ? '#fca5a5' : '#f87171', fontSize: 11 }}>stop ${num(f.stop)}</span>}
    </button>
  );
}

// Position card — mirrors Tree's DevourCard layout + fields, in Pounce gold.
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
        <div><span style={lbl}>RSI </span><span title="current daily RSI-14 (Wilder) — entered ≥ 50" style={{ color: (p.rsi ?? 0) >= 50 ? '#4ade80' : '#f87171', fontWeight: 700 }}>{p.rsi ?? '—'}</span></div>
      </div>
      {fmtWhen(p.createdAt) && <div style={{ color: '#6a6a6a', fontSize: 12, marginTop: 8 }}>Bought {fmtWhen(p.createdAt)}</div>}
    </div>
  );
}

// Recently stopped — red card, mirrors Tree's StoppedCard.
function StoppedCard({ s, onClick }) {
  const pnl = s.pnl || 0;
  return (
    <div onClick={onClick} title={`${s.company || s.ticker} — view chart`}
      style={{ background: '#1a0d0d', border: '1px solid #ef4444', borderRadius: 10, padding: '10px 14px', minWidth: 210, cursor: 'pointer' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ background: '#ef4444', color: '#fff', fontWeight: 900, padding: '3px 10px', borderRadius: 7, fontSize: 13 }}>{s.ticker}</span>
        <span style={{ marginLeft: 'auto', color: pnl >= 0 ? '#22c55e' : '#ef4444', fontWeight: 800 }}>{pnl >= 0 ? '+' : ''}${Math.round(pnl).toLocaleString()}</span>
      </div>
      <div style={{ color: '#b3b3b3', fontSize: 12, marginTop: 6 }}>{s.shares}sh · in ${num(s.entryPrice)} → out ${num(s.exitPrice)}</div>
      <div style={{ color: '#8a8a8a', fontSize: 11, marginTop: 2 }}>stopped {fmtWhen(s.exitAt)}</div>
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
  const recentStops = data?.recentStops || [];
  const byLiq = (a, b) => (b.adv || 0) - (a.adv || 0);   // most-liquid first = buy priority (same as Tree)
  // Held names live in the paper book, not the funnel — a name shows once, like Tree.
  const pounce = funnel.filter(f => f.state === 'pounce' && !f.held).sort(byLiq);
  const approaching = funnel.filter(f => f.state === 'approaching' && !f.held).sort(byLiq);
  const stalking = funnel.filter(f => f.state === 'stalking' && !f.held).sort((a, b) => a.ticker.localeCompare(b.ticker));
  const protectedPos = positions.filter(p => p.protected);
  const devourPos = positions.filter(p => !p.protected);
  const bookPnl = positions.reduce((a, p) => a + (p.pnl || 0), 0);
  const devourRisk = devourPos.reduce((a, p) => a + (p.riskNow || 0), 0);
  const g = arr => arr.map(x => x.ticker);   // ticker group for chart nav

  return (
    <div style={{ background: PANEL_BG, border: `2px solid ${GOLD}`, borderRadius: 12, padding: 16, margin: '0 0 16px 0' }}>
      <style>{`@keyframes pounceflash { 0%,100% { box-shadow: 0 0 0 0 ${GOLD}00; } 50% { box-shadow: 0 0 9px 2px ${GOLD}; } }`}</style>

      {/* top-level POUNCE header — mirrors the Tree header (title left, execution control right) */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, color: GOLD }}>🐾 PNTHR Pounce</h1>
          <div style={{ color: '#8a8a8a', fontSize: 12 }}>AI-300 · pullback to the weekly OpEMA · 11-week regime gate · 2-week-low trailing stop · PAPER</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {busy && <span style={{ color: GOLD_DIM, fontSize: 11 }}>saving…</span>}
          <ModeBtn label="OFF" active={mode === 'off'} onClick={() => setMode('off')} />
          <ModeBtn label="PAPER" active={mode === 'paper'} onClick={() => setMode('paper')} />
          <ModeBtn label="LIVE POUNCE" active={false} disabled title="Phase 5 — live wiring not built yet" />
          <ModeBtn label="LIVE BOTH" active={false} disabled title="Phase 5 — live wiring not built yet" />
          <button onClick={resetPaper} disabled={busy} style={{ fontSize: 11, color: '#8a8a8a', background: 'none', border: '1px solid #333', borderRadius: 6, padding: '7px 10px', cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit' }}>↺ Reset Paper Book</button>
        </div>
      </div>

      {/* regime + summary strip */}
      <div style={{ display: 'flex', gap: 16, color: '#888', fontSize: 11, marginBottom: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontWeight: 800, color: data?.gateOn ? GOLD : '#ef4444' }}>{data ? (data.gateOn ? '● REGIME ON — hunting' : '○ REGIME OFF — in cash') : '…'}</span>
        <span>Book <b style={{ color: '#e6e6e6' }}>{positions.length}</b> · P&amp;L <b style={{ color: bookPnl >= 0 ? '#22c55e' : '#ef4444' }}>{bookPnl >= 0 ? '+' : ''}${bookPnl.toLocaleString()}</b></span>
        <span>Pouncing {pounce.length} · Approaching {approaching.length} · Stalking {stalking.length}</span>
        <span style={{ color: '#5a5a5a' }}>live modes in Phase 5 · Paper, hypothetical, survivorship-flattered AI-300. Not a track record.</span>
      </div>

      {err && <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 10 }}>Error: {err}</div>}
      {mode !== 'paper' && <div style={{ color: '#666', fontSize: 12, margin: '10px 0' }}>Flip to PAPER to start tracking Pounce forward.</div>}

      {/* PROTECT */}
      <div style={{ marginTop: 16 }}>
        <SectionHead color={GOLD}>🛡️ PROTECT — PROFIT LOCKED ({protectedPos.length})</SectionHead>
        {protectedPos.length === 0 ? <div style={{ color: '#666', fontSize: 12 }}>None yet — a position moves here once its trailing stop reaches entry (stop ≥ avg).</div> :
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>{protectedPos.map(p => <PounceCard key={p.ticker} p={p} onClick={() => openChart(g(protectedPos), p.ticker)} />)}</div>}
      </div>

      {/* RECENTLY STOPPED */}
      {recentStops.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <SectionHead color="#ef4444">🛑 RECENTLY STOPPED — LAST 24H ({recentStops.length})</SectionHead>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>{recentStops.map((s, i) => <StoppedCard key={i} s={s} onClick={() => openChart(g(recentStops), s.ticker)} />)}</div>
        </div>
      )}

      {/* DEVOUR */}
      <div style={{ marginTop: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 12 }}>
          <SectionHead color={GOLD}>DEVOUR — HELD, RISK ON ({devourPos.length})</SectionHead>
          {devourPos.length > 0 && <span style={{ color: '#888', fontSize: 12 }}>Risk if all stopped <b style={{ color: '#facc15' }}>-${devourRisk.toLocaleString()}</b></span>}
        </div>
        {devourPos.length === 0 ? <div style={{ color: '#666', fontSize: 12 }}>No positions with open risk.</div> :
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>{devourPos.map(p => <PounceCard key={p.ticker} p={p} onClick={() => openChart(g(devourPos), p.ticker)} />)}</div>}
      </div>

      {/* POUNCING (= Tree's ATTACK) */}
      <div style={{ marginTop: 18 }}>
        <SectionHead color={GOLD}>🐾 POUNCING NOW — AT THE OPEMA ({pounce.length})</SectionHead>
        {pounce.length === 0 ? <div style={{ color: '#666', fontSize: 12 }}>No names at the line right now.</div> :
          <div>{pounce.map((f, i) => <PounceBadge key={f.ticker} f={f} rank={i + 1} isPounce onClick={() => openChart(g(pounce), f.ticker)} />)}</div>}
      </div>

      {/* APPROACHING */}
      <div style={{ marginTop: 18 }}>
        <SectionHead color={GOLD_DIM}>APPROACHING THE LINE ({approaching.length})</SectionHead>
        {approaching.length === 0 ? <div style={{ color: '#666', fontSize: 12 }}>None pulling back yet.</div> :
          <div>{approaching.map((f, i) => <PounceBadge key={f.ticker} f={f} rank={i + 1} onClick={() => openChart(g(approaching), f.ticker)} />)}</div>}
      </div>

      {/* STALKING */}
      <div style={{ marginTop: 18 }}>
        <SectionHead color={GOLD_DIM}>STALKING — AI-300 UNIVERSE, A→Z ({stalking.length})</SectionHead>
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>{stalking.map(f => <PounceBadge key={f.ticker} f={f} detail={false} onClick={() => openChart(g(stalking), f.ticker)} />)}</div>
      </div>

      {chart && <AiTickerChartModal tickers={chart.tickers} initialIndex={chart.index} onClose={() => setChart(null)} />}
    </div>
  );
}
