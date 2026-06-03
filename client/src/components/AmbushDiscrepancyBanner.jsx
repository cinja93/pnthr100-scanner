import { useState, useEffect, useCallback } from 'react';
import { fetchAmbushDiscrepancies, ambushDiscrepancyAction } from '../services/api';

// ── Ambush ↔ IBKR discrepancy banner (2026-06-03) ───────────────────────────
// Flashing banner shown on EVERY screen whenever the Ambush engine's book
// disagrees with the live IBKR account. Shows ticker + "Ambush says X vs IBKR
// says Y", with actions:
//   • Flatten     — close the live IBKR position
//   • Keep (adopt)— engine takes the position over: auto-places the 2-bar exit
//                   stop + pyramid (same as adopting a manual order)
//   • Clear       — (phantom only) reconcile the stale engine record to flat
// Polls every 45s; only renders when there is at least one discrepancy.
export default function AmbushDiscrepancyBanner() {
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchAmbushDiscrepancies();
      setItems(data?.ibkrConnected ? (data.discrepancies || []) : []);
    } catch { /* IBKR not synced — no banner */ }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 45000);
    return () => clearInterval(iv);
  }, [load]);

  if (!items.length) return null;

  const act = async (ticker, action) => {
    setBusy(`${ticker}:${action}`);
    try { await ambushDiscrepancyAction(ticker, action); await load(); }
    catch (e) { alert(`${action} ${ticker} failed: ${e.message}`); }
    finally { setBusy(null); }
  };

  const btn = (d, action, label, bg) => (
    <button
      onClick={() => act(d.ticker, action)}
      disabled={!!busy}
      style={{
        background: bg, color: '#fff', border: 'none', borderRadius: 4,
        padding: '3px 10px', fontSize: 11, fontWeight: 800, cursor: busy ? 'wait' : 'pointer',
        letterSpacing: '0.03em', opacity: busy ? 0.6 : 1,
      }}
    >{busy === `${d.ticker}:${action}` ? '…' : label}</button>
  );

  return (
    <div style={{ position: 'sticky', top: 0, zIndex: 6000, width: '100%' }}>
      <style>{`@keyframes ambushDiscFlash { 0%,100%{background:#8b0000;} 50%{background:#d11f1f;} }`}</style>
      <div style={{
        animation: 'ambushDiscFlash 1.1s ease-in-out infinite',
        color: '#fff', padding: '6px 14px', borderBottom: '2px solid #ffce00',
        display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12,
      }}>
        <div style={{ fontWeight: 900, fontSize: 12, letterSpacing: '0.06em', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14 }}>⚠️</span>
          DISCREPANCY — AMBUSH vs IBKR — NEEDS ATTENTION ({items.length})
        </div>
        {items.map((d) => (
          <div key={`${d.ticker}_${d.type}`} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 900, fontSize: 13, background: 'rgba(0,0,0,0.3)', borderRadius: 4, padding: '1px 7px', minWidth: 56 }}>{d.ticker}</span>
            <span style={{ fontSize: 10, letterSpacing: '0.05em', opacity: 0.85, minWidth: 72 }}>{d.type}</span>
            <span style={{ flex: 1, minWidth: 220 }}>
              Ambush: <b style={{ color: '#ffd9d9' }}>{d.ambush}</b>
              <span style={{ opacity: 0.6 }}>{'  |  '}</span>
              IBKR: <b style={{ color: '#ffe9b0' }}>{d.ibkr}</b>
            </span>
            <span style={{ display: 'flex', gap: 6 }}>
              {d.canFlatten && btn(d, 'flatten', 'Flatten', '#3a3a3a')}
              {d.canAdopt && btn(d, 'adopt', 'Keep (adopt)', '#1565c0')}
              {d.canClear && btn(d, 'clear', 'Clear', '#3a3a3a')}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
