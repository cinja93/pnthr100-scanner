import { useState, useEffect, useCallback } from 'react';
import { fetchInvestors, createInvestor, updateInvestorApi, deleteInvestorApi, fetchInvestorAnalytics, fetchInvestorActivityLog, fetchInvestorNotes, addInvestorNote, editInvestorNote, deleteInvestorNote, resetInvestorLogins } from '../services/api';

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
  const [resetTarget, setResetTarget] = useState(null); // { id, name, type: 'email' | 'password' }

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
    <div style={{ padding: '24px 32px', maxWidth: 1100, minHeight: '100vh', background: '#0a0a0a' }}>
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
            <InvestorCard
              key={inv._id}
              inv={inv}
              onResetEmail={() => setResetTarget({ id: inv._id, name: inv.name, currentEmail: inv.email, type: 'email' })}
              onResetPassword={() => setResetTarget({ id: inv._id, name: inv.name, type: 'password' })}
              onResetAccess={async () => {
                try {
                  await resetInvestorLogins(inv._id);
                  loadData();
                } catch (err) { alert('Failed to reset access: ' + err.message); }
              }}
              onActivity={() => loadActivity(inv._id)}
              onToggleStatus={() => handleToggleStatus(inv._id, inv.status)}
              onDelete={() => handleDelete(inv._id, inv.name)}
            />
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

      {/* ── Reset Email / Password Modal ── */}
      {resetTarget && (
        <ResetModal
          target={resetTarget}
          onClose={() => setResetTarget(null)}
          onSaved={() => { setResetTarget(null); loadData(); }}
        />
      )}

      {/* ── Create Investor Modal ── */}
      {showCreate && <CreateInvestorModal onClose={() => setShowCreate(false)} onCreated={loadData} />}
    </div>
  );
}

function InvestorCard({ inv, onResetEmail, onResetPassword, onResetAccess, onActivity, onToggleStatus, onDelete }) {
  const [notesOpen, setNotesOpen] = useState(false);
  const [notes, setNotes] = useState([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [newNote, setNewNote] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');
  const [saving, setSaving] = useState(false);

  async function loadNotes() {
    setNotesLoading(true);
    try {
      const data = await fetchInvestorNotes(inv._id);
      setNotes(data);
    } catch { setNotes([]); }
    finally { setNotesLoading(false); }
  }

  function handleToggleNotes() {
    if (!notesOpen) loadNotes();
    setNotesOpen(v => !v);
  }

  async function handleAddNote() {
    if (!newNote.trim()) return;
    setSaving(true);
    try {
      const note = await addInvestorNote(inv._id, newNote.trim());
      setNotes(prev => [note, ...prev]);
      setNewNote('');
    } catch (err) { alert('Failed to add note: ' + err.message); }
    finally { setSaving(false); }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleAddNote();
    }
  }

  async function handleSaveEdit(noteId) {
    if (!editText.trim()) return;
    try {
      await editInvestorNote(noteId, editText.trim());
      setNotes(prev => prev.map(n => n._id === noteId ? { ...n, text: editText.trim(), updatedAt: new Date().toISOString() } : n));
      setEditingId(null);
      setEditText('');
    } catch (err) { alert('Failed to edit note: ' + err.message); }
  }

  async function handleDeleteNote(noteId) {
    if (!confirm('Delete this note?')) return;
    try {
      await deleteInvestorNote(noteId);
      setNotes(prev => prev.filter(n => n._id !== noteId));
    } catch (err) { alert('Failed to delete note: ' + err.message); }
  }

  return (
    <div style={{ background: '#141414', border: '1px solid #222', borderRadius: 8, overflow: 'hidden' }}>
      {/* ── Header row ── */}
      <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>{inv.name}</span>
            <button onClick={onResetEmail}
              style={{ background: 'none', border: '1px solid #333', color: '#888', borderRadius: 4, padding: '2px 8px', fontSize: 9, cursor: 'pointer', letterSpacing: '0.04em' }}>
              RESET EMAIL
            </button>
            <button onClick={onResetPassword}
              style={{ background: 'none', border: '1px solid #333', color: '#888', borderRadius: 4, padding: '2px 8px', fontSize: 9, cursor: 'pointer', letterSpacing: '0.04em' }}>
              RESET PASSWORD
            </button>
          </div>
          <div style={{ fontSize: 11, color: '#888' }}>{inv.email} {inv.company ? `- ${inv.company}` : ''}</div>
        </div>
        <div style={{ fontSize: 11, color: '#666', minWidth: 100, textAlign: 'center' }}>
          Created {formatDate(inv.createdAt)}
        </div>
        <div style={{ fontSize: 11, color: '#666', minWidth: 100, textAlign: 'center' }}>
          Last login: {formatDate(inv.lastLoginAt)}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 140, justifyContent: 'center' }}>
          <span style={{
            fontSize: 10, fontWeight: 700,
            color: (inv.loginCount || 0) >= (inv.maxLogins || 5) ? '#dc3545' : (inv.loginCount || 0) >= ((inv.maxLogins || 5) - 1) ? '#f9a825' : '#888',
          }}>
            {inv.loginCount || 0}/{inv.maxLogins || 5} sessions
          </span>
          {(inv.loginCount || 0) > 0 && (
            <button onClick={onResetAccess}
              style={{
                background: (inv.loginCount || 0) >= (inv.maxLogins || 5) ? 'rgba(252,240,0,0.15)' : 'none',
                border: '1px solid ' + ((inv.loginCount || 0) >= (inv.maxLogins || 5) ? '#FCF000' : '#333'),
                color: (inv.loginCount || 0) >= (inv.maxLogins || 5) ? '#FCF000' : '#888',
                borderRadius: 4, padding: '2px 8px', fontSize: 9, cursor: 'pointer', fontWeight: 700, letterSpacing: '0.04em',
              }}>
              {(inv.loginCount || 0) >= (inv.maxLogins || 5) ? 'RENEW ACCESS' : 'RESET'}
            </button>
          )}
        </div>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '3px 10px', borderRadius: 4,
          background: inv.status === 'active' ? 'rgba(40,167,69,0.15)' : 'rgba(220,53,69,0.15)',
          color: inv.status === 'active' ? '#28a745' : '#dc3545',
          letterSpacing: '0.05em',
        }}>
          {inv.status?.toUpperCase()}
        </span>
        <button onClick={handleToggleNotes}
          style={{ background: notesOpen ? '#1a1a1a' : 'none', border: '1px solid #333', color: notesOpen ? '#FCF000' : '#888', borderRadius: 4, padding: '4px 10px', fontSize: 10, cursor: 'pointer', fontWeight: notesOpen ? 700 : 400 }}>
          NOTES {notes.length > 0 ? `(${notes.length})` : ''}
        </button>
        <button onClick={onActivity}
          style={{ background: 'none', border: '1px solid #333', color: '#888', borderRadius: 4, padding: '4px 10px', fontSize: 10, cursor: 'pointer' }}>
          ACTIVITY
        </button>
        <button onClick={onToggleStatus}
          style={{ background: 'none', border: '1px solid #333', color: '#888', borderRadius: 4, padding: '4px 10px', fontSize: 10, cursor: 'pointer' }}>
          {inv.status === 'active' ? 'DISABLE' : 'ENABLE'}
        </button>
        <button onClick={onDelete}
          style={{ background: 'none', border: '1px solid #dc3545', color: '#dc3545', borderRadius: 4, padding: '4px 10px', fontSize: 10, cursor: 'pointer' }}>
          DELETE
        </button>
      </div>

      {/* ── Notes section ── */}
      {notesOpen && (
        <div style={{ borderTop: '1px solid #222', padding: '12px 18px', background: '#0f0f0f' }}>
          {/* Add note input */}
          <div style={{ display: 'flex', gap: 8, marginBottom: notes.length > 0 ? 12 : 0 }}>
            <textarea
              value={newNote}
              onChange={e => setNewNote(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a note and press Enter..."
              rows={2}
              style={{
                flex: 1, padding: '8px 12px', background: '#1a1a1a', border: '1px solid #333',
                borderRadius: 6, fontSize: 12, color: '#fff', outline: 'none', resize: 'vertical',
                fontFamily: 'inherit', lineHeight: 1.5,
              }}
            />
            <button
              onClick={handleAddNote}
              disabled={saving || !newNote.trim()}
              style={{
                padding: '8px 14px', background: '#FCF000', color: '#000', fontWeight: 700,
                fontSize: 11, border: 'none', borderRadius: 6, cursor: 'pointer',
                opacity: saving || !newNote.trim() ? 0.4 : 1, alignSelf: 'flex-end',
                whiteSpace: 'nowrap',
              }}
            >
              + ADD NOTE
            </button>
          </div>

          {notesLoading && <div style={{ color: '#666', fontSize: 11 }}>Loading notes...</div>}

          {/* Notes list */}
          {notes.map(note => (
            <div key={note._id} style={{
              padding: '8px 0', borderBottom: '1px solid #1a1a1a',
              display: 'flex', gap: 10, alignItems: 'flex-start',
            }}>
              <div style={{ minWidth: 120, flexShrink: 0 }}>
                <div style={{ fontSize: 10, color: '#555' }}>{formatDateTime(note.createdAt)}</div>
                {note.updatedAt && note.updatedAt !== note.createdAt && (
                  <div style={{ fontSize: 9, color: '#444', fontStyle: 'italic' }}>edited {formatDateTime(note.updatedAt)}</div>
                )}
              </div>
              <div style={{ flex: 1 }}>
                {editingId === note._id ? (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <textarea
                      value={editText}
                      onChange={e => setEditText(e.target.value)}
                      rows={2}
                      autoFocus
                      style={{
                        flex: 1, padding: '6px 10px', background: '#1a1a1a', border: '1px solid #444',
                        borderRadius: 4, fontSize: 12, color: '#fff', outline: 'none', resize: 'vertical',
                        fontFamily: 'inherit', lineHeight: 1.5,
                      }}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <button onClick={() => handleSaveEdit(note._id)}
                        style={{ background: '#FCF000', color: '#000', border: 'none', borderRadius: 4, padding: '4px 10px', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>
                        SAVE
                      </button>
                      <button onClick={() => { setEditingId(null); setEditText(''); }}
                        style={{ background: 'none', border: '1px solid #333', color: '#888', borderRadius: 4, padding: '4px 10px', fontSize: 10, cursor: 'pointer' }}>
                        CANCEL
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: '#ccc', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{note.text}</div>
                )}
              </div>
              {editingId !== note._id && (
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  <button onClick={() => { setEditingId(note._id); setEditText(note.text); }}
                    style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 10, padding: '2px 6px' }}>
                    EDIT
                  </button>
                  <button onClick={() => handleDeleteNote(note._id)}
                    style={{ background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: 10, padding: '2px 6px' }}>
                    DELETE
                  </button>
                </div>
              )}
            </div>
          ))}

          {!notesLoading && notes.length === 0 && (
            <div style={{ color: '#555', fontSize: 11, padding: '4px 0' }}>No notes yet.</div>
          )}
        </div>
      )}
    </div>
  );
}

function CreateInvestorModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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
            INVESTOR NAME
            <input type="text" value={name} onChange={e => setName(e.target.value)} required autoFocus placeholder="Investor's full name"
              style={{ padding: '9px 12px', background: '#0a0a0a', border: '1px solid #333', borderRadius: 6, fontSize: 13, color: '#fff', outline: 'none' }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, fontWeight: 600, color: '#888' }}>
            INVESTOR EMAIL
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="Investor's login email"
              style={{ padding: '9px 12px', background: '#0a0a0a', border: '1px solid #333', borderRadius: 6, fontSize: 13, color: '#fff', outline: 'none' }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, fontWeight: 600, color: '#888' }}>
            INVESTOR COMPANY
            <input type="text" value={company} onChange={e => setCompany(e.target.value)} placeholder="Investor's firm (optional)"
              style={{ padding: '9px 12px', background: '#0a0a0a', border: '1px solid #333', borderRadius: 6, fontSize: 13, color: '#fff', outline: 'none' }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, fontWeight: 600, color: '#888' }}>
            PNTHR PORTAL PASSWORD
            <div style={{ position: 'relative' }}>
              <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} required minLength={8} placeholder="Password you assign them"
                style={{ padding: '9px 12px', paddingRight: 40, background: '#0a0a0a', border: '1px solid #333', borderRadius: 6, fontSize: 13, color: '#fff', outline: 'none', width: '100%', boxSizing: 'border-box' }} />
              <button type="button" onClick={() => setShowPassword(v => !v)}
                style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 16, padding: '2px 4px' }}
                title={showPassword ? 'Hide password' : 'Show password'}>
                {showPassword ? '🙈' : '👁'}
              </button>
            </div>
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

function ResetModal({ target, onClose, onSaved }) {
  const [value, setValue] = useState(target.type === 'email' ? (target.currentEmail || '') : '');
  const [showPw, setShowPw] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const isEmail = target.type === 'email';
  const title = isEmail ? 'Reset Investor Email' : 'Reset Investor Password';
  const label = isEmail ? 'NEW EMAIL ADDRESS' : 'NEW PASSWORD';
  const placeholder = isEmail ? 'investor@company.com' : 'Enter new password (min 8 characters)';

  async function handleSave(e) {
    e.preventDefault();
    if (!value.trim()) return;
    if (!isEmail && value.length < 8) { setError('Password must be at least 8 characters'); return; }
    setSaving(true);
    setError(null);
    try {
      const updates = isEmail ? { email: value.trim() } : { password: value };
      await updateInvestorApi(target.id, updates);
      onSaved();
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
        <h3 style={{ fontSize: 16, fontWeight: 700, color: '#fff', margin: '0 0 4px' }}>{title}</h3>
        <p style={{ fontSize: 12, color: '#666', margin: '0 0 20px' }}>For: {target.name}</p>
        <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, fontWeight: 600, color: '#888' }}>
            {label}
            {isEmail ? (
              <input type="email" value={value} onChange={e => setValue(e.target.value)} required autoFocus placeholder={placeholder}
                style={{ padding: '9px 12px', background: '#0a0a0a', border: '1px solid #333', borderRadius: 6, fontSize: 13, color: '#fff', outline: 'none' }} />
            ) : (
              <div style={{ position: 'relative' }}>
                <input type={showPw ? 'text' : 'password'} value={value} onChange={e => setValue(e.target.value)} required autoFocus minLength={8} placeholder={placeholder}
                  style={{ padding: '9px 12px', paddingRight: 40, background: '#0a0a0a', border: '1px solid #333', borderRadius: 6, fontSize: 13, color: '#fff', outline: 'none', width: '100%', boxSizing: 'border-box' }} />
                <button type="button" onClick={() => setShowPw(v => !v)}
                  style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 16, padding: '2px 4px' }}
                  title={showPw ? 'Hide password' : 'Show password'}>
                  {showPw ? '🙈' : '👁'}
                </button>
              </div>
            )}
          </label>
          {error && <p style={{ fontSize: 12, color: '#dc3545', margin: 0, padding: '6px 10px', background: 'rgba(220,53,69,0.1)', borderRadius: 4 }}>{error}</p>}
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button type="submit" disabled={saving} style={{
              flex: 1, padding: '10px', background: '#FCF000', color: '#000', fontWeight: 700,
              fontSize: 13, border: 'none', borderRadius: 6, cursor: saving ? 'default' : 'pointer',
              opacity: saving ? 0.6 : 1,
            }}>
              {saving ? 'Saving...' : isEmail ? 'Update Email' : 'Update Password'}
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
