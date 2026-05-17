import { useState, useEffect } from 'react';
import { API_BASE, authHeaders } from '../services/api';

export default function DocPermissionsSelector({ selected, onChange }) {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/dataroom`, { headers: authHeaders() });
        if (res.ok) setDocs(await res.json());
      } catch { /* ignore */ }
      finally { setLoading(false); }
    })();
  }, []);

  function toggle(id) {
    onChange(
      selected.includes(id)
        ? selected.filter(d => d !== id)
        : [...selected, id],
    );
  }

  function selectAll() {
    onChange(docs.map(d => d._id));
  }

  function deselectAll() {
    onChange([]);
  }

  const SECTION_AI300 = 'PNTHR AI Elite 300 Fund';
  const SECTION_679 = 'PNTHR Funds, Carnivore Quant LP Fund Documents';
  const SECTION_SUPPORTING = 'Supporting PNTHR Documents';

  function selectByFund(fundSections) {
    const ids = docs
      .filter(d => fundSections.includes(d.section || 'Uncategorized'))
      .map(d => d._id);
    const merged = new Set([...selected, ...ids]);
    onChange([...merged]);
  }

  // Group docs by section
  const sections = {};
  for (const d of docs) {
    const sec = d.section || 'Uncategorized';
    if (!sections[sec]) sections[sec] = [];
    sections[sec].push(d);
  }

  if (loading) return <div style={{ fontSize: 11, color: '#666', padding: '8px 0' }}>Loading documents...</div>;
  if (docs.length === 0) return <div style={{ fontSize: 11, color: '#666', padding: '8px 0' }}>No documents in Data Room yet.</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: '#888', letterSpacing: '0.04em' }}>
          DATA ROOM DOCS ({selected.length}/{docs.length})
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" onClick={selectAll}
            style={{ background: 'none', border: '1px solid #333', color: '#888', borderRadius: 4, padding: '2px 8px', fontSize: 9, cursor: 'pointer' }}>
            ALL
          </button>
          <button type="button" onClick={deselectAll}
            style={{ background: 'none', border: '1px solid #333', color: '#888', borderRadius: 4, padding: '2px 8px', fontSize: 9, cursor: 'pointer' }}>
            NONE
          </button>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" onClick={() => selectByFund([SECTION_AI300, SECTION_SUPPORTING])}
          style={{ background: 'none', border: '1px solid #444', color: '#FCF000', borderRadius: 4, padding: '3px 10px', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>
          AI 300
        </button>
        <button type="button" onClick={() => selectByFund([SECTION_679, SECTION_SUPPORTING])}
          style={{ background: 'none', border: '1px solid #444', color: '#FCF000', borderRadius: 4, padding: '3px 10px', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>
          679
        </button>
      </div>
      <div style={{
        background: '#0a0a0a', border: '1px solid #333', borderRadius: 6, padding: '10px 12px',
        display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        {Object.entries(sections).map(([sec, secDocs]) => (
          <div key={sec}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#666', marginBottom: 4, letterSpacing: '0.04em' }}>
              {sec.toUpperCase()}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {secDocs.map(d => (
                <label key={d._id} style={{
                  display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                  padding: '2px 0', fontSize: 12, color: selected.includes(d._id) ? '#fff' : '#555',
                }}>
                  <input
                    type="checkbox"
                    checked={selected.includes(d._id)}
                    onChange={() => toggle(d._id)}
                    style={{ accentColor: '#FCF000', cursor: 'pointer', width: 14, height: 14 }}
                  />
                  <span>{d.label || d.filename}</span>
                  <span style={{ fontSize: 9, color: '#444', marginLeft: 'auto' }}>
                    {d.contentType?.includes('pdf') ? 'PDF' : d.contentType?.split('/')[1]?.toUpperCase() || ''}
                  </span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
