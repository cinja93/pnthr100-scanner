import { getLatestSignals } from './database.js';
import { calculateStopPrices } from './stockService.js';

const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';
const FMP_API_KEY = process.env.FMP_API_KEY;

// Add laser signals + calculated stop prices to an array of stock objects.
// Mutates nothing — returns new objects.
export async function enrichWithSignals(stocks) {
  if (!stocks || stocks.length === 0) return [];
  const tickers = stocks.map(s => s.ticker);
  const signalMap = await getLatestSignals(tickers);
  const withStops = await calculateStopPrices(signalMap);

  return stocks.map(stock => {
    const sig = withStops[stock.ticker];
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
// Framework: stop-defined risk, sector caps, VIX-based vol targeting, Sortino-first.
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

// Risk-Adjusted Portfolio Optimization
// ─────────────────────────────────────
// Step 1a Drop any stock with Sortino < 0 (net loser on a risk-adjusted basis).
// Step 1b Sector caps (≤ 25% of positions per sector).
//         Within an over-weight sector, drop lowest individual Sortino stocks.
// Step 2  Build equal-risk-weight portfolio return series (capital-weighted by baseW).
// Step 3  VIX-based vol targeting: volScale = min(1, VIX_TARGET / currentVIX).
//         Falls back to no scaling if VIX is unavailable.
// Step 4  Correlation check: further reduce if avg P&L correlation > 0.5.
// Step 5  Compute portfolio Sortino (primary), Sharpe (secondary), MaxDrawdown.
//
// Returns { fractions[], sortino, sharpe, scaleFactor, maxDrawdown, portfolioVol, vix, avgCorrelation }
export async function optimizeWithRason(positions, accountSize, riskPct = 1) {
  const WEEKS = 12;
  const VIX_TARGET = 20;        // VIX level at which full sizing applies; scale back proportionally above this
  const SECTOR_CAP = 0.25;      // max 25% of positions in any one sector
  const CORR_THRESHOLD = 0.50;  // scale down when avg pairwise correlation exceeds this

  const n = positions.length;
  const tickers = positions.map(p => p.ticker);
  const dir = positions.map(p => (p.direction === 'LONG' ? 1 : -1));

  // Capital weight of each position at full (100%) base allocation
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

  // Per-stock Sortino for ranking within sectors
  const stockSortino = adjReturns.map(computeSortino);

  // ── Step 1a: Drop stocks with negative Sortino (lost money on a risk-adjusted basis) ──
  // Start with only non-negative Sortino stocks; sector cap then trims further.
  const included = new Set([...Array(n).keys()].filter(i => stockSortino[i] >= 0));

  // ── Step 1b: Sector caps ───────────────────────────────────────────────────
  const maxPerSector = Math.max(2, Math.ceil(n * SECTOR_CAP));
  const sectorGroups = {};
  positions.forEach((p, i) => {
    if (!included.has(i)) return; // skip already-excluded stocks
    const s = p.sector || 'Unknown';
    (sectorGroups[s] = sectorGroups[s] || []).push({ i, sortino: stockSortino[i] });
  });
  for (const group of Object.values(sectorGroups)) {
    if (group.length > maxPerSector) {
      group.sort((a, b) => b.sortino - a.sortino);
      group.slice(maxPerSector).forEach(g => included.delete(g.i));
    }
  }
  const inclArr = [...included];

  // ── Step 2: Portfolio return series (capital-weighted) ────────────────────
  const totalBaseW = inclArr.reduce((s, i) => s + baseW[i], 0);
  const portRets = Array(WEEKS).fill(0);
  for (const i of inclArr) {
    const w = totalBaseW > 0 ? baseW[i] / totalBaseW : 1 / inclArr.length;
    for (let wk = 0; wk < WEEKS; wk++) portRets[wk] += adjReturns[i][wk] * w;
  }

  // ── Step 3: VIX-based volatility targeting ────────────────────────────────
  // portMean / portVolAnnual still computed for Sharpe reporting (Step 5).
  const portMean = portRets.reduce((s, r) => s + r, 0) / WEEKS;
  const portVolWeekly = Math.sqrt(
    portRets.reduce((s, r) => s + (r - portMean) ** 2, 0) / Math.max(WEEKS - 1, 1)
  );
  const portVolAnnual = portVolWeekly * Math.sqrt(52);

  const vix = await fetchVix();
  // Scale back proportionally when VIX > target; no leverage when VIX is calm.
  const volScale = (vix != null && vix > VIX_TARGET) ? VIX_TARGET / vix : 1.0;

  // ── Step 4: Correlation check ──────────────────────────────────────────────
  const avgCorr = computeAvgCorrelation(inclArr.map(i => adjReturns[i]));
  const corrScale = avgCorr > CORR_THRESHOLD ? CORR_THRESHOLD / avgCorr : 1.0;

  const scaleFactor = Math.min(volScale, corrScale);

  // ── Step 5: Portfolio metrics ──────────────────────────────────────────────
  // Sortino and Sharpe are scale-invariant; report unscaled portfolio quality.
  const portSortino = computeSortino(portRets);
  const portSharpe = portVolAnnual > 0 ? (portMean * 52) / portVolAnnual : 0;
  const portMaxDD = computeMaxDrawdown(portRets);

  console.log(
    `📐 Opt done. Sortino: ${portSortino.toFixed(2)}, Sharpe: ${portSharpe.toFixed(2)}, ` +
    `Scale: ${(scaleFactor * 100).toFixed(0)}%, VIX: ${vix != null ? vix.toFixed(1) : 'N/A'}, ` +
    `Excluded: ${n - included.size}`
  );

  return {
    fractions: positions.map((_, i) => included.has(i) ? scaleFactor : 0),
    sortino: portSortino,
    sharpe: portSharpe,
    scaleFactor,
    maxDrawdown: portMaxDD,
    portfolioVol: portVolAnnual,
    vix,                          // raw VIX level (e.g. 22.4), null if unavailable
    avgCorrelation: avgCorr,
    excludedCount: n - included.size,
  };
}
