import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../AuthContext';
import { fetchLatestAiOrders, runAiOrders, runAiScouts, fetchNav } from '../services/api';
import AiTickerChartModal from './AiTickerChartModal';
import { computeWeeksAgo } from '../utils/dateUtils';

// PNTHR AI Orders — APEX v6 weekly order sheet
//
// Each row = one BL/SS signal that passed the 5D sector rotation gate.
// Sorted by sector tier (GO/NO_GO 1.25× first, then NEUTRAL), then by signal
// recency. Sized per Phase 4 mechanics on a notional $1M reference NAV.
//
// Cyan accent + yellow-on-black throughout to match AI 300 visual identity.

const TIER_COLORS = {
  GO:      { bg: '#16a34a', fg: '#000', label: 'GO' },
  NEUTRAL: { bg: '#737373', fg: '#fff', label: 'NEUTRAL' },
  NO_GO:   { bg: '#dc2626', fg: '#fff', label: 'NO GO' },
};

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

export default function AiOrdersPage() {
  const { isAdmin } = useAuth();
  const [doc, setDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('new'); // new | all | bl | ss
  const [chartTickers, setChartTickers] = useState([]);
  const [chartIndex, setChartIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState(null);
  const [userNav, setUserNav] = useState(null);

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

  // Set of tickers with active weekly BL — used to highlight confirmed scouts
  const weeklyBLTickers = useMemo(() => {
    if (!doc?.orders) return new Set();
    return new Set(doc.orders.filter(o => o.signal === 'BL').map(o => o.ticker));
  }, [doc]);

  const orders = useMemo(() => {
    if (!doc?.orders) return [];
    return doc.orders.filter(o => {
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
  }, [doc, filter, navScale]);

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

      {/* Sector strip */}
      <SectorSummaryStrip summary={doc?.sectorSummary} />

      {/* Stats + filters */}
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

      {/* Orders table */}
      {orders.length > 0 && (
        <div style={{ overflowX: 'auto', margin: '8px 0' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'monospace' }}>
            <thead>
              <tr style={{ background: '#1a1a1a', color: '#fcf000', textAlign: 'left' }}>
                <th style={{ padding: '8px 10px' }}>Grade</th>
                <th style={{ padding: '8px 10px' }}>Signal</th>
                <th style={{ padding: '8px 10px' }}>Ticker</th>
                <th style={{ padding: '8px 10px' }}>Sector</th>
                <th style={{ padding: '8px 10px' }}>Tier</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Gap %</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Slope %</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Price</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Stop</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Risk %</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Entry sh</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Entry $</th>
                <th style={{ padding: '8px 10px' }}>Signal Date</th>
                <th style={{ padding: '8px 10px' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {orders.map(o => (
                <tr key={`${o.signal}-${o.ticker}`} style={{
                  borderBottom: '1px solid #1a1a1a',
                  background: o.isNewSignal ? 'rgba(252,240,0,0.04)' : 'transparent',
                  cursor: 'pointer',
                }}
                onClick={() => {
                  const tickers = orders.map(x => x.ticker);
                  setChartTickers(tickers);
                  setChartIndex(tickers.indexOf(o.ticker));
                }}
                onMouseEnter={e => e.currentTarget.style.background = '#1a1a1a'}
                onMouseLeave={e => e.currentTarget.style.background = o.isNewSignal ? 'rgba(252,240,0,0.04)' : 'transparent'}
                >
                  <td style={{ padding: '6px 10px', textAlign: 'center', fontSize: 14 }}>
                    {o.qualityGrade === 'BEST' ? <span style={{ color: '#fcf000' }} title="Gap>15%, Slope<20%">★</span>
                     : o.qualityGrade === 'GOOD' ? <span style={{ color: '#16a34a' }} title="Gap>12%, Slope<20%">✓</span>
                     : <span style={{ color: '#666' }} title="Does not meet scout criteria">✗</span>}
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
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Daily Cascade Scouts */}
      {doc?.scouts?.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
            <h2 style={{ color: '#00e5ff', margin: 0, fontSize: 18, letterSpacing: '0.04em' }}>Daily Cascade Scouts</h2>
            <span style={{ color: '#888', fontSize: 12 }}>50% of Lot 1 — 28-day conversion window</span>
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
                  <th style={{ padding: '8px 10px' }}>Grade</th>
                  <th style={{ padding: '8px 10px' }}>Status</th>
                  <th style={{ padding: '8px 10px' }}>Ticker</th>
                  <th style={{ padding: '8px 10px' }}>Sector</th>
                  <th style={{ padding: '8px 10px' }}>Tier</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>Entry</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>Stop</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>Scout sh</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>Full L1</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>Gap %</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>Slope %</th>
                  <th style={{ padding: '8px 10px' }}>Entry Date</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>Days Open</th>
                </tr>
              </thead>
              <tbody>
                {[...doc.scouts]
                  .sort((a, b) => {
                    // Converted first, then weekly-confirmed, then active
                    const aRank = a.status === 'CONVERTED' ? 0 : weeklyBLTickers.has(a.ticker) ? 1 : 2;
                    const bRank = b.status === 'CONVERTED' ? 0 : weeklyBLTickers.has(b.ticker) ? 1 : 2;
                    return aRank - bRank;
                  })
                  .map(s => {
                  const isConverted = s.status === 'CONVERTED';
                  const hasWeeklyBL = weeklyBLTickers.has(s.ticker);
                  const isConfirmed = isConverted || hasWeeklyBL;
                  const scaledShares = Math.max(1, Math.round(s.shares * navScale));
                  const scaledFullL1 = Math.max(1, Math.round(s.fullLot1Shares * navScale));
                  const rowBg = isConfirmed ? 'rgba(252,240,0,0.08)' : 'transparent';
                  return (
                    <tr key={`scout-${s.ticker}`} style={{
                      borderBottom: isConfirmed ? '1px solid rgba(252,240,0,0.3)' : '1px solid #1a1a1a',
                      borderTop: isConfirmed ? '1px solid rgba(252,240,0,0.3)' : 'none',
                      background: rowBg,
                      cursor: 'pointer',
                      boxShadow: isConfirmed ? 'inset 3px 0 0 #fcf000' : 'none',
                    }}
                    onClick={() => {
                      setChartTickers([s.ticker]);
                      setChartIndex(0);
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = isConfirmed ? 'rgba(252,240,0,0.14)' : '#1a1a1a'}
                    onMouseLeave={e => e.currentTarget.style.background = rowBg}
                    >
                      <td style={{ padding: '6px 10px', textAlign: 'center', fontSize: 14 }}>
                        {s.qualityGrade === 'BEST' ? <span style={{ color: '#fcf000' }} title="Gap>15%, Slope<20%">★</span>
                         : s.qualityGrade === 'GOOD' ? <span style={{ color: '#16a34a' }} title="Gap>12%, Slope<20%">✓</span>
                         : <span style={{ color: '#666' }}>—</span>}
                      </td>
                      <td style={{ padding: '6px 10px' }}>
                        {isConverted ? (
                          <span style={{
                            padding: '2px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700,
                            background: '#fcf000', color: '#000',
                          }}>CONVERTED</span>
                        ) : hasWeeklyBL ? (
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
                      <td style={{ padding: '6px 10px', fontWeight: 700, color: isConfirmed ? '#fcf000' : '#fff' }}>{s.ticker}</td>
                      <td style={{ padding: '6px 10px', color: '#aaa', fontSize: 11 }}>S{s.sectorId} {s.sectorName?.split(' ').slice(0, 2).join(' ')}</td>
                      <td style={{ padding: '6px 10px' }}><TierPill tier={s.sectorTier} /></td>
                      <td style={{ padding: '6px 10px', textAlign: 'right' }}>{fmtUsd(s.entryPrice)}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: '#aaa' }}>{fmtUsd(s.stopPrice)}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: isConfirmed ? '#fcf000' : '#00e5ff' }}>{scaledShares}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: isConfirmed ? '#fcf000' : '#aaa' }}>{scaledFullL1}</td>
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

      {/* Footer note */}
      <div style={{ marginTop: 16, fontSize: 11, color: '#666', lineHeight: 1.6 }}>
        Sized at 1% NAV vitality × sector multiplier on your ${(userNav || 100000).toLocaleString()} NAV. Lot 1 = 35% of full target.
        BL skipped if sector NO_GO · SS skipped if sector GO · PAI300 36W EMA hard gate blocks all BL in bear regime.
        Quality grades: ★ BEST (Gap{'>'}15%, Slope{'<'}20%) · ✓ GOOD (Gap{'>'}12%, Slope{'<'}20%) · ✗ SKIP.
        Daily Cascade scouts enter at 50% of Lot 1 — gold = weekly BL confirmed → enter remaining 50% for full Lot 1 → pyramid continues.
        Realized DD -5.4% (backtest). 10% portfolio heat cap enforced.
      </div>

      {/* Chart modal — clicking a row opens the AI ticker chart with prev/next */}
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
