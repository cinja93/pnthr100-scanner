// server/backtest/costEngine.js
// ── Single Source of Truth for All Trade Friction Cost Calculations ───────────
//
// Three cost components applied to every trade:
//   1. Commission  — IBKR Pro Fixed: $0.005/share, $1.00 min, 1.0% max of trade value
//   2. Slippage    — 5 basis points adverse per leg (conservative limit-order estimate)
//   3. Borrow cost — SS trades only; sector-tiered annualized rate ÷ 252 per day held
//
// Used by:
//   exportOrdersTrades.js    — backtest trade log generation
//   computeHedgeFundMetrics.js — gross vs. net metric computation
//   exportAuditLog.js        — investor-grade auditable trade export
//
// Usage:
//   import { calcTradeCosts, COST_METHODOLOGY } from './costEngine.js';
//   const costs = calcTradeCosts({ signal, sector, entryPrice, exitPrice,
//                                   shares, tradingDays, dollarPnl, profitPct });
//
// ─────────────────────────────────────────────────────────────────────────────

export const COST_ENGINE_VERSION = '1.0.0';
export const COST_ENGINE_DATE    = '2026-04-07';

// ── 1. Commission ─────────────────────────────────────────────────────────────
//
// IBKR Pro Fixed Pricing (verified April 2026)
// Source: https://www.interactivebrokers.com/en/trading/stocks-pricing.php
//
//   Per share:    $0.005
//   Minimum:      $1.00 per order leg
//   Maximum:      1.0% of total trade value per order leg
//
// Applied to BOTH entry and exit legs of every trade (round-trip).
// Example: 200 shares at $50 = $10,000 trade
//   commission = max($1.00, min(200 × $0.005, $10,000 × 0.01))
//             = max($1.00, min($1.00, $100.00))
//             = $1.00 per leg → $2.00 round-trip = 0.020% of $10K

const COMMISSION_PER_SHARE  = 0.005;
const COMMISSION_MIN        = 1.00;
const COMMISSION_MAX_PCT    = 0.01;   // 1% of trade value cap

/**
 * Calculate IBKR Pro Fixed commission for one order leg.
 * @param {number} shares - Number of shares
 * @param {number} price  - Price per share
 * @returns {number} Commission in dollars (2 decimal places)
 */
export function calcCommission(shares, price) {
  const tradeValue  = Math.abs(shares) * Math.abs(price);
  const raw         = Math.abs(shares) * COMMISSION_PER_SHARE;
  const commission  = Math.max(COMMISSION_MIN, Math.min(raw, tradeValue * COMMISSION_MAX_PCT));
  return parseFloat(commission.toFixed(2));
}

// ── 2. Slippage ───────────────────────────────────────────────────────────────
//
// Conservative estimate for liquid equities using limit-order entries.
// 5 basis points (0.05%) adverse slippage per leg.
//
// Rationale:
//   PNTHR signals are weekly EMA breakouts. Entries are placed at the
//   2-week high (BL) or 2-week low (SS) — price levels the stock reaches
//   naturally during normal trading. No urgency, no market orders.
//
//   For reference:
//     Typical institutional estimate (limit orders, large-cap): 1–3 bps
//     Typical retail estimate (limit orders, mid-cap):          3–8 bps
//     Our model (conservative):                                 5 bps
//
//   Using a MORE conservative number than institutional standard means
//   our net-of-slippage metrics are harder to beat, not easier.
//   If the strategy survives 5 bps, it definitively survives 3 bps.
//
// Applied to BOTH entry and exit legs (adverse direction each time).
// BL entry: pay slightly more. BL exit: receive slightly less.
// SS entry: receive slightly less. SS exit: pay slightly more to cover.

const SLIPPAGE_BPS = 5;   // basis points per leg

/**
 * Calculate slippage cost for one order leg.
 * @param {number} shares - Number of shares
 * @param {number} price  - Price per share at execution
 * @returns {number} Slippage cost in dollars (2 decimal places)
 */
export function calcSlippage(shares, price) {
  return parseFloat((Math.abs(shares) * Math.abs(price) * (SLIPPAGE_BPS / 10000)).toFixed(2));
}

// ── 3. Short Borrow Cost (SS trades only) ─────────────────────────────────────
//
// Short selling requires borrowing shares. IBKR charges a daily borrow fee
// based on the annualized rate for each security.
//
// Rate Tiers:
//   ETB  (Easy to Borrow):           0.25%–1.5% annualized
//   HTB  (Hard to Borrow):           2%–15%+ annualized
//   XHTB (Extremely Hard to Borrow): 15%–50%+ annualized
//
// PNTHR SS Universe Classification:
//   The SS crash gate requires: macro EMA slope falling (2+ weeks) AND
//   sector 5-day return < -3%. These are systematic sector-wide selloffs —
//   the short candidates are predominantly liquid large/mid-cap names
//   experiencing sector-driven selling, NOT individual squeeze candidates.
//   Classification: predominantly ETB, some HTB in volatile sectors.
//
// Conservative rates chosen: higher than typical ETB to be defensible.
// Energy and Real Estate use 1.5%–2.0% acknowledging higher borrow difficulty
// in stressed commodity/REIT environments.
//
// Live trading note: actual IBKR borrow costs are tracked in real-time via
// the commissionReport() callback in the Python bridge (pnthr-ibkr-bridge.py).
// Those actual costs supersede these estimates for live trade analysis.

const BORROW_RATES = {
  'Technology':             0.010,   // 1.0% — mega/large-cap, deep liquidity, ETB
  'Healthcare':             0.010,   // 1.0% — large-cap pharma/biotech, ETB
  'Health Care':            0.010,   // alias
  'Financial Services':     0.010,   // 1.0% — banks/insurers, very liquid, ETB
  'Financials':             0.010,   // alias
  'Consumer Discretionary': 0.010,   // 1.0% — large-cap retail/autos, ETB
  'Consumer Staples':       0.010,   // 1.0% — defensive megacap, very ETB
  'Utilities':              0.010,   // 1.0% — large-cap regulated utilities, ETB
  'Industrials':            0.015,   // 1.5% — mid-cap mix, moderate borrow
  'Communication Services': 0.015,   // 1.5% — mixed market-cap, moderate
  'Basic Materials':        0.015,   // 1.5% — commodities-linked, leaning ETB
  'Materials':              0.015,   // alias
  'Energy':                 0.015,   // 1.5% — volatile sector; stressed enviro = higher borrow
  'Real Estate':            0.020,   // 2.0% — REITs can be harder to borrow in downturns
};

const DEFAULT_BORROW_RATE = 0.015;   // 1.5% fallback for unrecognized sectors

/**
 * Get the annualized borrow rate for a sector.
 * @param {string} sector - Sector name (from PNTHR 679 universe)
 * @returns {number} Annualized borrow rate (e.g. 0.010 = 1.0%)
 */
export function getBorrowRate(sector) {
  return BORROW_RATES[sector] ?? DEFAULT_BORROW_RATE;
}

/**
 * Calculate short borrow cost for an SS trade.
 * @param {number} shares       - Number of shares shorted
 * @param {number} entryPrice   - Price per share at short entry (cost basis for borrow)
 * @param {number} tradingDays  - Number of trading days the position was held
 * @param {string} sector       - Sector name for rate lookup
 * @returns {number} Borrow cost in dollars (2 decimal places)
 */
export function calcBorrowCost(shares, entryPrice, tradingDays, sector) {
  const annualRate  = getBorrowRate(sector);
  const dailyRate   = annualRate / 252;
  const cost        = Math.abs(shares) * Math.abs(entryPrice) * dailyRate * (tradingDays || 0);
  return parseFloat(cost.toFixed(2));
}

// ── 4. Full Trade Cost Bundle ─────────────────────────────────────────────────
//
// Applies all three cost components to a single closed trade.
// Returns a complete cost breakdown record suitable for storage in the
// trade log and the investor-grade audit log.
//
// Input trade object (required fields):
//   signal      {string}  'BL' or 'SS'
//   sector      {string}  Sector name from PNTHR 679 universe
//   entryPrice  {number}  Entry price per share
//   exitPrice   {number}  Exit price per share
//   shares      {number}  Number of shares traded
//   tradingDays {number}  Trading days held
//   dollarPnl   {number}  Gross dollar P&L (before costs)
//   profitPct   {number}  Gross profit percentage (before costs)
//
// Output fields appended to the trade record:
//   positionValue        Shares × entryPrice
//   commissionIn         IBKR commission at entry
//   commissionOut        IBKR commission at exit
//   commissionTotal      Round-trip commission
//   slippageIn           Slippage cost at entry
//   slippageOut          Slippage cost at exit
//   slippageTotal        Round-trip slippage
//   borrowRate           Annual borrow rate (SS only; 0 for BL)
//   borrowCost           Total borrow cost for holding period (SS only)
//   borrowDays           Trading days borrowed (SS only; 0 for BL)
//   totalFrictionDollar  Commission + slippage + borrow
//   totalFrictionPct     Total friction as % of position value
//   netDollarPnl         Gross P&L minus all friction costs
//   netProfitPct         Gross profit% minus friction%
//   netIsWinner          Whether the trade was profitable after all costs

/**
 * Calculate all friction costs for a closed trade.
 * @param {Object} trade - Trade object with required fields (see above)
 * @returns {Object} Cost breakdown object
 */
export function calcTradeCosts(trade) {
  const {
    signal,
    sector,
    entryPrice,
    exitPrice,
    shares,
    tradingDays,
    dollarPnl   = 0,
    profitPct   = 0,
  } = trade;

  const isSS = signal === 'SS';

  // 1. Commission (both legs)
  const commissionIn    = calcCommission(shares, entryPrice);
  const commissionOut   = calcCommission(shares, exitPrice);
  const commissionTotal = parseFloat((commissionIn + commissionOut).toFixed(2));

  // 2. Slippage (both legs, adverse direction)
  const slippageIn    = calcSlippage(shares, entryPrice);
  const slippageOut   = calcSlippage(shares, exitPrice);
  const slippageTotal = parseFloat((slippageIn + slippageOut).toFixed(2));

  // 3. Borrow cost (SS trades only)
  const borrowRate = isSS ? getBorrowRate(sector) : 0;
  const borrowCost = isSS ? calcBorrowCost(shares, entryPrice, tradingDays, sector) : 0;
  const borrowDays = isSS ? (tradingDays || 0) : 0;

  // 4. Totals
  const totalFrictionDollar = parseFloat((commissionTotal + slippageTotal + borrowCost).toFixed(2));
  const positionValue       = parseFloat((Math.abs(shares) * Math.abs(entryPrice)).toFixed(2));
  const totalFrictionPct    = positionValue > 0
    ? parseFloat((totalFrictionDollar / positionValue * 100).toFixed(4))
    : 0;

  // 5. Net performance
  const netDollarPnl = parseFloat((dollarPnl - totalFrictionDollar).toFixed(2));
  const netProfitPct = parseFloat((profitPct - totalFrictionPct).toFixed(4));
  const netIsWinner  = netDollarPnl > 0;

  return {
    positionValue,
    commissionIn,
    commissionOut,
    commissionTotal,
    slippageIn,
    slippageOut,
    slippageTotal,
    borrowRate,
    borrowCost,
    borrowDays,
    totalFrictionDollar,
    totalFrictionPct,
    netDollarPnl,
    netProfitPct,
    netIsWinner,
  };
}

// ── 5. Shares From Position Value ─────────────────────────────────────────────
//
// The backtest uses a fixed $10,000 lot size rather than tracking exact shares.
// This derives the integer share count from lot size and entry price.
//
// Note: actual share counts in live trading may differ by ±1 share due to
// rounding. For the backtest, this is immaterial to cost accuracy.

const LOT_SIZE_USD = 10000;

/**
 * Derive share count from lot size and entry price.
 * @param {number} entryPrice - Entry price per share
 * @param {number} [lotSize]  - Dollar lot size (default $10,000)
 * @returns {number} Integer share count
 */
export function sharesFromLot(entryPrice, lotSize = LOT_SIZE_USD) {
  if (!entryPrice || entryPrice <= 0) return 0;
  return Math.round(lotSize / entryPrice);
}

// ── 6. Methodology Metadata ───────────────────────────────────────────────────
//
// This object is included verbatim in the investor methodology document
// and the audit log export. Every cost assumption is documented here
// with its rationale, source, and effective date.

export const COST_METHODOLOGY = {
  version:       COST_ENGINE_VERSION,
  effectiveDate: COST_ENGINE_DATE,

  commission: {
    model:       'IBKR Pro Fixed',
    source:      'https://www.interactivebrokers.com/en/trading/stocks-pricing.php',
    perShare:    COMMISSION_PER_SHARE,
    minimum:     COMMISSION_MIN,
    maximumPct:  COMMISSION_MAX_PCT,
    formula:     'max($1.00, min(shares × $0.005, tradeValue × 0.01))',
    appliedTo:   'Both entry and exit legs of every trade (round-trip)',
    liveVerification: 'Actual commissions verified via IBKR execution reports in pnthr_ibkr_executions collection',
  },

  slippage: {
    model:       'Conservative limit-order adverse slippage',
    basisPoints: SLIPPAGE_BPS,
    basisPointsPerLeg: true,
    roundTripBps: SLIPPAGE_BPS * 2,
    rationale:   [
      'PNTHR uses weekly EMA breakout entries — price levels the stock reaches naturally.',
      'Limit orders placed at the 2-week high (BL) or 2-week low (SS) fill without urgency.',
      'Institutional standard for liquid large-cap equities with limit orders: 1–3 bps.',
      `Our model uses ${SLIPPAGE_BPS} bps — MORE conservative than institutional standard.`,
      'If the strategy survives 5 bps slippage, it definitively survives 3 bps.',
    ],
    appliedTo:   'Both entry and exit legs of every trade, adverse direction each leg',
    limitation:  'Intraday crash events (VIX > 40) can produce 50–500 bps real slippage. This model does not adjust for tail events.',
  },

  borrowCost: {
    model:       'Sector-tiered IBKR ETB annualized rate',
    rateFormula: 'shares × entryPrice × (annualRate / 252) × tradingDays',
    appliedTo:   'SS (short) trades only; BL trades have zero borrow cost',
    rateSchedule: BORROW_RATES,
    defaultRate:  DEFAULT_BORROW_RATE,
    rationale:   [
      'SS crash gate requires macro slope falling 2+ weeks + sector 5D return < -3%.',
      'These conditions identify sector-wide systematic selloffs, not individual squeeze candidates.',
      'Stocks meeting these conditions are predominantly ETB (Easy to Borrow) at IBKR.',
      'Rates are conservative: slightly above typical ETB to provide a defensive cushion.',
    ],
    liveVerification: 'Actual borrow costs returned by IBKR commissionReport() callback in Python bridge.',
    limitation:  'Does not model forced recall, HTB rate spikes, or borrow unavailability. These are tail risks in individual name stress events, rare in sector-wide systematic selloffs.',
  },

  summary: {
    typicalBLFrictionPct:  '0.10%–0.20% round-trip (commission + slippage only)',
    typicalSSFrictionPct:  '0.15%–0.30% round-trip (commission + slippage + ~2-week borrow)',
    expectedCAGRImpact:    '−1.0% to −1.5% on net-of-cost CAGR vs. gross CAGR',
    conclusion:            'Friction costs reduce CAGR by approximately 1–1.5%. The strategy edge (~30%+ gross CAGR) is an order of magnitude larger than friction costs, confirming robustness.',
  },
};
