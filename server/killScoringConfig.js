// killScoringConfig.js
// PNTHR Kill v3 Scoring — configuration constants and thresholds
// Scoring logic lives in apexService.js; tweak numbers here without touching logic.
// Add a CHANGELOG entry every time you change a value.

export const KILL_CONFIG = {

  // D1: Market Regime Multiplier (0.70× to 1.30×)
  // Exchange routing: Nasdaq → QQQ, NYSE/ARCA → SPY
  // regimeScore (-5 to +5) × multiplierStep = ±0.30 adjustment around 1.0 base
  // BL benefits from bullish regime; SS benefits from bearish regime
  d1: {
    multiplierBase: 1.0,
    multiplierStep: 0.06,   // per regime score point
    multiplierMin:  0.70,
    multiplierMax:  1.30,
    // Index scoring: below+falling=-2, below=-1, above+rising=+2, above=+1
    // Ratio scoring: openRatio >3=-2, >2=-1, <0.5=+2, <1=+1
    // New ratio: newRatio >5 penalises by 1, <0.2 boosts by 1
  },

  // D2: Sector Alignment (capped ±15 pts)
  // 5D component: |return5D%| × newMult × direction × 2
  // 1M component: |return1M%| × direction
  // New signals (signalAge ≤ 1) get ×2 on the 5D component
  d2: {
    cap:              15,
    newSignalMult5D:   2,   // age 0-1 new-signal multiplier on 5D component
    sectorReturn5DScale: 2, // 5D return is doubled per base formula
    sectorReturn1MScale: 1, // 1M return is point-for-point
  },

  // D3: Entry Quality (0–85 pts) — THE DOMINANT DIMENSION
  // Backed by 7,883 closed trades; entry quality is the #1 predictor of trade success
  //   Sub-A: Close conviction (range-normalized) = (close-low)/(high-low)*100 × 2.5  → cap 40
  //   Sub-B: EMA slope (signal-direction only)   = |slope%| × 10                     → cap 30
  //   Sub-C: EMA separation                      = |sep%| × 1.5                      → cap 15
  // Confirmation: CONFIRMED (≥30 pts) → 70%+ win rate evidence
  //               PARTIAL (≥15 pts)   → developing quality
  //               UNCONFIRMED (<15)   → low-quality entry
  d3: {
    convictionMult:        2.5,
    convictionCap:         40,
    slopeMult:             10,
    slopeCap:              30,
    separationMult:        1.5,
    separationCap:         15,
    confirmedThreshold:    30,
    partialThreshold:      15,
  },

  // D4: Signal Freshness (-15 to +10 pts)
  // New signals with strong entry quality earn a bonus.
  // Stale signals decay — position held too long loses edge.
  //   Age 0 (new this week): CONFIRMED=+10, PARTIAL=+6, UNCONFIRMED=+3
  //   Age 1:                 CONFIRMED=+7,  PARTIAL=+4, UNCONFIRMED=+2
  //   Age 2:                 +4 pts
  //   Age 3–5:               0 pts
  //   Age 6–9:               -3 pts per week beyond 5
  //   Age 10+:               -5 pts per week beyond 9, floor -15
  d4: {
    newConfirmedPts:       10,
    newPartialPts:          6,
    newUnconfirmedPts:      3,
    age1ConfirmedPts:       7,
    age1PartialPts:         4,
    age1UnconfirmedPts:     2,
    age2Pts:                4,
    decayStart:             5,  // age > 5 begins decay zone
    decayPerWeekEarly:      3,  // -3/week for age 6–9
    decayDeepStart:         9,  // age > 9 enters deep decay
    decayPerWeekDeep:       5,  // -5/week for age 10+
    floor:                -15,
  },

  // D5: Rank Rise (capped ±20 pts)
  // Linear delta: +1 per spot risen, -1 per spot fallen
  // Capped to prevent rank volatility from dominating
  d5: {
    cap:          20,   // max/min score
  },

  // D6: Momentum (0–20 pts, floored at 0)
  // 4 sub-scores added; raw sum capped 0–20
  //   Sub-A: RSI centered on 50 → (rsi-50)/10 → ±5 range
  //   Sub-B: OBV week-over-week % change → obvPct/5 → ±5 range (inverted for SS)
  //   Sub-C: ADX strength (only if rising) → (adx-15)/5 → 0–5 range
  //   Sub-D: Volume confirmation → 0 or +5 (if volumeRatio > 1.5)
  d6: {
    rsiCenter:        50,
    rsiDivisor:       10,   // (rsi-50)/10 gives ±5 at RSI 100 or 0
    obvDivisor:        5,   // obvChangePct/5 gives ±5 range
    adxMin:           15,   // below this → 0 pts regardless
    adxDivisor:        5,   // (adx-15)/5 gives 0–5 range
    volumeThreshold:   1.5, // volumeRatio > 1.5 triggers +5
    cap:              20,
  },

  // D7: Rank Velocity (-10 to +10 pts)
  // Measures acceleration of rank change (momentum of rank momentum)
  // velocity = currentRankChange - previousRankChange
  // score = clip(round(velocity / velocityDivisor), -10, +10)
  d7: {
    velocityDivisor:   6,
    cap:              10,
  },

  // D8: Multi-Strategy Prey Presence (0–6 pts)
  // SPRINT and HUNT each get extra weight (2 pts each) as direct trade signals
  // Other strategies (Feast, Alpha, Spring, Sneak) each add 1 pt
  // Max 6 pts regardless of strategy count
  d8: {
    sprintPts:  2,
    huntPts:    2,
    otherPts:   1,   // Feast / Alpha / Spring / Sneak
    cap:        6,
  },

};

// =============================================================================
// CHANGELOG — document every change to weights/formulas with date + reason
// =============================================================================
//
// 2026-03-14  v2: Initial design locked — D1–D8 additive formula
//             D1: ±1/week × 5 weeks (additive, range ±5)
//             D2: 5D doubled new signals + 1M point-for-point (uncapped)
//             D3: sep% + conv% (point-for-point, old low/high formula)
//             D4: max(1, 100-rank) — THEN REMOVED same day (was dominating)
//             D5: ±1/spot delta (uncapped)
//             D6: EMA conviction (slope×sep) + RSI-50 + OBV% + ADX (uncapped)
//             D7: consecutive EMA slope weeks, max 20
//             D8: +3/strategy (max 18 with 6 strategies)
//             Formula: D1+D2+D3+D4+D5+D6+D7+D8 (additive)
//
// 2026-03-16  v3: FULL REDESIGN — backed by 7,883 closed trades (Opus analysis)
//             D1: Market MULTIPLIER 0.70×–1.30× (replaces ±5 additive)
//                 regimeScore = indexScore(-2 to +2) + ratioScore(-3 to +3)
//                 BL multiplier = 1.0 + regimeScore×0.06; SS inverted
//             D2: Same formula but now capped ±15
//             D3: NEW formula with 3 sub-scores; cap 85 total
//                 Sub-A: range-normalized conviction × 2.5 (cap 40)
//                 Sub-B: emaSlopePct × 10 (cap 30, signal-direction only)
//                 Sub-C: emaSeparation% × 1.5 (cap 15)
//                 CONFIRMATION gate: ≥30=CONFIRMED, ≥15=PARTIAL, else UNCONFIRMED
//             D4: NEW Signal Freshness -15 to +10 (replaces always-0 D4)
//                 Fresh CONFIRMED signals bonus; stale signals decay penalty
//             D5: Rank delta capped ±20 (was uncapped — prevented volatility dominance)
//             D6: Simplified — RSI±5 + OBV±5 + ADX 0–5 + Volume 0/5; cap 0–20
//             D7: NEW Rank Velocity ±10 (replaces EMA slope duration)
//                 velocity = currentRankChange - previousRankChange
//             D8: NEW weights — SPRINT=2, HUNT=2, others=1 (was +3 flat for all)
//             Formula: (D2+D3+D4+D5+D6+D7+D8) × D1 (MULTIPLICATIVE — not additive)
//
// 2026-03-23  v3.2: Centralized sector name normalization (Scott)
//             BUG_FIX / MEDIUM impact
//             FMP returns "Consumer Cyclical" / "Consumer Defensive" from company
//             profiles; GICS standard is "Consumer Discretionary" / "Consumer Staples".
//             Duplicate normalizeSector() existed in index.js and stockService.js.
//             Two call sites used it inconsistently → Consumer Discretionary sector
//             cards showed zero signal badges on the Sectors page.
//             Fix: created server/sectorUtils.js as single source of truth.
//             Exports: normalizeSector(), warnUnknownSector(), SECTOR_NORMALIZE_MAP,
//             KNOWN_SECTORS. Both index.js and stockService.js now import from there.
//             warnUnknownSector() logs once per process for any sector string not in
//             the map so new FMP renames surface immediately in server logs.
//
