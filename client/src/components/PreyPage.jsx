import { useState, useEffect } from 'react';
import { fetchPreyStocks } from '../services/api';
import ChartModal from './ChartModal';
import styles from './PreyPage.module.css';
import pantherHead from '../assets/panther head.png';

const GROUPS = [
  { key: 'alphas',  label: 'Alphas',  subtitle: 'Elite Alpha Longs & Shorts — maximum trend alignment' },
  { key: 'springs', label: 'Springs', subtitle: 'PNTHR Spring — institutional powerhouses off the 21-EMA floor/ceiling' },
  { key: 'dinner',  label: 'Dinner',  subtitle: 'BL+1 & SS+1 — one bar past entry, still in the zone' },
];

function pct(v) {
  if (v == null) return '—';
  return `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`;
}

function price(v) {
  if (v == null) return '—';
  return `$${Number(v).toFixed(2)}`;
}

function AlphaRow({ s, onClick }) {
  return (
    <tr
      className={`${s.direction === 'long' ? styles.rowLong : styles.rowShort} ${styles.clickableRow}`}
      onClick={onClick}
    >
      <td className={styles.tdTicker}>{s.ticker}</td>
      <td className={styles.tdName}>{s.companyName || '—'}</td>
      <td className={styles.tdDir}>{s.direction === 'long' ? '▲ Long' : '▼ Short'}</td>
      <td className={styles.tdBar}>Bar {s.barNumber}</td>
      <td className={styles.tdPrice}>{price(s.currentPrice)}</td>
      <td className={styles.tdEma}>{price(s.ema21)}</td>
      <td className={s.direction === 'long' ? styles.tdDeltaPos : styles.tdDeltaNeg}>{pct(s.priceDeltaPct)}</td>
      <td className={styles.tdStat}>{s.rsi ?? '—'}</td>
      <td className={styles.tdStat}>{s.adx ?? '—'}</td>
      <td className={styles.tdObv}>
        <span className={styles.obvPill}>{s.obvSlope}</span>
      </td>
      <td className={styles.tdSector}>{s.sectorEtf ?? '—'}</td>
      <td className={s.direction === 'long' ? styles.tdDeltaPos : styles.tdDeltaNeg}>
        {pct(s.stock4wPct)} vs {pct(s.sector4wPct)}
      </td>
    </tr>
  );
}

function SpringRow({ s, onClick }) {
  return (
    <tr
      className={`${s.direction === 'long' ? styles.rowLong : styles.rowShort} ${styles.clickableRow}`}
      onClick={onClick}
    >
      <td className={styles.tdTicker}>{s.ticker}</td>
      <td className={styles.tdName}>{s.companyName || '—'}</td>
      <td className={styles.tdDir}>{s.direction === 'long' ? '▲ Long' : '▼ Short'}</td>
      <td className={styles.tdBar}>T-{s.touchBar} touch</td>
      <td className={styles.tdPrice}>{price(s.currentPrice)}</td>
      <td className={styles.tdEma}>{price(s.ema21)}</td>
      <td className={s.direction === 'long' ? styles.tdDeltaPos : styles.tdDeltaNeg}>{pct(s.priceDeltaPct)}</td>
      <td className={styles.tdStat} colSpan={2}>{s.weeksAbove52 ?? s.weeksBelow52 ?? '—'} / 52 wks</td>
      <td className={styles.tdObv}>
        <span className={styles.obvPill}>{s.obvSlope}</span>
      </td>
      <td className={styles.tdSector}>{s.sector || '—'}</td>
      <td className={styles.tdSignal}>
        <span className={styles.signalPill}>confirmed</span>
      </td>
    </tr>
  );
}

function DinnerRow({ s, onClick }) {
  return (
    <tr
      className={`${s.direction === 'long' ? styles.rowLong : styles.rowShort} ${styles.clickableRow}`}
      onClick={onClick}
    >
      <td className={styles.tdTicker}>{s.ticker}</td>
      <td className={styles.tdName}>{s.companyName || '—'}</td>
      <td className={styles.tdDir}>{s.direction === 'long' ? '▲ Long' : '▼ Short'}</td>
      <td className={styles.tdSignal}>
        <span className={styles.signalPill}>{s.strategy}</span>
      </td>
      <td className={styles.tdPrice}>{price(s.currentPrice)}</td>
      <td className={styles.tdEma}>{price(s.ema21)}</td>
      <td className={s.direction === 'long' ? styles.tdDeltaPos : styles.tdDeltaNeg}>{pct(s.priceDeltaPct)}</td>
      <td className={styles.tdStat} colSpan={2}>—</td>
      <td className={styles.tdObv}>—</td>
      <td className={styles.tdSector}>{s.sector || '—'}</td>
      <td>—</td>
    </tr>
  );
}

function ResultTable({ longs, shorts, RowComponent, headers, onStockClick }) {
  const [side, setSide] = useState('long');
  const rows = side === 'long' ? longs : shorts;
  const count = rows?.length ?? 0;

  return (
    <div className={styles.tableWrap}>
      <div className={styles.sideToggle}>
        <button
          className={`${styles.sideBtn} ${side === 'long' ? styles.sideBtnLong : ''}`}
          onClick={() => setSide('long')}
        >
          Longs ({longs?.length ?? 0})
        </button>
        <button
          className={`${styles.sideBtn} ${side === 'short' ? styles.sideBtnShort : ''}`}
          onClick={() => setSide('short')}
        >
          Shorts ({shorts?.length ?? 0})
        </button>
      </div>

      {count === 0 ? (
        <div className={styles.empty}>No {side} candidates found this week.</div>
      ) : (
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                {headers.map(h => <th key={h} className={styles.th}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((s, i) => (
                <RowComponent
                  key={s.ticker + i}
                  s={s}
                  onClick={() => onStockClick?.(s, rows, i)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const ALPHA_HEADERS  = ['Ticker', 'Company', 'Dir', 'Bar', 'Price', 'EMA21', 'Δ EMA', 'RSI', 'ADX', 'OBV', 'ETF', '4-Wk α'];
const SPRING_HEADERS = ['Ticker', 'Company', 'Dir', 'Touch', 'Price', 'EMA21', 'Δ EMA', 'Wks / 52', '', 'OBV', 'Sector', 'Daylight'];
const DINNER_HEADERS = ['Ticker', 'Company', 'Dir', 'Signal', 'Price', 'EMA21', 'Δ EMA', '', '', 'OBV', 'Sector', ''];

export default function PreyPage() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [chartStocks, setChartStocks] = useState([]);
  const [chartIndex, setChartIndex]   = useState(null);
  const [showAlphaGuide, setShowAlphaGuide] = useState(false);

  useEffect(() => { load(); }, []);

  async function load(forceRefresh = false) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchPreyStocks(forceRefresh);
      setData(res);
    } catch (e) {
      setError(e.message || 'Scan failed.');
    } finally {
      setLoading(false);
    }
  }

  function handleStockClick(stock, list, index) {
    if (!stock || !Array.isArray(list)) return;
    setChartStocks(list);
    setChartIndex(index ?? list.indexOf(stock));
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>
            <img src={pantherHead} alt="PNTHR" className={styles.pantherLogo} />
            PNTHR PREY
          </h1>
          <p className={styles.subtitle}>679 stocks · Sector-filtered · Three precision strategies</p>
        </div>
        <button className={styles.refreshBtn} onClick={() => load(true)} disabled={loading}>
          {loading ? 'Scanning…' : '↻ Refresh'}
        </button>
      </div>

      {loading && (
        <div className={styles.loadingWrap}>
          <div className={styles.spinner} />
          <p className={styles.loadingText}>Running PREY scan across 679 stocks…</p>
          <p className={styles.loadingNote}>First run may take 30–60 seconds. Results are cached weekly.</p>
        </div>
      )}

      {error && (
        <div className={styles.error}>
          ⚠️ {error}
          <button className={styles.retryBtn} onClick={() => load(true)}>Retry</button>
        </div>
      )}

      {!loading && data && (
        <>
          <div className={styles.meta}>
            Scanned {data.totalScanned} stocks · {data.scannedAt ? new Date(data.scannedAt).toLocaleString() : ''}
          </div>

          {/* Sector Sentinel status bar */}
          <div className={styles.sectorBar}>
            {Object.entries(data.sectorStatus || {}).map(([etf, status]) => (
              <span key={etf} className={status === 'above' ? styles.sectorUp : styles.sectorDown}>
                {etf} {status === 'above' ? '▲' : '▼'}
              </span>
            ))}
          </div>

          {/* Alphas */}
          <section className={styles.section}>
            <div className={styles.sectionTitleRow}>
              <div>
                <h2 className={styles.groupTitle}>Alphas <span className={styles.groupBadge}>Elite</span></h2>
                <p className={styles.groupSubtitle}>Maximum trend alignment · institutional accumulation · sector alpha leadership</p>
              </div>
              <button
                type="button"
                className={styles.infoBtn}
                onClick={() => setShowAlphaGuide(v => !v)}
                aria-label="Column definitions"
                title="What the columns mean"
              >
                i
              </button>
            </div>
            {showAlphaGuide && (
              <div className={styles.columnGuidePopover}>
                <strong>What the columns mean:</strong>
                <ul className={styles.columnGuideList}>
                  <li><strong>Ticker</strong> — Stock symbol.</li>
                  <li><strong>Company</strong> — Company name.</li>
                  <li><strong>Dir</strong> — Direction: Long (bullish) or Short (bearish).</li>
                  <li><strong>Bar</strong> — Which weekly bar since the trend signal (Bar 1 = first week).</li>
                  <li><strong>Price</strong> — Current share price.</li>
                  <li><strong>EMA21</strong> — 21-week exponential moving average (trend line).</li>
                  <li><strong>Δ EMA</strong> — How far price is above or below the 21-EMA (%).</li>
                  <li><strong>RSI</strong> — Relative Strength Index (momentum; 0–100).</li>
                  <li><strong>ADX</strong> — Trend strength (higher = stronger trend).</li>
                  <li><strong>OBV</strong> — On-Balance Volume slope (volume supporting the move).</li>
                  <li><strong>ETF</strong> — Sector ETF this stock is grouped with.</li>
                  <li><strong>4-Wk α</strong> — Stock 4-wk return vs sector 4-wk return (outperformance).</li>
                </ul>
              </div>
            )}
            <ResultTable
              longs={data.alphas.longs}
              shorts={data.alphas.shorts}
              RowComponent={AlphaRow}
              headers={ALPHA_HEADERS}
              onStockClick={handleStockClick}
            />
          </section>

          {/* Springs */}
          <section className={styles.section}>
            <h2 className={styles.groupTitle}>Springs <span className={styles.groupBadge}>Institutional</span></h2>
            <p className={styles.groupSubtitle}>Long-term trend maturity · 21-EMA touch & relaunch · confirmed daylight</p>
            <ResultTable
              longs={data.springs.longs}
              shorts={data.springs.shorts}
              RowComponent={SpringRow}
              headers={SPRING_HEADERS}
              onStockClick={handleStockClick}
            />
          </section>

          {/* Dinner */}
          <section className={styles.section}>
            <h2 className={styles.groupTitle}>Dinner <span className={styles.groupBadge}>BL+1 · SS+1</span></h2>
            <p className={styles.groupSubtitle}>One bar past the PNTHR entry signal · still in the zone</p>
            <ResultTable
              longs={data.dinner.longs}
              shorts={data.dinner.shorts}
              RowComponent={DinnerRow}
              headers={DINNER_HEADERS}
              onStockClick={handleStockClick}
            />
          </section>
        </>
      )}

      {chartIndex != null && chartStocks.length > 0 && (
        <ChartModal
          stocks={chartStocks}
          initialIndex={chartIndex}
          earnings={{}}
          onClose={() => setChartIndex(null)}
        />
      )}
    </div>
  );
}
