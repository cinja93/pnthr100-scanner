import { useState, useEffect, useRef } from 'react';
import { createChart, BarSeries, CandlestickSeries, LineSeries, createSeriesMarkers } from 'lightweight-charts';
import { fetchAiStockChartData, fetchNav } from '../services/api';
import { sizePosition, STRIKE_PCT, isEtfTicker } from '../utils/sizingUtils';
import { useQueue } from '../contexts/QueueContext';
import pantherHead from '../assets/panther head.png';

// AiTickerChartModal — daily + weekly OHLC charts side-by-side for any AI
// Universe ticker. EMA period comes from the stock's AI sector (one number,
// applied to both timeframes — so e.g. S1=30 means 30D on daily, 30W on weekly).
// Each panel has its own SIZE IT / QUEUE IT — the daily and weekly stops are
// real different stops and should be sized independently. Each panel also
// renders a dashed PNTHR Stop price line on its chart.

function fmtNum(n) {
  if (n == null) return '—';
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(n) {
  if (n == null) return '—';
  const s = n >= 0 ? '+' : '';
  return `${s}${n.toFixed(2)}%`;
}

// ── Single chart panel (daily or weekly) ───────────────────────────────────
function ChartPanel({
  title, period, fallback, bars, signals, chartType,
  currentSignal, pnthrStop,
  ticker, entryPrice,
}) {
  const containerRef    = useRef(null);
  const chartRef        = useRef(null);
  const priceSeriesRef  = useRef(null);
  const priceLineRef    = useRef(null);
  const markersRef      = useRef(null);
  const navCache        = useRef(null);

  const { queuedTickers, toggleQueue, nav: contextNav } = useQueue() || {};

  const [hoveredBar, setHoveredBar] = useState(null);
  const [barSpacing, setBarSpacing] = useState(title === 'Weekly' ? 12 : 14);
  const [sizeLoading, setSizeLoading] = useState(false);
  const [sizePanel,   setSizePanel]   = useState(null);

  const barSpacingRef = useRef(barSpacing);
  useEffect(() => { barSpacingRef.current = barSpacing; }, [barSpacing]);

  function adjustBarSpacing(delta) {
    setBarSpacing(prev => {
      const next = Math.max(2, Math.min(40, prev + delta));
      chartRef.current?.timeScale().applyOptions({ barSpacing: next });
      return next;
    });
  }

  // Reset sizing when ticker changes
  useEffect(() => { setSizePanel(null); }, [ticker]);

  // Auto-fire SIZE IT as soon as inputs are ready — Scott wants the sizing
  // info (NAV / Stop / Shares / Risk / etc.) visible by default without
  // having to click the button. Re-fires when ticker / entryPrice / signal /
  // stop change (e.g. on ◀ ▶ navigation). User edits to the stop input
  // don't change deps, so they're preserved between auto-runs.
  useEffect(() => {
    if (entryPrice == null) return;
    handleSizeIt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, entryPrice, pnthrStop, currentSignal]);

  // ── Chart render ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || !bars || bars.length === 0) return;

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: { background: { color: '#0c0c0c' }, textColor: '#d4d4d4', attributionLogo: false, fontSize: 10 },
      grid: { vertLines: { color: '#1a1a1a' }, horzLines: { color: '#1a1a1a' } },
      rightPriceScale: { borderColor: '#333' },
      timeScale: { borderColor: '#333', timeVisible: title === 'Daily', barSpacing: barSpacingRef.current },
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

    // Signal markers — render EVERY BL/SS/BE/SE event in the bar series so
    // the chart reflects the full signal history.
    //
    // Prior behavior: filter to the last 5 entry/exit pairs to "avoid
    // saturation." That filter was hiding real production signals from the
    // chart — a trader spotting a clean BL setup on, say, 5-19-25 wouldn't
    // see a marker drawn even though the state machine had fired a BL there,
    // because there were 5+ later pairs and the older signal got pushed out.
    // For decision-making, hiding real signals is unacceptable. Saturation on
    // a few extreme names (e.g., chop kings with 100+ events) is the lesser
    // evil — and zoom/pan still works to focus on a window.
    if (signals && signals.length > 0) {
      const visibleEvents = [...signals].sort((a, b) => a.time.localeCompare(b.time));
      const markers = visibleEvents.map(ev => {
        let position, shape, text, color;
        if (ev.signal === 'BL')      { color = '#16a34a'; position = 'belowBar'; shape = 'arrowUp';   text = 'BL'; }
        else if (ev.signal === 'SS') { color = '#dc2626'; position = 'aboveBar'; shape = 'arrowDown'; text = 'SS'; }
        else if (ev.signal === 'BE') { color = '#f59e0b'; position = 'aboveBar'; shape = 'square';    text = 'BE'; }
        else if (ev.signal === 'SE') { color = '#f59e0b'; position = 'belowBar'; shape = 'square';    text = 'SE'; }
        return { time: ev.time, position, color, shape, text, size: 2 };
      });
      // Save the marker manager to a ref so it isn't garbage-collected
      markersRef.current = createSeriesMarkers(priceSeries, markers);
    }

    // Dashed PNTHR Stop line — only the last 5 bars on the right edge so it
    // doesn't bisect the whole chart. Implemented as a LineSeries (not a
    // priceLine) so we can control its x-extent. Price label still appears
    // on the right Y axis via lastValueVisible. No floating chart-overlay
    // label (priceLine's `title` blocked the bars).
    if (pnthrStop != null && bars.length >= 1) {
      const stopLine = chart.addSeries(LineSeries, {
        color: '#fcf000',
        lineWidth: 1,
        lineStyle: 2,                     // 0=Solid 1=Dotted 2=Dashed 3=LargeDashed 4=SparseDotted
        priceLineVisible: false,
        lastValueVisible: true,           // shows the stop $ on the right axis
        crosshairMarkerVisible: false,
        title: '',                        // no floating overlay label
      });
      const lastN = Math.min(5, bars.length);
      const stopData = bars.slice(-lastN).map(b => ({ time: b.date, value: pnthrStop }));
      stopLine.setData(stopData);
      priceLineRef.current = stopLine;    // ref points to the series so we can update it
    }

    // (do NOT call fitContent — see comment in earlier commit)

    let destroyed = false;
    chart.subscribeCrosshairMove(param => {
      if (destroyed) return;
      const data = param?.seriesData?.get(priceSeries);
      if (!param?.time || !param?.point || !data) { setHoveredBar(null); return; }
      const emaData = param.seriesData?.get(ema);
      setHoveredBar({
        time: param.time,
        open: data.open, high: data.high, low: data.low, close: data.close,
        ema: emaData?.value ?? null,
      });
    });

    return () => {
      destroyed = true;
      chart.remove();
      chartRef.current = null;
      priceSeriesRef.current = null;
      priceLineRef.current = null;
      markersRef.current = null;
    };
  }, [bars, signals, chartType, title, pnthrStop]);

  // Update the dashed stop line live when SIZE IT's adjustable stop changes.
  // The line is a LineSeries pinned to the last 5 bars at a constant Y value;
  // we re-set its data with the new stop value to redraw at the new level.
  useEffect(() => {
    if (!priceLineRef.current || !bars || bars.length === 0) return;
    const live = sizePanel?.adjustedStop ?? pnthrStop;
    if (live == null) return;
    try {
      const lastN = Math.min(5, bars.length);
      const newData = bars.slice(-lastN).map(b => ({ time: b.date, value: Number(live) }));
      priceLineRef.current.setData(newData);
    } catch { /* series may have been disposed during a chart rebuild */ }
  }, [sizePanel?.adjustedStop, pnthrStop, bars]);

  // ── SIZE IT — uses THIS timeframe's signal + stop ──────────────────────
  async function handleSizeIt() {
    if (sizeLoading || entryPrice == null) return;
    setSizeLoading(true); setSizePanel(null);
    try {
      let nav = contextNav;
      if (!nav) {
        if (!navCache.current) {
          const d = await fetchNav();
          navCache.current = d?.nav || 100000;
        }
        nav = navCache.current;
      }

      // Direction from THIS panel's currentSignal
      let direction = 'LONG';
      if (currentSignal === 'BL') direction = 'LONG';
      else if (currentSignal === 'SS') direction = 'SHORT';

      // Stop from THIS panel's pnthrStop, fall back to ±2% of entry
      const stopDefault = pnthrStop != null
        ? pnthrStop
        : (direction === 'SHORT'
            ? +(entryPrice * 1.02).toFixed(2)
            : +(entryPrice * 0.98).toFixed(2));

      const isETF    = isEtfTicker(ticker);
      const maxGapPct = 0;
      const sizing    = sizePosition({ netLiquidity: nav, entryPrice, stopPrice: stopDefault, maxGapPct, direction, isETF });
      const lot1Shr   = Math.max(1, Math.round(sizing.totalShares * STRIKE_PCT[0]));
      const risk$     = lot1Shr * Math.abs(entryPrice - stopDefault);

      setSizePanel({
        nav, entry: entryPrice, stop: stopDefault, adjustedStop: stopDefault,
        totalShares: sizing.totalShares, lot1Shares: lot1Shr,
        risk$: +risk$.toFixed(0), direction, isETF,
        vitality: sizing.vitality, vitalityPct: sizing.vitalityPct,
        gapPct: maxGapPct, gapMult: sizing.gapMult,
        timeframe: title,  // tags the queue entry with which panel sized it
      });
    } catch (e) {
      console.error(`[SIZE IT ${title}]`, e.message);
    }
    setSizeLoading(false);
  }

  function recalcWithStop(newStopStr) {
    const newStop = parseFloat(newStopStr);
    if (!sizePanel || !newStop || newStop <= 0) return;
    const sizing = sizePosition({
      netLiquidity: sizePanel.nav, entryPrice: sizePanel.entry, stopPrice: newStop,
      maxGapPct: sizePanel.gapPct, direction: sizePanel.direction, isETF: sizePanel.isETF,
    });
    const lot1Shr = Math.max(1, Math.round(sizing.totalShares * STRIKE_PCT[0]));
    const risk    = lot1Shr * Math.abs(sizePanel.entry - newStop);
    setSizePanel(prev => ({
      ...prev, adjustedStop: newStop, totalShares: sizing.totalShares,
      lot1Shares: lot1Shr, risk$: +risk.toFixed(0),
      gapMult: sizing.gapMult, vitality: sizing.vitality,
    }));
  }

  function handleQueueToggle() {
    if (!toggleQueue || !sizePanel) return;
    const isQueued = queuedTickers?.has(ticker);
    if (isQueued) {
      toggleQueue({ ticker, _remove: true });
    } else {
      toggleQueue({
        id:                Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        ticker,
        signal:            currentSignal || null,
        timeframe:         sizePanel.timeframe,         // 'Daily' | 'Weekly'
        direction:         sizePanel.direction,
        currentPrice:      sizePanel.entry,
        suggestedStop:     sizePanel.stop,
        adjustedStop:      sizePanel.adjustedStop,
        gapPct:            sizePanel.gapPct,
        gapMultiplier:     sizePanel.gapMult,
        totalTargetShares: sizePanel.totalShares,
        lot1Shares:        sizePanel.lot1Shares,
        risk:              sizePanel.risk$,
        isETF:             sizePanel.isETF,
        vitalityPct:       sizePanel.vitalityPct,
        addedAt:           new Date().toISOString(),
      });
    }
  }

  const sigColor = currentSignal === 'BL' ? '#16a34a' : currentSignal === 'SS' ? '#dc2626' : currentSignal ? '#f59e0b' : '#666';
  const isQueued = queuedTickers?.has(ticker);

  // Data box always shows: latest bar by default, hovered bar when crosshair active.
  const lastBar = bars && bars.length > 0 ? bars[bars.length - 1] : null;
  const displayBar = hoveredBar || (lastBar ? {
    time:  lastBar.date,
    open:  lastBar.open,
    high:  lastBar.high,
    low:   lastBar.low,
    close: lastBar.close,
    ema:   lastBar.ema,
  } : null);
  const displayChangePct = displayBar && displayBar.open
    ? ((displayBar.close - displayBar.open) / displayBar.open) * 100
    : null;

  return (
    <div style={{
      flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column',
      border: '1px solid rgba(252,240,0,0.45)',     // thin yellow outline
      borderRadius: 4,
      margin: title === 'Daily' ? '6px 3px 6px 6px' : '6px 6px 6px 3px',
      overflow: 'hidden',
    }}>
      {/* Panel title bar */}
      <div style={{
        padding: '8px 12px', borderBottom: '1px solid #1f1f1f',
        display: 'flex', alignItems: 'center', gap: 8, background: '#0a0a0a', flexWrap: 'wrap',
      }}>
        <span style={{ color: '#fcf000', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          {title}
        </span>
        {period != null && (
          <span style={{ color: '#888', fontSize: 11, fontFamily: 'monospace' }}>
            {period}{title === 'Daily' ? 'D' : 'W'} OpEMA{fallback ? ' (21-fb)' : ''}
          </span>
        )}
        {currentSignal && (
          <span style={{
            padding: '2px 8px', borderRadius: 3, fontSize: 10, fontWeight: 700,
            background: sigColor, color: '#fff', letterSpacing: '0.06em',
          }}>
            {currentSignal}
          </span>
        )}
        {pnthrStop != null && !sizePanel && (
          <span style={{ color: '#fcf000', fontSize: 10, fontFamily: 'monospace' }}>
            Stop ${fmtNum(pnthrStop)}
          </span>
        )}

        {/* SIZE IT (gold) */}
        <button
          onClick={handleSizeIt}
          disabled={sizeLoading || entryPrice == null}
          style={{
            background: sizeLoading ? 'rgba(255,215,0,0.3)' : '#FFD700',
            color: '#000', border: 'none', borderRadius: 4,
            padding: '3px 8px', fontSize: 10, fontWeight: 800,
            cursor: sizeLoading ? 'not-allowed' : 'pointer',
            letterSpacing: '0.06em',
          }}
          title={`Size this ${title.toLowerCase()} setup using the panel's PNTHR Stop`}
        >
          {sizeLoading ? '⟳' : 'SIZE IT'}
        </button>

        {/* QUEUE IT (green, after sizing) */}
        {sizePanel && toggleQueue && (
          <button
            onClick={handleQueueToggle}
            style={{
              background:   isQueued ? '#28a745' : 'rgba(40,167,69,0.15)',
              color:        isQueued ? '#fff'    : '#28a745',
              border:       `1px solid ${isQueued ? '#28a745' : 'rgba(40,167,69,0.4)'}`,
              borderRadius: 4, padding: '3px 8px',
              fontSize: 10, fontWeight: 700, cursor: 'pointer',
              letterSpacing: '0.04em',
            }}
            title={isQueued ? 'Remove from queue' : `Add to entry queue (${title.toLowerCase()} setup)`}
          >
            {isQueued ? 'QUEUED ✓' : 'QUEUE IT'}
          </button>
        )}

        {/* Bar-spacing arrows */}
        <span style={{ marginLeft: 'auto', display: 'flex', borderRadius: 4, overflow: 'hidden', border: '1px solid #2a2a2a' }}>
          <button
            onClick={() => adjustBarSpacing(-2)}
            title="Contract — bring bars closer together"
            style={{ padding: '3px 8px', fontSize: 11, fontWeight: 700, background: 'transparent', color: '#888', border: 'none', cursor: 'pointer' }}
            onMouseEnter={e => { e.currentTarget.style.color = '#fcf000'; }}
            onMouseLeave={e => { e.currentTarget.style.color = '#888'; }}
          >
            →←
          </button>
          <button
            onClick={() => adjustBarSpacing(2)}
            title="Expand — push bars further apart"
            style={{ padding: '3px 8px', fontSize: 11, fontWeight: 700, background: 'transparent', color: '#888', border: 'none', cursor: 'pointer', borderLeft: '1px solid #2a2a2a' }}
            onMouseEnter={e => { e.currentTarget.style.color = '#fcf000'; }}
            onMouseLeave={e => { e.currentTarget.style.color = '#888'; }}
          >
            ←→
          </button>
        </span>
      </div>

      {/* SIZE IT strip — appears below title bar after sizing computed */}
      {sizePanel && (
        <div style={{
          padding: '8px 14px', borderBottom: '1px solid #1f1f1f',
          background: '#111', display: 'flex', gap: 14, alignItems: 'center',
          fontSize: 13, fontFamily: 'monospace', color: '#d4d4d4', flexWrap: 'wrap',
        }}>
          <span style={{ color: '#888' }}>Entry <strong style={{ color: '#fff' }}>${sizePanel.entry.toFixed(2)}</strong></span>
          <span style={{ color: '#888' }}>Dir <strong style={{ color: sizePanel.direction === 'LONG' ? '#16a34a' : '#dc2626' }}>{sizePanel.direction}</strong></span>
          <span style={{ color: '#888' }}>Stop&nbsp;
            <input
              type="number" step="0.01"
              value={sizePanel.adjustedStop}
              onChange={e => recalcWithStop(e.target.value)}
              style={{
                width: 92, padding: '2px 6px', fontSize: 13, fontFamily: 'monospace',
                background: '#0a0a0a', border: '1px solid #2a2a2a', borderRadius: 3,
                color: '#fcf000', outline: 'none', fontWeight: 700,
              }}
            />
          </span>
          <span style={{ color: '#888' }}>Sh <strong style={{ color: '#fff' }}>{sizePanel.totalShares.toLocaleString()}</strong></span>
          <span style={{ color: '#888' }}>L1 <strong style={{ color: '#fcf000' }}>{sizePanel.lot1Shares.toLocaleString()}</strong></span>
          <span style={{ color: '#888' }}>Risk <strong style={{ color: '#dc2626' }}>${sizePanel.risk$.toLocaleString()}</strong></span>
          <span style={{ color: '#888' }}>Vit <strong style={{ color: '#fff' }}>{(sizePanel.vitalityPct * 100).toFixed(1)}%</strong></span>
        </div>
      )}

      {/* Chart body */}
      <div style={{ flex: 1, position: 'relative' }}>
        {/* Data box — always visible upper-left. Shows the LATEST bar by
            default; switches to the HOVERED bar when crosshair is on a bar. */}
        {displayBar && (
          <div style={{
            position: 'absolute', top: 8, left: 8, zIndex: 4,
            background: 'rgba(15,15,15,0.95)', border: '1px solid #2a2a2a', borderRadius: 4,
            padding: '6px 10px', fontSize: 10, fontFamily: 'monospace',
            color: '#d4d4d4', minWidth: 140, pointerEvents: 'none',
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
          }}>
            <div style={{ color: '#fcf000', fontWeight: 700, marginBottom: 3, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span>{displayBar.time}</span>
              {!hoveredBar && <span style={{ fontSize: 8, color: '#666', fontWeight: 500 }}>LATEST</span>}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '1px 10px' }}>
              <span style={{ color: '#888' }}>O</span><span>{fmtNum(displayBar.open)}</span>
              <span style={{ color: '#888' }}>H</span><span style={{ color: '#16a34a' }}>{fmtNum(displayBar.high)}</span>
              <span style={{ color: '#888' }}>L</span><span style={{ color: '#dc2626' }}>{fmtNum(displayBar.low)}</span>
              <span style={{ color: '#888' }}>C</span>
              <span style={{ color: displayBar.close >= displayBar.open ? '#16a34a' : '#dc2626', fontWeight: 700 }}>
                {fmtNum(displayBar.close)}
              </span>
              {displayChangePct != null && (
                <>
                  <span style={{ color: '#888' }}>%</span>
                  <span style={{ color: displayChangePct >= 0 ? '#16a34a' : '#dc2626' }}>{fmtPct(displayChangePct)}</span>
                </>
              )}
              {displayBar.ema != null && (
                <>
                  <span style={{ color: '#888' }}>EMA</span>
                  <span style={{ color: '#fcf000' }}>{fmtNum(displayBar.ema)}</span>
                </>
              )}
            </div>
          </div>
        )}
        <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      </div>
    </div>
  );
}

// ── Modal ──────────────────────────────────────────────────────────────────
// Accepts EITHER a single `ticker` (back-compat) OR a `tickers` array +
// `initialIndex` for prev/next navigation. When given a list, ◀ / ▶ buttons
// (and ← / → keyboard) cycle through them without closing the modal.
export default function AiTickerChartModal({ ticker, tickers, initialIndex = 0, onClose }) {
  const tickerList = tickers && tickers.length > 0 ? tickers : (ticker ? [ticker] : []);
  const [currentIdx, setCurrentIdx] = useState(Math.min(Math.max(0, initialIndex), Math.max(0, tickerList.length - 1)));
  const activeTicker = tickerList[currentIdx];

  const [data, setData]           = useState(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [chartType, setChartType] = useState('bars');

  const canPrev = currentIdx > 0;
  const canNext = currentIdx < tickerList.length - 1;
  function gotoPrev() { if (canPrev) setCurrentIdx(i => i - 1); }
  function gotoNext() { if (canNext) setCurrentIdx(i => i + 1); }

  useEffect(() => {
    function onKey(e) {
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      if (e.key === 'ArrowLeft')  { e.preventDefault(); gotoPrev(); }
      if (e.key === 'ArrowRight') { e.preventDefault(); gotoNext(); }
      if (e.key === 'Escape')     { e.preventDefault(); onClose(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canPrev, canNext, onClose]);

  // Initial load + 30s silent auto-refresh while the modal is open.
  // Server cache for /api/pnthr-ai-stock/:ticker is also 30s and pulls a fresh
  // FMP /quote on every miss, so each tick rolls live currentPrice + day-change
  // forward. Spinner only shows on the initial load (or ticker change), not
  // on the silent ticks. Cleared on unmount or when activeTicker changes.
  useEffect(() => {
    if (!activeTicker) return;
    let cancelled = false;
    const fetchOnce = (silent) => {
      if (!silent) { setLoading(true); setError(null); setData(null); }
      fetchAiStockChartData(activeTicker)
        .then(d => {
          if (cancelled) return;
          if (!d.ok) { if (!silent) setError(d.error || 'Failed to load'); return; }
          setData(d);
        })
        .catch(e => { if (!cancelled && !silent) setError(e.message || 'Failed to load'); })
        .finally(() => { if (!cancelled && !silent) setLoading(false); });
    };
    fetchOnce(false);
    const id = setInterval(() => fetchOnce(true), 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, [activeTicker]);

  const dayChangeColor = data?.dayChangePct == null ? '#888' : data.dayChangePct >= 0 ? '#16a34a' : '#dc2626';

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 9999, padding: 16,
      }}
    >
      <div style={{
        background: '#0a0a0a', borderRadius: 8, width: '100%', maxWidth: 1600,
        height: '90vh', display: 'flex', flexDirection: 'column',
        border: '1px solid #2a2a2a', boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
      }}>
        {/* Header — three-column flex so the ticker block sits CENTERED
            over the two charts regardless of left/right toolbar width. */}
        <div style={{
          padding: '12px 18px', borderBottom: '1px solid #1f1f1f',
          display: 'flex', alignItems: 'center', gap: 14,
        }}>
          {/* Left: panther only (prev/next nav moved to bottom center) */}
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 14, justifyContent: 'flex-start', minWidth: 0 }}>
            <img src={pantherHead} alt="PNTHR" style={{ width: 36, height: 36, opacity: 0.9 }} />
          </div>

          {/* Center: ticker info — centered over the two chart panels */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap', justifyContent: 'center' }}>
            <span style={{ color: '#fcf000', fontSize: 22, fontWeight: 700, letterSpacing: '0.02em', fontFamily: 'monospace' }}>
              {activeTicker}
            </span>
            {data?.name && <span style={{ color: '#888', fontSize: 13 }}>{data.name}</span>}
            {data?.ok && (
              <>
                <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ color: '#fff', fontSize: 20, fontWeight: 700, fontFamily: 'monospace' }}>
                    ${fmtNum(data.currentPrice)}
                  </span>
                  <span style={{ color: dayChangeColor, fontSize: 13, fontWeight: 600, fontFamily: 'monospace' }}>
                    {fmtPct(data.dayChangePct)}
                  </span>
                </span>
                <span style={{ color: '#666', fontSize: 11, fontFamily: 'monospace' }}>
                  {data.sectorName} · {data.emaPeriod}-period OpEMA
                </span>
              </>
            )}
          </div>

          {/* Right: chart-type toggle + close */}
          <div style={{ flex: 1, display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end', minWidth: 0 }}>
            <div style={{ display: 'flex', borderRadius: 4, overflow: 'hidden', border: '1px solid #2a2a2a' }}>
              {[
                { key: 'bars',    label: 'OHLC Bars' },
                { key: 'candles', label: 'Candles' },
              ].map(opt => (
                <button
                  key={opt.key}
                  onClick={() => setChartType(opt.key)}
                  style={{
                    padding: '5px 10px', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
                    background: chartType === opt.key ? '#fcf000' : 'transparent',
                    color: chartType === opt.key ? '#000' : '#888',
                    border: 'none', cursor: 'pointer', textTransform: 'uppercase',
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <button
              onClick={onClose}
              style={{
                background: 'transparent', border: '1px solid #2a2a2a', borderRadius: 4,
                color: '#888', padding: '5px 9px', cursor: 'pointer', fontSize: 12, marginLeft: 4,
              }}
              title="Close"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Body — two charts side by side, each panel owns its own SIZE IT / QUEUE IT / stop line */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'row', minHeight: 0 }}>
          {loading && <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888' }}>Loading {activeTicker}…</div>}
          {error && <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#dc2626' }}>{error}</div>}

          {!loading && !error && data?.ok && (
            <>
              <ChartPanel
                title="Daily"
                period={data.dailyEmaPeriod ?? data.emaPeriod}
                fallback={data.fallbackDaily}
                bars={data.daily.bars}
                signals={data.daily.signals}
                chartType={chartType}
                currentSignal={data.daily.currentSignal}
                pnthrStop={data.daily.pnthrStop}
                ticker={activeTicker}
                entryPrice={data.currentPrice}
              />
              <ChartPanel
                title="Weekly"
                period={data.weeklyEmaPeriod ?? data.emaPeriod}
                fallback={data.fallbackWeekly}
                bars={data.weekly.bars}
                signals={data.weekly.signals}
                chartType={chartType}
                currentSignal={data.weekly.currentSignal}
                pnthrStop={data.weekly.pnthrStop}
                ticker={activeTicker}
                entryPrice={data.currentPrice}
              />
            </>
          )}
        </div>

        {/* Prev / Next nav — bottom center, between the charts and the footer */}
        {tickerList.length > 1 && (
          <div style={{
            padding: '8px 18px', borderTop: '1px solid #1f1f1f',
            display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 14,
            background: '#0a0a0a',
          }}>
            <button
              onClick={gotoPrev}
              disabled={!canPrev}
              title="Previous ticker (← arrow)"
              style={{
                background: canPrev ? '#fcf000' : 'transparent',
                border: `2px solid ${canPrev ? '#fcf000' : '#333'}`,
                borderRadius: 6,
                color: canPrev ? '#000' : '#444',
                padding: '6px 22px', fontSize: 18, fontWeight: 800,
                cursor: canPrev ? 'pointer' : 'not-allowed',
                lineHeight: 1,
              }}
            >
              ◀
            </button>
            <span style={{ color: '#fff', fontSize: 13, fontFamily: 'monospace', minWidth: 90, textAlign: 'center', fontWeight: 600 }}>
              {currentIdx + 1} / {tickerList.length}
            </span>
            <button
              onClick={gotoNext}
              disabled={!canNext}
              title="Next ticker (→ arrow)"
              style={{
                background: canNext ? '#fcf000' : 'transparent',
                border: `2px solid ${canNext ? '#fcf000' : '#333'}`,
                borderRadius: 6,
                color: canNext ? '#000' : '#444',
                padding: '6px 22px', fontSize: 18, fontWeight: 800,
                cursor: canNext ? 'pointer' : 'not-allowed',
                lineHeight: 1,
              }}
            >
              ▶
            </button>
          </div>
        )}

        {/* Footer methodology note */}
        <div style={{
          padding: '7px 18px', borderTop: '1px solid #1f1f1f',
          fontSize: 10, color: '#666', fontStyle: 'italic',
          display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8,
        }}>
          <span>EMA period sourced from {data?.sectorName} sector config — same number applied to weekly bars (= {data?.emaPeriod}W) and daily bars (= {data?.emaPeriod}D). Each panel sizes independently using its own PNTHR Stop.</span>
          {data?.asOf && <span>as of {data.asOf}</span>}
        </div>
      </div>
    </div>
  );
}
