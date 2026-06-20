// client/src/components/FundComparisonPage.jsx
// Investor-facing 3-fund comparison: PNTHR Tree (LIVE) vs Elite AI (PAPER) vs
// Ambush V7.6 (PAPER). Refreshes every 10s. Data: GET /api/fund-compare.
// COMPLIANCE: simulated/paper results carry mandatory hypothetical-performance
// disclaimers; the only investor action is a non-binding expression of interest.
import { useState, useEffect, useCallback } from 'react';
import { fetchFundComparison } from '../services/api';

const GREEN = '#22c55e', RED = '#ef4444', BLUE = '#60a5fa', AMBER = '#f59e0b', MUT = '#9a9aa6';
const usd = (n) => (n == null || isNaN(n)) ? '--' : `$${Math.round(n).toLocaleString()}`;
const signed = (n) => (n >= 0 ? '+' : '') + usd(n);
const pctc = (n) => (n >= 0 ? GREEN : RED);

function Badge({ mode }) {
  const live = mode === 'LIVE';
  return (
    <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.4, padding: '2px 8px', borderRadius: 4,
      color: live ? '#04210f' : BLUE, background: live ? GREEN : 'transparent',
      border: live ? `1px solid ${GREEN}` : `1px dashed ${BLUE}` }}>
      {live ? 'LIVE · REAL MONEY' : 'PAPER · SIMULATED'}
    </span>
  );
}

function Row({ label, value, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0', color: MUT }}>
      <span>{label}</span><b style={{ color: color || '#ddd', fontFamily: 'monospace' }}>{value}</b>
    </div>
  );
}

function FundCard({ f, acknowledged, startDate }) {
  const r = f.risk || {};
  const ts = f.tradeStats?.combined || {};
  return (
    <div style={{ flex: 1, minWidth: 300, background: '#0d0d0f', border: `1px solid ${f.simulated ? '#2a2a3a' : '#1e3a26'}`,
      borderTop: `3px solid ${f.mode === 'LIVE' ? GREEN : BLUE}`, borderRadius: 10, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
        <span style={{ fontSize: 16, fontWeight: 800, color: '#fff' }}>{f.name}</span>
        <Badge mode={f.mode} />
      </div>
      <div style={{ fontSize: 11, color: '#777', marginBottom: 12 }}>{f.strategy}</div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 2 }}>
        <span style={{ fontSize: 30, fontWeight: 800, color: pctc(f.returnPct), fontFamily: 'monospace' }}>
          {f.returnPct >= 0 ? '+' : ''}{f.returnPct}%
        </span>
        <span style={{ fontSize: 13, color: MUT }}>since {startDate || 'start'}</span>
      </div>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>Equity {usd(f.currentEquity)} · from {usd(f.baselineNav)} baseline</div>

      <Row label={`P&L since ${startDate || 'start'}`} value={signed(f.pnlSinceStart)} color={pctc(f.pnlSinceStart)} />
      <Row label="Risk at stop" value={usd(f.riskAtStop)} color={AMBER} />
      <Row label="Open positions" value={f.openCount} />
      <div style={{ borderTop: '1px solid #1a1a22', margin: '8px 0' }} />
      <Row label="Closed trades" value={f.tradeStats?.closed ?? 0} />
      <Row label="Win rate" value={`${ts.winRate ?? 0}%`} />
      <Row label="Profit factor" value={ts.profitFactor ?? 0} />
      <Row label="Payoff ratio" value={ts.payoffRatio ?? 0} />
      <div style={{ borderTop: '1px solid #1a1a22', margin: '8px 0' }} />
      {r.status === 'ready' ? (
        <>
          <Row label="Sharpe" value={r.sharpe} />
          <Row label="Sortino" value={r.sortino} />
          <Row label="Max drawdown" value={`${r.maxDD}%`} color={RED} />
          <Row label="Calmar" value={r.calmar} />
        </>
      ) : (
        <div style={{ fontSize: 11, color: '#777', fontStyle: 'italic', padding: '4px 0' }}>
          Risk-adjusted metrics (Sharpe, drawdown, Calmar) build over time — {r.points ?? 0}/{r.need ?? 15} days collected.
        </div>
      )}

      {f.positions?.length > 0 && (
        <div style={{ marginTop: 10, borderTop: '1px solid #1a1a22', paddingTop: 8 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#777', marginBottom: 4 }}>OPEN POSITIONS</div>
          {f.positions.slice(0, 6).map((p, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, fontFamily: 'monospace', padding: '1px 0' }}>
              <span style={{ color: '#ccc' }}>{p.ticker}<span style={{ color: p.direction === 'LONG' ? GREEN : RED, marginLeft: 5, fontSize: 9 }}>{p.direction === 'LONG' ? 'L' : 'S'}</span></span>
              <span style={{ color: pctc(p.pnl) }}>{signed(p.pnl)}</span>
            </div>
          ))}
          {f.openCount > 6 && <div style={{ fontSize: 10, color: '#666', marginTop: 3 }}>+{f.openCount - 6} more</div>}
        </div>
      )}

      <button
        disabled={!acknowledged}
        onClick={() => { window.location.href = `mailto:Scott@pnthrfunds.com?subject=${encodeURIComponent('Interest in ' + f.name)}&body=${encodeURIComponent('I am a verified accredited investor and would like to learn more about the ' + f.name + ' strategy.')}`; }}
        style={{ marginTop: 12, width: '100%', padding: '8px 0', borderRadius: 6, fontSize: 12, fontWeight: 700,
          cursor: acknowledged ? 'pointer' : 'not-allowed', opacity: acknowledged ? 1 : 0.4,
          background: 'transparent', color: f.mode === 'LIVE' ? GREEN : BLUE, border: `1px solid ${f.mode === 'LIVE' ? GREEN : BLUE}` }}>
        Express interest in {f.name}
      </button>
    </div>
  );
}

export default function FundComparisonPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [last, setLast] = useState(null);
  const [ack, setAck] = useState(false);

  const load = useCallback(async () => {
    try { const d = await fetchFundComparison(); setData(d); setError(null); setLast(new Date()); }
    catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load(); const id = setInterval(load, 10000); return () => clearInterval(id); }, [load]);

  const funds = data?.funds || [];
  const metricRows = [
    ['Return %', f => `${f.returnPct >= 0 ? '+' : ''}${f.returnPct}%`, f => pctc(f.returnPct)],
    ['Equity', f => usd(f.currentEquity)],
    ['P&L since start', f => signed(f.pnlSinceStart), f => pctc(f.pnlSinceStart)],
    ['Win rate', f => `${f.tradeStats?.combined?.winRate ?? 0}%`],
    ['Profit factor', f => f.tradeStats?.combined?.profitFactor ?? 0],
    ['Payoff', f => f.tradeStats?.combined?.payoffRatio ?? 0],
    ['Closed trades', f => f.tradeStats?.closed ?? 0],
    ['Sharpe', f => f.risk?.status === 'ready' ? f.risk.sharpe : 'building'],
    ['Max drawdown', f => f.risk?.status === 'ready' ? `${f.risk.maxDD}%` : '—'],
  ];

  return (
    <div style={{ padding: '20px 26px', color: '#e6e6e6', maxWidth: 1200 }}>
      <h1 style={{ fontSize: 22, fontWeight: 800, margin: '0 0 2px' }}>Fund Comparison</h1>
      <div style={{ fontSize: 13, color: MUT, marginBottom: 14 }}>
        {data?.note || 'Three PNTHR strategies, one common baseline.'} {last && <span style={{ color: '#666' }}>· refreshed {last.toLocaleTimeString()} · updates every 10s</span>}
      </div>

      {/* MANDATORY disclaimer banner */}
      <div style={{ background: '#1a1206', border: `1px solid ${AMBER}`, borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 11.5, color: '#e8c88a', lineHeight: 1.5 }}>
        <b style={{ color: AMBER }}>HYPOTHETICAL / SIMULATED PERFORMANCE.</b> {data?.disclaimer ||
          'Elite AI and Ambush V7.6 are PAPER-TRADED simulations — not real trading and not a track record. PNTHR Tree reflects a live account with a very short history. Past and simulated performance does not guarantee future results. For evaluation only; not an offer to sell securities. Reg D 506(c) — available only to verified accredited investors.'}
      </div>

      {error && <div style={{ color: RED, marginBottom: 12 }}>Error: {error}</div>}
      {!data && !error && <div style={{ color: '#666', padding: '40px 0' }}>Loading…</div>}

      {data && (
        <>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
            {funds.map(f => <FundCard key={f.id} f={f} acknowledged={ack} startDate={data.startDate} />)}
          </div>

          {/* Side-by-side comparison table */}
          <div style={{ background: '#0d0d0f', border: '1px solid #1e1e22', borderRadius: 10, padding: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: MUT, marginBottom: 10, letterSpacing: 0.4 }}>SIDE-BY-SIDE</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr><th style={{ textAlign: 'left', color: '#777', fontWeight: 600, padding: '4px 8px' }}>Metric</th>
                  {funds.map(f => <th key={f.id} style={{ textAlign: 'right', padding: '4px 8px', color: f.mode === 'LIVE' ? GREEN : BLUE }}>{f.name}<div style={{ fontSize: 9, fontWeight: 400, color: '#666' }}>{f.mode === 'LIVE' ? 'live' : 'paper'}</div></th>)}</tr>
              </thead>
              <tbody>
                {metricRows.map(([label, fn, colorFn], i) => (
                  <tr key={i} style={{ borderTop: '1px solid #16161c' }}>
                    <td style={{ padding: '5px 8px', color: MUT }}>{label}</td>
                    {funds.map(f => <td key={f.id} style={{ textAlign: 'right', padding: '5px 8px', fontFamily: 'monospace', color: colorFn ? colorFn(f) : '#ddd' }}>{fn(f)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Accredited acknowledgment gate for the interest buttons */}
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11.5, color: MUT, marginBottom: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} style={{ marginTop: 2 }} />
            <span>I am a verified accredited investor, I understand that Elite AI and Ambush V7.6 figures above are <b>simulated/paper</b> results and not a track record, and I have read the disclosures. (Required to express interest.)</span>
          </label>
          <div style={{ fontSize: 10.5, color: '#666', lineHeight: 1.5, marginTop: 8 }}>
            Paper figures are gross of commissions and borrow costs; entries/exits include modeled slippage where the strategy specifies. PNTHR Tree reflects the actual net result of a live account. Risk-adjusted statistics require several weeks of data before they are meaningful. This page is an internal comparison tool; nothing herein is an offer, solicitation, or recommendation to buy or sell any security.
          </div>
        </>
      )}
    </div>
  );
}
