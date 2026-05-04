// Box-Breakout — Capital-Neutral Tilt
//
// Apples-to-apples test: hold TOTAL capital deployed constant, hold trade
// count constant, but TILT allocation toward box-UP confirmed BL trades by
// shrinking non-box-confirmed BL trades just enough to keep aggregate
// capital deployment identical to baseline.
//
// Math:
//   Σ(M_high × box_trades.totalCost) + Σ(M_low × nobox_trades.totalCost)
//     = Σ(box_trades.totalCost + nobox_trades.totalCost)   [baseline capital]
//
//   M_low = 1 − (M_high − 1) × Σ(box.totalCost) / Σ(nobox.totalCost)
//
// All scaling applied via per-trade equity contribution series × M.
// SS trades unchanged. Pre-eligible (pre-2020-12-18) BL trades unchanged.

import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
dotenv.config();

const NAV_TIER       = 1000000;
const TRADE_COLL     = 'pnthr_bt_pyramid_nav_1m_trade_log';
const NAV_COLL       = 'pnthr_bt_pyramid_nav_1m_daily_nav_mtm_v21_recomputed';
const BOX_COLL       = 'pnthr_bt_box_alerts';
const CANDLE_COLL    = 'pnthr_bt_candles';
const RESULT_COLL    = 'pnthr_bt_box_capneutral_test';

const RISK_FREE_ANNUAL = 0.030;
const TRADING_DAYS_YR  = 252;
const WINDOWS = [3, 7, 14];
const M_HIGHS = [1.25, 1.5, 2.0];

function daysBetween(a, b) { return (new Date(a) - new Date(b)) / 86400000; }
function mean(arr) { return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0; }
function stdev(arr) { if (arr.length < 2) return 0; const m = mean(arr); return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1)); }
function maxDrawdown(navs) { let p = navs[0], dd = 0; for (const v of navs) { if (v > p) p = v; const x = (v - p) / p; if (x < dd) dd = x; } return dd; }
function computeMetrics(navByDate, dates) {
  const navs = dates.map(d => navByDate[d]);
  const startNav = navs[0], endNav = navs[navs.length - 1];
  const totalReturn = (endNav - startNav) / startNav;
  const years = dates.length / TRADING_DAYS_YR;
  const cagr = Math.pow(endNav / startNav, 1 / years) - 1;
  const ret = []; for (let i = 1; i < navs.length; i++) ret.push(navs[i] / navs[i - 1] - 1);
  const dailyRf = RISK_FREE_ANNUAL / TRADING_DAYS_YR;
  const sharpe = stdev(ret) > 0 ? (mean(ret.map(r => r - dailyRf)) / stdev(ret)) * Math.sqrt(TRADING_DAYS_YR) : 0;
  const downside = ret.filter(r => r < 0);
  const dDev = downside.length ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / ret.length) : 0;
  const sortino = dDev > 0 ? (mean(ret) / dDev) * Math.sqrt(TRADING_DAYS_YR) : 0;
  const dd = maxDrawdown(navs);
  const calmar = dd < 0 ? cagr / Math.abs(dd) : 0;
  return {
    cagr: +(cagr * 100).toFixed(2),
    sharpe: +sharpe.toFixed(2),
    sortino: +sortino.toFixed(2),
    calmar: +calmar.toFixed(2),
    maxDD: +(dd * 100).toFixed(2),
    totalReturn: +(totalReturn * 100).toFixed(2),
  };
}

function buildTradeEquitySeries(trade, candleByDate, allDates) {
  const dir = trade.signal === 'BL' ? +1 : -1;
  const lots = (trade.lots || []).filter(l => l.shares > 0);
  if (lots.length === 0) return {};
  const sortedLots = [...lots].sort((a, b) => a.fillDate.localeCompare(b.fillDate));
  const firstFill = sortedLots[0].fillDate;
  const exitDate = trade.exitDate;
  if (!exitDate) return {};
  const result = {};
  for (const d of allDates) {
    if (d < firstFill) continue;
    if (d >= exitDate) { result[d] = trade.netDollarPnl; continue; }
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
  const upBox = new Map();
  let earliestBoxDate = '9999-99-99';
  for (const d of boxes) {
    const ups = (d.boxes || []).filter(b => b.status === 'broken-up' && b.breakoutDate).map(b => b.breakoutDate);
    if (ups.length) upBox.set(d.ticker, ups.sort());
    for (const x of ups) if (x < earliestBoxDate) earliestBoxDate = x;
  }
  const ELIG = earliestBoxDate;
  console.log(`  ${trades.length} trades, ${navDocs.length} NAV days, ELIG from ${ELIG}`);

  const tickers = [...new Set(trades.map(t => t.ticker))];
  const candleDocs = await db.collection(CANDLE_COLL).find({ ticker: { $in: tickers } }).toArray();
  const candleByTicker = new Map();
  for (const d of candleDocs) {
    const m = {};
    for (const bar of (d.daily || [])) m[bar.date] = bar.close;
    candleByTicker.set(d.ticker, m);
  }

  // Per-trade baseline equity series + totalCost cache
  const baselineSeries = new Map();
  const tradeMeta = new Map();   // tid → { signal, eligible, totalCost, entryDate }
  for (const t of trades) {
    if (!t.exitDate || t.netDollarPnl == null) continue;
    const cand = candleByTicker.get(t.ticker);
    if (!cand) continue;
    const tid = t._id.toString();
    baselineSeries.set(tid, buildTradeEquitySeries(t, cand, allDates));
    tradeMeta.set(tid, {
      signal: t.signal,
      ticker: t.ticker,
      entryDate: t.entryDate,
      eligible: t.entryDate >= ELIG,
      totalCost: t.totalCost || 0,
    });
  }

  // Sanity check baseline
  const aggSeries = {};
  for (const series of baselineSeries.values()) {
    for (const [d, v] of Object.entries(series)) aggSeries[d] = (aggSeries[d] || 0) + v;
  }
  let rmsSum = 0;
  for (const d of allDates) {
    const rebuilt = prodNav[startDate] + (aggSeries[d] || 0);
    rmsSum += ((rebuilt - prodNav[d]) / prodNav[d]) ** 2;
  }
  console.log(`  Baseline RMS error: ${(Math.sqrt(rmsSum / allDates.length) * 100).toFixed(3)}%`);

  const baseline = computeMetrics(prodNav, allDates);
  console.log('\nBASELINE:', JSON.stringify(baseline));

  // Run capital-neutral tilt scenarios
  const scenarios = [];

  for (const W of WINDOWS) {
    // Identify eligible BL trades and their box-confirmed status
    const eligBlTrades = [];
    let boxCost = 0, noboxCost = 0;
    let boxCount = 0, noboxCount = 0;
    for (const [tid, meta] of tradeMeta.entries()) {
      if (meta.signal !== 'BL') continue;
      if (!meta.eligible) continue;
      const t = trades.find(x => x._id.toString() === tid);
      const d = nearestBoxBefore(meta.ticker, meta.entryDate, upBox, W);
      const isBox = d !== null;
      eligBlTrades.push({ tid, isBox });
      if (isBox) { boxCost += meta.totalCost; boxCount++; }
      else       { noboxCost += meta.totalCost; noboxCount++; }
    }

    for (const M_HIGH of M_HIGHS) {
      // Capital-neutral M_low: M_high × boxCost + M_low × noboxCost = boxCost + noboxCost
      const M_LOW = 1 - (M_HIGH - 1) * boxCost / noboxCost;
      // (M_LOW must stay positive — sanity check)
      if (M_LOW <= 0) {
        console.log(`  Skip W=${W} M_HIGH=${M_HIGH}: M_low would go negative`);
        continue;
      }

      const cfNav = { ...prodNav };
      let scaledBoxPnl = 0, scaledNoboxPnl = 0, baseBoxPnl = 0, baseNoboxPnl = 0;

      for (const { tid, isBox } of eligBlTrades) {
        const M = isBox ? M_HIGH : M_LOW;
        const baseSer = baselineSeries.get(tid);
        const t = trades.find(x => x._id.toString() === tid);
        baseBoxPnl   += isBox ? t.netDollarPnl : 0;
        baseNoboxPnl += isBox ? 0 : t.netDollarPnl;
        scaledBoxPnl   += isBox ? t.netDollarPnl * M : 0;
        scaledNoboxPnl += isBox ? 0 : t.netDollarPnl * M;
        // Apply (M-1) × baseline series to NAV (baseline already in cfNav)
        for (const d of allDates) {
          const v = baseSer[d];
          if (v != null) cfNav[d] += (M - 1) * v;
        }
      }

      const m = computeMetrics(cfNav, allDates);
      scenarios.push({
        window: W, M_HIGH, M_LOW: +M_LOW.toFixed(4),
        boxCount, noboxCount,
        boxCostUsd: Math.round(boxCost), noboxCostUsd: Math.round(noboxCost),
        boxBaseNetPnl: Math.round(baseBoxPnl),
        noboxBaseNetPnl: Math.round(baseNoboxPnl),
        boxScaledNetPnl: Math.round(scaledBoxPnl),
        noboxScaledNetPnl: Math.round(scaledNoboxPnl),
        ...m,
      });
    }
  }

  // ── Print ──
  console.log('\n');
  console.log('═'.repeat(120));
  console.log('CAPITAL-NEUTRAL TILT — Wagyu $1M, BL only, eligible period only');
  console.log('═'.repeat(120));
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('Scenario', 40) + pad('M_high', 8) + pad('M_low', 8) + pad('CAGR', 9) + pad('Shrp', 7) + pad('Srtn', 7) + pad('Calm', 7) + pad('MaxDD', 9) + pad('TotalRet', 12));
  console.log('─'.repeat(120));
  console.log(pad('BASELINE', 40) + pad('—', 8) + pad('—', 8) + pad(baseline.cagr + '%', 9) + pad(baseline.sharpe, 7) + pad(baseline.sortino, 7) + pad(baseline.calmar, 7) + pad(baseline.maxDD + '%', 9) + pad(baseline.totalReturn + '%', 12));
  for (const s of scenarios) {
    const label = `Tilt ±${s.window}d  (box ${s.boxCount} | nobox ${s.noboxCount})`;
    console.log(
      pad(label, 40) +
      pad(s.M_HIGH + '×', 8) +
      pad(s.M_LOW.toFixed(3) + '×', 8) +
      pad(s.cagr + '%', 9) +
      pad(s.sharpe, 7) +
      pad(s.sortino, 7) +
      pad(s.calmar, 7) +
      pad(s.maxDD + '%', 9) +
      pad(s.totalReturn + '%', 12)
    );
  }

  await db.collection(RESULT_COLL).replaceOne({ _id: 'latest' }, {
    _id: 'latest',
    runAt: new Date(),
    methodology: 'Capital-neutral tilt: M_high on BL+box-UP (≤W days before), M_low on other eligible BL, total cost held constant',
    baseline,
    scenarios,
    parameters: { NAV_TIER, RISK_FREE_ANNUAL, TRADING_DAYS_YR, WINDOWS, M_HIGHS, ELIG },
  }, { upsert: true });
  console.log(`\nResults saved to ${RESULT_COLL}._id = 'latest'`);

  await c.close();
}

main().catch(e => { console.error(e); process.exit(1); });
