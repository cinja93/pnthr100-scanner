// Unit tests for the Risk Scorecard math (run: node pnthrTreeScorecard.test.mjs).
// No DB — pure functions only. Proves return/drawdown/score logic before real trades arrive.
import { reconstructEpisodes, priceDrawdownPct, scoreEpisode } from './pnthrTreeScorecard.js';

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
