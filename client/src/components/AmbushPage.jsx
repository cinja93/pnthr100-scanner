// AmbushPage.jsx — PNTHR Ambush V7.6 Dashboard
// Full phase visibility: STALKING → ATTACK → ACTIVE → PROTECT
// Every metric the engine uses is surfaced so you can verify the machine.

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../AuthContext';
import { fetchAmbushSummary, updateAmbushConfig, triggerAmbushTick, deleteAmbushPosition, fetchAmbushProjection, fetchAmbushReconcile, fetchEliteScorecard, setAmbushReopen } from '../services/api';
import LongShortScorecard from './LongShortScorecard';
import PageHeader from './PageHeader';
import AiTickerChartModal from './AiTickerChartModal';
import styles from './AmbushPage.module.css';

// ── Constants (mirror server/ambush/ambushEngine.js) ───────────────────────
const LOT_OFFSETS  = [0, 0.03, 0.06, 0.10, 0.14];
const BE_THRESHOLD = 75;
const GRAD_TIER_1  = 125_000;
const GRAD_TIER_2  = 166_000;

const STATE_COLORS = {
  STALKING: '#a78bfa', HUNTING: '#f59e0b', ATTACK: '#f97316', ACTIVE: '#22c55e', DEVOUR: '#22c55e', PROTECT: '#3b82f6',
  'STILL HUNGRY': '#e879f9',
};
// Display the engine's ACTIVE state as "DEVOUR" (panther hunt cycle). Engine value stays ACTIVE.
const STATE_DISPLAY = { STALKING: 'STALKING', ATTACK: 'ATTACK', ACTIVE: 'DEVOUR', PROTECT: 'PROTECT' };

// The PNTHR Hunt Cycle. New entry: STALKING → HUNTING → ATTACK → DEVOUR → PROTECT.
// Re-entry loop: exit → STALKING → ATTACK → DEVOUR.
const PHASE_INFO = {
  STALKING: 'STALKING (purple): the prey pool — every name with an active weekly BL+1 / SS+1 signal (and any name stopped out, now hunting a re-entry). Shown in the STALKING box. The panther is watching, waiting for the daily 2-day-high to clear.',
  HUNTING: 'HUNTING (amber): the daily 2-day-high has cleared — the panther is closing in. The engine now watches these names every 60s for the real-time break of the prior hourly bar high. Shown in the HUNTING box.',
  ATTACK: 'ATTACK (orange): the pounce — price just broke the prior hourly bar high (N=1), the entry order fires this tick. A brief hand-off into a live position. Also where re-entries fire on the 2-bar-high break.',
  DEVOUR: 'DEVOUR (green): a live position, in the kill — stop is still the first-hour disaster stop (below entry). Shown in the LIVE POSITIONS box with a green DEVOUR badge.',
  ACTIVE: 'DEVOUR (green): a live position, in the kill — stop is still the first-hour disaster stop (below entry). Shown in the LIVE POSITIONS box with a green DEVOUR badge.',
  PROTECT: 'PROTECT (blue): the kill is secured — a lot has ratcheted the stop to breakeven-or-better, so it can no longer turn into a loss. The panther guards its kill. Shown in the LIVE POSITIONS box with a blue PROTECT badge.',
  'STILL HUNGRY': 'STILL HUNGRY (pink): names that were exited or manually closed and are hunting another bite of the same stock. Re-entry needs price above BOTH the Weekly and Daily triggers plus a fresh 1-bar break (the loop back through the funnel). Shown in the STILL HUNGRY box.',
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

      {/* Lot-trail status for PROTECT (V7.6) */}
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
// ── DEVOUR ladder card: lays a position out like the real-world price ladder ──
// Entry is the anchor in the middle. LONG: lots stack ABOVE entry (price rises to add),
// stop + triggers BELOW. SHORT: mirror image (stop above, lots below). Green chips = live
// fields that move as lots fill. Header carries the pill + all 9 IBKR-truth checks + DIAG.
function LadderCard({ pos, rec, allTickers, onChart, onRemove, isAdmin, PILL }) {
  const isLong = pos.direction === 'LONG';
  const total = totalPlannedShares(pos);
  const risk = computeRisk(pos);
  const rps = computeRps(pos);
  const exitLevel = isLong ? pos.todayFirstHourLow : pos.todayFirstHourHigh;
  const rollupColor = rec ? (PILL[rec.rollup] || PILL.gray) : PILL.gray;
  const navPctByLot = {}; (rec?.lotLadder || []).forEach(l => { navPctByLot[l.lot] = l.navPct; });
  const STATUS_COLORS = { FILLED: '#22c55e', WAITING: '#f59e0b', LOCKED: '#555' };
  const GREEN = '#9ae6b4';
  const mono = { fontFamily: 'monospace' };

  const lotRows = (pos.lotPlan || []).map((shares, i) => {
    const status = getLotStatus(i, pos.nextLot);
    const trigger = getLotTrigger(pos.originalEntry, i, pos.direction);
    const fill = pos.lotFills?.find(f => f.lot === i);
    const fillTime = fill?.at ? new Date(fill.at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    return { i, label: `L${i + 1}`, trigger, shares, status, fillTime, navPct: navPctByLot[i + 1] };
  });
  // LONG: show L5 (top, furthest) down to L1 (just above entry). SHORT: L1 (just below entry) down to L5.
  const orderedLots = isLong ? [...lotRows].reverse() : lotRows;

  const lotsBlock = (
    <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
      <div style={{ flex: '1 1 0', minWidth: 0 }}>
        {orderedLots.map(l => (
          <div key={l.i} style={{ display: 'grid', gridTemplateColumns: '54px 82px 64px 72px 124px 92px 1fr', gap: 8, alignItems: 'center', padding: '3px 0', fontSize: 12, fontWeight: l.status === 'FILLED' ? 700 : 400, opacity: l.status === 'LOCKED' ? 0.5 : 1 }}>
            <span style={{ color: STATUS_COLORS[l.status] }}>{l.status === 'LOCKED' ? '○' : '●'} {l.label}</span>
            <span style={mono}>{fmtUsd(l.trigger)}</span>
            <span style={mono}>{l.shares} sh</span>
            <span style={{ color: STATUS_COLORS[l.status], fontSize: 11 }}>{l.status}</span>
            <span style={{ ...mono, color: '#888', fontSize: 11 }}>{l.fillTime || (l.status === 'FILLED' ? '--' : '')}</span>
            <span style={{ ...mono, color: GREEN }}>{l.navPct != null ? l.navPct.toFixed(2) : '--'}% NAV</span>
            <span />
          </div>
        ))}
      </div>
      <div style={{ flexShrink: 0, textAlign: 'right', borderLeft: '1px solid #2a2a33', paddingLeft: 12, minWidth: 110 }}>
        <div style={{ fontSize: 9, color: '#888', letterSpacing: 0.4 }}>TOTAL AT L5</div>
        <div style={{ ...mono, fontSize: 13, fontWeight: 700 }}>{total} sh</div>
        <div style={{ ...mono, fontSize: 11, color: '#aaa' }}>{fmtUsd(total * (pos.originalEntry || 0))}</div>
      </div>
    </div>
  );

  const chip = (v) => <span style={{ background: 'rgba(34,197,94,0.14)', color: GREEN, padding: '1px 7px', borderRadius: 4, ...mono, fontWeight: 700 }}>{v}</span>;
  const entryRow = (
    <div style={{ display: 'flex', gap: 22, alignItems: 'center', padding: '8px 10px', margin: '8px 0', background: '#16161c', border: '1px solid #2a3a2e', borderRadius: 6, flexWrap: 'wrap' }}>
      <span style={{ fontWeight: 800, color: '#ccc', letterSpacing: 0.6 }}>ENTRY</span>
      <span style={{ fontSize: 12, color: '#999' }}>Price {chip(fmtUsd(pos.entryPrice))}</span>
      <span style={{ fontSize: 12, color: '#999' }}>Shares {chip(`${pos.totalShares || 0} / ${total}`)}</span>
      <span style={{ fontSize: 12, color: '#999' }}>Avg Cost {chip(fmtUsd(pos.avgCost))}</span>
    </div>
  );

  const stopBlock = (
    <div style={{ fontSize: 12 }}>
      <div style={{ display: 'flex', gap: 22, alignItems: 'center', padding: '3px 0', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, color: '#ef4444', minWidth: 110 }}>2 Bar Stop</span>
        {chip(fmtUsd(pos.stop))}
        <span style={{ color: '#999' }}>Risk <span style={{ ...mono, color: risk > 200 ? '#ef4444' : '#ddd', fontWeight: 700 }}>{risk != null ? fmtUsd(risk) : '--'}</span></span>
        <span style={{ color: '#999' }}>Risk/Share <span style={{ ...mono, color: '#ddd' }}>{rps != null ? fmtUsd(rps) : '--'}</span></span>
      </div>
      <div style={{ display: 'flex', gap: 22, alignItems: 'center', padding: '3px 0' }} title="When this position is open the 2-bar stop above is the live exit. If it sells off, this becomes the 1-bar re-entry trigger (provided the day + weekly triggers aren't violated). One or the other carries the live number.">
        <span style={{ fontWeight: 700, color: '#a78bfa', minWidth: 110 }}>1 Bar Reentry</span>
        <span style={{ ...mono, color: '#666' }}>{'--'}</span>
      </div>
      <div style={{ display: 'flex', gap: 18, padding: '4px 0 0', fontSize: 11, flexWrap: 'wrap', color: '#888' }}>
        <span>Original Stop <span style={{ ...mono, color: '#f59e0b' }}>{exitLevel ? fmtUsd(exitLevel) : '--'}</span></span>
        <span>Day Trigger <span style={{ ...mono, color: '#60a5fa' }}>{pos.dailyTrigger != null ? fmtUsd(pos.dailyTrigger) : '--'}</span></span>
        <span>Weekly Trigger <span style={{ ...mono, color: '#a78bfa' }}>{pos.weeklyTrigger != null ? fmtUsd(pos.weeklyTrigger) : '--'}</span></span>
      </div>
    </div>
  );

  const CHECK_LABELS = { direction: 'Dir', shares: 'Shares', avgCost: 'Avg', stopExists: 'Stop in IBKR', stopPrice: 'Stop price', stopLevel: 'Stop lvl', stopQty: 'Stop qty', cap: '10% cap', risk: 'Risk' };
  const diagText = rec ? `${pos.ticker} ${pos.direction} ${Math.abs(rec.ibkrShares ?? rec.engineShares ?? 0)}sh — ${rec.reasons?.length ? rec.reasons.join(' | ') : 'all green'}` : '';

  return (
    <div style={{ border: `1px solid ${rollupColor === PILL.gray ? '#2a2a33' : rollupColor}`, borderLeft: `4px solid ${rollupColor}`, borderRadius: 8, background: '#0e0e13', padding: '12px 14px' }}>
      {/* HEADER: pill + ticker + dir + lots + peak/trail/cycle + remove */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ width: 11, height: 11, borderRadius: '50%', background: rollupColor, flexShrink: 0, boxShadow: rec?.rollup === 'red' ? `0 0 6px ${rollupColor}` : 'none' }} />
        <span onClick={() => onChart(pos.ticker, allTickers)} style={{ fontWeight: 800, fontSize: 16, cursor: 'pointer', color: '#fff' }} title="click for charts">{pos.ticker}</span>
        <DirBadge direction={pos.direction} />
        <span style={{ fontSize: 12, color: '#aaa' }}>{lotsLabel(pos)}</span>
        <span style={{ fontSize: 12, color: '#888' }}>Peak P&amp;L <span style={{ color: (pos.peak || 0) >= 0 ? '#22c55e' : '#ef4444', fontWeight: 700 }}>{fmtPnl(pos.peak)}</span></span>
        {pos.atBE && <span style={{ color: '#3b82f6', fontWeight: 600, fontSize: 11 }} title="2-bar trailing exit active">TRAIL ✓</span>}
        {pos.cycleNum > 0 && <span style={{ fontSize: 11, color: '#888' }}>Cycle #{pos.cycleNum + 1}</span>}
        <span style={{ fontSize: 11, color: '#666' }}>{pos.entryDate || ''}</span>
        <span style={{ flex: 1 }} />
        {isAdmin && <button onClick={() => onRemove(pos.ticker)} style={{ background: 'transparent', border: '1px solid #3a3a44', color: '#888', borderRadius: 4, padding: '2px 9px', cursor: 'pointer', fontSize: 13 }} title="Remove position">×</button>}
      </div>

      {/* IBKR-TRUTH VERIFICATION: all 9 checks + DIAG */}
      <div style={{ border: '1px solid #2a2a33', borderRadius: 6, padding: '8px 10px', marginBottom: 10, background: '#121217' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 800, color: '#9a9aa6', letterSpacing: 0.6 }}>IBKR-TRUTH VERIFICATION</span>
          {rec && <button onClick={() => navigator.clipboard?.writeText(diagText)} style={{ background: '#2a2a33', color: '#d4d4dc', border: '1px solid #3a3a44', borderRadius: 4, padding: '2px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }} title="Copy this position's diagnostic">DIAG</button>}
        </div>
        {!rec ? <span style={{ fontSize: 11, color: '#666' }}>No verification data yet.</span> : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
            {Object.entries(rec.checks || {}).map(([k, c]) => (
              <span key={k} style={{ fontSize: 11, display: 'inline-flex', alignItems: 'baseline', gap: 5, color: c.status === 'red' ? '#ffb4b4' : c.status === 'yellow' ? '#f0d090' : '#8a8a96' }} title={c.reason || 'OK'}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: PILL[c.status] || PILL.gray, flexShrink: 0, alignSelf: 'center' }} />
                {CHECK_LABELS[k] || k}{(c.status === 'red' || c.status === 'yellow') && c.reason ? `: ${c.reason}` : ''}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* LADDER: LONG = lots above / stop below; SHORT = mirror */}
      {isLong ? (<>{lotsBlock}{entryRow}{stopBlock}</>) : (<>{stopBlock}{entryRow}{lotsBlock}</>)}
    </div>
  );
}

function StateBadge({ state }) {
  return (
    <span className={styles.stateBadge} style={{ background: STATE_COLORS[state] + '22', color: STATE_COLORS[state], borderColor: STATE_COLORS[state] + '44' }}>
      {STATE_DISPLAY[state] || state}
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
function WatchCol({ title, color, items, onTicker, onRightClick, eng, chipStyle }) {
  // Chips colored by ENGAGEMENT (eng): SOLID green/red = in play (held • / daily
  // cleared), YELLOW = attacking, LIGHT green/red = weekly signal but not in play yet.
  const readyCount = items.filter(i => i.ready).length;
  return (
    <div style={{ flex: 1, minWidth: 220 }}>
      <div style={{ color, fontSize: 11, fontWeight: 700, marginBottom: 6 }}>
        {title} <span style={{ color: '#555' }}>· {readyCount} eligible / {items.length} total</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {items.length === 0 ? <span style={{ color: '#555', fontSize: 12 }}>none today</span> : items.map(it => {
          const e = eng(it.ticker);
          return (
            <span key={it.ticker} onClick={() => onTicker?.(it.ticker)}
              onContextMenu={onRightClick ? (ev) => { ev.preventDefault(); onRightClick(it.ticker); } : undefined}
              title={`${it.sector} — ${e.label} · click for charts`} style={chipStyle(e)}>
              {it.ticker}{e.held ? ' •' : ''}
            </span>
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

function AumChart({ projected, actual, actualProjected }) {
  if (!projected?.length) return null;
  const W = 1000, H = 230, padL = 6, padR = 6, padT = 12, padB = 24;
  const proj = projected, act = actual || [], actProj = actualProjected || [];
  const maxV = Math.max(...proj.map(p => p.value), ...act.map(a => a.value), ...actProj.map(a => a.value));
  const minV = Math.min(proj[0].value, ...act.map(a => a.value), ...actProj.map(a => a.value));
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
  const actProjPts = actProj.filter((_, i) => i % step === 0 || i === actProj.length - 1)
    .map(a => `${xd(a.date).toFixed(1)},${y(a.value).toFixed(1)}`).join(' ');
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
      {actProjPts && <polyline points={actProjPts} fill="none" stroke="#22c55e" strokeWidth="2" strokeDasharray="2 5" opacity="0.85" />}
      {actPts && <polyline points={actPts} fill="none" stroke="#22c55e" strokeWidth="2.5" />}
      {/* "You are here" dot on the latest actual point. A <polyline> needs 2+ points to
          draw, so a brand-new book (a single actual data point) would show NO actual line
          at all — this marker makes today's AUM visible from day one, and labels the
          current position on an established book too. */}
      {act.length > 0 && (() => {
        const a = act[act.length - 1]; const cx = xd(a.date), cy = y(a.value);
        return (isFinite(cx) && isFinite(cy)) ? <circle cx={cx} cy={cy} r="4" fill="#22c55e" stroke="#0a0a0a" strokeWidth="1.5" /> : null;
      })()}
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
  const isProj = view === 'projected' || view === 'projectedGross';
  const series = view === 'projectedGross' ? (projection.projectedGross || []) : isProj ? (projection.projected || []) : (projection.actual || []);
  // Projected: one row per WEEK (first trading day of each week). Actual: every snapshot.
  let rows = series;
  if (isProj) {
    const seen = new Set(); rows = [];
    for (const p of series) { const wk = mondayOf(p.date); if (!seen.has(wk)) { seen.add(wk); rows.push(p); } }
  }
  return (
    <div onClick={onClose} className="pnthr-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#0d0d0d', border: '1px solid #2a2a2a', borderRadius: 10, width: 440, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid #222' }}>
          <div style={{ color: isProj ? '#3b82f6' : '#22c55e', fontWeight: 700, fontSize: 14 }}>
            {view === 'projectedGross' ? 'Projected AUM (Gross) — week by week' : isProj ? 'Projected AUM — week by week' : 'Actual AUM — daily history'}
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

// Forward projection: today's real AUM ridden forward at the backtest growth,
// with the live $2M -> bank $1M withdrawal rule. Shows working balance + banked.
export function ForwardProjection({ forward }) {
  if (!forward?.horizons?.length) return null;
  const rule = forward.withdrawalRule || {};
  return (
    <div style={{ marginTop: 14, background: '#0d0d0d', border: '1px solid #2e7d46', borderRadius: 10, padding: '14px 16px', boxShadow: '0 0 0 1px rgba(34,197,94,0.08)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid #1d3a28' }}>
        <span style={{ color: '#22c55e', fontWeight: 800, fontSize: 17, letterSpacing: '0.03em' }}>🎯 PNTHR GOALS</span>
        <span style={{ color: '#666', fontSize: 11 }}>where today's real AUM goes from here</span>
      </div>
      <div style={{ color: '#22c55e', fontWeight: 700, fontSize: 13, letterSpacing: '0.04em' }}>
        PROJECTED FORWARD <span style={{ color: '#555', fontWeight: 400 }}>· riding today's real AUM forward at the backtest</span>
      </div>
      <div style={{ color: '#666', fontSize: 11, marginTop: 3, lineHeight: 1.4 }}>
        Live withdrawal rule applied: once the working balance reaches {fmtAum(rule.threshold)}, bank {fmtAum(rule.amount)} and trade off the rest. Banked profit is locked in and yours.
        {forward.cagrPct ? ` Growth rides today's AUM at the backtested ${forward.cagrPct}% CAGR.` : ''}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 10, minWidth: 560 }}>
          <thead>
            <tr style={{ color: '#b4b4be', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>Horizon</th>
              <th style={{ textAlign: 'right', padding: '6px 8px', color: '#3b82f6' }}>Projected AUM</th>
              <th style={{ textAlign: 'right', padding: '6px 8px' }}>Working Balance</th>
              <th style={{ textAlign: 'right', padding: '6px 8px' }}>Profit Banked</th>
              <th style={{ textAlign: 'right', padding: '6px 8px', color: '#22c55e' }}>Your Total</th>
              <th style={{ textAlign: 'right', padding: '6px 8px' }}>Edge</th>
            </tr>
          </thead>
          <tbody>
            {forward.horizons.map((h, i) => {
              const a = h.actual, p = h.projected;
              if (!a) return null;
              const edge = (p && p.total > 0) ? ((a.total / p.total - 1) * 100) : 0;
              return (
                <tr key={i} style={{ borderTop: '1px solid #1a1a1a', fontFamily: 'monospace' }}>
                  <td style={{ textAlign: 'left', padding: '7px 8px', fontFamily: 'system-ui, sans-serif', color: '#e6e6e6', fontWeight: 700 }}>
                    {h.label}
                    {h.extrapolated && (
                      <span title="Beyond the ~3.5-yr backtest — extended at the backtest CAGR" style={{ color: '#8a8', fontSize: 9, fontWeight: 400, marginLeft: 6 }}>
                        extrapolated
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', padding: '7px 8px', color: '#3b82f6' }}>{p ? fmtAum(p.total) : '--'}</td>
                  <td style={{ textAlign: 'right', padding: '7px 8px', color: '#ccc' }}>{fmtAum(a.balance)}</td>
                  <td style={{ textAlign: 'right', padding: '7px 8px', color: a.banked > 0 ? '#fbbf24' : '#555' }}>{a.banked > 0 ? fmtAum(a.banked) : '--'}</td>
                  <td style={{ textAlign: 'right', padding: '7px 8px', color: '#22c55e', fontWeight: 700 }}>{fmtAum(a.total)}</td>
                  <td style={{ textAlign: 'right', padding: '7px 8px', color: edge >= 0 ? '#22c55e' : '#ef4444' }}>{edge >= 0 ? '+' : ''}{edge.toFixed(1)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Cash-ledger / margin-stress detail modal (Tree page; opened from the AUM panel).
export function CashLedgerModal({ data, onClose }) {
  const f = n => (n < 0 ? '-$' : '$') + Math.round(Math.abs(n)).toLocaleString();
  const b = data.breaks || {};
  const noBreaks = !b.blowupDays && !b.call25Days && !b.call30Days && !b.call35Days;
  const stat = (label, value, color) => (
    <div style={{ background: '#121212', border: '1px solid #222', borderRadius: 8, padding: '8px 12px', minWidth: 150 }}>
      <div style={{ color: '#888', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ color: color || '#e6e6e6', fontSize: 18, fontWeight: 700, fontFamily: 'monospace' }}>{value}</div>
    </div>
  );
  return (
    <div onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      className="pnthr-overlay"
      style={{ position: 'fixed', inset: 0, background: '#000a', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#0d0d0d', border: '1px solid #25405f', borderRadius: 12, padding: '20px 22px', maxWidth: 840, width: '100%', maxHeight: '88vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h2 style={{ margin: 0, color: '#3b82f6', fontSize: 18 }}>📒 Cash Ledger &amp; Margin Stress</h2>
          <button onClick={onClose} style={{ background: '#161616', border: '1px solid #2a2a2a', color: '#aaa', borderRadius: 6, padding: '4px 12px', cursor: 'pointer' }}>Close</button>
        </div>
        <div style={{ color: '#666', fontSize: 11, margin: '4px 0 14px' }}>{data.strategy} · {data.period} · {data.tradingDays} trading days · start {f(data.startCash)}</div>

        <div style={{ background: noBreaks ? '#0e1f14' : '#2a0d0d', border: `1px solid ${noBreaks ? '#22c55e' : '#ef4444'}`, borderRadius: 8, padding: '10px 14px', marginBottom: 14, color: noBreaks ? '#22c55e' : '#fca5a5', fontWeight: 700, fontSize: 13 }}>
          {noBreaks ? '✅ Never breaks — 0 account-blowup days and 0 margin-call days (25/30/35% maintenance).' : '❌ Breaks — see the break tests below.'}
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          {stat('Ending equity', f(data.endingEquity), '#22c55e')}
          {stat('Max drawdown', data.maxDDPct + '%', '#facc15')}
          {stat('Lowest equity', f(data.lowestEquity), '#e6e6e6')}
          {stat('Deepest margin loan', f(-data.deepestMarginLoan), '#facc15')}
          {stat('Peak lev (close)', data.peakLevClose + '×', '#e6e6e6')}
          {stat('Peak lev (intraday)', data.peakLevIntraday + '×', '#e6e6e6')}
        </div>

        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 14, lineHeight: 1.5 }}>
          A margin call would only trigger if your broker's blended maintenance requirement exceeded <b style={{ color: '#facc15' }}>{data.callMaintBreakevenPct}%</b> (standard is 25–35%). Reg-T maintenance of 25% calls at 4× leverage; the peak here was {data.peakLevIntraday}×.
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 16 }}>
          <tbody>
            {[['Account blowup (equity ≤ 0)', b.blowupDays],
              ['Margin call @ 25% maintenance (lev > 4.0×)', b.call25Days],
              ['Margin call @ 30% maintenance (lev > 3.3×)', b.call30Days],
              ['Margin call @ 35% maintenance (lev > 2.9×)', b.call35Days]].map(([label, days], i) => (
              <tr key={i} style={{ borderTop: '1px solid #1a1a1a' }}>
                <td style={{ padding: '6px 8px', color: '#ccc' }}>{label}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right', color: days ? '#ef4444' : '#22c55e', fontWeight: 700 }}>{days ? days + ' days ❌' : '0 days ✅'}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ color: '#888', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Most-levered days — top 8 by intraday leverage across the whole backtest (not a date range)</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'monospace', minWidth: 560 }}>
            <thead><tr style={{ color: '#b4b4be', fontSize: 10, textTransform: 'uppercase' }}>
              <th style={{ textAlign: 'left', padding: '5px 8px' }}>Date</th>
              <th style={{ textAlign: 'right', padding: '5px 8px' }}>Lev (close)</th>
              <th style={{ textAlign: 'right', padding: '5px 8px' }}>Lev (intraday)</th>
              <th style={{ textAlign: 'right', padding: '5px 8px' }}>Equity</th>
              <th style={{ textAlign: 'right', padding: '5px 8px' }}>Cash</th>
              <th style={{ textAlign: 'right', padding: '5px 8px' }}>Long MV</th>
            </tr></thead>
            <tbody>
              {(data.worstDays || []).map((r, i) => (
                <tr key={i} style={{ borderTop: '1px solid #1a1a1a' }}>
                  <td style={{ textAlign: 'left', padding: '5px 8px', color: '#e6e6e6', fontFamily: 'system-ui, sans-serif' }}>{r.date}</td>
                  <td style={{ textAlign: 'right', padding: '5px 8px', color: '#ccc' }}>{r.levClose}×</td>
                  <td style={{ textAlign: 'right', padding: '5px 8px', color: '#facc15' }}>{r.levIntraday}×</td>
                  <td style={{ textAlign: 'right', padding: '5px 8px', color: '#22c55e' }}>{f(r.equity)}</td>
                  <td style={{ textAlign: 'right', padding: '5px 8px', color: '#ef4444' }}>{f(r.cash)}</td>
                  <td style={{ textAlign: 'right', padding: '5px 8px', color: '#ccc' }}>{f(r.longMV)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {data.weekly?.length > 0 && (
          <>
            <div style={{ color: '#888', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '18px 0 6px' }}>
              Weekly results — full backtest ({data.weekly.length} weeks · {data.weekly[0].weekOf} → {data.weekly[data.weekly.length - 1].endDate})
            </div>
            <div style={{ maxHeight: 340, overflowY: 'auto', border: '1px solid #1a1a1a', borderRadius: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'monospace', minWidth: 560 }}>
                <thead><tr style={{ color: '#b4b4be', fontSize: 10, textTransform: 'uppercase', position: 'sticky', top: 0, background: '#0d0d0d' }}>
                  <th style={{ textAlign: 'left', padding: '5px 8px' }}>Week of</th>
                  <th style={{ textAlign: 'right', padding: '5px 8px' }}>Equity</th>
                  <th style={{ textAlign: 'right', padding: '5px 8px' }}>P&amp;L</th>
                  <th style={{ textAlign: 'right', padding: '5px 8px' }}>P&amp;L %</th>
                  <th style={{ textAlign: 'right', padding: '5px 8px' }}>Peak lev</th>
                  <th style={{ textAlign: 'right', padding: '5px 8px' }}>Margin loan</th>
                  <th style={{ textAlign: 'right', padding: '5px 8px' }}>Pos</th>
                </tr></thead>
                <tbody>
                  {data.weekly.map((w, i) => (
                    <tr key={i} style={{ borderTop: '1px solid #1a1a1a' }}>
                      <td style={{ textAlign: 'left', padding: '4px 8px', color: '#e6e6e6', fontFamily: 'system-ui, sans-serif' }}>{w.weekOf}</td>
                      <td style={{ textAlign: 'right', padding: '4px 8px', color: '#e6e6e6' }}>{f(w.equity)}</td>
                      <td style={{ textAlign: 'right', padding: '4px 8px', color: w.pnl >= 0 ? '#22c55e' : '#ef4444' }}>{w.pnl >= 0 ? '+' : ''}{f(w.pnl)}</td>
                      <td style={{ textAlign: 'right', padding: '4px 8px', color: w.pnlPct >= 0 ? '#22c55e' : '#ef4444' }}>{w.pnlPct >= 0 ? '+' : ''}{w.pnlPct}%</td>
                      <td style={{ textAlign: 'right', padding: '4px 8px', color: w.maxLevIntraday > 2 ? '#facc15' : '#ccc' }}>{w.maxLevIntraday}×</td>
                      <td style={{ textAlign: 'right', padding: '4px 8px', color: w.minCash < 0 ? '#ef4444' : '#555' }}>{w.minCash < 0 ? f(w.minCash) : '—'}</td>
                      <td style={{ textAlign: 'right', padding: '4px 8px', color: '#ccc' }}>{w.posCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div style={{ color: '#555', fontSize: 10, marginTop: 14 }}>{data.disclosure}</div>
      </div>
    </div>
  );
}

// Strip the Net/Gross prefix so 'Net CAGR' / 'Gross CAGR' share one definition.
const baseKey = (l) => String(l).replace(/^(Net|Gross)\s+/, '');
// "How this is calculated" copy for the ⓘ on each metric tile.
const METRIC_INFO = {
  'Total Return': 'Ending equity ÷ $100K start − 1 — the full cumulative gain over the backtest window.',
  'CAGR': 'Compound annual growth rate: (ending ÷ $100K) ^ (1 ÷ years) − 1. Smooths the total return into a per-year rate.',
  'Sharpe': 'Mean daily return ÷ standard deviation of daily returns, annualized (× √252). Reward per unit of total volatility.',
  'Sortino': 'Like Sharpe, but divides by downside deviation only (negative days), annualized. Reward per unit of harmful volatility.',
  'Profit Factor': 'Gross profit ÷ gross loss across all closed trades. 2.2× means $2.20 won for every $1.00 lost.',
  'Calmar': 'CAGR ÷ max drawdown. Return earned per unit of worst-case peak-to-trough loss.',
  'Recovery Factor': 'Total net profit ÷ max drawdown (in dollars). How many times over the strategy earned back its deepest drawdown.',
  'Positive Months': 'Share of calendar months that closed higher than the prior month-end.',
  'Win Rate': 'Share of closed trades that were profitable. A low win rate is fine when payoff (avg win ÷ avg loss) is high.',
  'Total Closed': 'Number of round-trip trades closed over the backtest.',
  'Ending Equity': 'Account value at the end of the backtest, compounding from the $100K start.',
  'Alpha vs S&P': 'Ending equity minus what $100K would be worth if it had simply tracked the S&P 500 over the same window — dollars earned above the index.',
  'Avg Win': 'Average gain on winning trades — the price move from entry to exit (% and $). Price-based, so it reads the same net or gross.',
  'Avg Winner Hold': 'Average number of trading days a winning trade was held (entry to exit), shown with the median.',
  'Avg Month': 'Average of every monthly return. "positive X%" is the share of months that finished up.',
  'Best Month': 'The single best calendar-month return over the backtest.',
  'Avg Up Month': 'Average return across only the months that finished positive.',
  'Avg Down Month': 'Average return across only the months that finished negative.',
  'Avg Loss': 'Average loss on losing trades (% and $). Most are small breakeven-snap scratch exits.',
  'Avg Loser Hold': 'Average number of trading days a losing trade was held, with the median. Losers are cut quickly.',
  'Max Monthly DD': 'The worst single calendar-month return in the backtest.',
  'Avg Within-Month Dip': 'For each month, its worst peak-to-trough dip on daily closes, then averaged — the typical drawdown felt inside a month.',
  'Worst 30 Days': 'The worst peak-to-trough decline over any rolling 30-calendar-day window.',
  'Worst Stretch': 'The deepest peak-to-trough decline measured on month-end values (a multi-month drawdown).',
  'Max Drawdown': 'The largest peak-to-trough decline on the daily equity curve over the entire backtest.',
};

export function AumTracker({ projection, hideForward, cashLedger, onActualTable }) {
  // onActualTable (optional): overrides the Actual AUM box click — the Tree page
  // uses it to open its IBKR-truth daily trade log instead of the plain table.
  const [showChart, setShowChart] = useState(false);
  const [tableView, setTableView] = useState(null);
  const [showLedger, setShowLedger] = useState(false);
  const [infoMetric, setInfoMetric] = useState(null);   // metric whose "how it's calculated" popover is open
  const openActual = onActualTable || (() => setTableView('actual'));
  if (!projection?.current) return null;
  const { current, projected, actual, anchor } = projection;
  // Tree carries the extra monthly/winner fields → use the aligned fixed-column grid only there;
  // Ambush keeps its original stretch layout untouched.
  const treeLayout = projection.metrics?.maxMonthlyDDPct != null;
  const box = (label, value, color, onClick) => (
    <div onClick={onClick} title="Click for the full table" style={{ cursor: 'pointer', background: '#161616', border: '1px solid #2a2a2a', borderRadius: 8, padding: '8px 14px', minWidth: 175 }}>
      <div style={{ color: '#888', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', display: 'flex', justifyContent: 'space-between', gap: 10 }}>
        <span>{label}</span><span style={{ color: '#555' }}>▸ table</span>
      </div>
      <div style={{ color, fontSize: 22, fontWeight: 700, fontFamily: 'monospace' }}>{fmtAum(value)}</div>
    </div>
  );
  // One row of hedge-fund metric cards for a given metrics object (Net or Gross).
  // shared card renderer (one tile)
  // Fixed 14-column grid (gap 8px) shared by all 3 panels → tiles are identical width and the
  // 11 monthly tiles line up under the first 11 columns of the 14-tile NET/GROSS rows.
  const tileGrid = (tiles, oneLine, accent) => (
    <div style={{ display: 'flex', flexWrap: treeLayout ? 'wrap' : (oneLine ? 'nowrap' : 'wrap'), gap: 8, marginTop: 6 }}>
      {tiles.map(([label, value, color, sub], i) => (
        <div key={i} style={{ background: '#121212', border: `1px solid ${accent || '#222'}`, borderRadius: 8, padding: '8px 10px', overflow: 'hidden',
          ...(treeLayout ? { flexGrow: 0, flexShrink: 0, flexBasis: 'calc((100% - 116px) / 14)', minWidth: 0 } : { minWidth: oneLine ? 0 : 96, flex: oneLine ? '1 1 0' : '1 1 auto' }) }}>
          {/* header: label + ⓘ. minHeight reserves 2 lines so the values below line up across all tiles. */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 4, minHeight: 22 }}>
            <span style={{ color: '#888', fontSize: 9, letterSpacing: '0.05em', textTransform: 'uppercase', lineHeight: 1.25 }}>{label}</span>
            {METRIC_INFO[baseKey(label)] && (
              <span onClick={(e) => { e.stopPropagation(); setInfoMetric(baseKey(label)); }} title="How this is calculated"
                style={{ cursor: 'pointer', color: '#5a5a5a', fontSize: 11, lineHeight: 1, flexShrink: 0 }}>ⓘ</span>
            )}
          </div>
          <div style={{ color, fontSize: 17, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
          {sub && <div style={{ color: '#555', fontSize: 9, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>}
        </div>
      ))}
    </div>
  );
  const metricTiles = (m, kind, oneLine = false) => {
    const tiles = [
      [`${kind} Total Return`, (m.netReturnPct >= 0 ? '+' : '') + Math.round(m.netReturnPct).toLocaleString() + '%', '#22c55e', '$' + Math.round((m.startNav || 100000) / 1000) + 'K start'],
      [`${kind} CAGR`, (m.cagrPct >= 0 ? '+' : '') + m.cagrPct + '%', '#22c55e'],
      ['Sharpe', m.sharpe, '#e6e6e6'],
      ['Sortino', m.sortino, '#22c55e'],
      ['Profit Factor', m.profitFactor + 'x', '#22c55e'],
      ['Calmar', m.calmar, '#e6e6e6'],
      ['Recovery Factor', m.recoveryFactor + 'x', '#e6e6e6'],
      ['Positive Months', m.positiveMonthsPct + '%', '#22c55e'],
      ['Win Rate', m.winRatePct + '%', '#e6e6e6', m.payoff + 'x payoff'],
      ['Total Closed', Math.round(m.totalClosed).toLocaleString(), '#e6e6e6'],
      ['Ending Equity', fmtAum(m.endingEquity), '#22c55e'],
      ['Alpha vs S&P', (m.alphaDollar >= 0 ? '+' : '') + fmtAum(m.alphaDollar), '#22c55e'],
    ];
    // Extra per-trade WINNER tiles (data-gated → only the Tree baseline carries these; Ambush
    // unaffected). NOTE: monthly-path stats (Avg Up / Best Month) are intentionally NOT here —
    // the gross curve = net + fees-added-back inflates the base and distorts monthly %, so those
    // live NET-only in the monthly/risk panel. These two are per-trade (price-based) → valid per stream.
    // Avg Win / Winner Hold are per-trade (price-based), so we show ONE value (NET) in BOTH rows
    // rather than a trivially-different gross figure — same number on net and gross by design.
    const w = projection.metrics;
    if (w?.avgWinPct != null) tiles.push(['Avg Win', '+' + w.avgWinPct + '%', '#22c55e', '+$' + Math.round(w.avgWinDollar).toLocaleString()]);
    if (w?.winnerHoldDays != null) tiles.push(['Avg Winner Hold', w.winnerHoldDays + 'd', '#22c55e', 'median ' + w.winnerHoldMed]);
    return tileGrid(tiles, oneLine);
  };
  // Drawdown / risk profile panel (NET) — rendered only when the baseline carries monthly stats.
  // Full monthly + risk profile — reported NET only (the gross monthly % is distorted by the
  // fee-add-back, so we show the honest net figure once rather than a misleading gross column).
  const riskPanel = (m) => (
    <div style={{ border: '1px solid #b45309', borderRadius: 10, padding: '0 10px 10px', marginTop: 10 }}>
      {rowLabel('MONTHLY & RISK PROFILE · NET OF TRADING COSTS')}
      {tileGrid([
        ['Avg Month', '+' + m.avgMonthPct + '%', '#22c55e', 'positive ' + m.positiveMonthsPct + '%'],
        ['Best Month', '+' + m.bestMonthPct + '%', '#22c55e'],
        ['Avg Up Month', '+' + m.avgUpMonthPct + '%', '#22c55e'],
        ['Avg Down Month', m.avgDownMonthPct + '%', '#f59e0b', 'when red'],
        ['Avg Loss', m.avgLossPct + '%', '#f59e0b', m.avgLossDollar != null ? '-$' + Math.abs(Math.round(m.avgLossDollar)).toLocaleString() : null],
        ['Avg Loser Hold', m.loserHoldDays + 'd', '#f59e0b', 'median ' + m.loserHoldMed],
        ['Max Monthly DD', m.maxMonthlyDDPct + '%', '#ef4444', 'worst month'],
        ['Avg Within-Month Dip', m.avgWithinMonthDipPct + '%', '#f59e0b', 'mid-month'],
        ['Worst 30 Days', m.worstRolling30Pct + '%', '#ef4444', 'rolling'],
        ['Worst Stretch', m.worstStretchPct + '%', '#ef4444', 'peak→trough'],
        ['Max Drawdown', '-' + Math.abs(m.maxDDPct).toFixed(1) + '%', '#ef4444', 'all-time'],
      ], false, '#3a2a12')}
    </div>
  );
  const rowLabel = (t) => <div style={{ color: '#888', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', marginTop: 12 }}>{t}</div>;
  // ON TRACK line + "At MM-DD-YY levels" + "N trading days ahead/behind schedule" grouped in a
  // SINGLE outlined box (Tree only — when current.aheadOfSchedule is present). Dynamic as AUM moves.
  const fmtMMDDYY = (d) => { const [y, m, dd] = String(d || '').split('-'); return y ? `${m}-${dd}-${y.slice(2)}` : '—'; };
  const trackWithPace = (pct) => {
    const a = current.aheadOfSchedule;
    if (!a || !a.date) return trackBadge(pct);   // no pace data → original standalone pill
    const ok = (pct ?? 0) >= 0;
    const col = ok ? '#22c55e' : '#ef4444';
    const n = Math.abs(a.tradingDays);
    return (
      <div style={{ border: `1px solid ${col}66`, background: col + '12', borderRadius: 8, padding: '8px 12px', textAlign: 'center', lineHeight: 1.5 }}>
        <div style={{ color: col, fontWeight: 700, fontSize: 12 }}>{ok ? 'ON TRACK' : 'BEHIND'} {pct >= 0 ? '+' : ''}{pct}% vs backtest</div>
        <div style={{ color: '#888', fontSize: 11, marginTop: 4 }}>At {fmtMMDDYY(a.date)} levels</div>
        <div style={{ color: a.ahead ? '#22c55e' : '#ef4444', fontWeight: 600, fontSize: 11 }}>
          {n} trading day{n === 1 ? '' : 's'} {a.ahead ? 'ahead of' : 'behind'} schedule
        </div>
      </div>
    );
  };
  // ON TRACK / BEHIND pill for a given % (vs backtest).
  const trackBadge = (pct, suffix = '') => {
    const ok = (pct ?? 0) >= 0;
    return (
      <span style={{
        fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 6, textAlign: 'center',
        color: ok ? '#22c55e' : '#ef4444',
        background: (ok ? '#22c55e' : '#ef4444') + '1a',
        border: `1px solid ${(ok ? '#22c55e' : '#ef4444')}44`,
      }}>
        {ok ? 'ON TRACK' : 'BEHIND'} {pct >= 0 ? '+' : ''}{pct}% vs backtest{suffix}
      </span>
    );
  };
  // Outlined "bundle" wrapper grouping a Projected box + its on-track badge.
  const bundle = (children, color = '#25405f') => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, border: `1px solid ${color}`, borderRadius: 10, padding: 10, background: '#0d0d0d' }}>
      {children}
    </div>
  );
  // The projected-vs-actual line chart (rendered once, placed per layout below).
  const chartBlock = showChart && (
    <>
      <div style={{ marginTop: 10 }}>
        <AumChart projected={projected} actual={actual} actualProjected={projection.actualProjected} />
      </div>
      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: '#888', marginTop: 2, flexWrap: 'wrap' }}>
        <span><span style={{ color: '#3b82f6' }}>━</span> Projected (backtest)</span>
        <span><span style={{ color: '#22c55e' }}>━</span> Actual (your account)</span>
        {projection.actualProjected?.length > 0 && <span><span style={{ color: '#22c55e' }}>┄</span> If you keep pace (at plan CAGR from today)</span>}
      </div>
    </>
  );
  const hasGross = current.projectedAumGross != null;
  return (
    <div style={{ position: 'relative', marginBottom: 12 }}>
      <div style={{ background: '#0d0d0d', border: '1px solid #25405f', borderRadius: 10, padding: '14px 16px', boxShadow: '0 0 0 1px rgba(59,130,246,0.08)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: hasGross ? 1 : undefined, minWidth: 0 }}>
          <div style={{ color: '#3b82f6', fontWeight: 700, fontSize: 13, letterSpacing: '0.04em' }}>
            PROJECTED vs ACTUAL AUM <span style={{ color: '#555', fontWeight: 400 }}>· backtest, pure compounding</span>
          </div>
          <div style={{ color: '#555', fontSize: 11, marginTop: 2 }}>
            Anchored {anchor?.startDate} at {fmtAum(anchor?.startAum)} · projects to {fmtAum(projection.meta?.backtestEndNav)} over ~3.5 yrs
          </div>
          <button onClick={() => setShowChart(s => !s)} style={{ marginTop: 8, background: '#161616', border: '1px solid #2a2a2a', color: '#aaa', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>
            {showChart ? '▲ Hide chart' : '▼ Show chart'}
          </button>
          {cashLedger && (
            <button onClick={() => setShowLedger(true)} style={{ marginTop: 8, marginLeft: 8, background: '#161616', border: '1px solid #2a2a2a', color: '#aaa', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>
              📒 Cash Ledger
            </button>
          )}
          {hasGross && chartBlock}
        </div>
        {/* the 2 boxes — upper right, click for table */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: current.projectedAumGross != null ? 'stretch' : 'flex-end', width: current.projectedAumGross != null ? 320 : undefined }}>
          {current.projectedAumGross != null ? (
            <>
              {bundle(box('Actual AUM', current.actualAum, '#22c55e', openActual), '#2a2a2a')}
              {bundle(<>
                {box('Projected AUM (Net)', current.projectedAum, '#3b82f6', () => setTableView('projected'))}
                {trackBadge(current.onTrackPct, ' (net)')}
              </>, '#22c55e')}
              {bundle(<>
                {box('Projected AUM (Gross)', current.projectedAumGross, '#60a5fa', () => setTableView('projectedGross'))}
                {trackBadge(current.onTrackPctGross, ' (gross)')}
              </>, '#ef4444')}
            </>
          ) : (
            <>
              {box('Projected AUM', current.projectedAum, '#3b82f6', () => setTableView('projected'))}
              {box('Actual AUM', current.actualAum, '#22c55e', openActual)}
              {trackWithPace(current.onTrackPct)}
            </>
          )}
        </div>
      </div>

      {/* Projected-vs-actual chart — right under the header / Show-chart button (Tree
          layout) so expanding it is visible immediately, not below the metric rows. */}
      {!hasGross && chartBlock}

      {/* Hedge-fund metric cards — NET row (green box) + GROSS row (red box) when gross present */}
      {projection.metrics && (projection.metricsGross ? (
        <>
          <div style={{ border: '1px solid #22c55e', borderRadius: 10, padding: '0 10px 10px', marginTop: 12 }}>
            {rowLabel('NET OF TRADING COSTS · BEFORE FUND FEES')}
            {metricTiles(projection.metrics, 'Net', true)}
          </div>
          <div style={{ border: '1px solid #ef4444', borderRadius: 10, padding: '0 10px 10px', marginTop: 10 }}>
            {rowLabel('GROSS · BEFORE TRADING COSTS')}
            {metricTiles(projection.metricsGross, 'Gross', true)}
          </div>
        </>
      ) : (
        metricTiles(projection.metrics, 'Net')
      ))}

      {/* Drawdown & risk profile (Tree only — data-gated; Ambush baseline lacks these fields) */}
      {projection.metrics?.maxMonthlyDDPct != null && riskPanel(projection.metrics)}

      {/* Context facts: backtest window, average hold time, and when live (actual) tracking began */}
      {(projection.meta?.backtestStart || projection.meta?.avgHoldDays != null || projection.meta?.actualStart) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', color: '#777', fontSize: 11, marginTop: 10, paddingTop: 8, borderTop: '1px solid #1e1e1e' }}>
          {projection.meta?.backtestStart && <span>Backtest: <b style={{ color: '#aaa' }}>{projection.meta.backtestStart} → {projection.meta.backtestEnd}</b></span>}
          {projection.meta?.avgHoldDays != null && <span>Avg hold: <b style={{ color: '#aaa' }}>{projection.meta.avgHoldDays} trading days</b> (~{(projection.meta.avgHoldDays / 5).toFixed(1)} wks · median {projection.meta.medianHoldDays})</span>}
          {projection.meta?.actualStart && <span>Live tracking since: <b style={{ color: '#22c55e' }}>{projection.meta.actualStart}</b></span>}
        </div>
      )}
      </div>

      {!hideForward && <ForwardProjection forward={projection.forward} />}

      {tableView && <AumTableModal view={tableView} projection={projection} onClose={() => setTableView(null)} />}
      {showLedger && cashLedger && <CashLedgerModal data={cashLedger} onClose={() => setShowLedger(false)} />}
      {infoMetric && (
        <div onClick={() => setInfoMetric(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#111', border: '1px solid #333', borderRadius: 10, padding: '18px 20px', maxWidth: 460, boxShadow: '0 20px 60px rgba(0,0,0,0.6)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
              <div style={{ color: '#fcf000', fontWeight: 700, fontSize: 13, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{infoMetric}</div>
              <span onClick={() => setInfoMetric(null)} style={{ cursor: 'pointer', color: '#888', fontSize: 14 }}>✕</span>
            </div>
            <div style={{ color: '#ccc', fontSize: 13, lineHeight: 1.55, marginTop: 10 }}>{METRIC_INFO[infoMetric] || 'No description available.'}</div>
            <div style={{ color: '#555', fontSize: 10, marginTop: 12, fontStyle: 'italic' }}>Backtest is survivorship-flattered and hypothetical · net of costs unless the row is labeled GROSS.</div>
          </div>
        </div>
      )}
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
  // Acknowledged directional conflicts ("It's all good") — keyed by ticker:direction,
  // persisted so a deliberate position-vs-signal divergence (e.g. an intentional
  // discretionary short) stops nagging across refreshes. A NEW conflict, or the same
  // ticker flipping to a different direction, re-alerts (the key changes).
  const [ackedConflicts, setAckedConflicts] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('pnthr_acked_conflicts') || '[]')); }
    catch { return new Set(); }
  });
  const ackConflict = (key) => setAckedConflicts(prev => {
    const next = new Set(prev); next.add(key);
    try { localStorage.setItem('pnthr_acked_conflicts', JSON.stringify([...next])); } catch { /* */ }
    return next;
  });
  // Click any ticker → open the weekly + daily chart modal (prev/next navigates the box's list).
  const [chartTickers, setChartTickers] = useState([]);
  const [chartIndex, setChartIndex] = useState(0);
  const openChart = useCallback((ticker, list) => {
    const arr = (list && list.length) ? [...new Set(list)] : [ticker];
    setChartTickers(arr);
    setChartIndex(Math.max(0, arr.indexOf(ticker)));
  }, []);
  const [showOutbox, setShowOutbox] = useState(false);
  const [showActions, setShowActions] = useState(true);
  const [showWatching, setShowWatching] = useState(true);
  const [projection, setProjection] = useState(null);
  const [reconcile, setReconcile] = useState(null); // IBKR-truth verification harness (pills + diag)
  const [scorecard, setScorecard] = useState(null); // long-vs-short scorecard (shared with Elite AI)
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
    fetchAmbushReconcile().then(setReconcile).catch(() => {});
    fetchEliteScorecard().then(setScorecard).catch(() => {});
  }, []);

  // lookup of reconcile rows by ticker for the per-row pills
  const recByTicker = {};
  (reconcile?.rows || []).forEach(r => { recByTicker[r.ticker] = r; });
  const PILL = { green: '#22c55e', yellow: '#f59e0b', red: '#ef4444', gray: '#555' };
  const copyDiag = () => {
    if (!reconcile?.diag) return;
    navigator.clipboard?.writeText(reconcile.diag).then(
      () => { try { window.__ambushDiagCopied = true; } catch {} },
      () => {}
    );
  };

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

  const handleNoReopen = async () => {
    if (!data?.config) return;
    try {
      await updateAmbushConfig({ noReopenExisting: !data.config.noReopenExisting });
      await loadData();
    } catch (err) { alert('No-Reopen toggle failed: ' + err.message); }
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
  if (loading) return <div className={styles.page}><PageHeader title="PNTHR AMBUSH V7.6" /><div className={styles.loading}>Loading Ambush data...</div></div>;
  if (error) return <div className={styles.page}><PageHeader title="PNTHR AMBUSH V7.6" /><div className={styles.error}>Error: {error}</div></div>;

  // ── Data prep ──
  const positions = data?.positions || [];
  const config = data?.config || {};
  const stats = data?.stats || {};
  const recentTrades = data?.recentTrades || [];
  const recentOrders = data?.recentOrders || [];
  const lastResult = config.lastCronResult || {};
  const actions = lastResult.actions || [];
  const watching = lastResult.watching || { longs: [], shorts: [] };
  const hunting = lastResult.hunting || []; // daily-cleared candidates (HUNTING stage)
  const huntingSet = new Set(hunting.map(h => h.ticker));
  // Persisted day's daily-trigger clears (throughput view): every name that took out
  // its 2-day trigger at any point today, with current signed distance (holdPct) to
  // its FROZEN trigger. Drives the flash/solid/dim coloring in the HUNTING box.
  const dailyClears = lastResult.dailyClears || [];
  const dailyClearMap = {};
  for (const d of dailyClears) if (d && d.ticker) dailyClearMap[d.ticker.toUpperCase()] = d;

  // ── Per-stage funnel chip coloring (Scott 2026-06-05) ────────────────────────
  // Each box colors its OWN gate; direction = green(long)/red(short):
  //   • Held position → SOLID bright + "•" (in the kill), wherever it appears.
  //   • Weekly box  → LIGHT tint (the weekly signal is live).
  //   • Daily box   → LIGHT tint if the daily trigger cleared; FAINT if not yet.
  //   • Hourly box  → BRIGHT solid once the hourly fired today (entered — kept all
  //                   day); AMBER while armed but not yet fired.
  const todayET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const NEAR_PCT = 0.005; // within 0.5% of the hourly trigger → AMBER "approaching" precursor
  const DAILY_ZONE = 0.0005; // within 0.05% of the daily trigger → "in the zone" (flashing)
  const posByTicker = {};
  for (const p of positions) posByTicker[(p.ticker || '').toUpperCase()] = p;
  // NO-REOPEN per-ticker restriction (Scott): a name is "restricted" when NO-REOPEN mode
  // is on AND its record carries exitWasManual. Restricted chips render PURPLE; right-click
  // toggles it (allow a restricted name back in, or restrict one from re-opening).
  const isRestricted = (t) => !!(config?.noReopenExisting && posByTicker[(t || '').toUpperCase()]?.exitWasManual);
  const RESTRICTED_CHIP = { bg: '#7c3aed', border: '#a78bfa', text: '#ffffff' };
  const handleToggleReopen = async (ticker) => {
    const t = (ticker || '').toUpperCase();
    const restricted = isRestricted(t);
    const msg = restricted
      ? `Allow ${t} to RE-OPEN again? (the engine may re-enter it on a fresh signal)`
      : `RESTRICT ${t} from re-opening? (it stays closed even on a fresh signal)`;
    if (!window.confirm(msg)) return;
    try { await setAmbushReopen(t, !restricted); await loadData(); }
    catch (e) { alert('Reopen toggle failed: ' + e.message); }
  };
  // nearPct per armed name (how close to its hourly trigger), from the engine.
  const nearByTicker = {};
  for (const h of hunting) if (h && h.ticker && h.nearPct != null) nearByTicker[h.ticker.toUpperCase()] = h.nearPct;
  const funnelStyle = (ticker, isLong, stage, near) => {
    const t = (ticker || '').toUpperCase();
    const p = posByTicker[t];
    const base  = isLong ? '#22c55e' : '#ef4444';
    const light = { bg: isLong ? 'rgba(34,197,94,0.16)' : 'rgba(239,68,68,0.16)', border: isLong ? 'rgba(34,197,94,0.6)' : 'rgba(239,68,68,0.6)', text: isLong ? '#86efac' : '#fca5a5' };
    const faint = { bg: isLong ? 'rgba(34,197,94,0.05)' : 'rgba(239,68,68,0.05)', border: '#2a2a2a', text: '#6b6b6b' };
    const solid = { bg: base, border: base, text: '#000' };
    const amber = { bg: '#f59e0b', border: '#f59e0b', text: '#000' };
    const held = p && (p.state === 'ACTIVE' || p.state === 'PROTECT' || (+p.totalShares || 0) !== 0);
    const firedToday = p && (p.state === 'ATTACK' || p.entryDate === todayET); // hourly fired today
    if (held) return { ...solid, held: true, label: 'in a position' };
    if (isRestricted(t)) return { ...RESTRICTED_CHIP, held: false, restricted: true, label: 'RESTRICTED from re-opening — right-click to allow' };
    if (stage === 'weekly') return { ...light, held: false, label: 'weekly signal live' };
    if (stage === 'daily')  return (huntingSet.has(t) || firedToday)
      ? { ...light, held: false, label: 'daily trigger cleared' }
      : { ...faint, held: false, label: 'daily not cleared yet' };
    // hourly: fired today → bright; armed & within 0.5% of the trigger → AMBER
    // (approaching, may fire — no guarantee); armed but still far → faint.
    if (firedToday) return { ...solid, held: false, label: 'hourly fired — entered today' };
    if (near != null && near <= NEAR_PCT) return { ...amber, held: false, label: `approaching the hourly break (${(near * 100).toFixed(2)}% away)` };
    return { ...faint, held: false, label: near != null ? `armed — ${(near * 100).toFixed(2)}% from the hourly break` : 'armed — waiting on the hourly break' };
  };
  const engChipStyle = (e) => ({
    fontSize: 12, fontWeight: 700, padding: '3px 8px', borderRadius: 5, fontFamily: 'monospace', cursor: 'pointer',
    color: e.text, background: e.bg, border: `1px solid ${e.border}`,
  });

  // ── DIRECTIONAL CONFLICT detection (Scott 2026-06-05) ────────────────────────
  // A held position whose direction is OPPOSITE its weekly/daily signal (e.g. an
  // over-sell flipped a long into a short — the D contamination). Flag it: the hourly
  // chip flashes and a banner asks for discretionary attention. Signal direction comes
  // from the weekly BL+1 (long) / SS+1 (short) lists; position direction from IBKR.
  const signalDir = {};
  for (const w of (watching.longs || [])) signalDir[(w.ticker || '').toUpperCase()] = 'LONG';
  for (const w of (watching.shorts || [])) signalDir[(w.ticker || '').toUpperCase()] = 'SHORT';
  const conflictKey = (p) => `${(p.ticker || '').toUpperCase()}:${p.direction}`;
  const dirConflicts = positions.filter(p => {
    const t = (p.ticker || '').toUpperCase();
    const held = p.state === 'ACTIVE' || p.state === 'PROTECT' || (+p.totalShares || 0) !== 0;
    return held && signalDir[t] && signalDir[t] !== p.direction && !ackedConflicts.has(conflictKey(p));
  });
  const conflictSet = new Set(dirConflicts.map(p => (p.ticker || '').toUpperCase()));

  const byState = {
    STALKING: positions.filter(p => p.state === 'STALKING'),
    ATTACK:   positions.filter(p => p.state === 'ATTACK'),
    ACTIVE:   positions.filter(p => p.state === 'ACTIVE'),
    PROTECT:  positions.filter(p => p.state === 'PROTECT'),
  };

  // Order live positions by URGENCY (Scott 2026-06-05): most urgent reconcile
  // severity at the top (red → amber → green → gray), and within each tier the
  // least-profitable first — so names needing attention are top-burner and the
  // ones doing great sit at the bottom. recByTicker is the IBKR-truth reconcile.
  const sevRank = { red: 0, yellow: 1, amber: 1, green: 2, gray: 3 };
  const openPnlOf = (p) => {
    if (!p.avgCost || !p.livePrice || !p.totalShares) return 0;
    return p.direction === 'LONG'
      ? (p.livePrice - p.avgCost) * p.totalShares
      : (p.avgCost - p.livePrice) * p.totalShares;
  };
  const byUrgency = (a, b) => {
    const ra = sevRank[recByTicker[a.ticker]?.rollup] ?? 3;
    const rb = sevRank[recByTicker[b.ticker]?.rollup] ?? 3;
    if (ra !== rb) return ra - rb;          // red first, green last
    return openPnlOf(a) - openPnlOf(b);     // least profitable first within a tier
  };
  byState.ACTIVE.sort(byUrgency);
  byState.PROTECT.sort(byUrgency);

  const livePositions = [...byState.PROTECT, ...byState.ACTIVE]; // PROTECT first (more important)

  // Live total: current unrealized P&L across all open positions (refreshes each 60s poll).
  // Net of estimated entry commission so it tracks IBKR's "Unrealized" (which bakes the
  // entry commission into avg cost). Prices are the FMP 60s feed, so this follows IBKR
  // closely but not to the penny — an exact tie needs the live IBKR per-position sync.
  const totalOpenPnl = livePositions.reduce((s, p) => {
    if (!p.avgCost || !p.livePrice || !p.totalShares) return s;
    const gross = p.direction === 'LONG'
      ? (p.livePrice - p.avgCost) * p.totalShares
      : (p.avgCost - p.livePrice) * p.totalShares;
    const entryComm = Math.max(1, p.totalShares * 0.005); // ~IBKR commission baked into avg cost
    return s + gross - entryComm;
  }, 0);

  const nav = lastResult.nav || config.nav || 83000;
  const navSource = lastResult.navSource || 'config';
  const sizingTier = lastResult.sizingTier || getSizingTier(nav);
  const sizingMult = lastResult.sizingMultiplier || (nav >= GRAD_TIER_2 ? 1.0 : nav >= GRAD_TIER_1 ? 0.75 : 0.50);

  // Reusable live-positions table — renders the SAME detailed table for both the
  // DEVOUR (ACTIVE) and PROTECT boxes so they're identical. boxPnl = this box's own
  // open-P&L subtotal (shown in the header).
  const renderPositionsTable = (posList, label, color, infoText) => {
    const boxPnl = posList.reduce((s, p) => {
      if (!p.avgCost || !p.livePrice || !p.totalShares) return s;
      const gross = p.direction === 'LONG'
        ? (p.livePrice - p.avgCost) * p.totalShares
        : (p.avgCost - p.livePrice) * p.totalShares;
      return s + gross - Math.max(1, p.totalShares * 0.005);
    }, 0);
    return (
      <div className={styles.section} style={{ borderLeftColor: color }}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>
            {label}
            <InfoPopup text={infoText} wide />
          </span>
          <div className={styles.sectionBadges}>
            <span style={{ color }}>{label} {posList.length}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: boxPnl >= 0 ? '#22c55e' : '#ef4444' }}>
              {boxPnl >= 0 ? '+' : ''}{fmtUsd(boxPnl)} open
            </span>
          </div>
        </div>
        {posList.length === 0 ? (
          <div className={styles.emptyState}>No {label.toLowerCase()} positions</div>
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
                  <th style={{ textAlign: 'right' }}>Shares <InfoPopup text="Current filled shares / total planned at L5." /></th>
                  <th style={{ textAlign: 'right' }}>Stop <InfoPopup text="Current 2-bar trailing stop (lowest low of the last 2 completed hourly bars - $0.01 for LONG)." wide /></th>
                  <th style={{ textAlign: 'right' }}>1H Exit <InfoPopup text="First-hour low (LONG) / high (SHORT) — the disaster floor." /></th>
                  <th style={{ textAlign: 'right' }}>Wk Trig <InfoPopup text="Weekly Trigger: the frozen weekly BL/SS breakout entry level." wide /></th>
                  <th style={{ textAlign: 'right' }}>Dy Trig <InfoPopup text="Daily Trigger: the frozen original 2-day breakout level." wide /></th>
                  <th style={{ textAlign: 'right' }}>Risk $ <InfoPopup text="Max loss if stopped now: (avg cost - stop) x shares." /></th>
                  <th style={{ textAlign: 'right' }}>RPS</th>
                  <th>Lots</th>
                  <th style={{ textAlign: 'right' }}>Peak P&L</th>
                  <th>Cycle</th>
                  <th>Date</th>
                  <th></th>
                </tr>
              </thead>
              {posList.map(pos => {
                const total = totalPlannedShares(pos);
                const risk = computeRisk(pos);
                const rps = computeRps(pos);
                const exitLevel = pos.direction === 'LONG' ? pos.todayFirstHourLow : pos.todayFirstHourHigh;
                const isExpanded = expanded[pos.ticker];
                return (
                  <tbody key={pos.ticker} className={styles.positionGroup}>
                    <tr className={styles.positionRow} onClick={() => toggleExpand(pos.ticker)} style={{ cursor: 'pointer', borderLeftColor: STATE_COLORS[pos.state] }}>
                      <td><StateBadge state={pos.state} /></td>
                      <td className={styles.tickerCell} onClick={(e) => { e.stopPropagation(); openChart(pos.ticker, posList.map(p => p.ticker)); }} title="click for charts" style={{ cursor: 'pointer' }}>
                        {(() => {
                          const rec = recByTicker[pos.ticker];
                          const color = rec ? PILL[rec.rollup] : PILL.gray;
                          const tip = rec
                            ? (rec.reasons?.length ? 'CHECK: ' + rec.reasons.join('  •  ') : 'CHECK: all green — IBKR-verified (dir, shares, avg, stop level+side+qty, cap, risk)')
                            : 'CHECK: no verification data yet';
                          return (<span title={tip} style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: color, marginRight: 6, verticalAlign: 'middle', boxShadow: rec?.rollup === 'red' ? `0 0 5px ${color}` : 'none' }} />);
                        })()}
                        {pos.ticker}
                      </td>
                      <td><DirBadge direction={pos.direction} /></td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{fmtUsd(pos.entryPrice)}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{fmtUsd(pos.avgCost)}</td>
                      <td style={{ textAlign: 'right' }}><span style={{ fontWeight: 600 }}>{pos.totalShares || 0}</span><span style={{ color: '#555' }}> / {total}</span></td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace', color: '#ef4444' }}>{fmtUsd(pos.stop)}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace', color: exitLevel ? '#f59e0b' : '#444' }}>{fmtUsd(exitLevel)}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace', color: pos.weeklyTrigger != null ? '#a78bfa' : '#444' }}>{pos.weeklyTrigger != null ? fmtUsd(pos.weeklyTrigger) : '--'}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace', color: pos.dailyTrigger != null ? '#60a5fa' : '#444' }}>{pos.dailyTrigger != null ? fmtUsd(pos.dailyTrigger) : '--'}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace', color: risk > 200 ? '#ef4444' : '#ccc' }}>{risk != null ? fmtUsd(risk) : '--'}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace', color: '#888' }}>{rps != null ? fmtUsd(rps) : '--'}</td>
                      <td><span className={styles.lotsBadge}>{lotsLabel(pos)}</span></td>
                      <td style={{ textAlign: 'right' }}>{pos.atBE ? <span style={{ color: '#3b82f6', fontWeight: 600, fontSize: 11 }} title="2-bar trailing exit active from entry">TRAIL ✓</span> : fmtPnl(pos.peak)}</td>
                      <td style={{ color: '#888', fontSize: 11 }}>{pos.cycleNum > 0 ? `#${pos.cycleNum + 1}` : '--'}</td>
                      <td style={{ color: '#666', fontSize: 11 }}>{pos.entryDate || '--'}</td>
                      <td>{isAdmin && (<button className={styles.removeBtn} onClick={(e) => { e.stopPropagation(); handleRemove(pos.ticker); }} title="Remove position">x</button>)}</td>
                    </tr>
                    {isExpanded && (<tr className={styles.detailRow}><td colSpan={15} style={{ padding: 0 }}><LotDetail pos={pos} /></td></tr>)}
                  </tbody>
                );
              })}
            </table>
          </div>
        )}
      </div>
    );
  };

  // ── Render ──
  return (
    <div className={styles.page}>
      <PageHeader title="PNTHR AMBUSH V7.6" />

      {config.noReopenExisting && (
        <div style={{ margin: '0 0 10px', padding: '8px 14px', background: '#3a2708', border: '2px solid #f59e0b', borderRadius: 8, color: '#fbbf24', fontWeight: 700, fontSize: 13 }}>
          🟠 NO-REOPEN MODE — names you MANUALLY close (in TWS) will NOT re-open. Stop-outs and brand-new entries still work normally. Click "NO REOPEN: ON" to turn it off.
        </div>
      )}

      {/* ═══ STATUS BAR ═══ */}
      <div className={styles.statusBar}>
        <div className={styles.statusTop}>
          <button
            className={styles.toggleBtn}
            onClick={handleToggle}
            title={config.enabled ? 'Engine is LIVE — click to STOP' : 'Engine is OFF — click to GO LIVE'}
            style={{
              background: config.enabled ? '#16a34a' : '#7f1d1d',
              color: '#fff',
              border: config.enabled ? '2px solid #22c55e' : '2px solid #ef4444',
              boxShadow: config.enabled ? '0 0 10px rgba(34,197,94,0.55)' : 'none',
              fontWeight: 800,
              letterSpacing: '0.08em',
              minWidth: 96,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
            }}
          >
            <span style={{ fontSize: 9 }}>{config.enabled ? '🟢' : '🔴'}</span>
            {config.enabled ? 'LIVE' : 'OFF — CLICK TO GO LIVE'}
          </button>

          <button
            onClick={handleNoReopen}
            title={config.noReopenExisting
              ? 'NO-REOPEN is ON — names you MANUALLY close (in TWS) will NOT re-open. Stop-outs and brand-new names are unaffected. Click to turn off.'
              : 'Turn ON so names you MANUALLY close (in TWS) do NOT re-open. Stop-outs and new entries keep working normally.'}
            style={{
              background: config.noReopenExisting ? '#b45309' : '#1a1a1a',
              color: config.noReopenExisting ? '#fff' : '#bbb',
              border: `2px solid ${config.noReopenExisting ? '#f59e0b' : '#3a3a3a'}`,
              boxShadow: config.noReopenExisting ? '0 0 10px rgba(245,158,11,0.6)' : 'none',
              fontWeight: 800, letterSpacing: '0.04em', borderRadius: 6, padding: '6px 12px',
              fontSize: 12, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            <span style={{ fontSize: 9 }}>{config.noReopenExisting ? '🟠' : '⚪'}</span>
            {config.noReopenExisting ? 'NO REOPEN: ON' : 'NO REOPEN EXISTING'}
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

          {/* Verified engine-health status (NOT a clock): TRADING only shows if the
              engine actually ticked in the last ~2.5 min — a stalled engine goes red. */}
          {(() => {
            const tickAgeMs = config.lastCronRun ? Date.now() - new Date(config.lastCronRun).getTime() : Infinity;
            const fresh = tickAgeMs < 150000; // engine ticks every 60s; <2.5 min = alive
            const firstHour = lastResult?.isFirstHour;
            let cls, label, title;
            if (!config.enabled) { cls = styles.statusOff; label = '○ OFF'; title = 'Engine is OFF — toggle it LIVE to run'; }
            else if (!fresh) { cls = styles.statusStalled; label = '● STALLED'; title = `Engine not ticking (last tick ${config.lastCronRun ? Math.round(tickAgeMs/1000)+'s ago' : 'never'}). NOT trading — check the server/cron.`; }
            else if (firstHour) { cls = styles.statusCapturing; label = '● CAPTURING'; title = 'Engine is LIVE and building the first-hour opening ranges. Entries begin after 10:30 ET.'; }
            else { cls = styles.statusTrading; label = '● TRADING'; title = 'Verified: engine is LIVE, ticking, and running entry logic (past 10:30 ET).'; }
            return <span className={`${styles.engineStatus} ${cls}`} title={title}>{label}</span>;
          })()}
          {config.lastCronRun && (
            <span className={styles.lastTick}>
              Last tick: {new Date(config.lastCronRun).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              {lastResult.priceSource && <span style={{ color: '#444', marginLeft: 6 }}>({lastResult.priceSource})</span>}
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
          The engine is already sizing off ${Number(lastResult.withdrawalAlert.tradingNav).toLocaleString()} (V7.6 rule). Wire the $1M out to stay on the model.
        </div>
      )}

      {/* ═══ FLOW INDICATOR ═══ */}
      <div className={styles.flowRow}>
        {[
          { key: 'STALKING', count: watching.longs.length + watching.shorts.length },
          { key: 'HUNTING',  count: hunting.length },
          { key: 'ATTACK',   count: byState.ATTACK.length },
          { key: 'DEVOUR',   count: byState.ACTIVE.length },
          { key: 'STILL HUNGRY', count: byState.STALKING.length },
          { key: 'PROTECT',  count: byState.PROTECT.length },
        ].map((s, i) => (
          <div key={s.key} className={styles.flowItem}>
            {i > 0 && <span className={styles.flowArrow}>{'→'}</span>}
            <span style={{ color: STATE_COLORS[s.key], fontWeight: 700, fontSize: 13 }}>{s.key}</span>
            <span className={styles.flowCount} style={{ background: STATE_COLORS[s.key], color: '#000' }}>
              {s.count}
            </span>
            <InfoPopup text={PHASE_INFO[s.key]} wide />
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

      {/* ═══ DIRECTIONAL CONFLICT — position opposite its signal (Scott 2026-06-05) ═══ */}
      <style>{`@keyframes pnthrConflictFlash { 0%,100% { opacity: 1; box-shadow: 0 0 0 0 rgba(251,191,36,0); } 50% { opacity: 0.5; box-shadow: 0 0 9px 2px rgba(251,191,36,0.9); } }
@keyframes pnthrDailyFlashLong { 0%,100% { opacity: 1; box-shadow: 0 0 0 0 rgba(34,197,94,0); } 50% { opacity: 0.4; box-shadow: 0 0 11px 2px rgba(34,197,94,0.9); } }
@keyframes pnthrDailyFlashShort { 0%,100% { opacity: 1; box-shadow: 0 0 0 0 rgba(239,68,68,0); } 50% { opacity: 0.4; box-shadow: 0 0 11px 2px rgba(239,68,68,0.9); } }`}</style>
      {dirConflicts.length > 0 && (
        <div style={{ margin: '0 0 12px', padding: '10px 14px', background: '#2a1c0a', border: '2px solid #fbbf24', borderRadius: 8, animation: 'pnthrConflictFlash 1.1s ease-in-out infinite' }}>
          <div style={{ fontWeight: 800, color: '#fbbf24', letterSpacing: 0.4, marginBottom: 4 }}>⚠ DIRECTIONAL CONFLICT — {dirConflicts.length} NEED ATTENTION</div>
          {dirConflicts.map(p => (
            <div key={p.ticker} style={{ fontSize: 12, color: '#f0d090', padding: '3px 0', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ flex: 1 }}><b style={{ color: '#fff' }}>{p.ticker}</b> — position is <b>{p.direction}</b> but the signal is <b>{signalDir[(p.ticker || '').toUpperCase()]}</b>. Discretionary review.</span>
              <button onClick={() => ackConflict(conflictKey(p))} title="Dismiss this conflict (you've vetted it). It re-alerts only if the position flips direction." style={{ background: '#1f3a24', color: '#4ade80', border: '1px solid #2f6e3f', borderRadius: 5, padding: '3px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>It's all good</button>
            </div>
          ))}
        </div>
      )}

      {/* ═══ WATCHING — today's BL+1 / SS+1 candidates ═══ */}
      <div className={styles.section}>
        <div className={styles.sectionHeader} onClick={() => setShowWatching(!showWatching)} style={{ cursor: 'pointer' }}>
          <span className={styles.sectionTitle}>
            ① STALKING: Weekly BL+1 / SS+1 Candidates
            <InfoPopup text="Top of the funnel: every AI-300 name with an active weekly BL+1 (long) or SS+1 (short) signal — the prey pool, so all chips carry a LIGHT direction tint (green long / red short). SOLID + • = a live position. These names flow down to the DAILY box. The engine recomputes every 60s." wide />
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
              <WatchCol title="BL+1 LONGS" color="#22c55e" items={watching.longs} eng={(t) => funnelStyle(t, true, 'weekly')} chipStyle={engChipStyle} onTicker={(t) => openChart(t, [...watching.longs, ...watching.shorts].map(x => x.ticker))} onRightClick={handleToggleReopen} />
              <WatchCol title="SS+1 SHORTS" color="#ef4444" items={watching.shorts} eng={(t) => funnelStyle(t, false, 'weekly')} chipStyle={engChipStyle} onTicker={(t) => openChart(t, [...watching.longs, ...watching.shorts].map(x => x.ticker))} onRightClick={handleToggleReopen} />
            </div>
          )
        )}
      </div>

      {/* ═══ ② DAILY — daily trigger fired (green) / waiting (grey) ═══ */}
      {(() => {
        const longs = watching.longs, shorts = watching.shorts;
        // THROUGHPUT (2026-06-10, Scott): a name "cleared today" if it's in the
        // persisted dailyClears set (took out its 2-day trigger at ANY point today).
        // It stays here all day; its look tracks current price vs the FROZEN trigger:
        //   solid  = holding beyond the 0.05% zone in its direction
        //   flash  = within 0.05% of the trigger (in the zone)
        //   dim    = pulled back past the trigger to the wrong side (breakout lost)
        const cleared = (it) => !!dailyClearMap[(it.ticker || '').toUpperCase()];
        const dailyChip = (it, isLong) => {
          const t = (it.ticker || '').toUpperCase();
          const dc = dailyClearMap[t];
          const p = posByTicker[t];
          const isHeld = !!(p && (p.state === 'ACTIVE' || p.state === 'PROTECT' || (+p.totalShares || 0) !== 0));
          const baseC = isLong ? '#22c55e' : '#ef4444';
          const faint = { bg: isLong ? 'rgba(34,197,94,0.05)' : 'rgba(239,68,68,0.05)', border: '#2a2a2a', text: '#6b6b6b' };
          const dim   = { bg: isLong ? 'rgba(34,197,94,0.10)' : 'rgba(239,68,68,0.10)', border: isLong ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.4)', text: isLong ? 'rgba(134,239,172,0.75)' : 'rgba(252,165,165,0.75)' };
          const solid = { bg: baseC, border: baseC, text: '#000' };
          let e, flash = false;
          if (!dc) {
            e = isHeld ? { ...solid, label: 'in a position' } : { ...faint, label: 'daily not cleared today' };
          } else {
            const hp = dc.holdPct;
            if (hp == null)             e = { ...solid, label: 'daily cleared today' };
            else if (hp > DAILY_ZONE)   e = { ...solid, label: `holding the breakout (+${(hp * 100).toFixed(2)}% past trigger)` };
            else if (hp >= -DAILY_ZONE) { e = { ...solid, label: `in the trigger zone (${(hp * 100).toFixed(2)}% from trigger)` }; flash = true; }
            else                        e = { ...dim, label: `pulled back past the trigger (${(hp * 100).toFixed(2)}%)` };
          }
          if (!isHeld && isRestricted(t)) { e = { ...RESTRICTED_CHIP, label: 'RESTRICTED from re-opening — right-click to allow' }; flash = false; }
          const style = { ...engChipStyle(e) };
          if (flash) style.animation = `${isLong ? 'pnthrDailyFlashLong' : 'pnthrDailyFlashShort'} 1s ease-in-out infinite`;
          return (
            <span key={it.ticker}
              onClick={() => openChart(it.ticker, [...longs, ...shorts].map(x => x.ticker))}
              onContextMenu={(ev) => { ev.preventDefault(); handleToggleReopen(it.ticker); }}
              title={`${e.label} · click to chart · right-click to ${isRestricted(t) ? 'ALLOW re-open' : 'RESTRICT re-open'}`} style={style}>
              {it.ticker}{isHeld ? ' •' : ''}
            </span>
          );
        };
        const lFired = longs.filter(cleared).length, sFired = shorts.filter(cleared).length;
        return (
          <div className={styles.section} style={{ borderLeftColor: '#f59e0b' }}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionTitle}>
                ② HUNTING: Cleared the Daily Trigger
                <InfoPopup text="Throughput view: every name that took out its prior 2-day trigger at ANY point today, kept here all day. SOLID green/red = holding beyond the trigger (more than 0.05% in its direction). FLASHING = sitting in the trigger zone (within 0.05%). DIM = triggered earlier today but pulled back past the trigger. FAINT = hasn't cleared today. • = a live position. Green = long, red = short." wide />
              </span>
              <div className={styles.sectionBadges}>
                <span style={{ color: '#22c55e' }}>CLEARED {lFired + sFired}</span>
                <span style={{ color: '#888' }}>WAITING {longs.length + shorts.length - lFired - sFired}</span>
              </div>
            </div>
            {(longs.length === 0 && shorts.length === 0) ? (
              <div className={styles.emptyState}>No weekly candidates yet — appears once the engine ticks.</div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, padding: '10px 14px' }}>
                <div style={{ minWidth: 220 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#22c55e', marginBottom: 8 }}>LONGS · {lFired}/{longs.length} cleared today</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{longs.length ? longs.map(it => dailyChip(it, true)) : <span style={{ color: '#555', fontSize: 12 }}>none</span>}</div>
                </div>
                <div style={{ minWidth: 220 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#ef4444', marginBottom: 8 }}>SHORTS · {sFired}/{shorts.length} cleared today</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{shorts.length ? shorts.map(it => dailyChip(it, false)) : <span style={{ color: '#555', fontSize: 12 }}>none</span>}</div>
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* ═══ ③ HOURLY — broke the hourly bar (green) / waiting (grey) ═══ */}
      {(() => {
        // Population = daily-cleared candidates (armed) + any name that fired/entered
        // TODAY (kept in this box all day, per Scott 2026-06-05), deduped by ticker.
        const hourlyMap = {};
        for (const h of hunting) hourlyMap[(h.ticker || '').toUpperCase()] = { ticker: h.ticker, direction: h.direction };
        for (const p of positions.filter(p => p.entryDate === todayET)) hourlyMap[(p.ticker || '').toUpperCase()] = { ticker: p.ticker, direction: p.direction };
        const armed = Object.values(hourlyMap);
        const isFired = (tk) => { const p = posByTicker[(tk || '').toUpperCase()]; return !!(p && (p.state === 'ACTIVE' || p.state === 'PROTECT' || (+p.totalShares || 0) !== 0 || p.state === 'ATTACK' || p.entryDate === todayET)); };
        const firedCount = armed.filter(a => isFired(a.ticker)).length;
        const hourlyChip = (it) => {
          const t = (it.ticker || '').toUpperCase();
          const e = funnelStyle(it.ticker, it.direction === 'LONG', 'hourly');
          const conflict = conflictSet.has(t);
          const style = { ...engChipStyle(e) };
          if (conflict) { style.animation = 'pnthrConflictFlash 0.9s ease-in-out infinite'; style.border = '2px solid #fbbf24'; }
          return (
            <span key={it.ticker}
              onClick={() => openChart(it.ticker, armed.map(h => h.ticker))}
              onContextMenu={(ev) => { ev.preventDefault(); handleToggleReopen(it.ticker); }}
              title={conflict ? `⚠ DIRECTION CONFLICT — position is ${it.direction} but the signal is ${signalDir[t]}. Needs attention.` : `${e.label} · click to chart · right-click to ${isRestricted(t) ? 'ALLOW re-open' : 'RESTRICT re-open'}`} style={style}>
              {it.ticker}{conflict ? ' ⚠' : (e.held ? ' •' : '')}
            </span>
          );
        };
        return (
          <div className={styles.section} style={{ borderLeftColor: STATE_COLORS.ATTACK }}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionTitle}>
                ③ ATTACK: The Hourly Breakout / Entering
                <InfoPopup text="The daily-cleared names, watched every 60s for the 1-bar hourly break. AMBER = armed, waiting for the break. BRIGHT green/red = the hourly fired today (the pounce) — it entered and stays here all day so you can see what triggered. SOLID + • = still a live position. Direction sets the color: green long, red short." wide />
              </span>
              <div className={styles.sectionBadges}>
                <span style={{ color: '#22c55e' }}>FIRED {firedCount}</span>
                <span style={{ color: '#f59e0b' }}>ARMED {armed.length - firedCount}</span>
              </div>
            </div>
            {armed.length === 0 ? (
              <div className={styles.emptyState}>No names armed for the hourly break yet (a name appears here once its daily trigger fires).</div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '10px 14px' }}>
                {armed.map(hourlyChip)}
              </div>
            )}
          </div>
        );
      })()}

      <LongShortScorecard scorecard={scorecard} />

      {/* ═══ DEVOUR — live positions (the kill, stop still below entry) ═══ */}
      <div className={styles.section} style={{ borderLeftColor: STATE_COLORS.ACTIVE }}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>
            ④ DEVOUR: Live Positions
            <InfoPopup text="The kill — live positions the engine is in. Stop is the 2-bar trailing level (still below entry). When the stop ratchets to breakeven-or-better, the position graduates to the PROTECT box below. Click a row for the lot plan and trailing detail." wide />
          </span>
          <div className={styles.sectionBadges}>
            <span style={{ color: STATE_COLORS.ACTIVE }}>DEVOUR {byState.ACTIVE.length}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: totalOpenPnl >= 0 ? '#22c55e' : '#ef4444' }}>{totalOpenPnl >= 0 ? '+' : ''}{fmtUsd(totalOpenPnl)} open (all)</span>
          </div>
        </div>

        {/* ═══ IBKR-truth verification bar: snapshot health + pill summary + Copy-Diag ═══ */}
        {reconcile && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', margin: '0 0 10px', padding: '6px 10px', background: '#16161c', border: '1px solid #2a2a33', borderRadius: 6, fontSize: 12 }}>
            <span title={reconcile.snapHealth?.reason || 'IBKR snapshot is fresh and non-empty'} style={{ color: PILL[reconcile.snapHealth?.status] || PILL.gray, fontWeight: 700 }}>
              ● IBKR snapshot: {reconcile.snapHealth?.status === 'green' ? 'healthy' : (reconcile.snapHealth?.reason || reconcile.snapHealth?.status || 'unknown')}
              {reconcile.snapAgeMin != null ? ` (${reconcile.snapAgeMin}m)` : ''}
            </span>
            <span style={{ color: '#888' }}>|</span>
            <span style={{ color: PILL.green, fontWeight: 700 }}>{reconcile.summary?.green || 0} green</span>
            <span style={{ color: PILL.yellow, fontWeight: 700 }}>{reconcile.summary?.yellow || 0} amber</span>
            <span style={{ color: PILL.red, fontWeight: 700 }}>{reconcile.summary?.red || 0} red</span>
            <span style={{ flex: 1 }} />
            <button
              onClick={copyDiag}
              style={{ background: '#2a2a33', color: '#d4d4dc', border: '1px solid #3a3a44', borderRadius: 5, padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
              title="Copy the full IBKR-truth diagnostic (every red/amber position + reason) to paste to Claude"
            >Copy Diag</button>
          </div>
        )}

        {/* ═══ ISSUES summary — every discrepancy at a glance, no need to open rows ═══ */}
        {reconcile && (() => {
          const problems = (reconcile.rows || [])
            .filter(r => r.rollup === 'red' || r.rollup === 'yellow')
            .sort((a, b) => (a.rollup === 'red' ? 0 : 1) - (b.rollup === 'red' ? 0 : 1));
          if (!(reconcile.rows || []).length) return null;
          if (!problems.length) return (
            <div style={{ margin: '0 0 12px', padding: '8px 12px', background: '#0f1a12', border: '1px solid #1f3a24', borderRadius: 6, fontSize: 12, color: PILL.green, fontWeight: 700 }}>
              ✓ All {reconcile.rows.length} positions verified against IBKR — no discrepancies.
            </div>
          );
          return (
            <div style={{ margin: '0 0 12px', padding: '8px 12px', background: '#1c1214', border: '1px solid #4a2230', borderRadius: 6, fontSize: 12 }}>
              <div style={{ fontWeight: 800, color: PILL.red, marginBottom: 6, letterSpacing: 0.4 }}>⚠ {problems.length} NEED ATTENTION</div>
              {problems.map(r => {
                const reasons = (r.reasons || []).map(x => x.replace(/^[a-zA-Z]+:\s*/, ''));
                return (
                  <div key={r.ticker} style={{ display: 'flex', gap: 8, padding: '3px 0', borderTop: '1px solid #2a1a1e', alignItems: 'baseline' }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: PILL[r.rollup], display: 'inline-block', flexShrink: 0, marginTop: 4 }} />
                    <span style={{ fontWeight: 700, color: '#fff', minWidth: 52 }}>{r.ticker}</span>
                    <span style={{ color: '#9a9aa6', minWidth: 78, flexShrink: 0 }}>{r.direction} {Math.abs(r.ibkrShares ?? r.engineShares ?? 0)}</span>
                    <span style={{ color: r.rollup === 'red' ? '#ffb4b4' : '#f0d090' }}>{reasons.join('  ·  ') || 'see row'}</span>
                  </div>
                );
              })}
            </div>
          );
        })()}

        {byState.ACTIVE.length === 0 ? (
          <div className={styles.emptyState}>No positions in DEVOUR</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {byState.ACTIVE.map(pos => (
              <LadderCard
                key={pos.ticker}
                pos={pos}
                rec={recByTicker[pos.ticker]}
                allTickers={byState.ACTIVE.map(p => p.ticker)}
                onChart={openChart}
                onRemove={handleRemove}
                isAdmin={isAdmin}
                PILL={PILL}
              />
            ))}
          </div>
        )}
      </div>

      {/* ═══ ⑤ PROTECT — break-even-or-better, moved up so secured kills stay with the live book ═══ */}
      {renderPositionsTable(
        byState.PROTECT,
        '⑤ PROTECT: Break-Even or Better',
        STATE_COLORS.PROTECT,
        "The kill is secured: the 2-bar trailing stop has ratcheted to break-even-or-better, so these positions can no longer turn into a loss. Same detail as DEVOUR — click a row for the lot plan and trailing status."
      )}

      {/* ═══ ⑥ STILL HUNGRY — Re-entry Watch ═══ */}
      <div className={styles.section} style={{ borderLeftColor: STATE_COLORS.STALKING }}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>
            ⑥ STILL HUNGRY: Re-Entry Watch
            <InfoPopup text="The panther's still hungry: names that were exited or manually closed and are hunting another bite of the SAME stock. Re-entry needs price to hold above BOTH the Weekly Trigger and the Daily Trigger (green) plus a fresh 1-bar break — the columns below show those levels (green = eligible side, red = sold off past it). No cooldown: if the setup re-lines-up, it re-enters." wide />
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
                  <th style={{ textAlign: 'right' }}>Wk Trig <InfoPopup text="Weekly Trigger (frozen breakout entry). Green = current price is on the eligible side; red = sold off past it. Re-entry needs price ABOVE this (long) / BELOW (short)." wide /></th>
                  <th style={{ textAlign: 'right' }}>Dy Trig <InfoPopup text="Daily Trigger (frozen original 2-day breakout). Green = eligible side; red = sold off past it. Re-entry needs price ABOVE this (long) / BELOW (short). Re-entry requires BOTH green + the 1-bar break." wide /></th>
                  <th>Last Bar</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {byState.STALKING.map(pos => {
                  const estStop = pos.direction === 'LONG'
                    ? pos.runningLow ? +(pos.runningLow - 0.01).toFixed(2) : null
                    : pos.runningHigh ? +(pos.runningHigh + 0.01).toFixed(2) : null;
                  // Re-entry eligibility per trigger: green = price on the eligible side.
                  const lp = pos.livePrice;
                  const wkOk = pos.weeklyTrigger == null || lp == null || (pos.direction === 'LONG' ? lp >= pos.weeklyTrigger : lp <= pos.weeklyTrigger);
                  const dyOk = pos.dailyTrigger == null || lp == null || (pos.direction === 'LONG' ? lp >= pos.dailyTrigger : lp <= pos.dailyTrigger);
                  return (
                    <tr key={pos.ticker} style={{ borderLeftColor: STATE_COLORS.STALKING }}>
                      <td className={styles.tickerCell} onClick={() => openChart(pos.ticker, byState.STALKING.map(p => p.ticker))} title="click for charts" style={{ cursor: 'pointer' }}>{pos.ticker}</td>
                      <td><DirBadge direction={pos.direction} /></td>
                      <td style={{ color: '#a78bfa' }}>#{(pos.cycleNum || 0) + 1}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{pos.direction === 'LONG' ? fmtUsd(pos.runningLow) : <span style={{ color: '#444' }}>--</span>}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{pos.direction === 'SHORT' ? fmtUsd(pos.runningHigh) : <span style={{ color: '#444' }}>--</span>}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace', color: '#ef4444' }}>{estStop ? fmtUsd(estStop) : '--'}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace', color: pos.weeklyTrigger == null ? '#444' : wkOk ? '#22c55e' : '#ef4444' }}>{pos.weeklyTrigger != null ? fmtUsd(pos.weeklyTrigger) : '--'}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace', color: pos.dailyTrigger == null ? '#444' : dyOk ? '#22c55e' : '#ef4444' }}>{pos.dailyTrigger != null ? fmtUsd(pos.dailyTrigger) : '--'}</td>
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

      {chartTickers.length > 0 && (
        <AiTickerChartModal
          tickers={chartTickers}
          initialIndex={chartIndex}
          onClose={() => setChartTickers([])}
        />
      )}
    </div>
  );
}
