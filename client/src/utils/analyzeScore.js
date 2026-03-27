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
import { getETFAssetClass, isClassifiedETF } from './etfClassification';
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
    return { score: 2, max: 10, label: 'PARTIAL', detail: 'EMA data missing — partial credit', warnings };
  }

  let pts = 0;
  // 1. Price vs EMA (0-4)
  const priceAboveEma = price > ema;
  const aligned = (direction === 'LONG' && priceAboveEma) || (direction === 'SHORT' && !priceAboveEma);
  if (aligned) pts += 4;

  // 2. EMA slope (0-3) — use emaRising if available
  const emaRising = stock.emaRising ?? stock.emaSlope ?? null;
  if (emaRising != null) {
    const slopeAligned = (direction === 'LONG' && emaRising) || (direction === 'SHORT' && !emaRising);
    if (slopeAligned) pts += 3;
    else if (emaRising == null) pts += 1;
  } else {
    pts += 1; // partial if unknown
  }

  // 3. Trend duration (0-3)
  const weeks = stock.signalAge ?? stock.weeksSince ?? null;
  if (weeks != null) {
    if (weeks >= 4) pts += 3;
    else if (weeks >= 2) pts += 2;
    else if (weeks >= 1) pts += 1;
  } else {
    pts += 1; // partial
  }

  const label = pts >= 8 ? 'STRONG' : pts >= 5 ? 'ALIGNED' : pts >= 1 ? 'WEAK' : 'AGAINST';
  return { score: Math.min(pts, 10), max: 10, label, detail: `ETF own-trend alignment`, warnings };
}

function scoreETFMacroAlignment(stock, context, assetClass, direction) {
  const warnings = [];
  let pts = 0;

  const spyAbove = context.regime?.live?.spy?.position != null
    ? context.regime.live.spy.position === 'above'
    : context.regime?.spyAboveEma ?? null;
  const qqqAbove = context.regime?.live?.qqq?.position != null
    ? context.regime.live.qqq.position === 'above'
    : context.regime?.qqqAboveEma ?? null;

  switch (assetClass) {

    case 'COMMODITY': {
      // Commodities are independent of equity indices — use own price momentum
      // Price vs EMA direction is already confirmed in trendAlignment; give base credit
      pts = 4; // base: commodity operates independently
      const ret4w = stock.return4w ?? stock.weeklyReturn4 ?? null;
      if (ret4w != null) {
        const aligned = (direction === 'LONG' && ret4w > 0) || (direction === 'SHORT' && ret4w < 0);
        pts += aligned ? 4 : 1;
      } else {
        pts += 2; // unknown = neutral partial
        warnings.push('Commodity ETF — macro alignment based on own momentum');
      }
      break;
    }

    case 'BOND': {
      // Bonds: INVERSE equity regime alignment (bear market = bond rally)
      if (spyAbove != null) {
        const spyBearish = !spyAbove;
        // Bond LONG aligns with bearish equity (flight to safety)
        const aligned = (direction === 'LONG' && spyBearish) || (direction === 'SHORT' && !spyBearish);
        pts += aligned ? 5 : 2;
      } else {
        pts += 3; // regime unknown = neutral
        warnings.push('Bond ETF — inverse equity regime alignment applied');
      }
      pts += 3; // base: bond ETFs have independent duration risk
      break;
    }

    case 'SECTOR': {
      // Sector ETFs ARE equities — same regime logic as stocks
      if (spyAbove != null && qqqAbove != null) {
        const bearish = !spyAbove || !qqqAbove;
        const aligned = (direction === 'LONG' && !bearish) || (direction === 'SHORT' && bearish);
        if (aligned) {
          const bothAligned = (direction === 'LONG' && spyAbove && qqqAbove) ||
                              (direction === 'SHORT' && !spyAbove && !qqqAbove);
          pts += bothAligned ? 8 : 5;
        } else {
          warnings.push(`Trading ${direction} against equity regime (SPY/QQQ)`);
        }
      } else if (spyAbove != null) {
        const aligned = (direction === 'LONG' && spyAbove) || (direction === 'SHORT' && !spyAbove);
        pts += aligned ? 6 : 0;
      } else {
        pts += 3; // regime unknown
        warnings.push('Regime data unavailable for sector ETF');
      }
      break;
    }

    case 'INDEX': {
      // Index ETFs (SPY, QQQ, DIA, IWM) — circular to check regime against itself
      // Use trend duration as self-referential macro signal
      pts += 4; // base: index ETFs ARE the market
      warnings.push('Index ETF — trend duration used for self-referential macro alignment');
      const weeks = stock.signalAge ?? stock.weeksSince ?? null;
      if (weeks != null) {
        if (weeks >= 4) pts += 4;
        else if (weeks >= 2) pts += 2;
      } else {
        pts += 1;
      }
      break;
    }

    case 'INTERNATIONAL': {
      // International: partial correlation with US regime + own momentum
      if (spyAbove != null) {
        const aligned = (direction === 'LONG' && spyAbove) || (direction === 'SHORT' && !spyAbove);
        pts += aligned ? 4 : 2; // International decorrelates — partial even if against
      } else {
        pts += 3;
      }
      const ret4w = stock.return4w ?? null;
      if (ret4w != null) {
        const momentumAligned = (direction === 'LONG' && ret4w > 0) || (direction === 'SHORT' && ret4w < 0);
        pts += momentumAligned ? 4 : 1;
      } else {
        pts += 2; // partial
      }
      break;
    }

    case 'CURRENCY': {
      // Currencies: DXY correlation — USD bull = UUP LONG aligns with risk-off
      // Simplified: use regime as partial signal, give base credit for independent FX trends
      if (spyAbove != null) {
        // Risk-off (spy below) → USD tends to rally; risk-on → commodity currencies rally
        const riskOff = !spyAbove;
        const usdBull = ['UUP'].includes((stock.ticker || '').toUpperCase());
        // For non-USD ETFs, inverse the logic
        const aligned = usdBull
          ? ((direction === 'LONG' && riskOff) || (direction === 'SHORT' && !riskOff))
          : ((direction === 'LONG' && !riskOff) || (direction === 'SHORT' && riskOff));
        pts += aligned ? 5 : 2;
      } else {
        pts += 3;
      }
      pts += 3; // base: currency trends are independent of equity indices
      break;
    }

    case 'THEMATIC':
    default: {
      // Thematic: similar to sector — check regime
      if (spyAbove != null && qqqAbove != null) {
        const bearish = !spyAbove || !qqqAbove;
        const aligned = (direction === 'LONG' && !bearish) || (direction === 'SHORT' && bearish);
        pts += aligned ? 6 : 2;
      } else if (spyAbove != null) {
        const aligned = (direction === 'LONG' && spyAbove) || (direction === 'SHORT' && !spyAbove);
        pts += aligned ? 5 : 2;
      } else {
        pts += 3;
      }
      pts += 2; // base: thematic has own momentum
      break;
    }
  }

  pts = Math.min(pts, 8);
  const label = pts >= 6 ? 'ALIGNED' : pts >= 3 ? 'PARTIAL' : 'AGAINST';
  return { score: pts, max: 8, label, detail: `${assetClass} macro context`, warnings };
}

function scoreETFVolatilityMomentum(stock, direction) {
  const warnings = [];
  let pts = 0;

  // 1. RSI alignment (0-3)
  const rsi = stock.rsi14 ?? stock.rsi ?? null;
  if (rsi != null) {
    if (direction === 'LONG') {
      if (rsi >= 40 && rsi <= 65) pts += 3;
      else if (rsi >= 30 && rsi < 40) pts += 2;
      else if (rsi > 65 && rsi <= 75) pts += 1;
      else if (rsi > 75) { pts += 0; warnings.push(`RSI at ${Math.round(rsi)} — overbought risk for LONG entry`); }
      else pts += 1; // deep oversold
    } else {
      if (rsi >= 35 && rsi <= 60) pts += 3;
      else if (rsi > 60 && rsi <= 70) pts += 2;
      else if (rsi < 35 && rsi >= 25) pts += 1;
      else if (rsi < 25) { pts += 0; warnings.push(`RSI at ${Math.round(rsi)} — oversold risk for SHORT entry`); }
      else pts += 1;
    }
  } else {
    pts += 1; // RSI often unavailable for ETFs — partial credit
  }

  // 2. Volume confirmation (0-2)
  const volRatio = stock.volumeRatio ?? stock.relativeVolume ?? null;
  if (volRatio != null) {
    if (volRatio >= 1.5) pts += 2;
    else if (volRatio >= 1.0) pts += 1;
  } else {
    pts += 1; // volume data often unavailable — partial credit, not ERROR
  }

  // 3. ATR stability (0-2) — low ATR% = stable trend
  const atr = stock.atr14 ?? stock.atr ?? null;
  const price = stock.currentPrice ?? stock.price ?? stock.close ?? null;
  if (atr && price) {
    const atrPct = (atr / price) * 100;
    if (atrPct <= 2.0) pts += 2;
    else if (atrPct <= 4.0) pts += 1;
  } else {
    pts += 1; // partial credit
  }

  pts = Math.min(pts, 7);
  const label = pts >= 5 ? 'STRONG' : pts >= 3 ? 'MODERATE' : 'WEAK';
  return { score: pts, max: 7, label, detail: 'RSI, volume, ATR stability', warnings };
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
  const macroAlignment = scoreETFMacroAlignment(stock, context, assetClass, direction);
  const volMomentum    = scoreETFVolatilityMomentum(stock, direction);

  components.signalQuality  = { score: signalQuality.score,  label: signalQuality.label,  detail: signalQuality.detail,  max: 15 };
  components.trendAlignment = { score: trendAlignment.score, label: trendAlignment.label, detail: trendAlignment.detail, max: 10 };
  components.macroAlignment = { score: macroAlignment.score, label: macroAlignment.label, detail: macroAlignment.detail, max: 8  };
  components.volMomentum    = { score: volMomentum.score,    label: volMomentum.label,    detail: volMomentum.detail,    max: 7  };

  allWarnings.push(...signalQuality.warnings, ...trendAlignment.warnings,
                   ...macroAlignment.warnings, ...volMomentum.warnings);

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
