// server/lotMath.js
// ── Pyramid-lot math (server-side, used by Phase 4g lot-trigger cron) ───────
//
// The numbers must match what the PNTHR Assistant LIVE table renders for each
// position's L1-L5 plan. Otherwise the cron's "complete vs incomplete" judgment
// will diverge from what the user sees on screen — and the cleanup pass could
// cancel REAL pending pyramid orders (verified the hard way during the 4g
// dry-run on 2026-04-30).
//
// Algorithm: ports `computeLotTargetShares` from server/assistantLiveReconcile.js
// verbatim. That function is the canonical lot-share calculator — it already
// powers the Live table the user is looking at. Key behaviors:
//
//   1. Sizes off ORIGINAL stop, not current ratcheted stop. Once a position's
//      stop ratchets up, current rps shrinks and naive sizePosition would
//      overstate the plan. Original stop preserves the intended risk frame.
//   2. L1-aware adjustment: if the actual L1 fill differs from the recommended
//      L1, recompute total off the actual fill (capped by ticker-cap and
//      vitality), then redistribute remaining shares to L2-L5 using weights
//      30/25/20/10 (sum 85) — NOT raw STRIKE_PCT[1..4] = 25/20/12/8 (sum 65).
//      This is the historical rebalance Command Center does after a Lot-1
//      over/under-fill.
//
// If you change anything here, mirror the change in assistantLiveReconcile.js
// or refactor that file to import from this one (tracked as future cleanup).

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

// ── Lot target shares (the canonical algorithm) ──────────────────────────────
// EXACT port of computeLotTargetShares in server/assistantLiveReconcile.js
// (lines 60-102). Returns [L1, L2, L3, L4, L5] share counts. Same inputs +
// same logic = same outputs as the Live table. Do not "improve" without
// also changing assistantLiveReconcile.js.
export function computeLotTargetShares(position, netLiquidity) {
  const fills      = position?.fills || {};
  const entry      = +position?.entryPrice || 0;
  // CRITICAL: original stop, not current. Ratcheted current stop shrinks rps
  // and inflates the plan total when used for sizing.
  const sizingStop = +(position?.originalStop || position?.stopPrice) || 0;
  const isETF      = !!position?.isETF;
  if (!entry || !sizingStop || !netLiquidity) return [0, 0, 0, 0, 0];

  const tickerCap  = netLiquidity * 0.10;
  const vitality   = netLiquidity * (isETF ? 0.005 : 0.01);
  const maxGapPct  = +position?.maxGapPct || 0;
  const structRisk = Math.abs((entry - sizingStop) / entry);
  const gapMult    = maxGapPct > structRisk * 100 ? Math.max(0.3, structRisk * 100 / maxGapPct) : 1.0;
  const rps        = Math.abs(entry - sizingStop);
  const total      = Math.floor(
    Math.min(rps > 0 ? Math.floor(vitality / rps) : 0, Math.floor(tickerCap / entry)) * gapMult
  );

  const lot1            = fills[1];
  const lot1Actual      = lot1?.filled && lot1?.shares ? +lot1.shares : null;
  const lot1FillPrice   = lot1?.price ? +lot1.price : entry;
  const lot1RPS         = Math.abs(lot1FillPrice - sizingStop);
  const lot1Recommended = Math.max(1, Math.round(total * STRIKE_PCT[0]));

  let effectiveTotal = total;
  let adjShares      = null;
  if (lot1Actual !== null && lot1Actual !== lot1Recommended) {
    const impliedTotal   = Math.round(lot1Actual / STRIKE_PCT[0]);
    const maxByTickerCap = lot1FillPrice > 0 ? Math.floor(netLiquidity * 0.10 / lot1FillPrice) : impliedTotal;
    const maxByVitality  = lot1RPS > 0 ? Math.floor(netLiquidity * (isETF ? 0.005 : 0.01) / lot1RPS) : impliedTotal;
    const cappedTotal    = Math.min(impliedTotal, maxByTickerCap, maxByVitality);
    effectiveTotal       = Math.max(lot1Actual, cappedTotal);

    const remaining = Math.max(0, effectiveTotal - lot1Actual);
    const l2 = Math.round(remaining * 30 / 85);
    const l3 = Math.round(remaining * 25 / 85);
    const l4 = Math.round(remaining * 20 / 85);
    const l5 = Math.max(0, remaining - l2 - l3 - l4);
    adjShares = [lot1Actual, l2, l3, l4, l5];
  }

  const targets = STRIKE_PCT.map(pct => Math.max(1, Math.round(effectiveTotal * pct)));
  return targets.map((tgt, i) => adjShares && adjShares[i] !== tgt ? adjShares[i] : tgt);
}

// ── computeLotPlan ───────────────────────────────────────────────────────────
// Returns a 5-element array (L1-L5) with everything the cron needs:
// targetShares from the canonical algorithm, deterministic trigger prices
// from anchor + LOT_OFFSETS, fill state, and the running cumulative target.
//
// `cumulativeTargetShares` is the keystone for the cleanup-stale rule: a
// lot N is "complete" iff IBKR shares ≥ cumulative through L_N. The cron's
// cleanup pass uses this to decide whether a TWS BUY/SELL STOP at L_N's
// trigger price is stale.
export function computeLotPlan(position, netLiquidity) {
  const direction = (position?.direction || 'LONG').toUpperCase();
  const isLong    = direction !== 'SHORT';
  const fills     = position?.fills || {};
  // Anchor: actual L1 fill price if filled, else planned entryPrice.
  // Once L1 fills, anchor is FIXED — trigger prices stop drifting forever.
  const anchor = fills[1]?.filled && fills[1]?.price
    ? +fills[1].price
    : +(position?.entryPrice || 0);

  const targetShares = computeLotTargetShares(position, netLiquidity);

  let cumulative = 0;
  return targetShares.map((tgt, i) => {
    const lot          = i + 1;
    cumulative        += tgt;
    const triggerPrice = isLong
      ? +(anchor * (1 + LOT_OFFSETS[i])).toFixed(2)
      : +(anchor * (1 - LOT_OFFSETS[i])).toFixed(2);
    const fill = fills[lot] || {};
    return {
      lot,
      name:                   LOT_NAMES[i],
      pct:                    STRIKE_PCT[i],
      offsetPct:              Math.round(LOT_OFFSETS[i] * 100),
      timeGate:               LOT_TIME_GATES[i],
      targetShares:           tgt,
      cumulativeTargetShares: cumulative,
      triggerPrice,
      filled:        !!fill.filled,
      actualPrice:   fill.price  != null ? +fill.price  : null,
      actualShares:  fill.shares != null ? +fill.shares : (fill.filled ? tgt : 0),
      anchor,
    };
  });
}

// ── Lot completion classifier ────────────────────────────────────────────────
// A lot N is "complete" when the position holds at least the cumulative target
// shares through L_N. The cron's cleanup pass uses this to decide whether a
// TWS BUY/SELL STOP at L_N's trigger price is stale.
//
// Why cumulative (not just `fills[n].filled`): if the user market-bought past
// L_N because the L_N STP didn't fill cleanly on a fast move, IBKR shares may
// exceed cumL_N even though `fills[n].filled` is still false. The cumulative
// comparison catches that case.
export function classifyLotCompletion(lots, ibkrShares) {
  const ibkr = Math.abs(+ibkrShares || 0);
  return lots.map(l => ({ ...l, complete: ibkr >= l.cumulativeTargetShares }));
}

// ── Direction → expected lot-trigger order action ───────────────────────────
// LONG pyramid adds = BUY  STOP above market
// SHORT pyramid adds = SELL STOP below market
// (Inverse of the protective stop, which is SELL for LONG / BUY for SHORT.)
export function expectedLotTriggerAction(direction) {
  return (direction || 'LONG').toUpperCase() === 'SHORT' ? 'SELL' : 'BUY';
}

// ── Match TWS stop order to a plan lot by trigger price ─────────────────────
// Tolerance now scales with the trigger price (3% pct, $0.10 abs floor).
// Pre-fix this used a hard $0.10 — too tight when the L1 anchor drifts and
// pre-existing TWS orders end up off-target by $0.20-$3 (e.g., CSCO 5/4:
// stale TWS orders from $92.44 anchor vs current $92.65 anchor diverged by
// $0.22 per lot, fell outside $0.10, were skipped as "user-placed unrelated"
// → cron then placed fresh canonical orders alongside, accumulating dupes).
// 3% is wide enough for any reasonable anchor drift, narrow enough that
// truly unrelated user orders (e.g., a tactical BUY STOP $20 away) still
// don't get auto-modified.
const LOT_PRICE_TOLERANCE_ABS = 0.10;
const LOT_PRICE_TOLERANCE_PCT = 0.03;
export function matchTwsOrderToLot(order, lots) {
  if (!order || !Number.isFinite(+order.stopPrice)) return null;
  const px = +order.stopPrice;
  let best = null;
  let bestDiff = Infinity;
  for (const l of lots) {
    if (l.lot === 1) continue; // L1 is the entry, not a trigger
    const tolerance = Math.max(LOT_PRICE_TOLERANCE_ABS, l.triggerPrice * LOT_PRICE_TOLERANCE_PCT);
    const diff = Math.abs(l.triggerPrice - px);
    if (diff <= tolerance && diff < bestDiff) {
      best = l;
      bestDiff = diff;
    }
  }
  return best;
}
