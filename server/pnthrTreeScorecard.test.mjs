// Unit tests for the Risk Scorecard math (run: node pnthrTreeScorecard.test.mjs).
// No DB — pure functions only. Proves return/drawdown/score logic before real trades arrive.
import { reconstructEpisodes, priceDrawdownPct, scoreEpisode, pairRoundTrips, findWalkAwayExits } from './pnthrTreeScorecard.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '✅' : '❌') + ' ' + name + (ok ? '' : `\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

// ── reconstructEpisodes ──
const simple = reconstructEpisodes([
  { ticker: 'AAA', side: 'BOT', shares: 10, price: 100, date: '2026-06-18' },
  { ticker: 'AAA', side: 'SLD', shares: 10, price: 120, date: '2026-06-25' },
]);
eq('simple round-trip: +20% return, 10 sh', [simple.length, simple[0].returnPct, simple[0].shares, simple[0].realizedPnl], [1, 20, 10, 200]);

const scaled = reconstructEpisodes([
  { ticker: 'BBB', side: 'BOT', shares: 10, price: 100, date: '2026-06-18' },
  { ticker: 'BBB', side: 'BOT', shares: 10, price: 110, date: '2026-06-19' },   // avg 105, 20 sh
  { ticker: 'BBB', side: 'SLD', shares: 20, price: 130, date: '2026-06-30' },
]);
eq('scale-in: avg $105, +23.81%, 20 sh', [scaled.length, scaled[0].returnPct, scaled[0].shares, scaled[0].avgEntry], [1, 23.81, 20, 105]);

// Scott's in/out case: buy 10@100, sell 5@110 (+50), sell 5@90 (-50) → net 0 P&L, return 0%
const inout = reconstructEpisodes([
  { ticker: 'CCC', side: 'BOT', shares: 10, price: 100, date: '2026-06-18' },
  { ticker: 'CCC', side: 'SLD', shares: 5, price: 110, date: '2026-06-20' },
  { ticker: 'CCC', side: 'SLD', shares: 5, price: 90, date: '2026-06-22' },
]);
eq('in/out: avgExit $100, 0% return', [inout.length, inout[0].avgExit, inout[0].returnPct], [1, 100, 0]);

// ── priceDrawdownPct ──
const bars = [
  { date: '2026-06-18', high: 100, low: 98 },
  { date: '2026-06-19', high: 120, low: 115 },   // peak 120
  { date: '2026-06-22', high: 118, low: 90 },    // trough 90 → DD (120-90)/120 = 25%
  { date: '2026-06-23', high: 105, low: 102 },
];
eq('drawdown: peak 120 → low 90 = 25%', priceDrawdownPct(bars, '2026-06-18', '2026-06-23'), 25);
eq('drawdown windowed (skips the 90 dip)', priceDrawdownPct(bars, '2026-06-22', '2026-06-23'), priceDrawdownPct([bars[2], bars[3]], '2026-06-22', '2026-06-23'));

// ── scoreEpisode ──
eq('WIN: same return, less DD → edge +50%',
  scoreEpisode({ returnPct: 20, ddPct: 8 }, { returnPct: 20, ddPct: 12 }),
  { verdict: 'WIN', edgePct: 50, actualEff: 2.5, strategyEff: 1.67 });
eq('MIXED: less return but also less DD',
  scoreEpisode({ returnPct: 10, ddPct: 8 }, { returnPct: 20, ddPct: 12 }).verdict, 'MIXED');
eq('LOSS: less return AND more DD',
  scoreEpisode({ returnPct: 10, ddPct: 15 }, { returnPct: 20, ddPct: 12 }).verdict, 'LOSS');

// ── includeOpen + pairRoundTrips (trade-skill savings) ──
// Exit DDD at $110, re-enter (still open) at $100 → saved (110−100)×10 = $100.
const loop = reconstructEpisodes([
  { ticker: 'DDD', side: 'BOT', shares: 10, price: 100, date: '2026-06-12' },
  { ticker: 'DDD', side: 'SLD', shares: 10, price: 110, date: '2026-06-15' },   // exit +10%
  { ticker: 'DDD', side: 'BOT', shares: 10, price: 100, date: '2026-06-17' },   // re-enter lower, still open
], { includeOpen: true });
eq('includeOpen: 1 closed + 1 open leg', [loop.length, loop[0].exitDate, loop[1].exitDate, loop[1].open], [2, '2026-06-15', null, true]);

const trips = pairRoundTrips(loop);
eq('round trip saved $100 (sold 110, re-bought 100, 10 sh, open)',
  [trips.length, trips[0].savings, trips[0].shares, trips[0].reentryOpen], [1, 100, 10, true]);

// Re-entered HIGHER → negative savings (the move cost you).
const costly = pairRoundTrips(reconstructEpisodes([
  { ticker: 'EEE', side: 'BOT', shares: 5, price: 50, date: '2026-06-10' },
  { ticker: 'EEE', side: 'SLD', shares: 5, price: 48, date: '2026-06-12' },     // exit at 48
  { ticker: 'EEE', side: 'BOT', shares: 5, price: 55, date: '2026-06-16' },     // chased back at 55
  { ticker: 'EEE', side: 'SLD', shares: 5, price: 60, date: '2026-06-18' },
], { includeOpen: true }));
eq('round trip COST -$35 (sold 48, re-bought 55, 5 sh)', [costly.length, costly[0].savings], [1, -35]);

// ── findWalkAwayExits (exits that prevented losses) ──
// FFF: bought 10@100, sold 10@120 and never re-bought. Current (daily close) 90 →
//   prevented (120 − 90) × 10 = +$300 (the drop you dodged by being out).
const walk = reconstructEpisodes([
  { ticker: 'FFF', side: 'BOT', shares: 10, price: 100, date: '2026-06-10' },
  { ticker: 'FFF', side: 'SLD', shares: 10, price: 120, date: '2026-06-15' },
], { includeOpen: true });
eq('walk-away prevented +$300 (sold 120, now 90, 10 sh)',
  (() => { const w = findWalkAwayExits(walk, { FFF: 90 }); return [w.length, w[0].preventedDollar, w[0].currentPx, w[0].shares]; })(),
  [1, 300, 90, 10]);

// HHH: sold 5@55, but it ROSE to 65 → you gave back upside: (55 − 65) × 5 = −$50.
const gaveBack = reconstructEpisodes([
  { ticker: 'HHH', side: 'BOT', shares: 5, price: 50, date: '2026-06-10' },
  { ticker: 'HHH', side: 'SLD', shares: 5, price: 55, date: '2026-06-12' },
], { includeOpen: true });
eq('walk-away gave back -$50 (sold 55, now 65, 5 sh)',
  (() => { const w = findWalkAwayExits(gaveBack, { HHH: 65 }); return [w.length, w[0].preventedDollar]; })(),
  [1, -50]);

// GGG: sold then re-bought and STILL HOLDING → currently held, NOT a walk-away (it's a round trip).
const heldNow = reconstructEpisodes([
  { ticker: 'GGG', side: 'BOT', shares: 10, price: 100, date: '2026-06-10' },
  { ticker: 'GGG', side: 'SLD', shares: 10, price: 110, date: '2026-06-12' },
  { ticker: 'GGG', side: 'BOT', shares: 10, price: 105, date: '2026-06-14' },   // re-entered, still open
], { includeOpen: true });
eq('currently-held name is NOT a walk-away', findWalkAwayExits(heldNow, { GGG: 90 }).length, 0);

// III: round-trip THEN walk away (now flat). The two metrics must PARTITION the exits with no
// double-count: first exit (120→re-enter 110) = round trip saved +$100; final exit (130, now 100)
// = walk-away prevented +$300.
const both = reconstructEpisodes([
  { ticker: 'III', side: 'BOT', shares: 10, price: 100, date: '2026-06-01' },
  { ticker: 'III', side: 'SLD', shares: 10, price: 120, date: '2026-06-05' },
  { ticker: 'III', side: 'BOT', shares: 10, price: 110, date: '2026-06-08' },
  { ticker: 'III', side: 'SLD', shares: 10, price: 130, date: '2026-06-12' },
], { includeOpen: true });
eq('round-trip + walk-away coexist, no double-count (trip +$100; final exit +$300)',
  [pairRoundTrips(both).length, pairRoundTrips(both)[0].savings, findWalkAwayExits(both, { III: 100 }).length, findWalkAwayExits(both, { III: 100 })[0].preventedDollar],
  [1, 100, 1, 300]);

// No current price (no candle) → skipped, never invent a mark.
eq('walk-away with no current price is skipped', findWalkAwayExits(walk, {}).length, 0);

// Held-now guard: ledger shows FFF sold-and-flat, but the live broker snapshot says you still hold
// it (a re-buy fill not yet recorded — the TXG 2026-06-26 case). Must be excluded, never shown as
// a prevented loss.
eq('currently-held name excluded even if ledger looks closed (TXG case)',
  findWalkAwayExits(walk, { FFF: 90 }, new Set(['FFF'])).length, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
