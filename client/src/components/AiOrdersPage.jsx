import { useState, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '../AuthContext';
import { fetchLatestAiOrders, runAiOrders, runAiScouts, fetchNav } from '../services/api';
import AiTickerChartModal from './AiTickerChartModal';
import AssistantLiveTable from './AssistantLiveTable';
import { computeWeeksAgo } from '../utils/dateUtils';

const TIER_COLORS = {
  GO:      { bg: '#16a34a', fg: '#000', label: 'GO' },
  NEUTRAL: { bg: '#737373', fg: '#fff', label: 'NEUTRAL' },
  NO_GO:   { bg: '#dc2626', fg: '#fff', label: 'NO GO' },
};
const TIER_RANK = { GO: 0, NEUTRAL: 1, NO_GO: 2 };
const ACTION_RANK = { '★ BUY': 0, 'BUY': 1, 'WAIT': 2, 'SS': 3, 'NO GO': 4 };

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
  const isBuy = o.qualityGrade === 'BEST' || o.qualityGrade === 'GOOD';
  if (isBuy) return o.qualityGrade === 'BEST' ? '★ BUY' : 'BUY';
  if (o.signal === 'BL') return 'WAIT';
  return o.signal === 'SS' ? 'SS' : 'NO GO';
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

function SectorSummaryStrip({ summary }) {
  if (!summary || (!summary.go?.length && !summary.nogo?.length)) return null;
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: 16,
      padding: '10px 14px', margin: '12px 0',
      background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 6,
      fontSize: 11, fontFamily: 'monospace', color: '#ccc',
    }}>
      <span style={{ color: '#fcf000', fontWeight: 700 }}>5D Sector Rank · {summary.asOf || '—'}</span>
      <span style={{ color: '#16a34a', fontWeight: 700 }}>GO ▲</span>
      {(summary.go || []).map(s => (
        <span key={`go-${s.sectorId}`} title={s.name}>
          S{s.sectorId} {((s.fiveDayReturn ?? 0) * 100).toFixed(2)}%
        </span>
      ))}
      <span style={{ color: '#dc2626', fontWeight: 700, marginLeft: 'auto' }}>NO GO ▼</span>
      {(summary.nogo || []).map(s => (
        <span key={`nogo-${s.sectorId}`} title={s.name}>
          S{s.sectorId} {((s.fiveDayReturn ?? 0) * 100).toFixed(2)}%
        </span>
      ))}
    </div>
  );
}

const ORDER_ACCESSORS = {
  action:     o => ACTION_RANK[getActionLabel(o)] ?? 99,
  signal:     o => o.signal,
  ticker:     o => o.ticker,
  sector:     o => o.sectorId,
  tier:       o => TIER_RANK[o.sectorTier] ?? 99,
  gapPct:     o => o.gapPct,
  slope:      o => o.wEmaSlope,
  price:      o => o.currentPrice,
  stop:       o => o.stopPrice,
  riskPct:    o => o.riskPct,
  entrySh:    o => o.scoutShares,
  entryDol:   o => o.isScoutEntry ? o.scoutDollar : o.lot1Dollar,
  signalDate: o => o.signalDate || '',
  status:     o => o.isNewSignal ? 0 : 1,
};

const SCOUT_ACCESSORS = {
  grade:      s => s.qualityGrade === 'BEST' ? 0 : s.qualityGrade === 'GOOD' ? 1 : 2,
  status:     s => s._statusRank,
  ticker:     s => s.ticker,
  sector:     s => s.sectorId,
  tier:       s => TIER_RANK[s.sectorTier] ?? 99,
  entry:      s => s.entryPrice,
  stop:       s => s.stopPrice,
  scoutSh:    s => s._scaledShares,
  fullL1:     s => s._scaledFullL1,
  gapPct:     s => s.gapPct,
  slope:      s => s.wEmaSlope,
  entryDate:  s => s.entryDate || '',
  daysOpen:   s => s.tradingDaysOpen || 0,
};

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
  const [scoutSort, toggleScoutSort] = useSort('status', 'asc');

  const load = () => {
    setLoading(true);
    fetchLatestAiOrders()
      .then(d => { setDoc(d); setError(null); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
    fetchNav().then(d => setUserNav(d?.nav || 100000)).catch(() => {});
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  const navScale = useMemo(() => {
    const assumed = doc?.assumedNav || 100000;
    const actual  = userNav || 100000;
    return actual / assumed;
  }, [doc, userNav]);

  const weeklyBLTickers = useMemo(() => {
    if (!doc?.orders) return new Set();
    return new Set(doc.orders.filter(o => o.signal === 'BL').map(o => o.ticker));
  }, [doc]);

  const orders = useMemo(() => {
    if (!doc?.orders) return [];
    const filtered = doc.orders.filter(o => {
      if (filter === 'bl')  return o.signal === 'BL';
      if (filter === 'ss')  return o.signal === 'SS';
      if (filter === 'new') return o.isNewSignal;
      return true;
    }).map(o => {
      const fullL1 = Math.max(1, Math.round(o.lot1Shares * navScale));
      const isScoutEntry = o.signal === 'BL';
      const scoutShares = isScoutEntry ? Math.max(1, Math.round(fullL1 * 0.50)) : fullL1;
      const scoutDollar = +(scoutShares * (o.currentPrice || 0)).toFixed(2);
      return {
        ...o,
        lot1Shares: fullL1,
        scoutShares,
        scoutDollar,
        lot1Dollar: +(o.lot1Dollar * navScale).toFixed(2),
        targetShares: Math.max(1, Math.round(o.targetShares * navScale)),
        isScoutEntry,
      };
    });
    return sortRows(filtered, orderSort, ORDER_ACCESSORS);
  }, [doc, filter, navScale, orderSort]);

  const scouts = useMemo(() => {
    if (!doc?.scouts?.length) return [];
    const enriched = doc.scouts.map(s => {
      const isConverted = s.status === 'CONVERTED';
      const hasWeeklyBL = weeklyBLTickers.has(s.ticker);
      return {
        ...s,
        _statusRank: isConverted ? 0 : hasWeeklyBL ? 1 : 2,
        _isConfirmed: isConverted || hasWeeklyBL,
        _scaledShares: Math.max(1, Math.round(s.shares * navScale)),
        _scaledFullL1: Math.max(1, Math.round(s.fullLot1Shares * navScale)),
      };
    });
    return sortRows(enriched, scoutSort, SCOUT_ACCESSORS);
  }, [doc, weeklyBLTickers, navScale, scoutSort]);

  const onRun = async () => {
    setRunning(true);
    setRunMsg(null);
    try {
      const r = await runAiOrders({ type: 'DAILY' });
      setRunMsg(`Regenerated — ${r.stats?.totalOrders ?? '?'} orders`);
      load();
    } catch (e) {
      setRunMsg(`Failed: ${e.message}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div style={{ padding: '20px 24px', color: '#e5e5e5', minHeight: '100vh', background: '#0a0a0a' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ color: '#fcf000', margin: 0, fontSize: 26, letterSpacing: '0.04em' }}>PNTHR AI Orders</h1>
        <span style={{ color: '#888', fontSize: 13 }}>APEX v6 — 5D sector rotation overlay</span>
        <span style={{
          padding: '3px 8px', background: '#fcf000', color: '#000', borderRadius: 3,
          fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
        }}>AI 300</span>
      </div>

      {doc && (
        <div style={{ marginTop: 12, fontSize: 13, color: '#ccc' }}>
          Week of <strong style={{ color: '#fff' }}>{doc.weekOf}</strong>
          {doc.generatedAt && <span style={{ color: '#666' }}> · generated {new Date(doc.generatedAt).toLocaleString()}</span>}
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
              { k: 'new', label: 'BL+1 / SS+1' },
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
            <>
              <button onClick={onRun} disabled={running} style={{
                padding: '4px 10px', fontSize: 11, fontWeight: 700,
                background: '#fcf000', color: '#000', border: 'none', borderRadius: 3,
                cursor: running ? 'wait' : 'pointer',
              }}>{running ? 'RUNNING…' : 'REGENERATE'}</button>
              <button onClick={async () => {
                setRunning(true);
                try {
                  const r = await runAiScouts({ nav: userNav || 100000 });
                  setRunMsg(`Scouts: ${r.scan?.newScouts ?? 0} new, ${r.manage?.stopped ?? 0} stopped, ${r.manage?.active ?? 0} active`);
                  load();
                } catch (e) { setRunMsg(`Scout scan failed: ${e.message}`); }
                finally { setRunning(false); }
              }} disabled={running} style={{
                padding: '4px 10px', fontSize: 11, fontWeight: 700,
                background: '#00e5ff', color: '#000', border: 'none', borderRadius: 3,
                cursor: running ? 'wait' : 'pointer',
              }}>{running ? 'SCANNING…' : 'SCAN SCOUTS'}</button>
            </>
          )}
        </div>
      )}
      {runMsg && <div style={{ fontSize: 11, color: '#fcf000' }}>{runMsg}</div>}

      {loading && !doc && <div style={{ color: '#666', padding: 20 }}>Loading orders…</div>}
      {error && <div style={{ color: '#dc2626', padding: 20 }}>{error}</div>}
      {doc && doc.orders?.length === 0 && (
        <div style={{ color: '#888', padding: 20, fontSize: 14 }}>
          No orders this week — all signals filtered by sector gate, or no live BL/SS active.
        </div>
      )}

      {/* Section 1: Weekly Signal Orders */}
      {orders.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'baseline', gap: 10, margin: '16px 0 8px',
          borderBottom: '2px solid #fcf000', paddingBottom: 6,
        }}>
          <h2 style={{ color: '#fcf000', margin: 0, fontSize: 16, letterSpacing: '0.04em' }}>1 · Weekly Signal Orders</h2>
          <span style={{ color: '#888', fontSize: 11 }}>Confirmed weekly BL/SS signals — full position sizing</span>
        </div>
      )}
      {orders.length > 0 && (
        <div style={{ overflowX: 'auto', margin: '8px 0' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'monospace' }}>
            <thead>
              <tr style={{ background: '#1a1a1a', color: '#fcf000', textAlign: 'left' }}>
                <SortHeader label="Action"      sortKey="action"     currentSort={orderSort} onSort={toggleOrderSort} />
                <SortHeader label="Signal"      sortKey="signal"     currentSort={orderSort} onSort={toggleOrderSort} />
                <SortHeader label="Ticker"      sortKey="ticker"     currentSort={orderSort} onSort={toggleOrderSort} />
                <SortHeader label="Sector"      sortKey="sector"     currentSort={orderSort} onSort={toggleOrderSort} />
                <SortHeader label="Tier"        sortKey="tier"       currentSort={orderSort} onSort={toggleOrderSort} />
                <SortHeader label="Gap %"       sortKey="gapPct"     currentSort={orderSort} onSort={toggleOrderSort} align="right" />
                <SortHeader label="Slope %"     sortKey="slope"      currentSort={orderSort} onSort={toggleOrderSort} align="right" />
                <SortHeader label="Price"       sortKey="price"      currentSort={orderSort} onSort={toggleOrderSort} align="right" />
                <SortHeader label="Stop"        sortKey="stop"       currentSort={orderSort} onSort={toggleOrderSort} align="right" />
                <SortHeader label="Risk %"      sortKey="riskPct"    currentSort={orderSort} onSort={toggleOrderSort} align="right" />
                <SortHeader label="Entry sh"    sortKey="entrySh"    currentSort={orderSort} onSort={toggleOrderSort} align="right" />
                <SortHeader label="Entry $"     sortKey="entryDol"   currentSort={orderSort} onSort={toggleOrderSort} align="right" />
                <SortHeader label="Signal Date" sortKey="signalDate" currentSort={orderSort} onSort={toggleOrderSort} />
                <SortHeader label="Status"      sortKey="status"     currentSort={orderSort} onSort={toggleOrderSort} />
              </tr>
            </thead>
            <tbody>
              {orders.map(o => {
                const actionLabel = getActionLabel(o);
                const isBuy = actionLabel === '★ BUY' || actionLabel === 'BUY';
                const isWait = actionLabel === 'WAIT';
                const isNoGo = !isBuy && !isWait;
                const rowBg = isBuy ? 'rgba(22,163,74,0.12)'
                  : isWait ? 'rgba(252,240,0,0.06)'
                  : isNoGo ? 'rgba(220,38,38,0.08)'
                  : 'transparent';
                const rowBorder = isBuy ? '1px solid rgba(22,163,74,0.30)'
                  : isWait ? '1px solid rgba(252,240,0,0.20)'
                  : isNoGo ? '1px solid rgba(220,38,38,0.20)'
                  : '1px solid #1a1a1a';
                const leftAccent = isBuy ? '3px solid #16a34a' : isWait ? '3px solid #fcf000' : isNoGo ? '3px solid #dc2626' : 'none';
                return (
                <tr key={`${o.signal}-${o.ticker}`} style={{
                  borderBottom: rowBorder,
                  borderLeft: leftAccent,
                  background: rowBg,
                  cursor: 'pointer',
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
                    {isBuy ? (
                      <span style={{ padding: '2px 8px', borderRadius: 3, fontSize: 10, fontWeight: 700, background: '#16a34a', color: '#fff' }}>
                        {actionLabel}
                      </span>
                    ) : isWait ? (
                      <span style={{ padding: '2px 8px', borderRadius: 3, fontSize: 10, fontWeight: 700, background: '#fcf000', color: '#000' }}>WAIT</span>
                    ) : (
                      <span style={{ padding: '2px 8px', borderRadius: 3, fontSize: 10, fontWeight: 700, background: '#dc2626', color: '#fff' }}>
                        {o.signal === 'SS' ? 'SS' : 'NO GO'}
                      </span>
                    )}
                  </td>
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
                  <td style={{ padding: '6px 10px', textAlign: 'right', color: o.gapPct >= 15 ? '#fcf000' : o.gapPct >= 12 ? '#16a34a' : '#aaa' }}>{o.gapPct != null ? `${o.gapPct.toFixed(1)}%` : '—'}</td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', color: o.wEmaSlope != null && o.wEmaSlope < 20 ? '#16a34a' : '#aaa' }}>{o.wEmaSlope != null ? `${o.wEmaSlope.toFixed(1)}%` : '—'}</td>
                  <td style={{ padding: '6px 10px', textAlign: 'right' }}>{fmtUsd(o.currentPrice)}</td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', color: '#aaa' }}>{fmtUsd(o.stopPrice)}</td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', color: o.riskPct > 20 ? '#fcf000' : '#aaa' }}>{o.riskPct?.toFixed(1)}%</td>
                  <td style={{ padding: '6px 10px', textAlign: 'right' }}>
                    {o.scoutShares?.toLocaleString()}
                    {o.isScoutEntry && <span style={{ color: '#00e5ff', fontSize: 9, marginLeft: 3 }} title={`Full L1: ${o.lot1Shares}`}>50%</span>}
                  </td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', color: '#aaa' }}>{fmtUsd(o.isScoutEntry ? o.scoutDollar : o.lot1Dollar, { k: true })}</td>
                  <td style={{ padding: '6px 10px', color: '#888' }}>{o.signalDate || '—'}</td>
                  <td style={{ padding: '6px 10px' }}>
                    {o.isNewSignal
                      ? <span style={{ color: '#fcf000', fontWeight: 700, fontSize: 10 }}>★ NEW</span>
                      : <span style={{ color: '#666', fontSize: 10 }}>RUNNING</span>}
                  </td>
                </tr>
              ); })}
            </tbody>
          </table>
        </div>
      )}

      {/* Section 2: Daily Cascade Scouts */}
      {scouts.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <div style={{
            display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8,
            borderBottom: '2px solid #00e5ff', paddingBottom: 6,
          }}>
            <h2 style={{ color: '#00e5ff', margin: 0, fontSize: 16, letterSpacing: '0.04em' }}>2 · Daily Cascade Scouts</h2>
            <span style={{ color: '#888', fontSize: 11 }}>50% of Lot 1 — 28-day conversion window</span>
            <span style={{
              padding: '3px 8px', background: '#00e5ff', color: '#000', borderRadius: 3,
              fontSize: 10, fontWeight: 700,
            }}>
              {doc.stats?.activeScouts || 0} ACTIVE · {doc.stats?.convertedScouts || 0} CONVERTED
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'monospace' }}>
              <thead>
                <tr style={{ background: '#1a1a1a', color: '#00e5ff', textAlign: 'left' }}>
                  <SortHeader label="Grade"      sortKey="grade"     currentSort={scoutSort} onSort={toggleScoutSort} />
                  <SortHeader label="Status"     sortKey="status"    currentSort={scoutSort} onSort={toggleScoutSort} />
                  <SortHeader label="Ticker"     sortKey="ticker"    currentSort={scoutSort} onSort={toggleScoutSort} />
                  <SortHeader label="Sector"     sortKey="sector"    currentSort={scoutSort} onSort={toggleScoutSort} />
                  <SortHeader label="Tier"       sortKey="tier"      currentSort={scoutSort} onSort={toggleScoutSort} />
                  <SortHeader label="Entry"      sortKey="entry"     currentSort={scoutSort} onSort={toggleScoutSort} align="right" />
                  <SortHeader label="Stop"       sortKey="stop"      currentSort={scoutSort} onSort={toggleScoutSort} align="right" />
                  <SortHeader label="Scout sh"   sortKey="scoutSh"   currentSort={scoutSort} onSort={toggleScoutSort} align="right" />
                  <SortHeader label="Full L1"    sortKey="fullL1"    currentSort={scoutSort} onSort={toggleScoutSort} align="right" />
                  <SortHeader label="Gap %"      sortKey="gapPct"    currentSort={scoutSort} onSort={toggleScoutSort} align="right" />
                  <SortHeader label="Slope %"    sortKey="slope"     currentSort={scoutSort} onSort={toggleScoutSort} align="right" />
                  <SortHeader label="Entry Date" sortKey="entryDate" currentSort={scoutSort} onSort={toggleScoutSort} />
                  <SortHeader label="Days Open"  sortKey="daysOpen"  currentSort={scoutSort} onSort={toggleScoutSort} align="right" />
                </tr>
              </thead>
              <tbody>
                {scouts.map(s => {
                  const rowBg = s._isConfirmed ? 'rgba(252,240,0,0.08)' : 'transparent';
                  return (
                    <tr key={`scout-${s.ticker}`} style={{
                      borderBottom: s._isConfirmed ? '1px solid rgba(252,240,0,0.3)' : '1px solid #1a1a1a',
                      borderTop: s._isConfirmed ? '1px solid rgba(252,240,0,0.3)' : 'none',
                      background: rowBg,
                      cursor: 'pointer',
                      boxShadow: s._isConfirmed ? 'inset 3px 0 0 #fcf000' : 'none',
                    }}
                    onClick={() => {
                      setChartTickers([s.ticker]);
                      setChartIndex(0);
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = s._isConfirmed ? 'rgba(252,240,0,0.14)' : '#1a1a1a'}
                    onMouseLeave={e => e.currentTarget.style.background = rowBg}
                    >
                      <td style={{ padding: '6px 10px', textAlign: 'center', fontSize: 14 }}>
                        {s.qualityGrade === 'BEST' ? <span style={{ color: '#fcf000' }} title="Gap>15%, Slope<20%">★</span>
                         : s.qualityGrade === 'GOOD' ? <span style={{ color: '#16a34a' }} title="Gap>12%, Slope<20%">✓</span>
                         : <span style={{ color: '#666' }}>—</span>}
                      </td>
                      <td style={{ padding: '6px 10px' }}>
                        {s.status === 'CONVERTED' ? (
                          <span style={{
                            padding: '2px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700,
                            background: '#fcf000', color: '#000',
                          }}>CONVERTED</span>
                        ) : weeklyBLTickers.has(s.ticker) ? (
                          <span style={{
                            padding: '2px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700,
                            background: '#fcf000', color: '#000',
                          }}>WEEKLY BL ✓</span>
                        ) : (
                          <span style={{
                            padding: '2px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700,
                            background: '#00e5ff', color: '#000',
                          }}>SCOUT</span>
                        )}
                      </td>
                      <td style={{ padding: '6px 10px', fontWeight: 700, color: s._isConfirmed ? '#fcf000' : '#fff' }}>{s.ticker}</td>
                      <td style={{ padding: '6px 10px', color: '#aaa', fontSize: 11 }}>S{s.sectorId} {s.sectorName?.split(' ').slice(0, 2).join(' ')}</td>
                      <td style={{ padding: '6px 10px' }}><TierPill tier={s.sectorTier} /></td>
                      <td style={{ padding: '6px 10px', textAlign: 'right' }}>{fmtUsd(s.entryPrice)}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: '#aaa' }}>{fmtUsd(s.stopPrice)}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: s._isConfirmed ? '#fcf000' : '#00e5ff' }}>{s._scaledShares}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: s._isConfirmed ? '#fcf000' : '#aaa' }}>{s._scaledFullL1}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: '#aaa' }}>{s.gapPct?.toFixed(1)}%</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: '#aaa' }}>{s.wEmaSlope?.toFixed(1)}%</td>
                      <td style={{ padding: '6px 10px', color: '#888' }}>{s.entryDate || '—'}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: s.tradingDaysOpen >= 20 ? '#dc2626' : s.tradingDaysOpen >= 14 ? '#fcf000' : '#aaa' }}>
                        {s.tradingDaysOpen || 0}/{s.conversionDeadlineDays || 28}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Section 3: Live Positions */}
      <div style={{ marginTop: 24 }}>
        <div style={{
          display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8,
          borderBottom: '2px solid #f97316', paddingBottom: 6,
        }}>
          <h2 style={{ color: '#f97316', margin: 0, fontSize: 16, letterSpacing: '0.04em' }}>3 · Live Positions</h2>
          <span style={{ color: '#888', fontSize: 11 }}>IBKR ↔ PNTHR source-of-truth reconciliation</span>
        </div>
        <AssistantLiveTable
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
        />
      </div>

      {/* Footer note */}
      <div style={{ marginTop: 16, fontSize: 11, color: '#666', lineHeight: 1.6 }}>
        Sized at 1% NAV vitality × sector multiplier on your ${(userNav || 100000).toLocaleString()} NAV. Lot 1 = 35% of full target.
        BL skipped if sector NO_GO · SS skipped if sector GO · PAI300 36W EMA hard gate blocks all BL in bear regime.
        Quality grades: ★ BEST (Gap{'>'}15%, Slope{'<'}20%) · ✓ GOOD (Gap{'>'}12%, Slope{'<'}20%) · ✗ SKIP.
        Daily Cascade scouts enter at 50% of Lot 1 — gold = weekly BL confirmed → enter remaining 50% for full Lot 1 → pyramid continues.
        Realized DD -5.4% (backtest). 10% portfolio heat cap enforced.
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
