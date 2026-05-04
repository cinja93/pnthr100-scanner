import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, BarSeries, LineSeries, createSeriesMarkers } from 'lightweight-charts';
import { API_BASE, authHeaders } from '../services/api';
import { getSectorEmaPeriod, DEFAULT_EMA_PERIOD } from '../utils/sectorEmaConfig';

const ROW_HEIGHT = 420;
const CHART_HEIGHT = 380;

const OVERLAY_OPTIONS = [
  { key: 'boxes',      label: 'Boxes (v2)' },
  { key: 'opema',      label: 'OpEMA' },
  { key: 'signals',    label: 'BL/SS Signals' },
  { key: 'trendlines', label: 'Trendlines (3-pt)' },
];

export default function TestPage() {
  const [tickers, setTickers]   = useState([]);
  const [search, setSearch]     = useState('');
  const [loading, setLoading]   = useState(true);
  const [meta, setMeta]         = useState(null);
  const [enabled, setEnabled]   = useState({ boxes: true, opema: true, signals: true, trendlines: true });
  const [recomputing, setRecomputing] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(`${API_BASE}/api/test/tickers`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => { setTickers(d.tickers || []); setMeta(d.meta || null); })
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    return q ? tickers.filter(t => t.includes(q)) : tickers;
  }, [tickers, search]);

  async function handleRecompute() {
    if (!confirm('Recompute box backtest across all tickers? May take 30-60s.')) return;
    setRecomputing(true);
    try {
      const r = await fetch(`${API_BASE}/api/test/recompute?overlay=box-breakout`, {
        method: 'POST', headers: authHeaders(),
      });
      const d = await r.json();
      alert(`Done. ${d.alertsWritten || 0} alerts across ${d.tickersProcessed || 0} tickers.`);
      window.location.reload();
    } catch (e) {
      alert('Recompute failed: ' + e.message);
    } finally { setRecomputing(false); }
  }

  const toggle = (k) => setEnabled(prev => ({ ...prev, [k]: !prev[k] }));

  return (
    <div style={{ padding: 16, color: '#e0e0e0', minHeight: '100vh' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ color: '#fcf000', margin: 0, fontSize: 22, letterSpacing: 1 }}>🧪 TEST</h1>
          <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
            Reusable chart playground · {tickers.length} tickers · admin only
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <input
          placeholder="Filter ticker..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            background: '#111', color: '#e0e0e0', border: '1px solid #333',
            borderRadius: 4, padding: '6px 10px', fontSize: 13, width: 160,
          }}
        />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {OVERLAY_OPTIONS.map(o => (
            <label key={o.key} style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              background: enabled[o.key] ? '#fcf000' : '#222',
              color: enabled[o.key] ? '#000' : '#888',
              border: '1px solid #333', borderRadius: 4, padding: '4px 9px',
              fontSize: 11, fontWeight: 700, cursor: 'pointer',
            }}>
              <input type="checkbox" checked={enabled[o.key]} onChange={() => toggle(o.key)} style={{ display: 'none' }} />
              {o.label}
            </label>
          ))}
        </div>
        <button
          onClick={handleRecompute}
          disabled={recomputing}
          style={{
            background: recomputing ? '#333' : '#fcf000',
            color: recomputing ? '#888' : '#000',
            border: 'none', borderRadius: 4, padding: '6px 14px', fontSize: 12,
            fontWeight: 700, cursor: recomputing ? 'wait' : 'pointer',
          }}
        >
          {recomputing ? 'Recomputing...' : '⟳ Recompute Boxes'}
        </button>
      </div>

      {meta?.lastRunAt && (
        <div style={{ fontSize: 10, color: '#666', marginBottom: 8 }}>
          Last box backtest run: {new Date(meta.lastRunAt).toLocaleString()} · {meta.alertsTotal || 0} alerts across {meta.tickersTotal || 0} tickers
        </div>
      )}

      {loading && <div style={{ padding: 40, textAlign: 'center', color: '#888' }}>Loading tickers...</div>}
      {!loading && filtered.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', color: '#888' }}>No tickers match.</div>
      )}
      {!loading && filtered.map(ticker => (
        <LazyTickerRow key={ticker} ticker={ticker} enabled={enabled} />
      ))}
    </div>
  );
}

function LazyTickerRow({ ticker, enabled }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (e.isIntersecting) { setVisible(true); io.disconnect(); }
      }
    }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} style={{
      height: ROW_HEIGHT, marginBottom: 12, background: '#0a0a0a',
      border: '1px solid #222', borderRadius: 6, padding: 10,
      display: 'flex', flexDirection: 'column',
    }}>
      {visible
        ? <TickerChart ticker={ticker} enabled={enabled} />
        : <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#444', fontSize: 11 }}>
            {ticker} · scroll to load
          </div>
      }
    </div>
  );
}

function TickerChart({ ticker, enabled }) {
  const containerRef = useRef(null);
  const [data, setData]       = useState(null);   // { weekly, sector }
  const [boxes, setBoxes]     = useState(null);
  const [events, setEvents]   = useState(null);   // [{type:'BL'|'SS'|'BE'|'SE', weekOf, ...}]
  const [tlCount, setTlCount] = useState(0);
  const [error, setError]     = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`${API_BASE}/api/test/candles?ticker=${ticker}`, { headers: authHeaders() }).then(r => r.json()),
      fetch(`${API_BASE}/api/test/box-alerts?ticker=${ticker}`, { headers: authHeaders() }).then(r => r.json()),
      fetch(`${API_BASE}/api/test/signals?ticker=${ticker}`, { headers: authHeaders() }).then(r => r.json()),
    ])
      .then(([candles, boxData, sigData]) => {
        if (cancelled) return;
        setData({ weekly: candles?.weekly || [], sector: candles?.sector || null });
        setBoxes(boxData?.boxes || []);
        setEvents(sigData?.events || []);
      })
      .catch(e => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [ticker]);

  useEffect(() => {
    if (!data || !containerRef.current) return;
    const slice = data.weekly.slice(-260);
    if (slice.length === 0) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: CHART_HEIGHT,
      layout:    { background: { color: '#0a0a0a' }, textColor: '#888' },
      grid:      { vertLines: { color: '#1a1a1a' }, horzLines: { color: '#1a1a1a' } },
      timeScale: { borderColor: '#333', timeVisible: false },
      rightPriceScale: { borderColor: '#333' },
    });

    const bars = slice.map(b => ({ time: b.weekOf, open: b.open, high: b.high, low: b.low, close: b.close }));
    const barSeries = chart.addSeries(BarSeries, { upColor: '#26a69a', downColor: '#ef5350' });
    barSeries.setData(bars);

    // ── OpEMA overlay ──
    if (enabled.opema) {
      const period = data.sector ? getSectorEmaPeriod(data.sector) : DEFAULT_EMA_PERIOD;
      const emaPoints = computeEMA(slice, period);
      if (emaPoints.length) {
        const ema = chart.addSeries(LineSeries, {
          color: '#3b82f6', lineWidth: 2,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        });
        ema.setData(emaPoints);
      }
    }

    // ── Boxes ──
    if (enabled.boxes && boxes && boxes.length) {
      drawBoxes(chart, boxes, slice);
    }

    // ── Trendlines ──
    let tlCountLocal = 0;
    if (enabled.trendlines) {
      const tl = computeTrendlines(slice);
      drawTrendlines(chart, tl, slice);
      tlCountLocal = tl.active.length + tl.broken.length;
    }
    setTlCount(tlCountLocal);

    // ── Signals (BL / SS / BE / SE) ──
    // BL = green ↑ below bar (long entry)
    // BE = green × above bar (long exit, BL state ended)
    // SS = red ↓ above bar (short entry)
    // SE = red × below bar (short exit, SS state ended)
    if (enabled.signals && events && events.length) {
      const visibleStart = slice[0].weekOf;
      const visibleEnd   = slice[slice.length - 1].weekOf;
      // Map weekOf strings → which bar in slice contains that week. Trade-log
      // weekOf is Friday-aligned, but we need to snap to the Mon-aligned bar.
      function snapToBar(targetWeek) {
        if (targetWeek < visibleStart || targetWeek > addOneWeek(visibleEnd)) return null;
        let lastMatch = null;
        for (const b of slice) {
          if (b.weekOf <= targetWeek) lastMatch = b;
          else break;
        }
        return lastMatch;
      }
      const markers = [];
      for (const e of events) {
        const bar = snapToBar(e.weekOf);
        if (!bar) continue;
        const cfg = MARKER_CONFIG[e.type];
        if (!cfg) continue;
        markers.push({
          time:     bar.weekOf,
          position: cfg.position,
          color:    cfg.color,
          shape:    cfg.shape,
          text:     e.type,
          size:     1,
        });
      }
      markers.sort((a, b) => a.time.localeCompare(b.time));
      if (markers.length) createSeriesMarkers(barSeries, markers);
    }

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    });
    ro.observe(containerRef.current);

    return () => { ro.disconnect(); chart.remove(); };
  }, [data, boxes, events, enabled]);

  if (error) return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ef5350' }}>Error: {error}</div>;
  if (!data) return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666' }}>Loading {ticker}...</div>;

  const period = data.sector ? getSectorEmaPeriod(data.sector) : DEFAULT_EMA_PERIOD;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#fcf000' }}>
          {ticker}
          {data.sector && <span style={{ fontSize: 11, fontWeight: 400, color: '#888', marginLeft: 8 }}>· {data.sector}</span>}
        </div>
        <div style={{ fontSize: 10, color: '#666', display: 'flex', gap: 12 }}>
          {enabled.opema && <span><span style={{ color: '#3b82f6' }}>━</span> OpEMA {period}W</span>}
          {enabled.boxes && boxes != null && <span>📦 {boxes.length} box{boxes.length === 1 ? '' : 'es'}</span>}
          {enabled.signals && events != null && <span>🎯 {events.length} event{events.length === 1 ? '' : 's'}</span>}
          {enabled.trendlines && <span>📈 {tlCount} trendline{tlCount === 1 ? '' : 's'}</span>}
        </div>
      </div>
      <div ref={containerRef} style={{ width: '100%', height: CHART_HEIGHT }} />
    </>
  );
}

// ─────────────────────────── Helpers ───────────────────────────

// Marker visual config per signal type. BL/SS = entries (arrows). BE/SE = exits (X marks).
const MARKER_CONFIG = {
  BL: { color: '#26a69a', position: 'belowBar', shape: 'arrowUp'   }, // long entry
  SS: { color: '#ef5350', position: 'aboveBar', shape: 'arrowDown' }, // short entry
  BE: { color: '#26a69a', position: 'aboveBar', shape: 'circle'    }, // long exit (BL state ended)
  SE: { color: '#ef5350', position: 'belowBar', shape: 'circle'    }, // short exit (SS state ended)
};

function addOneWeek(weekOfStr) {
  const d = new Date(weekOfStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}

function computeEMA(weeklyBars, period) {
  if (weeklyBars.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let ema = null;
  for (let i = 0; i < weeklyBars.length; i++) {
    const close = weeklyBars[i].close;
    if (i < period - 1) continue;
    if (ema === null) {
      // Seed with SMA of first `period` values
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += weeklyBars[j].close;
      ema = s / period;
    } else {
      ema = close * k + ema * (1 - k);
    }
    out.push({ time: weeklyBars[i].weekOf, value: +ema.toFixed(2) });
  }
  return out;
}

// Lightweight-Charts has no native rectangle; draw box top + bottom as
// horizontal line segments spanning the box period.
function drawBoxes(chart, boxes, slice) {
  for (const box of boxes) {
    const color =
      box.status === 'broken-up'   ? '#26a69a' :
      box.status === 'broken-down' ? '#ef5350' :
                                     '#fcf000';
    const startIdx = slice.findIndex(b => b.weekOf >= box.startDate);
    const endWeek  = box.endDate || slice[slice.length - 1].weekOf;
    const endIdx   = slice.findIndex(b => b.weekOf >= endWeek);
    if (startIdx < 0) continue;
    const stopIdx = endIdx < 0 ? slice.length - 1 : endIdx;
    const span = slice.slice(startIdx, stopIdx + 1).map(b => b.weekOf);
    if (span.length < 2) continue;
    const opt = { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
    const top = chart.addSeries(LineSeries, opt);
    const bot = chart.addSeries(LineSeries, opt);
    top.setData(span.map(t => ({ time: t, value: box.top })));
    bot.setData(span.map(t => ({ time: t, value: box.bottom })));
  }
}

// ─────────────────────────── Rule #1 — 3-Point Diagonal ───────────────────────────
//
// Find diagonals connecting 3 highs (downtrend) or 3 lows (uptrend) where:
//  - Each anchor within ±1% of the line connecting them
//  - ≥ 3 weeks between adjacent anchors
//  - Wicks only (highs for downtrend, lows for uptrend)
//  - Direction strict: h1 > h2 > h3 for downtrend, l1 < l2 < l3 for uptrend
//  - Break = wick pierces line by > 1% AFTER the third anchor
//  - Cap: 2 active up + 2 active down
//  - Selection: longest span (P1 date → today/break)
//  - Broken lines disappear 5 weeks after break
const TL_FIT_PCT       = 0.01;
const TL_MIN_SPACING_W = 3;
const TL_BREAK_PCT     = 0.01;
const TL_MAX_LINES_PER_DIR = 2;
const TL_BROKEN_FADE_W = 5;

function computeTrendlines(weekly) {
  const N = weekly.length;
  if (N < 7) return { active: [], broken: [] };

  const downCandidates = []; // { i, j, k, slope, intercept }
  const upCandidates   = [];

  // For each (i, k) pair, find any j between them that fits
  for (let i = 0; i < N - 6; i++) {
    for (let k = i + 6; k < N; k++) {
      const dx = k - i;
      const hi = weekly[i].high, hk = weekly[k].high;
      const li = weekly[i].low,  lk = weekly[k].low;

      // Downtrend: hi > hk
      if (hi > hk) {
        const slope = (hk - hi) / dx;
        for (let j = i + TL_MIN_SPACING_W; j <= k - TL_MIN_SPACING_W; j++) {
          const lineAtJ = hi + slope * (j - i);
          const hj = weekly[j].high;
          if (hj <= hi && hj >= hk && Math.abs(hj - lineAtJ) / lineAtJ <= TL_FIT_PCT) {
            downCandidates.push({ i, j, k, slope, intercept: hi - slope * i });
            break; // one valid j is enough to flag this (i,k) pair
          }
        }
      }
      // Uptrend: li < lk
      if (li < lk) {
        const slope = (lk - li) / dx;
        for (let j = i + TL_MIN_SPACING_W; j <= k - TL_MIN_SPACING_W; j++) {
          const lineAtJ = li + slope * (j - i);
          const lj = weekly[j].low;
          if (lj >= li && lj <= lk && Math.abs(lj - lineAtJ) / lineAtJ <= TL_FIT_PCT) {
            upCandidates.push({ i, j, k, slope, intercept: li - slope * i });
            break;
          }
        }
      }
    }
  }

  // For each candidate, walk forward from k+1 and find first wick that breaks
  // the line by >1%. Determine status (active vs broken) and break date.
  function annotate(c, dir) {
    const lineAt = (idx) => c.intercept + c.slope * idx;
    let breakIdx = null;
    for (let m = c.k + 1; m < N; m++) {
      const v = lineAt(m);
      if (dir === 'down' && weekly[m].high > v * (1 + TL_BREAK_PCT)) { breakIdx = m; break; }
      if (dir === 'up'   && weekly[m].low  < v * (1 - TL_BREAK_PCT)) { breakIdx = m; break; }
    }
    return { ...c, dir, breakIdx, span: (breakIdx ?? N - 1) - c.i };
  }

  const downAnnotated = downCandidates.map(c => annotate(c, 'down'));
  const upAnnotated   = upCandidates.map(c => annotate(c, 'up'));

  // Pick longest span among lines with same anchor i (longest is the "longest-span" winner)
  // Then take top N by span across all
  function pickTop(arr, max) {
    arr.sort((a, b) => b.span - a.span);
    const seen = new Set();
    const picked = [];
    for (const c of arr) {
      // Dedupe by the anchor pair (i, k) ignoring j
      const key = `${c.i}_${c.k}`;
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(c);
      if (picked.length >= max) break;
    }
    return picked;
  }

  const activeDown = pickTop(downAnnotated.filter(c => c.breakIdx === null), TL_MAX_LINES_PER_DIR);
  const activeUp   = pickTop(upAnnotated  .filter(c => c.breakIdx === null), TL_MAX_LINES_PER_DIR);
  const brokenDown = pickTop(downAnnotated.filter(c => c.breakIdx !== null && (N - 1 - c.breakIdx) <= TL_BROKEN_FADE_W), TL_MAX_LINES_PER_DIR);
  const brokenUp   = pickTop(upAnnotated  .filter(c => c.breakIdx !== null && (N - 1 - c.breakIdx) <= TL_BROKEN_FADE_W), TL_MAX_LINES_PER_DIR);

  return { active: [...activeUp, ...activeDown], broken: [...brokenUp, ...brokenDown] };
}

function drawTrendlines(chart, tl, slice) {
  const N = slice.length;
  function draw(c, isActive) {
    const startTime = slice[c.i].weekOf;
    const endIdx = c.breakIdx ?? N - 1;
    const endTime = slice[endIdx].weekOf;
    const startVal = c.intercept + c.slope * c.i;
    const endVal   = c.intercept + c.slope * endIdx;
    const color = c.dir === 'down'
      ? (isActive ? '#ef5350' : '#7a3a3a')
      : (isActive ? '#26a69a' : '#3a7a5e');
    const series = chart.addSeries(LineSeries, {
      color, lineWidth: 2, lineStyle: isActive ? 0 : 2,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    series.setData([
      { time: startTime, value: +startVal.toFixed(2) },
      { time: endTime,   value: +endVal.toFixed(2) },
    ]);
  }
  for (const c of tl.active) draw(c, true);
  for (const c of tl.broken) draw(c, false);
}
