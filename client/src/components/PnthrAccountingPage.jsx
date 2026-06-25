import { useState, useEffect } from 'react';
import PageHeader from './PageHeader';
import { API_BASE, authHeaders, fetchPnthrAccountingPeriods, fetchPnthrAccountingReference } from '../services/api';

// PNTHR Accounting — INTERNAL admin page.
// Self-administration of the monthly fund-accounting package that replaces NAV.
// The grid spans fund inception (June 2025) through 2027; each month holds the 5
// documents (2 investor PDFs + 3 Excel working papers). Historical months carry the
// NAV originals; future months fill as the engine produces them. A separate Reference
// Documents section holds fund-level docs (disclosure statement, statements guide).

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
  const [refDocs, setRefDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [auditBusy, setAuditBusy] = useState(false);
  const [k1Busy, setK1Busy] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [data, ref] = await Promise.all([
        fetchPnthrAccountingPeriods(),
        fetchPnthrAccountingReference().catch(() => ({ documents: [] })),
      ]);
      setDocTypes(data.docTypes || []);
      setPeriods(data.periods || []);
      setRefDocs(ref.documents || []);
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
  // Distinct investors for the selected year (from the per-investor individual statements).
  const investorsForYear = [...new Set(monthsForYear.flatMap(p =>
    (p.documents || []).filter(d => d.docType === 'individual_account_statement' && d.investorNo).map(d => d.investorNo)))].sort();

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

  // One-button auditor package: zips the year's statements + working papers + custodian sources.
  async function downloadAuditPackage() {
    setAuditBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/pnthr-accounting/audit-package/${year}`, { headers: authHeaders() });
      if (!res.ok) throw new Error('Audit package failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `PNTHR_Audit_Package_${year}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    } finally {
      setAuditBusy(false);
    }
  }

  // One-button K-1 tax-data package for a single investor + year (PDF for the tax preparer).
  async function downloadK1(investorNo) {
    setK1Busy(investorNo);
    try {
      const res = await fetch(`${API_BASE}/api/pnthr-accounting/k1-package/${year}/${investorNo}`, { headers: authHeaders() });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'K-1 package failed'); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `PNTHR_K1_${year}_Investor${investorNo}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    } finally {
      setK1Busy(null);
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
          const isPdf = (d.contentType || '').includes('pdf');
          return (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span title={d.investorNo ? `Investor ${d.investorNo}` : sc.label}
                style={{ width: 7, height: 7, borderRadius: '50%', background: sc.fg, flexShrink: 0 }} />
              {isPdf ? (
                <>
                  <button onClick={() => handleDoc(d.id, d.filename, false)} style={linkBtn(sc.fg)} title="View in browser">View</button>
                  <button onClick={() => handleDoc(d.id, d.filename, true)} style={linkBtn(DIM)} title="Download PDF">↓</button>
                </>
              ) : (
                <button onClick={() => handleDoc(d.id, d.filename, true)} style={linkBtn(sc.fg)} title="Download Excel">Download</button>
              )}
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
        description="Self-administered monthly fund-accounting package (replaces NAV). The grid spans fund inception (June 2025) through 2027; each month holds its document set. Nothing finalizes until the books reconcile to IBKR and the bank to the penny."
      />

      {/* Reference Documents — fund-level, not period-bound */}
      {refDocs.length > 0 && (
        <div style={{ border: '1px solid #222', borderRadius: 8, padding: '12px 14px', marginBottom: 16, background: '#0d0d0d' }}>
          <div style={{ color: '#aaa', fontSize: 11, fontWeight: 700, fontFamily: 'monospace', letterSpacing: 0.5, marginBottom: 8 }}>
            REFERENCE DOCUMENTS
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {refDocs.map(d => (
              <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid #1f2a3a', borderRadius: 6, padding: '8px 12px', background: '#111' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: GREEN, flexShrink: 0 }} />
                <span style={{ color: '#eee', fontSize: 13, fontWeight: 600 }}>{d.label}</span>
                <button onClick={() => handleDoc(d.id, d.filename, false)} style={linkBtn(GOLD)} title="View">View</button>
                <button onClick={() => handleDoc(d.id, d.filename, true)} style={linkBtn(DIM)} title="Download">↓ PDF</button>
              </div>
            ))}
          </div>
        </div>
      )}

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
        <button onClick={downloadAuditPackage} disabled={auditBusy}
          title={`Download the ${year} audit package (zip) — all statements, working papers, and IBKR custodian sources — to send to the auditor`}
          style={{
            marginLeft: 'auto', padding: '6px 14px', borderRadius: 6,
            border: '1px solid #2f6b46', background: '#0c140e', color: '#7fcf9f',
            fontSize: 12, fontWeight: 700, fontFamily: 'monospace', cursor: auditBusy ? 'wait' : 'pointer',
          }}>{auditBusy ? 'Packaging…' : `📦 Package for Audit (${year})`}</button>
        <button onClick={load} disabled={loading} style={{
          padding: '6px 14px', borderRadius: 6,
          border: '1px solid #333', background: '#111', color: DIM,
          fontSize: 12, fontFamily: 'monospace', cursor: 'pointer',
        }}>{loading ? 'Loading…' : '↻ Refresh'}</button>
      </div>

      {/* K-1 tax-data packages — one button per investor for the selected year */}
      {investorsForYear.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 14, padding: '8px 12px', border: '1px solid #3a2a14', borderRadius: 6, background: '#0d0d0d' }}>
          <span style={{ color: '#aaa', fontSize: 11, fontWeight: 700, fontFamily: 'monospace', letterSpacing: 0.5 }}>K-1 DATA PACKAGES ({year}):</span>
          {investorsForYear.map(no => (
            <button key={no} onClick={() => downloadK1(no)} disabled={k1Busy === no} style={{
              padding: '5px 12px', borderRadius: 6, border: '1px solid #6b4a2f', background: '#140f0c', color: '#f5b97f',
              fontSize: 12, fontWeight: 700, fontFamily: 'monospace', cursor: k1Busy === no ? 'wait' : 'pointer',
            }}>{k1Busy === no ? 'Compiling…' : `📄 Investor #${no}`}</button>
          ))}
          <span style={{ color: '#666', fontSize: 10 }}>one-click tax-preparer data package, per investor</span>
        </div>
      )}

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
