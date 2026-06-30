import { useState, useEffect } from 'react';
import AiTickerChartModal from './AiTickerChartModal';
import PageHeader from './PageHeader';
import { fetchAiObOs } from '../services/api';
import styles from './AiObOsPage.module.css';

// PNTHR OB/OS — Overbought / Oversold tracker for the AI Elite 300.
// Eight boxes: each of four categories gets a Daily box and a Weekly box.
// RSI-14 (Wilder) on CLOSED bars. Categories are mutually exclusive and the
// episode peak/trough is carried through the roll (see server/aiObOsService.js).
//
//   rollingOver (OB-1) — still > 70, >= 2 off the peak     78 -> 74
//   brokeDown   (OB-2) — crossed down through 70           78 -> 69
//   turningUp   (OS-1) — still < 30, >= 2 off the trough   22 -> 26
//   brokeOut    (OS-2) — crossed up through 30             22 -> 31

const CATEGORIES = [
  { key: 'rollingOver', title: 'Rolling Over', side: 'ob', blurb: 'RSI still above 70 but turning down (≥2 pts off the peak)' },
  { key: 'brokeDown',   title: 'Broke Below 70', side: 'ob', blurb: 'RSI crossed down through 70 — momentum cooling off' },
  { key: 'turningUp',   title: 'Turning Up', side: 'os', blurb: 'RSI still below 30 but turning up (≥2 pts off the trough)' },
  { key: 'brokeOut',    title: 'Broke Above 30', side: 'os', blurb: 'RSI crossed up through 30 — momentum reviving' },
];

function ObOsBox({ category, timeframe, rows, onTickerClick }) {
  const list = rows || [];
  return (
    <div className={`${styles.box} ${category.side === 'ob' ? styles.boxOb : styles.boxOs}`}>
      <div className={styles.boxHead}>
        <span className={styles.boxTitle}>{category.title}</span>
        <span className={styles.boxTf}>{timeframe}</span>
        <span className={styles.boxCount}>{list.length}</span>
      </div>
      <div className={styles.boxBlurb}>{category.blurb}</div>
      {list.length === 0 ? (
        <div className={styles.empty}>No names</div>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.thTicker}>Ticker</th>
              <th className={styles.thSector}>Sector</th>
              <th className={styles.thRsi}>RSI</th>
              <th className={styles.thPrice}>Price</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r, i) => (
              <tr key={r.ticker}>
                <td>
                  <button
                    className={styles.tickerBtn}
                    onClick={() => onTickerClick(list, i)}
                    title={r.name}
                  >{r.ticker}</button>
                </td>
                <td className={styles.sectorCell} title={r.sectorName || ''}>{r.sectorName || '—'}</td>
                <td className={styles.rsiCell}>
                  <span className={styles.rsiFrom}>{r.from}</span>
                  <span className={styles.rsiArrow}>→</span>
                  <span className={styles.rsiTo}>{r.to}</span>
                </td>
                <td className={styles.priceCell}>{r.price != null ? `$${r.price.toFixed(2)}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function AiObOsPage() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [chartTickers, setChartTickers] = useState([]);
  const [chartIndex, setChartIndex]     = useState(0);

  function load(forceRefresh = false, { silent = false } = {}) {
    if (!silent) setLoading(true);
    setError(null);
    fetchAiObOs(forceRefresh)
      .then(d => {
        if (!d || d.ok === false) throw new Error(d?.error || 'Failed');
        setData(d);
      })
      .catch(err => {
        console.error(err);
        if (!silent) setError('Failed to load OB/OS data. Please try again.');
      })
      .finally(() => { if (!silent) setLoading(false); });
  }

  // Data only changes after the post-close candle cron, but a quiet 60s refresh
  // keeps the page current if it is left open across the close.
  useEffect(() => {
    load();
    const id = setInterval(() => load(false, { silent: true }), 60000);
    return () => clearInterval(id);
  }, []);

  function handleTickerClick(boxRows, idx) {
    setChartTickers(boxRows.map(r => r.ticker));
    setChartIndex(idx);
  }

  const fmtAsOf = iso => {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${m}/${d}/${y}`;
  };

  return (
    <div className={styles.page}>
      <PageHeader
        title="AI 300 OB/OS"
        description="AI Elite 300 names coming out of overbought (RSI > 70) and oversold (RSI < 30), on closed daily and weekly bars."
      />

      <div className={styles.controls}>
        {!loading && !error && data && (
          <span className={styles.asOf}>
            RSI-14 · Daily as of {fmtAsOf(data.daily?.asOf)} · Weekly as of {fmtAsOf(data.weekly?.asOf)}
            {' · '}AI 300 {data.universe?.version || ''} ({data.universe?.count ?? 0} names)
          </span>
        )}
        <button className={styles.refreshBtn} onClick={() => load(true)} disabled={loading}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {loading && (
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <p>Scanning the AI Elite 300 for RSI turns…</p>
        </div>
      )}

      {error && <div className={styles.errorState}>{error}</div>}

      {!loading && !error && data && (
        <>
          <div className={styles.sectionLabel}>
            <span className={styles.dotOb} /> Overbought — rolling over the top
          </div>
          <div className={styles.grid}>
            {CATEGORIES.filter(c => c.side === 'ob').map(cat => (
              <div className={styles.catRow} key={cat.key}>
                <ObOsBox category={cat} timeframe="Daily"  rows={data.daily?.[cat.key]}  onTickerClick={handleTickerClick} />
                <ObOsBox category={cat} timeframe="Weekly" rows={data.weekly?.[cat.key]} onTickerClick={handleTickerClick} />
              </div>
            ))}
          </div>

          <div className={styles.sectionLabel}>
            <span className={styles.dotOs} /> Oversold — bouncing off the bottom
          </div>
          <div className={styles.grid}>
            {CATEGORIES.filter(c => c.side === 'os').map(cat => (
              <div className={styles.catRow} key={cat.key}>
                <ObOsBox category={cat} timeframe="Daily"  rows={data.daily?.[cat.key]}  onTickerClick={handleTickerClick} />
                <ObOsBox category={cat} timeframe="Weekly" rows={data.weekly?.[cat.key]} onTickerClick={handleTickerClick} />
              </div>
            ))}
          </div>
        </>
      )}

      {chartTickers.length > 0 && (
        <AiTickerChartModal
          tickers={chartTickers}
          initialIndex={chartIndex}
          onClose={() => setChartTickers([])}
        />
      )}
    </div>
  );
}
