import { useState, useEffect, useRef } from 'react';
import { createChart, CandlestickSeries, LineSeries } from 'lightweight-charts';
import { fetchChartData } from '../services/api';
import styles from './ChartModal.module.css';

// Aggregate daily OHLCV (newest-first from FMP) into weekly candles
function aggregateToWeekly(dailyData) {
  const sorted = [...dailyData].sort((a, b) => (a.date < b.date ? -1 : 1));
  const weeksMap = new Map();
  for (const day of sorted) {
    const date = new Date(day.date + 'T00:00:00');
    const dow = date.getDay(); // 0=Sun
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

// Calculate EMA over the full dataset for accuracy, then trim to display range
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

export default function ChartModal({ stocks, initialIndex, signals, onClose }) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [range, setRange] = useState('12m');
  const [allWeeklyData, setAllWeeklyData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);
  const cacheRef = useRef({});

  const stock = stocks[currentIndex];
  const signalData = signals[stock?.ticker];
  const stopPrice = signalData?.stopPrice ?? null;

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
      })
      .catch(err => {
        if (cancelled) return;
        console.error(err);
        setError('Failed to load chart data');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [currentIndex]);

  // Build/rebuild chart when data, range, or stop price changes
  useEffect(() => {
    if (loading || !chartContainerRef.current || allWeeklyData.length === 0) return;

    // Destroy any existing chart
    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }

    const filtered = filterByRange(allWeeklyData, range);
    if (filtered.length === 0) return;

    const chart = createChart(chartContainerRef.current, {
      autoSize: true,
      layout: { background: { color: '#ffffff' }, textColor: '#212121' },
      grid: { vertLines: { color: '#f0f0f0' }, horzLines: { color: '#f0f0f0' } },
      rightPriceScale: { borderColor: '#d4d4d4' },
      timeScale: { borderColor: '#d4d4d4', timeVisible: false },
      crosshair: { mode: 1 },
    });
    chartRef.current = chart;

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#16a34a',
      downColor: '#dc2626',
      borderUpColor: '#16a34a',
      borderDownColor: '#dc2626',
      wickUpColor: '#16a34a',
      wickDownColor: '#dc2626',
    });

    series.setData(filtered);

    // 21 EMA — calculated on full history so it's accurate in any display range
    const ema21Full = calculateEMA(allWeeklyData, 21);
    if (ema21Full.length > 0) {
      const filteredTimes = new Set(filtered.map(d => d.time));
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
        title: `Stop $${stopPrice}`,
      });
    }

    chart.timeScale().fitContent();

    return () => {
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
    };
  }, [allWeeklyData, range, stopPrice, loading]);

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
            <span className={styles.ticker}>{stock.ticker}</span>
            {stock.companyName && <span className={styles.company}>{stock.companyName}</span>}
            <div className={styles.badges}>
              {stock.sector && <span className={styles.badge}>{stock.sector}</span>}
              {stock.exchange && <span className={styles.badge}>{stock.exchange}</span>}
            </div>
          </div>
          <button className={styles.closeBtn} onClick={onClose} title="Close">×</button>
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
            <div ref={chartContainerRef} className={styles.chartContainer} />
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
