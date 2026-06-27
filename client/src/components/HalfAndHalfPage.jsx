// PNTHR Half and Half — the AI-300 universe split four ways by price vs EMA.
//   LEFT  (shorts): Daily Shorts (price below the daily EMA) · Weekly Shorts (below the weekly EMA)
//   RIGHT (longs):  Daily Longs  (price above the daily EMA) · Weekly Longs  (above the weekly EMA)
// Each box is its own scrollable group: click any ticker to chart it, then use the
// modal's ◀ ▶ (or arrow keys) to scroll through the rest of that box.
import { useState, useEffect, useCallback, useMemo } from 'react';
import { fetchHalfAndHalf } from '../services/api';
import PageHeader from './PageHeader';
import AiTickerChartModal from './AiTickerChartModal';

const SHORT = { bg: 'rgba(239,83,80,0.12)', border: 'rgba(239,83,80,0.55)', text: '#fca5a5', head: '#ef5350' };
const LONG  = { bg: 'rgba(38,166,154,0.12)', border: 'rgba(38,166,154,0.55)', text: '#86efac', head: '#22c55e' };

function Chip({ item, tone, onClick }) {
  const sign = item.distPct >= 0 ? '+' : '';
  return (
    <span
      onClick={onClick}
      title={`${item.ticker} — ${item.name}\n${item.sector}\nprice $${item.price.toFixed(2)} · EMA $${item.ema.toFixed(2)} · ${sign}${item.distPct.toFixed(1)}% from EMA · click to chart`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
        background: tone.bg, border: `1px solid ${tone.border}`, color: tone.text,
        borderRadius: 6, padding: '4px 9px', fontSize: 13, fontWeight: 700, fontFamily: 'monospace',
      }}
    >
      <span>{item.ticker}</span>
      <span style={{ fontSize: 11, fontWeight: 600, opacity: 0.85 }}>${item.price.toFixed(2)}</span>
      <span style={{ background: '#0008', padding: '1px 5px', borderRadius: 5, fontSize: 11, fontWeight: 700 }}>
        {sign}{item.distPct.toFixed(1)}%
      </span>
    </span>
  );
}

function SortToggle({ tone, sort, setSort }) {
  const btn = (mode, label) => (
    <button
      onClick={() => setSort(mode)}
      title={`Sort by ${label}`}
      style={{
        background: sort === mode ? tone.head : 'transparent',
        color: sort === mode ? '#000' : '#888',
        border: 'none', cursor: 'pointer',
        padding: '3px 8px', fontSize: 10, fontWeight: 700, letterSpacing: '0.02em',
        borderLeft: mode === 'longest' ? '1px solid #2a2a2a' : 'none',
      }}
    >
      {label}
    </button>
  );
  return (
    <span style={{ display: 'inline-flex', borderRadius: 4, overflow: 'hidden', border: `1px solid ${tone.border}` }}>
      {btn('shortest', 'Shortest Distance EMA')}
      {btn('longest', 'Longest Distance EMA')}
    </span>
  );
}

function Box({ title, subtitle, tone, rows, onPick }) {
  const [sort, setSort] = useState('shortest'); // 'shortest' = closest to EMA first
  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => sort === 'shortest'
      ? Math.abs(a.distPct) - Math.abs(b.distPct)   // closest to EMA first
      : Math.abs(b.distPct) - Math.abs(a.distPct)); // furthest from EMA first
    return copy;
  }, [rows, sort]);

  return (
    <div style={{ background: '#0d0d0d', border: '1px solid #222', borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 2 }}>
        <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ color: tone.head, fontWeight: 800, fontSize: 14, letterSpacing: '0.04em' }}>{title}</span>
          <span style={{ color: tone.head, fontWeight: 800, fontSize: 13, fontFamily: 'monospace' }}>{rows.length}</span>
        </span>
        <SortToggle tone={tone} sort={sort} setSort={setSort} />
      </div>
      <div style={{ color: '#666', fontSize: 11, marginBottom: 12 }}>{subtitle}</div>
      {sorted.length === 0 ? (
        <div style={{ color: '#555', fontSize: 12 }}>none</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 360, overflowY: 'auto' }}>
          {sorted.map((it, i) => (
            <Chip key={it.ticker} item={it} tone={tone} onClick={() => onPick(sorted.map(r => r.ticker), i)} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function HalfAndHalfPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [chart, setChart] = useState(null); // { tickers, index }

  const load = useCallback(async () => {
    try { setData(await fetchHalfAndHalf()); setError(null); }
    catch (e) { setError(e.message); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); const id = setInterval(load, 60000); return () => clearInterval(id); }, [load]);

  const openChart = (tickers, index) => setChart({ tickers, index });

  return (
    <div style={{ padding: '0 4px' }}>
      <PageHeader
        title="Half and Half"
        description="The AI 300 split by where price sits versus its EMA. SHORTS on the left (price below the EMA), LONGS on the right (price above). Top row is the daily timeframe, bottom row is weekly — the same EMA lines you see on each ticker's chart. Click any name to chart it, then scroll with ◀ ▶ through that box."
      />
      {data?.updatedAt && (
        <div style={{ color: '#555', fontSize: 11, margin: '0 0 12px' }}>
          Updated {new Date(data.updatedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' })} ET · auto-refreshes every 60s · live price vs end-of-day EMA
        </div>
      )}
      {loading && !data ? (
        <div style={{ color: '#666', padding: 20 }}>Loading…</div>
      ) : error ? (
        <div style={{ color: '#ef4444', padding: 20 }}>Error: {error}</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
          {/* Column headers */}
          <div style={{ color: SHORT.head, fontWeight: 800, fontSize: 12, letterSpacing: '0.1em', textAlign: 'center' }}>SHORTS · BELOW EMA</div>
          <div style={{ color: LONG.head,  fontWeight: 800, fontSize: 12, letterSpacing: '0.1em', textAlign: 'center' }}>LONGS · ABOVE EMA</div>

          {/* Top row: daily */}
          <Box title="Daily Shorts" subtitle="Price below the daily EMA" tone={SHORT} rows={data?.dailyShorts || []} onPick={openChart} />
          <Box title="Daily Longs"  subtitle="Price above the daily EMA" tone={LONG}  rows={data?.dailyLongs || []}  onPick={openChart} />

          {/* Bottom row: weekly */}
          <Box title="Weekly Shorts" subtitle="Price below the weekly EMA" tone={SHORT} rows={data?.weeklyShorts || []} onPick={openChart} />
          <Box title="Weekly Longs"  subtitle="Price above the weekly EMA" tone={LONG}  rows={data?.weeklyLongs || []}  onPick={openChart} />
        </div>
      )}

      {chart && (
        <AiTickerChartModal
          tickers={chart.tickers}
          initialIndex={chart.index}
          onClose={() => setChart(null)}
        />
      )}
    </div>
  );
}
