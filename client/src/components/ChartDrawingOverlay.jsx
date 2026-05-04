// ChartDrawingOverlay — interactive trendline-drawing tool overlay.
//
// Mounts inside a position:relative parent that also contains a Lightweight
// Charts instance. Renders:
//   - A floating ✏️ Draw / Clear button (top-right by default)
//   - A transparent DIV overlay that captures mouse events when in draw mode
//   - An SVG inside the overlay for visual feedback (start dot, temp line,
//     hover preview, endpoint handles for editing)
//   - A right-click context menu (delete this / extend left / extend right /
//     delete all)
//
// User-drawn lines are persisted per-user via /api/test/trendlines and
// rendered as LineSeries on the parent chart. The hourly cron checks them
// for breaks and posts alerts to PNTHR Assistant.
//
// Usage:
//   <div style={{ position: 'relative' }}>
//     <div ref={chartContainerRef} />
//     <ChartDrawingOverlay
//       chartRef={chartRef}
//       seriesRef={barSeriesRef}
//       weeklyBars={visibleSliceArray}
//       ticker="AAPL"
//       enabled={isAdmin}
//     />
//   </div>

import { useEffect, useRef, useState } from 'react';
import { LineSeries } from 'lightweight-charts';
import { API_BASE, authHeaders } from '../services/api';

function daysBetweenIso(a, b) {
  return (new Date(a + 'T12:00:00Z') - new Date(b + 'T12:00:00Z')) / 86400000;
}

// Color rule: black for horizontal (kind='horizontal' or v1≈v2), green for
// uptrends (v2>v1, since t2>t1 always), red for downtrends.
const COLOR_UP = '#26a69a';
const COLOR_DOWN = '#ef5350';
const COLOR_HORIZ = '#000000';
function lineColor(ln) {
  if (ln.kind === 'horizontal' || Math.abs(ln.v2 - ln.v1) < 0.01) return COLOR_HORIZ;
  return ln.v2 > ln.v1 ? COLOR_UP : COLOR_DOWN;
}

export default function ChartDrawingOverlay({
  chartRef,
  seriesRef,
  weeklyBars,                       // sorted [{weekOf, open, high, low, close}]
  ticker,
  enabled = true,
  buttonPosition = 'top-right',     // 'top-right' | 'top-left'
}) {
  const overlayRef        = useRef(null);
  const drawnSeriesRef    = useRef([]);
  const drawStartRef      = useRef(null);
  const editingRef        = useRef(null);
  const windowHandlersRef = useRef(null);

  const [drawMode, setDrawMode]     = useState(null);   // null | 'free' | 'horizontal'
  const [drawnLines, setDrawnLines] = useState([]);
  const [tempLine, setTempLine]     = useState(null);
  const [hoverSnap, setHoverSnap]   = useState(null);
  const [ctxMenu, setCtxMenu]       = useState(null);
  const [bodyDragLineId, setBodyDragLineId] = useState(null); // hide original line series while body-dragging
  const isDrawing = drawMode != null;

  // Keep weeklyBars accessible from event handlers without re-binding
  const sliceRef = useRef(weeklyBars);
  useEffect(() => { sliceRef.current = weeklyBars; }, [weeklyBars]);

  // Load existing trendlines on mount / ticker change
  useEffect(() => {
    if (!enabled || !ticker) return;
    let cancelled = false;
    fetch(`${API_BASE}/api/test/trendlines?ticker=${ticker}`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => { if (!cancelled) setDrawnLines(d.trendlines || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [ticker, enabled]);

  // Render drawn lines as LineSeries on the chart
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const s of drawnSeriesRef.current) {
      try { chart.removeSeries(s); } catch { /* chart may have been disposed */ }
    }
    drawnSeriesRef.current = [];
    for (const ln of drawnLines) {
      // Hide the line being body-dragged — the temp line shows its new position
      if (ln._id === bodyDragLineId) continue;
      const s = chart.addSeries(LineSeries, {
        color: lineColor(ln), lineWidth: 2,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        autoscaleInfoProvider: () => null,
      });
      // For horizontal lines, force v2 = v1 so screen rendering is exactly flat
      const v2render = (ln.kind === 'horizontal') ? ln.v1 : ln.v2;
      s.setData([
        { time: ln.t1, value: ln.v1 },
        { time: ln.t2, value: v2render },
      ]);
      drawnSeriesRef.current.push(s);
    }
  }, [drawnLines, chartRef, bodyDragLineId]);

  // ── Snap helpers ──
  function snapAt(clientX, clientY) {
    const chart = chartRef.current, series = seriesRef.current, slice = sliceRef.current;
    if (!chart || !series || !slice?.length || !overlayRef.current) return null;
    const rect = overlayRef.current.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
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
    const snapHigh = Math.abs(priceAtY - bestBar.high) <= Math.abs(priceAtY - bestBar.low);
    const snappedPrice = snapHigh ? bestBar.high : bestBar.low;
    const snappedY = series.priceToCoordinate(snappedPrice);
    return { time: bestBar.weekOf, value: snappedPrice, x: bestPx, y: snappedY, snapHigh };
  }

  function computeExpectSide(t1, v1, t2, v2) {
    const slice = sliceRef.current;
    if (!slice || slice.length === 0) return 'above';
    const lastBar = slice[slice.length - 1];
    const slope = (v2 - v1) / Math.max(1, daysBetweenIso(t2, t1));
    const lineAtLast = v1 + slope * daysBetweenIso(lastBar.weekOf, t1);
    return lineAtLast >= lastBar.close ? 'above' : 'below';
  }

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

  // Hit-test the BODY of any drawn line (between the two endpoints, not on
  // them). Returns {lineId, x1, x2, lineY} or null. Used for two purposes:
  //   - Body-drag: left-click on a horizontal line's body slides it up/down
  //   - Right-click context menu: identifies which line the menu applies to
  // Distance from cursor to a line segment is computed in screen pixels.
  function findBodyHit(clientX, clientY) {
    const chart = chartRef.current, series = seriesRef.current;
    if (!chart || !series || !overlayRef.current) return null;
    const rect = overlayRef.current.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    const HIT_TOL_PX = 6;     // perpendicular distance to line counts as a hit
    const ENDPOINT_BUFFER = 10;  // skip body hit if cursor is on an endpoint
    let best = null, bestD = Infinity;
    for (const ln of drawnLines) {
      const x1 = chart.timeScale().timeToCoordinate(ln.t1);
      const x2 = chart.timeScale().timeToCoordinate(ln.t2);
      const y1 = series.priceToCoordinate(ln.v1);
      const y2render = (ln.kind === 'horizontal') ? ln.v1 : ln.v2;
      const y2 = series.priceToCoordinate(y2render);
      if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
      // Skip if cursor is within endpoint hit-radius (endpoints take priority)
      if (Math.hypot(x1 - x, y1 - y) <= ENDPOINT_BUFFER) continue;
      if (Math.hypot(x2 - x, y2 - y) <= ENDPOINT_BUFFER) continue;
      // Perpendicular distance from point to line segment
      const d = pointToSegmentDistance(x, y, x1, y1, x2, y2);
      if (d <= HIT_TOL_PX && d < bestD) {
        bestD = d;
        best = { lineId: ln._id, x1, x2, y1, y2, isHoriz: ln.kind === 'horizontal' || Math.abs(ln.v2 - ln.v1) < 0.01 };
      }
    }
    return best;
  }

  function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const projX = x1 + t * dx, projY = y1 + t * dy;
    return Math.hypot(px - projX, py - projY);
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
  useEffect(() => () => detachWindowDragListeners(), []);

  function onDrawDown(e) {
    if (!isDrawing) return;
    e.preventDefault();
    // 1) Endpoint grab — highest priority (within 10px of an endpoint handle)
    const grab = findEndpointHit(e.clientX, e.clientY);
    if (grab) {
      const chart = chartRef.current, series = seriesRef.current;
      const xOther = chart.timeScale().timeToCoordinate(grab.otherTime);
      const yOther = series.priceToCoordinate(grab.otherVal);
      editingRef.current = { ...grab, kind: 'endpoint' };
      const rect = overlayRef.current.getBoundingClientRect();
      setTempLine({ x1: xOther, y1: yOther, x2: e.clientX - rect.left, y2: e.clientY - rect.top });
      setHoverSnap(null);
      attachWindowDragListeners();
      return;
    }
    // 2) Body hit — slide a horizontal line up/down (or in future, parallel
    //    translate any line). For now, only horizontal lines support sliding.
    const body = findBodyHit(e.clientX, e.clientY);
    if (body && body.isHoriz) {
      const rect = overlayRef.current.getBoundingClientRect();
      const cursorY = e.clientY - rect.top;
      editingRef.current = { kind: 'body', lineId: body.lineId };
      setBodyDragLineId(body.lineId);
      setTempLine({ x1: body.x1, y1: cursorY, x2: body.x2, y2: cursorY });
      setHoverSnap(null);
      attachWindowDragListeners();
      return;
    }
    // 3) New line draw
    const snap = snapAt(e.clientX, e.clientY);
    if (!snap) return;
    drawStartRef.current = snap;
    setTempLine({ x1: snap.x, y1: snap.y, x2: snap.x, y2: snap.y });
    setHoverSnap(null);
    attachWindowDragListeners();
  }

  function onDrawMove(e) {
    if (!isDrawing || !overlayRef.current) return;
    const rect = overlayRef.current.getBoundingClientRect();
    const cursorX = e.clientX - rect.left;
    const cursorY = e.clientY - rect.top;
    const isHoriz = drawMode === 'horizontal';
    if (drawStartRef.current) {
      // Horizontal mode: lock y2 to start's y so the temp line is flat
      setTempLine({
        x1: drawStartRef.current.x,
        y1: drawStartRef.current.y,
        x2: cursorX,
        y2: isHoriz ? drawStartRef.current.y : cursorY,
      });
    } else if (editingRef.current?.kind === 'body') {
      // Body-drag (horizontal slide): keep line flat, follow cursor y
      setTempLine(prev => prev ? { x1: prev.x1, y1: cursorY, x2: prev.x2, y2: cursorY } : null);
    } else if (editingRef.current) {
      setTempLine(prev => prev ? { x1: prev.x1, y1: prev.y1, x2: cursorX, y2: cursorY } : null);
    } else {
      const snap = snapAt(e.clientX, e.clientY);
      setHoverSnap(snap ? { x: snap.x, y: snap.y, snapHigh: snap.snapHigh } : null);
    }
  }

  async function onDrawUp(e) {
    if (!isDrawing) return;
    // Body-drag (horizontal slide) — convert release y to a price, snap to
    // the nearest visible bar's high/low, persist new v1=v2.
    if (editingRef.current?.kind === 'body') {
      const edit = editingRef.current;
      const series = seriesRef.current;
      const rect = overlayRef.current.getBoundingClientRect();
      const cursorY = e.clientY - rect.top;
      editingRef.current = null;
      setTempLine(null);
      setBodyDragLineId(null);
      const releasePrice = series ? series.coordinateToPrice(cursorY) : null;
      if (releasePrice == null || releasePrice < 0) return;
      // Snap to nearest visible bar's high or low (typical S/R alignment)
      const slice = sliceRef.current;
      let bestVal = releasePrice, bestDist = Infinity;
      for (const b of slice) {
        for (const candidate of [b.high, b.low]) {
          const d = Math.abs(candidate - releasePrice);
          if (d < bestDist) { bestDist = d; bestVal = candidate; }
        }
      }
      const newPrice = +bestVal.toFixed(2);
      const ln = drawnLines.find(l => l._id === edit.lineId);
      if (!ln) return;
      const expectSide = computeExpectSide(ln.t1, newPrice, ln.t2, newPrice);
      setDrawnLines(prev => prev.map(l => l._id === edit.lineId
        ? { ...l, v1: newPrice, v2: newPrice, expectSide }
        : l));
      if (!String(edit.lineId).startsWith('pending-')) {
        try {
          await fetch(`${API_BASE}/api/test/trendlines/${edit.lineId}`, {
            method: 'PATCH',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ t1: ln.t1, v1: newPrice, t2: ln.t2, v2: newPrice, expectSide }),
          });
        } catch (err) { console.error('slide trendline failed', err); }
      }
      return;
    }
    if (editingRef.current) {
      const edit = editingRef.current;
      const snap = snapAt(e.clientX, e.clientY);
      editingRef.current = null;
      setTempLine(null);
      if (!snap) return;
      const isStart = edit.endpoint === 'start';
      const newT1 = isStart ? snap.time : edit.otherTime;
      const newV1 = isStart ? snap.value : edit.otherVal;
      const newT2 = isStart ? edit.otherTime : snap.time;
      const newV2 = isStart ? edit.otherVal : snap.value;
      if (newT1 === newT2) return;
      const expectSide = computeExpectSide(newT1, newV1, newT2, newV2);
      setDrawnLines(prev => prev.map(l => l._id === edit.lineId
        ? { ...l, t1: newT1, v1: newV1, t2: newT2, v2: newV2, expectSide }
        : l));
      try {
        await fetch(`${API_BASE}/api/test/trendlines/${edit.lineId}`, {
          method: 'PATCH',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ t1: newT1, v1: newV1, t2: newT2, v2: newV2, expectSide }),
        });
      } catch (err) { console.error('PATCH trendline failed', err); }
      return;
    }
    if (!drawStartRef.current) return;
    const start = drawStartRef.current;
    const end = snapAt(e.clientX, e.clientY);
    const isHoriz = drawMode === 'horizontal';
    drawStartRef.current = null;
    setTempLine(null);
    if (!end || end.time === start.time) return;
    const [a, b] = start.time < end.time ? [start, end] : [end, start];
    // Horizontal lines: force both y-values to the original click's value
    // (whichever bar that was, regardless of time-order swap).
    const v1 = isHoriz ? start.value : a.value;
    const v2 = isHoriz ? start.value : b.value;
    const kind = isHoriz ? 'horizontal' : 'free';
    const expectSide = computeExpectSide(a.time, v1, b.time, v2);
    const payload = { ticker, t1: a.time, v1, t2: b.time, v2, expectSide, kind };
    setDrawnLines(prev => [...prev, { ...payload, _id: 'pending-' + Date.now() }]);
    try {
      const r = await fetch(`${API_BASE}/api/test/trendlines`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (j.ok) {
        setDrawnLines(prev => prev.map(l => l._id?.startsWith?.('pending-') && l.t1 === payload.t1 && l.t2 === payload.t2 ? { ...l, _id: j._id } : l));
      }
    } catch (err) { console.error('save trendline failed', err); }
  }

  function onContextMenu(e) {
    e.preventDefault();
    if (drawnLines.length === 0) return;
    // Try endpoint first (10px tolerance), then body (6px perpendicular)
    const endpointHit = findEndpointHit(e.clientX, e.clientY);
    const bodyHit     = endpointHit ? null : findBodyHit(e.clientX, e.clientY);
    const hitId = endpointHit?.lineId || bodyHit?.lineId || null;
    const rect = overlayRef.current.getBoundingClientRect();
    setCtxMenu({ x: e.clientX - rect.left, y: e.clientY - rect.top, hitId });
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

  // Toggle alert on/off for a specific line. Server cron only checks lines
  // where alertEnabled !== false (legacy lines without the field are treated
  // as enabled for backward compat).
  async function toggleLineAlert(lineId) {
    const ln = drawnLines.find(l => l._id === lineId);
    if (!ln) return;
    // Default missing field → true (legacy lines were on); toggle from there
    const currentlyOn = ln.alertEnabled !== false;
    const newValue = !currentlyOn;
    setDrawnLines(prev => prev.map(l => l._id === lineId ? { ...l, alertEnabled: newValue } : l));
    setCtxMenu(null);
    if (lineId && !String(lineId).startsWith('pending-')) {
      try {
        await fetch(`${API_BASE}/api/test/trendlines/${lineId}`, {
          method: 'PATCH',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ alertEnabled: newValue }),
        });
      } catch (err) { console.error('toggle alert failed', err); }
    }
  }

  async function extendLine(lineId, direction) {
    const slice = sliceRef.current;
    if (!slice || slice.length === 0) return;
    const ln = drawnLines.find(l => l._id === lineId);
    if (!ln) return;
    const slope = (ln.v2 - ln.v1) / Math.max(1, daysBetweenIso(ln.t2, ln.t1));
    function clampAtZero(targetT, anchorT, anchorV) {
      let newV = anchorV + slope * daysBetweenIso(targetT, anchorT);
      let newT = targetT;
      if (newV < 0 && slope !== 0) {
        const daysToZero = -anchorV / slope;
        const zeroMs = new Date(anchorT + 'T12:00:00Z').getTime() + daysToZero * 86400000;
        newT = new Date(zeroMs).toISOString().slice(0, 10);
        newV = 0;
      }
      return { newT, newV: +newV.toFixed(2) };
    }
    let updated;
    if (direction === 'left') {
      const { newT, newV } = clampAtZero(slice[0].weekOf, ln.t1, ln.v1);
      updated = { ...ln, t1: newT, v1: newV };
    } else {
      const { newT, newV } = clampAtZero(slice[slice.length - 1].weekOf, ln.t2, ln.v2);
      updated = { ...ln, t2: newT, v2: newV };
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

  if (!enabled) return null;

  const buttonStyle = (active) => ({
    background: active ? '#fcf000' : 'rgba(20,20,20,0.85)',
    color: active ? '#000' : '#fcf000',
    border: '1px solid #fcf000', borderRadius: 4,
    padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', gap: 4,
  });

  return (
    <>
      {/* Floating button stack: Draw, Horizontal, Clear (shown when ≥1 line) */}
      <div style={{
        position: 'absolute', top: 6,
        [buttonPosition === 'top-right' ? 'right' : 'left']: 6,
        zIndex: 12,
        display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start',
      }}>
        <button
          onClick={() => setDrawMode(prev => prev === 'free' ? null : 'free')}
          style={buttonStyle(drawMode === 'free')}
          title="Free-form trendline (any direction)"
        >
          ✏️ {drawMode === 'free' ? 'Drawing' : 'Draw'}
        </button>
        <button
          onClick={() => setDrawMode(prev => prev === 'horizontal' ? null : 'horizontal')}
          style={buttonStyle(drawMode === 'horizontal')}
          title="Horizontal line — locks the second click to the same price level as the first"
        >
          ─ {drawMode === 'horizontal' ? 'Horizontal' : 'Horizontal'}
        </button>
        {drawnLines.length > 0 && (
          <button onClick={deleteAllForChart} style={buttonStyle(false)}>
            Clear ({drawnLines.length})
          </button>
        )}
      </div>

      {/* Drawing overlay — captures events only when a draw mode is active */}
      <div
        ref={overlayRef}
        onMouseDown={onDrawDown}
        onMouseMove={onDrawMove}
        onMouseUp={onDrawUp}
        onMouseLeave={() => {
          if (!drawStartRef.current && !editingRef.current) setHoverSnap(null);
        }}
        onContextMenu={onContextMenu}
        onWheel={(e) => { if (isDrawing) e.preventDefault(); }}
        style={{
          position: 'absolute', inset: 0, width: '100%', height: '100%',
          pointerEvents: (isDrawing || drawnLines.length > 0) ? 'auto' : 'none',
          cursor: isDrawing ? 'crosshair' : 'default',
          zIndex: 10,
          background: isDrawing ? 'rgba(252,240,0,0.04)' : 'transparent',
          border: isDrawing ? '1px dashed rgba(252,240,0,0.5)' : 'none',
        }}
      >
        <svg width="100%" height="100%" style={{ pointerEvents: 'none', display: 'block' }}>
          {isDrawing && drawnLines.map(ln => {
            const chart = chartRef.current, series = seriesRef.current;
            if (!chart || !series) return null;
            const x1 = chart.timeScale().timeToCoordinate(ln.t1);
            const y1 = series.priceToCoordinate(ln.v1);
            const x2 = chart.timeScale().timeToCoordinate(ln.t2);
            const y2 = series.priceToCoordinate((ln.kind === 'horizontal') ? ln.v1 : ln.v2);
            const handleFill = lineColor(ln);
            const alertOn = ln.alertEnabled !== false; // legacy lines treated as on
            return (
              <g key={ln._id}>
                {x1 != null && y1 != null && (
                  <circle cx={x1} cy={y1} r="6" fill={handleFill} stroke="#000" strokeWidth="1.5" />
                )}
                {x2 != null && y2 != null && (
                  <circle cx={x2} cy={y2} r="6" fill={handleFill} stroke="#000" strokeWidth="1.5" />
                )}
                {/* Bell indicator: shows next to start endpoint when alert
                    is enabled on this line. Subtle so it doesn't clutter. */}
                {alertOn && x1 != null && y1 != null && (
                  <text x={x1 + 9} y={y1 + 4} fontSize="11" pointerEvents="none">🔔</text>
                )}
              </g>
            );
          })}
          {isDrawing && hoverSnap && !tempLine && (
            <>
              <circle cx={hoverSnap.x} cy={hoverSnap.y} r="6" fill="none" stroke="#fcf000" strokeWidth="1.5" strokeDasharray="2 2" />
              <text x={hoverSnap.x + 10} y={hoverSnap.y - 8} fill="#fcf000" fontSize="10" fontFamily="monospace">
                {hoverSnap.snapHigh ? 'high' : 'low'}
              </text>
            </>
          )}
          {tempLine && (() => {
            // Color the temp line by direction so user previews red/green/black
            const tempStroke = drawMode === 'horizontal' ? COLOR_HORIZ
              : tempLine.y2 < tempLine.y1 ? COLOR_UP   // cursor higher on screen = higher price
              : tempLine.y2 > tempLine.y1 ? COLOR_DOWN
              : COLOR_HORIZ;
            return (
              <>
                <line x1={tempLine.x1} y1={tempLine.y1} x2={tempLine.x2} y2={tempLine.y2} stroke={tempStroke} strokeWidth="2" strokeDasharray="4 3" />
                <circle cx={tempLine.x1} cy={tempLine.y1} r="5" fill={tempStroke} stroke="#000" strokeWidth="1" />
              </>
            );
          })()}
        </svg>
      </div>

      {/* Right-click context menu */}
      {ctxMenu && (
        <>
          <div onClick={() => setCtxMenu(null)} style={{ position: 'fixed', inset: 0, zIndex: 99 }} />
          <div style={{
            position: 'absolute', left: ctxMenu.x, top: ctxMenu.y, zIndex: 100,
            background: '#0a0a0a', border: '1px solid #444', borderRadius: 4,
            padding: 4, fontSize: 12, color: '#e0e0e0',
            minWidth: 220, boxShadow: '0 4px 12px rgba(0,0,0,0.6)',
          }}>
            <CtxBtn onClick={() => deleteOne(ctxMenu.hitId)} disabled={!ctxMenu.hitId}>
              Delete this trendline {ctxMenu.hitId ? '' : '(none under cursor)'}
            </CtxBtn>
            <CtxBtn onClick={() => toggleLineAlert(ctxMenu.hitId)} disabled={!ctxMenu.hitId}>
              {(() => {
                const ln = drawnLines.find(l => l._id === ctxMenu.hitId);
                const on = ln?.alertEnabled !== false;
                return on ? '🔕 Disable alert on this trendline' : '🔔 Set alert on this trendline';
              })()}
            </CtxBtn>
            <CtxBtn onClick={() => extendLine(ctxMenu.hitId, 'left')} disabled={!ctxMenu.hitId}>
              ← Extend line to the left
            </CtxBtn>
            <CtxBtn onClick={() => extendLine(ctxMenu.hitId, 'right')} disabled={!ctxMenu.hitId}>
              Extend line to the right →
            </CtxBtn>
            <CtxBtn onClick={deleteAllForChart}>
              Delete ALL trendlines on this chart ({drawnLines.length})
            </CtxBtn>
          </div>
        </>
      )}
    </>
  );
}

function CtxBtn({ children, onClick, disabled = false }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        background: 'transparent', border: 'none', borderRadius: 3,
        // Bumped disabled color from #555 (unreadable on dark bg) to a
        // muted-but-legible tone. Enabled stays bright white.
        color: disabled ? '#9a9a9a' : '#ffffff',
        padding: '6px 10px', cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: 12,
      }}
      onMouseEnter={e => !disabled && (e.currentTarget.style.background = '#2a2a2a')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      {children}
    </button>
  );
}
