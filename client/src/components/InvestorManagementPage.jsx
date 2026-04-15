import { useState, useEffect, useCallback } from 'react';
import { fetchInvestors, createInvestor, updateInvestorApi, deleteInvestorApi, fetchInvestorAnalytics, fetchInvestorActivityLog } from '../services/api';

const TIER_COLORS = { Ready: '#28a745', Hot: '#dc3545', Warm: '#f9a825', Cold: '#666' };

function formatDate(d) {
  if (!d) return '-';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(d) {
  if (!d) return '-';
  return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function InvestorManagementPage() {
  const [tab, setTab] = useState('investors'); // 'investors' | 'analytics'
  const [investors, setInvestors] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [activityId, setActivityId] = useState(null);
  const [activityLog, setActivityLog] = useState([]);
  const [activityLoading, setActivityLoading] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      if (tab === 'investors') {
        const data = await fetchInvestors();
        setInvestors(data);
      } else {
        const data = await fetchInvestorAnalytics();
        setAnalytics(data);
      }
    } catch (err) {
      console.error('Failed to load investor data:', err);
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => { loadData(); }, [loadData]);

  async function handleToggleStatus(id, currentStatus) {
    const newStatus = currentStatus === 'active' ? 'disabled' : 'active';
    try {
      await updateInvestorApi(id, { status: newStatus });
      loadData();
    } catch (err) {
      alert('Failed to update status: ' + err.message);
    }
  }

  async function handleDelete(id, name) {
    if (!confirm(`Delete investor "${name}"? This cannot be undone.`)) return;
    try {
      await deleteInvestorApi(id);
      loadData();
    } catch (err) {
      alert('Failed to delete: ' + err.message);
    }
  }

  async function loadActivity(id) {
    setActivityId(id);
    setActivityLoading(true);
    try {
      const log = await fetchInvestorActivityLog(id);
      setActivityLog(log);
    } catch {
      setActivityLog([]);
    } finally {
      setActivityLoading(false);
    }
  }

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1100 }}>
      <h1 style={{ fontSize: 20, fontWeight: 800, color: '#fff', margin: '0 0 4px', letterSpacing: '0.04em' }}>
        <span style={{ color: '#FCF000' }}>PNTHR</span> Investor Portal Management
      </h1>
      <p style={{ fontSize: 12, color: '#666', margin: '0 0 20px' }}>
        Manage investor accounts, track engagement, and view analytics
      </p>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 20 }}>
        {['investors', 'analytics'].map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '8px 20px', fontSize: 12, fontWeight: 700, letterSpacing: '0.05em',
              background: tab === t ? '#1a1a1a' : 'transparent',
              color: tab === t ? '#FCF000' : '#666',
              border: tab === t ? '1px solid #333' : '1px solid transparent',
              borderRadius: 4, cursor: 'pointer',
            }}
          >
            {t.toUpperCase()}
          </button>
        ))}
        <button
          onClick={() => setShowCreate(true)}
          style={{
            marginLeft: 'auto', padding: '8px 16px', fontSize: 12, fontWeight: 700,
            background: '#FCF000', color: '#000', border: 'none', borderRadius: 4, cursor: 'pointer',
          }}
        >
          + NEW INVESTOR
        </button>
      </div>

      {loading && <div style={{ color: '#666', fontSize: 13 }}>Loading...</div>}

      {/* ── Investors Tab ── */}
      {!loading && tab === 'investors' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {investors.length === 0 && (
            <div style={{ color: '#666', fontSize: 13, padding: 20, textAlign: 'center' }}>
              No investors yet. Click "+ NEW INVESTOR" to create one.
            </div>
          )}
          {investors.map(inv => (
            <div key={inv._id} style={{
              background: '#141414', border: '1px solid #222', borderRadius: 8,
              padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 16,
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>{inv.name}</div>
                <div style={{ fontSize: 11, color: '#888' }}>{inv.email} {inv.company ? `- ${inv.company}` : ''}</div>
              </div>
              <div style={{ fontSize: 11, color: '#666', minWidth: 100, textAlign: 'center' }}>
                Created {formatDate(inv.createdAt)}
              </div>
              <div style={{ fontSize: 11, color: '#666', minWidth: 100, textAlign: 'center' }}>
                Last login: {formatDate(inv.lastLoginAt)}
              </div>
              <span style={{
                fontSize: 10, fontWeight: 700, padding: '3px 10px', borderRadius: 4,
                background: inv.status === 'active' ? 'rgba(40,167,69,0.15)' : 'rgba(220,53,69,0.15)',
                color: inv.status === 'active' ? '#28a745' : '#dc3545',
                letterSpacing: '0.05em',
              }}>
                {inv.status?.toUpperCase()}
              </span>
              <button
                onClick={() => loadActivity(inv._id)}
                style={{ background: 'none', border: '1px solid #333', color: '#888', borderRadius: 4, padding: '4px 10px', fontSize: 10, cursor: 'pointer' }}
              >
                ACTIVITY
              </button>
              <button
                onClick={() => handleToggleStatus(inv._id, inv.status)}
                style={{ background: 'none', border: '1px solid #333', color: '#888', borderRadius: 4, padding: '4px 10px', fontSize: 10, cursor: 'pointer' }}
              >
                {inv.status === 'active' ? 'DISABLE' : 'ENABLE'}
              </button>
              <button
                onClick={() => handleDelete(inv._id, inv.name)}
                style={{ background: 'none', border: '1px solid #dc3545', color: '#dc3545', borderRadius: 4, padding: '4px 10px', fontSize: 10, cursor: 'pointer' }}
              >
                DELETE
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Analytics Tab ── */}
      {!loading && tab === 'analytics' && analytics && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Engagement table */}
          <div>
            <h3 style={{ fontSize: 13, fontWeight: 700, color: '#FCF000', margin: '0 0 10px', letterSpacing: '0.05em' }}>
              INVESTOR ENGAGEMENT
            </h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #333' }}>
                  {['Name', 'Company', 'Sessions', 'Pages', 'Docs', 'Score', 'Tier', 'Last Active'].map(h => (
                    <th key={h} style={{ padding: '8px 10px', color: '#666', fontWeight: 600, textAlign: 'left', fontSize: 10, letterSpacing: '0.05em' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {analytics.investors.map(inv => (
                  <tr key={inv._id} style={{ borderBottom: '1px solid #1a1a1a' }}>
                    <td style={{ padding: '8px 10px', color: '#fff', fontWeight: 600 }}>{inv.name}</td>
                    <td style={{ padding: '8px 10px', color: '#888' }}>{inv.company || '-'}</td>
                    <td style={{ padding: '8px 10px', color: '#aaa', textAlign: 'center' }}>{inv.sessions || 0}</td>
                    <td style={{ padding: '8px 10px', color: '#aaa', textAlign: 'center' }}>{inv.pageViews || 0}</td>
                    <td style={{ padding: '8px 10px', color: '#aaa', textAlign: 'center' }}>{inv.docViews || 0}</td>
                    <td style={{ padding: '8px 10px', color: '#FCF000', fontWeight: 700, textAlign: 'center' }}>{inv.engagementScore}</td>
                    <td style={{ padding: '8px 10px' }}>
                      <span style={{ color: TIER_COLORS[inv.engagementTier] || '#666', fontWeight: 700, fontSize: 11 }}>
                        {inv.engagementTier}
                      </span>
                    </td>
                    <td style={{ padding: '8px 10px', color: '#666', fontSize: 11 }}>{formatDateTime(inv.lastActivity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Top Documents */}
          {analytics.topDocs?.length > 0 && (
            <div>
              <h3 style={{ fontSize: 13, fontWeight: 700, color: '#FCF000', margin: '0 0 10px', letterSpacing: '0.05em' }}>
                TOP VIEWED DOCUMENTS
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {analytics.topDocs.map((d, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 10px', background: '#141414', borderRadius: 4 }}>
                    <span style={{ color: '#666', fontSize: 11, minWidth: 20 }}>#{i + 1}</span>
                    <span style={{ color: '#fff', fontSize: 12, flex: 1 }}>{d._id}</span>
                    <span style={{ color: '#FCF000', fontWeight: 700, fontSize: 12 }}>{d.views} views</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Top Pages */}
          {analytics.topPages?.length > 0 && (
            <div>
              <h3 style={{ fontSize: 13, fontWeight: 700, color: '#FCF000', margin: '0 0 10px', letterSpacing: '0.05em' }}>
                TOP VIEWED PAGES
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {analytics.topPages.map((p, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 10px', background: '#141414', borderRadius: 4 }}>
                    <span style={{ color: '#666', fontSize: 11, minWidth: 20 }}>#{i + 1}</span>
                    <span style={{ color: '#fff', fontSize: 12, flex: 1 }}>{p._id}</span>
                    <span style={{ color: '#FCF000', fontWeight: 700, fontSize: 12 }}>{p.views} views</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Activity Log Modal ── */}
      {activityId && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => setActivityId(null)}>
          <div style={{
            background: '#1a1a1a', border: '1px solid #333', borderRadius: 12,
            padding: 24, width: '100%', maxWidth: 600, maxHeight: '70vh', overflow: 'auto',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: '#fff', margin: 0 }}>Activity Log</h3>
              <button onClick={() => setActivityId(null)} style={{ background: 'none', border: 'none', color: '#666', fontSize: 18, cursor: 'pointer' }}>x</button>
            </div>
            {activityLoading && <div style={{ color: '#666', fontSize: 12 }}>Loading...</div>}
            {!activityLoading && activityLog.length === 0 && <div style={{ color: '#666', fontSize: 12 }}>No activity recorded yet.</div>}
            {!activityLoading && activityLog.map((ev, i) => (
              <div key={i} style={{ display: 'flex', gap: 12, padding: '6px 0', borderBottom: '1px solid #222', fontSize: 11 }}>
                <span style={{ color: '#666', minWidth: 130 }}>{formatDateTime(ev.timestamp)}</span>
                <span style={{
                  fontWeight: 700, minWidth: 100,
                  color: ev.type === 'session_start' ? '#28a745' : ev.type === 'document_view' ? '#FCF000' : '#aaa',
                }}>
                  {ev.type}
                </span>
                <span style={{ color: '#888', flex: 1 }}>
                  {ev.page && `Page: ${ev.page}`}
                  {ev.documentName && `Doc: ${ev.documentName}`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Create Investor Modal ── */}
      {showCreate && <CreateInvestorModal onClose={() => setShowCreate(false)} onCreated={loadData} />}
    </div>
  );
}

function CreateInvestorModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!name || !email || !password) return;
    setSaving(true);
    setError(null);
    try {
      await createInvestor({ name, email, company, password });
      onCreated();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div style={{
        background: '#1a1a1a', border: '1px solid #333', borderRadius: 12,
        padding: 28, width: '100%', maxWidth: 420,
      }} onClick={e => e.stopPropagation()}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: '#fff', margin: '0 0 20px' }}>
          Create Investor Account
        </h3>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, fontWeight: 600, color: '#888' }}>
            NAME
            <input type="text" value={name} onChange={e => setName(e.target.value)} required autoFocus
              style={{ padding: '9px 12px', background: '#0a0a0a', border: '1px solid #333', borderRadius: 6, fontSize: 13, color: '#fff', outline: 'none' }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, fontWeight: 600, color: '#888' }}>
            EMAIL
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required
              style={{ padding: '9px 12px', background: '#0a0a0a', border: '1px solid #333', borderRadius: 6, fontSize: 13, color: '#fff', outline: 'none' }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, fontWeight: 600, color: '#888' }}>
            COMPANY
            <input type="text" value={company} onChange={e => setCompany(e.target.value)}
              style={{ padding: '9px 12px', background: '#0a0a0a', border: '1px solid #333', borderRadius: 6, fontSize: 13, color: '#fff', outline: 'none' }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, fontWeight: 600, color: '#888' }}>
            PASSWORD
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8}
              style={{ padding: '9px 12px', background: '#0a0a0a', border: '1px solid #333', borderRadius: 6, fontSize: 13, color: '#fff', outline: 'none' }} />
          </label>
          {error && <p style={{ fontSize: 12, color: '#dc3545', margin: 0, padding: '6px 10px', background: 'rgba(220,53,69,0.1)', borderRadius: 4 }}>{error}</p>}
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button type="submit" disabled={saving} style={{
              flex: 1, padding: '10px', background: '#FCF000', color: '#000', fontWeight: 700,
              fontSize: 13, border: 'none', borderRadius: 6, cursor: saving ? 'default' : 'pointer',
              opacity: saving ? 0.6 : 1,
            }}>
              {saving ? 'Creating...' : 'Create Investor'}
            </button>
            <button type="button" onClick={onClose} style={{
              padding: '10px 16px', background: 'none', border: '1px solid #333', color: '#888',
              fontSize: 13, borderRadius: 6, cursor: 'pointer',
            }}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
