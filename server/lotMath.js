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
    const fill         = fills[lot] || {};
    // If a catch-up rebalance has stored an explicit targetShares on this
    // lot's fill record (rebalancedFromCatchUp=true), honor that over the
    // canonical algorithmic value. Otherwise the lotTriggerCron's MODIFY
    // pass would compute the algorithmic count and overwrite the rebalance
    // every tick. Locked-in by computeCatchUpRebalance + lotFillRecorder
    // step-6 logic.
    const effectiveTarget = fill.rebalancedFromCatchUp && Number.isFinite(+fill.targetShares)
      ? +fill.targetShares
      : tgt;
    cumulative        += effectiveTarget;
    const triggerPrice = isLong
      ? +(anchor * (1 + LOT_OFFSETS[i])).toFixed(2)
      : +(anchor * (1 - LOT_OFFSETS[i])).toFixed(2);
    return {
      lot,
      name:                   LOT_NAMES[i],
      pct:                    STRIKE_PCT[i],
      offsetPct:              Math.round(LOT_OFFSETS[i] * 100),
      timeGate:               LOT_TIME_GATES[i],
      targetShares:           effectiveTarget,
      cumulativeTargetShares: cumulative,
      triggerPrice,
      filled:        !!fill.filled,
      actualPrice:   fill.price  != null ? +fill.price  : null,
      actualShares:  fill.shares != null ? +fill.shares : (fill.filled ? effectiveTarget : 0),
      anchor,
      rebalanced:    !!fill.rebalancedFromCatchUp,
    };
  });
}

// ── Target average price ────────────────────────────────────────────────────
// Computed once at L1 fill and stored on the position as `targetAvg`. Never
// recomputed. This is the share-weighted avg the position WOULD reach if every
// lot fills exactly at its planned price (L1 actual + L2-L5 trigger prices).
//
// Used by the live table card (displayed in outlined box under ticker) and
// by the missed-lot catch-up algorithm (preserves this avg through rebalance
// of upper lot share counts).
//
// Returns null if the plan is empty or invalid.
export function computeTargetAvg(position, netLiquidity) {
  const plan = computeLotPlan(position, netLiquidity);
  if (!plan || plan.length === 0) return null;
  // L1 anchor (actual fill price if filled, else entry price). Upper lots
  // contribute at their planned trigger prices.
  const fills = position?.fills || {};
  const l1Price = fills[1]?.filled && fills[1]?.price
    ? +fills[1].price
    : +(position?.entryPrice || 0);
  if (!l1Price) return null;
  let totalCost = 0;
  let totalShares = 0;
  for (const lot of plan) {
    const shares = +lot.targetShares || 0;
    if (shares <= 0) continue;
    const price = lot.lot === 1 ? l1Price : +lot.triggerPrice;
    if (!price) continue;
    totalCost += shares * price;
    totalShares += shares;
  }
  if (totalShares <= 0) return null;
  return +(totalCost / totalShares).toFixed(4);
}

// ── Catch-up rebalance math ─────────────────────────────────────────────────
// When a lot trigger N is missed (price crossed without fill), compute the
// catch-up shares Sa + a scale factor k for upper lots (N+1..5) such that:
//   1. final share-weighted avg = targetAvg (T) — exactly preserved
//   2. total final share count ≈ original plan total (preserves position size)
//
// Per design: front-load Sa (more than originally planned for L_N) at the
// "lower" catch-up price Pa, scale upper lots DOWN to compensate. This
// gives MORE shares earlier in the trade (better partial-exit outcomes)
// vs scaling everything uniformly.
//
// Two-equation solve:
//   Sa + k·S_upper_total = plan_total - S1                ← preserves total
//   S1·P1 + Sa·Pa + k·sum(S_i·P_i) = T·plan_total         ← preserves avg
//
// Returns { ok, Sa, k, newUpperShares, finalTotal, finalAvg, reason }.
// Returns ok=false with reason when no positive solution exists (e.g.,
// Pa too high above T to recover even with k=0).
//
// Inputs:
//   position      — the PNTHR position document (reads fills, direction)
//   netLiquidity  — current NAV
//   missedLot     — the lot number missed (2, 3, or 4)
//   currentPrice  — Pa, the price at which catch-up will fill (live market)
//   targetAvg     — T, the locked target avg from L1 fill (REQUIRED — never recompute)
export function computeCatchUpRebalance({ position, netLiquidity, missedLot, currentPrice, targetAvg }) {
  if (!position || !targetAvg || !currentPrice || !missedLot) {
    return { ok: false, reason: 'MISSING_INPUT' };
  }
  if (missedLot < 2 || missedLot > 4) {
    return { ok: false, reason: 'INVALID_LOT_FOR_CATCHUP' };
  }
  const plan = computeLotPlan(position, netLiquidity);
  if (!plan || plan.length < 5) return { ok: false, reason: 'PLAN_INCOMPLETE' };

  const fills = position?.fills || {};
  const l1 = plan[0];
  const S1 = +l1.actualShares || +l1.targetShares || 0;
  const P1 = fills[1]?.filled && fills[1]?.price ? +fills[1].price : +l1.triggerPrice;
  if (S1 <= 0 || P1 <= 0) return { ok: false, reason: 'L1_NOT_FILLED' };

  const Pa = +currentPrice;
  const T  = +targetAvg;

  // Plan total — fixed reference for "preserve total size".
  const planTotal = plan.reduce((s, l) => s + (+l.targetShares || 0), 0);

  // Upper lots = lots ABOVE the missed lot (N+1..5). These are the ones
  // we'll scale by k. The missed lot itself becomes the catch-up (Sa).
  const upperLots = plan.filter(l => l.lot > missedLot && !l.filled);
  const S_upper_total = upperLots.reduce((s, l) => s + (+l.targetShares || 0), 0);
  const C_upper       = upperLots.reduce((s, l) => s + (+l.targetShares || 0) * (+l.triggerPrice || 0), 0);

  // Solve the two-equation system:
  //   Sa + k·S_upper_total = planTotal - S1                    [eq1]
  //   S1·P1 + Sa·Pa + k·C_upper = T·planTotal                  [eq2]
  //
  // From [eq1]: Sa = (planTotal - S1) - k·S_upper_total
  // Substitute into [eq2]:
  //   S1·P1 + Pa·(planTotal - S1) - k·S_upper_total·Pa + k·C_upper = T·planTotal
  //   k·(C_upper - S_upper_total·Pa) = T·planTotal - S1·P1 - Pa·(planTotal - S1)
  const denom = C_upper - S_upper_total * Pa;
  const numer = T * planTotal - S1 * P1 - Pa * (planTotal - S1);
  // Edge case: no upper lots (missed lot was L4, no lots to scale).
  // Then k is irrelevant — Sa = planTotal - S1 directly. Avg may not hit T
  // exactly because we have no degree of freedom left.
  let k, Sa;
  if (Math.abs(denom) < 1e-9) {
    if (Math.abs(numer) > 1e-3) return { ok: false, reason: 'NO_FEASIBLE_K' };
    k  = 1;
    Sa = planTotal - S1;
  } else {
    k  = numer / denom;
    Sa = (planTotal - S1) - k * S_upper_total;
  }
  if (!Number.isFinite(k) || !Number.isFinite(Sa)) return { ok: false, reason: 'MATH_NONFINITE' };
  if (Sa <= 0) return { ok: false, reason: 'CATCHUP_REQUIRES_NEGATIVE_SHARES' };
  if (k < 0)   return { ok: false, reason: 'UPPER_SCALE_NEGATIVE_PRICE_TOO_HIGH' };

  // Round-up Sa per spec ("round up early").
  const SaRounded = Math.ceil(Sa);

  // Apply k to upper lots, round up each, then absorb rounding error in
  // the LAST lot (highest-numbered) by solving for exact T preservation.
  const upperRoundedAsc = upperLots
    .slice()
    .sort((a, b) => a.lot - b.lot); // ascending lot order
  const newUpper = upperRoundedAsc.map(l => ({
    lot: l.lot,
    triggerPrice: +l.triggerPrice,
    shares: Math.ceil((+l.targetShares || 0) * k),
  }));

  // If we have ≥1 upper lot, recompute the LAST (highest-numbered) lot to
  // absorb rounding error. Solve: T = (S1·P1 + Sa·Pa + Σ_locked + L_n·P_n) / (S1 + Sa + Σ_lockedShares + L_n)
  if (newUpper.length >= 1) {
    const last      = newUpper[newUpper.length - 1];
    const lockedAll = newUpper.slice(0, -1);
    const lockedShares = lockedAll.reduce((s, l) => s + l.shares, 0);
    const lockedCost   = lockedAll.reduce((s, l) => s + l.shares * l.triggerPrice, 0);
    const num = T * (S1 + SaRounded + lockedShares) - S1 * P1 - SaRounded * Pa - lockedCost;
    const den = last.triggerPrice - T;
    if (Math.abs(den) > 1e-9) {
      const Ln = num / den;
      // Round to nearest non-negative integer; if it'd go negative, set to 0.
      // Per spec: "round up early, then adjust in later lots if possible. If
      // not, rounding up is fine." So we floor-vs-round-up by which gives
      // a final avg closer to T (or both, if very close).
      const Lnceil  = Math.max(0, Math.ceil(Ln));
      const Lnfloor = Math.max(0, Math.floor(Ln));
      // Compute deviation for each candidate
      const totalCostFor = (lastShares) =>
        S1 * P1 + SaRounded * Pa + lockedCost + lastShares * last.triggerPrice;
      const totalSharesFor = (lastShares) => S1 + SaRounded + lockedShares + lastShares;
      const devFor = (lastShares) => Math.abs(totalCostFor(lastShares) / totalSharesFor(lastShares) - T);
      last.shares = devFor(Lnfloor) <= devFor(Lnceil) ? Lnfloor : Lnceil;
    }
  }

  const finalShares = S1 + SaRounded + newUpper.reduce((s, l) => s + l.shares, 0);
  const finalCost   = S1 * P1 + SaRounded * Pa + newUpper.reduce((s, l) => s + l.shares * l.triggerPrice, 0);
  const finalAvg    = finalShares > 0 ? +(finalCost / finalShares).toFixed(4) : null;

  return {
    ok: true,
    Sa: SaRounded,
    SaRaw: +Sa.toFixed(4),
    k: +k.toFixed(4),
    catchUpPrice: Pa,
    newUpperShares: newUpper, // [{ lot, triggerPrice, shares }, ...]
    finalTotal: finalShares,
    finalAvg,
    targetAvg: T,
    avgDeviation: finalAvg != null ? +(finalAvg - T).toFixed(4) : null,
  };
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

// ── Pair TWS stop orders to plan lots ───────────────────────────────────────
// Two-pass algorithm so both the anchor-drift case (HOOD: 3 off-by-$1.50 orders
// shifted up one lot under closest-distance match) and the duplicate-orders
// case (CSCO: 4 canonical-priced + 4 stale orders) reconcile correctly.
//
// PASS A — tight match. Any IBKR order already within ~0.5%/$0.10 of a plan
//   lot pairs directly with that lot. Greedy by smallest distance so a
//   canonical-priced order wins over a stale-anchor near-match.
// PASS B — order-based pairing. Remaining unmatched IBKR orders pair 1:1
//   with remaining unmatched plan lots in tightness-to-anchor order. Lowest
//   BUY STP for a LONG pyramid pairs with the lowest unmatched lot, etc.
// PASS C — excess as duplicates. Orders left over (more BUY STPs than plan
//   lots) get assigned to their nearest plan lot if within 5% — the per-lot
//   processing in lotTriggerCron then cancels them as DUPLICATE_AT_*. Orders
//   farther than 5% from any lot are returned as trulyUnmatched (left alone
//   — preserves genuine tactical user orders).
//
// Returns { candidatesByLot: Map<lotNum, [order]>, trulyUnmatched: [order] }.
export function pairTwsOrdersToLots(orders, lots, isLong) {
  const planLots = lots
    .filter(l => l.lot !== 1)
    .sort((a, b) => isLong ? a.triggerPrice - b.triggerPrice : b.triggerPrice - a.triggerPrice);
  const sortedOrders = (orders || [])
    .filter(o => o && Number.isFinite(+o.stopPrice))
    .sort((a, b) => isLong ? +a.stopPrice - +b.stopPrice : +b.stopPrice - +a.stopPrice);

  const candidatesByLot = new Map();
  const trulyUnmatched  = [];
  if (planLots.length === 0) return { candidatesByLot, trulyUnmatched: sortedOrders };

  // PASS A — tight match
  const TIGHT_ABS = 0.10;
  const TIGHT_PCT = 0.005;
  const tightCandidates = [];
  for (const order of sortedOrders) {
    for (const lot of planLots) {
      const tol  = Math.max(TIGHT_ABS, lot.triggerPrice * TIGHT_PCT);
      const diff = Math.abs(+order.stopPrice - lot.triggerPrice);
      if (diff <= tol) tightCandidates.push({ order, lot, diff });
    }
  }
  tightCandidates.sort((a, b) => a.diff - b.diff);

  const claimedOrders  = new Set();
  const claimedLotNums = new Set();
  for (const c of tightCandidates) {
    if (claimedOrders.has(c.order) || claimedLotNums.has(c.lot.lot)) continue;
    candidatesByLot.set(c.lot.lot, [c.order]);
    claimedOrders.add(c.order);
    claimedLotNums.add(c.lot.lot);
  }

  // PASS B — order-based pairing for remainders
  const remOrders = sortedOrders.filter(o => !claimedOrders.has(o));
  const remLots   = planLots.filter(l => !claimedLotNums.has(l.lot));
  const pairedCount = Math.min(remOrders.length, remLots.length);
  for (let i = 0; i < pairedCount; i++) {
    candidatesByLot.set(remLots[i].lot, [remOrders[i]]);
  }

  // PASS C — excess orders → duplicates of nearest lot (if within 5%) else
  // truly unmatched. The per-lot duplicate-cancellation logic in lotTriggerCron
  // will pick up the duplicates and cancel them.
  const EXCESS_DEDUP_PCT = 0.05;
  const excessOrders = remOrders.slice(pairedCount);
  for (const order of excessOrders) {
    let nearestLot = null;
    let nearestDiff = Infinity;
    for (const lot of planLots) {
      const d = Math.abs(+order.stopPrice - lot.triggerPrice);
      if (d < nearestDiff) { nearestLot = lot; nearestDiff = d; }
    }
    if (nearestLot && nearestDiff <= nearestLot.triggerPrice * EXCESS_DEDUP_PCT) {
      if (!candidatesByLot.has(nearestLot.lot)) candidatesByLot.set(nearestLot.lot, []);
      candidatesByLot.get(nearestLot.lot).push(order);
    } else {
      trulyUnmatched.push(order);
    }
  }

  return { candidatesByLot, trulyUnmatched };
}
