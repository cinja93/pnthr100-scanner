import { useState, useEffect, useRef, useMemo } from 'react';
import { createChart, LineSeries } from 'lightweight-charts';
import { fetchSectorData } from '../services/api';
import styles from './SectorPage.module.css';

const SECTOR_NAMES = {
  communicationServices:  'Communication Services',
  consumerDiscretionary:  'Consumer Discretionary',
  consumerStaples:        'Consumer Staples',
  energy:                 'Energy',
  financials:             'Financials',
  healthCare:             'Health Care',
  industrials:            'Industrials',
  informationTechnology:  'Information Technology',
  materials:              'Materials',
  realEstate:             'Real Estate',
  utilities:              'Utilities',
};

const SECTOR_COLORS = {
  communicationServices:  '#8b5cf6',
  consumerDiscretionary:  '#f59e0b',
  consumerStaples:        '#10b981',
  energy:                 '#ef4444',
  financials:             '#2563eb',
  healthCare:             '#06b6d4',
  industrials:            '#f97316',
  informationTechnology:  '#6366f1',
  materials:              '#84cc16',
  realEstate:             '#ec4899',
  utilities:              '#14b8a6',
};

const TIME_RANGES = ['5D', '1M', '6M', 'YTD', '12M'];

const RANGE_SUBTITLES = {
  '5D':  '5-day cumulative return',
  '1M':  '1-month cumulative return',
  '6M':  '6-month cumulative return',
  'YTD': 'Year-to-date cumulative return',
  '12M': '52-week cumulative return',
};

// Slice the raw daily data to the selected time range
function getFilteredData(allData, timeRange) {
  if (!allData || allData.length === 0) return [];

  if (timeRange === '5D') return allData.slice(-5);

  const today = new Date();
  let cutoff;

  if (timeRange === '1M') {
    cutoff = new Date(today);
    cutoff.setMonth(cutoff.getMonth() - 1);
  } else if (timeRange === '6M') {
    cutoff = new Date(today);
    cutoff.setMonth(cutoff.getMonth() - 6);
  } else if (timeRange === 'YTD') {
    cutoff = new Date(today.getFullYear(), 0, 1);
  } else {
    // 12M
    cutoff = new Date(today);
    cutoff.setFullYear(cutoff.getFullYear() - 1);
  }

  const cutoffStr = cutoff.toISOString().split('T')[0];
  return allData.filter(d => d.date >= cutoffStr);
}

// Compound daily % changes into a cumulative return series
function computeCumulative(filteredData, sectorKey) {
  let cum = 0;
  return filteredData.map(day => {
    const daily = day.sectors[sectorKey] ?? 0;
    cum = ((1 + cum / 100) * (1 + daily / 100) - 1) * 100;
    return { date: day.date, value: parseFloat(cum.toFixed(2)) };
  });
}

function SectorMiniChart({ sectorKey, chartData }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || chartData.length === 0) return;

    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: { background: { color: '#ffffff' }, textColor: '#212121', attributionLogo: false },
      grid: { vertLines: { color: '#f5f5f5' }, horzLines: { color: '#f5f5f5' } },
      rightPriceScale: { visible: false },
      leftPriceScale: { visible: false },
      timeScale: { visible: false },
      crosshair: { mode: 0 },
      handleScroll: false,
      handleScale: false,
    });
    chartRef.current = chart;

    const series = chart.addSeries(LineSeries, {
      color: SECTOR_COLORS[sectorKey],
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    series.setData(chartData.map(d => ({ time: d.date, value: d.value })));
    chart.timeScale().fitContent();

    return () => {
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
    };
  }, [sectorKey, chartData]);

  const currentReturn = chartData.length > 0 ? chartData[chartData.length - 1].value : null;
  const isPositive = currentReturn != null && currentReturn >= 0;

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <span className={styles.sectorName}>{SECTOR_NAMES[sectorKey]}</span>
        {currentReturn != null && (
          <span className={`${styles.returnBadge} ${isPositive ? styles.positive : styles.negative}`}>
            {isPositive ? '+' : ''}{currentReturn.toFixed(2)}%
          </span>
        )}
      </div>
      <div ref={containerRef} className={styles.chartContainer} />
    </div>
  );
}

export default function SectorPage() {
  const [allData, setAllData] = useState(null);
  const [timeRange, setTimeRange] = useState('12M');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchSectorData()
      .then(data => setAllData(data))
      .catch(err => {
        console.error(err);
        setError('Failed to load sector data.');
      })
      .finally(() => setLoading(false));
  }, []);

  // Recompute cumulative series whenever data or range changes — no extra API calls
  const { bySector, sortedSectorKeys } = useMemo(() => {
    if (!allData) return { bySector: null, sortedSectorKeys: Object.keys(SECTOR_NAMES) };

    const filtered = getFilteredData(allData, timeRange);
    const bySector = {};
    for (const key of Object.keys(SECTOR_NAMES)) {
      bySector[key] = computeCumulative(filtered, key);
    }

    const sortedSectorKeys = Object.keys(SECTOR_NAMES).sort((a, b) => {
      const aLast = bySector[a]?.at(-1)?.value ?? -Infinity;
      const bLast = bySector[b]?.at(-1)?.value ?? -Infinity;
      return bLast - aLast;
    });

    return { bySector, sortedSectorKeys };
  }, [allData, timeRange]);

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h2 className={styles.pageTitle}>Sector Performance</h2>
          <p className={styles.pageSubtitle}>{RANGE_SUBTITLES[timeRange]}</p>
        </div>
        <div className={styles.rangeBar}>
          {TIME_RANGES.map(range => (
            <button
              key={range}
              className={`${styles.rangeBtn} ${timeRange === range ? styles.rangeBtnActive : ''}`}
              onClick={() => setTimeRange(range)}
            >
              {range}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <p>Loading sector data...</p>
        </div>
      )}

      {error && (
        <div className={styles.errorState}>
          <span>⚠️</span> {error}
        </div>
      )}

      {!loading && !error && bySector && (
        <div className={styles.grid}>
          {sortedSectorKeys.map(key => (
            <SectorMiniChart
              key={key}
              sectorKey={key}
              chartData={bySector[key]}
            />
          ))}
        </div>
      )}
    </div>
  );
}
