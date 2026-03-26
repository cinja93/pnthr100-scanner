// client/src/components/ClosedTradeCards.jsx
// ── PNTHR Journal v3 — Card-Based Closed Trade Layout ────────────────────────
// Replaces the 42-column horizontal spreadsheet (ScorecardGrid) with vertically
// stacked trade cards. No horizontal scrolling. 7 sections per card.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback } from 'react';
import { API_BASE, authHeaders } from '../services/api';

// ── Formatting helpers ────────────────────────────────────────────────────────
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt)) return '—';
  return `${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${String(dt.getUTCDate()).padStart(2, '0')}/${dt.getUTCFullYear()}`;
}
function fmtDollar(n) {
  if (n == null) return '—';
  return `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtNum(n, dec = 2) { return n != null ? n.toFixed(dec) : '—'; }
function fmtVol(n) {
  if (n == null) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}

function calendarDaysBetween(from, to) {
  if (!from || !to) return null;
  return Math.max(0, Math.round((new Date(to) - new Date(from)) / 86400000));
}
function tradingDaysBetween(from, to) {
  if (!from || !to) return null;
  let count = 0;
  const d = new Date(from), end = new Date(to);
  while (d < end) { d.setDate(d.getDate() + 1); const dw = d.getDay(); if (dw > 0 && dw < 6) count++; }
  return count;
}

// ── Score badge color (background color for colored badge) ───────────────────
function getScoreColor(score) {
  if (score == null) return '#333';
  if (score >= 90) return '#28a745';  // ELITE
  if (score >= 75) return '#FFD700';  // STRONG
  if (score >= 60) return '#fd7e14';  // MODERATE
  if (score >= 40) return '#c9a227';  // WEAK (muted gold)
  return '#dc3545';                   // SYSTEM OVERRIDE
}
function getScoreTextColor(score) {
  // Dark text on bright backgrounds, light text on dark/red
  if (score == null) return '#888';
  if (score >= 40) return '#000';
  return '#fff';
}

// ── Tier box colors ───────────────────────────────────────────────────────────
function tierBoxStyle(total, max) {
  const pct = max ? (total / max) : 0;
  if (pct >= 0.90) return { bg: 'rgba(40,167,69,0.10)', border: '#28a745', text: '#28a745' };
  if (pct >= 0.70) return { bg: 'rgba(255,215,0,0.08)',  border: '#D4A017', text: '#FFD700' };
  if (pct >= 0.50) return { bg: 'rgba(253,126,20,0.09)', border: '#fd7e14', text: '#fd7e14' };
  return { bg: 'rgba(220,53,69,0.10)', border: '#dc3545', text: '#dc3545' };
}

// ── Discipline checks (mirrors ScorecardGrid computeChecks) ───────────────────
function computeChecks(entry) {
  const dir        = entry.direction || 'LONG';
  const snapE      = entry.marketAtEntry || {};
  const exits      = Array.isArray(entry.exits) ? entry.exits : [];
  const lastExit   = exits[exits.length - 1];
  const exitReason = lastExit?.reason || null;
  const entryPrice = entry.entry?.fillPrice ?? entry.entryPrice ?? null;
  const stopPrice  = entry.entry?.stopPrice ?? null;
  const nav        = entry.navAtEntry ?? null;
  const isETF      = entry.isETF || false;
  const lots       = Array.isArray(entry.lots) ? entry.lots : [];
  const lot1Shares = lots[0]?.shares ?? null;
  const mfePrice   = entry.mfe?.price ?? null;

  const useQqq     = entry.exchange === 'NASDAQ';
  const idxPos     = useQqq ? snapE.qqqPosition : snapE.spyPosition;
  const indexTrend = idxPos != null ? (dir === 'LONG' ? idxPos === 'above' : idxPos === 'below') : null;

  const sectPos     = snapE.sectorPosition ?? null;
  const sectorTrend = sectPos != null ? (dir === 'LONG' ? sectPos === 'above' : sectPos === 'below') : null;

  const sig    = entry.signal;
  const sigAge = entry.signalAge ?? 0;
  const entryCtx = entry.entryContext || null;
  let signalCheck = null;
  if (entryCtx === 'DEVELOPING_SIGNAL') signalCheck = 'developing';
  else if (!sig || sig === 'PAUSE' || sig === 'NO_SIGNAL') signalCheck = 'warn';
  else if ((dir === 'LONG' && sig === 'BL' && sigAge <= 1) || (dir === 'SHORT' && sig === 'SS' && sigAge <= 1)) signalCheck = true;
  else signalCheck = false;

  const systemExits   = ['SIGNAL', 'STOP_HIT', 'FEAST', 'STALE_HUNT'];
  const exitCheck     = exitReason ? systemExits.includes(exitReason) : null;
  const notEarlyCheck = exitReason === 'MANUAL' ? false : (exitReason ? true : null);
  const onSignalCheck = exitReason === 'SIGNAL';
  const washClean     = !(entry.tags?.includes('wash-sale'));

  let sizingCheck = null, riskDollar = null, riskPct = null, riskCapCheck = null;
  if (nav != null && entryPrice != null && stopPrice != null && lot1Shares != null) {
    const stopDist    = Math.abs(entryPrice - stopPrice);
    const vitality    = nav * (isETF ? 0.005 : 0.01);
    const tickerCap   = nav * 0.10;
    if (stopDist > 0) {
      const byV = Math.floor(vitality / stopDist);
      const byC = Math.floor(tickerCap / entryPrice);
      const tot = Math.min(byV, byC);
      const exp = Math.max(1, Math.round(tot * 0.15));
      const dev = exp > 0 ? Math.abs(lot1Shares - exp) / exp : null;
      sizingCheck  = dev != null ? dev <= 0.10 : null;
      riskDollar   = +(lot1Shares * stopDist).toFixed(2);
      riskPct      = +(riskDollar / nav * 100).toFixed(3);
      riskCapCheck = riskDollar <= vitality;
    }
  }

  const signalPrice = entry.signalPrice ?? null;
  const slipNA = entry.hasOwnProperty?.('signalPrice') && signalPrice === null;
  let slipCheck = slipNA ? 'na' : null;
  if (signalPrice != null && entryPrice != null) {
    const sd  = dir === 'LONG' ? entryPrice - signalPrice : signalPrice - entryPrice;
    const sp  = Math.abs(sd / signalPrice) * 100;
    slipCheck = sp < 1.0 ? true : sp <= 2.0 ? 'warn' : false;
  }

  function getLotCheck(n) {
    const lot = lots[n - 1];
    if (!lot) return null;
    const triggerPct = [0, 0, 0.03, 0.06, 0.10, 0.14][n] || 0;
    if (n === 1) return lot.shares > 0 ? true : false;
    const trigger = entryPrice != null ? entryPrice * (dir === 'LONG' ? 1 + triggerPct : 1 - triggerPct) : null;
    const reached = trigger != null && mfePrice != null
      ? (dir === 'LONG' ? mfePrice >= trigger : mfePrice <= trigger)
      : false;
    if (!reached) return null;
    return lot.shares > 0 ? true : false;
  }

  const recycled = (() => {
    if (stopPrice == null || entryPrice == null) return null;
    return dir === 'LONG' ? stopPrice >= entryPrice : stopPrice <= entryPrice;
  })();

  return {
    indexTrend, sectorTrend, signalCheck, exitCheck, notEarlyCheck, onSignalCheck,
    washClean, sizingCheck, riskCapCheck, slipCheck,
    lot1: getLotCheck(1), lot2: getLotCheck(2), lot3: getLotCheck(3),
    lot4: getLotCheck(4), lot5: getLotCheck(5),
    heldDrawdown: exitReason !== 'MANUAL' ? true : (lastExit?.price < (entryPrice || 0) ? false : true),
    recycled,
    riskDollar, riskPct,
  };
}

// ── CheckItem ─────────────────────────────────────────────────────────────────
function CheckItem({ label, value, tooltip }) {
  const display = value === true          ? { icon: '✓', color: '#28a745' }
                : value === false         ? { icon: '✗', color: '#dc3545' }
                : value === 'warn'        ? { icon: '⚠', color: '#FFD700' }
                : value === 'developing'  ? { icon: '◆', color: '#FFD700' }
                : value === 'na'          ? { icon: 'N/A', color: '#444' }
                : /* null */                { icon: '—', color: '#333' };
  return (
    <div title={tooltip} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 38, cursor: 'help' }}>
      <span style={{ color: display.color, fontSize: '0.95rem', fontWeight: 700, lineHeight: 1 }}>{display.icon}</span>
      <span style={{ color: '#555', fontSize: '0.58rem', letterSpacing: '0.04em', marginTop: 2 }}>{label}</span>
    </div>
  );
}

// ── ScoreTierBox ──────────────────────────────────────────────────────────────
function ScoreTierBox({ title, subtotal, max, components }) {
  const s = tierBoxStyle(subtotal, max);
  return (
    <div style={{ background: s.bg, border: `1px solid ${s.border}`, borderRadius: 6, padding: '8px 10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ color: s.text, fontWeight: 700, fontSize: '0.68rem', letterSpacing: '0.08em' }}>{title}</span>
        <span style={{ color: s.text, fontWeight: 700, fontSize: '0.85rem' }}>{subtotal}/{max}</span>
      </div>
      {components.map(c => (
        <div key={c.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '1px 0', fontSize: '0.72rem' }}>
          <span style={{ color: '#888' }}>{c.name}</span>
          <span style={{ display: 'flex', gap: 6 }}>
            <span style={{ color: '#666' }}>{c.score}/{c.max}</span>
            <span style={{ color: c.label === 'DEVELOPING' ? '#FFD700' : c.score >= c.max ? '#28a745' : c.score > 0 ? '#FFD700' : '#dc3545', fontWeight: 600 }}>{c.label === 'DEVELOPING' ? '◆ DEVELOPING' : c.label}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

// ── DataCell ──────────────────────────────────────────────────────────────────
function DataCell({ label, value, color, tooltip }) {
  return (
    <div title={tooltip} style={{ cursor: tooltip ? 'help' : 'default' }}>
      <div style={{ color: '#555', fontSize: '0.6rem', letterSpacing: '0.05em', marginBottom: 2 }}>{label}</div>
      <div style={{ color: color || '#ccc', fontSize: '0.82rem', fontWeight: 500 }}>{value ?? '—'}</div>
    </div>
  );
}

// ── ConditionRow ──────────────────────────────────────────────────────────────
function ConditionRow({ label, value, detail, badge, badgeColor, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '1px 0', fontSize: '0.78rem' }}>
      <span style={{ color: '#777', minWidth: 64, flexShrink: 0 }}>{label}</span>
      <span style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
        {badge && <span style={{ background: badgeColor, color: '#000', padding: '1px 5px', borderRadius: 3, fontSize: '0.66rem', fontWeight: 700 }}>{badge}</span>}
        {value != null && <span style={{ color: color || '#ccc' }}>{value}</span>}
        {detail && <span style={{ color: '#555', fontSize: '0.7rem' }}>{detail}</span>}
      </span>
    </div>
  );
}

// ── TechSection ───────────────────────────────────────────────────────────────
function TechSection({ tech }) {
  if (!tech) return <div style={{ color: '#444', fontSize: '0.72rem', fontStyle: 'italic' }}>Technical data not available</div>;
  const rsiColor = tech.rsi14 > 70 ? '#dc3545' : tech.rsi14 < 30 ? '#28a745' : '#ccc';
  const adxColor = tech.adx > 25 ? '#28a745' : '#fd7e14';
  const obvColor = tech.obvTrend === 'RISING' ? '#28a745' : tech.obvTrend === 'DECLINING' ? '#dc3545' : '#888';
  const volColor = tech.volumeRatio > 1.5 ? '#28a745' : tech.volumeRatio < 0.7 ? '#dc3545' : '#ccc';
  return (
    <>
      <ConditionRow label="RSI(14)" value={tech.rsi14 != null ? fmtNum(tech.rsi14, 1) : null} color={rsiColor} />
      <ConditionRow label="ATR(14)" value={tech.atr14 != null ? `$${fmtNum(tech.atr14)}` : null} />
      <ConditionRow label="ADX"     value={tech.adx    != null ? fmtNum(tech.adx, 1) : null} color={adxColor} />
      <ConditionRow label="OBV"     value={tech.obvTrend} color={obvColor} />
      <ConditionRow label="52WK%"   value={tech.range52wk != null ? `${fmtNum(tech.range52wk, 1)}%` : null} />
      <ConditionRow label="VOL x"   value={tech.volumeRatio != null ? `${fmtNum(tech.volumeRatio)}x` : null} color={volColor} />
      <ConditionRow label="EARNINGS" value={tech.daysToEarnings != null ? `${tech.daysToEarnings}d` : 'N/A'}
        color={tech.daysToEarnings != null && tech.daysToEarnings <= 7 ? '#dc3545' : '#ccc'} />
    </>
  );
}

// ── MarketColumn ──────────────────────────────────────────────────────────────
function MarketColumn({ snap, tech, dir, label }) {
  if (!snap) return null;
  const getRegimeColor = r => r === 'BULLISH' ? '#28a745' : r === 'BEARISH' ? '#dc3545' : '#FFD700';
  const getVixZone    = v => v <= 15 ? { z: 'CALM', c: '#28a745' } : v <= 20 ? { z: 'NORMAL', c: '#FFD700' } : v <= 30 ? { z: 'ELEVATED', c: '#fd7e14' } : { z: 'FEAR', c: '#dc3545' };
  const vixZ = snap.vix ? getVixZone(snap.vix) : null;

  return (
    <div style={{ padding: '12px 14px', flex: 1 }}>
      <div style={{ color: label === 'AT ENTRY' ? '#D4A017' : '#777', fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.1em', marginBottom: 8 }}>{label}</div>

      <div style={{ color: '#555', fontSize: '0.62rem', letterSpacing: '0.06em', marginBottom: 3 }}>MARKET</div>
      <ConditionRow label="SPY"    value={snap.spyPrice != null ? `$${fmtNum(snap.spyPrice)}` : null}
        detail={snap.spyVsEma != null ? `${snap.spyVsEma >= 0 ? '+' : ''}${fmtNum(snap.spyVsEma)}% EMA` : null} />
      <ConditionRow label="QQQ"    value={snap.qqqPrice != null ? `$${fmtNum(snap.qqqPrice)}` : null}
        detail={snap.qqqVsEma != null ? `${snap.qqqVsEma >= 0 ? '+' : ''}${fmtNum(snap.qqqVsEma)}% EMA` : null} />
      {snap.vix != null && <ConditionRow label="VIX" value={fmtNum(snap.vix, 1)}
        badge={vixZ?.z} badgeColor={vixZ?.c} />}
      {snap.regime && <ConditionRow label="REGIME" badge={snap.regime} badgeColor={getRegimeColor(snap.regime)} />}

      <div style={{ color: '#555', fontSize: '0.62rem', letterSpacing: '0.06em', marginBottom: 3, marginTop: 8 }}>YIELDS & MACRO</div>
      {snap.treasury2Y  != null && <ConditionRow label="2Y"     value={`${fmtNum(snap.treasury2Y)}%`} />}
      {snap.treasury10Y != null && <ConditionRow label="10Y"    value={`${fmtNum(snap.treasury10Y)}%`} />}
      {snap.treasury30Y != null && <ConditionRow label="30Y"    value={`${fmtNum(snap.treasury30Y)}%`} />}
      {snap.spread2Y10Y != null && <ConditionRow label="2Y-10Y" value={`${snap.spread2Y10Y >= 0 ? '+' : ''}${fmtNum(snap.spread2Y10Y, 3)}%`}
        color={snap.spread2Y10Y < 0 ? '#dc3545' : '#28a745'} />}
      {snap.dxy      != null && <ConditionRow label="DXY"   value={fmtNum(snap.dxy)} />}
      {snap.crudeOil != null && <ConditionRow label="CRUDE" value={`$${fmtNum(snap.crudeOil)}`} />}
      {snap.gold     != null && <ConditionRow label="GOLD"  value={`$${Math.round(snap.gold).toLocaleString()}`} />}

      {snap.sectorEtf && <>
        <div style={{ color: '#555', fontSize: '0.62rem', letterSpacing: '0.06em', marginBottom: 3, marginTop: 8 }}>SECTOR</div>
        <ConditionRow label={snap.sectorEtf} value={snap.sectorPrice != null ? `$${fmtNum(snap.sectorPrice)}` : null}
          detail={snap.sectorChange1D != null ? `${snap.sectorChange1D >= 0 ? '+' : ''}${fmtNum(snap.sectorChange1D)}%` : null}
          color={snap.sectorChange1D >= 0 ? '#28a745' : '#dc3545'} />
        {snap.sectorVsEma != null && <ConditionRow label="vs EMA"
          value={`${snap.sectorVsEma >= 0 ? '+' : ''}${fmtNum(snap.sectorVsEma)}%`}
          color={snap.sectorVsEma >= 0 ? '#28a745' : '#dc3545'} />}
      </>}

      {tech && <>
        <div style={{ color: '#555', fontSize: '0.62rem', letterSpacing: '0.06em', marginBottom: 3, marginTop: 8 }}>TECHNICALS</div>
        <TechSection tech={tech} />
      </>}
    </div>
  );
}

// ── TradeCard ─────────────────────────────────────────────────────────────────
function TradeCard({ entry, onTickerClick, saveNotes }) {
  const [expanded, setExpanded] = useState(true);
  const [localNotes, setLocalNotes] = useState({ tradeNotes: entry.tradeNotes || '', macroNotes: entry.macroNotes || '' });

  const disc      = entry.discipline || {};
  const chk       = computeChecks(entry);
  const dir       = entry.direction || 'LONG';
  const exits     = Array.isArray(entry.exits) ? entry.exits : [];
  const lastExit  = exits[exits.length - 1];
  const lots      = Array.isArray(entry.lots) ? entry.lots : [];
  const pnl       = entry.performance?.realizedPnlDollar ?? entry.totalPnL ?? null;
  const pnlPct    = entry.performance?.realizedPnlPct ?? null;
  const exitReason = lastExit?.reason || null;
  const entryPrice = entry.entry?.fillPrice ?? entry.entryPrice ?? null;
  const exitPrice  = entry.performance?.avgExitPrice ?? lastExit?.price ?? null;
  const calDays    = calendarDaysBetween(entry.entry?.fillDate || entry.createdAt, lastExit?.date);
  const tradDays   = tradingDaysBetween(entry.entry?.fillDate || entry.createdAt, lastExit?.date);
  const captureRatio = pnl != null && entry.mfe?.percent && entry.mfe.percent !== 0
    ? +((pnl / (Math.abs(entryPrice || 1) * (lots.reduce((s,l)=>s+(l.shares||0),0)||1)) / (entry.mfe.percent / 100)) * 100).toFixed(1)
    : null;
  const kse     = entry.killScoreAtEntry;
  const dims    = kse?.dimensions || null;
  const snapE   = entry.marketAtEntry || null;
  const snapX   = entry.marketAtExit  || null;
  const techE   = entry.techAtEntry   || null;
  const techX   = entry.techAtExit    || null;

  const CHECK_TIPS = {
    IDX:    'Index trend alignment. ✓ = traded with S&P 500 or Nasdaq 100 direction. Scored T1-C (0-8 pts).',
    SECT:   'Sector trend alignment. ✓ = traded with sector ETF 21-week EMA direction. Scored T1-D (0-7 pts).',
    SIG:    'Signal quality. ✓ = fresh BL+1/SS+1. ✗ = stale signal. ⚠ = no PNTHR signal. Scored T1-A (0-15 pts).',
    EXIT:   'Exit discipline. ✓ = system rule (signal/stop/feast/stale). ✗ = manual override. Scored T3-A (0-12 pts).',
    '~EARLY': '✓ = ran to system exit. ✗ = manually closed before signal. Part of T3-B scoring.',
    'ON SIG': '✓ = exited on BE/SE signal specifically. ✗ = any other exit reason. Part of T3-B scoring.',
    WASH:   'Wash sale compliance. ✓ = no active wash window. ✗ = entered during 30-day wash window. Scored T3-C (0-5 pts).',
    SIZE:   'Position sizing. ✓ = Lot 1 shares within 10% of SIZE IT calculation. Scored T2-A (0-8 pts).',
    CAP:    'Risk cap. ✓ = within 1% Vitality (stocks) or 0.5% (ETFs). ✗ = exceeded cap. Scored T2-B (0-5 pts).',
    SLIP:   'Slippage. ✓ = under 1%. ⚠ = 1-2%. ✗ = over 2%. N/A = no signal price. Scored T2-C (0-5 pts).',
    L1: 'Lot 1 — The Scent (15% of position). Always ✓ for closed trades.',
    L2: 'Lot 2 — The Stalk (30%). ✓ = trigger reached and filled. ✗ = trigger reached but skipped. N/A = trigger never reached.',
    L3: 'Lot 3 — The Strike (25%). Same logic. Scored as part of T2-D Pyramiding.',
    L4: 'Lot 4 — The Jugular (20%). Same logic.',
    L5: 'Lot 5 — The Kill (10%). Same logic.',
    HELD:  '✓ = held through drawdown (stop managed risk). ✗ = panic sold (manual exit at a loss). Scored T2-E (0-7 pts).',
    RECYC: '✓ = stop rose above entry price (recycled position, $0 heat). ✗ = never recycled. Display only.',
  };

  return (
    <div style={{ background: '#111', border: '1px solid #222', borderRadius: 8, marginBottom: 12, overflow: 'hidden' }}>

      {/* ── Section 1: HEADER BAR ── */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '10px 14px',
        background: 'rgba(212,160,23,0.07)',
        borderBottom: expanded ? '1px solid #2a2a2a' : 'none',
        cursor: 'pointer',
      }} onClick={() => setExpanded(e => !e)}>
        {/* Left */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ color: expanded ? '#FFD700' : '#ccc', fontSize: '1.3rem', fontWeight: 700, cursor: 'pointer' }}
            onClick={e => { e.stopPropagation(); onTickerClick?.(entry.ticker); }}>
            {entry.ticker}
          </span>
          <span style={{ background: dir === 'LONG' ? 'rgba(40,167,69,0.25)' : 'rgba(220,53,69,0.25)', color: dir === 'LONG' ? '#28a745' : '#dc3545', padding: '2px 8px', borderRadius: 4, fontSize: '0.72rem', fontWeight: 700 }}>
            {dir}
          </span>
          <span style={{ color: '#777', fontSize: '0.8rem' }}>{fmtDate(entry.entry?.fillDate || entry.createdAt)} → {fmtDate(lastExit?.date)}</span>
          {entry.exchange && <span style={{ color: '#555', fontSize: '0.75rem' }}>{entry.exchange}</span>}
          {entry.sector   && <span style={{ color: '#555', fontSize: '0.75rem' }}>{entry.sector}</span>}
          {calDays != null && <span style={{ color: '#555', fontSize: '0.72rem' }}>{calDays}d</span>}
        </div>
        {/* Right */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ color: pnl >= 0 ? '#28a745' : '#dc3545', fontSize: '1.1rem', fontWeight: 700 }}>
              {pnl != null ? `${pnl >= 0 ? '+' : ''}${fmtDollar(pnl).replace('$', pnl < 0 ? '-$' : '$')}` : '—'}
            </div>
            {pnlPct != null && <div style={{ color: pnlPct >= 0 ? '#28a745' : '#dc3545', fontSize: '0.8rem' }}>{pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%</div>}
          </div>
          {disc.totalScore != null && (
            <div style={{ background: getScoreColor(disc.totalScore), color: getScoreTextColor(disc.totalScore), padding: '5px 12px', borderRadius: 6, textAlign: 'center', minWidth: 72 }}>
              <div style={{ fontSize: '1.2rem', fontWeight: 700, lineHeight: 1.1 }}>{disc.totalScore}</div>
              <div style={{ fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.04em' }}>{disc.tierLabel?.split(' ')[0]}</div>
            </div>
          )}
          <span style={{ color: '#555', fontSize: '0.8rem' }}>{expanded ? '▼' : '▶'}</span>
        </div>
      </div>

      {expanded && <>

        {/* ── Section 2: DISCIPLINE CHECKS ── */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 10px', padding: '10px 14px', background: 'rgba(255,255,255,0.015)', borderBottom: '1px solid #1e1e1e' }}>
          <CheckItem label="IDX"     value={chk.indexTrend}   tooltip={CHECK_TIPS.IDX} />
          <CheckItem label="SECT"    value={chk.sectorTrend}  tooltip={CHECK_TIPS.SECT} />
          <CheckItem label="SIG"     value={chk.signalCheck}  tooltip={CHECK_TIPS.SIG} />
          <CheckItem label="EXIT"    value={chk.exitCheck}    tooltip={CHECK_TIPS.EXIT} />
          <CheckItem label="~EARLY"  value={chk.notEarlyCheck} tooltip={CHECK_TIPS['~EARLY']} />
          <CheckItem label="ON SIG"  value={chk.onSignalCheck} tooltip={CHECK_TIPS['ON SIG']} />
          <CheckItem label="WASH"    value={chk.washClean}    tooltip={CHECK_TIPS.WASH} />
          <CheckItem label="SIZE"    value={chk.sizingCheck}  tooltip={CHECK_TIPS.SIZE} />
          <CheckItem label="CAP"     value={chk.riskCapCheck} tooltip={CHECK_TIPS.CAP} />
          <CheckItem label="SLIP"    value={chk.slipCheck}    tooltip={CHECK_TIPS.SLIP} />
          <div style={{ width: 1, background: '#2a2a2a', alignSelf: 'stretch' }} />
          <CheckItem label="L1"  value={chk.lot1}  tooltip={CHECK_TIPS.L1} />
          <CheckItem label="L2"  value={chk.lot2}  tooltip={CHECK_TIPS.L2} />
          <CheckItem label="L3"  value={chk.lot3}  tooltip={CHECK_TIPS.L3} />
          <CheckItem label="L4"  value={chk.lot4}  tooltip={CHECK_TIPS.L4} />
          <CheckItem label="L5"  value={chk.lot5}  tooltip={CHECK_TIPS.L5} />
          <div style={{ width: 1, background: '#2a2a2a', alignSelf: 'stretch' }} />
          <CheckItem label="HELD"  value={chk.heldDrawdown} tooltip={CHECK_TIPS.HELD} />
          <CheckItem label="RECYC" value={chk.recycled}     tooltip={CHECK_TIPS.RECYC} />
        </div>

        {/* ── Section 3: DISCIPLINE SCORE BREAKDOWN ── */}
        {disc.tier1 && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, padding: '10px 14px', borderBottom: '1px solid #1e1e1e' }}>
            <ScoreTierBox title="STOCK SELECTION" subtotal={disc.tier1.total} max={disc.tier1.max}
              components={Object.entries(disc.tier1.components).map(([,c]) => ({ name: c.detail?.split(' ')[0] || c.label, score: c.score, max: c.max, label: c.label }))} />
            <ScoreTierBox title="EXECUTION" subtotal={disc.tier2.total} max={disc.tier2.max}
              components={Object.entries(disc.tier2.components).map(([,c]) => ({ name: c.detail?.split(' ')[0] || c.label, score: c.score, max: c.max, label: c.label }))} />
            <ScoreTierBox title="EXIT" subtotal={disc.tier3.total} max={disc.tier3.max}
              components={Object.entries(disc.tier3.components).map(([,c]) => ({ name: c.detail?.split(' ')[0] || c.label, score: c.score, max: c.max, label: c.label }))} />
          </div>
        )}

        {/* ── Section 4: KILL SCORE ── */}
        <div style={{ padding: '8px 14px', borderBottom: '1px solid #1e1e1e' }}>
          {kse?.totalScore != null ? (
            <>
              <div style={{ display: 'flex', gap: 20, marginBottom: 6, flexWrap: 'wrap' }}>
                <DataCell label="KILL SCORE" value={`${Math.round(kse.totalScore)}${kse.pipelineMaxScore ? `/${Math.round(kse.pipelineMaxScore)}` : ''}`} color="#FFD700" />
                {kse.rank     != null && <DataCell label="RANK"   value={`#${kse.rank}`} />}
                {kse.rankChange != null && <DataCell label="ΔRANK"  value={kse.rankChange > 0 ? `+${kse.rankChange}` : String(kse.rankChange)} color={kse.rankChange > 0 ? '#28a745' : '#dc3545'} />}
                {kse.tier      && <DataCell label="TIER"  value={kse.tier} color="#FFD700" />}
              </div>
              {dims && (
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  {[1,2,3,4,5,6,7,8].map(n => {
                    const v = dims[`d${n}`];
                    const val = v != null ? (typeof v === 'object' ? v.score : v) : null;
                    const c = val == null ? '#3a3a3a' : val > 0 ? '#28a745' : val < 0 ? '#dc3545' : '#666';
                    return <DataCell key={n} label={`D${n}`} value={val != null ? (n === 1 ? `${Number(val).toFixed(2)}×` : (val > 0 ? `+${Math.round(val)}` : String(Math.round(val)))) : '—'} color={c} />;
                  })}
                </div>
              )}
            </>
          ) : (
            <span style={{ color: '#444', fontSize: '0.76rem', fontStyle: 'italic' }}>
              Kill Score: N/A — stock was not in the Kill pipeline at time of entry
            </span>
          )}
        </div>

        {/* ── Section 5: RISK & EXECUTION ── */}
        <div style={{ padding: '10px 14px', borderBottom: '1px solid #1e1e1e' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 10 }}>
            <DataCell label="ENTRY PRICE" value={entryPrice != null ? fmtDollar(entryPrice) : '—'} />
            <DataCell label="EXIT PRICE"  value={exitPrice  != null ? fmtDollar(exitPrice)  : '—'} />
            <DataCell label="SIGNAL PRICE" value={entry.signalPrice != null ? fmtDollar(entry.signalPrice) : 'N/A'} />
            <DataCell label="STOP PRICE"  value={entry.entry?.stopPrice != null ? fmtDollar(entry.entry.stopPrice) : '—'} />

            <DataCell label="LOT 1 SHARES" value={lots[0]?.shares ?? '—'} />
            <DataCell label="TOTAL SHARES" value={lots.reduce((s,l)=>s+(l.shares||0),0) || '—'} />
            <DataCell label="LOTS FILLED"  value={`${lots.filter(l=>l.shares>0).length} of 5`} />
            <DataCell label="EXIT REASON"  value={exitReason || '—'} color={exitReason === 'MANUAL' ? '#dc3545' : exitReason === 'STOP_HIT' ? '#fd7e14' : '#28a745'} />

            <DataCell label="RISK $"   value={chk.riskDollar != null ? `$${Math.abs(chk.riskDollar).toFixed(2)}` : '—'} />
            <DataCell label="RISK %"   value={chk.riskPct != null ? `${chk.riskPct.toFixed(2)}%` : '—'} />
            <DataCell label="MFE" value={entry.mfe?.price != null ? `${fmtDollar(entry.mfe.price)} (${entry.mfe.percent?.toFixed(2)}%)` : '—'} color="#28a745" />
            <DataCell label="MAE" value={entry.mae?.price != null ? `${fmtDollar(entry.mae.price)} (${entry.mae.percent?.toFixed(2)}%)` : '—'} color="#dc3545" />

            <DataCell label="CAPTURE RATIO" value={captureRatio != null ? `${captureRatio}%` : '—'} tooltip="Exit P&L as % of MFE. 100% = captured the entire move." />
            <DataCell label="CALENDAR DAYS" value={calDays != null ? `${calDays}d` : '—'} />
            <DataCell label="TRADING DAYS"  value={tradDays != null ? `${tradDays}d` : '—'} />
            <DataCell label="NAV AT ENTRY"  value={entry.navAtEntry != null ? `$${entry.navAtEntry.toLocaleString()}` : '—'} />
          </div>

          {/* Forward returns */}
          {(entry.forwardReturns?.week1 != null || entry.forwardReturns?.week2 != null || entry.forwardReturns?.week4 != null) && (
            <div style={{ display: 'flex', gap: 16, paddingTop: 8, borderTop: '1px solid #1e1e1e' }}>
              <DataCell label="1WK POST-EXIT" tooltip="Stock return 1 week after exit. Green = left money on table."
                value={entry.forwardReturns?.week1 != null ? `${entry.forwardReturns.week1 > 0 ? '+' : ''}${entry.forwardReturns.week1.toFixed(2)}%` : 'pending'}
                color={entry.forwardReturns?.week1 > 0 ? '#28a745' : '#dc3545'} />
              <DataCell label="2WK POST-EXIT"
                value={entry.forwardReturns?.week2 != null ? `${entry.forwardReturns.week2 > 0 ? '+' : ''}${entry.forwardReturns.week2.toFixed(2)}%` : 'pending'}
                color={entry.forwardReturns?.week2 > 0 ? '#28a745' : '#dc3545'} />
              <DataCell label="4WK POST-EXIT"
                value={entry.forwardReturns?.week4 != null ? `${entry.forwardReturns.week4 > 0 ? '+' : ''}${entry.forwardReturns.week4.toFixed(2)}%` : 'pending'}
                color={entry.forwardReturns?.week4 > 0 ? '#28a745' : '#dc3545'} />
            </div>
          )}
        </div>

        {/* ── Section 6: MARKET & TECHNICAL CONDITIONS ── */}
        <div style={{ display: 'flex', borderBottom: '1px solid #1e1e1e' }}>
          <MarketColumn snap={snapE} tech={techE} dir={dir} label="AT ENTRY" />
          <div style={{ width: 1, background: '#1e1e1e', flexShrink: 0 }} />
          <MarketColumn snap={snapX} tech={techX} dir={dir} label="AT EXIT" />
        </div>

        {/* ── Section 7: NOTES ── */}
        <div style={{ padding: '10px 14px' }}>
          <div style={{ marginBottom: 8 }}>
            <div style={{ color: '#D4A017', fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.1em', marginBottom: 4 }}>TRADE NOTES</div>
            <textarea value={localNotes.tradeNotes}
              onChange={e => setLocalNotes(n => ({ ...n, tradeNotes: e.target.value }))}
              onBlur={() => saveNotes(entry._id, 'tradeNotes', localNotes.tradeNotes)}
              placeholder="Why I took this trade, chart thesis, what I observed..."
              style={{ width: '100%', minHeight: 44, background: 'transparent', border: '1px solid #222', borderRadius: 4, color: '#ccc', padding: '6px 8px', fontSize: '0.78rem', fontStyle: 'italic', resize: 'vertical', outline: 'none', boxSizing: 'border-box' }}
            />
          </div>
          <div>
            <div style={{ color: '#666', fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.1em', marginBottom: 4 }}>MACRO / GEOPOLITICAL NOTES</div>
            <textarea value={localNotes.macroNotes}
              onChange={e => setLocalNotes(n => ({ ...n, macroNotes: e.target.value }))}
              onBlur={() => saveNotes(entry._id, 'macroNotes', localNotes.macroNotes)}
              placeholder="War, Fed decisions, tariffs, earnings season, election, trade policy..."
              style={{ width: '100%', minHeight: 44, background: 'transparent', border: '1px solid #222', borderRadius: 4, color: '#999', padding: '6px 8px', fontSize: '0.78rem', fontStyle: 'italic', resize: 'vertical', outline: 'none', boxSizing: 'border-box' }}
            />
          </div>
        </div>
      </>}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────
export default function ClosedTradeCards({ onTickerClick }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`${API_BASE}/api/journal/closed-scorecard`, { headers: authHeaders() })
      .then(r => r.ok ? r.json() : [])
      .then(data => { setEntries(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const saveNotes = useCallback(async (id, field, value) => {
    try {
      await fetch(`${API_BASE}/api/journal/${id}/scorecard-notes`, {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      });
    } catch { /* non-fatal */ }
  }, []);

  if (loading) return <div style={{ padding: 48, textAlign: 'center', color: '#555', fontSize: 13 }}>Loading closed trades…</div>;
  if (!entries.length) return <div style={{ padding: 48, textAlign: 'center', color: '#555', fontSize: 13 }}>No closed trades yet.</div>;

  return (
    <div style={{ padding: '0 0 24px' }}>
      {entries.map(entry => (
        <TradeCard key={entry._id} entry={entry} onTickerClick={onTickerClick} saveNotes={saveNotes} />
      ))}
    </div>
  );
}
