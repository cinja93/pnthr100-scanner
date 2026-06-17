// PNTHR New Highs — stocks at a NEW intraday high, split by universe:
//   Carnivore (679) on the left at a 4-week high · AI 300 on the right at a 42-week high.
// Lows removed (2026-06-17): shorting new lows backtested as a money-loser in every regime,
// so the page is long-side only. Each column shows the backtest metrics for buying that signal.
// Badges are clickable to open the chart.
import { useState, useEffect, useCallback } from 'react';
import { fetchNewHighsLows } from '../services/api';
import PageHeader from './PageHeader';
import AiTickerChartModal from './AiTickerChartModal';

const GREEN = { bg: 'rgba(34,197,94,0.14)', border: 'rgba(34,197,94,0.55)', text: '#86efac' };

// Backtest metrics for buying each new-high signal (hypothetical, survivorship-flattered — see desc).
const CARN_METRICS = {
  period: '2019 → 2026 · full history, incl. COVID + the 2022 bear',
  rows: [
    ['Net return', '+1,115%'], ['CAGR', '40.4%'], ['Sharpe', '1.00'], ['Sortino', '1.42'],
    ['Profit factor', '1.51x'], ['Calmar', '0.77'], ['Max drawdown', '52.5%'],
    ['Win rate', '41%'], ['Trades', '2,081'], ['vs SPY', 'SPY +173%'],
  ],
  desc: 'Current S&P 500 + S&P 400 (MidCap) members making a NEW 4-week high today. The backtest buys each new 4-week high and trails a 2-week-low stop (2% NAV risk / 10% cap per name, 2× gross cap). Hypothetical & survivorship-flattered (current members only); not a track record.',
};
const AI_METRICS = {
  period: '2023-01-03 → 2026-06-11 · the live PNTHR Tree window',
  rows: [
    ['Net return', '+1,005%'], ['CAGR', '101.2%'], ['Sharpe', '1.48'], ['Sortino', '2.18'],
    ['Profit factor', '2.16x'], ['Calmar', '2.06'], ['Max drawdown', '49.2%'],
    ['Win rate', '44%'], ['Trades', '933'], ['vs SPY', 'SPY +94%'],
  ],
  desc: 'Current PNTHR AI-300 index members making a NEW 42-week high today — this is the live PNTHR Tree entry signal. Same 2-week-low trailing stop & sizing. Hypothetical & survivorship-flattered; frozen at go-live. Not a track record.',
};

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

function MetricsBlock({ metrics }) {
  return (
    <div style={{ background: '#0b0b0b', border: '1px solid #1c2a1c', borderRadius: 8, padding: '10px 12px', marginBottom: 12 }}>
      <div style={{ color: '#86efac', fontSize: 10, fontWeight: 800, letterSpacing: '0.06em', marginBottom: 2 }}>BACKTEST · BUY THIS SIGNAL</div>
      <div style={{ color: '#666', fontSize: 10, marginBottom: 8 }}>{metrics.period}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(82px, 1fr))', gap: 6 }}>
        {metrics.rows.map(([label, value], i) => (
          <div key={i} style={{ background: '#121212', border: '1px solid #222', borderRadius: 6, padding: '5px 8px' }}>
            <div style={{ color: '#888', fontSize: 9, letterSpacing: '0.04em', textTransform: 'uppercase', lineHeight: 1.2 }}>{label}</div>
            <div style={{ color: value.startsWith('+') ? '#22c55e' : '#e6e6e6', fontSize: 14, fontWeight: 700, fontFamily: 'monospace' }}>{value}</div>
          </div>
        ))}
      </div>
      <div style={{ color: '#777', fontSize: 10, marginTop: 8, lineHeight: 1.4 }}>{metrics.desc}</div>
    </div>
  );
}

function Column({ title, subtitle, metrics, data, onPick }) {
  const weeks = data?.lookbackWeeks;
  const highs = data?.highs || [];
  return (
    <div style={{ flex: 1, minWidth: 0, background: '#0d0d0d', border: '1px solid #222', borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ color: '#e6e6e6', fontWeight: 700, fontSize: 14 }}>{title}</div>
      <div style={{ color: '#666', fontSize: 11, marginBottom: 12 }}>{subtitle}</div>
      <MetricsBlock metrics={metrics} />
      <div style={{ color: GREEN.text, fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', marginBottom: 6 }}>
        {weeks ? `NEW ${weeks}-WEEK HIGHS` : 'NEW HIGHS'} · {highs.length}
      </div>
      {highs.length === 0 ? (
        <div style={{ color: '#555', fontSize: 12 }}>none today</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {highs.map((it, i) => <Badge key={it.ticker} item={it} tone={GREEN} onClick={() => onPick(highs.map(x => x.ticker), i)} />)}
        </div>
      )}
    </div>
  );
}

export default function NewHighsLowsPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [chart, setChart] = useState(null); // { tickers, index }

  const load = useCallback(async () => {
    try { setData(await fetchNewHighsLows()); setError(null); }
    catch (e) { setError(e.message); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); const id = setInterval(load, 60000); return () => clearInterval(id); }, [load]);

  // Both universes use the SAME modern daily+weekly chart modal (auto-detects AI-300 vs 679/ETF).
  const openChart = (tickers, index) => setChart({ tickers, index });

  return (
    <div style={{ padding: '0 4px' }}>
      <PageHeader
        title="New Highs"
        description="Stocks making a NEW intraday high today. Carnivore (679) at a 4-week high on the left, AI 300 at a 42-week high on the right — the lookbacks that backtested best for each. Click any badge to chart it."
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
          <Column title="Carnivore" subtitle="S&P 500 + S&P 400 (MidCap) · 4-week high" metrics={CARN_METRICS} data={data?.carnivore} onPick={openChart} />
          <Column title="AI 300" subtitle="PNTHR AI Universe · 42-week high" metrics={AI_METRICS} data={data?.ai300} onPick={openChart} />
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
