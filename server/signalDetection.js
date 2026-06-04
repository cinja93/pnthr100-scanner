// server/signalDetection.js  (mirrors client/src/utils/signalDetection.js)
// ── PNTHR signal state machine — extracted from ChartModal.jsx ─────────────
//
// The full BL/SS/BE/SE detection used by the 679 weekly chart, isolated here
// so it can be reused by other charts (PAI300 index, eventually individual AI
// Universe tickers). Behavior is identical to the version that lives inside
// ChartModal — same daylight rules, same 2-week structural triggers, same
// ATR-based stop math, same trend caps.
//
// Bar shape expected: { time: 'YYYY-MM-DD', open, high, low, close } sorted
// ascending. Caller maps from whatever native field name they use (e.g.
// PAI300 bars carry `date` — map to `time` before calling).
//
// Returns: { events, pnthrStop, currentWeekStop, activeType, currentSignal }
//   events = [{ time, signal: 'BL'|'SS'|'BE'|'SE', barLow, barHigh, profitDollar?, profitPct? }]
// ────────────────────────────────────────────────────────────────────────────

export function calculateEMA(bars, period) {
  if (bars.length < period) return [];
  const k = 2 / (period + 1);
  const result = [];
  let ema = bars.slice(0, period).reduce((sum, d) => sum + d.close, 0) / period;
  result.push({ time: bars[period - 1].time, value: parseFloat(ema.toFixed(4)) });
  for (let i = period; i < bars.length; i++) {
    ema = bars[i].close * k + ema * (1 - k);
    result.push({ time: bars[i].time, value: parseFloat(ema.toFixed(4)) });
  }
  return result;
}

// Wilder's ATR(period) — returns array indexed by bar index, atrArr[i] = ATR through bar i.
export function computeWilderATR(bars, period = 3) {
  const n = bars.length;
  const atrArr = new Array(n).fill(null);
  if (n < period + 1) return atrArr;
  const trs = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const cur = bars[i], prev = bars[i - 1];
    trs[i] = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
  }
  let atr = 0;
  for (let i = 1; i <= period; i++) atr += trs[i];
  atr /= period;
  atrArr[period] = atr;
  for (let i = period + 1; i < n; i++) {
    atr = (atr * 2 + trs[i]) / 3;
    atrArr[i] = atr;
  }
  return atrArr;
}

export function blInitStop(twoBarLow, entryClose, atr) {
  const structural = parseFloat((twoBarLow - 0.01).toFixed(2));
  const atrBased   = atr != null ? parseFloat((entryClose - atr).toFixed(2)) : -Infinity;
  return parseFloat(Math.max(structural, atrBased).toFixed(2));
}

export function ssInitStop(twoBarHigh, entryClose, atr) {
  const structural = parseFloat((twoBarHigh + 0.01).toFixed(2));
  const atrBased   = atr != null ? parseFloat((entryClose + atr).toFixed(2)) : Infinity;
  return parseFloat(Math.min(structural, atrBased).toFixed(2));
}

// Full signal scan. Same logic as ChartModal's detectAllSignals.
// `isETF=true` uses the tighter 0.3% daylight-zone threshold (vs 1% for stocks).
// `dPctOverride` (optional) — explicit daylight % (0..1). When provided, takes
// precedence over isETF. Use 0.003 (0.3%) for DAILY signals on individual
// stocks: daily ranges are tighter than weekly so the 1% rule is too strict
// and starves chop-zone names of any signals at all.
// PNTHR AI 300 + each sector index behave like ETFs (broad baskets) on weekly,
// so pass isETF=true for those.
// `gateOffset` (default 0.10) — first-BL upper bound is `ema × (1 + gateOffset)`.
// 679 stays at 0.10 (1.10× EMA). AI mode uses 0.25 (1.25× EMA) per the AI Universe spec.
export function detectAllSignals(bars, period = 21, isETF = false, dPctOverride = null, gateOffset = 0.10) {
  if (bars.length < period + 2) return { events: [], pnthrStop: null, currentWeekStop: null, activeType: null, currentSignal: null };
  const emaData = calculateEMA(bars, period);
  const atrArr  = computeWilderATR(bars);
  const events  = [];
  let position         = null;
  let longDaylight     = 0;
  let shortDaylight    = 0;
  let longTrendActive  = false;
  let longTrendCapped  = false;
  let shortTrendActive = false;
  let shortTrendCapped = false;

  for (let wi = period + 1; wi < bars.length; wi++) {
    const emaIdx = wi - (period - 1);
    if (emaIdx < 1) continue;
    const current     = bars[wi];
    const prev1       = bars[wi - 1];
    const prev2       = bars[wi - 2];
    const emaCurrent  = emaData[emaIdx].value;
    const twoBarHigh  = Math.max(prev1.high, prev2.high);
    const twoBarLow   = Math.min(prev1.low,  prev2.low);

    longDaylight  = current.low  > emaCurrent ? longDaylight + 1 : 0;
    shortDaylight = current.high < emaCurrent ? shortDaylight + 1 : 0;

    if (position && position.entryWi !== wi) {
      const prevAtr = atrArr[wi - 1];
      if (prevAtr != null) {
        if (position.type === 'BL') {
          const structStop = parseFloat((twoBarLow - 0.01).toFixed(2));
          const atrFloor   = parseFloat((prev1.close - prevAtr).toFixed(2));
          const candidate  = Math.max(structStop, atrFloor);
          position.pnthrStop = parseFloat(Math.max(position.pnthrStop, candidate).toFixed(2));
        } else {
          const structStop = parseFloat((twoBarHigh + 0.01).toFixed(2));
          const atrCeiling = parseFloat((prev1.close + prevAtr).toFixed(2));
          const candidate  = Math.min(structStop, atrCeiling);
          position.pnthrStop = parseFloat(Math.min(position.pnthrStop, candidate).toFixed(2));
        }
      }

      if (position.type === 'BL') {
        if (current.low < twoBarLow) {
          const exitPrice    = parseFloat((twoBarLow - 0.01).toFixed(2));
          const profitDollar = parseFloat((exitPrice - position.entryPrice).toFixed(2));
          const profitPct    = parseFloat(((profitDollar / position.entryPrice) * 100).toFixed(2));
          events.push({ time: current.time, signal: 'BE', barLow: current.low, barHigh: current.high, profitDollar, profitPct });
          shortTrendActive = true;
          shortTrendCapped = true;
          position = null; continue;
        }
      } else {
        if (current.high > twoBarHigh) {
          const exitPrice    = parseFloat((twoBarHigh + 0.01).toFixed(2));
          const profitDollar = parseFloat((position.entryPrice - exitPrice).toFixed(2));
          const profitPct    = parseFloat(((profitDollar / position.entryPrice) * 100).toFixed(2));
          events.push({ time: current.time, signal: 'SE', barLow: current.low, barHigh: current.high, profitDollar, profitPct });
          longTrendActive = true;
          longTrendCapped = true;
          position = null; continue;
        }
      }
    }

    if (!position) {
      const emaPrev  = emaData[emaIdx - 1].value;
      const blPhase1 = current.close > emaCurrent && emaCurrent > emaPrev && current.high >= twoBarHigh + 0.01;
      const ssPhase1 = current.close < emaCurrent && emaCurrent < emaPrev && current.low  <= twoBarLow  - 0.01;
      const dPct = dPctOverride != null ? dPctOverride : (isETF ? 0.003 : 0.01);
      const blZone   = current.low  >= emaCurrent * (1 + dPct) && current.low  <= emaCurrent * (1 + gateOffset);
      const ssZone   = current.high <= emaCurrent * (1 - dPct) && current.high >= emaCurrent * (1 - gateOffset);

      const blReentry    = longTrendActive  && current.low  >= emaCurrent * (1 + dPct) && (!longTrendCapped  || current.low  <= emaCurrent * 1.25);
      const ssReentry    = shortTrendActive && current.high <= emaCurrent * (1 - dPct) && (!shortTrendCapped || current.high >= emaCurrent * 0.75);
      const blDaylightOk = blReentry || (blZone && longDaylight  >= 1 && longDaylight  <= 3);
      const ssDaylightOk = ssReentry || (ssZone && shortDaylight >= 1 && shortDaylight <= 3);

      if (blPhase1 && blDaylightOk) {
        const entryPrice = parseFloat((twoBarHigh + 0.01).toFixed(2));
        const initStop   = blInitStop(twoBarLow, current.close, atrArr[wi]);
        // entry = the prior 2-bar high + $0.01 = the breakout level that fired this signal
        // (the "trigger"). Carried on the event so the Ambush engine can freeze it as the
        // Weekly Trigger for the re-entry cross-check. Additive — other consumers ignore it.
        events.push({ time: current.time, signal: 'BL', barLow: current.low, barHigh: current.high, entry: entryPrice });
        position          = { type: 'BL', entryWi: wi, entryPrice, pnthrStop: initStop };
        longTrendActive   = true;
        longTrendCapped   = false;
        shortTrendActive  = false;
        shortTrendCapped  = false;
      } else if (ssPhase1 && ssDaylightOk) {
        const entryPrice = parseFloat((twoBarLow - 0.01).toFixed(2));
        const initStop   = ssInitStop(twoBarHigh, current.close, atrArr[wi]);
        // entry = the prior 2-bar low − $0.01 = the breakdown level that fired this signal.
        events.push({ time: current.time, signal: 'SS', barLow: current.low, barHigh: current.high, entry: entryPrice });
        position          = { type: 'SS', entryWi: wi, entryPrice, pnthrStop: initStop };
        shortTrendActive  = true;
        shortTrendCapped  = false;
        longTrendActive   = false;
        longTrendCapped   = false;
      }
    }
  }

  let pnthrStop = null, currentWeekStop = null, activeType = null;
  let currentSignal = events.length > 0 ? events[events.length - 1].signal : null;
  if (position) {
    const lastBar = bars[bars.length - 1];
    pnthrStop       = position.pnthrStop;
    activeType      = position.type;
    currentSignal   = position.type;
    currentWeekStop = position.type === 'BL'
      ? parseFloat((lastBar.low  - 0.01).toFixed(2))
      : parseFloat((lastBar.high + 0.01).toFixed(2));
  }

  return { events, pnthrStop, currentWeekStop, activeType, currentSignal };
}
