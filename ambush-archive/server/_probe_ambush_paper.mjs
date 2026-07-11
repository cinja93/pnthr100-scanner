import dotenv from 'dotenv'; dotenv.config({ path: new URL('./.env', import.meta.url).pathname });
const { runAmbushPaperTick } = await import('./ambushPaperEngine.js');
// Replay Thursday 6/18 at ~1:00 PM ET (780 min) — real intraday bars exist → exercises
// the full entry/manage/breakout path. probe=true → ZERO db writes.
const r = await runAmbushPaperTick({ probe: true, asOf: '2026-06-18', nowMin: 780 });
console.log('PROBE result:', JSON.stringify(r, null, 2));
process.exit(0);
