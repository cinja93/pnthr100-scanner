import { useState, useEffect, useRef, useMemo } from 'react';
import { useAuth } from '../AuthContext';
import { useQueue } from '../contexts/QueueContext';
import { useAnalyzeContext } from '../contexts/AnalyzeContext';
import { computeAnalyzeScore } from '../utils/analyzeScore';
import { computeWeeksAgo } from '../utils/dateUtils';
import ChartModal from './ChartModal';
import KillBadge from './KillBadge';
import { fetchApexStocks, API_BASE, authHeaders } from '../services/api';
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
      case 'analyzeScore': av = a.analyzeScore ?? -1;  bv = b.analyzeScore ?? -1;  break;
      case 'composite':    av = a.composite   ?? -1;  bv = b.composite   ?? -1;  break;
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

// ── D1–D8 Formula reference data (v4.2) ──────────────────────────────────────
const FORMULA_GUIDE = [
  {
    dim: 'FORMULA · Total = (D2+D3+D4+D5+D6+D7+D8) × D1',
    desc: 'D1 is a multiplier (0.70×–1.30×) applied to the sum of all additive dimensions. Aligned with the market regime amplifies scores; fighting it compresses them.',
  },
  {
    dim: 'D1 · Market Regime Multiplier  (0.70× – 1.30×)',
    desc: 'Nasdaq stocks route to QQQ; NYSE/ARCA to SPY. Index EMA position + slope scored −2 to +2. SS:BL open ratio and new-signal ratio add ±1–2. regimeScore (−5 to +5) × 0.06 = adjustment. BL: 1.0 + adj; SS: 1.0 − adj.',
  },
  {
    dim: 'D2 · Sector Alignment  (±15 pts, capped)',
    desc: 'Sector direction = sign of sector ETF 5D return. 5D component: |return5D%| × newMult × direction × 2 (new signals get 2×). 1M component: |return1M%| × direction. Total capped ±15.',
  },
  {
    dim: 'D3 · Entry Quality  (0–85 pts) — THE KEY DIMENSION',
    desc: 'Sub-A: Close conviction = (close−low)/(high−low)×100 × 2.5, cap 40 pts. Sub-B: EMA slope% × 10 (signal direction only), cap 30 pts. Sub-C: EMA separation — BELL CURVE, sweet spot 2-8%: 0-2% ramp (0→6 pts), 2-8% (6→15 pts), 8-15% decay (15→3 pts), 15-20% steep decay (3→0 pts), 20%+ = OVEREXTENDED (hard gate, disqualified). Confirmation: CONFIRMED ≥30 pts, PARTIAL ≥15, UNCONFIRMED <15.',
  },
  {
    dim: 'OVEREXTENDED · Hard Gate (close separation > 20%)',
    desc: 'The move already happened — entering now is chasing, not hunting. Stocks with close-based EMA separation > 20% receive score −99, are excluded from Kill rankings, and appear greyed-out at the bottom of the list. D4–D8 are not calculated.',
  },
  {
    dim: 'D4 · Signal Freshness  (−15 to +10 pts)',
    desc: 'Age 0 (new this week): CONFIRMED +10, PARTIAL +6, UNCONFIRMED +3. Age 1: CONFIRMED +7, PARTIAL +4, UNCONFIRMED +2. Age 2: +4. Age 3–5: 0. Age 6–9: −3/wk beyond week 5. Age 10+: smooth decay −1.5/wk from −12, floor −15.',
  },
  {
    dim: 'D5 · Rank Rise  (±20 pts)',
    desc: '+1 pt per PNTHR rank position risen this week, −1 per position dropped. New entries (no prior rank): 0 pts. Capped ±20 — 55% of +30 rank jumps revert the following week.',
  },
  {
    dim: 'D6 · Momentum  (−10 to +20 pts)',
    desc: 'Sub-A RSI: (RSI−50)/10 → ±5 pts (inverted for SS). Sub-B OBV: week-over-week% ÷ 5 → ±5 pts (inverted for SS). Sub-C ADX: (ADX−15)/5 → 0–5 pts, only when ADX rising above 15. Sub-D Volume: +5 if volume ratio > 1.5×. Floor −10, cap +20.',
  },
  {
    dim: 'D7 · Rank Velocity  (±10 pts)',
    desc: 'Acceleration of rank movement: velocity = currentRankChange − previousRankChange. score = clip(round(velocity ÷ 6), −10, +10). A stock rising faster than last week scores positive; decelerating or reversing scores negative.',
  },
  {
    dim: 'D8 · Multi-Strategy Prey Presence  (0–6 pts)',
    desc: 'SPRINT +2 pts (PNTHR 100 riser). HUNT +2 pts (EMA crossover scan). FEAST / ALPHA / SPRING / SNEAK +1 pt each. Maximum 6 pts. Acts as tiebreaker — most of the 679 universe scores 0 here.',
  },
];

// ── Tier + UI info definitions (shown in ⓘ popups) ───────────────────────────
const TIER_DEFS = {
  'ALPHA PNTHR KILL': '≥130 pts — The rarest and highest-conviction setup. Every dimension is firing: strong entry quality, perfect sector alignment, fresh signal, rising rank with acceleration, powerful momentum, and multiple Prey strategy confirmation — all amplified by a favorable market regime. Historically requires all 8 dimensions to align simultaneously. Immediate action candidate.',
  'STRIKING':         '≥100 pts — A high-conviction setup with strong entry quality confirmed by multiple supporting dimensions. The core metrics (conviction, slope, separation) are solid, and at least 3–4 other dimensions are contributing meaningfully. These are your primary Kill Pipeline candidates for new position entries.',
  'HUNTING':          '≥80 pts — An active setup with confirmed entry quality and moderate support from other dimensions. The trade has a clear directional signal backed by data, but not every dimension is aligned. Worth evaluating for entry if you have available Vitality slots and the sector isn\'t saturated.',
  'POUNCING':         '≥65 pts — A developing setup where entry quality is present but supporting dimensions are mixed. Some factors confirm the trade, others are neutral or slightly negative. Monitor for improvement — if momentum or rank velocity picks up, this could promote to Hunting.',
  'COILING':          '≥50 pts — Building energy but not yet confirmed. The signal exists and some metrics are positive, but the confirmation gate may not be fully met. These are stocks to watch, not to enter. They may be developing setups that need another week of data.',
  'STALKING':         '≥35 pts — On the watchlist. The signal is present but entry quality is low or the supporting dimensions are weak. Keep an eye on it but don\'t commit capital until the score improves significantly.',
  'TRACKING':         '≥20 pts — Early detection. The system has identified a directional signal but there\'s minimal confirmation. Too early and too weak for any action.',
  'PROWLING':         '≥10 pts — Low signal strength. Barely registering on the scoring system. The stock has a signal but almost nothing supports it.',
  'STIRRING':         '≥0 pts — Neutral. The stock has a signal but the positive and negative dimensions are roughly canceling out. No edge.',
  'DORMANT':          '<0 pts — Fighting conditions. The dimensions are working against this signal — wrong regime, misaligned sector, weak entry, stale signal. The system is actively saying "do not enter this trade."',
  'OVEREXTENDED':     'Filtered out — The stock has moved more than 20% away from its sector EMA at the close. The move has already happened. Entering now would be chasing, not hunting. These stocks are removed from Kill rankings entirely. They may reappear if price reverts closer to the EMA.',
};

const UI_DEFS = {
  regime: 'Market Regime — The regime multiplier adjusts all Kill scores based on the broad market environment. When SPY and QQQ are below their falling 21-week EMAs (bear market), short signals are amplified up to 1.30× and long signals are dampened to 0.70×. When both are above rising EMAs (bull market), the reverse applies. This ensures the system favors trades aligned with the prevailing market direction.',
  bl:     'Longs (BL) — Buy Long signals. Stocks that have crossed above their sector EMA with an upward-sloping EMA and confirmed entry quality. In a bear regime, these are dampened by the regime multiplier and fewer will score highly.',
  ss:     'Shorts (SS) — Sell Short signals. Stocks that have crossed below their sector EMA with a downward-sloping EMA and confirmed entry quality. In a bear regime, these are amplified by the regime multiplier and will dominate the top rankings.',
};

export default function ApexPage() {
  const { isAdmin } = useAuth();
  const { queue, toggleQueue, queuedTickers } = useQueue();
  const { analyzeContext } = useAnalyzeContext() || {};
  const [data, setData]             = useState(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [side, setSide]             = useState('all');
  const [tierFilter, setTierFilter] = useState('all');
  const [popup, setPopup]           = useState(null);
  const [infoPopup, setInfoPopup]   = useState(null); // { def, x, y }
  const [formulaOpen, setFormulaOpen] = useState(false);
  const [formulaPos, setFormulaPos]   = useState({ x: 0, y: 0 });
  const formulaBtnRef = useRef(null);
  const [healthOpen,    setHealthOpen]    = useState(false);
  const [healthData,    setHealthData]    = useState(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [chartIndex, setChartIndex] = useState(null);
  const [chartStocks, setChartStocks] = useState([]);
  const [sortConfig, setSortConfig] = useState({ key: 'apexScore', dir: 'desc' });
  const [selectedTicker, setSelectedTicker] = useState(null);
  const [killSearch, setKillSearch] = useState('');
  const sortedRef = useRef([]);
  const searchRowRef = useRef(null);

  // Auto-scroll to exact match when search has exactly one result
  useEffect(() => {
    if (killSearchTrim && displaySorted.length === 1 && searchRowRef.current) {
      searchRowRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [killSearch]);

  async function openHealth() {
    setHealthOpen(true);
    if (healthData) return; // already loaded
    setHealthLoading(true);
    try {
      const res  = await fetch(`${API_BASE}/api/scoring-health`, { headers: authHeaders() });
      const json = await res.json();
      setHealthData(json);
    } catch { setHealthData({ status: 'ERROR', message: 'Failed to load health data.' }); }
    finally { setHealthLoading(false); }
  }

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

  // ⓘ info popup — shows tier / UI element definitions
  function showInfo(def, e) {
    e.stopPropagation();
    if (!def) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const popupW = 310;
    const popupH = 180;
    const spaceBelow = window.innerHeight - rect.bottom - 10;
    const x = Math.max(8, Math.min(rect.left - popupW / 2 + 8, window.innerWidth - popupW - 8));
    const y = spaceBelow >= popupH ? rect.bottom + 6 : Math.max(8, rect.top - popupH - 6);
    setInfoPopup(prev => (prev && prev.def === def) ? null : { def, x, y });
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

  const rawStocks = data?.stocks || [];

  // Enrich every stock with Analyze score + composite for sorting/display
  const stocks = useMemo(() => {
    if (!analyzeContext || !rawStocks.length) return rawStocks;
    const maxScore = Math.max(...rawStocks.map(s => s.apexScore || 0));
    return rawStocks.map(s => {
      const enriched = { ...s, pipelineMaxScore: maxScore };
      const ar = computeAnalyzeScore(enriched, analyzeContext);
      return {
        ...s,
        analyzeScore: ar?.pct ?? null,
        analyzeResult: ar,
        composite: ar?.composite ?? null,
      };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, analyzeContext]);

  const filtered = stocks.filter(s => {
    if (side === 'long'  && s.signal !== 'BL') return false;
    if (side === 'short' && s.signal !== 'SS') return false;
    if (tierFilter !== 'all' && s.tier !== tierFilter) return false;
    return true;
  });

  // Kill search: filter within already-filtered+sorted results
  const sorted = sortStocks(filtered, sortConfig);
  const killSearchTrim = killSearch.trim();
  const displaySorted = killSearchTrim
    ? sorted.filter(s => s.ticker.includes(killSearchTrim))
    : sorted;
  const killSearchNotFound = killSearchTrim && displaySorted.length === 0;

  function handleRowClick(stock, idx, list) {
    setChartStocks(list);
    setChartIndex(idx);
  }

  const ctx = data?.contextSummary || {};

  return (
    <div className={styles.page} onClick={() => setInfoPopup(null)}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>
            <img src={pantherHead} alt="PNTHR" className={styles.pantherLogo} />
            PNTHR KILL
          </h1>
          <p className={styles.subtitle}>
            KILL tells you WHAT to trade. ANALYZE tells you WHEN to trade it. A stock can be Kill #1 RANK for weeks. But there's only a narrow window in the first 1-3 weeks after signal where the Analyze score says NOW. If you miss that window, you wait for the next signal. You don't chase. Minimum gates: Kill rank: Top 20 (HUNTING tier or better, score ≥80), Analyze: ≥75%, Composite: ≥65. That's the floor. That's when the PNTHR Eats!
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
            {isAdmin && <span className={styles.infoIconSpan} onClick={e => showInfo(UI_DEFS.regime, e)} title="What is Market Regime?">ⓘ</span>}
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
                  style={{ borderColor: tier.color, position: 'relative' }}
                  onClick={() => setTierFilter(isActive ? 'all' : tier.name)}
                >
                  <span className={styles.tierCardCount} style={{ color: tier.color }}>{count}</span>
                  <span className={styles.tierCardName}>{tier.name}</span>
                  {TIER_DEFS[tier.name] && (
                    <span
                      className={styles.infoIconCorner}
                      onClick={e => showInfo(TIER_DEFS[tier.name], e)}
                      title="What does this tier mean?"
                    >ⓘ</span>
                  )}
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

          {/* ── Controls Bar: Signal tabs · Search · Admin tools ─────────────── */}
          <div className={styles.controlsBar}>

            {/* Left: Signal filter tabs */}
            <div className={styles.controlsLeft}>
              {[['all', 'All'], ['long', 'Longs (BL)'], ['short', 'Shorts (SS)']].map(([key, label]) => (
                <button
                  key={key}
                  className={`${styles.sideTab} ${side === key ? styles.sideTabActive : ''}`}
                  onClick={() => setSide(key)}
                >
                  {label}
                  {key === 'long' && (
                    <span className={styles.infoIconSpan} onClick={e => showInfo(UI_DEFS.bl, e)} title="What is a BL signal?">ⓘ</span>
                  )}
                  {key === 'short' && (
                    <span className={styles.infoIconSpan} onClick={e => showInfo(UI_DEFS.ss, e)} title="What is an SS signal?">ⓘ</span>
                  )}
                  <span className={styles.sideTabCount}>
                    {key === 'all' ? filtered.length
                      : key === 'long'  ? stocks.filter(s => s.signal === 'BL' && (tierFilter === 'all' || s.tier === tierFilter)).length
                      : stocks.filter(s => s.signal === 'SS' && (tierFilter === 'all' || s.tier === tierFilter)).length}
                  </span>
                </button>
              ))}
            </div>

            {/* Divider */}
            <div className={styles.controlsDivider} />

            {/* Centre: Ticker search */}
            <div className={styles.controlsSearch}>
              <span className={styles.controlsSearchLabel}>FIND:</span>
              <input
                type="text"
                placeholder="e.g. COIN"
                value={killSearch}
                onChange={e => setKillSearch(e.target.value.toUpperCase())}
                className={styles.killSearchInput}
                style={{ borderColor: killSearch ? '#FCF000' : 'rgba(252,240,0,0.35)' }}
              />
              {killSearch && (
                <button onClick={() => setKillSearch('')} className={styles.killSearchClear} title="Clear">✕</button>
              )}
            </div>

            {/* Right: Admin tools */}
            {isAdmin && (
              <div className={styles.controlsRight}>
                <button
                  ref={formulaBtnRef}
                  className={`${styles.formulaTabBtn}${formulaOpen ? ` ${styles.formulaTabBtnActive}` : ''}`}
                  onClick={toggleFormula}
                  title="D1–D8 Scoring Formulas"
                >
                  📐 Scoring Guide
                </button>
                <button
                  className={styles.formulaTabBtn}
                  onClick={openHealth}
                  title="Scoring engine dimension health check"
                >
                  ⚡ System Health
                </button>
              </div>
            )}
          </div>

          {/* ── Table ────────────────────────────────────────────────────────── */}
          {killSearchNotFound ? (
            <div className={styles.emptyState}>
              <span style={{ color: '#FCF000', fontFamily: 'monospace', fontSize: 15 }}>
                {killSearch}
              </span>
              <span style={{ color: '#888', marginLeft: 8 }}>— Not found in PNTHR Kill universe.</span>
            </div>
          ) : displaySorted.length === 0 ? (
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
                    <SortTh col="analyzeScore" label={<>Ana&shy;lyze</>}  title="Sort by Analyze pre-trade score" />
                    <SortTh col="composite"    label={<>Com&shy;posite</>} title="Sort by Composite (Kill × Analyze%)" />
                    <th className={`${styles.thStatic} ${styles.thDetail}`} style={{ textAlign: 'center' }}>Score<br/>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => { sortedRef.current = displaySorted; return null; })()}
                  {displaySorted.map((stock, idx) => {
                    const tier = getTierConfig(stock.tier);
                    const wks  = computeWeeksAgo(stock.signalDate);
                    const isTop10 = stock.isTop10;
                    const isOverextended = stock.overextended === true;
                    const isSearchMatch = killSearchTrim && stock.ticker === killSearchTrim;
                    return (
                      <tr
                        id={`aprow-${stock.ticker}`}
                        key={stock.ticker}
                        ref={isSearchMatch ? searchRowRef : null}
                        className={`${styles.row}${selectedTicker === stock.ticker ? ` ${styles.selectedRow}` : ''}${isTop10 ? ` ${styles.top10Row}` : ''}${isOverextended ? ` ${styles.overextendedRow}` : ''}`}
                        style={isSearchMatch ? { outline: '2px solid #FCF000', outlineOffset: '-2px' } : undefined}
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
                          onClick={e => { e.stopPropagation(); setSelectedTicker(stock.ticker); handleRowClick(stock, idx, displaySorted); }}
                          title="Click to view chart"
                        >
                          <div className={styles.tickerRow}>
                            {stock.rankList && (
                              <span className={stock.rankList === 'LONG' ? styles.badgeLong : styles.badgeShort}>
                                {stock.rankList === 'LONG' ? 'L' : 'S'}
                              </span>
                            )}
                            <span className={styles.tickerText}>{stock.ticker}</span>
                            {queuedTickers.has(stock.ticker) && (
                              <span style={{ fontSize: 9, fontWeight: 800, background: '#FFD700', color: '#000',
                                padding: '1px 5px', borderRadius: 3, letterSpacing: '0.04em' }}>QUEUED</span>
                            )}
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

                        {/* Analyze pre-trade score */}
                        <td className={styles.analyzeCell} style={{ textAlign: 'center', fontFamily: 'monospace', fontWeight: 700 }}>
                          {stock.analyzeScore != null ? (
                            <span
                              style={{ color: stock.analyzeResult?.color || '#888' }}
                              title={stock.analyzeResult?.warnings?.length ? stock.analyzeResult.warnings.join('\n') : `Pre-trade score: ${stock.analyzeScore}%`}
                            >
                              {stock.analyzeScore}%
                              {stock.analyzeResult?.warnings?.length > 0 && <span style={{ marginLeft: 2, fontSize: 10 }}>⚠</span>}
                            </span>
                          ) : '—'}
                        </td>

                        {/* Composite: Kill × Analyze% */}
                        <td className={styles.analyzeCell} style={{ textAlign: 'center', fontFamily: 'monospace', fontWeight: 700, color: '#FFD700' }}>
                          {stock.composite != null ? stock.composite : '—'}
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

      {/* ── ⓘ Info Popup (tier + UI element definitions) ─────────────────────── */}
      {infoPopup && (
        <div
          className={styles.infoPopupBox}
          style={{ left: infoPopup.x, top: infoPopup.y }}
          onClick={e => e.stopPropagation()}
        >
          {infoPopup.def}
        </div>
      )}

      {/* ── System Health Modal ─────────────────────────────────────────────── */}
      {healthOpen && (
        <div
          onClick={() => setHealthOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: '#141414', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, width: 620, maxHeight: '90vh', overflowY: 'auto', fontFamily: 'monospace' }}
          >
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <div>
                <div style={{ color: '#fcf000', fontWeight: 700, fontSize: 15, letterSpacing: 1 }}>⚡ SCORING ENGINE HEALTH</div>
                {healthData && !healthLoading && (
                  <div style={{ color: '#666', fontSize: 11, marginTop: 3 }}>
                    Week of {healthData.weekOf || '—'} · {healthData.lastRun ? new Date(healthData.lastRun).toLocaleString() : '—'} · {healthData.stocksScored ?? 0} stocks scored
                  </div>
                )}
              </div>
              <button onClick={() => setHealthOpen(false)} style={{ background: 'none', border: 'none', color: '#666', fontSize: 18, cursor: 'pointer', lineHeight: 1 }}>✕</button>
            </div>

            {/* Body */}
            <div style={{ padding: '12px 20px 20px' }}>
              {healthLoading && <div style={{ color: '#666', textAlign: 'center', padding: 40 }}>Loading…</div>}
              {!healthLoading && healthData?.message && <div style={{ color: '#ff6b6b', padding: 20 }}>{healthData.message}</div>}
              {!healthLoading && healthData?.dimensions && (() => {
                const statusIcon  = s => s === 'OK' ? '✅' : s === 'WARNING' ? '⚠️' : '❌';
                const statusColor = s => s === 'OK' ? '#28a745' : s === 'WARNING' ? '#fcf000' : '#dc3545';
                const fmtSample   = (id, val) => {
                  if (val === null || val === undefined) return '—';
                  if (id === 'D1') return `${(+val).toFixed(2)}×`;
                  return `${val > 0 ? '+' : ''}${(+val).toFixed(1)} pts`;
                };
                return (
                  <>
                    {healthData.dimensions.map(d => (
                      <div key={d.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', padding: '10px 0' }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                          <span style={{ fontSize: 16 }}>{statusIcon(d.status)}</span>
                          <span style={{ color: '#fcf000', fontWeight: 700, fontSize: 13, width: 26 }}>{d.id}</span>
                          <span style={{ color: '#fff', fontWeight: 600, fontSize: 13, width: 160 }}>{d.name}</span>
                          <span style={{ color: statusColor(d.status), fontSize: 13, fontWeight: 600, flex: 1 }}>
                            {fmtSample(d.id, d.sample)}
                          </span>
                          <span style={{ color: '#555', fontSize: 11 }}>{d.range}</span>
                        </div>
                        <div style={{ marginLeft: 52, marginTop: 2 }}>
                          <span style={{ color: statusColor(d.status), fontSize: 11 }}>
                            {d.status === 'OK' ? `${d.nonZero}/${d.total} stocks scoring` : d.status === 'WARNING' ? `${d.nonZero}/${d.total} non-zero — may be data gap` : 'No data — check pipeline'}
                          </span>
                          <span style={{ color: '#444', fontSize: 10, marginLeft: 10 }}>· {d.source}</span>
                        </div>
                      </div>
                    ))}

                    {/* Summary bar */}
                    <div style={{ marginTop: 16, padding: '10px 14px', background: '#0a0a0a', borderRadius: 6, display: 'flex', gap: 20, fontSize: 13 }}>
                      <span style={{ color: '#28a745' }}>✅ {healthData.okCount} OK</span>
                      <span style={{ color: '#fcf000' }}>⚠️ {healthData.warnCount} warnings</span>
                      <span style={{ color: '#dc3545' }}>❌ {healthData.errCount} errors</span>
                      <span style={{ color: '#555', marginLeft: 'auto', fontSize: 11 }}>source: {healthData.source}</span>
                    </div>
                    <div style={{ marginTop: 10, textAlign: 'right' }}>
                      <button
                        onClick={() => { setHealthData(null); openHealth(); }}
                        style={{ background: 'none', border: '1px solid rgba(255,255,255,0.15)', color: '#aaa', borderRadius: 4, padding: '4px 12px', fontSize: 11, cursor: 'pointer' }}
                      >
                        ↺ Refresh
                      </button>
                    </div>
                  </>
                );
              })()}
            </div>
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
