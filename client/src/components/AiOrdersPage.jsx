import { useState, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '../AuthContext';
import { fetchLatestAiOrders, runAiOrders, fetchNav } from '../services/api';
import AiTickerChartModal from './AiTickerChartModal';
import AssistantLiveTable from './AssistantLiveTable';
import PendingBridgeOrdersPanel from './PendingBridgeOrdersPanel';
import { computeWeeksAgo } from '../utils/dateUtils';
import { getStrategyMode } from '../utils/strategyMode';

const TIER_COLORS = {
  GO:      { bg: '#16a34a', fg: '#000', label: 'GO' },
  NEUTRAL: { bg: '#737373', fg: '#fff', label: 'NEUTRAL' },
  NO_GO:   { bg: '#dc2626', fg: '#fff', label: 'NO GO' },
};
const TIER_RANK = { GO: 0, NEUTRAL: 1, NO_GO: 2 };
const ACTION_RANK = { '★ BUY LONG': 0, 'LONG': 1, 'WAIT LONG': 2, '★ SELL SHORT': 3, 'SHORT': 4, 'WAIT SHORT': 5, 'NO GO': 6 };

const BEST_THRESHOLD = 12;

function TierPill({ tier }) {
  const c = TIER_COLORS[tier] || { bg: '#444', fg: '#fff', label: tier || '—' };
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 3, fontSize: 10,
      fontWeight: 700, letterSpacing: '0.06em',
      background: c.bg, color: c.fg,
    }}>{c.label}</span>
  );
}

function fmtUsd(n, opts = {}) {
  if (n == null || isNaN(n)) return '—';
  if (opts.k && Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function getActionLabel(o) {
  if (o.signal === 'BL') {
    if (o.qualityGrade === 'BEST') return '★ BUY LONG';
    if (o.qualityGrade === 'BETTER') return 'LONG';
    return 'WAIT LONG';
  }
  if (o.signal === 'SS') {
    if (o.qualityGrade === 'BEST') return '★ SELL SHORT';
    if (o.qualityGrade === 'BETTER') return 'SHORT';
    return 'WAIT SHORT';
  }
  return 'NO GO';
}

function SortHeader({ label, sortKey, currentSort, onSort, align }) {
  const active = currentSort.key === sortKey;
  const arrow = active ? (currentSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
  return (
    <th
      onClick={() => onSort(sortKey)}
      style={{
        padding: '8px 10px', cursor: 'pointer', userSelect: 'none',
        textAlign: align || 'left', whiteSpace: 'nowrap',
      }}
      title={`Sort by ${label}`}
    >
      {label}{arrow}
    </th>
  );
}

function useSort(defaultKey, defaultDir = 'asc') {
  const [sort, setSort] = useState({ key: defaultKey, dir: defaultDir });
  const toggle = useCallback((key) => {
    setSort(prev => prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'asc' }
    );
  }, []);
  return [sort, toggle];
}

function sortRows(rows, sort, accessors) {
  const accessor = accessors[sort.key];
  if (!accessor) return rows;
  return [...rows].sort((a, b) => {
    let va = accessor(a), vb = accessor(b);
    if (va == null) va = sort.dir === 'asc' ? Infinity : -Infinity;
    if (vb == null) vb = sort.dir === 'asc' ? Infinity : -Infinity;
    if (typeof va === 'string') {
      const cmp = va.localeCompare(vb);
      return sort.dir === 'asc' ? cmp : -cmp;
    }
    return sort.dir === 'asc' ? va - vb : vb - va;
  });
}

function ModeBadge({ ticker }) {
  const mode = getStrategyMode(ticker);
  return mode === 'carnivore' ? (
    <span style={{
      padding: '2px 6px', borderRadius: 3, fontSize: 9, fontWeight: 700,
      letterSpacing: '0.04em', background: '#fcf000', color: '#000',
    }}>679</span>
  ) : (
    <span style={{
      padding: '2px 6px', borderRadius: 3, fontSize: 9, fontWeight: 700,
      letterSpacing: '0.04em', background: '#00e5ff', color: '#000',
    }}>AI</span>
  );
}

function SectorSummaryStrip({ summary }) {
  if (!summary || (!summary.go?.length && !summary.nogo?.length)) return null;
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 6,
      padding: '10px 14px', margin: '12px 0',
      background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 6,
      fontSize: 11, fontFamily: 'monospace', color: '#ccc',
    }}>
      <span style={{ color: '#fcf000', fontWeight: 700 }}>5D Sector Rank · {summary.asOf || '—'}</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', alignItems: 'baseline' }}>
        <span style={{ color: '#16a34a', fontWeight: 700 }}>GO ▲</span>
        {(summary.go || []).map(s => (
          <span key={`go-${s.sectorId}`}>
            <span style={{ color: '#16a34a' }}>{s.name}</span>{' '}
            <span style={{ color: '#888' }}>{((s.fiveDayReturn ?? 0) * 100).toFixed(2)}%</span>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', alignItems: 'baseline' }}>
        <span style={{ color: '#dc2626', fontWeight: 700 }}>NO GO ▼</span>
        {(summary.nogo || []).map(s => (
          <span key={`nogo-${s.sectorId}`}>
            <span style={{ color: '#dc2626' }}>{s.name}</span>{' '}
            <span style={{ color: '#888' }}>{((s.fiveDayReturn ?? 0) * 100).toFixed(2)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function GapProgressBar({ gapPct, signal }) {
  const threshold = BEST_THRESHOLD;
  const absGap = Math.abs(gapPct ?? 0);
  const pct = Math.min(100, (absGap / threshold) * 100);
  const isClose = absGap >= threshold * 0.85;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 50, height: 6, background: '#222', borderRadius: 3, overflow: 'hidden', position: 'relative' }}>
        <div style={{
          height: '100%', borderRadius: 3, transition: 'width 0.5s ease',
          width: `${pct}%`,
          background: isClose ? '#fcf000' : '#555',
        }} />
      </div>
      <span style={{ color: isClose ? '#fcf000' : '#aaa', fontSize: 11, minWidth: 44, textAlign: 'right' }}>
        {gapPct != null ? `${gapPct.toFixed(1)}%` : '—'}
      </span>
    </div>
  );
}

function isMarketHours() {
  const now = new Date();
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false });
  const [h, m] = etStr.split(':').map(Number);
  const mins = h * 60 + m;
  if (mins < 570 || mins > 960) return false;
  const dow = now.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' });
  return dow !== 'Sat' && dow !== 'Sun';
}

const ORDER_ACCESSORS = {
  action:     o => ACTION_RANK[getActionLabel(o)] ?? 99,
  mode:       o => getStrategyMode(o.ticker),
  signal:     o => o.signal,
  ticker:     o => o.ticker,
  sector:     o => o.sectorId,
  tier:       o => TIER_RANK[o.sectorTier] ?? 99,
  gapPct:     o => o.gapPct,
  slope:      o => o.wEmaSlope,
  price:      o => o.currentPrice,
  stop:       o => o.stopPrice,
  riskPct:    o => o.riskPct,
  entrySh:    o => o.lot1Shares,
  fullPos:    o => o.targetShares,
  entryDol:   o => o.lot1Dollar,
  heat:       o => o._heatDollar ?? 0,
  signalDate: o => o.signalDate || '',
  status:     o => o.isNewSignal ? 0 : 1,
};

function OrderRow({ o, orders, navScale, setChartTickers, setChartIndex, dimmed, positionInfo }) {
  const actionLabel = getActionLabel(o);
  const isFired = !!positionInfo;
  const firedLabel = positionInfo?.direction === 'SHORT' ? 'SHORTED' : 'BOUGHT';
  const firedStatus = positionInfo?.status;
  const isBuyActive = !isFired && (actionLabel === '★ BUY LONG' || actionLabel === 'LONG');
  const isSSActive = !isFired && (actionLabel === '★ SELL SHORT' || actionLabel === 'SHORT');
  const isWait = !isFired && (actionLabel === 'WAIT LONG' || actionLabel === 'WAIT SHORT');
  const isNoGo = !isFired && actionLabel === 'NO GO';
  const rowBg = dimmed
    ? 'rgba(30,30,30,0.5)'
    : isBuyActive ? 'rgba(22,163,74,0.12)'
    : isSSActive ? 'rgba(220,38,38,0.08)'
    : isWait ? 'rgba(252,240,0,0.06)'
    : isNoGo ? 'rgba(100,100,100,0.08)'
    : 'transparent';
  const rowBorder = isBuyActive ? '1px solid rgba(22,163,74,0.30)'
    : isSSActive ? '1px solid rgba(220,38,38,0.20)'
    : isWait ? '1px solid rgba(252,240,0,0.20)'
    : isNoGo ? '1px solid rgba(100,100,100,0.20)'
    : '1px solid #1a1a1a';
  const leftAccent = isBuyActive ? '3px solid #16a34a' : isSSActive ? '3px solid #dc2626' : isWait ? '3px solid #fcf000' : isNoGo ? '3px solid #666' : 'none';
  const opacity = dimmed ? 0.7 : 1;

  return (
    <tr style={{
      borderBottom: rowBorder, borderLeft: leftAccent,
      background: rowBg, cursor: 'pointer', opacity,
    }}
    onClick={() => {
      const tickers = orders.map(x => x.ticker);
      setChartTickers(tickers);
      setChartIndex(tickers.indexOf(o.ticker));
    }}
    onMouseEnter={e => e.currentTarget.style.background = '#1a1a1a'}
    onMouseLeave={e => e.currentTarget.style.background = rowBg}
    >
      <td style={{ padding: '6px 10px', textAlign: 'center' }}>
        {isFired ? (
          <span style={{
            padding: '2px 8px', borderRadius: 3, fontSize: 10, fontWeight: 700,
            background: '#7c3aed', color: '#fff', letterSpacing: '0.04em',
          }}>{firedLabel}{firedStatus === 'STAGED' ? ' (STAGED)' : ''}</span>
        ) : isBuyActive ? (
          <span style={{ padding: '2px 8px', borderRadius: 3, fontSize: 10, fontWeight: 700, background: '#16a34a', color: '#fff' }}>{actionLabel}</span>
        ) : isSSActive ? (
          <span style={{ padding: '2px 8px', borderRadius: 3, fontSize: 10, fontWeight: 700, background: '#dc2626', color: '#fff' }}>{actionLabel}</span>
        ) : isWait ? (
          <span style={{ padding: '2px 8px', borderRadius: 3, fontSize: 10, fontWeight: 700, background: '#fcf000', color: '#000' }}>{actionLabel}</span>
        ) : (
          <span style={{ padding: '2px 8px', borderRadius: 3, fontSize: 10, fontWeight: 700, background: '#666', color: '#fff' }}>NO GO</span>
        )}
      </td>
      <td style={{ padding: '6px 10px', textAlign: 'center' }}><ModeBadge ticker={o.ticker} /></td>
      <td style={{ padding: '6px 10px', fontWeight: 700, color: o.signal === 'BL' ? '#16a34a' : '#dc2626' }}>
        {o.signal}
        {(() => {
          const n = computeWeeksAgo(o.signalDate, o.lastBarDate);
          return n != null ? <span style={{ color: '#aaa', fontWeight: 500 }}>+{n}</span> : null;
        })()}
      </td>
      <td style={{ padding: '6px 10px', fontWeight: 700, color: '#fff' }}>{o.ticker}</td>
      <td style={{ padding: '6px 10px', color: '#aaa', fontSize: 11 }}>S{o.sectorId} {o.sectorName?.split(' ').slice(0, 2).join(' ')}</td>
      <td style={{ padding: '6px 10px' }}><TierPill tier={o.sectorTier} /></td>
      <td style={{ padding: '6px 10px', textAlign: 'right' }}>
        {dimmed
          ? <GapProgressBar gapPct={o.gapPct} signal={o.signal} />
          : <span style={{ color: o.gapPct >= 15 ? '#fcf000' : o.gapPct >= 12 ? '#16a34a' : '#aaa' }}>{o.gapPct != null ? `${o.gapPct.toFixed(1)}%` : '—'}</span>
        }
      </td>
      <td style={{ padding: '6px 10px', textAlign: 'right', color: o.wEmaSlope != null && o.wEmaSlope < 20 ? '#16a34a' : '#aaa' }}>{o.wEmaSlope != null ? `${o.wEmaSlope.toFixed(1)}%` : '—'}</td>
      <td style={{ padding: '6px 10px', textAlign: 'right' }}>{fmtUsd(o.currentPrice)}</td>
      <td style={{ padding: '6px 10px', textAlign: 'right', color: '#aaa' }}>{fmtUsd(o.stopPrice)}</td>
      <td style={{ padding: '6px 10px', textAlign: 'right', color: o.riskPct > 20 ? '#fcf000' : '#aaa' }}>{o.riskPct?.toFixed(1)}%</td>
      <td style={{ padding: '6px 10px', textAlign: 'right' }}>{o.lot1Shares?.toLocaleString()}</td>
      <td style={{ padding: '6px 10px', textAlign: 'right', color: '#888' }}>{o.targetShares?.toLocaleString()}</td>
      <td style={{ padding: '6px 10px', textAlign: 'right', color: '#aaa' }}>{fmtUsd(o.lot1Dollar, { k: true })}</td>
      <td style={{ padding: '6px 10px', textAlign: 'right', color: '#f97316', fontWeight: 600 }}>{fmtUsd(o._heatDollar)}</td>
      <td style={{ padding: '6px 10px', color: '#888' }}>{o.signalDate || '—'}</td>
    </tr>
  );
}

function TableHeader({ sort, onSort }) {
  return (
    <thead>
      <tr style={{ background: '#1a1a1a', color: '#fcf000', textAlign: 'left' }}>
        <SortHeader label="Action"      sortKey="action"     currentSort={sort} onSort={onSort} />
        <SortHeader label="Mode"        sortKey="mode"       currentSort={sort} onSort={onSort} />
        <SortHeader label="Signal"      sortKey="signal"     currentSort={sort} onSort={onSort} />
        <SortHeader label="Ticker"      sortKey="ticker"     currentSort={sort} onSort={onSort} />
        <SortHeader label="Sector"      sortKey="sector"     currentSort={sort} onSort={onSort} />
        <SortHeader label="Sector 💪"   sortKey="tier"       currentSort={sort} onSort={onSort} />
        <SortHeader label="Gap %"       sortKey="gapPct"     currentSort={sort} onSort={onSort} align="right" />
        <SortHeader label="Slope %"     sortKey="slope"      currentSort={sort} onSort={onSort} align="right" />
        <SortHeader label="Price"       sortKey="price"      currentSort={sort} onSort={onSort} align="right" />
        <SortHeader label="Stop"        sortKey="stop"       currentSort={sort} onSort={onSort} align="right" />
        <SortHeader label="Risk %"      sortKey="riskPct"    currentSort={sort} onSort={onSort} align="right" />
        <SortHeader label="L1 sh"      sortKey="entrySh"    currentSort={sort} onSort={onSort} align="right" />
        <SortHeader label="Full Pos"   sortKey="fullPos"    currentSort={sort} onSort={onSort} align="right" />
        <SortHeader label="Entry $"     sortKey="entryDol"   currentSort={sort} onSort={onSort} align="right" />
        <SortHeader label="Heat $"      sortKey="heat"       currentSort={sort} onSort={onSort} align="right" />
        <SortHeader label="Signal Date" sortKey="signalDate" currentSort={sort} onSort={onSort} />
      </tr>
    </thead>
  );
}

export default function AiOrdersPage() {
  const { isAdmin } = useAuth();
  const [doc, setDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('new');
  const [chartTickers, setChartTickers] = useState([]);
  const [chartIndex, setChartIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState(null);
  const [userNav, setUserNav] = useState(null);
  const [orderSort, toggleOrderSort] = useSort('action', 'asc');
  const [heatData, setHeatData] = useState(null);
  const [bridgeOpen, setBridgeOpen] = useState(() => {
    try { return localStorage.getItem('aiOrders.bridgeOpen') !== 'false'; } catch { return true; }
  });
  const [lastRefresh, setLastRefresh] = useState(null);

  const load = useCallback((refresh = false) => {
    setLoading(prev => !doc ? true : prev);
    fetchLatestAiOrders({ refresh })
      .then(d => { setDoc(d); setError(null); setLastRefresh(new Date()); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [doc]);

  useEffect(() => {
    load(false);
    fetchNav().then(d => setUserNav(d?.nav || 100000)).catch(() => {});
    const id = setInterval(() => load(isMarketHours()), 60_000);
    return () => clearInterval(id);
  }, []);

  const navScale = useMemo(() => {
    const assumed = doc?.assumedNav || 100000;
    const actual  = userNav || 100000;
    return actual / assumed;
  }, [doc, userNav]);

  const scaleOrder = useCallback((o) => {
    const fullL1 = Math.max(1, Math.round(o.lot1Shares * navScale));
    const riskPerShare = o.riskPerShare || 0;
    const _heatDollar = +(fullL1 * riskPerShare).toFixed(2);
    return {
      ...o,
      lot1Shares: fullL1,
      lot1Dollar: +(o.lot1Dollar * navScale).toFixed(2),
      targetShares: Math.max(1, Math.round(o.targetShares * navScale)),
      _heatDollar,
    };
  }, [navScale]);

  const activePositions = useMemo(() => {
    const map = {};
    for (const p of (doc?.activePositionTickers || [])) {
      map[p.ticker] = p;
    }
    return map;
  }, [doc]);

  const { nowOrders, onDeckOrders, allOrders } = useMemo(() => {
    if (!doc?.orders) return { nowOrders: [], onDeckOrders: [], allOrders: [] };

    const newSignals = doc.orders.filter(o => o.isNewSignal && (o.signal === 'BL' || o.signal === 'SS'));
    const now = newSignals.filter(o => o.qualityGrade === 'BEST').map(scaleOrder);
    const onDeck = newSignals.filter(o => o.qualityGrade !== 'BEST').map(scaleOrder);

    const nowSorted = sortRows(now, { key: 'action', dir: 'asc' }, ORDER_ACCESSORS);
    const onDeckSorted = [...onDeck].sort((a, b) => Math.abs(b.gapPct ?? 0) - Math.abs(a.gapPct ?? 0));

    const all = doc.orders.map(scaleOrder);

    return { nowOrders: nowSorted, onDeckOrders: onDeckSorted, allOrders: all };
  }, [doc, scaleOrder]);

  const filteredOrders = useMemo(() => {
    if (filter === 'new') return null;
    if (!doc?.orders) return [];
    const filtered = doc.orders.filter(o => {
      if (filter === 'bl')  return o.signal === 'BL';
      if (filter === 'ss')  return o.signal === 'SS';
      return true;
    }).map(scaleOrder);
    return sortRows(filtered, orderSort, ORDER_ACCESSORS);
  }, [doc, filter, scaleOrder, orderSort]);

  const onRun = async () => {
    setRunning(true);
    setRunMsg(null);
    try {
      const r = await runAiOrders({ type: 'DAILY' });
      setRunMsg(`Regenerated — ${r.stats?.totalOrders ?? '?'} orders`);
      load(false);
    } catch (e) {
      setRunMsg(`Failed: ${e.message}`);
    } finally {
      setRunning(false);
    }
  };

  const allChartTickers = filter === 'new'
    ? [...nowOrders, ...onDeckOrders].map(o => o.ticker)
    : (filteredOrders || []).map(o => o.ticker);

  return (
    <div style={{ padding: '20px 24px', color: '#e5e5e5', minHeight: '100vh', background: '#0a0a0a' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ color: '#fcf000', margin: 0, fontSize: 26, letterSpacing: '0.04em' }}>PNTHR AI Orders</h1>
        <span style={{ color: '#888', fontSize: 13 }}>APEX v7 — 5D sector rotation overlay</span>
        <span style={{
          padding: '3px 8px', background: '#fcf000', color: '#000', borderRadius: 3,
          fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
        }}>AI 300</span>
      </div>

      {doc && (
        <div style={{ marginTop: 12, fontSize: 13, color: '#ccc' }}>
          Week of <strong style={{ color: '#fff' }}>{doc.weekOf}</strong>
          {doc.generatedAt && <span style={{ color: '#666' }}> · generated {new Date(doc.generatedAt).toLocaleString()}</span>}
          {lastRefresh && isMarketHours() && (
            <span style={{ color: '#444', fontSize: 11 }}> · live refresh {lastRefresh.toLocaleTimeString()}</span>
          )}
        </div>
      )}

      <SectorSummaryStrip summary={doc?.sectorSummary} />

      {doc?.stats && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', margin: '12px 0' }}>
          <div style={{ fontSize: 12, color: '#aaa' }}>
            <strong style={{ color: '#fcf000', fontSize: 16 }}>{doc.stats.totalOrders}</strong> total ·
            <strong style={{ color: '#16a34a' }}> {doc.stats.blCount}</strong> BL ·
            <strong style={{ color: '#dc2626' }}> {doc.stats.ssCount}</strong> SS ·
            <strong style={{ color: '#fcf000' }}> {doc.stats.newThisWeek}</strong> NEW
          </div>
          <div style={{ fontSize: 11, color: '#666' }}>
            {doc.stats.pai300Regime && (
              <span style={{
                padding: '2px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700, marginRight: 8,
                background: doc.stats.pai300Regime === 'BULL' ? '#16a34a' : doc.stats.pai300Regime === 'BEAR' ? '#dc2626' : '#444',
                color: '#fff',
              }}>PAI300 {doc.stats.pai300Regime}</span>
            )}
            skipped: BL/NO_GO <strong style={{ color: '#dc2626' }}>{doc.stats.skippedNoGoBL}</strong> ·
            SS/GO <strong style={{ color: '#dc2626' }}>{doc.stats.skippedGoSS}</strong>
            {doc.stats.blRegimeBlocked > 0 && (
              <span> · BL/BEAR <strong style={{ color: '#dc2626' }}>{doc.stats.blRegimeBlocked}</strong></span>
            )}
          </div>

          <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
            {[
              { k: 'new', label: 'This Week' },
              { k: 'all', label: 'All' },
              { k: 'bl',  label: 'BL only' },
              { k: 'ss',  label: 'SS only' },
            ].map(opt => (
              <button key={opt.k} onClick={() => setFilter(opt.k)} style={{
                padding: '4px 10px', fontSize: 11, fontWeight: 600,
                background: filter === opt.k ? '#fcf000' : 'transparent',
                color: filter === opt.k ? '#000' : '#aaa',
                border: '1px solid #444', borderRadius: 3, cursor: 'pointer',
              }}>{opt.label}</button>
            ))}
          </div>

          {isAdmin && (
            <button onClick={onRun} disabled={running} style={{
              padding: '4px 10px', fontSize: 11, fontWeight: 700,
              background: '#fcf000', color: '#000', border: 'none', borderRadius: 3,
              cursor: running ? 'wait' : 'pointer',
            }}>{running ? 'RUNNING…' : 'REGENERATE'}</button>
          )}
        </div>
      )}
      {runMsg && <div style={{ fontSize: 11, color: '#fcf000' }}>{runMsg}</div>}

      {/* Heat Budget Bar */}
      {heatData && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 14, padding: '10px 14px', margin: '12px 0',
          background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 6,
          fontSize: 12, fontFamily: 'monospace',
        }}>
          <span style={{ color: '#f97316', fontWeight: 700, fontSize: 11, letterSpacing: '0.06em' }}>PORTFOLIO HEAT</span>
          <div style={{ flex: 1, height: 14, background: '#0a0a0a', borderRadius: 3, overflow: 'hidden', position: 'relative' }}>
            <div style={{
              height: '100%', borderRadius: 3, transition: 'width 0.3s',
              width: `${Math.min(100, heatData.totalRiskPct)}%`,
              background: heatData.totalRiskPct >= 10 ? '#dc2626'
                : heatData.totalRiskPct >= 8 ? '#f97316'
                : heatData.totalRiskPct >= 5 ? '#fcf000'
                : '#16a34a',
            }} />
            <div style={{
              position: 'absolute', left: '100%', top: 0, bottom: 0, width: 2,
              background: '#dc2626', marginLeft: -2,
            }} title="10% cap" />
          </div>
          <span style={{
            color: heatData.totalRiskPct >= 10 ? '#dc2626' : heatData.totalRiskPct >= 8 ? '#f97316' : '#aaa',
            fontWeight: 700, minWidth: 60, textAlign: 'right',
          }}>
            {heatData.totalRiskPct.toFixed(1)}% / 10%
          </span>
          <span style={{ color: '#666', fontSize: 11 }}>
            {fmtUsd(heatData.totalRisk)} risk · {fmtUsd(heatData.nav)} NAV
            {heatData.recycled > 0 && <span style={{ color: '#16a34a' }}> · {heatData.recycled} recycled</span>}
          </span>
          {heatData.totalRiskPct >= 10 && (
            <span style={{
              padding: '2px 8px', background: '#dc2626', color: '#fff', borderRadius: 3,
              fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
            }}>CAP REACHED — NO NEW ENTRIES</span>
          )}
        </div>
      )}

      {loading && !doc && <div style={{ color: '#666', padding: 20 }}>Loading orders…</div>}
      {error && <div style={{ color: '#dc2626', padding: 20 }}>{error}</div>}
      {doc && doc.orders?.length === 0 && (
        <div style={{ color: '#888', padding: 20, fontSize: 14 }}>
          No orders this week — all signals filtered by sector gate, or no live BL/SS active.
        </div>
      )}

      {/* ═══ DEFAULT VIEW: NOW + ON DECK ═══ */}
      {filter === 'new' && (nowOrders.length > 0 || onDeckOrders.length > 0) && (
        <>
          {/* NOW section */}
          {nowOrders.length > 0 && (
            <div style={{
              border: '2px solid #16a34a', borderRadius: 8, overflow: 'hidden',
              margin: '24px 0 0',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 14px', background: 'rgba(22,163,74,0.15)',
                borderBottom: '1px solid rgba(22,163,74,0.3)',
              }}>
                <span style={{ color: '#16a34a', fontWeight: 700, fontSize: 14, letterSpacing: '0.06em' }}>NOW</span>
                <span style={{ color: '#16a34a', fontSize: 12 }}>Ready to execute — all gates passed, ★ quality grade</span>
                <span style={{
                  marginLeft: 'auto', padding: '2px 8px', background: '#16a34a', color: '#000',
                  borderRadius: 3, fontSize: 11, fontWeight: 700,
                }}>{nowOrders.length}</span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'monospace' }}>
                  <TableHeader sort={orderSort} onSort={toggleOrderSort} />
                  <tbody>
                    {nowOrders.map(o => (
                      <OrderRow key={`now-${o.ticker}`} o={o} orders={allChartTickers.map(t => ({ ticker: t }))}
                        navScale={navScale} setChartTickers={setChartTickers} setChartIndex={setChartIndex} dimmed={false}
                        positionInfo={activePositions[o.ticker]} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ON DECK section */}
          {onDeckOrders.length > 0 && (
            <div style={{
              border: '2px solid #f97316', borderRadius: 8, overflow: 'hidden',
              margin: '20px 0 0',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 14px', background: 'rgba(249,115,22,0.10)',
                borderBottom: '1px solid rgba(249,115,22,0.3)',
              }}>
                <span style={{ color: '#f97316', fontWeight: 700, fontSize: 14, letterSpacing: '0.06em' }}>ON DECK</span>
                <span style={{ color: '#f97316', fontSize: 12 }}>Batting order — sorted by gap% to trigger ({BEST_THRESHOLD}%)</span>
                <span style={{
                  marginLeft: 'auto', padding: '2px 8px', background: '#f97316', color: '#000',
                  borderRadius: 3, fontSize: 11, fontWeight: 700,
                }}>{onDeckOrders.length}</span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'monospace' }}>
                  <TableHeader sort={orderSort} onSort={toggleOrderSort} />
                  <tbody>
                    {onDeckOrders.map((o, i) => (
                      <OrderRow key={`deck-${o.ticker}`} o={o} orders={allChartTickers.map(t => ({ ticker: t }))}
                        navScale={navScale} setChartTickers={setChartTickers} setChartIndex={setChartIndex} dimmed={true}
                        positionInfo={activePositions[o.ticker]} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {nowOrders.length === 0 && onDeckOrders.length > 0 && (
            <div style={{
              margin: '24px 0 0', padding: '14px 18px',
              background: 'rgba(252,240,0,0.06)', border: '1px solid rgba(252,240,0,0.2)',
              borderRadius: 6, fontSize: 12, color: '#fcf000',
            }}>
              No stocks ready NOW — {onDeckOrders.length} on deck warming up. Gap% updates every 60 seconds during market hours.
            </div>
          )}
        </>
      )}

      {/* ═══ FILTERED VIEW (All / BL only / SS only) ═══ */}
      {filter !== 'new' && filteredOrders && filteredOrders.length > 0 && (
        <>
          <div style={{
            display: 'flex', alignItems: 'baseline', gap: 10, margin: '24px 0 8px',
            borderBottom: '2px solid #f97316', paddingBottom: 6,
          }}>
            <h2 style={{ color: '#f97316', margin: 0, fontSize: 16, letterSpacing: '0.04em' }}>PNTHR Weekly Orders</h2>
            <span style={{ color: '#888', fontSize: 11 }}>
              {filter === 'all' ? 'All active signals — current + prior weeks' : `${filter.toUpperCase()} signals only`}
            </span>
          </div>
          <div style={{ overflowX: 'auto', margin: '8px 0' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'monospace' }}>
              <TableHeader sort={orderSort} onSort={toggleOrderSort} />
              <tbody>
                {filteredOrders.map(o => (
                  <OrderRow key={`all-${o.signal}-${o.ticker}`} o={o} orders={filteredOrders}
                    navScale={navScale} setChartTickers={setChartTickers} setChartIndex={setChartIndex} dimmed={false}
                    positionInfo={activePositions[o.ticker]} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Live Positions */}
      <div style={{ marginTop: 24 }}>
        <div style={{
          display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8,
          borderBottom: '2px solid #fcf000', paddingBottom: 6,
        }}>
          <h2 style={{ color: '#fcf000', margin: 0, fontSize: 16, letterSpacing: '0.04em' }}>PNTHR Live Positions</h2>
          <span style={{ color: '#888', fontSize: 11 }}>IBKR ↔ PNTHR source-of-truth reconciliation</span>
        </div>
        <AssistantLiveTable
          hideHeader
          netLiquidity={userNav}
          onOpenChart={(stocks, idx) => {
            if (Array.isArray(stocks) && stocks.length > 0) {
              setChartTickers(stocks.map(s => s.ticker || s));
              setChartIndex(idx || 0);
            } else if (stocks?.ticker) {
              setChartTickers([stocks.ticker]);
              setChartIndex(0);
            }
          }}
          onPositionsSummary={(pos) => {
            if (pos?.heat) {
              setHeatData({
                totalRisk: pos.heat.totalRisk || 0,
                totalRiskPct: pos.heat.totalRiskPct || 0,
                nav: pos.nav || userNav || 100000,
                recycled: pos.recycled || 0,
                total: pos.total || 0,
              });
            }
          }}
        />
      </div>

      {/* Pending Bridge Orders */}
      {isAdmin && (
        <div style={{ marginTop: 24 }}>
          <PendingBridgeOrdersPanel
            collapsed={!bridgeOpen}
            onToggle={() => {
              setBridgeOpen(v => {
                localStorage.setItem('aiOrders.bridgeOpen', !v ? 'true' : 'false');
                return !v;
              });
            }}
          />
        </div>
      )}

      {/* Footer note */}
      <div style={{ marginTop: 16, fontSize: 11, color: '#666', lineHeight: 1.6 }}>
        Sized at 1% NAV vitality × sector multiplier on your ${(userNav || 100000).toLocaleString()} NAV. Lot 1 = 35% of full target.
        BL skipped if sector NO_GO · SS skipped if sector GO · PAI300 36W EMA hard gate blocks all BL in bear regime.
        Quality grades: BEST (Gap≥12% + Slope{'<'}50%) · BETTER (Gap≥9%) · GOOD (default).
        Gap% updates every 60 seconds during market hours. 10% portfolio heat cap enforced.
      </div>

      {chartTickers.length > 0 && (
        <AiTickerChartModal
          tickers={chartTickers}
          initialIndex={chartIndex}
          onClose={() => setChartTickers([])}
        />
      )}
    </div>
  );
}
