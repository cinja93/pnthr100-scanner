// client/src/components/LongShortScorecard.jsx
// Shared LONG-vs-SHORT scorecard — validates the Ambush(short) / Elite(long) split
// on real data. Rendered on both the Elite AI and Ambush V7.6 pages.
// Data shape from GET /api/elite-ai/scorecard (getEliteScorecard):
//   { short:{n,wr,pnl}, ambLong:{n,wr,pnl}, eliteClosed:{n,wr,pnl}, eliteOpen:{n,pnl}, from, to }
const fmtUsd = (n) => (n == null || isNaN(n)) ? '--' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const col = (v) => (v >= 0 ? '#22c55e' : '#ef4444');
const sign = (v) => (v >= 0 ? '+' : '');

export default function LongShortScorecard({ scorecard }) {
  const sc = scorecard;
  if (!sc) return null;
  return (
    <div style={{ margin: '0 0 12px' }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: '#9a9aa6', letterSpacing: 0.5, marginBottom: 5 }}>
        LONG vs SHORT SCORECARD <span style={{ color: '#666', fontWeight: 400 }}>· validating the split on real data{sc.from ? ` · Ambush ${sc.from}→${sc.to}` : ''}</span>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 250, padding: '9px 13px', borderRadius: 8, background: '#16161c', border: '1px solid #2a2a33', borderLeft: '3px solid #22c55e' }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: '#22c55e', letterSpacing: 0.4, marginBottom: 4 }}>LONG · Elite AI (paper)</div>
          <div style={{ fontSize: 12, color: '#aaa', fontFamily: 'monospace' }}>
            open {sc.eliteOpen.n} · <b style={{ color: col(sc.eliteOpen.pnl) }}>{sign(sc.eliteOpen.pnl)}{fmtUsd(sc.eliteOpen.pnl)}</b>
            {sc.eliteClosed.n > 0 && <span> &nbsp;·&nbsp; closed {sc.eliteClosed.n} · win {sc.eliteClosed.wr}% · <b style={{ color: col(sc.eliteClosed.pnl) }}>{fmtUsd(sc.eliteClosed.pnl)}</b></span>}
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 250, padding: '9px 13px', borderRadius: 8, background: '#16161c', border: '1px solid #2a2a33', borderLeft: '3px solid #ef4444' }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: '#ef4444', letterSpacing: 0.4, marginBottom: 4 }}>SHORT · Ambush (live)</div>
          <div style={{ fontSize: 12, color: '#aaa', fontFamily: 'monospace' }}>
            {sc.short.n} trades · win {sc.short.wr}% · <b style={{ color: col(sc.short.pnl) }}>{sign(sc.short.pnl)}{fmtUsd(sc.short.pnl)}</b>
          </div>
        </div>
      </div>
      {sc.ambLong?.n > 0 && <div style={{ fontSize: 10, color: '#777', marginTop: 5 }}>Ambush longs (legacy, migrating to Elite): {sc.ambLong.n} · win {sc.ambLong.wr}% · {fmtUsd(sc.ambLong.pnl)}</div>}
    </div>
  );
}
