import { useState, useEffect, useMemo } from 'react';
import { fetchPnthrAi300Weights, fetchFcfData } from '../services/api';
import pantherHead from '../assets/panther head.png';

// Pnthr300WeightsModal — popup showing how each of the 304 constituents is
// weighted in the PNTHR AI 300, plus a per-sector roll-up. Read from
// /api/pnthr-ai-300/weights (sourced from pnthr_ai_index_meta after each
// monthly rebalance). Searchable, sortable.

const SORT_OPTIONS = [
  { key: 'weight',  label: 'Weight (high → low)', dir: 'desc' },
  { key: 'weightAsc', label: 'Weight (low → high)', dir: 'asc' },
  { key: 'ticker',  label: 'Ticker A-Z',           dir: 'asc' },
  { key: 'sector',  label: 'Sector',                dir: 'asc' },
];

function fmtWeight(w) {
  if (w == null) return '—';
  // Anything ≥ 0.10% shows two decimals; tiny weights show three for visibility
  return w >= 0.1 ? `${w.toFixed(2)}%` : `${w.toFixed(3)}%`;
}

function getFcfColor(fcf) {
  if (fcf == null) return '#666';
  if (fcf > 50_000_000) return '#00c853';
  if (fcf > 0) return '#69f0ae';
  if (fcf > -50_000_000) return '#ffd600';
  return '#ff5252';
}

function getFcfLabel(fcf) {
  if (fcf == null) return 'No FCF data';
  if (fcf > 50_000_000) return `FCF: +$${(fcf / 1e9).toFixed(1)}B`;
  if (fcf > 0) return `FCF: +$${(fcf / 1e6).toFixed(0)}M`;
  if (fcf > -50_000_000) return `FCF: -$${(Math.abs(fcf) / 1e6).toFixed(0)}M (breakeven)`;
  return `FCF: -$${(Math.abs(fcf) / 1e9).toFixed(1)}B`;
}

const fcfBillStyle = {
  display: 'inline-block', fontSize: 9, fontWeight: 900, padding: '1px 4px',
  borderRadius: 2, color: '#000', lineHeight: 1, verticalAlign: 'middle', marginLeft: 6,
};

export default function Pnthr300WeightsModal({ onClose }) {
  const [data, setData]       = useState(null);
  const [fcfMap, setFcfMap]   = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [search, setSearch]   = useState('');
  const [sortKey, setSortKey] = useState('weight');
  const [tab, setTab]         = useState('constituents'); // 'constituents' | 'sectors'

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    Promise.all([fetchPnthrAi300Weights(), fetchFcfData()])
      .then(([d, fcf]) => { if (!cancelled) { setData(d); setFcfMap(fcf || {}); } })
      .catch(e => { if (!cancelled) setError(e.message || 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    if (!data?.constituents) return [];
    let list = data.constituents;
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(c =>
        c.ticker.toLowerCase().includes(q) ||
        (c.name && c.name.toLowerCase().includes(q)) ||
        (c.sector && c.sector.toLowerCase().includes(q))
      );
    }
    const sorted = [...list];
    switch (sortKey) {
      case 'weightAsc': sorted.sort((a, b) => a.weight - b.weight); break;
      case 'ticker':    sorted.sort((a, b) => a.ticker.localeCompare(b.ticker)); break;
      case 'sector':    sorted.sort((a, b) => a.sector.localeCompare(b.sector) || b.weight - a.weight); break;
      default:          sorted.sort((a, b) => b.weight - a.weight); break; // weight desc
    }
    return sorted;
  }, [data, search, sortKey]);

  const maxWeight = data?.constituents?.[0]?.weight ?? 4; // for the bar scale

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 9999, padding: 24,
      }}
    >
      <div style={{
        background: '#0a0a0a', borderRadius: 8, width: '100%', maxWidth: 920,
        height: '85vh', display: 'flex', flexDirection: 'column',
        border: '1px solid #2a2a2a', boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
      }}>
        {/* Header */}
        <div style={{
          padding: '14px 20px', borderBottom: '1px solid #1f1f1f',
          display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
        }}>
          <img src={pantherHead} alt="PNTHR" style={{ width: 40, height: 40, opacity: 0.95 }} />
          <div>
            <div style={{ color: '#fcf000', fontSize: 18, fontWeight: 700, letterSpacing: '0.02em' }}>
              PNTHR AI 300 — Constituent Weights
            </div>
            <div style={{ color: '#888', fontSize: 11, marginTop: 2 }}>
              {data?.ok
                ? <>{data.constituentCount} holdings · capped market-cap weighted (4% / 1.5% hyperscaler) · as of last rebalance <strong style={{ color: '#fcf000' }}>{data.asOfRebalance}</strong></>
                : <>Loading methodology…</>}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              marginLeft: 'auto', background: 'transparent', border: '1px solid #2a2a2a',
              borderRadius: 4, color: '#888', padding: '6px 10px', cursor: 'pointer', fontSize: 12,
            }}
            title="Close"
          >
            ✕
          </button>
        </div>

        {/* Tab switcher */}
        <div style={{ padding: '10px 20px', borderBottom: '1px solid #1f1f1f', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', borderRadius: 4, overflow: 'hidden', border: '1px solid #2a2a2a' }}>
            {[
              { key: 'constituents', label: '304 Constituents' },
              { key: 'sectors',      label: 'By Sector' },
            ].map(t => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                style={{
                  padding: '6px 14px', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
                  background: tab === t.key ? '#fcf000' : 'transparent',
                  color: tab === t.key ? '#000' : '#888',
                  border: 'none', cursor: 'pointer', textTransform: 'uppercase',
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'constituents' && (
            <>
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search ticker, name, or sector…"
                style={{
                  flex: 1, minWidth: 200, padding: '6px 10px', fontSize: 12,
                  background: '#111', border: '1px solid #2a2a2a', borderRadius: 4,
                  color: '#d4d4d4', outline: 'none',
                }}
              />
              <select
                value={sortKey}
                onChange={e => setSortKey(e.target.value)}
                style={{
                  padding: '6px 10px', fontSize: 11, fontWeight: 600,
                  background: '#111', border: '1px solid #2a2a2a', borderRadius: 4,
                  color: '#d4d4d4', cursor: 'pointer',
                }}
              >
                {SORT_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
            </>
          )}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', position: 'relative' }}>
          {loading && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888' }}>Loading…</div>}
          {error && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#dc2626' }}>{error}</div>}

          {!loading && !error && data?.ok && tab === 'constituents' && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ position: 'sticky', top: 0, background: '#111', zIndex: 1 }}>
                <tr style={{ color: '#888', textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.06em' }}>
                  <th style={{ padding: '8px 12px', textAlign: 'right',  width: 50 }}>#</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left',   width: 80 }}>Ticker</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left' }}>Name</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left',   width: 220 }}>Sector</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right',  width: 90 }}>Weight</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left',   width: 140 }}>Bar</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => {
                  const barPct = maxWeight > 0 ? (c.weight / maxWeight) * 100 : 0;
                  // Hyperscaler-capped names (1.5%) vs single-name-capped (4%)
                  const isAtSingleCap = c.weight >= 3.99;
                  const isAtHyperCap  = c.weight >= 1.49 && c.weight <= 1.51;
                  const barColor = isAtSingleCap ? '#dc2626' : isAtHyperCap ? '#f59e0b' : '#16a34a';
                  return (
                    <tr key={c.ticker} style={{ borderTop: '1px solid #1a1a1a' }}>
                      <td style={{ padding: '8px 12px', textAlign: 'right', color: '#666', fontFamily: 'monospace' }}>{c.rank}</td>
                      <td style={{ padding: '8px 12px', fontWeight: 700, color: '#fcf000', fontFamily: 'monospace' }}>
                        {c.ticker}
                        <span style={{ ...fcfBillStyle, backgroundColor: getFcfColor(fcfMap[c.ticker]) }} title={getFcfLabel(fcfMap[c.ticker])}>$</span>
                      </td>
                      <td style={{ padding: '8px 12px', color: '#d4d4d4' }}>{c.name}</td>
                      <td style={{ padding: '8px 12px', color: '#888', fontSize: 11 }}>{c.sector}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: '#fff' }}>
                        {fmtWeight(c.weight)}
                      </td>
                      <td style={{ padding: '8px 12px' }}>
                        <div style={{ width: '100%', height: 6, background: '#1a1a1a', borderRadius: 3, overflow: 'hidden' }}>
                          <div style={{ width: `${barPct}%`, height: '100%', background: barColor }} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr><td colSpan={6} style={{ padding: 30, textAlign: 'center', color: '#666' }}>No matches.</td></tr>
                )}
              </tbody>
            </table>
          )}

          {!loading && !error && data?.ok && tab === 'sectors' && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ position: 'sticky', top: 0, background: '#111', zIndex: 1 }}>
                <tr style={{ color: '#888', textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.06em' }}>
                  <th style={{ padding: '8px 12px', textAlign: 'right',  width: 50 }}>#</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left' }}>Sector</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right',  width: 90 }}>Holdings</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right',  width: 110 }}>Live Weight</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right',  width: 110 }}>Target</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left',   width: 200 }}>Bar</th>
                </tr>
              </thead>
              <tbody>
                {data.sectors.map((s, i) => {
                  const maxSec = data.sectors[0]?.weight ?? 1;
                  const barPct = (s.weight / maxSec) * 100;
                  const driftPp = s.target != null ? s.weight - s.target : null;  // positive = overweight target
                  return (
                    <tr key={s.id ?? i} style={{ borderTop: '1px solid #1a1a1a' }}>
                      <td style={{ padding: '8px 12px', textAlign: 'right', color: '#666', fontFamily: 'monospace' }}>{i + 1}</td>
                      <td style={{ padding: '8px 12px', color: '#fcf000', fontWeight: 700 }}>{s.name}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', color: '#888', fontFamily: 'monospace' }}>{s.count}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: '#fff' }}>
                        {fmtWeight(s.weight)}
                      </td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace', color: '#888' }}>
                        {s.target != null ? `${s.target}%` : '—'}
                        {driftPp != null && Math.abs(driftPp) >= 0.5 && (
                          <span style={{ marginLeft: 6, fontSize: 10, color: driftPp > 0 ? '#16a34a' : '#dc2626' }}>
                            {driftPp > 0 ? '+' : ''}{driftPp.toFixed(1)}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '8px 12px' }}>
                        <div style={{ width: '100%', height: 6, background: '#1a1a1a', borderRadius: 3, overflow: 'hidden' }}>
                          <div style={{ width: `${barPct}%`, height: '100%', background: '#16a34a' }} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '8px 20px', borderTop: '1px solid #1f1f1f',
          fontSize: 10, color: '#666', fontStyle: 'italic',
          display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8,
        }}>
          <span>Weights capped + redistributed iteratively (Nasdaq-100 style). Drift between rebalances reflects real performance — winners run within their cap.</span>
          {data?.ok && <span>Total: {fmtWeight(data.totalWeight)}</span>}
        </div>
      </div>
    </div>
  );
}
