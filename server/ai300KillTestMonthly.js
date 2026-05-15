// server/ai300KillTestMonthly.js
// ── PNTHR AI 300 Kill Test — Monthly Portfolio Snapshot & Analytics ──────────
//
// Mirrors killTestMonthly.js but operates on pnthr_ai300_kill_appearances.
// Uses AI 300 Kill Test settings (separate NAV/risk params).
//
// Collections written:
//   pnthr_ai300_kill_test_monthly  — one doc per month (equity + P&L)
//   pnthr_ai300_kill_test_metrics  — latest computed metrics (single doc, upserted)

import { connectToDatabase } from './database.js';
import { getAi300KillTestSettings } from './ai300KillTestSettings.js';

const FMP_BASE = 'https://financialmodelingprep.com/api/v3';

function lastDayOfMonth(yyyy, mm) {
  return new Date(yyyy, mm, 0).toISOString().split('T')[0];
}

function monthKey(date) {
  const d = typeof date === 'string' ? new Date(date + 'T12:00:00') : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function addMonths(monthStr, n) {
  const [y, m] = monthStr.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function currentMonthKey() {
  return monthKey(new Date());
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stdDev(arr, sampleMean = null) {
  if (arr.length < 2) return 0;
  const m = sampleMean ?? mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

async function fetchMonthEndPrice(ticker, monthStr) {
  const key = process.env.FMP_API_KEY;
  if (!key) return null;
  const [y, m] = monthStr.split('-').map(Number);
  const lastDay = lastDayOfMonth(y, m);
  const fromDay = lastDayOfMonth(y, m - 1);
  try {
    const url  = `${FMP_BASE}/historical-price-full/${ticker}?from=${fromDay}&to=${lastDay}&apikey=${key}`;
    const res  = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const hist = data?.historical;
    if (!hist?.length) return null;
    return hist[0].close ?? null;
  } catch {
    return null;
  }
}

async function computePositionSnapshot(appearances, monthStr, settings) {
  let totalInvested = 0;
  let unrealizedPnl = 0;
  const openTickers = [];

  const { serverSizePosition, buildServerLotConfig } = await import('./killTestSettings.js');
  const monthEndDate = lastDayOfMonth(...monthStr.split('-').map(Number));

  for (const appr of appearances) {
    const isShort = appr.signal === 'SS';

    const lotFills = appr.lotFills ?? {
      lot1: { filled: true,  fillDate: appr.firstAppearanceDate, fillPrice: appr.firstAppearancePrice },
      lot2: { filled: false, fillDate: null, fillPrice: null },
      lot3: { filled: false, fillDate: null, fillPrice: null },
      lot4: { filled: false, fillDate: null, fillPrice: null },
      lot5: { filled: false, fillDate: null, fillPrice: null },
    };

    const entry = appr.firstAppearancePrice;
    const stop  = appr.firstStopPrice ?? appr.currentStop ?? null;
    if (!entry || !stop) continue;

    const sized = serverSizePosition({
      nav:        settings.nav,
      entryPrice: entry,
      stopPrice:  stop,
      riskPct:    settings.riskPctPerTrade,
    });
    if (!sized || sized.totalShares <= 0) continue;

    const lots = buildServerLotConfig(sized.totalShares, entry, appr.signal);

    let shares = 0, cost = 0;
    for (let i = 0; i < 5; i++) {
      const fillKey = `lot${i + 1}`;
      const fill    = lotFills[fillKey];
      if (!fill?.filled || !fill.fillDate) continue;
      if (fill.fillDate > monthEndDate) continue;

      const lotShares = lots[i].targetShares;
      const fillPrice = fill.fillPrice ?? entry;
      shares += lotShares;
      cost   += lotShares * fillPrice;
    }
    if (shares === 0) continue;

    totalInvested += cost;
    const avgCost = cost / shares;

    let endPrice = appr.lastSeenPrice ?? null;

    if (!endPrice) {
      const snap = (appr.dailySnapshots || [])
        .filter(s => s.date <= monthEndDate)
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      endPrice = snap?.close ?? null;
    }

    if (!endPrice) {
      endPrice = await fetchMonthEndPrice(appr.ticker, monthStr);
    }

    if (!endPrice) endPrice = entry;

    const pnl = isShort
      ? (avgCost - endPrice) * shares
      : (endPrice - avgCost) * shares;

    unrealizedPnl += pnl;
    openTickers.push(appr.ticker);
  }

  return { totalInvested, unrealizedPnl, openTickers };
}

async function generateOneMonthSnapshot(db, monthStr, settings, prevSnapshot, tickerFilter = null) {
  const [y, m] = monthStr.split('-').map(Number);
  const monthEndDate = lastDayOfMonth(y, m);

  const baseQuery = { firstAppearanceDate: { $lte: monthEndDate } };
  if (tickerFilter && tickerFilter.length > 0) {
    baseQuery.ticker = { $in: tickerFilter };
  }
  const allAppr = await db.collection('pnthr_ai300_kill_appearances').find(baseQuery).toArray();

  const openAtEnd       = allAppr.filter(a => !a.exitDate || a.exitDate > monthEndDate);
  const closedByEnd     = allAppr.filter(a =>  a.exitDate && a.exitDate <= monthEndDate);
  const closedThisMonth = allAppr.filter(a => a.exitDate && a.exitDate >= `${monthStr}-01` && a.exitDate <= monthEndDate);

  const cumulativeRealizedPnl = closedByEnd.reduce((s, a) => s + (a.profitDollar || 0), 0);
  const realizedThisMonth     = closedThisMonth.reduce((s, a) => s + (a.profitDollar || 0), 0);

  const { totalInvested, unrealizedPnl, openTickers } = await computePositionSnapshot(
    openAtEnd, monthStr, settings
  );

  const currentNAV     = settings.nav + cumulativeRealizedPnl;
  const idleCash       = Math.max(0, currentNAV - totalInvested);
  const sweepInterest  = +(idleCash * (settings.sweepRate / 100 / 12)).toFixed(2);
  const prevSweep      = prevSnapshot?.cumulativeSweepInterest ?? 0;
  const cumulativeSweepInterest = +(prevSweep + sweepInterest).toFixed(2);
  const portfolioValue = +(settings.nav + cumulativeRealizedPnl + unrealizedPnl + cumulativeSweepInterest).toFixed(2);
  const prevValue      = prevSnapshot?.portfolioValue ?? settings.nav;
  const monthlyReturn  = +((portfolioValue - prevValue) / prevValue * 100).toFixed(4);
  const cumulativeReturn = +((portfolioValue - settings.nav) / settings.nav * 100).toFixed(4);

  return {
    month: monthStr,
    portfolioValue, monthlyReturn, cumulativeReturn,
    openPositions:        openAtEnd.length,
    closedThisMonth:      closedThisMonth.length,
    totalInvested:        +totalInvested.toFixed(2),
    unrealizedPnl:        +unrealizedPnl.toFixed(2),
    realizedThisMonth:    +realizedThisMonth.toFixed(2),
    cumulativeRealizedPnl: +cumulativeRealizedPnl.toFixed(2),
    idleCash:             +idleCash.toFixed(2),
    sweepInterest,
    cumulativeSweepInterest,
    openTickers,
    nav: settings.nav,
    createdAt: new Date(),
  };
}

export async function generateAi300MonthlySnapshots(db = null, forceMonth = null, tickerFilter = null, scenarioKey = 'all') {
  const ownDb = !db;
  if (!db) {
    db = await connectToDatabase();
    if (!db) { console.error('[AI300 KillTest Monthly] DB unavailable'); return null; }
  }

  const settings = await getAi300KillTestSettings();

  const earliestQuery = {};
  if (tickerFilter && tickerFilter.length > 0) {
    earliestQuery.ticker = { $in: tickerFilter };
  }
  const earliest = await db.collection('pnthr_ai300_kill_appearances')
    .findOne(earliestQuery, { sort: { firstAppearanceDate: 1 } });
  if (!earliest) return null;

  const startMonth = monthKey(earliest.firstAppearanceDate);
  const endMonth   = forceMonth ?? currentMonthKey();

  const monthsToProcess = [];
  let cur = startMonth;
  while (cur <= endMonth) {
    const existing = await db.collection('pnthr_ai300_kill_test_monthly').findOne({ scenarioKey, month: cur });
    if (!existing || cur === endMonth) monthsToProcess.push(cur);
    cur = addMonths(cur, 1);
  }

  if (monthsToProcess.length === 0) return null;

  let prevSnapshot = await db.collection('pnthr_ai300_kill_test_monthly')
    .findOne({ scenarioKey, month: { $lt: monthsToProcess[0] } }, { sort: { month: -1 } });

  const saved = [];
  for (const month of monthsToProcess) {
    try {
      const snap = await generateOneMonthSnapshot(db, month, settings, prevSnapshot, tickerFilter);
      const snapWithKey = { ...snap, scenarioKey };
      await db.collection('pnthr_ai300_kill_test_monthly').updateOne(
        { scenarioKey, month },
        { $set: snapWithKey },
        { upsert: true }
      );
      prevSnapshot = snapWithKey;
      saved.push(snapWithKey);
      console.log(`[AI300 KillTest Monthly][${scenarioKey}] ${month}: $${snap.portfolioValue.toLocaleString()} | ${snap.monthlyReturn >= 0 ? '+' : ''}${snap.monthlyReturn.toFixed(2)}%`);
    } catch (err) {
      console.error(`[AI300 KillTest Monthly][${scenarioKey}] ${month} failed:`, err.message);
    }
  }

  await computeAndSaveAi300Metrics(db, settings, scenarioKey);
  return saved;
}

function buildDrawdownSeries(equityCurve) {
  const drawdowns = [];
  let peak = equityCurve[0] ?? 100;
  for (const val of equityCurve) {
    if (val > peak) peak = val;
    drawdowns.push(((val - peak) / peak) * 100);
  }
  return drawdowns;
}

function rollingMaxDrawdown(drawdowns, w) {
  if (drawdowns.length < w) return null;
  let worst = 0;
  for (let i = w - 1; i < drawdowns.length; i++) {
    const windowDDs = drawdowns.slice(i - w + 1, i + 1);
    const wd = Math.min(...windowDDs);
    if (wd < worst) worst = wd;
  }
  return +worst.toFixed(2);
}

function avgDrawdownDuration(equityCurve) {
  const durations = [];
  let inDrawdown  = false;
  let duration    = 0;
  let peak        = equityCurve[0] ?? 100;

  for (const val of equityCurve) {
    if (val >= peak) {
      if (inDrawdown) { durations.push(duration); inDrawdown = false; duration = 0; }
      peak = val;
    } else {
      inDrawdown = true;
      duration++;
    }
  }
  if (inDrawdown) durations.push(duration);

  return durations.length > 0 ? +(mean(durations)).toFixed(1) : 0;
}

function findPeakToValley(snapshots, drawdowns) {
  if (!snapshots.length) return null;
  const worstIdx = drawdowns.indexOf(Math.min(...drawdowns));
  if (worstIdx <= 0) return null;

  let peakIdx = 0;
  let peak    = snapshots[0].portfolioValue;
  for (let i = 1; i <= worstIdx; i++) {
    if (snapshots[i].portfolioValue > peak) { peak = snapshots[i].portfolioValue; peakIdx = i; }
  }

  const peakMonth   = snapshots[peakIdx]?.month;
  const troughMonth = snapshots[worstIdx]?.month;
  const tickersOpen = new Set();
  for (let i = peakIdx; i <= worstIdx; i++) {
    (snapshots[i].openTickers || []).forEach(t => tickersOpen.add(t));
  }

  return {
    peakMonth, troughMonth,
    peakValue:   +peak.toFixed(2),
    troughValue: +snapshots[worstIdx].portfolioValue.toFixed(2),
    drawdownPct: +drawdowns[worstIdx].toFixed(2),
    tickersOpen: [...tickersOpen].sort(),
    durationMonths: worstIdx - peakIdx,
  };
}

export async function computeAndSaveAi300Metrics(db, settings = null, scenarioKey = 'all') {
  if (!settings) settings = await getAi300KillTestSettings();

  const snapshots = await db.collection('pnthr_ai300_kill_test_monthly')
    .find({ scenarioKey }).sort({ month: 1 }).toArray();

  if (snapshots.length < 2) {
    await db.collection('pnthr_ai300_kill_test_metrics').updateOne(
      { scenarioKey },
      { $set: { scenarioKey, asOf: currentMonthKey(), status: 'INSUFFICIENT_DATA', minMonthsRequired: 2, monthsAvailable: snapshots.length, updatedAt: new Date() } },
      { upsert: true }
    );
    return;
  }

  const rfPerMonth    = (settings.riskFreeRate / 100) / 12;
  const equityCurve   = snapshots.map(s => s.portfolioValue);
  const monthlyRets   = snapshots.map(s => s.monthlyReturn / 100);
  const excessRets    = monthlyRets.map(r => r - rfPerMonth);
  const drawdowns     = buildDrawdownSeries(equityCurve);
  const n             = snapshots.length;

  const meanExcess   = mean(excessRets);
  const stdExcess    = stdDev(excessRets, meanExcess);
  const sharpe       = stdExcess > 0 ? +(meanExcess / stdExcess * Math.sqrt(12)).toFixed(3) : null;

  const sharpe6M = (() => {
    if (n < 6) return null;
    const slice = excessRets.slice(-6);
    const m6 = mean(slice), s6 = stdDev(slice, m6);
    return s6 > 0 ? +(m6 / s6 * Math.sqrt(12)).toFixed(3) : null;
  })();

  const downsideRets = excessRets.filter(r => r < 0);
  const downsideStd  = downsideRets.length > 1 ? stdDev(downsideRets, 0) : 0;
  const sortino      = downsideStd > 0 ? +(meanExcess / downsideStd * Math.sqrt(12)).toFixed(3) : null;

  const sortino6M = (() => {
    if (n < 6) return null;
    const slice = excessRets.slice(-6);
    const down  = slice.filter(r => r < 0);
    const ds    = down.length > 1 ? stdDev(down, 0) : 0;
    return ds > 0 ? +(mean(slice) / ds * Math.sqrt(12)).toFixed(3) : null;
  })();

  const totalReturnPct   = snapshots[n - 1].cumulativeReturn;
  const annualizedReturn = n >= 2
    ? +((Math.pow(1 + totalReturnPct / 100, 12 / n) - 1) * 100).toFixed(2)
    : null;

  const return6M = n >= 6
    ? +((snapshots[n - 1].portfolioValue - snapshots[n - 7].portfolioValue) / snapshots[n - 7].portfolioValue * 100).toFixed(2)
    : null;

  const maxMonthlyDrawdown = +Math.min(...drawdowns).toFixed(2);
  const currentDrawdown    = +drawdowns[n - 1].toFixed(2);
  const nonZeroDrawdowns   = drawdowns.filter(d => d < 0);
  const avgDrawdown        = nonZeroDrawdowns.length > 0 ? +(mean(nonZeroDrawdowns)).toFixed(2) : 0;
  const drawdownFrequency  = +((nonZeroDrawdowns.length / n) * 100).toFixed(1);

  const sortedDDs = [...drawdowns].sort((a, b) => a - b);
  const worst5pct = sortedDDs.slice(0, Math.max(1, Math.ceil(n * 0.05)));
  const cdar95    = +(mean(worst5pct)).toFixed(2);

  const calmarAnnual = (annualizedReturn != null && maxMonthlyDrawdown < 0)
    ? +(annualizedReturn / Math.abs(maxMonthlyDrawdown)).toFixed(3) : null;

  const calmar6M = (return6M != null && n >= 6) ? (() => {
    const slice6DDs = drawdowns.slice(-6);
    const maxDD6    = Math.min(...slice6DDs);
    return maxDD6 < 0 ? +(return6M / Math.abs(maxDD6)).toFixed(3) : null;
  })() : null;

  const painIndex = +(mean(drawdowns.map(d => Math.abs(d)))).toFixed(2);

  const rolling1M  = rollingMaxDrawdown(drawdowns, 1);
  const rolling3M  = rollingMaxDrawdown(drawdowns, 3);
  const rolling6M  = rollingMaxDrawdown(drawdowns, 6);
  const rolling12M = rollingMaxDrawdown(drawdowns, 12);

  const avgDDDuration = avgDrawdownDuration(equityCurve);
  const peakToValley  = findPeakToValley(snapshots, drawdowns);

  const metrics = {
    scenarioKey,
    asOf:            currentMonthKey(),
    status:          'OK',
    monthsAvailable: n,
    totalReturnPct, annualizedReturn, return6M,
    sharpe, sharpe6M, sortino, sortino6M, calmarAnnual, calmar6M,
    maxMonthlyDrawdown, currentDrawdown, avgDrawdown, drawdownFrequency,
    cdar95, painIndex,
    rolling1M, rolling3M, rolling6M, rolling12M,
    avgDrawdownDurationMonths: avgDDDuration,
    peakToValley,
    monthlyReturns: snapshots.map(s => ({ month: s.month, return: s.monthlyReturn, cumulative: s.cumulativeReturn })),
    equityCurve:    snapshots.map(s => ({ month: s.month, value: s.portfolioValue, drawdown: drawdowns[snapshots.indexOf(s)] })),
    updatedAt: new Date(),
  };

  await db.collection('pnthr_ai300_kill_test_metrics').updateOne(
    { scenarioKey },
    { $set: metrics },
    { upsert: true }
  );

  console.log(`[AI300 KillTest Metrics][${scenarioKey}] Sharpe: ${sharpe} | Sortino: ${sortino} | Calmar: ${calmarAnnual} | MaxDD: ${maxMonthlyDrawdown}%`);
  return metrics;
}

export async function ai300KillTestMonthlyGet(req, res) {
  try {
    const db          = await connectToDatabase();
    const scenarioKey = req.query.scenarioKey || 'all';
    const rows = await db.collection('pnthr_ai300_kill_test_monthly')
      .find({ scenarioKey }).sort({ month: 1 }).toArray();
    res.json(rows);
  } catch (err) {
    console.error('[ai300-kill-test/monthly]', err);
    res.status(500).json({ error: err.message });
  }
}

export async function ai300KillTestMetricsGet(req, res) {
  try {
    const db          = await connectToDatabase();
    const scenarioKey = req.query.scenarioKey || 'all';
    const metrics = await db.collection('pnthr_ai300_kill_test_metrics').findOne({ scenarioKey });
    res.json(metrics ?? { status: 'NO_DATA' });
  } catch (err) {
    console.error('[ai300-kill-test/metrics]', err);
    res.status(500).json({ error: err.message });
  }
}

export async function ai300KillTestMonthlyGenerate(req, res) {
  try {
    const db = await connectToDatabase();

    const { killMin, killMax } = req.body ?? {};

    const hasFilter = [killMin, killMax].some(v => v != null && v !== '');
    const scenarioKey = hasFilter
      ? `k${killMin ?? '*'}-${killMax ?? '*'}`
      : 'all';

    let tickerFilter = null;
    if (hasFilter) {
      const allAppr = await db.collection('pnthr_ai300_kill_appearances').find({}).toArray();
      const filtered = allAppr.filter(a => {
        if (killMin != null && killMin !== '' && (a.firstKillScore ?? 0) < +killMin) return false;
        if (killMax != null && killMax !== '' && (a.firstKillScore ?? 0) > +killMax) return false;
        return true;
      });
      tickerFilter = filtered.map(a => a.ticker);
    }

    const results = await generateAi300MonthlySnapshots(db, null, tickerFilter, scenarioKey);

    const [monthly, metrics] = await Promise.all([
      db.collection('pnthr_ai300_kill_test_monthly').find({ scenarioKey }).sort({ month: 1 }).toArray(),
      db.collection('pnthr_ai300_kill_test_metrics').findOne({ scenarioKey }),
    ]);

    res.json({ ok: true, scenarioKey, monthsGenerated: results?.length ?? 0, results, monthly, metrics });
  } catch (err) {
    console.error('[ai300-kill-test/monthly/generate]', err);
    res.status(500).json({ error: err.message });
  }
}
