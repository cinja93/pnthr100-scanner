import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../AuthContext';
import { authHeaders, API_BASE } from '../services/api';

export default function DataRoomPage() {
  const { isAdmin } = useAuth();
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [file, setFile] = useState(null);
  const [label, setLabel] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);

  const loadDocs = useCallback(() => {
    setLoading(true);
    fetch(`${API_BASE}/api/dataroom`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => setDocs(Array.isArray(d) ? d : []))
      .catch(() => setDocs([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadDocs(); }, [loadDocs]);

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('document', file);
      if (label.trim()) form.append('label', label.trim());
      const hdrs = authHeaders();
      delete hdrs['Content-Type']; // let browser set multipart boundary
      const res = await fetch(`${API_BASE}/api/dataroom/upload`, { method: 'POST', headers: hdrs, body: form });
      if (!res.ok) throw new Error('Upload failed');
      setShowUpload(false);
      setFile(null);
      setLabel('');
      loadDocs();
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

  const handleDownload = async (doc) => {
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

  const formatSize = (bytes) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div style={{ padding: 30, background: '#0a0a0a', minHeight: '100vh', color: '#fff' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ color: '#FFD700', margin: 0 }}>PNTHR Data Room</h1>
        {isAdmin && (
          <button
            onClick={() => setShowUpload(true)}
            style={{ background: '#D4A017', color: '#000', border: 'none', borderRadius: 6, padding: '10px 18px', fontWeight: 700, cursor: 'pointer' }}
          >
            + Upload Document
          </button>
        )}
      </div>

      {loading && <p style={{ color: '#888' }}>Loading...</p>}
      {!loading && docs.length === 0 && <p style={{ color: '#888' }}>No documents available.</p>}
      {!loading && docs.length > 0 && docs.map(doc => (
        <div key={doc._id} style={{ display: 'flex', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid #222' }}>
          <span
            onClick={() => handleDownload(doc)}
            style={{ color: '#FFD700', cursor: 'pointer', textDecoration: 'none', flex: 1 }}
          >
            {doc.label || doc.filename}
          </span>
          <span style={{ color: '#666', fontSize: 12, marginRight: 16 }}>{formatSize(doc.size)}</span>
          <span style={{ color: '#666', fontSize: 12, marginRight: 16 }}>{new Date(doc.uploadedAt).toLocaleDateString()}</span>
          {isAdmin && (
            <button
              onClick={() => setDeleteTarget(doc)}
              style={{ background: '#600', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 10px', cursor: 'pointer', fontSize: 12 }}
            >
              Delete
            </button>
          )}
        </div>
      ))}

      {/* Upload Modal */}
      {showUpload && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 10, padding: 30, width: 420, maxWidth: '90vw' }}>
            <h2 style={{ color: '#FFD700', marginTop: 0 }}>Upload Document</h2>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', color: '#aaa', marginBottom: 6, fontSize: 13 }}>Label (optional)</label>
              <input
                type="text"
                value={label}
                onChange={e => setLabel(e.target.value)}
                placeholder="e.g. PNTHR System Guide v2"
                style={{ width: '100%', padding: 10, background: '#111', border: '1px solid #444', borderRadius: 6, color: '#fff', fontSize: 14, boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', color: '#aaa', marginBottom: 6, fontSize: 13 }}>File</label>
              <input
                type="file"
                onChange={e => setFile(e.target.files[0] || null)}
                style={{ color: '#ccc' }}
              />
            </div>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button
                onClick={() => { setShowUpload(false); setFile(null); setLabel(''); }}
                style={{ background: '#333', color: '#fff', border: 'none', borderRadius: 6, padding: '10px 18px', cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={handleUpload}
                disabled={!file || uploading}
                style={{ background: file && !uploading ? '#D4A017' : '#555', color: '#000', border: 'none', borderRadius: 6, padding: '10px 18px', fontWeight: 700, cursor: file && !uploading ? 'pointer' : 'not-allowed' }}
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
