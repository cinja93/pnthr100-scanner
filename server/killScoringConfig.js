// killScoringConfig.js
// PNTHR Kill Scoring — single source of truth for all weights and formulas
// Tweak numbers here without touching apexService.js logic
// Add a CHANGELOG entry every time you change a value

export const KILL_CONFIG = {

  // D1: Market Direction
  // Exchange routing: Nasdaq → QQQ, NYSE/ARCA → SPY
  // Look back 5 weeks: +1 per week signal aligns with index EMA position, -1 per week against
  d1: {
    lookbackWeeks: 5,       // number of weeks to score
    alignedPts: 1,          // points when signal matches index direction
    misalignedPts: -1,      // points when signal fights index direction
  },

  // D2: Sector Direction
  // Sector direction = sign of sector ETF 5D return (positive = bullish, negative = bearish)
  // 5D: new signals doubled, active/exits +1/-1 each, sector 5D return % doubled
  // 1M: all counts point-for-point, sector 1M return % point-for-point
  d2: {
    newSignalMultiplier5D: 2,     // BL+1 in UP sector / SS+1 in DOWN sector gets ×2
    sectorReturn5DMultiplier: 2,  // sector 5D return % gets doubled
    sectorReturn1MMultiplier: 1,  // sector 1M return % is point-for-point
  },

  // D3: Price Separation + Close Conviction
  // Both sub-scores are pure point-for-point percentages — no config multipliers
  // BL sep: (low - EMA) / EMA * 100
  // BL conv: (close - low) / low * 100
  // SS sep: (EMA - high) / EMA * 100
  // SS conv: (high - close) / high * 100
  d3: {},

  // D4: Rank Position — REMOVED (2026-03-14)
  // Static rank position gave too much weight (up to 99 pts) and drowned out
  // market/sector direction signals. Replaced by pure D5 delta scoring.
  // d4: { floor: 1 },

  // D5: Rank Rise (delta only — no new-entry bonus)
  // Rising: +ptPerSpot per position climbed
  // New entry (rankChange null): 0 pts — no rise data yet
  // Falling: -ptPerSpot per position dropped
  // Flat: 0 pts
  d5: {
    ptPerSpot: 1,           // points per position risen or fallen
    newEntryPts: 0,         // new PNTHR 100 entries get no rank bonus until they actually rise
  },

  // D6: Momentum (4 sub-scores added together)
  d6: {
    // Sub-score A: EMA Conviction = directedSlope% × separation%
    // BL: (+emaSlope%) × ((low-EMA)/EMA*100)
    // SS: (-emaSlope%) × ((EMA-high)/EMA*100)
    // No config — raw product is the score

    // Sub-score B: RSI centered on 50
    // BL: RSI - rsiCenter  →  RSI 65 = +15, RSI 35 = -15
    // SS: rsiCenter - RSI  →  RSI 35 = +15, RSI 65 = -15
    rsiCenter: 50,

    // Sub-score C: OBV week-over-week % change
    // BL: positive = positive pts; SS: inverted (negative OBV = positive pts)
    // Formula: (currentOBV - prevOBV) / abs(prevOBV) * 100
    // No config — raw % is the score

    // Sub-score D: ADX trend strength
    // ADX rising (this week > last week): ADX - adxRisingOffset
    // ADX falling (this week < last week): ADX - adxFallingOffset
    // ADX < adxMinThreshold: 0 pts
    adxRisingOffset: 5,     // ADX 40 rising → 40-5 = 35 pts
    adxFallingOffset: 15,   // ADX 30 falling → 30-15 = 15 pts
    adxMinThreshold: 15,    // below this ADX value = 0 pts regardless
  },

  // D7: EMA Slope Duration
  // Count consecutive weeks EMA has sloped in signal direction going backward from entry
  // BL: ema[i] > ema[i-1] counts; SS: ema[i] < ema[i-1] counts
  // Hard stop: first reversal ends the count
  d7: {
    maxWeeks: 20,           // cap at 20 pts (1 pt per week)
  },

  // D8: Multi-Strategy Prey Presence
  // +ptPerStrategy for each Prey section the stock appears in this week
  // Strategies: Feast, Alpha, Spring, Sneak, Hunt, Sprint (max 6)
  d8: {
    ptPerStrategy: 3,       // small tiebreaker bonus per strategy
  },

};

// =============================================================================
// CHANGELOG — document every change to weights/formulas with date + reason
// =============================================================================
//
// 2026-03-14  Initial design locked after full D1–D8 design session with Cindy + Blazer
//             D1: ±1/week × 5 weeks
//             D2: 5D doubled new signals + 1M point-for-point
//             D3: pure point-for-point separation + conviction %
//             D4: max(1, 100-rank)
//             D5: ±1/spot, new entry = 100-rank
//             D6: EMA conviction (slope×sep) + RSI-50 + OBV% + ADX (rising: -5, falling: -15)
//             D7: 1pt/week consecutive EMA slope, max 20
//             D8: +3pts per Prey strategy
//
// 2026-03-14  REMOVED D4 (rank position). Static rank was dominating scoring — rank #1
//             new entry got 99pts from D4 alone, overwhelming D1 (-5 max) and D2 penalties.
//             D5 new-entry bonus also removed (newEntryPts: 0). Stocks must earn rank
//             credit by actually RISING on the list. D5 is now pure delta only.
//             Tier thresholds recalibrated for lower max possible scores.
//
