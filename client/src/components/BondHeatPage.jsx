import { useState, useEffect, useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceArea,
} from 'recharts';
import { apiFetch, authHeaders, API_BASE } from '../services/api';
import styles from './BondHeatPage.module.css';

// ── Heat map colors ─────────────────────────────────────────────────────────

function getHeatColor(pct) {
  if (pct == null) return '#333';
  if (pct >= 4) return '#00c853';
  if (pct >= 3) return '#00e676';
  if (pct >= 2) return '#69f0ae';
  if (pct >= 1) return '#a5d6a7';
  if (pct >= 0.5) return '#c8e6c9';
  if (pct > 0) return '#e8f5e9';
  if (pct === 0) return '#424242';
  if (pct > -0.5) return '#ffebee';
  if (pct > -1) return '#ffcdd2';
  if (pct > -2) return '#ef9a9a';
  if (pct > -3) return '#e57373';
  if (pct > -4) return '#ef5350';
  return '#d32f2f';
}

function getTextColor(pct) {
  if (pct == null) return '#888';
  if (Math.abs(pct) >= 2) return '#fff';
  return '#111';
}

// ── Chart helpers ───────────────────────────────────────────────────────────

const CHART_COLORS = { y2: '#4fc3f7', y10: '#ffd600', y30: '#ff7043', spy: '#69f0ae', pai300: '#ffcc00', spread: '#ce93d8', spread1030: '#4dd0e1' };

function formatDateShort(dateStr) {
  if (!dateStr) return '';
  const [, m, d] = dateStr.split('-');
  return `${+m}/${+d}`;
}

function YieldChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className={styles.chartTooltip}>
      <div className={styles.tooltipDate}>{label}</div>
      {payload.map(p => (
        <div key={p.dataKey} style={{ color: p.color }}>
          {p.name}: {p.dataKey === 'spy'
            ? (p.value != null ? `$${p.value.toFixed(2)}` : '—')
            : p.dataKey === 'pai300'
            ? (p.value != null ? p.value.toFixed(2) : '—')
            : (p.dataKey === 'spyPct' || p.dataKey === 'pai300Pct')
            ? (p.value != null ? `${p.value > 0 ? '+' : ''}${p.value.toFixed(2)}%` : '—')
            : (p.value != null ? `${p.value.toFixed(3)}%` : '—')}
        </div>
      ))}
    </div>
  );
}

function YieldChart({ data, title, subtitle, lines, refLines, shockZones, dangerZones, height = 180, onClick, dualAxis, syncId, children }) {
  return (
    <div className={styles.chartCard} onClick={onClick} style={onClick ? { cursor: 'pointer' } : undefined}>
      <div className={styles.chartTitleRow}>
        <div>
          <div className={styles.chartTitle}>{title}</div>
          {subtitle && <div className={styles.chartSubtitle}>{subtitle}</div>}
        </div>
        {children}
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} syncId={syncId} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#333" />
          <XAxis dataKey="date" tickFormatter={formatDateShort} tick={{ fill: '#888', fontSize: 10 }} interval="preserveStartEnd" minTickGap={40} />
          <YAxis yAxisId="left" tick={{ fill: '#888', fontSize: 10 }} domain={['auto', 'auto']} tickFormatter={v => `${v}%`} />
          <YAxis yAxisId="right" orientation="right" width={50} tick={dualAxis ? { fill: '#69f0ae', fontSize: 10 } : false} domain={['auto', 'auto']} tickFormatter={dualAxis ? (v => `$${v}`) : () => ''} />
          <Tooltip content={<YieldChartTooltip />} />
          {dangerZones?.map((zone, i) => (
            <ReferenceArea key={`dz-${i}`} x1={zone.start} x2={zone.end} yAxisId="left" fill={zone.color} fillOpacity={0.08} />
          ))}
          {shockZones?.map((zone, i) => (
            <ReferenceArea key={`sz-${i}`} x1={zone.start} x2={zone.end} yAxisId="left" fill="#ff9800" fillOpacity={0.18} stroke="#ff9800" strokeOpacity={0.3} label={{ value: 'YIELD SHOCK', fill: '#ff9800', fontSize: 9, fontWeight: 700, position: 'insideTop' }} />
          ))}
          {refLines?.map((rl, i) => (
            <ReferenceLine key={i} y={rl.y} yAxisId="left" stroke={rl.color || '#ff5252'} strokeDasharray="5 3" label={{ value: rl.label, fill: rl.color || '#ff5252', fontSize: 10, position: 'insideTopLeft' }} />
          ))}
          {lines.map(l => (
            <Line key={l.key} type="monotone" dataKey={l.key} name={l.name} stroke={l.color} dot={false} strokeWidth={l.width || 2} yAxisId={l.axis || 'left'} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Info popup ──────────────────────────────────────────────────────────────

function InfoPopup({ title, children, onClose }) {
  return (
    <div className={styles.infoOverlay} onClick={onClose}>
      <div className={styles.infoPanel} onClick={e => e.stopPropagation()}>
        <button className={styles.modalClose} onClick={onClose}>✕</button>
        <div className={styles.infoTitle}>{title}</div>
        <div className={styles.infoBody}>{children}</div>
      </div>
    </div>
  );
}

// ── Chart modal ─────────────────────────────────────────────────────────────

function ChartModal({ data, chart, shockZones, dangerZones, onClose }) {
  if (!chart) return null;

  const configs = {
    yields: {
      title: '2Y / 10Y / 30Y Treasury Yields + S&P 500',
      subtitle: 'Red zones = Yield Shock (10Y rose 20+ bps in 10 days)',
      lines: [
        { key: 'y2', name: '2-Year', color: CHART_COLORS.y2 },
        { key: 'y10', name: '10-Year', color: CHART_COLORS.y10 },
        { key: 'y30', name: '30-Year', color: CHART_COLORS.y30 },
        { key: 'spy', name: 'S&P 500', color: CHART_COLORS.spy, axis: 'right', width: 1.5 },
      ],
      refLines: [
        { y: 4.5, label: '2Y/10Y Alert 4.50%', color: '#ffd600' },
        { y: 5.0, label: '30Y Alert 5.00%', color: '#ff7043' },
      ],
      dualAxis: true,
    },
    spread2_10: {
      title: '2Y / 10Y Yield Spread',
      subtitle: 'Fed Policy + Recession Risk',
      lines: [
        { key: 'spread2_10', name: '10Y - 2Y Spread', color: CHART_COLORS.spread },
      ],
      refLines: [
        { y: 0, label: 'Inversion', color: '#ef5350' },
      ],
    },
    spread10_30: {
      title: '10Y / 30Y Yield Spread',
      subtitle: 'Long-Term Inflation & Fiscal Concerns',
      lines: [
        { key: 'spread10_30', name: '30Y - 10Y Spread', color: CHART_COLORS.spread1030 },
      ],
      refLines: [],
    },
  };

  const cfg = configs[chart];

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modalContent} onClick={e => e.stopPropagation()}>
        <button className={styles.modalClose} onClick={onClose}>✕</button>
        <YieldChart
          data={data}
          title={cfg.title}
          subtitle={cfg.subtitle}
          lines={cfg.lines}
          refLines={cfg.refLines}
          shockZones={chart === 'yields' ? shockZones : undefined}
          dangerZones={chart === 'yields' ? dangerZones : undefined}
          dualAxis={cfg.dualAxis}
          height={420}
        />
      </div>
    </div>
  );
}

// ── Yield Shock Warning Banner ──────────────────────────────────────────────

function YieldShockBanner({ history, bonds }) {
  const latest = history.length ? history[history.length - 1] : null;
  const isShockActive = latest?.yieldShock;
  const y2Above = bonds?.y2 >= 4.5;
  const y10Above = bonds?.y10 >= 4.5;
  const y30Above = bonds?.y30 >= 5.0;
  const dangerCount = [isShockActive, y2Above, y10Above, y30Above].filter(Boolean).length;

  if (dangerCount === 0) return null;

  // Find the 10Y move over last 10 data points
  let bpsMove = null;
  if (history.length >= 11) {
    const cur = history[history.length - 1]?.y10;
    const prev = history[history.length - 11]?.y10;
    if (cur != null && prev != null) bpsMove = Math.round((cur - prev) * 100);
  }

  const level = dangerCount >= 4 ? 'critical' : dangerCount >= 3 ? 'critical' : dangerCount >= 2 ? 'high' : 'elevated';
  const levelLabels = { critical: 'CRITICAL', high: 'HIGH', elevated: 'ELEVATED' };
  const levelClass = { critical: 'shockCritical', high: 'shockHigh', elevated: 'shockElevated' };

  return (
    <div className={`${styles.shockBanner} ${styles[levelClass[level]]}`}>
      <div className={styles.shockHeader}>
        <span className={styles.shockIcon}>⚠</span>
        <span className={styles.shockTitle}>YIELD SHOCK — {levelLabels[level]} RISK</span>
      </div>
      <div className={styles.shockDetails}>
        {isShockActive && (
          <span className={styles.shockTag}>10Y VELOCITY: +{bpsMove || '20+'}bps / 10 days</span>
        )}
        {y2Above && (
          <span className={styles.shockTag}>2Y ABOVE 4.50%: {bonds.y2.toFixed(2)}% — RATE CUTS PRICED OUT</span>
        )}
        {y10Above && (
          <span className={styles.shockTag}>10Y ABOVE 4.50%: {bonds.y10.toFixed(2)}%</span>
        )}
        {y30Above && (
          <span className={styles.shockTag}>30Y ABOVE 5.00%: {bonds.y30.toFixed(2)}%</span>
        )}
      </div>
      <div className={styles.shockAction}>
        {dangerCount >= 4
          ? 'Full alarm — all yield thresholds breached, max defensive posture, tighten all stops'
          : dangerCount >= 3
          ? 'Triple threat active — tighten all stops, avoid new longs, watch for capitulation'
          : dangerCount >= 2
          ? 'Rate pressure elevated — tighten stops, reduce exposure to rate-sensitive names'
          : 'Monitor closely — rates approaching danger levels'}
      </div>
    </div>
  );
}

// ── Market Interpretation ──────────────────────────────────────────────────

function MarketInterpretation({ bonds, breadth, history, comparisonData }) {
  if (!bonds || !history.length) return null;

  const latest = history[history.length - 1];
  const isShock = latest?.yieldShock;
  const y2Above = bonds.y2 >= 4.5;
  const y10Above = bonds.y10 >= 4.5;
  const y30Above = bonds.y30 >= 5.0;

  // PAI300 beta
  let beta = null;
  if (history.length >= 22) {
    const recent = history.slice(-21);
    const returns = [];
    for (let i = 1; i < recent.length; i++) {
      const sp = recent[i - 1].spy, sc = recent[i].spy;
      const pp = recent[i - 1].pai300, pc = recent[i].pai300;
      if (sp && sc && pp && pc) returns.push({ spy: (sc - sp) / sp, pai: (pc - pp) / pp });
    }
    if (returns.length >= 10) {
      const n = returns.length;
      const aS = returns.reduce((s, r) => s + r.spy, 0) / n;
      const aP = returns.reduce((s, r) => s + r.pai, 0) / n;
      let cov = 0, v = 0;
      for (const r of returns) { cov += (r.spy - aS) * (r.pai - aP); v += (r.spy - aS) ** 2; }
      if (v > 0) beta = +(cov / v).toFixed(2);
    }
  }

  // PAI300 vs SPY recent divergence
  const lastComp = comparisonData?.length ? comparisonData[comparisonData.length - 1] : null;
  const paiLead = lastComp?.pai300Pct != null && lastComp?.spyPct != null
    ? +(lastComp.pai300Pct - lastComp.spyPct).toFixed(2)
    : null;

  // Breadth ratio
  const breadthPct = breadth.total > 0 ? Math.round((breadth.advancers / breadth.total) * 100) : null;

  const signals = [];

  // Yield shock
  if (isShock) {
    signals.push({ icon: '🔴', text: 'YIELD SHOCK ACTIVE — 10Y has risen 20+ bps in 10 trading days. This is a rate-driven selloff signal. Avoid adding new long positions until the shock clears.' });
  }

  // 2Y signal
  if (y2Above) {
    signals.push({ icon: '🔵', text: `2Y at ${bonds.y2.toFixed(2)}% (above 4.50%) — the market is pricing out near-term rate cuts. Growth and AI stocks face headwinds from "higher for longer" expectations.` });
  }

  // 10Y signal
  if (y10Above) {
    signals.push({ icon: '🟡', text: `10Y at ${bonds.y10.toFixed(2)}% (above 4.50%) — discount rates are elevated, compressing high-multiple AI stock valuations. The higher this goes, the more growth stocks suffer.` });
  }

  // 30Y signal
  if (y30Above) {
    signals.push({ icon: '🟠', text: `30Y at ${bonds.y30.toFixed(2)}% (above 5.00%) — the bond market is signaling concern about long-term inflation, deficit sustainability, or waning foreign demand for US debt.` });
  }

  // Beta interpretation
  if (beta != null) {
    if (beta > 1.3) {
      signals.push({ icon: '⚡', text: `PAI 300 Beta is ${beta}x — AI stocks are moving ${beta}x as much as the S&P 500. In a rate shock, expect PAI 300 to sell off significantly harder than the broad market.` });
    } else if (beta > 1.0) {
      signals.push({ icon: '📊', text: `PAI 300 Beta is ${beta}x — AI stocks are slightly more sensitive than the broad market to rate moves. Watch for acceleration if yields spike further.` });
    } else {
      signals.push({ icon: '✅', text: `PAI 300 Beta is ${beta}x — AI stocks are tracking close to or below the broad market's rate sensitivity. Relatively defensive posture for AI names.` });
    }
  }

  // PAI300 outperformance
  if (paiLead != null) {
    if (paiLead > 3) {
      signals.push({ icon: '🟢', text: `PAI 300 is outperforming SPY by +${paiLead.toFixed(1)}% since period start. AI names are leading — risk appetite is strong despite rate levels.` });
    } else if (paiLead < -3) {
      signals.push({ icon: '🔻', text: `PAI 300 is underperforming SPY by ${paiLead.toFixed(1)}%. AI stocks are lagging — rate pressure or rotation into value is hurting growth names.` });
    }
  }

  // Breadth
  if (breadthPct != null) {
    if (breadthPct < 30) {
      signals.push({ icon: '📉', text: `Only ${breadthPct}% of AI 300 stocks are positive today. Broad-based selling — this is not isolated weakness, it's a sector-wide retreat.` });
    } else if (breadthPct > 70) {
      signals.push({ icon: '📈', text: `${breadthPct}% of AI 300 stocks are positive today. Broad-based buying — the sector is moving together with conviction.` });
    }
  }

  // All-clear
  if (signals.length === 0) {
    signals.push({ icon: '✅', text: 'All yield levels are below danger thresholds. No shock detected. Normal trading conditions — proceed with standard position sizing and entries.' });
  }

  return (
    <div className={styles.interpretationBanner}>
      <div className={styles.interpretationTitle}>BOND HEAT MARKET READ</div>
      <div className={styles.interpretationBody}>
        {signals.map((s, i) => (
          <div key={i} className={styles.interpretationRow}>
            <span className={styles.interpretationIcon}>{s.icon}</span>
            <span>{s.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Yield Shock Meter (10 boxes, 10Y cumulative) ────────────────────────────

function YieldShockMeter({ history }) {
  if (history.length < 11) return null;

  const last10 = history.slice(-10);
  const anchor = history[history.length - 11]?.y10;

  const boxes = last10.map(row => {
    if (anchor == null || row.y10 == null) return { status: 'flat', bps: 0 };
    const bps = Math.round((row.y10 - anchor) * 100);
    if (bps >= 20) return { status: 'shock', bps };
    if (bps > 0) return { status: 'building', bps };
    return { status: 'declining', bps };
  });

  const latestBps = boxes[boxes.length - 1]?.bps || 0;
  const isShock = boxes[boxes.length - 1]?.status === 'shock';

  return (
    <div className={styles.shockMeterBlock}>
      <div className={styles.metersBlockTitle}>10Y YIELD SHOCK — 10 DAY WINDOW</div>
      <div className={styles.shockMeterBoxes}>
        {boxes.map((b, i) => (
          <div
            key={i}
            className={`${styles.shockMeterBox} ${styles[`shock_${b.status}`]}`}
            title={`${last10[i]?.date}: ${b.bps > 0 ? '+' : ''}${b.bps} bps cumulative`}
          >
            <div className={styles.shockBoxBps}>{b.bps > 0 ? '+' : ''}{b.bps}</div>
          </div>
        ))}
      </div>
      <div className={styles.shockMeterScale}>
        <span className={styles.scaleGreen}>Declining</span>
        <span className={styles.scaleYellow}>&lt;20 bps</span>
        <span className={styles.scaleRed}>20+ bps SHOCK</span>
      </div>
    </div>
  );
}

// ── Two-Factor Alarm Gauge ──────────────────────────────────────────────────

function AlarmGauge({ label, current, threshold, color }) {
  const min = threshold - 0.8;
  const max = threshold + 0.4;
  const range = max - min;
  const pct = current != null ? Math.max(0, Math.min(100, ((current - min) / range) * 100)) : 0;
  const thresholdPct = ((threshold - min) / range) * 100;
  const isBreached = current != null && current >= threshold;

  return (
    <div className={styles.gaugeBlock}>
      <div className={styles.gaugeLabel}>{label}</div>
      <div className={styles.gaugeTrack}>
        <div
          className={`${styles.gaugeFill} ${isBreached ? styles.gaugeDanger : ''}`}
          style={{ width: `${pct}%`, background: isBreached ? '#ff5252' : color }}
        />
        <div className={styles.gaugeThreshold} style={{ left: `${thresholdPct}%` }} />
      </div>
      <div className={styles.gaugeNumbers}>
        <span>{current != null ? `${current.toFixed(2)}%` : '—'}</span>
        <span className={styles.gaugeThresholdLabel}>{threshold.toFixed(2)}%</span>
      </div>
      {isBreached && <div className={styles.gaugeBreach}>BREACHED</div>}
    </div>
  );
}

// ── Current yields banner ───────────────────────────────────────────────────

function YieldsBanner({ bonds, breadth, history, onShowPlaybook }) {
  if (!bonds) return null;

  // Rolling 20-day beta: Cov(PAI300, SPY) / Var(SPY) using daily returns
  const pai300Beta = useMemo(() => {
    if (!history || history.length < 22) return null;
    const recent = history.slice(-21);
    const returns = [];
    for (let i = 1; i < recent.length; i++) {
      const spyPrev = recent[i - 1].spy;
      const spyCur = recent[i].spy;
      const paiPrev = recent[i - 1].pai300;
      const paiCur = recent[i].pai300;
      if (spyPrev && spyCur && paiPrev && paiCur) {
        returns.push({
          spy: (spyCur - spyPrev) / spyPrev,
          pai: (paiCur - paiPrev) / paiPrev,
        });
      }
    }
    if (returns.length < 10) return null;
    const n = returns.length;
    const avgSpy = returns.reduce((s, r) => s + r.spy, 0) / n;
    const avgPai = returns.reduce((s, r) => s + r.pai, 0) / n;
    let cov = 0, varSpy = 0;
    for (const r of returns) {
      cov += (r.spy - avgSpy) * (r.pai - avgPai);
      varSpy += (r.spy - avgSpy) ** 2;
    }
    if (varSpy === 0) return null;
    return +(cov / varSpy).toFixed(2);
  }, [history]);

  const items = [
    { label: 'Fed Funds Rate', value: bonds.fedFunds, change: null, alertLevel: null },
    { label: '2-Year', value: bonds.y2, change: bonds.y2Change, alertLevel: bonds.y2 >= 4.5 ? '4.50%' : null },
    { label: '10-Year', value: bonds.y10, change: bonds.y10Change, alertLevel: bonds.y10 >= 4.5 ? '4.50%' : null },
    { label: '30-Year', value: bonds.y30, change: bonds.y30Change, alertLevel: bonds.y30 >= 5.0 ? '5.00%' : null },
  ];

  return (
    <div className={styles.yieldsBannerWrap}>
      <div className={styles.yieldsBanner}>
        {items.map(item => (
          <div key={item.label} className={styles.yieldItem}>
            <div className={styles.yieldItemLabel}>{item.label}</div>
            <div className={`${styles.yieldItemValue} ${item.alertLevel ? styles.alert : ''}`}>
              {item.value != null ? `${item.value.toFixed(2)}%` : '—'}
            </div>
            {item.change != null && (
              <div className={`${styles.yieldItemChange} ${item.change > 0 ? styles.yieldUp : item.change < 0 ? styles.yieldDown : ''}`}>
                {item.change > 0 ? '+' : ''}{(item.change * 100).toFixed(1)} bps
              </div>
            )}
            {item.alertLevel && <div className={styles.alertTag}>ABOVE {item.alertLevel}</div>}
          </div>
        ))}

        {/* ── Block 1: Yield Shock Meter ── */}
        <YieldShockMeter history={history} />

        {/* ── Block 2: Two-Factor Alarm ── */}
        <div className={styles.gaugesBlock}>
          <div className={styles.metersBlockTitle}>THREE-FACTOR ALARM</div>
          <AlarmGauge label="2-Year" current={bonds.y2} threshold={4.50} color="#4fc3f7" />
          <AlarmGauge label="10-Year" current={bonds.y10} threshold={4.50} color="#ffd600" />
          <AlarmGauge label="30-Year" current={bonds.y30} threshold={5.00} color="#ff7043" />
        </div>

        {/* ── PAI300 Beta ── */}
        {pai300Beta != null && (
          <div className={styles.yieldItem}>
            <div className={styles.yieldItemLabel}>PAI 300 Beta</div>
            <div className={styles.yieldItemValue} style={{ color: pai300Beta > 1.3 ? '#ff5252' : pai300Beta > 1.0 ? '#ffd600' : '#69f0ae', fontSize: 20 }}>
              {pai300Beta.toFixed(2)}x
            </div>
            <div className={styles.yieldItemChange} style={{ color: '#888' }}>
              {pai300Beta > 1.3 ? 'HIGH SENSITIVITY' : pai300Beta > 1.0 ? 'ELEVATED' : 'NORMAL'}
            </div>
          </div>
        )}

        {/* ── Breadth + Playbook ── */}
        <div className={styles.bannerRight}>
          <div className={styles.yieldItem}>
            <div className={styles.yieldItemLabel}>AI 300 Breadth</div>
            <div className={styles.breadthRow}>
              <span className={styles.advancers}>{breadth.advancers} up</span>
              <span className={styles.decliners}>{breadth.decliners} down</span>
            </div>
          </div>
          <button className={styles.playbookBtn} onClick={onShowPlaybook} title="How to use this information">ⓘ</button>
        </div>
      </div>
    </div>
  );
}

// ── Sector grid ─────────────────────────────────────────────────────────────

function SectorGrid({ sector }) {
  return (
    <div className={styles.sectorBlock}>
      <div className={styles.sectorHeader}>
        <span className={styles.sectorName}>{sector.name}</span>
        <span className={`${styles.sectorAvg} ${sector.avgChange >= 0 ? styles.sectorAvgUp : styles.sectorAvgDown}`}>
          {sector.avgChange != null ? `${sector.avgChange > 0 ? '+' : ''}${sector.avgChange.toFixed(2)}%` : '—'}
        </span>
      </div>
      <div className={styles.tickerGrid}>
        {sector.holdings.map(h => {
          const bg = getHeatColor(h.changePct);
          const color = getTextColor(h.changePct);
          return (
            <div key={h.ticker} className={styles.tickerCell} style={{ backgroundColor: bg, color }} title={`${h.name}\n${h.changePct != null ? `${h.changePct > 0 ? '+' : ''}${h.changePct.toFixed(2)}%` : 'No data'}`}>
              <div className={styles.tickerSymbol}>{h.ticker}</div>
              <div className={styles.tickerChange}>
                {h.changePct != null ? `${h.changePct > 0 ? '+' : ''}${h.changePct.toFixed(1)}%` : '—'}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────

export default function BondHeatPage() {
  const [data, setData] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [modalChart, setModalChart] = useState(null);
  const [infoPanel, setInfoPanel] = useState(null);

  const load = async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const [heatRes, histRes] = await Promise.all([
        apiFetch(`${API_BASE}/api/bond-heat${refresh ? '?refresh=1' : ''}`, { headers: authHeaders() }),
        apiFetch(`${API_BASE}/api/bond-heat/history`, { headers: authHeaders() }),
      ]);
      if (!heatRes.ok) throw new Error(`HTTP ${heatRes.status}`);
      const json = await heatRes.json();
      setData(json);
      if (histRes.ok) {
        const histJson = await histRes.json();
        setHistory(Array.isArray(histJson) ? histJson : []);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const sortedSectors = useMemo(() => {
    if (!data?.sectors) return [];
    return [...data.sectors].sort((a, b) => (b.avgChange || 0) - (a.avgChange || 0));
  }, [data]);

  // Build yield shock zones from history for ReferenceArea overlay
  const shockZones = useMemo(() => {
    if (!history.length) return [];
    const zones = [];
    let inShock = false;
    let start = null;
    for (const row of history) {
      if (row.yieldShock && !inShock) {
        inShock = true;
        start = row.date;
      } else if (!row.yieldShock && inShock) {
        inShock = false;
        zones.push({ start, end: row.date });
      }
    }
    if (inShock) zones.push({ start, end: history[history.length - 1].date });
    return zones;
  }, [history]);

  const dangerZones = useMemo(() => {
    if (!history.length) return [];
    const zones = [];

    const buildZones = (key, threshold, color) => {
      let inZone = false;
      let start = null;
      for (const row of history) {
        const val = row[key];
        if (val != null && val >= threshold && !inZone) {
          inZone = true;
          start = row.date;
        } else if ((val == null || val < threshold) && inZone) {
          inZone = false;
          zones.push({ start, end: row.date, color });
        }
      }
      if (inZone) zones.push({ start, end: history[history.length - 1].date, color });
    };

    buildZones('y2', 4.5, '#4fc3f7');
    buildZones('y10', 4.5, '#ffd600');
    buildZones('y30', 5.0, '#ff7043');
    return zones;
  }, [history]);

  // Normalize SPY + PAI300 to % change from first value for direct comparison
  const comparisonData = useMemo(() => {
    if (!history.length) return [];
    const firstSpy = history.find(r => r.spy != null)?.spy;
    const firstPai = history.find(r => r.pai300 != null)?.pai300;
    return history.map(row => ({
      date: row.date,
      spyPct: row.spy != null && firstSpy ? +((row.spy / firstSpy - 1) * 100).toFixed(2) : null,
      pai300Pct: row.pai300 != null && firstPai ? +((row.pai300 / firstPai - 1) * 100).toFixed(2) : null,
      y10: row.y10,
      yieldShock: row.yieldShock,
    }));
  }, [history]);

  return (
    <div className={styles.container}>
      <div className={styles.headerRow}>
        <h1 className={styles.title}>PNTHR Bond Heat</h1>
        <button className={styles.refreshBtn} onClick={() => load(true)} disabled={loading}>
          {loading ? '⏳ Loading...' : '🔄 Refresh'}
        </button>
        {data?.updatedAt && (
          <span className={styles.timestamp}>
            Updated: {new Date(data.updatedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {data && (
        <>
          {/* ── Yield Shock Warning ── */}
          <YieldShockBanner history={history} bonds={data.bonds} />

          {/* ── Market Interpretation ── */}
          <MarketInterpretation bonds={data.bonds} breadth={data.breadth} history={history} comparisonData={comparisonData} />

          {/* ── Current Yields Banner ── */}
          <YieldsBanner bonds={data.bonds} breadth={data.breadth} history={history} onShowPlaybook={() => setInfoPanel('playbook')} />

          {/* ── Yield Curves + SPY overlay ── */}
          {history.length > 0 && (
            <>
              <YieldChart
                data={history}
                syncId="bondHeat"
                title="Treasury Yields + S&P 500 — Past 12 Months"
                subtitle="Red shaded zones = Yield Shock active (10Y rose 20+ bps in 10 trading days)"
                lines={[
                  { key: 'y2', name: '2-Year', color: CHART_COLORS.y2 },
                  { key: 'y10', name: '10-Year', color: CHART_COLORS.y10 },
                  { key: 'y30', name: '30-Year', color: CHART_COLORS.y30 },
                  { key: 'spy', name: 'S&P 500 (SPY)', color: CHART_COLORS.spy, axis: 'right', width: 1.5 },
                ]}
                refLines={[
                  { y: 4.5, label: '2Y/10Y Alert 4.50%', color: '#ffd600' },
                  { y: 5.0, label: '30Y Alert 5.00%', color: '#ff7043' },
                ]}
                shockZones={shockZones}
                dangerZones={dangerZones}
                dualAxis
                height={380}
                onClick={() => setModalChart('yields')}
              >
                <div className={styles.chartLegend}>
                  <span className={styles.legendItem}><span className={styles.legendLine} style={{ background: CHART_COLORS.y2 }} /> 2Y</span>
                  <span className={styles.legendItem}><span className={styles.legendLine} style={{ background: CHART_COLORS.y10 }} /> 10Y</span>
                  <span className={styles.legendItem}><span className={styles.legendLine} style={{ background: CHART_COLORS.y30 }} /> 30Y</span>
                  <span className={styles.legendItem}><span className={styles.legendLine} style={{ background: CHART_COLORS.spy }} /> SPY</span>
                  <span className={styles.legendItem}><span className={styles.legendSwatch} style={{ background: 'rgba(255,152,0,0.3)', borderColor: 'rgba(255,152,0,0.5)' }} /> Yield Shock</span>
                  <span className={styles.legendItem}><span className={styles.legendDash} style={{ borderColor: '#ffd600' }} /> 2Y/10Y Danger 4.50%</span>
                  <span className={styles.legendItem}><span className={styles.legendDash} style={{ borderColor: '#ff7043' }} /> 30Y Danger 5.00%</span>
                  <span className={styles.legendItem}><span className={styles.legendSwatch} style={{ background: 'rgba(79,195,247,0.15)', borderColor: 'rgba(79,195,247,0.4)' }} /> 2Y Above 4.50%</span>
                  <span className={styles.legendItem}><span className={styles.legendSwatch} style={{ background: 'rgba(255,214,0,0.15)', borderColor: 'rgba(255,214,0,0.4)' }} /> 10Y Above 4.50%</span>
                  <span className={styles.legendItem}><span className={styles.legendSwatch} style={{ background: 'rgba(255,112,67,0.15)', borderColor: 'rgba(255,112,67,0.4)' }} /> 30Y Above 5.00%</span>
                </div>
              </YieldChart>

              {/* ── 2Y / 10Y Spread ── */}
              <YieldChart
                data={history}
                syncId="bondHeat"
                title="2Y / 10Y Spread"
                subtitle="Fed Policy + Recession Risk"
                lines={[
                  { key: 'spread2_10', name: '10Y - 2Y Spread', color: CHART_COLORS.spread },
                ]}
                refLines={[
                  { y: 0, label: 'Inversion', color: '#ef5350' },
                ]}
                height={220}
                onClick={() => setModalChart('spread2_10')}
              >
                <button className={styles.infoBtn} onClick={e => { e.stopPropagation(); setInfoPanel('spread2_10'); }} title="What does this mean?">ⓘ</button>
              </YieldChart>

              {/* ── 10Y / 30Y Spread ── */}
              <YieldChart
                data={history}
                syncId="bondHeat"
                title="10Y / 30Y Spread"
                subtitle="Long-Term Inflation & Fiscal Concerns"
                lines={[
                  { key: 'spread10_30', name: '30Y - 10Y Spread', color: CHART_COLORS.spread1030 },
                ]}
                refLines={[]}
                height={220}
                onClick={() => setModalChart('spread10_30')}
              >
                <button className={styles.infoBtn} onClick={e => { e.stopPropagation(); setInfoPanel('spread10_30'); }} title="What does this mean?">ⓘ</button>
              </YieldChart>

              {/* ── PAI300 vs SPY Comparison ── */}
              {comparisonData.some(r => r.pai300Pct != null) && (
                <YieldChart
                  data={comparisonData}
                  syncId="bondHeat"
                  title="PAI 300 vs S&P 500 — Normalized % Change"
                  subtitle="Shows how AI stocks react more violently to yield shocks vs broad market"
                  lines={[
                    { key: 'pai300Pct', name: 'PAI 300', color: CHART_COLORS.pai300 },
                    { key: 'spyPct', name: 'S&P 500', color: CHART_COLORS.spy },
                  ]}
                  refLines={[
                    { y: 0, label: 'Baseline', color: '#555' },
                  ]}
                  shockZones={shockZones}
                  height={260}
                >
                  <div className={styles.chartLegend}>
                    <span className={styles.legendItem}><span className={styles.legendLine} style={{ background: CHART_COLORS.pai300 }} /> PAI 300</span>
                    <span className={styles.legendItem}><span className={styles.legendLine} style={{ background: CHART_COLORS.spy }} /> S&P 500</span>
                    <span className={styles.legendItem}><span className={styles.legendSwatch} style={{ background: 'rgba(255,152,0,0.3)', borderColor: 'rgba(255,152,0,0.5)' }} /> Yield Shock</span>
                  </div>
                </YieldChart>
              )}
            </>
          )}

          {/* ── Heat Map ── */}
          <div className={styles.sectorsContainer}>
            {sortedSectors.map(s => <SectorGrid key={s.id} sector={s} />)}
          </div>
        </>
      )}

      {loading && !data && (
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <p>Loading AI 300 heat map...</p>
        </div>
      )}

      {/* ── Modals ── */}
      <ChartModal data={history} chart={modalChart} shockZones={shockZones} dangerZones={dangerZones} onClose={() => setModalChart(null)} />

      {infoPanel === 'spread2_10' && (
        <InfoPopup title="2-Year / 10-Year Yield Spread" onClose={() => setInfoPanel(null)}>
          <p><strong>What it measures:</strong> The difference between the 10-year and 2-year Treasury yields. This is the most watched recession indicator in bond markets.</p>
          <p><strong>When the spread is positive (normal):</strong> Investors demand higher yields for locking up money longer. The economy is expected to grow and the Fed is expected to eventually raise rates or hold steady.</p>
          <p><strong>When the spread inverts (goes negative):</strong> Short-term rates exceed long-term rates. This signals the market expects the Fed will be forced to cut rates due to an economic slowdown. An inverted 2/10 curve has preceded every US recession since 1970.</p>
          <p><strong>When the spread is widening after inversion:</strong> This is called "bull steepening" and historically it's the most dangerous phase — it means the recession is arriving and the Fed is about to cut aggressively. The damage to equities typically accelerates during the re-steepening, not during the initial inversion.</p>
          <p><strong>What to watch:</strong> Direction matters more than level. A rapidly widening spread after a period of inversion suggests the recession trade is on. A narrowing spread toward zero suggests rate-cut expectations are building.</p>
        </InfoPopup>
      )}

      {infoPanel === 'spread10_30' && (
        <InfoPopup title="10-Year / 30-Year Yield Spread" onClose={() => setInfoPanel(null)}>
          <p><strong>What it measures:</strong> The difference between the 30-year and 10-year Treasury yields. This reflects long-term inflation expectations, fiscal sustainability concerns, and the risk premium investors demand for holding very long-duration government debt.</p>
          <p><strong>When the spread is rising:</strong> The market is becoming uncomfortable with financing long-term government debt at current yield levels. Investors are demanding more compensation for the risks of holding 30-year bonds.</p>
          <p><strong>Key concerns a rising 10/30 spread reflects:</strong></p>
          <ul>
            <li><strong>US deficit sustainability</strong> — growing federal debt relative to GDP raises questions about whether the government can service its obligations</li>
            <li><strong>Treasury auction demand</strong> — weak demand at long-dated auctions forces yields higher to attract buyers</li>
            <li><strong>Foreign buyer appetite</strong> — reduced buying from China, Japan, and other major holders puts upward pressure on yields</li>
            <li><strong>Inflation credibility</strong> — if investors believe inflation will remain elevated, they demand higher yields for locking up money for 30 years</li>
            <li><strong>Bond vigilante behavior</strong> — large institutional investors selling long bonds to pressure fiscal policy</li>
            <li><strong>Long-duration risk premium</strong> — the extra compensation required for the uncertainty of holding a 30-year asset</li>
            <li><strong>Confidence in long-term economic stability</strong> — structural doubts about growth, productivity, and institutional strength</li>
          </ul>
          <p><strong>What to watch:</strong> A persistent rise in the 10/30 spread alongside rising absolute yields is bearish for equities — it signals the bond market is losing confidence in long-term fiscal management and inflation control.</p>
        </InfoPopup>
      )}

      {infoPanel === 'playbook' && (
        <InfoPopup title="How to Use Bond Heat" onClose={() => setInfoPanel(null)}>
          <p><strong>This page combines two signals to predict rate-driven stock selloffs:</strong></p>
          <p><strong>Signal 1 — Yield Velocity (Red Zones):</strong> When the 10-year Treasury yield rises 20+ basis points in 10 trading days, a red zone appears on the chart. This captures the speed of the move, which is what rattles equity markets.</p>
          <p><strong>Signal 2 — Danger Levels (Dashed Lines):</strong> When the 10Y crosses 4.50% or the 30Y crosses 5.00%, equities face structural pressure from higher borrowing costs and risk-free competition.</p>
          <p><strong>The Direction Meter</strong> shows the last 20 trading days of rate movement. Green = rates fell that day, yellow = flat, red = rates rose. When all three yields show mostly red boxes, rate pressure is building.</p>
          <p><strong>The Two-Factor Alarm</strong> shows how close each yield is to its danger threshold. When a gauge fills past the red line, that threshold is breached.</p>

          <table className={styles.playbookTable}>
            <thead>
              <tr><th>Signal</th><th>What It Means</th><th>Action</th></tr>
            </thead>
            <tbody>
              <tr>
                <td>Red zone + SPY falling</td>
                <td>Rate-driven selloff in progress</td>
                <td>Defensive — tighten stops, avoid new longs, watch for capitulation</td>
              </tr>
              <tr>
                <td>Red zone + SPY holding</td>
                <td>Market absorbing the rate shock</td>
                <td>Watch closely — either rates cool off or equities catch down</td>
              </tr>
              <tr>
                <td>Above dotted lines, no red zone</td>
                <td>Elevated but stable yields</td>
                <td>Cautious — be selective, favor cash-flow-positive names</td>
              </tr>
              <tr>
                <td>Below dotted lines, no red zone</td>
                <td>Rates not threatening</td>
                <td>Normal — run your strategy without yield headwind</td>
              </tr>
              <tr>
                <td>Red zone + BOTH dotted lines breached</td>
                <td>Maximum danger</td>
                <td>Triple threat — 30Y topped 5%, 10Y topped 4.50%. Historically the worst setup for equities. Tighten all stops immediately.</td>
              </tr>
            </tbody>
          </table>

          <p><strong>Important:</strong> This indicator filters out geopolitical selloffs (tariffs, wars) because during those events, bond yields typically <em>fall</em> as investors flee to safety. The Yield Shock signal only fires when yields are spiking — which is the pure inflation/rate fear trade.</p>
        </InfoPopup>
      )}
    </div>
  );
}
