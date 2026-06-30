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
              <div style={{ color: '#9a9a9a', fontSize: 10, marginTop: 8 }}>Recorded {d.recordedAt ? new Date(d.recordedAt).toLocaleString() : '—'} · IBKR snapshot {d.ibkrSyncedAt ? new Date(d.ibkrSyncedAt).toLocaleString() : '—'} · mode {d.mode}</div>
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

// Per-card buyback toggle. When buybacks are ALLOWED it reads "NO BUYBACK" (click to
// block); when BLOCKED it reads "BUY BACK" (red — click to allow again). The engine
// skips re-entering a blocked name, so a position you manually sell stays sold.
function NoBuybackBadge({ ticker, blocked, onToggle, busy }) {
  if (!onToggle) return null;
  return (
    <span
      onClick={(e) => { e.stopPropagation(); if (!busy) onToggle(ticker, blocked); }}
      title={blocked
        ? `Buybacks are BLOCKED for ${ticker} — the engine will NOT re-buy it, so it stays sold. Click to allow buybacks again.`
        : `The engine may re-buy ${ticker} on a new 42-week high. Click to block buybacks so it stays sold after you sell it.`}
      style={{
        cursor: busy ? 'wait' : 'pointer', fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 4,
        letterSpacing: '0.04em', userSelect: 'none', whiteSpace: 'nowrap',
        ...(blocked
          ? { background: '#7f1d1d', color: '#fecaca', border: '1px solid #ef4444' }
          : { background: 'transparent', color: '#9aa0aa', border: '1px solid #3a3a3a' }),
      }}>
      {blocked ? '🔒 BUY BACK' : '🚫 NO BUYBACK'}
    </span>
  );
}

function Badge({ f, onClick, onToggleBuyback, liqFrac }) {
  // stalking = outline; approaching = flashing; attack = filled. ATTACK/APPROACHING are shaded by
  // liquidity: most liquid = DARK green (liqFrac 0), least liquid = LIGHT green (liqFrac 1).
  const base = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 8, margin: 3, fontSize: 12, cursor: 'pointer', fontFamily: 'monospace' };
  const liqBg = `hsl(142, 64%, ${Math.round(26 + (liqFrac ?? 1) * 30)}%)`;   // 26% dark → 56% light
  let style;
  if (f.state === 'attack') style = { ...base, background: liqBg, border: '1px solid #22c55e', color: '#fff', fontWeight: 700 };
  else if (f.state === 'approaching') style = { ...base, background: liqBg, border: '1px dashed #86efac', color: '#fff', fontWeight: 600, animation: 'treeflash 1s ease-in-out infinite' };
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
      {!f.manual && (f.state !== 'stalking' || f.noBuyback) && <NoBuybackBadge ticker={f.ticker} blocked={f.noBuyback} onToggle={onToggleBuyback} />}
    </span>
  );
}

function DevourCard({ p, onClick, offStrategy, onToggleBuyback }) {
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
      {!offStrategy && onToggleBuyback && (
        <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
          <NoBuybackBadge ticker={p.ticker} blocked={p.noBuyback} onToggle={onToggleBuyback} />
        </div>
      )}
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
  const [openTickers, setOpenTickers] = useState(() => new Set());   // which day|ticker rows are expanded to their individual trades
  const seenLatestDay = useRef(null);
  // Default: only the latest trading day expanded. When a NEW latest day appears (tomorrow),
  // collapse the rest and open just that one — "show only the present day of trading".
  useEffect(() => {
    const days = [...new Set([...(scorecard?.roundTrips || []).map(rt => rt.exitDate), ...(scorecard?.preventedExits || []).map(w => w.exitDate)])].sort();
    const latest = days[days.length - 1];
    if (latest && seenLatestDay.current !== latest) { seenLatestDay.current = latest; setOpenDays(new Set([latest])); }
  }, [scorecard]);
  const toggleDay = (d) => setOpenDays(prev => { const n = new Set(prev); n.has(d) ? n.delete(d) : n.add(d); return n; });
  const toggleTicker = (k) => setOpenTickers(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });

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

  // Toggle the per-ticker "no buyback" lock — block (or re-allow) the engine re-entering
  // a name. Optimistically reflect it, then reload from the server.
  const toggleBuyback = async (ticker, currentlyBlocked) => {
    try {
      const r = await apiFetch(`${API_BASE}/api/admin/pnthr-tree/no-buyback`, { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ ticker, blocked: !currentlyBlocked }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await load();
    } catch (e) { setErr(e.message); }
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
  // ATTACK + APPROACHING sorted MOST-LIQUID → least (20-day avg share volume = the engine's buy priority);
  // a new name lands in its liquidity slot automatically. Badge shades dark-green (liquid) → light-green.
  const byLiquidity = (a, b) => (b.adv ?? -1) - (a.adv ?? -1);
  const attack = funnel.filter(f => f.state === 'attack' && !f.held).sort(byLiquidity);
  const approaching = funnel.filter(f => f.state === 'approaching' && !f.held).sort(byLiquidity);
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
        {real.length > 0 && <div style={cardRow}>{real.map((p, i) => <DevourCard key={'r' + i} p={p} onClick={() => openChart(navTickers, p.ticker)} onToggleBuyback={toggleBuyback} />)}</div>}
        {sim.length > 0 && (
          <div style={{ marginTop: real.length ? 14 : 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7, color: '#93c5fd', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              <span style={{ background: '#1e3a8a', color: '#bfdbfe', border: '1px solid #3b82f6', padding: '1px 6px', borderRadius: 4, fontWeight: 800 }}>PAPER</span>
              simulated would-buys — hypothetical, not in IBKR ({sim.length})
            </div>
            <div style={cardRow}>{sim.map((p, i) => <DevourCard key={'s' + i} p={p} onClick={() => openChart(navTickers, p.ticker)} onToggleBuyback={toggleBuyback} />)}</div>
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
          {data?.readOnly ? (
            <span style={{ padding: '8px 14px', borderRadius: 8, fontWeight: 700, fontSize: 13, letterSpacing: '0.04em', border: '1px solid #3b82f6', background: '#0b1f3a', color: '#93c5fd' }}>
              📝 PAPER BOOK · {fmt(data.baseCapital || data.nav || 0)}
            </span>
          ) : (
            <>
              <ModeButton label="OFF" active={mode === 'off'} color="#666" onClick={() => setMode('off')} />
              <ModeButton label="PAPER TRADE" active={mode === 'paper'} color="#3b82f6" onClick={() => setMode('paper')} />
              <ModeButton label="AUTO-EXECUTE" active={mode === 'live'} color="#22c55e" onClick={() => setMode('live')} />
            </>
          )}
        </div>
      </div>

      {err && <div style={{ color: '#ef4444', fontSize: 12, marginTop: 8 }}>Error: {err}</div>}
      {data?.baselineDrift?.drifted && (
        <div style={{ background: '#3b0d0d', border: '2px solid #ef4444', borderRadius: 8, padding: '10px 14px', marginTop: 10, color: '#fca5a5', fontSize: 12, fontWeight: 600 }}>
          🔴 BACKTEST DRIFT — the displayed backtest numbers no longer match current data
          {data.baselineDrift.storedNet != null && data.baselineDrift.currentNet != null
            ? ` (locked ${data.baselineDrift.storedNet}% net vs ${data.baselineDrift.currentNet}% on current data)`
            : ''}
          . This is an AI-300 membership change or a trade-moving data revision, not a routine split. Regenerate + verify the baseline. Last checked {data.baselineDrift.checkedAt ? new Date(data.baselineDrift.checkedAt).toLocaleString() : '—'}.
        </div>
      )}
      {mode === 'live' && <div style={{ background: '#3b0d0d', border: '1px solid #ef4444', borderRadius: 8, padding: '8px 12px', marginTop: 10, color: '#fca5a5', fontSize: 12 }}>⚠️ AUTO-EXECUTE is LIVE — real orders fire on new 42-week highs. Verify the first fill, and confirm Ambush/Elite are OFF.</div>}
      {data?.readOnly && (
        <div style={{ background: '#0b1f3a', border: '1px dashed #3b82f6', borderRadius: 8, padding: '8px 12px', marginTop: 10, color: '#93c5fd', fontSize: 12 }}>
          📝 This is your PNTHR Tree paper book, sized to {fmt(data.baseCapital || data.nav || 0)}. The strategy runs automatically: every new 42-week high is a simulated buy with a 2-week-low trailing stop and a $250 breakeven snap. These are hypothetical paper trades, place NO real orders, and are not held in any brokerage account. When you connect your own brokerage down the road, this can switch to live trading.
        </div>
      )}
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
              <AumTracker projection={projection} hideForward cashLedger={projection.cashLedger} onActualTable={data?.readOnly ? undefined : openDailyLog} />
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
        {!data?.readOnly && (<>
        <button onClick={runSplitCheck} disabled={splitBusy}
          title="Refresh FMP's stock-split calendar + re-sync candles for any pending split (runs automatically every evening at 4:15pm ET)"
          style={{ padding: '3px 10px', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', background: 'transparent',
            border: '1px solid #2f6b46', borderRadius: 6, color: '#7fcf9f', cursor: splitBusy ? 'wait' : 'pointer' }}>
          {splitBusy ? 'CHECKING…' : '🪓 SPLIT CHECK'}
        </button>
        {splitMsg && <span style={{ color: splitMsg.startsWith('✗') ? '#ef4444' : '#7fcf9f' }}>{splitMsg}</span>}
        </>)}
        <span style={{ color: '#555' }}>Backtest hypothetical &amp; survivorship-flattered (current AI-300 names). Not a track record.</span>
      </div>

      {/* Categorized open P&L — TREE strategy + IBKR (manual) = Total (matches your IBKR account) */}
      {data && data.readOnly && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'baseline', fontFamily: 'monospace', padding: '9px 14px', background: '#0c140e', border: '1px solid #14331f', borderRadius: 8, marginBottom: 8 }}>
          <span style={{ color: '#bbb', fontSize: 12 }}>Open P&amp;L <b style={{ color: (data.openPnl || 0) >= 0 ? '#22c55e' : '#ef4444', fontSize: 15 }}>{(data.openPnl || 0) >= 0 ? '+' : '-'}{fmt(Math.abs(data.openPnl || 0))}</b> <span style={{ color: '#555' }}>· your paper book (hypothetical)</span></span>
        </div>
      )}
      {data && !data.readOnly && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'baseline', fontFamily: 'monospace', padding: '9px 14px', background: '#0c140e', border: '1px solid #14331f', borderRadius: 8, marginBottom: 8 }}>
          <span style={{ color: '#888', fontSize: 12 }} title="TREE strategy positions (Devour + Protect)">TREE P&amp;L <b style={{ color: (data.treePnl || 0) >= 0 ? '#22c55e' : '#ef4444' }}>{(data.treePnl || 0) >= 0 ? '+' : '-'}{fmt(Math.abs(data.treePnl || 0))}</b></span>
          <span style={{ color: '#555' }}>+</span>
          <span style={{ color: '#888', fontSize: 12 }} title="Your manual / off-strategy holdings — in IBKR but not part of the TREE strategy (e.g. SPCX)">IBKR P&amp;L <b style={{ color: (data.manualPnl || 0) >= 0 ? '#facc15' : '#ef4444' }}>{(data.manualPnl || 0) >= 0 ? '+' : '-'}{fmt(Math.abs(data.manualPnl || 0))}</b></span>
          <span style={{ color: '#555' }}>=</span>
          <span style={{ color: '#bbb', fontSize: 12 }}>Total P&amp;L <b style={{ color: (data.openPnl || 0) >= 0 ? '#22c55e' : '#ef4444', fontSize: 15 }}>{(data.openPnl || 0) >= 0 ? '+' : '-'}{fmt(Math.abs(data.openPnl || 0))}</b> <span style={{ color: '#555' }}>= your IBKR account</span></span>
          {!!data.simPnl && <span style={{ color: '#9a9a9a', fontSize: 11 }}>· sim would-buys {data.simPnl >= 0 ? '+' : '-'}{fmt(Math.abs(data.simPnl))} (hypothetical, not in IBKR)</span>}
        </div>
      )}

      {/* TOTAL RISK (heat) — your real account vs the strategy's book. Heat = $ you'd give back if every
          stop fired (price − stop) × shares, shown $ and % of NAV. Whether carrying less is a WIN depends
          on return too — that's scored per-trade in the scorecard (next build). */}
      {data?.totalRisk && data.readOnly && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'baseline', fontFamily: 'monospace', padding: '9px 14px', background: '#140f0c', border: '1px solid #3a2410', borderRadius: 8, marginBottom: 8 }}>
          <span style={{ color: '#888', fontSize: 12 }} title="What this paper book would give back if every position stopped from here">
            Open risk <b style={{ color: '#facc15' }}>{fmt(data.totalRisk.actual)}</b> <span style={{ color: '#a16207' }}>({data.totalRisk.actualPct}% of NAV)</span> <span style={{ color: '#666' }}>— if every stop fired from here</span>
          </span>
        </div>
      )}
      {data?.totalRisk && !data.readOnly && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'baseline', fontFamily: 'monospace', padding: '9px 14px', background: '#140f0c', border: '1px solid #3a2410', borderRadius: 8, marginBottom: 8 }}>
          <span style={{ color: '#888', fontSize: 12 }} title="What the strategy's book would lose if every stop fired (paper sim in paper mode, your real book once live)">
            Strategy risk <b style={{ color: '#facc15' }}>{fmt(data.totalRisk.strategy)}</b> <span style={{ color: '#a16207' }}>({data.totalRisk.strategyPct}% of NAV)</span>
          </span>
          <span style={{ color: '#555' }}>vs</span>
          <span style={{ color: '#888', fontSize: 12 }} title="What YOUR real account would give back if every position stopped from here">
            Your risk <b style={{ color: data.totalRisk.actual <= data.totalRisk.strategy ? '#22c55e' : '#ef4444' }}>{fmt(data.totalRisk.actual)}</b> <span style={{ color: data.totalRisk.actual <= data.totalRisk.strategy ? '#4ade80' : '#f87171' }}>({data.totalRisk.actualPct}% of NAV)</span>
          </span>
          <span style={{ color: '#9a9a9a', fontSize: 11 }}>
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
          <div>{attack.map((f, i, arr) => <Badge key={f.ticker} f={f} liqFrac={arr.length > 1 ? i / (arr.length - 1) : 0} onClick={() => openChart(attack.map(x => x.ticker), f.ticker)} onToggleBuyback={toggleBuyback} />)}</div>}
      </div>

      {/* MANUAL TRADES — positions you hold that Tree never trades (SPCX, non-AI-300) */}
      {manualTrades.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <h3 style={{ color: '#f59e0b', fontSize: 13, letterSpacing: '0.08em' }}>✋ MANUAL TRADES — OFF STRATEGY ({manualTrades.length})</h3>
          <div style={{ color: '#b3b3b3', fontSize: 11, marginBottom: 8 }}>You hold these; the engine doesn't manage them (excluded names like SPCX, or anything outside the AI-300). P&amp;L is your real P&amp;L.</div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>{manualTrades.map((p, i) => <DevourCard key={i} p={p} offStrategy onClick={() => openChart(manualTrades.map(x => x.ticker), p.ticker)} />)}</div>
        </div>
      )}

      {/* APPROACHING — flashing */}
      <div style={{ marginTop: 18 }}>
        <h3 style={{ color: '#facc15', fontSize: 13, letterSpacing: '0.08em' }}>APPROACHING — within 1% of a new high ({approaching.length})</h3>
        {approaching.length === 0 ? <div style={{ color: '#666', fontSize: 12 }}>None close yet.</div> :
          <div>{approaching.map((f, i, arr) => <Badge key={f.ticker} f={f} liqFrac={arr.length > 1 ? i / (arr.length - 1) : 0} onClick={() => openChart(approaching.map(x => x.ticker), f.ticker)} onToggleBuyback={toggleBuyback} />)}</div>}
      </div>

      {/* STALKING — the universe */}
      <div style={{ marginTop: 18 }}>
        <h3 style={{ color: '#7fcf9f', fontSize: 13, letterSpacing: '0.08em' }}>STALKING — AI-300 universe, A→Z ({stalking.length})</h3>
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>{stalking.map(f => <Badge key={f.ticker} f={f} onClick={() => openChart(stalking.map(x => x.ticker), f.ticker)} onToggleBuyback={toggleBuyback} />)}</div>
      </div>

      {/* RISK SCORECARD — forward-only: did your active management beat the strategy on return-per-drawdown? */}
      {scorecard && (
        <div style={{ marginTop: 18, border: '1px solid #2a2a2a', borderRadius: 10, padding: '12px 14px', background: '#0c0c0c' }}>
          <h3 style={{ color: '#e6e6e6', fontSize: 13, letterSpacing: '0.08em', margin: '0 0 8px' }}>🎯 RISK SCORECARD — your management vs the strategy</h3>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'baseline', fontFamily: 'monospace', fontSize: 12, color: '#ccc', marginBottom: 8 }}>
            <span title="Peak-to-trough of your real AUM since live tracking began">Your max drawdown <b style={{ color: '#22c55e' }}>{scorecard.portfolio?.actualMaxDDPct}%</b></span>
            <span style={{ color: '#555' }}>vs</span>
            <span title="The backtest's max drawdown — the number you're trying to beat by managing risk">Backtest <b style={{ color: '#facc15' }}>{scorecard.portfolio?.backtestDDPct}%</b></span>
            <span style={{ color: '#9a9a9a', fontSize: 11 }}>· tracking since {scorecard.portfolio?.since || '—'} ({scorecard.portfolio?.aumDays || 0} days)</span>
          </div>
          {scorecard.journeyCompare?.totals?.count > 0 && (() => {
            const T = scorecard.journeyCompare.totals;
            const $ = (n) => `${n >= 0 ? '+$' : '−$'}${Math.abs(Math.round(n)).toLocaleString()}`;
            const pc = (n) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}%`;
            const win = T.edge >= 0;
            const Row = ({ label, val, color }) => (
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#bbb' }}><span>{label}</span><b style={{ color }}>{val}</b></div>
            );
            return (
              <div style={{ margin: '4px 0 14px' }}>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline', padding: '8px 12px', borderRadius: 8, background: win ? '#0c1a0f' : '#1a0c0c', border: `1px solid ${win ? '#1f5130' : '#5e2020'}`, marginBottom: 10, fontFamily: 'monospace' }}>
                  <span style={{ fontSize: 12, color: '#cfcfcf', fontWeight: 700, letterSpacing: '0.03em' }}>🎯 ARE WE EFFECTIVE? — your management vs leaving TREE alone:</span>
                  <span style={{ fontSize: 20, fontWeight: 800, color: win ? '#22c55e' : '#ef4444' }}>{$(T.edge)}</span>
                  <span style={{ fontSize: 12, color: win ? '#86efac' : '#fca5a5', fontWeight: 700 }}>{win ? '✅ ADDING VALUE' : '✗ COSTING'} {pc(T.edgePct)}</span>
                  <span style={{ fontSize: 11, color: '#777', marginLeft: 'auto' }}>drawdown {scorecard.portfolio?.actualMaxDDPct}% vs {scorecard.portfolio?.backtestDDPct}% backtested</span>
                </div>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ flex: '1 1 300px', border: '1px dashed #3a3a3a', borderRadius: 10, padding: '12px 14px', background: '#0b0b0b' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                      <span style={{ color: '#e6e6e6', fontWeight: 800, fontSize: 15 }}>🌳 TREE Plan</span>
                      <span style={{ fontSize: 10, fontWeight: 800, color: '#9aa6a0', border: '1px dashed #555', borderRadius: 4, padding: '2px 7px', letterSpacing: '0.05em' }}>THE PLAN · MODELED</span>
                    </div>
                    <div style={{ color: '#b3b3b3', fontSize: 11, marginBottom: 8 }}>Held every signal to its stop — never touched</div>
                    <div style={{ fontFamily: 'monospace', fontSize: 28, fontWeight: 800, color: T.planNet >= 0 ? '#22c55e' : '#ef4444', lineHeight: 1.1 }}>{$(T.planNet)}</div>
                    <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#c4c4c4', marginBottom: 10 }}>{pc(T.planPct)} on {T.count} TREE trades</div>
                    <div style={{ borderTop: '1px solid #1c1c1c', paddingTop: 8, display: 'grid', gap: 4, fontFamily: 'monospace', fontSize: 12 }}>
                      <Row label="Would stop out (loss)" val={T.stopped} color="#e88" />
                      <Row label="Would trail to profit" val={T.trailed} color="#7fcf9f" />
                      <Row label="Would still be holding" val={T.openPlan} color="#ccc" />
                    </div>
                    <div style={{ color: '#a8a8a8', fontSize: 10, marginTop: 10, fontStyle: 'italic' }}>Did my whole approach beat leaving TREE alone? This is TREE's full untouched outcome — held to its stop.</div>
                  </div>
                  <div style={{ flex: '1 1 300px', border: `1px solid ${win ? '#1f7a3f' : '#7a3030'}`, borderRadius: 10, padding: '12px 14px', background: '#0b0b0b' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                      <span style={{ color: '#e6e6e6', fontWeight: 800, fontSize: 15 }}>🐾 PNTHR Management</span>
                      <span style={{ fontSize: 10, fontWeight: 800, color: '#22c55e', border: '1px solid #1f7a3f', borderRadius: 4, padding: '2px 7px', letterSpacing: '0.05em' }}>LIVE · YOUR ACTUAL</span>
                    </div>
                    <div style={{ color: '#b3b3b3', fontSize: 11, marginBottom: 8 }}>Your cutting, re-entering &amp; stepping aside</div>
                    <div style={{ fontFamily: 'monospace', fontSize: 28, fontWeight: 800, color: T.actualNet >= 0 ? '#22c55e' : '#ef4444', lineHeight: 1.1 }}>{$(T.actualNet)}</div>
                    <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#c4c4c4', marginBottom: 10 }}>{pc(T.actualPct)} on the same {T.count} trades</div>
                    <div style={{ borderTop: '1px solid #1c1c1c', paddingTop: 8, display: 'grid', gap: 4, fontFamily: 'monospace', fontSize: 12 }}>
                      <Row label="You beat the plan on" val={T.helped} color="#7fcf9f" />
                      <Row label="You trailed it on" val={T.hurt} color="#e88" />
                      <Row label="Edge vs the plan" val={$(T.edge)} color={win ? '#22c55e' : '#ef4444'} />
                    </div>
                    <div style={{ color: '#a8a8a8', fontSize: 10, marginTop: 10, fontStyle: 'italic' }}>By cutting losses early, did it help? Edge = your result − the plan.</div>
                  </div>
                </div>
                {T.exitsClassified > 0 && (
                  <div style={{ marginTop: 10, padding: '6px 10px', borderRadius: 6, background: '#0c1a0f', border: '1px solid #1f5130', fontFamily: 'monospace', fontSize: 11, color: '#86efac' }}>
                    🛡 <b>{T.exitsAboveStop} of {T.exitsClassified}</b> exits were <b>above TREE&apos;s stop</b> — your management, not TREE stop-outs. Only <b>{Math.max(0, T.exitsClassified - T.exitsAboveStop)}</b> actually hit TREE&apos;s stop.
                    <span style={{ color: '#9fc7ad' }}> (The 🌳 card&apos;s &quot;would stop out&quot; counts are TREE&apos;s <i>hypothetical</i> outcome if untouched — not what happened.) You exited a cumulative <b>${Math.round(T.aboveStopDollars).toLocaleString()}</b> above where TREE&apos;s stops sat — gross, shows how much more conservatively you manage; the net value is the edge above.</span>
                  </div>
                )}
                {(T.carried || T.pending) ? <div style={{ color: '#9a9a9a', fontSize: 10, marginTop: 8 }}>Plan (A) is MODELED — a daily-bar simulation; your side (B) is real money. {T.carried ? `${T.carried} carried positions (adopted before go-live) excluded — no TREE entry to compare. ` : ''}{T.pending ? `${T.pending} just entered (no journey yet).` : ''}</div> : null}
              </div>
            );
          })()}
          {(() => {
            const money = (n) => `${n >= 0 ? '+$' : '−$'}${Math.abs(n).toLocaleString()}`;
            // ONE timeline of every SELL decision: round trips (sold → re-bought) + walk-aways
            // (sold → still out, marked to the LIVE price). Same question for both: did
            // selling save capital? Grouped by the day you sold, with a final SAVED / COST verdict.
            const events = [];
            for (const rt of (scorecard.roundTrips || [])) events.push({
              date: rt.exitDate, ticker: rt.ticker,
              detail: `sold $${rt.exitPx} → re-bought $${rt.reentryPx}${rt.reentryOpen ? ' (open)' : ''}`,
              shares: rt.shares, result: rt.savings,
            });
            for (const w of (scorecard.preventedExits || [])) events.push({
              date: w.exitDate, ticker: w.ticker,
              detail: `sold $${w.exitPx} → still out, now $${w.currentPx}`,
              shares: w.shares, result: w.preventedDollar,
            });
            if (events.length === 0) return (
              <div style={{ color: '#777', fontSize: 12, marginBottom: 10 }}>No sell decisions to score yet — they appear here as you exit positions.</div>
            );
            const byDay = {};
            for (const e of events) (byDay[e.date] ||= []).push(e);
            const days = Object.keys(byDay).sort((a, b) => String(b).localeCompare(String(a)));
            const grandNet = events.reduce((s, e) => s + e.result, 0);
            const savedN = events.filter(e => e.result > 0).length;
            const costN  = events.filter(e => e.result < 0).length;
            return (
              <div style={{ marginBottom: 12, border: '1px solid #1f2a1f', borderRadius: 8, padding: '8px 10px', background: '#0a0f0a' }}>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline', fontFamily: 'monospace', fontSize: 12 }}>
                  <span style={{ color: '#86efac', fontWeight: 800, letterSpacing: '0.05em' }}>💰 CAPITAL SCORECARD — did selling save us money?</span>
                  <span title="Every sell decision, grouped by day and netted per ticker. Round trip = (exit − re-entry) × shares. Still out = (exit − LIVE price) × shares. Positive = selling saved capital; negative = it cost you. Click a ticker to see its individual trades.">
                    net <b style={{ color: grandNet >= 0 ? '#22c55e' : '#ef4444' }}>{money(grandNet)}</b>
                  </span>
                  <span style={{ color: '#aaa', fontSize: 11 }}>{events.length} sell{events.length === 1 ? '' : 's'} · {savedN} saved / {costN} cost · {days.length} day{days.length === 1 ? '' : 's'}</span>
                </div>
                <div style={{ color: '#9ca3af', fontSize: 10, marginTop: 2 }}>Was my sell timing good? — your exit / re-entry prices vs where the stock is right now. (The 🌳 cards above answer the bigger question: did your whole approach beat leaving TREE alone?)</div>
                <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
                  {days.map((day) => {
                    // roll the day's sells up to ONE netted row per ticker (click a ticker for its individual trades)
                    const byTicker = {};
                    for (const e of byDay[day]) (byTicker[e.ticker] ||= []).push(e);
                    const tickerRows = Object.entries(byTicker)
                      .map(([ticker, trades]) => ({ ticker, trades, net: trades.reduce((s, e) => s + e.result, 0) }))
                      .sort((a, b) => a.net - b.net);   // biggest cost first within the day
                    const dayNet = tickerRows.reduce((s, r) => s + r.net, 0);
                    const dayOpen = openDays.has(day);
                    return (
                      <div key={day} style={{ border: '1px solid #1c1c1c', borderRadius: 6, background: '#0e0e0e' }}>
                        <div onClick={() => toggleDay(day)} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', cursor: 'pointer', padding: '6px 10px', fontFamily: 'monospace', fontSize: 12, userSelect: 'none' }}>
                          <span style={{ color: '#888', width: 10 }}>{dayOpen ? '▾' : '▸'}</span>
                          <span style={{ fontWeight: 800, color: '#ddd' }}>{day}</span>
                          <span style={{ color: '#9a9a9a', fontSize: 11 }}>{tickerRows.length} ticker{tickerRows.length === 1 ? '' : 's'}</span>
                          <span style={{ marginLeft: 'auto', fontWeight: 800, color: dayNet >= 0 ? '#22c55e' : '#ef4444' }}>{money(dayNet)}</span>
                        </div>
                        {dayOpen && (
                          <div style={{ display: 'grid', gap: 4, padding: '0 10px 8px 24px' }}>
                            {tickerRows.map((tr) => {
                              const vColor = tr.net > 0 ? '#22c55e' : tr.net < 0 ? '#ef4444' : '#888';
                              const vText  = tr.net > 0 ? 'SAVED' : tr.net < 0 ? 'COST' : 'FLAT';
                              const key = `${day}|${tr.ticker}`;
                              const tOpen = openTickers.has(key);
                              const multi = tr.trades.length > 1;
                              return (
                                <div key={tr.ticker}>
                                  <div onClick={() => toggleTicker(key)} title={multi ? 'Click to see the individual trades' : 'Click to see this trade'} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontFamily: 'monospace', fontSize: 11, color: '#bbb', cursor: 'pointer', userSelect: 'none', padding: '1px 0' }}>
                                    <span style={{ color: '#666', width: 8, fontSize: 10 }}>{tOpen ? '▾' : '▸'}</span>
                                    <span style={{ fontWeight: 800, color: '#fff', minWidth: 52 }}>{tr.ticker}</span>
                                    <span style={{ color: '#777' }}>{tr.trades.length} trade{multi ? 's' : ''}</span>
                                    <span style={{ marginLeft: 'auto', color: vColor, fontWeight: 700 }}>{money(tr.net)}</span>
                                    <span style={{ color: vColor, background: vColor + '22', border: `1px solid ${vColor}66`, fontSize: 10, fontWeight: 800, padding: '1px 7px', borderRadius: 4, minWidth: 44, textAlign: 'center' }}>{vText}</span>
                                  </div>
                                  {tOpen && (
                                    <div style={{ display: 'grid', gap: 3, padding: '2px 0 5px 26px' }}>
                                      {tr.trades.slice().sort((a, b) => a.result - b.result).map((e, i) => {
                                        const evC = e.result > 0 ? '#22c55e' : e.result < 0 ? '#ef4444' : '#888';
                                        return (
                                          <div key={i} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', fontFamily: 'monospace', fontSize: 11, color: '#999' }}>
                                            <span>{e.detail}</span>
                                            <span style={{ color: '#666' }}>{e.shares}sh</span>
                                            <span style={{ marginLeft: 'auto', color: evC, fontWeight: 700 }}>{money(e.result)}</span>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div style={{ color: '#9a9a9a', fontSize: 10, marginTop: 8 }}>Each ticker is netted per day — a name traded several times shows one net row; click it for the individual trades. Combines closed round-trips (realized) with names you're still out of (marked to the LIVE price — unrealized, so it moves with the market).</div>
              </div>
            );
          })()}
          {scorecard.journeyCompare?.rows?.length > 0 && (() => {
            const jc = scorecard.journeyCompare; const T = jc.totals || {};
            const money = (n) => `${n >= 0 ? '+$' : '−$'}${Math.abs(Math.round(n)).toLocaleString()}`;
            const reasonLabel = (r) => r === 'STOP_LOSS' ? 'stopped out' : r === 'TRAIL_PROFIT' ? 'trailed out' : 'still open';
            return (
              <div style={{ marginBottom: 12, border: '1px solid #20301f', borderRadius: 8, padding: '8px 10px', background: '#0a0f0a' }}>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline', fontFamily: 'monospace', fontSize: 12 }}>
                  <span style={{ color: '#86efac', fontWeight: 800, letterSpacing: '0.05em' }}>🌳 TREE PLAN vs YOUR MANAGEMENT</span>
                  <span title="A (the plan) = bought at your TREE entry and held with TREE's 2-week-low trailing stop until stopped out or trailed to a profit — MODELED on daily bars. B = your real fills. edge = B − A: positive means your cutting/timing beat leaving TREE alone. An overnight gap hits A and B equally, so it cancels — this isolates YOUR decisions.">
                    your edge <b style={{ color: (T.edge || 0) >= 0 ? '#22c55e' : '#ef4444' }}>{money(T.edge || 0)}</b>
                  </span>
                  <span style={{ color: '#aaa', fontSize: 11 }}>plan {money(T.planNet || 0)} · you {money(T.actualNet || 0)} · {T.helped || 0} helped / {T.hurt || 0} hurt · {jc.rows.length} stocks</span>
                </div>
                <div style={{ display: 'grid', gap: 4, marginTop: 8 }}>
                  {jc.rows.map((r, i) => {
                    const c = r.edge > 0 ? '#22c55e' : r.edge < 0 ? '#ef4444' : '#888';
                    return (
                      <div key={i} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', fontFamily: 'monospace', fontSize: 11, color: '#bbb', padding: '3px 0', borderBottom: '1px solid #141414' }}>
                        <span style={{ fontWeight: 800, color: '#fff', minWidth: 52 }}>{r.ticker}</span>
                        <span style={{ color: '#888' }}>TREE bought ${r.entryPrice} {String(r.entryDate).slice(5)}</span>
                        <span title="What leaving TREE alone would have done (modeled)">plan {reasonLabel(r.plan?.reason)} ${r.plan?.exitPrice} <b style={{ color: r.planNet >= 0 ? '#7fcf9f' : '#e88' }}>{money(r.planNet)}</b></span>
                        <span title="Your actual result from your ins/outs">you <b style={{ color: r.actualNet >= 0 ? '#7fcf9f' : '#e88' }}>{money(r.actualNet)}</b></span>
                        <span style={{ marginLeft: 'auto', color: c, fontWeight: 700 }}>{money(r.edge)}</span>
                        <span style={{ color: c, background: c + '22', border: `1px solid ${c}66`, fontSize: 10, fontWeight: 800, padding: '1px 7px', borderRadius: 4, minWidth: 54, textAlign: 'center' }}>{r.verdict}</span>
                      </div>
                    );
                  })}
                </div>
                <div style={{ color: '#9a9a9a', fontSize: 10, marginTop: 8 }}>
                  Plan (A) is MODELED — TREE's 2-week-low trailing stop simulated forward from your entry on daily bars, not booked fills. Your side (B) is real money. edge = B − A.
                  {T.carried ? ` · ${T.carried} carried positions excluded (adopted before go-live — no TREE entry to compare).` : ''}
                  {T.pending ? ` · ${T.pending} just entered (no journey yet).` : ''}
                </div>
              </div>
            );
          })()}
          <div style={{ borderTop: '1px solid #1c1c1c', margin: '2px 0 8px' }} />
          <div title="A different question from capital saved: for each closed trade, did your active management beat just holding the strategy on return-per-drawdown? WIN = matched/beat the return for less (or equal) risk." style={{ color: '#9aa6a0', fontSize: 11, letterSpacing: '0.05em', fontWeight: 700, marginBottom: 6 }}>📊 VS THE STRATEGY — your return-per-drawdown vs just holding</div>
          {(scorecard.counts.WIN + scorecard.counts.MIXED + scorecard.counts.LOSS) > 0 && (
            <div style={{ display: 'flex', gap: 12, fontSize: 12, fontWeight: 700, marginBottom: 8 }}>
              <span style={{ color: '#22c55e' }}>WIN {scorecard.counts.WIN}</span>
              <span style={{ color: '#facc15' }}>MIXED {scorecard.counts.MIXED}</span>
              <span style={{ color: '#ef4444' }}>LOSS {scorecard.counts.LOSS}</span>
            </div>
          )}
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
            <div style={{ marginTop: 8, color: '#aaa', fontSize: 11 }}>
              Strategy benchmark (engine trades — the bar to beat): {scorecard.strategyOnly.slice(0, 6).map(s => `${s.ticker} ${s.returnPct >= 0 ? '+' : ''}${s.returnPct}%/${s.ddPct}%DD`).join(' · ')}
            </div>
          )}
          <div style={{ color: '#9a9a9a', fontSize: 10, marginTop: 8 }}>{scorecard.note}</div>
        </div>
      )}

      <div style={{ color: '#9a9a9a', fontSize: 10, marginTop: 18, borderTop: '1px solid #222', paddingTop: 8 }}>
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
