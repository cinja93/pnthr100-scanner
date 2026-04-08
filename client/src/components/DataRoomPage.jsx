import { useState, useEffect, useContext } from 'react';
import { AuthContext } from '../context/AuthContext';
const API_BASE = import.meta.env.VITE_API_URL || '';
export default function DataRoomPage() {
  const { token, user } = useContext(AuthContext);
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [show, setShow] = useState(false);
  const isAdmin = user && user.role === 'admin';
  useEffect(() => {
    fetch(API_BASE + '/api/dataroom', { headers: { Authorization: 'Bearer ' + token } })
      .then(r => r.json()).then(d => setDocs(Array.isArray(d) ? d : [])).catch(() => setDocs([])).finally(() => setLoading(false));
  }, [token]);
  return (
    <div style={{ padding: 30, background: '#0a0a0a', minHeight: '100vh', color: '#fff' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ color: '#FFD700', margin: 0 }}>PNTHR Data Room</h1>
        {isAdmin && <button onClick={() => setShow(true)} style={{ background: '#D4A017', color: '#000', border: 'none', borderRadius: 6, padding: '10px 18px', fontWeight: 700, cursor: 'pointer' }}>+ Upload Document</button>}
      </div>
      {loading && <p style={{ color: '#888' }}>Loading...</p>}
      {!loading && docs.length === 0 && <p style={{ color: '#888' }}>No documents available.</p>}
      {!loading && docs.length > 0 && docs.map(doc => (
        <div key={doc._id} style={{ padding: '12px 0', borderBottom: '1px solid #222' }}>
          <a href={API_BASE + '/api/dataroom/' + doc._id + '/download'} target="_blank" rel="noreferrer" style={{ color: '#FFD700', textDecoration: 'none' }}>{doc.label}</a>
          <span style={{ color: '#666', marginLeft: 16, fontSize: 12 }}>{new Date(doc.uploadedAt).toLocaleDateString()}</span>
        </div>
      ))}
    </div>
  );
}
