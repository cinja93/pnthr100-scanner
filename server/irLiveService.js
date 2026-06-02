// server/irLiveService.js
// Live Intelligence Report — serves backtest metrics via API.
// Reads from pnthr_ai_bt_pyramid_nav_{tier} collections (same as IR PDF generator).

import { connectToDatabase } from './database.js';

const US3MT_PCT = { 2022: 0.09, 2023: 4.29, 2024: 5.40, 2025: 4.30, 2026: 4.29 };

const TIERS = {
  '1m':   { key: '1m',   label: 'Wagyu',       seedNav: 1000000, feeYr1to3: 20, feeYr4plus: 15 },
  '500k': { key: '500k', label: 'Porterhouse',  seedNav: 500000,  feeYr1to3: 25, feeYr4plus: 20 },
  '100k': { key: '100k', label: 'Filet',        seedNav: 100000,  feeYr1to3: 30, feeYr4plus: 25 },
};

export const CRISIS_EVENTS = [
  { label: '2025 Liberation Day Correction', start: '2025-02-19', end: '2025-04-08' },
  { label: '2024 August Correction',         start: '2024-07-16', end: '2024-08-05' },
  { label: '2023 Regional Bank Crisis',      start: '2023-02-02', end: '2023-03-13' },
  { label: '2024 April Pullback',            start: '2024-03-28', end: '2024-04-19' },
];

function daysBetween(d1, d2) { return (new Date(d2) - new Date(d1)) / 86400000; }
function yearsBetween(d1, d2) { return daysBetween(d1, d2) / 365.25; }

function dailyReturns(equity) {
  const r = [];
  for (let i = 1; i < equity.length; i++) r.push((equity[i] - equity[i-1]) / equity[i-1]);
  return r;
}

export function computeSharpe(dailyRet, dates) {
  const mean_excess = dailyRet.reduce((s, r, i) => {
    const year = new Date(dates[i+1]).getUTCFullYear();
    const rf_daily = ((US3MT_PCT[year] ?? 4.0) / 100) / 252;
    return s + (r - rf_daily);
  }, 0) / dailyRet.length;
  const mean = dailyRet.reduce((a, x) => a + x, 0) / dailyRet.length;
  const std = Math.sqrt(dailyRet.reduce((s, r) => s + (r - mean) ** 2, 0) / dailyRet.length);
  return std > 0 ? (mean_excess / std) * Math.sqrt(252) : 0;
}

export function computeSortino(dailyRet) {
  const mean = dailyRet.reduce((s, r) => s + r, 0) / dailyRet.length;
  const downSumSq = dailyRet.reduce((s, r) => s + (r < 0 ? r * r : 0), 0);
  const downDev = Math.sqrt(downSumSq / dailyRet.length);
  return downDev > 0 ? (mean / downDev) * Math.sqrt(252) : 0;
}

function computeMaxDD(equity, dates) {
  let peak = equity[0], maxDD = 0, maxDDStart = dates[0], maxDDTrough = dates[0];
  let recoveryDate = null, curPeakStart = dates[0];
  for (let i = 0; i < equity.length; i++) {
    if (equity[i] > peak) { peak = equity[i]; curPeakStart = dates[i]; }
    const dd = (equity[i] - peak) / peak;
    if (dd < maxDD) {
      maxDD = dd; maxDDStart = curPeakStart; maxDDTrough = dates[i]; recoveryDate = null;
      for (let j = i + 1; j < equity.length; j++) {
        if (equity[j] >= peak) { recoveryDate = dates[j]; break; }
      }
    }
  }
  const lastDate = dates[dates.length - 1];
  return { maxDD: maxDD * 100, maxDDStart, maxDDTrough, recoveryDate, maxDDDays: Math.round(daysBetween(maxDDStart, recoveryDate || lastDate)) };
}

function computeUlcerIndex(equity) {
  let peak = equity[0];
  const ddSq = [];
  for (const e of equity) { if (e > peak) peak = e; ddSq.push(((e - peak) / peak) ** 2); }
  return Math.sqrt(ddSq.reduce((s, x) => s + x, 0) / ddSq.length) * 100;
}

function computeTimeUnderWater(equity) {
  let peak = equity[0], under = 0;
  for (const e of equity) { if (e > peak) peak = e; if (e < peak) under++; }
  return (under / equity.length) * 100;
}

function groupMonthly(equity, dates) {
  const months = new Map();
  for (let i = 0; i < equity.length; i++) {
    const m = String(dates[i]).slice(0, 7);
    if (!months.has(m)) months.set(m, { first: equity[i], last: equity[i] });
    months.get(m).last = equity[i];
  }
  return [...months.entries()].map(([m, { first, last }]) => ({ m, ret: ((last - first) / first) * 100 }));
}

function groupAnnual(equity, dates) {
  const years = new Map();
  for (let i = 0; i < equity.length; i++) {
    const y = String(dates[i]).slice(0, 4);
    if (!years.has(y)) years.set(y, { first: equity[i], last: equity[i] });
    years.get(y).last = equity[i];
  }
  return [...years.entries()].map(([y, { first, last }]) => ({
    year: y, startEquity: +first.toFixed(2), endEquity: +last.toFixed(2),
    ret: +(((last - first) / first) * 100).toFixed(2),
  }));
}

function topNDrawdowns(equity, dates, n = 5) {
  const events = [];
  let peak = equity[0], peakDate = dates[0], inDD = false, trough = peak, troughDate = peakDate;
  for (let i = 0; i < equity.length; i++) {
    if (equity[i] > peak) {
      if (inDD && trough < peak) {
        events.push({ start: peakDate, trough: troughDate, recovery: dates[i], duration: Math.round(daysBetween(peakDate, dates[i])), depthPct: +(((trough - peak) / peak) * 100).toFixed(2) });
      }
      peak = equity[i]; peakDate = dates[i]; inDD = false; trough = peak; troughDate = peakDate;
    } else if (equity[i] < peak) {
      if (equity[i] < trough) { trough = equity[i]; troughDate = dates[i]; }
      inDD = true;
    }
  }
  if (inDD && trough < peak) {
    events.push({ start: peakDate, trough: troughDate, recovery: null, duration: Math.round(daysBetween(peakDate, dates[dates.length - 1])), depthPct: +(((trough - peak) / peak) * 100).toFixed(2) });
  }
  return events.sort((a, b) => a.depthPct - b.depthPct).slice(0, n);
}

function rolling12mReturns(equity, dates) {
  const monthlyEnds = new Map();
  for (let i = 0; i < equity.length; i++) monthlyEnds.set(String(dates[i]).slice(0, 7), equity[i]);
  const months = [...monthlyEnds.entries()].sort(([a], [b]) => a.localeCompare(b));
  const results = [];
  for (let i = 12; i < months.length; i++) {
    results.push({ endMonth: months[i][0], ret: +(((months[i][1] - months[i - 12][1]) / months[i - 12][1]) * 100).toFixed(2) });
  }
  return results;
}

function topNDailyReturns(equity, dates, n, worst = false) {
  const ret = dailyReturns(equity);
  const items = ret.map((r, i) => ({ date: dates[i + 1], ret: +(r * 100).toFixed(3), equity: +equity[i + 1].toFixed(2) }));
  items.sort((a, b) => worst ? a.ret - b.ret : b.ret - a.ret);
  return items.slice(0, n);
}

export function computeTradeStats(trades, seedNav, pnlScale) {
  const closed = trades.filter(t => t.exitDate && t.exitReason && t.exitReason !== 'STILL_OPEN');
  function statsOf(arr, pnlField) {
    let wins = 0, losses = 0, grossWin = 0, grossLoss = 0;
    for (const t of arr) {
      const pnl = (t[pnlField] || 0) * pnlScale;
      if (pnl > 0) { wins++; grossWin += pnl; } else if (pnl < 0) { losses++; grossLoss += -pnl; }
    }
    const avgWin = wins > 0 ? grossWin / wins : 0;
    const avgLoss = losses > 0 ? grossLoss / losses : 0;
    return {
      total: arr.length, wins, losses,
      winRate: wins + losses > 0 ? +((wins / (wins + losses)) * 100).toFixed(1) : 0,
      profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : 0,
      grossWin: +grossWin.toFixed(2), grossLoss: +grossLoss.toFixed(2),
      avgWin: +avgWin.toFixed(2), avgLoss: +avgLoss.toFixed(2),
      payoffRatio: avgLoss > 0 ? +(avgWin / avgLoss).toFixed(1) : 0,
    };
  }
  const bl = closed.filter(t => t.signal === 'BL');
  const ss = closed.filter(t => t.signal === 'SS');
  const combined = statsOf(closed, 'grossDollarPnl');
  const combinedNet = statsOf(closed, 'netDollarPnl');

  let cumPnl = 0, cumPeak = 0, realizedDD = 0;
  const sorted = [...closed].sort((a, b) => (a.exitDate || '').localeCompare(b.exitDate || ''));
  for (const t of sorted) {
    cumPnl += (t.netDollarPnl || 0) * pnlScale;
    if (cumPnl > cumPeak) cumPeak = cumPnl;
    const dd = cumPeak > 0 ? (cumPnl - cumPeak) / (seedNav + cumPeak) * 100 : cumPnl / seedNav * 100;
    if (dd < realizedDD) realizedDD = dd;
  }

  return {
    total: trades.length, closed: closed.length, open: trades.length - closed.length,
    bl: { count: bl.length, ...statsOf(bl, 'grossDollarPnl') },
    ss: { count: ss.length, ...statsOf(ss, 'grossDollarPnl') },
    combined, combinedNet, realizedDD: +realizedDD.toFixed(2),
  };
}

export function computeMarketCorrelation(grossDocs, benchDaily, fromDate) {
  const benchByDate = new Map();
  for (const b of benchDaily) benchByDate.set(b.date, b.close);
  const grossSorted = grossDocs.map(d => ({ date: String(d.date).slice(0, 10), equity: +d.equity })).filter(d => d.date >= fromDate).sort((a, b) => a.date.localeCompare(b.date));
  const pRet = [], bRet = [];
  for (let i = 1; i < grossSorted.length; i++) {
    const benchClose = benchByDate.get(grossSorted[i].date);
    const benchPrev = benchByDate.get(grossSorted[i - 1].date);
    if (benchClose == null || benchPrev == null || benchPrev === 0) continue;
    pRet.push((grossSorted[i].equity - grossSorted[i - 1].equity) / grossSorted[i - 1].equity);
    bRet.push((benchClose - benchPrev) / benchPrev);
  }
  if (pRet.length < 30) return null;
  const n = pRet.length;
  const pMean = pRet.reduce((s, x) => s + x, 0) / n;
  const bMean = bRet.reduce((s, x) => s + x, 0) / n;
  let cov = 0, pVar = 0, bVar = 0;
  for (let i = 0; i < n; i++) { const dp = pRet[i] - pMean; const db = bRet[i] - bMean; cov += dp * db; pVar += dp * dp; bVar += db * db; }
  cov /= n; pVar /= n; bVar /= n;
  const beta = bVar > 0 ? cov / bVar : 0;
  const correlation = (pVar > 0 && bVar > 0) ? cov / Math.sqrt(pVar * bVar) : 0;
  return { beta: +beta.toFixed(4), correlation: +correlation.toFixed(4), rSquared: +(correlation * correlation).toFixed(4), capmAlpha: +((pMean - beta * bMean) * 252 * 100).toFixed(2), observations: n };
}

export function crisisAlpha(pnthrEquity, pnthrDates, spyDaily, events) {
  const spySorted = [...spyDaily].sort((a, b) => a.date.localeCompare(b.date));
  function findClose(series, dates, target) { for (let i = 0; i < dates.length; i++) if (dates[i] >= target) return { val: series[i] }; return null; }
  function findSpyClose(target) { for (const b of spySorted) if (b.date >= target) return { val: b.close }; return null; }
  return events.map(ev => {
    const ps = findClose(pnthrEquity, pnthrDates, ev.start);
    const pe = findClose(pnthrEquity, pnthrDates, ev.end);
    const ss = findSpyClose(ev.start);
    const se = findSpyClose(ev.end);
    if (!ps || !pe || !ss || !se) return { event: ev.label, period: `${ev.start} to ${ev.end}`, spyReturn: null, pnthrReturn: null, alpha: null };
    const pnthrRet = ((pe.val - ps.val) / ps.val) * 100;
    const spyRet = ((se.val - ss.val) / ss.val) * 100;
    return { event: ev.label, period: `${ev.start} to ${ev.end}`, spyReturn: +spyRet.toFixed(2), pnthrReturn: +pnthrRet.toFixed(2), alpha: +(pnthrRet - spyRet).toFixed(2) };
  });
}

export function spyMetrics(spyDaily, metricsStartDate, endDate, seedNav, chartStartDate) {
  // Metrics computed from metricsStartDate (first trade date)
  const inRange = spyDaily.filter(b => b.date >= metricsStartDate && b.date <= endDate).sort((a, b) => a.date.localeCompare(b.date));
  if (inRange.length === 0) return null;
  const closes = inRange.map(b => b.close);
  const dates = inRange.map(b => b.date);
  const equity = closes.map(c => (c / closes[0]) * seedNav);
  const ret = dailyReturns(equity);
  const years = yearsBetween(dates[0], dates[dates.length - 1]);
  const totalReturn = ((equity[equity.length - 1] - equity[0]) / equity[0]) * 100;
  const cagr = (Math.pow(equity[equity.length - 1] / equity[0], 1 / years) - 1) * 100;
  const monthly = groupMonthly(equity, dates);
  const meanM = monthly.length > 0 ? monthly.reduce((s, m) => s + m.ret, 0) / monthly.length : 0;

  // Equity curve for chart: spans full date range from chartStartDate for alignment
  // with fund curve. Before metricsStartDate, SPY sits at seedNav (fund was in cash).
  let equityCurve;
  const effectiveChartStart = chartStartDate && chartStartDate < metricsStartDate ? chartStartDate : metricsStartDate;
  if (effectiveChartStart < metricsStartDate) {
    const fullRange = spyDaily.filter(b => b.date >= effectiveChartStart && b.date <= endDate).sort((a, b) => a.date.localeCompare(b.date));
    const metricsStartPrice = closes[0]; // SPY price on first trade date
    equityCurve = fullRange.map(b => ({
      date: b.date,
      value: b.date < metricsStartDate
        ? Math.round(seedNav)
        : Math.round((b.close / metricsStartPrice) * seedNav),
    }));
  } else {
    equityCurve = dates.map((d, i) => ({ date: d, value: +equity[i].toFixed(0) }));
  }

  return {
    startDate: dates[0], endDate: dates[dates.length - 1],
    totalReturn: +totalReturn.toFixed(2), cagr: +cagr.toFixed(2),
    sharpe: +computeSharpe(ret, dates).toFixed(2), sortino: +computeSortino(ret).toFixed(2),
    maxDD: +computeMaxDD(equity, dates).maxDD.toFixed(2),
    avgMonthlyReturn: +meanM.toFixed(2),
    endingEquity: +equity[equity.length - 1].toFixed(2),
    equityCurve,
  };
}

export function computeSide(docs, field) {
  const dates = docs.map(d => String(d.date).slice(0, 10));
  const equity = docs.map(d => +d[field]);
  const ret = dailyReturns(equity);
  const years = yearsBetween(dates[0], dates[dates.length - 1]);
  const totalReturn = ((equity[equity.length - 1] - equity[0]) / equity[0]) * 100;
  const cagr = (Math.pow(equity[equity.length - 1] / equity[0], 1 / years) - 1) * 100;
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
  const stdM = Math.sqrt(monthly.reduce((s, m) => s + (m.ret - meanM) ** 2, 0) / monthly.length);

  return {
    startDate: dates[0], endDate: dates[dates.length - 1], years: +years.toFixed(2),
    startNav: +equity[0].toFixed(2), endNav: +equity[equity.length - 1].toFixed(2),
    totalReturn: +totalReturn.toFixed(2), cagr: +cagr.toFixed(2),
    sharpe: +sharpe.toFixed(2), sortino: +sortino.toFixed(2),
    maxDD: +ddInfo.maxDD.toFixed(2), maxDDStart: ddInfo.maxDDStart, maxDDTrough: ddInfo.maxDDTrough,
    maxDDRecovery: ddInfo.recoveryDate, maxDDDays: ddInfo.maxDDDays,
    calmar: +calmar.toFixed(2), ulcerIndex: +ulcer.toFixed(2),
    recoveryFactor: +recoveryFactor.toFixed(2), timeUnderWater: +tuw.toFixed(2),
    positiveMonths: posMonths, totalMonths: monthly.length,
    positivePct: +((posMonths / monthly.length) * 100).toFixed(1),
    bestMonth: { m: best.m, ret: +best.ret.toFixed(2) },
    worstMonth: { m: worst.m, ret: +worst.ret.toFixed(2) },
    avgMonthlyReturn: +meanM.toFixed(2), monthlyStdDev: +stdM.toFixed(2),
    monthlyReturns: monthly.map(m => ({ m: m.m, ret: +m.ret.toFixed(2) })),
    annualReturns: annual,
    top5Drawdowns: topNDrawdowns(equity, dates, 5),
    rolling12m: rolling12mReturns(equity, dates),
    top10WorstDays: topNDailyReturns(equity, dates, 10, true),
    top10BestDays: topNDailyReturns(equity, dates, 10, false),
    equityCurve: dates.map((d, i) => ({ date: d, value: +equity[i].toFixed(0) })),
  };
}

// In-memory cache (refresh every 6 hours)
const cache = {};
const CACHE_TTL = 6 * 60 * 60 * 1000;

async function getIrData(tierKey) {
  const tier = TIERS[tierKey];
  if (!tier) throw new Error(`Invalid tier: ${tierKey}`);

  if (cache[tierKey] && Date.now() - cache[tierKey].ts < CACHE_TTL) return cache[tierKey].data;

  const db = await connectToDatabase();
  if (!db) throw new Error('DB unavailable');

  const [grossDocs, netDocs, allTrades, spyDoc, qqqDoc] = await Promise.all([
    db.collection(`pnthr_ai_bt_pyramid_nav_${tier.key}_daily_nav_gross`).find({}).sort({ date: 1 }).toArray(),
    db.collection(`pnthr_ai_bt_pyramid_nav_${tier.key}_daily_nav_net`).find({}).sort({ date: 1 }).toArray(),
    db.collection(`pnthr_ai_bt_pyramid_nav_${tier.key}_trade_log`).find({}).toArray(),
    db.collection('pnthr_bt_candles').findOne({ ticker: 'SPY' }),
    db.collection('pnthr_bt_candles').findOne({ ticker: 'QQQ' }),
  ]);

  if (grossDocs.length === 0 || netDocs.length === 0) throw new Error(`No NAV data for tier ${tierKey}`);

  const spyDaily = spyDoc?.daily || [];
  const qqqDaily = qqqDoc?.daily || [];

  const gross = computeSide(grossDocs, 'equity');
  const net = computeSide(netDocs, 'netEquity');
  const scale = 1;
  const tradeStats = computeTradeStats(allTrades, tier.seedNav, scale);
  const closedTrades = allTrades.filter(t => t.entryDate).sort((a, b) => String(a.entryDate).localeCompare(String(b.entryDate)));
  const firstTradeDate = closedTrades.length > 0 ? String(closedTrades[0].entryDate).slice(0, 10) : null;
  const spyStartDate = firstTradeDate || gross.startDate;
  const spy = spyMetrics(spyDaily, spyStartDate, gross.endDate, tier.seedNav, gross.startDate);

  const crisisGrossEq = grossDocs.map(d => +d.equity);
  const crisisGrossDates = grossDocs.map(d => String(d.date).slice(0, 10));
  const crisisNetEq = netDocs.map(d => +d.netEquity);
  const crisisNetDates = netDocs.map(d => String(d.date).slice(0, 10));

  const CORR_FROM = '2023-06-01';
  const spyCorr = computeMarketCorrelation(grossDocs, spyDaily, CORR_FROM);
  const qqqCorr = computeMarketCorrelation(grossDocs, qqqDaily, CORR_FROM);

  const result = {
    tier: tier.key, label: tier.label, seedNav: tier.seedNav,
    feeSchedule: { yearsOneToThree: tier.feeYr1to3, yearsFourPlus: tier.feeYr4plus },
    gross, net, trades: tradeStats, spy, firstTradeDate,
    spyAnnualReturns: buildSpyAnnualReturns(grossDocs, spyDaily, tier.seedNav, firstTradeDate),
    crisisAlphaGross: crisisAlpha(crisisGrossEq, crisisGrossDates, spyDaily, CRISIS_EVENTS),
    crisisAlphaNet: crisisAlpha(crisisNetEq, crisisNetDates, spyDaily, CRISIS_EVENTS),
    alphaVsSpy: spy ? {
      totalReturnPts: +(net.totalReturn - spy.totalReturn).toFixed(2),
      cagrPts: +(net.cagr - spy.cagr).toFixed(2),
      endingEquityDelta: +(net.endNav - spy.endingEquity).toFixed(2),
    } : null,
    marketCorrelation: {
      spy: spyCorr, qqq: qqqCorr,
      observations: spyCorr?.observations || 0,
      fromDate: CORR_FROM,
    },
    generatedAt: new Date().toISOString(),
  };

  cache[tierKey] = { data: result, ts: Date.now() };
  return result;
}

export function buildSpyAnnualReturns(grossDocs, spyDaily, seedNav, firstTradeDate) {
  const spySorted = [...spyDaily].sort((a, b) => a.date.localeCompare(b.date));
  const spyByDate = new Map(spySorted.map(b => [b.date, b.close]));
  const startFrom = firstTradeDate || String(grossDocs[0].date).slice(0, 10);
  let spyStartClose = null;
  for (const b of spySorted) { if (b.date >= startFrom) { spyStartClose = b.close; break; } }
  if (!spyStartClose) return [];

  const years = new Map();
  for (const d of grossDocs) {
    const date = String(d.date).slice(0, 10);
    if (date < startFrom) continue;
    const y = date.slice(0, 4);
    const spyClose = spyByDate.get(date);
    if (spyClose == null) continue;
    const spyEq = (spyClose / spyStartClose) * seedNav;
    if (!years.has(y)) years.set(y, { first: spyEq, last: spyEq });
    years.get(y).last = spyEq;
  }
  return [...years.entries()].map(([y, { first, last }]) => ({ year: y, ret: +(((last - first) / first) * 100).toFixed(2) }));
}

async function getTradeLog(tierKey) {
  const tier = TIERS[tierKey];
  if (!tier) throw new Error(`Invalid tier: ${tierKey}`);
  const db = await connectToDatabase();
  if (!db) throw new Error('DB unavailable');

  const trades = await db.collection(`pnthr_ai_bt_pyramid_nav_${tier.key}_trade_log`)
    .find({}).sort({ entryDate: 1 }).toArray();

  const scale = 1;
  return trades.map(t => ({
    ticker: t.ticker,
    signal: t.signal,
    direction: t.signal === 'SS' ? 'SHORT' : 'LONG',
    sectorName: t.sectorName || '—',
    entryDate: String(t.entryDate || '').slice(0, 10),
    exitDate: t.exitDate ? String(t.exitDate).slice(0, 10) : null,
    entryPrice: +((t.entryPrice || 0)).toFixed(2),
    exitPrice: t.exitPrice ? +t.exitPrice.toFixed(2) : null,
    avgCost: t.avgCost ? +t.avgCost.toFixed(2) : null,
    totalShares: t.totalShares || 0,
    lotsFilledCount: t.lots?.length || 1,
    totalLots: 5,
    exitReason: t.exitReason || 'ACTIVE',
    grossPnlPct: t.grossProfitPct != null ? +t.grossProfitPct.toFixed(2) : null,
    netPnlPct: t.netProfitPct != null ? +t.netProfitPct.toFixed(2) : null,
    grossPnlDollar: t.grossDollarPnl != null ? +((t.grossDollarPnl * scale)).toFixed(0) : null,
    netPnlDollar: t.netDollarPnl != null ? +((t.netDollarPnl * scale)).toFixed(0) : null,
    holdingDays: t.tradingDays || 0,
    isWinner: t.netIsWinner ?? t.isWinner ?? null,
    killRank: t.killRank || null,
    tierName: t.tierName || null,
    sectorTier: t.sectorTier || null,
  }));
}

export async function irLiveMetricsHandler(req, res) {
  try {
    const tier = req.params.tier;
    const data = await getIrData(tier);
    res.json(data);
  } catch (err) {
    console.error('[IR LIVE] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

export async function irLiveTradesHandler(req, res) {
  try {
    const tier = req.params.tier;
    const trades = await getTradeLog(tier);
    res.json({ trades, count: trades.length });
  } catch (err) {
    console.error('[IR LIVE] Trades error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
