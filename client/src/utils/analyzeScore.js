/**
 * PNTHR Analyze — Pre-Trade Scoring System
 *
 * Computes the pre-trade discipline score for a stock using shared context
 * (regime, sector exposure, wash rules, NAV) loaded once per page.
 *
 * Returns:
 * {
 *   score: number,       // points earned (0-53)
 *   max: 53,
 *   pct: number,         // percentage (0-100)
 *   projected: { low, high },
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

function scoreETFTrendAlignment(stock, direction) {
  const warnings = [];
  const price = stock.currentPrice || stock.price || stock.close;
  const ema = stock.ema21;

  if (!price || !ema) {
    warnings.push('Price or EMA unavailable for trend alignment');
    return { score: 5, max: 10, label: 'PARTIAL', detail: 'EMA data missing — partial credit', warnings };
  }

  const priceAboveEma = price > ema;
  const etfTrend = priceAboveEma ? 'LONG' : 'SHORT';
  const aligned = etfTrend === direction;

  if (aligned) {
    return {
      score: 10, max: 10, label: 'ALIGNED',
      detail: `Price ${priceAboveEma ? 'above' : 'below'} 21 EMA — ${etfTrend} trend confirmed`,
      warnings,
    };
  } else {
    warnings.push(`ETF trend is ${etfTrend} (price ${priceAboveEma ? 'above' : 'below'} EMA) — trading against trend`);
    return {
      score: 0, max: 10, label: 'AGAINST',
      detail: `Price ${priceAboveEma ? 'above' : 'below'} 21 EMA — trend is ${etfTrend}, trade direction is ${direction}`,
      warnings,
    };
  }
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

  // Independent assets (bonds, currencies, crypto) — scored on own trend only
  if (benchmark === null) {
    const tradeAligned = (direction === 'LONG' && etfAboveEma) || (direction === 'SHORT' && !etfAboveEma);
    return {
      score: tradeAligned ? 6 : 2, max: 8,
      label: tradeAligned ? 'OWN TREND' : 'AGAINST',
      detail: `Independent asset — no sector benchmark; price ${etfAboveEma ? 'above' : 'below'} 21 EMA`,
      warnings,
    };
  }

  // Pure sector ETF (XLK, XLE, etc.) — compares against itself
  if (benchmark === ticker) {
    const tradeAligned = (direction === 'LONG' && etfAboveEma) || (direction === 'SHORT' && !etfAboveEma);
    if (tradeAligned) {
      return { score: 8, max: 8, label: 'ALIGNED', detail: `${ticker} IS the sector benchmark — trend confirms direction`, warnings };
    } else {
      warnings.push(`Trading ${direction} against ${ticker} sector trend`);
      return { score: 0, max: 8, label: 'AGAINST', detail: `${ticker} IS the sector benchmark — trading against its own trend`, warnings };
    }
  }

  // Get benchmark EMA position
  let benchmarkAboveEma = null;
  let benchmarkLabel = benchmark;

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
    return { score: 4, max: 8, label: 'PARTIAL', detail: `${benchmarkLabel} EMA data unavailable — neutral`, warnings };
  }

  // Are the ETF and its benchmark moving in the same direction?
  const inSync = etfAboveEma === benchmarkAboveEma;
  const sectorTrend = benchmarkAboveEma ? 'LONG' : 'SHORT';
  const tradeAligned = (direction === 'LONG' && benchmarkAboveEma) || (direction === 'SHORT' && !benchmarkAboveEma);

  if (inSync && tradeAligned) {
    // ETF and benchmark both confirm trade direction
    return {
      score: 8, max: 8, label: 'ALIGNED',
      detail: `${ticker} and ${benchmark} both ${sectorTrend} — sector confirms trade`,
      warnings,
    };
  } else if (inSync && !tradeAligned) {
    // ETF and benchmark are synced but both point against the trade
    warnings.push(`${ticker} and ${benchmark} both ${sectorTrend} — trading ${direction} against sector`);
    return {
      score: 2, max: 8, label: 'AGAINST',
      detail: `${ticker} and ${benchmark} in sync but ${sectorTrend} — sector opposes ${direction} trade`,
      warnings,
    };
  } else {
    // ETF and benchmark are diverging — mixed signal
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
  const direction = inferDirection(stock);
  const assetClass = getETFAssetClass(ticker) || 'THEMATIC';

  const components = {};
  const allWarnings = [];

  // ETF SELECTION (40 pts)
  const signalQuality  = scoreETFSignalQuality(stock, direction);
  const trendAlignment = scoreETFTrendAlignment(stock, direction);
  const macroAlignment = scoreETFMacroAlignment(stock, context, ticker, direction);
  const momentumQuality = scoreETFMomentumQuality(stock, direction);

  components.signalQuality  = { score: signalQuality.score,   label: signalQuality.label,   detail: signalQuality.detail,   max: 15 };
  components.trendAlignment = { score: trendAlignment.score,  label: trendAlignment.label,  detail: trendAlignment.detail,  max: 10 };
  components.macroAlignment = { score: macroAlignment.score,  label: macroAlignment.label,  detail: macroAlignment.detail,  max: 8  };
  components.momentumQuality = { score: momentumQuality.score, label: momentumQuality.label, detail: momentumQuality.detail, max: 7  };

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
  const max = 53;
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
  const max = 53;

  const direction = inferDirection(stock);
  const sector = normalizeSector(stock.sector || '');

  // ═══════════════════════════════════════════════════════
  // TIER 1: STOCK SELECTION (40 pts)
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
      t1a = { score: 15, label: 'FRESH', detail: `${sigUp}+1 — highest win rate` };
    } else if (signalAge === 2) {
      t1a = { score: 8, label: 'RECENT', detail: `${sigUp}+2 — reduced edge` };
    } else if (signalAge === 3) {
      t1a = { score: 3, label: 'STALE', detail: `${sigUp}+3 — diminished edge` };
    } else if (signalAge != null && signalAge > 3) {
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
    else if (killScore >= 100) t1b = { score: 7, label: 'STRIKING', detail: `Score ${Math.round(killScore)}` };
    else if (killScore >= 80) t1b = { score: 4, label: 'HUNTING', detail: `Score ${Math.round(killScore)}` };
    else if (killScore >= 50) t1b = { score: 2, label: 'COILING', detail: `Score ${Math.round(killScore)}` };
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
  // TIER 2: EXECUTION (projected — 13 pts)
  // ═══════════════════════════════════════════════════════

  // T2-A: Sizing (0-8) — assume will follow SIZE IT
  const t2a = { score: 8, label: 'SIZE IT', detail: 'Projected: will use SIZE IT recommendation' };
  score += t2a.score;
  components.sizing = t2a;

  // T2-B: Risk Cap (0-5)
  const t2b = { score: 5, label: 'COMPLIANT', detail: 'Projected: within Vitality cap' };
  score += t2b.score;
  components.riskCap = t2b;

  // ═══════════════════════════════════════════════════════
  // BONUS CHECKS (warnings only — not subtracted from score)
  // ═══════════════════════════════════════════════════════

  // Wash Rule Check
  const ticker = (stock.ticker || '').toUpperCase();
  let washStatus = { clean: true, daysRemaining: null };
  if (context.washTickers?.has(ticker)) {
    const washEntry = (context.washRules || []).find(w => (w.ticker || '').toUpperCase() === ticker);
    washStatus = { clean: false, daysRemaining: washEntry?.washSale?.daysRemaining || '?' };
    warnings.push(`WASH RULE: ${ticker} has an active wash window (${washStatus.daysRemaining} days remaining). Re-entering triggers wash sale.`);
  }
  components.washRule = washStatus.clean
    ? { score: 5, label: 'CLEAN', detail: 'No active wash window' }
    : { score: 0, label: 'WASH', detail: `Wash window: ${washStatus.daysRemaining} days remaining` };

  // Sector Exposure Check
  const sectorData = context.sectorExposure?.[sector];
  let sectorImpact = { level: 'CLEAR', netAfter: 0 };
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
      warnings.push(`SECTOR: Adding this ${direction} brings ${sector} to net ${projectedNet}. CRITICAL — exceeds limit.`);
    } else if (projectedNet === 3) {
      warnings.push(`SECTOR: Adding this ${direction} brings ${sector} to net ${projectedNet}. At limit.`);
    }
  }
  components.sectorExposure = sectorImpact;

  // Slippage Warning
  const signalPrice = stock.signalPrice || stock.entryPrice || null;
  const currentPrice = stock.currentPrice || stock.price || null;
  if (signalPrice && currentPrice) {
    const slippagePct = Math.abs(currentPrice - signalPrice) / signalPrice * 100;
    if (slippagePct > 2) {
      warnings.push(`SLIPPAGE: Current price is ${slippagePct.toFixed(1)}% from signal price ($${(+signalPrice).toFixed(2)}). Over 2% costs discipline points.`);
    } else if (slippagePct > 1) {
      warnings.push(`SLIPPAGE: Current price is ${slippagePct.toFixed(1)}% from signal price. Stay within 1% for full points.`);
    }
    components.slippageWarning = { pct: slippagePct, signalPrice };
  }

  // ═══════════════════════════════════════════════════════
  // FINAL CALCULATIONS
  // ═══════════════════════════════════════════════════════

  const pct = Math.round((score / max) * 100);

  // Projected full score range
  const projectedExecution = 35;
  const projectedExit = 21;
  const projectedLow = score + Math.round(projectedExecution * 0.7) + Math.round(projectedExit * 0.7);
  const projectedHigh = score + projectedExecution + 25;

  // Composite: Kill score × Analyze%
  const killScoreNum = killScore ?? 0;
  const composite = Math.round(killScoreNum * (pct / 100));

  // Color
  const color = pct >= 80 ? '#28a745' : pct >= 60 ? '#FFD700' : '#dc3545';

  return {
    score,
    max,
    pct,
    projected: {
      low: Math.min(projectedLow, 100),
      high: Math.min(projectedHigh, 100),
    },
    composite,
    killScore: killScoreNum,
    components,
    warnings,
    color,
    direction,

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
        ticker:       stock.ticker,
        exchange:     stock.exchange || null,
        sector:       stock.sector || null,
        currentPrice: stock.currentPrice || stock.price || null,
        stopPrice:    stock.stopPrice || stock.pnthrStop || null,
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
