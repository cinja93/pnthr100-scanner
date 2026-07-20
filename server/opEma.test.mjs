// Equivalence tests for the extracted OpEMA line (run: node opEma.test.mjs).
// No DB — pure functions only.
//
// WHY THIS EXISTS: computeOpEma/buildDevelopingSeries were lifted out of
// aiValueService.js so Daily Rank and Value share one definition of the line.
// The Value page's behaviour was verified 120/121 against the Jungle's BL/SS, so
// the extraction must be byte-for-byte behaviour-preserving. ORIGINAL below is
// the pre-extraction inline logic copied verbatim from aiValueService.js; the
// tests assert the shared module agrees with it over randomized inputs.
//
// If you change opEma.js and this fails, the line moved. That is a real
// regression in Value, Daily Rank, and anything else reading the line.

import { SECTOR_EMA_PERIODS } from './data/pnthrAiSectorsConfig.js';
import { calculateEMA } from './signalDetection.js';
import { buildDevelopingSeries, computeOpEma, effectivePeriod } from './opEma.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '✅' : '❌') + ' ' + name + (ok ? '' : `\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

// ── ORIGINAL: verbatim from aiValueService.js before the extraction ──────────
function originalEffectivePeriod(barCount, sectorPeriod) {
  if (barCount >= sectorPeriod * 3) return sectorPeriod;
  if (barCount >= 21 + 2)           return 21;
  return null;
}

function originalInline(wBars, devMonday, live, sectorId) {
  // series build
  const wSeries = wBars.map(b => ({ w: b.d, c: b.c }));
  if (live != null && wSeries.length) {
    if (wSeries[wSeries.length - 1].w === devMonday) wSeries[wSeries.length - 1] = { w: devMonday, c: live };
    else if (wSeries[wSeries.length - 1].w < devMonday) wSeries.push({ w: devMonday, c: live });
  }
  // line
  let opema = null, opemaPeriod = null, light = null, side = null, weekOf = null;
  let wksBelow = null, wksAbove = null, aboveRun = null, reclaim = false;
  const period = SECTOR_EMA_PERIODS[sectorId] || 30;
  const eff = originalEffectivePeriod(wSeries.length, period);
  if (eff) {
    const emaData = calculateEMA(wSeries.map(b => ({ time: b.w, close: b.c })), eff);
    const emaByWeek = Object.fromEntries(emaData.map(e => [e.time, e.value]));
    const aligned = wSeries.filter(b => emaByWeek[b.w] != null)
      .map(b => ({ w: b.w, c: b.c, e: emaByWeek[b.w], below: b.c < emaByWeek[b.w] }));
    if (aligned.length) {
      const m = aligned.length;
      const lastA = aligned[m - 1];
      opema = Math.round(lastA.e * 100) / 100;
      opemaPeriod = eff;
      weekOf = lastA.w;
      light = Math.round(((lastA.c / lastA.e) - 1) * 1000) / 10;
      side = lastA.below ? 'below' : 'above';
      let hiIdx = 0;
      for (let i = 1; i < m; i++) if (aligned[i].c >= aligned[hiIdx].c) hiIdx = i;
      let belowCnt = 0;
      for (let i = hiIdx; i < m; i++) if (aligned[i].below) belowCnt++;
      wksBelow = belowCnt;
      let last5 = 0;
      for (let i = Math.max(0, m - 5); i < m; i++) if (!aligned[i].below) last5++;
      wksAbove = last5;
      if (!lastA.below) { aboveRun = 1; for (let i = m - 2; i >= 0; i--) { if (!aligned[i].below) aboveRun++; else break; } }
      else aboveRun = 0;
      reclaim = (aboveRun === 1);
    }
  }
  return { opema, opemaPeriod, light, side, weekOf, wksBelow, wksAbove, aboveRun, reclaim };
}

// ── NEW: the same result assembled from the shared module ───────────────────
function viaSharedModule(wBars, devMonday, live, sectorId) {
  const wSeries = buildDevelopingSeries(wBars, devMonday, live);
  const r = computeOpEma(wSeries, sectorId);
  let wksBelow = null, wksAbove = null, aboveRun = null, reclaim = false;
  const aligned = r.aligned;
  if (aligned.length) {
    const m = aligned.length;
    const lastA = aligned[m - 1];
    let hiIdx = 0;
    for (let i = 1; i < m; i++) if (aligned[i].c >= aligned[hiIdx].c) hiIdx = i;
    let belowCnt = 0;
    for (let i = hiIdx; i < m; i++) if (aligned[i].below) belowCnt++;
    wksBelow = belowCnt;
    let last5 = 0;
    for (let i = Math.max(0, m - 5); i < m; i++) if (!aligned[i].below) last5++;
    wksAbove = last5;
    if (!lastA.below) { aboveRun = 1; for (let i = m - 2; i >= 0; i--) { if (!aligned[i].below) aboveRun++; else break; } }
    else aboveRun = 0;
    reclaim = (aboveRun === 1);
  }
  return { opema: r.opema, opemaPeriod: r.opemaPeriod, light: r.light, side: r.side, weekOf: r.weekOf,
           wksBelow, wksAbove, aboveRun, reclaim };
}

// ── Deterministic pseudo-random walk generator ──────────────────────────────
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function makeWeeks(rand, n, startIso = '2020-01-06') {
  const bars = [];
  let px = 10 + rand() * 400;
  const d = new Date(startIso + 'T12:00:00Z');
  for (let i = 0; i < n; i++) {
    px = Math.max(0.5, px * (1 + (rand() - 0.48) * 0.14));
    bars.push({ d: d.toISOString().split('T')[0], c: Math.round(px * 100) / 100 });
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return bars;
}

// ── Randomized equivalence sweep ────────────────────────────────────────────
const sectorIds = Object.keys(SECTOR_EMA_PERIODS);
let mismatches = 0, checked = 0, withLine = 0;

for (let seed = 1; seed <= 400; seed++) {
  const rand = mulberry32(seed);
  // Cover young names (no line), just-past-21 names, and fully seasoned ones.
  const n = [0, 1, 5, 22, 23, 40, 64, 90, 150, 260][seed % 10];
  const bars = makeWeeks(rand, n);
  const sectorId = sectorIds[seed % sectorIds.length];
  const devMonday = bars.length ? bars[bars.length - 1].d : '2026-07-20';
  // Three live-price cases: none, same developing week, and a new week.
  for (const live of [null, 10 + rand() * 400, 10 + rand() * 400]) {
    for (const dm of [devMonday, isoAdd(devMonday, 7)]) {
      const a = originalInline(bars, dm, live, sectorId);
      const b = viaSharedModule(bars, dm, live, sectorId);
      checked++;
      if (a.opema != null) withLine++;
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        mismatches++;
        if (mismatches <= 3) {
          console.log(`❌ mismatch seed=${seed} n=${n} sector=${sectorId} live=${live} dm=${dm}`);
          console.log(`    original: ${JSON.stringify(a)}`);
          console.log(`    shared:   ${JSON.stringify(b)}`);
        }
      }
    }
  }
}

function isoAdd(iso, days) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

eq(`randomized equivalence: ${checked} cases (${withLine} produced a line), 0 mismatches`, mismatches, 0);

// ── Targeted behaviour checks ───────────────────────────────────────────────
eq('effectivePeriod: seasoned name uses its sector period', effectivePeriod(90, 30), 30);
eq('effectivePeriod: young-but-viable name falls back to 21', effectivePeriod(23, 30), 21);
eq('effectivePeriod: too young for any line', effectivePeriod(22, 30), null);

// Developing-week substitution: live price replaces the current week's close.
const wk = [{ d: '2026-07-06', c: 100 }, { d: '2026-07-13', c: 110 }];
eq('developing series: live price overwrites the current week',
   buildDevelopingSeries(wk, '2026-07-13', 123.45).slice(-1),
   [{ w: '2026-07-13', c: 123.45 }]);
eq('developing series: live price appends a brand-new week',
   buildDevelopingSeries(wk, '2026-07-20', 123.45).slice(-1),
   [{ w: '2026-07-20', c: 123.45 }]);
eq('developing series: no live price leaves the series untouched',
   buildDevelopingSeries(wk, '2026-07-20', null).length, 2);

// A clean above/below read on a monotonic series.
const rising = Array.from({ length: 120 }, (_, i) => ({ d: isoAdd('2023-01-02', i * 7), c: 50 + i }));
const up = computeOpEma(buildDevelopingSeries(rising, '2999-01-01', null), sectorIds[0]);
eq('steadily rising series reads above the line', up.side, 'above');
const falling = Array.from({ length: 120 }, (_, i) => ({ d: isoAdd('2023-01-02', i * 7), c: 200 - i }));
const dn = computeOpEma(buildDevelopingSeries(falling, '2999-01-01', null), sectorIds[0]);
eq('steadily falling series reads below the line', dn.side, 'below');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
