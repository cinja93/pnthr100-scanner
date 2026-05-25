import { useState } from 'react';
import Pnthr300ChartModal from './Pnthr300ChartModal';
import Pnthr300WeightsModal from './Pnthr300WeightsModal';
import pnthrFundsLogo from '../assets/PNTHR FUNDS Logo black background 2 lines.png';

export default function Ai300IndexPage() {
  const [showWeights, setShowWeights] = useState(false);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 16,
        padding: '20px 24px 16px',
        borderBottom: '1px solid rgba(252, 240, 0, 0.12)',
        marginBottom: 0,
      }}>
        <img src={pnthrFundsLogo} alt="PNTHR FUNDS" style={{ height: 44, width: 'auto', objectFit: 'contain', flexShrink: 0 }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <h1 style={{
            fontFamily: "'Inter', sans-serif", fontSize: 20, fontWeight: 800,
            color: '#fcf000', letterSpacing: '0.5px', margin: 0, textTransform: 'uppercase',
          }}>AI 300 Index</h1>
          <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', margin: 0, fontStyle: 'italic', lineHeight: 1.4 }}>
            PNTHR AI 300 proprietary index — 304 AI-elite holdings, capped market-cap weighted, monthly rebalance.
          </p>
        </div>
        <button
          onClick={() => setShowWeights(true)}
          title="Show how each of the 304 holdings is weighted in the index"
          style={{
            marginLeft: 'auto', padding: '6px 14px', fontSize: 12, fontWeight: 700,
            letterSpacing: '0.04em', background: 'transparent',
            border: '1px solid #fcf000', borderRadius: 4,
            color: '#fcf000', cursor: 'pointer', whiteSpace: 'nowrap',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = '#fcf000'; e.currentTarget.style.color = '#000'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#fcf000'; }}
        >
          📊 Weights
        </button>
      </div>
      <Pnthr300ChartModal embedded onClose={() => {}} />
      {showWeights && <Pnthr300WeightsModal onClose={() => setShowWeights(false)} />}
    </div>
  );
}
