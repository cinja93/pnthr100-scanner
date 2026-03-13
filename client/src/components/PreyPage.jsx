import { useState, useEffect, useMemo } from 'react';
import { fetchPreyStocks, fetchEarnings, fetchEmaCrossoverStocks, fetchScannerRanks, fetchTopStocks, fetchShortStocks, fetchSignals } from '../services/api';
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

function computeWeeksAgo(signalDate) {
  if (!signalDate) return null;
  const signalMonday = new Date(signalDate + 'T12:00:00');
  const today = new Date();
  const dow = today.getDay();
  const daysToMonday = dow === 0 ? -6 : 1 - dow;
  const currentMonday = new Date(today);
  currentMonday.setDate(today.getDate() + daysToMonday);
  currentMonday.setHours(0, 0, 0, 0);
  const diffDays = Math.round((currentMonday - signalMonday) / (1000 * 60 * 60 * 24));
  return Math.floor(diffDays / 7) + 1;
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

function SignalBadge({ badge }) {
  if (!badge) return <span className={styles.tdGray}>—</span>;
  if (badge === 'BE' || badge === 'SE') return <span className={`${styles.badge} ${styles.badgePause}`}>⏸ PAUSE</span>;
  const isBL = badge.startsWith('BL');
  return <span className={`${styles.badge} ${isBL ? styles.badgeBL : styles.badgeSS}`}>{badge}</span>;
}

function SpringStatusBadge({ status }) {
  const cls = status === 'LAUNCHED' ? styles.badgeLaunched
            : status === 'GAINING'  ? styles.badgeGaining
            : styles.badgeCoiled;
  return <span className={`${styles.badge} ${cls}`}>{status}</span>;
}

function SpringRow({ s, onClick }) {
  const isLong = s.direction === 'long';
  const rowCls = s.status === 'LAUNCHED' ? (isLong ? styles.rowLaunched : styles.rowLaunchedShort)
               : s.status === 'GAINING'  ? styles.rowGaining
               : styles.rowCoiled;
  return (
    <tr onClick={onClick} className={rowCls}>
      <TickerCell ticker={s.ticker} companyName={s.companyName} />
      <td className={styles.td}><SignalBadge badge={s.signalBadge} /></td>
      <td className={styles.td}><SpringStatusBadge status={s.status} /></td>
      <td className={styles.tdNum}>{price(s.high26)}</td>
      <td className={isLong ? styles.tdNeg : styles.tdPos}>
        {s.pctOffHigh != null ? `${Number(s.pctOffHigh).toFixed(1)}%` : '—'}
      </td>
      <td className={styles.tdNum}>{price(s.currentPrice)}</td>
      <td className={s.pctVsOpen != null ? styles.tdPos : styles.tdGray}>
        {s.pctVsOpen != null ? `+${Number(s.pctVsOpen).toFixed(1)}%` : '—'}
      </td>
      <td className={s.pctAboveTrigger != null ? styles.tdPos : styles.tdGray}>
        {s.pctAboveTrigger != null ? `+${Number(s.pctAboveTrigger).toFixed(1)}%` : '—'}
      </td>
      <td className={styles.tdNum}>{price(s.ema21)}</td>
      <td className={isLong ? styles.tdPos : styles.tdNeg}>{pct(s.priceDeltaPct)}</td>
      <td className={styles.tdGray}>{s.sector || '—'}</td>
    </tr>
  );
}

function CrouchRow({ s, onClick }) {
  const isLong = s.direction === 'long';
  const isAttack = s.strategy === 'Attack';
  const rowCls = isAttack
    ? (isLong ? styles.rowAttackLong : styles.rowAttackShort)
    : styles.rowStalk;
  const stateBadgeCls = isAttack
    ? (isLong ? styles.badgeBL : styles.badgeSS)
    : styles.badgeCoiled;
  return (
    <tr onClick={onClick} className={rowCls}>
      <TickerCell ticker={s.ticker} companyName={s.companyName} />
      <td className={styles.td}><SignalBadge badge={s.signalBadge} /></td>
      <td className={styles.td}>
        <span className={`${styles.badge} ${stateBadgeCls}`}>
          {isAttack ? (isLong ? 'ATTACK ▲' : 'ATTACK ▼') : 'STALK'}
        </span>
      </td>
      <td className={styles.tdNum}>{price(s.currentPrice)}</td>
      <td className={styles.tdNum}>{s.bandWidth != null ? `${Number(s.bandWidth).toFixed(2)}%` : '—'}</td>
      <td className={styles.tdGray}>{s.bwMin52 != null ? `${Number(s.bwMin52).toFixed(2)}%` : '—'}</td>
      <td className={isAttack ? (isLong ? styles.tdPos : styles.tdNeg) : styles.tdGray}>
        {s.expansionPct != null ? `+${Number(s.expansionPct).toFixed(1)}%` : '—'}
      </td>
      <td className={styles.tdNum}>{s.wksInSqueeze ?? '—'}</td>
      <td className={s.emaLean === 'above' ? styles.tdPos : (s.emaLean === 'below' ? styles.tdNeg : styles.tdGray)}>
        {s.emaLean === 'above' ? 'Above EMA' : s.emaLean === 'below' ? 'Below EMA' : '—'}
      </td>
      <td className={s.emaSlope != null ? (s.emaSlope > 0 ? styles.tdPos : styles.tdNeg) : styles.tdGray}>
        {s.emaSlope != null ? `${s.emaSlope > 0 ? '+' : ''}${Number(s.emaSlope).toFixed(2)}` : '—'}
      </td>
      <td className={styles.tdGray}>{s.sector || '—'}</td>
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
      <td className={styles.tdRisk}>{riskPct != null ? `${riskPct.toFixed(2)}%` : '—'}</td>
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

function ResultTable({ longs, shorts, RowComponent, headers, onStockClick, rowExtraProps = {}, sortAccessors = {} }) {
  const [side, setSide] = useState('long');
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');

  const rawRows = side === 'all' ? [...(longs ?? []), ...(shorts ?? [])] : side === 'long' ? longs : shorts;

  const rows = useMemo(() => {
    if (!sortKey || !sortAccessors[sortKey] || !rawRows) return rawRows ?? [];
    const fn = sortAccessors[sortKey];
    return [...rawRows].sort((a, b) => {
      const av = fn(a), bv = fn(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [rawRows, sortKey, sortDir, sortAccessors]);

  const count = rows?.length ?? 0;

  function handleHeaderClick(h) {
    if (!sortAccessors[h]) return;
    if (sortKey === h) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(h);
      setSortDir('asc');
    }
  }

  function sortIcon(h) {
    if (!sortAccessors[h]) return null;
    if (sortKey !== h) return <span className={styles.sortIcon}>↕</span>;
    return <span className={styles.sortIcon}>{sortDir === 'asc' ? '↑' : '↓'}</span>;
  }

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
        <button
          className={`${styles.sideBtn} ${side === 'all' ? styles.sideBtnAll : ''}`}
          onClick={() => setSide('all')}
        >
          All ({(longs?.length ?? 0) + (shorts?.length ?? 0)})
        </button>
      </div>

      {count === 0 ? (
        <div className={styles.empty}>The panther is patient. No {side === 'all' ? '' : side + ' '}candidates this week.</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {headers.map(h => (
                  <th
                    key={h}
                    className={`${styles.th} ${sortAccessors[h] ? styles.thSortable : ''}`}
                    onClick={() => handleHeaderClick(h)}
                  >
                    {h}{sortIcon(h)}
                  </th>
                ))}
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

// PreyStockTable — uniform Signal-in-col-2 table for Hunt and Sprint
function PreyStockTable({ stocks, longs, shorts, signals = {}, earnings = {}, onRowClick }) {
  const hasTabs = longs !== undefined || shorts !== undefined;
  const [side, setSide] = useState('long');
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');

  const allLongs  = longs  ?? [];
  const allShorts = shorts ?? [];
  const rawRows = hasTabs
    ? (side === 'long' ? allLongs : side === 'short' ? allShorts : [...allLongs, ...allShorts])
    : (stocks ?? []);

  const sortedRows = useMemo(() => {
    if (!sortKey) return rawRows;
    return [...rawRows].sort((a, b) => {
      const sigA = signals[a.ticker];
      const sigB = signals[b.ticker];
      let av, bv;
      const SIG_ORDER = { BL: 1, SS: 2, BE: 3, SE: 3 };
      if (sortKey === 'PNTHR Signal') {
        av = SIG_ORDER[sigA?.signal] ?? 99;
        bv = SIG_ORDER[sigB?.signal] ?? 99;
      } else if (sortKey === 'Wks Since') {
        av = computeWeeksAgo(sigA?.signalDate) ?? 999;
        bv = computeWeeksAgo(sigB?.signalDate) ?? 999;
      } else if (sortKey === 'PNTHR Stop') {
        av = sigA?.stopPrice ?? 0; bv = sigB?.stopPrice ?? 0;
      } else if (sortKey === 'Risk $') {
        av = sigA?.stopPrice != null ? Math.abs(a.currentPrice - sigA.stopPrice) : 0;
        bv = sigB?.stopPrice != null ? Math.abs(b.currentPrice - sigB.stopPrice) : 0;
      } else if (sortKey === 'Risk %') {
        av = sigA?.stopPrice != null ? Math.abs(a.currentPrice - sigA.stopPrice) / a.currentPrice * 100 : 0;
        bv = sigB?.stopPrice != null ? Math.abs(b.currentPrice - sigB.stopPrice) / b.currentPrice * 100 : 0;
      } else if (sortKey === 'Next Earnings') {
        av = earnings[a.ticker] ?? '9999'; bv = earnings[b.ticker] ?? '9999';
      } else {
        const FM = { 'Ticker': 'ticker', 'Exchange': 'exchange', 'Sector': 'sector', 'Current Price': 'currentPrice', 'YTD Return': 'ytdReturn' };
        const f = FM[sortKey]; if (!f) return 0;
        av = a[f]; bv = b[f];
      }
      if (av == null && bv == null) return 0;
      if (av == null) return 1; if (bv == null) return -1;
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [rawRows, sortKey, sortDir, signals, earnings]);

  function handleSort(h) {
    if (sortKey === h) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(h); setSortDir('asc'); }
  }
  function sortIcon(h) {
    if (sortKey !== h) return <span className={styles.sortIcon}>↕</span>;
    return <span className={styles.sortIcon}>{sortDir === 'asc' ? '↑' : '↓'}</span>;
  }

  const HEADERS = ['Ticker', 'PNTHR Signal', 'Wks Since', 'Exchange', 'Sector', 'Current Price', 'YTD Return', 'PNTHR Stop', 'Risk $', 'Risk %', 'Next Earnings'];

  return (
    <div>
      {hasTabs && (
        <div className={styles.sideToggle}>
          <button className={`${styles.sideBtn} ${side === 'long'  ? styles.sideBtnLong  : ''}`} onClick={() => setSide('long')}>Longs ({allLongs.length})</button>
          <button className={`${styles.sideBtn} ${side === 'short' ? styles.sideBtnShort : ''}`} onClick={() => setSide('short')}>Shorts ({allShorts.length})</button>
          <button className={`${styles.sideBtn} ${side === 'all'   ? styles.sideBtnAll   : ''}`} onClick={() => setSide('all')}>All ({allLongs.length + allShorts.length})</button>
        </div>
      )}
      {sortedRows.length === 0 ? (
        <div className={styles.empty}>The panther is patient. No candidates this week.</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {HEADERS.map(h => (
                  <th key={h} className={`${styles.th} ${styles.thSortable}`} onClick={() => handleSort(h)}>
                    {h}{sortIcon(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((stock, i) => {
                const sigData = signals[stock.ticker];
                const sig = sigData?.signal;
                const isPause = sig === 'BE' || sig === 'SE';
                const stopPrice = sigData?.stopPrice ?? null;
                const riskDollar = stopPrice != null ? Math.abs(stock.currentPrice - stopPrice) : null;
                const riskPct = riskDollar != null ? (riskDollar / stock.currentPrice) * 100 : null;
                const wks = computeWeeksAgo(sigData?.signalDate);
                const earningsInfo = getEarningsInfo(earnings[stock.ticker]);

                let sigBadge;
                if (!sig) sigBadge = <span className={styles.tdGray}>—</span>;
                else if (isPause) sigBadge = <span className={`${styles.badge} ${styles.badgePause}`}>⏸ PAUSE</span>;
                else sigBadge = <span className={`${styles.badge} ${sig === 'BL' ? styles.badgeBL : styles.badgeSS}`}>{sigData?.isNewSignal ? '★ ' : ''}{sig}</span>;

                let wksBadge;
                if (!sig || wks == null) wksBadge = <span className={styles.tdGray}>—</span>;
                else {
                  const wksCls = sig === 'BL' ? styles.badgeBL : sig === 'SS' ? styles.badgeSS : styles.badgeCoiled;
                  wksBadge = <span className={`${styles.badge} ${wksCls}`}>{sig}+{wks}</span>;
                }

                return (
                  <tr key={stock.ticker + i} onClick={() => onRowClick?.(stock, sortedRows, i)}>
                    <td className={styles.tdTicker}>
                      <div className={styles.tickerSymbol}>{stock.ticker}</div>
                      {stock.companyName && <div className={styles.companyName}>{stock.companyName}</div>}
                    </td>
                    <td className={styles.td}>{sigBadge}</td>
                    <td className={styles.td}>{wksBadge}</td>
                    <td className={styles.tdGray}>{stock.exchange || '—'}</td>
                    <td className={styles.tdGray}>{stock.sector || '—'}</td>
                    <td className={styles.tdNum}>${stock.currentPrice?.toLocaleString() ?? '—'}</td>
                    <td className={stock.ytdReturn != null ? (stock.ytdReturn >= 0 ? styles.tdPos : styles.tdNeg) : styles.tdGray}>
                      {stock.ytdReturn != null ? `${stock.ytdReturn >= 0 ? '+' : ''}${stock.ytdReturn.toFixed(2)}%` : '—'}
                    </td>
                    <td className={styles.tdNum}>{stopPrice != null ? `$${stopPrice.toLocaleString()}` : '—'}</td>
                    <td className={styles.tdNum}>{riskDollar != null ? `$${riskDollar.toFixed(2)}` : '—'}</td>
                    <td className={styles.tdNum}>{riskPct != null ? `${riskPct.toFixed(2)}%` : '—'}</td>
                    <td className={earningsInfo.highlight ? styles.earningsHighlight : ''}>
                      {earningsInfo.display}
                      {earningsInfo.highlight && (
                        <span className={styles.earningsSoonBadge}>{earningsInfo.daysAway === 0 ? 'Today' : `${earningsInfo.daysAway}d`}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const ALPHA_HEADERS  = ['Ticker', 'Signal', 'Wks Since', 'Current Price', 'EMA21', 'Δ EMA', 'RSI', 'ADX', 'OBV', 'ETF', '4-Wk α'];
const SPRING_HEADERS = ['Ticker', 'Signal', 'Status', '6M High', '% Off High', 'Current', '% vs Open', '% past Trigger', 'EMA21', 'Δ EMA', 'Sector'];
const CROUCH_HEADERS = ['Ticker', 'Signal', 'State', 'Current', 'Band Width %', '52-Wk Min BW', 'Expansion %', 'Wks in Squeeze', 'EMA Lean', 'Δ EMA', 'Sector'];
const DINNER_HEADERS = ['Ticker', 'Signal', 'Exchange', 'Sector', 'Current Price', 'PNTHR Stop', 'Risk Per Share', 'Risk %', 'RSI', 'OBV', 'Δ EMA', 'Next Earnings'];

const ALPHA_SORT = {
  'Ticker':        s => s.ticker,
  'Signal':        s => s.direction || '',
  'Wks Since':     s => s.barNumber ?? 0,
  'Current Price': s => s.currentPrice ?? 0,
  'EMA21':         s => s.ema21 ?? 0,
  'Δ EMA':         s => s.priceDeltaPct ?? 0,
  'RSI':           s => s.rsi ?? 0,
  'ADX':           s => s.adx ?? 0,
  'OBV':           s => s.obvSlope || '',
  'ETF':           s => s.sectorEtf || '',
  '4-Wk α':        s => (s.stock4wPct ?? 0) - (s.sector4wPct ?? 0),
};

const SPRING_SORT = {
  'Ticker':          s => s.ticker,
  'Signal':          s => s.signalBadge || '',
  'Status':          s => s.status || '',
  '6M High':         s => s.high26 ?? 0,
  '% Off High':      s => s.pctOffHigh ?? 0,
  'Current':         s => s.currentPrice ?? 0,
  '% vs Open':       s => s.pctVsOpen ?? 0,
  '% past Trigger':  s => s.pctAboveTrigger ?? 0,
  'EMA21':           s => s.ema21 ?? 0,
  'Δ EMA':           s => s.priceDeltaPct ?? 0,
  'Sector':          s => s.sector || '',
};

const CROUCH_SORT = {
  'Ticker':          s => s.ticker,
  'Signal':          s => s.signalBadge || '',
  'State':           s => s.strategy || '',
  'Current':         s => s.currentPrice ?? 0,
  'Band Width %':    s => s.bandWidth ?? 0,
  '52-Wk Min BW':   s => s.bwMin52 ?? 0,
  'Expansion %':     s => s.expansionPct ?? 0,
  'Wks in Squeeze':  s => s.wksInSqueeze ?? 0,
  'EMA Lean':        s => s.emaLean || '',
  'Δ EMA':           s => s.emaSlope ?? 0,
  'Sector':          s => s.sector || '',
};

// DINNER_SORT is computed as a useMemo inside PreyPage to access earnings data

export default function PreyPage({ onNavigate }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [chartStocks, setChartStocks] = useState([]);
  const [chartIndex, setChartIndex]   = useState(null);
  const [showAlphaGuide, setShowAlphaGuide] = useState(false);
  const [showSpringGuide, setShowSpringGuide] = useState(false);
  const [showCrouchGuide, setShowCrouchGuide] = useState(false);
  const [showDinnerGuide, setShowDinnerGuide] = useState(false);
  const [showHuntGuide, setShowHuntGuide] = useState(false);
  const [showSprintGuide, setShowSprintGuide] = useState(false);
  const [earnings, setEarnings] = useState({});
  const [huntStocks, setHuntStocks] = useState([]);
  const [huntSignals, setHuntSignals] = useState({});
  const [huntScannerRanks, setHuntScannerRanks] = useState(null);
  const [huntLoading, setHuntLoading] = useState(true);
  const [huntError, setHuntError] = useState(null);
  const [sprintLongs, setSprintLongs] = useState([]);
  const [sprintShorts, setSprintShorts] = useState([]);
  const [sprintSignals, setSprintSignals] = useState({});
  const [sprintLoading, setSprintLoading] = useState(true);
  const [sprintError, setSprintError] = useState(null);
  const [chartSignals, setChartSignals] = useState({});
  const [collapsed, setCollapsed] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('pnthr-prey-collapsed') || '{}'); } catch { return {}; }
  });

  function toggleSection(key) {
    setCollapsed(prev => {
      const next = { ...prev, [key]: !prev[key] };
      sessionStorage.setItem('pnthr-prey-collapsed', JSON.stringify(next));
      return next;
    });
  }

  const dinnerSort = useMemo(() => ({
    'Ticker':         s => s.ticker,
    'Signal':         s => s.strategy || '',
    'Exchange':       s => s.exchange || '',
    'Sector':         s => s.sector || '',
    'Current Price':  s => s.currentPrice ?? 0,
    'PNTHR Stop':     s => s.stopPrice ?? 0,
    'Risk Per Share': s => s.currentPrice != null && s.stopPrice != null ? Math.abs(s.currentPrice - s.stopPrice) : 0,
    'Risk %':         s => s.currentPrice != null && s.stopPrice != null ? Math.abs(s.currentPrice - s.stopPrice) / s.currentPrice * 100 : 0,
    'RSI':            s => s.rsi ?? 0,
    'OBV':            s => s.obvSlope || '',
    'Δ EMA':          s => s.priceDeltaPct ?? 0,
    'Next Earnings':  s => earnings[s.ticker] ?? '9999-99-99',
  }), [earnings]);

  useEffect(() => { load(); loadHunt(); loadSprint(); }, []);

  async function load(forceRefresh = false) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchPreyStocks(forceRefresh);
      setData(res);
      const allTickers = [
        ...(res.dinner?.longs   || []),
        ...(res.dinner?.shorts  || []),
        ...(res.alphas?.longs   || []),
        ...(res.alphas?.shorts  || []),
        ...(res.springs?.longs  || []),
        ...(res.springs?.shorts || []),
        ...(res.crouch?.longs   || []),
        ...(res.crouch?.shorts  || []),
      ].map(s => s.ticker);
      if (allTickers.length > 0) {
        fetchEarnings(allTickers).then(setEarnings);
      }
    } catch (e) {
      setError(e.message || 'Scan failed.');
    } finally {
      setLoading(false);
    }
  }

  async function loadHunt(forceRefresh = false) {
    setHuntLoading(true);
    setHuntError(null);
    try {
      const result = await fetchEmaCrossoverStocks(forceRefresh);
      const stockList = result.stocks || [];
      setHuntStocks(stockList);
      setHuntSignals(result.signals || {});
      fetchScannerRanks().then(setHuntScannerRanks);
    } catch (e) {
      setHuntError(e.message || 'Hunt scan failed.');
    } finally {
      setHuntLoading(false);
    }
  }

  async function loadSprint() {
    setSprintLoading(true);
    setSprintError(null);
    try {
      const [longStocks, shortStocks] = await Promise.all([fetchTopStocks(), fetchShortStocks()]);
      const filteredLongs  = (longStocks  || []).filter(s => s.rankChange > 0 || s.rankChange === null);
      const filteredShorts = (shortStocks || []).filter(s => s.rankChange > 0 || s.rankChange === null);
      setSprintLongs(filteredLongs);
      setSprintShorts(filteredShorts);
      const allTickers = [...filteredLongs, ...filteredShorts].map(s => s.ticker);
      if (allTickers.length > 0) {
        fetchSignals(allTickers).then(setSprintSignals);
      }
    } catch (e) {
      setSprintError(e.message || 'Sprint scan failed.');
    } finally {
      setSprintLoading(false);
    }
  }

  function handleStockClick(stock, list, index, signals = {}) {
    if (!stock || !Array.isArray(list)) return;
    setChartSignals(signals);
    setChartStocks(list);
    setChartIndex(index ?? list.indexOf(stock));
  }

  function handleHuntRowClick(_stock, sortedIdx, sortedStocks) {
    setChartSignals(huntSignals);
    setChartStocks(sortedStocks);
    setChartIndex(sortedIdx);
  }

  function handleSprintRowClick(_stock, sortedIdx, sortedStocks) {
    setChartSignals(sprintSignals);
    setChartStocks(sortedStocks);
    setChartIndex(sortedIdx);
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
              <button
                key={etf}
                className={`${styles.sectorBtn} ${status === 'above' ? styles.sectorUp : styles.sectorDown}`}
                onClick={() => {
                  sessionStorage.setItem('pnthr-sector-etf', etf);
                  onNavigate?.('sectors');
                }}
                title={`Go to ${etf} sector`}
              >
                {etf} {status === 'above' ? '▲' : '▼'}
              </button>
            ))}
          </div>

          {/* Section nav */}
          <div className={styles.sectionNav}>
            {[
              { key: 'dinner', label: 'PNTHR Dinner', count: data.dinner.longs.length + data.dinner.shorts.length },
              { key: 'alpha',  label: 'PNTHR Alpha',  count: data.alphas.longs.length + data.alphas.shorts.length },
              { key: 'spring', label: 'PNTHR Spring', count: data.springs.longs.length + data.springs.shorts.length },
              { key: 'crouch', label: 'PNTHR Crouch', count: (data.crouch?.longs.length ?? 0) + (data.crouch?.shorts.length ?? 0) },
              { key: 'hunt',   label: 'PNTHR Hunt',   count: huntStocks.length },
              { key: 'sprint', label: 'PNTHR Sprint', count: sprintLongs.length + sprintShorts.length },
            ].map(({ key, label, count }) => (
              <button
                key={key}
                className={styles.navPill}
                onClick={() => document.getElementById(`prey-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              >
                {label}{count > 0 ? ` · ${count}` : ''}
              </button>
            ))}
          </div>

          {/* Dinner */}
          <section className={styles.section} id="prey-dinner">
            <div className={styles.sectionHeader}>
              <div className={styles.sectionTitleRow}>
                <h2 className={styles.groupTitle}>
                  PNTHR Dinner <span className={styles.groupBadge}>BL+1 · SS+1</span>
                  <span className={styles.countNote}>{data.dinner.longs.length}L · {data.dinner.shorts.length}S</span>
                  <button type="button" className={styles.infoBtn} onClick={() => setShowDinnerGuide(v => !v)} aria-label="Column definitions" title="What the columns mean">i</button>
                </h2>
                <button type="button" className={`${styles.collapseBtn} ${collapsed.dinner ? styles.collapseBtnClosed : ''}`} onClick={() => toggleSection('dinner')}>▼</button>
              </div>
              {!collapsed.dinner && <p className={styles.groupSubtitle}>One bar past the PNTHR entry signal · still in the zone</p>}
            </div>
            {!collapsed.dinner && (
              <>
                {showDinnerGuide && (
                  <div className={styles.columnGuidePopover}>
                    <strong>What the columns mean:</strong>
                    <ul className={styles.columnGuideList}>
                      <li><strong>Ticker</strong> — Stock symbol.</li>
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
                  sortAccessors={dinnerSort}
                />
              </>
            )}
          </section>

          {/* Alpha */}
          <section className={styles.section} id="prey-alpha">
            <div className={styles.sectionHeader}>
              <div className={styles.sectionTitleRow}>
                <h2 className={styles.groupTitle}>
                  PNTHR Alpha <span className={styles.groupBadge}>Elite</span>
                  <span className={styles.countNote}>{data.alphas.longs.length}L · {data.alphas.shorts.length}S</span>
                  <button type="button" className={styles.infoBtn} onClick={() => setShowAlphaGuide(v => !v)} aria-label="Column definitions" title="What the columns mean">i</button>
                </h2>
                <button type="button" className={`${styles.collapseBtn} ${collapsed.alpha ? styles.collapseBtnClosed : ''}`} onClick={() => toggleSection('alpha')}>▼</button>
              </div>
              {!collapsed.alpha && <p className={styles.groupSubtitle}>Maximum trend alignment · institutional accumulation · sector alpha leadership</p>}
            </div>
            {!collapsed.alpha && (
              <>
                {showAlphaGuide && (
                  <div className={styles.columnGuidePopover}>
                    <strong>What the columns mean:</strong>
                    <ul className={styles.columnGuideList}>
                      <li><strong>Ticker</strong> — Stock symbol and company name.</li>
                      <li><strong>Signal</strong> — BL (Buy Long) or SS (Sell Short) entry direction.</li>
                      <li><strong>Wks Since</strong> — Which weekly bar since the signal (Bar 1 = first week).</li>
                      <li><strong>Current Price</strong> — Current share price.</li>
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
                  sortAccessors={ALPHA_SORT}
                />
              </>
            )}
          </section>

          {/* Spring */}
          <section className={styles.section} id="prey-spring">
            <div className={styles.sectionHeader}>
              <div className={styles.sectionTitleRow}>
                <h2 className={styles.groupTitle}>
                  PNTHR Spring <span className={styles.groupBadge}>Pullback</span>
                  <span className={styles.countNote}>{data.springs.longs.length}L · {data.springs.shorts.length}S</span>
                  <button type="button" className={styles.infoBtn} onClick={() => setShowSpringGuide(v => !v)} aria-label="Column definitions" title="What the columns mean">i</button>
                </h2>
                <button type="button" className={`${styles.collapseBtn} ${collapsed.spring ? styles.collapseBtnClosed : ''}`} onClick={() => toggleSection('spring')}>▼</button>
              </div>
              {!collapsed.spring && <p className={styles.groupSubtitle}>6-month high → ≥8% pullback → relaunch above EMA · three stages: Coiled → Gaining → Launched</p>}
            </div>
            {!collapsed.spring && (
              <>
                {showSpringGuide && (
                  <div className={styles.columnGuidePopover}>
                    <strong>What the columns mean:</strong>
                    <ul className={styles.columnGuideList}>
                      <li><strong>Ticker</strong> — Stock symbol and company name.</li>
                      <li><strong>Signal</strong> — Active PNTHR signal if one exists (BL+N or SS+N).</li>
                      <li><strong>Status</strong> — Stage: <strong>COILED</strong> (setup met, watching), <strong>GAINING</strong> (building momentum), or <strong>LAUNCHED</strong> (trigger confirmed).</li>
                      <li><strong>6M High</strong> — The 26-week high before the pullback (shorts: 26-week low).</li>
                      <li><strong>% Off High</strong> — How far price is from that 6-month extreme. Deeper = more coiled energy.</li>
                      <li><strong>Current</strong> — Current weekly close price.</li>
                      <li><strong>% vs Open</strong> — For GAINING: close vs this week's open. Higher = more momentum toward a launch.</li>
                      <li><strong>% past Trigger</strong> — For LAUNCHED: how far past the prior week's high (longs) or low (shorts).</li>
                      <li><strong>EMA21</strong> — 21-week exponential moving average (trend anchor).</li>
                      <li><strong>Δ EMA</strong> — Distance between price and the 21-EMA (%).</li>
                      <li><strong>Sector</strong> — Sector the stock belongs to.</li>
                    </ul>
                  </div>
                )}
                <ResultTable
                  longs={data.springs.longs}
                  shorts={data.springs.shorts}
                  RowComponent={SpringRow}
                  headers={SPRING_HEADERS}
                  onStockClick={handleStockClick}
                  sortAccessors={SPRING_SORT}
                />
              </>
            )}
          </section>

          {/* Crouch */}
          <section className={styles.section} id="prey-crouch">
            <div className={styles.sectionHeader}>
              <div className={styles.sectionTitleRow}>
                <h2 className={styles.groupTitle}>
                  PNTHR Crouch <span className={styles.groupBadge}>BB Squeeze</span>
                  <span className={styles.countNote}>{(data.crouch?.longs.length ?? 0)}L · {(data.crouch?.shorts.length ?? 0)}S</span>
                  <button type="button" className={styles.infoBtn} onClick={() => setShowCrouchGuide(v => !v)} aria-label="Column definitions" title="What the columns mean">i</button>
                </h2>
                <button type="button" className={`${styles.collapseBtn} ${collapsed.crouch ? styles.collapseBtnClosed : ''}`} onClick={() => toggleSection('crouch')}>▼</button>
              </div>
              {!collapsed.crouch && <p className={styles.groupSubtitle}>Bollinger Band squeeze — STALK (grey, coiling) upgrades to ATTACK (green/red) when bands fire ≥15%</p>}
            </div>
            {!collapsed.crouch && (
              <>
                {showCrouchGuide && (
                  <div className={styles.columnGuidePopover}>
                    <strong>What the columns mean:</strong>
                    <ul className={styles.columnGuideList}>
                      <li><strong>Ticker</strong> — Stock symbol and company name.</li>
                      <li><strong>Signal</strong> — Active PNTHR signal if one exists (BL+N or SS+N).</li>
                      <li><strong>State</strong> — <strong>STALK</strong>: BB at 52-week min, coiling. <strong>ATTACK ▲/▼</strong>: squeeze fired ≥15% expansion within last 3 weeks.</li>
                      <li><strong>Current</strong> — Current weekly close price.</li>
                      <li><strong>Band Width %</strong> — Current BB width: (Upper − Lower) / Middle × 100. Lower = more compressed.</li>
                      <li><strong>52-Wk Min BW</strong> — Tightest band width over 52 weeks — the squeeze floor.</li>
                      <li><strong>Expansion %</strong> — For ATTACK: BW growth from the 52-week min. Bigger = more explosive.</li>
                      <li><strong>Wks in Squeeze</strong> — Consecutive weeks near the 52-week min. Longer = more potential energy.</li>
                      <li><strong>EMA Lean</strong> — Price above or below 21-week EMA — direction hint for STALK stocks.</li>
                      <li><strong>Δ EMA</strong> — EMA slope over the last 4 weeks.</li>
                      <li><strong>Sector</strong> — Sector the stock belongs to.</li>
                    </ul>
                  </div>
                )}
                <ResultTable
                  longs={data.crouch?.longs ?? []}
                  shorts={data.crouch?.shorts ?? []}
                  RowComponent={CrouchRow}
                  headers={CROUCH_HEADERS}
                  onStockClick={handleStockClick}
                  sortAccessors={CROUCH_SORT}
                />
              </>
            )}
          </section>

          {/* Hunt — fresh EMA crossovers (comes before Sprint) */}
          <section className={styles.section} id="prey-hunt">
            <div className={styles.sectionHeader}>
              <div className={styles.sectionTitleRow}>
                <h2 className={styles.groupTitle}>
                  PNTHR Hunt <span className={styles.groupBadge}>New Cross</span>
                  <span className={styles.countNote}>{huntStocks.length} stocks</span>
                  <button type="button" className={styles.infoBtn} onClick={() => setShowHuntGuide(v => !v)} aria-label="Column definitions" title="What the columns mean">i</button>
                </h2>
                <button type="button" className={`${styles.collapseBtn} ${collapsed.hunt ? styles.collapseBtnClosed : ''}`} onClick={() => toggleSection('hunt')}>▼</button>
              </div>
              {!collapsed.hunt && <p className={styles.groupSubtitle}>Fresh tracks. Stocks that just crossed the 21-week EMA — the panther locks on.</p>}
            </div>
            {!collapsed.hunt && (
              <>
                {showHuntGuide && (
                  <div className={styles.columnGuidePopover}>
                    <strong>What the columns mean:</strong>
                    <ul className={styles.columnGuideList}>
                      <li><strong>Ticker</strong> — Stock symbol and company name.</li>
                      <li><strong>Exchange</strong> — NYSE or NASDAQ.</li>
                      <li><strong>Sector</strong> — Sector the stock belongs to.</li>
                      <li><strong>Current Price</strong> — Last weekly close price.</li>
                      <li><strong>YTD Return</strong> — Year-to-date performance (%).</li>
                      <li><strong>PNTHR Stop</strong> — Predatory buffer stop: ratcheted via Wilder ATR(3) from the signal week.</li>
                      <li><strong>Risk Per Share</strong> — Dollar distance from current price to the PNTHR Stop.</li>
                      <li><strong>Risk %</strong> — Risk as a percentage of current price.</li>
                      <li><strong>PNTHR Signal</strong> — BL (Buy Long) or SS (Sell Short) — the entry signal type.</li>
                      <li><strong>Wks Since</strong> — Number of weekly bars since the crossover signal fired.</li>
                      <li><strong>Next Earnings</strong> — Upcoming earnings date. Amber highlight = within 14 days.</li>
                    </ul>
                  </div>
                )}
                {huntLoading && <div className={styles.empty}>Scanning for fresh EMA crossovers…</div>}
                {huntError && !huntLoading && <div className={styles.empty}>⚠️ {huntError}</div>}
                {!huntLoading && !huntError && huntStocks.length === 0 && (
                  <div className={styles.empty}>The panther is patient. No fresh EMA crossovers this week.</div>
                )}
                {!huntLoading && !huntError && huntStocks.length > 0 && (
                  <PreyStockTable
                    stocks={huntStocks}
                    signals={huntSignals}
                    earnings={earnings}
                    onRowClick={handleHuntRowClick}
                  />
                )}
              </>
            )}
          </section>

          {/* Sprint — rising ranks in PNTHR 100 */}
          <section className={styles.section} id="prey-sprint">
            <div className={styles.sectionHeader}>
              <div className={styles.sectionTitleRow}>
                <h2 className={styles.groupTitle}>
                  PNTHR Sprint <span className={styles.groupBadge}>Rising</span>
                  <span className={styles.countNote}>{sprintLongs.length}L · {sprintShorts.length}S</span>
                  <button type="button" className={styles.infoBtn} onClick={() => setShowSprintGuide(v => !v)} aria-label="Column definitions" title="What the columns mean">i</button>
                </h2>
                <button type="button" className={`${styles.collapseBtn} ${collapsed.sprint ? styles.collapseBtnClosed : ''}`} onClick={() => toggleSection('sprint')}>▼</button>
              </div>
              {!collapsed.sprint && <p className={styles.groupSubtitle}>New entries and rising ranks in the PNTHR 100 — momentum building, the panther accelerates.</p>}
            </div>
            {!collapsed.sprint && (
              <>
                {showSprintGuide && (
                  <div className={styles.columnGuidePopover}>
                    <strong>What the columns mean:</strong>
                    <ul className={styles.columnGuideList}>
                      <li><strong>Performance Rank</strong> — Current rank in the PNTHR 100 (1 = strongest performer).</li>
                      <li><strong>Rank Change</strong> — How many positions the stock moved up this week. "New" = first time on the list.</li>
                      <li><strong>Ticker</strong> — Stock symbol and company name.</li>
                      <li><strong>Exchange</strong> — NYSE or NASDAQ.</li>
                      <li><strong>Sector</strong> — Sector the stock belongs to.</li>
                      <li><strong>Current Price</strong> — Last weekly close price.</li>
                      <li><strong>YTD Return</strong> — Year-to-date performance (%).</li>
                      <li><strong>PNTHR Stop</strong> — Predatory buffer stop: ratcheted via Wilder ATR(3) from the signal week.</li>
                      <li><strong>Risk Per Share</strong> — Dollar distance from current price to the PNTHR Stop.</li>
                      <li><strong>Risk %</strong> — Risk as a percentage of current price.</li>
                      <li><strong>PNTHR Signal</strong> — BL (Buy Long) or SS (Sell Short) entry signal type.</li>
                      <li><strong>Wks Since</strong> — Weeks since the signal fired.</li>
                      <li><strong>Next Earnings</strong> — Upcoming earnings date. Amber highlight = within 14 days.</li>
                    </ul>
                  </div>
                )}
                {sprintLoading && <div className={styles.empty}>Scanning PNTHR 100 for risers…</div>}
                {sprintError && !sprintLoading && <div className={styles.empty}>⚠️ {sprintError}</div>}
                {!sprintLoading && !sprintError && (
                  <PreyStockTable
                    longs={sprintLongs}
                    shorts={sprintShorts}
                    signals={sprintSignals}
                    earnings={earnings}
                    onRowClick={handleSprintRowClick}
                  />
                )}
              </>
            )}
          </section>
        </>
      )}

      {chartIndex != null && chartStocks.length > 0 && (
        <ChartModal
          stocks={chartStocks}
          initialIndex={chartIndex}
          signals={chartSignals}
          earnings={earnings}
          onClose={() => setChartIndex(null)}
        />
      )}
    </div>
  );
}
