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
  const chartRef     = useRef(null);
  const seriesRef    = useRef(null);
  const overlayRef   = useRef(null);
  const drawnSeriesRef = useRef([]);
  const sliceRef     = useRef([]);
  const [data, setData]       = useState(null);
  const [boxes, setBoxes]     = useState(null);
  const [events, setEvents]   = useState(null);
  const [tlCount, setTlCount] = useState(0);
  const [error, setError]     = useState(null);
  const [drawMode, setDrawMode]     = useState(false);
  const [drawnLines, setDrawnLines] = useState([]);   // [{_id, t1, v1, t2, v2, expectSide}]
  const [tempLine, setTempLine]     = useState(null); // {x1,y1,x2,y2} screen-px during drag
  const [hoverSnap, setHoverSnap]   = useState(null); // {x, y} preview of where click would snap
  const [ctxMenu, setCtxMenu]       = useState(null); // {x, y, hitId}
  const [debug, setDebug]           = useState('idle');  // visible status badge for diagnosing issues

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`${API_BASE}/api/test/candles?ticker=${ticker}`, { headers: authHeaders() }).then(r => r.json()),
      fetch(`${API_BASE}/api/test/box-alerts?ticker=${ticker}`, { headers: authHeaders() }).then(r => r.json()),
      fetch(`${API_BASE}/api/test/signals?ticker=${ticker}`, { headers: authHeaders() }).then(r => r.json()),
      fetch(`${API_BASE}/api/test/trendlines?ticker=${ticker}`, { headers: authHeaders() }).then(r => r.json()),
    ])
      .then(([candles, boxData, sigData, tlData]) => {
        if (cancelled) return;
        setData({ weekly: candles?.weekly || [], sector: candles?.sector || null });
        setBoxes(boxData?.boxes || []);
        setEvents(sigData?.events || []);
        setDrawnLines(tlData?.trendlines || []);
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
    chartRef.current  = chart;
    seriesRef.current = barSeries;
    sliceRef.current  = slice;

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

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      drawnSeriesRef.current = [];
    };
  }, [data, boxes, events, enabled]);

  // Render user-drawn lines as LineSeries on the chart (re-runs when drawnLines changes)
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    // Remove prior drawn series
    for (const s of drawnSeriesRef.current) {
      try { chart.removeSeries(s); } catch (e) { /* chart may have been disposed */ }
    }
    drawnSeriesRef.current = [];
    for (const ln of drawnLines) {
      const s = chart.addSeries(LineSeries, {
        color: '#fcf000', lineWidth: 2,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
      s.setData([
        { time: ln.t1, value: ln.v1 },
        { time: ln.t2, value: ln.v2 },
      ]);
      drawnSeriesRef.current.push(s);
    }
  }, [drawnLines, data]);

  // ── Draw mode mouse handlers (only active when drawMode is true) ──
  function snapAt(clientX, clientY) {
    const chart = chartRef.current, series = seriesRef.current, slice = sliceRef.current;
    if (!chart || !series || !slice.length || !overlayRef.current) return null;
    const rect = overlayRef.current.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    // Find nearest bar by x-coordinate
    let bestBar = null, bestDx = Infinity, bestPx = null;
    for (const b of slice) {
      const px = chart.timeScale().timeToCoordinate(b.weekOf);
      if (px == null) continue;
      const dx = Math.abs(px - x);
      if (dx < bestDx) { bestDx = dx; bestBar = b; bestPx = px; }
    }
    if (!bestBar) return null;
    const priceAtY = series.coordinateToPrice(y);
    if (priceAtY == null) return null;
    // Snap to whichever of high/low is closer to the click
    const snapHigh = Math.abs(priceAtY - bestBar.high) <= Math.abs(priceAtY - bestBar.low);
    const snappedPrice = snapHigh ? bestBar.high : bestBar.low;
    const snappedY = series.priceToCoordinate(snappedPrice);
    return { time: bestBar.weekOf, value: snappedPrice, x: bestPx, y: snappedY, snapHigh };
  }

  const drawStartRef     = useRef(null); // {time, value, x, y, snapHigh} when drawing new line
  const editingRef       = useRef(null); // {lineId, endpoint:'start'|'end', otherTime, otherVal} when editing
  const windowHandlersRef = useRef(null); // for cleanup of document-level listeners

  // Compute expectSide for a line given its endpoints, vs latest bar's close.
  function computeExpectSide(t1, v1, t2, v2) {
    const slice = sliceRef.current;
    if (!slice || slice.length === 0) return 'above';
    const lastBar = slice[slice.length - 1];
    const slope = (v2 - v1) / Math.max(1, daysBetweenIso(t2, t1));
    const lineAtLast = v1 + slope * daysBetweenIso(lastBar.weekOf, t1);
    return lineAtLast >= lastBar.close ? 'above' : 'below';
  }

  // Hit test: is the click near an endpoint of an existing drawn line? Returns
  // {lineId, endpoint, otherTime, otherVal} for handle-drag, or null.
  function findEndpointHit(clientX, clientY) {
    const chart = chartRef.current, series = seriesRef.current;
    if (!chart || !series || !overlayRef.current) return null;
    const rect = overlayRef.current.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    const HANDLE_R = 10;
    for (const ln of drawnLines) {
      const x1 = chart.timeScale().timeToCoordinate(ln.t1);
      const y1 = series.priceToCoordinate(ln.v1);
      const x2 = chart.timeScale().timeToCoordinate(ln.t2);
      const y2 = series.priceToCoordinate(ln.v2);
      if (x1 != null && y1 != null && Math.hypot(x1 - x, y1 - y) <= HANDLE_R) {
        return { lineId: ln._id, endpoint: 'start', otherTime: ln.t2, otherVal: ln.v2 };
      }
      if (x2 != null && y2 != null && Math.hypot(x2 - x, y2 - y) <= HANDLE_R) {
        return { lineId: ln._id, endpoint: 'end', otherTime: ln.t1, otherVal: ln.v1 };
      }
    }
    return null;
  }

  function attachWindowDragListeners() {
    if (windowHandlersRef.current) return;
    const onMove = (ev) => onDrawMove(ev);
    const onUp   = (ev) => { onDrawUp(ev); detachWindowDragListeners(); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    windowHandlersRef.current = { onMove, onUp };
  }
  function detachWindowDragListeners() {
    const h = windowHandlersRef.current;
    if (!h) return;
    window.removeEventListener('mousemove', h.onMove);
    window.removeEventListener('mouseup', h.onUp);
    windowHandlersRef.current = null;
  }

  function onDrawDown(e) {
    if (!drawMode) {
      setDebug(`down ignored — drawMode off`);
      return;
    }
    e.preventDefault();
    setDebug(`down @ (${e.clientX},${e.clientY}) — looking for snap…`);
    // Endpoint-editing temporarily disabled while we fix the basic draw flow.
    // Re-enable once Scott confirms new-line drawing is rock solid.
    // const grab = findEndpointHit(e.clientX, e.clientY);
    // if (grab) { ... }
    const snap = snapAt(e.clientX, e.clientY);
    if (!snap) {
      setDebug(`snap FAILED — chart=${!!chartRef.current} series=${!!seriesRef.current} bars=${sliceRef.current?.length || 0}`);
      return;
    }
    drawStartRef.current = snap;
    setTempLine({ x1: snap.x, y1: snap.y, x2: snap.x, y2: snap.y });
    setHoverSnap(null);
    attachWindowDragListeners();
    setDebug(`drawing — start=${snap.time} @ $${snap.value.toFixed(2)} (${snap.snapHigh ? 'high' : 'low'})`);
  }

  function onDrawMove(e) {
    if (!drawMode) return;
    const rect = overlayRef.current.getBoundingClientRect();
    const cursorX = e.clientX - rect.left;
    const cursorY = e.clientY - rect.top;
    if (drawStartRef.current) {
      setTempLine({ x1: drawStartRef.current.x, y1: drawStartRef.current.y, x2: cursorX, y2: cursorY });
    } else if (editingRef.current) {
      // Show the line being edited: fixed end → cursor
      setTempLine(prev => prev ? { x1: prev.x1, y1: prev.y1, x2: cursorX, y2: cursorY } : null);
    } else {
      const snap = snapAt(e.clientX, e.clientY);
      setHoverSnap(snap ? { x: snap.x, y: snap.y, snapHigh: snap.snapHigh } : null);
    }
  }

  async function onDrawUp(e) {
    if (!drawMode) return;
    setDebug(`up @ (${e.clientX},${e.clientY})`);
    // Endpoint-edit completion
    if (editingRef.current) {
      const edit = editingRef.current;
      const snap = snapAt(e.clientX, e.clientY);
      editingRef.current = null;
      setTempLine(null);
      if (!snap) return;
      // Build updated endpoints
      const isStart = edit.endpoint === 'start';
      const newT1 = isStart ? snap.time : edit.otherTime;
      const newV1 = isStart ? snap.value : edit.otherVal;
      const newT2 = isStart ? edit.otherTime : snap.time;
      const newV2 = isStart ? edit.otherVal : snap.value;
      if (newT1 === newT2) return; // refuse zero-length
      const expectSide = computeExpectSide(newT1, newV1, newT2, newV2);
      // Optimistic UI update
      setDrawnLines(prev => prev.map(l => l._id === edit.lineId
        ? { ...l, t1: newT1, v1: newV1, t2: newT2, v2: newV2, expectSide }
        : l));
      // Persist
      try {
        await fetch(`${API_BASE}/api/test/trendlines/${edit.lineId}`, {
          method: 'PATCH',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ t1: newT1, v1: newV1, t2: newT2, v2: newV2, expectSide }),
        });
      } catch (err) { console.error('PATCH trendline failed', err); }
      return;
    }
    // New-line completion
    if (!drawStartRef.current) return;
    const start = drawStartRef.current;
    const end = snapAt(e.clientX, e.clientY);
    drawStartRef.current = null;
    setTempLine(null);
    if (!end || end.time === start.time) {
      setDebug(`rejected — ${!end ? 'no snap' : 'same bar as start'}`);
      return;
    }
    const [a, b] = start.time < end.time ? [start, end] : [end, start];
    const expectSide = computeExpectSide(a.time, a.value, b.time, b.value);
    const payload = { ticker, t1: a.time, v1: a.value, t2: b.time, v2: b.value, expectSide };
    setDrawnLines(prev => [...prev, { ...payload, _id: 'pending-' + Date.now() }]);
    setDebug(`saved ${a.time} → ${b.time} (${expectSide})`);
    try {
      const r = await fetch(`${API_BASE}/api/test/trendlines`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (j.ok) {
        setDrawnLines(prev => prev.map(l => l._id?.startsWith?.('pending-') && l.t1 === payload.t1 && l.t2 === payload.t2 ? { ...l, _id: j._id } : l));
      } else {
        setDebug(`server error: ${j.error || 'unknown'}`);
      }
    } catch (err) {
      setDebug(`network error: ${err.message}`);
      console.error('save trendline failed', err);
    }
  }

  // ── Right-click context menu ──
  function findHitLine(clientX, clientY) {
    const chart = chartRef.current, series = seriesRef.current;
    if (!chart || !series || !overlayRef.current) return null;
    const rect = overlayRef.current.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    const tAtX = chart.timeScale().coordinateToTime(x);
    if (tAtX == null) return null;
    const dateAtX = typeof tAtX === 'string' ? tAtX : (tAtX.year ? `${tAtX.year}-${String(tAtX.month).padStart(2, '0')}-${String(tAtX.day).padStart(2, '0')}` : null);
    if (!dateAtX) return null;
    const HIT_TOLERANCE_PX = 6;
    let best = null, bestDy = Infinity;
    for (const ln of drawnLines) {
      const slope = (ln.v2 - ln.v1) / Math.max(1, daysBetweenIso(ln.t2, ln.t1));
      const lineVal = ln.v1 + slope * daysBetweenIso(dateAtX, ln.t1);
      const lineY = series.priceToCoordinate(lineVal);
      if (lineY == null) continue;
      const dy = Math.abs(lineY - y);
      if (dy < HIT_TOLERANCE_PX && dy < bestDy) { best = ln; bestDy = dy; }
    }
    return best;
  }

  function onContextMenu(e) {
    e.preventDefault();
    if (drawnLines.length === 0) return;
    const hit = findHitLine(e.clientX, e.clientY);
    const rect = overlayRef.current.getBoundingClientRect();
    setCtxMenu({ x: e.clientX - rect.left, y: e.clientY - rect.top, hitId: hit?._id || null });
  }

  async function deleteOne(id) {
    if (!id || String(id).startsWith('pending-')) {
      setDrawnLines(prev => prev.filter(l => l._id !== id));
    } else {
      setDrawnLines(prev => prev.filter(l => l._id !== id));
      await fetch(`${API_BASE}/api/test/trendlines/${id}`, { method: 'DELETE', headers: authHeaders() });
    }
    setCtxMenu(null);
  }

  async function deleteAllForChart() {
    setDrawnLines([]);
    await fetch(`${API_BASE}/api/test/trendlines?ticker=${ticker}`, { method: 'DELETE', headers: authHeaders() });
    setCtxMenu(null);
  }

  // Extend a drawn line in either direction. Slope stays the same; only the
  // chosen endpoint moves to the leftmost/rightmost visible bar's date, with
  // its value recomputed along the original line.
  async function extendLine(lineId, direction) {
    const slice = sliceRef.current;
    if (!slice || slice.length === 0) return;
    const ln = drawnLines.find(l => l._id === lineId);
    if (!ln) return;
    const slope = (ln.v2 - ln.v1) / Math.max(1, daysBetweenIso(ln.t2, ln.t1));
    let updated;
    if (direction === 'left') {
      const newT1 = slice[0].weekOf;
      const newV1 = +(ln.v1 + slope * daysBetweenIso(newT1, ln.t1)).toFixed(2);
      updated = { ...ln, t1: newT1, v1: newV1 };
    } else {
      const newT2 = slice[slice.length - 1].weekOf;
      const newV2 = +(ln.v2 + slope * daysBetweenIso(newT2, ln.t2)).toFixed(2);
      updated = { ...ln, t2: newT2, v2: newV2 };
    }
    const expectSide = computeExpectSide(updated.t1, updated.v1, updated.t2, updated.v2);
    updated.expectSide = expectSide;
    setDrawnLines(prev => prev.map(l => l._id === lineId ? updated : l));
    setCtxMenu(null);
    if (lineId && !String(lineId).startsWith('pending-')) {
      try {
        await fetch(`${API_BASE}/api/test/trendlines/${lineId}`, {
          method: 'PATCH',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ t1: updated.t1, v1: updated.v1, t2: updated.t2, v2: updated.v2, expectSide }),
        });
      } catch (err) { console.error('extend trendline failed', err); }
    }
  }

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            background: drawMode ? '#fcf000' : '#222',
            color: drawMode ? '#000' : '#888',
            border: '1px solid #444', borderRadius: 4, padding: '3px 8px',
            fontSize: 11, fontWeight: 700, cursor: 'pointer',
          }}>
            <input type="checkbox" checked={drawMode} onChange={() => setDrawMode(v => !v)} style={{ display: 'none' }} />
            ✏️ Draw
          </label>
          {drawnLines.length > 0 && (
            <button
              onClick={() => setDrawnLines([])}
              style={{ background: '#222', color: '#888', border: '1px solid #444', borderRadius: 4, padding: '3px 8px', fontSize: 11, cursor: 'pointer' }}
            >
              Clear ({drawnLines.length})
            </button>
          )}
          <div style={{ fontSize: 10, color: '#666', display: 'flex', gap: 12 }}>
            {enabled.opema && <span><span style={{ color: '#3b82f6' }}>━</span> OpEMA {period}W</span>}
            {enabled.boxes && boxes != null && <span>📦 {boxes.length} box{boxes.length === 1 ? '' : 'es'}</span>}
            {enabled.signals && events != null && <span>🎯 {events.length} event{events.length === 1 ? '' : 's'}</span>}
            {enabled.trendlines && <span>📈 {tlCount} trendline{tlCount === 1 ? '' : 's'}</span>}
          </div>
        </div>
      </div>
      <div style={{ position: 'relative', width: '100%', height: CHART_HEIGHT }}>
        <div ref={containerRef} style={{ width: '100%', height: CHART_HEIGHT }} />
        {drawMode && (
          <div style={{
            position: 'absolute', top: 6, left: 6, zIndex: 11,
            background: 'rgba(0,0,0,0.85)', color: '#fcf000',
            padding: '4px 10px', borderRadius: 4, fontSize: 11, fontFamily: 'monospace',
            pointerEvents: 'none',
          }}>
            🐞 {debug}
          </div>
        )}
        {/* Drawing overlay — DIV (reliable event capture) on top of chart, with
            inner SVG for visuals only. zIndex forces it above any chart canvases. */}
        <div
          ref={overlayRef}
          onMouseDown={onDrawDown}
          onMouseMove={onDrawMove}
          onMouseUp={onDrawUp}
          onMouseLeave={() => {
            // Only clear hover preview — never cancel an in-progress drag
            // (the window-level mouseup will catch the release outside).
            if (!drawStartRef.current && !editingRef.current) {
              setHoverSnap(null);
            }
          }}
          onContextMenu={onContextMenu}
          onWheel={(e) => { if (drawMode) e.preventDefault(); }}
          style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%',
            pointerEvents: (drawMode || drawnLines.length > 0) ? 'auto' : 'none',
            cursor: drawMode ? 'crosshair' : 'default',
            zIndex: 10,
            background: drawMode ? 'rgba(252,240,0,0.04)' : 'transparent',
            border: drawMode ? '1px dashed rgba(252,240,0,0.5)' : 'none',
          }}
        >
          <svg width="100%" height="100%" style={{ pointerEvents: 'none', display: 'block' }}>
            {/* Endpoint handles for existing drawn lines (only visible in draw mode) */}
            {drawMode && drawnLines.map(ln => {
              const chart = chartRef.current, series = seriesRef.current;
              if (!chart || !series) return null;
              const x1 = chart.timeScale().timeToCoordinate(ln.t1);
              const y1 = series.priceToCoordinate(ln.v1);
              const x2 = chart.timeScale().timeToCoordinate(ln.t2);
              const y2 = series.priceToCoordinate(ln.v2);
              return (
                <g key={ln._id}>
                  {x1 != null && y1 != null && (
                    <circle cx={x1} cy={y1} r="6" fill="#fcf000" stroke="#000" strokeWidth="1.5" />
                  )}
                  {x2 != null && y2 != null && (
                    <circle cx={x2} cy={y2} r="6" fill="#fcf000" stroke="#000" strokeWidth="1.5" />
                  )}
                </g>
              );
            })}
            {/* Hover preview */}
            {drawMode && hoverSnap && !tempLine && (
              <>
                <circle cx={hoverSnap.x} cy={hoverSnap.y} r="6" fill="none" stroke="#fcf000" strokeWidth="1.5" strokeDasharray="2 2" />
                <text x={hoverSnap.x + 10} y={hoverSnap.y - 8} fill="#fcf000" fontSize="10" fontFamily="monospace">
                  {hoverSnap.snapHigh ? 'high' : 'low'}
                </text>
              </>
            )}
            {/* Active drag */}
            {tempLine && (
              <>
                <line x1={tempLine.x1} y1={tempLine.y1} x2={tempLine.x2} y2={tempLine.y2} stroke="#fcf000" strokeWidth="2" strokeDasharray="4 3" />
                <circle cx={tempLine.x1} cy={tempLine.y1} r="5" fill="#fcf000" stroke="#000" strokeWidth="1" />
              </>
            )}
          </svg>
        </div>
        {ctxMenu && (
          <>
            <div
              onClick={() => setCtxMenu(null)}
              style={{ position: 'fixed', inset: 0, zIndex: 99 }}
            />
            <div style={{
              position: 'absolute',
              left: ctxMenu.x, top: ctxMenu.y,
              background: '#0a0a0a', border: '1px solid #444', borderRadius: 4,
              padding: 4, fontSize: 12, color: '#e0e0e0', zIndex: 100,
              minWidth: 220, boxShadow: '0 4px 12px rgba(0,0,0,0.6)',
            }}>
              <button
                onClick={() => deleteOne(ctxMenu.hitId)}
                disabled={!ctxMenu.hitId}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  background: 'transparent', border: 'none', borderRadius: 3,
                  color: ctxMenu.hitId ? '#e0e0e0' : '#555',
                  padding: '6px 10px', cursor: ctxMenu.hitId ? 'pointer' : 'not-allowed',
                  fontSize: 12,
                }}
                onMouseEnter={e => ctxMenu.hitId && (e.currentTarget.style.background = '#222')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                Delete this trendline {ctxMenu.hitId ? '' : '(none under cursor)'}
              </button>
              <button
                onClick={() => extendLine(ctxMenu.hitId, 'left')}
                disabled={!ctxMenu.hitId}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  background: 'transparent', border: 'none', borderRadius: 3,
                  color: ctxMenu.hitId ? '#e0e0e0' : '#555',
                  padding: '6px 10px', cursor: ctxMenu.hitId ? 'pointer' : 'not-allowed',
                  fontSize: 12,
                }}
                onMouseEnter={e => ctxMenu.hitId && (e.currentTarget.style.background = '#222')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                ← Extend line to the left
              </button>
              <button
                onClick={() => extendLine(ctxMenu.hitId, 'right')}
                disabled={!ctxMenu.hitId}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  background: 'transparent', border: 'none', borderRadius: 3,
                  color: ctxMenu.hitId ? '#e0e0e0' : '#555',
                  padding: '6px 10px', cursor: ctxMenu.hitId ? 'pointer' : 'not-allowed',
                  fontSize: 12,
                }}
                onMouseEnter={e => ctxMenu.hitId && (e.currentTarget.style.background = '#222')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                Extend line to the right →
              </button>
              <button
                onClick={deleteAllForChart}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  background: 'transparent', border: 'none', borderRadius: 3, color: '#e0e0e0',
                  padding: '6px 10px', cursor: 'pointer', fontSize: 12,
                }}
                onMouseEnter={e => e.currentTarget.style.background = '#222'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                Delete ALL trendlines on this chart ({drawnLines.length})
              </button>
            </div>
          </>
        )}
      </div>
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

function daysBetweenIso(a, b) {
  return (new Date(a + 'T12:00:00Z') - new Date(b + 'T12:00:00Z')) / 86400000;
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
// REVISED 2026-05-03 — three new filters added to eliminate near-horizontal
// "coincidence" lines that aren't visually meaningful trendlines:
//
//  - SWING PIVOT FILTER: only consider bars that are local maxima (high >
//    both 2-bar neighbors on each side) for downtrends, or local minima (low <
//    both 2-bar neighbors) for uptrends. Restricts anchors to actual peaks /
//    valleys instead of arbitrary bars whose values happen to align.
//  - MIN SLOPE: |slope|/mid_price ≥ 0.15%/week. Flatter than that = treat as
//    horizontal S/R (the box detection already covers that case).
//  - ANCHOR PROXIMITY: hi - hk ≥ 10% × hi for downtrend; lk - li ≥ 10% × li for
//    uptrend. P1 and P3 must be visually distinguishable.
const TL_FIT_PCT             = 0.03;   // ±3% — was 1%, too tight for real peaks
const TL_MIN_SPACING_W       = 3;
const TL_BREAK_PCT           = 0.01;
const TL_MAX_LINES_PER_DIR   = 2;
const TL_BROKEN_FADE_W       = 5;
const TL_PIVOT_LOOKAROUND    = 2;
const TL_MIN_SLOPE_PCT_PER_W = 0.0005; // 0.05%/week — catches slow multi-year grinds
const TL_MIN_ANCHOR_GAP_PCT  = 0.10;

function isSwingHigh(weekly, idx, look = TL_PIVOT_LOOKAROUND) {
  const h = weekly[idx].high;
  for (let m = Math.max(0, idx - look); m < idx; m++) if (weekly[m].high >= h) return false;
  for (let m = idx + 1; m <= Math.min(weekly.length - 1, idx + look); m++) if (weekly[m].high >= h) return false;
  return true;
}
function isSwingLow(weekly, idx, look = TL_PIVOT_LOOKAROUND) {
  const l = weekly[idx].low;
  for (let m = Math.max(0, idx - look); m < idx; m++) if (weekly[m].low <= l) return false;
  for (let m = idx + 1; m <= Math.min(weekly.length - 1, idx + look); m++) if (weekly[m].low <= l) return false;
  return true;
}

function computeTrendlines(weekly) {
  const N = weekly.length;
  if (N < 7) return { active: [], broken: [] };

  // Pre-compute swing pivots — anchors are restricted to these
  const swingHighs = [];
  const swingLows  = [];
  for (let i = TL_PIVOT_LOOKAROUND; i < N - TL_PIVOT_LOOKAROUND; i++) {
    if (isSwingHigh(weekly, i)) swingHighs.push(i);
    if (isSwingLow(weekly, i))  swingLows.push(i);
  }

  const downCandidates = [];
  const upCandidates   = [];

  // Downtrends — pair each swing-high with each later swing-high
  for (let a = 0; a < swingHighs.length; a++) {
    for (let b = a + 1; b < swingHighs.length; b++) {
      const i = swingHighs[a], k = swingHighs[b];
      if (k - i < 6) continue;
      const hi = weekly[i].high, hk = weekly[k].high;
      if (hi <= hk) continue;
      // Anchor proximity: P1 and P3 must differ by ≥ TL_MIN_ANCHOR_GAP_PCT
      if ((hi - hk) / hi < TL_MIN_ANCHOR_GAP_PCT) continue;
      const slope = (hk - hi) / (k - i);
      // Min slope: line shouldn't be near-horizontal
      const midPrice = (hi + hk) / 2;
      if (Math.abs(slope) / midPrice < TL_MIN_SLOPE_PCT_PER_W) continue;
      // Need at least one swing high between i and k that fits the line within ±1%
      let foundJ = false;
      for (let c = a + 1; c < b; c++) {
        const j = swingHighs[c];
        if (j - i < TL_MIN_SPACING_W || k - j < TL_MIN_SPACING_W) continue;
        const lineAtJ = hi + slope * (j - i);
        const hj = weekly[j].high;
        if (hj <= hi && hj >= hk && Math.abs(hj - lineAtJ) / lineAtJ <= TL_FIT_PCT) {
          foundJ = true;
          break;
        }
      }
      if (foundJ) downCandidates.push({ i, k, slope, intercept: hi - slope * i });
    }
  }

  // Uptrends — pair each swing-low with each later swing-low
  for (let a = 0; a < swingLows.length; a++) {
    for (let b = a + 1; b < swingLows.length; b++) {
      const i = swingLows[a], k = swingLows[b];
      if (k - i < 6) continue;
      const li = weekly[i].low, lk = weekly[k].low;
      if (li >= lk) continue;
      if ((lk - li) / li < TL_MIN_ANCHOR_GAP_PCT) continue;
      const slope = (lk - li) / (k - i);
      const midPrice = (li + lk) / 2;
      if (Math.abs(slope) / midPrice < TL_MIN_SLOPE_PCT_PER_W) continue;
      let foundJ = false;
      for (let c = a + 1; c < b; c++) {
        const j = swingLows[c];
        if (j - i < TL_MIN_SPACING_W || k - j < TL_MIN_SPACING_W) continue;
        const lineAtJ = li + slope * (j - i);
        const lj = weekly[j].low;
        if (lj >= li && lj <= lk && Math.abs(lj - lineAtJ) / lineAtJ <= TL_FIT_PCT) {
          foundJ = true;
          break;
        }
      }
      if (foundJ) upCandidates.push({ i, k, slope, intercept: li - slope * i });
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
