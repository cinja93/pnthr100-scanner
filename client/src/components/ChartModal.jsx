import { useState, useEffect, useRef } from 'react';
import { createChart, BarSeries, LineSeries } from 'lightweight-charts';
import { fetchChartData, fetchEntryDates, fetchWatchlist, addWatchlistTicker, removeWatchlistTicker } from '../services/api';
import styles from './ChartModal.module.css';
import pantherHeadIcon from '../assets/panther head.png';

import confirmedBuyIcon     from './Confirmed Buy Signal.png';
import confirmedSellIcon    from './Confirmed Sell Signal.png';
import cautionBuyIcon       from './Caution Buy Signal.png';
import cautionSellIcon      from './Caution Sell Signal.png';
import newConfirmedBuyIcon  from './New Confirmed Buy Signal.png';
import newConfirmedSellIcon from './New Confirmed Sell Signal.png';
import newCautionBuyIcon    from './New Caution Buy Signal.png';
import newCautionSellIcon   from './New Caution Sell Signal.png';

function getSignalIcon(signalData) {
  if (!signalData?.signal) return null;
  const { signal, isNewSignal } = signalData;
  if (signal === 'BUY')         return { src: isNewSignal ? newConfirmedBuyIcon  : confirmedBuyIcon,  alt: isNewSignal ? 'New Confirmed Buy'  : 'Confirmed Buy'  };
  if (signal === 'SELL')        return { src: isNewSignal ? newConfirmedSellIcon : confirmedSellIcon, alt: isNewSignal ? 'New Confirmed Sell' : 'Confirmed Sell' };
  if (signal === 'YELLOW_BUY')  return { src: isNewSignal ? newCautionBuyIcon   : cautionBuyIcon,    alt: isNewSignal ? 'New Caution Buy'    : 'Caution Buy'    };
  if (signal === 'YELLOW_SELL') return { src: isNewSignal ? newCautionSellIcon  : cautionSellIcon,   alt: isNewSignal ? 'New Caution Sell'   : 'Caution Sell'   };
  return null;
}

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

export default function ChartModal({ stocks, initialIndex, signals, onClose }) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [range, setRange] = useState('12m');
  const [allWeeklyData, setAllWeeklyData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hoveredBar, setHoveredBar] = useState(null);
  const [signalMarkerPos, setSignalMarkerPos] = useState(null);
  const [pantherMarkerPos, setPantherMarkerPos] = useState(null);
  const [entryDatesLoaded, setEntryDatesLoaded] = useState(false);
  const [watchlistSet, setWatchlistSet] = useState(new Set());
  const [watchlistSaving, setWatchlistSaving] = useState(false);
  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);
  const cacheRef = useRef({});
  const entryDatesRef = useRef({});

  const stock = stocks[currentIndex];
  const signalData = signals[stock?.ticker];
  const stopPrice = signalData?.stopPrice ?? null;
  const signalIcon = getSignalIcon(signalData);
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
    setSignalMarkerPos(null);
    setPantherMarkerPos(null);

    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
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

    const series = chart.addSeries(BarSeries, {
      upColor: '#16a34a',
      downColor: '#dc2626',
    });

    series.setData(filtered);

    const filteredTimes = new Set(filtered.map(d => d.time));

    // OHLC tooltip on crosshair hover
    chart.subscribeCrosshairMove(param => {
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

    // Signal marker — float PNG icon over chart at the signal bar's price
    if (signalData?.signal && signalData?.timestamp) {
      const sigDate = new Date(signalData.timestamp);
      const dow = sigDate.getDay();
      const monday = new Date(sigDate);
      monday.setDate(sigDate.getDate() - (dow === 0 ? 6 : dow - 1));
      const weekKey = monday.toISOString().split('T')[0];
      if (filteredTimes.has(weekKey)) {
        const isBuy = signalData.signal.includes('BUY');
        const barData = filtered.find(d => d.time === weekKey);
        if (barData) {
          const ICON = 32;
          const updateMarkerPos = () => {
            const x = chart.timeScale().timeToCoordinate(weekKey);
            const price = isBuy ? barData.low : barData.high;
            const y = series.priceToCoordinate(price);
            if (x != null && y != null) {
              setSignalMarkerPos({
                left: Math.round(x) - ICON / 2,
                top: isBuy ? Math.round(y) + 4 : Math.round(y) - ICON - 4,
              });
            }
          };
          chart.timeScale().subscribeVisibleTimeRangeChange(updateMarkerPos);
          setTimeout(updateMarkerPos, 50);
        }
      }
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

    if (stopPrice != null) {
      series.createPriceLine({
        price: stopPrice,
        color: '#ca8a04',
        lineWidth: 2,
        lineStyle: 2,
        axisLabelVisible: true,
      });
    }

    chart.timeScale().fitContent();

    return () => {
      setHoveredBar(null);
      setSignalMarkerPos(null);
      setPantherMarkerPos(null);
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
    };
  }, [allWeeklyData, range, stopPrice, loading, entryDatesLoaded]);

  // Load watchlist on mount
  useEffect(() => {
    fetchWatchlist().then(tickers => setWatchlistSet(new Set(tickers))).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggleWatchlist() {
    const ticker = stock.ticker;
    const inList = watchlistSet.has(ticker);
    setWatchlistSaving(true);
    try {
      if (inList) {
        await removeWatchlistTicker(ticker);
        setWatchlistSet(prev => { const next = new Set(prev); next.delete(ticker); return next; });
      } else {
        await addWatchlistTicker(ticker);
        setWatchlistSet(prev => new Set([...prev, ticker]));
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
            {signalIcon && (
              <img src={signalIcon.src} alt={signalIcon.alt} className={styles.signalIcon} title={signalIcon.alt} />
            )}
            <span className={styles.currentPrice}>${stock.currentPrice?.toLocaleString()}</span>
            {stopPrice != null && (
              <span className={styles.stopBadge}>Stop: ${stopPrice.toLocaleString()}</span>
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

              {/* PNG signal marker overlaid on chart */}
              {signalMarkerPos && signalIcon && (
                <img
                  src={signalIcon.src}
                  alt={signalIcon.alt}
                  className={styles.chartMarkerIcon}
                  style={{ left: signalMarkerPos.left, top: signalMarkerPos.top }}
                />
              )}

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
