import { useState } from 'react';
import { setInvestmentAmount } from '../services/api';

const AMOUNTS = [100000, 250000, 500000, 1000000, 2500000, 5000000];

function fmt(v) {
  if (v >= 1000000) return `$${(v / 1000000).toFixed(v % 1000000 === 0 ? 0 : 1)}M`;
  return `$${(v / 1000).toFixed(0)}K`;
}

export default function InvestmentAmountModal({ currentAmount, onSaved }) {
  const [selected, setSelected] = useState(currentAmount || null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function handleConfirm() {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      await setInvestmentAmount(selected);
      onSaved(selected);
    } catch (err) {
      setError('Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 2000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: '#141414', border: '1px solid #222', borderRadius: 12,
        padding: '36px 32px 28px', width: '100%', maxWidth: 480,
      }}>
        <h2 style={{ fontSize: 18, fontWeight: 800, color: '#fff', margin: '0 0 4px', letterSpacing: '0.03em' }}>
          <span style={{ color: '#FCF000' }}>PNTHR</span> Investment Simulator
        </h2>
        <p style={{ fontSize: 13, color: '#888', margin: '0 0 24px', lineHeight: 1.6 }}>
          Select the amount you are considering investing. Position sizes throughout the platform will be calibrated to this amount.
        </p>

        {/* Amount grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 20 }}>
          {AMOUNTS.map(amt => (
            <button
              key={amt}
              onClick={() => setSelected(amt)}
              style={{
                padding: '14px 8px',
                background: selected === amt ? '#FCF000' : '#1a1a1a',
                color: selected === amt ? '#000' : '#aaa',
                border: selected === amt ? '2px solid #FCF000' : '1px solid #333',
                borderRadius: 8,
                fontSize: 15,
                fontWeight: 700,
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
            >
              {fmt(amt)}
            </button>
          ))}
        </div>

        {/* Disclaimer */}
        <div style={{
          background: '#0a0a0a', border: '1px solid #222', borderRadius: 6,
          padding: '10px 14px', marginBottom: 20,
        }}>
          <p style={{ fontSize: 10, color: '#666', margin: 0, lineHeight: 1.6 }}>
            <strong style={{ color: '#888' }}>DISCLAIMER:</strong> Position sizes shown are hypothetical illustrations based on your selected investment amount. They do not constitute investment advice, a recommendation, or an offer to invest. Actual fund allocations, position sizing, and risk parameters may differ materially. Past performance is not indicative of future results.
          </p>
        </div>

        {error && (
          <p style={{ fontSize: 12, color: '#dc3545', margin: '0 0 12px', padding: '6px 10px', background: 'rgba(220,53,69,0.1)', borderRadius: 4 }}>
            {error}
          </p>
        )}

        <button
          onClick={handleConfirm}
          disabled={!selected || saving}
          style={{
            width: '100%', padding: '12px',
            background: selected ? '#FCF000' : '#333',
            color: selected ? '#000' : '#666',
            fontSize: 14, fontWeight: 700, border: 'none', borderRadius: 6,
            cursor: selected && !saving ? 'pointer' : 'default',
            opacity: saving ? 0.6 : 1,
            letterSpacing: '0.04em',
          }}
        >
          {saving ? 'Saving...' : selected ? `Continue with ${fmt(selected)}` : 'Select an amount'}
        </button>
      </div>
    </div>
  );
}
