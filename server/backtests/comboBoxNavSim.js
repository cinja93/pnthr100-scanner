// Box-Breakout Combo Filter — Counterfactual NAV Simulation
//
// Purpose: rigorously test whether adding a same-direction box-breakout
// filter to PNTHR's existing D1-D8 BL/SS pipeline would improve fund-level
// metrics (CAGR, Sharpe, Sortino, Calmar, MaxDD, win rate).
//
// READ-ONLY: this script touches no production collection. Output is written
// to a NEW collection `pnthr_bt_box_combo_nav_test` for review.
//
// Methodology (see chat log 2026-05-03):
//  1. Pull production daily NAV from pnthr_bt_pyramid_nav_1m_daily_nav (Wagyu
//     $1M tier; matches PDF p.3 exactly).
//  2. Pull all 2,623 production trades with full lot detail from
//     pnthr_bt_pyramid_nav_1m_trade_log.
//  3. Pull box-breakout history from pnthr_bt_box_alerts.
//  4. Pull daily candles from pnthr_bt_candles for per-trade MTM.
//  5. For each trade, compute its per-day MTM contribution to NAV:
//       direction = +1 (BL) or −1 (SS)
//       shares_held(D) = sum of lot.shares with lot.fillDate ≤ D
//       daily_mtm(D) = (close_D − close_{D-1}) × shares_held(D) × direction
//       Friction: lot.entryComm + lot.entrySlip on lot.fillDate;
//                 lot.exitComm  + lot.exitSlip  on trade.exitDate;
//                 lot.borrowCost on trade.exitDate (already aggregated).
//  6. SANITY CHECK: sum all 2,623 trades' MTM + friction across the full
//     period + initial $1M equity. Compare to production NAV per-day.
//     If RMS variance > 0.5% on equity, abort with diagnostics.
//  7. For each scenario (15 total), determine which trades to FILTER OUT,
//     subtract their MTM contribution from production NAV → counterfactual.
//  8. Compute on each counterfactual NAV:
//        Total Return, CAGR, Sharpe (252d, vs 3m T-bill ~3%),
//        Sortino (MAR=0), Calmar, MaxDD, monthly best/worst.
//
// Scenarios (5 windows × 3 filter modes):
//   BL_A_{W}:  BL trades passed through ONLY if same-ticker box-UP breakout
//              occurred within W days BEFORE entryDate (≤ entry, real-time
//              actionable). All other BL trades dropped. SS unchanged.
//   BL_B_{W}:  BL trades passed through ONLY if box-UP within W days AFTER
//              entryDate. Post-hoc / not real-time tradeable. SS unchanged.
//   SS_B_{W}:  SS trades passed through ONLY if box-DOWN within W days AFTER
//              entryDate. BL unchanged.
//
// W ∈ {3, 5, 7, 10, 14}.
//
// Pre-2020-08 trades are NOT filterable (box backtest starts May 2020 + 8w
// base lookback). They pass through all scenarios unchanged. Reported both
// "full period" (1,713 days) and "box-eligible subset" (Aug 2020 onwards).
// Survivorship: trades on tickers without box weekly data are kept (treated
// as "no box found", thus filtered OUT in real-time scenarios).

import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
dotenv.config();

const NAV_TIER       = 1000000;            // Wagyu $1M
const TRADE_COLL     = 'pnthr_bt_pyramid_nav_1m_trade_log';
const NAV_COLL       = 'pnthr_bt_pyramid_nav_1m_daily_nav_mtm_v21_recomputed';  // GROSS MTM NAV
const BOX_COLL       = 'pnthr_bt_box_alerts';
const CANDLE_COLL    = 'pnthr_bt_candles';
const RESULT_COLL    = 'pnthr_bt_box_combo_nav_test';

const RISK_FREE_ANNUAL = 0.030;            // 3% T-bill (PDF doesn't pin a year; Sharpe tolerance bound)
const TRADING_DAYS_YR  = 252;
const WINDOWS = [3, 5, 7, 10, 14];

// ---------- Date helpers ----------
function addDays(iso, days) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) { return (new Date(a) - new Date(b)) / 86400000; }
function dateRange(start, end) {
  const out = [];
  let d = start;
  while (d <= end) { out.push(d); d = addDays(d, 1); }
  return out;
}

// ---------- Stats ----------
function mean(arr) { return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0; }
function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}
function maxDrawdown(navArr) {
  let peak = navArr[0], maxDD = 0;
  for (const v of navArr) {
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

  // Daily returns
  const ret = [];
  for (let i = 1; i < navs.length; i++) ret.push(navs[i] / navs[i - 1] - 1);

  const dailyRf = RISK_FREE_ANNUAL / TRADING_DAYS_YR;
  const excess = ret.map(r => r - dailyRf);
  const sharpe = stdev(ret) > 0 ? (mean(excess) / stdev(ret)) * Math.sqrt(TRADING_DAYS_YR) : 0;

  const downside = ret.filter(r => r < 0);
  const downsideDev = downside.length
    ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / ret.length)  // MAR=0, full-sample denominator
    : 0;
  const sortino = downsideDev > 0 ? (mean(ret) / downsideDev) * Math.sqrt(TRADING_DAYS_YR) : 0;

  const maxDD = maxDrawdown(navs);
  const calmar = maxDD < 0 ? cagr / Math.abs(maxDD) : 0;

  // Monthly returns
  const monthly = {};
  for (let i = 0; i < dates.length; i++) {
    const ym = dates[i].slice(0, 7);
    if (!(ym in monthly)) monthly[ym] = { startNav: navs[i], endNav: navs[i] };
    monthly[ym].endNav = navs[i];
  }
  const monthlyRets = Object.values(monthly).map(m => m.endNav / m.startNav - 1);
  const bestMonth = Math.max(...monthlyRets);
  const worstMonth = Math.min(...monthlyRets);

  return {
    startNav: +startNav.toFixed(2),
    endNav:   +endNav.toFixed(2),
    totalReturn: +(totalReturn * 100).toFixed(2),
    cagr:        +(cagr * 100).toFixed(2),
    sharpe:      +sharpe.toFixed(2),
    sortino:     +sortino.toFixed(2),
    calmar:      +calmar.toFixed(2),
    maxDD:       +(maxDD * 100).toFixed(2),
    bestMonth:   +(bestMonth * 100).toFixed(2),
    worstMonth:  +(worstMonth * 100).toFixed(2),
  };
}

// ---------- Per-trade equity contribution (MTM-aware) ----------
// Returns { date → equity_contribution_of_this_trade_on_that_date }.
// For each day during the trade's life (inclusive of fillDate1, exclusive of
// exitDate), contribution = (close × shares − cost_basis) × dir − entry_friction.
// On exitDate and after, contribution = trade.netDollarPnl (realized).
// This matches production's MTM-recomputed equity formulation:
//   prod_equity(D) = $1M + Σ over all trades T of contribution_T(D)
function buildTradeEquitySeries(trade, candleByDate, allDates) {
  if (!trade.exitDate || trade.netDollarPnl == null) return {};
  const dir = trade.signal === 'BL' ? +1 : -1;
  const lots = (trade.lots || []).filter(l => l.shares > 0);
  if (lots.length === 0) return {};

  // Pre-sort lots by fillDate
  const sortedLots = [...lots].sort((a, b) => a.fillDate.localeCompare(b.fillDate));
  const firstFill = sortedLots[0].fillDate;
  const exitDate  = trade.exitDate;

  const result = {};
  for (const d of allDates) {
    if (d < firstFill) continue;
    if (d >= exitDate) {
      // After exit: realized
      result[d] = trade.netDollarPnl;
      continue;
    }
    // During trade life — compute unrealized + cumulative entry friction
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
      // Carry forward previous day's contribution
      const idx = allDates.indexOf(d);
      result[d] = idx > 0 ? (result[allDates[idx - 1]] ?? 0) : 0;
      continue;
    }
    result[d] = (close * shares - costBasis) * dir - entryFric;
  }
  return result;
}

// ---------- Main ----------
async function main() {
  const c = new MongoClient(process.env.MONGODB_URI);
  await c.connect();
  const db = c.db('pnthr_den');

  console.log('Loading production NAV...');
  const navDocs = await db.collection(NAV_COLL).find({}).sort({ date: 1 }).toArray();
  const prodNav = {};
  for (const n of navDocs) prodNav[n.date] = n.equity;
  const allDates = Object.keys(prodNav).sort();
  const startDate = allDates[0], endDate = allDates[allDates.length - 1];
  console.log(`  ${navDocs.length} days, ${startDate} → ${endDate}`);
  console.log(`  Start NAV $${prodNav[startDate].toLocaleString()} → End NAV $${prodNav[endDate].toLocaleString()}`);

  console.log('Loading trades...');
  const trades = await db.collection(TRADE_COLL).find({ navTier: NAV_TIER }).toArray();
  console.log(`  ${trades.length} trades`);

  console.log('Loading box alerts...');
  const boxes = await db.collection(BOX_COLL).find({}).toArray();
  const upBox = new Map();    // ticker → array of breakout dates (sorted)
  const downBox = new Map();
  let earliestBoxDate = '9999-99-99';
  for (const d of boxes) {
    const ups = (d.boxes || []).filter(b => b.status === 'broken-up' && b.breakoutDate).map(b => b.breakoutDate);
    const dns = (d.boxes || []).filter(b => b.status === 'broken-down' && b.breakoutDate).map(b => b.breakoutDate);
    if (ups.length) upBox.set(d.ticker, ups.sort());
    if (dns.length) downBox.set(d.ticker, dns.sort());
    for (const x of [...ups, ...dns]) if (x < earliestBoxDate) earliestBoxDate = x;
  }
  console.log(`  ${upBox.size} tickers with box-UP, ${downBox.size} tickers with box-DOWN`);
  console.log(`  Earliest box breakout in data: ${earliestBoxDate}`);

  // Survivorship: tickers WITHOUT box detection (no weekly bars in box backtest)
  const withBoxData = new Set([...upBox.keys(), ...downBox.keys()]);
  let tradesOnUncovered = 0;
  for (const t of trades) if (!withBoxData.has(t.ticker)) tradesOnUncovered++;
  console.log(`  Production trades on tickers w/o box data: ${tradesOnUncovered} of ${trades.length}`);

  // For "box-eligible period only" runs, we treat trades entered before
  // earliestBoxDate as untestable (pass-through). This eliminates the
  // mechanical bias of filtering out 14 months of trades that pre-date box
  // detection.
  const BOX_ELIGIBLE_FROM = earliestBoxDate;
  let preEligibleBL = 0, preEligibleSS = 0, postBL = 0, postSS = 0;
  for (const t of trades) {
    if (t.entryDate < BOX_ELIGIBLE_FROM) {
      if (t.signal === 'BL') preEligibleBL++; else preEligibleSS++;
    } else {
      if (t.signal === 'BL') postBL++; else postSS++;
    }
  }
  console.log(`  Trades pre-box-eligible (pass-through): BL ${preEligibleBL}  SS ${preEligibleSS}`);
  console.log(`  Trades post-box-eligible (filterable):  BL ${postBL}  SS ${postSS}`);

  console.log('Loading daily candles for trade tickers...');
  const tickers = [...new Set(trades.map(t => t.ticker))];
  const candleDocs = await db.collection(CANDLE_COLL).find({ ticker: { $in: tickers } }).toArray();
  const candleByTicker = new Map();
  for (const d of candleDocs) {
    const m = {};
    for (const bar of (d.daily || [])) m[bar.date] = bar.close;
    candleByTicker.set(d.ticker, m);
  }
  console.log(`  candles for ${candleByTicker.size}/${tickers.length} tickers`);

  // ---------- Per-trade equity contribution series ----------
  console.log('\nComputing per-trade equity contribution series (MTM)...');
  const tradeImpact = new Map();   // trade._id → { date → equity_contribution }
  let okCount = 0, skipCount = 0;
  for (const t of trades) {
    if (!t.exitDate || t.netDollarPnl == null) { skipCount++; continue; }
    const cand = candleByTicker.get(t.ticker);
    if (!cand) { skipCount++; continue; }
    tradeImpact.set(t._id.toString(), buildTradeEquitySeries(t, cand, allDates));
    okCount++;
  }
  console.log(`  ${okCount} trades with series, ${skipCount} skipped`);

  // ---------- Sanity check ----------
  console.log('\nSanity check: rebuilt equity ($1M + Σ contributions) vs production MTM NAV...');
  const aggSeries = {};
  for (const series of tradeImpact.values()) {
    for (const [d, v] of Object.entries(series)) aggSeries[d] = (aggSeries[d] || 0) + v;
  }
  let maxAbsErr = 0, maxRelErr = 0, maxErrDate = null, sumSqRel = 0;
  for (const d of allDates) {
    const rebuilt = prodNav[startDate] + (aggSeries[d] || 0);
    const prod = prodNav[d];
    const err = rebuilt - prod;
    const rel = Math.abs(err / prod);
    sumSqRel += rel * rel;
    if (Math.abs(err) > Math.abs(maxAbsErr)) { maxAbsErr = err; maxErrDate = d; maxRelErr = rel; }
  }
  const rmsRel = Math.sqrt(sumSqRel / allDates.length);
  const finalRebuilt = prodNav[startDate] + (aggSeries[endDate] || 0);
  console.log(`  Max abs error:        $${maxAbsErr.toFixed(2)} on ${maxErrDate} (${(maxRelErr * 100).toFixed(3)}% rel)`);
  console.log(`  RMS relative error:   ${(rmsRel * 100).toFixed(4)}%`);
  console.log(`  Final rebuilt NAV:    $${finalRebuilt.toFixed(2)} vs production $${prodNav[endDate].toFixed(2)}`);
  console.log(`  Final delta:          $${(finalRebuilt - prodNav[endDate]).toFixed(2)} (${(((finalRebuilt - prodNav[endDate]) / prodNav[endDate]) * 100).toFixed(4)}%)`);

  if (rmsRel > 0.02) {
    console.error('\n⚠ Sanity check FAILED — RMS error > 2%. Aborting before scenario runs.');
    process.exit(2);
  }
  console.log('  ✓ Sanity check within tolerance — counterfactual deltas are meaningful.\n');

  // ---------- Baseline metrics ----------
  console.log('━'.repeat(72));
  console.log('BASELINE — production NAV (full period, no filter)');
  console.log('━'.repeat(72));
  const baseline = computeMetrics(prodNav, allDates);
  console.log(JSON.stringify(baseline, null, 2));

  console.log('\nPDF benchmark to verify methodology:');
  console.log('  CAGR        38.78%  (computed: ' + baseline.cagr + '%)');
  console.log('  Sharpe       2.59   (computed: ' + baseline.sharpe + ')');
  console.log('  Sortino      4.72   (computed: ' + baseline.sortino + ')');
  console.log('  Calmar       4.56   (computed: ' + baseline.calmar + ')');
  console.log('  MaxDD       -8.51%  (computed: ' + baseline.maxDD + '%)');
  console.log('  TotalRet  +837.05%  (computed: ' + baseline.totalReturn + '%)');

  // ---------- Filter helpers ----------
  function nearestBoxBefore(ticker, entryDate, listMap, windowDays) {
    const list = listMap.get(ticker);
    if (!list) return null;
    let best = null;
    for (const bd of list) {
      const dd = daysBetween(entryDate, bd);
      if (dd >= 0 && dd <= windowDays) {
        if (best === null || dd < best) best = dd;
      }
    }
    return best;
  }
  function nearestBoxAfter(ticker, entryDate, listMap, windowDays) {
    const list = listMap.get(ticker);
    if (!list) return null;
    let best = null;
    for (const bd of list) {
      const dd = daysBetween(bd, entryDate);
      if (dd > 0 && dd <= windowDays) {
        if (best === null || dd < best) best = dd;
      }
    }
    return best;
  }

  // ---------- Scenarios ----------
  // For each scenario, determine which trade._ids to FILTER OUT (drop), then
  // subtract their MTM from production NAV.
  function runScenario(label, dropFn) {
    const dropIds = new Set();
    let dropBL = 0, dropSS = 0, droppedPnL = 0;
    for (const t of trades) {
      if (!tradeImpact.has(t._id.toString())) continue;
      if (dropFn(t)) {
        dropIds.add(t._id.toString());
        droppedPnL += t.netDollarPnl;
        if (t.signal === 'BL') dropBL++; else dropSS++;
      }
    }
    // Per-day equity contribution sum from filtered-out trades
    const dropAgg = {};
    for (const id of dropIds) {
      const m = tradeImpact.get(id);
      for (const [d, v] of Object.entries(m)) dropAgg[d] = (dropAgg[d] || 0) + v;
    }
    // Counterfactual NAV(D) = prod NAV(D) - dropped trades' equity contribution(D)
    const cfNav = {};
    for (const d of allDates) cfNav[d] = prodNav[d] - (dropAgg[d] || 0);
    const metrics = computeMetrics(cfNav, allDates);
    return { label, dropBL, dropSS, dropTotal: dropIds.size, droppedPnL: +droppedPnL.toFixed(2), ...metrics };
  }

  const scenarios = [];

  // ── Full-period scenarios (filter applies to ALL trades) ──
  for (const W of WINDOWS) {
    scenarios.push(runScenario(`BL_A_${W}d   FULL  (box-UP ≤${W}d BEFORE BL)`, t => {
      if (t.signal !== 'BL') return false;
      const d = nearestBoxBefore(t.ticker, t.entryDate, upBox, W);
      return d === null;
    }));
    scenarios.push(runScenario(`BL_B_${W}d   FULL  (box-UP ≤${W}d AFTER  BL)`, t => {
      if (t.signal !== 'BL') return false;
      const d = nearestBoxAfter(t.ticker, t.entryDate, upBox, W);
      return d === null;
    }));
    scenarios.push(runScenario(`SS_B_${W}d   FULL  (box-DOWN ≤${W}d AFTER SS)`, t => {
      if (t.signal !== 'SS') return false;
      const d = nearestBoxAfter(t.ticker, t.entryDate, downBox, W);
      return d === null;
    }));
  }
  // ── Box-eligible period scenarios (pre-eligible trades pass through) ──
  for (const W of WINDOWS) {
    scenarios.push(runScenario(`BL_A_${W}d   ELIG  (box-UP ≤${W}d BEFORE BL)`, t => {
      if (t.signal !== 'BL') return false;
      if (t.entryDate < BOX_ELIGIBLE_FROM) return false;   // pass-through pre-data
      const d = nearestBoxBefore(t.ticker, t.entryDate, upBox, W);
      return d === null;
    }));
    scenarios.push(runScenario(`BL_B_${W}d   ELIG  (box-UP ≤${W}d AFTER  BL)`, t => {
      if (t.signal !== 'BL') return false;
      if (t.entryDate < BOX_ELIGIBLE_FROM) return false;
      const d = nearestBoxAfter(t.ticker, t.entryDate, upBox, W);
      return d === null;
    }));
    scenarios.push(runScenario(`SS_B_${W}d   ELIG  (box-DOWN ≤${W}d AFTER SS)`, t => {
      if (t.signal !== 'SS') return false;
      if (t.entryDate < BOX_ELIGIBLE_FROM) return false;
      const d = nearestBoxAfter(t.ticker, t.entryDate, downBox, W);
      return d === null;
    }));
  }

  // ---------- Comparison output ----------
  console.log('\n');
  console.log('═'.repeat(108));
  console.log('SCENARIO RESULTS (Wagyu $1M tier, full period 2019-06-07 → 2026-04-02)');
  console.log('═'.repeat(108));
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('Scenario', 36) + pad('Dropped', 18) + pad('Δ$', 12) + pad('CAGR', 9) + pad('Shrp', 7) + pad('Srtn', 7) + pad('Calm', 7) + pad('MaxDD', 9) + pad('TotalRet', 12));
  console.log('─'.repeat(124));

  const baselineRow = { label: 'BASELINE (production)', dropBL: 0, dropSS: 0, dropTotal: 0, droppedPnL: 0, ...baseline };
  const all = [baselineRow, ...scenarios];

  for (const s of all) {
    const sign = s.droppedPnL >= 0 ? '+' : '';
    console.log(
      pad(s.label, 36) +
      pad(`BL:${s.dropBL} SS:${s.dropSS}`, 18) +
      pad('$' + sign + Math.round(s.droppedPnL).toLocaleString(), 12) +
      pad(s.cagr + '%', 9) +
      pad(s.sharpe, 7) +
      pad(s.sortino, 7) +
      pad(s.calmar, 7) +
      pad(s.maxDD + '%', 9) +
      pad(s.totalReturn + '%', 12)
    );
  }

  // ---------- Persist results ----------
  const outDoc = {
    _id: 'latest',
    runAt: new Date(),
    methodology: 'Per-day equity contribution subtraction from MTM NAV (Wagyu $1M)',
    sanityCheck: {
      maxAbsError: +maxAbsErr.toFixed(2),
      maxAbsErrorDate: maxErrDate,
      maxRelErrorPct: +(maxRelErr * 100).toFixed(4),
      rmsRelErrorPct: +(rmsRel * 100).toFixed(4),
      finalDeltaPct: +(((finalRebuilt - prodNav[endDate]) / prodNav[endDate]) * 100).toFixed(4),
    },
    baseline: baselineRow,
    scenarios,
    parameters: { NAV_TIER, RISK_FREE_ANNUAL, TRADING_DAYS_YR, WINDOWS },
  };
  await db.collection(RESULT_COLL).replaceOne({ _id: 'latest' }, outDoc, { upsert: true });
  console.log(`\nResults saved to ${RESULT_COLL}._id = 'latest'`);

  await c.close();
}

main().catch(e => { console.error(e); process.exit(1); });
