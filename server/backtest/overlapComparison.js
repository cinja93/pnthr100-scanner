// server/backtest/overlapComparison.js
// ── PNTHR Overlap Comparison: AI 300 vs 679 Rules for Shared Tickers ────────
//
// Head-to-head backtest of tickers that exist in BOTH the AI 300 universe
// and the 679 universe. Determines which strategy produces better results
// for each ticker so we can optimally assign them.
//
// Usage: cd server && node backtest/overlapComparison.js
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { MongoClient } from 'mongodb';
import { detectAllSignals, calculateEMA, blInitStop, ssInitStop } from '../signalDetection.js';
import { computeWilderATR } from '../stopCalculation.js';
import { SECTORS } from '../scripts/aiUniverse/aiUniverseData.js';
import { SECTOR_EMA_PERIODS as AI_SECTOR_EMA_PERIODS } from '../data/pnthrAiSectorsConfig.js';
import { CARNIVORE_MODE_TICKERS } from '../data/strategyMode.js';

// ── Constants ────────────────────────────────────────────────────────────────
const STARTING_NAV    = 1_000_000;
const AI_GATE_OFFSET  = 0.25;
const C679_GATE_OFFSET = 0.10;
const PAI300_EMA      = 36;
const REGIME_EMA_679  = 21;
const LOT_PCT         = [0.35, 0.25, 0.20, 0.12, 0.08];
const GO_TOP          = 6;
const NEUT_TOP        = 12;
const STALE_DAYS      = 20;  // 4 weeks
const BACKTEST_START  = '2022-11-30';

// timeout: kill after 9 min to print partial results
const TIMEOUT_MS = 9 * 60 * 1000;
const startTime = Date.now();

// SECTOR_MAP for 679 (GICS sector name → ETF ticker)
const SECTOR_MAP = {
  'Technology':             'XLK',
  'Energy':                 'XLE',
  'Healthcare':             'XLV',
  'Health Care':            'XLV',
  'Financial Services':     'XLF',
  'Financials':             'XLF',
  'Consumer Discretionary': 'XLY',
  'Communication Services': 'XLC',
  'Industrials':            'XLI',
  'Basic Materials':        'XLB',
  'Materials':              'XLB',
  'Real Estate':            'XLRE',
  'Utilities':              'XLU',
  'Consumer Staples':       'XLP',
};

// Build AI universe ticker set and sectorId lookup
const AI_TICKER_SET = new Set();
const AI_TICKER_SECTOR = {};  // ticker → sectorId
for (const sec of SECTORS) {
  for (const h of sec.holdings) {
    AI_TICKER_SET.add(h.ticker);
    AI_TICKER_SECTOR[h.ticker] = sec.id;
  }
}

// ── Position sizing ─────────────────────────────────────────────────────────
function sizePosition(nav, entryPrice, stopPrice, sectorMult = 1.0) {
  const tickerCap = nav * 0.10;
  const vitality  = nav * 0.01 * sectorMult;
  const rps = Math.abs(entryPrice - stopPrice);
  if (rps <= 0 || entryPrice <= 0) return 0;
  return Math.floor(Math.min(Math.floor(vitality / rps), Math.floor(tickerCap / entryPrice)));
}

// ── EMA helper ──────────────────────────────────────────────────────────────
function emaValues(closes, period) {
  const k = 2 / (period + 1);
  const result = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    result.push(closes[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

// ── Stop ratchet ─────────────────────────────────────────────────────────────
function ratchetStop(weekly, atrArr, weekIdx, signal, currentStop) {
  if (weekIdx < 3 || !atrArr[weekIdx - 1]) return currentStop;
  const prev1 = weekly[weekIdx - 1];
  const prev2 = weekly[weekIdx - 2];
  if (signal === 'BL') {
    const twoWeekLow = Math.min(prev1.low, prev2.low);
    const struct = parseFloat((twoWeekLow - 0.01).toFixed(2));
    const atrFloor = parseFloat((prev1.close - atrArr[weekIdx - 1]).toFixed(2));
    return parseFloat(Math.max(currentStop, Math.max(struct, atrFloor)).toFixed(2));
  } else {
    const twoWeekHigh = Math.max(prev1.high, prev2.high);
    const struct = parseFloat((twoWeekHigh + 0.01).toFixed(2));
    const atrCeil = parseFloat((prev1.close + atrArr[weekIdx - 1]).toFixed(2));
    return parseFloat(Math.min(currentStop, Math.min(struct, atrCeil)).toFixed(2));
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db('pnthr_den');

  console.log('═'.repeat(80));
  console.log('  PNTHR OVERLAP COMPARISON — AI 300 vs 679 Rules');
  console.log(`  Period:       ${BACKTEST_START} → present`);
  console.log(`  Starting NAV: $${STARTING_NAV.toLocaleString()}`);
  console.log('═'.repeat(80));

  // ── 1. Find overlap tickers ────────────────────────────────────────────
  console.log('\n[1/6] Finding overlap tickers...');
  const btScoreTickers = await db.collection('pnthr_bt_scores').distinct('ticker');
  const bt679Set = new Set(btScoreTickers);
  const overlapTickers = [...AI_TICKER_SET].filter(t => bt679Set.has(t)).sort();
  console.log(`  AI 300 universe:     ${AI_TICKER_SET.size} tickers`);
  console.log(`  679 bt_scores:       ${bt679Set.size} tickers`);
  console.log(`  Overlap:             ${overlapTickers.length} tickers`);
  console.log(`  Currently carnivore: ${[...overlapTickers].filter(t => CARNIVORE_MODE_TICKERS.has(t)).length}`);
  console.log(`  Currently AI 300:    ${[...overlapTickers].filter(t => !CARNIVORE_MODE_TICKERS.has(t)).length}`);

  // ── 2. Load PAI300 index for AI regime gate ────────────────────────────
  console.log('\n[2/6] Loading PAI300 regime data...');
  const pai300Doc = await db.collection('pnthr_ai_index_candles_weekly').findOne({ ticker: 'PAI300' });
  if (!pai300Doc?.weekly?.length) { console.error('No PAI300 data'); process.exit(1); }
  const pai300Weekly = [...pai300Doc.weekly].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  const pai300Closes = pai300Weekly.map(b => b.close);
  const pai300Ema = emaValues(pai300Closes, PAI300_EMA);
  const pai300Regime = {};
  for (let i = 0; i < pai300Weekly.length; i++) {
    pai300Regime[pai300Weekly[i].weekOf] = pai300Closes[i] > pai300Ema[i];
  }

  // ── 3. Load SPY/QQQ for 679 regime gate ────────────────────────────────
  console.log('[3/6] Loading SPY/QQQ regime data...');
  const spyDoc = await db.collection('pnthr_bt_candles_weekly').findOne({ ticker: 'SPY' });
  const qqqDoc = await db.collection('pnthr_bt_candles_weekly').findOne({ ticker: 'QQQ' });
  if (!spyDoc?.weekly?.length || !qqqDoc?.weekly?.length) {
    console.error('Missing SPY or QQQ candles'); process.exit(1);
  }
  const spyWeekly = [...spyDoc.weekly].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  const qqqWeekly = [...qqqDoc.weekly].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  const spyCloses = spyWeekly.map(b => b.close);
  const qqqCloses = qqqWeekly.map(b => b.close);
  const spyEma21 = emaValues(spyCloses, REGIME_EMA_679);
  const qqqEma21 = emaValues(qqqCloses, REGIME_EMA_679);
  const regime679 = {};
  for (let i = 0; i < spyWeekly.length; i++) {
    const spyAbove = spyCloses[i] > spyEma21[i];
    const weekOf = spyWeekly[i].weekOf;
    // find matching QQQ week
    const qIdx = qqqWeekly.findIndex(b => b.weekOf === weekOf);
    const qqqAbove = qIdx >= 0 ? qqqCloses[qIdx] > qqqEma21[qIdx] : false;
    regime679[weekOf] = { spyAbove, qqqAbove, bullish: spyAbove && qqqAbove };
  }
  // Also build SPY EMA slope for SS crash gate
  const spyEmaSlope = {};
  for (let i = 1; i < spyWeekly.length; i++) {
    const falling = spyEma21[i] < spyEma21[i - 1];
    const prevFalling = i >= 2 ? spyEma21[i - 1] < spyEma21[i - 2] : false;
    spyEmaSlope[spyWeekly[i].weekOf] = { falling, twoWeekFalling: falling && prevFalling };
  }

  // ── 4. Load sector rotation ranks (AI) ─────────────────────────────────
  console.log('[4/6] Loading sector rotation ranks...');
  const sectorRankDocs = await db.collection('pnthr_ai_sector_rank_daily').find({}).sort({ date: 1 }).toArray();
  const sectorRankByDate = {};
  const sectorRankDates = [];
  for (const doc of sectorRankDocs) {
    const tierMap = {};
    for (const r of doc.ranks) {
      tierMap[r.sectorId] = r.rank <= GO_TOP ? 'GO' : r.rank <= NEUT_TOP ? 'NEUTRAL' : 'NO_GO';
    }
    sectorRankByDate[doc.date] = tierMap;
    sectorRankDates.push(doc.date);
  }

  function getSectorTierOnDate(sectorId, dateStr) {
    for (let i = sectorRankDates.length - 1; i >= 0; i--) {
      if (sectorRankDates[i] <= dateStr) return sectorRankByDate[sectorRankDates[i]][sectorId] || 'NEUTRAL';
    }
    return 'NEUTRAL';
  }

  function getSectorMult(tier, signal) {
    if (signal === 'BL') {
      if (tier === 'GO') return 1.25;
      if (tier === 'NEUTRAL') return 1.0;
      return 0; // NO_GO skip
    } else {
      if (tier === 'NO_GO') return 1.25;
      if (tier === 'NEUTRAL') return 1.0;
      return 0; // GO skip
    }
  }

  // ── 5. Load sector ETF candles for 679 SS crash gate ───────────────────
  console.log('[5/6] Loading sector ETF candles for SS crash gate...');
  const sectorEtfs = ['XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLY', 'XLP', 'XLU', 'XLRE', 'XLC', 'XLB'];
  const sectorEtfWeekly = {};
  for (const etf of sectorEtfs) {
    const doc = await db.collection('pnthr_bt_candles_weekly').findOne({ ticker: etf });
    if (doc?.weekly) {
      const sorted = [...doc.weekly].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
      // build 5D return map (weekly close-to-close)
      const returnMap = {};
      for (let i = 1; i < sorted.length; i++) {
        returnMap[sorted[i].weekOf] = (sorted[i].close - sorted[i - 1].close) / sorted[i - 1].close;
      }
      sectorEtfWeekly[etf] = returnMap;
    }
  }

  // ── 6. Load candle data + bt_scores and run comparison ─────────────────
  console.log('[6/6] Running comparison for each overlap ticker...\n');

  // Pre-load all AI candles for overlap tickers
  const aiWeeklyDocs = await db.collection('pnthr_ai_bt_candles_weekly')
    .find({ ticker: { $in: overlapTickers } }).toArray();
  const aiWeeklyMap = {};
  for (const doc of aiWeeklyDocs) {
    aiWeeklyMap[doc.ticker] = [...(doc.weekly || [])].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  }

  // Pre-load all 679 candles for overlap tickers
  const bt679WeeklyDocs = await db.collection('pnthr_bt_candles_weekly')
    .find({ ticker: { $in: overlapTickers } }).toArray();
  const bt679WeeklyMap = {};
  for (const doc of bt679WeeklyDocs) {
    bt679WeeklyMap[doc.ticker] = [...(doc.weekly || [])].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  }

  // Pre-load all bt_scores for overlap tickers
  // NOTE: bt_scores.weekOf is a FRIDAY date. bt_candles_weekly.weekOf is MONDAY.
  // To align, we convert the Friday score date to its preceding Monday (same week).
  const btScoreDocs = await db.collection('pnthr_bt_scores')
    .find({ ticker: { $in: overlapTickers } }).sort({ weekOf: 1 }).toArray();
  const btScoreMap = {};  // ticker → { mondayWeekOf → doc }
  function fridayToMonday(fridayStr) {
    const d = new Date(fridayStr + 'T12:00:00');
    const dow = d.getDay(); // Friday=5
    // Go back to Monday of same week
    const daysBack = dow === 0 ? 6 : dow - 1;
    const mon = new Date(d);
    mon.setDate(d.getDate() - daysBack);
    return mon.toISOString().split('T')[0];
  }
  for (const doc of btScoreDocs) {
    if (!btScoreMap[doc.ticker]) btScoreMap[doc.ticker] = {};
    const mondayKey = fridayToMonday(doc.weekOf);
    btScoreMap[doc.ticker][mondayKey] = doc;
  }

  // ── Trade simulator (shared mechanics) ─────────────────────────────────
  // Returns array of { pnl, signal, entryPrice, exitPrice, entryWeek, exitWeek }
  function simulateTrades(entries, weeklyBars, atrArr) {
    const trades = [];
    const barByWeek = {};
    for (let i = 0; i < weeklyBars.length; i++) {
      barByWeek[weeklyBars[i].weekOf] = { ...weeklyBars[i], idx: i };
    }

    for (const entry of entries) {
      const { weekOf, signal, stopPrice: initStop, sectorMult } = entry;
      // Find the NEXT week's bar for Monday open entry
      const entryBarInfo = barByWeek[weekOf];
      if (!entryBarInfo) continue;
      const nextIdx = entryBarInfo.idx + 1;
      if (nextIdx >= weeklyBars.length) continue;
      const entryBar = weeklyBars[nextIdx];
      const entryPrice = entryBar.open;
      if (!entryPrice || entryPrice <= 0) continue;

      // Size position
      const totalShares = sizePosition(STARTING_NAV, entryPrice, initStop, sectorMult || 1.0);
      if (totalShares <= 0) continue;

      let currentStop = initStop;
      let exitPrice = null;
      let exitWeek = null;
      let weeksHeld = 0;

      // Walk forward from entry
      for (let w = nextIdx; w < weeklyBars.length; w++) {
        const bar = weeklyBars[w];
        weeksHeld++;

        // Ratchet stop (skip entry week)
        if (w > nextIdx) {
          currentStop = ratchetStop(weeklyBars, atrArr, w, signal, currentStop);
        }

        // Check structural exit first
        if (w >= 2) {
          const prev1 = weeklyBars[w - 1];
          const prev2 = weeklyBars[w - 2];
          if (signal === 'BL') {
            const twoWeekLow = Math.min(prev1.low, prev2.low);
            if (bar.low < twoWeekLow) {
              exitPrice = currentStop;
              exitWeek = bar.weekOf;
              break;
            }
          } else {
            const twoWeekHigh = Math.max(prev1.high, prev2.high);
            if (bar.high > twoWeekHigh) {
              exitPrice = currentStop;
              exitWeek = bar.weekOf;
              break;
            }
          }
        }

        // Stop hit
        if (signal === 'BL' && bar.low <= currentStop) {
          exitPrice = currentStop;
          exitWeek = bar.weekOf;
          break;
        }
        if (signal === 'SS' && bar.high >= currentStop) {
          exitPrice = currentStop;
          exitWeek = bar.weekOf;
          break;
        }

        // Stale hunt (20 weeks ~ 20 trading weeks = ~100 days)
        if (weeksHeld >= STALE_DAYS / 5) {
          const underwater = signal === 'BL'
            ? bar.close < entryPrice
            : bar.close > entryPrice;
          if (underwater && weeksHeld >= 4) {
            exitPrice = bar.close;
            exitWeek = bar.weekOf;
            break;
          }
        }
      }

      // If still open, mark-to-market at last bar
      if (!exitPrice) {
        const lastBar = weeklyBars[weeklyBars.length - 1];
        exitPrice = lastBar.close;
        exitWeek = lastBar.weekOf;
      }

      const pnl = signal === 'BL'
        ? (exitPrice - entryPrice) * totalShares
        : (entryPrice - exitPrice) * totalShares;

      trades.push({
        signal,
        entryPrice,
        exitPrice,
        entryWeek: entryBar.weekOf,
        exitWeek,
        shares: totalShares,
        pnl,
        sectorMult: sectorMult || 1.0,
      });
    }
    return trades;
  }

  // ── Results collection ─────────────────────────────────────────────────
  const results = [];
  let processed = 0;
  let skippedAI = 0;
  let skipped679 = 0;

  for (const ticker of overlapTickers) {
    // Timeout check
    if (Date.now() - startTime > TIMEOUT_MS) {
      console.log(`\n⏱ TIMEOUT reached after ${processed} tickers. Printing partial results.\n`);
      break;
    }

    processed++;
    if (processed % 20 === 0 || processed === 1) {
      console.log(`  Processing ${processed}/${overlapTickers.length}: ${ticker}...`);
    }

    // ── RUN A: AI 300 Rules ──────────────────────────────────────────────
    const aiWeekly = aiWeeklyMap[ticker];
    let aiTrades = [];
    if (aiWeekly && aiWeekly.length > 40) {
      const sectorId = AI_TICKER_SECTOR[ticker];
      const emaPeriod = AI_SECTOR_EMA_PERIODS[sectorId] || 30;

      // Run detectAllSignals on AI candles
      const wBars = aiWeekly.map(b => ({
        time: b.weekOf, open: b.open, high: b.high, low: b.low, close: b.close,
      }));
      const sigResult = detectAllSignals(wBars, emaPeriod, false, null, AI_GATE_OFFSET);

      // Filter signals through AI gates
      const aiEntries = [];
      for (const ev of (sigResult.events || [])) {
        if (ev.signal !== 'BL' && ev.signal !== 'SS') continue;
        if (ev.time < BACKTEST_START) continue;

        // Regime gate: PAI300
        const paiAbove = pai300Regime[ev.time];
        if (paiAbove === undefined) continue;
        if (ev.signal === 'BL' && !paiAbove) continue;
        if (ev.signal === 'SS' && paiAbove) continue;

        // Sector rotation
        const tier = getSectorTierOnDate(sectorId, ev.time);
        const mult = getSectorMult(tier, ev.signal);
        if (mult === 0) continue;

        // Compute stop from signal detection
        const barIdx = wBars.findIndex(b => b.time === ev.time);
        if (barIdx < 2) continue;
        const prev1 = wBars[barIdx - 1];
        const prev2 = wBars[barIdx - 2];
        const cur = wBars[barIdx];
        const atrArrFull = computeWilderATR(wBars.slice(0, barIdx + 1).map(b => ({ high: b.high, low: b.low, close: b.close })));
        const atr = atrArrFull[atrArrFull.length - 1];
        let stopPrice;
        if (ev.signal === 'BL') {
          const twoBarLow = Math.min(prev1.low, prev2.low);
          stopPrice = blInitStop(twoBarLow, cur.close, atr);
        } else {
          const twoBarHigh = Math.max(prev1.high, prev2.high);
          stopPrice = ssInitStop(twoBarHigh, cur.close, atr);
        }

        aiEntries.push({
          weekOf: ev.time,
          signal: ev.signal,
          stopPrice,
          sectorMult: mult,
        });
      }

      // Build ATR for full weekly series
      const atrFull = computeWilderATR(aiWeekly.map(b => ({ high: b.high, low: b.low, close: b.close })));
      aiTrades = simulateTrades(aiEntries, aiWeekly, atrFull);
    } else {
      skippedAI++;
    }

    // ── RUN B: 679 Rules ─────────────────────────────────────────────────
    const scores = btScoreMap[ticker] || {};
    const bt679Weekly = bt679WeeklyMap[ticker];
    let trades679 = [];

    if (bt679Weekly && bt679Weekly.length > 30 && Object.keys(scores).length > 0) {
      const entries679 = [];

      for (const [weekOf, doc] of Object.entries(scores)) {
        if (weekOf < BACKTEST_START) continue;
        if (!doc.signal || (doc.signal !== 'BL' && doc.signal !== 'SS')) continue;
        if (!doc.stopPrice || !doc.entryPrice) continue;

        // D2 gate
        if (!doc.scores || doc.scores.d2 < 0) continue;

        // apexScore gate
        if (!doc.apexScore || doc.apexScore <= 0) continue;

        // Regime gate: SPY + QQQ both above 21W EMA
        // Find closest regime week on or before this weekOf
        let regimeWeek = null;
        for (const rw of Object.keys(regime679).sort().reverse()) {
          if (rw <= weekOf) { regimeWeek = rw; break; }
        }
        if (!regimeWeek) continue;
        const rg = regime679[regimeWeek];
        if (doc.signal === 'BL' && !rg.bullish) continue;
        if (doc.signal === 'SS' && rg.bullish) continue;

        // SS crash gate
        if (doc.signal === 'SS') {
          const slope = spyEmaSlope[regimeWeek];
          if (slope?.twoWeekFalling) {
            const sectorEtf = SECTOR_MAP[doc.sector];
            if (sectorEtf && sectorEtfWeekly[sectorEtf]) {
              const ret5d = sectorEtfWeekly[sectorEtf][regimeWeek];
              if (ret5d !== undefined && ret5d < -0.03) continue; // skip SS during crash
            }
          }
        }

        entries679.push({
          weekOf,
          signal: doc.signal,
          stopPrice: doc.stopPrice,
          sectorMult: 1.0,
        });
      }

      const atrFull679 = computeWilderATR(bt679Weekly.map(b => ({ high: b.high, low: b.low, close: b.close })));
      trades679 = simulateTrades(entries679, bt679Weekly, atrFull679);
    } else {
      skipped679++;
    }

    // ── Aggregate ticker results ─────────────────────────────────────────
    const aiPnl = aiTrades.reduce((s, t) => s + t.pnl, 0);
    const aiWins = aiTrades.filter(t => t.pnl > 0).length;
    const aiLosses = aiTrades.filter(t => t.pnl <= 0).length;
    const aiGrossWin = aiTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const aiGrossLoss = Math.abs(aiTrades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));

    const pnl679 = trades679.reduce((s, t) => s + t.pnl, 0);
    const wins679 = trades679.filter(t => t.pnl > 0).length;
    const losses679 = trades679.filter(t => t.pnl <= 0).length;
    const grossWin679 = trades679.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const grossLoss679 = Math.abs(trades679.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));

    results.push({
      ticker,
      currentAssignment: CARNIVORE_MODE_TICKERS.has(ticker) ? '679' : 'AI',
      ai: {
        pnl: aiPnl,
        trades: aiTrades.length,
        wins: aiWins,
        losses: aiLosses,
        winRate: aiTrades.length > 0 ? (aiWins / aiTrades.length * 100) : 0,
        pf: aiGrossLoss > 0 ? aiGrossWin / aiGrossLoss : (aiGrossWin > 0 ? 99.9 : 0),
      },
      c679: {
        pnl: pnl679,
        trades: trades679.length,
        wins: wins679,
        losses: losses679,
        winRate: trades679.length > 0 ? (wins679 / trades679.length * 100) : 0,
        pf: grossLoss679 > 0 ? grossWin679 / grossLoss679 : (grossWin679 > 0 ? 99.9 : 0),
      },
      delta: aiPnl - pnl679,
      recommendation: aiPnl >= pnl679 ? 'AI' : '679',
    });
  }

  // ── Print Results ──────────────────────────────────────────────────────
  console.log('\n');
  console.log('═'.repeat(140));
  console.log('  OVERLAP COMPARISON RESULTS — Sorted by |Delta| (largest difference first)');
  console.log('═'.repeat(140));

  // Sort by absolute delta descending
  results.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  // Header
  const hdr = [
    'Ticker'.padEnd(8),
    'Curr'.padEnd(5),
    '│',
    'AI P&L'.padStart(12),
    'Trades'.padStart(7),
    'WR%'.padStart(7),
    'PF'.padStart(6),
    '│',
    '679 P&L'.padStart(12),
    'Trades'.padStart(7),
    'WR%'.padStart(7),
    'PF'.padStart(6),
    '│',
    'Delta'.padStart(12),
    'Rec'.padStart(5),
    'Switch?'.padStart(8),
  ].join(' ');
  console.log(hdr);
  console.log('─'.repeat(140));

  let totalAiPnl = 0, totalAiTrades = 0, totalAiWins = 0;
  let total679Pnl = 0, total679Trades = 0, total679Wins = 0;
  let switchCount = 0;

  for (const r of results) {
    totalAiPnl += r.ai.pnl;
    totalAiTrades += r.ai.trades;
    totalAiWins += r.ai.wins;
    total679Pnl += r.c679.pnl;
    total679Trades += r.c679.trades;
    total679Wins += r.c679.wins;

    const shouldSwitch = r.recommendation !== r.currentAssignment;
    if (shouldSwitch) switchCount++;

    const row = [
      r.ticker.padEnd(8),
      r.currentAssignment.padEnd(5),
      '│',
      `$${r.ai.pnl >= 0 ? '+' : ''}${r.ai.pnl.toFixed(0)}`.padStart(12),
      String(r.ai.trades).padStart(7),
      `${r.ai.winRate.toFixed(1)}`.padStart(7),
      r.ai.pf.toFixed(2).padStart(6),
      '│',
      `$${r.c679.pnl >= 0 ? '+' : ''}${r.c679.pnl.toFixed(0)}`.padStart(12),
      String(r.c679.trades).padStart(7),
      `${r.c679.winRate.toFixed(1)}`.padStart(7),
      r.c679.pf.toFixed(2).padStart(6),
      '│',
      `$${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(0)}`.padStart(12),
      r.recommendation.padStart(5),
      (shouldSwitch ? '  <<' : '').padStart(8),
    ].join(' ');
    console.log(row);
  }

  console.log('─'.repeat(140));

  // Aggregates
  const aggAiWR = totalAiTrades > 0 ? (totalAiWins / totalAiTrades * 100).toFixed(1) : '0.0';
  const agg679WR = total679Trades > 0 ? (total679Wins / total679Trades * 100).toFixed(1) : '0.0';
  console.log([
    'TOTAL'.padEnd(8),
    ''.padEnd(5),
    '│',
    `$${totalAiPnl >= 0 ? '+' : ''}${totalAiPnl.toFixed(0)}`.padStart(12),
    String(totalAiTrades).padStart(7),
    `${aggAiWR}`.padStart(7),
    ''.padStart(6),
    '│',
    `$${total679Pnl >= 0 ? '+' : ''}${total679Pnl.toFixed(0)}`.padStart(12),
    String(total679Trades).padStart(7),
    `${agg679WR}`.padStart(7),
    ''.padStart(6),
    '│',
    `$${(totalAiPnl - total679Pnl) >= 0 ? '+' : ''}${(totalAiPnl - total679Pnl).toFixed(0)}`.padStart(12),
    (totalAiPnl >= total679Pnl ? 'AI' : '679').padStart(5),
    ''.padStart(8),
  ].join(' '));

  console.log('\n' + '═'.repeat(80));
  console.log('  SUMMARY');
  console.log('═'.repeat(80));
  console.log(`  Overlap tickers analyzed:  ${results.length}`);
  console.log(`  Tickers favoring AI 300:   ${results.filter(r => r.recommendation === 'AI').length}`);
  console.log(`  Tickers favoring 679:      ${results.filter(r => r.recommendation === '679').length}`);
  console.log(`  Tickers that should SWITCH: ${switchCount}`);
  console.log(`    Currently 679 → should be AI: ${results.filter(r => r.currentAssignment === '679' && r.recommendation === 'AI').length}`);
  console.log(`    Currently AI → should be 679: ${results.filter(r => r.currentAssignment === 'AI' && r.recommendation === '679').length}`);
  console.log(`  Aggregate AI 300 P&L:      $${totalAiPnl >= 0 ? '+' : ''}${totalAiPnl.toFixed(0)}`);
  console.log(`  Aggregate 679 P&L:         $${total679Pnl >= 0 ? '+' : ''}${total679Pnl.toFixed(0)}`);
  console.log(`  AI advantage:              $${(totalAiPnl - total679Pnl) >= 0 ? '+' : ''}${(totalAiPnl - total679Pnl).toFixed(0)}`);
  if (skippedAI > 0 || skipped679 > 0)
    console.log(`  Skipped (no data):         AI=${skippedAI}, 679=${skipped679}`);
  console.log(`  Runtime:                   ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  console.log('═'.repeat(80));

  // Print switch list
  const switches = results.filter(r => r.recommendation !== r.currentAssignment);
  if (switches.length > 0) {
    console.log('\n  SWITCH LIST:');
    const toAI = switches.filter(r => r.recommendation === 'AI').sort((a, b) => b.delta - a.delta);
    const to679 = switches.filter(r => r.recommendation === '679').sort((a, b) => a.delta - b.delta);
    if (toAI.length) {
      console.log(`\n  Move to AI 300 (${toAI.length} tickers):`);
      for (const r of toAI) console.log(`    ${r.ticker.padEnd(8)} delta $${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(0)}`);
    }
    if (to679.length) {
      console.log(`\n  Move to 679 (${to679.length} tickers):`);
      for (const r of to679) console.log(`    ${r.ticker.padEnd(8)} delta $${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(0)}`);
    }
  }

  // ── ALPHABETICAL SIDE-BY-SIDE TABLE ──────────────────────────────────────
  console.log('\n\n');
  console.log('═'.repeat(130));
  console.log('  SIDE-BY-SIDE COMPARISON — Alphabetical by Ticker');
  console.log('  Return % = P&L / $1M starting NAV.  WINNER column shows which strategy produced higher returns for that stock.');
  console.log('═'.repeat(130));
  const alpha = [...results].sort((a, b) => a.ticker.localeCompare(b.ticker));
  console.log(
    'Ticker'.padEnd(8) +
    ' │ ' + 'AI 300 P&L'.padStart(12) + '  ' + 'Return%'.padStart(8) + '  ' + 'Trades'.padStart(6) + '  ' + 'WR%'.padStart(6) +
    ' │ ' + '679 P&L'.padStart(12) + '  ' + 'Return%'.padStart(8) + '  ' + 'Trades'.padStart(6) + '  ' + 'WR%'.padStart(6) +
    ' │ ' + 'WINNER'.padStart(6) + '  ' + 'Edge $'.padStart(12) + '  ' + 'Curr'.padStart(4) + '  ' + 'Action'.padStart(10)
  );
  console.log('─'.repeat(130));
  for (const r of alpha) {
    const aiRet = (r.ai.pnl / STARTING_NAV * 100).toFixed(2);
    const c679Ret = (r.c679.pnl / STARTING_NAV * 100).toFixed(2);
    const winner = r.recommendation;
    const edge = Math.abs(r.delta);
    const shouldSwitch = r.recommendation !== r.currentAssignment;
    const action = shouldSwitch ? `→ ${r.recommendation}` : 'KEEP';
    console.log(
      r.ticker.padEnd(8) +
      ' │ ' + `$${r.ai.pnl >= 0 ? '+' : ''}${r.ai.pnl.toFixed(0)}`.padStart(12) + '  ' + `${aiRet}%`.padStart(8) + '  ' + String(r.ai.trades).padStart(6) + '  ' + `${r.ai.winRate.toFixed(1)}`.padStart(6) +
      ' │ ' + `$${r.c679.pnl >= 0 ? '+' : ''}${r.c679.pnl.toFixed(0)}`.padStart(12) + '  ' + `${c679Ret}%`.padStart(8) + '  ' + String(r.c679.trades).padStart(6) + '  ' + `${r.c679.winRate.toFixed(1)}`.padStart(6) +
      ' │ ' + winner.padStart(6) + '  ' + `$${edge.toFixed(0)}`.padStart(12) + '  ' + r.currentAssignment.padStart(4) + '  ' + action.padStart(10)
    );
  }
  console.log('─'.repeat(130));
  const totAiRet = (totalAiPnl / STARTING_NAV * 100).toFixed(2);
  const tot679Ret = (total679Pnl / STARTING_NAV * 100).toFixed(2);
  console.log(
    'TOTAL'.padEnd(8) +
    ' │ ' + `$${totalAiPnl >= 0 ? '+' : ''}${totalAiPnl.toFixed(0)}`.padStart(12) + '  ' + `${totAiRet}%`.padStart(8) + '  ' + String(totalAiTrades).padStart(6) + '  ' + `${(totalAiWins/totalAiTrades*100).toFixed(1)}`.padStart(6) +
    ' │ ' + `$${total679Pnl >= 0 ? '+' : ''}${total679Pnl.toFixed(0)}`.padStart(12) + '  ' + `${tot679Ret}%`.padStart(8) + '  ' + String(total679Trades).padStart(6) + '  ' + `${(total679Wins/total679Trades*100).toFixed(1)}`.padStart(6) +
    ' │ ' + 'AI'.padStart(6) + '  ' + `$${Math.abs(totalAiPnl - total679Pnl).toFixed(0)}`.padStart(12) + '  ' + ''.padStart(4) + '  ' + ''.padStart(10)
  );
  console.log('═'.repeat(130));

  await client.close();
}

main().catch(err => { console.error(err); process.exit(1); });
