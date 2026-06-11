// PNTHR New Highs/Lows — stocks at a NEW intraday 52-week high (green) or low (red),
// split into two columns: Carnivore (679) on the left, AI 300 on the right.
// Highs listed first, then lows. Badges are clickable to open the chart.
import { useState, useEffect, useCallback } from 'react';
import { fetchNewHighsLows } from '../services/api';
import PageHeader from './PageHeader';
import ChartModal from './ChartModal';
import AiTickerChartModal from './AiTickerChartModal';

const GREEN = { bg: 'rgba(34,197,94,0.14)', border: 'rgba(34,197,94,0.55)', text: '#86efac' };
const RED = { bg: 'rgba(239,68,68,0.14)', border: 'rgba(239,68,68,0.55)', text: '#fca5a5' };

function Badge({ item, tone, onClick }) {
  return (
    <span
      onClick={onClick}
      title={`${item.ticker} — $${(+item.price).toFixed(2)} (${item.changePct >= 0 ? '+' : ''}${(+item.changePct).toFixed(1)}%) · click to chart`}
      style={{
        display: 'inline-flex', alignItems: 'baseline', gap: 6, cursor: 'pointer',
        background: tone.bg, border: `1px solid ${tone.border}`, color: tone.text,
        borderRadius: 6, padding: '4px 9px', fontSize: 13, fontWeight: 700, fontFamily: 'monospace',
      }}
    >
      {item.ticker}
      <span style={{ fontSize: 10, fontWeight: 600, opacity: 0.75 }}>${(+item.price).toFixed(2)}</span>
    </span>
  );
}

function Group({ label, items, tone, onPick }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ color: tone.text, fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', marginBottom: 6 }}>
        {label} · {items.length}
      </div>
      {items.length === 0 ? (
        <div style={{ color: '#555', fontSize: 12 }}>none today</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {items.map((it, i) => <Badge key={it.ticker} item={it} tone={tone} onClick={() => onPick(items.map(x => x.ticker), i)} />)}
        </div>
      )}
    </div>
  );
}

function Column({ title, subtitle, data, onPick }) {
  return (
    <div style={{ flex: 1, minWidth: 0, background: '#0d0d0d', border: '1px solid #222', borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ color: '#e6e6e6', fontWeight: 700, fontSize: 14 }}>{title}</div>
      <div style={{ color: '#666', fontSize: 11, marginBottom: 12 }}>{subtitle}</div>
      <Group label="NEW 52-WEEK HIGHS" items={data?.highs || []} tone={GREEN} onPick={onPick} />
      <Group label="NEW 52-WEEK LOWS" items={data?.lows || []} tone={RED} onPick={onPick} />
    </div>
  );
}

export default function NewHighsLowsPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [chart, setChart] = useState(null); // { universe, tickers, index }

  const load = useCallback(async () => {
    try { setData(await fetchNewHighsLows()); setError(null); }
    catch (e) { setError(e.message); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); const id = setInterval(load, 60000); return () => clearInterval(id); }, [load]);

  const openCarn = (tickers, index) => setChart({ universe: 'carnivore', tickers, index });
  const openAi = (tickers, index) => setChart({ universe: 'ai300', tickers, index });

  return (
    <div style={{ padding: '0 4px' }}>
      <PageHeader
        title="New Highs/Lows"
        description="Stocks at a NEW intraday 52-week high (green) or low (red). Carnivore (679) on the left, AI 300 on the right — highs first, then lows. Click any badge to chart it."
      />
      {data?.updatedAt && (
        <div style={{ color: '#555', fontSize: 11, margin: '0 0 12px' }}>
          Updated {new Date(data.updatedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' })} ET · auto-refreshes every 60s
        </div>
      )}
      {loading && !data ? (
        <div style={{ color: '#666', padding: 20 }}>Loading…</div>
      ) : error ? (
        <div style={{ color: '#ef4444', padding: 20 }}>Error: {error}</div>
      ) : (
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          <Column title="Carnivore" subtitle="S&P 500 + S&P 400 (679 universe)" data={data?.carnivore} onPick={openCarn} />
          <Column title="AI 300" subtitle="PNTHR AI Universe" data={data?.ai300} onPick={openAi} />
        </div>
      )}

      {chart && chart.universe === 'carnivore' && (
        <ChartModal
          stocks={chart.tickers.map(t => ({ ticker: t }))}
          initialIndex={chart.index}
          earnings={{}}
          onClose={() => setChart(null)}
        />
      )}
      {chart && chart.universe === 'ai300' && (
        <AiTickerChartModal
          tickers={chart.tickers}
          initialIndex={chart.index}
          onClose={() => setChart(null)}
        />
      )}
    </div>
  );
}
