// server/backtest/backtestMembershipSets.js
//
// Shared helper for backtest scripts: loads index membership events + current
// snapshots, then provides per-Friday membership-set resolution for the
// direction-index gate.
//
// Replaces the legacy exchange-proxy routing (exc === 'NASDAQ' ? QQQ : SPY)
// with the membership-based policy:
//
//   SP500 member (possibly also NDX100)  -> SPY
//   NDX100-only member                   -> QQQ
//   SP400 member (via MDY holdings)      -> MDY (or SPY fallback if MDY omitted)
//   Non-index                            -> SPY fallback
//
// Usage:
//   import { loadMembership, getDirectionIndexForTicker } from './backtestMembershipSets.js';
//   ...
//   await loadMembership(db);                       // once, at startup
//   const idx = getDirectionIndexForTicker(ticker, friday);
//
// Per-Friday set reconstruction is memoized for performance.

import { buildMembershipAsOfDate, getDirectionIndex } from '../gateLogic.js';

let _sp500Events = [];
let _ndx100Events = [];
let _sp500Current = new Set();
let _ndx100Current = new Set();
let _mdyHoldings = null;   // optional
const _cache = new Map();  // friday (YYYY-MM-DD) -> { sp500, ndx100 }

/**
 * Load membership data once. Optionally pass a Set of MDY holdings (SP400 proxy).
 * If omitted, SP400 routing falls back to SPY per gateLogic.getDirectionIndex.
 */
export async function loadMembership(db, { mdyHoldings = null } = {}) {
  const events    = await db.collection('pnthr_index_membership_events').find({}).toArray();
  const snapshots = await db.collection('pnthr_index_membership_current').find({}).toArray();

  _sp500Events  = events.filter(e => e.index === 'SP500');
  _ndx100Events = events.filter(e => e.index === 'NDX100');

  const sp500Snap  = snapshots.find(s => s.index === 'SP500' || s._id === 'SP500');
  const ndx100Snap = snapshots.find(s => s.index === 'NDX100' || s._id === 'NDX100');

  _sp500Current  = new Set(sp500Snap?.tickers  || []);
  _ndx100Current = new Set(ndx100Snap?.tickers || []);
  _mdyHoldings   = mdyHoldings;
  _cache.clear();
}

/**
 * Get membership sets (SP500, NDX100, SP400) as of a specific Friday.
 * Memoized per-Friday for performance.
 */
export function getMembershipSetsForFriday(friday) {
  if (_cache.has(friday)) return _cache.get(friday);
  const sp500  = buildMembershipAsOfDate(_sp500Events,  _sp500Current,  friday);
  const ndx100 = buildMembershipAsOfDate(_ndx100Events, _ndx100Current, friday);
  const sets = { sp500, ndx100, sp400: _mdyHoldings };
  _cache.set(friday, sets);
  return sets;
}

/**
 * Resolve the direction-index ETF for a given ticker as of a given Friday.
 * Membership-based per gateLogic policy.
 */
export function getDirectionIndexForTicker(ticker, friday) {
  const { sp500, ndx100, sp400 } = getMembershipSetsForFriday(friday);
  return getDirectionIndex(ticker, sp500, ndx100, sp400);
}
