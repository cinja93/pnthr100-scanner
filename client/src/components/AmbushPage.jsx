// AmbushPage.jsx — PNTHR Ambush V7.4 Dashboard
// Full phase visibility: STALKING → ATTACK → ACTIVE → PROTECT
// Every metric the engine uses is surfaced so you can verify the machine.

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../AuthContext';
import { fetchAmbushSummary, updateAmbushConfig, triggerAmbushTick, deleteAmbushPosition, fetchAmbushProjection } from '../services/api';
import PageHeader from './PageHeader';
import styles from './AmbushPage.module.css';

// ── Constants (mirror server/ambush/ambushEngine.js) ───────────────────────
const LOT_OFFSETS  = [0, 0.03, 0.06, 0.10, 0.14];
const BE_THRESHOLD = 75;
const GRAD_TIER_1  = 125_000;
const GRAD_TIER_2  = 166_000;

const STATE_COLORS = {
  STALKING: '#a78bfa', ATTACK: '#f59e0b', ACTIVE: '#22c55e', PROTECT: '#3b82f6',
};

const ACTION_CONFIG = {
  NEW_ENTRY:          { icon: '●', color: '#22c55e', label: 'NEW ENTRY' },
  RE_ENTRY:           { icon: '●', color: '#22c55e', label: 'RE-ENTRY' },
  BREAK_EVEN:         { icon: '●', color: '#3b82f6', label: 'BREAK EVEN' },
  TRAILING_ACTIVATED: { icon: '●', color: '#3b82f6', label: 'TRAILING ON' },
  LOT_FILL:           { icon: '●', color: '#f59e0b', label: 'LOT FILLED' },
  TRAILING_RATCHET:   { icon: '↑', color: '#3b82f6', label: 'RATCHET' },
  '1H_EXIT':          { icon: '●', color: '#ef4444', label: '1H EXIT' },
  LOT_EXIT:           { icon: '●', color: '#ef4444', label: 'LOT STOP' },
  TRAILING_EXIT:      { icon: '●', color: '#ef4444', label: 'TRAIL EXIT' },
  BREAKOUT_DETECTED:  { icon: '●', color: '#a78bfa', label: 'BREAKOUT' },
  SIGNAL_EXPIRED:     { icon: '○', color: '#666',    label: 'EXPIRED' },
  SKIPPED_CAP:        { icon: '⚠', color: '#f59e0b', label: 'CAP SKIP' },
  SKIPPED_CASH:       { icon: '⚠', color: '#f59e0b', label: 'CASH SKIP' },
};

// ── Helpers ────────────────────────────────────────────────────────────────
function fmtUsd(n) {
  if (n == null || isNaN(n)) return '--';
  return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPnl(n) {
  if (n == null || isNaN(n)) return <span style={{ color: '#666' }}>--</span>;
  const color = n >= 0 ? '#22c55e' : '#ef4444';
  const prefix = n >= 0 ? '+' : '';
  return <span style={{ color, fontWeight: 600 }}>{prefix}{fmtUsd(n)}</span>;
}

function getLotStatus(lotIndex, nextLot) {
  if (lotIndex === 0) return 'FILLED';
  if (lotIndex < nextLot) return 'FILLED';
  if (lotIndex === nextLot && nextLot <= 4) return 'WAITING';
  return 'LOCKED';
}

function getLotTrigger(originalEntry, lotIndex, direction) {
  if (!originalEntry || lotIndex === 0) return originalEntry;
  const offset = LOT_OFFSETS[lotIndex];
  return direction === 'LONG'
    ? +(originalEntry * (1 + offset)).toFixed(2)
    : +(originalEntry * (1 - offset)).toFixed(2);
}

function computeRisk(pos) {
  if (!pos.avgCost || !pos.stop || !pos.totalShares) return null;
  const diff = pos.direction === 'LONG' ? pos.avgCost - pos.stop : pos.stop - pos.avgCost;
  return +(diff * pos.totalShares).toFixed(2);
}

function computeRps(pos) {
  if (!pos.avgCost || !pos.stop) return null;
  return pos.direction === 'LONG'
    ? +(pos.avgCost - pos.stop).toFixed(2)
    : +(pos.stop - pos.avgCost).toFixed(2);
}

function getSizingTier(nav) {
  if (nav >= GRAD_TIER_2) return '100%';
  if (nav >= GRAD_TIER_1) return '75%';
  return '50%';
}

function lotsLabel(pos) {
  if (!pos.lotPlan) return '--';
  // nextLot=1 means L1 filled (L2 next), show as "L1/5"
  // nextLot=0 should never happen on an ACTIVE position, but guard it
  const filled = Math.max(0, Math.min(pos.nextLot || 0, 5));
  if (filled === 0) return 'Entry';
  return `L${filled}/5`;
}

function totalPlannedShares(pos) {
  return pos.lotPlan ? pos.lotPlan.reduce((s, v) => s + v, 0) : 0;
}

// ── Info Popup Component (fixed-positioned so it never clips inside a section) ─
function InfoPopup({ text, wide }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const iconRef = useRef(null);
  const W = wide ? 340 : 280;
  const toggle = (e) => {
    e.stopPropagation();
    if (!open && iconRef.current) {
      const r = iconRef.current.getBoundingClientRect();
      let left = r.left - 8;
      if (left + W > window.innerWidth - 8) left = window.innerWidth - W - 8;
      if (left < 8) left = 8;
      const openUp = (window.innerHeight - r.bottom) < 240; // flip up near the bottom
      setPos(openUp
        ? { left, bottom: window.innerHeight - r.top + 6 }
        : { left, top: r.bottom + 6 });
    }
    setOpen(o => !o);
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      <span ref={iconRef} onClick={toggle} className={styles.infoCircle} title="Click for info">i</span>
      {open && pos && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 999 }} />
          <div className={styles.infoPopup} style={{
            position: 'fixed', left: pos.left, top: pos.top ?? 'auto', bottom: pos.bottom ?? 'auto', width: W, zIndex: 1000,
          }}>
            {text}
          </div>
        </>
      )}
    </span>
  );
}

// ── Lot Detail (expandable per position) ───────────────────────────────────
function LotDetail({ pos }) {
  if (!pos.lotPlan || !pos.originalEntry) return null;
  const lotLabels = ['L1', 'L2', 'L3', 'L4', 'L5'];
  const total = totalPlannedShares(pos);
  const statusColors = { FILLED: '#22c55e', WAITING: '#f59e0b', LOCKED: '#444' };

  return (
    <div className={styles.lotDetail}>
      <div className={styles.lotSection}>
        <div className={styles.lotSectionTitle}>LOT PLAN</div>
        {pos.lotPlan.map((shares, i) => {
          const status = getLotStatus(i, pos.nextLot);
          const trigger = getLotTrigger(pos.originalEntry, i, pos.direction);
          const pctLabel = i === 0 ? 'entry' : `+${(LOT_OFFSETS[i] * 100).toFixed(0)}%`;
          const fill = pos.lotFills?.find(f => f.lot === i);
          const fillTime = fill?.at ? new Date(fill.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : null;
          return (
            <div key={i} className={styles.lotRow}>
              <span style={{ color: statusColors[status], fontSize: 10, width: 12 }}>{status === 'LOCKED' ? '○' : '●'}</span>
              <span className={styles.lotLabel}>{lotLabels[i]}</span>
              <span className={styles.lotPrice}>{fmtUsd(trigger)}</span>
              <span className={styles.lotShares}>{shares} sh</span>
              <span className={styles.lotStatus} style={{ color: statusColors[status] }}>{status}</span>
              <span className={styles.lotPct}>{pctLabel}</span>
              <span style={{ marginLeft: 'auto', color: status === 'FILLED' ? '#22c55e' : '#555', fontSize: 11, fontFamily: 'monospace', fontWeight: 600 }}>
                {status === 'FILLED' ? `⏱ ${fillTime || '--'}` : ''}
              </span>
            </div>
          );
        })}
        <div className={styles.lotTotal}>
          Total at L5: <strong>{total} sh</strong> &mdash; {fmtUsd(total * pos.originalEntry)} notional
        </div>
      </div>

      {/* Lot-trail status for PROTECT (V7.4) */}
      {pos.state === 'PROTECT' && (
        <div className={styles.lotSection}>
          <div className={styles.lotSectionTitle}>LOT-TRAIL STATUS</div>
          <div className={styles.lotRow}>
            <span style={{ color: '#666', width: 12 }}/>
            <span className={styles.trailingLabel}>Break Even</span>
            <span className={styles.trailingValue}>{pos.beDate || '--'}</span>
          </div>
          <div className={styles.lotRow}>
            <span style={{ color: '#666', width: 12 }}/>
            <span className={styles.trailingLabel}>Stop basis</span>
            <span className={styles.trailingValue} style={{ color: '#22c55e' }}>
              {pos.nextLot >= 3 ? `Lot ${pos.nextLot - 1} price` : 'Breakeven'}
            </span>
          </div>
          <div className={styles.lotRow}>
            <span style={{ color: '#666', width: 12 }}/>
            <span className={styles.trailingLabel}>2-bar exit watch (prev low)</span>
            <span className={styles.trailingValue}>{fmtUsd(pos.prevBarLow)}</span>
          </div>
          {pos.stop && pos.avgCost && pos.totalShares > 0 && (
            <div className={styles.lotRow}>
              <span style={{ color: '#666', width: 12 }}/>
              <span className={styles.trailingLabel}>Profit at Stop</span>
              <span className={styles.trailingValue}>
                {fmtPnl(pos.direction === 'LONG'
                  ? (pos.stop - pos.avgCost) * pos.totalShares
                  : (pos.avgCost - pos.stop) * pos.totalShares)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Break Even progress for ACTIVE */}
      {pos.state === 'ACTIVE' && !pos.atBE && (
        <div className={styles.lotSection}>
          <div className={styles.lotSectionTitle}>BREAK EVEN PROGRESS</div>
          <div className={styles.beProgressRow}>
            <div className={styles.beBar}>
              <div className={styles.beFill} style={{ width: `${Math.min(100, ((pos.peak || 0) / BE_THRESHOLD) * 100)}%` }} />
            </div>
            <span className={styles.beText}>Peak: {fmtUsd(pos.peak)} / {fmtUsd(BE_THRESHOLD)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Action Feed Item ───────────────────────────────────────────────────────
function ActionItem({ action }) {
  const conf = ACTION_CONFIG[action.type] || { icon: '•', color: '#888', label: action.type };
  let desc = action.ticker || '';

  switch (action.type) {
    case 'NEW_ENTRY':
    case 'RE_ENTRY':
      desc = `${action.ticker} ${action.direction} -- Entry: ${fmtUsd(action.price)} / ${action.shares} sh / Stop: ${fmtUsd(action.stop)}`;
      if (action.cycle) desc += ` / Cycle #${action.cycle}`;
      break;
    case 'BREAK_EVEN':
      desc = `${action.ticker} -- Stop moved to ${fmtUsd(action.stop)} (avg cost + fees)`;
      break;
    case 'LOT_FILL':
      desc = `${action.ticker} L${(action.lot || 0) + 1} -- ${action.shares} sh @ ${fmtUsd(action.price)}`;
      break;
    case 'TRAILING_RATCHET':
      desc = `${action.ticker} -- Stop: ${fmtUsd(action.from)} → ${fmtUsd(action.to)}`;
      break;
    case '1H_EXIT':
      desc = `${action.ticker} -- 1H Break / P&L: ${action.pnl >= 0 ? '+' : ''}${fmtUsd(action.pnl)}`;
      break;
    case 'LOT_EXIT':
      desc = `${action.ticker} -- Lot/Breakeven Stop / P&L: ${action.pnl >= 0 ? '+' : ''}${fmtUsd(action.pnl)}`;
      break;
    case 'TRAILING_EXIT':
      desc = `${action.ticker} -- Trailing Stop / P&L: ${action.pnl >= 0 ? '+' : ''}${fmtUsd(action.pnl)}`;
      break;
    case 'BREAKOUT_DETECTED':
      desc = `${action.ticker} ${action.direction} -- Entry queued for next bar`;
      break;
    case 'SIGNAL_EXPIRED':
      desc = `${action.ticker} -- Weekly signal expired, removed`;
      break;
    case 'TRAILING_ACTIVATED':
      desc = `${action.ticker} -- Trailing stop now active, ratcheting with 1H low`;
      break;
    case 'SKIPPED_CAP':
      desc = `${action.ticker} -- Position cap reached, entry skipped`;
      break;
    default: break;
  }

  return (
    <div className={styles.actionItem} style={{ borderLeftColor: conf.color }}>
      <span style={{ color: conf.color, fontSize: 11, width: 14, flexShrink: 0 }}>{conf.icon}</span>
      <span className={styles.actionLabel} style={{ color: conf.color }}>{conf.label}</span>
      <span className={styles.actionDesc}>{desc}</span>
    </div>
  );
}

// ── State Badge ────────────────────────────────────────────────────────────
function StateBadge({ state }) {
  return (
    <span className={styles.stateBadge} style={{ background: STATE_COLORS[state] + '22', color: STATE_COLORS[state], borderColor: STATE_COLORS[state] + '44' }}>
      {state}
    </span>
  );
}

function DirBadge({ direction }) {
  const isLong = direction === 'LONG';
  return (
    <span style={{ color: isLong ? '#22c55e' : '#ef4444', fontWeight: 700, fontSize: 11, letterSpacing: '0.04em' }}>
      {isLong ? 'LONG' : 'SHORT'}
    </span>
  );
}

// ── Watching: today's BL+1 / SS+1 candidate pool ────────────────────────────
function WatchCol({ title, color, items }) {
  const readyCount = items.filter(i => i.ready).length;
  return (
    <div style={{ flex: 1, minWidth: 220 }}>
      <div style={{ color, fontSize: 11, fontWeight: 700, marginBottom: 6 }}>
        {title} <span style={{ color: '#555' }}>· {readyCount} ready / {items.length} total</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {items.length === 0 ? <span style={{ color: '#555', fontSize: 12 }}>none today</span> : items.map(it => {
          const reason = it.tracked ? 'already in a position' : !it.regimeOk ? 'waiting on regime' : !it.sectorOk ? 'sector AVOID' : 'ready';
          return (
            <span key={it.ticker} title={`${it.sector} — ${reason}`} style={{
              fontSize: 12, fontWeight: 700, padding: '3px 8px', borderRadius: 5, fontFamily: 'monospace',
              color: it.ready ? '#000' : '#888',
              background: it.ready ? color : '#161616',
              border: `1px solid ${it.ready ? color : '#2a2a2a'}`,
            }}>{it.ticker}{it.tracked ? ' •' : ''}</span>
          );
        })}
      </div>
    </div>
  );
}

// ── AUM tracker: Projected (backtest, pure compounding) vs Actual ───────────
function fmtAum(n) {
  if (n == null || isNaN(n)) return '--';
  const v = Number(n);
  if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (Math.abs(v) >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + v.toFixed(0);
}

function AumChart({ projected, actual }) {
  if (!projected?.length) return null;
  const W = 1000, H = 230, padL = 6, padR = 6, padT = 12, padB = 24;
  const proj = projected, act = actual || [];
  const maxV = Math.max(...proj.map(p => p.value), ...act.map(a => a.value));
  const minV = Math.min(proj[0].value, ...act.map(a => a.value));
  const anchor = new Date(proj[0].date + 'T12:00:00');
  const last = new Date(proj[proj.length - 1].date + 'T12:00:00');
  const span = (last - anchor) || 1;
  const xd = ds => padL + ((new Date(ds + 'T12:00:00') - anchor) / span) * (W - padL - padR);
  const y = v => padT + (1 - (v - minV) / ((maxV - minV) || 1)) * (H - padT - padB);
  // downsample projected to ~250 pts for a light polyline
  const step = Math.max(1, Math.floor(proj.length / 250));
  const projPts = proj.filter((_, i) => i % step === 0 || i === proj.length - 1)
    .map(p => `${xd(p.date).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const actPts = act.map(a => `${xd(a.date).toFixed(1)},${y(a.value).toFixed(1)}`).join(' ');
  const yearTicks = [];
  for (let yr = anchor.getFullYear(); yr <= last.getFullYear(); yr++) yearTicks.push(yr);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 230, display: 'block' }}>
      {/* y gridlines */}
      {[0, 0.5, 1].map((f, i) => {
        const v = minV + f * (maxV - minV);
        return (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="#222" strokeWidth="1" />
            <text x={padL + 2} y={y(v) - 3} fill="#555" fontSize="11">{fmtAum(v)}</text>
          </g>
        );
      })}
      {/* x year labels */}
      {yearTicks.map((yr, i) => {
        const xp = xd(`${yr}-01-02`);
        if (xp < padL || xp > W - padR) return null;
        return <text key={i} x={xp} y={H - 6} fill="#555" fontSize="11" textAnchor="middle">{yr}</text>;
      })}
      <polyline points={projPts} fill="none" stroke="#3b82f6" strokeWidth="2" />
      {actPts && <polyline points={actPts} fill="none" stroke="#22c55e" strokeWidth="2.5" />}
    </svg>
  );
}

function mondayOf(dateStr) {
  // ISO Monday of the week containing dateStr (YYYY-MM-DD) — stable week key.
  const d = new Date(dateStr + 'T12:00:00');
  const back = (d.getDay() + 6) % 7; // Mon=0 .. Sun=6
  d.setDate(d.getDate() - back);
  return d.toISOString().slice(0, 10);
}
function AumTableModal({ view, projection, onClose }) {
  const isProj = view === 'projected';
  const series = isProj ? (projection.projected || []) : (projection.actual || []);
  // Projected: one row per WEEK (first trading day of each week). Actual: every snapshot.
  let rows = series;
  if (isProj) {
    const seen = new Set(); rows = [];
    for (const p of series) { const wk = mondayOf(p.date); if (!seen.has(wk)) { seen.add(wk); rows.push(p); } }
  }
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#0d0d0d', border: '1px solid #2a2a2a', borderRadius: 10, width: 440, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid #222' }}>
          <div style={{ color: isProj ? '#3b82f6' : '#22c55e', fontWeight: 700, fontSize: 14 }}>
            {isProj ? 'Projected AUM — week by week' : 'Actual AUM — daily history'}
          </div>
          <span onClick={onClose} style={{ cursor: 'pointer', color: '#888', fontSize: 20, lineHeight: 1 }}>×</span>
        </div>
        <div style={{ overflowY: 'auto', padding: '0 16px 12px' }}>
          {rows.length === 0 ? (
            <div style={{ color: '#666', padding: '18px 0' }}>No data yet{isProj ? '.' : ' — fills in as the engine records daily NAV.'}</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ color: '#777', textAlign: 'left' }}>
                  <th style={{ padding: '8px 0', position: 'sticky', top: 0, background: '#0d0d0d' }}>{isProj ? 'Week of' : 'Date'}</th>
                  <th style={{ padding: '8px 0', textAlign: 'right', position: 'sticky', top: 0, background: '#0d0d0d' }}>{isProj ? 'Projected' : 'Actual'} AUM</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ borderTop: '1px solid #1a1a1a' }}>
                    <td style={{ padding: '6px 0', color: '#ccc' }}>{r.date}</td>
                    <td style={{ padding: '6px 0', textAlign: 'right', fontFamily: 'monospace', color: isProj ? '#3b82f6' : '#22c55e' }}>{fmtAum(r.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function AumTracker({ projection }) {
  const [showChart, setShowChart] = useState(false);
  const [tableView, setTableView] = useState(null);
  if (!projection?.current) return null;
  const { current, projected, actual, anchor } = projection;
  const onTrack = (current.onTrackPct ?? 0) >= 0;
  const box = (label, value, color, onClick) => (
    <div onClick={onClick} title="Click for the full table" style={{ cursor: 'pointer', background: '#161616', border: '1px solid #2a2a2a', borderRadius: 8, padding: '8px 14px', minWidth: 175 }}>
      <div style={{ color: '#888', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', display: 'flex', justifyContent: 'space-between', gap: 10 }}>
        <span>{label}</span><span style={{ color: '#555' }}>▸ table</span>
      </div>
      <div style={{ color, fontSize: 22, fontWeight: 700, fontFamily: 'monospace' }}>{fmtAum(value)}</div>
    </div>
  );
  return (
    <div style={{ position: 'relative', background: '#0d0d0d', border: '1px solid #222', borderRadius: 10, padding: 14, marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <div style={{ color: '#3b82f6', fontWeight: 700, fontSize: 13, letterSpacing: '0.04em' }}>
            PROJECTED vs ACTUAL AUM <span style={{ color: '#555', fontWeight: 400 }}>· backtest, pure compounding</span>
          </div>
          <div style={{ color: '#555', fontSize: 11, marginTop: 2 }}>
            Anchored {anchor?.startDate} at {fmtAum(anchor?.startAum)} · projects to {fmtAum(projection.meta?.backtestEndNav)} over ~3.5 yrs
          </div>
          <button onClick={() => setShowChart(s => !s)} style={{ marginTop: 8, background: '#161616', border: '1px solid #2a2a2a', color: '#aaa', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>
            {showChart ? '▲ Hide chart' : '▼ Show chart'}
          </button>
        </div>
        {/* the 2 boxes — upper right, click for table */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
          {box('Projected AUM', current.projectedAum, '#3b82f6', () => setTableView('projected'))}
          {box('Actual AUM', current.actualAum, '#22c55e', () => setTableView('actual'))}
          <span style={{
            fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 6,
            color: onTrack ? '#22c55e' : '#ef4444',
            background: (onTrack ? '#22c55e' : '#ef4444') + '1a',
            border: `1px solid ${(onTrack ? '#22c55e' : '#ef4444')}44`,
          }}>
            {onTrack ? 'ON TRACK' : 'BEHIND'} {current.onTrackPct >= 0 ? '+' : ''}{current.onTrackPct}% vs backtest
          </span>
        </div>
      </div>

      {/* Hedge-fund metric cards from the backtest (GRAD BASELINE) */}
      {projection.metrics && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          {[
            ['Net Total Return', (projection.metrics.netReturnPct >= 0 ? '+' : '') + Math.round(projection.metrics.netReturnPct).toLocaleString() + '%', '#22c55e', '$83K start'],
            ['Net CAGR', (projection.metrics.cagrPct >= 0 ? '+' : '') + projection.metrics.cagrPct + '%', '#22c55e'],
            ['Sharpe', projection.metrics.sharpe, '#e6e6e6'],
            ['Sortino', projection.metrics.sortino, '#22c55e'],
            ['Profit Factor', projection.metrics.profitFactor + 'x', '#22c55e'],
            ['Calmar', projection.metrics.calmar, '#e6e6e6'],
            ['Recovery Factor', projection.metrics.recoveryFactor + 'x', '#e6e6e6'],
            ['Positive Months', projection.metrics.positiveMonthsPct + '%', '#22c55e'],
            ['Win Rate', projection.metrics.winRatePct + '%', '#e6e6e6', projection.metrics.payoff + 'x payoff'],
            ['Total Closed', Math.round(projection.metrics.totalClosed).toLocaleString(), '#e6e6e6'],
            ['Ending Equity', fmtAum(projection.metrics.endingEquity), '#22c55e'],
            ['Alpha vs S&P', (projection.metrics.alphaDollar >= 0 ? '+' : '') + fmtAum(projection.metrics.alphaDollar), '#22c55e'],
          ].map(([label, value, color, sub], i) => (
            <div key={i} style={{ background: '#121212', border: '1px solid #222', borderRadius: 8, padding: '8px 12px', minWidth: 96, flex: '1 1 auto' }}>
              <div style={{ color: '#888', fontSize: 9, letterSpacing: '0.05em', textTransform: 'uppercase', lineHeight: 1.25 }}>{label}</div>
              <div style={{ color, fontSize: 17, fontWeight: 700 }}>{value}</div>
              {sub && <div style={{ color: '#555', fontSize: 9 }}>{sub}</div>}
            </div>
          ))}
        </div>
      )}

      {showChart && (
        <>
          <div style={{ marginTop: 10 }}>
            <AumChart projected={projected} actual={actual} />
          </div>
          <div style={{ display: 'flex', gap: 16, fontSize: 11, color: '#888', marginTop: 2 }}>
            <span><span style={{ color: '#3b82f6' }}>━</span> Projected (backtest)</span>
            <span><span style={{ color: '#22c55e' }}>━</span> Actual (your account)</span>
          </div>
        </>
      )}
      {tableView && <AumTableModal view={tableView} projection={projection} onClose={() => setTableView(null)} />}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  MAIN PAGE
// ════════════════════════════════════════════════════════════════════════════

export default function AmbushPage() {
  const { isAdmin } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tickRunning, setTickRunning] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [showOutbox, setShowOutbox] = useState(false);
  const [showActions, setShowActions] = useState(true);
  const [showWatching, setShowWatching] = useState(true);
  const [projection, setProjection] = useState(null);
  const refreshRef = useRef(null);

  const loadData = useCallback(async () => {
    try {
      const summary = await fetchAmbushSummary();
      setData(summary);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
    fetchAmbushProjection().then(setProjection).catch(() => {});
  }, []);

  useEffect(() => {
    loadData();
    refreshRef.current = setInterval(loadData, 60000);
    return () => clearInterval(refreshRef.current);
  }, [loadData]);

  const handleToggle = async () => {
    if (!data?.config) return;
    try {
      await updateAmbushConfig({ enabled: !data.config.enabled });
      await loadData();
    } catch (err) { alert('Toggle failed: ' + err.message); }
  };

  const handleManualTick = async () => {
    setTickRunning(true);
    try {
      await triggerAmbushTick();
      await loadData();
    } catch (err) { alert('Tick failed: ' + err.message); }
    finally { setTickRunning(false); }
  };

  const handleRemove = async (ticker) => {
    if (!confirm(`Remove ${ticker} from Ambush? This cannot be undone.`)) return;
    try {
      await deleteAmbushPosition(ticker);
      await loadData();
    } catch (err) { alert('Remove failed: ' + err.message); }
  };

  const toggleExpand = (ticker) => setExpanded(prev => ({ ...prev, [ticker]: !prev[ticker] }));

  // ── Loading / Error ──
  if (loading) return <div className={styles.page}><PageHeader title="PNTHR AMBUSH V7.4" /><div className={styles.loading}>Loading Ambush data...</div></div>;
  if (error) return <div className={styles.page}><PageHeader title="PNTHR AMBUSH V7.4" /><div className={styles.error}>Error: {error}</div></div>;

  // ── Data prep ──
  const positions = data?.positions || [];
  const config = data?.config || {};
  const stats = data?.stats || {};
  const recentTrades = data?.recentTrades || [];
  const recentOrders = data?.recentOrders || [];
  const lastResult = config.lastCronResult || {};
  const actions = lastResult.actions || [];
  const watching = lastResult.watching || { longs: [], shorts: [] };

  const byState = {
    STALKING: positions.filter(p => p.state === 'STALKING'),
    ATTACK:   positions.filter(p => p.state === 'ATTACK'),
    ACTIVE:   positions.filter(p => p.state === 'ACTIVE'),
    PROTECT:  positions.filter(p => p.state === 'PROTECT'),
  };
  const livePositions = [...byState.PROTECT, ...byState.ACTIVE]; // PROTECT first (more important)

  // Live total: current unrealized P&L across all open positions (refreshes each 60s poll).
  const totalOpenPnl = livePositions.reduce((s, p) => {
    if (!p.avgCost || !p.livePrice || !p.totalShares) return s;
    const u = p.direction === 'LONG'
      ? (p.livePrice - p.avgCost) * p.totalShares
      : (p.avgCost - p.livePrice) * p.totalShares;
    return s + u;
  }, 0);

  const nav = lastResult.nav || config.nav || 83000;
  const navSource = lastResult.navSource || 'config';
  const sizingTier = lastResult.sizingTier || getSizingTier(nav);
  const sizingMult = lastResult.sizingMultiplier || (nav >= GRAD_TIER_2 ? 1.0 : nav >= GRAD_TIER_1 ? 0.75 : 0.50);

  // ── Render ──
  return (
    <div className={styles.page}>
      <PageHeader title="PNTHR AMBUSH V7.4" />

      {/* ═══ STATUS BAR ═══ */}
      <div className={styles.statusBar}>
        <div className={styles.statusTop}>
          <button
            className={styles.toggleBtn}
            onClick={handleToggle}
            style={{ background: config.enabled ? '#22c55e' : '#333', color: config.enabled ? '#000' : '#888' }}
          >
            {config.enabled ? 'LIVE' : 'OFF'}
          </button>

          <div className={styles.statusGroup}>
            <span className={styles.statusLabel}>NAV</span>
            <span className={styles.navValue}>{fmtUsd(nav)}</span>
            <span className={styles.navSource}>({navSource})</span>
          </div>

          <div className={styles.statusGroup}>
            <span className={styles.statusLabel}>Sizing</span>
            <span className={styles.sizingBadge}>{sizingTier}</span>
            <InfoPopup text={`Graduated sizing: 50% position size below $125K NAV, 75% from $125K-$166K, 100% above $166K. Currently ${sizingTier} (${sizingMult}x multiplier). Reads live IBKR NAV each tick.`} />
          </div>

          <div className={styles.statusGroup}>
            <span className={styles.statusLabel}>Positions</span>
            <span>{livePositions.length} / {config.maxPositions || 999}</span>
          </div>

          {config.lastCronRun && (
            <span className={styles.lastTick}>
              Last tick: {new Date(config.lastCronRun).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              {lastResult.priceSource && <span style={{ color: '#444', marginLeft: 6 }}>({lastResult.priceSource})</span>}
              {lastResult.isFirstHour && <span style={{ color: '#f59e0b', marginLeft: 6, fontWeight: 700 }}>1H CAPTURE</span>}
            </span>
          )}
        </div>

        <div className={styles.statusBottom}>
          <span className={styles.stat}>Trades: <strong>{stats.totalTrades || 0}</strong></span>
          <span className={styles.stat}>Win Rate: <strong>{stats.winRate || 0}%</strong></span>
          <span className={styles.stat}>P&L: {fmtPnl(stats.totalPnl)}</span>
          {lastResult.tickersPriced > 0 && (
            <span className={styles.stat} style={{ color: '#555' }}>
              Live prices: {lastResult.tickersPriced} tickers
            </span>
          )}
          <button className={styles.tickBtn} onClick={handleManualTick} disabled={tickRunning}>
            {tickRunning ? 'Running...' : 'Manual Tick'}
          </button>
        </div>
      </div>

      {/* ═══ PROJECTED vs ACTUAL AUM ═══ */}
      <AumTracker projection={projection} />

      {/* ═══ WITHDRAWAL ALERT ($2M rule) ═══ */}
      {lastResult.withdrawalAlert?.due && (
        <div style={{
          margin: '10px 0', padding: '12px 16px', borderRadius: 8,
          background: '#f59e0b22', border: '1px solid #f59e0b66', color: '#f59e0b', fontWeight: 600,
        }}>
          ⚠ WITHDRAW ${Number(lastResult.withdrawalAlert.amount).toLocaleString()} NOW — account hit ${Number(lastResult.withdrawalAlert.nav).toLocaleString()}.
          The engine is already sizing off ${Number(lastResult.withdrawalAlert.tradingNav).toLocaleString()} (V7.4 rule). Wire the $1M out to stay on the model.
        </div>
      )}

      {/* ═══ FLOW INDICATOR ═══ */}
      <div className={styles.flowRow}>
        {['STALKING', 'ATTACK', 'ACTIVE', 'PROTECT'].map((state, i) => (
          <div key={state} className={styles.flowItem}>
            {i > 0 && <span className={styles.flowArrow}>{'→'}</span>}
            <span style={{ color: STATE_COLORS[state], fontWeight: 700, fontSize: 13 }}>{state}</span>
            <span className={styles.flowCount} style={{ background: STATE_COLORS[state], color: '#000' }}>
              {byState[state].length}
            </span>
          </div>
        ))}
      </div>

      {/* ═══ LAST TICK ACTIONS ═══ */}
      {actions.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHeader} onClick={() => setShowActions(!showActions)} style={{ cursor: 'pointer' }}>
            <span className={styles.sectionTitle}>
              LAST TICK ACTIONS
              <InfoPopup text="Events from the most recent 60-second tick. The engine ticks every 60 seconds during market hours (9:30 AM - 4:05 PM ET) using IBKR live prices." />
            </span>
            <span className={styles.badge}>{actions.length}</span>
            <span className={styles.expandIcon}>{showActions ? '▼' : '▶'}</span>
          </div>
          {showActions && (
            <div className={styles.actionsFeed}>
              {actions.map((a, i) => <ActionItem key={i} action={a} />)}
            </div>
          )}
        </div>
      )}

      {/* ═══ WATCHING — today's BL+1 / SS+1 candidates ═══ */}
      <div className={styles.section}>
        <div className={styles.sectionHeader} onClick={() => setShowWatching(!showWatching)} style={{ cursor: 'pointer' }}>
          <span className={styles.sectionTitle}>
            WATCHING — today's candidates
            <InfoPopup text="Every name with an active weekly BL+1 (long) or SS+1 (short) signal. V7.4 takes longs AND shorts in any market regime, so a bright chip just needs to pass the sector gate and is ready to enter the moment its breakout confirms after 10:30. A dimmed chip has the signal but its sector is on AVOID, or it's already in a position (•). The engine recomputes this every 60s." wide />
          </span>
          <div className={styles.sectionBadges}>
            <span style={{ color: '#22c55e' }}>BL+1 {watching.longs.length}</span>
            <span style={{ color: '#ef4444' }}>SS+1 {watching.shorts.length}</span>
          </div>
          <span className={styles.expandIcon}>{showWatching ? '▼' : '▶'}</span>
        </div>
        {showWatching && (
          (watching.longs.length === 0 && watching.shorts.length === 0) ? (
            <div className={styles.emptyState}>No active signals loaded yet — appears once the engine ticks.</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, padding: '6px 2px' }}>
              <WatchCol title="BL+1 LONGS" color="#22c55e" items={watching.longs} />
              <WatchCol title="SS+1 SHORTS" color="#ef4444" items={watching.shorts} />
            </div>
          )
        )}
      </div>

      {/* ═══ LIVE POSITIONS (ACTIVE + PROTECT) ═══ */}
      <div className={styles.section} style={{ borderLeftColor: STATE_COLORS.ACTIVE }}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>
            LIVE POSITIONS
            <InfoPopup text="All open Ambush positions. ACTIVE = pre-Break Even, lots loading. PROTECT = Break Even hit ($75 unrealized), trailing stop ratcheting. Click a row to see lot plan and trailing status." wide />
          </span>
          <div className={styles.sectionBadges}>
            <span style={{ color: STATE_COLORS.ACTIVE }}>ACTIVE {byState.ACTIVE.length}</span>
            <span style={{ color: STATE_COLORS.PROTECT }}>PROTECT {byState.PROTECT.length}</span>
          </div>
        </div>

        {livePositions.length === 0 ? (
          <div className={styles.emptyState}>No live positions</div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>State</th>
                  <th>Ticker</th>
                  <th>Dir</th>
                  <th style={{ textAlign: 'right' }}>Entry <InfoPopup text="L1 fill price with 5bps slippage applied." /></th>
                  <th style={{ textAlign: 'right' }}>Avg Cost</th>
                  <th style={{ textAlign: 'right' }}>Shares <InfoPopup text="Current filled shares / total planned at L5. Shares increase as lots fill." /></th>
                  <th style={{ textAlign: 'right' }}>Stop <InfoPopup text="Current stop price. Initial = 1H low - $0.005 for LONG. Moves to avg cost + fees at Break Even. Ratchets up with daily 1H low during trailing." /></th>
                  <th style={{ textAlign: 'right' }}>1H Exit <InfoPopup text="Today's first-hour low (LONG) or high (SHORT). If price breaks this level pre-trailing, position exits immediately." /></th>
                  <th style={{ textAlign: 'right' }}>Risk $ <InfoPopup text="Maximum loss if stopped out now: (avg cost - stop) x shares for LONG." /></th>
                  <th style={{ textAlign: 'right' }}>RPS <InfoPopup text="Risk Per Share = avg cost minus stop. Used for position sizing." /></th>
                  <th>Lots <InfoPopup text="5-lot pyramid: L1 at entry (35%), L2 +3% (25%), L3 +6% (20%), L4 +10% (12%), L5 +14% (8%)." /></th>
                  <th style={{ textAlign: 'right' }}>
                    Peak P&L <InfoPopup text="Per row: highest unrealized P&L each position reached (Break Even triggers at $75). The bold number here is the LIVE total — current unrealized P&L across all open positions, refreshed every 60s with the cron." wide />
                    <div style={{ fontSize: 13, fontWeight: 700, color: totalOpenPnl >= 0 ? '#22c55e' : '#ef4444', marginTop: 2 }}>
                      {totalOpenPnl >= 0 ? '+' : ''}{fmtUsd(totalOpenPnl)}
                    </div>
                    <div style={{ fontSize: 9, color: '#666', fontWeight: 400 }}>open total</div>
                  </th>
                  <th>Cycle</th>
                  <th>Date</th>
                  <th></th>
                </tr>
              </thead>
              {livePositions.map(pos => {
                  const total = totalPlannedShares(pos);
                  const risk = computeRisk(pos);
                  const rps = computeRps(pos);
                  const exitLevel = pos.direction === 'LONG' ? pos.todayFirstHourLow : pos.todayFirstHourHigh;
                  const isExpanded = expanded[pos.ticker];

                  return (
                    <tbody key={pos.ticker} className={styles.positionGroup}>
                      <tr
                        className={styles.positionRow}
                        onClick={() => toggleExpand(pos.ticker)}
                        style={{ cursor: 'pointer', borderLeftColor: STATE_COLORS[pos.state] }}
                      >
                        <td><StateBadge state={pos.state} /></td>
                        <td className={styles.tickerCell}>{pos.ticker}</td>
                        <td><DirBadge direction={pos.direction} /></td>
                        <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{fmtUsd(pos.entryPrice)}</td>
                        <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{fmtUsd(pos.avgCost)}</td>
                        <td style={{ textAlign: 'right' }}>
                          <span style={{ fontWeight: 600 }}>{pos.totalShares || 0}</span>
                          <span style={{ color: '#555' }}> / {total}</span>
                        </td>
                        <td style={{ textAlign: 'right', fontFamily: 'monospace', color: '#ef4444' }}>{fmtUsd(pos.stop)}</td>
                        <td style={{ textAlign: 'right', fontFamily: 'monospace', color: exitLevel ? '#f59e0b' : '#444' }}>{fmtUsd(exitLevel)}</td>
                        <td style={{ textAlign: 'right', fontFamily: 'monospace', color: risk > 200 ? '#ef4444' : '#ccc' }}>
                          {risk != null ? fmtUsd(risk) : '--'}
                        </td>
                        <td style={{ textAlign: 'right', fontFamily: 'monospace', color: '#888' }}>
                          {rps != null ? fmtUsd(rps) : '--'}
                        </td>
                        <td>
                          <span className={styles.lotsBadge}>{lotsLabel(pos)}</span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {pos.atBE
                            ? <span style={{ color: '#3b82f6', fontWeight: 600, fontSize: 11 }}>BE {'✓'}</span>
                            : fmtPnl(pos.peak)
                          }
                        </td>
                        <td style={{ color: '#888', fontSize: 11 }}>
                          {pos.cycleNum > 0 ? `#${pos.cycleNum + 1}` : '--'}
                        </td>
                        <td style={{ color: '#666', fontSize: 11 }}>{pos.entryDate || '--'}</td>
                        <td>
                          {isAdmin && (
                            <button
                              className={styles.removeBtn}
                              onClick={(e) => { e.stopPropagation(); handleRemove(pos.ticker); }}
                              title="Remove position"
                            >x</button>
                          )}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className={styles.detailRow}>
                          <td colSpan={15} style={{ padding: 0 }}>
                            <LotDetail pos={pos} />
                          </td>
                        </tr>
                      )}
                    </tbody>
                  );
                })}
            </table>
          </div>
        )}
      </div>

      {/* ═══ STALKING — Re-entry Watch ═══ */}
      <div className={styles.section} style={{ borderLeftColor: STATE_COLORS.STALKING }}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>
            STALKING
            <InfoPopup text="After being stopped out, watches for a confirmed breakout to re-enter. If the weekly BL/SS signal expires, position is removed entirely. Re-entry gets a tighter stop (running low - $0.01) for smaller risk per share." wide />
          </span>
          <span className={styles.badge} style={{ background: STATE_COLORS.STALKING }}>{byState.STALKING.length}</span>
        </div>

        {byState.STALKING.length === 0 ? (
          <div className={styles.emptyState}>No tickers stalking for re-entry</div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Dir</th>
                  <th>Cycle <InfoPopup text="How many times this ticker has been entered, stopped out, and is re-stalking. Cycle #2 = second attempt." /></th>
                  <th style={{ textAlign: 'right' }}>Running Low <InfoPopup text="Lowest low since last exit (LONG). Becomes the re-entry stop at running low - $0.01." /></th>
                  <th style={{ textAlign: 'right' }}>Running High <InfoPopup text="Highest high since last exit (SHORT). Becomes the re-entry stop at running high + $0.01." /></th>
                  <th style={{ textAlign: 'right' }}>Est. Re-entry Stop <InfoPopup text="What the stop will be on re-entry. Running low - $0.01 for LONG, running high + $0.01 for SHORT." /></th>
                  <th>Last Bar</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {byState.STALKING.map(pos => {
                  const estStop = pos.direction === 'LONG'
                    ? pos.runningLow ? +(pos.runningLow - 0.01).toFixed(2) : null
                    : pos.runningHigh ? +(pos.runningHigh + 0.01).toFixed(2) : null;
                  return (
                    <tr key={pos.ticker} style={{ borderLeftColor: STATE_COLORS.STALKING }}>
                      <td className={styles.tickerCell}>{pos.ticker}</td>
                      <td><DirBadge direction={pos.direction} /></td>
                      <td style={{ color: '#a78bfa' }}>#{(pos.cycleNum || 0) + 1}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{pos.direction === 'LONG' ? fmtUsd(pos.runningLow) : <span style={{ color: '#444' }}>--</span>}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{pos.direction === 'SHORT' ? fmtUsd(pos.runningHigh) : <span style={{ color: '#444' }}>--</span>}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace', color: '#ef4444' }}>{estStop ? fmtUsd(estStop) : '--'}</td>
                      <td style={{ color: '#555', fontSize: 11 }}>{pos.lastBarDate || '--'}</td>
                      <td>
                        {isAdmin && <button className={styles.removeBtn} onClick={() => handleRemove(pos.ticker)} title="Remove">x</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ═══ ATTACK — Entry Queued ═══ */}
      {byState.ATTACK.length > 0 && (
        <div className={styles.section} style={{ borderLeftColor: STATE_COLORS.ATTACK }}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionTitle}>
              ATTACK
              <InfoPopup text="Breakout confirmed, entry executes on the next 60-second tick with 5bps slippage. This state typically lasts only one tick." />
            </span>
            <span className={styles.badge} style={{ background: STATE_COLORS.ATTACK }}>{byState.ATTACK.length}</span>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Dir</th>
                  <th>Cycle</th>
                  <th style={{ textAlign: 'right' }}>Est. Stop <InfoPopup text="Running low - $0.01 for LONG re-entries. Used for sizing calculation." /></th>
                  <th>Status</th>
                  <th>Last Bar</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {byState.ATTACK.map(pos => {
                  const estStop = pos.direction === 'LONG'
                    ? pos.runningLow ? +(pos.runningLow - 0.01).toFixed(2) : null
                    : pos.runningHigh ? +(pos.runningHigh + 0.01).toFixed(2) : null;
                  return (
                    <tr key={pos.ticker} style={{ borderLeftColor: STATE_COLORS.ATTACK }}>
                      <td className={styles.tickerCell}>{pos.ticker}</td>
                      <td><DirBadge direction={pos.direction} /></td>
                      <td style={{ color: '#f59e0b' }}>#{(pos.cycleNum || 0) + 1}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace', color: '#ef4444' }}>{estStop ? fmtUsd(estStop) : '--'}</td>
                      <td><span style={{ color: '#f59e0b', fontWeight: 600, fontSize: 11 }}>ENTRY QUEUED</span></td>
                      <td style={{ color: '#555', fontSize: 11 }}>{pos.lastBarDate || '--'}</td>
                      <td>
                        {isAdmin && <button className={styles.removeBtn} onClick={() => handleRemove(pos.ticker)} title="Remove">x</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ═══ RECENT TRADES ═══ */}
      {recentTrades.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionTitle}>RECENT TRADES</span>
            <span className={styles.badge}>{recentTrades.length}</span>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Dir</th>
                  <th style={{ textAlign: 'right' }}>Entry</th>
                  <th style={{ textAlign: 'right' }}>Exit</th>
                  <th style={{ textAlign: 'right' }}>Shares</th>
                  <th style={{ textAlign: 'right' }}>Net P&L</th>
                  <th style={{ textAlign: 'right' }}>Comm <InfoPopup text="IBKR Pro Fixed: $0.005/share, $1 min, 1% trade value max." /></th>
                  <th style={{ textAlign: 'right' }}>Borrow <InfoPopup text="Short borrow cost based on days held and sector rate." /></th>
                  <th style={{ textAlign: 'right' }}>Peak P&L <InfoPopup text="Highest unrealized P&L before exit. Shows how much was left on the table." /></th>
                  <th>Exit Type</th>
                  <th>Cycle</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {recentTrades.map((t, i) => (
                  <tr key={i}>
                    <td className={styles.tickerCell}>{t.ticker}</td>
                    <td><DirBadge direction={t.direction} /></td>
                    <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{fmtUsd(t.entryPrice)}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{fmtUsd(t.exitPrice)}</td>
                    <td style={{ textAlign: 'right' }}>{t.shares}</td>
                    <td style={{ textAlign: 'right' }}>{fmtPnl(t.pnl)}</td>
                    <td style={{ textAlign: 'right', color: '#888', fontFamily: 'monospace' }}>{t.commission ? fmtUsd(t.commission) : '--'}</td>
                    <td style={{ textAlign: 'right', color: '#888', fontFamily: 'monospace' }}>{t.borrow ? fmtUsd(t.borrow) : '--'}</td>
                    <td style={{ textAlign: 'right' }}>{t.peakProfit ? fmtPnl(t.peakProfit) : '--'}</td>
                    <td>
                      <span className={styles.exitBadge} style={{
                        color: t.exitType === 'TRAILING_STOP' ? '#3b82f6' : '#f59e0b',
                        borderColor: t.exitType === 'TRAILING_STOP' ? '#3b82f644' : '#f59e0b44',
                      }}>
                        {t.exitType === 'TRAILING_STOP' ? 'TRAIL' : t.exitType === '1H_LOW_BREAK' ? '1H LOW' : t.exitType === '1H_HIGH_BREAK' ? '1H HIGH' : t.exitType === 'LOT_STOP' ? 'LOT' : t.exitType || '--'}
                      </span>
                    </td>
                    <td style={{ color: '#888', fontSize: 11 }}>{t.cycleNum > 0 ? `#${t.cycleNum + 1}` : '--'}</td>
                    <td style={{ color: '#666', fontSize: 11 }}>{t.exitDate || '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ═══ OUTBOX (collapsible) ═══ */}
      <div className={styles.section} style={{ borderLeftColor: '#333' }}>
        <div className={styles.sectionHeader} onClick={() => setShowOutbox(!showOutbox)} style={{ cursor: 'pointer' }}>
          <span className={styles.sectionTitle}>
            OUTBOX
            <InfoPopup text="Order commands sent to the IBKR bridge. The bridge polls this queue and executes via TWS API." />
          </span>
          <span className={styles.badge}>{recentOrders.length}</span>
          <span className={styles.expandIcon}>{showOutbox ? '▼' : '▶'}</span>
        </div>
        {showOutbox && recentOrders.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Command</th>
                  <th>Ticker</th>
                  <th>Details</th>
                  <th>Status</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {recentOrders.map((o, i) => {
                  const req = o.request || {};
                  let details = '';
                  if (req.shares) details += `${req.shares} sh`;
                  if (req.price) details += ` @ ${fmtUsd(req.price)}`;
                  if (req.stopPrice) details += ` / Stop ${fmtUsd(req.stopPrice)}`;
                  if (req.newStopPrice) details += ` → ${fmtUsd(req.newStopPrice)}`;
                  if (req.reason) details += ` (${req.reason})`;
                  if (req.lot != null) details += ` / L${req.lot + 1}`;
                  if (req.triggerPrice) details += ` trigger ${fmtUsd(req.triggerPrice)}`;

                  const statusColor = o.status === 'DONE' ? '#22c55e' : o.status === 'FAILED' ? '#ef4444' : '#f59e0b';
                  return (
                    <tr key={i}>
                      <td><span className={styles.cmdBadge}>{o.command}</span></td>
                      <td className={styles.tickerCell}>{req.ticker || '--'}</td>
                      <td style={{ color: '#aaa', fontSize: 11 }}>{details}</td>
                      <td><span style={{ color: statusColor, fontWeight: 600, fontSize: 11 }}>{o.status}</span></td>
                      <td style={{ color: '#555', fontSize: 11 }}>{o.createdAt ? new Date(o.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
