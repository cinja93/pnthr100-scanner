import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../AuthContext';
import { usePortal } from '../contexts/PortalContext';
import { authHeaders, API_BASE } from '../services/api';

const DEFAULT_SECTION          = 'PNTHR Funds, Carnivore Quant LP Fund Documents';
const VIP_HIDDEN_DOC_LABELS    = new Set(['PNTHR Strategy Change Notice']);

export default function DataRoomPage() {
  const { isAdmin: rawIsAdmin } = useAuth();
  const { isVipPortal, isInvestorPortal } = usePortal();
  // In VIP / investor portals, suppress admin UI (upload / download / delete /
  // reorder / view log) so admins previewing under those subdomains see
  // exactly what family / investors see.
  const isAdmin = rawIsAdmin && !isVipPortal && !isInvestorPortal;
  const [docs, setDocs] = useState([]);
  const [sections, setSections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [file, setFile] = useState(null);
  const [label, setLabel] = useState('');
  const [selectedSection, setSelectedSection] = useState(DEFAULT_SECTION);
  const [newSectionName, setNewSectionName] = useState('');
  const [showNewSection, setShowNewSection] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [collapsedSections, setCollapsedSections] = useState({});
  const [downloading, setDownloading] = useState(null); // track which zip is downloading
  const [showViewLog, setShowViewLog] = useState(false);
  const [viewLog, setViewLog] = useState([]);
  const [viewLogLoading, setViewLogLoading] = useState(false);

  const loadDocs = useCallback(() => {
    setLoading(true);
    fetch(`${API_BASE}/api/dataroom`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => setDocs(Array.isArray(d) ? d : []))
      .catch(() => setDocs([]))
      .finally(() => setLoading(false));
  }, []);

  const loadSections = useCallback(() => {
    fetch(`${API_BASE}/api/dataroom/sections`, { headers: authHeaders() })
      .then(r => r.json())
      .then(s => setSections(Array.isArray(s) ? s : [DEFAULT_SECTION]))
      .catch(() => setSections([DEFAULT_SECTION]));
  }, []);

  useEffect(() => { loadDocs(); loadSections(); }, [loadDocs, loadSections]);

  // Group docs by section. VIP portal hides specific docs (e.g. the
  // Strategy Change Notice) so family doesn't see internal-strategy changes.
  const grouped = {};
  docs.forEach(doc => {
    if (isVipPortal && VIP_HIDDEN_DOC_LABELS.has(doc.label?.trim())) return;
    const sec = doc.section || DEFAULT_SECTION;
    if (!grouped[sec]) grouped[sec] = [];
    grouped[sec].push(doc);
  });
  // Sort docs within each section by sortOrder (then uploadedAt as fallback)
  Object.values(grouped).forEach(arr => {
    arr.sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999));
  });
  // Also include empty sections from the sections list
  sections.forEach(sec => {
    if (!grouped[sec]) grouped[sec] = [];
  });
  const sectionNames = Object.keys(grouped).sort();

  const toggleSection = (sec) => {
    setCollapsedSections(prev => ({ ...prev, [sec]: !prev[sec] }));
  };

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    try {
      let section = selectedSection;
      if (showNewSection && newSectionName.trim()) {
        // Create the section first
        const secRes = await fetch(`${API_BASE}/api/dataroom/sections`, {
          method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newSectionName.trim() })
        });
        if (!secRes.ok) throw new Error('Failed to create section');
        section = newSectionName.trim();
      }
      const form = new FormData();
      form.append('document', file);
      if (label.trim()) form.append('label', label.trim());
      form.append('section', section);
      const hdrs = authHeaders();
      delete hdrs['Content-Type'];
      const res = await fetch(`${API_BASE}/api/dataroom/upload`, { method: 'POST', headers: hdrs, body: form });
      if (!res.ok) throw new Error('Upload failed');
      setShowUpload(false);
      setFile(null);
      setLabel('');
      setSelectedSection(DEFAULT_SECTION);
      setNewSectionName('');
      setShowNewSection(false);
      loadDocs();
      loadSections();
    } catch (err) {
      alert(err.message);
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      const res = await fetch(`${API_BASE}/api/dataroom/${deleteTarget._id}`, { method: 'DELETE', headers: authHeaders() });
      if (!res.ok) throw new Error('Delete failed');
      setDeleteTarget(null);
      loadDocs();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleView = (doc) => {
    // Open document inline in a new browser tab (all users)
    window.open(`${API_BASE}/api/dataroom/${doc._id}/view?token=${encodeURIComponent(localStorage.getItem('pnthr_token') || '')}`, '_blank');
  };

  const handleDownload = async (doc) => {
    if (!isAdmin) return;
    try {
      const res = await fetch(`${API_BASE}/api/dataroom/${doc._id}/download`, { headers: authHeaders() });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = doc.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDownloadZip = async (section) => {
    if (!isAdmin) return;
    setDownloading(section || '__all__');
    try {
      const url = section
        ? `${API_BASE}/api/dataroom/download-all?section=${encodeURIComponent(section)}`
        : `${API_BASE}/api/dataroom/download-all`;
      const res = await fetch(url, { headers: authHeaders() });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = section
        ? `PNTHR_DataRoom_${section.replace(/[^a-zA-Z0-9]/g, '_')}.zip`
        : 'PNTHR_DataRoom_All_Documents.zip';
      a.click();
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      alert(err.message);
    } finally {
      setDownloading(null);
    }
  };

  const formatSize = (bytes) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // ── Drag-and-drop reorder state (admin only) ──
  const dragRef = useRef({ section: null, fromIdx: null });
  const [dragOverIdx, setDragOverIdx] = useState(null);
  const [dragOverSec, setDragOverSec] = useState(null);

  function handleDragStart(sec, idx) {
    dragRef.current = { section: sec, fromIdx: idx };
  }

  function handleDragOver(e, sec, idx) {
    e.preventDefault();
    setDragOverIdx(idx);
    setDragOverSec(sec);
  }

  function handleDragEnd() {
    setDragOverIdx(null);
    setDragOverSec(null);
  }

  async function handleDrop(sec, toIdx) {
    const { section: fromSec, fromIdx } = dragRef.current;
    setDragOverIdx(null);
    setDragOverSec(null);
    if (fromSec !== sec || fromIdx === null || fromIdx === toIdx) return;
    const secDocs = [...(grouped[sec] || [])];
    const [moved] = secDocs.splice(fromIdx, 1);
    secDocs.splice(toIdx, 0, moved);
    // Optimistic update
    const updated = docs.map(d => {
      if ((d.section || DEFAULT_SECTION) !== sec) return d;
      const idx = secDocs.findIndex(sd => sd._id === d._id);
      return idx >= 0 ? { ...d, sortOrder: idx } : d;
    });
    setDocs(updated);
    // Persist
    const order = secDocs.map((d, i) => ({ id: d._id, sortOrder: i }));
    try {
      await fetch(`${API_BASE}/api/dataroom/reorder`, {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ order }),
      });
    } catch { /* silent — optimistic update already applied */ }
  }

  const totalDocs = docs.length;

  return (
    <div style={{ padding: 30, background: '#0a0a0a', minHeight: '100vh', color: '#fff' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h1 style={{ color: '#fcf000', margin: 0 }}>PNTHR Data Room</h1>
        <div style={{ display: 'flex', gap: 10 }}>
          {isAdmin && (
            <>
              <button
                onClick={() => {
                  setShowViewLog(v => !v);
                  if (!showViewLog && viewLog.length === 0) {
                    setViewLogLoading(true);
                    fetch(`${API_BASE}/api/dataroom/view-log`, { headers: authHeaders() })
                      .then(r => r.json())
                      .then(d => setViewLog(Array.isArray(d) ? d : []))
                      .catch(() => setViewLog([]))
                      .finally(() => setViewLogLoading(false));
                  }
                }}
                style={{
                  background: showViewLog ? '#1a1a1a' : '#222',
                  color: showViewLog ? '#fcf000' : '#888', border: '1px solid #444', borderRadius: 6,
                  padding: '10px 16px', fontWeight: 600, cursor: 'pointer', fontSize: 13
                }}
              >
                {showViewLog ? 'Hide View Log' : 'Investor View Log'}
              </button>
              <button
                onClick={() => handleDownloadZip(null)}
                disabled={downloading || totalDocs === 0}
                style={{
                  background: downloading === '__all__' ? '#555' : '#222',
                  color: '#fcf000', border: '1px solid #444', borderRadius: 6,
                  padding: '10px 16px', fontWeight: 600, cursor: totalDocs > 0 && !downloading ? 'pointer' : 'not-allowed', fontSize: 13
                }}
              >
                {downloading === '__all__' ? 'Zipping...' : `Download All (${totalDocs})`}
              </button>
              <button
                onClick={() => setShowUpload(true)}
                style={{ background: '#D4A017', color: '#000', border: 'none', borderRadius: 6, padding: '10px 18px', fontWeight: 700, cursor: 'pointer' }}
              >
                + Upload Document
              </button>
            </>
          )}
        </div>
      </div>
      <p style={{ color: '#666', fontSize: 13, margin: '0 0 24px 0' }}>
        {isAdmin ? 'Manage fund documents by section. Upload, download, or delete.' : 'View fund documents. Contact an administrator to request copies or signatures.'}
      </p>

      {/* ── Investor View Log Panel ── */}
      {showViewLog && isAdmin && (
        <div style={{ marginBottom: 20, border: '1px solid #222', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ padding: '12px 18px', background: '#141414', borderBottom: '1px solid #222' }}>
            <span style={{ color: '#fcf000', fontWeight: 700, fontSize: 13, letterSpacing: '0.05em' }}>INVESTOR DOCUMENT VIEW LOG</span>
            <span style={{ color: '#555', fontSize: 11, marginLeft: 8 }}>({viewLog.length} entries)</span>
          </div>
          {viewLogLoading && <div style={{ padding: '16px 18px', color: '#666', fontSize: 12 }}>Loading...</div>}
          {!viewLogLoading && viewLog.length === 0 && (
            <div style={{ padding: '16px 18px', color: '#555', fontSize: 12, fontStyle: 'italic' }}>No document views recorded yet.</div>
          )}
          {!viewLogLoading && viewLog.length > 0 && (
            <div style={{ background: '#0d0d0d', maxHeight: 340, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #222' }}>
                    {['Investor', 'Email', 'Document', 'Section', 'Viewed At'].map(h => (
                      <th key={h} style={{ padding: '8px 12px', color: '#555', fontWeight: 600, textAlign: 'left', fontSize: 10, letterSpacing: '0.05em', position: 'sticky', top: 0, background: '#0d0d0d' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {viewLog.map((log, i) => (
                    <tr key={log._id || i} style={{ borderBottom: '1px solid #1a1a1a' }}>
                      <td style={{ padding: '7px 12px', color: '#fff', fontWeight: 600 }}>{log.investorName || '-'}</td>
                      <td style={{ padding: '7px 12px', color: '#888' }}>{log.investorEmail || '-'}</td>
                      <td style={{ padding: '7px 12px', color: '#ccc' }}>{log.documentName || '-'}</td>
                      <td style={{ padding: '7px 12px', color: '#666', fontSize: 11 }}>{log.section || '-'}</td>
                      <td style={{ padding: '7px 12px', color: '#666', fontSize: 11, whiteSpace: 'nowrap' }}>
                        {log.viewedAt ? new Date(log.viewedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {loading && <p style={{ color: '#888' }}>Loading...</p>}

      {!loading && sectionNames.length === 0 && <p style={{ color: '#888' }}>No documents available.</p>}

      {/* Sections */}
      {!loading && sectionNames.map(sec => {
        const secDocs = grouped[sec] || [];
        const isCollapsed = collapsedSections[sec];
        return (
          <div key={sec} style={{ marginBottom: 20, border: '1px solid #222', borderRadius: 8, overflow: 'hidden' }}>
            {/* Section Header */}
            <div
              onClick={() => toggleSection(sec)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '14px 18px', background: '#141414', cursor: 'pointer', userSelect: 'none',
                borderBottom: isCollapsed ? 'none' : '1px solid #222'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ color: '#fcf000', fontSize: 14, fontWeight: 700, transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0)', transition: 'transform 0.2s' }}>
                  ▼
                </span>
                <span style={{ color: '#fcf000', fontWeight: 700, fontSize: 15 }}>{sec}</span>
                <span style={{ color: '#666', fontSize: 12, marginLeft: 4 }}>({secDocs.length} {secDocs.length === 1 ? 'document' : 'documents'})</span>
              </div>
              {isAdmin && secDocs.length > 0 && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleDownloadZip(sec); }}
                  disabled={downloading === sec}
                  style={{
                    background: downloading === sec ? '#555' : '#222',
                    color: '#fcf000', border: '1px solid #333', borderRadius: 4,
                    padding: '5px 12px', fontSize: 12, fontWeight: 600,
                    cursor: downloading ? 'not-allowed' : 'pointer'
                  }}
                >
                  {downloading === sec ? 'Zipping...' : 'Download Section'}
                </button>
              )}
            </div>

            {/* Documents in section */}
            {!isCollapsed && (
              <div style={{ background: '#0d0d0d' }}>
                {secDocs.length === 0 && (
                  <p style={{ color: '#555', padding: '16px 18px', margin: 0, fontSize: 13, fontStyle: 'italic' }}>No documents in this section yet.</p>
                )}
                {secDocs.map((doc, idx) => (
                  <div
                    key={doc._id}
                    draggable={isAdmin}
                    onDragStart={() => isAdmin && handleDragStart(sec, idx)}
                    onDragOver={e => isAdmin && handleDragOver(e, sec, idx)}
                    onDrop={() => isAdmin && handleDrop(sec, idx)}
                    onDragEnd={handleDragEnd}
                    style={{
                      display: 'flex', alignItems: 'center', padding: '11px 18px',
                      borderBottom: '1px solid #1a1a1a',
                      borderTop: (dragOverSec === sec && dragOverIdx === idx) ? '2px solid #fcf000' : '2px solid transparent',
                      transition: 'border-top 0.1s',
                    }}
                  >
                    {/* Drag handle — admin only */}
                    {isAdmin && (
                      <span style={{ color: '#444', marginRight: 10, cursor: 'grab', fontSize: 14, userSelect: 'none' }} title="Drag to reorder">
                        ⠿
                      </span>
                    )}
                    {/* Document icon */}
                    <span style={{ color: '#555', marginRight: 12, fontSize: 16 }}>
                      {doc.contentType?.includes('pdf') ? '📄' : doc.contentType?.includes('image') ? '🖼️' : '📎'}
                    </span>
                    {/* Label — clickable to view for all users */}
                    <span
                      onClick={() => handleView(doc)}
                      style={{ color: '#ddd', cursor: 'pointer', flex: 1, fontSize: 14 }}
                      onMouseEnter={e => e.target.style.color = '#fcf000'}
                      onMouseLeave={e => e.target.style.color = '#ddd'}
                    >
                      {doc.label || doc.filename}
                    </span>
                    <span style={{ color: '#555', fontSize: 12, marginRight: 16, whiteSpace: 'nowrap' }}>{formatSize(doc.size)}</span>
                    <span style={{ color: '#555', fontSize: 12, marginRight: 16, whiteSpace: 'nowrap' }}>{new Date(doc.uploadedAt).toLocaleDateString()}</span>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {/* View — all users */}
                      <button
                        onClick={() => handleView(doc)}
                        style={{ background: '#1a1a1a', color: '#4a9eff', border: '1px solid #333', borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontSize: 11 }}
                      >
                        View
                      </button>
                      {/* Download — admin only */}
                      {isAdmin && (
                        <button
                          onClick={() => handleDownload(doc)}
                          style={{ background: '#1a1a1a', color: '#fcf000', border: '1px solid #333', borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontSize: 11 }}
                        >
                          Download
                        </button>
                      )}
                      {/* Delete — admin only */}
                      {isAdmin && (
                        <button
                          onClick={() => setDeleteTarget(doc)}
                          style={{ background: '#1a1a1a', color: '#c00', border: '1px solid #333', borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontSize: 11 }}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Upload Modal */}
      {showUpload && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 10, padding: 30, width: 460, maxWidth: '90vw' }}>
            <h2 style={{ color: '#fcf000', marginTop: 0 }}>Upload Document</h2>

            {/* Section selector */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', color: '#aaa', marginBottom: 6, fontSize: 13 }}>Section</label>
              {!showNewSection ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <select
                    value={selectedSection}
                    onChange={e => setSelectedSection(e.target.value)}
                    style={{ flex: 1, padding: 10, background: '#111', border: '1px solid #444', borderRadius: 6, color: '#fff', fontSize: 14 }}
                  >
                    {sections.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <button
                    onClick={() => setShowNewSection(true)}
                    style={{ background: '#222', color: '#fcf000', border: '1px solid #444', borderRadius: 6, padding: '8px 14px', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' }}
                  >
                    + New Section
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    value={newSectionName}
                    onChange={e => setNewSectionName(e.target.value)}
                    placeholder="Enter new section name"
                    style={{ flex: 1, padding: 10, background: '#111', border: '1px solid #444', borderRadius: 6, color: '#fff', fontSize: 14, boxSizing: 'border-box' }}
                    autoFocus
                  />
                  <button
                    onClick={() => { setShowNewSection(false); setNewSectionName(''); }}
                    style={{ background: '#333', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 14px', cursor: 'pointer', fontSize: 12 }}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>

            {/* Label */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', color: '#aaa', marginBottom: 6, fontSize: 13 }}>Label (optional)</label>
              <input
                type="text"
                value={label}
                onChange={e => setLabel(e.target.value)}
                placeholder="e.g. PNTHR PPM v3"
                style={{ width: '100%', padding: 10, background: '#111', border: '1px solid #444', borderRadius: 6, color: '#fff', fontSize: 14, boxSizing: 'border-box' }}
              />
            </div>

            {/* File */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', color: '#aaa', marginBottom: 6, fontSize: 13 }}>File</label>
              <input
                type="file"
                onChange={e => { e.stopPropagation(); setFile(e.target.files[0] || null); }}
                onClick={e => e.stopPropagation()}
                style={{ color: '#ccc' }}
              />
              {file && <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>{file.name} ({(file.size / 1024).toFixed(0)} KB)</div>}
            </div>

            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => { setShowUpload(false); setFile(null); setLabel(''); setSelectedSection(DEFAULT_SECTION); setShowNewSection(false); setNewSectionName(''); }}
                style={{ background: '#333', color: '#fff', border: 'none', borderRadius: 6, padding: '10px 18px', cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={e => { e.preventDefault(); e.stopPropagation(); if (!uploading && file) handleUpload(); }}
                disabled={!file || uploading || (showNewSection && !newSectionName.trim())}
                style={{
                  background: file && !uploading ? '#D4A017' : '#555',
                  color: '#000', border: 'none', borderRadius: 6, padding: '10px 18px', fontWeight: 700,
                  cursor: file && !uploading ? 'pointer' : 'not-allowed'
                }}
              >
                {uploading ? 'Uploading...' : 'Upload'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 10, padding: 30, width: 380, maxWidth: '90vw' }}>
            <h3 style={{ color: '#ff4444', marginTop: 0 }}>Delete Document?</h3>
            <p style={{ color: '#ccc' }}>Are you sure you want to delete <strong>{deleteTarget.label || deleteTarget.filename}</strong>?</p>
            <p style={{ color: '#888', fontSize: 12 }}>Section: {deleteTarget.section || DEFAULT_SECTION}</p>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setDeleteTarget(null)}
                style={{ background: '#333', color: '#fff', border: 'none', borderRadius: 6, padding: '10px 18px', cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                style={{ background: '#c00', color: '#fff', border: 'none', borderRadius: 6, padding: '10px 18px', fontWeight: 700, cursor: 'pointer' }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
