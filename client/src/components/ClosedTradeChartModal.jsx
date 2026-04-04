// client/src/components/ClosedTradeChartModal.jsx
// ── PNTHR Closed Trade Chart Modal ────────────────────────────────────────────
// Trade history chart with entry/exit box overlay for the Journal.
// COMPLETELY SEPARATE from ChartModal.jsx — do not merge or modify that file.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useCallback } from 'react';
import { createChart, BarSeries, LineSeries } from 'lightweight-charts';
import { fetchChartData } from '../services/api';
import { LOT_NAMES, LOT_OFFSETS } from '../utils/sizingUtils';
import { getSectorEmaPeriod } from '../utils/sectorEmaConfig';
import pantherHeadIcon from '../assets/panther head.png';

// ── Weekly aggregation (same as ChartModal) ───────────────────────────────────
function aggregateToWeekly(dailyData) {
  const sorted = [...dailyData].sort((a, b) => (a.date < b.date ? -1 : 1));
  const weeksMap = new Map();
  for (const day of sorted) {
    const date = new Date(day.date + 'T00:00:00');
    const dow = date.getDay();
    const monday = new Date(date);
    monday.setDate(date.getDate() - (dow === 0 ? 6 : dow - 1));
    const weekKey = monday.toISOString().split('T')[0];
    if (!weeksMap.has(weekKey)) {
      weeksMap.set(weekKey, { time: weekKey, open: day.open, high: day.high, low: day.low, close: day.close, volume: day.volume || 0 });
    } else {
      const w = weeksMap.get(weekKey);
      w.high = Math.max(w.high, day.high);
      w.low = Math.min(w.low, day.low);
      w.close = day.close;
      w.volume = (w.volume || 0) + (day.volume || 0);
    }
  }
  return [...weeksMap.values()];
}

// ── EMA calculation (same as ChartModal) ─────────────────────────────────────
function calculateEMA(weeklyData, period) {
  if (weeklyData.length < period) return [];
  const k = 2 / (period + 1);
  const result = [];
  let ema = weeklyData.slice(0, period).reduce((sum, d) => sum + d.close, 0) / period;
  result.push({ time: weeklyData[period - 1].time, value: parseFloat(ema.toFixed(4)) });
  for (let i = period; i < weeklyData.length; i++) {
    ema = weeklyData[i].close * k + ema * (1 - k);
    result.push({ time: weeklyData[i].time, value: parseFloat(ema.toFixed(4)) });
  }
  return result;
}

// ── Wilder ATR(3) (same as ChartModal) ───────────────────────────────────────
function computeWilderATR(weeklyData, period = 3) {
  const n = weeklyData.length;
  const atrArr = new Array(n).fill(null);
  if (n < period + 1) return atrArr;
  const trs = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const cur = weeklyData[i], prev = weeklyData[i - 1];
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

// ── Init stop helpers (same as ChartModal) ───────────────────────────────────
function blInitStop(twoWeekLow, entryClose, atr) {
  const structural = parseFloat((twoWeekLow - 0.01).toFixed(2));
  const atrBased   = atr != null ? parseFloat((entryClose - atr).toFixed(2)) : -Infinity;
  return parseFloat(Math.max(structural, atrBased).toFixed(2));
}

function ssInitStop(twoWeekHigh, entryClose, atr) {
  const structural = parseFloat((twoWeekHigh + 0.01).toFixed(2));
  const atrBased   = atr != null ? parseFloat((entryClose + atr).toFixed(2)) : Infinity;
  return parseFloat(Math.min(structural, atrBased).toFixed(2));
}

// ── Convert any date string to its Monday (week-key used by the chart) ───────
// The chart uses Monday-based ISO strings ('YYYY-MM-DD') as time keys.
// Journal fill/exit dates may land on any weekday — this snaps them to Monday
// so timeToCoordinate() can find the matching bar.
function toWeekMonday(dateStr) {
  if (!dateStr) return null;
  const date = new Date(dateStr + 'T00:00:00');
  const dow = date.getDay(); // 0=Sun, 1=Mon … 6=Sat
  const offset = dow === 0 ? 6 : dow - 1; // days back to Monday
  const monday = new Date(date);
  monday.setDate(date.getDate() - offset);
  return monday.toISOString().split('T')[0];
}

// ── Signal detection (mirrors ChartModal's detectAllSignals) ─────────────────
function detectAllSignals(weeklyData, period = 21, isETF = false) {
  if (weeklyData.length < period + 2) return { events: [], pnthrStop: null, currentWeekStop: null, activeType: null, currentSignal: null };
  const emaData = calculateEMA(weeklyData, period);
  const atrArr  = computeWilderATR(weeklyData);
  const events  = [];
  let position         = null;
  let longDaylight     = 0;
  let shortDaylight    = 0;
  let longTrendActive   = false;
  let longTrendCapped   = false;
  let shortTrendActive  = false;
  let shortTrendCapped  = false;

  for (let wi = period + 1; wi < weeklyData.length; wi++) {
    const emaIdx = wi - (period - 1);
    if (emaIdx < 1) continue;
    const current     = weeklyData[wi];
    const prev1       = weeklyData[wi - 1];
    const prev2       = weeklyData[wi - 2];
    const emaCurrent  = emaData[emaIdx].value;
    const twoWeekHigh = Math.max(prev1.high, prev2.high);
    const twoWeekLow  = Math.min(prev1.low,  prev2.low);

    longDaylight  = current.low  > emaCurrent ? longDaylight + 1 : 0;
    shortDaylight = current.high < emaCurrent ? shortDaylight + 1 : 0;

    if (position && position.entryWi !== wi) {
      const prevAtr = atrArr[wi - 1];
      if (prevAtr != null) {
        if (position.type === 'BL') {
          const structStop = parseFloat((twoWeekLow - 0.01).toFixed(2));
          const atrFloor   = parseFloat((prev1.close - prevAtr).toFixed(2));
          const candidate  = Math.max(structStop, atrFloor);
          position.pnthrStop = parseFloat(Math.max(position.pnthrStop, candidate).toFixed(2));
        } else {
          const structStop  = parseFloat((twoWeekHigh + 0.01).toFixed(2));
          const atrCeiling  = parseFloat((prev1.close + prevAtr).toFixed(2));
          const candidate   = Math.min(structStop, atrCeiling);
          position.pnthrStop = parseFloat(Math.min(position.pnthrStop, candidate).toFixed(2));
        }
      }

      if (position.type === 'BL') {
        if (current.low < twoWeekLow) {
          const exitPrice    = parseFloat((twoWeekLow - 0.01).toFixed(2));
          const profitDollar = parseFloat((exitPrice - position.entryPrice).toFixed(2));
          const profitPct    = parseFloat(((profitDollar / position.entryPrice) * 100).toFixed(2));
          events.push({ time: current.time, signal: 'BE', barLow: current.low, barHigh: current.high, profitDollar, profitPct });
          shortTrendActive = true; shortTrendCapped = true;
          position = null; continue;
        }
      } else {
        if (current.high > twoWeekHigh) {
          const exitPrice    = parseFloat((twoWeekHigh + 0.01).toFixed(2));
          const profitDollar = parseFloat((position.entryPrice - exitPrice).toFixed(2));
          const profitPct    = parseFloat(((profitDollar / position.entryPrice) * 100).toFixed(2));
          events.push({ time: current.time, signal: 'SE', barLow: current.low, barHigh: current.high, profitDollar, profitPct });
          longTrendActive = true; longTrendCapped = true;
          position = null; continue;
        }
      }
    }

    if (!position) {
      const emaPrev  = emaData[emaIdx - 1].value;
      const blPhase1 = current.close > emaCurrent && emaCurrent > emaPrev && current.high >= twoWeekHigh + 0.01;
      const ssPhase1 = current.close < emaCurrent && emaCurrent < emaPrev && current.low  <= twoWeekLow  - 0.01;
      const dPct = isETF ? 0.003 : 0.01;
      const blZone   = current.low  >= emaCurrent * (1 + dPct) && current.low  <= emaCurrent * 1.10;
      const ssZone   = current.high <= emaCurrent * (1 - dPct) && current.high >= emaCurrent * 0.90;
      const blReentry    = longTrendActive  && current.low  >= emaCurrent * (1 + dPct) && (!longTrendCapped  || current.low  <= emaCurrent * 1.25);
      const ssReentry    = shortTrendActive && current.high <= emaCurrent * (1 - dPct) && (!shortTrendCapped || current.high >= emaCurrent * 0.75);
      const blDaylightOk = blReentry || (blZone && longDaylight  >= 1 && longDaylight  <= 3);
      const ssDaylightOk = ssReentry || (ssZone && shortDaylight >= 1 && shortDaylight <= 3);

      if (blPhase1 && blDaylightOk) {
        const entryPrice = parseFloat((twoWeekHigh + 0.01).toFixed(2));
        const initStop   = blInitStop(twoWeekLow, current.close, atrArr[wi]);
        events.push({ time: current.time, signal: 'BL', barLow: current.low, barHigh: current.high });
        position = { type: 'BL', entryWi: wi, entryPrice, pnthrStop: initStop };
        longTrendActive = true; longTrendCapped = false;
        shortTrendActive = false; shortTrendCapped = false;
      } else if (ssPhase1 && ssDaylightOk) {
        const entryPrice = parseFloat((twoWeekLow - 0.01).toFixed(2));
        const initStop   = ssInitStop(twoWeekHigh, current.close, atrArr[wi]);
        events.push({ time: current.time, signal: 'SS', barLow: current.low, barHigh: current.high });
        position = { type: 'SS', entryWi: wi, entryPrice, pnthrStop: initStop };
        shortTrendActive = true; shortTrendCapped = false;
        longTrendActive = false; longTrendCapped = false;
      }
    }
  }

  let pnthrStop = null, currentWeekStop = null, activeType = null;
  let currentSignal = events.length > 0 ? events[events.length - 1].signal : null;
  if (position) {
    const lastBar = weeklyData[weeklyData.length - 1];
    pnthrStop       = position.pnthrStop;
    activeType      = position.type;
    currentSignal   = position.type;
    currentWeekStop = position.type === 'BL'
      ? parseFloat((lastBar.low  - 0.01).toFixed(2))
      : parseFloat((lastBar.high + 0.01).toFixed(2));
  }
  return { events, pnthrStop, currentWeekStop, activeType, currentSignal };
}

// ── Range filter ──────────────────────────────────────────────────────────────
function filterByRange(weeklyData, range) {
  if (range === 'all') return weeklyData;
  const months = range === '3m' ? 3 : 12;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  return weeklyData.filter(w => w.time >= cutoffStr);
}

// ── Trade stop ratchet history ────────────────────────────────────────────────
function computeTradeStops(allWeeklyBars, lot1Date, exitDate, entryStopPrice, direction) {
  if (!lot1Date || !exitDate || !entryStopPrice) return [];
  const tradeBars = allWeeklyBars.filter(b => b.time >= lot1Date && b.time <= exitDate);
  if (tradeBars.length < 2) return [];

  let currentStop = entryStopPrice;
  const result = [{ time: tradeBars[0].time, value: currentStop }];

  const trs = [];
  for (let i = 0; i < tradeBars.length; i++) {
    const bar = tradeBars[i];
    const prevClose = i > 0 ? tradeBars[i - 1].close : bar.open;
    const tr = Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - prevClose),
      Math.abs(bar.low - prevClose)
    );
    trs.push(tr);
  }

  let atr = trs.slice(0, 3).reduce((s, v) => s + v, 0) / Math.min(3, trs.length);

  for (let i = 1; i < tradeBars.length; i++) {
    atr = (atr * 2 + trs[i]) / 3;
    const bar  = tradeBars[i];
    const prev = tradeBars[i - 1];

    let candidate;
    if (direction === 'LONG') {
      const twoWeekHigh = Math.max(bar.high, prev.high);
      candidate = Math.min(twoWeekHigh - 0.01, bar.close - atr);
      currentStop = Math.max(currentStop, +(candidate.toFixed(2)));
    } else {
      const twoWeekLow = Math.min(bar.low, prev.low);
      candidate = Math.max(twoWeekLow + 0.01, bar.close + atr);
      currentStop = Math.min(currentStop, +(candidate.toFixed(2)));
    }
    result.push({ time: bar.time, value: currentStop });
  }
  return result;
}

// ── Date formatting helper ────────────────────────────────────────────────────
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d + 'T00:00:00');
  if (isNaN(dt)) return '—';
  return `${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${String(dt.getUTCDate()).padStart(2, '0')}/${dt.getUTCFullYear()}`;
}

// ── Hold time calculator ──────────────────────────────────────────────────────
function calcHoldTime(fromDate, toDate) {
  if (!fromDate || !toDate) return null;
  // Strip time component — handles both 'YYYY-MM-DD' and ISO timestamps like '2026-03-27T15:30:00.000Z'
  const from = typeof fromDate === 'string' ? fromDate.split('T')[0] : new Date(fromDate).toISOString().split('T')[0];
  const to   = typeof toDate   === 'string' ? toDate.split('T')[0]   : new Date(toDate).toISOString().split('T')[0];
  const ms = new Date(to + 'T00:00:00') - new Date(from + 'T00:00:00');
  if (ms <= 0) return null;
  const totalMins = Math.floor(ms / 60000);
  const days = Math.floor(totalMins / (60 * 24));
  const hrs  = Math.floor((totalMins % (60 * 24)) / 60);
  const mins = totalMins % 60;
  if (days > 0) return `${days}d ${hrs}h`;
  if (hrs > 0)  return `${hrs}h ${mins}m`;
  return `${mins}m`;
}

// ── Signal badge label map ────────────────────────────────────────────────────
const SIGNAL_LABELS = { BL: 'BL+1', SS: 'SS+1', BE: 'BE', SE: 'SE' };
const SIGNAL_COLORS = {
  BL: { bg: '#16a34a', text: '#fff' },
  SS: { bg: '#dc2626', text: '#fff' },
  BE: { bg: '#dc2626', text: '#fff' },
  SE: { bg: '#16a34a', text: '#fff' },
};

// ── Main component ────────────────────────────────────────────────────────────
export default function ClosedTradeChartModal({ entry: initialEntry, allEntries, onClose }) {
  // Sort allEntries newest-first (same as ClosedTradeCards)
  const sortedEntries = [...(allEntries || [])].sort((a, b) => {
    const aDate = a.exits?.[a.exits.length - 1]?.date || a.createdAt;
    const bDate = b.exits?.[b.exits.length - 1]?.date || b.createdAt;
    return new Date(bDate) - new Date(aDate);
  });

  const initialIdx = sortedEntries.findIndex(e =>
    e._id?.toString() === initialEntry?._id?.toString()
  );
  const [currentIdx, setCurrentIdx] = useState(initialIdx >= 0 ? initialIdx : 0);
  const entry = sortedEntries[currentIdx] || initialEntry;

  const [range, setRange] = useState('12m');
  const [allWeeklyData, setAllWeeklyData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [signalMarkers, setSignalMarkers] = useState([]);
  const [pantherMarkerPos, setPantherMarkerPos] = useState(null);
  const [hoveredBar, setHoveredBar] = useState(null);
  const [tradeBoxStyle, setTradeBoxStyle] = useState(null);
  const [innerBoxStyles, setInnerBoxStyles] = useState([]);
  const [stopLineStyle, setStopLineStyle] = useState(null);

  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const cacheRef = useRef({});
  const destroyedRef = useRef(false);

  // ── Derived trade data ────────────────────────────────────────────────────
  const lots = Array.isArray(entry?.lots) ? entry.lots : [];
  const exits = Array.isArray(entry?.exits) ? entry.exits : [];
  const lot1 = lots[0];
  const lastExit = exits[exits.length - 1];
  const isWin = (entry?.performance?.realizedPnlDollar || 0) > 0;
  const isLong = entry?.direction === 'LONG';
  const lot1Price = +(lot1?.price || 0);
  const finalExitPrice = +(lastExit?.price || entry?.performance?.avgExitPrice || 0);
  const entryStopPrice = +(entry?.entry?.stopPrice || 0);
  const lot1Date = lot1?.date || null;  // 'YYYY-MM-DD'
  const exitDate = lastExit?.date || null; // 'YYYY-MM-DD'
  const sigType = entry?.entry?.signalType || (isLong ? 'BL' : 'SS');

  const topPrice = lot1Price && finalExitPrice ? Math.max(lot1Price, finalExitPrice) : null;
  const bottomPrice = lot1Price && finalExitPrice ? Math.min(lot1Price, finalExitPrice) : null;

  // Show entry stop dashed line when: LONG loss exit above stop, or SHORT loss exit below stop
  const showEarlyExitStop = entryStopPrice > 0 && lot1Price > 0 && finalExitPrice > 0 && (
    (isLong && !isWin && finalExitPrice > entryStopPrice) ||
    (!isLong && !isWin && finalExitPrice < entryStopPrice)
  );

  // Lot triggers from Lot 1 actual price
  const lotTriggers = [0, 0.03, 0.06, 0.10, 0.14].map((offset) => {
    if (!lot1Price) return 0;
    return isLong
      ? +(lot1Price * (1 + offset)).toFixed(2)
      : +(lot1Price * (1 - offset)).toFixed(2);
  });

  // ── Fetch chart data when entry changes ──────────────────────────────────
  useEffect(() => {
    if (!entry?.ticker) return;
    const ticker = entry.ticker;
    setLoading(true);
    setError(null);
    setAllWeeklyData([]);
    setSignalMarkers([]);
    setPantherMarkerPos(null);
    setTradeBoxStyle(null);
    setInnerBoxStyles([]);
    setStopLineStyle(null);

    if (cacheRef.current[ticker]) {
      setAllWeeklyData(cacheRef.current[ticker]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    fetchChartData(ticker)
      .then(daily => {
        if (cancelled) return;
        const weekly = aggregateToWeekly(daily);
        cacheRef.current[ticker] = weekly;
        setAllWeeklyData(weekly);
        if (weekly.length === 0) setError('No chart data available.');
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load chart data.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [entry?.ticker]);

  // ── Build/rebuild chart when data or range changes ────────────────────────
  useEffect(() => {
    if (loading || !chartContainerRef.current || allWeeklyData.length === 0) return;

    destroyedRef.current = false;
    setHoveredBar(null);
    setSignalMarkers([]);
    setPantherMarkerPos(null);
    setTradeBoxStyle(null);
    setInnerBoxStyles([]);
    setStopLineStyle(null);

    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
      seriesRef.current = null;
    }

    const filtered = filterByRange(allWeeklyData, range);
    if (filtered.length === 0) return;

    const chart = createChart(chartContainerRef.current, {
      autoSize: true,
      layout: { background: { color: '#ffffff' }, textColor: '#212121', attributionLogo: false },
      grid: { vertLines: { color: '#f0f0f0' }, horzLines: { color: '#f0f0f0' } },
      rightPriceScale: { borderColor: '#d4d4d4' },
      timeScale: { borderColor: '#d4d4d4', timeVisible: false },
      crosshair: { mode: 1 },
    });
    chartRef.current = chart;

    // Wider bar spacing for trade chart
    chart.timeScale().applyOptions({ barSpacing: 10 });

    const series = chart.addSeries(BarSeries, {
      upColor: '#16a34a',
      downColor: '#dc2626',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    series.setData(filtered);
    seriesRef.current = series;

    const filteredTimes = new Set(filtered.map(d => d.time));

    // OHLC tooltip on crosshair hover
    chart.subscribeCrosshairMove(param => {
      if (destroyedRef.current) return;
      if (!param.time || !param.point || !param.seriesData?.get(series)) {
        setHoveredBar(null);
        return;
      }
      const data = param.seriesData.get(series);
      setHoveredBar({
        x: param.point.x,
        y: param.point.y,
        time: param.time,
        open: data.open,
        high: data.high,
        low: data.low,
        close: data.close,
      });
    });

    // Sector-specific EMA
    const emaPeriod = getSectorEmaPeriod(entry?.sector);
    const ema21Full = calculateEMA(allWeeklyData, emaPeriod);
    if (ema21Full.length > 0) {
      const ema21 = ema21Full.filter(d => filteredTimes.has(d.time));
      if (ema21.length > 0) {
        const emaSeries = chart.addSeries(LineSeries, {
          color: '#2563eb',
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        emaSeries.setData(ema21);
      }
    }

    // Signal detection for BL/SS/BE/SE badges
    const { events: allDetected } = detectAllSignals(allWeeklyData, emaPeriod, false);
    const lastEntryIdx = (() => { for (let i = allDetected.length - 1; i >= 0; i--) { if (allDetected[i].signal === 'BL' || allDetected[i].signal === 'SS') return i; } return -1; })();
    const lastEntry  = lastEntryIdx >= 0 ? allDetected[lastEntryIdx] : null;
    const exitEvent  = lastEntry ? allDetected.slice(lastEntryIdx + 1).find(e => e.signal === 'BE' || e.signal === 'SE') : null;
    const allSignalEvents = [lastEntry, exitEvent].filter(ev => ev && filteredTimes.has(ev.time));

    if (allSignalEvents.length > 0) {
      const BADGE_H = 22;
      const updateAllMarkers = () => {
        if (destroyedRef.current) return;
        try {
          const positions = [];
          for (const ev of allSignalEvents) {
            const x = chart.timeScale().timeToCoordinate(ev.time);
            const belowBar = ev.signal === 'BL' || ev.signal === 'SE';
            const price = belowBar ? ev.barLow * 0.98 : ev.barHigh * 1.02;
            const y = series.priceToCoordinate(price);
            if (x != null && y != null) {
              positions.push({
                signal: ev.signal,
                left: Math.round(x),
                top: belowBar ? Math.round(y) : Math.round(y) - BADGE_H,
                profitDollar: ev.profitDollar ?? null,
                profitPct:    ev.profitPct    ?? null,
              });
            }
          }
          setSignalMarkers(positions);
        } catch { /* chart destroyed mid-callback */ }
      };
      chart.timeScale().subscribeVisibleTimeRangeChange(updateAllMarkers);
      setTimeout(updateAllMarkers, 50);
    }

    // PNTHR head icon — float at lot1 fill date on chart (same approach as ChartModal)
    if (lot1Date && filteredTimes.has(lot1Date)) {
      const barData = filtered.find(d => d.time === lot1Date);
      if (barData) {
        const ICON = 24;
        const updatePantherPos = () => {
          if (destroyedRef.current) return;
          try {
            const x = chart.timeScale().timeToCoordinate(lot1Date);
            const price = isLong ? barData.low : barData.high;
            const y = series.priceToCoordinate(price);
            if (x != null && y != null) {
              setPantherMarkerPos({
                left: Math.round(x) - ICON / 2,
                top: isLong ? Math.round(y) + 28 : Math.round(y) - ICON - 28,
                list: isLong ? 'LONG' : 'SHORT',
              });
            }
          } catch { /* chart destroyed mid-callback */ }
        };
        chart.timeScale().subscribeVisibleTimeRangeChange(updatePantherPos);
        setTimeout(updatePantherPos, 50);
      }
    }

    // Trade stop ratchet history as amber dashed LineSeries
    if (lot1Date && exitDate && entryStopPrice) {
      const stopData = computeTradeStops(allWeeklyData, lot1Date, exitDate, entryStopPrice, entry.direction);
      if (stopData.length > 0) {
        const validStopData = stopData.filter(d => filteredTimes.has(d.time));
        if (validStopData.length > 0) {
          const stopSeries = chart.addSeries(LineSeries, {
            color: '#ca8a04',
            lineWidth: 2,
            lineStyle: 2,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          });
          stopSeries.setData(validStopData);
        }
      }
    }

    // ── Trade box overlay — subscribe to time range changes ──────────────
    const updateTradeBox = () => {
      if (destroyedRef.current || !chartRef.current || !seriesRef.current) return;
      if (!lot1Date || !exitDate || topPrice == null || bottomPrice == null) return;
      try {
        const c = chartRef.current;
        const s = seriesRef.current;
        // Snap dates to Monday (chart uses Monday-based week keys)
        const lot1Monday = toWeekMonday(lot1Date);
        const exitMonday = toWeekMonday(exitDate);
        const x1 = c.timeScale().timeToCoordinate(lot1Monday);
        // If same week, find the NEXT week's coordinate for a 1-bar wide box
        let x2;
        if (lot1Monday === exitMonday) {
          const nextWeekBar = allWeeklyData.find(b => b.time > lot1Monday);
          x2 = nextWeekBar
            ? c.timeScale().timeToCoordinate(nextWeekBar.time)
            : (x1 != null ? x1 + 12 : null);
        } else {
          x2 = c.timeScale().timeToCoordinate(exitMonday);
        }
        const yTop = s.priceToCoordinate(topPrice);
        const yBot = s.priceToCoordinate(bottomPrice);
        if (x1 == null || x2 == null || yTop == null || yBot == null) {
          setTradeBoxStyle(null);
          return;
        }
        const left = Math.round(x1);
        const width = Math.round(x2 - x1);
        if (width <= 0) { setTradeBoxStyle(null); return; }
        setTradeBoxStyle({
          left,
          top: Math.round(yTop),
          width,
          height: Math.round(yBot - yTop),
        });

        // Inner boxes for additional filled lots
        const innerBoxes = [];
        for (let i = 1; i < lots.length; i++) {
          const lotN = lots[i];
          if (!lotN?.price || !lotN?.date) continue;
          const xN = c.timeScale().timeToCoordinate(toWeekMonday(lotN.date));
          const topN = isLong
            ? Math.max(+lotN.price, finalExitPrice)
            : Math.min(+lotN.price, finalExitPrice);
          const botN = isLong
            ? Math.min(+lotN.price, finalExitPrice)
            : Math.max(+lotN.price, finalExitPrice);
          const yTopN = s.priceToCoordinate(topN);
          const yBotN = s.priceToCoordinate(botN);
          if (xN == null || yTopN == null || yBotN == null) continue;
          const wN = Math.round(x2 - xN);
          if (wN <= 0) continue;
          innerBoxes.push({
            left: Math.round(xN),
            top: Math.round(yTopN),
            width: wN,
            height: Math.round(yBotN - yTopN),
          });
        }
        setInnerBoxStyles(innerBoxes);

        // Early exit stop line
        if (showEarlyExitStop) {
          const ySL = s.priceToCoordinate(entryStopPrice);
          if (ySL != null) {
            setStopLineStyle({ left, top: Math.round(ySL), width });
          } else {
            setStopLineStyle(null);
          }
        } else {
          setStopLineStyle(null);
        }
      } catch { /* chart destroyed mid-callback */ }
    };

    chart.timeScale().subscribeVisibleTimeRangeChange(updateTradeBox);
    // Fire at multiple points: fitContent() triggers the subscription, but
    // priceToCoordinate may still return null until the price scale is laid out.
    // Additional delayed calls ensure the box appears even on slow mounts.
    setTimeout(updateTradeBox, 150);
    setTimeout(updateTradeBox, 500);

    chart.timeScale().fitContent();

    return () => {
      destroyedRef.current = true;
      setHoveredBar(null);
      setSignalMarkers([]);
      setPantherMarkerPos(null);
      setTradeBoxStyle(null);
      setInnerBoxStyles([]);
      setStopLineStyle(null);
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
        seriesRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allWeeklyData, range, loading]);

  // ── Keyboard navigation ───────────────────────────────────────────────────
  useEffect(() => {
    function handleKey(e) {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') setCurrentIdx(i => Math.max(0, i - 1));
      if (e.key === 'ArrowRight') setCurrentIdx(i => Math.min(sortedEntries.length - 1, i + 1));
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose, sortedEntries.length]);

  // ── Reset range when entry changes ────────────────────────────────────────
  useEffect(() => {
    setRange('12m');
  }, [currentIdx]);

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) onClose();
  }

  // ── Current price from last candle ────────────────────────────────────────
  const lastBar = allWeeklyData.length > 0 ? allWeeklyData[allWeeklyData.length - 1] : null;
  const currentPrice = lastBar?.close ?? null;

  // ── Chart container width for data panel visibility ───────────────────────
  const containerRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(600);
  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect?.width;
      if (w) setContainerWidth(w);
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  const showDataPanel = containerWidth >= 400;

  return (
    <div
      onClick={handleBackdropClick}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div style={{
        position: 'relative', width: '90vw', maxWidth: 1100, height: '85vh',
        background: '#fff', borderRadius: 10, overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
      }}>
        {/* ── Header ── */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 14px', borderBottom: '1px solid #e0e0e0',
          background: '#fafafa', flexShrink: 0, flexWrap: 'wrap', gap: 8,
        }}>
          {/* Left: ticker + meta */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: '1.15rem', color: '#111' }}>
              {entry?.ticker}
            </span>
            {entry?.companyName && (
              <span style={{ fontSize: '0.8rem', color: '#555', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {entry.companyName}
              </span>
            )}
            {entry?.sector && (
              <span style={{ background: '#f3f4f6', border: '1px solid #d1d5db', color: '#374151', padding: '1px 7px', borderRadius: 4, fontSize: '0.72rem', fontWeight: 600 }}>
                {entry.sector}
              </span>
            )}
            {entry?.exchange && (
              <span style={{ background: '#f3f4f6', border: '1px solid #d1d5db', color: '#6b7280', padding: '1px 7px', borderRadius: 4, fontSize: '0.7rem' }}>
                {entry.exchange}
              </span>
            )}
            {currentPrice != null && (
              <span style={{ fontWeight: 600, fontSize: '0.9rem', color: '#111' }}>
                ${currentPrice.toFixed(2)}
              </span>
            )}
          </div>
          {/* Right: range toggles + close */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {['3m', '12m', 'all'].map(r => (
              <button
                key={r}
                onClick={() => setRange(r)}
                style={{
                  padding: '3px 10px', borderRadius: 4, fontSize: '0.75rem',
                  fontWeight: range === r ? 700 : 400,
                  background: range === r ? '#111' : '#f3f4f6',
                  color: range === r ? '#FFD700' : '#555',
                  border: range === r ? '1px solid #111' : '1px solid #d1d5db',
                  cursor: 'pointer',
                }}
              >
                {r.toUpperCase()}
              </button>
            ))}
            <button
              onClick={onClose}
              style={{
                marginLeft: 4, background: 'none', border: 'none',
                fontSize: '1.3rem', cursor: 'pointer', color: '#555', lineHeight: 1,
              }}
              title="Close"
            >
              ✕
            </button>
          </div>
        </div>

        {/* ── Chart area ── */}
        <div ref={containerRef} style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
          {/* Chart canvas */}
          <div ref={chartContainerRef} style={{ width: '100%', height: '100%' }} />

          {/* Loading / error states */}
          {loading && (
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
              justifyContent: 'center', background: 'rgba(255,255,255,0.85)', fontSize: 13, color: '#555',
            }}>
              Loading chart…
            </div>
          )}
          {error && !loading && (
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
              justifyContent: 'center', background: 'rgba(255,255,255,0.9)', fontSize: 13, color: '#dc3545',
            }}>
              {error}
            </div>
          )}

          {/* Trade box overlay */}
          {tradeBoxStyle && (
            <div style={{
              position: 'absolute',
              pointerEvents: 'none',
              left: tradeBoxStyle.left,
              top: tradeBoxStyle.top,
              width: tradeBoxStyle.width,
              height: tradeBoxStyle.height,
              background: isWin ? 'rgba(40,167,69,0.15)' : 'rgba(220,53,69,0.15)',
              border: `1px solid ${isWin ? '#28a745' : '#dc3545'}`,
              zIndex: 2,
            }} />
          )}

          {/* Inner boxes for additional lot fills */}
          {innerBoxStyles.map((box, i) => (
            <div key={i} style={{
              position: 'absolute',
              pointerEvents: 'none',
              left: box.left,
              top: box.top,
              width: box.width,
              height: box.height,
              background: isWin ? 'rgba(40,167,69,0.10)' : 'rgba(220,53,69,0.10)',
              border: `1px solid ${isWin ? 'rgba(40,167,69,0.4)' : 'rgba(220,53,69,0.4)'}`,
              zIndex: 2,
            }} />
          ))}

          {/* Manual early exit stop line */}
          {stopLineStyle && (
            <div style={{
              position: 'absolute',
              pointerEvents: 'none',
              left: stopLineStyle.left,
              top: stopLineStyle.top,
              width: stopLineStyle.width,
              height: 2,
              borderTop: '2px dashed #ca8a04',
              zIndex: 3,
            }} />
          )}

          {/* Signal badges (BL/SS/BE/SE) */}
          {signalMarkers.map((m, i) => {
            const col = SIGNAL_COLORS[m.signal] || { bg: '#555', text: '#fff' };
            const label = SIGNAL_LABELS[m.signal] || m.signal;
            return (
              <div key={i} style={{
                position: 'absolute',
                left: m.left - 18,
                top: m.top,
                background: col.bg,
                color: col.text,
                fontSize: 10,
                fontWeight: 700,
                padding: '2px 5px',
                borderRadius: 3,
                pointerEvents: 'none',
                zIndex: 4,
                whiteSpace: 'nowrap',
              }}>
                {label}
                {m.profitPct != null && (
                  <span style={{ marginLeft: 3, opacity: 0.85 }}>
                    {m.profitPct >= 0 ? '+' : ''}{m.profitPct.toFixed(1)}%
                  </span>
                )}
              </div>
            );
          })}

          {/* PNTHR head marker */}
          {pantherMarkerPos && (
            <img
              src={pantherHeadIcon}
              alt="PNTHR"
              style={{
                position: 'absolute',
                left: pantherMarkerPos.left,
                top: pantherMarkerPos.top,
                width: 24,
                height: 24,
                pointerEvents: 'none',
                zIndex: 5,
                filter: pantherMarkerPos.list === 'SHORT' ? 'hue-rotate(300deg)' : 'none',
              }}
            />
          )}

          {/* OHLC tooltip */}
          {hoveredBar && (
            <div style={{
              position: 'absolute',
              left: Math.min(hoveredBar.x + 10, containerWidth - 130),
              top: Math.max(hoveredBar.y - 70, 4),
              background: 'rgba(0,0,0,0.75)',
              color: '#eee',
              fontSize: 11,
              padding: '5px 8px',
              borderRadius: 4,
              pointerEvents: 'none',
              zIndex: 10,
              lineHeight: 1.5,
            }}>
              <div style={{ color: '#FFD700', fontWeight: 700, marginBottom: 2 }}>{hoveredBar.time}</div>
              <div>O: <b>{hoveredBar.open?.toFixed(2)}</b></div>
              <div>H: <b style={{ color: '#16a34a' }}>{hoveredBar.high?.toFixed(2)}</b></div>
              <div>L: <b style={{ color: '#dc2626' }}>{hoveredBar.low?.toFixed(2)}</b></div>
              <div>C: <b>{hoveredBar.close?.toFixed(2)}</b></div>
            </div>
          )}

          {/* Data panel (upper-left) */}
          {showDataPanel && lot1Price > 0 && (() => {
            // ── Summary data ──────────────────────────────────────────────
            const avgExitPx    = entry?.performance?.avgExitPrice || finalExitPrice || 0;
            const totalExitShr = exits.reduce((s, e) => s + (+e.shares || 0), 0) || lot1?.shares || 0;
            const pnlDollar    = entry?.performance?.realizedPnlDollar ?? null;
            const pnlPct       = entry?.performance?.realizedPnlPct   ?? null;
            const pnlColor     = pnlDollar == null ? '#aaa' : pnlDollar >= 0 ? '#6bcb77' : '#ff6b6b';
            // Entry / exit action labels
            const entryAction  = isLong ? 'BUY LONG'  : 'SELL SHORT';
            const exitAction   = isLong ? 'BUY EXIT'  : 'SELL EXIT';
            return (
            <div style={{
              position: 'absolute', left: 8, top: 8, zIndex: 10,
              background: 'rgba(0,0,0,0.80)', border: '1px solid #444',
              borderRadius: 6, padding: '8px 12px', minWidth: 210, maxWidth: 250,
              pointerEvents: 'none', fontSize: 11, color: '#ccc',
            }}>
              {/* Signal + date */}
              <div style={{ color: '#FFD700', fontWeight: 700, marginBottom: 6, fontSize: 12 }}>
                {sigType}+1 &nbsp; {fmtDate(lot1?.date)}
              </div>

              {/* ── Trade summary ── */}
              <div style={{ marginBottom: 2 }}>
                <span style={{ color: '#aaa', fontSize: 10, fontWeight: 700, letterSpacing: '0.05em' }}>
                  {entryAction}
                </span>
                <span style={{ color: '#fff', fontWeight: 700, marginLeft: 6 }}>
                  ${lot1Price.toFixed(2)}
                </span>
                <span style={{ color: '#aaa' }}> × {lot1?.shares} shr</span>
              </div>
              <div style={{ marginBottom: 4 }}>
                <span style={{ color: '#aaa', fontSize: 10, fontWeight: 700, letterSpacing: '0.05em' }}>
                  {exitAction}
                </span>
                <span style={{ color: '#fff', fontWeight: 700, marginLeft: 6 }}>
                  ${avgExitPx > 0 ? avgExitPx.toFixed(2) : '—'}
                </span>
                {totalExitShr > 0 && <span style={{ color: '#aaa' }}> × {totalExitShr} shr</span>}
              </div>
              {/* Net result */}
              <div style={{ color: pnlColor, fontWeight: 700, fontSize: 12, marginBottom: 6 }}>
                {pnlDollar == null ? '—' : (
                  <>
                    {pnlDollar >= 0 ? '+' : ''}${Math.abs(pnlDollar).toFixed(2)}
                    {pnlPct != null && (
                      <span style={{ fontWeight: 400, fontSize: 10, marginLeft: 6 }}>
                        ({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%)
                      </span>
                    )}
                  </>
                )}
              </div>

              <div style={{ borderTop: '1px solid #333', marginBottom: 6 }} />

              {/* Each lot */}
              {[0, 1, 2, 3, 4].map(i => {
                const lot = lots[i];
                const trigger = lotTriggers[i];
                const name = LOT_NAMES[i];
                if (i === 0 && !lot?.price) return null;
                if (i > 0 && !lot?.price && !trigger) return null;
                const filled = !!lot?.price;
                const slippage = filled && i > 0 ? +(lot.price - trigger).toFixed(2) : null;
                const slippageBad = isLong ? (slippage != null && slippage > 0) : (slippage != null && slippage < 0);
                return (
                  <div key={i} style={{ marginBottom: 6, opacity: filled ? 1 : 0.45 }}>
                    <div style={{ color: '#FFD700', fontWeight: 700, fontSize: 10, letterSpacing: '0.04em' }}>
                      {`LOT ${i + 1} — ${name}`}
                    </div>
                    {i === 0 ? (
                      <div style={{ color: '#fff' }}>
                        ${lot.price} × {lot.shares} shr
                        <span style={{ color: '#aaa' }}> &nbsp; {fmtDate(lot.date)}</span>
                      </div>
                    ) : (
                      <>
                        <div style={{ color: '#aaa' }}>Rec: <span style={{ color: '#ddd' }}>${trigger}</span></div>
                        {filled ? (
                          <>
                            <div style={{ color: '#fff' }}>
                              Fill: ${lot.price} &nbsp;
                              {slippage != null && (
                                <span style={{ color: slippageBad ? '#ff6b6b' : '#6bcb77', fontWeight: 700 }}>
                                  ({slippage >= 0 ? '+' : ''}${Math.abs(slippage).toFixed(2)})
                                </span>
                              )}
                            </div>
                            <div style={{ color: '#aaa' }}>
                              {lot.shares} shr &nbsp; {fmtDate(lot.date)} &nbsp;
                              <span style={{ color: '#FFD700' }}>{sigType}+{i + 1}</span>
                            </div>
                          </>
                        ) : (
                          <div style={{ color: '#666' }}>— not filled</div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}

              <div style={{ borderTop: '1px solid #333', margin: '6px 0' }} />

              {/* Kill data at entry */}
              {entry?.entry?.killScore != null && (
                <div style={{ marginBottom: 5 }}>
                  <span style={{ color: '#aaa' }}>KILL </span>
                  <span style={{ color: '#FFD700', fontWeight: 700 }}>{entry.entry.killScore}</span>
                  <span style={{ color: '#aaa' }}> &nbsp; RANK </span>
                  <span style={{ color: '#fff', fontWeight: 700 }}>#{entry.entry.killRank}</span>
                  {entry.entry.killTier && (
                    <div style={{ color: '#bbb', fontSize: 10, marginTop: 1 }}>{entry.entry.killTier}</div>
                  )}
                </div>
              )}

              {/* Entry stop price */}
              {entryStopPrice > 0 && (
                <div style={{ marginBottom: 5 }}>
                  <span style={{ color: '#aaa' }}>ENTRY STOP </span>
                  <span style={{ color: '#ff6b6b', fontWeight: 700 }}>${entryStopPrice.toFixed(2)}</span>
                </div>
              )}

              {/* Hold time — try multiple date sources since exit.date may be null */}
              <div style={{ marginBottom: 4 }}>
                <span style={{ color: '#aaa' }}>HOLD </span>
                <span style={{ color: '#fff' }}>
                  {calcHoldTime(
                    lot1?.date,
                    lastExit?.date || entry?.closedAt || entry?.performance?.closedAt
                  ) || '—'}
                </span>
              </div>

              {/* Notes */}
              {(entry?.tradeNotes || entry?.macroNotes) && (
                <>
                  <div style={{ borderTop: '1px solid #333', margin: '4px 0' }} />
                  <div style={{ color: '#bbb', fontSize: 10, fontStyle: 'italic', maxWidth: 220, wordBreak: 'break-word', lineHeight: 1.4 }}>
                    {entry.tradeNotes || entry.macroNotes}
                  </div>
                </>
              )}
            </div>
            );
          })()}
        </div>

        {/* ── Navigation footer ── */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: 16, padding: '8px 16px', borderTop: '1px solid #e0e0e0',
          background: '#fafafa', flexShrink: 0,
        }}>
          <button
            onClick={() => setCurrentIdx(i => Math.max(0, i - 1))}
            disabled={currentIdx === 0}
            style={{
              padding: '4px 14px', borderRadius: 4, border: '1px solid #d1d5db',
              background: currentIdx === 0 ? '#f3f4f6' : '#111',
              color: currentIdx === 0 ? '#aaa' : '#FFD700',
              cursor: currentIdx === 0 ? 'default' : 'pointer', fontWeight: 700, fontSize: 13,
            }}
          >
            ← Prev
          </button>
          <span style={{ fontSize: 12, color: '#666' }}>
            {currentIdx + 1} / {sortedEntries.length}
          </span>
          <button
            onClick={() => setCurrentIdx(i => Math.min(sortedEntries.length - 1, i + 1))}
            disabled={currentIdx === sortedEntries.length - 1}
            style={{
              padding: '4px 14px', borderRadius: 4, border: '1px solid #d1d5db',
              background: currentIdx === sortedEntries.length - 1 ? '#f3f4f6' : '#111',
              color: currentIdx === sortedEntries.length - 1 ? '#aaa' : '#FFD700',
              cursor: currentIdx === sortedEntries.length - 1 ? 'default' : 'pointer', fontWeight: 700, fontSize: 13,
            }}
          >
            Next →
          </button>
        </div>
      </div>
    </div>
  );
}
