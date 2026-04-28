// client/src/components/ClosedTradeCards.jsx
// ── PNTHR Journal v3 — Card-Based Closed Trade Layout ────────────────────────
// Replaces the 42-column horizontal spreadsheet (ScorecardGrid) with vertically
// stacked trade cards. No horizontal scrolling. 7 sections per card.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback, useRef, Component } from 'react';

// ── TradeCard ErrorBoundary ────────────────────────────────────────────────────
// Catches render errors on a per-card basis so one bad entry never kills the
// entire CLOSED tab (and the whole app).
class TradeCardBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(err) { return { error: err }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ background: '#1a0a0a', border: '1px solid #7b2e2e', borderRadius: 8, marginBottom: 12, padding: '14px 18px' }}>
          <span style={{ color: '#dc3545', fontWeight: 700, fontSize: 12 }}>⚠ Could not render trade card</span>
          <span style={{ color: '#666', fontSize: 11, marginLeft: 10 }}>{this.state.error?.message}</span>
        </div>
      );
    }
    return this.props.children;
  }
}
import { API_BASE, authHeaders } from '../services/api';
import ClosedTradeChartModal from './ClosedTradeChartModal';

// ── Safe string helper — prevents React Error #31 when fields contain objects ──
function safeStr(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // Object (e.g. {label: 'ERROR'}) — extract label if present, otherwise JSON
  if (typeof v === 'object' && v.label != null) return String(v.label);
  return JSON.stringify(v);
}

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

  const systemExits   = ['SIGNAL', 'STOP_HIT', 'FEAST', 'STALE_HUNT', 'RISK_ADVISOR'];
  const exitCheck     = exitReason ? systemExits.includes(exitReason) : null;
  const notEarlyCheck = exitReason === 'MANUAL' ? false : (exitReason ? true : null);
  const onSignalCheck = exitReason === 'SIGNAL';
  const washClean     = !(entry.tags?.includes('wash-sale'));

  let sizingCheck = null, riskDollar = null, riskPct = null, riskCapCheck = null;
  // Risk $ only needs entry + stop + shares — no NAV required
  if (entryPrice != null && stopPrice != null && lot1Shares != null) {
    const stopDist = Math.abs(entryPrice - stopPrice);
    if (stopDist > 0) {
      riskDollar = +(lot1Shares * stopDist).toFixed(2);
      // Risk % (portfolio) and sizing checks require NAV
      if (nav != null) {
        const vitality  = nav * (isETF ? 0.005 : 0.01);
        const tickerCap = nav * 0.10;
        const byV = Math.floor(vitality / stopDist);
        const byC = Math.floor(tickerCap / entryPrice);
        const tot = Math.min(byV, byC);
        const exp = Math.max(1, Math.round(tot * 0.35));
        const dev = exp > 0 ? Math.abs(lot1Shares - exp) / exp : null;
        sizingCheck  = dev != null ? dev <= 0.10 : null;
        riskPct      = +(riskDollar / nav * 100).toFixed(3);
        riskCapCheck = riskDollar <= vitality;
      }
    }
  }
  // User-confirmed answer overrides auto-calculation
  if (entry.userConfirmed?.sizingCorrect === true)  sizingCheck = true;
  if (entry.userConfirmed?.sizingCorrect === false) sizingCheck = false;

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
      {components.map((c, i) => {
        const lbl = typeof c.label === 'string' ? c.label : (c.label != null ? String(c.label) : '—');
        const nm  = typeof c.name  === 'string' ? c.name  : (c.name  != null ? String(c.name)  : '—');
        return (
          <div key={nm + i} style={{ display: 'flex', justifyContent: 'space-between', padding: '1px 0', fontSize: '0.72rem' }}>
            <span style={{ color: '#888' }}>{nm}</span>
            <span style={{ display: 'flex', gap: 6 }}>
              <span style={{ color: '#666' }}>{c.score}/{c.max}</span>
              <span style={{ color: lbl === 'DEVELOPING' ? '#FFD700' : c.score >= c.max ? '#28a745' : c.score > 0 ? '#FFD700' : '#dc3545', fontWeight: 600 }}>{lbl === 'DEVELOPING' ? '◆ DEVELOPING' : lbl}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── DataCell ──────────────────────────────────────────────────────────────────
function DataCell({ label, value, color, tooltip }) {
  return (
    <div title={tooltip} style={{ cursor: tooltip ? 'help' : 'default' }}>
      <div style={{ color: '#555', fontSize: '0.6rem', letterSpacing: '0.05em', marginBottom: 2 }}>{label}</div>
      <div style={{ color: color || '#ccc', fontSize: '0.82rem', fontWeight: 500 }}>{value != null && typeof value === 'object' ? JSON.stringify(value) : (value ?? '—')}</div>
    </div>
  );
}

// ── ConditionRow ──────────────────────────────────────────────────────────────
function ConditionRow({ label, value, detail, badge, badgeColor, color }) {
  if (value == null && !badge && !detail) return null;
  const safeBadge  = safeStr(badge);
  const safeValue  = safeStr(value);
  const safeDetail = safeStr(detail);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', columnGap: 10, padding: '1px 0', fontSize: '0.78rem' }}>
      <span style={{ color: '#777', flexShrink: 0 }}>{label}</span>
      <span style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
        {safeBadge  && <span style={{ background: badgeColor, color: '#000', padding: '1px 5px', borderRadius: 3, fontSize: '0.66rem', fontWeight: 700 }}>{safeBadge}</span>}
        {safeValue  != null && <span style={{ color: color || '#ccc' }}>{safeValue}</span>}
        {safeDetail && <span style={{ color: '#555', fontSize: '0.7rem' }}>{safeDetail}</span>}
      </span>
    </div>
  );
}

// ── TechSection ───────────────────────────────────────────────────────────────
function TechSection({ tech }) {
  if (!tech) return null;
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

  const hasMarket  = snap.spyPrice != null || snap.qqqPrice != null || snap.vix != null || !!snap.regime;
  const hasYields  = snap.treasury2Y != null || snap.treasury10Y != null || snap.treasury30Y != null ||
                     snap.spread2Y10Y != null || snap.dxy != null || snap.crudeOil != null || snap.gold != null;

  return (
    <div style={{ padding: '12px 14px', flex: 1, maxWidth: 480 }}>
      <div style={{ color: label === 'AT ENTRY' ? '#D4A017' : '#777', fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.1em', marginBottom: 8 }}>{label}</div>

      {hasMarket && <>
        <div style={{ color: '#555', fontSize: '0.62rem', letterSpacing: '0.06em', marginBottom: 3 }}>MARKET</div>
        <ConditionRow label="SPY" value={snap.spyPrice != null ? `$${fmtNum(snap.spyPrice)}` : null}
          detail={snap.spyVsEma != null ? `${snap.spyVsEma >= 0 ? '+' : ''}${fmtNum(snap.spyVsEma)}% EMA` : null} />
        <ConditionRow label="QQQ" value={snap.qqqPrice != null ? `$${fmtNum(snap.qqqPrice)}` : null}
          detail={snap.qqqVsEma != null ? `${snap.qqqVsEma >= 0 ? '+' : ''}${fmtNum(snap.qqqVsEma)}% EMA` : null} />
        {snap.vix != null && <ConditionRow label="VIX" value={fmtNum(snap.vix, 1)} badge={vixZ?.z} badgeColor={vixZ?.c} />}
        {snap.regime && <ConditionRow label="REGIME" badge={snap.regime} badgeColor={getRegimeColor(snap.regime)} />}
      </>}

      {hasYields && <>
        <div style={{ color: '#555', fontSize: '0.62rem', letterSpacing: '0.06em', marginBottom: 3, marginTop: 8 }}>YIELDS & MACRO</div>
        {snap.treasury2Y  != null && <ConditionRow label="2Y"     value={`${fmtNum(snap.treasury2Y)}%`} />}
        {snap.treasury10Y != null && <ConditionRow label="10Y"    value={`${fmtNum(snap.treasury10Y)}%`} />}
        {snap.treasury30Y != null && <ConditionRow label="30Y"    value={`${fmtNum(snap.treasury30Y)}%`} />}
        {snap.spread2Y10Y != null && <ConditionRow label="2Y-10Y" value={`${snap.spread2Y10Y >= 0 ? '+' : ''}${fmtNum(snap.spread2Y10Y, 3)}%`}
          color={snap.spread2Y10Y < 0 ? '#dc3545' : '#28a745'} />}
        {snap.dxy      != null && <ConditionRow label="DXY"   value={fmtNum(snap.dxy)} />}
        {snap.crudeOil != null && <ConditionRow label="CRUDE" value={`$${fmtNum(snap.crudeOil)}`} />}
        {snap.gold     != null && <ConditionRow label="GOLD"  value={`$${Math.round(snap.gold).toLocaleString()}`} />}
      </>}

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

// ── CompleteYourScore ─────────────────────────────────────────────────────────
function getScoreQuestions(entry, disc) {
  // NOTE: signal quality and Kill score questions have been removed.
  // Both are captured at entry confirmation time via the Analyze snapshot
  // (4-source cascade: Analyze → queue entry → MongoDB pipeline → signal cache).
  // Only subjective/behavioral questions remain here.
  const questions = [];
  if (!disc) return questions;

  const isETF    = entry.isETF || entry.entryConfirmed?.isETF || false;
  const idxLabel = disc.tier1?.components?.indexTrend?.label;
  // ETFs don't have index trend questions (ETF IS the index — circular logic)
  if (!isETF && (idxLabel === 'UNKNOWN' || idxLabel === 'ERROR') && !entry.userConfirmed?.indexTrend && !entry.entryConfirmed?.indexTrend) {
    questions.push({
      id: 'indexTrend',
      question: `Was the market (SPY/QQQ) trending WITH or AGAINST your ${entry.direction} trade in ${entry.ticker}?`,
      type: 'single_select',
      options: [
        { value: 'WITH',    label: 'With trend (index supported my direction)' },
        { value: 'AGAINST', label: 'Against trend (I went against the index)' },
        { value: 'UNKNOWN', label: "Don't remember" },
      ],
    });
  }

  const sectLabel = disc.tier1?.components?.sectorTrend?.label;
  // ETFs don't have sector trend questions (no GICS sector classification)
  if (!isETF && (sectLabel === 'UNKNOWN' || sectLabel === 'ERROR') && !entry.userConfirmed?.sectorTrend && !entry.entryConfirmed?.sectorTrend) {
    questions.push({
      id: 'sectorTrend',
      question: `Was the ${entry.sector || 'sector'} trending WITH or AGAINST your ${entry.direction} trade?`,
      type: 'single_select',
      options: [
        { value: 'WITH',    label: 'With sector trend' },
        { value: 'AGAINST', label: 'Against sector trend' },
        { value: 'UNKNOWN', label: "Don't remember" },
      ],
    });
  }

  if (disc.tier2?.components?.sizing?.label === 'N/A' && !entry.userConfirmed?.sizing) {
    questions.push({
      id: 'sizing',
      question: 'Did you use SIZE IT for the recommended position size?',
      type: 'single_select',
      options: [
        { value: 'EXACT',     label: 'Yes, exact SIZE IT recommendation' },
        { value: 'WITHIN_10', label: 'Yes, within 10% of SIZE IT' },
        { value: 'WITHIN_20', label: 'Close, within 20%' },
        { value: 'NO',        label: 'No, I adjusted significantly' },
      ],
    });
  }

  return questions;
}

// Returns ALL scoreable questions regardless of disc state — used in review mode
// so the user can correct any previously confirmed answer.
function getReviewQuestions(entry) {
  return [
    {
      id: 'signal',
      question: `What was the PNTHR signal for ${entry.ticker} when you entered?`,
      type: 'single_select',
      options: [
        { value: 'BL+1',        label: 'BL+1 (fresh buy long)' },
        { value: 'BL+2',        label: 'BL+2 (1 week old)' },
        { value: 'BL+3',        label: 'BL+3+ (2+ weeks old)' },
        { value: 'SS+1',        label: 'SS+1 (fresh sell short)' },
        { value: 'SS+2',        label: 'SS+2 (1 week old)' },
        { value: 'SS+3',        label: 'SS+3+ (2+ weeks old)' },
        { value: 'DEVELOPING',  label: 'Developing signal (3/4 conditions met)' },
        { value: 'NONE',        label: 'No PNTHR signal' },
      ],
    },
    {
      id: 'indexTrend',
      question: `Was the market (SPY/QQQ) trending WITH or AGAINST your ${entry.direction} trade?`,
      type: 'single_select',
      options: [
        { value: 'WITH',    label: 'With trend (index supported my direction)' },
        { value: 'AGAINST', label: 'Against trend (I went against the index)' },
        { value: 'UNKNOWN', label: "Don't remember" },
      ],
    },
    {
      id: 'sectorTrend',
      question: `Was the ${entry.sector || 'sector'} trending WITH or AGAINST your ${entry.direction} trade?`,
      type: 'single_select',
      options: [
        { value: 'WITH',    label: 'With sector trend' },
        { value: 'AGAINST', label: 'Against sector trend' },
        { value: 'UNKNOWN', label: "Don't remember" },
      ],
    },
    {
      id: 'sizing',
      question: 'Did you use SIZE IT for the recommended position size?',
      type: 'single_select',
      options: [
        { value: 'EXACT',     label: 'Yes, exact SIZE IT recommendation' },
        { value: 'WITHIN_10', label: 'Yes, within 10% of SIZE IT' },
        { value: 'WITHIN_20', label: 'Close, within 20%' },
        { value: 'NO',        label: 'No, I adjusted significantly' },
      ],
    },
  ];
}

// questions and reviewMode are now passed from the parent (TradeCard) so the
// parent controls exactly what to show — no internal re-derivation needed.
function CompleteYourScore({ entry, questions, reviewMode, onSave }) {
  // Pre-populate from existing userConfirmed so saved answers show highlighted
  const [answers, setAnswers] = useState(() => {
    const uc = entry.userConfirmed || {};
    return {
      ...(uc.signal      != null ? { signal:      uc.signal      } : {}),
      ...(uc.killScore   != null ? { killScore:   uc.killScore   } : {}),
      ...(uc.indexTrend  != null ? { indexTrend:  uc.indexTrend  } : {}),
      ...(uc.sectorTrend != null ? { sectorTrend: uc.sectorTrend } : {}),
      ...(uc.sizing      != null ? { sizing:      uc.sizing      } : {}),
    };
  });
  const [saving, setSaving] = useState(false);

  const hasAnswers = Object.keys(answers).length > 0;

  const handleSave = async () => {
    if (!hasAnswers) return;
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/journal/${entry._id}/confirm-score`, {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers }),
      });
      if (!res.ok) throw new Error('Failed to save');
      const { newScore } = await res.json();
      onSave?.(entry._id, newScore, answers);
    } catch (e) {
      alert('Failed to save score: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ border: '1px solid #D4A017', borderRadius: 8, padding: 16, backgroundColor: 'rgba(212,160,23,0.05)', margin: '10px 14px' }}>
      <div style={{ color: '#FFD700', fontWeight: 700, fontSize: 14, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>{reviewMode ? '✎' : '?'}</span>
        {reviewMode
          ? 'REVIEW CONFIRMED ANSWERS — click any option to correct it'
          : `COMPLETE YOUR SCORE — ${questions.length} field${questions.length > 1 ? 's' : ''} need confirmation`}
      </div>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 14 }}>
        {reviewMode
          ? 'Your previously confirmed answers are highlighted. Change any selection and hit SAVE AND RESCORE.'
          : "Some data wasn't captured automatically at entry. Confirm these to get an accurate discipline score."}
      </div>

      {questions.map(q => (
        <div key={q.id} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13, color: '#ccc', marginBottom: 6 }}>{q.question}</div>
          {q.type === 'single_select' && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {q.options.map(opt => (
                <button key={opt.value}
                  onClick={() => setAnswers(a => ({ ...a, [q.id]: opt.value }))}
                  style={{
                    padding: '4px 10px', borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                    background:  answers[q.id] === opt.value ? 'rgba(212,160,23,0.2)' : 'transparent',
                    border: `1px solid ${answers[q.id] === opt.value ? '#D4A017' : '#444'}`,
                    color:  answers[q.id] === opt.value ? '#FFD700' : '#888',
                  }}>
                  {opt.label}
                </button>
              ))}
            </div>
          )}
          {q.type === 'multi_field' && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
              {q.fields.map(f => (
                <div key={f.key}>
                  <div style={{ fontSize: 10, color: '#666', marginBottom: 2 }}>{f.label}</div>
                  {f.type === 'select' ? (
                    <select
                      onChange={e => setAnswers(a => ({ ...a, [q.id]: { ...(a[q.id] || {}), [f.key]: e.target.value } }))}
                      style={{ padding: '3px 6px', fontSize: 11, background: '#1a1a1a', color: '#ccc', border: '1px solid #444', borderRadius: 3 }}>
                      <option value="">Select…</option>
                      {f.options.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input type={f.type} placeholder={f.placeholder}
                      onChange={e => setAnswers(a => ({ ...a, [q.id]: { ...(a[q.id] || {}), [f.key]: e.target.value } }))}
                      style={{ padding: '3px 6px', fontSize: 11, background: '#1a1a1a', color: '#ccc', border: '1px solid #444', borderRadius: 3, width: 80 }} />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      <button onClick={handleSave} disabled={!hasAnswers || saving}
        style={{
          padding: '7px 18px', borderRadius: 5, fontWeight: 700, fontSize: 12,
          cursor: hasAnswers && !saving ? 'pointer' : 'default',
          background: hasAnswers ? 'rgba(212,160,23,0.15)' : 'transparent',
          border: `1px solid ${hasAnswers ? '#D4A017' : '#333'}`,
          color:  hasAnswers ? '#FFD700' : '#555',
        }}>
        {saving ? 'SAVING…' : 'SAVE AND RESCORE'}
      </button>
    </div>
  );
}

// ── TradeCard ─────────────────────────────────────────────────────────────────
function TradeCard({ entry: initialEntry, onTickerClick, saveNotes, onConfirmScore, focusRef, autoExpand, allEntries }) {
  const [entry, setEntry] = useState(initialEntry);
  // Always start collapsed — user expands the cards they want to review.
  // autoExpand overrides when navigating here directly from Assistant.
  const isConfirmed = !!initialEntry.userConfirmed?.confirmedAt;
  const [expanded, setExpanded] = useState(autoExpand || false);
  const [showCompleteScore, setShowCompleteScore] = useState(false);
  const [showChart, setShowChart] = useState(false);
  const [localNotes, setLocalNotes] = useState({ tradeNotes: entry.tradeNotes || '', macroNotes: entry.macroNotes || '' });

  const disc      = entry.discipline || {};
  const pendingQs = getScoreQuestions(entry, disc); // drives the header status badge
  const chk       = computeChecks(entry);
  const dir       = entry.direction || 'LONG';
  const exits     = Array.isArray(entry.exits) ? entry.exits : [];
  const lastExit  = exits[exits.length - 1];
  const lots      = Array.isArray(entry.lots) ? entry.lots : [];
  const pnl       = entry.performance?.realizedPnlDollar ?? entry.totalPnL ?? null;
  const pnlPct    = entry.performance?.realizedPnlPct ?? (() => {
    if (pnl == null) return null;
    const costBasis = lots.reduce((s, l) => s + (l.price || 0) * (l.shares || 0), 0);
    return costBasis > 0 ? +(pnl / costBasis * 100).toFixed(2) : null;
  })();
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
    SECT:   'Sector trend alignment. ✓ = traded with sector ETF OpEMA direction. Scored T1-D (0-7 pts).',
    SIG:    'Signal quality. ✓ = fresh BL+1/SS+1. ✗ = stale signal. ⚠ = no PNTHR signal. Scored T1-A (0-15 pts).',
    EXIT:   'Exit discipline. ✓ = system rule (signal/stop/feast/stale). ✗ = manual override. Scored T3-A (0-12 pts).',
    '~EARLY': '✓ = ran to system exit. ✗ = manually closed before signal. Part of T3-B scoring.',
    'ON SIG': '✓ = exited on BE/SE signal specifically. ✗ = any other exit reason. Part of T3-B scoring.',
    WASH:   'Wash sale compliance. ✓ = no active wash window. ✗ = entered during 30-day wash window. Scored T3-C (0-5 pts).',
    SIZE:   'Position sizing. ✓ = Lot 1 shares within 10% of SIZE IT calculation. Scored T2-A (0-8 pts).',
    CAP:    'Risk cap. ✓ = within 1% Vitality (stocks) or 0.5% (ETFs). ✗ = exceeded cap. Scored T2-B (0-5 pts).',
    SLIP:   'Slippage. ✓ = under 1%. ⚠ = 1-2%. ✗ = over 2%. N/A = no signal price. Scored T2-C (0-5 pts).',
    L1: 'Lot 1 — The Scent (35% of position). Always ✓ for closed trades.',
    L2: 'Lot 2 — The Stalk (25%). ✓ = trigger reached and filled. ✗ = trigger reached but skipped. N/A = trigger never reached.',
    L3: 'Lot 3 — The Strike (20%). Same logic. Scored as part of T2-D Pyramiding.',
    L4: 'Lot 4 — The Jugular (12%). Same logic.',
    L5: 'Lot 5 — The Kill (8%). Same logic.',
    HELD:  '✓ = held through drawdown (stop managed risk). ✗ = panic sold (manual exit at a loss). Scored T2-E (0-7 pts).',
    RECYC: '✓ = stop rose above entry price (recycled position, $0 heat). ✗ = never recycled. Display only.',
  };

  return (
    <div ref={focusRef} style={{ background: '#111', border: focusRef ? '1px solid #f5a623' : '1px solid #222', borderRadius: 8, marginBottom: 12, overflow: 'hidden' }}>

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
            {safeStr(dir) || 'LONG'}
          </span>
          <span style={{ color: '#777', fontSize: '0.8rem' }}>{fmtDate(entry.entry?.fillDate || entry.createdAt)} → {fmtDate(lastExit?.date)}</span>
          {entry.exchange && <span style={{ color: '#555', fontSize: '0.75rem' }}>{entry.exchange}</span>}
          {/* Status badge: red count if questions remain, green check if all answered */}
          {pendingQs.length > 0 ? (
            <span
              onClick={e => { e.stopPropagation(); setExpanded(true); }}
              title={`${pendingQs.length} question${pendingQs.length > 1 ? 's' : ''} still need your answer — click to open`}
              style={{ background: 'rgba(220,53,69,0.2)', border: '1px solid #dc3545', color: '#ff6b6b', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <span style={{ background: '#dc3545', color: '#fff', borderRadius: '50%', width: 14, height: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 800 }}>{pendingQs.length}</span>
              ANSWER NEEDED
            </span>
          ) : (
            <>
              {entry.entryConfirmed?.allCaptured && (
                <span
                  title="Kill score, signal, regime, index &amp; sector trend were auto-captured at entry confirmation"
                  style={{ background: 'rgba(0,180,255,0.12)', border: '1px solid rgba(0,180,255,0.4)', color: '#39c0ff', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, letterSpacing: '0.05em' }}
                >
                  ⚡ AUTO
                </span>
              )}
              {entry.userConfirmed?.confirmedAt && (
                <span
                  onClick={e => { e.stopPropagation(); setShowCompleteScore(v => !v); }}
                  title="All questions answered — click to review or correct"
                  style={{ background: 'rgba(40,167,69,0.15)', border: '1px solid #28a745', color: '#6bcb77', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', cursor: 'pointer' }}
                >
                  ✓ VERIFIED
                </span>
              )}
            </>
          )}
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
              <div style={{ fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.04em' }}>{typeof disc.tierLabel === 'string' ? disc.tierLabel.split(' ')[0] : ''}</div>
            </div>
          )}
          {/* Trade chart icon */}
          <span
            onClick={e => { e.stopPropagation(); setShowChart(true); }}
            title="View trade chart"
            style={{
              fontSize: 14, cursor: 'pointer', color: '#555',
              padding: '2px 4px', borderRadius: 4,
              transition: 'color 0.15s',
            }}
            onMouseEnter={e => e.currentTarget.style.color = '#FFD700'}
            onMouseLeave={e => e.currentTarget.style.color = '#555'}
          >📊</span>
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
              components={Object.entries(disc.tier1.components).map(([,c]) => ({ name: typeof c.detail === 'string' ? c.detail.split(' ')[0] : safeStr(c.label), score: c.score, max: c.max, label: c.label }))} />
            <ScoreTierBox title="EXECUTION" subtotal={disc.tier2.total} max={disc.tier2.max}
              components={Object.entries(disc.tier2.components).map(([,c]) => ({ name: typeof c.detail === 'string' ? c.detail.split(' ')[0] : safeStr(c.label), score: c.score, max: c.max, label: c.label }))} />
            <ScoreTierBox title="EXIT" subtotal={disc.tier3.total} max={disc.tier3.max}
              components={Object.entries(disc.tier3.components).map(([,c]) => ({ name: typeof c.detail === 'string' ? c.detail.split(' ')[0] : safeStr(c.label), score: c.score, max: c.max, label: c.label }))} />
          </div>
        )}

        {/* ── Section 4: KILL SCORE ── */}
        <div style={{ padding: '8px 14px', borderBottom: '1px solid #1e1e1e' }}>
          {kse?.totalScore != null ? (
            <>
              <div style={{ display: 'flex', gap: 20, marginBottom: 6, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <DataCell label="KILL SCORE" value={`${Math.round(kse.totalScore)}${kse.pipelineMaxScore ? `/${Math.round(kse.pipelineMaxScore)}` : ''}`} color="#FFD700" />
                {kse.source && (
                  <span style={{
                    fontSize: 9,
                    color: kse.source === 'ANALYZE_SNAPSHOT' ? '#28a745'
                         : kse.source === 'QUEUE_ENTRY'      ? '#FFD700'
                         : kse.source === 'MONGODB_PIPELINE'  ? '#888'
                         : '#dc3545',
                    fontFamily: 'monospace',
                    marginLeft: 8,
                    opacity: 0.8,
                  }}>
                    {kse.source === 'ANALYZE_SNAPSHOT' ? '● live capture'
                     : kse.source === 'QUEUE_ENTRY'    ? '● queue data'
                     : kse.source === 'MONGODB_PIPELINE' ? '● pipeline data'
                     : '● unknown source'}
                  </span>
                )}
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
            {entry.signalPrice != null && <DataCell label="SIGNAL PRICE" value={fmtDollar(entry.signalPrice)} />}
            <DataCell label="STOP PRICE"  value={entry.entry?.stopPrice != null ? fmtDollar(entry.entry.stopPrice) : '—'} />

            <DataCell label="LOT 1 SHARES" value={lots[0]?.shares ?? '—'} />
            <DataCell label="TOTAL SHARES" value={lots.reduce((s,l)=>s+(l.shares||0),0) || '—'} />
            <DataCell label="LOTS FILLED"  value={`${lots.filter(l=>l.shares>0).length} of 5`} />
            <DataCell label="EXIT REASON"  value={exitReason || '—'} color={exitReason === 'MANUAL' ? '#dc3545' : exitReason === 'STOP_HIT' ? '#fd7e14' : '#28a745'} />

            <DataCell label="RISK $"   value={chk.riskDollar != null ? `$${Math.abs(chk.riskDollar).toFixed(2)}` : '—'} />
            <DataCell label="RISK %"   value={chk.riskPct != null ? `${chk.riskPct.toFixed(2)}%` : '—'} />
            {entry.mfe?.price != null && <DataCell label="MFE" value={`${fmtDollar(entry.mfe.price)} (${entry.mfe.percent?.toFixed(2)}%)`} color="#28a745" />}
            {entry.mae?.price != null && <DataCell label="MAE" value={`${fmtDollar(entry.mae.price)} (${entry.mae.percent?.toFixed(2)}%)`} color="#dc3545" />}

            <DataCell label="CALENDAR DAYS" value={calDays != null ? `${calDays}d` : '—'} />
            <DataCell label="TRADING DAYS"  value={tradDays != null ? `${tradDays}d` : '—'} />
            {captureRatio != null && <DataCell label="CAPTURE RATIO" value={`${captureRatio}%`} tooltip="Exit P&L as % of MFE. 100% = captured the entire move." />}
            {entry.navAtEntry != null && <DataCell label="NAV AT ENTRY" value={`$${entry.navAtEntry.toLocaleString()}`} />}
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

        {/* ── Complete Your Score / Review Confirmed Answers ── */}
        {(() => {
          const normalQs = getScoreQuestions(entry, disc);
          const isReviewMode = showCompleteScore && !!entry.userConfirmed?.confirmedAt;
          const reviewQs = isReviewMode ? getReviewQuestions(entry) : [];
          const activeQs = isReviewMode ? reviewQs : normalQs;
          const shouldShow = normalQs.length > 0 || showCompleteScore;
          if (!shouldShow) return null;
          return (
            <CompleteYourScore
              entry={entry}
              questions={activeQs}
              reviewMode={isReviewMode}
              onSave={(id, newScore, sentAnswers) => {
                setEntry(prev => ({
                  ...prev,
                  discipline: newScore,
                  userConfirmed: {
                    ...prev.userConfirmed,
                    confirmedAt: new Date(),
                    ...(sentAnswers?.signal      != null ? { signal:      sentAnswers.signal      } : {}),
                    ...(sentAnswers?.killScore   != null ? { killScore:   sentAnswers.killScore   } : {}),
                    ...(sentAnswers?.indexTrend  != null ? { indexTrend:  sentAnswers.indexTrend  } : {}),
                    ...(sentAnswers?.sectorTrend != null ? { sectorTrend: sentAnswers.sectorTrend } : {}),
                    ...(sentAnswers?.sizing      != null ? { sizing:      sentAnswers.sizing      } : {}),
                  },
                }));
                setShowCompleteScore(false);
                onConfirmScore?.(id, newScore);
              }}
            />
          );
        })()}
      </>}

      {showChart && (
        <ClosedTradeChartModal
          entry={entry}
          allEntries={allEntries || [entry]}
          onClose={() => setShowChart(false)}
        />
      )}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────
export default function ClosedTradeCards({ onTickerClick, focusPositionId, focusTicker }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const focusRef = useRef(null);

  useEffect(() => {
    setLoading(true);
    fetch(`${API_BASE}/api/journal/closed-scorecard`, { headers: authHeaders() })
      .then(r => r.ok ? r.json() : [])
      .then(data => { setEntries(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  // Scroll to focused card once entries are loaded
  useEffect(() => {
    if (!loading && focusPositionId && focusRef.current) {
      setTimeout(() => {
        focusRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 150);
    }
  }, [loading, focusPositionId]);

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

  // Sort by trade close date, newest first — use last exit date, fall back to createdAt
  const sortedEntries = [...entries].sort((a, b) => {
    const aDate = a.exits?.[a.exits.length - 1]?.date || a.createdAt;
    const bDate = b.exits?.[b.exits.length - 1]?.date || b.createdAt;
    return new Date(bDate) - new Date(aDate);
  });

  // Determine if any entry matches by positionId exactly.
  // If not, fall back to ticker match so the scroll target is always found.
  const hasPosIdMatch = focusPositionId
    ? sortedEntries.some(e => e.positionId?.toString() === focusPositionId?.toString())
    : false;

  return (
    <div style={{ padding: '0 0 24px' }}>
      {sortedEntries.map(e => {
        const isFocused = hasPosIdMatch
          ? !!(focusPositionId && e.positionId?.toString() === focusPositionId?.toString())
          : !!(focusTicker && e.ticker === focusTicker);
        return (
          <TradeCardBoundary key={e._id}>
            <TradeCard
              entry={e}
              onTickerClick={onTickerClick}
              saveNotes={saveNotes}
              focusRef={isFocused ? focusRef : null}
              allEntries={sortedEntries}
              autoExpand={isFocused}
              onConfirmScore={(id, newScore) => {
                setEntries(prev => prev.map(x => x._id?.toString() === id?.toString() ? { ...x, discipline: newScore } : x));
              }}
            />
          </TradeCardBoundary>
        );
      })}
    </div>
  );
}
