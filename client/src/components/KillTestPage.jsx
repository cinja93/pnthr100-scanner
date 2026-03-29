// client/src/components/KillTestPage.jsx
// ── PNTHR Kill Test — Forward Performance Tracker ─────────────────────────────
//
// Tracks every stock that first qualifies on the PNTHR Kill list with:
//   Kill Score > 100  |  Analyze > 80%  |  Composite > 75
//
// Records the exact appearance date, price, stop, and risk % at qualification.
// Updated automatically every Friday after the Kill pipeline runs.
// Admin only.

import { useState, useEffect, useMemo } from 'react';
import { authHeaders, API_BASE } from '../services/api';

// ── Helpers ───────────────────────────────────────────────────────────────────
const YELLOW = '#fcf000';
const GREEN  = '#28a745';
const RED    = '#dc3545';
const ORANGE = '#ffa500';
const CARD_BG = 'rgba(255,255,255,0.04)';
const BORDER  = 'rgba(255,255,255,0.08)';
const ROW_ALT = 'rgba(255,255,255,0.02)';

const fmtPrice = (n) => n == null ? '—' : `$${Number(n).toFixed(2)}`;
const fmtPct   = (n) => n == null ? '—' : `${n >= 0 ? '+' : ''}${Number(n).toFixed(2)}%`;
const fmtRisk  = (n) => n == null ? '—' : `${Number(n).toFixed(2)}%`;
const fmtDate  = (s) => s ? new Date(s + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) : '—';
const daysSince = (dateStr) => {
  if (!dateStr) return null;
  const diff = Date.now() - new Date(dateStr + 'T12:00:00').getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
};

function calcCurrentPnl(rec) {
  const entry = rec.firstAppearancePrice;
  const last  = rec.lastSeenPrice;
  if (!entry || !last) return null;
  return rec.signal === 'SS'
    ? ((entry - last) / entry) * 100
    : ((last - entry) / entry) * 100;
}

// ── Stat Card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, color }) {
  return (
    <div style={{
      background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 8,
      padding: '14px 18px', flex: '1 1 110px', minWidth: 110,
    }}>
      <div style={{ fontSize: 11, color: '#888', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: color || '#fff', lineHeight: 1.1 }}>{value ?? '—'}</div>
      {sub && <div style={{ fontSize: 11, color: '#666', marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

// ── Signal Badge ──────────────────────────────────────────────────────────────
function SignalBadge({ signal }) {
  const bg    = signal === 'SS' ? 'rgba(220,53,69,0.18)' : 'rgba(40,167,69,0.18)';
  const color = signal === 'SS' ? RED : GREEN;
  return (
    <span style={{ background: bg, color, fontWeight: 700, fontSize: 11,
      padding: '2px 7px', borderRadius: 4, letterSpacing: '0.04em' }}>
      {signal}
    </span>
  );
}

// ── Tier Badge ────────────────────────────────────────────────────────────────
function TierBadge({ tier }) {
  const map = {
    'ALPHA PNTHR KILL': { bg: 'rgba(252,240,0,0.13)', color: YELLOW },
    'STRIKING':         { bg: 'rgba(0,200,100,0.12)', color: '#00c864' },
    'HUNTING':          { bg: 'rgba(0,150,255,0.12)', color: '#0096ff' },
  };
  const c = map[tier] || { bg: 'rgba(255,255,255,0.06)', color: '#aaa' };
  return (
    <span style={{ background: c.bg, color: c.color, fontWeight: 700, fontSize: 10,
      padding: '2px 7px', borderRadius: 4, letterSpacing: '0.03em' }}>
      {tier}
    </span>
  );
}

// ── P&L Cell ──────────────────────────────────────────────────────────────────
function PnlCell({ pct, isOpen }) {
  if (pct == null) return <span style={{ color: '#555' }}>—</span>;
  const color = pct > 0 ? GREEN : pct < 0 ? RED : '#aaa';
  return (
    <span style={{ color, fontWeight: 700 }}>
      {fmtPct(pct)}
      {isOpen && <span style={{ color: '#555', fontWeight: 400, fontSize: 10, marginLeft: 4 }}>est</span>}
    </span>
  );
}

// ── Score Pills Row ───────────────────────────────────────────────────────────
function ScorePills({ kill, analyze, composite }) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 10, padding: '2px 5px', borderRadius: 3,
        background: 'rgba(252,240,0,0.1)', color: YELLOW, fontWeight: 700 }}>
        K:{kill}
      </span>
      <span style={{ fontSize: 10, padding: '2px 5px', borderRadius: 3,
        background: 'rgba(40,167,69,0.1)', color: '#4fc870', fontWeight: 700 }}>
        A:{analyze}%
      </span>
      <span style={{ fontSize: 10, padding: '2px 5px', borderRadius: 3,
        background: 'rgba(0,150,255,0.1)', color: '#48b0ff', fontWeight: 700 }}>
        C:{composite}
      </span>
    </div>
  );
}

// ── Table ─────────────────────────────────────────────────────────────────────
const TH = ({ children, align = 'left', style = {} }) => (
  <th style={{
    padding: '8px 12px', fontSize: 11, fontWeight: 700, letterSpacing: '0.05em',
    color: '#888', textAlign: align, textTransform: 'uppercase',
    borderBottom: `1px solid ${BORDER}`, whiteSpace: 'nowrap', ...style,
  }}>{children}</th>
);

const TD = ({ children, align = 'left', style = {} }) => (
  <td style={{
    padding: '9px 12px', fontSize: 13, color: '#ccc',
    textAlign: align, borderBottom: `1px solid rgba(255,255,255,0.04)`,
    verticalAlign: 'middle', ...style,
  }}>{children}</td>
);

// ── Active Appearances Table ──────────────────────────────────────────────────
function ActiveTable({ rows }) {
  if (!rows.length) return (
    <div style={{ padding: '32px 0', textAlign: 'center', color: '#555', fontSize: 13 }}>
      No active appearances — qualifying stocks will appear here each Friday
    </div>
  );

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            <TH>Rank</TH>
            <TH>Ticker</TH>
            <TH>Signal</TH>
            <TH>Appeared</TH>
            <TH align="right">Entry Price</TH>
            <TH align="right">Stop</TH>
            <TH align="right">Risk %</TH>
            <TH>Kill / Analyze / Composite</TH>
            <TH>Tier</TH>
            <TH align="right">Last Price</TH>
            <TH align="right">P&L Est.</TH>
            <TH align="center">Days</TH>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const pnl  = calcCurrentPnl(r);
            const days = daysSince(r.firstAppearanceDate);
            const rowBg = i % 2 === 1 ? ROW_ALT : 'transparent';
            return (
              <tr key={r._id} style={{ background: rowBg }}>
                <TD style={{ color: YELLOW, fontWeight: 700 }}>#{r.firstKillRank ?? '—'}</TD>
                <TD>
                  <span style={{ fontWeight: 800, color: '#fff', fontSize: 14 }}>{r.ticker}</span>
                  {r.sector && <div style={{ fontSize: 10, color: '#666', marginTop: 2 }}>{r.sector}</div>}
                </TD>
                <TD><SignalBadge signal={r.signal} /></TD>
                <TD style={{ whiteSpace: 'nowrap' }}>
                  {fmtDate(r.firstAppearanceDate)}
                  {r.firstSignalAge != null && (
                    <span style={{ color: '#555', fontSize: 11, marginLeft: 4 }}>
                      {r.signal}+{r.firstSignalAge}
                    </span>
                  )}
                </TD>
                <TD align="right" style={{ fontWeight: 700, color: '#fff' }}>{fmtPrice(r.firstAppearancePrice)}</TD>
                <TD align="right" style={{ color: ORANGE }}>{fmtPrice(r.firstStopPrice)}</TD>
                <TD align="right">
                  <span style={{ color: r.firstRiskPct > 15 ? RED : r.firstRiskPct > 10 ? ORANGE : '#aaa', fontWeight: 600 }}>
                    {fmtRisk(r.firstRiskPct)}
                  </span>
                </TD>
                <TD><ScorePills kill={r.firstKillScore} analyze={r.firstAnalyzeScore} composite={r.firstCompositeScore} /></TD>
                <TD><TierBadge tier={r.firstTier} /></TD>
                <TD align="right" style={{ color: '#ddd' }}>{fmtPrice(r.lastSeenPrice)}</TD>
                <TD align="right"><PnlCell pct={pnl} isOpen /></TD>
                <TD align="center" style={{ color: '#666' }}>{days ?? '—'}</TD>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Closed Appearances Table ──────────────────────────────────────────────────
function ClosedTable({ rows }) {
  if (!rows.length) return (
    <div style={{ padding: '32px 0', textAlign: 'center', color: '#555', fontSize: 13 }}>
      No closed trades yet — results will appear here when signals exit
    </div>
  );

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            <TH>Ticker</TH>
            <TH>Signal</TH>
            <TH>Appeared</TH>
            <TH>Exited</TH>
            <TH align="right">Entry</TH>
            <TH align="right">Stop</TH>
            <TH align="right">Risk %</TH>
            <TH>Scores at Entry</TH>
            <TH align="right">Exit Price</TH>
            <TH align="right">Profit %</TH>
            <TH align="center">Weeks</TH>
            <TH align="center">Result</TH>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const rowBg = i % 2 === 1 ? ROW_ALT : 'transparent';
            return (
              <tr key={r._id} style={{ background: rowBg }}>
                <TD>
                  <span style={{ fontWeight: 800, color: '#fff', fontSize: 14 }}>{r.ticker}</span>
                  {r.sector && <div style={{ fontSize: 10, color: '#666', marginTop: 2 }}>{r.sector}</div>}
                </TD>
                <TD><SignalBadge signal={r.signal} /></TD>
                <TD style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.firstAppearanceDate)}</TD>
                <TD style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.exitDate)}</TD>
                <TD align="right" style={{ fontWeight: 700, color: '#fff' }}>{fmtPrice(r.firstAppearancePrice)}</TD>
                <TD align="right" style={{ color: ORANGE }}>{fmtPrice(r.firstStopPrice)}</TD>
                <TD align="right">
                  <span style={{ color: r.firstRiskPct > 15 ? RED : r.firstRiskPct > 10 ? ORANGE : '#aaa', fontWeight: 600 }}>
                    {fmtRisk(r.firstRiskPct)}
                  </span>
                </TD>
                <TD><ScorePills kill={r.firstKillScore} analyze={r.firstAnalyzeScore} composite={r.firstCompositeScore} /></TD>
                <TD align="right">{fmtPrice(r.exitPrice)}</TD>
                <TD align="right"><PnlCell pct={r.profitPct} /></TD>
                <TD align="center" style={{ color: '#888' }}>{r.holdingWeeks ?? '—'}</TD>
                <TD align="center">
                  {r.isWinner == null ? <span style={{ color: '#555' }}>—</span>
                    : r.isWinner
                      ? <span style={{ color: GREEN, fontWeight: 700, fontSize: 12 }}>WIN ✓</span>
                      : <span style={{ color: RED,   fontWeight: 700, fontSize: 12 }}>LOSS ✗</span>
                  }
                </TD>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────
export default function KillTestPage() {
  const [data,    setData]    = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [tab,     setTab]     = useState('active');

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const res = await fetch(`${API_BASE}/api/kill-appearances`, { headers: authHeaders() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setData(await res.json());
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const active = useMemo(() => data.filter(r => !r.exitDate), [data]);
  const closed = useMemo(() => data.filter(r =>  r.exitDate), [data]);

  // Summary stats
  const stats = useMemo(() => {
    const closedWinners = closed.filter(r => r.isWinner === true);
    const winRate  = closed.length ? Math.round((closedWinners.length / closed.length) * 100) : null;
    const avgProfit = closed.length
      ? +(closed.reduce((s, r) => s + (r.profitPct || 0), 0) / closed.length).toFixed(2)
      : null;
    const avgRisk = active.length
      ? +(active.reduce((s, r) => s + (r.firstRiskPct || 0), 0) / active.filter(r => r.firstRiskPct).length).toFixed(2)
      : null;
    const activePnl = active.map(r => calcCurrentPnl(r)).filter(n => n != null);
    const avgActivePnl = activePnl.length
      ? +(activePnl.reduce((s, n) => s + n, 0) / activePnl.length).toFixed(2)
      : null;
    return { winRate, avgProfit, avgRisk, avgActivePnl };
  }, [active, closed]);

  if (loading) return (
    <div style={{ padding: 40, color: '#888', textAlign: 'center', fontFamily: 'monospace' }}>
      Loading Kill Test data...
    </div>
  );
  if (error) return (
    <div style={{ padding: 40, color: RED, textAlign: 'center' }}>Error: {error}</div>
  );

  const tabStyle = (key) => ({
    padding: '8px 20px', cursor: 'pointer', border: 'none', fontSize: 13,
    fontWeight: 700, borderRadius: '6px 6px 0 0',
    background: tab === key ? 'rgba(252,240,0,0.1)' : 'transparent',
    color: tab === key ? YELLOW : '#888',
    borderBottom: tab === key ? `2px solid ${YELLOW}` : '2px solid transparent',
  });

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1400, margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ color: YELLOW, fontSize: 26, fontWeight: 900, margin: 0, letterSpacing: '0.03em' }}>
          PNTHR Kill Test
        </h1>
        <p style={{ color: '#666', fontSize: 13, margin: '6px 0 0' }}>
          Forward performance tracker — stocks qualifying with Kill &gt; 100, Analyze &gt; 80%, Composite &gt; 75.
          Appearance price, stop, and risk % captured at the exact moment of first qualification.
          Updated every Friday after market close.
        </p>
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 28 }}>
        <StatCard label="Active"       value={active.length}                     sub="open appearances" />
        <StatCard label="Closed"       value={closed.length}                     sub="completed trades" />
        <StatCard label="Win Rate"     value={stats.winRate != null ? `${stats.winRate}%` : '—'}
                  color={stats.winRate >= 70 ? GREEN : stats.winRate >= 50 ? ORANGE : RED}
                  sub={`${closed.length} closed`} />
        <StatCard label="Avg Profit"   value={stats.avgProfit != null ? fmtPct(stats.avgProfit) : '—'}
                  color={stats.avgProfit > 0 ? GREEN : stats.avgProfit < 0 ? RED : '#fff'}
                  sub="closed trades" />
        <StatCard label="Avg Risk"     value={stats.avgRisk != null ? `${stats.avgRisk}%` : '—'}
                  color={ORANGE} sub="at appearance" />
        <StatCard label="Active P&L"  value={stats.avgActivePnl != null ? fmtPct(stats.avgActivePnl) : '—'}
                  color={stats.avgActivePnl > 0 ? GREEN : stats.avgActivePnl < 0 ? RED : '#fff'}
                  sub="avg estimated" />
      </div>

      {/* Tab Bar */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${BORDER}`, marginBottom: 0 }}>
        <button style={tabStyle('active')} onClick={() => setTab('active')}>
          Active ({active.length})
        </button>
        <button style={tabStyle('closed')} onClick={() => setTab('closed')}>
          Closed ({closed.length})
        </button>
      </div>

      {/* Table */}
      <div style={{
        background: CARD_BG, border: `1px solid ${BORDER}`, borderTop: 'none',
        borderRadius: '0 0 8px 8px', padding: '4px 0',
      }}>
        {tab === 'active' ? <ActiveTable rows={active} /> : <ClosedTable rows={closed} />}
      </div>

      {/* Footer note */}
      <div style={{ marginTop: 16, fontSize: 12, color: '#444', textAlign: 'right' }}>
        P&L for active trades is estimated from last Friday close price.
        Exit data populated automatically when Friday pipeline detects signal close.
      </div>
    </div>
  );
}
