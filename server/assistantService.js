// server/assistantService.js
// ── PNTHR Assistant — Daily Task Co-Pilot ─────────────────────────────────────
//
// Scans portfolio state and returns a sorted, prioritized array of task objects
// that tell the user exactly what to do today, in order of urgency.
//
// Exports:
//   generateAssistantTasks(userId, positions, nav)  → task[]
//   getStopSyncRows(positions)                       → stopSyncRow[]
//   getRoutineTasks(dayOfWeek)                       → routineTask[]
//   markTaskComplete(userId, taskId, taskType, ticker, dayOfWeek) → void
//   getTodayCompleted(userId)                        → completedRecord[]
//   seedRoutines()                                   → void (call once on startup)
//
// ─────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';

const FMP_API_KEY = process.env.FMP_API_KEY;

// ── Constants ─────────────────────────────────────────────────────────────────

const STRIKE_PCT  = [0.15, 0.30, 0.25, 0.20, 0.10];
const LOT_OFFSETS = [0, 0.03, 0.06, 0.10, 0.14];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Count Mon-Fri trading days from a given date to today.
 * Does not account for public holidays — intentionally simple.
 */
export function tradingDaysSince(date) {
  if (!date) return 0;
  let count = 0;
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  while (d < now) {
    d.setDate(d.getDate() + 1);
    const dw = d.getDay();
    if (dw !== 0 && dw !== 6) count++;
  }
  return count;
}

/**
 * Return today's date string in YYYY-MM-DD format (local time).
 */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Format a number as a dollar string: $1,234.56
 */
function fmt$(n) {
  if (n == null) return 'N/A';
  return `$${Number(n).toFixed(2)}`;
}

/**
 * Compute lot trigger price for lot N (1-indexed).
 * anchor = fills[1].price || entryPrice
 */
function lotTrigger(anchor, lotIndex, isLong) {
  const offset = LOT_OFFSETS[lotIndex];
  return isLong
    ? +(anchor * (1 + offset)).toFixed(2)
    : +(anchor * (1 - offset)).toFixed(2);
}

/**
 * Compute target shares for a lot.
 */
function lotTargetShares(totalShares, lotIndex) {
  return Math.max(1, Math.round(totalShares * STRIKE_PCT[lotIndex]));
}

/**
 * Determine which lot is "next" (the lowest unfilled lot >= 2).
 * Returns { lotNum (1-indexed), lotIndex (0-indexed) } or null if all filled.
 */
function nextUnfilledLot(fills) {
  for (let i = 1; i <= 4; i++) {
    if (!fills[i + 1] || !fills[i + 1].filled) {
      return { lotNum: i + 1, lotIndex: i };
    }
  }
  return null;
}

/**
 * Find the highest filled lot number (1-indexed), or 0 if none.
 */
function highestFilledLot(fills) {
  let highest = 0;
  for (let n = 1; n <= 5; n++) {
    if (fills[n]?.filled) highest = n;
  }
  return highest;
}

/**
 * Compute the ratchet stop that should be in place given which lots are filled.
 * Returns { ratchetLevel, lotRule } or null if no ratchet is required yet.
 *
 * Rules:
 *   Lot 3 filled → stop = Lot 1 fill (breakeven)
 *   Lot 4 filled → stop = Lot 2 fill
 *   Lot 5 filled → stop = Lot 3 fill
 */
function computeRequiredRatchet(fills) {
  const hf = highestFilledLot(fills);
  if (hf < 3) return null;

  if (hf >= 5) {
    const p = fills[3]?.price;
    if (!p) return null;
    return { ratchetLevel: +p, lotRule: 5 };
  }
  if (hf >= 4) {
    const p = fills[2]?.price;
    if (!p) return null;
    return { ratchetLevel: +p, lotRule: 4 };
  }
  // hf === 3
  const p = fills[1]?.price;
  if (!p) return null;
  return { ratchetLevel: +p, lotRule: 3 };
}

// ── Earnings Cache ────────────────────────────────────────────────────────────
// Cache FMP earning calendar for 24 hours to avoid rate limit hammering.

let earningsCache = null;
let earningsCacheTime = 0;
const EARNINGS_CACHE_MS = 24 * 60 * 60 * 1000;

async function fetchEarningsMap(tickers) {
  const now = Date.now();
  if (earningsCache && (now - earningsCacheTime) < EARNINGS_CACHE_MS) {
    return earningsCache;
  }

  const today = new Date();
  const sevenDays = new Date(today);
  sevenDays.setDate(today.getDate() + 7);

  const from = today.toISOString().split('T')[0];
  const to   = sevenDays.toISOString().split('T')[0];

  try {
    const url = `https://financialmodelingprep.com/api/v3/earning_calendar?from=${from}&to=${to}&apikey=${FMP_API_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`FMP ${res.status}`);
    const data = await res.json();

    const map = {};
    if (Array.isArray(data)) {
      const tickerSet = new Set(tickers.map(t => t.toUpperCase()));
      for (const e of data) {
        const t = (e.symbol || '').toUpperCase();
        if (tickerSet.has(t)) {
          map[t] = e.date; // YYYY-MM-DD
        }
      }
    }

    earningsCache = map;
    earningsCacheTime = now;
    return map;
  } catch (err) {
    console.warn('[Assistant] Earnings fetch failed:', err.message);
    return earningsCache || {};
  }
}

/**
 * Days until an earnings date string (YYYY-MM-DD). Returns null if not found.
 * 0 = today, 1 = tomorrow, etc.
 */
function daysUntilEarnings(dateStr) {
  if (!dateStr) return null;
  const earn = new Date(dateStr + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((earn - today) / (1000 * 60 * 60 * 24));
  return diff;
}

// ── IBKR Data ─────────────────────────────────────────────────────────────────

/**
 * Load IBKR positions from MongoDB for the given tickers.
 * Returns a map: { TICKER: { ibkrShares, ibkrStop, ibkrAvgCost } }
 */
async function loadIbkrPositions(tickers) {
  if (!tickers.length) return {};
  try {
    const db = await connectToDatabase();
    const docs = await db.collection('pnthr_ibkr_positions')
      .find({ ticker: { $in: tickers.map(t => t.toUpperCase()) } })
      .toArray();
    const map = {};
    for (const d of docs) {
      map[d.ticker.toUpperCase()] = {
        ibkrShares:   d.shares ?? d.ibkrShares ?? null,
        ibkrStop:     d.stopPrice ?? d.ibkrStop ?? null,
        ibkrAvgCost:  d.avgCost ?? d.ibkrAvgCost ?? null,
      };
    }
    return map;
  } catch (err) {
    console.warn('[Assistant] IBKR load failed:', err.message);
    return {};
  }
}

// ── Signal Cache for Stop Sync ────────────────────────────────────────────────

/**
 * Get the current signal-cache stop price for a ticker.
 * This is the authoritative PNTHR stop from signalService.
 */
async function loadSignalStops(tickers) {
  if (!tickers.length) return {};
  try {
    const db = await connectToDatabase();
    const docs = await db.collection('pnthr_signals')
      .find({ ticker: { $in: tickers.map(t => t.toUpperCase()) } })
      .toArray();
    const map = {};
    for (const d of docs) {
      map[d.ticker.toUpperCase()] = d.stopPrice ?? null;
    }
    return map;
  } catch (err) {
    console.warn('[Assistant] Signal stop load failed:', err.message);
    return {};
  }
}

// ── Task Generators ───────────────────────────────────────────────────────────

/**
 * Generate all task objects from a list of active positions.
 *
 * @param {string}   userId
 * @param {object[]} positions  — enriched positions from positionsGetAll
 * @param {number}   nav        — Net Liquidity value
 * @returns {object[]} sorted task array
 */
export async function generateAssistantTasks(userId, positions, nav) {
  const tasks = [];
  const activePosns = positions.filter(p => p.status === 'ACTIVE');
  const tickers = activePosns.map(p => p.ticker);

  // Load supporting data in parallel
  const [earningsMap, ibkrMap] = await Promise.all([
    fetchEarningsMap(tickers),
    loadIbkrPositions(tickers),
  ]);

  for (const pos of activePosns) {
    const ticker    = pos.ticker.toUpperCase();
    const isLong    = pos.direction === 'LONG';
    const direction = isLong ? 'LONG' : 'SHORT';
    const fills     = pos.fills || {};
    const cp        = pos.currentPrice;
    const stopPrice = pos.stopPrice;
    const ibkr      = ibkrMap[ticker] || {};

    // Anchor price for lot triggers = Lot 1 fill price or entry price
    const anchor = fills[1]?.filled && fills[1]?.price
      ? +fills[1].price
      : (pos.entryPrice || 0);

    // Compute total shares for lot size estimates
    const vitality     = nav * (pos.isETF ? 0.005 : 0.01);
    const stopDist     = Math.abs((anchor - stopPrice) || 1);
    const totalShares  = Math.floor(
      Math.min(
        stopDist > 0 ? Math.floor(vitality / stopDist) : 0,
        Math.floor(nav * 0.10 / (anchor || 1))
      )
    );

    const days = tradingDaysSince(pos.createdAt);

    // ── P1: STOP_CROSSED ──────────────────────────────────────────────────────
    if (cp != null && stopPrice != null) {
      const crossed = isLong ? cp < stopPrice : cp > stopPrice;
      if (crossed) {
        tasks.push({
          id:              `stop_crossed_${ticker}`,
          priority:        1,
          type:            'STOP_CROSSED',
          ticker,
          badge:           'STOP CROSSED',
          headline:        `${ticker} ${direction}: Price ${fmt$(cp)} crossed stop ${fmt$(stopPrice)}. Check IBKR.`,
          instructions:    [
            '1. Open IBKR → Activity → Executions tab',
            `2. Find ${ticker} — note the exact fill price and time it executed`,
            `3. Return to PNTHR Command → find ${ticker} card`,
            '4. Click CLOSE → enter Exit Price, Date, and select reason: STOP_HIT',
            '5. Confirm the position shows as CLOSED in Command',
          ],
          confirmQuestion: `Did you find the fill in IBKR and record the exit in Command?`,
          data:            { currentPrice: cp, stopPrice, direction },
          dayOfWeek:       null,
          autoClears:      true,
        });
        continue; // don't generate other tasks for a stopped-out position
      }
    }

    // ── P1: LOT_READY ─────────────────────────────────────────────────────────
    const hf = highestFilledLot(fills);
    for (let lotIdx = 1; lotIdx <= 4; lotIdx++) {
      const lotNum = lotIdx + 1; // lots 2-5
      if (fills[lotNum]?.filled) continue;        // already filled
      if (fills[lotNum - 1] && !fills[lotNum - 1]?.filled) break; // prior not filled

      // Time gate for Lot 2: 5 trading days after Lot 1 fill
      if (lotNum === 2) {
        const lot1FillDate = fills[1]?.date || pos.createdAt;
        const gateCleared  = tradingDaysSince(lot1FillDate) >= 5;
        if (!gateCleared) break;
      }

      const trigger   = lotTrigger(anchor, lotIdx, isLong);
      const priceHit  = cp != null && (isLong ? cp >= trigger : cp <= trigger);
      if (!priceHit) break; // price hasn't reached trigger yet

      const shares = lotTargetShares(totalShares, lotIdx);
      tasks.push({
        id:              `lot_ready_${ticker}_${lotNum}`,
        priority:        1,
        type:            'LOT_READY',
        ticker,
        badge:           'LOT READY',
        headline:        `${ticker}: Lot ${lotNum} READY — price hit ${fmt$(trigger)}. Buy ${shares} shares in IBKR.`,
        instructions:    [
          `1. In IBKR, place a BUY order for ${shares} shares of ${ticker} at market`,
          '2. Note the exact fill price when it executes',
          `3. Return to PNTHR Command → ${ticker} card → find Lot ${lotNum}`,
          `4. Click FILL on Lot ${lotNum} → enter the fill price and date`,
          '5. The system will prompt you to ratchet the stop — confirm when asked',
        ],
        confirmQuestion: `Did you buy the shares in IBKR and record the Lot ${lotNum} fill in Command?`,
        data:            { lotNum, trigger, shares, currentPrice: cp },
        dayOfWeek:       null,
        autoClears:      true,
      });
      break; // only generate the NEXT eligible lot, not multiple at once
    }

    // ── P1: RATCHET_DUE ───────────────────────────────────────────────────────
    const ratchet = computeRequiredRatchet(fills);
    if (ratchet) {
      const needsRatchet = isLong
        ? (stopPrice == null || stopPrice < ratchet.ratchetLevel)
        : (stopPrice == null || stopPrice > ratchet.ratchetLevel);

      if (needsRatchet) {
        const ratchetLevelStr = fmt$(ratchet.ratchetLevel);
        const currentStr      = fmt$(stopPrice);
        tasks.push({
          id:              `ratchet_due_${ticker}`,
          priority:        1,
          type:            'RATCHET_DUE',
          ticker,
          badge:           'RATCHET DUE',
          headline:        `${ticker}: Stop ratchet overdue. Move stop from ${currentStr} → ${ratchetLevelStr} (Lot ${ratchet.lotRule} rule).`,
          instructions:    [
            `1. In IBKR, find your ${ticker} position's stop order`,
            `2. Modify the stop price to ${ratchetLevelStr}`,
            `3. In PNTHR Command → ${ticker} → edit the Stop field → enter ${ratchetLevelStr}`,
            `4. This locks in ${isLong ? 'breakeven' : 'profit'} on this position`,
          ],
          confirmQuestion: `Did you update the stop to ${ratchetLevelStr} in both IBKR and Command?`,
          data:            { ratchetLevel: ratchet.ratchetLevel, currentStop: stopPrice, lotRule: ratchet.lotRule },
          dayOfWeek:       null,
          autoClears:      false,
        });
      }
    }

    // ── P1: FEAST_ALERT ───────────────────────────────────────────────────────
    if (pos.feastAlert && pos.feastRSI != null) {
      const rsi = Math.round(pos.feastRSI);
      const filledShares = Object.values(fills)
        .filter(f => f.filled)
        .reduce((s, f) => s + (+f.shares || 0), 0);
      const halfShares = Math.max(1, Math.floor(filledShares / 2));

      tasks.push({
        id:              `feast_${ticker}`,
        priority:        1,
        type:            'FEAST_ALERT',
        ticker,
        badge:           'FEAST',
        headline:        `${ticker} ${direction}: RSI ${rsi}. FEAST RULE — Sell 50% immediately.`,
        instructions:    [
          `1. FEAST rule triggered: weekly RSI above 85 signals extreme overbought condition`,
          `2. In IBKR, sell 50% of your ${ticker} shares (${halfShares} shares at market)`,
          '3. Note the fill price and time',
          `4. In Command → ${ticker} → record a partial exit for ${halfShares} shares`,
          '5. Keep remaining shares — let the stop manage the rest',
        ],
        confirmQuestion: `Did you sell 50% of ${ticker} shares in IBKR and record the partial exit?`,
        data:            { rsi, halfShares, direction },
        dayOfWeek:       null,
        autoClears:      false,
      });
    }

    // ── P1: STALE_HUNT_20 ─────────────────────────────────────────────────────
    if (days >= 20) {
      tasks.push({
        id:              `stale_20_${ticker}`,
        priority:        1,
        type:            'STALE_HUNT_20',
        ticker,
        badge:           'LIQUIDATE',
        headline:        `${ticker}: Day ${days}/20 — LIQUIDATE TODAY. System rule requires exit.`,
        instructions:    [
          '1. Stale hunt rule: positions held 20+ trading days without confirmation must close',
          `2. In IBKR, close your entire ${ticker} position at market`,
          '3. Note the fill price',
          `4. In Command → ${ticker} → CLOSE → enter price, date, reason: STALE_HUNT`,
        ],
        confirmQuestion: `Did you close ${ticker} in IBKR and record the exit with reason STALE_HUNT?`,
        data:            { days },
        dayOfWeek:       null,
        autoClears:      true,
      });
    }

    // ── P1: EARNINGS_TOMORROW ─────────────────────────────────────────────────
    const earnDate   = earningsMap[ticker];
    const daysToEarn = daysUntilEarnings(earnDate);
    if (daysToEarn != null && daysToEarn <= 1 && daysToEarn >= 0) {
      tasks.push({
        id:              `earnings_tomorrow_${ticker}`,
        priority:        1,
        type:            'EARNINGS_TOMORROW',
        ticker,
        badge:           'EARNINGS TMRW',
        headline:        `${ticker}: Earnings ${daysToEarn === 0 ? 'TODAY' : 'TOMORROW'} (${earnDate}). Decide now: hold or exit before open?`,
        instructions:    [
          `1. ${ticker} reports earnings ${daysToEarn === 0 ? 'today' : 'tomorrow'} — price can gap significantly in either direction`,
          `2. Your current stop at ${fmt$(stopPrice)} may not protect against a gap`,
          '3. Options: (A) Exit today before close to avoid earnings risk, or (B) Hold with current stop',
          `4. If exiting: sell in IBKR → record in Command with reason: MANUAL`,
          '5. If holding: no action needed — but be prepared for volatility at open tomorrow',
        ],
        confirmQuestion: `Have you decided whether to hold or exit ${ticker} before earnings?`,
        data:            { earnDate, daysToEarn, stopPrice },
        dayOfWeek:       null,
        autoClears:      false,
      });
    }

    // ── P1: IBKR_STOP_MISMATCH ────────────────────────────────────────────────
    if (ibkr.ibkrStop != null && stopPrice != null) {
      const stopDiff = Math.abs(ibkr.ibkrStop - stopPrice);
      if (stopDiff > 0.10) {
        tasks.push({
          id:              `ibkr_stop_mismatch_${ticker}`,
          priority:        1,
          type:            'IBKR_STOP_MISMATCH',
          ticker,
          badge:           'STOP SYNC',
          headline:        `${ticker}: IBKR stop ${fmt$(ibkr.ibkrStop)} doesn't match PNTHR ${fmt$(stopPrice)}. Update IBKR.`,
          instructions:    [
            `1. Your IBKR stop for ${ticker} is set to ${fmt$(ibkr.ibkrStop)}`,
            `2. PNTHR has calculated the correct stop as ${fmt$(stopPrice)}`,
            `3. In IBKR, find your ${ticker} stop order and modify it to ${fmt$(stopPrice)}`,
            '4. Do NOT change the stop in PNTHR Command — it\'s already correct',
          ],
          confirmQuestion: `Did you update the ${ticker} stop in IBKR to ${fmt$(stopPrice)}?`,
          data:            { ibkrStop: ibkr.ibkrStop, pnthrStop: stopPrice, diff: +stopDiff.toFixed(2) },
          dayOfWeek:       null,
          autoClears:      false,
        });
      }
    }

    // ── P2: STOP_CLOSE (within 2%) ────────────────────────────────────────────
    if (cp != null && stopPrice != null) {
      const dist = Math.abs((cp - stopPrice) / cp) * 100;
      if (dist <= 2.0 && dist > 0) {
        tasks.push({
          id:              `stop_close_${ticker}`,
          priority:        2,
          type:            'STOP_CLOSE',
          ticker,
          badge:           'STOP CLOSE',
          headline:        `${ticker}: Price ${fmt$(cp)} is ${dist.toFixed(1)}% from stop ${fmt$(stopPrice)}. Watch closely today.`,
          instructions:    [
            `Monitor ${ticker} closely today — stop at ${fmt$(stopPrice)} may be hit.`,
            'If stopped out: check IBKR Activity and record exit in Command.',
          ],
          confirmQuestion: `Noted — you're watching ${ticker} today.`,
          data:            { currentPrice: cp, stopPrice, dist: +dist.toFixed(2) },
          dayOfWeek:       null,
          autoClears:      false,
        });
      }
    }

    // ── P2: STALE_HUNT_18 (days 18-19) ───────────────────────────────────────
    if (days >= 18 && days < 20) {
      tasks.push({
        id:              `stale_18_${ticker}`,
        priority:        2,
        type:            'STALE_HUNT_18',
        ticker,
        badge:           'STALE',
        headline:        `${ticker}: Day ${days}/20 — ${20 - days} trading days to forced exit.`,
        instructions:    [
          `Plan your ${ticker} exit — you have ${20 - days} trading days remaining.`,
          'Evaluate: is the trade working? If not, consider exiting early rather than waiting for the deadline.',
        ],
        confirmQuestion: `Have you reviewed your plan for ${ticker}?`,
        data:            { days, remaining: 20 - days },
        dayOfWeek:       null,
        autoClears:      false,
      });
    }

    // ── P2: LOT_GATE_CLEAR (gate open, price not yet at trigger) ─────────────
    // Shows every day the gate is open and Lot 2 hasn't been hit yet.
    // On Day 10+ escalates to LOT_GATE_NO_TRIGGER (P2 with reassessment guidance).
    {
      const lot2 = fills[2];
      if (!lot2?.filled && fills[1]?.filled) {
        const lot1FillDate = fills[1]?.date || pos.createdAt;
        const tradDays     = tradingDaysSince(lot1FillDate);
        if (tradDays >= 5) {
          const trigger  = lotTrigger(anchor, 1, isLong);
          const priceHit = cp != null && (isLong ? cp >= trigger : cp <= trigger);
          if (!priceHit) {
            const shares    = lotTargetShares(totalShares, 1);
            const remaining = 20 - tradDays;
            const isDay10Plus = tradDays >= 10;

            if (isDay10Plus) {
              // ── LOT_GATE_NO_TRIGGER — momentum reassessment alert ────────
              const urgency = tradDays >= 14 ? 'CONSIDER EXITING' : 'REASSESS NOW';
              tasks.push({
                id:       `lot_gate_no_trigger_${ticker}_2`,
                priority: 2,
                type:     'LOT_GATE_NO_TRIGGER',
                ticker,
                badge:    urgency,
                headline: `${ticker}: Day ${tradDays} — Lot 2 gate open ${tradDays - 5} days, trigger ${fmt$(trigger)} still not hit. Reassess.`,
                instructions: [
                  `1. ${ticker} entered ${tradDays} trading days ago. Lot 2 gate opened ${tradDays - 5} days ago.`,
                  `2. Lot 2 trigger of ${fmt$(trigger)} (${isLong ? '+3%' : '-3%'} from entry) has NOT been reached — the stock has not confirmed the move.`,
                  `3. This is a momentum warning. A stock that can't move ${isLong ? '+3%' : '-3%'} in ${tradDays - 5} days may be losing conviction.`,
                  `4. Check the chart: Is price still ${isLong ? 'above' : 'below'} the 21W EMA? Is the EMA slope still ${isLong ? 'up' : 'down'}?`,
                  `5. If YES (signal intact): hold and continue watching for the trigger. ${remaining} trading days remain before stale hunt deadline.`,
                  `6. If NO (signal weakening or price drifting back): consider exiting voluntarily now rather than waiting for the Day 20 forced exit.`,
                  tradDays >= 14
                    ? `7. ⚠ Day ${tradDays}/20 — you have ${remaining} trading days left. Voluntary exit now is strongly recommended if the move hasn't materialized.`
                    : `7. You have ${remaining} trading days remaining before the mandatory stale hunt exit at Day 20.`,
                ],
                confirmQuestion: `Have you reviewed ${ticker}'s chart and decided whether to hold or exit early?`,
                data:            { trigger, shares, tradDays, remaining, daysGateOpen: tradDays - 5 },
                dayOfWeek:       null,
                autoClears:      false,
              });
            } else {
              // ── LOT_GATE_CLEAR — informational (Days 5-9) ───────────────
              const openedDaysAgo = tradDays - 5;
              const gateDesc = openedDaysAgo === 0 ? 'opens today' : `opened ${openedDaysAgo} day${openedDaysAgo > 1 ? 's' : ''} ago`;
              tasks.push({
                id:       `lot_gate_clear_${ticker}_2`,
                priority: 2,
                type:     'LOT_GATE_CLEAR',
                ticker,
                badge:    'GATE OPEN',
                headline: `${ticker}: Lot 2 gate ${gateDesc}. Trigger ${fmt$(trigger)} not yet hit — Day ${tradDays}/20.`,
                instructions: [
                  `1. The 5-day time gate for ${ticker} Lot 2 has cleared (Day ${tradDays} since entry).`,
                  `2. Lot 2 trigger: ${fmt$(trigger)} (${isLong ? '+3%' : '-3%'} from entry). Buy ${shares} shares when price reaches this level.`,
                  `3. If price hits ${fmt$(trigger)}: buy ${shares} shares in IBKR, then record the Lot 2 fill in Command.`,
                  `4. Momentum guidance: if the trigger isn't hit by Day 10, you'll receive a reassessment alert.`,
                  `5. Stale hunt clock: Day ${tradDays} of 20 — ${remaining} trading days remaining before mandatory exit.`,
                ],
                confirmQuestion: `Noted — you're watching for ${ticker} Lot 2 trigger at ${fmt$(trigger)}.`,
                data:            { trigger, shares, tradDays, remaining },
                dayOfWeek:       null,
                autoClears:      false,
              });
            }
          }
        }
      }
    }

    // ── P2: EARNINGS_THIS_WEEK (2-5 days out) ────────────────────────────────
    if (daysToEarn != null && daysToEarn >= 2 && daysToEarn <= 5) {
      tasks.push({
        id:              `earnings_week_${ticker}`,
        priority:        2,
        type:            'EARNINGS_THIS_WEEK',
        ticker,
        badge:           'EARNINGS',
        headline:        `${ticker}: Reports earnings ${daysToEarn === 2 ? 'in 2 days' : 'this week'} (${earnDate}).`,
        instructions:    [
          `Start thinking about your plan for ${ticker} earnings.`,
          'Consider your current P&L, stop placement, and risk tolerance before the announcement.',
        ],
        confirmQuestion: `Noted — you're aware of ${ticker} earnings.`,
        data:            { earnDate, daysToEarn },
        dayOfWeek:       null,
        autoClears:      false,
      });
    }

    // ── P2: EXIT_UNRECORDED ───────────────────────────────────────────────────
    if (ibkr.ibkrShares != null && ibkr.ibkrShares === 0) {
      tasks.push({
        id:              `exit_unrecorded_${ticker}`,
        priority:        2,
        type:            'EXIT_UNRECORDED',
        ticker,
        badge:           'EXIT UNRECORDED',
        headline:        `${ticker}: IBKR shows position closed but PNTHR still shows ACTIVE. Record the exit.`,
        instructions:    [
          `1. Your ${ticker} position was closed in IBKR (IBKR shows 0 shares)`,
          '2. Open IBKR → Activity → Executions to find the exit price and date',
          `3. In PNTHR Command → ${ticker} → CLOSE → enter the fill price, date, and exit reason`,
          '4. The position will move to the journal for discipline scoring',
        ],
        confirmQuestion: `Did you record the ${ticker} exit in Command?`,
        data:            { ibkrShares: 0 },
        dayOfWeek:       null,
        autoClears:      true,
      });
    }

    // ── P3: STALE_HUNT_15 (days 15-17) ───────────────────────────────────────
    if (days >= 15 && days < 18) {
      tasks.push({
        id:              `stale_15_${ticker}`,
        priority:        3,
        type:            'STALE_HUNT_15',
        ticker,
        badge:           'STALE',
        headline:        `${ticker}: Day ${days}/20 — Start planning your exit strategy.`,
        instructions:    [
          `${ticker} has been open ${days} trading days. You have ${20 - days} days before the forced exit rule triggers.`,
          'Review whether the trade is performing as expected and consider your exit plan.',
        ],
        confirmQuestion: `Have you reviewed ${ticker} staleness?`,
        data:            { days, remaining: 20 - days },
        dayOfWeek:       null,
        autoClears:      false,
      });
    }

    // ── P3: HEAT_WARNING ──────────────────────────────────────────────────────
    // (computed below per-portfolio, not per-position — see portfolio section)

    // ── P3: IBKR_SHARE_MISMATCH ───────────────────────────────────────────────
    if (ibkr.ibkrShares != null && ibkr.ibkrShares > 0) {
      const filledShares = Object.values(fills)
        .filter(f => f.filled)
        .reduce((s, f) => s + (+f.shares || 0), 0);
      if (filledShares > 0 && Math.abs(ibkr.ibkrShares - filledShares) >= 1) {
        tasks.push({
          id:              `ibkr_share_mismatch_${ticker}`,
          priority:        3,
          type:            'IBKR_SHARE_MISMATCH',
          ticker,
          badge:           'SHARE MISMATCH',
          headline:        `${ticker}: IBKR shows ${ibkr.ibkrShares} shares, PNTHR has ${filledShares}. Verify your records.`,
          instructions:    [
            `IBKR shows ${ibkr.ibkrShares} shares for ${ticker}, but PNTHR records show ${filledShares} filled shares.`,
            'Open IBKR → Activity → Executions and compare fill records.',
            'If PNTHR is wrong, edit the lot fill details in Command to match IBKR.',
          ],
          confirmQuestion: `Have you verified the share count for ${ticker}?`,
          data:            { ibkrShares: ibkr.ibkrShares, pnthrShares: filledShares },
          dayOfWeek:       null,
          autoClears:      false,
        });
      }
    }

    // ── P3: WASH_EXPIRING ─────────────────────────────────────────────────────
    // Check for recent closed positions in same ticker that could trigger wash sale
    // (simplified: check if position was opened within 30 days of today)
    // Full wash logic would require journal data — this is a lightweight signal
    if (pos.washSaleExpiry) {
      const expiry     = new Date(pos.washSaleExpiry);
      const today      = new Date();
      const daysToExp  = Math.round((expiry - today) / (1000 * 60 * 60 * 24));
      if (daysToExp >= 0 && daysToExp <= 7) {
        tasks.push({
          id:              `wash_expiring_${ticker}`,
          priority:        3,
          type:            'WASH_EXPIRING',
          ticker,
          badge:           'WASH EXPIRY',
          headline:        `${ticker}: Wash sale window expires in ${daysToExp} days (${pos.washSaleExpiry}).`,
          instructions:    [
            `The wash sale restriction for ${ticker} expires on ${pos.washSaleExpiry} (${daysToExp} days).`,
            'If you exit and re-enter before the wash sale window closes, losses may be disallowed.',
            'Consult your tax advisor before closing this position.',
          ],
          confirmQuestion: `Noted — you're aware of the ${ticker} wash sale window.`,
          data:            { washExpiry: pos.washSaleExpiry, daysToExp },
          dayOfWeek:       null,
          autoClears:      false,
        });
      }
    }
  }

  // ── Portfolio-level P3 checks ─────────────────────────────────────────────

  // P3: HEAT_WARNING — portfolio heat > 80% of 15% cap
  if (nav > 0 && activePosns.length > 0) {
    let totalRisk = 0;
    for (const p of activePosns) {
      const isL   = p.direction === 'LONG';
      const fShr  = Object.values(p.fills || {})
        .filter(f => f.filled).reduce((s, f) => s + (+f.shares || 0), 0);
      const avg   = fShr > 0
        ? Object.values(p.fills || {}).filter(f => f.filled)
            .reduce((s, f) => s + (+f.shares || 0) * (+f.price || 0), 0) / fShr
        : (p.entryPrice || 0);
      const rps   = Math.max(0, isL ? avg - p.stopPrice : p.stopPrice - avg);
      const recycled = isL ? p.stopPrice >= avg : p.stopPrice <= avg;
      if (!recycled) totalRisk += fShr * rps;
    }
    const heatPct = (totalRisk / nav) * 100;
    const cap     = 15;
    if (heatPct >= cap * 0.80) {
      tasks.push({
        id:              'heat_warning',
        priority:        3,
        type:            'HEAT_WARNING',
        ticker:          null,
        badge:           'HEAT WARNING',
        headline:        `Portfolio heat at ${heatPct.toFixed(1)}% — approaching ${cap}% cap.`,
        instructions:    [
          `Current portfolio heat: ${heatPct.toFixed(1)}% of NAV (${fmt$(totalRisk)}).`,
          `PNTHR cap is ${cap}%. You have ${(cap - heatPct).toFixed(1)}% remaining before hard cap.`,
          'Consider whether any positions should be reduced or stops tightened.',
        ],
        confirmQuestion: 'Have you reviewed portfolio heat?',
        data:            { heatPct: +heatPct.toFixed(2), totalRisk: +totalRisk.toFixed(0), cap },
        dayOfWeek:       null,
        autoClears:      false,
      });
    }
  }

  // P3: SECTOR_LIMIT — any sector at net 3 positions
  if (activePosns.length > 0) {
    const sectorNet = {};
    for (const p of activePosns) {
      const sec = p.sector;
      if (!sec || sec === '—') continue;
      if (!sectorNet[sec]) sectorNet[sec] = { longs: 0, shorts: 0 };
      if (p.direction === 'LONG') sectorNet[sec].longs++;
      else sectorNet[sec].shorts++;
    }
    for (const [sec, counts] of Object.entries(sectorNet)) {
      const net = Math.abs(counts.longs - counts.shorts);
      if (net >= 3) {
        tasks.push({
          id:              `sector_limit_${sec.replace(/\s+/g, '_')}`,
          priority:        3,
          type:            'SECTOR_LIMIT',
          ticker:          null,
          badge:           'SECTOR LIMIT',
          headline:        `${sec}: Net directional exposure at ${net} (cap = 3). Review concentration.`,
          instructions:    [
            `${sec} sector has ${counts.longs} long${counts.longs !== 1 ? 's' : ''} and ${counts.shorts} short${counts.shorts !== 1 ? 's' : ''}`,
            `Net directional exposure = ${net} (PNTHR cap is 3).`,
            'Consider whether a new position in this sector would violate the concentration rule.',
            'No immediate action required — this is a watch flag for new entries.',
          ],
          confirmQuestion: `Have you reviewed ${sec} sector concentration?`,
          data:            { sector: sec, longs: counts.longs, shorts: counts.shorts, net },
          dayOfWeek:       null,
          autoClears:      false,
        });
      }
    }
  }

  // ── Sort: priority ASC, then ticker alphabetically ────────────────────────
  tasks.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const ta = a.ticker || 'ZZZZZ';
    const tb = b.ticker || 'ZZZZZ';
    return ta.localeCompare(tb);
  });

  return tasks;
}

// ── Stop Sync ─────────────────────────────────────────────────────────────────

/**
 * Compare signal-cache stop prices with stored position stop prices.
 * Returns an array of rows for the Stop Sync UI section.
 *
 * @param {object[]} positions — active positions
 * @returns {object[]} stopSyncRows
 */
export async function getStopSyncRows(positions) {
  const activePosns = positions.filter(p => p.status === 'ACTIVE');
  const tickers     = activePosns.map(p => p.ticker.toUpperCase());
  const signalStops = await loadSignalStops(tickers);

  return activePosns.map(p => {
    const ticker     = p.ticker.toUpperCase();
    const currentStop = p.stopPrice ?? null;
    const newStop     = signalStops[ticker] ?? null;
    const diff        = currentStop != null && newStop != null
      ? +Math.abs(currentStop - newStop).toFixed(2)
      : null;
    const needsUpdate = diff != null && diff >= 0.01;

    return {
      ticker,
      direction:    p.direction,
      currentStop,
      newStop,
      diff,
      needsUpdate,
    };
  }).sort((a, b) => {
    if (a.needsUpdate !== b.needsUpdate) return a.needsUpdate ? -1 : 1;
    return a.ticker.localeCompare(b.ticker);
  });
}

// ── Routine Tasks ─────────────────────────────────────────────────────────────

/**
 * Pre-seeded day-of-week checklists.
 * dayOfWeek: 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, null=daily
 */
const BUILT_IN_ROUTINES = [
  // ── Daily ──
  { id: 'daily_ibkr_check',   dayOfWeek: null, label: 'Review IBKR overnight — any exits?' },
  { id: 'daily_record_exits', dayOfWeek: null, label: 'Record any exits in Command' },
  { id: 'daily_stop_check',   dayOfWeek: null, label: 'Verify all stop orders are live in IBKR' },

  // ── Monday ──
  { id: 'mon_stop_sync',      dayOfWeek: 1, label: 'Run Monday Stop Sync — update IBKR stops to match PNTHR' },
  // mon_weekly_plan, mon_sector_review, mon_earnings_scan → computed smart routines (see buildRoutineContext)
  { id: 'mon_heat_check',     dayOfWeek: 1, label: 'Check portfolio heat — are you within 15% cap?' },
  { id: 'mon_regime',         dayOfWeek: 1, label: 'Check market regime — SPY/QQQ above or below 21W EMA?' },

  // ── Wednesday ──
  { id: 'wed_mid_week',       dayOfWeek: 3, label: 'Mid-week position review — any lot triggers approaching?' },
  { id: 'wed_perch_check',    dayOfWeek: 3, label: "Check PNTHR's Perch — new newsletter published?" },
  { id: 'wed_stale_review',   dayOfWeek: 3, label: 'Review stale positions (Day 10+) — still in thesis?' },

  // ── Friday ──
  { id: 'fri_kill_refresh',   dayOfWeek: 5, label: 'Friday Kill refresh — new pipeline running at 4:15 PM ET' },
  { id: 'fri_week_review',    dayOfWeek: 5, label: 'End-of-week review: wins, losses, and lessons' },
  { id: 'fri_journal',        dayOfWeek: 5, label: 'Update journal discipline scores for closed trades' },
  { id: 'fri_ibkr_token',     dayOfWeek: 5, label: 'Check IBKR bridge token expiry — renew if < 2 weeks' },
];

// ── Smart Routine Context ─────────────────────────────────────────────────────

/**
 * Build context object for smart Monday routines.
 * Fetches earnings and computes sector summary so routines show specific data.
 *
 * @param {object[]} activePosns  — active PNTHR portfolio positions
 * @param {object[]} killSignals  — from getCachedSignalStocks() in apexService
 * @returns {object} context for getRoutineTasks()
 */
export async function buildRoutineContext(activePosns, killSignals = []) {
  const tickers = activePosns.map(p => p.ticker.toUpperCase());
  const earningsMap = await fetchEarningsMap(tickers).catch(() => ({}));

  // ── Chip helper ───────────────────────────────────────────────────────────
  function tierShort(tier) {
    if (!tier) return '';
    return tier.split(' ')[0]; // 'ALPHA PNTHR KILL' → 'ALPHA'
  }

  function toChip(s) {
    return {
      ticker:    s.ticker,
      score:     Math.round(s.totalScore ?? 0),
      tier:      tierShort(s.tier),
      rank:      s.killRank,
      direction: s.signal,
      price:     s.currentPrice ? +Number(s.currentPrice).toFixed(2) : null,
      sector:    s.sector || null,
    };
  }

  // ── Kill signals chip sections ────────────────────────────────────────────
  // Exclude tickers already held in Command Center — no point re-entering
  const heldTickers = new Set(activePosns.map(p => p.ticker.toUpperCase()));

  let killLabel, killChipSections;

  if (!killSignals.length) {
    killLabel = 'Kill signals: Computing... auto-refreshes in ~60s';
    killChipSections = [];
  } else {
    const blAll = killSignals
      .filter(s => s.signal === 'BL' && !heldTickers.has(s.ticker.toUpperCase()))
      .sort((a, b) => (b.totalScore ?? 0) - (a.totalScore ?? 0));
    const ssAll = killSignals
      .filter(s => s.signal === 'SS' && !heldTickers.has(s.ticker.toUpperCase()))
      .sort((a, b) => (b.totalScore ?? 0) - (a.totalScore ?? 0));

    const blTotal = killSignals.filter(s => s.signal === 'BL').length;
    const ssTotal = killSignals.filter(s => s.signal === 'SS').length;
    const blHeld  = blTotal - blAll.length;
    const ssHeld  = ssTotal - ssAll.length;
    const heldNote = (blHeld + ssHeld) > 0
      ? ` (${blHeld + ssHeld} already held excluded)`
      : '';

    killLabel = `Kill signals: ${blAll.length} new BL · ${ssAll.length} new SS — top setups by Kill Score below${heldNote}`;
    killChipSections = [];

    if (blAll.length) {
      killChipSections.push({
        title:    `▲ TOP 5 BL — Kill Score  (${blAll.length} new, not yet held)`,
        subtitle: 'Click any ticker to open chart → check Analyze + Composite before entering',
        direction: 'BL',
        chips:    blAll.slice(0, 5).map(toChip),
      });
    }
    if (ssAll.length) {
      killChipSections.push({
        title:    `▼ TOP 5 SS — Kill Score  (${ssAll.length} new, not yet held)`,
        subtitle: 'Click any ticker to open chart → check Analyze + Composite before shorting',
        direction: 'SS',
        chips:    ssAll.slice(0, 5).map(toChip),
      });
    }
  }

  // ── Sector analysis chip sections ─────────────────────────────────────────
  // Group Kill signals by sector
  const sectorBLMap = {};
  const sectorSSMap = {};
  for (const s of killSignals) {
    const sec = s.sector;
    if (!sec || sec === '—') continue;
    if (s.signal === 'BL') {
      if (!sectorBLMap[sec]) sectorBLMap[sec] = [];
      sectorBLMap[sec].push(s);
    } else if (s.signal === 'SS') {
      if (!sectorSSMap[sec]) sectorSSMap[sec] = [];
      sectorSSMap[sec].push(s);
    }
  }

  // Compute sector signal counts (use count not score-sum — DORMANT stocks have
  // negative Kill scores which would corrupt a score-sum-based comparison).
  const allSectors = new Set([...Object.keys(sectorBLMap), ...Object.keys(sectorSSMap)]);
  const sectorStats = {};
  for (const sec of allSectors) {
    const blStocks = sectorBLMap[sec] || [];
    const ssStocks = sectorSSMap[sec] || [];
    // Use best killRank (lowest number = best) as secondary sort metric
    const bestBLRank = blStocks.length ? Math.min(...blStocks.map(s => s.killRank ?? 9999)) : 9999;
    const bestSSRank = ssStocks.length ? Math.min(...ssStocks.map(s => s.killRank ?? 9999)) : 9999;
    sectorStats[sec] = {
      blCount: blStocks.length,
      ssCount: ssStocks.length,
      bestBLRank,
      bestSSRank,
    };
  }

  // Rising sectors: more BL signals than SS, at least 2 BL, sorted by BL count then best BL rank
  const risingSectors = Object.entries(sectorStats)
    .filter(([, v]) => v.blCount > v.ssCount && v.blCount >= 2)
    .sort(([, a], [, b]) => b.blCount !== a.blCount ? b.blCount - a.blCount : a.bestBLRank - b.bestBLRank)
    .slice(0, 4);

  // Falling sectors: more SS signals than BL, at least 2 SS, sorted by SS count then best SS rank
  const fallingSectors = Object.entries(sectorStats)
    .filter(([, v]) => v.ssCount > v.blCount && v.ssCount >= 2)
    .sort(([, a], [, b]) => b.ssCount !== a.ssCount ? b.ssCount - a.ssCount : a.bestSSRank - b.bestSSRank)
    .slice(0, 4);

  const sectorChipSections = [];
  for (const [sec, v] of risingSectors) {
    const chips = (sectorBLMap[sec] || [])
      .filter(s => !heldTickers.has(s.ticker.toUpperCase()))
      .sort((a, b) => (b.totalScore ?? 0) - (a.totalScore ?? 0))
      .slice(0, 3)
      .map(toChip);
    if (chips.length) {
      sectorChipSections.push({
        title:    `↑ ${sec} — ${v.blCount} BL signals`,
        direction: 'BL',
        chips,
      });
    }
  }
  for (const [sec, v] of fallingSectors) {
    const chips = (sectorSSMap[sec] || [])
      .filter(s => !heldTickers.has(s.ticker.toUpperCase()))
      .sort((a, b) => (b.totalScore ?? 0) - (a.totalScore ?? 0))
      .slice(0, 3)
      .map(toChip);
    if (chips.length) {
      sectorChipSections.push({
        title:    `↓ ${sec} — ${v.ssCount} SS signals`,
        direction: 'SS',
        chips,
      });
    }
  }

  const sectorLabel = sectorChipSections.length > 0
    ? `Sector scan: ${risingSectors.length} rising · ${fallingSectors.length} falling — top picks below`
    : killSignals.length === 0
      ? 'Sector scan: Computing... auto-refreshes in ~60s'
      : 'Sector scan: Balanced — no dominant rising or falling sectors';

  // ── Earnings for held positions this week ─────────────────────────────────
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const sevenDays = new Date(today);
  sevenDays.setDate(today.getDate() + 7);

  const earningsThisWeek = activePosns
    .filter(p => {
      const earnDate = earningsMap[p.ticker.toUpperCase()];
      if (!earnDate) return false;
      const d = new Date(earnDate + 'T00:00:00');
      return d >= today && d <= sevenDays;
    })
    .map(p => ({ ticker: p.ticker, date: earningsMap[p.ticker.toUpperCase()] }))
    .sort((a, b) => a.date.localeCompare(b.date));

  let earningsLabel, earningsDetail;
  if (!earningsThisWeek.length) {
    earningsLabel = 'Earnings check: No held positions reporting this week ✓';
    earningsDetail = null;
  } else {
    const names = earningsThisWeek.map(e => {
      const d = new Date(e.date + 'T00:00:00');
      const dow = d.toLocaleDateString('en-US', { weekday: 'short' });
      return `${e.ticker} (${dow})`;
    }).join(' · ');
    earningsLabel = `Earnings this week: ${earningsThisWeek.map(e => e.ticker).join(', ')} — decide hold or exit`;
    earningsDetail = names + ' — see P1/P2 tasks above for action steps';
  }

  return {
    killLabel,
    killChipSections,
    sectorLabel,
    sectorChipSections,
    earningsLabel,
    earningsDetail,
  };
}

/**
 * Get routine tasks for a given day of week (0=Sun..6=Sat).
 * Pass context (from buildRoutineContext) to inject smart Monday routines.
 * Returns daily tasks + day-specific tasks.
 *
 * @param {number}  dayOfWeek  0=Sun..6=Sat
 * @param {object}  context    optional — from buildRoutineContext()
 */
export function getRoutineTasks(dayOfWeek, context = {}) {
  const base = BUILT_IN_ROUTINES.filter(r =>
    r.dayOfWeek === null || r.dayOfWeek === dayOfWeek
  );

  // Inject smart Monday routines after mon_stop_sync
  if (dayOfWeek === 1) {
    const {
      killLabel        = 'Kill signals: Review Kill page for new BL/SS signals',
      killChipSections = [],
      sectorLabel      = 'Sector concentration — review for any sector at 3+ net',
      sectorChipSections = [],
      earningsLabel    = 'Earnings check — scan calendar for held positions this week',
      earningsDetail   = null,
    } = context;

    const smartRoutines = [
      {
        id:           'mon_weekly_plan',
        dayOfWeek:    1,
        label:        killLabel,
        detail:       null,
        chipSections: killChipSections,
      },
      {
        id:           'mon_sector_review',
        dayOfWeek:    1,
        label:        sectorLabel,
        detail:       null,
        chipSections: sectorChipSections,
      },
      {
        id:           'mon_earnings_scan',
        dayOfWeek:    1,
        label:        earningsLabel,
        detail:       earningsDetail || null,
        chipSections: [],
      },
    ];

    // Insert smart routines after mon_stop_sync
    const stopSyncIdx = base.findIndex(r => r.id === 'mon_stop_sync');
    if (stopSyncIdx >= 0) {
      base.splice(stopSyncIdx + 1, 0, ...smartRoutines);
    } else {
      base.push(...smartRoutines);
    }
  }

  return base;
}

// ── Completed Records ─────────────────────────────────────────────────────────

/**
 * Mark a task as completed for today.
 */
export async function markTaskComplete(userId, taskId, taskType, ticker, dayOfWeek) {
  const db = await connectToDatabase();
  await db.collection('pnthr_assistant_completed').insertOne({
    userId,
    taskId,
    taskType:    taskType || null,
    ticker:      ticker   || null,
    completedAt: new Date(),
    date:        todayStr(),
    dayOfWeek:   dayOfWeek ?? new Date().getDay(),
  });
}

/**
 * Get all tasks completed by this user today.
 */
export async function getTodayCompleted(userId) {
  const db   = await connectToDatabase();
  const docs = await db.collection('pnthr_assistant_completed')
    .find({ userId, date: todayStr() })
    .sort({ completedAt: -1 })
    .toArray();
  return docs;
}

/**
 * Ensure indexes exist for the completed collection.
 */
export async function ensureAssistantIndexes() {
  try {
    const db = await connectToDatabase();
    await db.collection('pnthr_assistant_completed').createIndex(
      { userId: 1, date: -1 }
    );
    await db.collection('pnthr_assistant_completed').createIndex(
      { userId: 1, taskId: 1, date: 1 }, { unique: true }
    );
  } catch (err) {
    console.warn('[Assistant] Index creation warning:', err.message);
  }
}
