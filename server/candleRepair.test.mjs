// Unit tests for the closed-bar + overlap-repair candle logic (2026-07-06 audit fix).
// Run: node candleRepair.test.mjs — pure functions only, no DB, no FMP.
import { mergeBarsWithRepair, detectScaleMismatch, lastCompleteTradingDate, isoMinusDays } from './aiUniverseDailyJob.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '✅' : '❌') + ' ' + name + (ok ? '' : `\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};
const bar = (date, close, extra = {}) => ({ date, open: close, high: close + 1, low: close - 1, close, volume: 1000, ...extra });

// ── lastCompleteTradingDate (ET cutoff 16:10) ──
eq('1pm ET → yesterday (today\'s bar is partial)',
  lastCompleteTradingDate(new Date('2026-07-06T17:00:00Z')), '2026-07-05');   // 1pm EDT
eq('4:15pm ET → today (session closed)',
  lastCompleteTradingDate(new Date('2026-07-06T20:15:00Z')), '2026-07-06');   // 4:15pm EDT
eq('4:09pm ET → still yesterday (inside the buffer)',
  lastCompleteTradingDate(new Date('2026-07-06T20:09:00Z')), '2026-07-05');
eq('9pm ET (1am UTC next day) → today in ET, not UTC-tomorrow',
  lastCompleteTradingDate(new Date('2026-07-07T01:00:00Z')), '2026-07-06');
eq('isoMinusDays crosses months', isoMinusDays('2026-07-03', 10), '2026-06-23');

// ── mergeBarsWithRepair ──
const stored = [bar('2026-07-02', 100), bar('2026-07-01', 99)];
const r1 = mergeBarsWithRepair(stored, [bar('2026-07-03', 101)]);
eq('new date appends, newest-first order', [r1.appendedCount, r1.replacedCount, r1.merged.map(b => b.date)],
  [1, 0, ['2026-07-03', '2026-07-02', '2026-07-01']]);
const r2 = mergeBarsWithRepair(stored, [bar('2026-07-02', 100)]);
eq('identical same-date bar → no write', [r2.merged, r2.appendedCount, r2.replacedCount], [null, 0, 0]);
const r3 = mergeBarsWithRepair(stored, [bar('2026-07-02', 102)]);
eq('differing same-date bar is REPLACED (frozen partial bar heals)', [r3.replacedCount, r3.merged[0].close], [1, 102]);
const r4 = mergeBarsWithRepair(stored, [{ ...bar('2026-07-02', 100), volume: 2000 }]);
eq('volume-only revision is also repaired (drives MOST_LIQUID)', [r4.replacedCount, r4.merged[0].volume], [1, 2000]);
eq('empty store → all bars append', mergeBarsWithRepair(null, [bar('2026-07-01', 5)]).appendedCount, 1);

// ── detectScaleMismatch ──
eq('sane append → no mismatch', detectScaleMismatch(stored, [bar('2026-07-03', 101)]), null);
eq('same-date rescale (3:1 split re-stated) → mismatch',
  detectScaleMismatch(stored, [bar('2026-07-02', 33.3)]) !== null, true);
eq('new-bar seam vs newest stored (unadjusted split) → mismatch',
  detectScaleMismatch(stored, [bar('2026-07-03', 50)]) !== null, true);
eq('overlap bar ~4 days back does NOT false-trip the seam check',
  detectScaleMismatch([bar('2026-07-02', 100), bar('2026-06-29', 96)], [bar('2026-06-29', 96), bar('2026-07-03', 101)]), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
