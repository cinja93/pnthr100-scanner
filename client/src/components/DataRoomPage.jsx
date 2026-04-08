import { useState, useEffect, useRef, useContext } from 'react';
import styles from './DataRoomPage.module.css';
import pnthrLogo from '../assets/panther head.png';
import { AuthContext } from '../contexts/AuthContext';

const API_BASE = import.meta.env.VITE_API_URL || '';

const COMING_SOON = [
  { title: 'Subscription Agreement', subtitle: 'Investor Subscription Form & Reps', icon: 'pen' },
  { title: 'Investment Management Agreement', subtitle: 'GP to STT Capital Advisors, LLC', icon: 'handshake' },
  { title: 'Operating Agreement - GP', subtitle: 'PNTHR Funds, LLC', icon: 'building' },
  { title: 'Operating Agreement - IM', subtitle: 'STT Capital Advisors, LLC', icon: 'building' },
  { title: 'Form D Filing', subtitle: 'SEC Regulation D - Rule 506(b)', icon: 'clipboard' },
  { title: 'Backtest Report', subtitle: 'Full Audit-Grade Backtest 2019-2026', icon: 'chart' },
  { title: 'Annual Audited Financials', subtitle: 'Independent CPA Audit', icon: 'search' },
  ];

const CATEGORY_COLORS = {
    'Fund Formation':     { bg: '#0f2010', text: '#4CAF50', border: '#1e4020' },
    'Offering Documents': { bg: '#0f0f20', text: '#5B8DEF', border: '#1e2050' },
    'Tax & Compliance':   { bg: '#200f0f', text: '#EF5B5B', border: '#501e1e' },
    'Investor Reports':   { bg: '#0f2020', text: '#4ECDC4', border: '#1e5050' },
    'Legal Agreements':   { bg: '#201a0f', text: '#D4A017', border: '#503a1e' },
    'Regulatory Filings': { bg: '#1a0f20', text: '#B57BEF', border: '#3a1e50' },
    'Other':              { bg: '#111',    text: '#888',    border: '#222'    },
};

function UploadModal({ onClose, onSuccess, token }) {
    const [title, setTitle] = useState('');
    const [category, setCategory] = useState('');
    const [description, setDescription] = useState('');
    const [version, setVersion] = useState('v1.0');
    const [file, setFile] = useState(null);
    const [uploading, setUploading] = useState(false);
    const [progress, setProgress] = useState(0);
    const [error, setError] = useState('');
    const [dragOver, setDragOver] = useState(false);
    const fileRef = useRef();

  const CATS = ['Fund Formation','Offering Documents','Tax & Compliance','Investor Reports','Legal Agreements','Regulatory Filings','Other'];
    const ALLOWED = ['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','image/png','image/jpeg'];

  const handleFile = (f) => {
        if (!f) return;
        if (!ALLOWED.includes(f.type)) { setError('Unsupported file type. Use PDF, DOCX, XLSX, PNG, or JPG.'); return; }
        if (f.size > 25 * 1024 * 1024) { setError('File exceeds 25 MB limit.'); return; }
        setError(''); setFile(f);
        if (!title) setTitle(f.name.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' '));
  };

  const handleUpload = () => {
        if (!file || !title.trim() || !category) return;
        setUploading(true); setError('');
        const fd = new FormData();
        fd.append('file', file);
        fd.append('title', title.trim());
        fd.append('category', category);
        fd.append('description', description.trim());
        fd.append('version', version.trim() || 'v1.0');
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) setProgress(Math.round(e.loaded / e.total * 100)); };
        xhr.onload = () => {
                try {
                          const res = JSON.parse(xhr.responseText);
                          if (res.success) { onSuccess(res.document); }
                          else { setError(res.error || 'Upload failed.'); setUploading(false); }
                } catch { setError('Unexpected server response.'); setUploading(false); }
        };
        xhr.onerror = () => { setError('Network error. Try again.'); setUploading(false); };
        xhr.open('POST', API_BASE + '/api/dataroom/upload');
        if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
        xhr.send(fd);
  };

  const inp = { width: '100%', background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 4, padding: '8px 10px', color: '#fff', fontSize: 13, boxSizing: 'border-box', outline: 'none' };
    const canUpload = file && title.trim() && category && !uploading;

  return (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
                <div style={{ background: '#0d0d0d', border: '1px solid #D4A017', borderRadius: 8, padding: 28, width: 520, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                                      <span style={{ color: '#FFD700', fontWeight: 700, fontSize: 15 }}>Upload Document</span>span>
                                      <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#666', fontSize: 22, cursor: 'pointer' }}>x</button>button>
                          </div>div>
                          <div onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }} onClick={() => fileRef.current.click()} style={{ border: '2px dashed ' + (dragOver ? '#FFD700' : '#D4A017'), borderRadius: 6, padding: '22px 12px', textAlign: 'center', cursor: 'pointer', marginBottom: 16, background: dragOver ? '#1c1400' : 'transparent' }}>
                                      <input ref={fileRef} type="file" hidden accept=".pdf,.docx,.xlsx,.png,.jpg,.jpeg" onChange={(e) => handleFile(e.target.files[0])} />
                            {file ? (
                      <div>
                                    <div style={{ fontSize: 26, marginBottom: 6 }}>PDF</div>div>
                                    <div style={{ color: '#FFD700', fontSize: 13, fontWeight: 600 }}>{file.name}</div>div>
                                    <div style={{ color: '#555', fontSize: 11, marginTop: 3 }}>{(file.size / 1024 / 1024).toFixed(2)} MB</div>div>
                      </div>div>
                    ) : (
                      <div>
                                    <div style={{ color: '#888', fontSize: 13 }}>Drag and drop or <span style={{ color: '#D4A017', textDecoration: 'underline' }}>browse</span>span></div>div>
                                    <div style={{ color: '#444', fontSize: 11, marginTop: 5 }}>PDF, DOCX, XLSX, PNG, JPG - Max 25 MB</div>div>
                      </div>div>
                                    )}
                          </div>div>
                        <div style={{ marginBottom: 12 }}>
                                  <label style={{ color: '#666', fontSize: 11, display: 'block', marginBottom: 4 }}>Document Title *</label>label>
                                  <input value={title} onChange={(e) => setTitle(e.target.value)} style={inp} placeholder="e.g. Amended LPA v2.0" />
                        </div>div>
                        <div style={{ marginBottom: 12 }}>
                                  <label style={{ color: '#666', fontSize: 11, display: 'block', marginBottom: 4 }}>Category *</label>label>
                                  <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ ...inp, color: category ? '#fff' : '#555' }}>
                                              <option value="">Select category...</option>option>
                                    {CATS.map((c) => <option key={c} value={c}>{c}</option>option>)}
                                  </select>select>
                        </div>div>
                        <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
                                  <div style={{ width: 110 }}>
                                              <label style={{ color: '#666', fontSize: 11, display: 'block', marginBottom: 4 }}>Version</label>label>
                                              <input value={version} onChange={(e) => setVersion(e.target.value)} style={inp} placeholder="v1.0" />
                                  </div>div>
                                  <div style={{ flex: 1 }}>
                                              <label style={{ color: '#666', fontSize: 11, display: 'block', marginBottom: 4 }}>Description (optional)</label>label>
                                              <input value={description} onChange={(e) => setDescription(e.target.value)} style={inp} placeholder="Brief description..." maxLength={300} />
                                  </div>div>
                        </div>div>
                  {uploading && (
                    <div style={{ marginBottom: 14 }}>
                                <div style={{ background: '#1a1a1a', borderRadius: 4, height: 5, overflow: 'hidden' }}>
                                              <div style={{ height: '100%', background: '#D4A017', width: progress + '%', transition: 'width 0.2s' }} />
                                </div>div>
                                <div style={{ color: '#666', fontSize: 11, textAlign: 'center', marginTop: 4 }}>Uploading... {progress}%</div>div>
                    </div>div>
                        )}
                  {error && <div style={{ color: '#cc4444', fontSize: 12, marginBottom: 12 }}>{error}</div>div>}
                        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                                  <button onClick={onClose} disabled={uploading} style={{ background: 'transparent', border: '1px solid #333', borderRadius: 4, padding: '8px 18px', color: '#666', cursor: 'pointer', fontSize: 13 }}>Cancel</button>button>
                                  <button onClick={handleUpload} disabled={!canUpload} style={{ background: canUpload ? '#D4A017' : '#1c1400', border: 'none', borderRadius: 4, padding: '8px 22px', color: canUpload ? '#000' : '#444', fontWeight: 700, cursor: canUpload ? 'pointer' : 'not-allowed', fontSize: 13 }}>
                                    {uploading ? 'Uploading...' : 'Upload'}
                                  </button>button>
                        </div>div>
                </div>div>
        </div>div>
      );
}

function DeleteModal({ doc, onConfirm, onClose }) {
    return (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1001 }}>
                <div style={{ background: '#0d0d0d', border: '1px solid #cc4444', borderRadius: 8, padding: 28, width: 400, maxWidth: '90%' }}>
                        <div style={{ color: '#EF5B5B', fontWeight: 700, fontSize: 15, marginBottom: 12 }}>Delete Document</div>div>
                        <div style={{ color: '#999', fontSize: 13, marginBottom: 20 }}>Are you sure you want to delete <strong style={{ color: '#fff' }}>{doc.title}</strong>strong>? This cannot be undone.</div>div>
                        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                                  <button onClick={onClose} style={{ background: 'transparent', border: '1px solid #333', borderRadius: 4, padding: '8px 18px', color: '#666', cursor: 'pointer', fontSize: 13 }}>Cancel</button>button>
                                  <button onClick={onConfirm} style={{ background: '#cc4444', border: 'none', borderRadius: 4, padding: '8px 18px', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>Delete</button>button>
                        </div>div>
                </div>div>
          </div>div>
        );
}

export default function DataRoomPage() {
    const { user, token } = useContext(AuthContext);
    const [docs, setDocs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showUpload, setShowUpload] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState(null);
    const [filterCat, setFilterCat] = useState('All');
    const [search, setSearch] = useState('');
  
    const isAdmin = user?.role === 'admin' || user?.role === 'gp';
    const CATS = ['All','Fund Formation','Offering Documents','Tax & Compliance','Investor Reports','Legal Agreements','Regulatory Filings','Other'];
  
    const fetchDocs = async () => {
          try {
                  const params = new URLSearchParams();
                  if (filterCat !== 'All') params.set('category', filterCat);
                  if (search) params.set('search', search);
                  const res = await fetch(API_BASE + '/api/dataroom/documents?' + params, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
                  const data = await res.json();
                  setDocs(Array.isArray(data) ? data : []);
          } catch (err) { console.error('DataRoom fetch:', err); }
          finally { setLoading(false); }
    };
  
    useEffect(() => { fetchDocs(); }, [filterCat, search]);
  
    const handleDownload = (doc) => {
          fetch(API_BASE + '/api/dataroom/download/' + doc._id, { headers: token ? { Authorization: 'Bearer ' + token } : {} })
                  .then((r) => r.blob())
                  .then((blob) => {
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url; a.download = doc.filename || doc.title; a.click();
                            URL.revokeObjectURL(url);
                  });
    };
  
    const handleDelete = async () => {
          if (!deleteTarget) return;
          try {
                  await fetch(API_BASE + '/api/dataroom/documents/' + deleteTarget._id, { method: 'DELETE', headers: token ? { Authorization: 'Bearer ' + token } : {} });
                  setDocs((prev) => prev.filter((d) => d._id !== deleteTarget._id));
          } catch (err) { console.error('Delete:', err); }
          finally { setDeleteTarget(null); }
    };
  
    const sizeLabel = (b) => !b ? '' : b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB';
    const inp2 = { background: '#111', border: '1px solid #222', borderRadius: 4, padding: '7px 10px', color: '#ccc', fontSize: 12, outline: 'none' };
  
    return (
          <div className={styles.page}>
                <div className={styles.header}>
                        <div className={styles.headerLeft}>
                                  <img src={pnthrLogo} alt="PNTHR" className={styles.headerLogo} />
                                  <div className={styles.headerText}>
                                              <h1 className={styles.title}><span className={styles.titleYellow}>PNTHR</span>span> Data Room</h1>h1>
                                              <p className={styles.subtitle}>Fund documents, legal filings, and investor materials for Carnivore Quant Fund, LP</p>p>
                                  </div>div>
                        </div>div>
                  {isAdmin && (
                      <button onClick={() => setShowUpload(true)} style={{ background: '#D4A017', border: 'none', borderRadius: 5, padding: '9px 18px', color: '#000', fontWeight: 700, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap', flexShrink: 0 }}>
                                  Upload Document
                      </button>button>
                        )}
                        <div className={styles.confidentialBadge}>CONFIDENTIAL</div>div>
                </div>div>
          
                <div className={styles.notice}>
                        <span>Lock</span>span>
                        <span>These materials are strictly confidential and intended solely for authorized recipients. Distribution or reproduction without express written consent of PNTHR Funds, LLC is prohibited.</span>span>
                </div>div>
          
                <div style={{ display: 'flex', gap: 10, margin: '0 0 20px 0', flexWrap: 'wrap', alignItems: 'center' }}>
                        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search documents..." style={{ ...inp2, flex: 1, minWidth: 180 }} />
                        <select value={filterCat} onChange={(e) => setFilterCat(e.target.value)} style={{ ...inp2, minWidth: 160 }}>
                          {CATS.map((c) => <option key={c} value={c}>{c}</option>option>)}
                        </select>select>
                </div>div>
          
            {loading ? (
                    <div style={{ color: '#555', fontSize: 13, padding: '20px 0' }}>Loading documents...</div>div>
                  ) : docs.length > 0 ? (
                    <div style={{ marginBottom: 32 }}>
                              <div style={{ color: '#D4A017', fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10, paddingBottom: 6, borderBottom: '1px solid #1a1a1a' }}>Available Documents</div>div>
                              <div className={styles.grid}>
                                {docs.map((doc) => {
                                    const cat = CATEGORY_COLORS[doc.category] || CATEGORY_COLORS['Other'];
                                    return (
                                                      <div key={doc._id} className={styles.card} style={{ cursor: 'default', position: 'relative' }}>
                                                                        <div style={{ position: 'absolute', top: 10, right: 10, background: cat.bg, color: cat.text, border: '1px solid ' + cat.border, borderRadius: 3, padding: '2px 7px', fontSize: 9, fontWeight: 700 }}>{doc.category}</div>div>
                                                                        <div className={styles.cardTop}>
                                                                                            <span className={styles.cardIcon}>PDF</span>span>
                                                                                            <span style={{ background: '#1c1400', color: '#D4A017', border: '1px solid #3a2800', borderRadius: 3, padding: '2px 6px', fontSize: 9, fontWeight: 700, marginLeft: 4 }}>{doc.version}</span>span>
                                                                                            <span style={{ background: '#0f200f', color: '#4CAF50', border: '1px solid #1e4020', borderRadius: 3, padding: '2px 6px', fontSize: 9, fontWeight: 700, marginLeft: 4 }}>Available</span>span>
                                                                        </div>div>
                                                                        <div className={styles.cardTitle}>{doc.title}</div>div>
                                                        {doc.description && <div className={styles.cardSubtitle}>{doc.description}</div>div>}
                                                                        <div className={styles.cardFooter}>
                                                                                            <span className={styles.cardDate}>{new Date(doc.uploadedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}{doc.fileSize ? ' - ' + sizeLabel(doc.fileSize) : ''}</span>span>
                                                                                            <div style={{ display: 'flex', gap: 6 }}>
                                                                                                                  <span onClick={() => handleDownload(doc)} className={styles.cardOpen} style={{ cursor: 'pointer' }}>Download</span>span>
                                                                                              {isAdmin && <span onClick={() => setDeleteTarget(doc)} style={{ color: '#663333', fontSize: 11, cursor: 'pointer', userSelect: 'none' }}>Delete</span>span>}
                                                                                              </div>div>
                                                                        </div>div>
                                                      </div>div>
                                                    );
                    })}
                              </div>div>
                    </div>div>
                  ) : !loading && (
                    <div style={{ color: '#333', fontSize: 13, padding: '20px 0 28px', borderBottom: '1px solid #1a1a1a', marginBottom: 28 }}>
                      {search || filterCat !== 'All' ? 'No documents match your search.' : isAdmin ? 'No documents uploaded yet. Use the Upload Document button above to add your first document.' : 'No documents available yet.'}
                    </div>div>
                )}
          
                <div>
                        <div style={{ color: '#555', fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10, paddingBottom: 6, borderBottom: '1px solid #1a1a1a' }}>Coming Soon</div>div>
                        <div className={styles.grid}>
                          {COMING_SOON.map((doc) => (
                        <div key={doc.title} className={styles.card + ' ' + styles.cardDisabled}>
                                      <div className={styles.cardTop}>
                                                      <span className={styles.cardIcon}>{doc.icon}</span>span>
                                                      <span className={styles.badge + ' ' + styles.badgePending}>Pending</span>span>
                                      </div>div>
                                      <div className={styles.cardTitle}>{doc.title}</div>div>
                                      <div className={styles.cardSubtitle}>{doc.subtitle}</div>div>
                                      <div className={styles.cardFooter}>
                                                      <span className={styles.cardDate}>-</span>span>
                                                      <span className={styles.cardSoon}>Coming soon</span>span>
                                      </div>div>
                        </div>div>
                      ))}
                        </div>div>
                </div>div>
          
                <div className={styles.footerNote}>
                        All documents are encrypted in transit and at rest. Access is logged and monitored.
                        For questions contact scott@pnthrfunds.com
                </div>div>
          
            {showUpload && <UploadModal token={token} onClose={() => setShowUpload(false)} onSuccess={(d) => { setDocs((prev) => [d, ...prev]); setShowUpload(false); }} />}
            {deleteTarget && <DeleteModal doc={deleteTarget} onConfirm={handleDelete} onClose={() => setDeleteTarget(null)} />}
          </div>div>
        );
}</div>
