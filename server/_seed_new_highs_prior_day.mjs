// One-shot: seed the PRIOR trading day's new-high baseline so the New Highs page can flash
// "new to the list today" on the day this ships (instead of waiting for tomorrow's natural
// baseline). Reconstructs from the daily candle store with the SAME rule as the live list.
//
// Safety: the import chain is import-side-effect-free (verified) — this NEVER calls the live
// order pipeline. Run dry first, then with --write.
//   node server/_seed_new_highs_prior_day.mjs            # dry run, no DB writes
//   node server/_seed_new_highs_prior_day.mjs --write    # writes the baseline snapshot
//
// It RE-DERIVES the set a second, INDEPENDENT way (its own trigger math over the raw bars, on the
// exact same member universe) and requires EXACT set equality with the service before trusting it.
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
dotenv.config({ path: fileURLToPath(new URL('.env', import.meta.url)) });   // server/.env, regardless of CWD

const WRITE = process.argv.includes('--write');

const { connectToDatabase } = await import('./database.js');
const { seedPriorDayBaseline } = await import('./newHighsLowsService.js');
const { getAllTickers, getSp400Tickers } = await import('./constituents.js');
const { SECTORS: AI_SECTORS } = await import('./scripts/aiUniverse/aiUniverseData.js');

// ── Independent re-implementation of "new high on day D" (a genuine second method) ──────────────
// Deliberately duplicated here (NOT importing the service helper) so agreement is meaningful.
function independentNewHighSet(docs, memberSet, lookback, D) {
  const set = new Set();
  const detail = {};
  for (const d of docs) {
    if (!memberSet.has(d.ticker)) continue;                       // score the SAME universe the service does
    const bars = (d.daily || []).filter(b => +b.high > 0 && +b.low > 0).sort((a, b) => a.date.localeCompare(b.date));
    const idx = bars.findIndex(b => b.date === D);
    if (idx < 0) continue;                                        // no bar ON D
    const prior = bars.slice(0, idx);                             // strictly before D
    if (prior.length < lookback) continue;                        // need a full window
    const window = prior.slice(-lookback);
    const trigger = Math.max(...window.map(b => +b.high));
    const Dhigh = +bars[idx].high;
    const isNew = Dhigh >= trigger + 0.01;
    detail[d.ticker] = { Dhigh: +Dhigh.toFixed(2), trigger: +trigger.toFixed(2), winFrom: window[0].date, winTo: window[window.length - 1].date, winLen: window.length, isNew };
    if (isNew) set.add(d.ticker);
  }
  return { set, detail };
}

const db = await connectToDatabase();
if (!db) { console.error('No DB connection (check server/.env MONGODB_URI)'); process.exit(1); }

// Rebuild the exact member universes the service scores.
const [base, sp400] = await Promise.all([getAllTickers(), getSp400Tickers()]);
const carnMembers = new Set([...(base || []), ...(sp400 || [])]);
const aiMembers = new Set();
for (const s of AI_SECTORS) for (const h of s.holdings) aiMembers.add(h.ticker);
const UNIV = {
  carnivore: { coll: 'pnthr_bt_candles',    lookback: 20,  members: carnMembers },
  ai300:     { coll: 'pnthr_ai_bt_candles', lookback: 210, members: aiMembers  },
};

console.log(`\n=== Seed prior-day New Highs baseline (${WRITE ? 'WRITE' : 'DRY RUN'}) ===`);
const res = await seedPriorDayBaseline(db, { dryRun: !WRITE });
console.log('today (ET):', res.today, `| carn members=${carnMembers.size} ai members=${aiMembers.size}\n`);

let allMatch = true;
for (const s of res.summary) {
  console.log(`── ${s.universe.toUpperCase()} ──  priorDay=${s.priorDay}  serviceCount=${s.count}  wrote=${s.wrote}${s.note ? '  ('+s.note+')' : ''}`);
  if (!s.priorDay || !s.tickers) { console.log(''); continue; }

  const { coll, lookback, members } = UNIV[s.universe];
  const docs = await db.collection(coll).find({}, { projection: { ticker: 1, daily: 1 } }).toArray();
  const { set: indSet, detail } = independentNewHighSet(docs, members, lookback, s.priorDay);

  const svc = new Set(s.tickers);
  const svcOnly = [...svc].filter(t => !indSet.has(t));   // service flagged, independent didn't
  const indOnly = [...indSet].filter(t => !svc.has(t));   // independent flagged, service didn't
  const exact = svcOnly.length === 0 && indOnly.length === 0;
  console.log(`   independent(same universe)=${indSet.size}  exactMatch=${exact ? 'YES ✓' : 'NO ✗'}`);
  if (!exact) { allMatch = false; console.log(`     serviceOnly=${svcOnly.join(',') || '-'}\n     independentOnly=${indOnly.join(',') || '-'}`); }

  // Numeric spot-check: window + trigger for a few positives, then a few negatives.
  for (const t of s.tickers.slice(0, 5)) {
    const x = detail[t];
    console.log(`     +${t}: D.high=${x?.Dhigh}  trigger(max ${x?.winLen} prior highs ${x?.winFrom}→${x?.winTo})=${x?.trigger}  → ${x?.isNew ? 'NEW HIGH ✓' : 'MISMATCH ✗'}`);
  }
  let neg = 0;
  for (const t of Object.keys(detail)) {
    if (svc.has(t) || detail[t].isNew) continue;
    console.log(`     -${t}: D.high=${detail[t].Dhigh}  trigger=${detail[t].trigger}  → not new ✓`);
    if (++neg >= 3) break;
  }
  console.log('');
}

console.log(allMatch ? '✅ Reconciliation PASSED — service set == independent re-derivation on the same universe.'
                     : '❌ Reconciliation FAILED — do not trust; investigate before writing.');
if (!WRITE) console.log('   (dry run — nothing written. Re-run with --write to persist.)');
process.exit(0);
