// client/src/components/HistoryPage.jsx
// ── PNTHR Kill History — Track Record System ──────────────────────────────────
//
// Displays the forward-tested track record of every stock that entered the
// Kill top 10. Pulls from four endpoints:
//   GET /api/kill-history/track-record  — aggregate stats
//   GET /api/kill-history/active        — live open trades
//   GET /api/kill-history              — all trades (for closed table + equity curve)
//   GET /api/kill-history/simulation   — pyramid simulation results (NAV-independent)

import { useState, useEffect, useMemo, useCallback } from 'react';
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
  'ALPHA AI KILL':    { bg: 'rgba(252,240,0,0.15)', color: YELLOW },
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

function MetricCard({ label, value, sub, color, info }) {
  const [showInfo, setShowInfo] = useState(false);
  return (
    <div style={{
      background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 8,
      padding: '14px 18px', minWidth: 110, flex: '1 1 100px', position: 'relative',
    }}>
      <div style={{ fontSize: 11, color: '#888', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: 5 }}>
        {label}
        {info && (
          <span
            onClick={(e) => { e.stopPropagation(); setShowInfo(v => !v); }}
            style={{ cursor: 'pointer', fontSize: 12, color: 'rgba(255,255,255,0.3)', lineHeight: 1, transition: 'color 0.15s' }}
            onMouseEnter={e => e.target.style.color = YELLOW}
            onMouseLeave={e => e.target.style.color = 'rgba(255,255,255,0.3)'}
          >ⓘ</span>
        )}
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: color || '#fff', lineHeight: 1.1 }}>{value ?? '—'}</div>
      {sub && <div style={{ fontSize: 11, color: '#666', marginTop: 3 }}>{sub}</div>}
      {showInfo && (
        <div
          onClick={() => setShowInfo(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 10000,
            background: 'rgba(0,0,0,0.7)', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div onClick={e => e.stopPropagation()} style={{
            background: '#1a1a1a', border: `1px solid ${YELLOW}`, borderRadius: 10,
            padding: '20px 24px', maxWidth: 400, width: '90vw', position: 'relative',
            boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
          }}>
            <button onClick={() => setShowInfo(false)} style={{
              position: 'absolute', top: 8, right: 12, background: 'none',
              border: 'none', color: 'rgba(255,255,255,0.5)', fontSize: 16, cursor: 'pointer',
            }}>✕</button>
            <div style={{ fontSize: 14, fontWeight: 700, color: YELLOW, marginBottom: 8 }}>{label}</div>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.8)', lineHeight: 1.6 }}>{info}</div>
          </div>
        </div>
      )}
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
                    color: v.winRate > 0 ? GREEN : RED,
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
  const [tab,         setTab]         = useState('active');
  const [fund,        setFund]        = useState('679'); // '679' | 'ai300'
  const [dataSource,  setDataSource]  = useState('kill10'); // 'kill10' | 'orders'
  const [ordersData,  setOrdersData]  = useState(null);
  const [ordersLoading, setOrdersLoading] = useState(false);

  const [refreshing, setRefreshing] = useState(false);
  const [analyticsMonthly,  setAnalyticsMonthly]  = useState([]);
  const [analyticsMetrics,  setAnalyticsMetrics]  = useState(null);
  const [analyticsLoading,  setAnalyticsLoading]  = useState(false);
  const [analyticsGenerating, setAnalyticsGenerating] = useState(false);
  const [showAnalytics, setShowAnalytics] = useState(false);

  const isAi300 = fund === 'ai300';
  const historyBase = isAi300 ? 'ai300-kill-history' : 'kill-history';
  const analyticsMonthlyUrl = isAi300 ? 'ai300-kill-test/monthly' : 'kill-test/monthly';
  const analyticsMetricsUrl = isAi300 ? 'ai300-kill-test/metrics' : 'kill-test/metrics';
  const analyticsGenerateUrl = isAi300 ? 'ai300-kill-test/monthly/generate' : 'kill-test/monthly/generate';

  async function load(isManual = false) {
    try {
      if (isManual) setRefreshing(true); else setLoading(true);
      setError(null);
      const [trRes, acRes, allRes, simRes] = await Promise.all([
        fetch(`${API_BASE}/api/${historyBase}/track-record`, { headers: authHeaders() }),
        fetch(`${API_BASE}/api/${historyBase}/active`,       { headers: authHeaders() }),
        fetch(`${API_BASE}/api/${historyBase}`,              { headers: authHeaders() }),
        fetch(`${API_BASE}/api/${historyBase}/simulation`,   { headers: authHeaders() }),
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

  useEffect(() => { load(); }, [fund]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch Orders 2026 backtest data on demand
  async function loadOrders() {
    if (ordersData) return; // Already loaded
    try {
      setOrdersLoading(true);
      // Explicit tier=wagyu — HistoryPage mirrors Wagyu-tier numbers (flagship NAV reporting basis).
      const res = await fetch(`${API_BASE}/api/journal/backtest/2026?tier=wagyu`, { headers: authHeaders() });
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

  // Lazy-load analytics when section is opened or fund changes
  useEffect(() => {
    if (!showAnalytics) return;
    setAnalyticsMonthly([]);
    setAnalyticsMetrics(null);
    async function fetchAnalytics() {
      try {
        setAnalyticsLoading(true);
        const [mRes, meRes] = await Promise.all([
          fetch(`${API_BASE}/api/${analyticsMonthlyUrl}?scenarioKey=all`, { headers: authHeaders() }),
          fetch(`${API_BASE}/api/${analyticsMetricsUrl}?scenarioKey=all`, { headers: authHeaders() }),
        ]);
        if (mRes.ok) setAnalyticsMonthly(await mRes.json());
        if (meRes.ok) setAnalyticsMetrics(await meRes.json());
      } catch { /* non-fatal */ }
      finally { setAnalyticsLoading(false); }
    }
    fetchAnalytics();
  }, [showAnalytics, fund]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleGenerateAnalytics() {
    setAnalyticsGenerating(true);
    try {
      const res = await fetch(`${API_BASE}/api/${analyticsGenerateUrl}`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (res.ok) {
        const { monthly: m, metrics: me } = await res.json();
        if (m) setAnalyticsMonthly(m);
        if (me) setAnalyticsMetrics(me);
      }
    } catch { /* non-fatal */ }
    finally { setAnalyticsGenerating(false); }
  }

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

      let pnlDollar = 0;
      let exitPrice = null;
      let exitDate  = null;
      let exitReason = null;

      if (t.status === 'CLOSED' && t.finalExit) {
        exitPrice  = t.finalExit.price;
        exitDate   = t.finalExit.date;
        exitReason = t.finalExit.reason;
        const avgCost = totalShr > 0 ? totalCost / totalShr : t.entryPrice;
        pnlDollar = isLong
          ? (t.finalExit.price - avgCost) * totalShr
          : (avgCost - t.finalExit.price) * totalShr;
      } else {
        // Active — use latest price for unrealized P&L
        const avgCost = totalShr > 0 ? totalCost / totalShr : t.entryPrice;
        const curPrice = t.latestPrice;
        pnlDollar = isLong
          ? (curPrice - avgCost) * totalShr
          : (avgCost - curPrice) * totalShr;
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
    const avgWin = winners.length > 0 ? +(grossWin / winners.length).toFixed(0) : 0;
    const avgLoss = losers.length > 0 ? +(grossLoss / losers.length).toFixed(0) : 0;
    const winLossRatio = avgLoss > 0 ? +(avgWin / avgLoss).toFixed(1) : (avgWin > 0 ? 999 : 0);
    const winRateFrac = winners.length / cl.length;
    const expectancy = +((winRateFrac * avgWin) - ((1 - winRateFrac) * avgLoss)).toFixed(0);

    return {
      totalTrades: pyramidTrades.length,
      closedTrades: cl.length,
      activeTrades: pyramidActive.length,
      winRate: +(winners.length / cl.length * 100).toFixed(1),
      totalPnl: +totalPnl.toFixed(0),
      avgWinDollar: avgWin,
      avgLossDollar: losers.length > 0 ? +(-grossLoss / losers.length).toFixed(0) : 0,
      profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? 999 : 0),
      winLossRatio,
      expectancy,
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
      winLossRatio: (() => {
        const aw = winners.length > 0 ? grossWin / winners.length : 0;
        const al = losers.length > 0 ? grossLoss / losers.length : 0;
        return al > 0 ? +(aw / al).toFixed(1) : (aw > 0 ? 999 : 0);
      })(),
      expectancy: (() => {
        const aw = winners.length > 0 ? grossWin / winners.length : 0;
        const al = losers.length > 0 ? grossLoss / losers.length : 0;
        const wr = winners.length / cl.length;
        return +((wr * aw) - ((1 - wr) * al)).toFixed(0);
      })(),
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
    <div style={{ padding: '28px 32px', maxWidth: 1440, margin: '0 auto', fontFamily: 'system-ui, sans-serif', color: '#ddd', background: '#0a0a0a', minHeight: '100vh', boxSizing: 'border-box' }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20, gap: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 4 }}>
            <h1 style={{ fontSize: 26, fontWeight: 900, color: isAi300 ? '#0096ff' : YELLOW, margin: 0, letterSpacing: '0.03em' }}>
              {dataSource === 'orders' ? 'PNTHR Orders — 2026' : isAi300 ? 'PNTHR AI 300 Kill 10 History' : 'PNTHR Kill 10'}
            </h1>
          </div>
          <p style={{ fontSize: 12, color: '#666', margin: '2px 0 0', maxWidth: 640, lineHeight: 1.5 }}>
            {dataSource === 'orders'
              ? 'Fund Intelligence Report — 2026 pyramid backtest (5-lot pyramid, net of costs).'
              : <>Forward-tested track record — full 5-lot {isAi300 ? 'AI 300' : 'PNTHR Command'} pyramid strategy.
                  {tr.asOf && <span> Last updated: {fmtD(tr.asOf)}</span>}</>
            }
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* Fund toggle pill */}
          <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #444' }}>
            {[{ key: '679', label: '679' }, { key: 'ai300', label: 'AI 300' }].map(f => (
              <button
                key={f.key}
                onClick={() => setFund(f.key)}
                style={{
                  padding: '5px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                  border: 'none', letterSpacing: '0.04em',
                  background: fund === f.key ? (f.key === 'ai300' ? '#0096ff' : YELLOW) : '#111',
                  color: fund === f.key ? '#000' : '#888',
                  transition: 'all 0.15s',
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
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
            <MetricCard label="Total Trades" value={stats.totalTrades} sub={stats.activeTrades > 0 ? `${stats.activeTrades} active` : 'all closed'}
              info="Total number of stocks that have entered the Kill 10 tracking system, including both closed and currently active trades. Each trade simulates the full PNTHR 5-lot pyramid strategy (35/25/20/12/8% allocation) scaled to your selected NAV." />
            <MetricCard label="Win Rate" value={`${stats.winRate}%`}
              color={stats.winRate >= 60 ? GREEN : stats.winRate >= 40 ? YELLOW : '#fff'}
              sub={`${stats.closedTrades} closed`}
              info="Percentage of closed trades that finished with a profit. In trend-following, win rates of 30–45% are normal and healthy — the strategy profits by making winners much larger than losers, not by winning often. Don't judge this number in isolation; pair it with Win/Loss Ratio and Profit Factor to see the full picture." />
            <MetricCard label="Win/Loss Ratio"
              value={stats.winLossRatio === 999 ? '∞' : stats.winLossRatio > 0 ? `${stats.winLossRatio}x` : '—'}
              sub="avg win ÷ avg loss"
              color={stats.winLossRatio >= 3 ? GREEN : stats.winLossRatio >= 1.5 ? YELLOW : '#fff'}
              info="How much bigger the average winning trade is compared to the average losing trade. A 3x ratio means winners are 3 times the size of losers. This is the core advantage of the PNTHR pyramid — losers get stopped early (small loss), while winners keep adding lots and running (large gain). Above 2x is strong; above 3x is excellent for trend-following." />
            <MetricCard label="Expectancy"
              value={stats.expectancy != null ? `${stats.expectancy >= 0 ? '+' : ''}$${Math.abs(stats.expectancy).toLocaleString()}` : '—'}
              sub="avg $/trade"
              color={stats.expectancy > 0 ? GREEN : stats.expectancy < 0 ? RED : '#fff'}
              info="The average dollar amount you can expect to make per trade over time. Formula: (win rate × avg win) − (loss rate × avg loss). Positive expectancy means the strategy has a mathematical edge. Even with a low win rate, if your winners are large enough relative to your losers, every trade you take has a positive expected value. This is the single most important number for evaluating any trading system." />
            <MetricCard label="Total P&L" value={fmtP(stats.totalPnl)}
              sub={dataSource === 'orders' ? '$10K/position pyramid' : `at ${fmtNav(nav)} NAV`}
              color={stats.totalPnl >= 0 ? GREEN : RED}
              info="Cumulative dollar profit or loss across all closed trades, scaled to your selected NAV using the full 5-lot pyramid sizing. This number changes as you adjust the NAV selector — a $1M NAV will show proportionally larger P&L than $100K because position sizes scale with account size." />
            <MetricCard label="Profit Factor"
              value={stats.profitFactor === 999 ? '∞' : stats.profitFactor > 0 ? `${stats.profitFactor}x` : '—'}
              sub={stats.profitFactor === 999 ? 'No losses yet' : undefined}
              color={stats.profitFactor >= 2 || stats.profitFactor === 999 ? GREEN : stats.profitFactor >= 1 ? '#ffa500' : RED}
              info="Total gross profits divided by total gross losses. A profit factor above 1.0 means the strategy is profitable overall. Above 1.5 is good, above 2.0 is strong, and above 3.0 is exceptional. Unlike win rate, profit factor captures both the frequency AND the magnitude of wins vs losses — it's the complete picture in one number." />
            <MetricCard label="Avg Win" value={fmtP(stats.avgWinDollar)} color={GREEN}
              info="Average dollar profit on winning trades. In the PNTHR pyramid strategy, winning trades tend to be large because they accumulate multiple lots (up to 5) as the stock moves in your favor. The pyramid adds size into strength, so a winner that fills all 5 lots generates a much larger gain than a single-lot trade." />
            <MetricCard label="Avg Loss" value={fmtP(stats.avgLossDollar)} color={RED}
              info="Average dollar loss on losing trades. Losses should be relatively small and consistent because the stop loss caps downside on every trade. Most losers only fill Lot 1 (35% of max position) before getting stopped out, which limits the damage. Compare this to Avg Win — the bigger the gap, the stronger the strategy's edge." />
            {stats.activeTrades > 0 && <MetricCard label="Active Now" value={stats.activeTrades} color={YELLOW}
              info="Number of trades currently open and being tracked by the Kill 10 simulation. These positions entered the top 10 Kill rankings, triggered a pyramid entry, and have not yet hit their stop or exit condition. Active trades have unrealized P&L that is not included in the closed-trade statistics above." />}
          </>);
          // Fallback for Kill 10 when no pyramid sim data
          return (<>
            <MetricCard label="Total Trades" value={tr.totalTrades ?? 0} sub={`${tr.activeTrades ?? 0} active`}
              info="Total number of stocks tracked by the Kill 10 system, including both closed and currently active trades." />
            <MetricCard label="Win Rate" value={tr.closedTrades > 0 ? `${tr.winRate}%` : '—'}
              color={tr.winRate >= 60 ? GREEN : tr.winRate >= 40 ? '#ffa500' : RED}
              info="Percentage of closed trades that finished with a profit. In trend-following, win rates of 30–45% are normal — the strategy profits by making winners much larger than losers." />
            <MetricCard label="Avg Win" value={tr.avgWinPct != null ? fmt(tr.avgWinPct) : '—'} color={GREEN}
              info="Average percentage gain on winning trades. Compare this to Avg Loss — the bigger the gap, the stronger the strategy's edge." />
            <MetricCard label="Avg Loss" value={tr.avgLossPct != null ? fmt(tr.avgLossPct) : '—'} color={RED}
              info="Average percentage loss on losing trades. Losses should be small and consistent because the stop loss caps downside." />
            <MetricCard label="Profit Factor"
              value={tr.profitFactor === 999 ? '∞' : tr.profitFactor > 0 ? `${tr.profitFactor}x` : '—'}
              sub={tr.profitFactor === 999 ? 'No losses yet' : undefined}
              color={tr.profitFactor >= 2 || tr.profitFactor === 999 ? GREEN : tr.profitFactor >= 1 ? '#ffa500' : RED}
              info="Total gross profits divided by total gross losses. Above 1.0 means profitable. Above 2.0 is strong. Above 3.0 is exceptional." />
            <MetricCard label="Active Now" value={tr.activeTrades ?? 0} color={YELLOW}
              info="Number of trades currently open. These have unrealized P&L not reflected in the closed-trade statistics." />
            <MetricCard label="Avg Hold" value={tr.avgHoldingWeeks > 0 ? `${tr.avgHoldingWeeks}w` : '—'}
              info="Average number of weeks trades were held before closing. Longer holds in a trend-following system generally mean the stock trended well before eventually hitting a stop." />
          </>);
        })()}
      </div>
      )}

      {/* ── Tab bar (mirrors Kill Test layout) ──────────────────────────── */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${BORDER}`, marginBottom: 0 }}>
        {[
          { key: 'active',    label: () => `Active (${(() => { const usePyramid = dataSource === 'orders' || pyramidActive.length > 0; return (dataSource === 'orders' ? ordersActive : usePyramid ? pyramidActive : activeWithDerived).length; })()})` },
          { key: 'closed',    label: () => `Closed (${dataSource === 'orders' ? ordersClosed.length : pyramidClosed.length > 0 ? pyramidClosed.length : closed.length})` },
          { key: 'equity',    label: () => 'Equity & Breakdown' },
          { key: 'analytics', label: () => 'Portfolio Analytics' },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); if (t.key === 'analytics' && !showAnalytics) setShowAnalytics(true); }}
            style={{
              padding: '9px 22px', cursor: 'pointer', border: 'none', fontSize: 13,
              fontWeight: 700, borderRadius: '6px 6px 0 0', fontFamily: 'inherit',
              background: tab === t.key ? (isAi300 ? 'rgba(0,150,255,0.07)' : 'rgba(252,240,0,0.07)') : 'transparent',
              color: tab === t.key ? (isAi300 ? '#0096ff' : YELLOW) : '#888',
              borderBottom: tab === t.key ? `2px solid ${isAi300 ? '#0096ff' : YELLOW}` : '2px solid transparent',
            }}
          >
            {t.label()}
          </button>
        ))}
      </div>

      {/* ── Tab content area ───────────────────────────────────────────────── */}
      <div style={{
        background: CARD_BG, border: `1px solid ${BORDER}`, borderTop: 'none',
        borderRadius: '0 0 10px 10px', padding: tab === 'analytics' ? '24px 20px' : '4px 0',
      }}>

        {/* ── Active tab ───────────────────────────────────────────────── */}
        {tab === 'active' && (() => {
          const usePyramid = dataSource === 'orders' || pyramidActive.length > 0;
          const openRows = dataSource === 'orders' ? ordersActive
            : pyramidActive.length > 0 ? pyramidActive : activeWithDerived;
          const openCount = openRows.length;
          const asOfDate = usePyramid
            ? pyramidActive[0]?.latestDate
            : active[0]?.weeklySnapshots?.slice(-1)[0]?.date;

          if (openCount === 0) return (
            <div style={{ textAlign: 'center', padding: '48px 0', color: '#555', fontSize: 13 }}>
              No active case studies. They appear when a stock enters the Kill top 10.
            </div>
          );

          return (
            <div>
              {asOfDate && (
                <div style={{ padding: '10px 16px 0', fontSize: 11, color: '#555' }}>
                  P&L as of {fmtD(asOfDate)}
                </div>
              )}
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
            </div>
          );
        })()}

        {/* ── Closed tab ──────────────────────────────────────────────── */}
        {tab === 'closed' && (() => {
          const rows = dataSource === 'orders'
            ? sortRows(ordersClosed, sortClosed, { lotsFilledCount: r => r.lotsFilledCount })
            : pyramidClosed.length > 0
              ? sortRows(pyramidClosed, sortClosed, { lotsFilledCount: r => r.lotsFilledCount })
              : sortedClosed;
          const usePyramid = dataSource === 'orders' || pyramidClosed.length > 0;

          if (rows.length === 0) return (
            <div style={{ textAlign: 'center', padding: '48px 0', color: '#555', fontSize: 13 }}>No closed trades yet.</div>
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
                              ? 'rgba(255,165,0,0.15)' : isPos ? 'rgba(40,167,69,0.15)' : 'rgba(220,53,69,0.15)',
                            color: reason.includes('OVEREXTENDED') ? '#ffa500'
                              : isPos ? GREEN : RED,
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

        {/* ── Equity & Breakdown tab ──────────────────────────────────── */}
        {tab === 'equity' && (
          <div style={{ padding: '16px 18px' }}>
            {/* Equity Curve */}
            {(() => {
              const curveData = dataSource === 'orders' ? ordersClosed
                : pyramidClosed.length > 0 ? pyramidClosed : closed;
              const curveSub = dataSource === 'orders' ? '2026 Orders — $10K/position pyramid'
                : pyramidClosed.length > 0 ? `5-lot pyramid at ${fmtNav(nav)}` : 'standardized $10K / trade';
              if (curveData.length === 0) return (
                <div style={{ textAlign: 'center', padding: '32px 0', color: '#555', fontSize: 13 }}>No closed trades yet — equity curve will appear after the first exit.</div>
              );
              return (
                <div style={{ background: '#111', border: `1px solid ${BORDER}`, borderRadius: 10, padding: '16px 20px', marginBottom: 20 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#aaa', marginBottom: 12 }}>
                    Equity Curve — Cumulative P&L{' '}
                    <span style={{ color: '#555', fontWeight: 400 }}>({curveSub})</span>
                  </div>
                  <EquityCurve closed={curveData} />
                </div>
              );
            })()}

            {/* Breakdown */}
            {(dataSource === 'orders' ? ordersClosed.length > 0 : pyramidClosed.length > 0 || closed.length > 0) && (() => {
              const bd = dataSource === 'orders' ? ordersBreakdown : (pyramidBreakdown || {});
              const usePyramid = dataSource === 'orders' || !!pyramidBreakdown;
              const byTier      = usePyramid ? bd?.byTier      : tr.byTier;
              const byDirection  = usePyramid ? bd?.byDirection  : tr.byDirection;
              const bySector     = usePyramid ? bd?.bySector     : tr.bySector;
              const monthly      = usePyramid ? bd?.monthlyReturns : tr.monthlyReturns;
              return (
                <div>
                  <BreakdownTable title="By Tier"      data={byTier}      defaultOpen={true} />
                  <BreakdownTable title="By Direction"  data={byDirection} />
                  <BreakdownTable title="By Sector"     data={bySector} />
                  {!usePyramid && <BreakdownTable title="By Entry Source (Friday vs Mid-Week)" data={tr.bySource} />}

                  {monthly?.length > 0 && (
                    <div style={{
                      background: 'rgba(255,255,255,0.04)', border: `1px solid ${BORDER}`, borderRadius: 8,
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
                </div>
              );
            })()}
          </div>
        )}

        {/* ── Portfolio Analytics tab ─────────────────────────────────── */}
        {tab === 'analytics' && (() => {
          if (analyticsLoading) return (
            <div style={{ padding: 48, textAlign: 'center', color: '#888', fontSize: 13 }}>Loading analytics…</div>
          );

          const m = analyticsMetrics;
          const hasData = m?.status === 'OK' && m.monthsAvailable >= 2;
          const n = m?.monthsAvailable ?? 0;
          const retColor = (v) => v == null ? '#fff' : v > 0 ? GREEN : v < 0 ? RED : '#fff';
          const ratioColor = (v) => v == null ? '#fff' : v >= 2 ? GREEN : v >= 1 ? '#4fc870' : v >= 0 ? '#ffa500' : RED;
          const ddColor = (v) => v == null ? '#fff' : v < -15 ? RED : v < -5 ? '#ffa500' : v < 0 ? '#ffcc44' : GREEN;

          if (!hasData) return (
            <div>
              <div style={{ background: '#1a1100', border: `1px solid rgba(252,240,0,0.2)`, borderRadius: 8, padding: '16px 20px', marginBottom: 16 }}>
                <div style={{ color: YELLOW, fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
                  {n === 0 ? 'No monthly data yet' : `${n} month of data — need at least 2 for metrics`}
                </div>
                <div style={{ color: '#888', fontSize: 12, lineHeight: 1.6 }}>
                  Generate the first monthly snapshot to start tracking Sharpe, Sortino, Calmar, and drawdown metrics.
                </div>
              </div>
              <button onClick={handleGenerateAnalytics} disabled={analyticsGenerating}
                style={{ background: YELLOW, color: '#000', fontWeight: 800, fontSize: 12, border: 'none', borderRadius: 6, padding: '10px 24px', cursor: analyticsGenerating ? 'default' : 'pointer', letterSpacing: '0.05em' }}>
                {analyticsGenerating ? 'Generating…' : '⚡ GENERATE SNAPSHOT NOW'}
              </button>
            </div>
          );

          const ec = m.equityCurve ?? [];

          return (
            <div>
              {/* Equity curve */}
              <div style={{ background: '#111', border: `1px solid ${BORDER}`, borderRadius: 10, padding: '16px 20px', marginBottom: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
                  <div>
                    <span style={{ color: isAi300 ? '#0096ff' : YELLOW, fontWeight: 800, fontSize: 14, letterSpacing: '0.03em' }}>PORTFOLIO EQUITY CURVE</span>
                    <span style={{ color: '#888', fontSize: 11, marginLeft: 10 }}>{n} months</span>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 18, fontWeight: 800, color: retColor(m.totalReturnPct) }}>
                      {m.totalReturnPct != null ? `${m.totalReturnPct >= 0 ? '+' : ''}${m.totalReturnPct.toFixed(2)}%` : '—'}
                    </div>
                    <div style={{ fontSize: 11, color: '#888' }}>cumulative return</div>
                  </div>
                </div>
                {ec.length > 1 && (() => {
                  const W = 700, H = 160, PAD = { t: 12, r: 12, b: 28, l: 52 };
                  const iW = W - PAD.l - PAD.r, iH = H - PAD.t - PAD.b;
                  const vals = ec.map(p => p.value);
                  const dds  = ec.map(p => p.drawdown);
                  const minV = Math.min(...vals), maxV = Math.max(...vals);
                  const range = maxV - minV || 1;
                  const px = (i) => PAD.l + (i / (vals.length - 1 || 1)) * iW;
                  const py = (v) => PAD.t + (1 - (v - minV) / range) * iH;
                  const linePath = vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
                  const peakY = py(maxV);
                  const ddPath = vals.map((v, i) => {
                    const isDD = dds[i] < 0;
                    return `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${isDD ? py(v).toFixed(1) : peakY.toFixed(1)}`;
                  }).join(' ') + ` L${px(vals.length - 1).toFixed(1)},${peakY.toFixed(1)} Z`;
                  const yTicks = [minV, (minV + maxV) / 2, maxV].map(v => ({
                    y: py(v), label: v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${(v / 1000).toFixed(0)}k`,
                  }));
                  const step = Math.ceil(ec.length / 8);
                  const xTicks = ec.filter((_, i) => i % step === 0 || i === ec.length - 1);
                  return (
                    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
                      <path d={ddPath} fill="rgba(220,53,69,0.15)" />
                      {yTicks.map((t, i) => (
                        <g key={i}>
                          <line x1={PAD.l} y1={t.y} x2={W - PAD.r} y2={t.y} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
                          <text x={PAD.l - 4} y={t.y + 4} textAnchor="end" fill="#555" fontSize={10}>{t.label}</text>
                        </g>
                      ))}
                      <line x1={PAD.l} y1={peakY} x2={W - PAD.r} y2={peakY} stroke="rgba(255,255,255,0.15)" strokeWidth={1} strokeDasharray="4,3" />
                      <path d={linePath} fill="none" stroke={isAi300 ? '#0096ff' : YELLOW} strokeWidth={2} />
                      {xTicks.map((p, i) => (
                        <text key={i} x={px(ec.indexOf(p))} y={H - 6} textAnchor="middle" fill="#555" fontSize={9}>{p.month}</text>
                      ))}
                    </svg>
                  );
                })()}
              </div>

              {/* Top metric cards */}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
                <MetricCard label="Sharpe Ratio" value={m.sharpe != null ? m.sharpe.toFixed(2) : '—'}
                  sub={m.sharpe6M != null ? `6M: ${m.sharpe6M.toFixed(2)}` : n < 6 ? `(need 6M, have ${n})` : '—'}
                  color={ratioColor(m.sharpe)}
                  info="Annualized excess return above risk-free rate divided by return volatility. Measures return per unit of total risk. Above 1.0 is good, above 2.0 is excellent." />
                <MetricCard label="Sortino Ratio" value={m.sortino != null ? m.sortino.toFixed(2) : '—'}
                  sub={m.sortino6M != null ? `6M: ${m.sortino6M.toFixed(2)}` : n < 6 ? `(need 6M, have ${n})` : '—'}
                  color={ratioColor(m.sortino)}
                  info="Like Sharpe but only penalizes downside volatility — ignores upside swings. Better for trend-following strategies that have large positive outliers." />
                <MetricCard label="Calmar Ratio" value={m.calmarAnnual != null ? m.calmarAnnual.toFixed(2) : '—'}
                  sub={m.calmar6M != null ? `6M: ${m.calmar6M.toFixed(2)}` : '—'}
                  color={ratioColor(m.calmarAnnual)}
                  info="Annualized return divided by maximum drawdown. Measures how much return you get per unit of worst-case pain. Above 1.0 is good." />
                <MetricCard label="Annualized Return" value={m.annualizedReturn != null ? `${m.annualizedReturn >= 0 ? '+' : ''}${m.annualizedReturn.toFixed(2)}%` : '—'}
                  sub={m.return6M != null ? `6M: ${m.return6M >= 0 ? '+' : ''}${m.return6M.toFixed(2)}%` : '—'}
                  color={retColor(m.annualizedReturn)}
                  info="Compound annual growth rate from inception." />
                <MetricCard label="Current Drawdown" value={m.currentDrawdown != null ? `${m.currentDrawdown.toFixed(2)}%` : '—'}
                  sub={m.currentDrawdown === 0 ? 'At all-time high' : 'Below ATH'}
                  color={ddColor(m.currentDrawdown)}
                  info="How far below the all-time portfolio high you are right now. 0% means at peak." />
                <MetricCard label="Pain Index" value={m.painIndex != null ? `${m.painIndex.toFixed(2)}%` : '—'}
                  sub="avg abs drawdown" color={m.painIndex > 10 ? RED : m.painIndex > 5 ? '#ffa500' : GREEN}
                  info="Average of absolute drawdown values across all months. Lower is better." />
              </div>

              {/* Two-column: Drawdown + Rolling */}
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
                <div style={{ flex: '1 1 280px', background: 'rgba(255,255,255,0.04)', border: `1px solid ${BORDER}`, borderRadius: 8, padding: '16px 20px' }}>
                  <div style={{ fontSize: 11, color: isAi300 ? '#0096ff' : YELLOW, fontWeight: 700, marginBottom: 14, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Drawdown Analysis</div>
                  {[
                    { label: 'Max Monthly Drawdown', val: m.maxMonthlyDrawdown },
                    { label: 'Average Drawdown', val: m.avgDrawdown },
                    { label: 'Current Drawdown', val: m.currentDrawdown },
                    { label: 'CDaR 95%', val: m.cdar95 },
                  ].map(({ label, val }) => (
                    <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid rgba(255,255,255,0.08)` }}>
                      <span style={{ fontSize: 13, color: '#ddd' }}>{label}</span>
                      <span style={{ fontSize: 14, fontWeight: 700, color: val == null ? '#888' : val < -10 ? RED : val < -5 ? '#ffa500' : val < 0 ? '#ffcc44' : GREEN }}>
                        {val != null ? `${val.toFixed(2)}%` : '—'}
                      </span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid rgba(255,255,255,0.08)` }}>
                    <span style={{ fontSize: 13, color: '#ddd' }}>Drawdown Frequency</span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: m.drawdownFrequency > 50 ? '#ffa500' : '#aaa' }}>
                      {m.drawdownFrequency != null ? `${m.drawdownFrequency.toFixed(0)}%` : '—'} <span style={{ fontSize: 11, color: '#888' }}>of months</span>
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
                    <span style={{ fontSize: 13, color: '#ddd' }}>Avg DD Duration</span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: m.avgDrawdownDurationMonths > 3 ? '#ffa500' : '#aaa' }}>
                      {m.avgDrawdownDurationMonths != null ? `${m.avgDrawdownDurationMonths} mo` : '—'}
                    </span>
                  </div>
                </div>
                <div style={{ flex: '1 1 280px', background: 'rgba(255,255,255,0.04)', border: `1px solid ${BORDER}`, borderRadius: 8, padding: '16px 20px' }}>
                  <div style={{ fontSize: 11, color: isAi300 ? '#0096ff' : YELLOW, fontWeight: 700, marginBottom: 14, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Rolling Drawdowns</div>
                  {[
                    { label: '1-Month',  val: m.rolling1M,  min: 1 },
                    { label: '3-Month',  val: m.rolling3M,  min: 3 },
                    { label: '6-Month',  val: m.rolling6M,  min: 6 },
                    { label: '12-Month', val: m.rolling12M, min: 12 },
                  ].map(({ label, val, min }) => (
                    <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: `1px solid rgba(255,255,255,0.08)` }}>
                      <span style={{ fontSize: 13, color: '#ddd' }}>{label}</span>
                      {n < min
                        ? <span style={{ fontSize: 11, color: '#555' }}>need {min}M data</span>
                        : <span style={{ fontSize: 14, fontWeight: 700, color: ddColor(val) }}>{val != null ? `${val.toFixed(2)}%` : '—'}</span>
                      }
                    </div>
                  ))}
                </div>
              </div>

              {/* Peak-to-Valley */}
              {m.peakToValley && (
                <div style={{ background: 'rgba(255,255,255,0.04)', border: `1px solid rgba(220,53,69,0.2)`, borderRadius: 8, padding: '16px 20px', marginBottom: 20 }}>
                  <div style={{ fontSize: 11, color: RED, fontWeight: 700, marginBottom: 10, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Worst Drawdown — Peak to Valley Attribution</div>
                  <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 12 }}>
                    <div><div style={{ fontSize: 10, color: '#888' }}>Peak Month</div><div style={{ fontWeight: 700, color: '#ddd' }}>{m.peakToValley.peakMonth}</div></div>
                    <div><div style={{ fontSize: 10, color: '#888' }}>Trough Month</div><div style={{ fontWeight: 700, color: '#ddd' }}>{m.peakToValley.troughMonth}</div></div>
                    <div><div style={{ fontSize: 10, color: '#888' }}>Peak Value</div><div style={{ fontWeight: 700, color: '#ddd' }}>${m.peakToValley.peakValue?.toLocaleString()}</div></div>
                    <div><div style={{ fontSize: 10, color: '#888' }}>Trough Value</div><div style={{ fontWeight: 700, color: RED }}>${m.peakToValley.troughValue?.toLocaleString()}</div></div>
                    <div><div style={{ fontSize: 10, color: '#888' }}>Drawdown</div><div style={{ fontWeight: 800, color: RED }}>{m.peakToValley.drawdownPct?.toFixed(2)}%</div></div>
                    <div><div style={{ fontSize: 10, color: '#888' }}>Duration</div><div style={{ fontWeight: 700, color: '#ffa500' }}>{m.peakToValley.durationMonths} mo</div></div>
                  </div>
                  <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>Stocks open during this period:</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {(m.peakToValley.tickersOpen || []).map(t => (
                      <span key={t} style={{ background: 'rgba(220,53,69,0.1)', color: '#e06060', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4 }}>{t}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* Monthly Performance History table */}
              {analyticsMonthly.length > 0 && (
                <div style={{ background: 'rgba(255,255,255,0.04)', border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden', marginBottom: 16 }}>
                  <div style={{ fontSize: 11, color: isAi300 ? '#0096ff' : YELLOW, fontWeight: 700, padding: '14px 18px 10px', letterSpacing: '0.05em', textTransform: 'uppercase', borderBottom: `1px solid ${BORDER}` }}>
                    Monthly Performance History
                  </div>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                          {['Month', 'Portfolio Value', 'Monthly Return', 'Cumulative', 'Unrealized P&L', 'Realized P&L', 'Idle Cash', 'Sweep', 'Open'].map(h => (
                            <th key={h} style={{ padding: '7px 12px', fontSize: 10, fontWeight: 700, color: '#888', textAlign: h === 'Month' ? 'left' : 'right', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {[...analyticsMonthly].reverse().map((r, i) => (
                          <tr key={r.month} style={{ background: i % 2 === 1 ? 'rgba(255,255,255,0.025)' : 'transparent' }}>
                            <td style={{ padding: '7px 12px', fontWeight: 700, color: isAi300 ? '#0096ff' : YELLOW }}>{r.month}</td>
                            <td style={{ padding: '7px 12px', textAlign: 'right', fontWeight: 700, color: '#fff' }}>${r.portfolioValue?.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                            <td style={{ padding: '7px 12px', textAlign: 'right', fontWeight: 700, color: r.monthlyReturn > 0 ? GREEN : r.monthlyReturn < 0 ? RED : '#aaa' }}>
                              {r.monthlyReturn >= 0 ? '+' : ''}{r.monthlyReturn?.toFixed(2)}%
                            </td>
                            <td style={{ padding: '7px 12px', textAlign: 'right', fontWeight: 600, color: r.cumulativeReturn > 0 ? GREEN : r.cumulativeReturn < 0 ? RED : '#aaa' }}>
                              {r.cumulativeReturn >= 0 ? '+' : ''}{r.cumulativeReturn?.toFixed(2)}%
                            </td>
                            <td style={{ padding: '7px 12px', textAlign: 'right', color: r.unrealizedPnl >= 0 ? '#4fc870' : '#e06060' }}>
                              {r.unrealizedPnl != null ? `${r.unrealizedPnl >= 0 ? '+' : ''}$${Math.abs(r.unrealizedPnl).toFixed(0)}` : '—'}
                            </td>
                            <td style={{ padding: '7px 12px', textAlign: 'right', color: r.realizedThisMonth >= 0 ? '#4fc870' : '#e06060' }}>
                              {r.realizedThisMonth != null ? `${r.realizedThisMonth >= 0 ? '+' : ''}$${Math.abs(r.realizedThisMonth).toFixed(0)}` : '—'}
                            </td>
                            <td style={{ padding: '7px 12px', textAlign: 'right', color: '#888' }}>${r.idleCash?.toFixed(0) ?? '—'}</td>
                            <td style={{ padding: '7px 12px', textAlign: 'right', color: '#4fc870', fontSize: 11 }}>+${r.sweepInterest?.toFixed(2) ?? '—'}</td>
                            <td style={{ padding: '7px 12px', textAlign: 'right', color: '#888' }}>{r.openPositions ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Regenerate button */}
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button onClick={handleGenerateAnalytics} disabled={analyticsGenerating}
                  style={{ background: 'transparent', color: '#888', fontWeight: 600, fontSize: 11, border: `1px solid ${BORDER}`, borderRadius: 6, padding: '6px 16px', cursor: analyticsGenerating ? 'default' : 'pointer' }}>
                  {analyticsGenerating ? 'Regenerating…' : '↻ Regenerate Snapshot'}
                </button>
              </div>
            </div>
          );
        })()}
      </div>

    </div>
  );
}
