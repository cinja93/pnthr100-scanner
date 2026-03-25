// client/src/components/ScorecardGrid.jsx
// ── PNTHR Closed Trades Scorecard Grid ────────────────────────────────────────
//
// Replaces the normal journal table when CLOSED filter is active.
// Section A: 28 discipline columns (ticker sticky, check/X logic).
// Section B: Market conditions AT ENTRY + AT EXIT (inline-flex in colSpan cell).
// Notes rows for both sections — editable inline, saved via PATCH endpoint.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback } from 'react';
import { API_BASE, authHeaders } from '../services/api';

// ── Icon helpers ──────────────────────────────────────────────────────────────
const Check = () => <span style={{ color: '#28a745', fontSize: '1.05rem', fontWeight: 700 }}>✓</span>;
const XMark = () => <span style={{ color: '#dc3545', fontSize: '1.05rem', fontWeight: 700 }}>✗</span>;
const Warn  = () => <span style={{ color: '#FFD700', fontSize: '1.05rem', fontWeight: 700 }}>⚠</span>;
const Dash  = () => <span style={{ color: '#3a3a3a' }}>—</span>;

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

function getSpreadColor(spread) {
  if (spread == null) return '#aaa';
  if (spread < 0)    return '#dc3545';
  if (spread < 0.25) return '#fd7e14';
  return '#28a745';
}

function getRegimeColor(regime) {
  if (!regime)              return '#aaa';
  if (regime === 'BULLISH') return '#28a745';
  if (regime === 'BEARISH') return '#dc3545';
  return '#FFD700';
}

// Defensive dimension scorer — handles both number and sub-object forms
function getDim(dims, n) {
  if (!dims) return null;
  const d = dims[`d${n}`];
  if (d == null) return null;
  if (typeof d === 'number') return d;
  if (typeof d === 'object' && d.score != null) return d.score;
  return null;
}

// ── Check logic ───────────────────────────────────────────────────────────────
function computeChecks(entry) {
  const dir      = entry.direction || 'LONG';
  const snap     = entry.marketAtEntry || {};
  const exits    = Array.isArray(entry.exits) ? entry.exits : [];
  const lastExit = exits[exits.length - 1];
  const exitReason = lastExit?.reason || null;

  // Index trend: NASDAQ stocks use QQQ; NYSE / everything else uses SPY
  const useQqq = entry.exchange === 'NASDAQ';
  const idxPos = useQqq ? snap.qqqPosition : snap.spyPosition;
  const indexAbove = idxPos === 'above';
  const indexTrend = idxPos != null
    ? (dir === 'LONG' ? indexAbove : !indexAbove)
    : null;

  // Sector trend: not available without sector EMA in snapshot; show dash
  const sectorTrend = null;

  // Signal check
  const sig    = entry.signal;
  const sigAge = entry.signalAge ?? 0;
  let signalCheck = null;
  if (!sig || sig === 'PAUSE' || sig === 'NO_SIGNAL') {
    signalCheck = 'warn';
  } else if (dir === 'LONG' && sig === 'BL' && sigAge <= 1) {
    signalCheck = true;
  } else if (dir === 'SHORT' && sig === 'SS' && sigAge <= 1) {
    signalCheck = true;
  } else {
    signalCheck = false;
  }

  // Exit check: system exits = disciplined
  const systemExits = ['SIGNAL', 'STOP_HIT', 'FEAST', 'STALE_HUNT'];
  const exitCheck    = exitReason ? systemExits.includes(exitReason) : null;

  // Closed early = manual override
  const closedEarly    = exitReason === 'MANUAL' ? false : (exitReason ? true : null);
  const closedOnSignal = exitReason === 'SIGNAL';

  // Wash rule: ✓ if this entry did NOT trigger a wash sale
  const washClean = !(entry.tags?.includes('wash-sale'));

  return { indexTrend, sectorTrend, signalCheck, exitCheck, closedEarly, closedOnSignal, washClean };
}

// ── Styles ────────────────────────────────────────────────────────────────────
const cell = {
  padding: '5px 7px',
  fontSize: '0.76rem',
  color: '#ccc',
  whiteSpace: 'nowrap',
  borderBottom: '1px solid #1e1e1e',
  textAlign: 'center',
};
const hdr = {
  ...cell,
  color: '#666',
  fontWeight: 700,
  fontSize: '0.68rem',
  letterSpacing: '0.05em',
  backgroundColor: '#141414',
  borderBottom: '2px solid #2a2a2a',
  position: 'sticky',
  top: 0,
  zIndex: 1,
};
const sticky = {
  position: 'sticky',
  left: 0,
  zIndex: 2,
  backgroundColor: '#1a1a1a',
};

// ── Column defs ───────────────────────────────────────────────────────────────
const A_COLS = [
  { key: 'entryDate',     label: 'ENTRY',     w: 86 },
  { key: 'exitDate',      label: 'EXIT',      w: 86 },
  { key: 'exchange',      label: 'EXCH',      w: 62 },
  { key: 'indexTrend',    label: 'IDX ✓',     w: 52 },
  { key: 'sector',        label: 'SECTOR',    w: 130 },
  { key: 'sectorTrend',   label: 'SECT ✓',    w: 55 },
  { key: 'entrySignal',   label: 'SIG',       w: 72 },
  { key: 'signalCheck',   label: 'SIG ✓',     w: 50 },
  { key: 'exitSignal',    label: 'EXIT SIG',  w: 85 },
  { key: 'exitCheck',     label: 'EXIT ✓',    w: 52 },
  { key: 'notEarly',      label: 'NOT EARLY', w: 68 },
  { key: 'onSignal',      label: 'ON SIG',    w: 58 },
  { key: 'washRule',      label: 'WASH ✓',    w: 58 },
  { key: 'killScore',     label: 'KILL',      w: 68 },
  { key: 'rank',          label: 'RANK',      w: 52 },
  { key: 'rankChange',    label: 'ΔRANK',     w: 58 },
  { key: 'tier',          label: 'TIER',      w: 130 },
  { key: 'd1',            label: 'D1',        w: 52 },
  { key: 'd2',            label: 'D2',        w: 42 },
  { key: 'd3',            label: 'D3',        w: 42 },
  { key: 'd4',            label: 'D4',        w: 42 },
  { key: 'd5',            label: 'D5',        w: 42 },
  { key: 'd6',            label: 'D6',        w: 42 },
  { key: 'd7',            label: 'D7',        w: 42 },
  { key: 'd8',            label: 'D8',        w: 42 },
  { key: 'pnlDollar',    label: 'P&L $',     w: 80 },
  { key: 'pnlPct',       label: 'P&L %',     w: 68 },
];
const TOTAL_COLS = 1 + A_COLS.length; // sticky ticker + 27 A cols

const B_COLS = [
  'spy', 'spyVsEma', 'spyTrend',
  'qqq', 'qqqVsEma', 'qqqTrend',
  'vix', 'vixZone', 'regime',
  'y2', 'y10', 'y30', 'spread',
  'dxy', 'crude', 'gold',
  'sectEtf', 'sect1D',
];
const B_LABELS = {
  spy: 'SPY', spyVsEma: 'SPY/EMA', spyTrend: 'SPY✓',
  qqq: 'QQQ', qqqVsEma: 'QQQ/EMA', qqqTrend: 'QQQ✓',
  vix: 'VIX', vixZone: 'ZONE', regime: 'REGIME',
  y2: '2Y', y10: '10Y', y30: '30Y', spread: '2Y-10Y',
  dxy: 'DXY', crude: 'CRUDE', gold: 'GOLD',
  sectEtf: 'SECT ETF', sect1D: 'SECT 1D%',
};

// ── Section B cell renderer ───────────────────────────────────────────────────
function BCell({ id, snap, dir }) {
  if (!snap) return <span style={{ color: '#3a3a3a', fontSize: '0.75rem', marginRight: 8 }}>—</span>;

  const lbl = (k) => (
    <span style={{ color: '#444', fontSize: '0.66rem', marginRight: 2 }}>{B_LABELS[k]}:</span>
  );
  const base = { fontSize: '0.75rem', color: '#bbb', marginRight: 10, whiteSpace: 'nowrap' };

  switch (id) {
    case 'spy':
      return snap.spyPrice != null
        ? <span style={base}>{lbl('spy')}${snap.spyPrice.toFixed(2)}</span>
        : null;
    case 'spyVsEma': {
      const v = snap.spyVsEma;
      return v != null
        ? <span style={{ ...base, color: v >= 0 ? '#28a745' : '#dc3545' }}>
            {lbl('spyVsEma')}{v >= 0 ? '+' : ''}{v.toFixed(2)}%
          </span>
        : null;
    }
    case 'spyTrend': {
      const pos = snap.spyPosition;
      if (!pos) return null;
      const ok = dir === 'LONG' ? pos === 'above' : pos === 'below';
      return <span style={{ ...base, color: ok ? '#28a745' : '#dc3545' }}>{lbl('spyTrend')}{ok ? '✓' : '✗'}</span>;
    }
    case 'qqq':
      return snap.qqqPrice != null
        ? <span style={base}>{lbl('qqq')}${snap.qqqPrice.toFixed(2)}</span>
        : null;
    case 'qqqVsEma': {
      const v = snap.qqqVsEma;
      return v != null
        ? <span style={{ ...base, color: v >= 0 ? '#28a745' : '#dc3545' }}>
            {lbl('qqqVsEma')}{v >= 0 ? '+' : ''}{v.toFixed(2)}%
          </span>
        : null;
    }
    case 'qqqTrend': {
      const pos = snap.qqqPosition;
      if (!pos) return null;
      const ok = dir === 'LONG' ? pos === 'above' : pos === 'below';
      return <span style={{ ...base, color: ok ? '#28a745' : '#dc3545' }}>{lbl('qqqTrend')}{ok ? '✓' : '✗'}</span>;
    }
    case 'vix':
      return snap.vix != null
        ? <span style={base}>{lbl('vix')}{snap.vix.toFixed(1)}</span>
        : null;
    case 'vixZone': {
      const z = getVixZone(snap.vix);
      return z
        ? <span style={{ ...base, color: z.color }}>{lbl('vixZone')}{z.label}</span>
        : null;
    }
    case 'regime': {
      const c = getRegimeColor(snap.regime);
      return snap.regime
        ? <span style={{ ...base, color: c }}>{lbl('regime')}{snap.regime}</span>
        : null;
    }
    case 'y2':
      return snap.treasury2Y != null
        ? <span style={base}>{lbl('y2')}{snap.treasury2Y.toFixed(2)}%</span>
        : null;
    case 'y10':
      return snap.treasury10Y != null
        ? <span style={base}>{lbl('y10')}{snap.treasury10Y.toFixed(2)}%</span>
        : null;
    case 'y30':
      return snap.treasury30Y != null
        ? <span style={base}>{lbl('y30')}{snap.treasury30Y.toFixed(2)}%</span>
        : null;
    case 'spread': {
      const s = snap.spread2Y10Y;
      return s != null
        ? <span style={{ ...base, color: getSpreadColor(s) }}>
            {lbl('spread')}{s >= 0 ? '+' : ''}{s.toFixed(3)}%
          </span>
        : null;
    }
    case 'dxy':
      return snap.dxy != null
        ? <span style={base}>{lbl('dxy')}{snap.dxy.toFixed(2)}</span>
        : null;
    case 'crude':
      return snap.crudeOil != null
        ? <span style={base}>{lbl('crude')}${snap.crudeOil.toFixed(2)}</span>
        : null;
    case 'gold':
      return snap.gold != null
        ? <span style={base}>{lbl('gold')}${Math.round(snap.gold).toLocaleString()}</span>
        : null;
    case 'sectEtf':
      return snap.sectorEtf
        ? <span style={base}>{lbl('sectEtf')}{snap.sectorEtf}{snap.sectorPrice != null ? ` $${snap.sectorPrice.toFixed(2)}` : ''}</span>
        : null;
    case 'sect1D': {
      const v = snap.sectorChange1D;
      return v != null
        ? <span style={{ ...base, color: v >= 0 ? '#28a745' : '#dc3545' }}>
            {lbl('sect1D')}{v >= 0 ? '+' : ''}{v.toFixed(2)}%
          </span>
        : null;
    }
    default: return null;
  }
}

// ── CheckCell ─────────────────────────────────────────────────────────────────
function CC({ v }) {
  return (
    <td style={cell}>
      {v === null || v === undefined ? <Dash /> : v === 'warn' ? <Warn /> : v ? <Check /> : <XMark />}
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
      <table style={{ borderCollapse: 'collapse', width: 'max-content', fontSize: '0.76rem', tableLayout: 'fixed' }}>

        {/* ── Column widths ── */}
        <colgroup>
          <col style={{ width: 90 }} />
          {A_COLS.map(c => <col key={c.key} style={{ width: c.w }} />)}
        </colgroup>

        {/* ── Header ── */}
        <thead>
          <tr>
            <th style={{ ...hdr, ...sticky, zIndex: 3, textAlign: 'left', width: 90 }}>TICKER</th>
            {A_COLS.map(c => <th key={c.key} style={hdr}>{c.label}</th>)}
          </tr>
        </thead>

        <tbody>
          {entries.map((entry, idx) => {
            const id      = entry._id?.toString() || String(idx);
            const checks  = computeChecks(entry);
            const kse     = entry.killScoreAtEntry || {};
            const dims    = kse.dimensions || null;
            const dir     = entry.direction || 'LONG';
            const exits   = Array.isArray(entry.exits) ? entry.exits : [];
            const lastExit = exits[exits.length - 1];
            const exitReason = lastExit?.reason || null;

            const pnl    = entry.performance?.realizedPnlDollar ?? entry.totalPnL ?? null;
            const pnlPct = entry.performance?.realizedPnlPct ?? entry.totalPnlPct ?? null;

            // Entry signal label
            const sig    = entry.signal;
            const sigAge = entry.signalAge;
            let sigLabel = '—';
            if (sig && sig !== 'PAUSE' && sig !== 'NO_SIGNAL') {
              sigLabel = sigAge != null ? `${sig}+${sigAge}` : sig;
            } else if (sig === 'PAUSE') {
              sigLabel = 'PAUSE';
            }

            // Rank change
            const rc = kse.rankChange;
            const rcLabel = rc == null ? 'NEW' : rc > 0 ? `+${rc}` : String(rc);
            const rcColor = rc == null ? '#FFD700' : rc > 0 ? '#28a745' : '#dc3545';

            // P&L colors
            const pnlColor  = pnl    != null ? (pnl    >= 0 ? '#28a745' : '#dc3545') : '#555';
            const pnlPctClr = pnlPct != null ? (pnlPct >= 0 ? '#28a745' : '#dc3545') : '#555';

            // D1 multiplier
            const d1Label = kse.d1 != null ? `${Number(kse.d1).toFixed(2)}×` : null;

            const snapE = entry.marketAtEntry || {};
            const snapX = entry.marketAtExit  || {};

            const sectionABg = idx % 2 === 0 ? '#161616' : '#141414';

            return (
              <React.Fragment key={id}>

                {/* ── Section A label ── */}
                <tr>
                  <td colSpan={TOTAL_COLS} style={{
                    backgroundColor: 'rgba(212,160,23,0.07)',
                    borderTop: '1px solid rgba(212,160,23,0.25)',
                    borderBottom: '1px solid rgba(212,160,23,0.15)',
                    padding: '3px 12px',
                    color: '#D4A017',
                    fontWeight: 700,
                    fontSize: '0.66rem',
                    letterSpacing: '0.12em',
                  }}>
                    SECTION A · TRADE DISCIPLINE
                  </td>
                </tr>

                {/* ── Section A data row ── */}
                <tr style={{ backgroundColor: sectionABg }}>

                  {/* TICKER (sticky) */}
                  <td style={{ ...cell, ...sticky, textAlign: 'left', paddingLeft: 10 }}>
                    <span
                      style={{ color: '#fcf000', cursor: 'pointer', fontWeight: 700, fontSize: '0.82rem' }}
                      onClick={() => onTickerClick?.(entry.ticker)}
                    >
                      {entry.ticker}
                    </span>
                    <div style={{ fontSize: '0.65rem', color: dir === 'LONG' ? '#28a745' : '#dc3545', marginTop: 1 }}>
                      {dir}
                    </div>
                  </td>

                  {/* A2: ENTRY DATE */}
                  <td style={cell}>{fmtDate(entry.entryDate) ?? <Dash />}</td>
                  {/* A3: EXIT DATE */}
                  <td style={cell}>{fmtDate(lastExit?.date) ?? <Dash />}</td>
                  {/* A4: EXCHANGE */}
                  <td style={{ ...cell, color: '#888' }}>{entry.exchange || <Dash />}</td>
                  {/* A5: INDEX TREND */}
                  <CC v={checks.indexTrend} />
                  {/* A6: SECTOR */}
                  <td style={{ ...cell, fontSize: '0.7rem', textAlign: 'left' }}>{entry.sector || <Dash />}</td>
                  {/* A7: SECTOR TREND */}
                  <CC v={checks.sectorTrend} />
                  {/* A8: ENTRY SIGNAL */}
                  <td style={{ ...cell, color: '#aaa' }}>{sigLabel}</td>
                  {/* A9: SIGNAL CHECK */}
                  <CC v={checks.signalCheck} />
                  {/* A10: EXIT SIGNAL */}
                  <td style={{ ...cell, fontSize: '0.72rem', color: '#aaa' }}>{exitReason || <Dash />}</td>
                  {/* A11: EXIT CHECK */}
                  <CC v={checks.exitCheck} />
                  {/* A12: NOT EARLY (inverse of closedEarly) */}
                  <CC v={checks.closedEarly} />
                  {/* A13: ON SIGNAL */}
                  <CC v={checks.closedOnSignal} />
                  {/* A14: WASH RULE */}
                  <CC v={checks.washClean} />

                  {/* A15: KILL SCORE */}
                  <td style={{ ...cell, color: '#FFD700' }}>
                    {kse.totalScore != null
                      ? `${Math.round(kse.totalScore)}${kse.pipelineMaxScore != null ? `/${Math.round(kse.pipelineMaxScore)}` : ''}`
                      : <Dash />}
                  </td>

                  {/* A16: RANK */}
                  <td style={cell}>{kse.rank != null ? `#${kse.rank}` : <Dash />}</td>

                  {/* A17: RANK CHANGE */}
                  <td style={{ ...cell, color: rcColor }}>
                    {kse.totalScore != null ? rcLabel : <Dash />}
                  </td>

                  {/* A18: TIER */}
                  <td style={{ ...cell, fontSize: '0.68rem', color: '#FFD700', textAlign: 'left' }}>
                    {kse.tier || <Dash />}
                  </td>

                  {/* A19: D1 */}
                  <td style={{ ...cell, color: '#aaa' }}>{d1Label ?? <Dash />}</td>

                  {/* A20–A26: D2–D8 */}
                  {[2, 3, 4, 5, 6, 7, 8].map(n => {
                    const v = getDim(dims, n);
                    const c = v == null ? '#3a3a3a' : v > 0 ? '#28a745' : v < 0 ? '#dc3545' : '#666';
                    return (
                      <td key={n} style={{ ...cell, color: c }}>
                        {v != null ? (v > 0 ? `+${Math.round(v)}` : `${Math.round(v)}`) : <Dash />}
                      </td>
                    );
                  })}

                  {/* A27: P&L $ */}
                  <td style={{ ...cell, color: pnlColor, fontWeight: 600 }}>
                    {pnl != null
                      ? `${pnl >= 0 ? '+' : ''}$${Math.abs(pnl).toFixed(2)}`
                      : <Dash />}
                  </td>

                  {/* A28: P&L % */}
                  <td style={{ ...cell, color: pnlPctClr, fontWeight: 600 }}>
                    {pnlPct != null
                      ? `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`
                      : <Dash />}
                  </td>
                </tr>

                {/* ── Section A notes row ── */}
                <tr style={{ backgroundColor: 'rgba(255,255,255,0.015)' }}>
                  <td style={{ ...cell, ...sticky, color: '#3a3a3a', fontSize: '0.64rem', fontStyle: 'italic', paddingLeft: 10 }}>
                    A NOTES
                  </td>
                  <td colSpan={A_COLS.length} style={{ padding: '3px 10px', borderBottom: '1px solid #1e1e1e' }}>
                    <input
                      type="text"
                      value={getNote(entry, 'tradeNotes')}
                      onChange={e => setNote(entry, 'tradeNotes', e.target.value)}
                      onBlur={e  => saveNotes(id, 'tradeNotes', e.target.value)}
                      placeholder="Add trade notes — why I took this, chart thesis, what I saw..."
                      style={{
                        background: 'transparent', border: 'none', color: '#888',
                        width: '100%', fontStyle: 'italic', fontSize: '0.78rem', outline: 'none',
                      }}
                    />
                  </td>
                </tr>

                {/* ── Section B label ── */}
                <tr>
                  <td colSpan={TOTAL_COLS} style={{
                    backgroundColor: 'rgba(80,80,80,0.07)',
                    borderBottom: '1px solid #252525',
                    padding: '3px 12px',
                    color: '#555',
                    fontWeight: 700,
                    fontSize: '0.64rem',
                    letterSpacing: '0.12em',
                  }}>
                    SECTION B · MARKET CONDITIONS
                  </td>
                </tr>

                {/* ── Section B AT ENTRY row ── */}
                <tr style={{ backgroundColor: '#121212' }}>
                  <td style={{ ...cell, ...sticky, color: '#3a3a3a', fontSize: '0.64rem', fontStyle: 'italic', paddingLeft: 10 }}>
                    AT ENTRY
                  </td>
                  <td colSpan={A_COLS.length} style={{ padding: '4px 10px', borderBottom: '1px solid #1e1e1e' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0 2px' }}>
                      {B_COLS.map(k => {
                        const el = BCell({ id: k, snap: snapE, dir });
                        return el ? <React.Fragment key={k}>{el}</React.Fragment> : null;
                      })}
                    </div>
                  </td>
                </tr>

                {/* ── Section B AT EXIT row ── */}
                <tr style={{ backgroundColor: '#0e0e0e' }}>
                  <td style={{ ...cell, ...sticky, color: '#3a3a3a', fontSize: '0.64rem', fontStyle: 'italic', paddingLeft: 10 }}>
                    AT EXIT
                  </td>
                  <td colSpan={A_COLS.length} style={{ padding: '4px 10px', borderBottom: '1px solid #1e1e1e' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0 2px' }}>
                      {B_COLS.map(k => {
                        const el = BCell({ id: k, snap: snapX, dir });
                        return el ? <React.Fragment key={k}>{el}</React.Fragment> : null;
                      })}
                    </div>
                  </td>
                </tr>

                {/* ── Section B notes row ── */}
                <tr style={{ backgroundColor: 'rgba(255,255,255,0.01)' }}>
                  <td style={{ ...cell, ...sticky, color: '#3a3a3a', fontSize: '0.64rem', fontStyle: 'italic', paddingLeft: 10 }}>
                    B NOTES
                  </td>
                  <td colSpan={A_COLS.length} style={{ padding: '3px 10px', borderBottom: '1px solid #1e1e1e' }}>
                    <input
                      type="text"
                      value={getNote(entry, 'macroNotes')}
                      onChange={e => setNote(entry, 'macroNotes', e.target.value)}
                      onBlur={e  => saveNotes(id, 'macroNotes', e.target.value)}
                      placeholder="Add macro/geopolitical notes — war, Fed, tariffs, earnings season..."
                      style={{
                        background: 'transparent', border: 'none', color: '#888',
                        width: '100%', fontStyle: 'italic', fontSize: '0.78rem', outline: 'none',
                      }}
                    />
                  </td>
                </tr>

                {/* ── Trade divider ── */}
                <tr>
                  <td colSpan={TOTAL_COLS} style={{ height: 10, borderBottom: '1px solid rgba(212,160,23,0.18)' }} />
                </tr>

              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
