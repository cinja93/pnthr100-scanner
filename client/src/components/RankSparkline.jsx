import { rankTrendColor } from '../utils/rankTrend';

// Tiny rank-trajectory sparkline. History is [{ date, rank }] oldest → newest.
// Rank 1 = best, so we invert the y-axis: a climbing stock's line goes UP.
// A dot ("pin") marks each weekly snapshot; the latest week is the larger filled pin.
// Click anywhere on it to open the blown-up chart.
export default function RankSparkline({ history, width = 88, height = 30, onClick }) {
  const pts = (history || []).filter(p => p && p.rank != null);
  const color = rankTrendColor(history);

  if (pts.length === 0) {
    return <span style={{ color: '#4b5563', fontSize: 11 }}>—</span>;
  }

  const padX = 4, padY = 5;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;
  const ranks = pts.map(p => p.rank);
  const minR = Math.min(...ranks);
  const maxR = Math.max(...ranks);
  const n = pts.length;

  const xOf = i => (n === 1 ? width / 2 : padX + (i / (n - 1)) * innerW);
  // best rank (minR) → top (small y); worst rank (maxR) → bottom (large y)
  const yOf = r => (maxR === minR ? height / 2 : padY + ((r - minR) / (maxR - minR)) * innerH);

  const coords = pts.map((p, i) => ({ x: xOf(i), y: yOf(p.rank) }));
  const linePath = coords.map(c => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default', display: 'block', overflow: 'visible' }}
      role="img"
      aria-label={`Rank trend, ${pts.length} weeks`}
    >
      {n > 1 && (
        <polyline points={linePath} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      )}
      {coords.map((c, i) => {
        const latest = i === coords.length - 1;
        return (
          <circle
            key={i}
            cx={c.x}
            cy={c.y}
            r={latest ? 3 : 2}
            fill={latest ? color : '#0a0a0a'}
            stroke={color}
            strokeWidth="1.2"
          />
        );
      })}
    </svg>
  );
}
