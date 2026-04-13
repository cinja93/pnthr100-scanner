/**
 * PNTHR Analyze — Pre-Trade Scoring System v2
 *
 * 100-point system — every point evaluable at scan time.
 *
 * T1 Setup Quality (40 pts): Signal Quality 15, Kill Context 10, Index Trend 8, Sector Trend 7
 * T2 Risk Profile  (35 pts): Freshness 12, Risk/Reward 8, Prey Presence 8, Conviction 7
 * T3 Entry Conditions (25 pts): Slope Strength 5, Sector Concentration 5, Wash Compliance 5,
 *                                Volatility Context 5, Portfolio Fit 5
 *
 * Returns:
 * {
 *   score: number,       // points earned (0-100)
 *   max: 100,
 *   pct: number,         // percentage (0-100)
 *   composite: number,   // Kill score × Analyze% (for sorting)
 *   components: { ... },
 *   warnings: [ ... ],
 *   color: string,       // '#28a745' | '#FFD700' | '#dc3545'
 *   direction: string,
 * }
 */

import { normalizeSector } from './sectorUtils';
import { getETFAssetClass, isClassifiedETF, ETF_SECTOR_BENCHMARK, BENCHMARK_TO_SECTOR_KEY } from './etfClassification';
import { isEtfTicker } from './sizingUtils';

// ─── ETF routing gate ───────────────────────────────────────────────────────
// Returns true when this stock should use computeETFAnalyzeScore() instead of
// the equity path. Uses three signals in order of reliability:
//  1. stock.isETF flag (set during SIZE IT / server enrichment)
//  2. stock.type === 'etf' (from API data source)
//  3. isEtfTicker() / isClassifiedETF() — static ticker-list checks
function stockIsETF(stock) {
  if (!stock) return false;
  const t = (stock.ticker || stock.symbol || '').toUpperCase();
  return !!(stock.isETF || stock.type === 'etf' || isEtfTicker(t) || isClassifiedETF(t));
}

// ─── Shared direction inference ─────────────────────────────────────────────
function inferDirection(stock) {
  const sig = (stock.signal || stock.pnthrSignal || '').toUpperCase();
  if (sig === 'SS') return 'SHORT';
  if (sig === 'BL') return 'LONG';
  if (stock.suggestedDirection) return stock.suggestedDirection;
  if (stock.direction) return stock.direction;
  return 'LONG';
}

// ─── ETF scoring helpers ────────────────────────────────────────────────────

function scoreETFSignalQuality(stock, direction) {
  const signal = (stock.signal || stock.pnthrSignal || '').toUpperCase();
  const signalAge = stock.signalAge ?? stock.weeksSince ?? null;
  const warnings = [];

  if (signal !== 'BL' && signal !== 'SS') {
    if (stock.isDeveloping) {
      return { score: 10, max: 15, label: 'DEVELOPING', detail: '3/4 conditions met', warnings };
    }
    warnings.push('No active ETF signal');
    return { score: 0, max: 15, label: 'NO SIGNAL', detail: 'No PNTHR signal', warnings };
  }

  const matchesDir = (direction === 'LONG' && signal === 'BL') || (direction === 'SHORT' && signal === 'SS');
  if (!matchesDir) {
    warnings.push('Signal direction conflicts with trade direction');
    return { score: 0, max: 15, label: 'WRONG DIR', detail: 'Signal does not match trade direction', warnings };
  }

  // Base signal points by age (same scale as equity)
  let pts = 0;
  let label = 'SIGNAL';
  if (signalAge == null) {
    pts = 8; label = 'SIGNAL';
  } else if (signalAge <= 1) {
    pts = 10; label = 'FRESH';
  } else if (signalAge <= 2) {
    pts = 8; label = 'RECENT';
  } else if (signalAge <= 3) {
    pts = 5; label = 'RECENT';
  } else if (signalAge <= 6) {
    pts = 3;
  } else {
    pts = 0; label = 'EXPIRED';
    warnings.push(`Signal is ${signalAge} weeks old — reduced edge for ETFs`);
  }

  // EMA conviction bonus (0-5 pts)
  const price = stock.currentPrice || stock.price || stock.close;
  const ema = stock.ema21;
  if (price && ema) {
    const sep = Math.abs((price - ema) / ema);
    const aligned = (signal === 'BL' && price > ema) || (signal === 'SS' && price < ema);
    if (aligned) {
      if (sep >= 0.03) pts += 5;
      else if (sep >= 0.02) pts += 3;
      else if (sep >= 0.01) pts += 2;
      else if (sep >= 0.005) pts += 1;
    }
  }

  return { score: Math.min(pts, 15), max: 15, label, detail: `${signal}${signalAge != null ? '+' + signalAge : ''} signal`, warnings };
}

// EMA Slope: is the 21-week EMA itself rising or falling, and how steeply?
// Scored 0-10 based on slope direction alignment with ETF trend + slope magnitude.
// emaSlope = % change from previous week's EMA to current (from signalService or ChartModal).
function scoreETFEmaSlope(stock, direction) {
  const slope = stock.emaSlope ?? null;

  if (slope === null) {
    // emaRising boolean fallback
    const rising = stock.emaRising ?? null;
    if (rising === null) {
      return { score: 0, max: 10, label: 'ERROR', detail: 'EMA slope data unavailable — data pipeline failure', warnings: [] };
    }
    const slopeDir = rising ? 'LONG' : 'SHORT';
    const aligned  = slopeDir === direction;
    return {
      score: aligned ? 7 : 0, max: 10,
      label: aligned ? (rising ? 'RISING' : 'FALLING') : 'FIGHTING',
      detail: `EMA ${rising ? 'rising' : 'falling'} (direction only — magnitude unavailable)`,
      warnings: [],
    };
  }

  const slopeDir = slope >= 0 ? 'LONG' : 'SHORT';
  const aligned  = slopeDir === direction;
  const magnitude = Math.abs(slope);

  if (!aligned) {
    return {
      score: 0, max: 10, label: 'FIGHTING',
      detail: `EMA slope ${slope > 0 ? '+' : ''}${slope.toFixed(3)}% — ${slopeDir} slope, trading ${direction}`,
      warnings: [],
    };
  }

  // Aligned — score by magnitude
  let pts, label;
  if (magnitude >= 1.0)      { pts = 10; label = 'STRONG';   }
  else if (magnitude >= 0.5) { pts = 8;  label = 'MODERATE'; }
  else if (magnitude >= 0.2) { pts = 6;  label = 'MILD';     }
  else                       { pts = 3;  label = 'FLAT';      }

  return {
    score: pts, max: 10, label,
    detail: `EMA slope ${slope > 0 ? '+' : ''}${slope.toFixed(3)}% — ${label.toLowerCase()} ${slopeDir.toLowerCase()} momentum`,
    warnings: [],
  };
}

// ETF Trend: direction indicator only — no scoring.
// Price above 21 EMA = LONG trend; price below = SHORT trend.
// This direction feeds Signal Quality and Macro Alignment checks.
// Trade direction conflict is NOT penalized here — Macro Alignment handles alignment.
function scoreETFTrendAlignment(stock) {
  const price = stock.currentPrice || stock.price || stock.close;
  const ema   = stock.ema21;
  if (!price || !ema) {
    return { score: 0, max: 0, label: 'ERROR', detail: 'EMA data missing — data pipeline failure', warnings: [] };
  }
  const direction = price > ema ? 'LONG' : 'SHORT';
  return {
    score: 0, max: 0,
    label: direction,
    detail: `Price ${price > ema ? 'above' : 'below'} 21 EMA`,
    warnings: [],
  };
}

function scoreETFMacroAlignment(stock, context, ticker, direction) {
  const warnings = [];

  // Determine this ETF's own EMA direction
  const price = stock.currentPrice || stock.price || stock.close;
  const ema   = stock.ema21;
  if (!price || !ema) {
    return { score: 4, max: 8, label: 'PARTIAL', detail: 'EMA data missing — neutral', warnings };
  }
  const etfAboveEma = price > ema;

  // Look up the benchmark for this ETF
  // ETF_SECTOR_BENCHMARK[ticker] is:
  //   same ticker   → pure sector ETF (always synced with itself)
  //   sector ticker → compare against that sector ETF's EMA direction
  //   'SPY'         → compare against SPY EMA direction
  //   null          → independent asset (bonds/currencies/crypto) — no comparison
  const benchmark = ETF_SECTOR_BENCHMARK[ticker] ?? null;

  // Independent assets (bonds, currencies, crypto) — no sector benchmark
  if (benchmark === null) {
    return {
      score: 4, max: 8, label: 'INDEPENDENT',
      detail: `No sector benchmark — independent asset class`,
      warnings,
    };
  }

  // Pure sector ETF (XLK, XLE, etc.) — IS the benchmark; always in alignment with itself
  if (benchmark === ticker) {
    return {
      score: 8, max: 8, label: 'ALIGNED',
      detail: `${ticker} IS the sector benchmark`,
      warnings,
    };
  }

  // Get benchmark EMA position
  let benchmarkAboveEma = null;

  if (benchmark === 'SPY') {
    benchmarkAboveEma = context.regime?.live?.spy?.position != null
      ? context.regime.live.spy.position === 'above'
      : context.regime?.spyAboveEma ?? null;
  } else {
    const sectorKey = BENCHMARK_TO_SECTOR_KEY[benchmark];
    if (sectorKey && context.sectorEma?.[sectorKey] != null) {
      benchmarkAboveEma = context.sectorEma[sectorKey].aboveEma ?? null;
    }
  }

  if (benchmarkAboveEma === null) {
    return { score: 4, max: 8, label: 'PARTIAL', detail: `${benchmark} EMA data unavailable — neutral`, warnings };
  }

  // Core question: are the ETF and its benchmark moving in the same direction?
  // Both above EMA (LONG sync) or both below EMA (SHORT sync) = IN ALIGNMENT.
  // Trade direction conflict is already captured by ETF Trend — no double-penalty here.
  const inSync = etfAboveEma === benchmarkAboveEma;
  const sectorTrend = benchmarkAboveEma ? 'LONG' : 'SHORT';

  if (inSync) {
    return {
      score: 8, max: 8, label: 'ALIGNED',
      detail: `${ticker} and ${benchmark} both ${sectorTrend} — in alignment`,
      warnings,
    };
  } else {
    warnings.push(`${ticker} (${etfAboveEma ? 'above' : 'below'} EMA) diverging from ${benchmark} (${benchmarkAboveEma ? 'above' : 'below'} EMA)`);
    return {
      score: 0, max: 8, label: 'CONFLICTED',
      detail: `${ticker} and ${benchmark} moving in opposite directions — sector signal unclear`,
      warnings,
    };
  }
}

function scoreETFMomentumQuality(stock, direction) {
  const warnings = [];
  let pts = 0;

  // Sub-A: RSI positioning (0-3 pts) — is entry timing good within the trend?
  const rsi = stock.rsi14 ?? stock.rsi ?? null;
  if (rsi != null) {
    if (direction === 'LONG') {
      if (rsi >= 40 && rsi <= 65)     pts += 3; // ideal entry zone
      else if (rsi >= 30 && rsi < 40) pts += 2; // oversold, bounce potential
      else if (rsi > 65 && rsi <= 75) pts += 1; // momentum but extended
      else if (rsi < 30)              pts += 1; // deeply oversold, risky
      // rsi > 75: 0 pts — overbought
      if (rsi > 75) warnings.push(`RSI at ${Math.round(rsi)} — overbought risk for LONG entry`);
    } else {
      if (rsi >= 35 && rsi <= 60)     pts += 3; // ideal entry zone
      else if (rsi > 60 && rsi <= 70) pts += 2; // overbought, drop potential
      else if (rsi >= 25 && rsi < 35) pts += 1; // has momentum but extended
      else if (rsi > 70)              pts += 1; // deeply overbought, risky
      // rsi < 25: 0 pts — oversold squeeze risk
      if (rsi < 25) warnings.push(`RSI at ${Math.round(rsi)} — oversold risk for SHORT entry`);
    }
  } else {
    warnings.push('RSI unavailable');
    // 0 pts — no partial credit; RSI is widely available for ETFs
  }

  // Sub-B: Close conviction (0-2 pts) — mirrors D3 Sub-A from Kill scoring
  // Where did the ETF close within its most recent weekly bar?
  const weekHigh  = stock.weekHigh  ?? stock.high  ?? null;
  const weekLow   = stock.weekLow   ?? stock.low   ?? null;
  const closePrice = stock.close ?? stock.currentPrice ?? null;
  if (weekHigh && weekLow && closePrice && weekHigh !== weekLow) {
    let conviction;
    if (direction === 'LONG') {
      conviction = (closePrice - weekLow) / (weekHigh - weekLow);
    } else {
      conviction = (weekHigh - closePrice) / (weekHigh - weekLow);
    }
    if (conviction >= 0.7)      pts += 2; // bulls/bears dominated the bar
    else if (conviction >= 0.4) pts += 1; // neutral close
    // < 0.4: 0 pts — weak close for the direction
  } else {
    // Weekly bar data unavailable — not an error for ETFs, partial credit
    warnings.push('Weekly bar data unavailable for conviction check');
  }

  // Sub-C: Volume health (0-2 pts) — is volume confirming the move?
  const volRatio = stock.volumeRatio ?? stock.relativeVolume ?? null;
  if (volRatio != null) {
    if (volRatio >= 1.5)      pts += 2; // strong confirmation
    else if (volRatio >= 1.0) pts += 1; // normal
    // < 1.0: 0 pts — thin volume, weak conviction
  } else {
    pts += 1; // volume often unavailable for ETFs — partial credit, not ERROR
  }

  pts = Math.min(pts, 7);
  const label = pts >= 5 ? 'STRONG' : pts >= 3 ? 'MODERATE' : 'WEAK';
  return { score: pts, max: 7, label, detail: 'RSI positioning, close conviction, volume', warnings };
}

// ─── ETF wash + exposure check (shared with equity, same logic) ─────────────
function scoreETFRiskCap(stock, context, direction) {
  const warnings = [];
  const ticker = (stock.ticker || '').toUpperCase();

  // Wash rule
  let washStatus = { clean: true, daysRemaining: null };
  if (context.washTickers?.has(ticker)) {
    const washEntry = (context.washRules || []).find(w => (w.ticker || '').toUpperCase() === ticker);
    washStatus = { clean: false, daysRemaining: washEntry?.washSale?.daysRemaining || '?' };
    warnings.push(`WASH RULE: ${ticker} has an active wash window (${washStatus.daysRemaining} days remaining).`);
  }

  return {
    score: 5, max: 5,
    label: washStatus.clean ? 'COMPLIANT' : 'WASH',
    detail: washStatus.clean ? 'No active wash window' : `Wash window: ${washStatus.daysRemaining} days`,
    washStatus, warnings,
  };
}

// ─── Main ETF Analyze function ───────────────────────────────────────────────
export function computeETFAnalyzeScore(stock, context) {
  if (!stock || !context) return null;

  const ticker = (stock.ticker || stock.symbol || '').toUpperCase();
  const assetClass = getETFAssetClass(ticker) || 'THEMATIC';

  // ETF direction is determined by price vs 21 EMA — not by signal.
  // Price above EMA = LONG trend; price below = SHORT trend.
  const price = stock.currentPrice || stock.price || stock.close;
  const ema   = stock.ema21;
  const direction = (price && ema)
    ? (price > ema ? 'LONG' : 'SHORT')
    : inferDirection(stock); // fallback to signal if EMA unavailable

  const components = {};
  const allWarnings = [];

  // ETF SELECTION — Signal Quality (15), ETF Trend (direction only, 0), EMA Slope (10), Macro Alignment (8), Momentum (7)
  const signalQuality   = scoreETFSignalQuality(stock, direction);
  const trendAlignment  = scoreETFTrendAlignment(stock);           // direction indicator, no score
  const emaSlope        = scoreETFEmaSlope(stock, direction);      // 0-10 pts
  const macroAlignment  = scoreETFMacroAlignment(stock, context, ticker, direction);
  const momentumQuality = scoreETFMomentumQuality(stock, direction);

  components.signalQuality   = { score: signalQuality.score,    label: signalQuality.label,    detail: signalQuality.detail,    max: 15 };
  components.trendAlignment  = { score: 0,                      label: trendAlignment.label,   detail: trendAlignment.detail,   max: 0  }; // display only
  components.emaSlope        = { score: emaSlope.score,         label: emaSlope.label,         detail: emaSlope.detail,         max: 10 };
  components.macroAlignment  = { score: macroAlignment.score,   label: macroAlignment.label,   detail: macroAlignment.detail,   max: 8  };
  components.momentumQuality = { score: momentumQuality.score,  label: momentumQuality.label,  detail: momentumQuality.detail,  max: 7  };

  allWarnings.push(...signalQuality.warnings, ...trendAlignment.warnings,
                   ...macroAlignment.warnings, ...momentumQuality.warnings);

  // EXECUTION (13 pts — identical to equity)
  components.sizing  = { score: 8, label: 'SIZE IT',    detail: 'Projected: will use SIZE IT recommendation', max: 8 };
  components.riskCap = { score: 5, label: 'COMPLIANT',  detail: 'Projected: within ETF 5% Vitality cap',     max: 5 };

  // Wash rule warning
  const riskCapResult = scoreETFRiskCap(stock, context, direction);
  if (!riskCapResult.washStatus.clean) {
    components.riskCap = { score: 0, label: 'WASH', detail: riskCapResult.detail, max: 5 };
    allWarnings.push(...riskCapResult.warnings);
  }

  // Sector exposure (warning only — ETFs exempt from concentration limits)
  const sectorExposure = { level: 'CLEAR', netAfter: 0 };
  components.sectorExposure = sectorExposure;

  const score = Object.values(components)
    .filter(c => c.max)
    .reduce((s, c) => s + (c.score || 0), 0);
  const max = 53; // 15 (signal) + 10 (ema slope) + 8 (macro) + 7 (momentum) + 8 (sizing) + 5 (risk)
  const pct = Math.round((score / max) * 100);
  const color = pct >= 80 ? '#28a745' : pct >= 60 ? '#FFD700' : '#dc3545';

  // ETFs have no Kill score — composite = analyze% directly
  const composite = pct;

  const projectedLow  = Math.min(pct + Math.round(35 * 0.7) + Math.round(21 * 0.7), 100);
  const projectedHigh = Math.min(pct + 35 + 25, 100);

  return {
    score, max, pct,
    projected: { low: projectedLow, high: projectedHigh },
    composite,
    killScore: 0,
    components,
    warnings: allWarnings,
    color,
    direction,
    isETF: true,
    assetClass,
    rawData: {
      stock: {
        ticker, exchange: stock.exchange || null,
        sector: stock.sector || null,
        currentPrice: stock.currentPrice || stock.price || null,
      },
      signal: {
        type:  (stock.signal || stock.pnthrSignal || null),
        age:   stock.signalAge ?? stock.weeksSince ?? null,
        price: stock.signalPrice ?? stock.entryPrice ?? null,
      },
      nav: context.nav ?? null,
      analyzedAt: new Date().toISOString(),
    },
  };
}

export function computeAnalyzeScore(stock, context) {
  if (!stock || !context) return null;

  const components = {};
  const warnings = [];
  let score = 0;
  const max = 100;

  const direction = inferDirection(stock);
  const sector = normalizeSector(stock.sector || '');

  // ═══════════════════════════════════════════════════════
  // TIER 1: SETUP QUALITY (40 pts)
  // ═══════════════════════════════════════════════════════

  // T1-A: Signal Quality (0-15)
  const signal = stock.signal || stock.pnthrSignal || null;
  const signalAge = stock.signalAge ?? stock.weeksSince ?? null;
  const sigUp = (signal || '').toUpperCase();

  let t1a = { score: 0, label: 'NO SIGNAL', detail: 'No PNTHR signal' };
  if (sigUp === 'BL' || sigUp === 'SS') {
    const matchesDir = (direction === 'LONG' && sigUp === 'BL') || (direction === 'SHORT' && sigUp === 'SS');
    if (!matchesDir) {
      t1a = { score: 0, label: 'WRONG DIR', detail: 'Signal direction does not match trade direction' };
      warnings.push('Signal direction conflicts with trade direction');
    } else if (signalAge != null && signalAge <= 1) {
      t1a = { score: 15, label: 'FRESH', detail: `${sigUp}+${signalAge} — highest win rate` };
    } else if (signalAge === 2) {
      t1a = { score: 13, label: 'RECENT', detail: `${sigUp}+2 — strong edge` };
    } else if (signalAge === 3) {
      t1a = { score: 10, label: 'ACTIVE', detail: `${sigUp}+3 — good edge` };
    } else if (signalAge === 4) {
      t1a = { score: 6, label: 'AGING', detail: `${sigUp}+4 — reduced edge` };
      warnings.push(`Signal is ${signalAge} weeks old — edge declining`);
    } else if (signalAge === 5) {
      t1a = { score: 3, label: 'STALE', detail: `${sigUp}+5 — diminished edge` };
      warnings.push(`Signal is ${signalAge} weeks old — minimal edge remains`);
    } else if (signalAge != null && signalAge > 5) {
      t1a = { score: 0, label: 'EXPIRED', detail: `${sigUp}+${signalAge} — no edge` };
      warnings.push(`Signal is ${signalAge} weeks old — no statistical edge remains`);
    } else {
      // signalAge is null — have signal but no age yet
      t1a = { score: 8, label: 'SIGNAL', detail: `${sigUp} signal — age unknown` };
    }
  } else if (stock.isDeveloping) {
    t1a = { score: 10, label: 'DEVELOPING', detail: '3/4 conditions met, within 2% of trigger' };
  } else {
    warnings.push('No PNTHR signal — entering without system confirmation');
  }
  score += t1a.score;
  components.signalQuality = t1a;

  // T1-B: Kill Score Context (0-10)
  const killScore = stock.totalScore ?? stock.killScore ?? stock.apexScore ?? null;
  const pipelineMax = stock.pipelineMaxScore ?? stock.maxScore ?? null;

  let t1b = { score: 0, label: 'NOT SCORED', detail: 'Not in Kill pipeline' };
  if (killScore != null && pipelineMax != null && pipelineMax > 0) {
    const pct = (killScore / pipelineMax) * 100;
    if (pct >= 90) t1b = { score: 10, label: 'TOP 10%', detail: `Score ${Math.round(killScore)}/${Math.round(pipelineMax)}` };
    else if (pct >= 75) t1b = { score: 7, label: 'TOP 25%', detail: `Score ${Math.round(killScore)}/${Math.round(pipelineMax)}` };
    else if (pct >= 50) t1b = { score: 4, label: 'TOP 50%', detail: `Score ${Math.round(killScore)}/${Math.round(pipelineMax)}` };
    else t1b = { score: 1, label: 'BOTTOM 50%', detail: `Score ${Math.round(killScore)}/${Math.round(pipelineMax)}` };
  } else if (killScore != null) {
    // Have score but no pipeline max — use tier thresholds
    if (killScore >= 130) t1b = { score: 10, label: 'ALPHA', detail: `Score ${Math.round(killScore)}` };
    else if (killScore >= 100) t1b = { score: 8, label: 'STRIKING', detail: `Score ${Math.round(killScore)}` };
    else if (killScore >= 80) t1b = { score: 6, label: 'HUNTING', detail: `Score ${Math.round(killScore)}` };
    else if (killScore >= 50) t1b = { score: 3, label: 'COILING', detail: `Score ${Math.round(killScore)}` };
    else t1b = { score: 1, label: 'LOW', detail: `Score ${Math.round(killScore)}` };
  } else {
    warnings.push('Stock not in Kill pipeline — no system scoring data');
  }
  score += t1b.score;
  components.killContext = t1b;

  // T1-C: Index Trend (0-8)
  const exch = (stock.exchange || '').toUpperCase();
  const isNasdaq = exch === 'NASDAQ';
  const indexName = isNasdaq ? 'QQQ' : 'SPY';

  let t1c;
  if (context.regime) {
    // Try live position first, fall back to aboveEma flag
    const spyAbove = context.regime.live?.spy?.position != null
      ? context.regime.live.spy.position === 'above'
      : context.regime.spyAboveEma ?? null;
    const qqqAbove = context.regime.live?.qqq?.position != null
      ? context.regime.live.qqq.position === 'above'
      : context.regime.qqqAboveEma ?? null;
    const primaryAbove = isNasdaq ? qqqAbove : spyAbove;

    if (primaryAbove != null) {
      const aligned = (direction === 'LONG' && primaryAbove) || (direction === 'SHORT' && !primaryAbove);
      if (aligned) {
        t1c = { score: 8, label: 'WITH TREND', detail: `${direction} with ${indexName} ${primaryAbove ? 'above' : 'below'} 21 EMA` };
      } else {
        t1c = { score: 0, label: 'AGAINST', detail: `${direction} against ${indexName} ${primaryAbove ? 'above' : 'below'} 21 EMA` };
        warnings.push(`Trading ${direction} against ${indexName} — ${indexName} is ${primaryAbove ? 'above' : 'below'} 21 EMA`);
      }
    } else {
      console.error(`[ANALYZE] Regime loaded but ${indexName} EMA position is null`);
      t1c = { score: 0, label: 'ERROR', detail: `${indexName} EMA data missing — data pipeline failure` };
      warnings.push(`DATA ERROR: ${indexName} EMA unavailable. Score penalized. Report to admin.`);
    }
  } else {
    console.error('[ANALYZE] No regime data in AnalyzeContext');
    t1c = { score: 0, label: 'ERROR', detail: 'Market regime data missing — AnalyzeContext failed to load' };
    warnings.push('DATA ERROR: Market regime unavailable. Score penalized. Check API connection.');
  }
  score += t1c.score;
  components.indexTrend = t1c;

  // T1-D: Sector Trend (0-7)
  const sectorInfo = context.sectorEma?.[sector];

  let t1d;
  if (sectorInfo?.aboveEma != null) {
    const aligned = (direction === 'LONG' && sectorInfo.aboveEma) || (direction === 'SHORT' && !sectorInfo.aboveEma);
    if (aligned) {
      t1d = { score: 7, label: 'WITH SECTOR', detail: `${direction} with ${sector} (${sectorInfo.etf} ${sectorInfo.aboveEma ? 'above' : 'below'} 21 EMA, ${sectorInfo.separation ?? '?'}%)` };
    } else {
      t1d = { score: 0, label: 'AGAINST', detail: `${direction} against ${sector} (${sectorInfo.etf} ${sectorInfo.aboveEma ? 'above' : 'below'} 21 EMA)` };
      warnings.push(`Trading ${direction} against ${sector} — ${sectorInfo.etf} is ${sectorInfo.aboveEma ? 'above' : 'below'} 21 EMA`);
    }
  } else {
    console.error(`[ANALYZE] No sector EMA data for "${sector}" — data bug`);
    t1d = { score: 0, label: 'ERROR', detail: `Sector EMA data missing for ${sector} — data pipeline failure` };
    warnings.push(`DATA ERROR: Sector EMA unavailable for ${sector}. Score penalized.`);
  }
  score += t1d.score;
  components.sectorTrend = t1d;

  // ═══════════════════════════════════════════════════════
  // TIER 2: RISK PROFILE (35 pts)
  // ═══════════════════════════════════════════════════════

  const ticker = (stock.ticker || '').toUpperCase();
  const sd = stock.scoreDetail || {};

  // T2-A: Freshness (0-12) — signal confirmation + age gate
  const confirmation = stock.confirmation || sd.d3?.confirmation || '';
  let t2a;
  if (confirmation === 'CONFIRMED' && signalAge != null && signalAge <= 1) {
    t2a = { score: 12, label: 'CONFIRMED FRESH', detail: `${sigUp}+${signalAge} confirmed — maximum conviction`, max: 12 };
  } else if (confirmation === 'CONFIRMED' && signalAge === 2) {
    t2a = { score: 10, label: 'CONFIRMED', detail: `${sigUp}+2 confirmed — strong conviction`, max: 12 };
  } else if (confirmation === 'CONFIRMED' || (signalAge != null && signalAge <= 3)) {
    t2a = { score: 7, label: 'ACTIVE', detail: `${confirmation || 'UNCONFIRMED'} ${sigUp}+${signalAge ?? '?'} — moderate conviction`, max: 12 };
  } else if (signalAge != null && signalAge <= 5) {
    t2a = { score: 4, label: 'AGING', detail: `${sigUp}+${signalAge} — declining conviction`, max: 12 };
  } else if (signalAge != null && signalAge <= 8) {
    t2a = { score: 2, label: 'STALE', detail: `${sigUp}+${signalAge} — weak conviction`, max: 12 };
  } else if (signalAge != null) {
    t2a = { score: 0, label: 'EXPIRED', detail: `${sigUp}+${signalAge} — no conviction`, max: 12 };
  } else if (sigUp === 'BL' || sigUp === 'SS') {
    // Have signal but no age — chart data may not have loaded yet
    t2a = { score: 4, label: 'SIGNAL', detail: `${sigUp} — age computing`, max: 12 };
  } else {
    t2a = { score: 0, label: 'EXPIRED', detail: 'No signal data', max: 12 };
  }
  score += t2a.score;
  components.freshness = t2a;

  // T2-B: Risk/Reward (0-8) — stop distance quality
  const stopPrice = stock.stopPrice || stock.pnthrStop || sd.d3?.stopPrice || null;
  const currentPrice = stock.currentPrice || stock.price || null;
  let t2b;
  if (stopPrice && currentPrice && stopPrice > 0 && currentPrice > 0) {
    const riskPct = Math.abs(currentPrice - stopPrice) / currentPrice * 100;
    if (riskPct >= 2 && riskPct <= 5) {
      t2b = { score: 8, label: 'IDEAL', detail: `${riskPct.toFixed(1)}% risk — tight, high R:R`, max: 8 };
    } else if (riskPct > 5 && riskPct <= 8) {
      t2b = { score: 6, label: 'GOOD', detail: `${riskPct.toFixed(1)}% risk — moderate stop distance`, max: 8 };
    } else if (riskPct > 8 && riskPct <= 12) {
      t2b = { score: 4, label: 'WIDE', detail: `${riskPct.toFixed(1)}% risk — wide stop reduces R:R`, max: 8 };
      warnings.push(`Wide stop: ${riskPct.toFixed(1)}% risk per share reduces reward-to-risk ratio`);
    } else if (riskPct > 12) {
      t2b = { score: 2, label: 'VERY WIDE', detail: `${riskPct.toFixed(1)}% risk — poor R:R`, max: 8 };
      warnings.push(`Very wide stop: ${riskPct.toFixed(1)}% risk — consider waiting for tighter entry`);
    } else {
      // < 2% — too tight, high chance of getting stopped out
      t2b = { score: 3, label: 'TIGHT', detail: `${riskPct.toFixed(1)}% risk — may be too tight`, max: 8 };
      warnings.push(`Stop very close (${riskPct.toFixed(1)}%) — high probability of getting stopped out`);
    }
  } else {
    t2b = { score: 0, label: 'ERROR', detail: 'Stop price unavailable — data pipeline failure', max: 8 };
  }
  score += t2b.score;
  components.riskReward = t2b;

  // T2-C: Prey Presence (0-8) — multi-strategy confirmation (D8)
  const d8score = sd.d8?.score ?? 0;
  const preyStrats = stock.preyStrategies || sd.d8?.strategies || [];
  // D8 max is 6, scale to 8 pts
  const preyPts = Math.min(Math.round((d8score / 6) * 8), 8);
  let preyLabel = 'NONE';
  if (preyPts >= 6) preyLabel = 'STRONG';
  else if (preyPts >= 3) preyLabel = 'PRESENT';
  else if (preyPts >= 1) preyLabel = 'WEAK';
  const t2c = {
    score: preyPts, label: preyLabel, max: 8,
    detail: preyStrats.length ? `Prey: ${preyStrats.join(', ')}` : 'No Prey strategies active',
  };
  score += t2c.score;
  components.preyPresence = t2c;

  // T2-D: Conviction (0-7) — where price closed in weekly bar (D3 subA)
  // Primary: Kill pipeline D3 convictionPct. Fallback: compute from chart weekly bar.
  let convPct = sd.d3?.convictionPct ?? null;
  if (convPct == null && stock.weekHigh && stock.weekLow && stock.weekHigh > stock.weekLow) {
    const closePrice = stock.close || stock.currentPrice || stock.price;
    if (closePrice != null) {
      const range = stock.weekHigh - stock.weekLow;
      const rawConv = ((closePrice - stock.weekLow) / range) * 100;
      // For SS, conviction is inverted — closing near lows is strong
      convPct = direction === 'SHORT' ? (100 - rawConv) : rawConv;
    }
  }
  let t2d;
  if (convPct != null) {
    if (convPct >= 80)      t2d = { score: 7, label: 'DOMINANT', detail: `${Math.round(convPct)}% conviction — price closed at extreme`, max: 7 };
    else if (convPct >= 65) t2d = { score: 5, label: 'STRONG', detail: `${Math.round(convPct)}% conviction — favorable close`, max: 7 };
    else if (convPct >= 45) t2d = { score: 3, label: 'NEUTRAL', detail: `${Math.round(convPct)}% conviction — mid-range close`, max: 7 };
    else if (convPct >= 25) t2d = { score: 1, label: 'WEAK', detail: `${Math.round(convPct)}% conviction — unfavorable close`, max: 7 };
    else                    t2d = { score: 0, label: 'AGAINST', detail: `${Math.round(convPct)}% conviction — closed against direction`, max: 7 };
  } else {
    t2d = { score: 0, label: 'ERROR', detail: 'Conviction data unavailable — no weekly bar data', max: 7 };
  }
  score += t2d.score;
  components.conviction = t2d;

  // ═══════════════════════════════════════════════════════
  // TIER 3: ENTRY CONDITIONS (25 pts)
  // ═══════════════════════════════════════════════════════

  // T3-A: Slope Strength (0-5) — EMA slope magnitude (D3 subB)
  // Primary: Kill pipeline D3 slopePct. Fallback: chart-computed emaSlope.
  const slopePct = sd.d3?.slopePct ?? stock.emaSlope ?? null;
  let t3a;
  if (slopePct != null) {
    const mag = Math.abs(slopePct);
    if (mag >= 1.0)      t3a = { score: 5, label: 'STRONG', detail: `EMA slope ${slopePct > 0 ? '+' : ''}${slopePct.toFixed(3)}% — powerful trend`, max: 5 };
    else if (mag >= 0.5) t3a = { score: 4, label: 'MODERATE', detail: `EMA slope ${slopePct > 0 ? '+' : ''}${slopePct.toFixed(3)}% — clear trend`, max: 5 };
    else if (mag >= 0.2) t3a = { score: 3, label: 'MILD', detail: `EMA slope ${slopePct > 0 ? '+' : ''}${slopePct.toFixed(3)}% — gentle trend`, max: 5 };
    else if (mag >= 0.1) t3a = { score: 2, label: 'FLAT', detail: `EMA slope ${slopePct > 0 ? '+' : ''}${slopePct.toFixed(3)}% — minimal trend`, max: 5 };
    else                 t3a = { score: 0, label: 'NO TREND', detail: `EMA slope ${slopePct.toFixed(3)}% — no directional conviction`, max: 5 };
  } else {
    t3a = { score: 0, label: 'ERROR', detail: 'EMA slope data unavailable — data pipeline failure', max: 5 };
  }
  score += t3a.score;
  components.slopeStrength = t3a;

  // T3-B: Sector Concentration (0-5) — net directional exposure
  const sectorData = context.sectorExposure?.[sector];
  let sectorImpact = { level: 'CLEAR', netAfter: 0 };
  let t3b;
  if (sectorData) {
    const projectedLongs = (sectorData.longCount || 0) + (direction === 'LONG' ? 1 : 0);
    const projectedShorts = (sectorData.shortCount || 0) + (direction === 'SHORT' ? 1 : 0);
    const projectedNet = Math.abs(projectedLongs - projectedShorts);
    sectorImpact = {
      level: projectedNet > 3 ? 'CRITICAL' : projectedNet === 3 ? 'AT_LIMIT' : 'CLEAR',
      netAfter: projectedNet,
      currentLongs: sectorData.longCount || 0,
      currentShorts: sectorData.shortCount || 0,
    };
    if (projectedNet > 3) {
      t3b = { score: 0, label: 'CRITICAL', detail: `${sector} net ${projectedNet} — exceeds limit`, max: 5 };
      warnings.push(`SECTOR: Adding this ${direction} brings ${sector} to net ${projectedNet}. CRITICAL — exceeds limit.`);
    } else if (projectedNet === 3) {
      t3b = { score: 2, label: 'AT LIMIT', detail: `${sector} net ${projectedNet} — at concentration cap`, max: 5 };
      warnings.push(`SECTOR: Adding this ${direction} brings ${sector} to net ${projectedNet}. At limit.`);
    } else {
      t3b = { score: 5, label: 'CLEAR', detail: `${sector} net ${projectedNet} — within limits`, max: 5 };
    }
  } else {
    t3b = { score: 5, label: 'CLEAR', detail: 'No existing sector exposure', max: 5 };
  }
  score += t3b.score;
  components.sectorConcentration = t3b;
  components.sectorExposure = sectorImpact; // keep for backward compat

  // T3-C: Wash Compliance (0-5)
  let washStatus = { clean: true, daysRemaining: null };
  if (context.washTickers?.has(ticker)) {
    const washEntry = (context.washRules || []).find(w => (w.ticker || '').toUpperCase() === ticker);
    washStatus = { clean: false, daysRemaining: washEntry?.washSale?.daysRemaining || '?' };
    warnings.push(`WASH RULE: ${ticker} has an active wash window (${washStatus.daysRemaining} days remaining). Re-entering triggers wash sale.`);
  }
  const t3c = washStatus.clean
    ? { score: 5, label: 'CLEAN', detail: 'No active wash window', max: 5 }
    : { score: 0, label: 'WASH', detail: `Wash window: ${washStatus.daysRemaining} days remaining`, max: 5 };
  score += t3c.score;
  components.washCompliance = t3c;

  // T3-D: Volatility Context (0-5) — RSI entry timing
  // Primary: Kill D6 RSI. Fallback: top-level weeklyRsi, then chart-computed rsi14.
  const rsi = sd.d6?.curRsi ?? stock.weeklyRsi ?? stock.rsi14 ?? null;
  let t3d;
  if (rsi != null) {
    if (direction === 'SHORT') {
      if (rsi >= 35 && rsi <= 60)      t3d = { score: 5, label: 'IDEAL', detail: `RSI ${Math.round(rsi)} — ideal SS entry zone`, max: 5 };
      else if (rsi > 60 && rsi <= 70)  t3d = { score: 3, label: 'GOOD', detail: `RSI ${Math.round(rsi)} — overbought, drop potential`, max: 5 };
      else if (rsi >= 25 && rsi < 35)  t3d = { score: 2, label: 'EXTENDED', detail: `RSI ${Math.round(rsi)} — already stretched`, max: 5 };
      else {
        t3d = { score: 0, label: 'EXTREME', detail: `RSI ${Math.round(rsi)} — ${rsi > 70 ? 'deeply overbought' : 'oversold squeeze risk'}`, max: 5 };
        warnings.push(`RSI at ${Math.round(rsi)} — ${rsi > 70 ? 'deeply overbought, reversal risk' : 'oversold, squeeze risk for shorts'}`);
      }
    } else {
      if (rsi >= 40 && rsi <= 65)      t3d = { score: 5, label: 'IDEAL', detail: `RSI ${Math.round(rsi)} — ideal BL entry zone`, max: 5 };
      else if (rsi >= 30 && rsi < 40)  t3d = { score: 3, label: 'GOOD', detail: `RSI ${Math.round(rsi)} — oversold, bounce potential`, max: 5 };
      else if (rsi > 65 && rsi <= 75)  t3d = { score: 2, label: 'EXTENDED', detail: `RSI ${Math.round(rsi)} — already stretched`, max: 5 };
      else {
        t3d = { score: 0, label: 'EXTREME', detail: `RSI ${Math.round(rsi)} — ${rsi > 75 ? 'overbought risk' : 'deeply oversold'}`, max: 5 };
        warnings.push(`RSI at ${Math.round(rsi)} — ${rsi > 75 ? 'overbought risk for longs' : 'deeply oversold, catching a knife'}`);
      }
    }
  } else {
    t3d = { score: 0, label: 'ERROR', detail: 'RSI data unavailable — data pipeline failure', max: 5 };
  }
  score += t3d.score;
  components.volatilityContext = t3d;

  // T3-E: Portfolio Fit (0-5) — heat capacity remaining
  // Without real-time portfolio heat data, estimate based on NAV + position count
  const navVal = context.nav ?? null;
  let t3e;
  if (navVal && sectorData) {
    const totalPositions = Object.values(context.sectorExposure || {}).reduce(
      (sum, s) => sum + (s.longCount || 0) + (s.shortCount || 0), 0
    );
    if (totalPositions >= 10) {
      t3e = { score: 2, label: 'TIGHT', detail: `${totalPositions} positions — limited capacity`, max: 5 };
    } else if (totalPositions >= 7) {
      t3e = { score: 3, label: 'MODERATE', detail: `${totalPositions} positions — some capacity`, max: 5 };
    } else {
      t3e = { score: 5, label: 'AMPLE', detail: `${totalPositions} positions — plenty of capacity`, max: 5 };
    }
  } else {
    t3e = { score: 4, label: 'ESTIMATED', detail: 'Portfolio data limited — near-full credit', max: 5 };
  }
  score += t3e.score;
  components.portfolioFit = t3e;

  // ═══════════════════════════════════════════════════════
  // SLIPPAGE WARNING (informational — does not affect score)
  // ═══════════════════════════════════════════════════════

  const signalPrice = stock.signalPrice || stock.entryPrice || null;
  if (signalPrice && currentPrice) {
    const slippagePct = Math.abs(currentPrice - signalPrice) / signalPrice * 100;
    if (slippagePct > 2) {
      warnings.push(`SLIPPAGE: Current price is ${slippagePct.toFixed(1)}% from signal price ($${(+signalPrice).toFixed(2)}).`);
    } else if (slippagePct > 1) {
      warnings.push(`SLIPPAGE: Current price is ${slippagePct.toFixed(1)}% from signal price. Stay within 1% for best entry.`);
    }
    components.slippageWarning = { pct: slippagePct, signalPrice };
  }

  // ═══════════════════════════════════════════════════════
  // FINAL CALCULATIONS
  // ═══════════════════════════════════════════════════════

  const pct = Math.round((score / max) * 100);

  // Composite: Kill score × Analyze%
  const killScoreNum = killScore ?? 0;
  const composite = Math.round(killScoreNum * (pct / 100));

  // Color thresholds
  const color = pct >= 75 ? '#28a745' : pct >= 55 ? '#FFD700' : '#dc3545';

  return {
    score,
    max,
    pct,
    composite,
    killScore: killScoreNum,
    components,
    warnings,
    color,
    direction,

    // ── Tier subtotals for display ────────────────────────────────────────
    tiers: {
      t1: { label: 'Setup Quality', score: (t1a.score + t1b.score + (t1c?.score || 0) + (t1d?.score || 0)), max: 40 },
      t2: { label: 'Risk Profile', score: (t2a.score + t2b.score + t2c.score + t2d.score), max: 35 },
      t3: { label: 'Entry Conditions', score: (t3a.score + t3b.score + t3c.score + t3d.score + t3e.score), max: 25 },
    },

    // ── Snapshot of everything on screen at analysis time ──────────────────
    rawData: {
      kill: {
        totalScore:       stock.totalScore ?? stock.killScore ?? stock.apexScore ?? null,
        pipelineMaxScore: stock.pipelineMaxScore ?? stock.maxScore ?? null,
        rank:             stock.killRank ?? stock.rank ?? null,
        rankChange:       stock.rankChange ?? null,
        tier:             stock.tier ?? stock.killTier ?? null,
        d1:               stock.d1 ?? stock.dimensions?.d1 ?? null,
        d2:               stock.d2 ?? stock.dimensions?.d2 ?? null,
        d3:               stock.d3 ?? stock.dimensions?.d3 ?? null,
        d4:               stock.d4 ?? stock.dimensions?.d4 ?? null,
        d5:               stock.d5 ?? stock.dimensions?.d5 ?? null,
        d6:               stock.d6 ?? stock.dimensions?.d6 ?? null,
        d7:               stock.d7 ?? stock.dimensions?.d7 ?? null,
        d8:               stock.d8 ?? stock.dimensions?.d8 ?? null,
      },
      signal: {
        type:         signal,
        age:          signalAge,
        price:        stock.signalPrice ?? stock.entryPrice ?? null,
        isNew:        stock.isNewSignal || (signalAge != null && signalAge <= 1),
        isDeveloping: stock.isDeveloping || false,
      },
      market: {
        spy: {
          price:      context.regime?.spyPrice ?? null,
          ema21:      context.regime?.spyEma ?? null,
          separation: context.regime?.spySeparation ?? null,
          aboveEma:   context.regime?.live?.spy?.position != null
                        ? context.regime.live.spy.position === 'above'
                        : context.regime?.spyAboveEma ?? null,
          slope:      context.regime?.spyEmaRising ?? null,
        },
        qqq: {
          price:      context.regime?.qqqPrice ?? null,
          ema21:      context.regime?.qqqEma ?? null,
          separation: context.regime?.qqqSeparation ?? null,
          aboveEma:   context.regime?.live?.qqq?.position != null
                        ? context.regime.live.qqq.position === 'above'
                        : context.regime?.qqqAboveEma ?? null,
          slope:      context.regime?.qqqEmaRising ?? null,
        },
        vix:    context.regime?.vix ?? null,
        regime: context.regime?.regime ?? context.regime?.label ?? null,
      },
      sector: {
        name:       sector,
        etf:        sectorInfo?.etf        ?? null,
        price:      sectorInfo?.price      ?? null,
        ema21:      sectorInfo?.ema21      ?? null,
        aboveEma:   sectorInfo?.aboveEma   ?? null,
        separation: sectorInfo?.separation ?? null,
      },
      stock: {
        ticker:       stock.ticker || ticker,
        exchange:     stock.exchange || null,
        sector:       stock.sector || null,
        currentPrice: currentPrice || null,
        stopPrice:    stopPrice || null,
      },
      riskProfile: {
        freshness:    t2a.score,
        riskReward:   t2b.score,
        preyPresence: t2c.score,
        conviction:   t2d.score,
        preyStrategies: preyStrats,
        convictionPct:  convPct,
        slopePct:       slopePct,
        rsi:            rsi,
      },
      sectorExposure: {
        sector:        sector,
        currentLongs:  sectorData?.longCount ?? null,
        currentShorts: sectorData?.shortCount ?? null,
        netExposure:   sectorData?.netExposure ?? null,
        projectedNet:  sectorImpact?.netAfter ?? null,
      },
      wash: {
        active:        !washStatus.clean,
        daysRemaining: washStatus.daysRemaining,
      },
      nav: context.nav ?? null,
      analyzedAt: new Date().toISOString(),
    },
  };
}

// inferDirection is defined at the top of this module (shared by both equity and ETF paths)
