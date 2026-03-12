import { useState, useEffect } from 'react';
import { fetchPreyStocks, fetchEarnings } from '../services/api';
import ChartModal from './ChartModal';
import styles from './PreyPage.module.css';
import pantherHead from '../assets/panther head.png';

function pct(v) {
  if (v == null) return '—';
  return `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`;
}

function price(v) {
  if (v == null) return '—';
  return `$${Number(v).toFixed(2)}`;
}

function TickerCell({ ticker, companyName }) {
  return (
    <td className={styles.tdTicker}>
      <div className={styles.tickerSymbol}>{ticker}</div>
      {companyName && <div className={styles.companyName}>{companyName}</div>}
    </td>
  );
}

function DirBadge({ direction }) {
  return (
    <span className={`${styles.badge} ${direction === 'long' ? styles.badgeBL : styles.badgeSS}`}>
      {direction === 'long' ? 'BL' : 'SS'}
    </span>
  );
}

function WksBadge({ direction, n }) {
  const label = `${direction === 'long' ? 'BL' : 'SS'}+${n}`;
  return <span className={`${styles.badge} ${styles.badgeWks}`}>{label}</span>;
}

function AlphaRow({ s, onClick }) {
  const isLong = s.direction === 'long';
  return (
    <tr onClick={onClick}>
      <TickerCell ticker={s.ticker} companyName={s.companyName} />
      <td className={styles.td}><DirBadge direction={s.direction} /></td>
      <td className={styles.td}><WksBadge direction={s.direction} n={s.barNumber} /></td>
      <td className={styles.tdNum}>{price(s.currentPrice)}</td>
      <td className={styles.tdNum}>{price(s.ema21)}</td>
      <td className={isLong ? styles.tdPos : styles.tdNeg}>{pct(s.priceDeltaPct)}</td>
      <td className={styles.tdNum}>{s.rsi ?? '—'}</td>
      <td className={styles.tdNum}>{s.adx ?? '—'}</td>
      <td className={styles.td}><span className={`${styles.badge} ${styles.badgeOBV}`}>{s.obvSlope}</span></td>
      <td className={styles.tdGray}>{s.sectorEtf ?? '—'}</td>
      <td className={isLong ? styles.tdPos : styles.tdNeg}>{pct(s.stock4wPct)} vs {pct(s.sector4wPct)}</td>
    </tr>
  );
}

function SpringRow({ s, onClick }) {
  const isLong = s.direction === 'long';
  const wks = s.weeksAbove52 ?? s.weeksBelow52;
  return (
    <tr onClick={onClick}>
      <TickerCell ticker={s.ticker} companyName={s.companyName} />
      <td className={styles.td}><DirBadge direction={s.direction} /></td>
      <td className={styles.tdGray}>T-{s.touchBar}</td>
      <td className={styles.tdNum}>{price(s.currentPrice)}</td>
      <td className={styles.tdNum}>{price(s.ema21)}</td>
      <td className={isLong ? styles.tdPos : styles.tdNeg}>{pct(s.priceDeltaPct)}</td>
      <td className={styles.tdNum}>{wks != null ? `${wks} / 52` : '—'}</td>
      <td className={styles.td}><span className={`${styles.badge} ${styles.badgeOBV}`}>{s.obvSlope}</span></td>
      <td className={styles.tdGray}>{s.sector || '—'}</td>
      <td className={styles.td}><span className={`${styles.badge} ${styles.badgeConfirm}`}>confirmed</span></td>
    </tr>
  );
}

function getEarningsInfo(dateStr) {
  if (!dateStr) return { display: '—', highlight: false, daysAway: null };
  const [y, m, d] = dateStr.split('-').map(Number);
  const earningsDate = new Date(y, m - 1, d);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const daysAway = Math.round((earningsDate - today) / (1000 * 60 * 60 * 24));
  const display = earningsDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return { display, highlight: daysAway >= 0 && daysAway <= 14, daysAway };
}

function DinnerRow({ s, onClick, earnings = {} }) {
  const isLong = s.direction === 'long';
  const stopPrice = s.stopPrice ?? null;
  const riskDollar = stopPrice != null ? Math.abs(s.currentPrice - stopPrice) : null;
  const riskPct = riskDollar != null ? (riskDollar / s.currentPrice) * 100 : null;
  const earningsInfo = getEarningsInfo(earnings[s.ticker]);

  return (
    <tr
      onClick={onClick}
      className={earningsInfo.highlight ? styles.earningsHighlight : undefined}
    >
      <TickerCell ticker={s.ticker} companyName={s.companyName} />
      <td className={styles.td}>
        <span className={`${styles.badge} ${isLong ? styles.badgeBL : styles.badgeSS}`}>{s.strategy}</span>
      </td>
      <td className={styles.tdGray}>{s.exchange || '—'}</td>
      <td className={styles.tdGray}>{s.sector || '—'}</td>
      <td className={styles.tdNum}>{price(s.currentPrice)}</td>
      <td className={styles.tdNum}>{stopPrice != null ? price(stopPrice) : '—'}</td>
      <td className={styles.tdNum}>{riskDollar != null ? `$${riskDollar.toFixed(2)}` : '—'}</td>
      <td className={isLong ? styles.tdNeg : styles.tdPos}>{riskPct != null ? `${riskPct.toFixed(2)}%` : '—'}</td>
      <td className={styles.tdNum}>{s.rsi ?? '—'}</td>
      <td className={styles.td}><span className={`${styles.badge} ${styles.badgeOBV}`}>{s.obvSlope}</span></td>
      <td className={isLong ? styles.tdPos : styles.tdNeg}>{pct(s.priceDeltaPct)}</td>
      <td className={styles.tdGray}>
        {earningsInfo.display}
        {earningsInfo.highlight && (
          <span className={styles.earningsSoonBadge}>
            {earningsInfo.daysAway === 0 ? 'Today' : `${earningsInfo.daysAway}d`}
          </span>
        )}
      </td>
    </tr>
  );
}

function ResultTable({ longs, shorts, RowComponent, headers, onStockClick, rowExtraProps = {} }) {
  const [side, setSide] = useState('long');
  const rows = side === 'long' ? longs : shorts;
  const count = rows?.length ?? 0;

  return (
    <div>
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
        <div className={styles.tableWrap}>
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
                  {...rowExtraProps}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const ALPHA_HEADERS  = ['Ticker', 'Signal', 'Wks Since', 'Price', 'EMA21', 'Δ EMA', 'RSI', 'ADX', 'OBV', 'ETF', '4-Wk α'];
const SPRING_HEADERS = ['Ticker', 'Signal', 'Touch', 'Price', 'EMA21', 'Δ EMA', 'Wks / 52', 'OBV', 'Sector', 'Daylight'];
const DINNER_HEADERS = ['Ticker', 'Signal', 'Exchange', 'Sector', 'Price', 'PNTHR Stop', 'Risk $', 'Risk %', 'RSI', 'OBV', 'Δ EMA', 'Next Earnings'];

export default function PreyPage() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [chartStocks, setChartStocks] = useState([]);
  const [chartIndex, setChartIndex]   = useState(null);
  const [showAlphaGuide, setShowAlphaGuide] = useState(false);
  const [showSpringGuide, setShowSpringGuide] = useState(false);
  const [showDinnerGuide, setShowDinnerGuide] = useState(false);
  const [earnings, setEarnings] = useState({});

  useEffect(() => { load(); }, []);

  async function load(forceRefresh = false) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchPreyStocks(forceRefresh);
      setData(res);
      const dinnerTickers = [
        ...(res.dinner?.longs  || []),
        ...(res.dinner?.shorts || []),
      ].map(s => s.ticker);
      if (dinnerTickers.length > 0) {
        fetchEarnings(dinnerTickers).then(setEarnings);
      }
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

          {/* Dinner */}
          <section className={styles.section}>
            <h2 className={styles.groupTitle}>
              Dinner <span className={styles.groupBadge}>BL+1 · SS+1</span>
              <button
                type="button"
                className={styles.infoBtn}
                onClick={() => setShowDinnerGuide(v => !v)}
                aria-label="Column definitions"
                title="What the columns mean"
              >i</button>
            </h2>
            <p className={styles.groupSubtitle}>One bar past the PNTHR entry signal · still in the zone</p>
            {showDinnerGuide && (
              <div className={styles.columnGuidePopover}>
                <strong>What the columns mean:</strong>
                <ul className={styles.columnGuideList}>
                  <li><strong>Ticker</strong> — Stock symbol.</li>
                  <li><strong>Company</strong> — Company name.</li>
                  <li><strong>Dir</strong> — Direction: Long (bullish) or Short (bearish).</li>
                  <li><strong>Signal</strong> — Entry strategy: BL+1 (one bar past Buy Long) or SS+1 (one bar past Sell Short).</li>
                  <li><strong>Price</strong> — Current share price.</li>
                  <li><strong>EMA21</strong> — 21-week exponential moving average (trend line).</li>
                  <li><strong>Δ EMA</strong> — How far price is above or below the 21-EMA (%).</li>
                  <li><strong>Sector</strong> — Sector the stock belongs to.</li>
                </ul>
              </div>
            )}
            <ResultTable
              longs={data.dinner.longs}
              shorts={data.dinner.shorts}
              RowComponent={DinnerRow}
              headers={DINNER_HEADERS}
              onStockClick={handleStockClick}
              rowExtraProps={{ earnings }}
            />
          </section>

          {/* Alphas */}
          <section className={styles.section}>
            <h2 className={styles.groupTitle}>
              Alphas <span className={styles.groupBadge}>Elite</span>
              <button
                type="button"
                className={styles.infoBtn}
                onClick={() => setShowAlphaGuide(v => !v)}
                aria-label="Column definitions"
                title="What the columns mean"
              >i</button>
            </h2>
            <p className={styles.groupSubtitle}>Maximum trend alignment · institutional accumulation · sector alpha leadership</p>
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
            <h2 className={styles.groupTitle}>
              Springs <span className={styles.groupBadge}>Institutional</span>
              <button
                type="button"
                className={styles.infoBtn}
                onClick={() => setShowSpringGuide(v => !v)}
                aria-label="Column definitions"
                title="What the columns mean"
              >i</button>
            </h2>
            <p className={styles.groupSubtitle}>Long-term trend maturity · 21-EMA touch & relaunch · confirmed daylight</p>
            {showSpringGuide && (
              <div className={styles.columnGuidePopover}>
                <strong>What the columns mean:</strong>
                <ul className={styles.columnGuideList}>
                  <li><strong>Ticker</strong> — Stock symbol.</li>
                  <li><strong>Company</strong> — Company name.</li>
                  <li><strong>Dir</strong> — Direction: Long (bullish) or Short (bearish).</li>
                  <li><strong>Touch</strong> — How many bars ago the stock last touched the 21-EMA.</li>
                  <li><strong>Price</strong> — Current share price.</li>
                  <li><strong>EMA21</strong> — 21-week exponential moving average (trend line).</li>
                  <li><strong>Δ EMA</strong> — How far price is above or below the 21-EMA (%).</li>
                  <li><strong>Wks / 52</strong> — Weeks above (longs) or below (shorts) the EMA out of the last 52 weeks — measures long-term trend maturity.</li>
                  <li><strong>OBV</strong> — On-Balance Volume slope (volume supporting the move).</li>
                  <li><strong>Sector</strong> — Sector the stock belongs to.</li>
                  <li><strong>Daylight</strong> — Confirmed open space between price and EMA after the touch.</li>
                </ul>
              </div>
            )}
            <ResultTable
              longs={data.springs.longs}
              shorts={data.springs.shorts}
              RowComponent={SpringRow}
              headers={SPRING_HEADERS}
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
