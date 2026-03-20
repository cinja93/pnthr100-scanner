// client/src/components/QueueReviewPanel.jsx
// ── PNTHR Entry Queue Review Panel ────────────────────────────────────────────
//
// Heat model: actual dollar risk (not slot count)
//   Stocks: 1% vitality cap / 10% NAV cap
//   ETFs:   0.5% vitality cap / 5% NAV cap
//   Total:  15% NAV cap
//
// Sector concentration: ETFs are exempt (they're already diversified instruments)

import { useState, useEffect } from 'react';
import { createPendingEntries, API_BASE, authHeaders, fetchNav } from '../services/api';
import { useQueue } from '../contexts/QueueContext';

// ── Dollar risk for a single existing position ─────────────────────────────────
// Mirrors the logic inside calcHeat() in sizingUtils.js
function calcPositionRisk(p) {
  const fills     = p.fills || {};
  const filledShr = Object.values(fills).reduce((s, f) => s + (f.filled ? (+f.shares || 0) : 0), 0);
  const avg       = filledShr > 0
    ? Object.values(fills).filter(f => f.filled)
        .reduce((s, f) => s + (+f.shares || 0) * (+f.price || 0), 0) / filledShr
    : (p.entryPrice || 0);
  const isL       = p.direction === 'LONG';
  const recycled  = isL ? p.stopPrice >= avg : p.stopPrice <= avg;
  if (recycled || filledShr === 0) return 0;
  const rps = Math.max(0, isL ? avg - p.stopPrice : p.stopPrice - avg);
  return filledShr * rps;
}

// ── Format helpers ─────────────────────────────────────────────────────────────
const pct  = (v) => `${v.toFixed(2)}%`;
const dol  = (v) => `$${Math.round(Math.abs(v)).toLocaleString()}`;

const STOCK_CAP = 10;   // % NAV
const ETF_CAP   = 5;    // % NAV
const TOTAL_CAP = 15;   // % NAV

export default function QueueReviewPanel({ onClose }) {
  const { queue, toggleQueue, clearQueue, setSendSuccess } = useQueue();
  const [currentPositions, setCurrentPositions] = useState([]);
  const [nav, setNav]                           = useState(100000);
  const [posLoading, setPosLoading]             = useState(true);
  const [sending, setSending]                   = useState(false);

  const items = [...queue.values()];

  useEffect(() => {
    Promise.all([
      fetch(`${API_BASE}/api/positions`, { headers: authHeaders() })
        .then(r => r.ok ? r.json() : {})
        .then(d => setCurrentPositions(d.positions || [])),
      fetchNav().then(d => setNav(d.nav || 100000)).catch(() => {}),
    ]).finally(() => setPosLoading(false));
  }, []);

  // ── Existing dollar risk ───────────────────────────────────────────────────
  const activePosns = currentPositions.filter(p => p.status === 'ACTIVE');
  const exStockRisk = activePosns.filter(p => !p.isETF).reduce((s, p) => s + calcPositionRisk(p), 0);
  const exEtfRisk   = activePosns.filter(p =>  p.isETF).reduce((s, p) => s + calcPositionRisk(p), 0);
  const exStockPct  = nav > 0 ? (exStockRisk / nav) * 100 : 0;
  const exEtfPct    = nav > 0 ? (exEtfRisk   / nav) * 100 : 0;
  const exTotalPct  = exStockPct + exEtfPct;

  // ── Queue dollar risk ──────────────────────────────────────────────────────
  const qStockRisk = items.filter(q => !q.isETF).reduce((s, q) => s + (+q.riskPerPosition || 0), 0);
  const qEtfRisk   = items.filter(q =>  q.isETF).reduce((s, q) => s + (+q.riskPerPosition || 0), 0);

  // ── Projected totals ───────────────────────────────────────────────────────
  const prStockPct  = nav > 0 ? ((exStockRisk + qStockRisk) / nav) * 100 : 0;
  const prEtfPct    = nav > 0 ? ((exEtfRisk   + qEtfRisk)   / nav) * 100 : 0;
  const prTotalPct  = prStockPct + prEtfPct;

  const stockOver = prStockPct > STOCK_CAP;
  const etfOver   = prEtfPct   > ETF_CAP;
  const totalOver = prTotalPct > TOTAL_CAP;
  const overCap   = stockOver || etfOver || totalOver;

  // ── Sector concentration — ETFs exempt ────────────────────────────────────
  const sectorCounts = {};
  for (const p of activePosns) {
    if (p.isETF) continue;
    const s = p.sector || 'Unknown';
    sectorCounts[s] = (sectorCounts[s] || 0) + 1;
  }
  for (const q of items) {
    if (q.isETF) continue;
    const s = q.sector || 'Unknown';
    sectorCounts[s] = (sectorCounts[s] || 0) + 1;
  }
  const saturatedSectors = Object.entries(sectorCounts).filter(([, c]) => c > 3);

  // ── Option A: suggest positions to close to get under each cap ────────────
  // Only close stocks to make room for stock queue, ETFs for ETF queue
  const livePositions = activePosns.filter(p => calcPositionRisk(p) > 0);
  const liveStocks    = livePositions.filter(p => !p.isETF);
  const liveEtfs      = livePositions.filter(p =>  p.isETF);

  function worstFirst(positions) {
    return [...positions].sort((a, b) => {
      const pnl = p => p.direction === 'LONG'
        ? (p.currentPrice - p.entryPrice) / p.entryPrice
        : (p.entryPrice - p.currentPrice) / p.entryPrice;
      return pnl(a) - pnl(b);
    });
  }

  function closeToFree(positions, dollarShortfall) {
    if (dollarShortfall <= 0) return [];
    let freed = 0;
    const result = [];
    for (const p of worstFirst(positions)) {
      if (freed >= dollarShortfall) break;
      result.push(p.ticker);
      freed += calcPositionRisk(p);
    }
    return result;
  }

  const stockShortfall = Math.max(0, (exStockRisk + qStockRisk) - (STOCK_CAP / 100 * nav));
  const etfShortfall   = Math.max(0, (exEtfRisk   + qEtfRisk)   - (ETF_CAP   / 100 * nav));
  const totalShortfall = Math.max(0, (exStockRisk + exEtfRisk + qStockRisk + qEtfRisk) - (TOTAL_CAP / 100 * nav));

  const closeStockTickers = closeToFree(liveStocks, stockShortfall);
  const closeEtfTickers   = closeToFree(liveEtfs,   etfShortfall);
  // For total cap: close from whichever asset class has more exposure
  const closeTotalTickers = closeToFree(livePositions, totalShortfall);
  const optionAClose      = [...new Set([...closeStockTickers, ...closeEtfTickers, ...closeTotalTickers])];

  // ── Option B: scale all queue Lot 1 shares to fit within budgets ──────────
  const stockBudget = Math.max(0, (STOCK_CAP / 100 * nav) - exStockRisk);
  const etfBudget   = Math.max(0, (ETF_CAP   / 100 * nav) - exEtfRisk);
  const totalBudget = Math.max(0, (TOTAL_CAP / 100 * nav) - exStockRisk - exEtfRisk);

  function scaleShares(item) {
    const budget  = item.isETF ? etfBudget : stockBudget;
    const myGroup = items.filter(q => q.isETF === item.isETF);
    const perSlot = myGroup.length > 0 ? budget / myGroup.length : 0;
    const risk1   = +item.riskPerPosition || 1;
    const scale   = Math.min(1, perSlot / Math.max(risk1, 1));
    return Math.max(1, Math.floor((item.lot1Shares || 1) * scale));
  }

  // ── Overall canSend ───────────────────────────────────────────────────────
  const canSend = !overCap && saturatedSectors.length === 0;

  // ── Send handler ──────────────────────────────────────────────────────────
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

  // ── Risk row renderer ─────────────────────────────────────────────────────
  function RiskRow({ label, existPct, projPct, cap, warn }) {
    const color = warn ? '#dc3545' : projPct > cap * 0.8 ? '#ffc107' : '#28a745';
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, lineHeight: 1.6 }}>
        <span style={{ color: '#888', width: 80 }}>{label}</span>
        <span style={{ color: '#aaa', fontFamily: 'monospace', minWidth: 44 }}>{pct(existPct)}</span>
        <span style={{ color: '#555' }}>→</span>
        <span style={{ fontWeight: 700, color, fontFamily: 'monospace', minWidth: 44 }}>{pct(projPct)}</span>
        <span style={{ color: '#555' }}>cap: {cap}%</span>
        {warn && <span style={{ color: '#dc3545', fontWeight: 700 }}>⚠ OVER</span>}
        {!warn && <span style={{ color: '#28a745' }}>✓</span>}
      </div>
    );
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 300,
        display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: '#111', borderRadius: 14, border: '1px solid rgba(255,215,0,0.2)',
        width: '90vw', maxWidth: 920, maxHeight: '90vh', overflow: 'auto',
        display: 'flex', flexDirection: 'column' }}>

        {/* Panel header */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <span style={{ fontSize: 15, fontWeight: 800, color: '#FFD700' }}>⚡ ENTRY QUEUE</span>
            <span style={{ fontSize: 12, color: '#666', marginLeft: 12 }}>
              {items.length} position{items.length !== 1 ? 's' : ''}
              {' · '}Total Risk: {pct(exTotalPct)} → <span style={{ color: overCap ? '#dc3545' : '#aaa' }}>{pct(prTotalPct)}</span>
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
                {['#', 'Ticker', 'Type', 'Dir', 'Lot 1 Shr', 'Entry $', 'Stop $', 'Risk $', 'Kill Score', 'Sector', ''].map(h => (
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
                    {item.isETF && (
                      <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3,
                        background: 'rgba(110,168,254,0.15)', color: '#6ea8fe', fontWeight: 700 }}>ETF</span>
                    )}
                  </td>
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
                  <td style={{ padding: '8px', color: '#ffc107' }}>{dol(item.riskPerPosition)}</td>
                  <td style={{ padding: '8px', color: item.killScore >= 100 ? '#FFD700' : '#888' }}>{item.killScore?.toFixed(1) ?? '—'}</td>
                  <td style={{ padding: '8px', color: '#666', fontSize: 11 }}>{item.isETF ? '—' : item.sector}</td>
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

        {/* Portfolio impact — dollar risk summary */}
        <div style={{ padding: '12px 20px', borderTop: '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(0,0,0,0.2)', margin: '12px 0 0' }}>
          <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>
            <b style={{ color: '#e8e6e3' }}>Portfolio Heat Impact</b>
            <span style={{ color: '#555', marginLeft: 8, fontSize: 11 }}>NAV: {dol(nav)}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <RiskRow label="Stock Risk"
              existPct={exStockPct} projPct={prStockPct}
              cap={STOCK_CAP} warn={stockOver} />
            <RiskRow label="ETF Risk"
              existPct={exEtfPct} projPct={prEtfPct}
              cap={ETF_CAP} warn={etfOver} />
            <RiskRow label="Total Risk"
              existPct={exTotalPct} projPct={prTotalPct}
              cap={TOTAL_CAP} warn={totalOver} />
          </div>

          {/* Sector concentration */}
          {saturatedSectors.length > 0 && (
            <div style={{ background: 'rgba(255,193,7,0.08)', border: '1px solid rgba(255,193,7,0.25)',
              borderRadius: 6, padding: '8px 12px', marginTop: 10, fontSize: 11 }}>
              <div style={{ color: '#ffc107', fontWeight: 700, marginBottom: 4 }}>⚠ SECTOR CONCENTRATION (stocks only — ETFs exempt):</div>
              {saturatedSectors.map(([sector, count]) => (
                <div key={sector} style={{ color: '#aaa', marginLeft: 8 }}>
                  {sector}: {count} stock position{count !== 1 ? 's' : ''} (max 3) — remove {count - 3} {sector} entry or close existing
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Options */}
        <div style={{ padding: '0 20px 16px' }}>
          {canSend ? (
            <div style={{ padding: '10px 14px', background: 'rgba(40,167,69,0.08)',
              border: '1px solid rgba(40,167,69,0.25)', borderRadius: 8, marginTop: 12 }}>
              <span style={{ color: '#28a745', fontWeight: 700, fontSize: 12 }}>
                ✅ All {items.length} position{items.length !== 1 ? 's' : ''} fit within risk limits.
              </span>
            </div>
          ) : overCap ? (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>

              {/* Option A */}
              <div style={{ padding: '10px 14px', background: 'rgba(220,53,69,0.06)',
                border: '1px solid rgba(220,53,69,0.2)', borderRadius: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 11, color: '#ff6b6b', marginBottom: 6 }}>
                  🔴 OPTION A — Close weakest positions to create room
                </div>
                <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>
                  Go to Command to close these first, then return and SEND:
                </div>
                {closeStockTickers.length > 0 && (
                  <div style={{ fontSize: 11, color: '#ff6b6b', fontFamily: 'monospace', marginBottom: 2 }}>
                    Close stocks: {closeStockTickers.join(', ')}
                  </div>
                )}
                {closeEtfTickers.length > 0 && (
                  <div style={{ fontSize: 11, color: '#ff6b6b', fontFamily: 'monospace', marginBottom: 2 }}>
                    Close ETFs: {closeEtfTickers.join(', ')}
                  </div>
                )}
                {closeTotalTickers.length > 0 && !closeStockTickers.length && !closeEtfTickers.length && (
                  <div style={{ fontSize: 11, color: '#ff6b6b', fontFamily: 'monospace', marginBottom: 2 }}>
                    Close: {closeTotalTickers.join(', ')}
                  </div>
                )}
              </div>

              {/* Option B */}
              <div style={{ padding: '10px 14px', background: 'rgba(255,193,7,0.05)',
                border: '1px solid rgba(255,193,7,0.2)', borderRadius: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 11, color: '#ffc107', marginBottom: 6 }}>
                  🟡 OPTION B — Scale Lot 1 shares to fit within budgets
                </div>
                <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>
                  Stock budget: {dol(stockBudget)} · ETF budget: {dol(etfBudget)}
                </div>
                <div style={{ fontSize: 11, color: '#aaa', fontFamily: 'monospace' }}>
                  {items.map(q => {
                    const scaled = scaleShares(q);
                    return `${q.ticker}: ${scaled} shr (was ${q.lot1Shares})`;
                  }).join(' · ')}
                </div>
              </div>

              {/* Option C */}
              <div style={{ padding: '10px 14px', background: 'rgba(255,255,255,0.02)',
                border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 11, color: '#888', marginBottom: 4 }}>
                  ⚪ OPTION C — Remove entries from the queue above, then SEND TO COMMAND
                </div>
                <div style={{ fontSize: 11, color: '#555' }}>
                  {stockOver && `Need to cut ~${dol(stockShortfall)} of stock risk. `}
                  {etfOver   && `Need to cut ~${dol(etfShortfall)} of ETF risk. `}
                  {totalOver && !stockOver && !etfOver && `Need to cut ~${dol(totalShortfall)} of total risk.`}
                </div>
              </div>
            </div>
          ) : null}
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
