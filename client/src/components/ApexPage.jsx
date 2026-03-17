import { useState, useEffect, useRef } from 'react';
import ChartModal from './ChartModal';
import KillBadge from './KillBadge';
import { fetchApexStocks } from '../services/api';
import styles from './ApexPage.module.css';
import pantherHead from '../assets/panther head.png';

// ── Tier config — mirrors server/apexService.js ───────────────────────────────
// Thresholds recalibrated after D4 removal (2026-03-14):
// ≥130 ALPHA · ≥100 STRIKING · ≥80 HUNTING · ≥65 POUNCING · ≥50 COILING
// ≥35 STALKING · ≥20 TRACKING · ≥10 PROWLING · ≥0 STIRRING · <0 DORMANT
// OVEREXTENDED: separation > 20% — disqualified, shown greyed-out at bottom
const TIERS = [
  { name: 'ALPHA PNTHR KILL', tagline: 'Jugular. Teeth in. Alpha PNTHR is Legend.',            color: '#15803d', textColor: '#ffffff' },
  { name: 'STRIKING',         tagline: 'Claws out. Contact made. In the kill zone.',            color: '#16a34a', textColor: '#ffffff' },
  { name: 'HUNTING',          tagline: 'Full pursuit mode. Locked and moving fast.',            color: '#22c55e', textColor: '#111111' },
  { name: 'POUNCING',         tagline: 'The leap has begun. No turning back.',                  color: '#86efac', textColor: '#111111' },
  { name: 'COILING',          tagline: 'Body compressed. Energy stored. About to explode.',    color: '#ca8a04', textColor: '#ffffff' },
  { name: 'STALKING',         tagline: 'Eyes fixed on target. Closing the distance silently.', color: '#eab308', textColor: '#111111' },
  { name: 'TRACKING',         tagline: 'Scent picked up. Target identified. Moving with intent.', color: '#fde047', textColor: '#111111' },
  { name: 'PROWLING',         tagline: 'Moving through the jungle. No target yet.',             color: '#b91c1c', textColor: '#ffffff' },
  { name: 'STIRRING',         tagline: 'Waking up. Eyes barely open.',                         color: '#ef4444', textColor: '#ffffff' },
  { name: 'DORMANT',          tagline: 'Fighting the trend. Sleeping against the flow.',        color: '#fca5a5', textColor: '#111111' },
  { name: 'OVEREXTENDED',     tagline: 'Move already happened - too far from EMA to enter.',   color: '#555555', textColor: '#aaaaaa' },
];

function getTierConfig(tierName) {
  return TIERS.find(t => t.name === tierName) || TIERS[9];
}
function getTierIndex(tierName) {
  const idx = TIERS.findIndex(t => t.name === tierName);
  return idx === -1 ? 9 : idx;
}

// Weeks-ago helper
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

// Format a dimension score — plain number, 1 decimal
function fmtScore(v) {
  if (v == null) return '—';
  const n = Number(v);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// Score breakdown popup — v3 dimensions
// D1 is a multiplier (×); D2–D8 are additive; formula = (D2+…+D8) × D1
function ScoreBreakdown({ scores, preMultiplier, total }) {
  // D2–D8 additive dimensions
  const additiveDims = [
    { label: 'D2 Sector Alignment',   key: 'd2', range: '±15'      },
    { label: 'D3 Entry Quality',       key: 'd3', range: '0–85'     },
    { label: 'D4 Signal Freshness',    key: 'd4', range: '-15–+10'  },
    { label: 'D5 Rank Rise',           key: 'd5', range: '±20'      },
    { label: 'D6 Momentum',            key: 'd6', range: '0–20'     },
    { label: 'D7 Rank Velocity',       key: 'd7', range: '±10'      },
    { label: 'D8 Prey Presence',       key: 'd8', range: '0–6'      },
  ];
  const d1Val = Number(scores?.d1 ?? 1);
  const preVal = preMultiplier != null ? Number(preMultiplier) : null;

  return (
    <div className={styles.breakdown}>
      {additiveDims.map(d => {
        const val = scores?.[d.key];
        const n   = Number(val);
        const isNeg = n < 0;
        return (
          <div key={d.key} className={styles.breakdownRow}>
            <span className={styles.breakdownLabel}>{d.label}</span>
            <span
              className={styles.breakdownScore}
              style={{ color: isNeg ? '#f87171' : n > 0 ? '#86efac' : '#9ca3af', width: 'auto', minWidth: 40 }}
            >
              {fmtScore(val)}
            </span>
          </div>
        );
      })}
      {/* Pre-multiplier subtotal */}
      {preVal != null && (
        <>
          <div className={styles.breakdownDivider} />
          <div className={styles.breakdownRow}>
            <span className={styles.breakdownLabel} style={{ color: '#a5b4fc', fontSize: 11 }}>Pre-multiplier</span>
            <span className={styles.breakdownScore} style={{ color: '#a5b4fc', fontWeight: 700, width: 'auto', minWidth: 40 }}>
              {fmtScore(preVal)}
            </span>
          </div>
        </>
      )}
      {/* D1 multiplier row */}
      <div className={styles.breakdownRow}>
        <span className={styles.breakdownLabel} style={{ color: '#fbbf24', fontSize: 11 }}>
          D1 Market Multiplier
        </span>
        <span className={styles.breakdownScore} style={{ color: '#fbbf24', fontWeight: 700, width: 'auto', minWidth: 40 }}>
          {d1Val.toFixed(2)}×
        </span>
      </div>
      <div className={styles.breakdownDivider} />
      <div className={styles.breakdownRow}>
        <span className={styles.breakdownLabel} style={{ color: '#fcf000', fontWeight: 700 }}>TOTAL</span>
        <span className={styles.breakdownScore} style={{ color: '#fcf000', fontWeight: 900, width: 'auto', minWidth: 40 }}>
          {fmtScore(total)}
        </span>
      </div>
    </div>
  );
}

// ── Sort helper ───────────────────────────────────────────────────────────────
function sortStocks(stocks, { key, dir }) {
  return [...stocks].sort((a, b) => {
    let av, bv;
    switch (key) {
      case 'killRank':
      case 'apexScore':   av = a.apexScore   ?? -9999;  bv = b.apexScore   ?? -9999;  break;
      case 'tier':        av = getTierIndex(a.tier);    bv = getTierIndex(b.tier);    break;
      case 'rank':
        av = a.rank ?? 9999; bv = b.rank ?? 9999; break;
      case 'ticker':      av = a.ticker   ?? ''; bv = b.ticker   ?? ''; break;
      case 'exchange':    av = a.exchange ?? ''; bv = b.exchange ?? ''; break;
      case 'sector':      av = a.sector   ?? ''; bv = b.sector   ?? ''; break;
      case 'price':       av = a.currentPrice ?? -1;  bv = b.currentPrice ?? -1;  break;
      case 'ytd':         av = a.ytdReturn    ?? -999; bv = b.ytdReturn    ?? -999; break;
      case 'signal': {
        const SIG_ORDER = { BL: 1, SS: 2 };
        const aType = SIG_ORDER[a.signal] ?? 99;
        const bType = SIG_ORDER[b.signal] ?? 99;
        const aW = computeWeeksAgo(a.signalDate) ?? 9999;
        const bW = computeWeeksAgo(b.signalDate) ?? 9999;
        av = aType * 10000 + aW; bv = bType * 10000 + bW; break;
      }
      case 'wks': {
        const SIG_ORDER2 = { BL: 1, SS: 2 };
        const aW2   = computeWeeksAgo(a.signalDate) ?? 9999;
        const bW2   = computeWeeksAgo(b.signalDate) ?? 9999;
        const aType2 = SIG_ORDER2[a.signal] ?? 99;
        const bType2 = SIG_ORDER2[b.signal] ?? 99;
        av = aW2 * 10000 + aType2; bv = bW2 * 10000 + bType2; break;
      }
      default: av = 0; bv = 0;
    }
    if (typeof av === 'string') return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    return dir === 'asc' ? av - bv : bv - av;
  });
}

// Strategy tag colors
const STRATEGY_COLORS = {
  Feast:  { bg: '#7f1d1d', color: '#fca5a5' },
  Alpha:  { bg: '#1e3a5f', color: '#93c5fd' },
  Spring: { bg: '#14532d', color: '#86efac' },
  Sneak:  { bg: '#3b0764', color: '#d8b4fe' },
  Hunt:   { bg: '#431407', color: '#fdba74' },
  Sprint: { bg: '#1c1917', color: '#d6d3d1' },
};

function PreyTags({ strategies }) {
  if (!strategies || strategies.length === 0) return null;
  return (
    <div className={styles.preyTagRow}>
      {strategies.map(s => {
        const c = STRATEGY_COLORS[s] || { bg: '#374151', color: '#9ca3af' };
        return (
          <span
            key={s}
            className={styles.preyTag}
            style={{ background: c.bg, color: c.color }}
          >
            {s}
          </span>
        );
      })}
    </div>
  );
}

// ── D1–D8 Formula reference data (v3) ────────────────────────────────────────
const FORMULA_GUIDE = [
  {
    dim: 'FORMULA · Total = (D2+D3+D4+D5+D6+D7+D8) × D1',
    desc: 'D1 is a multiplier (0.70×–1.30×) applied to the sum of all additive dimensions. Fighting the market regime compresses scores; aligned with the regime amplifies them.',
  },
  {
    dim: 'D1 · Market Regime Multiplier  (0.70× – 1.30×)',
    desc: 'Nasdaq → QQQ; NYSE/ARCA → SPY. Index EMA position + slope scored −2 to +2. SS:BL open ratio and new-signal ratio add ±1–2. regimeScore (−5 to +5) × 0.06 = adjustment. BL: 1.0 + adj; SS: 1.0 − adj.',
  },
  {
    dim: 'D2 · Sector Alignment  (±15 pts)',
    desc: 'Sector direction = sign of sector ETF 5D return. 5D component: |return5D%| × newMult × direction × 2 (new signals ×2). 1M component: |return1M%| × direction. Total capped ±15.',
  },
  {
    dim: 'D3 · Entry Quality  (0–85 pts) — THE KEY DIMENSION',
    desc: 'Sub-A: Range-normalized conviction = (close−low)/(high−low)×100 × 2.5, cap 40. Sub-B: EMA slope% × 10 (signal direction only), cap 30. Sub-C: EMA separation% × 1.5, cap 15. CONFIRMED ≥30 (70%+ WR), PARTIAL ≥15, UNCONFIRMED <15.',
  },
  {
    dim: 'D4 · Signal Freshness  (−15 to +10 pts)',
    desc: 'Age 0 (new): CONFIRMED +10, PARTIAL +6, UNCONFIRMED +3. Age 1: CONFIRMED +7, PARTIAL +4, UNCONFIRMED +2. Age 2: +4. Age 3–5: 0. Age 6–9: −3/week. Age 10+: −5/week, floor −15.',
  },
  {
    dim: 'D5 · Rank Rise  (±20 pts)',
    desc: '+1 pt per PNTHR 100 position risen, −1 per position dropped. New entries (null): 0 pts. Capped ±20 — 55% of +30 rank jumps revert the following week.',
  },
  {
    dim: 'D6 · Momentum  (0–20 pts)',
    desc: 'Sub-A: (RSI−50)/10 → ±5 pts. Sub-B: OBV wk/wk% ÷ 5 → ±5 pts (inverted for SS). Sub-C: (ADX−15)/5 → 0–5 pts, only when ADX rising above 15. Sub-D: +5 if volume ratio > 1.5×. Floor 0.',
  },
  {
    dim: 'D7 · Rank Velocity  (±10 pts)',
    desc: 'Measures momentum of rank movement: velocity = currentRankChange − previousRankChange. score = clip(round(velocity ÷ 6), −10, +10). Accelerating rises score positive; decelerating or reversing score negative.',
  },
  {
    dim: 'D8 · Multi-Strategy Prey Presence  (0–6 pts)',
    desc: 'SPRINT = +2 pts (in PNTHR 100 and rising). HUNT = +2 pts (EMA crossover). FEAST / ALPHA / SPRING / SNEAK = +1 pt each. Maximum 6 pts.',
  },
];

export default function ApexPage() {
  const [data, setData]             = useState(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [side, setSide]             = useState('all');
  const [tierFilter, setTierFilter] = useState('all');
  const [popup, setPopup]           = useState(null);
  const [formulaOpen, setFormulaOpen] = useState(false);
  const [formulaPos, setFormulaPos]   = useState({ x: 0, y: 0 });
  const formulaBtnRef = useRef(null);
  const [chartIndex, setChartIndex] = useState(null);
  const [chartStocks, setChartStocks] = useState([]);
  const [sortConfig, setSortConfig] = useState({ key: 'apexScore', dir: 'desc' });
  const [selectedTicker, setSelectedTicker] = useState(null);
  const sortedRef = useRef([]);

  function toggleFormula(e) {
    e.stopPropagation();
    if (!formulaOpen && formulaBtnRef.current) {
      const rect = formulaBtnRef.current.getBoundingClientRect();
      // Estimate popup height (~520px); if it would overflow the bottom, open upward
      const estimatedH = 520;
      const spaceBelow = window.innerHeight - rect.bottom - 12;
      const top = spaceBelow >= estimatedH
        ? rect.bottom + 6
        : Math.max(8, rect.top - estimatedH - 6);
      const left = Math.max(8, Math.min(rect.right - 440, window.innerWidth - 452));
      setFormulaPos({ x: left, y: top });
    }
    setFormulaOpen(prev => !prev);
  }

  // Arrow-key navigation through Kill page rows
  useEffect(() => {
    function onKey(e) {
      if (!selectedTicker) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const list = sortedRef.current;
      const idx = list.findIndex(s => s.ticker === selectedTicker);
      if (idx === -1) return;
      const next = e.key === 'ArrowDown'
        ? Math.min(idx + 1, list.length - 1)
        : Math.max(idx - 1, 0);
      setSelectedTicker(list[next].ticker);
      document.getElementById(`aprow-${list[next].ticker}`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selectedTicker]);

  useEffect(() => { load(false); }, []);

  async function load(forceRefresh) {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchApexStocks(forceRefresh);
      setData(result);
    } catch (err) {
      setError('Failed to load Kill data. Make sure the server is running.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  function handleSort(key) {
    setSortConfig(prev =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'ticker' || key === 'exchange' || key === 'sector' || key === 'signal' ? 'asc' : 'desc' }
    );
  }

  function SortTh({ col, label, title: titleProp }) {
    const active = sortConfig.key === col;
    const arrow = active ? (sortConfig.dir === 'asc' ? '▲' : '▼') : '↕';
    return (
      <th
        className={styles.thSortable}
        onClick={() => handleSort(col)}
        title={titleProp ?? `Sort by ${col}`}
      >
        {label}<span className={active ? styles.sortArrowActive : styles.sortArrow}>{arrow}</span>
      </th>
    );
  }

  const stocks = data?.stocks || [];

  const filtered = stocks.filter(s => {
    if (side === 'long'  && s.signal !== 'BL') return false;
    if (side === 'short' && s.signal !== 'SS') return false;
    if (tierFilter !== 'all' && s.tier !== tierFilter) return false;
    return true;
  });

  const sorted = sortStocks(filtered, sortConfig);

  function handleRowClick(stock, idx, list) {
    setChartStocks(list);
    setChartIndex(idx);
  }

  const ctx = data?.contextSummary || {};

  return (
    <div className={styles.page}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>
            <img src={pantherHead} alt="PNTHR" className={styles.pantherLogo} />
            PNTHR KILL
          </h1>
          <p className={styles.subtitle}>
            Stocks that are the PNTHR's Prey with 7-dimensional predatory scoring. Which ones have the PNTHR's full attention this week? ...time for the PNTHR to Eat.
          </p>
        </div>
        <button
          className={styles.refreshBtn}
          onClick={() => load(true)}
          disabled={loading}
        >
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {/* ── Loading / Error ─────────────────────────────────────────────────── */}
      {loading && (
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <p>Scoring Prey universe…</p>
          <p className={styles.loadingNote}>First load takes 1-2 minutes — weekly cached after that.</p>
        </div>
      )}

      {error && !loading && (
        <div className={styles.errorState}>
          <p>{error}</p>
          <button className={styles.retryBtn} onClick={() => load(false)}>Try Again</button>
        </div>
      )}

      {!loading && !error && data && (
        <>
          {/* ── Context Banner: SPY + QQQ ────────────────────────────────────── */}
          <div className={styles.contextBanner}>
            <span className={styles.contextLabel}>SPY:</span>
            <span className={ctx.spyAboveEma ? styles.contextBull : styles.contextBear}>
              {ctx.spyAboveEma ? '▲ Above EMA' : '▼ Below EMA'}
            </span>
            <span className={ctx.spyEmaRising ? styles.contextBull : styles.contextBear}>
              {ctx.spyEmaRising ? '· Rising' : '· Falling'}
            </span>
            <span className={styles.contextDivider}>|</span>
            <span className={styles.contextLabel}>QQQ:</span>
            <span className={ctx.qqqAboveEma ? styles.contextBull : styles.contextBear}>
              {ctx.qqqAboveEma ? '▲ Above EMA' : '▼ Below EMA'}
            </span>
            <span className={ctx.qqqEmaRising ? styles.contextBull : styles.contextBear}>
              {ctx.qqqEmaRising ? '· Rising' : '· Falling'}
            </span>
            <span className={styles.contextMeta}>
              · {data.activeSignals} scored · {data.preyCount ?? data.totalScanned} Prey · scanned {new Date(data.scannedAt).toLocaleDateString()}
            </span>
          </div>

          {/* ── Tier Summary Cards ───────────────────────────────────────────── */}
          <div className={styles.tierCards}>
            {TIERS.map(tier => {
              const count = data.tierCounts?.[tier.name] || 0;
              const isActive = tierFilter === tier.name;
              return (
                <button
                  key={tier.name}
                  className={`${styles.tierCard} ${isActive ? styles.tierCardActive : ''}`}
                  style={{ borderColor: tier.color }}
                  onClick={() => setTierFilter(isActive ? 'all' : tier.name)}
                >
                  <span className={styles.tierCardCount} style={{ color: tier.color }}>{count}</span>
                  <span className={styles.tierCardName}>{tier.name}</span>
                </button>
              );
            })}
            <button
              className={`${styles.tierCard} ${tierFilter === 'all' ? styles.tierCardActive : ''}`}
              style={{ borderColor: '#555' }}
              onClick={() => setTierFilter('all')}
            >
              <span className={styles.tierCardCount} style={{ color: '#aaa' }}>{stocks.length}</span>
              <span className={styles.tierCardName}>ALL TIERS</span>
            </button>
          </div>

          {/* ── L / S / All Tabs + Formula Guide button ─────────────────────── */}
          <div className={styles.sideTabs}>
            {[['all', 'All'], ['long', 'Longs (BL)'], ['short', 'Shorts (SS)']].map(([key, label]) => (
              <button
                key={key}
                className={`${styles.sideTab} ${side === key ? styles.sideTabActive : ''}`}
                onClick={() => setSide(key)}
              >
                {label}
                <span className={styles.sideTabCount}>
                  {key === 'all' ? filtered.length
                    : key === 'long'  ? stocks.filter(s => s.signal === 'BL' && (tierFilter === 'all' || s.tier === tierFilter)).length
                    : stocks.filter(s => s.signal === 'SS' && (tierFilter === 'all' || s.tier === tierFilter)).length}
                </span>
              </button>
            ))}
            <button
              ref={formulaBtnRef}
              className={`${styles.formulaTabBtn}${formulaOpen ? ` ${styles.formulaTabBtnActive}` : ''}`}
              onClick={toggleFormula}
              title="D1–D8 Scoring Formulas"
            >
              📐 Scoring Guide
            </button>
          </div>

          {/* ── Table ────────────────────────────────────────────────────────── */}
          {sorted.length === 0 ? (
            <div className={styles.emptyState}>No stocks match the current filters.</div>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <SortTh col="killRank" label={<>Kill<br/>Rank</>}    title="Sort by Kill Rank" />
                    <SortTh col="apexScore" label={<>Kill<br/>Score</>}  title="Sort by Kill Score" />
                    <SortTh col="tier"      label="Tier"                 title="Sort by Tier" />
                    <SortTh col="rank"      label={<>PNTHR<br/>Rank</>}  title="Sort by PNTHR Rank" />
                    <SortTh col="ticker"    label="Ticker"               title="Sort by Ticker" />
                    <SortTh col="exchange"  label="Exchange"             title="Sort by Exchange" />
                    <SortTh col="sector"    label="Sector"               title="Sort by Sector" />
                    <SortTh col="price"     label={<>Current<br/>Price</>} title="Sort by Price" />
                    <SortTh col="ytd"       label={<>YTD<br/>Return</>}  title="Sort by YTD Return" />
                    <SortTh col="signal"    label={<>PNTHR<br/>Signal</>} title="Sort by Signal" />
                    <SortTh col="wks"       label={<>Wks<br/>Since</>}   title="Sort by Weeks Since Signal" />
                    <th className={`${styles.thStatic} ${styles.thDetail}`} style={{ textAlign: 'center' }}>Score<br/>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => { sortedRef.current = sorted; return null; })()}
                  {sorted.map((stock, idx) => {
                    const tier = getTierConfig(stock.tier);
                    const wks  = computeWeeksAgo(stock.signalDate);
                    const isTop10 = stock.isTop10;
                    const isOverextended = stock.overextended === true;
                    return (
                      <tr
                        id={`aprow-${stock.ticker}`}
                        key={stock.ticker}
                        className={`${styles.row}${selectedTicker === stock.ticker ? ` ${styles.selectedRow}` : ''}${isTop10 ? ` ${styles.top10Row}` : ''}${isOverextended ? ` ${styles.overextendedRow}` : ''}`}
                        onClick={() => setSelectedTicker(stock.ticker)}
                        title={isOverextended ? `${stock.companyName || stock.ticker} — OVEREXTENDED: ${stock.scores?.d3?.separationPct ?? ''}% from EMA` : stock.companyName || stock.ticker}
                      >
                        {/* Kill Rank */}
                        <td className={styles.killRankCell}>
                          {isTop10
                            ? <KillBadge rank={stock.killRank} size={52} />
                            : isOverextended ? '—' : stock.killRank}
                        </td>

                        {/* Kill Score — pill badge, accommodates larger numbers */}
                        <td className={styles.scoreCell}>
                          <span
                            className={styles.scoreBadge}
                            style={{ background: tier.color, color: tier.textColor }}
                          >
                            {stock.apexScore}
                          </span>
                        </td>

                        {/* Tier badge */}
                        <td>
                          <span
                            className={styles.tierBadge}
                            style={{ background: tier.color, color: tier.textColor }}
                            title={tier.tagline}
                          >
                            {stock.tier}
                          </span>
                        </td>

                        {/* PNTHR 100 Rank */}
                        <td className={styles.rankCell}>
                          {stock.rank != null ? (
                            <span>
                              #{stock.rank}
                              {stock.rankChange === null || stock.rankChange === undefined
                                ? <span className={styles.rankNew}> NEW</span>
                                : stock.rankChange > 0
                                  ? <span className={styles.rankUp}> ▲+{stock.rankChange}</span>
                                  : stock.rankChange < 0
                                    ? <span className={styles.rankDown}> ▼{stock.rankChange}</span>
                                    : null}
                            </span>
                          ) : <span className={styles.badgeJungle}>JUNGLE</span>}
                        </td>

                        {/* Ticker + tags + prey strategies — click opens chart */}
                        <td
                          className={`${styles.tickerCell} ${styles.tickerClickable}`}
                          onClick={e => { e.stopPropagation(); setSelectedTicker(stock.ticker); handleRowClick(stock, idx, sorted); }}
                          title="Click to view chart"
                        >
                          <div className={styles.tickerRow}>
                            {stock.rankList && (
                              <span className={stock.rankList === 'LONG' ? styles.badgeLong : styles.badgeShort}>
                                {stock.rankList === 'LONG' ? 'L' : 'S'}
                              </span>
                            )}
                            <span className={styles.tickerText}>{stock.ticker}</span>
                            {(() => {
                              const tags = [];
                              if (stock.isSp500)    tags.push('500');
                              if (stock.isDow30)    tags.push('30');
                              if (stock.universe === 'sp400Long' || stock.universe === 'sp400Short') tags.push('400');
                              if (stock.isNasdaq100) tags.push('100');
                              return tags.length > 0
                                ? <span className={styles.membershipTag}>({tags.join(', ')})</span>
                                : null;
                            })()}
                          </div>
                          {stock.companyName && <div className={styles.companyName}>{stock.companyName}</div>}
                          <PreyTags strategies={stock.preyStrategies} />
                        </td>

                        <td>{stock.exchange}</td>
                        <td className={styles.sectorCell}>{stock.sector}</td>

                        {/* Price */}
                        <td className={styles.price}>${stock.currentPrice?.toLocaleString()}</td>

                        {/* YTD */}
                        <td className={stock.ytdReturn != null ? (stock.ytdReturn >= 0 ? styles.positive : styles.negative) : ''}>
                          {stock.ytdReturn != null ? `${stock.ytdReturn >= 0 ? '+' : ''}${stock.ytdReturn.toFixed(2)}%` : '—'}
                        </td>

                        {/* Signal */}
                        <td>
                          {stock.signal === 'BL'
                            ? <span className={styles.sigBadgeBL}>{stock.isNewSignal ? '★ BL' : 'BL'}</span>
                            : stock.signal === 'SS'
                              ? <span className={styles.sigBadgeSS}>{stock.isNewSignal ? '★ SS' : 'SS'}</span>
                              : <span className={styles.sigNone}>—</span>}
                        </td>

                        {/* Weeks since signal */}
                        <td className={styles.wksCell}>
                          {wks != null
                            ? <span className={stock.signal === 'BL' ? styles.wksBL : styles.wksSS}>{stock.signal}+{wks}</span>
                            : '—'}
                        </td>

                        {/* Score Detail hover */}
                        <td
                          className={styles.detailCell}
                          onMouseEnter={(e) => {
                            if (!stock.scores) return;
                            const rect = e.currentTarget.getBoundingClientRect();
                            setPopup({ ticker: stock.ticker, apexScore: stock.apexScore, scores: stock.scores, preMultiplier: stock.preMultiplier, x: rect.left, y: rect.bottom + 4 });
                          }}
                          onMouseLeave={() => setPopup(null)}
                        >
                          <span className={styles.detailIcon}>📊</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ── Score Breakdown Popup (fixed, avoids overflow clipping) ─────────── */}
      {popup && (
        <div
          className={styles.breakdownPopupFixed}
          style={{ left: Math.max(8, popup.x - 240), top: popup.y }}
        >
          <div className={styles.breakdownTitle}>{popup.ticker} — Kill Score: {popup.apexScore}</div>
          <ScoreBreakdown scores={popup.scores} preMultiplier={popup.preMultiplier} total={popup.apexScore} />
        </div>
      )}

      {/* ── D1–D8 Formula Guide Popup (click to open/close) ─────────────────── */}
      {formulaOpen && (
        <div
          className={styles.formulaPopup}
          style={{ left: formulaPos.x, top: formulaPos.y }}
        >
          <div className={styles.formulaHeader}>
            <span className={styles.formulaTitle}>D1–D8 Scoring Formulas</span>
            <button className={styles.formulaClose} onClick={() => setFormulaOpen(false)}>✕</button>
          </div>
          <div className={styles.formulaList}>
            {FORMULA_GUIDE.map(f => (
              <div key={f.dim} className={styles.formulaItem}>
                <div className={styles.formulaDim}>{f.dim}</div>
                <div className={styles.formulaDesc}>{f.desc}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Chart Modal ─────────────────────────────────────────────────────── */}
      {chartIndex != null && (
        <ChartModal
          stocks={chartStocks}
          initialIndex={chartIndex}
          signals={Object.fromEntries(chartStocks.map(s => [s.ticker, { signal: s.signal, signalDate: s.signalDate, isNewSignal: s.isNewSignal, stopPrice: s.stopPrice }]))}
          earnings={{}}
          onClose={() => setChartIndex(null)}
        />
      )}
    </div>
  );
}
