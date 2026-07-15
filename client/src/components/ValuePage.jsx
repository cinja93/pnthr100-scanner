import { useState, useEffect } from 'react';
import AiTickerChartModal from './AiTickerChartModal';
import PageHeader from './PageHeader';
import { fetchAiValue } from '../services/api';
import styles from './ValuePage.module.css';

// PNTHR Value — the AI-300 "bottoming" screen. Genuinely beaten names, long
// below their sector-optimized EMA (OpEMA) line, grouped by where they are in
// the turn. See server/aiValueService.js for the exact math + integrity checks.

// Box metadata is built from the server's knobs so the definitions in each box
// header always match the thresholds the engine actually used.
function buildBoxDefs(K) {
  return [
    { key: 'turned', title: 'Turned up', cls: styles.boxTurned, dot: styles.dotTurned,
      def: `Beaten ≥${K.BEATEN}% off its high, ≥${K.BASEMIN} weeks below the line since that high, and now back above it within the last ${K.RECLAIM_W} weeks. The actionable list.` },
    { key: 'line', title: 'At the line', cls: styles.boxLine, dot: styles.dotLine,
      def: `Beaten & long-based, still just below the line — within ${K.NEAR_BAND}% of it. About to resolve either way.` },
    { key: 'basing', title: 'Basing', cls: styles.boxBasing, dot: styles.dotBasing,
      def: `Beaten ≥${K.BEATEN}% off and ≥${K.BASEMIN} weeks below the line (since its high), still more than ${K.NEAR_BAND}% under it. Building — the deep watch list.` },
    { key: 'other', title: 'All others', cls: styles.boxOther, dot: styles.dotOther,
      def: `Not a bottoming candidate — healthy / long above the line, not beaten ≥${K.BEATEN}%, or too young for an OpEMA. Includes any data-flagged names.` },
  ];
}

const fmtPct = v => (v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(1) + '%');

const COLS = [
  { k: 'name',   label: 'Company', txt: true },
  { k: 'ticker', label: 'Ticker',  txt: true },
  { k: 'd52',    label: 'Off 52-wk high' },
  { k: 'wk',     label: '1-wk' },
  { k: 'light',  label: 'vs OpEMA' },
  { k: 'wb',     label: 'Wks below*' },
  { k: 'wa',     label: 'Abv (last 5)' },
  { k: 'last',   label: 'Last' },
];

function sortValue(r, k, reclaimW) {
  switch (k) {
    case 'd52':   return r.suspect ? -1 : r.d52;
    case 'wk':    return r.wk ?? 0;
    case 'light': return r.opema == null ? 999 : r.light;
    case 'wb':    return r.opema == null ? -1 : r.wksBelow;
    case 'wa':    return r.opema == null ? -1 : r.wksAbove;
    case 'last':  return r.last ?? 0;
    case 'ticker': return r.ticker;
    case 'name':  return r.name;
    default:      return 0;
  }
}

function ValueRow({ r, list, idx, onTickerClick, reclaimW }) {
  const flagged = r.suspect;
  const wcls = r.wk > 0 ? styles.up : (r.wk < 0 ? styles.down : styles.flat);
  const barW = Math.max(0, Math.min(100, r.d52 || 0));
  // wksBelow = weeks below the line since its high; wksAbove = # of last 5 weeks above.
  // Both are meaningful whenever the name has an OpEMA line.
  const showWb = !flagged && r.opema != null;
  const showWa = !flagged && r.opema != null;
  return (
    <tr className={flagged ? styles.flaggedRow : undefined}>
      <td className={styles.nameCell}>
        <span className={styles.nm}>{r.name}</span>
        <span className={styles.secsub} title={r.sector || ''}>{r.sector || '—'}</span>
      </td>
      <td className={styles.tickerCell}>
        <button className={styles.tickerBtn} onClick={() => onTickerClick(list, idx)} title={r.name}>{r.ticker}</button>
        {r.reclaim && !flagged && <span className={styles.rcMark} title="Reclaimed the OpEMA line this week">{'⤴'}</span>}
        {flagged && <span className={styles.flagMark} title={r.suspectReason || 'data-suspect'}>{'⚠'}</span>}
        {r.volatile && !flagged && <span className={styles.volMark} title="Had a 40%+ single-session move (real volatility)">{'●'}</span>}
      </td>
      <td className={styles.d52Cell}>
        <span className={styles.bar} style={{ width: `${barW}%` }} />
        <span className={styles.d52Val}>
          {r.deep && !flagged && <span className={styles.deepMark} title={'Deep drawdown'}>{'◆'}</span>}
          {flagged ? '—' : `${r.d52.toFixed(1)}%`}
        </span>
      </td>
      <td className={`${styles.numCell} ${wcls}`}>{fmtPct(r.wk)}</td>
      <td className={styles.numCell}>
        {flagged || r.opema == null ? <span className={styles.muted}>{'—'}</span> : (
          <span className={r.side === 'below' ? styles.down : styles.up}>
            {r.side === 'below' ? '▼' : '▲'} {fmtPct(r.light)}
          </span>
        )}
      </td>
      <td className={`${styles.numCell} ${styles.wbCell}`}>{showWb ? r.wksBelow : <span className={styles.muted}>{'—'}</span>}</td>
      <td className={`${styles.numCell} ${styles.wbCell}`}>{showWa ? r.wksAbove : <span className={styles.muted}>{'—'}</span>}</td>
      <td className={`${styles.numCell} ${styles.lastCell}`}>${(r.last ?? 0).toFixed(2)}</td>
    </tr>
  );
}

function ValueBox({ def, rows, sortKey, sortDir, onSort, onTickerClick, reclaimW }) {
  const list = (rows || []).slice().sort((a, b) => {
    const av = sortValue(a, sortKey, reclaimW), bv = sortValue(b, sortKey, reclaimW);
    if (typeof av === 'string') return av.localeCompare(bv) * sortDir;
    return (av - bv) * sortDir;
  });
  return (
    <div className={`${styles.box} ${def.cls}`}>
      <div className={styles.boxHead}>
        <span className={`${styles.boxDot} ${def.dot}`} />
        <div className={styles.boxTitleWrap}>
          <div className={styles.boxTitle}>{def.title}</div>
          <div className={styles.boxDef}>{def.def}</div>
        </div>
        <span className={styles.boxCount}>{list.length}</span>
      </div>
      <div className={styles.boxBody}>
        {list.length === 0 ? (
          <div className={styles.empty}>No names</div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                {COLS.map(c => (
                  <th
                    key={c.k}
                    className={`${c.txt ? styles.thTxt : styles.thNum} ${sortKey === c.k ? (sortDir === 1 ? styles.sortAsc : styles.sortDesc) : ''}`}
                    onClick={() => onSort(c.k)}
                  >{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.map((r, i) => (
                <ValueRow key={r.ticker} r={r} list={list} idx={i} onTickerClick={onTickerClick} reclaimW={reclaimW} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default function ValuePage() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [chartTickers, setChartTickers] = useState([]);
  const [chartIndex, setChartIndex]     = useState(0);
  const [sortKey, setSortKey] = useState('d52');
  const [sortDir, setSortDir] = useState(-1);   // deepest first

  function load(forceRefresh = false, { silent = false } = {}) {
    if (!silent) setLoading(true);
    setError(null);
    fetchAiValue(forceRefresh)
      .then(d => {
        if (!d || d.ok === false) throw new Error(d?.error || 'Failed');
        setData(d);
      })
      .catch(err => {
        console.error(err);
        if (!silent) setError('Failed to load Value data. Please try again.');
      })
      .finally(() => { if (!silent) setLoading(false); });
  }

  useEffect(() => {
    load();
    const id = setInterval(() => load(false, { silent: true }), 60000);
    return () => clearInterval(id);
  }, []);

  function handleSort(k) {
    if (k === sortKey) setSortDir(d => -d);
    else { setSortKey(k); setSortDir(k === 'name' || k === 'ticker' ? 1 : -1); }
  }

  function handleTickerClick(boxRows, idx) {
    setChartTickers(boxRows.map(r => r.ticker));
    setChartIndex(idx);
  }

  const fmtAsOf = iso => {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${m}/${d}/${y}`;
  };

  const K = data?.knobs;
  const boxDefs = K ? buildBoxDefs(K) : [];

  return (
    <div className={styles.page}>
      <PageHeader
        title="Value"
        description="The AI Elite 300 bottoming screen. Genuinely beaten names, long below their OpEMA line, grouped by where they are in the turn: turned up, at the line, basing, or not yet a candidate."
      />

      <div className={styles.controls}>
        {!loading && !error && data && (
          <span className={styles.asOf}>
            Prices {fmtAsOf(data.asOf)} {'·'} OpEMA wk ending {fmtAsOf(data.weekEnding)}
            {' · '}AI 300 {data.universe?.version || ''} ({data.counts?.candidates ?? 0} candidates of {data.universe?.count ?? 0})
          </span>
        )}
        <button className={styles.refreshBtn} onClick={() => load(true)} disabled={loading}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {!loading && !error && data && (
        <div className={styles.legend}>
          <strong>Wks below*</strong> = weeks the close was below the OpEMA line since it made its high &nbsp;·&nbsp;
          <strong>Abv (last 5)</strong> = weeks above the line in the last 5 (recency) &nbsp;·&nbsp;
          <span className={styles.deepMark}>◆</span> deep (≥{K.DEEP}% off) &nbsp;·&nbsp;
          <span className={styles.rcMark}>⤴</span> crossed above the line this week &nbsp;·&nbsp;
          reflects the last <strong>closed</strong> weekly bar (wk ending {fmtAsOf(data.weekEnding)})
        </div>
      )}

      {loading && (
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <p>Scanning the AI Elite 300 for real bottoms…</p>
        </div>
      )}

      {error && <div className={styles.errorState}>{error}</div>}

      {!loading && !error && data && (
        <div className={styles.grid}>
          {boxDefs.map(def => (
            <ValueBox
              key={def.key}
              def={def}
              rows={data.boxes?.[def.key]}
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              onTickerClick={handleTickerClick}
              reclaimW={K.RECLAIM_W}
            />
          ))}
        </div>
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
