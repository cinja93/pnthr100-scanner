// client/src/components/EliteAiPage.jsx
// ── PNTHR Elite AI — automated funnel for the AI 300 Elite strategy ──────────
//
// The funnel (Ambush stair-step UX) wired to the AI-300 Elite brain:
//   STALKING → HUNTING → ATTACK → DEVOUR → STILL HUNGRY → PROTECT
//
// STALKING / HUNTING = weekly BL/SS candidates from the orders pipeline, chips
// brightening by qualityGrade (GOOD → BETTER → BEST). DEVOUR / PROTECT = the
// isolated DRY-RUN paper engine (pnthr_elite_positions) rendered as lot ladders.
// Paper only — no orders, no IBKR, nothing shared with Ambush or the portfolio.
// ────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useCallback } from 'react';
import { fetchLatestAiOrders, fetchEliteAiPositions, runEliteDryRun, resetEliteDryRun } from '../services/api';
import PageHeader from './PageHeader';
import AumShield from './AumShield';
import styles from './AmbushPage.module.css';

const STAGES = [
  { key: 'STALKING',     color: '#a78bfa', tip: 'Weekly BL / SS candidates watching for the daily trigger (grade GOOD/BETTER).' },
  { key: 'HUNTING',      color: '#f59e0b', tip: 'Cleared — grade BEST, ready to fire at Monday open or on the daily 2-bar breakout.' },
  { key: 'ATTACK',       color: '#f97316', tip: 'The pounce — entry fires (L1 market + stop + L2-L5 lot triggers).' },
  { key: 'DEVOUR',       color: '#22c55e', tip: 'Live paper position pyramiding on the 5-lot ladder.' },
  { key: 'STILL HUNGRY', color: '#e879f9', tip: 'Exited names hunting a re-entry on a fresh daily breakout.' },
  { key: 'PROTECT',      color: '#3b82f6', tip: 'Stop ratcheted to break-even+ — the kill is secured.' },
];
const GRADE_STYLE = { BEST: { op: 1.0, ring: '#f59e0b', glow: true }, BETTER: { op: 0.92, ring: '#a78bfa', glow: false }, GOOD: { op: 0.62, ring: '#6d5bbf', glow: false } };
const LOT_OFFSETS = [0, 0.03, 0.06, 0.10, 0.14];

const fmt = (n, d = 2) => (n == null || isNaN(n)) ? '--' : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtUsd = (n) => (n == null || isNaN(n)) ? '--' : `$${fmt(n, 2)}`;

function Chip({ o }) {
  const isLong = o.signal === 'BL';
  const g = GRADE_STYLE[o.qualityGrade] || GRADE_STYLE.GOOD;
  return (
    <span title={`${o.ticker} · ${isLong ? 'LONG' : 'SHORT'} · ${o.qualityGrade} · gap ${fmt(o.gapPct, 1)}% · ${o.sectorTier || ''}\nEntry ${fmtUsd(o.currentPrice)} · stop ${fmtUsd(o.stopPrice)}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', margin: 3, borderRadius: 4, fontSize: 11, fontWeight: 700, fontFamily: 'monospace', background: isLong ? '#16a34a' : '#dc2626', color: '#fff', opacity: g.op, border: `1px solid ${g.ring}`, boxShadow: g.glow ? `0 0 7px ${g.ring}` : 'none' }}>
      {o.ticker}<span style={{ fontSize: 9, opacity: 0.85 }}>{fmt(o.gapPct, 0)}%</span>
    </span>
  );
}

// DEVOUR ladder card — lays a paper position out as a price ladder (L1 anchor,
// lots stacking toward the trend, stop on the risk side).
function LadderCard({ pos }) {
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
    <div style={{ border: '1px solid #2a3a2e', borderLeft: '4px solid #22c55e', borderRadius: 8, background: '#0e0e13', padding: '12px 14px', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontWeight: 800, fontSize: 16, color: '#fff' }}>{pos.ticker}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: isLong ? '#16a34a' : '#dc2626', border: `1px solid ${isLong ? '#16a34a' : '#dc2626'}`, borderRadius: 3, padding: '1px 6px' }}>{pos.direction}</span>
        <span style={{ fontSize: 11, color: '#f59e0b' }}>{pos.qualityGrade}</span>
        <span style={{ fontSize: 11, color: '#888' }}>{pos.sector}</span>
        <span style={{ fontSize: 10, color: '#a78bfa', border: '1px solid #6d5bbf', borderRadius: 3, padding: '1px 6px' }}>PAPER</span>
        <span style={{ flex: 1 }} />
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
    </div>
  );
}

export default function EliteAiPage() {
  const [doc, setDoc] = useState(null);
  const [positions, setPositions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    try {
      const [d, p] = await Promise.all([fetchLatestAiOrders({}), fetchEliteAiPositions().catch(() => [])]);
      setDoc(d); setPositions(Array.isArray(p) ? p : []);
    } catch (e) { setMsg(e.message); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); const id = setInterval(load, 60000); return () => clearInterval(id); }, [load]);

  const doRun = async (minGrade) => { setRunning(true); setMsg(null); try { const r = await runEliteDryRun({ minGrade }); setMsg(`Dry-run (${minGrade}): opened ${r.created?.length || 0} paper position(s), ${r.totalOpen} open.`); await load(); } catch (e) { setMsg('Error: ' + e.message); } setRunning(false); };
  const doReset = async () => { setRunning(true); setMsg(null); try { const r = await resetEliteDryRun(); setMsg(`Reset: cleared ${r.deleted} paper position(s).`); await load(); } catch (e) { setMsg('Error: ' + e.message); } setRunning(false); };

  const orders = (doc?.orders || []).filter(o => o.signal === 'BL' || o.signal === 'SS');
  const stalking = orders.filter(o => o.qualityGrade !== 'BEST');
  const hunting = orders.filter(o => o.qualityGrade === 'BEST');
  const splitLS = (list) => ({ longs: list.filter(o => o.signal === 'BL'), shorts: list.filter(o => o.signal === 'SS') });
  const devour = positions.filter(p => !p.atBE);
  const protect = positions.filter(p => p.atBE);
  const counts = { STALKING: stalking.length, HUNTING: hunting.length, ATTACK: 0, DEVOUR: devour.length, 'STILL HUNGRY': 0, PROTECT: protect.length };

  const candidateBox = (title, list, color) => {
    const { longs, shorts } = splitLS(list);
    return (
      <div className={styles.section} style={{ borderLeftColor: color }}>
        <div className={styles.sectionHeader}><span className={styles.sectionTitle}>{title}</span>
          <div className={styles.sectionBadges}><span style={{ color: '#16a34a' }}>BL {longs.length}</span><span style={{ color: '#dc2626' }}>SS {shorts.length}</span></div></div>
        {list.length === 0 ? <div className={styles.emptyState}>No candidates at this stage</div> : (
          <div style={{ padding: '8px 10px' }}>
            {longs.length > 0 && <div style={{ marginBottom: 6 }}><div style={{ fontSize: 10, color: '#16a34a', fontWeight: 700, marginBottom: 3 }}>BL LONGS</div>{longs.map(o => <Chip key={o.ticker} o={o} />)}</div>}
            {shorts.length > 0 && <div><div style={{ fontSize: 10, color: '#dc2626', fontWeight: 700, marginBottom: 3 }}>SS SHORTS</div>{shorts.map(o => <Chip key={o.ticker} o={o} />)}</div>}
          </div>)}
      </div>
    );
  };

  return (
    <AumShield block showDuration>
      <div style={{ padding: '0 4px' }}>
        <PageHeader title="Elite AI" description="Automated funnel for the PNTHR AI 300 Elite strategy. STALKING/HUNTING = live weekly BL/SS candidates; DEVOUR = the isolated DRY-RUN paper engine (no orders, no IBKR)." />

        {/* dry-run control bar */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '6px 0 12px' }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#a78bfa', border: '1px solid #6d5bbf', borderRadius: 4, padding: '3px 8px' }}>DRY-RUN · PAPER</span>
          <button disabled={running} onClick={() => doRun('BEST')} style={{ background: '#16a34a', color: '#fff', border: 0, borderRadius: 5, padding: '5px 12px', fontWeight: 700, cursor: 'pointer', opacity: running ? 0.6 : 1 }}>Run Dry-Run (BEST)</button>
          <button disabled={running} onClick={() => doRun('BETTER')} style={{ background: '#7c3aed', color: '#fff', border: 0, borderRadius: 5, padding: '5px 12px', fontWeight: 700, cursor: 'pointer', opacity: running ? 0.6 : 1 }}>+ BETTER</button>
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
        </div>

        {loading && <div className={styles.emptyState}>Loading…</div>}

        {!loading && doc && (
          <>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>Week of <b style={{ color: '#ccc' }}>{doc.weekOf}</b> · {orders.length} active BL/SS signals · grade brightens GOOD → BETTER → BEST</div>
            {candidateBox('STALKING — weekly BL / SS candidates', stalking, '#a78bfa')}
            {candidateBox('HUNTING — cleared (BEST, ready to fire)', hunting, '#f59e0b')}

            <div className={styles.section} style={{ borderLeftColor: '#22c55e' }}>
              <div className={styles.sectionHeader}><span className={styles.sectionTitle}>DEVOUR — live paper positions</span>
                <div className={styles.sectionBadges}><span style={{ color: '#22c55e' }}>DEVOUR {devour.length}</span></div></div>
              {devour.length === 0
                ? <div className={styles.emptyState}>No paper positions — click "Run Dry-Run" to open the current BEST-grade names on paper</div>
                : <div style={{ padding: '4px 8px' }}>{devour.map(p => <LadderCard key={p.ticker} pos={p} />)}</div>}
            </div>
          </>
        )}
      </div>
    </AumShield>
  );
}
