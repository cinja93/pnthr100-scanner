import { useState, useEffect, useMemo, useRef } from 'react';
import { fetchAiMembers } from '../services/api';
import AiTickerChartModal from './AiTickerChartModal';
import styles from './AiMembersPage.module.css';

// AI Members — the AI 300 Index roster as a live, browsable list (replaces the static PDF).
// Tabs: Current Positions (default, matched to the real IBKR account), Alphabetical, By Sector,
// and Search. Selecting any name opens its summary (PNTHR thesis + held status + View Chart).
// Admin-only (the page is gated in the sidebar and the /api/ai-members endpoint requires admin).

const TABS = [
  { key: 'positions', label: 'Current Positions' },
  { key: 'alpha',     label: 'Alphabetical' },
  { key: 'sector',    label: 'By Sector' },
  { key: 'search',    label: 'Search' },
];

// Current Positions columns — sortable. `cls` reuses the body column widths; `type`
// drives string vs numeric sort. Numeric columns default to descending (biggest first).
const POS_COLS = [
  { key: 'ticker',        label: 'Ticker',      type: 'str', cls: 'ticker' },
  { key: 'companyName',   label: 'Company',     type: 'str', cls: 'company' },
  { key: 'sector',        label: 'Sector',      type: 'str', cls: 'sectorCell' },
  { key: 'shares',        label: 'Shares',      type: 'num', cls: 'numCell' },
  { key: 'marketPrice',   label: 'Price',       type: 'num', cls: 'numCell' },
  { key: 'marketValue',   label: 'Mkt Value',   type: 'num', cls: 'numCell' },
  { key: 'unrealizedPnl', label: 'Unreal. P&L', type: 'num', cls: 'numCell' },
];

const fmtMoney = (n) => (n == null ? '—' : (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString());
const fmtPx    = (n) => (n == null ? '—' : '$' + Number(n).toFixed(2));
const fmtShares = (n) => (n == null ? '—' : Math.round(n).toLocaleString());

function HeldPnl({ m }) {
  if (!m.held) return <span className={styles.dim}>—</span>;
  const pnl = m.unrealizedPnl;
  const cls = pnl == null ? '' : pnl >= 0 ? styles.pnlPos : styles.pnlNeg;
  return <span className={cls}>{fmtMoney(pnl)}</span>;
}

export default function AiMembersPage({ isAdmin = true }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [tab, setTab]         = useState('positions');
  const [query, setQuery]     = useState('');
  const [selected, setSelected]       = useState(null);   // member -> summary modal
  const [chartGroup, setChartGroup]   = useState(null);   // { tickers, index } -> scrollable AiTickerChartModal group
  const [posSort, setPosSort]         = useState({ key: 'marketValue', dir: 'desc' });   // Current Positions sort
  const searchRef = useRef(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try { setLoading(true); const d = await fetchAiMembers(); if (alive) { setData(d); setError(null); } }
      catch (e) { if (alive) setError(e.message || 'Failed to load AI members'); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => { if (tab === 'search' && searchRef.current) searchRef.current.focus(); }, [tab]);

  const members = data?.members || [];
  const sectors = data?.sectors || [];

  const held = useMemo(
    () => members.filter(m => m.held).sort((a, b) => (b.marketValue || 0) - (a.marketValue || 0)),
    [members]);
  const alpha = useMemo(() => [...members].sort((a, b) => a.ticker.localeCompare(b.ticker)), [members]);
  const bySector = useMemo(() => {
    const map = {};
    for (const m of members) (map[m.sectorId] = map[m.sectorId] || []).push(m);
    for (const k of Object.keys(map)) map[k].sort((a, b) => a.ticker.localeCompare(b.ticker));
    return map;
  }, [members]);
  const results = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return [];
    return members
      .filter(m => m.ticker.toUpperCase().includes(q) || (m.companyName || '').toUpperCase().includes(q))
      .sort((a, b) => {
        const at = a.ticker.toUpperCase(), bt = b.ticker.toUpperCase();
        if (at === q && bt !== q) return -1;
        if (bt === q && at !== q) return 1;
        const as = at.startsWith(q), bs = bt.startsWith(q);
        if (as && !bs) return -1;
        if (bs && !as) return 1;
        return at.localeCompare(bt);
      })
      .slice(0, 60);
  }, [members, query]);

  // Current Positions, sorted by the active column.
  const heldSorted = useMemo(() => {
    const { key, dir } = posSort;
    const mult = dir === 'asc' ? 1 : -1;
    const col = POS_COLS.find(c => c.key === key) || POS_COLS[5];
    return [...held].sort((a, b) => {
      if (col.type === 'str') return String(a[key] || '').localeCompare(String(b[key] || '')) * mult;
      const av = a[key] == null ? -Infinity : a[key];
      const bv = b[key] == null ? -Infinity : b[key];
      return (av - bv) * mult;
    });
  }, [held, posSort]);

  function handleSort(key) {
    setPosSort(prev => prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: (POS_COLS.find(c => c.key === key)?.type === 'str') ? 'asc' : 'desc' });
  }

  // Ordered tickers of whatever the active tab is showing — so the chart group
  // scrolls through exactly what you're looking at (in its current order).
  function viewTickers() {
    if (tab === 'positions') return heldSorted.map(m => m.ticker);
    if (tab === 'alpha')     return alpha.map(m => m.ticker);
    if (tab === 'sector')    return [...sectors].sort((a, b) => a.id - b.id).flatMap(s => (bySector[s.id] || []).map(m => m.ticker));
    if (tab === 'search')    return results.map(m => m.ticker);
    return [];
  }

  function openChart(ticker) {
    const list = viewTickers();
    const idx = Math.max(0, list.indexOf(ticker));
    setChartGroup({ tickers: list.length ? list : [ticker], index: idx });
    setSelected(null);   // close the summary so the chart's prev/next isn't confusing
  }

  if (!isAdmin) {
    return <div className={styles.page}><div className={styles.empty}>This page is admin-only.</div></div>;
  }

  const heldCount = data?.heldCount ?? held.length;
  const asOf = data?.asOf ? new Date(data.asOf) : null;

  function Row({ m, showPosition }) {
    return (
      <button className={styles.row} onClick={() => setSelected(m)}>
        <span className={styles.ticker}>{m.ticker}</span>
        <span className={styles.company}>{m.companyName}</span>
        <span className={styles.sectorCell}>{m.sector}</span>
        {showPosition ? (
          <>
            <span className={styles.numCell}>{fmtShares(m.shares)}</span>
            <span className={styles.numCell}>{fmtPx(m.marketPrice)}</span>
            <span className={styles.numCell}>{fmtMoney(m.marketValue)}</span>
            <span className={styles.numCell}><HeldPnl m={m} /></span>
          </>
        ) : (
          <span className={styles.heldCell}>{m.held ? <span className={styles.heldDot} title="Currently held">● HELD</span> : ''}</span>
        )}
      </button>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>AI Members</h1>
        <p className={styles.subtitle}>
          PNTHR AI 300 Index roster {data?.fundMeta?.version ? `(${data.fundMeta.version})` : ''} — {members.length} members across {sectors.length} sectors.
          {' '}<strong className={styles.accent}>{heldCount}</strong> currently held in the live account
          {asOf ? ` · as of ${asOf.toLocaleString()}` : ''}.
        </p>
      </div>

      <div className={styles.tabs}>
        {TABS.map(t => (
          <button
            key={t.key}
            className={`${styles.tab} ${tab === t.key ? styles.tabActive : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}{t.key === 'positions' ? <span className={styles.tabCount}>{heldCount}</span> : null}
          </button>
        ))}
      </div>

      {loading && <div className={styles.empty}>Loading members…</div>}
      {error && !loading && <div className={styles.error}>Couldn’t load members: {error}</div>}

      {!loading && !error && (
        <div className={styles.content}>
          {/* CURRENT POSITIONS */}
          {tab === 'positions' && (
            held.length === 0 ? (
              <div className={styles.empty}>No index members are currently held in the live account.</div>
            ) : (
              <div className={styles.table}>
                <div className={`${styles.row} ${styles.headRow}`}>
                  {POS_COLS.map(col => (
                    <button
                      key={col.key}
                      className={`${styles[col.cls]} ${styles.sortHead} ${col.type === 'num' ? styles.sortHeadNum : ''} ${posSort.key === col.key ? styles.sortHeadActive : ''}`}
                      onClick={() => handleSort(col.key)}
                      title={`Sort by ${col.label}`}
                    >
                      {col.label}
                      {posSort.key === col.key && <span className={styles.sortArrow}>{posSort.dir === 'asc' ? '▲' : '▼'}</span>}
                    </button>
                  ))}
                </div>
                {heldSorted.map(m => <Row key={m.ticker} m={m} showPosition />)}
              </div>
            )
          )}

          {/* ALPHABETICAL */}
          {tab === 'alpha' && (
            <div className={styles.table}>
              <div className={`${styles.row} ${styles.headRow}`}>
                <span className={styles.ticker}>Ticker</span>
                <span className={styles.company}>Company</span>
                <span className={styles.sectorCell}>Sector</span>
                <span className={styles.heldCell}>Held</span>
              </div>
              {alpha.map(m => <Row key={m.ticker} m={m} />)}
            </div>
          )}

          {/* BY SECTOR */}
          {tab === 'sector' && (
            <div className={styles.sectorList}>
              {[...sectors].sort((a, b) => a.id - b.id).map(s => (
                <div key={s.id} className={styles.sectorGroup}>
                  <div className={styles.sectorHeader}>
                    <span className={styles.sectorName}>{s.name}</span>
                    <span className={styles.sectorMeta}>{(bySector[s.id] || []).length} names · {s.weight}% weight</span>
                  </div>
                  <div className={styles.table}>
                    {(bySector[s.id] || []).map(m => <Row key={m.ticker} m={m} />)}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* SEARCH */}
          {tab === 'search' && (
            <div className={styles.searchPane}>
              <div className={styles.searchWrap}>
                <span className={styles.searchIcon} aria-hidden="true">⌕</span>
                <input
                  ref={searchRef}
                  className={styles.searchInput}
                  placeholder="Type a ticker or company name…"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && results.length) setSelected(results[0]); }}
                />
                {query && <button className={styles.searchClear} onClick={() => setQuery('')}>×</button>}
              </div>
              {!query && <div className={styles.hint}>Search the {members.length} AI 300 members. Press Enter to open the top match.</div>}
              {query && results.length === 0 && <div className={styles.empty}>No member matches “{query}”.</div>}
              {results.length > 0 && (
                <div className={styles.table}>
                  {results.map(m => <Row key={m.ticker} m={m} />)}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* SUMMARY (definition + thesis) */}
      {selected && (
        <div className={styles.overlay} onClick={() => setSelected(null)}>
          <div className={styles.summaryCard} onClick={e => e.stopPropagation()}>
            <button className={styles.summaryClose} onClick={() => setSelected(null)} aria-label="Close">×</button>
            <div className={styles.summaryHead}>
              <span className={styles.summaryTicker}>{selected.ticker}</span>
              {selected.held && <span className={styles.heldBadge}>HELD</span>}
            </div>
            <div className={styles.summaryCompany}>{selected.companyName}</div>
            <div className={styles.summarySector}>{selected.sector}</div>

            {selected.held && (
              <div className={styles.summaryPosition}>
                <span>{fmtShares(selected.shares)} sh</span>
                <span>avg {fmtPx(selected.avgCost)}</span>
                <span>last {fmtPx(selected.marketPrice)}</span>
                <span>{fmtMoney(selected.marketValue)}</span>
                <span className={selected.unrealizedPnl >= 0 ? styles.pnlPos : styles.pnlNeg}>{fmtMoney(selected.unrealizedPnl)}</span>
              </div>
            )}

            <div className={styles.thesisLabel}>PNTHR Thesis</div>
            <div className={styles.thesis}>{selected.thesis || 'No thesis on file for this member.'}</div>

            <button className={styles.viewChartBtn} onClick={() => openChart(selected.ticker)}>
              View Chart →
            </button>
          </div>
        </div>
      )}

      {/* CHART — scrollable group: prev/next walks the current view's tickers */}
      {chartGroup && (
        <AiTickerChartModal
          tickers={chartGroup.tickers}
          initialIndex={chartGroup.index}
          onClose={() => setChartGroup(null)}
        />
      )}
    </div>
  );
}
