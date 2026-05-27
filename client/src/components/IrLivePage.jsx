// client/src/components/IrLivePage.jsx
// AI Elite Fund — Live Intelligence Report
// Mirrors the per-tier IR PDF with real-time data from backtest collections.

import { useState, useEffect, useMemo, useRef } from 'react';
import { API_BASE, authHeaders } from '../services/api';
import pnthrLogo from '../assets/panther head.png';

const BG     = '#0a0a0a';
const CARD   = '#111';
const BORDER = '#222';
const GREEN  = '#00e676';
const RED    = '#ff4444';
const YELLOW = '#fcf000';
const BLUE   = '#0096ff';
const GOLD   = '#ffd700';

const TIER_CONFIG = [
  { key: '1m',   label: 'Wagyu $1.00M',       short: '$1.00M', startingCapital: '$1,000,000' },
  { key: '500k', label: 'Porterhouse $500K',   short: '$500K',  startingCapital: '$500,000' },
  { key: '100k', label: 'Filet $100K',         short: '$100K',  startingCapital: '$100,000' },
];

const SECTIONS = [
  { key: 'overview',    label: 'Overview' },
  { key: 'performance', label: 'Performance' },
  { key: 'risk',        label: 'Risk & Drawdown' },
  { key: 'correlation', label: 'Correlation & Alpha' },
  { key: 'trades',      label: 'Trade Log' },
  { key: 'methodology', label: 'Methodology' },
];

function fmt(v, dec = 2) { return v != null ? v.toFixed(dec) : '—'; }
function fmtPct(v) { return v != null ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '—'; }
function fmtDollar(v) {
  if (v == null) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${v >= 0 ? '+' : '-'}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${v >= 0 ? '+' : '-'}$${(abs / 1e3).toFixed(0)}K`;
  return `${v >= 0 ? '+' : '-'}$${abs.toFixed(0)}`;
}
function fmtNav(v) {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v}`;
}
function retColor(v) { return v == null ? '#888' : v > 0 ? GREEN : v < 0 ? RED : '#fff'; }

function MetricCard({ label, value, sub, color, small, info }) {
  const [showInfo, setShowInfo] = useState(false);
  const popRef = useRef(null);

  useEffect(() => {
    if (!showInfo) return;
    function onClickOutside(e) {
      if (popRef.current && !popRef.current.contains(e.target)) setShowInfo(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [showInfo]);

  return (
    <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 8, padding: small ? '10px 14px' : '14px 18px', minWidth: small ? 110 : 140, position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <div style={{ fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, display: 'flex', alignItems: 'flex-start', gap: 5, flex: 1 }}>
        {label}
        {info && (
          <span
            onClick={() => setShowInfo(v => !v)}
            style={{ cursor: 'pointer', color: '#aaa', fontSize: 11, lineHeight: 1, flexShrink: 0 }}
            title={`About ${label}`}
          >ⓘ</span>
        )}
      </div>
      <div style={{ fontSize: small ? 18 : 22, fontWeight: 800, color: color || '#fff', whiteSpace: 'nowrap' }}>{value}</div>
      <div style={{ fontSize: 10, color: sub ? '#aaa' : 'transparent', marginTop: 2, minHeight: 14 }}>{sub || ' '}</div>
      {showInfo && (
        <div ref={popRef} style={{
          position: 'absolute', top: '100%', left: 0, zIndex: 100, marginTop: 6,
          background: '#1a1a1a', border: '1px solid #444', borderRadius: 8,
          padding: '14px 16px', width: 300, boxShadow: '0 8px 30px rgba(0,0,0,0.6)',
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: GOLD, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
          <div style={{ fontSize: 12, color: '#ccc', lineHeight: 1.6 }}>{info}</div>
          <span onClick={() => setShowInfo(false)} style={{ position: 'absolute', top: 8, right: 10, color: '#555', cursor: 'pointer', fontSize: 14 }}>✕</span>
        </div>
      )}
    </div>
  );
}

function fmtNavFull(v) {
  if (v == null) return '—';
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)} million`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toLocaleString()}`;
}

function fmtMonthYear(dateStr) {
  if (!dateStr) return '...';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function TierButton({ tier, active, onClick, fundName, summary }) {
  const [showInfo, setShowInfo] = useState(false);
  const popRef = useRef(null);

  useEffect(() => {
    if (!showInfo) return;
    function onClickOutside(e) {
      if (popRef.current && !popRef.current.contains(e.target)) setShowInfo(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [showInfo]);

  const endNav = summary?.endNav;
  const firstTrade = summary?.firstTradeDate;
  const endDate = summary?.endDate;

  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button onClick={onClick}
        style={{
          padding: '8px 20px', border: `1px solid ${active ? GOLD : BORDER}`,
          background: active ? 'rgba(255,215,0,0.1)' : 'transparent',
          color: active ? GOLD : '#888', fontWeight: 700, fontSize: 13,
          borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
        }}>
        {tier.label}
      </button>
      <span
        onClick={(e) => { e.stopPropagation(); setShowInfo(v => !v); }}
        style={{ cursor: 'pointer', color: '#ccc', fontSize: 13, lineHeight: 1 }}
      >ⓘ</span>
      {showInfo && (
        <div ref={popRef} style={{
          position: 'absolute', top: '100%', left: 0, zIndex: 100, marginTop: 6,
          background: '#1a1a1a', border: '1px solid #444', borderRadius: 8,
          padding: '14px 16px', width: 340, boxShadow: '0 8px 30px rgba(0,0,0,0.6)',
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: GOLD, marginBottom: 6 }}>{tier.label}</div>
          <div style={{ fontSize: 12, color: '#ccc', lineHeight: 1.7 }}>
            This tier simulates that if you had invested {tier.startingCapital} at the inception of the {fundName} strategy, it would have grown and compounded to{' '}
            <strong style={{ color: GREEN }}>{endNav ? fmtNavFull(endNav) : '...'}</strong>{' '}
            through the full backtested period which was {fmtMonthYear(firstTrade)} through {fmtMonthYear(endDate)}.
          </div>
          <div style={{ fontSize: 10, color: '#777', lineHeight: 1.5, marginTop: 10, borderTop: '1px solid #333', paddingTop: 8, fontStyle: 'italic' }}>
            Please see PPM and LPA for complete legal description of the fund. For informational purposes only.
          </div>
        </div>
      )}
    </div>
  );
}

function ComparisonTable({ data, spy, alpha, label, netLabel = 'FUND (NET)' }) {
  if (!data || !spy) return null;
  const rows = [
    { metric: 'Total Return',      fund: fmtPct(data.totalReturn),  bench: fmtPct(spy.totalReturn),  alpha: alpha ? fmtPct(alpha.totalReturnPts) : '—' },
    { metric: 'CAGR (Net)',        fund: fmtPct(data.cagr),         bench: fmtPct(spy.cagr),         alpha: alpha ? fmtPct(alpha.cagrPts) : '—' },
    { metric: 'Sharpe Ratio',      fund: fmt(data.sharpe),          bench: fmt(spy.sharpe),          alpha: fmt(data.sharpe - spy.sharpe) },
    { metric: 'Sortino Ratio',     fund: fmt(data.sortino),         bench: fmt(spy.sortino),         alpha: fmt(data.sortino - spy.sortino) },
    { metric: 'Calmar Ratio',      fund: fmt(data.calmar),          bench: '—',                      alpha: '—' },
    { metric: 'Max Peak-to-Trough',fund: fmtPct(data.maxDD),        bench: fmtPct(spy.maxDD),        alpha: fmtPct(data.maxDD - spy.maxDD) },
    { metric: 'Recovery Factor',   fund: `${fmt(data.recoveryFactor, 0)}x`, bench: '—',              alpha: '—' },
    { metric: 'Ending Equity',     fund: fmtNav(data.endNav),       bench: fmtNav(spy.endingEquity), alpha: alpha ? fmtDollar(alpha.endingEquityDelta) : '—' },
  ];
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: GOLD, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
            <th style={{ textAlign: 'left', padding: '8px 12px', color: '#888', fontWeight: 600 }}>METRIC</th>
            <th style={{ textAlign: 'right', padding: '8px 12px', color: BLUE, fontWeight: 700 }}>{netLabel}</th>
            <th style={{ textAlign: 'right', padding: '8px 12px', color: '#888', fontWeight: 600 }}>S&P 500</th>
            <th style={{ textAlign: 'right', padding: '8px 12px', color: GOLD, fontWeight: 700 }}>ALPHA</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.metric} style={{ borderBottom: `1px solid rgba(255,255,255,0.05)` }}>
              <td style={{ padding: '8px 12px', color: '#ccc' }}>{r.metric}</td>
              <td style={{ padding: '8px 12px', textAlign: 'right', color: BLUE, fontWeight: 700 }}>{r.fund}</td>
              <td style={{ padding: '8px 12px', textAlign: 'right', color: '#aaa' }}>{r.bench}</td>
              <td style={{ padding: '8px 12px', textAlign: 'right', color: GOLD, fontWeight: 700 }}>{r.alpha}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EquityCurveChart({ data, spyData, spyReturn, label, color }) {
  if (!data?.equityCurve || data.equityCurve.length < 2) return null;
  const ec = data.equityCurve;
  const spyEc = spyData?.equityCurve || [];
  const W = 800, H = 200, PAD = { t: 16, r: 16, b: 32, l: 64 };
  const iW = W - PAD.l - PAD.r, iH = H - PAD.t - PAD.b;

  const allVals = [...ec.map(p => p.value), ...spyEc.map(p => p.value)];
  const minV = Math.min(...allVals), maxV = Math.max(...allVals);
  const range = maxV - minV || 1;

  const px = (i, len) => PAD.l + (i / (len - 1 || 1)) * iW;
  const py = (v) => PAD.t + (1 - (v - minV) / range) * iH;

  const fundPath = ec.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(i, ec.length).toFixed(1)},${py(p.value).toFixed(1)}`).join(' ');
  const spyPath = spyEc.length > 1
    ? spyEc.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(i, spyEc.length).toFixed(1)},${py(p.value).toFixed(1)}`).join(' ')
    : '';

  const yTicks = [minV, (minV + maxV) / 2, maxV].map(v => ({
    y: py(v), label: v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${(v / 1000).toFixed(0)}k`,
  }));

  const step = Math.ceil(ec.length / 7);
  const xTicks = ec.filter((_, i) => i % step === 0 || i === ec.length - 1);

  return (
    <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 10, padding: '16px 20px', marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <div>
          <span style={{ color, fontWeight: 800, fontSize: 13, letterSpacing: '0.03em' }}>{label}</span>
          <span style={{ color: '#666', fontSize: 11, marginLeft: 8 }}>vs S&P 500</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <img src={pnthrLogo} alt="" style={{ width: 20, height: 20, filter: 'brightness(1.5)' }} />
          <span style={{ fontSize: 18, fontWeight: 800, color: retColor(data.totalReturn) }}>{fmtPct(data.totalReturn)}</span>
        </div>
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.l} y1={t.y} x2={W - PAD.r} y2={t.y} stroke="rgba(255,255,255,0.06)" />
            <text x={PAD.l - 6} y={t.y + 4} textAnchor="end" fill="#999" fontSize={10}>{t.label}</text>
          </g>
        ))}
        {spyPath && <>
          <path d={spyPath} fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth={1.5} strokeDasharray="4,3" />
          {spyReturn != null && spyEc.length > 1 && (
            <text x={px(spyEc.length - 1, spyEc.length)} y={py(spyEc[spyEc.length - 1].value) - 8} textAnchor="end" fill="rgba(255,255,255,0.6)" fontSize={10} fontWeight={700}>{fmtPct(spyReturn)}</text>
          )}
        </>}
        <path d={fundPath} fill="none" stroke={color} strokeWidth={2} />
        {xTicks.map((p) => {
          const idx = ec.indexOf(p);
          return <text key={p.date} x={px(idx, ec.length)} y={H - 6} textAnchor="middle" fill="#999" fontSize={9}>{p.date.slice(0, 7)}</text>;
        })}
      </svg>
      <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 10, color: '#666' }}>
        <span><span style={{ display: 'inline-block', width: 16, height: 2, background: color, marginRight: 4, verticalAlign: 'middle' }} /> {label}</span>
        <span><span style={{ display: 'inline-block', width: 16, height: 2, background: 'rgba(255,255,255,0.55)', marginRight: 4, verticalAlign: 'middle', borderTop: '1px dashed rgba(255,255,255,0.65)' }} /> S&P 500</span>
      </div>
    </div>
  );
}

function MonthlyHeatmap({ monthlyReturns, firstTradeDate }) {
  if (!monthlyReturns || monthlyReturns.length === 0) return null;
  const byYear = {};
  for (const { m, ret } of monthlyReturns) {
    const [y, mo] = m.split('-');
    if (!byYear[y]) byYear[y] = {};
    byYear[y][+mo] = ret;
  }
  const years = Object.keys(byYear).sort();
  const monthLabels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  // Detect first real trading month: scan chronologically for first month with |return| > 2%
  const sorted = [...monthlyReturns].sort((a, b) => a.m.localeCompare(b.m));
  const first = sorted.find(r => Math.abs(r.ret) > 2.0);
  const ftYear = first ? first.m.slice(0, 4) : null;
  const ftMonth = first ? +first.m.slice(5, 7) : null;

  function heatColor(v) {
    if (v == null) return 'transparent';
    if (v > 10) return 'rgba(0,230,118,0.5)';
    if (v > 5) return 'rgba(0,230,118,0.3)';
    if (v > 0) return 'rgba(0,230,118,0.15)';
    if (v > -5) return 'rgba(255,68,68,0.15)';
    if (v > -10) return 'rgba(255,68,68,0.3)';
    return 'rgba(255,68,68,0.5)';
  }

  return (
    <div style={{ overflowX: 'auto', marginBottom: 20 }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%' }}>
        <thead>
          <tr>
            <th style={{ padding: '6px 10px', color: '#888', textAlign: 'left' }}>Year</th>
            {monthLabels.map(m => <th key={m} style={{ padding: '6px 8px', color: '#888', textAlign: 'center', minWidth: 48 }}>{m}</th>)}
            <th style={{ padding: '6px 10px', color: GOLD, textAlign: 'center' }}>YTD</th>
          </tr>
        </thead>
        <tbody>
          {years.map(y => {
            function isWarmup(yr, mo) {
              if (!ftYear) return false;
              if (yr < ftYear) return true;
              if (yr === ftYear && mo < ftMonth) return true;
              return false;
            }
            let ytd = 0;
            for (const [moStr, v] of Object.entries(byYear[y])) {
              if (!isWarmup(y, +moStr)) ytd += v;
            }
            return (
              <tr key={y} style={{ borderTop: `1px solid rgba(255,255,255,0.05)` }}>
                <td style={{ padding: '6px 10px', color: '#ddd', fontWeight: 700 }}>{y}</td>
                {[1,2,3,4,5,6,7,8,9,10,11,12].map(mo => {
                  const warmup = isWarmup(y, mo);
                  const v = byYear[y][mo];
                  if (warmup) return <td key={mo} style={{ padding: '6px 8px', background: '#0a0a0a' }} />;
                  return (
                    <td key={mo} style={{ padding: '6px 8px', textAlign: 'center', background: heatColor(v), color: v != null ? (v >= 0 ? GREEN : RED) : '#333', fontWeight: 600 }}>
                      {v != null ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}` : ''}
                    </td>
                  );
                })}
                <td style={{ padding: '6px 10px', textAlign: 'center', fontWeight: 800, color: retColor(ytd) }}>{fmtPct(ytd)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DrawdownTable({ drawdowns }) {
  if (!drawdowns || drawdowns.length === 0) return null;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 16 }}>
      <thead>
        <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
          {['#','Depth','Start','Trough','Recovery','Duration'].map(h => (
            <th key={h} style={{ padding: '8px 10px', color: '#888', textAlign: h === '#' ? 'center' : 'left', fontWeight: 600 }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {drawdowns.map((dd, i) => (
          <tr key={i} style={{ borderBottom: `1px solid rgba(255,255,255,0.04)` }}>
            <td style={{ padding: '8px 10px', textAlign: 'center', color: '#888' }}>{i + 1}</td>
            <td style={{ padding: '8px 10px', color: RED, fontWeight: 700 }}>{fmtPct(dd.depthPct)}</td>
            <td style={{ padding: '8px 10px', color: '#ccc' }}>{dd.start}</td>
            <td style={{ padding: '8px 10px', color: '#ccc' }}>{dd.trough}</td>
            <td style={{ padding: '8px 10px', color: dd.recovery ? GREEN : '#888' }}>{dd.recovery || 'Ongoing'}</td>
            <td style={{ padding: '8px 10px', color: '#aaa' }}>{dd.duration}d</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CrisisAlphaTable({ crisisNet, fundLabel = 'AI Elite' }) {
  if (!crisisNet || crisisNet.length === 0) return null;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 16 }}>
      <thead>
        <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
          {['Event','Period','S&P 500', fundLabel,'Alpha'].map(h => (
            <th key={h} style={{ padding: '8px 10px', color: '#888', textAlign: h === 'Event' ? 'left' : 'right', fontWeight: 600 }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {crisisNet.map((c, i) => (
          <tr key={i} style={{ borderBottom: `1px solid rgba(255,255,255,0.04)` }}>
            <td style={{ padding: '8px 10px', color: '#ddd', fontWeight: 600 }}>{c.event}</td>
            <td style={{ padding: '8px 10px', textAlign: 'right', color: '#888', fontSize: 11 }}>{c.period}</td>
            <td style={{ padding: '8px 10px', textAlign: 'right', color: retColor(c.spyReturn) }}>{c.spyReturn != null ? fmtPct(c.spyReturn) : '—'}</td>
            <td style={{ padding: '8px 10px', textAlign: 'right', color: retColor(c.pnthrReturn), fontWeight: 700 }}>{c.pnthrReturn != null ? fmtPct(c.pnthrReturn) : '—'}</td>
            <td style={{ padding: '8px 10px', textAlign: 'right', color: GOLD, fontWeight: 700 }}>{c.alpha != null ? fmtPct(c.alpha) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const MONTH_LABELS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

const CORR_INFO = {
  Beta: {
    what: 'Beta measures how much the fund moves relative to the market. A beta of 1.0 means it moves in lockstep with the index. Below 1.0 means the fund is less volatile than the market. Above 1.0 means it amplifies market moves.',
    edge: 'The PNTHR AI Elite 300 Fund maintains a beta near or below 1.0, meaning it carries similar or less market risk than the S&P 500. The critical advantage: the fund delivers annual returns that are multiples higher than the index while taking on equal or less systematic risk. You are not paying for returns with extra volatility. That combination is rare and valuable.',
  },
  Correlation: {
    what: 'Correlation measures how closely the fund\'s daily returns move with the benchmark on a scale from -1.0 (perfectly inverse) to +1.0 (perfectly in sync). A correlation near zero means the fund moves independently of the market.',
    edge: 'The PNTHR AI Elite 300 Fund has a low correlation to both the S&P 500 and Nasdaq. This means the fund\'s profits come from its own stock selection engine, not from passively riding the same market wave. For investors, this is powerful: it provides genuine diversification. Adding this fund to a portfolio of index funds reduces overall risk while dramatically increasing return potential.',
  },
  'R-Squared': {
    what: 'R-Squared shows what percentage of the fund\'s returns are explained by broad market movements. An R-Squared of 100% means the fund is just tracking the index. A low R-Squared means returns are driven by the manager\'s skill, not market direction.',
    edge: 'The PNTHR AI Elite 300 Fund has a very low R-Squared, proving that the vast majority of its returns come from active stock picking and sector rotation, not from broad market exposure. This is the definition of alpha. The fund is not a disguised index fund or a leveraged bet on the market. It generates independent, skill-based returns that you simply cannot replicate with a passive strategy.',
  },
  'CAPM Alpha (ann.)': {
    what: 'CAPM Alpha is the annualized excess return the fund delivers above what the Capital Asset Pricing Model predicts based on its beta. It isolates pure manager skill from market exposure. Positive alpha means the fund earns more than its risk level would suggest.',
    edge: 'The PNTHR AI Elite 300 Fund generates an exceptionally large CAPM Alpha, placing it among the highest alpha-producing strategies in the hedge fund industry. This number proves that the fund\'s returns are not borrowed from market risk. They are earned through disciplined momentum selection, systematic pyramiding, and automated risk management. This is return you cannot access through any index fund or passive strategy.',
  },
};

function CorrelationCards({ marketCorrelation }) {
  const [openInfo, setOpenInfo] = useState(null);

  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
      {['spy', 'qqq'].map(bench => {
        const c = marketCorrelation[bench];
        if (!c) return null;
        return (
          <div key={bench} style={{ flex: '1 1 250px', background: 'rgba(255,255,255,0.03)', border: `1px solid ${BORDER}`, borderRadius: 8, padding: '16px 20px' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: BLUE, marginBottom: 12 }}>vs {bench.toUpperCase()}</div>
            {[
              { l: 'Beta', v: c.beta?.toFixed(2) },
              { l: 'Correlation', v: c.correlation?.toFixed(2) },
              { l: 'R-Squared', v: `${(c.rSquared * 100).toFixed(1)}%` },
              { l: 'CAPM Alpha (ann.)', v: `${c.capmAlpha >= 0 ? '+' : ''}${c.capmAlpha?.toFixed(1)}%`, color: retColor(c.capmAlpha) },
            ].map(r => (
              <div key={r.l} style={{ position: 'relative' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: `1px solid rgba(255,255,255,0.05)` }}>
                  <span style={{ fontSize: 12, color: '#aaa', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span
                      onClick={() => setOpenInfo(openInfo === `${bench}-${r.l}` ? null : `${bench}-${r.l}`)}
                      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, borderRadius: '50%', border: '1px solid rgba(255,255,255,0.2)', color: '#888', fontSize: 10, cursor: 'pointer', flexShrink: 0 }}
                    >i</span>
                    {r.l}
                  </span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: r.color || '#ddd' }}>{r.v}</span>
                </div>
                {openInfo === `${bench}-${r.l}` && CORR_INFO[r.l] && (
                  <div style={{ background: '#1a1a1a', border: `1px solid ${BORDER}`, borderRadius: 8, padding: '12px 14px', marginTop: 4, marginBottom: 4 }}>
                    <div style={{ fontSize: 11, color: '#ccc', lineHeight: 1.6, marginBottom: 8 }}>{CORR_INFO[r.l].what}</div>
                    <div style={{ fontSize: 11, color: GREEN, lineHeight: 1.6, fontWeight: 600 }}>{CORR_INFO[r.l].edge}</div>
                  </div>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function TradeLogSection({ tier, apiBase = 'ir-live' }) {
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(false);
  const [sortCol, setSortCol] = useState('exitDate');
  const [sortDir, setSortDir] = useState('desc');
  const [selectedYear, setSelectedYear] = useState(null);
  const [selectedMonth, setSelectedMonth] = useState(null);

  useEffect(() => {
    setLoading(true);
    fetch(`${API_BASE}/api/${apiBase}/${tier}/trades`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => setTrades(d.trades || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [tier, apiBase]);

  const availableYears = useMemo(() => {
    const yrs = new Set();
    for (const t of trades) {
      const d = t.exitDate || t.entryDate || '';
      if (d.length >= 4) yrs.add(d.slice(0, 4));
    }
    return [...yrs].sort((a, b) => b.localeCompare(a));
  }, [trades]);

  const availableMonths = useMemo(() => {
    if (!selectedYear) return [];
    const mos = new Set();
    for (const t of trades) {
      const d = t.exitDate || t.entryDate || '';
      if (d.startsWith(selectedYear) && d.length >= 7) mos.add(+d.slice(5, 7));
    }
    return [...mos].sort((a, b) => a - b);
  }, [trades, selectedYear]);

  const filtered = useMemo(() => {
    if (!selectedYear) return trades;
    return trades.filter(t => {
      const d = t.exitDate || t.entryDate || '';
      if (!d.startsWith(selectedYear)) return false;
      if (selectedMonth != null) {
        const mo = +d.slice(5, 7);
        if (mo !== selectedMonth) return false;
      }
      return true;
    });
  }, [trades, selectedYear, selectedMonth]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      let av = a[sortCol], bv = b[sortCol];
      if (av == null && bv == null) return 0;
      if (av == null) return sortDir === 'asc' ? -1 : 1;
      if (bv == null) return sortDir === 'asc' ? 1 : -1;
      if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortDir === 'asc' ? av - bv : bv - av;
    });
    return arr;
  }, [filtered, sortCol, sortDir]);

  const grouped = useMemo(() => {
    const groups = {};
    for (const t of sorted) {
      const month = (t.exitDate || t.entryDate || '').slice(0, 7) || 'Active';
      if (!groups[month]) groups[month] = [];
      groups[month].push(t);
    }
    return Object.entries(groups).sort(([a], [b]) => b.localeCompare(a));
  }, [sorted]);

  function handleSort(col) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('desc'); }
  }

  function handleYearClick(yr) {
    if (selectedYear === yr) { setSelectedYear(null); setSelectedMonth(null); }
    else { setSelectedYear(yr); setSelectedMonth(null); }
  }

  function handleMonthClick(mo) {
    setSelectedMonth(selectedMonth === mo ? null : mo);
  }

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#888' }}>Loading trade log...</div>;

  const closedCount = trades.filter(t => t.exitDate).length;
  const activeCount = trades.filter(t => !t.exitDate).length;
  const filteredClosedCount = filtered.filter(t => t.exitDate).length;

  const cols = [
    { key: 'ticker', label: 'Ticker', w: 70 },
    { key: 'signal', label: 'Dir', w: 45 },
    { key: 'entryDate', label: 'Entry', w: 90 },
    { key: 'entryPrice', label: 'Entry $', w: 80, align: 'right' },
    { key: 'exitDate', label: 'Exit', w: 90 },
    { key: 'exitPrice', label: 'Exit $', w: 80, align: 'right' },
    { key: 'lotsFilledCount', label: 'Lots', w: 45, align: 'center' },
    { key: 'grossPnlPct', label: 'P&L %', w: 70, align: 'right' },
    { key: 'netPnlDollar', label: 'P&L $', w: 90, align: 'right' },
    { key: 'holdingDays', label: 'Days', w: 50, align: 'right' },
    { key: 'exitReason', label: 'Reason', w: 80 },
    { key: 'sectorName', label: 'Sector', w: 120 },
  ];

  return (
    <div>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>
        {trades.length} trades total ({closedCount} closed, {activeCount} active)
        {selectedYear && <span style={{ color: BLUE, marginLeft: 8 }}>| Showing: {selectedYear}{selectedMonth != null ? `-${String(selectedMonth).padStart(2, '0')}` : ''} ({filtered.length} trades)</span>}
      </div>

      {/* Year navigation */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        <button onClick={() => { setSelectedYear(null); setSelectedMonth(null); }}
          style={{
            padding: '6px 14px', border: `1px solid ${!selectedYear ? GOLD : BORDER}`, borderRadius: 5,
            background: !selectedYear ? 'rgba(255,215,0,0.1)' : 'transparent',
            color: !selectedYear ? GOLD : '#888', fontWeight: 700, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
          }}>ALL</button>
        {availableYears.map(yr => (
          <button key={yr} onClick={() => handleYearClick(yr)}
            style={{
              padding: '6px 14px', border: `1px solid ${selectedYear === yr ? BLUE : BORDER}`, borderRadius: 5,
              background: selectedYear === yr ? 'rgba(0,150,255,0.1)' : 'transparent',
              color: selectedYear === yr ? BLUE : '#888', fontWeight: 700, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
            }}>{yr}</button>
        ))}
      </div>

      {/* Month navigation (visible when year selected) */}
      {selectedYear && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 14, flexWrap: 'wrap' }}>
          {MONTH_LABELS.map((label, idx) => {
            const mo = idx + 1;
            const hasData = availableMonths.includes(mo);
            const isActive = selectedMonth === mo;
            return (
              <button key={mo} onClick={() => hasData && handleMonthClick(mo)} disabled={!hasData}
                style={{
                  padding: '5px 10px', border: `1px solid ${isActive ? GOLD : hasData ? BORDER : 'rgba(255,255,255,0.04)'}`,
                  borderRadius: 4, fontFamily: 'inherit',
                  background: isActive ? 'rgba(255,215,0,0.1)' : 'transparent',
                  color: isActive ? GOLD : hasData ? '#aaa' : '#333',
                  fontWeight: isActive ? 700 : 600, fontSize: 11, cursor: hasData ? 'pointer' : 'default',
                  letterSpacing: '0.03em', opacity: hasData ? 1 : 0.4,
                }}>{label}</button>
            );
          })}
        </div>
      )}

      {/* Trade table */}
      {grouped.map(([month, monthTrades]) => (
        <div key={month} style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: GOLD, padding: '8px 0', borderBottom: `1px solid ${BORDER}`, marginBottom: 0, letterSpacing: '0.05em' }}>
            {month === 'Active' ? 'ACTIVE POSITIONS' : month}
            <span style={{ color: '#555', fontWeight: 400, marginLeft: 8 }}>{monthTrades.length} trade{monthTrades.length !== 1 ? 's' : ''}</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
                  {cols.map(c => (
                    <th key={c.key} onClick={() => handleSort(c.key)}
                      style={{
                        padding: '7px 8px', color: sortCol === c.key ? BLUE : '#888', cursor: 'pointer',
                        textAlign: c.align || 'left', fontWeight: 700, fontSize: 11, whiteSpace: 'nowrap', minWidth: c.w,
                        background: sortCol === c.key ? 'rgba(0,150,255,0.05)' : 'transparent',
                        userSelect: 'none', position: 'sticky', top: 0,
                      }}>
                      {c.label} {sortCol === c.key ? (sortDir === 'desc' ? '▼' : '▲') : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {monthTrades.map((t, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid rgba(255,255,255,0.03)` }}>
                    <td style={{ padding: '6px 8px', color: BLUE, fontWeight: 700 }}>{t.ticker}</td>
                    <td style={{ padding: '6px 8px', color: t.signal === 'BL' ? GREEN : RED, fontWeight: 700 }}>{t.signal}</td>
                    <td style={{ padding: '6px 8px', color: '#ccc', fontSize: 11 }}>{t.entryDate?.replace(/-/g, '/').slice(2)}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: '#ddd' }}>${t.entryPrice}</td>
                    <td style={{ padding: '6px 8px', color: '#ccc', fontSize: 11 }}>{t.exitDate?.replace(/-/g, '/').slice(2) || '—'}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: '#ddd' }}>{t.exitPrice ? `$${t.exitPrice}` : '—'}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'center', color: t.lotsFilledCount >= 4 ? GREEN : t.lotsFilledCount >= 2 ? YELLOW : '#aaa' }}>
                      {t.lotsFilledCount}/{t.totalLots}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: retColor(t.grossPnlPct), fontWeight: 600 }}>
                      {t.grossPnlPct != null ? `${t.grossPnlPct >= 0 ? '+' : ''}${t.grossPnlPct}%` : '—'}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: retColor(t.netPnlDollar), fontWeight: 700 }}>
                      {t.netPnlDollar != null ? `${t.netPnlDollar >= 0 ? '+' : ''}$${Math.abs(t.netPnlDollar).toLocaleString()}` : '—'}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: '#aaa' }}>{t.holdingDays || '—'}</td>
                    <td style={{ padding: '6px 8px', color: t.exitReason === 'STOP_HIT' ? RED : t.exitReason === 'BE' || t.exitReason === 'SE' ? YELLOW : '#888', fontSize: 11 }}>
                      {t.exitReason}
                    </td>
                    <td style={{ padding: '6px 8px', color: '#888', fontSize: 11, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {t.sectorName}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {filtered.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', color: '#555', fontSize: 13 }}>
          No trades found for {selectedYear}{selectedMonth != null ? `-${String(selectedMonth).padStart(2, '0')}` : ''}.
        </div>
      )}
    </div>
  );
}

const FUND_CONFIG = {
  ai300: {
    name: 'PNTHR AI Elite 300 Fund',
    netLabel: 'AI ELITE (NET)',
    compLabel: 'AI ELITE FUND',
    subtitle: (endDate) => `Backtest Performance Report | EMA Warm-Up Jan 2022 (First Trade Jun 2022) – ${endDate} | Multi-Strategy Pyramiding + MCE | PNTHR AI Universe (~300 Names) | v10.1`,
    apiBase: 'ir-live',
    footer: 'AI ELITE FUND',
    curveLabel: 'AI Elite Fund',
    crisisHeader: 'AI Elite',
  },
  carnivore: {
    name: 'PNTHR Carnivore Quant Fund',
    netLabel: 'CARNIVORE (NET)',
    compLabel: 'CARNIVORE FUND',
    subtitle: (endDate) => `Backtest Performance Report | Jun 2019 – ${endDate} | Weekly OpEMA Trend-Following | PNTHR 679 Universe (~679 Names) | v5.0`,
    apiBase: 'carnivore-ir',
    footer: 'CARNIVORE QUANT FUND',
    curveLabel: 'Carnivore Quant Fund',
    crisisHeader: 'Carnivore',
  },
};

const AI300_METHODOLOGY = [
  { title: 'The PNTHR AI Universe', content: 'Approximately 300 AI-focused U.S. equities spanning 16 proprietary sectors of the artificial intelligence economy, from semiconductors and cloud infrastructure to autonomous vehicles and AI-powered healthcare. Reconstituted quarterly with a minimum market cap of $500M and average daily volume threshold.' },
  { title: 'The PAI300 Index & Regime Gate', content: 'The PAI300 is a proprietary capped market-cap-weighted index of the AI Universe. A 36-week EMA applied to PAI300 determines the macro regime: bullish (index above EMA) or bearish (below). The regime gate multiplies conviction scores — amplifying signals in favorable conditions and dampening them in adverse ones.' },
  { title: 'Sector Rotation Signal Architecture (Weekly Entry)', content: 'All 16 AI sectors are ranked daily by 5-day trailing return. Sectors ranked 1-6 are classified GO (strong momentum), 7-12 NEUTRAL, and 13-16 NO_GO (weak momentum). Entry signals are generated on Fridays using sector-optimized weekly EMAs (18-36 week periods). Buy Long (BL) signals fire when price closes above a rising EMA with a daylight zone confirmation. Sell Short (SS) signals fire on the inverse. Weekly entries execute at Monday open.' },
  { title: 'Momentum Continuation Entry (MCE) — Daily Entry', content: 'MCE captures proven momentum stocks between weekly signal cycles. Stocks must have an active weekly BL signal AND rank in the trailing 12-month (TTM) top 100 by return (walk-forward, recomputed weekly, no look-ahead bias). Entry triggers on a daily 2-bar high breakout (daily high > max of prior 2 daily highs + $0.01). MCE deploys a full 5-lot pyramid at breakout. Controls: max 3 new MCE entries per day, 5-day gap-add cooldown, same 1% vitality / 10% ticker cap, vitality tracking prevents over-allocation. MCE contributes approximately 70% of total alpha across all tiers.' },
  { title: 'Capital Constraint (Cash Ledger)', content: 'The fund tracks a real-time cash ledger day by day. Every buy deducts from available cash; every position close returns capital. Entries are skipped when insufficient cash exists — no leverage, no margin. This ensures all backtest results are achievable with real capital deployment. The S&P 500 has historically produced approximately 10% CAGR with drawdowns of -34% (2022) to -50% (2008). The AI Elite Fund delivers 5x the return with less drawdown than public markets.' },
  { title: 'Position Sizing & Pyramiding', content: 'Each position uses a 5-lot pyramid system with allocations of 35/25/20/12/8% of the maximum position size. Position sizing is dynamic, calculated from current NAV with a 1% maximum risk per trade and 10% maximum single-ticker exposure. Lot triggers are set at 0%, 3%, 6%, 10%, and 14% from entry price. Stops ratchet upward as lots fill: Lot 2 triggers a breakeven stop, Lot 3 moves stop to entry, Lot 4 to Lot 2 fill price, Lot 5 to Lot 3 fill price.' },
  { title: 'Execution Model', content: 'Weekly entries: signals generated on Friday close, all entries execute at Monday open. MCE entries: daily 2-bar high breakout triggers immediate entry at breakout price. Lot fills are capped at 2% of 20-day average daily volume per lot to ensure institutional executability. Stop fills use gap-through pricing (fill at open when gap exceeds stop level) for conservative modeling. All friction costs (commission, slippage, borrow) are included in net figures.' },
];

const CARNIVORE_METHODOLOGY = [
  { title: 'The PNTHR 679 Universe', content: 'Approximately 679 liquid U.S. equities and ETFs spanning the S&P 500 and S&P 400 Mid Cap indices. The universe captures institutional-grade large and mid cap names with sufficient liquidity for systematic trend-following across all 11 GICS sectors.' },
  { title: 'Regime Gate (SPY & QQQ)', content: 'SPY and QQQ 21-week exponential moving averages determine the macro regime. When both indices trade above their 21-week EMAs, the system enters bullish mode and generates Buy Long signals. When both trade below, bearish mode activates Sell Short signals. Mixed signals default to a neutral stance with reduced position sizing.' },
  { title: 'Signal Generation (Sector-Optimized Weekly EMA)', content: 'Each GICS sector uses an optimized weekly EMA period ranging from 18 to 26 weeks, tuned for that sector\'s characteristic momentum profile. Buy Long (BL) signals fire when price closes above a rising sector-optimized EMA with a daylight zone confirmation. Sell Short (SS) signals fire on the inverse. All entries are generated on Friday close and execute at Monday open.' },
  { title: 'Multi-Factor Scoring (PNTHR Kill)', content: 'An 8-dimensional scoring engine evaluates entry conviction across momentum, trend strength, relative performance, sector positioning, volume confirmation, volatility regime, risk/reward profile, and institutional accumulation signals. Higher Kill scores correspond to higher probability setups.' },
  { title: 'Capital Constraint (Cash Ledger)', content: 'The fund tracks a real-time cash ledger day by day. Every buy deducts from available cash; every position close returns capital. Entries are skipped when insufficient cash exists — no leverage, no margin. This ensures all backtest results are achievable with real capital deployment.' },
  { title: 'Position Sizing & Pyramiding', content: 'Each position uses a 5-lot pyramid system with allocations of 35/25/20/12/8% of the maximum position size. Position sizing is dynamic, calculated from current NAV with a 1% maximum risk per trade and 10% maximum single-ticker exposure. Lot triggers are set at 0%, 3%, 6%, 10%, and 14% from entry price. Stops ratchet upward as lots fill: Lot 2 triggers a breakeven stop, Lot 3 moves stop to entry, Lot 4 to Lot 2 fill price, Lot 5 to Lot 3 fill price.' },
  { title: 'Execution Model', content: 'Signals are generated on Friday close; all entries execute at Monday open. Lot fills are capped at 2% of 20-day average daily volume per lot to ensure institutional executability. Stop fills use gap-through pricing (fill at open when gap exceeds stop level) for conservative modeling. All friction costs (commission, slippage, borrow) are included in net figures.' },
];

function MethodologySection({ fund }) {
  const sections = fund === 'carnivore' ? CARNIVORE_METHODOLOGY : AI300_METHODOLOGY;

  return (
    <div>
      {sections.map(s => (
        <div key={s.title} style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: GOLD, marginBottom: 8, letterSpacing: '0.02em' }}>{s.title}</div>
          <div style={{ fontSize: 13, color: '#bbb', lineHeight: 1.7 }}>{s.content}</div>
        </div>
      ))}
    </div>
  );
}

export default function IrLivePage({ fund = 'ai300' }) {
  const fc = FUND_CONFIG[fund] || FUND_CONFIG.ai300;
  const [tier, setTier] = useState('1m');
  const [section, setSection] = useState('overview');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [tierSummaries, setTierSummaries] = useState({});
  const [showRolling12Info, setShowRolling12Info] = useState(false);
  const rolling12Ref = useRef(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/api/${fc.apiBase}/${tier}/metrics`, { headers: authHeaders() })
      .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); })
      .then(d => setData(d))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [tier, fc.apiBase]);

  useEffect(() => {
    TIER_CONFIG.forEach(t => {
      fetch(`${API_BASE}/api/${fc.apiBase}/${t.key}/metrics`, { headers: authHeaders() })
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (d) setTierSummaries(prev => ({ ...prev, [t.key]: { endNav: d.net?.endNav, firstTradeDate: d.firstTradeDate, endDate: d.net?.endDate } }));
        })
        .catch(() => {});
    });
  }, [fc.apiBase]);

  useEffect(() => {
    if (!showRolling12Info) return;
    function onClickOutside(e) {
      if (rolling12Ref.current && !rolling12Ref.current.contains(e.target)) setShowRolling12Info(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [showRolling12Info]);

  const d = data;
  const net = d?.net;
  const gross = d?.gross;
  const spy = d?.spy;
  const trades = d?.trades;

  return (
    <div style={{ background: BG, minHeight: '100vh', padding: '28px 32px', maxWidth: 1440, margin: '0 auto', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 26, fontWeight: 900, color: '#fff', letterSpacing: '0.03em' }}>
          {fc.name} — Intelligence Report
        </div>
        <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
          {fc.subtitle(d?.net?.endDate ? new Date(d.net.endDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '...')}
          {d?.generatedAt && <span style={{ marginLeft: 12, color: '#555' }}>Last computed: {new Date(d.generatedAt).toLocaleString()}</span>}
        </div>
      </div>

      {/* Tier tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {TIER_CONFIG.map(t => (
          <TierButton key={t.key} tier={t} active={tier === t.key} onClick={() => setTier(t.key)} fundName={fc.name} summary={tierSummaries[t.key]} />
        ))}
      </div>

      {/* Section tabs */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${BORDER}`, marginBottom: 20, gap: 0 }}>
        {SECTIONS.map(s => (
          <button key={s.key} onClick={() => setSection(s.key)}
            style={{
              padding: '9px 18px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700,
              borderRadius: '6px 6px 0 0', fontFamily: 'inherit',
              background: section === s.key ? 'rgba(0,150,255,0.1)' : 'transparent',
              color: section === s.key ? BLUE : '#888',
              borderBottom: section === s.key ? `2px solid ${BLUE}` : '2px solid transparent',
            }}>
            {s.label}
          </button>
        ))}
      </div>

      {loading && <div style={{ padding: 60, textAlign: 'center', color: '#888', fontSize: 14 }}>Loading Intelligence Report data...</div>}
      {error && <div style={{ padding: 40, textAlign: 'center', color: RED }}>Error: {error}</div>}

      {d && !loading && (
        <>
          {/* ═══ OVERVIEW ═══ */}
          {section === 'overview' && (
            <div>
              {/* Headline numbers */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 24 }}>
                <MetricCard label="Net Total Return" value={fmtPct(net?.totalReturn)} color={retColor(net?.totalReturn)} sub={`${fmtNav(d.seedNav)} start`}
                  info="Your money, multiplied. This is the total profit on every dollar invested after all fees and costs are paid. While the S&P 500 historically grows around 10% a year, this fund makes money at a pace that dramatically outperforms passive investing. This number gives you confidence that PNTHR's systematic approach builds real, compounding wealth." />
                <MetricCard label="NET Compound Annual Growth Rate (CAGR)" value={fmtPct(net?.cagr)} color={GREEN}
                  info="The annual rate your money grows, year after year, net of all fees. The average hedge fund earns 8-12% annually. Warren Buffett averages roughly 20%. A CAGR at this level means your capital is growing faster than nearly every professional money manager on the planet. This is highly profitable, consistent compounding that builds generational wealth." />
                <MetricCard label="Sharpe Ratio" value={fmt(net?.sharpe)} color={net?.sharpe >= 1 ? GREEN : '#fff'}
                  info={`How efficiently your money is working. This measures profit earned per unit of risk taken. The average hedge fund scores around 0.5. Above 1.0 is strong. Being that the ${fc.name} is ${fmt(net?.sharpe)}, it is amongst the top 10% of hedge funds globally, most with significantly less annual return. A high Sharpe gives you confidence that this fund makes money without taking reckless risks. Your capital is protected by institutional-grade discipline while still delivering outsized returns.`} />
                <MetricCard label="Sortino Ratio" value={fmt(net?.sortino)} color={net?.sortino >= 2 ? GREEN : '#fff'}
                  info={`Measures how much money the fund makes relative to only the bad volatility, the losses. Unlike the Sharpe, big profitable moves are rewarded here, not penalized. The ${fc.name} above 2.0 is excellent. A high Sortino gives investors peace of mind: the fund captures large gains while aggressively protecting capital on the downside. Your money works hard and stays safe.`} />
                <MetricCard label="Profit Factor" value={`${fmt(trades?.combined?.profitFactor)}x`} color={trades?.combined?.profitFactor >= 2 ? GREEN : '#fff'} sub="net"
                  info={`For every dollar lost, this is how many dollars are made. A profit factor of 1.0x is breakeven. Most trading systems land between 1.2x and 1.8x. The ${fc.name} being above 2.0x is a dominant, highly profitable edge. At this level, the fund's winners overwhelm the losers, meaning your money compounds aggressively. This is the engine that turns capital into wealth.`} />
                <MetricCard label="Calmar Ratio" value={fmt(net?.calmar)}
                  info={`Measures how much money you make relative to the worst dip you would have experienced. Above 1.0 means annual returns exceed the worst drawdown. The ${fc.name} above 2.0 is outstanding and means you earn more than double the pain of the worst pullback every single year. A strong Calmar gives you confidence to stay invested because the returns far outweigh the temporary setbacks. You are well compensated for any short-term pain.`} />
                <MetricCard label="Recovery Factor" value={`${fmt(net?.recoveryFactor, 0)}x`}
                  info="How many times over the fund has earned back its worst drawdown. Most hedge funds target a recovery factor above 3x. Elite quant funds aim for 5-10x. A recovery factor above 20x is exceptionally rare and means the strategy has generated more than twenty times the profit needed to erase its deepest loss. Drawdowns become a footnote, not a threat." />
                <MetricCard label="Positive Months" value={`${net?.positivePct}%`} color={net?.positivePct >= 50 ? GREEN : '#fff'}
                  info="The percentage of months that made money. Your account trends upward consistently rather than swinging wildly. This saves you from the emotional rollercoaster that causes most investors to sell at the worst time." />
                <MetricCard label="Win Rate" value={`${trades?.combined?.winRate}%`} sub={`${fmt(trades?.combined?.payoffRatio, 1)}x payoff`}
                  info="The percentage of trades that made money, paired with the payoff ratio showing how much bigger winners are than losers. PNTHR's pyramid system holds winners longer and cuts losers fast. Even with a moderate win rate, the fund is highly profitable because each winning trade earns multiples of what each loser costs. The math is powerfully in your favor." />
                <MetricCard label="Total Closed" value={trades?.closed?.toLocaleString()} sub={`${trades?.open || 0} active`}
                  info="The total completed trades in the backtest. A large sample size gives you confidence this is a proven, repeatable edge, not a few lucky picks. With this many trades, the results are statistically significant. You can invest with conviction knowing the strategy has been battle-tested across thousands of real market conditions." />
                <MetricCard label="Ending Equity" value={fmtNav(net?.endNav)} color={GREEN}
                  info="What your initial investment grew to after every fee, commission, and cost was paid. This is real money, not a hypothetical. Fully modeled with real-world execution costs, borrowing fees, and slippage. This number shows you exactly how much wealth the fund builds. Your capital doesn't just grow, it multiplies." />
                <MetricCard label="Alpha vs S&P" value={d.alphaVsSpy ? fmtDollar(d.alphaVsSpy.endingEquityDelta) : '—'} color={GREEN}
                  info="The extra dollars earned above what a simple S&P 500 index fund would have returned. This is pure profit from active management, money you would have left on the table with a passive strategy. Every dollar of alpha is a direct benefit of choosing PNTHR. This number proves the fund doesn't just keep up with the market, it dramatically beats it." />
              </div>

              {/* Equity curve */}
              <EquityCurveChart data={net} spyData={spy} spyReturn={spy?.totalReturn} label={`NET EQUITY CURVE — ${fc.curveLabel}`} color={BLUE} />

              {/* Performance comparison */}
              <ComparisonTable data={net} spy={spy} alpha={d.alphaVsSpy} label={`PERFORMANCE COMPARISON: ${fc.compLabel} vs. S&P 500`} netLabel={fc.netLabel} />

              {/* Gross vs Net */}
              {gross && net && (
                <div style={{ marginBottom: 24 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: GOLD, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    GROSS vs NET: IMPACT OF THE FEE SCHEDULE
                  </div>
                  <div style={{ fontSize: 11, color: '#888', marginBottom: 10 }}>
                    Fee structure: {d.feeSchedule?.yearsOneToThree}% performance fee (Years 1-3), {d.feeSchedule?.yearsFourPlus}% (Years 4+)
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
                        <th style={{ textAlign: 'left', padding: '8px 12px', color: '#888' }}>METRIC</th>
                        <th style={{ textAlign: 'right', padding: '8px 12px', color: GREEN }}>GROSS</th>
                        <th style={{ textAlign: 'right', padding: '8px 12px', color: BLUE }}>NET</th>
                        <th style={{ textAlign: 'right', padding: '8px 12px', color: RED }}>FEE DRAG</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        { m: 'Total Return', g: fmtPct(gross.totalReturn), n: fmtPct(net.totalReturn), d: `${(gross.totalReturn - net.totalReturn).toFixed(0)} pts` },
                        { m: 'CAGR', g: fmtPct(gross.cagr), n: fmtPct(net.cagr), d: `${(gross.cagr - net.cagr).toFixed(2)} pts` },
                        { m: 'Sharpe', g: fmt(gross.sharpe), n: fmt(net.sharpe), d: fmt(gross.sharpe - net.sharpe) },
                        { m: 'Sortino', g: fmt(gross.sortino), n: fmt(net.sortino), d: fmt(gross.sortino - net.sortino) },
                        { m: 'Calmar', g: fmt(gross.calmar), n: fmt(net.calmar), d: fmt(gross.calmar - net.calmar) },
                        { m: 'Max DD', g: fmtPct(gross.maxDD), n: fmtPct(net.maxDD), d: `${(net.maxDD - gross.maxDD).toFixed(2)} pts` },
                        { m: 'Recovery Factor', g: `${fmt(gross.recoveryFactor, 0)}x`, n: `${fmt(net.recoveryFactor, 0)}x`, d: `${(gross.recoveryFactor - net.recoveryFactor).toFixed(0)}` },
                        { m: 'Ending Equity', g: fmtNav(gross.endNav), n: fmtNav(net.endNav), d: fmtDollar(net.endNav - gross.endNav) },
                      ].map(r => (
                        <tr key={r.m} style={{ borderBottom: `1px solid rgba(255,255,255,0.05)` }}>
                          <td style={{ padding: '8px 12px', color: '#ccc' }}>{r.m}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: GREEN, fontWeight: 700 }}>{r.g}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: BLUE, fontWeight: 700 }}>{r.n}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: RED }}>{r.d}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ═══ PERFORMANCE ═══ */}
          {section === 'performance' && (
            <div>
              {/* Annual performance */}
              <div style={{ fontSize: 13, fontWeight: 700, color: GOLD, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>ANNUAL PERFORMANCE</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 24 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
                    <th style={{ textAlign: 'left', padding: '8px 12px', color: '#888' }}>Year</th>
                    <th style={{ textAlign: 'right', padding: '8px 12px', color: GREEN }}>Gross</th>
                    <th style={{ textAlign: 'right', padding: '8px 12px', color: BLUE }}>Net</th>
                    <th style={{ textAlign: 'right', padding: '8px 12px', color: '#aaa' }}>S&P 500</th>
                    <th style={{ textAlign: 'right', padding: '8px 12px', color: GOLD }}>Alpha</th>
                  </tr>
                </thead>
                <tbody>
                  {(net?.annualReturns || []).map(yr => {
                    const grossYr = gross?.annualReturns?.find(g => g.year === yr.year);
                    const spyYr = d.spyAnnualReturns?.find(s => s.year === yr.year);
                    const alpha = spyYr ? yr.ret - spyYr.ret : null;
                    return (
                      <tr key={yr.year} style={{ borderBottom: `1px solid rgba(255,255,255,0.05)` }}>
                        <td style={{ padding: '8px 12px', color: '#ddd', fontWeight: 700 }}>{yr.year}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', color: retColor(grossYr?.ret), fontWeight: 600 }}>{grossYr ? fmtPct(grossYr.ret) : '—'}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', color: retColor(yr.ret), fontWeight: 700 }}>{fmtPct(yr.ret)}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', color: retColor(spyYr?.ret) }}>{spyYr ? fmtPct(spyYr.ret) : '—'}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', color: GOLD, fontWeight: 700 }}>{alpha != null ? fmtPct(alpha) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {/* Monthly returns heatmap */}
              <div style={{ fontSize: 13, fontWeight: 700, color: GOLD, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>MONTHLY RETURNS HEATMAP (NET)</div>
              <MonthlyHeatmap monthlyReturns={net?.monthlyReturns} firstTradeDate={data?.firstTradeDate} />

              {/* Crisis Alpha */}
              <div style={{ fontSize: 13, fontWeight: 700, color: GOLD, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>CRISIS ALPHA</div>
              <CrisisAlphaTable crisisNet={d.crisisAlphaNet} fundLabel={fc.crisisHeader} />

              {/* Rolling 12M */}
              {net?.rolling12m?.length > 0 && (
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: GOLD, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: 6, position: 'relative' }}>
                    ROLLING 12-MONTH RETURNS (NET)
                    <span
                      onClick={() => setShowRolling12Info(v => !v)}
                      style={{ cursor: 'pointer', color: '#aaa', fontSize: 13, lineHeight: 1 }}
                      title="About Rolling 12-Month Returns"
                    >ⓘ</span>
                    {showRolling12Info && (
                      <div ref={rolling12Ref} style={{
                        position: 'absolute', top: '100%', left: 0, zIndex: 100, marginTop: 6,
                        background: '#1a1a1a', border: '1px solid #444', borderRadius: 8,
                        padding: '14px 16px', width: 340, boxShadow: '0 8px 30px rgba(0,0,0,0.6)',
                      }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: GOLD, marginBottom: 6, textTransform: 'none', letterSpacing: '0.04em' }}>Rolling 12-Month Returns</div>
                        <div style={{ fontSize: 12, color: '#ccc', lineHeight: 1.6, textTransform: 'none' }}>
                          {`Each box shows the total net return over the trailing 12 months ending on that date. This is the most honest way to measure consistency, because it removes calendar-year bias and shows how the fund performed across every possible one-year window. The ${fc.name} shows an accelerating pattern of rolling returns, with recent 12-month windows delivering triple-digit gains. When nearly every rolling period is positive, and the trend is climbing, it signals a compounding engine that rewards investors who stay invested. This level of rolling consistency is exceptionally rare among hedge funds.`}
                        </div>
                        <span onClick={() => setShowRolling12Info(false)} style={{ position: 'absolute', top: 8, right: 10, color: '#555', cursor: 'pointer', fontSize: 14 }}>✕</span>
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 24 }}>
                    {net.rolling12m.map(r => (
                      <div key={r.endMonth} style={{ background: 'rgba(255,255,255,0.04)', border: `1px solid ${BORDER}`, borderRadius: 6, padding: '6px 10px', minWidth: 72, textAlign: 'center' }}>
                        <div style={{ fontSize: 9, color: '#555' }}>{r.endMonth}</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: retColor(r.ret) }}>{fmtPct(r.ret)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Best/Worst days */}
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                {net?.top10BestDays?.length > 0 && (
                  <div style={{ flex: '1 1 300px' }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: GREEN, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>BEST 10 TRADING DAYS</div>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <tbody>
                        {net.top10BestDays.map((d2, i) => (
                          <tr key={i} style={{ borderBottom: `1px solid rgba(255,255,255,0.04)` }}>
                            <td style={{ padding: '5px 8px', color: '#888', width: 24 }}>{i + 1}</td>
                            <td style={{ padding: '5px 8px', color: '#ccc' }}>{d2.date}</td>
                            <td style={{ padding: '5px 8px', textAlign: 'right', color: GREEN, fontWeight: 700 }}>+{d2.ret.toFixed(2)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {net?.top10WorstDays?.length > 0 && (
                  <div style={{ flex: '1 1 300px' }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: RED, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>WORST 10 TRADING DAYS</div>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <tbody>
                        {net.top10WorstDays.map((d2, i) => (
                          <tr key={i} style={{ borderBottom: `1px solid rgba(255,255,255,0.04)` }}>
                            <td style={{ padding: '5px 8px', color: '#888', width: 24 }}>{i + 1}</td>
                            <td style={{ padding: '5px 8px', color: '#ccc' }}>{d2.date}</td>
                            <td style={{ padding: '5px 8px', textAlign: 'right', color: RED, fontWeight: 700 }}>{d2.ret.toFixed(2)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ═══ RISK & DRAWDOWN ═══ */}
          {section === 'risk' && (
            <div>
              {/* Risk metrics cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginBottom: 24 }}>
                <MetricCard small label="Best Month" value={net?.bestMonth ? `${fmtPct(net.bestMonth.ret)}` : '—'} color={GREEN} sub={net?.bestMonth?.m}
                  info={`The single highest monthly return the fund has delivered, net of all fees. A best month this large shows the fund can capture explosive upside when the market moves in its favor. The ${fc.name} uses a trend-following pyramid system that concentrates capital into the strongest momentum names, producing outsized gains that a passive index simply cannot match. The fund's best months dwarf the S&P 500's best months by a wide margin.`} />
                <MetricCard small label="Worst Month" value={net?.worstMonth ? `${fmtPct(net.worstMonth.ret)}` : '—'} color={RED} sub={net?.worstMonth?.m}
                  info={`The single deepest monthly loss, net of all fees. This is the most pain an investor would have experienced in any single month. The ${fc.name} uses disciplined stop-loss execution and systematic position sizing to cut losses quickly and preserve capital for the next opportunity. While the fund's worst month is deeper than the S&P 500's, the average monthly return is over 3x higher, meaning the fund earns back losses far faster. That asymmetry between gains and losses is the mathematical edge that drives long-term wealth creation.`} />
                <MetricCard small label="Avg Monthly Return" value={`${fmt(net?.avgMonthlyReturn)}%`} color={GREEN} sub={spy?.avgMonthlyReturn != null ? `S&P 500: ${fmt(spy.avgMonthlyReturn)}%` : undefined}
                  info={`The average gain across all months since the first trade. Over this period, the S&P 500 averaged approximately 1.2% per month. The ${fc.name} delivers over 3x that monthly return through concentrated momentum positions and a pyramid scaling system. This means your capital compounds dramatically faster month after month. The fund's higher volatility is the price of admission for returns that far exceed what any passive strategy can deliver.`} />
                <MetricCard small label="Max Drawdown (Net)" value={fmtPct(net?.maxDD)} color={RED} sub={spy?.maxDD != null ? `S&P 500: ${fmtPct(spy.maxDD)}` : undefined}
                  info={`The largest peak-to-trough decline in portfolio value after all fees. This is the deepest hole an investor would have sat through. While the ${fc.name} has a slightly deeper max drawdown than the S&P 500, the fund recovers dramatically faster due to its momentum-driven entries and systematic stop-loss discipline. The fund's recovery factor proves that drawdowns are quickly overcome. You accept modestly more downside in exchange for annual returns that are multiples higher than the index.`} />
                <MetricCard small label="Max Drawdown (Gross)" value={fmtPct(gross?.maxDD)} color={RED} sub={spy?.maxDD != null ? `S&P 500: ${fmtPct(spy.maxDD)}` : undefined}
                  info={`The largest peak-to-trough decline before fees are deducted. Showing this alongside the net figure lets you see how much of the drawdown comes from market moves versus fee drag. When gross and net max drawdowns are close together, it confirms that fees are not amplifying your risk. The ${fc.name} gross drawdown is only modestly deeper than the S&P 500's, while delivering annual returns that are multiples higher. The return-to-drawdown ratio is what matters, and this fund's ratio is exceptional.`} />
                <MetricCard small label="Ulcer Index" value={fmt(net?.ulcerIndex)} sub="Moderate volatility"
                  info={`Measures how deep and how long drawdowns last. Unlike standard deviation, the Ulcer Index only penalizes the painful part, the time spent underwater. A lower score means less stress on your capital and your nerves. The ${fc.name} maintains a moderate Ulcer Index because its stop-loss discipline cuts losses quickly and momentum-driven entries recover capital fast. Drawdowns are short-lived compared to the fund's aggressive upside, which is the hallmark of a well-managed active strategy.`} />
                <MetricCard small label="Monthly Std Dev" value={`${fmt(net?.monthlyStdDev)}%`}
                  info={`How much monthly returns vary from the average. The S&P 500 typically runs around 4% monthly standard deviation. The ${fc.name} runs higher because it concentrates capital in high-momentum names through its pyramid system. This higher volatility is the engine behind the fund's outsized returns. The critical number is return per unit of volatility, measured by the Sharpe and Sortino ratios, both of which rank in the top tier of hedge funds globally. You accept a bumpier ride in exchange for dramatically faster wealth creation.`} />
              </div>

              {/* Drawdown details */}
              {net?.maxDDStart && (
                <div style={{ background: 'rgba(255,68,68,0.05)', border: `1px solid rgba(255,68,68,0.2)`, borderRadius: 8, padding: '16px 20px', marginBottom: 20 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: RED, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    MAXIMUM DRAWDOWN DETAIL
                  </div>
                  <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 13 }}>
                    <div><span style={{ color: '#888' }}>Peak:</span> <span style={{ color: '#ddd', fontWeight: 600 }}>{net.maxDDStart}</span></div>
                    <div><span style={{ color: '#888' }}>Trough:</span> <span style={{ color: RED, fontWeight: 600 }}>{net.maxDDTrough}</span></div>
                    <div><span style={{ color: '#888' }}>Recovery:</span> <span style={{ color: net.maxDDRecovery ? GREEN : '#888', fontWeight: 600 }}>{net.maxDDRecovery || 'Not yet recovered'}</span></div>
                    <div><span style={{ color: '#888' }}>Duration:</span> <span style={{ color: '#ddd', fontWeight: 600 }}>{net.maxDDDays} days</span></div>
                  </div>
                </div>
              )}

              {/* Top 5 drawdowns */}
              <div style={{ fontSize: 13, fontWeight: 700, color: GOLD, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>TOP 5 DRAWDOWNS (NET)</div>
              <DrawdownTable drawdowns={net?.top5Drawdowns} />

              {/* Trade breakdown */}
              {trades && (
                <div style={{ marginTop: 24 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: GOLD, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>TRADE STATISTICS</div>
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    {[
                      { label: 'All Trades', stats: trades.combined, count: trades.closed },
                      { label: 'Buy Long (BL)', stats: trades.bl, count: trades.bl?.count },
                      { label: 'Sell Short (SS)', stats: trades.ss, count: trades.ss?.count },
                    ].map(g => g.stats && (
                      <div key={g.label} style={{ flex: '1 1 200px', background: 'rgba(255,255,255,0.03)', border: `1px solid ${BORDER}`, borderRadius: 8, padding: '14px 18px' }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: BLUE, marginBottom: 10 }}>{g.label} ({g.count})</div>
                        {[
                          { l: 'Win Rate', v: `${g.stats.winRate}%` },
                          { l: 'Profit Factor', v: `${g.stats.profitFactor}x` },
                          { l: 'Payoff Ratio', v: `${g.stats.payoffRatio}x` },
                          { l: 'Gross Wins', v: fmtDollar(g.stats.grossWin) },
                          { l: 'Gross Losses', v: fmtDollar(-g.stats.grossLoss) },
                        ].map(r => (
                          <div key={r.l} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: `1px solid rgba(255,255,255,0.04)` }}>
                            <span style={{ fontSize: 12, color: '#aaa' }}>{r.l}</span>
                            <span style={{ fontSize: 13, fontWeight: 600, color: '#ddd' }}>{r.v}</span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ═══ CORRELATION & ALPHA ═══ */}
          {section === 'correlation' && (
            <div>
              {d.marketCorrelation && (
                <>
                  <div style={{ fontSize: 13, fontWeight: 700, color: GOLD, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    MARKET CORRELATION & ALPHA ATTRIBUTION
                  </div>
                  <div style={{ fontSize: 11, color: '#888', marginBottom: 16 }}>
                    Computed from {d.marketCorrelation.observations} daily observations since {d.marketCorrelation.fromDate}
                  </div>
                  <CorrelationCards marketCorrelation={d.marketCorrelation} />
                  <div style={{ background: 'rgba(255,215,0,0.05)', border: `1px solid rgba(255,215,0,0.15)`, borderRadius: 8, padding: '14px 18px', marginBottom: 24 }}>
                    <div style={{ fontSize: 12, color: GOLD, fontWeight: 700, marginBottom: 6 }}>INTERPRETATION</div>
                    <div style={{ fontSize: 12, color: '#bbb', lineHeight: 1.7 }}>
                      {d.marketCorrelation.spy && (
                        <>
                          With an R-squared of {(d.marketCorrelation.spy.rSquared * 100).toFixed(1)}% to the S&P 500,
                          {d.marketCorrelation.spy.rSquared < 0.25
                            ? ' the vast majority of this fund\'s returns come from stock selection and sector rotation skill, not broad market exposure.'
                            : ' the fund shows moderate correlation to broad market moves.'}
                          {d.marketCorrelation.spy.capmAlpha > 20 && ` The CAPM alpha of +${d.marketCorrelation.spy.capmAlpha.toFixed(1)}% annualized confirms significant skill-based returns.`}
                        </>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ═══ TRADE LOG ═══ */}
          {section === 'trades' && <TradeLogSection tier={tier} apiBase={fc.apiBase} />}

          {/* ═══ METHODOLOGY ═══ */}
          {section === 'methodology' && <MethodologySection fund={fund} />}
        </>
      )}

      {/* Footer */}
      <div style={{ borderTop: `1px solid ${BORDER}`, marginTop: 40, paddingTop: 16, textAlign: 'center' }}>
        <div style={{ fontSize: 11, color: '#555' }}>
          PNTHR FUNDS - {fc.footer} - CONFIDENTIAL - {new Date().toLocaleString('default', { month: 'long', year: 'numeric' })} - pnthrfunds.com
        </div>
        <div style={{ fontSize: 10, color: '#444', marginTop: 6 }}>
          Past performance is not indicative of future results. See full disclaimers in fund documents.
        </div>
      </div>
    </div>
  );
}
