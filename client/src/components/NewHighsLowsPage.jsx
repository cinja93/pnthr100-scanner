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
  dates: '2019-02-01 → 2026-06-11',
  window: '~7.3 yrs · full history — COVID crash, the 2022 bear, and the AI bull',
  scan: 'LIVE: current S&P 500 + S&P 400 (MidCap) members whose intraday high today has reached a NEW 4-week high (≥ the highest high of the prior 20 trading days, today excluded).',
  rows: [
    ['Net return', '+1,115%'], ['CAGR', '40.4%'], ['Sharpe', '1.00'], ['Sortino', '1.42'],
    ['Profit factor', '1.51x'], ['Calmar', '0.77'], ['Max drawdown', '52.5%'],
    ['Win rate', '41%'], ['Trades', '2,081'], ['vs SPY', 'SPY +173%'],
  ],
  specs: [
    'Entry — buy the breakout: resting buy-stop at the prior 4-week high + $0.01 (fills at the level, or the open on a gap-through; no look-ahead)',
    'Exit — trailing stop at the lowest low of the prior 10 trading days (2 weeks) − $0.01, ratcheted up; exit when the day breaks it',
    'Sizing — 2% of NAV risked per name (off the stop), capped at 10% of NAV per name · 2× gross cap',
    'Costs — IBKR commission + 5 bps slippage per leg',
    'Universe — current members only → SURVIVORSHIP-FLATTERED. Hypothetical backtest on $100K, not a track record.',
  ],
};
const AI_METRICS = {
  dates: '2023-01-03 → 2026-06-11',
  window: '~3.45 yrs · the live PNTHR Tree window (AI-300 data begins 2022, so this is a shorter, mostly-bull window — not directly comparable to Carnivore’s full cycle)',
  scan: 'LIVE: current PNTHR AI-300 index members whose intraday high today has reached a NEW 42-week high (≥ the highest high of the prior 210 trading days, today excluded). This is the live PNTHR Tree entry signal.',
  rows: [
    ['Net return', '+1,005%'], ['CAGR', '101.2%'], ['Sharpe', '1.48'], ['Sortino', '2.18'],
    ['Profit factor', '2.16x'], ['Calmar', '2.06'], ['Max drawdown', '49.2%'],
    ['Win rate', '44%'], ['Trades', '933'], ['vs SPY', 'SPY +94%'],
  ],
  specs: [
    'Entry — buy the breakout: resting buy-stop at the prior 42-week high + $0.01 (fills at the level, or the open on a gap-through; no look-ahead)',
    'Exit — trailing stop at the lowest low of the prior 10 trading days (2 weeks) − $0.01, ratcheted up; exit when the day breaks it',
    'Sizing — 2% of NAV risked per name (off the stop), capped at 10% of NAV per name · 2× gross cap',
    'Costs — IBKR commission + 5 bps slippage per leg',
    'Universe — current AI-300 members only → SURVIVORSHIP-FLATTERED. Hypothetical backtest on $100K, frozen at go-live. Not a track record.',
  ],
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
      {/* What the column is showing, live */}
      <div style={{ color: '#86efac', fontSize: 10, fontWeight: 800, letterSpacing: '0.06em', marginBottom: 2 }}>LOOKING AT (LIVE)</div>
      <div style={{ color: '#aaa', fontSize: 11, marginBottom: 10, lineHeight: 1.45 }}>{metrics.scan}</div>
      {/* Backtest period + metrics */}
      <div style={{ color: '#86efac', fontSize: 10, fontWeight: 800, letterSpacing: '0.06em' }}>BACKTEST · BUY THIS SIGNAL</div>
      <div style={{ color: '#888', fontSize: 11, fontFamily: 'monospace', margin: '2px 0 1px' }}>Dates: <b style={{ color: '#ccc' }}>{metrics.dates}</b></div>
      <div style={{ color: '#666', fontSize: 10, marginBottom: 8, lineHeight: 1.4 }}>{metrics.window}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(82px, 1fr))', gap: 6 }}>
        {metrics.rows.map(([label, value], i) => (
          <div key={i} style={{ background: '#121212', border: '1px solid #222', borderRadius: 6, padding: '5px 8px' }}>
            <div style={{ color: '#888', fontSize: 9, letterSpacing: '0.04em', textTransform: 'uppercase', lineHeight: 1.2 }}>{label}</div>
            <div style={{ color: value.startsWith('+') ? '#22c55e' : '#e6e6e6', fontSize: 14, fontWeight: 700, fontFamily: 'monospace' }}>{value}</div>
          </div>
        ))}
      </div>
      {/* The exact rules that produced those metrics */}
      <div style={{ color: '#86efac', fontSize: 10, fontWeight: 800, letterSpacing: '0.06em', marginTop: 10, marginBottom: 4 }}>SPECS</div>
      <ul style={{ margin: 0, paddingLeft: 16, color: '#888', fontSize: 10, lineHeight: 1.5 }}>
        {metrics.specs.map((s, i) => <li key={i}>{s}</li>)}
      </ul>
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
