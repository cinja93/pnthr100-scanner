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

export const NOW_BANNER_HEIGHT = 62;

export default function NowOrdersBanner({ topOffset = 0, onVisibleChange, onNavigate, onTickerClick }) {
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
        const closedToday = new Set(aiDoc.closedTodayTickers || []);
        for (const o of aiDoc.orders) {
          if (
            o.isNewSignal &&
            (o.signal === 'BL' || o.signal === 'SS') &&
            o.qualityGrade === 'BEST' &&
            !activeTickers.has(o.ticker) &&
            !closedToday.has(o.ticker)
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
        minHeight: NOW_BANNER_HEIGHT,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 0, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 18 }}>⚡</span>
          <span style={{ fontWeight: 900, fontSize: 14, letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>
            {undismissed.length} NEW ORDER{undismissed.length > 1 ? 'S' : ''} — NOW
          </span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {undismissed.map(t => {
              const isBL = t.signal === 'BL';
              return (
                <button
                  key={t.key}
                  onClick={() => onTickerClick?.(t.ticker)}
                  title={`Open ${t.ticker} chart`}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center',
                    background: isBL ? '#16a34a' : '#dc2626',
                    color: '#fff', fontWeight: 800, fontSize: 12,
                    padding: '4px 12px 3px', borderRadius: 5,
                    cursor: 'pointer', border: 'none',
                    letterSpacing: '0.04em', lineHeight: 1.3,
                  }}
                >
                  <span>{t.ticker} {t.signal}</span>
                  <span style={{ fontSize: 9, fontWeight: 600, opacity: 0.85 }}>{t.source}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, marginLeft: 8 }}>
          <button
            onClick={() => onNavigate?.('aiOrders')}
            title="View AI 300 Orders"
            style={{
              background: 'rgba(0,0,0,0.35)', color: '#fff',
              border: '1px solid rgba(255,255,255,0.3)', borderRadius: 4,
              padding: '5px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            AI 300
          </button>
          <button
            onClick={() => onNavigate?.('orders')}
            title="View Carnivore Orders"
            style={{
              background: 'rgba(0,0,0,0.35)', color: '#fff',
              border: '1px solid rgba(255,255,255,0.3)', borderRadius: 4,
              padding: '5px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            Carnivore
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
