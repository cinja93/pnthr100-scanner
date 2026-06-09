// client/src/components/EliteAiPage.jsx
// ── PNTHR Elite AI — automated funnel for the AI 300 Elite strategy ──────────
//
// READ-ONLY funnel view (v1). Reuses the existing AI Orders data (no backend
// changes, no execution) and lays the AI-300 Elite pipeline out in the Ambush
// stair-step funnel UX:
//
//   STALKING → HUNTING → ATTACK → DEVOUR → PROTECT
//
// The strategy BRAIN is AI Orders (aiOrdersPipeline + aiAutoExecute, gated off);
// this page is the PLATFORM wrapper (the funnel Scott loves), modeled on Ambush
// but wired to AI-300 data. Isolated: new page, new sidebar button, touches
// nothing in Ambush or the existing pages.
//
// Grade IS the funnel progression: GOOD (watching) → BETTER (closing in) →
// BEST (cleared, ready to fire). Chips brighten as a name climbs.
// ────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useCallback } from 'react';
import { fetchLatestAiOrders, API_BASE, authHeaders } from '../services/api';
import PageHeader from './PageHeader';
import AumShield from './AumShield';
import styles from './AmbushPage.module.css';

const STAGES = [
  { key: 'STALKING',     color: '#a78bfa', tip: 'STALKING (purple): the prey pool — every AI-300 name with an active weekly BL / SS signal, watching for its daily trigger to clear. Grade GOOD/BETTER.' },
  { key: 'HUNTING',      color: '#f59e0b', tip: 'HUNTING (amber): the daily trigger cleared (grade BEST) — gapped past its threshold, ready to fire at Monday open or on the daily 2-bar breakout.' },
  { key: 'ATTACK',       color: '#f97316', tip: 'ATTACK (orange): the pounce — the entry order fires (L1 market + protective stop + L2-L5 lot triggers).' },
  { key: 'DEVOUR',       color: '#22c55e', tip: 'DEVOUR (green): a live position, pyramiding into the trend on the 5-lot ladder.' },
  { key: 'STILL HUNGRY', color: '#e879f9', tip: 'STILL HUNGRY (pink): exited / closed names hunting a re-entry on a fresh daily breakout.' },
  { key: 'PROTECT',      color: '#3b82f6', tip: 'PROTECT (blue): a lot ratcheted the stop to break-even-or-better — the kill is secured.' },
];

const GRADE_STYLE = {
  BEST:   { glow: true,  op: 1.0,  ring: '#f59e0b' },
  BETTER: { glow: false, op: 0.92, ring: '#a78bfa' },
  GOOD:   { glow: false, op: 0.62, ring: '#6d5bbf' },
};

function fmt(n, d = 2) { return (n == null || isNaN(n)) ? '--' : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }); }
function fmtUsd(n) { return n == null || isNaN(n) ? '--' : `$${fmt(n, 2)}`; }

// A single candidate chip — brightness/glow rises with grade (the "lighting up").
function Chip({ o }) {
  const isLong = o.signal === 'BL';
  const g = GRADE_STYLE[o.qualityGrade] || GRADE_STYLE.GOOD;
  const base = isLong ? '#16a34a' : '#dc2626';
  return (
    <span
      title={`${o.ticker} · ${o.signal === 'BL' ? 'LONG' : 'SHORT'} · ${o.qualityGrade} · gap ${fmt(o.gapPct, 1)}% · ${o.sectorTier || ''}\nEntry ${fmtUsd(o.currentPrice)} · stop ${fmtUsd(o.stopPrice)}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '3px 8px', margin: 3, borderRadius: 4, fontSize: 11, fontWeight: 700,
        fontFamily: 'monospace', letterSpacing: '0.02em',
        background: base, color: '#fff', opacity: g.op,
        border: `1px solid ${g.ring}`,
        boxShadow: g.glow ? `0 0 7px ${g.ring}` : 'none',
      }}
    >
      {o.ticker}
      <span style={{ fontSize: 9, opacity: 0.85 }}>{fmt(o.gapPct, 0)}%</span>
    </span>
  );
}

export default function EliteAiPage() {
  const [doc, setDoc] = useState(null);
  const [positions, setPositions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await fetchLatestAiOrders({});
      setDoc(d);
      try {
        const res = await fetch(`${API_BASE}/api/positions`, { headers: authHeaders() });
        if (res.ok) { const p = await res.json(); setPositions(Array.isArray(p) ? p : (p.positions || [])); }
      } catch { /* positions are best-effort */ }
      setErr(null);
    } catch (e) { setErr(e.message); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); const id = setInterval(load, 60000); return () => clearInterval(id); }, [load]);

  const orders = (doc?.orders || []).filter(o => o.signal === 'BL' || o.signal === 'SS');
  const byGrade = (gradeTest) => orders.filter(o => gradeTest(o.qualityGrade));
  const stalking = byGrade(g => g !== 'BEST');
  const hunting = byGrade(g => g === 'BEST');
  const splitLS = (list) => ({ longs: list.filter(o => o.signal === 'BL'), shorts: list.filter(o => o.signal === 'SS') });

  // Live AI-300 positions → DEVOUR / PROTECT (best-effort; empty until Elite AI executes live)
  const live = (positions || []).filter(p => (p.status === 'ACTIVE' || p.status === 'PARTIAL' || (+p.totalShares || +p.shares || 0) !== 0));
  const protect = live.filter(p => p.atBE);
  const devour = live.filter(p => !p.atBE);

  const counts = {
    STALKING: stalking.length, HUNTING: hunting.length, ATTACK: 0,
    DEVOUR: devour.length, 'STILL HUNGRY': 0, PROTECT: protect.length,
  };

  const candidateBox = (title, list, color) => {
    const { longs, shorts } = splitLS(list);
    return (
      <div className={styles.section} style={{ borderLeftColor: color }}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>{title}</span>
          <div className={styles.sectionBadges}>
            <span style={{ color: '#16a34a' }}>BL {longs.length}</span>
            <span style={{ color: '#dc2626' }}>SS {shorts.length}</span>
          </div>
        </div>
        {list.length === 0 ? (
          <div className={styles.emptyState}>No candidates at this stage</div>
        ) : (
          <div style={{ padding: '8px 10px' }}>
            {longs.length > 0 && (<div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 10, color: '#16a34a', fontWeight: 700, marginBottom: 3 }}>BL LONGS</div>
              {longs.map(o => <Chip key={o.ticker} o={o} />)}
            </div>)}
            {shorts.length > 0 && (<div>
              <div style={{ fontSize: 10, color: '#dc2626', fontWeight: 700, marginBottom: 3 }}>SS SHORTS</div>
              {shorts.map(o => <Chip key={o.ticker} o={o} />)}
            </div>)}
          </div>
        )}
      </div>
    );
  };

  const livePositionsBox = (title, list, color) => (
    <div className={styles.section} style={{ borderLeftColor: color }}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>{title}</span>
        <div className={styles.sectionBadges}><span style={{ color }}>{title} {list.length}</span></div>
      </div>
      {list.length === 0 ? (
        <div className={styles.emptyState}>No live positions yet — execution engine (aiAutoExecute) is gated off pending a separate account</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Ticker</th><th>Dir</th><th style={{ textAlign: 'right' }}>Shares</th><th style={{ textAlign: 'right' }}>Avg</th><th style={{ textAlign: 'right' }}>Stop</th></tr></thead>
            <tbody>
              {list.map(p => (
                <tr key={p.ticker || p.id}>
                  <td style={{ fontWeight: 700 }}>{p.ticker}</td>
                  <td>{p.direction || (p.signal === 'SS' ? 'SHORT' : 'LONG')}</td>
                  <td style={{ textAlign: 'right' }}>{p.totalShares || p.shares || 0}</td>
                  <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{fmtUsd(p.avgCost || p.entryPrice)}</td>
                  <td style={{ textAlign: 'right', fontFamily: 'monospace', color: '#ef4444' }}>{fmtUsd(p.stopPrice || p.stop)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  return (
    <AumShield block showDuration>
      <div style={{ padding: '0 4px' }}>
        <PageHeader title="Elite AI" description="Automated funnel for the PNTHR AI 300 Elite strategy — weekly BL/SS signals climb the grade ladder to a daily-breakout entry, pyramid, and protective stop. Read-only preview." />

        {/* ── The stair-step funnel header ────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'stretch', gap: 6, flexWrap: 'wrap', margin: '10px 0 16px' }}>
          {STAGES.map((s, i) => (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div title={s.tip} style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                minWidth: 96, padding: '8px 12px', borderRadius: 8, cursor: 'help',
                background: '#16161c', border: `1px solid ${s.color}55`, borderBottom: `3px solid ${s.color}`,
              }}>
                <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.06em', color: s.color }}>{s.key}</span>
                <span style={{ fontSize: 20, fontWeight: 800, color: counts[s.key] ? '#fff' : '#555' }}>{counts[s.key]}</span>
              </div>
              {i < STAGES.length - 1 && <span style={{ color: '#555', fontSize: 18 }}>→</span>}
            </div>
          ))}
        </div>

        {loading && <div className={styles.emptyState}>Loading…</div>}
        {err && <div className={styles.emptyState} style={{ color: '#ef4444' }}>Error: {err}</div>}

        {!loading && doc && (
          <>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>
              Week of <b style={{ color: '#ccc' }}>{doc.weekOf}</b> · {orders.length} active BL/SS signals · grade brightens GOOD → BETTER → BEST as a name nears its trigger
            </div>
            {candidateBox('STALKING — weekly BL / SS candidates', stalking, '#a78bfa')}
            {candidateBox('HUNTING — cleared (BEST grade, ready to fire)', hunting, '#f59e0b')}
            {livePositionsBox('DEVOUR — live positions', devour, '#22c55e')}
            {livePositionsBox('PROTECT — stop at break-even+', protect, '#3b82f6')}
          </>
        )}
      </div>
    </AumShield>
  );
}
