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
import { getKillTestSettings, serverSizePosition, buildServerLotConfig } from './killTestSettings.js';
import { checkFeastAlerts } from './killTestDailyUpdate.js';

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

// ── Server-side Analyze score approximation ───────────────────────────────────
// Mirrors client-side computeAnalyzeScore() using data available in the pipeline.
// T1-A Signal Quality: signal + signalAge
// T1-B Kill Context:   tier / totalScore
// T1-C Index Trend:    regime spyAboveEma / qqqAboveEma vs direction
// T1-D Sector Trend:   D2 score proxy (>0 = aligned, <0 = against, 0 = neutral)
// T2   Execution:      always projected full (8+5 = 13 pts)
// Max = 53 pts
function computeServerAnalyzeScore(stock, regime) {
  const signal    = (stock.signal || '').toUpperCase();
  const direction = signal === 'BL' ? 'LONG' : 'SHORT';

  // Parse numeric signalAge (stored as integer in pnthr_kill_scores)
  const signalAge = typeof stock.signalAge === 'number'
    ? stock.signalAge
    : parseInt((stock.signalAge || '').replace(/\D/g, '')) || 0;

  let s = 0;

  // T1-A: Signal Quality (0-15)
  if (signal === 'BL' || signal === 'SS') {
    if      (signalAge <= 1) s += 15; // FRESH
    else if (signalAge === 2) s += 8; // RECENT
    else if (signalAge === 3) s += 3; // STALE
    // age 4+: 0 pts — EXPIRED
  }

  // T1-B: Kill Context (0-10)
  const ks = stock.apexScore ?? stock.totalScore ?? 0;
  if      (ks >= 130) s += 10;
  else if (ks >= 100) s += 7;
  else if (ks >= 80)  s += 4;
  else if (ks >= 50)  s += 2;
  else                s += 1;

  // T1-C: Index Trend (0-8) — NASDAQ stocks route to QQQ, others to SPY
  const isNasdaq     = (stock.exchange || '').toUpperCase() === 'NASDAQ';
  const primaryAbove = isNasdaq ? (regime?.qqqAboveEma ?? null) : (regime?.spyAboveEma ?? null);
  if (primaryAbove !== null) {
    const aligned = (direction === 'LONG' && primaryAbove) || (direction === 'SHORT' && !primaryAbove);
    s += aligned ? 8 : 0;
  }

  // T1-D: Sector Trend (0-7) — D2 score proxy
  // D2 > 0 = sector aligned with signal direction
  // D2 < 0 = sector against
  // D2 = 0 = neutral / no data → partial credit
  const d2 = stock.dimensions?.d2?.score ?? stock.scoreDetail?.d2?.score ?? null;
  if      (d2 === null) s += 3; // no sector data — neutral
  else if (d2 > 0)      s += 7; // sector aligned
  else if (d2 === 0)    s += 3; // neutral
  else                  s += 0; // sector against

  // T2: Execution — always projected at full (sizing + risk cap = 13 pts)
  s += 13;

  const max = 53;
  const pct = Math.round((s / max) * 100);
  const composite = Math.round(ks * (pct / 100));
  return { analyzeScore: pct, compositeScore: composite };
}

// ── Kill Appearances: first-qualification tracking ────────────────────────────
// Thresholds: Kill score > 100 AND Analyze > 80% AND Composite > 75
// Logic:
//   - If no existing appearance for this ticker+signal within 8 weeks → new record
//   - If existing record found → update lastSeen fields only (preserve first appearance)
// This gives us the exact date + price a stock FIRST qualified for action.

const KILL_THRESHOLD     = 100;
const ANALYZE_THRESHOLD  = 80;
const COMPOSITE_THRESHOLD = 75;

async function updateKillAppearances(db, scored, weekOf, regime, jungleSignals = {}, settings = null) {
  // Apply all three thresholds: Kill > 100, Analyze > 80%, Composite > 75
  const qualifying = scored.filter(s => {
    if (!s.signal || (s.signal !== 'BL' && s.signal !== 'SS')) return false;
    if ((s.apexScore ?? 0) <= KILL_THRESHOLD) return false;
    const { analyzeScore, compositeScore } = computeServerAnalyzeScore(s, regime);
    s._analyzeScore   = analyzeScore;
    s._compositeScore = compositeScore;
    return analyzeScore > ANALYZE_THRESHOLD && compositeScore > COMPOSITE_THRESHOLD;
  });

  if (qualifying.length === 0) return;

  const eightWeeksAgo = new Date(weekOf);
  eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56);
  const cutoff = eightWeeksAgo.toISOString().split('T')[0];

  let newCount     = 0;
  let updatedCount = 0;

  for (const s of qualifying) {
    // Look for an active appearance record (same signal, seen within last 8 weeks)
    const existing = await db.collection('pnthr_kill_appearances').findOne({
      ticker: s.ticker,
      signal: s.signal,
      lastSeenDate: { $gte: cutoff },
    });

    // Look up stop price from signal service
    const sigData   = jungleSignals[s.ticker] ?? {};
    const stopPrice = sigData.stopPrice ?? null;
    const price     = s.currentPrice ?? null;
    const riskPct   = (price && stopPrice)
      ? +Math.abs((price - stopPrice) / price * 100).toFixed(2)
      : null;

    if (!existing) {
      // ── Compute lot config using sizePosition (same logic as Size It) ─────
      let lotConfig = null;
      let lotFills  = null;
      if (settings && price && stopPrice) {
        const sized = serverSizePosition({
          nav:        settings.nav,
          entryPrice: price,
          stopPrice,
          riskPct:    settings.riskPctPerTrade,
        });
        if (sized && sized.totalShares > 0) {
          const lots = buildServerLotConfig(sized.totalShares, price, s.signal);
          lotConfig = {
            nav:           settings.nav,
            riskPct:       settings.riskPctPerTrade,
            totalShares:   sized.totalShares,
            maxRiskDollar: sized.maxRiskDollar,
            lots,
          };
          // Lot 1 filled immediately at appearance price.
          // Store ONLY fillDate + fillPrice (historical facts).
          // shares/costBasis are intentionally omitted — recomputed from settings dynamically.
          lotFills = {
            lot1: { filled: true,  fillDate: weekOf, fillPrice: price },
            lot2: { filled: false, fillDate: null,   fillPrice: null  },
            lot3: { filled: false, fillDate: null,   fillPrice: null  },
            lot4: { filled: false, fillDate: null,   fillPrice: null  },
            lot5: { filled: false, fillDate: null,   fillPrice: null  },
          };
        }
      }

      // First time this stock has qualified — NEVER overwrite this record
      await db.collection('pnthr_kill_appearances').insertOne({
        ticker:               s.ticker,
        signal:               s.signal,
        sector:               s.sector ?? null,
        exchange:             s.exchange ?? null,
        // First appearance snapshot
        firstAppearanceDate:  weekOf,
        firstAppearancePrice: price,
        firstStopPrice:       stopPrice,
        firstRiskPct:         riskPct,
        firstKillScore:       s.apexScore,
        firstKillRank:        s.killRank ?? null,
        firstTier:            s.tier,
        firstSignalAge:       s.signalAge ?? null,
        firstAnalyzeScore:    s._analyzeScore,
        firstCompositeScore:  s._compositeScore,
        firstConvictionPct:   s.scoreDetail?.d3?.convictionPct ?? null,
        firstSlopePct:        s.scoreDetail?.d3?.slopePct ?? null,
        firstSeparationPct:   s.scoreDetail?.d3?.separationPct ?? null,
        // Lot simulation
        lotConfig,
        lotFills,
        currentStop:     stopPrice,
        currentAvgCost:  price,
        currentShares:   lotConfig ? lotConfig.lots[0].targetShares : null,
        lotsFilledCount: 1,
        // Feast alert tracking
        feastFired:     false,
        feastDate:      null,
        feastRsi:       null,
        feastExitPrice: null,
        feastExitShares: 0,
        // P&L tracking
        currentPnlPct:    0,
        currentPnlDollar: 0,
        // Last seen (updated weekly while signal stays active)
        lastSeenDate:         weekOf,
        lastSeenPrice:        price,
        lastStopPrice:        stopPrice,
        lastKillScore:        s.apexScore,
        lastKillRank:         s.killRank ?? null,
        lastAnalyzeScore:     s._analyzeScore,
        lastCompositeScore:   s._compositeScore,
        // Outcome (filled in later when signal exits)
        exitDate:             null,
        exitPrice:            null,
        exitReason:           null,
        profitPct:            null,
        profitDollar:         null,
        holdingWeeks:         null,
        isWinner:             null,
        dailySnapshots:       [],
        createdAt:            new Date(),
        updatedAt:            new Date(),
      });
      newCount++;
    } else {
      // Already on the list — update lastSeen only, preserve first appearance
      await db.collection('pnthr_kill_appearances').updateOne(
        { _id: existing._id },
        {
          $set: {
            lastSeenDate:       weekOf,
            lastSeenPrice:      price,
            lastStopPrice:      stopPrice,
            lastKillScore:      s.apexScore,
            lastKillRank:       s.killRank ?? null,
            lastAnalyzeScore:   s._analyzeScore,
            lastCompositeScore: s._compositeScore,
            updatedAt:          new Date(),
          },
        }
      );
      updatedCount++;
    }
  }

  console.log(`   Kill Appearances: ${newCount} new, ${updatedCount} updated (${qualifying.length} qualifying stocks)`);

  // Ensure indexes exist
  try {
    await db.collection('pnthr_kill_appearances').createIndex(
      { ticker: 1, signal: 1, lastSeenDate: -1 }
    );
    await db.collection('pnthr_kill_appearances').createIndex({ firstAppearanceDate: -1 });
  } catch { /* indexes may already exist */ }
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
    const { stocks: scored, contextSummary, regime, indexData: apexIndexData = {} } = apexResults;
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
          spy: apexIndexData.SPY ? { close: apexIndexData.SPY.price, ema21: apexIndexData.SPY.ema21 } : undefined,
          qqq: apexIndexData.QQQ ? { close: apexIndexData.QQQ.price, ema21: apexIndexData.QQQ.ema21 } : undefined,
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
            spyPrice:     apexIndexData.SPY?.price  ?? null,
            spyEma21:     apexIndexData.SPY?.ema21  ?? null,
            spyAboveEma:  contextSummary.spyAboveEma,
            spyEmaRising: contextSummary.spyEmaRising,
            qqqPrice:     apexIndexData.QQQ?.price  ?? null,
            qqqEma21:     apexIndexData.QQQ?.ema21  ?? null,
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

    // ── 5d. Kill Appearances — first-time qualification tracking ─────────────
    // Records the EXACT date and price when a stock first hits STRIKING+ (≥100)
    // This is the true "entry baseline" for forward performance tracking.
    try {
      const ktSettings = await getKillTestSettings();
      await updateKillAppearances(db, scored, weekOf, contextSummary, jungleSignals, ktSettings);
    } catch (err) {
      console.error('[Kill Pipeline] Appearances update failed (non-fatal):', err.message);
    }

    // ── 5e. Kill Test Feast Alert check (weekly RSI from scored data) ─────────
    try {
      await checkFeastAlerts(db, scored, weekOf);
    } catch (err) {
      console.error('[Kill Pipeline] Feast alert check failed (non-fatal):', err.message);
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
