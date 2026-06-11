// client/src/components/EliteAiPage.jsx
// ── PNTHR Elite AI — automated funnel for the AI 300 Elite strategy ──────────
//
// The funnel (Ambush stair-step UX) wired to the AI-300 Elite brain:
//   STALKING → HUNTING → DEVOUR → PROTECT
//
// STALKING / HUNTING = weekly BL/SS candidates from the orders pipeline, chips
// brightening by qualityGrade (GOOD → BETTER → BEST). DEVOUR / PROTECT = the
// isolated DRY-RUN paper engine (pnthr_elite_positions) rendered as lot ladders.
// Paper only — no orders, no IBKR, nothing shared with Ambush or the portfolio.
// ────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useCallback } from 'react';
import { fetchReentrySignals, fetchLatestAiOrders, fetchEliteAiPositions, fetchEliteSizing, fetchEliteScorecard, fetchEliteProjection, runEliteDryRun, resetEliteDryRun, manageEliteDryRun } from '../services/api';
import PageHeader from './PageHeader';
import AumShield from './AumShield';
import LongShortScorecard from './LongShortScorecard';
import AiTickerChartModal from './AiTickerChartModal';
import { AumTracker, ForwardProjection } from './AmbushPage';
import styles from './AmbushPage.module.css';

// MCE funnel — the 4 stages the engine actually has (no intraday tripwire / re-entry loop).
const STAGES = [
  { key: 'STALKING', color: '#a78bfa', tip: 'Active weekly BL names in the pool, waiting for a daily 2-bar high breakout.' },
  { key: 'HUNTING',  color: '#f59e0b', tip: 'Broke the 2-bar high + confirmed by a green 60-min bar — ready to enter.' },
  { key: 'DEVOUR',   color: '#22c55e', tip: 'Live paper position pyramiding on the 5-lot ladder.' },
  { key: 'PROTECT',  color: '#3b82f6', tip: 'Stop ratcheted to break-even+ — the kill is secured.' },
];
const LOT_OFFSETS = [0, 0.03, 0.06, 0.10, 0.14];
const PILL = { green: '#22c55e', yellow: '#f59e0b', red: '#ef4444', gray: '#555' };
const CHECK_LABEL = { direction: 'Dir', shares: 'Shares', stopLevel: 'Stop', cap: '10% cap', risk: 'Risk' };

const fmt = (n, d = 2) => (n == null || isNaN(n)) ? '--' : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtUsd = (n) => (n == null || isNaN(n)) ? '--' : `$${fmt(n, 2)}`;

// DEVOUR ladder card — lays a paper position out as a price ladder (L1 anchor,
// lots stacking toward the trend, stop on the risk side).
function LadderCard({ pos, onChart, allTickers }) {
  const isLong = pos.direction === 'LONG';
  const anchor = pos.originalEntry || pos.entryPrice || 0;
  const total = (pos.lotPlan || []).reduce((s, v) => s + v, 0);
  const rps = Math.abs((pos.avgCost || pos.entryPrice) - (pos.stop || pos.stopPrice));
  const risk = rps * (pos.totalShares || 0);
  const STATUS_COLORS = { FILLED: '#22c55e', WAITING: '#f59e0b', LOCKED: '#555' };
  const mono = { fontFamily: 'monospace' };

  const lots = (pos.lotPlan || []).map((sh, i) => {
    const trig = isLong ? +(anchor * (1 + LOT_OFFSETS[i])).toFixed(2) : +(anchor * (1 - LOT_OFFSETS[i])).toFixed(2);
    const status = i < (pos.nextLot || 1) ? 'FILLED' : (i === (pos.nextLot || 1) ? 'WAITING' : 'LOCKED');
    return { i, label: `L${i + 1}`, trig, sh, status };
  });
  const ordered = isLong ? [...lots].reverse() : lots;

  return (
    <div style={{ border: '1px solid #2a3a2e', borderLeft: `4px solid ${pos.rec ? (PILL[pos.rec.rollup] || '#22c55e') : '#22c55e'}`, borderRadius: 8, background: '#0e0e13', padding: '12px 14px', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        {pos.rec && <span title={pos.rec.reasons?.length ? pos.rec.reasons.join('  •  ') : 'all checks green'} style={{ width: 11, height: 11, borderRadius: '50%', background: PILL[pos.rec.rollup] || PILL.gray, flexShrink: 0, boxShadow: pos.rec.rollup === 'red' ? `0 0 6px ${PILL.red}` : 'none' }} />}
        <span onClick={() => onChart?.(pos.ticker, allTickers)} title="click for charts" style={{ fontWeight: 800, fontSize: 16, color: '#fff', cursor: 'pointer' }}>{pos.ticker}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: isLong ? '#16a34a' : '#dc2626', border: `1px solid ${isLong ? '#16a34a' : '#dc2626'}`, borderRadius: 3, padding: '1px 6px' }}>{pos.direction}</span>
        <span style={{ fontSize: 11, color: '#f59e0b' }}>{pos.qualityGrade}</span>
        <span style={{ fontSize: 11, color: '#888' }}>{pos.sector}</span>
        <span style={{ fontSize: 10, color: '#a78bfa', border: '1px solid #6d5bbf', borderRadius: 3, padding: '1px 6px' }}>PAPER</span>
        <span style={{ flex: 1 }} />
        {pos.livePnl != null && <span style={{ fontSize: 12, fontWeight: 700, color: pos.livePnl >= 0 ? '#22c55e' : '#ef4444' }} title="Paper unrealized P&L">{pos.livePnl >= 0 ? '+' : ''}{fmtUsd(pos.livePnl)}</span>}
        <span style={{ fontSize: 11, color: '#888' }}>{pos.entryDate}</span>
      </div>

      {/* ENTRY anchor */}
      <div style={{ display: 'flex', gap: 20, alignItems: 'center', padding: '7px 10px', margin: '6px 0', background: '#16161c', border: '1px solid #2a3a2e', borderRadius: 6, flexWrap: 'wrap', fontSize: 12 }}>
        <span style={{ fontWeight: 800, color: '#ccc', letterSpacing: 0.6 }}>ENTRY</span>
        <span style={{ color: '#999' }}>Price <b style={{ ...mono, color: '#9ae6b4' }}>{fmtUsd(pos.entryPrice)}</b></span>
        <span style={{ color: '#999' }}>Filled <b style={{ ...mono, color: '#9ae6b4' }}>{pos.totalShares} / {total} sh</b></span>
        <span style={{ color: '#999' }}>Avg <b style={{ ...mono, color: '#9ae6b4' }}>{fmtUsd(pos.avgCost)}</b></span>
      </div>

      {/* The 5-lot ladder */}
      <div style={{ padding: '2px 4px' }}>
        {ordered.map(l => (
          <div key={l.i} style={{ display: 'grid', gridTemplateColumns: '52px 84px 70px 76px', gap: 10, alignItems: 'center', padding: '3px 0', fontSize: 12, fontWeight: l.status === 'FILLED' ? 700 : 400, opacity: l.status === 'LOCKED' ? 0.5 : 1 }}>
            <span style={{ color: STATUS_COLORS[l.status] }}>{l.status === 'LOCKED' ? '○' : '●'} {l.label}</span>
            <span style={mono}>{fmtUsd(l.trig)}</span>
            <span style={mono}>{l.sh} sh</span>
            <span style={{ color: STATUS_COLORS[l.status], fontSize: 11 }}>{l.status}</span>
          </div>
        ))}
      </div>

      {/* Stop */}
      <div style={{ display: 'flex', gap: 20, alignItems: 'center', padding: '7px 0 0', fontSize: 12, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, color: '#ef4444' }}>2-Bar Stop</span>
        <b style={{ ...mono, color: '#ef4444' }}>{fmtUsd(pos.stop || pos.stopPrice)}</b>
        <span style={{ color: '#999' }}>Risk <b style={{ ...mono, color: risk > 200 ? '#ef4444' : '#ddd' }}>{fmtUsd(risk)}</b></span>
        <span style={{ color: '#999' }}>RPS <b style={{ ...mono, color: '#ddd' }}>{fmtUsd(rps)}</b></span>
      </div>

      {/* RULE VERIFICATION — paper analogue of Ambush's IBKR-truth checks */}
      {pos.rec && (
        <div style={{ border: '1px solid #2a2a33', borderRadius: 6, padding: '6px 9px', marginTop: 9, background: '#121217' }}>
          <span style={{ fontSize: 10, fontWeight: 800, color: '#9a9aa6', letterSpacing: 0.5 }}>RULE VERIFICATION <span style={{ color: '#555', fontWeight: 400 }}>· paper (IBKR-truth when live)</span></span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 5 }}>
            {Object.entries(pos.rec.checks).map(([k, c]) => (
              <span key={k} style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 5, color: c.status === 'red' ? '#ffb4b4' : c.status === 'yellow' ? '#f0d090' : '#8a8a96' }} title={c.reason || 'OK'}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: PILL[c.status] || PILL.gray }} />
                {CHECK_LABEL[k] || k}{c.status !== 'green' && c.reason ? `: ${c.reason}` : ''}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// 5D Sector Rank strip (ported from ORDERS AI) — the GO / NO-GO regime that gates entries.
function SectorStrip({ summary }) {
  if (!summary || (!summary.go?.length && !summary.nogo?.length)) return null;
  const row = (label, arr, color) => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', alignItems: 'baseline' }}>
      <span style={{ color, fontWeight: 700 }}>{label}</span>
      {(arr || []).map(s => (
        <span key={`${label}-${s.sectorId}`}><span style={{ color }}>{s.name}</span> <span style={{ color: '#888' }}>{((s.fiveDayReturn ?? 0) * 100).toFixed(2)}%</span></span>
      ))}
    </div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 14px', margin: '0 0 12px', background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 6, fontSize: 11, fontFamily: 'monospace', color: '#ccc' }}>
      <span style={{ color: '#fcf000', fontWeight: 700 }}>5D Sector Rank · {summary.asOf || '—'}</span>
      {row('GO ▲', summary.go, '#16a34a')}
      {row('NO GO ▼', summary.nogo, '#dc2626')}
    </div>
  );
}

export default function EliteAiPage() {
  const [doc, setDoc] = useState(null);
  const [ordersDoc, setOrdersDoc] = useState(null);   // weekly BL pool + 5D sector rank (display only)
  const [sizing, setSizing] = useState(null);          // graduated-sizing tier
  const [scorecard, setScorecard] = useState(null);    // long-vs-short validation
  const [projection, setProjection] = useState(null);  // projected-vs-actual AUM (backtest)
  const [positions, setPositions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState(null);
  const [chartTickers, setChartTickers] = useState([]);
  const [chartIndex, setChartIndex] = useState(0);

  const load = useCallback(async () => {
    try {
      const [c, o, p, s, sc, pr] = await Promise.all([fetchReentrySignals().catch(() => ({ signals: [] })), fetchLatestAiOrders({}).catch(() => null), fetchEliteAiPositions().catch(() => []), fetchEliteSizing().catch(() => null), fetchEliteScorecard().catch(() => null), fetchEliteProjection().catch(() => null)]);
      setDoc(c); setOrdersDoc(o); setPositions(Array.isArray(p) ? p : []); setSizing(s); setScorecard(sc); setProjection(pr);
    } catch (e) { setMsg(e.message); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); const id = setInterval(load, 60000); return () => clearInterval(id); }, [load]);

  const doRun = async () => { setRunning(true); setMsg(null); try { const r = await runEliteDryRun({}); setMsg(`Dry-run: opened ${r.created?.length || 0} paper position(s), ${r.totalOpen} open.`); await load(); } catch (e) { setMsg('Error: ' + e.message); } setRunning(false); };
  const doReset = async () => { setRunning(true); setMsg(null); try { const r = await resetEliteDryRun(); setMsg(`Reset: cleared ${r.deleted} paper position(s).`); await load(); } catch (e) { setMsg('Error: ' + e.message); } setRunning(false); };
  const doManage = async () => { setRunning(true); setMsg(null); try { const r = await manageEliteDryRun(); setMsg(`Tick: ${r.fills} lot fill(s), ${r.exits} exit(s) across ${r.managed} position(s).`); await load(); } catch (e) { setMsg('Error: ' + e.message); } setRunning(false); };
  const openChart = (ticker, list) => { const arr = (list && list.length) ? [...new Set(list)] : [ticker]; setChartIndex(Math.max(0, arr.indexOf(ticker))); setChartTickers(arr); };

  const candidates = doc?.signals || [];
  const heldTickers = new Set(positions.map(p => (p.ticker || '').toUpperCase()));
  const waiting = candidates.filter(c => !heldTickers.has((c.ticker || '').toUpperCase())); // breakout-ready, not yet in the book
  const huntingSet = new Set(waiting.map(c => (c.ticker || '').toUpperCase()));
  // STALKING = the weekly BL pool still waiting: not yet breaking out (HUNTING) and not held
  const blPool = (ordersDoc?.orders || []).filter(o => o.signal === 'BL');
  const stalking = blPool.filter(o => { const t = (o.ticker || '').toUpperCase(); return !heldTickers.has(t) && !huntingSet.has(t); });
  const devour = positions.filter(p => !p.atBE);
  const protect = positions.filter(p => p.atBE);
  const sumPnl = (arr) => arr.reduce((s, p) => s + (+p.livePnl || 0), 0);   // refreshes on each 60s poll
  const devourPnl = sumPnl(devour);
  const protectPnl = sumPnl(protect);
  const totalOpenPnl = devourPnl + protectPnl;
  // risk-at-stop per section + paper-book heat vs the 15% NAV cap the engine gates on
  const NAV = sizing?.paperNav || 100000;
  const sumRisk = (arr) => arr.reduce((s, p) => s + Math.abs((+p.avgCost || +p.entryPrice) - (+p.stop || +p.stopPrice)) * (+p.totalShares || 0), 0);
  const devourRisk = sumRisk(devour);
  const protectRisk = sumRisk(protect);
  const bookRisk = devourRisk + protectRisk;
  const heatPct = (bookRisk / NAV) * 100;
  const capacity = Math.max(0, NAV * 0.15 - bookRisk);
  const counts = { STALKING: stalking.length, HUNTING: waiting.length, DEVOUR: devour.length, PROTECT: protect.length };

  const mceBox = (list) => (
    <div className={styles.section} style={{ borderLeftColor: '#f59e0b' }}>
      <div className={styles.sectionHeader}><span className={styles.sectionTitle}>HUNTING — MCE breakout candidates (ready to enter)</span>
        <div className={styles.sectionBadges}><span style={{ color: '#f59e0b' }}>{list.length} ready</span></div></div>
      {list.length === 0 ? <div className={styles.emptyState}>No breakout candidates waiting — every confirmed name is already in the paper book below</div> : (
        <div style={{ padding: '8px 10px' }}>
          {list.map(c => (
            <span key={c.ticker} onClick={() => openChart(c.ticker, list.map(x => x.ticker))} title={`${c.ticker}  ${c.sectorName || ''}\nL1 trigger $${(+c.entryTrigger).toFixed(2)} | weekly stop $${(+c.weeklyStop).toFixed(2)} | ${(c.lotShares || [])[0] || 0} sh | RPS $${(+c.rps).toFixed(2)}\nweekly BL ${c.signalDate || ''} · click for charts`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 8px', margin: 3, borderRadius: 4, fontSize: 11, fontWeight: 700, fontFamily: 'monospace', background: '#16a34a', color: '#fff', border: '1px solid #f59e0b', cursor: 'pointer' }}>
              {c.ticker}<span style={{ fontSize: 9, opacity: 0.8 }}>${(+c.entryTrigger).toFixed(0)}</span>
            </span>
          ))}
        </div>)}
    </div>
  );

  return (
    <AumShield block showDuration>
      <div style={{ padding: '0 4px' }}>
        <PageHeader title="Elite AI" description="Automated paper engine for the PNTHR AI 300 Elite (MCE) strategy — the same daily-breakout scan as ORDERS AI. HUNTING = breakout candidates ready to enter; DEVOUR = the isolated dry-run paper book (no orders, no IBKR)." />

        {/* ═══ PROJECTED vs ACTUAL AUM (backtest, hypothetical) ═══ */}
        <AumTracker projection={projection} />

        {/* ═══ PNTHR GOALS — ride today's real AUM forward at the Elite backtest CAGR ═══ */}
        <ForwardProjection forward={projection?.forward} />

        {/* dry-run control bar */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '6px 0 12px' }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#a78bfa', border: '1px solid #6d5bbf', borderRadius: 4, padding: '3px 8px' }}>DRY-RUN · PAPER</span>
          {sizing && <span title={`Graduated sizing — paper equity $${(sizing.paperNav || 0).toLocaleString()}. Steps: 50% under $125K, 75% under $166K, 100% above. At 50% that caps L1 risk ~$150/name.`} style={{ fontSize: 11, fontWeight: 700, color: '#f59e0b', border: '1px solid #b07d1a', borderRadius: 4, padding: '3px 8px' }}>SIZING {sizing.sizingPct}%</span>}
          <button disabled={running} onClick={doRun} style={{ background: '#16a34a', color: '#fff', border: 0, borderRadius: 5, padding: '5px 12px', fontWeight: 700, cursor: 'pointer', opacity: running ? 0.6 : 1 }}>Run Dry-Run</button>
          <button disabled={running} onClick={doManage} style={{ background: '#2563eb', color: '#fff', border: 0, borderRadius: 5, padding: '5px 12px', fontWeight: 700, cursor: 'pointer', opacity: running ? 0.6 : 1 }}>Tick (manage)</button>
          <button disabled={running} onClick={doReset} style={{ background: 'transparent', color: '#888', border: '1px solid #3a3a44', borderRadius: 5, padding: '5px 12px', cursor: 'pointer' }}>Reset paper book</button>
          {msg && <span style={{ fontSize: 12, color: '#9ae6b4' }}>{msg}</span>}
        </div>

        {/* funnel header */}
        <div style={{ display: 'flex', alignItems: 'stretch', gap: 6, flexWrap: 'wrap', margin: '6px 0 16px' }}>
          {STAGES.map((s, i) => (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div title={s.tip} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minWidth: 96, padding: '8px 12px', borderRadius: 8, cursor: 'help', background: '#16161c', border: `1px solid ${s.color}55`, borderBottom: `3px solid ${s.color}` }}>
                <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.06em', color: s.color }}>{s.key}</span>
                <span style={{ fontSize: 20, fontWeight: 800, color: counts[s.key] ? '#fff' : '#555' }}>{counts[s.key]}</span>
              </div>
              {i < STAGES.length - 1 && <span style={{ color: '#555', fontSize: 18 }}>→</span>}
            </div>
          ))}
          {/* per-section open-P&L summary — far right; refreshes on each 60s poll */}
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3, marginLeft: 'auto', padding: '8px 16px', borderRadius: 8, background: '#16161c', border: '1px solid #2a2a33' }}>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.06em', color: '#9a9aa6', marginBottom: 1 }}>{'OPEN P&L'}</div>
            {[['DEVOUR', devourPnl, '#22c55e'], ['PROTECT', protectPnl, '#3b82f6']].map(([label, val, c]) => (
              <div key={label} style={{ display: 'flex', gap: 12, fontSize: 12, fontFamily: 'monospace', alignItems: 'baseline' }}>
                <span style={{ color: c, width: 62 }}>{label}</span>
                <b style={{ color: val >= 0 ? '#22c55e' : '#ef4444' }}>{val >= 0 ? '+' : ''}{fmtUsd(val)}</b>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 12, fontSize: 12, fontFamily: 'monospace', alignItems: 'baseline', borderTop: '1px solid #2a2a33', paddingTop: 3, marginTop: 1 }}>
              <span style={{ color: '#ccc', width: 62, fontWeight: 700 }}>TOTAL</span>
              <b style={{ color: totalOpenPnl >= 0 ? '#22c55e' : '#ef4444' }}>{totalOpenPnl >= 0 ? '+' : ''}{fmtUsd(totalOpenPnl)}</b>
            </div>
          </div>

          {/* RISK at stop — mirrors OPEN P&L: what the book loses if every stop hits */}
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3, padding: '8px 16px', borderRadius: 8, background: '#16161c', border: '1px solid #2a2a33' }}>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.06em', color: '#f97316', marginBottom: 1 }}>RISK AT STOP</div>
            {[['DEVOUR', devourRisk, '#22c55e'], ['PROTECT', protectRisk, '#3b82f6']].map(([label, val, c]) => (
              <div key={label} style={{ display: 'flex', gap: 12, fontSize: 12, fontFamily: 'monospace', alignItems: 'baseline' }}>
                <span style={{ color: c, width: 62 }}>{label}</span>
                <b style={{ color: '#ddd' }}>{fmtUsd(val)}</b>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 12, fontSize: 12, fontFamily: 'monospace', alignItems: 'baseline', borderTop: '1px solid #2a2a33', paddingTop: 3, marginTop: 1 }}>
              <span style={{ color: '#ccc', width: 62, fontWeight: 700 }}>TOTAL</span>
              <b style={{ color: heatPct >= 15 ? '#dc2626' : '#ddd' }}>{fmtUsd(bookRisk)}</b>
            </div>
          </div>
        </div>

        {loading && <div className={styles.emptyState}>Loading…</div>}

        {!loading && (
          <>
            <SectorStrip summary={ordersDoc?.summary} />

            {/* paper-book heat bar (ported from ORDERS AI, pointed at the paper book) */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '8px 12px', margin: '0 0 12px', background: '#16161c', border: '1px solid #2a2a33', borderRadius: 6, fontSize: 12 }}>
              <span style={{ color: '#f97316', fontWeight: 700, letterSpacing: '0.06em', fontSize: 11 }}>PAPER HEAT</span>
              <div style={{ flex: 1, minWidth: 140, maxWidth: 320, height: 8, background: '#0e0e13', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ width: `${Math.min(100, (heatPct / 15) * 100)}%`, height: '100%', background: heatPct >= 15 ? '#dc2626' : heatPct >= 10 ? '#f97316' : '#16a34a' }} />
              </div>
              <span style={{ color: heatPct >= 15 ? '#dc2626' : '#ccc', fontWeight: 700, fontFamily: 'monospace' }}>{heatPct.toFixed(1)}% / 15%</span>
              <span style={{ color: '#888' }}>risk <b style={{ color: '#ddd', fontFamily: 'monospace' }}>{fmtUsd(bookRisk)}</b></span>
              <span style={{ color: '#888' }}>capacity <b style={{ color: '#16a34a', fontFamily: 'monospace' }}>{fmtUsd(capacity)}</b></span>
              <span style={{ color: '#888' }}>{positions.length} positions · $100k paper NAV</span>
            </div>

            <LongShortScorecard scorecard={scorecard} />

            <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>{candidates.length} MCE breakout candidate{candidates.length === 1 ? '' : 's'} · {devour.length + protect.length} in the paper book · mirrors the ORDERS AI / PNTHR MCE scan (active weekly BL · top-100 TTM · daily 2-bar high breakout · bull sectors)</div>

            {/* STALKING — the broad weekly BL pool still waiting for a breakout */}
            <div className={styles.section} style={{ borderLeftColor: '#a78bfa' }}>
              <div className={styles.sectionHeader}><span className={styles.sectionTitle}>STALKING — weekly BL pool (watching for a breakout)</span>
                <div className={styles.sectionBadges}><span style={{ color: '#a78bfa' }}>{stalking.length} watching</span></div></div>
              {stalking.length === 0 ? <div className={styles.emptyState}>No names in the weekly BL pool waiting (or orders still loading)</div> : (
                <div style={{ padding: '8px 10px' }}>
                  {stalking.map(o => (
                    <span key={o.ticker} onClick={() => openChart(o.ticker, stalking.map(x => x.ticker))} title={`${o.ticker}  ${o.sectorName || ''}${o.qualityGrade ? '  ·  ' + o.qualityGrade : ''} · click for charts`}
                      style={{ display: 'inline-flex', alignItems: 'center', padding: '3px 8px', margin: 3, borderRadius: 4, fontSize: 11, fontWeight: 700, fontFamily: 'monospace', background: '#221f33', color: '#cdb6ff', border: '1px solid #6d5bbf', cursor: 'pointer' }}>
                      {o.ticker}
                    </span>
                  ))}
                </div>)}
            </div>

            {mceBox(waiting)}

            <div className={styles.section} style={{ borderLeftColor: '#22c55e' }}>
              <div className={styles.sectionHeader}><span className={styles.sectionTitle}>DEVOUR — live paper positions</span>
                <div className={styles.sectionBadges}><span style={{ color: '#22c55e' }}>DEVOUR {devour.length}</span><span title="Open paper P&L of the DEVOUR positions — refreshes every 60s" style={{ fontSize: 13, fontWeight: 800, color: devourPnl >= 0 ? '#22c55e' : '#ef4444', background: '#0e0e13', border: `1px solid ${devourPnl >= 0 ? '#1f3a24' : '#4a2230'}`, borderRadius: 5, padding: '2px 9px' }}>{devourPnl >= 0 ? '+' : ''}{fmtUsd(devourPnl)} open</span></div></div>
              {devour.length === 0
                ? <div className={styles.emptyState}>No paper positions yet — the cron auto-enters the MCE breakout names during market hours, or click "Run Dry-Run" now</div>
                : <div style={{ padding: '4px 8px' }}>{devour.map(p => <LadderCard key={p.ticker} pos={p} onChart={openChart} allTickers={devour.map(x => x.ticker)} />)}</div>}
            </div>

            {protect.length > 0 && (
              <div className={styles.section} style={{ borderLeftColor: '#3b82f6' }}>
                <div className={styles.sectionHeader}><span className={styles.sectionTitle}>PROTECT — stop ratcheted to break-even+</span>
                  <div className={styles.sectionBadges}><span style={{ color: '#3b82f6' }}>PROTECT {protect.length}</span></div></div>
                <div style={{ padding: '4px 8px' }}>{protect.map(p => <LadderCard key={p.ticker} pos={p} onChart={openChart} allTickers={protect.map(x => x.ticker)} />)}</div>
              </div>
            )}
          </>
        )}
      </div>
      {chartTickers.length > 0 && (
        <AiTickerChartModal tickers={chartTickers} initialIndex={chartIndex} onClose={() => setChartTickers([])} />
      )}
    </AumShield>
  );
}
