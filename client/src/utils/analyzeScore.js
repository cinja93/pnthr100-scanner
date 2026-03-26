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
  // Regime endpoint returns: { friday, live: { spy: { position: 'above'|'below' }, qqq: { position } } }
  let t1c = { score: 4, label: 'UNKNOWN', detail: 'Index data unavailable' };
  if (context.regime) {
    const exchange = (stock.exchange || '').toUpperCase();
    const isNasdaq = exchange === 'NASDAQ';

    const spyAbove = context.regime.live?.spy?.position === 'above';
    const qqqAbove = context.regime.live?.qqq?.position === 'above';

    // Primary: use exchange-matched index
    const primaryAbove = isNasdaq ? qqqAbove : spyAbove;
    const indexName = isNasdaq ? 'QQQ' : 'SPY';

    // Check if we have valid regime data
    const hasLiveData = context.regime.live?.spy?.position != null;
    if (hasLiveData) {
      const aligned = (direction === 'LONG' && primaryAbove) || (direction === 'SHORT' && !primaryAbove);
      if (aligned) {
        t1c = { score: 8, label: 'WITH TREND', detail: `${direction} with ${indexName} trend` };
      } else {
        t1c = { score: 0, label: 'AGAINST', detail: `${direction} against ${indexName} trend` };
        warnings.push(`Trading ${direction} against ${indexName} — ${indexName} is ${primaryAbove ? 'above' : 'below'} 21 EMA`);
      }
    }
  }
  score += t1c.score;
  components.indexTrend = t1c;

  // T1-D: Sector Trend (0-7)
  let t1d = { score: 3, label: 'UNKNOWN', detail: 'Sector data unavailable' };
  if (stock.sectorAboveEma != null) {
    const aligned = (direction === 'LONG' && stock.sectorAboveEma) || (direction === 'SHORT' && !stock.sectorAboveEma);
    t1d = aligned
      ? { score: 7, label: 'WITH SECTOR', detail: `${direction} with ${sector} trend` }
      : { score: 0, label: 'AGAINST', detail: `${direction} against ${sector} trend` };
    if (!aligned) warnings.push(`Trading ${direction} against ${sector} sector trend`);
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
  };
}

function inferDirection(stock) {
  const sig = (stock.signal || stock.pnthrSignal || '').toUpperCase();
  if (sig === 'SS') return 'SHORT';
  if (sig === 'BL') return 'LONG';
  if (stock.suggestedDirection) return stock.suggestedDirection;
  if (stock.direction) return stock.direction;
  return 'LONG'; // fallback
}
