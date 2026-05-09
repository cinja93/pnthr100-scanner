import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../AuthContext';
import { fetchLatestAiOrders, runAiOrders } from '../services/api';
import AiTickerChartModal from './AiTickerChartModal';

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
  const [filter, setFilter] = useState('all'); // all | bl | ss | new
  const [chartTicker, setChartTicker] = useState(null);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState(null);

  const load = () => {
    setLoading(true);
    fetchLatestAiOrders()
      .then(d => { setDoc(d); setError(null); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
    const id = setInterval(load, 60_000); // 60s refresh
    return () => clearInterval(id);
  }, []);

  const orders = useMemo(() => {
    if (!doc?.orders) return [];
    return doc.orders.filter(o => {
      if (filter === 'bl')  return o.signal === 'BL';
      if (filter === 'ss')  return o.signal === 'SS';
      if (filter === 'new') return o.isNewSignal;
      return true;
    });
  }, [doc, filter]);

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
            skipped: BL/NO_GO <strong style={{ color: '#dc2626' }}>{doc.stats.skippedNoGoBL}</strong> ·
            SS/GO <strong style={{ color: '#dc2626' }}>{doc.stats.skippedGoSS}</strong>
          </div>

          <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
            {[
              { k: 'all', label: 'All' },
              { k: 'bl',  label: 'BL only' },
              { k: 'ss',  label: 'SS only' },
              { k: 'new', label: 'New this week' },
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
                <th style={{ padding: '8px 10px' }}>Signal</th>
                <th style={{ padding: '8px 10px' }}>Ticker</th>
                <th style={{ padding: '8px 10px' }}>Sector</th>
                <th style={{ padding: '8px 10px' }}>Tier</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Mult</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Price</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Stop</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Risk %</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Lot 1 sh</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Lot 1 $</th>
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
                onClick={() => setChartTicker(o.ticker)}
                onMouseEnter={e => e.currentTarget.style.background = '#1a1a1a'}
                onMouseLeave={e => e.currentTarget.style.background = o.isNewSignal ? 'rgba(252,240,0,0.04)' : 'transparent'}
                >
                  <td style={{ padding: '6px 10px', fontWeight: 700, color: o.signal === 'BL' ? '#16a34a' : '#dc2626' }}>{o.signal}</td>
                  <td style={{ padding: '6px 10px', fontWeight: 700, color: '#fff' }}>{o.ticker}</td>
                  <td style={{ padding: '6px 10px', color: '#aaa', fontSize: 11 }}>S{o.sectorId} {o.sectorName?.split(' ').slice(0, 2).join(' ')}</td>
                  <td style={{ padding: '6px 10px' }}><TierPill tier={o.sectorTier} /></td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', color: o.sectorMult >= 1.25 ? '#fcf000' : '#aaa' }}>{o.sectorMult?.toFixed(2)}×</td>
                  <td style={{ padding: '6px 10px', textAlign: 'right' }}>{fmtUsd(o.currentPrice)}</td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', color: '#aaa' }}>{fmtUsd(o.stopPrice)}</td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', color: o.riskPct > 20 ? '#fcf000' : '#aaa' }}>{o.riskPct?.toFixed(1)}%</td>
                  <td style={{ padding: '6px 10px', textAlign: 'right' }}>{o.lot1Shares?.toLocaleString()}</td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', color: '#aaa' }}>{fmtUsd(o.lot1Dollar, { k: true })}</td>
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

      {/* Footer note */}
      <div style={{ marginTop: 16, fontSize: 11, color: '#666', lineHeight: 1.6 }}>
        Sized at 1% NAV vitality × sector multiplier on a $1M reference NAV. Lot 1 = 35% of full target.
        BL skipped if sector NO_GO (cooling) · SS skipped if sector GO (heating).
        Sector rank refreshes daily ~5:30pm ET after constituent close.
      </div>

      {/* Chart modal — clicking a row opens the AI ticker chart */}
      {chartTicker && (
        <AiTickerChartModal ticker={chartTicker} onClose={() => setChartTicker(null)} />
      )}
    </div>
  );
}
