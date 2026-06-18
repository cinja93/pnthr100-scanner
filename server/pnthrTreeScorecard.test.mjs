// Unit tests for the Risk Scorecard math (run: node pnthrTreeScorecard.test.mjs).
// No DB — pure functions only. Proves return/drawdown/score logic before real trades arrive.
import { reconstructEpisodes, priceDrawdownPct, scoreEpisode, pairRoundTrips } from './pnthrTreeScorecard.js';

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
