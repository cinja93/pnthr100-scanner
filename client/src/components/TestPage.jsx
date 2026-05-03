import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, BarSeries, LineSeries } from 'lightweight-charts';
import { API_BASE, authHeaders } from '../services/api';

const ROW_HEIGHT = 360;
const CHART_HEIGHT = 320;

const OVERLAYS = [
  { key: 'none',          label: 'None' },
  { key: 'box-breakout',  label: 'Box Breakout (Rule #2)' },
];

export default function TestPage() {
  const [tickers, setTickers]   = useState([]);
  const [overlay, setOverlay]   = useState('box-breakout');
  const [search, setSearch]     = useState('');
  const [loading, setLoading]   = useState(true);
  const [meta, setMeta]         = useState(null);
  const [recomputing, setRecomputing] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(`${API_BASE}/api/test/tickers`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => {
        setTickers(d.tickers || []);
        setMeta(d.meta || null);
      })
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    if (!q) return tickers;
    return tickers.filter(t => t.includes(q));
  }, [tickers, search]);

  async function handleRecompute() {
    if (!confirm(`Recompute the ${overlay} backtest across all tickers? May take 30-60s.`)) return;
    setRecomputing(true);
    try {
      const r = await fetch(`${API_BASE}/api/test/recompute?overlay=${overlay}`, {
        method: 'POST',
        headers: authHeaders(),
      });
      const d = await r.json();
      alert(`Recompute done. ${d.alertsWritten || 0} alerts written across ${d.tickersProcessed || 0} tickers.`);
      window.location.reload();
    } catch (e) {
      alert('Recompute failed: ' + e.message);
    } finally {
      setRecomputing(false);
    }
  }

  return (
    <div style={{ padding: 16, color: '#e0e0e0', minHeight: '100vh' }}>
      {/* Header */}
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
        <select
          value={overlay}
          onChange={e => setOverlay(e.target.value)}
          style={{
            background: '#111', color: '#e0e0e0', border: '1px solid #333',
            borderRadius: 4, padding: '6px 10px', fontSize: 13,
          }}
        >
          {OVERLAYS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <button
          onClick={handleRecompute}
          disabled={recomputing || overlay === 'none'}
          style={{
            background: recomputing ? '#333' : '#fcf000',
            color: recomputing ? '#888' : '#000',
            border: 'none', borderRadius: 4, padding: '6px 14px', fontSize: 12,
            fontWeight: 700, cursor: recomputing ? 'wait' : 'pointer',
          }}
        >
          {recomputing ? 'Recomputing...' : '⟳ Recompute'}
        </button>
      </div>

      {meta?.lastRunAt && (
        <div style={{ fontSize: 10, color: '#666', marginBottom: 8 }}>
          Last backtest run: {new Date(meta.lastRunAt).toLocaleString()} · {meta.alertsTotal || 0} alerts across {meta.tickersTotal || 0} tickers
        </div>
      )}

      {loading && <div style={{ padding: 40, textAlign: 'center', color: '#888' }}>Loading tickers...</div>}

      {!loading && filtered.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', color: '#888' }}>No tickers match.</div>
      )}

      {!loading && filtered.map(ticker => (
        <LazyTickerRow key={ticker} ticker={ticker} overlay={overlay} />
      ))}
    </div>
  );
}

function LazyTickerRow({ ticker, overlay }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (e.isIntersecting) {
          setVisible(true);
          io.disconnect();
        }
      }
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      style={{
        height: ROW_HEIGHT,
        marginBottom: 12,
        background: '#0a0a0a',
        border: '1px solid #222',
        borderRadius: 6,
        padding: 10,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#fcf000' }}>{ticker}</div>
        <div style={{ fontSize: 11, color: '#666' }}>weekly · 5y</div>
      </div>
      {visible
        ? <TickerChart ticker={ticker} overlay={overlay} />
        : <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#444', fontSize: 11 }}>
            scroll to load
          </div>
      }
    </div>
  );
}

function TickerChart({ ticker, overlay }) {
  const containerRef = useRef(null);
  const chartRef     = useRef(null);
  const [data, setData]       = useState(null);
  const [boxes, setBoxes]     = useState(null);
  const [error, setError]     = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`${API_BASE}/api/test/candles?ticker=${ticker}`, { headers: authHeaders() }).then(r => r.json()),
      overlay === 'box-breakout'
        ? fetch(`${API_BASE}/api/test/box-alerts?ticker=${ticker}`, { headers: authHeaders() }).then(r => r.json())
        : Promise.resolve(null),
    ])
      .then(([candles, boxData]) => {
        if (cancelled) return;
        setData(candles?.weekly || []);
        setBoxes(boxData?.boxes || null);
      })
      .catch(e => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [ticker, overlay]);

  useEffect(() => {
    if (!data || !containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width:  containerRef.current.clientWidth,
      height: CHART_HEIGHT,
      layout:     { background: { color: '#0a0a0a' }, textColor: '#888' },
      grid:       { vertLines: { color: '#1a1a1a' }, horzLines: { color: '#1a1a1a' } },
      timeScale:  { borderColor: '#333', timeVisible: false },
      rightPriceScale: { borderColor: '#333' },
    });
    chartRef.current = chart;

    const slice = data.slice(-260); // last ~5 years of weekly bars
    const bars  = slice.map(b => ({
      time:  b.weekOf,
      open:  b.open,
      high:  b.high,
      low:   b.low,
      close: b.close,
    }));

    const series = chart.addSeries(BarSeries, {
      upColor:   '#26a69a',
      downColor: '#ef5350',
    });
    series.setData(bars);

    if (boxes && boxes.length > 0) {
      drawBoxes(chart, boxes, slice);
    }

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [data, boxes]);

  if (error) return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ef5350' }}>Error: {error}</div>;
  if (!data) return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666' }}>Loading {ticker}...</div>;

  return (
    <div style={{ flex: 1, position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: CHART_HEIGHT }} />
      {boxes && boxes.length > 0 && (
        <div style={{
          position: 'absolute', top: 4, right: 8,
          background: 'rgba(0,0,0,0.7)', border: '1px solid #333', borderRadius: 3,
          padding: '2px 6px', fontSize: 10, color: '#888',
        }}>
          {boxes.length} box{boxes.length > 1 ? 'es' : ''}
        </div>
      )}
    </div>
  );
}

// Render each box as a horizontal-line pair (top + bottom) over the box span,
// plus a marker at the breakout point. Lightweight Charts doesn't have a
// native rectangle primitive, so we fake it with two horizontal line segments.
function drawBoxes(chart, boxes, slice) {
  const visibleWeeks = new Set(slice.map(b => b.weekOf));

  for (const box of boxes) {
    const color = box.status === 'broken-up'   ? '#26a69a'
               : box.status === 'broken-down' ? '#ef5350'
               : '#fcf000'; // active

    const startIdx = slice.findIndex(b => b.weekOf >= box.startDate);
    const endWeek  = box.endDate || slice[slice.length - 1].weekOf;
    const endIdx   = slice.findIndex(b => b.weekOf >= endWeek);
    if (startIdx < 0) continue;
    const stopIdx = endIdx < 0 ? slice.length - 1 : endIdx;

    const span = slice.slice(startIdx, stopIdx + 1).map(b => b.weekOf);
    if (span.length < 2) continue;

    // Top line
    const topSeries = chart.addSeries(LineSeries, {
      color, lineWidth: 1, lineStyle: 0,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    topSeries.setData(span.map(t => ({ time: t, value: box.top })));

    // Bottom line
    const botSeries = chart.addSeries(LineSeries, {
      color, lineWidth: 1, lineStyle: 0,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    botSeries.setData(span.map(t => ({ time: t, value: box.bottom })));
  }
}
