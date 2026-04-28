// client/src/components/ScorecardGrid.jsx
// ── PNTHR Closed Trades Scorecard Grid ────────────────────────────────────────

import React, { useState, useEffect, useCallback } from 'react';
import { API_BASE, authHeaders } from '../services/api';

// ── Discipline score color (matches JournalPage.jsx thresholds) ───────────────
function discColor(score) {
  if (score == null) return '#555';
  if (score >= 90) return '#6bcb77';  // ELITE
  if (score >= 75) return '#FFD700';  // STRONG
  if (score >= 60) return '#fd7e14';  // MODERATE
  if (score >= 40) return '#dc3545';  // WEAK
  return '#8b0000';                    // SYSTEM OVERRIDE
}
function discTierShort(label) {
  if (!label) return '';
  if (label.startsWith('ELITE'))    return 'ELITE';
  if (label.startsWith('STRONG'))   return 'STRONG';
  if (label.startsWith('MODERATE')) return 'MOD';
  if (label.startsWith('WEAK'))     return 'WEAK';
  return 'OVRD';
}

// ── Icon helpers ──────────────────────────────────────────────────────────────
const Check = () => <span style={{ color: '#28a745', fontSize: '1rem', fontWeight: 700 }}>✓</span>;
const XMark = () => <span style={{ color: '#dc3545', fontSize: '1rem', fontWeight: 700 }}>✗</span>;
const Warn  = () => <span style={{ color: '#FFD700', fontSize: '1rem', fontWeight: 700 }}>⚠</span>;
const Dash  = () => <span style={{ color: '#3a3a3a' }}>—</span>;
// N/A = intentionally not applicable (different from — which means data not captured)
const NAEl  = () => <span style={{ color: '#3d3d3d', fontSize: '0.68rem', letterSpacing: '0.03em' }}>N/A</span>;

// ── Format helpers ─────────────────────────────────────────────────────────────
function fmtDate(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (isNaN(dt)) return null;
  return `${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${String(dt.getUTCDate()).padStart(2, '0')}/${dt.getUTCFullYear()}`;
}

function getVixZone(vix) {
  if (vix == null) return null;
  if (vix <= 15) return { label: 'CALM',     color: '#28a745' };
  if (vix <= 20) return { label: 'NORMAL',   color: '#FFD700' };
  if (vix <= 30) return { label: 'ELEVATED', color: '#fd7e14' };
  return { label: 'FEAR', color: '#dc3545' };
}
function getSpreadColor(s) {
  if (s == null) return '#aaa';
  if (s < 0)    return '#dc3545';
  if (s < 0.25) return '#fd7e14';
  return '#28a745';
}
function getRegimeColor(r) {
  if (!r)              return '#aaa';
  if (r === 'BULLISH') return '#28a745';
  if (r === 'BEARISH') return '#dc3545';
  return '#FFD700';
}

// Defensive dimension scorer — handles number or sub-object with .score
function getDim(dims, n) {
  if (!dims) return null;
  const d = dims[`d${n}`];
  if (d == null) return null;
  if (typeof d === 'number') return d;
  if (typeof d === 'object' && d.score != null) return d.score;
  return null;
}

// ── Check computations ────────────────────────────────────────────────────────
// Returns values: true=✓  false=✗  'warn'=⚠  'na'=N/A  null=— (unknown)
function computeChecks(entry) {
  const dir        = entry.direction || 'LONG';
  const snapE      = entry.marketAtEntry || {};
  const exits      = Array.isArray(entry.exits) ? entry.exits : [];
  const lastExit   = exits[exits.length - 1];
  const exitReason = lastExit?.reason || null;
  const exitPrice  = lastExit?.price ?? null;
  const entryPrice = entry.entry?.fillPrice ?? entry.entryPrice ?? null;
  const stopPrice  = entry.entry?.stopPrice ?? null;
  const nav        = entry.navAtEntry ?? null;
  const isETF      = entry.isETF || false;
  const lots       = Array.isArray(entry.lots) ? entry.lots : [];
  const lot1Shares = lots[0]?.shares ?? null;
  const mfePrice   = entry.mfe?.price ?? null;

  // ── Index trend ──
  const useQqq  = entry.exchange === 'NASDAQ';
  const idxPos  = useQqq ? snapE.qqqPosition : snapE.spyPosition;
  const indexTrend = idxPos != null
    ? (dir === 'LONG' ? idxPos === 'above' : idxPos === 'below')
    : null;

  // ── Sector trend — uses sectorPosition stored in marketAtEntry at backfill/entry time ──
  const sectPos    = snapE.sectorPosition ?? null;
  const sectorTrend = sectPos != null
    ? (dir === 'LONG' ? sectPos === 'above' : sectPos === 'below')
    : null;

  // ── Signal check ──
  const sig    = entry.signal;
  const sigAge = entry.signalAge ?? 0;
  let signalCheck = null;
  if (!sig || sig === 'PAUSE' || sig === 'NO_SIGNAL') {
    signalCheck = 'warn';
  } else if ((dir === 'LONG' && sig === 'BL' && sigAge <= 1) ||
             (dir === 'SHORT' && sig === 'SS' && sigAge <= 1)) {
    signalCheck = true;
  } else {
    signalCheck = false;
  }

  // ── Exit checks ──
  const systemExits = ['SIGNAL', 'STOP_HIT', 'FEAST', 'STALE_HUNT'];
  const exitCheck     = exitReason ? systemExits.includes(exitReason) : null;
  const notEarlyCheck = exitReason === 'MANUAL' ? false : (exitReason ? true : null);
  const onSignalCheck = exitReason === 'SIGNAL';

  // ── Wash rule ──
  const washClean = !(entry.tags?.includes('wash-sale'));

  // ── Sizing check ──
  // Mirrors sizePosition() in sizingUtils.js: min(vitality/rps, tickerCap/price) then ×gapMult.
  // We don't store maxGapPct in the journal, so gapMult=1.0 (conservative baseline).
  // Lot 1 expected = Math.max(1, Math.round(total × 0.35)) — same as buildLots().
  let sizingCheck  = null;
  let riskDollar   = null;
  let riskPct      = null;
  let riskCapCheck = null;
  if (nav != null && entryPrice != null && stopPrice != null && lot1Shares != null) {
    const stopDist    = Math.abs(entryPrice - stopPrice);
    const vitality    = nav * (isETF ? 0.005 : 0.01);
    const tickerCap   = nav * 0.10;
    if (stopDist > 0) {
      const byVitality  = Math.floor(vitality / stopDist);
      const byTickerCap = Math.floor(tickerCap / entryPrice);
      const totalShares = Math.min(byVitality, byTickerCap);
      const expected    = Math.max(1, Math.round(totalShares * 0.35));
      const deviation   = expected > 0 ? Math.abs(lot1Shares - expected) / expected : null;
      sizingCheck  = deviation != null ? deviation <= 0.10 : null;
      riskDollar   = +(lot1Shares * stopDist).toFixed(2);
      riskPct      = +(riskDollar / nav * 100).toFixed(3);
      riskCapCheck = riskDollar <= vitality;
    }
  }

  // ── Slippage — 'na' when no signalPrice (no PNTHR signal) ──
  const signalPrice = entry.signalPrice ?? null;
  // signalPrice === null AND explicitly stored as null → N/A (no signal existed)
  // signalPrice === undefined → unknown (data not captured yet) → show —
  const slipNA = entry.hasOwnProperty?.('signalPrice') && signalPrice === null;
  let slipDollar = slipNA ? 'na' : null;
  let slipPct    = slipNA ? 'na' : null;
  let slipCheck  = slipNA ? 'na' : null;
  if (signalPrice != null && entryPrice != null) {
    const sd  = +(dir === 'LONG' ? entryPrice - signalPrice : signalPrice - entryPrice).toFixed(4);
    const sp  = +(Math.abs(sd / signalPrice) * 100).toFixed(2);
    slipDollar = sd;
    slipPct    = sp;
    slipCheck  = sp < 1 ? true : sp <= 2 ? 'warn' : false;
  }

  // ── Lot discipline — use MFE to determine if trigger was reachable ──
  const LOT_MULT_LONG  = [1.03, 1.06, 1.10, 1.14];
  const LOT_MULT_SHORT = [0.97, 0.94, 0.90, 0.86];
  const getLotCheck = (n) => {
    if (n === 1) return true;
    const idx     = n - 2;
    const trigger = entryPrice != null
      ? entryPrice * (dir === 'LONG' ? LOT_MULT_LONG[idx] : LOT_MULT_SHORT[idx])
      : null;
    // If MFE available, determine if trigger was ever in reach
    if (mfePrice != null && trigger != null) {
      const reached = dir === 'LONG' ? mfePrice >= trigger : mfePrice <= trigger;
      if (!reached) return 'na';            // trigger never reached
      return lots.find(l => l.lot === n) ? true : false; // reached: filled=✓ skipped=✗
    }
    // MFE not available — filled=✓ unknown=—
    return lots.find(l => l.lot === n) ? true : null;
  };

  // ── Held drawdown ──
  const panicSold = exitReason === 'MANUAL' && exitPrice != null && entryPrice != null && (
    (dir === 'LONG'  && exitPrice < entryPrice) ||
    (dir === 'SHORT' && exitPrice > entryPrice)
  );
  const heldDrawdown = !panicSold;

  // ── Recycled ──
  const recycledCheck = 'wasRecycled' in (entry || {})
    ? entry.wasRecycled
    : null;

  return {
    indexTrend, sectorTrend, signalCheck, exitCheck, notEarlyCheck, onSignalCheck, washClean,
    sizingCheck, riskDollar, riskPct, riskCapCheck,
    slipDollar, slipPct, slipCheck, slipNA,
    lot1: getLotCheck(1), lot2: getLotCheck(2), lot3: getLotCheck(3),
    lot4: getLotCheck(4), lot5: getLotCheck(5),
    heldDrawdown, recycledCheck,
  };
}

// ── Styles ────────────────────────────────────────────────────────────────────
const cell = {
  padding: '4px 6px',
  fontSize: '0.74rem',
  color: '#ccc',
  whiteSpace: 'nowrap',
  borderBottom: '1px solid #1e1e1e',
  textAlign: 'center',
};
const hdr = {
  ...cell,
  color: '#555',
  fontWeight: 700,
  fontSize: '0.64rem',
  letterSpacing: '0.04em',
  backgroundColor: '#141414',
  borderBottom: '2px solid #2a2a2a',
  position: 'sticky',
  top: 0,
  zIndex: 1,
  cursor: 'help',
};
const sticky = { position: 'sticky', left: 0, zIndex: 2, backgroundColor: '#1a1a1a' };

// ── Tooltips ─────────────────────────────────────────────────────────────────
const TIP = {
  ticker:       'Stock symbol and trade direction',
  entryDate:    'Date position was opened (Lot 1 fill date)',
  exitDate:     'Date position was fully closed',
  exchange:     'Stock exchange: NYSE or NASDAQ',
  indexTrend:   'Index trend alignment. ✓ = traded with S&P 500 or Nasdaq 100 direction. ✗ = traded against the index trend',
  sector:       'GICS sector classification',
  sectorTrend:  'Sector trend alignment. ✓ = traded with sector ETF OpEMA direction. ✗ = traded against sector trend',
  entrySignal:  'Entry signal at time of trade. BL+1 = fresh buy long, SS+1 = fresh sell short, NO SIGNAL = no PNTHR signal existed',
  signalCheck:  'Signal quality check. ✓ = entered on fresh signal (BL+1 or SS+1). ✗ = stale signal (BL+2 or later). ⚠ = no signal (PAUSE)',
  exitSignal:   'Exit reason. SIGNAL = system BE/SE exit. STOP_HIT = stopped out. MANUAL = manual override. FEAST = RSI > 85. STALE_HUNT = 20-day expiry',
  exitCheck:    'Exit discipline. ✓ = exited via system rule (signal, stop, FEAST, stale hunt). ✗ = manual override',
  notEarly:     'Closed early check. ✓ = trade ran to system exit. ✗ = manually closed before system signaled exit',
  onSignal:     'Closed on signal. ✓ = exited on BE/SE signal specifically. ✗ = any other exit reason',
  washRule:     'Wash sale rule. ✓ = no active wash window when entered. ✗ = entered during a 30-day wash window from a prior loss',
  sizingCheck:  'Position sizing discipline. ✓ = Lot 1 shares within 10% of SIZE IT calculation. ✗ = oversized or undersized',
  riskDollar:   'Actual dollar risk at entry (Lot 1 shares × distance to stop)',
  riskPct:      'Risk as percentage of NAV at time of entry',
  riskCapCheck: 'Risk cap check. ✓ = risk within 1% Vitality (stocks) or 0.5% (ETFs). ✗ = exceeded Vitality cap',
  slipDollar:   'Entry slippage in dollars (fill price minus signal price). N/A = no PNTHR signal existed at entry',
  slipPct:      'Entry slippage as percentage of signal price. N/A = no PNTHR signal existed at entry',
  slipCheck:    'Slippage check. ✓ = under 1%. ⚠ = 1-2%. ✗ = over 2%. N/A = no signal price to compare',
  lot1:         'Lot 1 — The Scent (35% of position). Always ✓ for closed trades',
  lot2:         'Lot 2 — The Stalk (25%). ✓ = trigger hit and filled. ✗ = trigger hit but skipped. N/A = trigger never reached',
  lot3:         'Lot 3 — The Strike (20%). ✓ = trigger hit and filled. ✗ = trigger hit but skipped. N/A = trigger never reached',
  lot4:         'Lot 4 — The Jugular (12%). ✓ = trigger hit and filled. ✗ = trigger hit but skipped. N/A = trigger never reached',
  lot5:         'Lot 5 — The Kill (8%). ✓ = trigger hit and filled. ✗ = trigger hit but skipped. N/A = trigger never reached',
  heldDrawdown: 'Held through first drawdown. ✓ = did not panic sell. ✗ = manually exited at a loss before stop was hit',
  recycled:     'Position recycled to $0 risk. ✓ = stop rose above entry price. ✗ = never recycled. N/A = data not yet tracked',
  killScore:    'Kill score at entry vs pipeline max (e.g., 123/150). N/A = stock was not in the Kill pipeline',
  rank:         'Kill rank position at time of entry (e.g., #12 of 679). N/A = not in pipeline',
  rankChange:   'Rank change from prior week (+35 = rising, -12 = falling, NEW = first appearance). N/A = not in pipeline',
  tier:         'Kill tier name at entry (ALPHA PNTHR KILL, STRIKING, HUNTING, etc.). N/A = not in pipeline',
  d1:           'D1: Market Regime Multiplier (0.70× to 1.30×). Amplifies or dampens total score based on market regime',
  d2:           'D2: Sector Alignment score (–15 to +15 pts)',
  d3:           'D3: Entry Quality — dominant predictor (0 to 85 pts). Includes bell curve separation and close conviction',
  d4:           'D4: Signal Freshness (–15 to +10 pts)',
  d5:           'D5: Rank Rise — delta from prior position (–20 to +20 pts)',
  d6:           'D6: Momentum — RSI, OBV, ADX, EMA conviction (–10 to +20 pts)',
  d7:           'D7: Rank Velocity — acceleration of rank change (–10 to +10 pts)',
  d8:           'D8: Multi-Strategy Confirmation — Prey presence (0 to 6 pts)',
  disc:         'Discipline Score v2 (0-100). 90+=ELITE · 75+=STRONG · 60+=MODERATE · 40+=WEAK · <40=SYSTEM OVERRIDE. T1: Stock Selection (40), T2: Execution (35), T3: Exit (25)',
  pnlDollar:    'Total realized profit or loss in dollars',
  pnlPct:       'Total realized profit or loss as percentage of entry cost (Lot 1 shares × entry price)',
};

const B_TIP = {
  spy:      'S&P 500 ETF price at time of snapshot',
  spyVsEma: 'SPY percentage distance from 21W Index EMA. Negative = below EMA (bearish)',
  spyTrend: 'SPY trend check. ✓ = traded with SPY trend. ✗ = traded against SPY trend',
  qqq:      'Nasdaq 100 ETF price at time of snapshot',
  qqqVsEma: 'QQQ percentage distance from 21W Index EMA',
  qqqTrend: 'QQQ trend check. ✓ = traded with QQQ trend. ✗ = traded against QQQ trend',
  vix:      'CBOE Volatility Index level',
  vixZone:  'VIX zone: CALM (≤15), NORMAL (15-20), ELEVATED (20-30), FEAR (30+)',
  regime:   'Market regime: BULLISH (both above EMA), BEARISH (both below), MIXED',
  y2:       '2-Year Treasury yield — Fed policy proxy',
  y10:      '10-Year Treasury yield',
  y30:      '30-Year Treasury yield — long duration risk',
  spread:   'Yield curve spread (10Y minus 2Y). Negative = inverted curve (recession signal)',
  dxy:      'US Dollar Index',
  crude:    'WTI crude oil price',
  gold:     'Gold spot price',
  sectEtf:  'Sector ETF ticker and price at time of snapshot',
  sect1D:   'Sector ETF 1-day return at time of snapshot',
};

// ── Column definitions ────────────────────────────────────────────────────────
const A_COLS = [
  { key: 'entryDate',    label: 'ENTRY',    w: 84  },
  { key: 'exitDate',     label: 'EXIT',     w: 84  },
  { key: 'exchange',     label: 'EXCH',     w: 58  },
  { key: 'indexTrend',   label: 'IDX ✓',   w: 48  },
  { key: 'sector',       label: 'SECTOR',   w: 120 },
  { key: 'sectorTrend',  label: 'SECT ✓',  w: 52  },
  { key: 'entrySignal',  label: 'SIG',      w: 80  },
  { key: 'signalCheck',  label: 'SIG ✓',   w: 46  },
  { key: 'exitSignal',   label: 'EXIT SIG', w: 82  },
  { key: 'exitCheck',    label: 'EXIT ✓',  w: 48  },
  { key: 'notEarly',     label: '¬EARLY',  w: 50  },
  { key: 'onSignal',     label: 'ON SIG',   w: 54  },
  { key: 'washRule',     label: 'WASH ✓',  w: 52  },
  { key: 'sizingCheck',  label: 'SIZE ✓',  w: 48  },
  { key: 'riskDollar',   label: 'RISK $',   w: 68  },
  { key: 'riskPct',      label: 'RISK %',   w: 60  },
  { key: 'riskCapCheck', label: 'CAP ✓',   w: 46  },
  { key: 'slipDollar',   label: 'SLIP $',   w: 62  },
  { key: 'slipPct',      label: 'SLIP %',   w: 56  },
  { key: 'slipCheck',    label: 'SLIP ✓',  w: 48  },
  { key: 'lot1',         label: 'L1',       w: 36  },
  { key: 'lot2',         label: 'L2',       w: 36  },
  { key: 'lot3',         label: 'L3',       w: 36  },
  { key: 'lot4',         label: 'L4',       w: 36  },
  { key: 'lot5',         label: 'L5',       w: 36  },
  { key: 'heldDrawdown', label: 'HELD ✓',  w: 50  },
  { key: 'recycled',     label: 'RECYCLED', w: 60  },
  { key: 'killScore',    label: 'KILL',     w: 66  },
  { key: 'rank',         label: 'RANK',     w: 48  },
  { key: 'rankChange',   label: 'ΔRANK',   w: 54  },
  { key: 'tier',         label: 'TIER',     w: 120 },
  { key: 'd1',           label: 'D1',       w: 50  },
  { key: 'd2',           label: 'D2',       w: 38  },
  { key: 'd3',           label: 'D3',       w: 38  },
  { key: 'd4',           label: 'D4',       w: 38  },
  { key: 'd5',           label: 'D5',       w: 38  },
  { key: 'd6',           label: 'D6',       w: 38  },
  { key: 'd7',           label: 'D7',       w: 38  },
  { key: 'd8',           label: 'D8',       w: 38  },
  { key: 'disc',         label: 'DISC',     w: 70  },
  { key: 'pnlDollar',    label: 'P&L $',    w: 78  },
  { key: 'pnlPct',       label: 'P&L %',    w: 66  },
];
const TOTAL_COLS = 1 + A_COLS.length;

// ── Section B ─────────────────────────────────────────────────────────────────
const B_COLS  = ['spy','spyVsEma','spyTrend','qqq','qqqVsEma','qqqTrend',
  'vix','vixZone','regime','y2','y10','y30','spread','dxy','crude','gold','sectEtf','sect1D'];
const B_LABEL = {
  spy:'SPY', spyVsEma:'SPY/EMA', spyTrend:'SPY✓',
  qqq:'QQQ', qqqVsEma:'QQQ/EMA', qqqTrend:'QQQ✓',
  vix:'VIX', vixZone:'ZONE', regime:'REGIME',
  y2:'2Y', y10:'10Y', y30:'30Y', spread:'2Y-10Y',
  dxy:'DXY', crude:'CRUDE', gold:'GOLD',
  sectEtf:'SECT ETF', sect1D:'SECT 1D%',
};

function BCell({ id, snap, dir }) {
  if (!snap) return null;
  const tip  = B_TIP[id] || '';
  const lbl  = <span title={tip} style={{ color: '#3a3a3a', fontSize: '0.64rem', marginRight: 2, cursor: 'help' }}>{B_LABEL[id]}:</span>;
  const base = { fontSize: '0.74rem', color: '#aaa', marginRight: 10, whiteSpace: 'nowrap' };
  const na   = <span style={{ ...base, color: '#3d3d3d', fontSize: '0.68rem' }}>{lbl}N/A</span>;

  switch (id) {
    case 'spy':
      return snap.spyPrice != null ? <span style={base}>{lbl}${snap.spyPrice.toFixed(2)}</span> : na;
    case 'spyVsEma': {
      const v = snap.spyVsEma;
      return v != null ? <span style={{ ...base, color: v >= 0 ? '#28a745' : '#dc3545' }}>{lbl}{v >= 0 ? '+' : ''}{v.toFixed(2)}%</span> : na;
    }
    case 'spyTrend': {
      const pos = snap.spyPosition;
      if (!pos) return na;
      const ok = dir === 'LONG' ? pos === 'above' : pos === 'below';
      return <span style={{ ...base, color: ok ? '#28a745' : '#dc3545' }}>{lbl}{ok ? '✓' : '✗'}</span>;
    }
    case 'qqq':
      return snap.qqqPrice != null ? <span style={base}>{lbl}${snap.qqqPrice.toFixed(2)}</span> : na;
    case 'qqqVsEma': {
      const v = snap.qqqVsEma;
      return v != null ? <span style={{ ...base, color: v >= 0 ? '#28a745' : '#dc3545' }}>{lbl}{v >= 0 ? '+' : ''}{v.toFixed(2)}%</span> : na;
    }
    case 'qqqTrend': {
      const pos = snap.qqqPosition;
      if (!pos) return na;
      const ok = dir === 'LONG' ? pos === 'above' : pos === 'below';
      return <span style={{ ...base, color: ok ? '#28a745' : '#dc3545' }}>{lbl}{ok ? '✓' : '✗'}</span>;
    }
    case 'vix':
      return snap.vix != null ? <span style={base}>{lbl}{snap.vix.toFixed(1)}</span> : na;
    case 'vixZone': {
      const z = getVixZone(snap.vix);
      return z ? <span style={{ ...base, color: z.color }}>{lbl}{z.label}</span> : na;
    }
    case 'regime':
      return snap.regime ? <span style={{ ...base, color: getRegimeColor(snap.regime) }}>{lbl}{snap.regime}</span> : na;
    case 'y2':
      return snap.treasury2Y != null ? <span style={base}>{lbl}{snap.treasury2Y.toFixed(2)}%</span> : na;
    case 'y10':
      return snap.treasury10Y != null ? <span style={base}>{lbl}{snap.treasury10Y.toFixed(2)}%</span> : na;
    case 'y30':
      return snap.treasury30Y != null ? <span style={base}>{lbl}{snap.treasury30Y.toFixed(2)}%</span> : na;
    case 'spread': {
      const s = snap.spread2Y10Y;
      return s != null ? <span style={{ ...base, color: getSpreadColor(s) }}>{lbl}{s >= 0 ? '+' : ''}{s.toFixed(3)}%</span> : na;
    }
    case 'dxy':
      return snap.dxy != null ? <span style={base}>{lbl}{snap.dxy.toFixed(2)}</span> : na;
    case 'crude':
      return snap.crudeOil != null ? <span style={base}>{lbl}${snap.crudeOil.toFixed(2)}</span> : na;
    case 'gold':
      return snap.gold != null ? <span style={base}>{lbl}${Math.round(snap.gold).toLocaleString()}</span> : na;
    case 'sectEtf':
      return snap.sectorEtf
        ? <span style={base}>{lbl}{snap.sectorEtf}{snap.sectorPrice != null ? ` $${snap.sectorPrice.toFixed(2)}` : ''}</span>
        : na;
    case 'sect1D': {
      const v = snap.sectorChange1D;
      return v != null ? <span style={{ ...base, color: v >= 0 ? '#28a745' : '#dc3545' }}>{lbl}{v >= 0 ? '+' : ''}{v.toFixed(2)}%</span> : na;
    }
    default: return null;
  }
}

// ── CheckCell — v: true=✓  false=✗  'warn'=⚠  'na'=N/A  null=— ─────────────
function CC({ v }) {
  return (
    <td style={cell}>
      {v === true    ? <Check />
        : v === false  ? <XMark />
        : v === 'warn' ? <Warn />
        : v === 'na'   ? <NAEl />
        : <Dash />}
    </td>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function ScorecardGrid({ onTickerClick }) {
  const [entries,    setEntries]    = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [localNotes, setLocalNotes] = useState({});

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

  const getNote = (entry, field) => {
    const id = entry._id?.toString() || '';
    return localNotes[id]?.[field] ?? entry[field] ?? '';
  };
  const setNote = (entry, field, value) => {
    const id = entry._id?.toString() || '';
    setLocalNotes(prev => ({ ...prev, [id]: { ...(prev[id] || {}), [field]: value } }));
  };

  if (loading) return (
    <div style={{ padding: 48, textAlign: 'center', color: '#555', fontSize: 13 }}>Loading scorecard…</div>
  );
  if (!entries.length) return (
    <div style={{ padding: 48, textAlign: 'center', color: '#555', fontSize: 13 }}>No closed trades yet.</div>
  );

  return (
    <div style={{ overflowX: 'auto', overflowY: 'visible', background: '#111', borderRadius: 10 }}>
      <table style={{ borderCollapse: 'collapse', width: 'max-content', fontSize: '0.74rem', tableLayout: 'fixed' }}>

        <colgroup>
          <col style={{ width: 88 }} />
          {A_COLS.map(c => <col key={c.key} style={{ width: c.w }} />)}
        </colgroup>

        <thead>
          <tr>
            <th title={TIP.ticker} style={{ ...hdr, ...sticky, zIndex: 3, textAlign: 'left', width: 88 }}>TICKER</th>
            {A_COLS.map(c => (
              <th key={c.key} title={TIP[c.key] || ''} style={hdr}>{c.label}</th>
            ))}
          </tr>
        </thead>

        <tbody>
          {entries.map((entry, idx) => {
            const id       = entry._id?.toString() || String(idx);
            const chk      = computeChecks(entry);
            const dir      = entry.direction || 'LONG';
            const exits    = Array.isArray(entry.exits) ? entry.exits : [];
            const lastExit = exits[exits.length - 1];
            const exitReason = lastExit?.reason || null;
            const lots     = Array.isArray(entry.lots) ? entry.lots : [];

            // P&L — compute pct from scratch if not stored
            const pnl    = entry.performance?.realizedPnlDollar ?? entry.totalPnL ?? null;
            let pnlPct   = entry.performance?.realizedPnlPct ?? entry.totalPnlPct ?? null;
            if (pnlPct == null && pnl != null) {
              const ep = entry.entry?.fillPrice ?? entry.entryPrice ?? null;
              const totalSh = lots.reduce((s, l) => s + (l.shares || 0), 0);
              if (ep != null && totalSh > 0) pnlPct = +(pnl / (ep * totalSh) * 100).toFixed(2);
            }
            const pnlColor  = pnl    != null ? (pnl    >= 0 ? '#28a745' : '#dc3545') : '#555';
            const pnlPctClr = pnlPct != null ? (pnlPct >= 0 ? '#28a745' : '#dc3545') : '#555';

            // Entry signal label — "NO SIGNAL" when no signal
            const sig    = entry.signal;
            const sigAge = entry.signalAge;
            const sigLabel = (!sig || sig === 'PAUSE' || sig === 'NO_SIGNAL')
              ? 'NO SIGNAL'
              : sigAge != null ? `${sig}+${sigAge}` : sig;

            // Kill score — null (explicitly) = not in pipeline → N/A; undefined = unknown → —
            const kseNull    = entry.killScoreAtEntry === null;  // explicitly not in pipeline
            const kse        = entry.killScoreAtEntry || {};
            const dims       = kse.dimensions || null;
            const inPipeline = !kseNull && kse.totalScore != null;

            // Rank change display
            const rc = kse.rankChange;
            const rcLabel = rc == null ? 'NEW' : rc > 0 ? `+${rc}` : String(rc);
            const rcColor = rc == null ? '#FFD700' : rc > 0 ? '#28a745' : '#dc3545';

            const d1Label  = kse.d1 != null ? `${Number(kse.d1).toFixed(2)}×` : null;
            const snapE    = entry.marketAtEntry || null;
            const snapX    = entry.marketAtExit  || null;
            const rowBg    = idx % 2 === 0 ? '#161616' : '#141414';

            // Helper: N/A cell for pipeline-absent fields
            const naCell = <td style={cell}><NAEl /></td>;

            return (
              <React.Fragment key={id}>

                {/* ── Section A label ── */}
                <tr>
                  <td colSpan={TOTAL_COLS} style={{
                    backgroundColor: 'rgba(212,160,23,0.07)',
                    borderTop: '1px solid rgba(212,160,23,0.22)',
                    borderBottom: '1px solid rgba(212,160,23,0.13)',
                    padding: '3px 12px',
                    color: '#D4A017', fontWeight: 700, fontSize: '0.62rem', letterSpacing: '0.12em',
                  }}>
                    SECTION A · TRADE DISCIPLINE
                  </td>
                </tr>

                {/* ── Section A data row ── */}
                <tr style={{ backgroundColor: rowBg }}>

                  {/* TICKER (sticky) */}
                  <td style={{ ...cell, ...sticky, textAlign: 'left', paddingLeft: 10 }}>
                    <span style={{ color: '#fcf000', cursor: 'pointer', fontWeight: 700, fontSize: '0.8rem' }}
                      onClick={() => onTickerClick?.(entry.ticker)}>
                      {entry.ticker}
                    </span>
                    <div style={{ fontSize: '0.62rem', color: dir === 'LONG' ? '#28a745' : '#dc3545', marginTop: 1 }}>
                      {dir}
                    </div>
                  </td>

                  {/* A2: ENTRY DATE */}
                  <td style={cell}>{fmtDate(entry.entry?.fillDate || entry.entryDate) ?? <Dash />}</td>
                  {/* A3: EXIT DATE */}
                  <td style={cell}>{fmtDate(lastExit?.date) ?? <Dash />}</td>
                  {/* A4: EXCHANGE */}
                  <td style={{ ...cell, color: '#777' }}>{entry.exchange || <Dash />}</td>
                  {/* A5: INDEX TREND */}
                  <CC v={chk.indexTrend} />
                  {/* A6: SECTOR */}
                  <td style={{ ...cell, fontSize: '0.68rem', textAlign: 'left' }}>{entry.sector || <Dash />}</td>
                  {/* A7: SECTOR TREND */}
                  <CC v={chk.sectorTrend} />
                  {/* A8: ENTRY SIGNAL */}
                  <td style={{ ...cell, color: sig ? '#ccc' : '#555', fontSize: '0.7rem' }}>{sigLabel}</td>
                  {/* A9: SIGNAL CHECK */}
                  <CC v={chk.signalCheck} />
                  {/* A10: EXIT SIGNAL */}
                  <td style={{ ...cell, fontSize: '0.68rem', color: '#999' }}>{exitReason || <Dash />}</td>
                  {/* A11: EXIT CHECK */}
                  <CC v={chk.exitCheck} />
                  {/* A12: NOT EARLY */}
                  <CC v={chk.notEarlyCheck} />
                  {/* A13: ON SIGNAL */}
                  <CC v={chk.onSignalCheck} />
                  {/* A14: WASH RULE */}
                  <CC v={chk.washClean} />
                  {/* A15: SIZING CHECK */}
                  <CC v={chk.sizingCheck} />
                  {/* A16: RISK $ */}
                  <td style={{ ...cell, color: chk.riskCapCheck === false ? '#dc3545' : '#aaa' }}>
                    {chk.riskDollar != null ? `$${Math.abs(chk.riskDollar).toFixed(2)}` : <Dash />}
                  </td>
                  {/* A17: RISK % */}
                  <td style={{ ...cell, color: chk.riskCapCheck === false ? '#dc3545' : '#aaa' }}>
                    {chk.riskPct != null ? `${chk.riskPct.toFixed(2)}%` : <Dash />}
                  </td>
                  {/* A18: RISK CAP CHECK */}
                  <CC v={chk.riskCapCheck} />

                  {/* A19: SLIP $ — N/A when no signal price */}
                  <td style={cell}>
                    {chk.slipDollar === 'na' ? <NAEl />
                      : chk.slipDollar != null ? `$${Math.abs(chk.slipDollar).toFixed(2)}`
                      : <Dash />}
                  </td>
                  {/* A20: SLIP % */}
                  <td style={cell}>
                    {chk.slipPct === 'na' ? <NAEl />
                      : chk.slipPct != null ? `${chk.slipPct.toFixed(2)}%`
                      : <Dash />}
                  </td>
                  {/* A21: SLIP CHECK */}
                  <CC v={chk.slipCheck} />

                  {/* A22-A26: LOT 1-5 */}
                  <CC v={chk.lot1} />
                  <CC v={chk.lot2} />
                  <CC v={chk.lot3} />
                  <CC v={chk.lot4} />
                  <CC v={chk.lot5} />

                  {/* A27: HELD DRAWDOWN */}
                  <CC v={chk.heldDrawdown} />
                  {/* A28: RECYCLED */}
                  <CC v={chk.recycledCheck} />

                  {/* A29: KILL SCORE */}
                  {kseNull ? naCell :
                    <td style={{ ...cell, color: '#FFD700' }}>
                      {inPipeline
                        ? `${Math.round(kse.totalScore)}${kse.pipelineMaxScore != null ? `/${Math.round(kse.pipelineMaxScore)}` : ''}`
                        : <Dash />}
                    </td>}
                  {/* A30: RANK */}
                  {kseNull ? naCell :
                    <td style={cell}>{inPipeline && kse.rank != null ? `#${kse.rank}` : <Dash />}</td>}
                  {/* A31: RANK CHANGE */}
                  {kseNull ? naCell :
                    <td style={{ ...cell, color: rcColor }}>
                      {inPipeline ? rcLabel : <Dash />}
                    </td>}
                  {/* A32: TIER */}
                  {kseNull ? naCell :
                    <td style={{ ...cell, fontSize: '0.65rem', color: '#FFD700', textAlign: 'left' }}>
                      {inPipeline && kse.tier ? kse.tier : <Dash />}
                    </td>}
                  {/* A33: D1 */}
                  {kseNull ? naCell :
                    <td style={{ ...cell, color: '#aaa' }}>{d1Label ?? <Dash />}</td>}
                  {/* A34-A40: D2-D8 */}
                  {[2, 3, 4, 5, 6, 7, 8].map(n => {
                    if (kseNull) return <td key={n} style={cell}><NAEl /></td>;
                    const v = getDim(dims, n);
                    const c = v == null ? '#3a3a3a' : v > 0 ? '#28a745' : v < 0 ? '#dc3545' : '#666';
                    return (
                      <td key={n} style={{ ...cell, color: c }}>
                        {v != null ? (v > 0 ? `+${Math.round(v)}` : `${Math.round(v)}`) : <Dash />}
                      </td>
                    );
                  })}

                  {/* DISC: Discipline Score v2 */}
                  {(() => {
                    const ds = entry.discipline;
                    const score = ds?.totalScore;
                    const tier  = ds?.tierLabel;
                    return (
                      <td style={{ ...cell, textAlign: 'center' }}>
                        {score != null
                          ? <>
                              <div style={{ color: discColor(score), fontWeight: 800, fontSize: '0.82rem', lineHeight: 1.1 }}>{score}</div>
                              <div style={{ color: '#444', fontSize: '0.58rem', letterSpacing: '0.04em', marginTop: 1 }}>{discTierShort(tier)}</div>
                            </>
                          : <Dash />}
                      </td>
                    );
                  })()}
                  {/* P&L $ */}
                  <td style={{ ...cell, color: pnlColor, fontWeight: 600 }}>
                    {pnl != null ? (pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`) : <Dash />}
                  </td>
                  {/* P&L % */}
                  <td style={{ ...cell, color: pnlPctClr, fontWeight: 600 }}>
                    {pnlPct != null ? `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%` : <Dash />}
                  </td>
                </tr>

                {/* ── Section A notes ── */}
                <tr style={{ backgroundColor: 'rgba(255,255,255,0.015)' }}>
                  <td style={{ ...cell, ...sticky, color: '#3a3a3a', fontSize: '0.6rem', fontStyle: 'italic', paddingLeft: 10 }}>
                    A NOTES
                  </td>
                  <td colSpan={A_COLS.length} style={{ padding: '3px 10px', borderBottom: '1px solid #1e1e1e' }}>
                    <input type="text" value={getNote(entry, 'tradeNotes')}
                      onChange={e => setNote(entry, 'tradeNotes', e.target.value)}
                      onBlur={e  => saveNotes(id, 'tradeNotes', e.target.value)}
                      placeholder="Add trade notes — why I took this, chart thesis, what I saw..."
                      style={{ background: 'transparent', border: 'none', color: '#888', width: '100%', fontStyle: 'italic', fontSize: '0.76rem', outline: 'none' }}
                    />
                  </td>
                </tr>

                {/* ── Section B label ── */}
                <tr>
                  <td colSpan={TOTAL_COLS} style={{
                    backgroundColor: 'rgba(80,80,80,0.12)',
                    borderTop: '1px solid #2a2a2a',
                    borderBottom: '1px solid #2a2a2a',
                    padding: '3px 12px',
                    color: '#666', fontWeight: 700, fontSize: '0.6rem', letterSpacing: '0.12em',
                  }}>
                    SECTION B · MARKET CONDITIONS
                  </td>
                </tr>

                {/* ── Section B AT ENTRY ── */}
                <tr style={{ backgroundColor: '#131313' }}>
                  <td style={{ ...cell, ...sticky, color: '#555', fontSize: '0.6rem', fontStyle: 'italic', paddingLeft: 10 }}>AT ENTRY</td>
                  <td colSpan={A_COLS.length} style={{ padding: '4px 10px', borderBottom: '1px solid #1e1e1e' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center' }}>
                      {B_COLS.map(k => { const el = BCell({ id: k, snap: snapE, dir }); return el ? <React.Fragment key={k}>{el}</React.Fragment> : null; })}
                    </div>
                  </td>
                </tr>

                {/* ── Section B AT EXIT ── */}
                <tr style={{ backgroundColor: '#0f0f0f' }}>
                  <td style={{ ...cell, ...sticky, color: '#555', fontSize: '0.6rem', fontStyle: 'italic', paddingLeft: 10 }}>AT EXIT</td>
                  <td colSpan={A_COLS.length} style={{ padding: '4px 10px', borderBottom: '1px solid #1e1e1e' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center' }}>
                      {B_COLS.map(k => { const el = BCell({ id: k, snap: snapX, dir }); return el ? <React.Fragment key={k}>{el}</React.Fragment> : null; })}
                    </div>
                  </td>
                </tr>

                {/* ── Section B notes ── */}
                <tr style={{ backgroundColor: 'rgba(255,255,255,0.01)' }}>
                  <td style={{ ...cell, ...sticky, color: '#555', fontSize: '0.6rem', fontStyle: 'italic', paddingLeft: 10 }}>
                    B NOTES
                  </td>
                  <td colSpan={A_COLS.length} style={{ padding: '3px 10px', borderBottom: '1px solid #1e1e1e' }}>
                    <input type="text" value={getNote(entry, 'macroNotes')}
                      onChange={e => setNote(entry, 'macroNotes', e.target.value)}
                      onBlur={e  => saveNotes(id, 'macroNotes', e.target.value)}
                      placeholder="Add macro/geopolitical notes — war, Fed, tariffs, earnings season..."
                      style={{ background: 'transparent', border: 'none', color: '#888', width: '100%', fontStyle: 'italic', fontSize: '0.76rem', outline: 'none' }}
                    />
                  </td>
                </tr>

                {/* ── Trade divider ── */}
                <tr>
                  <td colSpan={TOTAL_COLS} style={{ height: 8, borderBottom: '1px solid rgba(212,160,23,0.16)' }} />
                </tr>

              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
