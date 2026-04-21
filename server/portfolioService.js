import { getSignals } from './signalService.js';

const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';
const FMP_API_KEY = process.env.FMP_API_KEY;

// Add EMA-derived signals + stop prices to an array of stock objects.
// Mutates nothing — returns new objects.
export async function enrichWithSignals(stocks) {
  if (!stocks || stocks.length === 0) return [];
  const tickers = stocks.map(s => s.ticker);
  const signalMap = await getSignals(tickers);

  return stocks.map(stock => {
    const sig = signalMap[stock.ticker];
    const stopPrice = sig?.stopPrice ?? null;
    return {
      ...stock,
      signal: sig?.signal ?? null,
      isNewSignal: sig?.isNewSignal ?? false,
      profitPercentage: sig?.profitPercentage ?? null,
      stopPrice,
      stopProxy: stopPrice == null, // true → 8% proxy used for position sizing
    };
  });
}

// Fetch the last 12 weeks of Friday-close returns for each ticker.
// Returns { [ticker]: [r1, r2, ..., r12] } where ri are decimal weekly returns.
export async function fetchWeeklyReturns(tickers) {
  const from = new Date();
  from.setDate(from.getDate() - 105); // 15 weeks back for safety
  const fromStr = from.toISOString().split('T')[0];

  const returnsMap = {};
  const concurrency = 5;

  for (let i = 0; i < tickers.length; i += concurrency) {
    const chunk = tickers.slice(i, i + concurrency);
    await Promise.all(chunk.map(async (ticker) => {
      try {
        const url = `${FMP_BASE_URL}/historical-price-full/${ticker}?from=${fromStr}&apikey=${FMP_API_KEY}`;
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();
        if (!data?.historical?.length) return;

        // Keep only Friday closes, ascending
        const fridays = data.historical
          .filter(d => new Date(d.date + 'T12:00:00').getDay() === 5)
          .sort((a, b) => (a.date > b.date ? 1 : -1))
          .slice(-13); // need 13 prices → 12 returns

        if (fridays.length < 2) return;

        const returns = [];
        for (let j = 1; j < fridays.length; j++) {
          returns.push((fridays[j].close - fridays[j - 1].close) / fridays[j - 1].close);
        }
        returnsMap[ticker] = returns.slice(-12);
      } catch (err) {
        console.error(`Weekly returns error for ${ticker}:`, err.message);
      }
    }));
    if (i + concurrency < tickers.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }
  return returnsMap;
}

// Fetch the current VIX level from FMP.
// Returns the VIX as a raw number (e.g. 22.4) or null if unavailable.
async function fetchVix() {
  try {
    const url = `${FMP_BASE_URL}/quote/%5EVIX?apikey=${FMP_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const price = data?.[0]?.price;
    return typeof price === 'number' && price > 0 ? price : null;
  } catch (err) {
    console.error('VIX fetch error:', err.message);
    return null;
  }
}

// ── Risk-Adjusted Portfolio Optimization ─────────────────────────────────────
// Framework: stop-defined risk, VIX-based vol targeting, Sortino-first.
// No return forecasts are used. All rules are mechanical.

// Pad / trim a raw return array to exactly WEEKS periods (oldest first, zero-padded).
function alignReturns(raw, WEEKS = 12) {
  const padded = Array(WEEKS).fill(0);
  raw.slice(-WEEKS).forEach((r, k) => {
    padded[k + (WEEKS - Math.min(raw.length, WEEKS))] = r;
  });
  return padded;
}

// Annualised Sortino ratio from weekly returns, target = 0%.
// Downside deviation uses ALL weeks in the denominator (conservative, widely used).
function computeSortino(weeklyReturns) {
  const n = weeklyReturns.length;
  if (n === 0) return 0;
  const annualReturn = (weeklyReturns.reduce((s, r) => s + r, 0) / n) * 52;
  const downSqSum = weeklyReturns.reduce((s, r) => s + Math.pow(Math.min(r, 0), 2), 0);
  const downsideDev = Math.sqrt((downSqSum / n) * 52);
  if (downsideDev < 1e-10) return annualReturn > 0 ? 10 : 0;
  return annualReturn / downsideDev;
}

// Max peak-to-trough drawdown from a weekly return series.
function computeMaxDrawdown(weeklyReturns) {
  let cum = 1, peak = 1, maxDD = 0;
  for (const r of weeklyReturns) {
    cum *= (1 + r);
    if (cum > peak) peak = cum;
    maxDD = Math.max(maxDD, (peak - cum) / peak);
  }
  return maxDD;
}

// Average pairwise Pearson correlation across an array of return series.
// Uses direction-adjusted returns (P&L correlation proxy).
function computeAvgCorrelation(returnSeries) {
  const m = returnSeries.length;
  if (m < 2) return 0;
  const T = returnSeries[0].length;
  let total = 0, count = 0;
  for (let a = 0; a < m - 1; a++) {
    for (let b = a + 1; b < m; b++) {
      const ra = returnSeries[a], rb = returnSeries[b];
      const mA = ra.reduce((s, r) => s + r, 0) / T;
      const mB = rb.reduce((s, r) => s + r, 0) / T;
      let num = 0, vA = 0, vB = 0;
      for (let w = 0; w < T; w++) {
        const dA = ra[w] - mA, dB = rb[w] - mB;
        num += dA * dB; vA += dA * dA; vB += dB * dB;
      }
      total += (vA > 0 && vB > 0) ? num / Math.sqrt(vA * vB) : 0;
      count++;
    }
  }
  return count > 0 ? total / count : 0;
}

// ── RASON Product Mix Portfolio Optimization ──────────────────────────────────
//
// Formulation (Simplex LP):
//   Variables : x[i] ∈ [0, 1]  — allocation fraction for each position
//   Objective : Maximize Σ sortino[i] * x[i]
//               LP naturally sets x[i] = 0 for negative-Sortino stocks.
//   No sector constraint — Fund policy is manager-discretion on sector concentration.
//
// Post-solve (local JS):
//   VIX-based vol targeting  — volScale  = min(1, VIX_TARGET / currentVIX)
//   Correlation check        — corrScale = min(1, CORR_THRESHOLD / avgCorr)
//   Final scaleFactor        = min(volScale, corrScale)
//
// Falls back to rule-based greedy selection if RASON is unavailable.
//
// Returns { fractions[], sortino, sharpe, scaleFactor, maxDrawdown, portfolioVol, vix, avgCorrelation }
export async function optimizeWithRason(positions, accountSize, riskPct = 1) {
  const WEEKS = 12;
  const VIX_TARGET = 20;
  const CORR_THRESHOLD = 0.50;

  const n = positions.length;
  const tickers = positions.map(p => p.ticker);
  const dir = positions.map(p => (p.direction === 'LONG' ? 1 : -1));

  // Capital weight of each position at full base allocation
  const baseW = positions.map((p) => {
    const riskPerShare = p.stopPrice != null
      ? Math.abs(p.currentPrice - p.stopPrice)
      : p.currentPrice * 0.08;
    const baseShares = riskPerShare > 0
      ? Math.floor(accountSize * (riskPct / 100) / riskPerShare)
      : 0;
    return baseShares > 0 ? (baseShares * p.currentPrice) / accountSize : 0;
  });

  console.log(`📐 Fetching 12-week returns for ${n} tickers...`);
  const returnsMap = await fetchWeeklyReturns(tickers);

  // Direction-adjusted aligned returns (positive = profitable for our position)
  const adjReturns = tickers.map((t, i) =>
    alignReturns(returnsMap[t] || [], WEEKS).map(r => dir[i] * r)
  );

  const stockSortino = adjReturns.map(computeSortino);

  // ── Build RASON LP model ───────────────────────────────────────────────────
  // One scalar variable per position: x0, x1, ... xN (RASON scalar variable format)
  const xNames = positions.map((_, i) => `x${i}`);

  const variables = {};
  xNames.forEach((name) => {
    variables[name] = { value: 0.5, lowerBound: 0, upperBound: 1, finalValue: [] };
  });

  // Objective: maximize Σ sortino[i] * xi
  const objFormula = xNames
    .map((name, i) => `${stockSortino[i].toFixed(8)}*${name}`)
    .join(' + ');

  // No sector constraints — manager-discretion policy on sector concentration.
  const rasonModel = {
    engineSettings: { engine: 'Simplex LP' },
    variables,
    constraints: {},
    objective: {
      obj: { type: 'maximize', formula: objFormula, finalValue: [] },
    },
  };

  // ── Call RASON API ─────────────────────────────────────────────────────────
  let fractions;
  try {
    const rasonRes = await fetch('https://rason.net/api/optimize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RASON_API_TOKEN}`,
      },
      body: JSON.stringify(rasonModel),
    });

    if (!rasonRes.ok) throw new Error(`RASON HTTP ${rasonRes.status}`);
    const rasonResult = await rasonRes.json();

    // Extract per-position fractions from solution
    fractions = xNames.map(name => {
      const val = rasonResult?.variables?.[name]?.finalValue;
      return typeof val === 'number' ? Math.max(0, Math.min(1, val)) : 0;
    });

    console.log(`📐 RASON solved. Included: ${fractions.filter(f => f > 0.01).length}/${n}`);
  } catch (err) {
    // ── Fallback: greedy rule-based selection (no sector cap) ─────────────
    console.warn(`⚠️  RASON unavailable (${err.message}), using rule-based fallback.`);
    const included = new Set([...Array(n).keys()].filter(i => stockSortino[i] >= 0));
    fractions = positions.map((_, i) => included.has(i) ? 1 : 0);
  }

  // ── Post-solve: VIX scaling + correlation check ────────────────────────────
  const inclArr = fractions.map((f, i) => f > 0.01 ? i : -1).filter(i => i >= 0);

  const totalBaseW = inclArr.reduce((s, i) => s + baseW[i], 0);
  const portRets = Array(WEEKS).fill(0);
  for (const i of inclArr) {
    const w = totalBaseW > 0 ? baseW[i] / totalBaseW : 1 / inclArr.length;
    for (let wk = 0; wk < WEEKS; wk++) portRets[wk] += adjReturns[i][wk] * w;
  }

  const portMean = portRets.reduce((s, r) => s + r, 0) / WEEKS;
  const portVolWeekly = Math.sqrt(
    portRets.reduce((s, r) => s + (r - portMean) ** 2, 0) / Math.max(WEEKS - 1, 1)
  );
  const portVolAnnual = portVolWeekly * Math.sqrt(52);

  const vix = await fetchVix();
  const volScale = (vix != null && vix > VIX_TARGET) ? VIX_TARGET / vix : 1.0;

  const avgCorr = computeAvgCorrelation(inclArr.map(i => adjReturns[i]));
  const corrScale = avgCorr > CORR_THRESHOLD ? CORR_THRESHOLD / avgCorr : 1.0;

  const scaleFactor = Math.min(volScale, corrScale);

  const portSortino = computeSortino(portRets);
  const portSharpe = portVolAnnual > 0 ? (portMean * 52) / portVolAnnual : 0;
  const portMaxDD = computeMaxDrawdown(portRets);

  console.log(
    `📐 Opt done. Sortino: ${portSortino.toFixed(2)}, Sharpe: ${portSharpe.toFixed(2)}, ` +
    `Scale: ${(scaleFactor * 100).toFixed(0)}%, VIX: ${vix != null ? vix.toFixed(1) : 'N/A'}, ` +
    `Excluded: ${n - inclArr.length}`
  );

  return {
    fractions: fractions.map(f => f > 0.01 ? f * scaleFactor : 0),
    sortino: portSortino,
    sharpe: portSharpe,
    scaleFactor,
    maxDrawdown: portMaxDD,
    portfolioVol: portVolAnnual,
    vix,
    avgCorrelation: avgCorr,
    excludedCount: n - inclArr.length,
  };
}
