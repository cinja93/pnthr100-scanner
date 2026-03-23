import React, { useState, useEffect } from 'react';
import { fetchPulse, fetchLiveVix, fetchSignalStocks } from '../services/api';
import ChartModal from './ChartModal';

function formatTimestamp(date) {
  if (!date) return 'Loading...';
  const day = date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'America/New_York' });
  return `${day} at ${time} ET`;
}

export default function PulsePage({ onNavigate }) {
  const [data, setData] = useState(null);
  const [vix, setVix] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [chartList, setChartList] = useState([]);
  const [chartIndex, setChartIndex] = useState(0);
  const [signalModal, setSignalModal] = useState(null);

  useEffect(() => {
    Promise.all([fetchPulse(), fetchLiveVix()])
      .then(([pulse, vixData]) => { setData(pulse); setVix(vixData); setLastRefresh(new Date()); })
      .catch(err => { console.error(err); setError(err.message); })
      .finally(() => setLoading(false));
  }, []);

  async function refreshPulse() {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      const [pulse, vixData] = await Promise.all([fetchPulse(), fetchLiveVix()]);
      setData(pulse);
      setVix(vixData);
      setLastRefresh(new Date());
    } catch (err) {
      console.error('Refresh failed:', err);
    } finally {
      setIsRefreshing(false);
    }
  }

  if (loading) return (
    <div style={{ background: '#0a0a0a', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#D4A017', fontSize: 18, fontFamily: 'monospace' }}>
      Loading Pulse...
    </div>
  );
  if (!data) return (
    <div style={{ background: '#0a0a0a', minHeight: '100vh', color: '#ff6b6b', padding: 40, fontFamily: 'monospace' }}>
      <div>Failed to load Pulse data.</div>
      {error && <div style={{ marginTop: 12, fontSize: 13, color: '#ff9999', background: '#1a0000', padding: '10px 14px', borderRadius: 6, maxWidth: 600 }}>{error}</div>}
    </div>
  );

  return (
    <div style={{ background: '#0a0a0a', minHeight: '100vh', padding: '16px 24px', fontFamily: 'monospace' }}>
      {/* STATUS LIGHT */}
      <StatusLight
        status={data.statusLight}
        message={data.statusMessage}
        positions={data.positions}
        lastRefresh={lastRefresh}
        isRefreshing={isRefreshing}
        onRefresh={refreshPulse}
        killDataLive={data.killDataLive}
      />

      {/* TIER 1: Market environment — SPY, QQQ, Regime, VIX */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <SpyGauge regime={data.regime} />
        <QqqGauge regime={data.regime} />
        <RegimeIndicator regime={data.regime} signals={data.signals} />
        <VixThermometer vix={vix} />
      </div>

      {/* TIER 2: Signal intelligence — Kill Top 10, Sector Pulse, Signal Breadth, Macro */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
        <KillTop10 killTop10={data.killTop10} onTickerClick={s => { setChartList([s]); setChartIndex(0); }} killDataLive={data.killDataLive} />
        <SectorPulse signals={data.signals} killDataLive={data.killDataLive} onNavigate={onNavigate} />
      </div>
      <NewSignalsPanel
        newSignals={data.newSignals}
        onTickerClick={(stocks, idx) => { setChartList(stocks); setChartIndex(idx); }}
      />
      <SignalBreadthBar signals={data.signals} onSignalClick={setSignalModal} />
      <MacroStrip marketSnapshot={data.marketSnapshot} />

      {/* TIER 3: Portfolio — Heat gauge + positions + alerts/lots in one band */}
      <PortfolioStatus positions={data.positions} lotsReady={data.lotsReady} onNavigate={onNavigate} />

      {signalModal && (
        <SignalStockModal
          signal={signalModal}
          onClose={() => setSignalModal(null)}
          onTickerClick={(stocks, idx) => { setSignalModal(null); setChartList(stocks); setChartIndex(idx); }}
        />
      )}
      {chartList.length > 0 && (
        <ChartModal
          stocks={chartList}
          initialIndex={chartIndex}
          earnings={{}}
          onClose={() => { setChartList([]); setChartIndex(0); }}
        />
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatusLight({ status, message, positions, lastRefresh, isRefreshing, onRefresh, killDataLive }) {
  const color = status === 'RED' ? '#dc3545' : status === 'YELLOW' ? '#ffc107' : '#28a745';
  const pulse = status !== 'GREEN';
  const [hovRefresh, setHovRefresh] = useState(false);

  const dataBadge = isRefreshing
    ? { dot: '#ffc107', label: 'Refreshing...', anim: true }
    : killDataLive
      ? { dot: '#28a745', label: 'Live',         anim: false }
      : { dot: '#ffc107', label: 'Fri Pipeline', anim: false };

  return (
    <div style={{
      marginBottom: 16, borderRadius: 8,
      border: `1px solid ${color}22`,
      background: `${color}11`,
      animation: pulse ? 'statusPulse 2s ease-in-out infinite' : 'none',
      overflow: 'hidden',
    }}>
      <style>{`
        @keyframes statusPulse { 0%,100% { opacity:0.85 } 50% { opacity:1 } }
        @keyframes spin { from { transform:rotate(0deg) } to { transform:rotate(360deg) } }
      `}</style>

      {/* Row 1: status dot · message · positions · heat · REFRESH */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '9px 18px', gap: 10 }}>
        <div style={{ width: 11, height: 11, borderRadius: '50%', background: color, boxShadow: `0 0 7px ${color}`, flexShrink: 0 }} />
        <span style={{ color, fontWeight: 700, fontSize: 13, letterSpacing: 2, flex: 1 }}>{message}</span>
        {positions && (
          <span style={{ color: '#777', fontSize: 12 }}>
            {positions.total} positions · {Math.round((positions.heat?.totalRiskPct || 0) * 10) / 10}% heat
          </span>
        )}
        <button
          onClick={onRefresh}
          disabled={isRefreshing}
          onMouseEnter={() => setHovRefresh(true)}
          onMouseLeave={() => setHovRefresh(false)}
          style={{
            background: hovRefresh ? 'rgba(255,215,0,0.1)' : 'transparent',
            border: '1px solid #FFD700',
            color: '#FFD700',
            padding: '3px 10px',
            borderRadius: 4,
            cursor: isRefreshing ? 'wait' : 'pointer',
            fontSize: 11,
            fontFamily: 'monospace',
            fontWeight: 700,
            letterSpacing: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            boxShadow: hovRefresh ? '0 0 8px rgba(255,215,0,0.2)' : 'none',
            transition: 'all 0.15s',
          }}
        >
          <span style={{ display: 'inline-block', animation: isRefreshing ? 'spin 1s linear infinite' : 'none' }}>↻</span>
          {isRefreshing ? 'REFRESHING...' : 'REFRESH'}
        </button>
      </div>

      {/* Row 2: timestamp · data source badge */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px 7px', borderTop: `1px solid ${color}11` }}>
        <span style={{ color: '#555', fontSize: 11, fontFamily: 'monospace' }}>
          {formatTimestamp(lastRefresh)}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%',
            background: dataBadge.dot,
            boxShadow: `0 0 5px ${dataBadge.dot}`,
            animation: dataBadge.anim ? 'statusPulse 1s ease-in-out infinite' : 'none',
            flexShrink: 0,
          }} />
          <span style={{ color: dataBadge.dot, fontFamily: 'monospace' }}>Data: {dataBadge.label}</span>
        </span>
      </div>
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
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="#FFD700" strokeWidth={3} strokeLinecap="round" />
        {/* PNTHR head pivot */}
        <circle cx={cx} cy={cy} r={13} fill="#0a0a0a" stroke="#FFD700" strokeWidth={1.5} />
        <image href="/favicon.png" x={cx - 10} y={cy - 10} width={20} height={20} />
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
  const sep = (spy?.close && spy?.ema21 > 0) ? +((spy.close - spy.ema21) / spy.ema21 * 100).toFixed(1) : null;
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
      subLabel={spy?.ema21 > 0 ? `vs $${spy.ema21.toFixed(2)} EMA` : (spy?.close ? 'EMA pending' : regime?.weekOf ? `Week ${regime.weekOf}` : 'No data')}
      subValue={sep !== null ? `${sep > 0 ? '+' : ''}${sep}%` : (pos ? `${pos} EMA` : null)}
      subValueColor={sep !== null ? (sep >= 0 ? '#28a745' : '#dc3545') : (pos === 'above' ? '#28a745' : '#dc3545')}
    />
  );
}

function QqqGauge({ regime }) {
  const qqq = regime?.qqq;
  const sep = (qqq?.close && qqq?.ema21 > 0) ? +((qqq.close - qqq.ema21) / qqq.ema21 * 100).toFixed(1) : null;
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
      subLabel={qqq?.ema21 > 0 ? `vs $${qqq.ema21.toFixed(2)} EMA` : (qqq?.close ? 'EMA pending' : regime?.weekOf ? `Week ${regime.weekOf}` : 'No data')}
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

  const ssD1 = regime?.ssD1 ?? null;
  const blD1 = regime?.blD1 ?? null;

  return (
    <div style={{ flex: 1, minWidth: 200, background: bg, border: `2px solid ${border}33`, borderRadius: 12, padding: '16px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <div style={{ color: '#888', fontSize: 11, letterSpacing: 2, fontWeight: 700 }}>⚡ REGIME</div>
      <div style={{ color: labelColor, fontSize: 28, fontWeight: 900, letterSpacing: 4 }}>{label}</div>
      {ssD1 !== null && blD1 !== null ? (
        <div style={{ display: 'flex', gap: 12, fontSize: 12 }}>
          <span style={{ color: '#ff6b6b', fontWeight: 700 }}>SS {ssD1.toFixed(2)}×</span>
          <span style={{ color: '#555' }}>|</span>
          <span style={{ color: '#6bcb77', fontWeight: 700 }}>BL {blD1.toFixed(2)}×</span>
        </div>
      ) : (
        <div style={{ color: '#FFD700', fontSize: 13, fontWeight: 700 }}>D1 computing...</div>
      )}
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
          const yMid = (yTop + yBot) / 2;
          return (
            <g key={i}>
              <rect x={bx} y={yTop} width={bw} height={yBot - yTop} fill={z.color} opacity={0.2} rx={2} />
              <text x={bx + bw + 5} y={yMid + 3} fill={z.color} fontSize={7} opacity={0.85}>{z.label}</text>
            </g>
          );
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

function KillTop10({ killTop10, onTickerClick, killDataLive }) {
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ color: '#FFD700', fontSize: 12, fontWeight: 700, letterSpacing: 2 }}>⚡ PNTHR KILL TOP 10</span>
        {killDataLive === false && <span style={{ color: '#555', fontSize: 10, background: '#1a1a1a', padding: '1px 6px', borderRadius: 4 }}>Fri pipeline</span>}
        {killDataLive === true && <span style={{ color: '#28a745', fontSize: 10 }}>● live</span>}
      </div>
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

// ── PNTHR Sector Mini-Gauge ────────────────────────────────────────────────────
function PNTHRMiniGauge({ label, bl, ss, highlight, onClick }) {
  const [hovered, setHovered] = useState(false);
  const total = bl + ss;
  const ssRatio = total > 0 ? ss / total : 0.5;
  const W = 160, H = 96;
  const cx = W / 2, cy = H - 10, r = 66;

  const toAngle = (v) => Math.PI + v * Math.PI;
  const arcPath = (a1, a2) => {
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
    const large = Math.abs(a2 - a1) > Math.PI ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  };

  // Left = bearish (red), right = bullish (green) — matches SPY/QQQ convention
  // Needle tracks BL ratio: 0 = all SS (left/bearish), 1 = all BL (right/bullish)
  const blRatio = total > 0 ? bl / total : 0.5;
  const zones = [
    { from: 0,    to: 0.30, color: '#DC3545' },  // strongly bearish (left)
    { from: 0.30, to: 0.45, color: '#FF6B6B' },  // leaning bearish
    { from: 0.45, to: 0.55, color: '#555555' },  // neutral
    { from: 0.55, to: 0.70, color: '#6BCB77' },  // leaning bullish
    { from: 0.70, to: 1.00, color: '#28A745' },  // strongly bullish (right)
  ];

  const angle = toAngle(blRatio);
  const nx = cx + r * 0.78 * Math.cos(angle);
  const ny = cy + r * 0.78 * Math.sin(angle);

  const netPct = total > 0 ? Math.abs(ss - bl) / total * 100 : 0;
  const isBearish = ss >= bl;
  const dir = total === 0 ? '—' : `${netPct.toFixed(0)}% ${isBearish ? 'SS' : 'BL'}`;
  const dirColor = total === 0 ? '#555' : isBearish ? '#ff6b6b' : '#6bcb77';
  const textY = cy - r * 0.58;

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        background: highlight ? '#161610' : '#111',
        borderRadius: 10, padding: '8px 4px 8px',
        border: hovered ? '1px solid rgba(255,215,0,0.45)' : highlight ? '1px solid #FFD70033' : '1px solid transparent',
        cursor: onClick ? 'pointer' : 'default',
        transform: hovered && onClick ? 'scale(1.03)' : 'scale(1)',
        filter: hovered && onClick ? 'drop-shadow(0 0 5px rgba(255,215,0,0.25))' : 'none',
        transition: 'transform 0.15s ease, border-color 0.15s ease, filter 0.15s ease',
      }}
    >
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        {/* Background track */}
        <path d={arcPath(Math.PI, 2 * Math.PI)} fill="none" stroke="#1e1e1e" strokeWidth={13} />
        {/* Color zones */}
        {zones.map((z, i) => (
          <path key={i} d={arcPath(toAngle(z.from), toAngle(z.to))} fill="none" stroke={z.color} strokeWidth={11} opacity={0.75} />
        ))}
        {/* BL/SS counts inside arc */}
        <text x={cx} y={textY} textAnchor="middle" fill="#ccc" fontSize={11} fontFamily="monospace" fontWeight={600}>
          {`↑${bl} ↓${ss}`}
        </text>
        {/* Needle */}
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="#FFD700" strokeWidth={3} strokeLinecap="round" />
        {/* PNTHR head pivot */}
        <circle cx={cx} cy={cy} r={13} fill="#0a0a0a" stroke="#FFD700" strokeWidth={1.5} />
        <image href="/favicon.png" x={cx - 11} y={cy - 11} width={22} height={22} />
      </svg>
      <div style={{ color: '#FFD700', fontSize: 12, fontWeight: 700, textAlign: 'center', lineHeight: 1.2, marginTop: -2, padding: '0 4px' }}>{label}</div>
      <div style={{ color: dirColor, fontSize: 11, fontWeight: 600, marginTop: 2 }}>{dir}</div>
    </div>
  );
}

const ALIASES = {
  'Consumer Defensive': 'Consumer Staples',
  'Consumer Discretionary': 'Consumer Cyclical',
};
const SECTOR_CONFIG = [
  { key: 'Technology',             label: 'Technology'            },
  { key: 'Healthcare',             label: 'Healthcare'            },
  { key: 'Financial Services',     label: 'Financials'            },
  { key: 'Industrials',            label: 'Industrials'           },
  { key: 'Consumer Staples',       label: 'Consumer Staples'      },
  { key: 'Energy',                 label: 'Energy'                },
  { key: 'Utilities',              label: 'Utilities'             },
  { key: 'Basic Materials',        label: 'Basic Materials'       },
  { key: 'Communication Services', label: 'Communication'         },
  { key: 'Real Estate',            label: 'Real Estate'           },
  { key: 'Consumer Cyclical',      label: 'Consumer Disc.'        },
  { key: '__ALL__',                label: 'ALL SECTORS'           },
];

// Maps Pulse sector keys to SectorPage ETF tickers (sessionStorage handshake)
const SECTOR_KEY_TO_ETF = {
  'Technology':             'XLK',
  'Healthcare':             'XLV',
  'Financial Services':     'XLF',
  'Industrials':            'XLI',
  'Consumer Staples':       'XLP',
  'Energy':                 'XLE',
  'Utilities':              'XLU',
  'Basic Materials':        'XLB',
  'Communication Services': 'XLC',
  'Real Estate':            'XLRE',
  'Consumer Cyclical':      'XLY',
};

function SectorPulse({ signals, killDataLive, onNavigate }) {
  const rawBySector = signals?.bySector || {};
  const bySector = {};
  for (const [sector, counts] of Object.entries(rawBySector)) {
    const canonical = ALIASES[sector] || sector;
    if (!bySector[canonical]) bySector[canonical] = { bl: 0, ss: 0 };
    bySector[canonical].bl += counts.bl || 0;
    bySector[canonical].ss += counts.ss || 0;
  }

  const handleSectorClick = (key) => {
    if (key === '__ALL__') {
      onNavigate?.('sectors');
      return;
    }
    const etf = SECTOR_KEY_TO_ETF[key];
    if (etf) sessionStorage.setItem('pnthr-sector-etf', etf);
    onNavigate?.('sectors');
  };

  return (
    <div style={{ flex: 1, minWidth: 600, background: '#111', borderRadius: 12, padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ color: '#FFD700', fontSize: 12, fontWeight: 700, letterSpacing: 2 }}>⚡ PNTHR SECTOR PULSE</span>
        {killDataLive === false && <span style={{ color: '#555', fontSize: 10, background: '#1a1a1a', padding: '1px 6px', borderRadius: 4 }}>Fri pipeline</span>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 6 }}>
        {SECTOR_CONFIG.map(({ key, label }) => {
          const d = key === '__ALL__'
            ? { bl: signals?.blCount || 0, ss: signals?.ssCount || 0 }
            : (bySector[key] || { bl: 0, ss: 0 });
          return (
            <PNTHRMiniGauge
              key={key}
              label={label}
              bl={d.bl}
              ss={d.ss}
              highlight={key === '__ALL__'}
              onClick={() => handleSectorClick(key)}
            />
          );
        })}
      </div>
    </div>
  );
}

// ── New Signals This Week Panel ────────────────────────────────────────────────
function NewSignalsPanel({ newSignals, onTickerClick }) {
  if (!newSignals) return null;
  const { blStocks = [], blEtfs = [], ssStocks = [], ssEtfs = [] } = newSignals;
  const totalBL = blStocks.length + blEtfs.length;
  const totalSS = ssStocks.length + ssEtfs.length;
  if (totalBL === 0 && totalSS === 0) return (
    <div style={{ background: '#111', borderRadius: 12, padding: '12px 16px', marginBottom: 12, color: '#444', fontSize: 12, fontFamily: 'monospace' }}>
      <span style={{ color: '#FFD700', letterSpacing: 2, fontSize: 11 }}>⚡ NEW SIGNALS THIS WEEK</span>
      <span style={{ marginLeft: 16 }}>No new signals this week.</span>
    </div>
  );

  // Build chart list for navigation within each direction group
  function makeChartList(stocks) {
    return stocks.map(s => ({ ticker: s.ticker, symbol: s.ticker, currentPrice: s.currentPrice, signal: s.signal, sector: s.sector }));
  }
  const blAll  = [...blStocks, ...blEtfs];
  const ssAll  = [...ssStocks, ...ssEtfs];
  const blChartList = makeChartList(blAll);
  const ssChartList = makeChartList(ssAll);

  function NewSigRow({ s, idx, chartList }) {
    const t = tierBadge(s.tier);
    return (
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 10px',
          borderBottom: '1px solid #1a1a1a', cursor: 'pointer',
          transition: 'background 0.15s' }}
        onMouseEnter={e => e.currentTarget.style.background = '#1e1e1e'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        onClick={() => onTickerClick(chartList, idx)}
      >
        <span style={{ color: '#FFD700', fontWeight: 800, fontSize: 13, minWidth: 48, fontFamily: 'monospace' }}>{s.ticker}</span>
        <span style={{ color: '#555', fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.sector || '—'}</span>
        <span style={{ color: '#ccc', fontSize: 12, minWidth: 58, textAlign: 'right', fontFamily: 'monospace' }}>
          {s.currentPrice ? `$${(+s.currentPrice).toFixed(2)}` : '—'}
        </span>
        <span style={{ color: '#fff', fontWeight: 700, fontSize: 12, minWidth: 42, textAlign: 'right', fontFamily: 'monospace' }}>
          {s.totalScore != null ? s.totalScore.toFixed(1) : '—'}
        </span>
        <span style={{ minWidth: 80 }}>{t}</span>
        <span style={{ color: '#FFD700', fontSize: 12 }}>▸</span>
      </div>
    );
  }

  function SignalSection({ label, stocks, etfs, direction }) {
    const borderColor = direction === 'BL' ? '#28a745' : '#dc3545';
    const headerBg    = direction === 'BL' ? 'rgba(40,167,69,0.12)' : 'rgba(220,53,69,0.12)';
    const badgeColor  = direction === 'BL' ? '#6bcb77' : '#ff6b6b';
    const chartList   = direction === 'BL' ? blChartList : ssChartList;
    const label2      = direction === 'BL' ? 'NEW BUY LONG (BL+1)' : 'NEW SELL SHORT (SS+1)';
    const all = [...stocks, ...etfs];
    if (all.length === 0) return (
      <div style={{ flex: 1, border: `1px solid ${borderColor}33`, borderLeft: `3px solid ${borderColor}`, borderRadius: 8, padding: '10px 14px', color: '#444', fontSize: 12 }}>
        <div style={{ color: badgeColor, fontSize: 11, fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>{label2}</div>
        <div style={{ color: '#333' }}>No new {direction === 'BL' ? 'BL' : 'SS'} signals.</div>
      </div>
    );
    const stockOffset = 0;
    const etfOffset   = stocks.length;
    return (
      <div style={{ flex: 1, border: `1px solid ${borderColor}33`, borderLeft: `3px solid ${borderColor}`, borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ background: headerBg, padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: badgeColor, fontSize: 11, fontWeight: 700, letterSpacing: 1 }}>{label2}</span>
        </div>
        {stocks.length > 0 && (
          <>
            <div style={{ padding: '4px 10px 2px', color: '#444', fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', background: '#0d0d0d' }}>
              Stocks ({stocks.length})
            </div>
            {stocks.map((s, i) => <NewSigRow key={s.ticker} s={s} idx={stockOffset + i} chartList={chartList} />)}
          </>
        )}
        {etfs.length > 0 && (
          <>
            <div style={{ padding: '4px 10px 2px', color: '#444', fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', background: '#0d0d0d' }}>
              ETFs ({etfs.length})
            </div>
            {etfs.map((s, i) => <NewSigRow key={s.ticker} s={s} idx={etfOffset + i} chartList={chartList} />)}
          </>
        )}
      </div>
    );
  }

  return (
    <div style={{ background: '#111', borderRadius: 12, padding: '12px 16px', marginBottom: 12 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <span style={{ color: '#FFD700', fontSize: 11, letterSpacing: 2, fontFamily: 'monospace' }}>⚡ NEW SIGNALS THIS WEEK</span>
        {totalBL > 0 && <span style={{ color: '#6bcb77', fontSize: 11, fontWeight: 700 }}>{totalBL} BL+1</span>}
        {totalBL > 0 && totalSS > 0 && <span style={{ color: '#333', fontSize: 11 }}>|</span>}
        {totalSS > 0 && <span style={{ color: '#ff6b6b', fontSize: 11, fontWeight: 700 }}>{totalSS} SS+1</span>}
      </div>
      {/* Two columns: BL | SS */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <SignalSection direction="BL" stocks={blStocks} etfs={blEtfs} />
        <SignalSection direction="SS" stocks={ssStocks} etfs={ssEtfs} />
      </div>
    </div>
  );
}

function SignalBreadthBar({ signals, onSignalClick }) {
  const [hovBl, setHovBl] = useState(false);
  const [hovSs, setHovSs] = useState(false);
  const bl = signals?.blCount || 0, ss = signals?.ssCount || 0;
  const total = bl + ss;
  const blPct = total > 0 ? (bl / total) * 100 : 50;

  return (
    <div style={{ background: '#111', borderRadius: 12, padding: '12px 16px', marginBottom: 12 }}>
      <div style={{ color: '#888', fontSize: 11, letterSpacing: 2, marginBottom: 8 }}>⚡ SIGNAL BREADTH</div>
      <div style={{ display: 'flex', height: 22, borderRadius: 4, overflow: 'hidden', marginBottom: 6 }}>
        <div
          onClick={() => onSignalClick?.('BL')}
          onMouseEnter={() => setHovBl(true)}
          onMouseLeave={() => setHovBl(false)}
          style={{ width: `${blPct}%`, background: '#28a745', opacity: hovBl ? 1 : 0.7, cursor: 'pointer', transition: 'opacity 0.15s' }}
        />
        <div
          onClick={() => onSignalClick?.('SS')}
          onMouseEnter={() => setHovSs(true)}
          onMouseLeave={() => setHovSs(false)}
          style={{ width: `${100 - blPct}%`, background: '#dc3545', opacity: hovSs ? 1 : 0.7, cursor: 'pointer', transition: 'opacity 0.15s' }}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#ccc' }}>
        <span
          onClick={() => onSignalClick?.('BL')}
          style={{ color: '#6bcb77', cursor: 'pointer', fontWeight: 700, textDecoration: 'underline', textDecorationColor: 'rgba(107,203,119,0.4)' }}
        >{bl} BL</span>
        <span style={{ color: '#888', fontSize: 11 }}>Ratio: {(signals?.ratio || 0).toFixed(1)}:1 SS:BL</span>
        <span
          onClick={() => onSignalClick?.('SS')}
          style={{ color: '#ff6b6b', cursor: 'pointer', fontWeight: 700, textDecoration: 'underline', textDecorationColor: 'rgba(255,107,107,0.4)' }}
        >{ss} SS</span>
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

// ── Signal Stock Drill-Down Modal ──────────────────────────────────────────────
const TIER_BADGE = {
  'ALPHA PNTHR KILL': { bg: 'rgba(212,160,23,0.25)', color: '#FFD700' },
  'STRIKING':         { bg: 'rgba(40,167,69,0.2)',   color: '#6bcb77' },
  'HUNTING':          { bg: 'rgba(32,120,55,0.2)',   color: '#4a9',   },
  'POUNCING':         { bg: 'rgba(20,160,140,0.2)',  color: '#4dd',   },
  'COILING':          { bg: 'rgba(30,100,180,0.2)',  color: '#69b',   },
  'STALKING':         { bg: 'rgba(80,80,120,0.2)',   color: '#99a',   },
};

function tierBadge(tier) {
  if (!tier) return null;
  const key = Object.keys(TIER_BADGE).find(k => tier.includes(k)) || null;
  const { bg, color } = key ? TIER_BADGE[key] : { bg: '#1a1a1a', color: '#666' };
  const short = tier.includes('ALPHA') ? 'ALPHA' : tier.split(' ')[0];
  return <span style={{ background: bg, color, fontSize: 10, padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>{short}</span>;
}

const SORT_COLS = ['ticker', 'sector', 'currentPrice', 'totalScore', 'tier', 'signalAge'];

function SignalStockModal({ signal, onClose, onTickerClick }) {
  const [stocks, setStocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sortCol, setSortCol] = useState('totalScore');
  const [sortDir, setSortDir] = useState(-1); // -1 = desc, 1 = asc

  useEffect(() => {
    setLoading(true);
    fetchSignalStocks(signal)
      .then(data => setStocks(data.stocks || []))
      .catch(err => console.error(err))
      .finally(() => setLoading(false));
  }, [signal]);

  const sorted = [...stocks].sort((a, b) => {
    const av = a[sortCol] ?? '', bv = b[sortCol] ?? '';
    if (typeof av === 'number') return (av - bv) * sortDir;
    return String(av).localeCompare(String(bv)) * sortDir;
  });

  const handleSort = (col) => {
    if (sortCol === col) setSortDir(d => d * -1);
    else { setSortCol(col); setSortDir(-1); }
  };

  const isBL = signal === 'BL';
  const headerColor = isBL ? '#6bcb77' : '#ff6b6b';
  const headerBg = isBL ? 'rgba(40,167,69,0.12)' : 'rgba(220,53,69,0.12)';

  const ColHeader = ({ col, label }) => (
    <th
      onClick={() => handleSort(col)}
      style={{ padding: '8px 10px', textAlign: 'left', color: sortCol === col ? '#FFD700' : '#666', fontWeight: 700, fontSize: 11, letterSpacing: 1, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
    >
      {label}{sortCol === col ? (sortDir === -1 ? ' ↓' : ' ↑') : ''}
    </th>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={{ background: '#0f0f0f', border: `1px solid ${headerColor}33`, borderRadius: 12, width: '100%', maxWidth: 860, maxHeight: '85vh', display: 'flex', flexDirection: 'column', fontFamily: 'monospace' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid #1a1a1a', background: headerBg, borderRadius: '12px 12px 0 0' }}>
          <span style={{ color: '#FFD700', fontWeight: 800, fontSize: 14, letterSpacing: 2 }}>
            ⚡ {loading ? '...' : sorted.length} {isBL ? 'BUY LONG (BL)' : 'SELL SHORT (SS)'} SIGNALS
          </span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#888', fontSize: 20, cursor: 'pointer', lineHeight: 1 }}>✕</button>
        </div>

        {/* Table */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {loading ? (
            <div style={{ color: '#555', textAlign: 'center', padding: 40, fontSize: 13 }}>Loading signals...</div>
          ) : sorted.length === 0 ? (
            <div style={{ color: '#555', textAlign: 'center', padding: 40, fontSize: 13 }}>No {signal} signals in current data.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead style={{ position: 'sticky', top: 0, background: '#0f0f0f', borderBottom: '1px solid #222' }}>
                <tr>
                  <ColHeader col="ticker" label="TICKER" />
                  <ColHeader col="sector" label="SECTOR" />
                  <ColHeader col="currentPrice" label="PRICE" />
                  <ColHeader col="totalScore" label="KILL SCORE" />
                  <ColHeader col="tier" label="TIER" />
                  <ColHeader col="signalAge" label="AGE" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((s, i) => (
                  <tr key={s.ticker} style={{ borderBottom: '1px solid #111', background: i % 2 === 0 ? 'transparent' : '#0a0a0a' }}>
                    <td style={{ padding: '7px 10px' }}>
                      <span
                        onClick={() => {
                          const chartStocks = sorted.map(x => ({ ticker: x.ticker, symbol: x.ticker, currentPrice: x.currentPrice, signal, sector: x.sector }));
                          onTickerClick(chartStocks, i);
                        }}
                        style={{ color: '#FFD700', fontWeight: 800, fontSize: 13, cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'rgba(212,160,23,0.4)' }}
                      >{s.ticker}</span>
                    </td>
                    <td style={{ padding: '7px 10px', color: '#888', fontSize: 12 }}>{s.sector || '—'}</td>
                    <td style={{ padding: '7px 10px', color: '#ccc', fontSize: 12 }}>{s.currentPrice ? `$${(+s.currentPrice).toFixed(2)}` : '—'}</td>
                    <td style={{ padding: '7px 10px', color: '#fff', fontWeight: 700, fontSize: 13 }}>{s.totalScore?.toFixed(1) ?? '—'}</td>
                    <td style={{ padding: '7px 10px' }}>{tierBadge(s.tier)}</td>
                    <td style={{ padding: '7px 10px', color: '#555', fontSize: 11 }}>{s.signalAge != null ? `${s.signalAge}w` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        {!loading && sorted.length > 0 && (
          <div style={{ padding: '10px 20px', borderTop: '1px solid #1a1a1a', color: '#555', fontSize: 11, textAlign: 'right' }}>
            Sorted by {sortCol} {sortDir === -1 ? '↓' : '↑'} · Click column headers to sort · Click ticker for chart
          </div>
        )}
      </div>
    </div>
  );
}

// ── Tier 3: Combined Portfolio Status panel ────────────────────────────────────
function PortfolioStatus({ positions, lotsReady, onNavigate }) {
  const heat = positions?.heat || {};
  const nav = positions?.nav || 100000;

  const alerts = [];
  if (heat.stockRiskPct > 10) alerts.push({ icon: '🔴', text: `Stock risk ${heat.stockRiskPct.toFixed(1)}% exceeds 10% cap` });
  if (heat.etfRiskPct > 5) alerts.push({ icon: '🔴', text: `ETF risk ${heat.etfRiskPct.toFixed(1)}% exceeds 5% cap` });
  if (heat.totalRiskPct > 13) alerts.push({ icon: '🟡', text: `Total heat ${heat.totalRiskPct.toFixed(1)}% approaching 15% cap` });

  const lotsCount = lotsReady?.length || 0;
  if (lotsCount > 0) alerts.push({ icon: '🟢', text: `${lotsCount} lot${lotsCount > 1 ? 's' : ''} READY to fill` });

  const remaining = Math.max(0, 15 - (heat.totalRiskPct || 0));

  return (
    <div style={{ background: '#111', borderRadius: 12, padding: '16px 20px', marginTop: 12 }}>
      <div style={{ color: '#FFD700', fontSize: 11, fontWeight: 700, letterSpacing: 2, marginBottom: 14 }}>⚡ PNTHR PORTFOLIO STATUS</div>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>

        {/* Heat Gauge */}
        <HeatGauge positions={positions} />

        {/* Positions Summary */}
        <div style={{ minWidth: 180, display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 8 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#fff', lineHeight: 1 }}>{positions?.total || 0} Active</div>
          <div style={{ fontSize: 13, color: '#888' }}>{positions?.short || 0} Short · {positions?.long || 0} Long</div>
          {(positions?.recycled || 0) > 0 && (
            <div style={{ fontSize: 12, color: '#555' }}>{positions.recycled} Recycled ($0 risk)</div>
          )}
          <div style={{ fontSize: 13, color: '#ccc', marginTop: 4 }}>
            Stock: <strong style={{ color: heat.stockRiskPct > 10 ? '#ff8c00' : '#ccc' }}>{(heat.stockRiskPct || 0).toFixed(1)}%</strong>
            <span style={{ color: '#555' }}> / 10%</span>
          </div>
          <div style={{ fontSize: 13, color: '#ccc' }}>
            ETF: <strong style={{ color: heat.etfRiskPct > 5 ? '#ff8c00' : '#ccc' }}>{(heat.etfRiskPct || 0).toFixed(1)}%</strong>
            <span style={{ color: '#555' }}> / 5%</span>
          </div>
          <div style={{ fontSize: 12, color: '#28a745', marginTop: 2 }}>
            ${Math.round(remaining / 100 * nav).toLocaleString()} capacity left
          </div>
          <div onClick={() => onNavigate?.('command')} style={{ marginTop: 8, color: '#FFD700', fontSize: 11, cursor: 'pointer', letterSpacing: 1 }}>GO TO COMMAND →</div>
        </div>

        {/* Alerts + Lots Ready */}
        <div style={{ flex: 1, minWidth: 200, display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 8 }}>
          <div style={{ color: '#888', fontSize: 11, fontWeight: 700, letterSpacing: 1.5, marginBottom: 4 }}>ALERTS & LOTS</div>
          {alerts.length === 0
            ? <div style={{ color: '#28a745', fontSize: 12 }}>✅ No active alerts. All clear.</div>
            : alerts.map((a, i) => (
              <div key={i} style={{ fontSize: 12, color: '#ccc' }}>{a.icon} {a.text}</div>
            ))
          }
          {lotsCount > 0 && (
            <div style={{ marginTop: 6 }}>
              {(lotsReady || []).map((l, i) => (
                <div key={i} style={{ fontSize: 12, color: '#6bcb77', marginBottom: 2 }}>
                  ▶ {l.ticker} Lot {l.lot} @ ${l.triggerPrice}
                </div>
              ))}
            </div>
          )}
          <div onClick={() => onNavigate?.('command')} style={{ marginTop: 8, color: '#FFD700', fontSize: 11, cursor: 'pointer', letterSpacing: 1 }}>VIEW RISK ADVISOR →</div>
        </div>

      </div>
    </div>
  );
}
