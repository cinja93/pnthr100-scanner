// server/scripts_den/compute_per_tier_ir_metrics.js
//
// Comprehensive per-tier Intelligence Report metrics — read-only computation
// against the canonical v21-MTM + PPM-fee daily NAV collections.
//
// Outputs one JSON file per tier to ~/Downloads/pnthr_ir_metrics_{tier}_2026_04_21.json
//
// Methodology (per user preferences):
//   Sharpe  : daily excess over US 3-mo T-Bill, annualized by sqrt(252)
//   Sortino : MAR=0, HFRI convention (sum(min(0,r)^2) / TOTAL_N), sqrt(252) annualize
//   MaxDD   : peak-to-trough on daily MTM equity curve
//   Calmar  : CAGR / |MaxDD|
//   Ulcer   : sqrt(mean(drawdown^2)) over full series
//   Recovery: TotalReturn / |MaxDD|
//   CAGR    : (end/start)^(1/years) - 1
//
// Baseline verification (handoff §1.7 v22-corrected values):
//   Filet       Gross CAGR 38.48  Sharpe 2.54  Sortino 4.59  MaxDD -8.63
//   Porterhouse Gross CAGR 38.77  Sharpe 2.59  Sortino 4.71  MaxDD -8.52
//   Wagyu       Gross CAGR 38.78  Sharpe 2.59  Sortino 4.72  MaxDD -8.51
//   Filet       Net   CAGR 25.81  Sharpe 1.64  Sortino 2.71  MaxDD -9.99
//   Porterhouse Net   CAGR 27.73  Sharpe 1.81  Sortino 3.07  MaxDD -9.36
//   Wagyu       Net   CAGR 29.48  Sharpe 1.95  Sortino 3.39  MaxDD -8.82

import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const DB_NAME = process.env.MONGODB_DB_NAME || 'pnthr_den';

// ── US 3-month Treasury Bill yield, first trading day of each year (FRED DTB3) ──
const US3MT_PCT = {
  2019: 2.40, 2020: 1.56, 2021: 0.06, 2022: 0.09,
  2023: 4.29, 2024: 5.40, 2025: 4.30, 2026: 4.29,  // 2026 close to 2025 level
};

const TIERS = [
  { key: '100k',  label: 'Filet',       classLabel: 'Filet Class',       seedNav: 100000,   feeYr1to3: 30, feeYr4plus: 25 },
  { key: '500k',  label: 'Porterhouse', classLabel: 'Porterhouse Class', seedNav: 500000,   feeYr1to3: 25, feeYr4plus: 20 },
  { key: '1m',    label: 'Wagyu',       classLabel: 'Wagyu Class',       seedNav: 1000000,  feeYr1to3: 20, feeYr4plus: 15 },
];

// ── Metric helpers ──────────────────────────────────────────────────────────

function daysBetween(d1, d2) {
  return (new Date(d2) - new Date(d1)) / 86400000;
}

function yearsBetween(d1, d2) {
  return daysBetween(d1, d2) / 365.25;
}

function dailyReturns(equity) {
  const r = [];
  for (let i = 1; i < equity.length; i++) {
    r.push((equity[i] - equity[i-1]) / equity[i-1]);
  }
  return r;
}

function computeSharpe(dailyRet, dates) {
  // Per-year risk-free: lookup by date year. Excess return per day = ret - rf_daily.
  const mean_excess = dailyRet.reduce((s, r, i) => {
    const year = new Date(dates[i+1]).getUTCFullYear();
    const rf_annual = (US3MT_PCT[year] ?? 4.0) / 100;
    const rf_daily = rf_annual / 252;
    return s + (r - rf_daily);
  }, 0) / dailyRet.length;
  const std = Math.sqrt(dailyRet.reduce((s, r) => s + (r - dailyRet.reduce((a,x)=>a+x,0)/dailyRet.length) ** 2, 0) / dailyRet.length);
  return std > 0 ? (mean_excess / std) * Math.sqrt(252) : 0;
}

function computeSortino(dailyRet) {
  // HFRI convention: MAR = 0, downside deviation uses TOTAL N in denominator
  const mean = dailyRet.reduce((s, r) => s + r, 0) / dailyRet.length;
  const downSumSq = dailyRet.reduce((s, r) => s + (r < 0 ? r*r : 0), 0);
  const downDev = Math.sqrt(downSumSq / dailyRet.length);
  return downDev > 0 ? (mean / downDev) * Math.sqrt(252) : 0;
}

function computeMaxDD(equity, dates) {
  let peak = equity[0];
  let peakIdx = 0;
  let maxDD = 0;
  let maxDDStart = dates[0];
  let maxDDTrough = dates[0];
  let recoveryDate = null;
  let maxDDDays = 0;
  let curPeakStart = dates[0];
  for (let i = 0; i < equity.length; i++) {
    if (equity[i] > peak) {
      peak = equity[i];
      peakIdx = i;
      curPeakStart = dates[i];
    }
    const dd = (equity[i] - peak) / peak;  // negative
    if (dd < maxDD) {
      maxDD = dd;
      maxDDStart = curPeakStart;
      maxDDTrough = dates[i];
      // Find recovery date (first date after trough where equity >= peak)
      recoveryDate = null;
      for (let j = i + 1; j < equity.length; j++) {
        if (equity[j] >= peak) { recoveryDate = dates[j]; break; }
      }
    }
  }
  if (recoveryDate) maxDDDays = Math.round(daysBetween(maxDDStart, recoveryDate));
  return { maxDD: maxDD * 100, maxDDStart, maxDDTrough, recoveryDate, maxDDDays };
}

function computeUlcerIndex(equity) {
  let peak = equity[0];
  const ddSq = [];
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = (e - peak) / peak;  // negative
    ddSq.push(dd * dd);
  }
  return Math.sqrt(ddSq.reduce((s, x) => s + x, 0) / ddSq.length) * 100;
}

function computeTimeUnderWater(equity) {
  let peak = equity[0];
  let underWater = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    if (e < peak) underWater++;
  }
  return (underWater / equity.length) * 100;
}

function groupMonthly(equity, dates) {
  const months = new Map();
  for (let i = 0; i < equity.length; i++) {
    const m = String(dates[i]).slice(0, 7);
    if (!months.has(m)) months.set(m, { first: equity[i], last: equity[i] });
    months.get(m).last = equity[i];
  }
  return [...months.entries()].map(([m, { first, last }]) => ({
    m,
    ret: ((last - first) / first) * 100,
  }));
}

function groupAnnual(equity, dates) {
  const years = new Map();
  for (let i = 0; i < equity.length; i++) {
    const y = String(dates[i]).slice(0, 4);
    if (!years.has(y)) years.set(y, { first: equity[i], last: equity[i] });
    years.get(y).last = equity[i];
  }
  return [...years.entries()].map(([y, { first, last }]) => ({
    year: y,
    startEquity: +first.toFixed(2),
    endEquity:   +last.toFixed(2),
    ret: +(((last - first) / first) * 100).toFixed(2),
  }));
}

function topNDrawdowns(equity, dates, n = 5) {
  // Find distinct drawdown events (peak -> trough -> recovery). Return top-N by depth.
  const events = [];
  let peak = equity[0];
  let peakDate = dates[0];
  let inDD = false;
  let trough = peak;
  let troughDate = peakDate;
  for (let i = 0; i < equity.length; i++) {
    if (equity[i] > peak) {
      // New peak. If we were in a drawdown, close it out (recovery = this date).
      if (inDD && trough < peak) {
        events.push({
          start: peakDate,
          trough: troughDate,
          recovery: dates[i],
          duration: Math.round(daysBetween(peakDate, dates[i])),
          depthPct: +(((trough - peak) / peak) * 100).toFixed(2),
        });
      }
      peak = equity[i];
      peakDate = dates[i];
      inDD = false;
      trough = peak;
      troughDate = peakDate;
    } else if (equity[i] < peak) {
      if (equity[i] < trough) {
        trough = equity[i];
        troughDate = dates[i];
      }
      inDD = true;
    }
  }
  // Ongoing unrecovered DD
  if (inDD && trough < peak) {
    events.push({
      start: peakDate,
      trough: troughDate,
      recovery: null,
      duration: Math.round(daysBetween(peakDate, dates[dates.length-1])),
      depthPct: +(((trough - peak) / peak) * 100).toFixed(2),
    });
  }
  return events.sort((a, b) => a.depthPct - b.depthPct).slice(0, n);
}

function rolling12mReturns(equity, dates) {
  // Take month-end equities, compute 12-month trailing returns.
  const monthlyEnds = new Map();
  for (let i = 0; i < equity.length; i++) {
    const m = String(dates[i]).slice(0, 7);
    monthlyEnds.set(m, equity[i]);
  }
  const months = [...monthlyEnds.entries()].sort(([a], [b]) => a.localeCompare(b));
  const results = [];
  for (let i = 12; i < months.length; i++) {
    const start = months[i - 12][1];
    const end = months[i][1];
    results.push({
      endMonth: months[i][0],
      ret: +(((end - start) / start) * 100).toFixed(2),
    });
  }
  return results;
}

function topNDailyReturns(equity, dates, n, worst = false) {
  const ret = dailyReturns(equity);
  const items = ret.map((r, i) => ({ date: dates[i+1], ret: +(r * 100).toFixed(3), equity: +equity[i+1].toFixed(2) }));
  items.sort((a, b) => worst ? a.ret - b.ret : b.ret - a.ret);
  return items.slice(0, n);
}

// ── Trade stats ──────────────────────────────────────────────────────────────

function computeTradeStats(trades) {
  const closed = trades.filter(t => t.closed && t.exitReason !== 'STILL_OPEN');
  const open = trades.length - closed.length;
  const bl = closed.filter(t => t.signal === 'BL');
  const ss = closed.filter(t => t.signal === 'SS');
  function tradePnl(t) {
    return (t.lots || []).reduce((s, l) => s + (l.netDollarPnl || 0), 0);
  }
  function statsOf(arr) {
    let wins = 0, losses = 0, grossWin = 0, grossLoss = 0;
    for (const t of arr) {
      const pnl = tradePnl(t);
      if (pnl > 0) { wins++; grossWin += pnl; }
      else if (pnl < 0) { losses++; grossLoss += -pnl; }
    }
    return {
      total: arr.length,
      wins, losses,
      winRate: wins + losses > 0 ? +((wins / (wins + losses)) * 100).toFixed(1) : 0,
      profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : 0,
      grossWin: +grossWin.toFixed(2),
      grossLoss: +grossLoss.toFixed(2),
    };
  }
  const combined = statsOf(closed);
  return {
    total: trades.length,
    closed: closed.length,
    open,
    bl: { count: bl.length, ...statsOf(bl) },
    ss: { count: ss.length, ...statsOf(ss) },
    combined: { ...combined },
  };
}

function top10MAE(trades) {
  // Rank by most negative MAE pct
  const items = trades
    .filter(t => t.closed && typeof t.mae === 'number')
    .map(t => {
      const pnl = (t.lots || []).reduce((s, l) => s + (l.netDollarPnl || 0), 0);
      return {
        ticker: t.ticker,
        signal: t.signal,
        entryDate: String(t.entryDate).slice(0, 10),
        exitDate:  String(t.exitDate).slice(0, 10),
        maePct: +(t.mae || 0).toFixed(1),
        netPnl: +pnl.toFixed(2),
        exitReason: t.exitReason,
      };
    })
    .sort((a, b) => a.maePct - b.maePct)
    .slice(0, 10);
  return items;
}

// ── Per-direction metrics (realized NAV curve from trades) ─────────────────

function buildRealizedNav(trades, startNav, startDate, endDate) {
  // Group realized P&L by exitDate
  const byDate = new Map();
  for (const t of trades) {
    const d = String(t.exitDate).slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, 0);
    const pnl = (t.lots || []).reduce((s, l) => s + (l.netDollarPnl || 0), 0);
    byDate.set(d, byDate.get(d) + pnl);
  }
  // Generate business day sequence between startDate and endDate
  const dates = [];
  const series = [];
  const cur = new Date(startDate);
  const end = new Date(endDate);
  let nav = startNav;
  while (cur <= end) {
    const dow = cur.getUTCDay();
    if (dow >= 1 && dow <= 5) {
      const d = cur.toISOString().slice(0, 10);
      if (byDate.has(d)) nav += byDate.get(d);
      dates.push(d);
      series.push(nav);
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return { dates, series };
}

function perDirectionMetrics(trades, seedNav, startDate, endDate) {
  const closed = trades.filter(t => t.closed && t.exitReason !== 'STILL_OPEN');
  const bl = closed.filter(t => t.signal === 'BL');
  const ss = closed.filter(t => t.signal === 'SS');
  function metricsOf(subset) {
    const { dates, series } = buildRealizedNav(subset, seedNav, startDate, endDate);
    const ret = dailyReturns(series);
    const sharpe = computeSharpe(ret, dates);
    const sortino = computeSortino(ret);
    const maxDD = computeMaxDD(series, dates).maxDD;
    const years = yearsBetween(dates[0], dates[dates.length-1]);
    const totalReturn = ((series[series.length-1] - series[0]) / series[0]) * 100;
    const cagr = (Math.pow(series[series.length-1] / series[0], 1 / years) - 1) * 100;
    const calmar = Math.abs(maxDD) > 0 ? cagr / Math.abs(maxDD) : 0;
    const monthly = groupMonthly(series, dates);
    const posMonths = monthly.filter(m => m.ret > 0).length;
    const best = monthly.reduce((b, m) => m.ret > b.ret ? m : b);
    const worst = monthly.reduce((w, m) => m.ret < w.ret ? m : w);
    const mean = monthly.reduce((s, m) => s + m.ret, 0) / monthly.length;
    const std = Math.sqrt(monthly.reduce((s, m) => s + (m.ret - mean)**2, 0) / monthly.length);
    return {
      cagr: +cagr.toFixed(2),
      sharpe: +sharpe.toFixed(2),
      sortino: +sortino.toFixed(2),
      maxDD: +maxDD.toFixed(2),
      calmar: +calmar.toFixed(2),
      totalReturn: +totalReturn.toFixed(2),
      bestMonth: { m: best.m, ret: +best.ret.toFixed(2) },
      worstMonth: { m: worst.m, ret: +worst.ret.toFixed(2) },
      positiveMonths: posMonths,
      totalMonths: monthly.length,
      positivePct: +((posMonths / monthly.length) * 100).toFixed(1),
      avgMonthly: +mean.toFixed(2),
      stdMonthly: +std.toFixed(2),
    };
  }
  return {
    bl: { count: bl.length, ...metricsOf(bl) },
    ss: { count: ss.length, ...metricsOf(ss) },
    combined: { count: closed.length, ...metricsOf(closed) },
  };
}

// ── SPY benchmark ───────────────────────────────────────────────────────────

function spyMetrics(spyDaily, startDate, endDate, seedNav) {
  const inRange = spyDaily
    .filter(b => b.date >= startDate && b.date <= endDate)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (inRange.length === 0) return null;
  const closes = inRange.map(b => b.close);
  const dates  = inRange.map(b => b.date);
  // SPY $1 at start → equity scaled to seedNav
  const equity = closes.map(c => (c / closes[0]) * seedNav);
  const ret = dailyReturns(equity);
  const years = yearsBetween(dates[0], dates[dates.length-1]);
  const totalReturn = ((equity[equity.length-1] - equity[0]) / equity[0]) * 100;
  const cagr = (Math.pow(equity[equity.length-1] / equity[0], 1/years) - 1) * 100;
  const sharpe = computeSharpe(ret, dates);
  const sortino = computeSortino(ret);
  const ddInfo = computeMaxDD(equity, dates);
  return {
    startDate: dates[0], endDate: dates[dates.length-1],
    startPrice: +closes[0].toFixed(2), endPrice: +closes[closes.length-1].toFixed(2),
    totalReturn: +totalReturn.toFixed(2),
    cagr: +cagr.toFixed(2),
    sharpe: +sharpe.toFixed(2),
    sortino: +sortino.toFixed(2),
    maxDD: +ddInfo.maxDD.toFixed(2),
    endingEquity: +equity[equity.length-1].toFixed(2),
  };
}

function crisisAlpha(grossEquity, grossDates, spyDaily, events, seedNav) {
  // grossEquity = pnthr equity series
  const spySorted = [...spyDaily].sort((a, b) => a.date.localeCompare(b.date));
  function findClose(series, dates, target) {
    // find closest date >= target that has equity
    for (let i = 0; i < dates.length; i++) {
      if (dates[i] >= target) return { date: dates[i], val: series[i] };
    }
    return null;
  }
  function findSpyClose(target) {
    for (const b of spySorted) if (b.date >= target) return { date: b.date, val: b.close };
    return null;
  }
  const results = [];
  for (const ev of events) {
    const pnthrStart = findClose(grossEquity, grossDates, ev.start);
    const pnthrEnd   = findClose(grossEquity, grossDates, ev.end);
    const spyStart   = findSpyClose(ev.start);
    const spyEnd     = findSpyClose(ev.end);
    if (!pnthrStart || !pnthrEnd || !spyStart || !spyEnd) {
      results.push({ event: ev.label, period: `${ev.start} to ${ev.end}`, spyReturn: null, pnthrReturn: null, alpha: null });
      continue;
    }
    const pnthrRet = ((pnthrEnd.val - pnthrStart.val) / pnthrStart.val) * 100;
    const spyRet   = ((spyEnd.val  - spyStart.val)  / spyStart.val) * 100;
    results.push({
      event: ev.label,
      period: `${ev.start} to ${ev.end}`,
      spyReturn: +spyRet.toFixed(2),
      pnthrReturn: +pnthrRet.toFixed(2),
      alpha: +(pnthrRet - spyRet).toFixed(2),
    });
  }
  return results;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const c = new MongoClient(process.env.MONGODB_URI);
  await c.connect();
  const db = c.db(DB_NAME);

  const spyDoc = await db.collection('pnthr_bt_candles').findOne({ ticker: 'SPY' });
  const spyDaily = spyDoc?.daily || [];

  const CRISIS_EVENTS = [
    { label: 'COVID Crash',                    start: '2020-02-19', end: '2020-03-23' },
    { label: '2022 Bear Market',               start: '2022-01-03', end: '2022-10-12' },
    { label: '2025 Liberation Day Correction', start: '2025-02-19', end: '2025-04-08' },
    { label: '2020 September Correction',      start: '2020-09-02', end: '2020-09-23' },
    { label: '2024 August Correction',         start: '2024-07-16', end: '2024-08-05' },
    { label: '2019 August Correction',         start: '2019-07-26', end: '2019-08-05' },
  ];

  const output = {};

  for (const tier of TIERS) {
    console.log(`\n── ${tier.label} (${tier.key}) ──`);
    const grossDocs = await db.collection(`pnthr_bt_pyramid_nav_${tier.key}_daily_nav_mtm_v21_recomputed`)
      .find({}).sort({ date: 1 }).toArray();
    const netDocs   = await db.collection(`pnthr_bt_pyramid_nav_${tier.key}_daily_nav_mtm_v21_net_recomputed`)
      .find({}).sort({ date: 1 }).toArray();
    const trades    = await db.collection(`pnthr_bt_pyramid_nav_${tier.key}_trade_log`).find({}).toArray();

    function computeSide(docs, field) {
      const dates  = docs.map(d => String(d.date).slice(0, 10));
      const equity = docs.map(d => +d[field]);
      const ret = dailyReturns(equity);
      const years = yearsBetween(dates[0], dates[dates.length-1]);
      const totalReturn = ((equity[equity.length-1] - equity[0]) / equity[0]) * 100;
      const cagr = (Math.pow(equity[equity.length-1] / equity[0], 1/years) - 1) * 100;
      const sharpe = computeSharpe(ret, dates);
      const sortino = computeSortino(ret);
      const ddInfo = computeMaxDD(equity, dates);
      const calmar = Math.abs(ddInfo.maxDD) > 0 ? cagr / Math.abs(ddInfo.maxDD) : 0;
      const ulcer = computeUlcerIndex(equity);
      const tuw = computeTimeUnderWater(equity);
      const recoveryFactor = Math.abs(ddInfo.maxDD) > 0 ? totalReturn / Math.abs(ddInfo.maxDD) : 0;
      const monthly = groupMonthly(equity, dates);
      const annual = groupAnnual(equity, dates);
      const posMonths = monthly.filter(m => m.ret > 0).length;
      const best = monthly.reduce((b, m) => m.ret > b.ret ? m : b);
      const worst = monthly.reduce((w, m) => m.ret < w.ret ? m : w);
      const meanM = monthly.reduce((s, m) => s + m.ret, 0) / monthly.length;
      const stdM  = Math.sqrt(monthly.reduce((s, m) => s + (m.ret - meanM)**2, 0) / monthly.length);
      const top5DD = topNDrawdowns(equity, dates, 5);
      const r12m = rolling12mReturns(equity, dates);
      const top10Worst = topNDailyReturns(equity, dates, 10, true);
      const top10Best  = topNDailyReturns(equity, dates, 10, false);
      return {
        startDate: dates[0],
        endDate: dates[dates.length-1],
        years: +years.toFixed(2),
        startNav: +equity[0].toFixed(2),
        endNav: +equity[equity.length-1].toFixed(2),
        totalReturn: +totalReturn.toFixed(2),
        cagr: +cagr.toFixed(2),
        sharpe: +sharpe.toFixed(2),
        sortino: +sortino.toFixed(2),
        maxDD: +ddInfo.maxDD.toFixed(2),
        maxDDStart: ddInfo.maxDDStart,
        maxDDTrough: ddInfo.maxDDTrough,
        maxDDRecovery: ddInfo.recoveryDate,
        maxDDDays: ddInfo.maxDDDays,
        calmar: +calmar.toFixed(2),
        ulcerIndex: +ulcer.toFixed(2),
        recoveryFactor: +recoveryFactor.toFixed(2),
        timeUnderWater: +tuw.toFixed(2),
        positiveMonths: posMonths,
        totalMonths: monthly.length,
        positivePct: +((posMonths / monthly.length) * 100).toFixed(1),
        bestMonth: { m: best.m, ret: +best.ret.toFixed(2) },
        worstMonth: { m: worst.m, ret: +worst.ret.toFixed(2) },
        avgMonthlyReturn: +meanM.toFixed(2),
        monthlyStdDev: +stdM.toFixed(2),
        monthlyReturns: monthly.map(m => ({ m: m.m, ret: +m.ret.toFixed(2) })),
        annualReturns: annual,
        top5Drawdowns: top5DD,
        rolling12m: r12m,
        top10WorstDays: top10Worst,
        top10BestDays: top10Best,
      };
    }

    const gross = computeSide(grossDocs, 'equity');
    const net   = computeSide(netDocs,   'netEquity');

    // ── Build per-day activity map (OPEN/CLOSE events) for Act III proof log ──
    // opensByDate[yyyy-mm-dd] = { BL: [ticker], SS: [ticker] }
    // closesByDate[yyyy-mm-dd] = [{ ticker, netPnl }]
    // (Open = entryDate; Close = exitDate if closed, with sum of lot netDollarPnl)
    const opensByDate = new Map();
    const closesByDate = new Map();
    const openStartByTicker = new Map();  // ticker -> entryDate (for openCount on each day)
    const openEndByTicker   = new Map();  // ticker -> exitDate (null if still open)
    for (const t of trades) {
      const ed = String(t.entryDate).slice(0, 10);
      if (!opensByDate.has(ed)) opensByDate.set(ed, { BL: [], SS: [] });
      opensByDate.get(ed)[t.signal].push(t.ticker);
      if (t.closed && t.exitReason !== 'STILL_OPEN' && t.exitDate) {
        const xd = String(t.exitDate).slice(0, 10);
        const pnl = (t.lots || []).reduce((s, l) => s + (l.netDollarPnl || 0), 0);
        if (!closesByDate.has(xd)) closesByDate.set(xd, []);
        closesByDate.get(xd).push({ ticker: t.ticker, netPnl: Math.round(pnl) });
        openStartByTicker.set(t.ticker + '|' + ed, { entry: ed, exit: xd });
      } else {
        openStartByTicker.set(t.ticker + '|' + ed, { entry: ed, exit: null });
      }
    }

    // Build SPY equity scaled to seedNav on the same dates as the PNTHR gross series
    const spySorted = [...spyDaily].sort((a, b) => a.date.localeCompare(b.date));
    const spyByDate = new Map(spySorted.map(b => [b.date, b.close]));
    const pnthrStartDate = String(grossDocs[0].date).slice(0, 10);
    let spyStartClose = null;
    for (const b of spySorted) {
      if (b.date >= pnthrStartDate) { spyStartClose = b.close; break; }
    }
    let lastKnownSpy = spyStartClose;
    function spyEquityOn(date) {
      const c = spyByDate.get(date);
      if (c != null) { lastKnownSpy = c; }
      return (lastKnownSpy / spyStartClose) * tier.seedNav;
    }

    // Full daily NAV series for Act III proof table (gross + net aligned by date,
    // with SPY equity, positions open, MTD %, and activity description).
    const dailySeries = [];
    let gPeak = +grossDocs[0].equity;
    let nPeak = +netDocs[0].netEquity;
    let curMonth = '';
    let monthStartNetNav = null;
    let monthStartSpy = null;
    let monthOpenCount = null;  // positions at start of month
    let monthOpened = 0, monthClosed = 0, monthNetPL = 0;
    const monthSummaryByMonth = new Map();  // key yyyy-mm -> { opened, closed, endOpen, netPL, start nav, mtd }

    function pnlStr(p) {
      if (p == null) return '';
      const n = Math.round(p);
      return n >= 0 ? `+$${n}` : `-$${Math.abs(n)}`;
    }

    for (let i = 0; i < grossDocs.length; i++) {
      const date = String(grossDocs[i].date).slice(0, 10);
      const g = +grossDocs[i].equity;
      const n = i < netDocs.length ? +netDocs[i].netEquity : null;
      if (g > gPeak) gPeak = g;
      if (n != null && n > nPeak) nPeak = n;
      const gDD = ((g - gPeak) / gPeak) * 100;
      const nDD = n != null ? ((n - nPeak) / nPeak) * 100 : null;

      const ym = date.slice(0, 7);
      if (ym !== curMonth) {
        curMonth = ym;
        monthStartNetNav = n;
        monthStartSpy = spyEquityOn(date);
      }

      // Count positions open at END of this day
      let openCount = 0;
      for (const info of openStartByTicker.values()) {
        if (info.entry <= date && (info.exit == null || info.exit > date)) openCount++;
      }

      // Build activity string
      const opens = opensByDate.get(date);
      const closes = closesByDate.get(date) || [];
      const parts = [];
      if (opens) {
        if (opens.BL.length) parts.push(`OPEN: ${opens.BL.join(', ')} (all BL)`);
        if (opens.SS.length) parts.push(`OPEN: ${opens.SS.join(', ')} (all SS)`);
      }
      if (closes.length) {
        parts.push('CLOSE: ' + closes.map(c => `${c.ticker} ${pnlStr(c.netPnl)}`).join(', '));
      }
      const activity = parts.join(' ');

      // Month-to-date % (NET)
      const mtdPct = monthStartNetNav && monthStartNetNav > 0
        ? ((n - monthStartNetNav) / monthStartNetNav) * 100
        : 0;

      dailySeries.push({
        date,
        gross: +g.toFixed(2),
        grossDD: +gDD.toFixed(2),
        net: n != null ? +n.toFixed(2) : null,
        netDD: nDD != null ? +nDD.toFixed(2) : null,
        spyEquity: +spyEquityOn(date).toFixed(0),
        openCount,
        mtdPct: +mtdPct.toFixed(2),
        activity,
        opensList: opens ? { BL: opens.BL, SS: opens.SS } : { BL: [], SS: [] },
        closesList: closes,
      });
    }

    // Build monthlyActivitySummary: for each month, count opens/closes + sum P&L + MTD %
    const monthlyActivitySummary = [];
    const monthsInOrder = [...new Set(dailySeries.map(d => d.date.slice(0, 7)))];
    for (const m of monthsInOrder) {
      const daysInMonth = dailySeries.filter(d => d.date.startsWith(m));
      const startNet = daysInMonth[0].net;
      const endNet   = daysInMonth[daysInMonth.length - 1].net;
      const startSpy = daysInMonth[0].spyEquity;
      const endSpy   = daysInMonth[daysInMonth.length - 1].spyEquity;
      const spyPct = startSpy ? ((endSpy - startSpy) / startSpy) * 100 : 0;
      const netPct = startNet ? ((endNet - startNet) / startNet) * 100 : 0;
      let opened = 0, closed = 0, netPL = 0;
      for (const d of daysInMonth) {
        opened += d.opensList.BL.length + d.opensList.SS.length;
        closed += d.closesList.length;
        netPL  += d.closesList.reduce((s, c) => s + c.netPnl, 0);
      }
      const endOpen = daysInMonth[daysInMonth.length - 1].openCount;
      monthlyActivitySummary.push({
        month: m,
        startNav: +startNet.toFixed(0),
        spyPct: +spyPct.toFixed(2),
        netPct: +netPct.toFixed(2),
        opened, closed, endOpen,
        netPL: Math.round(netPL),
      });
    }

    gross.dailySeries = dailySeries;
    gross.monthlyActivitySummary = monthlyActivitySummary;
    const tradeStats = computeTradeStats(trades);
    const mae10 = top10MAE(trades);
    const byDir = perDirectionMetrics(trades, tier.seedNav, gross.startDate, gross.endDate);
    const spy = spyMetrics(spyDaily, gross.startDate, gross.endDate, tier.seedNav);
    const crisisGrossEq   = grossDocs.map(d => +d.equity);
    const crisisGrossDates= grossDocs.map(d => String(d.date).slice(0,10));
    const crisisGross = crisisAlpha(crisisGrossEq, crisisGrossDates, spyDaily, CRISIS_EVENTS, tier.seedNav);
    const crisisNetEq    = netDocs.map(d => +d.netEquity);
    const crisisNetDates = netDocs.map(d => String(d.date).slice(0,10));
    const crisisNet      = crisisAlpha(crisisNetEq, crisisNetDates, spyDaily, CRISIS_EVENTS, tier.seedNav);

    const alphaTR = net.totalReturn - spy.totalReturn;
    const alphaCAGR = net.cagr - spy.cagr;
    const alphaEndingEq = net.endNav - spy.endingEquity;

    const tierOutput = {
      tier: tier.key,
      label: tier.label,
      classLabel: tier.classLabel,
      seedNav: tier.seedNav,
      feeSchedule: { yearsOneToThree: tier.feeYr1to3, yearsFourPlus: tier.feeYr4plus },
      gross, net,
      trades: tradeStats,
      mae10,
      byDirection: byDir,
      spy,
      crisisAlphaGross: crisisGross,
      crisisAlphaNet: crisisNet,
      alphaVsSpy: {
        totalReturnPts: +alphaTR.toFixed(2),
        cagrPts: +alphaCAGR.toFixed(2),
        endingEquityDelta: +alphaEndingEq.toFixed(2),
      },
      generatedAt: new Date().toISOString(),
    };

    // Print baseline-check summary
    console.log(`  Gross: CAGR ${gross.cagr}  Sharpe ${gross.sharpe}  Sortino ${gross.sortino}  MaxDD ${gross.maxDD}`);
    console.log(`  Net  : CAGR ${net.cagr}    Sharpe ${net.sharpe}    Sortino ${net.sortino}    MaxDD ${net.maxDD}`);
    console.log(`  Closed trades: ${tradeStats.closed}  Win rate: ${tradeStats.combined.winRate}%  PF: ${tradeStats.combined.profitFactor}`);

    output[tier.key] = tierOutput;

    // Write per-tier JSON
    const outFile = path.join(os.homedir(), 'Downloads', `pnthr_ir_metrics_${tier.key}_2026_04_21.json`);
    fs.writeFileSync(outFile, JSON.stringify(tierOutput, null, 2));
    console.log(`  Written: ${outFile}`);
  }

  await c.close();
  console.log('\nDone.');
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
