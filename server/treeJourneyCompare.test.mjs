// Unit tests for the TREE journey simulator (run: node treeJourneyCompare.test.mjs).
// Pure functions only, no DB. Proves Plan-A exit logic matches the locked treeSim rule.
import { computeLoStop, planExit } from './treeJourneyCompare.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '✅' : '❌') + ' ' + name + (ok ? '' : `\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};
// bar helper
const B = (date, o, h, l, c) => ({ date, open: o, high: h, low: l, close: c });

// 12 flat bars at ~100 (lows 99) to seed a full 10-bar window, then the move.
const seed = []; for (let i = 0; i < 12; i++) seed.push(B(`2026-05-${String(i + 1).padStart(2, '0')}`, 100, 101, 99, 100));

// CASE 1 — stop-loss: enter at bar 11 ($100), price falls and pierces the 2-week low ($99 − .01 = 98.99).
const c1 = [...seed, B('2026-05-13', 100, 100, 97, 97.5)];   // low 97 ≤ 98.99 → stop hit
const lo1 = computeLoStop(c1);
const r1 = planExit(c1, lo1, 11, 100, 100, 250);
eq('stop-loss: exits at the 2wk-low stop 98.99, reason STOP_LOSS',
  [r1.exited, r1.exitPrice, r1.reason], [true, 98.99, 'STOP_LOSS']);

// CASE 2 — gap-through: gaps OPEN below the stop → fills at the open, not the stop.
const c2 = [...seed, B('2026-05-13', 95, 96, 94, 95.5)];   // opens 95 < stop 98.99 → fill at 95
const r2 = planExit(c2, computeLoStop(c2), 11, 100, 100, 250);
eq('gap-through: fills at the gap open 95 (worse than the stop)', [r2.exited, r2.exitPrice], [true, 95]);

// CASE 3 — trail to profit then stop out GREEN: price runs up, the 2wk-low trails up above entry,
// then a pullback hits the trailed stop → exit is a PROFIT (reason TRAIL_PROFIT).
const up = [...seed];
for (let i = 13; i <= 26; i++) up.push(B(`2026-05-${i}`, 100 + (i - 12) * 3, 100 + (i - 12) * 3 + 2, 100 + (i - 12) * 3 - 1, 100 + (i - 12) * 3 + 1));
// after the run, a sharp drop that pierces the (now-elevated) trailing stop
up.push(B('2026-05-27', 110, 110, 105, 106));
const r3 = planExit(up, computeLoStop(up), 11, 100, 100, 250);
eq('trail-to-profit: exits above entry → reason TRAIL_PROFIT, exit price > 100',
  [r3.exited, r3.reason, r3.exitPrice > 100], [true, 'TRAIL_PROFIT', true]);

// CASE 4 — never stops out → open, marked to last close.
const c4 = [...seed]; for (let i = 13; i <= 20; i++) c4.push(B(`2026-05-${i}`, 100, 102, 99.5, 101));   // stays above the 98.99 stop
const r4 = planExit(c4, computeLoStop(c4), 11, 100, 100, 250);
eq('never stopped → open, lastClose reported', [r4.exited, r4.lastClose], [false, 101]);

// CASE 5 — loStop excludes today and uses the prior 10 bars
const lo = computeLoStop(seed);
eq('loStop null until a full 10-bar window, then = prior-10 low (99)', [lo[9], lo[10], lo[11]], [null, 99, 99]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
