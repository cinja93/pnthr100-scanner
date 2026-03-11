import { useState, useEffect, useRef } from 'react';
import { createChart, BarSeries, LineSeries } from 'lightweight-charts';
import { fetchChartData, fetchEntryDates, fetchWatchlist, addWatchlistTicker, removeWatchlistTicker } from '../services/api';
import styles from './ChartModal.module.css';
import pantherHeadIcon from '../assets/panther head.png';


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
      weeksMap.set(weekKey, { time: weekKey, open: day.open, high: day.high, low: day.low, close: day.close });
    } else {
      const w = weeksMap.get(weekKey);
      w.high = Math.max(w.high, day.high);
      w.low = Math.min(w.low, day.low);
      w.close = day.close;
    }
  }
  return [...weeksMap.values()];
}

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

// Wilder's ATR(period) over weekly bars.
// Returns array indexed by bar index; atrArr[i] = ATR through bar i (null until seeded).
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

function longPredStop(low, price) {
  const buf = price * 0.001;
  return parseFloat((buf > 0.01 ? low + buf : low - 0.01).toFixed(2));
}

function shortPredStop(high, price) {
  const buf = price * 0.001;
  return parseFloat((buf > 0.01 ? high - buf : high + 0.01).toFixed(2));
}

// Scan full weekly history; returns events: BL/SS entries + BE/SE exits.
//
// BL (Launch): weekLow is 1–10% above 21-EMA, within first 3 bars of long-daylight streak
//              (current or previous bar is the 1st or 2nd bar where low > EMA).
// SS (Failure): weekHigh is 1–10% below 21-EMA, within first 3 bars of short-daylight streak.
// Phase 5 exit: structural 2-week low/high + 0.1% predatory buffer, trigger on weekly close.
// Returns { events, pnthrStop, currentWeekStop, activeType } where stop fields are
// non-null only when the most recent BL/SS signal is still open (no following BE/SE).
function detectAllSignals(weeklyData, period = 21) {
  if (weeklyData.length < period + 2) return { events: [], pnthrStop: null, currentWeekStop: null, activeType: null };
  const emaData = calculateEMA(weeklyData, period);
  const atrArr  = computeWilderATR(weeklyData);
  const events  = [];
  let position         = null;  // { type, entryWi, entryPrice, pnthrStop }
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

    // Past entry week: update PNTHR stop (ratchet), then check for BE/SE exit
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
          shortTrendActive = true;
          shortTrendCapped = true;
          position = null; continue;
        }
      } else {
        if (current.high > twoWeekHigh) {
          const exitPrice    = parseFloat((twoWeekHigh + 0.01).toFixed(2));
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
      const blPhase1 = current.close > emaCurrent && emaCurrent > emaPrev && current.high >= twoWeekHigh + 0.01;
      const ssPhase1 = current.close < emaCurrent && emaCurrent < emaPrev && current.low  <= twoWeekLow  - 0.01;
      const blZone   = current.low  >= emaCurrent * 1.01 && current.low  <= emaCurrent * 1.10;
      const ssZone   = current.high <= emaCurrent * 0.99 && current.high >= emaCurrent * 0.90;

      const blReentry    = longTrendActive  && current.low  >= emaCurrent * 1.01 && (!longTrendCapped  || current.low  <= emaCurrent * 1.25);
      const ssReentry    = shortTrendActive && current.high <= emaCurrent * 0.99 && (!shortTrendCapped || current.high >= emaCurrent * 0.75);
      const blDaylightOk = blReentry || (blZone && longDaylight  >= 1 && longDaylight  <= 3);
      const ssDaylightOk = ssReentry || (ssZone && shortDaylight >= 1 && shortDaylight <= 3);

      if (blPhase1 && blDaylightOk) {
        const entryPrice = parseFloat((twoWeekHigh + 0.01).toFixed(2));
        const initStop   = longPredStop(current.low, current.close);
        events.push({ time: current.time, signal: 'BL', barLow: current.low, barHigh: current.high });
        position          = { type: 'BL', entryWi: wi, entryPrice, pnthrStop: initStop };
        longTrendActive   = true;
        longTrendCapped   = false;
        shortTrendActive  = false;
        shortTrendCapped  = false;
      } else if (ssPhase1 && ssDaylightOk) {
        const entryPrice = parseFloat((twoWeekLow - 0.01).toFixed(2));
        const initStop   = shortPredStop(current.high, current.close);
        events.push({ time: current.time, signal: 'SS', barLow: current.low, barHigh: current.high });
        position          = { type: 'SS', entryWi: wi, entryPrice, pnthrStop: initStop };
        shortTrendActive  = true;
        shortTrendCapped  = false;
        longTrendActive   = false;
        longTrendCapped   = false;
      }
    }
  }

  // Compute live stops and current signal from client data (always up-to-date)
  let pnthrStop = null, currentWeekStop = null, activeType = null;
  let currentSignal = events.length > 0 ? events[events.length - 1].signal : null;
  if (position) {
    const lastBar = weeklyData[weeklyData.length - 1];
    pnthrStop       = position.pnthrStop;
    activeType      = position.type;
    currentSignal   = position.type; // 'BL' or 'SS' (open position)
    currentWeekStop = position.type === 'BL'
      ? parseFloat((lastBar.low  - 0.01).toFixed(2))
      : parseFloat((lastBar.high + 0.01).toFixed(2));
  }

  return { events, pnthrStop, currentWeekStop, activeType, currentSignal };
}

// Count n trading days (Mon–Fri) before a date string, returning the start date string
function nTradingDaysBefore(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  let count = 0;
  while (count < n) {
    d.setDate(d.getDate() - 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return d.toISOString().split('T')[0];
}

function filterByRange(weeklyData, range) {
  if (range === 'all') return weeklyData;
  const months = range === '3m' ? 3 : 12;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  return weeklyData.filter(w => w.time >= cutoffStr);
}

function formatWeekDate(timeStr) {
  if (!timeStr) return '';
  const date = new Date(timeStr + 'T00:00:00');
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function ChartModal({ stocks, initialIndex, earnings = {}, onClose, onWatchlistChange }) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [range, setRange] = useState('12m');
  const [allWeeklyData, setAllWeeklyData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hoveredBar, setHoveredBar] = useState(null);
  const [hoveredMarkerProfit, setHoveredMarkerProfit] = useState(null);
  const [pnthrStop, setPnthrStop] = useState(null);
  const [currentWeekStop, setCurrentWeekStop] = useState(null);
  const [currentSignal, setCurrentSignal] = useState(null);
  const [signalMarkers, setSignalMarkers] = useState([]);
  const [pantherMarkerPos, setPantherMarkerPos] = useState(null);
  const [entryDatesLoaded, setEntryDatesLoaded] = useState(false);
  const [watchlistSet, setWatchlistSet] = useState(new Set());
  const [watchlistSaving, setWatchlistSaving] = useState(false);
  const [inEarningsWindow, setInEarningsWindow] = useState(false);
  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);
  const cacheRef = useRef({});
  const entryDatesRef = useRef({});

  const stock = stocks[currentIndex];
  const inWatchlist = stock ? watchlistSet.has(stock.ticker) : false;

  // Fetch data when stock changes
  useEffect(() => {
    if (!stock) return;
    const ticker = stock.ticker;
    if (cacheRef.current[ticker]) {
      setAllWeeklyData(cacheRef.current[ticker]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setAllWeeklyData([]);
    fetchChartData(ticker)
      .then(daily => {
        if (cancelled) return;
        const weekly = aggregateToWeekly(daily);
        cacheRef.current[ticker] = weekly;
        setAllWeeklyData(weekly);
        if (weekly.length === 0) setError('No chart data available for this ticker.');
      })
      .catch(err => {
        if (cancelled) return;
        console.error(err);
        setError('Failed to load chart data');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [currentIndex]);

  // Fetch entry dates for all stocks in this modal (batch, one-time on mount)
  useEffect(() => {
    const tickers = stocks.map(s => s.ticker);
    fetchEntryDates(tickers).then(data => {
      entryDatesRef.current = data;
      setEntryDatesLoaded(true);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Build/rebuild chart when data, range, or stop price changes
  useEffect(() => {
    if (loading || !chartContainerRef.current || allWeeklyData.length === 0) return;

    setHoveredBar(null);
    setSignalMarkers([]);
    setPantherMarkerPos(null);

    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }

    const filtered = filterByRange(allWeeklyData, range);
    if (filtered.length === 0) return;

    // Yellow background if today is within 14 calendar days of earnings (matches dashboard row highlight)
    const earningsDate = earnings[stock?.ticker] ?? null;
    const earningsWindow = (() => {
      if (!earningsDate) return false;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const [ey, em, ed] = earningsDate.split('-').map(Number);
      const eDate = new Date(ey, em - 1, ed);
      const daysAway = Math.round((eDate - today) / (1000 * 60 * 60 * 24));
      return daysAway >= 0 && daysAway <= 14;
    })();
    setInEarningsWindow(earningsWindow);
    const chartBg = earningsWindow ? '#fffde7' : '#ffffff';

    const chart = createChart(chartContainerRef.current, {
      autoSize: true,
      layout: { background: { color: chartBg }, textColor: '#212121', attributionLogo: false },
      grid: { vertLines: { color: '#f0f0f0' }, horzLines: { color: '#f0f0f0' } },
      rightPriceScale: { borderColor: '#d4d4d4' },
      timeScale: { borderColor: '#d4d4d4', timeVisible: false },
      crosshair: { mode: 1 },
    });
    chartRef.current = chart;

    const series = chart.addSeries(BarSeries, {
      upColor: '#16a34a',
      downColor: '#dc2626',
      priceLineVisible: false,
      lastValueVisible: false,
    });

    series.setData(filtered);

    const filteredTimes = new Set(filtered.map(d => d.time));

    let destroyed = false;

    // OHLC tooltip on crosshair hover
    chart.subscribeCrosshairMove(param => {
      if (destroyed) return;
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

    // Compute signals and live stops from full history
    const { events: allDetected, pnthrStop: ps, currentWeekStop: cws, currentSignal: cs } = detectAllSignals(allWeeklyData, 21);
    setPnthrStop(ps);
    setCurrentWeekStop(cws);
    setCurrentSignal(cs);
    const lastEntryIdx = (() => { for (let i = allDetected.length - 1; i >= 0; i--) { if (allDetected[i].signal === 'BL' || allDetected[i].signal === 'SS') return i; } return -1; })();
    const lastEntry  = lastEntryIdx >= 0 ? allDetected[lastEntryIdx] : null;
    const exitEvent  = lastEntry ? allDetected.slice(lastEntryIdx + 1).find(e => e.signal === 'BE' || e.signal === 'SE') : null;
    const allSignalEvents = [lastEntry, exitEvent].filter(e => e && filteredTimes.has(e.time));
    if (allSignalEvents.length > 0) {
      const BADGE_H = 22;
      const updateAllMarkers = () => {
        if (destroyed) return;
        try {
          const positions = [];
          for (const ev of allSignalEvents) {
            const x = chart.timeScale().timeToCoordinate(ev.time);
            // BL, SE → below bar; SS, BE → above bar
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

    // Panther head — float icon at the date the stock first appeared in the long or short top-100 list
    const entryInfo = entryDatesRef.current[stock?.ticker];
    if (entryInfo?.date) {
      const entryDate = new Date(entryInfo.date + 'T00:00:00');
      const dow = entryDate.getDay();
      const monday = new Date(entryDate);
      monday.setDate(entryDate.getDate() - (dow === 0 ? 6 : dow - 1));
      const weekKey = monday.toISOString().split('T')[0];
      if (filteredTimes.has(weekKey)) {
        const barData = filtered.find(d => d.time === weekKey);
        if (barData) {
          const ICON = 24;
          const isLong = entryInfo.list === 'LONG';
          const updatePantherPos = () => {
            if (destroyed) return;
            try {
              const x = chart.timeScale().timeToCoordinate(weekKey);
              const price = isLong ? barData.low : barData.high;
              const y = series.priceToCoordinate(price);
              if (x != null && y != null) {
                setPantherMarkerPos({
                  left: Math.round(x) - ICON / 2,
                  top: isLong ? Math.round(y) + 28 : Math.round(y) - ICON - 28,
                  list: entryInfo.list,
                });
              }
            } catch { /* chart destroyed mid-callback */ }
          };
          chart.timeScale().subscribeVisibleTimeRangeChange(updatePantherPos);
          setTimeout(updatePantherPos, 50);
        }
      }
    }

    // 21 EMA — calculated on full history for accuracy
    const ema21Full = calculateEMA(allWeeklyData, 21);
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

    // Draw stop lines only across the last 3 bars (not full chart width)
    const last3 = filtered.slice(-3);
    if (ps != null && last3.length > 0) {
      const pnthrLineSeries = chart.addSeries(LineSeries, {
        color: '#ca8a04',
        lineWidth: 2,
        lineStyle: 2, // dashed
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      pnthrLineSeries.setData(last3.map(b => ({ time: b.time, value: ps })));
    }
    if (cws != null && last3.length > 0) {
      const cwsLineSeries = chart.addSeries(LineSeries, {
        color: '#9333ea',
        lineWidth: 1,
        lineStyle: 3, // dotted
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      cwsLineSeries.setData(last3.map(b => ({ time: b.time, value: cws })));
    }

    chart.timeScale().fitContent();

    return () => {
      destroyed = true;
      setHoveredBar(null);
      setSignalMarkers([]);
      setPantherMarkerPos(null);
      setPnthrStop(null);
      setCurrentWeekStop(null);
      setCurrentSignal(null);
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
    };
  }, [allWeeklyData, range, loading, entryDatesLoaded, earnings]);

  // Load watchlist on mount
  useEffect(() => {
    fetchWatchlist().then(data => setWatchlistSet(new Set(data.map(s => s.ticker)))).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggleWatchlist() {
    const ticker = stock.ticker;
    const inList = watchlistSet.has(ticker);
    setWatchlistSaving(true);
    try {
      if (inList) {
        await removeWatchlistTicker(ticker);
        setWatchlistSet(prev => { const next = new Set(prev); next.delete(ticker); return next; });
        onWatchlistChange?.(ticker, false);
      } else {
        await addWatchlistTicker(ticker);
        setWatchlistSet(prev => new Set([...prev, ticker]));
        onWatchlistChange?.(ticker, true);
      }
    } catch (err) {
      console.error('Watchlist toggle error:', err);
    } finally {
      setWatchlistSaving(false);
    }
  }

  // Keyboard navigation
  useEffect(() => {
    function handleKey(e) {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') setCurrentIndex(i => Math.max(0, i - 1));
      if (e.key === 'ArrowRight') setCurrentIndex(i => Math.min(stocks.length - 1, i + 1));
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [stocks.length, onClose]);

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) onClose();
  }

  if (!stock) return null;

  return (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div className={styles.modal}>

        {/* Header */}
        <div className={styles.header}>
          <div className={styles.stockInfo}>
            <div className={styles.tickerRow}>
              <span className={styles.ticker}>{stock.ticker}</span>
              <span className={styles.company}>{stock.companyName}</span>
            </div>
            <div className={styles.badges}>
              {stock.sector && <span className={styles.badge}>{stock.sector}</span>}
              {stock.exchange && <span className={styles.badge}>{stock.exchange}</span>}
            </div>
          </div>
          <div className={styles.headerActions}>
            <button
              className={`${styles.watchlistBtn} ${inWatchlist ? styles.watchlistBtnActive : ''}`}
              onClick={toggleWatchlist}
              disabled={watchlistSaving}
              title={inWatchlist ? `Remove ${stock.ticker} from watchlist` : `Add ${stock.ticker} to watchlist`}
            >
              {inWatchlist ? '★' : '☆'}
            </button>
            <button className={styles.closeBtn} onClick={onClose} title="Close">×</button>
          </div>
        </div>

        {/* Controls */}
        <div className={styles.controls}>
          <div className={styles.rangeButtons}>
            {['3m', '12m', 'all'].map(r => (
              <button
                key={r}
                className={`${styles.rangeBtn} ${range === r ? styles.rangeBtnActive : ''}`}
                onClick={() => setRange(r)}
              >
                {r === '3m' ? '3M' : r === '12m' ? '12M' : 'All'}
              </button>
            ))}
          </div>
          <div className={styles.priceInfo}>
            {currentSignal === 'BL' && (
              <span className={`${styles.pnthrBadge} ${styles.pnthrBadgeBL}`}>BL</span>
            )}
            {currentSignal === 'SS' && (
              <span className={`${styles.pnthrBadge} ${styles.pnthrBadgeSS}`}>SS</span>
            )}
            {currentSignal === 'BE' && (
              <span className={`${styles.pnthrBadge} ${styles.pnthrBadgeBE}`}>BE</span>
            )}
            {currentSignal === 'SE' && (
              <span className={`${styles.pnthrBadge} ${styles.pnthrBadgeSE}`}>SE</span>
            )}
            <span className={styles.currentPrice}>${stock.currentPrice?.toLocaleString()}</span>
            {pnthrStop != null && (
              <span className={styles.stopBadge}>PNTHR Stop: ${pnthrStop.toFixed(2)}</span>
            )}
            {currentWeekStop != null && (
              <span className={styles.stopBadgeCurr}>Curr Stop: ${currentWeekStop.toFixed(2)}</span>
            )}
          </div>
        </div>

        {/* Chart */}
        <div className={styles.chartArea}>
          {loading && (
            <div className={styles.loadingState}>
              <div className={styles.spinner}></div>
              <p>Loading chart...</p>
            </div>
          )}
          {error && <div className={styles.errorState}>{error}</div>}
          {!loading && !error && (
            <div className={styles.chartWrapper}>
              <div ref={chartContainerRef} className={styles.chartContainer} />

              {/* Earnings Week label — centered top of chart when in earnings window */}
              {inEarningsWindow && (
                <div className={styles.earningsWindowLabel}>Earnings Week</div>
              )}

              {/* BL/SS/BE/SE signal badges — overlaid on chart at signal bar */}
              {signalMarkers.map((m, i) => {
                const isProfitable = (m.signal === 'BE' || m.signal === 'SE') && m.profitPct != null && m.profitPct > 0;
                return (
                  <span
                    key={i}
                    className={`${styles.chartSignalBadge} ${
                      m.signal === 'BL' ? styles.chartSignalBadgeBL :
                      m.signal === 'SS' ? styles.chartSignalBadgeSS :
                      m.signal === 'BE' ? styles.chartSignalBadgeBE :
                      styles.chartSignalBadgeSE
                    }`}
                    style={{
                      left: m.left,
                      top: m.top,
                      pointerEvents: isProfitable ? 'auto' : 'none',
                      cursor: isProfitable ? 'pointer' : 'default',
                    }}
                    onMouseEnter={isProfitable ? () => setHoveredMarkerProfit(m) : undefined}
                    onMouseLeave={isProfitable ? () => setHoveredMarkerProfit(null) : undefined}
                  >{m.signal}</span>
                );
              })}

              {/* Panther head — marks the date stock first entered the long or short top-100 list */}
              {pantherMarkerPos && (
                <div
                  className={styles.pantherMarker}
                  style={{ left: pantherMarkerPos.left, top: pantherMarkerPos.top }}
                  title={`First appeared in ${pantherMarkerPos.list} top-100 list`}
                >
                  <img src={pantherHeadIcon} alt="PNTHR entry" className={styles.pantherIcon} />
                  <span className={`${styles.pantherBadge} ${pantherMarkerPos.list === 'LONG' ? styles.pantherBadgeLong : styles.pantherBadgeShort}`}>
                    {pantherMarkerPos.list === 'LONG' ? 'L' : 'S'}
                  </span>
                </div>
              )}

              {/* Profit tooltip for profitable BE/SE markers */}
              {hoveredMarkerProfit && (
                <div
                  className={styles.profitTooltip}
                  style={{ left: Math.max(8, hoveredMarkerProfit.left - 136), top: Math.max(8, hoveredMarkerProfit.top - 54) }}
                >
                  <div className={styles.profitTooltipTitle}>
                    {hoveredMarkerProfit.signal} Profit
                  </div>
                  <div className={styles.profitTooltipRow}>
                    +{hoveredMarkerProfit.profitPct.toFixed(2)}%
                  </div>
                  <div className={styles.profitTooltipRow}>
                    +${hoveredMarkerProfit.profitDollar.toFixed(2)}/sh
                  </div>
                </div>
              )}

              {/* OHLC tooltip on hover */}
              {hoveredBar && (
                <div
                  className={styles.ohlcTooltip}
                  style={{
                    left: hoveredBar.x < 180 ? hoveredBar.x + 14 : hoveredBar.x - 148,
                    top: Math.max(8, hoveredBar.y - 72),
                  }}
                >
                  <div className={styles.ohlcDate}>Week of {formatWeekDate(hoveredBar.time)}</div>
                  <div className={styles.ohlcRow}><span>O</span><span>${hoveredBar.open?.toFixed(2)}</span></div>
                  <div className={styles.ohlcRow}><span>H</span><span>${hoveredBar.high?.toFixed(2)}</span></div>
                  <div className={styles.ohlcRow}><span>L</span><span>${hoveredBar.low?.toFixed(2)}</span></div>
                  <div className={styles.ohlcRow}><span>C</span><span>${hoveredBar.close?.toFixed(2)}</span></div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Navigation */}
        <div className={styles.navigation}>
          <button
            className={styles.navBtn}
            onClick={() => setCurrentIndex(i => Math.max(0, i - 1))}
            disabled={currentIndex === 0}
          >
            ← Prev
          </button>
          <span className={styles.navPosition}>{currentIndex + 1} of {stocks.length}</span>
          <button
            className={styles.navBtn}
            onClick={() => setCurrentIndex(i => Math.min(stocks.length - 1, i + 1))}
            disabled={currentIndex === stocks.length - 1}
          >
            Next →
          </button>
        </div>

      </div>
    </div>
  );
}
