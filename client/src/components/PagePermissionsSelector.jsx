import { ALL_ASSIGNABLE_PAGES } from '../contexts/PortalContext';
import DocPermissionsSelector from './DocPermissionsSelector';

export default function PagePermissionsSelector({ selected, onChange, docIds, onDocIdsChange, defaultDocFund }) {
  function toggle(key) {
    onChange(
      selected.includes(key)
        ? selected.filter(k => k !== key)
        : [...selected, key],
    );
  }

  function selectAll() {
    onChange(ALL_ASSIGNABLE_PAGES.map(p => p.key));
  }

  function deselectAll() {
    onChange([]);
  }

  const dataRoomChecked = selected.includes('data-room');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: '#888', letterSpacing: '0.04em' }}>
          PORTAL PAGES ({selected.length}/{ALL_ASSIGNABLE_PAGES.length})
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
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px',
        background: '#0a0a0a', border: '1px solid #333', borderRadius: 6, padding: '10px 12px',
      }}>
        {ALL_ASSIGNABLE_PAGES.map(p => (
          <div key={p.key} style={{ display: 'flex', flexDirection: 'column' }}>
            <label style={{
              display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
              padding: '3px 0', fontSize: 12, color: selected.includes(p.key) ? '#fff' : '#555',
            }}>
              <input
                type="checkbox"
                checked={selected.includes(p.key)}
                onChange={() => toggle(p.key)}
                style={{ accentColor: '#FCF000', cursor: 'pointer', width: 14, height: 14 }}
              />
              <span>{p.label}</span>
              {p.personalData && (
                <span title="Contains account-specific data" style={{ fontSize: 9, color: '#f9a825', marginLeft: 2 }}>●</span>
              )}
            </label>
            {p.key === 'data-room' && dataRoomChecked && onDocIdsChange && (
              <div style={{ marginLeft: 20, marginTop: 6, marginBottom: 6 }}>
                <DocPermissionsSelector selected={docIds || []} onChange={onDocIdsChange} defaultFund={defaultDocFund} />
              </div>
            )}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 9, color: '#555' }}>
        <span style={{ color: '#f9a825' }}>●</span> Pages that display personal account data (positions, NAV, orders, journal)
      </div>
    </div>
  );
}
