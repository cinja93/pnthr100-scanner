// MoversLogModal — research tool tracking every BL+1/SS+1 that appeared on
// the PNTHR Movers banner. Shows entry, current price, return %, days held,
// and exit reason (BE/SE/STOP) once closed.

import { useState, useEffect } from 'react';
import { fetchMoversLog } from '../services/api';

const FILTER_OPTIONS = ['ALL', 'OPEN', 'CLOSED'];

function statusColor(status) {
  if (status === 'OPEN') return '#fcf000';
  if (status === 'CLOSED-BE') return '#22c55e';
  if (status === 'CLOSED-SE') return '#22c55e';
  if (status === 'CLOSED-STOP') return '#ef4444';
  return '#888';
}

function returnColor(pct) {
  if (pct > 0) return '#22c55e';
  if (pct < 0) return '#ef4444';
  return '#ccc';
}

export default function MoversLogModal({ onClose, onTickerClick }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('ALL');

  useEffect(() => {
    setLoading(true);
    fetchMoversLog()
      .then(d => setData(d))
      .catch(err => console.error('[MoversLog]', err))
      .finally(() => setLoading(false));
  }, []);

  const entries = data?.entries || [];
  const stats = data?.stats || {};

  const filtered = filter === 'ALL'
    ? entries
    : filter === 'OPEN'
      ? entries.filter(e => e.status === 'OPEN')
      : entries.filter(e => e.status !== 'OPEN');

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'rgba(0,0,0,0.75)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#111', border: '1px solid #333', borderRadius: 10,
          width: '90%', maxWidth: 900, maxHeight: '85vh',
          display: 'flex', flexDirection: 'column',
          fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
        }}
      >
        {/* Header */}
        <div style={{
          padding: '16px 20px 12px',
          borderBottom: '1px solid #333',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <h2 style={{ color: '#fcf000', fontSize: 18, fontWeight: 900, margin: 0, letterSpacing: '0.06em' }}>
              PNTHR MOVERS LOG
            </h2>
            <p style={{ color: '#888', fontSize: 11, margin: '4px 0 0' }}>
              Tracking BL+1 / SS+1 signals from the Movers banner
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', color: '#888',
              fontSize: 22, cursor: 'pointer', padding: '0 4px',
            }}
          >
            &times;
          </button>
        </div>

        {/* Stats bar */}
        {stats && (() => {
          const openEntries = entries.filter(e => e.status === 'OPEN');
          const closedEntries = entries.filter(e => e.status !== 'OPEN');
          const openAvg = openEntries.length > 0
            ? openEntries.reduce((s, e) => s + (e.returnPct || 0), 0) / openEntries.length
            : 0;
          const openWins = openEntries.filter(e => (e.returnPct || 0) > 0).length;
          const openAvgDays = openEntries.length > 0
            ? Math.round(openEntries.reduce((s, e) => s + (e.daysHeld || 0), 0) / openEntries.length)
            : 0;
          const closedAvg = closedEntries.length > 0
            ? closedEntries.reduce((s, e) => s + (e.returnPct || 0), 0) / closedEntries.length
            : 0;
          const closedWins = closedEntries.filter(e => (e.returnPct || 0) > 0).length;
          const closedAvgDays = closedEntries.length > 0
            ? Math.round(closedEntries.reduce((s, e) => s + (e.daysHeld || 0), 0) / closedEntries.length)
            : 0;
          return (
            <div style={{ padding: '10px 20px', borderBottom: '1px solid #222', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
                <StatBox label="Total" value={stats.total || 0} color="#fff" />
                <div style={{ width: 1, height: 24, background: '#333' }} />
                <StatBox label="Open" value={openEntries.length} color="#fcf000" />
                <StatBox label="Winning" value={openWins} color="#22c55e" />
                <StatBox label="Avg Return" value={openEntries.length ? `${openAvg >= 0 ? '+' : ''}${openAvg.toFixed(2)}%` : '—'} color={returnColor(openAvg)} />
                <StatBox label="Avg Days" value={openEntries.length ? openAvgDays : '—'} color="#aaa" />
                <div style={{ width: 1, height: 24, background: '#333' }} />
                <StatBox label="Closed" value={closedEntries.length} color="#888" />
                <StatBox label="Win Rate" value={closedEntries.length ? `${(closedWins / closedEntries.length * 100).toFixed(0)}%` : '—'} color="#22c55e" />
                <StatBox label="Avg Return" value={closedEntries.length ? `${closedAvg >= 0 ? '+' : ''}${closedAvg.toFixed(2)}%` : '—'} color={returnColor(closedAvg)} />
                <StatBox label="Avg Days" value={closedEntries.length ? closedAvgDays : '—'} color="#aaa" />
              </div>
            </div>
          );
        })()}

        {/* Filter tabs */}
        <div style={{ padding: '8px 20px 4px', display: 'flex', gap: 6 }}>
          {FILTER_OPTIONS.map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                background: filter === f ? '#fcf000' : '#222',
                color: filter === f ? '#000' : '#aaa',
                border: 'none', borderRadius: 4,
                padding: '4px 12px', fontSize: 11, fontWeight: 700,
                cursor: 'pointer', letterSpacing: '0.04em',
              }}
            >
              {f}
            </button>
          ))}
        </div>

        {/* Table */}
        <div style={{ flex: 1, overflow: 'auto', padding: '8px 20px 16px' }}>
          {loading ? (
            <p style={{ color: '#888', textAlign: 'center', padding: 40 }}>Loading...</p>
          ) : filtered.length === 0 ? (
            <p style={{ color: '#666', textAlign: 'center', padding: 40 }}>
              {entries.length === 0
                ? 'No movers logged yet. Entries auto-record when BL+1 or SS+1 signals appear on the PNTHR Movers banner.'
                : 'No entries match this filter.'}
            </p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #333' }}>
                  {['Ticker', 'Signal', 'Entry Date', 'Entry $', 'Current $', 'Return', 'Days', 'Status'].map(h => (
                    <th key={h} style={{
                      color: '#fcf000', fontWeight: 800, fontSize: 10,
                      padding: '6px 8px', textAlign: 'left',
                      letterSpacing: '0.06em', whiteSpace: 'nowrap',
                    }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((e, i) => (
                  <tr
                    key={e._id || i}
                    style={{
                      borderBottom: '1px solid #1a1a1a',
                      cursor: onTickerClick ? 'pointer' : 'default',
                    }}
                    onClick={() => onTickerClick?.(e.ticker)}
                    title={e.companyName || e.ticker}
                  >
                    <td style={{ padding: '7px 8px', color: '#fff', fontWeight: 700 }}>
                      {e.ticker}
                    </td>
                    <td style={{ padding: '7px 8px' }}>
                      <span style={{
                        background: e.direction === 'LONG' ? '#16a34a' : '#dc2626',
                        color: '#fff', fontWeight: 800, fontSize: 10,
                        padding: '2px 6px', borderRadius: 3,
                      }}>
                        {e.signal}
                      </span>
                    </td>
                    <td style={{ padding: '7px 8px', color: '#aaa' }}>
                      {e.entryDate}
                    </td>
                    <td style={{ padding: '7px 8px', color: '#ccc', fontFamily: 'monospace' }}>
                      ${e.entryPrice?.toFixed(2)}
                    </td>
                    <td style={{ padding: '7px 8px', color: '#ccc', fontFamily: 'monospace' }}>
                      ${(e.exitPrice || e.currentPrice)?.toFixed(2)}
                    </td>
                    <td style={{
                      padding: '7px 8px', fontWeight: 700, fontFamily: 'monospace',
                      color: returnColor(e.returnPct),
                    }}>
                      {e.returnPct >= 0 ? '+' : ''}{e.returnPct?.toFixed(2)}%
                    </td>
                    <td style={{ padding: '7px 8px', color: '#aaa', textAlign: 'center' }}>
                      {e.daysHeld}
                    </td>
                    <td style={{ padding: '7px 8px' }}>
                      <span style={{
                        color: statusColor(e.status),
                        fontWeight: 700, fontSize: 10,
                        letterSpacing: '0.04em',
                      }}>
                        {e.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function StatBox({ label, value, color }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ color, fontSize: 16, fontWeight: 800 }}>{value}</div>
      <div style={{ color: '#666', fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', marginTop: 1 }}>
        {label.toUpperCase()}
      </div>
    </div>
  );
}
