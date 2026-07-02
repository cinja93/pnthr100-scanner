// server/backtest/treePaperReconstruction.js
// ── HANDS-OFF (no-intervention) PNTHR Tree — hypothetical reconstruction over the
//    fund-compare window (2026-06-22 → last complete session) ────────────────────
// Answers "what would Tree have done if I hadn't intervened?" using the LOCKED,
// executable, no-look-ahead treeSim engine (MOST_LIQUID priority = the live rule).
// Fairness: warm up BEFORE the window so the book is mature entering 06-22 (Elite +
// Ambush also entered 06-22 with mature books), then REBASE to the $89,882 baseline
// on 06-22 and measure the segment. HYPOTHETICAL — a simulation, NOT a live track
// record. Heavy (loads all AI candles) → run on a daily cron / seed, never on the
// 10s-polled fund-compare endpoint (which just reads the stored result).
//
// Robustness (per NUMBER INTEGRITY PROTOCOL): the segment is re-run across 4 warm-up
// starts + 2 alternative entry-tiebreaks. central = median of the MOST_LIQUID (live-
// rule) warm-ups; [low,high] = full spread across ALL variants — the honest fragility
// (the 2× cap binds, so which names hold scarce capital on 06-22 moves the number).

import { loadTreeData, simulateTree, MOST_LIQUID, CLOSEST_TO_TRIGGER } from './treeSim.js';

export const RECON_DOC = 'pnthr_tree_paper_reconstruction';
const BASELINE = 89882;                 // common fund-compare baseline (Tree's 06-22 NAV)
const SEG_START = '2026-06-22';
const ALPHA = (a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : +(((s[n / 2 - 1] + s[n / 2]) / 2)).toFixed(2)) : null; };

// Rebase a full equity curve's SEG_START→asOf slice to $BASELINE on the first in-window bar.
function segment(curve, asOf) {
  const pts = curve.filter(p => p.date >= SEG_START && p.date <= asOf);
  if (!pts.length) return { series: [], segRet: null, base0: null };
  const base0 = pts[0].eq;
  const series = pts.map(p => ({ date: p.date, eq: Math.round(BASELINE * (p.eq / base0)), ret: +((p.eq / base0 - 1) * 100).toFixed(2) }));
  return { series, segRet: series[series.length - 1].ret, base0 };
}

// Compute the band. Returns the doc to store (or { status:'no_data' } if the window
// isn't covered by complete candles yet).
export async function computeHandsOffBand(db, { asOf = null } = {}) {
  const data = await loadTreeData(db, { end: asOf || '2100-01-01', universe: 'ai' });
  const lastComplete = asOf || data.lastDate;                      // caller passes a post-close date; else latest bar
  const inWindow = data.allDates.filter(d => d >= SEG_START && d <= lastComplete);
  if (inWindow.length < 1) return { key: 'tree_paper_reconstruction', status: 'no_data', asOf: lastComplete, generatedAt: new Date() };

  const variantDefs = [
    { label: 'warmup 2025-09-02 · most-liquid', start: '2025-09-02', sort: MOST_LIQUID, live: true },
    { label: 'warmup 2026-01-02 · most-liquid', start: '2026-01-02', sort: MOST_LIQUID, live: true },
    { label: 'warmup 2026-03-02 · most-liquid', start: '2026-03-02', sort: MOST_LIQUID, live: true },
    { label: 'warmup 2025-06-02 · most-liquid', start: '2025-06-02', sort: MOST_LIQUID, live: true },
    { label: 'tiebreak · closest-to-trigger',   start: '2025-09-02', sort: CLOSEST_TO_TRIGGER, live: false },
    { label: 'tiebreak · alphabetical',          start: '2025-09-02', sort: ALPHA, live: false },
  ];
  const variants = [];
  let primarySeries = null;
  for (const v of variantDefs) {
    const r = simulateTree(data, { nav0: BASELINE, start: v.start, entrySort: v.sort });
    const g = segment(r.equityGross, lastComplete);
    const n = segment(r.equity, lastComplete);
    variants.push({ label: v.label, live: v.live, segGross: g.segRet, segNet: n.segRet, bookNav0: Math.round(g.base0) });
    if (v.label === variantDefs[0].label) primarySeries = g.series;   // representative central path
  }

  const liveVars = variants.filter(v => v.live).map(v => v.segGross);
  const allGross = variants.map(v => v.segGross);
  const central = median(liveVars);
  const low = Math.min(...allGross);       // most negative
  const high = Math.max(...allGross);      // least negative
  const netCentral = median(variants.filter(v => v.live).map(v => v.segNet));

  return {
    key: 'tree_paper_reconstruction',
    status: 'ok',
    baseline: BASELINE, start: SEG_START, asOf: lastComplete,
    windowDays: inWindow.length,
    centralPct: central, lowPct: low, highPct: high, netCentralPct: netCentral,
    method: 'treeSim (locked, executable, no look-ahead) · MOST_LIQUID = live rule · warm-up-matured book rebased to $89,882 on 06-22 · GROSS of costs (matches Elite/Ambush paper)',
    hypothetical: true,
    variants,
    series: primarySeries,   // representative central daily path (rebased $89,882)
    generatedAt: new Date(),
  };
}

// Compute + persist (upsert one doc). Returns the stored doc.
export async function refreshHandsOffBand(db, opts = {}) {
  const doc = await computeHandsOffBand(db, opts);
  await db.collection(RECON_DOC).updateOne({ key: 'tree_paper_reconstruction' }, { $set: doc }, { upsert: true });
  return doc;
}

export async function getHandsOffBand(db) {
  return db.collection(RECON_DOC).findOne({ key: 'tree_paper_reconstruction' });
}
