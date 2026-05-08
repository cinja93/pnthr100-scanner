import { useState, useEffect, useRef } from 'react';
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

export default function Pnthr300ChartModal({ onClose }) {
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
  const [barSpacing, setBarSpacing] = useState(8);  // px between bars (lightweight-charts unit)

  const containerRef    = useRef(null);
  const chartRef        = useRef(null);
  const priceSeriesRef  = useRef(null);
  const visibleBarsRef  = useRef([]);
  const barSpacingRef   = useRef(barSpacing);
  useEffect(() => { barSpacingRef.current = barSpacing; }, [barSpacing]);

  // Imperative spacing adjuster — applies to the live chart without triggering
  // a full re-render. Clamped to [2, 40] so bars stay readable at extremes.
  function adjustBarSpacing(delta) {
    setBarSpacing(prev => {
      const next = Math.max(2, Math.min(40, prev + delta));
      chartRef.current?.timeScale().applyOptions({ barSpacing: next });
      return next;
    });
  }

  // Latest snapshot (for header summary)
  useEffect(() => {
    let cancelled = false;
    fetchPnthrAi300Latest()
      .then(d => { if (!cancelled) setLatest(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Bars on mount + when timeframe changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    fetchPnthrAi300Bars(timeframe)
      .then(d => {
        if (cancelled) return;
        if (!d.ok || !d.bars?.length) { setError('No data'); setBars([]); return; }
        setBars(d.bars);
        setEmaPeriod(d.emaPeriod);
      })
      .catch(e => { if (!cancelled) setError(e.message || 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [timeframe]);

  // Chart render
  useEffect(() => {
    if (!containerRef.current || bars.length === 0) return;

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

    // EMA overlay — title removed (was overlapping bars on the right). The
    // right-axis price tag (lastValueVisible) still shows the live value.
    const ema = chart.addSeries(LineSeries, {
      color: '#fcf000', lineWidth: 2,
      priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false,
    });

    priceSeries.setData(bars.map(b => ({
      time: b.date, open: b.open, high: b.high, low: b.low, close: b.close,
    })));
    ema.setData(bars.filter(b => b.ema != null).map(b => ({ time: b.date, value: b.ema })));

    // PNTHR signal markers (BL / SS / BE / SE) — same state machine the 679
    // weekly chart uses, run on this timeframe's bars + EMA period. PAI300 is
    // a broad index → isETF=true (tighter daylight zone).
    const sigBars = bars.map(b => ({ time: b.date, open: b.open, high: b.high, low: b.low, close: b.close }));
    const { events: sigEvents } = detectAllSignals(sigBars, emaPeriod, true);
    if (sigEvents.length > 0) {
      const markers = sigEvents.map(ev => {
        const isLong = ev.signal === 'BL';
        const isShort = ev.signal === 'SS';
        const isExitOfLong  = ev.signal === 'BE';
        const isExitOfShort = ev.signal === 'SE';
        let color, position, shape, text;
        if (isLong)        { color = '#16a34a'; position = 'belowBar'; shape = 'arrowUp';   text = 'BL'; }
        else if (isShort)  { color = '#dc2626'; position = 'aboveBar'; shape = 'arrowDown'; text = 'SS'; }
        else if (isExitOfLong)  { color = '#f59e0b'; position = 'aboveBar'; shape = 'square'; text = 'BE'; }
        else if (isExitOfShort) { color = '#f59e0b'; position = 'belowBar'; shape = 'square'; text = 'SE'; }
        return { time: ev.time, position, color, shape, text, size: 1 };
      });
      createSeriesMarkers(priceSeries, markers);
    }

    // Snapshot bars for the drawing overlay's snap-to-high/low logic. The
    // overlay expects a `weekOf` field — map from `date` regardless of
    // timeframe (the overlay just keys off it).
    visibleBarsRef.current = bars.map(b => ({
      weekOf: b.date, open: b.open, high: b.high, low: b.low, close: b.close,
    }));
    setBarsTick(t => t + 1);

    chart.timeScale().fitContent();

    // Crosshair OHLC tooltip
    let destroyed = false;
    chart.subscribeCrosshairMove(param => {
      if (destroyed) return;
      const data = param?.seriesData?.get(priceSeries);
      if (!param?.time || !param?.point || !data) { setHoveredBar(null); return; }
      const emaData = param.seriesData?.get(ema);
      setHoveredBar({
        x: param.point.x, y: param.point.y,
        time: param.time,
        open: data.open, high: data.high, low: data.low, close: data.close,
        ema: emaData?.value ?? null,
      });
    });

    return () => { destroyed = true; chart.remove(); chartRef.current = null; priceSeriesRef.current = null; };
  }, [bars, timeframe, emaPeriod, chartType]);

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

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 9999, padding: 24,
      }}
    >
      <div style={{
        background: '#0a0a0a', borderRadius: 8, width: '100%', maxWidth: 1200,
        height: '85vh', display: 'flex', flexDirection: 'column',
        border: '1px solid #2a2a2a', boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
      }}>
        {/* Header */}
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
            {/* Bar spacing: contract ⇨⇦  /  expand ⇦⇨ — adjusts the gap between bars */}
            <div style={{ display: 'flex', borderRadius: 4, overflow: 'hidden', border: '1px solid #2a2a2a' }}>
              <button
                onClick={() => adjustBarSpacing(-2)}
                title="Contract — bring bars closer together (more bars on screen)"
                style={{
                  padding: '6px 10px', fontSize: 13, fontWeight: 700,
                  background: 'transparent', color: '#888',
                  border: 'none', cursor: 'pointer',
                }}
                onMouseEnter={e => { e.currentTarget.style.color = '#fcf000'; }}
                onMouseLeave={e => { e.currentTarget.style.color = '#888'; }}
              >
                →←
              </button>
              <button
                onClick={() => adjustBarSpacing(2)}
                title="Expand — push bars further apart (fewer bars on screen, wider candles)"
                style={{
                  padding: '6px 10px', fontSize: 13, fontWeight: 700,
                  background: 'transparent', color: '#888',
                  border: 'none', cursor: 'pointer', borderLeft: '1px solid #2a2a2a',
                }}
                onMouseEnter={e => { e.currentTarget.style.color = '#fcf000'; }}
                onMouseLeave={e => { e.currentTarget.style.color = '#888'; }}
              >
                ←→
              </button>
            </div>

            {/* Chart type: OHLC bars (default) vs candlesticks */}
            <div style={{ display: 'flex', borderRadius: 4, overflow: 'hidden', border: '1px solid #2a2a2a' }}>
              {[
                { key: 'bars',    label: 'OHLC Bars' },
                { key: 'candles', label: 'Candles' },
              ].map(opt => (
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
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Timeframe: daily vs weekly */}
            <div style={{ display: 'flex', borderRadius: 4, overflow: 'hidden', border: '1px solid #2a2a2a' }}>
              {['daily', 'weekly'].map(tf => (
                <button
                  key={tf}
                  onClick={() => setTimeframe(tf)}
                  style={{
                    padding: '6px 14px', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
                    background: timeframe === tf ? '#fcf000' : 'transparent',
                    color: timeframe === tf ? '#000' : '#888',
                    border: 'none', cursor: 'pointer', textTransform: 'uppercase',
                  }}
                >
                  {tf}
                </button>
              ))}
            </div>
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

        {/* Chart body */}
        <div style={{ flex: 1, position: 'relative' }}>
          {/* Panther head — sized to match the width of "PNTHR AI 300" yellow label above */}
          <img
            src={pantherHead}
            alt="PNTHR"
            style={{
              position: 'absolute', top: 14, left: 14, width: 200, height: 200,
              opacity: 0.92, zIndex: 2, pointerEvents: 'none',
              filter: 'drop-shadow(0 3px 12px rgba(0,0,0,0.75))',
            }}
          />

          {/* OHLC crosshair tooltip — positioned near cursor, doesn't block hits */}
          {hoveredBar && (
            <div style={{
              position: 'absolute', top: 12, right: 16, zIndex: 4,
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
              </div>
            </div>
          )}

          {loading && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888', zIndex: 3 }}>Loading…</div>}
          {error && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#dc2626', zIndex: 3 }}>{error}</div>}

          <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />

          {/* Trendline drawing tool (admin) — same overlay the 679 ChartModal uses.
              Persists per ticker to MongoDB; 'PAI300' gets its own bucket. */}
          {!loading && !error && bars.length > 0 && (
            <ChartDrawingOverlay
              key={`PAI300:${timeframe}:${chartType}:${barsTick}`}
              chartRef={chartRef}
              seriesRef={priceSeriesRef}
              weeklyBars={visibleBarsRef.current}
              ticker="PAI300"
              enabled={isAdmin}
              buttonPosition="top-left"
              topOffset={224}
            />
          )}
        </div>

        {/* Footer methodology note */}
        <div style={{
          padding: '8px 20px', borderTop: '1px solid #1f1f1f',
          fontSize: 10, color: '#666', fontStyle: 'italic',
          display: 'flex', justifyContent: 'space-between',
        }}>
          <span>304 holdings · capped market-cap weighted (4% / 1.5% hyperscaler) · monthly rebalance · base {latest?.baseDate} = {fmtNum(latest?.baseValue)}</span>
          {latest?.asOf && <span>as of {latest.asOf}</span>}
        </div>
      </div>
    </div>
  );
}
