// server/assistantLiveReconcile.js
// GET /api/assistant/live-reconcile
// The "PNTHR Assistant LIVE" source-of-truth table.
// Compares IBKR (positions + working stops) against Command Center (portfolio + planned stops)
// and returns one row per ticker (union of all three sources) with color-coded checks.

import { connectToDatabase, getUserProfile } from './database.js';

// ── Tolerance thresholds ──────────────────────────────────────────────────────
// Centralized so tuning doesn't require chasing through the file.
const TOL = {
  AVG_EXACT:         0.01,   // < $0.01 = green (rounding)
  AVG_YELLOW_PCT:    0.0025, // < 0.25%  = yellow
  STOP_EXACT:        0.01,   // < $0.01 = green match
  RATCHET_STAGED:    0.05,   // IBKR stop within $0.05 of target = "staged"
  RATCHET_YELLOW:    0.01,   // within 1% of lot trigger = yellow
  RATCHET_RED:       0.005,  // within 0.5% or past = red
};

// ── Utility: worst-severity wins for the row rollup ──────────────────────────
function worst(...statuses) {
  if (statuses.includes('red'))    return 'red';
  if (statuses.includes('yellow')) return 'yellow';
  if (statuses.includes('green'))  return 'green';
  return 'gray';
}

// ── Filled-lot math ──────────────────────────────────────────────────────────
function summarizeFills(fills = {}) {
  const filledLots = [1, 2, 3, 4, 5]
    .map(n => ({ n, f: fills[n] }))
    .filter(x => x.f?.filled);
  const totShr  = filledLots.reduce((s, x) => s + (+x.f.shares || 0), 0);
  const totCost = filledLots.reduce((s, x) => s + (+x.f.shares || 0) * (+x.f.price || 0), 0);
  const avgCost = totShr > 0 ? +(totCost / totShr).toFixed(4) : null;
  return { filledCount: filledLots.length, totShr, avgCost, filledLots };
}

// Lot-trigger prices for lots 2-5 (BUY STP for long, SELL STP for short).
// Mirrors client/src/utils/sizingUtils.js → buildLots so server and client
// agree on the exact trigger prices.
const LOT_OFFSETS = [0, 0.03, 0.06, 0.10, 0.14];
const STRIKE_PCT  = [0.35, 0.25, 0.20, 0.12, 0.08];

// Mirrors the lot-sizing math in client/src/components/CommandCenter.jsx
// (approx lines 700-735). If these two diverge, Command will show one number
// and the LIVE table will show another for the same position — which is what
// happened with AVGO (user saw 2 in Command, 3 here).
//
// Steps:
//   1. sizePosition() → base totalShares from vitality + ticker-cap caps
//   2. Compare lot 1's ACTUAL fill to STRIKE_PCT[0] × totalShares. If it
//      differs, scale effectiveTotal off actual fill but re-apply caps, then
//      redistribute the remaining shares to lots 2-5 using weights 30/25/20/10
//      (sum 85). These are NOT the same as STRIKE_PCT[1..4] — they are the
//      historical rebalance weights that Command uses after a lot-1 over/
//      under-fill.
//   3. Final display value per lot = adjShares[i] if the adjustment kicked in,
//      otherwise Math.round(effectiveTotal × STRIKE_PCT[i]).
function computeLotTargetShares(position, netLiquidity) {
  const fills = position.fills || {};
  const entry = +position.entryPrice || 0;
  const sizingStop = +(position.originalStop || position.stopPrice) || 0;
  const isETF = !!position.isETF;
  if (!entry || !sizingStop || !netLiquidity) return [0, 0, 0, 0, 0];

  const tickerCap  = netLiquidity * 0.10;
  const vitality   = netLiquidity * (isETF ? 0.005 : 0.01);
  const maxGapPct  = +position.maxGapPct || 0;
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
  let adjShares = null;
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

function computeLotTriggers(position, netLiquidity) {
  const dir = position.direction;
  const isLong = dir === 'LONG';
  if (!dir || !['LONG', 'SHORT'].includes(dir)) return [];
  const fills = position.fills || {};
  const anchor = fills[1]?.filled && fills[1]?.price
    ? +fills[1].price
    : +position.entryPrice || null;
  if (!anchor) return [];
  const targetShares = computeLotTargetShares(position, netLiquidity);
  // Cumulative target through L_N — used to determine whether the position
  // already covers a given lot (over-fill or single-shot at canonical full
  // size both yield "complete" lots that need no further action).
  let cumulative = 0;
  return [2, 3, 4, 5].map(n => {
    const i = n - 1;
    cumulative = (targetShares[0] || 0); // start with L1 cumulative
    for (let k = 1; k <= i; k++) cumulative += (targetShares[k] || 0);
    const triggerPrice = isLong
      ? +(anchor * (1 + LOT_OFFSETS[i])).toFixed(2)
      : +(anchor * (1 - LOT_OFFSETS[i])).toFixed(2);
    return {
      lot: n,
      triggerPrice,
      targetShares: targetShares[i] || 0,
      cumulativeTargetShares: cumulative,
      filled: fills[n]?.filled || false,
      expectedSide: isLong ? 'BUY' : 'SELL', // lot-entry orders are the same side as the position
    };
  });
}

// A protective stop is opposite-side from the position direction. BUY STPs
// on a LONG are lot-entry orders (staged at ratchet prices), NOT protective —
// they should never be counted toward stop coverage or trigger 'multi-stop'
// warnings.
function protectiveSideFor(direction) {
  if (direction === 'LONG')  return 'SELL';
  if (direction === 'SHORT') return 'BUY';
  return null;
}
function filterProtectiveStops(ibkrStops, direction) {
  const side = protectiveSideFor(direction);
  if (!side) return ibkrStops; // unknown direction — be conservative, include all
  return ibkrStops.filter(s => s.action === side);
}

// For each unfilled lot trigger, check if there's a matching pending order in
// IBKR (same side + same price within tolerance). Returns an array enriched
// with `staged: bool`, `stagedShares: number`, and `complete: bool` so the
// client can render the right dot color:
//   • complete (cumulative target ≤ position shares) → no action needed; gray
//   • staged AND stagedShares == targetShares        → order in TWS; green
//   • staged BUT stagedShares != targetShares        → price right, share count
//     wrong; yellow (e.g., GOOGL plan 3 sh @ $399.73, TWS has 2 sh @ same price)
//   • not staged                                     → should be staged but isn't; red
//
// Shares are summed across all matching orders so multi-order TWS state still
// reconciles cleanly (1 sh + 2 sh @ same price = 3 sh staged, matches plan).
function enrichLotTriggersWithIbkrStatus(triggers, ibkrStops, ibkrShares = 0) {
  const heldShares = Math.abs(+ibkrShares || 0);
  return triggers.map(t => {
    const complete = heldShares >= (t.cumulativeTargetShares || 0);
    if (t.filled) return { ...t, staged: null, stagedShares: 0, complete }; // already happened — no dot
    const matches = ibkrStops.filter(s =>
      s.action === t.expectedSide &&
      Math.abs(+s.stopPrice - t.triggerPrice) < 0.05
    );
    const stagedShares = matches.reduce((sum, m) => sum + Math.abs(+m.shares || 0), 0);
    return { ...t, staged: matches.length > 0, stagedShares, complete };
  });
}

// ── Daily RSI(14) for the stock badge on the Live table card ─────────────────
// Computed from FMP historical daily closes (60-day window = ~42 trading days,
// enough for Wilder's RSI-14 to settle). Cached 1 hour because RSI values
// don't move meaningfully minute-to-minute and the live table polls every 60s.
const RSI_CACHE = new Map(); // ticker -> { value, expiresAt }
const RSI_TTL_MS = 60 * 60 * 1000;
const RSI_API_KEY = process.env.FMP_API_KEY;

function computeDailyRSI14(closes) {
  const n = closes.length;
  if (n < 15) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= 14; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
  }
  avgGain /= 14; avgLoss /= 14;
  let rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = 15; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * 13 + Math.max(d, 0)) / 14;
    avgLoss = (avgLoss * 13 + Math.max(-d, 0)) / 14;
    rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

async function fetchDailyRSI(ticker) {
  const cached = RSI_CACHE.get(ticker);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (!RSI_API_KEY) return null;
  try {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 60);
    const fmt = d => d.toISOString().split('T')[0];
    const url = `https://financialmodelingprep.com/api/v3/historical-price-full/${ticker}?from=${fmt(from)}&to=${fmt(to)}&apikey=${RSI_API_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const daily = (data?.historical || []).slice().sort((a, b) => a.date > b.date ? 1 : -1);
    if (daily.length < 16) return null;
    const rsi = computeDailyRSI14(daily.map(b => b.close));
    if (rsi == null) return null;
    const rounded = Math.round(rsi);
    RSI_CACHE.set(ticker, { value: rounded, expiresAt: Date.now() + RSI_TTL_MS });
    return rounded;
  } catch {
    return null;
  }
}

// Market RSI comparator: NASDAQ-listed → QQQ; everything else → SPY.
// Mirrors the NASDAQ check in disciplineScoring.scoreIndexTrend.
function marketTickerFor(exchange) {
  return (exchange || '').toUpperCase() === 'NASDAQ' ? 'QQQ' : 'SPY';
}

// ── FMP live price fetch (mirrors headlines endpoint pattern) ────────────────
async function fetchLivePrices(tickers) {
  const out = {};
  if (!tickers.length || !process.env.FMP_API_KEY) return out;
  try {
    // /stable/quote silently returns [] for multi-symbol; /api/v3/quote/{symbols} works
    const url = `https://financialmodelingprep.com/api/v3/quote/${tickers.join(',')}?apikey=${process.env.FMP_API_KEY}`;
    const r   = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return out;
    const d = await r.json();
    if (Array.isArray(d)) for (const q of d) out[q.symbol?.toUpperCase()] = q.price;
  } catch { /* non-fatal */ }
  return out;
}

// ── Per-column classifiers ───────────────────────────────────────────────────
function classifyDirection(ibkrDir, cmdDir) {
  if (!ibkrDir && !cmdDir) return { status: 'gray' };
  if (!ibkrDir) return { status: 'red', reason: 'Command has position, IBKR does not' };
  if (!cmdDir)  return { status: 'red', reason: 'IBKR has position, Command does not' };
  if (ibkrDir === cmdDir) return { status: 'green' };
  return { status: 'red', reason: `IBKR ${ibkrDir} vs Cmd ${cmdDir}` };
}

function classifyShares(ibkrShr, cmdShr) {
  if (ibkrShr == null && cmdShr == null) return { status: 'gray' };
  if (ibkrShr == null) return { status: 'red', reason: 'Command position has no IBKR match' };
  if (cmdShr == null)  return { status: 'red', reason: 'IBKR position has no Command match' };
  if (ibkrShr === cmdShr) return { status: 'green' };
  return { status: 'red', reason: `IBKR ${ibkrShr} vs Cmd ${cmdShr}` };
}

function classifyAvg(ibkrAvg, cmdAvg) {
  if (ibkrAvg == null && cmdAvg == null) return { status: 'gray' };
  if (ibkrAvg == null || cmdAvg == null) return { status: 'yellow', reason: 'only one side' };
  const diff = Math.abs(ibkrAvg - cmdAvg);
  if (diff < TOL.AVG_EXACT) return { status: 'green' };
  if (diff < cmdAvg * TOL.AVG_YELLOW_PCT) return { status: 'yellow', reason: `${(diff/cmdAvg*100).toFixed(2)}% drift` };
  return { status: 'red', reason: `$${diff.toFixed(2)} drift` };
}

function classifyStopSide(expectedSide, stops) {
  if (!stops.length) return { status: 'gray' };
  const sides = new Set(stops.map(s => s.action));
  if (!expectedSide) return { status: 'yellow', reason: 'no Command direction to compare' };
  if (sides.size === 1 && sides.has(expectedSide)) return { status: 'green' };
  return { status: 'red', reason: `Expected ${expectedSide}, IBKR has ${[...sides].join('+')}` };
}

function classifyStopPrice(ibkrStops, cmdStop) {
  const hasIbkr = ibkrStops.length > 0;
  if (!hasIbkr && cmdStop == null) return { status: 'gray' };
  if (!hasIbkr && cmdStop != null)  return { status: 'red', reason: 'NAKED — no IBKR stop' };
  if (hasIbkr && cmdStop == null)   return { status: 'red', reason: 'Orphan stop — no Command position' };
  // Compare the "active" IBKR stop (tightest = highest for long stops, lowest for short)
  // Note: without direction ambiguity we compare against ANY match — if plan stop matches any IBKR stop, green.
  const match = ibkrStops.find(s => Math.abs(+s.stopPrice - cmdStop) < TOL.STOP_EXACT);
  if (match) return { status: 'green' };
  const closest = ibkrStops.reduce((a, b) =>
    Math.abs(+a.stopPrice - cmdStop) < Math.abs(+b.stopPrice - cmdStop) ? a : b
  );
  const diff = Math.abs(+closest.stopPrice - cmdStop);
  return { status: 'red', reason: `IBKR $${(+closest.stopPrice).toFixed(2)} vs Cmd $${cmdStop.toFixed(2)} ($${diff.toFixed(2)} diff)` };
}

function classifyStopShares(ibkrStops, cmdShr) {
  if (!ibkrStops.length && cmdShr == null) return { status: 'gray' };
  if (!ibkrStops.length) return { status: 'red', reason: 'NAKED — position unprotected' };
  // If any stop is missing a shares value, the bridge is the old version and
  // the coverage math would be wrong. Surface as a yellow "restart bridge"
  // signal rather than a misleading red under-stopped flag.
  const anyUnknown = ibkrStops.some(o => o.shares == null);
  if (anyUnknown) {
    return { status: 'yellow', reason: 'Bridge has not reported stop share count (restart pnthr-ibkr-bridge)' };
  }
  const covered = ibkrStops.reduce((s, o) => s + (+o.shares || 0), 0);
  if (cmdShr == null) {
    return { status: 'red', reason: `${covered} sh stop with no Command position` };
  }
  if (covered === cmdShr) return { status: 'green' };
  if (covered < cmdShr)   return { status: 'red', reason: `Under-stopped: ${covered}/${cmdShr} covered` };
  return { status: 'red', reason: `Over-stopped: ${covered} sh stopping ${cmdShr} sh position` };
}

// Classify the overall ratchet-column status. The roll-up drives the row's
// far-left card dot via buildRow's rowStatus computation.
//
// Standard raised 2026-05-05: green now requires the FULL pyramid (every
// actionable lot through L5) to be staged in IBKR with correct share counts,
// not just the next-up lot. Old behavior would show green as soon as L2 was
// staged even if L3-L5 were missing — that hid real drift.
//
// Gray   = all lots COMPLETE (cumulative target ≤ position shares). The
//          position already covers every planned lot. This includes over-
//          filled positions like QTUM (52 sh on a 19-sh canonical plan).
//          No action needed.
// Green  = every actionable lot (incomplete + unfilled + shares > 0) is
//          staged in IBKR with the correct share count.
// Yellow = every actionable lot is staged at the right price/side, but
//          ≥1 has the wrong share count.
// Red    = ≥1 actionable lot is not staged in IBKR.
function classifyLotTriggers(enrichedTriggers) {
  // If every lot is "complete" (position covers cumulative target), the
  // pyramid is done. No further action.
  if (enrichedTriggers.length > 0 && enrichedTriggers.every(t => t.complete)) {
    return { status: 'gray', reason: 'All lots covered — position is at or above full plan size' };
  }

  // Actionable = unfilled, not yet covered by position, and plan calls for >0 sh.
  const actionable = enrichedTriggers.filter(t =>
    !t.filled && !t.complete && t.targetShares && t.targetShares > 0
  );
  if (actionable.length === 0) {
    return { status: 'gray', reason: 'No more lots to stage — position at plan size or cap' };
  }

  // Any actionable lot missing in TWS → red.
  const unstaged = actionable.filter(t => !t.staged);
  if (unstaged.length > 0) {
    const lots = unstaged.map(t => `L${t.lot}`).join(', ');
    return { status: 'red', reason: `Lot(s) not staged in IBKR: ${lots}` };
  }

  // All staged at right price/side, but any with share mismatch → yellow.
  const mismatched = actionable.filter(t => (t.stagedShares || 0) !== t.targetShares);
  if (mismatched.length > 0) {
    const detail = mismatched.map(t =>
      `L${t.lot} (plan ${t.targetShares} sh, TWS ${t.stagedShares || 0} sh)`
    ).join('; ');
    return { status: 'yellow', reason: `Share count mismatch on ${mismatched.length} lot(s): ${detail}` };
  }

  // Every actionable lot staged with correct shares.
  const lots = actionable.map(t => `L${t.lot}`).join(', ');
  return { status: 'green', reason: `All actionable lots staged with correct shares (${lots})` };
}

// ── Row builder ──────────────────────────────────────────────────────────────
function buildRow(ticker, cmd, ibkrPos, ibkrTickerStops, lastPrice, netLiquidity) {
  const cmdHas  = !!cmd;
  const ibkrHas = !!ibkrPos;

  // Direction
  const cmdDir  = cmd?.direction || null;
  const ibkrDir = ibkrPos ? (ibkrPos.shares > 0 ? 'LONG' : ibkrPos.shares < 0 ? 'SHORT' : null) : null;

  // Shares
  const ibkrShares = ibkrPos ? Math.abs(ibkrPos.shares) : null;
  const { totShr: cmdShares, avgCost: cmdAvg } = cmd ? summarizeFills(cmd.fills) : { totShr: null, avgCost: null };
  const cmdSharesOrNull = cmdHas ? cmdShares : null;

  // Avg
  const ibkrAvg = ibkrPos?.avgCost ?? null;

  // Stop side expected
  const expectedStopSide = cmdDir === 'LONG' ? 'SELL' : cmdDir === 'SHORT' ? 'BUY' : null;

  // Lot triggers (BUY STP for long / SELL STP for short) for unfilled lots 2-5.
  // Each enriched with staged:true/false based on whether a matching pending order
  // exists in IBKR. The client stacks these in the NEXT RATCHET column with dots.
  const rawLotTriggers     = cmd ? computeLotTriggers(cmd, netLiquidity) : [];
  const enrichedLotTriggers = enrichLotTriggersWithIbkrStatus(rawLotTriggers, ibkrTickerStops, ibkrShares);

  // For the protective-stop checks (side / price / shares / multi-stop flag),
  // look only at PROTECTIVE stops. A BUY STP on a long is a lot-entry order
  // staged at a ratchet price, not a protective stop — it shouldn't inflate
  // coverage math or trigger a 'multi-stop' warning. It gets its green/red
  // treatment in the ratchet column instead.
  const protectiveStops = filterProtectiveStops(ibkrTickerStops, cmdDir || ibkrDir);

  // Classify each column
  const checks = {
    direction:     classifyDirection(ibkrDir, cmdDir),
    shares:        classifyShares(ibkrShares, cmdSharesOrNull),
    avg:           classifyAvg(ibkrAvg, cmdAvg),
    stopSide:      classifyStopSide(expectedStopSide, protectiveStops),
    stopPrice:     classifyStopPrice(protectiveStops, cmd?.stopPrice ?? null),
    stopShares:    classifyStopShares(protectiveStops, cmdSharesOrNull),
    ratchet:       cmd ? classifyLotTriggers(enrichedLotTriggers) : { status: 'gray' },
  };

  // Multi-stop flag counts only protective stops — multiple BUY STPs on a
  // long are expected (lot triggers), not a multi-stop mistake.
  const multiStop = protectiveStops.length > 1;

  // Row status = worst of all checks
  const rowStatus = worst(...Object.values(checks).map(c => c.status));

  // Action list: what the user can click to fix
  const actions = [];
  // For any unstaged lot trigger with shares remaining, give the user the
  // exact TWS instruction. Lots with 0 target shares are skipped — the
  // position is already at its size cap and there's nothing more to stage.
  for (const t of enrichedLotTriggers) {
    if (t.filled || t.staged) continue;
    if (!t.targetShares || t.targetShares <= 0) continue;
    actions.push({
      type: 'ibkr',
      label: `Stage Lot ${t.lot} trigger in IBKR`,
      instruction: `Open TWS. Add ${t.expectedSide} STP ${t.targetShares} sh @ $${t.triggerPrice.toFixed(2)} GTC (Lot ${t.lot} entry).`,
    });
  }
  if (checks.stopPrice.status === 'red' && checks.stopPrice.reason?.includes('NAKED')) {
    actions.push({
      type: 'ibkr',
      label: 'NAKED — add protective stop in IBKR',
      instruction: `Open TWS. Add ${expectedStopSide} STP ${cmdSharesOrNull || '?'} sh @ $${(cmd?.stopPrice || 0).toFixed(2)} GTC.`,
    });
  }
  if (checks.stopPrice.status === 'red' && checks.stopPrice.reason?.includes('Orphan')) {
    const orphan = ibkrTickerStops[0];
    actions.push({
      type: 'ibkr',
      label: 'Cancel orphan stop in IBKR',
      instruction: `Open TWS. Cancel ${orphan?.action || ''} ${orphan?.orderType || 'STP'} order #${orphan?.orderId} (${ticker} @ $${(+orphan?.stopPrice || 0).toFixed(2)}).`,
    });
  }
  if (cmdHas && (checks.shares.status === 'red' || checks.avg.status === 'red' || checks.direction.status === 'red')) {
    actions.push({
      type: 'app',
      label: 'Open in Assistant',
      expandTicker: ticker,
      positionId: cmd.id,
    });
  }
  if (!cmdHas && ibkrHas) {
    actions.push({
      type: 'app',
      label: 'Add to Assistant',
      addTicker: ticker,
    });
  }

  // Pyramid complete = every planned lot is covered by the actual position
  // (no actionable shares left to stage). When true, the position is in
  // "maintenance mode" — only stop ratchets remain. Client renders these
  // cards with a light green background to visually flag them as done-growing.
  const pyramidComplete = enrichedLotTriggers.length > 0
    && enrichedLotTriggers.every(t => t.complete);

  return {
    ticker,
    rowStatus,
    pyramidComplete,
    ibkr: {
      hasPosition: ibkrHas,
      direction:   ibkrDir,
      shares:      ibkrShares,
      avgCost:     ibkrAvg,
      marketPrice: ibkrPos?.marketPrice ?? null,
      stops:       ibkrTickerStops.map(s => ({
        orderId:   s.orderId,
        side:      s.action,
        type:      s.orderType,
        price:     +s.stopPrice,
        // shares: null means bridge predates the totalQuantity patch (treat as unknown, not 0)
        shares:    s.shares == null ? null : +s.shares,
      })),
    },
    command: {
      hasPosition:    cmdHas,
      positionId:     cmd?.id || null,
      direction:      cmdDir,
      shares:         cmdSharesOrNull,
      avgCost:        cmdAvg,
      stopPrice:      cmd?.stopPrice ?? null,
      // How many lots are filled — the client uses this to decide whether the
      // CMD avg cost is inline-editable (only editable for single-lot positions
      // where avg == lot 1 fill price unambiguously).
      filledLotCount: cmd ? summarizeFills(cmd.fills).filledCount : 0,
    },
    lastPrice,
    lotTriggers:  enrichedLotTriggers, // [{lot, triggerPrice, filled, expectedSide, staged}, ...]
    multiStop,
    checks,
    actions,
  };
}

// ── Main handler ─────────────────────────────────────────────────────────────
export async function assistantLiveReconcile(req, res) {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });

    // Command positions — must include PARTIAL so partially-closed positions
    // still render. Otherwise the duplicate guard in POST /api/positions
    // (which spans ACTIVE+PARTIAL) blocks re-adds while the row shows "CMD —".
    const cmdPositions = await db.collection('pnthr_portfolio')
      .find({ ownerId: userId, status: { $in: ['ACTIVE', 'PARTIAL'] } })
      .toArray();

    // NAV is needed so the lot-sizing math matches Command Center exactly.
    // Command uses sizePosition(NAV, ...) to derive totalShares then splits
    // across lots — the LIVE table must compute the same values or the user
    // sees mismatches (AVGO: Command showed 2 sh at lot 2, LIVE table showed 3).
    let netLiquidity = 0;
    try {
      const profile = await getUserProfile(userId);
      netLiquidity = +profile?.accountSize || 100000; // match default in database.js
    } catch { netLiquidity = 100000; }

    // IBKR snapshot (single doc per user)
    const ibkrDoc = await db.collection('pnthr_ibkr_positions').findOne({ ownerId: userId });
    const ibkrPositions = ibkrDoc?.positions  || [];
    const ibkrStops     = Array.isArray(ibkrDoc?.stopOrders) ? ibkrDoc.stopOrders : [];
    const ibkrSyncedAt  = ibkrDoc?.syncedAt   || null;

    // Union of all tickers across three sources (uppercase, deduped, exclude cash)
    const tickerSet = new Set();
    for (const p of cmdPositions)   if (p.ticker)           tickerSet.add(p.ticker.toUpperCase());
    for (const p of ibkrPositions)  if (p.symbol && p.symbol !== 'USD') tickerSet.add(p.symbol.toUpperCase());
    for (const s of ibkrStops)      if (s.symbol)           tickerSet.add(s.symbol.toUpperCase());

    const tickers = Array.from(tickerSet);

    // Live prices
    const prices = await fetchLivePrices(tickers);

    // Build rows
    const rows = tickers.map(ticker => {
      const cmd     = cmdPositions.find(p => p.ticker?.toUpperCase() === ticker) || null;
      const ibkrPos = ibkrPositions.find(p => p.symbol?.toUpperCase() === ticker) || null;
      const stops   = ibkrStops.filter(s => s.symbol?.toUpperCase() === ticker);
      const last    = prices[ticker] ?? ibkrPos?.marketPrice ?? cmd?.currentPrice ?? null;
      return buildRow(ticker, cmd, ibkrPos, stops, last, netLiquidity);
    });

    // Enrich rows with daily RSI(14) for the stock + the relevant market
    // index (QQQ for NASDAQ-listed, SPY otherwise). Cached for 1 hour so the
    // 60-second poll doesn't hammer FMP. Renders as a small "76 / 58" badge
    // in the bottom-left of each ticker card.
    const allRsiTickers = [...new Set([...tickers, 'SPY', 'QQQ'])];
    const rsiResults = await Promise.all(allRsiTickers.map(t =>
      fetchDailyRSI(t).then(v => [t, v]).catch(() => [t, null])
    ));
    const rsiMap = Object.fromEntries(rsiResults);
    for (const r of rows) {
      const cmd = cmdPositions.find(p => p.ticker?.toUpperCase() === r.ticker);
      const marketTicker = marketTickerFor(cmd?.exchange);
      r.rsi = {
        stock:        rsiMap[r.ticker] ?? null,
        market:       rsiMap[marketTicker] ?? null,
        marketTicker,
      };
    }

    // Sort: red first, then yellow, then green; within each by ticker
    const order = { red: 0, yellow: 1, green: 2, gray: 3 };
    rows.sort((a, b) => (order[a.rowStatus] - order[b.rowStatus]) || a.ticker.localeCompare(b.ticker));

    const summary = { green: 0, yellow: 0, red: 0, gray: 0, total: rows.length };
    for (const r of rows) summary[r.rowStatus]++;

    res.json({
      lastSyncedAt: ibkrSyncedAt,
      generatedAt:  new Date().toISOString(),
      summary,
      rows,
    });
  } catch (err) {
    console.error('[assistant/live-reconcile]', err);
    res.status(500).json({ error: err.message });
  }
}
