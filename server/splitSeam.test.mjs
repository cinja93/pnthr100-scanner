// Unit tests for the split-seam discriminator (run: node splitSeam.test.mjs).
// No DB, no network — pure function only.
//
// This is the guard that lets the candle re-sync tell a genuine unadjusted split
// seam (FMP records the split → stays excluded) apart from a real price crash or
// short-squeeze (FMP records NO split → the series is legitimate, don't freeze
// the name). It is shared by BOTH the AI re-sync (splitMaintenanceService) and
// the 679 re-sync (carnivoreDailyJob). The PRIM regression it fixes: a real -50%
// news crash on 2026-05-06 that FMP records no split for had kept PRIM
// data-flagged and out of the Value screen for 29 days.

import { seamMatchesSplit } from './splitMaintenanceService.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = got === want;
  console.log((ok ? '✅ ' : '❌ ') + name + (ok ? '' : `  (got ${got}, want ${want})`));
  ok ? pass++ : fail++;
};

// A seam that lines up with a real FMP split must BLOCK the swap.
eq('exact split-date match blocks',        seamMatchesSplit('2026-06-12', new Set(['2026-06-12'])), true);
eq('3 days before a split blocks',         seamMatchesSplit('2026-06-12', new Set(['2026-06-15'])), true);
eq('5 days (tolerance edge) blocks',       seamMatchesSplit('2026-06-12', new Set(['2026-06-17'])), true);
eq('one real split among several blocks',  seamMatchesSplit('2026-06-12', new Set(['2020-01-01', '2026-06-13'])), true);

// A seam with NO nearby FMP split is a real market move — must NOT block.
eq('6 days apart does not block',          seamMatchesSplit('2026-06-12', new Set(['2026-06-18'])), false);
eq('no splits at all does not block',      seamMatchesSplit('2026-05-06', new Set()), false);
eq('PRIM case (crash, no split) clears',   seamMatchesSplit('2026-05-06', new Set(['2024-08-01'])), false);
eq('distant splits do not block',          seamMatchesSplit('2026-05-06', new Set(['2024-01-01', '2026-06-12'])), false);

// Custom tolerance argument is honored.
eq('tolerance 0: exact only, match',       seamMatchesSplit('2026-06-12', new Set(['2026-06-12']), 0), true);
eq('tolerance 0: 1 day off, no match',     seamMatchesSplit('2026-06-12', new Set(['2026-06-13']), 0), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
