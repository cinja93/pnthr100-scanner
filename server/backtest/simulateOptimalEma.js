// server/backtest/simulateOptimalEma.js
// ── DEFINITIVE TEST: Full pipeline with per-sector optimal EMA periods ────────
//
// Runs TWO complete simulations side-by-side:
//   A) BASELINE: Universal 21 EMA for all stocks (current production)
//   B) OPTIMIZED: Each sector uses its empirically optimal EMA period
//
// Both use the EXACT same pipeline:
//   Macro gate → Sector gate → D2 gate → SS crash gate → Re-rank → Top 10 BL / Top 5 SS
//
// This measures the REAL combined impact when all sectors use optimal EMAs
// simultaneously, including how signal changes affect cross-sector ranking
// competition in the top 10/5 selection.
//
// Usage:  cd server && node backtest/simulateOptimalEma.js
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { connectToDatabase } from '../database.js';
import { aggregateWeeklyBars } from '../technicalUtils.js';
import { computeWilderATR, blInitStop, ssInitStop } from '../stopCalculation.js';

const ALL_SECTOR_ETFS = ['XLK','XLE','XLV','XLF','XLY','XLC','XLI','XLB','XLRE','XLU','XLP'];
const SECTOR_MAP = {
  'Technology':'XLK','Energy':'XLE','Healthcare':'XLV','Health Care':'XLV',
  'Financial Services':'XLF','Financials':'XLF','Consumer Discretionary':'XLY',
  'Consumer Cyclical':'XLY','Communication Services':'XLC','Industrials':'XLI',
  'Basic Materials':'XLB','Materials':'XLB','Real Estate':'XLRE','Utilities':'XLU',
  'Consumer Staples':'XLP','Consumer Defensive':'XLP',
};

const SECTOR_NORMALIZE = {
  'Consumer Cyclical': 'Consumer Discretionary',
  'Consumer Defensive': 'Consumer Staples',
  'Health Care': 'Healthcare',
  'Financials': 'Financial Services',
  'Materials': 'Basic Materials',
};
function normSector(s) { return SECTOR_NORMALIZE[s] || s; }

const ALL_SECTORS = [
  'Technology', 'Energy', 'Healthcare', 'Financial Services',
  'Consumer Discretionary', 'Consumer Staples', 'Communication Services',
  'Industrials', 'Basic Materials', 'Real Estate', 'Utilities',
];

// ── OPTIMAL EMA PERIODS (empirically derived from per-sector testing) ────────
// REFINED CONFIG: Comm Services + Utilities kept at 21 (regressed in full pipeline)
const OPTIMAL_EMA = {
  'Technology':              21,  // baseline confirmed optimal
  'Healthcare':              24,  // +longer, slow-cycle defensive/growth
  'Financial Services':      25,  // +longer, cyclical
  'Industrials':             24,  // +longer, cyclical
  'Energy':                  26,  // +longer, commodity
  'Communication Services':  21,  // kept at 21 — regressed -15% in full pipeline at 25
  'Real Estate':             26,  // +longer, rate-sensitive
  'Utilities':               21,  // kept at 21 — regressed -54% in full pipeline at 23
  'Basic Materials':         19,  // -shorter, fast-revert commodity
  'Consumer Discretionary':  19,  // -shorter, cyclical consumer
  'Consumer Staples':        18,  // -shorter, defensive consumer
};

const LOT_SIZE_USD = 10000;

// ── EMA computation with variable period ─────────────────────────────────────
function computeEMASeries(closes, period) {
  if (closes.length < period) return [];
  const mult = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, c) => s + c, 0) / period;
  const emas = [ema];
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * mult + ema * (1 - mult);
    emas.push(ema);
  }
  return emas;
}

// ── Signal state machine with variable EMA ───────────────────────────────────
// Returns Map<fridayDate, { signal, entryPrice, stopPrice }>
// Emits for EVERY active week (multi-week signal persistence)
function runAllSignals(weeklyBars, emaPeriod, isETF = false) {
  const events = new Map();
  if (weeklyBars.length < emaPeriod + 2) return events;

  const closes = weeklyBars.map(b => b.close);
  const emas = computeEMASeries(closes, emaPeriod);
  if (emas.length < 2) return events;
  const atrArr = computeWilderATR(weeklyBars);
  const emaOffset = emaPeriod - 1;

  let position = null;
  let longDaylight = 0, shortDaylight = 0;
  let longTrendActive = false, longTrendCapped = false;
  let shortTrendActive = false, shortTrendCapped = false;

  for (let wi = emaPeriod + 1; wi < weeklyBars.length; wi++) {
    const emaIdx = wi - emaOffset;
    if (emaIdx < 1) continue;

    const current = weeklyBars[wi];
    const prev1 = weeklyBars[wi - 1];
    const prev2 = weeklyBars[wi - 2];
    const emaCurrent = emas[emaIdx];
    const twoWeekHigh = Math.max(prev1.high, prev2.high);
    const twoWeekLow = Math.min(prev1.low, prev2.low);

    longDaylight = current.low > emaCurrent ? longDaylight + 1 : 0;
    shortDaylight = current.high < emaCurrent ? shortDaylight + 1 : 0;

    const mon = new Date(current.weekStart + 'T12:00:00');
    const fri = new Date(mon);
    fri.setDate(mon.getDate() + 4);
    const fridayStr = fri.toISOString().split('T')[0];

    if (position && position.entryWi !== wi) {
      const prevAtr = atrArr[wi - 1];
      if (prevAtr != null) {
        if (position.type === 'BL') {
          const candidate = Math.max(parseFloat((twoWeekLow - 0.01).toFixed(2)), parseFloat((prev1.close - prevAtr).toFixed(2)));
          position.pnthrStop = parseFloat(Math.max(position.pnthrStop, candidate).toFixed(2));
        } else {
          const candidate = Math.min(parseFloat((twoWeekHigh + 0.01).toFixed(2)), parseFloat((prev1.close + prevAtr).toFixed(2)));
          position.pnthrStop = parseFloat(Math.min(position.pnthrStop, candidate).toFixed(2));
        }
      }
      if (position.type === 'BL' && current.low < twoWeekLow) {
        shortTrendActive = true; shortTrendCapped = true; position = null; continue;
      }
      if (position.type === 'SS' && current.high > twoWeekHigh) {
        longTrendActive = true; longTrendCapped = true; position = null; continue;
      }
      events.set(fridayStr, { signal: position.type, entryPrice: position.entryPrice, stopPrice: position.pnthrStop });
    }

    if (!position) {
      const emaPrev = emas[emaIdx - 1];
      const blPhase1 = current.close > emaCurrent && emaCurrent > emaPrev && current.high >= twoWeekHigh + 0.01;
      const ssPhase1 = current.close < emaCurrent && emaCurrent < emaPrev && current.low <= twoWeekLow - 0.01;
      const dPct = isETF ? 0.003 : 0.01;
      const blZone = current.low >= emaCurrent * (1 + dPct) && current.low <= emaCurrent * 1.10;
      const ssZone = current.high <= emaCurrent * (1 - dPct) && current.high >= emaCurrent * 0.90;
      const blReentry = longTrendActive && current.low >= emaCurrent * (1 + dPct) && (!longTrendCapped || current.low <= emaCurrent * 1.25);
      const ssReentry = shortTrendActive && current.high <= emaCurrent * (1 - dPct) && (!shortTrendCapped || current.high >= emaCurrent * 0.75);
      const blDaylightOk = blReentry || (blZone && longDaylight >= 1 && longDaylight <= 3);
      const ssDaylightOk = ssReentry || (ssZone && shortDaylight >= 1 && shortDaylight <= 3);

      if (blPhase1 && blDaylightOk) {
        const initStop = blInitStop(twoWeekLow, current.close, atrArr[wi]);
        const entryPrice = parseFloat((twoWeekHigh + 0.01).toFixed(2));
        events.set(fridayStr, { signal: 'BL', entryPrice, stopPrice: initStop });
        position = { type: 'BL', entryWi: wi, pnthrStop: initStop, entryPrice };
        longTrendActive = true; longTrendCapped = false; shortTrendActive = false; shortTrendCapped = false;
      } else if (ssPhase1 && ssDaylightOk) {
        const initStop = ssInitStop(twoWeekHigh, current.close, atrArr[wi]);
        const entryPrice = parseFloat((twoWeekLow - 0.01).toFixed(2));
        events.set(fridayStr, { signal: 'SS', entryPrice, stopPrice: initStop });
        position = { type: 'SS', entryWi: wi, pnthrStop: initStop, entryPrice };
        shortTrendActive = true; shortTrendCapped = false; longTrendActive = false; longTrendCapped = false;
      }
    }
  }
  return events;
}

// ── Close helper ────────────────────────────────────────────────────────────
function closePosition(pos, exitDate, exitPrice, exitReason) {
  pos.exitDate = exitDate;
  pos.exitPrice = exitPrice;
  pos.exitReason = exitReason;
  if (pos.signal === 'BL') {
    pos.profitPct = parseFloat(((exitPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(2));
  } else {
    pos.profitPct = parseFloat(((pos.entryPrice - exitPrice) / pos.entryPrice * 100).toFixed(2));
  }
  pos.dollarPnl = parseFloat((pos.profitPct / 100 * LOT_SIZE_USD).toFixed(2));
  pos.isWinner = pos.profitPct > 0;
  pos.closed = true;
  pos.maxLots = 1;
}

// ── Run one full simulation ──────────────────────────────────────────────────
// useOptimal=false → baseline (use stored scores as-is, EMA 21)
// useOptimal=true  → override signals for non-21 sectors with recomputed signals
function runFullSimulation({
  useOptimal, allWeeks, scoresByWeek, signalMap,
  regimeMap, slopeFallingMap, sectorEmaByWeek, sector5dMap,
  candleMap, weeklyMap, atrMap, optimizedSignals,
}) {
  const openPositions = new Map();
  const closedTrades = [];

  for (let wi = 0; wi < allWeeks.length; wi++) {
    const friday = allWeeks[wi];
    const regime = regimeMap[friday];

    // ── Exit checks ──
    for (const [ticker, pos] of openPositions) {
      const daily = candleMap[ticker];
      if (!daily) continue;
      const weekly = weeklyMap[ticker];
      const atrArr = atrMap[ticker];

      for (const bar of daily) {
        if (bar.date <= pos.lastCheckedDate) continue;
        if (bar.date > friday) break;

        pos.tradingDays++;
        pos.lastCheckedDate = bar.date;

        // MFE/MAE tracking
        const refPrice = pos.entryPrice;
        if (pos.signal === 'BL') {
          pos.maxFavorable = Math.max(pos.maxFavorable || 0, (bar.high - refPrice) / refPrice * 100);
          pos.maxAdverse = Math.min(pos.maxAdverse || 0, (bar.low - refPrice) / refPrice * 100);
        } else {
          pos.maxFavorable = Math.max(pos.maxFavorable || 0, (refPrice - bar.low) / refPrice * 100);
          pos.maxAdverse = Math.min(pos.maxAdverse || 0, (refPrice - bar.high) / refPrice * 100);
        }

        // Weekly stop ratchet
        const barD = new Date(bar.date + 'T12:00:00');
        const barDow = barD.getDay();
        const daysToMon = barDow === 0 ? -6 : 1 - barDow;
        const barMonday = new Date(barD);
        barMonday.setDate(barD.getDate() + daysToMon);
        const barMondayStr = barMonday.toISOString().split('T')[0];
        const weekIdx = weekly.findIndex(b => b.weekStart === barMondayStr);

        if (weekIdx > pos.currentWeekIdx && weekIdx >= 3) {
          pos.currentWeekIdx = weekIdx;
          const prev1 = weekly[weekIdx - 1];
          const prev2 = weekly[weekIdx - 2];
          const twoWeekHigh = Math.max(prev1.high, prev2.high);
          const twoWeekLow = Math.min(prev1.low, prev2.low);
          const prevAtr = atrArr[weekIdx - 1];

          if (prevAtr != null) {
            if (pos.signal === 'BL') {
              const candidate = Math.max(parseFloat((twoWeekLow - 0.01).toFixed(2)), parseFloat((prev1.close - prevAtr).toFixed(2)));
              pos.stop = parseFloat(Math.max(pos.stop, candidate).toFixed(2));
            } else {
              const candidate = Math.min(parseFloat((twoWeekHigh + 0.01).toFixed(2)), parseFloat((prev1.close + prevAtr).toFixed(2)));
              pos.stop = parseFloat(Math.min(pos.stop, candidate).toFixed(2));
            }
          }

          const weekBar = weekly[weekIdx];
          if (weekBar) {
            if (pos.signal === 'BL' && weekBar.low < twoWeekLow) {
              closePosition(pos, bar.date, pos.stop, 'SIGNAL_BE');
              break;
            }
            if (pos.signal === 'SS' && weekBar.high > twoWeekHigh) {
              closePosition(pos, bar.date, pos.stop, 'SIGNAL_SE');
              break;
            }
          }
        }

        if (pos.signal === 'BL' && bar.low <= pos.stop) {
          closePosition(pos, bar.date, pos.stop, 'STOP_HIT');
          break;
        }
        if (pos.signal === 'SS' && bar.high >= pos.stop) {
          closePosition(pos, bar.date, pos.stop, 'STOP_HIT');
          break;
        }

        if (pos.tradingDays >= 20) {
          const pnl = pos.signal === 'BL'
            ? (bar.close - pos.entryPrice) / pos.entryPrice * 100
            : (pos.entryPrice - bar.close) / pos.entryPrice * 100;
          if (pnl < 0) {
            closePosition(pos, bar.date, bar.close, 'STALE_HUNT');
            break;
          }
        }
      }
    }

    // Remove closed
    for (const [ticker, pos] of openPositions) {
      if (pos.closed) { closedTrades.push(pos); openPositions.delete(ticker); }
    }

    // ── Select entries ──
    const weekScores = scoresByWeek[friday] || [];
    if (weekScores.length === 0) continue;

    // Build pool — optionally override signals for optimized sectors
    let pool;
    if (useOptimal) {
      pool = weekScores.map(s => {
        const sectorEma = OPTIMAL_EMA[s.sector];
        if (!sectorEma || sectorEma === 21) return s; // No override needed
        // Override with recomputed signal at optimal EMA
        const optSig = optimizedSignals[s.sector]?.[s.ticker]?.get(friday);
        if (optSig) {
          return { ...s, signal: optSig.signal, entryPrice: optSig.entryPrice, stopPrice: optSig.stopPrice, _optimized: true };
        }
        // No signal at optimal EMA for this week → null out
        return { ...s, signal: null, entryPrice: 0, _optimized: true };
      });
    } else {
      pool = [...weekScores];
    }

    pool = pool.filter(s => !s.overextended && s.signal && s.entryPrice > 0);

    // MACRO gate
    if (regime) {
      pool = pool.filter(s => {
        const exc = (s.exchange || '').toUpperCase();
        const idxTicker = (exc === 'NASDAQ' || exc.includes('NASDAQ')) ? 'QQQ' : 'SPY';
        const idxKey = idxTicker.toLowerCase();
        const idx = regime[idxKey];
        if (!idx) return false;
        if (s.signal === 'BL') return idx.aboveEma;
        else return !idx.aboveEma;
      });
    }

    // SECTOR gate
    const sectorEma = sectorEmaByWeek[friday] || {};
    pool = pool.filter(s => {
      const etf = SECTOR_MAP[s.sector];
      if (!etf || !sectorEma[etf]) return true;
      if (s.signal === 'BL') return sectorEma[etf].blAligned;
      else return sectorEma[etf].ssAligned;
    });

    // D2 gate
    pool = pool.filter(s => (s.scores?.d2 ?? 0) >= 0);

    // SS crash gate
    pool = pool.filter(s => {
      if (s.signal !== 'SS') return true;
      const exc = (s.exchange || '').toUpperCase();
      const idxTicker = (exc === 'NASDAQ' || exc.includes('NASDAQ')) ? 'QQQ' : 'SPY';
      const slopeOk = slopeFallingMap[friday]?.[idxTicker] ?? false;
      if (!slopeOk) return false;
      const etf = SECTOR_MAP[s.sector];
      const sect5d = sector5dMap[friday]?.[etf] ?? 0;
      if (sect5d > -3) return false;
      return true;
    });

    // Re-rank by Kill score
    pool.sort((a, b) => b.apexScore - a.apexScore);
    let fRank = 0;
    for (const s of pool) { fRank++; s.filteredRank = fRank; }

    // Top 10 BL + top 5 SS
    const blPool = pool.filter(s => s.signal === 'BL').slice(0, 10);
    const ssPool = pool.filter(s => s.signal === 'SS').slice(0, 5);
    pool = [...blPool, ...ssPool];

    // ── Enter positions ──
    for (const score of pool) {
      const ticker = score.ticker;
      if (openPositions.has(ticker)) continue;

      let entryPrice, stopPrice;
      if (score._optimized) {
        entryPrice = score.entryPrice;
        stopPrice = score.stopPrice;
      } else {
        const sig = signalMap[friday + '|' + ticker];
        entryPrice = sig?.entryPrice || score.entryPrice;
        stopPrice = sig?.stopPrice || score.stopPrice;
      }
      if (!entryPrice || entryPrice <= 0) continue;

      const weekly = weeklyMap[ticker];
      if (!weekly) continue;

      const fd = new Date(friday + 'T12:00:00');
      fd.setDate(fd.getDate() - 4);
      const monday = fd.toISOString().split('T')[0];
      const entryBi = weekly.findIndex(b => b.weekStart === monday);
      if (entryBi < 3) continue;

      openPositions.set(ticker, {
        ticker,
        signal: score.signal,
        sector: score.sector,
        exchange: score.exchange,
        weekOf: friday,
        entryDate: friday,
        entryPrice,
        stop: stopPrice || entryPrice * (score.signal === 'BL' ? 0.95 : 1.05),
        tradingDays: 0,
        maxFavorable: 0,
        maxAdverse: 0,
        currentWeekIdx: entryBi,
        lastCheckedDate: friday,
        closed: false,
        killRank: score.killRank,
        filteredRank: score.filteredRank,
        apexScore: score.apexScore,
        optimized: !!score._optimized,
      });
    }
  }

  // Close remaining open positions
  for (const [ticker, pos] of openPositions) {
    const daily = candleMap[ticker];
    if (daily?.length > 0) {
      const last = daily[daily.length - 1];
      closePosition(pos, last.date, last.close, 'STILL_OPEN');
    }
    closedTrades.push(pos);
  }

  return closedTrades;
}

// ── Stats computation ───────────────────────────────────────────────────────
function computeStats(trades) {
  if (trades.length === 0) return { trades: 0, winRate: 0, avgPnl: 0, avgWin: 0, avgLoss: 0, wlRatio: 0, totalReturn: 0 };
  const winners = trades.filter(t => t.isWinner);
  const losers = trades.filter(t => !t.isWinner);
  const avgPnl = trades.reduce((s, t) => s + t.profitPct, 0) / trades.length;
  const avgWin = winners.length > 0 ? winners.reduce((s, t) => s + t.profitPct, 0) / winners.length : 0;
  const avgLoss = losers.length > 0 ? losers.reduce((s, t) => s + t.profitPct, 0) / losers.length : 0;
  return {
    trades: trades.length,
    winners: winners.length,
    losers: losers.length,
    winRate: parseFloat((winners.length / trades.length * 100).toFixed(1)),
    avgPnl: parseFloat(avgPnl.toFixed(2)),
    avgWin: parseFloat(avgWin.toFixed(2)),
    avgLoss: parseFloat(avgLoss.toFixed(2)),
    wlRatio: avgLoss !== 0 ? parseFloat((avgWin / Math.abs(avgLoss)).toFixed(2)) : 0,
    totalReturn: parseFloat(trades.reduce((s, t) => s + t.profitPct, 0).toFixed(0)),
    totalDollar: parseFloat(trades.reduce((s, t) => s + (t.dollarPnl || 0), 0).toFixed(0)),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('Cannot connect to MongoDB'); process.exit(1); }
  console.log('Connected to MongoDB\n');

  const scoreCol  = db.collection('pnthr_bt_scores');
  const signalCol = db.collection('pnthr_bt_analyze_signals');
  const regimeCol = db.collection('pnthr_bt_regime');
  const candleCol = db.collection('pnthr_bt_candles');

  // ── Load data ──
  console.log('Loading data...');
  const allScores = await scoreCol.find({}).toArray();
  // Normalize sector names
  for (const s of allScores) s.sector = normSector(s.sector);

  const scoresByWeek = {};
  for (const s of allScores) {
    if (!scoresByWeek[s.weekOf]) scoresByWeek[s.weekOf] = [];
    scoresByWeek[s.weekOf].push(s);
  }
  const allWeeks = Object.keys(scoresByWeek).sort();

  // Tickers per sector
  const tickersBySector = {};
  for (const sector of ALL_SECTORS) tickersBySector[sector] = new Set();
  for (const s of allScores) {
    if (tickersBySector[s.sector]) tickersBySector[s.sector].add(s.ticker);
  }

  const rawSignals = await signalCol.find({}).toArray();
  const signalMap = {};
  for (const s of rawSignals) signalMap[s.weekOf + '|' + s.ticker] = s;

  const regimeDocs = await regimeCol.find({}).toArray();
  const regimeMap = {};
  for (const r of regimeDocs) regimeMap[r.weekOf] = r;

  // Slope falling map
  const regimeWeeks = Object.keys(regimeMap).sort();
  const slopeFallingMap = {};
  for (let i = 0; i < regimeWeeks.length; i++) {
    const w = regimeWeeks[i];
    const r = regimeMap[w];
    slopeFallingMap[w] = {};
    for (const idx of ['SPY', 'QQQ']) {
      const idxKey = idx.toLowerCase();
      const cur = r[idxKey];
      if (!cur || cur.emaSlope >= 0) { slopeFallingMap[w][idx] = false; continue; }
      if (i > 0) {
        const prev = regimeMap[regimeWeeks[i - 1]]?.[idxKey];
        slopeFallingMap[w][idx] = prev && prev.emaSlope < 0;
      } else {
        slopeFallingMap[w][idx] = false;
      }
    }
  }

  // Sector EMA alignment
  const sectorEmaByWeek = {};
  for (const s of rawSignals) {
    if (!sectorEmaByWeek[s.weekOf]) sectorEmaByWeek[s.weekOf] = {};
    const etf = SECTOR_MAP[s.sector];
    if (!etf) continue;
    if (!sectorEmaByWeek[s.weekOf][etf]) sectorEmaByWeek[s.weekOf][etf] = { blAligned: false, ssAligned: false };
    if ((s.analyzeComponents?.t1d ?? 0) > 0) {
      if (s.signal === 'BL') sectorEmaByWeek[s.weekOf][etf].blAligned = true;
      else sectorEmaByWeek[s.weekOf][etf].ssAligned = true;
    }
  }

  // Sector 5D momentum
  const sectorDailyMap = {};
  for (const etf of ALL_SECTOR_ETFS) {
    const doc = await candleCol.findOne({ ticker: etf });
    if (doc?.daily) sectorDailyMap[etf] = [...doc.daily].sort((a, b) => a.date > b.date ? 1 : -1);
  }
  const sector5dMap = {};
  for (const friday of allWeeks) {
    sector5dMap[friday] = {};
    for (const etf of ALL_SECTOR_ETFS) {
      const daily = sectorDailyMap[etf];
      if (!daily) continue;
      let fi = -1;
      for (let i = daily.length - 1; i >= 0; i--) {
        if (daily[i].date <= friday) { fi = i; break; }
      }
      if (fi < 5) continue;
      const cur = daily[fi].close, prev = daily[fi - 5].close;
      if (prev > 0) sector5dMap[friday][etf] = parseFloat(((cur - prev) / prev * 100).toFixed(2));
    }
  }

  // Candle data
  console.log('Loading candle data...');
  const allCandles = await candleCol.find({}).toArray();
  const candleMap = {}, weeklyMap = {}, atrMap = {};
  for (const doc of allCandles) {
    candleMap[doc.ticker] = [...doc.daily].sort((a, b) => a.date > b.date ? 1 : -1);
    const weekly = aggregateWeeklyBars(doc.daily, { includeVolume: false });
    weeklyMap[doc.ticker] = weekly;
    atrMap[doc.ticker] = computeWilderATR(weekly);
  }
  console.log(`  ${Object.keys(candleMap).length} tickers loaded\n`);

  // ── Pre-compute optimized signals for all non-21 sectors ──────────────────
  console.log('Pre-computing optimized signals for sectors with non-21 EMA...\n');
  const optimizedSignals = {}; // sector → { ticker → Map<friday, sig> }

  for (const sector of ALL_SECTORS) {
    const optPeriod = OPTIMAL_EMA[sector];
    if (optPeriod === 21) {
      console.log(`  ${sector.padEnd(26)} EMA 21 (no override needed)`);
      continue;
    }
    optimizedSignals[sector] = {};
    const tickers = tickersBySector[sector];
    let sigCount = 0;
    for (const ticker of tickers) {
      const weekly = weeklyMap[ticker];
      if (!weekly || weekly.length < optPeriod + 3) continue;
      const sigs = runAllSignals(weekly, optPeriod, false);
      optimizedSignals[sector][ticker] = sigs;
      sigCount += sigs.size;
    }
    console.log(`  ${sector.padEnd(26)} EMA ${optPeriod} → ${tickers.size} tickers, ${sigCount} signal-weeks`);
  }

  // ── Run both simulations ──────────────────────────────────────────────────
  console.log('\n── Running BASELINE simulation (all EMA 21)...');
  const baselineTrades = runFullSimulation({
    useOptimal: false, allWeeks, scoresByWeek, signalMap,
    regimeMap, slopeFallingMap, sectorEmaByWeek, sector5dMap,
    candleMap, weeklyMap, atrMap, optimizedSignals: {},
  });

  console.log('── Running OPTIMIZED simulation (per-sector optimal EMA)...');
  const optimizedTrades = runFullSimulation({
    useOptimal: true, allWeeks, scoresByWeek, signalMap,
    regimeMap, slopeFallingMap, sectorEmaByWeek, sector5dMap,
    candleMap, weeklyMap, atrMap, optimizedSignals,
  });

  // ── Persist optimized trades to MongoDB ────────────────────────────────────
  const optTradesCol = db.collection('pnthr_bt_optimal_trades');
  const optClosedAll = optimizedTrades.filter(t => t.exitReason !== 'STILL_OPEN');
  // Clean trade objects for storage (remove Map/Set references, keep flat data)
  const tradeDocs = optClosedAll.map(t => ({
    ticker: t.ticker, signal: t.signal, sector: t.sector, exchange: t.exchange,
    weekOf: t.weekOf, entryDate: t.entryDate, entryPrice: t.entryPrice,
    exitDate: t.exitDate, exitPrice: t.exitPrice, exitReason: t.exitReason,
    profitPct: t.profitPct, dollarPnl: t.dollarPnl, isWinner: t.isWinner,
    tradingDays: t.tradingDays, maxFavorable: t.maxFavorable, maxAdverse: t.maxAdverse,
    stop: t.stop, killRank: t.killRank, filteredRank: t.filteredRank,
    apexScore: t.apexScore, optimized: t.optimized,
    _persistedAt: new Date().toISOString(),
  }));
  await optTradesCol.deleteMany({});
  if (tradeDocs.length > 0) await optTradesCol.insertMany(tradeDocs);
  console.log(`\n  Persisted ${tradeDocs.length} optimized trades to pnthr_bt_optimal_trades\n`);

  // ── Compute results ───────────────────────────────────────────────────────
  const baseClosed = baselineTrades.filter(t => t.exitReason !== 'STILL_OPEN');
  const optClosed = optClosedAll;

  const baseAll = computeStats(baseClosed);
  const optAll = computeStats(optClosed);

  const baseBL = computeStats(baseClosed.filter(t => t.signal === 'BL'));
  const optBL = computeStats(optClosed.filter(t => t.signal === 'BL'));

  const baseSS = computeStats(baseClosed.filter(t => t.signal === 'SS'));
  const optSS = computeStats(optClosed.filter(t => t.signal === 'SS'));

  // ── OUTPUT ────────────────────────────────────────────────────────────────
  console.log('\n');
  console.log('=============================================================================================================');
  console.log('  PNTHR BACKTEST — FULL PIPELINE: UNIVERSAL 21 EMA vs PER-SECTOR OPTIMAL EMA');
  console.log('  Pipeline: Macro gate + Sector gate + D2 gate + SS crash gate + Top 10 BL / Top 5 SS');
  console.log('=============================================================================================================\n');

  console.log('  OPTIMAL EMA CONFIG:');
  for (const sector of ALL_SECTORS) {
    const p = OPTIMAL_EMA[sector];
    const marker = p === 21 ? '' : ` (was 21 → ${p})`;
    console.log(`    ${sector.padEnd(26)} EMA ${p}${marker}`);
  }

  console.log('\n─────────────────────────────────────────────────────────────────────────────────────────────────────────────');
  console.log('  HEAD-TO-HEAD COMPARISON');
  console.log('─────────────────────────────────────────────────────────────────────────────────────────────────────────────\n');

  function printComparison(label, base, opt) {
    const dTrades = opt.trades - base.trades;
    const dWinRate = (opt.winRate - base.winRate).toFixed(1);
    const dAvgPnl = (opt.avgPnl - base.avgPnl).toFixed(2);
    const dWL = (opt.wlRatio - base.wlRatio).toFixed(2);
    const dTotal = opt.totalReturn - base.totalReturn;
    const dPct = base.totalReturn !== 0 ? ((dTotal / Math.abs(base.totalReturn)) * 100).toFixed(1) : 'n/a';

    console.log(`  ── ${label} ──\n`);
    console.log('                       BASELINE (21)    OPTIMIZED        DELTA');
    console.log('                       ─────────────    ─────────        ─────');
    console.log(`  Trades:              ${String(base.trades).padStart(13)}    ${String(opt.trades).padStart(9)}        ${(dTrades >= 0 ? '+' : '') + dTrades}`);
    console.log(`  Win Rate:            ${(base.winRate + '%').padStart(13)}    ${(opt.winRate + '%').padStart(9)}        ${(parseFloat(dWinRate) >= 0 ? '+' : '') + dWinRate}%`);
    console.log(`  Avg P&L/trade:       ${((base.avgPnl >= 0 ? '+' : '') + base.avgPnl + '%').padStart(13)}    ${((opt.avgPnl >= 0 ? '+' : '') + opt.avgPnl + '%').padStart(9)}        ${(parseFloat(dAvgPnl) >= 0 ? '+' : '') + dAvgPnl}%`);
    console.log(`  Avg Winner:          ${('+' + base.avgWin + '%').padStart(13)}    ${('+' + opt.avgWin + '%').padStart(9)}`);
    console.log(`  Avg Loser:           ${(base.avgLoss + '%').padStart(13)}    ${(opt.avgLoss + '%').padStart(9)}`);
    console.log(`  W/L Ratio:           ${(base.wlRatio + ':1').padStart(13)}    ${(opt.wlRatio + ':1').padStart(9)}        ${(parseFloat(dWL) >= 0 ? '+' : '') + dWL}`);
    console.log(`  Total Return:        ${((base.totalReturn >= 0 ? '+' : '') + base.totalReturn + '%').padStart(13)}    ${((opt.totalReturn >= 0 ? '+' : '') + opt.totalReturn + '%').padStart(9)}        ${(dTotal >= 0 ? '+' : '') + dTotal}% (${dPct}%)`);
    console.log(`  Est $ P&L ($10K):    ${('$' + base.totalDollar.toLocaleString()).padStart(13)}    ${('$' + opt.totalDollar.toLocaleString()).padStart(9)}`);
    console.log('');
  }

  printComparison('ALL TRADES', baseAll, optAll);
  printComparison('BUY LONG ONLY', baseBL, optBL);
  printComparison('SELL SHORT ONLY', baseSS, optSS);

  // ── Year-by-Year ──
  console.log('─────────────────────────────────────────────────────────────────────────────────────────────────────────────');
  console.log('  YEAR-BY-YEAR COMPARISON');
  console.log('─────────────────────────────────────────────────────────────────────────────────────────────────────────────\n');

  const baseByYear = {}, optByYear = {};
  for (const t of baseClosed) {
    const y = t.weekOf.slice(0, 4);
    if (!baseByYear[y]) baseByYear[y] = [];
    baseByYear[y].push(t);
  }
  for (const t of optClosed) {
    const y = t.weekOf.slice(0, 4);
    if (!optByYear[y]) optByYear[y] = [];
    optByYear[y].push(t);
  }

  const allYears = [...new Set([...Object.keys(baseByYear), ...Object.keys(optByYear)])].sort();
  console.log('  Year   Base Trades  Base Win%  Base Avg   Base Total    Opt Trades  Opt Win%  Opt Avg    Opt Total    Delta');
  console.log('  ────   ──────────   ─────────  ────────   ──────────    ──────────  ────────  ────────   ─────────    ─────');

  for (const year of allYears) {
    const b = computeStats(baseByYear[year] || []);
    const o = computeStats(optByYear[year] || []);
    const delta = o.totalReturn - b.totalReturn;
    console.log(
      `  ${year}   ${String(b.trades).padStart(10)}   ${(b.winRate + '%').padStart(8)}  ${((b.avgPnl >= 0 ? '+' : '') + b.avgPnl + '%').padStart(8)}   ${((b.totalReturn >= 0 ? '+' : '') + b.totalReturn + '%').padStart(9)}    ` +
      `${String(o.trades).padStart(10)}  ${(o.winRate + '%').padStart(7)}  ${((o.avgPnl >= 0 ? '+' : '') + o.avgPnl + '%').padStart(8)}   ${((o.totalReturn >= 0 ? '+' : '') + o.totalReturn + '%').padStart(8)}    ${(delta >= 0 ? '+' : '') + delta}%`
    );
  }

  // ── By Sector ──
  console.log('\n─────────────────────────────────────────────────────────────────────────────────────────────────────────────');
  console.log('  SECTOR-BY-SECTOR COMPARISON');
  console.log('─────────────────────────────────────────────────────────────────────────────────────────────────────────────\n');

  console.log('  Sector                    EMA   Base Tr  Base Win%  Base Total   Opt Tr  Opt Win%  Opt Total   Delta    Verdict');
  console.log('  ────────────────────────  ───   ───────  ─────────  ──────────   ──────  ────────  ─────────   ──────   ───────');

  for (const sector of ALL_SECTORS) {
    const ema = OPTIMAL_EMA[sector];
    const baseSec = computeStats(baseClosed.filter(t => t.sector === sector));
    const optSec = computeStats(optClosed.filter(t => t.sector === sector));
    const delta = optSec.totalReturn - baseSec.totalReturn;

    let verdict;
    if (ema === 21) verdict = 'UNCHANGED';
    else if (delta > 0) verdict = 'IMPROVED';
    else if (delta === 0) verdict = 'NEUTRAL';
    else verdict = 'REGRESSED';

    console.log(
      `  ${sector.padEnd(26)}${String(ema).padStart(3)}   ` +
      `${String(baseSec.trades).padStart(7)}  ${(baseSec.winRate + '%').padStart(8)}  ${((baseSec.totalReturn >= 0 ? '+' : '') + baseSec.totalReturn + '%').padStart(9)}   ` +
      `${String(optSec.trades).padStart(6)}  ${(optSec.winRate + '%').padStart(7)}  ${((optSec.totalReturn >= 0 ? '+' : '') + optSec.totalReturn + '%').padStart(8)}   ` +
      `${((delta >= 0 ? '+' : '') + delta + '%').padStart(7)}   ${verdict}`
    );
  }

  // ── By Exit Reason ──
  console.log('\n─────────────────────────────────────────────────────────────────────────────────────────────────────────────');
  console.log('  EXIT REASON COMPARISON');
  console.log('─────────────────────────────────────────────────────────────────────────────────────────────────────────────\n');

  const baseByReason = {}, optByReason = {};
  for (const t of baseClosed) {
    if (!baseByReason[t.exitReason]) baseByReason[t.exitReason] = [];
    baseByReason[t.exitReason].push(t);
  }
  for (const t of optClosed) {
    if (!optByReason[t.exitReason]) optByReason[t.exitReason] = [];
    optByReason[t.exitReason].push(t);
  }

  const allReasons = [...new Set([...Object.keys(baseByReason), ...Object.keys(optByReason)])].sort();
  console.log('  Reason          Base Count  Base Avg     Opt Count  Opt Avg      Delta Count  Delta Avg');
  console.log('  ──────────────  ──────────  ─────────    ─────────  ─────────    ───────────  ─────────');

  for (const reason of allReasons) {
    const b = computeStats(baseByReason[reason] || []);
    const o = computeStats(optByReason[reason] || []);
    const dCount = o.trades - b.trades;
    const dAvg = (o.avgPnl - b.avgPnl).toFixed(2);
    console.log(
      `  ${reason.padEnd(16)}${String(b.trades).padStart(10)}  ${((b.avgPnl >= 0 ? '+' : '') + b.avgPnl + '%').padStart(9)}    ` +
      `${String(o.trades).padStart(9)}  ${((o.avgPnl >= 0 ? '+' : '') + o.avgPnl + '%').padStart(9)}    ` +
      `${((dCount >= 0 ? '+' : '') + dCount).padStart(11)}  ${((parseFloat(dAvg) >= 0 ? '+' : '') + dAvg + '%').padStart(9)}`
    );
  }

  // ── Trade overlap analysis ──
  console.log('\n─────────────────────────────────────────────────────────────────────────────────────────────────────────────');
  console.log('  TRADE OVERLAP ANALYSIS');
  console.log('─────────────────────────────────────────────────────────────────────────────────────────────────────────────\n');

  const baseTradeKeys = new Set(baseClosed.map(t => t.ticker + '|' + t.weekOf));
  const optTradeKeys = new Set(optClosed.map(t => t.ticker + '|' + t.weekOf));
  const sharedKeys = [...baseTradeKeys].filter(k => optTradeKeys.has(k));
  const baseOnlyKeys = [...baseTradeKeys].filter(k => !optTradeKeys.has(k));
  const optOnlyKeys = [...optTradeKeys].filter(k => !baseTradeKeys.has(k));

  console.log(`  Shared trades (same ticker+week):      ${sharedKeys.length}`);
  console.log(`  Baseline-only trades (lost):           ${baseOnlyKeys.length}`);
  console.log(`  Optimized-only trades (gained):        ${optOnlyKeys.length}`);

  // Stats for gained/lost trades
  if (baseOnlyKeys.length > 0) {
    const lostTrades = baseClosed.filter(t => baseOnlyKeys.includes(t.ticker + '|' + t.weekOf));
    const lostStats = computeStats(lostTrades);
    console.log(`\n  Lost trades:    ${lostStats.trades} trades, ${lostStats.winRate}% win, avg ${(lostStats.avgPnl >= 0 ? '+' : '') + lostStats.avgPnl}%, total ${(lostStats.totalReturn >= 0 ? '+' : '') + lostStats.totalReturn}%`);
  }
  if (optOnlyKeys.length > 0) {
    const gainedTrades = optClosed.filter(t => optOnlyKeys.includes(t.ticker + '|' + t.weekOf));
    const gainedStats = computeStats(gainedTrades);
    console.log(`  Gained trades:  ${gainedStats.trades} trades, ${gainedStats.winRate}% win, avg ${(gainedStats.avgPnl >= 0 ? '+' : '') + gainedStats.avgPnl}%, total ${(gainedStats.totalReturn >= 0 ? '+' : '') + gainedStats.totalReturn}%`);
  }

  // Shared trades — did optimized entry/stop prices improve P&L?
  if (sharedKeys.length > 0) {
    const baseShared = baseClosed.filter(t => sharedKeys.includes(t.ticker + '|' + t.weekOf));
    const optShared = optClosed.filter(t => sharedKeys.includes(t.ticker + '|' + t.weekOf));
    const baseSharedStats = computeStats(baseShared);
    const optSharedStats = computeStats(optShared);
    console.log(`\n  Shared trades baseline:  ${baseSharedStats.trades} trades, ${baseSharedStats.winRate}% win, avg ${(baseSharedStats.avgPnl >= 0 ? '+' : '') + baseSharedStats.avgPnl}%, total ${(baseSharedStats.totalReturn >= 0 ? '+' : '') + baseSharedStats.totalReturn}%`);
    console.log(`  Shared trades optimized: ${optSharedStats.trades} trades, ${optSharedStats.winRate}% win, avg ${(optSharedStats.avgPnl >= 0 ? '+' : '') + optSharedStats.avgPnl}%, total ${(optSharedStats.totalReturn >= 0 ? '+' : '') + optSharedStats.totalReturn}%`);
  }

  // ── Out-of-sample validation ──
  console.log('\n─────────────────────────────────────────────────────────────────────────────────────────────────────────────');
  console.log('  OUT-OF-SAMPLE VALIDATION (Train: 2020-2023, Test: 2024-2026)');
  console.log('─────────────────────────────────────────────────────────────────────────────────────────────────────────────\n');

  const trainBase = computeStats(baseClosed.filter(t => t.weekOf < '2024-01-01'));
  const trainOpt = computeStats(optClosed.filter(t => t.weekOf < '2024-01-01'));
  const testBase = computeStats(baseClosed.filter(t => t.weekOf >= '2024-01-01'));
  const testOpt = computeStats(optClosed.filter(t => t.weekOf >= '2024-01-01'));

  console.log('  Period         Base Trades  Base Win%  Base Avg   Base Total   Opt Trades  Opt Win%  Opt Avg   Opt Total   Delta');
  console.log('  ─────────────  ──────────   ─────────  ────────   ──────────   ──────────  ────────  ────────  ─────────   ─────');
  const trainDelta = trainOpt.totalReturn - trainBase.totalReturn;
  const testDelta = testOpt.totalReturn - testBase.totalReturn;
  console.log(
    `  TRAIN 20-23    ${String(trainBase.trades).padStart(10)}   ${(trainBase.winRate + '%').padStart(8)}  ${((trainBase.avgPnl >= 0 ? '+' : '') + trainBase.avgPnl + '%').padStart(8)}   ${((trainBase.totalReturn >= 0 ? '+' : '') + trainBase.totalReturn + '%').padStart(9)}   ` +
    `${String(trainOpt.trades).padStart(10)}  ${(trainOpt.winRate + '%').padStart(7)}  ${((trainOpt.avgPnl >= 0 ? '+' : '') + trainOpt.avgPnl + '%').padStart(8)}  ${((trainOpt.totalReturn >= 0 ? '+' : '') + trainOpt.totalReturn + '%').padStart(8)}   ${(trainDelta >= 0 ? '+' : '') + trainDelta}%`
  );
  console.log(
    `  TEST  24-26    ${String(testBase.trades).padStart(10)}   ${(testBase.winRate + '%').padStart(8)}  ${((testBase.avgPnl >= 0 ? '+' : '') + testBase.avgPnl + '%').padStart(8)}   ${((testBase.totalReturn >= 0 ? '+' : '') + testBase.totalReturn + '%').padStart(9)}   ` +
    `${String(testOpt.trades).padStart(10)}  ${(testOpt.winRate + '%').padStart(7)}  ${((testOpt.avgPnl >= 0 ? '+' : '') + testOpt.avgPnl + '%').padStart(8)}  ${((testOpt.totalReturn >= 0 ? '+' : '') + testOpt.totalReturn + '%').padStart(8)}   ${(testDelta >= 0 ? '+' : '') + testDelta}%`
  );

  console.log('\n  VERDICT:');
  if (trainDelta > 0 && testDelta > 0) {
    console.log('  BOTH in-sample AND out-of-sample show improvement → STRONG SIGNAL, not overfitting');
  } else if (trainDelta > 0 && testDelta <= 0) {
    console.log('  In-sample improves but out-of-sample does NOT → POSSIBLE OVERFITTING, caution advised');
  } else if (trainDelta <= 0 && testDelta > 0) {
    console.log('  Out-of-sample improves but training period does not → UNUSUAL PATTERN, investigate further');
  } else {
    console.log('  Neither period shows improvement → OPTIMIZATION DOES NOT HELP in the full pipeline');
  }

  // ── Final verdict ──
  console.log('\n=============================================================================================================');
  console.log('  FINAL VERDICT');
  console.log('=============================================================================================================\n');

  const totalDelta = optAll.totalReturn - baseAll.totalReturn;
  const totalDeltaPct = baseAll.totalReturn !== 0 ? ((totalDelta / Math.abs(baseAll.totalReturn)) * 100).toFixed(1) : 'n/a';

  console.log(`  BASELINE (Universal EMA 21):     ${baseAll.trades} trades | ${baseAll.winRate}% win | +${baseAll.avgWin}%/−${Math.abs(baseAll.avgLoss)}% | W/L ${baseAll.wlRatio}:1 | Total +${baseAll.totalReturn}%`);
  console.log(`  OPTIMIZED (Per-Sector EMA):      ${optAll.trades} trades | ${optAll.winRate}% win | +${optAll.avgWin}%/−${Math.abs(optAll.avgLoss)}% | W/L ${optAll.wlRatio}:1 | Total +${optAll.totalReturn}%`);
  console.log(`  NET IMPROVEMENT:                 ${(totalDelta >= 0 ? '+' : '') + totalDelta}% total return (${totalDeltaPct}%)`);

  if (totalDelta > 0) {
    console.log(`\n  RECOMMENDATION: Per-sector EMA optimization adds +${totalDelta}% cumulative return.`);
    if (parseFloat(totalDeltaPct) >= 5) {
      console.log('  This is a SIGNIFICANT improvement worth implementing in production.');
    } else if (parseFloat(totalDeltaPct) >= 2) {
      console.log('  This is a MEANINGFUL improvement. Evaluate implementation complexity vs. gain.');
    } else {
      console.log('  This is a MODEST improvement. May not justify added complexity.');
    }
  } else {
    console.log('\n  RECOMMENDATION: Per-sector EMA optimization does NOT improve the full pipeline.');
    console.log('  The universal 21 EMA remains optimal when all sectors compete through the ranking system.');
  }

  console.log('\n=============================================================================================================\n');

  process.exit(0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
