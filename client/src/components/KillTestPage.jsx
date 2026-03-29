// client/src/components/KillTestPage.jsx
// ── PNTHR Kill Test — Forward Performance Tracker ─────────────────────────────
//
// Admin-only page tracking stocks that first qualify on the PNTHR Kill list:
//   Kill > 100 | Analyze > 80% | Composite > 75
//
// Simulates the full lot 1–5 pyramid (15/30/25/20/10%) using the same
// sizePosition() logic as PNTHR Command's Size It. Configurable NAV,
// risk %, portfolio cap, and sweep rate.

import { useState, useEffect, useMemo, useCallback } from 'react';
import { authHeaders, API_BASE } from '../services/api';

// ── Lot sizing constants (mirrors server killTestSettings.js) ─────────────────
const STRIKE_PCT = [0.15, 0.30, 0.25, 0.20, 0.10]; // cumul: 15, 45, 70, 90, 100%

// Client-side sizePosition (mirrors serverSizePosition)
function clientSizePosition(nav, entryPrice, stopPrice, riskPct = 1) {
  if (!entryPrice || !stopPrice || !nav || nav <= 0) return null;
  const rps = Math.abs(entryPrice - stopPrice);
  if (rps <= 0) return null;
  const vitality    = nav * (riskPct / 100);
  const tickerCap   = nav * 0.10;
  const totalShares = Math.floor(Math.min(Math.floor(vitality / rps), Math.floor(tickerCap / entryPrice)));
  if (totalShares <= 0) return null;
  return { totalShares, maxRiskDollar: +(totalShares * rps).toFixed(2) };
}

// Actual dollar risk for ONE appearance given current lot fills + current NAV.
// Uses firstStopPrice for sizing (original stop = conservative — ignores ratchets).
// filledPct = cumulative STRIKE_PCT of filled lots.
function computeActualRisk(rec, settings) {
  if (!settings || !rec.firstAppearancePrice || !rec.firstStopPrice) return null;
  const sized = clientSizePosition(
    settings.nav, rec.firstAppearancePrice, rec.firstStopPrice, settings.riskPctPerTrade
  );
  if (!sized) return null;

  // Sum STRIKE_PCT for each filled lot
  let filledPct = 0;
  const fills = rec.lotFills ?? { lot1: { filled: true } }; // default: Lot 1
  for (let i = 0; i < 5; i++) {
    if (fills[`lot${i + 1}`]?.filled) filledPct += STRIKE_PCT[i];
  }
  if (filledPct === 0) filledPct = STRIKE_PCT[0]; // safety: Lot 1 always entered

  const actualRiskDollar = +(filledPct * sized.maxRiskDollar).toFixed(2);
  const actualRiskPct    = +(actualRiskDollar / settings.nav * 100).toFixed(3);
  return { actualRiskDollar, actualRiskPct, maxRiskDollar: sized.maxRiskDollar, filledPct };
}

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
const fmtScore = (n) => n == null ? '—' : Number.isInteger(n) ? `${n}.0` : String(n);

function ScorePills({ kill, analyze, composite }) {
  const pill = (bg, color) => ({
    fontSize: 10, padding: '2px 0', borderRadius: 3, fontWeight: 700,
    background: bg, color,
    display: 'inline-block', textAlign: 'center',
  });
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'nowrap' }}>
      <span style={{ ...pill(`rgba(252,240,0,0.1)`, Y), minWidth: 52 }}>
        K:{fmtScore(kill)}
      </span>
      <span style={{ ...pill('rgba(40,167,69,0.1)', '#4fc870'), minWidth: 44 }}>
        A:{analyze ?? '—'}%
      </span>
      <span style={{ ...pill('rgba(0,150,255,0.1)', '#48b0ff'), minWidth: 44 }}>
        C:{fmtScore(composite)}
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
            title={filled ? `Lot ${n}: filled @ $${fill.fillPrice ?? '?'}${fill.fillDate ? ` on ${fill.fillDate}` : ''}` : `Lot ${n}: pending`}
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
function StatCard({ label, value, sub, color, dollar, barPct, barCap, barColor }) {
  const filled = barPct != null && barCap != null ? Math.min(barPct / barCap * 100, 100) : null;
  return (
    <div style={{
      background: BG3, border: `1px solid ${BORDER}`, borderRadius: 8,
      padding: '14px 18px', flex: '1 1 110px', minWidth: 110,
    }}>
      <div style={{ fontSize: 10, color: DIM, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: color || '#fff', lineHeight: 1.1 }}>{value ?? '—'}</div>
      {dollar != null && <div style={{ fontSize: 12, color: dollar > 0 ? '#4fc870' : dollar < 0 ? '#e06060' : DIM, marginTop: 2, fontWeight: 600 }}>{fmtDollar(dollar)}</div>}
      {filled != null && (
        <div style={{ marginTop: 6, height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ width: `${filled}%`, height: '100%', background: barColor || ORANGE, borderRadius: 2, transition: 'width 0.4s' }} />
        </div>
      )}
      {sub && <div style={{ fontSize: 11, color: '#555', marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

// ── Settings panel ────────────────────────────────────────────────────────────
function SettingsPanel({ settings, onSave, onCancel }) {
  const [vals, setVals] = useState({ ...settings });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

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
    setSaveError(null);
    try {
      await onSave(vals);
    } catch (err) {
      setSaveError(err.message || 'Save failed — check console');
    } finally {
      setSaving(false);
    }
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
      <div style={{ display: 'flex', gap: 10, marginTop: 18, alignItems: 'center', flexWrap: 'wrap' }}>
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
        {saveError && (
          <span style={{ fontSize: 12, color: RED, fontWeight: 600 }}>
            ✗ {saveError}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Active appearances table ───────────────────────────────────────────────────
function ActiveTable({ rows, settings }) {
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
            <TH align="right" style={{ cursor: 'help' }} title="Distance from entry to stop as % of entry price. Dollar risk is always 1% of NAV regardless of this value — wider stops = fewer shares.">Stop Dist. %</TH>
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
                  {(() => {
                    const risk = computeActualRisk(r, settings);
                    if (!risk) return null;
                    const pctColor = risk.actualRiskPct >= 0.8 ? ORANGE : '#4fc870';
                    return (
                      <div style={{ fontSize: 10, color: pctColor, marginTop: 2, fontWeight: 600 }}>
                        ${risk.actualRiskDollar.toFixed(0)} · {risk.actualRiskPct.toFixed(2)}% NAV
                      </div>
                    );
                  })()}
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

// ── SVG Equity & Drawdown Chart ───────────────────────────────────────────────
function EquityChart({ equityCurve, height = 180 }) {
  if (!equityCurve?.length) return null;
  const W = 100, H = height;
  const PAD = { t: 16, r: 8, b: 28, l: 48 };
  const cw = W - PAD.l - PAD.r;
  const ch = H - PAD.t - PAD.b;

  const vals  = equityCurve.map(p => p.value);
  const dds   = equityCurve.map(p => p.drawdown);
  const minV  = Math.min(...vals);
  const maxV  = Math.max(...vals);
  const range = maxV - minV || 1;

  const px = (i) => PAD.l + (i / (vals.length - 1 || 1)) * cw;
  const py = (v) => PAD.t + (1 - (v - minV) / range) * ch;

  // Equity line path
  const linePath = vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');

  // Drawdown fill (below 0% line = below peak)
  const peakY = py(equityCurve.find(p => p.drawdown === 0)?.value ?? maxV);
  const ddPath = vals.map((v, i) => {
    const isDD = dds[i] < 0;
    return `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${isDD ? py(v).toFixed(1) : peakY.toFixed(1)}`;
  }).join(' ') + ` L${px(vals.length - 1).toFixed(1)},${peakY.toFixed(1)} Z`;

  // Y axis ticks (3 labels)
  const yTicks = [minV, (minV + maxV) / 2, maxV].map(v => ({
    v, y: py(v), label: `$${(v / 1000).toFixed(0)}k`,
  }));

  // X axis: show up to 6 month labels
  const step = Math.ceil(equityCurve.length / 6);
  const xTicks = equityCurve
    .filter((_, i) => i % step === 0 || i === equityCurve.length - 1)
    .map((p, _, arr) => ({ label: p.month.slice(2), x: px(equityCurve.indexOf(p)) }));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
      style={{ width: '100%', height, display: 'block' }}>
      {/* Drawdown fill */}
      <path d={ddPath} fill="rgba(220,53,69,0.15)" />
      {/* Grid lines */}
      {yTicks.map(({ y }, i) => (
        <line key={i} x1={PAD.l} y1={y} x2={W - PAD.r} y2={y} stroke="rgba(255,255,255,0.06)" strokeWidth="0.3" />
      ))}
      {/* Peak line */}
      <line x1={PAD.l} y1={peakY} x2={W - PAD.r} y2={peakY} stroke="rgba(255,255,255,0.15)" strokeWidth="0.4" strokeDasharray="1,1" />
      {/* Equity line */}
      <path d={linePath} fill="none" stroke="#fcf000" strokeWidth="0.8" />
      {/* Y labels */}
      {yTicks.map(({ y, label }, i) => (
        <text key={i} x={PAD.l - 2} y={y + 1} textAnchor="end" fontSize="3.5" fill="#555">{label}</text>
      ))}
      {/* X labels */}
      {xTicks.map(({ label, x }, i) => (
        <text key={i} x={x} y={H - 4} textAnchor="middle" fontSize="3.2" fill="#555">{label}</text>
      ))}
    </svg>
  );
}

// ── Metric card (analytics) ───────────────────────────────────────────────────
function MetricCard({ label, value, sub, color, tooltip, wide }) {
  const [tip, setTip] = useState(false);
  return (
    <div
      style={{
        background: BG3, border: `1px solid ${BORDER}`, borderRadius: 8,
        padding: '14px 18px', flex: wide ? '2 1 220px' : '1 1 140px', minWidth: wide ? 200 : 130,
        position: 'relative',
      }}
      onMouseEnter={() => tooltip && setTip(true)}
      onMouseLeave={() => setTip(false)}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
        <span style={{ fontSize: 10, color: DIM, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</span>
        {tooltip && <span style={{ fontSize: 9, color: '#555', cursor: 'help' }}>ⓘ</span>}
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: color || '#fff', lineHeight: 1.1 }}>{value ?? '—'}</div>
      {sub && <div style={{ fontSize: 11, color: '#555', marginTop: 3 }}>{sub}</div>}
      {tip && tooltip && (
        <div style={{
          position: 'absolute', bottom: '110%', left: 0, background: '#1e1e1e',
          border: `1px solid ${BORDER2}`, borderRadius: 6, padding: '8px 12px',
          fontSize: 11, color: TEXT, zIndex: 50, width: 220, lineHeight: 1.5,
          boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
        }}>{tooltip}</div>
      )}
    </div>
  );
}

// ── Drawdown metric row ───────────────────────────────────────────────────────
function DDRow({ label, value, tooltip }) {
  const [tip, setTip] = useState(false);
  const color = value == null ? DIM : value < -10 ? RED : value < -5 ? ORANGE : value < 0 ? '#ffcc44' : GREEN;
  return (
    <div
      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: `1px solid ${SUBDIM}` }}
      onMouseEnter={() => tooltip && setTip(true)}
      onMouseLeave={() => setTip(false)}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, position: 'relative' }}>
        <span style={{ fontSize: 13, color: TEXT }}>{label}</span>
        {tooltip && <span style={{ fontSize: 9, color: '#555', cursor: 'help' }}>ⓘ</span>}
        {tip && (
          <div style={{
            position: 'absolute', top: '100%', left: 0, background: '#1e1e1e',
            border: `1px solid ${BORDER2}`, borderRadius: 6, padding: '8px 12px',
            fontSize: 11, color: TEXT, zIndex: 50, width: 240, lineHeight: 1.5,
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
          }}>{tooltip}</div>
        )}
      </div>
      <span style={{ fontSize: 14, fontWeight: 700, color }}>{value != null ? `${value.toFixed(2)}%` : '—'}</span>
    </div>
  );
}

// ── Portfolio Analytics Tab ───────────────────────────────────────────────────
function AnalyticsTab({ metrics, monthly, settings, onGenerate, generating }) {
  const hasData = metrics?.status === 'OK' && metrics.monthsAvailable >= 2;
  const n       = metrics?.monthsAvailable ?? 0;

  const retColor = (v) => v == null ? '#fff' : v > 0 ? GREEN : v < 0 ? RED : '#fff';
  const ratioColor = (v) => v == null ? '#fff' : v >= 2 ? GREEN : v >= 1 ? '#4fc870' : v >= 0 ? ORANGE : RED;
  const ddColor  = (v) => v == null ? '#fff' : v < -15 ? RED : v < -5 ? ORANGE : v < 0 ? '#ffcc44' : GREEN;

  if (!hasData) {
    return (
      <div style={{ padding: 32 }}>
        {/* Status banner */}
        <div style={{ background: '#1a1100', border: `1px solid rgba(252,240,0,0.2)`, borderRadius: 8, padding: '16px 20px', marginBottom: 24 }}>
          <div style={{ color: Y, fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
            {n === 0 ? 'No monthly data yet' : `${n} month${n === 1 ? '' : 's'} of data — need at least 2 for metrics`}
          </div>
          <div style={{ color: DIM, fontSize: 12, lineHeight: 1.6 }}>
            The Portfolio Analytics tab requires monthly equity snapshots. Generate the first snapshot now to start tracking.
            Metrics like Sharpe, Sortino, and Calmar become meaningful after 6+ months of data.
          </div>
        </div>

        {/* Monthly history table (even with 1 month) */}
        {monthly.length > 0 && <MonthlyTable rows={monthly} settings={settings} />}

        <button
          onClick={onGenerate}
          disabled={generating}
          style={{
            marginTop: 20, background: Y, color: '#000', fontWeight: 800, fontSize: 12,
            border: 'none', borderRadius: 6, padding: '10px 24px',
            cursor: generating ? 'default' : 'pointer', letterSpacing: '0.05em',
          }}
        >
          {generating ? 'Generating…' : '⚡ GENERATE SNAPSHOT NOW'}
        </button>
      </div>
    );
  }

  const ec = metrics.equityCurve ?? [];

  return (
    <div style={{ padding: '24px 28px' }}>

      {/* ── Equity curve ──────────────────────────────────────────────── */}
      <div style={{ background: '#111', border: `1px solid ${BORDER}`, borderRadius: 10, padding: '16px 20px', marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
          <div>
            <span style={{ color: Y, fontWeight: 800, fontSize: 14, letterSpacing: '0.03em' }}>PORTFOLIO EQUITY CURVE</span>
            <span style={{ color: DIM, fontSize: 11, marginLeft: 10 }}>{n} months · starting NAV ${(settings?.nav ?? 100000).toLocaleString()}</span>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: retColor(metrics.totalReturnPct) }}>
              {metrics.totalReturnPct != null ? `${metrics.totalReturnPct >= 0 ? '+' : ''}${metrics.totalReturnPct.toFixed(2)}%` : '—'}
            </div>
            <div style={{ fontSize: 11, color: DIM }}>cumulative return</div>
          </div>
        </div>
        <EquityChart equityCurve={ec} height={180} />
        <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: 11, color: DIM }}>
          <span><span style={{ display: 'inline-block', width: 12, height: 2, background: Y, verticalAlign: 'middle', marginRight: 4 }} />Portfolio value</span>
          <span><span style={{ display: 'inline-block', width: 12, height: 6, background: 'rgba(220,53,69,0.25)', verticalAlign: 'middle', marginRight: 4 }} />Drawdown period</span>
          <span><span style={{ display: 'inline-block', width: 12, height: 1, background: 'rgba(255,255,255,0.2)', verticalAlign: 'middle', marginRight: 4, borderTop: '1px dashed #555' }} />Peak (all-time high)</span>
        </div>
      </div>

      {/* ── Top metrics row ───────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
        <MetricCard
          label="Sharpe Ratio"
          value={metrics.sharpe != null ? metrics.sharpe.toFixed(2) : '—'}
          sub={metrics.sharpe6M != null ? `6M: ${metrics.sharpe6M.toFixed(2)}` : `${n < 6 ? `(need 6M, have ${n})` : '—'}`}
          color={ratioColor(metrics.sharpe)}
          tooltip="Annualized excess return above 2-yr Treasury divided by return standard deviation. > 1.0 is good, > 2.0 is excellent."
        />
        <MetricCard
          label="Sortino Ratio"
          value={metrics.sortino != null ? metrics.sortino.toFixed(2) : '—'}
          sub={metrics.sortino6M != null ? `6M: ${metrics.sortino6M.toFixed(2)}` : `${n < 6 ? `(need 6M, have ${n})` : '—'}`}
          color={ratioColor(metrics.sortino)}
          tooltip="Like Sharpe but only penalizes downside volatility — only counts months below the risk-free hurdle rate."
        />
        <MetricCard
          label="Calmar Ratio"
          value={metrics.calmarAnnual != null ? metrics.calmarAnnual.toFixed(2) : '—'}
          sub={metrics.calmar6M != null ? `6M: ${metrics.calmar6M.toFixed(2)}` : '—'}
          color={ratioColor(metrics.calmarAnnual)}
          tooltip="Annualized return ÷ maximum drawdown. Measures return per unit of worst-case risk. > 1.0 is good."
        />
        <MetricCard
          label="Annualized Return"
          value={metrics.annualizedReturn != null ? `${metrics.annualizedReturn >= 0 ? '+' : ''}${metrics.annualizedReturn.toFixed(2)}%` : '—'}
          sub={metrics.return6M != null ? `6M: ${metrics.return6M >= 0 ? '+' : ''}${metrics.return6M.toFixed(2)}%` : '—'}
          color={retColor(metrics.annualizedReturn)}
          tooltip="Compound annual growth rate from inception. 6M shows last 6-month return."
        />
        <MetricCard
          label="Current Drawdown"
          value={metrics.currentDrawdown != null ? `${metrics.currentDrawdown.toFixed(2)}%` : '—'}
          sub={metrics.currentDrawdown === 0 ? 'At all-time high' : 'Below ATH'}
          color={ddColor(metrics.currentDrawdown)}
          tooltip="Current portfolio value vs its all-time high. 0% = at peak."
        />
        <MetricCard
          label="Pain Index"
          value={metrics.painIndex != null ? `${metrics.painIndex.toFixed(2)}%` : '—'}
          sub="avg abs drawdown"
          color={metrics.painIndex > 10 ? RED : metrics.painIndex > 5 ? ORANGE : GREEN}
          tooltip="Average of absolute drawdown values across all months — measures persistent pain vs isolated spikes. Lower is better."
        />
      </div>

      {/* ── Two-column: Drawdown details + Rolling ────────────────────── */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>

        {/* Left: drawdown breakdown */}
        <div style={{ flex: '1 1 280px', background: BG3, border: `1px solid ${BORDER}`, borderRadius: 8, padding: '16px 20px' }}>
          <div style={{ fontSize: 11, color: Y, fontWeight: 700, marginBottom: 14, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
            Drawdown Analysis
          </div>
          <DDRow label="Max Monthly Drawdown"  value={metrics.maxMonthlyDrawdown}
            tooltip="Largest single peak-to-trough decline in any one month." />
          <DDRow label="Average Drawdown"      value={metrics.avgDrawdown}
            tooltip="Mean drawdown in months where portfolio was below its prior peak." />
          <DDRow label="Current Drawdown"      value={metrics.currentDrawdown}
            tooltip="How far below the all-time high the portfolio is right now." />
          <DDRow label="CDaR 95%"              value={metrics.cdar95}
            tooltip="Conditional Drawdown at Risk — average of the worst 5% of monthly drawdowns. Tail risk measure." />
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${SUBDIM}` }}>
            <span style={{ fontSize: 13, color: TEXT }}>Drawdown Frequency</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: metrics.drawdownFrequency > 50 ? ORANGE : '#aaa' }}>
              {metrics.drawdownFrequency != null ? `${metrics.drawdownFrequency.toFixed(0)}%` : '—'} <span style={{ fontSize: 11, color: DIM }}>of months</span>
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
            <span style={{ fontSize: 13, color: TEXT }}>Avg DD Duration</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: metrics.avgDrawdownDurationMonths > 3 ? ORANGE : '#aaa' }}>
              {metrics.avgDrawdownDurationMonths != null ? `${metrics.avgDrawdownDurationMonths} mo` : '—'}
            </span>
          </div>
        </div>

        {/* Right: rolling drawdowns + monthly history */}
        <div style={{ flex: '1 1 280px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ background: BG3, border: `1px solid ${BORDER}`, borderRadius: 8, padding: '16px 20px' }}>
            <div style={{ fontSize: 11, color: Y, fontWeight: 700, marginBottom: 14, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
              Rolling Drawdowns
            </div>
            {[
              { label: '1-Month',  val: metrics.rolling1M,  min: 1 },
              { label: '3-Month',  val: metrics.rolling3M,  min: 3 },
              { label: '6-Month',  val: metrics.rolling6M,  min: 6 },
              { label: '12-Month', val: metrics.rolling12M, min: 12 },
            ].map(({ label, val, min }) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: `1px solid ${SUBDIM}` }}>
                <span style={{ fontSize: 13, color: TEXT }}>{label}</span>
                {n < min
                  ? <span style={{ fontSize: 11, color: SUBDIM }}>need {min}M data</span>
                  : <span style={{ fontSize: 14, fontWeight: 700, color: ddColor(val) }}>{val != null ? `${val.toFixed(2)}%` : '—'}</span>
                }
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Peak-to-Valley Attribution ────────────────────────────────── */}
      {metrics.peakToValley && (
        <div style={{ background: BG3, border: `1px solid rgba(220,53,69,0.2)`, borderRadius: 8, padding: '16px 20px', marginBottom: 20 }}>
          <div style={{ fontSize: 11, color: RED, fontWeight: 700, marginBottom: 10, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
            Worst Drawdown — Peak to Valley Attribution
          </div>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 12 }}>
            <div><div style={{ fontSize: 10, color: DIM }}>Peak Month</div><div style={{ fontWeight: 700, color: TEXT }}>{metrics.peakToValley.peakMonth}</div></div>
            <div><div style={{ fontSize: 10, color: DIM }}>Trough Month</div><div style={{ fontWeight: 700, color: TEXT }}>{metrics.peakToValley.troughMonth}</div></div>
            <div><div style={{ fontSize: 10, color: DIM }}>Peak Value</div><div style={{ fontWeight: 700, color: TEXT }}>${metrics.peakToValley.peakValue?.toLocaleString()}</div></div>
            <div><div style={{ fontSize: 10, color: DIM }}>Trough Value</div><div style={{ fontWeight: 700, color: RED }}>${metrics.peakToValley.troughValue?.toLocaleString()}</div></div>
            <div><div style={{ fontSize: 10, color: DIM }}>Drawdown</div><div style={{ fontWeight: 800, color: RED }}>{metrics.peakToValley.drawdownPct?.toFixed(2)}%</div></div>
            <div><div style={{ fontSize: 10, color: DIM }}>Duration</div><div style={{ fontWeight: 700, color: ORANGE }}>{metrics.peakToValley.durationMonths} mo</div></div>
          </div>
          <div style={{ fontSize: 11, color: DIM, marginBottom: 6 }}>Stocks open during this period:</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {(metrics.peakToValley.tickersOpen || []).map(t => (
              <span key={t} style={{ background: 'rgba(220,53,69,0.1)', color: '#e06060', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4 }}>{t}</span>
            ))}
          </div>
        </div>
      )}

      {/* ── Monthly history table ─────────────────────────────────────── */}
      <MonthlyTable rows={monthly} settings={settings} />

      {/* ── Regenerate button ─────────────────────────────────────────── */}
      <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={onGenerate}
          disabled={generating}
          style={{
            background: 'transparent', color: DIM, fontWeight: 600, fontSize: 11,
            border: `1px solid ${BORDER}`, borderRadius: 6, padding: '6px 16px',
            cursor: generating ? 'default' : 'pointer', fontFamily: 'inherit',
          }}
        >
          {generating ? 'Regenerating…' : '↻ Regenerate Snapshot'}
        </button>
      </div>
    </div>
  );
}

// ── Monthly history table ─────────────────────────────────────────────────────
function MonthlyTable({ rows, settings }) {
  if (!rows.length) return null;
  const nav = settings?.nav ?? 100000;
  return (
    <div style={{ background: BG3, border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ fontSize: 11, color: Y, fontWeight: 700, padding: '14px 18px 10px', letterSpacing: '0.05em', textTransform: 'uppercase', borderBottom: `1px solid ${BORDER}` }}>
        Monthly Performance History
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <TH>Month</TH>
              <TH align="right">Portfolio Value</TH>
              <TH align="right">Monthly Return</TH>
              <TH align="right">Cumulative</TH>
              <TH align="right">Unrealized P&L</TH>
              <TH align="right">Realized P&L</TH>
              <TH align="right">Idle Cash</TH>
              <TH align="right">Sweep Interest</TH>
              <TH align="center">Open Pos.</TH>
            </tr>
          </thead>
          <tbody>
            {[...rows].reverse().map((r, i) => {
              const retC = r.monthlyReturn > 0 ? GREEN : r.monthlyReturn < 0 ? RED : '#aaa';
              const cumC = r.cumulativeReturn > 0 ? GREEN : r.cumulativeReturn < 0 ? RED : '#aaa';
              return (
                <tr key={r.month} style={{ background: i % 2 === 1 ? ROW_ALT : 'transparent' }}>
                  <TD style={{ fontWeight: 700, color: Y }}>{r.month}</TD>
                  <TD align="right" style={{ fontWeight: 700, color: '#fff' }}>${r.portfolioValue?.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</TD>
                  <TD align="right">
                    <span style={{ color: retC, fontWeight: 700 }}>
                      {r.monthlyReturn >= 0 ? '+' : ''}{r.monthlyReturn?.toFixed(2)}%
                    </span>
                  </TD>
                  <TD align="right">
                    <span style={{ color: cumC, fontWeight: 600 }}>
                      {r.cumulativeReturn >= 0 ? '+' : ''}{r.cumulativeReturn?.toFixed(2)}%
                    </span>
                  </TD>
                  <TD align="right" style={{ color: r.unrealizedPnl >= 0 ? '#4fc870' : '#e06060' }}>
                    {r.unrealizedPnl != null ? `${r.unrealizedPnl >= 0 ? '+' : ''}$${Math.abs(r.unrealizedPnl).toFixed(0)}` : '—'}
                  </TD>
                  <TD align="right" style={{ color: r.realizedThisMonth >= 0 ? '#4fc870' : '#e06060' }}>
                    {r.realizedThisMonth != null ? `${r.realizedThisMonth >= 0 ? '+' : ''}$${Math.abs(r.realizedThisMonth).toFixed(0)}` : '—'}
                  </TD>
                  <TD align="right" style={{ color: DIM }}>${r.idleCash?.toFixed(0) ?? '—'}</TD>
                  <TD align="right" style={{ color: '#4fc870', fontSize: 12 }}>+${r.sweepInterest?.toFixed(2) ?? '—'}</TD>
                  <TD align="center" style={{ color: DIM }}>{r.openPositions ?? '—'}</TD>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function KillTestPage() {
  const [data,          setData]          = useState([]);
  const [settings,      setSettings]      = useState(null);
  const [monthly,       setMonthly]       = useState([]);
  const [metrics,       setMetrics]       = useState(null);
  const [loading,       setLoading]       = useState(true);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [generating,    setGenerating]    = useState(false);
  const [error,         setError]         = useState(null);
  const [tab,           setTab]           = useState('active');
  const [showSettings,  setShowSettings]  = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [refreshing,    setRefreshing]    = useState(false);
  const [refreshedAt,   setRefreshedAt]   = useState(null);

  // Load appearances + settings on mount
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

  // Lazy-load analytics when tab is opened
  useEffect(() => {
    if (tab !== 'analytics' || monthly.length > 0) return;
    async function loadAnalytics() {
      try {
        setAnalyticsLoading(true);
        const [mRes, meRes] = await Promise.all([
          fetch(`${API_BASE}/api/kill-test/monthly`, { headers: authHeaders() }),
          fetch(`${API_BASE}/api/kill-test/metrics`, { headers: authHeaders() }),
        ]);
        if (mRes.ok)  setMonthly(await mRes.json());
        if (meRes.ok) setMetrics(await meRes.json());
      } catch { /* non-fatal */ }
      finally { setAnalyticsLoading(false); }
    }
    loadAnalytics();
  }, [tab]);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    try {
      const res = await fetch(`${API_BASE}/api/kill-test/monthly/generate`, {
        method: 'POST', headers: authHeaders(),
      });
      if (res.ok) {
        // Reload analytics data
        const [mRes, meRes] = await Promise.all([
          fetch(`${API_BASE}/api/kill-test/monthly`, { headers: authHeaders() }),
          fetch(`${API_BASE}/api/kill-test/metrics`, { headers: authHeaders() }),
        ]);
        if (mRes.ok)  setMonthly(await mRes.json());
        if (meRes.ok) setMetrics(await meRes.json());
      }
    } catch { /* non-fatal */ }
    finally { setGenerating(false); }
  }, []);

  const handleSaveSettings = async (vals) => {
    const res = await fetch(`${API_BASE}/api/kill-test/settings`, {
      method:  'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body:    JSON.stringify(vals),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); msg = j.error || msg; } catch {}
      throw new Error(msg);
    }
    const updated = await res.json();
    setSettings(updated);
    setShowSettings(false);
    setSettingsSaved(true);
    setTimeout(() => setSettingsSaved(false), 3000);
  };

  const handleRefreshPrices = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch(`${API_BASE}/api/kill-test/refresh-prices`, {
        method: 'POST', headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { prices, refreshedAt: ts } = await res.json();

      // Merge new prices + P&L into local data without a full reload
      setData(prev => prev.map(r => {
        const price = prices[r.ticker];
        if (price == null || r.exitDate) return r;
        const isShort   = r.signal === 'SS';
        const avgCost   = r.currentAvgCost ?? r.firstAppearancePrice;
        const shares    = r.currentShares  ?? 0;
        const pnlPct    = avgCost
          ? isShort ? ((avgCost - price) / avgCost) * 100
                    : ((price - avgCost) / avgCost) * 100
          : 0;
        const pnlDollar = isShort ? (avgCost - price) * shares : (price - avgCost) * shares;
        return {
          ...r,
          lastSeenPrice:    price,
          currentPnlPct:    +pnlPct.toFixed(2),
          currentPnlDollar: +pnlDollar.toFixed(2),
        };
      }));
      setRefreshedAt(ts ? new Date(ts) : new Date());
    } catch (err) {
      console.error('[refresh-prices]', err);
    } finally {
      setRefreshing(false);
    }
  }, []);

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

  // Portfolio heat — actual $ at risk based on current lot fills + current NAV
  // (separate memo so it updates when settings.nav changes)
  const portfolioHeat = useMemo(() => {
    if (!settings || !active.length) return null;
    let totalRisk = 0, counted = 0;
    for (const r of active) {
      const risk = computeActualRisk(r, settings);
      if (risk) { totalRisk += risk.actualRiskDollar; counted++; }
    }
    const heatPct = +(totalRisk / settings.nav * 100).toFixed(2);
    const cap     = settings.portfolioRiskCap ?? 10;
    return { dollar: +totalRisk.toFixed(2), pct: heatPct, cap, counted };
  }, [active, settings]);

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
          {/* Refresh prices button */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
            <button
              onClick={handleRefreshPrices}
              disabled={refreshing}
              style={{
                background: refreshing ? 'rgba(255,255,255,0.04)' : 'rgba(40,167,69,0.1)',
                border: `1px solid ${refreshing ? BORDER : 'rgba(40,167,69,0.35)'}`,
                borderRadius: 8, padding: '8px 14px', cursor: refreshing ? 'default' : 'pointer',
                color: refreshing ? DIM : '#4fc870', fontSize: 13, fontWeight: 700,
                fontFamily: 'inherit', transition: 'all 0.2s',
              }}
            >
              {refreshing ? '⟳ Refreshing…' : '↻ Refresh Prices'}
            </button>
            {refreshedAt && !refreshing && (
              <span style={{ fontSize: 10, color: SUBDIM }}>
                Updated {refreshedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' })}
              </span>
            )}
          </div>

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
          label="Avg Stop Dist."
          value={stats.avgRisk != null ? `${stats.avgRisk}%` : '—'}
          color={ORANGE}
          sub="entry→stop distance"
        />
        <StatCard
          label="Portfolio Heat"
          value={portfolioHeat != null ? `${portfolioHeat.pct}%` : '—'}
          sub={portfolioHeat != null
            ? `$${portfolioHeat.dollar.toLocaleString(undefined, { maximumFractionDigits: 0 })} actual at risk · cap ${portfolioHeat.cap}%`
            : 'actual $ at risk / NAV'
          }
          color={
            portfolioHeat == null ? '#fff'
            : portfolioHeat.pct >= portfolioHeat.cap * 0.9 ? RED
            : portfolioHeat.pct >= portfolioHeat.cap * 0.7 ? ORANGE
            : GREEN
          }
          barPct={portfolioHeat?.pct}
          barCap={portfolioHeat?.cap}
          barColor={
            portfolioHeat == null ? ORANGE
            : portfolioHeat.pct >= portfolioHeat.cap * 0.9 ? RED
            : portfolioHeat.pct >= portfolioHeat.cap * 0.7 ? ORANGE
            : GREEN
          }
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
        <button style={tabStyle('analytics')} onClick={() => setTab('analytics')}>
          Portfolio Analytics
        </button>
      </div>

      {/* ── Table / analytics area ──────────────────────────────────────── */}
      <div style={{
        background: BG3, border: `1px solid ${BORDER}`, borderTop: 'none',
        borderRadius: '0 0 10px 10px',
        padding: tab === 'analytics' ? 0 : '4px 0',
      }}>
        {tab === 'active' ? (
          <ActiveTable rows={active} settings={settings} />
        ) : tab === 'closed' ? (
          <ClosedTable rows={closed} />
        ) : analyticsLoading ? (
          <div style={{ padding: 48, textAlign: 'center', color: DIM, fontSize: 13 }}>Loading analytics…</div>
        ) : (
          <AnalyticsTab
            metrics={metrics}
            monthly={monthly}
            settings={settings}
            onGenerate={handleGenerate}
            generating={generating}
          />
        )}
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
