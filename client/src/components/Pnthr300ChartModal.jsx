import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { createChart, BarSeries, CandlestickSeries, LineSeries, createSeriesMarkers } from 'lightweight-charts';
import { fetchPnthrAi300Latest, fetchPnthrAi300Bars } from '../services/api';
import { useAuth } from '../AuthContext';
import ChartDrawingOverlay from './ChartDrawingOverlay';
import { detectAllSignals } from '../utils/signalDetection';
import pantherHead from '../assets/panther head.png';

// Pnthr300ChartModal — dedicated chart for the PNTHR AI 300 (PAI300).
//
// OHLC bars (default) / candlesticks toggle. Daily / weekly toggle. OpEMA
// overlay (20W tuned to ride own historical pullbacks, 21D for now).
// Crosshair OHLC tooltip + horizontal-line drawing tool (admin) reusing
// the same overlay component the 679 ChartModal uses.

function fmtNum(n) {
  if (n == null) return '—';
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(n) {
  if (n == null) return '—';
  const s = n >= 0 ? '+' : '';
  return `${s}${n.toFixed(2)}%`;
}

export default function Pnthr300ChartModal({ onClose, embedded = false, toolbarRef }) {
  const { isAdmin } = useAuth();

  const [timeframe, setTimeframe]   = useState('weekly');
  const [chartType, setChartType]   = useState('bars');   // 'bars' | 'candles'
  const [latest, setLatest]         = useState(null);
  const [bars, setBars]             = useState([]);
  const [emaPeriod, setEmaPeriod]   = useState(20);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [hoveredBar, setHoveredBar] = useState(null);
  const [barsTick, setBarsTick]     = useState(0);
  const [barSpacing, setBarSpacing] = useState(12);  // px between bars (+4 wider default per Scott)
  const [showAllSignals, setShowAllSignals] = useState(false);
  const [portalReady, setPortalReady] = useState(false);
  const [overlayDrawMode, setOverlayDrawMode] = useState(null);
  const [overlayLineCount, setOverlayLineCount] = useState(0);
  useEffect(() => { if (toolbarRef?.current) setPortalReady(true); }, [toolbarRef]);

  const containerRef    = useRef(null);
  const rsiContainerRef = useRef(null);
  const chartRef        = useRef(null);
  const rsiChartRef     = useRef(null);
  const priceSeriesRef  = useRef(null);
  const visibleBarsRef  = useRef([]);
  const drawOverlayRef  = useRef(null);
  const barSpacingRef   = useRef(barSpacing);
  useEffect(() => { barSpacingRef.current = barSpacing; }, [barSpacing]);

  // Imperative spacing adjuster — applies to the live chart without triggering
  // a full re-render. Clamped to [2, 40] so bars stay readable at extremes.
  function adjustBarSpacing(delta) {
    setBarSpacing(prev => {
      const next = Math.max(2, Math.min(40, prev + delta));
      chartRef.current?.timeScale().applyOptions({ barSpacing: next });
      rsiChartRef.current?.timeScale().applyOptions({ barSpacing: next });
      return next;
    });
  }

  // Latest snapshot (for header summary) — 30s silent auto-refresh
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchPnthrAi300Latest()
        .then(d => { if (!cancelled) setLatest(d); })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Bars on mount + when timeframe changes; silent 30s auto-refresh keeps
  // today's intraday bar (spliced in by getPnthrAi300Bars overlay) live.
  useEffect(() => {
    let cancelled = false;
    const load = (silent) => {
      if (!silent) { setLoading(true); setError(null); }
      fetchPnthrAi300Bars(timeframe)
        .then(d => {
          if (cancelled) return;
          if (!d.ok || !d.bars?.length) { if (!silent) { setError('No data'); setBars([]); } return; }
          setBars(d.bars);
          setEmaPeriod(d.emaPeriod);
        })
        .catch(e => { if (!cancelled && !silent) setError(e.message || 'Failed to load'); })
        .finally(() => { if (!cancelled && !silent) setLoading(false); });
    };
    load(false);
    const id = setInterval(() => load(true), 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, [timeframe]);

  // Compute RSI(14) series from bar closes
  function computeRsiSeries(closes) {
    const out = [];
    if (closes.length < 15) return out;
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= 14; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
    }
    avgGain /= 14; avgLoss /= 14;
    out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    for (let i = 15; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      avgGain = (avgGain * 13 + Math.max(d, 0)) / 14;
      avgLoss = (avgLoss * 13 + Math.max(-d, 0)) / 14;
      out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    }
    return out;
  }

  // Simple EMA over a value series (seeded on the first value). Used for the dotted
  // 10-period reference line — the short-term sector trend, visual only (not a trading gate).
  function computeEma(values, period) {
    if (!values.length) return [];
    const k = 2 / (period + 1);
    const out = [values[0]];
    for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
    return out;
  }

  // Chart render
  useEffect(() => {
    if (!containerRef.current || !rsiContainerRef.current || bars.length === 0) return;

    // ── Main price chart ──
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: { background: { color: '#0c0c0c' }, textColor: '#d4d4d4', attributionLogo: false },
      grid: { vertLines: { color: '#1f1f1f' }, horzLines: { color: '#1f1f1f' } },
      rightPriceScale: { borderColor: '#333' },
      timeScale: { borderColor: '#333', timeVisible: timeframe === 'daily', barSpacing: barSpacingRef.current },
      crosshair: { mode: 1 },
    });
    chartRef.current = chart;

    const priceSeries = chartType === 'candles'
      ? chart.addSeries(CandlestickSeries, {
          upColor: '#16a34a', downColor: '#dc2626',
          borderUpColor: '#16a34a', borderDownColor: '#dc2626',
          wickUpColor: '#16a34a', wickDownColor: '#dc2626',
          priceLineVisible: false,
        })
      : chart.addSeries(BarSeries, {
          upColor: '#16a34a', downColor: '#dc2626',
          priceLineVisible: false, lastValueVisible: true,
          openVisible: true, thinBars: false,
        });
    priceSeriesRef.current = priceSeries;

    const ema = chart.addSeries(LineSeries, {
      color: '#fcf000', lineWidth: 2,
      priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false,
    });

    priceSeries.setData(bars.map(b => ({
      time: b.date, open: b.open, high: b.high, low: b.low, close: b.close,
    })));
    ema.setData(bars.filter(b => b.ema != null).map(b => ({ time: b.date, value: b.ema })));

    // Dotted 10-period EMA — reference line for the sector's short-term trend. Cool color so it
    // reads as distinct from the solid yellow OpEMA. Visual only; NOT a trading gate (see the
    // regime study — a 10-EMA entry gate didn't survive executable testing).
    const ema10 = chart.addSeries(LineSeries, {
      color: '#38bdf8', lineWidth: 1, lineStyle: 1,   // lineStyle 1 = Dotted
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    const ema10Vals = computeEma(bars.map(b => b.close), 10);
    ema10.setData(bars.map((b, i) => ({ time: b.date, value: +ema10Vals[i].toFixed(2) })).slice(10));

    // Signal markers — default: last signal only; toggle shows all
    const sigBars = bars.map(b => ({ time: b.date, open: b.open, high: b.high, low: b.low, close: b.close }));
    const { events: sigEvents } = detectAllSignals(sigBars, emaPeriod, true);
    if (sigEvents.length > 0) {
      let visibleEvents = sigEvents;
      if (!showAllSignals) {
        // Walk backward to find the last entry (BL or SS), show from there
        let lastEntryIdx = -1;
        for (let i = sigEvents.length - 1; i >= 0; i--) {
          if (sigEvents[i].signal === 'BL' || sigEvents[i].signal === 'SS') { lastEntryIdx = i; break; }
        }
        visibleEvents = lastEntryIdx >= 0 ? sigEvents.slice(lastEntryIdx) : [];
      }
      if (visibleEvents.length > 0) {
        const markers = visibleEvents.map(ev => {
          let color, position, shape, text;
          if (ev.signal === 'BL')      { color = '#16a34a'; position = 'belowBar'; shape = 'arrowUp';   text = 'BL'; }
          else if (ev.signal === 'SS') { color = '#dc2626'; position = 'aboveBar'; shape = 'arrowDown'; text = 'SS'; }
          else if (ev.signal === 'BE') { color = '#f59e0b'; position = 'aboveBar'; shape = 'square';    text = 'BE'; }
          else if (ev.signal === 'SE') { color = '#f59e0b'; position = 'belowBar'; shape = 'square';    text = 'SE'; }
          return { time: ev.time, position, color, shape, text, size: 1 };
        });
        createSeriesMarkers(priceSeries, markers);
      }
    }

    // ── RSI sub-chart ──
    const rsiChart = createChart(rsiContainerRef.current, {
      autoSize: true,
      layout: { background: { color: '#0c0c0c' }, textColor: '#d4d4d4', attributionLogo: false },
      grid: { vertLines: { color: '#1f1f1f' }, horzLines: { color: '#1f1f1f' } },
      rightPriceScale: { borderColor: '#333', scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale: { borderColor: '#333', timeVisible: timeframe === 'daily', barSpacing: barSpacingRef.current, visible: false },
      crosshair: { mode: 1 },
    });
    rsiChartRef.current = rsiChart;

    const closes = bars.map(b => b.close);
    const rsiVals = computeRsiSeries(closes);
    const rsiStartIdx = bars.length - rsiVals.length;

    const rsiLine = rsiChart.addSeries(LineSeries, {
      color: '#D4A017', lineWidth: 2,
      priceLineVisible: true, lastValueVisible: true, crosshairMarkerVisible: true,
    });
    // Whitespace-pad the warm-up bars so the RSI pane has the SAME bar count and
    // time domain as the price pane. With identical logical indices, a given date
    // maps to the same x on both panes and the crosshair lines up exactly — the
    // 14-fewer-bars mismatch was drifting the RSI crosshair 1-2 bars to the right.
    const rsiData = bars.map((b, i) =>
      i < rsiStartIdx
        ? { time: b.date }
        : { time: b.date, value: parseFloat(rsiVals[i - rsiStartIdx].toFixed(1)) }
    );
    rsiLine.setData(rsiData);

    // Build date→RSI lookup for crosshair tooltip
    const rsiByDate = {};
    rsiData.forEach(d => { rsiByDate[d.time] = d.value; });

    // Overbought (70) / Oversold (30) reference lines
    const rsi70 = rsiChart.addSeries(LineSeries, {
      color: '#dc3545', lineWidth: 1, lineStyle: 2,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    const rsi30 = rsiChart.addSeries(LineSeries, {
      color: '#28a745', lineWidth: 1, lineStyle: 2,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    const lastBarDate = bars[bars.length - 1].date;
    if (bars.length >= 2) {
      // Span the full pane (first bar → last) so the 70/30 guides run edge-to-edge,
      // matching the now-aligned time axis.
      const first = bars[0].date;
      rsi70.setData([{ time: first, value: 70 }, { time: lastBarDate, value: 70 }]);
      rsi30.setData([{ time: first, value: 30 }, { time: lastBarDate, value: 30 }]);
    }

    // Sync time scales using time-based range (not logical index — RSI has
    // 14 fewer bars so logical indices are offset between the two charts).
    let syncing = false;
    const syncFromMain = () => {
      if (syncing) return;
      syncing = true;
      try {
        const range = chart.timeScale().getVisibleRange();
        if (range) rsiChart.timeScale().setVisibleRange(range);
      } catch (_) {}
      syncing = false;
    };
    const syncFromRsi = () => {
      if (syncing) return;
      syncing = true;
      try {
        const range = rsiChart.timeScale().getVisibleRange();
        if (range) chart.timeScale().setVisibleRange(range);
      } catch (_) {}
      syncing = false;
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(syncFromMain);
    rsiChart.timeScale().subscribeVisibleLogicalRangeChange(syncFromRsi);

    // Initial sync — force RSI chart to match main chart on first render
    requestAnimationFrame(() => {
      try {
        const range = chart.timeScale().getVisibleRange();
        if (range) rsiChart.timeScale().setVisibleRange(range);
      } catch (_) {}
    });

    // Price lookup for reverse crosshair sync (RSI chart → price chart)
    const priceByDate = {};
    bars.forEach(b => { priceByDate[b.date] = b.close; });

    // Snapshot bars for drawing overlay
    visibleBarsRef.current = bars.map(b => ({
      weekOf: b.date, open: b.open, high: b.high, low: b.low, close: b.close,
    }));
    setBarsTick(t => t + 1);

    // Crosshair sync: price chart → RSI chart + tooltip
    let destroyed = false;
    let crosshairSyncing = false;
    chart.subscribeCrosshairMove(param => {
      if (destroyed || crosshairSyncing) return;
      crosshairSyncing = true;
      const data = param?.seriesData?.get(priceSeries);
      if (!param?.time || !param?.point || !data) {
        setHoveredBar(null);
        rsiChart.clearCrosshairPosition();
        crosshairSyncing = false;
        return;
      }
      const emaData = param.seriesData?.get(ema);
      const ema10Data = param.seriesData?.get(ema10);
      const rsiVal = rsiByDate[param.time] ?? null;
      setHoveredBar({
        x: param.point.x, y: param.point.y,
        time: param.time,
        open: data.open, high: data.high, low: data.low, close: data.close,
        ema: emaData?.value ?? null,
        ema10: ema10Data?.value ?? null,
        rsi: rsiVal,
      });
      if (rsiVal != null) {
        rsiChart.setCrosshairPosition(rsiVal, param.time, rsiLine);
      } else {
        rsiChart.clearCrosshairPosition();
      }
      crosshairSyncing = false;
    });

    // Crosshair sync: RSI chart → price chart
    rsiChart.subscribeCrosshairMove(param => {
      if (destroyed || crosshairSyncing) return;
      crosshairSyncing = true;
      if (!param?.time) {
        chart.clearCrosshairPosition();
        setHoveredBar(null);
        crosshairSyncing = false;
        return;
      }
      const price = priceByDate[param.time];
      if (price != null) {
        chart.setCrosshairPosition(price, param.time, priceSeries);
      }
      crosshairSyncing = false;
    });

    return () => {
      destroyed = true;
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(syncFromMain);
      rsiChart.timeScale().unsubscribeVisibleLogicalRangeChange(syncFromRsi);
      chart.remove(); rsiChart.remove();
      chartRef.current = null; rsiChartRef.current = null; priceSeriesRef.current = null;
    };
  }, [bars, timeframe, emaPeriod, chartType, showAllSignals]);

  const dayChange = latest?.dayChangePct;
  const dayChangeColor = dayChange == null ? '#888' : dayChange >= 0 ? '#16a34a' : '#dc2626';
  const regimeColor = latest?.regime === 'bull' ? '#16a34a' : '#dc2626';

  // Pretty change-vs-previous-bar pct for the tooltip
  const hoveredChangePct = (() => {
    if (!hoveredBar) return null;
    const o = hoveredBar.open, c = hoveredBar.close;
    if (!o) return null;
    return ((c - o) / o) * 100;
  })();

  const toolbarControls = (
    <>
      {isAdmin && (
        <button
          onClick={() => setShowAllSignals(v => !v)}
          style={{
            padding: '6px 12px', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
            background: showAllSignals ? '#fcf000' : 'transparent',
            color: showAllSignals ? '#000' : '#888',
            border: '1px solid #2a2a2a', borderRadius: 4, cursor: 'pointer',
            textTransform: 'uppercase',
          }}
          title={showAllSignals ? 'Showing all signals — click to show only the most recent' : 'Showing most recent signal — click to show all'}
        >
          {showAllSignals ? 'ALL SIGNALS' : 'SIGNALS'}
        </button>
      )}
      <div style={{ display: 'flex', borderRadius: 4, overflow: 'hidden', border: '1px solid #2a2a2a' }}>
        <button
          onClick={() => adjustBarSpacing(-2)}
          title="Contract — bring bars closer together (more bars on screen)"
          style={{ padding: '6px 10px', fontSize: 13, fontWeight: 700, background: 'transparent', color: '#888', border: 'none', cursor: 'pointer' }}
          onMouseEnter={e => { e.currentTarget.style.color = '#fcf000'; }}
          onMouseLeave={e => { e.currentTarget.style.color = '#888'; }}
        >→←</button>
        <button
          onClick={() => adjustBarSpacing(2)}
          title="Expand — push bars further apart (fewer bars on screen, wider candles)"
          style={{ padding: '6px 10px', fontSize: 13, fontWeight: 700, background: 'transparent', color: '#888', border: 'none', cursor: 'pointer', borderLeft: '1px solid #2a2a2a' }}
          onMouseEnter={e => { e.currentTarget.style.color = '#fcf000'; }}
          onMouseLeave={e => { e.currentTarget.style.color = '#888'; }}
        >←→</button>
      </div>
      <div style={{ display: 'flex', borderRadius: 4, overflow: 'hidden', border: '1px solid #2a2a2a' }}>
        {[{ key: 'bars', label: 'OHLC Bars' }, { key: 'candles', label: 'Candles' }].map(opt => (
          <button
            key={opt.key}
            onClick={() => setChartType(opt.key)}
            style={{
              padding: '6px 12px', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
              background: chartType === opt.key ? '#fcf000' : 'transparent',
              color: chartType === opt.key ? '#000' : '#888',
              border: 'none', cursor: 'pointer', textTransform: 'uppercase',
            }}
            title={opt.key === 'bars' ? 'Traditional OHLC bars (open tick on left, close tick on right)' : 'Japanese candlesticks (filled body shows open→close range)'}
          >{opt.label}</button>
        ))}
      </div>
      <div style={{ display: 'flex', borderRadius: 4, overflow: 'hidden', border: '1px solid #2a2a2a' }}>
        {['daily', 'weekly', 'monthly'].map(tf => (
          <button
            key={tf}
            onClick={() => setTimeframe(tf)}
            style={{
              padding: '6px 14px', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
              background: timeframe === tf ? '#fcf000' : 'transparent',
              color: timeframe === tf ? '#000' : '#888',
              border: 'none', cursor: 'pointer', textTransform: 'uppercase',
            }}
          >{tf}</button>
        ))}
      </div>
      {embedded && isAdmin && (
        <div style={{ display: 'flex', borderRadius: 4, overflow: 'hidden', border: '1px solid #2a2a2a' }}>
          <button
            onClick={() => setOverlayDrawMode(prev => prev === 'free' ? null : 'free')}
            style={{
              padding: '6px 12px', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
              background: overlayDrawMode === 'free' ? '#fcf000' : 'transparent',
              color: overlayDrawMode === 'free' ? '#000' : '#888',
              border: 'none', cursor: 'pointer',
            }}
            title="Free-form trendline (any direction)"
          >✏️ Draw</button>
          <button
            onClick={() => setOverlayDrawMode(prev => prev === 'horizontal' ? null : 'horizontal')}
            style={{
              padding: '6px 12px', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
              background: overlayDrawMode === 'horizontal' ? '#fcf000' : 'transparent',
              color: overlayDrawMode === 'horizontal' ? '#000' : '#888',
              border: 'none', cursor: 'pointer', borderLeft: '1px solid #2a2a2a',
            }}
            title="Horizontal line — locks the second click to the same price level as the first"
          >─ Horiz</button>
          {overlayLineCount > 0 && (
            <button
              onClick={() => drawOverlayRef.current?.clearAll()}
              style={{
                padding: '6px 12px', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
                background: 'transparent', color: '#888',
                border: 'none', cursor: 'pointer', borderLeft: '1px solid #2a2a2a',
              }}
            >Clear ({overlayLineCount})</button>
          )}
        </div>
      )}
    </>
  );

  const chartInner = (
      <div style={{
        background: '#0a0a0a', borderRadius: embedded ? 0 : 8, width: '100%',
        ...(embedded ? { flex: 1, minHeight: 0 } : { maxWidth: 1200, height: '85vh' }),
        display: 'flex', flexDirection: 'column',
        border: embedded ? 'none' : '1px solid #2a2a2a',
        ...(!embedded && { boxShadow: '0 20px 60px rgba(0,0,0,0.6)' }),
      }}>
        {/* Header — hidden when embedded (controls portaled to parent) */}
        {!embedded && (
        <div style={{
          padding: '14px 20px', borderBottom: '1px solid #1f1f1f',
          display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            <span style={{ color: '#fcf000', fontSize: 20, fontWeight: 700, letterSpacing: '0.02em' }}>
              PNTHR AI 300
            </span>
            <span style={{ color: '#888', fontSize: 11, fontFamily: 'monospace' }}>PAI300</span>
          </div>

          {latest?.ok && (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ color: '#fff', fontSize: 24, fontWeight: 700, fontFamily: 'monospace' }}>
                  {fmtNum(latest.value)}
                </span>
                <span style={{ color: dayChangeColor, fontSize: 14, fontWeight: 600, fontFamily: 'monospace' }}>
                  {fmtPct(dayChange)}
                </span>
              </div>

              <div style={{
                padding: '4px 10px', borderRadius: 4, fontSize: 11, fontWeight: 700,
                letterSpacing: '0.08em', background: regimeColor, color: '#fff',
              }}>
                {latest.regime === 'bull' ? '🟢 BULL REGIME' : '🔴 BEAR REGIME'}
              </div>

              <div style={{ display: 'flex', gap: 14, fontSize: 11, color: '#aaa', fontFamily: 'monospace' }}>
                <span>YTD <strong style={{ color: latest.ytdPct >= 0 ? '#16a34a' : '#dc2626' }}>{fmtPct(latest.ytdPct)}</strong></span>
                <span>Since launch <strong style={{ color: '#16a34a' }}>{fmtPct(latest.inceptionPct)}</strong></span>
                <span>Daily OpEMA <strong style={{ color: '#fcf000' }}>{fmtNum(latest.ema21D)}</strong></span>
                <span>Weekly OpEMA <strong style={{ color: '#fcf000' }}>{fmtNum(latest.ema21W)}</strong></span>
              </div>
            </>
          )}

          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
            {toolbarControls}
            <button
              onClick={onClose}
              style={{
                background: 'transparent', border: '1px solid #2a2a2a', borderRadius: 4,
                color: '#888', padding: '6px 10px', cursor: 'pointer', fontSize: 12, marginLeft: 4,
              }}
              title="Close"
            >
              ✕
            </button>
          </div>
        </div>
        )}

        {/* Portal toolbar controls to parent when embedded */}
        {embedded && portalReady && toolbarRef?.current && createPortal(toolbarControls, toolbarRef.current)}

        {/* Chart body — price chart (top) + RSI sub-chart (bottom) */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          {loading && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888', zIndex: 3 }}>Loading…</div>}
          {error && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#dc2626', zIndex: 3 }}>{error}</div>}

          {/* Price chart */}
          <div style={{ flex: embedded ? 1 : 3, position: 'relative', minHeight: 0 }}>
            <img
              src={pantherHead}
              alt="PNTHR"
              style={{
                position: 'absolute', top: 14, left: 14, width: 200, height: 200,
                opacity: 0.92, zIndex: 2, pointerEvents: 'none',
                filter: 'drop-shadow(0 3px 12px rgba(0,0,0,0.75))',
              }}
            />

            {embedded && latest?.ok && (
              <div style={{
                position: 'absolute', top: 14, left: 224, zIndex: 3, pointerEvents: 'none',
                display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                fontSize: 13, fontFamily: 'monospace',
              }}>
                <span style={{ color: '#fcf000', fontWeight: 700, letterSpacing: '0.04em' }}>PNTHR AI 300</span>
                <span style={{ color: '#666', fontSize: 10 }}>PAI300</span>
                <span style={{ color: '#fff', fontSize: 20, fontWeight: 700 }}>
                  {fmtNum(latest.value)}
                </span>
                <span style={{ color: dayChangeColor, fontWeight: 600 }}>
                  {dayChange >= 0 ? '▲' : '▼'} {fmtPct(dayChange)}
                </span>
                <span style={{
                  padding: '3px 8px', borderRadius: 3, fontSize: 10, fontWeight: 700,
                  letterSpacing: '0.06em', background: regimeColor, color: '#fff',
                }}>
                  {latest.regime === 'bull' ? '🟢 BULL REGIME' : '🔴 BEAR REGIME'}
                </span>
                <span style={{ color: '#888', fontSize: 11 }}>
                  OpEMA <strong style={{ color: '#fcf000' }}>{latest.ema21W?.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</strong>
                </span>
                <span style={{ color: '#38bdf8', fontSize: 11 }} title="Dotted 10-period EMA — short-term sector trend, reference only (not a trading rule)">┈┈ 10 EMA</span>
                <span style={{ color: '#888', fontSize: 11 }}>
                  YTD <strong style={{ color: latest.ytdPct >= 0 ? '#16a34a' : '#dc2626' }}>{fmtPct(latest.ytdPct)}</strong>
                </span>
                <span style={{ color: '#888', fontSize: 11 }}>
                  Since launch <strong style={{ color: '#16a34a' }}>{fmtPct(latest.inceptionPct)}</strong>
                </span>
              </div>
            )}

            {hoveredBar && (
              <div style={{
                position: 'absolute', top: 14, left: 224, zIndex: 4,
                background: 'rgba(15,15,15,0.95)', border: '1px solid #2a2a2a', borderRadius: 4,
                padding: '8px 12px', fontSize: 11, fontFamily: 'monospace',
                color: '#d4d4d4', minWidth: 180, pointerEvents: 'none',
                boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
              }}>
                <div style={{ color: '#fcf000', fontWeight: 700, marginBottom: 4 }}>{hoveredBar.time}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '2px 12px' }}>
                  <span style={{ color: '#888' }}>Open</span><span>{fmtNum(hoveredBar.open)}</span>
                  <span style={{ color: '#888' }}>High</span><span style={{ color: '#16a34a' }}>{fmtNum(hoveredBar.high)}</span>
                  <span style={{ color: '#888' }}>Low</span><span style={{ color: '#dc2626' }}>{fmtNum(hoveredBar.low)}</span>
                  <span style={{ color: '#888' }}>Close</span>
                  <span style={{ color: hoveredBar.close >= hoveredBar.open ? '#16a34a' : '#dc2626', fontWeight: 700 }}>
                    {fmtNum(hoveredBar.close)}
                  </span>
                  {hoveredChangePct != null && (
                    <>
                      <span style={{ color: '#888' }}>Change</span>
                      <span style={{ color: hoveredChangePct >= 0 ? '#16a34a' : '#dc2626' }}>
                        {fmtPct(hoveredChangePct)}
                      </span>
                    </>
                  )}
                  {hoveredBar.ema != null && (
                    <>
                      <span style={{ color: '#888' }}>OpEMA</span>
                      <span style={{ color: '#fcf000' }}>{fmtNum(hoveredBar.ema)}</span>
                    </>
                  )}
                  {hoveredBar.ema10 != null && (
                    <>
                      <span style={{ color: '#888' }}>10 EMA</span>
                      <span style={{ color: '#38bdf8' }}>{fmtNum(hoveredBar.ema10)}</span>
                    </>
                  )}
                  {hoveredBar.rsi != null && (
                    <>
                      <span style={{ color: '#888' }}>RSI</span>
                      <span style={{
                        color: hoveredBar.rsi >= 70 ? '#dc3545' : hoveredBar.rsi <= 30 ? '#28a745' : '#D4A017',
                        fontWeight: 700,
                      }}>{hoveredBar.rsi.toFixed(1)}</span>
                    </>
                  )}
                </div>
              </div>
            )}

            <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />

            {!loading && !error && bars.length > 0 && (
              <ChartDrawingOverlay
                ref={drawOverlayRef}
                key={`PAI300:${timeframe}:${chartType}:${barsTick}`}
                chartRef={chartRef}
                seriesRef={priceSeriesRef}
                weeklyBars={visibleBarsRef.current}
                ticker="PAI300"
                enabled={isAdmin}
                buttonPosition="top-left"
                topOffset={224}
                hideButtons={embedded}
                externalDrawMode={embedded ? overlayDrawMode : undefined}
                onDrawModeChange={embedded ? setOverlayDrawMode : undefined}
                onLineCountChange={embedded ? setOverlayLineCount : undefined}
              />
            )}
          </div>

          {/* RSI label */}
          <div style={{
            padding: '2px 20px', borderTop: '1px solid #2a2a2a',
            fontSize: 10, color: '#D4A017', fontWeight: 700, letterSpacing: '0.08em',
            background: '#0c0c0c',
          }}>
            RSI (14)
          </div>

          {/* RSI sub-chart */}
          <div style={{ height: embedded ? 120 : undefined, flex: embedded ? 'none' : 1, position: 'relative', minHeight: 80 }}>
            <div ref={rsiContainerRef} style={{ position: 'absolute', inset: 0 }} />
          </div>
        </div>

        {/* Footer methodology note */}
        <div style={{
          padding: '8px 20px', borderTop: '1px solid #1f1f1f',
          fontSize: 10, color: '#666', fontStyle: 'italic',
          display: 'flex', justifyContent: 'space-between',
        }}>
          <span>321 holdings · capped market-cap weighted (2.5% / 1.0% hyperscaler) · monthly rebalance · base {latest?.baseDate} = {fmtNum(latest?.baseValue)}</span>
          {latest?.asOf && <span>as of {latest.asOf}</span>}
        </div>
      </div>
  );

  if (embedded) return chartInner;

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 9999, padding: 24,
      }}
    >
      {chartInner}
    </div>
  );
}
