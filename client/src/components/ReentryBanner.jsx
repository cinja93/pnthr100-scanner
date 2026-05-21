// ReentryBanner — fixed top-of-app banner for PNTHR MCE (Momentum Continuation Entry).
// AI 300 only. Fires when: weekly BL active + top-100 TTM rank + not held + daily 2-bar high breaks.

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../AuthContext';
import { fetchReentrySignals } from '../services/api';

const POLL_MS = 60 * 1000;
const LS_KEY  = () => `pnthr.reentryBanner.dismissed.${new Date().toISOString().slice(0, 10)}`;

function loadDismissed() {
  try { return JSON.parse(localStorage.getItem(LS_KEY()) || 'false'); } catch { return false; }
}
function saveDismissed(val) {
  try { localStorage.setItem(LS_KEY(), JSON.stringify(val)); } catch {}
}

// Exported height — App.jsx reads this for content offset. Dynamic measurement overrides via onVisibleChange.
export let REENTRY_BANNER_HEIGHT = 0;

function TickerBadge({ s, onTickerClick, scheme }) {
  return (
    <button
      key={s.ticker}
      onClick={() => onTickerClick?.(s.ticker)}
      title={`${s.ticker} — Entry $${s.entryTrigger} | Stop $${s.weeklyStop} | RPS $${s.rps}`}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        background: scheme.badgeBg,
        color: scheme.badgeText,
        fontWeight: 800, fontSize: 11,
        padding: '3px 10px 2px', borderRadius: 4,
        cursor: 'pointer',
        border: `1px solid ${scheme.badgeBorder}`,
        letterSpacing: '0.04em', lineHeight: 1.35,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ fontSize: 12 }}>
        {s.ticker}
        {s.heatReentry && <span style={{ marginLeft: 4, padding: '0 4px', background: '#f97316', color: '#000', borderRadius: 2, fontSize: 8, fontWeight: 900, verticalAlign: 'middle' }}>Heat</span>}
      </span>
      <span style={{ fontSize: 10, fontWeight: 600, opacity: 0.9 }}>
        ${s.entryTrigger} | Stop ${s.weeklyStop}
      </span>
    </button>
  );
}

const SCHEME_AI = {
  label:       '#60a5fa',
  badgeBg:     'rgba(59,130,246,0.13)',
  badgeBorder: 'rgba(59,130,246,0.45)',
  badgeText:   '#93c5fd',
  divider:     'rgba(59,130,246,0.25)',
};

export default function ReentryBanner({ onTickerClick, onVisibleChange, topOffset = 0 }) {
  const { currentUser } = useAuth() || {};
  const [signals, setSignals] = useState([]);
  const [hidden, setHidden]   = useState(() => loadDismissed());
  const [height, setHeight]   = useState(0);
  const bannerRef             = useRef(null);

  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    const load = () =>
      fetchReentrySignals()
        .then(d => { if (!cancelled) setSignals(d?.signals || []); })
        .catch(() => {});
    load();
    const id = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [currentUser]);

  const bullSignals = signals.filter(s => s.sectorRegime !== 'bear');
  const visible = !!(currentUser && !hidden && bullSignals.length > 0);

  // Attach ResizeObserver after banner becomes visible so bannerRef.current is set.
  // Dependency on visible ensures we re-attach when the banner first mounts into the DOM.
  useEffect(() => {
    if (!visible || !bannerRef.current) return;
    const ro = new ResizeObserver(entries => {
      const h = Math.ceil(entries[0]?.borderBoxSize?.[0]?.blockSize ?? entries[0]?.contentRect?.height ?? 0);
      setHeight(h);
      REENTRY_BANNER_HEIGHT = h;
    });
    ro.observe(bannerRef.current);
    return () => ro.disconnect();
  }, [visible]);

  useEffect(() => { onVisibleChange?.(visible, height); }, [visible, height]);

  if (!visible) return null;

  return (
    <div
      ref={bannerRef}
      style={{
        position: 'fixed', top: topOffset, left: 0, right: 0, zIndex: 9997,
        background: '#0d0d14',
        borderBottom: '2px solid #1e1e2e',
        boxShadow: '0 3px 16px rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'stretch',
        fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
        minHeight: 58,
      }}
    >
      {/* ── Left label column ── */}
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: '8px 16px',
        borderRight: '1px solid #2a2a40',
        background: '#0a0a12',
        minWidth: 80,
        gap: 5,
        flexShrink: 0,
      }}>
        <span style={{
          color: '#60a5fa', fontWeight: 900, fontSize: 11,
          letterSpacing: '0.12em', whiteSpace: 'nowrap',
        }}>
          PNTHR MCE
        </span>
        <span style={{
          background: '#15803d', color: '#fff',
          fontWeight: 800, fontSize: 11,
          padding: '2px 10px', borderRadius: 3,
          letterSpacing: '0.1em',
        }}>
          BL
        </span>
      </div>

      {/* ── AI 300 signals ── */}
      <div style={{
        flex: 1, padding: '7px 12px',
      }}>
        <div style={{
          fontSize: 10, fontWeight: 800, color: SCHEME_AI.label,
          letterSpacing: '0.12em', marginBottom: 5,
        }}>
          AI 300 &nbsp;<span style={{ opacity: 0.55, fontWeight: 600 }}>({bullSignals.length})</span>
        </div>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {bullSignals.map(s => (
            <TickerBadge key={s.ticker} s={s} onTickerClick={onTickerClick} scheme={SCHEME_AI} />
          ))}
        </div>
      </div>

      {/* ── Dismiss ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '8px 14px', borderLeft: '1px solid #2a2a40',
        background: '#0a0a12', flexShrink: 0,
      }}>
        <button
          onClick={() => { setHidden(true); saveDismissed(true); }}
          title="Dismiss PNTHR MCE banner for today"
          style={{
            background: '#1e1e35', color: '#a78bfa',
            border: '1px solid #3b3b5c', borderRadius: 4,
            padding: '4px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
            letterSpacing: '0.06em',
          }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
