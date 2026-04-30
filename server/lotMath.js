// server/lotMath.js
// ── Pyramid-lot math (server-side port of client/src/utils/sizingUtils.js) ──
//
// The client computes lot recommendations (L1-L5 share counts + trigger
// prices) dynamically from NAV every render. To reconcile against TWS
// orders in a daily cron, the server needs the same math — kept here in
// a pure module that mirrors the client EXACTLY so the cron's "this is
// what TWS should show" matches what PyramidCard displays.
//
// Constants are duplicated from sizingUtils.js (not imported) because the
// server can't pull from the client bundle. If you change one, change both —
// the comparison rule is "client and server must produce identical lot arrays
// for identical inputs."
//
// Used by:
//   • lotTriggerCron.js — daily reconciliation against IBKR open orders
//   • POST /api/admin/sync-lot-triggers — manual trigger of same logic
//   • Future: Phase 3 hook to pre-stage lot triggers for manual-add positions

// ── Constants (mirror sizingUtils.js exactly) ────────────────────────────────
export const STRIKE_PCT     = [0.35, 0.25, 0.20, 0.12, 0.08];
export const LOT_NAMES      = ['The Scent', 'The Stalk', 'The Strike', 'The Jugular', 'The Kill'];
export const LOT_OFFSETS    = [0, 0.03, 0.06, 0.10, 0.14];
export const LOT_TIME_GATES = [0, 5, 0, 0, 0];

// Same ETF set the client uses — drives vitality cap (0.5% ETFs vs 1% stocks).
const ETF_LIST = new Set([
  'SPY','QQQ','DIA','IWM','VTI','VOO','VEA','VWO','EEM','EFA',
  'XLE','XLF','XLK','XLV','XLP','XLI','XLU','XLB','XLC','XLRE','XLY',
  'GLD','SLV','TLT','HYG','LQD','USO','UNG',
  'ARKK','SOXX','SMH','IBB','XBI','KRE','XHB','ITB',
  'GDX','GDXJ','RSP','MDY','IJR','SCHA','VB',
  'JETS','BUZZ','KWEB','FXI','INDA',
]);
export function isEtfTicker(ticker, profileIsEtf = false) {
  return profileIsEtf || ETF_LIST.has((ticker || '').toUpperCase());
}

// ── Position sizing (mirror sizingUtils.js sizePosition) ─────────────────────
// Returns the planned TOTAL shares for the position (sum of all 5 lots).
// Caller passes NAV; the cron pulls that from user_profiles.accountSize.
export function sizePosition({ netLiquidity, entryPrice, stopPrice, maxGapPct = 0, isETF = false }) {
  if (!netLiquidity || !entryPrice || !stopPrice) {
    return { totalShares: 0, vitality: 0, gapMult: 1, structRisk: 0 };
  }
  const tickerCap  = netLiquidity * 0.10;
  const vitality   = netLiquidity * (isETF ? 0.005 : 0.01);
  const structRisk = Math.abs((entryPrice - stopPrice) / entryPrice);
  const gapMult    = maxGapPct > structRisk * 100 ? Math.max(0.3, structRisk * 100 / maxGapPct) : 1.0;
  const rps        = Math.abs(entryPrice - stopPrice);
  const totalShares = Math.floor(
    Math.min(rps > 0 ? Math.floor(vitality / rps) : 0, Math.floor(tickerCap / entryPrice)) * gapMult
  );
  return { totalShares, vitality: +vitality.toFixed(0), gapMult: +gapMult.toFixed(2), structRisk: +(structRisk * 100).toFixed(2) };
}

// ── computeLotTriggers ───────────────────────────────────────────────────────
// Pure recompute of L1-L5 from a position + plan total. Mirrors buildLots()
// in sizingUtils.js with one addition: `cumulativeTargetShares` for the
// cleanup-stale rule (per project_4g_lot_trigger_cleanup_rule.md).
//
// Inputs:
//   • position: { direction, entryPrice, stopPrice, isETF, fills }
//   • totalShares: planned sum across all 5 lots (from sizePosition)
//
// Returns: 5-element array, each entry:
//   { lot, name, pct, offsetPct, timeGate, targetShares, cumulativeTargetShares,
//     triggerPrice, filled, actualPrice, actualShares, anchor }
export function computeLotTriggers({ position, totalShares }) {
  const direction = (position?.direction || 'LONG').toUpperCase();
  const isLong    = direction !== 'SHORT';
  const fills     = position?.fills || {};
  // Anchor: Lot 1's actual fill if it filled, else the planned entryPrice.
  // Once L1 fills, the anchor is FIXED — trigger prices stop moving.
  const anchor = fills[1]?.filled && fills[1]?.price
    ? +fills[1].price
    : +(position?.entryPrice || 0);

  let cumulative = 0;
  return STRIKE_PCT.map((pct, i) => {
    const lot          = i + 1;
    const targetShares = Math.max(1, Math.round((+totalShares || 0) * pct));
    cumulative        += targetShares;
    const triggerPrice = isLong
      ? +(anchor * (1 + LOT_OFFSETS[i])).toFixed(2)
      : +(anchor * (1 - LOT_OFFSETS[i])).toFixed(2);
    const fill         = fills[lot] || {};
    return {
      lot,
      name:                   LOT_NAMES[i],
      pct,
      offsetPct:              Math.round(LOT_OFFSETS[i] * 100),
      timeGate:               LOT_TIME_GATES[i],
      targetShares,
      cumulativeTargetShares: cumulative,
      triggerPrice,
      filled:        !!fill.filled,
      actualPrice:   fill.price  != null ? +fill.price  : null,
      actualShares:  fill.shares != null ? +fill.shares : (fill.filled ? targetShares : 0),
      anchor,
    };
  });
}

// ── Lot completion classifier ────────────────────────────────────────────────
// A lot N is "complete" when the position holds at least the cumulative target
// shares through L_N. This is the criterion the 4g cleanup pass uses to decide
// whether a TWS BUY/SELL STOP at L_N's trigger price is stale.
//
// Why it matters: if Scott market-bought past L2 because the L2 STP didn't fill
// cleanly on a fast move, IBKR's actual share count may exceed cumulative-L2
// even though `fills[2].filled` is still false. The cumulative comparison
// catches that case; relying solely on fills[N].filled would miss it.
export function classifyLotCompletion(lots, ibkrShares) {
  const ibkr = Math.abs(+ibkrShares || 0);
  return lots.map(l => ({ ...l, complete: ibkr >= l.cumulativeTargetShares }));
}

// ── Direction → expected lot-trigger order action ───────────────────────────
//   LONG pyramid adds = BUY  STOP above market
//   SHORT pyramid adds = SELL STOP below market
// (Inverse of the protective stop, which is SELL for LONG / BUY for SHORT.)
// Used by the cron to filter IBKR orders to lot-trigger candidates.
export function expectedLotTriggerAction(direction) {
  return (direction || 'LONG').toUpperCase() === 'SHORT' ? 'SELL' : 'BUY';
}

// ── Match TWS stop order to a plan lot by trigger price ─────────────────────
// Tolerance is wider than the protective-stop check ($0.10 vs the $0.05 used
// by stopRatchetCron) because lot triggers are pre-staged at planned levels
// and may carry slight rounding differences from when they were placed. Picks
// the closest match within tolerance.
const LOT_PRICE_TOLERANCE = 0.10;
export function matchTwsOrderToLot(order, lots) {
  if (!order || !Number.isFinite(+order.stopPrice)) return null;
  const px = +order.stopPrice;
  let best = null;
  let bestDiff = Infinity;
  for (const l of lots) {
    if (l.lot === 1) continue; // L1 is the entry, not a trigger
    const diff = Math.abs(l.triggerPrice - px);
    if (diff <= LOT_PRICE_TOLERANCE && diff < bestDiff) {
      best = l;
      bestDiff = diff;
    }
  }
  return best;
}
