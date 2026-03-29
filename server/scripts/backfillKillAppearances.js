// server/scripts/backfillKillAppearances.js
// ── Backfill: seed pnthr_kill_appearances from existing pnthr_kill_scores ──
//
// Thresholds (matching Friday pipeline):
//   Kill score  > 100
//   Analyze     > 80%
//   Composite   > 75
//
// Run: node --env-file=server/.env server/scripts/backfillKillAppearances.js

import { MongoClient } from 'mongodb';

const KILL_THRESHOLD      = 100;
const ANALYZE_THRESHOLD   = 80;
const COMPOSITE_THRESHOLD = 75;

// ── Server-side Analyze score (mirrors fridayPipeline.js version) ─────────────
function computeServerAnalyzeScore(rec, regime) {
  const signal    = (rec.signal || '').toUpperCase();
  const direction = signal === 'BL' ? 'LONG' : 'SHORT';
  const signalAge = typeof rec.signalAge === 'number'
    ? rec.signalAge
    : parseInt((rec.signalAge || '').replace(/\D/g, '')) || 0;

  let s = 0;

  // T1-A: Signal Quality (0-15)
  if (signal === 'BL' || signal === 'SS') {
    if      (signalAge <= 1) s += 15;
    else if (signalAge === 2) s += 8;
    else if (signalAge === 3) s += 3;
  }

  // T1-B: Kill Context (0-10)
  const ks = rec.totalScore ?? 0;
  if      (ks >= 130) s += 10;
  else if (ks >= 100) s += 7;
  else if (ks >= 80)  s += 4;
  else if (ks >= 50)  s += 2;
  else                s += 1;

  // T1-C: Index Trend (0-8)
  const isNasdaq     = (rec.exchange || '').toUpperCase() === 'NASDAQ';
  const primaryAbove = isNasdaq ? (regime?.qqqAboveEma ?? null) : (regime?.spyAboveEma ?? null);
  if (primaryAbove !== null) {
    const aligned = (direction === 'LONG' && primaryAbove) || (direction === 'SHORT' && !primaryAbove);
    s += aligned ? 8 : 0;
  }

  // T1-D: Sector Trend (0-7) — D2 proxy from dimensions
  const d2 = rec.dimensions?.d2?.score ?? null;
  if      (d2 === null) s += 3;
  else if (d2 > 0)      s += 7;
  else if (d2 === 0)    s += 3;
  else                  s += 0;

  // T2: Execution projected full (13 pts)
  s += 13;

  const max = 53;
  const pct = Math.round((s / max) * 100);
  const composite = Math.round(ks * (pct / 100));
  return { analyzeScore: pct, compositeScore: composite };
}

async function backfill() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db('pnthr_den');

  // Drop and recreate so we start fresh with the new thresholds
  await db.collection('pnthr_kill_appearances').drop().catch(() => {});
  console.log('Dropped existing pnthr_kill_appearances collection');

  // Load regime data per week
  const regimeDocs = await db.collection('pnthr_kill_regime').find({}).toArray();
  const regimeByWeek = {};
  for (const r of regimeDocs) {
    regimeByWeek[r.weekOf] = r;
  }

  // Get all Kill score records sorted oldest-first
  const allRecords = await db.collection('pnthr_kill_scores')
    .find({ totalScore: { $gt: KILL_THRESHOLD } })
    .sort({ weekOf: 1, killRank: 1 })
    .toArray();

  // Filter by Analyze + Composite thresholds
  const qualifying = [];
  for (const rec of allRecords) {
    if (!rec.signal || (rec.signal !== 'BL' && rec.signal !== 'SS')) continue;
    const regime = regimeByWeek[rec.weekOf] ?? null;
    const { analyzeScore, compositeScore } = computeServerAnalyzeScore(rec, regime);
    if (analyzeScore > ANALYZE_THRESHOLD && compositeScore > COMPOSITE_THRESHOLD) {
      rec._analyzeScore   = analyzeScore;
      rec._compositeScore = compositeScore;
      qualifying.push(rec);
    }
  }

  console.log(`\nTotal records with Kill > ${KILL_THRESHOLD}: ${allRecords.length}`);
  console.log(`After Analyze > ${ANALYZE_THRESHOLD}% + Composite > ${COMPOSITE_THRESHOLD}: ${qualifying.length}`);

  // Group by ticker+signal — earliest record = first appearance
  const appearanceMap = new Map();

  for (const rec of qualifying) {
    const key = `${rec.ticker}|${rec.signal}`;
    const existing = appearanceMap.get(key);

    if (existing) {
      const weeksDiff = (new Date(rec.weekOf) - new Date(existing.lastSeenDate))
        / (7 * 24 * 60 * 60 * 1000);
      if (weeksDiff > 8) {
        // Gap > 8 weeks = new cycle, save old and start fresh
        await insertAppearance(db, existing);
        appearanceMap.delete(key);
      }
    }

    if (!appearanceMap.has(key)) {
      appearanceMap.set(key, {
        ticker:               rec.ticker,
        signal:               rec.signal,
        sector:               rec.sector ?? null,
        exchange:             rec.exchange ?? null,
        firstAppearanceDate:  rec.weekOf,
        firstAppearancePrice: rec.currentPrice ?? null,
        firstKillScore:       rec.totalScore,
        firstKillRank:        rec.killRank ?? null,
        firstTier:            rec.tier,
        firstSignalAge:       rec.signalAge ?? null,
        firstAnalyzeScore:    rec._analyzeScore,
        firstCompositeScore:  rec._compositeScore,
        firstConvictionPct:   rec.convictionPct ?? rec.dimensions?.d3?.convictionPct ?? null,
        firstSlopePct:        rec.slopePct ?? rec.dimensions?.d3?.slopePct ?? null,
        firstSeparationPct:   rec.separationPct ?? rec.dimensions?.d3?.separationPct ?? null,
        lastSeenDate:         rec.weekOf,
        lastSeenPrice:        rec.currentPrice ?? null,
        lastKillScore:        rec.totalScore,
        lastKillRank:         rec.killRank ?? null,
        lastAnalyzeScore:     rec._analyzeScore,
        lastCompositeScore:   rec._compositeScore,
        exitDate:             null,
        exitPrice:            null,
        profitPct:            null,
        holdingWeeks:         null,
        isWinner:             null,
        createdAt:            new Date(),
        updatedAt:            new Date(),
      });
    } else {
      const entry = appearanceMap.get(key);
      entry.lastSeenDate       = rec.weekOf;
      entry.lastSeenPrice      = rec.currentPrice ?? null;
      entry.lastKillScore      = rec.totalScore;
      entry.lastKillRank       = rec.killRank ?? null;
      entry.lastAnalyzeScore   = rec._analyzeScore;
      entry.lastCompositeScore = rec._compositeScore;
      entry.updatedAt          = new Date();
    }
  }

  // Save all appearances
  let saved = 0;
  for (const [, appearance] of appearanceMap) {
    await insertAppearance(db, appearance);
    saved++;
  }

  // Create indexes
  await db.collection('pnthr_kill_appearances').createIndex({ ticker: 1, signal: 1, lastSeenDate: -1 });
  await db.collection('pnthr_kill_appearances').createIndex({ firstAppearanceDate: -1 });
  await db.collection('pnthr_kill_appearances').createIndex({ exitDate: 1 });
  console.log('\nIndexes created.');

  // Print full summary
  const all = await db.collection('pnthr_kill_appearances')
    .find({})
    .sort({ firstAppearanceDate: 1, firstKillRank: 1 })
    .toArray();

  console.log(`\nSaved ${saved} appearance records to pnthr_kill_appearances`);
  console.log('\n── Appearance Records ────────────────────────────────────────────────');
  for (const a of all) {
    const price = a.firstAppearancePrice ? `$${a.firstAppearancePrice.toFixed(2)}` : 'N/A';
    console.log(
      `${a.ticker.padEnd(6)} ${a.signal} | ${a.firstAppearanceDate} @ ${price.padEnd(10)} ` +
      `| Kill:${String(a.firstKillScore).padEnd(6)} Analyze:${a.firstAnalyzeScore}% ` +
      `Composite:${a.firstCompositeScore} | Rank:#${a.firstKillRank ?? '?'} | ${a.firstTier}`
    );
  }

  await client.close();
}

async function insertAppearance(db, doc) {
  await db.collection('pnthr_kill_appearances').updateOne(
    { ticker: doc.ticker, signal: doc.signal, firstAppearanceDate: doc.firstAppearanceDate },
    { $setOnInsert: doc },
    { upsert: true }
  );
}

backfill().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
