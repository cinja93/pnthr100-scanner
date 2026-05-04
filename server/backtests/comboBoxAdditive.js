// Box-Breakout Additive Uses — counterfactual NAV simulation
//
// Tests three "additive" applications of box-breakout signals on the existing
// production (Wagyu $1M) trade book — none replace D1-D8, all augment it:
//
//   TEST 1 (BOOST):   For each production BL trade with same-direction box-UP
//                     within ±W days BEFORE entry, scale its position size by
//                     factor M (1.5×, 2.0×). Equity contribution scales by M.
//                     Other trades unchanged.
//                     Caveat: ignores capital constraints (1% vitality cap,
//                     heat limits, lot-pct rules); shows theoretical max.
//
//   TEST 2 (EARLY-EXIT): For each open BL position, if a box-DOWN breakout
//                     fires for the same ticker DURING the trade's life
//                     (entryDate < boxDate < exitDate), exit early at that
//                     date's close. Original exit replaced.
//
//   TEST 3 (BLOCKER): For each BL signal, if a box-DOWN breakout occurred
//                     within ±W days BEFORE entry, BLOCK the trade.
//                     Earlier raw analysis: 13 BL trades had this pattern,
//                     all losers, avg -5.81%. Tiny sample but unanimous.
//
// All tests:
//  - Use MTM NAV (pnthr_bt_pyramid_nav_1m_daily_nav_mtm_v21_recomputed)
//  - Subtract per-day equity contribution of CHANGED trades, add per-day
//    contribution of ALTERED versions
//  - Eligible period only (entryDate >= 2020-12-18); pre-eligible trades
//    pass through

import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
dotenv.config();

const NAV_TIER       = 1000000;
const TRADE_COLL     = 'pnthr_bt_pyramid_nav_1m_trade_log';
const NAV_COLL       = 'pnthr_bt_pyramid_nav_1m_daily_nav_mtm_v21_recomputed';
const BOX_COLL       = 'pnthr_bt_box_alerts';
const CANDLE_COLL    = 'pnthr_bt_candles';
const RESULT_COLL    = 'pnthr_bt_box_additive_test';

const RISK_FREE_ANNUAL = 0.030;
const TRADING_DAYS_YR  = 252;
const WINDOWS = [3, 7, 14];                 // proximity window (days)
const BOOST_FACTORS = [1.25, 1.5, 2.0];     // for TEST 1

// ---------- Helpers ----------
function daysBetween(a, b) { return (new Date(a) - new Date(b)) / 86400000; }
function mean(arr) { return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0; }
function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}
function maxDrawdown(navs) {
  let peak = navs[0], maxDD = 0;
  for (const v of navs) {
    if (v > peak) peak = v;
    const dd = (v - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }
  return maxDD;
}
function computeMetrics(navByDate, dates) {
  const navs = dates.map(d => navByDate[d]);
  const startNav = navs[0], endNav = navs[navs.length - 1];
  const totalReturn = (endNav - startNav) / startNav;
  const years = dates.length / TRADING_DAYS_YR;
  const cagr = Math.pow(endNav / startNav, 1 / years) - 1;
  const ret = [];
  for (let i = 1; i < navs.length; i++) ret.push(navs[i] / navs[i - 1] - 1);
  const dailyRf = RISK_FREE_ANNUAL / TRADING_DAYS_YR;
  const excess = ret.map(r => r - dailyRf);
  const sharpe = stdev(ret) > 0 ? (mean(excess) / stdev(ret)) * Math.sqrt(TRADING_DAYS_YR) : 0;
  const downside = ret.filter(r => r < 0);
  const downsideDev = downside.length
    ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / ret.length) : 0;
  const sortino = downsideDev > 0 ? (mean(ret) / downsideDev) * Math.sqrt(TRADING_DAYS_YR) : 0;
  const maxDD = maxDrawdown(navs);
  const calmar = maxDD < 0 ? cagr / Math.abs(maxDD) : 0;
  return {
    cagr: +(cagr * 100).toFixed(2),
    sharpe: +sharpe.toFixed(2),
    sortino: +sortino.toFixed(2),
    calmar: +calmar.toFixed(2),
    maxDD: +(maxDD * 100).toFixed(2),
    totalReturn: +(totalReturn * 100).toFixed(2),
  };
}

// ---------- Per-trade equity series ----------
// Same as comboBoxNavSim — for each day, returns this trade's contribution
// to NAV equity. Sum across all trades + $1M ≈ production NAV.
function buildTradeEquitySeries(trade, candleByDate, allDates, opts = {}) {
  const overrideExit = opts.overrideExitDate || null;
  const dir = trade.signal === 'BL' ? +1 : -1;
  const lots = (trade.lots || []).filter(l => l.shares > 0);
  if (lots.length === 0) return {};
  const sortedLots = [...lots].sort((a, b) => a.fillDate.localeCompare(b.fillDate));
  const firstFill = sortedLots[0].fillDate;
  const exitDate = overrideExit || trade.exitDate;
  if (!exitDate) return {};

  // If overriding exit, compute new realized P&L at the override date's close
  let overrideRealized = null;
  if (overrideExit) {
    const close = candleByDate[overrideExit];
    if (close == null) return {};   // can't compute alt exit — fall through (will skip)
    let shares = 0, costBasis = 0, entryFric = 0, exitFricEst = 0, borrowProRated = 0;
    for (const l of sortedLots) {
      if (l.fillDate <= overrideExit) {
        shares    += l.shares;
        costBasis += l.fillPrice * l.shares;
        entryFric += (l.entryComm || 0) + (l.entrySlip || 0);
        exitFricEst += (l.exitComm || 0) + (l.exitSlip || 0);
        // pro-rated borrow: original borrow × (days held early / days held actual)
        const origDays = Math.max(1, daysBetween(trade.exitDate, l.fillDate));
        const newDays  = Math.max(0, daysBetween(overrideExit, l.fillDate));
        borrowProRated += (l.borrowCost || 0) * (newDays / origDays);
      }
    }
    if (shares === 0) return {};
    overrideRealized = (close * shares - costBasis) * dir - entryFric - exitFricEst - borrowProRated;
  }

  const result = {};
  for (const d of allDates) {
    if (d < firstFill) continue;
    if (d >= exitDate) {
      result[d] = overrideExit ? overrideRealized : trade.netDollarPnl;
      continue;
    }
    let shares = 0, costBasis = 0, entryFric = 0;
    for (const l of sortedLots) {
      if (l.fillDate <= d) {
        shares    += l.shares;
        costBasis += l.fillPrice * l.shares;
        entryFric += (l.entryComm || 0) + (l.entrySlip || 0);
      }
    }
    const close = candleByDate[d];
    if (close == null) {
      const idx = allDates.indexOf(d);
      result[d] = idx > 0 ? (result[allDates[idx - 1]] ?? 0) : 0;
      continue;
    }
    result[d] = (close * shares - costBasis) * dir - entryFric;
  }
  return result;
}

function scaleSeries(series, factor) {
  const out = {};
  for (const [d, v] of Object.entries(series)) out[d] = v * factor;
  return out;
}

// ---------- Box helpers ----------
function nearestBoxBefore(ticker, entryDate, listMap, W) {
  const list = listMap.get(ticker);
  if (!list) return null;
  let best = null;
  for (const bd of list) {
    const dd = daysBetween(entryDate, bd);
    if (dd >= 0 && dd <= W) { if (best === null || dd < best) best = dd; }
  }
  return best;
}
function firstBoxDuring(ticker, entryDate, exitDate, listMap) {
  const list = listMap.get(ticker);
  if (!list) return null;
  for (const bd of list) {
    if (bd > entryDate && bd < exitDate) return bd;
  }
  return null;
}

// ---------- Main ----------
async function main() {
  const c = new MongoClient(process.env.MONGODB_URI);
  await c.connect();
  const db = c.db('pnthr_den');

  console.log('Loading...');
  const navDocs = await db.collection(NAV_COLL).find({}).sort({ date: 1 }).toArray();
  const prodNav = {};
  for (const n of navDocs) prodNav[n.date] = n.equity;
  const allDates = Object.keys(prodNav).sort();
  const startDate = allDates[0], endDate = allDates[allDates.length - 1];

  const trades = await db.collection(TRADE_COLL).find({ navTier: NAV_TIER }).toArray();

  const boxes = await db.collection(BOX_COLL).find({}).toArray();
  const upBox = new Map(), downBox = new Map();
  let earliestBoxDate = '9999-99-99';
  for (const d of boxes) {
    const ups = (d.boxes || []).filter(b => b.status === 'broken-up' && b.breakoutDate).map(b => b.breakoutDate);
    const dns = (d.boxes || []).filter(b => b.status === 'broken-down' && b.breakoutDate).map(b => b.breakoutDate);
    if (ups.length) upBox.set(d.ticker, ups.sort());
    if (dns.length) downBox.set(d.ticker, dns.sort());
    for (const x of [...ups, ...dns]) if (x < earliestBoxDate) earliestBoxDate = x;
  }
  const ELIG = earliestBoxDate;
  console.log(`  ${trades.length} trades, ${navDocs.length} NAV days`);
  console.log(`  Box-eligible from: ${ELIG}`);

  const tickers = [...new Set(trades.map(t => t.ticker))];
  const candleDocs = await db.collection(CANDLE_COLL).find({ ticker: { $in: tickers } }).toArray();
  const candleByTicker = new Map();
  for (const d of candleDocs) {
    const m = {};
    for (const bar of (d.daily || [])) m[bar.date] = bar.close;
    candleByTicker.set(d.ticker, m);
  }

  // Per-trade baseline equity series
  console.log('\nComputing baseline equity series for all trades...');
  const baselineSeries = new Map();
  for (const t of trades) {
    if (!t.exitDate || t.netDollarPnl == null) continue;
    const cand = candleByTicker.get(t.ticker);
    if (!cand) continue;
    baselineSeries.set(t._id.toString(), buildTradeEquitySeries(t, cand, allDates));
  }

  // Sanity check baseline reconstruction
  const aggSeries = {};
  for (const series of baselineSeries.values()) {
    for (const [d, v] of Object.entries(series)) aggSeries[d] = (aggSeries[d] || 0) + v;
  }
  let rmsSum = 0;
  for (const d of allDates) {
    const rebuilt = prodNav[startDate] + (aggSeries[d] || 0);
    rmsSum += ((rebuilt - prodNav[d]) / prodNav[d]) ** 2;
  }
  const rms = Math.sqrt(rmsSum / allDates.length);
  console.log(`  Baseline RMS error: ${(rms * 100).toFixed(3)}%`);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`BASELINE`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const baseline = computeMetrics(prodNav, allDates);
  console.log(JSON.stringify(baseline, null, 2));

  const scenarios = [];

  // Helper: run with custom per-trade series (replaces baseline series for changed trades)
  function runWithSeries(label, info, customSeries) {
    const cfNav = { ...prodNav };
    for (const [tid, baseSer] of baselineSeries.entries()) {
      const newSer = customSeries.get(tid) || baseSer;
      // Subtract baseline contribution, add new contribution
      for (const d of allDates) {
        const oldV = baseSer[d] || 0;
        const newV = newSer[d] || 0;
        if (oldV !== newV) cfNav[d] = cfNav[d] - oldV + newV;
      }
    }
    return { label, ...info, ...computeMetrics(cfNav, allDates) };
  }

  // ──────────── TEST 1: BOOST ────────────
  console.log('\n━━━ TEST 1: Position-size boost on BL+box-UP trades ━━━');
  for (const W of WINDOWS) {
    for (const M of BOOST_FACTORS) {
      const customSeries = new Map();
      let boostedCount = 0, boostedPnl = 0;
      for (const t of trades) {
        if (t.signal !== 'BL') continue;
        if (t.entryDate < ELIG) continue;
        const d = nearestBoxBefore(t.ticker, t.entryDate, upBox, W);
        if (d === null) continue;
        const baseSer = baselineSeries.get(t._id.toString());
        if (!baseSer) continue;
        customSeries.set(t._id.toString(), scaleSeries(baseSer, M));
        boostedCount++;
        boostedPnl += t.netDollarPnl;
      }
      const info = { test: 'BOOST', window: W, boost: M, boostedCount, boostedNetPnL: +boostedPnl.toFixed(0) };
      const r = runWithSeries(`BOOST ${M}× | box-UP ≤${W}d before BL`, info, customSeries);
      scenarios.push(r);
    }
  }

  // ──────────── TEST 2: EARLY-EXIT on box-DOWN during open BL ────────────
  console.log('\n━━━ TEST 2: Early-exit BL when box-DOWN fires during life ━━━');
  for (const minDaysFromEntry of [3, 7, 14]) {
    const customSeries = new Map();
    let altered = 0, alteredOldPnl = 0, alteredNewPnl = 0;
    for (const t of trades) {
      if (t.signal !== 'BL') continue;
      if (t.entryDate < ELIG) continue;
      const cand = candleByTicker.get(t.ticker);
      if (!cand) continue;
      const boxDownDate = firstBoxDuring(t.ticker, t.entryDate, t.exitDate, downBox);
      if (!boxDownDate) continue;
      // Require minimum days from entry to avoid being too jumpy
      if (daysBetween(boxDownDate, t.entryDate) < minDaysFromEntry) continue;
      const newSer = buildTradeEquitySeries(t, cand, allDates, { overrideExitDate: boxDownDate });
      if (Object.keys(newSer).length === 0) continue;
      customSeries.set(t._id.toString(), newSer);
      altered++;
      alteredOldPnl += t.netDollarPnl;
      // approximate new P&L = newSer at endDate or exit value
      const lastVal = newSer[t.exitDate] != null ? newSer[t.exitDate] : (newSer[boxDownDate] || 0);
      alteredNewPnl += lastVal;
    }
    const info = { test: 'EARLY_EXIT', minDaysFromEntry, altered, oldPnL: +alteredOldPnl.toFixed(0), newPnL: +alteredNewPnl.toFixed(0), pnlDelta: +(alteredNewPnl - alteredOldPnl).toFixed(0) };
    const r = runWithSeries(`EARLY-EXIT BL on box-DOWN (≥${minDaysFromEntry}d after entry)`, info, customSeries);
    scenarios.push(r);
  }

  // ──────────── TEST 3: BLOCKER (drop BL when opposite box-DOWN nearby) ────────────
  console.log('\n━━━ TEST 3: Block BL when box-DOWN within ±W days BEFORE entry ━━━');
  for (const W of WINDOWS) {
    const customSeries = new Map();
    let blocked = 0, blockedPnl = 0;
    for (const t of trades) {
      if (t.signal !== 'BL') continue;
      if (t.entryDate < ELIG) continue;
      const d = nearestBoxBefore(t.ticker, t.entryDate, downBox, W);
      if (d === null) continue;
      const baseSer = baselineSeries.get(t._id.toString());
      if (!baseSer) continue;
      // Replace with empty series (trade doesn't happen)
      customSeries.set(t._id.toString(), {});
      blocked++;
      blockedPnl += t.netDollarPnl;
    }
    const info = { test: 'BLOCKER', window: W, blocked, blockedNetPnL: +blockedPnl.toFixed(0) };
    const r = runWithSeries(`BLOCKER  | box-DOWN ≤${W}d before BL → drop`, info, customSeries);
    scenarios.push(r);
  }

  // ──────────── Output ────────────
  console.log('\n');
  console.log('═'.repeat(120));
  console.log('RESULTS — additive uses on Wagyu $1M (eligible period only, pre-2020-12 trades pass through)');
  console.log('═'.repeat(120));
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('Scenario', 50) + pad('Affected', 11) + pad('CAGR', 9) + pad('Shrp', 7) + pad('Srtn', 7) + pad('Calm', 7) + pad('MaxDD', 9) + pad('TotalRet', 12));
  console.log('─'.repeat(120));
  console.log(pad('BASELINE', 50) + pad('—', 11) + pad(baseline.cagr + '%', 9) + pad(baseline.sharpe, 7) + pad(baseline.sortino, 7) + pad(baseline.calmar, 7) + pad(baseline.maxDD + '%', 9) + pad(baseline.totalReturn + '%', 12));

  for (const s of scenarios) {
    let affected;
    if (s.test === 'BOOST')      affected = s.boostedCount;
    else if (s.test === 'EARLY_EXIT') affected = s.altered;
    else if (s.test === 'BLOCKER') affected = s.blocked;
    else affected = '?';
    console.log(
      pad(s.label, 50) +
      pad(affected, 11) +
      pad(s.cagr + '%', 9) +
      pad(s.sharpe, 7) +
      pad(s.sortino, 7) +
      pad(s.calmar, 7) +
      pad(s.maxDD + '%', 9) +
      pad(s.totalReturn + '%', 12)
    );
  }

  // Persist
  await db.collection(RESULT_COLL).replaceOne({ _id: 'latest' }, {
    _id: 'latest',
    runAt: new Date(),
    methodology: 'Additive box-breakout uses on Wagyu $1M, MTM NAV subtraction',
    baseline,
    scenarios,
    parameters: { NAV_TIER, RISK_FREE_ANNUAL, TRADING_DAYS_YR, WINDOWS, BOOST_FACTORS, ELIG },
  }, { upsert: true });
  console.log(`\nResults saved to ${RESULT_COLL}._id = 'latest'`);

  await c.close();
}

main().catch(e => { console.error(e); process.exit(1); });
