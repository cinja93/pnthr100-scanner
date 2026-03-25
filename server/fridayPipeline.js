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
import { checkCaseStudyEntries }  from './killHistory.js';
import { saveWeeklySnapshot, getCurrentWeekOf } from './signalHistoryService.js';

// ── Compute weekOf (last Friday) ─────────────────────────────────────────────

function getLastFriday() {
  const today = new Date();
  const dow = today.getDay();
  const daysBack = dow === 5 ? 0 : (dow + 2) % 7;
  const d = new Date(today);
  d.setDate(today.getDate() - daysBack);
  return d.toISOString().split('T')[0];
}

// ── Fetch VIX / 10Y Treasury / DXY from FMP ──────────────────────────────────

async function fetchMacroContext() {
  const FMP_API_KEY  = process.env.FMP_API_KEY;
  const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';
  const result = { vix: null, treasury10y: null, dxy: null };

  try {
    const res = await fetch(`${FMP_BASE_URL}/quote/%5EVIX?apikey=${FMP_API_KEY}`);
    if (res.ok) {
      const data = await res.json();
      result.vix = data?.[0]?.price ?? null;
    }
  } catch { /* non-fatal */ }

  try {
    const res = await fetch(`${FMP_BASE_URL}/quote/%5ETNX?apikey=${FMP_API_KEY}`);
    if (res.ok) {
      const data = await res.json();
      result.treasury10y = data?.[0]?.price ?? null;
    }
  } catch { /* non-fatal */ }

  try {
    const res = await fetch(`${FMP_BASE_URL}/quote/DX-Y.NYB?apikey=${FMP_API_KEY}`);
    if (res.ok) {
      const data = await res.json();
      result.dxy = data?.[0]?.price ?? null;
    }
  } catch { /* non-fatal */ }

  return result;
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

    // ── 3a. Fetch macro context (VIX, 10Y, DXY) ───────────────────────────
    console.log('3a. Fetching macro context (VIX, 10Y, DXY)...');
    const macroContext = await fetchMacroContext();
    console.log(`   VIX: ${macroContext.vix ?? 'n/a'} | 10Y: ${macroContext.treasury10y ?? 'n/a'} | DXY: ${macroContext.dxy ?? 'n/a'}`);

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

    // Track tickers that failed to score (signal error, missing data, etc.)
    const scoredTickers  = new Set(scored.map(s => s.ticker));
    const failedTickers  = tickers.filter(t => !scoredTickers.has(t));
    if (failedTickers.length > 0) {
      console.error(`[Kill Pipeline] ⚠ ${failedTickers.length} tickers failed to score: ${failedTickers.slice(0, 20).join(', ')}${failedTickers.length > 20 ? '...' : ''}`);
    }

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

    // ── 5b. Save weekly market snapshot ──────────────────────────────────
    try {
      const blCount  = regime?.blCount  ?? 0;
      const ssCount  = regime?.ssCount  ?? 0;
      const ssBlRatio = blCount > 0 ? ssCount / blCount : ssCount > 0 ? 99 : 0;
      await db.collection('pnthr_weekly_market_snapshot').updateOne(
        { weekOf },
        {
          $set: {
            weekOf,
            spyPrice:     null, // apex doesn't return raw prices in contextSummary
            spyEma21:     null,
            spyAboveEma:  contextSummary.spyAboveEma,
            spyEmaRising: contextSummary.spyEmaRising,
            qqqPrice:     null,
            qqqEma21:     null,
            qqqAboveEma:  contextSummary.qqqAboveEma,
            qqqEmaRising: contextSummary.qqqEmaRising,
            vix:          macroContext.vix,
            treasury10y:  macroContext.treasury10y,
            dxy:          macroContext.dxy,
            blCount,
            ssCount,
            newBlCount:   regime?.newBlCount ?? 0,
            newSsCount:   regime?.newSsCount ?? 0,
            ssBlRatio,
            createdAt:    new Date(),
          },
        },
        { upsert: true }
      );
      console.log('   Saved weekly market snapshot');
    } catch (err) {
      console.error('[Kill Pipeline] Market snapshot save failed (non-fatal):', err.message);
    }

    // ── 5c. Save enriched signals ─────────────────────────────────────────
    try {
      // Fetch previous week's enriched signals for score trajectory
      const prevWeekDate = new Date(weekOf);
      prevWeekDate.setDate(prevWeekDate.getDate() - 7);
      const prevWeekOf = prevWeekDate.toISOString().split('T')[0];
      const prevWeekDocs = await db.collection('pnthr_enriched_signals')
        .find({ weekOf: prevWeekOf }, { projection: { ticker: 1, totalScore: 1, tier: 1, killRank: 1 } })
        .toArray();
      const prevByTicker = {};
      for (const d of prevWeekDocs) prevByTicker[d.ticker] = d;

      let enrichedSaved = 0;
      for (const s of scored) {
        if (!s.signal || (s.signal !== 'BL' && s.signal !== 'SS')) continue;
        try {
          const prev = prevByTicker[s.ticker];
          const scoreLastWeek  = prev?.totalScore ?? null;
          const scoreDelta     = scoreLastWeek != null ? (s.apexScore - scoreLastWeek) : null;
          const tierLastWeek   = prev?.tier ?? null;
          const tierChanged    = tierLastWeek != null && tierLastWeek !== s.tier;
          const rankLastWeek   = prev?.killRank ?? null;
          const rankDelta      = (rankLastWeek != null && s.killRank != null) ? (rankLastWeek - s.killRank) : null;

          await db.collection('pnthr_enriched_signals').updateOne(
            { weekOf, ticker: s.ticker },
            {
              $set: {
                weekOf,
                ticker:         s.ticker,
                signal:         s.signal,
                signalAge:      s.signalAge ?? null,
                sector:         s.sector ?? null,
                exchange:       s.exchange ?? null,
                killRank:       s.killRank ?? null,
                killScore:      s.apexScore,
                totalScore:     s.apexScore,
                tier:           s.tier,
                confirmation:   s.confirmation,
                preMultiplier:  s.preMultiplier ?? null,
                dimensions:     s.scoreDetail ?? null,
                currentPrice:   s.currentPrice ?? null,
                ema21:          null,
                scoreLastWeek,
                scoreDelta,
                tierLastWeek,
                tierChanged,
                rankLastWeek,
                rankDelta,
                weeksInCurrentTier: tierChanged ? 1 : null,
                createdAt:      new Date(),
              },
            },
            { upsert: true }
          );
          enrichedSaved++;
        } catch { /* skip individual stock errors */ }
      }
      console.log(`   Saved ${enrichedSaved} enriched signal records`);
    } catch (err) {
      console.error('[Kill Pipeline] Enriched signals save failed (non-fatal):', err.message);
    }

    // ── 6. Case Study Entries ──────────────────────────────────────────────
    console.log('6. Running Kill case study detection...');
    try {
      await checkCaseStudyEntries(db, scored, jungleSignals, 'FRIDAY_PIPELINE');
    } catch (err) {
      console.error('[Kill Pipeline] Case study check failed (non-fatal):', err.message);
    }

    // ── 7. Auto-save signal history snapshot ─────────────────────────────
    try {
      const count = await saveWeeklySnapshot(jungleSignals);
      console.log(`[Signal History] Auto-saved ${count} signal records for week of ${getCurrentWeekOf()}`);
    } catch (err) {
      console.error('[Signal History] Auto-save failed (non-fatal):', err.message);
    }

    // ── 8. Auto-log pipeline run to changelog ─────────────────────────────
    try {
      const alphaCount = scored.filter(s => s.tier === 'ALPHA PNTHR KILL').length;
      const strCount   = scored.filter(s => s.tier === 'STRIKING').length;
      const failureNote = failedTickers.length > 0
        ? ` WARN: ${failedTickers.length} tickers failed (${failedTickers.slice(0, 10).join(', ')}${failedTickers.length > 10 ? '...' : ''}).`
        : '';
      await db.collection('pnthr_system_changelog').insertOne({
        date:        weekOf,
        version:     null,
        category:    failedTickers.length > 0 ? 'PIPELINE_WARNING' : 'PIPELINE',
        impact:      failedTickers.length > 10 ? 'MEDIUM' : 'LOW',
        description: `Friday pipeline completed. ${scored.length} scored, ${alphaCount} ALPHA, ${strCount} STRIKING. VIX: ${macroContext.vix ?? 'n/a'}. BL: ${regime?.blCount ?? 0}, SS: ${regime?.ssCount ?? 0}.${failureNote}`,
        changedBy:   'PIPELINE',
        details:     failedTickers.length > 0 ? `Failed tickers: ${failedTickers.join(', ')}` : '',
        createdAt:   new Date(),
      });
    } catch (err) {
      console.error('[Kill Pipeline] Changelog auto-log failed (non-fatal):', err.message);
    }

    // ── 9. Summary ────────────────────────────────────────────────────────
    const alphaKills = scored.filter(s => s.tier === 'ALPHA PNTHR KILL');
    const striking   = scored.filter(s => s.tier === 'STRIKING');
    const confirmed  = scored.filter(s => s.confirmation === 'CONFIRMED');

    console.log(`\n${'='.repeat(60)}`);
    console.log('PIPELINE COMPLETE'); // Step 9 summary
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

    // ── Portfolio Return Snapshot (per user who has an accountSize) ──────────
    try {
      const { connectToDatabase } = await import('./database.js');
      const db = await connectToDatabase();
      const profiles = await db.collection('user_profiles').find({ accountSize: { $gt: 0 } }).toArray();
      for (const profile of profiles) {
        const ownerId   = profile.userId || profile._id?.toString();
        const currentNav = profile.accountSize;
        const last = await db.collection('pnthr_portfolio_returns')
          .findOne({ ownerId }, { sort: { date: -1 } });
        const first = await db.collection('pnthr_portfolio_returns')
          .findOne({ ownerId }, { sort: { date: 1 } });
        const prevNav      = last?.nav || currentNav;
        const inceptionNav = first?.nav || currentNav;
        const weeklyReturn = ((currentNav - prevNav) / prevNav) * 100;
        const cumulativeReturn = ((currentNav - inceptionNav) / inceptionNav) * 100;
        await db.collection('pnthr_portfolio_returns').insertOne({
          ownerId,
          date: new Date(),
          nav: currentNav,
          weeklyReturn:     +weeklyReturn.toFixed(4),
          cumulativeReturn: +cumulativeReturn.toFixed(4),
          riskFreeRate:     0, // updated separately via treasury fetch if needed
        });
        console.log(`[Portfolio] Snapshot saved for ${ownerId}: weekly=${weeklyReturn.toFixed(2)}%`);
      }
    } catch (e) {
      console.warn('[Portfolio] Return snapshot failed:', e.message);
    }

  } catch (err) {
    console.error('[Kill Pipeline] Pipeline failed:', err);
  }
}
