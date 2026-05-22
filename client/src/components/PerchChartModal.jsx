import { useState, useEffect, useRef, useCallback } from 'react';
import { createChart, BarSeries, LineSeries, createSeriesMarkers } from 'lightweight-charts';
import { fetchAiStockChartData } from '../services/api';
import pantherHead from '../assets/panther head.png';

function PerchChartModal({ ticker, featuredTrade, onClose }) {
  const containerRef   = useRef(null);
  const chartRef       = useRef(null);
  const priceSeriesRef = useRef(null);
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

  const findTradePair = useCallback(() => {
    if (!data?.ok) return null;
    const signals = data.weekly?.signals || [];
    if (signals.length === 0) return null;
    const sorted = [...signals].sort((a, b) => a.time.localeCompare(b.time));
    for (let i = sorted.length - 1; i >= 0; i--) {
      const ev = sorted[i];
      if (ev.signal === 'BE' || ev.signal === 'SE') {
        const entryType = ev.signal === 'BE' ? 'BL' : 'SS';
        for (let j = i - 1; j >= 0; j--) {
          if (sorted[j].signal === entryType) {
            return { entry: sorted[j], exit: ev };
          }
        }
      }
    }
    return null;
  }, [data]);

  useEffect(() => {
    if (!containerRef.current || !data?.ok) return;

    const bars = data.weekly?.bars || [];
    if (bars.length === 0) return;

    const pair = findTradePair();

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { color: '#0a0a0a' },
        textColor: '#888',
        attributionLogo: false,
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#141414' },
        horzLines: { color: '#141414' },
      },
      rightPriceScale: { borderColor: '#222' },
      timeScale: {
        borderColor: '#222',
        barSpacing: 12,
        rightOffset: 5,
      },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;

    const priceSeries = chart.addSeries(BarSeries, {
      upColor: '#16a34a', downColor: '#dc2626',
      priceLineVisible: false, lastValueVisible: true,
      openVisible: true, thinBars: false,
    });
    priceSeriesRef.current = priceSeries;

    const ema = chart.addSeries(LineSeries, {
      color: '#fcf000', lineWidth: 2,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });

    priceSeries.setData(bars.map(b => ({
      time: b.date, open: b.open, high: b.high, low: b.low, close: b.close,
    })));
    ema.setData(bars.filter(b => b.ema != null).map(b => ({ time: b.date, value: b.ema })));

    if (pair) {
      const { entry, exit } = pair;
      const markers = [];
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
    }

    const drawAll = () => requestAnimationFrame(() => drawOverlay(chart, priceSeries, bars, pair));
    drawAll();
    chart.timeScale().subscribeVisibleTimeRangeChange(drawAll);

    return () => {
      chart.timeScale().unsubscribeVisibleTimeRangeChange(drawAll);
      chart.remove();
      chartRef.current = null;
    };
  }, [data, findTradePair]);

  function drawOverlay(chart, priceSeries, bars, pair) {
    const canvas = overlayRef.current;
    const container = containerRef.current;
    if (!canvas || !chart || !container) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = container.clientWidth * dpr;
    canvas.height = container.clientHeight * dpr;
    canvas.style.width = container.clientWidth + 'px';
    canvas.style.height = container.clientHeight + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, container.clientWidth, container.clientHeight);

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

    const entryY = priceSeries.priceToCoordinate(entryPrice);
    const exitPrice = isLong
      ? parseFloat((exitBar.low - 0.01).toFixed(2))
      : parseFloat((exitBar.high + 0.01).toFixed(2));
    const exitY = priceSeries.priceToCoordinate(exitPrice);

    // ── Connecting line from entry to exit ──
    if (entryY != null && exitY != null) {
      const lineY = isLong
        ? priceSeries.priceToCoordinate(Math.min(entryBar.low, exitBar.low) * 0.98)
        : priceSeries.priceToCoordinate(Math.max(entryBar.high, exitBar.high) * 1.02);

      if (lineY != null) {
        ctx.strokeStyle = 'rgba(22, 163, 106, 0.5)';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);

        // Horizontal dashed line below/above bars
        ctx.beginPath();
        ctx.moveTo(entryX, lineY);
        ctx.lineTo(exitX, lineY);
        ctx.stroke();

        // Vertical ticks at each end
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(entryX, lineY - 8);
        ctx.lineTo(entryX, lineY + 8);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(exitX, lineY - 8);
        ctx.lineTo(exitX, lineY + 8);
        ctx.stroke();
      }
    }

    // ── Entry label: "BUY @ $XXX.XX" ──
    {
      const labelText = `BUY @ $${entryPrice.toFixed(2)}`;
      ctx.font = 'bold 15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      const tw = ctx.measureText(labelText).width;
      const padX = 10, padY = 6;
      const boxW = tw + padX * 2;
      const boxH = 24;

      const belowEntry = priceSeries.priceToCoordinate(entryBar.low);
      if (belowEntry != null) {
        const lx = entryX - boxW / 2;
        const ly = belowEntry + 32;

        ctx.fillStyle = 'rgba(22, 163, 106, 0.2)';
        ctx.strokeStyle = '#16a34a';
        ctx.lineWidth = 1.5;
        roundRect(ctx, lx, ly, boxW, boxH, 5);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#22ff66';
        ctx.font = 'bold 15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(labelText, entryX, ly + boxH / 2);
      }
    }

    // ── Exit label: profit block ──
    {
      const profitDollar = featuredTrade?.profitDollar ?? exit.profitDollar;
      const profitPct = featuredTrade?.profitPct ?? exit.profitPct;

      if (profitDollar != null && profitPct != null) {
        const pctStr = `+${Math.abs(profitPct).toFixed(2)}%`;
        const dollarStr = `+$${Math.abs(profitDollar).toFixed(2)} per share`;

        ctx.font = 'bold 20px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        const pctW = ctx.measureText(pctStr).width;
        ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        const dollarW = ctx.measureText(dollarStr).width;
        const boxW = Math.max(pctW, dollarW) + 24;
        const boxH = 52;

        const aboveExit = priceSeries.priceToCoordinate(exitBar.high);
        if (aboveExit != null) {
          let lx = exitX - boxW / 2;
          const ly = aboveExit - boxH - 36;

          // Keep within canvas
          if (lx + boxW > container.clientWidth - 60) lx = container.clientWidth - boxW - 60;
          if (lx < 10) lx = 10;

          ctx.fillStyle = 'rgba(22, 163, 106, 0.15)';
          ctx.strokeStyle = '#16a34a';
          ctx.lineWidth = 1.5;
          roundRect(ctx, lx, ly, boxW, boxH, 6);
          ctx.fill();
          ctx.stroke();

          // Percentage — large, bright green
          ctx.fillStyle = '#22ff66';
          ctx.font = 'bold 20px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(pctStr, lx + boxW / 2, ly + 8);

          // Dollar per share — white, below
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
          ctx.fillText(dollarStr, lx + boxW / 2, ly + 32);

          ctx.textAlign = 'start';
          ctx.textBaseline = 'alphabetic';
        }
      }
    }
  }

  useEffect(() => {
    function handleKey(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const companyName = data?.name || featuredTrade?.companyName || ticker;
  const direction = featuredTrade?.direction || (findTradePair()?.entry?.signal === 'BL' ? 'LONG' : 'SHORT');
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

          {/* Watermark — PNTHR head logo, large and centered */}
          <img
            src={pantherHead}
            alt=""
            style={{
              position: 'absolute',
              top: '50%', left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 320, height: 320,
              opacity: 0.07,
              pointerEvents: 'none',
              zIndex: 2,
              filter: 'grayscale(50%) brightness(1.5)',
            }}
          />

          <div ref={containerRef} style={{ position: 'absolute', inset: 0, zIndex: 1 }} />

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

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export default PerchChartModal;
