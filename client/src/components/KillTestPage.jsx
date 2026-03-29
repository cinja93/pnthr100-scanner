// client/src/components/KillTestPage.jsx
// ── PNTHR Kill Test — Forward Performance Tracker ─────────────────────────────
//
// Admin-only page tracking stocks that first qualify on the PNTHR Kill list:
//   Kill > 100 | Analyze > 80% | Composite > 75
//
// Simulates the full lot 1–5 pyramid (15/30/25/20/10%) using the same
// sizePosition() logic as PNTHR Command's Size It. Configurable NAV,
// risk %, portfolio cap, and sweep rate.

import { useState, useEffect, useMemo, useRef } from 'react';
import { authHeaders, API_BASE } from '../services/api';

// ── Brand palette ─────────────────────────────────────────────────────────────
const Y      = '#fcf000';   // PNTHR yellow
const GREEN  = '#28a745';
const RED    = '#dc3545';
const ORANGE = '#ffa500';
const BG     = '#0d0d0d';
const BG2    = '#141414';
const BG3    = 'rgba(255,255,255,0.04)';
const BORDER = 'rgba(255,255,255,0.08)';
const BORDER2= 'rgba(255,255,255,0.14)';
const ROW_ALT= 'rgba(255,255,255,0.025)';
const TEXT   = '#ccc';
const DIM    = '#666';
const SUBDIM = '#444';

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmtPrice   = (n) => n == null ? '—' : `$${Number(n).toFixed(2)}`;
const fmtPct     = (n) => n == null ? '—' : `${n >= 0 ? '+' : ''}${Number(n).toFixed(2)}%`;
const fmtDollar  = (n) => n == null ? '—' : `${n >= 0 ? '+' : ''}$${Math.abs(n).toFixed(0)}`;
const fmtRisk    = (n) => n == null ? '—' : `${Number(n).toFixed(2)}%`;

const fmtDate = (s) => s
  ? new Date(s + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
  : '—';

const fmtTimestamp = (iso) => {
  if (!iso) return 'Fri 4:15 PM ET (exact time unavailable)';
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', month: 'short', day: 'numeric', year: '2-digit',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
  });
};

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

// ── Shared table cell components ──────────────────────────────────────────────
const TH = ({ children, align = 'left', style = {} }) => (
  <th style={{
    padding: '8px 12px', fontSize: 10, fontWeight: 700, letterSpacing: '0.07em',
    color: DIM, textAlign: align, textTransform: 'uppercase',
    borderBottom: `1px solid ${BORDER}`, whiteSpace: 'nowrap', ...style,
  }}>{children}</th>
);
const TD = ({ children, align = 'left', style = {} }) => (
  <td style={{
    padding: '9px 12px', fontSize: 13, color: TEXT,
    textAlign: align, borderBottom: `1px solid ${SUBDIM}`,
    verticalAlign: 'middle', ...style,
  }}>{children}</td>
);

// ── Signal badge ──────────────────────────────────────────────────────────────
function SignalBadge({ signal }) {
  const isShort = signal === 'SS';
  return (
    <span style={{
      background: isShort ? 'rgba(220,53,69,0.18)' : 'rgba(40,167,69,0.18)',
      color:      isShort ? RED : GREEN,
      fontWeight: 700, fontSize: 11, padding: '2px 7px',
      borderRadius: 4, letterSpacing: '0.04em',
    }}>{signal}</span>
  );
}

// ── Tier badge ────────────────────────────────────────────────────────────────
function TierBadge({ tier }) {
  const map = {
    'ALPHA PNTHR KILL': { bg: `rgba(252,240,0,0.13)`, color: Y },
    'STRIKING':         { bg: 'rgba(0,200,100,0.12)', color: '#00c864' },
    'HUNTING':          { bg: 'rgba(0,150,255,0.12)', color: '#0096ff' },
  };
  const c = map[tier] || { bg: 'rgba(255,255,255,0.06)', color: '#aaa' };
  return (
    <span style={{
      background: c.bg, color: c.color, fontWeight: 700, fontSize: 10,
      padding: '2px 7px', borderRadius: 4, letterSpacing: '0.03em',
    }}>{tier}</span>
  );
}

// ── Score pills ───────────────────────────────────────────────────────────────
function ScorePills({ kill, analyze, composite }) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 10, padding: '2px 5px', borderRadius: 3, background: `rgba(252,240,0,0.1)`, color: Y, fontWeight: 700 }}>
        K:{kill ?? '—'}
      </span>
      <span style={{ fontSize: 10, padding: '2px 5px', borderRadius: 3, background: 'rgba(40,167,69,0.1)', color: '#4fc870', fontWeight: 700 }}>
        A:{analyze ?? '—'}%
      </span>
      <span style={{ fontSize: 10, padding: '2px 5px', borderRadius: 3, background: 'rgba(0,150,255,0.1)', color: '#48b0ff', fontWeight: 700 }}>
        C:{composite ?? '—'}
      </span>
    </div>
  );
}

// ── Lot fill indicator ────────────────────────────────────────────────────────
function LotDots({ lotFills }) {
  if (!lotFills) return <span style={{ color: SUBDIM, fontSize: 11 }}>—</span>;
  return (
    <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
      {[1, 2, 3, 4, 5].map(n => {
        const fill = lotFills[`lot${n}`];
        const filled = fill?.filled;
        return (
          <span
            key={n}
            title={filled ? `Lot ${n}: $${fill.fillPrice} (${fill.shares} shr)` : `Lot ${n}: pending`}
            style={{
              width: 10, height: 10, borderRadius: '50%',
              background: filled ? (n <= 3 ? Y : '#00c864') : SUBDIM,
              display: 'inline-block', cursor: filled ? 'help' : 'default',
            }}
          />
        );
      })}
    </div>
  );
}

// ── P&L cell ──────────────────────────────────────────────────────────────────
function PnlCell({ pct, dollar, isOpen }) {
  if (pct == null) return <span style={{ color: SUBDIM }}>—</span>;
  const color = pct > 0 ? GREEN : pct < 0 ? RED : '#aaa';
  return (
    <div>
      <span style={{ color, fontWeight: 700 }}>
        {fmtPct(pct)}
        {isOpen && <span style={{ color: SUBDIM, fontWeight: 400, fontSize: 10, marginLeft: 3 }}>est</span>}
      </span>
      {dollar != null && (
        <div style={{ fontSize: 11, color: dollar > 0 ? '#4fc870' : dollar < 0 ? '#e06060' : DIM, marginTop: 1 }}>
          {fmtDollar(dollar)}
        </div>
      )}
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, color, dollar }) {
  return (
    <div style={{
      background: BG3, border: `1px solid ${BORDER}`, borderRadius: 8,
      padding: '14px 18px', flex: '1 1 110px', minWidth: 110,
    }}>
      <div style={{ fontSize: 10, color: DIM, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: color || '#fff', lineHeight: 1.1 }}>{value ?? '—'}</div>
      {dollar != null && <div style={{ fontSize: 12, color: dollar > 0 ? '#4fc870' : dollar < 0 ? '#e06060' : DIM, marginTop: 2, fontWeight: 600 }}>{fmtDollar(dollar)}</div>}
      {sub && <div style={{ fontSize: 11, color: '#555', marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

// ── Settings panel ────────────────────────────────────────────────────────────
function SettingsPanel({ settings, onSave, onCancel }) {
  const [vals, setVals] = useState({ ...settings });
  const [saving, setSaving] = useState(false);

  const field = (key, label, suffix = '', hint = '') => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 140 }}>
      <label style={{ fontSize: 10, color: DIM, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {key === 'nav' && <span style={{ color: DIM, fontSize: 13 }}>$</span>}
        <input
          type="number"
          value={vals[key] ?? ''}
          onChange={e => setVals(v => ({ ...v, [key]: e.target.value }))}
          style={{
            background: '#1a1a1a', border: `1px solid ${BORDER2}`, borderRadius: 6,
            color: '#fff', fontSize: 14, fontWeight: 600, padding: '6px 10px',
            width: key === 'nav' ? 110 : 70, outline: 'none',
          }}
        />
        {suffix && <span style={{ color: DIM, fontSize: 12 }}>{suffix}</span>}
      </div>
      {hint && <div style={{ fontSize: 10, color: '#555' }}>{hint}</div>}
    </div>
  );

  const handleSave = async () => {
    setSaving(true);
    try { await onSave(vals); } finally { setSaving(false); }
  };

  return (
    <div style={{
      background: '#111', border: `1px solid ${BORDER2}`, borderRadius: 10,
      padding: '20px 24px', marginBottom: 24,
    }}>
      <div style={{ fontSize: 12, color: Y, fontWeight: 700, marginBottom: 16, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
        Portfolio Simulation Settings
      </div>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {field('nav',              'Starting NAV',        '',    'Full portfolio value')}
        {field('riskPctPerTrade',  'Risk / Trade',        '%',   '1% = Size It default')}
        {field('portfolioRiskCap', 'Portfolio Risk Cap',  '%',   'Max total heat allowed')}
        {field('sweepRate',        'IBKR Sweep Rate',     '%',   'Idle cash interest')}
        {field('riskFreeRate',     'Risk-Free Rate',      '%',   '2-yr Treasury yield')}
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            background: Y, color: '#000', fontWeight: 800, fontSize: 12,
            border: 'none', borderRadius: 6, padding: '8px 20px',
            cursor: saving ? 'default' : 'pointer', letterSpacing: '0.05em',
          }}
        >
          {saving ? 'Saving…' : 'SAVE SETTINGS'}
        </button>
        <button
          onClick={onCancel}
          style={{
            background: 'transparent', color: DIM, fontWeight: 600, fontSize: 12,
            border: `1px solid ${BORDER}`, borderRadius: 6, padding: '8px 16px', cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Active appearances table ───────────────────────────────────────────────────
function ActiveTable({ rows }) {
  if (!rows.length) return (
    <div style={{ padding: '48px 0', textAlign: 'center', color: SUBDIM, fontSize: 13 }}>
      No active appearances — qualifying stocks will appear here each Friday after market close.
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
            <TH align="right">Appearance Price</TH>
            <TH align="right">Stop</TH>
            <TH align="right">Risk %</TH>
            <TH>Kill / Analyze / Composite</TH>
            <TH>Tier</TH>
            <TH>Lots</TH>
            <TH align="right">Last Price</TH>
            <TH align="right">P&L Est.</TH>
            <TH align="center">Days</TH>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const pnlPct    = r.currentPnlPct    ?? calcCurrentPnl(r);
            const pnlDollar = r.currentPnlDollar ?? null;
            const rowBg     = i % 2 === 1 ? ROW_ALT : 'transparent';
            const days      = daysSince(r.firstAppearanceDate);
            const feast     = r.feastFired;
            return (
              <tr key={r._id} style={{ background: rowBg }}>
                <TD style={{ color: Y, fontWeight: 700 }}>#{r.firstKillRank ?? '—'}</TD>
                <TD>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontWeight: 800, color: '#fff', fontSize: 14 }}>{r.ticker}</span>
                    {feast && (
                      <span title="Feast Alert fired — 50% exited" style={{ fontSize: 10, color: ORANGE, fontWeight: 700, border: `1px solid ${ORANGE}`, borderRadius: 3, padding: '1px 4px' }}>
                        FEAST
                      </span>
                    )}
                  </div>
                  {r.sector && <div style={{ fontSize: 10, color: DIM, marginTop: 2 }}>{r.sector}</div>}
                </TD>
                <TD><SignalBadge signal={r.signal} /></TD>
                <TD style={{ whiteSpace: 'nowrap', color: DIM }}>
                  {fmtDate(r.firstAppearanceDate)}
                  {r.firstSignalAge != null && (
                    <span style={{ color: '#444', fontSize: 10, marginLeft: 4 }}>
                      {r.signal}+{r.firstSignalAge}
                    </span>
                  )}
                </TD>
                <TD align="right">
                  <span
                    style={{ fontWeight: 700, color: '#fff', borderBottom: `1px dotted ${SUBDIM}`, cursor: 'help' }}
                    title={`Captured: ${fmtTimestamp(r.createdAt)}`}
                  >
                    {fmtPrice(r.firstAppearancePrice)}
                  </span>
                  {r.lotConfig && (
                    <div style={{ fontSize: 10, color: DIM, marginTop: 1 }}>
                      {r.lotConfig.totalShares} shr | ${r.lotConfig.maxRiskDollar?.toFixed(0)} risk
                    </div>
                  )}
                </TD>
                <TD align="right">
                  <span style={{ color: ORANGE, fontWeight: 600 }}>{fmtPrice(r.currentStop ?? r.firstStopPrice)}</span>
                  {r.currentStop && r.firstStopPrice && r.currentStop !== r.firstStopPrice && (
                    <div style={{ fontSize: 10, color: '#4fc870', marginTop: 1 }}>↓ ratcheted</div>
                  )}
                </TD>
                <TD align="right">
                  <span style={{
                    color: r.firstRiskPct > 15 ? RED : r.firstRiskPct > 10 ? ORANGE : '#aaa',
                    fontWeight: 600,
                  }}>
                    {fmtRisk(r.firstRiskPct)}
                  </span>
                </TD>
                <TD><ScorePills kill={r.firstKillScore} analyze={r.firstAnalyzeScore} composite={r.firstCompositeScore} /></TD>
                <TD><TierBadge tier={r.firstTier} /></TD>
                <TD>
                  <LotDots lotFills={r.lotFills} />
                  {r.lotsFilledCount != null && (
                    <div style={{ fontSize: 10, color: DIM, marginTop: 2 }}>{r.lotsFilledCount}/5 filled</div>
                  )}
                </TD>
                <TD align="right" style={{ color: '#ddd' }}>{fmtPrice(r.lastSeenPrice)}</TD>
                <TD align="right">
                  <PnlCell pct={pnlPct} dollar={pnlDollar} isOpen />
                </TD>
                <TD align="center" style={{ color: DIM }}>{days ?? '—'}</TD>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Closed appearances table ───────────────────────────────────────────────────
function ClosedTable({ rows }) {
  if (!rows.length) return (
    <div style={{ padding: '48px 0', textAlign: 'center', color: SUBDIM, fontSize: 13 }}>
      No closed trades yet — results appear here when stop hit, signal closes, or Feast exit.
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
            <TH align="right">App. Price</TH>
            <TH align="right">Exit Price</TH>
            <TH>Exit Reason</TH>
            <TH>Lots</TH>
            <TH>Scores at App.</TH>
            <TH align="right">P&L %</TH>
            <TH align="right">P&L $</TH>
            <TH align="center">Wks</TH>
            <TH align="center">Result</TH>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const rowBg = i % 2 === 1 ? ROW_ALT : 'transparent';
            const reasonColor = { STOP: RED, FEAST: ORANGE, SIGNAL_CLOSE: '#4fc870' }[r.exitReason] ?? DIM;
            return (
              <tr key={r._id} style={{ background: rowBg }}>
                <TD>
                  <span style={{ fontWeight: 800, color: '#fff', fontSize: 14 }}>{r.ticker}</span>
                  {r.sector && <div style={{ fontSize: 10, color: DIM, marginTop: 2 }}>{r.sector}</div>}
                </TD>
                <TD><SignalBadge signal={r.signal} /></TD>
                <TD style={{ whiteSpace: 'nowrap', color: DIM }}>{fmtDate(r.firstAppearanceDate)}</TD>
                <TD style={{ whiteSpace: 'nowrap', color: DIM }}>{fmtDate(r.exitDate)}</TD>
                <TD align="right">
                  <span
                    style={{ fontWeight: 700, color: '#fff', borderBottom: `1px dotted ${SUBDIM}`, cursor: 'help' }}
                    title={`Captured: ${fmtTimestamp(r.createdAt)}`}
                  >
                    {fmtPrice(r.firstAppearancePrice)}
                  </span>
                </TD>
                <TD align="right" style={{ fontWeight: 600 }}>{fmtPrice(r.exitPrice)}</TD>
                <TD>
                  <span style={{ color: reasonColor, fontWeight: 700, fontSize: 11 }}>
                    {r.exitReason ?? '—'}
                  </span>
                </TD>
                <TD><LotDots lotFills={r.lotFills} /></TD>
                <TD><ScorePills kill={r.firstKillScore} analyze={r.firstAnalyzeScore} composite={r.firstCompositeScore} /></TD>
                <TD align="right">
                  <PnlCell pct={r.profitPct} />
                </TD>
                <TD align="right">
                  {r.profitDollar != null ? (
                    <span style={{ color: r.profitDollar >= 0 ? GREEN : RED, fontWeight: 700 }}>
                      {fmtDollar(r.profitDollar)}
                    </span>
                  ) : <span style={{ color: SUBDIM }}>—</span>}
                </TD>
                <TD align="center" style={{ color: DIM }}>{r.holdingWeeks ?? '—'}</TD>
                <TD align="center">
                  {r.isWinner == null
                    ? <span style={{ color: SUBDIM }}>—</span>
                    : r.isWinner
                      ? <span style={{ color: GREEN, fontWeight: 800, fontSize: 12 }}>WIN ✓</span>
                      : <span style={{ color: RED,   fontWeight: 800, fontSize: 12 }}>LOSS ✗</span>
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

// ── Main component ─────────────────────────────────────────────────────────────
export default function KillTestPage() {
  const [data,        setData]        = useState([]);
  const [settings,    setSettings]    = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const [tab,         setTab]         = useState('active');
  const [showSettings, setShowSettings] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);

  // Load data + settings on mount
  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const [dataRes, settingsRes] = await Promise.all([
          fetch(`${API_BASE}/api/kill-appearances`,   { headers: authHeaders() }),
          fetch(`${API_BASE}/api/kill-test/settings`, { headers: authHeaders() }),
        ]);
        if (!dataRes.ok)     throw new Error(`Data HTTP ${dataRes.status}`);
        if (!settingsRes.ok) throw new Error(`Settings HTTP ${settingsRes.status}`);
        const [dataJson, settingsJson] = await Promise.all([dataRes.json(), settingsRes.json()]);
        setData(dataJson);
        setSettings(settingsJson);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const handleSaveSettings = async (vals) => {
    const res = await fetch(`${API_BASE}/api/kill-test/settings`, {
      method:  'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body:    JSON.stringify(vals),
    });
    if (!res.ok) throw new Error(`Save failed: ${res.status}`);
    const updated = await res.json();
    setSettings(updated);
    setShowSettings(false);
    setSettingsSaved(true);
    setTimeout(() => setSettingsSaved(false), 3000);
  };

  const active = useMemo(() => data.filter(r => !r.exitDate), [data]);
  const closed = useMemo(() => data.filter(r =>  r.exitDate), [data]);

  // Summary stats
  const stats = useMemo(() => {
    const winners = closed.filter(r => r.isWinner === true);
    const winRate = closed.length ? Math.round((winners.length / closed.length) * 100) : null;

    const avgProfitPct = closed.length
      ? +(closed.reduce((s, r) => s + (r.profitPct || 0), 0) / closed.length).toFixed(2)
      : null;

    const totalPnlDollar = closed.length
      ? closed.reduce((s, r) => s + (r.profitDollar || 0), 0)
      : null;

    const avgRisk = active.filter(r => r.firstRiskPct).length
      ? +(active.reduce((s, r) => s + (r.firstRiskPct || 0), 0) / active.filter(r => r.firstRiskPct).length).toFixed(2)
      : null;

    const activePnls = active.map(r => r.currentPnlPct ?? calcCurrentPnl(r)).filter(n => n != null);
    const avgActivePnl = activePnls.length
      ? +(activePnls.reduce((s, n) => s + n, 0) / activePnls.length).toFixed(2)
      : null;

    const activeDollarPnl = active.reduce((s, r) => s + (r.currentPnlDollar || 0), 0);

    const lotsStats = active.reduce((acc, r) => {
      acc.total++;
      acc.lotsFilledTotal += r.lotsFilledCount || 1;
      if (r.feastFired) acc.feast++;
      return acc;
    }, { total: 0, lotsFilledTotal: 0, feast: 0 });

    return { winRate, avgProfitPct, totalPnlDollar, avgRisk, avgActivePnl, activeDollarPnl, lotsStats };
  }, [active, closed]);

  // Tab style
  const tabStyle = (key) => ({
    padding: '9px 22px', cursor: 'pointer', border: 'none', fontSize: 13,
    fontWeight: 700, borderRadius: '6px 6px 0 0', fontFamily: 'inherit',
    background: tab === key ? 'rgba(252,240,0,0.07)' : 'transparent',
    color:      tab === key ? Y : DIM,
    borderBottom: tab === key ? `2px solid ${Y}` : `2px solid transparent`,
  });

  if (loading) return (
    <div style={{ background: BG, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: DIM, fontFamily: 'system-ui, sans-serif', fontSize: 14 }}>
      Loading Kill Test data…
    </div>
  );
  if (error) return (
    <div style={{ background: BG, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: RED, fontFamily: 'system-ui, sans-serif' }}>
      Error: {error}
    </div>
  );

  const nav = settings?.nav ?? 100000;
  const lotsAvg = stats.lotsStats.total > 0
    ? (stats.lotsStats.lotsFilledTotal / stats.lotsStats.total).toFixed(1)
    : null;

  return (
    <div style={{ background: BG, minHeight: '100vh', padding: '28px 32px', maxWidth: 1440, margin: '0 auto', fontFamily: 'system-ui, sans-serif', color: TEXT, boxSizing: 'border-box' }}>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h1 style={{ color: Y, fontSize: 26, fontWeight: 900, margin: 0, letterSpacing: '0.03em' }}>
            PNTHR Kill Test
          </h1>
          <p style={{ color: DIM, fontSize: 12, margin: '6px 0 0', maxWidth: 640, lineHeight: 1.5 }}>
            Forward performance tracker — Kill &gt; 100, Analyze &gt; 80%, Composite &gt; 75.
            Simulates full lot 1–5 pyramid. Appearance price captured at exact moment of first qualification.
          </p>
        </div>

        {/* Settings gear */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {settingsSaved && (
            <span style={{ fontSize: 12, color: '#4fc870', fontWeight: 600 }}>✓ Settings saved</span>
          )}
          {settings && (
            <div style={{ fontSize: 11, color: DIM, textAlign: 'right', lineHeight: 1.6 }}>
              <div>NAV: <span style={{ color: TEXT, fontWeight: 600 }}>${(nav).toLocaleString()}</span></div>
              <div>Risk: <span style={{ color: TEXT, fontWeight: 600 }}>{settings.riskPctPerTrade}% | Cap {settings.portfolioRiskCap}%</span></div>
              <div>Sweep: <span style={{ color: TEXT, fontWeight: 600 }}>{settings.sweepRate}% | Rf {settings.riskFreeRate}%</span></div>
            </div>
          )}
          <button
            onClick={() => setShowSettings(v => !v)}
            style={{
              background: showSettings ? `rgba(252,240,0,0.1)` : 'rgba(255,255,255,0.05)',
              border: `1px solid ${showSettings ? Y : BORDER}`,
              borderRadius: 8, padding: '8px 14px', cursor: 'pointer',
              color: showSettings ? Y : DIM, fontSize: 13, fontWeight: 700,
              fontFamily: 'inherit',
            }}
          >
            ⚙ Settings
          </button>
        </div>
      </div>

      {/* ── Settings panel ─────────────────────────────────────────────── */}
      {showSettings && settings && (
        <SettingsPanel
          settings={settings}
          onSave={handleSaveSettings}
          onCancel={() => setShowSettings(false)}
        />
      )}

      {/* ── Stats row ──────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 28 }}>
        <StatCard label="Active"      value={active.length}  sub="open appearances" />
        <StatCard label="Closed"      value={closed.length}  sub="completed" />
        <StatCard
          label="Win Rate"
          value={stats.winRate != null ? `${stats.winRate}%` : '—'}
          color={stats.winRate >= 70 ? GREEN : stats.winRate >= 50 ? ORANGE : stats.winRate != null ? RED : '#aaa'}
          sub={`${closed.length} closed`}
        />
        <StatCard
          label="Avg Profit"
          value={stats.avgProfitPct != null ? fmtPct(stats.avgProfitPct) : '—'}
          dollar={stats.totalPnlDollar}
          color={stats.avgProfitPct > 0 ? GREEN : stats.avgProfitPct < 0 ? RED : '#fff'}
          sub="closed trades"
        />
        <StatCard
          label="Avg Risk"
          value={stats.avgRisk != null ? `${stats.avgRisk}%` : '—'}
          color={ORANGE}
          sub="at appearance"
        />
        <StatCard
          label="Active P&L"
          value={stats.avgActivePnl != null ? fmtPct(stats.avgActivePnl) : '—'}
          dollar={stats.activeDollarPnl || null}
          color={stats.avgActivePnl > 0 ? GREEN : stats.avgActivePnl < 0 ? RED : '#fff'}
          sub="avg estimated"
        />
        <StatCard
          label="Avg Lots"
          value={lotsAvg ?? '—'}
          color="#48b0ff"
          sub={`${stats.lotsStats.feast} feast alerts`}
        />
      </div>

      {/* ── Tab bar ────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${BORDER}`, marginBottom: 0 }}>
        <button style={tabStyle('active')} onClick={() => setTab('active')}>
          Active ({active.length})
        </button>
        <button style={tabStyle('closed')} onClick={() => setTab('closed')}>
          Closed ({closed.length})
        </button>
        <button style={{ ...tabStyle('analytics'), opacity: 0.4 }} title="Coming soon — requires monthly equity data">
          Portfolio Analytics
        </button>
      </div>

      {/* ── Table area ─────────────────────────────────────────────────── */}
      <div style={{
        background: BG3, border: `1px solid ${BORDER}`, borderTop: 'none',
        borderRadius: '0 0 10px 10px', padding: '4px 0',
      }}>
        {tab === 'active'    ? <ActiveTable rows={active} /> :
         tab === 'closed'    ? <ClosedTable rows={closed} /> :
         <div style={{ padding: 40, textAlign: 'center', color: SUBDIM, fontSize: 13 }}>Portfolio Analytics coming soon</div>}
      </div>

      {/* ── Footer note ────────────────────────────────────────────────── */}
      <div style={{ marginTop: 14, fontSize: 11, color: SUBDIM, display: 'flex', justifyContent: 'space-between' }}>
        <span>
          Lot fills detected from daily OHLC range (4:30 PM ET). Feast: RSI &gt; 85 (BL) / &lt; 15 (SS) → 50% exit Friday.
        </span>
        <span>
          Lot 3 fill → stop ratchets to breakeven · Lot 4 → Lot 2 fill · Lot 5 → Lot 3 fill
        </span>
      </div>
    </div>
  );
}
