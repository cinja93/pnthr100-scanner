import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch, authHeaders, API_BASE, fetchPnthrTreeProjection } from '../services/api';
import AiTickerChartModal from './AiTickerChartModal';
import { AumTracker } from './AmbushPage';

// PNTHR Tree — 52-week-high momentum cockpit.
// Funnel: Stalking (outline green) → Approaching (flashing) → Attack (filled green) → Devour (cards).
// Modes: OFF · PAPER TRADE · AUTO-EXECUTE.  Auto requires confirmation (real orders).

const TREE_CAGR = 45.6;   // 1× no-pyramid backtest CAGR (conservative; 2× ≈ +104%). Hypothetical / survivorship-flattered.
const fmt = (n) => '$' + Math.round(n).toLocaleString();

function ModeButton({ label, active, color, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: '8px 16px', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: 'pointer',
      border: `1px solid ${active ? color : '#333'}`, background: active ? color : '#161616',
      color: active ? '#000' : '#aaa', letterSpacing: '0.04em',
    }}>{label}</button>
  );
}

function Badge({ f, onClick }) {
  // stalking = outline; approaching = flashing outline; attack = filled
  const base = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 8, margin: 3, fontSize: 12, cursor: 'pointer', fontFamily: 'monospace' };
  let style;
  if (f.state === 'attack') style = { ...base, background: '#16a34a', border: '1px solid #22c55e', color: '#fff', fontWeight: 700 };
  else if (f.state === 'approaching') style = { ...base, background: 'transparent', border: '1px solid #22c55e', color: '#22c55e', animation: 'treeflash 1s ease-in-out infinite' };
  else style = { ...base, background: 'transparent', border: '1px solid #2f6b46', color: '#7fcf9f' };
  return (
    <span style={style} onClick={onClick} title={`${f.ticker} · ${f.price?.toFixed(2)} · ${f.pctToHigh}% to 52wk high`}>
      <b>{f.ticker}</b><span style={{ opacity: 0.8 }}>${f.price?.toFixed(2)}</span>
      {f.state === 'attack' && f.shares > 0 && <span style={{ background: '#0008', padding: '1px 5px', borderRadius: 5 }}>{f.shares}sh</span>}
    </span>
  );
}

function DevourCard({ p, onClick }) {
  const pnlColor = p.pnl >= 0 ? '#22c55e' : '#ef4444';
  const shares = p.shares || p.totalShares;
  const last = p.last ?? (p.avgCost || p.entryPrice);
  const rps = (p.stop != null && last != null) ? last - p.stop : null;     // current price − stop
  const totalRisk = rps != null ? rps * shares : null;                     // × shares
  const prot = p.protected;
  return (
    <div onClick={onClick} title="Click for daily + weekly charts" style={{ cursor: 'pointer', background: prot ? '#0d1626' : '#0e1a12', border: `1px solid ${prot ? '#3b82f6' : '#22c55e'}`, borderRadius: 10, padding: '12px 14px', minWidth: 210 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ background: '#16a34a', border: '1px solid #22c55e', color: '#fff', fontWeight: 800, fontSize: 14, padding: '3px 9px', borderRadius: 8, fontFamily: 'monospace' }}>{p.ticker}</span>
          <span style={{ color: prot ? '#60a5fa' : '#22c55e', fontSize: 11 }}>{prot ? '🛡️ LOCKED' : 'LONG'}</span>
        </span>
        <span style={{ color: pnlColor, fontWeight: 700, fontFamily: 'monospace' }}>{p.pnl >= 0 ? '+' : ''}{fmt(p.pnl)} ({p.pnlPct}%)</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 12px', marginTop: 8, fontSize: 12, fontFamily: 'monospace', color: '#ccc' }}>
        <span>Shares <b style={{ color: '#fff' }}>{p.shares || p.totalShares}</b></span>
        <span>Last <b style={{ color: '#fff' }}>${p.last?.toFixed(2)}</b></span>
        <span>Avg <b style={{ color: '#fff' }}>${(p.avgCost || p.entryPrice)?.toFixed(2)}</b></span>
        <span>Stop <b style={{ color: prot ? '#22c55e' : '#ef4444' }}>${p.stop?.toFixed(2)}</b></span>
        <span>Risk/sh <b style={{ color: '#facc15' }}>${rps != null ? rps.toFixed(2) : '--'}</b></span>
        <span>Total risk <b style={{ color: '#facc15' }}>{totalRisk != null ? fmt(totalRisk) : '--'}</b></span>
      </div>
    </div>
  );
}

export default function PnthrTreePage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [chart, setChart] = useState(null);
  const [projection, setProjection] = useState(null);
  const openChart = (list, ticker) => setChart({ tickers: list, index: Math.max(0, list.indexOf(ticker)) });

  const load = useCallback(async () => {
    try {
      const r = await apiFetch(`${API_BASE}/api/pnthr-tree`, { headers: authHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json()); setErr(null);
    } catch (e) { setErr(e.message); }
  }, []);

  useEffect(() => { load(); const id = setInterval(load, 30000); return () => clearInterval(id); }, [load]);
  useEffect(() => {
    const go = () => fetchPnthrTreeProjection().then(setProjection).catch(() => {});
    go(); const id = setInterval(go, 60000); return () => clearInterval(id);
  }, []);

  const setMode = async (mode) => {
    if (mode === 'live' && !window.confirm('AUTO-EXECUTE places REAL orders on every new 52-week high. Make sure Ambush & Elite are OFF (one engine per account). Proceed?')) return;
    setBusy(true);
    try {
      const r = await apiFetch(`${API_BASE}/api/admin/pnthr-tree/mode`, { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await load();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const mode = data?.mode || 'off';
  const funnel = data?.funnel || [];
  const positions = data?.positions || [];
  const protectedPos = positions.filter(p => p.protected);
  const devourPos = positions.filter(p => !p.protected);
  // Devour roll-up: total open P&L, and total $ at risk if every stop fired (current price → stop).
  const devourPnl = devourPos.reduce((a, p) => a + (p.pnl || 0), 0);
  const devourRisk = devourPos.reduce((a, p) => {
    const last = p.last ?? (p.avgCost || p.entryPrice);
    return a + ((p.stop != null && last != null) ? (last - p.stop) * (p.shares || p.totalShares || 0) : 0);
  }, 0);
  const attack = funnel.filter(f => f.state === 'attack' && !f.held);
  const approaching = funnel.filter(f => f.state === 'approaching' && !f.held);
  const stalking = funnel.filter(f => f.state === 'stalking' && !f.held);
  const nav = data?.nav || 0;

  return (
    <div style={{ padding: '20px 26px', color: '#e6e6e6' }}>
      <style>{`@keyframes treeflash { 0%,100% { box-shadow: 0 0 0 0 #22c55e88; opacity: 1; } 50% { box-shadow: 0 0 8px 2px #22c55e; opacity: 0.55; } }`}</style>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', borderBottom: '2px solid #0b3d2e', paddingBottom: 10 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, color: '#22c55e' }}>🌳 PNTHR Tree</h1>
          <div style={{ color: '#888', fontSize: 12 }}>AI-300 · 52-week-high momentum · full size, 2-week-low trailing stop</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {busy && <span style={{ color: '#888', fontSize: 11 }}>saving…</span>}
          <ModeButton label="OFF" active={mode === 'off'} color="#666" onClick={() => setMode('off')} />
          <ModeButton label="PAPER TRADE" active={mode === 'paper'} color="#3b82f6" onClick={() => setMode('paper')} />
          <ModeButton label="AUTO-EXECUTE" active={mode === 'live'} color="#22c55e" onClick={() => setMode('live')} />
        </div>
      </div>

      {err && <div style={{ color: '#ef4444', fontSize: 12, marginTop: 8 }}>Error: {err}</div>}
      {mode === 'live' && <div style={{ background: '#3b0d0d', border: '1px solid #ef4444', borderRadius: 8, padding: '8px 12px', marginTop: 10, color: '#fca5a5', fontSize: 12 }}>⚠️ AUTO-EXECUTE is LIVE — real orders fire on new 52-week highs. Verify the first fill, and confirm Ambush/Elite are OFF.</div>}

      {/* Projected vs Actual AUM + PNTHR Goals — Tree's OWN backtest (daily-10 stop, 2x cap) */}
      <div style={{ marginTop: 14 }}>
        {projection ? <AumTracker projection={projection} /> : <div style={{ color: '#666', fontSize: 12 }}>Loading projection…</div>}
      </div>

      {/* live funnel counts + current leverage + disclosure */}
      <div style={{ display: 'flex', gap: 18, color: '#888', fontSize: 11, marginBottom: 4, flexWrap: 'wrap', alignItems: 'center' }}>
        {data?.counts && <span>Stalking {data.counts.stalking || 0} · Approaching {data.counts.approaching || 0} · Attack {data.counts.attack || 0}</span>}
        {data && <span>Leverage <b style={{ color: (data.grossX || 0) > (data.grossCapX || 2) ? '#ef4444' : '#22c55e' }}>{data.grossX ?? 0}x</b> / {data.grossCapX ?? 2}x cap</span>}
        <span style={{ color: '#555' }}>Backtest hypothetical &amp; survivorship-flattered (current AI-300 names). Not a track record.</span>
      </div>

      {/* DEVOUR — held, trailing stop still below entry (capital at risk) */}
      <div style={{ marginTop: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 12, borderBottom: '1px solid #1c3a28', paddingBottom: 6, marginBottom: 10 }}>
          <h3 style={{ color: '#22c55e', fontSize: 13, letterSpacing: '0.08em', margin: 0 }}>DEVOUR — POSITIONS, RISK ON ({devourPos.length})</h3>
          <div style={{ display: 'flex', gap: 20, fontSize: 12, fontFamily: 'monospace' }}>
            <span style={{ color: '#888' }}>Open P&amp;L <b style={{ color: devourPnl >= 0 ? '#22c55e' : '#ef4444' }}>{devourPnl >= 0 ? '+' : '-'}{fmt(Math.abs(devourPnl))}</b></span>
            <span style={{ color: '#888' }}>Total risk if all stopped <b style={{ color: '#facc15' }}>-{fmt(devourRisk)}</b> <span style={{ color: '#555' }}>({nav > 0 ? (devourRisk / nav * 100).toFixed(1) : '0'}% of NAV)</span></span>
          </div>
        </div>
        {devourPos.length === 0 ? <div style={{ color: '#666', fontSize: 12 }}>No positions with open risk.</div> :
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>{devourPos.map((p, i) => <DevourCard key={i} p={p} onClick={() => openChart(devourPos.map(x => x.ticker), p.ticker)} />)}</div>}
      </div>

      {/* PROTECT — trailing stop has reached/passed entry → worst case is a locked profit */}
      <div style={{ marginTop: 18 }}>
        <h3 style={{ color: '#60a5fa', fontSize: 13, letterSpacing: '0.08em' }}>🛡️ PROTECT — PROFIT LOCKED ({protectedPos.length})</h3>
        {protectedPos.length === 0 ? <div style={{ color: '#666', fontSize: 12 }}>None yet — a position moves here once its trailing stop reaches your entry (stop ≥ avg cost).</div> :
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>{protectedPos.map((p, i) => <DevourCard key={i} p={p} onClick={() => openChart(protectedPos.map(x => x.ticker), p.ticker)} />)}</div>}
      </div>

      {/* ATTACK — new highs */}
      <div style={{ marginTop: 18 }}>
        <h3 style={{ color: '#22c55e', fontSize: 13, letterSpacing: '0.08em' }}>⚔️ ATTACK — NEW 52-WEEK HIGHS ({attack.length})</h3>
        {attack.length === 0 ? <div style={{ color: '#666', fontSize: 12 }}>None at a new high right now.</div> :
          <div>{attack.map(f => <Badge key={f.ticker} f={f} onClick={() => openChart(attack.map(x => x.ticker), f.ticker)} />)}</div>}
      </div>

      {/* APPROACHING — flashing */}
      <div style={{ marginTop: 18 }}>
        <h3 style={{ color: '#facc15', fontSize: 13, letterSpacing: '0.08em' }}>APPROACHING — within 1% of a new high ({approaching.length})</h3>
        {approaching.length === 0 ? <div style={{ color: '#666', fontSize: 12 }}>None close yet.</div> :
          <div>{approaching.map(f => <Badge key={f.ticker} f={f} onClick={() => openChart(approaching.map(x => x.ticker), f.ticker)} />)}</div>}
      </div>

      {/* STALKING — the universe */}
      <div style={{ marginTop: 18 }}>
        <h3 style={{ color: '#7fcf9f', fontSize: 13, letterSpacing: '0.08em' }}>STALKING — AI-300 universe, closest to a new high first ({stalking.length})</h3>
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>{stalking.map(f => <Badge key={f.ticker} f={f} onClick={() => openChart(stalking.map(x => x.ticker), f.ticker)} />)}</div>
      </div>

      <div style={{ color: '#555', fontSize: 10, marginTop: 18, borderTop: '1px solid #222', paddingTop: 8 }}>
        Updates every 30s. PAPER records to a paper book (no real orders). AUTO-EXECUTE places real orders via the bridge — must own AI-300 alone (Ambush & Elite off). Backtest is hypothetical & survivorship-flattered; not a track record.
      </div>

      {chart && (
        <AiTickerChartModal
          tickers={chart.tickers}
          initialIndex={chart.index}
          onClose={() => setChart(null)}
        />
      )}
    </div>
  );
}
