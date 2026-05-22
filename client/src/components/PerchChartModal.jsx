import { useState, useEffect, useRef, useCallback } from 'react';
import { createChart, CandlestickSeries, LineSeries, createSeriesMarkers } from 'lightweight-charts';
import { fetchAiStockChartData } from '../services/api';
import pantherHead from '../assets/panther head.png';

function PerchChartModal({ ticker, featuredTrade, onClose }) {
  const containerRef   = useRef(null);
  const chartRef       = useRef(null);
  const markersRef     = useRef(null);
  const overlayRef     = useRef(null);
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    if (!ticker) return;
    setLoading(true);
    setError(null);
    fetchAiStockChartData(ticker)
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [ticker]);

  // Find entry→exit pair from weekly signals (Perch = weekly trades)
  const tradePair = useCallback(() => {
    if (!data?.ok) return null;
    const signals = data.weekly?.signals || [];
    if (signals.length === 0) return null;

    const sorted = [...signals].sort((a, b) => a.time.localeCompare(b.time));
    // Walk backward to find the last entry + its exit
    for (let i = sorted.length - 1; i >= 0; i--) {
      const ev = sorted[i];
      if (ev.signal === 'BE' || ev.signal === 'SE') {
        // Find its matching entry before it
        const exitType = ev.signal;
        const entryType = exitType === 'BE' ? 'BL' : 'SS';
        for (let j = i - 1; j >= 0; j--) {
          if (sorted[j].signal === entryType) {
            return { entry: sorted[j], exit: ev };
          }
        }
      }
    }
    // Fallback: try daily signals if weekly didn't have a complete pair
    const dailySigs = data.daily?.signals || [];
    if (dailySigs.length === 0) return null;
    const dailySorted = [...dailySigs].sort((a, b) => a.time.localeCompare(b.time));
    for (let i = dailySorted.length - 1; i >= 0; i--) {
      const ev = dailySorted[i];
      if (ev.signal === 'BE' || ev.signal === 'SE') {
        const entryType = ev.signal === 'BE' ? 'BL' : 'SS';
        for (let j = i - 1; j >= 0; j--) {
          if (dailySorted[j].signal === entryType) {
            return { entry: dailySorted[j], exit: ev, daily: true };
          }
        }
      }
    }
    return null;
  }, [data]);

  // Draw chart
  useEffect(() => {
    if (!containerRef.current || !data?.ok) return;

    const pair = tradePair();
    const useDailyBars = pair?.daily;
    const bars = useDailyBars ? (data.daily?.bars || []) : (data.weekly?.bars || []);
    const signals = useDailyBars ? (data.daily?.signals || []) : (data.weekly?.signals || []);
    if (bars.length === 0) return;

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { color: '#0a0a0a' },
        textColor: '#888',
        attributionLogo: false,
        fontSize: 10,
      },
      grid: {
        vertLines: { color: '#141414' },
        horzLines: { color: '#141414' },
      },
      rightPriceScale: { borderColor: '#222' },
      timeScale: {
        borderColor: '#222',
        barSpacing: useDailyBars ? 10 : 14,
        rightOffset: 3,
      },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;

    const priceSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#16a34a', downColor: '#dc2626',
      borderUpColor: '#16a34a', borderDownColor: '#dc2626',
      wickUpColor: '#16a34a', wickDownColor: '#dc2626',
      priceLineVisible: false,
    });

    const ema = chart.addSeries(LineSeries, {
      color: '#fcf000', lineWidth: 2,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });

    priceSeries.setData(bars.map(b => ({
      time: b.date, open: b.open, high: b.high, low: b.low, close: b.close,
    })));
    ema.setData(bars.filter(b => b.ema != null).map(b => ({ time: b.date, value: b.ema })));

    // Signal markers — show the trade pair
    if (pair) {
      const markers = [];
      const { entry, exit } = pair;

      if (entry.signal === 'BL') {
        markers.push({ time: entry.time, position: 'belowBar', color: '#16a34a', shape: 'arrowUp', text: 'BL', size: 2 });
      } else {
        markers.push({ time: entry.time, position: 'aboveBar', color: '#dc2626', shape: 'arrowDown', text: 'SS', size: 2 });
      }

      if (exit.signal === 'BE') {
        markers.push({ time: exit.time, position: 'aboveBar', color: '#f59e0b', shape: 'square', text: 'BE', size: 2 });
      } else {
        markers.push({ time: exit.time, position: 'belowBar', color: '#f59e0b', shape: 'square', text: 'SE', size: 2 });
      }

      markersRef.current = createSeriesMarkers(priceSeries, markers);

      // Scroll to show the trade in context — center between entry and exit
      const entryIdx = bars.findIndex(b => b.date === entry.time);
      const exitIdx = bars.findIndex(b => b.date === exit.time);
      if (entryIdx >= 0 && exitIdx >= 0) {
        const contextBars = 6;
        const from = Math.max(0, entryIdx - contextBars);
        const to = Math.min(bars.length - 1, exitIdx + contextBars);
        chart.timeScale().setVisibleRange({
          from: bars[from].date,
          to: bars[to].date,
        });
      }
    } else if (signals.length > 0) {
      // No complete pair — show last few signals
      const sorted = [...signals].sort((a, b) => a.time.localeCompare(b.time));
      const recent = sorted.slice(-2);
      const markers = recent.map(ev => {
        if (ev.signal === 'BL') return { time: ev.time, position: 'belowBar', color: '#16a34a', shape: 'arrowUp', text: 'BL', size: 2 };
        if (ev.signal === 'SS') return { time: ev.time, position: 'aboveBar', color: '#dc2626', shape: 'arrowDown', text: 'SS', size: 2 };
        if (ev.signal === 'BE') return { time: ev.time, position: 'aboveBar', color: '#f59e0b', shape: 'square', text: 'BE', size: 2 };
        return { time: ev.time, position: 'belowBar', color: '#f59e0b', shape: 'square', text: 'SE', size: 2 };
      });
      markersRef.current = createSeriesMarkers(priceSeries, markers);
    }

    // Draw the win highlight overlay + profit annotation after chart renders
    requestAnimationFrame(() => drawOverlay(chart, priceSeries, bars, pair));

    const handleResize = () => requestAnimationFrame(() => drawOverlay(chart, priceSeries, bars, pair));
    chart.timeScale().subscribeVisibleTimeRangeChange(handleResize);

    return () => {
      chart.timeScale().unsubscribeVisibleTimeRangeChange(handleResize);
      chart.remove();
      chartRef.current = null;
    };
  }, [data, tradePair]);

  function drawOverlay(chart, priceSeries, bars, pair) {
    const canvas = overlayRef.current;
    if (!canvas || !chart) return;

    const container = containerRef.current;
    if (!container) return;
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!pair) return;
    const { entry, exit } = pair;

    const entryBar = bars.find(b => b.date === entry.time);
    const exitBar = bars.find(b => b.date === exit.time);
    if (!entryBar || !exitBar) return;

    const entryX = chart.timeScale().timeToCoordinate(entry.time);
    const exitX = chart.timeScale().timeToCoordinate(exit.time);
    if (entryX == null || exitX == null) return;

    const isLong = entry.signal === 'BL';
    const entryPrice = isLong
      ? parseFloat((entryBar.high + 0.01).toFixed(2))
      : parseFloat((entryBar.low - 0.01).toFixed(2));

    // Win band — subtle gradient alongside the bars
    const bandWidth = 6;
    const x1 = Math.min(entryX, exitX) - 20;
    const x2 = Math.max(entryX, exitX) + 20;
    const topPrice = Math.max(entryBar.high, exitBar.high) * 1.01;
    const botPrice = Math.min(entryBar.low, exitBar.low) * 0.99;
    const topY = priceSeries.priceToCoordinate(topPrice);
    const botY = priceSeries.priceToCoordinate(botPrice);

    if (topY != null && botY != null) {
      // Vertical bracket line on the right side
      const bracketX = x2 + 12;
      const profitColor = 'rgba(22, 163, 106, 0.7)';

      // Vertical line
      ctx.strokeStyle = profitColor;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(bracketX, topY);
      ctx.lineTo(bracketX, botY);
      ctx.stroke();

      // Top cap
      ctx.beginPath();
      ctx.moveTo(bracketX - 6, topY);
      ctx.lineTo(bracketX, topY);
      ctx.stroke();

      // Bottom cap
      ctx.beginPath();
      ctx.moveTo(bracketX - 6, botY);
      ctx.lineTo(bracketX, botY);
      ctx.stroke();

      // Subtle highlight band between entry and exit bars
      const gradient = ctx.createLinearGradient(x1, 0, x2, 0);
      gradient.addColorStop(0, 'rgba(22, 163, 106, 0)');
      gradient.addColorStop(0.2, 'rgba(22, 163, 106, 0.04)');
      gradient.addColorStop(0.8, 'rgba(22, 163, 106, 0.04)');
      gradient.addColorStop(1, 'rgba(22, 163, 106, 0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(x1, topY, x2 - x1, botY - topY);
    }

    // Profit annotation near exit
    const profitDollar = featuredTrade?.profitDollar ?? exit.profitDollar;
    const profitPct = featuredTrade?.profitPct ?? exit.profitPct;

    if (profitDollar != null && profitPct != null && topY != null) {
      const annotX = exitX + 8;
      const annotY = topY - 18;

      const dollarStr = `+$${Math.abs(profitDollar).toFixed(2)}/sh`;
      const pctStr = `+${Math.abs(profitPct).toFixed(2)}%`;

      ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, sans-serif';
      const pctWidth = ctx.measureText(pctStr).width;
      ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
      const dollarWidth = ctx.measureText(dollarStr).width;
      const boxWidth = Math.max(pctWidth, dollarWidth) + 16;
      const boxHeight = 38;

      // Position: prefer right of exit bar, but if too close to edge, go left
      let bx = annotX;
      if (bx + boxWidth > canvas.width - 10) bx = exitX - boxWidth - 8;

      // Background pill
      ctx.fillStyle = 'rgba(22, 163, 106, 0.15)';
      ctx.strokeStyle = 'rgba(22, 163, 106, 0.5)';
      ctx.lineWidth = 1;
      const radius = 6;
      ctx.beginPath();
      ctx.moveTo(bx + radius, annotY);
      ctx.lineTo(bx + boxWidth - radius, annotY);
      ctx.quadraticCurveTo(bx + boxWidth, annotY, bx + boxWidth, annotY + radius);
      ctx.lineTo(bx + boxWidth, annotY + boxHeight - radius);
      ctx.quadraticCurveTo(bx + boxWidth, annotY + boxHeight, bx + boxWidth - radius, annotY + boxHeight);
      ctx.lineTo(bx + radius, annotY + boxHeight);
      ctx.quadraticCurveTo(bx, annotY + boxHeight, bx, annotY + boxHeight - radius);
      ctx.lineTo(bx, annotY + radius);
      ctx.quadraticCurveTo(bx, annotY, bx + radius, annotY);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Percent text (large, bold)
      ctx.fillStyle = '#16a34a';
      ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(pctStr, bx + boxWidth / 2, annotY + 16);

      // Dollar text (smaller, below)
      ctx.fillStyle = 'rgba(22, 163, 106, 0.8)';
      ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(dollarStr, bx + boxWidth / 2, annotY + 32);
      ctx.textAlign = 'start';
    }
  }

  // Keyboard: Escape to close
  useEffect(() => {
    function handleKey(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const companyName = data?.name || featuredTrade?.companyName || ticker;
  const direction = featuredTrade?.direction || (tradePair()?.entry?.signal === 'BL' ? 'LONG' : 'SHORT');
  const dirColor = direction === 'LONG' || direction === 'long' ? '#16a34a' : '#dc2626';
  const dirLabel = direction === 'LONG' || direction === 'long' ? 'LONG' : 'SHORT';

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 9999, padding: 20,
      }}
    >
      <div style={{
        background: '#0a0a0a', borderRadius: 10, width: '100%', maxWidth: 1100,
        height: '75vh', display: 'flex', flexDirection: 'column',
        border: '1px solid #1a1a1a', boxShadow: '0 24px 80px rgba(0,0,0,0.8)',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 24px', borderBottom: '1px solid #1a1a1a',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <img src={pantherHead} alt="PNTHR" style={{ width: 32, height: 32, opacity: 0.9 }} />
            <div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <span style={{
                  color: '#fcf000', fontSize: 24, fontWeight: 800,
                  letterSpacing: '0.03em', fontFamily: 'monospace',
                }}>
                  {ticker}
                </span>
                <span style={{
                  fontSize: 9, fontWeight: 800, padding: '2px 8px', borderRadius: 3,
                  background: dirColor, color: '#fff', letterSpacing: '0.08em',
                }}>
                  {dirLabel}
                </span>
                {data?.ok && (
                  <span style={{ color: '#888', fontSize: 14 }}>
                    ${data.currentPrice?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                )}
              </div>
              <div style={{ color: '#555', fontSize: 12, marginTop: 2 }}>
                {companyName}{data?.sectorName ? ` · ${data.sectorName}` : ''}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{
              color: '#333', fontSize: 10, fontWeight: 700,
              letterSpacing: '0.15em', textTransform: 'uppercase',
            }}>
              PNTHR TRADE OF THE WEEK
            </span>
            <button
              onClick={onClose}
              style={{
                background: 'transparent', border: '1px solid #222', borderRadius: 4,
                color: '#666', padding: '5px 9px', cursor: 'pointer', fontSize: 12,
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Chart body */}
        <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
          {loading && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#555' }}>
              Loading {ticker}…
            </div>
          )}
          {error && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#dc2626' }}>
              {error}
            </div>
          )}

          {/* Watermark — PNTHR head logo, center of chart area */}
          <img
            src={pantherHead}
            alt=""
            style={{
              position: 'absolute',
              top: '50%', left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 180, height: 180,
              opacity: 0.06,
              pointerEvents: 'none',
              zIndex: 2,
              filter: 'grayscale(100%) brightness(2)',
            }}
          />

          {/* Chart container */}
          <div ref={containerRef} style={{ position: 'absolute', inset: 0, zIndex: 1 }} />

          {/* Overlay canvas for win highlight + profit annotation */}
          <canvas
            ref={overlayRef}
            style={{
              position: 'absolute', inset: 0, zIndex: 3,
              pointerEvents: 'none',
            }}
          />
        </div>

        {/* Footer */}
        <div style={{
          padding: '8px 24px', borderTop: '1px solid #1a1a1a',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ color: '#333', fontSize: 10, fontFamily: 'monospace' }}>
            PNTHR PERCH · Weekly Intelligence
          </span>
          <span style={{ color: '#222', fontSize: 9 }}>
            pnthrfunds.com
          </span>
        </div>
      </div>
    </div>
  );
}

export default PerchChartModal;
