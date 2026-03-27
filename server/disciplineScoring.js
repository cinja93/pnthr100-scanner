// server/disciplineScoring.js
// ── PNTHR Trade Discipline Scoring v2 ────────────────────────────────────────
// 3 Tiers · 11 Components · 100 Points Total
//
// T1: Stock Selection & Signal Quality  (40 pts)
// T2: Execution Discipline              (35 pts)
// T3: Exit Discipline                   (25 pts)
// ─────────────────────────────────────────────────────────────────────────────

// ── T1-A: Signal Quality (0-15 pts) ──────────────────────────────────────────
// NOTE: entryContext is set at CONFIRM ENTRY time and never changes.
// Even if the stock subsequently confirms as BL+1, the entry context
// remains DEVELOPING_SIGNAL because that's what the trader knew at entry.
function scoreSignalQuality(signal, signalAge, direction, entryContext) {
  // Developing signal: 3/4 conditions met at time of entry — system-aware, informed entry
  if (entryContext === 'DEVELOPING_SIGNAL') {
    return {
      score:  10,
      label:  'DEVELOPING',
      detail: 'Entered on a developing signal (3/4 conditions met, within 2% of trigger). System-aware entry pending confirmation.',
    };
  }

  if (!signal || signal === 'PAUSE' || signal === 'NO_SIGNAL') {
    return { score: 0, label: 'NO SIGNAL', detail: 'Entered without a PNTHR signal' };
  }
  const matched =
    (direction === 'LONG'  && signal === 'BL') ||
    (direction === 'SHORT' && signal === 'SS');
  if (!matched) {
    return { score: 0, label: 'WRONG DIRECTION', detail: 'Signal direction does not match trade direction' };
  }
  const age = signalAge || 0;
  if (age <= 1) return { score: 15, label: '+1 FRESH',       detail: 'Entered on fresh signal (highest win rate)' };
  if (age === 2) return { score: 8,  label: '+2 RECENT',     detail: 'Signal is 2 weeks old (reduced edge)' };
  if (age === 3) return { score: 3,  label: '+3 STALE',      detail: 'Signal is 3+ weeks old (diminished edge)' };
  return           { score: 0,  label: `+${age} EXPIRED`, detail: 'Signal too old (no statistical edge remains)' };
}

// ── T1-B: Kill Score Context (0-10 pts) ──────────────────────────────────────
function scoreKillContext(killScoreAtEntry) {
  if (!killScoreAtEntry || killScoreAtEntry.totalScore == null) {
    return { score: 0, label: 'NOT SCORED', detail: 'Stock was not in the Kill pipeline at entry' };
  }
  const stock = killScoreAtEntry.totalScore;
  const max   = killScoreAtEntry.pipelineMaxScore;
  if (!max || max <= 0) {
    return { score: 0, label: 'NO DATA', detail: 'Pipeline max score unavailable' };
  }
  const pct = (stock / max) * 100;
  if (pct >= 90) return { score: 10, label: 'TOP 10%',    detail: `Score ${Math.round(stock)}/${Math.round(max)} — elite selection` };
  if (pct >= 75) return { score: 7,  label: 'TOP 25%',    detail: `Score ${Math.round(stock)}/${Math.round(max)} — strong selection` };
  if (pct >= 50) return { score: 4,  label: 'TOP 50%',    detail: `Score ${Math.round(stock)}/${Math.round(max)} — average selection` };
  return           { score: 1,  label: 'BOTTOM 50%', detail: `Score ${Math.round(stock)}/${Math.round(max)} — weak selection` };
}

// ── T1-C: Index Trend Alignment (0-8 pts) ────────────────────────────────────
// Uses stored sectorPosition ('above'/'below') since price vs EMA is pre-computed
function scoreIndexTrend(direction, marketAtEntry, exchange, userConfirmed) {
  // userConfirmed overrides take priority over auto-detection
  if (userConfirmed?.indexTrendAligned === true) {
    return { score: 8, label: 'WITH TREND', detail: 'User confirmed: traded with index trend' };
  }
  if (userConfirmed?.indexTrendAligned === false) {
    return { score: 0, label: 'AGAINST TREND', detail: 'User confirmed: traded against index trend' };
  }

  const isNasdaq  = (exchange || '').toUpperCase() === 'NASDAQ';
  const position  = isNasdaq ? marketAtEntry?.qqqPosition : marketAtEntry?.spyPosition;
  const indexName = isNasdaq ? 'QQQ' : 'SPY';
  if (!position) {
    return { score: 0, label: 'ERROR', detail: `${indexName} position data missing at entry — data pipeline failure` };
  }
  const above   = position === 'above';
  const aligned = (direction === 'LONG' && above) || (direction === 'SHORT' && !above);
  if (aligned) {
    return { score: 8, label: 'WITH TREND',    detail: `Traded ${direction} with ${indexName} ${above ? 'above' : 'below'} 21 EMA` };
  }
  return           { score: 0, label: 'AGAINST TREND', detail: `Traded ${direction} against ${indexName} ${above ? 'above' : 'below'} 21 EMA` };
}

// ── T1-D: Sector Trend Alignment (0-7 pts) ───────────────────────────────────
function scoreSectorTrend(direction, marketAtEntry, userConfirmed) {
  // userConfirmed overrides take priority over auto-detection
  if (userConfirmed?.sectorTrendAligned === true) {
    return { score: 7, label: 'WITH SECTOR', detail: 'User confirmed: traded with sector trend' };
  }
  if (userConfirmed?.sectorTrendAligned === false) {
    return { score: 0, label: 'AGAINST SECTOR', detail: 'User confirmed: traded against sector trend' };
  }
  const position = marketAtEntry?.sectorPosition;
  const etf      = marketAtEntry?.sectorEtf || 'sector ETF';
  if (!position) {
    return { score: 0, label: 'ERROR', detail: `Sector position data missing at entry — data pipeline failure` };
  }
  const above   = position === 'above';
  const aligned = (direction === 'LONG' && above) || (direction === 'SHORT' && !above);
  if (aligned) {
    return { score: 7, label: 'WITH SECTOR',    detail: `Traded ${direction} with ${etf} ${above ? 'above' : 'below'} 21 EMA` };
  }
  return           { score: 0, label: 'AGAINST SECTOR', detail: `Traded ${direction} against ${etf} trend` };
}

// ── T2-A: Position Sizing (0-8 pts) ──────────────────────────────────────────
function scoreSizing(actualShares, expectedShares, userConfirmed) {
  // userConfirmed overrides take priority over auto-detection
  if (userConfirmed?.sizingCorrect === true) {
    return { score: 8, label: 'CONFIRMED', detail: 'User confirmed: used SIZE IT recommendation' };
  }
  if (userConfirmed?.sizingCorrect === false) {
    return { score: 0, label: 'WRONG SIZE', detail: 'User confirmed: deviated from SIZE IT recommendation' };
  }

  if (!expectedShares || expectedShares <= 0) {
    return { score: 0, label: 'ERROR', detail: 'Expected size unavailable — NAV or stop data missing at entry' };
  }
  const dev = Math.abs(actualShares - expectedShares) / expectedShares;
  if (dev <= 0.10) return { score: 8, label: 'CORRECT',    detail: `${actualShares} shr vs ${expectedShares} expected (within 10%)` };
  if (dev <= 0.20) return { score: 4, label: 'CLOSE',      detail: `${actualShares} shr vs ${expectedShares} expected (within 20%)` };
  return             { score: 0, label: 'WRONG SIZE', detail: `${actualShares} shr vs ${expectedShares} expected (>20% off)` };
}

// ── T2-B: Risk Cap Compliance (0-5 pts) ──────────────────────────────────────
function scoreRiskCap(riskDollars, nav, isEtf) {
  if (!nav || nav <= 0) {
    return { score: 0, label: 'ERROR', detail: 'NAV missing at entry — data pipeline failure' };
  }
  const cap     = isEtf ? nav * 0.005 : nav * 0.01;
  const within  = riskDollars <= cap;
  if (within) {
    return { score: 5, label: 'COMPLIANT', detail: `Risk $${riskDollars.toFixed(2)} within ${isEtf ? '0.5%' : '1%'} Vitality ($${cap.toFixed(2)})` };
  }
  return           { score: 0, label: 'EXCEEDED',   detail: `Risk $${riskDollars.toFixed(2)} exceeds ${isEtf ? '0.5%' : '1%'} Vitality ($${cap.toFixed(2)})` };
}

// ── T2-C: Slippage (0-5 pts) ─────────────────────────────────────────────────
function scoreSlippage(slippagePct, hasSignal) {
  if (!hasSignal || slippagePct == null) {
    return { score: 3, label: 'N/A', detail: 'No signal price to measure slippage against' };
  }
  const abs = Math.abs(slippagePct);
  if (abs < 1.0)  return { score: 5, label: 'TIGHT',    detail: `${abs.toFixed(2)}% slippage (under 1%)` };
  if (abs <= 2.0) return { score: 3, label: 'MODERATE', detail: `${abs.toFixed(2)}% slippage (1-2%)` };
  return            { score: 0, label: 'CHASED',    detail: `${abs.toFixed(2)}% slippage (over 2% — chased entry)` };
}

// ── T2-D: Pyramiding Discipline (0-10 pts) ───────────────────────────────────
function scorePyramiding(lots, mfe, entryPrice, direction) {
  const triggers = {
    2: entryPrice * (direction === 'LONG' ? 1.03 : 0.97),
    3: entryPrice * (direction === 'LONG' ? 1.06 : 0.94),
    4: entryPrice * (direction === 'LONG' ? 1.10 : 0.90),
    5: entryPrice * (direction === 'LONG' ? 1.14 : 0.86),
  };
  const mfePrice = mfe?.price || entryPrice;
  let required = 0, correct = 0;
  for (let n = 2; n <= 5; n++) {
    const reached = direction === 'LONG' ? mfePrice >= triggers[n] : mfePrice <= triggers[n];
    if (reached) {
      required++;
      const fill = lots?.[n - 1]; // 0-indexed
      if (fill && fill.shares > 0) correct++;
    }
  }
  if (required === 0) {
    return { score: 10, label: 'N/A — FULL', detail: 'No lot triggers reached — system worked correctly. Full marks.' };
  }
  const score = Math.round((correct / required) * 10);
  const label = correct === required ? 'FOLLOWED' : correct === 0 ? 'SKIPPED ALL' : `${correct}/${required}`;
  return { score, label, detail: `${correct} of ${required} triggered lots were filled` };
}

// ── T2-E: Held Through Drawdown (0-7 pts) ────────────────────────────────────
function scoreHeldDrawdown(exits, entryPrice, direction) {
  const last = exits?.[exits.length - 1];
  if (!last) return { score: 3, label: 'N/A', detail: 'Exit data unavailable' };
  const panicSold = last.reason === 'MANUAL' && (
    (direction === 'LONG'  && last.price < entryPrice) ||
    (direction === 'SHORT' && last.price > entryPrice)
  );
  if (panicSold) return { score: 0, label: 'PANIC SOLD', detail: 'Manually exited at a loss before stop was hit' };
  return             { score: 7, label: 'HELD',       detail: 'Maintained position through drawdown — let the stop manage risk' };
}

// ── T3-A: Exit Method (0-12 pts) ─────────────────────────────────────────────
function scoreExitMethod(exitReason, pnlDollars) {
  const reason = (exitReason || '').toUpperCase().trim();
  switch (reason) {
    case 'SIGNAL':     return { score: 12, label: 'SIGNAL EXIT', detail: 'Exited on system BE/SE signal — maximum discipline' };
    case 'FEAST':      return { score: 12, label: 'FEAST RULE',  detail: 'FEAST triggered (RSI > 85) — system rule followed' };
    case 'STALE_HUNT': return { score: 10, label: 'STALE HUNT',  detail: '20-day stale hunt liquidation — trade never confirmed' };
    case 'STOP_HIT':     return { score: 10, label: 'STOP HIT',     detail: 'Stop hit — system protected capital as designed' };
    case 'RISK_ADVISOR': return { score: 10, label: 'RISK ADVISOR', detail: 'Closed per Risk Advisor recommendation — sector/heat risk management' };
    case 'MANUAL':
      return (pnlDollars ?? 0) > 0
        ? { score: 4, label: 'MANUAL +$', detail: 'Manual exit at profit — overrode system but at least made money' }
        : { score: 0, label: 'MANUAL -$', detail: 'Manual exit at loss — worst case: overrode system AND lost money' };
    default:
      console.error(`[scoreExitMethod] Unrecognized exit reason: "${exitReason}"`);
      return { score: 0, label: 'ERROR', detail: `Exit reason not recorded — data pipeline failure (got: "${exitReason || 'empty'}")` };
  }
}

// ── T3-B: Signal Timing (0-8 pts) ────────────────────────────────────────────
function scoreSignalTiming(exitReason) {
  const reason = (exitReason || '').toUpperCase().trim();
  if (reason === 'SIGNAL') {
    return { score: 8, label: 'ON SIGNAL',   detail: 'Exited on the system exit signal — perfect timing' };
  }
  if (['STOP_HIT', 'FEAST', 'STALE_HUNT', 'RISK_ADVISOR'].includes(reason)) {
    return { score: 6, label: 'SYSTEM RULE', detail: 'Exited via system rule (not primary signal, but disciplined)' };
  }
  if (reason === 'MANUAL') {
    return { score: 0, label: 'EARLY EXIT',  detail: 'Manually exited before any system signal fired' };
  }
  return { score: 0, label: 'ERROR', detail: 'Exit reason not recorded — data pipeline failure' };
}

// ── T3-C: Wash Rule Compliance (0-5 pts) ─────────────────────────────────────
// 'wash-sale' tag on the entry = this entry was placed inside an active 30-day window
function scoreWashCompliance(tags) {
  if (Array.isArray(tags) && tags.includes('wash-sale')) {
    return { score: 0, label: 'WASH VIOLATION', detail: 'Entered during 30-day wash window — tax loss disallowed' };
  }
  return { score: 5, label: 'CLEAN', detail: 'No wash sale violation — clean entry' };
}

// ── Tier label ────────────────────────────────────────────────────────────────
function getTierLabel(score) {
  if (score >= 90) return 'ELITE DISCIPLINE';
  if (score >= 75) return 'STRONG DISCIPLINE';
  if (score >= 60) return 'MODERATE DISCIPLINE';
  if (score >= 40) return 'WEAK DISCIPLINE';
  return 'SYSTEM OVERRIDE';
}

// ── Master function ───────────────────────────────────────────────────────────
export function computeDisciplineScore(journal) {
  const direction  = journal.direction || 'LONG';
  const exchange   = journal.exchange  || '';
  const isETF      = journal.isETF    || false;
  const signal      = journal.signal      || null;
  const signalAge   = journal.signalAge   ?? null;
  const entryContext = journal.entryContext ?? null;
  const hasSignal  = !!(signal && signal !== 'PAUSE' && signal !== 'NO_SIGNAL');
  const lots       = Array.isArray(journal.lots)  ? journal.lots  : [];
  const exits      = Array.isArray(journal.exits) ? journal.exits : [];
  const lastExit   = exits[exits.length - 1];
  const exitReason = lastExit?.reason || 'UNKNOWN';
  const mfe        = journal.mfe || null;
  const nav        = journal.navAtEntry || 0;
  const entryPrice = journal.entry?.fillPrice ?? journal.entryPrice ?? 0;
  const stopPrice  = journal.entry?.stopPrice ?? null;
  const killScore  = journal.killScoreAtEntry ?? null;
  const marketE    = journal.marketAtEntry || {};
  const tags       = Array.isArray(journal.tags) ? journal.tags : [];
  const pnlDollars = journal.performance?.realizedPnlDollar ?? journal.totalPnL ?? 0;

  // Sizing — mirrors sizePosition() + buildLots() with ticker cap
  const stopDist    = stopPrice != null ? Math.abs(entryPrice - stopPrice) : 0;
  const vitality    = nav * (isETF ? 0.005 : 0.01);
  const byVitality  = stopDist > 0 ? Math.floor(vitality / stopDist) : 0;
  const byTickerCap = entryPrice > 0 ? Math.floor((nav * 0.10) / entryPrice) : 0;
  const totalShares = Math.min(byVitality, byTickerCap);
  const expectedLot1 = totalShares > 0 ? Math.max(1, Math.round(totalShares * 0.15)) : 0;
  const actualLot1   = lots[0]?.shares || 0;
  const riskDollars  = actualLot1 * stopDist;

  // Slippage
  const signalPrice = journal.signalPrice ?? null;
  let slippagePct   = null;
  if (hasSignal && signalPrice != null && signalPrice > 0 && entryPrice > 0) {
    const slip = direction === 'LONG' ? entryPrice - signalPrice : signalPrice - entryPrice;
    slippagePct = (Math.abs(slip) / signalPrice) * 100;
  }

  const userConfirmed = journal.userConfirmed || {};

  // === TIER 1: STOCK SELECTION (40 pts) ===
  const t1a = scoreSignalQuality(signal, signalAge, direction, entryContext);
  const t1b = scoreKillContext(killScore);
  const t1c = scoreIndexTrend(direction, marketE, exchange, userConfirmed);
  const t1d = scoreSectorTrend(direction, marketE, userConfirmed);

  // === TIER 2: EXECUTION (35 pts) ===
  const t2a = scoreSizing(actualLot1, expectedLot1, userConfirmed);
  const t2b = scoreRiskCap(riskDollars, nav, isETF);
  const t2c = scoreSlippage(slippagePct, hasSignal);
  const t2d = scorePyramiding(lots, mfe, entryPrice, direction);
  const t2e = scoreHeldDrawdown(exits, entryPrice, direction);

  // === TIER 3: EXIT (25 pts) ===
  const t3a = scoreExitMethod(exitReason, pnlDollars);
  const t3b = scoreSignalTiming(exitReason);
  const t3c = scoreWashCompliance(tags);

  const tier1Total = t1a.score + t1b.score + t1c.score + t1d.score;
  const tier2Total = t2a.score + t2b.score + t2c.score + t2d.score + t2e.score;
  const tier3Total = t3a.score + t3b.score + t3c.score;
  const totalScore = tier1Total + tier2Total + tier3Total;

  const manualExits  = exits.filter(e => e.reason === 'MANUAL');
  const overrideCount = manualExits.length;

  return {
    totalScore,
    tierLabel: getTierLabel(totalScore),
    overrideCount,
    tier1: {
      total: tier1Total, max: 40,
      label: 'STOCK SELECTION & SIGNAL QUALITY',
      components: {
        signalQuality: { ...t1a, max: 15 },
        killContext:   { ...t1b, max: 10 },
        indexTrend:    { ...t1c, max: 8  },
        sectorTrend:   { ...t1d, max: 7  },
      },
    },
    tier2: {
      total: tier2Total, max: 35,
      label: 'EXECUTION DISCIPLINE',
      components: {
        sizing:       { ...t2a, max: 8  },
        riskCap:      { ...t2b, max: 5  },
        slippage:     { ...t2c, max: 5  },
        pyramiding:   { ...t2d, max: 10 },
        heldDrawdown: { ...t2e, max: 7  },
      },
    },
    tier3: {
      total: tier3Total, max: 25,
      label: 'EXIT DISCIPLINE',
      components: {
        exitMethod:     { ...t3a, max: 12 },
        signalTiming:   { ...t3b, max: 8  },
        washCompliance: { ...t3c, max: 5  },
      },
    },
  };
}
