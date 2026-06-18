import React, { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch, authHeaders, API_BASE, fetchPnthrTreeProjection } from '../services/api';
import AiTickerChartModal from './AiTickerChartModal';
import { AumTracker, ForwardProjection } from './AmbushPage';

// PNTHR Tree — 42-week-high momentum cockpit.
// Funnel: Stalking (outline green) → Approaching (flashing) → Attack (filled green) → Devour (cards).
// Modes: OFF · PAPER TRADE · AUTO-EXECUTE.  Auto requires confirmation (real orders).

const fmt = (n) => '$' + Math.round(n).toLocaleString();
// ET clock for signal/trade timestamps — time only if today, else "M/D h:mm".
const clockET = (d) => {
  if (!d) return '';
  const dt = new Date(d); if (isNaN(dt)) return '';
  const time = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
  const dayET = dt.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return dayET === todayET ? time : dt.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'America/New_York' }) + ' ' + time;
};
const agoStr = (iso) => {                                  // "2h 14m ago" / "8m ago"
  const ms = Date.now() - new Date(iso).getTime();
  if (!(ms >= 0)) return 'just now';
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m ago` : `${m}m ago`;
};

// ── Exit-proximity warnings on held cards (Scott 2026-06-14) ────────────────
// A "stock in play" (DEVOUR / PROTECT card) flashes to warn how close it is to
// an exit or to going flat:
//   RED    — last price within 1% of the trailing stop (or already at/below it) → about to be stopped out.
//   YELLOW — last price within 0.05% of break-even (avg cost) → the trade is sitting at scratch.
// Red wins when both apply (the stop is the action trigger). Tweak the bands here.
const NEAR_STOP_PCT = 0.01;     // 1.0% of the stop
const NEAR_BE_PCT   = 0.005;    // 0.5% of break-even (Scott widened from 0.05% so yellow catches a fading winner)

// Collapsible section wrapper (remembers open/closed per panel in localStorage).
function Collapsible({ title, storageKey, children }) {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(storageKey) !== '0'; } catch { return true; } });
  const toggle = () => setOpen(o => { const n = !o; try { localStorage.setItem(storageKey, n ? '1' : '0'); } catch { /* */ } return n; });
  return (
    <div style={{ marginBottom: 12 }}>
      <button onClick={toggle} style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'transparent', border: 'none', cursor: 'pointer', padding: '2px 0', marginBottom: open ? 2 : 0, fontFamily: 'inherit' }}>
        <span style={{ color: '#3b82f6', fontSize: 12 }}>{open ? '▼' : '▶'}</span>
        {open
          ? <span style={{ color: '#555', fontSize: 11, fontWeight: 400 }}>hide {title.toLowerCase()}</span>
          : <span style={{ color: '#9aa0aa', fontSize: 12, fontWeight: 700, letterSpacing: '0.04em' }}>{title}</span>}
      </button>
      {open && children}
    </div>
  );
}

// ── Daily trade log modal (IBKR truth, recorded 4:35pm ET each trading day) ──
// Per day: NAV, open positions with IBKR's own P&L, and every execution of the
// day — STRATEGY trades (Tree book) split from MANUAL trades (e.g. SPCX/ARM).
function TreeDailyLogModal({ days, onClose, onRecordNow, busy }) {
  const f$ = (n) => (n < 0 ? '-$' : '$') + Math.round(Math.abs(n)).toLocaleString();
  const timeOf = (t) => { const m = String(t || '').match(/(\d{2}:\d{2}:\d{2})/); return m ? m[1] : '—'; };
  const th = { textAlign: 'right', padding: '4px 8px' };
  const tradeTable = (rows, accent) => (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'monospace', marginBottom: 10 }}>
      <thead><tr style={{ color: '#b4b4be', fontSize: 10, textTransform: 'uppercase' }}>
        <th style={{ ...th, textAlign: 'left' }}>Time (TWS)</th><th style={{ ...th, textAlign: 'left' }}>Ticker</th>
        <th style={{ ...th, textAlign: 'left' }}>Side</th><th style={th}>Shares</th><th style={th}>Price</th><th style={th}>Value</th>
      </tr></thead>
      <tbody>{rows.map((x, i) => (
        <tr key={i} style={{ borderTop: '1px solid #1a1a1a' }}>
          <td style={{ ...th, textAlign: 'left', color: '#888' }}>{timeOf(x.time)}</td>
          <td style={{ ...th, textAlign: 'left', color: accent, fontWeight: 700 }}>{x.ticker}</td>
          <td style={{ ...th, textAlign: 'left', color: x.side === 'BUY' ? '#22c55e' : '#ef4444' }}>{x.side}</td>
          <td style={{ ...th, color: '#e6e6e6' }}>{x.shares}</td>
          <td style={{ ...th, color: '#e6e6e6' }}>${x.price?.toFixed(2)}</td>
          <td style={{ ...th, color: '#ccc' }}>{f$(x.value)}</td>
        </tr>))}
      </tbody>
    </table>
  );
  return (
    <div onClick={e => { if (e.target === e.currentTarget) onClose(); }} className="pnthr-overlay"
      style={{ position: 'fixed', inset: 0, background: '#000c', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#0d0d0d', border: '1px solid #1c3a28', borderRadius: 12, padding: '20px 22px', maxWidth: 900, width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
          <h2 style={{ margin: 0, color: '#22c55e', fontSize: 18 }}>📜 Daily Trade Log — IBKR truth</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onRecordNow} disabled={busy} style={{ background: '#161616', border: '1px solid #2f6b46', color: '#7fcf9f', borderRadius: 6, padding: '4px 12px', cursor: busy ? 'wait' : 'pointer', fontSize: 12 }}>{busy ? 'Recording…' : '↻ Record now'}</button>
            <button onClick={onClose} style={{ background: '#161616', border: '1px solid #2a2a2a', color: '#aaa', borderRadius: 6, padding: '4px 12px', cursor: 'pointer' }}>Close</button>
          </div>
        </div>
        <div style={{ color: '#666', fontSize: 11, margin: '4px 0 14px' }}>Recorded automatically at 4:35pm ET each trading day from the IBKR snapshot — positions, P&amp;L, and every execution, exactly as IBKR reports them.</div>
        {(!days || days.length === 0) && <div style={{ color: '#888', fontSize: 13 }}>No days recorded yet — the first record lands at 4:35pm ET, or click "Record now".</div>}
        {(days || []).map(d => {
          const catOf = (x) => x.category || (x.strategy ? 'strategy' : 'manual');   // old records predate `category`
          const strat = (d.trades || []).filter(t => catOf(t) === 'strategy');
          const early = (d.trades || []).filter(t => catOf(t) === 'early');
          const manual = (d.trades || []).filter(t => catOf(t) === 'manual');
          const extra = [early.length && `${early.length} early`, manual.length && `${manual.length} manual`].filter(Boolean).join(', ');
          return (
            <div key={d.date} style={{ border: '1px solid #1c3a28', borderRadius: 10, padding: '12px 14px', marginBottom: 14 }}>
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 8, fontFamily: 'monospace' }}>
                <b style={{ color: '#e6e6e6', fontSize: 15 }}>{d.date}</b>
                <span style={{ color: '#888', fontSize: 12 }}>NAV <b style={{ color: '#22c55e' }}>{f$(d.nav)}</b></span>
                <span style={{ color: '#888', fontSize: 12 }}>Open P&amp;L <b style={{ color: d.openPnl >= 0 ? '#22c55e' : '#ef4444' }}>{d.openPnl >= 0 ? '+' : ''}{f$(d.openPnl)}</b></span>
                <span style={{ color: '#888', fontSize: 12 }}>{d.positionsCount} open positions · {d.tradesCount} trades{extra ? ` (${extra})` : ''}</span>
              </div>
              {strat.length > 0 && <>
                <div style={{ color: '#7fcf9f', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Strategy trades (PNTHR Tree book)</div>
                {tradeTable(strat, '#22c55e')}
              </>}
              {early.length > 0 && <>
                <div style={{ color: '#f59e0b', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>⏱ Early entries — strategy names bought ahead of the engine's signal ({[...new Set(early.map(x => x.ticker))].join(', ')})</div>
                {tradeTable(early, '#f59e0b')}
              </>}
              {manual.length > 0 && <>
                <div style={{ color: '#facc15', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>⚠️ Not part of the strategy — manual trades ({[...new Set(manual.map(x => x.ticker))].join(', ')})</div>
                {tradeTable(manual, '#facc15')}
              </>}
              {(d.trades || []).length === 0 && <div style={{ color: '#666', fontSize: 12, marginBottom: 8 }}>No trades this day.</div>}
              <div style={{ color: '#888', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '6px 0 4px' }}>Open positions at record time</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'monospace' }}>
                <thead><tr style={{ color: '#b4b4be', fontSize: 10, textTransform: 'uppercase' }}>
                  <th style={{ ...th, textAlign: 'left' }}>Ticker</th><th style={th}>Shares</th><th style={th}>Avg</th><th style={th}>Last</th><th style={th}>P&amp;L</th><th style={th}>P&amp;L %</th><th style={th}>Stop</th>
                </tr></thead>
                <tbody>{(d.positions || []).map((p, i) => (
                  <tr key={i} style={{ borderTop: '1px solid #1a1a1a' }}>
                    <td style={{ ...th, textAlign: 'left' }}>{(() => { const c = p.category || (p.strategy ? 'strategy' : 'manual'); const col = c === 'strategy' ? '#22c55e' : c === 'early' ? '#f59e0b' : '#facc15'; return <><b style={{ color: col }}>{p.ticker}</b>{c === 'early' && <span style={{ color: '#f59e0b', fontSize: 9, marginLeft: 6 }}>EARLY</span>}{c === 'manual' && <span style={{ color: '#facc15', fontSize: 9, marginLeft: 6 }}>MANUAL</span>}</>; })()}</td>
                    <td style={{ ...th, color: '#e6e6e6' }}>{p.shares}</td>
                    <td style={{ ...th, color: '#ccc' }}>${p.avgCost?.toFixed(2)}</td>
                    <td style={{ ...th, color: '#e6e6e6' }}>${p.last?.toFixed(2)}</td>
                    <td style={{ ...th, color: p.pnl >= 0 ? '#22c55e' : '#ef4444' }}>{p.pnl >= 0 ? '+' : ''}{f$(p.pnl)}</td>
                    <td style={{ ...th, color: p.pnlPct >= 0 ? '#22c55e' : '#ef4444' }}>{p.pnlPct != null ? `${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct}%` : '—'}</td>
                    <td style={{ ...th, color: p.stop ? '#ef4444' : '#555' }}>{p.stop ? `$${p.stop.toFixed(2)}` : '—'}</td>
                  </tr>))}
                </tbody>
              </table>
              <div style={{ color: '#555', fontSize: 10, marginTop: 8 }}>Recorded {d.recordedAt ? new Date(d.recordedAt).toLocaleString() : '—'} · IBKR snapshot {d.ibkrSyncedAt ? new Date(d.ibkrSyncedAt).toLocaleString() : '—'} · mode {d.mode}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

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
    <span className="tree-pulse" style={style} onClick={onClick} title={f.manual
      ? `${f.ticker} · $${f.price?.toFixed(2)} · MANUAL ONLY — ${f.note || 'no 42wk-high trigger yet (new IPO seasoning or data re-sync)'}; the engine never trades it`
      : `${f.ticker} · $${f.price?.toFixed(2)} · ${f.pctToHigh}% to 42wk high${f.shares > 0 ? ` · buy ${f.shares}sh · stop $${f.stop?.toFixed(2)} · risk $${f.risk}` : ''}`}>
      <b>{f.ticker}</b><span style={{ opacity: 0.8 }}>${f.price?.toFixed(2)}</span>
      {f.manual && <span style={{ background: '#0008', padding: '1px 5px', borderRadius: 5, color: '#facc15', fontSize: 10, fontWeight: 700, letterSpacing: '0.04em' }}>MANUAL</span>}
      {(f.state === 'attack' || f.state === 'approaching') && f.shares > 0 && (
        <>
          <span style={{ background: '#0008', padding: '1px 5px', borderRadius: 5 }}>{f.shares}sh</span>
          {f.stop != null && <span style={{ color: f.state === 'attack' ? '#fecaca' : '#f87171' }}>stop ${f.stop.toFixed(2)}</span>}
        </>
      )}
      {f.attackAt && <span style={{ opacity: 0.85, fontSize: 10 }} title="When this 42-week-high signal first fired (ET)">⚡{clockET(f.attackAt)}</span>}
    </span>
  );
}

function DevourCard({ p, onClick, offStrategy }) {
  const sim = !!p.sim;                                                     // PAPER simulated would-buy — NOT a real IBKR position
  const pnlColor = p.pnl >= 0 ? '#22c55e' : '#ef4444';
  const shares = p.shares || p.totalShares;
  const last = p.last ?? (p.avgCost || p.entryPrice);
  const avg = p.avgCost || p.entryPrice;                                   // break-even price
  const rps = (p.stop != null && last != null) ? last - p.stop : null;     // current price − stop
  const totalRisk = rps != null ? rps * shares : null;                     // × shares
  const prot = p.protected;

  // Exit-proximity warning (strategy positions only — off-strategy names have no engine
  // stop). RED = at/within 1% of the stop; YELLOW = within 0.05% of break-even.
  const nearStop = (!offStrategy && p.stop > 0 && last != null) ? last <= p.stop * (1 + NEAR_STOP_PCT) : false;
  const nearBreakeven = (!offStrategy && avg > 0 && last != null) ? Math.abs(last - avg) / avg <= NEAR_BE_PCT : false;
  const warn = nearStop ? 'stop' : (nearBreakeven ? 'be' : null);

  // PROTECT uses a BRIGHT GREEN (locked profit) — clearly green, never blue, so it can't be
  // mistaken for a paper sim (paper = dashed blue #3b82f6 + PAPER badge). Brighter than a
  // normal long's green so it still reads as its own "locked" state.
  const borderColor = sim ? '#3b82f6' : offStrategy ? '#b45309' : warn === 'stop' ? '#ef4444' : warn === 'be' ? '#facc15' : (prot ? '#4ade80' : '#22c55e');
  const bgColor     = sim ? '#0b1626' : offStrategy ? '#1a1304' : warn === 'stop' ? '#1c0d0d' : warn === 'be' ? '#1c190a' : (prot ? '#07231b' : '#0e1a12');
  const flashAnim   = offStrategy ? undefined
                    : warn === 'stop' ? 'treestopflash 0.85s ease-in-out infinite'
                    : warn === 'be'   ? 'treebeflash 1.1s ease-in-out infinite'
                    : (p.newToday ? 'treecardflash 1.1s ease-in-out infinite' : undefined);
  return (
    <div onClick={onClick} className="tree-pulse" title={sim ? 'PAPER — simulated would-buy recorded by the paper engine. Hypothetical only: no order was placed and this is NOT a position in IBKR. Click for charts.' : offStrategy ? 'Off strategy — Tree does not trade this; you manage it. Click for charts.' : (p.newToday ? 'NEW today · click for daily + weekly charts' : 'Click for daily + weekly charts')} style={{ cursor: 'pointer', background: bgColor, border: `1px ${sim ? 'dashed' : 'solid'} ${borderColor}`, borderRadius: 10, padding: '12px 14px', minWidth: 210, opacity: sim ? 0.94 : 1, ...(flashAnim ? { animation: flashAnim } : {}) }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ background: sim ? '#1e3a8a' : offStrategy ? '#7c4a03' : '#16a34a', border: `1px solid ${sim ? '#3b82f6' : offStrategy ? '#f59e0b' : '#22c55e'}`, color: '#fff', fontWeight: 800, fontSize: 14, padding: '3px 9px', borderRadius: 8, fontFamily: 'monospace' }}>{p.ticker}</span>
          <span style={{ color: sim ? '#60a5fa' : offStrategy ? '#f59e0b' : (prot ? '#4ade80' : '#22c55e'), fontSize: 11 }}>{sim ? 'PAPER LONG' : offStrategy ? 'OFF STRATEGY' : (prot ? '🛡️ LOCKED' : 'LONG')}</span>
          {sim && <span title="Simulated would-buy recorded by the paper engine — NOT a real position in IBKR; no order was placed." style={{ background: '#1e3a8a', color: '#bfdbfe', border: '1px solid #3b82f6', fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 4, letterSpacing: '0.05em' }}>PAPER</span>}
          {p.early && !offStrategy && <span title="You bought this before the engine's signal (a new 42-week high). The tag clears the moment the strategy triggers the buy." style={{ background: '#f59e0b', color: '#1a1200', fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 4, letterSpacing: '0.05em' }}>EARLY</span>}
          {p.newToday && <span style={{ background: '#22c55e', color: '#04210f', fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 4, letterSpacing: '0.05em' }}>NEW</span>}
          {warn === 'stop' && <span title={`Within ${(NEAR_STOP_PCT * 100).toFixed(0)}% of the stop ($${p.stop?.toFixed(2)}) — exit imminent`} style={{ background: '#ef4444', color: '#1a0000', fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 4, letterSpacing: '0.05em' }}>⚠ NEAR STOP</span>}
          {warn === 'be' && <span title={`Within ${(NEAR_BE_PCT * 100).toFixed(2)}% of break-even ($${avg?.toFixed(2)}) — trade at scratch`} style={{ background: '#facc15', color: '#1a1500', fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 4, letterSpacing: '0.05em' }}>≈ BREAK-EVEN</span>}
        </span>
        <span style={{ color: pnlColor, fontWeight: 700, fontFamily: 'monospace' }}>{p.pnl >= 0 ? '+' : ''}{fmt(p.pnl)} ({p.pnlPct}%)</span>
      </div>
      {p.attackAt && <div style={{ marginTop: 4, fontSize: 10, color: '#7fcf9f', fontFamily: 'monospace' }} title="When this name first appeared on ATTACK (its new 42-week-high trigger, ET)">⚡ ATTACK {clockET(p.attackAt)}</div>}
      {(p.company || p.sector) && (
        <div style={{ marginTop: 6, lineHeight: 1.3 }}>
          {p.company && <div style={{ color: '#bbb', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 240 }} title={p.company}>{p.company}</div>}
          {p.sector && <div style={{ color: prot ? '#86efac' : '#7fcf9f', fontSize: 10, letterSpacing: '0.03em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 240 }} title={`AI 300 sector: ${p.sector}`}>{p.sector}</div>}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 12px', marginTop: 8, fontSize: 12, fontFamily: 'monospace', color: '#ccc' }}>
        <span>Shares <b style={{ color: '#fff' }}>{p.shares || p.totalShares}</b></span>
        <span>Last <b style={{ color: '#fff' }}>${p.last?.toFixed(2)}</b></span>
        <span>Avg <b style={{ color: '#fff' }}>${(p.avgCost || p.entryPrice)?.toFixed(2)}</b></span>
        <span>Stop <b style={{ color: prot ? '#22c55e' : '#ef4444' }}>${p.stop?.toFixed(2)}</b></span>
        <span>Risk/sh <b style={{ color: '#facc15' }}>${rps != null ? rps.toFixed(2) : '--'}</b></span>
        <span>Total risk <b style={{ color: '#facc15' }}>{totalRisk != null ? fmt(totalRisk) : '--'}</b>{p.riskPct != null && totalRisk != null ? <span style={{ color: '#a16207' }}> · {p.riskPct}% NAV</span> : null}</span>
      </div>
      {p.boughtAt && <div style={{ marginTop: 6, fontSize: 10, color: '#7a7a7a', fontFamily: 'monospace' }} title="When this position was purchased (ET)">Bought {clockET(p.boughtAt)}</div>}
    </div>
  );
}

// A name that got stopped out in the last 24h. Stays RED on the page so a stop
// hit can't be missed (the live position itself vanishes the instant it sells).
function StoppedCard({ s, onClick }) {
  const loss = s.pnl ?? null;
  const pnlColor = (loss ?? 0) >= 0 ? '#22c55e' : '#ef4444';
  return (
    <div onClick={onClick} className="tree-pulse" title={`Stopped out ${agoStr(s.stoppedAt)} · click for daily + weekly charts`}
      style={{ cursor: 'pointer', background: '#1c0d0d', border: '1px solid #ef4444', borderRadius: 10, padding: '12px 14px', minWidth: 210, animation: 'treestopflash 0.85s ease-in-out infinite' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ background: '#7f1d1d', border: '1px solid #ef4444', color: '#fff', fontWeight: 800, fontSize: 14, padding: '3px 9px', borderRadius: 8, fontFamily: 'monospace' }}>{s.ticker}</span>
          <span style={{ color: '#ef4444', fontSize: 11, fontWeight: 700 }}>🛑 STOPPED OUT</span>
        </span>
        {loss != null && <span style={{ color: pnlColor, fontWeight: 700, fontFamily: 'monospace' }}>{loss >= 0 ? '+' : ''}{fmt(loss)}</span>}
      </div>
      {(s.company || s.sector) && (
        <div style={{ marginTop: 6, lineHeight: 1.3 }}>
          {s.company && <div style={{ color: '#bbb', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 240 }} title={s.company}>{s.company}</div>}
          {s.sector && <div style={{ color: '#f87171', fontSize: 10, letterSpacing: '0.03em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 240 }} title={`AI 300 sector: ${s.sector}`}>{s.sector}</div>}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 12px', marginTop: 8, fontSize: 12, fontFamily: 'monospace', color: '#ccc' }}>
        <span>Shares <b style={{ color: '#fff' }}>{s.shares}</b></span>
        <span>Exit <b style={{ color: '#fff' }}>{s.exitPrice != null ? `$${s.exitPrice.toFixed(2)}` : '--'}</b></span>
        <span>Avg <b style={{ color: '#fff' }}>{s.avgCost != null ? `$${s.avgCost.toFixed(2)}` : '--'}</b></span>
        <span>Stop <b style={{ color: '#ef4444' }}>{s.stop != null ? `$${s.stop.toFixed(2)}` : '--'}</b></span>
      </div>
      <div style={{ color: '#9a6565', fontSize: 10, marginTop: 8 }}>Stopped {agoStr(s.stoppedAt)} · stays 24h</div>
    </div>
  );
}

export default function PnthrTreePage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [chart, setChart] = useState(null);
  const [projection, setProjection] = useState(null);
  const [splitBusy, setSplitBusy] = useState(false);
  const [splitMsg, setSplitMsg] = useState(null);
  const [dailyLog, setDailyLog] = useState(null);       // null = closed; array = open modal
  const [logBusy, setLogBusy] = useState(false);
  const [scorecard, setScorecard] = useState(null);     // Risk Scorecard (forward-only)
  const [openDays, setOpenDays] = useState(() => new Set());   // which savings days are expanded
  const seenLatestDay = useRef(null);
  // Default: only the latest trading day expanded. When a NEW latest day appears (tomorrow),
  // collapse the rest and open just that one — "show only the present day of trading".
  useEffect(() => {
    const days = [...new Set((scorecard?.roundTrips || []).map(rt => rt.exitDate))].sort();
    const latest = days[days.length - 1];
    if (latest && seenLatestDay.current !== latest) { seenLatestDay.current = latest; setOpenDays(new Set([latest])); }
  }, [scorecard]);
  const toggleDay = (d) => setOpenDays(prev => { const n = new Set(prev); n.has(d) ? n.delete(d) : n.add(d); return n; });

  const openDailyLog = async () => {
    setDailyLog([]);   // open immediately, fill when loaded
    try {
      const r = await apiFetch(`${API_BASE}/api/pnthr-tree/daily-log`, { headers: authHeaders() });
      if (r.ok) setDailyLog((await r.json()).days || []);
    } catch { /* keep empty state */ }
  };
  const recordLogNow = async () => {
    setLogBusy(true);
    try {
      const r = await apiFetch(`${API_BASE}/api/admin/pnthr-tree/record-daily-log`, { method: 'POST', headers: authHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const fresh = await apiFetch(`${API_BASE}/api/pnthr-tree/daily-log`, { headers: authHeaders() });
      if (fresh.ok) setDailyLog((await fresh.json()).days || []);
    } catch (e) { setErr(e.message); } finally { setLogBusy(false); }
  };
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
  useEffect(() => {
    const go = () => apiFetch(`${API_BASE}/api/pnthr-tree/scorecard`, { headers: authHeaders() }).then(r => r.ok ? r.json() : null).then(setScorecard).catch(() => {});
    go(); const id = setInterval(go, 60000); return () => clearInterval(id);
  }, []);

  const setMode = async (mode) => {
    if (mode === 'live' && !window.confirm('AUTO-EXECUTE places REAL orders on every new 42-week high. Make sure Ambush & Elite are OFF (one engine per account). Proceed?')) return;
    setBusy(true);
    try {
      const r = await apiFetch(`${API_BASE}/api/admin/pnthr-tree/mode`, { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await load();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  // Manual trigger for split tracking: refreshes FMP's split calendar + re-syncs
  // any pending split's candles (same job that runs nightly at 4:15pm ET).
  const runSplitCheck = async () => {
    setSplitBusy(true); setSplitMsg(null);
    try {
      const r = await apiFetch(`${API_BASE}/api/admin/run-split-maintenance`, { method: 'POST', headers: authHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'failed');
      const bits = [];
      if (d.calendar?.upserts > 0) bits.push(`${d.calendar.upserts} new split${d.calendar.upserts === 1 ? '' : 's'} detected`);
      if (d.resynced?.length) bits.push(`re-synced: ${d.resynced.join(', ')}`);
      if (d.waiting?.length) bits.push(`waiting on FMP: ${d.waiting.join('; ')}`);
      bits.push(`${d.upcoming || 0} upcoming tracked`);
      setSplitMsg(`✓ ${bits.join(' · ')}`);
      await load();
    } catch (e) { setSplitMsg(`✗ split check failed: ${e.message}`); }
    finally { setSplitBusy(false); }
  };

  const mode = data?.mode || 'off';
  const funnel = data?.funnel || [];
  const positions = data?.positions || [];
  const protectedPos = positions.filter(p => p.protected);
  const devourPos = positions.filter(p => !p.protected);
  const recentStops = data?.recentStops || [];
  const manualTrades = data?.manualTrades || [];
  // sim = the paper engine's hypothetical would-buys (PAPER mode only); real = your
  // actual IBKR holdings. Kept strictly distinct so a simulation can never read as real.
  const simCount = positions.filter(p => p.sim).length;
  const realCount = positions.filter(p => p.real).length;
  // Devour roll-up: total open P&L, and total $ at risk if every stop fired (current price → stop).
  const devourPnl = devourPos.reduce((a, p) => a + (p.pnl || 0), 0);
  const devourRisk = devourPos.reduce((a, p) => {
    const last = p.last ?? (p.avgCost || p.entryPrice);
    return a + ((p.stop != null && last != null) ? (last - p.stop) * (p.shares || p.totalShares || 0) : 0);
  }, 0);
  // These roll-ups sum every Devour card; when any are paper sims the totals are
  // partly/wholly hypothetical, so label them rather than let them read as real $.
  const devourAllSim = devourPos.length > 0 && devourPos.every(p => p.sim);
  const devourHasSim = devourPos.some(p => p.sim);
  const attack = funnel.filter(f => f.state === 'attack' && !f.held);
  const approaching = funnel.filter(f => f.state === 'approaching' && !f.held);
  const stalking = funnel.filter(f => f.state === 'stalking' && !f.held).sort((a, b) => a.ticker.localeCompare(b.ticker));
  const nav = data?.nav || 0;

  // Render a position section: REAL (IBKR) cards first, then a clearly-labeled,
  // dash-bordered PAPER group for simulated would-buys. A hypothetical can never be
  // mistaken for a real holding — compliance-critical for a regulated fund (2026-06-16).
  const cardRow = { display: 'flex', gap: 12, flexWrap: 'wrap' };
  const renderPositions = (list) => {
    const navTickers = list.map(x => x.ticker);
    const real = list.filter(p => !p.sim);
    const sim = list.filter(p => p.sim);
    return (
      <>
        {real.length > 0 && <div style={cardRow}>{real.map((p, i) => <DevourCard key={'r' + i} p={p} onClick={() => openChart(navTickers, p.ticker)} />)}</div>}
        {sim.length > 0 && (
          <div style={{ marginTop: real.length ? 14 : 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7, color: '#93c5fd', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              <span style={{ background: '#1e3a8a', color: '#bfdbfe', border: '1px solid #3b82f6', padding: '1px 6px', borderRadius: 4, fontWeight: 800 }}>PAPER</span>
              simulated would-buys — hypothetical, not in IBKR ({sim.length})
            </div>
            <div style={cardRow}>{sim.map((p, i) => <DevourCard key={'s' + i} p={p} onClick={() => openChart(navTickers, p.ticker)} />)}</div>
          </div>
        )}
      </>
    );
  };

  return (
    <div className="pnthr-tree-root" style={{ padding: '20px 26px', color: '#e6e6e6' }}>
      <style>{`@keyframes treeflash { 0%,100% { box-shadow: 0 0 0 0 #22c55e88; opacity: 1; } 50% { box-shadow: 0 0 8px 2px #22c55e; opacity: 0.55; } }
        @keyframes treecardflash { 0%,100% { box-shadow: 0 0 0 0 #22c55e00; } 50% { box-shadow: 0 0 13px 3px #22c55e; } }
        /* Exit-proximity flashes on held cards: RED near the stop, YELLOW near break-even. */
        @keyframes treestopflash { 0%,100% { box-shadow: 0 0 0 0 #ef444400; } 50% { box-shadow: 0 0 15px 4px #ef4444; } }
        @keyframes treebeflash   { 0%,100% { box-shadow: 0 0 0 0 #facc1500; } 50% { box-shadow: 0 0 13px 3px #facc15; } }
        /* While any overlay modal is open, freeze the page's pulse animations —
           15 NEW-today cards glowing through the translucent backdrop reads as
           the whole page flickering (reported on Cash Ledger, 2026-06-12). */
        .pnthr-tree-root:has(.pnthr-overlay) .tree-pulse { animation: none !important; }`}</style>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', borderBottom: '2px solid #0b3d2e', paddingBottom: 10 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, color: '#22c55e' }}>🌳 PNTHR Tree</h1>
          <div style={{ color: '#888', fontSize: 12 }}>AI-300 · 42-week-high momentum · full size, 2-week-low trailing stop</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {busy && <span style={{ color: '#888', fontSize: 11 }}>saving…</span>}
          <ModeButton label="OFF" active={mode === 'off'} color="#666" onClick={() => setMode('off')} />
          <ModeButton label="PAPER TRADE" active={mode === 'paper'} color="#3b82f6" onClick={() => setMode('paper')} />
          <ModeButton label="AUTO-EXECUTE" active={mode === 'live'} color="#22c55e" onClick={() => setMode('live')} />
        </div>
      </div>

      {err && <div style={{ color: '#ef4444', fontSize: 12, marginTop: 8 }}>Error: {err}</div>}
      {data?.baselineDrift?.drifted && (
        <div style={{ background: '#3b0d0d', border: '2px solid #ef4444', borderRadius: 8, padding: '10px 14px', marginTop: 10, color: '#fca5a5', fontSize: 12, fontWeight: 600 }}>
          🔴 BACKTEST DRIFT — the data behind the backtest numbers below changed since they were locked (likely a split re-sync). The displayed backtest is now STALE and must be regenerated + verified. Last checked {data.baselineDrift.checkedAt ? new Date(data.baselineDrift.checkedAt).toLocaleString() : '—'}.
        </div>
      )}
      {mode === 'live' && <div style={{ background: '#3b0d0d', border: '1px solid #ef4444', borderRadius: 8, padding: '8px 12px', marginTop: 10, color: '#fca5a5', fontSize: 12 }}>⚠️ AUTO-EXECUTE is LIVE — real orders fire on new 42-week highs. Verify the first fill, and confirm Ambush/Elite are OFF.</div>}
      {mode === 'paper' && simCount > 0 && (
        <div style={{ background: '#0b1f3a', border: '1px dashed #3b82f6', borderRadius: 8, padding: '8px 12px', marginTop: 10, color: '#93c5fd', fontSize: 12 }}>
          📝 PAPER TRADE mode — {simCount} simulated would-buy{simCount === 1 ? '' : 's'} shown below (dashed blue cards with a “PAPER” tag). These are hypothetical, place NO real orders, and are NOT positions in your IBKR account. {realCount === 0 ? 'Your real IBKR account is currently flat.' : 'Your real holdings are the solid-bordered cards.'}
        </div>
      )}

      {/* Projected vs Actual AUM + PNTHR Goals — Tree's OWN backtest; each collapsible */}
      <div style={{ marginTop: 14 }}>
        {projection ? (
          <>
            <Collapsible title="PROJECTED vs ACTUAL AUM" storageKey="tree_collapse_aum">
              <AumTracker projection={projection} hideForward cashLedger={projection.cashLedger} onActualTable={openDailyLog} />
            </Collapsible>
            <Collapsible title="PNTHR GOALS" storageKey="tree_collapse_goals">
              <ForwardProjection forward={projection.forward} />
            </Collapsible>
          </>
        ) : <div style={{ color: '#666', fontSize: 12 }}>Loading projection…</div>}
      </div>

      {/* live funnel counts + current leverage + disclosure */}
      <div style={{ display: 'flex', gap: 18, color: '#888', fontSize: 11, marginBottom: 4, flexWrap: 'wrap', alignItems: 'center' }}>
        {data?.counts && <span>Stalking {data.counts.stalking || 0} · Approaching {data.counts.approaching || 0} · Attack {data.counts.attack || 0}</span>}
        {data && <span>Leverage <b style={{ color: (data.grossX || 0) > (data.grossCapX || 2) ? '#ef4444' : '#22c55e' }}>{data.grossX ?? 0}x</b> / {data.grossCapX ?? 2}x cap</span>}
        {data && <span>Net liq deployed <b style={{ color: (data.grossX || 0) > (data.grossCapX || 2) ? '#ef4444' : '#7fcf9f' }}>{Math.round((data.grossX || 0) * 100)}%</b> <span style={{ color: '#555' }}>(Σ % net liq)</span></span>}
        <button onClick={runSplitCheck} disabled={splitBusy}
          title="Refresh FMP's stock-split calendar + re-sync candles for any pending split (runs automatically every evening at 4:15pm ET)"
          style={{ padding: '3px 10px', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', background: 'transparent',
            border: '1px solid #2f6b46', borderRadius: 6, color: '#7fcf9f', cursor: splitBusy ? 'wait' : 'pointer' }}>
          {splitBusy ? 'CHECKING…' : '🪓 SPLIT CHECK'}
        </button>
        {splitMsg && <span style={{ color: splitMsg.startsWith('✗') ? '#ef4444' : '#7fcf9f' }}>{splitMsg}</span>}
        <span style={{ color: '#555' }}>Backtest hypothetical &amp; survivorship-flattered (current AI-300 names). Not a track record.</span>
      </div>

      {/* Categorized open P&L — TREE strategy + IBKR (manual) = Total (matches your IBKR account) */}
      {data && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'baseline', fontFamily: 'monospace', padding: '9px 14px', background: '#0c140e', border: '1px solid #14331f', borderRadius: 8, marginBottom: 8 }}>
          <span style={{ color: '#888', fontSize: 12 }} title="TREE strategy positions (Devour + Protect)">TREE P&amp;L <b style={{ color: (data.treePnl || 0) >= 0 ? '#22c55e' : '#ef4444' }}>{(data.treePnl || 0) >= 0 ? '+' : '-'}{fmt(Math.abs(data.treePnl || 0))}</b></span>
          <span style={{ color: '#555' }}>+</span>
          <span style={{ color: '#888', fontSize: 12 }} title="Your manual / off-strategy holdings — in IBKR but not part of the TREE strategy (e.g. SPCX)">IBKR P&amp;L <b style={{ color: (data.manualPnl || 0) >= 0 ? '#facc15' : '#ef4444' }}>{(data.manualPnl || 0) >= 0 ? '+' : '-'}{fmt(Math.abs(data.manualPnl || 0))}</b></span>
          <span style={{ color: '#555' }}>=</span>
          <span style={{ color: '#bbb', fontSize: 12 }}>Total P&amp;L <b style={{ color: (data.openPnl || 0) >= 0 ? '#22c55e' : '#ef4444', fontSize: 15 }}>{(data.openPnl || 0) >= 0 ? '+' : '-'}{fmt(Math.abs(data.openPnl || 0))}</b> <span style={{ color: '#555' }}>= your IBKR account</span></span>
          {!!data.simPnl && <span style={{ color: '#666', fontSize: 11 }}>· sim would-buys {data.simPnl >= 0 ? '+' : '-'}{fmt(Math.abs(data.simPnl))} (hypothetical, not in IBKR)</span>}
        </div>
      )}

      {/* TOTAL RISK (heat) — your real account vs the strategy's book. Heat = $ you'd give back if every
          stop fired (price − stop) × shares, shown $ and % of NAV. Whether carrying less is a WIN depends
          on return too — that's scored per-trade in the scorecard (next build). */}
      {data?.totalRisk && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'baseline', fontFamily: 'monospace', padding: '9px 14px', background: '#140f0c', border: '1px solid #3a2410', borderRadius: 8, marginBottom: 8 }}>
          <span style={{ color: '#888', fontSize: 12 }} title="What the strategy's book would lose if every stop fired (paper sim in paper mode, your real book once live)">
            Strategy risk <b style={{ color: '#facc15' }}>{fmt(data.totalRisk.strategy)}</b> <span style={{ color: '#a16207' }}>({data.totalRisk.strategyPct}% of NAV)</span>
          </span>
          <span style={{ color: '#555' }}>vs</span>
          <span style={{ color: '#888', fontSize: 12 }} title="What YOUR real account would give back if every position stopped from here">
            Your risk <b style={{ color: data.totalRisk.actual <= data.totalRisk.strategy ? '#22c55e' : '#ef4444' }}>{fmt(data.totalRisk.actual)}</b> <span style={{ color: data.totalRisk.actual <= data.totalRisk.strategy ? '#4ade80' : '#f87171' }}>({data.totalRisk.actualPct}% of NAV)</span>
          </span>
          <span style={{ color: '#666', fontSize: 11 }}>
            {data.totalRisk.actual < data.totalRisk.strategy ? `carrying ${fmt(data.totalRisk.strategy - data.totalRisk.actual)} less heat than the strategy`
              : data.totalRisk.actual > data.totalRisk.strategy ? `carrying ${fmt(data.totalRisk.actual - data.totalRisk.strategy)} more heat than the strategy`
              : 'matching the strategy’s heat'}
          </span>
        </div>
      )}

      {/* PROTECT — trailing stop has reached/passed entry → worst case is a locked profit. Shown FIRST. */}
      <div style={{ marginTop: 20 }}>
        <h3 style={{ color: '#4ade80', fontSize: 13, letterSpacing: '0.08em' }}>🛡️ PROTECT — PROFIT LOCKED ({protectedPos.length})</h3>
        {protectedPos.length === 0 ? <div style={{ color: '#666', fontSize: 12 }}>None yet — a position moves here once its trailing stop reaches your entry (stop ≥ avg cost).</div> :
          renderPositions(protectedPos)}
      </div>

      {/* RECENTLY STOPPED — stop hit in the last 24h; stays red so it can't be missed (sits with PROTECT) */}
      {recentStops.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <h3 style={{ color: '#ef4444', fontSize: 13, letterSpacing: '0.08em' }}>🛑 RECENTLY STOPPED — LAST 24H ({recentStops.length})</h3>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>{recentStops.map((s, i) => <StoppedCard key={i} s={s} onClick={() => openChart([s.ticker], s.ticker)} />)}</div>
        </div>
      )}

      {/* DEVOUR — held, trailing stop still below entry (capital at risk). Shown after PROTECT. */}
      <div style={{ marginTop: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 12, borderBottom: '1px solid #1c3a28', paddingBottom: 6, marginBottom: 10 }}>
          <h3 style={{ color: '#22c55e', fontSize: 13, letterSpacing: '0.08em', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            DEVOUR — POSITIONS, RISK ON · PURCHASED ({devourPos.length})
            {devourHasSim && <span title="These Devour figures include paper simulations — hypothetical, not real IBKR risk." style={{ background: '#1e3a8a', color: '#bfdbfe', border: '1px solid #3b82f6', fontSize: 9, fontWeight: 800, padding: '1px 6px', borderRadius: 4, letterSpacing: '0.05em' }}>{devourAllSim ? 'ALL PAPER' : 'INCL. PAPER'}</span>}
          </h3>
          <div style={{ display: 'flex', gap: 20, fontSize: 12, fontFamily: 'monospace' }}>
            <span style={{ color: '#888' }}>{devourAllSim ? 'Paper P&L' : 'Devour P&L'} <b style={{ color: devourPnl >= 0 ? '#22c55e' : '#ef4444' }}>{devourPnl >= 0 ? '+' : '-'}{fmt(Math.abs(devourPnl))}</b>{devourAllSim && <span style={{ color: '#555' }}> (sim)</span>}</span>
            <span style={{ color: '#888' }}>{devourAllSim ? 'Paper risk if all stopped' : 'Total risk if all stopped'} <b style={{ color: '#facc15' }}>-{fmt(devourRisk)}</b> <span style={{ color: '#555' }}>({nav > 0 ? (devourRisk / nav * 100).toFixed(1) : '0'}% of NAV){devourAllSim ? ', hypothetical' : ''}</span></span>
          </div>
        </div>
        {devourPos.length === 0 ? <div style={{ color: '#666', fontSize: 12 }}>No positions with open risk.</div> :
          renderPositions(devourPos)}
      </div>

      {/* ATTACK — new highs */}
      <div style={{ marginTop: 18 }}>
        <h3 style={{ color: '#22c55e', fontSize: 13, letterSpacing: '0.08em' }}>⚔️ ATTACK — NEW 42-WEEK HIGHS · READY FOR PURCHASE ({attack.length})</h3>
        {attack.length === 0 ? <div style={{ color: '#666', fontSize: 12 }}>None at a new high right now.</div> :
          <div>{attack.map(f => <Badge key={f.ticker} f={f} onClick={() => openChart(attack.map(x => x.ticker), f.ticker)} />)}</div>}
      </div>

      {/* MANUAL TRADES — positions you hold that Tree never trades (SPCX, non-AI-300) */}
      {manualTrades.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <h3 style={{ color: '#f59e0b', fontSize: 13, letterSpacing: '0.08em' }}>✋ MANUAL TRADES — OFF STRATEGY ({manualTrades.length})</h3>
          <div style={{ color: '#777', fontSize: 11, marginBottom: 8 }}>You hold these; the engine doesn't manage them (excluded names like SPCX, or anything outside the AI-300). P&amp;L is your real P&amp;L.</div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>{manualTrades.map((p, i) => <DevourCard key={i} p={p} offStrategy onClick={() => openChart(manualTrades.map(x => x.ticker), p.ticker)} />)}</div>
        </div>
      )}

      {/* APPROACHING — flashing */}
      <div style={{ marginTop: 18 }}>
        <h3 style={{ color: '#facc15', fontSize: 13, letterSpacing: '0.08em' }}>APPROACHING — within 1% of a new high ({approaching.length})</h3>
        {approaching.length === 0 ? <div style={{ color: '#666', fontSize: 12 }}>None close yet.</div> :
          <div>{approaching.map(f => <Badge key={f.ticker} f={f} onClick={() => openChart(approaching.map(x => x.ticker), f.ticker)} />)}</div>}
      </div>

      {/* STALKING — the universe */}
      <div style={{ marginTop: 18 }}>
        <h3 style={{ color: '#7fcf9f', fontSize: 13, letterSpacing: '0.08em' }}>STALKING — AI-300 universe, A→Z ({stalking.length})</h3>
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>{stalking.map(f => <Badge key={f.ticker} f={f} onClick={() => openChart(stalking.map(x => x.ticker), f.ticker)} />)}</div>
      </div>

      {/* RISK SCORECARD — forward-only: did your active management beat the strategy on return-per-drawdown? */}
      {scorecard && (
        <div style={{ marginTop: 18, border: '1px solid #2a2a2a', borderRadius: 10, padding: '12px 14px', background: '#0c0c0c' }}>
          <h3 style={{ color: '#e6e6e6', fontSize: 13, letterSpacing: '0.08em', margin: '0 0 8px' }}>🎯 RISK SCORECARD — your management vs the strategy</h3>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'baseline', fontFamily: 'monospace', fontSize: 12, color: '#ccc', marginBottom: 8 }}>
            <span title="Peak-to-trough of your real AUM since live tracking began">Your max drawdown <b style={{ color: '#22c55e' }}>{scorecard.portfolio?.actualMaxDDPct}%</b></span>
            <span style={{ color: '#555' }}>vs</span>
            <span title="The backtest's max drawdown — the number you're trying to beat by managing risk">Backtest <b style={{ color: '#facc15' }}>{scorecard.portfolio?.backtestDDPct}%</b></span>
            <span style={{ color: '#666', fontSize: 11 }}>· tracking since {scorecard.portfolio?.since || '—'} ({scorecard.portfolio?.aumDays || 0} days)</span>
          </div>
          {(scorecard.counts.WIN + scorecard.counts.MIXED + scorecard.counts.LOSS) > 0 && (
            <div style={{ display: 'flex', gap: 12, fontSize: 12, fontWeight: 700, marginBottom: 8 }}>
              <span style={{ color: '#22c55e' }}>WIN {scorecard.counts.WIN}</span>
              <span style={{ color: '#facc15' }}>MIXED {scorecard.counts.MIXED}</span>
              <span style={{ color: '#ef4444' }}>LOSS {scorecard.counts.LOSS}</span>
            </div>
          )}
          {scorecard.savings && scorecard.roundTrips?.length > 0 && (() => {
            // Group every round trip by its EXIT day (the day the round trip was initiated), newest first.
            const byDay = {};
            for (const rt of scorecard.roundTrips) (byDay[rt.exitDate] ||= []).push(rt);
            const days = Object.keys(byDay).sort((a, b) => String(b).localeCompare(String(a)));
            const money = (n) => `${n >= 0 ? '+$' : '−$'}${Math.abs(n).toLocaleString()}`;
            return (
              <div style={{ marginBottom: 10, border: '1px solid #1f2a1f', borderRadius: 8, padding: '8px 10px', background: '#0a0f0a' }}>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline', fontFamily: 'monospace', fontSize: 12 }}>
                  <span style={{ color: '#86efac', fontWeight: 800, letterSpacing: '0.05em' }}>💰 TRADE-SKILL SAVINGS</span>
                  <span title="Round trip: (your exit price − your re-entry price) × shares, summed across every exit-and-reenter. Positive = you bought back lower; negative = you re-entered higher (the move ran away). Grouped by the day you exited.">
                    net <b style={{ color: scorecard.savings.totalSaved >= 0 ? '#22c55e' : '#ef4444' }}>{money(scorecard.savings.totalSaved)}</b>
                  </span>
                  <span style={{ color: '#777', fontSize: 11 }}>{scorecard.roundTrips.length} round trips · {scorecard.savings.wins} saved / {scorecard.savings.costs} cost{scorecard.savings.openTrips ? ` · ${scorecard.savings.openTrips} re-entry still open` : ''}</span>
                </div>
                <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
                  {days.map((day) => {
                    const trips = byDay[day].slice().sort((a, b) => a.savings - b.savings);   // biggest cost first within the day
                    const dayPnl = trips.reduce((s, rt) => s + rt.savings, 0);
                    const isOpen = openDays.has(day);
                    return (
                      <div key={day} style={{ border: '1px solid #1c1c1c', borderRadius: 6, background: '#0e0e0e' }}>
                        <div onClick={() => toggleDay(day)} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', cursor: 'pointer', padding: '6px 10px', fontFamily: 'monospace', fontSize: 12, userSelect: 'none' }}>
                          <span style={{ color: '#888', width: 10 }}>{isOpen ? '▾' : '▸'}</span>
                          <span style={{ fontWeight: 800, color: '#ddd' }}>{day}</span>
                          <span style={{ color: '#666', fontSize: 11 }}>{trips.length} trade{trips.length === 1 ? '' : 's'}</span>
                          <span style={{ marginLeft: 'auto', fontWeight: 800, color: dayPnl >= 0 ? '#22c55e' : '#ef4444' }}>{money(dayPnl)}</span>
                        </div>
                        {isOpen && (
                          <div style={{ display: 'grid', gap: 4, padding: '0 10px 8px 24px' }}>
                            {trips.map((rt, i) => (
                              <div key={i} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', fontFamily: 'monospace', fontSize: 11, color: '#bbb' }}>
                                <span style={{ fontWeight: 800, color: '#fff', minWidth: 48 }}>{rt.ticker}</span>
                                <span>sold ${rt.exitPx} {String(rt.exitDate).slice(5)} → re-bought ${rt.reentryPx} {String(rt.reentryDate).slice(5)}{rt.reentryOpen ? ' (open)' : ''}</span>
                                <span style={{ color: '#777' }}>{rt.shares}sh</span>
                                <span style={{ marginLeft: 'auto', color: rt.savings >= 0 ? '#22c55e' : '#ef4444', fontWeight: 700 }}>{rt.savings >= 0 ? 'saved ' : 'cost '}{money(rt.savings)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
          {scorecard.scored.length > 0 ? (
            <div style={{ display: 'grid', gap: 6 }}>
              {scorecard.scored.map((s, i) => {
                const v = s.score?.verdict;
                const c = v === 'WIN' ? '#22c55e' : v === 'LOSS' ? '#ef4444' : '#facc15';
                return (
                  <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontFamily: 'monospace', fontSize: 12, padding: '6px 10px', background: '#121212', border: '1px solid #222', borderRadius: 8 }}>
                    <span style={{ fontWeight: 800, color: '#fff', minWidth: 52 }}>{s.ticker}</span>
                    {v ? <span style={{ background: c + '22', color: c, border: `1px solid ${c}66`, fontSize: 10, fontWeight: 800, padding: '1px 6px', borderRadius: 4 }}>{v}{s.score.edgePct != null ? ` ${s.score.edgePct >= 0 ? '+' : ''}${s.score.edgePct}%` : ''}</span>
                       : <span style={{ color: '#888', fontSize: 11 }}>no strategy match</span>}
                    <span style={{ color: '#7fcf9f' }}>you: {s.returnPct >= 0 ? '+' : ''}{s.returnPct}% · {s.ddPct}% DD</span>
                    {s.strategy && <span style={{ color: '#999' }}>strategy{s.strategy.open ? ' (still holding)' : ''}: {s.strategy.returnPct >= 0 ? '+' : ''}{s.strategy.returnPct}% · {s.strategy.ddPct}% DD</span>}
                    {s.ddAvoidedPct != null && s.ddAvoidedPct > 0 && <span title="Drawdown the strategy sat through that you sidestepped by exiting" style={{ color: '#22c55e' }}>DD avoided {s.ddAvoidedPct}%</span>}
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ color: '#777', fontSize: 12 }}>No trades to score yet — fills recorded: <b style={{ color: '#aaa' }}>{scorecard.fillsRecorded}</b>. Scores each trade as you make it (return-per-drawdown vs the strategy).</div>
          )}
          {scorecard.strategyOnly.length > 0 && (
            <div style={{ marginTop: 8, color: '#777', fontSize: 11 }}>
              Strategy benchmark (engine trades — the bar to beat): {scorecard.strategyOnly.slice(0, 6).map(s => `${s.ticker} ${s.returnPct >= 0 ? '+' : ''}${s.returnPct}%/${s.ddPct}%DD`).join(' · ')}
            </div>
          )}
          <div style={{ color: '#555', fontSize: 10, marginTop: 8 }}>{scorecard.note}</div>
        </div>
      )}

      <div style={{ color: '#555', fontSize: 10, marginTop: 18, borderTop: '1px solid #222', paddingTop: 8 }}>
        Updates every 30s. PAPER records to a paper book (no real orders). AUTO-EXECUTE places real orders via the bridge — must own AI-300 alone (Ambush & Elite off). Backtest is hypothetical & survivorship-flattered; not a track record.
      </div>

      {dailyLog !== null && (
        <TreeDailyLogModal days={dailyLog} onClose={() => setDailyLog(null)} onRecordNow={recordLogNow} busy={logBusy} />
      )}

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
