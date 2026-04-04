// server/backtest/simulateAsymmetricGates.js
// ── Backtest #1+#2: Asymmetric BL/SS Entry Criteria + D2 Hard Gate ──────────
//
// Tests progressively stricter filter combinations:
//   - D2 hard gate (D2 < 0 = blocked)
//   - Macro alignment (index EMA direction)
//   - Sector alignment (sector ETF EMA direction)
//   - Asymmetric SS requirements (stricter macro/sector/Kill/Analyze for shorts)
//   - Combined "best of" configurations
//
// Reads: pnthr_bt_analyze_signals, pnthr_bt_scores, pnthr_bt_regime, pnthr_bt_candles
// Writes: pnthr_bt_asymmetric_results
//
// Usage:  cd server && node backtest/simulateAsymmetricGates.js
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { connectToDatabase } from '../database.js';
import { aggregateWeeklyBars, computeEMA21series } from '../technicalUtils.js';
import { computeWilderATR, blInitStop, ssInitStop } from '../stopCalculation.js';

const ALL_SECTOR_ETFS = ['XLK', 'XLE', 'XLV', 'XLF', 'XLY', 'XLC', 'XLI', 'XLB', 'XLRE', 'XLU', 'XLP'];
const SECTOR_MAP = {
  'Technology': 'XLK', 'Energy': 'XLE', 'Healthcare': 'XLV', 'Health Care': 'XLV',
  'Financial Services': 'XLF', 'Financials': 'XLF', 'Consumer Discretionary': 'XLY',
  'Communication Services': 'XLC', 'Industrials': 'XLI', 'Basic Materials': 'XLB',
  'Materials': 'XLB', 'Real Estate': 'XLRE', 'Utilities': 'XLU', 'Consumer Staples': 'XLP',
};

// ── Trade close helper ──────────────────────────────────────────────────────

function closePosition(pos, exitDate, exitPrice, exitReason) {
  pos.exitDate = exitDate;
  pos.exitPrice = exitPrice;
  pos.exitReason = exitReason;
  if (pos.signal === 'BL') {
    pos.profitPct = parseFloat(((exitPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(2));
  } else {
    pos.profitPct = parseFloat(((pos.entryPrice - exitPrice) / pos.entryPrice * 100).toFixed(2));
  }
  pos.isWinner = pos.profitPct > 0;
  pos.closed = true;
}

// ── Filter Configurations ───────────────────────────────────────────────────
// Each config defines entry criteria for BL and SS independently.

function defineConfigs() {
  return [
    // ── Baselines ──
    {
      name: 'BASELINE',
      desc: 'All signals, signal entry, no filters',
      bl: {}, ss: {},
    },
    {
      name: 'D2_GATE',
      desc: 'D2 >= 0 required (sector not fighting you)',
      bl: { d2Min: 0 }, ss: { d2Min: 0 },
    },
    {
      name: 'MACRO_GATE',
      desc: 'Index EMA alignment required',
      bl: { macroAligned: true }, ss: { macroAligned: true },
    },
    {
      name: 'SECTOR_GATE',
      desc: 'Sector ETF EMA alignment required',
      bl: { sectorAligned: true }, ss: { sectorAligned: true },
    },
    {
      name: 'D2_MACRO',
      desc: 'D2 >= 0 + macro alignment',
      bl: { d2Min: 0, macroAligned: true }, ss: { d2Min: 0, macroAligned: true },
    },
    {
      name: 'D2_MACRO_SECTOR',
      desc: 'D2 >= 0 + macro + sector alignment',
      bl: { d2Min: 0, macroAligned: true, sectorAligned: true },
      ss: { d2Min: 0, macroAligned: true, sectorAligned: true },
    },

    // ── Symmetric with Kill/Analyze ──
    {
      name: 'FULL_SYM_TOP10',
      desc: 'D2 + macro + sector + Kill top 10',
      bl: { d2Min: 0, macroAligned: true, sectorAligned: true, maxKillRank: 10 },
      ss: { d2Min: 0, macroAligned: true, sectorAligned: true, maxKillRank: 10 },
    },
    {
      name: 'FULL_SYM_ANA70',
      desc: 'D2 + macro + sector + Analyze >= 70%',
      bl: { d2Min: 0, macroAligned: true, sectorAligned: true, minAnalyze: 70 },
      ss: { d2Min: 0, macroAligned: true, sectorAligned: true, minAnalyze: 70 },
    },
    {
      name: 'FULL_SYM_TOP10_ANA70',
      desc: 'D2 + macro + sector + Kill top 10 + Analyze >= 70%',
      bl: { d2Min: 0, macroAligned: true, sectorAligned: true, maxKillRank: 10, minAnalyze: 70 },
      ss: { d2Min: 0, macroAligned: true, sectorAligned: true, maxKillRank: 10, minAnalyze: 70 },
    },

    // ── Asymmetric: tighter SS ──
    {
      name: 'ASYM_SS_SLOPE',
      desc: 'Symmetric BL + SS needs macro slope falling 2+ wks',
      bl: { d2Min: 0, macroAligned: true, sectorAligned: true },
      ss: { d2Min: 0, macroAligned: true, sectorAligned: true, macroSlopeFalling: true },
    },
    {
      name: 'ASYM_SS_SECT5D',
      desc: 'Symmetric BL + SS needs sector 5D momentum < -1%',
      bl: { d2Min: 0, macroAligned: true, sectorAligned: true },
      ss: { d2Min: 0, macroAligned: true, sectorAligned: true, sectorMomentumMax: -1 },
    },
    {
      name: 'ASYM_SS_STRICT',
      desc: 'Symmetric BL + SS needs slope falling + sector 5D < -1%',
      bl: { d2Min: 0, macroAligned: true, sectorAligned: true },
      ss: { d2Min: 0, macroAligned: true, sectorAligned: true, macroSlopeFalling: true, sectorMomentumMax: -1 },
    },
    {
      name: 'ASYM_SS_TOP5',
      desc: 'Symmetric BL (top 10) + SS must be top 5',
      bl: { d2Min: 0, macroAligned: true, sectorAligned: true, maxKillRank: 10 },
      ss: { d2Min: 0, macroAligned: true, sectorAligned: true, maxKillRank: 5 },
    },
    {
      name: 'ASYM_SS_ANA85',
      desc: 'BL Analyze >= 70% + SS Analyze >= 85%',
      bl: { d2Min: 0, macroAligned: true, sectorAligned: true, minAnalyze: 70 },
      ss: { d2Min: 0, macroAligned: true, sectorAligned: true, minAnalyze: 85 },
    },

    // ── Full asymmetric combos ──
    {
      name: 'FULL_ASYM_A',
      desc: 'BL: D2+macro+sector+top10+ana70 | SS: +slope+sect5D+top5+ana85',
      bl: { d2Min: 0, macroAligned: true, sectorAligned: true, maxKillRank: 10, minAnalyze: 70 },
      ss: { d2Min: 0, macroAligned: true, sectorAligned: true, macroSlopeFalling: true, sectorMomentumMax: -1, maxKillRank: 5, minAnalyze: 85 },
    },
    {
      name: 'FULL_ASYM_B',
      desc: 'BL: D2+macro+sector+top10+ana80 | SS: +slope+sect5D+top5+ana90',
      bl: { d2Min: 0, macroAligned: true, sectorAligned: true, maxKillRank: 10, minAnalyze: 80 },
      ss: { d2Min: 0, macroAligned: true, sectorAligned: true, macroSlopeFalling: true, sectorMomentumMax: -1, maxKillRank: 5, minAnalyze: 90 },
    },
    {
      name: 'FULL_ASYM_C',
      desc: 'BL: D2+macro+sector+ana70 | SS: +slope+sect5D+ana85 (no rank gate)',
      bl: { d2Min: 0, macroAligned: true, sectorAligned: true, minAnalyze: 70 },
      ss: { d2Min: 0, macroAligned: true, sectorAligned: true, macroSlopeFalling: true, sectorMomentumMax: -1, minAnalyze: 85 },
    },

    // ── BL-only (drop SS entirely) ──
    {
      name: 'BL_ONLY_FULL',
      desc: 'BL only: D2+macro+sector+top10+ana70, zero SS',
      bl: { d2Min: 0, macroAligned: true, sectorAligned: true, maxKillRank: 10, minAnalyze: 70 },
      ss: { blocked: true },
    },
    {
      name: 'BL_ONLY_LOOSE',
      desc: 'BL only: D2+macro+sector, zero SS',
      bl: { d2Min: 0, macroAligned: true, sectorAligned: true },
      ss: { blocked: true },
    },

    // ── SS crash mode (extreme conditions only) ──
    {
      name: 'SS_CRASH_MODE',
      desc: 'BL: full sym | SS: sector 5D < -3% + macro slope falling + top 5',
      bl: { d2Min: 0, macroAligned: true, sectorAligned: true, maxKillRank: 10, minAnalyze: 70 },
      ss: { d2Min: 0, macroAligned: true, sectorAligned: true, macroSlopeFalling: true, sectorMomentumMax: -3, maxKillRank: 5, minAnalyze: 85 },
    },
  ];
}

// ── Signal passes filter? ───────────────────────────────────────────────────

function passesFilter(signal, filter) {
  if (filter.blocked) return false;
  if (filter.d2Min != null && (signal.d2 == null || signal.d2 < filter.d2Min)) return false;
  if (filter.macroAligned && !signal.macroAligned) return false;
  if (filter.sectorAligned && !signal.sectorAligned) return false;
  if (filter.macroSlopeFalling && !signal.macroSlopeFalling) return false;
  if (filter.sectorMomentumMax != null && (signal.sector5dMomentum == null || signal.sector5dMomentum > filter.sectorMomentumMax)) return false;
  if (filter.maxKillRank != null && (signal.killRank == null || signal.killRank > filter.maxKillRank)) return false;
  if (filter.minAnalyze != null && (signal.analyzePct == null || signal.analyzePct < filter.minAnalyze)) return false;
  return true;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('Cannot connect to MongoDB'); process.exit(1); }

  const signalCol = db.collection('pnthr_bt_analyze_signals');
  const scoreCol  = db.collection('pnthr_bt_scores');
  const regimeCol = db.collection('pnthr_bt_regime');
  const candleCol = db.collection('pnthr_bt_candles');
  const resultCol = db.collection('pnthr_bt_asymmetric_results');

  await resultCol.deleteMany({});
  await resultCol.createIndex({ config: 1 }, { unique: true });

  // ── Load signals ──────────────────────────────────────────────────────────
  console.log('Loading signal data...');
  const rawSignals = await signalCol.find({}).toArray();
  console.log(`  ${rawSignals.length} signals loaded`);

  // ── Load D2 scores from bt_scores ─────────────────────────────────────────
  console.log('Loading Kill scores for D2...');
  const allScores = await scoreCol.find({}, {
    projection: { weekOf: 1, ticker: 1, 'scores.d2': 1 }
  }).toArray();
  const d2Map = {};
  for (const s of allScores) {
    d2Map[s.weekOf + '|' + s.ticker] = s.scores?.d2 ?? null;
  }
  console.log(`  ${allScores.length} score records → D2 map built`);

  // ── Load regime data ──────────────────────────────────────────────────────
  console.log('Loading regime data...');
  const regimeDocs = await regimeCol.find({}).toArray();
  const regimeMap = {};
  for (const r of regimeDocs) regimeMap[r.weekOf] = r;
  console.log(`  ${regimeDocs.length} regime weeks`);

  // Build index EMA slope history for "falling 2+ weeks" check
  const regimeWeeks = Object.keys(regimeMap).sort();
  const slopeFallingMap = {}; // weekOf → { SPY: bool, QQQ: bool }
  for (let i = 0; i < regimeWeeks.length; i++) {
    const w = regimeWeeks[i];
    const r = regimeMap[w];
    slopeFallingMap[w] = {};
    for (const idx of ['SPY', 'QQQ']) {
      const idxKey = idx.toLowerCase();
      const cur = r[idxKey];
      if (!cur) { slopeFallingMap[w][idx] = false; continue; }
      // Current slope must be negative
      if (cur.emaSlope >= 0) { slopeFallingMap[w][idx] = false; continue; }
      // Previous week slope must also be negative
      if (i > 0) {
        const prevR = regimeMap[regimeWeeks[i - 1]];
        const prev = prevR?.[idxKey];
        slopeFallingMap[w][idx] = prev && prev.emaSlope < 0;
      } else {
        slopeFallingMap[w][idx] = false;
      }
    }
  }

  // ── Compute sector 5D momentum from daily candles ─────────────────────────
  console.log('Computing sector 5D momentum...');
  const sectorDailyMap = {};
  for (const etf of ALL_SECTOR_ETFS) {
    const doc = await candleCol.findOne({ ticker: etf });
    if (doc?.daily) {
      sectorDailyMap[etf] = [...doc.daily].sort((a, b) => a.date > b.date ? 1 : -1);
    }
  }

  // Build sector 5D momentum lookup: weekOf → etf → 5D return %
  const sector5dMap = {}; // weekOf → { XLK: -1.5, ... }
  for (const friday of regimeWeeks) {
    sector5dMap[friday] = {};
    for (const etf of ALL_SECTOR_ETFS) {
      const daily = sectorDailyMap[etf];
      if (!daily) continue;
      // Find the bar on or before this Friday
      let fridayIdx = -1;
      for (let i = daily.length - 1; i >= 0; i--) {
        if (daily[i].date <= friday) { fridayIdx = i; break; }
      }
      if (fridayIdx < 5) continue;
      const fridayClose = daily[fridayIdx].close;
      const fiveDayAgoClose = daily[fridayIdx - 5].close;
      if (fiveDayAgoClose > 0) {
        sector5dMap[friday][etf] = parseFloat(((fridayClose - fiveDayAgoClose) / fiveDayAgoClose * 100).toFixed(2));
      }
    }
  }
  console.log(`  Sector 5D momentum computed for ${regimeWeeks.length} weeks\n`);

  // ── Also load weekly bars + ATR for trade simulation ──────────────────────
  console.log('Loading candle data for trade simulation...');
  const allCandles = await candleCol.find({}).toArray();
  const candleMap = {}, weeklyMap = {}, atrMap = {};
  for (const doc of allCandles) {
    candleMap[doc.ticker] = [...doc.daily].sort((a, b) => a.date > b.date ? 1 : -1);
    const weekly = aggregateWeeklyBars(doc.daily, { includeVolume: false });
    weeklyMap[doc.ticker] = weekly;
    atrMap[doc.ticker] = computeWilderATR(weekly);
  }
  console.log(`  ${Object.keys(candleMap).length} tickers loaded\n`);

  // ── Enrich signals with gate fields ───────────────────────────────────────
  console.log('Enriching signals with gate fields...');
  const signals = [];
  let enriched = 0;

  for (const sig of rawSignals) {
    const key = sig.weekOf + '|' + sig.ticker;
    const d2 = d2Map[key] ?? null;
    const regime = regimeMap[sig.weekOf];

    // Macro alignment
    const exc = (sig.exchange || '').toUpperCase();
    const idxTicker = (exc === 'NASDAQ' || exc.includes('NASDAQ')) ? 'QQQ' : 'SPY';
    const idxKey = idxTicker.toLowerCase();
    const idxState = regime?.[idxKey];
    const macroAligned = idxState
      ? (sig.signal === 'BL' ? idxState.aboveEma : !idxState.aboveEma)
      : false;

    // Macro slope falling 2+ weeks (for SS strict gate)
    const slopeData = slopeFallingMap[sig.weekOf];
    const macroSlopeFalling = slopeData?.[idxTicker] ?? false;

    // Sector alignment
    const sectorEtf = SECTOR_MAP[sig.sector];
    let sectorAligned = false;
    if (sectorEtf && regime) {
      // We need sector EMA state — derive from sector 5D or compute from weekly
      // For alignment, check if sector ETF close > its 21W EMA
      // Use the analyzeComponents.t1d as proxy: 7 = aligned, 0 = not
      sectorAligned = (sig.analyzeComponents?.t1d ?? 0) > 0;
    }

    // Sector 5D momentum
    const sector5d = sector5dMap[sig.weekOf]?.[sectorEtf] ?? null;

    signals.push({
      ...sig,
      d2,
      macroAligned,
      macroSlopeFalling,
      sectorAligned,
      sector5dMomentum: sector5d,
    });
    enriched++;
  }
  console.log(`  Enriched ${enriched} signals\n`);

  // ── Sort signals chronologically ──────────────────────────────────────────
  signals.sort((a, b) => a.weekOf < b.weekOf ? -1 : a.weekOf > b.weekOf ? 1 : 0);
  const allFridays = [...new Set(signals.map(s => s.weekOf))].sort();

  // ── Run each configuration ────────────────────────────────────────────────
  const configs = defineConfigs();
  const allConfigResults = [];

  for (const config of configs) {
    process.stdout.write(`\n  Running ${config.name}...`);

    const openPositions = new Map();
    const closedTrades = [];

    for (let fi = 0; fi < allFridays.length; fi++) {
      const friday = allFridays[fi];

      // ── Exit checks on open positions ──
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

          // MFE/MAE
          if (pos.signal === 'BL') {
            pos.maxFavorable = Math.max(pos.maxFavorable, (bar.high - pos.entryPrice) / pos.entryPrice * 100);
            pos.maxAdverse = Math.min(pos.maxAdverse, (bar.low - pos.entryPrice) / pos.entryPrice * 100);
          } else {
            pos.maxFavorable = Math.max(pos.maxFavorable, (pos.entryPrice - bar.low) / pos.entryPrice * 100);
            pos.maxAdverse = Math.min(pos.maxAdverse, (pos.entryPrice - bar.high) / pos.entryPrice * 100);
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
                const structStop = parseFloat((twoWeekLow - 0.01).toFixed(2));
                const atrFloor = parseFloat((prev1.close - prevAtr).toFixed(2));
                const candidate = Math.max(structStop, atrFloor);
                pos.stop = parseFloat(Math.max(pos.stop, candidate).toFixed(2));
              } else {
                const structStop = parseFloat((twoWeekHigh + 0.01).toFixed(2));
                const atrCeiling = parseFloat((prev1.close + prevAtr).toFixed(2));
                const candidate = Math.min(structStop, atrCeiling);
                pos.stop = parseFloat(Math.min(pos.stop, candidate).toFixed(2));
              }
            }

            // BE/SE structural exit
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

          // Daily stop hit
          if (pos.signal === 'BL' && bar.low <= pos.stop) {
            closePosition(pos, bar.date, pos.stop, 'STOP_HIT');
            break;
          }
          if (pos.signal === 'SS' && bar.high >= pos.stop) {
            closePosition(pos, bar.date, pos.stop, 'STOP_HIT');
            break;
          }

          // 20-day unprofitable
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

      // ── Enter new signals that pass this config's filters ──
      const weekSignals = signals.filter(s => s.weekOf === friday);

      for (const sig of weekSignals) {
        if (openPositions.has(sig.ticker)) continue;
        if (!sig.entryPrice || sig.entryPrice <= 0) continue;
        if (sig.overextended) continue;

        // Apply filter based on direction
        const filter = sig.signal === 'BL' ? config.bl : config.ss;
        if (!passesFilter(sig, filter)) continue;

        const weekly = weeklyMap[sig.ticker];
        if (!weekly) continue;

        // Find weekly bar index for entry
        const fd = new Date(sig.weekOf + 'T12:00:00');
        fd.setDate(fd.getDate() - 4);
        const monday = fd.toISOString().split('T')[0];
        const entryBi = weekly.findIndex(b => b.weekStart === monday);
        if (entryBi < 3) continue;

        openPositions.set(sig.ticker, {
          ticker: sig.ticker,
          signal: sig.signal,
          weekOf: sig.weekOf,
          entryDate: sig.weekOf,
          entryPrice: sig.entryPrice,
          stop: sig.stopPrice,
          tradingDays: 0,
          maxFavorable: 0,
          maxAdverse: 0,
          currentWeekIdx: entryBi,
          lastCheckedDate: sig.weekOf,
          closed: false,
          analyzePct: sig.analyzePct,
          killRank: sig.killRank,
          killConfirmed: sig.killConfirmed,
          d2: sig.d2,
          sector: sig.sector,
          exchange: sig.exchange,
        });
      }
    }

    // Close remaining at last price
    for (const [ticker, pos] of openPositions) {
      const daily = candleMap[ticker];
      if (daily?.length > 0) {
        closePosition(pos, daily[daily.length - 1].date, daily[daily.length - 1].close, 'STILL_OPEN');
      }
      closedTrades.push(pos);
    }

    // ── Compute results ──
    const closed = closedTrades.filter(t => t.exitReason !== 'STILL_OPEN');
    const winners = closed.filter(t => t.isWinner);
    const losers = closed.filter(t => !t.isWinner);
    const avgPnl = closed.length > 0 ? closed.reduce((s, t) => s + t.profitPct, 0) / closed.length : 0;
    const avgWin = winners.length > 0 ? winners.reduce((s, t) => s + t.profitPct, 0) / winners.length : 0;
    const avgLoss = losers.length > 0 ? losers.reduce((s, t) => s + t.profitPct, 0) / losers.length : 0;
    const totalReturn = closed.reduce((s, t) => s + t.profitPct, 0);

    // By direction
    const byDir = {};
    for (const dir of ['BL', 'SS']) {
      const dt = closed.filter(t => t.signal === dir);
      const dw = dt.filter(t => t.isWinner);
      const dl = dt.filter(t => !t.isWinner);
      const dAvgWin = dw.length > 0 ? dw.reduce((s, t) => s + t.profitPct, 0) / dw.length : 0;
      const dAvgLoss = dl.length > 0 ? dl.reduce((s, t) => s + t.profitPct, 0) / dl.length : 0;
      byDir[dir] = {
        trades: dt.length,
        winners: dw.length,
        winRate: dt.length > 0 ? parseFloat((dw.length / dt.length * 100).toFixed(1)) : 0,
        avgPnl: dt.length > 0 ? parseFloat((dt.reduce((s, t) => s + t.profitPct, 0) / dt.length).toFixed(2)) : 0,
        avgWin: parseFloat(dAvgWin.toFixed(2)),
        avgLoss: parseFloat(dAvgLoss.toFixed(2)),
        totalReturn: parseFloat(dt.reduce((s, t) => s + t.profitPct, 0).toFixed(1)),
      };
    }

    // By exit reason
    const byExit = {};
    for (const t of closed) {
      if (!byExit[t.exitReason]) byExit[t.exitReason] = { trades: 0, winners: 0, totalPnl: 0 };
      byExit[t.exitReason].trades++;
      if (t.isWinner) byExit[t.exitReason].winners++;
      byExit[t.exitReason].totalPnl += t.profitPct;
    }

    // By year
    const byYear = {};
    for (const t of closed) {
      const y = t.weekOf.slice(0, 4);
      if (!byYear[y]) byYear[y] = { trades: 0, winners: 0, totalPnl: 0 };
      byYear[y].trades++;
      if (t.isWinner) byYear[y].winners++;
      byYear[y].totalPnl += t.profitPct;
    }

    const result = {
      config: config.name,
      desc: config.desc,
      filters: { bl: config.bl, ss: config.ss },
      closedTrades: closed.length,
      winners: winners.length,
      losers: losers.length,
      winRate: closed.length > 0 ? parseFloat((winners.length / closed.length * 100).toFixed(1)) : 0,
      avgPnl: parseFloat(avgPnl.toFixed(2)),
      avgWin: parseFloat(avgWin.toFixed(2)),
      avgLoss: parseFloat(avgLoss.toFixed(2)),
      winLossRatio: avgLoss !== 0 ? parseFloat((avgWin / Math.abs(avgLoss)).toFixed(2)) : 0,
      totalReturn: parseFloat(totalReturn.toFixed(1)),
      avgDays: closed.length > 0 ? parseFloat((closed.reduce((s, t) => s + t.tradingDays, 0) / closed.length).toFixed(0)) : 0,
      byDirection: byDir,
      byExitReason: byExit,
      byYear,
    };

    allConfigResults.push(result);
    await resultCol.updateOne({ config: config.name }, { $set: result }, { upsert: true });

    process.stdout.write(` ${closed.length} trades, ${result.winRate}% win, ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(2)}% avg`);
  }

  // ── Console Report ────────────────────────────────────────────────────────
  console.log('\n\n');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('  PNTHR BACKTEST — ASYMMETRIC BL/SS GATES + D2 HARD GATE');
  console.log('  Entry: Signal price (limit order)  |  Exit: BE/SE + Stop + 20-day stale');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════');

  // Main comparison table
  console.log('\n── Configuration Comparison ──\n');
  console.log('  Config                  Trades  Win%    Avg P&L   Avg Win   Avg Loss  W/L     Total Ret');
  console.log('  ──────────────────────  ──────  ──────  ────────  ────────  ────────  ──────  ─────────');

  for (const r of allConfigResults) {
    console.log(
      `  ${r.config.padEnd(24)}` +
      `${String(r.closedTrades).padStart(6)}  ` +
      `${r.winRate.toFixed(1).padStart(5)}%  ` +
      `${(r.avgPnl >= 0 ? '+' : '') + r.avgPnl.toFixed(2) + '%'}`.padStart(8) + '  ' +
      `+${r.avgWin.toFixed(2)}%`.padStart(8) + '  ' +
      `${r.avgLoss.toFixed(2)}%`.padStart(8) + '  ' +
      `${r.winLossRatio.toFixed(2)}`.padStart(6) + '  ' +
      `${(r.totalReturn >= 0 ? '+' : '') + r.totalReturn.toFixed(0) + '%'}`.padStart(9)
    );
  }

  // Direction breakdown
  console.log('\n── BL vs SS by Configuration ──\n');
  console.log('  Config                  BL Trades  BL Win%  BL Avg    SS Trades  SS Win%  SS Avg    BL Total  SS Total');
  console.log('  ──────────────────────  ─────────  ───────  ────────  ─────────  ───────  ────────  ────────  ────────');

  for (const r of allConfigResults) {
    const bl = r.byDirection.BL || { trades: 0, winRate: 0, avgPnl: 0, totalReturn: 0 };
    const ss = r.byDirection.SS || { trades: 0, winRate: 0, avgPnl: 0, totalReturn: 0 };
    console.log(
      `  ${r.config.padEnd(24)}` +
      `${String(bl.trades).padStart(9)}  ` +
      `${bl.winRate.toFixed(1).padStart(6)}%  ` +
      `${(bl.avgPnl >= 0 ? '+' : '') + bl.avgPnl.toFixed(2) + '%'}`.padStart(8) + '  ' +
      `${String(ss.trades).padStart(9)}  ` +
      `${ss.winRate.toFixed(1).padStart(6)}%  ` +
      `${(ss.avgPnl >= 0 ? '+' : '') + ss.avgPnl.toFixed(2) + '%'}`.padStart(8) + '  ' +
      `${(bl.totalReturn >= 0 ? '+' : '') + bl.totalReturn.toFixed(0)}`.padStart(8) + '  ' +
      `${(ss.totalReturn >= 0 ? '+' : '') + ss.totalReturn.toFixed(0)}`.padStart(8)
    );
  }

  // Year-by-year for top configs
  const topConfigs = ['BASELINE', 'D2_MACRO_SECTOR', 'FULL_ASYM_A', 'FULL_ASYM_B', 'BL_ONLY_FULL', 'SS_CRASH_MODE'];
  console.log('\n── Year-by-Year for Key Configurations ──\n');

  for (const configName of topConfigs) {
    const r = allConfigResults.find(c => c.config === configName);
    if (!r) continue;
    console.log(`  ${r.config} (${r.desc}):`);
    const years = Object.keys(r.byYear).sort();
    for (const year of years) {
      const y = r.byYear[year];
      const wr = y.trades > 0 ? (y.winners / y.trades * 100).toFixed(1) : '0.0';
      const avg = y.trades > 0 ? (y.totalPnl / y.trades).toFixed(2) : '0.00';
      console.log(
        `    ${year}  ${String(y.trades).padStart(5)} trades  win: ${wr.padStart(5)}%  ` +
        `avg: ${(parseFloat(avg) >= 0 ? '+' : '') + avg}%  total: ${(y.totalPnl >= 0 ? '+' : '') + y.totalPnl.toFixed(0)}%`
      );
    }
    console.log('');
  }

  // Exit reason breakdown for top configs
  console.log('── Exit Reasons for Key Configurations ──\n');
  for (const configName of ['BASELINE', 'FULL_ASYM_A', 'BL_ONLY_FULL']) {
    const r = allConfigResults.find(c => c.config === configName);
    if (!r) continue;
    console.log(`  ${r.config}:`);
    for (const [reason, data] of Object.entries(r.byExitReason).sort((a, b) => b[1].trades - a[1].trades)) {
      const wr = data.trades > 0 ? (data.winners / data.trades * 100).toFixed(1) : '0.0';
      const avg = data.trades > 0 ? (data.totalPnl / data.trades).toFixed(2) : '0.00';
      console.log(
        `    ${reason.padEnd(12)}  ${String(data.trades).padStart(5)} trades  win: ${wr.padStart(5)}%  avg: ${(parseFloat(avg) >= 0 ? '+' : '') + avg}%`
      );
    }
    console.log('');
  }

  // ── Highlight best configs ──
  console.log('── TOP 5 BY WIN RATE ──\n');
  const byWinRate = [...allConfigResults].filter(r => r.closedTrades >= 50).sort((a, b) => b.winRate - a.winRate);
  for (const r of byWinRate.slice(0, 5)) {
    console.log(`  ${r.config.padEnd(24)} ${r.winRate.toFixed(1)}% win  ${r.closedTrades} trades  ${r.avgPnl >= 0 ? '+' : ''}${r.avgPnl.toFixed(2)}% avg  W/L: ${r.winLossRatio.toFixed(2)}`);
  }

  console.log('\n── TOP 5 BY TOTAL RETURN ──\n');
  const byReturn = [...allConfigResults].filter(r => r.closedTrades >= 50).sort((a, b) => b.totalReturn - a.totalReturn);
  for (const r of byReturn.slice(0, 5)) {
    console.log(`  ${r.config.padEnd(24)} total: ${r.totalReturn >= 0 ? '+' : ''}${r.totalReturn.toFixed(0)}%  ${r.winRate.toFixed(1)}% win  ${r.closedTrades} trades`);
  }

  console.log('\n── TOP 5 BY WIN/LOSS RATIO ──\n');
  const byWLR = [...allConfigResults].filter(r => r.closedTrades >= 50).sort((a, b) => b.winLossRatio - a.winLossRatio);
  for (const r of byWLR.slice(0, 5)) {
    console.log(`  ${r.config.padEnd(24)} W/L: ${r.winLossRatio.toFixed(2)}  ${r.winRate.toFixed(1)}% win  ${r.closedTrades} trades  ${r.avgPnl >= 0 ? '+' : ''}${r.avgPnl.toFixed(2)}% avg`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════════════════════════════\n');
  process.exit(0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
