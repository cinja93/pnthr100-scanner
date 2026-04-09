import { useState, useEffect, useCallback, useMemo } from 'react';
import { authHeaders, API_BASE } from '../services/api';

const PNTHR_YELLOW = '#fcf000';

const TABS = [
  { key: 'documents', label: 'Documents' },
  { key: 'calendar',  label: 'Calendar' },
  { key: 'tasks',     label: 'Task Tracker' },
  { key: 'archive2026', label: '2026' },
];

// ── Urgency helpers ─────────────────────────────────────────────────────────
function daysUntil(dateStr) {
  const now = new Date(); now.setHours(0,0,0,0);
  const due = new Date(dateStr); due.setHours(0,0,0,0);
  return Math.ceil((due - now) / 86400000);
}

function getUrgencyColor(days) {
  if (days < 0)  return '#ff4444';   // overdue — red
  if (days <= 7) return '#ff6b35';   // < 7 days — orange
  if (days <= 15) return '#f59e0b';  // 7-15 days — amber
  if (days <= 30) return PNTHR_YELLOW; // 15-30 — yellow
  return '#4ade80';                   // 30+ — green
}

function getStatusLabel(task) {
  if (task.status === 'COMPLETED') return 'COMPLETED';
  const days = daysUntil(task.dueDate);
  if (days < 0) return 'OVERDUE';
  if (days <= 7) return 'DUE SOON';
  return 'UPCOMING';
}

function getStatusColor(task) {
  if (task.status === 'COMPLETED') return '#4ade80';
  return getUrgencyColor(daysUntil(task.dueDate));
}

// ── Calendar helpers ────────────────────────────────────────────────────────
function getMonthData(year, month) {
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  return { firstDay, daysInMonth };
}

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAY_LABELS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// ═════════════════════════════════════════════════════════════════════════════
export default function CompliancePage() {
  const [activeTab, setActiveTab] = useState('documents');

  // ── Documents state ───────────────────────────────────────────────────────
  const [docs, setDocs] = useState([]);
  const [categories, setCategories] = useState([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [file, setFile] = useState(null);
  const [label, setLabel] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [subcategory, setSubcategory] = useState('');
  const [newCategoryName, setNewCategoryName] = useState('');
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [deleteDocTarget, setDeleteDocTarget] = useState(null);
  const [collapsedCategories, setCollapsedCategories] = useState({});
  const [downloading, setDownloading] = useState(null);

  // ── Tasks state ───────────────────────────────────────────────────────────
  const [tasks, setTasks] = useState([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [showAddTask, setShowAddTask] = useState(false);
  const [taskForm, setTaskForm] = useState({ title: '', description: '', dueDate: '', recurrence: 'one-time', category: '' });
  const [deleteTaskTarget, setDeleteTaskTarget] = useState(null);
  const [taskFilter, setTaskFilter] = useState('active'); // active, completed, all

  // ── Archive 2026 state ────────────────────────────────────────────────────
  const [archiveDocs, setArchiveDocs] = useState([]);
  const [archiveLoading, setArchiveLoading] = useState(true);
  const [archiveExpanded, setArchiveExpanded] = useState({ Q1: true, Q2: true, Q3: true, Q4: true });
  const [archiveDownloading, setArchiveDownloading] = useState(false);

  // ── Calendar state ────────────────────────────────────────────────────────
  const [calYear, setCalYear] = useState(new Date().getFullYear());
  const [calMonth, setCalMonth] = useState(new Date().getMonth());
  const [selectedDate, setSelectedDate] = useState(null);

  // ── Data loading ──────────────────────────────────────────────────────────
  const loadDocs = useCallback(() => {
    setDocsLoading(true);
    fetch(`${API_BASE}/api/compliance/documents`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => setDocs(Array.isArray(d) ? d : []))
      .catch(() => setDocs([]))
      .finally(() => setDocsLoading(false));
  }, []);

  const loadCategories = useCallback(() => {
    fetch(`${API_BASE}/api/compliance/categories`, { headers: authHeaders() })
      .then(r => r.json())
      .then(c => {
        const cats = Array.isArray(c) ? c : [];
        setCategories(cats);
        if (!selectedCategory && cats.length > 0) setSelectedCategory(cats[0]);
      })
      .catch(() => setCategories([]));
  }, []);

  const loadTasks = useCallback(() => {
    setTasksLoading(true);
    fetch(`${API_BASE}/api/compliance/tasks`, { headers: authHeaders() })
      .then(r => r.json())
      .then(t => setTasks(Array.isArray(t) ? t : []))
      .catch(() => setTasks([]))
      .finally(() => setTasksLoading(false));
  }, []);

  useEffect(() => { loadDocs(); loadCategories(); loadTasks(); }, [loadDocs, loadCategories, loadTasks]);

  // ── Documents: grouped by category with subcategories ─────────────────────
  const grouped = useMemo(() => {
    const g = {};
    docs.forEach(doc => {
      const cat = doc.category || 'Uncategorized';
      if (!g[cat]) g[cat] = {};
      const sub = doc.subcategory || '';
      if (!g[cat][sub]) g[cat][sub] = [];
      g[cat][sub].push(doc);
    });
    // Ensure seed categories appear even if empty
    categories.forEach(cat => { if (!g[cat]) g[cat] = {}; });
    return g;
  }, [docs, categories]);

  const categoryNames = useMemo(() => Object.keys(grouped).sort(), [grouped]);

  // ── Documents: handlers ───────────────────────────────────────────────────
  const toggleCategory = (cat) => setCollapsedCategories(prev => ({ ...prev, [cat]: !prev[cat] }));

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    try {
      let category = selectedCategory;
      if (showNewCategory && newCategoryName.trim()) {
        const secRes = await fetch(`${API_BASE}/api/compliance/categories`, {
          method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newCategoryName.trim() })
        });
        if (!secRes.ok) throw new Error('Failed to create category');
        category = newCategoryName.trim();
      }
      const form = new FormData();
      form.append('document', file);
      if (label.trim()) form.append('label', label.trim());
      form.append('category', category);
      if (subcategory.trim()) form.append('subcategory', subcategory.trim());
      const hdrs = authHeaders();
      delete hdrs['Content-Type'];
      const res = await fetch(`${API_BASE}/api/compliance/upload`, { method: 'POST', headers: hdrs, body: form });
      if (!res.ok) throw new Error('Upload failed');
      setShowUpload(false); setFile(null); setLabel(''); setSubcategory('');
      setNewCategoryName(''); setShowNewCategory(false);
      loadDocs(); loadCategories();
    } catch (err) { alert(err.message); }
    finally { setUploading(false); }
  };

  const handleDeleteDoc = async () => {
    if (!deleteDocTarget) return;
    try {
      const res = await fetch(`${API_BASE}/api/compliance/documents/${deleteDocTarget._id}`, { method: 'DELETE', headers: authHeaders() });
      if (!res.ok) throw new Error('Delete failed');
      setDeleteDocTarget(null); loadDocs();
    } catch (err) { alert(err.message); }
  };

  const handleView = (doc) => {
    window.open(`${API_BASE}/api/compliance/documents/${doc._id}/view?token=${encodeURIComponent(localStorage.getItem('pnthr_token') || '')}`, '_blank');
  };

  const handleDownload = async (doc) => {
    try {
      const res = await fetch(`${API_BASE}/api/compliance/documents/${doc._id}/download`, { headers: authHeaders() });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = doc.filename; a.click();
      URL.revokeObjectURL(url);
    } catch (err) { alert(err.message); }
  };

  const handleDownloadZip = async (category) => {
    setDownloading(category || '__all__');
    try {
      const url = category
        ? `${API_BASE}/api/compliance/download-all?category=${encodeURIComponent(category)}`
        : `${API_BASE}/api/compliance/download-all`;
      const res = await fetch(url, { headers: authHeaders() });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = blobUrl;
      a.download = category ? `PNTHR_Compliance_${category.replace(/[^a-zA-Z0-9]/g, '_')}.zip` : 'PNTHR_Compliance_All.zip';
      a.click(); URL.revokeObjectURL(blobUrl);
    } catch (err) { alert(err.message); }
    finally { setDownloading(null); }
  };

  const formatSize = (bytes) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // ── Tasks: handlers ───────────────────────────────────────────────────────
  const handleAddTask = async () => {
    if (!taskForm.title.trim() || !taskForm.dueDate) return;
    try {
      const res = await fetch(`${API_BASE}/api/compliance/tasks`, {
        method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(taskForm)
      });
      if (!res.ok) throw new Error('Failed to create task');
      setShowAddTask(false);
      setTaskForm({ title: '', description: '', dueDate: '', recurrence: 'one-time', category: '' });
      loadTasks();
    } catch (err) { alert(err.message); }
  };

  const handleCompleteTask = async (task) => {
    try {
      const res = await fetch(`${API_BASE}/api/compliance/tasks/${task._id}`, {
        method: 'PATCH', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'COMPLETED' })
      });
      if (!res.ok) throw new Error('Failed to update task');
      loadTasks();
    } catch (err) { alert(err.message); }
  };

  const handleDeleteTask = async () => {
    if (!deleteTaskTarget) return;
    try {
      const res = await fetch(`${API_BASE}/api/compliance/tasks/${deleteTaskTarget._id}`, { method: 'DELETE', headers: authHeaders() });
      if (!res.ok) throw new Error('Delete failed');
      setDeleteTaskTarget(null); loadTasks();
    } catch (err) { alert(err.message); }
  };

  const filteredTasks = useMemo(() => {
    if (taskFilter === 'completed') return tasks.filter(t => t.status === 'COMPLETED');
    if (taskFilter === 'active') return tasks.filter(t => t.status !== 'COMPLETED');
    return tasks;
  }, [tasks, taskFilter]);

  // ── Calendar: task events by date key ─────────────────────────────────────
  const tasksByDate = useMemo(() => {
    const map = {};
    tasks.forEach(t => {
      const d = new Date(t.dueDate);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      if (!map[key]) map[key] = [];
      map[key].push(t);
    });
    return map;
  }, [tasks]);

  const selectedDateTasks = useMemo(() => {
    if (!selectedDate) return [];
    return tasksByDate[selectedDate] || [];
  }, [selectedDate, tasksByDate]);

  // ── Archive 2026: filter docs by "2026 Archive" category ─────────────────
  useEffect(() => {
    setArchiveLoading(true);
    const filtered = docs.filter(d => d.category && d.category.startsWith('2026 Archive'));
    setArchiveDocs(filtered);
    setArchiveLoading(false);
  }, [docs]);

  const archiveByQuarter = useMemo(() => {
    const quarters = { Q1: [], Q2: [], Q3: [], Q4: [] };
    archiveDocs.forEach(doc => {
      const sub = (doc.subcategory || '').toUpperCase();
      if (sub.includes('Q1')) quarters.Q1.push(doc);
      else if (sub.includes('Q2')) quarters.Q2.push(doc);
      else if (sub.includes('Q3')) quarters.Q3.push(doc);
      else if (sub.includes('Q4')) quarters.Q4.push(doc);
      else {
        // Try to infer quarter from upload date
        const month = new Date(doc.uploadedAt).getMonth();
        if (month < 3) quarters.Q1.push(doc);
        else if (month < 6) quarters.Q2.push(doc);
        else if (month < 9) quarters.Q3.push(doc);
        else quarters.Q4.push(doc);
      }
    });
    return quarters;
  }, [archiveDocs]);

  const archiveCompletedTasks = useMemo(() => {
    return tasks.filter(t => t.status === 'COMPLETED' && t.category && t.category.startsWith('2026'));
  }, [tasks]);

  const archiveStats = useMemo(() => ({
    total: archiveDocs.length,
    q1: archiveByQuarter.Q1.length,
    q2: archiveByQuarter.Q2.length,
    q3: archiveByQuarter.Q3.length,
    q4: archiveByQuarter.Q4.length,
    tasksCompleted: archiveCompletedTasks.length,
  }), [archiveDocs, archiveByQuarter, archiveCompletedTasks]);

  const totalDocs = docs.length;

  // ═════════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═════════════════════════════════════════════════════════════════════════════
  return (
    <div style={{ padding: 30, background: '#0a0a0a', minHeight: '100vh', color: '#fff' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <h1 style={{ color: PNTHR_YELLOW, margin: 0 }}>PNTHR Compliance</h1>
      </div>
      <p style={{ color: '#666', fontSize: 13, margin: '0 0 12px 0' }}>
        Compliance document management, calendar, and task tracking.
      </p>

      {/* Firm Details Bar */}
      <div style={{
        background: '#111', border: '1px solid #222', borderRadius: 8, padding: '12px 18px',
        marginBottom: 20, display: 'flex', flexWrap: 'wrap', gap: '6px 28px', alignItems: 'center',
        fontSize: 12, color: '#999', lineHeight: 1.6,
      }}>
        <div><span style={{ color: '#ccc', fontWeight: 600 }}>Investment Manager:</span> STT Capital Advisors, LLC</div>
        <div><span style={{ color: '#ccc', fontWeight: 600 }}>CRD:</span> <span style={{ color: PNTHR_YELLOW, fontWeight: 600 }}>335628</span></div>
        <div><span style={{ color: '#ccc', fontWeight: 600 }}>Status:</span> ERA (Exempt Reporting Adviser) — AZ</div>
        <div><span style={{ color: '#ccc', fontWeight: 600 }}>Fund:</span> PNTHR Funds, Carnivore Quant Fund, LP</div>
        <div><span style={{ color: '#ccc', fontWeight: 600 }}>SEC CIK:</span> <span style={{ color: PNTHR_YELLOW, fontWeight: 600 }}>2056757</span></div>
        <div><span style={{ color: '#ccc', fontWeight: 600 }}>Private Fund ID:</span> 805-3257019749</div>
        <div><span style={{ color: '#ccc', fontWeight: 600 }}>GP:</span> PNTHR FUNDS, LLC</div>
        <div><span style={{ color: '#ccc', fontWeight: 600 }}>CCO/CIO:</span> Scott McBrien <span style={{ color: '#666' }}>(CRD: 2213610)</span></div>
        <div><span style={{ color: '#ccc', fontWeight: 600 }}>COO:</span> Cindy Eagar</div>
        <div><span style={{ color: '#ccc', fontWeight: 600 }}>Form PF:</span> <span style={{ color: '#4ade80' }}>Exempt</span> (ERA, not SEC-registered)</div>
        <div><span style={{ color: '#ccc', fontWeight: 600 }}>Office:</span> 15150 W Park Place, Suite 215, Goodyear, AZ 85395</div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 24, borderBottom: '1px solid #333' }}>
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              padding: '10px 24px', background: 'none', border: 'none', cursor: 'pointer',
              color: activeTab === tab.key ? PNTHR_YELLOW : '#888',
              fontWeight: activeTab === tab.key ? 700 : 400,
              fontSize: 14,
              borderBottom: activeTab === tab.key ? `2px solid ${PNTHR_YELLOW}` : '2px solid transparent',
              marginBottom: -1,
              transition: 'all 0.15s',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ═══ DOCUMENTS TAB ════════════════════════════════════════════════════ */}
      {activeTab === 'documents' && (
        <div>
          {/* Action bar */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
            <button
              onClick={() => handleDownloadZip(null)}
              disabled={downloading || totalDocs === 0}
              style={{
                background: downloading === '__all__' ? '#555' : '#222',
                color: PNTHR_YELLOW, border: '1px solid #444', borderRadius: 6,
                padding: '10px 16px', fontWeight: 600, cursor: totalDocs > 0 && !downloading ? 'pointer' : 'not-allowed', fontSize: 13
              }}
            >
              {downloading === '__all__' ? 'Zipping...' : `Download All (${totalDocs})`}
            </button>
            <button
              onClick={() => setShowUpload(true)}
              style={{ background: PNTHR_YELLOW, color: '#000', border: 'none', borderRadius: 6, padding: '10px 18px', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}
            >
              + Upload Document
            </button>
          </div>

          {docsLoading && <p style={{ color: '#888' }}>Loading...</p>}

          {!docsLoading && categoryNames.length === 0 && <p style={{ color: '#888' }}>No documents uploaded yet.</p>}

          {/* Category folders */}
          {!docsLoading && categoryNames.map(cat => {
            const subcats = grouped[cat] || {};
            const allDocs = Object.values(subcats).flat();
            const isCollapsed = collapsedCategories[cat];
            const subcatNames = Object.keys(subcats).sort((a,b) => {
              if (!a) return 1; if (!b) return -1; return a.localeCompare(b);
            });

            return (
              <div key={cat} style={{ marginBottom: 16, border: '1px solid #222', borderRadius: 8, overflow: 'hidden' }}>
                {/* Category header */}
                <div
                  onClick={() => toggleCategory(cat)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '14px 18px', background: '#141414', cursor: 'pointer', userSelect: 'none',
                    borderBottom: isCollapsed ? 'none' : '1px solid #222'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ color: PNTHR_YELLOW, fontSize: 14, fontWeight: 700, transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0)', transition: 'transform 0.2s', display: 'inline-block' }}>
                      ▼
                    </span>
                    <span style={{ color: PNTHR_YELLOW, fontWeight: 700, fontSize: 15 }}>{cat}</span>
                    <span style={{ color: '#666', fontSize: 12, marginLeft: 4 }}>({allDocs.length} {allDocs.length === 1 ? 'document' : 'documents'})</span>
                  </div>
                  {allDocs.length > 0 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDownloadZip(cat); }}
                      disabled={downloading === cat}
                      style={{
                        background: downloading === cat ? '#555' : '#222',
                        color: PNTHR_YELLOW, border: '1px solid #333', borderRadius: 4,
                        padding: '5px 12px', fontSize: 12, fontWeight: 600,
                        cursor: downloading ? 'not-allowed' : 'pointer'
                      }}
                    >
                      {downloading === cat ? 'Zipping...' : 'Download Category'}
                    </button>
                  )}
                </div>

                {/* Documents */}
                {!isCollapsed && (
                  <div style={{ background: '#0d0d0d' }}>
                    {allDocs.length === 0 && (
                      <p style={{ color: '#555', padding: '16px 18px', margin: 0, fontSize: 13, fontStyle: 'italic' }}>No documents in this category yet.</p>
                    )}
                    {subcatNames.map(sub => {
                      const subDocs = subcats[sub] || [];
                      if (subDocs.length === 0) return null;
                      return (
                        <div key={sub || '__root__'}>
                          {sub && (
                            <div style={{ padding: '8px 18px 4px 36px', color: '#888', fontSize: 12, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase' }}>
                              {sub}
                            </div>
                          )}
                          {subDocs.map(doc => (
                            <div key={doc._id} style={{
                              display: 'flex', alignItems: 'center', padding: '10px 18px',
                              paddingLeft: sub ? 36 : 18,
                              borderBottom: '1px solid #1a1a1a',
                            }}>
                              <span style={{ color: '#555', marginRight: 12, fontSize: 16 }}>
                                {doc.contentType?.includes('pdf') ? '📄' : doc.contentType?.includes('image') ? '🖼️' : doc.contentType?.includes('word') || doc.contentType?.includes('docx') ? '📝' : '📎'}
                              </span>
                              <span
                                onClick={() => handleView(doc)}
                                style={{ color: '#ddd', cursor: 'pointer', flex: 1, fontSize: 14 }}
                                onMouseEnter={e => e.target.style.color = PNTHR_YELLOW}
                                onMouseLeave={e => e.target.style.color = '#ddd'}
                              >
                                {doc.label || doc.filename}
                              </span>
                              <span style={{ color: '#555', fontSize: 12, marginRight: 16, whiteSpace: 'nowrap' }}>{formatSize(doc.size)}</span>
                              <span style={{ color: '#555', fontSize: 12, marginRight: 16, whiteSpace: 'nowrap' }}>{new Date(doc.uploadedAt).toLocaleDateString()}</span>
                              <div style={{ display: 'flex', gap: 6 }}>
                                <button onClick={() => handleView(doc)} style={{ background: '#1a1a1a', color: '#4a9eff', border: '1px solid #333', borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontSize: 11 }}>View</button>
                                <button onClick={() => handleDownload(doc)} style={{ background: '#1a1a1a', color: PNTHR_YELLOW, border: '1px solid #333', borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontSize: 11 }}>Download</button>
                                <button onClick={() => setDeleteDocTarget(doc)} style={{ background: '#1a1a1a', color: '#c00', border: '1px solid #333', borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontSize: 11 }}>Delete</button>
                              </div>
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ═══ CALENDAR TAB ═════════════════════════════════════════════════════ */}
      {activeTab === 'calendar' && (
        <div>
          {/* Month navigation */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
            <button onClick={() => { if (calMonth === 0) { setCalMonth(11); setCalYear(y => y-1); } else setCalMonth(m => m-1); }}
              style={{ background: '#222', color: PNTHR_YELLOW, border: '1px solid #333', borderRadius: 6, padding: '8px 14px', cursor: 'pointer', fontSize: 16, fontWeight: 700 }}>
              ◀
            </button>
            <h2 style={{ color: '#fff', margin: 0, minWidth: 200, textAlign: 'center' }}>
              {MONTH_NAMES[calMonth]} {calYear}
            </h2>
            <button onClick={() => { if (calMonth === 11) { setCalMonth(0); setCalYear(y => y+1); } else setCalMonth(m => m+1); }}
              style={{ background: '#222', color: PNTHR_YELLOW, border: '1px solid #333', borderRadius: 6, padding: '8px 14px', cursor: 'pointer', fontSize: 16, fontWeight: 700 }}>
              ▶
            </button>
            <button onClick={() => { setCalYear(new Date().getFullYear()); setCalMonth(new Date().getMonth()); }}
              style={{ background: '#222', color: '#888', border: '1px solid #333', borderRadius: 6, padding: '8px 12px', cursor: 'pointer', fontSize: 12 }}>
              Today
            </button>
          </div>

          {/* Calendar grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1, background: '#222', border: '1px solid #333', borderRadius: 8, overflow: 'hidden' }}>
            {/* Day headers */}
            {DAY_LABELS.map(d => (
              <div key={d} style={{ background: '#141414', padding: '10px 0', textAlign: 'center', color: '#888', fontSize: 12, fontWeight: 600 }}>{d}</div>
            ))}
            {/* Calendar cells */}
            {(() => {
              const { firstDay, daysInMonth } = getMonthData(calYear, calMonth);
              const cells = [];
              const today = new Date(); today.setHours(0,0,0,0);
              const todayKey = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

              // Empty cells before first day
              for (let i = 0; i < firstDay; i++) {
                cells.push(<div key={`empty-${i}`} style={{ background: '#0a0a0a', minHeight: 80 }} />);
              }
              // Day cells
              for (let day = 1; day <= daysInMonth; day++) {
                const dateKey = `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
                const dayTasks = tasksByDate[dateKey] || [];
                const isToday = dateKey === todayKey;
                const isSelected = dateKey === selectedDate;
                const completedCount = dayTasks.filter(t => t.status === 'COMPLETED').length;
                const pendingCount = dayTasks.length - completedCount;

                cells.push(
                  <div
                    key={dateKey}
                    onClick={() => setSelectedDate(dateKey === selectedDate ? null : dateKey)}
                    style={{
                      background: isSelected ? '#1a1a1a' : '#0d0d0d',
                      minHeight: 80, padding: 6, cursor: 'pointer',
                      border: isToday ? `2px solid ${PNTHR_YELLOW}` : isSelected ? '2px solid #444' : '2px solid transparent',
                      transition: 'all 0.1s',
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: isToday ? 700 : 400, color: isToday ? PNTHR_YELLOW : '#aaa', marginBottom: 4 }}>
                      {day}
                    </div>
                    {/* Task dots */}
                    {dayTasks.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {pendingCount > 0 && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <span style={{ width: 7, height: 7, borderRadius: '50%', background: getUrgencyColor(daysUntil(dateKey)), display: 'inline-block' }} />
                            <span style={{ fontSize: 10, color: '#aaa' }}>{pendingCount} due</span>
                          </div>
                        )}
                        {completedCount > 0 && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <span style={{ fontSize: 10, color: '#4ade80' }}>✓ {completedCount}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              }
              return cells;
            })()}
          </div>

          {/* Selected date detail */}
          {selectedDate && (
            <div style={{ marginTop: 20, border: '1px solid #333', borderRadius: 8, padding: 18, background: '#141414' }}>
              <h3 style={{ color: PNTHR_YELLOW, marginTop: 0 }}>
                {new Date(selectedDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
              </h3>
              {selectedDateTasks.length === 0 && <p style={{ color: '#666', fontStyle: 'italic' }}>No tasks on this date.</p>}
              {selectedDateTasks.map(task => (
                <div key={task._id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid #222' }}>
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 4,
                    background: getStatusColor(task) + '22', color: getStatusColor(task), whiteSpace: 'nowrap'
                  }}>
                    {getStatusLabel(task)}
                  </span>
                  <span style={{ color: '#ddd', flex: 1 }}>{task.title}</span>
                  {task.recurrence !== 'one-time' && <span style={{ color: '#666', fontSize: 11 }}>🔄 {task.recurrence}</span>}
                  {task.status !== 'COMPLETED' && (
                    <button onClick={() => handleCompleteTask(task)}
                      style={{ background: '#1a3a1a', color: '#4ade80', border: '1px solid #2a5a2a', borderRadius: 4, padding: '4px 10px', cursor: 'pointer', fontSize: 11 }}>
                      ✓ Complete
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ═══ TASK TRACKER TAB ═════════════════════════════════════════════════ */}
      {activeTab === 'tasks' && (
        <div>
          {/* Action bar */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 20, alignItems: 'center' }}>
            <button
              onClick={() => setShowAddTask(true)}
              style={{ background: PNTHR_YELLOW, color: '#000', border: 'none', borderRadius: 6, padding: '10px 18px', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}
            >
              + Add Task
            </button>
            <div style={{ display: 'flex', gap: 4, marginLeft: 16 }}>
              {['active', 'completed', 'all'].map(f => (
                <button key={f} onClick={() => setTaskFilter(f)}
                  style={{
                    background: taskFilter === f ? '#333' : '#1a1a1a',
                    color: taskFilter === f ? PNTHR_YELLOW : '#666',
                    border: '1px solid #333', borderRadius: 4, padding: '6px 14px', cursor: 'pointer', fontSize: 12,
                    fontWeight: taskFilter === f ? 600 : 400,
                  }}
                >
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
            {/* Summary counts */}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 16, fontSize: 12 }}>
              {(() => {
                const active = tasks.filter(t => t.status !== 'COMPLETED');
                const overdue = active.filter(t => daysUntil(t.dueDate) < 0);
                const dueSoon = active.filter(t => { const d = daysUntil(t.dueDate); return d >= 0 && d <= 7; });
                const completed = tasks.filter(t => t.status === 'COMPLETED');
                return (
                  <>
                    {overdue.length > 0 && <span style={{ color: '#ff4444', fontWeight: 700 }}>🔴 {overdue.length} Overdue</span>}
                    {dueSoon.length > 0 && <span style={{ color: '#ff6b35', fontWeight: 600 }}>🟠 {dueSoon.length} Due Soon</span>}
                    <span style={{ color: '#4ade80' }}>✓ {completed.length} Completed</span>
                    <span style={{ color: '#888' }}>{tasks.length} Total</span>
                  </>
                );
              })()}
            </div>
          </div>

          {tasksLoading && <p style={{ color: '#888' }}>Loading tasks...</p>}

          {!tasksLoading && filteredTasks.length === 0 && (
            <p style={{ color: '#666', fontStyle: 'italic' }}>
              {taskFilter === 'completed' ? 'No completed tasks yet.' : taskFilter === 'active' ? 'No active tasks. Add one to get started.' : 'No tasks yet.'}
            </p>
          )}

          {/* Task list */}
          {!tasksLoading && filteredTasks.map(task => {
            const days = daysUntil(task.dueDate);
            const urgencyColor = getStatusColor(task);
            const statusLabel = getStatusLabel(task);

            return (
              <div key={task._id} style={{
                display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px',
                background: '#111', borderRadius: 8, marginBottom: 8,
                borderLeft: `4px solid ${urgencyColor}`,
                opacity: task.status === 'COMPLETED' ? 0.6 : 1,
              }}>
                {/* Status badge */}
                <span style={{
                  fontSize: 10, fontWeight: 700, padding: '4px 10px', borderRadius: 4,
                  background: urgencyColor + '22', color: urgencyColor, whiteSpace: 'nowrap', minWidth: 70, textAlign: 'center',
                  animation: statusLabel === 'OVERDUE' ? 'pulse 2s infinite' : 'none',
                }}>
                  {statusLabel}
                </span>

                {/* Task info */}
                <div style={{ flex: 1 }}>
                  <div style={{ color: '#ddd', fontSize: 14, fontWeight: 600, textDecoration: task.status === 'COMPLETED' ? 'line-through' : 'none' }}>
                    {task.title}
                  </div>
                  {task.description && <div style={{ color: '#777', fontSize: 12, marginTop: 2 }}>{task.description}</div>}
                  <div style={{ display: 'flex', gap: 12, marginTop: 4, fontSize: 11, color: '#666' }}>
                    <span>Due: {new Date(task.dueDate).toLocaleDateString()}</span>
                    {task.recurrence !== 'one-time' && <span>🔄 {task.recurrence}</span>}
                    {task.category && <span>📁 {task.category}</span>}
                    {task.status === 'COMPLETED' && task.completedAt && <span style={{ color: '#4ade80' }}>✓ Completed {new Date(task.completedAt).toLocaleDateString()}</span>}
                  </div>
                </div>

                {/* Days until due */}
                {task.status !== 'COMPLETED' && (
                  <div style={{ textAlign: 'center', minWidth: 50 }}>
                    <div style={{ fontSize: 20, fontWeight: 700, color: urgencyColor }}>{Math.abs(days)}</div>
                    <div style={{ fontSize: 10, color: '#888' }}>{days < 0 ? 'days ago' : days === 0 ? 'TODAY' : 'days left'}</div>
                  </div>
                )}

                {/* Actions */}
                <div style={{ display: 'flex', gap: 6 }}>
                  {task.status !== 'COMPLETED' && (
                    <button onClick={() => handleCompleteTask(task)}
                      style={{ background: '#1a3a1a', color: '#4ade80', border: '1px solid #2a5a2a', borderRadius: 4, padding: '6px 12px', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                      ✓ Complete
                    </button>
                  )}
                  <button onClick={() => setDeleteTaskTarget(task)}
                    style={{ background: '#1a1a1a', color: '#c00', border: '1px solid #333', borderRadius: 4, padding: '6px 10px', cursor: 'pointer', fontSize: 11 }}>
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ═══ 2026 ARCHIVE TAB ═════════════════════════════════════════════════ */}
      {activeTab === 'archive2026' && (
        <div>
          {/* Header */}
          <div style={{ marginBottom: 24 }}>
            <h2 style={{ color: PNTHR_YELLOW, margin: '0 0 4px 0', fontSize: 22 }}>2026 Compliance Archive</h2>
            <p style={{ color: '#666', fontSize: 13, margin: 0 }}>Audit-ready archive of completed compliance items for fiscal year 2026.</p>
          </div>

          {/* Summary stats bar */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
            {[
              { label: 'Total Items', value: archiveStats.total, color: PNTHR_YELLOW },
              { label: 'Q1', value: archiveStats.q1, color: '#4a9eff' },
              { label: 'Q2', value: archiveStats.q2, color: '#4a9eff' },
              { label: 'Q3', value: archiveStats.q3, color: '#4a9eff' },
              { label: 'Q4', value: archiveStats.q4, color: '#4a9eff' },
              { label: 'Tasks Completed', value: archiveStats.tasksCompleted, color: '#4ade80' },
            ].map(s => (
              <div key={s.label} style={{
                background: '#141414', border: '1px solid #222', borderRadius: 8,
                padding: '12px 20px', textAlign: 'center', minWidth: 90,
              }}>
                <div style={{ fontSize: 22, fontWeight: 700, color: s.color }}>{s.value}</div>
                <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{s.label}</div>
              </div>
            ))}

            {/* Download All 2026 button */}
            <div style={{ display: 'flex', alignItems: 'center', marginLeft: 'auto' }}>
              <button
                onClick={async () => {
                  setArchiveDownloading(true);
                  try {
                    const url = `${API_BASE}/api/compliance/download-all?category=${encodeURIComponent('2026 Archive')}`;
                    const res = await fetch(url, { headers: authHeaders() });
                    if (!res.ok) throw new Error('Download failed');
                    const blob = await res.blob();
                    const blobUrl = URL.createObjectURL(blob);
                    const a = document.createElement('a'); a.href = blobUrl;
                    a.download = 'PNTHR_Compliance_2026_Archive.zip';
                    a.click(); URL.revokeObjectURL(blobUrl);
                  } catch (err) { alert(err.message); }
                  finally { setArchiveDownloading(false); }
                }}
                disabled={archiveDownloading || archiveDocs.length === 0}
                style={{
                  background: archiveDownloading ? '#555' : '#222',
                  color: PNTHR_YELLOW, border: '1px solid #444', borderRadius: 6,
                  padding: '10px 20px', fontWeight: 700, fontSize: 13,
                  cursor: archiveDocs.length > 0 && !archiveDownloading ? 'pointer' : 'not-allowed',
                }}
              >
                {archiveDownloading ? 'Zipping...' : 'Download All 2026'}
              </button>
            </div>
          </div>

          {archiveLoading && <p style={{ color: '#888' }}>Loading archive...</p>}

          {!archiveLoading && archiveDocs.length === 0 && (
            <div style={{ background: '#141414', border: '1px solid #222', borderRadius: 8, padding: 30, textAlign: 'center' }}>
              <p style={{ color: '#666', fontSize: 14, margin: 0 }}>No 2026 archive documents yet.</p>
              <p style={{ color: '#555', fontSize: 12, margin: '8px 0 0 0' }}>Upload documents with category "2026 Archive" and subcategory "Q1", "Q2", "Q3", or "Q4" to populate this archive.</p>
            </div>
          )}

          {/* Quarter sections */}
          {!archiveLoading && ['Q1', 'Q2', 'Q3', 'Q4'].map(q => {
            const qDocs = archiveByQuarter[q] || [];
            const isExpanded = archiveExpanded[q];
            const toggleArchiveQ = () => setArchiveExpanded(prev => ({ ...prev, [q]: !prev[q] }));

            // Group by type within quarter
            const byType = { 'Monthly Reviews': [], 'Quarterly Reviews': [], 'Annual Reviews': [], 'Other': [] };
            qDocs.forEach(doc => {
              const lbl = (doc.label || doc.filename || '').toLowerCase();
              if (lbl.includes('monthly')) byType['Monthly Reviews'].push(doc);
              else if (lbl.includes('quarterly')) byType['Quarterly Reviews'].push(doc);
              else if (lbl.includes('annual')) byType['Annual Reviews'].push(doc);
              else byType['Other'].push(doc);
            });

            return (
              <div key={q} style={{ marginBottom: 16, border: '1px solid #222', borderRadius: 8, overflow: 'hidden' }}>
                {/* Quarter header */}
                <div
                  onClick={toggleArchiveQ}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '14px 18px', background: '#141414', cursor: 'pointer', userSelect: 'none',
                    borderBottom: isExpanded ? '1px solid #222' : 'none',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{
                      color: PNTHR_YELLOW, fontSize: 14, fontWeight: 700,
                      transform: isExpanded ? 'rotate(0)' : 'rotate(-90deg)',
                      transition: 'transform 0.2s', display: 'inline-block',
                    }}>
                      ▼
                    </span>
                    <span style={{ color: PNTHR_YELLOW, fontWeight: 700, fontSize: 15 }}>{q} 2026</span>
                    <span style={{ color: '#666', fontSize: 12, marginLeft: 4 }}>
                      ({qDocs.length} {qDocs.length === 1 ? 'document' : 'documents'})
                    </span>
                  </div>
                </div>

                {/* Quarter content */}
                {isExpanded && (
                  <div style={{ background: '#0d0d0d' }}>
                    {qDocs.length === 0 && (
                      <p style={{ color: '#555', padding: '16px 18px', margin: 0, fontSize: 13, fontStyle: 'italic' }}>
                        No documents archived for {q} 2026.
                      </p>
                    )}

                    {['Monthly Reviews', 'Quarterly Reviews', 'Annual Reviews', 'Other'].map(type => {
                      const typeDocs = byType[type];
                      if (typeDocs.length === 0) return null;
                      return (
                        <div key={type}>
                          <div style={{
                            padding: '8px 18px 4px 36px', color: '#888',
                            fontSize: 12, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase',
                          }}>
                            {type}
                          </div>
                          {typeDocs.map(doc => (
                            <div key={doc._id} style={{
                              display: 'flex', alignItems: 'center', padding: '10px 18px', paddingLeft: 36,
                              borderBottom: '1px solid #1a1a1a',
                            }}>
                              <span style={{ color: '#555', marginRight: 12, fontSize: 16 }}>
                                {doc.contentType?.includes('pdf') ? '📄' : doc.contentType?.includes('image') ? '🖼️' : doc.contentType?.includes('word') || doc.contentType?.includes('docx') ? '📝' : '📎'}
                              </span>
                              <span style={{ color: '#ddd', flex: 1, fontSize: 14 }}>
                                {doc.label || doc.filename}
                              </span>
                              <span style={{ color: '#555', fontSize: 12, marginRight: 16, whiteSpace: 'nowrap' }}>
                                {new Date(doc.uploadedAt).toLocaleDateString()}
                              </span>
                              <div style={{ display: 'flex', gap: 6 }}>
                                <button onClick={() => handleView(doc)} style={{
                                  background: '#1a1a1a', color: '#4a9eff', border: '1px solid #333',
                                  borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontSize: 11,
                                }}>View</button>
                                <button onClick={() => handleDownload(doc)} style={{
                                  background: '#1a1a1a', color: PNTHR_YELLOW, border: '1px solid #333',
                                  borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontSize: 11,
                                }}>Download</button>
                              </div>
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {/* Completed tasks summary */}
          {archiveCompletedTasks.length > 0 && (
            <div style={{ marginTop: 24 }}>
              <h3 style={{ color: PNTHR_YELLOW, fontSize: 16, marginBottom: 12 }}>Completed Compliance Tasks</h3>
              <div style={{ border: '1px solid #222', borderRadius: 8, overflow: 'hidden' }}>
                {archiveCompletedTasks.map(task => (
                  <div key={task._id} style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px',
                    background: '#0d0d0d', borderBottom: '1px solid #1a1a1a',
                  }}>
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 4,
                      background: '#4ade8022', color: '#4ade80', whiteSpace: 'nowrap',
                    }}>
                      COMPLETED
                    </span>
                    <span style={{ color: '#ddd', flex: 1, fontSize: 14 }}>{task.title}</span>
                    {task.completedAt && (
                      <span style={{ color: '#666', fontSize: 12, whiteSpace: 'nowrap' }}>
                        {new Date(task.completedAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══ UPLOAD MODAL ═════════════════════════════════════════════════════ */}
      {showUpload && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 10, padding: 30, width: 480, maxWidth: '90vw' }}>
            <h2 style={{ color: PNTHR_YELLOW, marginTop: 0 }}>Upload Compliance Document</h2>

            {/* Category selector */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', color: '#aaa', marginBottom: 6, fontSize: 13 }}>Category</label>
              {!showNewCategory ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <select value={selectedCategory} onChange={e => setSelectedCategory(e.target.value)}
                    style={{ flex: 1, padding: 10, background: '#111', border: '1px solid #444', borderRadius: 6, color: '#fff', fontSize: 14 }}>
                    {categories.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <button onClick={() => setShowNewCategory(true)}
                    style={{ background: '#222', color: PNTHR_YELLOW, border: '1px solid #444', borderRadius: 6, padding: '8px 14px', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' }}>
                    + New
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 8 }}>
                  <input type="text" value={newCategoryName} onChange={e => setNewCategoryName(e.target.value)}
                    placeholder="Enter new category name" autoFocus
                    style={{ flex: 1, padding: 10, background: '#111', border: '1px solid #444', borderRadius: 6, color: '#fff', fontSize: 14, boxSizing: 'border-box' }} />
                  <button onClick={() => { setShowNewCategory(false); setNewCategoryName(''); }}
                    style={{ background: '#333', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 14px', cursor: 'pointer', fontSize: 12 }}>Cancel</button>
                </div>
              )}
            </div>

            {/* Subcategory (e.g., Q1 2025) */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', color: '#aaa', marginBottom: 6, fontSize: 13 }}>Subcategory <span style={{ color: '#666' }}>(optional — e.g., Q3 2025)</span></label>
              <input type="text" value={subcategory} onChange={e => setSubcategory(e.target.value)}
                placeholder="e.g. Q3, 2025"
                style={{ width: '100%', padding: 10, background: '#111', border: '1px solid #444', borderRadius: 6, color: '#fff', fontSize: 14, boxSizing: 'border-box' }} />
            </div>

            {/* Label */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', color: '#aaa', marginBottom: 6, fontSize: 13 }}>Label (optional)</label>
              <input type="text" value={label} onChange={e => setLabel(e.target.value)}
                placeholder="e.g. Annual Compliance Review Summary"
                style={{ width: '100%', padding: 10, background: '#111', border: '1px solid #444', borderRadius: 6, color: '#fff', fontSize: 14, boxSizing: 'border-box' }} />
            </div>

            {/* File */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', color: '#aaa', marginBottom: 6, fontSize: 13 }}>File</label>
              <input type="file" onChange={e => setFile(e.target.files[0] || null)} style={{ color: '#ccc' }} />
            </div>

            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowUpload(false); setFile(null); setLabel(''); setSubcategory(''); setShowNewCategory(false); setNewCategoryName(''); }}
                style={{ background: '#333', color: '#fff', border: 'none', borderRadius: 6, padding: '10px 18px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleUpload}
                disabled={!file || uploading || (showNewCategory && !newCategoryName.trim())}
                style={{ background: file && !uploading ? PNTHR_YELLOW : '#555', color: '#000', border: 'none', borderRadius: 6, padding: '10px 18px', fontWeight: 700, cursor: file && !uploading ? 'pointer' : 'not-allowed' }}>
                {uploading ? 'Uploading...' : 'Upload'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ ADD TASK MODAL ═══════════════════════════════════════════════════ */}
      {showAddTask && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 10, padding: 30, width: 480, maxWidth: '90vw' }}>
            <h2 style={{ color: PNTHR_YELLOW, marginTop: 0 }}>Add Compliance Task</h2>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', color: '#aaa', marginBottom: 6, fontSize: 13 }}>Task Title *</label>
              <input type="text" value={taskForm.title} onChange={e => setTaskForm(f => ({ ...f, title: e.target.value }))}
                placeholder="e.g. Q3 Quarterly Compliance Review"
                style={{ width: '100%', padding: 10, background: '#111', border: '1px solid #444', borderRadius: 6, color: '#fff', fontSize: 14, boxSizing: 'border-box' }} />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', color: '#aaa', marginBottom: 6, fontSize: 13 }}>Description (optional)</label>
              <textarea value={taskForm.description} onChange={e => setTaskForm(f => ({ ...f, description: e.target.value }))}
                placeholder="Details about what needs to be done..."
                rows={3}
                style={{ width: '100%', padding: 10, background: '#111', border: '1px solid #444', borderRadius: 6, color: '#fff', fontSize: 14, boxSizing: 'border-box', resize: 'vertical' }} />
            </div>

            <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', color: '#aaa', marginBottom: 6, fontSize: 13 }}>Due Date *</label>
                <input type="date" value={taskForm.dueDate} onChange={e => setTaskForm(f => ({ ...f, dueDate: e.target.value }))}
                  style={{ width: '100%', padding: 10, background: '#111', border: '1px solid #444', borderRadius: 6, color: '#fff', fontSize: 14, boxSizing: 'border-box' }} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', color: '#aaa', marginBottom: 6, fontSize: 13 }}>Recurrence</label>
                <select value={taskForm.recurrence} onChange={e => setTaskForm(f => ({ ...f, recurrence: e.target.value }))}
                  style={{ width: '100%', padding: 10, background: '#111', border: '1px solid #444', borderRadius: 6, color: '#fff', fontSize: 14 }}>
                  <option value="one-time">One-time</option>
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="annual">Annual</option>
                </select>
              </div>
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', color: '#aaa', marginBottom: 6, fontSize: 13 }}>Category (optional)</label>
              <select value={taskForm.category} onChange={e => setTaskForm(f => ({ ...f, category: e.target.value }))}
                style={{ width: '100%', padding: 10, background: '#111', border: '1px solid #444', borderRadius: 6, color: '#fff', fontSize: 14 }}>
                <option value="">None</option>
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowAddTask(false); setTaskForm({ title: '', description: '', dueDate: '', recurrence: 'one-time', category: '' }); }}
                style={{ background: '#333', color: '#fff', border: 'none', borderRadius: 6, padding: '10px 18px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleAddTask}
                disabled={!taskForm.title.trim() || !taskForm.dueDate}
                style={{ background: taskForm.title.trim() && taskForm.dueDate ? PNTHR_YELLOW : '#555', color: '#000', border: 'none', borderRadius: 6, padding: '10px 18px', fontWeight: 700, cursor: taskForm.title.trim() && taskForm.dueDate ? 'pointer' : 'not-allowed' }}>
                Add Task
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ DELETE DOC CONFIRMATION ══════════════════════════════════════════ */}
      {deleteDocTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 10, padding: 30, width: 380, maxWidth: '90vw' }}>
            <h3 style={{ color: '#ff4444', marginTop: 0 }}>Delete Document?</h3>
            <p style={{ color: '#ccc' }}>Are you sure you want to delete <strong>{deleteDocTarget.label || deleteDocTarget.filename}</strong>?</p>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setDeleteDocTarget(null)} style={{ background: '#333', color: '#fff', border: 'none', borderRadius: 6, padding: '10px 18px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleDeleteDoc} style={{ background: '#c00', color: '#fff', border: 'none', borderRadius: 6, padding: '10px 18px', fontWeight: 700, cursor: 'pointer' }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ DELETE TASK CONFIRMATION ═════════════════════════════════════════ */}
      {deleteTaskTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 10, padding: 30, width: 380, maxWidth: '90vw' }}>
            <h3 style={{ color: '#ff4444', marginTop: 0 }}>Delete Task?</h3>
            <p style={{ color: '#ccc' }}>Are you sure you want to delete <strong>{deleteTaskTarget.title}</strong>?</p>
            {deleteTaskTarget.recurrence !== 'one-time' && (
              <p style={{ color: '#f59e0b', fontSize: 12 }}>This is a recurring task. Only this instance will be deleted.</p>
            )}
            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setDeleteTaskTarget(null)} style={{ background: '#333', color: '#fff', border: 'none', borderRadius: 6, padding: '10px 18px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleDeleteTask} style={{ background: '#c00', color: '#fff', border: 'none', borderRadius: 6, padding: '10px 18px', fontWeight: 700, cursor: 'pointer' }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Pulse animation for overdue tasks */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
      `}</style>
    </div>
  );
}
