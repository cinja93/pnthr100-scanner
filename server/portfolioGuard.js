/**
 * PNTHR Portfolio Guard — Sacred Field Protection
 *
 * Prevents automated operations (price refresh, IBKR sync) from accidentally
 * overwriting user-entered fill prices, stops, and trade entry data.
 *
 * SACRED FIELDS (never auto-overwrite):
 *   fills[N].price/shares/date — user-entered fill data
 *   stopPrice                  — user-edited stop
 *   originalStop               — set once at entry, immutable
 *   entryPrice                 — set once at entry, immutable
 *   direction                  — LONG/SHORT, editable only via explicit toggle
 *   exits[N].price/shares      — user-entered exit data
 *   signal                     — BL/SS, set at entry
 *
 * AUTO-UPDATE FIELDS (ok to overwrite on refresh):
 *   currentPrice, dayHigh, dayLow — from FMP or IBKR
 *   ibkrAvgCost, ibkrShares, ibkrSyncedAt, ibkrUnrealizedPNL — from IBKR bridge
 *   updatedAt                  — timestamp
 */

export const SACRED_FIELDS = [
  'fills',
  'stopPrice',
  'originalStop',
  'entryPrice',
  'direction',
  'exits',
  'signal',
];

/**
 * Validate a MongoDB update document against the sacred field list.
 * Throws if any sacred field would be auto-overwritten.
 *
 * Use this in IBKR sync and price refresh — NOT in user-initiated saves
 * (commandCenter.positionsSave already handles user saves correctly).
 *
 * @param {Object} updateDoc - MongoDB update document with $set
 * @param {string} [context=''] - Operation name for log messages
 * @throws {Error} if sacred fields would be overwritten
 */
export function validatePortfolioUpdate(updateDoc, context = '') {
  const setFields = Object.keys(updateDoc.$set || {});
  const violations = setFields.filter(f =>
    SACRED_FIELDS.some(s => f === s || f.startsWith(s + '.') || f.startsWith(s + '['))
  );
  if (violations.length > 0) {
    const msg = `[GUARD${context ? ':' + context : ''}] Auto-overwrite of sacred fields blocked: ${violations.join(', ')}`;
    console.error(msg);
    throw new Error(`Cannot auto-overwrite sacred portfolio fields: ${violations.join(', ')}`);
  }
}

/**
 * Build a safe price-only update document.
 * Only touches currentPrice and updatedAt — never sacred fields.
 *
 * @param {number} livePrice
 * @returns {Object} MongoDB update document
 */
export function buildPriceUpdate(livePrice) {
  return {
    $set: {
      currentPrice: livePrice,
      updatedAt:    new Date(),
    },
  };
}
