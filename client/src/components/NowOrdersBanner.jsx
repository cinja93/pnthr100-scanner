import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../AuthContext';
import { fetchLatestAiOrders, fetchLatestOrders } from '../services/api';

const POLL_MS = 60 * 1000;
const LS_KEY = 'pnthr.nowOrders.dismissed';

function loadDismissed() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); }
  catch { return []; }
}

function saveDismissed(keys) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(keys)); } catch {}
}

export const NOW_BANNER_HEIGHT = 58;

export default function NowOrdersBanner({ topOffset = 0, onVisibleChange, onNavigate }) {
  const { isAdmin } = useAuth() || {};
  const [nowTickers, setNowTickers] = useState([]);
  const [dismissed, setDismissed] = useState(() => loadDismissed());

  const poll = useCallback(async () => {
    if (!isAdmin) return;
    const items = [];
    try {
      const [aiDoc, ordDoc] = await Promise.all([
        fetchLatestAiOrders().catch(() => null),
        fetchLatestOrders().catch(() => null),
      ]);

      if (aiDoc?.orders) {
        const activeTickers = new Set(
          (aiDoc.activePositionTickers || []).map(p => p.ticker)
        );
        for (const o of aiDoc.orders) {
          if (
            o.isNewSignal &&
            (o.signal === 'BL' || o.signal === 'SS') &&
            o.qualityGrade === 'BEST' &&
            !activeTickers.has(o.ticker)
          ) {
            items.push({
              key: `ai-${o.ticker}-${o.signal}`,
              ticker: o.ticker,
              signal: o.signal,
              source: 'AI',
            });
          }
        }
      }

      if (ordDoc?.orders) {
        for (const o of ordDoc.orders) {
          // Only fire for fresh signals (age 0 or 1 week) not already in portfolio
          if (!o.inPortfolio && (o.signalAge ?? 99) <= 1) {
            items.push({
              key: `ord-${o.ticker}-${o.signal}`,
              ticker: o.ticker,
              signal: o.signal,
              source: '679',
            });
          }
        }
      }
    } catch {}
    setNowTickers(items);
    const currentKeys = new Set(items.map(i => i.key));
    setDismissed(prev => {
      const pruned = prev.filter(k => currentKeys.has(k));
      saveDismissed(pruned);
      return pruned;
    });
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) return;
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [isAdmin, poll]);

  const undismissed = nowTickers.filter(t => !dismissed.includes(t.key));
  const visible = !!(isAdmin && undismissed.length > 0);

  useEffect(() => { onVisibleChange?.(visible); }, [visible]);

  if (!visible) return null;

  const blCount = undismissed.filter(t => t.signal === 'BL').length;
  const ssCount = undismissed.filter(t => t.signal === 'SS').length;

  function handleDismiss() {
    const keys = [...dismissed, ...undismissed.map(t => t.key)];
    setDismissed(keys);
    saveDismissed(keys);
  }

  return (
    <>
      <style>{`
        @keyframes nowPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
      `}</style>
      <div style={{
        position: 'fixed', top: topOffset, left: 0, right: 0, zIndex: 9997,
        background: 'linear-gradient(90deg, #b45309, #d97706, #b45309)',
        color: '#fff',
        padding: '10px 16px',
        borderBottom: '2px solid #f59e0b',
        boxShadow: '0 2px 16px rgba(217,119,6,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
        animation: 'nowPulse 1.5s ease-in-out infinite',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 18 }}>⚡</span>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div style={{ fontWeight: 900, fontSize: 14, letterSpacing: '0.06em' }}>
              {undismissed.length} NEW ORDER{undismissed.length > 1 ? 'S' : ''} — NOW
            </div>
            <div style={{ fontSize: 11, opacity: 0.9 }}>
              {blCount > 0 && `${blCount} BL`}{blCount > 0 && ssCount > 0 && ' + '}{ssCount > 0 && `${ssCount} SS`}
              {' '} — {undismissed.map(t => t.ticker).join(', ')}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, marginLeft: 8 }}>
          <button
            onClick={() => onNavigate?.('aiOrders')}
            title="View AI Orders"
            style={{
              background: 'rgba(0,0,0,0.35)', color: '#fff',
              border: '1px solid rgba(255,255,255,0.3)', borderRadius: 4,
              padding: '5px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
            }}
          >
            AI Orders
          </button>
          <button
            onClick={() => onNavigate?.('orders')}
            title="View 679 Orders"
            style={{
              background: 'rgba(0,0,0,0.35)', color: '#fff',
              border: '1px solid rgba(255,255,255,0.3)', borderRadius: 4,
              padding: '5px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
            }}
          >
            679 Orders
          </button>
          <button
            onClick={handleDismiss}
            title="Dismiss"
            style={{
              background: '#000', color: '#f59e0b',
              border: 'none', borderRadius: 4,
              padding: '5px 14px', fontSize: 12, fontWeight: 800, cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </div>
      </div>
    </>
  );
}
