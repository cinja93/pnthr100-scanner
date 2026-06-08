import { useEffect } from 'react';
import { rankTrendColor } from '../utils/rankTrend';

// Blown-up rank-trajectory chart (opens when a Rising-list sparkline is clicked).
// Same idea as the thumbnail — rank inverted so climbing = up — but with the rank value
// at each pin, the weekly date on the x-axis, and a plain-English trend summary.
export default function RankChartModal({ ticker, history, onClose }) {
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pts = (history || []).filter(p => p && p.rank != null);
  const color = rankTrendColor(history);

  const W = 520, H = 260, padL = 40, padR = 40, padT = 28, padB = 44;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const ranks = pts.map(p => p.rank);
  const minR = pts.length ? Math.min(...ranks) : 0;
  const maxR = pts.length ? Math.max(...ranks) : 0;
  const n = pts.length;
  const xOf = i => (n === 1 ? W / 2 : padL + (i / (n - 1)) * innerW);
  const yOf = r => (maxR === minR ? padT + innerH / 2 : padT + ((r - minR) / (maxR - minR)) * innerH);
  const coords = pts.map((p, i) => ({ x: xOf(i), y: yOf(p.rank), rank: p.rank, date: p.date }));

  const fmtDate = d => { try { const dt = new Date(d + 'T00:00:00'); return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch { return d; } };
  const first = pts[0], last = pts[n - 1];
  const delta = n >= 2 ? first.rank - last.rank : 0; // positive = climbed toward #1
  const summary = n < 2
    ? 'Not enough weekly snapshots yet to show a trend.'
    : delta > 0 ? `Climbed ${delta} spots — rank ${first.rank} (${fmtDate(first.date)}) → ${last.rank} (${fmtDate(last.date)}) over ${n} weeks.`
    : delta < 0 ? `Slid ${Math.abs(delta)} spots — rank ${first.rank} (${fmtDate(first.date)}) → ${last.rank} (${fmtDate(last.date)}) over ${n} weeks.`
    : `Flat at rank ${last.rank} over ${n} weeks.`;

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: '#0d0d0d', border: '1px solid #262626', borderRadius: 10, padding: 20, width: 560, maxWidth: '92vw', boxShadow: '0 10px 40px rgba(0,0,0,0.6)' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: '#fcf000' }}>{ticker} <span style={{ color: '#9ca3af', fontWeight: 500, fontSize: 13 }}>· Rank Trajectory</span></div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: 22, cursor: 'pointer', lineHeight: 1 }} aria-label="Close">×</button>
        </div>
        <div style={{ color: color, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>{summary}</div>

        {n === 0 ? (
          <div style={{ color: '#6b7280', padding: '40px 0', textAlign: 'center' }}>No rank history for {ticker} yet.</div>
        ) : (
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', overflow: 'visible' }}>
            {/* baseline */}
            <line x1={padL} y1={padT + innerH} x2={W - padR} y2={padT + innerH} stroke="#1f1f1f" strokeWidth="1" />
            {/* note: top = best rank */}
            <text x={4} y={padT + 4} fill="#4b5563" fontSize="9">#1 (best)</text>
            {n > 1 && (
              <polyline points={coords.map(c => `${c.x},${c.y}`).join(' ')} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
            )}
            {coords.map((c, i) => (
              <g key={i}>
                <circle cx={c.x} cy={c.y} r={i === n - 1 ? 5 : 4} fill={i === n - 1 ? color : '#0d0d0d'} stroke={color} strokeWidth="2" />
                <text x={c.x} y={c.y - 10} fill="#e5e7eb" fontSize="12" fontWeight="700" textAnchor="middle">{c.rank}</text>
                <text x={c.x} y={H - 16} fill="#9ca3af" fontSize="11" textAnchor="middle">{fmtDate(c.date)}</text>
              </g>
            ))}
          </svg>
        )}
        <div style={{ color: '#6b7280', fontSize: 11, marginTop: 8 }}>
          Higher on the chart = better rank (closer to #1). Line up and to the right = climbing the year-to-date leaderboard.
        </div>
      </div>
    </div>
  );
}
