import { useState, useEffect } from 'react';
import { createPendingEntries, API_BASE, authHeaders } from '../services/api';
import { useQueue } from '../contexts/QueueContext';

export default function QueueReviewPanel({ onClose }) {
  const { queue, toggleQueue, clearQueue, setSendSuccess } = useQueue();
  const [currentPositions, setCurrentPositions] = useState([]);
  const [posLoading, setPosLoading] = useState(true);
  const [sending, setSending] = useState(false);

  const items = [...queue.values()];

  useEffect(() => {
    fetch(`${API_BASE}/api/positions`, { headers: authHeaders() })
      .then(r => r.ok ? r.json() : {})
      .then(d => { setCurrentPositions(d.positions || []); setPosLoading(false); })
      .catch(() => setPosLoading(false));
  }, []);

  async function handleSend() {
    if (items.length === 0 || sending) return;
    setSending(true);
    try {
      await createPendingEntries(items);
      clearQueue();
      onClose();
      setSendSuccess(true);
      setTimeout(() => setSendSuccess(false), 4000);
    } catch { /* non-fatal */ }
    setSending(false);
  }

  // Heat impact
  const existingLive = currentPositions.filter(p => {
    const lot1P = p.fills?.[1]?.price ? +p.fills[1].price : p.entryPrice;
    const isL   = p.direction === 'LONG';
    return isL ? p.stopPrice < lot1P : p.stopPrice > lot1P;
  }).length;
  const newHeat = existingLive + items.length;
  const overCap = newHeat > 10;
  const excess  = Math.max(0, newHeat - 10);

  // Sector concentration check
  const sectorCounts = {};
  for (const p of currentPositions) {
    const s = p.sector || 'Unknown';
    if (p.status === 'ACTIVE') sectorCounts[s] = (sectorCounts[s] || 0) + 1;
  }
  for (const q of items) {
    const s = q.sector || 'Unknown';
    sectorCounts[s] = (sectorCounts[s] || 0) + 1;
  }
  const saturatedSectors = Object.entries(sectorCounts).filter(([, c]) => c > 3);

  // Option A candidates
  const livePositions = currentPositions.filter(p => {
    const lot1P = p.fills?.[1]?.price ? +p.fills[1].price : p.entryPrice;
    const isL   = p.direction === 'LONG';
    return isL ? p.stopPrice < lot1P : p.stopPrice > lot1P;
  });
  const worstLive = [...livePositions].sort((a, b) => {
    const pnlA = a.direction === 'LONG' ? (a.currentPrice - a.entryPrice) / a.entryPrice : (a.entryPrice - a.currentPrice) / a.entryPrice;
    const pnlB = b.direction === 'LONG' ? (b.currentPrice - b.entryPrice) / b.entryPrice : (b.entryPrice - b.currentPrice) / b.entryPrice;
    return pnlA - pnlB;
  }).slice(0, excess);
  const topQueued = [...items].sort((a, b) => (b.killScore || 0) - (a.killScore || 0)).slice(0, Math.min(items.length, 10 - existingLive + excess));

  const canSend = !overCap && saturatedSectors.length === 0;

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 300,
        display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: '#111', borderRadius: 14, border: '1px solid rgba(255,215,0,0.2)',
        width: '90vw', maxWidth: 900, maxHeight: '90vh', overflow: 'auto',
        display: 'flex', flexDirection: 'column' }}>

        {/* Panel header */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <span style={{ fontSize: 15, fontWeight: 800, color: '#FFD700' }}>⚡ ENTRY QUEUE</span>
            <span style={{ fontSize: 12, color: '#666', marginLeft: 12 }}>
              {items.length} position{items.length !== 1 ? 's' : ''} · Heat: {existingLive}% existing → {newHeat}% projected
            </span>
          </div>
          <button onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#666', fontSize: 20, cursor: 'pointer' }}>×</button>
        </div>

        {/* Queue table */}
        <div style={{ padding: '0 20px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'monospace', marginTop: 12 }}>
            <thead>
              <tr style={{ fontSize: 10, color: '#555', textTransform: 'uppercase', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                {['#', 'Ticker', 'Dir', 'Lot 1 Shr', 'Entry $', 'Stop $', 'Risk $', 'Kill Score', 'Sector', ''].map(h => (
                  <th key={h} style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 500 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr key={item.ticker} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                  <td style={{ padding: '8px', color: '#555' }}>{i + 1}</td>
                  <td style={{ padding: '8px', fontWeight: 700, color: '#FFD700' }}>{item.ticker}</td>
                  <td style={{ padding: '8px' }}>
                    <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 3, fontWeight: 700,
                      background: item.direction === 'LONG' ? '#d1e7dd' : '#f8d7da',
                      color: item.direction === 'LONG' ? '#0f5132' : '#842029' }}>
                      {item.direction}
                    </span>
                  </td>
                  <td style={{ padding: '8px', color: '#e8e6e3' }}>{item.lot1Shares}</td>
                  <td style={{ padding: '8px', color: '#aaa' }}>${item.currentPrice?.toFixed(2)}</td>
                  <td style={{ padding: '8px', color: '#dc3545' }}>${item.adjustedStop?.toFixed(2)}</td>
                  <td style={{ padding: '8px', color: '#ffc107' }}>${item.riskPerPosition}</td>
                  <td style={{ padding: '8px', color: item.killScore >= 100 ? '#FFD700' : '#888' }}>{item.killScore?.toFixed(1) ?? '—'}</td>
                  <td style={{ padding: '8px', color: '#666', fontSize: 11 }}>{item.sector}</td>
                  <td style={{ padding: '8px' }}>
                    <button
                      onClick={() => toggleQueue({ ticker: item.ticker, _remove: true })}
                      style={{ background: 'none', border: 'none', color: '#dc3545', cursor: 'pointer', fontSize: 14 }}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Portfolio impact summary */}
        <div style={{ padding: '12px 20px', borderTop: '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(0,0,0,0.2)', margin: '12px 0 0' }}>
          <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>
            <b style={{ color: '#e8e6e3' }}>Portfolio Impact:</b>
            {' '}New positions: {items.length} · New heat: +{items.length}%
            {' '}· Projected total:{' '}
            <span style={{ fontWeight: 700, color: overCap ? '#dc3545' : '#28a745' }}>{newHeat}%</span>
            {overCap && <span style={{ color: '#dc3545', marginLeft: 8 }}>⚠ EXCEEDS 10% CAP by {excess} slot{excess !== 1 ? 's' : ''}</span>}
          </div>
          {saturatedSectors.length > 0 && (
            <div style={{ background: 'rgba(255,193,7,0.08)', border: '1px solid rgba(255,193,7,0.25)',
              borderRadius: 6, padding: '8px 12px', marginTop: 8, fontSize: 11 }}>
              <div style={{ color: '#ffc107', fontWeight: 700, marginBottom: 4 }}>⚠ SECTOR CONCENTRATION:</div>
              {saturatedSectors.map(([sector, count]) => (
                <div key={sector} style={{ color: '#aaa', marginLeft: 8 }}>
                  {sector}: {count} positions (max 3) — deselect {count - 3} {sector} stock{count - 3 !== 1 ? 's' : ''} or close existing
                </div>
              ))}
            </div>
          )}
        </div>

        {/* AI Options */}
        <div style={{ padding: '0 20px 16px' }}>
          {canSend ? (
            <div style={{ padding: '10px 14px', background: 'rgba(40,167,69,0.08)',
              border: '1px solid rgba(40,167,69,0.25)', borderRadius: 8, marginTop: 12 }}>
              <span style={{ color: '#28a745', fontWeight: 700, fontSize: 12 }}>
                ✅ All {items.length} position{items.length !== 1 ? 's' : ''} fit within risk limits.
              </span>
            </div>
          ) : (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {overCap && (
                <>
                  {/* Option A */}
                  <div style={{ padding: '10px 14px', background: 'rgba(220,53,69,0.06)',
                    border: '1px solid rgba(220,53,69,0.2)', borderRadius: 8 }}>
                    <div style={{ fontWeight: 700, fontSize: 11, color: '#ff6b6b', marginBottom: 6 }}>
                      🔴 OPTION A — Close weakest existing + enter top queued
                    </div>
                    <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>
                      Go to Command to close these positions first, then return here to send your queue:
                    </div>
                    <div style={{ fontSize: 11, color: '#ff6b6b', fontFamily: 'monospace', marginBottom: 4 }}>
                      Close: {worstLive.map(p => p.ticker).join(', ') || '—'}
                    </div>
                    <div style={{ fontSize: 11, color: '#28a745', fontFamily: 'monospace' }}>
                      Then send: {topQueued.map(q => q.ticker).join(', ') || '—'}
                    </div>
                  </div>

                  {/* Option B */}
                  <div style={{ padding: '10px 14px', background: 'rgba(255,193,7,0.05)',
                    border: '1px solid rgba(255,193,7,0.2)', borderRadius: 8 }}>
                    <div style={{ fontWeight: 700, fontSize: 11, color: '#ffc107', marginBottom: 6 }}>
                      🟡 OPTION B — Reduce all Lot 1 sizes to fit
                    </div>
                    <div style={{ fontSize: 11, color: '#888' }}>
                      Scale each position's Lot 1 shares to keep total heat ≤ 10%:
                    </div>
                    <div style={{ fontSize: 11, color: '#aaa', fontFamily: 'monospace', marginTop: 4 }}>
                      {items.map(q => {
                        const scaledShares = Math.max(1, Math.floor(q.lot1Shares * (Math.max(0, 10 - existingLive) / items.length)));
                        return `${q.ticker}: ${scaledShares} shr (was ${q.lot1Shares})`;
                      }).join(' · ')}
                    </div>
                  </div>

                  {/* Option C */}
                  <div style={{ padding: '10px 14px', background: 'rgba(255,255,255,0.02)',
                    border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }}>
                    <div style={{ fontWeight: 700, fontSize: 11, color: '#888', marginBottom: 4 }}>
                      ⚪ OPTION C — You choose
                    </div>
                    <div style={{ fontSize: 11, color: '#666' }}>
                      Remove {excess} position{excess !== 1 ? 's' : ''} from the queue above, then SEND TO COMMAND.
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Send button */}
        <div style={{ padding: '0 20px 20px', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose}
            style={{ background: 'none', border: '1px solid rgba(255,255,255,0.1)', color: '#666',
              borderRadius: 6, padding: '8px 18px', fontSize: 12, cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={handleSend} disabled={sending || items.length === 0}
            style={{ background: sending ? 'rgba(255,215,0,0.3)' : '#FFD700', color: '#000',
              border: 'none', borderRadius: 6, padding: '8px 20px', fontWeight: 800,
              fontSize: 12, cursor: sending || items.length === 0 ? 'not-allowed' : 'pointer',
              letterSpacing: '0.04em', opacity: items.length === 0 ? 0.5 : 1 }}>
            {sending ? '⟳ Sending…' : `SEND ${items.length} TO COMMAND →`}
          </button>
        </div>
      </div>
    </div>
  );
}
