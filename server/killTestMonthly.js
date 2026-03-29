// server/killTestMonthly.js
// ── PNTHR Kill Test — Monthly Portfolio Snapshot & Analytics ──────────────────
//
// Runs on the first Friday of each month (or on demand via API).
// Builds a monthly equity curve from all Kill Test appearances, then
// computes the full suite of risk/return metrics.
//
// Collections written:
//   pnthr_kill_test_monthly  — one doc per month (equity + P&L)
//   pnthr_kill_test_metrics  — latest computed metrics (single doc, upserted)
//
// Metric definitions:
//   Sharpe    — (annualizedReturn - riskFree) / annualizedStd
//   Sortino   — (annualizedReturn - riskFree) / annualizedDownsideStd
//   Calmar    — annualizedReturn / abs(maxDrawdown)   [6M + all-history]
//   CDaR 95%  — avg of worst 5% monthly drawdowns
//   Pain Idx  — mean absolute drawdown across all months
//   Rolling   — worst drawdown within 1/3/6/12-month windows
//   Duration  — avg months from drawdown peak to recovery
// ─────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';
import { getKillTestSettings } from './killTestSettings.js';

const FMP_BASE = 'https://financialmodelingprep.com/api/v3';

// ── Date helpers ──────────────────────────────────────────────────────────────

function lastDayOfMonth(yyyy, mm) {
  return new Date(yyyy, mm, 0).toISOString().split('T')[0];
}

function monthKey(date) {
  const d = typeof date === 'string' ? new Date(date + 'T12:00:00') : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthsFrom(startMonth, endMonth) {
  const [sy, sm] = startMonth.split('-').map(Number);
  const [ey, em] = endMonth.split('-').map(Number);
  return (ey - sy) * 12 + (em - sm);
}

function addMonths(monthStr, n) {
  const [y, m] = monthStr.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function currentMonthKey() {
  return monthKey(new Date());
}

// ── FMP: fetch month-end closing price for a ticker ───────────────────────────
async function fetchMonthEndPrice(ticker, monthStr) {
  const key = process.env.FMP_API_KEY;
  if (!key) return null;
  const [y, m] = monthStr.split('-').map(Number);
  const lastDay = lastDayOfMonth(y, m);
  const fromDay = lastDayOfMonth(y, m - 1); // start of last week of month
  try {
    const url  = `${FMP_BASE}/historical-price-full/${ticker}?from=${fromDay}&to=${lastDay}&apikey=${key}`;
    const res  = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const hist = data?.historical;
    if (!hist?.length) return null;
    // hist is sorted newest-first; take the last bar on or before month end
    return hist[0].close ?? null;
  } catch {
    return null;
  }
}

// ── Compute invested capital & unrealized P&L for a set of appearances ────────
// IMPORTANT: Share counts are ALWAYS recomputed from current settings NAV + riskPct.
// Only fillDate and fillPrice are treated as historical facts.
// This ensures changing NAV retroactively rescales all P&L correctly.
async function computePositionSnapshot(appearances, monthStr, settings, useLastSeen = false) {
  let totalInvested = 0;
  let unrealizedPnl = 0;
  const openTickers = [];

  const { serverSizePosition, buildServerLotConfig } = await import('./killTestSettings.js');
  const monthEndDate = lastDayOfMonth(...monthStr.split('-').map(Number));

  for (const appr of appearances) {
    const isShort = appr.signal === 'SS';

    // ── Lot fills: build default if missing (Lot 1 always filled at appearance) ──
    const lotFills = appr.lotFills ?? {
      lot1: { filled: true,  fillDate: appr.firstAppearanceDate, fillPrice: appr.firstAppearancePrice },
      lot2: { filled: false, fillDate: null, fillPrice: null },
      lot3: { filled: false, fillDate: null, fillPrice: null },
      lot4: { filled: false, fillDate: null, fillPrice: null },
      lot5: { filled: false, fillDate: null, fillPrice: null },
    };

    // ── Dynamically recompute shares from current NAV + risk% ──────────────
    // This is the key: we do NOT use stored lotFills.shares (baked-in at creation).
    // We recalculate from current settings so NAV changes are fully retroactive.
    const entry = appr.firstAppearancePrice;
    // Fallback chain for stop price: stored firstStopPrice → currentStop → skip
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

    // Compute shares and cost from which lots were triggered by month end
    let shares = 0, cost = 0;
    for (let i = 0; i < 5; i++) {
      const fillKey = `lot${i + 1}`;
      const fill    = lotFills[fillKey];
      if (!fill?.filled || !fill.fillDate) continue;
      if (fill.fillDate > monthEndDate) continue; // lot filled after this month — skip

      // Use historical fill price (real fact) × dynamically-computed share count
      const lotShares = lots[i].targetShares;
      const fillPrice = fill.fillPrice ?? entry;
      shares += lotShares;
      cost   += lotShares * fillPrice;
    }
    if (shares === 0) continue;

    totalInvested += cost;
    const avgCost = cost / shares;

    // Get month-end price
    // Fallback chain: lastSeenPrice → dailySnapshot close → FMP fetch → appearance price
    // Using appearance price as last resort gives 0% unrealized P&L (conservative)
    // rather than excluding the position from capital calculations entirely.
    let endPrice = null;

    // Try lastSeenPrice first (always fastest, already fetched)
    endPrice = appr.lastSeenPrice ?? null;

    if (!endPrice) {
      // Try dailySnapshots (most recent bar at or before month end)
      const snap = (appr.dailySnapshots || [])
        .filter(s => s.date <= monthEndDate)
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      endPrice = snap?.close ?? null;
    }

    if (!endPrice) {
      // Fetch from FMP (works for both current and past months)
      endPrice = await fetchMonthEndPrice(appr.ticker, monthStr);
    }

    // Final fallback: use appearance price → unrealized P&L = 0 for this position,
    // but it IS included in totalInvested so idle cash is correctly reduced.
    if (!endPrice) endPrice = entry;

    const pnl = isShort
      ? (avgCost - endPrice) * shares
      : (endPrice - avgCost) * shares;

    unrealizedPnl += pnl;
    openTickers.push(appr.ticker);
  }

  return { totalInvested, unrealizedPnl, openTickers };
}

// ── Generate a single month's snapshot ───────────────────────────────────────
async function generateOneMonthSnapshot(db, monthStr, settings, prevSnapshot) {
  const [y, m] = monthStr.split('-').map(Number);
  const monthEndDate = lastDayOfMonth(y, m);
  const isCurrentMonth = monthStr === currentMonthKey();

  // Get all appearances that existed at any point this month
  const allAppr = await db.collection('pnthr_kill_appearances').find({
    firstAppearanceDate: { $lte: monthEndDate },
  }).toArray();

  // Split into open-at-month-end vs closed-by-month-end
  const openAtEnd   = allAppr.filter(a => !a.exitDate || a.exitDate > monthEndDate);
  const closedByEnd = allAppr.filter(a =>  a.exitDate && a.exitDate <= monthEndDate);
  const closedThisMonth = allAppr.filter(a => a.exitDate && a.exitDate >= `${monthStr}-01` && a.exitDate <= monthEndDate);

  // Cumulative realized P&L (all trades closed on or before month end)
  const cumulativeRealizedPnl = closedByEnd.reduce((s, a) => s + (a.profitDollar || 0), 0);

  // Realized P&L this month only
  const realizedThisMonth = closedThisMonth.reduce((s, a) => s + (a.profitDollar || 0), 0);

  // Open positions snapshot (useLastSeen param removed — now uses unified fallback chain)
  const { totalInvested, unrealizedPnl, openTickers } = await computePositionSnapshot(
    openAtEnd, monthStr, settings
  );

  // Idle cash = NAV + realized gains - invested capital (can go negative if overallocated)
  const currentNAV     = settings.nav + cumulativeRealizedPnl;
  const idleCash       = Math.max(0, currentNAV - totalInvested);

  // Sweep interest this month on idle cash
  const sweepInterest  = +(idleCash * (settings.sweepRate / 100 / 12)).toFixed(2);

  // Cumulative sweep interest (from all prior months)
  const prevSweep = prevSnapshot?.cumulativeSweepInterest ?? 0;
  const cumulativeSweepInterest = +(prevSweep + sweepInterest).toFixed(2);

  // Portfolio value at month end
  const portfolioValue = +(settings.nav + cumulativeRealizedPnl + unrealizedPnl + cumulativeSweepInterest).toFixed(2);

  // Monthly return %
  const prevValue      = prevSnapshot?.portfolioValue ?? settings.nav;
  const monthlyReturn  = +((portfolioValue - prevValue) / prevValue * 100).toFixed(4);

  // Cumulative return from inception
  const cumulativeReturn = +((portfolioValue - settings.nav) / settings.nav * 100).toFixed(4);

  return {
    month:                monthStr,
    portfolioValue,
    monthlyReturn,
    cumulativeReturn,
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
    nav:                  settings.nav,
    createdAt:            new Date(),
  };
}

// ── Main: generate all missing monthly snapshots ──────────────────────────────
export async function generateMonthlySnapshots(db = null, forceMonth = null) {
  const ownDb = !db;
  if (!db) {
    db = await connectToDatabase();
    if (!db) { console.error('[KillTest Monthly] DB unavailable'); return null; }
  }

  const settings = await getKillTestSettings();

  // Find the earliest appearance date to know where to start
  const earliest = await db.collection('pnthr_kill_appearances')
    .findOne({}, { sort: { firstAppearanceDate: 1 } });
  if (!earliest) return null;

  const startMonth = monthKey(earliest.firstAppearanceDate);
  const endMonth   = forceMonth ?? currentMonthKey();

  // Build list of months to process
  const monthsToProcess = [];
  let cur = startMonth;
  while (cur <= endMonth) {
    const existing = await db.collection('pnthr_kill_test_monthly').findOne({ month: cur });
    if (!existing || cur === endMonth) monthsToProcess.push(cur); // always regenerate current month
    cur = addMonths(cur, 1);
  }

  if (monthsToProcess.length === 0) return null;

  let prevSnapshot = await db.collection('pnthr_kill_test_monthly')
    .findOne({ month: { $lt: monthsToProcess[0] } }, { sort: { month: -1 } });

  const saved = [];
  for (const month of monthsToProcess) {
    try {
      const snap = await generateOneMonthSnapshot(db, month, settings, prevSnapshot);
      await db.collection('pnthr_kill_test_monthly').updateOne(
        { month },
        { $set: snap },
        { upsert: true }
      );
      prevSnapshot = snap;
      saved.push(snap);
      console.log(`[KillTest Monthly] ${month}: $${snap.portfolioValue.toLocaleString()} | ${snap.monthlyReturn >= 0 ? '+' : ''}${snap.monthlyReturn.toFixed(2)}%`);
    } catch (err) {
      console.error(`[KillTest Monthly] ${month} failed:`, err.message);
    }
  }

  // Recompute metrics after updating snapshots
  await computeAndSaveMetrics(db, settings);

  return saved;
}

// ── Statistics helpers ────────────────────────────────────────────────────────

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

// Build drawdown series from equity values
function buildDrawdownSeries(equityCurve) {
  const drawdowns = [];
  let peak = equityCurve[0] ?? 100;
  for (const val of equityCurve) {
    if (val > peak) peak = val;
    drawdowns.push(((val - peak) / peak) * 100);
  }
  return drawdowns;
}

// Max drawdown within a rolling window of W months
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

// Average drawdown duration (months from peak to full recovery)
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
  if (inDrawdown) durations.push(duration); // still in drawdown at end

  return durations.length > 0 ? +(mean(durations)).toFixed(1) : 0;
}

// Peak-to-valley: find worst drawdown period and list open tickers during it
function findPeakToValley(snapshots, drawdowns) {
  if (!snapshots.length) return null;
  const worstIdx = drawdowns.indexOf(Math.min(...drawdowns));
  if (worstIdx <= 0) return null;

  // Find the peak before this trough
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
    peakMonth,
    troughMonth,
    peakValue:   +peak.toFixed(2),
    troughValue: +snapshots[worstIdx].portfolioValue.toFixed(2),
    drawdownPct: +drawdowns[worstIdx].toFixed(2),
    tickersOpen: [...tickersOpen].sort(),
    durationMonths: worstIdx - peakIdx,
  };
}

// ── Compute and save all analytics metrics ────────────────────────────────────
export async function computeAndSaveMetrics(db, settings = null) {
  if (!settings) settings = await getKillTestSettings();

  const snapshots = await db.collection('pnthr_kill_test_monthly')
    .find({}).sort({ month: 1 }).toArray();

  if (snapshots.length < 2) {
    // Not enough data for meaningful metrics yet
    await db.collection('pnthr_kill_test_metrics').updateOne(
      {},
      { $set: { asOf: currentMonthKey(), status: 'INSUFFICIENT_DATA', minMonthsRequired: 2, monthsAvailable: snapshots.length, updatedAt: new Date() } },
      { upsert: true }
    );
    return;
  }

  const rfPerMonth    = (settings.riskFreeRate / 100) / 12;
  const equityCurve   = snapshots.map(s => s.portfolioValue);
  const monthlyRets   = snapshots.map(s => s.monthlyReturn / 100);  // as decimals
  const excessRets    = monthlyRets.map(r => r - rfPerMonth);
  const drawdowns     = buildDrawdownSeries(equityCurve);
  const n             = snapshots.length;

  // ── Sharpe (annualized) ─────────────────────────────────────────────
  const meanExcess   = mean(excessRets);
  const stdExcess    = stdDev(excessRets, meanExcess);
  const sharpe       = stdExcess > 0 ? +(meanExcess / stdExcess * Math.sqrt(12)).toFixed(3) : null;

  // 6-month Sharpe (last 6 months)
  const sharpe6M = (() => {
    if (n < 6) return null;
    const slice = excessRets.slice(-6);
    const m6 = mean(slice), s6 = stdDev(slice, m6);
    return s6 > 0 ? +(m6 / s6 * Math.sqrt(12)).toFixed(3) : null;
  })();

  // ── Sortino (annualized) ────────────────────────────────────────────
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

  // ── Returns ─────────────────────────────────────────────────────────
  const totalReturnPct   = snapshots[n - 1].cumulativeReturn;
  const annualizedReturn = n >= 2
    ? +((Math.pow(1 + totalReturnPct / 100, 12 / n) - 1) * 100).toFixed(2)
    : null;

  // 6-month return
  const return6M = n >= 6
    ? +((snapshots[n - 1].portfolioValue - snapshots[n - 7].portfolioValue) / snapshots[n - 7].portfolioValue * 100).toFixed(2)
    : null;

  // ── Drawdown metrics ─────────────────────────────────────────────────
  const maxMonthlyDrawdown = +Math.min(...drawdowns).toFixed(2);
  const currentDrawdown    = +drawdowns[n - 1].toFixed(2);
  const nonZeroDrawdowns   = drawdowns.filter(d => d < 0);
  const avgDrawdown        = nonZeroDrawdowns.length > 0
    ? +(mean(nonZeroDrawdowns)).toFixed(2)
    : 0;
  const drawdownFrequency  = +((nonZeroDrawdowns.length / n) * 100).toFixed(1); // % of months in drawdown

  // ── CDaR 95% (Conditional Drawdown at Risk — worst 5% of months) ───
  const sortedDDs = [...drawdowns].sort((a, b) => a - b);
  const worst5pct = sortedDDs.slice(0, Math.max(1, Math.ceil(n * 0.05)));
  const cdar95    = +(mean(worst5pct)).toFixed(2);

  // ── Calmar Ratio ────────────────────────────────────────────────────
  const calmarAnnual = (annualizedReturn != null && maxMonthlyDrawdown < 0)
    ? +(annualizedReturn / Math.abs(maxMonthlyDrawdown)).toFixed(3)
    : null;

  const calmar6M = (return6M != null && n >= 6) ? (() => {
    const slice6DDs = drawdowns.slice(-6);
    const maxDD6    = Math.min(...slice6DDs);
    return maxDD6 < 0 ? +(return6M / Math.abs(maxDD6)).toFixed(3) : null;
  })() : null;

  // ── Pain Index ──────────────────────────────────────────────────────
  const painIndex = +(mean(drawdowns.map(d => Math.abs(d)))).toFixed(2);

  // ── Rolling drawdowns ────────────────────────────────────────────────
  const rolling1M  = rollingMaxDrawdown(drawdowns, 1);
  const rolling3M  = rollingMaxDrawdown(drawdowns, 3);
  const rolling6M  = rollingMaxDrawdown(drawdowns, 6);
  const rolling12M = rollingMaxDrawdown(drawdowns, 12);

  // ── Drawdown duration ────────────────────────────────────────────────
  const avgDDDuration = avgDrawdownDuration(equityCurve);

  // ── Peak-to-valley attribution ───────────────────────────────────────
  const peakToValley = findPeakToValley(snapshots, drawdowns);

  // ── Assemble metrics doc ──────────────────────────────────────────────
  const metrics = {
    asOf:            currentMonthKey(),
    status:          'OK',
    monthsAvailable: n,
    // Returns
    totalReturnPct,
    annualizedReturn,
    return6M,
    // Sharpe
    sharpe,
    sharpe6M,
    // Sortino
    sortino,
    sortino6M,
    // Calmar
    calmarAnnual,
    calmar6M,
    // Drawdown
    maxMonthlyDrawdown,
    currentDrawdown,
    avgDrawdown,
    drawdownFrequency,
    cdar95,
    painIndex,
    rolling1M,
    rolling3M,
    rolling6M,
    rolling12M,
    avgDrawdownDurationMonths: avgDDDuration,
    peakToValley,
    // Full series for charting
    monthlyReturns: snapshots.map(s => ({ month: s.month, return: s.monthlyReturn, cumulative: s.cumulativeReturn })),
    equityCurve:    snapshots.map(s => ({ month: s.month, value: s.portfolioValue, drawdown: drawdowns[snapshots.indexOf(s)] })),
    updatedAt: new Date(),
  };

  await db.collection('pnthr_kill_test_metrics').updateOne(
    {},
    { $set: metrics },
    { upsert: true }
  );

  console.log(`[KillTest Metrics] Sharpe: ${sharpe} | Sortino: ${sortino} | Calmar: ${calmarAnnual} | MaxDD: ${maxMonthlyDrawdown}%`);
  return metrics;
}

// ── API handlers ──────────────────────────────────────────────────────────────

export async function killTestMonthlyGet(req, res) {
  try {
    const db   = await connectToDatabase();
    const rows = await db.collection('pnthr_kill_test_monthly')
      .find({}).sort({ month: 1 }).toArray();
    res.json(rows);
  } catch (err) {
    console.error('[kill-test/monthly]', err);
    res.status(500).json({ error: err.message });
  }
}

export async function killTestMetricsGet(req, res) {
  try {
    const db      = await connectToDatabase();
    const metrics = await db.collection('pnthr_kill_test_metrics').findOne({});
    res.json(metrics ?? { status: 'NO_DATA' });
  } catch (err) {
    console.error('[kill-test/metrics]', err);
    res.status(500).json({ error: err.message });
  }
}

export async function killTestMonthlyGenerate(req, res) {
  try {
    const db      = await connectToDatabase();
    const results = await generateMonthlySnapshots(db);
    res.json({ ok: true, monthsGenerated: results?.length ?? 0, results });
  } catch (err) {
    console.error('[kill-test/monthly/generate]', err);
    res.status(500).json({ error: err.message });
  }
}
