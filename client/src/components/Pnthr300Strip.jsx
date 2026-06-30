import { useState, useEffect } from 'react';
import { fetchPnthrAi300Latest } from '../services/api';

export default function Pnthr300Strip({ onOpenChart, onOpenWeights }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchPnthrAi300Latest()
        .then(d => { if (!cancelled) setData(d); })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (!data || !data.ok) return null;

  const dayChangeColor = data.dayChangePct >= 0 ? '#16a34a' : '#dc2626';
  const ytdColor       = (data.ytdPct ?? 0) >= 0 ? '#16a34a' : '#dc2626';
  const regimeColor    = data.regime === 'bull' ? '#16a34a' : '#dc2626';
  const regimeLabel    = data.regime === 'bull' ? '🟢 BULL REGIME' : '🔴 BEAR REGIME';

  return (
    <div
      onClick={onOpenChart}
      title="Click for full PNTHR AI 300 chart (OHLC bars + OpEMA, daily/weekly toggle)"
      style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14,
        padding: '10px 16px', margin: '12px 0',
        background: 'linear-gradient(90deg, #1a1a1a 0%, #0f0f0f 100%)',
        border: '1px solid #2a2a2a', borderRadius: 6,
        cursor: 'pointer', textAlign: 'left', width: '100%',
        fontFamily: 'inherit',
      }}
      onMouseEnter={e => e.currentTarget.style.borderColor = '#fcf000'}
      onMouseLeave={e => e.currentTarget.style.borderColor = '#2a2a2a'}
    >
      <span style={{ color: '#fcf000', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em' }}>
        PNTHR AI 300
      </span>
      <span style={{ color: '#666', fontSize: 10, fontFamily: 'monospace' }}>PAI300</span>

      <span style={{ color: '#fff', fontSize: 18, fontWeight: 700, fontFamily: 'monospace' }}>
        {data.value?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </span>
      <span style={{ color: dayChangeColor, fontSize: 13, fontWeight: 600, fontFamily: 'monospace' }}>
        {data.dayChangePct >= 0 ? '▲' : '▼'}
        {data.dayChangePoints != null && (
          <> {data.dayChangePoints >= 0 ? '+' : ''}{data.dayChangePoints.toFixed(2)}</>
        )}
        {' '}
        ({data.dayChangePct >= 0 ? '+' : ''}{data.dayChangePct?.toFixed(2)}%) today
      </span>

      <span style={{
        padding: '3px 8px', borderRadius: 3, fontSize: 10, fontWeight: 700,
        letterSpacing: '0.06em', background: regimeColor, color: '#fff',
      }}>
        {regimeLabel}
      </span>

      <span style={{ color: '#888', fontSize: 11, fontFamily: 'monospace' }}>
        OpEMA <strong style={{ color: '#fcf000' }}>{data.ema21W?.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</strong>
      </span>
      <span style={{ color: '#888', fontSize: 11, fontFamily: 'monospace' }}>
        YTD <strong style={{ color: ytdColor }}>{data.ytdPct >= 0 ? '+' : ''}{data.ytdPct?.toFixed(2)}%</strong>
      </span>
      <span style={{ color: '#888', fontSize: 11, fontFamily: 'monospace' }}>
        Since launch <strong style={{ color: '#16a34a' }}>+{data.inceptionPct?.toFixed(1)}%</strong>
      </span>

      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
        {onOpenWeights && (
          <button
            onClick={e => { e.stopPropagation(); onOpenWeights(); }}
            title="Show how each holding is weighted in the index"
            style={{
              padding: '5px 10px', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em',
              background: 'transparent', border: '1px solid #fcf000', borderRadius: 4,
              color: '#fcf000', cursor: 'pointer',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = '#fcf000'; e.currentTarget.style.color = '#000'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#fcf000'; }}
          >
            📊 Weights
          </button>
        )}
        <span style={{ color: '#fcf000', fontSize: 11, fontWeight: 600 }}>
          Open chart →
        </span>
      </span>
    </div>
  );
}
