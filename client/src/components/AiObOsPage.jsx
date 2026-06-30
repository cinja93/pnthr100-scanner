import { useState, useEffect } from 'react';
import AiTickerChartModal from './AiTickerChartModal';
import PageHeader from './PageHeader';
import { fetchAiObOs, fetchPnthrTreeState } from '../services/api';
import { computeWeeksAgo } from '../utils/dateUtils';
import styles from './AiObOsPage.module.css';

// Live PNTHR Tree funnel stages we flash on OB/OS (mirrors PnthrTreePage's own
// categorization): non-held funnel names in attack/approaching, plus held
// positions split into protect (stop locked at/above entry) vs devour.
const TREE_STAGE_META = {
  attack:      { cls: 'stageAttack',      label: 'PNTHR Tree: ATTACK — new 42-week high today' },
  approaching: { cls: 'stageApproaching', label: 'PNTHR Tree: APPROACHING — within 1% of the 42-week high' },
  devour:      { cls: 'stageDevour',      label: 'PNTHR Tree: DEVOUR — held, profit running' },
  protect:     { cls: 'stageProtect',     label: 'PNTHR Tree: PROTECT — held, stop locked at/above entry' },
};

function buildTreeStageMap(treeState) {
  const map = {};
  if (!treeState) return map;
  for (const f of treeState.funnel || []) {
    if (!f.held && (f.state === 'attack' || f.state === 'approaching')) map[f.ticker] = f.state;
  }
  for (const p of treeState.positions || []) {
    map[p.ticker] = p.protected ? 'protect' : 'devour';   // held position wins over funnel
  }
  return map;
}

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

function SignalBadge({ row }) {
  const sig = row.signal;
  if (!sig) return <span className={styles.signalNone}>—</span>;
  const wks = computeWeeksAgo(row.signalDate, row.lastBarDate);
  if (wks == null) return <span className={styles.signalNone}>—</span>;
  const cls = sig === 'BL' ? styles.badgeBL
            : sig === 'SS' ? styles.badgeSS
            : styles.badgeBE;   // BE + SE both orange (matches StockTable)
  return (
    <span className={`${styles.sigBadge} ${cls}`}>
      {row.isNewSignal ? '★ ' : ''}{sig}+{wks}
    </span>
  );
}

function rsiChipClass(v) {
  if (v >= 70) return styles.rsiHot;
  if (v <= 30) return styles.rsiCold;
  return styles.rsiMid;
}

function ObOsBox({ category, timeframe, rows, onTickerClick, treeStages = {} }) {
  const list = rows || [];
  const freshCount = list.filter(r => r.fresh).length;
  return (
    <div className={`${styles.box} ${category.side === 'ob' ? styles.boxOb : styles.boxOs}`}>
      <div className={styles.boxHead}>
        <span className={`${styles.sentiment} ${category.side === 'ob' ? styles.sentimentBear : styles.sentimentBull}`}>
          {category.side === 'ob' ? 'Bearish' : 'Bullish'}
        </span>
        <span className={styles.boxTitle}>{category.title}</span>
        <span className={styles.boxTf}>{timeframe}</span>
        {freshCount > 0 && <span className={styles.freshHeadPill}>{freshCount} fresh</span>}
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
              <th className={styles.thSignal}>Signal</th>
              <th className={styles.thRsi}>RSI</th>
              <th className={styles.thMove}>Move</th>
              <th className={styles.thPrice}>Price</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r, i) => {
              const stage = treeStages[r.ticker];
              const treeMeta = stage ? TREE_STAGE_META[stage] : null;
              return (
              <tr key={r.ticker} className={r.fresh ? styles.freshRow : undefined}>
                <td className={styles.tickerCell}>
                  <button
                    className={`${styles.tickerBtn} ${treeMeta ? `${styles.treeFlash} ${styles[treeMeta.cls]}` : ''}`}
                    onClick={() => onTickerClick(list, i)}
                    title={treeMeta ? `${r.name} · ${treeMeta.label}` : r.name}
                  >{r.ticker}</button>
                  {treeMeta && <span className={styles.treeMark} title={treeMeta.label}>🌳</span>}
                  {r.fresh && <span className={styles.freshTag} title="Turned on the latest closed bar">FRESH</span>}
                </td>
                <td className={styles.sectorCell} title={r.sectorName || ''}>{r.sectorName || '—'}</td>
                <td className={styles.signalCell}><SignalBadge row={r} /></td>
                <td className={styles.rsiCell}>
                  <span className={`${styles.rsiChip} ${rsiChipClass(r.rsi)}`}>{r.rsi}</span>
                </td>
                <td className={styles.moveCell}>
                  <span className={styles.moveFrom}>{r.from}</span>
                  <span className={styles.moveArrow}>→</span>
                  <span className={styles.moveTo}>{r.to}</span>
                </td>
                <td className={styles.priceCell}>{r.price != null ? `$${r.price.toFixed(2)}` : '—'}</td>
              </tr>
              );
            })}
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
  const [treeStages, setTreeStages]     = useState({});   // ticker -> live Tree stage

  // Live PNTHR Tree funnel state — refreshed on the poll so the flash reflects
  // intraday attack/approaching changes. Non-fatal: if it fails, no flash shows.
  function loadTree() {
    fetchPnthrTreeState()
      .then(s => setTreeStages(buildTreeStageMap(s)))
      .catch(() => {});
  }

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
    loadTree();
    const id = setInterval(() => { load(false, { silent: true }); loadTree(); }, 60000);
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
                <ObOsBox category={cat} timeframe="Daily"  rows={data.daily?.[cat.key]}  onTickerClick={handleTickerClick} treeStages={treeStages} />
                <ObOsBox category={cat} timeframe="Weekly" rows={data.weekly?.[cat.key]} onTickerClick={handleTickerClick} treeStages={treeStages} />
              </div>
            ))}
          </div>

          <div className={styles.sectionLabel}>
            <span className={styles.dotOs} /> Oversold — bouncing off the bottom
          </div>
          <div className={styles.grid}>
            {CATEGORIES.filter(c => c.side === 'os').map(cat => (
              <div className={styles.catRow} key={cat.key}>
                <ObOsBox category={cat} timeframe="Daily"  rows={data.daily?.[cat.key]}  onTickerClick={handleTickerClick} treeStages={treeStages} />
                <ObOsBox category={cat} timeframe="Weekly" rows={data.weekly?.[cat.key]} onTickerClick={handleTickerClick} treeStages={treeStages} />
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
