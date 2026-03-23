import React, { useState, useEffect } from 'react';
import { fetchPulse, fetchLiveVix } from '../services/api';
import ChartModal from './ChartModal';

export default function PulsePage({ onNavigate }) {
  const [data, setData] = useState(null);
  const [vix, setVix] = useState(null);
  const [loading, setLoading] = useState(true);
  const [chartStock, setChartStock] = useState(null);

  useEffect(() => {
    Promise.all([fetchPulse(), fetchLiveVix()])
      .then(([pulse, vixData]) => { setData(pulse); setVix(vixData); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <div style={{ background: '#0a0a0a', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#D4A017', fontSize: 18, fontFamily: 'monospace' }}>
      Loading Pulse...
    </div>
  );
  if (!data) return (
    <div style={{ background: '#0a0a0a', minHeight: '100vh', color: '#ff6b6b', padding: 40, fontFamily: 'monospace' }}>
      Failed to load Pulse data.
    </div>
  );

  return (
    <div style={{ background: '#0a0a0a', minHeight: '100vh', padding: '16px 24px', fontFamily: 'monospace' }}>
      {/* STATUS LIGHT */}
      <StatusLight status={data.statusLight} message={data.statusMessage} positions={data.positions} />

      {/* TIER 1: 5-second read */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <SpyGauge regime={data.regime} />
        <QqqGauge regime={data.regime} />
        <RegimeIndicator regime={data.regime} signals={data.signals} />
        <VixThermometer vix={vix} />
        <HeatGauge positions={data.positions} />
      </div>

      {/* TIER 2: 30-second scan */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
        <KillTop10 killTop10={data.killTop10} onTickerClick={setChartStock} />
        <SectorHeatmap signals={data.signals} />
      </div>
      <SignalBreadthBar signals={data.signals} />
      <MacroStrip marketSnapshot={data.marketSnapshot} />

      {/* TIER 3: Action items */}
      <div style={{ display: 'flex', gap: 16, marginTop: 16, flexWrap: 'wrap' }}>
        <LotsReady lotsReady={data.lotsReady} onNavigate={onNavigate} />
        <RiskAlertsPanel positions={data.positions} />
        <PositionsSummary positions={data.positions} onNavigate={onNavigate} />
      </div>

      {chartStock && (
        <ChartModal
          stocks={[chartStock]}
          initialIndex={0}
          earnings={{}}
          onClose={() => setChartStock(null)}
        />
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatusLight({ status, message, positions }) {
  const color = status === 'RED' ? '#dc3545' : status === 'YELLOW' ? '#ffc107' : '#28a745';
  const pulse = status !== 'GREEN';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
      padding: '10px 24px', marginBottom: 16, borderRadius: 8,
      border: `1px solid ${color}22`,
      background: `${color}11`,
      animation: pulse ? 'pulse 2s ease-in-out infinite' : 'none',
    }}>
      <style>{`@keyframes pulse { 0%,100% { opacity:0.8 } 50% { opacity:1 } }`}</style>
      <div style={{ width: 12, height: 12, borderRadius: '50%', background: color, boxShadow: `0 0 8px ${color}` }} />
      <span style={{ color, fontWeight: 700, fontSize: 14, letterSpacing: 2 }}>{message}</span>
      {positions && (
        <span style={{ color: '#888', fontSize: 12, marginLeft: 16 }}>
          {positions.total} positions · {Math.round((positions.heat?.totalRiskPct || 0) * 10) / 10}% heat
        </span>
      )}
    </div>
  );
}

function SemiGauge({ value, min, max, zones, label, displayValue, subLabel, subValue, subValueColor }) {
  const W = 180, H = 110;
  const cx = W / 2, cy = H - 10, r = 80;

  const toAngle = (v) => {
    const pct = Math.max(0, Math.min(1, (v - min) / (max - min)));
    return Math.PI + pct * Math.PI;
  };

  const arcPath = (a1, a2) => {
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
    const large = Math.abs(a2 - a1) > Math.PI ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  };

  const clampedValue = Math.max(min, Math.min(max, value ?? 0));
  const needleAngle = toAngle(clampedValue);
  const nx = cx + r * 0.8 * Math.cos(needleAngle);
  const ny = cy + r * 0.8 * Math.sin(needleAngle);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', background: '#111', borderRadius: 12, padding: '12px 16px', minWidth: 160 }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <path d={arcPath(Math.PI, 2 * Math.PI)} fill="none" stroke="#222" strokeWidth={14} />
        {zones.map((z, i) => {
          const a1 = toAngle(z.from), a2 = toAngle(z.to);
          return <path key={i} d={arcPath(a1, a2)} fill="none" stroke={z.color} strokeWidth={12} opacity={0.7} />;
        })}
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="#FFD700" strokeWidth={2.5} strokeLinecap="round" />
        <circle cx={cx} cy={cy} r={8} fill="#FFD700" />
        <circle cx={cx} cy={cy} r={4} fill="#0a0a0a" />
      </svg>
      <div style={{ color: '#FFD700', fontSize: 11, fontWeight: 700, letterSpacing: 2, marginTop: 4 }}>{label}</div>
      <div style={{ color: '#fff', fontSize: 20, fontWeight: 800 }}>{displayValue ?? '—'}</div>
      <div style={{ color: '#888', fontSize: 10 }}>{subLabel}</div>
      {subValue && <div style={{ color: subValueColor || '#fff', fontSize: 13, fontWeight: 600 }}>{subValue}</div>}
    </div>
  );
}

function SpyGauge({ regime }) {
  const spy = regime?.spy;
  const sep = spy ? +((spy.close - spy.ema21) / spy.ema21 * 100).toFixed(1) : null;
  // Compute separation from stored regime fields (indexPosition/spyAboveEma)
  const pos = regime?.indexPosition;
  const zones = [
    { from: -20, to: -10, color: '#dc3545' },
    { from: -10, to: -3,  color: '#ff6b6b' },
    { from: -3,  to:  3,  color: '#555' },
    { from:  3,  to:  10, color: '#6bcb77' },
    { from:  10, to:  20, color: '#28a745' },
  ];
  // If no spy price data, show bull/bear indicator based on indexPosition
  const needleVal = sep !== null ? sep : (pos === 'above' ? 5 : pos === 'below' ? -5 : 0);
  return (
    <SemiGauge
      value={needleVal} min={-20} max={20} zones={zones}
      label="SPY"
      displayValue={spy?.close ? `$${spy.close.toFixed(2)}` : (pos ? (pos === 'above' ? '▲ ABOVE' : '▼ BELOW') : '—')}
      subLabel={spy?.ema21 ? `vs $${spy.ema21.toFixed(2)} EMA` : (regime?.weekOf ? `Week ${regime.weekOf}` : 'No data')}
      subValue={sep !== null ? `${sep > 0 ? '+' : ''}${sep}%` : (pos ? `${pos} EMA` : null)}
      subValueColor={sep !== null ? (sep >= 0 ? '#28a745' : '#dc3545') : (pos === 'above' ? '#28a745' : '#dc3545')}
    />
  );
}

function QqqGauge({ regime }) {
  const qqq = regime?.qqq;
  const sep = qqq ? +((qqq.close - qqq.ema21) / qqq.ema21 * 100).toFixed(1) : null;
  const pos = regime?.qqqAboveEma != null ? (regime.qqqAboveEma ? 'above' : 'below') : null;
  const zones = [
    { from: -20, to: -10, color: '#dc3545' },
    { from: -10, to: -3,  color: '#ff6b6b' },
    { from: -3,  to:  3,  color: '#555' },
    { from:  3,  to:  10, color: '#6bcb77' },
    { from:  10, to:  20, color: '#28a745' },
  ];
  const needleVal = sep !== null ? sep : (pos === 'above' ? 5 : pos === 'below' ? -5 : 0);
  return (
    <SemiGauge
      value={needleVal} min={-20} max={20} zones={zones}
      label="QQQ"
      displayValue={qqq?.close ? `$${qqq.close.toFixed(2)}` : (pos ? (pos === 'above' ? '▲ ABOVE' : '▼ BELOW') : '—')}
      subLabel={qqq?.ema21 ? `vs $${qqq.ema21.toFixed(2)} EMA` : (regime?.weekOf ? `Week ${regime.weekOf}` : 'No data')}
      subValue={sep !== null ? `${sep > 0 ? '+' : ''}${sep}%` : (pos ? `${pos} EMA` : null)}
      subValueColor={sep !== null ? (sep >= 0 ? '#28a745' : '#dc3545') : (pos === 'above' ? '#28a745' : '#dc3545')}
    />
  );
}

function RegimeIndicator({ regime, signals }) {
  const pos = regime?.indexPosition || 'unknown';
  const isBear = pos === 'below';
  const isBull = pos === 'above';
  const bg = isBear ? 'rgba(220,53,69,0.15)' : isBull ? 'rgba(40,167,69,0.15)' : 'rgba(100,100,100,0.15)';
  const border = isBear ? '#dc3545' : isBull ? '#28a745' : '#555';
  const label = isBear ? 'BEARISH' : isBull ? 'BULLISH' : 'NEUTRAL';
  const labelColor = isBear ? '#ff6b6b' : isBull ? '#6bcb77' : '#888';

  // Compute D1 from blCount/ssCount ratio stored in regime
  const blCnt = regime?.blCount || 0;
  const ssCnt = regime?.ssCount || 0;
  const totalSigs = blCnt + ssCnt;
  const ssRatio = totalSigs > 0 ? ssCnt / totalSigs : 0.5;
  // Regime score: -5 to +5 based on SPY/QQQ position and signal mix
  const regimeScore = isBull ? 2 + (ssRatio < 0.4 ? 2 : 0) : isBear ? -2 - (ssRatio > 0.6 ? 2 : 0) : 0;
  const d1 = Math.max(0.70, Math.min(1.30, Math.round((1.0 + regimeScore * 0.06) * 100) / 100));

  return (
    <div style={{ flex: 1, minWidth: 200, background: bg, border: `2px solid ${border}33`, borderRadius: 12, padding: '16px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <div style={{ color: '#888', fontSize: 11, letterSpacing: 2, fontWeight: 700 }}>⚡ REGIME</div>
      <div style={{ color: labelColor, fontSize: 28, fontWeight: 900, letterSpacing: 4 }}>{label}</div>
      <div style={{ color: '#FFD700', fontSize: 16, fontWeight: 700 }}>D1 = {d1.toFixed(2)}x</div>
      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: '#888' }}>
        {regime?.weekOf && <span>Week {regime.weekOf}</span>}
        {signals && <span>SS:BL {(signals.ratio || 0).toFixed(1)}:1</span>}
      </div>
      <div style={{ display: 'flex', gap: 12, fontSize: 11 }}>
        <span style={{ color: isBear ? '#ff6b6b' : '#6bcb77' }}>SPY {isBear ? '▼ below' : '▲ above'}</span>
        <span style={{ color: regime?.qqqAboveEma === false ? '#ff6b6b' : '#6bcb77' }}>QQQ {regime?.qqqAboveEma === false ? '▼ below' : '▲ above'}</span>
      </div>
    </div>
  );
}

function VixThermometer({ vix }) {
  const val = vix?.close || 0;
  const change = vix?.change;
  const maxVix = 50;
  const zones = [
    { from: 0, to: 15, color: '#28a745', label: 'CALM' },
    { from: 15, to: 25, color: '#ffc107', label: 'NORMAL' },
    { from: 25, to: 35, color: '#ff8c00', label: 'ELEVATED' },
    { from: 35, to: 50, color: '#dc3545', label: 'FEAR' },
  ];
  const zoneColor = val < 15 ? '#28a745' : val < 25 ? '#ffc107' : val < 35 ? '#ff8c00' : '#dc3545';
  const fillPct = Math.min(val / maxVix, 1) * 100;

  const W = 70, H = 160, bx = 28, bw = 14, by = 10, bh = 130;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', background: '#111', borderRadius: 12, padding: '12px 16px', minWidth: 100 }}>
      <div style={{ color: '#888', fontSize: 11, letterSpacing: 2, fontWeight: 700, marginBottom: 4 }}>VIX</div>
      <svg width={W} height={H}>
        {zones.map((z, i) => {
          const yTop = by + bh * (1 - z.to / maxVix);
          const yBot = by + bh * (1 - z.from / maxVix);
          return <rect key={i} x={bx} y={yTop} width={bw} height={yBot - yTop} fill={z.color} opacity={0.2} rx={2} />;
        })}
        <rect x={bx + 2} y={by + bh * (1 - fillPct / 100)} width={bw - 4} height={bh * (fillPct / 100)} fill={zoneColor} opacity={0.8} rx={2} />
        <rect x={bx} y={by} width={bw} height={bh} fill="none" stroke="#444" strokeWidth={1.5} rx={3} />
        {[10, 20, 30, 40].map(v => {
          const y = by + bh * (1 - v / maxVix);
          return (
            <g key={v}>
              <line x1={bx - 4} y1={y} x2={bx} y2={y} stroke="#555" strokeWidth={1} />
              <text x={bx - 6} y={y + 3} textAnchor="end" fill="#555" fontSize={8}>{v}</text>
            </g>
          );
        })}
        {val > 0 && <line x1={bx} y1={by + bh * (1 - fillPct / 100)} x2={bx + bw + 4} y2={by + bh * (1 - fillPct / 100)} stroke={zoneColor} strokeWidth={2} />}
        <circle cx={bx + bw / 2} cy={by + bh + 8} r={8} fill="#FFD700" />
        <circle cx={bx + bw / 2} cy={by + bh + 8} r={4} fill="#0a0a0a" />
      </svg>
      <div style={{ color: '#fff', fontSize: 18, fontWeight: 800 }}>{val ? val.toFixed(1) : '—'}</div>
      {change !== null && change !== undefined && (
        <div style={{ color: change > 0 ? '#dc3545' : '#28a745', fontSize: 12 }}>
          {change > 0 ? '▲' : '▼'} {Math.abs(change).toFixed(1)}
        </div>
      )}
      <div style={{ color: zoneColor, fontSize: 10, fontWeight: 700, marginTop: 2 }}>
        {val < 15 ? 'CALM' : val < 25 ? 'NORMAL' : val < 35 ? 'ELEVATED' : 'FEAR'}
      </div>
    </div>
  );
}

function HeatGauge({ positions }) {
  const heat = positions?.heat || {};
  const total = heat.totalRiskPct || 0;
  const zones = [
    { from: 0,  to: 5,  color: '#28a745' },
    { from: 5,  to: 10, color: '#ffc107' },
    { from: 10, to: 13, color: '#ff8c00' },
    { from: 13, to: 15, color: '#dc3545' },
  ];
  const remaining = Math.max(0, 15 - total);
  const nav = positions?.nav || 100000;
  return (
    <SemiGauge
      value={total} min={0} max={15} zones={zones}
      label="PORTFOLIO HEAT"
      displayValue={`${total.toFixed(1)}%`}
      subLabel={`${(heat.stockRiskPct || 0).toFixed(1)}% stocks · ${(heat.etfRiskPct || 0).toFixed(1)}% ETFs`}
      subValue={`$${Math.round(remaining / 100 * nav).toLocaleString()} capacity left`}
      subValueColor="#28a745"
    />
  );
}

function KillTop10({ killTop10, onTickerClick }) {
  const tierShort = (tier) => {
    if (!tier) return '';
    if (tier.includes('ALPHA')) return 'ALPHA';
    if (tier.includes('STRIKING')) return 'STRIK';
    if (tier.includes('HUNTING')) return 'HUNT';
    if (tier.includes('POUNCING')) return 'POUNCE';
    return tier.slice(0, 5);
  };

  return (
    <div style={{ flex: 1, minWidth: 280, background: '#111', borderRadius: 12, padding: '14px 16px', maxWidth: 380 }}>
      <div style={{ color: '#FFD700', fontSize: 12, fontWeight: 700, letterSpacing: 2, marginBottom: 10 }}>⚡ PNTHR KILL TOP 10</div>
      {(!killTop10 || killTop10.length === 0) && <div style={{ color: '#555', fontSize: 12 }}>No kill scores yet.</div>}
      {(killTop10 || []).map((s, i) => {
        const isAlpha = (s.tier || '').includes('ALPHA');
        const rc = s.rankChange;
        return (
          <div key={s.ticker} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid #1a1a1a' }}>
            <span style={{ color: i === 0 ? '#FFD700' : '#555', fontSize: 11, minWidth: 18 }}>#{s.killRank || i + 1}</span>
            <span
              style={{ color: '#FFD700', fontWeight: 800, fontSize: 13, minWidth: 52, cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'rgba(212,160,23,0.4)' }}
              onClick={() => onTickerClick({ ticker: s.ticker, symbol: s.ticker, currentPrice: s.currentPrice, signal: s.signal, sector: s.sector })}
            >{s.ticker}</span>
            <span style={{ color: '#ccc', fontSize: 12, minWidth: 44 }}>{(s.totalScore || 0).toFixed(1)}</span>
            <span style={{ background: isAlpha ? 'rgba(212,160,23,0.2)' : 'rgba(40,167,69,0.15)', color: isAlpha ? '#FFD700' : '#6bcb77', fontSize: 9, padding: '2px 5px', borderRadius: 4, minWidth: 40, textAlign: 'center' }}>{tierShort(s.tier)}</span>
            <span style={{ background: s.signal === 'SS' ? 'rgba(220,53,69,0.2)' : 'rgba(40,167,69,0.2)', color: s.signal === 'SS' ? '#ff6b6b' : '#6bcb77', fontSize: 10, padding: '2px 6px', borderRadius: 4 }}>{s.signal}</span>
            {rc != null && rc !== 0 && <span style={{ color: rc > 0 ? '#28a745' : '#dc3545', fontSize: 10 }}>{rc > 0 ? '▲' : '▼'}{Math.abs(rc)}</span>}
          </div>
        );
      })}
      <div style={{ marginTop: 10, color: '#555', fontSize: 11, cursor: 'pointer' }}>VIEW FULL KILL LIST →</div>
    </div>
  );
}

function SectorHeatmap({ signals }) {
  const sectorAbbrevs = {
    'Technology': 'TECH',
    'Healthcare': 'HLTH',
    'Financial Services': 'FIN',
    'Industrials': 'IND',
    'Consumer Staples': 'CONS',
    'Energy': 'ENER',
    'Utilities': 'UTIL',
    'Basic Materials': 'MATL',
    'Communication Services': 'COMM',
    'Real Estate': 'REAL',
    'Consumer Cyclical': 'COND',
  };
  const bySector = signals?.bySector || {};
  const sectors = Object.keys(sectorAbbrevs);

  const getColor = (bl, ss) => {
    const total = bl + ss;
    if (total === 0) return '#1a1a1a';
    const ssRatio = ss / total;
    if (ssRatio > 0.8) return 'rgba(220,53,69,0.35)';
    if (ssRatio > 0.6) return 'rgba(220,53,69,0.2)';
    if (ssRatio < 0.2) return 'rgba(40,167,69,0.35)';
    if (ssRatio < 0.4) return 'rgba(40,167,69,0.2)';
    return 'rgba(100,100,100,0.2)';
  };

  return (
    <div style={{ flex: 1, minWidth: 280, background: '#111', borderRadius: 12, padding: '14px 16px' }}>
      <div style={{ color: '#FFD700', fontSize: 12, fontWeight: 700, letterSpacing: 2, marginBottom: 10 }}>⚡ SECTOR SIGNALS</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4 }}>
        {sectors.map(sec => {
          const d = bySector[sec] || { bl: 0, ss: 0 };
          return (
            <div key={sec} style={{ background: getColor(d.bl, d.ss), borderRadius: 6, padding: '6px 4px', textAlign: 'center', border: '1px solid #222' }}>
              <div style={{ color: '#aaa', fontSize: 9, fontWeight: 700 }}>{sectorAbbrevs[sec]}</div>
              <div style={{ color: '#6bcb77', fontSize: 9 }}>↑{d.bl}</div>
              <div style={{ color: '#ff6b6b', fontSize: 9 }}>↓{d.ss}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SignalBreadthBar({ signals }) {
  const bl = signals?.blCount || 0, ss = signals?.ssCount || 0;
  const total = bl + ss;
  const blPct = total > 0 ? (bl / total) * 100 : 50;
  return (
    <div style={{ background: '#111', borderRadius: 12, padding: '12px 16px', marginBottom: 12 }}>
      <div style={{ color: '#888', fontSize: 11, letterSpacing: 2, marginBottom: 8 }}>⚡ SIGNAL BREADTH</div>
      <div style={{ display: 'flex', height: 18, borderRadius: 4, overflow: 'hidden', marginBottom: 6 }}>
        <div style={{ width: `${blPct}%`, background: '#28a745', opacity: 0.7 }} />
        <div style={{ width: `${100 - blPct}%`, background: '#dc3545', opacity: 0.7 }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#ccc' }}>
        <span style={{ color: '#6bcb77' }}>{bl} BL</span>
        <span style={{ color: '#888', fontSize: 11 }}>Ratio: {(signals?.ratio || 0).toFixed(1)}:1 SS:BL</span>
        <span style={{ color: '#ff6b6b' }}>{ss} SS</span>
      </div>
    </div>
  );
}

function MacroStrip({ marketSnapshot }) {
  // treasury10y is stored lowercase in the DB
  const t10 = marketSnapshot?.treasury10y ?? marketSnapshot?.treasury10Y;
  const dxy = marketSnapshot?.dxy;
  const weekOf = marketSnapshot?.weekOf;
  return (
    <div style={{ background: '#111', borderRadius: 8, padding: '10px 16px', marginBottom: 12, display: 'flex', gap: 24, fontSize: 12, color: '#888' }}>
      <span>10Y: <strong style={{ color: '#ccc' }}>{t10 ? `${t10.toFixed(2)}%` : '—'}</strong></span>
      <span>DXY: <strong style={{ color: '#ccc' }}>{dxy ? dxy.toFixed(1) : '—'}</strong></span>
      <span style={{ marginLeft: 'auto' }}>Week of <strong style={{ color: '#FFD700' }}>{weekOf || new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}</strong></span>
    </div>
  );
}

function LotsReady({ lotsReady, onNavigate }) {
  return (
    <div style={{ flex: 1, minWidth: 220, background: '#111', borderRadius: 12, padding: '14px 16px' }}>
      <div style={{ color: '#FFD700', fontSize: 11, fontWeight: 700, letterSpacing: 2, marginBottom: 8 }}>LOTS READY</div>
      {(!lotsReady || lotsReady.length === 0)
        ? <div style={{ color: '#555', fontSize: 12 }}>No lots pending.</div>
        : lotsReady.map((l, i) => (
          <div key={i} style={{ marginBottom: 6 }}>
            <span style={{ color: '#6bcb77', fontWeight: 700 }}>▶ {l.ticker}</span>
            <span style={{ color: '#888', fontSize: 11 }}> Lot {l.lot} — ${l.triggerPrice}</span>
          </div>
        ))
      }
      <div onClick={() => onNavigate?.('command')} style={{ marginTop: 10, color: '#FFD700', fontSize: 11, cursor: 'pointer' }}>GO TO COMMAND →</div>
    </div>
  );
}

function RiskAlertsPanel({ positions }) {
  const alerts = [];
  if (positions?.heat?.stockRiskPct > 10) alerts.push({ icon: '🔴', text: `Stock risk ${positions.heat.stockRiskPct.toFixed(1)}% exceeds 10% cap` });
  if (positions?.heat?.etfRiskPct > 5) alerts.push({ icon: '🔴', text: `ETF risk ${positions.heat.etfRiskPct.toFixed(1)}% exceeds 5% cap` });
  if (positions?.heat?.totalRiskPct > 13) alerts.push({ icon: '🟡', text: `Total heat ${positions.heat.totalRiskPct.toFixed(1)}% approaching 15% cap` });

  return (
    <div style={{ flex: 1, minWidth: 220, background: '#111', borderRadius: 12, padding: '14px 16px' }}>
      <div style={{ color: '#FFD700', fontSize: 11, fontWeight: 700, letterSpacing: 2, marginBottom: 8 }}>RISK ALERTS</div>
      {alerts.length === 0
        ? <div style={{ color: '#28a745', fontSize: 12 }}>✅ No active alerts. All clear.</div>
        : alerts.map((a, i) => <div key={i} style={{ fontSize: 12, color: '#ccc', marginBottom: 4 }}>{a.icon} {a.text}</div>)
      }
      <div style={{ marginTop: 10, color: '#FFD700', fontSize: 11, cursor: 'pointer' }}>VIEW RISK ADVISOR →</div>
    </div>
  );
}

function PositionsSummary({ positions, onNavigate }) {
  const heat = positions?.heat || {};
  return (
    <div style={{ flex: 1, minWidth: 220, background: '#111', borderRadius: 12, padding: '14px 16px' }}>
      <div style={{ color: '#FFD700', fontSize: 11, fontWeight: 700, letterSpacing: 2, marginBottom: 8 }}>POSITIONS</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: '#fff', marginBottom: 4 }}>{positions?.total || 0} Active</div>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 2 }}>{positions?.short || 0} Short · {positions?.long || 0} Long</div>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 2 }}>{positions?.recycled || 0} Recycled ($0 risk)</div>
      <div style={{ fontSize: 12, color: '#ccc', marginTop: 6 }}>
        Heat: <strong style={{ color: heat.totalRiskPct > 10 ? '#ff8c00' : '#6bcb77' }}>{(heat.totalRiskPct || 0).toFixed(1)}%</strong> / 15%
      </div>
      <div onClick={() => onNavigate?.('command')} style={{ marginTop: 10, color: '#FFD700', fontSize: 11, cursor: 'pointer' }}>GO TO COMMAND →</div>
    </div>
  );
}
