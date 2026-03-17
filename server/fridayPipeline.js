// server/fridayPipeline.js
// ── PNTHR Kill — Friday Pipeline ─────────────────────────────────────────────
//
// Runs every Friday at 4:15 PM ET after market close.
// Uses the existing getApexResults() scoring engine, persists results to MongoDB
// so the Command Center's /api/kill-pipeline can serve pre-computed scores instantly.
//
// Collections written:
//   pnthr_kill_scores   — Ranked Kill scores for the week (replaced each run)
//   pnthr_kill_regime   — Regime snapshot (upserted by weekOf)
//   pnthr_kill_history  — Append-only CONFIRMED+new entries for backtesting
// ─────────────────────────────────────────────────────────────────────────────

import { getJungleStocks }        from './stockService.js';
import { getSignals }             from './signalService.js';
import { getSp400Longs, getSp400Shorts } from './sp400Service.js';
import { getEmaCrossoverStocks }  from './emaCrossoverService.js';
import { getPreyResults }         from './preyService.js';
import { getApexResults }         from './apexService.js';
import { getMostRecentRanking }   from './database.js';
import { connectToDatabase }      from './database.js';

// ── Compute weekOf (last Friday) ─────────────────────────────────────────────

function getLastFriday() {
  const today = new Date();
  const dow = today.getDay();
  const daysBack = dow === 5 ? 0 : (dow + 2) % 7;
  const d = new Date(today);
  d.setDate(today.getDate() - daysBack);
  return d.toISOString().split('T')[0];
}

// ── Main Pipeline ─────────────────────────────────────────────────────────────

export async function runFridayKillPipeline() {
  const start   = Date.now();
  const weekOf  = getLastFriday();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`PNTHR Kill — Friday Pipeline`);
  console.log(`Week of: ${weekOf}`);
  console.log(`${'='.repeat(60)}\n`);

  const db = await connectToDatabase();
  if (!db) {
    console.error('[Kill Pipeline] MongoDB unavailable — aborting');
    return;
  }

  try {
    // ── 1. Gather universe data (same as /api/apex route) ──────────────────
    console.log('1. Loading PNTHR 679 universe...');
    const [specLongs, specShorts] = await Promise.all([getSp400Longs(), getSp400Shorts()]);
    const stocks = await getJungleStocks(specLongs, specShorts);
    const tickers = stocks.map(s => s.ticker);

    const stockMeta = {};
    for (const s of stocks) {
      stockMeta[s.ticker] = {
        companyName: s.companyName, sector: s.sector, exchange: s.exchange,
        currentPrice: s.currentPrice, ytdReturn: s.ytdReturn,
        isSp500: s.isSp500, isDow30: s.isDow30, isNasdaq100: s.isNasdaq100,
        universe: s.universe, rankList: s.rankList ?? null,
        rank: null, rankChange: undefined,
      };
    }

    // Enrich with PNTHR 100 rankings
    try {
      const ranking = await getMostRecentRanking();
      if (ranking) {
        for (const e of (ranking.rankings || [])) {
          if (stockMeta[e.ticker]) {
            stockMeta[e.ticker].rank       = e.rank       ?? null;
            stockMeta[e.ticker].rankChange = e.rankChange ?? undefined;
            stockMeta[e.ticker].rankList   = 'LONG';
          }
        }
        for (const e of (ranking.shortRankings || [])) {
          if (stockMeta[e.ticker]) {
            stockMeta[e.ticker].rank       = e.rank       ?? null;
            stockMeta[e.ticker].rankChange = e.rankChange ?? undefined;
            stockMeta[e.ticker].rankList   = 'SHORT';
          }
        }
      }
    } catch { /* best-effort */ }

    console.log(`   ${tickers.length} tickers loaded`);

    // ── 2. Fetch signals ───────────────────────────────────────────────────
    console.log('2. Fetching jungle signals...');
    const jungleSignals = await getSignals(tickers);
    const openSignalCount = Object.values(jungleSignals).filter(s => s?.signal === 'BL' || s?.signal === 'SS').length;
    console.log(`   ${openSignalCount} open signals (BL + SS)`);

    // ── 3. Fetch Prey + Hunt for D8 ───────────────────────────────────────
    console.log('3. Loading Prey + Hunt universe...');
    let preyResults = null;
    let huntTickers = new Set();
    try {
      preyResults = await getPreyResults(tickers, stockMeta, jungleSignals);
    } catch (e) { console.warn('   Prey failed (D8 partial):', e.message); }
    try {
      const huntData = await getEmaCrossoverStocks();
      huntTickers = new Set((huntData?.stocks || []).map(s => s.ticker || s));
    } catch (e) { console.warn('   Hunt failed (D8 partial):', e.message); }

    // ── 4. Run scoring engine ─────────────────────────────────────────────
    console.log('4. Running PNTHR Kill v3 scoring engine...');
    // Force a fresh score (bypass in-memory cache) by calling with fresh data
    const apexResults = await getApexResults(tickers, stockMeta, jungleSignals, preyResults, huntTickers);
    const { stocks: scored, contextSummary, regime } = apexResults;
    console.log(`   Scored: ${scored.length} stocks`);

    // ── 5. Persist to MongoDB ─────────────────────────────────────────────
    console.log('5. Saving to MongoDB...');

    // Replace this week's scores
    await db.collection('pnthr_kill_scores').deleteMany({ weekOf });

    if (scored.length > 0) {
      const killDocs = scored.map((s, i) => ({
        weekOf,
        killRank:       i + 1,
        ticker:         s.ticker,
        signal:         s.signal,
        signalAge:      s.signalAge,
        totalScore:     s.apexScore,
        tier:           s.tier,
        confirmation:   s.confirmation,
        preMultiplier:  s.preMultiplier,
        dimensions:     s.scoreDetail,
        entryQuality:   s.scores?.d3 ?? 0,
        convictionPct:  s.scoreDetail?.d3?.convictionPct  ?? 0,
        slopePct:       s.scoreDetail?.d3?.slopePct       ?? 0,
        separationPct:  s.scoreDetail?.d3?.separationPct  ?? 0,
        sector:         s.sector,
        exchange:       s.exchange,
        ytdReturn:      s.ytdReturn,
        pnthrRank:      s.rank     ?? null,
        currentPrice:   s.currentPrice,
        ema21:          0, // populated next run
        maxGapPct:      0, // cached separately in pnthr_gap_risk
        createdAt:      new Date(),
      }));
      await db.collection('pnthr_kill_scores').insertMany(killDocs);
      console.log(`   Saved ${killDocs.length} scored stocks`);
    }

    // Upsert regime snapshot
    await db.collection('pnthr_kill_regime').updateOne(
      { weekOf },
      {
        $set: {
          weekOf,
          indexPosition: contextSummary.spyAboveEma  ? 'above' : 'below',
          indexSlope:    contextSummary.spyEmaRising ? 'rising' : 'falling',
          spyAboveEma:   contextSummary.spyAboveEma,
          spyEmaRising:  contextSummary.spyEmaRising,
          qqqAboveEma:   contextSummary.qqqAboveEma,
          qqqEmaRising:  contextSummary.qqqEmaRising,
          blCount:       regime?.blCount    ?? 0,
          ssCount:       regime?.ssCount    ?? 0,
          newBlCount:    regime?.newBlCount ?? 0,
          newSsCount:    regime?.newSsCount ?? 0,
          createdAt:     new Date(),
        },
      },
      { upsert: true }
    );

    // Append CONFIRMED + new entries to history (append-only for backtesting)
    const historyDocs = scored
      .filter(s => s.confirmation === 'CONFIRMED' && s.signalAge <= 1)
      .map(s => ({
        weekOf,
        ticker:       s.ticker,
        signal:       s.signal,
        killRank:     scored.indexOf(s) + 1,
        totalScore:   s.apexScore,
        tier:         s.tier,
        confirmation: s.confirmation,
        entryQuality: s.scores?.d3 ?? 0,
        convictionPct: s.scoreDetail?.d3?.convictionPct ?? 0,
        slopePct:     s.scoreDetail?.d3?.slopePct ?? 0,
        separationPct: s.scoreDetail?.d3?.separationPct ?? 0,
        outcome:      { exitDate: null, profitPct: null, holdingWeeks: null, isWinner: null },
        createdAt:    new Date(),
      }));

    if (historyDocs.length > 0) {
      // Only insert history entries that don't already exist for this weekOf+ticker
      for (const doc of historyDocs) {
        await db.collection('pnthr_kill_history').updateOne(
          { weekOf: doc.weekOf, ticker: doc.ticker },
          { $setOnInsert: doc },
          { upsert: true }
        );
      }
      console.log(`   Saved ${historyDocs.length} history entries`);
    }

    // ── 6. Summary ────────────────────────────────────────────────────────
    const alphaKills = scored.filter(s => s.tier === 'ALPHA PNTHR KILL');
    const striking   = scored.filter(s => s.tier === 'STRIKING');
    const confirmed  = scored.filter(s => s.confirmation === 'CONFIRMED');

    console.log(`\n${'='.repeat(60)}`);
    console.log('PIPELINE COMPLETE');
    console.log(`${'='.repeat(60)}`);
    console.log(`Total scored:   ${scored.length}`);
    console.log(`ALPHA KILL:     ${alphaKills.length}`);
    console.log(`STRIKING:       ${striking.length}`);
    console.log(`CONFIRMED:      ${confirmed.length}`);
    console.log(`Duration:       ${((Date.now() - start) / 1000).toFixed(1)}s`);

    if (scored.length > 0) {
      console.log('\nTOP 5 KILLS:');
      for (const s of scored.slice(0, 5)) {
        console.log(`  #${scored.indexOf(s) + 1} ${s.ticker.padEnd(6)} ${s.signal} | ${s.tier.padEnd(18)} | ${s.apexScore} pts | ${s.confirmation}`);
      }
    }

  } catch (err) {
    console.error('[Kill Pipeline] Pipeline failed:', err);
  }
}
