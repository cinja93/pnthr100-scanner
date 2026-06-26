// Unit tests for the naked-position stop-coverage math (run: node pnthrTreeEngine.coverage.test.mjs).
// Pure functions only, no DB. Proves the 2-week-low stop + safety gate before it places real stops.
import { tenDayLowStop, coverageStopDecision } from './pnthrTreeEngine.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '✅' : '❌') + ' ' + name + (ok ? '' : `\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};
const mk = (lows) => lows.map((lo, i) => ({ date: `2026-06-${String(i + 1).padStart(2, '0')}`, low: lo, high: lo + 5, close: lo + 2 }));

// ── tenDayLowStop ──
const t1 = tenDayLowStop(mk([20, 19, 18, 17, 16, 15, 14, 13, 12, 11]), '2026-07-01');
eq('10 bars → stop = min low (11) − $0.01', [t1.ok, t1.stop, t1.low, t1.barCount], [true, 10.99, 11, 10]);
eq('today is excluded from the window',
  tenDayLowStop([...mk([20, 19, 18, 17, 16, 15, 14, 13, 12, 11]), { date: '2026-07-01', low: 1, high: 5, close: 3 }], '2026-07-01').stop, 10.99);
eq('window is the LAST 10 bars (older lower low ignored)',
  tenDayLowStop(mk([5, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21]), '2026-07-01').stop, 20.99);
eq('fewer than 10 bars → not ok (fresh IPO not auto-stopped)', tenDayLowStop(mk([20, 19, 18]), '2026-07-01').ok, false);
eq('zero/negative lows filtered out', tenDayLowStop([...mk([20, 19, 18, 17, 16, 15, 14, 13, 12]), { date: '2026-06-30', low: 0, high: 5, close: 3 }], '2026-07-01').ok, false);

// ── coverageStopDecision (safety gate) ──
eq('place when stop sanely below market', coverageStopDecision({ stop: 10.99, lastPrice: 13, lastClose: 12.8 }).place, true);
eq('skip when stop >= price (would sell out instantly)', coverageStopDecision({ stop: 14, lastPrice: 13, lastClose: 12.8 }).place, false);
eq('skip when no price', coverageStopDecision({ stop: 10, lastPrice: 0, lastClose: 12 }).place, false);
eq('skip when price split-suspect vs last close (>50%)', coverageStopDecision({ stop: 10, lastPrice: 13, lastClose: 50 }).place, false);
eq('place when price within sane band of last close', coverageStopDecision({ stop: 10, lastPrice: 13, lastClose: 12 }).place, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
