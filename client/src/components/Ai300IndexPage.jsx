import { useState } from 'react';
import PageHeader from './PageHeader';
import Pnthr300Strip from './Pnthr300Strip';
import Pnthr300ChartModal from './Pnthr300ChartModal';
import Pnthr300WeightsModal from './Pnthr300WeightsModal';

export default function Ai300IndexPage() {
  const [showWeights, setShowWeights] = useState(false);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PageHeader
        title="AI 300 Index"
        description="PNTHR AI 300 proprietary index — 304 AI-elite holdings, capped market-cap weighted, monthly rebalance."
      />
      <Pnthr300Strip
        onOpenChart={() => {}}
        onOpenWeights={() => setShowWeights(true)}
      />
      <Pnthr300ChartModal embedded onClose={() => {}} />
      {showWeights && <Pnthr300WeightsModal onClose={() => setShowWeights(false)} />}
    </div>
  );
}
