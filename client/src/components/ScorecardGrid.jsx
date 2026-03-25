// client/src/components/ScorecardGrid.jsx
// ── PNTHR Closed Trades Scorecard Grid ────────────────────────────────────────
//
// Replaces the normal journal table when CLOSED filter is active.
// Section A: 41 discipline columns (ticker sticky, check/X logic, lot discipline).
// Section B: Market conditions AT ENTRY + AT EXIT (inline-flex in colSpan cell).
// Notes rows for both sections — editable inline, saved via PATCH endpoint.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback } from 'react';
import { API_BASE, authHeaders } from '../services/api';

// ── Icon helpers ──────────────────────────────────────────────────────────────
const Check = () => <span style={{ color: '#28a745', fontSize: '1rem', fontWeight: 700 }}>✓</span>;
const XMark = () => <span style={{ color: '#dc3545', fontSize: '1rem', fontWeight: 700 }}>✗</span>;
const Warn  = () => <span style={{ color: '#FFD700', fontSize: '1rem', fontWeight: 700 }}>⚠</span>;
const Dash  = () => <span style={{ color: '#3a3a3a' }}>—</span>;
const NA    = () => <span style={{ color: '#3a3a3a', fontSize: '0.7rem' }}>--</span>;

// ── Format helpers ─────────────────────────────────────────────────────────────
function fmtDate(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (isNaN(dt)) return null;
  return `${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${String(dt.getUTCDate()).padStart(2, '0')}/${dt.getUTCFullYear()}`;
}
function fmtDollar(v, forceSign = false) {
  if (v == null) return null;
  const abs = Math.abs(v).toFixed(2);
  if (forceSign) return `${v >= 0 ? '+' : '-'}$${abs}`;
  return `$${abs}`;
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
function computeChecks(entry) {
  const dir       = entry.direction || 'LONG';
  const snapE     = entry.marketAtEntry || {};
  const exits     = Array.isArray(entry.exits) ? entry.exits : [];
  const lastExit  = exits[exits.length - 1];
  const exitReason = lastExit?.reason || null;
  const exitPrice  = lastExit?.price ?? null;
  const entryPrice = entry.entry?.fillPrice ?? entry.entryPrice ?? null;
  const stopPrice  = entry.entry?.stopPrice ?? null;
  const nav        = entry.navAtEntry ?? null;
  const isETF      = entry.isETF || false;
  const lots       = Array.isArray(entry.lots) ? entry.lots : [];
  const lot1Shares = lots[0]?.shares ?? null;

  // ── Index trend ──
  const useQqq = entry.exchange === 'NASDAQ';
  const idxPos = useQqq ? snapE.qqqPosition : snapE.spyPosition;
  const indexTrend = idxPos != null
    ? (dir === 'LONG' ? idxPos === 'above' : idxPos === 'below')
    : null;

  // ── Sector trend ── (requires sector EMA — not stored in current snapshot)
  const sectorTrend = null;

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

  // ── Sizing check (A15) ──
  let sizingCheck = null;
  let riskDollar  = null;
  let riskPct     = null;
  let riskCapCheck = null;
  if (nav != null && entryPrice != null && stopPrice != null && lot1Shares != null) {
    const stopDist   = Math.abs(entryPrice - stopPrice);
    const vitality   = nav * (isETF ? 0.005 : 0.01);
    if (stopDist > 0) {
      const totalShares = Math.floor(vitality / stopDist);
      const expected    = Math.floor(totalShares * 0.15);   // Lot 1 = 15%
      const deviation   = expected > 0 ? Math.abs(lot1Shares - expected) / expected : null;
      sizingCheck = deviation != null ? deviation <= 0.10 : null;
      riskDollar  = +(lot1Shares * stopDist).toFixed(2);
      riskPct     = +(riskDollar / nav * 100).toFixed(3);
      riskCapCheck = riskDollar <= vitality;
    }
  }

  // ── Slippage (A19-A21) — requires signalPrice not currently stored ──
  const signalPrice  = entry.signalPrice ?? null;
  let slipDollar  = null;
  let slipPct     = null;
  let slipCheck   = null;
  if (signalPrice != null && entryPrice != null) {
    slipDollar = +(dir === 'LONG' ? entryPrice - signalPrice : signalPrice - entryPrice).toFixed(4);
    slipPct    = +(Math.abs(slipDollar / signalPrice) * 100).toFixed(2);
    slipCheck  = slipPct < 1 ? true : slipPct <= 2 ? 'warn' : false;
  }

  // ── Lot discipline (A22-A26) ──
  // ✓ if filled, -- if not in lots array (can't determine trigger without MFE)
  const getLotCheck = (n) => {
    if (n === 1) return true; // always filled for closed trades
    return lots.find(l => l.lot === n) ? true : null; // null → -- (unknown)
  };

  // ── Held drawdown (A27) ──
  const panicSold = exitReason === 'MANUAL' && exitPrice != null && entryPrice != null && (
    (dir === 'LONG'  && exitPrice < entryPrice) ||
    (dir === 'SHORT' && exitPrice > entryPrice)
  );
  const heldDrawdown = !panicSold;

  // ── Recycled (A28) — requires highestStopPrice tracking, not yet stored ──
  const recycledCheck = entry.wasRecycled != null ? entry.wasRecycled : null;

  return {
    indexTrend, sectorTrend, signalCheck, exitCheck, notEarlyCheck, onSignalCheck, washClean,
    sizingCheck, riskDollar, riskPct, riskCapCheck,
    slipDollar, slipPct, slipCheck,
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
};
const sticky = { position: 'sticky', left: 0, zIndex: 2, backgroundColor: '#1a1a1a' };

// ── Column definitions ────────────────────────────────────────────────────────
const A_COLS = [
  // Identifiers
  { key: 'entryDate',     label: 'ENTRY',     w: 84 },
  { key: 'exitDate',      label: 'EXIT',      w: 84 },
  { key: 'exchange',      label: 'EXCH',      w: 58 },
  // Index + sector
  { key: 'indexTrend',    label: 'IDX ✓',     w: 48 },
  { key: 'sector',        label: 'SECTOR',    w: 120 },
  { key: 'sectorTrend',   label: 'SECT ✓',    w: 52 },
  // Signal
  { key: 'entrySignal',   label: 'SIG',       w: 68 },
  { key: 'signalCheck',   label: 'SIG ✓',     w: 46 },
  // Exit discipline
  { key: 'exitSignal',    label: 'EXIT SIG',  w: 82 },
  { key: 'exitCheck',     label: 'EXIT ✓',    w: 48 },
  { key: 'notEarly',      label: '¬EARLY',    w: 50 },
  { key: 'onSignal',      label: 'ON SIG',    w: 54 },
  // Wash rule
  { key: 'washRule',      label: 'WASH ✓',    w: 52 },
  // Sizing + risk
  { key: 'sizingCheck',   label: 'SIZE ✓',    w: 48 },
  { key: 'riskDollar',    label: 'RISK $',    w: 68 },
  { key: 'riskPct',       label: 'RISK %',    w: 60 },
  { key: 'riskCapCheck',  label: 'CAP ✓',     w: 46 },
  // Slippage
  { key: 'slipDollar',    label: 'SLIP $',    w: 62 },
  { key: 'slipPct',       label: 'SLIP %',    w: 56 },
  { key: 'slipCheck',     label: 'SLIP ✓',    w: 48 },
  // Lot discipline
  { key: 'lot1',          label: 'L1',        w: 36 },
  { key: 'lot2',          label: 'L2',        w: 36 },
  { key: 'lot3',          label: 'L3',        w: 36 },
  { key: 'lot4',          label: 'L4',        w: 36 },
  { key: 'lot5',          label: 'L5',        w: 36 },
  // Behavioral
  { key: 'heldDrawdown',  label: 'HELD ✓',    w: 50 },
  { key: 'recycled',      label: 'RECYCLED',  w: 60 },
  // Kill scores
  { key: 'killScore',     label: 'KILL',      w: 66 },
  { key: 'rank',          label: 'RANK',      w: 48 },
  { key: 'rankChange',    label: 'ΔRANK',     w: 54 },
  { key: 'tier',          label: 'TIER',      w: 120 },
  // Dimensions
  { key: 'd1',            label: 'D1',        w: 50 },
  { key: 'd2',            label: 'D2',        w: 38 },
  { key: 'd3',            label: 'D3',        w: 38 },
  { key: 'd4',            label: 'D4',        w: 38 },
  { key: 'd5',            label: 'D5',        w: 38 },
  { key: 'd6',            label: 'D6',        w: 38 },
  { key: 'd7',            label: 'D7',        w: 38 },
  { key: 'd8',            label: 'D8',        w: 38 },
  // P&L
  { key: 'pnlDollar',    label: 'P&L $',     w: 78 },
  { key: 'pnlPct',       label: 'P&L %',     w: 66 },
];
const TOTAL_COLS = 1 + A_COLS.length; // sticky ticker + 41 A cols

// ── Section B ─────────────────────────────────────────────────────────────────
const B_COLS = ['spy','spyVsEma','spyTrend','qqq','qqqVsEma','qqqTrend',
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
  const lbl = <span style={{ color: '#3a3a3a', fontSize: '0.64rem', marginRight: 2 }}>{B_LABEL[id]}:</span>;
  const base = { fontSize: '0.74rem', color: '#aaa', marginRight: 10, whiteSpace: 'nowrap' };
  switch (id) {
    case 'spy':
      return snap.spyPrice != null ? <span style={base}>{lbl}${snap.spyPrice.toFixed(2)}</span> : null;
    case 'spyVsEma': {
      const v = snap.spyVsEma;
      return v != null ? <span style={{ ...base, color: v >= 0 ? '#28a745' : '#dc3545' }}>{lbl}{v >= 0 ? '+' : ''}{v.toFixed(2)}%</span> : null;
    }
    case 'spyTrend': {
      const pos = snap.spyPosition;
      if (!pos) return null;
      const ok = dir === 'LONG' ? pos === 'above' : pos === 'below';
      return <span style={{ ...base, color: ok ? '#28a745' : '#dc3545' }}>{lbl}{ok ? '✓' : '✗'}</span>;
    }
    case 'qqq':
      return snap.qqqPrice != null ? <span style={base}>{lbl}${snap.qqqPrice.toFixed(2)}</span> : null;
    case 'qqqVsEma': {
      const v = snap.qqqVsEma;
      return v != null ? <span style={{ ...base, color: v >= 0 ? '#28a745' : '#dc3545' }}>{lbl}{v >= 0 ? '+' : ''}{v.toFixed(2)}%</span> : null;
    }
    case 'qqqTrend': {
      const pos = snap.qqqPosition;
      if (!pos) return null;
      const ok = dir === 'LONG' ? pos === 'above' : pos === 'below';
      return <span style={{ ...base, color: ok ? '#28a745' : '#dc3545' }}>{lbl}{ok ? '✓' : '✗'}</span>;
    }
    case 'vix':
      return snap.vix != null ? <span style={base}>{lbl}{snap.vix.toFixed(1)}</span> : null;
    case 'vixZone': {
      const z = getVixZone(snap.vix);
      return z ? <span style={{ ...base, color: z.color }}>{lbl}{z.label}</span> : null;
    }
    case 'regime':
      return snap.regime ? <span style={{ ...base, color: getRegimeColor(snap.regime) }}>{lbl}{snap.regime}</span> : null;
    case 'y2':
      return snap.treasury2Y != null ? <span style={base}>{lbl}{snap.treasury2Y.toFixed(2)}%</span> : null;
    case 'y10':
      return snap.treasury10Y != null ? <span style={base}>{lbl}{snap.treasury10Y.toFixed(2)}%</span> : null;
    case 'y30':
      return snap.treasury30Y != null ? <span style={base}>{lbl}{snap.treasury30Y.toFixed(2)}%</span> : null;
    case 'spread': {
      const s = snap.spread2Y10Y;
      return s != null ? <span style={{ ...base, color: getSpreadColor(s) }}>{lbl}{s >= 0 ? '+' : ''}{s.toFixed(3)}%</span> : null;
    }
    case 'dxy':
      return snap.dxy != null ? <span style={base}>{lbl}{snap.dxy.toFixed(2)}</span> : null;
    case 'crude':
      return snap.crudeOil != null ? <span style={base}>{lbl}${snap.crudeOil.toFixed(2)}</span> : null;
    case 'gold':
      return snap.gold != null ? <span style={base}>{lbl}${Math.round(snap.gold).toLocaleString()}</span> : null;
    case 'sectEtf':
      return snap.sectorEtf ? <span style={base}>{lbl}{snap.sectorEtf}{snap.sectorPrice != null ? ` $${snap.sectorPrice.toFixed(2)}` : ''}</span> : null;
    case 'sect1D': {
      const v = snap.sectorChange1D;
      return v != null ? <span style={{ ...base, color: v >= 0 ? '#28a745' : '#dc3545' }}>{lbl}{v >= 0 ? '+' : ''}{v.toFixed(2)}%</span> : null;
    }
    default: return null;
  }
}

// ── CheckCell ─────────────────────────────────────────────────────────────────
// v: true=✓  false=✗  'warn'=⚠  null=—  'na'=--
function CC({ v }) {
  return (
    <td style={cell}>
      {v === true ? <Check />
        : v === false ? <XMark />
        : v === 'warn' ? <Warn />
        : v === null ? <Dash />
        : <NA />}
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
            <th style={{ ...hdr, ...sticky, zIndex: 3, textAlign: 'left', width: 88 }}>TICKER</th>
            {A_COLS.map(c => <th key={c.key} style={hdr}>{c.label}</th>)}
          </tr>
        </thead>

        <tbody>
          {entries.map((entry, idx) => {
            const id       = entry._id?.toString() || String(idx);
            const chk      = computeChecks(entry);
            const kse      = entry.killScoreAtEntry || {};
            const dims     = kse.dimensions || null;
            const dir      = entry.direction || 'LONG';
            const exits    = Array.isArray(entry.exits) ? entry.exits : [];
            const lastExit = exits[exits.length - 1];
            const exitReason = lastExit?.reason || null;

            const pnl    = entry.performance?.realizedPnlDollar ?? entry.totalPnL ?? null;
            const pnlPct = entry.performance?.realizedPnlPct ?? entry.totalPnlPct ?? null;
            const pnlColor  = pnl    != null ? (pnl    >= 0 ? '#28a745' : '#dc3545') : '#555';
            const pnlPctClr = pnlPct != null ? (pnlPct >= 0 ? '#28a745' : '#dc3545') : '#555';

            // Entry signal label
            const sig    = entry.signal;
            const sigAge = entry.signalAge;
            const sigLabel = (!sig || sig === 'PAUSE') ? (sig || '—')
              : sigAge != null ? `${sig}+${sigAge}` : sig;

            // Rank change
            const rc = kse.rankChange;
            const rcLabel = rc == null ? 'NEW' : rc > 0 ? `+${rc}` : String(rc);
            const rcColor = rc == null ? '#FFD700' : rc > 0 ? '#28a745' : '#dc3545';

            const d1Label = kse.d1 != null ? `${Number(kse.d1).toFixed(2)}×` : null;
            const snapE   = entry.marketAtEntry || null;
            const snapX   = entry.marketAtExit  || null;
            const rowBg   = idx % 2 === 0 ? '#161616' : '#141414';

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
                  <td style={{ ...cell, color: '#999' }}>{sigLabel}</td>
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
                    {chk.riskDollar != null ? fmtDollar(chk.riskDollar) : <Dash />}
                  </td>
                  {/* A17: RISK % */}
                  <td style={{ ...cell, color: chk.riskCapCheck === false ? '#dc3545' : '#aaa' }}>
                    {chk.riskPct != null ? `${chk.riskPct.toFixed(2)}%` : <Dash />}
                  </td>
                  {/* A18: RISK CAP CHECK */}
                  <CC v={chk.riskCapCheck} />

                  {/* A19: SLIP $ */}
                  <td style={{ ...cell, color: '#aaa' }}>
                    {chk.slipDollar != null ? fmtDollar(chk.slipDollar) : <Dash />}
                  </td>
                  {/* A20: SLIP % */}
                  <td style={{ ...cell, color: '#aaa' }}>
                    {chk.slipPct != null ? `${chk.slipPct.toFixed(2)}%` : <Dash />}
                  </td>
                  {/* A21: SLIP CHECK */}
                  <CC v={chk.slipCheck} />

                  {/* A22-A26: LOT 1-5 */}
                  <CC v={chk.lot1} />
                  <CC v={chk.lot2 === null ? undefined : chk.lot2} />
                  <CC v={chk.lot3 === null ? undefined : chk.lot3} />
                  <CC v={chk.lot4 === null ? undefined : chk.lot4} />
                  <CC v={chk.lot5 === null ? undefined : chk.lot5} />

                  {/* A27: HELD DRAWDOWN */}
                  <CC v={chk.heldDrawdown} />
                  {/* A28: RECYCLED */}
                  <CC v={chk.recycledCheck} />

                  {/* A29: KILL SCORE */}
                  <td style={{ ...cell, color: '#FFD700' }}>
                    {kse.totalScore != null
                      ? `${Math.round(kse.totalScore)}${kse.pipelineMaxScore != null ? `/${Math.round(kse.pipelineMaxScore)}` : ''}`
                      : <Dash />}
                  </td>
                  {/* A30: RANK */}
                  <td style={cell}>{kse.rank != null ? `#${kse.rank}` : <Dash />}</td>
                  {/* A31: RANK CHANGE */}
                  <td style={{ ...cell, color: rcColor }}>
                    {kse.totalScore != null ? rcLabel : <Dash />}
                  </td>
                  {/* A32: TIER */}
                  <td style={{ ...cell, fontSize: '0.65rem', color: '#FFD700', textAlign: 'left' }}>
                    {kse.tier || <Dash />}
                  </td>
                  {/* A33: D1 */}
                  <td style={{ ...cell, color: '#aaa' }}>{d1Label ?? <Dash />}</td>
                  {/* A34-A40: D2-D8 */}
                  {[2, 3, 4, 5, 6, 7, 8].map(n => {
                    const v = getDim(dims, n);
                    const c = v == null ? '#3a3a3a' : v > 0 ? '#28a745' : v < 0 ? '#dc3545' : '#666';
                    return (
                      <td key={n} style={{ ...cell, color: c }}>
                        {v != null ? (v > 0 ? `+${Math.round(v)}` : `${Math.round(v)}`) : <Dash />}
                      </td>
                    );
                  })}
                  {/* A41: P&L $ */}
                  <td style={{ ...cell, color: pnlColor, fontWeight: 600 }}>
                    {pnl != null ? (pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`) : <Dash />}
                  </td>
                  {/* A42: P&L % */}
                  <td style={{ ...cell, color: pnlPctClr, fontWeight: 600 }}>
                    {pnlPct != null ? `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%` : <Dash />}
                  </td>
                </tr>

                {/* ── Section A notes row ── */}
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
                    backgroundColor: 'rgba(70,70,70,0.07)',
                    borderBottom: '1px solid #252525',
                    padding: '3px 12px',
                    color: '#444', fontWeight: 700, fontSize: '0.6rem', letterSpacing: '0.12em',
                  }}>
                    SECTION B · MARKET CONDITIONS
                  </td>
                </tr>

                {/* ── Section B AT ENTRY ── */}
                <tr style={{ backgroundColor: '#121212' }}>
                  <td style={{ ...cell, ...sticky, color: '#3a3a3a', fontSize: '0.6rem', fontStyle: 'italic', paddingLeft: 10 }}>AT ENTRY</td>
                  <td colSpan={A_COLS.length} style={{ padding: '4px 10px', borderBottom: '1px solid #1e1e1e' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center' }}>
                      {B_COLS.map(k => { const el = BCell({ id: k, snap: snapE, dir }); return el ? <React.Fragment key={k}>{el}</React.Fragment> : null; })}
                    </div>
                  </td>
                </tr>

                {/* ── Section B AT EXIT ── */}
                <tr style={{ backgroundColor: '#0f0f0f' }}>
                  <td style={{ ...cell, ...sticky, color: '#3a3a3a', fontSize: '0.6rem', fontStyle: 'italic', paddingLeft: 10 }}>AT EXIT</td>
                  <td colSpan={A_COLS.length} style={{ padding: '4px 10px', borderBottom: '1px solid #1e1e1e' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center' }}>
                      {B_COLS.map(k => { const el = BCell({ id: k, snap: snapX, dir }); return el ? <React.Fragment key={k}>{el}</React.Fragment> : null; })}
                    </div>
                  </td>
                </tr>

                {/* ── Section B notes row ── */}
                <tr style={{ backgroundColor: 'rgba(255,255,255,0.01)' }}>
                  <td style={{ ...cell, ...sticky, color: '#3a3a3a', fontSize: '0.6rem', fontStyle: 'italic', paddingLeft: 10 }}>
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
