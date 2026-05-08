import { useState, useEffect, useRef } from 'react';
import { createChart, BarSeries, CandlestickSeries, LineSeries } from 'lightweight-charts';
import { fetchPnthrAiSectorBars, fetchPnthrAiSectorConstituents } from '../services/api';
import { useAuth } from '../AuthContext';
import ChartDrawingOverlay from './ChartDrawingOverlay';
import AiTickerChartModal from './AiTickerChartModal';
import pantherHead from '../assets/panther head.png';

// AiSectorChartModal — full chart for one AI sector index. Clones the PAI300
// modal layout (OHLC bars / candles toggle, daily / weekly toggle, OpEMA,
// crosshair tooltip, drawing overlay) — just parameterized for sector instead
// of the parent index. Footer lists the holdings inside the sector.

function fmtNum(n) {
  if (n == null) return '—';
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(n) {
  if (n == null) return '—';
  const s = n >= 0 ? '+' : '';
  return `${s}${n.toFixed(2)}%`;
}

export default function AiSectorChartModal({ sector, onClose }) {
  const { isAdmin } = useAuth();
  const [timeframe, setTimeframe]   = useState('weekly');
  const [chartType, setChartType]   = useState('bars');
  const [bars, setBars]             = useState([]);
  const [emaPeriod, setEmaPeriod]   = useState(sector?.emaWeeklyPeriod ?? 30);
  const [holdings, setHoldings]     = useState(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [hoveredBar, setHoveredBar] = useState(null);
  const [barsTick, setBarsTick]     = useState(0);
  const [tickerChartIdx, setTickerChartIdx] = useState(null);  // index into holdings list when a holding is clicked
  const [barSpacing, setBarSpacing]   = useState(12);  // +4 wider default per Scott

  const containerRef    = useRef(null);
  const chartRef        = useRef(null);
  const priceSeriesRef  = useRef(null);
  const visibleBarsRef  = useRef([]);
  const barSpacingRef   = useRef(barSpacing);
  useEffect(() => { barSpacingRef.current = barSpacing; }, [barSpacing]);

  function adjustBarSpacing(delta) {
    setBarSpacing(prev => {
      const next = Math.max(2, Math.min(40, prev + delta));
      chartRef.current?.timeScale().applyOptions({ barSpacing: next });
      return next;
    });
  }

  // Bars
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    fetchPnthrAiSectorBars(sector.id, timeframe)
      .then(d => {
        if (cancelled) return;
        if (!d.ok || !d.bars?.length) { setError('No data'); setBars([]); return; }
        setBars(d.bars);
        setEmaPeriod(d.emaPeriod);
      })
      .catch(e => { if (!cancelled) setError(e.message || 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sector.id, timeframe]);

  // Constituents (holdings list — load once)
  useEffect(() => {
    let cancelled = false;
    fetchPnthrAiSectorConstituents(sector.id)
      .then(d => { if (!cancelled) setHoldings(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [sector.id]);

  // Chart
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

    const ema = chart.addSeries(LineSeries, {
      color: '#fcf000', lineWidth: 2,
      priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false,
    });

    priceSeries.setData(bars.map(b => ({ time: b.date, open: b.open, high: b.high, low: b.low, close: b.close })));
    ema.setData(bars.filter(b => b.ema != null).map(b => ({ time: b.date, value: b.ema })));

    visibleBarsRef.current = bars.map(b => ({
      weekOf: b.date, open: b.open, high: b.high, low: b.low, close: b.close,
    }));
    setBarsTick(t => t + 1);
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

    return () => { destroyed = true; chart.remove(); chartRef.current = null; priceSeriesRef.current = null; };
  }, [bars, timeframe, chartType]);

  const dayChange = sector?.dayChangePct;
  const dayChangeColor = dayChange == null ? '#888' : dayChange >= 0 ? '#16a34a' : '#dc2626';
  const regimeColor = sector?.regime === 'bull' ? '#16a34a' : '#dc2626';
  const hoveredChangePct = hoveredBar && hoveredBar.open
    ? ((hoveredBar.close - hoveredBar.open) / hoveredBar.open) * 100
    : null;

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
            <span style={{ color: '#fcf000', fontSize: 18, fontWeight: 700, letterSpacing: '0.02em' }}>
              {sector.name}
            </span>
            <span style={{ color: '#888', fontSize: 11, fontFamily: 'monospace' }}>{sector.ticker}</span>
          </div>

          {sector.ok && (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ color: '#fff', fontSize: 22, fontWeight: 700, fontFamily: 'monospace' }}>{fmtNum(sector.value)}</span>
                <span style={{ color: dayChangeColor, fontSize: 13, fontWeight: 600, fontFamily: 'monospace' }}>{fmtPct(dayChange)}</span>
              </div>

              <div style={{
                padding: '4px 10px', borderRadius: 4, fontSize: 11, fontWeight: 700,
                letterSpacing: '0.08em', background: regimeColor, color: '#fff',
              }}>
                {sector.regime === 'bull' ? '🟢 BULL' : '🔴 BEAR'}
              </div>

              <div style={{ display: 'flex', gap: 14, fontSize: 11, color: '#aaa', fontFamily: 'monospace' }}>
                <span>YTD <strong style={{ color: sector.ytdPct >= 0 ? '#16a34a' : '#dc2626' }}>{fmtPct(sector.ytdPct)}</strong></span>
                <span>Since launch <strong style={{ color: sector.inceptionPct >= 0 ? '#16a34a' : '#dc2626' }}>{fmtPct(sector.inceptionPct)}</strong></span>
                <span>{sector.emaWeeklyPeriod}W OpEMA <strong style={{ color: '#fcf000' }}>{fmtNum(sector.emaWeekly)}</strong></span>
                <span style={{ color: '#666' }}>{sector.holdingCount} holdings · target {sector.targetWeight}%</span>
              </div>
            </>
          )}

          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
            {/* Bar spacing: contract ⇨⇦  /  expand ⇦⇨ */}
            <div style={{ display: 'flex', borderRadius: 4, overflow: 'hidden', border: '1px solid #2a2a2a' }}>
              <button
                onClick={() => adjustBarSpacing(-2)}
                title="Contract — bring bars closer together"
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
                title="Expand — push bars further apart"
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

            <div style={{ display: 'flex', borderRadius: 4, overflow: 'hidden', border: '1px solid #2a2a2a' }}>
              {[
                { key: 'bars', label: 'OHLC Bars' },
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
                >
                  {opt.label}
                </button>
              ))}
            </div>
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

        {/* Chart */}
        <div style={{ flex: 1, position: 'relative' }}>
          <img
            src={pantherHead}
            alt="PNTHR"
            style={{
              position: 'absolute', top: 14, left: 14, width: 160, height: 160,
              opacity: 0.9, zIndex: 2, pointerEvents: 'none',
              filter: 'drop-shadow(0 3px 12px rgba(0,0,0,0.75))',
            }}
          />

          {hoveredBar && (
            <div style={{
              // Sit immediately to the right of the 160px panther watermark
              // (panther is at top:14, left:14, width:160 → box starts at left:184)
              position: 'absolute', top: 14, left: 184, zIndex: 4,
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
                    <span style={{ color: hoveredChangePct >= 0 ? '#16a34a' : '#dc2626' }}>{fmtPct(hoveredChangePct)}</span>
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

          {!loading && !error && bars.length > 0 && (
            <ChartDrawingOverlay
              key={`${sector.ticker}:${timeframe}:${chartType}:${barsTick}`}
              chartRef={chartRef}
              seriesRef={priceSeriesRef}
              weeklyBars={visibleBarsRef.current}
              ticker={sector.ticker}
              enabled={isAdmin}
              buttonPosition="top-left"
              topOffset={184}
            />
          )}
        </div>

        {/* Holdings list (collapsed) */}
        {holdings?.ok && (
          <div style={{
            padding: '10px 20px', borderTop: '1px solid #1f1f1f',
            fontSize: 11, color: '#aaa', maxHeight: 100, overflowY: 'auto',
          }}>
            <div style={{ color: '#fcf000', fontWeight: 700, marginBottom: 6, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {holdings.holdings.length} Holdings in this Sector
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '4px 12px', fontFamily: 'monospace', fontSize: 11 }}>
              {holdings.holdings.map((h, i) => (
                <button
                  key={h.ticker}
                  onClick={() => setTickerChartIdx(i)}
                  title={`Open ${h.ticker} chart`}
                  style={{
                    background: 'transparent', border: 'none', textAlign: 'left',
                    padding: '2px 4px', borderRadius: 3, cursor: 'pointer',
                    fontFamily: 'monospace', fontSize: 11,
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(252,240,0,0.12)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <span style={{ color: '#fcf000', fontWeight: 700, textDecoration: 'underline', textDecorationColor: 'rgba(252,240,0,0.4)' }}>{h.ticker}</span>
                  <span style={{ color: '#666', marginLeft: 6, fontSize: 10 }}>{h.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Holding chart — opens on top of the sector modal. Passes the full
          sector ticker list so ◀ / ▶ in the modal cycles through holdings.
          Closing returns to the sector chart. */}
      {tickerChartIdx != null && holdings?.holdings && (
        <AiTickerChartModal
          tickers={holdings.holdings.map(h => h.ticker)}
          initialIndex={tickerChartIdx}
          onClose={() => setTickerChartIdx(null)}
        />
      )}
    </div>
  );
}
