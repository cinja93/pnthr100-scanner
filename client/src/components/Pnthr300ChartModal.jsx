import { useState, useEffect, useRef } from 'react';
import { createChart, BarSeries, CandlestickSeries, LineSeries } from 'lightweight-charts';
import { fetchPnthrAi300Latest, fetchPnthrAi300Bars } from '../services/api';
import pantherHead from '../assets/panther head.png';

// Pnthr300ChartModal — dedicated chart for the PNTHR AI 300 (PAI300).
//
// OHLC candlesticks + 21D/21W EMA overlay. Daily/Weekly toggle. Pulled from
// /api/pnthr-ai-300/bars. No signal detection / drawing tools (those are
// 679-stock concerns); this is a pure index chart.

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
  const [timeframe, setTimeframe] = useState('weekly');
  const [chartType, setChartType] = useState('bars');  // 'bars' (OHLC) or 'candles'
  const [latest, setLatest] = useState(null);
  const [bars, setBars] = useState([]);
  const [emaPeriod, setEmaPeriod] = useState(21);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const containerRef = useRef(null);

  // Fetch latest snapshot once
  useEffect(() => {
    let cancelled = false;
    fetchPnthrAi300Latest()
      .then(d => { if (!cancelled) setLatest(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Fetch bars on mount + when timeframe changes
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

  // Render lightweight-chart whenever bars change
  useEffect(() => {
    if (!containerRef.current || bars.length === 0) return;

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: { background: { color: '#0c0c0c' }, textColor: '#d4d4d4', attributionLogo: false },
      grid: { vertLines: { color: '#1f1f1f' }, horzLines: { color: '#1f1f1f' } },
      rightPriceScale: { borderColor: '#333' },
      timeScale: { borderColor: '#333', timeVisible: timeframe === 'daily' },
      crosshair: { mode: 1 },
    });

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
      priceLineVisible: false, lastValueVisible: true,
      title: `${emaPeriod}${timeframe === 'weekly' ? 'W' : 'D'} EMA`,
    });

    priceSeries.setData(bars.map(b => ({
      time: b.date, open: b.open, high: b.high, low: b.low, close: b.close,
    })));
    ema.setData(bars
      .filter(b => b.ema != null)
      .map(b => ({ time: b.date, value: b.ema })));

    chart.timeScale().fitContent();

    return () => chart.remove();
  }, [bars, timeframe, emaPeriod, chartType]);

  const dayChange = latest?.dayChangePct;
  const dayChangeClass = dayChange == null ? '' : dayChange >= 0 ? 'pos' : 'neg';
  const regimeColor = latest?.regime === 'bull' ? '#16a34a' : '#dc2626';

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
                <span
                  style={{
                    color: dayChangeClass === 'pos' ? '#16a34a' : dayChangeClass === 'neg' ? '#dc2626' : '#888',
                    fontSize: 14, fontWeight: 600, fontFamily: 'monospace',
                  }}
                >
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
                <span>21D EMA <strong style={{ color: '#fcf000' }}>{fmtNum(latest.ema21D)}</strong></span>
                <span>21W EMA <strong style={{ color: '#fcf000' }}>{fmtNum(latest.ema21W)}</strong></span>
              </div>
            </>
          )}

          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
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
          {/* Panther head watermark — fixed top-left of chart canvas */}
          <img
            src={pantherHead}
            alt="PNTHR"
            style={{
              position: 'absolute', top: 12, left: 12, width: 36, height: 36,
              opacity: 0.85, zIndex: 2, pointerEvents: 'none',
              filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.6))',
            }}
          />
          {loading && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888', zIndex: 3 }}>Loading…</div>}
          {error && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#dc2626', zIndex: 3 }}>{error}</div>}
          <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
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
