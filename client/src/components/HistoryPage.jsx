// client/src/components/HistoryPage.jsx
// ── PNTHR Kill History — Track Record System ──────────────────────────────────
//
// Displays the forward-tested track record of every stock that entered the
// Kill top 10. Pulls from four endpoints:
//   GET /api/kill-history/track-record  — aggregate stats
//   GET /api/kill-history/active        — live open trades
//   GET /api/kill-history              — all trades (for closed table + equity curve)
//   GET /api/kill-history/simulation   — pyramid simulation results (NAV-independent)

import { useState, useEffect, useMemo } from 'react';
import { authHeaders, API_BASE } from '../services/api';

// ── Constants (match sizingUtils.js) ─────────────────────────────────────────

const STRIKE_PCT  = [0.35, 0.25, 0.20, 0.12, 0.08];
const NAV_OPTIONS = [100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000];

function sizeForNav(nav, entryPrice, stopPrice) {
  const tickerCap = nav * 0.10;
  const vitality  = nav * 0.01;
  const rps       = Math.abs(entryPrice - stopPrice);
  if (rps <= 0) return 0;
  return Math.floor(Math.min(Math.floor(vitality / rps), Math.floor(tickerCap / entryPrice)));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt  = (n, dec = 1) => n == null ? '—' : `${n >= 0 ? '+' : ''}${Number(n).toFixed(dec)}%`;
const fmtP = (n) => n == null ? '—' : `${n >= 0 ? '+' : '-'}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const fmtD = (s) => s ? new Date(s + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) : '—';
const fmtNav = (n) => n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : `$${(n / 1_000).toFixed(0)}K`;

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

// ── Equity Curve (SVG) — weekly dates on X axis ──────────────────────────────

function EquityCurve({ closed }) {
  const WIDTH = 700, HEIGHT = 200, PAD = { t: 16, r: 16, b: 48, l: 64 };

  const points = useMemo(() => {
    const sorted = [...closed].sort((a, b) => (a.exitDate || '').localeCompare(b.exitDate || ''));
    let cum = 0;
    const pts = [];
    for (const t of sorted) {
      cum += (t.pnlDollar || 0);
      pts.push({ date: t.exitDate, cum: +cum.toFixed(0), label: t.ticker });
    }
    return pts;
  }, [closed]);

  if (points.length < 1) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 0', color: '#555', fontSize: 13 }}>
        No closed trades yet — equity curve will appear after the first exit
      </div>
    );
  }

  // Add origin point at earliest date
  const firstDate = points[0]?.date || '';
  const allPts = [{ date: firstDate, cum: 0, label: '' }, ...points];

  const vals = allPts.map(p => p.cum);
  const minV = Math.min(0, ...vals);
  const maxV = Math.max(0, ...vals);
  const range = maxV - minV || 1;

  const iW = WIDTH - PAD.l - PAD.r;
  const iH = HEIGHT - PAD.t - PAD.b;

  const toX = (i) => PAD.l + (i / (allPts.length - 1)) * iW;
  const toY = (v) => PAD.t + iH - ((v - minV) / range) * iH;

  const polyline = allPts.map((p, i) => `${toX(i)},${toY(p.cum)}`).join(' ');
  const zeroY    = toY(0);
  const lastPt   = allPts[allPts.length - 1];
  const lastX    = toX(allPts.length - 1);
  const lastY    = toY(lastPt.cum);
  const isPos    = lastPt.cum >= 0;

  // Y axis ticks
  const yTicks = [];
  const step = range / 4;
  for (let i = 0; i <= 4; i++) {
    const val = minV + step * i;
    const y   = toY(val);
    let lbl;
    const absVal = Math.abs(val);
    if (absVal >= 1_000_000) lbl = `${val >= 0 ? '+' : '-'}$${(absVal / 1_000_000).toFixed(1)}M`;
    else if (absVal >= 1000) lbl = `${val >= 0 ? '+' : '-'}$${Math.round(absVal / 1000)}k`;
    else lbl = `${val >= 0 ? '+' : '-'}$${Math.round(absVal)}`;
    yTicks.push({ y, lbl });
  }

  // X axis — weekly date labels (show ~6–10 labels evenly spaced)
  const xLabels = [];
  const totalPts = allPts.length;
  const maxLabels = Math.min(10, totalPts);
  const labelStep = Math.max(1, Math.floor(totalPts / maxLabels));
  for (let i = 0; i < totalPts; i += labelStep) {
    const pt = allPts[i];
    if (pt.date) {
      xLabels.push({ x: toX(i), label: fmtD(pt.date) });
    }
  }
  // Always include last point
  if (totalPts > 1) {
    const last = allPts[totalPts - 1];
    if (last.date) xLabels.push({ x: toX(totalPts - 1), label: fmtD(last.date) });
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

      {/* X axis date labels */}
      {xLabels.map((xl, i) => (
        <text key={i} x={xl.x} y={HEIGHT - PAD.b + 18} textAnchor="middle" fill="#555" fontSize={9}
          transform={`rotate(-30, ${xl.x}, ${HEIGHT - PAD.b + 18})`}>
          {xl.label}
        </text>
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
  const [simData,     setSimData]     = useState(null);
  const [nav,         setNav]         = useState(1_000_000);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const [sortClosed,  setSortClosed]  = useState({ col: 'exitDate', dir: -1 });
  const [sortActive,  setSortActive]  = useState({ col: 'entryRank', dir: 1 });
  const [dataSource,  setDataSource]  = useState('kill10'); // 'kill10' | 'orders'
  const [ordersData,  setOrdersData]  = useState(null);
  const [ordersLoading, setOrdersLoading] = useState(false);

  const [refreshing, setRefreshing] = useState(false);

  async function load(isManual = false) {
    try {
      if (isManual) setRefreshing(true); else setLoading(true);
      setError(null);
      const [trRes, acRes, allRes, simRes] = await Promise.all([
        fetch(`${API_BASE}/api/kill-history/track-record`, { headers: authHeaders() }),
        fetch(`${API_BASE}/api/kill-history/active`,       { headers: authHeaders() }),
        fetch(`${API_BASE}/api/kill-history`,              { headers: authHeaders() }),
        fetch(`${API_BASE}/api/kill-history/simulation`,   { headers: authHeaders() }),
      ]);
      if (!trRes.ok || !acRes.ok || !allRes.ok) throw new Error('Failed to load history');
      const [tr, ac, al] = await Promise.all([trRes.json(), acRes.json(), allRes.json()]);
      setTrackRecord(tr);
      setActive(ac.studies || []);
      setAll(al.studies || []);
      if (simRes.ok) {
        const sim = await simRes.json();
        setSimData(sim);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch Orders 2026 backtest data on demand
  async function loadOrders() {
    if (ordersData) return; // Already loaded
    try {
      setOrdersLoading(true);
      const res = await fetch(`${API_BASE}/api/journal/backtest/2026`, { headers: authHeaders() });
      if (!res.ok) throw new Error('Failed to load Orders data');
      const data = await res.json();
      setOrdersData(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setOrdersLoading(false);
    }
  }

  useEffect(() => {
    if (dataSource === 'orders') loadOrders();
  }, [dataSource]); // eslint-disable-line react-hooks/exhaustive-deps

  const closed = useMemo(() => all.filter(s => s.status === 'CLOSED'), [all]);

  // ── Pyramid P&L computation (NAV-scaled from simulation) ──────────────────
  // Sim results are NAV-independent (lot fills, exit prices).
  // We scale shares/dollars here based on selected NAV.
  const pyramidTrades = useMemo(() => {
    if (!simData?.trades) return [];
    return simData.trades.map(t => {
      const totalShares = sizeForNav(nav, t.entryPrice, t.initStop);
      const isLong = t.direction === 'LONG';

      // Compute per-lot shares and cost
      let totalCost = 0, totalShr = 0;
      const lotDetails = (t.lots || []).map(l => {
        const shr = Math.max(1, Math.round(totalShares * l.pctOfTotal));
        const cost = shr * l.fillPrice;
        totalCost += cost;
        totalShr += shr;
        return { ...l, shares: shr, cost };
      });

      // FEAST: 50% of filled shares exit at feast price, rest at final exit
      let pnlDollar = 0;
      let exitPrice = null;
      let exitDate  = null;
      let exitReason = null;

      if (t.status === 'CLOSED' && t.finalExit) {
        exitPrice  = t.finalExit.price;
        exitDate   = t.finalExit.date;
        exitReason = t.finalExit.reason;

        if (t.feastExit) {
          // Split: 50% at FEAST, 50% at final
          const feastShr = Math.floor(totalShr * 0.5);
          const restShr  = totalShr - feastShr;
          const avgCost  = totalShr > 0 ? totalCost / totalShr : t.entryPrice;

          const feastPnl = isLong
            ? (t.feastExit.price - avgCost) * feastShr
            : (avgCost - t.feastExit.price) * feastShr;
          const restPnl = isLong
            ? (t.finalExit.price - avgCost) * restShr
            : (avgCost - t.finalExit.price) * restShr;
          pnlDollar = feastPnl + restPnl;
          exitReason = `FEAST+${t.finalExit.reason}`;
        } else {
          const avgCost = totalShr > 0 ? totalCost / totalShr : t.entryPrice;
          pnlDollar = isLong
            ? (t.finalExit.price - avgCost) * totalShr
            : (avgCost - t.finalExit.price) * totalShr;
        }
      } else {
        // Active — use latest price for unrealized P&L
        const avgCost = totalShr > 0 ? totalCost / totalShr : t.entryPrice;
        const curPrice = t.latestPrice;
        if (t.feastExit) {
          const feastShr = Math.floor(totalShr * 0.5);
          const restShr  = totalShr - feastShr;
          const feastPnl = isLong
            ? (t.feastExit.price - avgCost) * feastShr
            : (avgCost - t.feastExit.price) * feastShr;
          const restPnl = isLong
            ? (curPrice - avgCost) * restShr
            : (avgCost - curPrice) * restShr;
          pnlDollar = feastPnl + restPnl;
        } else {
          pnlDollar = isLong
            ? (curPrice - avgCost) * totalShr
            : (avgCost - curPrice) * totalShr;
        }
        exitDate = t.latestDate;
      }

      const pnlPct = totalCost > 0 ? (pnlDollar / totalCost) * 100 : 0;

      return {
        ...t,
        lotDetails,
        totalShares: totalShr,
        totalCost: +totalCost.toFixed(2),
        pnlDollar: +pnlDollar.toFixed(2),
        pnlPct: +pnlPct.toFixed(2),
        exitPrice,
        exitDate,
        exitReason,
        lotsFilledCount: lotDetails.length,
      };
    });
  }, [simData, nav]);

  const pyramidClosed = useMemo(() => pyramidTrades.filter(t => t.status === 'CLOSED'), [pyramidTrades]);
  const pyramidActive = useMemo(() => pyramidTrades.filter(t => t.status === 'ACTIVE'), [pyramidTrades]);

  // Pyramid aggregate stats
  const pyramidStats = useMemo(() => {
    const cl = pyramidClosed;
    if (cl.length === 0) return null;
    const winners = cl.filter(t => t.pnlDollar > 0);
    const losers  = cl.filter(t => t.pnlDollar <= 0);
    const grossWin  = winners.reduce((s, t) => s + t.pnlDollar, 0);
    const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnlDollar, 0));
    const totalPnl  = cl.reduce((s, t) => s + t.pnlDollar, 0);
    return {
      totalTrades: pyramidTrades.length,
      closedTrades: cl.length,
      activeTrades: pyramidActive.length,
      winRate: +(winners.length / cl.length * 100).toFixed(1),
      totalPnl: +totalPnl.toFixed(0),
      avgWinDollar: winners.length > 0 ? +(grossWin / winners.length).toFixed(0) : 0,
      avgLossDollar: losers.length > 0 ? +(-grossLoss / losers.length).toFixed(0) : 0,
      profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? 999 : 0),
      avgLotsPerTrade: cl.length > 0 ? +(cl.reduce((s, t) => s + t.lotsFilledCount, 0) / cl.length).toFixed(1) : 0,
    };
  }, [pyramidClosed, pyramidActive, pyramidTrades]);

  // Pyramid breakdown tables (by tier, direction, sector) + monthly returns
  const pyramidBreakdown = useMemo(() => {
    const cl = pyramidClosed;
    if (cl.length === 0) return null;

    function buildGroup(keyFn) {
      const groups = {};
      for (const t of cl) {
        const k = keyFn(t) || 'Unknown';
        if (!groups[k]) groups[k] = { count: 0, wins: 0, totalPnl: 0 };
        groups[k].count++;
        if (t.pnlDollar > 0) groups[k].wins++;
        groups[k].totalPnl += t.pnlPct;
      }
      for (const k of Object.keys(groups)) {
        groups[k].winRate = +(groups[k].wins / groups[k].count * 100).toFixed(1);
        groups[k].avgPnl  = +(groups[k].totalPnl / groups[k].count).toFixed(1);
        delete groups[k].totalPnl;
      }
      return groups;
    }

    // Monthly returns by exit month
    const byMonth = {};
    for (const t of cl) {
      const month = t.exitDate?.substring(0, 7);
      if (!month) continue;
      if (!byMonth[month]) byMonth[month] = { trades: 0, totalPnl: 0, totalDollar: 0 };
      byMonth[month].trades++;
      byMonth[month].totalPnl += t.pnlPct;
      byMonth[month].totalDollar += t.pnlDollar;
    }
    const monthlyReturns = Object.entries(byMonth)
      .map(([month, d]) => ({
        month,
        trades: d.trades,
        avgPnl: +(d.totalPnl / d.trades).toFixed(1),
        totalDollar: +d.totalDollar.toFixed(0),
      }))
      .sort((a, b) => a.month.localeCompare(b.month));

    return {
      byTier:      buildGroup(t => t.entryTier),
      byDirection: buildGroup(t => t.direction),
      bySector:    buildGroup(t => t.sector),
      monthlyReturns,
    };
  }, [pyramidClosed]);

  // ── Orders 2026 mapped trades (backtest data, fixed $10K sizing) ─────────
  const ordersTrades = useMemo(() => {
    if (!ordersData?.trades) return [];
    return ordersData.trades.map(t => {
      const lotsCount = t.lots?.length || 1;
      return {
        id: `orders-${t.ticker}-${t.entryDate}`,
        ticker: t.ticker,
        direction: t.signal === 'SS' ? 'SHORT' : 'LONG',
        sector: t.sector || '—',
        entryDate: t.entryDate,
        entryPrice: t.avgCost || t.entryPrice,
        exitDate: t.exitDate,
        exitPrice: t.exitPrice,
        entryRank: t.killRank || null,
        entryTier: t.apexScore >= 130 ? 'ALPHA PNTHR KILL' : t.apexScore >= 100 ? 'STRIKING' : t.apexScore >= 80 ? 'HUNTING' : t.apexScore >= 65 ? 'POUNCING' : t.apexScore >= 50 ? 'COILING' : 'STALKING',
        entryScore: t.apexScore,
        exitReason: t.exitReason || '—',
        lotsFilledCount: lotsCount,
        pnlPct: t.netProfitPct ?? t.grossProfitPct ?? 0,
        pnlDollar: t.netDollarPnl ?? t.grossDollarPnl ?? 0,
        holdingDays: t.tradingDays ?? 0,
        status: t.closed === false ? 'ACTIVE' : 'CLOSED',
      };
    });
  }, [ordersData]);

  const ordersClosed = useMemo(() => ordersTrades.filter(t => t.status === 'CLOSED'), [ordersTrades]);
  const ordersActive = useMemo(() => ordersTrades.filter(t => t.status === 'ACTIVE'), [ordersTrades]);

  const ordersStats = useMemo(() => {
    const cl = ordersClosed;
    if (cl.length === 0) return null;
    const winners = cl.filter(t => t.pnlDollar > 0);
    const losers  = cl.filter(t => t.pnlDollar <= 0);
    const grossWin  = winners.reduce((s, t) => s + t.pnlDollar, 0);
    const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnlDollar, 0));
    const totalPnl  = cl.reduce((s, t) => s + t.pnlDollar, 0);
    return {
      totalTrades: ordersTrades.length,
      closedTrades: cl.length,
      activeTrades: ordersActive.length,
      winRate: +(winners.length / cl.length * 100).toFixed(1),
      totalPnl: +totalPnl.toFixed(0),
      avgWinDollar: winners.length > 0 ? +(grossWin / winners.length).toFixed(0) : 0,
      avgLossDollar: losers.length > 0 ? +(-grossLoss / losers.length).toFixed(0) : 0,
      profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? 999 : 0),
      avgLotsPerTrade: cl.length > 0 ? +(cl.reduce((s, t) => s + t.lotsFilledCount, 0) / cl.length).toFixed(1) : 0,
    };
  }, [ordersClosed, ordersActive, ordersTrades]);

  const ordersBreakdown = useMemo(() => {
    const cl = ordersClosed;
    if (cl.length === 0) return null;
    function buildGroup(keyFn) {
      const groups = {};
      for (const t of cl) {
        const k = keyFn(t) || 'Unknown';
        if (!groups[k]) groups[k] = { count: 0, wins: 0, totalPnl: 0 };
        groups[k].count++;
        if (t.pnlDollar > 0) groups[k].wins++;
        groups[k].totalPnl += t.pnlPct;
      }
      for (const k of Object.keys(groups)) {
        groups[k].winRate = +(groups[k].wins / groups[k].count * 100).toFixed(1);
        groups[k].avgPnl  = +(groups[k].totalPnl / groups[k].count).toFixed(1);
        delete groups[k].totalPnl;
      }
      return groups;
    }
    const byMonth = {};
    for (const t of cl) {
      const month = t.exitDate?.substring(0, 7);
      if (!month) continue;
      if (!byMonth[month]) byMonth[month] = { trades: 0, totalPnl: 0, totalDollar: 0 };
      byMonth[month].trades++;
      byMonth[month].totalPnl += t.pnlPct;
      byMonth[month].totalDollar += t.pnlDollar;
    }
    const monthlyReturns = Object.entries(byMonth)
      .map(([month, d]) => ({ month, trades: d.trades, avgPnl: +(d.totalPnl / d.trades).toFixed(1), totalDollar: +d.totalDollar.toFixed(0) }))
      .sort((a, b) => a.month.localeCompare(b.month));
    return { byTier: buildGroup(t => t.entryTier), byDirection: buildGroup(t => t.direction), bySector: buildGroup(t => t.sector), monthlyReturns };
  }, [ordersClosed]);

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
            {dataSource === 'orders' ? 'PNTHR Orders — 2026' : 'PNTHR Kill History'}
          </h1>
          <p style={{ fontSize: 13, color: '#666', marginTop: 4 }}>
            {dataSource === 'orders'
              ? 'Fund Intelligence Report — 2026 pyramid backtest (5-lot pyramid, net of costs).'
              : <>Forward-tested track record — full 5-lot PNTHR Command pyramid strategy.
                  {tr.asOf && <span> Last updated: {fmtD(tr.asOf)}</span>}</>
            }
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            value={dataSource}
            onChange={e => setDataSource(e.target.value)}
            style={{
              background: '#111', border: `1px solid ${dataSource === 'orders' ? '#0096ff' : '#444'}`,
              color: dataSource === 'orders' ? '#0096ff' : YELLOW,
              borderRadius: 5, padding: '6px 10px', fontSize: 12, fontWeight: 700,
              cursor: 'pointer', outline: 'none',
            }}
          >
            <option value="kill10">PNTHR Kill 10</option>
            <option value="orders">PNTHR Orders</option>
          </select>
          {dataSource === 'kill10' && (
            <select
              value={nav}
              onChange={e => setNav(Number(e.target.value))}
              style={{
                background: '#111', border: '1px solid #444', color: YELLOW,
                borderRadius: 5, padding: '6px 10px', fontSize: 12, fontWeight: 700,
                cursor: 'pointer', outline: 'none',
              }}
            >
              {NAV_OPTIONS.map(n => (
                <option key={n} value={n}>{fmtNav(n)} NAV</option>
              ))}
            </select>
          )}
          <button
            onClick={() => { if (dataSource === 'orders') { setOrdersData(null); loadOrders(); } else load(true); }}
            disabled={refreshing || ordersLoading}
            style={{
              background: 'transparent',
              border: `1px solid ${(refreshing || ordersLoading) ? '#333' : '#555'}`,
              color: (refreshing || ordersLoading) ? '#444' : '#aaa',
              borderRadius: 5,
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 600,
              cursor: (refreshing || ordersLoading) ? 'not-allowed' : 'pointer',
              whiteSpace: 'nowrap',
              letterSpacing: '0.04em',
            }}
          >
            {(refreshing || ordersLoading) ? '↻ Refreshing…' : '↺ Refresh'}
          </button>
        </div>
      </div>

      {/* ── Metric Cards ───────────────────────────────────────────────────── */}
      {dataSource === 'orders' && ordersLoading ? (
        <div style={{ padding: 40, color: '#888', textAlign: 'center' }}>Loading Orders data...</div>
      ) : (
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 24 }}>
        {(() => {
          const stats = dataSource === 'orders' ? ordersStats : pyramidStats;
          if (stats) return (<>
            <MetricCard label="Total Trades"   value={stats.totalTrades} sub={stats.activeTrades > 0 ? `${stats.activeTrades} active` : 'all closed'} />
            <MetricCard label="Win Rate"       value={`${stats.winRate}%`}
              color={stats.winRate >= 60 ? GREEN : stats.winRate >= 40 ? '#ffa500' : RED} />
            <MetricCard label="Total P&L"      value={fmtP(stats.totalPnl)}
              sub={dataSource === 'orders' ? '$10K/position pyramid' : `at ${fmtNav(nav)} NAV`}
              color={stats.totalPnl >= 0 ? GREEN : RED} />
            <MetricCard label="Avg Win"        value={fmtP(stats.avgWinDollar)} color={GREEN} />
            <MetricCard label="Avg Loss"       value={fmtP(stats.avgLossDollar)} color={RED} />
            <MetricCard label="Profit Factor"
              value={stats.profitFactor === 999 ? '∞' : stats.profitFactor > 0 ? `${stats.profitFactor}x` : '—'}
              sub={stats.profitFactor === 999 ? 'No losses yet' : undefined}
              color={stats.profitFactor >= 2 || stats.profitFactor === 999 ? GREEN : stats.profitFactor >= 1 ? '#ffa500' : RED} />
            <MetricCard label="Avg Lots/Trade" value={stats.avgLotsPerTrade} sub="of 5 max" color={YELLOW} />
            {stats.activeTrades > 0 && <MetricCard label="Active Now" value={stats.activeTrades} color={YELLOW} />}
          </>);
          // Fallback for Kill 10 when no pyramid sim data
          return (<>
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
          </>);
        })()}
      </div>
      )}

      {/* ── Equity Curve ───────────────────────────────────────────────────── */}
      {(() => {
        const curveData = dataSource === 'orders' ? ordersClosed
          : pyramidClosed.length > 0 ? pyramidClosed : closed;
        const curveSub = dataSource === 'orders' ? '2026 Orders — $10K/position pyramid'
          : pyramidClosed.length > 0 ? `5-lot pyramid at ${fmtNav(nav)}` : 'standardized $10K / trade';
        if (curveData.length === 0) return null;
        return (
          <div style={{
            background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 8,
            padding: '16px 18px', marginBottom: 24,
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#aaa', marginBottom: 12 }}>
              Equity Curve — Cumulative P&L{' '}
              <span style={{ color: '#555', fontWeight: 400 }}>({curveSub})</span>
            </div>
            <EquityCurve closed={curveData} />
          </div>
        );
      })()}

      {/* ── Closed Trades ─────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: '#ccc', margin: '0 0 12px', letterSpacing: '0.02em' }}>
          Closed Trades <span style={{ color: '#555', fontWeight: 400, fontSize: 13 }}>
            ({dataSource === 'orders' ? ordersClosed.length : pyramidClosed.length > 0 ? pyramidClosed.length : closed.length})
          </span>
        </h2>
        {(() => {
          const rows = dataSource === 'orders'
            ? sortRows(ordersClosed, sortClosed, { lotsFilledCount: r => r.lotsFilledCount })
            : pyramidClosed.length > 0
              ? sortRows(pyramidClosed, sortClosed, { lotsFilledCount: r => r.lotsFilledCount })
              : sortedClosed;
          const usePyramid = dataSource === 'orders' || pyramidClosed.length > 0;

          if (rows.length === 0) return (
            <div style={{ textAlign: 'center', padding: '40px 0', color: '#555' }}>No closed trades yet.</div>
          );

          return (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
                    <ClosedSortTh col="ticker" align="left">Ticker</ClosedSortTh>
                    <ClosedSortTh col="direction" align="left">Dir</ClosedSortTh>
                    <ClosedSortTh col="entryDate">Entry</ClosedSortTh>
                    <ClosedSortTh col="entryPrice">Entry $</ClosedSortTh>
                    <ClosedSortTh col="entryRank">Entry Rank</ClosedSortTh>
                    {usePyramid && <ClosedSortTh col="lotsFilledCount">Lots</ClosedSortTh>}
                    <ClosedSortTh col="exitDate">Exit</ClosedSortTh>
                    <ClosedSortTh col="exitPrice">Exit $</ClosedSortTh>
                    <ClosedSortTh col="pnlPct">P&L %</ClosedSortTh>
                    <ClosedSortTh col="pnlDollar">P&L $</ClosedSortTh>
                    <ClosedSortTh col="holdingDays">{usePyramid ? 'Days' : 'Weeks'}</ClosedSortTh>
                    <th style={{ padding: '9px 10px', color: '#888', fontWeight: 600 }}>Reason</th>
                    <th style={{ padding: '9px 10px', color: '#888', fontWeight: 600 }}>Tier</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(s => {
                    const isPos = (s.pnlPct ?? 0) > 0;
                    const reason = s.exitReason || s.finalExit?.reason || '—';
                    return (
                      <tr key={s.id || `${s.ticker}-${s.entryDate}`} style={{
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
                        {usePyramid && (
                          <td style={{ textAlign: 'center', padding: '7px 10px', color: '#aaa' }}>
                            {s.lotsFilledCount}/5
                          </td>
                        )}
                        <td style={{ textAlign: 'center', padding: '7px 10px', color: '#aaa', fontSize: 11 }}>{fmtD(s.exitDate)}</td>
                        <td style={{ textAlign: 'center', padding: '7px 10px' }}>
                          ${(s.exitPrice ?? s.finalExit?.price)?.toFixed(2) ?? '—'}
                        </td>
                        <td style={{ textAlign: 'center', padding: '7px 10px', fontWeight: 700,
                          color: isPos ? GREEN : RED }}>
                          {fmt(s.pnlPct)}
                        </td>
                        <td style={{ textAlign: 'center', padding: '7px 10px', fontWeight: 700,
                          color: isPos ? GREEN : RED }}>
                          {fmtP(s.pnlDollar)}
                        </td>
                        <td style={{ textAlign: 'center', padding: '7px 10px', color: '#aaa' }}>
                          {usePyramid ? s.holdingDays : s.holdingWeeks}
                        </td>
                        <td style={{ padding: '7px 10px' }}>
                          <span style={{
                            fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 3,
                            background: reason.includes('OVEREXTENDED')
                              ? 'rgba(255,165,0,0.15)' : reason.includes('FEAST')
                              ? 'rgba(252,240,0,0.12)' : isPos ? 'rgba(40,167,69,0.15)' : 'rgba(220,53,69,0.15)',
                            color: reason.includes('OVEREXTENDED') ? '#ffa500'
                              : reason.includes('FEAST') ? YELLOW : isPos ? GREEN : RED,
                          }}>
                            {reason}
                          </span>
                        </td>
                        <td style={{ padding: '7px 10px' }}><TierBadge tier={s.entryTier} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })()}
      </div>

      {/* ── Open Trades ───────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 32 }}>
        {(() => {
          const usePyramid = dataSource === 'orders' || pyramidActive.length > 0;
          const openRows = dataSource === 'orders' ? ordersActive
            : pyramidActive.length > 0 ? pyramidActive : activeWithDerived;
          const openCount = openRows.length;

          // Date subtitle
          const asOfDate = usePyramid
            ? pyramidActive[0]?.latestDate
            : active[0]?.weeklySnapshots?.slice(-1)[0]?.date;

          return (<>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: '#ccc', margin: '0 0 4px', letterSpacing: '0.02em' }}>
              Open Trades <span style={{ color: '#555', fontWeight: 400, fontSize: 13 }}>({openCount})</span>
            </h2>
            {asOfDate && (
              <p style={{ fontSize: 11, color: '#555', margin: '0 0 12px' }}>
                P&L as of {fmtD(asOfDate)}
              </p>
            )}
            {openCount === 0 ? (
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
                      <ActiveSortTh col="entryDate">Entry</ActiveSortTh>
                      <ActiveSortTh col="entryPrice">Entry $</ActiveSortTh>
                      <ActiveSortTh col="entryRank">Entry Rank</ActiveSortTh>
                      {usePyramid && <ActiveSortTh col="lotsFilledCount">Lots</ActiveSortTh>}
                      {!usePyramid && <ActiveSortTh col="currentRank">Current Rank</ActiveSortTh>}
                      <ActiveSortTh col="pnlPct">P&L %</ActiveSortTh>
                      {usePyramid && <ActiveSortTh col="pnlDollar">P&L $</ActiveSortTh>}
                      <ActiveSortTh col={usePyramid ? 'holdingDays' : 'holdingWeeks'}>{usePyramid ? 'Days' : 'Weeks'}</ActiveSortTh>
                      {!usePyramid && <ActiveSortTh col="maxFavorable">Max Gain</ActiveSortTh>}
                      <th style={{ padding: '9px 10px', color: '#888', fontWeight: 600 }}>Tier</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortRows(openRows, sortActive, {
                      pnlPct: r => usePyramid ? r.pnlPct : r._pnlPct,
                      pnlDollar: r => r.pnlDollar ?? 0,
                      currentRank: r => r._currentRank ?? 999,
                      lotsFilledCount: r => r.lotsFilledCount ?? 0,
                    }).map(s => {
                      const pnlPct = usePyramid ? s.pnlPct : s._pnlPct;
                      const isPos  = (pnlPct ?? 0) >= 0;
                      return (
                        <tr key={s.id || `${s.ticker}-${s.entryDate}`} style={{
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
                          {usePyramid && (
                            <td style={{ textAlign: 'center', padding: '8px 10px', color: '#aaa' }}>
                              {s.lotsFilledCount}/5
                            </td>
                          )}
                          {!usePyramid && (
                            <td style={{ textAlign: 'center', padding: '8px 10px', color: '#aaa' }}>#{s._currentRank}</td>
                          )}
                          <td style={{ textAlign: 'center', padding: '8px 10px', fontWeight: 700,
                            color: pnlPct === 0 ? '#555' : isPos ? GREEN : RED }}>
                            {fmt(pnlPct)}
                          </td>
                          {usePyramid && (
                            <td style={{ textAlign: 'center', padding: '8px 10px', fontWeight: 700,
                              color: (s.pnlDollar ?? 0) >= 0 ? GREEN : RED }}>
                              {fmtP(s.pnlDollar)}
                            </td>
                          )}
                          <td style={{ textAlign: 'center', padding: '8px 10px', color: '#aaa' }}>
                            {usePyramid ? s.holdingDays : s.holdingWeeks}
                          </td>
                          {!usePyramid && (
                            <td style={{ textAlign: 'center', padding: '8px 10px', color: GREEN }}>
                              {s.maxFavorable > 0 ? fmt(s.maxFavorable) : '—'}
                            </td>
                          )}
                          <td style={{ padding: '8px 10px' }}><TierBadge tier={s.entryTier} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>);
        })()}
      </div>

      {/* ── Breakdown ─────────────────────────────────────────────────────── */}
      {(dataSource === 'orders' ? ordersClosed.length > 0 : pyramidClosed.length > 0 || closed.length > 0) && (
        <div style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: '#ccc', margin: '0 0 12px', letterSpacing: '0.02em' }}>
            Breakdown
          </h2>
          {(() => {
            const bd = dataSource === 'orders' ? ordersBreakdown : (pyramidBreakdown || {});
            const usePyramid = dataSource === 'orders' || !!pyramidBreakdown;
            const byTier      = usePyramid ? bd?.byTier      : tr.byTier;
            const byDirection  = usePyramid ? bd?.byDirection  : tr.byDirection;
            const bySector     = usePyramid ? bd?.bySector     : tr.bySector;
            const monthly      = usePyramid ? bd?.monthlyReturns : tr.monthlyReturns;
            return (<>
              <BreakdownTable title="By Tier"      data={byTier}      defaultOpen={true} />
              <BreakdownTable title="By Direction"  data={byDirection} />
              <BreakdownTable title="By Sector"     data={bySector} />
              {!usePyramid && <BreakdownTable title="By Entry Source (Friday vs Mid-Week)" data={tr.bySource} />}

              {monthly?.length > 0 && (
                <div style={{
                  background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 8,
                  padding: '14px 16px', marginTop: 12,
                }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#aaa', marginBottom: 10 }}>
                    Monthly Returns {usePyramid && <span style={{ color: '#555', fontWeight: 400 }}>({fmtNav(nav)} pyramid)</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {monthly.map(m => (
                      <div key={m.month} style={{
                        background: 'rgba(255,255,255,0.04)', border: `1px solid ${BORDER}`,
                        borderRadius: 6, padding: '8px 12px', minWidth: 90, textAlign: 'center',
                      }}>
                        <div style={{ fontSize: 10, color: '#555', marginBottom: 3 }}>{m.month}</div>
                        <div style={{ fontSize: 16, fontWeight: 800, color: m.avgPnl >= 0 ? GREEN : RED }}>
                          {fmt(m.avgPnl)}
                        </div>
                        <div style={{ fontSize: 10, color: '#555' }}>{m.trades} trade{m.trades !== 1 ? 's' : ''}</div>
                        {usePyramid && m.totalDollar != null && (
                          <div style={{ fontSize: 10, color: m.totalDollar >= 0 ? GREEN : RED, marginTop: 2 }}>
                            {fmtP(m.totalDollar)}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>);
          })()}
        </div>
      )}

    </div>
  );
}
