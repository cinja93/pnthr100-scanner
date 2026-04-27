// Auto-detected trendlines for weekly stock charts.
//
// Pure-data layer (no chart-library coupling). Output is `[{time, value}]` arrays
// ready to feed lightweight-charts `LineSeries.setData()`.
//
// Algorithm:
//   1. Detect pivot highs/lows on weekly bars (3-bar confirmation, ATR-filtered).
//   2. Build candidate diagonal trendlines from pivot pairs (rising lows for
//      uptrend support, falling highs for downtrend resistance), discard any
//      that are "born broken" (a close already pierces the line between the
//      two anchor pivots).
//   3. Walk each surviving line forward from its second anchor; mark broken
//      at the first weekly close that pierces it.
//   4. Detect horizontal support/resistance by clustering pivot lows/highs at
//      similar prices (tolerance = 0.5 × current ATR).
//   5. Pick what to render per density caps:
//        - 1 active uptrend + 1 active downtrend (most recent)
//        - up to 2 most-recent broken diagonal lines
//        - 1 active support + 1 active resistance
//        - up to 2 most-recent broken horizontals
//   6. Extend active lines forward by `EXTEND_WEEKS` so they project as future
//      support/resistance.

const PIVOT_LR        = 3;     // bars on each side required to confirm a pivot
const ATR_PERIOD      = 14;    // ATR lookback (weekly bars)
const SWING_ATR_MULT  = 0.5;   // pivots must move at least this × ATR vs the prior pivot
const LOOKBACK_WEEKS  = 104;   // ~2 years of weekly bars
const EXTEND_WEEKS    = 26;    // project active lines this many weeks forward
const HORIZ_CLUSTER_ATR = 0.5; // pivots within this × ATR collapse to the same horizontal level
const HORIZ_MIN_TOUCHES = 2;   // a horizontal level needs at least this many anchor pivots
const MAX_BROKEN_DIAG = 2;     // most-recent broken diagonal lines to render
const MAX_BROKEN_HORIZ = 2;    // most-recent broken horizontals to render

// Wilder ATR on weekly bars. Returns array same length as bars; null until ATR_PERIOD.
function computeATR(bars, period = ATR_PERIOD) {
  const n = bars.length;
  const atr = new Array(n).fill(null);
  if (n < period + 1) return atr;
  const trs = [0];
  for (let i = 1; i < n; i++) {
    const cur = bars[i], prev = bars[i - 1];
    trs.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close)));
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trs[i];
  atr[period] = sum / period;
  for (let i = period + 1; i < n; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + trs[i]) / period;
  }
  return atr;
}

// Find pivot indices (high or low) using the standard "bar i is greater/less than
// the LR bars on either side" definition. Returns sorted ascending by index.
function findPivots(bars, leftRight = PIVOT_LR) {
  const highs = [];
  const lows  = [];
  for (let i = leftRight; i < bars.length - leftRight; i++) {
    let isHigh = true, isLow = true;
    const cur = bars[i];
    for (let j = 1; j <= leftRight; j++) {
      if (bars[i - j].high >= cur.high || bars[i + j].high >= cur.high) isHigh = false;
      if (bars[i - j].low  <= cur.low  || bars[i + j].low  <= cur.low)  isLow  = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ idx: i, time: cur.time, value: cur.high });
    if (isLow)  lows .push({ idx: i, time: cur.time, value: cur.low  });
  }
  return { highs, lows };
}

// Drop pivots whose move from the prior same-side pivot is smaller than
// SWING_ATR_MULT × ATR at that bar — kills micro-noise pivots.
function atrFilter(pivots, atr) {
  const out = [];
  for (let i = 0; i < pivots.length; i++) {
    const p = pivots[i];
    if (out.length === 0) { out.push(p); continue; }
    const prior = out[out.length - 1];
    const a = atr[p.idx];
    if (a == null) { out.push(p); continue; }
    if (Math.abs(p.value - prior.value) >= a * SWING_ATR_MULT) out.push(p);
  }
  return out;
}

// Compute the y value of the line (slope, intercept) at bar index x.
function lineAt(slope, intercept, x) { return slope * x + intercept; }

// Build a line from two anchor pivots, then walk forward looking for a close
// that pierces it. Returns the line plus break info, or null if the line is
// already broken between its two anchors (= "born broken", invalid).
//   side: 'up' = uptrend support (line below price; broken when close < line)
//         'dn' = downtrend resistance (line above price; broken when close > line)
function buildLineFromPivots(bars, p1, p2, side) {
  if (p1.idx >= p2.idx) return null;
  const slope = (p2.value - p1.value) / (p2.idx - p1.idx);
  const intercept = p1.value - slope * p1.idx;

  // Validity check: no close between the two anchors should pierce the line.
  for (let k = p1.idx + 1; k < p2.idx; k++) {
    const y = lineAt(slope, intercept, k);
    if (side === 'up' && bars[k].close < y) return null;
    if (side === 'dn' && bars[k].close > y) return null;
  }

  // Find first piercing close after p2 (or none → still active).
  let brokenAtIdx = -1;
  for (let k = p2.idx + 1; k < bars.length; k++) {
    const y = lineAt(slope, intercept, k);
    if (side === 'up' && bars[k].close < y) { brokenAtIdx = k; break; }
    if (side === 'dn' && bars[k].close > y) { brokenAtIdx = k; break; }
  }

  return {
    side,
    slope,
    intercept,
    p1Idx: p1.idx,
    p2Idx: p2.idx,
    p1Time: p1.time,
    p2Time: p2.time,
    p1Value: p1.value,
    p2Value: p2.value,
    broken: brokenAtIdx >= 0,
    brokenAtIdx,
    brokenAtTime: brokenAtIdx >= 0 ? bars[brokenAtIdx].time : null,
  };
}

// Build all valid diagonal trendlines from pivot pairs on one side.
//   side='up': iterate over pivot LOWS, require rising (p1.value < p2.value)
//   side='dn': iterate over pivot HIGHS, require falling (p1.value > p2.value)
function buildLines(bars, pivots, side) {
  const lines = [];
  for (let i = 0; i < pivots.length - 1; i++) {
    for (let j = i + 1; j < pivots.length; j++) {
      const p1 = pivots[i], p2 = pivots[j];
      if (side === 'up' && p1.value >= p2.value) continue;
      if (side === 'dn' && p1.value <= p2.value) continue;
      const ln = buildLineFromPivots(bars, p1, p2, side);
      if (ln) lines.push(ln);
    }
  }
  return lines;
}

// Pick the lines we'll actually render: most-recent active + N most-recent broken.
function selectDiagonals(allLines) {
  const active  = allLines.filter(l => !l.broken).sort((a, b) => b.p2Idx - a.p2Idx);
  const broken  = allLines.filter(l =>  l.broken).sort((a, b) => b.brokenAtIdx - a.brokenAtIdx);

  // Dedupe broken lines that share the same break point (multiple anchor pairs
  // can produce the same effective line — keep the one with the latest p2).
  const seenBreaks = new Set();
  const dedupedBroken = [];
  for (const l of broken) {
    const key = `${l.brokenAtIdx}-${l.slope.toFixed(4)}`;
    if (seenBreaks.has(key)) continue;
    seenBreaks.add(key);
    dedupedBroken.push(l);
    if (dedupedBroken.length >= MAX_BROKEN_DIAG) break;
  }

  return {
    active: active[0] || null,
    broken: dedupedBroken,
  };
}

// Find horizontal levels by clustering same-side pivots within an ATR-tolerance
// price band. Each cluster contributes one level at the cluster's mean price.
//   side='resistance': pivot highs; broken when a close pushes ABOVE level + tol
//   side='support':    pivot lows;  broken when a close pushes BELOW level - tol
function findHorizontalLevels(bars, pivots, atr, side) {
  if (pivots.length === 0 || bars.length === 0) return { active: null, broken: [] };

  // Use the most-recent ATR as the cluster tolerance scale.
  const recentAtr = atr.slice().reverse().find(v => v != null);
  if (!recentAtr) return { active: null, broken: [] };
  const tol = recentAtr * HORIZ_CLUSTER_ATR;

  // Greedy clustering: walk pivots, group consecutive same-level ones.
  const sorted = [...pivots].sort((a, b) => a.value - b.value);
  const clusters = [];
  for (const p of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(p.value - last.mean) <= tol) {
      last.members.push(p);
      last.mean = last.members.reduce((s, m) => s + m.value, 0) / last.members.length;
    } else {
      clusters.push({ mean: p.value, members: [p] });
    }
  }

  // Filter clusters with enough touches and compute break info.
  const levels = clusters
    .filter(c => c.members.length >= HORIZ_MIN_TOUCHES)
    .map(c => {
      const startIdx = Math.min(...c.members.map(m => m.idx));
      const startTime = c.members.find(m => m.idx === startIdx).time;
      // First close that breaks the level after the LAST anchor pivot.
      const lastAnchorIdx = Math.max(...c.members.map(m => m.idx));
      let brokenAtIdx = -1;
      for (let k = lastAnchorIdx + 1; k < bars.length; k++) {
        if (side === 'resistance' && bars[k].close > c.mean + tol) { brokenAtIdx = k; break; }
        if (side === 'support'    && bars[k].close < c.mean - tol) { brokenAtIdx = k; break; }
      }
      return {
        side,
        value: c.mean,
        startIdx,
        startTime,
        lastAnchorIdx,
        touches: c.members.length,
        broken: brokenAtIdx >= 0,
        brokenAtIdx,
        brokenAtTime: brokenAtIdx >= 0 ? bars[brokenAtIdx].time : null,
      };
    });

  // Active = the single most-recently-anchored unbroken level.
  // (For resistance, prefer the level closest to current price from above; for
  //  support, the level closest to current price from below — both within the
  //  recent-anchor preference.)
  const active = levels
    .filter(l => !l.broken)
    .sort((a, b) => b.lastAnchorIdx - a.lastAnchorIdx)[0] || null;

  const broken = levels
    .filter(l => l.broken)
    .sort((a, b) => b.brokenAtIdx - a.brokenAtIdx)
    .slice(0, MAX_BROKEN_HORIZ);

  return { active, broken };
}

// Convert our internal line representation into [{time, value}] segments ready
// for lightweight-charts `LineSeries.setData()`.
//   - Active lines: 3 points = anchor1, anchor2, projected forward EXTEND_WEEKS
//   - Broken lines: 3 points = anchor1, anchor2, value at break-bar (cap at break)
function diagonalToSegment(bars, line) {
  const lastIdx = bars.length - 1;
  const endIdx  = line.broken ? line.brokenAtIdx : lastIdx + EXTEND_WEEKS;
  const endValue = lineAt(line.slope, line.intercept, endIdx);

  // For the projected/break endpoint, generate a synthetic future time string
  // by walking 7 days forward from the last real bar's time, since the chart
  // uses 'YYYY-MM-DD' Monday strings. lightweight-charts accepts these.
  let endTime;
  if (endIdx <= lastIdx) {
    endTime = bars[endIdx].time;
  } else {
    const last = new Date(bars[lastIdx].time + 'T00:00:00');
    const future = new Date(last);
    future.setDate(last.getDate() + (endIdx - lastIdx) * 7);
    endTime = future.toISOString().slice(0, 10);
  }

  return [
    { time: line.p1Time, value: line.p1Value },
    { time: line.p2Time, value: line.p2Value },
    { time: endTime,     value: endValue   },
  ];
}

function horizontalToSegment(bars, level) {
  const lastIdx = bars.length - 1;
  const endIdx  = level.broken ? level.brokenAtIdx : lastIdx + EXTEND_WEEKS;
  let endTime;
  if (endIdx <= lastIdx) {
    endTime = bars[endIdx].time;
  } else {
    const last = new Date(bars[lastIdx].time + 'T00:00:00');
    const future = new Date(last);
    future.setDate(last.getDate() + (endIdx - lastIdx) * 7);
    endTime = future.toISOString().slice(0, 10);
  }
  return [
    { time: level.startTime, value: level.value },
    { time: endTime,         value: level.value },
  ];
}

/**
 * Public entry point. Given an array of weekly bars (each with `{time, open, high,
 * low, close}`, time is a 'YYYY-MM-DD' Monday string), returns everything the
 * chart layer needs to render the trendline overlays.
 *
 * Returns:
 *   {
 *     activeUptrend:        { color: 'green',  segment: [{time,value}, ...] } | null,
 *     activeDowntrend:      { color: 'red',    segment: [...] }              | null,
 *     brokenDiagonals:      [ { color: 'black', segment: [...] }, ... ],
 *     activeSupport:        { color: 'blue',   segment: [...] }              | null,
 *     activeResistance:     { color: 'orange', segment: [...] }              | null,
 *     brokenHorizontals:    [ { color: 'black', segment: [...] }, ... ],
 *   }
 */
export function detectTrendlines(weeklyBars) {
  if (!weeklyBars || weeklyBars.length < PIVOT_LR * 2 + ATR_PERIOD) {
    return emptyResult();
  }

  // Restrict to the lookback window — older bars only matter for ATR seeding.
  const sliceStart = Math.max(0, weeklyBars.length - LOOKBACK_WEEKS - PIVOT_LR);
  const bars = weeklyBars.slice(sliceStart);

  const atr = computeATR(bars);
  const { highs: rawHighs, lows: rawLows } = findPivots(bars);
  const highs = atrFilter(rawHighs, atr);
  const lows  = atrFilter(rawLows,  atr);

  const upLines = buildLines(bars, lows,  'up');
  const dnLines = buildLines(bars, highs, 'dn');
  const upPick  = selectDiagonals(upLines);
  const dnPick  = selectDiagonals(dnLines);

  const support    = findHorizontalLevels(bars, lows,  atr, 'support');
  const resistance = findHorizontalLevels(bars, highs, atr, 'resistance');

  return {
    activeUptrend: upPick.active
      ? { color: '#16a34a', segment: diagonalToSegment(bars, upPick.active) }
      : null,
    activeDowntrend: dnPick.active
      ? { color: '#dc2626', segment: diagonalToSegment(bars, dnPick.active) }
      : null,
    brokenDiagonals: [
      ...upPick.broken.map(l => ({ color: '#000000', segment: diagonalToSegment(bars, l) })),
      ...dnPick.broken.map(l => ({ color: '#000000', segment: diagonalToSegment(bars, l) })),
    ].slice(0, MAX_BROKEN_DIAG),
    activeSupport: support.active
      ? { color: '#2563eb', segment: horizontalToSegment(bars, support.active) }
      : null,
    activeResistance: resistance.active
      ? { color: '#f97316', segment: horizontalToSegment(bars, resistance.active) }
      : null,
    brokenHorizontals: [
      ...support.broken.map(l => ({ color: '#000000', segment: horizontalToSegment(bars, l) })),
      ...resistance.broken.map(l => ({ color: '#000000', segment: horizontalToSegment(bars, l) })),
    ].slice(0, MAX_BROKEN_HORIZ),
  };
}

function emptyResult() {
  return {
    activeUptrend: null,
    activeDowntrend: null,
    brokenDiagonals: [],
    activeSupport: null,
    activeResistance: null,
    brokenHorizontals: [],
  };
}
