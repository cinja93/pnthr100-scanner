// client/src/components/EarningsSeasonTable.jsx
// ── PNTHR Earnings Season snapshot ──────────────────────────────────────────
// Beat / Met / Miss rollup of the current fiscal reporting quarter across the
// S&P 500 sectors. Calls GET /api/earnings-season (server-side 12h cache).
// Sectors with zero reports render muted; rows with reports get colored
// counts and % of reported. Aggregate S&P 500 row pinned in the footer.
//
// Rendered at the top of CalendarPage.

import { useState, useEffect } from 'react';
import { fetchEarningsSeason } from '../services/api';

const thL = { textAlign: 'left',  padding: '8px 12px', fontWeight: 700 };
const thR = { textAlign: 'right', padding: '8px 12px', fontWeight: 700 };
const tdL = { textAlign: 'left',  padding: '8px 12px', fontSize: 12 };
const tdR = { textAlign: 'right', padding: '8px 12px', fontSize: 12 };

export default function EarningsSeasonTable() {
  const [snap, setSnap]             = useState(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async ({ refresh = false } = {}) => {
    try {
      if (refresh) setRefreshing(true); else setLoading(true);
      setError(null);
      const data = await fetchEarningsSeason({ refresh });
      setSnap(data);
    } catch (e) {
      setError(e.message || 'Failed to load earnings season');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { load(); }, []);

  const fmtPct   = (n) => n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
  const pctOf    = (n) => n == null ? '' : `(${n.toFixed(1)}%)`;
  const ageLabel = snap?.cacheAgeMinutes == null
    ? ''
    : snap.cacheAgeMinutes < 60
      ? `${snap.cacheAgeMinutes}m ago`
      : `${Math.floor(snap.cacheAgeMinutes / 60)}h ago`;

  return (
    <div style={{
      background:   '#0c0c0c',
      border:       '1px solid #1e1e1e',
      borderRadius: 8,
      marginBottom: 20,
      overflow:     'hidden',
    }}>
      <div style={{
        padding:     '10px 16px',
        background:  '#111',
        borderBottom: '1px solid #1a1a1a',
        display:     'flex',
        alignItems:  'center',
        gap:         14,
        flexWrap:    'wrap',
      }}>
        <span style={{
          color: '#FCF000', fontSize: 12, fontWeight: 900, letterSpacing: '0.14em',
          fontFamily: "'Inter', 'Segoe UI', sans-serif",
        }}>
          EARNINGS SEASON · {snap?.season || '—'}
        </span>
        {snap && (
          <span style={{ fontSize: 11, color: '#888' }}>
            {snap.totals?.reported ?? 0} of {snap.sp500Count ?? 0} S&P 500 reported
            ({((snap.totals?.reported ?? 0) / Math.max(1, snap.sp500Count ?? 1) * 100).toFixed(1)}%)
          </span>
        )}
        <span style={{ flex: 1 }} />
        {ageLabel && <span style={{ fontSize: 10, color: '#555' }}>cached {ageLabel}</span>}
        <button
          onClick={() => load({ refresh: true })}
          disabled={refreshing}
          style={{
            padding: '4px 10px',
            fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
            background: 'rgba(252,240,0,0.1)',
            color: '#FCF000',
            border: '1px solid rgba(252,240,0,0.35)',
            borderRadius: 4,
            cursor: refreshing ? 'wait' : 'pointer',
            opacity: refreshing ? 0.6 : 1,
          }}
        >{refreshing ? '…REFRESHING' : '↺ REFRESH'}</button>
      </div>

      {loading && !snap && (
        <div style={{ padding: 20, color: '#666', fontSize: 12 }}>Loading earnings season…</div>
      )}
      {error && (
        <div style={{ padding: 20, color: '#dc3545', fontSize: 12 }}>Error: {error}</div>
      )}

      {snap && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{
            width: '100%', borderCollapse: 'collapse', minWidth: 820,
            fontVariantNumeric: 'tabular-nums',
          }}>
            <thead>
              <tr style={{ background: '#0e0e0e', color: '#777', fontSize: 10, letterSpacing: '0.06em' }}>
                <th style={thL}>SECTOR</th>
                <th style={thR}>REPORTED</th>
                <th style={thR}>AVG MISS %</th>
                <th style={thR}>MISS</th>
                <th style={thR}>MET</th>
                <th style={thR}>BEAT</th>
                <th style={thR}>AVG BEAT %</th>
              </tr>
            </thead>
            <tbody>
              {snap.sectors.map(s => {
                const dim = s.reported === 0;
                const rowStyle = { borderTop: '1px solid #161616', color: dim ? '#444' : '#ddd' };
                return (
                  <tr key={s.sector} style={rowStyle}>
                    <td style={{ ...tdL, fontWeight: 700, color: dim ? '#444' : '#e0e0e0' }}>
                      {s.sector}
                    </td>
                    <td style={tdR}>
                      <span style={{ color: dim ? '#444' : '#e0e0e0' }}>
                        {s.reported} / {s.sp500Count}
                      </span>
                    </td>
                    <td style={{ ...tdR, color: s.miss > 0 ? '#ef5350' : '#333' }}>
                      {s.miss > 0 ? fmtPct(s.avgMissSurprisePct) : '—'}
                    </td>
                    <td style={{ ...tdR, color: s.miss > 0 ? '#ef5350' : dim ? '#333' : '#555' }}>
                      {s.miss > 0 ? <><b>{s.miss}</b> <span style={{ opacity: 0.7 }}>{pctOf(s.missPct)}</span></> : '—'}
                    </td>
                    <td style={{ ...tdR, color: s.met > 0 ? '#b0b0b0' : dim ? '#333' : '#555' }}>
                      {s.met > 0 ? <><b>{s.met}</b> <span style={{ opacity: 0.7 }}>{pctOf(s.metPct)}</span></> : '—'}
                    </td>
                    <td style={{ ...tdR, color: s.beat > 0 ? '#22c55e' : dim ? '#333' : '#555' }}>
                      {s.beat > 0 ? <><b>{s.beat}</b> <span style={{ opacity: 0.7 }}>{pctOf(s.beatPct)}</span></> : '—'}
                    </td>
                    <td style={{ ...tdR, color: s.beat > 0 ? '#22c55e' : '#333' }}>
                      {s.beat > 0 ? fmtPct(s.avgBeatSurprisePct) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{
                borderTop: '2px solid #2a2a2a',
                background: '#0e0e0e',
                color: '#FCF000',
                fontWeight: 700,
              }}>
                <td style={{ ...tdL, fontWeight: 900 }}>{snap.totals.sector}</td>
                <td style={tdR}>{snap.totals.reported} / {snap.totals.sp500Count}</td>
                <td style={{ ...tdR, color: snap.totals.miss > 0 ? '#ef5350' : '#666' }}>
                  {snap.totals.miss > 0 ? fmtPct(snap.totals.avgMissSurprisePct) : '—'}
                </td>
                <td style={{ ...tdR, color: '#ef5350' }}>
                  <b>{snap.totals.miss}</b> <span style={{ opacity: 0.7 }}>{pctOf(snap.totals.missPct)}</span>
                </td>
                <td style={{ ...tdR, color: '#b0b0b0' }}>
                  <b>{snap.totals.met}</b> <span style={{ opacity: 0.7 }}>{pctOf(snap.totals.metPct)}</span>
                </td>
                <td style={{ ...tdR, color: '#22c55e' }}>
                  <b>{snap.totals.beat}</b> <span style={{ opacity: 0.7 }}>{pctOf(snap.totals.beatPct)}</span>
                </td>
                <td style={{ ...tdR, color: snap.totals.beat > 0 ? '#22c55e' : '#666' }}>
                  {snap.totals.beat > 0 ? fmtPct(snap.totals.avgBeatSurprisePct) : '—'}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
