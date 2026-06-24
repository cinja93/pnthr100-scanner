import { useState, useEffect } from 'react';
import PageHeader from './PageHeader';
import { API_BASE, authHeaders, fetchPnthrAccountingPeriods } from '../services/api';

// PNTHR Accounting — INTERNAL admin page.
// Self-administration of the monthly fund-accounting package that replaces NAV.
// This is the placeholder grid: every month of 2026 + 2027 has a bucket, and the
// 5 documents (2 investor PDFs + 3 Excel working papers) auto-drop into their slot
// as the engine generates them each month. Empty slots show "—" until produced.

const GOLD = '#FFD700';
const GREEN = '#00c853';
const RED = '#ff5252';
const DIM = '#666';

const STATUS_COLORS = {
  empty:     { fg: DIM,   label: 'Not produced' },
  draft:     { fg: GOLD,  label: 'Draft' },
  finalized: { fg: GREEN, label: 'Finalized' },
};

function ReconBadge({ reconciliation }) {
  if (!reconciliation || !reconciliation.status) {
    return <span style={{ color: DIM, fontSize: 11, fontFamily: 'monospace' }}>RECON: —</span>;
  }
  const green = reconciliation.status === 'green';
  return (
    <span style={{
      color: green ? GREEN : RED, fontSize: 11, fontWeight: 800,
      fontFamily: 'monospace', letterSpacing: 1,
    }}>
      RECON: {green ? 'GREEN' : 'RED'}
    </span>
  );
}

export default function PnthrAccountingPage() {
  const [docTypes, setDocTypes] = useState([]);
  const [periods, setPeriods] = useState([]);
  const [year, setYear] = useState(2026);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchPnthrAccountingPeriods();
      setDocTypes(data.docTypes || []);
      setPeriods(data.periods || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const years = [...new Set(periods.map(p => p.year))].sort();
  const monthsForYear = periods
    .filter(p => p.year === year)
    .sort((a, b) => a.month - b.month);

  async function handleDoc(docId, filename, download) {
    try {
      const endpoint = download ? 'download' : 'view';
      const res = await fetch(`${API_BASE}/api/pnthr-accounting/documents/${docId}/${endpoint}`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`${download ? 'Download' : 'View'} failed`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (download) {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        window.open(url, '_blank');
      }
    } catch (err) {
      alert(err.message);
    }
  }

  // Find the document(s) for a given month + docType. Per-investor types can have several.
  function docsFor(period, docTypeKey) {
    return (period.documents || []).filter(d => d.docType === docTypeKey);
  }

  function DocCell({ period, dt }) {
    const docs = docsFor(period, dt.key);
    if (docs.length === 0) {
      return <span style={{ color: DIM, fontFamily: 'monospace' }}>—</span>;
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {docs.map(d => {
          const sc = STATUS_COLORS[d.status] || STATUS_COLORS.draft;
          return (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span title={d.investorNo ? `Investor ${d.investorNo}` : sc.label}
                style={{ width: 7, height: 7, borderRadius: '50%', background: sc.fg, flexShrink: 0 }} />
              <button onClick={() => handleDoc(d.id, d.filename, false)}
                style={linkBtn(sc.fg)} title="View">View</button>
              <button onClick={() => handleDoc(d.id, d.filename, true)}
                style={linkBtn(DIM)} title="Download">↓</button>
              {d.investorNo && <span style={{ color: DIM, fontSize: 10, fontFamily: 'monospace' }}>#{d.investorNo}</span>}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="PNTHR Accounting"
        description="Self-administered monthly fund-accounting package (replaces NAV). Each month of 2026 and 2027 has a placeholder; generated documents drop into their slot automatically. Nothing finalizes until the books reconcile to IBKR and the bank to the penny."
      />

      {/* Year tabs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14 }}>
        {(years.length ? years : [2026, 2027]).map(y => {
          const active = y === year;
          return (
            <button key={y} onClick={() => setYear(y)} style={{
              padding: '6px 18px', borderRadius: 6,
              border: active ? `1px solid ${GOLD}` : '1px solid #333',
              background: active ? 'rgba(255,215,0,0.12)' : '#111',
              color: active ? GOLD : DIM,
              fontWeight: active ? 800 : 600, fontSize: 13,
              fontFamily: 'monospace', letterSpacing: 1.5, cursor: 'pointer', transition: 'all 0.15s',
            }}>{y}</button>
          );
        })}
        <button onClick={load} disabled={loading} style={{
          marginLeft: 'auto', padding: '6px 14px', borderRadius: 6,
          border: '1px solid #333', background: '#111', color: DIM,
          fontSize: 12, fontFamily: 'monospace', cursor: 'pointer',
        }}>{loading ? 'Loading…' : '↻ Refresh'}</button>
      </div>

      {error && (
        <div style={{ padding: 16, border: `1px solid ${RED}`, borderRadius: 6, color: RED, marginBottom: 14 }}>
          ⚠️ {error}
        </div>
      )}

      {loading && periods.length === 0 ? (
        <div style={{ padding: 40, color: DIM, textAlign: 'center' }}>Loading monthly placeholders…</div>
      ) : (
        <div style={{ overflowX: 'auto', border: '1px solid #222', borderRadius: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#0d0d0d', borderBottom: '1px solid #222' }}>
                <th style={th()}>Month</th>
                <th style={th()}>Reconciliation</th>
                {docTypes.map(dt => (
                  <th key={dt.key} style={th()}>
                    {dt.label}
                    <span style={{ display: 'block', color: DIM, fontSize: 9, fontWeight: 400 }}>.{dt.ext}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {monthsForYear.map(p => (
                <tr key={p.period} style={{ borderBottom: '1px solid #1a1a1a' }}>
                  <td style={td()}>
                    <span style={{ color: '#eee', fontWeight: 700 }}>{p.label}</span>
                    <span style={{ display: 'block', color: DIM, fontSize: 10, fontFamily: 'monospace' }}>{p.period}</span>
                  </td>
                  <td style={td()}><ReconBadge reconciliation={p.reconciliation} /></td>
                  {docTypes.map(dt => (
                    <td key={dt.key} style={td()}><DocCell period={p} dt={dt} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 14, color: DIM, fontSize: 11, fontFamily: 'monospace', lineHeight: 1.6 }}>
        Legend: <span style={{ color: DIM }}>● Not produced</span> &nbsp;·&nbsp;
        <span style={{ color: GOLD }}>● Draft</span> &nbsp;·&nbsp;
        <span style={{ color: GREEN }}>● Finalized</span> &nbsp;|&nbsp;
        Documents are produced by the monthly close engine (built in a later phase) and reconcile to IBKR + bank before finalizing.
      </div>
    </>
  );
}

function th() {
  return { padding: '10px 12px', textAlign: 'left', color: '#aaa', fontSize: 11, fontWeight: 700,
    fontFamily: 'monospace', letterSpacing: 0.5, whiteSpace: 'nowrap', verticalAlign: 'bottom' };
}
function td() {
  return { padding: '10px 12px', verticalAlign: 'top', whiteSpace: 'nowrap' };
}
function linkBtn(color) {
  return { background: 'none', border: 'none', color, fontSize: 12, fontFamily: 'monospace',
    cursor: 'pointer', padding: 0, textDecoration: 'underline' };
}
