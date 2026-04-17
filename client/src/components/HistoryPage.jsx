// client/src/components/HistoryPage.jsx
// ── PNTHR Kill History — Track Record System ──────────────────────────────────
//
// Displays the forward-tested track record of every stock that entered the
// Kill top 10. Pulls from three endpoints:
//   GET /api/kill-history/track-record  — aggregate stats
//   GET /api/kill-history/active        — live open trades
//   GET /api/kill-history              — all trades (for closed table + equity curve)

import { useState, useEffect, useMemo } from 'react';
import { authHeaders, API_BASE } from '../services/api';

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt  = (n, dec = 1) => n == null ? '—' : `${n >= 0 ? '+' : ''}${Number(n).toFixed(dec)}%`;
const fmtP = (n) => n == null ? '—' : `${n >= 0 ? '+' : '-'}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const fmtD = (s) => s ? new Date(s + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) : '—';

// ── Colours ───────────────────────────────────────────────────────────────────

const YELLOW = '#fcf000';
const GREEN  = '#28a745';
const RED    = '#dc3545';
const CARD_BG = 'rgba(255,255,255,0.04)';
const BORDER  = 'rgba(255,255,255,0.08)';

// ── Tier badge colours ─────────────────────────────────────────────────────────

const TIER_COLORS = {
  'ALPHA PNTHR KILL': { bg: 'rgba(252,240,0,0.15)', color: YELLOW },
  'STRIKING':         { bg: 'rgba(0,200,100,0.12)', color: '#00c864' },
  'HUNTING':          { bg: 'rgba(0,150,255,0.12)', color: '#0096ff' },
  'POUNCING':         { bg: 'rgba(150,80,255,0.12)', color: '#9650ff' },
  'COILING':          { bg: 'rgba(255,165,0,0.12)',  color: '#ffa500' },
};

function TierBadge({ tier }) {
  const c = TIER_COLORS[tier] || { bg: 'rgba(255,255,255,0.06)', color: '#aaa' };
  return (
    <span style={{
      display: 'inline-block', fontSize: 10, fontWeight: 700, letterSpacing: '0.03em',
      padding: '2px 7px', borderRadius: 4, background: c.bg, color: c.color,
    }}>
      {tier}
    </span>
  );
}

// ── Equity Curve (SVG) ─────────────────────────────────────────────────────────

function EquityCurve({ closed }) {
  const WIDTH = 700, HEIGHT = 180, PAD = { t: 16, r: 16, b: 32, l: 56 };

  const points = useMemo(() => {
    const sorted = [...closed].sort((a, b) => (a.exitDate || '').localeCompare(b.exitDate || ''));
    let cum = 0;
    const pts = [{ date: '', cum: 0, label: '' }];
    for (const t of sorted) {
      cum += (t.pnlDollar || 0);
      pts.push({ date: t.exitDate, cum: +cum.toFixed(0), label: t.ticker });
    }
    return pts;
  }, [closed]);

  if (points.length < 2) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 0', color: '#555', fontSize: 13 }}>
        No closed trades yet — equity curve will appear after the first exit
      </div>
    );
  }

  const vals = points.map(p => p.cum);
  const minV = Math.min(0, ...vals);
  const maxV = Math.max(0, ...vals);
  const range = maxV - minV || 1;

  const iW = WIDTH - PAD.l - PAD.r;
  const iH = HEIGHT - PAD.t - PAD.b;

  const toX = (i) => PAD.l + (i / (points.length - 1)) * iW;
  const toY = (v) => PAD.t + iH - ((v - minV) / range) * iH;

  const polyline = points.map((p, i) => `${toX(i)},${toY(p.cum)}`).join(' ');
  const zeroY    = toY(0);
  const lastPt   = points[points.length - 1];
  const lastX    = toX(points.length - 1);
  const lastY    = toY(lastPt.cum);
  const isPos    = lastPt.cum >= 0;

  // Y axis ticks
  const yTicks = [];
  const step = range / 4;
  for (let i = 0; i <= 4; i++) {
    const val = minV + step * i;
    const y   = toY(val);
    const lbl = val >= 0 ? `+$${Math.round(val / 1000)}k` : `-$${Math.round(Math.abs(val) / 1000)}k`;
    yTicks.push({ y, lbl });
  }

  return (
    <svg width="100%" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} style={{ display: 'block', overflow: 'visible' }}>
      {/* Grid lines */}
      {yTicks.map((t, i) => (
        <g key={i}>
          <line x1={PAD.l} y1={t.y} x2={WIDTH - PAD.r} y2={t.y}
            stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
          <text x={PAD.l - 6} y={t.y + 4} textAnchor="end" fill="#555" fontSize={10}>{t.lbl}</text>
        </g>
      ))}

      {/* Zero line */}
      <line x1={PAD.l} y1={zeroY} x2={WIDTH - PAD.r} y2={zeroY}
        stroke="rgba(255,255,255,0.2)" strokeWidth={1} strokeDasharray="4,3" />

      {/* Equity line */}
      <polyline
        points={polyline}
        fill="none"
        stroke={isPos ? GREEN : RED}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* Final value dot + label */}
      <circle cx={lastX} cy={lastY} r={4} fill={isPos ? GREEN : RED} />
      <text x={lastX + 6} y={lastY + 4} fill={isPos ? GREEN : RED} fontSize={11} fontWeight={700}>
        {fmtP(lastPt.cum)}
      </text>
    </svg>
  );
}

// ── Metric Card ───────────────────────────────────────────────────────────────

function MetricCard({ label, value, sub, color }) {
  return (
    <div style={{
      background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 8,
      padding: '14px 18px', minWidth: 110, flex: '1 1 100px',
    }}>
      <div style={{ fontSize: 11, color: '#888', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: color || '#fff', lineHeight: 1.1 }}>{value ?? '—'}</div>
      {sub && <div style={{ fontSize: 11, color: '#666', marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

// ── Breakdown Panel ───────────────────────────────────────────────────────────

function BreakdownTable({ title, data, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const entries = Object.entries(data || {}).filter(([, v]) => v.count > 0);
  if (entries.length === 0) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      <button onClick={() => setOpen(o => !o)} style={{
        width: '100%', textAlign: 'left', background: CARD_BG,
        border: `1px solid ${BORDER}`, borderRadius: open ? '6px 6px 0 0' : 6,
        color: '#ccc', padding: '10px 14px', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        fontSize: 13, fontWeight: 600,
      }}>
        <span>{title}</span>
        <span style={{ color: '#555' }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{ border: `1px solid ${BORDER}`, borderTop: 'none', borderRadius: '0 0 6px 6px', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                <th style={{ textAlign: 'left', padding: '7px 12px', color: '#888', fontWeight: 600 }}>Group</th>
                <th style={{ textAlign: 'center', padding: '7px 12px', color: '#888', fontWeight: 600 }}>Trades</th>
                <th style={{ textAlign: 'center', padding: '7px 12px', color: '#888', fontWeight: 600 }}>Win Rate</th>
                <th style={{ textAlign: 'center', padding: '7px 12px', color: '#888', fontWeight: 600 }}>Avg P&L</th>
              </tr>
            </thead>
            <tbody>
              {entries.sort((a, b) => b[1].winRate - a[1].winRate).map(([name, v]) => (
                <tr key={name} style={{ borderTop: `1px solid ${BORDER}` }}>
                  <td style={{ padding: '7px 12px', color: '#ddd' }}>{name}</td>
                  <td style={{ textAlign: 'center', padding: '7px 12px', color: '#aaa' }}>{v.count}</td>
                  <td style={{ textAlign: 'center', padding: '7px 12px',
                    color: v.winRate >= 60 ? GREEN : v.winRate >= 40 ? '#ffa500' : RED,
                    fontWeight: 700 }}>
                    {v.winRate}%
                  </td>
                  <td style={{ textAlign: 'center', padding: '7px 12px',
                    color: v.avgPnl >= 0 ? GREEN : RED, fontWeight: 700 }}>
                    {fmt(v.avgPnl)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function HistoryPage() {
  const [trackRecord, setTrackRecord] = useState(null);
  const [active,      setActive]      = useState([]);
  const [all,         setAll]         = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const [sortClosed,  setSortClosed]  = useState({ col: 'exitDate', dir: -1 });
  const [sortActive,  setSortActive]  = useState({ col: 'entryRank', dir: 1 });

  const [refreshing, setRefreshing] = useState(false);

  async function load(isManual = false) {
    try {
      if (isManual) setRefreshing(true); else setLoading(true);
      setError(null);
      const [trRes, acRes, allRes] = await Promise.all([
        fetch(`${API_BASE}/api/kill-history/track-record`, { headers: authHeaders() }),
        fetch(`${API_BASE}/api/kill-history/active`,       { headers: authHeaders() }),
        fetch(`${API_BASE}/api/kill-history`,              { headers: authHeaders() }),
      ]);
      if (!trRes.ok || !acRes.ok || !allRes.ok) throw new Error('Failed to load history');
      const [tr, ac, al] = await Promise.all([trRes.json(), acRes.json(), allRes.json()]);
      setTrackRecord(tr);
      setActive(ac.studies || []);
      setAll(al.studies || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const closed = useMemo(() => all.filter(s => s.status === 'CLOSED'), [all]);

  // Generic sort helper for both tables
  function sortRows(rows, sortState, extraCols) {
    return [...rows].sort((a, b) => {
      let va = extraCols?.[sortState.col]?.(a) ?? a[sortState.col] ?? '';
      let vb = extraCols?.[sortState.col]?.(b) ?? b[sortState.col] ?? '';
      if (typeof va === 'number' && typeof vb === 'number') return sortState.dir * (va - vb);
      return sortState.dir * String(va).localeCompare(String(vb));
    });
  }

  const sortedClosed = useMemo(() => sortRows(closed, sortClosed), [closed, sortClosed]);

  // Active trades: derive current P&L and rank from snapshots for sorting
  const activeWithDerived = useMemo(() => active.map(s => {
    const lastSnap = s.weeklySnapshots?.slice(-1)[0];
    return { ...s, _pnlPct: lastSnap?.pnlPct ?? 0, _currentRank: lastSnap?.killRank ?? s.entryRank };
  }), [active]);

  const sortedActive = useMemo(() => sortRows(activeWithDerived, sortActive, {
    pnlPct: r => r._pnlPct,
    currentRank: r => r._currentRank,
  }), [activeWithDerived, sortActive]);

  // Sortable header factory — works with any sort state setter
  function makeSortTh(sortState, setSortState) {
    return function SortTh({ col, children, align }) {
      const isActive = sortState.col === col;
      return (
        <th onClick={() => setSortState(prev => prev.col === col ? { col, dir: prev.dir * -1 } : { col, dir: -1 })} style={{
          padding: '9px 10px', color: isActive ? YELLOW : '#888',
          fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none',
          textAlign: align || 'center',
        }}>
          {children} {isActive ? (sortState.dir === -1 ? '▼' : '▲') : ''}
        </th>
      );
    };
  }

  const ClosedSortTh = makeSortTh(sortClosed, setSortClosed);
  const ActiveSortTh = makeSortTh(sortActive, setSortActive);

  if (loading) return (
    <div style={{ padding: 40, color: '#888', textAlign: 'center' }}>Loading Kill History...</div>
  );
  if (error) return (
    <div style={{ padding: 40, color: RED }}>Error: {error}</div>
  );

  const tr = trackRecord || {};

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1100, margin: '0 auto', fontFamily: 'inherit', color: '#ddd', background: '#0a0a0a', minHeight: '100vh' }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24, gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: YELLOW, margin: 0, letterSpacing: '-0.02em' }}>
            PNTHR Kill History
          </h1>
          <p style={{ fontSize: 13, color: '#666', marginTop: 4 }}>
            Forward-tested track record of every stock that entered the Kill top 10.
            {tr.asOf && <span> Last updated: {fmtD(tr.asOf)}</span>}
          </p>
        </div>
        <button
          onClick={() => load(true)}
          disabled={refreshing}
          style={{
            background: 'transparent',
            border: `1px solid ${refreshing ? '#333' : '#555'}`,
            color: refreshing ? '#444' : '#aaa',
            borderRadius: 5,
            padding: '6px 14px',
            fontSize: 12,
            fontWeight: 600,
            cursor: refreshing ? 'not-allowed' : 'pointer',
            whiteSpace: 'nowrap',
            letterSpacing: '0.04em',
          }}
        >
          {refreshing ? '↻ Refreshing…' : '↺ Refresh'}
        </button>
      </div>

      {/* ── Metric Cards ───────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 24 }}>
        <MetricCard label="Total Trades"   value={tr.totalTrades ?? 0} sub={`${tr.activeTrades ?? 0} active`} />
        <MetricCard label="Win Rate"       value={tr.closedTrades > 0 ? `${tr.winRate}%` : '—'}
          color={tr.winRate >= 60 ? GREEN : tr.winRate >= 40 ? '#ffa500' : RED} />
        <MetricCard label="Avg Win"        value={tr.avgWinPct != null ? fmt(tr.avgWinPct) : '—'} color={GREEN} />
        <MetricCard label="Avg Loss"       value={tr.avgLossPct != null ? fmt(tr.avgLossPct) : '—'} color={RED} />
        <MetricCard label="Profit Factor"
          value={tr.profitFactor === 999 ? '∞' : tr.profitFactor > 0 ? `${tr.profitFactor}x` : '—'}
          sub={tr.profitFactor === 999 ? 'No losses yet' : undefined}
          color={tr.profitFactor >= 2 || tr.profitFactor === 999 ? GREEN : tr.profitFactor >= 1 ? '#ffa500' : RED} />
        <MetricCard label="Active Now"     value={tr.activeTrades ?? 0} color={YELLOW} />
        <MetricCard label="Avg Hold"       value={tr.avgHoldingWeeks > 0 ? `${tr.avgHoldingWeeks}w` : '—'} />
        <MetricCard label="Big Winners"    value={tr.bigWinnerRate > 0 ? `${tr.bigWinnerRate}%` : '—'}
          sub="trades ≥ +20%" color={GREEN} />
      </div>

      {/* ── Equity Curve ───────────────────────────────────────────────────── */}
      {closed.length > 0 && (
        <div style={{
          background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 8,
          padding: '16px 18px', marginBottom: 24,
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#aaa', marginBottom: 12 }}>
            Equity Curve — Cumulative P&L <span style={{ color: '#555', fontWeight: 400 }}>(standardized $10K / trade)</span>
          </div>
          <EquityCurve closed={closed} />
        </div>
      )}

      {/* ── Closed Trades ─────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: '#ccc', margin: '0 0 12px', letterSpacing: '0.02em' }}>
          Closed Trades <span style={{ color: '#555', fontWeight: 400, fontSize: 13 }}>({closed.length})</span>
        </h2>
        {closed.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: '#555' }}>
            No closed trades yet.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
                  <ClosedSortTh col="ticker" align="left">Ticker</ClosedSortTh>
                  <ClosedSortTh col="direction" align="left">Dir</ClosedSortTh>
                  <ClosedSortTh col="entryDate">Entry Date</ClosedSortTh>
                  <ClosedSortTh col="entryPrice">Entry $</ClosedSortTh>
                  <ClosedSortTh col="entryRank">Entry Kill Rank</ClosedSortTh>
                  <ClosedSortTh col="exitDate">Exit Date</ClosedSortTh>
                  <ClosedSortTh col="exitPrice">Exit $</ClosedSortTh>
                  <ClosedSortTh col="pnlPct">P&L %</ClosedSortTh>
                  <ClosedSortTh col="pnlDollar">P&L $</ClosedSortTh>
                  <ClosedSortTh col="holdingWeeks">Weeks</ClosedSortTh>
                  <th style={{ padding: '9px 10px', color: '#888', fontWeight: 600 }}>Reason</th>
                  <th style={{ padding: '9px 10px', color: '#888', fontWeight: 600 }}>Tier</th>
                </tr>
              </thead>
              <tbody>
                {sortedClosed.map(s => {
                  const isPos = (s.pnlPct ?? 0) > 0;
                  return (
                    <tr key={s.id} style={{
                      borderBottom: `1px solid ${BORDER}`,
                      background: isPos ? 'rgba(40,167,69,0.05)' : 'rgba(220,53,69,0.05)',
                    }}>
                      <td style={{ padding: '7px 10px', fontWeight: 800, color: YELLOW }}>{s.ticker}</td>
                      <td style={{ padding: '7px 10px', color: s.direction === 'SHORT' ? RED : GREEN, fontWeight: 700 }}>
                        {s.direction === 'SHORT' ? 'SS' : 'BL'}
                      </td>
                      <td style={{ textAlign: 'center', padding: '7px 10px', color: '#aaa', fontSize: 11 }}>{fmtD(s.entryDate)}</td>
                      <td style={{ textAlign: 'center', padding: '7px 10px' }}>${s.entryPrice?.toFixed(2)}</td>
                      <td style={{ textAlign: 'center', padding: '7px 10px', color: YELLOW, fontWeight: 700 }}>#{s.entryRank}</td>
                      <td style={{ textAlign: 'center', padding: '7px 10px', color: '#aaa', fontSize: 11 }}>{fmtD(s.exitDate)}</td>
                      <td style={{ textAlign: 'center', padding: '7px 10px' }}>${s.exitPrice?.toFixed(2)}</td>
                      <td style={{ textAlign: 'center', padding: '7px 10px', fontWeight: 700,
                        color: isPos ? GREEN : RED }}>
                        {fmt(s.pnlPct)}
                      </td>
                      <td style={{ textAlign: 'center', padding: '7px 10px', fontWeight: 700,
                        color: isPos ? GREEN : RED }}>
                        {fmtP(s.pnlDollar)}
                      </td>
                      <td style={{ textAlign: 'center', padding: '7px 10px', color: '#aaa' }}>{s.holdingWeeks}</td>
                      <td style={{ padding: '7px 10px' }}>
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 3,
                          background: s.exitReason === 'OVEREXTENDED'
                            ? 'rgba(255,165,0,0.15)' : isPos ? 'rgba(40,167,69,0.15)' : 'rgba(220,53,69,0.15)',
                          color: s.exitReason === 'OVEREXTENDED' ? '#ffa500' : isPos ? GREEN : RED,
                        }}>
                          {s.exitReason}
                        </span>
                      </td>
                      <td style={{ padding: '7px 10px' }}><TierBadge tier={s.entryTier} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Open Trades ───────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: '#ccc', margin: '0 0 4px', letterSpacing: '0.02em' }}>
          Open Trades <span style={{ color: '#555', fontWeight: 400, fontSize: 13 }}>({active.length})</span>
        </h2>
        {active.length > 0 && (() => {
          const lastSnap = active[0]?.weeklySnapshots?.slice(-1)[0];
          const snapDate = lastSnap?.date;
          return snapDate ? (
            <p style={{ fontSize: 11, color: '#555', margin: '0 0 12px' }}>
              P&L as of {fmtD(snapDate)}
            </p>
          ) : null;
        })()}
        {active.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: '#555' }}>
            No active case studies. They appear when a stock enters the Kill top 10.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
                  <ActiveSortTh col="ticker" align="left">Ticker</ActiveSortTh>
                  <ActiveSortTh col="direction" align="left">Dir</ActiveSortTh>
                  <ActiveSortTh col="entryDate">Entry Date</ActiveSortTh>
                  <ActiveSortTh col="entryPrice">Entry $</ActiveSortTh>
                  <ActiveSortTh col="entryRank">Entry Kill Rank</ActiveSortTh>
                  <ActiveSortTh col="currentRank">Current Kill Rank</ActiveSortTh>
                  <ActiveSortTh col="pnlPct">P&L %</ActiveSortTh>
                  <ActiveSortTh col="holdingWeeks">Weeks</ActiveSortTh>
                  <ActiveSortTh col="maxFavorable">Max Gain</ActiveSortTh>
                  <th style={{ padding: '9px 10px', color: '#888', fontWeight: 600 }}>Tier</th>
                </tr>
              </thead>
              <tbody>
                {sortedActive.map(s => {
                  const pnlPct   = s._pnlPct;
                  const rankNow  = s._currentRank;
                  const isPos    = pnlPct >= 0;
                  return (
                    <tr key={s.id} style={{
                      borderBottom: `1px solid ${BORDER}`,
                      background: pnlPct !== 0
                        ? (isPos ? 'rgba(40,167,69,0.05)' : 'rgba(220,53,69,0.05)')
                        : 'transparent',
                    }}>
                      <td style={{ padding: '8px 10px', fontWeight: 800, color: YELLOW }}>{s.ticker}</td>
                      <td style={{ padding: '8px 10px', color: s.direction === 'SHORT' ? RED : GREEN, fontWeight: 700 }}>
                        {s.direction === 'SHORT' ? 'SS' : 'BL'}
                      </td>
                      <td style={{ textAlign: 'center', padding: '8px 10px', color: '#aaa', fontSize: 11 }}>{fmtD(s.entryDate)}</td>
                      <td style={{ textAlign: 'center', padding: '8px 10px' }}>${s.entryPrice?.toFixed(2)}</td>
                      <td style={{ textAlign: 'center', padding: '8px 10px', color: YELLOW, fontWeight: 700 }}>#{s.entryRank}</td>
                      <td style={{ textAlign: 'center', padding: '8px 10px', color: '#aaa' }}>#{rankNow}</td>
                      <td style={{ textAlign: 'center', padding: '8px 10px', fontWeight: 700,
                        color: pnlPct === 0 ? '#555' : isPos ? GREEN : RED }}>
                        {fmt(pnlPct)}
                      </td>
                      <td style={{ textAlign: 'center', padding: '8px 10px', color: '#aaa' }}>{s.holdingWeeks}</td>
                      <td style={{ textAlign: 'center', padding: '8px 10px', color: GREEN }}>
                        {s.maxFavorable > 0 ? fmt(s.maxFavorable) : '—'}
                      </td>
                      <td style={{ padding: '8px 10px' }}><TierBadge tier={s.entryTier} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Breakdown ─────────────────────────────────────────────────────── */}
      {closed.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: '#ccc', margin: '0 0 12px', letterSpacing: '0.02em' }}>
            Breakdown
          </h2>
          <BreakdownTable title="By Tier"      data={tr.byTier}      defaultOpen={true} />
          <BreakdownTable title="By Direction"  data={tr.byDirection} />
          <BreakdownTable title="By Sector"     data={tr.bySector} />
          <BreakdownTable title="By Entry Source (Friday vs Mid-Week)" data={tr.bySource} />

          {tr.monthlyReturns?.length > 0 && (
            <div style={{
              background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 8,
              padding: '14px 16px', marginTop: 12,
            }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#aaa', marginBottom: 10 }}>Monthly Returns</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {tr.monthlyReturns.map(m => (
                  <div key={m.month} style={{
                    background: 'rgba(255,255,255,0.04)', border: `1px solid ${BORDER}`,
                    borderRadius: 6, padding: '8px 12px', minWidth: 90, textAlign: 'center',
                  }}>
                    <div style={{ fontSize: 10, color: '#555', marginBottom: 3 }}>{m.month}</div>
                    <div style={{ fontSize: 16, fontWeight: 800, color: m.avgPnl >= 0 ? GREEN : RED }}>
                      {fmt(m.avgPnl)}
                    </div>
                    <div style={{ fontSize: 10, color: '#555' }}>{m.trades} trade{m.trades !== 1 ? 's' : ''}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

    </div>
  );
}
