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
  const [tab,         setTab]         = useState('active');

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const [trRes, acRes, allRes] = await Promise.all([
          fetch(`${API_BASE}/kill-history/track-record`, { headers: authHeaders() }),
          fetch(`${API_BASE}/kill-history/active`,       { headers: authHeaders() }),
          fetch(`${API_BASE}/kill-history`,              { headers: authHeaders() }),
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
      }
    }
    load();
  }, []);

  const closed = useMemo(() => all.filter(s => s.status === 'CLOSED'), [all]);

  const sortedClosed = useMemo(() => {
    return [...closed].sort((a, b) => {
      const va = a[sortClosed.col] ?? '';
      const vb = b[sortClosed.col] ?? '';
      if (typeof va === 'number') return sortClosed.dir * (vb - va);
      return sortClosed.dir * String(va).localeCompare(String(vb));
    });
  }, [closed, sortClosed]);

  function toggleSort(col) {
    setSortClosed(prev => prev.col === col
      ? { col, dir: prev.dir * -1 }
      : { col, dir: -1 }
    );
  }

  function SortTh({ col, children }) {
    const active = sortClosed.col === col;
    return (
      <th onClick={() => toggleSort(col)} style={{
        padding: '9px 10px', color: active ? YELLOW : '#888',
        fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none',
        textAlign: col === 'ticker' || col === 'direction' ? 'left' : 'center',
      }}>
        {children} {active ? (sortClosed.dir === -1 ? '▼' : '▲') : ''}
      </th>
    );
  }

  if (loading) return (
    <div style={{ padding: 40, color: '#888', textAlign: 'center' }}>Loading Kill History...</div>
  );
  if (error) return (
    <div style={{ padding: 40, color: RED }}>Error: {error}</div>
  );

  const tr = trackRecord || {};

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1100, margin: '0 auto', fontFamily: 'inherit', color: '#ddd' }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: YELLOW, margin: 0, letterSpacing: '-0.02em' }}>
          PNTHR Kill History
        </h1>
        <p style={{ fontSize: 13, color: '#666', marginTop: 4 }}>
          Forward-tested track record of every stock that entered the Kill top 10.
          {tr.asOf && <span> Last updated: {fmtD(tr.asOf)}</span>}
        </p>
      </div>

      {/* ── Metric Cards ───────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 24 }}>
        <MetricCard label="Total Trades"   value={tr.totalTrades ?? 0} sub={`${tr.activeTrades ?? 0} active`} />
        <MetricCard label="Win Rate"       value={tr.closedTrades > 0 ? `${tr.winRate}%` : '—'}
          color={tr.winRate >= 60 ? GREEN : tr.winRate >= 40 ? '#ffa500' : RED} />
        <MetricCard label="Avg Win"        value={tr.avgWinPct != null ? fmt(tr.avgWinPct) : '—'} color={GREEN} />
        <MetricCard label="Avg Loss"       value={tr.avgLossPct != null ? fmt(tr.avgLossPct) : '—'} color={RED} />
        <MetricCard label="Profit Factor"  value={tr.profitFactor > 0 ? `${tr.profitFactor}x` : '—'}
          color={tr.profitFactor >= 2 ? GREEN : tr.profitFactor >= 1 ? '#ffa500' : RED} />
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

      {/* ── Tabs ───────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 16, borderBottom: `1px solid ${BORDER}` }}>
        {[
          { key: 'active', label: `Active (${active.length})` },
          { key: 'closed', label: `Closed (${closed.length})` },
          { key: 'breakdown', label: 'Breakdown' },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            background: 'none', border: 'none', padding: '8px 16px',
            fontSize: 13, fontWeight: 700, cursor: 'pointer',
            color: tab === t.key ? YELLOW : '#666',
            borderBottom: tab === t.key ? `2px solid ${YELLOW}` : '2px solid transparent',
            transition: 'color 0.15s',
          }}>{t.label}</button>
        ))}
      </div>

      {/* ── Active Trades Table ─────────────────────────────────────────────── */}
      {tab === 'active' && (
        <>
          {active.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: '#555' }}>
              No active case studies. They appear when a stock enters the Kill top 10.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
                    <th style={{ textAlign: 'left',   padding: '9px 10px', color: '#888', fontWeight: 600 }}>Ticker</th>
                    <th style={{ textAlign: 'left',   padding: '9px 10px', color: '#888', fontWeight: 600 }}>Dir</th>
                    <th style={{ textAlign: 'center', padding: '9px 10px', color: '#888', fontWeight: 600 }}>Entry Date</th>
                    <th style={{ textAlign: 'center', padding: '9px 10px', color: '#888', fontWeight: 600 }}>Entry $</th>
                    <th style={{ textAlign: 'center', padding: '9px 10px', color: '#888', fontWeight: 600 }}>P&L %</th>
                    <th style={{ textAlign: 'center', padding: '9px 10px', color: '#888', fontWeight: 600 }}>Weeks</th>
                    <th style={{ textAlign: 'center', padding: '9px 10px', color: '#888', fontWeight: 600 }}>Max Gain</th>
                    <th style={{ textAlign: 'center', padding: '9px 10px', color: '#888', fontWeight: 600 }}>Kill Rank</th>
                    <th style={{ textAlign: 'left',   padding: '9px 10px', color: '#888', fontWeight: 600 }}>Tier</th>
                  </tr>
                </thead>
                <tbody>
                  {active.map(s => {
                    const lastSnap = s.weeklySnapshots?.slice(-1)[0];
                    const pnlPct   = lastSnap?.pnlPct ?? null;
                    const rankNow  = lastSnap?.killRank;
                    const isPos    = pnlPct != null && pnlPct >= 0;
                    return (
                      <tr key={s.id} style={{
                        borderBottom: `1px solid ${BORDER}`,
                        background: pnlPct != null
                          ? (isPos ? 'rgba(40,167,69,0.05)' : 'rgba(220,53,69,0.05)')
                          : 'transparent',
                      }}>
                        <td style={{ padding: '8px 10px', fontWeight: 800, color: YELLOW }}>{s.ticker}</td>
                        <td style={{ padding: '8px 10px', color: s.direction === 'SHORT' ? RED : GREEN, fontWeight: 700 }}>
                          {s.direction === 'SHORT' ? 'SHORT' : 'LONG'}
                        </td>
                        <td style={{ textAlign: 'center', padding: '8px 10px', color: '#aaa' }}>{fmtD(s.entryDate)}</td>
                        <td style={{ textAlign: 'center', padding: '8px 10px' }}>${s.entryPrice?.toFixed(2)}</td>
                        <td style={{ textAlign: 'center', padding: '8px 10px', fontWeight: 700,
                          color: pnlPct == null ? '#555' : isPos ? GREEN : RED }}>
                          {fmt(pnlPct)}
                        </td>
                        <td style={{ textAlign: 'center', padding: '8px 10px', color: '#aaa' }}>{s.holdingWeeks}</td>
                        <td style={{ textAlign: 'center', padding: '8px 10px', color: GREEN }}>
                          {s.maxFavorable > 0 ? fmt(s.maxFavorable) : '—'}
                        </td>
                        <td style={{ textAlign: 'center', padding: '8px 10px', color: '#aaa' }}>
                          {rankNow != null ? `#${rankNow}` : `#${s.entryRank}`}
                        </td>
                        <td style={{ padding: '8px 10px' }}><TierBadge tier={s.entryTier} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ── Closed Trades Table ─────────────────────────────────────────────── */}
      {tab === 'closed' && (
        <>
          {closed.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: '#555' }}>
              No closed trades yet.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
                    <SortTh col="ticker">Ticker</SortTh>
                    <SortTh col="direction">Dir</SortTh>
                    <SortTh col="entryDate">Entry</SortTh>
                    <SortTh col="exitDate">Exit</SortTh>
                    <SortTh col="pnlPct">P&L %</SortTh>
                    <SortTh col="pnlDollar">P&L $</SortTh>
                    <SortTh col="holdingWeeks">Weeks</SortTh>
                    <th style={{ padding: '9px 10px', color: '#888', fontWeight: 600 }}>Reason</th>
                    <th style={{ padding: '9px 10px', color: '#888', fontWeight: 600 }}>Tier</th>
                    <th style={{ padding: '9px 10px', color: '#888', fontWeight: 600, textAlign: 'center' }}>Source</th>
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
                        <td style={{ textAlign: 'center', padding: '7px 10px', color: '#aaa', fontSize: 11 }}>{fmtD(s.exitDate)}</td>
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
                        <td style={{ textAlign: 'center', padding: '7px 10px' }}>
                          <span style={{ fontSize: 10, color: '#555' }}>
                            {s.entrySource === 'FRIDAY_PIPELINE' ? 'FRI' : 'MID'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ── Breakdown Tab ──────────────────────────────────────────────────── */}
      {tab === 'breakdown' && (
        <div>
          {closed.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: '#555' }}>
              No closed trades yet — breakdown will appear after first exits.
            </div>
          ) : (
            <>
              <BreakdownTable title="By Tier"      data={tr.byTier}      defaultOpen={true} />
              <BreakdownTable title="By Direction"  data={tr.byDirection} />
              <BreakdownTable title="By Sector"     data={tr.bySector} />
              <BreakdownTable title="By Entry Source (Friday vs Mid-Week)" data={tr.bySource} />

              {/* Monthly returns */}
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
            </>
          )}
        </div>
      )}

    </div>
  );
}
