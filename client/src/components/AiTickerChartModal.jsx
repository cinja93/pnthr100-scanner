import { useState, useEffect, useRef } from 'react';
import { createChart, BarSeries, CandlestickSeries, LineSeries, createSeriesMarkers } from 'lightweight-charts';
import { fetchAiStockChartData } from '../services/api';
import pantherHead from '../assets/panther head.png';

// AiTickerChartModal — daily + weekly OHLC charts side-by-side for any AI
// Universe ticker. EMA period comes from the stock's AI sector (one number,
// applied to both timeframes — so e.g. S1=30 means 30D on daily, 30W on weekly).
// Signal markers (BL/SS/BE/SE) overlaid on each chart.

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
function ChartPanel({ title, period, fallback, bars, signals, chartType, currentSignal, pnthrStop }) {
  const containerRef = useRef(null);
  const chartRef     = useRef(null);
  const [hoveredBar, setHoveredBar] = useState(null);
  const [barSpacing, setBarSpacing] = useState(title === 'Weekly' ? 6 : 4);
  const barSpacingRef = useRef(barSpacing);
  useEffect(() => { barSpacingRef.current = barSpacing; }, [barSpacing]);

  function adjustBarSpacing(delta) {
    setBarSpacing(prev => {
      const next = Math.max(2, Math.min(40, prev + delta));
      chartRef.current?.timeScale().applyOptions({ barSpacing: next });
      return next;
    });
  }

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

    const ema = chart.addSeries(LineSeries, {
      color: '#fcf000', lineWidth: 2,
      priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false,
    });

    priceSeries.setData(bars.map(b => ({
      time: b.date, open: b.open, high: b.high, low: b.low, close: b.close,
    })));
    ema.setData(bars.filter(b => b.ema != null).map(b => ({ time: b.date, value: b.ema })));

    // Signal markers
    if (signals && signals.length > 0) {
      const markers = signals.map(ev => {
        let position, shape, text, color;
        if (ev.signal === 'BL')      { color = '#16a34a'; position = 'belowBar'; shape = 'arrowUp';   text = 'BL'; }
        else if (ev.signal === 'SS') { color = '#dc2626'; position = 'aboveBar'; shape = 'arrowDown'; text = 'SS'; }
        else if (ev.signal === 'BE') { color = '#f59e0b'; position = 'aboveBar'; shape = 'square';    text = 'BE'; }
        else if (ev.signal === 'SE') { color = '#f59e0b'; position = 'belowBar'; shape = 'square';    text = 'SE'; }
        return { time: ev.time, position, color, shape, text, size: 1 };
      });
      createSeriesMarkers(priceSeries, markers);
    }

    chart.timeScale().fitContent();

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

    return () => { destroyed = true; chart.remove(); chartRef.current = null; };
  }, [bars, signals, chartType, title]);

  const sigColor = currentSignal === 'BL' ? '#16a34a' : currentSignal === 'SS' ? '#dc2626' : currentSignal ? '#f59e0b' : '#666';
  const hoveredChangePct = hoveredBar && hoveredBar.open
    ? ((hoveredBar.close - hoveredBar.open) / hoveredBar.open) * 100
    : null;

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', borderRight: title === 'Daily' ? '1px solid #1f1f1f' : 'none' }}>
      {/* Panel title bar */}
      <div style={{
        padding: '8px 12px', borderBottom: '1px solid #1f1f1f',
        display: 'flex', alignItems: 'center', gap: 10, background: '#0a0a0a',
      }}>
        <span style={{ color: '#fcf000', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          {title}
        </span>
        {period != null && (
          <span style={{ color: '#888', fontSize: 11, fontFamily: 'monospace' }}>
            {period}{title === 'Daily' ? 'D' : 'W'} OpEMA{fallback ? ' (21-fallback, short history)' : ''}
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
        {pnthrStop != null && (
          <span style={{ color: '#fcf000', fontSize: 10, fontFamily: 'monospace' }}>
            Stop ${fmtNum(pnthrStop)}
          </span>
        )}

        {/* Bar-spacing expand/contract buttons (per panel — daily and weekly tune independently) */}
        <span style={{ marginLeft: 'auto', display: 'flex', borderRadius: 4, overflow: 'hidden', border: '1px solid #2a2a2a' }}>
          <button
            onClick={() => adjustBarSpacing(-2)}
            title="Contract — bring bars closer together"
            style={{
              padding: '3px 8px', fontSize: 11, fontWeight: 700,
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
            title="Expand — push bars further apart"
            style={{
              padding: '3px 8px', fontSize: 11, fontWeight: 700,
              background: 'transparent', color: '#888',
              border: 'none', cursor: 'pointer', borderLeft: '1px solid #2a2a2a',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = '#fcf000'; }}
            onMouseLeave={e => { e.currentTarget.style.color = '#888'; }}
          >
            ←→
          </button>
        </span>
      </div>

      {/* Chart body */}
      <div style={{ flex: 1, position: 'relative' }}>
        {hoveredBar && (
          <div style={{
            position: 'absolute', top: 8, left: 8, zIndex: 4,
            background: 'rgba(15,15,15,0.95)', border: '1px solid #2a2a2a', borderRadius: 4,
            padding: '6px 10px', fontSize: 10, fontFamily: 'monospace',
            color: '#d4d4d4', minWidth: 140, pointerEvents: 'none',
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
          }}>
            <div style={{ color: '#fcf000', fontWeight: 700, marginBottom: 3 }}>{hoveredBar.time}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '1px 10px' }}>
              <span style={{ color: '#888' }}>O</span><span>{fmtNum(hoveredBar.open)}</span>
              <span style={{ color: '#888' }}>H</span><span style={{ color: '#16a34a' }}>{fmtNum(hoveredBar.high)}</span>
              <span style={{ color: '#888' }}>L</span><span style={{ color: '#dc2626' }}>{fmtNum(hoveredBar.low)}</span>
              <span style={{ color: '#888' }}>C</span>
              <span style={{ color: hoveredBar.close >= hoveredBar.open ? '#16a34a' : '#dc2626', fontWeight: 700 }}>
                {fmtNum(hoveredBar.close)}
              </span>
              {hoveredChangePct != null && (
                <>
                  <span style={{ color: '#888' }}>%</span>
                  <span style={{ color: hoveredChangePct >= 0 ? '#16a34a' : '#dc2626' }}>{fmtPct(hoveredChangePct)}</span>
                </>
              )}
              {hoveredBar.ema != null && (
                <>
                  <span style={{ color: '#888' }}>EMA</span>
                  <span style={{ color: '#fcf000' }}>{fmtNum(hoveredBar.ema)}</span>
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
export default function AiTickerChartModal({ ticker, onClose }) {
  const [data, setData]           = useState(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [chartType, setChartType] = useState('bars');

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    fetchAiStockChartData(ticker)
      .then(d => {
        if (cancelled) return;
        if (!d.ok) { setError(d.error || 'Failed to load'); return; }
        setData(d);
      })
      .catch(e => { if (!cancelled) setError(e.message || 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ticker]);

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
        {/* Header */}
        <div style={{
          padding: '12px 18px', borderBottom: '1px solid #1f1f1f',
          display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
        }}>
          <img src={pantherHead} alt="PNTHR" style={{ width: 36, height: 36, opacity: 0.9 }} />
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ color: '#fcf000', fontSize: 22, fontWeight: 700, letterSpacing: '0.02em', fontFamily: 'monospace' }}>
              {ticker}
            </span>
            {data?.name && <span style={{ color: '#888', fontSize: 13 }}>{data.name}</span>}
          </div>
          {data?.ok && (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ color: '#fff', fontSize: 20, fontWeight: 700, fontFamily: 'monospace' }}>
                  ${fmtNum(data.currentPrice)}
                </span>
                <span style={{ color: dayChangeColor, fontSize: 13, fontWeight: 600, fontFamily: 'monospace' }}>
                  {fmtPct(data.dayChangePct)}
                </span>
              </div>
              <span style={{ color: '#666', fontSize: 11, fontFamily: 'monospace' }}>
                {data.sectorName} · {data.emaPeriod}-period OpEMA
              </span>
            </>
          )}

          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
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

        {/* Body — two charts side by side */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'row', minHeight: 0 }}>
          {loading && <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888' }}>Loading {ticker}…</div>}
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
              />
            </>
          )}
        </div>

        {/* Footer methodology note */}
        <div style={{
          padding: '7px 18px', borderTop: '1px solid #1f1f1f',
          fontSize: 10, color: '#666', fontStyle: 'italic',
          display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8,
        }}>
          <span>EMA period sourced from {data?.sectorName} sector config — same number applied to weekly bars (= {data?.emaPeriod}W) and daily bars (= {data?.emaPeriod}D).</span>
          {data?.asOf && <span>as of {data.asOf}</span>}
        </div>
      </div>
    </div>
  );
}
