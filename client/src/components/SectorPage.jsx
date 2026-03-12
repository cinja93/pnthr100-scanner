import { useState, useEffect, useRef, useMemo } from 'react';
import { createChart, LineSeries } from 'lightweight-charts';
import { fetchSectorData, fetchSectorStocks, fetchEarnings, fetchScannerRanks, fetchSectorSignalCounts, fetchSpeculativeSignalCounts, fetchSpeculativeStocks } from '../services/api';
import StockTable from './StockTable';
import ChartModal from './ChartModal';
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

const SECTOR_ETF = {
  communicationServices:  'XLC',
  consumerDiscretionary:  'XLY',
  consumerStaples:        'XLP',
  energy:                 'XLE',
  financials:             'XLF',
  healthCare:             'XLV',
  industrials:            'XLI',
  informationTechnology:  'XLK',
  materials:              'XLB',
  realEstate:             'XLRE',
  utilities:              'XLU',
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

function SectorMiniChart({ sectorKey, chartData, signalCounts, onClick, onSignalClick }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const tooltipRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || chartData.length === 0) return;

    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: { background: { color: '#ffffff' }, textColor: '#888', attributionLogo: false, fontSize: 10 },
      grid: { vertLines: { color: '#f5f5f5' }, horzLines: { color: '#f5f5f5' } },
      rightPriceScale: { visible: false },
      leftPriceScale: { visible: false },
      timeScale: {
        visible: true,
        borderVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
      },
      crosshair: {
        // Vertical line only — no horizontal crosshair
        vertLine: {
          visible: true,
          width: 1,
          style: 3,         // dashed
          color: '#94a3b8',
          labelVisible: false,
        },
        horzLine: {
          visible: false,
          labelVisible: false,
        },
      },
      handleScroll: false,
      handleScale: false,
    });
    chartRef.current = chart;

    const series = chart.addSeries(LineSeries, {
      color: SECTOR_COLORS[sectorKey],
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
    });

    series.setData(chartData.map(d => ({ time: d.date, value: d.value })));
    chart.timeScale().fitContent();

    // Show a floating date label next to the crosshair dot as the user hovers
    chart.subscribeCrosshairMove(param => {
      const tooltip = tooltipRef.current;
      if (!tooltip) return;

      if (!param.time || !param.point || param.point.x < 0 || param.point.y < 0) {
        tooltip.style.display = 'none';
        return;
      }

      // param.time is a 'YYYY-MM-DD' string when using date strings
      const dateStr = typeof param.time === 'string'
        ? param.time
        : new Date(param.time * 1000).toISOString().split('T')[0];

      const [year, month, day] = dateStr.split('-').map(Number);
      const formatted = new Date(year, month - 1, day).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      });

      tooltip.textContent = formatted;
      tooltip.style.display = 'block';

      // Position to the right of the dot; flip left if near the right edge
      const containerWidth = containerRef.current ? containerRef.current.offsetWidth : 0;
      const tooltipWidth = tooltip.offsetWidth || 90;
      const OFFSET = 10;
      const left = param.point.x + OFFSET + tooltipWidth > containerWidth
        ? param.point.x - OFFSET - tooltipWidth
        : param.point.x + OFFSET;

      tooltip.style.left = `${left}px`;
      tooltip.style.top  = `${param.point.y - 22}px`;
    });

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
    <div className={styles.card} onClick={onClick} title={`Click to see all stocks in ${SECTOR_NAMES[sectorKey]}`}>
      <div className={styles.cardHeader}>
        <span className={styles.sectorName}>{SECTOR_NAMES[sectorKey]}</span>
        {currentReturn != null && (
          <span className={`${styles.returnBadge} ${isPositive ? styles.positive : styles.negative}`}>
            {SECTOR_ETF[sectorKey] && <span className={styles.etfTicker}>{SECTOR_ETF[sectorKey]}</span>}
            {isPositive ? '+' : ''}{currentReturn.toFixed(2)}%
          </span>
        )}
      </div>
      {/* Relative wrapper so the tooltip is positioned inside the chart area */}
      <div className={styles.chartWrap}>
        <div ref={containerRef} className={styles.chartContainer} />
        <div ref={tooltipRef} className={styles.chartTooltip} />
      </div>
      {signalCounts && (
        <div className={styles.signalSummary}>
          {signalCounts.newBL > 0 && <button className={`${styles.sigNewBL} ${styles.sigClickable}`} onClick={e => { e.stopPropagation(); onSignalClick('newBL'); }}>New BL <strong>{signalCounts.newBL}</strong></button>}
          {signalCounts.newSS > 0 && <button className={`${styles.sigNewSS} ${styles.sigClickable}`} onClick={e => { e.stopPropagation(); onSignalClick('newSS'); }}>New SS <strong>{signalCounts.newSS}</strong></button>}
          {signalCounts.BL > 0 && <button className={`${styles.sigBL} ${styles.sigClickable}`} onClick={e => { e.stopPropagation(); onSignalClick('BL'); }}>BL <strong>{signalCounts.BL}</strong></button>}
          {signalCounts.BE > 0 && <button className={`${styles.sigBE} ${styles.sigClickable}`} onClick={e => { e.stopPropagation(); onSignalClick('BE'); }}>BE <strong>{signalCounts.BE}</strong></button>}
          {signalCounts.SS > 0 && <button className={`${styles.sigSS} ${styles.sigClickable}`} onClick={e => { e.stopPropagation(); onSignalClick('SS'); }}>SS <strong>{signalCounts.SS}</strong></button>}
          {signalCounts.SE > 0 && <button className={`${styles.sigSE} ${styles.sigClickable}`} onClick={e => { e.stopPropagation(); onSignalClick('SE'); }}>SE <strong>{signalCounts.SE}</strong></button>}
          {signalCounts.BL === 0 && signalCounts.BE === 0 && signalCounts.SS === 0 && signalCounts.SE === 0 && (
            <span className={styles.sigNone}>No signals</span>
          )}
        </div>
      )}
      <div className={styles.cardFooter}>
        {signalCounts?.total != null && (
          <span className={styles.stockCount}>{signalCounts.total} stocks</span>
        )}
        <span>View stocks →</span>
      </div>
    </div>
  );
}

// ── S&P 400 center chart (IJH line chart, no card wrapper) ───────────────────

function Sp400CenterChart({ chartData }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const tooltipRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || chartData.length === 0) return;

    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: { background: { color: '#ffffff' }, textColor: '#888', attributionLogo: false, fontSize: 10 },
      grid: { vertLines: { color: '#f5f5f5' }, horzLines: { color: '#f5f5f5' } },
      rightPriceScale: { visible: false },
      leftPriceScale: { visible: false },
      timeScale: { visible: true, borderVisible: false, fixLeftEdge: true, fixRightEdge: true },
      crosshair: {
        vertLine: { visible: true, width: 1, style: 3, color: '#94a3b8', labelVisible: false },
        horzLine: { visible: false, labelVisible: false },
      },
      handleScroll: false,
      handleScale: false,
    });
    chartRef.current = chart;

    const series = chart.addSeries(LineSeries, {
      color: '#f59e0b',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
    });

    series.setData(chartData.map(d => ({ time: d.date, value: d.value })));
    chart.timeScale().fitContent();

    chart.subscribeCrosshairMove(param => {
      const tooltip = tooltipRef.current;
      if (!tooltip) return;
      if (!param.time || !param.point || param.point.x < 0 || param.point.y < 0) {
        tooltip.style.display = 'none';
        return;
      }
      const dateStr = typeof param.time === 'string'
        ? param.time
        : new Date(param.time * 1000).toISOString().split('T')[0];
      const [year, month, day] = dateStr.split('-').map(Number);
      const formatted = new Date(year, month - 1, day).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      });
      tooltip.textContent = formatted;
      tooltip.style.display = 'block';
      const containerWidth = containerRef.current ? containerRef.current.offsetWidth : 0;
      const tooltipWidth = tooltip.offsetWidth || 90;
      const OFFSET = 10;
      const left = param.point.x + OFFSET + tooltipWidth > containerWidth
        ? param.point.x - OFFSET - tooltipWidth
        : param.point.x + OFFSET;
      tooltip.style.left = `${left}px`;
      tooltip.style.top  = `${param.point.y - 22}px`;
    });

    return () => {
      if (chartRef.current) { chartRef.current.remove(); chartRef.current = null; }
    };
  }, [chartData]);

  return (
    <div className={styles.chartWrap}>
      <div ref={containerRef} className={styles.sp400Chart} />
      <div ref={tooltipRef} className={styles.chartTooltip} />
    </div>
  );
}

// ── S&P 400 full-width card ───────────────────────────────────────────────────

function Sp400Card({ chartData, specCounts, timeRange, onClickLongs, onClickShorts }) {
  const currentReturn = chartData.length > 0 ? chartData[chartData.length - 1].value : null;
  const isPositive = currentReturn != null && currentReturn >= 0;

  return (
    <div className={styles.sp400Card}>
      <div className={styles.sp400CardHeader}>
        <div>
          <span className={styles.sp400CardTitle}>S&P 400 Mid-Cap</span>
          <span className={styles.sp400CardSub}>iShares Core S&P Mid-Cap ETF (IJH) · {RANGE_SUBTITLES[timeRange]}</span>
        </div>
        {currentReturn != null && (
          <span className={`${styles.returnBadge} ${isPositive ? styles.positive : styles.negative}`}>
            IJH {isPositive ? '+' : ''}{currentReturn.toFixed(2)}%
          </span>
        )}
      </div>
      <div className={styles.sp400Body}>
        {/* Left: Long Leaders */}
        <div className={styles.sp400Panel} onClick={onClickLongs} title="View S&P 400 Long Leaders">
          <div className={styles.sp400PanelTitle}>S&P 400 Long Leaders</div>
          {specCounts?.longs ? (
            <div className={styles.signalSummary}>
              {specCounts.longs.BL > 0 && <span className={styles.sigBL}>BL <strong>{specCounts.longs.BL}</strong></span>}
              {specCounts.longs.BE > 0 && <span className={styles.sigBE}>BE <strong>{specCounts.longs.BE}</strong></span>}
              {specCounts.longs.SS > 0 && <span className={styles.sigSS}>SS <strong>{specCounts.longs.SS}</strong></span>}
              {specCounts.longs.SE > 0 && <span className={styles.sigSE}>SE <strong>{specCounts.longs.SE}</strong></span>}
              {specCounts.longs.BL === 0 && specCounts.longs.BE === 0 && specCounts.longs.SS === 0 && specCounts.longs.SE === 0 && (
                <span className={styles.sigNone}>No signals</span>
              )}
            </div>
          ) : (
            <div className={styles.sp400PanelLoading}>Computing…</div>
          )}
          <div className={styles.sp400PanelFooter}>
            {specCounts?.longs?.total != null && <span>{specCounts.longs.total} stocks</span>}
            <span>View stocks →</span>
          </div>
        </div>

        {/* Center: IJH chart */}
        <div className={styles.sp400Center}>
          <Sp400CenterChart chartData={chartData} />
        </div>

        {/* Right: Short Leaders */}
        <div className={styles.sp400Panel} onClick={onClickShorts} title="View S&P 400 Short Leaders">
          <div className={styles.sp400PanelTitle}>S&P 400 Short Leaders</div>
          {specCounts?.shorts ? (
            <div className={styles.signalSummary}>
              {specCounts.shorts.BL > 0 && <span className={styles.sigBL}>BL <strong>{specCounts.shorts.BL}</strong></span>}
              {specCounts.shorts.BE > 0 && <span className={styles.sigBE}>BE <strong>{specCounts.shorts.BE}</strong></span>}
              {specCounts.shorts.SS > 0 && <span className={styles.sigSS}>SS <strong>{specCounts.shorts.SS}</strong></span>}
              {specCounts.shorts.SE > 0 && <span className={styles.sigSE}>SE <strong>{specCounts.shorts.SE}</strong></span>}
              {specCounts.shorts.BL === 0 && specCounts.shorts.BE === 0 && specCounts.shorts.SS === 0 && specCounts.shorts.SE === 0 && (
                <span className={styles.sigNone}>No signals</span>
              )}
            </div>
          ) : (
            <div className={styles.sp400PanelLoading}>Computing…</div>
          )}
          <div className={styles.sp400PanelFooter}>
            {specCounts?.shorts?.total != null && <span>{specCounts.shorts.total} stocks</span>}
            <span>View stocks →</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── S&P 400 stocks modal ──────────────────────────────────────────────────────

function Sp400StocksModal({ side, onClose }) {
  const [stocks, setStocks] = useState([]);
  const [signals, setSignals] = useState({});
  const [earnings, setEarnings] = useState({});
  const [scannerRanks, setScannerRanks] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [chartIndex, setChartIndex] = useState(null);
  const [chartStocks, setChartStocks] = useState([]);

  const title = side === 'longs' ? 'S&P 400 Long Leaders' : 'S&P 400 Short Leaders';

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchScannerRanks().then(r => setScannerRanks(r));
    fetchSpeculativeStocks(side)
      .then(result => {
        const stockList = result.stocks || [];
        setStocks(stockList);
        setSignals(result.signals || {});
        fetchEarnings(stockList.map(s => s.ticker)).then(r => setEarnings(r));
      })
      .catch(err => {
        console.error(err);
        setError('Failed to load stocks.');
      })
      .finally(() => setLoading(false));
  }, [side]);

  function handleTickerClick(_stock, sortedIdx, sortedStocks) {
    setChartStocks(sortedStocks);
    setChartIndex(sortedIdx);
  }

  return (
    <>
      <div className={styles.modalOverlay} onClick={onClose}>
        <div className={styles.modalPanel} onClick={e => e.stopPropagation()}>
          <div className={styles.modalHeader}>
            <div>
              <h2 className={styles.modalTitle}>{title}</h2>
              {!loading && !error && (
                <p className={styles.modalSubtitle}>{stocks.length} stocks ranked by YTD return</p>
              )}
            </div>
            <button className={styles.modalCloseBtn} onClick={onClose} aria-label="Close">✕</button>
          </div>

          {loading && (
            <div className={styles.modalLoading}>
              <div className={styles.spinner} />
              <p>Loading stocks…</p>
            </div>
          )}
          {error && !loading && <div className={styles.modalError}>{error}</div>}
          {!loading && !error && stocks.length > 0 && (
            <div className={styles.modalTableWrap}>
              <StockTable
                stocks={stocks}
                signals={signals}
                signalsLoading={false}
                earnings={earnings}
                scannerRanks={scannerRanks}
                hideSector
                groupBySector
                onTickerClick={handleTickerClick}
                scanType={side === 'longs' ? 'long' : 'short'}
              />
            </div>
          )}
          {!loading && !error && stocks.length === 0 && (
            <div className={styles.modalEmpty}>No stocks found.</div>
          )}
        </div>
      </div>

      {chartIndex != null && (
        <ChartModal
          stocks={chartStocks}
          initialIndex={chartIndex}
          signals={signals}
          earnings={earnings}
          onClose={() => setChartIndex(null)}
        />
      )}
    </>
  );
}

// ── Sector stocks modal ──────────────────────────────────────────────────────

function SectorStocksModal({ sectorKey, sectorName, filterSignal, onClose }) {
  const [stocks, setStocks] = useState([]);
  const [signals, setSignals] = useState({});
  const [earnings, setEarnings] = useState({});
  const [scannerRanks, setScannerRanks] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [chartIndex, setChartIndex] = useState(null);
  const [chartStocks, setChartStocks] = useState([]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchScannerRanks().then(r => setScannerRanks(r));
    fetchSectorStocks(sectorKey)
      .then(result => {
        const stockList = result.stocks || [];
        setStocks(stockList);
        setSignals(result.signals || {});
        fetchEarnings(stockList.map(s => s.ticker)).then(r => setEarnings(r));
      })
      .catch(err => {
        console.error(err);
        setError('Failed to load sector stocks.');
      })
      .finally(() => setLoading(false));
  }, [sectorKey]);

  function handleTickerClick(_stock, sortedIdx, sortedStocks) {
    setChartStocks(sortedStocks);
    setChartIndex(sortedIdx);
  }

  return (
    <>
      <div className={styles.modalOverlay} onClick={onClose}>
        <div className={styles.modalPanel} onClick={e => e.stopPropagation()}>
          <div className={styles.modalHeader}>
            <div>
              <h2 className={styles.modalTitle}>{sectorName}</h2>
              {!loading && !error && (
                <p className={styles.modalSubtitle}>{stocks.length} stocks ranked by YTD return</p>
              )}
            </div>
            <button className={styles.modalCloseBtn} onClick={onClose} aria-label="Close">✕</button>
          </div>

          {loading && (
            <div className={styles.modalLoading}>
              <div className={styles.spinner} />
              <p>Loading stocks…</p>
            </div>
          )}

          {error && !loading && (
            <div className={styles.modalError}>{error}</div>
          )}

          {!loading && !error && stocks.length > 0 && (
            <div className={styles.modalTableWrap}>
              {filterSignal && (
                <div className={styles.filterLabel}>
                  Showing: <strong>{filterSignal === 'newBL' ? 'New BL' : filterSignal === 'newSS' ? 'New SS' : filterSignal}</strong> signals first
                  <button className={styles.filterClear} onClick={onClose}>✕ Close filter</button>
                </div>
              )}
              <StockTable
                stocks={stocks}
                signals={signals}
                signalsLoading={false}
                earnings={earnings}
                scannerRanks={scannerRanks}
                hideSector
                pinSignal={filterSignal}
                onTickerClick={handleTickerClick}
                scanType="long"
              />
            </div>
          )}

          {!loading && !error && stocks.length === 0 && (
            <div className={styles.modalEmpty}>No stocks found for this sector.</div>
          )}
        </div>
      </div>

      {chartIndex != null && (
        <ChartModal
          stocks={chartStocks}
          initialIndex={chartIndex}
          signals={signals}
          earnings={earnings}
          onClose={() => setChartIndex(null)}
        />
      )}
    </>
  );
}

// ── Main SectorPage ──────────────────────────────────────────────────────────

export default function SectorPage() {
  const [allData, setAllData] = useState(null);
  const [timeRange, setTimeRange] = useState('12M');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Check if navigated here from PREY page with a specific ETF pre-selected
  const pendingEtf = sessionStorage.getItem('pnthr-sector-etf');
  const ETF_TO_SECTOR = Object.fromEntries(Object.entries(SECTOR_ETF).map(([k, v]) => [v, k]));
  const [selectedSector, setSelectedSector] = useState(pendingEtf ? (ETF_TO_SECTOR[pendingEtf] ?? null) : null);
  const [selectedFilter, setSelectedFilter] = useState(null);
  useEffect(() => { sessionStorage.removeItem('pnthr-sector-etf'); }, []);
  const [signalCounts, setSignalCounts] = useState(null);
  const [specCounts, setSpecCounts] = useState(null);
  const [specModal, setSpecModal] = useState(null); // 'longs' | 'shorts' | null

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

    // Fetch sector signal counts — retries every 20s if server is still computing
    let sectorRetry;
    function loadSectorCounts() {
      fetchSectorSignalCounts()
        .then(counts => {
          if (counts) setSignalCounts(counts);
          else sectorRetry = setTimeout(loadSectorCounts, 20000);
        })
        .catch(err => console.error('Signal counts error:', err));
    }
    loadSectorCounts();

    // Fetch speculative signal counts — same retry pattern
    let specRetry;
    function loadSpecCounts() {
      fetchSpeculativeSignalCounts()
        .then(counts => {
          if (counts) setSpecCounts(counts);
          else specRetry = setTimeout(loadSpecCounts, 20000);
        })
        .catch(err => console.error('Speculative counts error:', err));
    }
    loadSpecCounts();

    return () => { clearTimeout(sectorRetry); clearTimeout(specRetry); };
  }, []);

  // Recompute cumulative series whenever data or range changes — no extra API calls
  const { bySector, sortedSectorKeys, sp400Data } = useMemo(() => {
    if (!allData) return { bySector: null, sortedSectorKeys: Object.keys(SECTOR_NAMES), sp400Data: [] };

    const filtered = getFilteredData(allData, timeRange);
    const bySector = {};
    for (const key of Object.keys(SECTOR_NAMES)) {
      bySector[key] = computeCumulative(filtered, key);
    }
    const sp400Data = computeCumulative(filtered, 'sp400');

    const sortedSectorKeys = Object.keys(SECTOR_NAMES).sort((a, b) => {
      const aLast = bySector[a]?.at(-1)?.value ?? -Infinity;
      const bLast = bySector[b]?.at(-1)?.value ?? -Infinity;
      return bLast - aLast;
    });

    return { bySector, sortedSectorKeys, sp400Data };
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
        <>
          <div className={styles.grid}>
            {sortedSectorKeys.map(key => (
              <SectorMiniChart
                key={key}
                sectorKey={key}
                chartData={bySector[key]}
                signalCounts={signalCounts?.[key] ?? null}
                onClick={() => { setSelectedSector(key); setSelectedFilter(null); }}
                onSignalClick={filter => { setSelectedSector(key); setSelectedFilter(filter); }}
              />
            ))}
          </div>
          <Sp400Card
            chartData={sp400Data}
            specCounts={specCounts}
            timeRange={timeRange}
            onClickLongs={() => setSpecModal('longs')}
            onClickShorts={() => setSpecModal('shorts')}
          />
        </>
      )}

      {selectedSector && (
        <SectorStocksModal
          sectorKey={selectedSector}
          sectorName={SECTOR_NAMES[selectedSector]}
          filterSignal={selectedFilter}
          onClose={() => { setSelectedSector(null); setSelectedFilter(null); }}
        />
      )}

      {specModal && (
        <Sp400StocksModal
          side={specModal}
          onClose={() => setSpecModal(null)}
        />
      )}
    </div>
  );
}
