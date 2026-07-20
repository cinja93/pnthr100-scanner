import { useState, useEffect, useMemo } from 'react';
import AiTickerChartModal from './AiTickerChartModal';
import PageHeader from './PageHeader';
import { fetchDailyRank } from '../services/api';
import styles from './DailyRankPage.module.css';

// PNTHR Daily Rank — every AI Elite 300 name ranked by today's move against the
// previous session's close. Biggest gainer at the top, biggest decliner at the
// bottom. Live through the session. See server/dailyRankService.js for the math
// and the split / prior-close integrity checks.

const COLS = [
  { k: 'rank',      label: '#',        w: 'colRank' },
  { k: 'ticker',    label: 'Ticker',   txt: true },
  { k: 'name',      label: 'Company',  txt: true },
  { k: 'sector',    label: 'Sector',   txt: true },
  { k: 'signal',    label: 'Signal',   txt: true },
  { k: 'price',     label: 'Last' },
  { k: 'change',    label: 'Chg $' },
  { k: 'changePct', label: 'Chg %' },
  { k: 'relVol',    label: 'Rel Vol' },
];

function sortValue(r, k) {
  switch (k) {
    case 'rank':      return r.rank;
    case 'ticker':    return r.ticker;
    case 'name':      return r.name || '';
    case 'sector':    return r.sector || '';
    case 'signal':    return r.signalLabel || '';
    case 'price':     return r.price ?? 0;
    case 'change':    return r.change ?? 0;
    case 'changePct': return r.changePct ?? 0;
    case 'relVol':    return r.relVol ?? -1;
    default:          return 0;
  }
}

const fmtPct = v => (v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + '%');
const fmtChg = v => (v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(2));

function RankRow({ r, list, idx, onTickerClick, maxAbs }) {
  const dir = r.changePct > 0 ? styles.up : (r.changePct < 0 ? styles.down : styles.flat);
  // Bar length is relative to the biggest absolute move on the board, so the
  // shape of the day reads at a glance without needing to parse every number.
  const barW = maxAbs > 0 ? Math.min(100, (Math.abs(r.changePct) / maxAbs) * 100) : 0;
  const sig = r.signalLabel;
  const sigCls = !sig ? null : (sig.startsWith('BL') ? styles.sigBl : styles.sigSs);

  return (
    <tr className={r.suspect ? styles.flaggedRow : undefined}>
      <td className={styles.rankCell}>{r.rank}</td>
      <td className={styles.tickerCell}>
        <button className={styles.tickerBtn} onClick={() => onTickerClick(list, idx)} title={r.name}>
          {r.ticker}
        </button>
        {r.suspect && (
          <span className={styles.flagMark} title={r.suspectReason || 'data-suspect'}>{'⚠'}</span>
        )}
      </td>
      <td className={styles.nameCell} title={r.name}>{r.name}</td>
      <td className={styles.sectorCell} title={r.sector || ''}>{r.sector || '—'}</td>
      <td className={styles.sigCell}>
        {sig ? <span className={`${styles.sigChip} ${sigCls}`}>{sig}</span>
             : <span className={styles.muted}>{'—'}</span>}
      </td>
      <td className={styles.numCell}>${(r.price ?? 0).toFixed(2)}</td>
      <td className={`${styles.numCell} ${dir}`}>{fmtChg(r.change)}</td>
      <td className={styles.pctCell}>
        <span className={`${styles.bar} ${r.changePct >= 0 ? styles.barUp : styles.barDown}`}
              style={{ width: `${barW}%` }} />
        <span className={`${styles.pctVal} ${dir}`}>{fmtPct(r.changePct)}</span>
      </td>
      <td className={`${styles.numCell} ${r.relVol >= 1.5 ? styles.hot : ''}`}>
        {r.relVol == null ? <span className={styles.muted}>{'—'}</span> : `${r.relVol.toFixed(2)}x`}
      </td>
    </tr>
  );
}

export default function DailyRankPage() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [chart, setChart]     = useState(null);      // { tickers, index }
  const [sortKey, setSortKey] = useState('changePct');
  const [sortDir, setSortDir] = useState(-1);        // biggest gainers first
  const [query, setQuery]     = useState('');

  function load(forceRefresh = false, { silent = false } = {}) {
    if (!silent) setLoading(true);
    setError(null);
    fetchDailyRank(forceRefresh)
      .then(d => {
        if (!d || d.ok === false) throw new Error(d?.error || 'Failed');
        setData(d);
      })
      .catch(err => {
        console.error(err);
        if (!silent) setError('Failed to load Daily Rank. Please try again.');
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
    else { setSortKey(k); setSortDir(k === 'ticker' || k === 'name' || k === 'sector' || k === 'signal' ? 1 : -1); }
  }

  // The list the modal pages through is exactly the list on screen, in the
  // order it is on screen, so prev/next walks the ranking you are looking at.
  function handleTickerClick(list, idx) {
    setChart({ tickers: list.map(r => r.ticker), index: idx });
  }

  const rows = useMemo(() => {
    const q = query.trim().toUpperCase();
    const base = (data?.rows || []).filter(r =>
      !q || r.ticker.includes(q) || (r.name || '').toUpperCase().includes(q) || (r.sector || '').toUpperCase().includes(q)
    );
    return base.slice().sort((a, b) => {
      const av = sortValue(a, sortKey), bv = sortValue(b, sortKey);
      if (typeof av === 'string') return av.localeCompare(bv) * sortDir;
      return (av - bv) * sortDir;
    });
  }, [data, sortKey, sortDir, query]);

  const maxAbs = useMemo(
    () => rows.reduce((m, r) => Math.max(m, Math.abs(r.changePct || 0)), 0),
    [rows]
  );

  const c = data?.counts;
  const breadthTotal = c ? (c.advancers + c.decliners + c.unchanged) : 0;
  const advPct = breadthTotal ? (c.advancers / breadthTotal) * 100 : 0;

  const fmtAsOf = iso => {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
    }) + ' ET';
  };

  return (
    <div className={styles.page}>
      <PageHeader
        title="Daily Rank"
        description="Every AI Elite 300 name ranked by today's move against the previous session's close. Biggest gainers at the top, biggest decliners at the bottom. Updates live through the trading day."
      />

      <div className={styles.controls}>
        {!loading && !error && data && (
          <span className={styles.asOf}>
            <span className={styles.liveDot} /> {fmtAsOf(data.asOf)}
            {' · '}session {data.sessionDate}
            {' · '}AI 300 {data.universe?.version || ''} ({data.universe?.withData ?? 0} of {data.universe?.count ?? 0} priced)
          </span>
        )}
        <input
          className={styles.search}
          type="text"
          placeholder="Filter ticker, company, sector…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <button className={styles.refreshBtn} onClick={() => load(true)} disabled={loading}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {!loading && !error && data && c && (
        <div className={styles.breadth}>
          <div className={styles.breadthBar}>
            <span className={styles.breadthUp} style={{ width: `${advPct}%` }} />
          </div>
          <div className={styles.breadthText}>
            <strong className={styles.up}>{c.advancers} up</strong>
            {' · '}
            <strong className={styles.down}>{c.decliners} down</strong>
            {c.unchanged > 0 && <>{' · '}<span className={styles.muted}>{c.unchanged} flat</span></>}
            {c.suspect > 0 && (
              <>{' · '}<span className={styles.flagMark} title="Prior close did not reconcile with our own candle store, or a split is pending. Shown dimmed, not ranked on trust.">
                {'⚠'} {c.suspect} data-flagged
              </span></>
            )}
            {c.unverified > 0 && (
              <>{' · '}<span className={styles.muted} title="Our candle store has not caught up, so the prior close could not be cross-checked.">
                {c.unverified} unverified
              </span></>
            )}
          </div>
        </div>
      )}

      {loading && (
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <p>Pricing the AI Elite 300…</p>
        </div>
      )}

      {error && <div className={styles.errorState}>{error}</div>}

      {!loading && !error && data && (
        <div className={styles.tableWrap}>
          {rows.length === 0 ? (
            <div className={styles.empty}>No names match that filter</div>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  {COLS.map(col => (
                    <th
                      key={col.k}
                      className={`${col.txt ? styles.thTxt : styles.thNum} ${styles[col.w] || ''} ${sortKey === col.k ? (sortDir === 1 ? styles.sortAsc : styles.sortDesc) : ''}`}
                      onClick={() => handleSort(col.k)}
                    >{col.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <RankRow
                    key={r.ticker}
                    r={r}
                    list={rows}
                    idx={i}
                    onTickerClick={handleTickerClick}
                    maxAbs={maxAbs}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {chart && (
        <AiTickerChartModal
          tickers={chart.tickers}
          initialIndex={chart.index}
          onClose={() => setChart(null)}
        />
      )}
    </div>
  );
}
