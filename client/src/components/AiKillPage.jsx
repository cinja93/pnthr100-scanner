import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../AuthContext';
import { fetchLatestAiKill, runAiKill } from '../services/api';
import AiTickerChartModal from './AiTickerChartModal';

// PNTHR AI Kill v1
//   Total = (D2 + D3 + D4) × D1   — D5/D6/D7/D8 deferred (set 0 in v1)
//   Same tier ladder as 679 Kill.

const TIER_COLORS = {
  'ALPHA AI KILL': { bg: '#fcf000', fg: '#000' },
  'STRIKING':      { bg: '#dc2626', fg: '#fff' },
  'HUNTING':       { bg: '#ea580c', fg: '#fff' },
  'POUNCING':      { bg: '#f97316', fg: '#fff' },
  'COILING':       { bg: '#eab308', fg: '#000' },
  'STALKING':      { bg: '#84cc16', fg: '#000' },
  'TRACKING':      { bg: '#22c55e', fg: '#000' },
  'PROWLING':      { bg: '#0ea5e9', fg: '#fff' },
  'STIRRING':      { bg: '#737373', fg: '#fff' },
  'DORMANT':       { bg: '#404040', fg: '#fff' },
};

function TierPill({ tier }) {
  const c = TIER_COLORS[tier] || { bg: '#444', fg: '#fff' };
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 3, fontSize: 10,
      fontWeight: 700, letterSpacing: '0.06em',
      background: c.bg, color: c.fg, whiteSpace: 'nowrap',
    }}>{tier}</span>
  );
}

function fmtUsd(n) {
  if (n == null || isNaN(n)) return '—';
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

export default function AiKillPage() {
  const { isAdmin } = useAuth();
  const [doc, setDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all'); // all | bl | ss | top10
  const [chartTicker, setChartTicker] = useState(null);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState(null);

  const load = () => {
    setLoading(true);
    fetchLatestAiKill()
      .then(d => { setDoc(d); setError(null); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  const scores = useMemo(() => {
    if (!doc?.scores) return [];
    let arr = doc.scores;
    if (filter === 'bl')    arr = arr.filter(s => s.signal === 'BL');
    if (filter === 'ss')    arr = arr.filter(s => s.signal === 'SS');
    if (filter === 'top10') arr = arr.slice(0, 10);
    return arr;
  }, [doc, filter]);

  const onRun = async () => {
    setRunning(true); setRunMsg(null);
    try {
      const r = await runAiKill();
      setRunMsg(`Scored ${r.scoredCount} names`);
      load();
    } catch (e) {
      setRunMsg(`Failed: ${e.message}`);
    } finally { setRunning(false); }
  };

  return (
    <div style={{ padding: '20px 24px', color: '#e5e5e5', minHeight: '100vh', background: '#0a0a0a' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ color: '#fcf000', margin: 0, fontSize: 26, letterSpacing: '0.04em' }}>PNTHR AI Kill</h1>
        <span style={{ color: '#888', fontSize: 13 }}>v1 — (D2 + D3 + D4) × D1</span>
        <span style={{
          padding: '3px 8px', background: '#fcf000', color: '#000', borderRadius: 3,
          fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
        }}>AI 300</span>
      </div>

      {doc && (
        <div style={{ marginTop: 12, fontSize: 13, color: '#ccc' }}>
          Week of <strong style={{ color: '#fff' }}>{doc.weekOf}</strong>
          {doc.pai300Bull != null && (
            <span style={{ marginLeft: 12, padding: '3px 8px', borderRadius: 3, fontSize: 10, fontWeight: 700,
                background: doc.pai300Bull ? '#16a34a' : '#dc2626', color: '#fff' }}>
              {doc.pai300Bull ? 'PAI300 BULL' : 'PAI300 BEAR'}
            </span>
          )}
          {doc.generatedAt && <span style={{ color: '#666' }}> · generated {new Date(doc.generatedAt).toLocaleString()}</span>}
        </div>
      )}

      {/* Tier breakdown strip */}
      {doc?.tierBreakdown && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', margin: '12px 0' }}>
          {Object.entries(TIER_COLORS).map(([name]) => {
            const count = doc.tierBreakdown[name] || 0;
            if (count === 0) return null;
            return (
              <span key={name} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <TierPill tier={name} />
                <strong style={{ color: '#fff' }}>{count}</strong>
              </span>
            );
          })}
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0' }}>
        {[
          { k: 'all',   label: 'All' },
          { k: 'top10', label: 'Top 10' },
          { k: 'bl',    label: 'BL only' },
          { k: 'ss',    label: 'SS only' },
        ].map(o => (
          <button key={o.k} onClick={() => setFilter(o.k)} style={{
            padding: '4px 10px', fontSize: 11, fontWeight: 600,
            background: filter === o.k ? '#fcf000' : 'transparent',
            color: filter === o.k ? '#000' : '#aaa',
            border: '1px solid #444', borderRadius: 3, cursor: 'pointer',
          }}>{o.label}</button>
        ))}
        <span style={{ color: '#666', fontSize: 11, marginLeft: 'auto' }}>
          {scores.length} of {doc?.scoredCount || 0} shown
        </span>
        {isAdmin && (
          <button onClick={onRun} disabled={running} style={{
            padding: '4px 10px', fontSize: 11, fontWeight: 700,
            background: '#fcf000', color: '#000', border: 'none', borderRadius: 3,
            cursor: running ? 'wait' : 'pointer',
          }}>{running ? 'RUNNING…' : 'RECOMPUTE'}</button>
        )}
      </div>
      {runMsg && <div style={{ fontSize: 11, color: '#fcf000' }}>{runMsg}</div>}

      {loading && !doc && <div style={{ color: '#666', padding: 20 }}>Loading scores…</div>}
      {error && <div style={{ color: '#dc2626', padding: 20 }}>{error}</div>}

      {/* Scores table */}
      {scores.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'monospace' }}>
            <thead>
              <tr style={{ background: '#1a1a1a', color: '#fcf000', textAlign: 'left' }}>
                <th style={{ padding: '8px 10px' }}>#</th>
                <th style={{ padding: '8px 10px' }}>Tier</th>
                <th style={{ padding: '8px 10px' }}>Ticker</th>
                <th style={{ padding: '8px 10px' }}>Signal</th>
                <th style={{ padding: '8px 10px' }}>Sector</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Total</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>D1</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>D2</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>D3</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>D4</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Risk %</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Price</th>
                <th style={{ padding: '8px 10px' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {scores.map(s => (
                <tr key={s.ticker} style={{
                  borderBottom: '1px solid #1a1a1a',
                  background: s.killRank <= 4 ? 'rgba(252,240,0,0.06)' : 'transparent',
                  cursor: 'pointer',
                }}
                onClick={() => setChartTicker(s.ticker)}
                onMouseEnter={e => e.currentTarget.style.background = '#1a1a1a'}
                onMouseLeave={e => e.currentTarget.style.background = s.killRank <= 4 ? 'rgba(252,240,0,0.06)' : 'transparent'}
                >
                  <td style={{ padding: '6px 10px', color: '#888' }}>{s.killRank}</td>
                  <td style={{ padding: '6px 10px' }}><TierPill tier={s.tierName} /></td>
                  <td style={{ padding: '6px 10px', fontWeight: 700, color: '#fff' }}>{s.ticker}</td>
                  <td style={{ padding: '6px 10px', fontWeight: 700, color: s.signal === 'BL' ? '#16a34a' : '#dc2626' }}>{s.signal}</td>
                  <td style={{ padding: '6px 10px', color: '#aaa', fontSize: 11 }}>S{s.sectorId} {s.sectorName?.split(' ').slice(0, 2).join(' ')}</td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', color: '#fcf000', fontWeight: 700 }}>{s.total?.toFixed(1)}</td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', color: '#aaa' }}>{s.scores?.d1?.toFixed(2)}×</td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', color: s.scores?.d2 > 0 ? '#16a34a' : s.scores?.d2 < 0 ? '#dc2626' : '#aaa' }}>{s.scores?.d2}</td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', color: '#aaa' }}>{s.scores?.d3?.toFixed(0)}</td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', color: s.scores?.d4 > 0 ? '#16a34a' : s.scores?.d4 < 0 ? '#dc2626' : '#aaa' }}>{s.scores?.d4}</td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', color: '#aaa' }}>{s.riskPct != null ? `${s.riskPct.toFixed(1)}%` : '—'}</td>
                  <td style={{ padding: '6px 10px', textAlign: 'right' }}>{fmtUsd(s.currentPrice)}</td>
                  <td style={{ padding: '6px 10px' }}>
                    {s.isNewSignal
                      ? <span style={{ color: '#fcf000', fontWeight: 700, fontSize: 10 }}>★ NEW</span>
                      : <span style={{ color: '#666', fontSize: 10 }}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer */}
      <div style={{ marginTop: 16, fontSize: 11, color: '#666', lineHeight: 1.6 }}>
        Score = (D2 + D3 + D4) × D1.
        D1 PAI300 36W regime mult (0.7×–1.3×).
        D2 sector tier ±15.
        D3 entry quality 0–85 (conviction + slope + tightness).
        D4 freshness +10 NEW / -1 per week stale.
        D5 D6 D7 D8 set to 0 in v1 (rank-history, daily momentum, AI Prey not built yet).
        Cron refreshes daily ~5:30pm ET.
      </div>

      {chartTicker && <AiTickerChartModal ticker={chartTicker} onClose={() => setChartTicker(null)} />}
    </div>
  );
}
