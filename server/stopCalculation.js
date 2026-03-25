/**
 * PNTHR Stop Calculation — SINGLE SOURCE OF TRUTH
 *
 * All PNTHR Stop computations on the server import from here.
 * The client (ChartModal.jsx) uses identical math to draw historical stop lines —
 * any formula change here must be mirrored there.
 *
 * Formula: Wilder ATR(3) trailing ratchet on weekly candles.
 *   BL: stop only moves UP  (ratchets up as long position profits)
 *   SS: stop only moves DOWN (ratchets down as short position profits)
 *
 * Inputs: weeklyBars array with { high, low, close } per bar.
 * Outputs: numeric stop price (2 decimal precision).
 */

/**
 * Wilder's ATR over weekly bars.
 * Returns an array parallel to weeklyBars where atrArr[i] = ATR at bar i.
 * Values are null until the seed period (index = period) is reached.
 *
 * Wilder smoothing: seed = avg(TR[1..period]), then ATR = (prevATR × 2 + TR) / 3
 *
 * @param {Array<{high:number,low:number,close:number}>} weeklyBars
 * @param {number} [period=3]
 * @returns {Array<number|null>}
 */
export function computeWilderATR(weeklyBars, period = 3) {
  const n = weeklyBars.length;
  const atrArr = new Array(n).fill(null);
  if (n < period + 1) return atrArr;

  const trs = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const cur  = weeklyBars[i];
    const prev = weeklyBars[i - 1];
    trs[i] = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low  - prev.close)
    );
  }

  // Seed: simple average of TR[1..period]
  let atr = 0;
  for (let i = 1; i <= period; i++) atr += trs[i];
  atr /= period;
  atrArr[period] = atr;

  // Wilder smoothing forward
  for (let i = period + 1; i < n; i++) {
    atr = (atr * 2 + trs[i]) / 3;
    atrArr[i] = atr;
  }

  return atrArr;
}

/**
 * Initial PNTHR Stop for a new BL (Buy Long) entry.
 *
 * Takes the HIGHER of:
 *   structural floor: 2-week low − $0.01
 *   ATR floor:        entry close − ATR(3)
 *
 * Higher = more conservative (tighter stop above support for a long).
 *
 * @param {number} twoWeekLow  - Lowest low of the 2 weeks prior to entry bar
 * @param {number} entryClose  - Entry bar's closing price
 * @param {number|null} atr    - ATR value at entry bar (null → use structural only)
 * @returns {number}
 */
export function blInitStop(twoWeekLow, entryClose, atr) {
  const structural = parseFloat((twoWeekLow - 0.01).toFixed(2));
  const atrBased   = atr != null ? parseFloat((entryClose - atr).toFixed(2)) : -Infinity;
  return parseFloat(Math.max(structural, atrBased).toFixed(2));
}

/**
 * Initial PNTHR Stop for a new SS (Sell Short) entry.
 *
 * Takes the LOWER of:
 *   structural ceiling: 2-week high + $0.01
 *   ATR ceiling:        entry close + ATR(3)
 *
 * Lower = more conservative (tighter stop below resistance for a short).
 *
 * @param {number} twoWeekHigh - Highest high of the 2 weeks prior to entry bar
 * @param {number} entryClose  - Entry bar's closing price
 * @param {number|null} atr    - ATR value at entry bar (null → use structural only)
 * @returns {number}
 */
export function ssInitStop(twoWeekHigh, entryClose, atr) {
  const structural = parseFloat((twoWeekHigh + 0.01).toFixed(2));
  const atrBased   = atr != null ? parseFloat((entryClose + atr).toFixed(2)) : Infinity;
  return parseFloat(Math.min(structural, atrBased).toFixed(2));
}
