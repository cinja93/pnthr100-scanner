// Rank-trajectory helpers for the Rising-list sparklines.
//
// A stock's history is [{ date, rank }] oldest → newest. Rank 1 = best (top of the board),
// so a stock is CLIMBING when its rank number is going DOWN over time.
//
// computeRankSlope returns the least-squares slope of rank vs. week index:
//   negative  = climbing toward #1 (improving)   ← steeper-negative = faster climb
//   positive  = sliding down the board (declining)
//   null      = fewer than 2 data points (can't draw a trend yet)
//
// Sort the Rising list ASCENDING by this slope to get "steepest climb to #1 first."
export function computeRankSlope(history) {
  if (!Array.isArray(history)) return null;
  const pts = history.filter(p => p && p.rank != null);
  const n = pts.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const x = i, y = pts[i].rank;
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  return (n * sxy - sx * sy) / denom;
}

// Sort comparator: steepest climb (most-negative slope) first; no-history names sink to the bottom.
export function compareByRankSlope(aHist, bHist) {
  const a = computeRankSlope(aHist);
  const b = computeRankSlope(bHist);
  if (a == null && b == null) return 0;
  if (a == null) return 1;   // no trend → bottom
  if (b == null) return -1;
  return a - b;              // ascending: more-negative (faster climb) first
}

// Green when climbing (net rank improved first→last), red when declining, grey when flat/unknown.
export function rankTrendColor(history) {
  const pts = (history || []).filter(p => p && p.rank != null);
  if (pts.length < 2) return '#6b7280';
  const delta = pts[pts.length - 1].rank - pts[0].rank; // negative = improved
  if (delta < 0) return '#22c55e';
  if (delta > 0) return '#ef4444';
  return '#9ca3af';
}
