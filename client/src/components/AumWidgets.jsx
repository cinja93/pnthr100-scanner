// AumWidgets.jsx - shared AUM and cash-tracking widgets (AumTracker,
// ForwardProjection, CashLedgerModal). Rendered by the PNTHR Tree, Pounce,
// and Elite AI pages.

import { useState } from 'react';

// ── AUM tracker: Projected (backtest, pure compounding) vs Actual ───────────
function fmtAum(n) {
  if (n == null || isNaN(n)) return '--';
  const v = Number(n);
  if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (Math.abs(v) >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + v.toFixed(0);
}

function AumChart({ projected, actual, actualProjected }) {
  if (!projected?.length) return null;
  const W = 1000, H = 230, padL = 6, padR = 6, padT = 12, padB = 24;
  const proj = projected, act = actual || [], actProj = actualProjected || [];
  const maxV = Math.max(...proj.map(p => p.value), ...act.map(a => a.value), ...actProj.map(a => a.value));
  const minV = Math.min(proj[0].value, ...act.map(a => a.value), ...actProj.map(a => a.value));
  const anchor = new Date(proj[0].date + 'T12:00:00');
  const last = new Date(proj[proj.length - 1].date + 'T12:00:00');
  const span = (last - anchor) || 1;
  const xd = ds => padL + ((new Date(ds + 'T12:00:00') - anchor) / span) * (W - padL - padR);
  const y = v => padT + (1 - (v - minV) / ((maxV - minV) || 1)) * (H - padT - padB);
  // downsample projected to ~250 pts for a light polyline
  const step = Math.max(1, Math.floor(proj.length / 250));
  const projPts = proj.filter((_, i) => i % step === 0 || i === proj.length - 1)
    .map(p => `${xd(p.date).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const actPts = act.map(a => `${xd(a.date).toFixed(1)},${y(a.value).toFixed(1)}`).join(' ');
  const actProjPts = actProj.filter((_, i) => i % step === 0 || i === actProj.length - 1)
    .map(a => `${xd(a.date).toFixed(1)},${y(a.value).toFixed(1)}`).join(' ');
  const yearTicks = [];
  for (let yr = anchor.getFullYear(); yr <= last.getFullYear(); yr++) yearTicks.push(yr);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 230, display: 'block' }}>
      {/* y gridlines */}
      {[0, 0.5, 1].map((f, i) => {
        const v = minV + f * (maxV - minV);
        return (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="#222" strokeWidth="1" />
            <text x={padL + 2} y={y(v) - 3} fill="#555" fontSize="11">{fmtAum(v)}</text>
          </g>
        );
      })}
      {/* x year labels */}
      {yearTicks.map((yr, i) => {
        const xp = xd(`${yr}-01-02`);
        if (xp < padL || xp > W - padR) return null;
        return <text key={i} x={xp} y={H - 6} fill="#555" fontSize="11" textAnchor="middle">{yr}</text>;
      })}
      <polyline points={projPts} fill="none" stroke="#3b82f6" strokeWidth="2" />
      {actProjPts && <polyline points={actProjPts} fill="none" stroke="#22c55e" strokeWidth="2" strokeDasharray="2 5" opacity="0.85" />}
      {actPts && <polyline points={actPts} fill="none" stroke="#22c55e" strokeWidth="2.5" />}
      {/* "You are here" dot on the latest actual point. A <polyline> needs 2+ points to
          draw, so a brand-new book (a single actual data point) would show NO actual line
          at all — this marker makes today's AUM visible from day one, and labels the
          current position on an established book too. */}
      {act.length > 0 && (() => {
        const a = act[act.length - 1]; const cx = xd(a.date), cy = y(a.value);
        return (isFinite(cx) && isFinite(cy)) ? <circle cx={cx} cy={cy} r="4" fill="#22c55e" stroke="#0a0a0a" strokeWidth="1.5" /> : null;
      })()}
    </svg>
  );
}

function mondayOf(dateStr) {
  // ISO Monday of the week containing dateStr (YYYY-MM-DD) — stable week key.
  const d = new Date(dateStr + 'T12:00:00');
  const back = (d.getDay() + 6) % 7; // Mon=0 .. Sun=6
  d.setDate(d.getDate() - back);
  return d.toISOString().slice(0, 10);
}
function AumTableModal({ view, projection, onClose }) {
  const isProj = view === 'projected' || view === 'projectedGross';
  const series = view === 'projectedGross' ? (projection.projectedGross || []) : isProj ? (projection.projected || []) : (projection.actual || []);
  // Projected: one row per WEEK (first trading day of each week). Actual: every snapshot.
  let rows = series;
  if (isProj) {
    const seen = new Set(); rows = [];
    for (const p of series) { const wk = mondayOf(p.date); if (!seen.has(wk)) { seen.add(wk); rows.push(p); } }
  }
  return (
    <div onClick={onClose} className="pnthr-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#0d0d0d', border: '1px solid #2a2a2a', borderRadius: 10, width: 440, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid #222' }}>
          <div style={{ color: isProj ? '#3b82f6' : '#22c55e', fontWeight: 700, fontSize: 14 }}>
            {view === 'projectedGross' ? 'Projected AUM (Gross) — week by week' : isProj ? 'Projected AUM — week by week' : 'Actual AUM — daily history'}
          </div>
          <span onClick={onClose} style={{ cursor: 'pointer', color: '#888', fontSize: 20, lineHeight: 1 }}>×</span>
        </div>
        <div style={{ overflowY: 'auto', padding: '0 16px 12px' }}>
          {rows.length === 0 ? (
            <div style={{ color: '#666', padding: '18px 0' }}>No data yet{isProj ? '.' : ' — fills in as the engine records daily NAV.'}</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ color: '#777', textAlign: 'left' }}>
                  <th style={{ padding: '8px 0', position: 'sticky', top: 0, background: '#0d0d0d' }}>{isProj ? 'Week of' : 'Date'}</th>
                  <th style={{ padding: '8px 0', textAlign: 'right', position: 'sticky', top: 0, background: '#0d0d0d' }}>{isProj ? 'Projected' : 'Actual'} AUM</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ borderTop: '1px solid #1a1a1a' }}>
                    <td style={{ padding: '6px 0', color: '#ccc' }}>{r.date}</td>
                    <td style={{ padding: '6px 0', textAlign: 'right', fontFamily: 'monospace', color: isProj ? '#3b82f6' : '#22c55e' }}>{fmtAum(r.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// Forward projection: today's real AUM ridden forward at the backtest growth,
// with the live $2M -> bank $1M withdrawal rule. Shows working balance + banked.
export function ForwardProjection({ forward }) {
  if (!forward?.horizons?.length) return null;
  const rule = forward.withdrawalRule || {};
  return (
    <div style={{ marginTop: 14, background: '#0d0d0d', border: '1px solid #2e7d46', borderRadius: 10, padding: '14px 16px', boxShadow: '0 0 0 1px rgba(34,197,94,0.08)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid #1d3a28' }}>
        <span style={{ color: '#22c55e', fontWeight: 800, fontSize: 17, letterSpacing: '0.03em' }}>🎯 PNTHR GOALS</span>
        <span style={{ color: '#666', fontSize: 11 }}>where today's real AUM goes from here</span>
      </div>
      <div style={{ color: '#22c55e', fontWeight: 700, fontSize: 13, letterSpacing: '0.04em' }}>
        PROJECTED FORWARD <span style={{ color: '#555', fontWeight: 400 }}>· riding today's real AUM forward at the backtest</span>
      </div>
      <div style={{ color: '#666', fontSize: 11, marginTop: 3, lineHeight: 1.4 }}>
        Live withdrawal rule applied: once the working balance reaches {fmtAum(rule.threshold)}, bank {fmtAum(rule.amount)} and trade off the rest. Banked profit is locked in and yours.
        {forward.cagrPct ? ` Growth rides today's AUM at the backtested ${forward.cagrPct}% CAGR.` : ''}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 10, minWidth: 560 }}>
          <thead>
            <tr style={{ color: '#b4b4be', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>Horizon</th>
              <th style={{ textAlign: 'right', padding: '6px 8px', color: '#3b82f6' }}>Projected AUM</th>
              <th style={{ textAlign: 'right', padding: '6px 8px' }}>Working Balance</th>
              <th style={{ textAlign: 'right', padding: '6px 8px' }}>Profit Banked</th>
              <th style={{ textAlign: 'right', padding: '6px 8px', color: '#22c55e' }}>Your Total</th>
              <th style={{ textAlign: 'right', padding: '6px 8px' }}>Edge</th>
            </tr>
          </thead>
          <tbody>
            {forward.horizons.map((h, i) => {
              const a = h.actual, p = h.projected;
              if (!a) return null;
              const edge = (p && p.total > 0) ? ((a.total / p.total - 1) * 100) : 0;
              return (
                <tr key={i} style={{ borderTop: '1px solid #1a1a1a', fontFamily: 'monospace' }}>
                  <td style={{ textAlign: 'left', padding: '7px 8px', fontFamily: 'system-ui, sans-serif', color: '#e6e6e6', fontWeight: 700 }}>
                    {h.label}
                    {h.extrapolated && (
                      <span title="Beyond the ~3.5-yr backtest — extended at the backtest CAGR" style={{ color: '#8a8', fontSize: 9, fontWeight: 400, marginLeft: 6 }}>
                        extrapolated
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', padding: '7px 8px', color: '#3b82f6' }}>{p ? fmtAum(p.total) : '--'}</td>
                  <td style={{ textAlign: 'right', padding: '7px 8px', color: '#ccc' }}>{fmtAum(a.balance)}</td>
                  <td style={{ textAlign: 'right', padding: '7px 8px', color: a.banked > 0 ? '#fbbf24' : '#555' }}>{a.banked > 0 ? fmtAum(a.banked) : '--'}</td>
                  <td style={{ textAlign: 'right', padding: '7px 8px', color: '#22c55e', fontWeight: 700 }}>{fmtAum(a.total)}</td>
                  <td style={{ textAlign: 'right', padding: '7px 8px', color: edge >= 0 ? '#22c55e' : '#ef4444' }}>{edge >= 0 ? '+' : ''}{edge.toFixed(1)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Cash-ledger / margin-stress detail modal (Tree page; opened from the AUM panel).
export function CashLedgerModal({ data, onClose }) {
  const f = n => (n < 0 ? '-$' : '$') + Math.round(Math.abs(n)).toLocaleString();
  const b = data.breaks || {};
  const noBreaks = !b.blowupDays && !b.call25Days && !b.call30Days && !b.call35Days;
  const stat = (label, value, color) => (
    <div style={{ background: '#121212', border: '1px solid #222', borderRadius: 8, padding: '8px 12px', minWidth: 150 }}>
      <div style={{ color: '#888', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ color: color || '#e6e6e6', fontSize: 18, fontWeight: 700, fontFamily: 'monospace' }}>{value}</div>
    </div>
  );
  return (
    <div onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      className="pnthr-overlay"
      style={{ position: 'fixed', inset: 0, background: '#000a', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#0d0d0d', border: '1px solid #25405f', borderRadius: 12, padding: '20px 22px', maxWidth: 840, width: '100%', maxHeight: '88vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h2 style={{ margin: 0, color: '#3b82f6', fontSize: 18 }}>📒 Cash Ledger &amp; Margin Stress</h2>
          <button onClick={onClose} style={{ background: '#161616', border: '1px solid #2a2a2a', color: '#aaa', borderRadius: 6, padding: '4px 12px', cursor: 'pointer' }}>Close</button>
        </div>
        <div style={{ color: '#666', fontSize: 11, margin: '4px 0 14px' }}>{data.strategy} · {data.period} · {data.tradingDays} trading days · start {f(data.startCash)}</div>

        <div style={{ background: noBreaks ? '#0e1f14' : '#2a0d0d', border: `1px solid ${noBreaks ? '#22c55e' : '#ef4444'}`, borderRadius: 8, padding: '10px 14px', marginBottom: 14, color: noBreaks ? '#22c55e' : '#fca5a5', fontWeight: 700, fontSize: 13 }}>
          {noBreaks ? '✅ Never breaks — 0 account-blowup days and 0 margin-call days (25/30/35% maintenance).' : '❌ Breaks — see the break tests below.'}
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          {stat('Ending equity', f(data.endingEquity), '#22c55e')}
          {stat('Max drawdown', data.maxDDPct + '%', '#facc15')}
          {stat('Lowest equity', f(data.lowestEquity), '#e6e6e6')}
          {stat('Deepest margin loan', f(-data.deepestMarginLoan), '#facc15')}
          {stat('Peak lev (close)', data.peakLevClose + '×', '#e6e6e6')}
          {stat('Peak lev (intraday)', data.peakLevIntraday + '×', '#e6e6e6')}
        </div>

        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 14, lineHeight: 1.5 }}>
          A margin call would only trigger if your broker's blended maintenance requirement exceeded <b style={{ color: '#facc15' }}>{data.callMaintBreakevenPct}%</b> (standard is 25–35%). Reg-T maintenance of 25% calls at 4× leverage; the peak here was {data.peakLevIntraday}×.
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 16 }}>
          <tbody>
            {[['Account blowup (equity ≤ 0)', b.blowupDays],
              ['Margin call @ 25% maintenance (lev > 4.0×)', b.call25Days],
              ['Margin call @ 30% maintenance (lev > 3.3×)', b.call30Days],
              ['Margin call @ 35% maintenance (lev > 2.9×)', b.call35Days]].map(([label, days], i) => (
              <tr key={i} style={{ borderTop: '1px solid #1a1a1a' }}>
                <td style={{ padding: '6px 8px', color: '#ccc' }}>{label}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right', color: days ? '#ef4444' : '#22c55e', fontWeight: 700 }}>{days ? days + ' days ❌' : '0 days ✅'}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ color: '#888', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Most-levered days — top 8 by intraday leverage across the whole backtest (not a date range)</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'monospace', minWidth: 560 }}>
            <thead><tr style={{ color: '#b4b4be', fontSize: 10, textTransform: 'uppercase' }}>
              <th style={{ textAlign: 'left', padding: '5px 8px' }}>Date</th>
              <th style={{ textAlign: 'right', padding: '5px 8px' }}>Lev (close)</th>
              <th style={{ textAlign: 'right', padding: '5px 8px' }}>Lev (intraday)</th>
              <th style={{ textAlign: 'right', padding: '5px 8px' }}>Equity</th>
              <th style={{ textAlign: 'right', padding: '5px 8px' }}>Cash</th>
              <th style={{ textAlign: 'right', padding: '5px 8px' }}>Long MV</th>
            </tr></thead>
            <tbody>
              {(data.worstDays || []).map((r, i) => (
                <tr key={i} style={{ borderTop: '1px solid #1a1a1a' }}>
                  <td style={{ textAlign: 'left', padding: '5px 8px', color: '#e6e6e6', fontFamily: 'system-ui, sans-serif' }}>{r.date}</td>
                  <td style={{ textAlign: 'right', padding: '5px 8px', color: '#ccc' }}>{r.levClose}×</td>
                  <td style={{ textAlign: 'right', padding: '5px 8px', color: '#facc15' }}>{r.levIntraday}×</td>
                  <td style={{ textAlign: 'right', padding: '5px 8px', color: '#22c55e' }}>{f(r.equity)}</td>
                  <td style={{ textAlign: 'right', padding: '5px 8px', color: '#ef4444' }}>{f(r.cash)}</td>
                  <td style={{ textAlign: 'right', padding: '5px 8px', color: '#ccc' }}>{f(r.longMV)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {data.weekly?.length > 0 && (
          <>
            <div style={{ color: '#888', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '18px 0 6px' }}>
              Weekly results — full backtest ({data.weekly.length} weeks · {data.weekly[0].weekOf} → {data.weekly[data.weekly.length - 1].endDate})
            </div>
            <div style={{ maxHeight: 340, overflowY: 'auto', border: '1px solid #1a1a1a', borderRadius: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'monospace', minWidth: 560 }}>
                <thead><tr style={{ color: '#b4b4be', fontSize: 10, textTransform: 'uppercase', position: 'sticky', top: 0, background: '#0d0d0d' }}>
                  <th style={{ textAlign: 'left', padding: '5px 8px' }}>Week of</th>
                  <th style={{ textAlign: 'right', padding: '5px 8px' }}>Equity</th>
                  <th style={{ textAlign: 'right', padding: '5px 8px' }}>P&amp;L</th>
                  <th style={{ textAlign: 'right', padding: '5px 8px' }}>P&amp;L %</th>
                  <th style={{ textAlign: 'right', padding: '5px 8px' }}>Peak lev</th>
                  <th style={{ textAlign: 'right', padding: '5px 8px' }}>Margin loan</th>
                  <th style={{ textAlign: 'right', padding: '5px 8px' }}>Pos</th>
                </tr></thead>
                <tbody>
                  {data.weekly.map((w, i) => (
                    <tr key={i} style={{ borderTop: '1px solid #1a1a1a' }}>
                      <td style={{ textAlign: 'left', padding: '4px 8px', color: '#e6e6e6', fontFamily: 'system-ui, sans-serif' }}>{w.weekOf}</td>
                      <td style={{ textAlign: 'right', padding: '4px 8px', color: '#e6e6e6' }}>{f(w.equity)}</td>
                      <td style={{ textAlign: 'right', padding: '4px 8px', color: w.pnl >= 0 ? '#22c55e' : '#ef4444' }}>{w.pnl >= 0 ? '+' : ''}{f(w.pnl)}</td>
                      <td style={{ textAlign: 'right', padding: '4px 8px', color: w.pnlPct >= 0 ? '#22c55e' : '#ef4444' }}>{w.pnlPct >= 0 ? '+' : ''}{w.pnlPct}%</td>
                      <td style={{ textAlign: 'right', padding: '4px 8px', color: w.maxLevIntraday > 2 ? '#facc15' : '#ccc' }}>{w.maxLevIntraday}×</td>
                      <td style={{ textAlign: 'right', padding: '4px 8px', color: w.minCash < 0 ? '#ef4444' : '#555' }}>{w.minCash < 0 ? f(w.minCash) : '—'}</td>
                      <td style={{ textAlign: 'right', padding: '4px 8px', color: '#ccc' }}>{w.posCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div style={{ color: '#555', fontSize: 10, marginTop: 14 }}>{data.disclosure}</div>
      </div>
    </div>
  );
}

// Strip the Net/Gross prefix so 'Net CAGR' / 'Gross CAGR' share one definition.
const baseKey = (l) => String(l).replace(/^(Net|Gross)\s+/, '');
// "How this is calculated" copy for the ⓘ on each metric tile.
const METRIC_INFO = {
  'Total Return': 'Ending equity ÷ $100K start − 1 — the full cumulative gain over the backtest window.',
  'CAGR': 'Compound annual growth rate: (ending ÷ $100K) ^ (1 ÷ years) − 1. Smooths the total return into a per-year rate.',
  'Sharpe': 'Mean daily return ÷ standard deviation of daily returns, annualized (× √252). Reward per unit of total volatility.',
  'Sortino': 'Like Sharpe, but divides by downside deviation only (negative days), annualized. Reward per unit of harmful volatility.',
  'Profit Factor': 'Gross profit ÷ gross loss across all closed trades. 2.2× means $2.20 won for every $1.00 lost.',
  'Calmar': 'CAGR ÷ max drawdown. Return earned per unit of worst-case peak-to-trough loss.',
  'Recovery Factor': 'Total net profit ÷ max drawdown (in dollars). How many times over the strategy earned back its deepest drawdown.',
  'Positive Months': 'Share of calendar months that closed higher than the prior month-end.',
  'Win Rate': 'Share of closed trades that were profitable. A low win rate is fine when payoff (avg win ÷ avg loss) is high.',
  'Total Closed': 'Number of round-trip trades closed over the backtest.',
  'Ending Equity': 'Account value at the end of the backtest, compounding from the $100K start.',
  'Alpha vs S&P': 'Ending equity minus what $100K would be worth if it had simply tracked the S&P 500 over the same window — dollars earned above the index.',
  'Avg Win': 'Average gain on winning trades — the price move from entry to exit (% and $). Price-based, so it reads the same net or gross.',
  'Avg Winner Hold': 'Average number of trading days a winning trade was held (entry to exit), shown with the median.',
  'Avg Month': 'Average of every monthly return. "positive X%" is the share of months that finished up.',
  'Best Month': 'The single best calendar-month return over the backtest.',
  'Avg Up Month': 'Average return across only the months that finished positive.',
  'Avg Down Month': 'Average return across only the months that finished negative.',
  'Avg Loss': 'Average loss on losing trades (% and $). Most are small breakeven-snap scratch exits.',
  'Avg Loser Hold': 'Average number of trading days a losing trade was held, with the median. Losers are cut quickly.',
  'Max Monthly DD': 'The worst single calendar-month return in the backtest.',
  'Avg Within-Month Dip': 'For each month, its worst peak-to-trough dip on daily closes, then averaged — the typical drawdown felt inside a month.',
  'Worst 30 Days': 'The worst peak-to-trough decline over any rolling 30-calendar-day window.',
  'Worst Stretch': 'The deepest peak-to-trough decline measured on month-end values (a multi-month drawdown).',
  'Max Drawdown': 'The largest peak-to-trough decline on the daily equity curve over the entire backtest.',
};

export function AumTracker({ projection, hideForward, cashLedger, onActualTable }) {
  // onActualTable (optional): overrides the Actual AUM box click — the Tree page
  // uses it to open its IBKR-truth daily trade log instead of the plain table.
  const [showChart, setShowChart] = useState(false);
  const [tableView, setTableView] = useState(null);
  const [showLedger, setShowLedger] = useState(false);
  const [infoMetric, setInfoMetric] = useState(null);   // metric whose "how it's calculated" popover is open
  const openActual = onActualTable || (() => setTableView('actual'));
  if (!projection?.current) return null;
  const { current, projected, actual, anchor } = projection;
  // Funds that carry the extra monthly/winner fields use the aligned fixed-column grid;
  // funds without them keep the original stretch layout untouched.
  const treeLayout = projection.metrics?.maxMonthlyDDPct != null;
  const box = (label, value, color, onClick) => (
    <div onClick={onClick} title="Click for the full table" style={{ cursor: 'pointer', background: '#161616', border: '1px solid #2a2a2a', borderRadius: 8, padding: '8px 14px', minWidth: 175 }}>
      <div style={{ color: '#888', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', display: 'flex', justifyContent: 'space-between', gap: 10 }}>
        <span>{label}</span><span style={{ color: '#555' }}>▸ table</span>
      </div>
      <div style={{ color, fontSize: 22, fontWeight: 700, fontFamily: 'monospace' }}>{fmtAum(value)}</div>
    </div>
  );
  // One row of hedge-fund metric cards for a given metrics object (Net or Gross).
  // shared card renderer (one tile)
  // Fixed 14-column grid (gap 8px) shared by all 3 panels → tiles are identical width and the
  // 11 monthly tiles line up under the first 11 columns of the 14-tile NET/GROSS rows.
  const tileGrid = (tiles, oneLine, accent) => (
    <div style={{ display: 'flex', flexWrap: treeLayout ? 'wrap' : (oneLine ? 'nowrap' : 'wrap'), gap: 8, marginTop: 6 }}>
      {tiles.map(([label, value, color, sub], i) => (
        <div key={i} style={{ background: '#121212', border: `1px solid ${accent || '#222'}`, borderRadius: 8, padding: '8px 10px', overflow: 'hidden',
          ...(treeLayout ? { flexGrow: 0, flexShrink: 0, flexBasis: 'calc((100% - 116px) / 14)', minWidth: 0 } : { minWidth: oneLine ? 0 : 96, flex: oneLine ? '1 1 0' : '1 1 auto' }) }}>
          {/* header: label + ⓘ. minHeight reserves 2 lines so the values below line up across all tiles. */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 4, minHeight: 22 }}>
            <span style={{ color: '#888', fontSize: 9, letterSpacing: '0.05em', textTransform: 'uppercase', lineHeight: 1.25 }}>{label}</span>
            {METRIC_INFO[baseKey(label)] && (
              <span onClick={(e) => { e.stopPropagation(); setInfoMetric(baseKey(label)); }} title="How this is calculated"
                style={{ cursor: 'pointer', color: '#5a5a5a', fontSize: 11, lineHeight: 1, flexShrink: 0 }}>ⓘ</span>
            )}
          </div>
          <div style={{ color, fontSize: 17, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
          {sub && <div style={{ color: '#555', fontSize: 9, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>}
        </div>
      ))}
    </div>
  );
  const metricTiles = (m, kind, oneLine = false) => {
    const tiles = [
      [`${kind} Total Return`, (m.netReturnPct >= 0 ? '+' : '') + Math.round(m.netReturnPct).toLocaleString() + '%', '#22c55e', '$' + Math.round((m.startNav || 100000) / 1000) + 'K start'],
      [`${kind} CAGR`, (m.cagrPct >= 0 ? '+' : '') + m.cagrPct + '%', '#22c55e'],
      ['Sharpe', m.sharpe, '#e6e6e6'],
      ['Sortino', m.sortino, '#22c55e'],
      ['Profit Factor', m.profitFactor + 'x', '#22c55e'],
      ['Calmar', m.calmar, '#e6e6e6'],
      ['Recovery Factor', m.recoveryFactor + 'x', '#e6e6e6'],
      ['Positive Months', m.positiveMonthsPct + '%', '#22c55e'],
      ['Win Rate', m.winRatePct + '%', '#e6e6e6', m.payoff + 'x payoff'],
      ['Total Closed', Math.round(m.totalClosed).toLocaleString(), '#e6e6e6'],
      ['Ending Equity', fmtAum(m.endingEquity), '#22c55e'],
      ['Alpha vs S&P', (m.alphaDollar >= 0 ? '+' : '') + fmtAum(m.alphaDollar), '#22c55e'],
    ];
    // Extra per-trade WINNER tiles (data-gated: only funds whose baseline carries these fields
    // show them). NOTE: monthly-path stats (Avg Up / Best Month) are intentionally NOT here —
    // the gross curve = net + fees-added-back inflates the base and distorts monthly %, so those
    // live NET-only in the monthly/risk panel. These two are per-trade (price-based) → valid per stream.
    // Avg Win / Winner Hold are per-trade (price-based), so we show ONE value (NET) in BOTH rows
    // rather than a trivially-different gross figure — same number on net and gross by design.
    const w = projection.metrics;
    if (w?.avgWinPct != null) tiles.push(['Avg Win', '+' + w.avgWinPct + '%', '#22c55e', '+$' + Math.round(w.avgWinDollar).toLocaleString()]);
    if (w?.winnerHoldDays != null) tiles.push(['Avg Winner Hold', w.winnerHoldDays + 'd', '#22c55e', 'median ' + w.winnerHoldMed]);
    return tileGrid(tiles, oneLine);
  };
  // Drawdown / risk profile panel (NET) — rendered only when the baseline carries monthly stats.
  // Full monthly + risk profile — reported NET only (the gross monthly % is distorted by the
  // fee-add-back, so we show the honest net figure once rather than a misleading gross column).
  const riskPanel = (m) => (
    <div style={{ border: '1px solid #b45309', borderRadius: 10, padding: '0 10px 10px', marginTop: 10 }}>
      {rowLabel('MONTHLY & RISK PROFILE · NET OF ALL FUND FEES')}
      {tileGrid([
        ['Avg Month', '+' + m.avgMonthPct + '%', '#22c55e', 'positive ' + m.positiveMonthsPct + '%'],
        ['Best Month', '+' + m.bestMonthPct + '%', '#22c55e'],
        ['Avg Up Month', '+' + m.avgUpMonthPct + '%', '#22c55e'],
        ['Avg Down Month', m.avgDownMonthPct + '%', '#f59e0b', 'when red'],
        ['Avg Loss', m.avgLossPct + '%', '#f59e0b', m.avgLossDollar != null ? '-$' + Math.abs(Math.round(m.avgLossDollar)).toLocaleString() : null],
        ['Avg Loser Hold', m.loserHoldDays + 'd', '#f59e0b', 'median ' + m.loserHoldMed],
        ['Max Monthly DD', m.maxMonthlyDDPct + '%', '#ef4444', 'worst month'],
        ['Avg Within-Month Dip', m.avgWithinMonthDipPct + '%', '#f59e0b', 'mid-month'],
        ['Worst 30 Days', m.worstRolling30Pct + '%', '#ef4444', 'rolling'],
        ['Worst Stretch', m.worstStretchPct + '%', '#ef4444', 'peak→trough'],
        ['Max Drawdown', '-' + Math.abs(m.maxDDPct).toFixed(1) + '%', '#ef4444', 'all-time'],
      ], false, '#3a2a12')}
    </div>
  );
  const rowLabel = (t) => <div style={{ color: '#888', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', marginTop: 12 }}>{t}</div>;
  // ON TRACK line + "At MM-DD-YY levels" + "N trading days ahead/behind schedule" grouped in a
  // SINGLE outlined box (Tree only — when current.aheadOfSchedule is present). Dynamic as AUM moves.
  const fmtMMDDYY = (d) => { const [y, m, dd] = String(d || '').split('-'); return y ? `${m}-${dd}-${y.slice(2)}` : '—'; };
  const trackWithPace = (pct) => {
    const a = current.aheadOfSchedule;
    if (!a || !a.date) return trackBadge(pct);   // no pace data → original standalone pill
    const ok = (pct ?? 0) >= 0;
    const col = ok ? '#22c55e' : '#ef4444';
    const n = Math.abs(a.tradingDays);
    return (
      <div style={{ border: `1px solid ${col}66`, background: col + '12', borderRadius: 8, padding: '8px 12px', textAlign: 'center', lineHeight: 1.5 }}>
        <div style={{ color: col, fontWeight: 700, fontSize: 12 }}>{ok ? 'ON TRACK' : 'BEHIND'} {pct >= 0 ? '+' : ''}{pct}% vs backtest</div>
        <div style={{ color: '#888', fontSize: 11, marginTop: 4 }}>At {fmtMMDDYY(a.date)} levels</div>
        <div style={{ color: a.ahead ? '#22c55e' : '#ef4444', fontWeight: 600, fontSize: 11 }}>
          {n} trading day{n === 1 ? '' : 's'} {a.ahead ? 'ahead of' : 'behind'} schedule
        </div>
      </div>
    );
  };
  // ON TRACK / BEHIND pill for a given % (vs backtest).
  const trackBadge = (pct, suffix = '') => {
    const ok = (pct ?? 0) >= 0;
    return (
      <span style={{
        fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 6, textAlign: 'center',
        color: ok ? '#22c55e' : '#ef4444',
        background: (ok ? '#22c55e' : '#ef4444') + '1a',
        border: `1px solid ${(ok ? '#22c55e' : '#ef4444')}44`,
      }}>
        {ok ? 'ON TRACK' : 'BEHIND'} {pct >= 0 ? '+' : ''}{pct}% vs backtest{suffix}
      </span>
    );
  };
  // Outlined "bundle" wrapper grouping a Projected box + its on-track badge.
  const bundle = (children, color = '#25405f') => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, border: `1px solid ${color}`, borderRadius: 10, padding: 10, background: '#0d0d0d' }}>
      {children}
    </div>
  );
  // The projected-vs-actual line chart (rendered once, placed per layout below).
  const chartBlock = showChart && (
    <>
      <div style={{ marginTop: 10 }}>
        <AumChart projected={projected} actual={actual} actualProjected={projection.actualProjected} />
      </div>
      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: '#888', marginTop: 2, flexWrap: 'wrap' }}>
        <span><span style={{ color: '#3b82f6' }}>━</span> Projected (backtest)</span>
        <span><span style={{ color: '#22c55e' }}>━</span> Actual (your account)</span>
        {projection.actualProjected?.length > 0 && <span><span style={{ color: '#22c55e' }}>┄</span> If you keep pace (at plan CAGR from today)</span>}
      </div>
    </>
  );
  const hasGross = current.projectedAumGross != null;
  return (
    <div style={{ position: 'relative', marginBottom: 12 }}>
      <div style={{ background: '#0d0d0d', border: '1px solid #25405f', borderRadius: 10, padding: '14px 16px', boxShadow: '0 0 0 1px rgba(59,130,246,0.08)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: hasGross ? 1 : undefined, minWidth: 0 }}>
          <div style={{ color: '#3b82f6', fontWeight: 700, fontSize: 13, letterSpacing: '0.04em' }}>
            PROJECTED vs ACTUAL AUM <span style={{ color: '#555', fontWeight: 400 }}>· backtest, pure compounding</span>
          </div>
          <div style={{ color: '#555', fontSize: 11, marginTop: 2 }}>
            Anchored {anchor?.startDate} at {fmtAum(anchor?.startAum)} · projects to {fmtAum(projection.meta?.backtestEndNav)} over ~3.5 yrs
          </div>
          <button onClick={() => setShowChart(s => !s)} style={{ marginTop: 8, background: '#161616', border: '1px solid #2a2a2a', color: '#aaa', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>
            {showChart ? '▲ Hide chart' : '▼ Show chart'}
          </button>
          {cashLedger && (
            <button onClick={() => setShowLedger(true)} style={{ marginTop: 8, marginLeft: 8, background: '#161616', border: '1px solid #2a2a2a', color: '#aaa', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>
              📒 Cash Ledger
            </button>
          )}
          {hasGross && chartBlock}
        </div>
        {/* the 2 boxes — upper right, click for table */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: current.projectedAumGross != null ? 'stretch' : 'flex-end', width: current.projectedAumGross != null ? 320 : undefined }}>
          {current.projectedAumGross != null ? (
            <>
              {bundle(box('Actual AUM', current.actualAum, '#22c55e', openActual), '#2a2a2a')}
              {bundle(<>
                {box('Projected AUM (Net)', current.projectedAum, '#3b82f6', () => setTableView('projected'))}
                {trackBadge(current.onTrackPct, ' (net)')}
              </>, '#22c55e')}
              {bundle(<>
                {box('Projected AUM (Gross)', current.projectedAumGross, '#60a5fa', () => setTableView('projectedGross'))}
                {trackBadge(current.onTrackPctGross, ' (gross)')}
              </>, '#ef4444')}
            </>
          ) : (
            <>
              {box('Projected AUM', current.projectedAum, '#3b82f6', () => setTableView('projected'))}
              {box('Actual AUM', current.actualAum, '#22c55e', openActual)}
              {trackWithPace(current.onTrackPct)}
            </>
          )}
        </div>
      </div>

      {/* Projected-vs-actual chart — right under the header / Show-chart button (Tree
          layout) so expanding it is visible immediately, not below the metric rows. */}
      {!hasGross && chartBlock}

      {/* Hedge-fund metric cards — NET row (green box) + GROSS row (red box) when gross present */}
      {projection.metrics && (projection.metricsGross ? (
        <>
          {projection.metricsNetFees && (
            <div style={{ border: '2px solid #22c55e', borderRadius: 10, padding: '0 10px 10px', marginTop: 12 }}>
              {rowLabel('NET · AFTER ALL FUND FEES — what an investor keeps (2% mgmt + performance fee)')}
              {metricTiles(projection.metricsNetFees, 'Net', true)}
            </div>
          )}
          <div style={{ border: '1px solid #6b7280', borderRadius: 10, padding: '0 10px 10px', marginTop: 10 }}>
            {rowLabel('STRATEGY · NET OF TRADING COSTS (before fund fees)')}
            {metricTiles(projection.metrics, 'Net', true)}
          </div>
          <div style={{ border: '1px solid #ef4444', borderRadius: 10, padding: '0 10px 10px', marginTop: 10 }}>
            {rowLabel('GROSS · BEFORE TRADING COSTS')}
            {metricTiles(projection.metricsGross, 'Gross', true)}
          </div>
        </>
      ) : (
        metricTiles(projection.metrics, 'Net')
      ))}

      {/* Drawdown & risk profile (data-gated; only shown for funds whose baseline carries these fields) */}
      {projection.metrics?.maxMonthlyDDPct != null && riskPanel(projection.metricsNetFees || projection.metrics)}

      {/* Context facts: backtest window, average hold time, and when live (actual) tracking began */}
      {(projection.meta?.backtestStart || projection.meta?.avgHoldDays != null || projection.meta?.actualStart) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', color: '#777', fontSize: 11, marginTop: 10, paddingTop: 8, borderTop: '1px solid #1e1e1e' }}>
          {projection.meta?.backtestStart && <span>Backtest: <b style={{ color: '#aaa' }}>{projection.meta.backtestStart} → {projection.meta.backtestEnd}</b></span>}
          {projection.meta?.avgHoldDays != null && <span>Avg hold: <b style={{ color: '#aaa' }}>{projection.meta.avgHoldDays} trading days</b> (~{(projection.meta.avgHoldDays / 5).toFixed(1)} wks · median {projection.meta.medianHoldDays})</span>}
          {projection.meta?.actualStart && <span>Live tracking since: <b style={{ color: '#22c55e' }}>{projection.meta.actualStart}</b></span>}
        </div>
      )}
      </div>

      {!hideForward && <ForwardProjection forward={projection.forward} />}

      {tableView && <AumTableModal view={tableView} projection={projection} onClose={() => setTableView(null)} />}
      {showLedger && cashLedger && <CashLedgerModal data={cashLedger} onClose={() => setShowLedger(false)} />}
      {infoMetric && (
        <div onClick={() => setInfoMetric(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#111', border: '1px solid #333', borderRadius: 10, padding: '18px 20px', maxWidth: 460, boxShadow: '0 20px 60px rgba(0,0,0,0.6)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
              <div style={{ color: '#fcf000', fontWeight: 700, fontSize: 13, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{infoMetric}</div>
              <span onClick={() => setInfoMetric(null)} style={{ cursor: 'pointer', color: '#888', fontSize: 14 }}>✕</span>
            </div>
            <div style={{ color: '#ccc', fontSize: 13, lineHeight: 1.55, marginTop: 10 }}>{METRIC_INFO[infoMetric] || 'No description available.'}</div>
            <div style={{ color: '#555', fontSize: 10, marginTop: 12, fontStyle: 'italic' }}>Backtest is survivorship-flattered and hypothetical · net of costs unless the row is labeled GROSS.</div>
          </div>
        </div>
      )}
    </div>
  );
}
