import { useState, useEffect, useRef, useMemo } from 'react';
import { createChart, BarSeries, LineSeries } from 'lightweight-charts';
import { fetchChartData, fetchEntryDates, fetchWatchlist, addWatchlistTicker, removeWatchlistTicker, fetchKillPipeline, fetchNav, API_BASE, authHeaders } from '../services/api';
import { sizePosition, calcHeat, STRIKE_PCT, isEtfTicker } from '../utils/sizingUtils.js';
import { useQueue } from '../contexts/QueueContext';
import { useAuth } from '../AuthContext';
import { useAnalyzeContext } from '../contexts/AnalyzeContext';
import { computeAnalyzeScore, computeETFAnalyzeScore } from '../utils/analyzeScore';
import { isClassifiedETF } from '../utils/etfClassification';
import { getSectorEmaPeriod } from '../utils/sectorEmaConfig';
import styles from './ChartModal.module.css';
import pantherHeadIcon from '../assets/panther head.png';
import KillBadge from './KillBadge';

// ── Module-level kill rank cache ─────────────────────────────────────────────
// Fetched once per session; Map<ticker, killRank (1-10)> for the current week's
// top-10 stocks. This lets the badge show from ANY page, not just Kill page.
let _killRankMap = null;
let _killRankMapTime = 0;
let _killRankFetching = false;
const _killRankCallbacks = [];
const KILL_RANK_TTL = 30 * 60 * 1000; // 30 minutes

function loadKillRanks() {
  if (_killRankMap && (Date.now() - _killRankMapTime < KILL_RANK_TTL)) return Promise.resolve(_killRankMap);
  if (_killRankMap && (Date.now() - _killRankMapTime >= KILL_RANK_TTL)) {
    _killRankMap = null; // TTL expired — force re-fetch
  }
  return new Promise((resolve) => {
    _killRankCallbacks.push(resolve);
    if (_killRankFetching) return;
    _killRankFetching = true;
    fetchKillPipeline()
      .then(data => {
        const map = new Map();
        for (const s of (data.stocks || [])) {
          if (s.killRank <= 10) map.set(s.ticker, s.killRank);
        }
        _killRankMap = map;
        _killRankMapTime = Date.now();
      })
      .catch(() => { _killRankMap = new Map(); _killRankMapTime = Date.now(); }) // graceful failure → no badges
      .finally(() => {
        _killRankFetching = false;
        for (const cb of _killRankCallbacks) cb(_killRankMap);
        _killRankCallbacks.length = 0;
      });
  });
}
// ─────────────────────────────────────────────────────────────────────────────


function aggregateToWeekly(dailyData) {
  const sorted = [...dailyData].sort((a, b) => (a.date < b.date ? -1 : 1));
  const weeksMap = new Map();
  for (const day of sorted) {
    const date = new Date(day.date + 'T00:00:00');
    const dow = date.getDay();
    const monday = new Date(date);
    monday.setDate(date.getDate() - (dow === 0 ? 6 : dow - 1));
    const weekKey = monday.toISOString().split('T')[0];
    if (!weeksMap.has(weekKey)) {
      weeksMap.set(weekKey, { time: weekKey, open: day.open, high: day.high, low: day.low, close: day.close, volume: day.volume || 0 });
    } else {
      const w = weeksMap.get(weekKey);
      w.high = Math.max(w.high, day.high);
      w.low = Math.min(w.low, day.low);
      w.close = day.close;
      w.volume = (w.volume || 0) + (day.volume || 0);
    }
  }
  return [...weeksMap.values()];
}

// Wilder RSI(period) on weekly closes. Returns the current RSI value or null.
function calculateRSI(weeklyData, period = 14) {
  if (weeklyData.length < period + 1) return null;
  const closes = weeklyData.map(d => d.close);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const chg = closes[i] - closes[i - 1];
    if (chg > 0) avgGain += chg; else avgLoss += Math.abs(chg);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const chg = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(chg, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-chg, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));
}

function calculateEMA(weeklyData, period) {
  if (weeklyData.length < period) return [];
  const k = 2 / (period + 1);
  const result = [];
  let ema = weeklyData.slice(0, period).reduce((sum, d) => sum + d.close, 0) / period;
  result.push({ time: weeklyData[period - 1].time, value: parseFloat(ema.toFixed(4)) });
  for (let i = period; i < weeklyData.length; i++) {
    ema = weeklyData[i].close * k + ema * (1 - k);
    result.push({ time: weeklyData[i].time, value: parseFloat(ema.toFixed(4)) });
  }
  return result;
}

// Wilder's ATR(period) over weekly bars.
// Returns array indexed by bar index; atrArr[i] = ATR through bar i (null until seeded).
function computeWilderATR(weeklyData, period = 3) {
  const n = weeklyData.length;
  const atrArr = new Array(n).fill(null);
  if (n < period + 1) return atrArr;
  const trs = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const cur = weeklyData[i], prev = weeklyData[i - 1];
    trs[i] = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
  }
  let atr = 0;
  for (let i = 1; i <= period; i++) atr += trs[i];
  atr /= period;
  atrArr[period] = atr;
  for (let i = period + 1; i < n; i++) {
    atr = (atr * 2 + trs[i]) / 3;
    atrArr[i] = atr;
  }
  return atrArr;
}

// Initial PNTHR stop for a new BL entry:
//   structural: 2-week low − $0.01  (floor: price must stay above prior support)
//   ATR floor:  entry close − ATR(3) (tightest reasonable stop below close)
//   Take the HIGHER of the two (most conservative = higher stop for a long).
function blInitStop(twoWeekLow, entryClose, atr) {
  const structural = parseFloat((twoWeekLow - 0.01).toFixed(2));
  const atrBased   = atr != null ? parseFloat((entryClose - atr).toFixed(2)) : -Infinity;
  return parseFloat(Math.max(structural, atrBased).toFixed(2));
}

// Initial PNTHR stop for a new SS entry:
//   structural: 2-week high + $0.01  (ceiling: price must stay below prior resistance)
//   ATR ceiling: entry close + ATR(3) (tightest reasonable stop above close)
//   Take the LOWER of the two (most conservative = lower stop for a short).
function ssInitStop(twoWeekHigh, entryClose, atr) {
  const structural = parseFloat((twoWeekHigh + 0.01).toFixed(2));
  const atrBased   = atr != null ? parseFloat((entryClose + atr).toFixed(2)) : Infinity;
  return parseFloat(Math.min(structural, atrBased).toFixed(2));
}

// Scan full weekly history; returns events: BL/SS entries + BE/SE exits.
//
// BL (Launch): weekLow is 1–10% above 21-EMA, within first 3 bars of long-daylight streak
//              (current or previous bar is the 1st or 2nd bar where low > EMA).
// SS (Failure): weekHigh is 1–10% below 21-EMA, within first 3 bars of short-daylight streak.
// Phase 5 exit: structural 2-week low/high + 0.1% predatory buffer, trigger on weekly close.
// Returns { events, pnthrStop, currentWeekStop, activeType } where stop fields are
// non-null only when the most recent BL/SS signal is still open (no following BE/SE).
function detectAllSignals(weeklyData, period = 21, isETF = false) {
  if (weeklyData.length < period + 2) return { events: [], pnthrStop: null, currentWeekStop: null, activeType: null };
  const emaData = calculateEMA(weeklyData, period);
  const atrArr  = computeWilderATR(weeklyData);
  const events  = [];
  let position         = null;  // { type, entryWi, entryPrice, pnthrStop }
  let longDaylight     = 0;
  let shortDaylight    = 0;
  let longTrendActive   = false;
  let longTrendCapped   = false;
  let shortTrendActive  = false;
  let shortTrendCapped  = false;

  for (let wi = period + 1; wi < weeklyData.length; wi++) {
    const emaIdx = wi - (period - 1);
    if (emaIdx < 1) continue;
    const current     = weeklyData[wi];
    const prev1       = weeklyData[wi - 1];
    const prev2       = weeklyData[wi - 2];
    const emaCurrent  = emaData[emaIdx].value;
    const twoWeekHigh = Math.max(prev1.high, prev2.high);
    const twoWeekLow  = Math.min(prev1.low,  prev2.low);

    longDaylight  = current.low  > emaCurrent ? longDaylight + 1 : 0;
    shortDaylight = current.high < emaCurrent ? shortDaylight + 1 : 0;

    // Past entry week: update PNTHR stop (ratchet), then check for BE/SE exit
    if (position && position.entryWi !== wi) {
      const prevAtr = atrArr[wi - 1];
      if (prevAtr != null) {
        if (position.type === 'BL') {
          const structStop = parseFloat((twoWeekLow - 0.01).toFixed(2));
          const atrFloor   = parseFloat((prev1.close - prevAtr).toFixed(2));
          const candidate  = Math.max(structStop, atrFloor);
          position.pnthrStop = parseFloat(Math.max(position.pnthrStop, candidate).toFixed(2));
        } else {
          const structStop  = parseFloat((twoWeekHigh + 0.01).toFixed(2));
          const atrCeiling  = parseFloat((prev1.close + prevAtr).toFixed(2));
          const candidate   = Math.min(structStop, atrCeiling);
          position.pnthrStop = parseFloat(Math.min(position.pnthrStop, candidate).toFixed(2));
        }
      }

      if (position.type === 'BL') {
        if (current.low < twoWeekLow) {
          const exitPrice    = parseFloat((twoWeekLow - 0.01).toFixed(2));
          const profitDollar = parseFloat((exitPrice - position.entryPrice).toFixed(2));
          const profitPct    = parseFloat(((profitDollar / position.entryPrice) * 100).toFixed(2));
          events.push({ time: current.time, signal: 'BE', barLow: current.low, barHigh: current.high, profitDollar, profitPct });
          shortTrendActive = true;
          shortTrendCapped = true;
          position = null; continue;
        }
      } else {
        if (current.high > twoWeekHigh) {
          const exitPrice    = parseFloat((twoWeekHigh + 0.01).toFixed(2));
          const profitDollar = parseFloat((position.entryPrice - exitPrice).toFixed(2));
          const profitPct    = parseFloat(((profitDollar / position.entryPrice) * 100).toFixed(2));
          events.push({ time: current.time, signal: 'SE', barLow: current.low, barHigh: current.high, profitDollar, profitPct });
          longTrendActive = true;
          longTrendCapped = true;
          position = null; continue;
        }
      }
    }

    if (!position) {
      const emaPrev  = emaData[emaIdx - 1].value;
      const blPhase1 = current.close > emaCurrent && emaCurrent > emaPrev && current.high >= twoWeekHigh + 0.01;
      const ssPhase1 = current.close < emaCurrent && emaCurrent < emaPrev && current.low  <= twoWeekLow  - 0.01;
      // ETFs use a tighter 0.3% daylight zone (vs 1% for stocks) so signals fire sooner
      const dPct = isETF ? 0.003 : 0.01;
      const blZone   = current.low  >= emaCurrent * (1 + dPct) && current.low  <= emaCurrent * 1.10;
      const ssZone   = current.high <= emaCurrent * (1 - dPct) && current.high >= emaCurrent * 0.90;

      const blReentry    = longTrendActive  && current.low  >= emaCurrent * (1 + dPct) && (!longTrendCapped  || current.low  <= emaCurrent * 1.25);
      const ssReentry    = shortTrendActive && current.high <= emaCurrent * (1 - dPct) && (!shortTrendCapped || current.high >= emaCurrent * 0.75);
      const blDaylightOk = blReentry || (blZone && longDaylight  >= 1 && longDaylight  <= 3);
      const ssDaylightOk = ssReentry || (ssZone && shortDaylight >= 1 && shortDaylight <= 3);

      if (blPhase1 && blDaylightOk) {
        const entryPrice = parseFloat((twoWeekHigh + 0.01).toFixed(2));
        const initStop   = blInitStop(twoWeekLow, current.close, atrArr[wi]);
        events.push({ time: current.time, signal: 'BL', barLow: current.low, barHigh: current.high });
        position          = { type: 'BL', entryWi: wi, entryPrice, pnthrStop: initStop };
        longTrendActive   = true;
        longTrendCapped   = false;
        shortTrendActive  = false;
        shortTrendCapped  = false;
      } else if (ssPhase1 && ssDaylightOk) {
        const entryPrice = parseFloat((twoWeekLow - 0.01).toFixed(2));
        const initStop   = ssInitStop(twoWeekHigh, current.close, atrArr[wi]);
        events.push({ time: current.time, signal: 'SS', barLow: current.low, barHigh: current.high });
        position          = { type: 'SS', entryWi: wi, entryPrice, pnthrStop: initStop };
        shortTrendActive  = true;
        shortTrendCapped  = false;
        longTrendActive   = false;
        longTrendCapped   = false;
      }
    }
  }

  // Compute live stops and current signal from client data (always up-to-date)
  let pnthrStop = null, currentWeekStop = null, activeType = null;
  let currentSignal = events.length > 0 ? events[events.length - 1].signal : null;
  if (position) {
    const lastBar = weeklyData[weeklyData.length - 1];
    pnthrStop       = position.pnthrStop;
    activeType      = position.type;
    currentSignal   = position.type; // 'BL' or 'SS' (open position)
    currentWeekStop = position.type === 'BL'
      ? parseFloat((lastBar.low  - 0.01).toFixed(2))
      : parseFloat((lastBar.high + 0.01).toFixed(2));
  }

  return { events, pnthrStop, currentWeekStop, activeType, currentSignal };
}

// Count n trading days (Mon–Fri) before a date string, returning the start date string
function nTradingDaysBefore(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  let count = 0;
  while (count < n) {
    d.setDate(d.getDate() - 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return d.toISOString().split('T')[0];
}

function filterByRange(weeklyData, range) {
  if (range === 'all') return weeklyData;
  const months = range === '3m' ? 3 : 12;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  return weeklyData.filter(w => w.time >= cutoffStr);
}

function formatWeekDate(timeStr) {
  if (!timeStr) return '';
  const date = new Date(timeStr + 'T00:00:00');
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function ChartModal({ stocks, initialIndex, earnings = {}, onClose, onWatchlistChange }) {
  const { isInvestor } = useAuth() || {};
  const { isAuthenticated, queuedTickers, toggleQueue, nav: contextNav } = useQueue() || {};
  const { analyzeContext } = useAnalyzeContext() || {};
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [range, setRange] = useState('12m');
  const [allWeeklyData, setAllWeeklyData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hoveredBar, setHoveredBar] = useState(null);
  const [hoveredMarkerProfit, setHoveredMarkerProfit] = useState(null);
  const [pnthrStop, setPnthrStop] = useState(null);
  const [currentWeekStop, setCurrentWeekStop] = useState(null);
  const [currentSignal, setCurrentSignal] = useState(null);
  const [chartSignalAge, setChartSignalAge] = useState(null); // weeks since last BL/SS from chart
  const [signalMarkers, setSignalMarkers] = useState([]);
  const [pantherMarkerPos, setPantherMarkerPos] = useState(null);
  const [entryDatesLoaded, setEntryDatesLoaded] = useState(false);
  const [watchlistSet, setWatchlistSet] = useState(new Set());
  const [watchlistSaving, setWatchlistSaving] = useState(false);
  const [inEarningsWindow, setInEarningsWindow] = useState(false);
  const [killRankMap, setKillRankMap] = useState(_killRankMap); // start from cache if already loaded
  const [fetchedKillData, setFetchedKillData] = useState(null); // Kill score fetched when not on Kill page
  // ── SIZE IT / QUEUE IT state ─────────────────────────────────────────────────
  const [sizePanel, setSizePanel] = useState(null);
  const [sizeLoading, setSizeLoading] = useState(false);
  // ── ANALYZE panel state ──────────────────────────────────────────────────────
  const [analyzeOpen, setAnalyzeOpen] = useState(false);
  const analyzeResultRef = useRef(null);
  // ── Wash rule warning ────────────────────────────────────────────────────────
  const [washWarning, setWashWarning] = useState(null);
  const positionsCache = useRef(null);
  const navCache = useRef(null);
  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);
  const cacheRef = useRef({});
  const entryDatesRef = useRef({});

  const stock = stocks[currentIndex];
  const inWatchlist = stock ? watchlistSet.has(stock.ticker) : false;

  // Enrich stock with chart-detected signal AND chart-computed metrics so Analyze always has
  // correct data. Page data often lacks signal, ema21, rsi14, weekly OHLC, and volumeRatio.
  // All derived from allWeeklyData — already loaded to draw the chart, no extra API calls.
  const enrichedStock = useMemo(() => {
    if (!stock) return stock;
    const activeSignal = (currentSignal === 'BL' || currentSignal === 'SS') ? currentSignal : null;
    const base = {
      ...stock,
      // Chart-detected signal is authoritative. Falls back to page data if chart not loaded yet.
      signal: activeSignal || stock.signal || stock.pnthrSignal || null,
    };

    // PNTHR Stop from chart detection — this is the stop shown on every chart.
    // Must be in enrichedStock so Analyze can score Risk/Reward.
    if (pnthrStop != null) {
      base.pnthrStop = +pnthrStop;
      if (!base.stopPrice) base.stopPrice = +pnthrStop;
    }

    // Signal age from chart detection — weeks since last BL/SS event.
    // Ensures Freshness scoring works even when server signalAge is missing.
    if (chartSignalAge != null && base.signalAge == null && base.weeksSince == null) {
      base.signalAge = chartSignalAge;
    }

    const emaPeriod = getSectorEmaPeriod(stock?.sector);
    if (allWeeklyData.length >= emaPeriod + 1) {
      // Sector-specific EMA — same series drawn on chart; last two values give current value + slope
      const ema21Series = calculateEMA(allWeeklyData, emaPeriod);
      const lastEma = ema21Series.at(-1)?.value ?? null;
      const prevEma = ema21Series.at(-2)?.value ?? null;
      if (lastEma) {
        base.ema21 = lastEma;
        if (prevEma) base.emaSlope = parseFloat(((lastEma - prevEma) / prevEma * 100).toFixed(4));
      }

      // Most recent weekly bar → weekHigh/weekLow for conviction; weekly close if missing
      const lastBar = allWeeklyData.at(-1);
      if (lastBar) {
        base.weekHigh = lastBar.high;
        base.weekLow  = lastBar.low;
        if (!base.close) base.close = lastBar.close; // weekly close; currentPrice kept for EMA checks

        // Volume ratio: last week vs 10-week prior average
        const lastVol = lastBar.volume || 0;
        if (lastVol > 0 && allWeeklyData.length >= 11) {
          const priorVols = allWeeklyData.slice(-11, -1).map(d => d.volume || 0);
          const avgVol = priorVols.reduce((s, v) => s + v, 0) / priorVols.length;
          if (avgVol > 0) base.volumeRatio = parseFloat((lastVol / avgVol).toFixed(2));
        }
      }

      // RSI14 on weekly closes (Wilder smoothing)
      if (allWeeklyData.length >= 16) {
        const rsi = calculateRSI(allWeeklyData, 14);
        if (rsi !== null) base.rsi14 = rsi;
      }
    }

    // Merge Kill pipeline data when not available from the source page (e.g. Search)
    if (fetchedKillData && base.totalScore == null && base.killScore == null && base.apexScore == null) {
      base.totalScore       = fetchedKillData.totalScore       ?? fetchedKillData.apexScore ?? null;
      base.pipelineMaxScore = fetchedKillData.pipelineMaxScore ?? fetchedKillData.maxScore  ?? null;
      base.killRank         = fetchedKillData.killRank         ?? fetchedKillData.rank       ?? null;
      base.rankChange       = fetchedKillData.rankChange       ?? null;
      base.tier             = fetchedKillData.tier             ?? null;
      // scoreDetail contains { d1, d2, d3, d6, d7, d8 } — analyzeScore reads stock.scoreDetail.d3 etc.
      base.scoreDetail      = fetchedKillData.scoreDetail      ?? null;
      // Top-level fields also used by analyzeScore fallbacks
      base.weeklyRsi        = base.weeklyRsi   ?? fetchedKillData.weeklyRsi   ?? null;
      base.stopPrice        = base.stopPrice   ?? fetchedKillData.stopPrice   ?? null;
      base.confirmation     = base.confirmation ?? fetchedKillData.confirmation ?? null;
    }

    return base;
  }, [stock, currentSignal, allWeeklyData, fetchedKillData, pnthrStop, chartSignalAge]);

  // Reset SIZE IT + ANALYZE panels when navigating to a new stock
  useEffect(() => { setSizePanel(null); setAnalyzeOpen(false); analyzeResultRef.current = null; setFetchedKillData(null); setChartSignalAge(null); }, [currentIndex]);

  // Auto-resync SIZE IT direction to chart's currentSignal UNLESS the user
  // has explicitly toggled (userOverride flag). Discretion mode is respected;
  // default mode snaps to the chart signal. Override is cleared automatically
  // on ticker change via the panel reset effect above.
  useEffect(() => {
    if (!sizePanel || sizePanel.userOverride) return;
    const enforced = currentSignal === 'BL' ? 'LONG' : currentSignal === 'SS' ? 'SHORT' : null;
    if (!enforced || sizePanel.direction === enforced) return;
    setSizePanel(p => p ? { ...p, direction: enforced } : p);
  }, [currentSignal, sizePanel?.direction, sizePanel?.userOverride]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Fetch Kill score from cache when stock doesn't have it (e.g. opened from Search) ──
  useEffect(() => {
    const s = stocks[currentIndex];
    if (!s?.ticker) return;
    // Already has Kill data — no fetch needed
    if (s.totalScore != null || s.killScore != null || s.apexScore != null) return;
    let cancelled = false;
    fetch(`${API_BASE}/api/apex/ticker/${encodeURIComponent(s.ticker)}`, { headers: authHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (!cancelled && data?.found) setFetchedKillData(data.stock); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [currentIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Check wash rule whenever ticker changes (including Prev/Next navigation) ──
  useEffect(() => {
    const ticker = stocks[currentIndex]?.ticker;
    if (!ticker) { setWashWarning(null); return; }
    fetch(`${API_BASE}/api/wash-rules?ticker=${encodeURIComponent(ticker)}`, { headers: authHeaders() })
      .then(r => r.ok ? r.json() : [])
      .then(data => {
        const active    = data.find(w => !w.washSale?.triggered && (w.washSale?.daysRemaining ?? 0) > 0);
        const triggered = data.find(w =>  w.washSale?.triggered);
        setWashWarning(active || triggered || null);
      })
      .catch(() => setWashWarning(null));
  }, [currentIndex]);

  // Fetch data when stock changes
  useEffect(() => {
    if (!stock) return;
    const ticker = stock.ticker;
    if (cacheRef.current[ticker]) {
      setAllWeeklyData(cacheRef.current[ticker]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setAllWeeklyData([]);
    fetchChartData(ticker)
      .then(daily => {
        if (cancelled) return;
        const weekly = aggregateToWeekly(daily);
        cacheRef.current[ticker] = weekly;
        setAllWeeklyData(weekly);
        if (weekly.length === 0) setError('No chart data available for this ticker.');
      })
      .catch(err => {
        if (cancelled) return;
        console.error(err);
        setError('Failed to load chart data');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [currentIndex]);

  // Fetch entry dates for all stocks in this modal (batch, one-time on mount)
  useEffect(() => {
    const tickers = stocks.map(s => s.ticker);
    fetchEntryDates(tickers).then(data => {
      entryDatesRef.current = data;
      setEntryDatesLoaded(true);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Build/rebuild chart when data, range, or stop price changes
  useEffect(() => {
    if (loading || !chartContainerRef.current || allWeeklyData.length === 0) return;

    setHoveredBar(null);
    setSignalMarkers([]);
    setPantherMarkerPos(null);

    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }

    const filtered = filterByRange(allWeeklyData, range);
    if (filtered.length === 0) return;

    // Yellow background if today is within 14 calendar days of earnings (matches dashboard row highlight)
    const earningsDate = earnings[stock?.ticker] ?? null;
    const earningsWindow = (() => {
      if (!earningsDate) return false;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const [ey, em, ed] = earningsDate.split('-').map(Number);
      const eDate = new Date(ey, em - 1, ed);
      const daysAway = Math.round((eDate - today) / (1000 * 60 * 60 * 24));
      return daysAway >= 0 && daysAway <= 5;
    })();
    setInEarningsWindow(earningsWindow);
    const chartBg = earningsWindow ? '#fffde7' : '#ffffff';

    const chart = createChart(chartContainerRef.current, {
      autoSize: true,
      layout: { background: { color: chartBg }, textColor: '#212121', attributionLogo: false },
      grid: { vertLines: { color: '#f0f0f0' }, horzLines: { color: '#f0f0f0' } },
      rightPriceScale: { borderColor: '#d4d4d4' },
      timeScale: { borderColor: '#d4d4d4', timeVisible: false },
      crosshair: { mode: 1 },
    });
    chartRef.current = chart;

    const series = chart.addSeries(BarSeries, {
      upColor: '#16a34a',
      downColor: '#dc2626',
      priceLineVisible: false,
      lastValueVisible: false,
    });

    series.setData(filtered);

    const filteredTimes = new Set(filtered.map(d => d.time));

    let destroyed = false;

    // OHLC tooltip on crosshair hover
    chart.subscribeCrosshairMove(param => {
      if (destroyed) return;
      if (!param.time || !param.point || !param.seriesData?.get(series)) {
        setHoveredBar(null);
        return;
      }
      const data = param.seriesData.get(series);
      setHoveredBar({
        x: param.point.x,
        y: param.point.y,
        time: param.time,
        open: data.open,
        high: data.high,
        low: data.low,
        close: data.close,
      });
    });

    // Sector-specific EMA period for signal detection + chart drawing
    const emaPeriod = getSectorEmaPeriod(stock?.sector);

    // Compute signals and live stops from full history
    const { events: allDetected, pnthrStop: ps, currentWeekStop: cws, currentSignal: cs } = detectAllSignals(allWeeklyData, emaPeriod, isEtfTicker(stock?.ticker));

    // Compute signal age (weeks since last BL/SS event) from chart data
    if (cs === 'BL' || cs === 'SS') {
      const lastSigEvent = [...allDetected].reverse().find(e => e.signal === 'BL' || e.signal === 'SS');
      if (lastSigEvent?.time) {
        const sigDate = new Date(typeof lastSigEvent.time === 'number' ? lastSigEvent.time * 1000 : lastSigEvent.time);
        const now = new Date();
        const diffWeeks = Math.floor((now - sigDate) / (7 * 24 * 60 * 60 * 1000));
        setChartSignalAge(diffWeeks);
      }
    } else {
      setChartSignalAge(null);
    }

    // Prefer server-computed stop (from Kill pipeline / signalService) — single source of truth.
    // Fall back to client-computed only when server value is unavailable (e.g. Prey page, cold cache).
    const serverStop = stock?.pnthrStop ?? stock?.stopPrice ?? null;
    const resolvedStop = serverStop != null ? serverStop : ps;
    setPnthrStop(resolvedStop);
    setCurrentWeekStop(cws);
    setCurrentSignal(cs);
    const lastEntryIdx = (() => { for (let i = allDetected.length - 1; i >= 0; i--) { if (allDetected[i].signal === 'BL' || allDetected[i].signal === 'SS') return i; } return -1; })();
    const lastEntry  = lastEntryIdx >= 0 ? allDetected[lastEntryIdx] : null;
    const exitEvent  = lastEntry ? allDetected.slice(lastEntryIdx + 1).find(e => e.signal === 'BE' || e.signal === 'SE') : null;
    const allSignalEvents = [lastEntry, exitEvent].filter(e => e && filteredTimes.has(e.time));
    if (allSignalEvents.length > 0) {
      const BADGE_H = 22;
      const updateAllMarkers = () => {
        if (destroyed) return;
        try {
          const positions = [];
          for (const ev of allSignalEvents) {
            const x = chart.timeScale().timeToCoordinate(ev.time);
            // BL, SE → below bar; SS, BE → above bar
            const belowBar = ev.signal === 'BL' || ev.signal === 'SE';
            const price = belowBar ? ev.barLow * 0.98 : ev.barHigh * 1.02;
            const y = series.priceToCoordinate(price);
            if (x != null && y != null) {
              positions.push({
                signal: ev.signal,
                left: Math.round(x),
                top: belowBar ? Math.round(y) : Math.round(y) - BADGE_H,
                profitDollar: ev.profitDollar ?? null,
                profitPct:    ev.profitPct    ?? null,
              });
            }
          }
          setSignalMarkers(positions);
        } catch { /* chart destroyed mid-callback */ }
      };
      chart.timeScale().subscribeVisibleTimeRangeChange(updateAllMarkers);
      setTimeout(updateAllMarkers, 50);
    }

    // Panther head — float icon at the date the stock first appeared in the long or short top-100 list
    const entryInfo = entryDatesRef.current[stock?.ticker];
    if (entryInfo?.date) {
      const entryDate = new Date(entryInfo.date + 'T00:00:00');
      const dow = entryDate.getDay();
      const monday = new Date(entryDate);
      monday.setDate(entryDate.getDate() - (dow === 0 ? 6 : dow - 1));
      const weekKey = monday.toISOString().split('T')[0];
      if (filteredTimes.has(weekKey)) {
        const barData = filtered.find(d => d.time === weekKey);
        if (barData) {
          const ICON = 24;
          const isLong = entryInfo.list === 'LONG';
          const updatePantherPos = () => {
            if (destroyed) return;
            try {
              const x = chart.timeScale().timeToCoordinate(weekKey);
              const price = isLong ? barData.low : barData.high;
              const y = series.priceToCoordinate(price);
              if (x != null && y != null) {
                setPantherMarkerPos({
                  left: Math.round(x) - ICON / 2,
                  top: isLong ? Math.round(y) + 28 : Math.round(y) - ICON - 28,
                  list: entryInfo.list,
                });
              }
            } catch { /* chart destroyed mid-callback */ }
          };
          chart.timeScale().subscribeVisibleTimeRangeChange(updatePantherPos);
          setTimeout(updatePantherPos, 50);
        }
      }
    }

    // Sector-specific EMA — calculated on full history for accuracy
    const ema21Full = calculateEMA(allWeeklyData, emaPeriod);
    if (ema21Full.length > 0) {
      const ema21 = ema21Full.filter(d => filteredTimes.has(d.time));
      if (ema21.length > 0) {
        const emaSeries = chart.addSeries(LineSeries, {
          color: '#2563eb',
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        emaSeries.setData(ema21);
      }
    }

    // Draw stop lines only across the last 3 bars (not full chart width)
    const last3 = filtered.slice(-3);
    if (resolvedStop != null && last3.length > 0) {
      const pnthrLineSeries = chart.addSeries(LineSeries, {
        color: '#ca8a04',
        lineWidth: 2,
        lineStyle: 2, // dashed
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      pnthrLineSeries.setData(last3.map(b => ({ time: b.time, value: resolvedStop })));
    }
    if (cws != null && last3.length > 0) {
      const cwsLineSeries = chart.addSeries(LineSeries, {
        color: '#9333ea',
        lineWidth: 1,
        lineStyle: 3, // dotted
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      cwsLineSeries.setData(last3.map(b => ({ time: b.time, value: cws })));
    }

    chart.timeScale().fitContent();

    return () => {
      destroyed = true;
      setHoveredBar(null);
      setSignalMarkers([]);
      setPantherMarkerPos(null);
      setPnthrStop(null);
      setCurrentWeekStop(null);
      setCurrentSignal(null);
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
    };
  }, [allWeeklyData, range, loading, entryDatesLoaded, earnings]);

  // Load watchlist + kill ranks on mount
  useEffect(() => {
    fetchWatchlist().then(data => setWatchlistSet(new Set(data.map(s => s.ticker)))).catch(() => {});
    if (!_killRankMap) {
      loadKillRanks().then(map => setKillRankMap(map));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggleWatchlist() {
    const ticker = stock.ticker;
    const inList = watchlistSet.has(ticker);
    setWatchlistSaving(true);
    try {
      if (inList) {
        await removeWatchlistTicker(ticker);
        setWatchlistSet(prev => { const next = new Set(prev); next.delete(ticker); return next; });
        onWatchlistChange?.(ticker, false);
      } else {
        await addWatchlistTicker(ticker);
        setWatchlistSet(prev => new Set([...prev, ticker]));
        onWatchlistChange?.(ticker, true);
      }
    } catch (err) {
      console.error('Watchlist toggle error:', err);
    } finally {
      setWatchlistSaving(false);
    }
  }

  // Keyboard navigation
  useEffect(() => {
    function handleKey(e) {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') setCurrentIndex(i => Math.max(0, i - 1));
      if (e.key === 'ArrowRight') setCurrentIndex(i => Math.min(stocks.length - 1, i + 1));
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [stocks.length, onClose]);

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) onClose();
  }

  // ── SIZE IT: fetch gap data + nav + positions → calculate lot 1 sizing ────
  async function handleSizeIt() {
    if (sizeLoading || !stock) return;
    setSizeLoading(true);
    setSizePanel(null);
    try {
      // Nav: prefer context (loaded on mount by QueueProvider), fall back to local fetch
      let nav = contextNav;
      if (!nav) {
        if (!navCache.current) {
          const navData = await fetchNav();
          navCache.current = navData.nav || 100000;
        }
        nav = navCache.current;
      }

      // Fetch gap risk + fresh price from ticker endpoint
      const tickerRes = await fetch(`${API_BASE}/api/ticker/${stock.ticker}`, { headers: authHeaders() });
      const tickerData = tickerRes.ok ? await tickerRes.json() : {};
      const maxGapPct  = tickerData.maxGapPct || 0;
      const entryPrice = tickerData.currentPrice || stock.currentPrice || 0;

      // ETF tier detection: hardcoded list OR FMP profile flag
      const isETF = isEtfTicker(stock.ticker, tickerData.isEtf);

      // ── Direction: SINGLE SOURCE OF TRUTH ─────────────────────────────────
      // The chart's currentSignal (from detectAllSignals) IS what's drawn on the
      // chart and shown as the green BL / red SS badge. SIZE IT must use the
      // same state — otherwise the direction can silently desync from the signal
      // the user is actually looking at.
      //
      // Priority: chart currentSignal → raw stock.signal → server suggestion → EMA fallback.
      let direction = 'LONG';
      let dirSource = 'FALLBACK';

      // P1: chart's state-machine currentSignal (authoritative — matches badge)
      if (currentSignal === 'BL') { direction = 'LONG';  dirSource = 'CHART_SIGNAL_BL'; }
      else if (currentSignal === 'SS') { direction = 'SHORT'; dirSource = 'CHART_SIGNAL_SS'; }
      // P2: raw prop signal (e.g. order row passes signal='BL')
      else {
        const sigRaw = stock.signal || stock.signalType || stock.pnthrSignal || stock.type || '';
        const sigUp  = sigRaw.toUpperCase();
        if (sigUp === 'BL') { direction = 'LONG';  dirSource = 'PROP_SIGNAL_BL'; }
        else if (sigUp === 'SS') { direction = 'SHORT'; dirSource = 'PROP_SIGNAL_SS'; }
        // P3: server suggestion (Kill cache or EMA-derived)
        else if (tickerData.suggestedDirection) {
          direction = tickerData.suggestedDirection;
          dirSource = 'SERVER_SUGGESTED';
        }
        // P4: EMA fallback
        else if (tickerData.ema21 && tickerData.ema21 > 0 && entryPrice) {
          direction = entryPrice < tickerData.ema21 ? 'SHORT' : 'LONG';
          dirSource = 'TICKER_EMA21';
        } else if (stock.ema && stock.ema > 0 && entryPrice) {
          direction = entryPrice < stock.ema ? 'SHORT' : 'LONG';
          dirSource = 'STOCK_EMA';
        }
      }

      console.log('[SIZE IT] Direction:', {
        ticker: stock.ticker, currentSignal, propSignal: stock.signal,
        suggestedDirection: tickerData.suggestedDirection, method: dirSource, direction,
      });
      // Stop default: PNTHR Stop from chart (ATR-based) > server stopPrice > EMA ±2%
      const chartStop   = pnthrStop ? +pnthrStop : null;
      const stopDefault = chartStop
        ? chartStop
        : stock.stopPrice
          ? +stock.stopPrice
          : direction === 'SHORT'
            ? +(entryPrice * 1.02).toFixed(2)
            : +(entryPrice * 0.98).toFixed(2);
      console.log('[SIZE IT] Stop:', { pnthrStop, chartStop, stockStopPrice: stock.stopPrice, stopDefault });

      // Sizing — ETF uses 0.5% vitality, stocks use 1%
      const sizing     = sizePosition({ netLiquidity: nav, entryPrice, stopPrice: stopDefault, maxGapPct, direction, isETF });
      const lot1Shr    = Math.max(1, Math.round(sizing.totalShares * STRIKE_PCT[0]));
      const riskDollar = lot1Shr * Math.abs(entryPrice - stopDefault);

      // Heat impact (fetch positions once and cache)
      if (!positionsCache.current) {
        const posRes = await fetch(`${API_BASE}/api/positions`, { headers: authHeaders() });
        const posData = posRes.ok ? await posRes.json() : {};
        positionsCache.current = posData.positions || [];
      }
      const heat = calcHeat(positionsCache.current, nav);

      setSizePanel({
        nav, entry: entryPrice, stop: stopDefault, adjustedStop: stopDefault,
        chartPnthrStop: chartStop,   // original chart PNTHR stop — used by direction toggle
        gapPct: maxGapPct, gapMult: sizing.gapMult,
        totalShares: sizing.totalShares, lot1Shares: lot1Shr,
        risk$: +riskDollar.toFixed(0), direction, isETF,
        vitality: sizing.vitality, vitalityPct: sizing.vitalityPct,
        stockRisk: heat.stockRisk, etfRisk: heat.etfRisk,
        stockRiskPct: heat.stockRiskPct, etfRiskPct: heat.etfRiskPct,
        heatBefore: heat.liveCnt, // legacy
        dirSource,  // debug: which detection method fired
      });
    } catch { /* non-fatal — panel stays null */ }
    setSizeLoading(false);
  }

  function recalcWithStop(newStopStr) {
    const newStop = parseFloat(newStopStr);
    if (!sizePanel || !newStop || newStop <= 0) return;
    const sizing   = sizePosition({ netLiquidity: sizePanel.nav, entryPrice: sizePanel.entry, stopPrice: newStop, maxGapPct: sizePanel.gapPct, direction: sizePanel.direction, isETF: sizePanel.isETF });
    const lot1Shr  = Math.max(1, Math.round(sizing.totalShares * STRIKE_PCT[0]));
    const risk     = lot1Shr * Math.abs(sizePanel.entry - newStop);
    setSizePanel(prev => ({ ...prev, adjustedStop: newStop, totalShares: sizing.totalShares, lot1Shares: lot1Shr, risk$: +risk.toFixed(0), gapMult: sizing.gapMult, vitality: sizing.vitality }));
  }

  function handleQueueToggle() {
    if (!toggleQueue || !sizePanel) return;
    const isQueued = queuedTickers?.has(stock.ticker);
    if (isQueued) {
      toggleQueue({ ticker: stock.ticker, _remove: true });
    } else {
      toggleQueue({
        id:               Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        ticker:           stock.ticker,
        signal:           stock.signal,
        direction:        sizePanel.direction,
        currentPrice:     sizePanel.entry,
        suggestedStop:    sizePanel.stop,
        adjustedStop:     sizePanel.adjustedStop,
        gapPct:           sizePanel.gapPct,
        gapMultiplier:    sizePanel.gapMult,
        totalTargetShares: sizePanel.totalShares,
        lot1Shares:       sizePanel.lot1Shares,
        riskPerPosition:  sizePanel.risk$,
        killScore:        stock.totalScore ?? stock.apexScore ?? stock.killScore ?? null,
        killTier:         stock.tier ?? null,
        isETF:            sizePanel.isETF || false,
        sector:           sizePanel.isETF ? 'ETF' : (stock.sector || '—'),
        companyName:      stock.companyName || '',
        exchange:         stock.exchange || '',
        signalAge:        stock.signalAge ?? stock.weeksSince ?? null,
        killRank:         stock.killRank ?? stock.rank ?? null,
        analyzeScore:     analyzeResultRef.current
          ? { ...analyzeResultRef.current, computedAt: new Date().toISOString() }
          : null,
        queuedAt:         Date.now(),
      });
    }
  }

  if (!stock) return null;

  return (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div className={styles.modal}>

        {/* Header */}
        <div className={styles.header}>
          <div className={styles.stockInfo}>
            <div className={styles.tickerRow}>
              <span className={styles.ticker}>{stock.ticker}</span>
              <span className={styles.company}>{stock.companyName}</span>
            </div>
            <div className={styles.badges}>
              {stock.sector && <span className={styles.badge}>{stock.sector}</span>}
              {stock.exchange && <span className={styles.badge}>{stock.exchange}</span>}
            </div>
          </div>
          <div className={styles.headerActions}>
            {/* ── Wash Rule Warning Badge (hidden for investors) ── */}
            {!isInvestor && washWarning && (() => {
              const ws = washWarning.washSale;
              if (ws?.triggered) {
                return (
                  <span className={styles.washBadgeTriggered} title={`Wash sale triggered — the prior loss on ${washWarning.ticker} is disallowed for tax purposes`}>
                    ⚠ WASH TRIGGERED
                  </span>
                );
              }
              const days    = ws?.daysRemaining ?? 0;
              const urgent  = days <= 7;
              const loss    = ws?.lossAmount != null ? ` · -$${Math.abs(ws.lossAmount).toFixed(2)} loss` : '';
              return (
                <span
                  className={urgent ? styles.washBadgeUrgent : styles.washBadge}
                  title={`Wash sale window active${loss}. Re-entering before ${ws?.expiryDate ? new Date(ws.expiryDate).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—'} will disallow the prior loss for tax purposes.`}
                >
                  ⚠ WASH RULE — {days}d
                </span>
              );
            })()}
            {isAuthenticated && (
              <>
                {/* ── ANALYZE button ── */}
                {analyzeContext && (() => {
                  const isETFStock = enrichedStock?.isETF || enrichedStock?.type === 'etf'
                    || isEtfTicker(enrichedStock?.ticker) || isClassifiedETF(enrichedStock?.ticker);
                  const ar = isETFStock
                    ? computeETFAnalyzeScore(enrichedStock, analyzeContext)
                    : computeAnalyzeScore(enrichedStock, analyzeContext);
                  if (!ar) return null;
                  const hasWarnings = ar.warnings.length > 0;
                  return (
                    <button
                      onClick={() => {
                        analyzeResultRef.current = ar;
                        setAnalyzeOpen(prev => !prev);
                        setSizePanel(null); // close SIZE IT if open
                      }}
                      title={hasWarnings ? ar.warnings[0] : `Pre-trade score: ${ar.score}/${ar.max}`}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 5,
                        padding: '5px 12px',
                        backgroundColor: analyzeOpen ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.3)',
                        border: `1.5px solid ${ar.color}`,
                        borderRadius: 5, color: ar.color, fontSize: 11, fontWeight: 800,
                        cursor: 'pointer', fontFamily: 'monospace', letterSpacing: '0.04em',
                      }}
                    >
                      ANALYZE
                      <span style={{ backgroundColor: ar.color, color: '#000', padding: '1px 5px', borderRadius: 3, fontSize: 11, fontWeight: 800 }}>
                        {ar.pct}
                      </span>
                      {hasWarnings && <span style={{ fontSize: 10 }}>⚠</span>}
                    </button>
                  );
                })()}
                <button
                  onClick={handleSizeIt}
                  disabled={sizeLoading}
                  style={{ background: sizeLoading ? 'rgba(255,215,0,0.3)' : '#FFD700',
                    color: '#000', border: 'none', borderRadius: 5, padding: '5px 12px',
                    fontSize: 11, fontWeight: 800, cursor: sizeLoading ? 'not-allowed' : 'pointer',
                    letterSpacing: '0.06em' }}
                  title="Size this position"
                >
                  {sizeLoading ? '⟳' : 'SIZE IT'}
                </button>
                {sizePanel && !isInvestor && (
                  <button
                    onClick={handleQueueToggle}
                    style={{ background: queuedTickers?.has(stock.ticker) ? '#28a745' : 'rgba(40,167,69,0.15)',
                      color: queuedTickers?.has(stock.ticker) ? '#fff' : '#28a745',
                      border: `1px solid ${queuedTickers?.has(stock.ticker) ? '#28a745' : 'rgba(40,167,69,0.4)'}`,
                      borderRadius: 5, padding: '5px 12px', fontSize: 11, fontWeight: 700,
                      cursor: 'pointer', letterSpacing: '0.04em' }}
                    title={queuedTickers?.has(stock.ticker) ? 'Remove from queue' : 'Add to entry queue'}
                  >
                    {queuedTickers?.has(stock.ticker) ? 'QUEUED ✓' : 'QUEUE IT'}
                  </button>
                )}
              </>
            )}
            <button
              className={`${styles.watchlistBtn} ${inWatchlist ? styles.watchlistBtnActive : ''}`}
              onClick={toggleWatchlist}
              disabled={watchlistSaving}
              title={inWatchlist ? `Remove ${stock.ticker} from watchlist` : `Add ${stock.ticker} to watchlist`}
            >
              {inWatchlist ? '★' : '☆'}
            </button>
            <button className={styles.closeBtn} onClick={onClose} title="Close">×</button>
          </div>
        </div>

        {/* ANALYZE panel — expands on click, closes when SIZE IT opens */}
        {isAuthenticated && analyzeOpen && analyzeResultRef.current && (() => {
          const ar = analyzeResultRef.current;
          function ScoreLine({ label, comp, max: lineMax }) {
            const s = comp?.score ?? 0;
            const lbl = comp?.label ?? '—';
            // Direction-only row (max=0): ETF Trend shows LONG/SHORT with no score fraction
            if (!lineMax) {
              const dirColor = lbl === 'LONG' ? '#28a745' : lbl === 'SHORT' ? '#dc3545' : '#888';
              return (
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 12 }}>
                  <span style={{ color: '#888' }}>{label}</span>
                  <span style={{ display: 'flex', gap: 8 }}>
                    <span style={{ color: '#555' }}>—</span>
                    <span style={{ color: dirColor, fontWeight: 600, minWidth: 80, textAlign: 'right' }}>{lbl}</span>
                  </span>
                </div>
              );
            }
            const lineColor = s >= lineMax * 0.7 ? '#28a745' : s > 0 ? '#FFD700' : '#dc3545';
            return (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 12 }}>
                <span style={{ color: '#888' }}>{label}</span>
                <span style={{ display: 'flex', gap: 8 }}>
                  <span style={{ color: '#aaa' }}>{s}/{lineMax}</span>
                  <span style={{ color: lineColor, fontWeight: 600, minWidth: 80, textAlign: 'right' }}>{lbl}</span>
                </span>
              </div>
            );
          }
          return (
            <div style={{ backgroundColor: '#111', borderBottom: `2px solid ${ar.color}`, padding: '16px 20px' }}>
              {/* Header row */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ color: '#FFD700', fontSize: 14, fontWeight: 700 }}>PRE-TRADE ANALYSIS — {stock.ticker}</span>
                  <span style={{ backgroundColor: ar.color, color: '#000', padding: '3px 10px', borderRadius: 5, fontSize: 13, fontWeight: 800 }}>{ar.pct}%</span>
                </div>
                <span style={{ color: '#888', fontSize: 11 }}>{ar.score}/{ar.max} pts</span>
              </div>
              {/* Two-column layout */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                <div>
                  {ar.isETF ? (
                    <>
                      <div style={{ color: '#D4A017', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', marginBottom: 6 }}>
                        {`ETF SELECTION${ar.assetClass ? ` [${ar.assetClass}]` : ''}`}
                      </div>
                      <ScoreLine label="Signal Quality"    comp={ar.components.signalQuality}   max={15} />
                      <ScoreLine label="ETF Trend"         comp={ar.components.trendAlignment}  max={0}  />
                      <ScoreLine label="EMA Slope"         comp={ar.components.emaSlope}        max={10} />
                      <ScoreLine label="Macro Alignment"   comp={ar.components.macroAlignment}  max={8}  />
                      <ScoreLine label="Momentum Quality"  comp={ar.components.momentumQuality} max={7}  />
                      <div style={{ color: '#D4A017', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', marginTop: 10, marginBottom: 6 }}>EXECUTION (PROJECTED)</div>
                      <ScoreLine label="Position Sizing"   comp={ar.components.sizing}          max={8}  />
                      <ScoreLine label="Risk Cap"          comp={ar.components.riskCap}         max={5}  />
                    </>
                  ) : (
                    <>
                      <div style={{ color: '#D4A017', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', marginBottom: 6 }}>
                        SETUP QUALITY {ar.tiers?.t1 ? `(${ar.tiers.t1.score}/${ar.tiers.t1.max})` : ''}
                      </div>
                      <ScoreLine label="Signal Quality"  comp={ar.components.signalQuality} max={15} />
                      <ScoreLine label="Kill Context"    comp={ar.components.killContext}    max={10} />
                      <ScoreLine label="Index Trend"     comp={ar.components.indexTrend}     max={8}  />
                      <ScoreLine label="Sector Trend"    comp={ar.components.sectorTrend}    max={7}  />
                      <div style={{ color: '#D4A017', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', marginTop: 10, marginBottom: 6 }}>
                        RISK PROFILE {ar.tiers?.t2 ? `(${ar.tiers.t2.score}/${ar.tiers.t2.max})` : ''}
                      </div>
                      <ScoreLine label="Freshness"       comp={ar.components.freshness}      max={12} />
                      <ScoreLine label="Risk / Reward"   comp={ar.components.riskReward}     max={8}  />
                      <ScoreLine label="Prey Presence"   comp={ar.components.preyPresence}   max={8}  />
                      <ScoreLine label="Conviction"      comp={ar.components.conviction}     max={7}  />
                      <div style={{ color: '#D4A017', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', marginTop: 10, marginBottom: 6 }}>
                        ENTRY CONDITIONS {ar.tiers?.t3 ? `(${ar.tiers.t3.score}/${ar.tiers.t3.max})` : ''}
                      </div>
                      <ScoreLine label="Slope Strength"      comp={ar.components.slopeStrength}      max={5} />
                      <ScoreLine label="Sector Concentration" comp={ar.components.sectorConcentration} max={5} />
                      {!isInvestor && <ScoreLine label="Wash Compliance"     comp={ar.components.washCompliance}     max={5} />}
                      <ScoreLine label="Volatility Context"  comp={ar.components.volatilityContext}  max={5} />
                      <ScoreLine label="Portfolio Fit"       comp={ar.components.portfolioFit}       max={5} />
                    </>
                  )}
                </div>
                <div>
                  {ar.warnings.length > 0 ? (
                    <>
                      <div style={{ color: '#dc3545', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', marginBottom: 6 }}>WARNINGS</div>
                      {ar.warnings.map((w, i) => (
                        <div key={i} style={{ fontSize: 11, color: '#ccc', padding: '3px 0 3px 8px', borderLeft: '2px solid #dc3545', marginBottom: 4 }}>{w}</div>
                      ))}
                    </>
                  ) : (
                    <div style={{ fontSize: 12, color: '#28a745', padding: 12, backgroundColor: 'rgba(40,167,69,0.08)', borderRadius: 6, textAlign: 'center' }}>
                      No warnings. Strong candidate for entry.
                    </div>
                  )}
                  {ar.components.sectorExposure?.level !== 'CLEAR' && (
                    <div style={{ marginTop: 10, padding: '8px 12px',
                      backgroundColor: ar.components.sectorExposure.level === 'CRITICAL' ? 'rgba(220,53,69,0.08)' : 'rgba(255,215,0,0.08)',
                      border: `1px solid ${ar.components.sectorExposure.level === 'CRITICAL' ? 'rgba(220,53,69,0.25)' : 'rgba(255,215,0,0.25)'}`,
                      borderRadius: 6, fontSize: 11, color: '#ccc' }}>
                      {stock.sector} goes to net {ar.components.sectorExposure.netAfter} ({ar.components.sectorExposure.currentLongs}L/{ar.components.sectorExposure.currentShorts}S → +1)
                    </div>
                  )}
                </div>
              </div>
              {/* Action buttons */}
              {(() => {
                const errorFields = Object.entries(ar.components || {})
                  .filter(([, c]) => c?.label === 'ERROR');
                const hasErrors = errorFields.length > 0;
                return (
                  <div style={{ marginTop: 14 }}>
                    {hasErrors && (
                      <div style={{ padding: '10px 14px', backgroundColor: 'rgba(220,53,69,0.08)', border: '1px solid rgba(220,53,69,0.4)', borderRadius: 6, color: '#dc3545', fontSize: 11, marginBottom: 10 }}>
                        <div style={{ fontWeight: 700, marginBottom: 4 }}>⚠ Cannot proceed — data pipeline failure:</div>
                        {errorFields.map(([key, c]) => (
                          <div key={key} style={{ paddingLeft: 10, marginTop: 2, color: '#ff6b7a' }}>• {c.detail}</div>
                        ))}
                        <div style={{ marginTop: 6, color: '#888', fontSize: 10 }}>Try refreshing the page. If the error persists, the data pipeline needs attention.</div>
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                      <button
                        onClick={hasErrors ? undefined : () => { setAnalyzeOpen(false); handleSizeIt(); }}
                        disabled={hasErrors}
                        style={{ padding: '7px 18px', backgroundColor: hasErrors ? 'rgba(60,60,60,0.5)' : 'rgba(212,160,23,0.15)', border: `1.5px solid ${hasErrors ? '#555' : '#D4A017'}`, color: hasErrors ? '#555' : '#FFD700', borderRadius: 5, fontWeight: 700, fontSize: 12, cursor: hasErrors ? 'not-allowed' : 'pointer' }}
                      >
                        SIZE IT →
                      </button>
                      <button
                        onClick={() => setAnalyzeOpen(false)}
                        style={{ padding: '7px 18px', backgroundColor: 'transparent', border: '1px solid #444', color: '#888', borderRadius: 5, fontSize: 12, cursor: 'pointer' }}
                      >
                        CLOSE
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
          );
        })()}

        {/* SIZE IT panel — two-row data card */}
        {isAuthenticated && sizePanel && (() => {
          const vitality      = sizePanel.vitality ?? +(sizePanel.nav * (sizePanel.isETF ? 0.005 : 0.01)).toFixed(0);
          const riskOverVit   = sizePanel.risk$ > vitality;
          const chartSigDir   = currentSignal === 'BL' ? 'LONG' : currentSignal === 'SS' ? 'SHORT' : null;
          const discretionOn  = chartSigDir != null && sizePanel.direction !== chartSigDir;
          const dirColor      = discretionOn ? '#f59e0b'
                               : sizePanel.direction === 'SHORT' ? '#ff6b6b'
                               : '#28a745';
          const dirLabel      = sizePanel.direction === 'SHORT' ? 'SHORT' : 'LONG';
          const tier          = sizePanel.isETF ? 'ETF' : 'STOCK';
          const tierColor     = sizePanel.isETF ? '#6ea8fe' : '#FFD700';
          const stockCap = 10, etfCap = 5, totalCap = 15;
          const projStockPct  = sizePanel.isETF ? sizePanel.stockRiskPct : +(sizePanel.stockRiskPct + (sizePanel.risk$ / sizePanel.nav * 100)).toFixed(2);
          const projEtfPct    = sizePanel.isETF ? +(sizePanel.etfRiskPct + (sizePanel.risk$ / sizePanel.nav * 100)).toFixed(2) : sizePanel.etfRiskPct;
          const projTotalPct  = +(projStockPct + projEtfPct).toFixed(2);
          const overStockCap  = projStockPct > stockCap;
          const overEtfCap    = projEtfPct > etfCap;
          const overTotalCap  = projTotalPct > totalCap;
          const overCap       = overStockCap || overEtfCap || overTotalCap;
          // legacy for heat display
          const heatAfter     = sizePanel.heatBefore + 1;
          return (
            <div style={{
              background: '#0e0e0e',
              borderTop: '2px solid #FFD700',
              borderBottom: '1px solid rgba(255,215,0,0.12)',
              padding: '14px 24px',
              minHeight: 80,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}>
              {/* Discretion banner — only renders when user has flipped direction away from chart signal */}
              {discretionOn && (
                <div style={{
                  background: 'rgba(245,158,11,0.12)',
                  border: '1px solid rgba(245,158,11,0.5)',
                  borderRadius: 4,
                  padding: '6px 10px',
                  fontSize: 11,
                  fontWeight: 700,
                  color: '#f59e0b',
                  fontFamily: 'monospace',
                  letterSpacing: '0.03em',
                }}>
                  ⚠ DISCRETION — chart signal is {currentSignal} ({chartSigDir}); sizing as {dirLabel}.
                  Stop recalculated via {dirLabel === 'LONG' ? 'blInitStop' : 'ssInitStop'} formula.
                </div>
              )}
              {/* Row 1: ticker · direction toggle | lot 1 shares · total target */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 18, fontWeight: 900, color: '#FFD700', fontFamily: 'monospace', letterSpacing: '0.04em' }}>
                    {stock.ticker}
                  </span>
                  <button
                    onClick={() => setSizePanel(p => {
                      const newDir = p.direction === 'LONG' ? 'SHORT' : 'LONG';

                      let newStop;
                      if (allWeeklyData.length >= 4) {
                        const atrArr      = computeWilderATR(allWeeklyData);
                        const lastIdx     = allWeeklyData.length - 1;
                        const prev1       = allWeeklyData[lastIdx - 1];
                        const prev2       = allWeeklyData[lastIdx - 2];
                        const current     = allWeeklyData[lastIdx];
                        const atr         = atrArr[lastIdx] ?? atrArr[lastIdx - 1] ?? null;
                        const twoWeekLow  = Math.min(prev1.low,  prev2.low);
                        const twoWeekHigh = Math.max(prev1.high, prev2.high);
                        newStop = newDir === 'LONG'
                          ? blInitStop(twoWeekLow,  current.close, atr)
                          : ssInitStop(twoWeekHigh, current.close, atr);
                      } else if (p.chartPnthrStop) {
                        newStop = p.chartPnthrStop;
                      } else {
                        newStop = newDir === 'SHORT' ? +(p.entry * 1.02).toFixed(2) : +(p.entry * 0.98).toFixed(2);
                      }

                      const sizing = sizePosition({ netLiquidity: p.nav, entryPrice: p.entry, stopPrice: newStop, maxGapPct: p.gapPct, direction: newDir, isETF: p.isETF });
                      const lot1   = Math.max(1, Math.round(sizing.totalShares * 0.35));
                      return {
                        ...p,
                        direction:    newDir,
                        adjustedStop: newStop,
                        stop:         newStop,
                        totalShares:  sizing.totalShares,
                        lot1Shares:   lot1,
                        vitality:     sizing.vitality,
                        risk$:        +(lot1 * Math.abs(p.entry - newStop)).toFixed(0),
                        userOverride: true,   // user exercised discretion — don't auto-resync on this ticker
                      };
                    })}
                    title={discretionOn
                      ? `DISCRETION — chart signal is ${currentSignal}; sizing as ${dirLabel}. Click to flip back.`
                      : 'Click to flip LONG ↔ SHORT (enters discretion mode)'}
                    style={{ background: discretionOn ? 'rgba(245,158,11,0.18)'
                            : sizePanel.direction === 'SHORT' ? 'rgba(220,53,69,0.15)'
                            : 'rgba(40,167,69,0.15)',
                      border: `1.5px solid ${dirColor}`, color: dirColor,
                      borderRadius: 5, padding: '3px 10px', fontSize: 12, fontWeight: 800,
                      cursor: 'pointer',
                      fontFamily: 'monospace', letterSpacing: '0.05em' }}>
                    {dirLabel} {discretionOn ? '⚠' : '⇄'}
                  </button>
                  <span style={{ fontSize: 11, color: tierColor, fontWeight: 700, border: `1px solid ${tierColor}`, borderRadius: 3, padding: '2px 7px', opacity: 0.85 }}>
                    {tier}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 28, alignItems: 'baseline' }}>
                  <div>
                    <span style={{ fontSize: 11, color: '#666', textTransform: 'uppercase', letterSpacing: '0.06em' }}>LOT 1</span>
                    <span style={{ fontSize: 16, fontWeight: 800, color: '#e8e6e3', fontFamily: 'monospace', marginLeft: 8 }}>
                      {sizePanel.lot1Shares} shr
                    </span>
                    <span style={{ fontSize: 13, color: '#888', fontFamily: 'monospace', marginLeft: 6 }}>
                      @ ${sizePanel.entry?.toFixed(2)}
                    </span>
                  </div>
                  <div>
                    <span style={{ fontSize: 11, color: '#666', textTransform: 'uppercase', letterSpacing: '0.06em' }}>TARGET</span>
                    <span style={{ fontSize: 16, fontWeight: 800, color: '#aaa', fontFamily: 'monospace', marginLeft: 8 }}>
                      {sizePanel.totalShares} shr
                    </span>
                  </div>
                </div>
              </div>

              {/* Row 2: stop input · risk · gap · heat · nav · vitality */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>

                {/* Stop — prominent editable field */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Stop</span>
                  <input
                    key={sizePanel.adjustedStop}
                    type="number" step="0.01"
                    defaultValue={sizePanel.adjustedStop}
                    onBlur={e => recalcWithStop(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { recalcWithStop(e.target.value); e.target.blur(); } }}
                    style={{
                      background: 'rgba(255,255,255,0.05)',
                      border: '1.5px solid #FFD700',
                      borderRadius: 6,
                      padding: '5px 10px',
                      color: '#dc3545',
                      fontSize: 15,
                      fontFamily: 'monospace',
                      fontWeight: 700,
                      outline: 'none',
                      textAlign: 'right',
                      width: 110,
                    }}
                  />
                </div>

                {/* Divider */}
                <span style={{ color: 'rgba(255,255,255,0.08)', fontSize: 18 }}>|</span>

                {/* Risk */}
                <div>
                  <span style={{ fontSize: 12, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Risk </span>
                  <span style={{ fontSize: 14, fontWeight: 800, fontFamily: 'monospace',
                    color: riskOverVit ? '#dc3545' : '#ffc107' }}>
                    ${sizePanel.risk$}
                  </span>
                  {riskOverVit && (
                    <span style={{ fontSize: 10, color: '#dc3545', marginLeft: 5 }}>⚠ &gt;VITALITY</span>
                  )}
                </div>

                {/* Gap */}
                <div>
                  <span style={{ fontSize: 12, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Gap </span>
                  <span style={{ fontSize: 14, fontFamily: 'monospace', color: '#aaa' }}>
                    {sizePanel.gapPct?.toFixed(1)}% · {sizePanel.gapMult}×
                  </span>
                </div>

                {/* Divider */}
                <span style={{ color: 'rgba(255,255,255,0.08)', fontSize: 18 }}>|</span>

                {/* Risk projection */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ fontSize: 12, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    {sizePanel.isETF ? 'ETF Risk' : 'Stock Risk'}
                  </span>
                  <span style={{ fontSize: 14, fontFamily: 'monospace', color: '#aaa' }}>
                    {sizePanel.isETF ? sizePanel.etfRiskPct : sizePanel.stockRiskPct}%
                  </span>
                  <span style={{ fontSize: 14, color: overCap ? '#dc3545' : '#28a745' }}>→</span>
                  <span style={{ fontSize: 14, fontWeight: 800, fontFamily: 'monospace',
                    color: overCap ? '#dc3545' : '#28a745' }}>
                    {sizePanel.isETF ? projEtfPct : projStockPct}%
                  </span>
                  <span style={{ fontSize: 10, color: '#555' }}>/ {sizePanel.isETF ? etfCap : stockCap}%</span>
                  {overCap && <span style={{ fontSize: 10, color: '#dc3545', marginLeft: 2 }}>⚠ CAP</span>}
                </div>

                {/* Divider */}
                <span style={{ color: 'rgba(255,255,255,0.08)', fontSize: 18 }}>|</span>

                {/* NAV + Vitality */}
                <div style={{ display: 'flex', gap: 18 }}>
                  <div>
                    <span style={{ fontSize: 12, color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em' }}>NAV </span>
                    <span style={{ fontSize: 14, fontFamily: 'monospace', color: '#666' }}>
                      ${(sizePanel.nav / 1000).toFixed(0)}K
                    </span>
                  </div>
                  <div>
                    <span style={{ fontSize: 12, color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{sizePanel.vitalityPct ?? (sizePanel.isETF ? 0.5 : 1)}% Vitality </span>
                    <span style={{ fontSize: 14, fontFamily: 'monospace', color: '#666' }}>
                      ${vitality.toLocaleString()}
                    </span>
                  </div>
                </div>

              </div>
            </div>
          );
        })()}

        {/* Controls */}
        <div className={styles.controls}>
          <div className={styles.rangeButtons}>
            {['3m', '12m', 'all'].map(r => (
              <button
                key={r}
                className={`${styles.rangeBtn} ${range === r ? styles.rangeBtnActive : ''}`}
                onClick={() => setRange(r)}
              >
                {r === '3m' ? '3M' : r === '12m' ? '12M' : 'All'}
              </button>
            ))}
          </div>
          <div className={styles.priceInfo}>
            {currentSignal === 'BL' && (
              <span className={`${styles.pnthrBadge} ${styles.pnthrBadgeBL}`}>BL</span>
            )}
            {currentSignal === 'SS' && (
              <span className={`${styles.pnthrBadge} ${styles.pnthrBadgeSS}`}>SS</span>
            )}
            {currentSignal === 'BE' && (
              <span className={`${styles.pnthrBadge} ${styles.pnthrBadgeBE}`}>BE</span>
            )}
            {currentSignal === 'SE' && (
              <span className={`${styles.pnthrBadge} ${styles.pnthrBadgeSE}`}>SE</span>
            )}
            <span className={styles.currentPrice}>${stock.currentPrice?.toLocaleString()}</span>
            {(() => {
              // When SIZE IT is open, reflect its direction in the stop badges
              const sizePanelDir = sizePanel?.direction; // 'LONG' | 'SHORT' | null
              const signalDir    = currentSignal === 'BL' ? 'LONG' : currentSignal === 'SS' ? 'SHORT' : null;
              const overridden   = sizePanelDir && signalDir && sizePanelDir !== signalDir;

              const displayPnthrStop = overridden ? sizePanel.adjustedStop : pnthrStop;
              const displayCurrStop  = (() => {
                if (!overridden || !allWeeklyData.length) return currentWeekStop;
                const lastBar = allWeeklyData[allWeeklyData.length - 1];
                return sizePanelDir === 'LONG'
                  ? parseFloat((lastBar.low  - 0.01).toFixed(2))
                  : parseFloat((lastBar.high + 0.01).toFixed(2));
              })();

              const overrideStyle = { fontSize: 10, marginLeft: 4, fontWeight: 900,
                color: '#f59e0b', letterSpacing: '0.04em' };
              return (
                <>
                  {displayPnthrStop != null && (
                    <span className={styles.stopBadge}>
                      PNTHR Stop: ${displayPnthrStop.toFixed(2)}
                      {overridden && <span style={overrideStyle}>⚠ {sizePanelDir}</span>}
                    </span>
                  )}
                  {displayCurrStop != null && (
                    <span className={styles.stopBadgeCurr}>
                      Curr Stop: ${displayCurrStop.toFixed(2)}
                      {overridden && <span style={overrideStyle}>⚠ {sizePanelDir}</span>}
                    </span>
                  )}
                </>
              );
            })()}
          </div>
        </div>

        {/* Chart */}
        <div className={styles.chartArea}>
          {loading && (
            <div className={styles.loadingState}>
              <div className={styles.spinner}></div>
              <p>Loading chart...</p>
            </div>
          )}
          {error && <div className={styles.errorState}>{error}</div>}
          {!loading && !error && (
            <div className={styles.chartWrapper}>
              <div ref={chartContainerRef} className={styles.chartContainer} />

              {/* PNTHR Kill badge — upper-left overlay for top-10 Kill stocks */}
              {(() => {
                const killRank = killRankMap?.get(stock.ticker)
                  ?? (stock.isTop10 && stock.killRank ? stock.killRank : null);
                return killRank != null ? (
                  <div className={styles.killBadgeOverlay} title={`PNTHR Kill #${killRank}`}>
                    <KillBadge rank={killRank} size={52} />
                  </div>
                ) : null;
              })()}

              {/* Earnings Week label — centered top of chart when in earnings window */}
              {inEarningsWindow && (
                <div className={styles.earningsWindowLabel}>Earnings Week</div>
              )}

              {/* BL/SS/BE/SE signal badges — overlaid on chart at signal bar */}
              {signalMarkers.map((m, i) => {
                const isProfitable = (m.signal === 'BE' || m.signal === 'SE') && m.profitPct != null && m.profitPct > 0;
                return (
                  <span
                    key={i}
                    className={`${styles.chartSignalBadge} ${
                      m.signal === 'BL' ? styles.chartSignalBadgeBL :
                      m.signal === 'SS' ? styles.chartSignalBadgeSS :
                      m.signal === 'BE' ? styles.chartSignalBadgeBE :
                      styles.chartSignalBadgeSE
                    }`}
                    style={{
                      left: m.left,
                      top: m.top,
                      pointerEvents: isProfitable ? 'auto' : 'none',
                      cursor: isProfitable ? 'pointer' : 'default',
                    }}
                    onMouseEnter={isProfitable ? () => setHoveredMarkerProfit(m) : undefined}
                    onMouseLeave={isProfitable ? () => setHoveredMarkerProfit(null) : undefined}
                  >{m.signal}</span>
                );
              })}

              {/* Panther head — marks the date stock first entered the long or short top-100 list */}
              {pantherMarkerPos && (
                <div
                  className={styles.pantherMarker}
                  style={{ left: pantherMarkerPos.left, top: pantherMarkerPos.top }}
                  title={`First appeared in ${pantherMarkerPos.list} top-100 list`}
                >
                  <img src={pantherHeadIcon} alt="PNTHR entry" className={styles.pantherIcon} />
                  <span className={`${styles.pantherBadge} ${pantherMarkerPos.list === 'LONG' ? styles.pantherBadgeLong : styles.pantherBadgeShort}`}>
                    {pantherMarkerPos.list === 'LONG' ? 'L' : 'S'}
                  </span>
                </div>
              )}

              {/* Profit tooltip for profitable BE/SE markers */}
              {hoveredMarkerProfit && (
                <div
                  className={styles.profitTooltip}
                  style={{ left: Math.max(8, hoveredMarkerProfit.left - 136), top: Math.max(8, hoveredMarkerProfit.top - 54) }}
                >
                  <div className={styles.profitTooltipTitle}>
                    {hoveredMarkerProfit.signal} Profit
                  </div>
                  <div className={styles.profitTooltipRow}>
                    +{hoveredMarkerProfit.profitPct.toFixed(2)}%
                  </div>
                  <div className={styles.profitTooltipRow}>
                    +${hoveredMarkerProfit.profitDollar.toFixed(2)}/sh
                  </div>
                </div>
              )}

              {/* OHLC tooltip on hover */}
              {hoveredBar && (
                <div
                  className={styles.ohlcTooltip}
                  style={{
                    left: hoveredBar.x < 180 ? hoveredBar.x + 14 : hoveredBar.x - 148,
                    top: Math.max(8, hoveredBar.y - 72),
                  }}
                >
                  <div className={styles.ohlcDate}>Week of {formatWeekDate(hoveredBar.time)}</div>
                  <div className={styles.ohlcRow}><span>O</span><span>${hoveredBar.open?.toFixed(2)}</span></div>
                  <div className={styles.ohlcRow}><span>H</span><span>${hoveredBar.high?.toFixed(2)}</span></div>
                  <div className={styles.ohlcRow}><span>L</span><span>${hoveredBar.low?.toFixed(2)}</span></div>
                  <div className={styles.ohlcRow}><span>C</span><span>${hoveredBar.close?.toFixed(2)}</span></div>
                </div>
              )}

              {/* Navigation — overlaid at bottom-center of chart */}
              <div className={styles.navigation}>
                <button
                  className={styles.navBtn}
                  onClick={() => setCurrentIndex(i => Math.max(0, i - 1))}
                  disabled={currentIndex === 0}
                >
                  ← Prev
                </button>
                <span className={styles.navPosition}>{currentIndex + 1} / {stocks.length}</span>
                <button
                  className={styles.navBtn}
                  onClick={() => setCurrentIndex(i => Math.min(stocks.length - 1, i + 1))}
                  disabled={currentIndex === stocks.length - 1}
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
